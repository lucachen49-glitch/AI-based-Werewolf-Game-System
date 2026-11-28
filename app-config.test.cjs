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

test('庄园立绘旧配置按席位补全，保存恢复兼容头像、声音和独立 API 配置', () => {
  const stored = {
    name: '自定义访客',
    avatar: '🐱',
    control: 'api',
    endpoint: 'https://example.test',
    model: 'my-model',
    key: 'test-only-key',
    rememberKey: true,
    voice: 'zh-CN-YunyangNeural',
    voiceStyle: 'calm',
    voiceSpeed: 0.85,
  };
  const saved = new Map([['nightfall-profiles-v1', JSON.stringify([stored])]]);
  const { context } = setup(saved, false, false);
  assert.equal(vm.runInContext('profiles[0].manorPortrait', context), 'portrait-01');
  assert.equal(vm.runInContext('profiles[5].manorPortrait', context), 'portrait-06');
  vm.runInContext("openAgent(0);$('manorPortraitInput').value='portrait-04';saveAgent()", context);
  const restored = setup(saved, false, false).context;
  for (const [key, value] of Object.entries({ ...stored, manorPortrait: 'portrait-04' }))
    assert.equal(vm.runInContext('profiles[0][key]', Object.assign(restored, { key })), value, key);
  assert.doesNotMatch(
    JSON.stringify(vm.runInContext('spectatorExport()', restored)),
    /test-only-key/,
  );
});

test('普通发言不增加阶段节奏等待，行动仍沿用可配置节奏', async () => {
  const { context } = setup();
  const delays = [];
  context.pacing = async (token, delay) => {
    delays.push(delay);
    return true;
  };
  vm.runInContext(
    "waitForTurn=pacing;turnDelay=1200;decision=async()=>({speech:'公开陈述'})",
    context,
  );
  await vm.runInContext("takeTurn(0,'speech','发言',epoch)", context);
  await vm.runInContext("takeTurn(0,'vote','投票',epoch)", context);
  assert.deepEqual(delays, [0, 0, 1200, 0]);
});

test('6 人间支持立绘与原头像，12 人间使用独立庄园布局且切换不改变配置', () => {
  const { context } = setup(new Map(), false);
  assert.equal(
    (vm.runInContext("$('playersGrid').innerHTML", context).match(/class="manor-portrait"/g) || [])
      .length,
    6,
  );
  vm.runInContext("profiles[1].manorPortrait='avatar';renderPlayers()", context);
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /manor-avatar-fallback/);
  vm.runInContext('reset(12)', context);
  assert.equal(
    (vm.runInContext("$('playersGrid').innerHTML", context).match(/manor-nameplate/g) || []).length,
    12,
  );
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML", context), /portrait-pending/);
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /portrait-12.webp/);
  assert.equal(
    vm.runInContext("$('tableScene').classList.contains('manor-twelve')", context),
    true,
  );
  assert.equal(vm.runInContext("$('tableScene').classList.contains('manor-six')", context), false);
  assert.equal(vm.runInContext("document.body.classList.contains('manor-mode')", context), true);
  vm.runInContext('reset(6)', context);
  assert.equal(vm.runInContext('profiles[1].manorPortrait', context), 'avatar');
  assert.equal(vm.runInContext("$('tableScene').classList.contains('manor-six')", context), true);
});

test('庄园人物不跟随身份改变，普通夜间隐藏身份、行动与连接提示，终局才揭晓', () => {
  const { context } = setup(new Map(), false);
  vm.runInContext(
    "game.start();game.phase='night';activeSeat=0;profiles[0].control='api';profiles[0].connection='testing';setPerspective('public')",
    context,
  );
  let html = vm.runInContext("$('playersGrid').innerHTML", context);
  assert.doesNotMatch(html, /狼人|预言家|女巫|思考中|acting|API 连接中/);
  assert.equal((html.match(/身份未知/g) || []).length, 6);
  assert.match(html, /portrait-01.webp/);
  vm.runInContext("game.players[0].role='预言家';game.phase='ended';renderPlayers()", context);
  html = vm.runInContext("$('playersGrid').innerHTML", context);
  assert.match(html, /预言家/);
  assert.match(html, /portrait-01.webp/);
});

test('非法自投等待重试，不模拟；修复响应后仅返回合法行动且不保存密钥', async () => {
  const { context, saved } = setup();
  let requests = 0;
  context.fetch = async (url) =>
    url === '/api/agent-events'
      ? { ok: true }
      : {
          ok: true,
          json: async () => ({
            choices: [
              { message: { content: ++requests === 1 ? '中文不是有效响应' : '{"target":1}' } },
            ],
          }),
        };
  const pending = vm.runInContext("decision(8,'vote')", context);
  await until(() => vm.runInContext('!!apiWaiting', context));
  assert.equal(vm.runInContext('profiles[8].connection', context), 'error');
  vm.runInContext('retryAPI()', context);
  const result = await pending;
  assert.equal(result.target, 0);
  assert.equal(requests, 2);
  vm.runInContext('profiles[8].rememberKey=false;persist()', context);
  assert.equal(saved.get('nightfall-profiles-v1').includes('secret-test-key'), false);
});

test('测试连接使用同一转发通道，保存后保留连接结果与已勾选密钥', async () => {
  const { context, requests, saved } = setup();
  assert.equal(await vm.runInContext('testConnection(profiles[8],false)', context), true);
  assert.equal(requests[0].messages[0].content, 'Reply with OK.');
  assert.equal(requests[0].purpose, 'connection-test');
  assert.equal(requests[0].maxTokens, 350);
  assert.equal('reasoningEffort' in requests[0], false);
  vm.runInContext(
    "openAgent(8);lastConnectionTest={signature:connectionSignature(profiles[8]),connection:'ok'};saveAgent()",
    context,
  );
  assert.equal(vm.runInContext('profiles[8].connection', context), 'ok');
  assert.equal(JSON.parse(saved.get('nightfall-profiles-v1'))[8].key, undefined);
  assert.equal(vm.runInContext('profiles[8].key', context), 'secret-test-key');
});

test('直接打开文件或填写不安全地址时不发送密钥', async () => {
  const { context, calls } = setup();
  context.location.protocol = 'file:';
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])', context), /start-game.cmd/);
  context.location.protocol = 'http:';
  vm.runInContext("profiles[8].endpoint='http://example.test'", context);
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])', context), /HTTPS/);
  vm.runInContext("profiles[8].endpoint='https://name:password@example.test'", context);
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])', context), /HTTPS/);
  assert.equal(calls.length, 0);
});

