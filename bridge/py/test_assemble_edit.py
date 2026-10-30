"""Timeline edits in the assembler: trim per clip, clip volume, a music track, burned-in subtitles."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from assemble import FONTS_DIR, ass_document, clip_window, filter_graph, subtitle_events


def has_filter(name):
    try:
        out = subprocess.run(['ffmpeg', '-hide_banner', '-filters'], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return False
    return f' {name} ' in out


class Trim(unittest.TestCase):
    def test_untrimmed_clip_plays_whole(self):
        self.assertEqual(clip_window({}, 5.04), (0.0, 5.04))

    def test_trim_in_and_out(self):
        self.assertEqual(clip_window({'trim': {'in': 0.5, 'out': 4.0}}, 5.04), (0.5, 3.5))

    def test_out_past_the_end_or_absent_stops_at_the_end(self):
        self.assertEqual(clip_window({'trim': {'in': 1.0}}, 5.0), (1.0, 4.0))
        self.assertEqual(clip_window({'trim': {'in': 1.0, 'out': 9.0}}, 5.0), (1.0, 4.0))

    def test_never_shorter_than_one_second_and_the_out_point_stays(self):
        self.assertEqual(clip_window({'trim': {'in': 4.8, 'out': 4.9}}, 5.0), (3.9, 1.0))
        self.assertEqual(clip_window({'trim': {'in': 0.2, 'out': 0.5}}, 5.0), (0.0, 1.0))


class Subtitles(unittest.TestCase):
    def test_one_line_per_spoken_clip_on_the_output_clock(self):
        # 3 clips of 5 s with 0.3 s crossfades: clip 2 starts at 4.7, clip 3 at 9.4
        events = subtitle_events([5.0, 5.0, 5.0], 0.3, ['Setiap malam.', '', 'Dia tidak pernah pergi.'])
        self.assertEqual(events, [(0.0, 4.7, 'Setiap malam.'), (9.4, 14.4, 'Dia tidak pernah pergi.')])

    def test_ass_has_vertical_play_res_and_escaped_dialogue(self):
        doc = ass_document([(0.0, 4.7, 'Tuhan, {masih} ada?\nMaafkan Raka.')], 720, 1280)
        self.assertIn('PlayResX: 720', doc)
        self.assertIn('PlayResY: 1280', doc)
        self.assertIn('Dialogue: 0,0:00:00.00,0:00:04.70,Default,,0,0,0,,Tuhan, (masih) ada?\\NMaafkan Raka.', doc)


class Graph(unittest.TestCase):
    def test_clip_volume_scales_the_clip_audio(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7, clip_volume=0.6)
        self.assertIn('volume=0.6', g)

    def test_music_is_delayed_to_its_start_and_mixed_under_the_clips(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7, music_input=2, music={'volume': 0.35, 'at': 1.5})
        self.assertIn('[2:a]', g)
        self.assertIn('volume=0.35', g)
        self.assertIn('adelay=1500|1500', g)
        self.assertIn('amix=inputs=2:duration=first:normalize=0', g)
        self.assertTrue(g.split(';')[-1].endswith('[aout]'))

    def test_subtitles_are_burned_before_the_end_fade(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7, subtitles='/tmp/x/subs.ass')
        video = [p for p in g.split(';') if p.endswith('[vout]')][0]
        self.assertIn("subtitles=filename=/tmp/x/subs.ass", video)
        self.assertLess(video.index('subtitles='), video.index('fade=t=out'))
        self.assertIn('fontsdir=/usr/share/fonts/truetype/dejavu', video)

    def test_handwritten_subtitles_use_the_bundled_font_dir(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7, subtitles='/tmp/x/subs.ass', fonts_dir=FONTS_DIR)
        self.assertIn(f'fontsdir={FONTS_DIR}', g)
        self.assertTrue(os.path.exists(os.path.join(FONTS_DIR, 'GochiHand-Regular.ttf')))


class HandwrittenStyle(unittest.TestCase):
    def test_default_style_is_unchanged(self):
        doc = ass_document([(0.0, 2.0, 'Halo')], 720, 1280)
        self.assertIn('Style: Default,DejaVu Sans,', doc)
        self.assertIn(',2,58,58,179,1', doc)      # bottom-centre, margins as before

    def test_tulisan_tangan_is_gochi_hand_in_the_upper_band_with_soft_fades(self):
        doc = ass_document([(0.0, 2.5, 'Satu langkah.')], 720, 1280, style='tulisan-tangan')
        style = [l for l in doc.split('\n') if l.startswith('Style: Default,')][0]
        self.assertTrue(style.startswith('Style: Default,Gochi Hand,'))
        fields = style.split(',')
        self.assertEqual(fields[18], '8')           # Alignment 8 = top centre (the quiet sky band)
        self.assertEqual(fields[7], '0')            # not bold: the hand-lettering stays light
        line = [l for l in doc.split('\n') if l.startswith('Dialogue:')][0]
        self.assertIn('{\\fad(500,500)\\blur', line)
        self.assertTrue(line.endswith('Satu langkah.'))


@unittest.skipUnless(shutil.which('ffmpeg') and has_filter('subtitles'), 'needs ffmpeg with libass')
class EndToEnd(unittest.TestCase):
    def test_trimmed_clips_music_and_subtitles_make_one_video(self):
        d = tempfile.mkdtemp(prefix='asm-edit-')
        try:
            for i, tone in enumerate([440, 660]):
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x334455:s=720x1280:r=24:d=4',
                                '-f', 'lavfi', '-i', f'sine=frequency={tone}:duration=4', '-shortest',
                                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', os.path.join(d, f's{i}.mp4')], check=True)
            music = os.path.join(d, 'music.m4a')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=20', '-c:a', 'aac', music], check=True)
            plan = {
                'slug': 'final', 'crossfade': 0.3,
                'shots': [
                    {'id': 's0', 'narration': 'Setiap malam, Nenek mengajari Raka berdoa.'},
                    {'id': 's1', 'narration': 'Dia tidak pernah pergi.', 'trim': {'in': 1.0, 'out': 3.0}}
                ],
                'edit': {'clipVolume': 0.8, 'subtitles': True, 'music': {'path': music, 'volume': 0.3, 'at': 1.0, 'from': 2.0}}
            }
            json.dump(plan, open(os.path.join(d, 'assemble.json'), 'w'))
            out = subprocess.run(['python3', os.path.join(os.path.dirname(__file__), 'assemble.py'), d], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            info = json.loads(out.stdout.strip().splitlines()[-1])
            self.assertAlmostEqual(info['total'], 4.0 + 2.0 - 0.3, places=2)
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', info['file']],
                                   capture_output=True, text=True, check=True)
            meta = json.loads(probe.stdout)
            self.assertEqual(sorted(s['codec_type'] for s in meta['streams']), ['audio', 'video'])
            self.assertAlmostEqual(float(meta['format']['duration']), 5.7, delta=0.15)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()


class ShotZoom(unittest.TestCase):
    def test_zoom_crops_into_the_clip_centre_and_default_is_untouched(self):
        g = filter_graph([5.0, 5.0], 0.3, total=9.7, zooms=[1.0, 1.12])
        v0 = [p for p in g.split(';') if p.startswith('[0:v]')][0]
        v1 = [p for p in g.split(';') if p.startswith('[1:v]')][0]
        self.assertNotIn('*1.12', v0)
        self.assertIn('scale=trunc(iw*1.12/2)*2:trunc(ih*1.12/2)*2,crop=720:1280', v1)
        self.assertEqual(filter_graph([5.0], 0.3, total=5.0), filter_graph([5.0], 0.3, total=5.0, zooms=None))

    def test_zoom_of_a_shot_is_read_and_clamped(self):
        from assemble import shot_zoom
        self.assertEqual(shot_zoom({}), 1.0)
        self.assertEqual(shot_zoom({'zoom': 1.12}), 1.12)
        self.assertEqual(shot_zoom({'zoom': 5}), 1.4)
        self.assertEqual(shot_zoom({'zoom': 0.5}), 1.0)


class ZoomAnchor(unittest.TestCase):
    """Zoom can be pinned to the bottom (or top) so a page edge + caption the model drew at the top is cropped out."""

    def test_anchor_is_read_and_clamped_and_defaults_to_the_centre(self):
        from assemble import shot_zoom_y
        self.assertEqual(shot_zoom_y({}), 0.5)
        self.assertEqual(shot_zoom_y({'zoomY': 1}), 1.0)
        self.assertEqual(shot_zoom_y({'zoomY': 0}), 0.0)
        self.assertEqual(shot_zoom_y({'zoomY': 7}), 1.0)
        self.assertEqual(shot_zoom_y({'zoomY': -2}), 0.0)
        self.assertEqual(shot_zoom_y({'zoomY': 'x'}), 0.5)

    def test_bottom_anchor_crops_from_the_bottom_edge_and_centre_is_unchanged(self):
        centred = filter_graph([5.0, 5.0], 0.3, total=9.7, zooms=[1.0, 1.3])
        bottom = filter_graph([5.0, 5.0], 0.3, total=9.7, zooms=[1.0, 1.3], zoom_ys=[0.5, 1.0])
        v1 = [p for p in bottom.split(';') if p.startswith('[1:v]')][0]
        self.assertIn('crop=720:1280:(iw-720)/2:(ih-1280)*1.0', v1)
        # a centred anchor must keep the exact graph that shipped before the anchor existed
        self.assertEqual(centred, filter_graph([5.0, 5.0], 0.3, total=9.7, zooms=[1.0, 1.3], zoom_ys=[0.5, 0.5]))
        self.assertEqual(centred, filter_graph([5.0, 5.0], 0.3, total=9.7, zooms=[1.0, 1.3], zoom_ys=None))

    @unittest.skipUnless(has_filter('crop'), 'needs ffmpeg')
    def test_bottom_anchor_really_drops_the_top_band_of_the_picture(self):
        d = tempfile.mkdtemp(prefix='asm-anchor-')
        try:
            # top 15% white, rest black: after a 1.3x zoom pinned to the bottom the top row must be black
            src = os.path.join(d, 's0.mp4')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=720x1280:r=24:d=2',
                            '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-shortest',
                            '-vf', 'drawbox=x=0:y=0:w=720:h=200:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                            '-c:a', 'aac', src], check=True)
            for y, expect_white in ((0.5, True), (1.0, False)):
                plan = {'slug': f'out{y}', 'crossfade': 0.3, 'shots': [{'id': 's0', 'zoom': 1.3, 'zoomY': y}]}
                json.dump(plan, open(os.path.join(d, 'assemble.json'), 'w'))
                out = subprocess.run(['python3', os.path.join(os.path.dirname(__file__), 'assemble.py'), d], capture_output=True, text=True)
                self.assertEqual(out.returncode, 0, out.stderr)
                png = os.path.join(d, f'f{y}.png')
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '1', '-i', os.path.join(d, f'out{y}.mp4'), '-frames:v', '1',
                                '-vf', 'crop=720:40:0:0,scale=1:1', '-pix_fmt', 'gray', '-f', 'rawvideo', png], check=True)
                luma = open(png, 'rb').read()[0]
                self.assertEqual(luma > 128, expect_white, f'zoomY={y}: top luma {luma}')
        finally:
            shutil.rmtree(d, ignore_errors=True)


class SubtitleSizeAndPosition(unittest.TestCase):
    def test_size_scales_the_font_and_y_pins_the_top_of_the_text(self):
        plain = ass_document([(0.0, 2.0, 'Halo')], 720, 1280)
        big = ass_document([(0.0, 2.0, 'Halo')], 720, 1280, size=1.5, y=0.42)
        size = lambda doc: int([l for l in doc.split('\n') if l.startswith('Style: Default,')][0].split(',')[2])
        self.assertEqual(size(big), round(size(plain) * 1.5))
        line = [l for l in big.split('\n') if l.startswith('Dialogue:')][0]
        self.assertIn('{\\an8\\pos(360,538)}', line)       # top-centre at 42% of 1280
        self.assertTrue(line.endswith('Halo'))

    def test_defaults_are_byte_identical(self):
        self.assertEqual(ass_document([(0.0, 2.0, 'Halo')], 720, 1280), ass_document([(0.0, 2.0, 'Halo')], 720, 1280, size=None, y=None))
        hand = ass_document([(0.0, 2.0, 'Halo')], 720, 1280, style='tulisan-tangan', y=0.7)
        line = [l for l in hand.split('\n') if l.startswith('Dialogue:')][0]
        self.assertIn('{\\an8\\pos(360,896)}{\\fad(500,500)\\blur1.5}Halo', line)
