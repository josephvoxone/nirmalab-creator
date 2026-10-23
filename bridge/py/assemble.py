#!/usr/bin/env python3
"""Assemble a storyboard's shots into one cinematic video.

    /usr/bin/python3 py/assemble.py <slug | path/to/storyboard.json>

Keeps Veo's native audio (voice-over + ambience), crossfades between shots,
animated title card (title_card.py) over the opening shot, fade to black at the end, -14 LUFS / -1 dBTP.
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


def filter_graph(durations, xf, transitions=None, title_input=None, total=None):
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
    if total:
        video += f'fade=t=in:st=0:d=0.8,fade=t=out:st={round(total - 1.2, 3)}:d=1.2,'
    parts.append(video.rstrip(',') + '[vout]' if video not in (f'[{vprev}]', '[vt]') else video + 'null[vout]')
    audio = f'[{aprev}]'
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
            dur = probe_duration(src)
            inputs += ['-i', src]
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
    graph = filter_graph(durations, xf, transitions[1:], title_input=title_input, total=total)
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
    print(json.dumps({'file': final, 'shots': len(durations), 'durations': durations, 'total': total}))


if __name__ == '__main__':
    main(sys.argv[1])
