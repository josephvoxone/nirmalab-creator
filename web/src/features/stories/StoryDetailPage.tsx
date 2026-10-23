import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Download, Film, RotateCcw, Trash2 } from 'lucide-react';
import { ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { CREDITS_PER_SHOT, STATUS_LABEL, doneCount, formatMB, isActive, storiesApi, type Story, type Storyboard } from './storiesClient.js';

export function StoryDetailPage(props: { pollMs?: number }) {
  const { id = '' } = useParams();
  const { fetchImpl, user } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const navigate = useNavigate();
  const [story, setStory] = useState<Story>();
  const [board, setBoard] = useState<Storyboard>();
  const [error, setError] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [json, setJson] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.get(id);
      setStory(r.story);
      setBoard(b => {
        if (!b || JSON.stringify(b) !== JSON.stringify(r.storyboard)) setJson(JSON.stringify(r.storyboard, null, 2));
        return r.storyboard;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat');
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
      else setError(e instanceof Error ? e.message : 'Gagal');
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
    await api.remove(id).then(() => navigate('/cerita'), e => setError(e instanceof Error ? e.message : 'Gagal menghapus'));
  }

  if (!story || !board) return error ? <p className="form-error" role="alert">{error}</p> : <p className="muted">Memuat…</p>;

  const reuse = new Set(board.shots.filter(s => s.reuse).map(s => s.id));
  const toRender = story.shots.filter(s => !reuse.has(s.id) && s.status !== 'done').length;
  const done = doneCount(story);
  const pct = Math.round((done / Math.max(story.shots.length, 1)) * 100);
  const canRender = user.isAdmin && story.status === 'draft';
  const seconds = story.shots.reduce((t, s) => t + (s.durationSec ?? 6), 0);

  return (
    <>
      <div className="card-head">
        <div>
          <h2 style={{ fontSize: 20 }}>{story.title}</h2>
          <span className="muted mono">{story.id}</span>
        </div>
        <div className="topbar-actions">
          {story.status === 'done' && (
            <a className="btn" href={api.videoUrl(story.id)} download={`${story.title}.mp4`}><Download size={16} /> Download</a>
          )}
          {user.isAdmin && story.status === 'failed' && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void act(() => api.retry(story.id))}><RotateCcw size={16} /> Ulangi yang gagal</button>
          )}
          {canRender && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void act(() => api.render(story.id, false))}><Film size={16} /> Render video</button>
          )}
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><b><span className={`pill ${story.status}`}>{STATUS_LABEL[story.status] ?? story.status}</span></b><span>Status</span></div>
        <div className="kpi"><b>{done}/{story.shots.length}</b><span>Shot siap</span></div>
        <div className="kpi"><b>±{toRender * CREDITS_PER_SHOT} credits</b><span>Untuk {toRender} shot tersisa</span></div>
        <div className="kpi"><b>±{Math.round(seconds)} dtk</b><span>{story.video ? formatMB(story.video.bytes) : 'Durasi'}</span></div>
      </div>
      {active && <div className="progress" aria-label="Progres"><i style={{ width: `${Math.max(pct, 4)}%` }} /></div>}

      {story.status === 'failed' && story.error && <p className="form-error" role="alert">{story.error}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {budget && (
        <div className="form-error" role="alert" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{budget}</span>
          <button className="btn btn-sm" onClick={() => void act(() => api.render(story.id, true))}>Tetap render</button>
        </div>
      )}

      <div className="story-grid">
        <section className="card">
          <div className="card-head"><h2>Shot</h2><span className="muted">QC otomatis: durasi ≥3 dtk & ada suara, diulang maks. 3 take</span></div>
          <div className="list">
            {board.shots.map(shot => {
              const s = story.shots.find(x => x.id === shot.id);
              return (
                <div className="shot" key={shot.id}>
                  <div className="shot-thumb">
                    {s?.status === 'done' ? <video src={api.shotUrl(story.id, shot.id)} muted playsInline preload="metadata" controls /> : <span>{shot.id.slice(0, 2)}</span>}
                  </div>
                  <div>
                    <div className="mono muted">{shot.id}{shot.silent ? ' · intro tanpa narasi' : ''}{shot.reuse ? ' · pakai ulang klip' : ''}</div>
                    {shot.narration && <p className="shot-narration">{shot.narration}</p>}
                    <p className="shot-prompt">{shot.prompt}</p>
                    {s?.error && <p className="form-error" style={{ marginTop: 6 }}>{s.error}</p>}
                    {!s?.error && s?.lastError && s.status === 'queued' && <p className="notice" style={{ marginTop: 6 }}>Take ulang: {s.lastError}</p>}
                  </div>
                  <span className={`pill ${s?.status ?? 'pending'}`}>{STATUS_LABEL[s?.status ?? 'pending']}</span>
                </div>
              );
            })}
          </div>
        </section>

        <aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section className="card">
            <h2>Video</h2>
            {story.status === 'done'
              ? <video data-testid="story-player" className="player" src={api.videoUrl(story.id)} controls playsInline preload="metadata" />
              : <div className="empty">{active ? 'Sedang dibuat. Halaman ini memperbarui sendiri.' : 'Klik Render video untuk mulai.'}</div>}
          </section>
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
    </>
  );
}
