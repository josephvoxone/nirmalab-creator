import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { flowHome, storyDir, storyFile, expandPath } from '../src/paths.mjs';

test('flowHome: default folder nirmalab, bisa di-override FLOW_HOME', () => {
  assert.equal(flowHome({}), join(homedir(), 'Documents', 'nirmalab', 'flow'));
  assert.equal(flowHome({ FLOW_HOME: '/x/flow' }), '/x/flow');
});

test('storyFile: slug → <home>/stories/<slug>/storyboard.json, path apa adanya', () => {
  const env = { FLOW_HOME: '/h' };
  assert.equal(storyFile('selendang-merah', env), '/h/stories/selendang-merah/storyboard.json');
  assert.equal(storyFile('./x/story.json', env), './x/story.json');
  assert.equal(storyDir('selendang-merah', env), '/h/stories/selendang-merah');
});

test('expandPath: ~ dan $FLOW_HOME', () => {
  const env = { FLOW_HOME: '/h' };
  assert.equal(expandPath('$FLOW_HOME/bridge/a.mp4', env), '/h/bridge/a.mp4');
  assert.equal(expandPath('~/a.mp4', env), join(homedir(), 'a.mp4'));
});
