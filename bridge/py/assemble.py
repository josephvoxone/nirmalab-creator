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
import re
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


SUNG = '&H0028BEFF'     # spoken words: saturated amber (255, 190, 40); paler gold vanished on a cream painted sky (ASS colours are BGR)
UNSUNG = '&H00EAF4FA'   # words still to come: warm white
KARAOKE_PRE = 0.08      # a cue appears a beat before its first word
KARAOKE_POST = 0.25     # and lingers a moment after its last
KARAOKE_MAX_WORDS = 3   # a few words at a time, not the whole sentence
KARAOKE_MAX_CHARS = 30
KARAOKE_GAP = 0.6       # a pause this long between two words starts a new cue
KARAOKE_MIN_LIT = 0.12  # a word stays lit at least this long: the next cue never pops in over a short last word
KARAOKE_SWAP = 0.35     # cues closer than this swap instantly; only a real pause earns a fade


def shot_starts(durations, xf):
    """Where each shot begins on the output clock (clips overlap by the crossfade)."""
    out, t = [], 0.0
    for d in durations:
        out.append(round(t, 3))
        t = round(t + d - xf, 3)
    return out


def _tokens(text):
    return re.sub(r'[^0-9a-z]+', ' ', (text or '').lower()).split()


def words_match_text(words, text):
    """True when the timed words spell exactly the caption (ignoring case and punctuation)."""
    return bool(words) and _tokens(' '.join(str(w[0]) for w in words)) == _tokens(text)


_SENTENCE_END = re.compile(r'[.!?;:][\"\u201d\u2019)]*$')


