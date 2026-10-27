import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  axcelOp, axcelPayload, absoluteMediaUrl, classifyAxcelError, cookieHeader, jobState,
  pickDuration, resolutionNumber, resultExtension, RATIOS
} from '../src/axcel-core.mjs';

test('axcelOp follows the inputs, not the caller', () => {
  assert.equal(axcelOp({ kind: 'video' }), 't2v');
  assert.equal(axcelOp({ kind: 'video', hasStart: true }), 'i2v');
  assert.equal(axcelOp({ kind: 'image' }), 't2i');
  assert.equal(axcelOp({ kind: 'image', hasReferences: true }), 'i2i');
});

test('resolutionNumber takes 480/720/1080 and falls back to 480', () => {
  assert.equal(resolutionNumber(720), 720);
  assert.equal(resolutionNumber('1080p'), 1080);
  assert.equal(resolutionNumber('720'), 720);
  assert.equal(resolutionNumber(2160), 480);
  assert.equal(resolutionNumber(undefined), 480);
});

test('pickDuration snaps to the model list, ties to the longer clip', () => {
  assert.equal(pickDuration(5, [5, 8, 10]), 5);
  assert.equal(pickDuration(6, [5, 8]), 5);
  assert.equal(pickDuration(6.5, [5, 8]), 8);
  assert.equal(pickDuration(1, [5, 8]), 5);
  assert.equal(pickDuration(40, [5, 8, 15, 30]), 30);
  // unknown list: clamp into Axcel's 5–30 s window
  assert.equal(pickDuration(3, undefined), 5);
  assert.equal(pickDuration(99, []), 30);
});

test('axcelPayload matches the captured web-app body', () => {
  const body = axcelPayload({
    model: 'Seedance 2.0', op: 't2v', prompt: 'ombak senja', ratio: '9:16',
    duration: 5, resolution: 480, audio: true, inputs: {}, idempotencyKey: 'k1', turnstile: 't1'
  });
  assert.deepEqual(body, {
    model: 'Seedance 2.0', op: 't2v', prompt: 'ombak senja', ratio: '9:16', audio: true,
    inputs: {}, idempotencyKey: 'k1', bahasa: 'id', turnstile: 't1', duration: 5, resolution: 480
  });
});

test('axcelPayload drops duration/resolution for image ops and unknown ratios', () => {
  const body = axcelPayload({
    model: 'Nano Banana Pro', op: 't2i', prompt: 'kucing', ratio: '7:3',
    duration: 9, resolution: 1080, idempotencyKey: 'k2', turnstile: 't2'
  });
  assert.equal(body.ratio, '9:16');
  assert.equal('duration' in body, false);
  assert.equal('resolution' in body, false);
  assert.equal(RATIOS.includes(body.ratio), true);
});

test('axcelPayload refuses a missing model, prompt, key or turnstile', () => {
  const base = { model: 'Seedance 2.0', op: 't2v', prompt: 'x', idempotencyKey: 'k', turnstile: 't' };
  assert.throws(() => axcelPayload({ ...base, model: '' }), /model/);
  assert.throws(() => axcelPayload({ ...base, prompt: '  ' }), /prompt/);
  assert.throws(() => axcelPayload({ ...base, idempotencyKey: '' }), /idempotencyKey/);
  assert.throws(() => axcelPayload({ ...base, turnstile: '' }), /turnstile/);
});

test('classifyAxcelError: gate errors are retryable, refusals are final', () => {
  assert.deepEqual(classifyAxcelError(403, { detail: { code: 'TURNSTILE', message: 'Verifikasi keamanan gagal.' } }),
    { final: false, code: 'TURNSTILE', message: 'TURNSTILE: Verifikasi keamanan gagal.' });
  assert.equal(classifyAxcelError(403, { detail: { code: 'TOKEN_HALAMAN', message: 'Muat ulang' } }).final, false);
  assert.equal(classifyAxcelError(422, { detail: [{ msg: 'bad' }] }).final, true);
  assert.equal(classifyAxcelError(401, { detail: 'Silakan masuk dulu.' }).message, 'Silakan masuk dulu.');
  assert.equal(classifyAxcelError(500, {}).final, false);
});

test('jobState maps Axcel statuses', () => {
  assert.equal(jobState('done'), 'done');
  assert.equal(jobState('error'), 'failed');
  assert.equal(jobState('running'), 'running');
  assert.equal(jobState(undefined), 'running');
});

test('cookieHeader keeps only the host cookies, ready for a header', () => {
  const jar = [
    { name: 'axcel_sesi', value: 'abc', domain: 'axcel.cloud' },
    { name: '_fbp', value: '1', domain: '.axcel.cloud' },
    { name: 'other', value: 'x', domain: 'example.com' }
  ];
  assert.equal(cookieHeader(jar), 'axcel_sesi=abc; _fbp=1');
  assert.equal(cookieHeader([]), '');
  assert.equal(cookieHeader(null), '');
});

test('absoluteMediaUrl and resultExtension', () => {
  assert.equal(absoluteMediaUrl('/api/media/x.mp4?k=1'), 'https://axcel.cloud/api/media/x.mp4?k=1');
  assert.equal(absoluteMediaUrl('https://media.axcel.cloud/x.mp4'), 'https://media.axcel.cloud/x.mp4');
  assert.equal(absoluteMediaUrl(''), undefined);
  assert.equal(resultExtension('video'), 'mp4');
  assert.equal(resultExtension('image'), 'png');
});
