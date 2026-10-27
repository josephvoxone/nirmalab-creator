/**
 * Breakdown: the film's bible — who (characters), where (locations) and how it looks (style).
 * Everything here feeds every shot: a character's look becomes its reference sheet, a
 * location's look becomes the "Setting:" of every shot in the scenes that use it.
 *
 * Bible boards: this tab is the one character editor (bible cards: anchors, want/need/arc, sheet,
 * reference — see CharacterCard) and location edits land on both sides (bible lookdev + board look).
 * Legacy boards keep the {name, look} editor.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { MapPin, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { useSession } from '../../lib/session.js';
import { sized } from '../../lib/media.js';
import { Choice, inputClass, textareaClass } from '../../ui/controls.js';
import { CREDITS_PER_SHOT, storiesApi } from '../stories/storiesClient.js';
import { FLOW, fmtUsd, isAxcel, isOpenRouter, type Engine, type EngineSet, type MediaKind } from '../providers/providersClient.js';
import { estimateUsd, openRouterOption, useEngines, type EngineCatalog } from '../providers/useEngines.js';
import { EngineChoice } from '../providers/EnginePicker.js';
import { DEFAULT_LOOK, useCatalog, type Look } from '../stories/catalog.js';
import { LookChips } from '../stories/LookChips.js';
import '../stories/studio.css';
import { media, useProject } from './useProject.js';
import type { Board, CharacterSpec } from './model.js';
import { CharacterCard, cardsOf, withCard } from './CharacterCard.js';
import { shotsUsing } from './mentions.js';

const TOKEN_RE = /^[A-Z][A-Z0-9_]{1,30}$/;
const tokenOf = (name: string) => name.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 30);
const titleCase = (t: string) => t.toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const asSpec = (token: string, s: CharacterSpec) => (typeof s === 'string' ? { name: titleCase(token), look: s } : { name: s.name || titleCase(token), look: s.look });

function Section(props: { id: string; title: string; hint: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={props.id} className="glass-panel flex flex-col gap-2.5 rounded-lg p-3">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-col">
          <h3 id={props.id} className="text-[13.5px] font-medium">{props.title}</h3>
          <p className="text-[12px] text-muted-foreground">{props.hint}</p>
        </div>
        <div className="ml-auto shrink-0">{props.action}</div>
      </div>
      {props.children}
    </section>
  );
}

/** One editable entry (character or location): name + English look. */
function Entry(props: {
  name: string; look: string; image?: ReactNode; icon: ReactNode; meta: string; status?: ReactNode;
  locked: boolean; deleteBlocked?: string; onSave: (name: string, look: string) => Promise<boolean>; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(props.name);
  const [look, setLook] = useState(props.look);
  const start = () => { setName(props.name); setLook(props.look); setEditing(true); };
  const save = async () => { if (await props.onSave(name.trim(), look.trim())) setEditing(false); };
  return (
    <li aria-label={props.name} className="flex gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground [&_svg]:size-5">{props.image ?? props.icon}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {editing ? (
          <>
            <input aria-label={`Nama ${props.name}`} placeholder="Nama yang tampil di naskah" className={inputClass} value={name} onChange={e => setName(e.target.value)} />
            <textarea aria-label="Deskripsi visual (English)" placeholder="Visual look in English: age, face, outfit / place, time of day" className={`${textareaClass} min-h-16`} value={look} onChange={e => setLook(e.target.value)} />
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => void save()} disabled={!name.trim() || !look.trim() || (name.trim() === props.name && look.trim() === props.look)}>Simpan</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Batal</Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{props.name}</span>
              {props.status}
            </div>
            <p className="line-clamp-2 text-[12px] text-muted-foreground">{props.look}</p>
            <p className="text-[11.5px] text-muted-foreground/80">{props.meta}</p>
          </>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 items-start gap-0.5">
          <Button size="icon-sm" variant="ghost" aria-label={`Ubah ${props.name}`} disabled={props.locked} onClick={start}><Pencil /></Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Hapus ${props.name}`} title={props.deleteBlocked} disabled={props.locked || !!props.deleteBlocked} onClick={props.onDelete}><Trash2 /></Button>
        </div>
      )}
    </li>
  );
}

function AddForm(props: { kind: 'karakter' | 'lokasi'; anchors?: boolean; onAdd: (name: string, look: string) => Promise<boolean>; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [look, setLook] = useState('');
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-dashed p-2.5">
      <input aria-label={`Nama ${props.kind}`} placeholder={props.kind === 'karakter' ? 'mis. Bu Sari' : 'mis. Pasar Ikan'} className={inputClass} value={name} onChange={e => setName(e.target.value)} />
      {props.anchors ? (
        <input aria-label="Anchor visual baru" placeholder="Fakta yang bisa dilihat, pisahkan dengan koma: mis. rambut kepang, kebaya hijau lumut"
          className={inputClass} value={look} onChange={e => setLook(e.target.value)} />
      ) : (
        <textarea aria-label="Deskripsi visual baru (English)" placeholder={props.kind === 'karakter' ? 'age, face, hair, outfit, one signature prop' : 'place, time of day, materials, weather'}
          className={`${textareaClass} min-h-16`} value={look} onChange={e => setLook(e.target.value)} />
      )}
      <div className="flex gap-1.5">
        <Button size="sm" disabled={!tokenOf(name) || !look.trim()} onClick={() => void props.onAdd(name.trim(), look.trim()).then(ok => ok && props.onCancel())}>Tambah</Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>Batal</Button>
      </div>
    </div>
  );
}

function engineOf(board: Board): EngineSet {
  const e = board.engine as EngineSet | undefined;
  return e && typeof e === 'object' ? e : {};
}

/** "4 klip × ±$0,30 = ±$1,20" (OpenRouter) or "4 klip × 10 kredit Flow = ±40 kredit". */
function estimateLine(kind: MediaKind, engine: Engine, catalog: EngineCatalog, count: number): string {
  const unit = kind === 'video' ? 'klip' : 'gambar';
  if (isAxcel(engine)) return `${count} ${unit} · Axcel ${engine.model} · termasuk paket, 0 kredit Flow`;
  if (!isOpenRouter(engine)) return kind === 'video' ? `${count} klip × ${CREDITS_PER_SHOT} kredit Flow = ±${count * CREDITS_PER_SHOT} kredit` : `${count} gambar · gratis di Flow`;
  const model = openRouterOption(catalog, kind, engine).model;
  if (!model && catalog.status === 'loading') return `${count} ${unit} · memuat harga OpenRouter…`;
  const total = estimateUsd(kind, model, count);
  const each = kind === 'video' ? model?.usdPerClip : model?.usdPerImage;
  return total === null || typeof each !== 'number' ? `${count} ${unit} × harga OpenRouter belum diketahui` : `${count} ${unit} × ±${fmtUsd(each)} = ±${fmtUsd(total)}`;
}

/** Axcel's models of one kind (the catalog's, else just the current one); a model that is down says so. */
function AxcelModelChoice(props: { kind: MediaKind; value: string; catalog: EngineCatalog; disabled: boolean; onChange: (model: string) => void }) {
  const listed = (props.catalog.axcelModels ?? []).filter(m => m.kind === props.kind);
  const models = listed.some(m => m.id === props.value) ? listed : [{ id: props.value, name: props.value, down: false }, ...listed];
  return (
    <Choice label={`Model Axcel (${props.kind === 'video' ? 'video' : 'gambar'})`} size="sm" disabled={props.disabled} className="w-full"
      value={props.value} onChange={props.onChange}
      options={models.map(m => ({ value: m.id, label: m.down ? `${m.name} · gangguan di Axcel` : m.name }))} />
  );
}

type AudioMode = 'narration' | 'ambient';
const AUDIO_OPTIONS: Array<{ value: AudioMode; label: string }> = [
  { value: 'narration', label: 'Narasi + suara ambien' },
  { value: 'ambient', label: 'Ambien saja — tanpa suara & musik' }
];

function EngineSection(props: { board: Board; locked: boolean; catalog: EngineCatalog; onSave: (engine: EngineSet) => void; onAudio: (mode: AudioMode) => void }) {
  const { board } = props;
  const engine = engineOf(board);
  const image = engine.image ?? FLOW;
  const video = engine.video ?? FLOW;
  const clips = board.shots.length;
  const images = clips + Object.keys(board.characters ?? {}).length;
  const set = (kind: MediaKind, e: Engine) => props.onSave({ ...engine, [kind]: e });
  return (
    <Section id="bd-engine" title="Mesin produksi" hint="Google Flow gratis lewat pool akun; OpenRouter dibayar per pemakaian; Axcel termasuk paket. Berlaku untuk gambar dan klip yang dibuat berikutnya.">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          {board.mode === 'cepat' ? (
            <>
              <span className="text-[12px] text-muted-foreground">Mesin gambar</span>
              <p className="text-[12.5px] text-muted-foreground">Tidak dipakai di mode Cepat — shot langsung dibuat dari teks ke video.</p>
            </>
          ) : (
            <>
              <EngineChoice label="Mesin gambar" showLabel kind="image" catalog={props.catalog} value={image} disabled={props.locked} onChange={e => set('image', e)} className="w-full" />
              {isAxcel(image) && <AxcelModelChoice kind="image" value={image.model} catalog={props.catalog} disabled={props.locked} onChange={model => set('image', { provider: 'axcel', model })} />}
              <span className="text-[11.5px] text-muted-foreground tabular-nums">Lembar karakter + keyframe: {estimateLine('image', image, props.catalog, images)}</span>
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <EngineChoice label="Mesin video" showLabel kind="video" catalog={props.catalog} value={video} disabled={props.locked} onChange={e => set('video', e)} className="w-full" />
          {isAxcel(video) && <AxcelModelChoice kind="video" value={video.model} catalog={props.catalog} disabled={props.locked} onChange={model => set('video', { provider: 'axcel', model })} />}
          <span className="text-[11.5px] text-muted-foreground tabular-nums">{estimateLine('video', video, props.catalog, clips)}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
          <Choice label="Suara klip" showLabel size="sm" disabled={props.locked} className="w-full sm:w-80"
            value={board.audioMode === 'ambient' ? 'ambient' : 'narration'} options={AUDIO_OPTIONS} onChange={props.onAudio} />
          <span className="text-[11.5px] text-muted-foreground">
            {board.audioMode === 'ambient' ? 'Klip tanpa suara orang dan tanpa musik — hanya suara tempatnya. Musik dan narasi ditambahkan nanti saat menyunting.' : 'Narasi tiap shot diucapkan di klip, ditambah suara tempatnya.'}
          </span>
        </div>
      </div>
    </Section>
  );
}

export function BreakdownTab() {
  const p = useProject();
  const { fetchImpl } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const load = useCallback(() => api.catalog(), [api]);
  const { catalog } = useCatalog(load, 0);
  const [adding, setAdding] = useState<'karakter' | 'lokasi'>();
  const [doomed, setDoomed] = useState<string>();
  const engines = useEngines(fetchImpl);
  const { board, story } = p;
  if (!board || !story) return null;
  const locked = ['casting', 'framing', 'rendering', 'assembling'].includes(story.status);
  const castState = new Map((story.cast ?? []).map(c => [c.token, c]));

  const bible = !!board.bible;
  const cards = bible ? cardsOf(board) : [];
  const characters = Object.entries(board.characters ?? {}).map(([token, spec]) => ({ token, ...asSpec(token, spec), ...shotsUsing(board, token) }));
  const lookdev = (key: string) => {
    const raw = (board.bible as { locations?: Array<{ key?: unknown; lookdev?: unknown }> } | undefined)?.locations;
    const card = Array.isArray(raw) ? raw.find(l => l?.key === key) : undefined;
    return typeof card?.lookdev === 'string' && card.lookdev.trim() ? card.lookdev : undefined;
  };
  const locations = Object.entries(board.locations ?? {}).map(([key, l]) => ({ key, ...l, look: lookdev(key) ?? l.look, scenes: (board.scenes ?? []).filter(s => s.location === key) }));
  /** Bible boards: a location is written on both sides at once (bible lookdev = board look), so nothing is left to mirror. */
  const withLocation = (b: Board, key: string, next: { name: string; look: string } | null): Board => {
    const locs = { ...b.locations };
    if (next) locs[key] = next; else delete locs[key];
    if (!b.bible) return { ...b, locations: locs };
    const raw = (b.bible as Record<string, unknown>);
    const cards = Array.isArray(raw.locations) ? (raw.locations as Array<Record<string, unknown>>) : [];
    const card = next ? { ...(cards.find(c => c.key === key) ?? {}), key, name: next.name, lookdev: next.look } : null;
    const list = card ? (cards.some(c => c.key === key) ? cards.map(c => (c.key === key ? card : c)) : [...cards, card]) : cards.filter(c => c.key !== key);
    return { ...b, locations: locs, bible: { ...raw, locations: list } };
  };

  const saveCharacter = (token: string, name: string, look: string) => p.save({ ...board, characters: { ...board.characters, [token]: { name, look } } });
  const addCharacter = async (name: string, look: string) => {
    const token = tokenOf(name);
    if (!TOKEN_RE.test(token) || board.characters?.[token]) return false;
    return p.save({ ...board, characters: { ...board.characters, [token]: { name, look } } });
  };
  const removeCharacter = (token: string) => { const c = { ...board.characters }; delete c[token]; void p.save({ ...board, characters: c }); };
  const addCard = async (name: string, anchorText: string) => {
    const token = tokenOf(name);
    if (!TOKEN_RE.test(token) || cards.some(c => c.token === token) || board.characters?.[token]) return false;
    const anchors = anchorText.split(',').map(a => a.trim()).filter(Boolean);
    // Both sides at once (like locations): the bible card, and the cast entry the sheet and TOKEN expansion read
    // (same "name, anchors" look the server mirrors for a new card).
    const next = withCard(board, token, { token, name, anchors, want: '', need: '', arc: '' });
    return p.save({ ...next, characters: { ...board.characters, [token]: [name.trim(), ...anchors].join(', ') } });
  };
  const saveLocation = (key: string, name: string, look: string) => p.save(withLocation(board, key, { name, look }));
  const addLocation = async (name: string, look: string) => {
    const key = tokenOf(name);
    if (!TOKEN_RE.test(key) || board.locations?.[key]) return false;
    return p.save(withLocation(board, key, { name, look }));
  };
  const removeLocation = (key: string) => {
    const b = withLocation(board, key, null);
    void p.save({ ...b, scenes: (board.scenes ?? []).map(s => (s.location === key ? { ...s, location: undefined } : s)) });
    setDoomed(undefined);
  };

  const bibleCast = cards.length === 0 ? (
    <p className="text-[12.5px] text-muted-foreground">Belum ada karakter. Cerita faceless boleh tanpa karakter; untuk tokoh berulang, tambahkan di sini lalu sebut dengan @ di subjek shot.</p>
  ) : (
    <ul className="flex flex-col">
      {cards.map(c => {
        const used = shotsUsing(board, c.token).shots.length;
        return (
          <CharacterCard key={c.token} card={c} engine={engineOf(board)} locked={locked}
            deleteBlocked={used ? `Dipakai di ${used} shot — ganti subjek shot itu dulu` : undefined}
            onDelete={() => void p.save(withCard(board, c.token, null))} />
        );
      })}
    </ul>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-muted-foreground">
        Bible produksi: siapa, di mana, dan seperti apa gayanya. Mengubah deskripsi berarti lembar karakter dan keyframe shot yang memakainya dibuat ulang (gratis); shot lain tidak tersentuh.
        {locked && <span className="text-foreground"> Sedang diproses — tunggu selesai untuk mengubah.</span>}
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        <Section id="bd-cast" title="Karakter" hint="Satu lembar referensi per karakter menjaga wajah dan kostum sama di semua shot."
          action={<Button size="sm" variant="glass" disabled={locked || adding === 'karakter'} onClick={() => setAdding('karakter')}><Plus /> Tambah karakter</Button>}>
          {adding === 'karakter' && <AddForm kind="karakter" anchors={bible} onAdd={bible ? addCard : addCharacter} onCancel={() => setAdding(undefined)} />}
          {bible ? bibleCast : characters.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">Belum ada karakter. Cerita faceless boleh tanpa karakter; untuk tokoh berulang, tambahkan di sini lalu tulis TOKEN-nya (mis. <code>BU_SARI</code>) di prompt shot.</p>
          ) : (
            <ul className="flex flex-col">
              {characters.map(c => {
                const st = castState.get(c.token);
                return (
                  <Entry key={c.token} name={c.name} look={c.look} icon={<UserRound />} locked={locked}
                    image={st?.status === 'done' ? <img src={sized(media.cast(p.id, c.token, st.mediaId ?? ''), 64 * 2)} width={64} height={64} alt="" loading="lazy" decoding="async" className="size-full object-cover" /> : undefined}
                    status={st ? <Badge variant="secondary" className="h-4.5 px-1.5 text-[10.5px]">{st.status === 'done' ? 'Lembar siap' : st.status === 'failed' ? 'Gagal' : st.status === 'queued' ? 'Dibuat…' : 'Belum dibuat'}</Badge> : undefined}
                    meta={c.shots.length ? `${c.shots.length} shot · ${c.scenes.map(s => s.title).join(', ')} · token ${c.token}` : `Belum muncul di shot mana pun · token ${c.token}`}
                    deleteBlocked={c.shots.length ? `Dipakai di ${c.shots.length} shot — hapus TOKEN dari prompt dulu` : undefined}
                    onSave={(name, look) => saveCharacter(c.token, name, look)} onDelete={() => removeCharacter(c.token)} />
                );
              })}
            </ul>
          )}
          {bible && story.mode === 'konsisten' && !isOpenRouter(engineOf(board).image) && cards.length > 0 && (
            <p className="text-[11.5px] text-muted-foreground">Referensi dipakai mesin OpenRouter; Flow memakai sheet yang dibuat.</p>
          )}
        </Section>

        <Section id="bd-loc" title="Lokasi" hint="Setting yang sama untuk semua shot dalam scene yang memakainya."
          action={<Button size="sm" variant="glass" disabled={locked || adding === 'lokasi'} onClick={() => setAdding('lokasi')}><Plus /> Tambah lokasi</Button>}>
          {adding === 'lokasi' && <AddForm kind="lokasi" onAdd={addLocation} onCancel={() => setAdding(undefined)} />}
          {locations.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">Belum ada lokasi. Tambahkan lalu pilih lokasinya di tiap scene supaya latar tidak berubah-ubah.</p>
          ) : (
            <ul className="flex flex-col">
              {locations.map(l => (
                <Entry key={l.key} name={l.name} look={l.look} icon={<MapPin />} locked={locked}
                  meta={`${l.scenes.length ? `Dipakai di scene: ${l.scenes.map(s => s.title).join(', ')}` : 'Belum dipakai scene mana pun'} · key ${l.key}`}
                  onSave={(name, look) => saveLocation(l.key, name, look)} onDelete={() => setDoomed(l.key)} />
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section id="bd-look" title="Gaya visual" hint="Satu baris Style yang dipakai lembar karakter, keyframe dan klip. Mengubahnya membuat ulang semuanya.">
        {catalog ? (
          <LookChips catalog={catalog} look={{ ...DEFAULT_LOOK, ...(board.look ?? {}) } as Look} disabled={locked}
            onChange={patch => void p.setLook(patch as Record<string, string>)} />
        ) : <p className="text-[12px] text-muted-foreground">Memuat pilihan gaya…</p>}
        {board.style && <p className="font-mono text-[11.5px] leading-relaxed text-muted-foreground">{board.style}</p>}
      </Section>

      <EngineSection board={board} locked={locked} catalog={engines} onSave={engine => void p.save({ ...board, engine })}
        onAudio={mode => void p.save({ ...board, audioMode: mode === 'ambient' ? 'ambient' : undefined })} />

      <AlertDialog open={!!doomed} onOpenChange={o => { if (!o) setDoomed(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus lokasi "{doomed && board.locations?.[doomed]?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>Scene yang memakainya jadi tanpa lokasi; keyframe scene itu perlu dibuat ulang.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => doomed && removeLocation(doomed)}>Ya, hapus</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
