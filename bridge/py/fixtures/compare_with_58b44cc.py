#!/usr/bin/env python3
"""Render one OLD-style plan (no fadeIn / beatCuts, last shot not dubbed) with assemble.py from 58b44cc and with the current one: the mp4s must be byte-identical.

    PATH=<ffmpeg with libass>:$PATH python3 bridge/py/fixtures/compare_with_58b44cc.py        # from the repo root
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
work = tempfile.mkdtemp(prefix='ident-')
old = os.path.join(work, 'old')
os.makedirs(old)
open(os.path.join(old, 'assemble.py'), 'w').write(subprocess.run(['git', '-C', ROOT, 'show', '58b44cc:bridge/py/assemble.py'], capture_output=True, text=True, check=True).stdout)
shutil.copytree(os.path.join(ROOT, 'bridge/py/fonts'), os.path.join(old, 'fonts'))
shutil.copy(os.path.join(ROOT, 'bridge/py/title_card.py'), old)
d = os.path.join(work, 'story')
os.makedirs(d)
for i in range(3):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=24:d=3', '-f', 'lavfi', '-i', f'sine=frequency={300 + 50 * i}:duration=3',
                    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f'{d}/s{i}.mp4'], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:a', 'libmp3lame', f'{d}/v.mp3'], check=True)
plan = {'slug': 'final', 'crossfade': 0.3, 'edit': {'subtitles': True, 'clipVolume': 0.8, 'subtitleStyle': 'tulisan-tangan'}, 'shots': [
    {'id': 's0', 'narration': 'Satu dua tiga.', 'zoom': 1.2, 'dub': {'file': f'{d}/v.mp3', 'seconds': 2.0, 'words': [['Satu', 0, 0.5], ['dua', 0.6, 1.0], ['tiga.', 1.1, 1.8]]}},
    {'id': 's1', 'narration': 'Empat lima.', 'transition': 'fadeblack'}, {'id': 's2', 'narration': 'Enam.', 'zoom': 1.1, 'zoomY': 1}]}
sums = {}
for name, script in (('old', os.path.join(old, 'assemble.py')), ('new', os.path.join(ROOT, 'bridge/py/assemble.py'))):
    json.dump(plan, open(f'{d}/assemble.json', 'w'))
    r = subprocess.run([sys.executable, script, d], capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stderr)
    sums[name] = hashlib.md5(open(f'{d}/final.mp4', 'rb').read()).hexdigest()
shutil.rmtree(work, ignore_errors=True)
print(sums, 'IDENTICAL' if sums['old'] == sums['new'] else 'DIFFERENT')
sys.exit(0 if sums['old'] == sums['new'] else 1)
