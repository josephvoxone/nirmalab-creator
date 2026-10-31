/** Left column of the Scene tab: the chapters. Click selects, drag (or the menu) reorders, shots can be dropped on a row. */
import { useState, type KeyboardEventHandler, type PointerEventHandler } from 'react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical, MoreHorizontal, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { Story } from '../stories/storiesClient.js';
import { sceneProgress, type Board, type Scene, fmtDuration } from './model.js';
import { TONE_DOT, dragId, parseDragId, sceneTone } from './SceneHelpers.js';
import { useReadOnly } from './readonly.js';

function SceneRow(props: {
  scene: Scene; index: number; count: number; board: Board; story: Story; selected: boolean; locked: boolean;
  onSelect: () => void; onMove: (to: number) => void;
}) {
  const { scene, index, board, story } = props;
  const readOnly = useReadOnly();
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging, isOver, active } = useSortable({ id: dragId.scene(scene.id), disabled: props.locked });
  const shotOver = isOver && parseDragId(active?.id)?.kind === 'shot';
  const p = sceneProgress(story, board, scene.id);
  const tone = sceneTone(p);
  const location = scene.location ? board.locations?.[scene.location]?.name : undefined;
  return (
    <li ref={setNodeRef} aria-label={`Scene ${index + 1} · ${scene.title}`} aria-current={props.selected ? 'true' : undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }} onPointerDown={listeners?.onPointerDown as PointerEventHandler | undefined}
      className={cn('group relative flex items-start gap-0.5 rounded-md py-1.5 pr-1 pl-0.5 transition-colors hover:bg-accent/60',
        props.selected && 'glass-chosen hover:bg-transparent', isDragging && 'z-10 opacity-60', shotOver && 'ring-1 ring-(--brand) bg-(--brand-muted)')}>
      {!readOnly && (
        <button type="button" ref={setActivatorNodeRef} {...attributes} onKeyDown={listeners?.onKeyDown as KeyboardEventHandler | undefined} aria-label={`Seret scene ${scene.title}`} disabled={props.locked}
          className="mt-0.5 flex h-5 w-4 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60 disabled:cursor-default disabled:opacity-40">
          <GripVertical className="size-3.5" />
        </button>
      )}
      <button type="button" aria-label={`Pilih ${scene.title}`} onClick={props.onSelect}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/60">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className="w-4 shrink-0 text-[11.5px] text-muted-foreground tabular-nums">{index + 1}</span>
          <span className="truncate font-medium">{scene.title}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1 pl-5.5 text-[11.5px] text-muted-foreground">
          <span className="truncate">{location ?? 'Tanpa lokasi'}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">{fmtDuration(p.seconds)}</span>
        </span>
        <span className="flex items-center gap-1.5 pl-5.5 text-[11px] text-muted-foreground tabular-nums">
          <span role="img" aria-label={`Status: ${tone.label}`} title={tone.label} className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[tone.tone])} />
          {p.framesNeeded > 0 && <span>Keyframe {p.frames}/{p.framesNeeded}</span>}
          <span>Klip {p.clips}/{p.shots}</span>
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger disabled={props.locked} aria-label={`Menu ${scene.title}`}
          render={<Button type="button" size="icon-xs" variant="ghost" className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100" />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem disabled={index === 0} onClick={() => props.onMove(index - 1)}><ArrowUp /> Naik</DropdownMenuItem>
          <DropdownMenuItem disabled={index >= props.count - 1} onClick={() => props.onMove(index + 1)}><ArrowDown /> Turun</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export function SceneList(props: {
  board: Board; story: Story; selected: string; locked: boolean;
  onSelect: (id: string) => void; onMove: (id: string, to: number) => void; onAdd: (title: string) => void;
  /** Bible boards: a new scene needs a goal, so "Tambah scene" opens the form instead of the inline title field. */
  onAddForm?: () => void;
}) {
  const readOnly = useReadOnly();
  const scenes = props.board.scenes ?? [];
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const commit = () => {
    setAdding(false);
    props.onAdd(title.trim());
    setTitle('');
  };
  return (
    <div className="glass-panel flex min-w-0 flex-col gap-1 self-start rounded-lg p-1.5">
      <div className="flex h-6 items-center justify-between px-1.5 text-[12px] text-muted-foreground">
        <span>Scene</span>
        <span className="tabular-nums">{scenes.length}</span>
      </div>
      <SortableContext items={scenes.map(s => dragId.scene(s.id))} strategy={verticalListSortingStrategy}>
        <ol aria-label="Daftar scene" className="flex flex-col gap-0.5">
          {scenes.map((s, i) => (
            <SceneRow key={s.id} scene={s} index={i} count={scenes.length} board={props.board} story={props.story} selected={s.id === props.selected}
              locked={props.locked} onSelect={() => props.onSelect(s.id)} onMove={to => props.onMove(s.id, to)} />
          ))}
        </ol>
      </SortableContext>
      {adding ? (
        <input autoFocus aria-label="Judul scene baru" placeholder={`Scene ${scenes.length + 1}`} value={title} maxLength={80}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setAdding(false); setTitle(''); } }}
          onBlur={() => { if (title.trim()) commit(); else setAdding(false); }}
          className="h-7 rounded-md border border-input bg-(--field) px-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:border-ring" />
      ) : (
        !readOnly && <Button type="button" size="sm" variant="ghost" aria-label="Tambah scene" disabled={props.locked} onClick={() => (props.onAddForm ? props.onAddForm() : setAdding(true))} className="justify-start text-muted-foreground">
          <Plus /> Scene
        </Button>
      )}
    </div>
  );
}