test('旧版浏览器独立密钥可读取，批量测试可用，连接状态重新验证', async () => {
  const { context, saved } = setup();
  vm.runInContext(
    "profiles[0]={...profiles[8],key:'another-seat-key',model:'another-model'};persist()",
    context,
  );
  assert.equal(saved.get('nightfall-profiles-v1').includes('another-seat-key'), false);
  saved.set(
    'nightfall-profiles-v1',
    vm.runInContext('JSON.stringify(serializedProfiles())', context),
  );
  const reloaded = setup(saved, false);
  assert.equal(vm.runInContext('profiles[0].key', reloaded.context), 'another-seat-key');
  assert.equal(vm.runInContext('profiles[8].key', reloaded.context), 'secret-test-key');
  assert.equal(vm.runInContext('profiles[0].connection', reloaded.context), 'untested');
  vm.runInContext('reset(12)', reloaded.context);
  await vm.runInContext('testAll()', reloaded.context);
  assert.deepEqual(
    reloaded.requests.map((r) => [r.model, r.apiKey]),
    [
      ['another-model', 'another-seat-key'],
      ['test-model', 'secret-test-key'],
    ],
  );
  assert.equal(vm.runInContext('profiles[0].connection', reloaded.context), 'ok');
  assert.equal(vm.runInContext('profiles[8].connection', reloaded.context), 'ok');
});

test('取消记住并保存删除原密钥，当前页面仍可测试，下次加载为空', async () => {
  const { context, saved } = setup();
  vm.runInContext('persist();openAgent(8)', context);
  assert.equal(JSON.parse(saved.get('nightfall-profiles-v1'))[8].key, undefined);
  assert.equal(vm.runInContext("$('rememberKeyInput').checked", context), true);
  vm.runInContext("$('rememberKeyInput').checked=false;saveAgent()", context);
  assert.equal(vm.runInContext('profiles[8].key', context), 'secret-test-key');
  assert.equal('key' in JSON.parse(saved.get('nightfall-profiles-v1'))[8], false);
  assert.equal(await vm.runInContext('testConnection(profiles[8],false)', context), true);
  const reloaded = setup(saved, false);
  assert.equal(vm.runInContext('profiles[8].key', reloaded.context), '');
  assert.equal(vm.runInContext('profiles[8].rememberKey', reloaded.context), false);
});

test('清空已存密钥可删除；旧版本和损坏配置可加载，不伪造旧密钥', () => {
  const { context, saved } = setup();
  vm.runInContext("persist();openAgent(8);$('keyInput').value='';saveAgent()", context);
  assert.equal(saved.get('nightfall-profiles-v1').includes('secret-test-key'), false);
  assert.equal(vm.runInContext('profiles[8].key', setup(saved, false).context), '');
  saved.set(
    'nightfall-profiles-v1',
    JSON.stringify([
      { name: '原玩家', endpoint: 'https://example.test', control: 'api', model: 'old-model' },
    ]),
  );
  const old = setup(saved, false);
  assert.equal(vm.runInContext('profiles[0].model', old.context), 'old-model');
  assert.equal(vm.runInContext('profiles[0].key', old.context), '');
  assert.equal(vm.runInContext('profiles[0].rememberKey', old.context), true);
  for (const value of [
    'null',
    'broken JSON',
    '[null]',
    JSON.stringify([{ rememberKey: false, key: 'must-not-load' }]),
  ]) {
    saved.set('nightfall-profiles-v1', value);
    assert.equal(vm.runInContext('profiles[0].key', setup(saved, false).context), '');
  }
});

test('保存失败保持编辑窗口且不显示成功，不改变原席位配置', () => {
  const { context } = setup();
  vm.runInContext(
    "openAgent(8);$('keyInput').value='new-key';localStorage.setItem=()=>{throw Error('quota')};saveAgent()",
    context,
  );
  assert.equal(vm.runInContext('profiles[8].key', context), 'secret-test-key');
  assert.match(vm.runInContext("$('toast').textContent", context), /存储空间不足/);
});

test('批量测试失败保留每席位原因，未填写密钥显示补填提示', async () => {
  const { context, saved } = setup();
  vm.runInContext("profiles[8].key='';reset(12)", context);
  context.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'API Key 无效或未填写，请检查密钥' } }),
  });
  await vm.runInContext('testAll()', context);
  assert.match(vm.runInContext("$('agentGrid').innerHTML", context), /API Key 无效或未填写/);
  assert.match(vm.runInContext("$('agentGrid').innerHTML", context), /请补填并保存/);
  vm.runInContext('persist()', context);
  assert.equal(saved.get('nightfall-profiles-v1').includes('connectionError'), false);
});

test('批量连接测试最多两路并发、排队补位并同步结果，重复操作不会启动新请求', async () => {
  const { context } = setup();
  const pending = [];
  vm.runInContext(
    "reset(12);profiles[0]={...profiles[8]};profiles[2]={...profiles[8]};profiles[4]={...profiles[8]};profiles[8].control='local';profiles[0].connection='ok';profiles[2].connection='error';profiles[2].connectionError='旧错误'",
    context,
  );
  context.fetch = async () => new Promise((resolve) => pending.push(resolve));
  const run = vm.runInContext('testAll()', context);
  assert.equal(pending.length, 2);
  assert.deepEqual(
    Array.from(vm.runInContext('profiles.slice(0,5).map(p=>connectionInfo(p).state)', context)),
    ['testing', 'local', 'testing', 'local', 'queued'],
  );
  assert.match(vm.runInContext("$('agentGrid').innerHTML", context), /连接中…/);
  assert.match(vm.runInContext("$('agentGrid').innerHTML", context), /等待测试…/);
  assert.doesNotMatch(vm.runInContext("$('agentGrid').innerHTML", context), /旧错误/);
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /API 连接中…/);
  assert.match(vm.runInContext("$('testAllBtn').textContent", context), /0 \/ 3 · (1、3|3、1) 号/);
  assert.equal(
    vm.runInContext(
      "$('startBtn').disabled&&$('testAllBtn').disabled&&$('saveAgent').disabled",
      context,
    ),
    true,
  );
  await vm.runInContext('testAll();testConnection(profiles[0],false);start()', context);
  assert.equal(pending.length, 2);
  assert.equal(vm.runInContext('game.phase', context), 'lobby');
  pending[0]({ ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) });
  await until(() => pending.length === 3);
  assert.equal(vm.runInContext('profiles[0].connection', context), 'ok');
  assert.equal(vm.runInContext('profiles[4].connection', context), 'testing');
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /API 在线/);
  assert.match(vm.runInContext("$('testAllBtn').textContent", context), /1 \/ 3/);
  pending[1]({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'API Key 无效' } }),
  });
  pending[2]({ ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) });
  await run;
  assert.equal(vm.runInContext('profiles[2].connection', context), 'error');
  assert.equal(vm.runInContext('profiles[4].connection', context), 'ok');
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /API 离线/);
  assert.match(vm.runInContext("$('toast').textContent", context), /2 \/ 3 个 API Agent 连接成功/);
  assert.equal(vm.runInContext('connectionTests', context), 0);
  assert.equal(vm.runInContext('activeRequestControllers.size', context), 0);
  assert.equal(vm.runInContext("$('startBtn').disabled||$('testAllBtn').disabled", context), false);
  context.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
  });
  await vm.runInContext('testAll()', context);
  assert.equal(vm.runInContext('profiles[2].connection', context), 'ok');
});

