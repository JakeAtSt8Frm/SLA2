# SLA 2.0 · League Intelligence

A fantasy football analysis app for Sleeper leagues, built around **your league’s exact scoring**:
custom rules, IDP, superflex and TE premium. It combines an ffwrapped-style league hub
(standings, power rankings, playoff odds, awards, history) with SLA’s scoring-accurate analytics,
and adds a trained projection model that powers start/sit, waivers and trades.

Default league: **Neighbas in Paris** (`1312656463549726720`). Any Sleeper NFL league works:
switch from the league name in the top bar (league ID or Sleeper username).

## Quick start

```bash
npm install
npm run dev          # API on :8787 (auto-restarts) + web on http://localhost:5180
```

Production (one process serves the app and the API):

```bash
npm run build
npm start            # http://localhost:8787
```

Requires Node 23.6+ (runs the TypeScript server directly; no compile step).

Checks:

```bash
npm run check        # typecheck + unit tests (scoring parity, optimizer vs brute force, sims, model runtime)
npm run smoke        # hits every API endpoint of a running server
npm run verify:scoring   # replays every week of league history against Sleeper’s official scores
```

## What’s in it

| Page | What it answers |
|---|---|
| **League hub** | Your matchup and win odds, standings with all-play/luck, playoff and title odds, awards, last week, recent moves |
| **Start / sit** | Best legal lineup across all 21 slots (Hungarian assignment, kickoff locks respected), swap-by-swap confidence, win odds as set vs optimized |
| **Waiver wire** | Every free agent tested in *your* roster: rest-of-season points added to your best lineup, net of the best drop (dynasty-aware), FAAB guidance, rival demand |
| **Matchups** | 10,000-run player-level simulations, score distributions, side-by-side lineups, live scoring, past weeks |
| **Power rankings** | Composite of scoring, all-play, recent form and projected outlook, with trend and roster value |
| **Playoff odds** | 20,000 simulated seasons: playoff/bye/title odds, finish distribution, this-week leverage, every remaining game |
| **Roster & outlook** | Any team: positional strength vs league, schedule win odds, roster values, weekly scoring |
| **Trade lab** | Re-optimizes both rosters every remaining week, re-simulates playoff odds, compares now vs dynasty value |
| **Players** | 1,500+ players scored your way, model vs Sleeper edge, values; click any name for the full forecast, projection breakdown and game log |
| **Season wrapped / History** | Awards, luck, lineup efficiency, MVPs, weekly heatmap; champions, all-time records, head-to-head across seasons |
| **Model lab** | Holdout accuracy, lineup backtest, calibration, availability rates, live track record |

## How the numbers are made

1. **Scoring is exact.** Raw stat lines × the league’s own `scoring_settings`. Replaying 2024–2026
   reproduces **9,874 of 9,874** official player scores and all 216 team totals.
2. **Projection model** (`engine/features.ts`, `research/train.py`): gradient-boosted trees start from
   Sleeper’s component projection rescored for the league, and correct it using recent form, snap share
   and trend, per-snap tackle/big-play rates, projection-beating history, opponent points allowed,
   opponent pace, Vegas implied totals and spreads, rest, venue and age. It predicts points *if the player
   plays*, with monotonic constraints so better recent production can never lower a forecast.
3. **Availability** comes from the injury tag, measured on 2020–25 official reports: Questionable players
   played 67.5% of the time, Doubtful 0.9%, Out 0.35%.
4. **Uncertainty**: floors, ceilings, boom/bust and every simulation use out-of-sample residual
   distributions by position and projection level (80% bands cover 76–81% of 2025 outcomes).

### Measured accuracy (2025 held out; trained 2020–24)

| On realistic start/sit candidates (4,536 player-games) | MAE | Pairs ordered right | Close calls (≤3 pts) |
|---|---|---|---|
| **SLA model** | **6.18** | **59.5%** | **56.6%** |
| Sleeper projection, rescored for the league | 6.31 | 58.4% | 54.8% |
| SLA 1.0-style linear recalibration | 6.24 | 58.4% | 54.8% |
| Recent form only | 6.43 | 57.6% | 54.6% |

The MAE gain over Sleeper is significant (95% CI −0.18 to −0.05 points) and concentrated in IDP, where the
provider underrates sacks, INTs and pass breakups. On this league’s real 2025 rosters, model-set lineups
scored **+27 pts/week over what managers actually started**. Versus lineups set from Sleeper’s own numbers
the edge is +1.6 pts/week, which is too small to be statistically certain over one season
(95% CI −3.0 to +6.3). Honest bottom line: most of the win comes from always fielding the best legal,
injury-aware lineup across all 21 slots; the model adds a real but modest edge on top, mostly at DL/LB/DB.

**Caveat:** Sleeper’s historical projections are final versions and may reflect late news. The server
therefore saves every pregame forecast (`data/snapshots/`) and scores it after each week. That leakage-free
track record appears in the Model lab as the season goes on.

## Architecture

```
engine/     Pure TypeScript domain logic shared by server and research
            scoring · features · model runtime · forecasts · optimizer · lineups · simulations
            · values · waivers · trades · power · recap
server/     Hono API: Sleeper/nflverse clients with memory+disk caching and stale-while-revalidate,
            league "core" (every forecast for every remaining week, rebuilt in the background
            every 90 s), JSON views, pregame snapshot tracking
web/        React 19 + TanStack Query + Tailwind v4, hand-built SVG charts
research/   Data fetch, dataset build (same feature code as the server), training, backtest
model/      model.json (exported trees + residual tables) and report.json (Model lab)
tests/      Vitest suite incl. an official-score parity fixture
```

The live server and the training pipeline use the **same** feature code, and a parity check proves the
TypeScript tree runtime reproduces scikit-learn to within 0.00003 points.

## Retraining the model

```bash
python3 -m venv research/.venv && research/.venv/bin/pip install -r research/requirements.txt
npm run research     # fetch → dataset → train (tune 2024, hold out 2025) → backtest; writes model/
```

Run it during the season (e.g. weekly) to fold in new games. Everything is cached, so re-runs take a few minutes.

## Deploying

Any Node 23.6+ host works (Render, Railway, Fly.io, a VPS). A `Dockerfile` is included:

```bash
docker build -t sla2 . && docker run -p 8787:8787 -v sla-data:/app/.cache -v sla-snap:/app/data sla2
```

Environment: `PORT` (default 8787), `HOST` (use `0.0.0.0` in containers), `SLA_DEFAULT_LEAGUE`,
`SLA_CACHE_DIR`, `SLA_SNAPSHOT_DIR`. Persist the cache and snapshot directories so restarts are fast and
the live track record accumulates. GitHub Pages alone can’t host this, because the model and simulations
run server-side.

## Data sources

- Sleeper public API (free for non-commercial use): leagues, rosters, matchups, stats, projections.
- nflverse (CC BY 4.0): schedule, kickoff times and betting lines; injury reports for the availability study.
- DynastyProcess player ID crosswalk (GPL-3.0): used offline in research only.

`sla/` holds an earlier Codex scaffold and isn’t used by this app.
