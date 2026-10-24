/**
 * Timeline tab, Premiere-style: a small program monitor on top (every shot in order; rendered
 * clips play, the rest show their keyframe), then tracks on one time ruler — Scene bands,
 * Video V1 (one clip per shot, width = duration) and Narasi A1. Drag clips or scene bands to
 * reorder (dnd-kit, mouse + keyboard); the inspector strip under the tracks does the same with
 * buttons. Only this tab scrolls sideways.
 */
import { useMemo, useState } from 'react';
import {
  closestCenter, DndContext, KeyboardSensor, PointerSensor, pointerWithin, useSensor, useSensors,
  type Announcements, type CollisionDetection, type DragEndEvent
} from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowLeft, ArrowRight, Clapperboard, FolderInput, Film } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Segmented } from '../../ui/controls.js';
import { fmtDuration, moveShot, type Board } from './model.js';
import { media, useProject } from './useProject.js';
import { sized } from '../../lib/media.js';
import { SequencePlayer } from './Player.js';
import {
  boardOrder, formatSeconds, nudgeScene, nudgeShot, rulerTicks, sceneKey, sequenceClips, shotKey, timelineDrop, timelineLayout,
  type ClipStatus, type TimelineClip, type TimelineScene
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

type Selection = { kind: 'shot' | 'scene'; id: string } | undefined;

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

function ClipItem(props: { clip: TimelineClip; pps: number; thumb?: string; selected: boolean; playing: boolean; onSelect: () => void }) {
  const { clip } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: shotKey(clip.shotId) });
  const width = clip.seconds * props.pps;
  return (
    <li className="contents">
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

function Inspector(props: { board: Board; clips: TimelineClip[]; scenes: TimelineScene[]; selection: NonNullable<Selection>; busy: boolean; apply: (next: Board) => void }) {
  const { board, selection, busy, apply } = props;
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
  const [zoom, setZoom] = useState<Zoom>('100');
  const [selection, setSelection] = useState<Selection>();
  const [current, setCurrent] = useState(0);
  const [offset, setOffset] = useState(0);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] } })
  );
  const layout = useMemo(() => (board ? timelineLayout(board, story) : undefined), [board, story]);
  const clips = useMemo(() => (board && story ? sequenceClips(id, board, story) : []), [id, board, story]);

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
  const selectShot = (c: TimelineClip) => { setSelection({ kind: 'shot', id: c.shotId }); setCurrent(c.index); };
  const selectScene = (s: TimelineScene) => {
    setSelection({ kind: 'scene', id: s.id });
    const first = layout.clips.find(c => c.sceneId === s.id);
    if (first) setCurrent(first.index);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="glass-panel flex flex-col gap-1 rounded-lg p-2.5">
        <SequencePlayer clips={clips} label="Program monitor" maxH={280} aspect={board.aspect} index={current} onIndex={setCurrent} onTime={setOffset} />
        <p className="text-center text-[11px] text-muted-foreground tabular-nums">{formatSeconds(playhead)} / {formatSeconds(layout.total)}</p>
      </div>

      <div className="glass-panel flex min-w-0 flex-col rounded-lg">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
          <Clapperboard className="size-3.5 text-muted-foreground" />
          <span className="text-[12px] text-muted-foreground tabular-nums">{layout.scenes.length} scene · {layout.clips.length} shot · {formatSeconds(layout.total)}</span>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">· Drag klip atau scene untuk mengubah urutan</span>
          <Segmented name="Zoom" value={zoom} onChange={setZoom} className="ml-auto"
            options={[{ value: '50', label: '50%' }, { value: '100', label: '100%' }, { value: '200', label: '200%' }]} />
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
                        selected={selection?.kind === 'shot' && selection.id === c.shotId} playing={c.index === current} onSelect={() => selectShot(c)} />
                    )) : <li key={`gap-${s.id}`} aria-hidden="true" className="h-12 shrink-0 rounded-[4px] border border-dashed border-border/70" style={{ width: EMPTY_SCENE_PX }} />)}
                  </ul>
                </SortableContext>
              </div>

              <div className="flex items-center py-1">
                <div className={cn(HEADER, 'h-7')}>A1</div>
                <ul aria-label="Track narasi A1" className="flex shrink-0">
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

      {selection ? (
        <Inspector board={board} clips={layout.clips} scenes={layout.scenes} selection={selection} busy={busy} apply={next => void apply(next)} />
      ) : (
        <p className="text-[11.5px] text-muted-foreground">Klik klip atau scene untuk melihat detail dan menggesernya tanpa drag.</p>
      )}
    </div>
  );
}
