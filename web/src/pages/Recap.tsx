import { Award, Flame, Snowflake, Sparkles, Target, Trophy, Zap } from 'lucide-react';
import { useRecap } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, pct, record } from '../lib/format.ts';
import { Card, CardHeader, Delta, Empty, ErrorState, InfoTip, PageHeader, PageSkeleton, PlayerLink, Pos, TeamAvatar, TeamLink, cx } from '../components/ui.tsx';

const ICONS: Record<string, typeof Trophy> = { high: Flame, low: Snowflake, blowout: Zap, close: Target, efficiency: Sparkles, bench: Award, lucky: Sparkles, unlucky: Snowflake, pf: Flame, performance: Trophy, pickup: Award };

export default function RecapPage() {
  const { leagueId, teamName, boot, openPlayer } = useApp();
  const q = useRecap(leagueId);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const r = q.data;
  if (!r.weekly.length) return <Card><Empty title="Nothing to wrap yet">Awards appear after the first week is final.</Empty></Card>;
  const teams = r.summaries.map(s => s.rosterId);
  // Rank within week drives the heat (color by rank in week is magnitude, one hue).
  const rankIn = (week: (typeof r.weekly)[number], rid: number) => {
    const sorted = [...week.scores].sort((a, b) => b.points - a.points);
    return sorted.findIndex(s => s.rosterId === rid);
  };
  const steps = ['var(--seq-6)', 'var(--seq-5)', 'var(--seq-4)', 'var(--seq-3)', 'var(--seq-2)', 'var(--seq-1)', 'var(--seq-1)', 'var(--seq-1)'];
  return (
    <div className="space-y-5">
      <PageHeader eyebrow={`${boot.league.season} · through week ${r.weekly[r.weekly.length - 1].week}`} title="Season wrapped" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {r.awards.map(a => {
          const Icon = ICONS[a.key] ?? Trophy;
          return (
            <Card key={a.key} className="p-4">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2"><Icon size={14} className="text-ink-3" aria-hidden />{a.title}</div>
              <div className="num mt-2 text-[24px] font-semibold leading-tight">{a.value}</div>
              <div className="mt-1 flex items-center gap-2 text-[13px]"><TeamAvatar rosterId={a.rosterId} size={18} /><span className="truncate font-medium">{teamName(a.rosterId)}</span></div>
              <div className="mt-1 text-[12px] text-ink-3">{a.detail}</div>
              {a.playerId && <button onClick={() => openPlayer(a.playerId!)} className="mt-1 text-[12px] font-medium text-accent hover:underline">View player</button>}
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader title="Weekly scores" />
        <div className="overflow-x-auto scroll-thin">
          <div className="grid min-w-[480px] gap-1" style={{ gridTemplateColumns: `minmax(150px,1.4fr) repeat(${r.weekly.length}, minmax(54px,1fr))` }}>
            <div />
            {r.weekly.map(w => <div key={w.week} className="pb-1 text-center text-[11px] font-semibold text-ink-3">W{w.week}</div>)}
            {teams.map(rid => (
              <div key={rid} className="contents">
                <div className="flex items-center"><TeamLink rosterId={rid} /></div>
                {r.weekly.map(w => {
                  const s = w.scores.find(x => x.rosterId === rid);
                  if (!s) return <div key={w.week} />;
                  const rank = rankIn(w, rid);
                  const dark = rank <= 2;
                  return (
                    <div key={w.week} title={`${teamName(rid)} week ${w.week}: ${fmt(s.points)} (${s.result ?? ''}) · optimal ${fmt(s.optimal)}`} className="num flex h-9 flex-col items-center justify-center rounded-[6px] text-[12px] font-semibold leading-tight" style={{ background: steps[rank], color: dark ? '#fff' : '#0b0b0b' }}>
                      {fmt(s.points, 0)}<span className="text-[9px] font-bold opacity-80">{s.result}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card pad={false}>
        <div className="px-4 pt-4 sm:px-5"><CardHeader title="Luck and lineup management" right={<InfoTip>All-play plays every team every week. Expected wins = all-play win rate × games. Efficiency = points started ÷ best possible lineup from the same roster in hindsight.</InfoTip>} /></div>
        <div className="overflow-x-auto scroll-thin">
          <table className="tbl num text-[13px]">
            <thead><tr><th>Team</th><th className="r">Record</th><th className="r">All-play</th><th className="r">Exp. wins</th><th className="r">Luck</th><th className="r">Efficiency</th><th className="r">Bench pts</th><th className="r">High</th><th className="r">Low</th></tr></thead>
            <tbody>
              {[...r.summaries].sort((a, b) => b.luck - a.luck).map(s => (
                <tr key={s.rosterId} className="row-hover">
                  <td><TeamLink rosterId={s.rosterId} showAvatar /></td>
                  <td className="r">{record(s.wins, s.losses, s.ties)}</td>
                  <td className="r text-ink-2">{record(s.allPlayWins, s.allPlayLosses)}</td>
                  <td className="r text-ink-2">{fmt(s.expectedWins, 2)}</td>
                  <td className="r"><Delta value={s.luck} digits={2} /></td>
                  <td className={cx('r', s.efficiency >= 0.9 ? 'font-semibold' : '')}>{pct(s.efficiency, 1)}</td>
                  <td className="r text-ink-2">{fmt(s.benchPoints)}</td>
                  <td className="r text-ink-2">{fmt(s.high)}</td>
                  <td className="r text-ink-2">{fmt(s.low)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Team MVPs" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {r.mvps.map(m => (
            <div key={m.rosterId} className="rounded-[12px] border border-line p-3">
              <TeamLink rosterId={m.rosterId} showAvatar className="font-semibold" />
              <div className="mt-2 space-y-1">
                {m.players.map((p, i) => <div key={p.id} className="flex items-center gap-2 text-[13px]"><span className="num w-4 text-ink-3">{i + 1}</span><Pos pos={p.pos} /><PlayerLink id={p.id} name={p.name} /><span className="num ml-auto font-semibold">{fmt(p.points)}</span></div>)}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Week by week" />
        <div className="space-y-4">
          {r.recaps.map(w => (
            <details key={w.week} className="group rounded-[12px] border border-line p-3" open={w === r.recaps[0]}>
              <summary className="flex cursor-pointer list-none items-center justify-between font-semibold">Week {w.week}<span className="text-[12px] font-normal text-ink-3 group-open:hidden">Show</span></summary>
              <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="space-y-1.5 text-[13px]">
                  {w.results.map(x => <div key={`${x.winner}-${x.loser}`} className="flex justify-between gap-2"><span className="truncate"><b>{teamName(x.winner)}</b> def. {teamName(x.loser ?? 0)}</span><span className="num shrink-0">{fmt(x.winnerPts)}–{fmt(x.loserPts)}</span></div>)}
                </div>
                <div>
                  <div className="eyebrow mb-1">Top performers</div>
                  {w.topPerformers.slice(0, 4).map(p => <div key={p.id} className="flex items-center gap-2 py-0.5 text-[13px]"><Pos pos={p.pos} /><PlayerLink id={p.id} name={p.name} /><span className="num ml-auto font-semibold">{fmt(p.pts)}</span></div>)}
                </div>
                <div>
                  <div className="eyebrow mb-1">Bench blunders</div>
                  {w.benchBlunders.map(p => <div key={p.id} className="flex items-center gap-2 py-0.5 text-[13px]"><Pos pos={p.pos} /><PlayerLink id={p.id} name={p.name} className="font-normal" /><span className="truncate text-[11px] text-ink-3">{teamName(p.rosterId)}</span><span className="num ml-auto">{fmt(p.pts)}</span></div>)}
                </div>
              </div>
            </details>
          ))}
        </div>
      </Card>
    </div>
  );
}
