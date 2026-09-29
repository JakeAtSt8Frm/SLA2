"""
Predicted vs actual review in the league's own scoring, every number out of sample: each season is
predicted by a model trained only on earlier seasons (the production configuration from
model/model[-key].json).

Usage: python research/review.py [key]
Writes research/review[-key].json and research/oos[-key].csv, and prints a summary.

  1. Weekly player forecasts: accuracy on realistic start/sit candidates vs the rescored provider
     projection, by position and week, and calibration by forecast level.
  2. Rest of season: the average over the next eight weeks, with availability assumed flat (98.6%, the
     old behaviour) vs the weeks-ahead curve fit on earlier seasons only.
  3. Team scores on the league's real rosters (research/team-backtest.ts): projection bias and spread,
     and whether scaling each team by its manager's lineup efficiency predicts the second half better.
"""
import json
import subprocess
import sys
from math import erf, sqrt
from pathlib import Path

import numpy as np
import pandas as pd

import lab

ROOT = Path(__file__).resolve().parent
KEY = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != 'default' else ''
SUFFIX = f'-{KEY}' if KEY else ''
LEAGUE = {'': '1312656463549726720'}.get(KEY, KEY)

rel = lab.setup(KEY)
df = lab.df
MODEL_JSON = json.loads((ROOT.parent / 'model' / f'model{SUFFIX}.json').read_text())
PARAMS = dict(MODEL_JSON['meta']['params'])
ITERS = MODEL_JSON['meta']['iterations']
SHRINK = MODEL_JSON.get('shrink', 1.0)
AVAIL_NONE = MODEL_JSON['availability']['none']
CURRENT = int(df.season.max())
grp = lambda p: 'IDP' if p in ('DL', 'LB', 'DB') else p


def summarize(frame: pd.DataFrame, col: str) -> dict:
    err = frame[col] - frame.y
    return {'n': int(len(frame)), 'mae': round(float(err.abs().mean()), 3), 'rmse': round(float(np.sqrt((err ** 2).mean())), 3),
            'bias': round(float(err.mean()), 3), 'pairAcc': round(lab.pair_accuracy(frame, col)[0], 4)}


def calibration(frame: pd.DataFrame, col: str, bins=5) -> list[dict]:
    """Mean forecast vs mean outcome by forecast quintile, per position."""
    out = []
    for pos, g in frame.groupby('pos'):
        q = pd.qcut(g[col].rank(method='first'), bins, labels=False)
        for b, gb in g.groupby(q):
            out.append({'pos': pos, 'bin': int(b) + 1, 'n': int(len(gb)), 'pred': round(float(gb[col].mean()), 2), 'actual': round(float(gb.y.mean()), 2),
                        'provider': round(float(gb.provider.mean()), 2)})
    return out


# ── Out-of-sample predictions for every candidate row, 2022 → now ─────────────
oos = []
for season in range(2022, CURRENT + 1):
    model = lab.fit(rel[rel.season < season], PARAMS, True, ITERS)
    frame = df[df.season == season].copy()          # every candidate, incl. inactive (availability, team work)
    frame['model'] = lab.predict(model, frame, True, shrink=SHRINK)
    oos.append(frame)
    print('out-of-sample', season, flush=True)
oos = pd.concat(oos)
oos[['season', 'week', 'player_id', 'pos', 'team', 'played', 'y', 'inj', 'model', 'proj_pts', 'has_proj', 'n_l16', 'snap_l4', 'ewma', 'mean_prev']].to_csv(ROOT / f'oos{SUFFIX}.csv', index=False)

# ── 1. Weekly player forecasts ────────────────────────────────────────────────
weekly = {}
for season in (CURRENT - 1, CURRENT):
    test = oos[(oos.season == season) & (oos.played == 1) & ((oos.has_proj == 1) | (oos.n_l16.fillna(0) >= 2))].copy()
    lab.add_baselines(rel[rel.season < season], test)
    c = test[lab.cohort(test)]
    weekly[str(season)] = {
        'cohort': {name: summarize(c, name) for name in ['model', 'provider', 'linear', 'form']},
        'byPos': {pos: {name: summarize(g, name) for name in ['model', 'provider']} for pos, g in c.groupby('pos')},
        'byWeek': [{'week': int(w), **{name: summarize(g, name) for name in ['model', 'provider']}} for w, g in c.groupby('week')],
        'calibration': calibration(c, 'model'),
    }

# ── 2. Rest of season: flat availability vs the weeks-ahead curve ─────────────
teams_week = df[df.played == 1].groupby(['season', 'week']).team.apply(set).to_dict()
played = set(map(tuple, df[df.played == 1][['season', 'week', 'player_id']].to_numpy()))
points = {(s, w, p): y for s, w, p, y in df[df.played == 1][['season', 'week', 'player_id', 'y']].itertuples(index=False)}
last_week = df.groupby('season').week.max().to_dict()
healthy_starter = (df.has_proj == 1) & (df.inj == '') & (df.snap_l4 >= 0.5)


def ahead_curve(seasons, horizon=17) -> pd.DataFrame:
    rows = []
    anchor = df[healthy_starter & (df.played == 1) & df.season.isin(seasons)]
    for s, w, pid, pos, team in anchor[['season', 'week', 'player_id', 'pos', 'team']].itertuples(index=False):
        for k in range(1, horizon + 1):
            if w + k > last_week[s]:
                break
            if team in teams_week.get((s, w + k), set()):
                rows.append((grp(pos), k, (s, w + k, pid) in played))
    return pd.DataFrame(rows, columns=['g', 'k', 'played']).groupby(['g', 'k']).played.mean().unstack().ffill(axis=1)


