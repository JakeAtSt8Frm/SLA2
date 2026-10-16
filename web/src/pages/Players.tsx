import { useDeferredValue, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { usePlayers } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, pct, posLabel } from '../lib/format.ts';
import { Sparkline } from '../charts/charts.tsx';
import { Button, Card, Delta, Empty, ErrorState, InfoTip, Injury, PageHeader, PageSkeleton, PlayerLink, Pos, Ranks, Segmented, Select, TeamDot, TeamLink, useSort } from '../components/ui.tsx';

type Avail = 'all' | 'fa' | 'rostered' | 'mine';

export default function PlayersPage() {
  const { leagueId, myTeamId, boot, teamName } = useApp();
  const q = usePlayers(leagueId);
  const [text, setText] = useState('');
  const query = useDeferredValue(text.trim().toLowerCase());
  const [pos, setPos] = useState('ALL');
  const [avail, setAvail] = useState<Avail>('all');
  const activeAvail = avail === 'mine' && myTeamId === null ? 'all' : avail;
  const [limit, setLimit] = useState(100);
  const rows = useMemo(() => (q.data?.players ?? []).filter(r =>
    (pos === 'ALL' || r.pos === pos) &&
    (activeAvail === 'all' || (activeAvail === 'fa' ? r.owner === null : activeAvail === 'rostered' ? r.owner !== null : r.owner === myTeamId)) &&
    (!query || r.name.toLowerCase().includes(query) || (r.team ?? '').toLowerCase() === query)), [q.data, pos, activeAvail, query, myTeamId]);
  const { sorted, header } = useSort(rows, { key: 'value', dir: 'desc' }, {
    name: r => r.name, exp: r => r.week?.exp, edge: r => (r.week && r.week.provider !== null ? r.week.exp - r.week.provider : null), ros: r => r.value?.rosAvg,
    ppg: r => r.season?.ppg, last3: r => r.season?.last3, snap: r => r.season?.snap, value: r => r.value?.value, dynasty: r => r.value?.dynasty, vorp: r => r.value?.vorp, age: r => r.age,
  });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="space-y-5">
      <PageHeader title="Players" />
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex min-w-[220px] flex-1 items-center sm:max-w-xs">
          <Search size={15} className="pointer-events-none absolute left-3 text-ink-3" aria-hidden />
          <span className="sr-only">Search players</span>
          <input value={text} onChange={e => { setText(e.target.value); setLimit(100); }} placeholder="Search name or NFL team" className="h-9 w-full rounded-[9px] border border-line-strong bg-surface pl-9 pr-3 text-[14px] placeholder:text-ink-3" />
        </label>
        <Segmented label="Position" value={pos} onChange={v => { setPos(v); setLimit(100); }} options={['ALL', ...boot.league.positions].map(p => ({ value: p, label: posLabel(p, boot.league.platform) }))} />
        <Select<Avail> label="Availability" value={activeAvail} onChange={v => { setAvail(v); setLimit(100); }} options={[{ value: 'all', label: 'All players' }, { value: 'fa', label: 'Free agents' }, { value: 'rostered', label: 'Rostered' }, ...(myTeamId !== null ? [{ value: 'mine' as Avail, label: 'My team' }] : [])]} className="w-40" />
      </div>
      <Card pad={false}>
        {sorted.length === 0 ? <Empty title="No players match">Try another name, position or availability filter.</Empty> : (
          <div className="max-h-[calc(100dvh-240px)] overflow-auto scroll-thin">
            <table className="tbl num text-[13px]">
              <thead>
                <tr>
                  {header('name', 'Player', 'sticky-col')}
                  <th>Owner</th>
                  {header('exp', `Wk ${boot.league.week ?? ''}`, 'r')}
                  {header('edge', <span className="inline-flex items-center gap-1">vs Sleeper <InfoTip>SLA expected points minus Sleeper’s projection rescored for this league. Positive = the model is higher.</InfoTip></span>, 'r')}
                  {header('ros', 'ROS/wk', 'r')}
                  {header('ppg', 'Avg', 'r')}
                  {header('last3', 'L3', 'r')}
                  <th className="hidden lg:table-cell">Weekly</th>
                  {header('snap', 'Snap%', 'r')}
                  {header('vorp', <span className="inline-flex items-center gap-1">+Waiver <InfoTip>Points per week above the best free agents at the position.</InfoTip></span>, 'r')}
                  {header('value', 'Value', 'r')}
                  {boot.league.isDynasty && header('dynasty', 'Dynasty', 'r')}
                  {header('age', 'Age', 'r')}
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, limit).map(r => (
                  <tr key={r.id} className="row-hover">
                    <td className="sticky-col"><span className="flex items-center gap-2"><Pos pos={r.pos} /><PlayerLink id={r.id} name={r.name} className="max-w-[130px] sm:max-w-[170px]" /><span className="text-[11px] text-ink-3">{r.team ?? 'FA'}</span><span className="hidden items-center gap-1 sm:inline-flex"><Ranks ranks={r.ranks} /></span><Injury status={r.injury} /></span></td>
                    <td className="max-w-[150px] text-[12px]">{r.owner !== null ? <><span className="sm:hidden" title={teamName(r.owner)}><TeamDot rosterId={r.owner} /></span><span className="hidden sm:inline"><TeamLink rosterId={r.owner} /></span></> : <span className="text-ink-3"><span className="sm:hidden">FA</span><span className="hidden sm:inline">Free agent</span></span>}</td>
                    <td className="r font-semibold">{r.week ? (r.week.bye ? 'BYE' : fmt(r.week.exp)) : '—'}</td>
                    <td className="r text-[12px]">{r.week && r.week.provider !== null && !r.week.bye ? <Delta value={r.week.exp - r.week.provider} /> : '—'}</td>
                    <td className="r">{fmt(r.value?.rosAvg)}</td>
                    <td className="r text-ink-2">{fmt(r.season?.ppg)}</td>
                    <td className="r text-ink-2">{fmt(r.season?.last3)}</td>
                    <td className="hidden lg:table-cell">{r.season && <Sparkline points={r.season.weeks as [number, number][]} width={64} height={18} />}</td>
                    <td className="r text-ink-2">{r.season?.snap !== null && r.season?.snap !== undefined ? pct(r.season.snap) : '—'}</td>
                    <td className="r"><Delta value={r.value?.vorp ?? null} /></td>
                    <td className="r font-medium">{fmt(r.value?.value, 0)}</td>
                    {boot.league.isDynasty && <td className="r text-ink-2">{fmt(r.value?.dynasty, 0)}</td>}
                    <td className="r text-ink-2">{r.age ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {limit < sorted.length && <div className="flex justify-center"><Button onClick={() => setLimit(l => l + 150)}>Show more ({(sorted.length - limit).toLocaleString('en-US')} left)</Button></div>}
    </div>
  );
}
