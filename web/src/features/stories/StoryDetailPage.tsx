import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Palette, BookOpenText, Clapperboard, Download, Film, Image as ImageIcon, Loader2, RefreshCw, RotateCcw, Save, Trash2, UserRound, UsersRound } from 'lucide-react';
import { ApiError } from '../../lib/api.js';
import { ErrorState, LoadingState, Skel, describeError } from '../../ui/states.js';
import { FlowCanvas } from './FlowCanvas.js';
import { buildGraph, type FlowNode } from './flowGraph.js';
import { useSession } from '../../lib/session.js';
import { DEFAULT_LOOK, readSetup, setShotSetup, useCatalog, type Catalog, type Look } from './catalog.js';
import { LookChips } from './LookChips.js';
import { CREDITS_PER_SHOT, STATUS_LABEL, doneCount, formatMB, isActive, storiesApi, type Story, type Storyboard, type StoryboardShot } from './storiesClient.js';
import './studio.css';

type Api = ReturnType<typeof storiesApi>;

const castName = (token: string, spec: unknown) =>
  spec && typeof spec === 'object' && 'name' in spec ? String((spec as { name: string }).name) : token.charAt(0) + token.slice(1).toLowerCase();
const castLook = (spec: unknown) => (typeof spec === 'string' ? spec : spec && typeof spec === 'object' && 'look' in spec ? String((spec as { look: string }).look) : '');

