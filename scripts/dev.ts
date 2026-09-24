/** Runs the API (with reload on change) and the Vite dev server together. */
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['--watch-path=server', '--watch-path=engine', '--watch-path=model', 'server/index.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
const stop = () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', code => { if (code) { console.error('process exited', code); stop(); } });
