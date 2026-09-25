import { useMemo, useState } from 'react';
import { useDefense, usePlayers } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, pct, posLabel } from '../lib/format.ts';
import { useSearchParam } from '../lib/router.ts';
import { Card, CardHeader, Empty, ErrorState, PageHeader, PageSkeleton, PlayerLink, Pos, Segmented, Select, useSort, useTooltip } from '../components/ui.tsx';

/** Groups whose rows are the offenses they faced rather than the defenses. */
const FACING_OFFENSE = new Set(['DL', 'LB', 'DB', 'DEF']);
// Diverging scale: tough (red) → neutral → soft (blue). Softer = better for the player.
const DIVERGING = ['#b52f2e', '#dd5b5a', '#eea3a2', 'var(--surface-3)', '#9ec5f4', '#5598e7', '#1c5cab'];
const divergingText = (i: number) => (i === 0 || i === 1 || i >= 5 ? '#fff' : i === 3 ? 'var(--ink)' : '#0b0b0b');

function Rating({ value }: { value: number }) {
  const i = Math.min(6, Math.max(0, Math.floor((value / 100) * 7)));
  return <span className="num inline-flex h-6 min-w-[40px] items-center justify-center rounded-[6px] px-1.5 text-[12px] font-semibold" style={{ background: DIVERGING[i], color: divergingText(i) }}>{fmt(value, 0)}</span>;
}

