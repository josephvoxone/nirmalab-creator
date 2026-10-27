/**
 * Camera ids the assistant may write (framing + move), checked in one place for edit_shot,
 * add_shot and breakdown_scene. Only catalog ids reach a shot: the compiler would otherwise fall
 * back to a medium/static camera without telling anyone. Loose spellings of a real id
 * ("Rack Focus", "rack_focus") are accepted as that id.
 */
import { CATALOG } from '../stories/looks.js';

export type CameraKind = 'framing' | 'move';

export const FRAMING_IDS: string[] = CATALOG.framings.map(f => f.id);
export const MOVE_IDS: string[] = CATALOG.moves.map(m => m.id);

export const cameraIds = (kind: CameraKind): string[] => (kind === 'framing' ? FRAMING_IDS : MOVE_IDS);

/** The catalog id for `value`, or undefined when it is not one (after trimming, case and separators). */
export function cameraId(kind: CameraKind, value: string): string | undefined {
  const id = value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  return cameraIds(kind).includes(id) ? id : undefined;
}
