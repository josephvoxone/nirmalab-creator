/**
 * Storyboard → Flow shots. Pure helpers (prompt assembly, validation, resume),
 * used by story.mjs.
 */

const GEAR = /jib arm|camera crane|technocrane|slider rig|dolly track|camera rig|drone flies|film crew/i;
const CAMERA_MOVES = /\b(pans?|tilts?|zooms?|dollies|pushes in|pulls back|orbits?|tracks?|rises|cranes?|arcs?)\b/gi;

export function buildShotPrompt(story, shot) {
  let body = shot.prompt;
  for (const [token, descriptor] of Object.entries(story.characters ?? {})) {
    body = body.replace(new RegExp(`\\b${token}\\b`, 'g'), descriptor);
  }
  const audio = shot.silent ? (story.audioSilent ?? '') : (story.audio ?? '')
    .replace('{narrator}', story.narrator ?? 'a narrator')
    .replace('{line}', (shot.narration ?? '').trim());
  return [body, story.style, audio].filter(Boolean).join(' ') + (story.negative ? `\n${story.negative}` : '');
}

/** Estimated Flow cost per new shot: 6 s default video = 10 credits (measured 2026-10-23). */
export const CREDITS_PER_SHOT = 10;

/** Veo speaks ~2 words/s in Indonesian narration; 12 words fit a 6 s shot. */
export const MAX_NARRATION_WORDS = 12;

export function validateStory(story, { budget, isDone = () => false } = {}) {
  const errors = [];
  if (!Array.isArray(story.shots) || story.shots.length === 0) errors.push('story has no shots');
  for (const shot of story.shots ?? []) {
    if (shot.reuse) continue;
    if (!shot.silent && !shot.narration?.trim()) errors.push(`${shot.id}: narration is empty`);
    const words = (shot.narration ?? '').trim().split(/\s+/).filter(Boolean).length;
    if (words > MAX_NARRATION_WORDS) errors.push(`${shot.id}: narration has ${words} words (max ${MAX_NARRATION_WORDS} to fit ~6 s)`);
    if (!shot.prompt?.trim()) errors.push(`${shot.id}: prompt is empty`);
    if (GEAR.test(shot.prompt ?? '')) errors.push(`${shot.id}: names camera gear (jib/crane/rig) that Veo renders in frame`);
    const moves = new Set((shot.prompt ?? '').toLowerCase().match(CAMERA_MOVES) ?? []);
    if (moves.size > 1) errors.push(`${shot.id}: more than one camera move (${[...moves].join(', ')})`);
  }
  const newShots = (story.shots ?? []).filter(s => !s.reuse && !isDone(s.id)).length;
  if (budget !== undefined && newShots * CREDITS_PER_SHOT > budget) {
    errors.push(`budget: ${newShots} new shots × ${CREDITS_PER_SHOT} = ${newShots * CREDITS_PER_SHOT} credits > ${budget}`);
  }
  return errors;
}

/** Shots still to generate (reuse shots and already-downloaded files are skipped). */
export function pendingShots(story, isDone) {
  return (story.shots ?? []).filter(s => !s.reuse && !isDone(s.id));
}
