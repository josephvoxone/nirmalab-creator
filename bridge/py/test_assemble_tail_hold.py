"""The closing line is never cut: when its dub cannot fit even at the fastest tempo, the last frame is held."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from assemble import tail_hold
from test_assemble_dub import tone, spectrum, level


class Hold(unittest.TestCase):
    def test_a_dub_that_fits_needs_no_hold(self):
        self.assertEqual(tail_hold(5.0, 5.5), 0.0)
        self.assertEqual(tail_hold(6.8, 5.5), 0.0)       # 6.8 / 1.25 = 5.44 fits

    def test_the_hold_is_what_the_fastest_tempo_still_lacks_plus_a_breath(self):
        # 7.654 s at 1.25x = 6.12 s in a 5.54 s window: 0.58 s short, plus 0.35 s of quiet at the end
        self.assertAlmostEqual(tail_hold(7.654, 5.54), 0.93, places=2)

    def test_nonsense_input_does_not_crash(self):
        self.assertEqual(tail_hold(0, 5.0), 0.0)
        self.assertEqual(tail_hold(5.0, 0), 0.0)


class EndToEnd(unittest.TestCase):
    def build(self, d, dub_seconds, shots=1):
        for k in range(shots):
            tone(os.path.join(d, f's{k}.mp4'), 330, 4, video=True)
        tone(os.path.join(d, 'voice.mp3'), 880, dub_seconds)
        dub = {'file': os.path.join(d, 'voice.mp3'), 'seconds': dub_seconds}
        json.dump({'slug': 'final', 'crossfade': 0.3,
                   'shots': [{'id': f's{k}', 'narration': 'x', **({'dub': dub} if k == shots - 1 else {})} for k in range(shots)],
                   'edit': {}}, open(os.path.join(d, 'assemble.json'), 'w'))
        out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assemble.py'), d], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        return os.path.join(d, 'final.mp4'), out.stdout + out.stderr

    def duration(self, path):
        return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], capture_output=True, text=True).stdout)

    def test_a_closing_dub_too_long_for_its_clip_is_heard_to_the_end_and_the_picture_waits(self):
        d = tempfile.mkdtemp(prefix='asm-hold-')
        try:
            final, log = self.build(d, 6.5)             # window 3.5 s; 6.5 s / 1.25 = 5.2 s -> hold 2.05 s
            self.assertAlmostEqual(self.duration(final), 4.0 + 2.05, delta=0.15)
            f, m = spectrum(final, 4.6, 5.3)            # past the end of the 4 s clip: the voice must still be speaking
            self.assertGreater(level(f, m, 880), 5.0, 'the end of the closing line was cut')
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_a_closing_dub_that_fits_changes_nothing(self):
        d = tempfile.mkdtemp(prefix='asm-hold-')
        try:
            final, log = self.build(d, 3.0)
            self.assertAlmostEqual(self.duration(final), 4.0, delta=0.1)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_only_the_last_shot_is_held_an_earlier_overlong_dub_is_still_cut(self):
        d = tempfile.mkdtemp(prefix='asm-hold-')
        try:
            for k in range(2):
                tone(os.path.join(d, f's{k}.mp4'), 330, 4, video=True)
            tone(os.path.join(d, 'voice.mp3'), 880, 6.5)
            dub = {'file': os.path.join(d, 'voice.mp3'), 'seconds': 6.5}
            json.dump({'slug': 'final', 'crossfade': 0.3, 'shots': [{'id': 's0', 'narration': 'x', 'dub': dub}, {'id': 's1', 'narration': 'y'}], 'edit': {}},
                      open(os.path.join(d, 'assemble.json'), 'w'))
            out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assemble.py'), d], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertAlmostEqual(self.duration(os.path.join(d, 'final.mp4')), 4.0 + 4.0 - 0.3, delta=0.15)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
