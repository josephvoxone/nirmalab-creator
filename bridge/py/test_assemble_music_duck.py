"""Music under a dubbed voice: the bed gets out of the way while the voice speaks and comes back in the pauses."""
import json
import math
import os
import shutil
import subprocess
import tempfile
import unittest

from assemble import filter_graph
from test_assemble_dub import tone, spectrum, level


def dubs_for(n=2):
    return [{'input': n + 1, 'tempo': 1.0, 'lead': 0.3, 'cut': False}] + [None] * (n - 1)


class Graph(unittest.TestCase):
    def test_music_under_a_dub_is_ducked_by_the_voice_and_cleared_of_rumble(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7, streams='a', music_input=3, music={'at': 0, 'volume': 0.7}, dubs=dubs_for())
        self.assertIn('sidechaincompress', g)
        self.assertIn('highpass=f=90', g)

    def test_music_without_any_dub_is_exactly_what_it_was(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7, streams='a', music_input=2, music={'at': 0, 'volume': 0.7})
        self.assertNotIn('sidechaincompress', g)
        self.assertNotIn('highpass', g)


class EndToEnd(unittest.TestCase):
    def test_the_music_drops_at_least_8_db_while_the_voice_speaks(self):
        d = tempfile.mkdtemp(prefix='asm-duck-')
        try:
            tone(os.path.join(d, 's0.mp4'), 330, 9, video=True)
            tone(os.path.join(d, 'voice.mp3'), 880, 3)                          # spoken 0.3 .. 3.3 s on the film's clock
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', os.path.join(d, 'bed.wav')], check=True)
            json.dump({'slug': 'final', 'crossfade': 0.3,
                       'shots': [{'id': 's0', 'narration': 'x', 'dub': {'file': os.path.join(d, 'voice.mp3'), 'seconds': 3.0}}],
                       'edit': {'music': {'path': os.path.join(d, 'bed.wav'), 'volume': 0.8, 'at': 0}}}, open(os.path.join(d, 'assemble.json'), 'w'))
            out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assemble.py'), d], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            final = os.path.join(d, 'final.mp4')
            f1, m1 = spectrum(final, 1.2, 2.8)      # the voice is speaking
            f2, m2 = spectrum(final, 5.0, 6.8)      # a pause
            speaking, quiet = level(f1, m1, 220), level(f2, m2, 220)
            self.assertGreater(quiet, 0, 'the music is audible in the pause')
            drop = 20 * math.log10(speaking / quiet)
            self.assertLess(drop, -8, f'music level while speaking vs in the pause: {drop:.1f} dB')
            self.assertGreater(level(f1, m1, 880), 3 * level(f1, m1, 220), 'and the voice stays on top')
        finally:
            shutil.rmtree(d, ignore_errors=True)


    def test_a_quiet_dub_still_ducks_the_music_as_deeply(self):
        # ElevenLabs lines sit around -25..-30 dBFS RMS before the final loudness pass; the ducking depth must not depend on that
        d = tempfile.mkdtemp(prefix='asm-duck-')
        try:
            tone(os.path.join(d, 's0.mp4'), 330, 9, video=True)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', '-af', 'volume=0.32', '-c:a', 'libmp3lame', os.path.join(d, 'voice.mp3')], check=True)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', os.path.join(d, 'bed.wav')], check=True)
            json.dump({'slug': 'final', 'crossfade': 0.3,
                       'shots': [{'id': 's0', 'narration': 'x', 'dub': {'file': os.path.join(d, 'voice.mp3'), 'seconds': 3.0}}],
                       'edit': {'music': {'path': os.path.join(d, 'bed.wav'), 'volume': 0.3, 'at': 0}}}, open(os.path.join(d, 'assemble.json'), 'w'))
            out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assemble.py'), d], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            final = os.path.join(d, 'final.mp4')
            f1, m1 = spectrum(final, 1.2, 2.8)
            f2, m2 = spectrum(final, 5.0, 6.8)
            drop = 20 * math.log10(level(f1, m1, 220) / level(f2, m2, 220))
            self.assertLess(drop, -8, f'music drop under a quiet voice: {drop:.1f} dB')
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_the_key_is_lifted_before_the_compressor(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7, streams='a', music_input=3, music={'at': 0, 'volume': 0.7}, dubs=dubs_for())
        self.assertIn('[clipk0]volume=2[clipk]', g)


if __name__ == '__main__':
    unittest.main()
