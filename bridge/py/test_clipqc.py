"""TDD spec for clipqc.  Run:  PATH=<ffmpeg dir>:$PATH /usr/bin/python3 -m unittest -v test_clipqc
Every defect found in the Lentera audit has a synthetic twin in fixtures.py; each test names the defect it guards."""
import json
import os
import resource
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clipqc
import fixtures_qc as fx

TMP = tempfile.mkdtemp(prefix='clipqc-')
_cache = {}


def clip(name, **kw):
    key = (name, tuple(sorted(kw.items())))
    if key not in _cache:
        _cache[key] = getattr(fx, name)(os.path.join(TMP, f'{name}-{abs(hash(key))}.mp4'), **kw)
    return _cache[key]


def codes(v):
    return {r.code for r in v.reasons}


class CameraTests(unittest.TestCase):
    def test_slow_push_in_is_measured_and_not_flagged(self):          # Lentera 4/8/12: strong, clean push-ins
        v = clipqc.check_clip(clip('push_in', z1=1.10), {'move': 'push-in'})
        self.assertAlmostEqual(v.features['zoom_total'], 1.10, delta=0.03)
        self.assertEqual(v.status, 'ok', v.reasons)

    def test_unrequested_pull_back_is_flagged(self):                  # Lentera 11 'rise' = -15 %; the known 'camera drifts back' defect
        v = clipqc.check_clip(clip('zoom_out', z1=0.80), {'move': 'static'})
        self.assertAlmostEqual(v.features['zoom_total'], 0.80, delta=0.04)
        self.assertIn('pullback', codes(v))

    def test_requested_pull_back_is_allowed(self):                    # Lentera 19 pull-back
        v = clipqc.check_clip(clip('zoom_out', z1=0.80), {'move': 'pull-back'})
        self.assertNotIn('pullback', codes(v))

    def test_scale_jump_between_two_frames_is_flagged(self):          # 'loncatan'
        v = clipqc.check_clip(clip('zoom_jump', at=3.0, jump=1.18), {'move': 'static'})
        self.assertIn('zoom_jump', codes(v))
        self.assertEqual(v.status, 'fail')

    def test_a_smooth_ramp_is_not_a_jump(self):
        v = clipqc.check_clip(clip('push_in', z1=1.35), {'move': 'push-in'})
        self.assertNotIn('zoom_jump', codes(v))


class BorderTests(unittest.TestCase):
    def test_paper_border_growing_in_is_a_fail_with_onset_time(self):  # Lentera 10/13/15/19
        v = clipqc.check_clip(clip('border_growth', onset=3.0, inset=0.06), {'move': 'static'})
        self.assertIn('border', codes(v))
        r = [r for r in v.reasons if r.code == 'border'][0]
        self.assertEqual(r.severity, 'fail')
        self.assertAlmostEqual(r.at_s, 3.2, delta=0.7)

    def test_border_gives_a_free_fix_not_a_re_render(self):
        v = clipqc.check_clip(clip('border_growth', onset=4.5, inset=0.06), {'move': 'static'})
        self.assertTrue('trim' in v.suggest or 'zoom' in v.suggest, v.suggest)
        if 'trim' in v.suggest:
            self.assertLess(v.suggest['trim']['out'], 4.5)

    def test_border_is_only_info_outside_painterly_looks(self):        # photoreal clips legitimately change their edges
        v = clipqc.check_clip(clip('border_growth', onset=3.0, inset=0.06), {'move': 'static', 'look_family': 'film-real'})
        sev = {r.code: r.severity for r in v.reasons}
        self.assertEqual(sev.get('border'), 'info')

    def test_clean_clip_has_no_border(self):
        self.assertNotIn('border', codes(clipqc.check_clip(clip('lively_static'), {'move': 'static'})))


class SceneChangeTests(unittest.TestCase):
    def test_cross_dissolve_to_another_picture_fails(self):           # Lentera 3/9/16/17/21
        v = clipqc.check_clip(clip('dissolve', at=2.5, length=0.8), {'move': 'static'})
        self.assertIn('dissolve', codes(v))
        self.assertEqual(v.status, 'fail')
        self.assertAlmostEqual([r for r in v.reasons if r.code == 'dissolve'][0].at_s, 2.9, delta=0.5)

    def test_hard_cut_fails(self):
        v = clipqc.check_clip(clip('hard_cut', at=2.5), {'move': 'static'})
        self.assertIn('hard_cut', codes(v))

    def test_dissolve_offers_a_trim_with_at_least_3_s_left(self):     # shot 9: trim.in after the swap
        v = clipqc.check_clip(clip('dissolve', at=1.2, length=0.6), {'move': 'static'})
        t = v.suggest.get('trim', {})
        self.assertTrue(t, v.suggest)
        self.assertGreaterEqual(6.0 - t.get('in', 0.0) if 'in' in t else t['out'], 3.0)

    def test_continuous_motion_is_not_a_dissolve(self):               # Lentera 18/20
        for name, kw in (('lively_static', {}), ('push_in', {'z1': 1.20})):
            v = clipqc.check_clip(clip(name, **kw), {'move': 'static' if name == 'lively_static' else 'push-in'})
            self.assertNotIn('dissolve', codes(v), name)
            self.assertNotIn('hard_cut', codes(v), name)


