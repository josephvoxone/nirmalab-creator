/**
 * Audit state on the web side: bands, badge colours and the "shots to check" list. Pure, so the
 * rules are unit-tested (audit.test.ts) and the server enforces the same gate (spec §4.4).
 *
 * Bands: ≥75 pass, 50–74 warn, <50 fail. Assembly needs ≥70, unless a human approved the shot
 * after its audit (the server records `approvedBy` / `approvedAtMs`).
 */
import type { ShotState, Story } from '../stories/storiesClient.js';

export const AUDIT_GATE = 70;
export const PASS_SCORE = 75;
export const WARN_SCORE = 50;

export type AuditTone = 'pass' | 'warn' | 'fail' | 'none';

export function auditTone(score: number | undefined): AuditTone {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'none';
  if (score >= PASS_SCORE) return 'pass';
  return score >= WARN_SCORE ? 'warn' : 'fail';
}

/** Badge classes: green pass, amber warn, red fail, quiet dash before the first audit. */
export const AUDIT_BADGE: Record<AuditTone, string> = {
  pass: 'bg-(--success)/15 text-(--success)',
  warn: 'bg-(--warning)/15 text-(--warning)',
  fail: 'bg-destructive/15 text-destructive',
  none: 'bg-muted text-muted-foreground/70'
};

/** What the badge shows: the score, or a dash when the take has not been judged yet. */
export const auditLabel = (score?: number): string => (typeof score === 'number' && Number.isFinite(score) ? String(Math.round(score)) : '—');

/** Tooltip of the badge: the issues the audit named, or why there is nothing yet. */
export function auditTooltip(shot: Pick<ShotState, 'audit'>): string {
  if (!shot.audit) return 'Belum diaudit';
  const issues = shot.audit.issues.filter(Boolean);
  return issues.length ? issues.join('; ') : `Lolos audit (${auditLabel(shot.audit.score)}/100)`;
}

/**
 * A human sign-off recorded after the take was audited overrides a failing score — but only what the human saw:
 * a failing motion verdict made after the sign-off blocks again (the server's gate says the same).
 */
export const auditSigned = (shot: Pick<ShotState, 'audit' | 'approvedAtMs' | 'motion'>): boolean =>
  typeof shot.approvedAtMs === 'number' && !!shot.audit && shot.approvedAtMs >= shot.audit.atMs
  && !(shot.motion?.status === 'fail' && shot.motion.at > shot.approvedAtMs);

export type CheckShot = { id: string; score?: number; needsReview: boolean; issues: string[]; repair: string };

/** Shots a human must look at before assembly — the same rule the server's gate applies. */
export function shotsToCheck(story: Pick<Story, 'shots'>): CheckShot[] {
  return story.shots
    .filter(s => !auditSigned(s) && (s.needsReview || (typeof s.audit?.score === 'number' && s.audit.score < AUDIT_GATE)))
    .map(s => ({
      id: s.id,
      ...(typeof s.audit?.score === 'number' ? { score: s.audit.score } : {}),
      needsReview: !!s.needsReview,
      issues: [...(s.audit?.issues ?? []), ...(s.motion?.status === 'fail' ? s.motion.reasons : [])],
      repair: s.audit?.repair?.trim() ?? ''
    }));
}

/** Indonesian one-liner for the count ('2 shot perlu dicek'). */
export const checkLine = (count: number): string => `${count} shot perlu dicek`;
