/**
 * End-to-end smoke test against a running server: every endpoint must answer 200 with the
 * fields the UI relies on. Usage: node scripts/smoke.ts [baseUrl] [leagueId…]
 * With no league given, every configured league (Sleeper and ESPN) is checked.
 */
type Check = [path: string, validate: (body: Record<string, unknown>) => string | null];
const has = (...keys: string[]) => (b: Record<string, unknown>) => keys.find(k => !(k in b)) ?? null;
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const listed = process.argv.slice(3);
const leagues = listed.length ? listed : (await (await fetch(`${base}/api/leagues`)).json() as { id: string }[]).map(l => l.id);

let failed = 0;
for (const league of leagues) {
  console.log(`\n── ${league}`);
  failed += await smoke(league);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);

async function smoke(league: string): Promise<number> {
  const boot = await (await fetch(`${base}/api/leagues/${league}/bootstrap`)).json() as { teams: { rosterId: number }[]; league: { week: number | null } };
  const rid = boot.teams[0]?.rosterId ?? 1;
  const checks: Check[] = [
    ['/api/health', has('ok')],
    [`/api/leagues/${league}/model`, has('meta', 'holdout2025')],
    [`/api/leagues/${league}/defense`, has('groups', 'seasons')],
    [`/api/leagues/${league}/bootstrap`, has('league', 'teams', 'model')],
    [`/api/leagues/${league}/overview`, has('standings', 'matchups', 'awards')],
    [`/api/leagues/${league}/power`, has('rankings', 'season', 'history')],
    [`/api/leagues/${league}/playoffs`, b => (Array.isArray(b.teams) && b.teams.length ? null : 'teams')],
    [`/api/leagues/${league}/matchups`, has('games', 'week')],
    [`/api/leagues/${league}/matchups?week=1`, has('games')],
    [`/api/leagues/${league}/teams/${rid}`, has('team', 'roster', 'outlook')],
    [`/api/leagues/${league}/teams/${rid}/lineup`, has('week')],
    [`/api/leagues/${league}/teams/${rid}/waivers`, has('week')],
    [`/api/leagues/${league}/players`, b => (Array.isArray(b.players) && (b.players as unknown[]).length > 100 ? null : 'players')],
    [`/api/leagues/${league}/recap`, has('awards', 'weekly')],
    [`/api/leagues/${league}/history`, has('seasons', 'allTime')],
    [`/api/leagues/${league}/transactions`, has('transactions')],
    [`/api/leagues/${league}/tracking`, has('weeks')],
  ];

  let failed = 0;
  for (const [path, validate] of checks) {
    const t = Date.now();
    try {
      const res = await fetch(`${base}${path}`);
      const body = await res.json() as Record<string, unknown>;
      const problem = res.ok ? validate(body) : `HTTP ${res.status}: ${String(body.error)}`;
      if (problem) { failed++; console.log(`✗ ${path} — missing/invalid: ${problem}`); }
      else console.log(`✓ ${path} (${Date.now() - t} ms)`);
    } catch (error) {
      failed++;
      console.log(`✗ ${path} — ${(error as Error).message}`);
    }
  }
  const player = await (await fetch(`${base}/api/leagues/${league}/players`)).json() as { players: { id: string; owner: number | null }[] };
  const pid = player.players[0]?.id;
  const detail = await fetch(`${base}/api/leagues/${league}/players/${pid}`);
  console.log(`${detail.ok ? '✓' : '✗'} player detail ${pid}`);
  if (!detail.ok) failed++;
  const mine = player.players.filter(p => p.owner === rid).slice(0, 1).map(p => p.id);
  const theirs = player.players.filter(p => p.owner !== null && p.owner !== rid);
  const other = theirs[0];
  if (mine.length && other) {
    const res = await fetch(`${base}/api/leagues/${league}/trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: rid, b: other.owner, aGives: mine, bGives: [other.id] }) });
    console.log(`${res.ok ? '✓' : '✗'} trade analysis`);
    if (!res.ok) failed++;
  }
  return failed;
}

export {};
