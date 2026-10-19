import { useDeferredValue, useMemo, useState } from 'react';
import { ArrowRight, Search, TrendingUp } from 'lucide-react';
import { CLAIMS_AVAILABLE, useWaivers, type Waivers } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, pct, posLabel } from '../lib/format.ts';
import { Button, Card, CardHeader, Empty, ErrorState, InfoTip, Injury, PageHeader, PageSkeleton, PlayerLink, Pos, Ranks, Segmented, Stat, cx, useSort } from '../components/ui.tsx';
import { Sparkline } from '../charts/charts.tsx';
import { AutoClaims } from '../components/ClaimPanel.tsx';

export default function WaiversPage() {
  const { leagueId, myTeamId, teamName, boot, teams } = useApp();
  const q = useWaivers(leagueId, myTeamId);
  const mode = boot.league.waiverMode;
  const priority = myTeamId !== null ? teams.get(myTeamId)?.waiverPosition : undefined;
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const w = q.data;
  if (w.week === null) return <Empty title="The season is over" />;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Week ${w.week} · ${teamName(myTeamId)}`}
        title="Waiver wire"
      />
      <Card>
        <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
          <Stat label="Roster spots" value={`${w.rosterCount} / ${w.rosterLimit}`} sub={w.rosterCount >= w.rosterLimit ? 'Full: every add needs a drop' : `${w.rosterLimit - w.rosterCount} open`} />
          {mode === 'faab' ? <Stat label="FAAB remaining" value={`$${w.faabRemaining}`} />
            : mode === 'priority' ? <Stat label="Waiver priority" value={priority ? `#${priority}` : '—'} sub={`of ${boot.teams.length} · rolling`} />
            : <Stat label="Pickups" value="Free agency" sub="First come, first served" />}
          <Stat label="Horizon" value={`Weeks ${w.horizon[0]}–${w.horizon[w.horizon.length - 1]}`} />
          <Stat label="Pickups that help you" value={String(w.recommendations.length)} sub={`of ${w.availableCount} available`} />
        </div>
      </Card>
      <AutoClaims />
      <FreeAgents rows={w.freeAgents} total={w.availableCount} />
      <Recommendations recs={w.recommendations} faab={mode === 'faab'} />
    </div>
  );
}

function Recommendations({ recs, faab }: { recs: Waivers['recommendations']; faab: boolean }) {
  const { boot, openPlayer } = useApp();
  const claimable = boot.league.platform === 'espn' && CLAIMS_AVAILABLE;
  const [shown, setShown] = useState(10);
  if (!recs.length) return <Card><Empty title="No free agent improves your lineup">Your roster is deeper than the wire at every slot. Nice.</Empty></Card>;
  return (
    <Card>
      <CardHeader title="Top pickups for you" right={<InfoTip>{`Net gain = sum of weekly best-lineup improvements with the pickup over the rest of the season, after dropping the suggested player.${boot.league.isDynasty ? ' Drop suggestions weigh both lineup impact and dynasty value, so young upside players aren’t cut for a one-week rental.' : ''}`}</InfoTip>} />
      <div className="space-y-3">
        {recs.slice(0, shown).map((r, i) => (
          <div key={r.id} className="grid grid-cols-1 gap-3 rounded-[12px] border border-line p-3.5 xl:grid-cols-[28px_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1.2fr)] xl:items-center">
            <div className="num text-[15px] font-semibold text-ink-3">{i + 1}</div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[11px] font-semibold uppercase tracking-wide text-good-ink">Add</span><Pos pos={r.player.pos} /><PlayerLink id={r.id} name={r.player.name} /><span className="text-[12px] text-ink-3">{r.player.team}</span><Ranks ranks={r.player.ranks} /><Injury status={r.player.injury} /></div>
              {r.drop ? (
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-2"><span className="text-[11px] font-semibold uppercase tracking-wide text-bad-ink">Drop</span><Pos pos={r.drop.pos} /><PlayerLink id={r.drop.id} name={r.drop.name} className="font-normal text-ink-2" /><span className="num text-[12px] text-ink-3">{r.dropCost < 0.1 ? 'no lineup impact' : `costs ${fmt(r.dropCost)} pts`}</span></div>
              ) : <div className="mt-1 text-[12px] text-ink-3">Open roster spot, no drop needed</div>}
              {r.player.trending > 0 && <div className="mt-1 inline-flex items-center gap-1 text-[12px] text-ink-3"><TrendingUp size={12} aria-hidden />{r.player.trending.toLocaleString('en-US')} adds on Sleeper (48h)</div>}
              {claimable && <div className="mt-2"><Button size="sm" onClick={() => openPlayer(r.id, r.drop?.id)}>Claim{r.drop ? `, drop ${r.drop.name}` : ''}…</Button></div>}
            </div>
            <div className={cx('grid gap-2', faab ? 'grid-cols-3' : 'grid-cols-2')}>
              <div><div className="text-[11px] text-ink-3">Net ROS</div><div className="num text-[17px] font-semibold text-good-ink">+{fmt(r.netGain)}</div></div>
              <div><div className="text-[11px] text-ink-3">This week</div><div className="num text-[15px] font-semibold">{r.weekGain > 0.05 ? `+${fmt(r.weekGain)}` : '—'}</div></div>
              {faab && <div><div className="text-[11px] text-ink-3">FAAB</div><div className="num text-[15px] font-semibold">{r.faab ? `$${r.faab.low}–${r.faab.high}` : '—'}</div></div>}
            </div>
            <ul className="space-y-0.5 text-[12px] text-ink-2">
              {r.reasons.slice(0, 3).map(reason => <li key={reason} className="flex gap-1.5"><ArrowRight size={12} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />{reason}</li>)}
            </ul>
          </div>
        ))}
      </div>
      {shown < recs.length && <div className="mt-3 flex justify-center"><Button onClick={() => setShown(s => s + 10)}>Show more</Button></div>}
    </Card>
  );
}

