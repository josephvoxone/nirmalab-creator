"""Synthetic clips that imitate each defect found in the Lentera audit.  numpy + ffmpeg only; deterministic (seeded).

    clip = Fixture(...).write(path)      # 6 s, 24 fps, H.264 yuv420p crf 20, default 360x640
Each builder returns a list of float32 RGB frames (0-255) through `render()`; `encode()` pipes them to ffmpeg.
The scene is a procedural 'painting' (multi-octave value noise + soft blobs) so the camera model has texture to lock on,
and a 'character' (yellow body, dark hair cap) that walks independently of the camera.
"""
from __future__ import annotations

import os
import shutil
import subprocess

import numpy as np
from PIL import Image

FPS = 24
PAPER = np.array([241, 236, 222], np.float32)


def ffmpeg() -> str:
    return os.environ.get('QC_FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg'


def painting(seed: int, w: int = 720, h: int = 1280, dark: bool = False) -> np.ndarray:
    """A textured RGB canvas (float32) twice the frame size, so the camera can zoom in/out without running out of picture."""
    rng = np.random.default_rng(seed)
    H, W = h * 2, w * 2
    img = np.zeros((H, W, 3), np.float32)
    for octave, amp in ((6, 1.0), (14, 0.7), (34, 0.5), (80, 0.35), (160, 0.2)):
        small = rng.random((octave * 2, int(octave * W / H) + 2, 3)).astype(np.float32)
        big = np.asarray(Image.fromarray((small * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC), np.float32) / 255.0
        img += (big - 0.5) * amp
    img = img / img.std() * 38 + (62 if dark else 120)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    for _ in range(14):                                    # soft blobs: gouache patches
        cx, cy, r = rng.uniform(0, W), rng.uniform(0, H), rng.uniform(80, 260)
        col = rng.uniform(30, 220, 3).astype(np.float32)
        m = np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r)))[..., None]
        img = img * (1 - 0.6 * m) + col * 0.6 * m
    return np.clip(img, 0, 255)


def crop_scale(canvas: np.ndarray, zoom: float, cx: float = 0.5, cy: float = 0.5, w: int = 360, h: int = 640) -> np.ndarray:
    """Camera: the window of canvas that is canvas/2 / zoom wide, centred at (cx, cy) of the canvas, scaled to w x h."""
    H, W = canvas.shape[:2]
    cw, ch = W / 2 / zoom, H / 2 / zoom
    x0, y0 = W * cx - cw / 2, H * cy - ch / 2
    im = Image.fromarray(canvas.astype(np.uint8)).resize((w, h), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch))
    return np.asarray(im, np.float32)


def character(frame: np.ndarray, t: float, hair=(25, 22, 28), x_amp: float = 0.22, scale: float = 1.4, still: bool = False) -> np.ndarray:
    """Draw a small walking figure (yellow coat, dark hair, navy boots) on top of the frame, independent of the camera."""
    h, w = frame.shape[:2]
    tt = 0.0 if still else t
    cx = w * (0.5 + x_amp * np.sin(tt * 2.6))
    cy = h * (0.62 + 0.012 * np.sin(tt * 6.0))
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    s = scale * w / 360.0
    body = ((xx - cx) / (30 * s)) ** 2 + ((yy - cy) / (52 * s)) ** 2 <= 1
    head = ((xx - cx) / (24 * s)) ** 2 + ((yy - (cy - 66 * s)) / (24 * s)) ** 2 <= 1
    cap = head & (yy < cy - 70 * s)
    boots = (abs(xx - cx) < 24 * s) & (yy > cy + 44 * s) & (yy < cy + 60 * s)
    out = frame.copy()
    out[body] = (235, 180, 40)
    out[head] = (240, 205, 170)
    out[cap] = hair
    out[boots] = (20, 30, 90)
    return out


def paper_border(frame: np.ndarray, inset: float) -> np.ndarray:
    """Shrink the picture by `inset` (share of each side) and fill the margin with flat paper: what a pull-back to the page edge looks like."""
    if inset <= 0.001:
        return frame
    h, w = frame.shape[:2]
    iw, ih = int(w * (1 - 2 * inset)), int(h * (1 - 2 * inset))
    out = np.empty_like(frame)
    out[:] = PAPER
    im = Image.fromarray(frame.astype(np.uint8)).resize((iw, ih), Image.BILINEAR)
    x0, y0 = (w - iw) // 2, (h - ih) // 2
    out[y0:y0 + ih, x0:x0 + iw] = np.asarray(im, np.float32)
    return out


