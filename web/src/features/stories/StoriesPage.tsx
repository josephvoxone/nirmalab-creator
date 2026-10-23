import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Wand2 } from 'lucide-react';
import { useSession } from '../../lib/session.js';
import { STATUS_LABEL, STYLES, doneCount, storiesApi, type Story } from './storiesClient.js';

export function StoriesPage() {
  const { fetchImpl, user } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const navigate = useNavigate();
  const [stories, setStories] = useState<Story[] | undefined>(undefined);
  const [premise, setPremise] = useState('');
  const [shots, setShots] = useState('8');
  const [style, setStyle] = useState(STYLES[0]!.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.list().then(r => alive && setStories(r.stories), e => alive && setError(e instanceof Error ? e.message : 'Gagal memuat'));
    return () => { alive = false; };
  }, [api]);

  async function draft(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { story } = await api.draft({ premise: premise.trim(), shots: Number(shots), style });
      navigate(`/cerita/${story.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal membuat storyboard');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {user.isAdmin && (
        <form className="card" onSubmit={draft}>
          <div className="card-head">
            <h2>Cerita baru</h2>
            <span className="muted">Premis → storyboard → video dengan narasi Indonesia</span>
          </div>
          <label className="field">
            <span>Premis cerita</span>
            <textarea
              value={premise}
              onChange={e => setPremise(e.target.value)}
              placeholder="Contoh: kelinci kesayangan seorang anak dibuang saat malam hujan, lalu menemukan jalan pulang."
              required
              minLength={5}
            />
          </label>
          <div className="form-row">
            <label className="field">
              <span>Jumlah shot</span>
              <select value={shots} onChange={e => setShots(e.target.value)}>
                {[4, 6, 8, 10, 12].map(n => <option key={n} value={n}>{n} shot · ±{n * 6} detik · ±{n * 10} credits</option>)}
              </select>
            </label>
            <label className="field">
              <span>Gaya visual</span>
              <select value={style} onChange={e => setStyle(e.target.value)}>
                {STYLES.map(s => <option key={s.label} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy || premise.trim().length < 5}>
              <Wand2 size={16} /> {busy ? 'Menulis storyboard…' : 'Buat storyboard'}
            </button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>
      )}
      <section className="card">
        <div className="card-head"><h2>Semua cerita</h2></div>
        {stories === undefined ? <p className="muted">Memuat…</p> : stories.length === 0 ? (
          <div className="empty">Belum ada cerita. Tulis premis di atas untuk mulai.</div>
        ) : (
          <div className="list">
            {stories.map(s => (
              <div className="row" key={s.id}>
                <div className="row-main">
                  <Link to={`/cerita/${s.id}`}>{s.title}</Link>
                  <div className="muted mono">{new Date(s.createdAtMs).toLocaleString('id-ID')}</div>
                </div>
                <span className="muted">{doneCount(s)}/{s.shots.length} shot</span>
                <span className={`pill ${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
