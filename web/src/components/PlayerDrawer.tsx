import { X } from 'lucide-react';
import { usePlayer } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, kickoff, pct, prob, signed, FEATURE_LABELS } from '../lib/format.ts';
import { navigate, useSearchParam } from '../lib/router.ts';
import { HBars, RangeBar, Sparkline, useWidth } from '../charts/charts.tsx';
import { Card, Delta, Empty, Injury, Pos, Ranks, Skeleton, TeamLink, useEscape, cx } from './ui.tsx';
import { ForecastSource } from './ForecastSource.tsx';
import { ClaimPanel } from './ClaimPanel.tsx';

/** Short, human reading of a model input. */
function describe(key: string, v: number | null): string | null {
  if (v === null) return null;
  switch (key) {
    case 'opp_ratio': return `${signed((v - 1) * 100, 0)}% vs avg`;
    case 'opp_plays_ratio': return `${signed((v - 1) * 100, 0)}% plays vs avg`;
    case 'snap_l4': return `${fmt(v * 100, 0)}%`;
    case 'snap_trend': return `${signed(v * 100, 0)} pts`;
    case 'spread': return v > 0 ? `favoured by ${fmt(v, 1)}` : v < 0 ? `underdog by ${fmt(-v, 1)}` : 'pick’em';
    case 'proj_resid': return `${signed(v, 1)} / game`;
    case 'weeks_since': return v <= 1 ? 'played last week' : `${fmt(v, 0)} weeks`;
    case 'age': return fmt(v, 1);
    case 'big_rate': return `${fmt(v * 60, 1)} per 60 snaps`;
    default: return fmt(v, 1);
  }
}

const IDP_ONLY = new Set(['tkl_l4', 'big_rate', 'exp_big_pts']);
const OFFENSE_ONLY = new Set(['opps_l4']);
const relevantInput = (key: string, pos: string) => {
  const idp = pos === 'DL' || pos === 'LB' || pos === 'DB';
  if (idp) return !OFFENSE_ONLY.has(key);
  if (pos === 'K') return !IDP_ONLY.has(key) && !OFFENSE_ONLY.has(key) && !key.startsWith('snap');
  return !IDP_ONLY.has(key);
};

