import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Dices, Wand2 } from 'lucide-react';
import { useSession } from '../../lib/session.js';
import { DEFAULT_LOOK, useCatalog, type Look } from './catalog.js';
import { LookChips, TemplateCard } from './LookChips.js';
import { CREDITS_PER_SHOT, STATUS_LABEL, doneCount, storiesApi, type Story } from './storiesClient.js';
import './studio.css';

type Mode = 'konsisten' | 'cepat';

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'konsisten', label: 'Konsisten', hint: 'Karakter dibuat sekali, tiap shot digambar dulu sebagai keyframe (gratis) lalu dianimasikan. Wajah, baju dan gaya tetap sama.' },
  { id: 'cepat', label: 'Cepat', hint: 'Langsung text-to-video per shot. Cocok untuk faceless, fakta, montase.' }
];

export function StoriesPage() {
  const { fetchImpl, user } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const loadCatalog = useCallback(() => api.catalog(), [api]);
  const { catalog, error: catalogError } = useCatalog(loadCatalog);
  const navigate = useNavigate();
  const [stories, setStories] = useState<Story[] | undefined>(undefined);
  const [premise, setPremise] = useState('');
  const [template, setTemplate] = useState<string>();
  const [look, setLook] = useState<Look>(DEFAULT_LOOK);
  const [mode, setMode] = useState<Mode>('konsisten');
  const [aspect, setAspect] = useState<'9:16' | '16:9'>('9:16');
  const [shots, setShots] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.list().then(r => alive && setStories(r.stories), e => alive && setError(e instanceof Error ? e.message : 'Gagal memuat'));
    return () => { alive = false; };
  }, [api]);

  const chosen = catalog?.templates.find(t => t.id === template);

  function pickTemplate(id: string) {
    const t = catalog?.templates.find(x => x.id === id);
    if (!t || !catalog) return;
    const previousExample = chosen?.example;
    setTemplate(t.id);
    setLook(t.look);
    setMode(t.mode);
    setAspect(t.aspect);
    setShots(catalog.tempos.find(x => x.id === t.look.tempo)?.shots ?? 8);
    if (!premise.trim() || premise === previousExample) setPremise(t.example);
  }

  function changeLook(patch: Partial<Look>) {
    setLook(l => ({ ...l, ...patch }));
    const tempo = patch.tempo && catalog?.tempos.find(t => t.id === patch.tempo);
    if (tempo) setShots(tempo.shots);
  }

  async function draft(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { story } = await api.draft({ premise: premise.trim(), shots, look, mode, aspect, ...(template ? { template } : {}) });
      navigate(`/cerita/${story.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal membuat storyboard');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="studio">
      <header className="studio-hero">
        <h2>Dari premis jadi film pendek</h2>
        <p>Pilih template, atur gaya seperti di set film, lalu tulis premisnya. Storyboard, karakter dan keyframe gratis; kredit Flow hanya terpakai saat render video.</p>
      </header>

      {catalogError && <p className="form-error" role="alert">{catalogError}</p>}

      {user.isAdmin && catalog && (
        <form className="composer" onSubmit={draft}>
          <LookChips catalog={catalog} look={look} onChange={changeLook} />
          <textarea
            className="composer-prompt"
            aria-label="Premis cerita"
            value={premise}
            onChange={e => setPremise(e.target.value)}
            placeholder="Tulis premis cerita dalam Bahasa Indonesia. Contoh: kelinci kesayangan seorang anak dibuang saat malam hujan, lalu menemukan jalan pulang."
            minLength={5}
            required
          />
          <div className="composer-bar">
            <div className="segmented" role="radiogroup" aria-label="Mode">
              {MODES.map(m => (
                <label key={m.id} className={mode === m.id ? 'on' : ''} title={m.hint}>
                  <input type="radio" name="mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} />
                  {m.label}
                </label>
              ))}
            </div>
            <div className="segmented" role="radiogroup" aria-label="Rasio">
              {(['9:16', '16:9'] as const).map(a => (
                <label key={a} className={aspect === a ? 'on' : ''}>
                  <input type="radio" name="aspect" value={a} checked={aspect === a} onChange={() => setAspect(a)} />
                  {a}
                </label>
              ))}
            </div>
            <label className="mini-field">
              <span>Jumlah shot</span>
              <select value={shots} onChange={e => setShots(Number(e.target.value))}>
                {[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-ghost" disabled={!chosen} onClick={() => chosen && setPremise(chosen.example)}>
              <Dices size={16} /> Coba contoh
            </button>
            <span className="composer-cost">±{shots * 6} dtk · ±{shots * CREDITS_PER_SHOT} kredit saat render</span>
            <button className="btn btn-primary btn-generate" type="submit" disabled={busy || premise.trim().length < 5}>
              <Wand2 size={16} /> {busy ? 'Menulis storyboard…' : 'Tulis storyboard'} <small>Gratis</small>
            </button>
          </div>
          <p className="composer-hint">{MODES.find(m => m.id === mode)!.hint}</p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>
      )}

      {catalog && (
        <section className="studio-section" aria-labelledby="tpl-title">
          <div className="section-head">
            <h2 id="tpl-title">Template</h2>
            <span className="muted">{catalog.templates.length} format siap pakai. Gaya, mode dan jumlah shot langsung terisi.</span>
          </div>
          <div className="template-grid">
            {catalog.templates.map(t => (
              <TemplateCard key={t.id} template={t} catalog={catalog} selected={t.id === template} onPick={() => pickTemplate(t.id)} />
            ))}
          </div>
        </section>
      )}

      <section className="studio-section" aria-labelledby="proj-title">
        <div className="section-head"><h2 id="proj-title">Proyek</h2></div>
        {stories === undefined ? <p className="muted">Memuat…</p> : stories.length === 0 ? (
          <div className="empty">Belum ada cerita. Pilih template di atas untuk mulai.</div>
        ) : (
          <div className="list">
            {stories.map(s => (
              <div className="row" key={s.id}>
                <div className="row-main">
                  <Link to={`/cerita/${s.id}`}>{s.title}</Link>
                  <div className="muted mono">{new Date(s.createdAtMs).toLocaleString('id-ID')}{s.mode ? ` · ${s.mode}` : ''}</div>
                </div>
                <span className="muted">{doneCount(s)}/{s.shots.length} shot</span>
                <span className={`pill ${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