ros = {}
for season in (CURRENT - 2, CURRENT - 1):
    curve = ahead_curve(range(2020, season))
    base = oos[(oos.season == season) & (oos.has_proj == 1) & (oos.inj == '') & (oos.snap_l4 >= 0.5)]
    rows = []
    for r in base.itertuples(index=False):
        future = [w for w in range(r.week + 1, min(last_week[season], r.week + 8) + 1) if r.team in teams_week.get((season, w), set())]
        if len(future) < 4:
            continue
        actual = np.mean([points.get((season, w, r.player_id), 0.0) for w in future])
        p_curve = np.mean([curve.loc[grp(r.pos), min(w - r.week, curve.columns.max())] for w in future])
        rows.append((r.pos, actual, r.model, r.model * AVAIL_NONE, r.model * p_curve))
    t = pd.DataFrame(rows, columns=['pos', 'actual', 'model', 'flat', 'curve'])
    ros[str(season)] = {name: {'bias': round(float((t[name] - t.actual).mean()), 3), 'mae': round(float((t[name] - t.actual).abs().mean()), 3)} for name in ('flat', 'curve')}
    ros[str(season)]['n'] = int(len(t))
    ros[str(season)]['biasByPos'] = {name: (t[name] - t.actual).groupby(t.pos).mean().round(2).to_dict() for name in ('flat', 'curve')}

# ── 3. Team scores on the league's real rosters ───────────────────────────────
team = {}
if subprocess.run(['node', str(ROOT / 'team-backtest.ts'), LEAGUE], cwd=ROOT.parent).returncode == 0:
    t = pd.read_csv(ROOT / f'team_backtest{SUFFIX}.csv')
    Phi = np.vectorize(lambda x: 0.5 * (1 + erf(x / sqrt(2))))
    team['bySeason'] = {str(s): {'teamWeeks': int(len(g)), 'projectedAsSet': round(float(g.as_set.mean()), 1), 'projectedOptimal': round(float(g.optimal.mean()), 1),
                                  'actual': round(float(g.actual.mean()), 1), 'mae': round(float((g.actual - g.as_set).abs().mean()), 2),
                                  'residualSd': round(float((g.actual - g.as_set).std()), 2), 'modelSd': round(float(g.as_set_sd.mean()), 2)}
                        for s, g in t.groupby('season')}
    # Second half of each completed season, projected from the first: optimal lineups (old) vs
    # scaled by each manager's lineup efficiency so far (shrunk toward the league with 6 weeks of prior).
    seasons = [s for s in t.season.unique() if s < CURRENT]
    split = {}
    for after in (4, 6, 8):
        err = {'optimal': [], 'manager': []}
        brier = {'optimal': [], 'manager': []}
        for s in seasons:
            g = t[t.season == s]
            first, second = g[g.week <= after], g[g.week > after]
            league = first.actual.sum() / first.hindsight.sum()
            eff = first.groupby('roster').actual.sum() / first.groupby('roster').hindsight.sum() / league
            factor = ((after * eff + 6) / (after + 6)).clip(0.8, 1.1).to_dict()
            for r, gg in second.groupby('roster'):
                err['optimal'].append(gg.optimal.mean() - gg.actual.mean())
                err['manager'].append(gg.optimal.mean() * factor[r] - gg.actual.mean())
            m = second.merge(second[['week', 'roster', 'optimal', 'optimal_sd', 'actual']], left_on=['week', 'opponent'], right_on=['week', 'roster'], suffixes=('', '_o'))
            m = m[m.roster < m.roster_o]
            win = (m.actual > m.actual_o).astype(float).to_numpy()
            fa, fb = m.roster.map(factor).to_numpy(), m.roster_o.map(factor).to_numpy()
            for name, (a, b) in {'optimal': (1, 1), 'manager': (fa, fb)}.items():
                sd = np.sqrt(m.optimal_sd ** 2 + m.optimal_sd_o ** 2 + (0.03 * m.optimal * a) ** 2 + (0.03 * m.optimal_o * b) ** 2)
                p = Phi((m.optimal * a - m.optimal_o * b) / sd)
                brier[name].extend(((p - win) ** 2).tolist())
        split[f'afterWeek{after}'] = {name: {'mae': round(float(np.mean(np.abs(err[name]))), 2), 'bias': round(float(np.mean(err[name])), 2), 'brier': round(float(np.mean(brier[name])), 4)}
                                      for name in err} | {'games': len(brier['optimal']), 'teamSeasons': len(err['optimal'])}
    team['secondHalf'] = split

report = {'weekly': weekly, 'restOfSeason': ros, 'team': team}
(ROOT / f'review{SUFFIX}.json').write_text(json.dumps(report, indent=1))

for season, r in weekly.items():
    print(f'\nWeekly forecasts {season} (trained on earlier seasons)')
    for name, v in r['cohort'].items():
        print(f"  {name:9s} MAE {v['mae']:.3f}  RMSE {v['rmse']:.3f}  bias {v['bias']:+.3f}  pairs {v['pairAcc']:.2%}  (n={v['n']})")
    for pos, v in r['byPos'].items():
        m, p = v['model'], v['provider']
        print(f"    {pos:3s} model MAE {m['mae']:.2f} bias {m['bias']:+.2f} | provider MAE {p['mae']:.2f} bias {p['bias']:+.2f}  (n={m['n']})")
print('\nRest of season (next 8 weeks, healthy starters):', json.dumps({s: {k: v for k, v in r.items() if k != 'biasByPos'} for s, r in ros.items()}))
if team:
    print('Team projections:', json.dumps(team['bySeason']))
    print('Second half from first half:', json.dumps(team['secondHalf']))
