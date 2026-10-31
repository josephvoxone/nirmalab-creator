import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from './ProjectPage.js';
import { BOARD, fakeProjectApi, ID, mountProject, storyFor, type Call, type ExtraRoute } from './testkit.js';
import type { DubShot, DubState } from './dubClient.js';

const TEXTS: Record<string, string> = { '00-pembuka': '', '01-pagar': 'Jingga menunggu setiap sore.', '02-jalan': 'Suatu hari Bima pulang.', '03-peluk': 'Mereka bertemu lagi.' };
const SCENE: Record<string, string> = { '00-pembuka': 'menunggu', '01-pagar': 'menunggu', '02-jalan': 'pulang', '03-peluk': 'pulang' };

/** A tiny stand-in for the dub routes of the server: state, plan with the estimate, render only with the exact confirmation. */
function fakeDub(opts: { hang?: boolean; configured?: boolean; voiceId?: string; failShot?: string; renderStatus?: number } = {}) {
  const configured = opts.configured ?? true;
  const shots: DubShot[] = Object.entries(TEXTS).map(([shotId, text]) => ({ shotId, sceneId: SCENE[shotId], text, textSource: 'narration', chars: text.length, status: 'none', skipped: !text, tooLong: false }));
  const settings = { ...(opts.voiceId ? { voiceId: opts.voiceId } : {}), modelId: 'eleven_multilingual_v2', languageCode: 'id', keepAmbient: true, voice: { stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1, speakerBoost: true } };
  const models = [{ id: 'eleven_multilingual_v2', label: 'Multilingual v2 — kualitas terbaik', creditsPerChar: 1, languageCode: false }, { id: 'eleven_flash_v2_5', label: 'Flash v2.5 — cepat dan hemat (½ kredit)', creditsPerChar: 0.5, languageCode: true }];
  const state = (): DubState => {
    const d = shots.filter(s => !s.skipped);
    return { configured, settings, models, shots, totals: { dubbable: d.length, done: d.filter(s => s.status === 'done').length, stale: d.filter(s => s.status === 'stale').length, failed: d.filter(s => s.status === 'failed').length, active: d.filter(s => s.status === 'queued' || s.status === 'running').length, chars: d.reduce((n, s) => n + s.chars, 0) } };
  };
  const calls: Call[] = [];
  const scopeShots = (scope: any, force: boolean) => shots.filter(s => !s.skipped && (force || s.status !== 'done') && (scope.kind === 'all' || (scope.kind === 'scene' && s.sceneId === scope.sceneId) || (scope.kind === 'shots' && scope.shotIds.includes(s.shotId))));
  const route: ExtraRoute = (call, json) => {
    const m = call.url.match(/^\/api\/stories\/[^/]+\/dub(\/.*)?$/);
    if (call.url === '/api/dub/voices') return json(200, { voices: [{ id: 'VOICE_ARYA_123456', name: 'Arya', gender: 'male', age: 'old' }, { id: 'VOICE_BAYU_654321', name: 'Bayu', gender: 'male', age: 'young' }] });
    if (!m) return undefined;
    calls.push(call);
    const sub = m[1] ?? '';
    if (call.method === 'GET' && sub === '') return opts.hang ? new Promise<Response>(() => undefined) : json(200, { dub: state() });
    if (call.method === 'PUT' && sub === '/settings') { Object.assign(settings, call.body); if ((call.body as any)?.voice) Object.assign(settings.voice, (call.body as any).voice); return json(200, { dub: state() }); }
    if (call.method === 'PUT' && sub.startsWith('/shots/')) { const s = shots.find(x => x.shotId === sub.split('/')[2])!; const t = (call.body as any).text; s.text = t ?? TEXTS[s.shotId]!; s.textSource = t ? 'override' : 'narration'; s.chars = s.text.length; if (s.status === 'done') s.status = 'stale'; return json(200, { dub: state() }); }
    if (call.method === 'DELETE' && sub.startsWith('/shots/')) { const s = shots.find(x => x.shotId === sub.split('/')[2])!; s.status = 'none'; delete s.audio; return json(200, { dub: state() }); }
    if (call.method === 'POST' && sub === '/plan') {
      const list = scopeShots((call.body as any).scope, (call.body as any).force === true);
      const chars = list.reduce((n, s) => n + s.chars, 0);
      return json(200, { plan: { shotIds: list.map(s => s.shotId), chars, credits: chars * (settings.modelId === 'eleven_flash_v2_5' ? 0.5 : 1), modelId: settings.modelId } });
    }
    if (call.method === 'POST' && sub === '/render') {
      if (opts.renderStatus) return json(opts.renderStatus, { error: { code: 'REJECTED', message: 'ElevenLabs menolak: kredit habis' } });
      const list = scopeShots((call.body as any).scope, (call.body as any).force === true);
      const need = list.reduce((n, s) => n + s.chars, 0);
      if ((call.body as any).confirmCredits !== need) return json(409, { error: { code: 'CONFIRM_REQUIRED', message: 'Konfirmasi biaya tidak cocok' } });
      for (const s of list) { s.status = opts.failShot === s.shotId ? 'failed' : 'done'; if (s.status === 'failed') s.error = 'ElevenLabs sedang sibuk'; else { s.seconds = 2.5; s.audio = `${s.shotId}-abcd1234`; } }
      return json(202, { dub: state() });
    }
    if (call.method === 'POST' && sub === '/cancel') return json(200, { dub: state() });
    return undefined;
  };
  return { route, calls, shots, settings };
}

