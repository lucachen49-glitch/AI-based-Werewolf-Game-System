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

test('女巫行动提示区分解药合法性与毒药目标限制', () => {
  const { context } = setup(new Map(), false);
  vm.runInContext('size=6;game=new Nightfall.Game(6).start();game.players[3].role="女巫"', context);
  const messages = JSON.parse(
    vm.runInContext(
      'JSON.stringify(agentMessages(3,profiles[3],"night",{allowedTargets:[1,3,4,5,6],nightRules:{canSave:true,poisonAvailable:true},tonightVictim:2}))',
      context,
    ),
  );
  assert.match(messages[0].content, /需要选择座位目标的行动/);
  assert.match(messages[0].content, /save.*合法性由 context\.nightRules\.canSave 决定/);
  assert.match(messages[0].content, /canSave 为 true.*允许救当前狼刀目标.*不代表必须用药/);
  assert.match(messages[0].content, /poison.*必须来自 context\.allowedTargets/);
});

test('完整流程重置取消请求，API 故障等待修复后继续终局', async () => {
  const { context } = setup();
  prepareAuto(context, 6);
  vm.runInContext(
    "game.random=()=>.9999;profiles[0].control='api';profiles[0].endpoint='https://example.test';profiles[0].model='first-seat'",
    context,
  );
  let cancelled = false;
  context.fetch = batchCompatibleFetch(
    async (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(new DOMException('Cancelled', 'AbortError'));
          },
          { once: true },
        ),
      ),
  );
  const playing = vm.runInContext('start()', context);
  await until(() =>
    vm.runInContext('activeRequest!==null||voteBatch?.controllers?.size>0', context),
  );
  vm.runInContext('reset(12)', context);
  await playing;
  assert.equal(cancelled, true);
  assert.equal(vm.runInContext('game.phase', context), 'lobby');
  assert.equal(vm.runInContext('game.logs.length', context), 0);
  assert.equal(vm.runInContext('feed.length', context), 1);
  context.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: '测试密钥无效', code: 'AUTH_FAILED' } }),
  });
  const recovering = vm.runInContext('start()', context);
  await until(() => vm.runInContext('apiWaiting!==null||voteBatch?.errorPause', context));
  assert.notEqual(vm.runInContext('game.phase', context), 'ended');
  context.fetch = batchCompatibleFetch(async (url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify(
                input.task === 'speech'
                  ? { speech: '按信息判断' }
                  : input.task === 'night' && input.context.role === '女巫'
                    ? { save: false, poison: null }
                    : { target: input.context.allowedTargets[0] ?? null },
              ),
            },
          },
        ],
      }),
    };
  });
  vm.runInContext('retryAPI()', context);
  await recovering;
  assert.equal(vm.runInContext('game.phase', context), 'ended');
  assert.equal(vm.runInContext('profiles[0].connection', context), 'ok');
});

test('语音接口失败和浏览器禁止播放有提示，不回退成机械语音或修改 Agent 在线状态', async () => {
  const { context } = setup(new Map(), false, false);
  const { spoken } = installSpeech(context);
  vm.runInContext("profiles[0].voiceProvider='neural';profiles[0].connection='ok'", context);
  installNatural(context);
  vm.runInContext('voiceEnabled=true', context);
  context.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: '语音密钥无效', attempts: 1 } }),
  });
  const failed = vm.runInContext("speakText('公开台词',{seat:0})", context);
  await until(() => !!vm.runInContext('speechFailure', context));
  assert.equal(spoken.length, 0);
  assert.equal(vm.runInContext('profiles[0].connection', context), 'ok');
  assert.match(vm.runInContext("$('voiceStatus').textContent", context), /语音密钥无效/);
  assert.equal(vm.runInContext('speechFailure.attempts', context), 1);
  assert.equal(vm.runInContext('paused', context), true);
  vm.runInContext('continueSpeechWithoutAudio()', context);
  assert.equal(await failed, false);
  const next = installNatural(context);
  context.Audio.prototype.play = () =>
    Promise.reject(Object.assign(Error('blocked'), { name: 'NotAllowedError' }));
  assert.equal(await vm.runInContext("speakText('公开台词',{seat:0})", context), false);
  assert.equal(next.revoked.length, 1);
  assert.match(vm.runInContext("$('voiceStatus').textContent", context), /浏览器暂停了声音/);
});

