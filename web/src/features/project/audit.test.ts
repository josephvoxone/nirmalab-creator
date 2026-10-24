import { describe, expect, it } from 'vitest';
import { AUDIT_GATE, auditLabel, auditSigned, auditTone, auditTooltip, checkLine, shotsToCheck } from './audit.js';
import type { ShotAudit, ShotState } from '../stories/storiesClient.js';

const audit = (score: number, extra: Partial<ShotAudit> = {}): ShotAudit => ({
  score, dimensions: { sceneMatch: score, actionMatch: score, moodMatch: score, composition: score },
  issues: [], repair: 'The gate is missing: add a wooden gate.', model: 'google/gemini-2.5-flash', atMs: 1_000, costUsd: 0.002, target: 'frame', ...extra
});
const shot = (id: string, extra: Partial<ShotState> = {}): ShotState => ({ id, status: 'done', attempts: 0, ...extra });

describe('audit bands', () => {
  it('green ≥75, amber 50–74, red below 50, a dash when unaudited', () => {
    expect(auditTone(100)).toBe('pass');
    expect(auditTone(75)).toBe('pass');
    expect(auditTone(74)).toBe('warn');
    expect(auditTone(50)).toBe('warn');
    expect(auditTone(49)).toBe('fail');
    expect(auditTone(0)).toBe('fail');
    expect(auditTone(undefined)).toBe('none');
  });

  it('the badge shows the score, or a dash', () => {
    expect(auditLabel(88)).toBe('88');
    expect(auditLabel(62.4)).toBe('62');
    expect(auditLabel(undefined)).toBe('—');
  });

  it('the tooltip lists the issues, or says it passed / was never audited', () => {
    expect(auditTooltip({ audit: audit(62, { issues: ['the gate is missing', 'the cat is cropped'] }) })).toBe('the gate is missing; the cat is cropped');
    expect(auditTooltip({ audit: audit(88) })).toBe('Lolos audit (88/100)');
    expect(auditTooltip({})).toBe('Belum diaudit');
  });

  it('the assembly gate is 70', () => {
    expect(AUDIT_GATE).toBe(70);
  });
});

describe('human sign-off', () => {
  it('an approval after the audit overrides a failing score, an earlier one does not', () => {
    expect(auditSigned({ audit: audit(62), approvedAtMs: 2_000 })).toBe(true);
    expect(auditSigned({ audit: audit(62), approvedAtMs: 500 })).toBe(false);
    expect(auditSigned({ approvedAtMs: 2_000 })).toBe(false);
    expect(auditSigned({ audit: audit(62) })).toBe(false);
  });
});

describe('shotsToCheck', () => {
  const story = {
    shots: [
      shot('lulus', { audit: audit(88) }),
      shot('kurang', { audit: audit(62, { issues: ['the gate is missing'] }) }),
      shot('dicek', { needsReview: true, audit: audit(72) }),
      shot('disetujui', { audit: audit(62), approvedAtMs: 2_000 }),
      shot('belum-diaudit', { audit: undefined })
    ]
  };

  it('lists only the shots the gate refuses, with score, issues and the repair line', () => {
    const list = shotsToCheck(story);
    expect(list.map(s => s.id)).toEqual(['kurang', 'dicek']);
    expect(list[0]).toMatchObject({ score: 62, needsReview: false, issues: ['the gate is missing'] });
    expect(list[0]!.repair).toContain('wooden gate');
    expect(list[1]).toMatchObject({ needsReview: true, score: 72 });
  });

  it('an unaudited shot is not a blocker', () => {
    expect(shotsToCheck({ shots: [shot('a')] })).toEqual([]);
  });

  it('the line is Indonesian and compact', () => {
    expect(checkLine(1)).toBe('1 shot perlu dicek');
    expect(checkLine(3)).toBe('3 shot perlu dicek');
  });
});
