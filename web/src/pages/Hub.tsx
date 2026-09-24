import { ArrowRight, Flame, Snowflake, Trophy, Zap } from 'lucide-react';
import { useLineup, useOverview, type Overview } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { ago, fmt, ordinal, prob, record, teamColor } from '../lib/format.ts';
import { navigate, pathFor } from '../lib/router.ts';
import { Sparkline, WinBar } from '../charts/charts.tsx';
import { Button, Card, CardHeader, Delta, Empty, ErrorState, InfoTip, PageHeader, PageSkeleton, PlayerLink, Pos, Stat, TeamAvatar, TeamLink, cx } from '../components/ui.tsx';

export default function Hub() {
  const { leagueId, boot, myTeamId } = useApp();
  const q = useOverview(leagueId);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  const week = boot.league.week;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`${boot.league.season} season · ${week ? `week ${week}` : 'complete'}`}
        title={boot.league.name}
        subtitle={`${boot.league.totalRosters} teams · ${boot.league.scoringRules} custom scoring rules · ${boot.league.idpSlots} IDP starters · every number uses your league’s settings`}
      />
      {myTeamId !== null && week !== null && <MyMatchup overview={o} />}
      <Standings rows={o.standings} />
      <div className="grid gap-5 lg:grid-cols-2">
        <ThisWeek games={o.matchups} />
        {o.awards.length > 0 && <Awards awards={o.awards} />}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {o.lastWeek && <LastWeek recap={o.lastWeek} />}
        <Transactions tx={o.transactions} />
      </div>
    </div>
  );
}

function MyMatchup({ overview }: { overview: Overview }) {
  const { leagueId, myTeamId, teamName } = useApp();
  const lineup = useLineup(leagueId, myTeamId);
  const me = overview.standings.find(s => s.rosterId === myTeamId);
  const game = overview.matchups.find(g => g.a.rosterId === myTeamId || g.b?.rosterId === myTeamId);
  if (!me) return null;
  const mine = game ? (game.a.rosterId === myTeamId ? game.a : game.b) : null;
  const opp = game ? (game.a.rosterId === myTeamId ? game.b : game.a) : null;
  const pMine = game?.winProbA === null || game?.winProbA === undefined ? null : game.a.rosterId === myTeamId ? game.winProbA : 1 - game.winProbA;
  const l = lineup.data && lineup.data.week !== null ? lineup.data : null;
  const optimizedP = l?.odds ? l.odds.optimized : null;
  return (
    <Card className="overflow-hidden" pad={false}>
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="p-5">
          <div className="eyebrow mb-3">Your matchup this week</div>
          {mine && opp ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <TeamAvatar rosterId={mine.rosterId} size={40} />
                  <div className="min-w-0"><div className="truncate font-semibold">{teamName(mine.rosterId)}</div><div className="num text-[13px] text-ink-3">proj {fmt(mine.projected)}</div></div>
                </div>
                <div className="text-[12px] font-semibold text-ink-3">VS</div>
                <div className="flex min-w-0 items-center gap-3 text-right">
                  <div className="min-w-0"><div className="truncate font-semibold">{teamName(opp.rosterId)}</div><div className="num text-[13px] text-ink-3">proj {fmt(opp.projected)}</div></div>
                  <TeamAvatar rosterId={opp.rosterId} size={40} />
                </div>
              </div>
              <div className="mt-4 flex items-end gap-4">
                <div>
                  <div className="text-[12px] text-ink-3">Win probability as set</div>
                  <div className="num text-[48px] font-semibold leading-none tracking-tight">{prob(pMine)}</div>
                </div>
                {l && l.gain > 0.5 && optimizedP !== null && (
                  <div className="pb-1 text-[13px] text-ink-2">
                    <div>Optimized lineup: <b className="num text-ink">{prob(optimizedP)}</b></div>
                    <div className="text-good-ink">+{fmt(l.gain)} expected pts from {l.swaps.length} change{l.swaps.length === 1 ? '' : 's'}</div>
                  </div>
                )}
              </div>
              <div className="mt-3"><WinBar a={mine.rosterId} b={opp.rosterId} pA={pMine} labels={false} height={10} /></div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => navigate(pathFor(leagueId, 'lineup'))}>Optimize lineup <ArrowRight size={15} /></Button>
                <Button onClick={() => navigate(pathFor(leagueId, 'matchups'))}>Matchup details</Button>
                <Button variant="ghost" onClick={() => navigate(pathFor(leagueId, 'waivers'))}>Waiver targets</Button>
              </div>
            </>
          ) : <Empty title="No matchup this week" />}
        </div>
        <div className="grid grid-cols-2 content-center gap-x-4 gap-y-6 border-t border-line bg-surface-2 p-5 lg:border-l lg:border-t-0">
          <Stat label="Record" value={record(me.wins, me.losses, me.ties)} sub={`${ordinal(overview.standings.findIndex(s => s.rosterId === myTeamId) + 1)} in standings`} />
          <Stat label="Playoff odds" value={prob(me.playoffPct)} sub={`Title odds ${prob(me.champPct)}`} />
          <Stat label="Power rank" value={`#${me.powerRank}`} sub={`Score ${fmt(me.power, 0)} / 100`} />
          <Stat label="All-play" value={record(me.allPlayWins, me.allPlayLosses)} sub={<span>Luck <Delta value={me.luck} digits={2} /> wins</span>} />
        </div>
      </div>
    </Card>
  );
}

