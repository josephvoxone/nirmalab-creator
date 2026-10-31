/**
 * Motion QC on the web side: tone, the free-fix sentences and which state the shot sheet panel shows. Pure (motion.test.ts).
 * The server only ever suggests edits the editor already has (trim, zoom); nothing here can start a render.
 */
import type { ShotMotion, ShotState, Story } from '../stories/storiesClient.js';

export type MotionTone = 'ok' | 'warn' | 'fail' | 'none';
export const motionTone = (m?: Pick<ShotMotion, 'status'>): MotionTone => m?.status ?? 'none';

/** What the check cannot see — said wherever its verdict is shown (it was tuned on one film, painterly look only). */
export const MOTION_LIMIT = 'Cek ini hanya melihat adegan yang melebur sendiri, tepi/border yang tumbuh, gambar beku atau diam, dan kamera yang mundur. Cacat kecil — misalnya tudung yang tiba-tiba naik atau wajah yang digambar ulang — tidak terdeteksi: tonton klipnya.';

/** Indonesian decimal comma, at most one decimal for seconds and two for a zoom factor. */
const secs = (n: number) => (Math.round(n * 10) / 10).toString().replace('.', ',');
const factor = (n: number) => (Math.round(n * 100) / 100).toString().replace('.', ',');

/** The free fixes the server found, as sentences; a failing clip with none says so. A clip that is fine gets nothing. */
export function motionSuggestions(m: ShotMotion): string[] {
  const out: string[] = [];
  if (m.suggest?.trimOut !== undefined) out.push(`Potong akhir klip di detik ${secs(m.suggest.trimOut)} (tab Timeline › Trim akhir) — gratis, tanpa render ulang.`);
  if (m.suggest?.trimIn !== undefined) out.push(`Lewati awal klip sampai detik ${secs(m.suggest.trimIn)} (tab Timeline › Trim awal) — gratis, tanpa render ulang.`);
  if (m.suggest?.zoom !== undefined) out.push(`Perbesar tampilan ${factor(m.suggest.zoom)}× untuk memotong tepi yang bocor (tab Timeline) — gratis, tanpa render ulang.`);
  if (!out.length && m.status === 'fail') out.push('Tidak ada perbaikan gratis yang aman untuk klip ini; tonton dulu, lalu setujui atau buat klip baru.');
  return out;
}

export type MotionState = 'hidden' | 'waiting' | 'empty' | 'error' | 'ok' | 'warn' | 'fail';

/** The panel's state: no clip → hidden; clip in flight → waiting; done → the verdict of THIS take, else empty (or error when the server logged it could not run). */
export function motionView(shot: ShotState | undefined, events: Story['events']): { state: MotionState; motion?: ShotMotion } {
  if (!shot || (shot.status !== 'done' && shot.status !== 'queued')) return { state: 'hidden' };
  if (shot.status === 'queued') return { state: 'waiting' };
  if (shot.motion && (shot.motionJobId === undefined || shot.motionJobId === shot.jobId)) return { state: shot.motion.status, motion: shot.motion };
  const latest = [...events].reverse().find(e => e.message.startsWith(`Cek gerak ${shot.id} `));
  return { state: latest?.message.startsWith(`Cek gerak ${shot.id} dilewati`) ? 'error' : 'empty' };
}
