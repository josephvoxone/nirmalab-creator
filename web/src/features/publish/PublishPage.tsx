import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { useSession } from '../../lib/session.js';
import {
  connectionState,
  errorText,
  PLATFORM_LABEL,
  publishApi,
  VISIBILITY_LABEL,
  type Platform,
  type PublisherStatus,
  type PublishResult,
  type StorySummary,
  type Visibility
} from './publishClient.js';

type Api = ReturnType<typeof publishApi>;

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PlatformsCard(props: { api: Api; statuses: PublisherStatus[] | undefined; canEdit: boolean; reload: () => Promise<void>; openUrl: (url: string) => void }) {
  const [busy, setBusy] = useState<Platform | ''>('');
  const [error, setError] = useState('');

  const act = async (platform: Platform, fn: () => Promise<void>) => {
    setBusy(platform);
    setError('');
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  const connect = (p: Platform) => act(p, async () => { props.openUrl((await props.api.connect(p)).url); });
  const disconnect = (p: Platform) => act(p, async () => { await props.api.disconnect(p); await props.reload(); });

  return (
    <section className="card" aria-labelledby="pub-platforms">
      <div className="card-head">
        <div>
          <h2 id="pub-platforms">Platform</h2>
          <span className="muted">Akun tujuan publish.</span>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!props.statuses ? <p className="muted">Memuat…</p> : (
        <ul className="list">
          {props.statuses.map(s => {
            const state = connectionState(s);
            const label = PLATFORM_LABEL[s.platform];
            return (
              <li key={s.platform} className="row" aria-label={label}>
                <div className="row-main">
                  <strong>{label}</strong>
                  {s.accountLabel && <div className="muted">{s.accountLabel}</div>}
                </div>
                <span className={`pill ${state.tone}`}>{state.label}</span>
                {s.connected ? (
                  <button className="btn btn-sm" disabled={!props.canEdit || busy === s.platform} onClick={() => void disconnect(s.platform)}>Putuskan</button>
                ) : (
                  <button className="btn btn-sm" disabled={!props.canEdit || !s.configured || busy === s.platform} onClick={() => void connect(s.platform)}>Hubungkan</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PublishCard(props: { api: Api; statuses: PublisherStatus[] | undefined; canEdit: boolean }) {
  const [stories, setStories] = useState<StorySummary[] | undefined>(undefined);
  const [storyId, setStoryId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('unlisted');
  const [platform, setPlatform] = useState<Platform | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PublishResult | undefined>(undefined);

  const connected = useMemo(() => (props.statuses ?? []).filter(s => s.connected).map(s => s.platform), [props.statuses]);

  useEffect(() => {
    let alive = true;
    props.api.stories().then(r => {
      if (!alive) return;
      const done = r.stories.filter(s => s.status === 'done');
      setStories(done);
      if (done[0]) { setStoryId(done[0].id); setTitle(done[0].title); }
    }, e => alive && setError(errorText(e)));
    return () => { alive = false; };
  }, [props.api]);

  useEffect(() => {
    if (!platform || !connected.includes(platform)) setPlatform(connected[0] ?? '');
  }, [connected, platform]);

  const chooseStory = (id: string) => {
    setStoryId(id);
    setTitle(stories?.find(s => s.id === id)?.title ?? '');
    setResult(undefined);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!platform || !storyId) return;
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      setResult(await props.api.publish(platform, { storyId, title: title.trim(), description, visibility }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const ready = props.canEdit && !!storyId && !!platform && !!title.trim() && !busy;

  return (
    <section className="card" aria-labelledby="pub-story">
      <div className="card-head">
        <div>
          <h2 id="pub-story">Publish video cerita</h2>
          <span className="muted">Kirim video cerita yang sudah selesai.</span>
        </div>
      </div>
      {stories && stories.length === 0 && <p className="empty">Belum ada cerita yang selesai dirender.</p>}
      {props.statuses && connected.length === 0 && <p className="notice">Hubungkan minimal satu platform di atas untuk mulai publish.</p>}
      <form className="stack" onSubmit={e => void submit(e)}>
        <div className="form-row">
          <label className="field">Cerita
            <select value={storyId} onChange={e => chooseStory(e.target.value)} disabled={!stories?.length}>
              {(stories ?? []).map(s => (
                <option key={s.id} value={s.id}>{s.title}{s.video ? ` · ${formatMb(s.video.bytes)}` : ''}</option>
              ))}
            </select>
          </label>
          <label className="field">Platform
            <select value={platform} onChange={e => setPlatform(e.target.value as Platform)} disabled={connected.length === 0}>
              {connected.map(p => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
            </select>
          </label>
        </div>
        <label className="field">Judul
          <input value={title} onChange={e => setTitle(e.target.value)} maxLength={100} />
        </label>
        <label className="field">Deskripsi
          <textarea value={description} onChange={e => setDescription(e.target.value)} />
        </label>
        <label className="field">Visibilitas
          <select value={visibility} onChange={e => setVisibility(e.target.value as Visibility)}>
            {(Object.keys(VISIBILITY_LABEL) as Visibility[]).map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}
          </select>
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        {result && (
          <p className="notice">
            Terkirim ke {PLATFORM_LABEL[result.platform]}.{' '}
            {result.url
              ? <a href={result.url} target="_blank" rel="noreferrer">Lihat <ExternalLink size={12} /></a>
              : result.externalId && <span className="mono">ID {result.externalId}</span>}
          </p>
        )}
        <div className="form-row">
          <button className="btn btn-primary" type="submit" disabled={!ready}>{busy ? 'Mengirim…' : 'Publish'}</button>
        </div>
      </form>
    </section>
  );
}

export default function PublishPage(props: { openUrl?: (url: string) => void }) {
  const { user, fetchImpl } = useSession();
  const api = useMemo(() => publishApi(fetchImpl), [fetchImpl]);
  const [statuses, setStatuses] = useState<PublisherStatus[] | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  const openUrl = props.openUrl ?? ((url: string) => window.location.assign(url));

  const reload = useCallback(async () => {
    try {
      setStatuses((await api.status()).publishers);
      setLoadError('');
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [api]);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <>
      {!user.isAdmin && <p className="notice">Hanya admin yang bisa menghubungkan platform dan publish.</p>}
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      <PlatformsCard api={api} statuses={statuses} canEdit={user.isAdmin} reload={reload} openUrl={openUrl} />
      <PublishCard api={api} statuses={statuses} canEdit={user.isAdmin} />
    </>
  );
}
