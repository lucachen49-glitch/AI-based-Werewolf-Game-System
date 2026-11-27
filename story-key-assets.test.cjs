'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createKeyAssetJobs } = require('./story-key-assets.cjs');
const { createScenarioStore } = require('./scenario-store.cjs');
const Scenario = require('./scenario.js');

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'key-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const story = {
    id: randomUUID(),
    version: 1,
    roomSize: 6,
    characters: [{ secret: 'private-secret' }],
  };
  const store = {
    get: async (id) => {
      assert.equal(id, story.id);
      return story;
    },
  };
  const items = new Map();
  const references = {
    async saveGenerated({ roomSize, label, kind, bytes }) {
      if (options.failSave) throw Error('local write error');
      const ref = { id: randomUUID(), roomSize, label, kind, file: path.join(root, 'ref.png') };
      await fs.writeFile(ref.file, bytes);
      items.set(ref.id, ref);
      return this.summary(ref);
    },
    async get(id, roomSize) {
      const ref = items.get(id);
      if (!ref || ref.roomSize !== roomSize)
        throw Object.assign(Error('wrong room'), { code: 'REFERENCE_NOT_FOUND' });
      return ref;
    },
    summary: (ref) => ({ ...ref, url: '/image/' + ref.id }),
  };
  const calls = [];
  const provider = {
    async generate(args) {
      calls.push(args);
      return options.generate ? options.generate(args) : Buffer.from('image');
    },
  };
  const reviewer = {
    credential: (x) => x,
    check: async () => ({ verdict: 'pass', summary: 'ok', findings: [] }),
  };
  const jobs = createKeyAssetJobs({
    root: path.join(root, 'jobs'),
    store,
    references,
    provider,
    reviewer,
    config: { loadCredential: async () => true },
  });
  const body = {
    storyId: story.id,
    version: 1,
    roomSize: 6,
    subject: 'table',
    confirmCharge: true,
  };
  async function wait(id, status) {
    for (let i = 0; i < 100; i++) {
      const job = (await jobs.list(story.id, 6)).find((x) => x.id === id);
      if (job?.status === status) return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('timed out: ' + status);
  }
  return { root, story, references, jobs, body, calls, wait };
}

