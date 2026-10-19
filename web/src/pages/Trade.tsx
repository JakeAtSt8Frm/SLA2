import { useMemo, useState } from 'react';
import { ArrowLeftRight, Scale, X } from 'lucide-react';
import { usePlayers, useTrade, type ListRow, type Trade } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, posLabel, prob, signed, teamColor } from '../lib/format.ts';
import { Button, Card, CardHeader, Delta, Empty, ErrorState, Injury, PageHeader, PageSkeleton, PlayerLink, Pos, Select, TeamAvatar, cx } from '../components/ui.tsx';

export default function TradePage() {
  const { leagueId, boot, myTeamId, teamName } = useApp();
  const players = usePlayers(leagueId);
  const trade = useTrade(leagueId);
  const [a, setA] = useState<number>(myTeamId ?? boot.teams[0].rosterId);
  const [b, setB] = useState<number>(boot.teams.find(t => t.rosterId !== (myTeamId ?? boot.teams[0].rosterId))!.rosterId);
  const [aGives, setAGives] = useState<string[]>([]);
  const [bGives, setBGives] = useState<string[]>([]);
  const byOwner = useMemo(() => {
    const m = new Map<number, ListRow[]>();
    for (const p of players.data?.players ?? []) if (p.owner !== null) m.set(p.owner, [...(m.get(p.owner) ?? []), p]);
    return m;
  }, [players.data]);
  if (players.isPending) return <PageSkeleton />;
  if (players.isError) return <ErrorState error={players.error} onRetry={() => void players.refetch()} />;
  const pick = (side: 'a' | 'b', id: string) => {
    const set = side === 'a' ? setAGives : setBGives;
    set(list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]));
    trade.reset();
  };
  const swapTeams = () => { setA(b); setB(a); setAGives(bGives); setBGives(aGives); trade.reset(); };
  const run = () => trade.mutate({ a, b, aGives, bGives });
  return (
    <div className="space-y-5">
      <PageHeader title="Trade lab" />
      <p className="text-[12px] leading-relaxed text-ink-3">Scenarios assume the trade takes effect next scoring week. This week’s lineups and points stay with their current teams; your league’s actual trade processing time may differ.</p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <RosterPicker rosterId={a} onTeam={v => { setA(v); setAGives([]); if (v === b) setB(a); trade.reset(); }} exclude={b} players={byOwner.get(a) ?? []} selected={aGives} onPick={id => pick('a', id)} />
        <div className="flex items-center justify-center"><Button variant="ghost" onClick={swapTeams} title="Swap sides"><ArrowLeftRight size={18} /><span className="sr-only">Swap sides</span></Button></div>
        <RosterPicker rosterId={b} onTeam={v => { setB(v); setBGives([]); if (v === a) setA(b); trade.reset(); }} exclude={a} players={byOwner.get(b) ?? []} selected={bGives} onPick={id => pick('b', id)} />
      </div>
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[14px]">
          <b>{teamName(a)}</b> sends {aGives.length || 'nothing'}{aGives.length ? ` player${aGives.length > 1 ? 's' : ''}` : ''} · <b>{teamName(b)}</b> sends {bGives.length || 'nothing'}{bGives.length ? ` player${bGives.length > 1 ? 's' : ''}` : ''}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => { setAGives([]); setBGives([]); trade.reset(); }} disabled={!aGives.length && !bGives.length}>Clear</Button>
          <Button variant="primary" onClick={run} disabled={(!aGives.length && !bGives.length) || trade.isPending}><Scale size={15} />{trade.isPending ? 'Analyzing…' : 'Analyze trade'}</Button>
        </div>
      </Card>
      {trade.isError && <ErrorState error={trade.error} />}
      {trade.data && <Result r={trade.data} />}
    </div>
  );
}

function RosterPicker({ rosterId, onTeam, exclude, players, selected, onPick }: { rosterId: number; onTeam: (v: number) => void; exclude: number; players: ListRow[]; selected: string[]; onPick: (id: string) => void }) {
  const { boot } = useApp();
  const [pos, setPos] = useState('ALL');
  const list = players.filter(p => pos === 'ALL' || p.pos === pos).sort((x, y) => (y.value?.value ?? 0) - (x.value?.value ?? 0));
  return (
    <Card pad={false} className="flex max-h-[560px] flex-col">
      <div className="flex items-center gap-2 border-b border-line p-3">
        <TeamAvatar rosterId={rosterId} size={28} />
        <Select label="Team" value={rosterId} onChange={onTeam} options={boot.teams.filter(t => t.rosterId !== exclude).map(t => ({ value: t.rosterId, label: t.name }))} className="min-w-0 flex-1" />
        <Select label="Position" value={pos} onChange={setPos} options={['ALL', ...boot.league.positions].map(p => ({ value: p, label: posLabel(p, boot.league.platform) }))} className="w-20" />
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-line p-2.5">
          {selected.map(id => {
            const p = players.find(x => x.id === id);
            return p && <button key={id} onClick={() => onPick(id)} className="inline-flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1.5 text-[12px] font-medium text-ink" style={{ background: `color-mix(in oklab, ${teamColor(rosterId)} 18%, transparent)` }}>{p.name}<X size={12} aria-label="remove" /></button>;
          })}
        </div>
      )}
      <div className="flex-1 overflow-y-auto scroll-thin">
        {list.length === 0 ? <Empty title="No players" /> : list.map(p => {
          const on = selected.includes(p.id);
          return (
            <label key={p.id} className={cx('flex cursor-pointer items-center gap-2.5 border-b border-line px-3 py-2 text-[13px] hover:bg-surface-2', on && 'bg-accent-soft')}>
              <input type="checkbox" checked={on} onChange={() => onPick(p.id)} aria-label={`Include ${p.name}`} className="h-4 w-4 accent-[var(--accent)]" />
              <Pos pos={p.pos} />
              <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
              <Injury status={p.injury} />
              <span className="num w-12 text-right text-[12px] text-ink-3">{fmt(p.value?.rosAvg)}/wk</span>
              <span className="num w-9 text-right font-semibold">{fmt(p.value?.value, 0)}</span>
            </label>
          );
        })}
      </div>
    </Card>
  );
}