test('语音三次失败后可重试当前原句，不重复调用 Agent；无声继续保留文字阅读流程', async () => {
  const { context } = setup(new Map(), false, false),
    natural = installNatural(context);
  vm.runInContext('voiceEnabled=true', context);
  vm.runInContext(
    "profiles[0].voiceProvider='api';profiles[0].voiceMatch='custom';profiles[0].voiceEndpoint='https://speech.example.test/v1';profiles[0].voiceModel='voice-model';profiles[0].voiceApiVoice='speaker-a';profiles[0].voiceKey='private-key';game.start();game.players.forEach((p,i)=>{p.alive=i===0});game.phase='discussion';turnDelay=0;busy=true;decisionCalls=0;decision=async()=>{decisionCalls++;return {speech:'同一段公开发言'}}",
    context,
  );
  context.fetch = async (url, request) => {
    natural.requests.push({ url, request, body: JSON.parse(request.body) });
    if (natural.requests.length === 1)
      return {
        ok: false,
        status: 503,
        json: async () => ({
          error: { code: 'VOICE_NETWORK_ERROR', message: '语音服务暂不可用', attempts: 3 },
        }),
      };
    return { ok: true, blob: async () => ({ size: 512, type: 'audio/mpeg' }) };
  };
  const turn = vm.runInContext('aiSpeeches(false,epoch)', context);
  try {
    await until(() => !!vm.runInContext('speechFailure', context));
    assert.equal(vm.runInContext('decisionCalls', context), 1);
    assert.equal(vm.runInContext('game.speeches.length', context), 1);
    assert.match(vm.runInContext("$('voiceStatus').textContent", context), /1 号.*已尝试 3 次/);
    assert.equal(
      vm.runInContext("$('speechRecovery').classList.contains('hidden')", context),
      false,
    );
    vm.runInContext("profiles[0].voiceApiVoice='speaker-b';retryFailedSpeech()", context);
    await until(() => natural.audios.length === 1);
    assert.equal(natural.requests.length, 2);
    assert.equal(natural.requests[0].body.text, natural.requests[1].body.text);
    assert.equal(natural.requests[1].body.voice, 'speaker-b');
    assert.equal(vm.runInContext('decisionCalls', context), 1);
    natural.audios[0].onended();
    await turn;
    assert.equal(vm.runInContext('speechBubble', context), null);
    assert.doesNotMatch(vm.runInContext("$('voiceStatus').textContent", context), /private-key/);
  } finally {
    if (vm.runInContext('speechFailure', context))
      vm.runInContext('continueSpeechWithoutAudio()', context);
    vm.runInContext('reset()', context);
  }
});

test('夜间 API 失败的私有席位与原因不会通过普通观战动态泄露', async () => {
  const { context } = setup();
  vm.runInContext("game.phase='night';setPerspective('public')", context);
  context.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { code: 'AUTH_FAILED', message: '专用接口故障' } }),
  });
  const pending = vm.runInContext("decision(8,'night')", context);
  await until(() => vm.runInContext('!!apiWaiting', context));
  assert.doesNotMatch(vm.runInContext("$('actionPanel').innerHTML", context), /9 号|专用接口故障/);
  vm.runInContext("setPerspective('god');renderAction()", context);
  assert.match(vm.runInContext("$('actionPanel').innerHTML", context), /9 号|专用接口故障/);
  vm.runInContext('reset()', context);
  await pending;
});

test('完整自动对局关键旁白按事件顺序播放，旁白不进入玩家上下文', async () => {
  const { context } = setup();
  prepareAuto(context, 12);
  const seen = [];
  context.capture = (text) => {
    seen.push(text);
    return Promise.resolve(true);
  };
  vm.runInContext(
    'spectatorPrefs.narratorEnabled=true;voiceEnabled=false;speakText=capture;game.random=()=>.9999',
    context,
  );
  await vm.runInContext('start()', context);
  assert.match(seen[0], /随机发牌/);
  assert.match(seen[1], /第 1 夜开始/);
  assert.ok(seen.some((t) => /天亮了/.test(t)));
  assert.ok(seen.some((t) => /开始公开投票/.test(t)));
  assert.match(seen.at(-1), /阵营获胜/);
  assert.equal(seen.length, vm.runInContext('observerEvents.length', context));
  assert.doesNotMatch(
    vm.runInContext('JSON.stringify(game.context(8))', context),
    /守护了|随机发牌完成|夜间角色将依次/,
  );
});

