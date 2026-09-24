import { useState } from 'react';
import { usePower } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, record, teamColor } from '../lib/format.ts';
import { TrendChart } from '../charts/charts.tsx';
import { Card, CardHeader, ErrorState, InfoTip, Meter, PageHeader, PageSkeleton, PlayerLink, Pos, Segmented, TeamAvatar, TeamLink, cx } from '../components/ui.tsx';

export default function PowerPage() {
  const { leagueId, myTeamId, teamName } = useApp();
  const q = usePower(leagueId);
  const [focus, setFocus] = useState<number | null>(null);
  const [metric, setMetric] = useState<'value' | 'dynasty'>('value');
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const w = p.rankings[0]?.weights;
  const highlight = [myTeamId, focus].filter((x): x is number => x !== null);
  const maxValue = Math.max(...p.rankings.map(r => (metric === 'value' ? r.rosterValue : r.dynastyValue)), 1);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={p.week ? `Week ${p.week}` : 'Final'}
        title="Power rankings"
        subtitle={w ? `A blend of what teams have done and what their rosters project to do. This week: season scoring ${Math.round(w.season * 100)}%, all-play ${Math.round(w.allPlay * 100)}%, recent form ${Math.round(w.recent * 100)}%, rest-of-season outlook ${Math.round(w.outlook * 100)}%. The outlook carries more weight early in the year.` : undefined}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
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
            <CardHeader title="Power over the season" subtitle="Performance-only score after each week. Hover a team to compare." right={<InfoTip>History uses results only (points, all-play, recent form), because the projection piece can only be computed for the current roster.</InfoTip>} />
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
            <CardHeader title="Roster value" subtitle="Sum of player values in this league’s scoring" right={<Segmented label="Value type" value={metric} onChange={setMetric} options={[{ value: 'value', label: 'Overall' }, { value: 'dynasty', label: 'Dynasty' }]} />} />
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
