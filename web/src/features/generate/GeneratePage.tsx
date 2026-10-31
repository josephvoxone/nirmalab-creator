import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Copy, Download, Mic, PenLine, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../../lib/session.js';
import { Choice, Segmented, Steps, textareaClass } from '../../ui/controls.js';
import { describeError } from '../../ui/states.js';
import { fileName, formatBytes, generateApi, mediaSrc, VOICES, type GeneratedFile } from './generateClient.js';
import { SCRIPT_KINDS, buildScriptRequest, estimateSeconds, toSpeech, wordCount, type ScriptKind } from './scriptTemplates.js';

type Api = ReturnType<typeof generateApi>;

const STEPS = ['Naskah', 'Suara', 'Pakai'];
const AUTO = '__auto__';

/* ---------- small building blocks ---------- */

function Panel(props: { label: string; children: ReactNode }) {
  return <section aria-label={props.label} className="glass-panel flex flex-col gap-3 rounded-lg p-4">{props.children}</section>;
}

/** A label tied to its textarea by id, with an optional line under it. */
function TextBox(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; footer?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12px] text-muted-foreground">{props.label}</label>
      <textarea id={id} value={props.value} rows={props.rows ?? 4} placeholder={props.placeholder}
        onChange={e => props.onChange(e.target.value)} className={textareaClass} />
      {props.footer && <div className="text-[11.5px] text-muted-foreground">{props.footer}</div>}
    </div>
  );
}

/** "± 42 dtk · 105 kata", with a warning past a minute (the cap for short video). */
function Length(props: { text: string }) {
  const secs = estimateSeconds(props.text);
  return (
    <span className={cn('tabular-nums', secs > 60 && 'text-(--warning,#e5a50a)')}>
      ± {secs} dtk dibacakan · {wordCount(props.text)} kata{secs > 60 ? ' · lebih dari 60 dtk, potong agar muat di video pendek' : ''}
    </span>
  );
}

function Failed(props: { title: string; error: unknown; onRetry: () => void; busy: boolean }) {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
      <span className="min-w-0 flex-1"><b className="font-medium">{props.title}.</b> {describeError(props.error)}</span>
      <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onRetry}><RotateCcw /> Coba lagi</Button>
    </div>
  );
}

function CopyButton(props: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [props.text]);
  return (
    <Button type="button" size="sm" variant="glass" disabled={!props.text.trim()} onClick={() => {
      void navigator.clipboard?.writeText(props.text).then(() => setCopied(true), () => undefined);
    }}>
      {copied ? <Check /> : <Copy />} {copied ? 'Tersalin' : props.label}
    </Button>
  );
}

/** One request at a time; the last one can be retried as-is. */
function useAction<T>() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [last, setLast] = useState<() => Promise<T>>();
  const run = useCallback(async (fn: () => Promise<T>): Promise<T | undefined> => {
    setLast(() => fn);
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError(e ?? new Error('Terjadi kesalahan'));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, retry: () => (last ? run(last) : Promise.resolve(undefined)) };
}

function useModels(api: Api) {
  const [models, setModels] = useState<string[]>();
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    api.models().then(r => { if (alive) setModels(r.models); }, () => { if (alive) { setModels([]); setFailed(true); } });
    return () => { alive = false; };
  }, [api, tick]);
  return { models, failed, reload: () => { setModels(undefined); setTick(t => t + 1); } };
}

/** The voice-over: a player and a download when the server serves the file; otherwise what was saved. */
function VoiceFile(props: { file: GeneratedFile }) {
  const src = mediaSrc(props.file);
  const name = fileName(props.file.filePath);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2.5">
      {src && <audio controls src={src} className="h-9 w-full" />}
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span className="min-w-0 truncate font-mono text-foreground/80">{name}</span>
        <span>{formatBytes(props.file.bytes)}</span>
        {src && (
          <a href={src} download={name} className={cn(buttonVariants({ variant: 'glass', size: 'sm' }), 'ml-auto')}>
            <Download /> Unduh MP3
          </a>
        )}
      </div>
      {!src && <p className="text-[12px] text-muted-foreground">Tersimpan di server. Pemutar belum tersedia karena server belum menyajikan file ini.</p>}
    </div>
  );
}

/* ---------- page ---------- */

