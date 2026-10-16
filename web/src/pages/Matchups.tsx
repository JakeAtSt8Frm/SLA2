import { useApp } from '../lib/context.tsx';
import { useMatchups, type Game, type Matchups } from '../lib/api.ts';
import { ago, fmt, posLabel, prob, slotLabel } from '../lib/format.ts';
import { useLiveGames } from '../lib/live.ts';
import { useSearchParam } from '../lib/router.ts';
import { ScoreDistribution, WinBar } from '../charts/charts.tsx';
import { Card, Empty, ErrorState, Injury, PageHeader, PageSkeleton, PlayerLink, Select, TeamAvatar, TeamLink, cx } from '../components/ui.tsx';

export default function MatchupsPage() {
  const { leagueId } = useApp();
  const [weekParam, setWeek] = useSearchParam('week');
  const week = weekParam ? Number(weekParam) : undefined;
  const q = useMatchups(leagueId, week);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <MatchupsView m={q.data} fetching={q.isFetching} onWeek={setWeek} />;
}

function MatchupsView({ m, fetching, onWeek }: { m: Matchups; fetching: boolean; onWeek: (v: string | null, replace?: boolean) => void }) {
  const { boot, myTeamId } = useApp();
  const live = useLiveGames(m.games, m.current ? m.week : null);
  const games = [...live.games].sort((x, y) => Number(y.a.rosterId === myTeamId || y.b?.rosterId === myTeamId) - Number(x.a.rosterId === myTeamId || x.b?.rosterId === myTeamId));
  return (
    <div className={cx('space-y-5', fetching && 'opacity-80 transition-opacity')}>
      <PageHeader
        eyebrow={m.final ? 'Final results' : m.current ? (live.at ? `This week · live scores ${ago(live.at)}` : 'This week · live odds') : 'Upcoming'}
        title={`Week ${m.week} matchups`}
        right={<Select label="Week" value={m.week} onChange={v => onWeek(v === boot.league.week ? null : String(v), true)} options={m.weeks.map(w => ({ value: w, label: `Week ${w}${w === boot.league.week ? ' (current)' : ''}` }))} className="w-44" />}
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
  const scored = g.final || live;
  const sub = (s: Game['a']): string[] => {
    if (g.final) return s.pregame !== null ? [`proj ${fmt(s.pregame)}`] : ['final'];
    if (live) return [`proj ${fmt(s.projected)}`, ...(s.pregame !== null ? [`pregame ${fmt(s.pregame)}`] : [])];
    return [`projected${s.optimal !== null && s.projected !== null && s.optimal - s.projected > 0.5 ? ` · ${fmt(s.optimal)} best` : ''}`];
  };
  return (
    <Card className={cx(mine && 'ring-1 ring-[var(--accent)]')}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-3">
        <Side rosterId={g.a.rosterId} name={teamName(g.a.rosterId)} score={scored ? g.a.points : g.a.projected} won={aWon} sub={sub(g.a)} />
        <div className="text-center text-[11px] font-semibold text-ink-3 sm:text-[12px]">{g.final ? 'FINAL' : live ? <span className="inline-flex items-center gap-1.5"><span className="live-dot" />LIVE</span> : 'VS'}</div>
        <Side rosterId={b.rosterId} name={teamName(b.rosterId)} score={scored ? b.points : b.projected} won={bWon} sub={sub(b)} right />
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
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
          <ScoreDistribution hist={g.range.histogram} a={g.a.rosterId} b={b.rosterId} nameA={teamName(g.a.rosterId)} nameB={teamName(b.rosterId)} />
          <div className="num grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] content-start gap-x-3 gap-y-1 text-[12px]">
            <span /><span className="truncate text-right text-ink-3">{teamName(g.a.rosterId)}</span><span className="truncate text-right text-ink-3">{teamName(b.rosterId)}</span>
            {([['Bad day (10%)', 0], ['Median', 1], ['Good day (90%)', 2]] as const).map(([label, i]) => (
              <div key={label} className="contents"><span className="text-ink-2">{label}</span><span className="text-right font-semibold">{fmt(g.range!.a[i])}</span><span className="text-right font-semibold">{fmt(g.range!.b[i])}</span></div>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4" role="table" aria-label={`${teamName(g.a.rosterId)} vs ${teamName(b.rosterId)} lineups`}>
        <div role="row" className="grid grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,1fr)] gap-2 border-b border-line pb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">
          <span role="columnheader" className="flex items-end justify-between gap-2"><span className="truncate">{teamName(g.a.rosterId)}</span><PtsHeader scored={scored} /></span>
          <span role="columnheader" className="self-end text-center">Slot</span>
          <span role="columnheader" className="flex items-end justify-between gap-2"><PtsHeader scored={scored} right /><span className="truncate text-right">{teamName(b.rosterId)}</span></span>
        </div>
        {g.a.lineup.map((pa, i) => {
          const pb = b.lineup[i];
          const va = scored ? pa.points : pa.forecast?.exp ?? null;
          const vb = scored ? pb?.points ?? null : pb?.forecast?.exp ?? null;
          return (
            <div key={i} role="row" className="grid grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,1fr)] items-center gap-2 border-b border-line py-2 last:border-b-0">
              <LineupCell p={pa} value={va} better={va !== null && vb !== null && va > vb} scored={scored} />
              <span role="cell" className="text-center text-[11px] font-semibold text-ink-3">{slotLabel(pa.slot)}</span>
              {pb ? <LineupCell p={pb} value={vb} better={va !== null && vb !== null && vb > va} scored={scored} right /> : <span role="cell" />}
            </div>
          );
        })}
      </div>
      {g.final && (g.a.bench.length > 0 || b.bench.length > 0) && (
        <div className="mt-3 grid grid-cols-1 gap-3 text-[12px] text-ink-2 sm:grid-cols-2">
          {[g.a, b].map(side => (
            <div key={side.rosterId} className="min-w-0"><span className="font-semibold text-ink-3">Bench · <TeamLink rosterId={side.rosterId} /></span>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{side.bench.slice(0, 6).map(p => <span key={p.id}><PlayerLink id={p.id} name={p.name} className="font-normal text-ink-2" /> <span className="num">{fmt(p.points)}</span></span>)}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function PtsHeader({ scored, right }: { scored: boolean; right?: boolean }) {
  if (!scored) return <span>Proj</span>;
  return <span className={cx('shrink-0 leading-tight', right ? 'text-left' : 'text-right')}>Pts<span className="block text-[10px] font-medium normal-case tracking-normal">proj</span></span>;
}

function Side({ rosterId, name, score, won, sub, right }: { rosterId: number; name: string; score: number | null; won: boolean; sub: string[]; right?: boolean }) {
  return (
    <div className={cx('flex min-w-0 items-center gap-2.5 sm:gap-3', right && 'flex-row-reverse text-right')}>
      <span className="hidden min-[380px]:inline-flex"><TeamAvatar rosterId={rosterId} size={36} /></span>
      <div className="min-w-0">
        <div className="truncate text-[14px] font-semibold">{name}</div>
        <div className="num text-[24px] font-semibold leading-tight tracking-tight sm:text-[26px]">{fmt(score)}{won && <span className="ml-1.5 align-middle text-[11px] font-bold text-good-ink">W</span>}</div>
        {sub.map(line => <div key={line} className="num truncate text-[12px] leading-snug text-ink-3">{line}</div>)}
      </div>
    </div>
  );
}

/** One side of a lineup row: name and position on the outside, points and pre-game projection toward the slot. */
function LineupCell({ p, value, better, scored, right }: { p: Game['a']['lineup'][number]; value: number | null; better: boolean; scored: boolean; right?: boolean }) {
  const { boot } = useApp();
  const f = p.forecast;
  const points = (
    <span className={cx('num shrink-0', right ? 'text-left' : 'text-right')}>
      <span className={cx('block text-[14px] leading-tight', better ? 'font-semibold text-ink' : 'text-ink-2')}>{fmt(value)}</span>
      {scored && p.pregame !== null && <span className="block text-[11px] leading-tight text-ink-3">{fmt(p.pregame)}</span>}
    </span>
  );
  if (!p.id || !p.name) return <span role="cell" className={cx('text-[13px] text-ink-3', right && 'text-right')}>Empty</span>;
  return (
    <span role="cell" className={cx('flex min-w-0 items-center justify-between gap-2', right && 'flex-row-reverse')}>
      <span className={cx('min-w-0', right && 'text-right')}>
        <span className={cx('flex min-w-0 items-center gap-1.5', right && 'flex-row-reverse')}>
          <PlayerLink id={p.id} name={p.name} className={cx('min-w-0 text-[13px]', right && 'text-right')} />
          {f?.live && f.live.status === 'in_game' && <span className="live-dot shrink-0" aria-label="playing now" />}
          {f && !f.bye && f.play < 0.95 && !f.live?.points && <Injury status={f.play === 0 ? 'Out' : f.play < 0.3 ? 'Doubtful' : 'Questionable'} />}
        </span>
        <span className="block truncate text-[11px] leading-tight text-ink-3">{posLabel(p.pos ?? '', boot.league.platform)}{p.team ? ` · ${p.team}` : ''}{f?.bye ? ' · BYE' : ''}</span>
      </span>
      {points}
    </span>
  );
}