test('实际夜间行动期间只有当前角色睁眼，闭眼不改变Agent上下文，旧旁白不能跨重置恢复', async () => {
  const { context } = setup();
  vm.runInContext(
    "game.phase='night';turnDelay=0;let eyeActions=[];decision=async(id,task,extra)=>{eyeActions.push({id,open:game.players.filter(p=>!eyesClosed(p)).map(p=>p.id),context:game.context(id)});return localDecision(id,task,extra)}",
    context,
  );
  await vm.runInContext('runNight()', context);
  const observations = vm.runInContext('eyeActions', context);
  assert.ok(observations.length > 0);
  for (const step of observations) {
    assert.ok(step.open.includes(step.id));
    assert.equal(
      vm.runInContext(
        'game.players.filter(p=>' +
          JSON.stringify(Array.from(step.open)) +
          '.includes(p.id)).every(p=>p.role===game.players[' +
          step.id +
          '].role)',
        context,
      ),
      true,
    );
    assert.doesNotMatch(JSON.stringify(step.context), /nightAwake|eyeNight|eyeStates/);
  }
  assert.equal(vm.runInContext('nightAwake.length', context), 0);
  vm.runInContext(
    "spectatorPrefs.narratorEnabled=true;let releaseEye;commentaryQueue=[];speakText=()=>new Promise(r=>releaseEye=r);addObserver({kind:'night-cue',private:true,actors:[0],godText:'请睁眼'});let oldEyeFlush=flushCommentary(epoch)",
    context,
  );
  await until(() => vm.runInContext("typeof releaseEye==='function'", context));
  vm.runInContext('reset();releaseEye(true)', context);
  await vm.runInContext('oldEyeFlush', context);
  assert.equal(vm.runInContext('eyeNight||nightAwake.length>0', context), false);
});

test('个人选刀在上帝历史和导出保留，普通观战及实际 Agent 请求不增加观众信息', async () => {
  const { context, requests } = setup(new Map(), false);
  const shown = [];
  context.fetch = async (url, request) => {
    requests.push(JSON.parse(request.body));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"speech":"请说明判断依据。"}' } }] }),
    };
  };
  context.capture = async (text) => {
    shown.push(text);
    return true;
  };
  vm.runInContext(
    'var productionDecision=decision;game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);turnDelay=0;spectatorPrefs.narratorEnabled=true;speakText=capture;decision=async(id)=>id<2?{target:id+4}:id===3?{save:false,poison:null}:{target:0}',
    context,
  );
  await vm.runInContext('runNight()', context);
  assert.match(
    vm.runInContext("$('commentaryList').innerHTML+JSON.stringify(spectatorExport())", context),
    /1 号狼人提议袭击 \d+ 号/,
  );
  vm.runInContext("setPerspective('public')", context);
  assert.doesNotMatch(
    vm.runInContext(
      "$('playersGrid').innerHTML+$('commentaryText').textContent+$('commentaryList').innerHTML+JSON.stringify(spectatorExport())",
      context,
    ),
    /提议袭击|票数相同|wolfChoices|wolf-choice/,
  );
  vm.runInContext(
    "decision=productionDecision;profiles[0].control='api';profiles[0].endpoint='https://chat.test';profiles[0].model='test'",
    context,
  );
  await vm.runInContext("decision(0,'speech')", context);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(
    JSON.stringify(requests[0].messages),
    /wolfChoices|提议袭击|票数相同|godText|wolf-choice/,
  );
  vm.runInContext("setPerspective('god')", context);
  assert.match(
    vm.runInContext("$('commentaryList').innerHTML", context),
    /1 号狼人提议袭击 \d+ 号/,
  );
});

test('狼人 API 离线停留原行动，恢复后选刀与最终目标一致', async (t) => {
  const h = wolfHarness(t, { size: 6 }),
    { read, groups } = h;
  const running = h.start();
  await until(() => groups.length === 1);
  const first = groups[0].requests[0].action.seat;
  groups[0].error(first, 'UPSTREAM_ERROR');
  await until(() => read('voteBatch?.errorPause===true'));
  assert.equal(read("observerEvents.filter(e=>e.kind==='wolf').length"), 0);
  groups[0].result(groups[0].requests[1].action.seat, 2);
  read('retryVoteBatch()');
  await until(() => groups.length === 2);
  const retry = groups[1].requests.find((request) => request.action.seat === first);
  assert.ok(retry);
  groups[1].result(first, 3);
  const output = await running;
  assert.equal(output[first - 1].target, 2);
  assert.equal(read('paused'), false);
  assert.equal(read('voteBatch'), null);
  assert.equal(groups.length, 2);
});

