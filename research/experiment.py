"""Tail-calibration experiment: do extra gap features / monotonic constraints fix elite-player under-prediction?"""
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

df = pd.read_csv('research/dataset.csv', dtype={'player_id': str, 'inj': str})
played = df[df.played == 1]
rel = played[(played.has_proj == 1) | (played.n_l16.fillna(0) >= 2)].copy()
BASE = [c for c in df.columns if c not in ('season', 'week', 'player_id', 'pos', 'team', 'opp', 'played', 'y', 'inj', 'exp')]
COH = {'QB': 24, 'RB': 36, 'WR': 48, 'TE': 12, 'K': 12, 'DL': 36, 'LB': 48, 'DB': 36}
RNG = np.random.default_rng(7)
import sys
TRAIN_END = int(sys.argv[1]) if len(sys.argv) > 1 else 2024


def base_pred(f):
    b = f.proj_pts.to_numpy(copy=True)
    fb = f.ewma.fillna(f.mean_prev).fillna(0).to_numpy()
    return np.where(np.isnan(b), fb, b)


def add_gaps(f):
    f = f.copy()
    f['gap_ewma'] = f.ewma - f.proj_pts
    f['gap_l16'] = f.mean_l16 - f.proj_pts
    f['gap_big'] = f.big_pts_l16 - f.proj_big_pts
    return f


def run(name, feats, params, mono=None, gaps=False):
    tr_all, te_all = rel[rel.season <= TRAIN_END], rel[rel.season == TRAIN_END + 1]
    if gaps:
        tr_all, te_all = add_gaps(tr_all), add_gaps(te_all)
    X = tr_all[feats].copy()
    mask = RNG.random(len(X)) < 0.15
    X.loc[mask, ['implied', 'opp_implied', 'spread', 'total']] = np.nan
    cst = [mono.get(f, 0) for f in feats] if mono else None
    m = HistGradientBoostingRegressor(max_iter=500, random_state=7, early_stopping=False, monotonic_cst=cst, **params)
    m.fit(X, tr_all.y - base_pred(tr_all))
    te = te_all.copy()
    te['pred'] = m.predict(te[feats]) + base_pred(te)
    rank = te.groupby(['week', 'pos']).proj_pts.rank(ascending=False, method='first')
    c = te[(te.has_proj == 1) & (rank <= te.pos.map(COH))]
    mae = np.mean(np.abs(c.pred - c.y))
    tail = te[(te.pos == 'DL') & (te.ewma > 15)]
    tail_lb = te[(te.pos.isin(['LB', 'DB'])) & (te.ewma > 15)]
    hits = tot = 0
    for _, g in c.groupby(['week', 'pos']):
        p, y = g.pred.to_numpy(), g.y.to_numpy()
        i, j = np.triu_indices(len(g), 1)
        k = y[i] != y[j]
        hits += np.sum(np.sign(p[i][k] - p[j][k]) == np.sign(y[i][k] - y[j][k]))
        tot += k.sum()
    print(f"{name:34s} MAE {mae:.4f}  pair {hits/tot:.4f}  DL>15 bias {np.mean(tail.pred - tail.y):+.2f} (n={len(tail)})  LB/DB>15 bias {np.mean(tail_lb.pred - tail_lb.y):+.2f}", flush=True)


P = {'learning_rate': 0.04, 'max_leaf_nodes': 15, 'min_samples_leaf': 80, 'l2_regularization': 1.0}
MONO = {'ewma': 1, 'mean_l16': 1, 'mean_cur': 1, 'proj_pts': 1, 'mean_l4': 1, 'exp_big_pts': 1, 'big_rate': 1}
run('baseline', BASE, P)
run('monotonic form', BASE, P, MONO)
run('gap features', BASE + ['gap_ewma', 'gap_l16', 'gap_big'], P, gaps=True)
run('gap + monotonic', BASE + ['gap_ewma', 'gap_l16', 'gap_big'], P, {**MONO, 'gap_ewma': 1, 'gap_l16': 1, 'gap_big': 1}, gaps=True)
