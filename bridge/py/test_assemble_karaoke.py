"""Karaoke subtitles: the word being spoken is highlighted, timed from the dub's own word timings."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from assemble import ass_document, karaoke_cues, karaoke_events, words_match_text, shot_starts, SUNG, UNSUNG, KARAOKE_PRE, KARAOKE_POST

W = lambda *a: [(w, s, e) for w, s, e in a]


class Cues(unittest.TestCase):
    def test_never_more_than_three_words_in_one_cue(self):
        words = W(*[(f'kata{i}', i * .3, i * .3 + .25) for i in range(15)])
        self.assertTrue(all(len(c) <= 3 for c in karaoke_cues(words)))
        self.assertEqual([w[0] for c in karaoke_cues(words) for w in c], [w[0] for w in words], 'no word lost, none reordered')

    def test_chunks_are_balanced_so_no_cue_is_a_lonely_word(self):
        sizes = lambda n: [len(c) for c in karaoke_cues(W(*[(f'k{i}', i * .3, i * .3 + .25) for i in range(n)]))]
        self.assertEqual(sizes(3), [3])
        self.assertEqual(sizes(4), [2, 2])
        self.assertEqual(sizes(5), [3, 2])
        self.assertEqual(sizes(6), [3, 3])
        self.assertEqual(sizes(7), [3, 2, 2])
        self.assertEqual(sizes(1), [1])

    def test_a_sentence_end_always_breaks_the_cue(self):
        words = W(('Dia', 0, .3), ('diam.', .35, .8), ('Aku', 1.0, 1.2), ('menoleh,', 1.25, 1.8), ('dan', 1.85, 2.0), ('mengerti.', 2.05, 2.6))
        self.assertEqual([[w[0] for w in c] for c in karaoke_cues(words)],
                         [['Dia', 'diam.'], ['Aku', 'menoleh,'], ['dan', 'mengerti.']])

    def test_a_comma_breaks_but_never_leaves_a_one_word_cue(self):
        words = W(('Tapi,', 0, .3), ('ia', .35, .5), ('tetap', .55, .9), ('masuk.', .95, 1.4))
        self.assertEqual([[w[0] for w in c] for c in karaoke_cues(words)], [['Tapi,', 'ia'], ['tetap', 'masuk.']])

    def test_a_long_pause_between_words_starts_a_new_cue(self):
        words = W(('satu', 0, .3), ('dua', .35, .6), ('tiga', 3.0, 3.3))   # three words would fit one cue; the silence is what splits them
        self.assertEqual([[w[0] for w in c] for c in karaoke_cues(words)], [['satu', 'dua'], ['tiga']])

    def test_no_words_no_cues(self):
        self.assertEqual(karaoke_cues([]), [])


def plain(text):
    import re
    return re.sub(r'\{[^}]*\}', '', text)


class Events(unittest.TestCase):
    def test_one_line_per_word_and_only_that_word_is_amber(self):
        words = W(('Halo', 0.0, 0.4), ('dunia', 0.5, 1.0), ('hari', 1.1, 1.5))
        evs = karaoke_events(10.0, 1.0, words)
        self.assertEqual(len(evs), 3)
        for k, (start, end, text, raw) in enumerate(evs):
            self.assertTrue(raw)
            self.assertEqual(plain(text), 'Halo dunia hari', 'the whole cue stays on screen in every line')
            parts = text.split(' ')
            for j, part in enumerate(parts):
                self.assertEqual(SUNG in part, j == k, f'line {k}: word {j} {part!r}')
                self.assertEqual(UNSUNG in part, j != k)

    def test_the_cue_shows_a_beat_before_its_first_word_and_the_amber_hands_over_without_a_gap(self):
        words = W(('Halo', 0.0, 0.4), ('dunia', 0.5, 1.0), ('hari', 1.1, 1.5))
        evs = karaoke_events(10.0, 1.0, words)
        self.assertAlmostEqual(evs[0][0], 10.0 - KARAOKE_PRE, places=2)
        self.assertAlmostEqual(evs[0][1], evs[1][0], places=3)
        self.assertAlmostEqual(evs[1][1], evs[2][0], places=3)
        self.assertAlmostEqual(evs[1][0], 10.5, places=2)                      # 'dunia' lights exactly when it is spoken
        self.assertAlmostEqual(evs[2][1], 10.0 + 1.5 + KARAOKE_POST, places=2)  # the last word lingers a moment

    def test_the_fade_belongs_to_the_cue_not_to_each_word(self):
        evs = karaoke_events(0.0, 1.0, W(('a', 0, .3), ('b', .4, .7), ('c', .8, 1.1)))
        self.assertTrue(evs[0][2].startswith('{\\fad(120,0)}'), evs[0][2])
        self.assertTrue(evs[1][2].startswith('{\\fad(0,0)}'), 'no flicker while the light moves from word to word')
        self.assertTrue(evs[2][2].startswith('{\\fad(0,200)}'), evs[2][2])
        (only,) = karaoke_events(0.0, 1.0, W(('a', 0, .3)))
        self.assertTrue(only[2].startswith('{\\fad(120,200)}'), only[2])

    def test_times_follow_the_tempo_of_the_sped_up_dub(self):
        evs = karaoke_events(10.3, 1.25, W(('Halo', 0.0, 0.4), ('dunia.', 0.5, 1.0)))
        self.assertAlmostEqual(evs[1][0], 10.3 + 0.5 / 1.25, places=2)
        self.assertAlmostEqual(evs[1][1], 10.3 + 1.0 / 1.25 + KARAOKE_POST, places=2)

    def test_a_cue_is_replaced_by_the_next_one_never_stacked(self):
        words = W(('Dia', 0, .3), ('diam.', .35, .8), ('Aku', .9, 1.2), ('menoleh.', 1.25, 1.8))
        evs = karaoke_events(0.0, 1.0, words)
        self.assertEqual(plain(evs[0][2]), 'Dia diam.')
        self.assertEqual(plain(evs[-1][2]), 'Aku menoleh.')
        for a, b in zip(evs, evs[1:]):
            self.assertLessEqual(a[1], b[0] + 1e-6)

    def test_words_that_start_after_the_window_are_dropped_when_the_dub_is_cut(self):
        words = W(('satu', 0, .5), ('dua', .6, 1.1), ('tiga', 5.0, 5.5))
        evs = karaoke_events(0.0, 1.25, words, window=2.0)
        joined = ' '.join(plain(e[2]) for e in evs)
        self.assertIn('dua', joined)
        self.assertNotIn('tiga', joined)

    def test_braces_and_newlines_in_a_word_cannot_inject_ass_tags(self):
        evs = karaoke_events(0.0, 1.0, W(('{\\an1}hai', 0, .5), ('a\nb', .6, 1.0)))
        for e in evs:
            self.assertNotIn('{\\an1}', e[2])
            self.assertNotIn('\n', e[2])
            self.assertEqual(plain(e[2]), '(an1)hai a b')


class Match(unittest.TestCase):
    def test_same_words_match_regardless_of_case_and_punctuation(self):
        words = W(('Tuhan', 0, .3), ('berkata,', .4, .8), ('“Terima', .9, 1.2), ('kasih.”', 1.25, 1.6))
        self.assertTrue(words_match_text(words, 'Tuhan berkata, "Terima kasih."'))

    def test_a_caption_that_says_something_else_does_not_match(self):
        self.assertFalse(words_match_text(W(('Halo', 0, .3)), 'Selamat tinggal'))
        self.assertFalse(words_match_text([], 'Halo'))


class Ass(unittest.TestCase):
    def test_start_times_of_shots_follow_the_crossfades(self):
        self.assertEqual(shot_starts([4.0, 4.0, 4.0], 0.3), [0.0, 3.7, 7.4])

    def test_karaoke_lines_keep_their_colour_tags_unescaped(self):
        doc = ass_document([(1.0, 3.0, '{\\1c%s}Halo {\\1c%s}dunia.' % (SUNG, UNSUNG), True)], 720, 1280, style='tulisan-tangan')
        line = [l for l in doc.splitlines() if l.startswith('Dialogue')][0]
        self.assertIn('{\\1c%s}Halo' % SUNG, line)
        self.assertNotIn('(\\1c', line, 'the tags must not be escaped like user text')

    def test_the_karaoke_style_is_white_with_a_heavy_outline_and_used_by_its_lines(self):
        doc = ass_document([(1.0, 3.0, 'Halo', True)], 720, 1280, style='tulisan-tangan')
        style = [l for l in doc.splitlines() if l.startswith('Style: Karaoke')][0].split(',')
        self.assertEqual(style[3], UNSUNG, 'unspoken words are the base colour; the spoken one is an override')
        self.assertGreaterEqual(int(style[16]), 4, 'a heavy outline keeps the letters readable on a pale sky')
        dialogue = [l for l in doc.splitlines() if l.startswith('Dialogue')][0]
        self.assertIn(',Karaoke,', dialogue)

    def test_plain_events_are_still_escaped(self):
        doc = ass_document([(1.0, 3.0, 'a {b} c')], 720, 1280)
        self.assertIn('a (b) c', doc)


def amber_stats(frame_png):
    """(pixel count, mean x) of the amber (255, 190, 40) letters in a frame."""
    from PIL import Image
    im = Image.open(frame_png).convert('RGB')
    w = im.size[0]
    xs = [i % w for i, (r, g, b) in enumerate(im.getdata()) if r > 230 and 170 < g < 215 and b < 120]
    return (len(xs), sum(xs) / len(xs) if xs else 0.0)


def gold_pixels(frame_png):
    return amber_stats(frame_png)[0]


def white_pixels(frame_png):
    from PIL import Image
    im = Image.open(frame_png).convert('RGB')
    return sum(1 for r, g, b in im.getdata() if r > 235 and g > 225 and b > 205)   # the warm white (250, 244, 234), not the amber


class EndToEnd(unittest.TestCase):
    def test_three_words_at_a_time_and_only_the_word_being_spoken_is_amber(self):
        d = tempfile.mkdtemp(prefix='asm-karaoke-')
        try:
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x223344:s=720x1280:r=24:d=8',
                            '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                            '-c:a', 'aac', os.path.join(d, 's0.mp4')], check=True)
            dub = os.path.join(d, 'dub.mp3')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=5.5', '-c:a', 'libmp3lame', dub], check=True)
            text = 'satu dua tiga empat lima enam'
            # in the file: 1.2 s of quiet, then six words; on the film's clock everything is 0.3 s later (the voice lead)
            words = [['satu', 1.2, 1.8], ['dua', 1.9, 2.5], ['tiga', 2.6, 3.2], ['empat', 3.3, 3.9], ['lima', 4.0, 4.6], ['enam', 4.7, 5.2]]
            plan = {'slug': 'final', 'crossfade': 0.3,
                    'shots': [{'id': 's0', 'narration': text, 'dub': {'file': dub, 'seconds': 5.5, 'words': words}}],
                    'edit': {'subtitles': True, 'subtitleStyle': 'tulisan-tangan', 'subtitleSize': 1.2}}
            json.dump(plan, open(os.path.join(d, 'assemble.json'), 'w'))
            out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assemble.py'), d], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            final = os.path.join(d, 'final.mp4')
            def frame(t):
                p = os.path.join(d, f'f{t}.png')
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(t), '-i', final, '-frames:v', '1', p], check=True)
                return p
            satu, dua, tiga = (amber_stats(frame(t)) for t in (1.8, 2.5, 3.2))   # words 1-3 of the first cue
            for name, st in (('satu', satu), ('dua', dua), ('tiga', tiga)):
                self.assertGreater(st[0], 100, f'{name} must be amber while it is spoken: {st}')
            self.assertLess(satu[1], dua[1] - 40, f'the amber moves right with the voice: {satu} -> {dua}')
            self.assertLess(dua[1], tiga[1] - 40, f'the amber moves right with the voice: {dua} -> {tiga}')
            self.assertLess(max(satu[0], dua[0], tiga[0]), 1.8 * min(satu[0], dua[0], tiga[0]),
                            'one word at a time: the amber must not accumulate like a sweep')
            self.assertGreater(white_pixels(frame(3.2)), 200, 'the other words of the cue are still on screen, in white')
            lima = amber_stats(frame(4.6))                                          # second cue: empat lima enam
            self.assertGreater(lima[0], 100)
            self.assertEqual(gold_pixels(frame(1.0)) + white_pixels(frame(1.0)) < 5, True, 'nothing is shown before the first word')
            self.assertLess(white_pixels(frame(6.4)), 5, 'and the caption is gone once the words are spoken')
            self.assertEqual(gold_pixels(frame(6.4)), 0)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_a_caption_that_is_not_what_the_voice_says_is_not_highlighted(self):
        d = tempfile.mkdtemp(prefix='asm-karaoke-')
        try:
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x223344:s=720x1280:r=24:d=6',
                            '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                            '-c:a', 'aac', os.path.join(d, 's0.mp4')], check=True)
            dub = os.path.join(d, 'dub.mp3')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-c:a', 'libmp3lame', dub], check=True)
            words = [['satu', 0.0, 0.6], ['dua', 0.7, 1.3], ['tiga', 1.4, 2.0]]
            with open(os.path.join(d, 'assemble.json'), 'w') as f:
                json.dump({'slug': 'final', 'crossfade': 0.3, 'shots': [{'id': 's0', 'narration': 'kata lain sama sekali', 'dub': {'file': dub, 'seconds': 2.0, 'words': words}}],
                           'edit': {'subtitles': True, 'subtitleStyle': 'tulisan-tangan'}}, f)
            out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assemble.py'), d], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            p = os.path.join(d, 'f.png')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '2', '-i', os.path.join(d, 'final.mp4'), '-frames:v', '1', p], check=True)
            self.assertGreater(white_pixels(p), 50, 'the caption is still shown')
            self.assertEqual(gold_pixels(p), 0, 'but never swept: the words on screen are not the words spoken')
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_a_shot_without_word_timings_keeps_the_plain_caption_for_the_whole_shot(self):
        d = tempfile.mkdtemp(prefix='asm-karaoke-')
        try:
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x223344:s=720x1280:r=24:d=4',
                            '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                            '-c:a', 'aac', os.path.join(d, 's0.mp4')], check=True)
            json.dump({'slug': 'final', 'crossfade': 0.3, 'shots': [{'id': 's0', 'narration': 'tanpa waktu kata'}],
                       'edit': {'subtitles': True, 'subtitleStyle': 'tulisan-tangan'}}, open(os.path.join(d, 'assemble.json'), 'w'))
            out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assemble.py'), d], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            p = os.path.join(d, 'f.png')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '2', '-i', os.path.join(d, 'final.mp4'), '-frames:v', '1', p], check=True)
            self.assertGreater(white_pixels(p), 50, 'the caption is shown')
            self.assertEqual(gold_pixels(p), 0, 'and nothing is highlighted')
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
