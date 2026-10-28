#!/usr/bin/env python3
"""Assemble a storyboard's shots into one cinematic video.

    /usr/bin/python3 py/assemble.py <slug | path/to/storyboard.json>

Keeps Veo's native audio (voice-over + ambience), crossfades between shots,
animated title card (title_card.py) over the opening shot, fade to black at the end, -14 LUFS / -1 dBTP.

Timeline edits (plan `edit` + per-shot `trim`): each clip plays its In..Out window, the clip audio
is scaled by `clipVolume`, a music file is delayed to its start and mixed under the clips, and the
narration lines can be burned in as subtitles (libass), timed to their clips on the output clock.
"""
import json
import os
import shutil
import subprocess
import tempfile
import sys

W, H, FPS = 720, 1280, 24


def xfade_offsets(durations, xf):
    """Start time of each crossfade when clips overlap by `xf` seconds."""
    offsets, t = [], 0.0
    for d in durations[:-1]:
        t += d - xf
        offsets.append(round(t, 3))
        t = round(t, 3)
    return offsets


MIN_CLIP = 1.0


def clip_window(shot, full):
    """(start, length) a clip plays: its trim In..Out inside the file, never shorter than MIN_CLIP."""
    trim = shot.get('trim') or {}
    end = min(float(trim.get('out', full) or full), full)
    start = max(0.0, float(trim.get('in', 0) or 0))
    if end - start < MIN_CLIP:
        start = max(0.0, end - MIN_CLIP)
        end = start + MIN_CLIP if end - start < MIN_CLIP else end
    return round(start, 3), round(min(end, full) - start, 3)


def subtitle_events(durations, xf, texts):
    """(start, end, text) per clip with text, on the output clock (clips overlap by the crossfade)."""
    events, t = [], 0.0
    for i, (d, text) in enumerate(zip(durations, texts)):
        end = t + d - (xf if i < len(durations) - 1 else 0)
        if text and text.strip():
            events.append((round(t, 3), round(end, 3), text.strip()))
        t = round(t + d - xf, 3)
    return events


def _ass_time(t):
    cs = int(round(t * 100))
    return f'{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}'


# Fonts shipped next to this file (title card faces, handwritten subtitles).
FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')
DEJAVU_DIR = '/usr/share/fonts/truetype/dejavu'
# Subtitle looks: 'tulisan-tangan' writes each line by hand into the quiet sky band of an artbook frame.
HANDWRITTEN = 'tulisan-tangan'

def ass_document(events, w, h, style=None):
    """Bottom-centred white captions with a dark outline, sized for the frame; or, with
    style='tulisan-tangan', light hand-lettering (Gochi Hand) top-centre with a soft outline and fades."""
    handwritten = style == HANDWRITTEN
    size = round(h * (0.044 if handwritten else 0.034))
    if handwritten:
        # Warm white letters, a soft translucent brown outline (legible on a bright painted sky), no box.
        style_line = (f'Style: Default,Gochi Hand,{size},&H00EAF4FA,&H00EAF4FA,&H6A1A2633,&H00000000,0,0,0,0,100,100,1,0,1,'
                      f'{max(2, size // 12)},0,8,{round(w * 0.1)},{round(w * 0.1)},{round(h * 0.11)},1')
    else:
        style_line = (f'Style: Default,DejaVu Sans,{size},&H00FFFFFF,&H00FFFFFF,&H00101010,&H64000000,1,0,0,0,100,100,0,0,1,{max(2, size // 14)},1,2,'
                      f'{round(w * 0.08)},{round(w * 0.08)},{round(h * 0.14)},1')
    lines = [
        '[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {w}', f'PlayResY: {h}', 'WrapStyle: 0', '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, '
        'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        style_line,
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ]
    lead = '{\\fad(500,500)\\blur1.5}' if handwritten else ''
    for start, end, text in events:
        safe = text.replace('{', '(').replace('}', ')').replace('\r', '').replace('\n', '\\N')
        lines.append(f'Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{lead}{safe}')
    return '\n'.join(lines) + '\n'


def filter_graph(durations, xf, transitions=None, title_input=None, total=None,
                 clip_volume=None, music_input=None, music=None, subtitles=None, fonts_dir=None):
    parts = []
    n = len(durations)
    for i in range(n):
        parts.append(
            f'[{i}:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},'
            f'fps={FPS},setsar=1,format=yuv420p,settb=AVTB[v{i}]'
        )
        parts.append(f'[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a{i}]')
    offsets = xfade_offsets(durations, xf)
    vprev, aprev = 'v0', 'a0'
    for i in range(1, n):
        tr = (transitions or [])[i - 1] if transitions and i - 1 < len(transitions) else 'fade'
        parts.append(f'[{vprev}][v{i}]xfade=transition={tr}:duration={xf}:offset={offsets[i - 1]}[vx{i}]')
        parts.append(f'[{aprev}][a{i}]acrossfade=d={xf}[ax{i}]')
        vprev, aprev = f'vx{i}', f'ax{i}'
    video = f'[{vprev}]'
    if title_input is not None:
        parts.append(f'[{title_input}:v]format=rgba,setpts=PTS-STARTPTS[ttl]')
        parts.append(f'[{vprev}][ttl]overlay=0:0:eof_action=pass[vt]')
        video = '[vt]'
    if subtitles:
        video += f"subtitles=filename={subtitles}:fontsdir={fonts_dir or DEJAVU_DIR},"
    if total:
        video += f'fade=t=in:st=0:d=0.8,fade=t=out:st={round(total - 1.2, 3)}:d=1.2,'
    parts.append(video.rstrip(',') + '[vout]' if video not in (f'[{vprev}]', '[vt]') else video + 'null[vout]')
    audio = f'[{aprev}]'
    if clip_volume is not None and abs(float(clip_volume) - 1.0) > 1e-6:
        audio += f'volume={round(float(clip_volume), 3)},'
    if music_input is not None and music:
        at_ms = int(round(float(music.get('at', 0)) * 1000))
        tail = f'atrim=0:{round(total - float(music.get("at", 0)), 3)},' if total else ''
        parts.append(
            f'[{music_input}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,{tail}'
            f'volume={round(float(music.get("volume", 0.35)), 3)},adelay={at_ms}|{at_ms}[mus]'
        )
        parts.append(audio.rstrip(',') + ('[clipa]' if audio != f'[{aprev}]' else 'anull[clipa]'))
        parts.append('[clipa][mus]amix=inputs=2:duration=first:normalize=0[mixa]')
        audio = '[mixa]'
    if total:
        audio += f'afade=t=in:st=0:d=0.6,afade=t=out:st={round(total - 1.2, 3)}:d=1.2,'
    audio += 'loudnorm=I=-14:TP=-1.5:LRA=11:linear=true,alimiter=limit=0.794:level=disabled,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
    parts.append(audio + '[aout]')
    return ';'.join(parts)


