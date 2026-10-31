"""Cases whose assembly must stay byte-identical for every plan made before the E-area fields existed.

`python3 fixtures/golden_cases.py write` regenerates old_graphs.json from the CURRENT assemble.py. It was written once
against 58b44cc (before fadeIn / beatCuts / voice_end / transition guard) and must never be regenerated from newer code:
test_assemble_golden.py compares the new code with that frozen file.
"""
import json
import os
import re
import sys
import tempfile
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

DUB = {'input': 3, 'tempo': 1.1, 'lead': 0.3, 'cut': False}
FILTER_CASES = {
    'bare': dict(durations=[5.0, 5.0, 5.0], xf=0.3),
    'total': dict(durations=[5.0, 5.0, 5.0], xf=0.3, total=14.4),
    'transitions': dict(durations=[6.0, 6.0, 6.0], xf=0.5, transitions=['fade', 'fadeblack'], total=17.0),
    'zoom': dict(durations=[5.0, 5.0], xf=0.3, total=9.7, zooms=[1.0, 1.3], zoom_ys=[0.5, 1.0]),
    'title': dict(durations=[5.0, 5.0], xf=0.3, total=9.7, title_input=2),
    'subs': dict(durations=[5.0, 5.0], xf=0.3, total=9.7, subtitles='/tmp/s.ass', fonts_dir='/tmp/fonts'),
    'clipvol': dict(durations=[5.0, 5.0], xf=0.3, total=9.7, clip_volume=0.5),
    'music': dict(durations=[5.0, 5.0], xf=0.3, total=9.7, music_input=2, music={'at': 1.0, 'volume': 0.4}),
    'dubs': dict(durations=[5.0, 5.0, 5.0], xf=0.3, total=14.4, dubs=[dict(DUB), dict(DUB, cut=True, keep=0.12), None]),
    'dubs+music': dict(durations=[5.0, 5.0, 5.0], xf=0.3, total=14.4, music_input=4, music={'at': 0, 'volume': 0.3},
                       dubs=[dict(DUB), None, dict(DUB, input=5)]),
    'tail_hold': dict(durations=[5.0, 6.9], xf=0.3, total=11.6, tail_hold=0.93, dubs=[None, dict(DUB, tempo=1.25)]),
    'v-only': dict(durations=[5.0, 5.0, 5.0], xf=0.3, total=14.4, streams='v', zooms=[1.2, 1.0, 1.0]),
    'a-only': dict(durations=[5.0, 5.0, 5.0], xf=0.3, total=14.4, streams='a', dubs=[dict(DUB), None, None]),
}

WORDS = [['Sari', 0.0, 0.4], ['menyalakan', 0.5, 1.1], ['lentera,', 1.2, 1.8], ['lalu', 2.4, 2.7], ['pergi.', 2.8, 3.4]]
SPEC = {'id': 'x'}


def main_plans(d):
    """name -> plan dict (paths under d). Shots 's0'.. exist as empty files; probe_duration is faked."""
    dub0 = os.path.join(d, 'v0.mp3')
    dub1 = os.path.join(d, 'v1.mp3')
    mus = os.path.join(d, 'm.mp3')
    return {
        'plain': {'slug': 'final', 'crossfade': 0.3, 'shots': [{'id': 's0'}, {'id': 's1', 'transition': 'fadeblack'}, {'id': 's2', 'zoom': 1.25, 'zoomY': 1}], 'edit': {}},
        'subs': {'slug': 'final', 'crossfade': 0.3, 'shots': [{'id': f's{i}', 'narration': f'Baris {i}.'} for i in range(3)],
                 'edit': {'subtitles': True, 'subtitleStyle': 'tulisan-tangan', 'subtitleSize': 1.2, 'subtitleY': 0.1}},
        'noedit-title': {'slug': 'final', 'crossfade': 0.3, 'shots': [{'id': 's0'}, {'id': 's1'}], 'titleCard': {'lines': ['A']}},
        'dub-not-last': {'slug': 'final', 'crossfade': 0.3,
                         'shots': [{'id': 's0', 'narration': 'Sari menyalakan lentera, lalu pergi.', 'dub': {'file': dub0, 'seconds': 3.4, 'words': WORDS}},
                                   {'id': 's1', 'narration': 'ok', 'dub': {'file': dub1, 'seconds': 7.0}},
                                   {'id': 's2', 'narration': 'tanpa dub'}],
                         'edit': {'subtitles': True, 'dubKeepAmbient': True, 'music': {'path': mus, 'volume': 0.35, 'at': 0.5}}},
        'trim-music': {'slug': 'final', 'crossfade': 0.4, 'shots': [{'id': 's0', 'trim': {'in': 1, 'out': 5}}, {'id': 's1'}, {'id': 's2', 'trim': {'out': 4}}],
                       'edit': {'clipVolume': 0.7, 'music': {'path': mus, 'volume': 0.35, 'at': 0, 'from': 3}}},
    }


def capture(plan_name, plan):
    """The two -filter_complex strings main() hands to ffmpeg for `plan` (paths replaced by <D>)."""
    import assemble
    d = tempfile.mkdtemp(prefix='golden-')
    try:
        plan = json.loads(json.dumps(plan_name_plan(plan_name, d)))
        for i in range(6):
            open(os.path.join(d, f's{i}.mp4'), 'wb').write(b'x')
        for n in ('v0.mp3', 'v1.mp3', 'm.mp3'):
            open(os.path.join(d, n), 'wb').write(b'x')
        json.dump(plan, open(os.path.join(d, 'assemble.json'), 'w'))
        calls = []
        with mock.patch.object(assemble, 'probe_duration', lambda p: 7.0 if p.endswith('v1.mp3') else (3.4 if p.endswith('v0.mp3') else 6.0)), \
             mock.patch.object(assemble, 'run_ffmpeg', lambda cmd, label: calls.append(list(cmd))), \
             mock.patch.dict(sys.modules, {'title_card': mock.Mock(TitleCard=lambda *a, **k: mock.Mock())}), \
             mock.patch('sys.stdout'):
            assemble.main(d)
        out = []
        for cmd in calls:
            if '-filter_complex' in cmd:
                g = cmd[cmd.index('-filter_complex') + 1]
                out.append(re.sub(r'subs-[A-Za-z0-9_]+', 'subs-X', g.replace(d, '<D>')))
        return out
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def plan_name_plan(name, d):
    return main_plans(d)[name]


def build():
    import assemble
    data = {'filter': {}, 'main': {}}
    for name, kw in FILTER_CASES.items():
        kw = dict(kw)
        data['filter'][name] = {'kwargs': kw, 'graph': assemble.filter_graph(**kw)}
    for name in main_plans('/x'):
        data['main'][name] = capture(name, None)
    return data


if __name__ == '__main__' and sys.argv[1:] == ['write']:
    json.dump(build(), open(os.path.join(HERE, 'old_graphs.json'), 'w'), indent=1, sort_keys=True)
    print('written')
