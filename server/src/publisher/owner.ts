import { normalizeEmail } from '../auth/password.js';

export type OwnerCandidate = { id: string; email: string; isAdmin: boolean; createdAt: string };

/** QA accounts created by the shipping skill's `qa-admin.sh` (`qa-<something>@example.local`). */
const QA_EMAIL = /^qa-.*@(nirmalab\.local|example\.local)$/i;

export type MainOwner = { user: OwnerCandidate; reason: 'configured' | 'oldest-admin' };
export type MainOwnerLookup = { owner: MainOwner; missing?: undefined } | { owner?: undefined; missing: 'configured-owner-not-found' | 'no-admin' };

/**
 * The "main owner": whoever the pre-tenancy global state (publish tokens, stories without `createdBy`) belongs to.
 * `TENANCY_DEFAULT_OWNER_EMAIL` when set (and it must match a real account — never a silent fallback), otherwise the
 * oldest admin that is not a QA account. Same rule as the tenancy plan (06 §C.1 item 5, decision D1).
 */
export function resolveMainOwner(users: readonly OwnerCandidate[], env: NodeJS.ProcessEnv = process.env): MainOwnerLookup {
  const configured = env.TENANCY_DEFAULT_OWNER_EMAIL?.trim();
  if (configured) {
    const wanted = normalizeEmail(configured);
    const user = users.find(entry => normalizeEmail(entry.email) === wanted);
    return user ? { owner: { user, reason: 'configured' } } : { missing: 'configured-owner-not-found' };
  }
  let oldest: OwnerCandidate | undefined;
  for (const user of users) {
    if (!user.isAdmin || QA_EMAIL.test(user.email)) continue;
    if (!oldest || Date.parse(user.createdAt) < Date.parse(oldest.createdAt)) oldest = user;
  }
  return oldest ? { owner: { user: oldest, reason: 'oldest-admin' } } : { missing: 'no-admin' };
}

/**
 * Can this user publish / preview this story? (Replaceable: the formal ownership helper from the tenancy area
 * — `assertOwner` — takes over this decision; app.ts is the only caller.)
 *
 *  - a story with `createdBy` belongs to exactly that user (an admin does NOT get through);
 *  - a story without `createdBy` (made before attribution existed) belongs to the main owner.
 */
export function isStoryOwner(story: { createdBy?: string } | undefined, userId: string, mainOwnerId: string | undefined): boolean {
  if (!story) return false;
  if (story.createdBy) return story.createdBy === userId;
  return mainOwnerId !== undefined && mainOwnerId === userId;
}
