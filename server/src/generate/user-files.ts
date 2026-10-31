import { join } from 'node:path';

/**
 * Where free-generate output lives (tenancy T4, audit 06 §B row 14): one folder per user,
 * `<data>/free-generate/users/<userId>/{tts,images,clips}/`. Ownership IS the folder: a user reads only their own,
 * so a leaked or guessed file name opens nothing for anyone else. The folders from before this change
 * (`<data>/free-generate/{tts,images,clips}/`) belong to the main owner (see `tenancy` migration + the read fallback).
 */
export const FREE_KINDS = ['tts', 'images', 'clips'] as const;
export type FreeKind = (typeof FREE_KINDS)[number];

const USER_ID = /^[A-Za-z0-9_-]{1,80}$/;

export const isFreeKind = (kind: string): kind is FreeKind => (FREE_KINDS as readonly string[]).includes(kind);

/** `<data>/free-generate/users/<userId>/<kind>`; throws on an id that could leave the folder (auth ids never do). */
export function userGenDir(dataDir: string, userId: string, kind: FreeKind): string {
  if (!USER_ID.test(userId)) throw new Error('Invalid user id for generated files');
  return join(dataDir, 'free-generate', 'users', userId, kind);
}

/** The pre-ownership folder, now only the main owner's. */
export const legacyGenDir = (dataDir: string, kind: FreeKind): string => join(dataDir, 'free-generate', kind);