function Result({ r }: { r: Trade }) {
  const { teamName } = useApp();
  const verdict = r.verdict === 'fair' ? 'Roughly fair' : `Favours ${teamName(r.verdict === 'a' ? r.a.rosterId : r.b.rosterId)}`;
  return (
    <div className="space-y-4 fade-in">
      <Card className="flex items-center gap-3">
        <Scale className="shrink-0 text-ink-3" aria-hidden />
        <div>
          <div className="text-[18px] font-semibold">{verdict}</div>
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[r.a, r.b].map(s => <SideResult key={s.rosterId} s={s} weeks={r.weeks.length} />)}
      </div>
    </div>
  );
}

function SideResult({ s, weeks }: { s: Trade['a']; weeks: number }) {
  const { teamName, boot } = useApp();
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><TeamAvatar rosterId={s.rosterId} size={24} />{teamName(s.rosterId)}</span>} subtitle={`Roster after trade: ${s.rosterSizeAfter} active players`} />
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-[12px] text-ink-3">Rest-of-season points</div>
          <div className="num text-[24px] font-semibold"><Delta value={s.rosDelta} /></div>
          <div className="num text-[12px] text-ink-3">{signed(s.perWeekDelta, 2)} per week over {weeks} weeks</div>
        </div>
        <div>
          <div className="text-[12px] text-ink-3">Playoff odds</div>
          <div className="num text-[24px] font-semibold">{prob(s.oddsBefore.playoffPct)} <span className="text-ink-3">→</span> {prob(s.oddsAfter.playoffPct)}</div>
          <div className="num text-[12px] text-ink-3">Title {prob(s.oddsBefore.champPct)} → {prob(s.oddsAfter.champPct)}</div>
        </div>
        <div>
          <div className="text-[12px] text-ink-3">SLA value</div>
          <div className="num text-[16px] font-semibold">{fmt(s.valueOut, 0)} out · {fmt(s.valueIn, 0)} in <Delta value={s.valueIn - s.valueOut} digits={0} className="text-[13px]" /></div>
        </div>
        {boot.league.isDynasty && (
          <div>
            <div className="text-[12px] text-ink-3">Dynasty value</div>
            <div className="num text-[16px] font-semibold">{fmt(s.dynastyOut, 0)} out · {fmt(s.dynastyIn, 0)} in <Delta value={s.dynastyIn - s.dynastyOut} digits={0} className="text-[13px]" /></div>
          </div>
        )}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div><div className="eyebrow mb-1">Receives</div>{s.gets.length ? s.gets.map(p => <div key={p.id} className="flex items-center gap-2 py-0.5 text-[13px]"><Pos pos={p.pos} /><PlayerLink id={p.id} name={p.name} /><span className="num text-[12px] text-ink-3">{fmt(p.value?.rosAvg)}/wk</span></div>) : <div className="text-[13px] text-ink-3">Nothing</div>}</div>
        <div><div className="eyebrow mb-1">Sends</div>{s.gives.length ? s.gives.map(p => <div key={p.id} className="flex items-center gap-2 py-0.5 text-[13px] text-ink-2"><Pos pos={p.pos} /><PlayerLink id={p.id} name={p.name} className="font-normal text-ink-2" /><span className="num text-[12px] text-ink-3">{fmt(p.value?.rosAvg)}/wk</span></div>) : <div className="text-[13px] text-ink-3">Nothing</div>}</div>
      </div>
      {(s.newStarters.length > 0 || s.lostStarters.length > 0) && (
        <div className="mt-3 text-[12px] text-ink-2">
          {s.newStarters.length > 0 && <div>Next week’s lineup gains: {s.newStarters.join(', ')}</div>}
          {s.lostStarters.length > 0 && <div>Loses from lineup: {s.lostStarters.join(', ')}</div>}
        </div>
      )}
      <div className="mt-4">
        <div className="eyebrow mb-1.5">Weekly best-lineup points, before → after</div>
        <div className="flex gap-1 overflow-x-auto pb-1 scroll-thin">
          {s.byWeek.map(w => (
            <div key={w.week} className="min-w-[48px] rounded-[8px] border border-line px-1 py-1 text-center">
              <div className="text-[10px] text-ink-3">W{w.week}</div>
              <div className="num text-[12px] font-semibold"><Delta value={w.after - w.before} /></div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
