'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  { once } = require('node:events');
const S = require('./scenario.js'),
  { createStoryArtJobs, normalizeImage } = require('./story-art-jobs.cjs'),
  { createImageProvider } = require('./image-provider.cjs');
const { createScenarioStore, atomic } = require('./scenario-store.cjs'),
  { createVideoJobs } = require('./video-jobs.cjs'),
  { createServer } = require('./server.cjs');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=',
  'base64',
);
function legacySample() {
  const s = S.bloodMoonSample();
  delete s.cinematic;
  delete s.targetDuration;
  s.scenes = s.scenes
    .slice(0, 6)
    .map(({ duration, dialogues, narrationSeconds, ...scene }) => scene);
  return s;
}
async function until(fn) {
  for (let i = 0; i < 800; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error('timeout');
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nightfall-art-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createScenarioStore(root),
    sample =
      options.sample ||
      (options.cinematic ? S.bloodMoonSample(options.roomSize || 6) : legacySample()),
    story = await store.save({
      ...sample,
      confirmed: true,
      scenes: sample.scenes.map((s, i) =>
        options.cinematic ? s : { ...s, cast: i === 0 ? [] : i === 1 ? [1, 2] : [2, 3, 4, 5, 6] },
      ),
    }),
    calls = [];
  const config = {
    loadCredential: async () => ({
      provider: 'https://images.test',
      model: 'gpt-image-2',
      apiKey: 'independent-image-secret',
    }),
    status: async () => ({
      configured: true,
      provider: 'https://images.test/v1',
      model: 'gpt-image-2',
    }),
  };
  const provider = {
    generate: async (args) => {
      calls.push(args);
      if (options.generate) return options.generate(args, calls.length);
      return Buffer.concat([png, Buffer.from(String(calls.length))]);
    },
  };
  const settings = {
    root: path.join(root, 'art'),
    store,
    config,
    provider,
    references: options.references,
    normalize: async (bytes, dest) => fs.writeFile(dest, bytes),
  };
  const art = createStoryArtJobs(settings);
  t.after(() => art.close());
  return { root, store, story, calls, config, provider, settings, art };
}
const start = async (f) => {
  const j = await f.art.create({ storyId: f.story.id, version: 1, confirmCharge: true });
  await until(async () => {
    const v = await f.art.get(j.id);
    return v.status !== 'running' && v;
  });
  return f.art.get(j.id);
};
async function confirmItems(f, j, kind) {
  const items = kind === 'character' ? j.characters : j.frames;
  for (let i = 0; i < items.length; i++)
    await f.art.action(j.id, {
      action: kind === 'character' ? 'confirmCharacter' : 'confirmFrame',
      kind,
      index: i,
      revision: j.revision,
    });
}
async function approved(f) {
  let j = await start(f);
  await confirmItems(f, j, 'character');
  await f.art.action(j.id, { action: 'confirmCharacters', revision: j.revision });
  await f.art.action(j.id, { action: 'generateFrames', revision: j.revision, confirmCharge: true });
  j = await until(async () => {
    const v = await f.art.get(j.id);
    return v.status === 'review' && v.frames.every((x) => x.status === 'done') && v;
  });
  await confirmItems(f, j, 'frame');
  await f.art.action(j.id, { action: 'confirmFrames', revision: j.revision });
  return f.art.get(j.id);
}

test('外观与出场人物校验、旧草稿兼容，公开外观进入 Agent 上下文且秘密隔离', () => {
  const s = legacySample();
  s.characters[0].appearance = '成年红发女性';
  s.characters[0].portraitId = 'portrait-04';
  s.scenes[0].cast = [6, 1];
  const clean = S.validate(s);
  assert.deepEqual(clean.scenes[0].cast, [1, 6]);
  assert.throws(() =>
    S.validate({ ...s, scenes: s.scenes.map((x, i) => (i ? x : { ...x, cast: [1, 1] })) }),
  );
  assert.throws(() =>
    S.validate({
      ...s,
      characters: s.characters.map((c, i) => (i ? c : { ...c, portraitId: '../../secret' })),
    }),
  );
  const context = JSON.stringify(S.context(clean, 1));
  assert.ok(context.includes('appearance'));
  assert.ok(context.includes('portrait-04'));
  assert.ok(!context.includes('cast'));
  assert.ok(!context.includes(s.characters[0].secret));
  assert.equal(S.videoPlan(s, 'story60-refs-v1').targetDuration, 60);
});

test('无人物参考视频不注入全剧人物或下一镜剧情，旧结束画面不引入无参考来客', () => {
  const s = legacySample();
  s.scenes[0].cast = [];
  s.scenes[0].endFrame = '一位来客手中举起信封';
  s.scenes[1].description = 'NEXT_SHOT_GUESTS';
  const prompt = S.referenceVideoPrompt(
    s,
    0,
    s.characters.map((c) => ({ ...c, appearance: S.appearance(c) })),
  );
  assert.match(prompt, /ENVIRONMENT ONLY for the entire 10 seconds/);
  assert.match(prompt, /no people, faces, hands/);
  assert.ok(prompt.includes(s.scenes[0].description));
  assert.ok(!prompt.includes(s.scenes[0].endFrame));
  assert.ok(!prompt.includes('NEXT_SHOT_GUESTS'));
  assert.ok(!prompt.includes(s.background));
  assert.ok(!prompt.includes(s.visualGuide));
  for (const c of s.characters) {
    assert.ok(!prompt.includes(c.name));
    assert.ok(!prompt.includes(c.secret));
  }
});

test('人物视频只引用本镜已绑定人物，外观以定妆快照为准，不混用全剧服饰设定', () => {
  const s = legacySample();
  s.scenes[1].cast = [2, 6];
  s.visualGuide = 'CONFLICTING_GLOBAL_OUTFIT';
  const characters = s.characters.map((c) => ({
      ...c,
      appearance: 'SNAPSHOT_APPEARANCE_' + c.seat,
    })),
    prompt = S.referenceVideoPrompt(s, 1, characters);
  assert.match(prompt, /<IMAGE_1> is 2/);
  assert.match(prompt, /<IMAGE_2> is 6/);
  assert.match(prompt, /Only these 2 cast members/);
  assert.ok(prompt.includes('SNAPSHOT_APPEARANCE_2'));
  assert.ok(prompt.includes('SNAPSHOT_APPEARANCE_6'));
  assert.ok(!prompt.includes('SNAPSHOT_APPEARANCE_1'));
  assert.ok(!prompt.includes('CONFLICTING_GLOBAL_OUTFIT'));
  assert.ok(!prompt.includes(s.scenes[2].description));
});
test('六人前三镜使用手部与邀请函连续性提示的局部版本', async (t) => {
  const f = await fixture(t, { cinematic: true });
  let j = await start(f);
  await confirmItems(f, j, 'character');
  await f.art.action(j.id, { action: 'confirmCharacters', revision: j.revision });
  await f.art.action(j.id, { action: 'generateFrames', revision: j.revision, confirmCharge: true });
  j = await until(async () => {
    const current = await f.art.get(j.id);
    return (
      current.status === 'review' && current.frames.every((x) => x.status === 'done') && current
    );
  });
  assert.equal(j.frames[0].promptVersion, 'workshop-art-v7-hand-opening');
  assert.equal(j.frames[1].promptVersion, 'workshop-art-v7-hand-opening');
  assert.equal(j.frames[2].promptVersion, 'workshop-art-v7-hand-opening');
  assert.equal(j.frames[3].promptVersion, 'workshop-art-v3');
  for (const frame of j.frames.slice(0, 3)) {
    assert.match(frame.prompt, /five fingers/i);
    assert.match(frame.prompt, /envelope/i);
    assert.match(frame.prompt, /hand|palm/i);
  }
  assert.match(j.frames[0].prompt, /palm[^.]*never beneath it/i);
  assert.match(j.frames[1].prompt, /lantern handoff and corridor movement happen in the video/i);
  assert.match(j.frames[2].prompt, /copy the preceding storyboard reference/i);
  assert.match(j.frames[2].prompt, /only Vera holds the invitation/i);
  assert.equal(f.calls.length, 6 + f.story.scenes.length);
});

test('六张人物依次保存、并发点击去重、确认门槛及分镜只携带出场人物', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.art.create({ storyId: f.story.id, version: 1 }), {
    code: 'CHARGE_CONFIRM_REQUIRED',
  });
  const [one, two] = await Promise.all([
    f.art.create({ storyId: f.story.id, version: 1, confirmCharge: true }),
    f.art.create({ storyId: f.story.id, version: 1, confirmCharge: true }),
  ]);
  assert.equal(one.id, two.id);
  await until(async () => f.calls.length === 6 && (await f.art.get(one.id)).status === 'review');
  assert.equal(f.calls.length, 6);
  for (let i = 0; i < 6; i++)
    assert.deepEqual(
      f.calls[i].references[0],
      await fs.readFile('assets/manor/portrait-0' + (i + 1) + '.webp'),
    );
  await assert.rejects(
    () => f.art.action(one.id, { action: 'generateFrames', revision: 1, confirmCharge: true }),
    { code: 'CHARACTERS_NOT_CONFIRMED' },
  );
  await assert.rejects(() => f.art.action(one.id, { action: 'confirmFrames', revision: 1 }), {
    code: 'FRAMES_NOT_READY',
  });
  await confirmItems(f, await f.art.get(one.id), 'character');
  await f.art.action(one.id, { action: 'confirmCharacters', revision: 1 });
  await assert.rejects(() => f.art.action(one.id, { action: 'resume', revision: 1 }), {
    code: 'CHARGE_CONFIRM_REQUIRED',
  });
  assert.equal(f.calls.length, 6);
  await f.art.action(one.id, { action: 'generateFrames', revision: 1, confirmCharge: true });
  await until(async () => f.calls.length === 12 && (await f.art.get(one.id)).status === 'review');
  assert.equal(f.calls[6].references.length, 1);
  assert.deepEqual(f.calls[6].references[0], await fs.readFile('assets/manor/manor-room.webp'));
  assert.match(f.calls[6].prompt, /Environment only, no people/);
  assert.equal(f.calls[7].references.length, 2);
  assert.deepEqual(f.calls[7].references[0], Buffer.concat([png, Buffer.from('1')]));
  assert.deepEqual(f.calls[7].references[1], Buffer.concat([png, Buffer.from('2')]));
  for (const call of f.calls)
    for (const c of f.story.characters) assert.ok(!call.prompt.includes(c.secret));
  const j = await f.art.get(one.id);
  assert.equal(j.framesConfirmed, false);
  await confirmItems(f, await f.art.get(j.id), 'frame');
  await f.art.action(j.id, { action: 'confirmFrames', revision: 1 });
  assert.equal((await f.art.get(j.id)).framesConfirmed, true);
});

