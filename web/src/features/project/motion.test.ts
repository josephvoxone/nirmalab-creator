import { describe, expect, it } from 'vitest';
import { MOTION_LIMIT, motionSuggestions, motionTone, motionView } from './motion.js';
import { shotsToCheck } from './audit.js';
import type { ShotMotion, ShotState, Story } from '../stories/storiesClient.js';

const motion = (over: Partial<ShotMotion> = {}): ShotMotion => ({ status: 'fail', score: 38, reasons: ['Gambar berganti/melebur sendiri di detik 1.7'], at: 100, ...over });
const shot = (over: Partial<ShotState> = {}): ShotState => ({ id: '01-a', status: 'done', attempts: 0, jobId: 'j1', ...over });

describe('motionTone', () => {
  it('maps the verdict, a dash-like none before any', () => {
    expect(motionTone(motion({ status: 'ok' }))).toBe('ok');
    expect(motionTone(motion({ status: 'warn' }))).toBe('warn');
    expect(motionTone(motion())).toBe('fail');
    expect(motionTone(undefined)).toBe('none');
  });
});

describe('motionSuggestions: only free edits the editor already has, in plain Indonesian', () => {
  it('names the cut second and where to do it', () => {
    expect(motionSuggestions(motion({ suggest: { trimOut: 3.4 } }))).toEqual(['Potong akhir klip di detik 3,4 (tab Timeline › Trim akhir) — gratis, tanpa render ulang.']);
    expect(motionSuggestions(motion({ suggest: { trimIn: 2.17 } }))).toEqual(['Lewati awal klip sampai detik 2,2 (tab Timeline › Trim awal) — gratis, tanpa render ulang.']);
    expect(motionSuggestions(motion({ suggest: { zoom: 1.12 } }))).toEqual(['Perbesar tampilan 1,12× untuk memotong tepi yang bocor (tab Timeline) — gratis, tanpa render ulang.']);
  });
  it('says plainly when no free fix exists on a failing clip, and nothing for a good one', () => {
    expect(motionSuggestions(motion())).toEqual(['Tidak ada perbaikan gratis yang aman untuk klip ini; tonton dulu, lalu setujui atau buat klip baru.']);
    expect(motionSuggestions(motion({ status: 'ok', reasons: [] }))).toEqual([]);
    expect(motionSuggestions(motion({ status: 'warn' }))).toEqual([]);
  });
});

describe('motionView: which of the states the panel shows', () => {
  it('no clip yet: nothing to show', () => {
    expect(motionView(shot({ status: 'pending' }), []).state).toBe('hidden');
    expect(motionView(undefined, []).state).toBe('hidden');
  });
  it('clip in flight: waiting', () => {
    expect(motionView(shot({ status: 'queued' }), []).state).toBe('waiting');
  });
  it('clip done, no verdict: empty — or error when the server logged that it could not run', () => {
    expect(motionView(shot(), [{ atMs: 1, message: '1/2 shot siap' }]).state).toBe('empty');
    expect(motionView(shot(), [{ atMs: 1, message: 'Cek gerak 01-a dilewati: tidak bisa dijalankan (klip tetap dipakai)' }]).state).toBe('error');
    expect(motionView(shot(), [{ atMs: 1, message: 'Cek gerak 02-b dilewati: tidak bisa dijalankan (klip tetap dipakai)' }]).state).toBe('empty');
  });
  it('a verdict of the current take shows by its status; one of another take is not shown', () => {
    expect(motionView(shot({ motion: motion({ status: 'warn' }), motionJobId: 'j1' }), []).state).toBe('warn');
    expect(motionView(shot({ motion: motion(), motionJobId: 'j1' }), []).state).toBe('fail');
    expect(motionView(shot({ motion: motion({ status: 'ok', reasons: [] }), motionJobId: 'j1' }), []).state).toBe('ok');
    expect(motionView(shot({ motion: motion(), motionJobId: 'OLD' }), []).state).toBe('empty');
  });
});

describe('the limits are said out loud', () => {
  it('names what is NOT detected (small identity glitches)', () => {
    expect(MOTION_LIMIT).toMatch(/tudung/i);
    expect(MOTION_LIMIT).toMatch(/tidak terdeteksi/i);
  });
});

describe('shotsToCheck: a failing motion verdict is a reason to look, with its sentence; a sign-off only covers what it saw', () => {
  const story = (s: Partial<ShotState>): Pick<Story, 'shots'> => ({ shots: [shot({ needsReview: true, motionJobId: 'j1', ...s })] });
  const audit = { score: 90, dimensions: { sceneMatch: 90, actionMatch: 90, moodMatch: 90, composition: 90 }, issues: [], repair: '', model: 'm', atMs: 10, costUsd: 0 };
  it('lists a motion-flagged shot with the motion reasons as its issues', () => {
    expect(shotsToCheck(story({ motion: motion() }))).toEqual([{ id: '01-a', needsReview: true, issues: ['Gambar berganti/melebur sendiri di detik 1.7'], repair: '' }]);
  });
  it('approved after the audit but BEFORE a failing motion verdict: still listed', () => {
    expect(shotsToCheck(story({ audit, approvedAtMs: 20, motion: motion({ at: 30 }) })).map(s => s.id)).toEqual(['01-a']);
  });
  it('approved after the failing verdict: not listed', () => {
    expect(shotsToCheck(story({ audit, approvedAtMs: 40, needsReview: undefined, motion: motion({ at: 30 }) }))).toEqual([]);
  });
  it('a warn never lists a shot', () => {
    expect(shotsToCheck(story({ needsReview: undefined, motion: motion({ status: 'warn' }) }))).toEqual([]);
  });
});
