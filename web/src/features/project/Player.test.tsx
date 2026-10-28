import { act, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SequencePlayer, type Clip } from './Player.js';

/** The timeline rebuilds its clip list on every poll and every playhead tick: new objects, same shots. */
function Polling(props: { onIndex: (i: number) => void }) {
  const [, setTick] = useState(0);
  const [, setTime] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 300); return () => clearInterval(t); }, []);
  const clips: Clip[] = [
    { id: '01', label: 'Shot 1', seconds: 2, poster: '/p1.jpg' },
    { id: '02', label: 'Shot 2', seconds: 2, poster: '/p2.jpg' },
    { id: '03', label: 'Shot 3', seconds: 2, poster: '/p3.jpg' }
  ];
  return <SequencePlayer clips={clips} label="Program monitor" onIndex={props.onIndex} onTime={setTime} />;
}

describe('SequencePlayer stills (shots without a clip yet)', () => {
  afterEach(() => vi.useRealTimers());

  it('keep playing through the timeline while the parent re-renders (polling, playhead), instead of restarting the same still', async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    render(<Polling onIndex={i => seen.push(i)} />);
    await act(async () => { screen.getByRole('button', { name: 'Putar' }).click(); });
    // Time passes in small steps with renders in between, as in a browser.
    const passMs = async (ms: number) => { for (let t = 0; t < ms; t += 100) await act(async () => { await vi.advanceTimersByTimeAsync(100); }); };
    await passMs(2300);
    expect(screen.getByText(/2\/3/)).toBeInTheDocument();
    await passMs(2000);
    expect(screen.getByText(/3\/3/)).toBeInTheDocument();
    expect(seen).toEqual(expect.arrayContaining([0, 1, 2]));
  });

  it('a still slowly moves (Ken Burns) while it plays, so the preview never looks frozen', async () => {
    vi.useFakeTimers();
    render(<Polling onIndex={() => undefined} />);
    const still = screen.getByRole('img', { name: 'Shot 1' });
    expect(still.style.animationPlayState).toBe('paused');
    await act(async () => { screen.getByRole('button', { name: 'Putar' }).click(); });
    expect(screen.getByRole('img', { name: 'Shot 1' }).style.animationPlayState).toBe('running');
    expect(screen.getByRole('img', { name: 'Shot 1' }).style.animationDuration).toBe('2s');
  });
});
