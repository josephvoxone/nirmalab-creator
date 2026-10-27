/**
 * Pengaturan › Provider › Model teks (admin): the OpenCode Go key, the model the project assistant
 * tries first, and a connection test. The key is write-only: the field clears after saving and
 * only the last 4 characters ever come back.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { KeyRound, PlugZap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../../lib/session.js';
import { Choice, inputClass } from '../../ui/controls.js';
import { LoadingState, describeError } from '../../ui/states.js';
import { TEXT_MODELS, textKeyText, textModelApi, type TextModelId, type TextModelState, type TextModelTest } from './settingsClient.js';

const OPTIONS = TEXT_MODELS.map(m => ({ value: m.value, label: m.label, hint: m.hint }));

export function TextModelPanel() {
  const { fetchImpl } = useSession();
  const api = useMemo(() => textModelApi(fetchImpl), [fetchImpl]);
  const [state, setState] = useState<TextModelState>();
  const [loadError, setLoadError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'key' | 'model' | 'test'>();
  const [error, setError] = useState('');
  const [result, setResult] = useState<TextModelTest>();
  const [testError, setTestError] = useState('');

  const reload = useCallback(() => setTick(t => t + 1), []);
  useEffect(() => {
    let alive = true;
    setLoadError(undefined);
    api.get().then(s => alive && setState(s), e => alive && setLoadError(e));
    return () => { alive = false; };
  }, [api, tick]);

  const save = async (what: 'key' | 'model', patch: { apiKey?: string; model?: TextModelId }) => {
    setBusy(what);
    setError('');
    try {
      setState(await api.save(patch));
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusy(undefined);
    }
  };
  const submitKey = async (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    if (await save('key', { apiKey: k })) { setKey(''); setResult(undefined); setTestError(''); }
  };
  const test = async () => {
    setBusy('test');
    setResult(undefined);
    setTestError('');
    try { setResult(await api.test()); } catch (e) { setTestError(describeError(e)); } finally { setBusy(undefined); }
  };

  return (
    <section aria-labelledby="prov-text" className="flex flex-col gap-3 border-b pb-5 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id="prov-text" className="text-[14px] font-medium text-foreground">Model teks</h2>
        <p className="text-[12.5px] text-muted-foreground">Dipakai asisten proyek. Langganan OpenCode Go; kalau model pilihan sibuk, otomatis pindah ke model berikutnya (glm-5.3-flash → glm-5.3 → beam-free).</p>
      </div>
      {loadError !== undefined && !state ? (
        <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          <span className="min-w-0 flex-1">Model teks gagal dimuat. {describeError(loadError)}</span>
          <Button size="sm" variant="ghost" onClick={reload}>Coba lagi</Button>
        </div>
      ) : !state ? (
        <LoadingState label="Memuat model teks" className="flex flex-col gap-2">
          <Skeleton className="h-9 w-full rounded-md" /><Skeleton className="h-9 w-full rounded-md" />
        </LoadingState>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[12.5px] text-muted-foreground">
            {state.configured ? textKeyText(state.keyHint) : 'Belum ada key — asisten proyek belum bisa dipakai. Tempel API key OpenCode Go di bawah.'}
          </p>
          <form className="flex items-end gap-2" onSubmit={e => void submitKey(e)}>
            <label className="flex flex-1 flex-col gap-1 text-[12px] text-muted-foreground">{state.configured ? 'Ganti API key OpenCode Go' : 'API key OpenCode Go'}
              <input className={inputClass} type="password" autoComplete="off" spellCheck={false}
                placeholder="sk-…" value={key} onChange={e => setKey(e.target.value)} />
            </label>
            <Button type="submit" size="lg" disabled={busy === 'key' || !key.trim()}><KeyRound /> {busy === 'key' ? 'Menyimpan…' : 'Simpan key'}</Button>
          </form>
          <div className="flex flex-wrap items-center gap-2">
            <Choice label="Model" value={state.model} options={OPTIONS} disabled={busy === 'model'}
              onChange={model => void save('model', { model })} className="w-56 max-w-full" />
            <Button size="sm" variant="glass" disabled={!state.configured || busy === 'test'} onClick={() => void test()}>
              <PlugZap /> {busy === 'test' ? 'Mengetes…' : 'Tes'}
            </Button>
          </div>
          {result && <p role="status" className="text-[12.5px] text-(--success) tabular-nums">Terhubung · {result.model} · {result.ms} ms</p>}
          {testError && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">Tes gagal: {testError}</p>}
          {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}
        </div>
      )}
    </section>
  );
}
