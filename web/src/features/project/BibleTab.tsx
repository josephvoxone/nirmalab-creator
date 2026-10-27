/**
 * Proyek › Bible: the story design the shots are compiled from (spec §4.2/§4.6). Free-form draft —
 * every field saves as you commit it; what is still empty is listed as a warning, not a block.
 * A board without `bible` explains what the bible is in one line and offers "Buat bible".
 * Characters are edited only in Breakdown (one source); this tab links there. A save merges into
 * the stored bible, so fields this tab does not show (locations, references, scene locations) stay.
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Pencil, Plus } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Segmented, inputClass, textareaClass } from '../../ui/controls.js';
import { Skel } from '../../ui/states.js';
import { useProject } from './useProject.js';
import { ACTS, AUDIENCES, bibleWarnings, readBible, seedBible, type Audience, type StoryBible } from '../bible/story.js';

const Section = (props: { id: string; title: string; hint: string; children: ReactNode; action?: ReactNode }) => (
  <section aria-label={props.title} className="glass-panel flex flex-col gap-2 rounded-lg p-3">
    <div className="flex items-start gap-2">
      <div className="flex min-w-0 flex-col">
        <h3 className="text-[13.5px] font-medium">{props.title}</h3>
        <p className="text-[12px] text-muted-foreground">{props.hint}</p>
      </div>
      {props.action && <div className="ml-auto shrink-0">{props.action}</div>}
    </div>
    {props.children}
  </section>
);

/**
 * One field: reads as text, turns into a field on click, commits on Enter or Simpan. A refused save
 * (409 STALE included) opens the field again with what the user typed, until they save it again on
 * top of the fresh board or press Batal — like the shot sheet.
 */
function Inline(props: {
  label: string; value: string; placeholder: string; onSave: (value: string) => Promise<boolean>;
  multiline?: boolean; rows?: number; labelClass?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.value);
  const [failed, setFailed] = useState(false);
  const start = () => { setDraft(props.value); setFailed(false); setEditing(true); };
  const cancel = () => { setEditing(false); setFailed(false); };
  const commit = async () => {
    setEditing(false);
    const next = draft.trim();
    if (next === props.value.trim()) { setFailed(false); return; }
    const ok = await props.onSave(next);
    setFailed(!ok);
    if (!ok) setEditing(true);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void commit(); }
  };
  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <span className={props.labelClass ?? 'text-[11.5px] text-muted-foreground'}>{props.label}</span>
        {editing ? (
          <div className="mt-0.5 flex flex-col gap-1">
            {props.multiline ? (
              <textarea autoFocus aria-label={props.label} placeholder={props.placeholder} rows={props.rows ?? 3}
                value={draft} maxLength={600} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown}
                className={`${textareaClass} min-h-16 text-[12.5px]`} />
            ) : (
              <input autoFocus aria-label={props.label} placeholder={props.placeholder} value={draft} maxLength={200}
                onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown} className={`${inputClass} h-7 text-[12.5px]`} />
            )}
            {failed && <p role="status" className="text-[11.5px] font-medium text-foreground">Perubahanmu belum tersimpan — simpan lagi</p>}
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => void commit()}>Simpan</Button>
              <Button size="sm" variant="ghost" onClick={cancel}>Batal</Button>
            </div>
          </div>
        ) : (
          <p className={`mt-0.5 text-[12.5px] leading-relaxed ${props.value.trim() ? 'text-foreground' : 'text-muted-foreground italic'}`}>
            {props.value.trim() || props.placeholder}
          </p>
        )}
      </div>
      {!editing && (
        <Button size="icon-xs" variant="ghost" aria-label={`Ubah ${props.label}`} onClick={start}><Pencil /></Button>
      )}
    </div>
  );
}

const moved = (bible: StoryBible, patch: Partial<StoryBible>): StoryBible => ({ ...bible, ...patch });

type Raw = Record<string, unknown>;
/**
 * The stored bible with this tab's fields written over it: story, structure and scene goals. Characters,
 * locations, rules and unknown keys are kept as stored, and each scene card keeps its location/states.
 */
export function mergeBible(stored: unknown, next: StoryBible): Raw {
  if (!stored || typeof stored !== 'object') return next as unknown as Raw;
  const raw = stored as Raw;
  const scenes = Array.isArray(raw.scenes) ? (raw.scenes as Raw[]) : [];
  return {
    ...raw,
    logline: next.logline, theme: next.theme, tone: next.tone, audience: next.audience, structure: next.structure,
    scenes: next.scenes.map(s => ({ ...(scenes.find(c => c?.id === s.id) ?? {}), id: s.id, title: s.title, goal: s.goal }))
  };
}