const PAGE = 40;

/** Everyone available, first: what a waiver screen should open on. */
function FreeAgents({ rows, total }: { rows: Waivers['freeAgents']; total: number }) {
  const { boot } = useApp();
  const [pos, setPos] = useState<string>('ALL');
  const [text, setText] = useState('');
  const query = useDeferredValue(text.trim().toLowerCase());
  const [limit, setLimit] = useState(PAGE);
  const filtered = useMemo(() => rows.filter(r =>
    (pos === 'ALL' || r.pos === pos || r.eligible.includes(pos as never)) &&
    (!query || r.name.toLowerCase().includes(query) || (r.team ?? '').toLowerCase() === query)), [rows, pos, query]);
  const { sorted, header } = useSort(filtered, { key: 'ros', dir: 'desc' }, {
    name: r => r.name, gain: r => r.gain, exp: r => r.week?.exp, ros: r => r.value?.rosAvg, ppg: r => r.season?.ppg, last3: r => r.season?.last3, snap: r => r.season?.snap, trend: r => r.trending,
  });
  return (
    <Card pad={false}>
      <div className="space-y-3 px-4 pt-4 sm:px-5">
        <CardHeader title="Available players" subtitle={total > rows.length ? `Top ${rows.length} of ${total} free agents who could score this season` : `${total} free agents who could score this season`} />
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative flex min-w-[200px] flex-1 items-center sm:max-w-xs">
            <Search size={15} className="pointer-events-none absolute left-3 text-ink-3" aria-hidden />
            <span className="sr-only">Search available players</span>
            <input value={text} onChange={e => { setText(e.target.value); setLimit(PAGE); }} placeholder="Search name or NFL team" className="h-9 w-full rounded-[9px] border border-line-strong bg-surface pl-9 pr-3 text-[14px] placeholder:text-ink-3" />
          </label>
          <Segmented label="Position" value={pos} onChange={v => { setPos(v); setLimit(PAGE); }} options={['ALL', ...boot.league.positions].map(p => ({ value: p, label: posLabel(p, boot.league.platform) }))} />
        </div>
      </div>
      {sorted.length === 0 ? <Empty title="No available players match" /> : (
        <div className="mt-3 max-h-[640px] overflow-auto scroll-thin">
          <table className="tbl num text-[13px]">
            <thead>
              <tr>
                {header('name', 'Player', 'sticky-col')}
                {header('gain', <span className="inline-flex items-center gap-1">For you <InfoTip>Rest-of-season points this player adds to your best lineup, after the best drop. Shown for your top 30 pickups.</InfoTip></span>, 'r')}
                {header('exp', 'This week', 'r')}
                {header('ros', 'ROS / wk', 'r')}
                {header('ppg', 'Season avg', 'r')}
                {header('last3', 'Last 3', 'r')}
                <th className="hidden md:table-cell">Weekly</th>
                {header('snap', 'Snap %', 'r')}
                {header('trend', 'Adds (48h)', 'r')}
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, limit).map(r => (
                <tr key={r.id} className="row-hover">
                  <td className="sticky-col"><span className="flex items-center gap-2"><Pos pos={r.pos} /><PlayerLink id={r.id} name={r.name} className="max-w-[130px] sm:max-w-[180px]" /><span className="text-[11px] text-ink-3">{r.team}</span><span className="hidden items-center gap-1 sm:inline-flex"><Ranks ranks={r.ranks} /></span><Injury status={r.injury} /></span></td>
                  <td className={cx('r', r.gain ? 'font-semibold text-good-ink' : 'text-ink-3')}>{r.gain ? `+${fmt(r.gain)}` : '—'}</td>
                  <td className="r font-semibold">{r.week ? (r.week.bye ? 'BYE' : fmt(r.week.exp)) : '—'}</td>
                  <td className="r">{fmt(r.value?.rosAvg)}</td>
                  <td className="r text-ink-2">{fmt(r.season?.ppg)}</td>
                  <td className="r text-ink-2">{fmt(r.season?.last3)}</td>
                  <td className="hidden md:table-cell">{r.season && <Sparkline points={r.season.weeks as [number, number][]} width={72} height={20} />}</td>
                  <td className="r text-ink-2">{r.season?.snap !== null && r.season?.snap !== undefined ? pct(r.season.snap) : '—'}</td>
                  <td className="r text-ink-2">{r.trending ? r.trending.toLocaleString('en-US') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {limit < sorted.length && <div className="flex justify-center border-t border-line p-3"><Button onClick={() => setLimit(l => l + PAGE * 2)}>Show more ({sorted.length - limit} left)</Button></div>}
    </Card>
  );
}
