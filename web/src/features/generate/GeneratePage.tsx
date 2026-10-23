import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { useSession } from '../../lib/session.js';
import { errorText, fileName, formatBytes, generateApi, mediaSrc, VOICES, type GeneratedFile } from './generateClient.js';

type Api = ReturnType<typeof generateApi>;

function Card(props: { id: string; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="card" aria-labelledby={props.id}>
      <div className="card-head">
        <div>
          <h2 id={props.id}>{props.title}</h2>
          <span className="muted">{props.hint}</span>
        </div>
      </div>
      {props.children}
    </section>
  );
}

function useAction<T>() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<T | undefined>(undefined);
  const run = async (fn: () => Promise<T>) => {
    setBusy(true);
    setError('');
    try {
      setResult(await fn());
    } catch (e) {
      setResult(undefined);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, result, run };
}

function CopyButton(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="btn btn-sm" onClick={() => {
      void navigator.clipboard?.writeText(props.text).then(() => setCopied(true), () => undefined);
    }}>
      {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Tersalin' : 'Salin'}
    </button>
  );
}

function Submit(props: { label: string; busy: boolean; disabled: boolean }) {
  return (
    <div className="form-row">
      <button className="btn btn-primary" type="submit" disabled={props.disabled || props.busy}>
        {props.busy ? 'Membuat…' : props.label}
      </button>
    </div>
  );
}

/** A generated file: the player/preview when the server serves it, otherwise just what was saved. */
function SavedFile(props: { file: GeneratedFile; children?: ReactNode }) {
  const src = mediaSrc(props.file);
  return (
    <div className="list">
      {src && <div className="row">{props.children}</div>}
      <div className="row">
        <div className="row-main"><span className="mono">{fileName(props.file.filePath)}</span></div>
        <span className="muted">{formatBytes(props.file.bytes)}</span>
      </div>
      {!src && <p className="notice">Tersimpan di server. Pratinjau belum tersedia karena server belum menyajikan file ini.</p>}
    </div>
  );
}

function TextCard(props: { api: Api; disabled: boolean }) {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const action = useAction<{ text: string; model: string }>();

  useEffect(() => {
    let alive = true;
    props.api.models().then(r => alive && setModels(r.models), () => undefined);
    return () => { alive = false; };
  }, [props.api]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(() => props.api.text({ prompt, model: model || undefined }));
  };

  return (
    <Card id="gen-text" title="Teks" hint="Naskah, hook atau caption dari LLM.">
      <form className="stack" onSubmit={submit}>
        <label className="field">Model
          <select value={model} onChange={e => setModel(e.target.value)}>
            <option value="">Otomatis</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="field">Prompt
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} />
        </label>
        {action.error && <p className="form-error" role="alert">{action.error}</p>}
        <Submit label="Buat teks" busy={action.busy} disabled={props.disabled || !prompt.trim()} />
      </form>
      {action.result && (
        <div className="list">
          <div className="row">
            <div className="row-main"><span className="muted">Model <span className="mono">{action.result.model}</span></span></div>
            <CopyButton text={action.result.text} />
          </div>
          <div className="row"><p className="generated-text">{action.result.text}</p></div>
        </div>
      )}
    </Card>
  );
}

function VoiceCard(props: { api: Api; disabled: boolean }) {
  const [text, setText] = useState('');
  const [voice, setVoice] = useState(VOICES[0]!.id);
  const action = useAction<GeneratedFile>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(() => props.api.tts({ text, voice }));
  };
  return (
    <Card id="gen-voice" title="Suara" hint="Teks menjadi voice-over.">
      <form className="stack" onSubmit={submit}>
        <label className="field">Suara
          <select value={voice} onChange={e => setVoice(e.target.value)}>
            {VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </label>
        <label className="field">Teks
          <textarea value={text} onChange={e => setText(e.target.value)} />
        </label>
        {action.error && <p className="form-error" role="alert">{action.error}</p>}
        <Submit label="Buat suara" busy={action.busy} disabled={props.disabled || !text.trim()} />
      </form>
      {action.result && (
        <SavedFile file={action.result}>
          <audio controls src={mediaSrc(action.result)} className="generated-media" />
        </SavedFile>
      )}
    </Card>
  );
}

function ImageCard(props: { api: Api; disabled: boolean }) {
  const [prompt, setPrompt] = useState('');
  const [shown, setShown] = useState('');
  const action = useAction<GeneratedFile>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setShown(prompt);
    void action.run(() => props.api.image(prompt));
  };
  return (
    <Card id="gen-image" title="Gambar" hint="Gambar dari deskripsi.">
      <form className="stack" onSubmit={submit}>
        <label className="field">Prompt
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} />
        </label>
        {action.error && <p className="form-error" role="alert">{action.error}</p>}
        <Submit label="Buat gambar" busy={action.busy} disabled={props.disabled || !prompt.trim()} />
      </form>
      {action.result && (
        <SavedFile file={action.result}>
          <img src={mediaSrc(action.result)} alt={shown} className="generated-media" />
        </SavedFile>
      )}
    </Card>
  );
}

export default function GeneratePage() {
  const { user, fetchImpl } = useSession();
  const api = useMemo(() => generateApi(fetchImpl), [fetchImpl]);
  const disabled = !user.isAdmin;
  return (
    <>
      {disabled && <p className="notice">Hanya admin yang bisa generate.</p>}
      <TextCard api={api} disabled={disabled} />
      <VoiceCard api={api} disabled={disabled} />
      <ImageCard api={api} disabled={disabled} />
    </>
  );
}
