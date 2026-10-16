"""
In-season retraining experiment: what to train on once a season is five weeks old.

Protocol (mirrors the live situation in mid-October): for a test season S, train on earlier
seasons plus S weeks 1-5, then score S weeks 6+. Tune on S = 2024, report S = 2025 honestly.

Variants
  all        every season since 2020 + S weeks 1-5 (what production does today)
  recent2    only S-2, S-1 + S weeks 1-5
  weighted   every season, S weeks 1-5 x3, S-1 x2, S-2 x1.5, older x1
  recent2w   S-2, S-1 + S weeks 1-5, with the same weights

Usage: python window.py [key] [--dataset=-h2] [--drop=f1,f2] [--variants=all,recent2]
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import lab

ROOT = Path(__file__).resolve().parent
args = [a for a in sys.argv[1:] if not a.startswith('--')]
KEY = args[0] if args and args[0] != 'default' else ''
opts = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
suffix = f'-{KEY}' if KEY else ''
TAG = opts.get('dataset', '')
relevant = lab.setup(KEY, pd.read_csv(ROOT / f'dataset{suffix}{TAG}.csv', dtype={'player_id': str, 'inj': str}) if TAG else None)
VARIANTS = opts.get('variants', 'all,recent2,weighted,recent2w').split(',')
report = json.loads((ROOT.parent / 'model' / f'report{suffix}.json').read_text())
PARAMS = dict(report['meta']['params'])
RESIDUAL = report['meta']['residualTarget']
ITERS = report['meta']['iterations']
SHRINK = report['meta'].get('shrink', 1.0)
FIRST_TEST_WEEK = int(opts.get('from', 6))
drop = set(filter(None, opts.get('drop', '').split(',')))
FEATURES = [f for f in lab.FEATURES if f not in drop]
print('league', lab.META.get('name', 'default'), TAG or '(current dataset)', 'params', PARAMS, 'iters', ITERS, 'shrink', SHRINK, 'features', len(FEATURES), 'dropped', sorted(drop), flush=True)


def weights(frame: pd.DataFrame, S: int) -> np.ndarray:
    w = np.ones(len(frame))
    w[(frame.season == S).to_numpy()] = 3.0
    w[(frame.season == S - 1).to_numpy()] = 2.0
    w[(frame.season == S - 2).to_numpy()] = 1.5
    return w


def run(S: int, variant: str) -> dict:
    early = (relevant.season == S) & (relevant.week < FIRST_TEST_WEEK)
    if variant.startswith('recent2'):
        train = relevant[((relevant.season >= S - 2) & (relevant.season < S)) | early]
    else:
        train = relevant[(relevant.season < S) | early]
    test = relevant[(relevant.season == S) & (relevant.week >= FIRST_TEST_WEEK)].copy()
    sw = weights(train, S) if variant.endswith('w') or variant == 'weighted' else None
    model = lab.fit(train, PARAMS, RESIDUAL, ITERS, features=FEATURES, sample_weight=sw)
    test['model'] = lab.predict(model, test, RESIDUAL, shrink=SHRINK)
    lab.add_baselines(train, test)
    out = {'train_rows': int(len(train))}
    for col in ['model', 'provider']:
        out[col] = lab.score(test, col)
    return out


rows = []
for S in [2024, 2025]:
    for variant in VARIANTS:
        r = run(S, variant)
        m, p = r['model'], r['provider']
        print(f"S={S} {variant:9s} rows={r['train_rows']:6d}  MAE {m['mae']:.3f} (provider {p['mae']:.3f})  pair {m['pairAcc']:.4f} (provider {p['pairAcc']:.4f})  close {m['closePairAcc']:.4f}  bias {m['bias']:+.3f}", flush=True)
        rows.append({'season': S, 'variant': variant, **{f'model_{k}': v for k, v in m.items()}, **{f'provider_{k}': v for k, v in p.items()}})
pd.DataFrame(rows).to_csv(ROOT / f'window{suffix}{TAG}.csv', index=False)