export function BibleTab() {
  const p = useProject();
  const { board } = p;

  if (!board) {
    return (
      <div role="status" aria-busy="true" aria-label="Memuat bible" className="flex flex-col gap-2">
        <Skel w="40%" h={14} /><Skel w="100%" h={72} /><Skel w="100%" h={72} />
      </div>
    );
  }

  const bible = readBible(board.bible);
  const commit = (next: StoryBible) => p.save({ ...board, bible: mergeBible(board.bible, next) });

  if (!bible) {
    return (
      <div className="glass-panel flex flex-wrap items-center gap-2 rounded-lg px-3 py-2.5 text-[12.5px]">
        <p className="min-w-0 flex-1 text-muted-foreground">
          Proyek ini belum punya bible: satu halaman berisi logline, tema, tone, struktur hook–setup–turn–payoff, anchor karakter dan tujuan tiap scene — dasar semua prompt shot. Isinya draf bebas, boleh diisi bertahap.
        </p>
        <Button size="sm" variant="glass" onClick={() => void commit(seedBible(board))}><Plus /> Buat bible</Button>
      </div>
    );
  }

  const warnings = bibleWarnings(bible);
  const sceneGoal = (id: string) => bible.scenes.find(s => s.id === id)?.goal ?? '';
  const setSceneGoal = (id: string, title: string, goal: string) => {
    const exists = bible.scenes.some(s => s.id === id);
    return commit(moved(bible, {
      scenes: exists
        ? bible.scenes.map(s => (s.id === id ? { ...s, goal } : s))
        : [...bible.scenes, { id, title, goal }]
    }));
  };

  return (
    <div className="flex flex-col gap-3">
      {warnings.length > 0 && (
        <div role="status" aria-label="Slot belum lengkap" className="flex flex-col gap-1 rounded-md bg-(--brand-muted) px-3 py-2 text-[12px]">
          <span className="flex items-center gap-1.5 font-medium"><AlertTriangle className="size-3.5" aria-hidden="true" /> Slot belum lengkap — masih bisa disimpan, tapi prompt shot belum akan utuh.</span>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {warnings.map(w => <li key={w}>· {w}</li>)}
          </ul>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Section id="bible-story" title="Cerita" hint="Satu kalimat logline, tema dan tone yang dipegang semua shot.">
          <Inline label="Logline" multiline rows={3} value={bible.logline} placeholder="mis. Seekor kucing oranye menunggu pemiliknya pulang setiap sore."
            onSave={value => commit(moved(bible, { logline: value }))} />
          <Inline label="Tema" value={bible.theme} placeholder="mis. kesetiaan yang tidak dihitung"
            onSave={value => commit(moved(bible, { theme: value }))} />
          <Inline label="Tone" value={bible.tone} placeholder="mis. hangat, sedikit sedih"
            onSave={value => commit(moved(bible, { tone: value }))} />
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] text-muted-foreground">Penonton</span>
            <Segmented name="Penonton" value={bible.audience} options={AUDIENCES}
              onChange={(audience: Audience) => void commit(moved(bible, { audience }))} />
          </div>
        </Section>

        <Section id="bible-structure" title="Struktur" hint="Empat act tetap; satu tujuan per act yang menentukan isi shot-nya.">
          <ol aria-label="Act" className="flex flex-col">
            {ACTS.map(act => {
              const goal = bible.structure.find(s => s.act === act.id)?.goal ?? '';
              const beat = bible.structure.find(s => s.act === act.id)?.beat;
              return (
                <li key={act.id} aria-label={act.label} className="border-b border-border/60 py-1.5 last:border-b-0">
                  <Inline label={`Tujuan ${act.label}`} value={goal} placeholder={act.hint}
                    onSave={value => commit(moved(bible, {
                      structure: bible.structure.map(s => (s.act === act.id ? { ...s, goal: value } : s))
                    }))} />
                  {beat && <p className="mt-0.5 pl-0.5 text-[11.5px] text-muted-foreground">{beat}</p>}
                </li>
              );
            })}
          </ol>
        </Section>
      </div>

      <Section id="bible-cast" title="Karakter" hint="Anchor = fakta visual yang menjaga wajah dan kostum sama di semua shot.">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
            {bible.characters.length
              ? `${bible.characters.length} karakter (${bible.characters.map(c => c.name).join(', ')}). Anchor, want/need/arc, sheet dan referensi diatur di Breakdown.`
              : 'Belum ada karakter. Tambahkan di Breakdown — anchor, want/need/arc, sheet dan referensi diatur di sana.'}
          </p>
          <Link to="?tab=breakdown" replace className={buttonVariants({ size: 'sm', variant: 'glass' })}>Kelola karakter di Breakdown <ArrowRight /></Link>
        </div>
      </Section>

      <Section id="bible-scenes" title="Tujuan scene" hint="Tiap scene punya satu tujuan cerita; shot di dalamnya hanya alat mencapainya.">
        <ol aria-label="Scene" className="flex flex-col">
          {(board.scenes ?? []).map((scene, i) => (
            <li key={scene.id} aria-label={scene.title} className="flex items-start gap-2 border-b border-border/60 py-1.5 last:border-b-0">
              <span className="w-5 shrink-0 pt-0.5 text-[11.5px] text-muted-foreground tabular-nums">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <Inline label={`Tujuan ${scene.title}`} value={sceneGoal(scene.id)} placeholder="Belum ada tujuan — apa yang berubah di scene ini?"
                  onSave={goal => setSceneGoal(scene.id, scene.title, goal)} />
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