test('12 人电影任务按实际镜数提交、对白音色与图片字节正确、恢复与费用去重', async (t) => {
  const f = await fixture(t, { cinematic: true, roomSize: 12 }),
    j = await approved(f),
    sent = [],
    normalized = [];
  let failAssembly = true;
  assert.equal(j.frames.length, 12);
  assert.equal(f.calls.length, 24);
  assert.equal(
    await f.art.mediaFile(j.id, j.frames[11].file),
    path.join(f.settings.root, j.id, j.frames[11].file),
  );
  const opts = {
    root: path.join(f.root, 'videos'),
    store: f.store,
    artJobs: f.art,
    config: {
      loadCredential: async () => ({
        provider: 'https://video.test/v1',
        model: 'grok-imagine-video-1.5',
        apiKey: 'cinema-only-key',
      }),
    },
    pollMs: 1,
    media: {
      available: async () => true,
      prepareNarration: async () => {},
      normalize: async (src, out, options) => {
        normalized.push(options);
        await fs.writeFile(out, 'movie');
      },
      assemble: async (dir) => {
        if (failAssembly) throw Error('interrupted');
        await fs.writeFile(path.join(dir, 'intro.mp4'), 'movie');
      },
    },
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') {
        sent.push(JSON.parse(init.body));
        return Response.json({ request_id: 'cinema-' + sent.length });
      }
      return url.startsWith('https://cdn.test')
        ? new Response(Buffer.alloc(100))
        : Response.json({ status: 'done', video: { url: 'https://cdn.test/clip' } });
    },
  };
  const video = createVideoJobs(opts);
  t.after(() => video.close());
  const request = {
    storyId: f.story.id,
    version: 1,
    artId: j.id,
    artRevision: j.revision,
    profile: 'cinema-refs-v1',
  };
  await assert.rejects(() => video.create(request), { code: 'CHARGE_CONFIRM_REQUIRED' });
  assert.equal(sent.length, 0);
  const [a, b] = await Promise.all([
    video.create({ ...request, confirmCharge: true }),
    video.create({ ...request, confirmCharge: true }),
  ]);
  assert.equal(a.id, b.id);
  await until(async () => {
    const x = await video.get(a.id);
    return x.status === 'paused' && x.scenes.every((s) => s.status === 'done');
  });
  assert.equal(sent.length, 12);
  for (let i = 0; i < sent.length; i++) {
    const scene = f.story.scenes[i],
      body = sent[i];
    assert.equal(body.duration, scene.duration);
    assert.equal(body.generate_audio, scene.dialogues.length > 0);
    assert.deepEqual(
      body.reference_audios || [],
      S.audioReferences(f.story, i).map(({ voice_id }) => ({ voice_id })),
    );
    assert.equal(body.reference_images.length, scene.cast.length);
    assert.deepEqual(
      Buffer.from(body.image.url.split(',')[1], 'base64'),
      await fs.readFile(path.join(f.settings.root, j.id, j.frames[i].file)),
    );
    for (let n = 0; n < scene.cast.length; n++)
      assert.deepEqual(
        Buffer.from(body.reference_images[n].url.split(',')[1], 'base64'),
        await fs.readFile(path.join(f.settings.root, j.id, j.characters[scene.cast[n] - 1].file)),
      );
    for (const line of scene.dialogues) {
      const character = f.story.characters[line.seat - 1],
        image = scene.cast.indexOf(line.seat) + 1,
        audio = S.audioReferences(f.story, i).findIndex((ref) => ref.seat === line.seat);
      assert.ok(body.prompt.includes(line.text));
      assert.ok(
        body.prompt.includes(
          'shown in <IMAGE_' +
            image +
            '>. Only this character speaks with <AUDIO_' +
            audio +
            '> (preset ' +
            S.voiceId(character) +
            ')',
        ),
      );
      assert.ok(
        body.prompt.includes(
          S.characterGender(character) === 'female' ? 'woman, FEMALE voice' : 'man, MALE voice',
        ),
      );
    }
    for (const c of f.story.characters) assert.ok(!body.prompt.includes(c.secret));
  }
  assert.deepEqual(
    normalized.map((x) => x.duration),
    f.story.scenes.map((x) => x.duration),
  );
  assert.deepEqual(
    normalized.map((x) => x.audioMode),
    f.story.scenes.map((scene) => (scene.dialogues.length ? 'dialogue-narration' : 'unified')),
  );
  const stored = await video.get(a.id);
  assert.equal(stored.roomSize, 12);
  assert.deepEqual(stored.voiceMap, S.videoPlan(f.story).voiceMap);
  assert.equal(stored.scenes[1].inputAudit.promptVersion, 4);
  assert.equal(video.summary(stored).sceneDuration, null);
  assert.deepEqual(stored.voiceCharacters, f.story.characters.map(S.voiceSnapshot));
  assert.deepEqual(
    stored.scenes[1].inputAudit.voiceCharacters,
    f.story.scenes[1].cast.map((seat) => S.voiceSnapshot(f.story.characters[seat - 1])),
  );
  await video.close();
  failAssembly = false;
  const restored = createVideoJobs(opts);
  t.after(() => restored.close());
  await restored.action(a.id, { action: 'resume' });
  await until(async () => (await restored.get(a.id)).status === 'ready');
  assert.equal(sent.length, 12);
  assert.ok((await restored.mediaFile(a.id, 'scene-11.mp4')).endsWith('scene-11.mp4'));
  await assert.rejects(() => restored.mediaFile(a.id, 'scene-12.mp4'));
  assert.equal(
    (await restored.create(request)).id,
    a.id,
    'completed task is reused without requiring a second charge confirmation',
  );
  await restored.action(a.id, { action: 'retry', index: 11, confirmCharge: true });
  await until(async () => (await restored.get(a.id)).status === 'ready');
  assert.equal(sent.length, 13);
});

