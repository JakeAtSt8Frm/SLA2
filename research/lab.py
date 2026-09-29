"""
Shared data prep and model helpers for train.py, review.py and experiments, so every script
fits and scores the model exactly the same way.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

ROOT = Path(__file__).resolve().parent
RNG = np.random.default_rng(7)
VEGAS = ['implied', 'opp_implied', 'spread', 'total']
SLOT_POSITIONS = {'QB': ['QB'], 'RB': ['RB'], 'WR': ['WR'], 'TE': ['TE'], 'K': ['K'], 'DL': ['DL'], 'LB': ['LB'], 'DB': ['DB'],
                  'FLEX': ['RB', 'WR', 'TE'], 'WRRB_FLEX': ['WR', 'RB'], 'REC_FLEX': ['WR', 'TE'], 'SUPER_FLEX': ['QB', 'RB', 'WR', 'TE'], 'IDP_FLEX': ['DL', 'LB', 'DB']}
# Prior knowledge as a constraint: better recent production never lowers the forecast.
MONOTONIC = {'ewma': 1, 'mean_l16': 1, 'mean_cur': 1, 'mean_l4': 1, 'exp_big_pts': 1, 'big_rate': 1, 'gap_ewma': 1, 'gap_l16': 1, 'gap_big': 1}

KEY = ''
META: dict = {}
df: pd.DataFrame
relevant: pd.DataFrame
FEATURES: list[str] = []
POSITIONS: list[str] = []
COHORT: dict = {}


def setup(key: str = '', dataset: pd.DataFrame | None = None):
    """Load dataset[-key].csv and derive the feature list, positions and decision cohort."""
    global KEY, META, df, relevant, FEATURES, POSITIONS, COHORT
    KEY = key
    suffix = f'-{key}' if key else ''
    meta_path = ROOT / f'dataset{suffix}.meta.json'
    META = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    frame = dataset if dataset is not None else pd.read_csv(ROOT / f'dataset{suffix}.csv', dtype={'player_id': str, 'inj': str})
    # Only positions the league can start (a two-way player listed at DB but eligible at WR would
    # otherwise leave a handful of rows in a position no league slot uses).
    if META.get('slots'):
        startable = {p for s in META['slots'] for p in SLOT_POSITIONS.get(s, [])}
        frame = frame[frame.pos.isin(startable)].copy()
    frame['inj'] = frame['inj'].fillna('')
    df = frame
    features_all = [c for c in df.columns if c not in ('season', 'week', 'player_id', 'pos', 'team', 'opp', 'played', 'y', 'inj')]
    # Sleeper's years_exp is frozen for retired players, so it is unreliable historically.
    feats = [f for f in features_all if f not in ('exp',)]
    # Features a league's positions never produce (e.g. tackle stats without IDP) carry no signal.
    FEATURES = [f for f in feats if df[f].notna().any() and df[f].nunique(dropna=True) > 1]
    POSITIONS = [p for p in ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'] if p in set(df.pos.unique())]
    # Twice the league's starting demand per position (the default six-team superflex league counts SF as a QB slot).
    cohort_sizes = META.get('cohort') if key else {'QB': 24, 'RB': 36, 'WR': 48, 'TE': 12, 'K': 12, 'DL': 36, 'LB': 48, 'DB': 36}
    COHORT = {p: cohort_sizes.get(p, 12) for p in POSITIONS}
    played = df[df.played == 1]
    # Rows a manager could realistically be deciding on: a provider forecast or a real track record.
    relevant = played[(played.has_proj == 1) | (played.n_l16.fillna(0) >= 2)].copy()
    return relevant


def with_vegas_dropout(frame: pd.DataFrame, rate=0.15, seed=7) -> pd.DataFrame:
    """Future weeks have no betting lines yet; teach the trees what to do without them."""
    frame = frame.copy()
    mask = np.random.default_rng(seed).random(len(frame)) < rate
    frame.loc[mask, VEGAS] = np.nan
    return frame


def base_prediction(frame: pd.DataFrame) -> np.ndarray:
    """Provider projection when present, else recent form: the offset the trees correct."""
    base = frame['proj_pts'].to_numpy(copy=True)
    fallback = frame['ewma'].fillna(frame['mean_prev']).fillna(0).to_numpy()
    return np.where(np.isnan(base), fallback, base)


def fit(train: pd.DataFrame, params: dict, residual: bool, max_iter: int, features=None, sample_weight=None):
    features = features or FEATURES
    X = with_vegas_dropout(train)[features]
    y = train['y'].to_numpy()
    target = y - base_prediction(train) if residual else y
    params = dict(params)
    if params.pop('monotonic', False):
        params['monotonic_cst'] = [MONOTONIC.get(f, 0) for f in features]
    model = HistGradientBoostingRegressor(loss=params.pop('loss', 'squared_error'), max_iter=max_iter, random_state=7, early_stopping=False, **params)
    model.fit(X, target, sample_weight=sample_weight)
    model.feature_list = list(features)
    return model


def predict(model, frame: pd.DataFrame, residual: bool, shrink=1.0, features=None) -> np.ndarray:
    features = features or getattr(model, 'feature_list', FEATURES)
    raw = model.predict(frame[features])
    if not residual:
        return raw
    shrink = np.asarray(shrink) if not isinstance(shrink, dict) else frame.pos.map(shrink).fillna(1.0).to_numpy()
    return shrink * raw + base_prediction(frame)


def linear_recalibration(train: pd.DataFrame):
    """SLA 1.0 style: per-position y = a + b·projection, fit on training seasons."""
    coefs = {}
    for pos in POSITIONS:
        t = train[(train.pos == pos) & (train.has_proj == 1)]
        if len(t) < 50:
            coefs[pos] = (0.0, 1.0)
            continue
        b, a = np.polyfit(t.proj_pts, t.y, 1)
        coefs[pos] = (a, b)
    return coefs


def apply_linear(frame: pd.DataFrame, coefs) -> np.ndarray:
    a = frame.pos.map(lambda p: coefs[p][0]).to_numpy()
    b = frame.pos.map(lambda p: coefs[p][1]).to_numpy()
    return a + b * frame.proj_pts.fillna(frame.ewma.fillna(0)).to_numpy()


def add_baselines(train: pd.DataFrame, test: pd.DataFrame):
    test['linear'] = apply_linear(test, linear_recalibration(train))
    test['provider'] = test.proj_pts.fillna(test.ewma.fillna(0))
    test['form'] = test.ewma.fillna(test.mean_prev).fillna(test.proj_pts).fillna(0)


def cohort(frame: pd.DataFrame) -> pd.Series:
    """Ex-ante decision cohort ranked by provider projection (model-neutral)."""
    rank = frame.groupby(['season', 'week', 'pos'])['proj_pts'].rank(ascending=False, method='first')
    limit = frame.pos.map(COHORT)
    return (frame.has_proj == 1) & (rank <= limit)


def pair_accuracy(frame: pd.DataFrame, col: str, close_only=False) -> tuple[float, int]:
    """Same week, same position: does the model order two options the way they finished?"""
    hits = total = 0
    for _, g in frame.groupby(['season', 'week', 'pos']):
        if len(g) < 2:
            continue
        p = g[col].to_numpy()
        y = g['y'].to_numpy()
        base = g['proj_pts'].to_numpy()
        i, j = np.triu_indices(len(g), 1)
        keep = y[i] != y[j]
        if close_only:
            keep &= np.abs(base[i] - base[j]) <= 3
        i, j = i[keep], j[keep]
        hits += int(np.sum(np.sign(p[i] - p[j]) == np.sign(y[i] - y[j])))
        total += len(i)
    return (hits / total if total else float('nan')), total


def score(frame: pd.DataFrame, col: str) -> dict:
    """Headline metrics on the decision cohort."""
    c = frame[cohort(frame)]
    err = c[col] - c.y
    return {'n': int(len(c)), 'mae': float(err.abs().mean()), 'bias': float(err.mean()), 'pairAcc': pair_accuracy(c, col)[0],
            'closePairAcc': pair_accuracy(c, col, close_only=True)[0]}
