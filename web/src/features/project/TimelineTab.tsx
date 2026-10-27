/**
 * Timeline tab, Premiere-style: a small program monitor on top (every shot in order; rendered
 * clips play, the rest show their keyframe), then tracks on one time ruler — Scene bands,
 * Video V1 (one clip per shot, width = its trimmed duration, In/Out handles on its edges), A1 the
 * clips' own sound (volume), A2 a music track (upload, start, volume) and T1 the subtitles (the
 * narration lines, burned in when switched on); edits apply when the video is assembled. Drag clips or scene bands to
 * reorder (dnd-kit, mouse + keyboard); the inspector strip under the tracks does the same with
 * buttons. Only this tab scrolls sideways.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  closestCenter, DndContext, KeyboardSensor, PointerSensor, pointerWithin, useSensor, useSensors,
  type Announcements, type CollisionDetection, type DragEndEvent
} from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowLeft, ArrowRight, Clapperboard, FolderInput, Film, Music, RotateCcw, Trash2, Upload, Volume2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { SecondsField, Segmented, fmtSeconds } from '../../ui/controls.js';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useSession } from '../../lib/session.js';
import { storiesApi } from '../stories/storiesClient.js';
import { fmtDuration, moveShot, type Board } from './model.js';
import { media, useProject } from './useProject.js';
import { sized } from '../../lib/media.js';
import { SequencePlayer } from './Player.js';
import {
  boardOrder, editOf, formatSeconds, MIN_CLIP, nudgeScene, nudgeShot, rulerTicks, sceneKey, sequenceClips, shotKey, timelineDrop, timelineLayout,
  withEdit, withTrim, type ClipStatus, type MusicEdit, type TimelineClip, type TimelineScene, type Trim
} from './TimelineModel.js';

type Zoom = '50' | '100' | '200';
const PX_PER_SECOND: Record<Zoom, number> = { '50': 8, '100': 16, '200': 32 };
/** An empty scene still gets a slot on every track so it can be seen, selected and dropped on. */
const EMPTY_SCENE_PX = 44;
const HEADER = 'sticky left-0 z-20 flex w-14 shrink-0 items-center border-r border-border/60 bg-background px-2 text-[10.5px] font-medium text-muted-foreground';

const SCENE_HUES = [250, 160, 30, 310, 95, 200, 0, 130];
export const sceneColor = (i: number, a = 0.3) => `oklch(0.68 0.11 ${SCENE_HUES[i % SCENE_HUES.length]} / ${a})`;

export const STATUS_TEXT: Record<ClipStatus, string> = { done: 'Selesai', queued: 'Antre render', failed: 'Gagal', pending: 'Belum dirender' };
export const STATUS_BAR: Record<ClipStatus, string> = { done: 'bg-(--success)', queued: 'bg-(--warning)', failed: 'bg-destructive', pending: 'bg-muted-foreground/35' };

type Selection = { kind: 'shot' | 'scene'; id: string } | { kind: 'music' | 'audio'; id?: undefined } | undefined;
/** Keyboard trims and volume slides save once you stop (one revision, not one per key). */
const COMMIT_MS = 600;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const DEFAULT_MUSIC_VOLUME = 0.35;

/** The trim a handle produces: In moves the start, Out the end; Out at the clip's end = no Out. */
function trimFrom(clip: TimelineClip, side: 'in' | 'out', value: number): Trim {
  const inAt = side === 'in' ? value : clip.trimIn;
  const outAt = side === 'out' ? value : clip.trimOut;
  return { ...(inAt > 0 ? { in: r1(inAt) } : {}), ...(outAt !== undefined && outAt < clip.full ? { out: r1(outAt) } : {}) };
}
function trimRange(clip: TimelineClip, side: 'in' | 'out') {
  const end = clip.trimIn + clip.seconds;
  return side === 'in'
    ? { min: 0, max: r1(Math.max(0, end - MIN_CLIP)), now: r1(clip.trimIn) }
    : { min: r1(clip.trimIn + MIN_CLIP), max: r1(clip.full), now: r1(end) };
}

