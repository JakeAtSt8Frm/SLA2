import { useMemo } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTeam, type TeamPage } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { ago, fmt, ordinal, POSITIONS, prob, record, teamColor } from '../lib/format.ts';
import { navigate, pathFor, useRoute } from '../lib/router.ts';
import { WeekColumns, WinBar } from '../charts/charts.tsx';
import { Button, Card, CardHeader, Delta, Empty, ErrorState, Injury, PageHeader, PageSkeleton, PlayerLink, Pos, Select, Stat, TeamAvatar, TeamLink, cx } from '../components/ui.tsx';

export default function TeamRoute() {
  const route = useRoute();
  const { leagueId, myTeamId, boot } = useApp();
  const rid = route.param ? Number(route.param) : myTeamId ?? boot.teams[0]?.rosterId ?? null;
  const q = useTeam(leagueId, rid);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <TeamView t={q.data} />;
}

function TeamView({ t }: { t: TeamPage }) {
  const { leagueId, boot, myTeamId, teamName } = useApp();
  const team = t.team;
  const byPos = useMemo(() => POSITIONS.map(pos => ({ pos, players: t.roster.filter(r => r.pos === pos).sort((a, b) => (b.value?.rosAvg ?? 0) - (a.value?.rosAvg ?? 0)) })).filter(g => g.players.length), [t.roster]);
  const leagueAvg = t.history.length ? t.history.reduce((a, h) => a + h.points, 0) / t.history.length : undefined;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={team.rosterId === myTeamId ? 'Your team' : 'Team'}
        title={<span className="flex items-center gap-3"><TeamAvatar rosterId={team.rosterId} size={40} /><span className="min-w-0 truncate">{team.name}</span></span>}
        subtitle={`${team.owner} · ${record(team.wins, team.losses, team.ties)} · ${fmt(team.pointsFor)} PF · $${team.faabRemaining} FAAB left`}
        right={<Select label="Team" value={team.rosterId} onChange={v => navigate(pathFor(leagueId, 'team', v))} options={boot.teams.map(x => ({ value: x.rosterId, label: x.name }))} className="w-56" />}
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Season outlook" />
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Stat label="Playoffs" value={prob(t.outlook.playoffPct)} />
            <Stat label="Title" value={prob(t.outlook.champPct)} />
            <Stat label="Proj. record" value={`${fmt(t.outlook.meanWins)}–${fmt(t.outlook.meanLosses)}`} />
            <Stat label="Lineup efficiency" value={t.summary.efficiency ? `${fmt(t.summary.efficiency * 100, 0)}%` : '—'} sub={`${fmt(t.summary.benchPoints)} pts on bench`} />
          </div>
          <div className="mt-4">
            <div className="eyebrow mb-1.5">Finish distribution</div>
            <div className="flex gap-1">
              {t.outlook.seedDist.map((v, i) => (
                <div key={i} className="flex-1 text-center">
                  <div className="flex h-16 items-end"><div className="w-full rounded-t-[4px]" style={{ height: `${Math.max(3, (v / Math.max(...t.outlook.seedDist, 0.01)) * 100)}%`, background: i < boot.league.playoffTeams ? teamColor(team.rosterId) : 'var(--axis)' }} title={`${ordinal(i + 1)}: ${prob(v)}`} /></div>
                  <div className="num mt-1 text-[11px] text-ink-3">{ordinal(i + 1)}</div>
                  <div className="num text-[11px] font-medium">{prob(v)}</div>
                </div>
              ))}
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Weekly scoring" subtitle={leagueAvg ? `Line = team average (${fmt(leagueAvg)})` : undefined} />
          {t.history.length ? <WeekColumns weeks={t.history.map(h => ({ week: h.week, value: h.points, result: h.result, label: h.opponent ? `vs ${teamName(h.opponent)} (${fmt(h.opponentPoints)}) · optimal ${fmt(h.optimal)}` : undefined }))} color={teamColor(team.rosterId)} reference={leagueAvg} marks /> : <Empty title="No completed weeks yet" />}
        </Card>
      </div>

      {t.strength.length > 0 && (
        <Card>
          <CardHeader title="Positional strength this week" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            {t.strength.map(s => (
              <div key={s.group} className="rounded-[10px] border border-line p-2.5">
                <div className="flex items-center justify-between"><Pos pos={s.group} /><span className={cx('num text-[11px] font-semibold', s.rank <= 2 ? 'text-good-ink' : s.rank >= boot.teams.length - 1 ? 'text-bad-ink' : 'text-ink-3')}>{ordinal(s.rank)}</span></div>
                <div className="num mt-1.5 text-[18px] font-semibold">{fmt(s.points)}</div>
                <div className="text-[11px]"><Delta value={s.points - s.leagueAvg} /> <span className="text-ink-3">vs avg</span></div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {t.schedule.length > 0 && (
        <Card>
          <CardHeader title="Remaining schedule" right={team.rosterId === myTeamId ? <Button size="sm" onClick={() => navigate(pathFor(leagueId, 'lineup'))}>Start/sit <ArrowRight size={14} /></Button> : undefined} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {t.schedule.map(s => (
              <div key={s.week} className="rounded-[10px] border border-line p-2.5">
                <div className="flex justify-between text-[12px]"><span className="font-semibold">Week {s.week}</span><span className="num text-ink-3">{fmt(s.projected)} – {fmt(s.opponentProjected)}</span></div>
                <div className="my-1 truncate text-[12px] text-ink-2">vs {s.opponent ? teamName(s.opponent) : 'bye'}</div>
                {s.opponent && <WinBar a={team.rosterId} b={s.opponent} pA={s.winProb} height={6} />}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card pad={false}>
        <div className="px-4 pt-4 sm:px-5"><CardHeader title="Roster" subtitle={`${t.roster.length} players`} /></div>
        {byPos.map(g => (
          <div key={g.pos} className="border-t border-line">
            <div className="eyebrow bg-surface-2 px-4 py-1.5 sm:px-5">{g.pos} · {g.players.length}</div>
            <div className="overflow-x-auto scroll-thin">
              <table className="tbl num text-[13px]">
                <thead className="sr-only"><tr><th>Player</th><th>Slot</th><th>This week</th><th>ROS</th><th>Season</th><th>Value</th><th>Dynasty</th><th>Age</th></tr></thead>
                <tbody>
                  {g.players.map(r => (
                    <tr key={r.id} className="row-hover">
                      <td className="w-[40%]"><span className="flex items-center gap-2"><PlayerLink id={r.id} name={r.name} className="max-w-[200px]" /><span className="text-[11px] text-ink-3">{r.team ?? 'FA'}</span><Injury status={r.injury} /></span></td>
                      <td className="text-[11px] font-semibold text-ink-3">{r.slot === 'START' ? 'Starter' : r.slot === 'BN' ? 'Bench' : r.slot}</td>
                      <td className="r"><span className="text-ink-3">wk </span>{r.week ? (r.week.bye ? 'BYE' : fmt(r.week.exp)) : '—'}</td>
                      <td className="r"><span className="text-ink-3">ros </span>{fmt(r.value?.rosAvg)}</td>
                      <td className="r text-ink-2"><span className="text-ink-3">avg </span>{fmt(r.season?.ppg)}</td>
                      <td className="r font-medium"><span className="font-normal text-ink-3">val </span>{fmt(r.value?.value, 0)}</td>
                      <td className="r text-ink-2"><span className="text-ink-3">dyn </span>{fmt(r.value?.dynasty, 0)}</td>
                      <td className="r text-ink-3">{r.age ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </Card>

      {t.transactions.length > 0 && (
        <Card>
          <CardHeader title="Transactions" />
          <div className="divide-y divide-[var(--line)] text-[13px]">
            {t.transactions.map(tx => (
              <div key={tx.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="w-24 shrink-0 text-[12px] capitalize text-ink-3">{tx.type.replace('_', ' ')} · {ago(tx.created)}</span>
                {tx.adds.filter(a => a.rosterId === team.rosterId).map(a => <span key={a.id} className="inline-flex items-center gap-1.5"><span className="font-bold text-good-ink">+</span><Pos pos={a.pos} /><PlayerLink id={a.id} name={a.name} /></span>)}
                {tx.drops.filter(d => d.rosterId === team.rosterId).map(d => <span key={d.id} className="inline-flex items-center gap-1.5 text-ink-2"><span className="font-bold text-bad-ink">−</span><Pos pos={d.pos} /><PlayerLink id={d.id} name={d.name} className="font-normal text-ink-2" /></span>)}
                {tx.type === 'trade' && <span className="text-[12px] text-ink-3">with {tx.rosterIds.filter(x => x !== team.rosterId).map(x => <TeamLink key={x} rosterId={x} />)}</span>}
                {tx.faab !== null && <span className="num text-[12px] text-ink-3">${tx.faab}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