test('服务端仍有对局请求时停止批量连接并取消在途席位', async () => {
  const { context } = setup();
  let requests = 0;
  vm.runInContext(
    'reset(12);profiles[0]={...profiles[8]};profiles[2]={...profiles[8]};profiles[4]={...profiles[8]}',
    context,
  );
  context.fetch = async () => {
    requests++;
    return {
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: 'GAME_REQUESTS_ACTIVE',
          message: '当前仍有游戏 Agent 请求正在处理，请等待本局请求完成后再测试连接',
        },
      }),
    };
  };
  await vm.runInContext('testAll()', context);
  assert.equal(requests, 2);
  assert.match(vm.runInContext("$('toast').textContent", context), /等待本局请求完成/);
  assert.equal(vm.runInContext('profiles[4].connection', context), 'untested');
  assert.equal(vm.runInContext('connectionBatch', context), null);
  assert.equal(vm.runInContext('connectionTests', context), 0);
  assert.equal(vm.runInContext('activeRequestControllers.size', context), 0);
});

test('游戏请求实时更新席位连接，等待当前行动成功后恢复在线', async () => {
  const { context } = setup();
  let finish;
  context.fetch = async () => new Promise((resolve) => (finish = resolve));
  const run = vm.runInContext("decision(8,'vote')", context);
  await until(() => !!finish);
  assert.equal(vm.runInContext('profiles[8].connection', context), 'testing');
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /API 连接中…/);
  await until(() => !!finish);
  finish({ ok: false, status: 503, json: async () => ({ error: { message: '服务暂不可用' } }) });
  await until(() => vm.runInContext('!!apiWaiting', context));
  assert.equal(vm.runInContext('profiles[8].connection', context), 'error');
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /API 离线/);
  context.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"target":1}' } }] }),
  });
  vm.runInContext('retryAPI()', context);
  await run;
  assert.equal(vm.runInContext('profiles[8].connection', context), 'ok');
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /API 在线/);
  vm.runInContext('persist()', context);
  assert.equal(
    vm.runInContext(
      "localStorage.getItem('nightfall-profiles-v1').includes('connection')",
      context,
    ),
    false,
  );
});

test('修改名称保留连接，修改模型重置状态，草稿测试不覆盖其他配置', async () => {
  const { context } = setup();
  vm.runInContext(
    "profiles[8].connection='ok';openAgent(8);$('nameInput').value='新名字';saveAgent()",
    context,
  );
  assert.equal(vm.runInContext('profiles[8].connection', context), 'ok');
  vm.runInContext("openAgent(8);$('modelInput').value='another-model'", context);
  await vm.runInContext('testConnection()', context);
  assert.equal(vm.runInContext('profiles[8].model', context), 'test-model');
  assert.equal(vm.runInContext('profiles[8].connection', context), 'ok');
  vm.runInContext('saveAgent()', context);
  assert.equal(vm.runInContext('profiles[8].connection', context), 'ok');
  vm.runInContext("openAgent(8);$('modelInput').value='untested-model';saveAgent()", context);
  assert.equal(vm.runInContext('profiles[8].connection', context), 'untested');
});

