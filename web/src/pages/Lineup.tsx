import { ArrowRight, Check, CircleAlert, Lock, MoveRight } from 'lucide-react';
import { useLineup, type LineupReady, type PlayerRow } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, kickoff, prob, slotLabel } from '../lib/format.ts';
import { RangeBar } from '../charts/charts.tsx';
import { Card, CardHeader, Empty, ErrorState, InfoTip, Injury, Meter, Notice, PageHeader, PageSkeleton, PlayerLink, Pos, Stat, cx } from '../components/ui.tsx';

type Row = (PlayerRow & { locked: boolean }) | null;

export default function LineupPage() {
  const { leagueId, myTeamId, teamName } = useApp();
  const q = useLineup(leagueId, myTeamId);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.data.week === null) return <Empty title="The season is over">No lineup decisions left this year.</Empty>;
  const l = q.data;
  const max = Math.max(20, ...l.optimal.map(r => r?.week?.ceiling ?? 0), ...l.bench.map(r => r?.week?.ceiling ?? 0));
  const changes = l.swaps.length;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Week ${l.week} · ${teamName(myTeamId)}`}
        title="Start / sit"
      />
      <Card>
        <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
          <Stat label="Your lineup as set" value={fmt(l.currentTotal)} sub={`± ${fmt(l.currentSd, 0)} pts (1 sd)`} />
          <Stat label="Optimal lineup" value={fmt(l.optimalTotal)} sub={changes ? `${changes} change${changes === 1 ? '' : 's'}` : 'You’re already optimal'} tone={l.gain > 0.5 ? 'good' : undefined} />
          <Stat label="Expected gain" value={`+${fmt(l.gain)}`} sub="points this week" tone={l.gain > 0.5 ? 'good' : undefined} />
          {l.odds ? (
            <Stat label={`Win odds vs ${teamName(l.odds.opponent)}`} value={<span>{prob(l.odds.asSet)} <span className="text-ink-3">→</span> {prob(l.odds.optimized)}</span>} sub="as set → optimized" />
          ) : <Stat label="Win odds" value="—" sub="No opponent this week" />}
        </div>
        {l.lockedSlots.length > 0 && <div className="mt-4 flex items-center gap-2 text-[13px] text-ink-2"><Lock size={14} aria-hidden /> {l.lockedSlots.length} slot{l.lockedSlots.length === 1 ? ' is' : 's are'} locked because those games have kicked off.</div>}
      </Card>

      <Warnings warnings={l.warnings} />

      {changes > 0 ? <Swaps l={l} /> : (
        <Card className="flex items-center gap-3"><Check className="text-good" aria-hidden /><div className="font-semibold">Lineup is optimal.</div></Card>
      )}

      <Card pad={false}>
        <div className="px-4 pt-4 sm:px-5"><CardHeader title="Lineup" /></div>
        <div className="overflow-x-auto scroll-thin">
          <table className="tbl text-[13px]">
            <thead>
              <tr><th className="w-12">Slot</th><th>Current</th><th className="r">Exp</th><th className="w-6" /><th>Recommended</th><th className="r">Exp</th><th className="hidden md:table-cell"><span className="inline-flex items-center gap-1">Range <InfoTip>Dot = expected. Bar = 10th–90th percentile outcome. Tick = median.</InfoTip></span></th><th className="hidden lg:table-cell">Game</th></tr>
            </thead>
            <tbody>
              {l.slots.map((slot, i) => {
                const cur = l.current[i], opt = l.optimal[i];
                const changed = (cur?.id ?? null) !== (opt?.id ?? null);
                return (
                  <tr key={i} className={cx('row-hover', changed && 'bg-[color-mix(in_oklab,var(--good)_7%,transparent)]')}>
                    <td className="font-semibold text-ink-3">{slotLabel(slot)}</td>
                    <td className={cx(changed && 'text-ink-3')}><PlayerCell r={cur} muted={changed} /></td>
                    <td className="num r text-ink-2">{cur?.week ? fmt(cur.week.exp) : '—'}</td>
                    <td className="text-ink-3">{changed ? <ArrowRight size={14} className="text-good-ink" aria-label="replace with" /> : ''}</td>
                    <td><PlayerCell r={opt} /></td>
                    <td className="num r font-semibold">{opt?.week ? fmt(opt.week.exp) : '—'}</td>
                    <td className="hidden md:table-cell">{opt?.week && !opt.week.bye && <RangeBar floor={opt.week.floor} median={opt.week.median} ceiling={opt.week.ceiling} expected={opt.week.exp} max={max} width={150} />}</td>
                    <td className="hidden whitespace-nowrap text-ink-2 lg:table-cell">{gameLabel(opt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card pad={false}>
        <div className="px-4 pt-4 sm:px-5"><CardHeader title="Bench" /></div>
        {l.bench.length === 0 ? <Empty title="No bench players" /> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="tbl text-[13px]">
              <thead><tr><th>Player</th><th className="r">Exp</th><th className="r">If plays</th><th className="r">Play %</th><th className="hidden md:table-cell">Range</th><th className="hidden sm:table-cell">Game</th><th className="r">Season avg</th></tr></thead>
              <tbody>
                {l.bench.map(r => r && (
                  <tr key={r.id} className="row-hover">
                    <td><PlayerCell r={r} /></td>
                    <td className="num r font-semibold">{r.week ? fmt(r.week.exp) : '—'}</td>
                    <td className="num r text-ink-2">{r.week ? fmt(r.week.mean) : '—'}</td>
                    <td className="num r text-ink-2">{r.week ? prob(r.week.play) : '—'}</td>
                    <td className="hidden md:table-cell">{r.week && !r.week.bye && <RangeBar floor={r.week.floor} median={r.week.median} ceiling={r.week.ceiling} expected={r.week.exp} max={max} width={150} />}</td>
                    <td className="hidden whitespace-nowrap text-ink-2 sm:table-cell">{gameLabel(r)}</td>
                    <td className="num r text-ink-2">{r.season ? fmt(r.season.ppg) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {l.reserve.length > 0 && (
        <Card>
          <CardHeader title="IR & taxi" />
          <div className="flex flex-wrap gap-2">
            {l.reserve.map(r => r && <span key={r.id} className="inline-flex items-center gap-2 rounded-[9px] border border-line px-2.5 py-1.5 text-[13px]"><Pos pos={r.pos} /><PlayerLink id={r.id} name={r.name} /><span className="text-[11px] text-ink-3">{r.slot}</span><Injury status={r.injury} /></span>)}
          </div>
        </Card>
      )}
    </div>
  );
}

function Warnings({ warnings }: { warnings: LineupReady['warnings'] }) {
  if (!warnings.length) return null;
  const q = warnings.filter(w => w.kind === 'questionable');
  const others = warnings.filter(w => w.kind !== 'questionable');
  return (
    <div className="space-y-2">
      {others.map((w, i) => <Notice key={i} tone={w.kind === 'no-projection' ? 'info' : 'warn'}>{w.message}</Notice>)}
      {q.length > 0 && (
        <Notice>
          Questionable/doubtful: <b className="text-ink">{q.map(w => w.message.replace(/ is (Questionable|Doubtful)$/, '')).join(', ')}</b>
        </Notice>
      )}
    </div>
  );
}

function gameLabel(r: Row) {
  if (!r?.week) return '—';
  if (r.week.bye) return 'BYE';
  if (r.week.live && r.week.live.status !== 'pre_game') return `${r.week.live.status === 'complete' ? 'Final' : 'Live'} · ${fmt(r.week.live.points)} pts`;
  return `${r.week.home ? 'vs' : '@'} ${r.week.opp} · ${kickoff(r.week.kickoff)}`;
}

function PlayerCell({ r, muted }: { r: Row; muted?: boolean }) {
  if (!r) return <span className="text-ink-3">Empty</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Pos pos={r.pos} />
      <PlayerLink id={r.id} name={r.name} className={cx('max-w-[170px]', muted && 'font-normal text-ink-3')} />
      <span className="text-[11px] text-ink-3">{r.team}</span>
      <Injury status={r.injury} />
      {r.locked && <Lock size={12} className="text-ink-3" aria-label="locked" />}
    </span>
  );
}

function Swaps({ l }: { l: LineupReady }) {
  const all = [...l.current, ...l.optimal, ...l.bench];
  const find = (id: string | null) => (id ? all.find(r => r?.id === id) ?? null : null);
  return (
    <Card>
      <CardHeader title="Recommended changes" />
      <div className="grid gap-3 md:grid-cols-2">
        {l.swaps.map(s => {
          const start = find(s.startId), sit = find(s.sitId);
          const close = s.confidence < 0.56;
          return (
            <div key={s.startId} className="rounded-[12px] border border-line p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">{slotLabel(s.slot)}</span>
                <span className="num text-[13px] font-semibold text-good-ink">+{fmt(s.gain)} pts</span>
              </div>
              <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-good-ink">Start</div>
                  {start && <PlayerCell r={start} />}
                  <div className="num mt-0.5 text-[12px] text-ink-3">{start?.week ? `${fmt(start.week.exp)} exp · ${gameLabel(start)}` : ''}</div>
                </div>
                <MoveRight size={16} className="text-ink-3" aria-hidden />
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Bench</div>
                  {sit ? <PlayerCell r={sit} muted /> : <span className="text-ink-3">Empty slot</span>}
                  <div className="num mt-0.5 text-[12px] text-ink-3">{sit?.week ? `${fmt(sit.week.exp)} exp · ${gameLabel(sit)}` : ''}</div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Meter value={s.confidence} color={close ? 'var(--warn)' : 'var(--good)'} label="Confidence" />
                <span className="num shrink-0 text-[12px] font-semibold">{prob(s.confidence)}</span>
              </div>
              {close && <div className="mt-1.5 flex items-center gap-1 text-[12px] text-ink-2"><CircleAlert size={12} aria-hidden /> Close call</div>}
            </div>
          );
        })}
      </div>
      {l.moves.length > 0 && (
        <div className="mt-3 space-y-1 text-[13px] text-ink-2">
          {l.moves.map(m => {
            const r = find(m.id);
            return <div key={m.id} className="flex items-center gap-2"><MoveRight size={14} aria-hidden /> Move <b className="text-ink">{r?.name ?? 'player'}</b> from {slotLabel(m.from)} to {slotLabel(m.to)}.</div>;
          })}
        </div>
      )}
    </Card>
  );
}
