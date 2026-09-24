import { useState } from 'react';
import { useTransactions } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { ago } from '../lib/format.ts';
import { Card, Empty, ErrorState, PageHeader, PageSkeleton, PlayerLink, Pos, Segmented, TeamLink } from '../components/ui.tsx';

export default function TransactionsPage() {
  const { leagueId } = useApp();
  const q = useTransactions(leagueId);
  const [type, setType] = useState('all');
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const list = q.data.transactions.filter(t => type === 'all' || t.type === type);
  return (
    <div className="space-y-5">
      <PageHeader title="Transactions" subtitle="Every completed add, drop and trade this season." right={<Segmented label="Type" value={type} onChange={setType} options={[{ value: 'all', label: 'All' }, { value: 'waiver', label: 'Waivers' }, { value: 'free_agent', label: 'Free agents' }, { value: 'trade', label: 'Trades' }]} />} />
      <Card pad={false}>
        {list.length === 0 ? <Empty title="No transactions" /> : (
          <div className="divide-y divide-[var(--line)]">
            {list.map(t => (
              <div key={t.id} className="grid gap-2 p-4 text-[13px] sm:grid-cols-[150px_1fr] sm:px-5">
                <div className="text-[12px] text-ink-3"><div className="font-semibold capitalize text-ink-2">{t.type.replace('_', ' ')}</div>Week {t.week} · {ago(t.created)}{t.faab !== null ? ` · $${t.faab} FAAB` : ''}</div>
                <div className="space-y-1">
                  {t.adds.map(a => <div key={`a${a.id}`} className="flex flex-wrap items-center gap-2"><span className="w-3 font-bold text-good-ink">+</span><Pos pos={a.pos} /><PlayerLink id={a.id} name={a.name} /><span className="text-ink-3">to</span><TeamLink rosterId={a.rosterId} /></div>)}
                  {t.drops.map(d => <div key={`d${d.id}`} className="flex flex-wrap items-center gap-2 text-ink-2"><span className="w-3 font-bold text-bad-ink">−</span><Pos pos={d.pos} /><PlayerLink id={d.id} name={d.name} className="font-normal text-ink-2" /><span className="text-ink-3">from</span><TeamLink rosterId={d.rosterId} /></div>)}
                  {t.picks.map((p, i) => <div key={`p${i}`} className="flex items-center gap-2 text-ink-2"><span className="w-3 text-ink-3">↔</span>{p.season} round {p.round} pick to <TeamLink rosterId={p.ownerId} /></div>)}
                  {t.budget.map((b, i) => <div key={`b${i}`} className="flex items-center gap-2 text-ink-2"><span className="w-3 text-ink-3">$</span>${b.amount} FAAB <TeamLink rosterId={b.sender} /> → <TeamLink rosterId={b.receiver} /></div>)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
