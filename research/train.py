"""
SLA 2.0 projection model: training, chronological evaluation and export.

Pipeline
  1. dataset.csv (built by build-dataset.ts with the same feature code the server runs)
  2. Rolling-origin evaluation: tune on 2024 (train 2020-23), hold out 2025 (train 2020-24),
     and score 2026 weeks played so far (train 2020-25).
  3. Compare against: Sleeper/Rotowire projection rescored for the league, a per-position
     linear recalibration of it (SLA 1.0's approach), and recent form.
  4. Export gradient-boosted trees + calibrated residual quantiles to model/model.json.

Target = league points given the player took a snap. Availability (did he play) is handled
separately from official injury designations, because historical projections were finalised
after inactives were announced and would leak that information.
"""
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

import lab
from lab import add_baselines, cohort, fit, pair_accuracy

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / 'model'
OUT.mkdir(exist_ok=True)
RNG = np.random.default_rng(7)
# Usage: python train.py [key]. Each league is trained on its own scoring (dataset-<key>.csv).
KEY = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != 'default' else ''
SUFFIX = f'-{KEY}' if KEY else ''
relevant = lab.setup(KEY)
df, META, FEATURES, POSITIONS, COHORT = lab.df, lab.META, lab.FEATURES, lab.POSITIONS, lab.COHORT
print('league', META.get('name', 'default'), 'positions', POSITIONS, 'cohort', COHORT, flush=True)
print(f'rows: all={len(df)} played={int(df.played.sum())} relevant={len(relevant)}', flush=True)

# Share of the trees' correction applied on top of the provider (chosen on the tuning season below).
SHRINK = 1.0


def predict(model, frame: pd.DataFrame, residual: bool) -> np.ndarray:
    return lab.predict(model, frame, residual, shrink=SHRINK)


def evaluate(frame: pd.DataFrame, cols: dict[str, str]) -> dict:
    out = {}
    c = frame[cohort(frame)]
    for name, col in cols.items():
        err = c[col] - c['y']
        acc, pairs = pair_accuracy(c, col)
        close, close_pairs = pair_accuracy(c, col, close_only=True)
        corr = c.groupby(['season', 'week', 'pos']).apply(lambda g: g[col].corr(g['y'], method='spearman'), include_groups=False).mean()
        by_pos = {}
        for pos in POSITIONS:
            cp = c[c.pos == pos]
            if len(cp):
                by_pos[pos] = {'mae': round(float(np.mean(np.abs(cp[col] - cp.y))), 3), 'n': int(len(cp)),
                               'bias': round(float(np.mean(cp[col] - cp.y)), 3),
                               'pairAcc': round(pair_accuracy(cp, col)[0], 4)}
        out[name] = {
            'n': int(len(c)),
            'mae': round(float(np.mean(np.abs(err))), 3),
            'rmse': round(float(np.sqrt(np.mean(err ** 2))), 3),
            'bias': round(float(np.mean(err)), 3),
            'spearman': round(float(corr), 4),
            'pairAcc': round(acc, 4), 'pairs': pairs,
            'closePairAcc': round(close, 4), 'closePairs': close_pairs,
            'byPos': by_pos,
        }
    return out


def add_predictions(train, test, params, residual, max_iter):
    model = fit(train, params, residual, max_iter)
    test = test.copy()
    test['model'] = predict(model, test, residual)
    add_baselines(train, test)
    return model, test


