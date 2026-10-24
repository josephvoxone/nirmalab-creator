/** Right column of the Scene tab: one scene's header (title, summary, location, cast, actions), preview and shots. */
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Clapperboard, Images, MoreHorizontal, Play, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Choice } from '../../ui/controls.js';
import type { Story } from '../stories/storiesClient.js';
import { fmtDuration, renameScene, sceneProgress, SECONDS_PER_SHOT, type Board, type Scene } from './model.js';
import { SequencePlayer, type Clip } from './Player.js';
import { SceneCastChips } from './SceneCast.js';
import { castIn, renderCost } from './SceneHelpers.js';
import { SceneShots, type ShotActions } from './SceneShots.js';
import { media } from './useProject.js';

const NO_LOCATION = '__none__';

export type SceneActions = ShotActions & {
  save: (next: Board) => void;
  addShot: () => void;
  prepare: () => void;
  render: () => void;
  moveScene: (to: number) => void;
  removeScene: () => void;
};

function sceneClips(projectId: string, story: Story, scene: Scene): Clip[] {
  return scene.shots.map((id, i) => {
    const st = story.shots.find(s => s.id === id);
    return {
      id,
      label: `Shot ${i + 1} · ${id}`,
      src: st?.status === 'done' ? media.clip(projectId, id, st.jobId ?? '') : undefined,
      poster: st?.frame?.status === 'done' ? media.frame(projectId, id, st.frame.mediaId ?? '') : undefined,
      seconds: st?.durationSec ?? SECONDS_PER_SHOT
    };
  });
}

function Header(props: { board: Board; scene: Scene; index: number; locked: boolean; save: (b: Board) => void }) {
  const { board, scene } = props;
  const [title, setTitle] = useState(scene.title);
  const [summary, setSummary] = useState(scene.summary ?? '');
  useEffect(() => setTitle(scene.title), [scene.id, scene.title]);
  useEffect(() => setSummary(scene.summary ?? ''), [scene.id, scene.summary]);
  const commitTitle = () => {
    if (!title.trim()) { setTitle(scene.title); return; }
    if (title.trim() !== scene.title) props.save(renameScene(board, scene.id, title));
  };
  const commitSummary = () => {
    if (summary.trim() !== (scene.summary ?? '')) props.save(renameScene(board, scene.id, scene.title, { summary }));
  };
  const locations = Object.entries(board.locations ?? {});
  return (
    <div className="flex flex-wrap items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">Scene {props.index + 1}</span>
          <input aria-label="Judul scene" value={title} maxLength={80} disabled={props.locked} onChange={e => setTitle(e.target.value)} onBlur={commitTitle}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setTitle(scene.title); } }}
            className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[14px] font-medium outline-none hover:border-input focus-visible:border-ring focus-visible:bg-(--field) disabled:hover:border-transparent" />
        </div>
        <textarea aria-label="Ringkasan scene" rows={1} value={summary} maxLength={300} disabled={props.locked} placeholder="Apa yang terjadi di scene ini…"
          onChange={e => setSummary(e.target.value)} onBlur={commitSummary}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'Escape') setSummary(scene.summary ?? ''); }}
          className="field-sizing-content min-h-7 w-full resize-none rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[12.5px] text-muted-foreground outline-none placeholder:text-muted-foreground/70 hover:border-input focus-visible:border-ring focus-visible:bg-(--field) focus-visible:text-foreground disabled:hover:border-transparent" />
      </div>
      <Choice label="Lokasi" size="sm" disabled={props.locked} value={scene.location ?? NO_LOCATION} className="min-w-36"
        options={[{ value: NO_LOCATION, label: 'Tanpa lokasi' }, ...locations.map(([key, l]) => ({ value: key, label: l.name, hint: l.look }))]}
        onChange={v => props.save(renameScene(board, scene.id, scene.title, { location: v === NO_LOCATION ? undefined : v }))} />
    </div>
  );
}

