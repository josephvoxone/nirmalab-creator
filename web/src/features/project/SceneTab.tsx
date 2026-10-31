/**
 * Scene tab (default): chapters on the left, the selected scene's board on the right, one shot
 * in a side sheet. Every edit is a model.ts op sent with useProject().save(next). Drag-and-drop
 * (@dnd-kit) reorders scenes and shots; every move also exists as a menu item.
 */
import { useMemo, useState } from 'react';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { useSession } from '../../lib/session.js';
import { useReadOnly } from './readonly.js';
import { useCatalog } from '../stories/catalog.js';
import { STATUS_LABEL, isActive, storiesApi } from '../stories/storiesClient.js';
import { addScene, addShot, duplicateShot, intentSkeleton, moveScene, moveShot, removeScene, removeShot, sceneOf, splitSceneAfter, type Board, type SceneGoal } from './model.js';
import { NewSceneDialog } from './NewSceneDialog.js';
import { SceneBoard, type SceneActions } from './SceneBoard.js';
import { dragEndBoard, parseDragId } from './SceneHelpers.js';
import { SceneList } from './SceneList.js';
import { thumbSize } from './SceneShots.js';
import { ShotSheet } from './ShotSheet.js';
import { media, useProject } from './useProject.js';
import { sized } from '../../lib/media.js';

/** Scenes are only compared with scenes; a dragged shot targets a scene row under the pointer first, else the nearest shot. */
export const sceneCollision: CollisionDetection = args => {
  const of = (kind: 'scene' | 'shot') => args.droppableContainers.filter(c => parseDragId(c.id)?.kind === kind);
  if (parseDragId(args.active.id)?.kind === 'scene') return closestCenter({ ...args, droppableContainers: of('scene') });
  const onScene = pointerWithin({ ...args, droppableContainers: of('scene') });
  return onScene.length ? onScene : closestCenter({ ...args, droppableContainers: of('shot') });
};

const newId = (before: string[], after: string[]) => after.find(id => !before.includes(id));

type Doomed = { kind: 'scene' | 'shot'; id: string };

