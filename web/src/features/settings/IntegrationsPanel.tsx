/**
 * Pengaturan › Integrasi (admin): personal MCP tokens and a copy-paste setup per client.
 * A new token is shown once: it lives only in this component's state (never localStorage), fills the
 * snippet below while revealed, and "Selesai" drops it for good — the snippet goes back to <TOKEN>.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, ExternalLink, KeyRound, PlugZap, Plus, TriangleAlert } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../../lib/session.js';
import { Segmented, inputClass } from '../../ui/controls.js';
import { LoadingState, describeError } from '../../ui/states.js';
import { del, post, requestJson, type FetchLike } from './http.js';
import { MCP_CLIENTS, snippetFor, type McpClient } from './mcpSnippets.js';
import { relativeTime } from './settingsClient.js';

export type McpToken = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
export type CreatedMcpToken = { id: string; name: string; token: string };
export type McpTest = { ok: boolean; tools: number; user?: string };

export const MAX_MCP_TOKENS = 10;
const MAX_NAME = 40;

export function mcpApi(fetchImpl: FetchLike) {
  return {
    list: async () => {
      const r = await requestJson<unknown>(fetchImpl, '/api/mcp/tokens');
      // A broken answer is an error to retry, never "no tokens" (that would hide live tokens).
      if (!Array.isArray(r)) throw new Error('Jawaban server tidak terbaca.');
      return r as McpToken[];
    },
    create: (name: string) => requestJson<CreatedMcpToken>(fetchImpl, '/api/mcp/tokens', post({ name })),
    revoke: (id: string) => requestJson<{ ok: boolean }>(fetchImpl, `/api/mcp/tokens/${encodeURIComponent(id)}`, del()),
    test: (token?: string) => requestJson<McpTest>(fetchImpl, '/api/mcp/test', post(token ? { token } : {}))
  };
}

const when = (iso: string | null) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? relativeTime(ms) : 'Belum pernah';
};

/** Clipboard API first; on http origins or older browsers, a temporary off-screen selection. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the selection fallback */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
}

/** `what` names the thing copied, so two copy buttons side by side have distinct names. */
function CopyButton(props: { text: string; what: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => { setState('idle'); }, [props.text]);
  const label = state === 'ok' ? `${props.what[0]!.toUpperCase()}${props.what.slice(1)} tersalin` : state === 'fail' ? `Salin ${props.what} manual` : `Salin ${props.what}`;
  return (
    <Button type="button" size="sm" variant="glass" aria-label={label}
      onClick={() => { void copyText(props.text).then(ok => setState(ok ? 'ok' : 'fail')); }}>
      {state === 'ok' ? <Check /> : <Copy />} {state === 'ok' ? 'Tersalin' : state === 'fail' ? 'Salin manual' : 'Salin'}
    </Button>
  );
}

function CodeBlock(props: { label: string; text: string; what: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <pre aria-label={props.label} className="glass-well max-h-64 overflow-auto rounded-md bg-muted px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-foreground [scrollbar-width:thin]">
        <code>{props.text}</code>
      </pre>
      <div><CopyButton text={props.text} what={props.what} /></div>
    </div>
  );
}

const alertClass = 'rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive';