test('视频服务 HTTP 503 显示可判断的暂不可用原因并保留显式重做保护', async (t) => {
  const f = await fixture(t, { cinematic: true, roomSize: 12 }),
    art = await approved(f);
  let posts = 0;
  const videos = createVideoJobs({
    root: path.join(f.root, 'videos'),
    store: f.store,
    artJobs: f.art,
    pollMs: 1,
    config: {
      loadCredential: async () => ({
        provider: 'https://video.test/v1',
        model: 'grok-imagine-video-1.5',
        apiKey: 'never-echo-key',
      }),
    },
    media: { available: async () => true, prepareNarration: async () => {} },
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') {
        posts++;
        return Response.json(
          {
            error: {
              code: 'upstream_overloaded',
              message: 'temporarily unavailable Bearer never-echo-key',
            },
          },
          { status: 503 },
        );
      }
      throw Error('unexpected');
    },
  });
  t.after(() => videos.close());
  const job = await videos.create({
    storyId: f.story.id,
    version: 1,
    artId: art.id,
    artRevision: art.revision,
    profile: 'cinema-refs-v1',
    confirmCharge: true,
  });
  const failed = await until(async () => {
    const value = await videos.get(job.id);
    return value.status === 'failed' && value;
  });
  assert.equal(posts, 1);
  assert.match(failed.scenes[0].message, /暂不可用/);
  assert.match(failed.scenes[0].message, /不是模型参数错误/);
  assert.match(failed.scenes[0].message, /upstream_overloaded/);
  assert.match(failed.scenes[0].message, /temporarily unavailable/);
  assert.equal(failed.scenes[0].requestId, undefined);
  assert.equal(failed.scenes[0].status, 'failed');
  assert.ok(!JSON.stringify(failed).includes('never-echo-key'));
  const legacy = videos.summary({
    ...failed,
    message: '视频接口返回错误，请核对模型、原生音频与参数支持（HTTP 503）',
    scenes: failed.scenes.map((scene, index) =>
      index === 0
        ? { ...scene, message: '视频接口返回错误，请核对模型、原生音频与参数支持（HTTP 503）' }
        : scene,
    ),
  });
  assert.match(legacy.scenes[0].message, /不是模型参数错误/);
  assert.match(legacy.message, /暂不可用/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(posts, 1, '明确失败的镜头不应自动重复提交');
});
test('电影音色字段被拒绝时停止，不重发或退回无对白，保留已完成镜头', async (t) => {
  const f = await fixture(t, { cinematic: true }),
    art = await approved(f);
  let posts = 0;
  const videos = createVideoJobs({
    root: path.join(f.root, 'videos'),
    store: f.store,
    artJobs: f.art,
    pollMs: 1,
    config: {
      loadCredential: async () => ({
        provider: 'https://video.test/v1',
        model: 'grok-imagine-video-1.5',
        apiKey: 'never-echo-key',
      }),
    },
    media: {
      available: async () => true,
      prepareNarration: async () => {},
      normalize: async (src, out) => fs.writeFile(out, 'movie'),
    },
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') {
        posts++;
        return posts === 2
          ? Response.json(
              {
                error: {
                  code: 'unsupported_reference_audios',
                  message: 'never-echo-key unsupported voice_id',
                },
              },
              { status: 400 },
            )
          : Response.json({ request_id: 'first' });
      }
      return url.startsWith('https://cdn.test')
        ? new Response(Buffer.alloc(100))
        : Response.json({ status: 'done', video: { url: 'https://cdn.test/clip' } });
    },
  });
  t.after(() => videos.close());
  const j = await videos.create({
    storyId: f.story.id,
    version: 1,
    artId: art.id,
    artRevision: 1,
    confirmCharge: true,
  });
  const failed = await until(async () => {
    const x = await videos.get(j.id);
    return x.status === 'failed' && x;
  });
  assert.equal(posts, 2);
  assert.equal(failed.scenes[0].status, 'done');
  assert.equal(failed.scenes[1].status, 'failed');
  assert.match(failed.message, /参考音色/);
  assert.ok(!JSON.stringify(failed).includes('never-echo-key'));
  await videos.action(j.id, { action: 'resume' });
  await until(async () => (await videos.get(j.id)).status === 'failed');
  assert.equal(posts, 2);
});
test('单张人物重做只生成一次，精确失效相关分镜并保留旧素材与提示词', async (t) => {
  const f = await fixture(t),
    j = await approved(f),
    old = j.characters[0].file,
    frames = j.frames.map((x) => x.file);
  assert.equal(f.calls.length, 12);
  await f.art.action(j.id, {
    action: 'retry',
    kind: 'character',
    index: 0,
    revision: 1,
    description: '成年女性，赤褐长发，黑金长裙，红宝石耳饰',
    confirmCharge: true,
  });
  const latest = await until(async () => {
    const x = await f.art.get(j.id);
    return x.status !== 'running' && x.characters[0].file && x.characters[0].file !== old && x;
  });
  assert.equal(f.calls.length, 13);
  assert.equal(latest.revision, 2);
  assert.equal(latest.charactersConfirmed, false);
  assert.equal(latest.framesConfirmed, false);
  assert.equal(latest.frames[1].status, 'done');
  assert.equal(latest.frames[1].needsReview, true);
  assert.equal(latest.frames[1].confirmedAt, null);
  for (const i of [0, 2, 3, 4, 5]) assert.equal(latest.frames[i].file, frames[i]);
  assert.ok(latest.history.some((h) => h.file === old && h.prompt && h.revision === 1));
  assert.equal(await f.art.mediaFile(j.id, old), path.join(f.settings.root, j.id, old));
  await assert.rejects(() => f.art.action(j.id, { action: 'confirmCharacters', revision: 1 }), {
    code: 'ART_CONFLICT',
  });
  await confirmItems(f, await f.art.get(j.id), 'character');
  await f.art.action(j.id, { action: 'confirmCharacters', revision: 2 });
  await f.art.action(j.id, { action: 'generateFrames', revision: 2, confirmCharge: true });
  await until(async () => (await f.art.get(j.id)).frames[1].status === 'done');
  await confirmItems(f, await f.art.get(j.id), 'frame');
  await f.art.action(j.id, { action: 'confirmFrames', revision: 2 });
  assert.equal(f.calls.length, 13);
});
test('兼容剧本版本逐张复用人物图和分镜图，记录来源且不发起图片请求', async (t) => {
  const f = await fixture(t),
    first = await approved(f),
    calls = f.calls.length;
  const secondStory = await f.store.save({ ...f.story, version: 1, confirmed: true });
  assert.equal(secondStory.version, 2);
  const second = await f.art.create({ storyId: secondStory.id, version: 2, confirmCharge: true });
  const characters = await until(async () => {
    const x = await f.art.get(second.id);
    return x.status === 'review' && x.characters.every((c) => c.status === 'done') && x;
  });
  assert.equal(f.calls.length, calls);
  assert.ok(characters.characters.every((c) => c.reuse?.taskId === first.id));
  await confirmItems(f, characters, 'character');
  await f.art.action(second.id, { action: 'confirmCharacters', revision: 1 });
  await f.art.action(second.id, { action: 'generateFrames', revision: 1, confirmCharge: true });
  const frames = await until(async () => {
    const x = await f.art.get(second.id);
    return x.status === 'review' && x.frames.every((f) => f.status === 'done') && x;
  });
  assert.equal(f.calls.length, calls);
  assert.ok(frames.frames.every((frame) => frame.reuse?.taskId === first.id));
});
test('逐项确认拦截整组确认，恢复历史图保留文件并清除当前确认', async (t) => {
  const f = await fixture(t),
    j = await approved(f),
    old = j.frames[0].file;
  await f.art.action(j.id, {
    action: 'retry',
    kind: 'frame',
    index: 0,
    revision: j.revision,
    confirmCharge: true,
  });
  const changed = await until(async () => {
    const x = await f.art.get(j.id);
    return x.status === 'review' && x.frames[0].file !== old && x;
  });
  await assert.rejects(
    () => f.art.action(j.id, { action: 'confirmFrames', revision: changed.revision }),
    { code: 'FRAMES_NOT_READY' },
  );
  const restored = await f.art.action(j.id, {
    action: 'restoreAssetRevision',
    kind: 'frame',
    index: 0,
    file: old,
    revision: changed.revision,
  });
  assert.equal(restored.frames[0].file, old);
  assert.equal(restored.frames[0].confirmedAt, null);
  assert.ok(restored.history.some((item) => item.file === changed.frames[0].file));
  assert.equal(f.calls.length, 13);
});
test('十二人人物任务完整保存恢复，参考素材缺失时不提交图片', async (t) => {
  const f = await fixture(t),
    s = await f.store.save({ ...S.bloodMoonSample(12), confirmed: true });
  const empty = path.join(f.root, 'missing-assets');
  await fs.mkdir(empty);
  const missing = createStoryArtJobs({ ...f.settings, assetRoot: empty });
  t.after(() => missing.close());
  await assert.rejects(missing.create({ storyId: s.id, version: 1, confirmCharge: true }), {
    code: 'PORTRAIT_MISSING',
  });
  assert.equal(f.calls.length, 0);
  const ready = s;
  const j = await f.art.create({ storyId: ready.id, version: ready.version, confirmCharge: true });
  await until(async () => (await f.art.get(j.id)).status === 'review');
  const done = await f.art.get(j.id);
  assert.equal(done.roomSize, 12);
  assert.equal(done.characters.length, 12);
  assert.equal(f.calls.length, 12);
  assert.equal(done.characters[11].seat, 12);
  await f.art.close();
  const restored = createStoryArtJobs(f.settings);
  t.after(() => restored.close());
  await restored.recover();
  const back = await restored.get(j.id);
  assert.equal(back.characters[11].file, done.characters[11].file);
  assert.equal(f.calls.length, 12);
});

