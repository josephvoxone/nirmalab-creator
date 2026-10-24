/**
 * Proyek › Bible: the story design the shots are compiled from (spec §4.2/§4.6). Free-form draft —
 * every field saves as you commit it; what is still empty is listed as a warning, not a block.
 * A board without `bible` explains what the bible is in one line and offers "Buat bible".
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertTriangle, Pencil, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Segmented, inputClass, textareaClass } from '../../ui/controls.js';
import { Skel } from '../../ui/states.js';
import { useProject } from './useProject.js';
import { ACTS, AUDIENCES, bibleWarnings, readBible, seedBible, type Audience, type BibleCharacter, type StoryBible } from '../bible/story.js';

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

/** One field: reads as text, turns into a field on click, commits on Enter or Simpan. */
function Inline(props: {
  label: string; value: string; placeholder: string; onSave: (value: string) => void;
  multiline?: boolean; rows?: number; labelClass?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.value);
  const start = () => { setDraft(props.value); setEditing(true); };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== props.value.trim()) props.onSave(next);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
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
            <div className="flex gap-1.5">
              <Button size="sm" onClick={commit}>Simpan</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Batal</Button>
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

/** Visual anchors as a list of facts: click to edit, × to remove, + to add. */
function Anchors(props: { owner: string; anchors: string[]; onChange: (next: string[]) => void }) {
  const [editing, setEditing] = useState<number>();
  const [draft, setDraft] = useState('');
  const start = (i: number) => { setDraft(props.anchors[i] ?? ''); setEditing(i); };
  const commit = () => {
    if (editing === undefined) return;
    const next = [...props.anchors];
    const value = draft.trim();
    if (value) next[editing] = value; else next.splice(editing, 1);
    setEditing(undefined);
    if (next.join('\n') !== props.anchors.join('\n')) props.onChange(next);
  };
  const add = () => { setDraft(''); setEditing(props.anchors.length); };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11.5px] text-muted-foreground">Anchor visual (fakta yang bisa dilihat)</span>
      <ul aria-label={`Anchor ${props.owner}`} className="flex flex-wrap items-center gap-1">
        {props.anchors.map((anchor, i) => (
          <li key={`${anchor}-${i}`} className="flex h-6 items-center gap-0.5 rounded-md bg-muted pr-0.5 pl-2 text-[12px]">
            {editing === i ? (
              <input autoFocus aria-label={`Anchor ${i + 1}`} placeholder="mis. kalung kulit merah pudar" value={draft} maxLength={160}
                onChange={e => setDraft(e.target.value)} onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commit(); }
                  if (e.key === 'Escape') { e.preventDefault(); setEditing(undefined); }
                }} onBlur={commit} className={`${inputClass} h-5.5 w-44 px-1 text-[12px]`} />
            ) : (
              <>
                <button type="button" aria-label={`Ubah anchor ${i + 1}`} onClick={() => start(i)}
                  className="max-w-56 truncate outline-none hover:underline focus-visible:underline">{anchor}</button>
                <Button size="icon-xs" variant="ghost" aria-label={`Hapus anchor ${i + 1}`}
                  onClick={() => props.onChange(props.anchors.filter((_, j) => j !== i))}><X /></Button>
              </>
            )}
          </li>
        ))}
        {editing === props.anchors.length && (
          <li className="flex h-6 items-center">
            <input autoFocus aria-label={`Anchor ${props.anchors.length + 1}`} placeholder="mis. tinggi 160 cm, rambut kepang"
              value={draft} maxLength={160} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { e.preventDefault(); setEditing(undefined); }
              }} onBlur={commit} className={`${inputClass} h-5.5 w-52 px-1 text-[12px]`} />
          </li>
        )}
        {props.anchors.length === 0 && editing === undefined && (
          <li className="text-[12px] text-muted-foreground italic">Belum ada anchor — tambahkan satu ciri yang bisa dilihat.</li>
        )}
        <li>
          <Button size="icon-xs" variant="ghost" aria-label={`Tambah anchor ${props.owner}`} onClick={add}><Plus /></Button>
        </li>
      </ul>
    </div>
  );
}

const moved = (bible: StoryBible, patch: Partial<StoryBible>): StoryBible => ({ ...bible, ...patch });

export function BibleTab() {
  const p = useProject();
  const { board } = p;
  // Initialised once: this tab is the only editor of `bible`, and a refused save must keep the text.
  const [bible, setBible] = useState<StoryBible | undefined>(() => readBible(board?.bible));

  if (!board) {
    return (
      <div role="status" aria-busy="true" aria-label="Memuat bible" className="flex flex-col gap-2">
        <Skel w="40%" h={14} /><Skel w="100%" h={72} /><Skel w="100%" h={72} />
      </div>
    );
  }

  const commit = (next: StoryBible) => {
    setBible(next);
    void p.save({ ...board, bible: next });
  };
  const characterAt = (i: number, patch: Partial<BibleCharacter>) => {
    if (!bible) return;
    commit(moved(bible, { characters: bible.characters.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  };

  if (!bible) {
    return (
      <div className="glass-panel flex flex-wrap items-center gap-2 rounded-lg px-3 py-2.5 text-[12.5px]">
        <p className="min-w-0 flex-1 text-muted-foreground">
          Proyek ini belum punya bible: satu halaman berisi logline, tema, tone, struktur hook–setup–turn–payoff, anchor karakter dan tujuan tiap scene — dasar semua prompt shot. Isinya draf bebas, boleh diisi bertahap.
        </p>
        <Button size="sm" variant="glass" onClick={() => commit(seedBible(board))}><Plus /> Buat bible</Button>
      </div>
    );
  }

  const warnings = bibleWarnings(bible);
  const sceneGoal = (id: string) => bible.scenes.find(s => s.id === id)?.goal ?? '';
  const setSceneGoal = (id: string, title: string, goal: string) => {
    const exists = bible.scenes.some(s => s.id === id);
    commit(moved(bible, {
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
              onChange={(audience: Audience) => commit(moved(bible, { audience }))} />
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
        {bible.characters.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">Belum ada karakter. Tambahkan karakter di tab Breakdown dulu, lalu buka bible ini lagi.</p>
        ) : (
          <ul className="flex flex-col">
            {bible.characters.map((c, i) => (
              <li key={c.token} aria-label={c.name} className="flex flex-col gap-1.5 border-b border-border/60 py-2 last:border-b-0">
                <div className="flex items-center gap-2">
                  <b className="text-[13px] font-medium">{c.name}</b>
                  <span className="text-[11px] text-muted-foreground">{c.token}</span>
                </div>
                <Anchors owner={c.name} anchors={c.anchors} onChange={anchors => characterAt(i, { anchors })} />
                <div className="grid gap-1.5 sm:grid-cols-3">
                  <Inline label="Want" value={c.want} placeholder="yang ia kejar" onSave={want => characterAt(i, { want })} />
                  <Inline label="Need" value={c.need} placeholder="yang ia butuhkan" onSave={need => characterAt(i, { need })} />
                  <Inline label="Arc" value={c.arc} placeholder="dari … jadi …" onSave={arc => characterAt(i, { arc })} />
                </div>
              </li>
            ))}
          </ul>
        )}
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
