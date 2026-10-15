# SLA 2.0 · League Intelligence

A fantasy football analysis app for Sleeper and ESPN leagues, built around **each league’s exact
scoring**: custom rules, IDP, superflex, TE premium, ESPN kicking and D/ST ladders. It combines an
ffwrapped-style league hub (standings, power rankings, playoff odds, awards, history) with SLA’s
scoring-accurate analytics, and adds trained projection models that power start/sit, waivers and trades.

Leagues set up in this deployment (switch from the league name in the top bar):

| League | Platform | Format | Model |
|---|---|---|---|
| **Neighbas in Paris** (`1312656463549726720`, default) | Sleeper | 6-team dynasty, superflex, 10 IDP | `model/model.json` |
| **UK-BG** (`espn-390483100`) | ESPN | 8-team redraft, PPR, D/ST with yards-allowed ladder | `model/model-espn-390483100.json` |
| **The O.J. Invitational** (`espn-1159035309`) | ESPN | 8-team redraft, half-PPR, D/ST | `model/model-espn-1159035309.json` |

Any other Sleeper NFL league also works (league ID or Sleeper username in the switcher).

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
npm run smoke        # hits every API endpoint of a running server, for every configured league
npm run bench        # cold league build, then first-request time and size of every view
npm run verify:scoring   # replays every week of league history against Sleeper’s official scores
npm run verify:espn      # rescoring ESPN leagues from stat lines vs ESPN’s official box scores
```

## What’s in it

| Page | What it answers |
|---|---|
| **League hub** | Your matchup and win odds, standings with all-play/luck, playoff and title odds, awards, last week, recent moves |
| **Start / sit** | Best legal lineup across every slot (Hungarian assignment, kickoff locks respected), swap-by-swap confidence, win odds as set vs optimized |
| **Waiver wire** | Every free agent tested in *your* roster: rest-of-season points added to your best lineup, net of the best drop (dynasty-aware in dynasty leagues), FAAB guidance or waiver priority, rival demand |
| **Matchups** | 8,000-run player-level simulations, score distributions, side-by-side lineups, live scoring, past weeks |
| **Power rankings** | Composite of scoring, all-play, recent form and projected outlook, with trend and roster value; season power ranks points scored plus the projection for every remaining regular-season week |
| **Playoff odds** | 12,000 simulated seasons: playoff/bye/title odds, finish distribution, this-week leverage, every remaining game |
| **Roster & outlook** | Any team: positional strength vs league, schedule win odds, roster values, weekly scoring |
| **Trade lab** | Re-optimizes both rosters every remaining week, re-simulates playoff odds, compares now vs dynasty value |
| **Players** | 1,500+ players scored your way, model vs Sleeper edge, values; click any name for the full forecast, projection breakdown and game log |
| **Season wrapped / History** | Awards, luck, lineup efficiency, MVPs, weekly heatmap; champions, all-time records, head-to-head across seasons |
| **Defense** | Points each defense allows to every position in league scoring (SLA 1.0’s matchup research), plus which offenses feed opposing D/STs |
| **Model lab** | The league’s own model: holdout accuracy, lineup backtest, calibration, availability rates, live track record |

## How the numbers are made

1. **Scoring is exact.** Raw stat lines × the league’s own `scoring_settings`. Replaying 2024–2026
   reproduces **9,874 of 9,874** official player scores and all 216 team totals.
2. **Projection model** (`engine/features.ts`, `research/train.py`): gradient-boosted trees start from
   Sleeper’s component projection rescored for the league, and correct it using recent form, snap share
   and trend, per-snap tackle/big-play rates, projection-beating history, opponent points allowed and
   opponent pace (this season’s games only), Vegas implied totals and spreads, rest, venue and age. It
   predicts points *if the player plays*, with monotonic constraints so better recent production can never
   lower a forecast.
3. **Availability** comes from the injury tag, measured on 2020–26 official reports: Questionable starters
   (≥50% of recent snaps) played 72.5% of the time and Questionable reserves 60.5%, Doubtful 0.9%, Out 0.35%.
   Season-long value also counts the chance of getting hurt or benched before each future week: a healthy
   starter plays the next week 93% of the time and eight weeks out only 83% (QBs 76%). Lineup planning
   keeps healthy availability, because a roster covers an injured starter from the bench.
4. **Uncertainty**: floors, ceilings, boom/bust and every simulation use out-of-sample residual
   distributions by position and projection level (80% bands cover 76–81% of 2025 outcomes).
5. **Season projections** (playoff odds, schedule, trade impact) scale each team's best lineup by how well
   its manager actually sets lineups (share of hindsight-optimal points started, relative to the league,
   shrunk toward average with six weeks of prior). Managers in this league started 68–97% of their best
   lineup's value, and the rate carries over within a season.

### Measured accuracy (2025 held out; trained 2020–24)

| On realistic start/sit candidates (4,536 player-games) | MAE | Pairs ordered right | Close calls (≤3 pts) |
|---|---|---|---|
| **SLA model** | **6.18** | **59.4%** | **56.6%** |
| Sleeper projection, rescored for the league | 6.31 | 58.4% | 54.8% |
| SLA 1.0-style linear recalibration | 6.24 | 58.4% | 54.8% |
| Recent form only | 6.43 | 57.6% | 54.6% |

The MAE gain over Sleeper is significant (95% CI −0.18 to −0.07 points) and concentrated in IDP, where the
provider underrates sacks, INTs and pass breakups. 2026 weeks 1–5 (model trained through 2025): MAE 6.40 vs
6.46, pairs ordered right 60.6% vs 58.6%. On this league’s real 2025 rosters, model-set lineups
scored **+28 pts/week over what managers actually started**. Versus lineups set from Sleeper’s own numbers
the edge is +2.8 pts/week, which is too small to be statistically certain over one season
(95% CI −0.4 to +6.4). Honest bottom line: most of the win comes from always fielding the best legal,
injury-aware lineup across all 21 slots; the model adds a real but modest edge on top, mostly at DL/LB/DB.

Tried in September 2026 and not adopted, because none held up on 2025 and 2026 after tuning on 2023–24:
weighting recent seasons more, season-to-date provider-bias features (league-wide by position, by team,
by opponent), other tree settings, a per-position recalibration of the output, and a per-position strength
for the model's correction. Elite DL remain under-predicted by about 1 point per game.

### ESPN leagues

ESPN supplies the league: settings, rosters, lineups, schedule, official scores, transactions and
history back to 2021. Player stats, projections and injury tags come from Sleeper, joined on ESPN player
id (then name and position for the few ids Sleeper lacks), and are scored with the ESPN league’s own rules
translated onto Sleeper stat keys (`server/espn.ts`). ESPN’s kicking buckets and D/ST points/yards-allowed
ladders don’t exist in Sleeper’s lines, so they are derived (`engine/derived.ts`). For projections the
D/ST ladder gets the *probability* of each bucket, not the one bucket the projected average falls in.

- **Scoring parity:** rescoring 3,281 ESPN player-weeks (both leagues, 2025–26, kickers and D/STs included)
  reproduces ESPN’s official points exactly, and all 202 team totals. `tests/fixtures/espn-parity.json`
  keeps 411 of them as a unit test.
- **Models:** each league has its own model trained on its scoring (offense and kickers; no IDP). The trees’
  correction to the provider is shrunk by a factor chosen on 2024 (0.5 for both). 2025 holdout MAE:
  O.J. **5.33 vs 5.36** for the rescored provider projection (95% CI of the gap −0.06 to −0.01),
  UK-BG **5.70 vs 5.72** (−0.05 to −0.00). That edge is small. Without IDP, Sleeper’s projections are already
  good. On the O.J.’s real 2025 rosters, model lineups and provider lineups are a wash (+0.1 pts/week,
  95% CI −0.3 to +0.5), and both beat what managers actually started by about +4.5 pts/week.
- **D/STs** use the rescored projection as the mean with the residual spread of every D/ST game since
  last season. A least-squares recalibration was tested out of sample and didn’t help.
- **Credentials** live in `config/espn.json` (`swid`, `espn_s2`, league list), overridable with `ESPN_SWID` and
  `ESPN_S2`. They are used server-side only and never sent to the browser; only configured leagues (and their
  past seasons) can be opened. `espn_s2` expires every few months. When it does, the ESPN leagues stop
  loading: copy fresh `SWID` and `espn_s2` cookies from a logged-in browser (DevTools › Application ›
  Cookies › espn.com) into the file and redeploy.

**Caveat:** Sleeper’s historical projections are final versions and may reflect late news. The server
therefore saves every pregame forecast (`data/snapshots/`) and scores it after each week. That leakage-free
track record appears in the Model lab as the season goes on.

## Architecture

```
engine/     Pure TypeScript domain logic shared by server and research
            scoring · features · model runtime · forecasts · optimizer · lineups · simulations
            · values · waivers · trades · power · recap
