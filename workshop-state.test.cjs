const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  W = require('./workshop-state.js'),
  S = require('./scenario.js');
function storage() {
  let value = null;
  return {
    getItem: () => value,
    setItem: (k, v) => {
      value = v;
    },
  };
}
test('不完整草稿可恢复，按剧本版本隔离，不保存额外密钥', () => {
  const st = storage(),
    d = S.bloodMoonSample();
  d.title = '';
  d.characters[0].name = '';
  d.apiKey = 'never-store';
  let state = W.save(st, W.read(st), {
    storyId: 'a',
    version: 1,
    dirty: true,
    activeStep: 3,
    draft: d,
    artId: 'art1',
    videoId: 'video1',
    artEdits: { 'art1:1': { 'frame-3': '未提交修改', apiKey: 'never-store' } },
  });
  assert.equal(state.entries['a:1'].draft.title, '');
  assert.equal(state.entries['a:1'].dirty, true);
  assert.equal(state.entries['a:1'].activeStep, 3);
  assert.ok(!st.getItem().includes('never-store'));
  state = W.save(st, state, { storyId: 'a', version: 2, draft: S.bloodMoonSample() });
  assert.equal(Object.keys(state.entries).length, 2);
  assert.equal(W.read(st).entries['a:1'].artEdits['art1:1']['frame-3'], '未提交修改');
  assert.equal(W.read(st).entries['a:1'].videoId, 'video1');
});
test('无法读取的记录不覆盖，非法结构拒绝保存', () => {
  const st = storage();
  st.setItem('', 'bad');
  assert.throws(() => W.read(st));
  assert.equal(st.getItem(), 'bad');
  assert.throws(() => W.draft({ characters: [], scenes: [] }));
});

test('旧草稿缺少人数索引时仍能恢复，损坏索引不会串到另一人数', () => {
  const six = { draft: S.bloodMoonSample(6), dirty: true, updatedAt: '2026-11-16T01:00:00Z' },
    twelve = { draft: S.bloodMoonSample(12), dirty: true, updatedAt: '2026-11-16T02:00:00Z' };
  const state = {
    schema: 1,
    lastKey: 'old-six',
    entries: { 'old-six': six, 'old-twelve': twelve },
  };
  assert.equal(W.latest(state, 6), six);
  assert.equal(W.latest(state, 12), twelve);
  state.lastByRoom = { 6: 'old-twelve', 12: 'missing' };
  assert.equal(W.latest(state, 6), six);
  assert.equal(W.latest(state, 12), twelve);
  const recent = { ...six, updatedAt: '2026-11-16T03:00:00Z' };
  state.lastKey = 'missing';
  state.entries.recent = recent;
  assert.equal(W.latest(state, 6), recent);
  assert.equal(W.latest(state, 12), twelve);
  assert.equal(W.latest({ entries: {} }, 6), undefined);
});

test('镜头插入删除和拆分后参考图用途、尾帧与起点按原镜头重映射', () => {
  const first = { referenceFrames: [2], referencePurposes: { 2: 'prop' }, endFrameIndex: 2 };
  const second = {
    startSource: 'previous',
    referenceFrames: [0],
    referencePurposes: { 0: 'scene' },
  };
  const third = {
    startSource: 'previous',
    referenceFrames: [1],
    referencePurposes: { 1: 'costume' },
  };
  const previous = [first, second, third],
    inserted = {};
  W.remapReferences(previous, [first, inserted, second, third]);
  assert.deepEqual(first.referenceFrames, [3]);
  assert.deepEqual(first.referencePurposes, { 3: 'prop' });
  assert.equal(first.endFrameIndex, 3);
  assert.equal(second.startSource, 'frame');
  assert.equal(third.startSource, 'previous');
  const beforeRemoval = [first, inserted, second, third];
  W.remapReferences(beforeRemoval, [first, inserted, third]);
  assert.deepEqual(first.referenceFrames, [2]);
  assert.equal(first.endFrameIndex, 2);
  assert.deepEqual(third.referenceFrames, []);
  assert.equal(third.startSource, 'frame');
  W.remapReferences([first, inserted, third], [first, inserted]);
  assert.deepEqual(first.referenceFrames, []);
  assert.equal(first.endFrameIndex, null);
});

test('新参考图字段随草稿保存，变更后内容签名失效且人数隔离', () => {
  const S = require('./scenario.js'),
    P = require('./workshop-preview.js'),
    { randomUUID } = require('node:crypto');
  let raw;
  const storage = { getItem: () => raw, setItem: (key, value) => (raw = value) };
  const story = S.bloodMoonEnglishSample(6);
  Object.assign(story.scenes[0], {
    referenceFrames: [2, 1],
    referencePurposes: { 2: 'prop', 1: 'scene' },
    endFrameIndex: 2,
    extraReferences: [{ id: randomUUID(), purpose: 'costume' }],
  });
  const signature = S.productionSignature(story),
    fingerprint = P.fingerprint(story, {});
  W.save(storage, W.read(storage), { draft: story, dirty: true });
  const restored = W.latest(W.read(storage), 6).draft;
  assert.deepEqual(restored.scenes[0], story.scenes[0]);
  assert.equal(S.productionSignature(restored), signature);
  restored.scenes[0].extraReferences[0].purpose = 'prop';
  assert.notEqual(S.productionSignature(restored), signature);
  assert.notEqual(P.fingerprint(restored, {}), fingerprint);
  assert.equal(W.latest(W.read(storage), 12), undefined);
});