class StillnessTests(unittest.TestCase):
    def test_frozen_tail_is_flagged_with_its_start(self):
        v = clipqc.check_clip(clip('freeze_tail', freeze_from=2.0), {'move': 'push-in'})
        r = [r for r in v.reasons if r.code == 'freeze_tail']
        self.assertTrue(r, v.reasons)
        self.assertAlmostEqual(r[0].at_s, 2.0, delta=0.3)
        self.assertLess(v.suggest.get('trim', {'out': 0})['out'], 2.1) if 'trim' in v.suggest else None

    def test_a_still_picture_is_under_animated(self):                 # Lentera 7/14/15
        self.assertIn('under_animated', codes(clipqc.check_clip(clip('frozen_still'), {'move': 'static'})))

    def test_a_locked_camera_with_a_lively_character_is_fine(self):   # must not punish static shots that really act
        v = clipqc.check_clip(clip('lively_static'), {'move': 'static'})
        self.assertEqual(v.status, 'ok', v.reasons)


class KeyframeTests(unittest.TestCase):
    def test_first_frame_matches_its_keyframe(self):
        kf = fx.keyframe_png(os.path.join(TMP, 'kf-same.png'), seed=1, same=True)
        v = clipqc.check_clip(clip('push_in', z1=1.10), {'move': 'push-in'}, keyframe=kf)
        self.assertNotIn('keyframe_mismatch', codes(v))

    def test_wrong_start_image_is_a_fail(self):                       # Lentera 9: the clip opened on another scene
        kf = fx.keyframe_png(os.path.join(TMP, 'kf-other.png'), seed=1, same=False)
        v = clipqc.check_clip(clip('push_in', z1=1.10), {'move': 'push-in'}, keyframe=kf)
        self.assertIn('keyframe_mismatch', codes(v))
        self.assertEqual(v.status, 'fail')


class KnownGapTests(unittest.TestCase):
    @unittest.expectedFailure
    def test_small_region_redraw_hood_pop_needs_the_vision_audit(self):
        """Documented gap: BAYU's hood going up in one frame is ~1 % of the picture; frame statistics cannot see it.
        When a deterministic character tracker exists this test should flip to green (remove expectedFailure)."""
        v = clipqc.check_clip(clip('hood_pop', at=2.0), {'move': 'static'})
        self.assertNotEqual(v.status, 'ok')


class BudgetTests(unittest.TestCase):
    def test_6s_clip_under_5s_and_small_memory(self):
        p = clip('push_in', z1=1.1)
        code = ('import sys,time,resource,json; sys.path.insert(0,%r); import clipqc; t=time.time(); '
                'v=clipqc.check_clip(%r,{"move":"push-in"}); print(json.dumps([time.time()-t, resource.getrusage(resource.RUSAGE_SELF).ru_maxrss]))'
                % (os.path.dirname(os.path.abspath(__file__)), p))
        out = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1]
        import json
        secs, rss = json.loads(out)
        rss_mb = rss / (1024 * 1024 if sys.platform == 'darwin' else 1024)
        self.assertLess(secs, 5.0)
        # Measured in the production image (Debian ffmpeg 5.1, Python 3.11, numpy 1.24): real Lentera clips 1.0-1.6 s and ~200 MB
        # (python 115 + ffmpeg 85); this noisy synthetic worst case up to ~500 MB. One check at a time on a 16 GB host, killed at 20 s.
        self.assertLess(rss_mb, 600)


HERE = os.path.dirname(os.path.abspath(__file__))


def cli(*args):
    return subprocess.run([sys.executable, os.path.join(HERE, 'clipqc.py'), *args], capture_output=True, text=True)


def lavfi_clip(name, source, seconds, size='64x112'):
    p = os.path.join(TMP, name)
    subprocess.run([clipqc.ffmpeg_bin(), '-v', 'error', '-y', '-f', 'lavfi', '-i', f"{source}{':' if '=' in source else '='}s={size}:r=24:d={seconds}",
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p], check=True)
    return p


class CliContractTests(unittest.TestCase):
    """The server (media/motion-qc.ts) runs `clipqc.py <clip> --move .. --look .. --keyframe .. --zoom ..` and reads one JSON object."""

    def test_cli_takes_the_look_family_and_prints_one_json_verdict(self):
        r = cli(clip('border_growth', onset=3.0, inset=0.06), '--move', 'static', '--look', 'film-real')
        self.assertEqual(r.returncode, 0, r.stderr)
        v = json.loads(r.stdout)
        self.assertEqual({'score', 'status', 'reasons', 'suggest', 'features'} - set(v), set())
        self.assertEqual({x['code']: x['severity'] for x in v['reasons']}.get('border'), 'info')   # not painterly -> info only

    def test_cli_default_look_is_painterly(self):
        v = json.loads(cli(clip('border_growth', onset=3.0, inset=0.06), '--move', 'static').stdout)
        self.assertEqual({x['code']: x['severity'] for x in v['reasons']}.get('border'), 'fail')

    def test_cli_on_an_unreadable_file_exits_2_with_a_json_error(self):
        bad = os.path.join(TMP, 'not-a-video.mp4')
        open(bad, 'wb').write(b'\x00' * 4096)
        r = cli(bad, '--move', 'static')
        self.assertEqual(r.returncode, 2)
        self.assertIn('error', json.loads(r.stdout))

    def test_cli_on_a_missing_file_exits_2_with_a_json_error(self):
        r = cli(os.path.join(TMP, 'nope.mp4'))
        self.assertEqual(r.returncode, 2)
        self.assertIn('error', json.loads(r.stdout))


