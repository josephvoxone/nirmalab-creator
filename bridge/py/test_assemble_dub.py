"""Per-shot dubbing in the assembler: the dub replaces the clip's own voice, fitted to the shot's window."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from assemble import dub_tempo, filter_graph


def tone(path, hz, seconds, video=False):
    cmd = ['ffmpeg', '-v', 'error', '-y']
    if video:
        cmd += ['-f', 'lavfi', '-i', f'color=c=0x334455:s=720x1280:r=24:d={seconds}']
    cmd += ['-f', 'lavfi', '-i', f'sine=frequency={hz}:duration={seconds}']
    cmd += (['-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] if video else ['-c:a', 'libmp3lame'])
    subprocess.run(cmd + [path], check=True)


def spectrum(path, start, end):
    """Magnitude per frequency of the mono audio between two times (needs numpy)."""
    import numpy as np
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.int16).astype(float) / 32768
    seg = x[int(start * 16000):int(end * 16000)]
    mag = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1 / 16000)
    return freqs, mag


def level(freqs, mag, hz, width=25):
    import numpy as np
    sel = (freqs > hz - width) & (freqs < hz + width)
    return float(mag[sel].max()) if sel.any() else 0.0


class Tempo(unittest.TestCase):
    def test_a_dub_that_fits_is_not_touched(self):
        self.assertEqual(dub_tempo(3.0, 4.0), (1.0, False))
        self.assertEqual(dub_tempo(4.0, 4.0), (1.0, False))

    def test_a_longer_dub_is_sped_up_just_enough(self):
        tempo, cut = dub_tempo(4.4, 4.0)
        self.assertAlmostEqual(tempo, 1.1, places=3)
        self.assertFalse(cut)

    def test_speed_up_stops_at_1_25_and_the_rest_is_cut(self):
        tempo, cut = dub_tempo(8.0, 4.0)
        self.assertEqual(tempo, 1.25)
        self.assertTrue(cut)

    def test_nonsense_windows_do_not_crash(self):
        self.assertEqual(dub_tempo(3.0, 0), (1.25, True))
        self.assertEqual(dub_tempo(0, 4.0), (1.0, False))


class Graph(unittest.TestCase):
    def test_without_dubs_the_graph_is_exactly_what_it_was(self):
        self.assertEqual(filter_graph([5.0, 5.0], 0.3, total=9.7), filter_graph([5.0, 5.0], 0.3, total=9.7, dubs=None))
        self.assertEqual(filter_graph([5.0, 5.0], 0.3, total=9.7), filter_graph([5.0, 5.0], 0.3, total=9.7, dubs=[None, None]))

    def test_a_dubbed_shot_takes_its_voice_from_the_dub_input_and_not_from_the_clip(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7, streams='a', dubs=[{'input': 2, 'tempo': 1.0, 'lead': 0.3}, None])
        parts = g.split(';')
        a0 = [p for p in parts if p.endswith('[a0]')][0]
        self.assertIn('[2:a]', a0)
        self.assertNotIn('[0:a]', g)  # the clip's own voice is dropped
        self.assertIn('adelay=300|300', a0)
        self.assertIn('apad=whole_dur=5.0', a0)
        self.assertIn('atrim=0:5.0', a0)
        self.assertIn('[1:a]', g)  # the other shot keeps its clip audio
        self.assertNotIn('atempo', a0)

    def test_a_long_dub_gets_atempo_and_a_fade_out_when_it_must_be_cut(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7, streams='a', dubs=[{'input': 2, 'tempo': 1.25, 'lead': 0.3, 'cut': True}, None])
        a0 = [p for p in g.split(';') if p.endswith('[a0]')][0]
        self.assertIn('atempo=1.25', a0)
        self.assertIn('afade=t=out', a0)

    def test_keep_ambient_mixes_the_clip_audio_quietly_under_the_dub(self):
        g = filter_graph([5.0], 0.3, total=5.0, streams='a', dubs=[{'input': 1, 'tempo': 1.0, 'lead': 0.3, 'keep': 0.12}])
        self.assertIn('volume=0.12', g)
        self.assertIn('amix=inputs=2', g)
        self.assertIn('[0:a]', g)

    def test_the_video_graph_ignores_dubs(self):
        v = filter_graph([5.0, 5.0], 0.3, total=9.7, streams='v')
        self.assertEqual(v, filter_graph([5.0, 5.0], 0.3, total=9.7, streams='v', dubs=[{'input': 2, 'tempo': 1.0, 'lead': 0.3}, None]))


def numpy_ok():
    try:
        import numpy  # noqa: F401
        return True
    except Exception:
        return False


@unittest.skipUnless(numpy_ok(), 'needs numpy')
class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='asm-dub-')
        tone(os.path.join(self.d, 's0.mp4'), 440, 4, video=True)
        tone(os.path.join(self.d, 's1.mp4'), 660, 4, video=True)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def assemble(self, shots, edit=None):
        plan = {'slug': 'final', 'crossfade': 0.3, 'shots': shots}
        if edit:
            plan['edit'] = edit
        json.dump(plan, open(os.path.join(self.d, 'assemble.json'), 'w'))
        out = subprocess.run(['python3', os.path.join(os.path.dirname(__file__), 'assemble.py'), self.d], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        return os.path.join(self.d, 'final.mp4'), json.loads(out.stdout.strip().splitlines()[-1])

    def test_the_dub_replaces_the_clip_voice_in_its_shot_only(self):
        dub = os.path.join(self.d, 'dub0.mp3')
        tone(dub, 880, 2.0)
        final, _ = self.assemble([{'id': 's0', 'dub': {'file': dub, 'seconds': 2.0}}, {'id': 's1'}])
        f, m = spectrum(final, 0.9, 2.1)
        self.assertGreater(level(f, m, 880), 5 * level(f, m, 440), 'the dub (880 Hz) must dominate shot 1')
        f, m = spectrum(final, 4.6, 5.6)
        self.assertGreater(level(f, m, 660), 5 * level(f, m, 880), 'shot 2 keeps its own audio')

    def test_the_voice_of_a_later_shot_starts_after_the_crossfade_into_it(self):
        dub = os.path.join(self.d, 'dub1.mp3')
        tone(dub, 880, 2.0)
        final, _ = self.assemble([{'id': 's0'}, {'id': 's1', 'dub': {'file': dub, 'seconds': 2.0}}])
        # shot 2 begins at 3.7 s (4 s - 0.3 s crossfade); its voice waits 0.3 s
        f, m = spectrum(final, 3.72, 3.98)
        early = level(f, m, 880)
        f, m = spectrum(final, 4.3, 5.5)
        steady = level(f, m, 880)
        self.assertLess(early, 0.02 * steady, f'the dub leaks into the crossfade: {early} vs {steady}')

    def test_keep_ambient_leaves_the_clip_quietly_under_the_dub(self):
        dub = os.path.join(self.d, 'dub0.mp3')
        tone(dub, 880, 2.0)
        final, _ = self.assemble([{'id': 's0', 'dub': {'file': dub, 'seconds': 2.0}}, {'id': 's1'}], edit={'dubKeepAmbient': True})
        f, m = spectrum(final, 0.9, 2.1)
        loud, quiet = level(f, m, 880), level(f, m, 440)
        self.assertGreater(quiet, 0.02 * loud, 'the ambient is still there')
        self.assertLess(quiet, 0.4 * loud, 'but well below the dub')

    def test_a_dub_longer_than_the_shot_is_sped_up_and_cut_and_the_film_keeps_its_length(self):
        dub = os.path.join(self.d, 'dub0.mp3')
        tone(dub, 880, 9.0)
        final, info = self.assemble([{'id': 's0', 'dub': {'file': dub, 'seconds': 9.0}}, {'id': 's1'}])
        self.assertAlmostEqual(info['total'], 4.0 + 4.0 - 0.3, places=2)
        self.assertTrue(any('s0' in w for w in info.get('warnings', [])), info)
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', final], capture_output=True, text=True).stdout
        self.assertAlmostEqual(float(probe), 7.7, delta=0.2)

    def test_a_dub_file_that_went_missing_falls_back_to_the_clip_audio(self):
        final, info = self.assemble([{'id': 's0', 'dub': {'file': os.path.join(self.d, 'gone.mp3'), 'seconds': 2.0}}, {'id': 's1'}])
        f, m = spectrum(final, 0.9, 2.1)
        self.assertGreater(level(f, m, 440), 5 * level(f, m, 880))
        self.assertTrue(any('gone' in w or 's0' in w for w in info.get('warnings', [])), info)


if __name__ == '__main__':
    unittest.main()
