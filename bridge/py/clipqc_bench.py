"""Measure clipqc on THIS host (run it in the production image: the Mac numbers are not the VPS numbers).

    docker exec <container> python3 /app/bridge/py/clipqc_bench.py                 # synthetic 720x1280 clips, nothing needed
    docker exec <container> python3 /app/bridge/py/clipqc_bench.py /data/stories/<id>/*.mp4 --runs 3

Each run is a fresh `python3 clipqc.py` process (what the server spawns: interpreter + numpy import + ffmpeg decode +
analysis).  Prints one JSON report: host versions, per-clip seconds and peak memory, and whether the budget held
(< 5 s and < 300 MB per clip).  Exit 0 = within budget, 1 = over budget, 2 = could not run.
"""
import argparse
import json
import os
import platform
import resource
import statistics
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BUDGET_S, BUDGET_MB = 5.0, 300.0
_RSS_MB = 1024 * 1024 if sys.platform == 'darwin' else 1024


def child(clip: str) -> None:
    """One measured analysis in this fresh process; prints [seconds, own peak MB, peak MB of a child (ffmpeg)]."""
    sys.path.insert(0, HERE)
    import clipqc
    t = time.time()
    clipqc.check_clip(clip, {'move': 'static'})
    print(json.dumps([time.time() - t, resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / _RSS_MB,
                      resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / _RSS_MB]))


def versions() -> dict:
    sys.path.insert(0, HERE)
    import clipqc
    out = {'python': platform.python_version(), 'platform': platform.platform(), 'cpus': os.cpu_count()}
    try:
        import numpy
        out['numpy'] = numpy.__version__
    except ImportError as e:
        out['numpy'] = f'MISSING ({e})'
    first = subprocess.run([clipqc.ffmpeg_bin(), '-version'], capture_output=True, text=True).stdout.splitlines()[:1]
    out['ffmpeg'] = first[0][:80] if first else 'MISSING'
    try:
        out['loadavg'] = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        pass
    return out


def synthetic(tmp: str) -> list:
    """A 6 s, 24 fps, 720x1280 H.264 push-in with a walking figure (streamed to ffmpeg: no frame list in memory)."""
    import numpy as np
    import fixtures_qc as fx   # needs PIL + numpy, like the test suite
    import clipqc
    w, h, path = 720, 1280, os.path.join(tmp, 'bench-720x1280-6s.mp4')
    canvas = fx.painting(1)
    p = subprocess.Popen([clipqc.ffmpeg_bin(), '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', '24', '-i', '-',
                          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'veryfast', path], stdin=subprocess.PIPE)
    for i in range(6 * fx.FPS):
        t = i / fx.FPS
        frame = fx.character(fx.crop_scale(canvas, 1 + 0.1 * t / 6, .5, .5, w, h), t)
        p.stdin.write(np.clip(frame, 0, 255).astype(np.uint8).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError('ffmpeg could not encode the synthetic clip')
    return [path]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('clips', nargs='*')
    ap.add_argument('--runs', type=int, default=3)
    ap.add_argument('--child', help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.child:
        child(a.child)
        return 0
    try:
        host = versions()
        with tempfile.TemporaryDirectory(prefix='clipqc-bench-') as tmp:
            clips = a.clips or synthetic(tmp)
            rows = []
            for c in clips:
                secs, own, ff = [], [], []
                for _ in range(max(1, a.runs)):
                    r = subprocess.run([sys.executable, os.path.abspath(__file__), '--child', c], capture_output=True, text=True, timeout=120)
                    if r.returncode != 0:
                        raise RuntimeError(f'{c}: {(r.stderr or r.stdout).strip().splitlines()[-1:]}')
                    s, o, f = json.loads(r.stdout.strip().splitlines()[-1])
                    secs.append(s), own.append(o), ff.append(f)
                rows.append({'clip': os.path.basename(c), 'seconds_median': round(statistics.median(secs), 2), 'seconds_max': round(max(secs), 2),
                             'python_peak_mb': round(max(own), 1), 'ffmpeg_peak_mb': round(max(ff), 1)})
    except Exception as e:  # noqa: BLE001 - the report must say why it could not run
        print(json.dumps({'error': str(e)[:400]}))
        return 2
    ok = all(r['seconds_max'] < BUDGET_S and r['python_peak_mb'] + r['ffmpeg_peak_mb'] < BUDGET_MB for r in rows)
    print(json.dumps({'host': host, 'budget': {'seconds': BUDGET_S, 'mb': BUDGET_MB}, 'runs': a.runs, 'clips': rows, 'within_budget': ok}, indent=1))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
