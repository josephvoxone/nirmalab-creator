import unittest
from assemble import xfade_offsets, filter_graph

class T(unittest.TestCase):
    def test_offsets_overlap_by_crossfade(self):
        # clip durations 6, 4.4, 6 with 0.5 s crossfades
        self.assertEqual(xfade_offsets([6.0, 4.4, 6.0], 0.5), [5.5, 9.4])
        self.assertAlmostEqual(sum([6.0, 4.4, 6.0]) - 2 * 0.5, 15.4)

    def test_single_clip_has_no_xfade(self):
        self.assertEqual(xfade_offsets([6.0], 0.5), [])

    def test_graph_chains_every_clip_video_and_audio(self):
        g = filter_graph([6.0, 6.0, 6.0], 0.5, transitions=['fade', 'fadeblack'])
        self.assertIn('xfade=transition=fade:duration=0.5:offset=5.5', g)
        self.assertIn('xfade=transition=fadeblack:duration=0.5:offset=11.0', g)
        self.assertEqual(g.count('acrossfade=d=0.5'), 2)
        self.assertIn('[vout]', g)
        self.assertIn('[aout]', g)

    def test_title_is_animated_sequence_overlay_not_drawtext(self):
        g = filter_graph([6.0, 6.0], 0.5, title_input=2, total=11.5)
        self.assertNotIn('drawtext', g)
        # animation (pop-in, ribbon, fade-out) is baked into the PNG sequence: no extra alpha fades
        self.assertIn('[2:v]format=rgba,setpts=PTS-STARTPTS[ttl]', g)
        self.assertIn('overlay=0:0:eof_action=pass', g)

    def test_title_card_animates_in_and_out(self):
        from title_card import TitleCard
        card = TitleCard(['SELENDANG', 'MERAH'], kicker='Sebuah Dongeng')
        alpha = lambda t: card.render_frame(t).getchannel('A').getextrema()[1]
        self.assertEqual(alpha(0.0), 0)          # empty at start: the shot breathes first
        self.assertGreater(alpha(3.0), 200)      # fully on screen mid-hold
        self.assertEqual(alpha(card.duration), 0)  # gone before the cut

    def test_resolve_story_dir_mode(self):
        import tempfile, os
        from assemble import resolve
        d = tempfile.mkdtemp()
        open(os.path.join(d, 'assemble.json'), 'w').write('{}')
        self.assertEqual(resolve(d), (os.path.join(d, 'assemble.json'), d))
        home = os.environ.get('FLOW_HOME')
        os.environ['FLOW_HOME'] = '/fh'
        try:
            self.assertEqual(resolve('kapas'), ('/fh/stories/kapas/storyboard.json', '/fh/stories/kapas'))
        finally:
            if home is None: os.environ.pop('FLOW_HOME')
            else: os.environ['FLOW_HOME'] = home

    def test_audio_chain_ends_in_explicit_stereo_layout(self):
        # ffmpeg 5.1 (Debian, the server) cannot negotiate a layout after loudnorm -> aac
        g = filter_graph([6.0, 6.0], 0.3, total=11.7)
        audio = g.split(';')[-1]
        self.assertTrue(audio.endswith('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]'), audio)

if __name__ == '__main__':
    unittest.main()
