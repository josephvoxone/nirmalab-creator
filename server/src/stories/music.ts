/**
 * The music track of a project's timeline: one audio file per project (`music.<ext>` in the story
 * dir), recognised by its bytes — never by the name or the content type the browser sends.
 */
export const MUSIC_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg'] as const;
export const MAX_MUSIC_BYTES = 25 * 1024 * 1024;
export const MUSIC_FILE = /^music\.(mp3|m4a|wav|ogg|aac)$/;
export const NOT_AUDIO_MESSAGE = 'Berkas ini bukan audio yang didukung (mp3, m4a, wav, ogg, aac).';
export const MUSIC_TOO_LARGE_MESSAGE = 'Musik maksimal 25 MB.';
export const NO_SOUND_MESSAGE = 'Berkas ini tidak berisi suara.';

export type MusicExt = 'mp3' | 'm4a' | 'wav' | 'ogg' | 'aac';

export function musicExt(b: Buffer): MusicExt | undefined {
  if (b.length < 12) return undefined;
  if (b.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  if (b.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return 'aac'; // ADTS: sync word, layer 00
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'mp3'; // MPEG audio frame sync
  return undefined;
}

export const MUSIC_MIME: Record<MusicExt, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac' };