function ShotCard(props: {
  api: Api; story: Story; shot: StoryboardShot; index: number; catalog?: Catalog; editable: boolean; busy: boolean;
  onRedraw: (shotId: string, prompt?: string) => void; onSave: (shotId: string, prompt: string) => void;
}) {
  const { api, story, shot, catalog } = props;
  const state = story.shots.find(s => s.id === shot.id);
  const [draft, setDraft] = useState(shot.prompt);
  useEffect(() => setDraft(shot.prompt), [shot.prompt]);
  const setup = catalog ? readSetup(draft, catalog) : {};
  const changed = draft.trim() !== shot.prompt.trim();
  const frame = state?.frame;
  const konsisten = story.mode === 'konsisten' && !!frame;
  const canRedraw = konsisten && props.editable && (story.cast ?? []).every(c => c.status === 'done');
  const label = `Shot ${props.index + 1} · ${shot.id}`;

  let media;
  if (state?.status === 'done') {
    media = (
      <video src={`${api.shotUrl(story.id, shot.id)}#t=1.5`} muted playsInline preload="metadata" title="Klik untuk putar/jeda"
        onClick={e => { const v = e.currentTarget; if (v.paused) { v.muted = false; void v.play(); } else v.pause(); }} />
    );
  } else if (frame?.status === 'done') {
    media = <img src={api.frameUrl(story.id, shot.id, frame.mediaId)} alt={`Keyframe ${shot.id}`} loading="lazy" />;
  } else {
    media = (
      <span className="shot-empty">
        {frame?.status === 'queued' || state?.status === 'queued' ? <><Loader2 size={18} className="spin" /> {frame?.status === 'queued' ? 'Menggambar keyframe' : 'Merender video'}</> : shot.reuse ? 'Pakai ulang klip' : konsisten ? 'Keyframe belum dibuat' : 'Belum dirender'}
      </span>
    );
  }

  const status = state?.status === 'done' ? 'done' : frame && frame.status !== 'done' ? frame.status : state?.status ?? 'pending';
  const statusLabel = state?.status === 'done' ? 'Video siap' : frame?.status === 'done' ? 'Keyframe siap' : STATUS_LABEL[status] ?? status;
  const error = state?.error ?? frame?.error;
  const retake = !error && (state?.status === 'queued' ? state.lastError : frame?.status === 'queued' ? frame.lastError : undefined);

  return (
    <article className="shot-card" aria-label={label}>
      <div className="shot-media">{media}<span className={`pill ${status}`}>{statusLabel}</span></div>
      <div className="shot-body">
        <div className="shot-meta mono">{String(props.index + 1).padStart(2, '0')} · {shot.id}{shot.silent ? ' · intro' : ''}</div>
        {shot.narration ? <p className="shot-narration">{shot.narration}</p> : <p className="shot-narration muted">Tanpa narasi</p>}
        {catalog && !shot.reuse && (
          <div className="shot-setup">
            <label>
              <span>Framing</span>
              <select aria-label="Framing" disabled={!props.editable} value={setup.framing ?? ''} onChange={e => setDraft(setShotSetup(draft, catalog, e.target.value, setup.move ?? 'static'))}>
                {!setup.framing && <option value="">Lain</option>}
                {catalog.framings.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </label>
            <label>
              <span>Gerakan kamera</span>
              <select aria-label="Gerakan kamera" disabled={!props.editable} value={setup.move ?? ''} onChange={e => setDraft(setShotSetup(draft, catalog, setup.framing ?? 'medium', e.target.value))}>
                {!setup.move && <option value="">Lain</option>}
                {catalog.moves.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
          </div>
        )}
        <details className="shot-prompt-edit">
          <summary>Prompt</summary>
          <textarea aria-label={`Prompt ${shot.id}`} rows={5} value={draft} disabled={!props.editable} onChange={e => setDraft(e.target.value)} />
        </details>
        {error && <p className="form-error">{error}</p>}
        {retake && <p className="notice">Take ulang: {retake}</p>}
        {props.editable && (
          <div className="shot-actions">
            {canRedraw && (
              <button type="button" className="btn btn-sm" disabled={props.busy} onClick={() => props.onRedraw(shot.id, changed ? draft.trim() : undefined)}>
                <RefreshCw size={14} /> Gambar ulang{changed ? ' dengan prompt baru' : ''}
              </button>
            )}
            {!canRedraw && changed && (
              <button type="button" className="btn btn-sm" disabled={props.busy} onClick={() => props.onSave(shot.id, draft.trim())}><Save size={14} /> Simpan</button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export function StoryDetailPage(props: { pollMs?: number }) {
  const { id = '' } = useParams();
  const { fetchImpl, user } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const loadCatalog = useCallback(() => api.catalog(), [api]);
  const { catalog } = useCatalog(loadCatalog);
  const navigate = useNavigate();
  const [story, setStory] = useState<Story>();
  const [board, setBoard] = useState<Storyboard>();
  const [error, setError] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [json, setJson] = useState('');
  const [loadError, setLoadError] = useState<unknown>();
  const [refreshError, setRefreshError] = useState<unknown>();
  const loaded = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get(id);
      loaded.current = true;
      setStory(r.story);
      setLoadError(undefined);
      setRefreshError(undefined);
      setBoard(b => {
        if (!b || JSON.stringify(b) !== JSON.stringify(r.storyboard)) setJson(JSON.stringify(r.storyboard, null, 2));
        return r.storyboard;
      });
    } catch (e) {
      // First load fails → full error screen; a failed background refresh keeps what we have.
      if (loaded.current) setRefreshError(e);
      else setLoadError(e);
    }
  }, [api, id]);

  useEffect(() => { void load(); }, [load]);

  const active = story ? isActive(story) : false;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), props.pollMs ?? 4000);
    return () => clearInterval(timer);
  }, [active, load, props.pollMs]);

  async function act(fn: () => Promise<{ story: Story }>) {
    setBusy(true);
    setError('');
    setBudget('');
    try {
      const r = await fn();
      setStory(r.story);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BUDGET') setBudget(e.message);
      else setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveBoard() {
    let parsed: Storyboard;
    try { parsed = JSON.parse(json) as Storyboard; } catch { setError('JSON storyboard tidak valid'); return; }
    await act(() => api.update(id, parsed));
  }

  async function remove() {
    if (!window.confirm('Hapus cerita ini beserta semua klipnya?')) return;
    await api.remove(id).then(() => navigate('/cerita'), e => setError(describeError(e)));
  }

  if (!story || !board) {
    if (loadError) {
      const missing = loadError instanceof ApiError && loadError.status === 404;
      return (
        <ErrorState
          title={missing ? 'Cerita tidak ditemukan' : 'Gagal memuat cerita'}
          error={loadError}
          onRetry={missing ? undefined : () => { setLoadError(undefined); void load(); }}
          action={<Link className="btn btn-sm" to="/cerita">Kembali ke daftar cerita</Link>}
        />
      );
    }
    return (
      <LoadingState label="Memuat cerita" className="studio">
        <Skel w="40%" h={30} />
        <Skel w="100%" h={44} />
        <div className="skel-flow">{[0, 1, 2, 3, 4].map(c => <div key={c}>{[0, 1, 2].map(r => <Skel key={r} h={92} />)}</div>)}</div>
      </LoadingState>
    );
  }

  const konsisten = story.mode === 'konsisten';
  const reuse = new Set(board.shots.filter(s => s.reuse).map(s => s.id));
  const toRender = story.shots.filter(s => !reuse.has(s.id) && s.status !== 'done').length;
  const done = doneCount(story);
  const seconds = story.shots.reduce((t, s) => t + (s.durationSec ?? 6), 0);
  const framesReady = story.shots.every(s => !s.frame || s.frame.status === 'done');
  const editable = user.isAdmin && !active && !busy;
  const look = board.look ? { ...DEFAULT_LOOK, ...(board.look as Partial<Look>) } : undefined;
  const characters = Object.entries((board.characters ?? {}) as Record<string, unknown>);
  const progress = konsisten && ['casting', 'framing'].includes(story.status)
    ? (story.status === 'casting'
      ? `${(story.cast ?? []).filter(c => c.status === 'done').length}/${story.cast?.length ?? 0} karakter`
      : `${story.shots.filter(s => s.frame?.status === 'done').length}/${story.shots.filter(s => s.frame).length} keyframe`)
    : `${done}/${story.shots.length} video`;

  const graph = buildGraph(story, board);
  const shotIndex = (shotId?: string) => board.shots.findIndex(s => s.id === shotId);

  function nodeThumb(node: FlowNode) {
    const s = story!;
    if (node.status === 'running') return <Loader2 size={18} className="spin" />;
    if (node.kind === 'cast' && node.status === 'done') return <img src={api.castUrl(s.id, node.token!)} alt="" loading="lazy" />;
    if (node.kind === 'frame' && node.status === 'done') {
      const f = s.shots.find(x => x.id === node.shotId)?.frame;
      return <img src={api.frameUrl(s.id, node.shotId!, f?.mediaId)} alt="" loading="lazy" />;
    }
    if (node.kind === 'clip' && node.status === 'done' && !board!.shots[shotIndex(node.shotId)]?.reuse) return <video src={`${api.shotUrl(s.id, node.shotId!)}#t=1.5`} muted playsInline preload="metadata" />;
    if (node.kind === 'final' && node.status === 'done') return <video src={`${api.videoUrl(s.id)}#t=2`} muted playsInline preload="metadata" />;
    const Icon = { storyboard: BookOpenText, look: Palette, cast: UserRound, frame: ImageIcon, clip: Clapperboard, final: Film }[node.kind];
    return <Icon size={18} />;
  }

  function inspect(node: FlowNode) {
    const s = story!, b = board!;
    if (node.kind === 'frame' || node.kind === 'clip') {
      const i = shotIndex(node.shotId);
      const shot = b.shots[i];
      if (!shot) return null;
      return (
        <ShotCard api={api} story={s} shot={shot} index={i} catalog={catalog} editable={editable} busy={busy}
          onRedraw={(shotId, prompt) => void act(() => api.redraw(s.id, shotId, prompt))}
          onSave={(shotId, prompt) => void act(() => api.update(s.id, { ...b, shots: b.shots.map(x => (x.id === shotId ? { ...x, prompt } : x)) }))} />
      );
    }
    if (node.kind === 'cast') {
      const c = s.cast?.find(x => x.token === node.token);
      const spec = (b.characters as Record<string, unknown> | undefined)?.[node.token!];
      return (
        <figure className="cast-card">
          <div className="cast-media">{c?.status === 'done' ? <img src={api.castUrl(s.id, node.token!)} alt={`Lembar karakter ${node.label}`} /> : <span className="shot-empty">{node.note ?? 'Belum dibuat'}</span>}</div>
          <figcaption><b>{node.label}</b><span className="mono">{node.token}</span><p>{castLook(spec)}</p>{c?.error && <p className="form-error">{c.error}</p>}</figcaption>
        </figure>
      );
    }
    if (node.kind === 'final') {
      return s.status === 'done'
        ? <><video className="player" src={api.videoUrl(s.id)} controls playsInline preload="metadata" /><a className="btn" href={api.videoUrl(s.id)} download={`${s.title}.mp4`}><Download size={16} /> Download</a></>
        : <p className="muted">Video akhir dirakit otomatis setelah semua klip lolos QC: judul animasi, crossfade, loudness −14 LUFS.</p>;
    }
    if (node.kind === 'look') {
      return (
        <div className="inspect-board">
          <p className="muted">{typeof b.style === 'string' ? b.style : ''}</p>
          <a className="btn btn-sm" href="#look-title">Ubah gaya</a>
        </div>
      );
    }
    return (
      <div className="inspect-board">
        <p><b>{b.shots.length} shot</b> · {s.mode === 'konsisten' ? 'mode konsisten' : 'mode cepat'} · ±{Math.round(seconds)} detik</p>
        {typeof b.style === 'string' && <p className="muted">{b.style}</p>}
        <a className="btn btn-sm" href="#sb-title">Lihat semua shot</a>
      </div>
    );
  }

  let primary = null;
  if (user.isAdmin) {
    if (story.status === 'failed') {
      primary = <button className="btn btn-primary" disabled={busy} onClick={() => void act(() => api.retry(story.id))}><RotateCcw size={16} /> Ulangi yang gagal</button>;
    } else if (konsisten && story.status === 'draft' && !framesReady) {
      primary = <button className="btn btn-primary" disabled={busy} onClick={() => void act(() => api.prepare(story.id))}><UsersRound size={16} /> Buat karakter & keyframe <small>Gratis</small></button>;
    } else if (story.status === 'review' || (story.status === 'draft' && (!konsisten || framesReady))) {
      primary = <button className="btn btn-primary" disabled={busy} onClick={() => void act(() => api.render(story.id, false))}><Film size={16} /> Render video <small>±{toRender * CREDITS_PER_SHOT} kredit</small></button>;
    }
  }

  const nextStep = konsisten
    ? ({
      draft: framesReady ? 'Keyframe siap. Render untuk menganimasikannya.' : 'Langkah berikut: buat lembar karakter lalu keyframe tiap shot. Gratis, tidak memakai kredit Flow.',
      casting: 'Flow sedang membuat lembar karakter. Halaman ini memperbarui sendiri.',
      framing: 'Flow sedang menggambar keyframe tiap shot dengan karakter yang sama.',
      review: 'Periksa keyframe. Gambar ulang yang kurang pas (gratis), lalu render: tiap keyframe dianimasikan jadi video 6 detik.',
      rendering: 'Keyframe sedang dianimasikan dengan narasi bawaan Veo.',
      assembling: 'Merakit video akhir: judul, crossfade, loudness.',
      done: 'Selesai.',
      failed: story.error ?? 'Ada yang gagal.'
    } as Record<string, string>)[story.status]
    : ({ draft: 'Render untuk membuat tiap shot langsung dari prompt.', rendering: 'Merender shot.', assembling: 'Merakit video akhir.', done: 'Selesai.', failed: story.error ?? 'Ada yang gagal.' } as Record<string, string>)[story.status];

  return (
    <div className="studio">
      <header className="story-head">
        <div>
          <h2>{story.title}</h2>
          <span className="muted mono">{story.id} · {konsisten ? 'Mode konsisten' : 'Mode cepat'}{board.aspect ? ` · ${String(board.aspect)}` : ''}</span>
        </div>
        <div className="topbar-actions">
          {story.status === 'done' && <a className="btn" href={api.videoUrl(story.id)} download={`${story.title}.mp4`}><Download size={16} /> Download</a>}
          {primary}
        </div>
      </header>


      <div className="next-step">
        <span className={`pill ${story.status}`}>{STATUS_LABEL[story.status] ?? story.status}</span>
        <p>{nextStep}</p>
        <span className="muted mono">{progress} · ±{Math.round(seconds)} dtk{story.video ? ` · ${formatMB(story.video.bytes)}` : ''}</span>
      </div>
      {active && <div className="progress" aria-label="Progres"><i className="indeterminate" /></div>}
      {refreshError !== undefined && (
        <ErrorState compact title="Gagal memperbarui status" error={refreshError} onRetry={() => void load()} />
      )}

      <FlowCanvas
        nodes={graph.nodes}
        edges={graph.edges}
        thumb={node => nodeThumb(node)}
        inspector={node => inspect(node)}
      />
      {story.status === 'failed' && story.error && <p className="form-error" role="alert">{story.error}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {budget && (
        <div className="form-error" role="alert" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{budget}</span>
          <button className="btn btn-sm" onClick={() => void act(() => api.render(story.id, true))}>Tetap render</button>
        </div>
      )}

      {catalog && look && (
        <section className="studio-section" aria-labelledby="look-title">
          <div className="section-head">
            <h2 id="look-title">Gaya</h2>
            <span className="muted">Berlaku untuk semua karakter, keyframe dan shot. Mengubahnya menggambar ulang yang terdampak.</span>
          </div>
          <LookChips catalog={catalog} look={look} disabled={!editable} onChange={patch => void act(() => api.setLook(story.id, patch as Record<string, string>))} />
        </section>
      )}

      {konsisten && characters.length > 0 && (
        <section className="studio-section" aria-labelledby="cast-title">
          <div className="section-head">
            <h2 id="cast-title">Karakter</h2>
            <span className="muted">Lembar referensi yang ditempelkan ke setiap keyframe dan video, supaya wajah dan baju tidak berubah.</span>
          </div>
          <div className="cast-grid">
            {characters.map(([token, spec]) => {
              const c = story.cast?.find(x => x.token === token);
              const name = c?.name ?? castName(token, spec);
              return (
                <figure className="cast-card" key={token}>
                  <div className="cast-media">
                    {c?.status === 'done'
                      ? <img src={api.castUrl(story.id, token)} alt={`Lembar karakter ${name}`} loading="lazy" />
                      : <span className="shot-empty">{c?.status === 'queued' ? <><Loader2 size={18} className="spin" /> Membuat</> : c?.status === 'failed' ? 'Gagal' : 'Belum dibuat'}</span>}
                  </div>
                  <figcaption><b>{name}</b><span className="mono">{token}</span><p>{castLook(spec)}</p>{c?.error && <p className="form-error">{c.error}</p>}</figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      )}

      <section className="studio-section" aria-labelledby="sb-title">
        <div className="section-head">
          <h2 id="sb-title">Storyboard</h2>
          <span className="muted">{board.shots.length} shot · QC otomatis: keyframe 9:16, video ≥3 dtk & bersuara, diulang maks. 3 take</span>
        </div>
        <div className={`shot-grid${board.aspect === '16:9' ? ' landscape' : ''}`}>
          {board.shots.map((shot, i) => (
            <ShotCard key={shot.id} api={api} story={story} shot={shot} index={i} catalog={catalog} editable={editable} busy={busy}
              onRedraw={(shotId, prompt) => void act(() => api.redraw(story.id, shotId, prompt))}
              onSave={(shotId, prompt) => void act(() => api.update(story.id, { ...board, shots: board.shots.map(s => (s.id === shotId ? { ...s, prompt } : s)) }))} />
          ))}
        </div>
      </section>

      <div className="story-grid">
        <section className="card">
          <h2>Video</h2>
          {story.status === 'done'
            ? <video data-testid="story-player" className="player" src={api.videoUrl(story.id)} controls playsInline preload="metadata" />
            : <div className="empty">{active ? 'Sedang dibuat. Halaman ini memperbarui sendiri.' : 'Video akhir muncul di sini setelah render.'}</div>}
        </section>
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section className="card">
            <h2>Riwayat</h2>
            <div className="events">
              {[...story.events].reverse().map(e => (
                <div key={`${e.atMs}-${e.message}`}><span className="mono">{new Date(e.atMs).toLocaleTimeString('id-ID')}</span> {e.message}</div>
              ))}
            </div>
          </section>
          {user.isAdmin && !active && (
            <details className="card">
              <summary>Edit storyboard (JSON)</summary>
              <label className="field">
                <span>Storyboard</span>
                <textarea className="mono" rows={14} value={json} onChange={e => setJson(e.target.value)} />
              </label>
              <div className="form-row">
                <button className="btn" disabled={busy} onClick={() => void saveBoard()}>Simpan storyboard</button>
                <button className="btn btn-danger" disabled={busy} onClick={() => void remove()}><Trash2 size={15} /> Hapus</button>
              </div>
            </details>
          )}
        </aside>
      </div>
    </div>
  );
}
