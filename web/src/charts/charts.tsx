/**
 * Hand-rolled SVG charts following the dataviz mark specs: 2px lines, ≤24px bars with 4px
 * rounded data-ends, 2px surface gaps, hairline solid grid, hover on every chart, colour by entity.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { fmt, pairColors, prob, teamColor } from '../lib/format.ts';
import { useTooltip } from '../components/ui.tsx';

export function useWidth<T extends HTMLElement>(fallback = 600): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width) setW(Math.floor(width));
    });
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width) || fallback);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, w];
}

/** Round tick values. `extend` adds one more tick so the axis always covers the maximum. */
function niceTicks(min: number, max: number, count = 4, extend = false): number[] {
  if (max <= min) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const end = extend ? Math.ceil(max / step - 1e-9) * step : max;
  const ticks: number[] = [];
  for (let v = start; v <= end + 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

function TipRow({ color, label, value, line = true }: { color: string; label: ReactNode; value: ReactNode; line?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-ink-2">
        {line ? <span className="inline-block h-[2px] w-3 rounded" style={{ background: color }} /> : <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />}
        {label}
      </span>
      <span className="num font-semibold text-ink">{value}</span>
    </div>
  );
}

// ─── Win probability split bar ──────────────────────────────────────────────

export function WinBar({ a, b, pA, labels = true, height = 8 }: { a: number; b: number | null; pA: number | null; labels?: boolean; height?: number }) {
  if (pA === null || b === null) return <div className="h-2 rounded-full bg-surface-3" />;
  const left = Math.max(0.02, Math.min(0.98, pA));
  const [colorA, colorB] = pairColors(a, b);
  return (
    <div>
      <div className="flex w-full gap-[2px]" style={{ height }} role="img" aria-label={`Win probability ${prob(pA)} to ${prob(1 - pA)}`}>
        <div className="rounded-l-full" style={{ width: `${left * 100}%`, background: colorA }} />
        <div className="rounded-r-full" style={{ width: `${(1 - left) * 100}%`, background: colorB }} />
      </div>
      {labels && (
        <div className="num mt-1 flex justify-between text-[12px] font-semibold text-ink">
          <span>{prob(pA)}</span>
          <span>{prob(1 - pA)}</span>
        </div>
      )}
    </div>
  );
}

// ─── Two-team score distribution ────────────────────────────────────────────

export function ScoreDistribution({ hist, a, b, nameA, nameB }: {
  hist: { lo: number; hi: number; a: number[]; b: number[] }; a: number; b: number; nameA: string; nameB: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(520);
  const tip = useTooltip();
  const [hover, setHover] = useState<number | null>(null);
  // Pinned while a phone user is reading the tip: set on tap, cleared by tapping the same spot again.
  const [pinned, setPinned] = useState<number | null>(null);
  const [colorA, colorB] = pairColors(a, b);
  const H = 150, pad = { l: 8, r: 8, t: 10, b: 24 };
  const n = hist.a.length;
  const binW = (hist.hi - hist.lo) / n;
  const maxY = Math.max(...hist.a, ...hist.b, 0.0001);
  const x = (v: number) => pad.l + ((v - hist.lo) / (hist.hi - hist.lo)) * (width - pad.l - pad.r);
  const y = (p: number) => pad.t + (1 - p / maxY) * (H - pad.t - pad.b);
  const path = (arr: number[]) => arr.map((p, i) => `${i ? 'L' : 'M'}${x(hist.lo + (i + 0.5) * binW).toFixed(1)},${y(p).toFixed(1)}`).join('');
  const area = (arr: number[]) => `${path(arr)}L${x(hist.lo + (n - 0.5) * binW)},${y(0)}L${x(hist.lo + 0.5 * binW)},${y(0)}Z`;
  const ticks = niceTicks(hist.lo, hist.hi, Math.max(3, Math.floor(width / 110)));
  const content = (i: number) => (
    <div className="space-y-1">
      <div className="text-ink-3">{fmt(hist.lo + i * binW, 0)}–{fmt(hist.lo + (i + 1) * binW, 0)} pts</div>
      <TipRow color={colorA} label={nameA} value={`${(hist.a[i] * 100).toFixed(1)}%`} />
      <TipRow color={colorB} label={nameB} value={`${(hist.b[i] * 100).toFixed(1)}%`} />
    </div>
  );
  const nearest = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    return Math.max(0, Math.min(n - 1, Math.floor(((px - pad.l) / (width - pad.l - pad.r)) * n)));
  };
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (e.pointerType === 'touch' && pinned === null) return; // taps pin, drags scroll the page
    const i = nearest(e);
    setHover(i);
    tip.show(e, content(i));
  };
  const onDown = (e: React.PointerEvent<SVGRectElement>) => {
    const i = nearest(e);
    if (pinned !== null) { if (pinned === i) { setPinned(null); setHover(null); tip.hide(); } else { setPinned(i); setHover(i); tip.show(e, content(i)); } return; }
    if (e.pointerType !== 'touch') return;
    setPinned(i);
    setHover(i);
    tip.show(e, content(i));
  };
  return (
    <div ref={ref} className="w-full min-w-0">
      <svg className="block max-w-full" width={width} height={H} role="img" aria-label={`Simulated score distributions for ${nameA} and ${nameB}`}>
        <line x1={pad.l} x2={width - pad.r} y1={y(0)} y2={y(0)} stroke="var(--axis)" strokeWidth={1} />
        {ticks.map(t => (
          <g key={t}>
            <text x={x(t)} y={H - 6} textAnchor="middle" className="num" fontSize={11} fill="var(--ink-3)">{fmt(t, 0)}</text>
          </g>
        ))}
        {([['a', hist.a, colorA], ['b', hist.b, colorB]] as const).map(([k, arr, color]) => (
          <g key={k}>
            <path d={area(arr)} fill={color} opacity={0.1} />
            <path d={path(arr)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        {hover !== null && <line x1={x(hist.lo + (hover + 0.5) * binW)} x2={x(hist.lo + (hover + 0.5) * binW)} y1={pad.t} y2={y(0)} stroke="var(--ink-3)" strokeWidth={1} />}
        <rect x={0} y={0} width={width} height={H} fill="transparent" onPointerMove={onMove}
          onPointerDown={onDown}
          onPointerLeave={() => { if (pinned !== null) return; setHover(null); tip.hide(); }} onPointerCancel={() => { setPinned(null); setHover(null); tip.hide(); }} />
      </svg>
      <div className="mt-1 flex flex-wrap gap-4 text-[12px] text-ink-2">
        <span className="inline-flex items-center gap-1.5"><span className="h-[2px] w-3 rounded" style={{ background: colorA }} />{nameA}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-[2px] w-3 rounded" style={{ background: colorB }} />{nameB}</span>
      </div>
      {tip.node}
    </div>
  );
}

// ─── Sparkline ──────────────────────────────────────────────────────────────

export function Sparkline({ points, width = 96, height = 26, color = 'var(--accent)', label }: { points: [number, number][]; width?: number; height?: number; color?: string; label?: string }) {
  const tip = useTooltip();
  const [pinned, setPinned] = useState(false);
  if (points.length < 2) return <span className="text-[12px] text-ink-3">{points.length ? fmt(points[0][1]) : '—'}</span>;
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(0, ...ys), maxY = Math.max(...ys, 1);
  const x = (v: number) => 4 + ((v - minX) / (maxX - minX || 1)) * (width - 8);
  const y = (v: number) => 4 + (1 - (v - minY) / (maxY - minY || 1)) * (height - 8);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  const nearest = (e: React.PointerEvent<SVGSVGElement>) =>
    points.reduce((best, p) => (Math.abs(x(p[0]) - (e.clientX - e.currentTarget.getBoundingClientRect().left)) < Math.abs(x(best[0]) - (e.clientX - e.currentTarget.getBoundingClientRect().left)) ? p : best), points[0]);
  return (
    <>
      <svg width={width} height={height} role="img" aria-label={label ?? `Weekly points: ${ys.map(v => fmt(v)).join(', ')}`}
        onPointerMove={e => {
          if (e.pointerType === 'touch' && !pinned) return; // taps pin, drags scroll the page
          const p = nearest(e);
          tip.show(e, <span>Week {p[0]}: <b className="num">{fmt(p[1])}</b> pts</span>);
        }}
        onPointerDown={e => {
          if (e.pointerType !== 'touch') return;
          if (pinned) { setPinned(false); tip.hide(); return; }
          setPinned(true);
          const p = nearest(e);
          tip.show(e, <span>Week {p[0]}: <b className="num">{fmt(p[1])}</b> pts</span>);
        }}
        onPointerLeave={() => { if (pinned) return; tip.hide(); }}
        onPointerCancel={() => { setPinned(false); tip.hide(); }}>
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={x(last[0])} cy={y(last[1])} r={3.5} fill={color} stroke="var(--surface)" strokeWidth={2} />
      </svg>
      {tip.node}
    </>
  );
}

// ─── Floor / median / ceiling range ─────────────────────────────────────────

export function RangeBar({ floor, median, ceiling, expected, max, width = 120 }: { floor: number; median: number; ceiling: number; expected: number; max: number; width?: number }) {
  const tip = useTooltip();
  const [pinned, setPinned] = useState(false);
  const h = 16, pad = 3;
  const x = (v: number) => pad + (Math.max(0, Math.min(max, v)) / (max || 1)) * (width - pad * 2);
  const content = (
    <div className="space-y-0.5">
      <TipRow color="var(--accent)" label="Expected" value={fmt(expected)} line={false} />
      <div className="flex justify-between gap-4 text-ink-2"><span>Floor (10th pct)</span><span className="num font-semibold text-ink">{fmt(floor)}</span></div>
      <div className="flex justify-between gap-4 text-ink-2"><span>Median</span><span className="num font-semibold text-ink">{fmt(median)}</span></div>
      <div className="flex justify-between gap-4 text-ink-2"><span>Ceiling (90th pct)</span><span className="num font-semibold text-ink">{fmt(ceiling)}</span></div>
    </div>
  );
  return (
    <>
      <svg width={width} height={h} role="img" aria-label={`Range ${fmt(floor)} to ${fmt(ceiling)}, expected ${fmt(expected)}`}
        onPointerMove={e => { if (e.pointerType === 'touch' && !pinned) return; tip.show(e, content); }}
        onPointerDown={e => {
          if (e.pointerType !== 'touch') return;
          if (pinned) { setPinned(false); tip.hide(); } else { setPinned(true); tip.show(e, content); }
        }}
        onPointerLeave={() => { if (pinned) return; tip.hide(); }}
        onPointerCancel={() => { setPinned(false); tip.hide(); }}>
        <line x1={pad} x2={width - pad} y1={h / 2} y2={h / 2} stroke="var(--grid)" strokeWidth={1} />
        <rect x={x(floor)} y={h / 2 - 3} width={Math.max(2, x(ceiling) - x(floor))} height={6} rx={3} fill="var(--accent)" opacity={0.22} />
        <line x1={x(median)} x2={x(median)} y1={h / 2 - 5} y2={h / 2 + 5} stroke="var(--ink-2)" strokeWidth={1.5} />
        <circle cx={x(expected)} cy={h / 2} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
      </svg>
      {tip.node}
    </>
  );
}

// ─── Multi-series line (power over time) with emphasis ──────────────────────

export interface LineSeries { id: number; name: string; values: (number | null)[] }

export function TrendChart({ series, labels, highlight, height = 220, yLabel, invert = false, yDomain }: {
  series: LineSeries[]; labels: (string | number)[]; highlight: number[]; height?: number; yLabel?: string; invert?: boolean; yDomain?: [number, number];
}) {
  const [ref, width] = useWidth<HTMLDivElement>(600);
  const tip = useTooltip();
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const pad = { l: 34, r: 90, t: 12, b: 26 };
  const all = series.flatMap(s => s.values.filter((v): v is number => v !== null));
  const [minY, maxY] = yDomain ?? [Math.min(...all, 0), Math.max(...all, 1)];
  const x = (i: number) => pad.l + (labels.length <= 1 ? 0.5 : i / (labels.length - 1)) * (width - pad.l - pad.r);
  const y = (v: number) => {
    const t = (v - minY) / (maxY - minY || 1);
    return pad.t + (invert ? t : 1 - t) * (height - pad.t - pad.b);
  };
  const ticks = niceTicks(minY, maxY, 4);
  const hl = new Set(highlight);
  const ordered = [...series].sort((a, b) => Number(hl.has(a.id)) - Number(hl.has(b.id)));
  const pathFor = (vals: (number | null)[]) => {
    let d = '', pen = false;
    vals.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    return d;
  };
  const content = (i: number) => (
    <div className="space-y-1">
      <div className="text-ink-3">{typeof labels[i] === 'number' ? `Week ${labels[i]}` : labels[i]}</div>
      {series.map(s => ({ s, v: s.values[i] })).filter(r => r.v !== null && r.v !== undefined).sort((a, b) => (invert ? a.v! - b.v! : b.v! - a.v!))
        .map(r => <TipRow key={r.s.id} color={hl.has(r.s.id) ? teamColor(r.s.id) : 'var(--ink-3)'} label={r.s.name} value={fmt(r.v, invert ? 0 : 1)} />)}
    </div>
  );
  const nearest = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let i = 0, best = Infinity;
    labels.forEach((_, k) => { const dist = Math.abs(x(k) - px); if (dist < best) { best = dist; i = k; } });
    return i;
  };
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (e.pointerType === 'touch' && pinned === null) return; // taps pin, drags scroll the page
    const i = nearest(e);
    setHover(i);
    tip.show(e, content(i));
  };
  const onDown = (e: React.PointerEvent<SVGRectElement>) => {
    if (e.pointerType !== 'touch') return;
    const i = nearest(e);
    if (pinned !== null) {
      if (pinned === i) { setPinned(null); setHover(null); tip.hide(); }
      else { setPinned(i); setHover(i); tip.show(e, content(i)); }
    } else { setPinned(i); setHover(i); tip.show(e, content(i)); }
  };
  // End labels only for highlighted series (selective direct labelling).
  const ends = series.filter(s => hl.has(s.id)).map(s => {
    const lastIdx = s.values.reduce<number>((acc, v, i) => (v !== null ? i : acc), -1);
    return lastIdx >= 0 ? { s, i: lastIdx, v: s.values[lastIdx]! } : null;
  }).filter((e): e is { s: LineSeries; i: number; v: number } => !!e);
  return (
    <div ref={ref} className="w-full min-w-0">
      <svg className="block max-w-full" width={width} height={height} role="img" aria-label={yLabel ?? 'Trend chart'}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} className="num" fill="var(--ink-3)">{fmt(t, 0)}</text>
          </g>
        ))}
        {labels.map((l, i) => (labels.length <= 12 || i % 2 === 0) && (
          <text key={i} x={x(i)} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--ink-3)">{typeof l === 'number' ? `W${l}` : l}</text>
        ))}
        {ordered.map(s => (
          <path key={s.id} d={pathFor(s.values)} fill="none" stroke={hl.has(s.id) ? teamColor(s.id) : 'var(--axis)'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {ordered.map(s => s.values.map((v, i) => v !== null && (hl.has(s.id) || hover === i) && (
          <circle key={`${s.id}-${i}`} cx={x(i)} cy={y(v)} r={hl.has(s.id) ? 4 : 3} fill={hl.has(s.id) ? teamColor(s.id) : 'var(--axis)'} stroke="var(--surface)" strokeWidth={2} />
        )))}
        {ends.map(e => (
          <text key={e.s.id} x={x(e.i) + 9} y={y(e.v) + 4} fontSize={12} fontWeight={600} fill="var(--ink)">{e.s.name.length > 13 ? `${e.s.name.slice(0, 12)}…` : e.s.name}</text>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} stroke="var(--ink-3)" strokeWidth={1} />}
        <rect x={pad.l - 10} y={0} width={width - pad.l - pad.r + 20} height={height} fill="transparent" onPointerMove={onMove} onPointerDown={onDown}
          onPointerLeave={() => { if (pinned !== null) return; setHover(null); tip.hide(); }} onPointerCancel={() => { setPinned(null); setHover(null); tip.hide(); }} />
      </svg>
      {tip.node}
    </div>
  );
}

// ─── Grouped bars (≤ 3 series) ──────────────────────────────────────────────

export function GroupedBars({ categories, series, height = 220, format = (v: number) => fmt(v, 2), yLabel }: {
  categories: string[]; series: { key: string; name: string; color: string; values: number[] }[]; height?: number; format?: (v: number) => string; yLabel?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(600);
  const tip = useTooltip();
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const pad = { l: 36, r: 8, t: 12, b: 26 };
  const maxY = Math.max(...series.flatMap(s => s.values), 0.001);
  const ticks = niceTicks(0, maxY, 4, true);
  const band = (width - pad.l - pad.r) / categories.length;
  const barW = Math.min(24, (band * 0.7 - (series.length - 1) * 2) / series.length);
  const groupW = barW * series.length + (series.length - 1) * 2;
  const y = (v: number) => pad.t + (1 - v / (ticks[ticks.length - 1] || maxY)) * (height - pad.t - pad.b);
  const base = y(0);
  const bar = (x0: number, v: number) => {
    const top = y(v), h = Math.max(0, base - top), r = Math.min(4, h, barW / 2);
    return `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + barW - r}Q${x0 + barW},${top} ${x0 + barW},${top + r}V${base}Z`;
  };
  return (
    <div ref={ref} className="w-full min-w-0">
      <svg className="block max-w-full" width={width} height={height} role="img" aria-label={yLabel ?? 'Grouped bar chart'}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} className="num" fill="var(--ink-3)">{fmt(t, t < 10 ? 1 : 0)}</text>
          </g>
        ))}
        {categories.map((c, ci) => {
          const gx = pad.l + ci * band + (band - groupW) / 2;
          return (
            <g key={c}>
              {series.map((s, si) => {
                const key = `${c}:${s.key}`;
                const x0 = gx + si * (barW + 2);
                const content = <div className="space-y-1"><div className="text-ink-3">{c}</div><TipRow color={s.color} label={s.name} value={format(s.values[ci])} line={false} /></div>;
                const down = (e: React.PointerEvent<SVGPathElement>) => {
                  if (e.pointerType !== 'touch') return;
                  if (pinned !== null) {
                    if (pinned === key) { setPinned(null); setHover(null); tip.hide(); return; }
                    setPinned(key); setHover(key); tip.show(e, content); return;
                  }
                  setPinned(key); setHover(key); tip.show(e, content);
                };
                return (
                  <path key={key} d={bar(x0, s.values[ci])} fill={s.color} opacity={hover && hover !== key ? 0.55 : 1}
                    onPointerMove={e => { if (e.pointerType === 'touch' && pinned === null) return; setHover(key); tip.show(e, content); }}
                    onPointerDown={down}
                    onPointerLeave={() => { if (pinned === key) return; setHover(null); tip.hide(); }}
                    onPointerCancel={() => { setPinned(null); setHover(null); tip.hide(); }} />
                );
              })}
              <text x={pad.l + ci * band + band / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--ink-3)">{c}</text>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-4 text-[12px] text-ink-2">
        {series.map(s => <span key={s.key} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.name}</span>)}
      </div>
      {tip.node}
    </div>
  );
}

// ─── Weekly columns (team scoring by week) ──────────────────────────────────

export function WeekColumns({ weeks, color, reference, height = 150, marks }: {
  weeks: { week: number; value: number; label?: string; result?: 'W' | 'L' | 'T' | null }[]; color: string; reference?: number; height?: number; marks?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(400);
  const tip = useTooltip();
  const [pinned, setPinned] = useState<number | null>(null);
  const pad = { l: 34, r: 6, t: 14, b: 24 };
  const maxY = Math.max(...weeks.map(w => w.value), reference ?? 0, 1);
  const ticks = niceTicks(0, maxY, 3, true);
  const top = ticks[ticks.length - 1] || maxY;
  const band = (width - pad.l - pad.r) / Math.max(1, weeks.length);
  const barW = Math.min(24, band - 4);
  const y = (v: number) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const base = y(0);
  const show = (e: React.PointerEvent<Element>, w: { week: number; value: number; label?: string; result?: 'W' | 'L' | 'T' | null }) =>
    tip.show(e, <div><div className="text-ink-3">Week {w.week}{w.result ? ` · ${w.result}` : ''}</div><div className="num font-semibold">{fmt(w.value)} pts</div>{w.label && <div className="text-ink-2">{w.label}</div>}</div>);
  return (
    <div ref={ref} className="w-full min-w-0">
      <svg className="block max-w-full" width={width} height={height} role="img" aria-label="Points by week">
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} className="num" fill="var(--ink-3)">{fmt(t, 0)}</text>
          </g>
        ))}
        {weeks.map((w, i) => {
          const x0 = pad.l + i * band + (band - barW) / 2;
          const t = y(w.value), h = Math.max(0, base - t), r = Math.min(4, h, barW / 2);
          const down = (e: React.PointerEvent<Element>) => {
            if (e.pointerType !== 'touch') return;
            if (pinned !== null) {
              if (pinned === w.week) { setPinned(null); tip.hide(); return; }
              setPinned(w.week); show(e, w); return;
            }
            setPinned(w.week); show(e, w);
          };
          return (
            <g key={w.week} onPointerMove={e => { if (e.pointerType === 'touch' && pinned === null) return; show(e, w); }} onPointerDown={down}
              onPointerLeave={() => { if (pinned === w.week) return; tip.hide(); }} onPointerCancel={() => { setPinned(null); tip.hide(); }}>
              <rect x={pad.l + i * band} y={pad.t} width={band} height={height - pad.t - pad.b} fill="transparent" />
              <path d={`M${x0},${base}V${t + r}Q${x0},${t} ${x0 + r},${t}H${x0 + barW - r}Q${x0 + barW},${t} ${x0 + barW},${t + r}V${base}Z`} fill={color} opacity={w.result === 'L' ? 0.55 : 1} />
              {marks && w.result && <text x={x0 + barW / 2} y={t - 4} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--ink-2)">{w.result}</text>}
              <text x={x0 + barW / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--ink-3)">{w.week}</text>
            </g>
          );
        })}
        {reference !== undefined && <line x1={pad.l} x2={width - pad.r} y1={y(reference)} y2={y(reference)} stroke="var(--ink-3)" strokeWidth={1} />}
      </svg>
      {tip.node}
    </div>
  );
}

