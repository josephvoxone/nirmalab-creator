"""Plans made before fadeIn / beatCuts / the closing fade existed assemble EXACTLY as before.

old_graphs.json was captured from assemble.py at 58b44cc by fixtures/golden_cases.py; these tests compare the current code
with that frozen file, string for string (the filter graph is the whole of what ffmpeg is told to do).
"""
import json
import os
import unittest

import assemble
from fixtures import golden_cases as G

FROZEN = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'old_graphs.json')))


class OldPlansAreIdentical(unittest.TestCase):
    def test_every_filter_graph_case_is_the_same_string(self):
        for name, case in FROZEN['filter'].items():
            with self.subTest(case=name):
                self.assertEqual(assemble.filter_graph(**case['kwargs']), case['graph'])

    def test_main_hands_ffmpeg_the_same_two_graphs_for_old_plans(self):
        for name, graphs in FROZEN['main'].items():
            with self.subTest(plan=name):
                self.assertEqual(len(graphs), 2)
                self.assertEqual(G.capture(name, None), graphs)

    def test_the_frozen_file_is_not_trivial(self):
        self.assertGreaterEqual(len(FROZEN['filter']), 13)
        self.assertTrue(any('fade=t=in:st=0:d=0.8' in c['graph'] for c in FROZEN['filter'].values()))
        self.assertTrue(any('afade=t=in:st=0:d=0.6' in c['graph'] for c in FROZEN['filter'].values()))


if __name__ == '__main__':
    unittest.main()
