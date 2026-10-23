import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clapperboard, Copy, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import {
  TECHNIQUE_CATEGORIES,
  filterTechniques,
  promptWarnings,
  techniqueKey,
  type Technique
} from './compose.js';
import { DEFAULT_NEGATIVE, PRESET_GROUPS, allPresets, applyPreset, composeShot, presetPreview, type PresetGroup, type StylePreset } from './presets.js';
import { flowClient, type FlowAccount, type FlowBridge, type FlowFetch, type FlowJob } from './flowClient.js';
import './studio.css';

const POLL_MS = 8_000;
const LIST_LIMIT = 60;

function relative(ms?: number): string {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86400)} hari lalu`;
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Antre',
  running: 'Diproses',
  done: 'Selesai',
  failed: 'Gagal',
  ready: 'Siap',
  cooldown: 'Cooldown',
  error: 'Error'
};

export function StudioPage(props: { baseUrl: string; fetchImpl: FlowFetch; techniques: Technique[] }) {
  const api = useMemo(() => flowClient(props.baseUrl, props.fetchImpl), [props.baseUrl, props.fetchImpl]);
  const [accounts, setAccounts] = useState<FlowAccount[]>([]);
  const [bridge, setBridge] = useState<FlowBridge>({ online: false });
  const [jobs, setJobs] = useState<FlowJob[]>([]);
  const [subject, setSubject] = useState('');
  const [character, setCharacter] = useState('');
  const [style, setStyle] = useState('');
  const [negative, setNegative] = useState(DEFAULT_NEGATIVE.join(', '));
  const [presetId, setPresetId] = useState<string>();
  const [presetGroup, setPresetGroup] = useState<PresetGroup>('drama');
  const [picked, setPicked] = useState<Technique[]>([]);
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [aspect, setAspect] = useState<'9:16' | '16:9'>('9:16');
  const [duration, setDuration] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [form, setForm] = useState({ label: '', email: '', profileDir: '' });

  const refresh = useCallback(async () => {
    try {
      const [a, j] = await Promise.all([api.accounts(), api.jobs()]);
      setAccounts(a.accounts);
      setBridge(a.bridge);
      setJobs(j.jobs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat');
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const composed = useMemo(() => composeShot({
    subject,
    character,
    picked,
    style,
    negative: negative.split(',')
  }), [subject, character, picked, style, negative]);
  const presets = useMemo(() => allPresets(props.techniques), [props.techniques]);
  const visiblePresets = presets.filter(p => p.group === presetGroup);
  /** Latest finished Flow render per preset (jobs tagged "preset:<id>"). */
  const ownRenders = useMemo(() => {
    const map = new Map<string, FlowJob>();
    for (const job of jobs) {
      if (job.status !== 'done' || !job.technique?.startsWith('preset:')) continue;
      const id = job.technique.slice('preset:'.length);
      const current = map.get(id);
      if (!current || (job.finishedAtMs ?? 0) > (current.finishedAtMs ?? 0)) map.set(id, job);
    }
    return map;
  }, [jobs]);

  async function renderPresetSample(preset: StylePreset): Promise<void> {
    if (busy) return;
    const state = applyPreset(preset, props.techniques);
    setBusy(true);
    setError(undefined);
    try {
      await api.createJob({
        prompt: composeShot({ subject: state.subject, character: state.character, picked: state.picked, style: state.style, negative: state.negative }),
        aspect: state.aspect,
        durationSec: state.durationSec,
        technique: `preset:${preset.id}`
      });
      setNotice(`Render contoh "${preset.name}" masuk antrean Flow.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal mengantre render');
    } finally {
      setBusy(false);
    }
  }

  function clonePreset(preset: StylePreset): void {
    const state = applyPreset(preset, props.techniques);
    setPicked(state.picked);
    setAspect(state.aspect);
    setDuration(state.durationSec);
    setSubject(state.subject);
    setCharacter(state.character);
    setStyle(state.style);
    setNegative(state.negative.join(', '));
    setPresetId(preset.id);
    setNotice(`Preset "${preset.name}" di-clone. Ganti subjek/karakter sesuai ceritamu.`);
    if (typeof document !== 'undefined') document.getElementById('studio-composer-title')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }
  const warnings = useMemo(() => promptWarnings(picked), [picked]);
  const visible = useMemo(
    () => filterTechniques(props.techniques, category, query).slice(0, LIST_LIMIT),
    [props.techniques, category, query]
  );
  const pickedKeys = useMemo(() => new Set(picked.map(techniqueKey)), [picked]);

  const ready = accounts.filter(a => a.status === 'ready').length;
  const queued = jobs.filter(j => j.status === 'queued' || j.status === 'running').length;
  const today = new Date().toDateString();
  const doneToday = jobs.filter(j => j.status === 'done' && j.finishedAtMs && new Date(j.finishedAtMs).toDateString() === today).length;
  const credits = accounts.reduce((sum, a) => sum + (a.credits ?? 0), 0);

  async function enqueue(): Promise<void> {
    if (busy || !composed.trim()) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.createJob({
        prompt: composed,
        aspect,
        durationSec: duration,
        ...(presetId ? { technique: `preset:${presetId}` } : picked[0] ? { technique: techniqueKey(picked[0]) } : {})
      });
      setNotice('Klip masuk antrean. Bridge akan mengambilnya dari akun Flow yang siap.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal mengantre');
    } finally {
      setBusy(false);
    }
  }

  async function addAccount(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || !form.label.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.addAccount({
        label: form.label.trim(),
        email: form.email.trim(),
        ...(form.profileDir.trim() ? { profileDir: form.profileDir.trim() } : {})
      });
      setForm({ label: '', email: '', profileDir: '' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menambah akun');
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(id: string): Promise<void> {
    setBusy(true);
    try {
      await api.removeAccount(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menghapus akun');
    } finally {
      setBusy(false);
    }
  }

  const accountLabel = (id?: string) => accounts.find(a => a.id === id)?.label ?? '—';

  return (
    <div className="studio-page">
      <header className="studio-header">
        <div>
          <p>Susun shot sinematik dari 424 teknik, antrekan ke Google Flow, pantau akun & hasilnya.</p>
        </div>
        <div className="studio-header-actions">
          <button type="button" className="studio-btn" onClick={() => void refresh()} aria-label="Muat ulang">
            <RefreshCw aria-hidden="true" size={15} /> Muat ulang
          </button>
        </div>
      </header>

      <section className="studio-kpi" aria-label="Ringkasan">
        <div className="studio-kpi-cell">
          <span>Akun siap</span>
          <strong>{ready}<small>/{accounts.length}</small></strong>
          <em className={bridge.online ? 'is-ok' : 'is-bad'}>{bridge.online ? 'Bridge online' : 'Bridge offline'}</em>
        </div>
        <div className="studio-kpi-cell">
          <span>Antrean aktif</span>
          <strong>{queued}</strong>
          <em>queued + running</em>
        </div>
        <div className="studio-kpi-cell">
          <span>Selesai hari ini</span>
          <strong>{doneToday}</strong>
          <em>klip mp4</em>
        </div>
        <div className="studio-kpi-cell">
          <span>Kredit Flow</span>
          <strong>{credits}</strong>
          <em>total semua akun</em>
        </div>
      </section>

      {error !== undefined ? <p className="studio-alert" role="alert">{error}</p> : null}
      {notice !== undefined ? <p className="studio-notice" role="status">{notice}</p> : null}

      <div className="studio-body">
        <div className="studio-main">
          <section className="studio-card" aria-labelledby="studio-presets-title">
            <header className="studio-card-head">
              <h2 id="studio-presets-title">Preset gaya</h2>
              <span className="studio-muted">{presets.length} preset · clone untuk mengisi composer</span>
            </header>
            <div className="studio-tabs" role="tablist" aria-label="Grup preset">
              {PRESET_GROUPS.map(g => (
                <button key={g.key} type="button" role="tab" aria-label={g.label} aria-selected={presetGroup === g.key} onClick={() => setPresetGroup(g.key)}>
                  {g.label} <span>{presets.filter(p => p.group === g.key).length}</span>
                </button>
              ))}
            </div>
            <div className="studio-presets">
              {visiblePresets.map(preset => {
                const own = ownRenders.get(preset.id);
                const media = own ? { video: api.fileUrl(own.id), image: undefined } : presetPreview(preset, props.techniques);
                return (
                  <article key={preset.id} className={`studio-preset${presetId === preset.id ? ' is-active' : ''}`} aria-label={preset.name}>
                    <div className="studio-preset-media">
                      {media.video ? (
                        <video
                          src={media.video}
                          poster={media.image}
                          muted
                          loop
                          playsInline
                          preload="none"
                          onMouseEnter={event => void event.currentTarget.play?.().catch(() => {})}
                          onMouseLeave={event => event.currentTarget.pause?.()}
                          onFocus={event => void event.currentTarget.play?.().catch(() => {})}
                        />
                      ) : media.image ? <img src={media.image} alt="" loading="lazy" /> : null}
                      <span className={`studio-preset-source${own ? ' is-own' : ''}`}>{own ? 'Render Flow' : 'Contoh teknik · Melies'}</span>
                    </div>
                    <div className="studio-preset-body">
                      <strong>{preset.name}</strong>
                      <p>{preset.description}</p>
                    </div>
                    <div className="studio-preset-actions">
                      <button type="button" className="studio-btn" aria-label={`Clone ${preset.name}`} onClick={() => clonePreset(preset)}>
                        <Copy aria-hidden="true" size={14} /> Clone
                      </button>
                      <button
                        type="button"
                        className="studio-btn"
                        aria-label={`Render contoh ${preset.name}`}
                        title="Antrekan render contoh preset ini ke Flow (pakai kredit akun)"
                        disabled={busy}
                        onClick={() => void renderPresetSample(preset)}
                      >
                        <Clapperboard aria-hidden="true" size={14} /> Render
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="studio-card" aria-labelledby="studio-composer-title">
            <header className="studio-card-head">
              <h2 id="studio-composer-title">Composer sinematik</h2>
              <div className="studio-segmented" role="radiogroup" aria-label="Aspek">
                {(['9:16', '16:9'] as const).map(value => (
                  <button key={value} type="button" role="radio" aria-checked={aspect === value} onClick={() => setAspect(value)}>{value}</button>
                ))}
              </div>
            </header>
            <div className="studio-composer">
              <label className="studio-field">
                <span>Subjek / aksi</span>
                <textarea
                  aria-label="Subjek"
                  rows={3}
                  maxLength={1200}
                  value={subject}
                  placeholder="mis. a paper boat drifting down a rainy street at dusk"
                  onChange={event => setSubject(event.target.value)}
                />
              </label>
              <label className="studio-field">
                <span>Karakter (descriptor identik di setiap shot)</span>
                <input
                  aria-label="Karakter"
                  value={character}
                  maxLength={300}
                  placeholder="mis. a woman in her thirties, yellow raincoat, short black hair"
                  onChange={event => setCharacter(event.target.value)}
                />
              </label>
              <div className="studio-row">
                <label className="studio-field studio-grow">
                  <span>Style / grade</span>
                  <input aria-label="Style" value={style} maxLength={300} onChange={event => setStyle(event.target.value)} />
                </label>
                <label className="studio-field studio-grow">
                  <span>Negative prompt (daftar, pisah koma)</span>
                  <input aria-label="Negative prompt" value={negative} maxLength={400} onChange={event => setNegative(event.target.value)} />
                </label>
              </div>
              <div className="studio-row">
                <label className="studio-field">
                  <span>Durasi</span>
                  <select value={duration} onChange={event => setDuration(Number(event.target.value))}>
                    {[4, 6, 8, 10].map(s => <option key={s} value={s}>{s} detik</option>)}
                  </select>
                </label>
                <label className="studio-field">
                  <span>Kategori</span>
                  <select value={category} onChange={event => setCategory(event.target.value)}>
                    <option value="all">Semua kategori</option>
                    {TECHNIQUE_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </label>
                <label className="studio-field studio-grow">
                  <span>Cari teknik</span>
                  <input aria-label="Cari teknik" value={query} placeholder="dolly, rim light, noir…" onChange={event => setQuery(event.target.value)} />
                </label>
              </div>

              {picked.length > 0 ? (
                <ul className="studio-chips" aria-label="Teknik dipilih">
                  {picked.map(t => (
                    <li key={techniqueKey(t)}>
                      {t.n}
                      <button type="button" aria-label={`Hapus ${t.n}`} onClick={() => setPicked(list => list.filter(x => techniqueKey(x) !== techniqueKey(t)))}>
                        <X aria-hidden="true" size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <ul className="studio-techniques">
                {visible.map(t => (
                  <li key={techniqueKey(t)}>
                    {t.i ? <img className="studio-technique-thumb" src={t.i} alt="" loading="lazy" /> : null}
                    <div className="studio-technique-text">
                      <strong>{t.n}</strong>
                      <p>{t.d}</p>
                    </div>
                    <button
                      type="button"
                      className="studio-btn"
                      aria-label={`Tambah ${t.n}`}
                      disabled={pickedKeys.has(techniqueKey(t))}
                      onClick={() => setPicked(list => [...list, t])}
                    >
                      <Plus aria-hidden="true" size={14} />
                    </button>
                  </li>
                ))}
                {visible.length === 0 ? <li className="studio-empty">Tidak ada teknik yang cocok.</li> : null}
              </ul>

              <div className="studio-preview">
                <span>Prompt tersusun</span>
                <p data-testid="composed-prompt">{composed || 'Tulis subjek lalu pilih teknik.'}</p>
                {warnings.map(w => <p key={w} className="studio-warning" role="note">{w}</p>)}
              </div>
              <div className="studio-actions">
                <button type="button" className="studio-btn studio-btn-primary" disabled={busy || !composed.trim()} onClick={() => void enqueue()}>
                  <Clapperboard aria-hidden="true" size={15} /> Antrekan ke Flow
                </button>
              </div>
            </div>
          </section>

          <section className="studio-card" aria-labelledby="studio-queue-title">
            <header className="studio-card-head">
              <h2 id="studio-queue-title">Antrean klip</h2>
              <span className="studio-muted">{jobs.length} job</span>
            </header>
            <ul className="studio-list">
              {jobs.map(job => (
                <li key={job.id} className="studio-job">
                  <div className="studio-job-main">
                    <span className={`studio-pill is-${job.status}`}>{STATUS_LABEL[job.status] ?? job.status}</span>
                    <p title={job.prompt}>{job.prompt}</p>
                  </div>
                  <div className="studio-job-meta">
                    <span>{accountLabel(job.accountId)}</span>
                    <span>{job.aspect} · {job.durationSec}s</span>
                    <span>{relative(job.finishedAtMs ?? job.createdAtMs)}</span>
                  </div>
                  {job.status === 'done' ? (
                    <video data-testid={`clip-${job.id}`} className="studio-clip" src={api.fileUrl(job.id)} controls preload="metadata" />
                  ) : null}
                  {job.status === 'failed' && job.error ? <p className="studio-job-error">{job.error}</p> : null}
                </li>
              ))}
              {jobs.length === 0 ? <li className="studio-empty">Belum ada klip. Susun prompt di atas lalu antrekan.</li> : null}
            </ul>
          </section>
        </div>

        <aside className="studio-rail">
          <section className="studio-card" aria-labelledby="studio-accounts-title">
            <header className="studio-card-head">
              <h2 id="studio-accounts-title">Akun Flow</h2>
              <span className="studio-muted">{accounts.length} akun</span>
            </header>
            <ul className="studio-list">
              {accounts.map(account => (
                <li key={account.id} className="studio-account">
                  <span className={`studio-dot is-${account.status}`} aria-hidden="true" />
                  <div>
                    <strong>{account.label}</strong>
                    <p>{STATUS_LABEL[account.status] ?? account.status} · {account.credits ?? '?'} kredit · {account.creditsUsedToday} klip hari ini</p>
                    {account.status === 'cooldown' && account.lastError ? <p className="studio-job-error">{account.lastError}</p> : null}
                  </div>
                  <button type="button" className="studio-icon-btn" aria-label={`Hapus akun ${account.label}`} onClick={() => void removeAccount(account.id)}>
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </li>
              ))}
              {accounts.length === 0 ? <li className="studio-empty">Belum ada akun. Tambahkan akun Flow (profile Chrome di Mac).</li> : null}
            </ul>
            <form className="studio-form" onSubmit={event => void addAccount(event)}>
              <input aria-label="Label akun" placeholder="Label (mis. Akun 2)" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
              <input aria-label="Email akun" placeholder="Email burner" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              <input aria-label="Folder profile" placeholder="cdp:http://127.0.0.1:9334" value={form.profileDir} onChange={e => setForm(f => ({ ...f, profileDir: e.target.value }))} />
              <button type="submit" className="studio-btn" disabled={busy || !form.label.trim()}>
                <Plus aria-hidden="true" size={14} /> Tambah akun
              </button>
            </form>
          </section>

          <section className="studio-card" aria-labelledby="studio-bridge-title">
            <header className="studio-card-head">
              <h2 id="studio-bridge-title">Bridge Mac</h2>
              <span className={`studio-pill ${bridge.online ? 'is-done' : 'is-failed'}`}>{bridge.online ? 'Online' : 'Offline'}</span>
            </header>
            <p className="studio-muted">{bridge.bridgeId ? `${bridge.bridgeId} · terakhir ${relative(bridge.lastSeenMs)}` : 'Belum pernah terhubung.'}</p>
            <p className="studio-muted">Bridge dan Chrome Flow jalan otomatis di Mac (LaunchAgent): bridge hidup terus, Chrome Flow dibuka ulang tiap 5 menit bila mati. Job hanya diambil saat Chrome Flow siap.</p>
            <p className="studio-muted">Akun Flow baru: buka Chrome khusus lalu login sekali, daftarkan dengan profil <code>cdp:http://127.0.0.1:&lt;port&gt;</code>.</p>
            <pre className="studio-code">cd ~/tools/nirmalab-creator/bridge{'\n'}./flow-chrome.sh flow-02 9334</pre>
          </section>
        </aside>
      </div>
    </div>
  );
}