/** In/Out handle on a clip edge: drag it, or focus it and use ←/→ (Shift = 1 s). Saves when you stop. */
function TrimHandle(props: { clip: TimelineClip; side: 'in' | 'out'; pps: number; onChange: (t: Trim) => void; onCommit: (now: boolean) => void }) {
  const { clip, side } = props;
  const range = trimRange(clip, side);
  const drag = useRef<{ x: number; v: number } | undefined>(undefined);
  const set = (v: number) => props.onChange(trimFrom(clip, side, Math.min(range.max, Math.max(range.min, v))));
  const label = `Trim ${side === 'in' ? 'awal' : 'akhir'} shot ${clip.index + 1}`;
  const trimmed = side === 'in' ? clip.trimIn > 0 : clip.trimOut !== undefined;
  return (
    <div role="slider" tabIndex={0} aria-label={label} aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={range.now}
      aria-valuetext={`${fmtSeconds(range.now)} detik`} title={`${label} · ${fmtSeconds(range.now)} dtk — tarik, atau ←/→`}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => { e.stopPropagation(); e.currentTarget.setPointerCapture?.(e.pointerId); drag.current = { x: e.clientX, v: range.now }; }}
      onPointerMove={(e: ReactPointerEvent<HTMLDivElement>) => { if (drag.current) set(drag.current.v + (e.clientX - drag.current.x) / props.pps); }}
      onPointerUp={() => { if (drag.current) { drag.current = undefined; props.onCommit(true); } }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        set(range.now + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 0.1));
        props.onCommit(false);
      }}
      className={cn('absolute top-0 z-20 h-full w-1.5 cursor-ew-resize outline-none hover:bg-foreground/60 focus-visible:bg-(--brand)',
        side === 'in' ? 'left-0 rounded-l-[4px]' : 'right-0 rounded-r-[4px]', trimmed ? 'bg-(--brand)/80' : 'bg-transparent')} />
  );
}

/** Scenes only land on scenes; a shot lands on whatever is under the pointer (clip or scene band), else the nearest clip. */
const collide: CollisionDetection = args => {
  const only = (prefix: string) => args.droppableContainers.filter(c => String(c.id).startsWith(prefix));
  if (String(args.active.id).startsWith('scene:')) return closestCenter({ ...args, droppableContainers: only('scene:') });
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCenter({ ...args, droppableContainers: only('shot:') });
};

const name = (id: string | number) => String(id).replace(/^(shot|scene):/, '');
const announcements: Announcements = {
  onDragStart: ({ active }) => `Mengangkat ${name(active.id)}.`,
  onDragOver: ({ active, over }) => (over ? `${name(active.id)} di atas ${name(over.id)}.` : `${name(active.id)} tidak di atas target.`),
  onDragEnd: ({ active, over }) => (over ? `${name(active.id)} dilepas di ${name(over.id)}.` : `${name(active.id)} dilepas.`),
  onDragCancel: ({ active }) => `Batal memindah ${name(active.id)}.`
};
const instructions = { draggable: 'Tekan spasi untuk mengangkat, panah kiri/kanan untuk menggeser, spasi lagi untuk melepas, Escape untuk batal.' };

function SceneBand(props: { scene: TimelineScene; pps: number; selected: boolean; onSelect: () => void }) {
  const { scene } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({ id: sceneKey(scene.id) });
  const width = scene.shots ? scene.seconds * props.pps : EMPTY_SCENE_PX;
  return (
    <li className="contents">
      <button ref={setNodeRef} type="button" {...attributes} {...listeners} aria-label={`Scene ${scene.title}`} aria-pressed={props.selected}
        title={scene.shots ? `${scene.title} · ${scene.shots} shot · ${formatSeconds(scene.seconds)}` : `${scene.title} · kosong — tarik klip ke sini`} onClick={props.onSelect}
        style={{ width, transform: CSS.Translate.toString(transform), transition, backgroundColor: sceneColor(scene.index, isOver ? 0.5 : 0.28), borderLeftColor: sceneColor(scene.index, 1) }}
        className={cn('relative flex h-6 shrink-0 items-center gap-1 overflow-hidden rounded-[4px] border-l-2 px-1.5 text-left text-[11px] whitespace-nowrap text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring',
          props.selected && 'ring-1 ring-foreground/70', isDragging && 'z-30 opacity-80 shadow-lg')}>
        <span className={cn('truncate', !scene.shots && 'text-muted-foreground italic')}>{scene.title}</span>
      </button>
    </li>
  );
}

