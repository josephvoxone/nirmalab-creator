export const DEFAULT_PUBLIC_URL = 'https://creator.nirmalab.com';

export const PUBLISHER_CALLBACK_PATHS = {
  youtube: '/api/publish/youtube/callback',
  tiktok: '/api/publish/tiktok/callback',
  meta: '/api/publish/meta/callback'
} as const;
export type PublisherCallbackKey = keyof typeof PUBLISHER_CALLBACK_PATHS;

export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCREATOR_PUBLIC_URL?.trim().replace(/\/+$/, '');
  return configured && /^https?:\/\//.test(configured)
    ? configured
    : DEFAULT_PUBLIC_URL;
}

export function publicCallbackUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${publicBaseUrl(env)}${normalized}`;
}

export function publisherCallbackUrl(
  key: PublisherCallbackKey,
  env: NodeJS.ProcessEnv = process.env
): string {
  return publicCallbackUrl(PUBLISHER_CALLBACK_PATHS[key], env);
}
