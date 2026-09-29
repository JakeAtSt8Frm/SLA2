import { useState } from 'react';
import { usePower } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, record, teamColor } from '../lib/format.ts';
import { TrendChart } from '../charts/charts.tsx';
import { Card, CardHeader, ErrorState, Meter, PageHeader, PageSkeleton, PlayerLink, Pos, Segmented, TeamAvatar, TeamLink, cx, useTooltip } from '../components/ui.tsx';

export default function PowerPage() {
  const { leagueId, myTeamId, teamName, boot } = useApp();
  const q = usePower(leagueId);
  const [focus, setFocus] = useState<number | null>(null);
  const [chosen, setMetric] = useState<'value' | 'dynasty'>('value');
  const tip = useTooltip();
  const metric = boot.league.isDynasty ? chosen : 'value';
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const highlight = [myTeamId, focus].filter((x): x is number => x !== null);
  const maxValue = Math.max(...p.rankings.map(r => (metric === 'value' ? r.rosterValue : r.dynastyValue)), 1);
  const sp = p.season;
  const maxTotal = Math.max(...sp.rankings.map(r => r.total), 1);
  const seasonSpan = [
    sp.playedWeeks ? `Wk${sp.playedWeeks > 1 ? 's' : ''} 1${sp.playedWeeks > 1 ? `–${sp.playedWeeks}` : ''} scored` : null,
    sp.firstRemaining !== null ? `wk${sp.remainingWeeks > 1 ? 's' : ''} ${sp.firstRemaining}${sp.remainingWeeks > 1 ? `–${sp.lastRegularWeek}` : ''} projected` : null,
  ].filter(Boolean).join(' + ');
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={p.week ? `Week ${p.week}` : 'Final'}
        title="Power rankings"
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card pad={false}>
          <div className="divide-y divide-[var(--line)]">
            {p.rankings.map(r => (
              <div key={r.rosterId} className={cx('grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-3 p-4 sm:px-5', r.rosterId === myTeamId && 'bg-accent-soft')}
                onMouseEnter={() => setFocus(r.rosterId)} onMouseLeave={() => setFocus(null)}>
                <div className="num pt-1 text-[22px] font-semibold text-ink-3">{r.rank}</div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5"><TeamAvatar rosterId={r.rosterId} size={30} /><div className="min-w-0"><TeamLink rosterId={r.rosterId} className="font-semibold" /><div className="text-[12px] text-ink-3">{record(r.wins, r.losses, r.ties)} · {fmt(r.ppg)} ppg · outlook {fmt(r.outlookPpg)} / wk</div></div></div>
                  <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-4">
                    {([['season', 'Scoring'], ['allPlay', 'All-play'], ['recent', 'Recent'], ['outlook', 'Outlook']] as const).map(([k, label]) => (
                      <div key={k}>
                        <div className="flex justify-between text-[11px] text-ink-3"><span>{label}</span><span className="num">{fmt(r.components[k], 0)}</span></div>
                        <Meter value={r.components[k] / 100} color={teamColor(r.rosterId)} label={`${label} ${fmt(r.components[k], 0)}`} />
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-2">
                    {r.keyPlayers.map(k => <span key={k.id} className="inline-flex items-center gap-1.5"><Pos pos={k.pos} /><PlayerLink id={k.id} name={k.name} className="font-normal" /></span>)}
                  </div>
                </div>
                <div className="text-right"><div className="num text-[26px] font-semibold leading-none">{fmt(r.score, 0)}</div><div className="text-[11px] text-ink-3">/ 100</div></div>
              </div>
            ))}
          </div>
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Season power" subtitle={seasonSpan} />
            <div className="-mx-1.5 space-y-1">
              {sp.rankings.map(r => (
                <div key={r.rosterId} className={cx('grid grid-cols-[18px_minmax(110px,38%)_1fr_52px] items-center gap-2 rounded-[6px] px-1.5 py-1 text-[13px]', r.rosterId === myTeamId && 'bg-accent-soft')}
                  onMouseEnter={() => setFocus(r.rosterId)} onMouseLeave={() => { setFocus(null); tip.hide(); }}
                  onMouseMove={e => tip.show(e, (
                    <div className="num space-y-0.5">
                      <div className="font-semibold">{teamName(r.rosterId)}</div>
                      <div>{fmt(r.scored)} scored over {sp.playedWeeks} wk</div>
                      <div>{fmt(r.projected)} projected over {sp.remainingWeeks} wk</div>
                      <div className="text-ink-2">{fmt(r.ppg)} per week · {r.scoredRank === r.rank ? 'same rank as points so far' : `#${r.scoredRank} in points so far`}</div>
                    </div>
                  ))}>
                  <div className="num text-center font-semibold text-ink-3">{r.rank}</div>
                  <TeamLink rosterId={r.rosterId} />
                  <div className="flex h-3" role="img" aria-label={`${fmt(r.scored)} scored, ${fmt(r.projected)} projected`}>
                    <div className="h-full" style={{ width: `${(r.scored / maxTotal) * 100}%`, background: teamColor(r.rosterId) }} />
                    <div className="h-full rounded-r-[4px]" style={{ width: `${(r.projected / maxTotal) * 100}%`, background: `color-mix(in oklab, ${teamColor(r.rosterId)} 35%, transparent)` }} />
                  </div>
                  <div className="num text-right font-medium">{fmt(r.total, 0)}</div>
                </div>
              ))}
            </div>
            {sp.playedWeeks > 0 && sp.remainingWeeks > 0 && (
              <div className="mt-3 flex gap-4 text-[12px] text-ink-2">
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] bg-ink-3" />Scored</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: 'color-mix(in oklab, var(--ink-3) 35%, transparent)' }} />Projected</span>
              </div>
            )}
            {tip.node}
          </Card>
          <Card>
            <CardHeader title="Power over the season" />
            {p.history.length < 2 ? <div className="py-8 text-center text-[13px] text-ink-3">The trend appears after two completed weeks.</div> : (
              <TrendChart
                labels={p.history.map(h => h.week)}
                series={p.rankings.map(r => ({ id: r.rosterId, name: teamName(r.rosterId), values: p.history.map(h => h.ranks.find(x => x.rosterId === r.rosterId)?.score ?? null) }))}
                highlight={highlight}
                yDomain={[0, 100]}
                yLabel="Power score by week"
              />
            )}
            <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-ink-2">
              {p.rankings.map(r => (
                <button key={r.rosterId} onMouseEnter={() => setFocus(r.rosterId)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(r.rosterId)} onBlur={() => setFocus(null)} className="inline-flex items-center gap-1.5">
                  <span className="h-[2px] w-3 rounded" style={{ background: highlight.includes(r.rosterId) ? teamColor(r.rosterId) : 'var(--axis)' }} />{teamName(r.rosterId)}
                </button>
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title="Roster value" right={boot.league.isDynasty ? <Segmented label="Value type" value={metric} onChange={setMetric} options={[{ value: 'value', label: 'Overall' }, { value: 'dynasty', label: 'Dynasty' }]} /> : undefined} />
            <div className="space-y-2">
              {[...p.rankings].sort((a, b) => (metric === 'value' ? b.rosterValue - a.rosterValue : b.dynastyValue - a.dynastyValue)).map(r => {
                const v = metric === 'value' ? r.rosterValue : r.dynastyValue;
                return (
                  <div key={r.rosterId} className="grid grid-cols-[minmax(110px,40%)_1fr_48px] items-center gap-2 text-[13px]">
                    <TeamLink rosterId={r.rosterId} />
                    <div className="h-3"><div className="h-full rounded-r-[4px]" style={{ width: `${(v / maxValue) * 100}%`, background: teamColor(r.rosterId) }} /></div>
                    <div className="num text-right font-medium">{fmt(v, 0)}</div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