const open = (dub: ReturnType<typeof fakeDub>, over: { videoStale?: boolean; isAdmin?: boolean } = {}) => {
  const api = fakeProjectApi({ story: storyFor(BOARD, [], ['done', 'done', 'done', 'done'], over.videoStale ? { videoStale: true } : {}), extra: dub.route });
  mountProject(<ProjectPage pollMs={0} />, api.fetchImpl, { path: `/cerita/${ID}?tab=dubbing`, isAdmin: over.isAdmin ?? true });
  return api;
};
const posts = (d: ReturnType<typeof fakeDub>, tail: string) => d.calls.filter(c => c.method === 'POST' && c.url.endsWith(tail));

describe('Dubbing tab', () => {
  it('shows a skeleton, then every scene with its shots, their text and status', async () => {
    open(fakeDub({ voiceId: 'VOICE_ARYA_123456' }));
    const menunggu = await screen.findByRole('region', { name: /scene menunggu/i });
    expect(within(menunggu).getByRole('listitem', { name: 'Shot 00-pembuka' })).toHaveTextContent(/tanpa narasi/i);
    expect(within(menunggu).getByRole('listitem', { name: 'Shot 01-pagar' })).toHaveTextContent('Jingga menunggu setiap sore.');
    expect(within(screen.getByRole('region', { name: /scene pulang/i })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/0\/3 shot sudah di-dub/)).toBeInTheDocument();
  });

  it('shows a skeleton while the dubbing state loads', async () => {
    open(fakeDub({ hang: true }));
    expect(await screen.findByRole('status', { name: /memuat dubbing/i })).toBeInTheDocument();
  });

  it('without a key it says where to add one (a link that opens the settings), disables dubbing and does not pretend to load voices', async () => {
    open(fakeDub({ configured: false }));
    expect(await screen.findByText(/belum ada api key elevenlabs/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /pengaturan › provider/i })).toHaveAttribute('href', '/pengaturan/provider');
    expect(screen.getByRole('button', { name: /dub semua yang belum/i })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Suara' })).toHaveTextContent(/isi api key dulu/i);
    expect(screen.queryByText(/memuat suara/i)).toBeNull();
  });

  it('a member sees no link to the settings (only admins can fill keys)', async () => {
    open(fakeDub({ configured: false }), { isAdmin: false });
    expect(await screen.findByText(/belum ada api key elevenlabs/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /pengaturan/i })).toBeNull();
    expect(screen.getByText(/minta admin/i)).toBeInTheDocument();
  });

  it('needs a voice before it can dub', async () => {
    open(fakeDub());
    await screen.findByRole('region', { name: /scene menunggu/i });
    expect(screen.getByRole('button', { name: /dub semua yang belum/i })).toBeDisabled();
  });

  it('dub per shot: asks the estimate first, shows the credits, and only the confirmation spends them', async () => {
    const d = fakeDub({ voiceId: 'VOICE_ARYA_123456' });
    open(d);
    const row = await screen.findByRole('listitem', { name: 'Shot 01-pagar' });
    await userEvent.click(within(row).getByRole('button', { name: /^dub$/i }));
    const dialog = await screen.findByRole('alertdialog', { name: /konfirmasi biaya/i });
    expect(dialog).toHaveTextContent(/1 shot/);
    expect(dialog).toHaveTextContent(`${TEXTS['01-pagar']!.length} karakter`);
    expect(dialog).toHaveTextContent(`±${TEXTS['01-pagar']!.length} kredit`);
    expect(posts(d, '/render')).toHaveLength(0); // nothing is spent yet
    await userEvent.click(within(dialog).getByRole('button', { name: /lanjut dub/i }));
    await waitFor(() => expect(within(screen.getByRole('listitem', { name: 'Shot 01-pagar' })).getByText('Siap')).toBeInTheDocument());
    expect(posts(d, '/render')).toEqual([expect.objectContaining({ body: { scope: { kind: 'shots', shotIds: ['01-pagar'] }, confirmCredits: TEXTS['01-pagar']!.length } })]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByLabelText('Putar dub 01-pagar')).toHaveAttribute('src', expect.stringContaining('/dub/shots/01-pagar/audio?v=01-pagar-abcd1234'));
  });

  it('cancel on the confirmation spends nothing', async () => {
    const d = fakeDub({ voiceId: 'VOICE_ARYA_123456' });
    open(d);
    await userEvent.click(within(await screen.findByRole('listitem', { name: 'Shot 02-jalan' })).getByRole('button', { name: /^dub$/i }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^batal$/i }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts(d, '/render')).toHaveLength(0);
  });

  it('dub a whole scene, then everything left; the summary follows', async () => {
    const d = fakeDub({ voiceId: 'VOICE_ARYA_123456' });
    open(d);
    await userEvent.click(within(await screen.findByRole('region', { name: /scene pulang/i })).getByRole('button', { name: /dub scene ini/i }));
    const total = TEXTS['02-jalan']!.length + TEXTS['03-peluk']!.length;
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(`±${total} kredit`);
    await userEvent.click(screen.getByRole('button', { name: /lanjut dub/i }));
    await screen.findByText(/2\/3 shot sudah di-dub/);
    expect(posts(d, '/render')[0]!.body).toMatchObject({ scope: { kind: 'scene', sceneId: 'pulang' } });
    await userEvent.click(screen.getByRole('button', { name: /dub semua yang belum/i }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/1 shot/); // only the one left
    await userEvent.click(screen.getByRole('button', { name: /lanjut dub/i }));
    await screen.findByText(/3\/3 shot sudah di-dub/);
  });

  it('when everything is already fresh it says so instead of offering a charge of zero', async () => {
    const d = fakeDub({ voiceId: 'VOICE_ARYA_123456' });
    d.shots.forEach(s => { if (!s.skipped) s.status = 'done'; });
    open(d);
    await userEvent.click(await screen.findByRole('button', { name: /dub semua yang belum/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/semuanya sudah terbaru/i);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a finished shot can be dubbed again (asks again, with force) or removed', async () => {
    const d = fakeDub({ voiceId: 'VOICE_ARYA_123456' });
    d.shots[1]!.status = 'done'; d.shots[1]!.audio = '01-pagar-abcd1234'; d.shots[1]!.seconds = 2.5;
    open(d);
    const row = await screen.findByRole('listitem', { name: 'Shot 01-pagar' });
    await userEvent.click(within(row).getByRole('button', { name: /dub ulang/i }));
    await screen.findByRole('alertdialog');
    expect(posts(d, '/plan')[0]!.body).toMatchObject({ force: true });
    await userEvent.click(screen.getByRole('button', { name: /^batal$/i }));
    await userEvent.click(within(row).getByRole('button', { name: /hapus dub 01-pagar/i }));
    await waitFor(() => expect(within(screen.getByRole('listitem', { name: 'Shot 01-pagar' })).getByText('Belum')).toBeInTheDocument());
  });

  it('edit the text of one shot: saved as its own text, and the shot becomes "perlu ulang"', async () => {
    const d = fakeDub({ voiceId: 'VOICE_ARYA_123456' });
    d.shots[1]!.status = 'done'; d.shots[1]!.audio = '01-pagar-abcd1234';
    open(d);
    await userEvent.click(await screen.findByRole('button', { name: /ubah teks 01-pagar/i }));
    const field = screen.getByLabelText(/teks dubbing 01-pagar/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Ia menunggu, pelan.');
    await userEvent.click(screen.getByRole('button', { name: /simpan teks/i }));
    await waitFor(() => expect(within(screen.getByRole('listitem', { name: 'Shot 01-pagar' })).getByText('Perlu ulang')).toBeInTheDocument());
    expect(d.calls.find(c => c.method === 'PUT' && c.url.endsWith('/shots/01-pagar'))!.body).toEqual({ text: 'Ia menunggu, pelan.' });
    expect(screen.getByText('teks khusus')).toBeInTheDocument();
  });

  it('changing the voice, model, speed and the original sound is saved at once', async () => {
    const d = fakeDub({ voiceId: 'VOICE_ARYA_123456' });
    open(d);
    await screen.findByRole('region', { name: /scene menunggu/i });
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Suara asli klip' })).getByRole('radio', { name: 'Dimatikan' }));
    await waitFor(() => expect(d.settings.keepAmbient).toBe(false));
    await userEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    await userEvent.click(await screen.findByRole('option', { name: /flash v2\.5/i }));
    await waitFor(() => expect(d.settings.modelId).toBe('eleven_flash_v2_5'));
    // the estimate follows the model: half a credit per character
    await userEvent.click(within(screen.getByRole('listitem', { name: 'Shot 01-pagar' })).getByRole('button', { name: /^dub$/i }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(`±${TEXTS['01-pagar']!.length / 2} kredit`);
  });

  it('a failed shot shows the reason; others are unaffected', async () => {
    const d = fakeDub({ voiceId: 'VOICE_ARYA_123456', failShot: '02-jalan' });
    open(d);
    await userEvent.click(await screen.findByRole('button', { name: /dub semua yang belum/i }));
    await userEvent.click(await screen.findByRole('button', { name: /lanjut dub/i }));
    expect(await screen.findByText('ElevenLabs sedang sibuk')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Shot 03-peluk' })).getByText('Siap')).toBeInTheDocument();
    expect(screen.getByText(/1 gagal/)).toBeInTheDocument();
  });

  it('a refused render (no credits) is shown as an error and the confirmation closes', async () => {
    open(fakeDub({ voiceId: 'VOICE_ARYA_123456', renderStatus: 422 }));
    await userEvent.click(within(await screen.findByRole('listitem', { name: 'Shot 01-pagar' })).getByRole('button', { name: /^dub$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /lanjut dub/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/kredit habis/i);
  });

  it('tells you to assemble again when the video is behind the dubbing', async () => {
    const d = fakeDub({ voiceId: 'VOICE_ARYA_123456' });
    d.shots[1]!.status = 'done'; d.shots[1]!.audio = 'x';
    open(d, { videoStale: true });
    expect(await screen.findByText(/rakit ulang video di tab hasil/i)).toBeInTheDocument();
  });

  it('a member who is not an admin can listen but not change or spend', async () => {
    const d = fakeDub({ voiceId: 'VOICE_ARYA_123456' });
    d.shots[1]!.status = 'done'; d.shots[1]!.audio = 'x';
    open(d, { isAdmin: false });
    await screen.findByRole('region', { name: /scene menunggu/i });
    expect(screen.queryByRole('button', { name: /dub semua/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /ubah teks/i })).toBeNull();
    expect(screen.getByLabelText('Putar dub 01-pagar')).toBeInTheDocument();
  });
});
