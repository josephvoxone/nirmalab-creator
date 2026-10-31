import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { UserAuthStore } from '../src/auth/store.js';
import { PublisherService, registerPublisherRoutes } from '../src/publisher/index.js';

export const STORY_A = 'story_aaaaaaaaaaaaaaaa';
export const STORY_B = 'story_bbbbbbbbbbbbbbbb';

export const publisherEnv = {
  OPENCREATOR_PUBLIC_URL: 'https://creator.example.com',
  OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_ID: 'yt-id',
  OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_SECRET: 'yt-secret'
} as NodeJS.ProcessEnv;

export type UploadCall = { url: string; authorization: string | undefined };

/**
 * A fake Google: the token endpoint answers `at-<code>` / `rt-<code>` for an authorization code, the channel lookup
 * names the channel after the token it was asked with, and every upload start records which bearer token it used.
 * No real platform is ever called.
 */
export function fakeGoogle() {
  const uploads: UploadCall[] = [];
  const refreshes: string[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'refresh_token') {
        refreshes.push(String(form.get('refresh_token')));
        return json({ access_token: `fresh-of-${form.get('refresh_token')}`, expires_in: 3600 });
      }
      const code = String(form.get('code'));
      return json({ access_token: `at-${code}`, refresh_token: `rt-${code}`, expires_in: 3600 });
    }
    if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
      const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
      return json({ items: [{ snippet: { title: `Channel(${token})` } }] });
    }
    if (url.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
      uploads.push({ url, authorization: headers.get('authorization') ?? undefined });
      return json({}, 200, { location: 'https://upload.example.com/session/1' });
    }
    if (url === 'https://upload.example.com/session/1') return json({ id: `vid-${uploads.length}` });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, uploads, refreshes };
}

export type WorldOptions = {
  /** Who owns which story (story id -> user email). Anything missing is "story without createdBy". */
  storyOwners?: Record<string, string | undefined>;
  /** Replaces the story-ownership decision wired into the routes. */
  canAccessStory?: (storyId: string, user: { id: string; email: string; isAdmin: boolean }) => Promise<boolean>;
  dataDir?: string;
};

/** Three real accounts (oldest admin = the main owner "joseph", a second admin "bina", one member "mira") and the routes. */
export async function publisherWorld(options: WorldOptions = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'nc-pubw-'));
  const userAuthStore = new UserAuthStore(dataDir);
  const joseph = await userAuthStore.createUser({ email: 'joseph@nirmalab.com', password: 'joseph-pass-1', isAdmin: true });
  const bina = await userAuthStore.createUser({ email: 'bina@nirmalab.com', password: 'bina-pass-123', isAdmin: true });
  const mira = await userAuthStore.createUser({ email: 'mira@nirmalab.com', password: 'mira-pass-123', isAdmin: false });
  const google = fakeGoogle();
  const service = new PublisherService({ dataDir, env: publisherEnv, fetchImpl: google.fetchImpl as never });
  const video = join(mkdtempSync(join(tmpdir(), 'nc-pubv-')), 'final.mp4');
  writeFileSync(video, Buffer.alloc(16));
  mkdirSync(join(dataDir, 'publisher'), { recursive: true });
  const server = Fastify();
  await registerPublisherRoutes(server, {
    service,
    userAuthStore,
    env: publisherEnv,
    resolveStoryVideo: async () => video,
    resolveStoryPreview: async id => ({ title: `Judul ${id}`, caption: 'caption' }),
    canAccessStory: options.canAccessStory ?? (async () => true)
  } as never);
  await server.ready();
  const cookieOf = (id: string) => `oc_session=${userAuthStore.createSession(id).token}`;
  const cookies = { joseph: cookieOf(joseph.id), bina: cookieOf(bina.id), mira: cookieOf(mira.id) };
  const users = { joseph, bina, mira };

  const connect = async (cookie: string, platform = 'youtube') => {
    const res = await server.inject({ method: 'POST', url: `/api/publish/${platform}/connect`, headers: { cookie } });
    return { res, state: (res.json() as { state?: string }).state ?? '' };
  };
  const callback = (cookie: string | undefined, state: string, code: string, platform = 'youtube') =>
    server.inject({ url: `/api/publish/${platform}/callback?code=${code}&state=${state}`, ...(cookie ? { headers: { cookie } } : {}) });
  /** The full happy path for one user: connect, then the provider redirects back with `code`. */
  const connectAs = async (cookie: string, code: string, platform = 'youtube') => {
    const { state } = await connect(cookie, platform);
    return callback(cookie, state, code, platform);
  };
  const status = async (cookie: string) =>
    (await server.inject({ url: '/api/publish/status', headers: { cookie } })).json() as { publishers: Array<{ platform: string; connected: boolean; accountLabel?: string }> };
  const yt = async (cookie: string) => (await status(cookie)).publishers.find(p => p.platform === 'youtube')!;
  const publish = (cookie: string, storyId = STORY_A, platform = 'youtube') =>
    server.inject({ method: 'POST', url: `/api/publish/${platform}/publish`, headers: { cookie }, payload: { storyId, title: 'Judul', visibility: 'private' } });
  const disconnect = (cookie: string, platform = 'youtube') =>
    server.inject({ method: 'POST', url: `/api/publish/${platform}/disconnect`, headers: { cookie } });

  return { dataDir, userAuthStore, users, cookies, service, server, google, connect, callback, connectAs, status, yt, publish, disconnect };
}
