#!/usr/bin/env python3
"""Check the E-area assembler features on the ffmpeg you are running (the production image has Debian ffmpeg 5.1).

Run it on the production image without touching /app:

    docker cp bridge/py/assemble.py  <container>:/tmp/e/assemble.py
    docker cp bridge/py/prod_check_assemble.py <container>:/tmp/e/prod_check_assemble.py
    docker exec <container> python3 /tmp/e/prod_check_assemble.py            # 21 clips, like Lentera
    docker exec <container> python3 /tmp/e/prod_check_assemble.py --clips 5   # quicker

Needs only python3 + ffmpeg/ffprobe (no numpy).  It makes its own clips under a temp dir and removes them.  Exit status 0 = every
check passed.  Prints ffmpeg's version, then one line per check (PASS/FAIL/INFO) and the peak memory of each assembly.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import assemble  # noqa: E402

FAILS = []


def say(kind, msg):
    print(f'{kind:5} {msg}', flush=True)
    if kind == 'FAIL':
        FAILS.append(msg)


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def clip(path, seconds, hz):
    r = run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'testsrc2=s=720x1280:r=24:d={seconds}', '-f', 'lavfi', '-i', f'sine=frequency={hz}:duration={seconds}',
             '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path])
    if r.returncode:
        sys.exit('cannot make a test clip: ' + r.stderr[-300:])


def duration(path):
    return float(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).stdout.strip())


def assemble_dir(d, plan):
    """(seconds, peak MB, stdout) of one `assemble.py <dir>` run, memory taken from the kernel's accounting of the process tree."""
    json.dump(plan, open(os.path.join(d, 'assemble.json'), 'w'))
    t0 = time.time()
    p = subprocess.Popen([sys.executable, os.path.join(HERE, 'assemble.py'), d], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = p.communicate()
    peak = None
    try:
        import resource
        peak = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / (1024 * 1024 if sys.platform == 'darwin' else 1024)
    except Exception:
        pass
    if p.returncode:
        say('FAIL', f'assemble.py exited {p.returncode}: {err[-400:]}')
    return time.time() - t0, peak, out


def frames(path):
    """Gray 45x80 frames of the video, as a list of bytes."""
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-an', '-s', '45x80', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
    n = 45 * 80
    return [raw[i:i + n] for i in range(0, len(raw) - n + 1, n)]


def mad(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def check_xfade_names():
    """Every transition the validator allows must work on THIS ffmpeg (5.1 lacks some of the newer ones)."""
    names = getattr(assemble, 'XFADE_TRANSITIONS', None)
    if not names:
        say('INFO', 'assemble.XFADE_TRANSITIONS not present yet: skipped')
        return
    bad = []
    for name in sorted(names):
        r = run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24:d=1',
                 '-filter_complex', f'[0][1]xfade=transition={name}:duration=0.3:offset=0.6', '-f', 'null', '-'])
        if r.returncode:
            bad.append(name)
    say('FAIL' if bad else 'PASS', f'xfade names accepted by this ffmpeg: {len(names) - len(bad)}/{len(names)}' + (f' — NOT supported here: {bad}' if bad else ''))


def check_atempo_timing(d):
    """Where does a voice that goes through `atempo,adelay` begin?  (ffmpeg 9 shows ~0.25 s early; report what 5.1 does.)"""
    v = os.path.join(d, 'v.mp3')
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', '-c:a', 'libmp3lame', v])
    res = {}
    for label, chain in (('no atempo', 'adelay=300|300,apad=whole_dur=4,atrim=0:4'), ('atempo=1.1', 'atempo=1.1,adelay=300|300,apad=whole_dur=4,atrim=0:4')):
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', v, '-af', chain, '-ar', '16000', '-ac', '1', '-f', 's16le', '-'], capture_output=True).stdout
        s = [int.from_bytes(raw[i:i + 2], 'little', signed=True) for i in range(0, len(raw) - 1, 2)]
        loud = [i for i, x in enumerate(s) if abs(x) > 1600]
        res[label] = (loud[0] / 16000, len(s) / 16000) if loud else (None, len(s) / 16000)
    say('INFO', f'voice start / length through the dub chain: {res}  (the plan assumes a start of 0.30 s and a length of 4.00 s)')