test('未知提交不自动重发，重启恢复保留成功图片与源立绘快照', async (t) => {
  const f = await fixture(t, {
      generate: async (args, n) => {
        if (n === 2) throw Error('connection lost including secret');
        return png;
      },
    }),
    j = await start(f);
  assert.equal(j.status, 'needs_review');
  assert.equal(f.calls.length, 2);
  assert.equal(j.characters[0].status, 'done');
  assert.equal(j.characters[1].status, 'unknown');
  await f.art.close();
  const restored = createStoryArtJobs(f.settings);
  t.after(() => restored.close());
  await restored.recover();
  assert.equal(f.calls.length, 2);
  const after = await restored.get(j.id);
  assert.equal(after.characters[0].file, j.characters[0].file);
  await assert.rejects(() => restored.action(j.id, { action: 'resume', revision: 1 }), {
    code: 'ART_REVIEW_REQUIRED',
  });
  await restored.action(j.id, {
    action: 'retry',
    kind: 'character',
    index: 1,
    revision: 1,
    confirmCharge: true,
    reconciled: true,
  });
  await until(async () => (await restored.get(j.id)).characters[1].status === 'done');
  assert.equal(f.calls.length, 3);
  assert.equal((await restored.get(j.id)).characters[2].status, 'queued');
  assert.deepEqual(
    await fs.readFile(path.join(f.settings.root, j.id, 'source-1.webp')),
    await fs.readFile('assets/manor/portrait-01.webp'),
  );
  assert.ok(!JSON.stringify(restored.summary(after)).includes('connection lost'));
  assert.ok(!JSON.stringify(after).includes('independent-image-secret'));
});
test('成功返回的原始图片先落盘，本地处理失败后可免费恢复且不重新调用模型', async (t) => {
  const f = await fixture(t);
  let okay = false;
  await f.art.close();
  const art = createStoryArtJobs({
    ...f.settings,
    normalize: async (bytes, dest) => {
      if (!okay) throw Error('decode failed');
      await fs.writeFile(dest, bytes);
    },
  });
  t.after(() => art.close());
  const j = await art.create({ storyId: f.story.id, version: 1, confirmCharge: true });
  await until(async () => (await art.get(j.id)).status === 'failed');
  assert.equal(f.calls.length, 1);
  let latest = await art.get(j.id);
  assert.equal(latest.characters[0].status, 'saved_raw');
  assert.ok(latest.characters[0].received);
  okay = true;
  await art.action(j.id, { action: 'processSaved', revision: 1, kind: 'character', index: 0 });
  latest = await art.get(j.id);
  assert.equal(latest.characters[0].status, 'done');
  assert.equal(f.calls.length, 1);
});
test('图片供应商请求确实包含立绘字节，异常响应不重发，CDN不携带密钥', async () => {
  const seen = [],
    config = {
      loadCredential: async () => ({
        provider: 'https://api-fast.hualong-ai.com',
        model: 'gpt-image-2.5-sunburst',
        apiKey: 'image-test-secret',
      }),
    };
  const p = createImageProvider({
    config,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return init.method === 'POST'
        ? Response.json({ data: [{ url: 'https://cdn.example/image.png' }] })
        : new Response(png);
    },
  });
  assert.deepEqual(
    await p.generate({ prompt: 'one adult', references: [png, png], size: '1536x864' }),
    png,
  );
  const form = seen[0].init.body;
  assert.equal(seen[0].url, 'https://api-fast.hualong-ai.com/v1/images/edits');
  assert.equal(form.get('model'), 'gpt-image-2.5-sunburst');
  assert.equal(form.get('n'), '1');
  assert.equal(form.getAll('image[]').length, 2);
  assert.deepEqual(Buffer.from(await form.getAll('image[]')[0].arrayBuffer()), png);
  assert.equal(seen[1].init.headers, undefined);
  for (const response of [
    new Response('html'),
    Response.json({ data: [] }),
    Response.json({ error: { message: 'image-test-secret' } }, { status: 503 }),
  ]) {
    let count = 0;
    const bad = createImageProvider({
      config,
      fetchImpl: async () => {
        count++;
        return response;
      },
    });
    await assert.rejects(
      () => bad.generate({ prompt: 'public', references: [png], size: '1024x1536' }),
      (e) => !e.message.includes('image-test-secret'),
    );
    assert.equal(count, 1);
  }
});
test('参考视频绑定确认快照、Base64内容与编号顺序正确；去重、恢复和单镜失败不退回纯文本', async (t) => {
  const f = await fixture(t),
    j = await approved(f),
    sent = [];
  const config = {
    loadCredential: async () => ({
      provider: 'https://video.test/v1',
      model: 'grok-imagine-video-1.5',
      apiKey: 'video-only-secret',
    }),
  };
  const media = {
    available: async () => true,
    prepareNarration: async () => {},
    normalize: async (src, out) => fs.writeFile(out, 'movie'),
    assemble: async (dir) => fs.writeFile(path.join(dir, 'intro.mp4'), 'movie'),
  };
  const opts = {
    root: path.join(f.root, 'videos'),
    store: f.store,
    config,
    artJobs: f.art,
    media,
    pollMs: 1,
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') {
        sent.push(JSON.parse(init.body));
        return Response.json({ request_id: 'clip-' + sent.length });
      }
      if (url.startsWith('https://cdn.test')) return new Response(Buffer.alloc(100));
      return Response.json({ status: 'done', video: { url: 'https://cdn.test/clip' } });
    },
  };
  const videos = createVideoJobs(opts);
  t.after(() => videos.close());
  await assert.rejects(() =>
    videos.create({ storyId: f.story.id, version: 1, profile: 'story60-refs-v1' }),
  );
  const request = {
    storyId: f.story.id,
    version: 1,
    profile: 'story60-refs-v1',
    artId: j.id,
    artRevision: 1,
  };
  const [a, b] = await Promise.all([videos.create(request), videos.create(request)]);
  assert.equal(a.id, b.id);
  await until(async () => (await videos.get(a.id)).status === 'ready');
  assert.equal(sent.length, 6);
  assert.equal(sent[0].reference_images.length, 0);
  assert.equal(sent[1].reference_images.length, 2);
  assert.match(sent[1].prompt, /<IMAGE_0>.*starting frame/);
  assert.match(sent[1].prompt, /<IMAGE_1> is 1/);
  assert.match(sent[1].prompt, /<IMAGE_2> is 2/);
  assert.deepEqual(
    Buffer.from(sent[1].image.url.split(',')[1], 'base64'),
    await fs.readFile(path.join(f.settings.root, j.id, j.frames[1].file)),
  );
  assert.deepEqual(
    Buffer.from(sent[1].reference_images[1].url.split(',')[1], 'base64'),
    await fs.readFile(path.join(f.settings.root, j.id, j.characters[1].file)),
  );
  for (const payload of sent) {
    assert.equal(payload.duration, 10);
    assert.equal(payload.resolution, '720p');
    assert.equal(payload.generate_audio, false);
    for (const c of f.story.characters) assert.ok(!payload.prompt.includes(c.secret));
  }
  const saved = await fs.readFile(path.join(opts.root, a.id, 'job.json'), 'utf8');
  assert.ok(!saved.includes('base64'));
  assert.ok(!saved.includes('video-only-secret'));
  const snap = await videos.get(a.id),
    snapBytes = await fs.readFile(path.join(opts.root, a.id, snap.art.characters[0].file));
  for (let i = 0; i < sent.length; i++) {
    const audit = snap.scenes[i].inputAudit,
      hash = (bytes) => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    assert.equal(audit.promptVersion, 2);
    assert.equal(audit.promptSha256, hash(sent[i].prompt));
    assert.equal(
      audit.startingFrame.sha256,
      hash(Buffer.from(sent[i].image.url.split(',')[1], 'base64')),
    );
    assert.deepEqual(
      audit.characters.map((c) => c.seat),
      snap.art.frames[i].cast,
    );
    for (let n = 0; n < audit.characters.length; n++)
      assert.equal(
        audit.characters[n].sha256,
        hash(Buffer.from(sent[i].reference_images[n].url.split(',')[1], 'base64')),
      );
  }
  await f.art.action(j.id, {
    action: 'retry',
    kind: 'character',
    index: 0,
    revision: 1,
    confirmCharge: true,
  });
  await until(async () => (await f.art.get(j.id)).status !== 'running');
  assert.deepEqual(
    await fs.readFile(path.join(opts.root, a.id, snap.art.characters[0].file)),
    snapBytes,
  );
  await assert.rejects(() => videos.action(a.id, { action: 'accept', previewConfirmed: true }), {
    code: 'ART_APPROVAL_REQUIRED',
  });
  // Use an independent approved copy; a rejected reference protocol must stop after the first POST.
  await confirmItems(f, await f.art.get(j.id), 'character');
  await f.art.action(j.id, { action: 'confirmCharacters', revision: 2 });
  await f.art.action(j.id, { action: 'generateFrames', revision: 2, confirmCharge: true });
  await until(async () => (await f.art.get(j.id)).frames[1].status === 'done');
  await confirmItems(f, await f.art.get(j.id), 'frame');
  await f.art.action(j.id, { action: 'confirmFrames', revision: 2 });
  let attempts = 0;
  const failJobs = createVideoJobs({
    ...opts,
    root: path.join(f.root, 'rejected'),
    fetchImpl: async () => {
      attempts++;
      return Response.json({ error: {} }, { status: 400 });
    },
  });
  t.after(() => failJobs.close());
  const rejected = await failJobs.create({ ...request, artRevision: 2 });
  await until(async () => (await failJobs.get(rejected.id)).status === 'failed');
  assert.equal(attempts, 1);
});
test('受控图片预览支持 GET/HEAD，拒绝原图与路径穿越，来源校验和工坊 CSP 正确', async (t) => {
  const f = await fixture(t),
    j = await start(f),
    server = createServer({
      storyStore: f.store,
      imageConfigStore: f.config,
      artJobs: f.art,
      recoverVideoJobs: false,
    });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const file = j.characters[0].file,
    url = base + '/api/story-art-media/' + j.id + '/' + file;
  const r = await fetch(url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.deepEqual(
    Buffer.from(await r.arrayBuffer()),
    await fs.readFile(path.join(f.settings.root, j.id, file)),
  );
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
  for (const name of ['job.json', 'source-1.webp', 'received-test.bin', '%2e%2e%2fsecret.png'])
    assert.equal((await fetch(base + '/api/story-art-media/' + j.id + '/' + name)).status, 404);
  const list = await fetch(base + '/api/story-art-jobs?storyId=' + f.story.id);
  assert.equal((await list.json())[0].id, j.id);
  const bad = await fetch(base + '/api/story-art-jobs/' + j.id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://outside.test' },
    body: JSON.stringify({ action: 'confirmCharacter', kind: 'character', index: 0, revision: 1 }),
  });
  assert.equal(bad.status, 403);
  const good = await fetch(base + '/api/story-art-jobs/' + j.id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ action: 'confirmCharacter', kind: 'character', index: 0, revision: 1 }),
  });
  assert.equal(good.status, 200);
  const page = await fetch(base + '/scenario-settings.html');
  assert.match(page.headers.get('content-security-policy'), /img-src 'self' data:/);
  assert.equal((await fetch(base + '/story-art-ui.js')).status, 200);
});
test('正式图片解码归一化输出 PNG，人物与分镜比例分别为 2:3 和 16:9', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'art-normalize-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = await fs.readFile('assets/manor/portrait-01.webp');
  for (const [kind, w, h] of [
    ['character', 1024, 1536],
    ['frame', 1536, 864],
  ]) {
    const dest = path.join(dir, kind + '.png');
    await normalizeImage(bytes, dest, { kind });
    const out = await fs.readFile(dest);
    assert.equal(out.readUInt32BE(16), w);
    assert.equal(out.readUInt32BE(20), h);
  }
});

