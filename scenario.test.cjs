'use strict';
function agentResponse(text) {
  return {
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
  };
}
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  { once } = require('node:events');
const S = require('./scenario.js'),
  { createScenarioStore, atomic } = require('./scenario-store.cjs'),
  { createVideoConfigStore, normalizeVideoBase } = require('./video-config.cjs'),
  { createVideoJobs } = require('./video-jobs.cjs'),
  { createServer } = require('./server.cjs');
const Player = require('./story-player.js');
test('血月停战宴完整配置可校验，草稿未确认，每次载入独立且血统不决定身份', () => {
  const s = S.bloodMoonSample();
  assert.deepEqual(S.validate(s), s);
  assert.equal(s.title, '血月停战宴');
  assert.equal(s.confirmed, false);
  assert.equal(s.characters.length, 6);
  assert.ok(s.scenes.length > 0);
  assert.equal(
    s.targetDuration,
    s.scenes.reduce((sum, scene) => sum + scene.duration, 0),
  );
  assert.match(s.background, /随机身份由发牌决定/);
  assert.deepEqual(
    s.characters.map((c) => c.gender),
    ['female', 'male', 'male', 'female', 'male', 'female'],
  );
  for (const c of s.characters) {
    assert.ok(s.source.includes(c.name));
    assert.ok(s.source.includes(c.secret));
    assert.ok(c.secret.length > 20);
  }
  for (const scene of s.scenes) {
    assert.ok(s.source.includes(scene.narration));
    assert.ok(scene.narration.length <= 75);
  }
  s.characters[0].name = '已编辑';
  assert.equal(S.bloodMoonSample().characters[0].name, '薇拉·绯夜');
});
test('剧本校验拒绝公开关系自指和镜头文字引用未出场人物', () => {
  const base = S.bloodMoonSample();
  const self = JSON.parse(JSON.stringify(base));
  self.characters[0].relationships = '与1号共同守门。';
  assert.throws(() => S.validate(self), /1号人物的公开关系不能引用自己/);
  const scene = JSON.parse(JSON.stringify(base));
  scene.scenes[0].description += ' 5号站在门外。';
  assert.throws(() => S.validate(scene), /第 1 镜头文字引用了未出场的 5号人物/);
});
test('关键参考连续性说明经剧本校验进入视频提示词且禁止秘密', () => {
  const s = S.bloodMoonEnglishSample(6),
    id = require('node:crypto').randomUUID();
  const fixedLayout = 'round table; empty head seat; two candles remain at the far edge';
  const allowedMovements = 'Only the envelope moves when Vera deliberately sets it beside the note';
  s.scenes[0].extraReferences = [{ id, purpose: 'scene', fixedLayout, allowedMovements }];
  const clean = S.validate(s);
  assert.equal(clean.scenes[0].extraReferences[0].fixedLayout, fixedLayout);
  assert.equal(clean.scenes[0].extraReferences[0].allowedMovements, allowedMovements);
  assert.ok(S.referenceVideoPrompt(clean, 0, clean.characters).includes(allowedMovements));
  const secret = clean.characters[0].secret;
  assert.throws(
    () =>
      S.validate({
        ...clean,
        scenes: clean.scenes.map((scene, i) =>
          i
            ? scene
            : { ...scene, extraReferences: [{ id, purpose: 'scene', fixedLayout: secret }] },
        ),
      }),
    /不能包含人物秘密/,
  );
});

test('六人前三镜持邀请函画面强调明确夹持、五指结构与镜头连续性', () => {
  const s = S.bloodMoonSample(),
    characters = s.characters.map((c) => ({ ...c, appearance: S.appearance(c) }));
  const prompts = s.scenes.slice(0, 3).map((_, i) => S.artPrompt(s, 'frame', i, characters));
  assert.match(prompts[0], /SHOT 1 — CLEAR PINCH, NOT A PALM HOLD/);
  assert.match(prompts[0], /sealed invitation/i);
  assert.match(
    prompts[0],
    /never pasted to the palm|pasted on, lying across, or passing through the hand/i,
  );
  assert.match(prompts[0], /one thumb and four distinct naturally attached fingers/i);
  assert.match(prompts[0], /paper edge between the opposing fingertips/i);
  assert.match(prompts[1], /SHOT 2 — MATCHED CONTINUITY AND READABLE HAND/);
  assert.match(prompts[2], /SHOT 3 — MATCH SHOT 2 EXACTLY/);
  assert.match(prompts[0], /outside on the snowy castle porch/i);
  assert.match(prompts[1], /Depict only the opening instant/i);
  assert.match(prompts[2], /separate sealed note.*own opening state/i);
  assert.doesNotMatch(prompts[2], /End with the invitation still in the same hand and pose/i);
  for (const prompt of prompts) {
    assert.match(
      prompt,
      /exactly five fingers, one thumb and four fingers|exactly five attached digits/i,
    );
    assert.match(
      prompt,
      /intersecting fingers|do not merge paper and skin|cannot intersect the fingers|never intersecting skin|passing through the hand|fused/,
    );
  }
});

