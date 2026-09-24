import { Hono, type Context } from 'hono';
import { compress } from 'hono/compress';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getCore } from './league.ts';
import { findLeagues } from './sleeper.ts';
import { recordSnapshot, trackRecord } from './snapshots.ts';
import * as views from './views.ts';
import { HttpError } from './views.ts';

export const DEFAULT_LEAGUE = process.env.SLA_DEFAULT_LEAGUE ?? '1312656463549726720';
const PORT = Number(process.env.PORT ?? 8787);
const DIST = path.resolve(import.meta.dirname, '..', 'dist');

const app = new Hono();
app.use('/api/*', compress());

const leagueId = (c: Context) => {
  const id = c.req.param('id') ?? '';
  if (!/^\d{10,22}$/.test(id)) throw new HttpError(400, 'Enter a valid Sleeper league ID.');
  return id;
};
const rosterId = (c: Context) => {
  const n = Number(c.req.param('rid'));
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid team.');
  return n;
};
const json = (c: Context, data: unknown, maxAge = 30) => {
  c.header('Cache-Control', `private, max-age=${maxAge}`);
  return c.json(data as object);
};

app.get('/api/health', c => c.json({ ok: true, service: 'sla2', time: new Date().toISOString() }));
app.get('/api/model', c => json(c, views.model(), 300));
app.get('/api/leagues/:id/bootstrap', async c => {
  const id = leagueId(c);
  const data = await views.bootstrap(id);
  void getCore(id).then(recordSnapshot).catch(() => undefined);
  return json(c, data);
});
app.get('/api/leagues/:id/overview', async c => json(c, await views.overview(leagueId(c))));
app.get('/api/leagues/:id/power', async c => json(c, await views.powerView(leagueId(c))));
app.get('/api/leagues/:id/playoffs', async c => json(c, await views.playoffs(leagueId(c))));
app.get('/api/leagues/:id/matchups', async c => {
  const week = c.req.query('week');
  const w = week ? Number(week) : undefined;
  if (w !== undefined && (!Number.isInteger(w) || w < 1 || w > 18)) throw new HttpError(400, 'Week must be 1–18.');
  return json(c, await views.matchups(leagueId(c), w));
});
app.get('/api/leagues/:id/teams/:rid', async c => json(c, await views.team(leagueId(c), rosterId(c))));
app.get('/api/leagues/:id/teams/:rid/lineup', async c => json(c, await views.lineup(leagueId(c), rosterId(c)), 15));
app.get('/api/leagues/:id/teams/:rid/waivers', async c => json(c, await views.waivers(leagueId(c), rosterId(c))));
app.get('/api/leagues/:id/players', async c => json(c, await views.players(leagueId(c)), 60));
app.get('/api/leagues/:id/players/:pid', async c => {
  const pid = c.req.param('pid');
  if (!/^[A-Za-z0-9_]{1,12}$/.test(pid)) throw new HttpError(400, 'Invalid player.');
  return json(c, await views.player(leagueId(c), pid));
});
app.post('/api/leagues/:id/trade', async c => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid trade.');
  const b = body as Record<string, unknown>;
  return json(c, await views.trade(leagueId(c), { a: Number(b.a), b: Number(b.b), aGives: (b.aGives ?? []) as string[], bGives: (b.bGives ?? []) as string[] }), 0);
});
app.get('/api/leagues/:id/history', async c => json(c, await views.history(leagueId(c)), 300));
app.get('/api/leagues/:id/recap', async c => json(c, await views.recap(leagueId(c)), 60));
app.get('/api/leagues/:id/transactions', async c => json(c, await views.transactions(leagueId(c)), 60));
app.get('/api/leagues/:id/tracking', async c => json(c, await trackRecord(await getCore(leagueId(c))), 300));
app.get('/api/users/:username/leagues', async c => {
  const username = c.req.param('username');
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(username)) throw new HttpError(400, 'Enter a Sleeper username.');
  return json(c, await findLeagues(username), 300);
});
app.all('/api/*', () => { throw new HttpError(404, 'Not found'); });

app.onError((error, c) => {
  if (error instanceof HttpError) return c.json({ error: error.message }, error.status as 400);
  const message = error instanceof Error ? error.message : String(error);
  console.error('[api]', c.req.path, message);
  if ((error as { status?: number }).status === 404 || /League not found/.test(message)) {
    const what = c.req.path.startsWith('/api/users/') ? 'Sleeper user not found. Check the username.' : 'League not found. Check the Sleeper league ID.';
    return c.json({ error: what }, 404);
  }
  if (/Only NFL/.test(message)) return c.json({ error: message }, 400);
  return c.json({ error: 'Could not load league data from Sleeper. Try again in a moment.' }, 502);
});

// Production: serve the built SPA with long-lived hashed assets.
if (existsSync(DIST)) {
  app.use('/assets/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), DIST) || '.' }));
  const index = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  app.get('*', c => c.html(index));
}

serve({ fetch: app.fetch, port: PORT, hostname: process.env.HOST ?? '127.0.0.1' }, info => {
  console.log(`SLA 2.0 API listening on http://${info.address}:${info.port}`);
  // Warm the default league so the first page load is instant.
  const t = Date.now();
  getCore(DEFAULT_LEAGUE).then(core => {
    console.log(`warmed ${core.league.name} in ${Date.now() - t} ms (${core.relevant.length} players, weeks ${core.horizon[0] ?? '-'}–${core.horizon.at(-1) ?? '-'})`);
    return recordSnapshot(core);
  }).catch(error => console.warn('warmup failed:', (error as Error).message));
});