export function PlayerDrawer() {
  const [pid] = useSearchParam('player');
  const [dropParam] = useSearchParam('drop');
  const { leagueId, boot } = useApp();
  const q = usePlayer(leagueId, pid);
  const close = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete('player');
    params.delete('drop');
    navigate(`${window.location.pathname}${params.size ? `?${params}` : ''}`, { replace: true });
  };
  const dialog = useEscape(close, !!pid);
  if (!pid) return null;
  const d = q.data;
  const p = d?.player;
  const f = p?.week;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={p ? p.name : 'Player'}>
      <div className="absolute inset-0 bg-[var(--overlay)] fade-in" onClick={close} aria-hidden />
      <div ref={dialog} tabIndex={-1} className="safe-top slide-in relative flex h-full w-full max-w-[640px] flex-col overflow-hidden border-l border-line bg-page shadow-2xl">
        <div className="flex items-start gap-3 border-b border-line bg-surface px-4 py-4 sm:px-5">
          {q.isPending || !p ? <Skeleton className="h-12 w-60" /> : (
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Pos pos={p.pos} />
                <h2 className="truncate text-[20px] font-semibold tracking-tight">{p.name}</h2>
                <Ranks ranks={p.ranks} />
                <Injury status={p.injury} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
                <span>{p.team ?? 'Free agent (NFL)'}{p.number ? ` #${p.number}` : ''}</span>
                {p.age !== null && <span>Age {p.age}</span>}
                {p.exp !== null && <span>{p.exp === 0 ? 'Rookie' : `${p.exp} yrs exp`}</span>}
                {p.eligible.length > 1 && <span>Eligible: {p.eligible.join('/')}</span>}
                <span className="inline-flex items-center gap-1">· <TeamLink rosterId={p.owner} />{p.slot && p.slot !== 'START' && p.slot !== 'BN' ? ` (${p.slot})` : ''}</span>
              </div>
              {d?.details.injuryNotes && <div className="mt-1 text-[12px] text-ink-3">{d.details.injuryNotes}</div>}
            </div>
          )}
          <button onClick={close} className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close player"><X size={20} /></button>
        </div>
        <div className="safe-bottom overscroll-contain flex-1 space-y-4 overflow-y-auto p-4 scroll-thin sm:p-5">
          {q.isError && <Empty title="Couldn’t load this player">{(q.error as Error).message}</Empty>}
          {q.isPending && <div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-48" /></div>}
          {d && p && (
            <>
              {p.owner === null || p.owner !== boot.myRosterId ? <ClaimPanel pid={pid} initialDrop={dropParam} /> : null}
              {f ? (
                <Card>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="eyebrow">Week {f.week} forecast · {boot.league.name} scoring</div>
                    <div className="text-[12px] text-ink-3">{f.bye ? 'Bye week' : `${f.home ? 'vs' : '@'} ${f.opp} · ${kickoff(f.kickoff)}`}</div>
                  </div>
                  {f.live && f.live.status !== 'pre_game' ? (
                    <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                      <div>
                        <div className="flex items-center gap-1.5 text-[12px] text-ink-3">{f.live.status === 'in_game' && <span className="live-dot" />}{f.live.status === 'complete' ? 'Final' : 'Live'}</div>
                        <div className="num text-[28px] font-semibold leading-tight">{fmt(f.live.points)}</div>
                      </div>
                      {f.live.status === 'in_game' && <div><div className="text-[12px] text-ink-3">Projected final</div><div className="num text-[20px] font-semibold">{fmt(f.exp)}</div></div>}
                      <div><div className="text-[12px] text-ink-3">Pregame forecast</div><div className="num text-[20px] font-semibold">{fmt(d.pregame)}</div><ForecastSource source={d.pregameSource} savedAt={d.pregameSavedAt} />{d.pregame !== null && f.live.status === 'complete' && <Delta value={f.live.points - d.pregame} className="text-[12px]" />}</div>
                      <div><div className="text-[12px] text-ink-3">Sleeper projection</div><div className="num text-[20px] font-semibold">{fmt(f.provider)}</div></div>
                    </div>
                  ) : (
                    <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                      <div><div className="text-[12px] text-ink-3">Expected</div><div className="num text-[28px] font-semibold leading-tight">{fmt(f.exp)}</div></div>
                      <div><div className="text-[12px] text-ink-3">If active</div><div className="num text-[20px] font-semibold">{fmt(f.mean)}</div></div>
                      <div><div className="text-[12px] text-ink-3">Chance to play</div><div className="num text-[20px] font-semibold">{prob(f.play)}</div></div>
                      <div><div className="text-[12px] text-ink-3">Sleeper projection</div><div className="num text-[20px] font-semibold">{fmt(f.provider)}</div>{f.provider !== null && <div className="text-[12px] text-ink-3">Model adj. <Delta value={f.mean - f.provider} /></div>}</div>
                    </div>
                  )}
                  {f.live && f.live.status !== 'pre_game' && d.pregame === null && <p className="mt-2 text-[12px] text-ink-3">No verified forecast was saved before kickoff for this player.</p>}
                  {(!f.live || f.live.status === 'pre_game') && !f.bye && <p className="mt-2 text-[12px] leading-relaxed text-ink-3">Expected points = {fmt(f.mean)} if active × {pct(f.play, 1)} chance to play. Availability adjustment: {signed(f.exp - f.mean)} pts{f.provider === null ? '. No provider projection is available; this forecast relies on player history.' : '.'}</p>}
                  {f.live?.status !== 'complete' && (
                    <div className="mt-4">
                      <FluidRange floor={f.floor} median={f.median} ceiling={f.ceiling} expected={f.exp} max={Math.max(f.ceiling * 1.1, 10)} />
                      <div className="num mt-1 flex justify-between text-[12px] text-ink-3">
                        <span>Floor {fmt(f.floor)}</span><span>Median {fmt(f.median)}</span><span>Ceiling {fmt(f.ceiling)}</span>
                      </div>
                      {!f.live || f.live.status === 'pre_game' ? (
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
                          <span>Boom chance <b className="num text-ink">{pct(f.boom)}</b> <span className="text-ink-3">(≥{fmt(Math.max(10, f.mean * 1.5), 0)})</span></span>
                          <span>Bust chance <b className="num text-ink">{pct(f.bust)}</b> <span className="text-ink-3">(&lt;{fmt(f.mean * 0.5, 0)})</span></span>
                        </div>
                      ) : null}
                    </div>
                  )}
                </Card>
              ) : <Card><Empty title="No forecast">This player has no game or projection in the remaining schedule.</Empty></Card>}

              {d.outlook && (
                <Card>
                  <div className="eyebrow mb-1.5">ESPN outlook</div>
                  <p className="text-[13px] leading-relaxed text-ink-2">{d.outlook}</p>
                </Card>
              )}

              {Object.keys(d.inputs).length > 0 && (
                <Card>
                  <div className="eyebrow mb-2">What’s driving the forecast</div>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                    {Object.entries(d.inputs).filter(([k, v]) => v !== null && relevantInput(k, p.pos)).map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-3 border-b border-line py-1 text-[13px]">
                        <dt className="text-ink-2">{FEATURE_LABELS[k] ?? k}</dt>
                        <dd className="num text-right font-medium">{describe(k, v)}</dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              )}

              {d.projection && d.projection.breakdown.length > 0 && (
                <Card>
                  <div className="mb-2 flex items-baseline justify-between"><div className="eyebrow">Sleeper projection, rescored</div><div className="num text-[13px] font-semibold">{fmt(d.projection.total)} pts</div></div>
                  <HBars rows={d.projection.breakdown.slice(0, 10).map(b => ({ key: b.key, label: `${b.label} · ${fmt(b.stat, 2)}`, value: b.points, detail: <span>{fmt(b.stat, 2)} × {b.multiplier} = <b>{fmt(b.points, 2)}</b></span> }))} format={v => fmt(v, 1)} />
                </Card>
              )}

              {d.upcoming.length > 1 && (
                <Card>
                  <div className="eyebrow mb-2">Rest of season</div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-1">
                    {d.upcoming.map(u => u && (
                      <div key={u.week} className={cx('rounded-[8px] border border-line px-1 py-1.5 text-center', u.bye && 'opacity-50')}>
                        <div className="text-[10px] text-ink-3">W{u.week}</div>
                        <div className="text-[11px] text-ink-2">{u.bye ? 'BYE' : `${u.home ? '' : '@'}${u.opp}`}</div>
                        <div className="num text-[13px] font-semibold">{u.bye ? '—' : fmt(u.exp)}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {p.value && (
                <Card>
                  <div className="eyebrow mb-2">Value in this league</div>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(84px,1fr))] gap-3">
                    <div><div className="text-[12px] text-ink-3">SLA value</div><div className="num text-[18px] font-semibold">{fmt(p.value.value, 0)}</div></div>
                    {boot.league.isDynasty && <div><div className="text-[12px] text-ink-3">Dynasty</div><div className="num text-[18px] font-semibold">{fmt(p.value.dynasty, 0)}</div></div>}
                    <div><div className="text-[12px] text-ink-3">ROS / week</div><div className="num text-[18px] font-semibold">{fmt(p.value.rosAvg)}</div></div>
                    <div><div className="text-[12px] text-ink-3">Over waiver level</div><div className="num text-[18px] font-semibold">{signed(p.value.vorp)}</div></div>
                    <div><div className="text-[12px] text-ink-3">Pos rank</div><div className="num text-[18px] font-semibold">{p.pos}{p.value.posRank}</div></div>
                  </div>
                </Card>
              )}

              <GameLog d={d} pos={p.pos} weeks={p.season?.weeks as [number, number][] | undefined} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Indicator stats (a points- or yards-allowed bucket) read better as just their label. */
const BUCKET = /^(x_pa_|x_ya_|pts_allow_|yds_allow_)|^shutout$/;

function GameLog({ d, pos, weeks }: { d: NonNullable<ReturnType<typeof usePlayer>['data']>; pos: string; weeks?: [number, number][] }) {
  const { boot } = useApp();
  const snaps = pos !== 'K' && pos !== 'DEF';
  const cols = snaps ? 'grid-cols-[3.4rem_minmax(0,1fr)_3.25rem_3.25rem_2.75rem]' : 'grid-cols-[3.4rem_minmax(0,1fr)_3.25rem_3.25rem]';
  const labels = d.labels as Record<string, string>;
  const statText = (stats: Record<string, unknown>) => Object.entries(stats).slice(0, 5)
    .map(([k, v]) => (BUCKET.test(k) && v === 1 ? labels[k] ?? k : `${fmt(v as number, Number.isInteger(v) ? 0 : 1)} ${labels[k] ?? k}`)).join(' · ');
  return (
    <Card pad={false}>
      <div className="flex items-center justify-between px-4 pt-4 sm:px-5">
        <div className="eyebrow">Game log (league scoring)</div>
        {weeks && <Sparkline points={weeks} width={120} />}
      </div>
      <p className="px-4 pt-2 text-[11px] leading-relaxed text-ink-3 sm:px-5">Saved = recorded before kickoff. Replay = retrospective estimate from the current model trained on completed seasons and weeks, not out-of-sample evidence. Only verified saved forecasts count in the live track record.</p>
      {d.gameLog.length === 0 ? <Empty title="No games in the last two seasons" /> : (
        <div className="mt-2 max-h-[440px] overflow-y-auto scroll-thin">
          <div className={cx('num sticky top-0 z-[1] grid gap-2 border-b border-line bg-surface px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3 sm:px-5', cols)}>
            <span>Wk</span><span>Opp</span><span className="text-right" title="SLA forecast before kickoff">Proj</span><span className="text-right">Pts</span>{snaps && <span className="text-right">Snap</span>}
          </div>
          <ul>
            {d.gameLog.map(g => {
              const diff = g.proj === null ? 0 : g.pts - g.proj;
              const stats = statText(g.stats);
              return (
                <li key={`${g.season}-${g.week}`} className="border-b border-line px-4 py-2 last:border-b-0 sm:px-5">
                  <div className={cx('num grid items-baseline gap-2 text-[13px]', cols)}>
                    <span className="whitespace-nowrap text-ink-2">{g.season !== boot.league.season ? `’${String(g.season).slice(2)} ` : ''}W{g.week}</span>
                    <span className="truncate text-ink-2">{g.opp ?? '—'}</span>
                    <span className="text-right text-ink-3">{fmt(g.proj)}<ForecastSource source={g.projSource} savedAt={g.projSavedAt} /></span>
                    <span className={cx('text-right font-semibold', diff >= 3 ? 'text-good-ink' : diff <= -3 ? 'text-bad-ink' : 'text-ink')}>{fmt(g.pts)}</span>
                    {snaps && <span className="text-right text-ink-3">{g.snapShare === null ? '—' : pct(g.snapShare)}</span>}
                  </div>
                  {stats && <div className="mt-0.5 pl-[3.9rem] text-[12px] leading-snug text-ink-3">{stats}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

function FluidRange(props: { floor: number; median: number; ceiling: number; expected: number; max: number }) {
  const [ref, width] = useWidth<HTMLDivElement>(520);
  return <div ref={ref} className="w-full min-w-0"><RangeBar {...props} width={width} /></div>;
}