test('本地服务真正关闭重启后，新页面恢复配置并通过真实 HTTP 批量测试', async () => {
  const { createServer } = require('./server.cjs'),
    { createAgentConfigStore } = require('./agent-config.cjs'),
    configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightfall-agent-config-')),
    configFile = path.join(configDirectory, 'agent-profiles.json'),
    authorizations = [],
    store = () => createAgentConfigStore(configFile);
  const fetchImpl = async (url, options) => {
    const authorization =
      typeof options.headers?.get === 'function'
        ? options.headers.get('authorization')
        : (options.headers?.Authorization ?? options.headers?.authorization);
    authorizations.push(
      authorization === 'Bearer restart-test-key'
        ? 'seat-one'
        : authorization === 'Bearer seat-nine-test-key'
          ? 'seat-nine'
          : 'unknown',
    );
    return new Response(
      JSON.stringify({
        id: 'resp-connection',
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  let service = createServer({ fetchImpl, agentConfigStore: store(), recoverVideoJobs: false }),
    port;
  const close = async () => {
    service.closeAllConnections();
    await new Promise((resolve) => service.close(resolve));
  };
  try {
    await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
    port = service.address().port;
    const origin = 'http://127.0.0.1:' + port,
      original = setup(),
      request = async (url, options = {}) =>
        fetch(origin + url, {
          ...options,
          headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
            Origin: origin,
            Connection: 'close',
          },
        });
    vm.runInContext(
      "profiles[0]={...profiles[8],key:'restart-test-key',model:'seat-one-model',profileSeat:1};profiles[8].key='seat-nine-test-key'",
      original.context,
    );
    const profiles = JSON.parse(
        vm.runInContext('JSON.stringify(serializedProfiles())', original.context),
      ),
      saved = await request('/api/agent-config', {
        method: 'POST',
        body: JSON.stringify({ profiles }),
      });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    for (const seat of [0, 8]) {
      assert.equal(savedBody.profiles[seat].hasKey, true);
      assert.equal(Object.hasOwn(savedBody.profiles[seat], 'key'), false);
      assert.equal(Object.hasOwn(savedBody.profiles[seat], 'voiceKey'), false);
    }
    const loaded = await request('/api/agent-config'),
      loadedBody = await loaded.json();
    assert.equal(loaded.status, 200);
    assert.equal(loadedBody.configured, true);
    for (const seat of [0, 8]) {
      assert.equal(loadedBody.profiles[seat].hasKey, true);
      assert.equal(Object.hasOwn(loadedBody.profiles[seat], 'key'), false);
      assert.equal(Object.hasOwn(loadedBody.profiles[seat], 'voiceKey'), false);
    }
    const publicProfiles = loadedBody.profiles.map(
        ({ profileSeat, key, voiceKey, ...profile }) => profile,
      ),
      savedPage = new Map([
        ['nightfall-profiles-v1', JSON.stringify(publicProfiles)],
        ['nightfall-profiles-saved-at-v1', loadedBody.savedAt],
      ]);
    await close();
    service = createServer({ fetchImpl, agentConfigStore: store(), recoverVideoJobs: false });
    await new Promise((resolve) => service.listen(port, '127.0.0.1', resolve));
    const client = setup(savedPage, false, true, false, false, {
      origin,
      fetchImpl: (url, options = {}) =>
        fetch(origin + url, {
          ...options,
          headers: { ...options.headers, Origin: origin, Connection: 'close' },
        }),
    });
    await vm.runInContext('restoreAgentProfiles()', client.context);
    assert.equal(vm.runInContext('profiles[0].profileSeat', client.context), 1);
    assert.equal(vm.runInContext('profiles[8].profileSeat', client.context), 9);
    vm.runInContext('size=12', client.context);
    await vm.runInContext('testAll()', client.context);
    for (const seat of [0, 8])
      assert.equal(
        vm.runInContext(`profiles[${seat}].connection`, client.context),
        'ok',
        vm.runInContext(`profiles[${seat}].connectionError`, client.context),
      );
    assert.equal(authorizations.filter((value) => value === 'seat-one').length, 1);
    assert.equal(authorizations.filter((value) => value === 'seat-nine').length, 1);
  } finally {
    if (service.listening) await close();
    fs.rmSync(configDirectory, { recursive: true, force: true });
  }
});

test('旧配置自动获得独立自然音色，保存声音设置并重载，不随随机身份变化', () => {
  const saved = new Map([
    [
      'nightfall-profiles-v1',
      JSON.stringify([{ name: '原玩家', model: 'chat-model', key: 'chat-key' }]),
    ],
  ]);
  const { context } = setup(saved, false, false);
  assert.equal(vm.runInContext('profiles[0].voiceProvider', context), 'neural');
  assert.equal(vm.runInContext('new Set(profiles.map(p=>p.voice)).size', context), 12);
  vm.runInContext(
    "openAgent(0);$('voiceMatchInput').value='custom';$('playerVoiceInput').value='zh-CN-XiaoxiaoNeural';$('voiceStyleInput').value='firm';$('voiceSpeedInput').value='0.85';saveAgent()",
    context,
  );
  const next = setup(saved, false, false);
  assert.equal(vm.runInContext('profiles[0].voice', next.context), 'zh-CN-XiaoxiaoNeural');
  assert.equal(vm.runInContext('profiles[0].voiceStyle', next.context), 'firm');
  assert.equal(vm.runInContext('profiles[0].voiceSpeed', next.context), 0.85);
  assert.equal(vm.runInContext('profiles[0].key', next.context), 'chat-key');
  vm.runInContext('game.start();reset(12);game.start()', next.context);
  assert.equal(vm.runInContext('profiles[0].voice', next.context), 'zh-CN-XiaoxiaoNeural');
});

test('自然对白逐席位生成播放，只发送公开台词与声音配置，结束释放音频', async () => {
  const { context } = setup(new Map(), false, false),
    { audios, requests, revoked } = installNatural(context);
  vm.runInContext('voiceEnabled=true', context);
  vm.runInContext(
    "game.start();game.phase='discussion';turnDelay=0;busy=true;decision=async(id)=>({speech:'为什么 '+(id+1)+' 号会这样判断？'})",
    context,
  );
  const playing = vm.runInContext('aiSpeeches(false,epoch)', context);
  await until(() => audios.length === 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/speech');
  assert.equal(requests[0].body.style, 'suspicious');
  assert.equal(requests[0].body.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(Object.hasOwn(requests[0].body, 'apiKey'), false);
  assert.equal(Object.hasOwn(requests[0].body, 'role'), false);
  assert.equal(Object.hasOwn(requests[0].body, 'messages'), false);
  const oldEnd = audios[0].onended;
  audios[0].onended();
  await until(() => audios.length === 2);
  assert.equal(revoked[0], 'blob:test-1');
  assert.equal(requests[1].body.voice, 'zh-CN-YunyangNeural');
  vm.runInContext('reset(12)', context);
  oldEnd();
  await playing;
  assert.equal(audios[1].src, '');
  assert.equal(revoked.length, 2);
  assert.equal(vm.runInContext('narration', context), null);
});

test('试听使用未保存的语音配置、独立密钥；取消记住会删除语音密钥', async () => {
  const { context, saved } = setup(new Map(), false, false),
    { requests, audios } = installNatural(context);
  vm.runInContext(
    "openAgent(1);$('voiceMatchInput').value='custom';$('voiceProviderInput').value='api';$('voiceEndpointInput').value='https://speech.example.test';$('voiceModelInput').value='emotional-model';$('voiceApiVoiceInput').value='speaker-2';$('voiceKeyInput').value='voice-only-key';$('voiceStyleInput').value='firm'",
    context,
  );
  const preview = vm.runInContext('previewVoice()', context);
  await until(() => audios.length === 1);
  assert.equal(requests[0].body.voice, 'speaker-2');
  assert.equal(requests[0].body.apiKey, 'voice-only-key');
  assert.equal(requests[0].body.model, 'emotional-model');
  assert.equal(requests[0].body.style, 'firm');
  assert.equal(vm.runInContext('profiles[1].voiceProvider', context), 'neural');
  audios[0].onended();
  await preview;
  vm.runInContext('saveAgent()', context);
  assert.equal(JSON.parse(saved.get('nightfall-profiles-v1'))[1].voiceKey, undefined);
  assert.equal(vm.runInContext('profiles[1].voiceKey', context), 'voice-only-key');
  vm.runInContext("openAgent(1);$('rememberVoiceKeyInput').checked=false;saveAgent()", context);
  assert.equal(saved.get('nightfall-profiles-v1').includes('voice-only-key'), false);
  assert.equal(vm.runInContext('profiles[1].voiceKey', context), 'voice-only-key');
  assert.equal(vm.runInContext('profiles[1].voiceKey', setup(saved, false, false).context), '');
});

test('观战控件实际注册，设置持久化；本局旁白重置后不保存', () => {
  const { context, saved } = setup(new Map(), false);
  assert.equal(
    vm.runInContext("typeof $('perspectiveInput').listeners.change", context),
    'function',
  );
  vm.runInContext(
    "$('perspectiveInput').value='public';$('perspectiveInput').listeners.change();$('railToggle').listeners.click();$('narratorBtn').listeners.click();addObserver({round:1,publicText:'公开',godText:'秘密'})",
    context,
  );
  const p = JSON.parse(saved.get('nightfall-spectator-v1'));
  assert.deepEqual(p, { perspective: 'public', railOpen: false, narratorEnabled: true });
  assert.doesNotMatch(saved.get('nightfall-spectator-v1'), /公开|秘密/);
  const next = setup(saved, false);
  assert.equal(vm.runInContext('spectatorPrefs.perspective', next.context), 'public');
  assert.equal(vm.runInContext('spectatorPrefs.railOpen', next.context), false);
  assert.equal(vm.runInContext('observerEvents.length', next.context), 0);
  assert.equal(vm.runInContext('spectatorPrefs.narratorEnabled', next.context), true);
});

test('十二人 Agent 不接收人物秘密，剧情选择按人数保存并映射去重项', async () => {
  const { context } = setup(new Map(), false, true, true),
    S = require('./scenario.js'),
    s = { ...S.bloodMoonSample(12), id: '12-story', version: 1 },
    sent = [];
  s.characters.forEach((c, i) => (c.secret = 'ONLY_PRIVATE_' + String(i + 1).padStart(2, '0')));
  context.s12 = s;
  context.fetch = async (url, options) =>
    url === '/api/chat'
      ? (sent.push(JSON.parse(options.body)),
        {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"speech":"请说明依据。"}' } }] }),
        })
      : { ok: true, json: async () => S.context(s, Number(/context\/(\d+)/.exec(url)[1])) };
  vm.runInContext(
    "reset(12);sessionStory=s12;game.start();profiles.forEach(p=>{p.control='api';p.endpoint='https://chat.test';p.model='test'})",
    context,
  );
  for (let i = 0; i < 12; i++) {
    await vm.runInContext(`decision(${i},'speech')`, context);
    const text = JSON.stringify(sent[i].messages);
    for (let k = 0; k < 12; k++) assert.ok(!text.includes(s.characters[k].secret));
  }
  vm.runInContext(
    "reset(6);storyLibrary=[{id:'keep6',roomSize:6,title:'同名',version:1,aliasIds:['old6']},{id:'keep12',roomSize:12,title:'同名',version:1,aliasIds:['old12']}];selectedStoryId='old6';storyOptions();rememberStory()",
    context,
  );
  assert.equal(vm.runInContext('selectedStoryId', context), 'keep6');
  assert.doesNotMatch(vm.runInContext("$('storyChoice').innerHTML", context), /keep12/);
  vm.runInContext(
    "reset(12);selectedStoryId='old12';storyOptions();rememberStory();reset(6)",
    context,
  );
  assert.equal(vm.runInContext('selectedStoryId', context), 'keep6');
  vm.runInContext('reset(12)', context);
  assert.equal(vm.runInContext('selectedStoryId', context), 'keep12');
});

test('音乐开关和音量单独保存，刷新恢复且不改动玩家配置', () => {
  const { context, saved } = setup(new Map(), false);
  const before = vm.runInContext('JSON.stringify(profiles)', context);
  vm.runInContext('music.setVolume(.23);toggleMusic()', context);
  assert.deepEqual(JSON.parse(saved.get('nightfall-music-v1')), { enabled: false, volume: 0.23 });
  assert.equal(vm.runInContext('JSON.stringify(profiles)', context), before);
  const restored = setup(saved, false).context;
  assert.equal(vm.runInContext("$('musicBtn').textContent", restored), '♫ 音乐：关');
  assert.equal(vm.runInContext("$('musicVolume').value", restored), 23);
});

test('暂停期间修改接口丢弃旧响应，修改配置和继续均不隐式请求', async (t) => {
  const { context } = setup();
  let release,
    n = 0;
  t.after(() => vm.runInContext('reset()', context));
  context.fetch = async (url) => {
    if (url === '/api/agent-events') return { ok: true };
    n++;
    if (n === 1) return new Promise((r) => (release = r));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"target":2}' } }] }),
    };
  };
  vm.runInContext('busy=true;turnDelay=0', context);
  const pending = vm.runInContext("takeTurn(8,'vote','投票',epoch)", context);
  await until(() => !!release);
  vm.runInContext("togglePause();profiles[8].model='new-model'", context);
  release({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"target":1}' } }] }),
  });
  await until(() => vm.runInContext('!!apiWaiting', context));
  vm.runInContext('togglePause()', context);
  assert.equal(n, 1);
  vm.runInContext('retryAPI()', context);
  await until(() => n === 2);
  assert.equal(vm.runInContext('paused', context), true);
  vm.runInContext('togglePause()', context);
  assert.equal((await pending).target, 1);
  assert.equal(n, 2);
});

test('已暂存成功结果之后修改配置，需要明确重试才能重新请求', async (t) => {
  const { context } = setup();
  let release,
    n = 0;
  t.after(() => vm.runInContext('reset()', context));
  context.fetch = async (url) => {
    if (url === '/api/agent-events') return { ok: true };
    n++;
    if (n === 1) return new Promise((r) => (release = r));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"target":2}' } }] }),
    };
  };
  vm.runInContext('busy=true;turnDelay=0', context);
  const pending = vm.runInContext("takeTurn(8,'vote','投票',epoch)", context);
  await until(() => !!release);
  vm.runInContext('togglePause()', context);
  release({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"target":1}' } }] }),
  });
  await until(() => vm.runInContext('agentPending===null', context));
  vm.runInContext("profiles[8].model='new-model';togglePause()", context);
  await until(() => vm.runInContext('!!apiWaiting', context));
  assert.equal(n, 1);
  vm.runInContext('togglePause()', context);
  assert.equal(n, 1);
  vm.runInContext('retryAPI()', context);
  assert.equal((await pending).target, 1);
  assert.equal(n, 2);
});

