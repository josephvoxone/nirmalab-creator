/**
 * The one next step for the whole project. The header button runs it; tabs only name it, so a
 * project-wide action never appears twice on screen.
 */
import type { Story } from '../stories/storiesClient.js';
import { stageOf, type Board } from './model.js';

export type NextStep =
  | { kind: 'working'; label: string }
  | { kind: 'retry' | 'prepare' | 'render' | 'assemble'; label: string }
  | { kind: 'publish'; label: string }
  | { kind: 'none'; label: string };

const WORKING: Record<string, string> = { casting: 'Membuat karakter', framing: 'Membuat keyframe', assembling: 'Merakit video' };

export function nextStep(story: Story, board: Board): NextStep {
  const done = story.shots.filter(s => s.status === 'done').length;
  if (['casting', 'framing', 'rendering', 'assembling'].includes(story.status)) {
    return { kind: 'working', label: story.status === 'rendering' ? `Merender ${done}/${story.shots.length}` : WORKING[story.status]! };
  }
  if (story.status === 'failed') return { kind: 'retry', label: 'Ulangi yang gagal' };
  if (!board.shots.length) return { kind: 'none', label: 'Tambah shot dulu' };
  const { current } = stageOf(story, board);
  const todo = story.shots.length - done;
  if (current === 'breakdown') return { kind: 'prepare', label: 'Buat karakter & keyframe · gratis' };
  if (current === 'keyframe') return { kind: 'prepare', label: 'Buat keyframe semua · gratis' };
  if (current === 'render') return { kind: 'render', label: `Render semua · ±${todo * 10} kredit` };
  if (!story.video) return { kind: 'assemble', label: 'Rakit video' };
  if (story.videoStale) return { kind: 'assemble', label: 'Rakit ulang video' };
  return { kind: 'publish', label: 'Publish' };
}
