import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import { INJURY_SHORT, posLabel, teamColor } from '../lib/format.ts';
import { usePlatform } from '../lib/context.tsx';
import { useApp } from '../lib/context.tsx';
import { navigate, pathFor } from '../lib/router.ts';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Card({ children, className, pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  return <section className={cx('card', pad && 'p-4 sm:p-5', className)}>{children}</section>;
}

export function CardHeader({ title, subtitle, right, icon }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-ink">{icon}{title}</h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, right, eyebrow }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink sm:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-[14px] text-ink-2">{subtitle}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </header>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className={cx('mt-0.5 text-[22px] font-semibold leading-tight tracking-tight', tone === 'good' ? 'text-good-ink' : tone === 'bad' ? 'text-bad-ink' : 'text-ink')}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{sub}</div>}
    </div>
  );
}

export function Button({ children, onClick, variant = 'secondary', size = 'md', disabled, type = 'button', className, title }: {
  children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md'; disabled?: boolean; type?: 'button' | 'submit'; className?: string; title?: string;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-[9px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-[14px]',
        variant === 'primary' && 'bg-ink text-page hover:opacity-90',
        variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string | number>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full overflow-x-auto rounded-[10px] border border-line bg-surface-2 p-0.5 scroll-thin">
      {options.map(o => (
        <button
          key={String(o.value)}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx('h-7 shrink-0 whitespace-nowrap rounded-[8px] px-2.5 text-[13px] font-medium transition-colors', o.value === value ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string; className?: string }) {
  return (
    <label className={cx('relative inline-flex items-center', className)}>
      <span className="sr-only">{label}</span>
      <select
        value={String(value)}
        onChange={e => {
          const raw = e.target.value;
          const match = options.find(o => String(o.value) === raw);
          if (match) onChange(match.value);
        }}
        className="h-9 w-full appearance-none rounded-[9px] border border-line-strong bg-surface pl-3 pr-8 text-[14px] text-ink hover:bg-surface-2"
      >
        {options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
      <svg className="pointer-events-none absolute right-2.5 h-4 w-4 text-ink-3" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </label>
  );
}

const POS_TINT: Record<string, string> = { QB: 'var(--team-8)', RB: 'var(--team-3)', WR: 'var(--team-1)', TE: 'var(--team-4)', K: 'var(--ink-3)', DL: 'var(--team-2)', LB: 'var(--team-7)', DB: 'var(--team-5)', DEF: 'var(--ink-3)' };
/** Position chip: tinted wash with ink text (text never wears the data colour). */
export function Pos({ pos, className }: { pos: string; className?: string }) {
  const tint = POS_TINT[pos] ?? 'var(--ink-3)';
  const platform = usePlatform();
  return (
    <span className={cx('inline-flex h-[18px] min-w-[26px] shrink-0 items-center justify-center rounded-[5px] px-1 text-[10px] font-bold tracking-wide text-ink', className)}
      style={{ background: `color-mix(in oklab, ${tint} 22%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tint} 38%, transparent)` }}>
      {posLabel(pos, platform ?? undefined)}
    </span>
  );
}

/**
 * SLA 1.0 rank pill: position rank by season total or by points per game, washed on the
 * red → yellow → green scale by where the rank falls in the position pool. The number is
 * always printed, so colour only reinforces it.
 */
export function RankPill({ rank, kind }: { rank: { rank: number; outOf: number } | null | undefined; kind: 'Total' | 'PPG' }) {
  if (!rank) return null;
  const t = 1 - Math.min(1, rank.rank / Math.max(1, rank.outOf));
  const hue = t < 0.5
    ? `color-mix(in oklab, var(--ryg-low) ${Math.round((1 - t * 2) * 100)}%, var(--ryg-mid))`
    : `color-mix(in oklab, var(--ryg-mid) ${Math.round((1 - (t - 0.5) * 2) * 100)}%, var(--ryg-high))`;
  return (
    <span title={`Position rank ${rank.rank} of ${rank.outOf} by ${kind === 'PPG' ? 'points per game' : 'total points'}`}
      className="num inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-[5px] px-1.5 text-[10px] font-semibold text-ink"
      style={{ background: `color-mix(in oklab, ${hue} 38%, var(--surface))` }}>
      #{rank.rank}<span className="font-medium text-ink-2">{kind === 'PPG' ? 'PPG' : 'Tot'}</span>
    </span>
  );
}

export function Ranks({ ranks }: { ranks: { total: { rank: number; outOf: number } | null; ppg: { rank: number; outOf: number } | null } | null | undefined }) {
  if (!ranks) return null;
  return <><RankPill rank={ranks.total} kind="Total" /><RankPill rank={ranks.ppg} kind="PPG" /></>;
}

export function TeamDot({ rosterId, size = 10 }: { rosterId: number | null | undefined; size?: number }) {
  return <span aria-hidden className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: teamColor(rosterId) }} />;
}

export function TeamAvatar({ rosterId, size = 28 }: { rosterId: number; size?: number }) {
  const { teams } = useApp();
  const t = teams.get(rosterId);
  const [failed, setFailed] = useState(false);
  const initials = (t?.name ?? '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-bold text-ink"
      style={{ width: size, height: size, background: `color-mix(in oklab, ${teamColor(rosterId)} 25%, var(--surface-2))`, boxShadow: `0 0 0 2px ${teamColor(rosterId)}` }}>
      {t?.avatar && !failed ? <img src={t.avatar} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} /> : initials}
    </span>
  );
}

export function TeamLink({ rosterId, showAvatar = false, className }: { rosterId: number | null | undefined; showAvatar?: boolean; className?: string }) {
  const { leagueId, teamName, myTeamId } = useApp();
  if (!rosterId) return <span className="text-ink-3">Free agent</span>;
  return (
    <a
      href={pathFor(leagueId, 'team', rosterId)}
      onClick={e => { e.preventDefault(); navigate(pathFor(leagueId, 'team', rosterId)); }}
      className={cx('inline-flex min-w-0 items-center gap-2 hover:underline', rosterId === myTeamId && 'font-semibold', className)}
    >
      {showAvatar ? <TeamAvatar rosterId={rosterId} size={22} /> : <TeamDot rosterId={rosterId} />}
      <span className="truncate">{teamName(rosterId)}</span>
    </a>
  );
}

export function PlayerLink({ id, name, className }: { id: string; name: string; className?: string }) {
  const { openPlayer } = useApp();
  return (
    <button onClick={() => openPlayer(id)} className={cx('min-w-0 truncate text-left font-medium text-ink hover:underline', className)}>{name}</button>
  );
}

export function Injury({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const severe = ['Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR', 'NFI', 'COV'].includes(status);
  const color = severe ? 'var(--bad)' : status === 'Doubtful' ? 'var(--serious)' : 'var(--warn)';
  return (
    <span title={status} className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[10px] font-bold text-ink"
      style={{ background: `color-mix(in oklab, ${color} 20%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 45%, transparent)` }}>
      <CircleAlert size={10} aria-hidden style={{ color }} />
      {INJURY_SHORT[status] ?? status}
    </span>
  );
}

export function Delta({ value, digits = 1, suffix = '', className }: { value: number | null | undefined; digits?: number; suffix?: string; className?: string }) {
  if (value === null || value === undefined) return <span className="text-ink-3">—</span>;
  const up = value > 0.0001, down = value < -0.0001;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cx('num inline-flex items-center gap-0.5 font-medium', up ? 'text-good-ink' : down ? 'text-bad-ink' : 'text-ink-3', className)}>
      {(up || down) && <Icon size={13} aria-hidden />}
      {up ? '+' : down ? '−' : ''}{Math.abs(value).toFixed(digits)}{suffix}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} />;
}

export function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-9 w-64" />
      <div className="grid gap-4 md:grid-cols-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-28" />)}</div>
      <Skeleton className="h-72" />
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Card className="flex flex-col items-center gap-3 py-10 text-center">
      <AlertTriangle className="text-bad" aria-hidden />
      <div>
        <div className="font-semibold">Something went wrong</div>
        <div className="mt-1 max-w-md text-[13px] text-ink-2">{error instanceof Error ? error.message : 'Unexpected error.'}</div>
      </div>
      {onRetry && <Button onClick={onRetry}><RefreshCw size={14} /> Try again</Button>}
    </Card>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <span className="text-ink-3">{icon ?? <Inbox aria-hidden />}</span>
      <div className="font-semibold">{title}</div>
      {children && <div className="max-w-md text-[13px] text-ink-2">{children}</div>}
    </div>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <div className={cx('flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[13px]', tone === 'warn' ? 'border-[color-mix(in_oklab,var(--warn)_45%,transparent)] bg-[color-mix(in_oklab,var(--warn)_10%,transparent)] text-ink' : 'border-line bg-surface-2 text-ink-2')}>
      {tone === 'warn' ? <AlertTriangle size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} aria-hidden /> : <CircleAlert size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />}
      <div>{children}</div>
    </div>
  );
}

