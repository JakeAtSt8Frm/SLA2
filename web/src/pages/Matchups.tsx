import { useApp } from '../lib/context.tsx';
import { useMatchups, type Game } from '../lib/api.ts';
import { fmt, prob, slotLabel } from '../lib/format.ts';
import { useSearchParam } from '../lib/router.ts';
import { ScoreDistribution, WinBar } from '../charts/charts.tsx';
import { Card, Empty, ErrorState, Injury, PageHeader, PageSkeleton, PlayerLink, Pos, Select, TeamAvatar, TeamLink, cx } from '../components/ui.tsx';

export default function MatchupsPage() {
  const { leagueId, boot, myTeamId } = useApp();
  const [weekParam, setWeek] = useSearchParam('week');
  const week = weekParam ? Number(weekParam) : undefined;
  const q = useMatchups(leagueId, week);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const m = q.data;
  const games = [...m.games].sort((x, y) => Number(y.a.rosterId === myTeamId || y.b?.rosterId === myTeamId) - Number(x.a.rosterId === myTeamId || x.b?.rosterId === myTeamId));
  return (
    <div className={cx('space-y-5', q.isFetching && 'opacity-80 transition-opacity')}>
      <PageHeader
        eyebrow={m.final ? 'Final results' : m.current ? 'This week · live odds' : 'Upcoming'}
        title={`Week ${m.week} matchups`}
        subtitle={m.final ? 'Final scores with each team’s lineup and bench.' : 'Win odds simulate every starter’s full outcome distribution (including injury risk) 10,000 times.'}
        right={<Select label="Week" value={m.week} onChange={v => setWeek(v === boot.league.week ? null : String(v), true)} options={m.weeks.map(w => ({ value: w, label: `Week ${w}${w === boot.league.week ? ' (current)' : ''}` }))} className="w-44" />}
      />
      {games.length === 0 && <Card><Empty title="No matchups scheduled this week" /></Card>}
      {games.map(g => <GameCard key={g.matchupId ?? g.a.rosterId} g={g} />)}
    </div>
  );
}