test('血月公开视频和公开上下文不含秘密，Agent不接收人物秘密', () => {
  const s = S.bloodMoonSample(),
    pub = JSON.stringify(S.publicStory(s));
  for (const c of s.characters) {
    assert.ok(!pub.includes(c.secret));
    for (let i = 0; i < s.scenes.length; i++) assert.ok(!S.videoPrompt(s, i).includes(c.secret));
    const self = JSON.stringify(S.context(s, c.seat));
    assert.ok(!self.includes(c.secret));
    for (const other of s.characters)
      if (other.seat !== c.seat) assert.ok(!self.includes(other.secret));
  }
});
function draft() {
  return {
    title: '迷雾庄园',
    source: '原稿',
    background: '六位成年人重返山中庄园，围桌试探彼此。',
    confirmed: true,
    characters: Array.from({ length: 6 }, (_, i) => ({
      seat: i + 1,
      name: '人物' + (i + 1),
      personality: '沉着谨慎',
      relationships: '公开关系' + (i + 1),
      secret: '私密往事' + (i + 1),
    })),
    scenes: [0, 1, 2].map((i) => ({
      description: '雨夜庄园镜头' + i,
      narration: '六位来客围桌，今夜的选择将决定答案。',
    })),
  };
}
function legacy60() {
  const s = S.expand60(draft());
  s.visualGuide = '保持同一庄园建筑与照明。';
  s.scenes = s.scenes.map((x, i) => ({
    ...x,
    startFrame: '镜头起点' + i,
    endFrame: '镜头终点' + i,
    description: i === 0 ? '吊桥尚完整' : i === 4 ? '吊桥断裂' : x.description,
  }));
  return s;
}
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nightfall-story-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function eventually(fn) {
  for (let i = 0; i < 600; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error('任务未在测试上限内完成');
}
async function fixture(t, options = {}) {
  const root = await temp(t),
    store = createScenarioStore(root),
    story = await store.save(draft()),
    seen = [];
  const config = {
    loadCredential: async () => ({
      provider: 'https://video.test/v1',
      model: 'grok-imagine-video-1.5',
      apiKey: 'separate-video-test-secret',
    }),
  };
  const media = {
    available: async () => true,
    normalize: async (src, out) => {
      await fs.writeFile(out, 'validated-movie-bytes-'.repeat(5));
    },
    assemble: async (dir) => {
      await fs.writeFile(path.join(dir, 'intro.mp4'), 'final-video-content-'.repeat(5));
    },
    ...options.media,
  };
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (options.handler) return options.handler(url, init, seen);
    if (url.startsWith('https://cdn.test/')) return new Response(Buffer.alloc(100));
    if (init.method === 'POST')
      return Response.json({
        request_id: 'mock-task-' + seen.filter((s) => s.init.method === 'POST').length,
      });
    return Response.json({ status: 'done', video: { url: 'https://cdn.test/video.mp4' } });
  };
  const jobs = createVideoJobs({
    root: path.join(root, 'videos'),
    store,
    config,
    fetchImpl,
    media,
    pollMs: 1,
    ...options.jobOptions,
  });
  t.after(() => jobs.close());
  return { root, store, story, config, media, fetchImpl, seen, jobs };
}
async function fileText(root) {
  let out = '';
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    out += e.isDirectory() ? await fileText(p) : await fs.readFile(p, 'utf8');
  }
  return out;
}

