import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLIC_URL,
  publicBaseUrl,
  publicCallbackUrl,
  publisherCallbackUrl
} from '../src/lib/public-url.js';

describe('public url', () => {
  it('defaults to creator.nirmalab.com', () => {
    expect(publicBaseUrl({})).toBe(DEFAULT_PUBLIC_URL);
    expect(DEFAULT_PUBLIC_URL).toBe('https://creator.nirmalab.com');
  });

  it('honours OPENCREATOR_PUBLIC_URL and strips trailing slashes', () => {
    expect(publicBaseUrl({ OPENCREATOR_PUBLIC_URL: 'https://staging.example.com//' }))
      .toBe('https://staging.example.com');
  });

  it('falls back on invalid values', () => {
    expect(publicBaseUrl({ OPENCREATOR_PUBLIC_URL: 'not-a-url' }))
      .toBe(DEFAULT_PUBLIC_URL);
  });

  it('builds publisher callback urls', () => {
    expect(publisherCallbackUrl('youtube', {}))
      .toBe('https://creator.nirmalab.com/api/publish/youtube/callback');
    expect(publisherCallbackUrl('tiktok', {}))
      .toBe('https://creator.nirmalab.com/api/publish/tiktok/callback');
    expect(publisherCallbackUrl('meta', {}))
      .toBe('https://creator.nirmalab.com/api/publish/meta/callback');
    expect(publicCallbackUrl('api/health', {})).toBe('https://creator.nirmalab.com/api/health');
  });
});