function Standings({ rows }: { rows: Overview['standings'] }) {
  const { myTeamId, boot } = useApp();
  const cut = boot.league.playoffTeams;
  return (
    <Card pad={false}>
      <div className="px-4 pt-4 sm:px-5"><CardHeader title="Standings" subtitle={`Top ${cut} make the playoffs · odds from 20,000 simulated seasons`} /></div>
      <div className="overflow-x-auto scroll-thin">
        <table className="tbl num text-[13px]">
          <thead>
            <tr>
              <th className="w-8">#</th><th>Team</th><th className="r">W–L</th><th className="r">PF</th><th className="r">PA</th>
              <th className="r"><span className="inline-flex items-center gap-1">All-play <InfoTip>Record if you played every team every week.</InfoTip></span></th>
              <th className="r"><span className="inline-flex items-center gap-1">Luck <InfoTip>Actual wins minus all-play expected wins. Positive = lucky schedule.</InfoTip></span></th>
              <th>Weekly</th><th className="r">Power</th><th className="r">Playoffs</th><th className="r">Title</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.rosterId} className={cx('row-hover', r.rosterId === myTeamId && 'bg-accent-soft')}>
                <td className="text-ink-3">{i + 1}{i === cut - 1 && <span className="sr-only"> (playoff line)</span>}</td>
                <td className={cx('max-w-[220px]', i === cut - 1 && 'border-b-2 border-b-[var(--line-strong)]')}><TeamLink rosterId={r.rosterId} showAvatar /><div className="pl-[30px] text-[11px] text-ink-3">{r.owner}{r.streak ? ` · ${r.streak}` : ''}</div></td>
                <td className="r font-semibold">{record(r.wins, r.losses, r.ties)}</td>
                <td className="r">{fmt(r.pointsFor)}</td>
                <td className="r text-ink-2">{fmt(r.pointsAgainst)}</td>
                <td className="r text-ink-2">{record(r.allPlayWins, r.allPlayLosses)}</td>
                <td className="r"><Delta value={r.luck} digits={2} /></td>
                <td><Sparkline points={r.weekly.map((v, k) => [k + 1, v] as [number, number])} width={80} height={22} color={teamColor(r.rosterId)} /></td>
                <td className="r font-medium">{fmt(r.power, 0)}</td>
                <td className="r font-semibold">{prob(r.playoffPct)}</td>
                <td className="r text-ink-2">{prob(r.champPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ThisWeek({ games }: { games: Overview['matchups'] }) {
  const { leagueId, teamName, boot } = useApp();
  if (!games.length) return null;
  return (
    <Card>
      <CardHeader title={`Week ${boot.league.week} matchups`} subtitle="Win odds simulate every starter’s outcome distribution" right={<Button size="sm" variant="ghost" onClick={() => navigate(pathFor(leagueId, 'matchups'))}>All <ArrowRight size={14} /></Button>} />
      <div className="space-y-4">
        {games.map(g => g.b && (
          <button key={g.matchupId ?? g.a.rosterId} onClick={() => navigate(pathFor(leagueId, 'matchups'))} className="block w-full rounded-[10px] text-left hover:bg-surface-2">
            <div className="mb-1.5 flex items-center justify-between gap-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-2"><TeamAvatar rosterId={g.a.rosterId} size={20} /><span className="truncate font-medium">{teamName(g.a.rosterId)}</span></span>
              <span className="flex min-w-0 items-center gap-2"><span className="truncate font-medium">{teamName(g.b.rosterId)}</span><TeamAvatar rosterId={g.b.rosterId} size={20} /></span>
            </div>
            <WinBar a={g.a.rosterId} b={g.b.rosterId} pA={g.winProbA} />
            <div className="num flex justify-between text-[11px] text-ink-3"><span>{g.a.points > 0 ? `${fmt(g.a.points)} live · ` : ''}proj {fmt(g.a.projected)}</span><span>proj {fmt(g.b.projected)}{g.b.points > 0 ? ` · ${fmt(g.b.points)} live` : ''}</span></div>
          </button>
        ))}
      </div>
    </Card>
  );
}

function Awards({ awards }: { awards: Overview['awards'] }) {
  const icon = (key: string) => (key === 'high' || key === 'pf' ? <Flame size={15} /> : key === 'low' ? <Snowflake size={15} /> : key === 'efficiency' ? <Zap size={15} /> : <Trophy size={15} />);
  return (
    <Card>
      <CardHeader title="Season awards" subtitle="So far this season" />
      <div className="grid grid-cols-2 gap-2">
        {awards.map(a => (
          <div key={a.key} className="rounded-[10px] border border-line p-2.5">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2"><span className="text-ink-3">{icon(a.key)}</span>{a.title}</div>
            <div className="num mt-1 text-[17px] font-semibold">{a.value}</div>
            <div className="mt-0.5 truncate text-[12px]"><TeamLink rosterId={a.rosterId} /></div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function LastWeek({ recap }: { recap: NonNullable<Overview['lastWeek']> }) {
  const { teamName } = useApp();
  return (
    <Card>
      <CardHeader title={`Week ${recap.week} in review`} />
      <div className="space-y-2">
        {recap.results.map(r => (
          <div key={`${r.winner}-${r.loser}`} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2"><TeamAvatar rosterId={r.winner} size={20} /><span className="truncate font-semibold">{teamName(r.winner)}</span></span>
            <span className="num shrink-0 font-semibold">{fmt(r.winnerPts)} <span className="text-ink-3">–</span> {fmt(r.loserPts)}</span>
            <span className="flex min-w-0 items-center justify-end gap-2 text-ink-2"><span className="truncate">{teamName(r.loser ?? 0)}</span><TeamAvatar rosterId={r.loser ?? 0} size={20} /></span>
          </div>
        ))}
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <div className="eyebrow mb-1.5">Top performers</div>
          {recap.topPerformers.slice(0, 5).map(p => (
            <div key={p.id} className="flex items-center justify-between gap-2 py-1 text-[13px]">
              <span className="flex min-w-0 items-center gap-2"><Pos pos={p.pos} /><PlayerLink id={p.id} name={p.name} /></span>
              <span className="num font-semibold">{fmt(p.pts)}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="eyebrow mb-1.5">Left on the bench</div>
          {recap.efficiency.slice(0, 5).map(e => (
            <div key={e.rosterId} className="flex items-center justify-between gap-2 py-1 text-[13px]">
              <TeamLink rosterId={e.rosterId} />
              <span className="num text-ink-2">{fmt(e.left)} <span className="text-ink-3">of {fmt(e.optimal, 0)}</span></span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function Transactions({ tx }: { tx: Overview['transactions'] }) {
  const { leagueId } = useApp();
  return (
    <Card>
      <CardHeader title="Recent moves" right={<Button size="sm" variant="ghost" onClick={() => navigate(pathFor(leagueId, 'transactions'))}>All <ArrowRight size={14} /></Button>} />
      {tx.length === 0 ? <Empty title="No transactions yet" /> : (
        <div className="divide-y divide-[var(--line)]">
          {tx.map(t => (
            <div key={t.id} className="py-2 text-[13px]">
              <div className="flex items-center justify-between gap-2 text-[12px] text-ink-3">
                <span className="capitalize">{t.type.replace('_', ' ')}{t.faab !== null ? ` · $${t.faab}` : ''}</span><span>{ago(t.created)}</span>
              </div>
              {t.adds.map(a => <div key={`a${a.id}`} className="mt-0.5 flex items-center gap-2"><span className="w-3 font-bold text-good-ink">+</span><Pos pos={a.pos} /><PlayerLink id={a.id} name={a.name} /><span className="text-ink-3">→</span><TeamLink rosterId={a.rosterId} /></div>)}
              {t.drops.map(d => <div key={`d${d.id}`} className="mt-0.5 flex items-center gap-2 text-ink-2"><span className="w-3 font-bold text-bad-ink">−</span><Pos pos={d.pos} /><PlayerLink id={d.id} name={d.name} className="font-normal text-ink-2" /><span className="text-ink-3">from</span><TeamLink rosterId={d.rosterId} /></div>)}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
