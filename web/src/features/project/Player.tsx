/**
 * Compact media preview: a bounded frame (never wider/taller than its box), click or the
 * expand button for fullscreen. `SequencePlayer` plays a list of clips back to back (a scene
 * preview or the whole timeline), showing a still for clips that are not rendered yet.
 */
import { useEffect, useRef, useState } from 'react';
import { Maximize2, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export type Clip = { id: string; label: string; src?: string; poster?: string; seconds: number };

async function fullscreen(el: HTMLElement | null) {
  if (!el) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el.requestFullscreen();
  } catch { /* not allowed (e.g. iOS): ignore */ }
}

/** One video, max `maxH` px tall, aspect kept, fullscreen on demand. */
export function ClipPreview(props: { src: string; poster?: string; label: string; maxH?: number; className?: string; autoPlay?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  return (
    <div className={cn('group relative inline-flex max-w-full overflow-hidden rounded-md bg-black', props.className)}>
      <video ref={ref} src={props.src} poster={props.poster} controls playsInline preload="metadata" autoPlay={props.autoPlay} aria-label={props.label}
        style={{ maxHeight: props.maxH ?? 320 }} className="block h-auto max-w-full object-contain" />
      <Button type="button" size="icon-sm" variant="glass" aria-label={`Layar penuh ${props.label}`} onClick={() => void fullscreen(ref.current)}
        className="absolute top-1.5 right-1.5 opacity-80 group-hover:opacity-100"><Maximize2 /></Button>
    </div>
  );
}

/** Plays clips in order; unrendered clips show their still for their duration. */
export function SequencePlayer(props: {
  clips: Clip[]; label: string; maxH?: number; aspect?: '9:16' | '16:9'; className?: string;
  onIndex?: (i: number) => void;
  /** Controlled jump: when this changes the player cues that clip (e.g. a click on the timeline). */
  index?: number;
  /** Seconds into the current clip, for a playhead. */
  onTime?: (seconds: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const clip = props.clips[i];
  const maxH = props.maxH ?? 320;
  const ratio = props.aspect === '16:9' ? 16 / 9 : 9 / 16;

  useEffect(() => { props.onIndex?.(i); props.onTime?.(0); }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (props.index !== undefined && props.index >= 0 && props.index < props.clips.length) setI(props.index);
  }, [props.index]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (i >= props.clips.length) setI(0); }, [props.clips.length, i]);

  // Stills (no rendered clip) advance on a timer while playing.
  useEffect(() => {
    if (!playing || !clip || clip.src) return;
    const t = setTimeout(() => (i + 1 < props.clips.length ? setI(i + 1) : setPlaying(false)), clip.seconds * 1000);
    const began = Date.now();
    const tick = props.onTime ? setInterval(() => props.onTime?.(Math.min(clip.seconds, (Date.now() - began) / 1000)), 250) : undefined;
    return () => { clearTimeout(t); if (tick) clearInterval(tick); };
  }, [playing, clip, i, props.clips.length]);

  useEffect(() => {
    const v = video.current;
    if (!v || !clip?.src) return;
    if (playing) Promise.resolve().then(() => v.play()).catch(() => setPlaying(false));
    else if (!v.paused) v.pause();
  }, [playing, clip?.src, i]);

  if (!props.clips.length) {
    return <div className="flex items-center justify-center rounded-md border border-dashed text-[12px] text-muted-foreground" style={{ height: Math.min(maxH, 160) }}>Belum ada shot untuk diputar.</div>;
  }
  const go = (n: number) => setI(Math.max(0, Math.min(props.clips.length - 1, n)));
  return (
    <div className={cn('flex flex-col gap-1.5', props.className)} role="group" aria-label={props.label}>
      <div ref={box} className="relative mx-auto overflow-hidden rounded-md bg-black" style={{ height: maxH, width: Math.round(maxH * ratio), maxWidth: '100%' }}>
        {clip?.src ? (
          <video key={clip.src} ref={video} src={clip.src} poster={clip.poster} playsInline preload="metadata" aria-label={clip.label}
            onTimeUpdate={e => props.onTime?.(e.currentTarget.currentTime)}
            onEnded={() => (i + 1 < props.clips.length ? setI(i + 1) : setPlaying(false))} className="size-full object-contain" />
        ) : clip?.poster ? (
          <img src={clip.poster} alt={clip.label} decoding="async" className="size-full object-contain opacity-80" />
        ) : (
          <div className="flex size-full items-center justify-center text-[12px] text-white/60">{clip?.label} · belum dirender</div>
        )}
        {clip && !clip.src && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10.5px] text-white/80">Keyframe · belum dirender</span>}
        <Button type="button" size="icon-sm" variant="glass" aria-label={`Layar penuh ${props.label}`} onClick={() => void fullscreen(box.current)} className="absolute top-1.5 right-1.5"><Maximize2 /></Button>
      </div>
      <div className="flex items-center justify-center gap-1 text-[12px] text-muted-foreground">
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Shot sebelumnya" onClick={() => go(i - 1)} disabled={i === 0}><SkipBack /></Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={playing ? 'Jeda' : 'Putar'} onClick={() => setPlaying(p => !p)}>{playing ? <Pause /> : <Play />}</Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Shot berikutnya" onClick={() => go(i + 1)} disabled={i >= props.clips.length - 1}><SkipForward /></Button>
        <span className="ml-1 tabular-nums">{i + 1}/{props.clips.length} · {clip?.label}</span>
      </div>
    </div>
  );
}
