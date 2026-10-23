#!/usr/bin/env python3
"""Animated storybook title card (Luca-poster style): hand-lettered bouncy letters,
chalky edges, soft shadow, a red knitted-ribbon swash, kicker line above.

render_frame(t) -> RGBA PIL image (W x H) for time t seconds; write_sequence() dumps PNGs.
"""
import math
import os
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

W, H = 720, 1280
HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, 'fonts', 'Chewy-Regular.ttf')
KICKER_FONT = os.path.join(HERE, 'fonts', 'LilitaOne-Regular.ttf')
RED = (214, 38, 46)
RED_LIGHT = (240, 92, 86)
RED_DARK = (140, 18, 28)


def ease_out_back(x):
    x = min(max(x, 0.0), 1.0)
    c1, c3 = 1.70158, 2.70158
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2


def ease_out(x):
    x = min(max(x, 0.0), 1.0)
    return 1 - (1 - x) ** 3


def clamp01(x):
    return min(max(x, 0.0), 1.0)


def _chalk(mask, seed):
    """Rough up glyph edges like brush/chalk lettering."""
    rnd = random.Random(seed)
    noise = Image.effect_noise(mask.size, 90).filter(ImageFilter.GaussianBlur(0.8))
    edge = mask.filter(ImageFilter.GaussianBlur(1.6))
    # pixels near the edge (partially covered after blur) get eaten by noise
    rough = ImageChops.multiply(edge, noise.point(lambda v: 255 if v > 70 + rnd.randint(-5, 5) else 0))
    inner = mask.filter(ImageFilter.MinFilter(5))
    return ImageChops.lighter(rough.point(lambda v: 255 if v > 110 else 0), inner)


def _letter(ch, font, seed):
    box = font.getbbox(ch)
    w, h = box[2] - box[0] + 24, box[3] - box[1] + 24
    m = Image.new('L', (w, h), 0)
    ImageDraw.Draw(m).text((12 - box[0], 12 - box[1]), ch, font=font, fill=255)
    m = _chalk(m, seed)
    return m, box


