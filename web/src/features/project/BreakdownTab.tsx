/**
 * Breakdown: the film's bible — who (characters), where (locations) and how it looks (style).
 * Everything here feeds every shot: a character's look becomes its reference sheet, a
 * location's look becomes the "Setting:" of every shot in the scenes that use it.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { MapPin, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { useSession } from '../../lib/session.js';
import { inputClass, textareaClass } from '../../ui/controls.js';
import { storiesApi } from '../stories/storiesClient.js';
import { DEFAULT_LOOK, useCatalog, type Look } from '../stories/catalog.js';
import { LookChips } from '../stories/LookChips.js';
import '../stories/studio.css';
import { media, useProject } from './useProject.js';
import type { Board, CharacterSpec } from './model.js';

const TOKEN_RE = /^[A-Z][A-Z0-9_]{1,30}$/;
const tokenOf = (name: string) => name.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 30);
const titleCase = (t: string) => t.toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const asSpec = (token: string, s: CharacterSpec) => (typeof s === 'string' ? { name: titleCase(token), look: s } : { name: s.name || titleCase(token), look: s.look });
const uses = (b: Board, token: string) => {
  const re = new RegExp(`\\b${token}\\b`);
  const shots = b.shots.filter(s => re.test(s.prompt));
  const scenes = (b.scenes ?? []).filter(sc => sc.shots.some(id => shots.some(s => s.id === id)));
  return { shots, scenes };
};

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
            <input aria-label={`Nama ${props.name}`} className={inputClass} value={name} onChange={e => setName(e.target.value)} />
            <textarea aria-label="Deskripsi visual (English)" className={`${textareaClass} min-h-16`} value={look} onChange={e => setLook(e.target.value)} />
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

function AddForm(props: { kind: 'karakter' | 'lokasi'; onAdd: (name: string, look: string) => Promise<boolean>; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [look, setLook] = useState('');
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-dashed p-2.5">
      <input aria-label={`Nama ${props.kind}`} placeholder={props.kind === 'karakter' ? 'mis. Bu Sari' : 'mis. Pasar Ikan'} className={inputClass} value={name} onChange={e => setName(e.target.value)} />
      <textarea aria-label="Deskripsi visual baru (English)" placeholder={props.kind === 'karakter' ? 'age, face, hair, outfit, one signature prop' : 'place, time of day, materials, weather'}
        className={`${textareaClass} min-h-16`} value={look} onChange={e => setLook(e.target.value)} />
      <div className="flex gap-1.5">
        <Button size="sm" disabled={!tokenOf(name) || !look.trim()} onClick={() => void props.onAdd(name.trim(), look.trim()).then(ok => ok && props.onCancel())}>Tambah</Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>Batal</Button>
      </div>
    </div>
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
  const { board, story } = p;
  if (!board || !story) return null;
  const locked = ['casting', 'framing', 'rendering', 'assembling'].includes(story.status);
  const castState = new Map((story.cast ?? []).map(c => [c.token, c]));

  const characters = Object.entries(board.characters ?? {}).map(([token, spec]) => ({ token, ...asSpec(token, spec), ...uses(board, token) }));
  const locations = Object.entries(board.locations ?? {}).map(([key, l]) => ({ key, ...l, scenes: (board.scenes ?? []).filter(s => s.location === key) }));

  const saveCharacter = (token: string, name: string, look: string) => p.save({ ...board, characters: { ...board.characters, [token]: { name, look } } });
  const addCharacter = async (name: string, look: string) => {
    const token = tokenOf(name);
    if (!TOKEN_RE.test(token) || board.characters?.[token]) return false;
    return p.save({ ...board, characters: { ...board.characters, [token]: { name, look } } });
  };
  const removeCharacter = (token: string) => { const c = { ...board.characters }; delete c[token]; void p.save({ ...board, characters: c }); };
  const saveLocation = (key: string, name: string, look: string) => p.save({ ...board, locations: { ...board.locations, [key]: { name, look } } });
  const addLocation = async (name: string, look: string) => {
    const key = tokenOf(name);
    if (!TOKEN_RE.test(key) || board.locations?.[key]) return false;
    return p.save({ ...board, locations: { ...board.locations, [key]: { name, look } } });
  };
  const removeLocation = (key: string) => {
    const l = { ...board.locations };
    delete l[key];
    void p.save({ ...board, locations: l, scenes: (board.scenes ?? []).map(s => (s.location === key ? { ...s, location: undefined } : s)) });
    setDoomed(undefined);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-muted-foreground">
        Bible produksi: siapa, di mana, dan seperti apa gayanya. Mengubah deskripsi berarti lembar karakter dan keyframe shot yang memakainya dibuat ulang (gratis); shot lain tidak tersentuh.
        {locked && <span className="text-foreground"> Sedang diproses — tunggu selesai untuk mengubah.</span>}
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        <Section id="bd-cast" title="Karakter" hint="Satu lembar referensi per karakter menjaga wajah dan kostum sama di semua shot."
          action={<Button size="sm" variant="glass" disabled={locked || adding === 'karakter'} onClick={() => setAdding('karakter')}><Plus /> Tambah karakter</Button>}>
          {adding === 'karakter' && <AddForm kind="karakter" onAdd={addCharacter} onCancel={() => setAdding(undefined)} />}
          {characters.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">Belum ada karakter. Cerita faceless boleh tanpa karakter; untuk tokoh berulang, tambahkan di sini lalu tulis TOKEN-nya (mis. <code>BU_SARI</code>) di prompt shot.</p>
          ) : (
            <ul className="flex flex-col">
              {characters.map(c => {
                const st = castState.get(c.token);
                return (
                  <Entry key={c.token} name={c.name} look={c.look} icon={<UserRound />} locked={locked}
                    image={st?.status === 'done' ? <img src={media.cast(p.id, c.token, st.mediaId ?? '')} alt="" loading="lazy" className="size-full object-cover" /> : undefined}
                    status={st ? <Badge variant="secondary" className="h-4.5 px-1.5 text-[10.5px]">{st.status === 'done' ? 'Lembar siap' : st.status === 'failed' ? 'Gagal' : st.status === 'queued' ? 'Dibuat…' : 'Belum dibuat'}</Badge> : undefined}
                    meta={c.shots.length ? `${c.shots.length} shot · ${c.scenes.map(s => s.title).join(', ')} · token ${c.token}` : `Belum muncul di shot mana pun · token ${c.token}`}
                    deleteBlocked={c.shots.length ? `Dipakai di ${c.shots.length} shot — hapus TOKEN dari prompt dulu` : undefined}
                    onSave={(name, look) => saveCharacter(c.token, name, look)} onDelete={() => removeCharacter(c.token)} />
                );
              })}
            </ul>
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
                  meta={l.scenes.length ? `Dipakai di scene: ${l.scenes.map(s => s.title).join(', ')}` : 'Belum dipakai scene mana pun'}
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
