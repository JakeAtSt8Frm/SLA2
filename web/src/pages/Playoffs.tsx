import { usePlayoffs } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, ordinal, prob, record, teamColor } from '../lib/format.ts';
import { HeatCell, WinBar } from '../charts/charts.tsx';
import { Card, CardHeader, ErrorState, InfoTip, PageHeader, PageSkeleton, TeamAvatar, TeamLink, cx } from '../components/ui.tsx';

export default function PlayoffsPage() {
  const { leagueId, myTeamId, teamName } = useApp();
  const q = usePlayoffs(leagueId);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const seeds = p.teams[0]?.seedDist.length ?? 0;
  const weeks = [...new Set(p.games.map(g => g.week))];
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`${p.sims.toLocaleString('en-US')} simulated seasons`}
        title="Playoff odds"
        subtitle={`Every remaining game is simulated from each team’s best projected lineup that week (byes and injuries included). Top ${p.playoffTeams} make the playoffs; ties are broken by points for. The bracket starts in week ${p.playoffWeekStart}.`}
      />
      <Card pad={false}>
        <div className="px-4 pt-4 sm:px-5"><CardHeader title="Odds" subtitle="Leverage shows how much this week’s result swings each team’s playoff odds" /></div>
        <div className="overflow-x-auto scroll-thin">
          <table className="tbl num text-[13px]">
            <thead>
              <tr>
                <th>Team</th><th className="r">Now</th><th className="r">Proj. record</th><th className="r">Playoffs</th>
                <th className="r"><span className="inline-flex items-center gap-1">This week <InfoTip>Playoff odds if the team wins vs loses its current-week game.</InfoTip></span></th>
                <th className="r">#1 seed</th><th className="r">Final</th><th className="r">Title</th><th className="r">Last</th>
              </tr>
            </thead>
            <tbody>
              {p.teams.map(t => (
                <tr key={t.rosterId} className={cx('row-hover', t.rosterId === myTeamId && 'bg-accent-soft')}>
                  <td><TeamLink rosterId={t.rosterId} showAvatar /></td>
                  <td className="r text-ink-2">{record(t.wins, t.losses, t.ties)}</td>
                  <td className="r">{fmt(t.meanWins)}–{fmt(t.meanLosses)}</td>
                  <td className="r text-[15px] font-semibold">{prob(t.playoffPct)}</td>
                  <td className="r whitespace-nowrap text-[12px]">{t.ifWinPlayoffPct !== null && t.ifLosePlayoffPct !== null ? <span><span className="text-good-ink">W {prob(t.ifWinPlayoffPct)}</span> <span className="text-ink-3">/</span> <span className="text-bad-ink">L {prob(t.ifLosePlayoffPct)}</span></span> : '—'}</td>
                  <td className="r">{prob(t.firstSeedPct)}</td>
                  <td className="r">{prob(t.finalPct)}</td>
                  <td className="r font-semibold">{prob(t.champPct)}</td>
                  <td className="r text-ink-2">{prob(t.lastPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Final standing distribution" subtitle="Share of simulations finishing in each place (darker = more likely)" />
        <div className="overflow-x-auto scroll-thin">
          <div className="grid min-w-[520px] gap-1" style={{ gridTemplateColumns: `minmax(160px,1.3fr) repeat(${seeds}, minmax(52px,1fr))` }}>
            <div />
            {Array.from({ length: seeds }, (_, i) => <div key={i} className={cx('pb-1 text-center text-[11px] font-semibold', i < p.playoffTeams ? 'text-ink-2' : 'text-ink-3')}>{ordinal(i + 1)}</div>)}
            {p.teams.map(t => (
              <div key={t.rosterId} className="contents">
                <div className="flex items-center"><TeamLink rosterId={t.rosterId} /></div>
                {t.seedDist.map((v, i) => <HeatCell key={i} value={v} />)}
              </div>
            ))}
          </div>
        </div>
        <p className="mt-2 text-[12px] text-ink-3">Places 1–{p.playoffTeams} make the playoffs.</p>
      </Card>

      <Card>
        <CardHeader title="Remaining schedule" subtitle="Projected win probability for every regular-season game left" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {weeks.map(w => (
            <div key={w} className="rounded-[12px] border border-line p-3">
              <div className="eyebrow mb-2">Week {w}</div>
              <div className="space-y-3">
                {p.games.filter(g => g.week === w).map(g => (
                  <div key={`${g.a}-${g.b}`} className={cx(g.a === myTeamId || g.b === myTeamId ? 'rounded-[8px] bg-accent-soft p-1.5' : 'p-1.5')}>
                    <div className="mb-1 flex justify-between gap-2 text-[12px]">
                      <span className="flex min-w-0 items-center gap-1.5"><TeamAvatar rosterId={g.a} size={16} /><span className="truncate">{teamName(g.a)}</span></span>
                      <span className="flex min-w-0 items-center gap-1.5"><span className="truncate">{teamName(g.b)}</span><TeamAvatar rosterId={g.b} size={16} /></span>
                    </div>
                    <WinBar a={g.a} b={g.b} pA={g.winProbA} height={6} />
                    <div className="num flex justify-between text-[11px] text-ink-3"><span>{fmt(g.projA)}</span><span>{fmt(g.projB)}</span></div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Projected points for" subtitle="Current points plus simulated rest of regular season" />
        <div className="space-y-2">
          {[...p.teams].sort((a, b) => b.meanPointsFor - a.meanPointsFor).map(t => {
            const max = Math.max(...p.teams.map(x => x.meanPointsFor));
            return (
              <div key={t.rosterId} className="grid grid-cols-[minmax(120px,30%)_1fr_70px_60px] items-center gap-2 text-[13px]">
                <TeamLink rosterId={t.rosterId} />
                <div className="h-3"><div className="h-full rounded-r-[4px]" style={{ width: `${(t.meanPointsFor / max) * 100}%`, background: teamColor(t.rosterId) }} /></div>
                <div className="num text-right font-medium">{fmt(t.meanPointsFor, 0)}</div>
                <div className="num text-right text-[12px] text-ink-3">now {fmt(t.pointsFor, 0)}</div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
