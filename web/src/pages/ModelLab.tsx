import { useModel, useTracking, type Metrics } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { fmt, pct, FEATURE_LABELS } from '../lib/format.ts';
import { GroupedBars, HBars } from '../charts/charts.tsx';
import { Card, CardHeader, Empty, ErrorState, InfoTip, Meter, PageHeader, PageSkeleton, Stat, cx } from '../components/ui.tsx';

const SERIES = [
  { key: 'model', name: 'SLA model', color: 'var(--team-1)' },
  { key: 'provider', name: 'Sleeper projection (rescored)', color: 'var(--team-2)' },
  { key: 'linear', name: 'Recalibrated projection (SLA 1.0)', color: 'var(--team-3)' },
] as const;
const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'];

export default function ModelLab() {
  const q = useModel();
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const r = q.data;
  const h = r.holdout2025;
  const bt = r.lineupBacktest;
  const improvement = (h.provider.mae - h.model.mae) / h.provider.mae;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Model ${r.meta.version} · trained ${new Date(r.meta.trainedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
        title="Model lab"
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card><Stat label="Error vs Sleeper projection (2025)" value={`−${fmt(improvement * 100, 1)}%`} sub={`MAE ${fmt(h.model.mae, 2)} vs ${fmt(h.provider.mae, 2)} pts · 95% CI of the gap ${fmt(r.maeDeltaCI2025[0], 2)} to ${fmt(r.maeDeltaCI2025[1], 2)}`} tone="good" /></Card>
        <Card><Stat label="Close start/sit calls ordered right" value={pct(h.model.closePairAcc, 1)} sub={`Sleeper ${pct(h.provider.closePairAcc, 1)} · same-position pairs within 3 pts`} /></Card>
        {bt && <Card><Stat label="Lineups on your league’s 2025 rosters" value={`+${fmt(bt.modelMinusProvider, 1)} / wk`} sub={`vs Sleeper-projection lineups · 95% CI ${bt.modelMinusProviderCI ? `${fmt(bt.modelMinusProviderCI[0], 1)} to ${fmt(bt.modelMinusProviderCI[1], 1)}` : '—'} · better in ${bt.modelBeatProvider} of ${bt.modelBeatProvider + bt.providerBeatModel} decided team-weeks`} tone={bt.modelMinusProviderCI && bt.modelMinusProviderCI[0] > 0 ? 'good' : undefined} /></Card>}
        {bt && <Card><Stat label="vs lineups managers actually set" value={`+${fmt(bt.modelMinusManager, 1)} / wk`} sub={`${bt.resultFlipsVsManager.flips} of ${bt.resultFlipsVsManager.games} results would have flipped`} tone="good" /></Card>}
      </div>

      <Card>
        <CardHeader title="Accuracy by position — 2025 holdout" subtitle={`Mean absolute error, league points (lower is better) · ${h.model.n.toLocaleString('en-US')} player-games`} />
        <GroupedBars categories={POS} series={SERIES.map(s => ({ ...s, values: POS.map(p => h[s.key].byPos[p]?.mae ?? 0) }))} format={v => `${fmt(v, 2)} pts`} yLabel="Mean absolute error by position" />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <MetricTable title="2025 holdout (never seen in training)" m={r.holdout2025} />
        {r.live2026 ? <MetricTable title="2026 so far (model trained through 2025)" m={r.live2026} note="Only two weeks. Treat as a smoke test, not evidence." /> : <Card><Empty title="No 2026 weeks scored yet" /></Card>}
      </div>

      {bt && (
        <Card>
          <CardHeader title="Lineup backtest on Neighbas in Paris 2025" subtitle={`${bt.teamWeeks} team-weeks`} />
          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-3">
              {([['Hindsight-perfect lineup', bt.perTeamWeek.optimal, 1], ['SLA model', bt.perTeamWeek.model, bt.captureRate.model], ['Sleeper projection', bt.perTeamWeek.provider, bt.captureRate.provider], ['What managers started', bt.perTeamWeek.manager, bt.captureRate.manager]] as const).map(([label, pts, cap]) => (
                <div key={label}>
                  <div className="flex justify-between text-[13px]"><span className="text-ink-2">{label}</span><span className="num font-semibold">{fmt(pts)} pts/wk · {pct(cap, 1)}</span></div>
                  <Meter value={cap} color={label === 'SLA model' ? 'var(--team-1)' : label === 'Sleeper projection' ? 'var(--team-2)' : 'var(--ink-3)'} label={label} />
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="What the model leans on" subtitle="Share of total split gain in the gradient-boosted trees" />
          <HBars rows={r.importance.slice(0, 12).map(f => ({ key: f.feature, label: FEATURE_LABELS[f.feature] ?? f.feature, value: f.share * 100 }))} format={v => `${fmt(v, 1)}%`} />
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Are the ranges honest?" subtitle="Share of 2025 outcomes inside each position’s 10th–90th percentile band (target 80%)" right={<InfoTip>Bands were fit on 2024 residuals only, then checked on 2025, so this is an out-of-sample calibration test.</InfoTip>} />
            <div className="grid grid-cols-4 gap-3">
              {POS.map(p => (
                <div key={p}>
                  <div className="flex justify-between text-[12px]"><span className="font-semibold text-ink-2">{p}</span><span className="num">{pct(r.coverage80[p], 0)}</span></div>
                  <Meter value={r.coverage80[p]} color={Math.abs(r.coverage80[p] - 0.8) <= 0.03 ? 'var(--good)' : 'var(--warn)'} label={`${p} coverage`} />
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title="Chance to play by injury tag" subtitle="Measured on 2020–2025 official game-status reports" />
            <table className="tbl num text-[13px]">
              <thead><tr><th>Designation</th><th className="r">Played</th><th className="r">Sample</th></tr></thead>
              <tbody>
                {([['No designation', r.availability.none, null], ['Questionable', r.availability.Questionable, r.availability.n.Questionable], ['Doubtful', r.availability.Doubtful, r.availability.n.Doubtful], ['Out / IR / Suspended', 0, r.availability.n.Out]] as const).map(([k, v, n]) => (
                  <tr key={k}><td>{k}</td><td className="r font-semibold">{pct(v, 1)}</td><td className="r text-ink-2">{n ? n.toLocaleString('en-US') : '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </div>

      <Tracking />
    </div>
  );
}

function MetricTable({ title, m, note }: { title: string; m: Record<'model' | 'provider' | 'linear' | 'form', Metrics>; note?: string }) {
  const rows = [['SLA model', m.model], ['Sleeper projection', m.provider], ['Recalibrated (SLA 1.0)', m.linear], ['Recent form only', m.form]] as const;
  const best = Math.min(...rows.map(([, x]) => x.mae));
  return (
    <Card pad={false}>
      <div className="px-4 pt-4 sm:px-5"><CardHeader title={title} subtitle={`${m.model.n.toLocaleString('en-US')} player-games${note ? ` · ${note}` : ''}`} /></div>
      <div className="overflow-x-auto scroll-thin">
        <table className="tbl num text-[13px]">
          <thead><tr><th>Method</th><th className="r">MAE</th><th className="r">RMSE</th><th className="r">Bias</th><th className="r"><span className="inline-flex items-center gap-1">Pairs <InfoTip>Same week, same position: share of pairs ordered correctly.</InfoTip></span></th><th className="r">Close pairs</th></tr></thead>
          <tbody>
            {rows.map(([label, x]) => (
              <tr key={label}>
                <td className={cx(label === 'SLA model' && 'font-semibold')}>{label}</td>
                <td className={cx('r', x.mae === best && 'font-semibold text-good-ink')}>{fmt(x.mae, 3)}</td>
                <td className="r text-ink-2">{fmt(x.rmse, 2)}</td>
                <td className="r text-ink-2">{fmt(x.bias, 2)}</td>
                <td className="r">{pct(x.pairAcc, 1)}</td>
                <td className="r">{pct(x.closePairAcc, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Tracking() {
  const { leagueId } = useApp();
  const q = useTracking(leagueId);
  return (
    <Card>
      <CardHeader title="Live track record" />
      {q.data && q.data.weeks.length ? (
        <table className="tbl num text-[13px]">
          <thead><tr><th>Week</th><th className="r">Players</th><th className="r">SLA MAE</th><th className="r">Sleeper MAE</th><th className="r">Bias</th><th className="r">Pair accuracy</th></tr></thead>
          <tbody>{q.data.weeks.map(w => <tr key={w.week}><td>Week {w.week}</td><td className="r">{w.players}</td><td className={cx('r font-semibold', w.maeModel < w.maeProvider && 'text-good-ink')}>{fmt(w.maeModel, 2)}</td><td className="r">{fmt(w.maeProvider, 2)}</td><td className="r text-ink-2">{fmt(w.biasModel, 2)}</td><td className="r">{w.pairAcc === null ? '—' : pct(w.pairAcc, 1)}</td></tr>)}</tbody>
        </table>
      ) : <Empty title="Collecting">Appears after the first week with saved forecasts is final.</Empty>}
    </Card>
  );
}