// ─── Horizontal bars (single series, value at tip) ──────────────────────────

export function HBars({ rows, color = 'var(--accent)', format = (v: number) => fmt(v, 1), negativeColor = 'var(--bad)' }: {
  rows: { label: ReactNode; value: number; key: string; detail?: ReactNode }[]; color?: string; format?: (v: number) => string; negativeColor?: string;
}) {
  const tip = useTooltip();
  const [pinned, setPinned] = useState<string | null>(null);
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 0.001);
  return (
    <div className="space-y-1.5">
      {rows.map(r => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_auto] items-center gap-2 text-[13px] sm:grid-cols-[minmax(90px,38%)_1fr_auto]"
          onPointerMove={e => { if (e.pointerType === 'touch' && pinned === null) return; if (r.detail) tip.show(e, r.detail); }}
          onPointerDown={e => {
            if (e.pointerType !== 'touch' || !r.detail) return;
            if (pinned !== null) { if (pinned === r.key) { setPinned(null); tip.hide(); return; } setPinned(r.key); tip.show(e, r.detail); return; }
            setPinned(r.key); tip.show(e, r.detail);
          }}
          onPointerLeave={() => { if (pinned === r.key) return; tip.hide(); }}
          onPointerCancel={() => { setPinned(null); tip.hide(); }}>
          <div className="truncate text-ink-2">{r.label}</div>
          <div className="h-3">
            <div className="h-full rounded-r-[4px]" style={{ width: `${(Math.abs(r.value) / max) * 100}%`, minWidth: 2, background: r.value < 0 ? negativeColor : color }} />
          </div>
          <div className="num w-12 text-right font-medium text-ink">{format(r.value)}</div>
        </div>
      ))}
      {tip.node}
    </div>
  );
}

/** Sequential cell (blue ramp) for probabilities; ink flips by luminance. */
export function HeatCell({ value, label }: { value: number; label?: string }) {
  const steps = ['transparent', 'var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)', 'var(--seq-6)', 'var(--seq-7)'];
  const idx = value <= 0.005 ? 0 : Math.min(7, 1 + Math.floor(value * 7));
  return (
    <div className="num flex h-8 items-center justify-center rounded-[6px] text-[12px] font-medium" style={{ background: steps[idx], color: idx === 0 ? 'var(--ink-3)' : idx >= 4 ? '#fff' : '#0b0b0b' }}>
      {label ?? (value <= 0.005 ? '·' : prob(value))}
    </div>
  );
}
