"""The assembler must never hold the whole timeline in memory.

ffmpeg 5.1 (the Debian build in the production image) decodes every input as soon as ONE graph asks for
audio from all of them, and parks the raw video frames of the later clips until the crossfade chain reaches
them: 21 clips of 720x1280 needed 5.7-8.1 GB and the kernel OOM-killed ffmpeg ("ffmpeg failed:" with no
message).  Video and audio therefore render in separate passes and are muxed with -c copy.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import assemble
from assemble import filter_graph


def make_story(d, clips=3, seconds=2):
    for i in range(clips):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'color=c=0x334455:s=720x1280:r=24:d={seconds}',
                        '-f', 'lavfi', '-i', f'sine=frequency={300 + 100 * i}:duration={seconds}', '-shortest',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', os.path.join(d, f's{i}.mp4')], check=True)
    plan = {'slug': 'final', 'crossfade': 0.3, 'shots': [{'id': f's{i}', 'narration': f'Baris {i}.'} for i in range(clips)],
            'edit': {'subtitles': True}}
    json.dump(plan, open(os.path.join(d, 'assemble.json'), 'w'))


class StreamSplit(unittest.TestCase):
    def test_video_only_graph_has_no_audio_chain(self):
        g = filter_graph([5.0, 5.0, 5.0], 0.3, total=14.4, streams='v')
        self.assertIn('[vout]', g)
        self.assertIn('xfade', g)
        for word in ('[aout]', 'acrossfade', ':a]', 'loudnorm'):
            self.assertNotIn(word, g)

    def test_audio_only_graph_has_no_video_chain(self):
        g = filter_graph([5.0, 5.0, 5.0], 0.3, total=14.4, streams='a')
        self.assertIn('[aout]', g)
        self.assertIn('acrossfade', g)
        for word in ('[vout]', 'xfade=', ':v]', 'scale='):
            self.assertNotIn(word, g)

    def test_default_still_builds_both(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7)
        self.assertIn('[vout]', g)
        self.assertIn('[aout]', g)


class Passes(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='asm-mem-')
        make_story(self.d)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def run_main(self):
        real = subprocess.run
        seen = []

        def spy(cmd, *a, **k):
            if isinstance(cmd, list) and cmd and cmd[0] == 'ffmpeg' and '-filter_complex' in cmd:
                seen.append(cmd)
            return real(cmd, *a, **k)

        with mock.patch('subprocess.run', side_effect=spy):
            assemble.main(self.d)
        return seen

    def test_no_single_ffmpeg_graph_carries_both_video_and_audio(self):
        for cmd in self.run_main():
            g = cmd[cmd.index('-filter_complex') + 1]
            self.assertFalse('[vout]' in g and '[aout]' in g, 'one graph renders both streams: ' + g[:120])

    def test_two_passes_then_one_file_with_both_streams_in_sync(self):
        seen = self.run_main()
        self.assertEqual(len(seen), 2)
        probe = json.loads(subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,duration,start_time', '-of', 'json',
             os.path.join(self.d, 'final.mp4')], capture_output=True, text=True, check=True).stdout)
        by = {s['codec_type']: s for s in probe['streams']}
        self.assertEqual(sorted(by), ['audio', 'video'])
        self.assertAlmostEqual(float(by['video']['duration']), 2 * 3 - 0.3 * 2, delta=0.15)
        self.assertAlmostEqual(float(by['audio']['duration']), float(by['video']['duration']), delta=0.1)
        self.assertLess(abs(float(by['audio']['start_time']) - float(by['video']['start_time'])), 0.06)

    def test_no_temporary_pass_files_are_left_behind(self):
        self.run_main()
        self.assertEqual(sorted(os.listdir(self.d)), ['assemble.json', 'final.mp4', 's0.mp4', 's1.mp4', 's2.mp4'])


class Killed(unittest.TestCase):
    def test_a_killed_ffmpeg_is_reported_as_out_of_memory_not_as_an_empty_message(self):
        d = tempfile.mkdtemp(prefix='asm-kill-')
        try:
            make_story(d)
            real = subprocess.run

            def killer(cmd, *a, **k):
                if isinstance(cmd, list) and cmd and cmd[0] == 'ffmpeg' and '-filter_complex' in cmd:
                    return subprocess.CompletedProcess(cmd, -9, '', '')
                return real(cmd, *a, **k)

            with mock.patch('subprocess.run', side_effect=killer):
                with self.assertRaises(SystemExit) as ctx:
                    assemble.main(d)
            msg = str(ctx.exception)
            self.assertIn('killed', msg)
            self.assertIn('memory', msg)
            self.assertNotEqual(msg.strip(), 'ffmpeg failed:')
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_an_ordinary_failure_keeps_the_last_ffmpeg_lines(self):
        d = tempfile.mkdtemp(prefix='asm-fail-')
        try:
            make_story(d)
            real = subprocess.run

            def failing(cmd, *a, **k):
                if isinstance(cmd, list) and cmd and cmd[0] == 'ffmpeg' and '-filter_complex' in cmd:
                    return subprocess.CompletedProcess(cmd, 1, '', 'Invalid argument\nsomething broke')
                return real(cmd, *a, **k)

            with mock.patch('subprocess.run', side_effect=failing):
                with self.assertRaises(SystemExit) as ctx:
                    assemble.main(d)
            self.assertIn('something broke', str(ctx.exception))
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
