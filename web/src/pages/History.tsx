import { Crown, Medal } from 'lucide-react';
import { useHistory } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, pct, record } from '../lib/format.ts';
import { Card, CardHeader, Empty, ErrorState, PageHeader, PageSkeleton, cx } from '../components/ui.tsx';

export default function HistoryPage() {
  const { leagueId } = useApp();
  const q = useHistory(leagueId);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const h = q.data;
  const name = (ownerId: string | null | undefined) => (ownerId ? h.ownerNames[ownerId]?.name ?? h.allTime.find(o => o.ownerId === ownerId)?.name ?? 'Former manager' : '—');
  const owners = h.allTime.map(o => o.ownerId);
  const completed = h.seasons.filter(s => s.complete);
  return (
    <div className="space-y-5">
      <PageHeader title="League history" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {completed.length === 0 && <Card className="sm:col-span-2"><Empty title="No completed seasons yet" /></Card>}
        {completed.map(s => (
          <Card key={s.leagueId} className="p-4">
            <div className="eyebrow">{s.season}</div>
            <div className="mt-2 flex items-center gap-2"><Crown size={18} style={{ color: 'var(--warn)' }} aria-label="Champion" /><span className="truncate text-[16px] font-semibold">{name(s.champion)}</span></div>
            <div className="mt-1 flex items-center gap-2 text-[13px] text-ink-2"><Medal size={15} className="text-ink-3" aria-label="Runner-up" /><span className="truncate">{name(s.runnerUp)}</span></div>
          </Card>
        ))}
      </div>

      <Card pad={false}>
        <div className="px-4 pt-4 sm:px-5"><CardHeader title="All-time standings" /></div>
        <div className="overflow-x-auto scroll-thin">
          <table className="tbl num text-[13px]">
            <thead><tr><th>Manager</th><th className="r">Seasons</th><th className="r">Record</th><th className="r">Win %</th><th className="r">Points for</th><th className="r">Titles</th><th className="r">Finals</th></tr></thead>
            <tbody>
              {h.allTime.map(o => (
                <tr key={o.ownerId} className="row-hover">
                  <td className="font-medium">{name(o.ownerId)}<div className="text-[11px] font-normal text-ink-3">{h.ownerNames[o.ownerId]?.owner}</div></td>
                  <td className="r">{o.seasons}</td>
                  <td className="r">{record(o.wins, o.losses, o.ties)}</td>
                  <td className="r font-semibold">{pct(o.winPct, 1)}</td>
                  <td className="r">{fmt(o.pointsFor, 0)}</td>
                  <td className="r font-semibold">{o.titles || '—'}</td>
                  <td className="r">{o.finals || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Head-to-head" />
        <div className="overflow-x-auto scroll-thin">
          <table className="tbl num text-[12px]">
            <thead><tr><th />{owners.map(o => <th key={o} className="text-center">{name(o).slice(0, 12)}</th>)}</tr></thead>
            <tbody>
              {owners.map(row => (
                <tr key={row}>
                  <td className="whitespace-nowrap font-medium">{name(row)}</td>
                  {owners.map(col => {
                    if (row === col) return <td key={col} className="text-center text-ink-3">·</td>;
                    const r = h.h2h[row]?.[col];
                    if (!r) return <td key={col} className="text-center text-ink-3">—</td>;
                    const lead = r.w - r.l;
                    return <td key={col} className={cx('text-center', lead > 0 ? 'font-semibold text-good-ink' : lead < 0 ? 'text-bad-ink' : 'text-ink-2')}>{record(r.w, r.l, r.t)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Record book" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <div className="eyebrow mb-1">Highest</div>
              {h.records.highScore.map((x, i) => <div key={i} className="flex justify-between gap-2 py-1 text-[13px]"><span className="truncate">{name(x.owner)} <span className="text-ink-3">’{String(x.season).slice(2)} W{x.week}</span></span><span className="num font-semibold">{fmt(x.points)}</span></div>)}
            </div>
            <div>
              <div className="eyebrow mb-1">Lowest</div>
              {h.records.lowScore.map((x, i) => <div key={i} className="flex justify-between gap-2 py-1 text-[13px]"><span className="truncate">{name(x.owner)} <span className="text-ink-3">’{String(x.season).slice(2)} W{x.week}</span></span><span className="num font-semibold">{fmt(x.points)}</span></div>)}
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Blowouts and nail-biters" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <div className="eyebrow mb-1">Biggest margins</div>
              {h.records.blowouts.map((x, i) => <div key={i} className="py-1 text-[13px]"><div className="flex justify-between gap-2"><span className="truncate font-medium">{name(x.winner)}</span><span className="num font-semibold">+{fmt(x.margin)}</span></div><div className="text-[11px] text-ink-3">over {name(x.loser)} · {x.score} · ’{String(x.season).slice(2)} W{x.week}</div></div>)}
            </div>
            <div>
              <div className="eyebrow mb-1">Closest games</div>
              {h.records.closest.map((x, i) => <div key={i} className="py-1 text-[13px]"><div className="flex justify-between gap-2"><span className="truncate font-medium">{name(x.winner)}</span><span className="num font-semibold">+{fmt(x.margin, 2)}</span></div><div className="text-[11px] text-ink-3">over {name(x.loser)} · {x.score} · ’{String(x.season).slice(2)} W{x.week}</div></div>)}
            </div>
          </div>
        </Card>
      </div>

      {h.seasons.map(s => (
        <Card key={s.leagueId} pad={false}>
          <div className="px-4 pt-4 sm:px-5"><CardHeader title={`${s.season} ${s.complete ? 'final standings' : 'standings so far'}`} subtitle={s.name} /></div>
          <div className="overflow-x-auto scroll-thin">
            <table className="tbl num text-[13px]">
              <thead><tr><th className="w-12">Finish</th><th>Team</th><th className="r">Record</th><th className="r">PF</th><th className="r">PA</th></tr></thead>
              <tbody>
                {s.teams.map((t, i) => (
                  <tr key={t.rosterId} className="row-hover">
                    <td className="text-ink-3">{t.finish ?? i + 1}</td>
                    <td className="font-medium">{t.name}<span className="ml-2 text-[11px] font-normal text-ink-3">{t.owner}</span></td>
                    <td className="r">{record(t.wins, t.losses, t.ties)}</td>
                    <td className="r">{fmt(t.pointsFor)}</td>
                    <td className="r text-ink-2">{fmt(t.pointsAgainst)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}
