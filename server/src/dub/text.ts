/**
 * The text of a dub as ElevenLabs hears it, bills it and as it is hashed: Unicode NFC, every run of whitespace
 * (double spaces, tabs, no-break spaces, line breaks) one plain space, nothing at the ends. A different amount of
 * whitespace is not a different sentence, so it must never cost a second render.
 */
export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}
