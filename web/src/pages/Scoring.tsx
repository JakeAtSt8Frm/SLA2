import { useApp } from '../lib/context.tsx';
import { fmt, slotLabel } from '../lib/format.ts';
import { Card, CardHeader, PageHeader, Pos } from '../components/ui.tsx';

const GROUPS: { title: string; match: (k: string) => boolean }[] = [
  { title: 'Passing', match: k => k.startsWith('pass_') },
  { title: 'Rushing', match: k => k.startsWith('rush_') },
  { title: 'Receiving', match: k => k === 'rec' || k.startsWith('rec_') || k.startsWith('bonus_rec') },
  { title: 'IDP tackles', match: k => k === 'idp_tkl_solo' || k === 'idp_tkl_ast' || k === 'idp_tkl' },
  { title: 'IDP big plays', match: k => k.startsWith('idp_') },
  { title: 'Kicking', match: k => k.startsWith('fgm') || k.startsWith('fgmiss') || k.startsWith('xp') },
  { title: 'Team defense & special teams', match: k => /^(pts_allow|yds_allow|sack|int|ff|fum_rec|safe|blk_kick|def_|st_)/.test(k) },
  { title: 'Other', match: () => true },
];

const LABELS: Record<string, string> = {
  pass_yd: 'Passing yard', pass_td: 'Passing TD', pass_int: 'Interception thrown', pass_2pt: 'Passing 2-pt',
  rush_yd: 'Rushing yard', rush_td: 'Rushing TD', rush_2pt: 'Rushing 2-pt', rec: 'Reception', rec_yd: 'Receiving yard', rec_td: 'Receiving TD', rec_2pt: 'Receiving 2-pt',
  bonus_rec_te: 'TE reception bonus', fum_lost: 'Fumble lost', fum_rec_td: 'Fumble recovery TD', idp_tkl_solo: 'Solo tackle', idp_tkl_ast: 'Assisted tackle',
  idp_sack: 'Sack', idp_int: 'Interception', idp_pass_def: 'Pass defended', idp_ff: 'Forced fumble', idp_fum_rec: 'Fumble recovery', idp_tkl_loss: 'Tackle for loss',
  idp_qb_hit: 'QB hit', idp_def_td: 'Defensive TD', idp_safe: 'Safety', idp_blk_kick: 'Blocked kick',
  fgm_0_19: 'FG 0–19 yd', fgm_20_29: 'FG 20–29 yd', fgm_30_39: 'FG 30–39 yd', fgm_40_49: 'FG 40–49 yd', fgm_50p: 'FG 50+ yd', fgmiss: 'FG missed', xpm: 'Extra point', xpmiss: 'Extra point missed',
};

export default function ScoringPage() {
  const { boot } = useApp();
  const scoring = boot.league.scoring as Record<string, number>;
  const entries = Object.entries(scoring);
  const used = new Set<string>();
  const groups = GROUPS.map(g => {
    const rows = entries.filter(([k]) => !used.has(k) && g.match(k));
    rows.forEach(([k]) => used.add(k));
    return { ...g, rows };
  }).filter(g => g.rows.length);
  const counts = boot.league.rosterPositions.reduce<Record<string, number>>((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {});
  const hasDef = boot.league.slots.includes('DEF');
  const s = (k: string) => scoring[k] ?? 0;
  const equivalents = [
    s('idp_sack') && s('rush_yd') ? `A sack (${fmt(s('idp_sack'), 1)}) is worth ${fmt(s('idp_sack') / s('rush_yd'), 0)} rushing yards.` : null,
    s('idp_int') && s('pass_td') ? `An IDP interception (${fmt(s('idp_int'), 1)}) outscores a ${fmt(s('pass_td'), 0)}-point passing touchdown.` : null,
    s('idp_tkl_solo') && s('rec') ? `A solo tackle (${fmt(s('idp_tkl_solo'), 1)}) is worth ${fmt(s('idp_tkl_solo') / s('rec'), 0)} receptions.` : null,
    s('bonus_rec_te') ? `Tight ends get ${fmt(s('rec') + s('bonus_rec_te'), 1)} per catch (TE premium +${fmt(s('bonus_rec_te'), 1)}).` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-5">
      <PageHeader title="Scoring rules" subtitle={`${entries.length} nonzero rules read live from Sleeper. Every projection, value and simulation in the app is computed with exactly these numbers; Sleeper’s PPR totals are never used.`} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Starting lineup" subtitle={`${boot.league.slots.length} starters · ${counts.BN ?? 0} bench · ${boot.league.reserveSlots} IR · ${boot.league.taxiSlots} taxi`} />
            <div className="flex flex-wrap gap-1.5">
              {boot.league.slots.map((slot, i) => <span key={i} className="inline-flex h-7 items-center rounded-[7px] border border-line bg-surface-2 px-2 text-[12px] font-semibold">{['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'].includes(slot) ? <Pos pos={slot} /> : slotLabel(slot)}</span>)}
            </div>
          </Card>
          {equivalents.length > 0 && (
            <Card>
              <CardHeader title="What makes this league different" />
              <ul className="space-y-2 text-[14px]">{equivalents.map(e => <li key={e} className="flex gap-2"><span className="text-ink-3">•</span>{e}</li>)}</ul>
            </Card>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {groups.map(g => (
            <Card key={g.title} className={g.title.startsWith('Team defense') && !hasDef ? 'opacity-60' : undefined}>
              <CardHeader title={g.title} subtitle={g.title.startsWith('Team defense') && !hasDef ? 'No team DEF slot, so these never score' : undefined} />
              <div className="divide-y divide-[var(--line)]">
                {g.rows.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 py-1.5 text-[13px]">
                    <span className="text-ink-2">{LABELS[k] ?? k}</span>
                    <span className={`num font-semibold ${v < 0 ? 'text-bad-ink' : ''}`}>{v > 0 ? '+' : ''}{fmt(v, Math.abs(v) < 1 && v !== 0 ? 2 : 1)}</span>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