def _balanced(words, max_words, max_chars):
    """Cut a run of words into the fewest, evenly sized groups of at most max_words that also fit max_chars (4 -> 2+2, never 3+1)."""
    n = len(words)
    k = -(-n // max_words)
    while True:
        base, extra = divmod(n, k)
        groups, i = [], 0
        for g in range(k):
            size = base + (1 if g < extra else 0)
            groups.append(words[i:i + size])
            i += size
        if k >= n or all(len(g) == 1 or len(' '.join(w[0] for w in g)) <= max_chars for g in groups):
            return groups
        k += 1


def karaoke_cues(words, max_words=KARAOKE_MAX_WORDS, max_chars=KARAOKE_MAX_CHARS, gap=KARAOKE_GAP):
    """Timed words -> short cues of at most max_words: break at sentence ends, commas and long pauses, then cut each run evenly.

    A lone word before a comma is joined to the next run (a one-word flash reads badly); a one-word sentence stays alone.
    """
    runs = []   # [words, reason the run ended]
    cur = []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if _SENTENCE_END.search(w[0]):
            runs.append([cur, 'sentence']); cur = []
        elif nxt is not None and nxt[1] - w[2] > gap:
            runs.append([cur, 'pause']); cur = []
        elif w[0].endswith(','):
            runs.append([cur, 'comma']); cur = []
    if cur:
        runs.append([cur, 'end'])
    merged = []
    i = 0
    while i < len(runs):
        run, reason = runs[i]
        if len(run) == 1 and reason == 'comma' and i + 1 < len(runs):
            runs[i + 1][0] = run + runs[i + 1][0]
        else:
            merged.append(run)
        i += 1
    cues = []
    for run in merged:
        cues += _balanced(run, max_words, max_chars)
    return cues


def _ass_word(word):
    return re.sub(r'\s+', ' ', str(word).replace('{', '(').replace('}', ')').replace('\\', '')).strip()


def karaoke_events(clock_start, tempo, words, window=None):
    """Caption lines that show a few words at a time, with only the word being spoken lit.

    Every cue yields one line per word: the same words, the spoken one in SUNG, the rest in UNSUNG, each line lasting from
    when its word starts to when the next one does (so the light hands over with no gap). A cue after a real pause fades in
    and one before a real pause fades out; cues that follow each other at once swap instantly (a fade would dim the lit word),
    and the next cue never pops in over the last word before it (KARAOKE_MIN_LIT). `clock_start` is when the voice begins on the output clock, `tempo` the speed-up applied to the
    dub, `window` the seconds of dub that survive when it is cut (words starting after it are never spoken, so never shown).
    """
    tempo = tempo if tempo and tempo > 0 else 1.0
    words = [(str(w[0]), float(w[1]), float(w[2])) for w in words if w and str(w[0]).strip()]
    if window is not None:
        words = [w for w in words if w[1] / tempo < window]
    events = []
    cues = karaoke_cues(words)
    prev = None   # (start of the last word, end of the last word) of the cue before, on the output clock
    for ci, cue in enumerate(cues):
        starts = [clock_start + w[1] / tempo for w in cue]
        first_word = starts[0]
        close_prev = prev is not None and first_word - prev[1] < KARAOKE_SWAP
        pre = first_word - KARAOKE_PRE
        if prev is not None:
            pre = max(pre, min(first_word, prev[0] + KARAOKE_MIN_LIT))   # the word before it keeps its light
        starts[0] = max(0.0, pre)
        last_end = clock_start + cue[-1][2] / tempo
        nxt = clock_start + cues[ci + 1][0][1] / tempo if ci + 1 < len(cues) else None
        close_next = nxt is not None and nxt - last_end < KARAOKE_SWAP
        ends = starts[1:] + [last_end + KARAOKE_POST]
        for k, (word, s, e) in enumerate(zip(cue, starts, ends)):
            fade_in = 120 if k == 0 and not close_prev else 0
            fade_out = 200 if k == len(cue) - 1 and not close_next else 0
            text = '{\\fad(%d,%d)}' % (fade_in, fade_out) + ' '.join('{\\1c%s&}%s' % (SUNG if j == k else UNSUNG, _ass_word(w[0])) for j, w in enumerate(cue))
            events.append([round(s, 3), round(max(e, s + 0.04), 3), text, True])
        prev = (clock_start + cue[-1][1] / tempo, last_end)
    for a, b in zip(events, events[1:]):
        a[1] = min(a[1], b[0])
    return [tuple(e) for e in events]


# Fonts shipped next to this file (title card faces, handwritten subtitles).
FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')
DEJAVU_DIR = '/usr/share/fonts/truetype/dejavu'
# Subtitle looks: 'tulisan-tangan' writes each line by hand into the quiet sky band of an artbook frame.
HANDWRITTEN = 'tulisan-tangan'

def ass_document(events, w, h, style=None, size=None, y=None):
    """Bottom-centred white captions with a dark outline, sized for the frame; or, with
    style='tulisan-tangan', light hand-lettering (Gochi Hand) top-centre with a soft outline and fades."""
    handwritten = style == HANDWRITTEN
    base = round(h * (0.044 if handwritten else 0.034))
    size = round(base * size) if size else base
    if handwritten:
        # Warm white letters, a soft translucent brown outline (legible on a bright painted sky), no box.
        style_line = (f'Style: Default,Gochi Hand,{size},&H00EAF4FA,&H00EAF4FA,&H6A1A2633,&H00000000,0,0,0,0,100,100,1,0,1,'
                      f'{max(2, size // 12)},0,8,{round(w * 0.1)},{round(w * 0.1)},{round(h * 0.11)},1')
    else:
        style_line = (f'Style: Default,DejaVu Sans,{size},&H00FFFFFF,&H00FFFFFF,&H00101010,&H64000000,1,0,0,0,100,100,0,0,1,{max(2, size // 14)},1,2,'
                      f'{round(w * 0.08)},{round(w * 0.08)},{round(h * 0.14)},1')
    # Word-by-word captions: the base colour is the warm white, the word being spoken is lit by a colour override. A heavy
    # dark outline keeps both readable on a pale painted sky, where thin white lettering disappeared.
    if handwritten:
        karaoke_line = (f'Style: Karaoke,Gochi Hand,{size},{UNSUNG},{UNSUNG},&H20122030,&H00000000,0,0,0,0,100,100,1,0,1,'
                        f'{max(4, size // 8)},0,8,{round(w * 0.08)},{round(w * 0.08)},{round(h * 0.11)},1')
    else:
        karaoke_line = (f'Style: Karaoke,DejaVu Sans,{size},{UNSUNG},{UNSUNG},&H00101010,&H64000000,1,0,0,0,100,100,0,0,1,{max(4, size // 9)},1,2,'
                        f'{round(w * 0.08)},{round(w * 0.08)},{round(h * 0.14)},1')
    lines = [
        '[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {w}', f'PlayResY: {h}', 'WrapStyle: 0', '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, '
        'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        style_line, karaoke_line,
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ]
    lead = '{\\fad(500,500)\\blur1.5}' if handwritten else ''
    # A chosen position pins the top of the text, centred, at y x height.
    if y is not None:
        lead = f'{{\\an8\\pos({w // 2},{round(h * y)})}}' + lead
    kar_lead = '{\\blur1}' if handwritten else ''   # the fades are per cue, written into the first and last line by karaoke_events
    if y is not None:
        kar_lead = f'{{\\an8\\pos({w // 2},{round(h * y)})}}' + kar_lead
    for ev in events:
        start, end, text = ev[:3]
        if len(ev) > 3 and ev[3]:   # a karaoke cue: its \k tags are already built and every word already escaped
            lines.append(f'Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Karaoke,,0,0,0,,{kar_lead}{text}')
            continue
        safe = text.replace('{', '(').replace('}', ')').replace('\r', '').replace('\n', '\\N')
        lines.append(f'Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{lead}{safe}')
    return '\n'.join(lines) + '\n'


MAX_ZOOM = 1.4


def shot_zoom(shot):
    """Assembly crop into the clip: 1.0 (none) .. MAX_ZOOM."""
    try:
        z = float(shot.get('zoom') or 1.0)
    except (TypeError, ValueError):
        return 1.0
    return min(MAX_ZOOM, max(1.0, z))


def shot_zoom_y(shot):
    """Where the zoom window sits vertically: 0 = pinned to the top, 0.5 = centre (default), 1 = pinned to the bottom.

    Pinned to the bottom, the whole crop comes off the top: that removes the page edge and the made-up caption a
    model sometimes draws there, without touching the characters.
    """
    try:
        y = float(shot.get('zoomY', 0.5))
    except (TypeError, ValueError):
        return 0.5
    if y != y:  # NaN
        return 0.5
    return min(1.0, max(0.0, y))


MAX_DUB_TEMPO = 1.25
DUB_LEAD = 0.3  # the voice starts a moment into the shot, after the crossfade into it
DUB_AMBIENT = 0.12


def dub_tempo(seconds, window, max_tempo=MAX_DUB_TEMPO):
    """(tempo, cut): speed a dub up to fit `window` seconds; past `max_tempo` the rest is cut (with a short fade)."""
    if seconds <= 0:
        return 1.0, False
    if window <= 0:
        return max_tempo, True
    if seconds <= window:
        return 1.0, False
    need = seconds / window
    return (need, False) if need <= max_tempo else (max_tempo, True)


def tail_hold(seconds, window, max_tempo=MAX_DUB_TEMPO, breath=0.35):
    """Seconds of the last frame to hold so a closing dub is heard to the end instead of being cut.

    A dub that fits at `max_tempo` needs none; otherwise the hold is what is still missing plus a breath of quiet.
    """
    if seconds <= 0 or window <= 0 or seconds / max_tempo <= window:
        return 0.0
    return round(seconds / max_tempo - window + breath, 2)


def filter_graph(durations, xf, transitions=None, title_input=None, total=None,
                 clip_volume=None, music_input=None, music=None, subtitles=None, fonts_dir=None, zooms=None,
                 streams='av', zoom_ys=None, dubs=None, tail_hold=0.0):
    """One ffmpeg filter graph.  streams: 'av' (both), 'v' (video chain only) or 'a' (audio chain only).

    Production renders 'v' and 'a' in two ffmpeg runs: in one graph, ffmpeg 5.1 reads every clip to feed the
    audio chain and keeps the raw video frames of the later clips in memory (5.7-8 GB for 21 clips).
    """
    want_v, want_a = 'v' in streams, 'a' in streams
    parts = []
    n = len(durations)
    for i in range(n):
        z = (zooms or [])[i] if zooms and i < len(zooms) else 1.0
        zy = (zoom_ys or [])[i] if zoom_ys and i < len(zoom_ys) else 0.5
        # a centred anchor keeps the exact crop that shipped before the anchor existed
        crop = f'crop={W}:{H}' if zy == 0.5 else f'crop={W}:{H}:(iw-{W})/2:(ih-{H})*{zy}'
        zoom = f'scale=trunc(iw*{z}/2)*2:trunc(ih*{z}/2)*2,{crop},' if z and z > 1.0 else ''
        if want_v:
            parts.append(
                f'[{i}:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},{zoom}'
                f'fps={FPS},setsar=1,format=yuv420p,settb=AVTB'
                + (f',tpad=stop_mode=clone:stop_duration={tail_hold}' if tail_hold and i == n - 1 else '') + f'[v{i}]'
            )
        dub = (dubs or [])[i] if dubs and i < len(dubs) else None
        if want_a and dub:
            lead_ms = int(round(float(dub.get('lead', DUB_LEAD)) * 1000))
            dur = durations[i]
            chain = f"[{dub['input']}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS"
            if float(dub.get('tempo', 1.0)) > 1.0:
                chain += f",atempo={dub['tempo']}"
            chain += f',adelay={lead_ms}|{lead_ms},apad=whole_dur={dur},atrim=0:{dur}'
            if dub.get('cut'):
                chain += f',afade=t=out:st={round(max(0.0, dur - xf - 0.15), 3)}:d=0.15'
            if dub.get('keep'):
                parts.append(chain + f'[ad{i}]')
                parts.append(f"[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={dub['keep']},asetpts=PTS-STARTPTS[ac{i}]")
                parts.append(f'[ad{i}][ac{i}]amix=inputs=2:duration=longest:normalize=0,atrim=0:{dur}[a{i}]')
            else:
                parts.append(chain + f'[a{i}]')
        elif want_a:
            parts.append(f'[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a{i}]')
    offsets = xfade_offsets(durations, xf)
    vprev, aprev = 'v0', 'a0'
    for i in range(1, n):
        tr = (transitions or [])[i - 1] if transitions and i - 1 < len(transitions) else 'fade'
        if want_v:
            parts.append(f'[{vprev}][v{i}]xfade=transition={tr}:duration={xf}:offset={offsets[i - 1]}[vx{i}]')
        if want_a:
            parts.append(f'[{aprev}][a{i}]acrossfade=d={xf}[ax{i}]')
        vprev, aprev = f'vx{i}', f'ax{i}'
    video = f'[{vprev}]'
    if want_v:
        if title_input is not None:
            parts.append(f'[{title_input}:v]format=rgba,setpts=PTS-STARTPTS[ttl]')
            parts.append(f'[{vprev}][ttl]overlay=0:0:eof_action=pass[vt]')
            video = '[vt]'
        if subtitles:
            video += f"subtitles=filename={subtitles}:fontsdir={fonts_dir or DEJAVU_DIR},"
        if total:
            video += f'fade=t=in:st=0:d=0.8,fade=t=out:st={round(total - 1.2, 3)}:d=1.2,'
        parts.append(video.rstrip(',') + '[vout]' if video not in (f'[{vprev}]', '[vt]') else video + 'null[vout]')
    if not want_a:
        return ';'.join(parts)
    audio = f'[{aprev}]'
    if clip_volume is not None and abs(float(clip_volume) - 1.0) > 1e-6:
        audio += f'volume={round(float(clip_volume), 3)},'
    if music_input is not None and music:
        at_ms = int(round(float(music.get('at', 0)) * 1000))
        tail = f'atrim=0:{round(total - float(music.get("at", 0)), 3)},' if total else ''
        # Under a dubbed voice the bed gets out of the way: the clips' audio (the voice) is the sidechain key, and the
        # rumble below the voice is cleared (measured: ~12 dB lower while speaking, back up in the pauses).
        duck = any(dubs or [])
        parts.append(
            f'[{music_input}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,{tail}'
            f'{"highpass=f=90," if duck else ""}volume={round(float(music.get("volume", 0.35)), 3)},adelay={at_ms}|{at_ms}[mus]'
        )
        parts.append(audio.rstrip(',') + ('[clipa]' if audio != f'[{aprev}]' else 'anull[clipa]'))
        if duck:
            # The key only steers the compressor, so lift it +6 dB: dubs sit around -25..-30 dBFS before the final loudness pass
            # and the ducking depth must not depend on how quiet the voice happens to be.
            parts.append('[clipa]asplit=2[clipm][clipk0]')
            parts.append('[clipk0]volume=2[clipk]')
            parts.append('[mus][clipk]sidechaincompress=threshold=0.015:ratio=9:attack=40:release=700:makeup=1[musd]')
            parts.append('[clipm][musd]amix=inputs=2:duration=first:normalize=0[mixa]')
        else:
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


def run_ffmpeg(cmd, label):
    """Run one ffmpeg pass; exit with a message that says what happened (a killed process has no stderr)."""
    done = subprocess.run(cmd, capture_output=True, text=True)
    if done.returncode == 0:
        return
    if done.returncode in (-9, 137):
        sys.exit(f'ffmpeg ({label}) was killed (SIGKILL): the server most likely ran out of memory')
    if done.returncode < 0:
        sys.exit(f'ffmpeg ({label}) was killed by signal {-done.returncode}')
    lines = [l for l in done.stderr.strip().splitlines() if l.strip()]
    sys.exit(f'ffmpeg failed ({label}): ' + ' | '.join(lines[-4:]))


def main(arg):
    story_path, out_dir = resolve(arg)
    story = json.load(open(story_path))
    inputs, durations, transitions = [], [], []
    zooms = [shot_zoom(s) for s in story['shots']]
    zoom_ys = [shot_zoom_y(s) for s in story['shots']]
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
    dubs, warnings, last_hold = [], [], 0.0
    karaoke = {}   # shot index -> (tempo, words, window when the dub is cut)
    for i, shot in enumerate(story['shots']):
        d = shot.get('dub')
        if not d or not d.get('file'):
            dubs.append(None)
            continue
        dub_file = expand(d['file'])
        if not os.path.exists(dub_file):
            warnings.append(f"{shot['id']}: dub file is missing, the clip's own audio is kept")
            dubs.append(None)
            continue
        seconds = float(d.get('seconds') or probe_duration(dub_file))
        window = durations[i] - DUB_LEAD - (xf if i < len(durations) - 1 else 0.2)
        if i == len(durations) - 1:
            # The closing line is never cut: hold the last frame for as long as the fastest tempo still lacks.
            hold = tail_hold(seconds, window)
            if hold:
                last_hold = hold
                durations[i] = round(durations[i] + hold, 3)
                window += hold
                warnings.append(f"{shot['id']}: the last frame is held {hold:.2f}s so the closing line is heard to the end")
        tempo, cut = dub_tempo(seconds, window)
        if cut:
            warnings.append(f"{shot['id']}: dub {seconds:.1f}s does not fit the {window:.1f}s window even at {tempo}x: the end is cut")
        elif tempo > 1.0:
            warnings.append(f"{shot['id']}: dub {seconds:.1f}s sped up {tempo:.2f}x to fit the {window:.1f}s window")
        if d.get('words'):
            karaoke[i] = (tempo, d['words'], window if cut else None)
        idx = sum(1 for a in inputs if a == '-i')
        inputs += ['-i', dub_file]
        dubs.append({'input': idx, 'tempo': round(tempo, 3), 'lead': DUB_LEAD, 'cut': cut,
                     **({'keep': DUB_AMBIENT} if edit.get('dubKeepAmbient') else {})})
    subs_dir, subs = None, None
    if edit.get('subtitles'):
        texts = [s.get('narration', '') or '' for s in story['shots']]
        # A dubbed shot whose caption is exactly what the voice says gets a karaoke sweep timed from the dub's own word
        # timings; every other shot keeps the plain caption for its whole window.
        karaoke_events_out, starts = [], shot_starts(durations, xf)
        if edit.get('subtitleKaraoke', True):
            for i, (tempo, words, cut_window) in karaoke.items():
                if words_match_text(words, texts[i]):
                    karaoke_events_out += karaoke_events(starts[i] + DUB_LEAD, tempo, words, cut_window)
                    texts[i] = ''
        events = sorted(subtitle_events(durations, xf, texts) + karaoke_events_out, key=lambda e: e[0])
        if events:
            subs_dir = tempfile.mkdtemp(prefix='subs-')
            subs = os.path.join(subs_dir, 'subs.ass')
            open(subs, 'w', encoding='utf-8').write(ass_document(events, W, H, style=edit.get('subtitleStyle'),
                                                                size=edit.get('subtitleSize'), y=edit.get('subtitleY')))
    total = round(sum(durations) - xf * (len(durations) - 1), 3)
    graph_args = dict(title_input=title_input, total=total, clip_volume=edit.get('clipVolume'),
                      music_input=music_input, music=music, subtitles=subs, tail_hold=last_hold,
                      fonts_dir=FONTS_DIR if edit.get('subtitleStyle') == HANDWRITTEN else None, zooms=zooms, zoom_ys=zoom_ys, dubs=dubs)
    vgraph = filter_graph(durations, xf, transitions[1:], streams='v', **graph_args)
    agraph = filter_graph(durations, xf, transitions[1:], streams='a', **graph_args)
    final = os.path.join(out_dir, f"{story['slug']}.mp4")
    work = tempfile.mkdtemp(prefix='.pass-', dir=out_dir)
    vfile, afile = os.path.join(work, 'video.mp4'), os.path.join(work, 'audio.m4a')
    try:
        # Two sequential passes (see filter_graph): each reads the clips but only one stream is rendered.
        run_ffmpeg(['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', vgraph, '-map', '[vout]',
                    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-t', str(total), vfile],
                   'video pass')
        run_ffmpeg(['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', agraph, '-map', '[aout]',
                    '-c:a', 'aac', '-b:a', '192k', '-t', str(total), afile], 'audio pass')
        run_ffmpeg(['ffmpeg', '-y', '-v', 'error', '-i', vfile, '-i', afile, '-map', '0:v:0', '-map', '1:a:0',
                    '-c', 'copy', '-movflags', '+faststart', final], 'mux')
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if card_cfg:
            shutil.rmtree(seq, ignore_errors=True)
        if subs_dir:
            shutil.rmtree(subs_dir, ignore_errors=True)
    print(json.dumps({'file': final, 'shots': len(durations), 'durations': durations, 'total': total, **({'warnings': warnings} if warnings else {})}))


if __name__ == '__main__':
    main(sys.argv[1])