test('六镜头时间轴与制作方案兼容旧三镜头，扩展只产生未确认草稿', () => {
  const old = draft(),
    expanded = S.expand60(old),
    sample = legacy60();
  assert.equal(old.scenes.length, 3);
  assert.equal(expanded.scenes.length, 6);
  assert.equal(expanded.confirmed, false);
  assert.deepEqual(expanded.characters, old.characters);
  assert.equal(expanded.source, old.source);
  assert.deepEqual(S.videoPlan(expanded), {
    profile: 'story60-v1',
    targetDuration: 60,
    sceneDurations: Array(6).fill(10),
    sceneDuration: 10,
    audioMode: 'unified',
  });
  assert.equal(S.videoPlan(old).profile, 'legacy30-v1');
  assert.throws(() => S.videoPlan(old, 'story60-v1'));
  assert.throws(() => S.videoPlan(sample, 'legacy30-v1'));
  assert.throws(() => S.validate({ ...sample, scenes: sample.scenes.slice(0, 5) }));
  for (let i = 0; i < 6; i++) {
    const p = S.videoPrompt(sample, i);
    assert.ok(p.includes(sample.visualGuide));
    assert.ok(p.includes(sample.scenes[i].startFrame));
    assert.ok(p.includes(sample.scenes[i].endFrame));
    assert.match(p, /No dialogue, narration/);
  }
  assert.match(S.videoPrompt(old, 0), /Native audio REQUIRED/);
  assert.match(sample.scenes[0].description, /尚完整/);
  assert.match(sample.scenes[4].description, /断裂/);
});

test('六镜头先完成旁白，再顺序生成无原声画面；方案去重且第六镜可访问', async (t) => {
  let voiced = false,
    assembled = 0,
    normalized = [];
  const f = await fixture(t, {
    media: {
      prepareNarration: async () => {
        voiced = true;
      },
      normalize: async (src, out, options) => {
        assert.equal(voiced, true);
        normalized.push(options.audioMode);
        await fs.writeFile(out, 'movie');
      },
      assemble: async (dir, j) => {
        assert.equal(j.scenes.length, 6);
        assembled++;
        await fs.writeFile(path.join(dir, 'intro.mp4'), 'movie');
      },
    },
  });
  const story = await f.store.save({ ...legacy60(), confirmed: true });
  const [j, duplicate] = await Promise.all([
    f.jobs.create({ storyId: story.id, version: 1, profile: 'story60-v1' }),
    f.jobs.create({ storyId: story.id, version: 1 }),
  ]);
  assert.equal(j.id, duplicate.id);
  await eventually(async () => (await f.jobs.get(j.id)).status === 'ready');
  assert.equal(assembled, 1);
  assert.deepEqual(normalized, Array(6).fill('unified'));
  const musicSnapshot = await f.jobs.get(j.id);
  assert.deepEqual(
    musicSnapshot.scenes.map((x) => x.musicCue),
    story.scenes.map((scene) =>
      require('./soundfx.js').storyMusic({ story, scene: scene.description }),
    ),
  );
  assert.ok(
    musicSnapshot.scenes.every(
      (x) => !JSON.stringify(x.musicCue).includes(story.characters[0].secret),
    ),
  );
  assert.equal(f.seen.filter((r) => r.init.method === 'POST').length, 6);
  assert.ok(
    f.seen
      .filter((r) => r.init.method === 'POST')
      .every((r) => JSON.parse(r.init.body).generate_audio === false),
  );
  assert.ok((await f.jobs.mediaFile(j.id, 'scene-5.mp4')).endsWith('scene-5.mp4'));
  await assert.rejects(() => f.jobs.mediaFile(j.id, 'scene-6.mp4'));
  const publicJob = f.jobs.summary(await f.jobs.get(j.id));
  assert.equal(publicJob.targetDuration, 60);
  assert.equal(publicJob.stage, 'complete');
  await f.jobs.action(j.id, { action: 'retry', index: 5, confirmCharge: true });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'ready');
  assert.equal(f.seen.filter((r) => r.init.method === 'POST').length, 7);
});

test('旁白失败不提交收费任务，合成失败后复用全部画面并可重启恢复', async (t) => {
  let narrationOK = false,
    assemblyOK = false;
  const f = await fixture(t, {
    media: {
      prepareNarration: async () => {
        if (!narrationOK) throw Error('voice unavailable');
      },
      assemble: async (dir) => {
        if (!assemblyOK) throw Error('assembly interrupted');
        await fs.writeFile(path.join(dir, 'intro.mp4'), 'movie');
      },
    },
  });
  const story = await f.store.save({ ...legacy60(), confirmed: true });
  const j = await f.jobs.create({ storyId: story.id, version: 1 });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'paused');
  assert.equal(f.seen.length, 0);
  narrationOK = true;
  await f.jobs.action(j.id, { action: 'resume' });
  await eventually(async () => {
    const v = await f.jobs.get(j.id);
    return v.status === 'paused' && v.scenes.every((s) => s.status === 'done');
  });
  assert.equal(f.seen.filter((r) => r.init.method === 'POST').length, 6);
  await f.jobs.close();
  assemblyOK = true;
  const recovered = createVideoJobs({
    root: f.jobs.root,
    store: f.store,
    config: f.config,
    fetchImpl: f.fetchImpl,
    media: f.media,
    pollMs: 1,
  });
  t.after(() => recovered.close());
  await recovered.action(j.id, { action: 'resume' });
  await eventually(async () => (await recovered.get(j.id)).status === 'ready');
  assert.equal(f.seen.filter((r) => r.init.method === 'POST').length, 6);
});