# ── 1. Tune on 2024 (train 2020-2023) ────────────────────────────────────────
GRID = [
    ({'learning_rate': 0.04, 'max_leaf_nodes': 15, 'min_samples_leaf': 80, 'l2_regularization': 1.0}, True, 500),
    ({'learning_rate': 0.04, 'max_leaf_nodes': 31, 'min_samples_leaf': 60, 'l2_regularization': 1.0}, True, 400),
    ({'learning_rate': 0.04, 'max_leaf_nodes': 31, 'min_samples_leaf': 60, 'l2_regularization': 1.0}, False, 600),
    ({'learning_rate': 0.03, 'max_leaf_nodes': 15, 'min_samples_leaf': 120, 'l2_regularization': 3.0}, True, 800),
    ({'learning_rate': 0.05, 'max_leaf_nodes': 63, 'min_samples_leaf': 100, 'l2_regularization': 2.0}, True, 300),
    ({'learning_rate': 0.04, 'max_leaf_nodes': 15, 'min_samples_leaf': 80, 'l2_regularization': 1.0, 'monotonic': True}, True, 500),
    ({'learning_rate': 0.03, 'max_leaf_nodes': 15, 'min_samples_leaf': 120, 'l2_regularization': 3.0, 'monotonic': True}, True, 800),
    # Conservative corrections: small, heavily regularised adjustments to the provider.
    ({'learning_rate': 0.03, 'max_leaf_nodes': 7, 'min_samples_leaf': 250, 'l2_regularization': 5.0, 'monotonic': True}, True, 300),
]
tune_train = relevant[relevant.season <= 2023]
tune_test = relevant[relevant.season == 2024]
best = None
for params, residual, iters in GRID:
    t0 = time.time()
    _, pred = add_predictions(tune_train, tune_test, params, residual, iters)
    ev = evaluate(pred, {'model': 'model'})['model']
    print(f"tune {params} residual={residual} iters={iters}: MAE {ev['mae']} pair {ev['pairAcc']} close {ev['closePairAcc']} ({time.time()-t0:.1f}s)", flush=True)
    score = ev['mae'] - 2 * (ev['pairAcc'] - 0.5)
    if best is None or score < best[0]:
        best = (score, params, residual, iters)
_, PARAMS, RESIDUAL, ITERS = best
print('selected', PARAMS, 'residual' if RESIDUAL else 'direct', ITERS, flush=True)

# Shrinkage toward the provider, chosen on the same tuning season (2025 stays untouched).
if RESIDUAL:
    _, tuned = add_predictions(tune_train, tune_test, PARAMS, RESIDUAL, ITERS)
    base = lab.base_prediction(tuned)
    correction = tuned['model'].to_numpy() - base
    best_shrink = None
    for lam in [0.0, 0.25, 0.5, 0.75, 1.0]:
        trial = tuned.copy()
        trial['model'] = base + lam * correction
        ev = evaluate(trial, {'model': 'model'})['model']
        score = ev['mae'] - 2 * (ev['pairAcc'] - 0.5)
        print(f'  shrink {lam}: MAE {ev["mae"]} pair {ev["pairAcc"]} close {ev["closePairAcc"]}', flush=True)
        if best_shrink is None or score < best_shrink[0] - 1e-9:
            best_shrink = (score, lam)
    SHRINK = best_shrink[1]
print('shrink', SHRINK, flush=True)

# ── 2. Holdout 2025 (train 2020-2024) and 2026 to date (train 2020-2025) ─────
holdout_model, holdout = add_predictions(relevant[relevant.season <= 2024], relevant[relevant.season == 2025], PARAMS, RESIDUAL, ITERS)
report_2025 = evaluate(holdout, {'model': 'model', 'provider': 'provider', 'linear': 'linear', 'form': 'form'})
live_train = relevant[relevant.season <= 2025]
live_test = relevant[relevant.season == 2026]
report_2026 = None
if len(live_test):
    _, live = add_predictions(live_train, live_test, PARAMS, RESIDUAL, ITERS)
    report_2026 = evaluate(live, {'model': 'model', 'provider': 'provider', 'linear': 'linear', 'form': 'form'})
for name, rep in [('2025 holdout', report_2025), ('2026 to date', report_2026)]:
    if not rep:
        continue
    print(f'\n{name}')
    for k, v in rep.items():
        print(f"  {k:9s} MAE {v['mae']:.3f}  RMSE {v['rmse']:.3f}  bias {v['bias']:+.3f}  spearman {v['spearman']:.3f}  pair {v['pairAcc']:.3%}  close {v['closePairAcc']:.3%} (n={v['n']})")
    for pos in POSITIONS:
        row = '  '.join(f"{k}:{v['byPos'].get(pos, {}).get('mae', float('nan')):.2f}" for k, v in rep.items())
        print(f'    {pos}: {row}')