export function SceneTab() {
  const p = useProject();
  const { fetchImpl } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const { catalog, error: catalogError } = useCatalog(api.catalog);
  const [selected, setSelected] = useState<string>();
  const [picked, setPicked] = useState<string>();
  const [sheet, setSheet] = useState<string>();
  const [doomed, setDoomed] = useState<Doomed>();
  const [dragging, setDragging] = useState<string>();
  /** Bible boards: the new-scene form is open (after a shot when it splits a scene). */
  const [newScene, setNewScene] = useState<{ afterShot?: string }>();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const board = p.board!;
  const story = p.story!;
  const scenes = board.scenes ?? [];
  const index = Math.max(0, scenes.findIndex(s => s.id === selected));
  const scene = scenes[index]!;
  const readOnly = useReadOnly();
  const locked = isActive(story) || readOnly;
  const save = (next: Board) => void p.save(next);

  const openShot = (id: string) => { setPicked(id); setSheet(id); };
  const actions: SceneActions = {
    save,
    open: openShot,
    duplicate: id => save(duplicateShot(board, id)),
    move: (id, sceneId, to) => save(moveShot(board, id, sceneId, to)),
    remove: id => setDoomed({ kind: 'shot', id }),
    addShot: () => {
      // Bible boards: a new shot starts as an intent skeleton, so its prompt is compiled from the bible.
      const next = addShot(board, scene.id, undefined, board.bible ? { intent: intentSkeleton(board) } : {});
      const id = newId(board.shots.map(s => s.id), next.shots.map(s => s.id));
      save(next);
      if (id) openShot(id);
    },
    prepare: () => void p.prepare(scene.id),
    render: () => void p.render({ scene: scene.id }),
    // Bible boards ask for the new scene's goal first; legacy boards split at once.
    splitAfter: (shotId: string) => (board.bible ? setNewScene({ afterShot: shotId }) : save(splitSceneAfter(board, shotId, ''))),
    moveScene: to => save(moveScene(board, scene.id, to)),
    removeScene: () => setDoomed({ kind: 'scene', id: scene.id })
  };

  const onAddScene = (title: string, extra: SceneGoal = {}) => {
    const next = addScene(board, title, undefined, extra);
    const id = newId(scenes.map(s => s.id), (next.scenes ?? []).map(s => s.id));
    save(next);
    if (id) setSelected(id);
  };
  const onCreateScene = (title: string, extra: SceneGoal) => {
    if (newScene?.afterShot) save(splitSceneAfter(board, newScene.afterShot, title, extra));
    else onAddScene(title, extra);
  };

  /** Removing a scene hands its shots to the previous scene (the next one for the first). */
  const heirOf = (sceneId: string) => {
    const i = scenes.findIndex(s => s.id === sceneId);
    return scenes[i > 0 ? i - 1 : 1];
  };

  const confirmDelete = () => {
    if (!doomed) return;
    if (doomed.kind === 'shot') {
      save(removeShot(board, doomed.id));
      if (sheet === doomed.id) setSheet(undefined);
      if (picked === doomed.id) setPicked(undefined);
    } else {
      const heir = heirOf(doomed.id);
      save(removeScene(board, doomed.id));
      setSelected(heir?.id);
    }
    setDoomed(undefined);
  };

  const onDragStart = (e: DragStartEvent) => setDragging(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(undefined);
    const next = dragEndBoard(board, e.active.id, e.over?.id);
    if (next) save(next);
  };

  const doomedScene = doomed?.kind === 'scene' ? scenes.find(s => s.id === doomed.id) : undefined;
  const doomedShotScene = doomed?.kind === 'shot' ? sceneOf(board, doomed.id) : undefined;
  const drag = parseDragId(dragging);
  const dragFrame = drag?.kind === 'shot' ? story.shots.find(s => s.id === drag.id)?.frame : undefined;

  return (
    <div className="flex flex-col gap-2">
      {locked && <p role="status" className="text-[12px] text-muted-foreground">Sedang {(STATUS_LABEL[story.status] ?? story.status).toLowerCase()} — scene dan shot dikunci sampai selesai.</p>}
      {catalogError != null && <p className="text-[12px] text-muted-foreground">Pilihan framing dan gerakan kamera gagal dimuat; ubah lewat prompt.</p>}
      <DndContext sensors={sensors} collisionDetection={sceneCollision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(undefined)}>
        <div className="grid items-start gap-3 md:grid-cols-[236px_minmax(0,1fr)]">
          <SceneList board={board} story={story} selected={scene.id} locked={locked} onSelect={setSelected}
            onMove={(id, to) => save(moveScene(board, id, to))} onAdd={title => onAddScene(title)} onAddForm={board.bible ? () => setNewScene({}) : undefined} />
          <SceneBoard projectId={p.id} board={board} story={story} scene={scene} index={index} locked={locked} busy={!!p.busy && p.busy !== 'save'}
            picked={picked} actions={actions} />
        </div>
        <DragOverlay dropAnimation={null}>
          {drag?.kind === 'shot' ? (
            <div className="overflow-hidden rounded-md border bg-(--field) shadow-lg" style={thumbSize(board.aspect)}>
              {dragFrame?.status === 'done' && <img src={sized(media.frame(p.id, drag.id, dragFrame.mediaId ?? ''), thumbSize(board.aspect).width)} alt="" decoding="async" className="size-full object-cover" />}
            </div>
          ) : drag?.kind === 'scene' ? (
            <div className="rounded-md border bg-popover px-2 py-1 text-[13px] shadow-lg">{scenes.find(s => s.id === drag.id)?.title}</div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <ShotSheet shotId={sheet} catalog={catalog} onClose={() => setSheet(undefined)} />
      {!!board.bible && (
        <NewSceneDialog open={!!newScene} board={board} afterShot={newScene?.afterShot} defaultTitle={`Scene ${scenes.length + 1}`}
          onOpenChange={o => { if (!o) setNewScene(undefined); }} onCreate={onCreateScene} />
      )}
      <AlertDialog open={!!doomed} onOpenChange={o => { if (!o) setDoomed(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{doomedScene ? `Hapus scene "${doomedScene.title}"?` : `Hapus shot ${doomed?.id ?? ''}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {doomedScene
                ? `${doomedScene.shots.length} shot pindah ke scene "${heirOf(doomedScene.id)?.title ?? ''}". Shot tidak ikut terhapus.`
                : `Narasi, prompt dan take shot ini dihapus dari ${doomedShotScene ? `scene "${doomedShotScene.title}"` : 'storyboard'}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>Hapus</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
