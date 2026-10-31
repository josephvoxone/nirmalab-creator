"""E1: the closing fade starts after the closing line is spoken, so the last word (the payoff) keeps its level.

Audit 01 measured "terhilang." at -25.1 dBFS, 8 dB below the words before it: `afade` ran 1.2 s up to the end of the
timeline while the closing dub was still being spoken inside that window.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import assemble
from assemble import closing_fade, filter_graph
from test_assemble_dub import tone

AFADE = re.compile(r'afade=t=out:st=([0-9.]+):d=([0-9.]+)')
VFADE = re.compile(r'(?<!a)fade=t=out:st=([0-9.]+):d=([0-9.]+)')


def graphs_of(plan, dub_seconds, clip=6.0):
    """(video graph, audio graph, -t of the video pass) main() builds for `plan`, with the files faked."""
    d = tempfile.mkdtemp(prefix='closing-')
    try:
        for i in range(len(plan['shots'])):
            open(os.path.join(d, f's{i}.mp4'), 'wb').write(b'x')
        open(os.path.join(d, 'v.mp3'), 'wb').write(b'x')
        for s in plan['shots']:
            if s.get('dub'):
                s['dub']['file'] = os.path.join(d, 'v.mp3')
        json.dump(plan, open(os.path.join(d, 'assemble.json'), 'w'))
        calls = []
        with mock.patch.object(assemble, 'probe_duration', lambda p: dub_seconds if p.endswith('.mp3') else clip), \
             mock.patch.object(assemble, 'run_ffmpeg', lambda cmd, label: calls.append(cmd)), mock.patch('sys.stdout'):
            assemble.main(d)
        g = [c[c.index('-filter_complex') + 1] for c in calls if '-filter_complex' in c]
        return g[0], g[1], float(calls[0][len(calls[0]) - 1 - calls[0][::-1].index('-t') + 1])
    finally:
        shutil.rmtree(d, ignore_errors=True)


def two_shots(dub_seconds):
    return {'slug': 'final', 'crossfade': 0.3, 'shots': [{'id': 's0'}, {'id': 's1', 'narration': 'x', 'dub': {'seconds': dub_seconds}}], 'edit': {}}


class Where(unittest.TestCase):
    def test_a_closing_dub_that_fits_is_not_faded_while_it_speaks(self):
        # shot 2 starts at 5.7 s, its voice at 6.0 s and a 5.0 s dub ends at 11.0 s
        v, a, total = graphs_of(two_shots(5.0), 5.0)
        for pat in (AFADE, VFADE):
            st, d = map(float, pat.search(a if pat is AFADE else v).groups())
            self.assertGreaterEqual(st, 11.0 + 0.15 - 1e-6, f'the fade starts at {st}s, inside the last word')
            self.assertGreaterEqual(d, 0.5)
            self.assertLessEqual(total, 11.7 + 1.5)
            self.assertGreaterEqual(total, st + d - 1e-3, 'the fade must finish inside the video')

    def test_a_closing_dub_that_needs_the_hold_is_not_faded_while_it_speaks(self):
        # 8.0 s dub in a 5.5 s window: hold 1.25 s, tempo 1.185, voice ends at 12.75 s
        v, a, total = graphs_of(two_shots(8.0), 8.0)
        st, d = map(float, AFADE.search(a).groups())
        self.assertGreaterEqual(st, 12.75 + 0.15 - 1e-6)
        self.assertGreaterEqual(total, st + d - 1e-3)
        self.assertLessEqual(total, 12.95 + 1.5)

    def test_audio_and_video_fade_start_together(self):
        v, a, _ = graphs_of(two_shots(5.0), 5.0)
        self.assertEqual(AFADE.search(a).groups(), VFADE.search(v).groups())

    def test_a_dub_that_ended_long_before_the_end_keeps_the_old_fade(self):
        # 2 s dub in a 6 s clip: voice over at 8.0 s, the last 1.2 s of the 11.7 s video fade as before
        v, a, total = graphs_of(two_shots(2.0), 2.0)
        self.assertEqual(AFADE.search(a).groups(), ('10.5', '1.2'))
        self.assertEqual(total, 11.7)

    def test_no_dub_on_the_last_shot_keeps_the_old_fade(self):
        plan = {'slug': 'final', 'crossfade': 0.3, 'shots': [{'id': 's0'}, {'id': 's1'}], 'edit': {}}
        v, a, total = graphs_of(plan, 0)
        self.assertEqual(AFADE.search(a).groups(), ('10.5', '1.2'))
        self.assertEqual(VFADE.search(v).groups(), ('10.5', '1.2'))


class Helper(unittest.TestCase):
    def test_nothing_changes_without_a_closing_voice(self):
        self.assertEqual(closing_fade(11.7, None), (10.5, 1.2, 0.0))

    def test_the_fade_waits_for_the_voice_and_the_timeline_grows_just_enough(self):
        st, d, extra = closing_fade(11.7, 11.0)
        self.assertAlmostEqual(st, 11.15, places=3)
        self.assertAlmostEqual(d, 0.6, places=3)
        self.assertAlmostEqual(extra, 0.05, places=3)

    def test_a_short_tail_is_never_longer_than_needed(self):
        st, d, extra = closing_fade(20.0, 11.0)
        self.assertEqual((st, d, extra), (18.8, 1.2, 0.0))


class Measured(unittest.TestCase):
    """Real ffmpeg: a 880 Hz 'voice' as the closing dub; the last 300 ms of speech must be within 3 dB of the speech average."""

    def samples(self, path):
        import numpy as np
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], capture_output=True).stdout
        return np.frombuffer(raw, dtype=np.int16).astype(float) / 32768

    def speech_span(self, x):
        """(start, end) in seconds of the voice: the first and last 20 ms hop within 20 dB of the typical speech level."""
        import numpy as np
        hop = 320
        r = np.array([np.sqrt(np.mean(x[i:i + hop] ** 2)) for i in range(0, len(x) - hop, hop)])
        loud = np.where(r > 0.1 * np.median(r[r > 0.01]))[0]
        return loud[0] * hop / 16000, (loud[-1] + 1) * hop / 16000

    def build(self, dub_seconds):
        d = tempfile.mkdtemp(prefix='closing-e2e-')
        tone(os.path.join(d, 's0.mp4'), 330, 4, video=True)   # one shot: a clip's own audio is a little shorter than its picture, which would shift a second shot
        tone(os.path.join(d, 'voice.mp3'), 880, dub_seconds)
        json.dump({'slug': 'final', 'crossfade': 0.3, 'shots': [
            {'id': 's0', 'narration': 'x', 'dub': {'file': os.path.join(d, 'voice.mp3'), 'seconds': dub_seconds}}], 'edit': {}},
            open(os.path.join(d, 'assemble.json'), 'w'))
        out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assemble.py'), d], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        return d, os.path.join(d, 'final.mp4')

    def check(self, dub_seconds):
        import math
        d, final = self.build(dub_seconds)
        try:
            x = self.samples(final)
            start, end = self.speech_span(x)
            rms = lambda a, b: float(__import__('numpy').sqrt(__import__('numpy').mean(x[int(a * 16000):int(b * 16000)] ** 2)))
            db = 20 * math.log10(rms(end - 0.3, end) / rms(start, end))
            self.assertGreaterEqual(db, -3.0, f'the last 300 ms of the closing line ({end:.2f}s) is {db:.1f} dB below the speech average')
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_a_fitting_closing_line_keeps_its_last_word(self):
        self.check(3.45)

    def test_a_held_closing_line_keeps_its_last_word(self):
        self.check(6.5)


if __name__ == '__main__':
    unittest.main()
