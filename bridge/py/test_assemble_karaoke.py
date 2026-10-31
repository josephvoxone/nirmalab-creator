"""Karaoke subtitles: the word being spoken is highlighted, timed from the dub's own word timings."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from assemble import ass_document, karaoke_cues, karaoke_events, words_match_text, shot_starts

W = lambda *a: [(w, s, e) for w, s, e in a]


class Cues(unittest.TestCase):
    def test_a_short_sentence_is_one_cue(self):
        words = W(('Tuhan', 0, .4), ('menunjukkan', .45, 1.0), ('dua', 1.05, 1.3), ('jalan.', 1.35, 1.8))
        self.assertEqual([[w[0] for w in c] for c in karaoke_cues(words)], [['Tuhan', 'menunjukkan', 'dua', 'jalan.']])

    def test_a_long_line_splits_at_the_sentence_end_first(self):
        words = W(('Dia', 0, .3), ('diam.', .35, .8), ('Aku', 1.0, 1.2), ('menoleh,', 1.25, 1.8), ('dan', 1.85, 2.0), ('mengerti.', 2.05, 2.6))
        cues = [[w[0] for w in c] for c in karaoke_cues(words)]
        self.assertEqual(cues[0], ['Dia', 'diam.'])
        self.assertEqual(cues[1][0], 'Aku')

    def test_never_more_than_six_words_or_a_wall_of_letters_in_one_cue(self):
        words = W(*[(f'kata{i}', i * .3, i * .3 + .25) for i in range(15)])
        for c in karaoke_cues(words):
            self.assertLessEqual(len(c), 6)
        long_words = W(*[('menyelamatkan', i * .5, i * .5 + .4) for i in range(5)])
        for c in karaoke_cues(long_words):
            self.assertLessEqual(len(' '.join(w[0] for w in c)), 34)

    def test_a_long_pause_between_words_starts_a_new_cue(self):
        words = W(('satu', 0, .3), ('dua', .35, .6), ('tiga', 3.0, 3.3))
        self.assertEqual(len(karaoke_cues(words)), 2)

    def test_no_words_no_cues(self):
        self.assertEqual(karaoke_cues([]), [])


class Events(unittest.TestCase):
    def test_times_are_on_the_output_clock_and_follow_the_tempo(self):
        words = W(('Halo', 0.0, 0.4), ('dunia.', 0.5, 1.0))
        (start, end, text, raw), = karaoke_events(10.3, 1.25, words)
        self.assertTrue(raw)
        self.assertAlmostEqual(start, 10.3 - 0.15, places=2)               # shows a beat before the first word
        self.assertAlmostEqual(end, 10.3 + 1.0 / 1.25 + 0.35, places=2)    # and lingers after the last
        # centiseconds per word on the sped-up clock: (0.5-0.0)/1.25 and (1.0-0.5)/1.25
        self.assertIn('{\\kf40}Halo', text)
        self.assertIn('{\\kf40}dunia.', text)

    def test_the_cue_opens_with_the_lead_in_so_the_sweep_starts_with_the_first_word(self):
        (start, end, text, raw), = karaoke_events(5.0, 1.0, W(('a', 0, .5)))
        self.assertTrue(text.startswith('{\\k15}'), text)

    def test_two_cues_do_not_overlap(self):
        words = W(('Dia', 0, .3), ('diam.', .35, .8), ('Aku', .9, 1.2), ('menoleh.', 1.25, 1.8))
        evs = karaoke_events(0.0, 1.0, words)
        self.assertEqual(len(evs), 2)
        self.assertLessEqual(evs[0][1], evs[1][0] + 1e-6)

    def test_words_that_start_after_the_window_are_dropped_when_the_dub_is_cut(self):
        words = W(('satu', 0, .5), ('dua', .6, 1.1), ('tiga', 5.0, 5.5))
        evs = karaoke_events(0.0, 1.25, words, window=2.0)
        joined = ' '.join(e[2] for e in evs)
        self.assertIn('dua', joined)
        self.assertNotIn('tiga', joined)

    def test_braces_and_newlines_in_a_word_cannot_inject_ass_tags(self):
        evs = karaoke_events(0.0, 1.0, W(('{\\an1}hai', 0, .5), ('a\nb', .6, 1.0)))
        text = evs[0][2]
        self.assertNotIn('{\\an1}', text)
        self.assertNotIn('\n', text)


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

    def test_karaoke_cues_become_dialogue_lines_with_the_sweep_tags_untouched(self):
        doc = ass_document([(1.0, 3.0, '{\\k15}{\\kf40}Halo {\\kf40}dunia.', True)], 720, 1280, style='tulisan-tangan')
        line = [l for l in doc.splitlines() if l.startswith('Dialogue')][0]
        self.assertIn('{\\kf40}Halo', line)
        self.assertNotIn('(\\kf40)', line, 'the tags must not be escaped like user text')

    def test_the_sung_colour_differs_from_the_unsung_one_and_the_outline_is_heavy(self):
        doc = ass_document([(1.0, 3.0, '{\\kf40}Halo', True)], 720, 1280, style='tulisan-tangan')
        style = [l for l in doc.splitlines() if l.startswith('Style: Karaoke')][0].split(',')
        self.assertNotEqual(style[3], style[4], 'primary (sung) and secondary (unsung) colours must differ for a karaoke sweep')
        plain = [l for l in doc.splitlines() if l.startswith('Style: Default')][0].split(',')
        self.assertEqual(plain[3], plain[4], 'plain captions keep a single colour')
        self.assertGreaterEqual(int(style[16]), 4, 'a heavy outline keeps the letters readable on a pale sky')
        dialogue = [l for l in doc.splitlines() if l.startswith('Dialogue')][0]
        self.assertIn(',Karaoke,', dialogue)

    def test_plain_events_are_still_escaped(self):
        doc = ass_document([(1.0, 3.0, 'a {b} c')], 720, 1280)
        self.assertIn('a (b) c', doc)


def gold_pixels(frame_png):
    from PIL import Image
    im = Image.open(frame_png).convert('RGB')
    return sum(1 for r, g, b in im.getdata() if r > 230 and 170 < g < 235 and b < 140)


def white_pixels(frame_png):
    from PIL import Image
    im = Image.open(frame_png).convert('RGB')
    return sum(1 for r, g, b in im.getdata() if r > 235 and g > 225 and b > 205)   # the warm white (250, 244, 234), not the gold (255, 214, 90)


class EndToEnd(unittest.TestCase):
    def test_the_sweep_turns_the_spoken_words_gold_while_the_rest_stay_white(self):
        d = tempfile.mkdtemp(prefix='asm-karaoke-')
        try:
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x223344:s=720x1280:r=24:d=6',
                            '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                            '-c:a', 'aac', os.path.join(d, 's0.mp4')], check=True)
            dub = os.path.join(d, 'dub.mp3')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-c:a', 'libmp3lame', dub], check=True)
            text = 'satu dua tiga empat lima enam'
            words = [['satu', 0.0, 0.6], ['dua', 0.7, 1.3], ['tiga', 1.4, 2.0], ['empat', 2.1, 2.7], ['lima', 2.8, 3.4], ['enam', 3.5, 4.0]]
            plan = {'slug': 'final', 'crossfade': 0.3,
                    'shots': [{'id': 's0', 'narration': text, 'dub': {'file': dub, 'seconds': 4.0, 'words': words}}],
                    'edit': {'subtitles': True, 'subtitleStyle': 'tulisan-tangan', 'subtitleSize': 1.2}}
            json.dump(plan, open(os.path.join(d, 'assemble.json'), 'w'))
            out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assemble.py'), d], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            final = os.path.join(d, 'final.mp4')
            def frame(t):
                p = os.path.join(d, f'f{t}.png')
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(t), '-i', final, '-frames:v', '1', p], check=True)
                return p
            early, mid, late = frame(1.2), frame(2.4), frame(4.1)   # the voice starts at 0.3 s; the film itself fades in over the first ~second
            self.assertEqual(gold_pixels(early) < gold_pixels(mid) < gold_pixels(late), True,
                             f'the gold must grow as the words are spoken: {[gold_pixels(p) for p in (early, mid, late)]}')
            self.assertGreater(white_pixels(early), 2 * white_pixels(late), 'unspoken words stay white, and almost none are left at the end')
            before = frame(0.05)
            self.assertEqual(gold_pixels(before), 0)
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