test('查询等待上限属于各个镜头，整项任务超出窗口仍能顺序完成', async (t) => {
  let id = 0;
  const queried = new Set();
  const f = await fixture(t, {
    jobOptions: { maxWaitMs: 100, pollMs: 1 },
    handler: async (url, init) => {
      if (init.method === 'POST') return Response.json({ request_id: 'scene-' + ++id });
      if (url.startsWith('https://cdn.test')) return new Response(Buffer.alloc(100));
      if (!queried.has(url)) {
        queried.add(url);
        await new Promise((r) => setTimeout(r, 55));
        return Response.json({ status: 'processing' });
      }
      return Response.json({ status: 'done', video: { url: 'https://cdn.test/clip' } });
    },
  });
  const start = Date.now(),
    j = await f.jobs.create({ storyId: f.story.id, version: 1 });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'ready');
  assert.ok(Date.now() - start > 100);
  assert.equal(f.seen.filter((r) => r.init.method === 'POST').length, 3);
});

test('剧本严格为六位人物和三个镜头，不能固定本局身份', () => {
  assert.equal(S.validate(draft()).characters.length, 6);
  for (const mutate of [
    (s) => s.characters.pop(),
    (s) => s.scenes.pop(),
    (s) => (s.characters[1].name = s.characters[0].name),
    (s) => (s.characters[0].seat = 2),
    (s) => (s.background = '本局固定人物1是狼人'),
  ]) {
    const s = draft();
    mutate(s);
    assert.throws(() => S.validate(s));
  }
});
test('公开投影和视频提示词不包含个人秘密；每席上下文不含秘密', () => {
  const s = draft();
  for (const text of [JSON.stringify(S.publicStory(s)), S.videoPrompt(s, 0)])
    assert.doesNotMatch(text, /私密往事|原稿/);
  for (let i = 1; i <= 6; i++) {
    const c = S.context(s, i);
    assert.equal(c.self.seat, i);
    for (let j = 1; j <= 6; j++) assert.ok(!JSON.stringify(c).includes('私密往事' + j));
  }
  assert.throws(() => S.context(s, 7));
});
test('本地模拟保留人物口吻和公开关系，不拿个人秘密或往事当身份依据', () => {
  const text = S.fallback(draft(), 1, '我怀疑 2 号。');
  assert.match(text, /人物1|公开关系1/);
  assert.doesNotMatch(text, /私密往事/);
  assert.match(text, /不能证明本局身份/);
});
test('剧本重启恢复、版本快照、旧配置和修改后视频解绑', async (t) => {
  const root = await temp(t),
    store = createScenarioStore(root);
  const s = await store.save(draft());
  await store.bindVideo(s.id, 1, 'test-job');
  const v2 = await store.save({ ...s, title: '修改后的庄园' });
  assert.equal(v2.version, 2);
  assert.equal(v2.video, null);
  const restored = createScenarioStore(root);
  assert.equal((await restored.get(s.id, 1)).title, s.title);
  assert.equal((await restored.get(s.id, 1)).video.jobId, 'test-job');
  assert.equal((await restored.get(s.id)).title, v2.title);
  await assert.rejects(() => store.save(s), /其他页面更新/);
  await assert.rejects(() => store.get('../video-provider'));
  assert.doesNotMatch(JSON.stringify(await store.list()), /私密往事|原稿/);
});
test('视频配置独立加密、重启可解密、HTTP状态不含密钥；不自动更换模型', async (t) => {
  const file = path.join(await temp(t), 'video-provider.json'),
    protect = async (s, decrypt) =>
      decrypt
        ? Buffer.from(s.slice(4), 'base64').toString()
        : 'enc:' + Buffer.from(s).toString('base64');
  const store = createVideoConfigStore(file, protect);
  await store.save({ apiKey: 'isolated-video-key-123' });
  const saved = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(saved, /isolated-video-key/);
  assert.doesNotMatch(JSON.stringify(await store.status()), /encryptedKey|isolated-video-key/);
  const restored = createVideoConfigStore(file, protect);
  assert.equal((await restored.loadCredential()).apiKey, 'isolated-video-key-123');
  await restored.save({ provider: 'https://api-fast.hualong-ai.com/v1', apiKey: '' });
  assert.equal((await restored.loadCredential()).apiKey, 'isolated-video-key-123');
  await assert.rejects(() => restored.save({ provider: 'https://new.example' }), {
    code: 'VIDEO_KEY_REQUIRED',
  });
  assert.equal((await restored.loadCredential()).provider, 'https://api-fast.hualong-ai.com/v1');
  await restored.save({ provider: 'https://new.example', apiKey: 'new-video-key' });
  assert.equal((await restored.loadCredential()).apiKey, 'new-video-key');
  await assert.rejects(() => restored.save({ model: 'another-model' }));
  for (const url of [
    'http://bad.test',
    'https://u:p@bad.test',
    'https://bad.test/v1/videos',
    'https://bad.test/?key=x',
  ])
    assert.throws(() => normalizeVideoBase(url));
  assert.equal(
    normalizeVideoBase('https://api-fast.hualong-ai.com/'),
    'https://api-fast.hualong-ai.com/v1',
  );
});
test('三镜头顺序生成，原生音轨检查后才提交下一镜头；去重、确认与媒体白名单', async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([
    f.jobs.create({ storyId: f.story.id, version: 1 }),
    f.jobs.create({ storyId: f.story.id, version: 1 }),
  ]);
  assert.equal(a.id, b.id);
  await eventually(async () => (await f.jobs.get(a.id)).status === 'ready');
  const posts = f.seen.filter((s) => s.init.method === 'POST');
  assert.equal(posts.length, 3);
  assert.ok(posts.every((s) => JSON.parse(s.init.body).model === 'grok-imagine-video-1.5'));
  assert.ok(posts.every((s) => JSON.parse(s.init.body).duration === 10));
  assert.ok(
    f.seen
      .filter((s) => s.url.startsWith('https://cdn.test'))
      .every((s) => !s.init.headers?.Authorization),
  );
  assert.doesNotMatch(
    await fileText(f.root),
    /separate-video-test-secret|私密往事.*prompt|https:\/\/cdn.test/,
  );
  await assert.rejects(() => f.jobs.action(a.id, { action: 'accept' }), /预览/);
  await f.jobs.action(a.id, { action: 'accept', previewConfirmed: true });
  assert.equal((await f.store.get(f.story.id)).video.jobId, a.id);
  assert.ok((await f.jobs.mediaFile(a.id, 'intro.mp4')).endsWith('intro.mp4'));
  await assert.rejects(() => f.jobs.mediaFile(a.id, '../job.json'));
  await f.jobs.action(a.id, { action: 'retry', index: 1, confirmCharge: true });
  assert.equal((await f.store.get(f.story.id)).video, null);
  await eventually(async () => (await f.jobs.get(a.id)).status === 'ready');
  assert.equal(f.seen.filter((s) => s.init.method === 'POST').length, 4);
});
test('首镜头缺少音频则停止后续提交，继续查询沿用同一个任务编号', async (t) => {
  let bad = true;
  const f = await fixture(t, {
    media: {
      normalize: async (src, out) => {
        if (bad) throw Error('no audio');
        await fs.writeFile(out, 'audio-movie');
      },
    },
  });
  const j = await f.jobs.create({ storyId: f.story.id, version: 1 });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'paused');
  assert.equal(f.seen.filter((s) => s.init.method === 'POST').length, 1);
  bad = false;
  await f.jobs.action(j.id, { action: 'resume' });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'ready');
  assert.equal(f.seen.filter((s) => s.init.method === 'POST').length, 3);
});

