"""E4: `shot.transition` is raw text in a plan; only the xfade names we allow may reach the ffmpeg filter graph."""
import json
import os
import subprocess
import unittest

import assemble
from assemble import filter_graph
from test_assemble_closing import graphs_of

EVIL = ["fade:duration=0.3:offset=0,sendcmd=f=/etc/hostname,xfade=transition=fade", 'fade;[0:v]movie=/etc/passwd[x]', 'fade,scale=1:1', ' fade', 'FADE',
        '', 'custom', "fade'", 'fade\n', None, 7, ['fade'], {'a': 1}]


class Guard(unittest.TestCase):
    def test_the_list_exists_and_has_the_common_names(self):
        for name in ('fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'slideup', 'circleopen', 'zoomin'):
            self.assertIn(name, assemble.XFADE_TRANSITIONS)
        self.assertNotIn('custom', assemble.XFADE_TRANSITIONS)

    def test_a_filter_graph_never_carries_a_name_outside_the_list(self):
        for bad in EVIL:
            with self.subTest(bad=bad):
                g = filter_graph([5.0, 5.0], 0.3, transitions=[bad], streams='v', total=9.7)
                self.assertIn('xfade=transition=fade:duration=0.3', g)
                for danger in ('sendcmd', 'movie', '/etc', 'scale=1:1'):
                    self.assertNotIn(danger, g)

    def test_an_allowed_name_goes_through_untouched(self):
        self.assertIn('xfade=transition=fadeblack:duration=0.3', filter_graph([5.0, 5.0], 0.3, transitions=['fadeblack'], streams='v'))

    def test_the_plan_is_guarded_too_and_the_fix_is_visible_in_the_warnings(self):
        for bad in EVIL:
            with self.subTest(bad=bad):
                plan = {'slug': 'final', 'crossfade': 0.3, 'edit': {}, 'shots': [{'id': 's0'}, {'id': 's1', 'transition': bad}]}
                v, a, _ = graphs_of(plan, 0)
                self.assertIn('xfade=transition=fade:duration=0.3', v)
                self.assertNotIn('sendcmd', v)

    def test_every_allowed_name_is_a_real_xfade_transition_on_this_ffmpeg(self):
        for name in sorted(assemble.XFADE_TRANSITIONS):
            with self.subTest(name=name):
                r = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24:d=1',
                                    '-filter_complex', f'[0][1]xfade=transition={name}:duration=0.3:offset=0.6', '-f', 'null', '-'], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr[-200:])


if __name__ == '__main__':
    unittest.main()