server/     Hono API: Sleeper/nflverse clients with memory+disk caching, stale-while-revalidate and
            conditional requests (stored ETags: an unchanged feed costs an empty 304, not a 6 MB
            download and parse; a core built from stale copies is rebuilt as soon as fresh ones land),
            league "core" (every forecast for every remaining week, re-checked every 90 s while games
            are on; rebuilds are incremental: feature history and each player's pregame forecast are
            reused unless their inputs changed, so a live scoring update costs ~40 ms instead of ~1 s),
            JSON views memoised per core and served pre-compressed (brotli) with ETags, pregame
            snapshot tracking
web/        React 19 + TanStack Query + Tailwind v4, hand-built SVG charts
research/   Data fetch, dataset build (same feature code as the server), training, backtests, review
model/      model.json / model-<league>.json (exported trees + residual tables) and matching report files
config/     espn.json: ESPN login cookies and league list (server-side only)
tests/      Vitest suite incl. Sleeper and ESPN official-score parity fixtures
```

The live server and the training pipeline use the **same** feature code, and a parity check proves the
TypeScript tree runtime reproduces scikit-learn to within 0.00003 points.

## Retraining the model

```bash
python3 -m venv research/.venv && research/.venv/bin/pip install -r research/requirements.txt
npm run research       # Sleeper league: fetch → dataset → train (tune 2024, hold out 2025) → backtest → review
npm run research:espn  # the same for each ESPN league (after research:fetch); writes model/model-espn-*.json
```

Any league can be trained on its own: `node research/build-dataset.ts <leagueId>`, then
`research/.venv/bin/python research/train.py <key>` and `node research/backtest.ts <leagueId>`, where the key is
`espn-<id>` for ESPN leagues. The server picks up `model/model-<key>.json` automatically.

Run it during the season (e.g. weekly) to fold in new games. A week counts as soon as all its games are final.
Everything is cached, so re-runs take a few minutes.

`npm run research:review` (`research/review.py`) is the predicted-vs-actual audit in the league's own scoring,
every number out of sample: weekly forecasts for last season and this season to date (by position, week and
forecast level), rest-of-season averages, and team scores on the league's real rosters
(`research/team-backtest.ts`). It writes `research/review.json`.

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
- ESPN Fantasy API (the league members’ own login): ESPN league settings, rosters, box scores, history.
- nflverse (CC BY 4.0): schedule, kickoff times and betting lines; injury reports for the availability study.
- DynastyProcess player ID crosswalk (GPL-3.0): used offline in research only.

`sla/` holds an earlier Codex scaffold and isn’t used by this app.
