"""E3: `edit.beatCuts` — "potong ritme": hard cuts to a punch-in INSIDE a clip, at the pauses of the voice.

Free (no new clip, no credit), and it must not move anything else: voice, karaoke captions and crossfades keep the times
they have without it.
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
from assemble import beat_cut_times, beat_windows, filter_graph
from test_assemble_closing import graphs_of

WORDS = [['Sari', 0.0, 0.4], ['menyalakan', 0.45, 1.1], ['lentera,', 1.1, 1.8],
         ['lalu', 1.85, 2.2], ['pergi', 2.2, 2.7], ['ke', 2.7, 2.9], ['hutan.', 2.9, 3.6],
         ['Ia', 4.0, 4.2], ['tak', 4.2, 4.5], ['kembali.', 4.5, 5.3]]


class CutTimes(unittest.TestCase):
    def test_without_words_a_long_shot_is_cut_in_the_middle(self):
        self.assertEqual(beat_cut_times(6.0), [3.0])

    def test_a_longer_shot_is_cut_into_pieces_of_about_three_seconds(self):
        self.assertEqual(beat_cut_times(9.0), [3.0, 6.0])

    def test_a_short_shot_is_left_alone(self):
        self.assertEqual(beat_cut_times(2.5), [])
        self.assertEqual(beat_cut_times(3.0), [])

    def test_the_cut_lands_on_the_end_of_a_phrase(self):
        cuts = beat_cut_times(6.0, WORDS, tempo=1.0, lead=0.3)
        # phrase ends: 1.8 (comma), 3.6 (full stop) -> on the clip clock +0.3; the pause 3.6-4.0 is cut at its middle
        self.assertTrue(any(abs(c - (0.3 + 3.8)) < 0.06 or abs(c - (0.3 + 1.8)) < 0.06 for c in cuts), cuts)
        for c in cuts:
            self.assertGreaterEqual(c, 0.3 + 0.5 + 0.3 - 1e-6)

    def test_the_tempo_of_the_dub_moves_the_cut(self):
        slow = beat_cut_times(6.0, WORDS, tempo=1.0, lead=0.3)
        fast = beat_cut_times(6.0, WORDS, tempo=1.25, lead=0.3)
        self.assertNotEqual(slow, fast)
        self.assertTrue(any(abs(c - (0.3 + 3.8 / 1.25)) < 0.06 for c in fast), fast)   # the pause after 'hutan.' came earlier

    def test_words_that_the_cut_dub_never_says_are_ignored(self):
        words = [['a', 0, 1.0], ['b,', 1.0, 2.0], ['c', 2.0, 3.0], ['d.', 3.0, 4.0], ['e', 4.5, 5.5], ['f.', 5.5, 6.5]]
        self.assertTrue(any(abs(c - 4.25) < 0.01 for c in beat_cut_times(7.5, words, tempo=1.0, lead=0.0)))
        self.assertFalse(any(abs(c - 4.25) < 0.01 for c in beat_cut_times(7.5, words, tempo=1.0, lead=0.0, window=3.0)))

    def test_no_cut_within_the_crossfades_or_too_close_together(self):
        for dur in (3.4, 4.0, 5.0, 6.0, 7.5, 9.0, 12.0):
            for words in (None, WORDS):
                cuts = beat_cut_times(dur, words, tempo=1.0, lead=0.3, xf=0.3)
                pts = [0.0] + cuts + [dur]
                with self.subTest(dur=dur, words=bool(words)):
                    for c in cuts:
                        self.assertGreaterEqual(c, 0.8 - 1e-6)
                        self.assertLessEqual(c, dur - 0.8 + 1e-6)
                    for a, b in zip(pts, pts[1:]):
                        self.assertGreaterEqual(b - a, 1.4 - 1e-6)
                        self.assertLessEqual(b - a, 4.2)

    def test_bad_words_never_crash_and_fall_back_to_the_middle(self):
        for bad in ([], [None], [['x']], [['a', 'b', 'c']], 'text', [['a', 1, 0.2]]):
            with self.subTest(bad=bad):
                self.assertEqual(beat_cut_times(6.0, bad, tempo=1.0, lead=0.3), [3.0])
        self.assertEqual(beat_cut_times(6.0, WORDS, tempo=0, lead=0.3), beat_cut_times(6.0, WORDS, tempo=1.0, lead=0.3))

    def test_a_long_pause_with_no_punctuation_is_a_phrase_end_too(self):
        words = [['satu', 0.0, 0.5], ['dua', 0.5, 1.0], ['tiga', 2.6, 3.0], ['empat', 3.0, 3.4]]
        cuts = beat_cut_times(6.0, words, tempo=1.0, lead=0.0)
        self.assertTrue(any(abs(c - 1.8) < 0.06 for c in cuts), cuts)


class Windows(unittest.TestCase):
    def test_every_second_piece_is_punched_in_and_the_zoom_alternates(self):
        w = beat_windows([2.0, 4.0, 6.0, 8.0], 10.0, zoom=1.14)
        self.assertEqual([(a, b) for a, b, _, _ in w], [(2.0, 4.0), (6.0, 8.0)])
        self.assertEqual([z for _, _, z, _ in w], [1.10, 1.18])
        self.assertEqual(len({y for *_, y in w}), 2, 'the anchor must differ from one punch-in to the next')

    def test_the_zoom_stays_between_1_05_and_1_4(self):
        for z in (0.2, 1.0, 1.14, 1.35, 9):
            for _, _, zz, _ in beat_windows([2.0, 4.0, 6.0, 8.0], 10.0, zoom=z):
                self.assertGreaterEqual(zz, 1.05)
                self.assertLessEqual(zz, 1.4)

    def test_no_cuts_no_windows(self):
        self.assertEqual(beat_windows([], 6.0, zoom=1.14), [])

    def test_the_last_punch_in_runs_to_the_end_of_the_clip(self):
        self.assertEqual(beat_windows([3.0], 6.0, zoom=1.14)[0][:2], (3.0, 6.0))


class Graph(unittest.TestCase):
    def test_no_beats_is_the_old_string(self):
        self.assertEqual(filter_graph([6.0, 6.0], 0.3, total=11.7), filter_graph([6.0, 6.0], 0.3, total=11.7, beats=None))
        self.assertEqual(filter_graph([6.0, 6.0], 0.3, total=11.7), filter_graph([6.0, 6.0], 0.3, total=11.7, beats=[[], None]))

    def test_a_punch_in_is_a_split_scale_crop_and_a_timed_overlay_inside_the_same_clip(self):
        g = filter_graph([6.0, 6.0], 0.3, total=11.7, streams='v', beats=[[(3.0, 6.0, 1.14, 0.4)], None])
        self.assertEqual(g.count('split='), 1)
        self.assertEqual(g.count('-i'), 0)
        self.assertIn("overlay=0:0:enable='between(t,3.0,6.0)'", g)
        self.assertIn('scale=trunc(720*1.14/2)*2:trunc(1280*1.14/2)*2,crop=720:1280:(iw-720)/2:(ih-1280)*0.4', g)
        self.assertEqual(g.count('xfade='), 1)

    def test_two_punch_ins_split_into_three_branches(self):
        g = filter_graph([9.0], 0.3, total=9.0, streams='v', beats=[[(2.0, 4.0, 1.1, 0.35), (6.0, 8.0, 1.18, 0.65)]])
        self.assertIn('split=3', g)
        self.assertEqual(g.count('overlay='), 2)

    def test_the_hold_of_the_last_shot_comes_after_the_beats(self):
        g = filter_graph([6.0, 7.0], 0.3, total=12.7, streams='v', tail_hold=1.0, beats=[None, [(3.0, 7.0, 1.14, 0.4)]])
        self.assertLess(g.index('overlay=0:0:enable'), g.index('tpad=stop_mode=clone'))

    def test_the_audio_graph_does_not_know_about_beats(self):
        a = filter_graph([6.0, 6.0], 0.3, total=11.7, streams='a')
        self.assertEqual(a, filter_graph([6.0, 6.0], 0.3, total=11.7, streams='a', beats=[[(3.0, 6.0, 1.14, 0.4)], None]))


def plan(edit, shots=2, words=True):
    return {'slug': 'final', 'crossfade': 0.3, 'edit': edit,
            'shots': [{'id': f's{i}', 'narration': 'Sari menyalakan lentera, lalu pergi ke hutan. Ia tak kembali.',
                       **({'dub': {'seconds': 5.4, **({'words': WORDS} if words else {})}} if i == 0 else {})} for i in range(shots)]}


class FromThePlan(unittest.TestCase):
    def test_off_by_default_and_when_false(self):
        base = graphs_of(plan({}), 5.4)
        self.assertEqual(graphs_of(plan({'beatCuts': False}), 5.4), base)
        self.assertNotIn('overlay=0:0:enable', base[0])

    def test_on_adds_punch_ins_to_the_picture_only(self):
        v0, a0, t0 = graphs_of(plan({}), 5.4)
        v1, a1, t1 = graphs_of(plan({'beatCuts': {}}), 5.4)
        self.assertIn('overlay=0:0:enable', v1)
        self.assertEqual(a1, a0, 'the voice/audio chain must not move')
        self.assertEqual(t1, t0, 'the length of the video must not change')
        self.assertEqual(re.findall(r'xfade=[^;\[]*', v1), re.findall(r'xfade=[^;\[]*', v0))

    def test_every_dubbed_and_silent_shot_gets_cut(self):
        v, a, _ = graphs_of(plan({'beatCuts': {}}), 5.4)
        self.assertEqual(v.count('overlay=0:0:enable'), 2)     # shot 0 (on its phrases) and shot 1 (no dub: in the middle)

    def test_the_zoom_of_the_plan_is_used(self):
        v, a, _ = graphs_of(plan({'beatCuts': {'zoom': 1.2}}), 5.4)
        self.assertIn('trunc(720*1.16/2)*2', v)     # the first punch-in of a shot is 0.04 below the chosen zoom, the next 0.04 above

    def test_nonsense_means_off(self):
        base = graphs_of(plan({}), 5.4)
        for bad in (True, 'ya', 3, [1], None):
            with self.subTest(bad=bad):
                self.assertEqual(graphs_of(plan({'beatCuts': bad}), 5.4), base)

    def test_with_the_beats_on_the_shot_graph_gets_no_extra_input(self):
        v, a, _ = graphs_of(plan({'beatCuts': {}}), 5.4)
        self.assertEqual(len(re.findall(r'\[(\d+):v\]', v)), 2)


def make_static_clip(path, seconds=6):
    """A clip of one still picture with fine detail (so a punch-in shows) and a tone."""
    png = path + '.png'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=720x1280,geq=lum=128+90*sin(X/9)*sin(Y/13):cb=128+60*sin(X/50):cr=128+60*sin(Y/70)', '-frames:v', '1', png], check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-loop', '1', '-framerate', '24', '-i', png, '-f', 'lavfi', '-i', 'sine=frequency=330:duration=%d' % seconds, '-t', str(seconds),
                    '-shortest', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path], check=True)


class Rendered(unittest.TestCase):
    def frames(self, path):
        import numpy as np
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-an', '-s', '90x160', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
        return np.frombuffer(raw, dtype=np.uint8).reshape(-1, 160, 90).astype(float)

    def assemble(self, d, edit, shot=None):
        json.dump({'slug': 'final', 'crossfade': 0.3, 'shots': [{'id': 's0', **(shot or {})}], 'edit': edit}, open(os.path.join(d, 'assemble.json'), 'w'))
        out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assemble.py'), d], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        return self.frames(os.path.join(d, 'final.mp4')), out.stdout

    def test_the_picture_jumps_in_at_the_cut_and_only_there(self):
        import numpy as np
        d = tempfile.mkdtemp(prefix='beats-')
        try:
            make_static_clip(os.path.join(d, 's0.mp4'))
            flat, _ = self.assemble(d, {'fadeIn': 0})
            cut, out = self.assemble(d, {'fadeIn': 0, 'beatCuts': {'zoom': 1.14}})
            self.assertEqual(len(flat), len(cut), 'same number of frames: nothing moved in time')
            diff = np.abs(cut - flat).mean(axis=(1, 2))
            first = int(np.argmax(diff > 8))
            self.assertAlmostEqual(first / 24, 3.0, delta=0.09, msg=f'the picture changes at frame {first}')
            self.assertLess(diff[:first].max(), 3.0, 'before the cut it is the plain clip')
            self.assertGreater(diff[first:first + 20].min(), 8, 'after the cut it stays punched in')
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_the_voice_and_the_length_are_the_same_with_and_without(self):
        d = tempfile.mkdtemp(prefix='beats-')
        try:
            make_static_clip(os.path.join(d, 's0.mp4'))
            _, a = self.assemble(d, {})
            a_len = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', os.path.join(d, 'final.mp4')], capture_output=True, text=True).stdout
            _, b = self.assemble(d, {'beatCuts': {}})
            b_len = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', os.path.join(d, 'final.mp4')], capture_output=True, text=True).stdout
            self.assertEqual(a_len, b_len)
            self.assertEqual(json.loads(a)['durations'], json.loads(b)['durations'])
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