test('参考视频重启沿用已提交编号，后续镜头读取图片快照', async (t) => {
  const f = await fixture(t),
    art = await approved(f),
    sent = [];
  const media = {
    available: async () => true,
    prepareNarration: async () => {},
    normalize: async (src, out) => fs.writeFile(out, 'movie'),
    assemble: async (dir) => fs.writeFile(path.join(dir, 'intro.mp4'), 'movie'),
  };
  let ready = false;
  const settings = {
    root: path.join(f.root, 'restart-videos'),
    store: f.store,
    artJobs: f.art,
    media,
    pollMs: 5,
    config: {
      loadCredential: async () => ({
        provider: 'https://video.test/v1',
        model: 'grok-imagine-video-1.5',
        apiKey: 'separate-video-key',
      }),
    },
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') {
        sent.push(JSON.parse(init.body));
        return Response.json({ request_id: 'saved-' + sent.length });
      }
      if (url.startsWith('https://cdn.test')) return new Response(Buffer.alloc(100));
      return Response.json(
        ready ? { status: 'done', video: { url: 'https://cdn.test/clip' } } : { status: 'pending' },
      );
    },
  };
  const first = createVideoJobs(settings),
    created = await first.create({
      storyId: f.story.id,
      version: 1,
      profile: 'story60-refs-v1',
      artId: art.id,
      artRevision: art.revision,
    });
  await until(async () => {
    const j = await first.get(created.id);
    return j.scenes[0].requestId === 'saved-1';
  });
  await first.close();
  assert.equal(sent.length, 1);
  const old = await first.get(created.id);
  old.scenes[1].prompt = 'LEGACY_CONFLICTING_PROMPT';
  await atomic(path.join(settings.root, created.id, 'job.json'), old);
  ready = true;
  const restored = createVideoJobs(settings);
  t.after(() => restored.close());
  await restored.recover();
  const done = await until(async () => {
    const j = await restored.get(created.id);
    return j.status === 'ready' && j;
  });
  assert.equal(sent.length, 6);
  assert.equal(done.scenes[0].requestId, 'saved-1');
  assert.deepEqual(
    Buffer.from(sent[1].reference_images[0].url.split(',')[1], 'base64'),
    await fs.readFile(path.join(settings.root, created.id, done.art.characters[0].file)),
  );
  assert.ok(!sent[1].prompt.includes('LEGACY_CONFLICTING_PROMPT'));
  assert.equal(done.scenes[1].inputAudit.promptVersion, 2);
  assert.equal(f.calls.length, 12);
});

test('图片超时、异常响应与下载失败准确分类，均不自动重发', async () => {
  const config = {
    loadCredential: async () => ({
      provider: 'https://images.test',
      model: 'gpt-image-2',
      apiKey: 'secret',
    }),
  };
  let calls = 0;
  const timeout = createImageProvider({
    config,
    timeoutMs: 10,
    fetchImpl: async (url, { signal }) => {
      calls++;
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(Error('abort')), { once: true }),
      );
    },
  });
  await assert.rejects(
    () => timeout.generate({ prompt: 'test', references: [png], size: '1536x864' }),
    { code: 'IMAGE_TIMEOUT' },
  );
  assert.equal(calls, 1);
  const invalid = createImageProvider({ config, fetchImpl: async () => new Response('not json') });
  await assert.rejects(() => invalid.generate({ prompt: 'test', references: [png] }), {
    code: 'IMAGE_RESPONSE_INVALID',
  });
  const phases = [],
    download = createImageProvider({
      config,
      fetchImpl: async (url, init) =>
        init.method === 'POST'
          ? Response.json({ data: [{ url: 'https://cdn.example/a.png' }] })
          : Promise.reject(Error('private secret')),
    });
  await assert.rejects(
    () =>
      download.generate({
        prompt: 'test',
        references: [png],
        onProgress: async (p) => phases.push(p),
      }),
    { code: 'IMAGE_RESULT_UNSAVED' },
  );
  assert.deepEqual(phases, ['waiting', 'downloading']);
});
test('镜头4重做后仅继续排队的5、6，保留所有完成素材且不自动确认', async (t) => {
  let failFourth = true;
  const f = await fixture(t, {
    generate: async (args, n) => {
      if (n === 10 && failFourth) throw Error('unknown');
      return png;
    },
  });
  let j = await start(f);
  await confirmItems(f, await f.art.get(j.id), 'character');
  await f.art.action(j.id, { action: 'confirmCharacters', revision: 1 });
  await f.art.action(j.id, { action: 'generateFrames', revision: 1, confirmCharge: true });
  j = await until(async () => {
    const x = await f.art.get(j.id);
    return x.status === 'needs_review' && x;
  });
  assert.equal(j.frames[3].status, 'unknown');
  const files = j.frames.slice(0, 3).map((x) => x.file),
    characters = j.characters.map((x) => x.file);
  failFourth = false;
  await f.art.action(j.id, {
    action: 'retry',
    kind: 'frame',
    index: 3,
    revision: 1,
    confirmCharge: true,
    reconciled: true,
    continueQueued: true,
  });
  j = await until(async () => {
    const x = await f.art.get(j.id);
    return x.status === 'review' && x;
  });
  assert.equal(f.calls.length, 13);
  assert.deepEqual(
    j.frames.slice(0, 3).map((x) => x.file),
    files,
  );
  assert.deepEqual(
    j.characters.map((x) => x.file),
    characters,
  );
  assert.ok(j.frames.every((x) => x.status === 'done'));
  assert.equal(j.framesConfirmed, false);
  assert.equal(j.revision, 2);
});
test('单图重做不继续排队；连续重做再次结果不明立即停止', async (t) => {
  let fail = false;
  const f = await fixture(t, {
    generate: async () => {
      if (fail) throw Error('unknown');
      return png;
    },
  });
  let j = await start(f);
  await confirmItems(f, j, 'character');
  await f.art.action(j.id, { action: 'confirmCharacters', revision: 1 });
  await f.art.action(j.id, {
    action: 'retry',
    kind: 'frame',
    index: 3,
    revision: 1,
    confirmCharge: true,
    reconciled: true,
  });
  j = await until(async () => {
    const x = await f.art.get(j.id);
    return x.status === 'review' && x;
  });
  assert.equal(f.calls.length, 7);
  assert.equal(j.frames[4].status, 'queued');
  fail = true;
  await f.art.action(j.id, {
    action: 'retry',
    kind: 'frame',
    index: 3,
    revision: 2,
    confirmCharge: true,
    reconciled: true,
    continueQueued: true,
  });
  j = await until(async () => {
    const x = await f.art.get(j.id);
    return x.status === 'needs_review' && x;
  });
  assert.equal(f.calls.length, 8);
  assert.equal(j.frames[4].status, 'queued');
  assert.equal(j.frames[5].status, 'queued');
  await f.art.close();
  const restored = createStoryArtJobs(f.settings);
  t.after(() => restored.close());
  await restored.recover();
  assert.equal(f.calls.length, 8);
  assert.equal((await restored.get(j.id)).frames[3].status, 'unknown');
});