test('十二人竖屏独立显示真实连接状态，行动提示不替代连接，夜间隐藏私有信息', () => {
  const { context } = setup(new Map(), false, true, false, true);
  const read = (code) => vm.runInContext(code, context);
  read("reset(12);game.start();game.phase='discussion';setPortraitMode(true)");
  const expected = {
    ok: '在线',
    error: '离线',
    testing: '连接中',
    queued: '待测',
    untested: '未测',
    invalid: '未测',
  };
  for (const [connection, label] of Object.entries(expected)) {
    read(
      `profiles[0].control='api';profiles[0].connection='${connection}';activeSeat=0;renderAll()`,
    );
    assert.match(read('portraitConnectionBadge(profiles[0])'), new RegExp('>' + label + '<'));
    assert.match(read("$('portraitSeatsLeft').innerHTML"), /思考中/);
  }
  read("profiles[0].control='local';renderAll()");
  assert.match(read('portraitConnectionBadge(profiles[0])'), />模拟</);
  read(
    "profiles[0].control='api';profiles[0].connection='error';game.phase='night';setPerspective('god');wolfPresentation={round:game.round,states:{0:{status:'selected',target:2}}};renderAll()",
  );
  assert.match(read("$('portraitSeatsLeft').innerHTML"), /提议 3 号/);
  assert.match(read('portraitConnectionBadge(profiles[0])'), />离线</);
  read('wolfPresentation.states[0].target=11;renderAll()');
  assert.match(
    read("$('portraitSeatsLeft').innerHTML"),
    /portrait-seat-connection[\s\S]*portrait-avatar[\s\S]*portrait-seat-info[\s\S]*portrait-seat-role[\s\S]*portrait-seat-state[^>]*title="提议 12 号">提议<span class="portrait-seat-number">12<\/span>号<\/span><\/span><\/button>/,
  );
  assert.equal(
    read("portraitActionLabel('投 10 号')"),
    '投给<span class="portrait-seat-number">10</span>号',
  );
  assert.equal(read("portraitActionLabel('弃票')"), '弃票');
  const rightHtml = read("$('portraitSeatsRight').innerHTML");
  const rightSeats = Array.from(
    rightHtml.matchAll(/data-portrait-seat="(\d+)"/g),
    (match) => match[1],
  ).join(',');
  assert.equal(
    rightSeats,
    '6,7,8,9,10,11',
    '右侧保持7至12号自上而下，玩家 ID 与座位号一致；DOM：' + rightHtml,
  );
  read(
    "game.phase='voting';wolfPresentation=null;votePresentation={states:{0:'revealed'},votes:{0:9},counts:{9:1}};renderAll()",
  );
  assert.match(
    read("$('portraitSeatsLeft').innerHTML"),
    /title="投 10 号">投给<span class="portrait-seat-number">10<\/span>号/,
  );
  for (const [state, label] of Object.entries({
    pending: '待投票',
    choosing: '投票中',
    submitted: '已投票',
    excluded: '本轮不投票',
  })) {
    read(`votePresentation.states[0]='${state}';renderAll()`);
    assert.equal(read('portraitSeatHint(game.players[0])'), label);
  }
  read(
    "game.phase='night';votePresentation=null;wolfPresentation={round:game.round,states:{0:{status:'selected',target:11}}};renderAll()",
  );
  read("setPerspective('public');renderAll()");
  const html = read("$('portraitSeatsLeft').innerHTML+$('portraitSeatsRight').innerHTML");
  assert.doesNotMatch(html, /提议|正在选刀|狼人|女巫|预言家|data-connection="error"/);
  assert.match(read('portraitConnectionBadge(profiles[0])'), /data-connection="hidden"/);
  assert.match(read('portraitConnectionBadge(profiles[0])'), />夜间</);
  read('reset(6);renderAll()');
  assert.doesNotMatch(
    read("$('portraitSeatsLeft').innerHTML"),
    /portrait-seat-info|portrait-seat-connection/,
  );
});