export function IntegrationsPanel() {
  const { fetchImpl } = useSession();
  const api = useMemo(() => mcpApi(fetchImpl), [fetchImpl]);
  const [tokens, setTokens] = useState<McpToken[]>();
  const [loadError, setLoadError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  // One flag per action: a test finishing never re-enables "Buat" while a create is still out (and so on).
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState<CreatedMcpToken>();
  const [confirm, setConfirm] = useState<McpToken>();
  const [client, setClient] = useState<McpClient>('claude-code');
  const [result, setResult] = useState<McpTest>();
  const [testError, setTestError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => setTick(t => t + 1), []);
  useEffect(() => {
    let alive = true;
    setLoadError(undefined);
    api.list().then(list => alive && setTokens(list), e => alive && setLoadError(e));
    return () => { alive = false; };
  }, [api, tick]);
  useEffect(() => { if (formOpen) nameRef.current?.focus(); }, [formOpen]);

  const full = (tokens?.length ?? 0) >= MAX_MCP_TOKENS;
  const url = `${window.location.origin}/mcp`;
  const snippet = snippetFor(client, url, revealed?.token);
  const clientLabel = MCP_CLIENTS.find(c => c.id === client)?.label ?? client;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setCreating(true);
    setError('');
    try {
      const created = await api.create(n);
      setRevealed(created);
      setResult(undefined);
      setTestError('');
      setName('');
      setFormOpen(false);
      setTokens(list => [...(list ?? []), { id: created.id, name: created.name, createdAt: new Date().toISOString(), lastUsedAt: null }]);
      reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCreating(false);
    }
  };

  const done = () => {
    setRevealed(undefined);
    setResult(undefined);
    setTestError('');
  };

  const revoke = async (token: McpToken) => {
    setRevoking(true);
    setError('');
    try {
      await api.revoke(token.id);
      setTokens(list => list?.filter(t => t.id !== token.id));
      if (revealed?.id === token.id) done();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRevoking(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(undefined);
    setTestError('');
    try { setResult(await api.test(revealed?.token)); } catch (err) { setTestError(describeError(err)); } finally { setTesting(false); }
  };
  // A create/revoke error belongs to that attempt: opening or cancelling the form starts clean.
  const openForm = () => { setError(''); setFormOpen(true); };
  const closeForm = () => { setError(''); setFormOpen(false); setName(''); };

  const createButton = (
    <Button size="sm" variant="glass" disabled={full || formOpen} onClick={openForm}><Plus /> Buat token</Button>
  );

  return (
    <>
      <section aria-labelledby="int-tokens" className="flex flex-col gap-3 border-b pb-5 last:border-b-0 last:pb-0">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id="int-tokens" className="text-[14px] font-medium text-foreground">Token MCP</h2>
            <p className="text-[12.5px] text-muted-foreground">Hubungkan Claude, Cursor, OpenCode atau Codex ke proyekmu lewat MCP. Asisten di luar app memakai aksi yang sama dengan chat proyek — biaya tetap butuh persetujuanmu.</p>
          </div>
          {tokens && tokens.length > 0 && <div className="ml-auto flex shrink-0 items-center gap-1.5">{createButton}</div>}
        </div>

        {loadError !== undefined && !tokens ? (
          <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
            <span className="min-w-0 flex-1">Token gagal dimuat. {describeError(loadError)}</span>
            <Button size="sm" variant="ghost" onClick={reload}>Coba lagi</Button>
          </div>
        ) : !tokens ? (
          <LoadingState label="Memuat token" className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full rounded-md" /><Skeleton className="h-10 w-full rounded-md" />
          </LoadingState>
        ) : tokens.length === 0 && !formOpen && !revealed ? (
          <div className="glass-panel flex flex-col items-start gap-2 rounded-md px-4 py-5">
            <h3 className="text-[13px] font-medium">Belum ada token</h3>
            <span className="text-[12.5px] text-muted-foreground">Dengan token pribadi, klien MCP masuk sebagai kamu tanpa password. Satu token per perangkat atau klien; bisa dicabut kapan saja.</span>
            {createButton}
          </div>
        ) : (
          <>
            {loadError !== undefined && (
              <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">
                <span className="min-w-0 flex-1">Daftar token gagal diperbarui. {describeError(loadError)}</span>
                <Button size="sm" variant="ghost" onClick={reload}>Coba lagi</Button>
              </div>
            )}
            {tokens.length > 0 && (
              <ul className="flex flex-col">
                {tokens.map(t => (
                  <li key={t.id} aria-label={t.name} className="flex items-center gap-3 border-b border-border/60 py-2.5 last:border-b-0">
                    <KeyRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px] text-foreground">{t.name}</span>
                      <span className="text-[12px] text-muted-foreground">Dibuat {when(t.createdAt)} · Terakhir dipakai {when(t.lastUsedAt)}</span>
                    </div>
                    <Button size="sm" variant="ghost" className="ml-auto shrink-0" aria-label={`Cabut ${t.name}`} disabled={revoking} onClick={() => setConfirm(t)}>Cabut</Button>
                  </li>
                ))}
              </ul>
            )}
            {full && <p className="text-[12px] text-muted-foreground">Maksimal 10 token per akun. Cabut yang tidak dipakai lagi untuk membuat yang baru.</p>}
          </>
        )}

        {formOpen && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={e => void create(e)}>
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-[12px] text-muted-foreground">Nama token
              <input ref={nameRef} className={inputClass} maxLength={MAX_NAME} autoComplete="off"
                placeholder="mis. Claude Code di laptop" value={name} onChange={e => setName(e.target.value)} />
            </label>
            <Button type="submit" size="lg" disabled={creating || !name.trim()}>{creating ? 'Membuat…' : 'Buat'}</Button>
            <Button type="button" size="lg" variant="ghost" onClick={closeForm}>Batal</Button>
          </form>
        )}

        {revealed && (
          <div role="region" aria-label="Token baru" className="glass-panel flex flex-col gap-2 rounded-md px-3 py-3">
            <span className="text-[12px] text-muted-foreground">Token baru · {revealed.name}</span>
            <code className="block overflow-x-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[12.5px] break-all text-foreground">{revealed.token}</code>
            <p className="flex items-center gap-1.5 text-[12.5px] text-(--warning)">
              <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />Token ini hanya ditampilkan sekali. Simpan sekarang.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton text={revealed.token} what="token" />
              <Button size="sm" onClick={done}>Selesai</Button>
            </div>
          </div>
        )}

        {error && <p role="alert" className={alertClass}>{error}</p>}
      </section>

      <section aria-labelledby="int-setup" className="flex flex-col gap-3 border-b pb-5 last:border-b-0 last:pb-0">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="int-setup" className="text-[14px] font-medium text-foreground">Pasang di klien</h2>
          <p className="text-[12.5px] text-muted-foreground">
            {revealed ? 'Perintah di bawah sudah berisi token barumu — salin sebelum menekan Selesai.' : 'Ganti <TOKEN> dengan token yang kamu simpan saat membuatnya.'}
          </p>
        </div>
        <Segmented name="Klien" value={client} options={MCP_CLIENTS.map(c => ({ value: c.id, label: c.label }))} onChange={setClient} className="max-w-full self-start overflow-x-auto" />
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-[12.5px] text-foreground/90 marker:text-muted-foreground">
          {snippet.steps.map(s => <li key={s}>{s}</li>)}
        </ol>
        {snippet.file && <p className="text-[12px] text-muted-foreground">File: <span className="font-mono text-foreground/90">{snippet.file}</span></p>}
        <CodeBlock label={`Konfigurasi ${clientLabel}`} text={snippet.text} what="konfigurasi" />
        {snippet.extra && <>
          <span className="text-[12px] text-muted-foreground">{snippet.extra.label}</span>
          <CodeBlock label={snippet.extra.label} text={snippet.extra.text} what="variabel token" />
        </>}
        <div className="flex flex-wrap items-center gap-2">
          <a href={snippet.docUrl} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline [&_svg]:size-3.5">
            Dokumentasi resmi {clientLabel} <ExternalLink aria-hidden="true" />
          </a>
          <Button size="sm" variant="glass" className="ml-auto" disabled={testing} onClick={() => void test()}>
            <PlugZap /> {testing ? 'Mengetes…' : 'Tes koneksi'}
          </Button>
        </div>
        {result && <p role="status" className="text-[12.5px] text-(--success) tabular-nums">Terhubung · {result.tools} tools</p>}
        {testError && <p role="alert" className={alertClass}>Tes gagal: {testError}</p>}
      </section>

      <AlertDialog open={!!confirm} onOpenChange={o => { if (!o) setConfirm(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cabut token {confirm?.name ?? ''}?</AlertDialogTitle>
            <AlertDialogDescription>Klien yang memakainya langsung terputus.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Batal</AlertDialogCancel>
            <AlertDialogAction size="sm" variant="destructive" onClick={() => { const t = confirm; setConfirm(undefined); if (t) void revoke(t); }}>Cabut</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