test('错配在生成请求前拦截；旧任务查询不受阻、显式重做不沿用错误声音', async (t) => {
  const f = await fixture(t, { cinematic: true });
  const mismatch = {
    ...f.story,
    characters: f.story.characters.map((c, i) => (i ? c : { ...c, voiceId: 'leo' })),
  };
  let bad = true,
    posts = 0;
  const store = { ...f.store, get: async (id) => (bad ? mismatch : f.store.get(id)) };
  const video = createVideoJobs({
    root: path.join(f.root, 'videos'),
    store,
    artJobs: f.art,
    pollMs: 1,
    config: {
      loadCredential: async () => ({
        provider: 'https://video.test/v1',
        model: 'grok-imagine-video-1.5',
        apiKey: 'private-test-key',
      }),
    },
    media: {
      available: async () => true,
      prepareNarration: async () => {},
      normalize: async (src, out) => fs.writeFile(out, 'movie'),
      assemble: async () => {},
    },
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') {
        posts++;
        return Response.json({ request_id: 'voice-' + posts });
      }
      return url.startsWith('https://cdn.test')
        ? new Response(Buffer.alloc(100))
        : Response.json({ status: 'done', video: { url: 'https://cdn.test/clip' } });
    },
  });
  t.after(() => video.close());
  await assert.rejects(
    () => video.create({ storyId: f.story.id, version: 1, confirmCharge: true }),
    { code: 'INVALID_VIDEO_PLAN' },
  );
  assert.equal(posts, 0);
  bad = false;
  const art = await approved(f),
    created = await video.create({
      storyId: f.story.id,
      version: 1,
      confirmCharge: true,
      artId: art.id,
      artRevision: art.revision,
    });
  await until(async () => (await video.get(created.id)).status === 'ready');
  await video.close();
  const old = await video.get(created.id);
  old.voiceMap[1] = 'altair';
  delete old.voiceCharacters;
  old.status = 'paused';
  old.scenes[1].status = 'pending';
  old.scenes[1].requestId = 'already-submitted';
  await atomic(path.join(video.root, old.id, 'job.json'), old);
  let queries = 0;
  const resumed = createVideoJobs({
    root: video.root,
    store: f.store,
    artJobs: f.art,
    pollMs: 1,
    config: {
      loadCredential: async () => ({
        provider: 'https://video.test/v1',
        model: 'grok-imagine-video-1.5',
        apiKey: 'private-test-key',
      }),
    },
    media: {
      available: async () => true,
      prepareNarration: async () => {},
      normalize: async (src, out) => fs.writeFile(out, 'movie'),
      assemble: async () => {},
    },
    fetchImpl: async (url, init = {}) => {
      assert.notEqual(init.method, 'POST');
      queries++;
      return url.startsWith('https://cdn.test')
        ? new Response(Buffer.alloc(100))
        : Response.json({ status: 'done', video: { url: 'https://cdn.test/clip' } });
    },
  });
  t.after(() => resumed.close());
  await resumed.action(old.id, { action: 'resume' });
  await until(async () => (await resumed.get(old.id)).status === 'ready');
  assert.ok(queries > 0);
  await assert.rejects(
    () => resumed.action(old.id, { action: 'retry', index: 1, confirmCharge: true }),
    { code: 'VIDEO_VOICE_MISMATCH' },
  );
  const retained = await resumed.get(old.id);
  assert.equal(retained.voiceMap[1], 'altair');
  assert.equal(retained.scenes[1].status, 'done');
});

test('姓名条草稿不锁住分镜单张重做，实际剧本未保存修改仍会禁用', async () => {
  const fsync = require('node:fs/promises'),
    vm = require('node:vm'),
    nodes = {},
    retry = { disabled: true, dataset: { kind: 'frame' } };
  const node = (id) =>
    (nodes[id] ??= {
      disabled: false,
      textContent: '',
      title: '',
      classList: { toggle() {} },
      setAttribute() {},
    });
  const context = vm.createContext({
    $: node,
    document: {
      getElementById: node,
      querySelectorAll: (selector) => (selector === '#workshopSteps li' ? [] : [retry]),
    },
    NightfallManor: { imagePath: () => '/portrait.webp', defaultId: () => '' },
    current: { confirmed: true, characters: [] },
    dirty: true,
    cinematic: true,
    sceneCount: 8,
    roomSize: 6,
    restoreBlocked: false,
    loading: false,
    restoring: false,
    workshopReady: true,
    artSubmitting: false,
    job: null,
    art: {
      id: 'art',
      status: 'review',
      charactersConfirmed: true,
      framesConfirmed: false,
      characters: [],
      frames: [{ status: 'done' }],
    },
    generationDraftChanged: () => false,
  });
  vm.runInContext(await fsync.readFile('story-art-ui.js', 'utf8'), context);
  vm.runInContext(
    "art={id:'art',status:'review',charactersConfirmed:true,framesConfirmed:false,characters:[],frames:[{status:'done'}]};artUpdateButtons()",
    context,
  );
  assert.equal(retry.disabled, false);
  context.generationDraftChanged = () => true;
  vm.runInContext('artUpdateButtons()', context);
  assert.equal(retry.disabled, true);
});
const { createTitleJobs } = require('./story-title-jobs.cjs');
test('任务列表忽略缺失记录的目录，同时保留有效记录并报告损坏数据', async (t) => {
  const f = await fixture(t);
  const art = await start(f);
  const absent = '00000000-0000-4000-8000-000000000001';
  const roots = ['art', 'videos', 'titles'].map((name) => path.join(f.root, name));
  for (const root of roots) await fs.mkdir(path.join(root, absent), { recursive: true });
  const videos = createVideoJobs({ root: roots[1], store: f.store, artJobs: f.art });
  const titles = createTitleJobs({ root: roots[2], store: f.store, jobs: videos });
  t.after(() => Promise.all([videos.close(), titles.close()]));
  assert.equal((await f.art.list())[0].id, art.id);
  assert.deepEqual(await videos.list(), []);
  assert.deepEqual(await titles.list(), []);
  await fs.writeFile(path.join(roots[0], absent, 'job.json'), '{invalid');
  await assert.rejects(() => f.art.list(), SyntaxError);
});