class TitleCard:
    def __init__(self, lines, kicker=None, font=FONT, sizes=(128, 176), top=150, seed=7):
        self.kicker = kicker
        self.lines = []
        rnd = random.Random(seed)
        y = top + (70 if kicker else 0)
        for li, (text, size) in enumerate(zip(lines, sizes)):
            f = ImageFont.truetype(font, size)
            glyphs, x = [], 0
            for ci, ch in enumerate(text):
                if ch == ' ':
                    x += size * 0.32
                    continue
                m, box = _letter(ch, f, seed * 100 + li * 20 + ci)
                adv = f.getlength(ch) * 0.96
                glyphs.append({'mask': m, 'x': x, 'adv': adv, 'rot': rnd.uniform(-5, 5),
                               'dy': rnd.uniform(-size * 0.05, size * 0.05), 'h': m.size[1]})
                x += adv
            total = x
            ox = (W - total) / 2
            for g in glyphs:
                g['x'] += ox
            self.lines.append({'glyphs': glyphs, 'y': y, 'size': size, 'width': total})
            y += size * 0.98
        self.bottom = y
        self.kfont = ImageFont.truetype(KICKER_FONT, 30) if kicker else None

    # timeline (seconds)
    KICK_IN, POP_START, POP_STAGGER, POP_DUR = 0.4, 0.8, 0.07, 0.55
    RIBBON_START, RIBBON_DUR = 1.9, 0.9
    OUT_START, OUT_DUR = 4.7, 0.8

    def _ribbon(self, progress):
        """Flowing knitted red scarf swash under the last line, revealed left->right."""
        last = self.lines[-1]
        x0, x1 = (W - last['width']) / 2 - 40, (W + last['width']) / 2 + 40
        ybase = last['y'] + last['size'] * 1.04
        n = 160
        centre, half = [], []
        for i in range(n + 1):
            u = i / n
            x = x0 + (x1 - x0) * u
            y = ybase + math.sin(u * math.pi * 2.0 + 0.4) * 20 - u * 14
            centre.append((x, y))
            half.append(5 + 15 * math.sin(math.pi * min(max(u, 0.0), 1.0)) ** 0.6 + 3 * math.sin(u * 30))
        upto = max(2, int(n * clamp01(progress)) + 1)
        img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        top, bot = [], []
        for i in range(upto):
            (xa, ya) = centre[max(0, i - 1)]
            (xb, yb) = centre[min(n, i + 1)]
            dx, dy = xb - xa, yb - ya
            L = math.hypot(dx, dy) or 1
            nx, ny = -dy / L, dx / L
            cx, cy = centre[i]
            top.append((cx + nx * half[i], cy + ny * half[i]))
            bot.append((cx - nx * half[i], cy - ny * half[i]))
        d.polygon(top + bot[::-1], fill=RED)
        # knit texture: rows of small V stitches along the scarf
        for i in range(2, upto - 2, 3):
            cx, cy = centre[i]
            hh = half[i]
            for row in (-0.5, 0.0, 0.5):
                yy = cy + row * hh
                d.line([(cx - 3, yy - 3), (cx, yy + 2), (cx + 3, yy - 3)], fill=RED_LIGHT if row <= 0 else RED_DARK, width=2)
        # tassels at the tail
        if progress >= 1:
            ex, ey = centre[-1]
            for k in range(6):
                d.line([(ex - 2, ey - 8 + k * 3), (ex + 22 + k * 1.5, ey - 4 + k * 5)], fill=RED, width=4)
        return img

    def render_frame(self, t):
        out_a = 1 - clamp01((t - self.OUT_START) / self.OUT_DUR)
        drift = 1 + 0.025 * clamp01(t / (self.OUT_START + self.OUT_DUR))
        text = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        order = 0
        for line in self.lines:
            for g in line['glyphs']:
                p = (t - self.POP_START - order * self.POP_STAGGER) / self.POP_DUR
                order += 1
                if p <= 0:
                    continue
                s = max(0.01, ease_out_back(p))
                a = clamp01(p * 2.5)
                m = g['mask']
                mw, mh = m.size
                sm = m.resize((max(1, int(mw * s)), max(1, int(mh * s))), Image.BICUBIC).rotate(g['rot'], resample=Image.BICUBIC, expand=True)
                cx = g['x'] + g['adv'] / 2
                cy = line['y'] + g['h'] / 2 + g['dy'] - 20 * (1 - ease_out(p))
                fill = Image.new('RGBA', sm.size, (255, 251, 240, 255))
                fill.putalpha(sm.point(lambda v, a=a: int(v * a)))
                text.alpha_composite(fill, (int(cx - sm.size[0] / 2), int(cy - sm.size[1] / 2)))
        if t >= self.RIBBON_START:
            ribbon = self._ribbon((t - self.RIBBON_START) / self.RIBBON_DUR)
            text = Image.alpha_composite(ribbon, text)
        if self.kicker:
            ka = clamp01((t - self.KICK_IN) / 0.6)
            if ka > 0:
                kd = ImageDraw.Draw(text)
                spaced = '  '.join(self.kicker.upper())
                tw = kd.textlength(spaced, font=self.kfont)
                kd.text(((W - tw) / 2, self.lines[0]['y'] - 64), spaced, font=self.kfont, fill=(255, 245, 225, int(235 * ka)))
        # warm radial glow behind the title (fades with the letters)
        glow_a = clamp01((t - self.POP_START) / 1.2) * 0.28
        if glow_a > 0:
            glow = Image.new('L', (W, H), 0)
            gy = (self.lines[0]['y'] + self.bottom) / 2
            ImageDraw.Draw(glow).ellipse((W * 0.1, gy - 170, W * 0.9, gy + 170), fill=int(255 * glow_a))  # subtle: must not haze the scene
            glow = glow.filter(ImageFilter.GaussianBlur(70))
            gl = Image.new('RGBA', (W, H), (255, 214, 150, 0))
            gl.putalpha(glow)
            text = Image.alpha_composite(gl, text)
        # soft shadow + thin warm outline for readability on any background
        alpha = text.getchannel('A')
        shadow = Image.new('RGBA', (W, H), (40, 20, 10, 0))
        shadow.putalpha(alpha.filter(ImageFilter.GaussianBlur(10)).point(lambda v: int(v * 0.75)))
        outline = Image.new('RGBA', (W, H), (70, 35, 20, 0))
        outline.putalpha(alpha.filter(ImageFilter.MaxFilter(5)).point(lambda v: int(v * 0.85)))
        frame = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        frame.alpha_composite(shadow, (0, 8))
        frame.alpha_composite(outline)
        frame.alpha_composite(text)
        if drift != 1:
            fw, fh = int(W * drift), int(H * drift)
            frame = frame.resize((fw, fh), Image.BICUBIC).crop(((fw - W) // 2, (fh - H) // 2, (fw - W) // 2 + W, (fh - H) // 2 + H))
        if out_a < 1:
            frame.putalpha(frame.getchannel('A').point(lambda v: int(v * out_a)))
        return frame

    @property
    def duration(self):
        return self.OUT_START + self.OUT_DUR

    def write_sequence(self, out_dir, fps=24):
        os.makedirs(out_dir, exist_ok=True)
        n = int(math.ceil(self.duration * fps))
        for i in range(n):
            self.render_frame(i / fps).save(os.path.join(out_dir, f'{i:04d}.png'))
        return n