def probe_duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def flow_home():
    return os.environ.get('FLOW_HOME') or os.path.expanduser('~/Documents/nirmalab/flow')


def expand(p):
    if p.startswith('$FLOW_HOME'):
        p = flow_home() + p[len('$FLOW_HOME'):]
    return os.path.expanduser(p)


def resolve(arg):
    """(plan file, output dir). A directory means server mode: <dir>/assemble.json, clips in <dir>."""
    if os.path.isdir(arg):
        return os.path.join(arg, 'assemble.json'), arg
    if '/' in arg or arg.endswith('.json'):
        story = json.load(open(arg))
        return arg, os.path.join(flow_home(), 'stories', story['slug'])
    return os.path.join(flow_home(), 'stories', arg, 'storyboard.json'), os.path.join(flow_home(), 'stories', arg)


def main(arg):
    story_path, out_dir = resolve(arg)
    story = json.load(open(story_path))
    inputs, durations, transitions = [], [], []
    edit = story.get('edit') or {}
    for shot in story['shots']:
        if shot.get('reuse'):
            src = expand(shot['reuse']['file'])
            start = float(shot['reuse'].get('start', 0))
            dur = probe_duration(src) - start
            inputs += ['-ss', str(start), '-t', f'{dur:.3f}', '-i', src]
        else:
            src = os.path.join(out_dir, f"{shot['id']}.mp4")
            if not os.path.exists(src):
                sys.exit(f'missing shot {shot["id"]}: {src}')
            start, dur = clip_window(shot, probe_duration(src))
            inputs += (['-ss', str(start)] if start else []) + ['-t', f'{dur:.3f}', '-i', src]
        durations.append(round(dur, 3))
        transitions.append(shot.get('transition', 'fade'))
    # keep crossfades shorter than the silence after each shot's narration (Veo lines end ~5.3-5.7 s of 6 s)
    xf = float(story.get('crossfade', 0.3))
    total = round(sum(durations) - xf * (len(durations) - 1), 3)
    title_input = None
    card_cfg = story.get('titleCard')
    if card_cfg:
        from title_card import TitleCard
        seq = tempfile.mkdtemp(prefix='title-seq-')
        card = TitleCard(card_cfg['lines'], kicker=card_cfg.get('kicker'))
        card.write_sequence(seq, FPS)
        title_input = len(durations)
        inputs += ['-framerate', str(FPS), '-i', os.path.join(seq, '%04d.png')]
    music_input, music = None, edit.get('music')
    if music and music.get('path') and os.path.exists(music['path']):
        music_input = sum(1 for a in inputs if a == '-i')
        inputs += (['-ss', str(float(music.get('from', 0)))] if music.get('from') else []) + ['-i', music['path']]
    else:
        music = None
    subs_dir, subs = None, None
    if edit.get('subtitles'):
        texts = [s.get('narration', '') or '' for s in story['shots']]
        events = subtitle_events(durations, xf, texts)
        if events:
            subs_dir = tempfile.mkdtemp(prefix='subs-')
            subs = os.path.join(subs_dir, 'subs.ass')
            open(subs, 'w', encoding='utf-8').write(ass_document(events, W, H, style=edit.get('subtitleStyle')))
    graph = filter_graph(durations, xf, transitions[1:], title_input=title_input, total=total,
                         clip_volume=edit.get('clipVolume'), music_input=music_input, music=music, subtitles=subs,
                         fonts_dir=FONTS_DIR if edit.get('subtitleStyle') == HANDWRITTEN else None)
    final = os.path.join(out_dir, f"{story['slug']}.mp4")
    cmd = ['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', graph, '-map', '[vout]', '-map', '[aout]',
           '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
           '-movflags', '+faststart', '-t', str(total), final]
    try:
        done = subprocess.run(cmd, capture_output=True, text=True)
        if done.returncode != 0:
            lines = [l for l in done.stderr.strip().splitlines() if l.strip()]
            sys.exit('ffmpeg failed: ' + ' | '.join(lines[-4:]))
    finally:
        if card_cfg:
            shutil.rmtree(seq, ignore_errors=True)
        if subs_dir:
            shutil.rmtree(subs_dir, ignore_errors=True)
    print(json.dumps({'file': final, 'shots': len(durations), 'durations': durations, 'total': total}))


if __name__ == '__main__':
    main(sys.argv[1])
