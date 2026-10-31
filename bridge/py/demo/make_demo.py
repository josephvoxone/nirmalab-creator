#!/usr/bin/env python3
"""Build a demo film with no source footage: three procedural scenes painted with Pillow,
a music bed and a word-timed dub, rendered by the story assembler next to this file.

    python3 bridge/py/demo/make_demo.py   # clip files + bridge/py/demo/out/demo.mp4

The scenes are painted with Pillow (gradient sky, layered hills, a low sun and, in the last
shot, warm windows switching on), so nothing is downloaded and no source footage is needed.
The "voice" is a tone: what the demo shows is the caption lighting one word at a time from
per-word timings, which is what a real dub file feeds in.
"""
import json
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
ROOT = os.path.dirname(HERE)   # bridge/py, where assemble.py lives
W, H, FPS, SECONDS = 720, 1280, 24, 4.0

SHOTS = [
    {'id': 's0', 'scene': 'dawn', 'narration': 'The boat left before dawn'},
    {'id': 's1', 'scene': 'river', 'narration': 'The river was quiet'},
    {'id': 's2', 'scene': 'lights', 'narration': 'And then the lights came on'},
]
WORDS = [['The', 0.10, 0.34], ['river', 0.40, 0.78], ['was', 0.86, 1.06], ['quiet', 1.12, 1.62]]

SKY = {
    'dawn':   ((18, 26, 54), (244, 160, 116), (255, 214, 160)),
    'river':  ((32, 14, 44), (214, 104, 84), (255, 176, 128)),
    'lights': ((4, 6, 18), (22, 40, 74), (150, 190, 220)),
}


def gradient(top, bottom, height=H):
    img = Image.new('RGB', (1, height))
    for y in range(height):
        t = (y / (height - 1)) ** 0.85
        img.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img.resize((W, height))


def glow(radius, colour, alpha=190):
    size = radius * 2
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for r in range(radius, 0, -2):
        a = int(alpha * (1 - r / radius) ** 2.2)
        d.ellipse((radius - r, radius - r, radius + r, radius + r), fill=colour + (a,))
    return img.filter(ImageFilter.GaussianBlur(radius * 0.06))


def ridge(seed, base_y, amp, speed, t, colour, roughness=2):
    pts = []
    for x in range(0, W + 8, 8):
        u = (x + speed * t) / W
        y = (base_y
             + math.sin(u * math.pi * (1.1 + roughness * 0.4) + seed) * amp
             + math.sin(u * math.pi * 3.3 + seed * 2.1) * amp * 0.34)
        pts.append((x, y))
    return pts


def paint(scene, t):
    top, bottom, accent = SKY[scene]
    img = gradient(top, bottom).convert('RGBA')
    d = ImageDraw.Draw(img)

    if scene == 'lights':
        moon = glow(210, accent, 120)
        img.alpha_composite(moon, (int(W * 0.58 - 210), int(H * 0.20 - 210)))
        d.ellipse((W * 0.58 - 34, H * 0.20 - 34, W * 0.58 + 34, H * 0.20 + 34), fill=accent + (235,))
    else:
        cx = W * (0.30 if scene == 'dawn' else 0.66)
        cy = H * (0.52 if scene == 'dawn' else 0.46)
        img.alpha_composite(glow(340, accent, 150), (int(cx - 340), int(cy - 340)))
        d.ellipse((cx - 62, cy - 62, cx + 62, cy + 62), fill=accent + (240,))

    if scene == 'river':
        for i in range(58):
            y = H * 0.58 + i * 7.4
            wob = math.sin(t * 1.6 + i * 0.7) * 16
            span = (W * 0.5) * (1 - i / 70)
            d.line([(W * 0.5 - span + wob, y), (W * 0.5 + span + wob, y)],
                   fill=accent + (max(0, int(90 - i * 1.4)),), width=3)

    layers = [
        (0.60, 46, 6, (26, 22, 40, 255)),
        (0.70, 34, 11, (16, 14, 30, 255)),
        (0.82, 26, 17, (8, 8, 18, 255)),
    ]
    for i, (base, amp, speed, colour) in enumerate(layers):
        pts = ridge(i * 1.7 + (0.5 if scene == 'river' else 0), H * base, amp, speed, t, colour)
        d.polygon(pts + [(W, H), (0, H)], fill=colour)

    if scene == 'lights' and t > 1.6:
        reveal = min(1.0, (t - 1.6) / 1.4)
        spots = [(0.14, 0.655), (0.23, 0.668), (0.36, 0.648), (0.44, 0.672),
                 (0.58, 0.652), (0.66, 0.665), (0.78, 0.645), (0.86, 0.66)]
        for k, (fx, fy) in enumerate(spots):
            if k / len(spots) > reveal:
                break
            x, y = W * fx, H * (fy + math.sin(t * 2 + k) * 0.002)
            img.alpha_composite(glow(26, (255, 214, 150), 210), (int(x - 26), int(y - 26)))
            d.rectangle((x - 5, y - 4, x + 5, y + 5), fill=(255, 236, 190, 245))

    d.rectangle((0, 0, W, H), outline=(0, 0, 0, 0))
    return img.convert('RGB')