function GameCard({ g }: { g: Game }) {
  const { teamName, myTeamId } = useApp();
  if (!g.b) return null;
  const b = g.b;
  const aWon = g.final && g.a.points > b.points, bWon = g.final && b.points > g.a.points;
  const live = !g.final && (g.a.points > 0 || b.points > 0);
  const mine = g.a.rosterId === myTeamId || b.rosterId === myTeamId;
  return (
    <Card className={cx(mine && 'ring-1 ring-[var(--accent)]')}>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <Side rosterId={g.a.rosterId} name={teamName(g.a.rosterId)} score={g.final || live ? g.a.points : g.a.projected} won={aWon} sub={g.final ? 'final' : live ? `live · proj ${fmt(g.a.projected)}` : `projected${g.a.optimal !== null && g.a.projected !== null && g.a.optimal - g.a.projected > 0.5 ? ` · ${fmt(g.a.optimal)} optimized` : ''}`} />
        <div className="text-center text-[12px] font-semibold text-ink-3">{g.final ? 'FINAL' : live ? <span className="inline-flex items-center gap-1.5"><span className="live-dot" />LIVE</span> : 'VS'}</div>
        <Side rosterId={b.rosterId} name={teamName(b.rosterId)} score={g.final || live ? b.points : b.projected} won={bWon} sub={g.final ? 'final' : live ? `live · proj ${fmt(b.projected)}` : `projected${b.optimal !== null && b.projected !== null && b.optimal - b.projected > 0.5 ? ` · ${fmt(b.optimal)} optimized` : ''}`} right />
      </div>
      {!g.final && g.winProbA !== null && (
        <div className="mt-4">
          <WinBar a={g.a.rosterId} b={b.rosterId} pA={g.winProbA} height={10} />
          {g.optimizedWinProbA !== null && Math.abs(g.optimizedWinProbA - g.winProbA) > 0.03 && (
            <div className="mt-1 text-center text-[12px] text-ink-3">If both managers set optimal lineups: {prob(g.optimizedWinProbA)} – {prob(1 - g.optimizedWinProbA)}</div>
          )}
        </div>
      )}
      {g.range && (
        <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
          <ScoreDistribution hist={g.range.histogram} a={g.a.rosterId} b={b.rosterId} nameA={teamName(g.a.rosterId)} nameB={teamName(b.rosterId)} />
          <div className="num grid grid-cols-3 content-start gap-x-2 gap-y-1 text-[12px]">
            <span className="text-ink-3" /><span className="text-right text-ink-3">{teamName(g.a.rosterId).slice(0, 10)}</span><span className="text-right text-ink-3">{teamName(b.rosterId).slice(0, 10)}</span>
            {[['Bad day (10%)', 0], ['Median', 1], ['Good day (90%)', 2]].map(([label, i]) => (
              <div key={label as string} className="contents"><span className="text-ink-2">{label}</span><span className="text-right font-semibold">{fmt(g.range!.a[i as number])}</span><span className="text-right font-semibold">{fmt(g.range!.b[i as number])}</span></div>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 overflow-x-auto scroll-thin">
        <table className="tbl text-[13px]">
          <thead><tr><th className="r">{g.final || live ? 'Pts' : 'Proj'}</th><th className="r">{teamName(g.a.rosterId)}</th><th className="w-12 text-center">Slot</th><th>{teamName(b.rosterId)}</th><th>{g.final || live ? 'Pts' : 'Proj'}</th></tr></thead>
          <tbody>
            {g.a.lineup.map((pa, i) => {
              const pb = b.lineup[i];
              const va = g.final || live ? pa.points : pa.forecast?.exp ?? null;
              const vb = g.final || live ? pb?.points ?? null : pb?.forecast?.exp ?? null;
              return (
                <tr key={i} className="row-hover">
                  <td className={cx('num r w-14', va !== null && vb !== null && va > vb ? 'font-semibold text-ink' : 'text-ink-2')}>{fmt(va)}</td>
                  <td className="r"><PlayerSlot p={pa} align="right" /></td>
                  <td className="text-center text-[11px] font-semibold text-ink-3">{slotLabel(pa.slot)}</td>
                  <td>{pb && <PlayerSlot p={pb} />}</td>
                  <td className={cx('num w-14', va !== null && vb !== null && vb > va ? 'font-semibold text-ink' : 'text-ink-2')}>{fmt(vb)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {g.final && (g.a.bench.length > 0 || b.bench.length > 0) && (
        <div className="mt-3 grid gap-3 text-[12px] text-ink-2 sm:grid-cols-2">
          {[g.a, b].map(side => (
            <div key={side.rosterId}><span className="font-semibold text-ink-3">Bench · <TeamLink rosterId={side.rosterId} /></span>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{side.bench.slice(0, 6).map(p => <span key={p.id}><PlayerLink id={p.id} name={p.name} className="font-normal text-ink-2" /> <span className="num">{fmt(p.points)}</span></span>)}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Side({ rosterId, name, score, won, sub, right }: { rosterId: number; name: string; score: number | null; won: boolean; sub: string; right?: boolean }) {
  return (
    <div className={cx('flex min-w-0 items-center gap-3', right && 'flex-row-reverse text-right')}>
      <TeamAvatar rosterId={rosterId} size={40} />
      <div className="min-w-0">
        <div className="truncate font-semibold">{name}</div>
        <div className={cx('num text-[26px] font-semibold leading-tight tracking-tight', won ? 'text-ink' : 'text-ink')}>{fmt(score)}{won && <span className="ml-1.5 align-middle text-[11px] font-bold text-good-ink">W</span>}</div>
        <div className="truncate text-[12px] text-ink-3">{sub}</div>
      </div>
    </div>
  );
}

function PlayerSlot({ p, align }: { p: Game['a']['lineup'][number]; align?: 'right' }) {
  if (!p.id || !p.name) return <span className="text-ink-3">Empty</span>;
  const f = p.forecast;
  return (
    <span className={cx('inline-flex min-w-0 max-w-full items-center gap-2', align === 'right' && 'flex-row-reverse')}>
      <Pos pos={p.pos ?? ''} />
      <PlayerLink id={p.id} name={p.name} className="max-w-[160px]" />
      {f?.live && f.live.status === 'in_game' && <span className="live-dot" aria-label="playing now" />}
      {f?.bye && <span className="text-[11px] font-semibold text-bad-ink">BYE</span>}
      {f && f.play < 0.95 && !f.live?.points && <Injury status={f.play === 0 ? 'Out' : f.play < 0.3 ? 'Doubtful' : 'Questionable'} />}
    </span>
  );
}