/** Small horizontal meter (0–1). The unfilled track is a lighter step of the same hue. */
export function Meter({ value, color = 'var(--accent)', className, label }: { value: number; color?: string; className?: string; label?: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label} className={cx('h-1.5 w-full overflow-hidden rounded-full', className)} style={{ background: `color-mix(in oklab, ${color} 18%, transparent)` }}>
      <div className="h-full rounded-full" style={{ width: `${v * 100}%`, background: color }} />
    </div>
  );
}

/** Pointer-following tooltip rendered in a portal. */
export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const node = tip ? createPortal(
    <div role="tooltip" className="pointer-events-none fixed z-[100] max-w-[280px] rounded-[10px] border border-line-strong bg-surface px-3 py-2 text-[12px] text-ink shadow-lg fade-in"
      style={{ left: Math.min(tip.x + 14, window.innerWidth - 290), top: Math.max(8, tip.y - 12) }}>
      {tip.content}
    </div>, document.body) : null;
  return { show: (e: { clientX: number; clientY: number }, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content }), hide: () => setTip(null), node };
}

export function InfoTip({ children }: { children: ReactNode }) {
  const t = useTooltip();
  return (
    <>
      <button type="button" aria-label="More info" className="inline-flex h-4 w-4 items-center justify-center rounded-full text-ink-3 hover:text-ink"
        onMouseEnter={e => t.show(e, children)} onMouseMove={e => t.show(e, children)} onMouseLeave={t.hide} onFocus={e => { const r = e.currentTarget.getBoundingClientRect(); t.show({ clientX: r.right, clientY: r.bottom + 20 }, children); }} onBlur={t.hide}>
        <CircleAlert size={13} aria-hidden />
      </button>
      {t.node}
    </>
  );
}