export default function DefensePage() {
  const { leagueId, myTeamId, boot } = useApp();
  const [seasonParam, setSeason] = useSearchParam('season');
  const q = useDefense(leagueId, seasonParam ? Number(seasonParam) : undefined);
  const players = usePlayers(leagueId);
  const [group, setGroup] = useState<string>(boot.league.positions[0] ?? 'QB');
  const tip = useTooltip();
  const d = q.data;
  const rows = useMemo(() => d?.groups[group] ?? [], [d, group]);
  const { sorted, header } = useSort(rows, { key: 'score', dir: 'desc' }, {
    team: r => r.team, score: r => r.score, player: r => r.playerScore, ppg: r => r.pointsPerGame, adj: r => r.adjustedPerGame, last4: r => r.last4,
    ceil: r => r.ceilingRate, floor: r => r.floorRate, top10: r => r.top10Rate, opp: r => r.opportunitiesPerGame, eff: r => r.efficiency, games: r => r.games,
  });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!d) return null;
  const byTeam = new Map(rows.map(r => [r.team, r]));
  const idp = FACING_OFFENSE.has(group);
  const label = posLabel(group, boot.league.platform);
  const groups = boot.league.positions.filter(p => d.groups[p]);
  const allWeekly = rows.flatMap(r => r.weekly.map(w => w[1])).sort((a, b) => a - b);
  const heatStep = (v: number) => {
    const rank = allWeekly.findIndex(x => x >= v);
    return Math.min(6, Math.floor(((rank < 0 ? allWeekly.length : rank) / Math.max(1, allWeekly.length)) * 7));
  };
  const mine = (players.data?.players ?? []).filter(p => myTeamId !== null && p.owner === myTeamId && p.pos === group && p.team && d.upcoming[p.team]);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Defense"
        subtitle={`${group === 'DEF' ? `Points ${label}s score against each offense` : `Points allowed ${idp ? 'by offenses to IDP' : 'to each position'}`} in league scoring · ${d.season}${d.season === d.seasons[0] ? ` through week ${d.throughWeek}` : ''}`}
        right={<Select label="Season" value={d.season} onChange={v => setSeason(String(v), true)} options={d.seasons.map(s => ({ value: s, label: String(s) }))} className="w-28" />}
      />
      <Segmented label="Position" value={group} onChange={setGroup} options={groups.map(p => ({ value: p, label: posLabel(p, boot.league.platform) }))} />

      {mine.length > 0 && d.week && (
        <Card>
          <CardHeader title={`Your ${label}${group === 'DEF' ? '' : 's'} in week ${d.week}`} />
          <div className="flex flex-wrap gap-2">
            {mine.map(p => {
              const opp = d.upcoming[p.team!];
              const r = byTeam.get(opp);
              return (
                <div key={p.id} className="flex items-center gap-2 rounded-[10px] border border-line px-2.5 py-1.5 text-[13px]">
                  <Pos pos={p.pos} /><PlayerLink id={p.id} name={p.name} /><span className="text-ink-3">vs {opp}</span>{r && <Rating value={r.playerScore} />}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card pad={false}>
        {sorted.length === 0 ? <Empty title="No games yet" /> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="tbl num text-[13px]">
              <thead>
                <tr>
                  <th className="w-10">#</th>
                  {header('team', idp ? 'Offense' : 'Defense')}
                  {d.week && <th>Wk {d.week}</th>}
                  {header('score', 'Matchup', 'r')}
                  {header('player', 'Player', 'r')}
                  {header('ppg', 'Allowed/gm', 'r')}
                  {header('adj', 'Adj/gm', 'r')}
                  {header('last4', 'Last 4', 'r')}
                  {header('ceil', 'Ceiling%', 'r')}
                  {header('floor', 'Floor%', 'r')}
                  {header('top10', 'Top-10%', 'r')}
                  {header('opp', 'Opp/gm', 'r')}
                  {header('eff', 'Pts/opp', 'r')}
                  {header('games', 'G', 'r')}
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => (
                  <tr key={r.team} className="row-hover">
                    <td className="text-ink-3">{r.rank}</td>
                    <td className="font-semibold">{r.team}</td>
                    {d.week && <td className="whitespace-nowrap text-ink-2">{d.upcoming[r.team] ? `vs ${d.upcoming[r.team]}` : 'BYE'}</td>}
                    <td className="r"><Rating value={r.score} /></td>
                    <td className="r"><Rating value={r.playerScore} /></td>
                    <td className="r font-semibold">{fmt(r.pointsPerGame)}</td>
                    <td className="r">{fmt(r.adjustedPerGame)}</td>
                    <td className="r">{fmt(r.last4)}</td>
                    <td className="r text-ink-2">{pct(r.ceilingRate)}</td>
                    <td className="r text-ink-2">{pct(r.floorRate)}</td>
                    <td className="r text-ink-2">{pct(r.top10Rate)}</td>
                    <td className="r text-ink-2">{fmt(r.opportunitiesPerGame)}</td>
                    <td className="r text-ink-2">{fmt(r.efficiency, 2)}</td>
                    <td className="r text-ink-3">{r.games}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {sorted.length > 0 && (
        <Card>
          <CardHeader title="By week" subtitle={`${label} points allowed each week`} />
          <div className="overflow-x-auto scroll-thin">
            <div className="grid min-w-[640px] gap-[2px]" style={{ gridTemplateColumns: `56px repeat(${d.weeks.length}, minmax(34px,1fr))` }}>
              <div />
              {d.weeks.map(w => <div key={w} className="pb-1 text-center text-[11px] font-semibold text-ink-3">{w}</div>)}
              {sorted.map(r => {
                const byWeek = new Map(r.weekly);
                return (
                  <div key={r.team} className="contents">
                    <div className="flex items-center text-[12px] font-semibold">{r.team}</div>
                    {d.weeks.map(w => {
                      const v = byWeek.get(w);
                      if (v === undefined) return <div key={w} className="flex h-7 items-center justify-center rounded-[4px] text-[10px] text-ink-3">·</div>;
                      const s = heatStep(v);
                      const bg = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)', 'var(--seq-6)', 'var(--seq-7)'][s];
                      return (
                        <div key={w} className="num flex h-7 items-center justify-center rounded-[4px] text-[11px] font-medium" style={{ background: bg, color: s >= 3 ? '#fff' : '#0b0b0b' }}
                          onPointerMove={e => tip.show(e, <span>{r.team} week {w}: <b className="num">{fmt(v)}</b> pts allowed to {label}</span>)} onPointerLeave={tip.hide}>
                          {fmt(v, 0)}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
          {tip.node}
        </Card>
      )}
    </div>
  );
}