test('模型上下文容量不足时保留完整输入、暂停并仅在手动重试后重新请求', async (t) => {
  const { context } = setup();
  let n = 0;
  const sent = [];
  t.after(() => vm.runInContext('reset()', context));
  context.fetch = async (url, options) => {
    if (url === '/api/agent-events') return { ok: true };
    sent.push(JSON.parse(options.body));
    n++;
    return n === 1
      ? {
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              code: 'CONTEXT_CAPACITY_EXCEEDED',
              message: '完整对局上下文超过当前模型或接口的容量上限。系统未删减或概括历史信息。',
            },
          }),
        }
      : { ok: true, json: async () => ({ choices: [{ message: { content: '{"target":2}' } }] }) };
  };
  vm.runInContext('busy=true', context);
  const pending = vm.runInContext("decision(8,'vote')", context);
  await until(() => vm.runInContext('!!apiWaiting', context));
  assert.equal(vm.runInContext('paused', context), true);
  assert.equal(vm.runInContext('apiWaiting.code', context), 'CONTEXT_CAPACITY_EXCEEDED');
  assert.match(vm.runInContext('apiWaiting.message', context), /未删减或概括历史信息/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(n, 1);
  vm.runInContext('retryAPI()', context);
  assert.equal((await pending).target, 1);
  assert.equal(n, 2);
  assert.deepEqual(sent[0].messages, sent[1].messages);
});

test('竖屏真实API断连与恢复立即同步人物和字幕，不重建媒体或重播亮相', async (t) => {
  for (const count of [6, 12]) {
    const { context } = setup(new Map(), false, true, false, true),
      read = (code) => vm.runInContext(code, context);
    t.after(() => read('reset()'));
    read(
      `reset(${count});game.start();game.phase='discussion';activeSeat=0;busy=true;profiles[0].control='api';profiles[0].endpoint='https://example.test/v1/chat/completions';profiles[0].model='test-model';profiles[0].key='test-key';setPortraitMode(true)`,
    );
    let requests = 0;
    context.fetch = async () =>
      ++requests === 1
        ? {
            ok: false,
            status: 503,
            json: async () => ({
              error: { code: 'UPSTREAM_NETWORK_ERROR', message: '服务暂时不可用' },
            }),
          }
        : {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: '{"speech":"先听听大家的意见。"}' } }],
            }),
          };
    const focus = read("$('portraitHero').dataset.focus"),
      running = read("decision(0,'speech')");
    await until(() => read('!!apiWaiting'));
    assert.equal(read("$('portraitHeroState').textContent"), '已暂停');
    assert.match(read("$('portraitCaption').textContent"), /1 号的当前行动已暂停，请手动重试/);
    assert.match(read("$('portraitAPIStatus').textContent"), /1号.*已暂停/);
    assert.equal(read("$('portraitAPIBar').classList.contains('waiting')"), true);
    assert.equal(read("$('portraitHero').dataset.focus"), focus);
    read('paused=true;renderAction()');
    assert.equal(read("$('portraitAPIRetry').disabled"), false);
    assert.equal(read("$('portraitHeroState').textContent"), '已暂停');
    read("paused=false;renderAction();handleAPIWaitCommand('retry-api')");
    assert.equal((await running).speech, '先听听大家的意见。');
    assert.equal(requests, 2);
    assert.equal(read('apiWaiting'), null);
    assert.equal(read("$('portraitAPIStatus').textContent"), '接口等待：无');
    assert.equal(read("$('portraitHeroState').textContent"), '思考中');
    assert.doesNotMatch(read("$('portraitCaption').textContent"), /当前行动已暂停/);
    assert.equal(read("$('portraitHero').dataset.focus"), focus);
    assert.equal(read('narration'), null);
    assert.equal(read('speechBubble'), null);
  }
});