test('华龙相对内容地址可带本任务鉴权下载，外部CDN不携带密钥', async (t) => {
  const f = await fixture(t, {
    handler: async (url, init) => {
      if (init.method === 'POST') return Response.json({ request_id: 'existing-task' });
      if (url.endsWith('/content')) {
        assert.equal(init.headers.Authorization, 'Bearer separate-video-test-secret');
        return new Response(Buffer.alloc(100));
      }
      return Response.json({
        status: 'done',
        progress: 100,
        video: { url: '/v1/videos/existing-task/content' },
      });
    },
  });
  const j = await f.jobs.create({ storyId: f.story.id, version: 1 });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'ready');
  assert.equal(
    f.seen.filter((s) => s.url === 'https://video.test/v1/videos/existing-task/content').length,
    3,
  );
  assert.doesNotMatch(await fileText(f.root), /separate-video-test-secret/);
  const external = await fixture(t, {
    handler: async (url, init) => {
      if (init.method === 'POST') return Response.json({ request_id: 'cdn-task' });
      if (url.startsWith('https://cdn.test/')) {
        assert.equal(init.headers?.Authorization, undefined);
        return new Response(Buffer.alloc(100));
      }
      return Response.json({ status: 'done', video: { url: '//cdn.test/video.mp4' } });
    },
  });
  const c = await external.jobs.create({ storyId: external.story.id, version: 1 });
  await eventually(async () => (await external.jobs.get(c.id)).status === 'ready');
});