test('六人与十二人旧 Agent 配置恢复后发言上限、token预算及 xhigh 可核对', async () => {
  for (const count of [6, 12]) {
    const { context, saved, requests } = setup(new Map(), false);
    const read = (code) => vm.runInContext(code, context);
    context.fetch = async (url, options) => {
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  speech: '发'.repeat(1501),
                  target: null,
                  save: false,
                  poison: null,
                }),
              },
            },
          ],
        }),
      };
    };
    read('reset(' + count + ')');
    read(
      "profiles[0].control='api';profiles[0].reasoningEffort='xhigh';profiles[0].endpoint='https://example.test/v1';profiles[0].model='test-model-" +
        count +
        "';profiles[0].key='test-key';persist();game.start();game.players[0].role='狼人'",
    );
    assert.equal(read('profiles[0].reasoningEffort'), 'xhigh');
    for (const task of ['night', 'speech', 'vote', 'hunter']) {
      const result = await read('decision(0,' + JSON.stringify(task) + ')');
      assert.equal(requests.at(-1).reasoningEffort, 'xhigh');
      assert.equal(requests.at(-1).maxTokens, 25000);
      assert.equal(requests.at(-1).model, 'test-model-' + count);
      if (task === 'speech') assert.equal(Array.from(result.speech).length, 1400);
    }
    read('game.pk=[0,1]');
    const pkSpeech = await read("decision(0,'speech')");
    assert.equal(requests.at(-1).reasoningEffort, 'xhigh');
    assert.equal(requests.at(-1).maxTokens, 25000);
    assert.equal(Array.from(pkSpeech.speech).length, 1400);
    read('renderAgents();openAgent(0)');
    assert.match(read("$('agentGrid').innerHTML"), /推理强度 · 超高（xhigh）/);
    read('closeModal()');
    const before = requests.length;
    read("profiles[1].control='local'");
    await read("decision(1,'speech')");
    assert.equal(requests.length, before);
    const restored = setup(saved, false);
    vm.runInContext('reset(' + count + ')', restored.context);
    assert.equal(vm.runInContext('profiles[0].model', restored.context), 'test-model-' + count);
    assert.equal(vm.runInContext('profiles[0].reasoningEffort', restored.context), 'xhigh');
    await vm.runInContext("apiCall(profiles[0],[{role:'user',content:'test'}])", restored.context);
    assert.equal(restored.requests.at(-1).purpose, 'connection-test');
    assert.equal(restored.requests.at(-1).maxTokens, 350);
    assert.equal('reasoningEffort' in restored.requests.at(-1), false);
    vm.runInContext('renderAgents()', restored.context);
    assert.match(
      vm.runInContext("$('agentGrid').innerHTML", restored.context),
      /推理强度 · 超高（xhigh）/,
    );
  }
});

