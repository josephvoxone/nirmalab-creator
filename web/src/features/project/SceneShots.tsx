/** The shots of one scene as compact cards: sortable by drag, every move also in the card menu. */
import type { KeyboardEventHandler, PointerEventHandler } from 'react';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowLeft, ArrowRight, Copy, Film, FolderInput, GripVertical, Loader2, MoreHorizontal, Pencil, Trash2, Scissors } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import type { Story } from '../stories/storiesClient.js';
import type { Board, Scene } from './model.js';
import { TONE_TEXT, dragId, shotStatus, snippet } from './SceneHelpers.js';
import { media } from './useProject.js';

/** Thumbnail box of a shot card: 96×170 portrait or 170×96 landscape. */
export const thumbSize = (aspect?: string) => (aspect === '16:9' ? { width: 170, height: 96 } : { width: 96, height: 170 });

export type ShotActions = {
  open: (shotId: string) => void;
  duplicate: (shotId: string) => void;
  move: (shotId: string, sceneId: string, index: number) => void;
  remove: (shotId: string) => void;
  /** Start a new scene right after this shot (the rest of the scene moves into it). */
  splitAfter: (shotId: string) => void;
};

function ShotThumb(props: { projectId: string; story: Story; shotId: string; aspect?: string }) {
  const st = props.story.shots.find(s => s.id === props.shotId);
  const size = thumbSize(props.aspect);
  const busy = st?.status === 'queued' || st?.frame?.status === 'queued';
  return (
    <span className="relative block shrink-0 overflow-hidden rounded bg-muted" style={size}>
      {st?.frame?.status === 'done' ? (
        <img src={media.frame(props.projectId, props.shotId, st.frame.mediaId ?? '')} alt={`Keyframe ${props.shotId}`} loading="lazy" className="size-full object-cover" />
      ) : st?.status === 'done' ? (
        <video src={`${media.clip(props.projectId, props.shotId, st.jobId ?? '')}#t=1.5`} muted playsInline preload="metadata" aria-hidden="true" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center text-muted-foreground/50">
          {busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Film aria-hidden="true" className="size-4" />}
        </span>
      )}
    </span>
  );
}

function ShotCard(props: {
  projectId: string; board: Board; story: Story; scene: Scene; shotId: string; index: number; locked: boolean; picked: boolean; actions: ShotActions;
}) {
  const { board, story, scene, shotId, index, actions } = props;
  // Number shots across the whole project, like the timeline (scene cards and V1 clips agree).
  const number = board.shots.findIndex(s => s.id === shotId) + 1;
  const shot = board.shots.find(s => s.id === shotId)!;
  const status = shotStatus(story, shotId);
  const size = thumbSize(board.aspect);
  const others = (board.scenes ?? []).map((s, i) => ({ s, i })).filter(x => x.s.id !== scene.id);
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: dragId.shot(shotId), disabled: props.locked });
  return (
    <li ref={setNodeRef} aria-label={`Shot ${number} · ${shotId}`} onPointerDown={listeners?.onPointerDown as PointerEventHandler | undefined}
      style={{ transform: CSS.Translate.toString(transform), transition, width: size.width + 8 }}
      className={cn('group relative flex flex-col gap-1 rounded-md border border-border/70 bg-(--field) p-1 transition-colors hover:border-border',
        props.picked && 'border-foreground/40', isDragging && 'z-10 opacity-40')}>
      <button type="button" aria-label={`Edit shot ${number}`} onClick={() => actions.open(shotId)}
        className="flex flex-col gap-1 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/60">
        <ShotThumb projectId={props.projectId} story={story} shotId={shotId} aspect={board.aspect} />
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className="tabular-nums text-foreground/80">{String(number).padStart(2, '0')}</span>
          <span title={status.label} className={cn('truncate', TONE_TEXT[status.tone])}>{status.label}</span>
        </span>
        <span className="line-clamp-2 min-h-[2lh] text-[11.5px] leading-snug">
          {shot.silent ? <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-muted-foreground">Tanpa narasi</Badge> : (snippet(shot.narration, 7) || <span className="text-muted-foreground">Narasi kosong</span>)}
        </span>
      </button>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
        <button type="button" ref={setActivatorNodeRef} {...attributes} onKeyDown={listeners?.onKeyDown as KeyboardEventHandler | undefined} aria-label={`Seret shot ${shotId}`} disabled={props.locked}
          className="flex size-6 cursor-grab items-center justify-center rounded-sm bg-black/55 text-white/80 opacity-0 outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring/60 disabled:hidden max-md:opacity-100">
          <GripVertical className="size-3.5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger disabled={props.locked} aria-label={`Menu shot ${shotId}`}
            render={<Button type="button" size="icon-xs" variant="glass" className="opacity-80 group-hover:opacity-100 aria-expanded:opacity-100" />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => actions.open(shotId)}><Pencil /> Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.duplicate(shotId)}><Copy /> Duplikat</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={!others.length}><FolderInput /> Pindah ke scene</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                {others.map(({ s, i }) => (
                  <DropdownMenuItem key={s.id} onClick={() => actions.move(shotId, s.id, s.shots.length)}>{i + 1}. {s.title}</DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem disabled={index === 0} onClick={() => actions.move(shotId, scene.id, index - 1)}><ArrowLeft /> Geser kiri</DropdownMenuItem>
            <DropdownMenuItem disabled={index >= scene.shots.length - 1} onClick={() => actions.move(shotId, scene.id, index + 1)}><ArrowRight /> Geser kanan</DropdownMenuItem>
            <DropdownMenuItem disabled={index >= scene.shots.length - 1} onClick={() => actions.splitAfter(shotId)}><Scissors /> Scene baru setelah shot ini</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={board.shots.length <= 1} onClick={() => actions.remove(shotId)}><Trash2 /> Hapus</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

export function SceneShots(props: { projectId: string; board: Board; story: Story; scene: Scene; locked: boolean; picked?: string; actions: ShotActions }) {
  const { scene } = props;
  return (
    <SortableContext items={scene.shots.map(dragId.shot)} strategy={rectSortingStrategy}>
      <ul aria-label={`Shot di scene ${scene.title}`} className="flex flex-wrap gap-2">
        {scene.shots.map((id, i) => (
          <ShotCard key={id} projectId={props.projectId} board={props.board} story={props.story} scene={scene} shotId={id} index={i}
            locked={props.locked} picked={props.picked === id} actions={props.actions} />
        ))}
      </ul>
    </SortableContext>
  );
}