test('视频等待状态展示供应商进度与查询时间，不虚构百分比、不暴露凭据', async (t) => {
  let generating = true;
  const f = await fixture(t, {
    handler: async (url, init) => {
      if (init.method === 'POST') return Response.json({ request_id: 'progress-task' });
      if (url.startsWith('https://cdn.test')) return new Response(Buffer.alloc(100));
      return Response.json(
        generating
          ? { status: 'queued', progress: 27 }
          : { status: 'done', video: { url: 'https://cdn.test/movie' } },
      );
    },
    jobOptions: { pollMs: 10 },
  });
  const j = await f.jobs.create({ storyId: f.story.id, version: 1 });
  const pending = await eventually(async () => {
    const s = f.jobs.summary(await f.jobs.get(j.id));
    return s.scenes[0].progress === 27 ? s : null;
  });
  assert.equal(pending.scenes[0].providerStatus, 'queued');
  assert.ok(Date.parse(pending.scenes[0].lastCheckedAt));
  assert.ok(Date.parse(pending.scenes[0].startedAt));
  assert.ok(pending.updatedAt);
  assert.doesNotMatch(JSON.stringify(pending), /progress-task|separate-video-test-secret/);
  generating = false;
  await eventually(async () => (await f.jobs.get(j.id)).status === 'ready');
  assert.equal(f.jobs.summary(await f.jobs.get(j.id)).scenes[0].progress, null);
});