test('独立参考素材按人数隔离，格式与路径受控，导入不调用生成服务', async (t) => {
  const { createStoryReferences } = require('./story-references.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nightfall-refs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const normalizations = [];
  const library = createStoryReferences({
    root,
    normalize: async (bytes, dest, options) => {
      normalizations.push(options.kind);
      await fs.writeFile(dest, bytes);
    },
  });
  const six = await library.upload({
    roomSize: 6,
    label: '宴厅长桌',
    kind: 'scene',
    data: 'data:image/png;base64,' + png.toString('base64'),
  });
  const twelve = await library.upload({
    roomSize: 12,
    label: '人物服装',
    kind: 'costume',
    data: 'data:image/png;base64,' + png.toString('base64'),
  });
  assert.equal((await library.list(6)).length, 1);
  assert.equal((await library.list(12)).length, 1);
  assert.match(six.url, /roomSize=6$/);
  assert.match(twelve.url, /roomSize=12$/);
  assert.deepEqual(await fs.readFile((await library.get(six.id, 6)).file), png);
  await assert.rejects(library.get(six.id, 12), { code: 'REFERENCE_NOT_FOUND' });
  await assert.rejects(library.get('../outside', 6), { code: 'REFERENCE_NOT_FOUND' });
  await assert.rejects(
    library.upload({
      roomSize: 6,
      label: 'bad',
      kind: 'scene',
      data: 'data:image/png;base64,YmFk',
    }),
    { code: 'INVALID_REFERENCE_IMAGE' },
  );
  await assert.rejects(
    library.upload({
      roomSize: 6,
      label: 'bad',
      kind: 'secret',
      data: 'data:image/png;base64,' + png.toString('base64'),
    }),
    { code: 'INVALID_REFERENCE' },
  );
  assert.deepEqual(normalizations, ['frame', 'frame']);
});

test('独立参考、用途顺序、结束帧和前镜真实尾帧进入视频快照，重做保留旧镜头并阻止依赖镜自动计费', async (t) => {
  const { randomUUID } = require('node:crypto'),
    refId = randomUUID(),
    sample = S.bloodMoonEnglishSample(6);
  Object.assign(sample.scenes[0], {
    referenceFrames: [2, 1],
    referencePurposes: { 2: 'prop', 1: 'scene' },
    extraReferences: [{ id: refId, purpose: 'costume' }],
    endFrameIndex: 2,
  });
  sample.scenes[1].startSource = 'previous';
  let refFile;
  const references = {
    get: async (id, size) => {
      assert.equal(id, refId);
      assert.equal(size, 6);
      return { id, label: 'import', file: refFile };
    },
  };
  const f = await fixture(t, { cinematic: true, sample, references }),
    sent = [];
  refFile = path.join(f.root, 'import.png');
  await fs.writeFile(refFile, png);
  const art = await approved(f);
  const tailSources = [],
    tailBytes = new Map();
  const media = {
    available: async () => true,
    prepareNarration: async () => {},
    normalize: async (src, out) => fs.writeFile(out, 'movie'),
    assemble: async (dir) => fs.writeFile(path.join(dir, 'intro.mp4'), 'movie'),
    extractLastFrame: async (src, dest) => {
      const name = path.basename(src);
      assert.match(name, /^scene-(?:0|2)\.mp4$/);
      tailSources.push(name);
      const bytes = Buffer.concat([png, Buffer.from('actual-tail-' + name)]);
      tailBytes.set(name, bytes);
      await fs.writeFile(dest, bytes);
    },
  };
  const root = path.join(f.root, 'video');
  const videos = createVideoJobs({
    root,
    store: f.store,
    artJobs: f.art,
    references: {
      get: async (id, size) => {
        assert.equal(id, refId);
        assert.equal(size, 6);
        return { id, label: '服装参考', kind: 'costume', file: refFile, sha256: 'test-hash' };
      },
    },
    media,
    pollMs: 1,
    config: {
      loadCredential: async () => ({
        provider: 'https://video.test/v1',
        model: 'grok-imagine-video-1.5',
        apiKey: 'never-store',
      }),
    },
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') {
        sent.push(JSON.parse(init.body));
        return Response.json({ request_id: 'r-' + sent.length });
      }
      if (url.startsWith('https://cdn.test')) return new Response(Buffer.alloc(100));
      return Response.json({ status: 'done', video: { url: 'https://cdn.test/movie' } });
    },
  });
  t.after(() => videos.close());
  const request = {
    storyId: f.story.id,
    version: 1,
    profile: 'cinema-refs-v1',
    artId: art.id,
    artRevision: art.revision,
    confirmCharge: true,
  };
  const j = await videos.create(request);
  await until(async () => (await videos.get(j.id)).status === 'ready');
  assert.deepEqual(tailSources, ['scene-0.mp4', 'scene-2.mp4']);
  assert.equal(sent.length, sample.scenes.length);
  const input = sent[0],
    cast = sample.scenes[0].cast,
    readImage = (v) => Buffer.from(v.url.split(',')[1], 'base64');
  assert.equal(input.reference_images.length, cast.length + 3);
  assert.deepEqual(
    readImage(input.last_frame),
    await fs.readFile(path.join(f.settings.root, art.id, art.frames[2].file)),
  );
  assert.deepEqual(readImage(input.reference_images[cast.length]), readImage(input.last_frame));
  assert.deepEqual(
    readImage(input.reference_images[cast.length + 1]),
    await fs.readFile(path.join(f.settings.root, art.id, art.frames[1].file)),
  );
  assert.deepEqual(readImage(input.reference_images.at(-1)), png);
  assert.deepEqual(readImage(sent[1].image), tailBytes.get('scene-0.mp4'));
  assert.deepEqual(readImage(sent[3].image), tailBytes.get('scene-2.mp4'));
  assert.match(input.prompt, /prop appearance/);
  assert.match(input.prompt, /setting and architecture/);
  assert.match(input.prompt, /costume reference named/);
  assert.match(input.prompt, /English lines/);
  const snapshot = await videos.get(j.id);
  assert.equal(snapshot.scenes[0].extraReferences[0].id, refId);
  for (let i = 0; i < sent.length; i++) {
    assert.equal(sent[i].duration, sample.scenes[i].duration);
    assert.ok((sent[i].reference_audios || []).length <= 3);
    for (const c of sample.characters) assert.ok(!sent[i].prompt.includes(c.secret));
  }
  await fs.writeFile(refFile, 'changed');
  assert.deepEqual(
    await fs.readFile(path.join(root, j.id, snapshot.scenes[0].extraReferences[0].file)),
    png,
  );
  await videos.action(j.id, { action: 'retry', index: 0, confirmCharge: true });
  await until(async () => (await videos.get(j.id)).status === 'needs_review');
  assert.equal(sent.length, sample.scenes.length + 1);
  const latest = await videos.get(j.id);
  assert.equal(latest.scenes[1].status, 'stale');
  const version = videos.summary(latest).scenes[0].previousVersions[0];
  assert.ok(version.url);
  const name = version.url.split('/').at(-1);
  assert.equal(await fs.readFile(await videos.mediaFile(j.id, name), 'utf8'), 'movie');
  await assert.rejects(videos.mediaFile(j.id, 'scene-0-archived-' + randomUUID() + '.mp4'), {
    code: 'MEDIA_NOT_FOUND',
  });
  await videos.action(j.id, { action: 'resume' });
  await until(async () => (await videos.get(j.id)).status === 'needs_review');
  assert.equal(sent.length, sample.scenes.length + 1);
});

test('每镜人物与独立参考图合计超过14张时在任何请求前拒绝', () => {
  const { randomUUID } = require('node:crypto'),
    sample = S.bloodMoonEnglishSample(12),
    scene = sample.scenes[0];
  scene.extraReferences = Array.from({ length: 14 }, () => ({
    id: randomUUID(),
    purpose: 'scene',
  }));
  assert.throws(() => S.validate(sample), /合计不能超过14/);
});

test('自动制作逐镜检查后才提交下一镜，自动参考和已受理任务在暂停后保留', async (t) => {
  const { randomUUID } = require('node:crypto'),
    productionId = randomUUID();
  const sample = S.bloodMoonEnglishSample(6),
    f = await fixture(t, { cinematic: true, sample }),
    art = await approved(f),
    sent = [];
  const media = {
    available: async () => true,
    prepareNarration: async () => {},
    normalize: async (src, out) => fs.writeFile(out, 'movie'),
    assemble: async (dir) => fs.writeFile(path.join(dir, 'intro.mp4'), 'movie'),
    extractLastFrame: async (src, dest) => fs.writeFile(dest, png),
  };
  const videos = createVideoJobs({
    root: path.join(f.root, 'auto-video'),
    store: f.store,
    artJobs: f.art,
    media,
    pollMs: 1,
    config: {
      loadCredential: async () => ({
        provider: 'https://video.test/v1',
        model: 'grok-imagine-video-1.5',
        apiKey: 'test-only',
      }),
    },
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') {
        sent.push(JSON.parse(init.body));
        return Response.json({ request_id: 'r-' + sent.length });
      }
      if (url.startsWith('https://cdn.test')) return new Response(Buffer.alloc(100));
      return Response.json({ status: 'done', video: { url: 'https://cdn.test/movie' } });
    },
  });
  t.after(() => videos.close());
  const request = {
    storyId: f.story.id,
    version: 1,
    profile: 'cinema-refs-v1',
    artId: art.id,
    artRevision: art.revision,
    productionId,
    confirmCharge: true,
  };
  const j = await videos.create(request);
  await until(async () => (await videos.get(j.id)).status === 'quality_review');
  assert.equal(sent.length, 1);
  await videos.pause(j.id);
  await videos.action(j.id, { action: 'approveScene', index: 0, productionId });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sent.length, 1);
  await videos.unpause(j.id);
  await videos.action(j.id, { action: 'resume' });
  await until(async () => (await videos.get(j.id)).status === 'quality_review');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].reference_images.length, sample.scenes[1].cast.length + 1);
  const planned = await videos.get(j.id);
  assert.deepEqual(planned.scenes[1].referenceFrames, [0]);
  await assert.rejects(
    () => videos.action(j.id, { action: 'approveScene', index: 0, productionId }),
    { code: 'QUALITY_APPROVAL_INVALID' },
  );
  await assert.rejects(
    () => videos.action(j.id, { action: 'approveScene', index: 1, productionId: 'wrong' }),
    { code: 'QUALITY_APPROVAL_INVALID' },
  );
  const again = await videos.create(request);
  assert.equal(again.id, j.id);
  assert.equal(sent.length, 2);
  const followup = await videos.create({ ...request, productionId: randomUUID() });
  const reused = await until(async () => {
    const current = await videos.get(followup.id);
    return current.status === 'quality_review' && current.scenes[0].reuse && current;
  });
  assert.equal(sent.length, 2, '兼容的历史视频已复用，没有再次请求供应商');
  assert.equal(reused.scenes[0].reuse.sourceTaskId, j.id);
  assert.ok(reused.scenes[0].outputFingerprint);
});