function ClipItem(props: {
  clip: TimelineClip; pps: number; thumb?: string; selected: boolean; playing: boolean; onSelect: () => void;
  onTrim: (t: Trim) => void; onTrimCommit: (now: boolean) => void;
}) {
  const { clip } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: shotKey(clip.shotId) });
  const width = clip.seconds * props.pps;
  // Only a rendered clip has a real length to trim inside.
  const trimmable = clip.status === 'done' && width >= 24 && !isDragging;
  return (
    <li className="relative shrink-0">
      {trimmable && <TrimHandle clip={clip} side="in" pps={props.pps} onChange={props.onTrim} onCommit={props.onTrimCommit} />}
      {trimmable && <TrimHandle clip={clip} side="out" pps={props.pps} onChange={props.onTrim} onCommit={props.onTrimCommit} />}
      <button ref={setNodeRef} type="button" {...attributes} {...listeners}
        aria-label={`Shot ${clip.index + 1}: ${clip.shotId}`} aria-pressed={props.selected} aria-current={props.playing ? 'true' : undefined}
        data-status={clip.status} title={`Shot ${clip.index + 1} · ${clip.shotId} · ${fmtDuration(clip.seconds)} · ${STATUS_TEXT[clip.status]}`} onClick={props.onSelect}
        style={{ width, transform: CSS.Translate.toString(transform), transition }}
        className={cn('relative flex h-12 shrink-0 overflow-hidden rounded-[4px] border border-border/70 bg-muted text-left outline-none focus-visible:ring-1 focus-visible:ring-ring',
          props.playing && 'border-(--brand)', props.selected && 'ring-1 ring-foreground', isDragging && 'z-30 opacity-80 shadow-lg')}>
        {props.thumb && width >= 28 && <img src={sized(props.thumb, 32)} width={32} height={48} alt={`Keyframe shot ${clip.index + 1}`} loading="lazy" decoding="async" className="h-full w-8 shrink-0 object-cover opacity-90" />}
        <span className="flex min-w-0 flex-1 flex-col justify-center px-1 leading-tight">
          <span className="text-[11px] font-medium tabular-nums">{clip.index + 1}</span>
          {width >= 72 && <span className="truncate text-[10px] text-muted-foreground">{clip.shotId}</span>}
        </span>
        <span aria-hidden="true" className={cn('absolute inset-x-0 bottom-0 h-0.5', STATUS_BAR[clip.status])} />
      </button>
    </li>
  );
}

/** A 0..max volume (100 % = as rendered); moves live, saves when you stop. */
function VolumeSlider(props: { label: string; value: number; max: number; step: number; disabled?: boolean; onCommit: (v: number) => void }) {
  const [v, setV] = useState(props.value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setV(props.value), [props.value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="flex items-center gap-2">
      <Volume2 className="size-3.5 text-muted-foreground" />
      <Slider thumbLabel={props.label} className="w-36" min={0} max={props.max} step={props.step} value={[v]} disabled={props.disabled}
        onValueChange={value => {
          const n = r2(Array.isArray(value) ? value[0]! : (value as number));
          setV(n);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => props.onCommit(n), COMMIT_MS);
        }} />
      <span className="w-10 text-[12px] tabular-nums">{Math.round(v * 100)}%</span>
    </div>
  );
}

function Labelled(props: { label: string; children: ReactNode }) {
  return <div className="flex items-center gap-1.5"><span className="text-[11px] text-muted-foreground">{props.label}</span>{props.children}</div>;
}

