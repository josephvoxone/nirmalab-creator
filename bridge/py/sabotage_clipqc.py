"""Prove every guard test of clipqc is sensitive: break ONE line of a temp copy of clipqc.py and require its test to go RED.

    cd bridge/py && PATH=<ffmpeg dir>:$PATH python3 sabotage_clipqc.py     # exit 0 = every sabotage turned its test red
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

here = os.path.dirname(os.path.abspath(__file__))
CASES = [
    ("pullback threshold off", "pullback=0.92", "pullback=0.01", "CameraTests.test_unrequested_pull_back_is_flagged"),
    ("border detector off", "edge_fail=100.0", "edge_fail=1e9", "BorderTests.test_paper_border_growing_in_is_a_fail_with_onset_time"),
    ("exact-blend rule off", "morph_straight=1.06,", "morph_straight=0.5,", "SceneChangeTests.test_cross_dissolve_to_another_picture_fails"),
    ("freeze tail off", "freeze_tail_s=1.0", "freeze_tail_s=99.0", "StillnessTests.test_frozen_tail_is_flagged_with_its_start"),
    ("hard cut off", "cut_gray=0.08", "cut_gray=9.0", "SceneChangeTests.test_hard_cut_fails"),
    ("zoom jump off", "zoom_step=0.05,", "zoom_step=9.0,", "CameraTests.test_scale_jump_between_two_frames_is_flagged"),
    ("keyframe check off", "kf_fail=0.50", "kf_fail=-1.0", "KeyframeTests.test_wrong_start_image_is_a_fail"),
    ("under-animated off", "still_obj=0.0075", "still_obj=-1.0", "StillnessTests.test_a_still_picture_is_under_animated"),
    ("camera ignores the fit quality (slow zoom lost)", "r['res1'] <= r['res0'] + 1e-4", "r['res1'] <= 0.9 * r['res0']", "CameraTests.test_slow_push_in_is_measured_and_not_flagged"),
    ("painterly gate off (border always fail)", "painterly = (intent.get('look_family') or 'painterly') == 'painterly'", "painterly = True", "BorderTests.test_border_is_only_info_outside_painterly_looks"),
    # added in the port
    ("fps clamp off", "return fps if 8.0 <= fps <= 60.0 else 24.0", "return fps", "RobustnessTests.test_an_absurd_frame_rate_header_is_clamped"),
    ("decode cap off", "'-t', str(MAX_SECONDS)", "'-t', '9999'", "RobustnessTests.test_a_long_clip_is_only_analysed_up_to_the_cap"),
    ("broken keyframe not tolerated", "        except Exception:      # unreadable keyframe", "        except ZeroDivisionError:      # unreadable keyframe", "RobustnessTests.test_a_broken_keyframe_file_skips_the_keyframe_check_instead_of_failing_the_clip"),
    ("already-zoomed shot still told to zoom", "and zoom_assembly < SUGGEST_ZOOM", "and True", "AssemblyZoomTests.test_no_crop_is_suggested_when_the_assembler_already_zooms_that_much"),
    ("cli exit code for an unreadable clip", "        return 2\n", "        return 1\n", "CliContractTests.test_cli_on_an_unreadable_file_exits_2_with_a_json_error"),
]


def main() -> int:
    out = []
    for name, old, new, test in CASES:
        src = open(os.path.join(here, 'clipqc.py')).read()
        assert src.count(old) == 1, f'sabotage anchor missing or not unique: {old}'
        d = tempfile.mkdtemp(prefix='sab-')
        for f in ('fixtures_qc.py', 'test_clipqc.py'):
            shutil.copy(os.path.join(here, f), d)
        open(os.path.join(d, 'clipqc.py'), 'w').write(src.replace(old, new, 1))
        try:
            r = subprocess.run([sys.executable, '-W', 'ignore', '-m', 'unittest', f'test_clipqc.{test}'], cwd=d, capture_output=True, text=True, timeout=150)
            red = r.returncode != 0
        except subprocess.TimeoutExpired:
            red = False
        out.append(dict(sabotage=name, test=test, red=red))
        print(('RED  ' if red else 'GREEN'), name, '->', test, flush=True)
        shutil.rmtree(d, ignore_errors=True)
    return 0 if all(o['red'] for o in out) else 1


if __name__ == '__main__':
    sys.exit(main())
