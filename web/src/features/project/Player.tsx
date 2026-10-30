/**
 * Compact media preview: a bounded frame (never wider/taller than its box), click or the
 * expand button for fullscreen. `SequencePlayer` plays a list of clips back to back (a scene
 * preview or the whole timeline), showing a still for clips that are not rendered yet.
 */
import { useEffect, useRef, useState } from 'react';
import { Maximize2, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** `from`/`to`: the trimmed window inside the clip file; `caption`: a subtitle shown over it. */
export type Clip = { id: string; label: string; src?: string; poster?: string; seconds: number; from?: number; to?: number; caption?: string; zoom?: number; zoomY?: number };
/** A music track under the sequence: starts at `at` seconds of the sequence, `from` seconds into the song. */
export type SequenceMusic = { src: string; volume: number; at: number; from?: number };

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
  music?: SequenceMusic;
  /** 'tulisan-tangan' letters the caption by hand at the top, like the assembled video. */
  captionStyle?: 'tulisan-tangan';
  /** Font scale and the top of the text (share of the height): drawn exactly as the assembler burns it. */
  captionSize?: number;
  captionY?: number;
  /** Dragging the caption saves a new position (once, when you let go). */
  onCaptionY?: (y: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const clip = props.clips[i];
  const maxH = props.maxH ?? 320;
  const audio = useRef<HTMLAudioElement>(null);
  const [local, setLocal] = useState(0);
  const report = (t: number) => { setLocal(t); props.onTime?.(t); };
  const startOf = (n: number) => props.clips.slice(0, n).reduce((sum, c) => sum + c.seconds, 0);

  // Music follows the sequence clock: silent before its start, re-seeked when it drifts.
  useEffect(() => {
    const a = audio.current;
    const m = props.music;
    if (!a || !m) return;
    a.volume = Math.max(0, Math.min(1, m.volume));
    const global = startOf(i) + local;
    const want = (m.from ?? 0) + global - m.at;
    if (!playing || want < 0 || (Number.isFinite(a.duration) && want >= a.duration)) { if (!a.paused) a.pause(); return; }
    if (Math.abs(a.currentTime - want) > 0.35) a.currentTime = want;
    if (a.paused) Promise.resolve().then(() => a.play()).catch(() => undefined);
  }, [playing, i, local, props.music]); // eslint-disable-line react-hooks/exhaustive-deps
  const ratio = props.aspect === '16:9' ? 16 / 9 : 9 / 16;
  // Caption drag: a live position while the pointer moves, saved on release.
  const [dragY, setDragY] = useState<number>();
  const hand = props.captionStyle === 'tulisan-tangan';
  const captionY = dragY ?? props.captionY;
  const grabCaption = (e: { clientY: number; preventDefault: () => void }) => {
    if (!props.onCaptionY) return;
    e.preventDefault();
    const startY = e.clientY;
    const from = props.captionY ?? (hand ? 0.11 : 0.78);
    const at = (clientY: number) => Math.round(Math.min(0.9, Math.max(0.02, from + (clientY - startY) / maxH)) * 100) / 100;
    const move = (ev: MouseEvent) => setDragY(at(ev.clientY));
    const up = (ev: MouseEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragY(undefined);
      props.onCaptionY?.(at(ev.clientY));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => { props.onIndex?.(i); report(0); }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (props.index !== undefined && props.index >= 0 && props.index < props.clips.length) setI(props.index);
  }, [props.index]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (i >= props.clips.length) setI(0); }, [props.clips.length, i]);

  // Stills (no rendered clip) advance on a timer while playing. The parent rebuilds its clip list on
  // every poll and playhead tick, so the timer keys on the shot (id + length), not on the object, and
  // keeps the time already shown: a re-render never restarts the same still.
  const stillElapsed = useRef({ key: '', ms: 0 });
  const stillKey = clip && !clip.src ? `${i}:${clip.id}:${clip.seconds}` : '';
  useEffect(() => {
    if (!playing || !stillKey || !clip) return;
    if (stillElapsed.current.key !== stillKey) stillElapsed.current = { key: stillKey, ms: 0 };
    const total = clip.seconds * 1000;
    const began = Date.now() - stillElapsed.current.ms;
    const tick = setInterval(() => {
      const ms = Date.now() - began;
      stillElapsed.current.ms = ms;
      if (ms >= total) { clearInterval(tick); stillElapsed.current = { key: '', ms: 0 }; next(); return; }
      report(ms / 1000);
    }, 100);
    return () => clearInterval(tick);
  }, [playing, stillKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const next = () => (i + 1 < props.clips.length ? setI(i + 1) : setPlaying(false));
  return (
    <div className={cn('flex flex-col gap-1.5', props.className)} role="group" aria-label={props.label}>
      <div ref={box} className="relative mx-auto overflow-hidden rounded-md bg-black" style={{ height: maxH, width: Math.round(maxH * ratio), maxWidth: '100%' }}>
        {clip?.src ? (
          <video key={clip.src} ref={video} src={clip.src} poster={clip.poster} playsInline preload="metadata" aria-label={clip.label}
            data-testid="program-video" style={clip.zoom ? { transform: `scale(${clip.zoom})`, transformOrigin: `50% ${(clip.zoomY ?? 0.5) * 100}%` } : undefined}
            onLoadedMetadata={e => { if (clip.from) e.currentTarget.currentTime = clip.from; }}
            onTimeUpdate={e => {
              const t = e.currentTarget.currentTime;
              // The trimmed Out point ends the clip like its real end does.
              if (clip.to !== undefined && t >= clip.to - 0.04) { next(); return; }
              report(Math.max(0, t - (clip.from ?? 0)));
            }}
            onEnded={next} className="size-full object-contain" />
        ) : clip?.poster ? (
          // A slow push-in while it plays (Ken Burns), so a shot without its clip still moves on the timeline.
          <img key={`${i}:${clip.id}`} src={clip.poster} alt={clip.label} decoding="async" className="size-full object-contain opacity-90"
            style={{ animationName: 'nc-ken-burns', animationDuration: `${clip.seconds}s`, animationTimingFunction: 'linear', animationFillMode: 'forwards', animationPlayState: playing ? 'running' : 'paused' }} />
        ) : (
          <div className="flex size-full items-center justify-center text-[12px] text-white/60">{clip?.label} · belum dirender</div>
        )}
        {clip && !clip.src && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10.5px] text-white/80">Keyframe · belum dirender</span>}
        {clip?.caption && (
          // Same share of the frame as the assembler: 4.4 % (hand) / 3.4 % (plain) of the height × size.
          <p data-testid="caption" data-style={props.captionStyle ?? 'biasa'} onPointerDown={grabCaption}
            title={props.onCaptionY ? 'Seret untuk memindah subtitle' : undefined}
            style={{ fontSize: `${Math.round((hand ? 0.044 : 0.034) * maxH * (props.captionSize ?? 1) * 10) / 10}px`, ...(captionY !== undefined ? { top: `${Math.round(captionY * 1000) / 10}%` } : {}) }}
            className={cn('absolute text-center text-white select-none',
              props.onCaptionY ? 'cursor-ns-resize touch-none' : 'pointer-events-none',
              hand ? 'inset-x-[10%] font-hand leading-tight text-[#faf4ea] [text-shadow:0_0_2px_rgba(51,38,26,.75),0_1px_3px_rgba(51,38,26,.5)]'
                : 'inset-x-[8%] leading-snug font-semibold [text-shadow:0_0_3px_#000,0_1px_2px_#000]',
              captionY === undefined && (hand ? 'top-[11%]' : 'bottom-[14%]'))}>{clip.caption}</p>
        )}
        {props.music && <audio ref={audio} src={props.music.src} preload="auto" aria-hidden="true" />}
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