test('对局持续等待显示请求编号和用时，连接测试仍设185秒浏览器期限', async (t) => {
  const { context, timeouts } = setup();
  let release, signal;
  const sent = [];
  t.after(() => vm.runInContext('reset()', context));
  context.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body));
    signal = options.signal;
    return new Promise((resolve) => (release = resolve));
  };
  const pending = vm.runInContext("decision(8,'vote')", context);
  await until(() => !!release);
  assert.equal(timeouts.includes(185000), false);
  assert.equal(sent[0].purpose, 'game-action');
  assert.equal(sent[0].action.seat, 9);
  assert.match(vm.runInContext("$('actionPanel').innerHTML", context), /正在等待接口返回|停止等待/);
  vm.runInContext('agentPending.startedAt-=1100000;renderAction()', context);
  assert.match(vm.runInContext("$('actionPanel').innerHTML", context), /1100 秒/);
  assert.equal(signal.aborted, false);
  release({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"target":1}' } }] }),
  });
  await pending;
  context.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
  };
  await vm.runInContext("apiCall(profiles[8],[{role:'user',content:'OK'}])", context);
  assert.equal(timeouts.includes(185000), true);
  assert.equal(sent.at(-1).purpose, 'connection-test');
});

test('在途请求修改配置会暂停，保存配置和普通继续不能隐式发新请求', async (t) => {
  const { context } = setup();
  let n = 0,
    signal;
  const read = (code) => vm.runInContext(code, context);
  t.after(() => read('reset()'));
  context.fetch = async (url, options) => {
    if (url === '/api/agent-events') return { ok: true };
    n++;
    if (n === 1)
      return new Promise((resolve, reject) => {
        signal = options.signal;
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(Error('abort'), { name: 'AbortError' })),
          { once: true },
        );
      });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"target":1}' } }] }),
    };
  };
  read('busy=true');
  const pending = read("decision(8,'vote')");
  await until(() => !!signal);
  read('togglePause();openAgent(8);$("modelInput").value="updated-model";saveAgent()');
  await until(() => read('!!apiWaiting'));
  assert.equal(signal.aborted, true);
  read('openAgent(8);$("modelInput").value="updated-again";saveAgent();togglePause()');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(n, 1);
  assert.equal(read('paused'), true);
  read('retryAPI()');
  assert.equal((await pending).target, 0);
  assert.equal(n, 2);
});

test('已准备及在途目标配置变化均使旧结果失效，恢复播放后要求显式重试', async (t) => {
  for (const ready of [false, true])
    await t.test(ready ? '已就绪' : '在途', async (t) => {
      const h = speechPipeline(t, { actors: [0, 1] }),
        { read, chat, playbacks } = h;
      const running = h.start();
      await until(() => chat.length === 1);
      chat[0].speech('当前发言');
      await until(() => chat.length === 2 && playbacks.length === 1);
      if (ready) {
        chat[1].speech('旧配置发言');
        await until(() => read('preparedSpeech.status') === 'ready');
      }
      read('togglePause();openAgent(1);$("modelInput").value="updated-model";saveAgent()');
      await until(() => read('preparedSpeech.status') === 'failed');
      if (!ready) assert.equal(chat[1].signal.aborted, true);
      assert.equal(chat.length, 2);
      assert.equal(read('apiWaiting'), null);
      read('togglePause()');
      playbacks[0].finish();
      await until(() => read('!!apiWaiting'));
      assert.equal(read('apiWaiting.code'), 'AGENT_CONFIG_CHANGED');
      assert.equal(playbacks.length, 1);
      read('retryAPI()');
      await until(() => chat.length === 3);
      assert.equal(chat[2].body.model, 'updated-model');
      chat[2].speech('新配置发言');
      await until(() => playbacks.length === 2);
      assert.equal(playbacks[1].text, '新配置发言');
      playbacks[1].finish();
      await running;
      assert.equal(read('transcript.some(s=>s.text==="旧配置发言")'), false);
    });
});

test('本地模拟PK票在开始时规范为合法目标，公布后修改配置不改变已锁定票型', async (t) => {
  const h = votingHarness(t, { pk: true, locals: [2] }),
    { read, groups } = h;
  read('game.players[2].role="预言家";game.knowledge[2]={0:"狼人"}');
  let updated = false;
  h.context.flushCommentary = async () => {
    if (!updated) {
      updated = true;
      read('profiles[0].model="changed-during-reveal";invalidateVoteAgent(0)');
    }
    return true;
  };
  const running = h.start();
  await until(() => groups.length === 1);
  const lockedTarget = read('voteBatch.items[2].result.target');
  assert.ok(read('game.pk').includes(lockedTarget));
  assert.equal(read('Object.keys(votePresentation.votes).length'), 0);
  groups[0].result(1, 2);
  for (const seat of [5, 6]) groups[0].result(seat, null);
  await running;
  assert.equal(read('game.votes[0]'), 1);
  assert.equal(read('game.votes[2]'), lockedTarget);
  assert.equal(groups.length, 1);
  assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'), 4);
});

test('本机服务可用时浏览器配置不保存密钥，直接打开文件时保留原有本地保存', () => {
  const { context, saved } = setup();
  context.location.origin = 'http://127.0.0.1:4173';
  vm.runInContext(
    "profiles[8].rememberKey=true;profiles[8].voiceKey='voice-secret';profiles[8].rememberVoiceKey=true;persist()",
    context,
  );
  const stored = saved.get('nightfall-profiles-v1');
  assert.equal(stored.includes('secret-test-key'), false);
  assert.equal(stored.includes('voice-secret'), false);
  assert.equal(vm.runInContext('serializedProfiles()[8].key', context), 'secret-test-key');
  assert.equal(
    vm.runInContext('serializedProfilesFor(profiles,{includeSecrets:false})[8].key', context),
    undefined,
  );
  context.location.protocol = 'file:';
  vm.runInContext('persist()', context);
  assert.equal(saved.get('nightfall-profiles-v1').includes('secret-test-key'), false);
});

