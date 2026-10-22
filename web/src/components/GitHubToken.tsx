import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { checkToken, getToken, githubRepo, setToken, subscribeToken, tokenHelpUrl } from '../lib/github.ts';
import { Button, cx } from './ui.tsx';

/** The GitHub token the static site starts jobs with (ESPN claims, league builds), kept in this browser. */
export const useToken = () => useSyncExternalStore(subscribeToken, getToken, () => null);

/** Says what the saved token is missing, without starting anything. */
export function TokenCheck({ auto = false }: { auto?: boolean }) {
  const [state, setState] = useState<{ ok: boolean; message: string } | 'checking' | null>(null);
  const run = () => { setState('checking'); checkToken().then(setState, (error: Error) => setState({ ok: false, message: error.message })); };
  useEffect(() => { if (auto) run(); }, [auto]);
  return (
    <span className="mt-2 block">
      <Button size="sm" onClick={run} disabled={state === 'checking'}>{state === 'checking' ? 'Checking…' : 'Check token'}</Button>
      {state && state !== 'checking' && <span className={cx('mt-1.5 block text-[12px] leading-relaxed', state.ok ? 'text-good-ink' : 'text-bad-ink')}>{state.message}</span>}
    </span>
  );
}

/** One-time setup on the static site: a fine-grained token that can run this repository's Actions. */
export function TokenSetup({ intro }: { intro: ReactNode }) {
  const [value, setValue] = useState('');
  const valid = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(value.trim());
  return (
    <div className="space-y-3 text-[13px] text-ink-2">
      <p>{intro} That needs a GitHub token, once per device:</p>
      <ol className="list-decimal space-y-1 pl-5 text-[12px]">
        <li>Open <a href={tokenHelpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline hover:text-ink">a new fine-grained token on GitHub<ExternalLink size={11} aria-hidden /></a>.</li>
        <li>Resource owner: <b>{githubRepo.split('/')[0]}</b>. Repository access: <b>Only select repositories</b> → <b>{githubRepo.split('/')[1] ?? githubRepo}</b> (not “Public repositories”, which is read-only).</li>
        <li>Permissions → Repository permissions → <b>Actions</b> → change it to <b>Read and write</b>.</li>
        <li>Generate it, copy it, and paste it here.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <input type="password" autoComplete="off" spellCheck={false} value={value} onChange={e => setValue(e.target.value)} placeholder="github_pat_…" aria-label="GitHub token"
          className="h-9 min-w-0 flex-1 rounded-[9px] border border-line-strong bg-surface px-3 font-mono text-[16px] placeholder:text-ink-3" />
        <Button variant="primary" onClick={() => setToken(value)} disabled={!valid}>Save token</Button>
      </div>
      <p className="text-[11px] text-ink-3">Kept only in this browser. It can run and cancel Actions on {githubRepo} and nothing else.</p>
    </div>
  );
}
