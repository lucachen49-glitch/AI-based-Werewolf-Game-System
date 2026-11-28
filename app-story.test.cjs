'use strict';
const {
  test,
  assert,
  vm,
  fs,
  os,
  path,
  Nightfall,
  APP_SCRIPTS,
  setup,
  voteStream,
  batchCompatibleFetch,
  installStory,
  until,
  prepareAuto,
  installSpeech,
  installRuleAudio,
  installNatural,
  speechPipeline,
  votingHarness,
  wolfHarness,
  agentConfigFetch,
  settle,
} = require('./test-support/app-harness.cjs');

test('剧情开局不依赖序幕视频；确认剧本后直接发牌且重置清理公开快照', async () => {
  const { context } = setup(new Map(), false, true, true),
    { story, video } = installStory(context);
  let deals = 0,
    chat = 0,
    videoJobs = 0;
  context.deal = async () => {
    deals++;
    return true;
  };
  context.fetch = async (url, options) => {
    if (url === '/api/chat') {
      chat++;
      throw Error('开局不应调用 Agent');
    }
    if (url.startsWith('/api/video-jobs')) {
      videoJobs++;
      throw Error('开局不应检查视频任务');
    }
    return { ok: true, json: async () => story };
  };
  vm.runInContext('animateDeal=deal', context);
  await vm.runInContext('start()', context);
  assert.equal(deals, 1);
  assert.equal(chat, 0);
  assert.equal(videoJobs, 0);
  assert.equal(vm.runInContext('game.phase', context), 'night');
  assert.equal(vm.runInContext('sessionStory.title', context), story.title);
  assert.equal(vm.runInContext('storyPlayer.state().active', context), false);
  assert.equal(video.playCalls, 0);
  vm.runInContext('reset(12)', context);
  assert.equal(vm.runInContext('sessionStory', context), null);
});

test('剧情席位立绘取自本局公开快照，重置后恢复玩家设置', () => {
  const { context } = setup(new Map(), false, true, true),
    { story } = installStory(context);
  story.characters[0].portraitId = 'portrait-04';
  vm.runInContext("profiles[0].manorPortrait='portrait-02';sessionStory=storyFixture", context);
  assert.equal(vm.runInContext('manorPortrait(profiles[0],0).id', context), 'portrait-04');
  assert.equal(vm.runInContext('profiles[0].manorPortrait', context), 'portrait-02');
  vm.runInContext('reset(6)', context);
  assert.equal(vm.runInContext('manorPortrait(profiles[0],0).id', context), 'portrait-02');
});

test('Agent 不接收剧本秘密且上下文缓存，角色名临时替换；12 人不加载剧本', async () => {
  const { context, saved } = setup(new Map(), false, true, true),
    { story } = installStory(context);
  const requests = [],
    gets = [];
  const originalName = vm.runInContext('profiles[0].name', context),
    S = require('./scenario.js');
  const privateStory = {
    ...story,
    characters: story.characters.map((c, i) => ({ ...c, secret: '独有秘密' + (i + 1) })),
  };
  context.fetch = async (url, options) => {
    if (url === '/api/chat') {
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"speech":"我是来客1，先听听大家的判断。"}' } }],
        }),
      };
    }
    gets.push(url);
    return {
      ok: true,
      json: async () => S.context(privateStory, Number(/context\/(\d)/.exec(url)[1])),
    };
  };
  vm.runInContext(
    "sessionStory=storyFixture;game.start();profiles[0].control='api';profiles[0].reasoningEffort='xhigh';profiles[0].endpoint='https://chat.test';profiles[0].model='selected-chat';profiles[0].key='test-chat-key'",
    context,
  );
  await vm.runInContext("decision(0,'speech')", context);
  await vm.runInContext("decision(0,'speech')", context);
  assert.equal(gets.length, 1);
  assert.match(gets[0], /context\/1\?version=1$/);
  for (const r of requests) {
    const text = JSON.stringify(r.messages);
    assert.doesNotMatch(text, /独有秘密[1-6]/);
    assert.match(text, /来客1/);
  }
  assert.equal(vm.runInContext('name(0)', context), '来客1');
  assert.equal(vm.runInContext('profiles[0].name', context), originalName);
  assert.doesNotMatch(JSON.stringify([...saved]), /独有秘密/);
  vm.runInContext('reset(12);game.start()', context);
  await vm.runInContext("decision(0,'speech')", context);
  assert.equal(gets.length, 1);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /独有秘密|测试庄园/);
  assert.equal(vm.runInContext('name(0)', context), originalName);
});

test('重置中止剧本私有上下文请求，迟到结果不会调用聊天或污染下一局', async () => {
  const { context } = setup(new Map(), false, true, true);
  installStory(context);
  let signal,
    chat = 0;
  context.fetch = async (url, options) => {
    if (url === '/api/chat') {
      chat++;
      throw Error('不应发送');
    }
    signal = options.signal;
    return new Promise((resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          const e = Error('取消');
          e.name = 'AbortError';
          reject(e);
        },
        { once: true },
      ),
    );
  };
  vm.runInContext(
    "sessionStory=storyFixture;game.start();profiles[0].control='api';profiles[0].endpoint='https://chat.test';profiles[0].model='test'",
    context,
  );
  const pending = vm.runInContext("decision(0,'speech')", context);
  await until(() => !!signal);
  vm.runInContext('reset()', context);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(chat, 0);
  assert.equal(vm.runInContext('storyContexts.size', context), 0);
  assert.equal(vm.runInContext('sessionStory', context), null);
});
