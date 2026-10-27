import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PendingCard, pendingBlocked } from './PendingCard.js';

const base = { id: 'p_1', label: 'Render 1 klip (±10 kredit Flow)', estimate: { credits: 10 }, createdAt: new Date().toISOString(), rev: 4 };

describe('PendingCard', () => {
  it('is no longer valid once the project moved past the revision it was proposed at (edit or undo)', () => {
    expect(pendingBlocked(base, Date.now(), 4)).toBeUndefined();
    expect(pendingBlocked(base, Date.now(), 5)).toBe('Sudah tidak berlaku');
    // A lagging project view (reload not in yet) never hides a live approval.
    expect(pendingBlocked(base, Date.now(), 3)).toBeUndefined();
    render(<PendingCard pending={base} currentRev={5} onRun={() => undefined} onSkip={() => undefined} />);
    expect(screen.queryByRole('button', { name: /jalankan/i })).toBeNull();
    expect(screen.getByText('Sudah tidak berlaku')).toBeInTheDocument();
  });

  it('shows the estimate once: no second line when the label already carries it', () => {
    render(<PendingCard pending={base} currentRev={4} onRun={() => undefined} onSkip={() => undefined} />);
    expect(screen.getAllByText(/±10 kredit Flow/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /jalankan/i })).toBeEnabled();
  });

  it('keeps the estimate line when the label does not say the cost', () => {
    render(<PendingCard pending={{ ...base, label: 'Render scene 1' }} currentRev={4} onRun={() => undefined} onSkip={() => undefined} />);
    expect(screen.getByText('±10 kredit Flow')).toBeInTheDocument();
  });
});