test('旧版浏览器明文密钥先同步到本机服务，确认成功后才从浏览器移除', async () => {
  const legacy = JSON.stringify(
    Array.from({ length: 12 }, (_, i) =>
      i === 8
        ? {
            control: 'api',
            endpoint: 'https://example.test',
            model: 'm',
            key: 'legacy-key',
            rememberKey: true,
          }
        : {},
    ),
  );
  for (const ok of [true, false]) {
    const saved = new Map([['nightfall-profiles-v1', legacy]]),
      posts = [];
    const { context } = setup(saved, false, true, false, false, {
      origin: 'http://127.0.0.1:4173',
      fetchImpl: agentConfigFetch(async (request) => {
        if (request.method === 'POST') {
          posts.push(JSON.parse(request.body));
          return ok
            ? {
                ok: true,
                status: 200,
                json: async () => ({ configured: true, savedAt: new Date().toISOString() }),
              }
            : {
                ok: false,
                status: 500,
                json: async () => ({ error: { message: '本机配置加密暂不可用' } }),
              };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ configured: false, profiles: null, savedAt: null }),
        };
      }),
    });
    await settle(context);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].profiles[8].key, 'legacy-key');
    assert.equal(
      saved.get('nightfall-profiles-v1').includes('legacy-key'),
      !ok,
      ok ? '同步成功后移除浏览器明文密钥' : '同步失败时保持原样',
    );
    assert.equal(vm.runInContext('profiles[8].key', context), 'legacy-key');
  }
});

test('浏览器配置较新时沿用本机服务保存的密钥，不会用空密钥覆盖', async () => {
  const now = Date.now(),
    posts = [];
  const local = Array.from({ length: 12 }, (_, i) =>
    i === 8
      ? { control: 'api', endpoint: 'https://example.test', model: 'new-model', rememberKey: true }
      : {},
  );
  const remote = Array.from({ length: 12 }, (_, i) =>
    i === 8
      ? {
          control: 'api',
          endpoint: 'https://example.test',
          model: 'old-model',
          hasKey: true,
          keyRevision: 3,
          rememberKey: true,
        }
      : {},
  );
  const saved = new Map([
    ['nightfall-profiles-v1', JSON.stringify(local)],
    ['nightfall-profiles-saved-at-v1', new Date(now).toISOString()],
  ]);
  const { context } = setup(saved, false, true, false, false, {
    origin: 'http://127.0.0.1:4173',
    fetchImpl: agentConfigFetch(async (request) => {
      if (request.method === 'POST') {
        posts.push(JSON.parse(request.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ configured: true, savedAt: new Date().toISOString() }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          configured: true,
          profiles: remote,
          savedAt: new Date(now - 60000).toISOString(),
        }),
      };
    }),
  });
  await settle(context);
  assert.equal(vm.runInContext('profiles[8].model', context), 'new-model');
  assert.equal(vm.runInContext('profiles[8].key', context), '');
  assert.equal(vm.runInContext('profiles[8].hasKey', context), true);
  assert.equal(posts.at(-1).profiles[8].key, undefined);
  assert.equal(saved.get('nightfall-profiles-v1').includes('server-key'), false);
});

test('连续保存使用前一次确认的版本，避免加密耗时导致后一次保存冲突', async () => {
  const saved = new Map(),
    posts = [];
  let remoteSavedAt = '2026-01-01T00:00:00.000Z';
  const { context } = setup(saved, false, true, false, false, {
    origin: 'http://127.0.0.1:4173',
    fetchImpl: agentConfigFetch(async (request) => {
      if (request.method !== 'POST')
        return { ok: true, json: async () => ({ configured: false, savedAt: remoteSavedAt }) };
      const body = JSON.parse(request.body);
      posts.push(body);
      assert.equal(body.baseSavedAt, remoteSavedAt);
      remoteSavedAt = new Date(Date.parse(remoteSavedAt) + 1).toISOString();
      return { ok: true, json: async () => ({ configured: true, savedAt: remoteSavedAt }) };
    }),
  });
  await settle(context);
  vm.runInContext('persist(true);persist(true)', context);
  await settle(context);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].baseSavedAt, posts[1].baseSavedAt);
});

test('服务端配置较新时迁移旧密钥，保留服务端模型和人格，接口不匹配时保留旧记录', async () => {
  for (const matches of [true, false]) {
    const saved = new Map([
      [
        'nightfall-profiles-v1',
        JSON.stringify([
          {
            endpoint: 'https://old.example/v1',
            key: 'legacy-private',
            rememberKey: true,
            model: 'old',
          },
        ]),
      ],
      ['nightfall-profiles-saved-at-v1', '2025-01-01T00:00:00Z'],
    ]);
    const posts = [];
    const remote = Array.from({ length: 12 }, (_, i) => ({
      endpoint: i === 0 ? (matches ? 'https://old.example/v1' : 'https://new.example/v1') : '',
      model: 'current-model',
      personality: 'current-personality',
      rememberKey: true,
    }));
    const { context } = setup(saved, false, true, false, false, {
      origin: 'http://127.0.0.1:4173',
      fetchImpl: agentConfigFetch(async (request) => {
        if (request.method !== 'POST')
          return {
            ok: true,
            json: async () => ({
              configured: true,
              savedAt: '2026-01-01T00:00:00Z',
              profiles: remote,
            }),
          };
        const body = JSON.parse(request.body);
        posts.push(body);
        return {
          ok: true,
          json: async () => ({ configured: true, savedAt: '2026-01-02T00:00:00Z' }),
        };
      }),
    });
    await settle(context);
    assert.equal(vm.runInContext('profiles[0].model', context), matches ? 'current-model' : 'old');
    if (matches)
      assert.equal(vm.runInContext('profiles[0].personality', context), 'current-personality');
    assert.equal(posts.length, matches ? 1 : 0);
    assert.equal(saved.get('nightfall-profiles-v1').includes('legacy-private'), !matches);
    if (matches) assert.equal(posts[0].profiles[0].key, 'legacy-private');
    else {
      vm.runInContext('persist(true)', context);
      await settle(context);
      assert.equal(posts[0].profiles[0].endpoint, 'https://old.example/v1');
      assert.equal(posts[0].profiles[0].key, 'legacy-private');
    }
  }
});