/** Sticky-header, horizontally scrollable table container. */
export function TableWrap({ children, maxHeight }: { children: ReactNode; maxHeight?: number }) {
  return <div className="overflow-auto scroll-thin" style={{ maxHeight }}>{children}</div>;
}

export function useSort<T>(rows: T[], initial: { key: string; dir: 'asc' | 'desc' }, accessors: Record<string, (row: T) => number | string | null | undefined>) {
  const [sort, setSort] = useState(initial);
  const get = accessors[sort.key];
  const sorted = get ? [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const c = x < y ? -1 : 1;
    return sort.dir === 'asc' ? c : -c;
  }) : rows;
  const header = (key: string, label: ReactNode, className?: string) => (
    <th className={className} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
        {label}{sort.key === key && <span aria-hidden>{sort.dir === 'desc' ? '↓' : '↑'}</span>}
      </button>
    </th>
  );
  return { sorted, header, sort };
}

/** Keep keyboard focus inside an open dialog and restore it when the dialog closes. */
export function useEscape(onClose: () => void, active = true) {
  const ref = useRef(onClose);
  const dialog = useRef<HTMLDivElement>(null);
  ref.current = onClose;
  useEffect(() => {
    const panel = dialog.current;
    if (!active || !panel) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => [...panel.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
      .filter(el => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getClientRects().length > 0);
    (focusable()[0] ?? panel).focus();
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); ref.current(); }
      if (e.key !== 'Tab') return;
      const targets = focusable();
      const first = targets[0] ?? panel, last = targets.at(-1) ?? panel;
      const focused = document.activeElement;
      if (e.shiftKey && (focused === first || !panel.contains(focused))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (focused === last || !panel.contains(focused) || !targets.length)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => {
      window.removeEventListener('keydown', h);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [active]);
  return dialog;
}