test('下载失败恢复只查询原任务，不重新提交首镜头', async (t) => {
  let downloadFailed = true,
    count = 0;
  const f = await fixture(t, {
    handler: async (url, init) => {
      if (init.method === 'POST') return Response.json({ request_id: 'resume-task-' + ++count });
      if (url.endsWith('/content'))
        return downloadFailed ? new Response('', { status: 503 }) : new Response(Buffer.alloc(100));
      return Response.json({ status: 'done', video: { url: new URL(url).pathname + '/content' } });
    },
  });
  const j = await f.jobs.create({ storyId: f.story.id, version: 1 });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'paused');
  assert.equal(count, 1);
  downloadFailed = false;
  await f.jobs.action(j.id, { action: 'resume' });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'ready');
  assert.equal(count, 3);
  assert.equal((await f.jobs.get(j.id)).scenes[0].requestId, 'resume-task-1');
});
test('接口拒绝鉴权和路径错误可读且不回显原始密钥报错', async (t) => {
  for (const status of [401, 403, 404]) {
    const f = await fixture(t, {
      handler: async () =>
        Response.json({ error: { message: 'separate-video-test-secret' } }, { status }),
    });
    const j = await f.jobs.create({ storyId: f.story.id, version: 1 });
    await eventually(async () => (await f.jobs.get(j.id)).status === 'failed');
    const d = f.jobs.summary(await f.jobs.get(j.id));
    assert.doesNotMatch(JSON.stringify(d), /separate-video-test-secret/);
    assert.match(d.message, status === 401 ? /密钥/ : status === 403 ? /权限/ : /接口/);
    assert.equal((await f.jobs.create({ storyId: f.story.id, version: 1 })).id, j.id);
  }
});
test('提交超时或非JSON成功响应不得自动重发；需原编号或明确付费重做', async (t) => {
  for (const mode of ['timeout', 'html']) {
    const f = await fixture(t, {
      handler: async (url, init) => {
        if (mode === 'html') return new Response('<html>unknown</html>');
        return new Promise((resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      },
      jobOptions: { requestTimeoutMs: 20 },
    });
    const j = await f.jobs.create({ storyId: f.story.id, version: 1 });
    await eventually(async () => (await f.jobs.get(j.id)).status === 'needs_review');
    await f.jobs.action(j.id, { action: 'resume' });
    await eventually(async () => (await f.jobs.get(j.id)).status === 'needs_review');
    assert.equal(f.seen.length, 1);
    await assert.rejects(() => f.jobs.action(j.id, { action: 'retry', index: 0 }), /确认/);
    assert.equal((await f.jobs.create({ storyId: f.story.id, version: 1 })).id, j.id);
  }
});
test('服务重启保留已提交任务，未知提交不重发，可手动挂接编号', async (t) => {
  const f = await fixture(t);
  const j = await f.jobs.create({ storyId: f.story.id, version: 1 });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'ready');
  await f.jobs.close();
  let old = await f.jobs.get(j.id);
  old.status = 'running';
  old.scenes[2] = { status: 'submitting', prompt: old.scenes[2].prompt };
  await atomic(path.join(f.jobs.root, j.id, 'job.json'), old);
  const jobs = createVideoJobs({
    root: f.jobs.root,
    store: f.store,
    config: f.config,
    fetchImpl: f.fetchImpl,
    media: f.media,
    pollMs: 1,
  });
  t.after(() => jobs.close());
  await jobs.recover();
  await eventually(async () => (await jobs.get(j.id)).status === 'needs_review');
  const count = f.seen.length;
  await jobs.action(j.id, { action: 'attach', index: 2, requestId: 'existing-id' });
  await eventually(async () => (await jobs.get(j.id)).status === 'ready');
  assert.equal(f.seen.slice(count).filter((s) => s.init.method === 'POST').length, 0);
  assert.ok(f.seen.some((s) => s.url.endsWith('/videos/existing-id')));
});
test('等待超时只暂停查询，不重新生成；修改剧本后旧成片不能采用', async (t) => {
  let pending = true;
  const f = await fixture(t, {
    handler: async (url, init) =>
      url.startsWith('https://cdn')
        ? new Response(Buffer.alloc(100))
        : init.method === 'POST'
          ? Response.json({ request_id: 'retained-id' })
          : Response.json(
              pending
                ? { status: 'pending' }
                : { status: 'done', video: { url: 'https://cdn.test/movie' } },
            ),
    jobOptions: { maxWaitMs: 200 },
  });
  const j = await f.jobs.create({ storyId: f.story.id, version: 1 });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'paused');
  assert.equal(f.seen.filter((s) => s.init.method === 'POST').length, 1);
  pending = false;
  await f.jobs.action(j.id, { action: 'resume' });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'ready');
  await f.store.save({ ...f.story, title: '新版本' });
  await assert.rejects(
    () => f.jobs.action(j.id, { action: 'accept', previewConfirmed: true }),
    /旧版/,
  );
});
test('视频配置鉴权检查不提交计费视频，不把模型列表当权限验证', async (t) => {
  const f = await fixture(t, {
    handler: async () => Response.json({ data: [{ id: 'grok-imagine-video-1.5' }] }),
  });
  const r = await f.jobs.check();
  assert.equal(r.listed, true);
  assert.match(r.message, /不代表视频权限/);
  assert.ok(f.seen.every((s) => s.init.method !== 'POST'));
});
function videoStub() {
  return {
    src: '',
    paused: true,
    playCount: 0,
    pause() {
      this.paused = true;
    },
    load() {},
    removeAttribute() {
      this.src = '';
    },
    async play() {
      this.playCount++;
      this.paused = false;
      this.onplaying?.();
    },
  };
}
test('序幕暂停继续与单次结束、跳过、重置隔离旧回调', async () => {
  const video = videoStub(),
    p = Player.create({ video });
  let count = 0;
  const first = p.play('/movie').then((v) => {
    if (v) count++;
  });
  const old = video.onended;
  p.pause();
  assert.equal(p.state().paused, true);
  await p.resume();
  assert.equal(p.state().paused, false);
  p.skip();
  old();
  await first;
  assert.equal(count, 1);
  const second = p.play('/movie2'),
    stale = video.onended;
  p.cancel();
  assert.equal(await second, false);
  const third = p.play('/movie3');
  stale();
  assert.equal(p.state().active, true);
  video.onended();
  assert.equal(await third, true);
});
test('自动播放限制和媒体失败保持序幕等待，允许重试或跳过而不自动发牌', async () => {
  const video = videoStub(),
    messages = [];
  video.play = async () => {
    const e = Error();
    e.name = 'NotAllowedError';
    throw e;
  };
  const p = Player.create({ video, onError: (x) => messages.push(x) }),
    done = p.play('/movie');
  await new Promise((r) => setImmediate(r));
  assert.equal(p.state().blocked, true);
  assert.equal(p.state().active, true);
  video.onerror();
  assert.match(messages.at(-1), /加载失败/);
  p.skip();
  assert.equal(await done, true);
});