export default function GeneratePage() {
  const { user, fetchImpl } = useSession();
  const api = useMemo(() => generateApi(fetchImpl), [fetchImpl]);
  const navigate = useNavigate();
  const canGenerate = user.isAdmin;
  const { models, failed: modelsFailed, reload: reloadModels } = useModels(api);

  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<ScriptKind>('narasi');
  const [topic, setTopic] = useState('');
  const [model, setModel] = useState(AUTO);
  const [script, setScript] = useState<string>();
  const [usedModel, setUsedModel] = useState('');
  const [carried, setCarried] = useState<string>();
  const [voiceText, setVoiceText] = useState('');
  const [voice, setVoice] = useState(VOICES[0]!.id);
  const [audio, setAudio] = useState<{ file: GeneratedFile; text: string }>();
  const textAction = useAction<{ text: string; model: string }>();
  const ttsAction = useAction<GeneratedFile>();

  const kindInfo = SCRIPT_KINDS.find(k => k.value === kind)!;
  const modelOptions = useMemo(() => [{ value: AUTO, label: 'Otomatis' }, ...(models ?? []).map(m => ({ value: m, label: m }))], [models]);

  const gotScript = (out: { text: string; model: string } | undefined) => {
    if (out) { setScript(out.text.trim()); setUsedModel(out.model); }
  };
  const writeScript = async () => {
    const request = { ...buildScriptRequest(kind, topic), ...(model !== AUTO ? { model } : {}) };
    gotScript(await textAction.run(() => api.text(request)));
  };

  /** Carry the script into step 2, unless it hasn't changed since the last carry (keeps voice edits). */
  const toVoice = () => {
    if (script !== undefined && script !== carried) {
      setVoiceText(toSpeech(script));
      setCarried(script);
    }
    setStep(1);
  };

  const makeVoice = async () => {
    const text = voiceText.trim();
    const out = await ttsAction.run(() => api.tts({ text, voice }));
    if (out) setAudio({ file: out, text });
  };
  const retryVoice = async () => {
    const out = await ttsAction.retry();
    if (out) setAudio({ file: out, text: voiceText.trim() });
  };

  const finalText = voiceText.trim() || script?.trim() || '';
  const startOver = () => {
    setTopic(''); setScript(undefined); setCarried(undefined); setVoiceText(''); setAudio(undefined); setStep(0);
  };

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-3 pt-2 text-[13px]">
      <p className="text-[13px] text-muted-foreground">Tulis narasi atau caption untuk video faceless atau video cerita, lalu jadikan voice-over — gratis.</p>
      <Steps label="Langkah" steps={STEPS} current={step} onStep={setStep} />

      {!canGenerate && (
        <p role="note" className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[12.5px] text-muted-foreground">
          Hanya admin yang bisa membuat naskah dan suara. Kamu tetap bisa melihat alurnya dan menyalin teks; minta admin bila perlu dibuatkan.
        </p>
      )}

      {step === 0 && (
        <Panel label="Langkah 1: Naskah">
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-muted-foreground">Jenis</span>
            <Segmented<ScriptKind> name="Jenis" value={kind} onChange={setKind} className="flex-wrap self-start"
              options={SCRIPT_KINDS.map(k => ({ value: k.value, label: k.label }))} />
            <span className="text-[11.5px] text-muted-foreground">{kindInfo.hint}</span>
          </div>

          <TextBox label="Topik / ide" value={topic} onChange={setTopic} rows={3} placeholder={kindInfo.placeholder} />

          <div className="flex flex-wrap items-end gap-2">
            {models === undefined ? (
              <div role="status" aria-label="Memuat daftar model" className="flex flex-col gap-1">
                <span className="text-[12px] text-muted-foreground">Model</span>
                <Skeleton className="h-8 w-44 rounded-md" />
              </div>
            ) : (
              <Choice label="Model" showLabel value={model} onChange={setModel} options={modelOptions} className="min-w-44" />
            )}
            <Button variant="glass" data-strong="" className="ml-auto" disabled={!canGenerate || !topic.trim() || textAction.busy} onClick={() => void writeScript()}>
              <PenLine /> {textAction.busy ? 'Menulis…' : 'Tulis naskah'}
            </Button>
          </div>
          {modelsFailed && (
            <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
              Daftar model gagal dimuat — Otomatis tetap bisa dipakai.
              <Button size="xs" variant="ghost" onClick={reloadModels}>Muat ulang model</Button>
            </p>
          )}

          {textAction.error !== undefined && !textAction.busy && (
            <Failed title="Naskah gagal dibuat" error={textAction.error} busy={textAction.busy} onRetry={() => void textAction.retry().then(gotScript)} />
          )}

          {script === undefined ? (
            textAction.busy ? (
              <div role="status" aria-label="Menulis naskah" className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" />
              </div>
            ) : (
              <div className="flex flex-col items-start gap-1.5 rounded-md border border-dashed border-border/70 px-3 py-3">
                <span className="text-[12.5px] text-muted-foreground">Belum ada naskah. Isi topik lalu tekan Tulis naskah.</span>
                <Button size="sm" variant="ghost" onClick={() => setStep(1)}>Sudah punya naskah? Langsung ke suara <ArrowRight /></Button>
              </div>
            )
          ) : (
            <div className="flex flex-col gap-2">
              <TextBox label="Naskah" value={script} onChange={setScript} rows={8}
                footer={<><Length text={script} />{usedModel && <> · model <span className="font-mono">{usedModel}</span></>}</>} />
              <div className="flex flex-wrap items-center gap-1.5">
                <CopyButton text={script} label="Salin" />
                <Button size="sm" variant="ghost" disabled={!canGenerate || !topic.trim() || textAction.busy} onClick={() => void writeScript()}>
                  <RotateCcw /> Ulangi
                </Button>
                <Button size="sm" variant="glass" data-strong="" className="ml-auto" disabled={!script.trim()} onClick={toVoice}>
                  Lanjut ke suara <ArrowRight />
                </Button>
              </div>
            </div>
          )}
        </Panel>
      )}

      {step === 1 && (
        <Panel label="Langkah 2: Suara">
          <TextBox label="Teks untuk dibacakan" value={voiceText} onChange={setVoiceText} rows={8}
            placeholder="Tempel atau tulis teks yang akan dibacakan." footer={<Length text={voiceText} />} />
          <div className="flex flex-wrap items-end gap-2">
            <Choice label="Suara" showLabel value={voice} onChange={setVoice} options={VOICES.map(v => ({ value: v.id, label: v.label }))} className="min-w-44" />
            <Button variant="glass" data-strong="" className="ml-auto" disabled={!canGenerate || !voiceText.trim() || ttsAction.busy} onClick={() => void makeVoice()}>
              <Mic /> {ttsAction.busy ? 'Membuat suara…' : 'Buat suara'}
            </Button>
          </div>

          {ttsAction.error !== undefined && !ttsAction.busy && (
            <Failed title="Suara gagal dibuat" error={ttsAction.error} busy={ttsAction.busy} onRetry={() => void retryVoice()} />
          )}
          {ttsAction.busy && !audio && (
            <div role="status" aria-label="Membuat suara"><Skeleton className="h-14 w-full rounded-md" /></div>
          )}
          {audio && (
            <div className="flex flex-col gap-1">
              <VoiceFile file={audio.file} />
              {audio.text !== voiceText.trim() && <span className="text-[11.5px] text-muted-foreground">Teks sudah diubah sejak suara ini dibuat — tekan Buat suara lagi bila perlu.</span>}
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <span className="text-[11.5px] text-muted-foreground">Suara boleh dilewati; naskahnya tetap bisa dipakai.</span>
            <Button size="sm" variant="glass" className="ml-auto" disabled={!voiceText.trim()} onClick={() => setStep(2)}>Lanjut <ArrowRight /></Button>
          </div>
        </Panel>
      )}

      {step === 2 && (
        <Panel label="Langkah 3: Pakai naskah">
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-muted-foreground">Naskah akhir</span>
            <p className="max-h-64 overflow-y-auto rounded-md border border-border/60 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-foreground">{finalText}</p>
            <span className="text-[11.5px] text-muted-foreground"><Length text={finalText} /></span>
          </div>
          {audio && <VoiceFile file={audio.file} />}
          <p className="text-[12px] text-muted-foreground">Jadikan video cerita membuka Buat baru dengan naskah ini sebagai premis; visualnya dibuat di Studio lewat Google Flow.</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="glass" data-strong="" disabled={!finalText} onClick={() => navigate('/?prompt=' + encodeURIComponent(finalText))}>
              Jadikan video cerita <ArrowRight />
            </Button>
            <CopyButton text={finalText} label="Salin naskah" />
            <Button size="sm" variant="ghost" className="ml-auto" onClick={startOver}>Buat naskah lain</Button>
          </div>
        </Panel>
      )}
    </div>
  );
}