# Bootstrap (by week) confidence interval of the MAE improvement over the provider on 2025.
c25 = holdout[cohort(holdout)]
weeks = c25.week.unique()
diffs = []
for _ in range(1000):
    sample = RNG.choice(weeks, len(weeks))
    s = pd.concat([c25[c25.week == w] for w in sample])
    diffs.append(np.mean(np.abs(s.model - s.y)) - np.mean(np.abs(s.provider - s.y)))
ci = [round(float(np.percentile(diffs, 2.5)), 3), round(float(np.percentile(diffs, 97.5)), 3)]
print('MAE model - provider (2025) 95% CI:', ci, flush=True)

# ── 3. Residual quantiles for calibrated ranges (out-of-sample 2024 + 2025) ──
_, oos24 = add_predictions(relevant[relevant.season <= 2023], relevant[relevant.season == 2024], PARAMS, RESIDUAL, ITERS)
oos = pd.concat([oos24, holdout])
QS = np.linspace(0, 1, 21)
residuals = {}
coverage = {}
for pos in POSITIONS:
    g = oos[oos.pos == pos]
    edges = list(np.unique(np.quantile(g.model, [0.2, 0.4, 0.6, 0.8])))
    buckets = np.digitize(g.model, edges)
    table = []
    for b in range(len(edges) + 1):
        r = (g.y - g.model)[buckets == b].to_numpy()
        q = np.quantile(r, QS) if len(r) >= 30 else np.quantile((g.y - g.model).to_numpy(), QS)
        table.append([round(float(v), 3) for v in q])
    residuals[pos] = {'edges': [round(float(e), 3) for e in edges], 'quantiles': table}
    # Coverage check of the 10-90% band on 2025 using quantiles fit on 2024 only.
    g24, g25 = oos24[oos24.pos == pos], holdout[holdout.pos == pos]
    lo, hi = np.quantile(g24.y - g24.model, [0.1, 0.9])
    inside = ((g25.y >= g25.model + lo) & (g25.y <= g25.model + hi)).mean()
    coverage[pos] = round(float(inside), 4)
print('80% band coverage on 2025 (target 0.80):', coverage, flush=True)

# ── 4. Production model on everything through the latest completed week ─────
final = fit(relevant, PARAMS, RESIDUAL, ITERS)


def export_trees(model) -> dict:
    trees = []
    for iteration in model._predictors:
        for predictor in iteration:
            n = predictor.nodes
            trees.append({
                'f': [int(v) if not leaf else -1 for v, leaf in zip(n['feature_idx'], n['is_leaf'])],
                # A split on "value present vs missing" has an infinite threshold; JSON needs a finite stand-in.
                't': [float(np.clip(v, -1e300, 1e300)) if not leaf else 0.0 for v, leaf in zip(n['num_threshold'], n['is_leaf'])],
                'l': [int(v) for v in n['left']],
                'r': [int(v) for v in n['right']],
                'm': [int(v) for v in n['missing_go_to_left']],
                'v': [round(float(v), 6) for v in n['value']],
            })
    return {'baseline': float(np.ravel(model._baseline_prediction)[0]), 'trees': trees}


def tree_predict(export: dict, X: np.ndarray) -> np.ndarray:
    """Pure re-implementation used to prove the exported trees reproduce sklearn exactly."""
    out = np.full(len(X), export['baseline'])
    for tree in export['trees']:
        for i, row in enumerate(X):
            node = 0
            while tree['f'][node] != -1:
                v = row[tree['f'][node]]
                go_left = tree['m'][node] == 1 if math.isnan(v) else v <= tree['t'][node]
                node = tree['l'][node] if go_left else tree['r'][node]
            out[i] += tree['v'][node]
    return out


exported = export_trees(final)
sample = relevant.sample(300, random_state=1)
check = np.max(np.abs(tree_predict(exported, sample[FEATURES].to_numpy()) - final.predict(sample[FEATURES])))
print('export parity max abs diff:', check, flush=True)
assert check < 1e-3, 'exported trees do not reproduce sklearn predictions'