test('剧本HTTP路由来源校验、单席信息、整理独立长输出、静态白名单及MP4 Range', async (t) => {
  const f = await fixture(t),
    seen = [];
  const server = createServer({
    storyStore: f.store,
    videoConfigStore: { status: async () => ({ configured: false }) },
    videoJobs: f.jobs,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return Response.json(agentResponse(JSON.stringify(draft())));
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (route, body, origin = base) =>
    fetch(base + route, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const pub = await fetch(base + '/api/scenarios/' + f.story.id).then((r) => r.json());
  assert.doesNotMatch(JSON.stringify(pub), /私密往事/);
  const self = await fetch(base + '/api/scenarios/' + f.story.id + '/context/2?version=1').then(
    (r) => r.json(),
  );
  assert.doesNotMatch(JSON.stringify(self), /私密往事2/);
  assert.doesNotMatch(JSON.stringify(self), /私密往事1/);
  assert.equal((await post('/api/scenarios', draft(), 'https://evil.test')).status, 403);
  assert.equal((await post('/api/video-config', {}, 'https://evil.test')).status, 403);
  const prepared = await post('/api/scenarios/prepare', {
    source: '六位成年人的庄园故事',
    endpoint: 'https://chat.test',
    model: 'selected-agent',
    apiKey: 'only-chat-test-key',
  });
  assert.equal(prepared.status, 200);
  const req = JSON.parse(seen[0].init.body);
  assert.equal(req.model, 'selected-agent');
  assert.equal(req.max_output_tokens, 25000);
  assert.equal(req.reasoning.effort, 'medium');
  assert.equal(req.temperature, undefined);
  assert.equal(seen[0].init.headers.Authorization, 'Bearer only-chat-test-key');
  assert.doesNotMatch(await fileText(f.root), /only-chat-test-key/);
  for (const route of ['/scenario-settings.html', '/story-player.js', '/story-game.js'])
    assert.equal((await fetch(base + route)).status, 200);
  for (const route of [
    '/video-config.cjs',
    '/scenario-store.cjs',
    '/video-provider.json',
    '/story-api.cjs',
  ])
    assert.equal((await fetch(base + route)).status, 404);
  const j = await f.jobs.create({ storyId: f.story.id, version: 1 });
  await eventually(async () => (await f.jobs.get(j.id)).status === 'ready');
  const range = await fetch(base + '/api/story-media/' + j.id + '/intro.mp4', {
    headers: { Range: 'bytes=2-8' },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 7);
  assert.match(range.headers.get('content-range'), /^bytes 2-8\//);
  assert.equal(
    (
      await fetch(base + '/api/story-media/' + j.id + '/intro.mp4', {
        headers: { Range: 'bytes=99999-' },
      })
    ).status,
    416,
  );
  assert.equal((await fetch(base + '/api/story-media/' + j.id + '/job.json')).status, 404);
});

// A user pause aborts a still-pending play promise; it is not a media failure.
test('序幕快速暂停不误报，旧播放失败不能覆盖恢复后的状态', async () => {
  const video = videoStub(),
    errors = [],
    attempts = [];
  video.play = () => new Promise((resolve, reject) => attempts.push({ resolve, reject }));
  const p = Player.create({ video, onError: (e) => errors.push(e) }),
    done = p.play('/movie');
  p.pause();
  const resumed = p.resume();
  attempts[0].reject(Object.assign(Error(), { name: 'AbortError' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(p.state().blocked, false);
  assert.equal(p.state().paused, false);
  assert.deepEqual(errors, []);
  attempts[1].resolve();
  await resumed;
  p.cancel();
  assert.equal(await done, false);
});

test('未配置姓名条不阻止基础视频生成，任务保留原片且不提前合成姓名条', async (t) => {
  const f = await fixture(t),
    story = await f.store.save({
      ...f.story,
      introductions: { enabled: true, confirmed: false, markers: [] },
    });
  const created = await f.jobs.create({ storyId: story.id, version: story.version });
  await eventually(async () => (await f.jobs.get(created.id)).status === 'ready');
  const job = await f.jobs.get(created.id);
  assert.equal(job.introStory, undefined);
  assert.equal(job.status, 'ready');
  assert.equal(f.seen.filter((x) => x.init.method === 'POST').length, 3);
  assert.equal(
    await f.jobs.mediaFile(job.id, 'intro.mp4').then((p) => path.basename(p)),
    'intro.mp4',
  );
});