test('分镜附加参考图按顺序送检并在复用后保留可读取的快照', async (t) => {
  const sample = S.bloodMoonSample();
  const refId = require('node:crypto').randomUUID();
  const fixedLayout =
    'one round walnut banquet table with the head seat empty; candelabra at the left';
  const allowedMovements =
    'Only the sealed invitation may move from Vera’s right hand to the place beside the empty chair';
  sample.scenes[0].extraReferences = [
    { id: refId, purpose: 'prop', fixedLayout, allowedMovements },
  ];
  let referenceFile;
  const references = {
    get: async (id, size) => {
      assert.equal(id, refId);
      assert.equal(size, 6);
      return { id, label: '邀请函', file: referenceFile };
    },
  };
  const f = await fixture(t, { sample, cinematic: true, references });
  referenceFile = path.join(f.root, 'reference.png');
  await fs.writeFile(referenceFile, png);
  const first = await approved(f);
  const original = first.frames[0].referenceManifest.find((r) => r.sourceId === refId);
  assert.equal(original.order, first.frames[0].referenceManifest.length);
  assert.equal(original.fixedLayout, fixedLayout);
  assert.equal(original.allowedMovements, allowedMovements);
  assert.ok(first.frames[0].prompt.includes(fixedLayout));
  assert.ok(first.frames[0].prompt.includes(allowedMovements));
  assert.match(first.frames[0].prompt, /CONTINUITY LOCK/);
  assert.deepEqual(await fs.readFile(await f.art.mediaFile(first.id, original.snapshotFile)), png);
  const saved = await f.store.save({ ...(await f.store.get(f.story.id)), confirmed: true });
  const next = await f.art.create({
    storyId: saved.id,
    version: saved.version,
    confirmCharge: true,
  });
  let job = await until(async () => {
    const j = await f.art.get(next.id);
    return j.status === 'review' && j;
  });
  await confirmItems(f, job, 'character');
  await f.art.action(job.id, { action: 'confirmCharacters', revision: job.revision });
  await f.art.action(job.id, {
    action: 'generateFrames',
    revision: job.revision,
    confirmCharge: true,
  });
  job = await until(async () => {
    const j = await f.art.get(next.id);
    return j.status === 'review' && j.frames.every((x) => x.status === 'done') && j;
  });
  const reused = job.frames[0].referenceManifest.find((r) => r.sourceId === refId);
  assert.equal(job.frames[0].reuse.taskId, first.id);
  assert.deepEqual(await fs.readFile(await f.art.mediaFile(job.id, reused.snapshotFile)), png);
});

test('图片编辑参考数量、大小、格式和提示词在读取凭据前校验', async () => {
  const { validateImageInputs, createImageProvider } = require('./image-provider.cjs');
  validateImageInputs('a'.repeat(32000), Array(16).fill(png));
  assert.throws(() => validateImageInputs('a'.repeat(32001), [png]), {
    code: 'IMAGE_PROMPT_INVALID',
  });
  assert.throws(() => validateImageInputs('有效', Array(17).fill(png)), {
    code: 'IMAGE_REFERENCE_COUNT',
  });
  assert.throws(() => validateImageInputs('有效', [Buffer.alloc(50 * 1024 * 1024)]), {
    code: 'IMAGE_REFERENCE_SIZE',
  });
  assert.throws(() => validateImageInputs('有效', [Buffer.from('not image')]), {
    code: 'IMAGE_REFERENCE_FORMAT',
  });
  let called = false;
  const p = createImageProvider({
    config: {
      loadCredential: async () => {
        called = true;
        throw Error('unexpected');
      },
    },
    fetchImpl: async () => {
      called = true;
      throw Error('unexpected');
    },
  });
  await assert.rejects(p.generate({ prompt: '有效', references: Array(17).fill(png) }), {
    code: 'IMAGE_REFERENCE_COUNT',
  });
  assert.equal(called, false);
});

test('无参考图关键视觉素材走纯文字生图接口，参考图素材仍走编辑接口', async () => {
  const { createImageProvider } = require('./image-provider.cjs'),
    requests = [];
  const provider = createImageProvider({
    config: {
      loadCredential: async () => ({
        provider: 'https://images.test/v1',
        model: 'gpt-image-2.5-sunburst',
        apiKey: 'secret',
      }),
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await provider.generate({
    prompt: 'A fixed banquet table and carefully arranged props.',
    references: [],
    mode: 'generation',
    size: '1536x864',
  });
  assert.equal(requests[0].url, 'https://images.test/v1/images/generations');
  assert.equal(requests[0].init.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(requests[0].init.body).model, 'gpt-image-2.5-sunburst');
  await provider.generate({ prompt: 'Portrait edit.', references: [png], size: '1024x1536' });
  assert.equal(requests[1].url, 'https://images.test/v1/images/edits');
  assert.ok(requests[1].init.body instanceof FormData);
});

test('关键视觉素材清单可补齐、去重并使关联分镜待检查，不提交图片请求', async (t) => {
  const f = await fixture(t);
  const job = await start(f);
  const imageCount = f.calls.length;
  const visualAssets = [
    {
      id: 'banquet-table',
      label: '固定宴会桌与桌面布置',
      kind: 'scene',
      appearance: '深色圆桌，中央烛台、空主位和封存留言保持固定相对位置。',
      prompt:
        'A dark round banquet table with a fixed central candelabrum, an empty head seat, and a sealed note in a consistent arrangement, cinematic manor interior, no people.',
      scenes: [0, 1],
    },
  ];
  const updated = await f.art.action(job.id, {
    action: 'addVisualAssets',
    visualAssets,
    revision: job.revision,
  });
  assert.equal(f.calls.length, imageCount);
  assert.equal(updated.visualAssets.length, 1);
  assert.equal(updated.visualAssets[0].status, 'queued');
  assert.equal(updated.visualAssets[0].kind, 'scene');
  assert.equal(updated.charactersConfirmed, false);
  assert.equal(updated.frames[0].needsReview, true);
  assert.equal(updated.frames[1].needsRegeneration, true);
  const duplicate = await f.art.action(job.id, {
    action: 'addVisualAssets',
    visualAssets,
    revision: updated.revision,
  });
  assert.equal(duplicate.visualAssets.length, 1);
  assert.equal(f.calls.length, imageCount);
  await assert.rejects(
    () =>
      f.art.action(job.id, {
        action: 'addVisualAssets',
        revision: duplicate.revision,
        visualAssets: [
          { ...visualAssets[0], prompt: 'Use the secret ' + f.story.characters[0].secret },
        ],
      }),
    { code: 'INVALID_VISUAL_ASSETS' },
  );
});

test('关键视觉素材清单校验最多八项并隔离无效条目', async (t) => {
  const f = await fixture(t);
  const job = await start(f);
  const make = (index) => ({
    label: '素材' + index,
    kind: 'prop',
    appearance: '公开道具外观 ' + index,
    prompt: 'Public prop reference ' + index + ', consistent shape and placement.',
    scenes: [0],
  });
  await assert.rejects(
    () =>
      f.art.action(job.id, {
        action: 'addVisualAssets',
        revision: job.revision,
        visualAssets: Array.from({ length: 9 }, (_, index) => make(index)),
      }),
    { code: 'INVALID_VISUAL_ASSETS' },
  );
  const valid = await f.art.action(job.id, {
    action: 'addVisualAssets',
    revision: job.revision,
    visualAssets: [make(1)],
  });
  assert.equal(valid.visualAssets.length, 1);
  assert.equal(valid.visualAssets[0].scenes[0], 0);
  assert.equal(f.calls.length, 6);
});