def build_clip(shot, index):
    path = os.path.join(OUT, shot['id'] + '.mp4')
    enc = subprocess.Popen(
        ['ffmpeg', '-y', '-v', 'error',
         '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (W, H), '-r', str(FPS), '-i', '-',
         '-f', 'lavfi', '-i', 'sine=frequency=%d:duration=%.2f' % (300 + index * 110, SECONDS),
         '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
         '-c:a', 'aac', '-shortest', path],
        stdin=subprocess.PIPE)
    frames = int(SECONDS * FPS)
    for i in range(frames):
        enc.stdin.write(paint(shot['scene'], i / FPS).tobytes())
    enc.stdin.close()
    if enc.wait() != 0:
        sys.exit('ffmpeg failed building %s' % shot['id'])
    return path


def build_bed(seconds, path):
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi',
                    '-i', 'sine=frequency=180:duration=%.2f' % seconds,
                    '-af', 'volume=0.5', '-c:a', 'aac', path], check=True)
    return path


def build_dub(path):
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi',
                    '-i', 'sine=frequency=420:duration=1.8',
                    '-af', 'volume=0.9', '-c:a', 'aac', path], check=True)
    return path


def main():
    os.makedirs(OUT, exist_ok=True)
    for i, shot in enumerate(SHOTS):
        build_clip(shot, i)
    build_bed(12, os.path.join(OUT, 'bed.m4a'))
    build_dub(os.path.join(OUT, 's1-dub.m4a'))

    plan = {
        'slug': 'demo',
        'crossfade': 0.3,
        'titleCard': {'lines': ['SHOTWEAVE'], 'kicker': 'demo reel'},
        'shots': [
            {'id': 's0', 'narration': SHOTS[0]['narration'], 'transition': 'fade'},
            {'id': 's1', 'narration': SHOTS[1]['narration'], 'transition': 'wipeleft',
             'dub': {'file': os.path.join(OUT, 's1-dub.m4a'), 'words': WORDS}},
            {'id': 's2', 'narration': SHOTS[2]['narration'], 'transition': 'fade',
             'trim': {'in': 0.2}},
        ],
        'edit': {'subtitles': True, 'music': {'path': os.path.join(OUT, 'bed.m4a'), 'from': 0}},
    }
    plan_path = os.path.join(OUT, 'assemble.json')
    with open(plan_path, 'w') as fh:
        json.dump(plan, fh, indent=2)

    print('plan: %s' % plan_path)
    done = subprocess.run([sys.executable, os.path.join(ROOT, 'assemble.py'), OUT])
    sys.exit(done.returncode)


if __name__ == '__main__':
    main()