/** An empty scene: say why, offer the one action, and the drag alternative (drop a shot on this scene in the list). */
function EmptyShots(props: { scene: Scene; locked: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed px-4 py-6 text-center">
      <p className="text-[13px] font-medium">Scene ini belum punya shot</p>
      <Button type="button" size="sm" variant="glass" aria-label="Tambah shot" disabled={props.locked} onClick={props.onAdd}><Plus /> Shot</Button>
      <p className="text-[12px] text-muted-foreground">atau seret shot dari scene lain ke “{props.scene.title}” di daftar scene</p>
    </div>
  );
}

export function SceneBoard(props: {
  projectId: string; board: Board; story: Story; scene: Scene; index: number; locked: boolean; busy: boolean; picked?: string; actions: SceneActions;
}) {
  const { board, story, scene, actions } = props;
  const [preview, setPreview] = useState(false);
  useEffect(() => setPreview(false), [scene.id]);
  const konsisten = story.mode === 'konsisten';
  const cost = renderCost(story, board, scene.id);
  const cast = castIn(board, story, scene.shots);
  const count = board.scenes?.length ?? 1;
  const idle = !props.locked && !props.busy;
  return (
    <section aria-label={`Scene ${scene.title}`} className="glass-panel flex min-w-0 flex-col gap-3 rounded-lg p-3">
      <Header board={board} scene={scene} index={props.index} locked={props.locked} save={actions.save} />
      <div className="flex flex-wrap items-center gap-2">
        <SceneCastChips projectId={props.projectId} story={story} cast={cast} label="Pemeran di scene ini" className="min-w-40 flex-1" />
        <div className="flex flex-wrap items-center gap-1.5">
          {konsisten && (
            <Button type="button" size="sm" variant="glass" disabled={!idle || !scene.shots.length} onClick={actions.prepare}>
              <Images /> Buat keyframe scene · gratis
            </Button>
          )}
          {cost.todo === 0 && scene.shots.length > 0 ? (
            <span className="flex items-center gap-1 text-[12px] text-muted-foreground"><Check className="size-3.5 text-(--success)" /> Semua klip scene ini siap</span>
          ) : (
            <Button type="button" size="sm" disabled={!idle || cost.todo === 0} onClick={actions.render} title={`${cost.todo} shot belum dirender`}>
              <Clapperboard /> Render scene · ±{cost.credits} kredit
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" aria-pressed={preview} onClick={() => setPreview(v => !v)}><Play /> Preview scene</Button>
          <DropdownMenu>
            <DropdownMenuTrigger disabled={props.locked} aria-label="Aksi scene" render={<Button type="button" size="icon-sm" variant="ghost" />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem disabled={props.index === 0} onClick={() => actions.moveScene(props.index - 1)}><ArrowUp /> Naik</DropdownMenuItem>
              <DropdownMenuItem disabled={props.index >= count - 1} onClick={() => actions.moveScene(props.index + 1)}><ArrowDown /> Turun</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={count <= 1} onClick={actions.removeScene}><Trash2 /> Hapus scene</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {preview && (
        <div className="relative flex flex-col items-center rounded-md border bg-black/20 p-2">
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Tutup preview" onClick={() => setPreview(false)} className="absolute top-1.5 left-1.5"><X /></Button>
          <SequencePlayer clips={sceneClips(props.projectId, story, scene)} label={`Preview scene ${scene.title}`} maxH={300} aspect={board.aspect} className="w-full" />
        </div>
      )}
      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        <span>{scene.shots.length} shot · ±{fmtDuration(sceneProgress(story, board, scene.id).seconds)}</span>
        {scene.shots.length > 0 && (
          <Button type="button" size="sm" variant="ghost" aria-label="Tambah shot" disabled={props.locked} onClick={actions.addShot}><Plus /> Shot</Button>
        )}
      </div>
      {scene.shots.length
        ? <SceneShots projectId={props.projectId} board={board} story={story} scene={scene} locked={props.locked} picked={props.picked} actions={actions} />
        : <EmptyShots scene={scene} locked={props.locked} onAdd={actions.addShot} />}
    </section>
  );
}
