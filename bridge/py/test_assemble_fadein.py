"""E2: `edit.fadeIn` (seconds, 0..1.2) replaces the fixed 0.8 s fade-in from black; absent = 0.8, exactly as before."""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import assemble
from assemble import filter_graph
from test_assemble_closing import graphs_of


def plan(edit):
    return {'slug': 'final', 'crossfade': 0.3, 'shots': [{'id': 's0'}, {'id': 's1'}], 'edit': edit}


class Main(unittest.TestCase):
    def test_the_plan_sets_the_fade_of_the_picture(self):
        v, a, _ = graphs_of(plan({'fadeIn': 0.25}), 0)
        self.assertIn('fade=t=in:st=0:d=0.25,', v)
        self.assertNotIn('d=0.8,', v)

    def test_the_sound_comes_in_with_the_picture(self):
        v, a, _ = graphs_of(plan({'fadeIn': 0.4}), 0)
        self.assertIn('afade=t=in:st=0:d=0.3,', a)     # three quarters of the picture's fade, as 0.6 is of 0.8

    def test_zero_has_no_picture_fade_and_only_a_declick_in_the_sound(self):
        v, a, _ = graphs_of(plan({'fadeIn': 0}), 0)
        self.assertNotIn('fade=t=in', v)
        self.assertIn('afade=t=in:st=0:d=0.02,', a)

    def test_no_field_is_the_old_fade(self):
        v, a, _ = graphs_of(plan({}), 0)
        self.assertIn('fade=t=in:st=0:d=0.8,', v)
        self.assertIn('afade=t=in:st=0:d=0.6,', a)

    def test_an_explicit_0_8_is_the_old_fade_too(self):
        old = graphs_of(plan({}), 0)
        self.assertEqual(graphs_of(plan({'fadeIn': 0.8}), 0), old)

    def test_nonsense_falls_back_to_the_old_fade_or_the_limits(self):
        old = graphs_of(plan({}), 0)
        for bad in ('x', None, [1], {'a': 1}, float('nan'), True):
            with self.subTest(bad=bad):
                self.assertEqual(graphs_of(plan({'fadeIn': bad}), 0), old)
        self.assertIn('fade=t=in:st=0:d=1.2,', graphs_of(plan({'fadeIn': 9}), 0)[0])
        self.assertNotIn('fade=t=in', graphs_of(plan({'fadeIn': -3}), 0)[0])


class Graph(unittest.TestCase):
    def test_the_default_is_the_old_string(self):
        self.assertEqual(filter_graph([5.0, 5.0], 0.3, total=9.7), filter_graph([5.0, 5.0], 0.3, total=9.7, fade_in=None))
        self.assertIn('fade=t=in:st=0:d=0.8,fade=t=out', filter_graph([5.0, 5.0], 0.3, total=9.7, streams='v'))

    def test_zero_removes_the_fade_and_keeps_the_end_fade(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7, streams='v', fade_in=0)
        self.assertNotIn('fade=t=in', g)
        self.assertIn('fade=t=out:st=8.5:d=1.2', g)


class Rendered(unittest.TestCase):
    """Real ffmpeg: the first frame is no longer black."""

    def first_and_later_luma(self, edit):
        d = tempfile.mkdtemp(prefix='fadein-')
        try:
            for k in range(2):
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xc0c0c0:s=720x1280:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3',
                                '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', os.path.join(d, f's{k}.mp4')], check=True)
            json.dump(plan(edit), open(os.path.join(d, 'assemble.json'), 'w'))
            out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assemble.py'), d], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            import numpy as np
            def luma(frame):
                raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join(d, 'final.mp4'), '-vf', f'select=eq(n\\,{frame})', '-frames:v', '1', '-s', '36x64',
                                      '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
                return float(np.frombuffer(raw, dtype=np.uint8).mean())
            return luma(0), luma(24)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_default_first_frame_is_black(self):
        first, later = self.first_and_later_luma({})
        self.assertLess(first, 0.1 * later)

    def test_fade_in_zero_opens_on_the_picture(self):
        first, later = self.first_and_later_luma({'fadeIn': 0})
        self.assertGreaterEqual(first, 0.6 * later, f'first frame {first:.0f} vs later {later:.0f}')

    def test_a_short_fade_is_nearly_up_by_a_quarter_second(self):
        first, later = self.first_and_later_luma({'fadeIn': 0.25})
        self.assertLess(first, 0.1 * later)
        self.assertGreaterEqual(later, 100)


if __name__ == '__main__':
    unittest.main()
