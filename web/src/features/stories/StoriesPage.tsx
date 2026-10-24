import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Dices, LayoutTemplate, Wand2 } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, Skel, describeError } from '../../ui/states.js';
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

export function StoriesPage(props: { pollMs?: number }) {
  const { fetchImpl, user } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const loadCatalog = useCallback(() => api.catalog(), [api]);
  const { catalog, covers, error: catalogError, reload } = useCatalog(loadCatalog, props.pollMs);
  const [coverError, setCoverError] = useState('');
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

  const [listError, setListError] = useState<unknown>();
  const [listTick, setListTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setListError(undefined);
    api.list().then(r => alive && setStories(r.stories), e => alive && setListError(e));
    return () => { alive = false; };
  }, [api, listTick]);
  const focusTemplates = () => {
    const first = document.querySelector<HTMLButtonElement>('.template-grid .template-card');
    first?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    first?.focus();
  };

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
      setError(describeError(e));
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

      {catalogError !== undefined && !catalog && <ErrorState title="Gagal memuat template & pengaturan gaya" error={catalogError} onRetry={reload} />}
      {catalogError === undefined && !catalog && (
        <LoadingState label="Memuat studio" className="studio-skeleton">
          <div className="skel-chips">{[0, 1, 2, 3, 4].map(i => <Skel key={i} h={52} />)}</div>
          <Skel h={104} />
          <div className="skel-templates">{[0, 1, 2, 3, 4].map(i => <Skel key={i} h={220} />)}</div>
        </LoadingState>
      )}

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
          {coverError && <p className="form-error" role="alert">{coverError}</p>}
          <div className="template-grid">
            {catalog.templates.map(t => (
              <TemplateCard key={t.id} template={t} catalog={catalog} selected={t.id === template} onPick={() => pickTemplate(t.id)}
                coverUrl={api.coverUrl(t.id, covers[t.id]?.updatedAtMs ?? 0)} cover={covers[t.id]}
                onRegenerate={user.isAdmin ? () => { setCoverError(''); api.regenerateCover(t.id).then(reload, e => setCoverError(e instanceof Error ? e.message : 'Gagal')); } : undefined} />
            ))}
          </div>
        </section>
      )}

      <section className="studio-section" aria-labelledby="proj-title">
        <div className="section-head"><h2 id="proj-title">Proyek</h2></div>
        {listError !== undefined ? (
          <ErrorState title="Gagal memuat proyek" error={listError} onRetry={() => setListTick(t => t + 1)} />
        ) : stories === undefined ? (
          <LoadingState label="Memuat proyek">{[0, 1, 2].map(i => <div className="skel-row" key={i}><Skel w="45%" h={14} /><Skel w={70} h={14} /><Skel w={80} h={22} /></div>)}</LoadingState>
        ) : stories.length === 0 ? (
          <EmptyState
            icon={<LayoutTemplate size={20} />}
            title="Belum ada cerita"
            reason={user.isAdmin ? 'Proyek muncul di sini setelah kamu menulis storyboard. Mulai dari template agar gaya, mode dan jumlah shot langsung terisi.' : 'Admin belum membuat cerita. Proyek akan muncul di sini.'}
            action={user.isAdmin && catalog ? <button type="button" className="btn btn-primary btn-sm" onClick={focusTemplates}><LayoutTemplate size={14} /> Pilih template</button> : undefined}
          />
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