# Availability by official designation (measured, see availability.json).
avail_path = ROOT / f'availability{SUFFIX}.json'
avail_raw = json.loads((avail_path if avail_path.exists() else ROOT / 'availability.json').read_text())
none_rows = df[(df.inj == '') & (df.has_proj == 1)]
availability = {
    'none': round(float(none_rows.played.mean()), 4),
    'Questionable': avail_raw.get('Questionable', {}).get('rate', 0.67),
    'Doubtful': avail_raw.get('Doubtful', {}).get('rate', 0.01),
    'Out': 0.0,
    'n': {k: v['n'] for k, v in avail_raw.items() if ':' not in k and isinstance(v, dict) and 'n' in v},
}
if 'Questionable:starter' in avail_raw and 'Questionable:reserve' in avail_raw:
    availability['roles'] = {'Questionable': {'starter': avail_raw['Questionable:starter']['rate'], 'reserve': avail_raw['Questionable:reserve']['rate']}}
if avail_raw.get('ahead'):
    availability['ahead'] = avail_raw['ahead']

importance_model = holdout_model
# Permutation-free importance proxy: split gain summed per feature over the holdout model.
gain = np.zeros(len(FEATURES))
for iteration in importance_model._predictors:
    for predictor in iteration:
        n = predictor.nodes
        for f, g, leaf in zip(n['feature_idx'], n['gain'], n['is_leaf']):
            if not leaf:
                gain[f] += max(g, 0)
importance = sorted(({'feature': FEATURES[i], 'share': round(float(gain[i] / gain.sum()), 4)} for i in range(len(FEATURES))), key=lambda d: -d['share'])[:20]

meta = {
    'league': META.get('name'),
    'key': KEY or 'default',
    'version': time.strftime('%Y.%m.%d'),
    'trainedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'trainingRows': int(len(relevant)),
    'seasons': sorted(int(s) for s in relevant.season.unique()),
    'params': PARAMS,
    'residualTarget': RESIDUAL,
    'iterations': ITERS,
    'shrink': SHRINK,
}
model_json = {
    'meta': meta,
    'features': FEATURES,
    'residualTarget': RESIDUAL,
    'shrink': SHRINK,
    'points': exported,
    'residuals': residuals,
    'availability': availability,
}
MODEL_NAME = f'model{SUFFIX}.json'
REPORT_NAME = f'report{SUFFIX}.json'
(OUT / MODEL_NAME).write_text(json.dumps(model_json, separators=(',', ':')))
report = {
    'meta': meta,
    'holdout2025': report_2025,
    'live2026': report_2026,
    'live2026Weeks': sorted(int(w) for w in live_test.week.unique()) if len(live_test) else [],
    'maeDeltaCI2025': ci,
    'coverage80': coverage,
    'availability': availability,
    'importance': importance,
    'cohort': COHORT,
}
(OUT / REPORT_NAME).write_text(json.dumps(report, indent=1))
holdout[['season', 'week', 'player_id', 'pos', 'y', 'model', 'provider', 'linear', 'form']].to_csv(ROOT / f'predictions_2025{SUFFIX}.csv', index=False)
# Every 2025 candidate (including players who ended up inactive) for the lineup backtest,
# predicted by the model that never saw 2025.
all25 = df[df.season == 2025].copy()
all25['model'] = predict(holdout_model, all25, RESIDUAL)
all25['provider'] = all25.proj_pts
all25[['season', 'week', 'player_id', 'pos', 'played', 'y', 'inj', 'model', 'provider']].to_csv(ROOT / f'backtest_2025{SUFFIX}.csv', index=False)
# Parity fixture: production-model predictions for a sample, checked by the TypeScript runtime.
fixture = relevant.sample(400, random_state=3)
fixture_out = pd.DataFrame({'season': fixture.season, 'week': fixture.week, 'player_id': fixture.player_id, 'expected': predict(final, fixture, RESIDUAL)})
fixture_out.to_csv(ROOT / f'parity_fixture{SUFFIX}.csv', index=False)
print(f"wrote {MODEL_NAME} ({(OUT / MODEL_NAME).stat().st_size/1e6:.2f} MB) and {REPORT_NAME}", flush=True)