test('模拟席位在轮到时计算，写入前文后才提前请求紧邻API席位', async (t) => {
  const h = speechPipeline(t, { actors: [0, 1, 2, 3], api: [0, 2, 3] }),
    { read, chat, playbacks, context } = h;
  context.localTurns = [];
  read(
    'const actualLocalDecision=localStoryDecision;localStoryDecision=(id,task,extra)=>{localTurns.push(id);return actualLocalDecision(id,task,extra)}',
  );
  const running = h.start();
  await until(() => chat.length === 1);
  chat[0].speech('第一位');
  await until(() => playbacks.length === 1);
  assert.equal(chat.length, 1);
  assert.equal(context.localTurns.length, 0);
  playbacks[0].finish();
  await until(() => playbacks.length === 2 && chat.length === 2);
  assert.deepEqual(context.localTurns, [1]);
  assert.equal(JSON.parse(chat[1].body.messages.at(-1).content).context.speeches.at(-1).seat, 2);
  chat[1].speech('第三位');
  await until(() => read('preparedSpeech.status') === 'ready');
  assert.equal(chat.length, 2);
  playbacks[1].finish();
  await until(() => playbacks.length === 3 && chat.length === 3);
  chat[2].speech('第四位');
  await until(() => read('preparedSpeech.status') === 'ready');
  playbacks[2].finish();
  await until(() => playbacks.length === 4);
  playbacks[3].finish();
  await running;
  assert.deepEqual(
    playbacks.map((p) => p.id),
    [0, 1, 2, 3],
  );
});

test('非法自投、非PK目标和残缺JSON分别暂停，成功席位保留，错误不会自动重发', async (t) => {
  const h = votingHarness(t, { pk: true }),
    { read, groups } = h;
  const running = h.start();
  await until(() => groups.length === 1);
  groups[0].result(1, 1);
  groups[0].result(3, 6);
  const request = groups[0].requests.find((x) => x.action.seat === 5);
  groups[0].emit({
    type: 'result',
    seat: 5,
    requestId: request.requestId,
    result: { choices: [{ message: { content: '{"target":' } }] },
  });
  groups[0].result(6, 2);
  await until(() => read('voteBatchStatus().failed.length') === 3);
  assert.equal(read('voteBatchStatus().received'), 1);
  assert.equal(groups.length, 1);
  assert.equal(read('Object.keys(votePresentation.votes).length'), 0);
  assert.deepEqual(
    h.events.map((e) => e.code),
    ['INVALID_ACTION', 'INVALID_ACTION', 'INVALID_AGENT_RESPONSE', 'ACTION_VALIDATED'],
  );
  assert.deepEqual(
    h.events.map((e) => e.validation?.rule),
    ['TARGET_NOT_ALLOWED', 'TARGET_NOT_ALLOWED', undefined, undefined],
  );
  assert.deepEqual(
    h.events.slice(0, 2).map((e) => e.validation.targetAllowed),
    [false, false],
  );
  read('retryAPI()');
  await until(() => groups.length === 2);
  assert.deepEqual(
    groups[1].requests.map((x) => x.action.seat),
    [1, 3, 5],
  );
  h.replyAll();
  await running;
});

test('猎人省略目标等同放弃，普通席位和观战记录均不包含私有结算', () => {
  const { context } = setup();
  const read = (code) => vm.runInContext(code, context);
  prepareAuto(context, 12);
  read(
    `game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[12][i]);game.resolveNight({},6);`,
  );
  assert.equal(
    read(`validateAgentDecision(6,'hunter','{}',buildAgentContext(6,'hunter')).target`),
    null,
  );
  read("spectatorPrefs.perspective='public'");
  assert.equal(read('spectatorExport().phase'), 'settlement');
  read('game.shoot(null);syncLogs();');
  assert.doesNotMatch(read('JSON.stringify(spectatorExport())'), /猎人出局|放弃开枪|可选择开枪/);
  read("spectatorPrefs.perspective='god'");
  assert.match(read('spectatorExport().log.join(" ")'), /放弃开枪/);
  assert.doesNotMatch(read(`JSON.stringify(game.context(0).publicEvents)`), /猎人|开枪/);
  assert.equal(
    read(
      `observerEvents.filter(e=>/放弃开枪/.test(e.godText)).every(e=>!NightfallObserver.project(e,'public'))`,
    ),
    true,
  );
  assert.match(read(`observerEvents.map(e=>e.godText).join(' ')`), /放弃开枪/);
});
