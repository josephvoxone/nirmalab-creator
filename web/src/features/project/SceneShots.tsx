/** The shots of one scene as compact cards: sortable by drag, every move also in the card menu. */
import { useState, type KeyboardEventHandler, type PointerEventHandler } from 'react';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowLeft, ArrowRight, Copy, Film, FolderInput, GripVertical, Loader2, MoreHorizontal, Pencil, Play, Square, Trash2, Scissors, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import type { Story } from '../stories/storiesClient.js';
import type { Board, Scene } from './model.js';
import { TONE_TEXT, dragId, shotStatus, snippet } from './SceneHelpers.js';
import { AUDIT_BADGE, auditLabel, auditTooltip, auditTone } from './audit.js';
import { motionView } from './motion.js';
import { media } from './useProject.js';
import { poster, sizedImg } from '../../lib/media.js';

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

/** The still of a shot card: its keyframe, else the poster of its rendered clip (sized to the box). */
function shotStill(projectId: string, story: Story, shotId: string, width: number): { src: string; srcSet?: string; alt: string } | undefined {
  const st = story.shots.find(s => s.id === shotId);
  if (st?.frame?.status === 'done') return { ...sizedImg(media.frame(projectId, shotId, st.frame.mediaId ?? ''), width), alt: `Keyframe ${shotId}` };
  if (st?.status === 'done') return { ...sizedImg(poster.shot(projectId, shotId, width, st.jobId), width), alt: `Klip ${shotId}` };
  return undefined;
}

function ShotThumb(props: { projectId: string; story: Story; shotId: string; aspect?: string }) {
  const st = props.story.shots.find(s => s.id === props.shotId);
  const size = thumbSize(props.aspect);
  const busy = st?.status === 'queued' || st?.frame?.status === 'queued';
  const still = shotStill(props.projectId, props.story, props.shotId, size.width);
  return (
    <span className="relative block shrink-0 overflow-hidden rounded bg-muted" style={size}>
      {still ? (
        <img src={still.src} srcSet={still.srcSet} width={size.width} height={size.height} alt={still.alt} loading="lazy" decoding="async" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center text-muted-foreground/50">
          {busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Film aria-hidden="true" className="size-4" />}
        </span>
      )}
    </span>
  );
}

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const overlayBtn = 'flex items-center justify-center rounded-full bg-black/60 text-white outline-none transition-colors hover:bg-black/75 focus-visible:ring-1 focus-visible:ring-ring/60';

/** Play a rendered clip inside its card (muted, with a sound toggle) without opening the editor. */
function InlineClip(props: { src: string; poster?: string; number: number; size: { width: number; height: number } }) {
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const { width, height } = props.size;
  if (!playing) {
    return (
      <button type="button" aria-label={`Putar shot ${props.number}`} title="Putar klip di sini" onPointerDown={stop} onClick={() => setPlaying(true)}
        className={cn(overlayBtn, 'absolute size-8 [&_svg]:size-3.5 [&_svg]:fill-current')} style={{ top: 4 + height / 2 - 16, left: 4 + width / 2 - 16 }}>
        <Play aria-hidden="true" className="ml-0.5" />
      </button>
    );
  }
  return (
    <div className="absolute overflow-hidden rounded bg-black" style={{ top: 4, left: 4, width, height }} onPointerDown={stop}>
      <video src={props.src} poster={props.poster} autoPlay muted={muted} playsInline aria-label={`Klip shot ${props.number}`}
        onEnded={() => setPlaying(false)} className="size-full object-cover" />
      <div className="absolute inset-x-1 bottom-1 flex items-center justify-between [&_svg]:size-3">
        <button type="button" aria-label={muted ? `Nyalakan suara shot ${props.number}` : `Matikan suara shot ${props.number}`} onClick={() => setMuted(m => !m)} className={cn(overlayBtn, 'size-6')}>
          {muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
        </button>
        <button type="button" aria-label={`Hentikan shot ${props.number}`} onClick={() => setPlaying(false)} className={cn(overlayBtn, 'size-6 [&_svg]:fill-current')}>
          <Square aria-hidden="true" />
        </button>
      </div>
    </div>
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
  const st = story.shots.find(s => s.id === shotId);
  const motion = st ? motionView(st, story.events) : undefined;
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
          {/* Audit score: green ≥75, amber 50–74, red <50, a dash until the take is audited. */}
          <span data-audit={auditTone(st?.audit?.score)} aria-label={`Skor audit ${shotId}`} title={auditTooltip(st ?? {})}
            className={cn('ml-auto shrink-0 rounded px-1 text-[10px] leading-4 tabular-nums', AUDIT_BADGE[auditTone(st?.audit?.score)])}>
            {auditLabel(st?.audit?.score)}
          </span>
          {/* Motion QC: only a warn or a fail earns a chip (ok and unchecked stay quiet). */}
          {motion && (motion.state === 'warn' || motion.state === 'fail') && (
            <span data-motion={motion.state} aria-label={`Cek gerak ${shotId}`} title={motion.motion!.reasons.join('; ')}
              className={cn('shrink-0 rounded px-1 text-[10px] leading-4', AUDIT_BADGE[motion.state])}>
              Gerak
            </span>
          )}
        </span>
        <span className="line-clamp-2 min-h-[2lh] text-[11.5px] leading-snug">
          {shot.silent ? <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-muted-foreground">Tanpa narasi</Badge> : (snippet(shot.narration, 7) || <span className="text-muted-foreground">Narasi kosong</span>)}
        </span>
      </button>
      {st?.status === 'done' && (
        <InlineClip key={st.jobId} src={media.clip(props.projectId, shotId, st.jobId ?? '')} poster={shotStill(props.projectId, story, shotId, size.width)?.src} number={number} size={size} />
      )}
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
