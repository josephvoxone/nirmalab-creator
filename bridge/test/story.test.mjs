import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildShotPrompt, pendingShots, validateStory } from '../src/story.mjs';

const story = JSON.parse(readFileSync(new URL('./fixtures/selendang-merah.json', import.meta.url), 'utf8'));

test('buildShotPrompt: token karakter diganti descriptor identik, lalu Style, Audio, Negative', () => {
  const hadiah = story.shots.find(s => s.id === '01-hadiah');
  const out = buildShotPrompt(story, hadiah);
  assert.ok(out.includes(story.characters.GIRL));
  assert.ok(out.includes(story.characters.RABBIT));
  assert.doesNotMatch(out, /\b(GIRL|RABBIT)\b/);
  const lines = out.split('\n');
  assert.equal(lines.at(-1), story.negative);
  assert.ok(out.includes(story.style));
  assert.ok(out.includes(`"${hadiah.narration}"`), 'narasi shot ada di baris Audio');
  assert.doesNotMatch(out, /\{(narrator|line)\}/);
});

test('validateStory: storyboard nyata lolos, aturan Veo dijaga', () => {
  assert.deepEqual(validateStory(story), []);
  const bad = { ...story, shots: [{ id: 'x', prompt: 'A jib arm lifts above RABBIT. The camera pans and the camera zooms.', narration: '' }] };
  const errors = validateStory(bad);
  assert.ok(errors.some(e => /jib/i.test(e)));
  assert.ok(errors.some(e => /narration/i.test(e)));
});

test('validateStory: total biaya shot baru tidak boleh melebihi anggaran', () => {
  assert.ok(validateStory(story, { budget: 50 }).some(e => /budget/i.test(e)));
  assert.deepEqual(validateStory(story, { budget: 93 }), []);
});

test('pendingShots: shot reuse dan file yang sudah ada dilewati (bisa dilanjutkan)', () => {
  const done = new Set(['01-hadiah']);
  const ids = pendingShots(story, id => done.has(id)).map(s => s.id);
  assert.ok(!ids.includes('01-hadiah'));
  assert.ok(!ids.includes('06-istana'));
  assert.ok(ids.includes('00-intro'), 'intro senyap tetap di-generate');
  assert.equal(ids.length, story.shots.filter(s => !s.reuse).length - 1);
});

test('narasi bawaan Veo: baris Audio berisi voice-over bahasa Indonesia dari narasi shot', () => {
  const s = { ...story, narrator: 'a warm gentle female narrator', audio: 'Audio: voice-over by {narrator}, speaking Bahasa Indonesia slowly: "{line}" Quiet natural ambience underneath.' };
  const out = buildShotPrompt(s, { id: 'x', prompt: 'RABBIT sits.', narration: 'Namanya Kapas.' });
  assert.match(out, /Audio: voice-over by a warm gentle female narrator, speaking Bahasa Indonesia slowly: "Namanya Kapas\." Quiet natural ambience underneath\./);
});

test('narasi harus muat ±6 detik (maks 12 kata) dan shot reuse boleh tanpa narasi', () => {
  const long = { ...story, shots: [{ id: 'x', prompt: 'RABBIT sits.', narration: 'satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua belas tiga' }] };
  assert.ok(validateStory(long).some(e => /words/.test(e)));
  const reuse = { ...story, shots: [{ id: 'r', reuse: { file: 'x.mp4' }, narration: '' }] };
  assert.deepEqual(validateStory(reuse), []);
});

test('shot intro tanpa narasi: silent=true memakai audioSilent, tidak butuh narasi', () => {
  const s = { ...story, audioSilent: 'Audio: soft wind and gentle orchestral swell, no voice.' };
  const shot = { id: '00-intro', silent: true, prompt: 'Extreme wide shot of a valley.' };
  const out = buildShotPrompt(s, shot);
  assert.match(out, /Audio: soft wind and gentle orchestral swell, no voice\./);
  assert.doesNotMatch(out, /voice-over/);
  assert.deepEqual(validateStory({ ...s, shots: [shot] }), []);
});

test('budget dihitung dari shot yang belum dibuat saja', () => {
  const allDone = () => true;
  assert.deepEqual(validateStory(story, { budget: 3, isDone: allDone }), []);
  assert.ok(validateStory(story, { budget: 3 }).some(e => /budget/.test(e)));
});