def main():
    n = 21
    if '--clips' in sys.argv:
        n = int(sys.argv[sys.argv.index('--clips') + 1])
    first = run(['ffmpeg', '-version']).stdout.splitlines()[0]
    say('INFO', first)
    d = tempfile.mkdtemp(prefix='asm-check-')
    try:
        for i in range(n):
            clip(os.path.join(d, f's{i}.mp4'), 6, 300 + 20 * i)
        voice = os.path.join(d, 'voice.mp3')
        run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=7.6', '-c:a', 'libmp3lame', voice])
        words = [['Sari', 0.0, 0.4], ['menyalakan', 0.45, 1.1], ['lentera,', 1.1, 1.8], ['lalu', 1.85, 2.2], ['pergi', 2.2, 2.7], ['ke', 2.7, 2.9], ['hutan.', 2.9, 3.6]]

        def plan(edit):
            shots = [{'id': f's{i}', **({'dub': {'file': voice, 'seconds': 7.6, 'words': words}} if i in (0, n - 1) else {}), 'narration': 'x'} for i in range(n)]
            return {'slug': 'final', 'crossfade': 0.3, 'shots': shots, 'edit': edit}

        out = {}
        for label, edit in (('beats off', {'fadeIn': 0.25}), ('beats on', {'fadeIn': 0.25, 'beatCuts': {}})):
            secs, peak, stdout = assemble_dir(d, plan(edit))
            final = os.path.join(d, 'final.mp4')
            keep = os.path.join(d, label.replace(' ', '-') + '.mp4')
            shutil.move(final, keep)
            out[label] = (keep, json.loads(stdout) if stdout.strip() else {})
            say('INFO', f'{label}: {secs:.1f} s, peak memory so far {peak and round(peak)} MB, duration {duration(keep):.2f} s')
        off, on = out['beats off'], out['beats on']
        same = abs(duration(off[0]) - duration(on[0])) < 0.05
        say('PASS' if same else 'FAIL', f'beat cuts do not change the length ({duration(off[0]):.2f} vs {duration(on[0]):.2f} s)')
        fo, fn = frames(off[0]), frames(on[0])
        say('PASS' if len(fo) == len(fn) else 'FAIL', f'same number of frames: {len(fo)} vs {len(fn)}')
        diffs = [mad(a, b) for a, b in zip(fo[:150], fn[:150])]
        jump = next((i for i, x in enumerate(diffs) if x > 6), None)
        say('PASS' if jump is not None else 'FAIL', f'the first punch-in of shot 1 shows at frame {jump} (t = {None if jump is None else round(jump / 24, 2)} s); before it the pictures match (max diff {max(diffs[:jump or 1]):.2f})')
        # first frame of the plan with fadeIn=0.25 must be black, with fadeIn=0 must not
        secs, peak, _ = assemble_dir(d, plan({'fadeIn': 0}))
        f0 = frames(os.path.join(d, 'final.mp4'))[0]
        say('PASS' if sum(f0) / len(f0) > 40 else 'FAIL', f'fadeIn 0: the first frame is the picture (mean luma {sum(f0) / len(f0):.0f})')
        say('PASS' if sum(fo[0]) / len(fo[0]) < 20 else 'FAIL', f'fadeIn 0.25: the first frame is dark (mean luma {sum(fo[0]) / len(fo[0]):.0f})')
        check_xfade_names()
        check_atempo_timing(d)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print('RESULT:', 'ALL PASS' if not FAILS else f'{len(FAILS)} FAILED')
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