function Inspector(props: {
  board: Board; clips: TimelineClip[]; scenes: TimelineScene[]; selection: NonNullable<Selection>; busy: boolean; total: number;
  apply: (next: Board) => void; save: (next: Board) => void; pickMusic: () => void;
}) {
  const { board, selection, busy, apply, save } = props;
  const edit = editOf(board);
  const panel = 'glass-panel flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg px-3 py-2';

  if (selection.kind === 'audio') {
    const volume = edit.clipVolume ?? 1;
    return (
      <section aria-label="Inspector" className={panel}>
        <span className="text-[12.5px] font-medium">A1 · Suara klip</span>
        <VolumeSlider label="Volume suara klip" value={volume} max={1.5} step={0.1} disabled={busy}
          onCommit={v => save(withEdit(board, { clipVolume: v === 1 ? undefined : v }))} />
        <span className="text-[11.5px] text-muted-foreground">Suara tempat dari klip yang dirender; dipakai saat video dirakit.</span>
      </section>
    );
  }

  if (selection.kind === 'music') {
    const m = edit.music;
    if (!m) return null;
    const music = (patch: Partial<MusicEdit>) => save(withEdit(board, { music: { ...m, ...patch } }));
    return (
      <section aria-label="Inspector" className={panel}>
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium"><Music className="size-3.5" /><span className="max-w-56 truncate">A2 · {m.name}</span>
          <span className="text-muted-foreground tabular-nums">{formatSeconds(m.seconds)}</span></span>
        <VolumeSlider label="Volume musik" value={m.volume} max={1} step={0.05} disabled={busy} onCommit={v => music({ volume: v })} />
        <Labelled label="Mulai di">
          <SecondsField label="Mulai di timeline (detik)" value={m.at} min={0} max={r1(props.total)} disabled={busy} onCommit={v => music({ at: v })} />
        </Labelled>
        <Labelled label="Dari detik lagu">
          <SecondsField label="Mulai dari detik lagu (detik)" value={m.from ?? 0} min={0} max={r1(Math.max(0, m.seconds - 1))} disabled={busy} onCommit={v => music({ from: v || undefined })} />
        </Labelled>
        <div className="ml-auto flex gap-1">
          <Button size="xs" variant="glass" disabled={busy} onClick={props.pickMusic}><Upload /> Ganti musik</Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => save(withEdit(board, { music: undefined }))} aria-label="Hapus musik"><Trash2 /> Hapus</Button>
        </div>
      </section>
    );
  }
  const row = (k: string, v: string) => (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="text-[11px] text-muted-foreground">{k}</dt>
      <dd className="min-w-0 truncate text-[12px]">{v}</dd>
    </div>
  );
  const nudge = (left: Board, right: Board) => (
    <>
      <Button size="xs" variant="glass" disabled={busy || left === board} onClick={() => apply(left)}><ArrowLeft /> Geser kiri</Button>
      <Button size="xs" variant="glass" disabled={busy || right === board} onClick={() => apply(right)}>Geser kanan <ArrowRight /></Button>
    </>
  );

  if (selection.kind === 'scene') {
    const scene = props.scenes.find(s => s.id === selection.id);
    if (!scene) return null;
    return (
      <section aria-label="Inspector" className="glass-panel flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg px-3 py-2">
        <span className="flex items-center gap-1.5 text-[12.5px] font-medium"><span aria-hidden="true" className="size-2.5 rounded-sm" style={{ backgroundColor: sceneColor(scene.index, 1) }} />Scene {scene.index + 1} · {scene.title}</span>
        <dl className="flex flex-wrap gap-x-4 gap-y-1">
          {row('Isi', `${scene.shots} shot`)}
          {row('Durasi', formatSeconds(scene.seconds))}
        </dl>
        <div className="ml-auto flex gap-1">{nudge(nudgeScene(board, scene.id, -1), nudgeScene(board, scene.id, 1))}</div>
      </section>
    );
  }

  const clip = props.clips.find(c => c.shotId === selection.id);
  if (!clip) return null;
  const scene = props.scenes.find(s => s.id === clip.sceneId);
  const others = props.scenes.filter(s => s.id !== clip.sceneId);
  return (
    <section aria-label="Inspector" className="glass-panel flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg px-3 py-2">
      <span className="text-[12.5px] font-medium tabular-nums">Shot {clip.index + 1} · <span className="text-muted-foreground">{clip.shotId}</span></span>
      <dl className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1">
        {row('Scene', scene?.title ?? '—')}
        {row('Durasi', `${fmtDuration(clip.seconds)}`)}
        {row('Status', STATUS_TEXT[clip.status])}
        {row('Narasi', clip.narration)}
      </dl>
      {clip.status === 'done' ? (
        <div role="group" aria-label="Trim" className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Trim</span>
          <SecondsField label="Trim awal (detik)" value={r1(clip.trimIn)} min={0} max={trimRange(clip, 'in').max} disabled={busy}
            onCommit={v => save(withTrim(board, clip.shotId, trimFrom(clip, 'in', v)))} />
          <span className="text-muted-foreground">–</span>
          <SecondsField label="Trim akhir (detik)" value={trimRange(clip, 'out').now} min={trimRange(clip, 'out').min} max={r1(clip.full)} disabled={busy}
            onCommit={v => save(withTrim(board, clip.shotId, trimFrom(clip, 'out', v)))} />
          <span className="text-[11px] text-muted-foreground tabular-nums">dari {fmtSeconds(clip.full)} dtk</span>
          <Button size="xs" variant="ghost" disabled={busy || (clip.trimIn === 0 && clip.trimOut === undefined)} onClick={() => save(withTrim(board, clip.shotId, undefined))}>
            <RotateCcw /> Reset trim
          </Button>
        </div>
      ) : <span className="text-[11px] text-muted-foreground">Trim bisa diatur setelah klip dirender.</span>}
      <div className="flex gap-1">
        {nudge(nudgeShot(board, clip.shotId, -1), nudgeShot(board, clip.shotId, 1))}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="xs" variant="glass" disabled={busy || !others.length} />}><FolderInput /> Pindah ke scene…</DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Pindah ke akhir scene</DropdownMenuLabel>
              {others.map(s => (
                <DropdownMenuItem key={s.id} onClick={() => apply(moveShot(board, clip.shotId, s.id, Number.MAX_SAFE_INTEGER))}>
                  <span aria-hidden="true" className="size-2.5 rounded-sm" style={{ backgroundColor: sceneColor(s.index, 1) }} />{s.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </section>
  );
}

export function TimelineTab() {
  const p = useProject();
  const { id, story, board } = p;
  const { fetchImpl } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const [zoom, setZoom] = useState<Zoom>('100');
  // A trim being dragged/keyed: shown live, saved once (COMMIT_MS after the last key, or on release).
  const [draft, setDraft] = useState<{ shotId: string; trim: Trim }>();
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const boardRef = useRef(board);
  boardRef.current = board;
  const trimTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(trimTimer.current), []);
  const musicInput = useRef<HTMLInputElement>(null);
  const [musicBusy, setMusicBusy] = useState(false);
  const [musicError, setMusicError] = useState<string>();
  const [musicAt, setMusicAt] = useState<number>();
  const musicDrag = useRef<{ x: number; at: number; moved: boolean } | undefined>(undefined);
  const [selection, setSelection] = useState<Selection>();
  const [current, setCurrent] = useState(0);
  const [offset, setOffset] = useState(0);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] } })
  );
  const view = useMemo(() => (board && draft ? withTrim(board, draft.shotId, draft.trim) : board), [board, draft]);
  const layout = useMemo(() => (view ? timelineLayout(view, story) : undefined), [view, story]);
  const clips = useMemo(() => (view && story ? sequenceClips(id, view, story) : []), [id, view, story]);

  if (!board || !story || !layout) return null;
  if (!board.shots.length) {
    return (
      <Empty className="glass-panel rounded-lg py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Film /></EmptyMedia>
          <EmptyTitle>Belum ada shot di timeline</EmptyTitle>
          <EmptyDescription>Tambah shot di tab Scene; urutannya bisa diatur di sini dengan drag-and-drop.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const pps = PX_PER_SECOND[zoom];
  const empties = layout.scenes.filter(s => !s.shots);
  const px = (t: number) => t * pps + empties.filter(s => s.start <= t).length * EMPTY_SCENE_PX;
  const width = px(layout.total);
  const playing = layout.clips[current];
  const playhead = playing ? playing.start + Math.min(offset, playing.seconds) : 0;
  const busy = p.busy === 'save';

  const apply = async (next: Board) => {
    if (boardOrder(next) === boardOrder(board)) return;
    const ok = await p.save(next);
    if (!ok) return;
    if (selection?.kind === 'shot') {
      const at = timelineLayout(next, story).clips.findIndex(c => c.shotId === selection.id);
      if (at >= 0) setCurrent(at);
    }
  };
  const onDragEnd = (e: DragEndEvent) => void apply(timelineDrop(board, String(e.active.id), e.over ? String(e.over.id) : null));
  const save = (next: Board) => void p.save(next);
  const edit = editOf(board);
  const music = edit.music;

  const commitTrim = (now: boolean) => {
    clearTimeout(trimTimer.current);
    const run = () => {
      const d = draftRef.current;
      const b = boardRef.current;
      if (!d || !b) return;
      void p.save(withTrim(b, d.shotId, d.trim)).finally(() => setDraft(undefined));
    };
    if (now) run(); else trimTimer.current = setTimeout(run, COMMIT_MS);
  };

  const uploadMusic = async (file: File | undefined) => {
    if (!file) return;
    setMusicBusy(true);
    setMusicError(undefined);
    try {
      const up = await api.uploadMusic(id, file);
      const ok = await p.save(withEdit(board, { music: { file: up.file, name: up.name, seconds: up.seconds, volume: music?.volume ?? DEFAULT_MUSIC_VOLUME, at: music?.at ?? 0 } }));
      if (ok) setSelection({ kind: 'music' });
    } catch (e) {
      setMusicError(e instanceof Error ? e.message : 'Musik gagal diunggah');
    } finally {
      setMusicBusy(false);
      if (musicInput.current) musicInput.current.value = '';
    }
  };
  const musicStart = musicAt ?? music?.at ?? 0;
  const musicSpan = music ? Math.max(0.5, Math.min(music.seconds - (music.from ?? 0), layout.total - musicStart)) : 0;
  const selectShot = (c: TimelineClip) => { setSelection({ kind: 'shot', id: c.shotId }); setCurrent(c.index); };
  const selectScene = (s: TimelineScene) => {
    setSelection({ kind: 'scene', id: s.id });
    const first = layout.clips.find(c => c.sceneId === s.id);
    if (first) setCurrent(first.index);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="glass-panel flex flex-col gap-1 rounded-lg p-2.5">
        <SequencePlayer clips={clips} label="Program monitor" maxH={280} aspect={board.aspect} index={current} onIndex={setCurrent} onTime={setOffset}
          music={music ? { src: media.music(id, `${music.file}:${music.name}`), volume: music.volume, at: music.at, from: music.from } : undefined} />
        <p className="text-center text-[11px] text-muted-foreground tabular-nums">{formatSeconds(playhead)} / {formatSeconds(layout.total)}</p>
      </div>

      <div className="glass-panel flex min-w-0 flex-col rounded-lg">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
          <Clapperboard className="size-3.5 text-muted-foreground" />
          <span className="text-[12px] text-muted-foreground tabular-nums">{layout.scenes.length} scene · {layout.clips.length} shot · {formatSeconds(layout.total)}</span>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">· Drag klip untuk urutan, tepinya untuk trim</span>
          <label className="ml-auto flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Switch size="sm" aria-label="Subtitle di video" checked={edit.subtitles === true} disabled={busy}
              onCheckedChange={v => save(withEdit(board, { subtitles: v ? true : undefined }))} />
            Subtitle
          </label>
          <Segmented name="Zoom" value={zoom} onChange={setZoom}
            options={[{ value: '50', label: '50%' }, { value: '100', label: '100%' }, { value: '200', label: '200%' }]} />
          <input ref={musicInput} type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.aac" aria-label="Pilih berkas musik" className="sr-only" tabIndex={-1}
            onChange={e => void uploadMusic(e.target.files?.[0])} />
        </div>

        <div className="overflow-x-auto overscroll-x-contain">
          <DndContext sensors={sensors} collisionDetection={collide} onDragEnd={onDragEnd} accessibility={{ announcements, screenReaderInstructions: instructions }}>
            <div className="relative w-max min-w-full pb-1">
              <div className="flex h-5 border-b border-border/60">
                <div className={HEADER}>Waktu</div>
                <ul aria-label="Ruler" className="relative shrink-0" style={{ width: width + 28 }}>
                  {rulerTicks(layout.total).map(t => (
                    <li key={t.at} className="absolute top-0 h-full border-l border-border pl-0.5 text-[10px] leading-5 text-muted-foreground tabular-nums" style={{ left: px(t.at) }}>{t.label}</li>
                  ))}
                </ul>
              </div>

              <div className="flex items-center py-1">
                <div className={HEADER}>Scene</div>
                <SortableContext items={layout.scenes.map(s => sceneKey(s.id))} strategy={horizontalListSortingStrategy}>
                  <ul aria-label="Track scene" className="flex shrink-0">
                    {layout.scenes.map(s => (
                      <SceneBand key={s.id} scene={s} pps={pps} selected={selection?.kind === 'scene' && selection.id === s.id} onSelect={() => selectScene(s)} />
                    ))}
                  </ul>
                </SortableContext>
              </div>

              <div className="flex items-center py-1">
                <div className={cn(HEADER, 'h-12')}>V1</div>
                <SortableContext items={layout.clips.map(c => shotKey(c.shotId))} strategy={horizontalListSortingStrategy}>
                  <ul aria-label="Track video V1" className="flex shrink-0">
                    {layout.scenes.map(s => s.shots ? layout.clips.filter(c => c.sceneId === s.id).map(c => (
                      <ClipItem key={c.shotId} clip={c} pps={pps} thumb={c.frameDone ? media.frame(id, c.shotId, c.frame) : undefined}
                        selected={selection?.kind === 'shot' && selection.id === c.shotId} playing={c.index === current} onSelect={() => selectShot(c)}
                        onTrim={trim => setDraft({ shotId: c.shotId, trim })} onTrimCommit={commitTrim} />
                    )) : <li key={`gap-${s.id}`} aria-hidden="true" className="h-12 shrink-0 rounded-[4px] border border-dashed border-border/70" style={{ width: EMPTY_SCENE_PX }} />)}
                  </ul>
                </SortableContext>
              </div>

              <div className="flex items-center py-1">
                <button type="button" aria-label="Suara klip A1" aria-pressed={selection?.kind === 'audio'} title="Suara klip: volume" onClick={() => setSelection({ kind: 'audio' })}
                  className={cn(HEADER, 'h-6 gap-1 hover:text-foreground', selection?.kind === 'audio' && 'text-foreground')}>A1 <Volume2 className="size-3" /></button>
                <ul aria-label="Track suara klip A1" className="flex shrink-0">
                  {layout.scenes.map(s => s.shots ? layout.clips.filter(c => c.sceneId === s.id).map(c => (
                    <li key={c.shotId} aria-hidden="true" style={{ width: c.seconds * pps, opacity: c.status === 'done' ? Math.max(0.25, Math.min(1, (edit.clipVolume ?? 1) / 1.5 + 0.35)) : 0.25 }}
                      className="h-6 shrink-0 border-r border-border/40 bg-[repeating-linear-gradient(90deg,var(--success)_0_1px,transparent_1px_3px)] [mask-image:linear-gradient(transparent_20%,#000_40%,#000_60%,transparent_80%)]" />
                  )) : <li key={`gap-${s.id}`} aria-hidden="true" className="h-6 shrink-0" style={{ width: EMPTY_SCENE_PX }} />)}
                </ul>
              </div>

              <div className="flex items-center py-1">
                <div className={cn(HEADER, 'h-7')}>A2</div>
                <ul aria-label="Track musik A2" className="relative h-7 shrink-0" style={{ width }}>
                  {music ? (
                    <li className="absolute top-0 h-7" style={{ left: px(musicStart), width: Math.max(24, px(musicStart + musicSpan) - px(musicStart)) }}>
                      <button type="button" aria-label={`Musik: ${music.name}`} aria-pressed={selection?.kind === 'music'} title={`${music.name} · mulai ${fmtSeconds(musicStart)} dtk — tarik untuk menggeser`}
                        onPointerDown={e => { e.currentTarget.setPointerCapture?.(e.pointerId); musicDrag.current = { x: e.clientX, at: music.at, moved: false }; }}
                        onPointerMove={e => {
                          const d = musicDrag.current;
                          if (!d) return;
                          const dx = e.clientX - d.x;
                          if (Math.abs(dx) > 3) d.moved = true;
                          if (d.moved) setMusicAt(r1(Math.min(layout.total, Math.max(0, d.at + dx / pps))));
                        }}
                        onPointerUp={() => {
                          const d = musicDrag.current;
                          musicDrag.current = undefined;
                          if (d?.moved && musicAt !== undefined) void p.save(withEdit(board, { music: { ...music, at: musicAt } })).finally(() => setMusicAt(undefined));
                        }}
                        onClick={() => setSelection({ kind: 'music' })}
                        className={cn('flex size-full cursor-grab items-center gap-1 overflow-hidden rounded-[4px] border border-(--brand)/50 bg-(--brand)/20 px-1.5 text-left text-[10.5px] whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing',
                          selection?.kind === 'music' && 'ring-1 ring-foreground')}>
                        <Music className="size-3 shrink-0" /><span className="truncate">{music.name}</span>
                      </button>
                    </li>
                  ) : (
                    <li className="absolute top-0 left-1 flex h-7 items-center gap-2">
                      <Button size="xs" variant="glass" disabled={busy || musicBusy} onClick={() => musicInput.current?.click()}><Music /> {musicBusy ? 'Mengunggah…' : 'Tambah musik'}</Button>
                      <span className="text-[11px] text-muted-foreground">mp3, m4a, wav, ogg · maks 25 MB</span>
                    </li>
                  )}
                </ul>
              </div>

              <div className="flex items-center py-1">
                <div className={cn(HEADER, 'h-7')}>T1</div>
                <ul aria-label="Track subtitle T1" className={cn('flex shrink-0', edit.subtitles !== true && 'opacity-55')}>
                  {layout.scenes.map(s => s.shots ? layout.clips.filter(c => c.sceneId === s.id).map(c => (
                    <li key={c.shotId} title={c.narration} style={{ width: c.seconds * pps }}
                      className={cn('flex h-7 shrink-0 items-center overflow-hidden border-r border-border/40 px-1 text-[10.5px] leading-tight',
                        c.narration === '—' ? 'text-muted-foreground' : 'bg-(--brand)/10 text-foreground/85', selection?.id === c.shotId && 'bg-(--brand)/20')}>
                      <span className="line-clamp-2">{c.narration}</span>
                    </li>
                  )) : <li key={`gap-${s.id}`} aria-hidden="true" className="h-7 shrink-0" style={{ width: EMPTY_SCENE_PX }} />)}
                </ul>
              </div>

              <div aria-hidden="true" className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-(--brand)" style={{ left: `calc(3.5rem + ${px(playhead)}px)` }} />
            </div>
          </DndContext>
        </div>
      </div>

      {musicError && <p role="alert" className="text-[12px] text-destructive">{musicError}</p>}
      {selection ? (
        <Inspector board={board} clips={layout.clips} scenes={layout.scenes} selection={selection} busy={busy} total={layout.total}
          apply={next => void apply(next)} save={save} pickMusic={() => musicInput.current?.click()} />
      ) : (
        <p className="text-[11.5px] text-muted-foreground">Klik klip untuk trim dan urutan, A1 untuk volume suara klip, musik di A2. Perubahan dipakai saat video dirakit lagi.</p>
      )}
    </div>
  );
}
