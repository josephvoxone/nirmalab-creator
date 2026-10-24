import { describe, expect, it } from 'vitest';
import { inviteState } from './settingsClient.js';

const base = { tokenHash: 'h', createdAt: '2026-10-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', createdBy: 'u1' };
describe('inviteState', () => {
  it('says Dicabut for a revoked invite, Dipakai only for a used one', () => {
    expect(inviteState({ ...base, usedAt: '2026-10-02T00:00:00Z', revokedAt: '2026-10-02T00:00:00Z' }).label).toBe('Dicabut');
    expect(inviteState({ ...base, usedAt: '2026-10-02T00:00:00Z' }).label).toBe('Dipakai');
    expect(inviteState(base)).toMatchObject({ label: 'Aktif', active: true });
  });
});
