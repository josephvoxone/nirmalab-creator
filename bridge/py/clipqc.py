"""clipqc — deterministic motion/composition QC for one generated clip (numpy + ffmpeg only, no credits).

No GPU, no scipy/cv2, no network.  One clip = one ffmpeg decode (small gray rawvideo) + numpy; budget on one VPS
core: < 5 s per 6 s / 720x1280 clip (bridge/py/clipqc_bench.py measures it on the host that runs it).  Only the
painterly look has been tested; thresholds (TH) were tuned on 21 shots of one film + 12 other clips, with no
human hold-out.  Small identity glitches (a hood going up in 0.2 s) are NOT detected: that needs the vision audit.

CLI (what server/src/media/motion-qc.ts runs):
    python3 clipqc.py clip.mp4 --move push-in --look painterly --keyframe kf.png --zoom 1.0
prints one JSON verdict and exits 0; an unreadable clip prints {"error": "..."} and exits 2.

Public API
    analyze_frames(gray, fps)         -> Features   (pure numpy; what the tests drive)
    analyze_clip(path)                -> Features   (ffmpeg decode, then analyze_frames)
    judge(features, intent=None, keyframe_ncc=None) -> Verdict  (score 0-100, ok|warn|fail, reasons, free fixes)
    check_clip(path, intent=None, keyframe=None)     -> Verdict  (= analyze_clip + judge)

Frames: gray uint8 (N, 256, 144), area-downscaled from the clip.
Camera model: global zoom + translation by Gauss-Newton (Lucas-Kanade) on a 3-level pyramid, robust
(Tukey) weights so a moving character does not drag the estimate.  Zoom is the cumulative product of
non-overlapping 0.25 s steps.  s > 1 = content gets bigger (dolly-in), s < 1 = pull-back.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import asdict, dataclass, field

import numpy as np

GW, GH = 144, 256          # gray analysis size
MAX_SECONDS = 15.0         # never decode more than this: cost and memory stay bounded whatever the engine returns
DECODE_TIMEOUT_S = 30


class ClipError(Exception):
    """The clip could not be decoded (missing, corrupt, no video stream).  Never a verdict."""
LAG = 6                    # frames per camera step (0.25 s at 24 fps)

# --------------------------------------------------------------------------------------------------
# decode
# --------------------------------------------------------------------------------------------------


def ffmpeg_bin() -> str:
    return os.environ.get('QC_FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg'


def _decode(path: str, w: int, h: int, fps: float) -> np.ndarray:
    cmd = [ffmpeg_bin(), '-nostdin', '-v', 'error', '-i', path, '-t', str(MAX_SECONDS), '-an', '-sn',
           '-vf', f'fps={fps},scale={w}:{h}:flags=area,format=gray', '-f', 'rawvideo', '-']
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=DECODE_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise ClipError(f'ffmpeg: {e}'[:300])
    if r.returncode != 0 or not r.stdout:
        detail = (r.stderr or b'').decode('utf-8', 'replace').strip().splitlines()
        raise ClipError(('ffmpeg: ' + (detail[-1] if detail else 'no video frames'))[:300])
    a = np.frombuffer(r.stdout, np.uint8)
    n = a.size // (w * h)
    if n == 0:
        raise ClipError('ffmpeg: no video frames')
    return a[:n * w * h].reshape(n, h, w)


def probe_fps(path: str) -> float:
    """Frame rate from the header, clamped: a VFR/odd header (90000/1, 0/0) must not blow up the frame count."""
    ffprobe = os.path.join(os.path.dirname(ffmpeg_bin()), 'ffprobe')
    ffprobe = ffprobe if os.path.exists(ffprobe) else (shutil.which('ffprobe') or 'ffprobe')
    try:
        out = subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate',
                              '-of', 'csv=p=0', path], capture_output=True, text=True, timeout=15).stdout.strip()
        n, d = out.split('/')
        fps = float(n) / float(d)
    except Exception:
        return 24.0
    return fps if 8.0 <= fps <= 60.0 else 24.0


# --------------------------------------------------------------------------------------------------
# camera model (zoom + translation), Lucas-Kanade
# --------------------------------------------------------------------------------------------------


def _down(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[0] // 2 * 2, img.shape[1] // 2 * 2
    i = img[:h, :w]
    return (i[0::2, 0::2] + i[1::2, 0::2] + i[0::2, 1::2] + i[1::2, 1::2]) * 0.25


def _blur(img: np.ndarray) -> np.ndarray:
    p = np.pad(img, 1, mode='edge')
    return (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:] + 2 * p[1:-1, :-2] + 4 * p[1:-1, 1:-1] + 2 * p[1:-1, 2:]
            + p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) / 16.0


def _sample(img: np.ndarray, sx: np.ndarray, sy: np.ndarray):
    h, w = img.shape
    valid = (sx >= 0) & (sx <= w - 1) & (sy >= 0) & (sy <= h - 1)
    sx = np.clip(sx, 0, w - 1.001)
    sy = np.clip(sy, 0, h - 1.001)
    x0, y0 = sx.astype(np.int32), sy.astype(np.int32)
    fx, fy = sx - x0, sy - y0
    v = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
         + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)
    return v, valid


def _inner(h: int, w: int) -> np.ndarray:
    m = max(2, int(0.06 * w))
    inner = np.zeros((h, w), bool)
    inner[m:h - m, m:w - m] = True
    return inner


def estimate_step(a: np.ndarray, b: np.ndarray, levels: int = 3, iters: int = 5) -> dict:
    """Global (zoom, tx, ty) so that b(p) ~ a(p + za*(p-c) + t).  Returns zoom s = 1/(1+za) (s>1: b is a
    magnified a), shifts in px of the gray grid, residuals before/after (0-1 gray units), mean gradient."""
    A = [a.astype(np.float32) / 255.0]
    B = [b.astype(np.float32) / 255.0]
    for _ in range(levels - 1):
        A.append(_down(A[-1]))
        B.append(_down(B[-1]))
    za, tx, ty = 0.0, 0.0, 0.0
    for lv in range(levels - 1, -1, -1):
        Al, Bl = _blur(A[lv]), _blur(B[lv])
        h, w = Al.shape
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
        cx, cy = (w - 1) / 2, (h - 1) / 2
        rx, ry = xs - cx, ys - cy
        inner = _inner(h, w)
        if lv < levels - 1:
            tx, ty = tx * 2, ty * 2  # carry shifts to the finer level
        for _ in range(iters if lv else iters + 2):
            aw, valid = _sample(Al, xs + za * rx + tx, ys + za * ry + ty)
            ok = valid & inner
            err = Bl - aw
            gy, gx = np.gradient(aw)
            J = np.stack([(gx * rx + gy * ry)[ok], gx[ok], gy[ok]], 1)
            e = err[ok]
            if e.size < 50:
                break
            sig = 1.4826 * np.median(np.abs(e - np.median(e))) + 1e-4
            wgt = np.clip(1 - (e / (4.685 * sig)) ** 2, 0, None) ** 2
            H = J.T @ (J * wgt[:, None]) + 1e-6 * np.eye(3)
            g = J.T @ (e * wgt)
            try:
                dp = np.linalg.solve(H, g)
            except np.linalg.LinAlgError:
                break
            dp[0] = np.clip(dp[0], -0.05, 0.05)
            za, tx, ty = za + dp[0], tx + dp[1], ty + dp[2]
            if abs(dp[0]) < 1e-5 and abs(dp[1]) < 0.01 and abs(dp[2]) < 0.01:
                break
    h, w = A[0].shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = (w - 1) / 2, (h - 1) / 2
    inner = _inner(h, w)
    aw, valid = _sample(A[0], xs + za * (xs - cx) + tx, ys + za * (ys - cy) + ty)
    ok = valid & inner
    res1 = float(np.abs(B[0] - aw)[ok].mean())
    res0 = float(np.abs(B[0] - A[0])[inner].mean())
    gy, gx = np.gradient(_blur(A[0]))
    tex = float(np.hypot(gx, gy)[inner].mean())
    return dict(s=float(1.0 / (1.0 + za)), tx=float(tx), ty=float(ty), res0=res0, res1=res1, tex=tex)


# --------------------------------------------------------------------------------------------------
# features
# --------------------------------------------------------------------------------------------------

# Every number below was set against the 21 shots of "Lentera" + 12 other Flow clips (see 05-qc-gerak.md §3).
TH = dict(
    morph_dab=0.045,        # mean |A-B| (0-1 gray, 72x128) between the two ends of a blend window
    morph_straight=1.06,    # (d(A,Ft)+d(Ft,B))/d(A,B): exactly 1.0 for a pixelwise blend, > 1.1 for real motion
    morph_big_dab=0.09, morph_big_straight=1.15,   # a very large change may blend more slowly (walking figure on top)
    morph_ncc=0.85,         # ends that correlate this well AND differ >40 % in brightness are a fade, not a scene change
    morph_fail_dab=0.08,
    edge_warn=60.0, edge_fail=100.0,    # luma step (0-255) between the outer 2 px of an edge and the picture 7-14 % inside, GAINED over the clip
    edge_cover=0.6,                     # share of the edge (8 segments) that must show it: a border runs along the whole edge
    paper_band=1.4,         # % of a dimension: flat pale band growing at left/right/bottom
    pullback=0.92, pullback_tail=0.94,  # cumulative scale (first->last) / last 2 s
    still_obj=0.0075, still_area=0.12,  # camera-compensated residual / share of pixels changing in 0.5 s
    freeze_tail_s=1.0, freeze_run_s=1.5,
    cut_gray=0.08, cut_ratio=8.0,
    zoom_step=0.05, zoom_step_ratio=4.0,
    speed_pct_s=10.0,       # push-in faster than this %/s is not "slowly"
    kf_warn=0.75, kf_fail=0.50,       # best NCC between keyframe and the first 0.5 s of the clip
    fade_dark=0.30,
)
SUGGEST_ZOOM = 1.12
PULLBACK_OK = {'pull-back', 'rise', 'aerial-reveal', 'dolly-zoom', 'crane-up', 'dolly-out', 'tilt-up'}
PUSH = {'push-in', 'dolly-in', 'zoom-in'}


@dataclass
class Features:
    fps: float
    n: int
    seconds: float
    motion_mean: float = 0.0            # mean |frame diff| (0-1)
    changed_area: float = 0.0           # share of pixels changing > 6/255 over 0.5 s
    block_active: float = 0.0           # share of 8x16 blocks whose 0.5 s change exceeds 0.02 at least once
    obj_motion: float = 0.0             # median residual after camera compensation (0-1): the characters' own motion
    zoom_total: float = 1.0             # cumulative scale first->last (s>1 = dolly-in)
    zoom_first: float = 1.0             # scale over the first half
    zoom_last2s: float = 1.0            # scale over the last 2 s
    zoom_speed_pct_s: float = 0.0       # |ln zoom| / seconds * 100
    zoom_step_max: float = 0.0          # largest single 0.25 s step |ln s|
    zoom_step_spike: float = 0.0        # that step / median step
    zoom_step_at: float = -1.0
    pan_x: float = 0.0                  # total horizontal shift, % of width
    pan_y: float = 0.0
    cam_conf: float = 0.0               # share of steps usable for the camera estimate
    edge_gain: dict = field(default_factory=dict)    # edge -> median over 8 segments of (step_end - step_start), luma 0-255
    edge_cover: dict = field(default_factory=dict)   # edge -> share of segments with a gain > 30
    ring_lift: float = 0.0              # best edge gain (needs cover >= TH['edge_cover'])
    ring_lift_edge: str = ''
    ring_lift_at: float = -1.0          # onset: first frame 20 % into the final gain
    paper_band_end: float = 0.0         # flat pale band at left/right/bottom, % (strict detector)
    paper_band_growth: float = 0.0
    freeze_longest_s: float = 0.0
    freeze_tail_s: float = 0.0
    freeze_head_s: float = 0.0
    cut_gray: float = 0.0               # largest single-frame |diff| (0-1)
    cut_ratio: float = 0.0
    cut_at: float = -1.0
    morph_dab: float = 0.0              # strongest blend-like change (dissolve / scene swap / re-draw)
    morph_straight: float = 9.9
    morph_at: float = -1.0
    morph_strict: bool = False
    luma_start: float = 0.0
    luma_end: float = 0.0
    zoom_curve: list = field(default_factory=list)

    def to_dict(self):
        return asdict(self)


def _band(frame: np.ndarray, edge: str, mean_min=215.0, std_max=4.0) -> float:
    """Width of the pale, flat paper band at one edge, % of that dimension (frame gray 0-255)."""
    h, w = frame.shape
    if edge == 'bottom':
        lines, size = frame[::-1], h
    elif edge == 'top':
        lines, size = frame, h
    elif edge == 'left':
        lines, size = frame.T, w
    else:
        lines, size = frame.T[::-1], w
    k = int(size * 0.25)
    mean = lines[:k].mean(1)
    std = lines[:k].std(1)
    ok = (mean >= mean_min) & (std <= std_max)
    bad = np.flatnonzero(~ok)
    n = int(bad[0]) if bad.size else len(ok)
    return 100.0 * n / size


EDGES = ('top', 'bottom', 'left', 'right')


def _ring(f: np.ndarray, p: float = 0.05) -> dict:
    h, w = f.shape
    a, b = max(2, int(h * p)), max(2, int(w * p))
    return {'top': float(f[:a].mean()), 'bottom': float(f[-a:].mean()), 'left': float(f[:, :b].mean()),
            'right': float(f[:, -b:].mean())}


def _down2(g: np.ndarray) -> np.ndarray:
    return (g[:, 0::2, 0::2] + g[:, 1::2, 0::2] + g[:, 0::2, 1::2] + g[:, 1::2, 1::2]) * 0.25


def find_blend(gray: np.ndarray, fps: float) -> tuple[float, float, float, bool]:
    """Strongest 'pixelwise blend' window: (dAB, straightness, centre time).  For F_t = a*A + (1-a)*B the L1 distances
    add up exactly (d(A,F)+d(F,B) = d(A,B)); moving edges break that (ratio > 1.1), so ratio ~ 1 with a large d(A,B)
    means two different pictures are cross-dissolving (or one is being re-drawn into the other)."""
    g = _down2(gray.astype(np.float32) / 255.0)
    n = len(g)
    best = (0.0, 9.9, -1.0, False)
    for hh in sorted({max(3, int(round(x * fps / 24))) for x in (6, 9, 12)}):
        for c in range(hh, n - hh):
            A, B = g[c - hh], g[c + hh]
            dab = float(np.abs(A - B).mean())
            if dab < TH['morph_dab'] or (dab <= best[0] and best[3]):
                continue
            mid = g[c - hh + 1:c + hh]
            da = np.abs(mid - A).mean((1, 2))
            db = np.abs(mid - B).mean((1, 2))
            straight = float(np.mean((da + db) / dab))
            alpha = da / dab
            limit = TH['morph_big_straight'] if dab >= TH['morph_big_dab'] else TH['morph_straight']
            if straight > limit or alpha.std() < 1e-6:
                continue
            if float(np.corrcoef(np.arange(len(mid)), alpha)[0, 1]) < 0.9:
                continue
            a0, b0 = A - A.mean(), B - B.mean()
            ncc = float((a0 * b0).sum() / (np.sqrt((a0 ** 2).sum() * (b0 ** 2).sum()) + 1e-9))
            ma, mb = float(A.mean()), float(B.mean())
            if ncc > TH['morph_ncc'] and min(ma, mb) / (max(ma, mb) + 1e-6) < 0.6:
                continue   # same picture, only brighter/darker: a fade, not a scene change
            strict_hit = straight <= TH['morph_straight']
            if strict_hit or not best[3]:           # a strict (exact-blend) window outranks a loose one
                best = (dab, straight, c / fps, strict_hit)
    return best


def _edge_steps(g: np.ndarray, px: int = 2, segs: int = 8) -> dict:
    """Per frame and per edge segment: mean luma of the outer `px` pixels minus the mean of the band 7-14 % inside."""
    out = {}
    n, h, w = g.shape
    for e in EDGES:
        a = {'top': g, 'bottom': g[:, ::-1], 'left': g.transpose(0, 2, 1), 'right': g[:, :, ::-1].transpose(0, 2, 1)}[e]
        depth = a.shape[1]
        outer = a[:, :px].mean(1)
        ref = a[:, int(depth * 0.07):int(depth * 0.14)].mean(1)
        d = outer - ref
        m = d.shape[1] // segs * segs
        out[e] = d[:, :m].reshape(n, segs, -1).mean(2)
    return out


def analyze_frames(gray: np.ndarray, fps: float = 24.0) -> Features:
    n = len(gray)
    f = Features(fps=fps, n=n, seconds=n / fps)
    if n < 6:
        return f
    g = gray.astype(np.float32) / 255.0
    d = np.abs(np.diff(g, axis=0)).mean((1, 2))
    f.motion_mean = float(d.mean())
    L = max(1, int(round(0.5 * fps)))
    if n > L:
        diff = np.abs(g[L:] - g[:-L])
        f.changed_area = float((diff > 6 / 255).mean())
        bh, bw = GH // 16, GW // 8
        blocks = diff[:, :bh * 16, :bw * 8].reshape(len(diff), 16, bh, 8, bw).mean((2, 4))
        f.block_active = float((blocks.max(0) > 0.02).mean())
    # dissolve / scene swap / re-draw
    f.morph_dab, f.morph_straight, f.morph_at, f.morph_strict = find_blend(gray, fps)
    # single-frame hard cut
    med = float(np.median(d)) + 1e-4
    j = int(d.argmax())
    f.cut_gray, f.cut_ratio, f.cut_at = float(d[j]), float(d[j] / med), (j + 1) / fps
    # camera: cumulative zoom from non-overlapping 0.25 s steps (steps that straddle a scene swap or a cut are not camera motion)
    is_cut = f.cut_gray >= TH['cut_gray'] and f.cut_ratio >= TH['cut_ratio']
    blind = [(f.morph_at - 0.7, f.morph_at + 0.7)] if f.morph_strict else []
    blind += [(f.cut_at - 0.4, f.cut_at + 0.4)] if is_cut else []
    step = max(2, int(round(LAG * fps / 24)))
    logz, curve, ok_n, tot, steps, res, px, py = 0.0, [(0.0, 1.0)], 0, 0, [], [], 0.0, 0.0
    for i in range(0, n - step, step):
        r = estimate_step(gray[i], gray[i + step])
        tot += 1
        mid_t = (i + step / 2) / fps
        usable = r['tex'] > 0.006 and r['res1'] <= r['res0'] + 1e-4 and not any(a <= mid_t <= b for a, b in blind)
        ls = 0.0
        if usable:
            ok_n += 1
            ls = float(np.log(r['s']))
            logz += ls
            px += r['tx'] / GW * 100
            py += r['ty'] / GH * 100
        steps.append(ls)
        res.append(r['res1'])
        curve.append(((i + step) / fps, float(np.exp(logz))))
    f.cam_conf = ok_n / max(tot, 1)
    f.zoom_total = float(np.exp(logz))
    f.zoom_curve = [(round(a, 3), round(b, 4)) for a, b in curve]
    tt = np.array([a for a, _ in curve])
    zz = np.array([b for _, b in curve])
    f.zoom_first = float(zz[min(len(zz) - 1, np.searchsorted(tt, f.seconds / 2))])
    z_at = zz[min(len(zz) - 1, np.searchsorted(tt, max(0.0, tt[-1] - 2.0)))]
    f.zoom_last2s = float(zz[-1] / z_at) if z_at else 1.0
    f.zoom_speed_pct_s = abs(logz) / max(f.seconds, 1e-6) * 100
    f.pan_x, f.pan_y = px, py
    f.obj_motion = float(np.median(res)) if res else 0.0
    a = np.abs(np.array(steps))
    if a.size:
        j = int(a.argmax())
        nb = np.concatenate([a[max(0, j - 2):j], a[j + 1:j + 3]])
        f.zoom_step_max = float(a[j])
        f.zoom_step_spike = float(a[j] / (nb.mean() + 0.004)) if nb.size else 0.0   # vs its own neighbours: a jump, not a ramp
        f.zoom_step_at = (j + 0.5) * step / fps
    # pale border growing in at an edge: the outer 2 px become much brighter than the picture 7-14 % inside, along the whole edge
    steps = _edge_steps(gray.astype(np.float32))
    k = max(2, int(0.5 * fps))
    best = (-1e9, '', None)
    for e in EDGES:
        seg = steps[e]                                  # (n, 8)
        gain = seg[-k:].mean(0) - seg[:k].mean(0)
        f.edge_gain[e] = float(np.median(gain))
        f.edge_cover[e] = float((gain > 30).mean())
        if f.edge_cover[e] >= TH['edge_cover'] and f.edge_gain[e] > best[0]:
            best = (f.edge_gain[e], e, seg.mean(1))
    if best[1]:
        f.ring_lift, f.ring_lift_edge = best[0], best[1]
        series = best[2]
        base_s, gain_s = series[:k].mean(), series[-k:].mean() - series[:k].mean()
        hit = np.flatnonzero(series > base_s + max(15.0, 0.2 * gain_s))   # onset, not the half-way point
        f.ring_lift_at = float(hit[0] / fps) if hit.size else -1.0
    # strict paper band
    ends = [max(_band(x, e) for e in ('left', 'right', 'bottom')) for x in gray[-k:].astype(np.float32)]
    starts = [max(_band(x, e) for e in ('left', 'right', 'bottom')) for x in gray[:k].astype(np.float32)]
    f.paper_band_end = float(np.median(ends))
    f.paper_band_growth = f.paper_band_end - float(np.median(starts))
    # freeze runs
    still = d < 0.0006
    best_run = run = 0
    for v in still:
        run = run + 1 if v else 0
        best_run = max(best_run, run)
    f.freeze_longest_s = best_run / fps
    run = 0
    for v in still[::-1]:
        if not v:
            break
        run += 1
    f.freeze_tail_s = run / fps
    run = 0
    for v in still:
        if not v:
            break
        run += 1
    f.freeze_head_s = run / fps
    f.luma_start, f.luma_end = float(g[:k].mean()), float(g[-k:].mean())
    return f


def analyze_clip(path: str, fps: float | None = None) -> Features:
    fps = fps or probe_fps(path)
    return analyze_frames(_decode(path, GW, GH, fps), fps)


def _small(x: np.ndarray) -> np.ndarray:
    x = x.astype(np.float32)
    h, w = x.shape[0] // 4 * 4, x.shape[1] // 4 * 4
    return x[:h, :w].reshape(h // 4, 4, w // 4, 4).mean((1, 3))


def _ncc(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a - a.mean(), b - b.mean()
    return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9))


def keyframe_match(first_frames: np.ndarray, keyframe_path: str) -> float:
    """Best normalised cross-correlation (36x64 gray) between the keyframe and the clip's first ~0.5 s: ~1 when the clip
    really starts from that picture (all 21 Lentera clips: >= 0.86 after 0.5 s), ~0 when it opens on another scene."""
    from PIL import Image  # only for the optional keyframe check
    with Image.open(keyframe_path) as src:
        im = src.convert('L')
    w, h = im.size
    tw = int(round(h * GW / GH))
    if tw <= w:
        x0 = (w - tw) // 2
        im = im.crop((x0, 0, x0 + tw, h))
    else:
        th = int(round(w * GH / GW))
        y0 = (h - th) // 2
        im = im.crop((0, y0, w, y0 + th))
    k = _small(np.asarray(im.resize((GW, GH), Image.BOX), np.float32))
    return max(_ncc(_small(fr), k) for fr in first_frames)


# --------------------------------------------------------------------------------------------------
# verdict
# --------------------------------------------------------------------------------------------------


@dataclass
class Reason:
    code: str
    severity: str          # 'fail' | 'warn' | 'info'
    penalty: int
    at_s: float
    value: float
    message: str           # Indonesian, shown to the user


@dataclass
class Verdict:
    score: int
    status: str            # ok | warn | fail   (fail < 50, warn 50..74, ok >= 75, like the vision audit)
    reasons: list = field(default_factory=list)
    suggest: dict = field(default_factory=dict)   # free fixes only: trim / zoom (never a paid re-render)
    features: dict = field(default_factory=dict)

    def to_dict(self):
        return asdict(self)


def judge(f: Features, intent: dict | None = None, keyframe_ncc: float | None = None,
          zoom_assembly: float = 1.0) -> Verdict:
    intent = intent or {}
    move = (intent.get('move') or '').strip()
    rs: list[Reason] = []

    def add(code, sev, pen, at, val, msg):
        rs.append(Reason(code, sev, pen, round(float(at), 2), round(float(val), 4), msg))

    if f.n < 6:
        return Verdict(0, 'fail', [Reason('too_short', 'fail', 100, 0, f.n, 'Klip terlalu pendek untuk dianalisis')])
    if f.cut_gray >= TH['cut_gray'] and f.cut_ratio >= TH['cut_ratio']:
        add('hard_cut', 'fail', 50, f.cut_at, f.cut_gray, f'Loncatan/potongan mendadak di detik {f.cut_at:.1f} (satu bingkai berubah {f.cut_gray:.0%})')
    if f.morph_dab >= TH['morph_dab'] and f.morph_strict:
        sev, pen = ('fail', 45) if f.morph_dab >= TH['morph_fail_dab'] else ('warn', 28)
        add('dissolve', sev, pen, f.morph_at, f.morph_dab,
            f'Gambar berganti/melebur sendiri di detik {f.morph_at:.1f} (adegan atau karakter digambar ulang di tengah klip)')
    elif f.morph_dab >= TH['morph_big_dab']:
        add('scene_change', 'warn', 22, f.morph_at, f.morph_dab,
            f'Perubahan besar yang mirip peleburan di detik {f.morph_at:.1f} (cek: adegan berganti atau kamera meloncat?)')
    if f.zoom_step_max >= TH['zoom_step'] and f.zoom_step_spike >= TH['zoom_step_ratio']:
        add('zoom_jump', 'fail', 40, f.zoom_step_at, f.zoom_step_max, f'Skala bingkai meloncat di detik {f.zoom_step_at:.1f}')
    painterly = (intent.get('look_family') or 'painterly') == 'painterly'   # paper margins are the painterly failure; elsewhere info only
    steady = f.zoom_total <= 1.10
    if f.ring_lift >= TH['edge_fail']:
        add('border', 'fail' if painterly else 'info', 40 if painterly else 0, f.ring_lift_at, f.ring_lift,
            f'Pita/border pucat tumbuh di tepi {f.ring_lift_edge} mulai detik {f.ring_lift_at:.1f} (tepi +{f.ring_lift:.0f} lebih terang dari gambar di dalamnya)')
    elif steady and f.ring_lift >= TH['edge_warn']:
        add('border', 'warn' if painterly else 'info', 18 if painterly else 0, f.ring_lift_at, f.ring_lift,
            f'Tepi {f.ring_lift_edge} makin terang (+{f.ring_lift:.0f}) — kemungkinan border kertas muncul')
    elif f.paper_band_growth >= TH['paper_band'] and painterly:
        add('border', 'warn', 18, -1, f.paper_band_growth, f'Pita kertas rata tumbuh {f.paper_band_growth:.1f}% di tepi')
    if move not in PULLBACK_OK and f.zoom_total <= TH['pullback']:
        add('pullback', 'warn', 25, -1, f.zoom_total, f'Kamera menarik mundur {1 / f.zoom_total - 1:.0%} padahal gerak yang diminta "{move or "static"}"')
    elif f.zoom_last2s <= TH['pullback_tail'] and move not in PULLBACK_OK:
        add('pullback_tail', 'warn', 15, f.seconds - 2, f.zoom_last2s, 'Kamera menarik mundur di 2 detik terakhir')
    if move == 'static' and f.zoom_total > 1.10:
        add('moves_when_static', 'info', 8, -1, f.zoom_total, f'Kamera mendekat {f.zoom_total - 1:.0%} padahal diminta statis')
    if move in PUSH and f.zoom_total < 1.05 and f.cam_conf > 0.5:
        add('no_push', 'warn', 12, -1, f.zoom_total, 'Gerak "push-in" diminta tetapi kamera hampir tidak bergerak')
    if move in PUSH and f.zoom_speed_pct_s > TH['speed_pct_s']:
        add('too_fast', 'info', 8, -1, f.zoom_speed_pct_s, f'Dorongan kamera {f.zoom_speed_pct_s:.0f}%/dtk — bukan "perlahan"')
    if f.obj_motion < TH['still_obj'] and f.changed_area < TH['still_area']:
        add('under_animated', 'warn', 15, -1, f.obj_motion, 'Hampir tidak ada gerak (klip seperti gambar diam)')
    if f.freeze_tail_s >= TH['freeze_tail_s']:
        add('freeze_tail', 'warn', 15, f.seconds - f.freeze_tail_s, f.freeze_tail_s, f'Bingkai membeku {f.freeze_tail_s:.1f} dtk di akhir')
    elif f.freeze_longest_s >= TH['freeze_run_s']:
        add('freeze', 'warn', 20, -1, f.freeze_longest_s, f'Bingkai membeku {f.freeze_longest_s:.1f} dtk')
    if f.luma_start > 0.05 and f.luma_end / f.luma_start < TH['fade_dark']:
        add('fade_dark', 'info', 6, f.seconds, f.luma_end / f.luma_start, 'Klip menggelap hampir hitam di akhir (pastikan memang disengaja)')
    if keyframe_ncc is not None:
        if keyframe_ncc < TH['kf_fail']:
            add('keyframe_mismatch', 'fail', 45, 0, keyframe_ncc, f'Klip tidak dimulai dari keyframe-nya (kemiripan {keyframe_ncc:.2f}) — gambar awal salah')
        elif keyframe_ncc < TH['kf_warn']:
            add('keyframe_mismatch', 'warn', 20, 0, keyframe_ncc, f'Bingkai awal klip agak berbeda dari keyframe (kemiripan {keyframe_ncc:.2f})')
    penalty = sum(r.penalty for r in rs)
    score = max(0, 100 - penalty)
    status = 'fail' if any(r.severity == 'fail' for r in rs) or score < 50 else ('warn' if score < 75 or any(r.severity == 'warn' for r in rs) else 'ok')
    return Verdict(score, status, rs, _suggest(f, rs, zoom_assembly), {k: v for k, v in f.to_dict().items() if k != 'zoom_curve'})


def _suggest(f: Features, rs: list, zoom_assembly: float = 1.0) -> dict:
    """Free repairs the assembler already supports (shot.trim / shot.zoom).  Never a paid re-render.
    The EARLIEST defect decides trim.out (keep >= 3 s, 0.6 s margin: the detector only sees a border once it is ~1 % wide);
    a scene swap early in the clip may instead be skipped with trim.in; a border with no clean 3 s gets a crop (zoom)."""
    min_keep, margin = 3.0, 0.6
    codes = {r.code: r for r in rs}
    outs = [codes[c].at_s - margin for c in ('border', 'pullback_tail', 'freeze_tail', 'dissolve', 'scene_change', 'zoom_jump', 'hard_cut')
            if c in codes and codes[c].at_s > 0]
    out: dict = {}
    if outs and min(outs) >= min_keep:
        out['trim'] = {'out': round(min(outs), 2)}
    else:
        for c in ('dissolve', 'scene_change', 'hard_cut'):
            r = codes.get(c)
            if r and r.at_s > 0 and f.seconds - (r.at_s + 0.5) >= min_keep and 'border' not in codes:
                out['trim'] = {'in': round(r.at_s + 0.5, 2)}
                break
    if 'border' in codes and 'trim' not in out and f.ring_lift > 20 and zoom_assembly < SUGGEST_ZOOM:
        out['zoom'] = SUGGEST_ZOOM   # crop the band off (shot.zoom 1.0-1.4, hashes unchanged); not when the shot is already cropped that much
    return out


def check_clip(path: str, intent: dict | None = None, keyframe: str | None = None, zoom_assembly: float = 1.0) -> Verdict:
    fps = probe_fps(path)
    gray = _decode(path, GW, GH, fps)
    f = analyze_frames(gray, fps)
    kn = None
    if keyframe:
        try:
            kn = keyframe_match(gray[:max(1, int(0.5 * fps)):3], keyframe)
        except Exception:      # unreadable keyframe: the check is skipped, the clip is still judged on its own
            kn = None
    return judge(f, intent, kn, zoom_assembly)


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json
    ap = argparse.ArgumentParser(description='Deterministic clip QC (no credits, numpy + ffmpeg)')
    ap.add_argument('clip')
    ap.add_argument('--move', default='', help='camera move id of the shot (static, push-in, ...)')
    ap.add_argument('--look', default='painterly', help='look family (painterly, film-real, ...); border is a failure only for painterly')
    ap.add_argument('--keyframe', help='the still the clip was animated from (konsisten)')
    ap.add_argument('--zoom', type=float, default=1.0, help='shot.zoom applied at assembly')
    a = ap.parse_args(argv)
    try:
        v = check_clip(a.clip, {'move': a.move, 'look_family': a.look}, a.keyframe, a.zoom)
    except ClipError as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False))
        return 2
    print(json.dumps(v.to_dict(), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
