/**
 * Pengaturan › Provider › API key pool (admin): up to 10 keys per provider, used round-robin. A key is
 * write-only: the field clears after saving and only the last 4 characters come back. A rate-limited key
 * rests by itself and the call moves to the next one.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { KeyRound, PlugZap, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../../lib/session.js';
import { Segmented, inputClass } from '../../ui/controls.js';
import { LoadingState, describeError } from '../../ui/states.js';
import { MAX_POOL_KEYS, STATE_LABEL, creditsText, keyPoolApi, stateDetail, type KeyPools, type KeyTest, type PoolKeyView, type PoolProviderId } from './keyPoolClient.js';

const COPY: Record<PoolProviderId, { title: string; id: string; blurb: string; placeholder: string }> = {
  elevenlabs: { title: 'ElevenLabs — dubbing', id: 'pool-elevenlabs', blurb: 'Suara dubbing per shot atau scene. Beberapa key dipakai bergantian (round-robin) agar pekerjaan banyak user tidak antre di satu akun.', placeholder: 'sk_…' },
  gemini: { title: 'Gemini — model teks', id: 'pool-gemini', blurb: 'Model teks cadangan/utama untuk asisten dan draft. Beberapa key dipakai bergantian; kalau satu kena batas, pindah ke key berikutnya.', placeholder: 'AIza…' }
};
const TONE: Record<PoolKeyView['state'], string> = { ready: 'text-(--success)', busy: 'text-foreground', cooldown: 'text-muted-foreground', invalid: 'text-destructive' };

export function KeyPoolPanel(props: { provider: PoolProviderId }) {
  const { provider } = props;
  const copy = COPY[provider];
  const { fetchImpl } = useSession();
  const api = useMemo(() => keyPoolApi(fetchImpl), [fetchImpl]);
  const [pools, setPools] = useState<KeyPools>();
  const [loadError, setLoadError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [tests, setTests] = useState<Record<string, KeyTest | string>>({});
  const [model, setModel] = useState('');

  const reload = useCallback(() => setTick(t => t + 1), []);
  useEffect(() => {
    let alive = true;
    setLoadError(undefined);
    api.get().then(p => { if (alive) { setPools(p); setModel(p.gemini.geminiModel ?? ''); } }, e => alive && setLoadError(e));
    return () => { alive = false; };
  }, [api, tick]);

  const list = pools?.[provider].keys ?? [];
  const full = list.length >= MAX_POOL_KEYS;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    setBusy('add'); setError(''); setNote('');
    try {
      const r = await api.add(provider, k, label.trim());
      setKey(''); setLabel('');
      setNote(r.verified ? (r.limited ? 'Key ditambahkan (izin terbatas: sisa kredit tidak terbaca).' : 'Key ditambahkan dan terverifikasi.') : `Key ditambahkan, tapi belum bisa diverifikasi (${r.detail ?? 'provider tidak merespons'}).`);
      reload();
    } catch (err) { setError(describeError(err)); } finally { setBusy(undefined); }
  };
  const remove = async (k: PoolKeyView) => {
    setBusy(`rm:${k.id}`); setError(''); setNote('');
    try { await api.remove(provider, k.id); reload(); } catch (err) { setError(describeError(err)); } finally { setBusy(undefined); }
  };
  const test = async (k: PoolKeyView) => {
    setBusy(`test:${k.id}`);
    try { const r = await api.test(provider, k.id); setTests(t => ({ ...t, [k.id]: r })); } catch (err) { setTests(t => ({ ...t, [k.id]: describeError(err) })); } finally { setBusy(undefined); }
  };
  const route = async (patch: Parameters<typeof api.setRouting>[0]) => {
    setBusy('route'); setError('');
    try { await api.setRouting(patch); reload(); } catch (err) { setError(describeError(err)); } finally { setBusy(undefined); }
  };

  return (
    <section aria-labelledby={copy.id} className="flex flex-col gap-3 border-b pb-5 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h2 id={copy.id} className="text-[14px] font-medium text-foreground">{copy.title}</h2>
          {pools && <span className="text-[12px] text-muted-foreground tabular-nums">{list.length}/{MAX_POOL_KEYS} key</span>}
        </div>
        <p className="text-[12.5px] text-muted-foreground">{copy.blurb}</p>
      </div>
      {loadError !== undefined && !pools ? (
        <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          <span className="min-w-0 flex-1">Daftar key gagal dimuat. {describeError(loadError)}</span>
          <Button size="sm" variant="ghost" onClick={reload}>Coba lagi</Button>
        </div>
      ) : !pools ? (
        <LoadingState label={`Memuat key ${provider}`} className="flex flex-col gap-2"><Skeleton className="h-9 w-full rounded-md" /><Skeleton className="h-9 w-full rounded-md" /></LoadingState>
      ) : (
        <div className="flex flex-col gap-3">
          {list.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">Belum ada key. Tempel API key {provider === 'elevenlabs' ? 'ElevenLabs' : 'Gemini'} di bawah.</p>
          ) : (
            <ul aria-label={`Key ${provider}`} className="flex flex-col">
              {list.map(k => {
                const t = tests[k.id];
                return (
                  <li key={k.id} aria-label={k.label} className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0">
                    <div className="flex items-center gap-2">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-[13px] text-foreground">{k.label}</span>
                          <span className="font-mono text-[12px] text-muted-foreground">{k.keyHint}</span>
                          <Badge variant="secondary" className={cn('h-4.5 px-1.5 text-[11px] font-normal', TONE[k.state])}>{STATE_LABEL[k.state]}</Badge>
                          {k.source === 'env' && <Badge variant="secondary" className="h-4.5 px-1.5 text-[11px] font-normal text-muted-foreground">dari server</Badge>}
                        </div>
                        <span className="text-[12px] text-muted-foreground">{stateDetail(k)}</span>
                      </div>
                      <Button size="sm" variant="glass" disabled={busy === `test:${k.id}`} onClick={() => void test(k)} aria-label={`Tes key ${k.label}`}><PlugZap /> {busy === `test:${k.id}` ? 'Mengetes…' : 'Tes'}</Button>
                      {k.source === 'store' && <Button size="sm" variant="ghost" disabled={busy === `rm:${k.id}`} onClick={() => void remove(k)} aria-label={`Hapus key ${k.label}`}><Trash2 /></Button>}
                    </div>
                    {t && (typeof t === 'string' || !t.ok
                      ? <p role="alert" className="text-[12px] text-destructive">Tes gagal: {typeof t === 'string' ? t : t.reason}</p>
                      : <p role="status" className="text-[12px] text-(--success) tabular-nums">{creditsText(t)}</p>)}
                  </li>
                );
              })}
            </ul>
          )}
          <form className="flex flex-wrap items-end gap-2" onSubmit={e => void add(e)}>
            <label className="flex min-w-52 flex-1 flex-col gap-1 text-[12px] text-muted-foreground">API key
              <input className={inputClass} type="password" autoComplete="off" spellCheck={false} placeholder={copy.placeholder} value={key} disabled={full} onChange={e => setKey(e.target.value)} />
            </label>
            <label className="flex w-40 flex-col gap-1 text-[12px] text-muted-foreground">Nama (opsional)
              <input className={inputClass} type="text" autoComplete="off" placeholder="Akun 2" value={label} disabled={full} onChange={e => setLabel(e.target.value)} />
            </label>
            <Button type="submit" size="lg" disabled={full || busy === 'add' || !key.trim()}><KeyRound /> {busy === 'add' ? 'Memeriksa…' : 'Tambah key'}</Button>
          </form>
          {full && <p className="text-[12px] text-muted-foreground">Sudah {MAX_POOL_KEYS} key (maksimal). Hapus satu untuk menambah.</p>}
          {provider === 'gemini' && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1 text-[12px] text-muted-foreground">Model teks utama
                <Segmented name="Model teks utama" value={pools.gemini.primary} disabled={busy === 'route'}
                  options={[{ value: 'opencode-go', label: 'OpenCode Go', hint: 'Gemini jadi cadangan' }, { value: 'gemini', label: 'Gemini', hint: 'OpenCode Go jadi cadangan' }]}
                  onChange={primary => void route({ primary })} />
              </div>
              <form className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); void route({ geminiModel: model.trim() || null }); }}>
                <label className="flex w-48 flex-col gap-1 text-[12px] text-muted-foreground">Nama model Gemini
                  <input className={inputClass} type="text" autoComplete="off" spellCheck={false} placeholder="gemini-3.8-flash" value={model} onChange={e => setModel(e.target.value)} />
                </label>
                <Button type="submit" size="lg" variant="glass" disabled={busy === 'route' || model.trim() === (pools.gemini.geminiModel ?? '')}>Simpan model</Button>
              </form>
            </div>
          )}
          {note && <p role="status" className="text-[12.5px] text-(--success)">{note}</p>}
          {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}
        </div>
      )}
    </section>
  );
}
