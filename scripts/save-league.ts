/**
 * Saves or removes a Sleeper league in config/sleeper.json, for the Deploy workflow's save_league /
 * forget_league inputs (started from the app's league switcher). Writes the commit message to the
 * step's outputs; the workflow commits the file.
 *
 * Usage: SAVE_LEAGUE=<id> node scripts/save-league.ts   |   FORGET_LEAGUE=<id> node scripts/save-league.ts
 */
import { appendFile } from 'node:fs/promises';
import { DEFAULT_LEAGUE, isSleeperId, savedLeagues, updateSaved } from '../server/saved-leagues.ts';

const save = (process.env.SAVE_LEAGUE ?? '').trim();
const forget = (process.env.FORGET_LEAGUE ?? '').trim();
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();

function fail(message: string): never {
  // The app shows the build's failure; the annotation says why on GitHub.
  console.error(`::error title=SLA league::${message}`);
  process.exit(1);
}

let message: string;
if (save) {
  if (!isSleeperId(save)) fail(`"${save}" isn't a Sleeper league ID.`);
  if (save === DEFAULT_LEAGUE) fail('That is the default league; it is always built.');
  const res = await fetch(`https://api.sleeper.app/v1/league/${save}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (res?.status === 404) fail('Sleeper has no league with this ID.');
  if (!res?.ok) fail(`Sleeper didn't answer (${res?.status ?? 'no connection'}). Try again.`);
  const league = await res.json() as { name?: unknown; sport?: unknown } | null;
  if (!league) fail('Sleeper has no league with this ID.');
  if (league.sport !== 'nfl') fail('Only NFL leagues can be saved.');
  const name = oneLine(typeof league.name === 'string' ? league.name : '') || save;
  await updateSaved({ save: { id: save, name } });
  message = `Save league ${name} (${save})`;
} else if (forget) {
  if (!isSleeperId(forget)) fail(`"${forget}" isn't a Sleeper league ID.`);
  const name = savedLeagues().find(l => l.id === forget)?.name;
  await updateSaved({ forget });
  message = `Remove saved league ${name ? `${name} (${forget})` : forget}`;
} else {
  fail('Set SAVE_LEAGUE or FORGET_LEAGUE.');
}

console.log(message);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `message=${message}\n`);