class AssemblyZoomTests(unittest.TestCase):
    def test_a_border_with_no_clean_3_s_gets_a_crop_suggestion(self):
        v = clipqc.check_clip(clip('border_growth', onset=1.5, inset=0.06), {'move': 'static'})
        self.assertEqual(v.suggest.get('zoom'), 1.12, v.suggest)

    def test_no_crop_is_suggested_when_the_assembler_already_zooms_that_much(self):   # shot.zoom 1.12+ is already applied
        v = clipqc.check_clip(clip('border_growth', onset=1.5, inset=0.06), {'move': 'static'}, zoom_assembly=1.2)
        self.assertNotIn('zoom', v.suggest)
        self.assertIn('border', codes(v))     # the reason stays: the shot may still need a new clip


class RobustnessTests(unittest.TestCase):
    def test_a_broken_keyframe_file_skips_the_keyframe_check_instead_of_failing_the_clip(self):
        bad = os.path.join(TMP, 'kf-broken.png')
        open(bad, 'wb').write(b'not a png')
        v = clipqc.check_clip(clip('push_in', z1=1.10), {'move': 'push-in'}, keyframe=bad)
        self.assertNotIn('keyframe_mismatch', codes(v))
        self.assertEqual(v.status, 'ok', v.reasons)

    def test_a_missing_keyframe_file_is_ignored(self):
        v = clipqc.check_clip(clip('push_in', z1=1.10), {'move': 'push-in'}, keyframe=os.path.join(TMP, 'gone.png'))
        self.assertNotIn('keyframe_mismatch', codes(v))

    def test_an_absurd_frame_rate_header_is_clamped(self):             # VFR/odd headers must not blow up the frame count
        from unittest import mock
        for header, want in (('90000/1\n', 24.0), ('0/0\n', 24.0), ('30000/1001\n', 30000 / 1001), ('', 24.0)):
            with mock.patch.object(clipqc.subprocess, 'run', return_value=mock.Mock(stdout=header)):
                self.assertAlmostEqual(clipqc.probe_fps('x.mp4'), want, places=3, msg=header)

    def test_a_long_clip_is_only_analysed_up_to_the_cap(self):         # time and memory stay bounded whatever the engine returns
        p = lavfi_clip('long.mp4', 'testsrc2', 40)
        f = clipqc.analyze_clip(p)
        self.assertLessEqual(f.seconds, clipqc.MAX_SECONDS + 0.1)

    def test_an_all_black_clip_gets_a_verdict_not_an_exception(self):
        v = clipqc.check_clip(lavfi_clip('black.mp4', 'color=c=black', 6), {'move': 'static'})
        self.assertIn(v.status, ('warn', 'fail'))
        self.assertIn('under_animated', codes(v))

    def test_a_clip_with_no_video_stream_raises_a_clear_error(self):
        p = os.path.join(TMP, 'audio-only.m4a')
        subprocess.run([clipqc.ffmpeg_bin(), '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=2', p], check=True)
        with self.assertRaises(clipqc.ClipError):
            clipqc.check_clip(p, {'move': 'static'})

    def test_a_clip_shorter_than_a_quarter_second_fails_as_too_short(self):
        v = clipqc.check_clip(lavfi_clip('tiny.mp4', 'testsrc2', 0.2), {'move': 'static'})
        self.assertEqual(v.status, 'fail')
        self.assertIn('too_short', codes(v))


class BenchScriptTests(unittest.TestCase):
    """clipqc_bench.py is what the lead runs in the production image to learn the VPS cost."""

    def run_bench(self, *args):
        return subprocess.run([sys.executable, os.path.join(HERE, 'clipqc_bench.py'), '--runs', '1', *args], capture_output=True, text=True)

    def test_bench_reports_host_versions_time_and_memory_for_a_given_clip(self):
        r = self.run_bench(clip('push_in', z1=1.10))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        rep = json.loads(r.stdout)
        self.assertEqual({'python', 'numpy', 'ffmpeg'} - set(rep['host']), set())
        row = rep['clips'][0]
        self.assertGreater(row['seconds_max'], 0)
        self.assertGreater(row['python_peak_mb'], 10)
        self.assertTrue(rep['within_budget'])

    def test_bench_exits_2_with_a_json_error_when_a_clip_cannot_be_analysed(self):
        r = self.run_bench(os.path.join(TMP, 'nope.mp4'))
        self.assertEqual(r.returncode, 2)
        self.assertIn('error', json.loads(r.stdout))


if __name__ == '__main__':
    unittest.main(verbosity=2)