def encode(frames, path: str, fps: int = FPS, crf: int = 20) -> str:
    h, w = frames[0].shape[:2]
    p = subprocess.Popen([ffmpeg(), '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', str(fps), '-i', '-',
                          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', str(crf), '-preset', 'veryfast', path], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(np.clip(f, 0, 255).astype(np.uint8).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError('ffmpeg encode failed')
    return path


def render(n: int, cam, canvas_a, canvas_b=None, mix=None, border=None, hair=None, still_from=None, w=360, h=640):
    """cam(t) -> (zoom, cx, cy); mix(t) -> 0..1 weight of canvas_b (dissolve/cut); border(t) -> inset share; hair(t) -> rgb;
    still_from: freeze every frame after this time on the frame at that time."""
    frames, frozen = [], None
    for i in range(n):
        t = i / FPS
        if still_from is not None and t >= still_from and frozen is not None:
            frames.append(frozen)
            continue
        z, cx, cy = cam(t)
        a = crop_scale(canvas_a, z, cx, cy, w, h)
        if canvas_b is not None and mix is not None and mix(t) > 0:
            b = crop_scale(canvas_b, z, cx, cy, w, h)
            m = mix(t)
            a = a * (1 - m) + b * m
        fr = character(a, t, hair=hair(t) if hair else (25, 22, 28))
        if border:
            fr = paper_border(fr, border(t))
        if still_from is not None and t >= still_from - 1e-9 and frozen is None:
            frozen = fr
        frames.append(fr)
    return frames


# ---- the named fixtures ------------------------------------------------------------------------------------------------

def push_in(path, z1=1.10, seconds=6.0, seed=1):
    a = painting(seed)
    return encode(render(int(seconds * FPS), lambda t: (1 + (z1 - 1) * t / seconds, .5, .5), a), path)


def zoom_out(path, z1=0.80, seconds=6.0, seed=2):
    a = painting(seed)
    return encode(render(int(seconds * FPS), lambda t: (1.25 + (z1 * 1.25 - 1.25) * t / seconds, .5, .5), a), path)


def border_growth(path, onset=3.0, inset=0.06, seconds=6.0, seed=3):
    a = painting(seed, dark=True)
    return encode(render(int(seconds * FPS), lambda t: (1.0, .5, .5), a,
                         border=lambda t: 0.0 if t < onset else inset * min(1.0, (t - onset) / 1.5)), path)


def freeze_tail(path, freeze_from=2.0, seconds=6.0, seed=4):
    a = painting(seed)
    return encode(render(int(seconds * FPS), lambda t: (1 + 0.05 * t, .5, .5), a, still_from=freeze_from), path)


def hard_cut(path, at=2.5, seconds=6.0, seed=5):
    a, b = painting(seed), painting(seed + 100)
    return encode(render(int(seconds * FPS), lambda t: (1.0, .5, .5), a, b, mix=lambda t: 1.0 if t >= at else 0.0), path)


def dissolve(path, at=2.5, length=0.8, seconds=6.0, seed=6):
    a, b = painting(seed), painting(seed + 100)
    return encode(render(int(seconds * FPS), lambda t: (1.0, .5, .5), a, b,
                         mix=lambda t: 0.0 if t < at else min(1.0, (t - at) / length)), path)


def zoom_jump(path, at=3.0, jump=1.18, seconds=6.0, seed=7):
    a = painting(seed)
    return encode(render(int(seconds * FPS), lambda t: (1.0 if t < at else jump, .5, .5), a), path)


def lively_static(path, seconds=6.0, seed=8):
    """Locked camera, a character crossing the frame the whole time: motion must come out as ok, not as a defect."""
    a = painting(seed)
    return encode(render(int(seconds * FPS), lambda t: (1.0, .5, .5), a), path)


def frozen_still(path, seconds=6.0, seed=9):
    a = painting(seed)
    fr = character(crop_scale(a, 1.0), 0.0, still=True)
    return encode([fr] * int(seconds * FPS), path)


def hood_pop(path, at=2.0, seconds=6.0, seed=10):
    """Small redraw: the hair cap turns yellow ('hood up') in one frame while everything else moves on."""
    a = painting(seed)
    return encode(render(int(seconds * FPS), lambda t: (1.0, .5, .5), a, hair=lambda t: (25, 22, 28) if t < at else (235, 180, 40)), path)


def keyframe_png(path, seed=1, same=True):
    """The still the clip 'started from': frame 0 of push_in(seed) when same, else a different painting."""
    a = painting(seed if same else seed + 77)
    im = character(crop_scale(a, 1.0), 0.0)
    Image.fromarray(np.clip(im, 0, 255).astype(np.uint8)).save(path)
    return path