test('关键物品须授权且重复提交被阻止，检查确认并保留历史', async (t) => {
  let finish;
  const f = await setup(t, {
    generate: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await assert.rejects(f.jobs.create({ ...f.body, confirmCharge: false }), {
    code: 'CHARGE_CONFIRM_REQUIRED',
  });
  await assert.rejects(f.jobs.create({ ...f.body, detail: 'private-secret' }), {
    code: 'INVALID_PUBLIC_DESCRIPTION',
  });
  await assert.rejects(f.jobs.create({ ...f.body, fixedLayout: 'private-secret' }), {
    code: 'INVALID_PUBLIC_DESCRIPTION',
  });
  await assert.rejects(f.jobs.create({ ...f.body, allowedMovements: 'private-secret' }), {
    code: 'INVALID_PUBLIC_DESCRIPTION',
  });
  const fixedLayout =
    'round walnut banquet table; the head seat stays empty; candelabra left, guestbook right';
  const allowedMovements =
    'Only the invitation may move from Vera’s hand to the empty place after the note is read';
  const first = await f.jobs.create({ ...f.body, fixedLayout, allowedMovements });
  await assert.rejects(f.jobs.create(f.body), { code: 'KEY_ASSET_UNCERTAIN' });
  while (!finish) await new Promise((r) => setTimeout(r, 1));
  finish(Buffer.from('image'));
  const done = await f.wait(first.id, 'done');
  assert.equal(f.calls.length, 1);
  assert.ok(done.reference.id);
  assert.equal(done.fixedLayout, fixedLayout);
  assert.equal(done.allowedMovements, allowedMovements);
  assert.ok(f.calls[0].prompt.includes(fixedLayout));
  assert.ok(f.calls[0].prompt.includes(allowedMovements));
  await assert.rejects(f.jobs.action(first.id, { action: 'confirm' }), {
    code: 'KEY_ASSET_NOT_READY',
  });
  await f.jobs.action(first.id, { action: 'review', agent: {} });
  const confirmed = await f.jobs.action(first.id, { action: 'confirm' });
  assert.ok(confirmed.confirmedAt);
  const reused = await f.jobs.reuse({ ...f.body, referenceId: done.reference.id });
  assert.equal(reused.sourceReferenceId, done.reference.id);
  assert.equal(f.calls.length, 1);
  f.story.version = 2;
  await assert.rejects(f.jobs.action(first.id, { action: 'confirm' }), { code: 'STORY_CHANGED' });
  await assert.rejects(f.jobs.reuse({ ...f.body, referenceId: done.reference.id }), {
    code: 'STORY_CHANGED',
  });
  assert.equal((await f.jobs.list(f.story.id, 12)).length, 0);
});

test('结果不明需人工核对，保存原图失败可恢复', async (t) => {
  const unknown = await setup(t, {
    generate: async () => {
      throw Object.assign(Error('timeout'), { code: 'TIMEOUT' });
    },
  });
  const task = await unknown.jobs.create(unknown.body);
  await unknown.wait(task.id, 'unknown');
  await assert.rejects(unknown.jobs.create(unknown.body), { code: 'KEY_ASSET_UNCERTAIN' });
  await assert.rejects(unknown.jobs.action(task.id, { action: 'resolveUnknown' }), {
    code: 'RECONCILIATION_REQUIRED',
  });
  await unknown.jobs.action(task.id, { action: 'resolveUnknown', reconciled: true });
  assert.equal(unknown.calls.length, 1);
  const recover = await setup(t, { failSave: true });
  const second = await recover.jobs.create(recover.body);
  await recover.wait(second.id, 'received');
  recover.references.saveGenerated = async ({ roomSize, label, kind }) => ({
    id: randomUUID(),
    roomSize,
    label,
    kind,
  });
  const restored = await recover.jobs.action(second.id, { action: 'recover' });
  assert.equal(restored.status, 'done');
  assert.equal(recover.calls.length, 1);
});

async function setupReferenceApplication(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'key-asset-apply-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createScenarioStore(path.join(root, 'stories'));
  const draft = options.story || Scenario.bloodMoonEnglishSample(options.roomSize || 6);
  const story = await store.save(draft);
  const items = new Map();
  const references = {
    async saveGenerated({ roomSize, label, kind, bytes }) {
      const id = randomUUID();
      const file = path.join(root, id + '.png');
      await fs.writeFile(file, bytes);
      const ref = { id, roomSize, label, kind, file, sha256: 'test-' + id };
      items.set(id, ref);
      return this.summary(ref);
    },
    async get(id, roomSize) {
      const ref = items.get(id);
      if (!ref || ref.roomSize !== roomSize)
        throw Object.assign(Error('wrong room'), { code: 'REFERENCE_NOT_FOUND' });
      return ref;
    },
    summary: (ref) => ({
      id: ref.id,
      roomSize: ref.roomSize,
      label: ref.label,
      kind: ref.kind,
      url: '/image/' + ref.id,
      sha256: ref.sha256,
    }),
  };
  const provider = { generate: async () => Buffer.from('reference image') };
  const reviewer = {
    credential: (value) => value,
    check: async () => ({ verdict: 'pass', summary: 'ok', findings: [] }),
  };
  const jobs = createKeyAssetJobs({
    root: path.join(root, 'jobs'),
    store,
    references,
    provider,
    reviewer,
    config: { loadCredential: async () => true },
  });
  async function confirmedEnvelope(continuity = {}) {
    const job = await jobs.create({
      storyId: story.id,
      version: story.version,
      roomSize: story.roomSize,
      subject: 'envelope',
      confirmCharge: true,
      ...continuity,
    });
    for (let i = 0; i < 100; i++) {
      const current = (await jobs.list(story.id, story.roomSize)).find(
        (item) => item.id === job.id,
      );
      if (current?.status === 'done') {
        await jobs.action(job.id, { action: 'review', agent: {} });
        return jobs.action(job.id, { action: 'confirm' });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error('timed out waiting for confirmed key asset');
  }
  return { root, store, story, jobs, confirmedEnvelope };
}

test('应用已确认关键物品图时创建新剧本版本并保留旧版且隔离人数', async (t) => {
  const f = await setupReferenceApplication(t);
  const fixedLayout = 'one ivory envelope with a red wax seal, held vertically';
  const allowedMovements =
    'Vera keeps it in her right hand until she lays it beside the empty chair';
  const job = await f.confirmedEnvelope({ fixedLayout, allowedMovements });
  const result = await f.jobs.applyReferences({
    storyId: f.story.id,
    version: 1,
    roomSize: 6,
    items: [{ jobId: job.id, scenes: [0, 1] }],
  });
  assert.equal(result.story.version, 2);
  assert.equal(result.mappings[0].label, '封好的邀请函');
  const oldVersion = await f.store.get(f.story.id, 1);
  const current = await f.store.get(f.story.id);
  assert.equal(oldVersion.scenes[0].extraReferences.length, 0);
  assert.deepEqual(current.scenes[0].extraReferences, [
    { id: job.reference.id, purpose: 'prop', fixedLayout, allowedMovements },
  ]);
  assert.deepEqual(current.scenes[1].extraReferences, [
    { id: job.reference.id, purpose: 'prop', fixedLayout, allowedMovements },
  ]);
  assert.equal(current.confirmed, false);
  assert.equal((await f.jobs.list(f.story.id, 12)).length, 0);
  await assert.rejects(
    f.jobs.applyReferences({
      storyId: f.story.id,
      version: 2,
      roomSize: 12,
      items: [{ jobId: job.id, scenes: [0] }],
    }),
    { code: 'STORY_CHANGED' },
  );
  await assert.rejects(
    f.jobs.applyReferences({
      storyId: f.story.id,
      version: 2,
      roomSize: 6,
      items: [{ jobId: job.id, scenes: [0] }],
    }),
    { code: 'KEY_ASSET_NOT_CONFIRMED' },
  );
  assert.equal((await f.store.get(f.story.id)).version, 2);
});

test('关键物品引用导致镜头参考图超限时不创建部分版本', async (t) => {
  const draft = Scenario.bloodMoonEnglishSample(6);
  draft.scenes[0].extraReferences = Array.from({ length: 12 }, () => ({
    id: randomUUID(),
    purpose: 'prop',
  }));
  const f = await setupReferenceApplication(t, { story: draft });
  const job = await f.confirmedEnvelope();
  await assert.rejects(
    f.jobs.applyReferences({
      storyId: f.story.id,
      version: 1,
      roomSize: 6,
      items: [{ jobId: job.id, scenes: [0] }],
    }),
    { code: 'INVALID_KEY_ASSET_MAPPING' },
  );
  const current = await f.store.get(f.story.id);
  assert.equal(current.version, 1);
  assert.equal(current.scenes[0].extraReferences.length, 12);
  assert.equal((await f.store.get(f.story.id, 1)).scenes[0].extraReferences.length, 12);
});
