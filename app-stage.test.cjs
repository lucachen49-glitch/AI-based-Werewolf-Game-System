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

test('关键事件动画与真实事件对应，公开视角不含夜间秘密，视角切换与规则介绍可清除', async () => {
  const { context } = setup(new Map(), false);
  const releases = [];
  context.effectWait = () => new Promise((r) => releases.push(r));
  vm.runInContext("presentationWait=effectWait;game.start();setPerspective('public')", context);
  for (const kind of [
    'night',
    'dawn',
    'discussion',
    'voting',
    'pk',
    'exile',
    'hunter',
    'hunter-result',
    'winner',
  ]) {
    vm.runInContext(
      "animateEvent({kind:'" +
        kind +
        "',round:1,publicText:'公开结果',godText:'秘密查验 1 号是狼人'},epoch)",
      context,
    );
    assert.equal(vm.runInContext('sceneMotion.kind', context), kind);
    assert.doesNotMatch(
      vm.runInContext("$('sceneEffect').innerHTML", context),
      /秘密查验|1 号是狼人/,
    );
  }
  vm.runInContext("setPerspective('god')", context);
  assert.equal(vm.runInContext('sceneMotion', context), null);
  for (const release of releases) release();
  await new Promise(setImmediate);
  assert.equal(vm.runInContext('sceneMotion', context), null);
});

test('真实请求格式含独立模型和完整规则，不向平民发送隐藏身份', async () => {
  const { context, requests, calls, timeouts } = setup();
  const result = await vm.runInContext("decision(8,'vote')", context);
  assert.equal(result.target, 0);
  const req = requests[0],
    view = JSON.parse(req.messages[1].content).context;
  assert.equal(req.model, 'test-model');
  assert.match(req.messages[0].content, /不能连续守/);
  assert.equal(view.seat, 9);
  assert.equal(view.role, '平民');
  assert.ok(view.players.every((p) => !('role' in p)));
  assert.equal(view.wolfTeammates, undefined);
  assert.equal(view.potions, undefined);
  assert.equal(view.allowedTargets.includes(9), false);
  assert.equal(calls[0].url, '/api/chat');
  assert.equal(calls[0].request.headers.Authorization, undefined);
  assert.equal(req.endpoint, 'https://example.test/v1/chat/completions');
  assert.equal(req.apiKey, 'secret-test-key');
  assert.equal(JSON.stringify(req.messages).includes('secret-test-key'), false);
  assert.equal(timeouts.includes(185000), false);
  assert.equal(req.purpose, 'game-action');
  assert.equal(req.action.task, 'vote');
  assert.match(req.requestId, /^agent-/);
});

test('女巫解药耗尽后不再获取狼刀目标，保留自己的药水信息', async () => {
  const { context, requests } = setup();
  vm.runInContext(
    "profiles[5]={...profiles[8]};game.phase='night';game.potions.save=false;",
    context,
  );
  context.fetch = async (url, request) => {
    requests.push(JSON.parse(request.body));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"save":false,"poison":null}' } }] }),
    };
  };
  await vm.runInContext("decision(5,'night',{victim:8})", context);
  const view = JSON.parse(requests[0].messages[1].content).context;
  assert.equal(view.tonightVictim, undefined);
  assert.equal(view.potions.save, false);
  assert.equal(view.potions.poison, true);
});

test('默认 recent 与显式 full 在 6/12 人对局中按最近两轮筛选发言', () => {
  const { context } = setup(new Map(), false),
    read = (code) => vm.runInContext(code, context);
  for (const size of [6, 12]) {
    context.historyFixture = { size };
    read(
      'size=historyFixture.size;game=new Nightfall.Game(size).start();game.players.forEach((player,index)=>player.role=Nightfall.ROLES[size][index]);game.round=4;game.phase=\"voting\";game.speechHistory=Array.from({length:size*4},(_,i)=>({id:i%size,text:\"发言\"+(i+1),round:Math.floor(i/size)+1,pk:i%5===0}));game.logs=Array.from({length:17},(_,i)=>({text:\"事件\"+(i+1),round:Math.floor(i/size)+1,phase:\"voting\"}));profiles.forEach(profile=>profile.historyContext=\"recent\");',
    );
    const recent = JSON.parse(read('JSON.stringify(buildAgentContext(0,\"vote\"))'));
    assert.equal(recent.speeches.length, size * 2);
    assert.equal(recent.speeches[0].round, 3);
    assert.equal(recent.speeches.at(-1).round, 4);
    assert.equal(recent.publicEvents.length, 17);
    read('profiles[0].historyContext=\"full\"');
    const full = JSON.parse(read('JSON.stringify(buildAgentContext(0,\"night\"))'));
    assert.equal(full.speeches.length, size * 4);
    assert.equal(full.publicEvents.length, 17);
  }
});

test('供应商错误提示原样展示为安全中文，不再笼统提示跨域', async () => {
  const { context } = setup();
  context.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({
      error: { code: 'AUTH_FAILED', message: 'API Key 无效或未填写，请检查密钥' },
    }),
  });
  assert.equal(await vm.runInContext('testConnection(profiles[8],false)', context), false);
  assert.equal(vm.runInContext('profiles[8].connection', context), 'error');
  assert.match(vm.runInContext("$('toast').textContent", context), /API Key 无效/);
  assert.doesNotMatch(vm.runInContext("$('toast').textContent", context), /跨域/);
});

test('旧本地服务、断网和非法响应分别给出可操作提示', async () => {
  const { context } = setup();
  context.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => {
      throw new SyntaxError('HTML');
    },
  });
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])', context), /本地服务需要重启/);
  context.fetch = async () => {
    const e = Error('Failed to fetch');
    e.name = 'TypeError';
    throw e;
  };
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])', context), /启动窗口仍在运行/);
  context.fetch = async () => ({ ok: true, json: async () => ({ choices: [] }) });
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])', context), /返回格式不正确/);
});

test('重置游戏取消进行中的转发，停止旧对局请求', async () => {
  const { context } = setup();
  context.fetch = async (url, { signal }) =>
    new Promise((resolve, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {
        once: true,
      }),
    );
  const pending = vm.runInContext('apiCall(profiles[8],[])', context);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  vm.runInContext('reset()', context);
  await rejected;
  assert.equal(vm.runInContext('activeRequest', context), null);
});

test('全屏进入、点击退出与浏览器 Esc 退出同步恢复布局，不重置对局', async () => {
  const { context, events } = setup(),
    doc = context.document;
  let requested = 0,
    exited = 0;
  doc.documentElement.requestFullscreen = async () => {
    requested++;
    doc.fullscreenElement = doc.documentElement;
  };
  doc.exitFullscreen = async () => {
    exited++;
    doc.fullscreenElement = null;
  };
  const original = vm.runInContext('game', context);
  await vm.runInContext('toggleFullscreen()', context);
  assert.equal(requested, 1);
  assert.equal(doc.body.classList.contains('watch-mode'), true);
  assert.equal(vm.runInContext("$('fullscreenBtn').textContent", context), '⛶ 退出全屏');
  assert.equal(vm.runInContext("$('storyMovieFullscreen').textContent", context), '⛶ 退出全屏');
  assert.equal(
    vm.runInContext("$('storyMovieFullscreen').attributes['aria-pressed']", context),
    'true',
  );
  await vm.runInContext('toggleFullscreen()', context);
  assert.equal(exited, 1);
  assert.equal(doc.body.classList.contains('watch-mode'), false);
  assert.equal(vm.runInContext("$('storyMovieFullscreen').textContent", context), '⛶ 全屏观战');
  await vm.runInContext('toggleFullscreen()', context);
  doc.fullscreenElement = null;
  events.fullscreenchange.forEach((fn) => fn());
  assert.equal(doc.body.classList.contains('watch-mode'), false);
  assert.equal(vm.runInContext('game', context), original);
});

test('全屏被浏览器拒绝时进入沉浸布局，Esc 退出；规则弹窗优先关闭', async () => {
  const { context, events } = setup();
  context.document.documentElement.requestFullscreen = async () => {
    throw Error('denied');
  };
  await vm.runInContext('toggleFullscreen()', context);
  assert.equal(vm.runInContext('watchMode', context), true);
  assert.match(vm.runInContext("$('toast').textContent", context), /沉浸观战/);
  vm.runInContext('openRulesIntro()', context);
  const escape = { key: 'Escape', preventDefault() {} };
  events.keydown.forEach((fn) => fn(escape));
  assert.equal(vm.runInContext("$('rulesBackdrop').classList.contains('hidden')", context), true);
  assert.equal(vm.runInContext('watchMode', context), true);
  events.keydown.forEach((fn) => fn(escape));
  assert.equal(vm.runInContext('watchMode', context), false);
});

test('6/12 人只调用一次开始即可自动完成整局与再次开局', async (t) => {
  for (const size of [6, 12])
    await t.test(`${size} 人`, async () => {
      const { context } = setup();
      prepareAuto(context, size);
      vm.runInContext(
        `
      let seed=35;game.random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
      const actualDecision=decision;let turns=0;
      decision=async(...args)=>{if(++turns>1500)throw Error('Too many turns');return actualDecision(...args)};
      const actualOpenVoting=game.openVoting.bind(game);
      game.openVoting=()=>{if(game.speeches.length!==game.alive().length)throw Error('Missing speech');return actualOpenVoting()};
    `,
        context,
      );
      await vm.runInContext('start()', context);
      assert.equal(vm.runInContext('runError', context), '');
      assert.equal(vm.runInContext('game.phase', context), 'ended');
      assert.ok(vm.runInContext('game.winner', context));
      assert.equal(vm.runInContext('busy', context), false);
      assert.ok(vm.runInContext('game.speechHistory.length', context) > 0);
      assert.doesNotMatch(
        vm.runInContext("$('actionPanel').innerHTML", context),
        /data-command="(?:vote|hunter|night|speak)"/,
      );
      assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /狼人/);
      const previous = vm.runInContext('game', context);
      await vm.runInContext('start()', context);
      assert.notEqual(vm.runInContext('game', context), previous);
      assert.equal(vm.runInContext('game.phase', context), 'ended');
    });
});

test('猎人狼刀或放逐出局后自动开枪，并继续剩余流程', async (t) => {
  for (const cause of ['night', 'vote'])
    await t.test(cause, async () => {
      const { context } = setup();
      prepareAuto(context, 12);
      context.hunterCause = cause;
      vm.runInContext(
        `
      game.random=()=>.9999;let shots=0;
      decision=(id,task)=>{
        if(task==='speech')return {speech:'我将独立判断'};
        if(task==='hunter'){shots++;return {target:0}}
        if(task==='night')return game.players[id].role==='女巫'?{save:false,poison:null}:{target:game.players[id].role==='狼人'&&game.round===1&&hunterCause==='night'?6:null};
        const target=hunterCause==='vote'&&game.round===1?6:game.alive().find(p=>p.role==='狼人').id;
        return {target:id===target?null:target};
      };localStoryDecision=decision;
    `,
        context,
      );
      await vm.runInContext('start()', context);
      assert.equal(vm.runInContext('runError', context), '');
      assert.equal(vm.runInContext('game.phase', context), 'ended');
      assert.equal(vm.runInContext('shots', context), 1);
      assert.equal(vm.runInContext('game.players[0].cause', context), 'hunter');
    });
});

test('暂停允许当前请求完成，后续行动停止，继续后自动到终局，重复开始无效', async () => {
  const { context } = setup();
  prepareAuto(context, 6);
  vm.runInContext(
    "game.random=()=>.9999;profiles[0].control='api';profiles[0].endpoint='https://example.test';profiles[0].model='first-seat'",
    context,
  );
  let release,
    requests = 0;
  context.fetch = batchCompatibleFetch(async (url, options) => {
    if (url === '/api/chat') requests++;
    if (requests === 1 && url === '/api/chat') await new Promise((resolve) => (release = resolve));
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify(
                input.task === 'speech'
                  ? { speech: '我会根据发言判断' }
                  : { target: input.context.allowedTargets[0] ?? null },
              ),
            },
          },
        ],
      }),
    };
  });
  const playing = vm.runInContext('start()', context);
  await until(() => !!release);
  const activeSeat = vm.runInContext('activeSeat', context),
    voteBatch = vm.runInContext('voteBatch', context);
  assert.ok(activeSeat === 0 || voteBatch, '当前 API 请求应处于单席行动或狼人批次等待状态');
  assert.doesNotMatch(
    vm.runInContext("$('actionPanel').innerHTML", context),
    /狼人正在|预言家正在|女巫正在/,
  );
  vm.runInContext('togglePause()', context);
  release();
  await new Promise(setImmediate);
  await vm.runInContext('start()', context);
  assert.equal(requests, 1);
  assert.equal(vm.runInContext('paused', context), true);
  assert.equal(vm.runInContext('game.round', context), 1);
  vm.runInContext('togglePause()', context);
  await playing;
  assert.equal(vm.runInContext('game.phase', context), 'ended');
});

test('暂停等待中切房立即释放旧流程，新一局可正常自动完成', async () => {
  const { context } = setup();
  prepareAuto(context, 6);
  vm.runInContext('turnDelay=2600', context);
  const playing = vm.runInContext('start()', context);
  vm.runInContext('togglePause()', context);
  await new Promise(setImmediate);
  vm.runInContext('reset(12);turnDelay=0', context);
  await playing;
  assert.equal(vm.runInContext('game.phase', context), 'lobby');
  assert.equal(vm.runInContext('game.size', context), 12);
  assert.equal(vm.runInContext('busy', context), false);
  await vm.runInContext('start()', context);
  assert.equal(vm.runInContext('game.phase', context), 'ended');
});

test('批量测试重置会取消两路在途请求，不遗留加载状态且不再请求排队席位', async () => {
  const { context } = setup();
  let requests = 0,
    aborted = 0;
  vm.runInContext(
    'reset(12);profiles[0]={...profiles[8]};profiles[2]={...profiles[8]};profiles[4]={...profiles[8]}',
    context,
  );
  context.fetch = async (url, { signal }) => {
    requests++;
    return new Promise((resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted++;
          reject(new DOMException('Cancelled', 'AbortError'));
        },
        { once: true },
      ),
    );
  };
  const run = vm.runInContext('testAll()', context);
  assert.equal(requests, 2);
  vm.runInContext('reset(6)', context);
  await run;
  assert.equal(aborted, 2);
  assert.equal(requests, 2);
  assert.equal(vm.runInContext('connectionBatch', context), null);
  assert.equal(vm.runInContext('connectionTests', context), 0);
  assert.equal(vm.runInContext('activeRequestControllers.size', context), 0);
  assert.equal(
    vm.runInContext('profiles.some(p=>["testing","queued"].includes(p.connection))', context),
    false,
  );
  assert.equal(vm.runInContext("$('testAllBtn').disabled", context), false);
});

test('完整发言跨轮保留，按席位筛选，保留 PK、时间和独立重播索引', () => {
  const { context } = setup();
  vm.runInContext(
    "for(let i=0;i<150;i++){game.round=1+Math.floor(i/12);game.pk=i%2?[0,1]:null;addSpeech(i%12,'公开发言 '+i)}recordSeat='0';renderTranscript()",
    context,
  );
  assert.equal(vm.runInContext('transcript.length', context), 150);
  assert.equal(vm.runInContext('filteredSpeeches().length', context), 13);
  const html = vm.runInContext("$('transcript').innerHTML", context);
  assert.match(html, /公开发言 0<|公开发言 0</);
  assert.match(html, /公开发言 144/);
  assert.match(html, /data-record-replay="144"/);
  vm.runInContext("recordSeat='1';renderTranscript()", context);
  assert.match(vm.runInContext("$('transcript').innerHTML", context), /PK发言/);
  assert.doesNotMatch(vm.runInContext("$('transcript').innerHTML", context), /公开发言 144/);
  vm.runInContext('reset()', context);
  assert.equal(vm.runInContext('transcript.length', context), 0);
});

test('查看旧记录不跳底，新消息提示可回到最新，左右三栏独立保留位置', () => {
  const { context } = setup();
  vm.runInContext(
    "addSpeech(0,'第一条');Object.assign($('recordsViewport'),{scrollTop:20,scrollHeight:1000,clientHeight:200});$('recordsViewport').listeners.scroll();addSpeech(1,'第二条')",
    context,
  );
  assert.equal(vm.runInContext("$('recordsViewport').scrollTop", context), 20);
  assert.equal(vm.runInContext("$('newRecordsBtn').classList.contains('hidden')", context), false);
  assert.match(vm.runInContext("$('newRecordsBtn').textContent", context), /1 条新记录/);
  vm.runInContext(
    "Object.assign($('commentaryViewport'),{scrollTop:30,scrollHeight:700,clientHeight:200});$('commentaryViewport').listeners.scroll();addObserver({round:1,publicText:'新旁白',godText:'新旁白'})",
    context,
  );
  assert.equal(vm.runInContext("$('recordsViewport').scrollTop", context), 20);
  vm.runInContext('jumpToLatest()', context);
  assert.equal(vm.runInContext("$('recordsViewport').scrollTop", context), 1000);
  assert.equal(vm.runInContext("$('newRecordsBtn').classList.contains('hidden')", context), true);
});

test('重播在对局暂停时正常结束，不抢占自动对局的继续等待', async () => {
  const { context } = setup(),
    { spoken } = installSpeech(context);
  vm.runInContext("busy=true;paused=true;addSpeech(0,'重播公开发言')", context);
  vm.runInContext('voiceEnabled=true', context);
  let resumed = false;
  const waiting = vm.runInContext('waitForTurn(epoch,0)', context).then(() => (resumed = true));
  const replay = vm.runInContext('replaySpeech(0)', context);
  spoken[0].onend();
  await replay;
  assert.equal(vm.runInContext('speechBubble', context), null);
  assert.equal(resumed, false);
  vm.runInContext('togglePause()', context);
  await waiting;
  assert.equal(resumed, true);
});

test('夜间说明只取规则引擎确认结果，无效或旧查验不被当作新行动', () => {
  const Observer = require('./observer.js'),
    g = new Nightfall.Game(12).start();
  g.players.forEach((p, i) => (p.role = Nightfall.ROLES[12][i]));
  g.players[8].alive = false;
  g.knowledge[4] = { 8: '好人' };
  const result = g.resolveNight(
    { 4: { target: 8 }, 5: { save: false, poison: 5 }, 7: { target: 7 } },
    null,
  );
  assert.equal(result.seerCheck, null);
  assert.equal(result.poisoned, null);
  assert.equal(result.guardTarget, 7);
  const e = Observer.commentary(
    g.logs.find((l) => /^天亮了/.test(l.text)),
    result,
  );
  assert.doesNotMatch(e.godText, /查验 9|使用毒药/);
  assert.match(e.godText, /8 号守卫守护了 8 号/);
  assert.doesNotMatch(e.publicText, /守护|预言家|未使用药水/);
  const next = new Nightfall.Game(6).start();
  next.players.forEach((p, i) => (p.role = Nightfall.ROLES[6][i]));
  assert.deepEqual(next.resolveNight({ 2: { target: 0 } }, null).seerCheck, {
    id: 2,
    target: 0,
    result: '狼人',
  });
});

test('每夜闭眼与天亮睁眼口令完整，角色口令在请求前播放，结果后闭眼', async () => {
  const observer = require('./observer.js');
  for (const round of [1, 2, 3]) {
    const event = observer.commentary({
      text: '第 ' + round + ' 夜开始。' + (round === 1 ? '天黑请闭眼。' : ''),
      round,
      phase: 'night',
    });
    assert.equal((event.godText.match(/天黑请闭眼/g) || []).length, 1);
  }
  assert.match(
    observer.commentary({ text: '天亮了。昨夜是平安夜。', round: 1, phase: 'discussion' })
      .publicText,
    /天亮了，请睁眼/,
  );
  const { context } = setup(new Map(), false),
    order = [];
  context.hear = (text) => {
    order.push(text);
    return Promise.resolve(true);
  };
  context.choose = (id) => {
    order.push('行动:' + vm.runInContext('game.players[' + id + '].role', context));
    return Promise.resolve({ target: null, save: false, poison: null });
  };
  vm.runInContext(
    'game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);speakText=hear;takeTurn=choose;spectatorPrefs.narratorEnabled=true',
    context,
  );
  await vm.runInContext('runNight(epoch)', context);
  for (const role of ['狼人', '预言家', '女巫']) {
    const cue = order.findIndex((t) => t.startsWith(role + '请睁眼'));
    const action =
      role === '狼人'
        ? order.findIndex((t) => /提议袭击|没有形成有效的袭击目标/.test(t))
        : order.findIndex((t) => t === '行动:' + role);
    const closed =
      role === '狼人'
        ? action
        : order.findIndex((t, i) => i > action && t.includes(role + '请闭眼'));
    assert.ok(
      cue >= 0 && cue < action && (role === '狼人' ? closed >= action : closed > action),
      role + ': ' + order.join('|'),
    );
  }
  assert.ok(order.some((t) => t.includes('狼人请杀人')));
});

test('重置发生在夜间口令时，旧回调不再请求角色行动', async () => {
  const { context } = setup(new Map(), false);
  let release,
    calls = 0;
  context.waitCue = () => new Promise((r) => (release = r));
  context.choose = () => {
    calls++;
    return Promise.resolve({});
  };
  vm.runInContext(
    'game.start();speakText=waitCue;takeTurn=choose;spectatorPrefs.narratorEnabled=true',
    context,
  );
  const running = vm.runInContext('runNight(epoch)', context);
  await until(() => !!release);
  vm.runInContext('reset()', context);
  release(true);
  await running;
  assert.equal(calls, 0);
  assert.equal(vm.runInContext('observerEvents.length', context), 0);
});

test('出局原因使用引擎结果，六人与十二人文字和标记一致，普通观战隐藏狼刀与毒药', () => {
  for (const count of [6, 12]) {
    const { context } = setup(new Map(), false);
    vm.runInContext(
      'reset(' +
        count +
        ');game.start();game.phase="discussion";["wolf","vote","poison","hunter"].forEach((cause,i)=>Object.assign(game.players[i],{alive:false,cause}));renderPlayers()',
      context,
    );
    let html = vm.runInContext("$('playersGrid').innerHTML", context);
    for (const [kind, label] of [
      ['wolf', '遭狼袭'],
      ['vote', '投票放逐'],
      ['poison', '中毒出局'],
      ['hunter', '猎人击中'],
    ]) {
      assert.match(html, new RegExp('eliminated-' + kind));
      assert.match(html, new RegExp(label));
    }
    vm.runInContext("setPerspective('public')", context);
    html = vm.runInContext("$('playersGrid').innerHTML", context);
    assert.doesNotMatch(html, /遭狼袭|中毒出局|eliminated-wolf|eliminated-poison/);
    assert.equal((html.match(/eliminated-night/g) || []).length, 2);
    assert.match(html, /投票放逐/);
    assert.match(html, /猎人击中/);
    vm.runInContext("game.phase='ended';renderPlayers()", context);
    html = vm.runInContext("$('playersGrid').innerHTML", context);
    assert.match(html, /遭狼袭/);
    assert.match(html, /中毒出局/);
    vm.runInContext('reset()', context);
    assert.doesNotMatch(
      vm.runInContext("$('playersGrid').innerHTML", context),
      /elimination-mark|eliminated-/,
    );
  }
});

test('视角切换立即清除夜间目标，私有记录不留空行，胜方已出局成员仍高亮', async () => {
  const { context } = setup(new Map(), false);
  vm.runInContext(
    "game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);addObserver({private:true,kind:'poison',actors:[3],target:0,round:1,godText:'秘密用药',publicText:''},false);nightFocus=observerEvents[0];currentCommentary=nightFocus;renderAll()",
    context,
  );
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /action-target/);
  vm.runInContext("setPerspective('public')", context);
  assert.doesNotMatch(
    vm.runInContext(
      "$('playersGrid').innerHTML+$('commentaryList').innerHTML+$('commentaryText').textContent",
      context,
    ),
    /action-target|秘密用药|narrator-record/,
  );
  vm.runInContext(
    "game.phase='ended';game.winner='狼人';game.players[0].alive=false;renderPlayers()",
    context,
  );
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /dead .*winner-seat/);
  assert.equal(
    (vm.runInContext("$('playersGrid').innerHTML", context).match(/winner-seat/g) || []).length,
    2,
  );
});

test('夜间口令驱动闭眼和行动者睁眼，普通观战不泄露身份，天亮恢复', () => {
  const { context } = setup();
  vm.runInContext("beginEyeEvent({kind:'night'});", context);
  assert.equal(vm.runInContext('game.players.every(eyesClosed)', context), true);
  vm.runInContext("beginEyeEvent({kind:'night-cue',actors:[0,1]})", context);
  assert.deepEqual(Array.from(vm.runInContext('game.players.map(eyesClosed)', context)), [
    false,
    false,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
  vm.runInContext("setPerspective('public')", context);
  assert.equal(vm.runInContext('game.players.every(eyesClosed)', context), true);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML", context), /data-eyes="open"/);
  vm.runInContext("setPerspective('god');endEyeEvent({kind:'wolf'})", context);
  assert.equal(vm.runInContext('game.players.every(eyesClosed)', context), true);
  vm.runInContext("beginEyeEvent({kind:'dawn'});game.players[0].alive=false", context);
  assert.equal(
    vm.runInContext('eyesClosed(game.players[0])&&!eyesClosed(game.players[1])', context),
    true,
  );
  vm.runInContext('reset()', context);
  assert.equal(vm.runInContext('eyeNight||nightAwake.length>0', context), false);
});

test('六人个人狼刀同刀、平票、单狼、放弃和无效目标与女巫及天亮结算一致', async () => {
  for (const spec of [
    { targets: [4, 4], victim: 4, tie: false },
    { targets: [4, 5], victim: 5, tie: true },
    { targets: [4, null], victim: 4, tie: false, deadWolf: true },
    { targets: [null, null], victim: null, tie: false },
    { targets: [1, 99], victim: null, tie: false },
    { targets: [4, 4], victim: 4, tie: false, save: true },
  ]) {
    const { context } = setup(new Map(), false),
      spoken = [],
      choosing = [];
    let witchVictim,
      rolls = 0;
    context.spec = spec;
    context.roll = () => {
      rolls++;
      return 0.99;
    };
    context.choose = async (id, task, extra) => {
      if (id < 2)
        choosing.push(vm.runInContext('seatDecorations(game.players[' + id + '])', context));
      if (id === 3) witchVictim = extra.victim;
      return id < 2
        ? { target: spec.targets[id] }
        : id === 3
          ? { save: !!spec.save, poison: null }
          : { target: 0 };
    };
    context.hear = async (text) => {
      spoken.push(text);
      return true;
    };
    vm.runInContext(
      'game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);if(spec.deadWolf)game.players[1].alive=false;game.random=roll;decision=choose;speakText=hear;turnDelay=0;spectatorPrefs.narratorEnabled=true',
      context,
    );
    await vm.runInContext('runNight(epoch)', context);
    const event = vm.runInContext("observerEvents.find(e=>e.kind==='wolf')", context);
    assert.equal(event.target, witchVictim);
    assert.equal(event.wolfChoices.length, spec.deadWolf ? 1 : 2);
    assert.equal(event.private, true);
    assert.ok(
      event.wolfChoices.every(
        (choice) =>
          choice.status === 'selected' ||
          choice.status === 'abstained' ||
          choice.status === 'invalid',
      ),
    );
    assert.ok(choosing.every((html) => html.includes('正在选刀')));
    assert.equal(spoken.filter((text) => /提议袭击|放弃袭击|未形成有效选择/.test(text)).length, 1);
    if (event.target !== null)
      assert.match(event.godText, new RegExp('今晚袭击 ' + (event.target + 1) + ' 号'));
    assert.equal(vm.runInContext('wolfPresentation', context), null);
    assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML", context), /wolf-choice/);
  }
});

test('十二人四狼分刀只确定一次目标，个人明细与女巫及结算一致', async () => {
  const { context } = setup(new Map(), false),
    hints = [],
    spoken = [];
  let rolls = 0,
    victim;
  context.roll12 = () => {
    rolls++;
    return 0.99;
  };
  context.pick12 = async (id, task, extra) => {
    if (id < 4) hints.push(vm.runInContext('seatDecorations(game.players[' + id + '])', context));
    if (id === 5) victim = extra.victim;
    return id < 4
      ? { target: id < 2 ? 8 : 9 }
      : id === 7
        ? { target: 10 }
        : id === 5
          ? { save: false, poison: null }
          : { target: 0 };
  };
  context.hear12 = async (text) => {
    spoken.push(text);
    return true;
  };
  vm.runInContext(
    'reset(12);game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[12][i]);game.random=roll12;decision=pick12;speakText=hear12;turnDelay=0;spectatorPrefs.narratorEnabled=true',
    context,
  );
  await vm.runInContext('runNight()', context);
  const e = vm.runInContext("observerEvents.find(e=>e.kind==='wolf')", context);
  assert.equal(e.wolfChoices.length, 4);
  assert.equal(e.target, victim);
  assert.ok(e.target === null || rolls >= 1);
  assert.ok(hints.every((h) => h.includes('正在选刀')));
  assert.ok(spoken.filter((t) => /提议袭击/.test(t)).length >= 1);
  if (e.target !== null)
    assert.equal(vm.runInContext('game.players[' + e.target + '].alive', context), false);
  vm.runInContext("setPerspective('public')", context);
  assert.doesNotMatch(
    vm.runInContext(
      "$('commentaryList').innerHTML+JSON.stringify(spectatorExport())+$('playersGrid').innerHTML",
      context,
    ),
    /wolfChoices|提议袭击|票数相同|wolf-choice/,
  );
});

test('狼刀提示暂停保留、切视角立即隐藏，重置及换房隔离迟到结果', async (t) => {
  for (const resetSize of [6, 12]) {
    const h = wolfHarness(t, { size: resetSize }),
      { read, groups } = h;
    read('wolfPresentation={round:game.round,states:{}};renderPlayers()');
    const running = h.start();
    await until(() => groups.length === 1);
    read('renderPlayers()');
    assert.match(read("$('playersGrid').innerHTML"), /正在选刀/);
    read('togglePause()');
    assert.match(read("$('playersGrid').innerHTML"), /正在选刀/);
    read("setPerspective('public')");
    assert.doesNotMatch(read("$('playersGrid').innerHTML"), /wolf-choice|正在选刀/);
    read("setPerspective('god')");
    assert.match(read("$('playersGrid').innerHTML"), /正在选刀/);
    read('reset(' + resetSize + ')');
    for (const group of groups) group.close();
    await running;
    assert.equal(read('wolfPresentation'), null);
    assert.equal(read('observerEvents.length'), 0);
    assert.doesNotMatch(read("$('playersGrid').innerHTML"), /wolf-choice|提议袭击/);
  }
});

test('鉴权失败暂停且普通继续不重试，重置释放当前行动', async (t) => {
  const { context } = setup();
  let n = 0;
  t.after(() => vm.runInContext('reset()', context));
  context.fetch = async () => {
    n++;
    return {
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'AUTH_FAILED', message: '鉴权失败' } }),
    };
  };
  const pending = vm.runInContext("decision(8,'vote')", context);
  await until(() => vm.runInContext('!!apiWaiting', context));
  assert.equal(vm.runInContext('paused', context), true);
  assert.equal(vm.runInContext('apiWaiting.nextAt', context), null);
  vm.runInContext('busy=true;togglePause();wakeAPIWait()', context);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(n, 1);
  assert.equal(vm.runInContext('paused', context), true);
  vm.runInContext('reset()', context);
  await pending;
  assert.equal(n, 1);
  assert.equal(vm.runInContext('apiWaiting', context), null);
});

test('全屏默认隐藏记录，退出恢复原有偏好', async () => {
  const { context } = setup();
  vm.runInContext('spectatorPrefs.railOpen=true', context);
  await vm.runInContext('toggleFullscreen()', context);
  assert.equal(vm.runInContext('spectatorPrefs.railOpen', context), false);
  vm.runInContext('spectatorPrefs.railOpen=true', context);
  await vm.runInContext('toggleFullscreen()', context);
  assert.equal(vm.runInContext('spectatorPrefs.railOpen', context), true);
});

test('限流及临时故障持续暂停，只有手动重试发起一笔新请求', async (t) => {
  const { context } = setup();
  let n = 0;
  const sent = [];
  context.fetch = async (u, o) => {
    sent.push(JSON.parse(o.body));
    n++;
    return n === 1
      ? {
          ok: false,
          status: 429,
          json: async () => ({ error: { code: 'RATE_LIMITED', message: '稍后重试' } }),
        }
      : { ok: true, json: async () => ({ choices: [{ message: { content: '{"target":2}' } }] }) };
  };
  context.clock = 1000;
  vm.runInContext('Date.now=()=>clock;busy=true', context);
  t.after(() => vm.runInContext('reset()', context));
  const pending = vm.runInContext("decision(8,'vote')", context);
  await until(() => vm.runInContext('!!apiWaiting', context));
  vm.runInContext('clock+=600000;togglePause();wakeAPIWait()', context);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(n, 1);
  assert.equal(vm.runInContext('paused', context), true);
  vm.runInContext('retryAPI();retryAPI()', context);
  assert.equal((await pending).target, 1);
  assert.equal(n, 2);
  assert.notEqual(sent[0].requestId, sent[1].requestId);
  assert.deepEqual(sent[0].messages, sent[1].messages);
});

test('浏览器Esc退出原生全屏恢复进入前记录状态', () => {
  const { context, events } = setup();
  vm.runInContext('spectatorPrefs.railOpen=true;setWatchMode(true);nativeWatch=true', context);
  events.fullscreenchange[0]();
  assert.equal(vm.runInContext('watchMode', context), false);
  assert.equal(vm.runInContext('spectatorPrefs.railOpen', context), true);
});

test('竖屏亮相可暂停、切换和重置取消，圆桌不增加亮相等待', async () => {
  const { context } = setup(new Map(), false, true, false, true),
    { spoken } = installSpeech(context, { autoEnd: true });
  vm.runInContext('voiceEnabled=true', context);
  vm.runInContext('setPortraitMode(true);busy=true;paused=true;presentationDelayScale=1', context);
  const playing = vm.runInContext(
    "showPlayerSpeech({id:0,text:'这条发言不应在暂停期间开始。'})",
    context,
  );
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(spoken.length, 0);
  vm.runInContext('setPortraitMode(false)', context);
  await new Promise(setImmediate);
  assert.equal(spoken.length, 0);
  vm.runInContext('togglePause();presentationDelayScale=0', context);
  await playing;
  assert.equal(spoken.length, 1);
  vm.runInContext('setPortraitMode(true);presentationDelayScale=1', context);
  const cancelled = vm.runInContext("showPlayerSpeech({id:1,text:'旧局不能播放。'})", context);
  vm.runInContext('reset(12)', context);
  await cancelled;
  assert.equal(spoken.length, 1);
  assert.equal(vm.runInContext('speechBubble', context), null);
  assert.equal(vm.runInContext("$('portraitHeroArt').innerHTML", context), '');
  assert.equal(vm.runInContext("$('portraitFrame').dataset.size", context), '12');
  const waits = [];
  context.trackWait = async (ms) => {
    waits.push(ms);
    return true;
  };
  vm.runInContext('setPortraitMode(false);presentationWait=trackWait', context);
  await vm.runInContext("showPlayerSpeech({id:2,text:'圆桌直接开始声音。'})", context);
  assert.ok(!waits.includes(500));
  assert.equal(spoken.length, 2);
});

test('竖屏、全屏任意嵌套切换均恢复圆桌记录偏好', () => {
  for (const sequence of [
    [
      'setPortraitMode(true)',
      'setWatchMode(true)',
      'setPortraitMode(false)',
      'setWatchMode(false)',
    ],
    [
      'setWatchMode(true)',
      'setPortraitMode(true)',
      'setWatchMode(false)',
      'setPortraitMode(false)',
    ],
    [
      'setPortraitMode(true)',
      'setWatchMode(true)',
      'setWatchMode(false)',
      'setPortraitMode(false)',
    ],
  ]) {
    const { context } = setup(new Map(), false, true, false, true);
    vm.runInContext('spectatorPrefs.railOpen=true', context);
    sequence.forEach((code) => vm.runInContext(code, context));
    assert.equal(vm.runInContext('spectatorPrefs.railOpen', context), true, sequence.join(' → '));
  }
});

test('竖屏等待详情随视角即时清除秘密，恢复或退出竖屏关闭详情', () => {
  const { context } = setup(new Map(), false, true, false, true),
    read = (code) => vm.runInContext(code, context);
  read(
    "game.start();game.phase='night';activeSeat=2;spectatorPrefs.perspective='god';setPortraitMode(true);apiWaiting={id:2,message:'私有供应商错误',failures:3,startedAt:Date.now()-10000,nextAt:null};renderAction()",
  );
  assert.match(read("$('portraitAPIDialogText').textContent"), /私有供应商错误/);
  assert.match(read("$('portraitAPIStatus').textContent"), /等待手动重试/);
  read(
    "$('portraitAPIDialog').open=true;$('portraitAPIDialog').close=()=>{$('portraitAPIDialog').open=false};setPerspective('public')",
  );
  assert.equal(read("$('portraitAPIDialog').open"), true);
  assert.doesNotMatch(
    read(
      "$('portraitAPIDialogText').textContent+$('portraitAPIDialogTitle').textContent+$('portraitAPIStatus').textContent",
    ),
    /私有供应商错误|3号|3 号/,
  );
  assert.match(read("$('portraitAPIStatus').textContent"), /夜间行动/);
  read('apiWaiting=null;renderAction()');
  assert.equal(read("$('portraitAPIDialog').open"), false);
  assert.equal(read("$('portraitAPIDialogText').textContent"), '');
  read(
    "apiWaiting={id:2,failures:1,startedAt:Date.now(),nextAt:null};renderAction();$('portraitAPIDialog').open=true;setPortraitMode(false)",
  );
  assert.equal(read("$('portraitAPIDialog').open"), false);
  read("setPortraitMode(true);setWatchMode(true);handleAPIWaitCommand('edit-api')");
  assert.equal(read('view'), 'agents');
  assert.equal(read('portraitMode'), false);
  assert.equal(read('watchMode'), false);
});

test('达到发言 token 上限时拒绝不完整 JSON 且不自动重复请求', async () => {
  const { context, requests } = setup(new Map(), false);
  vm.runInContext(
    "profiles[0].endpoint='https://example.test/v1';profiles[0].model='test-model'",
    context,
  );
  context.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: 'length', message: { content: '{\"speech\":\"未完成' } }],
      }),
    };
  };
  await assert.rejects(
    vm.runInContext(
      "apiCall(profiles[0],[{role:'user',content:'test'}],{maxTokens:4000})",
      context,
    ),
    { code: 'AGENT_OUTPUT_TRUNCATED' },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].maxTokens, 4000);
});

test('xhigh 参数被拒绝后停留当前行动并等待手动处理', async () => {
  const { context } = setup();
  let requests = 0;
  context.fetch = async () => {
    requests++;
    return {
      ok: false,
      status: 422,
      json: async () => ({
        error: {
          code: 'REASONING_EFFORT_UNSUPPORTED',
          message: '当前模型不支持推理强度 xhigh，请修改配置。',
        },
      }),
    };
  };
  const read = (code) => vm.runInContext(code, context);
  const before = read('JSON.stringify(game)');
  const pending = read("decision(8,'vote')");
  await until(() => read('!!apiWaiting'));
  assert.equal(read('apiWaiting.nextAt'), null);
  assert.match(read('apiWaiting.message'), /xhigh/);
  assert.equal(read('JSON.stringify(game)'), before);
  read('busy=true;togglePause()');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests, 1);
  read('reset()');
  await pending;
  assert.equal(requests, 1);
  assert.equal(read('apiWaiting'), null);
});

test('停止等待取消当前请求并暂停，重试使用相同内容且只发一次', async (t) => {
  const { context } = setup();
  const calls = [],
    events = [];
  let waiting;
  t.after(() => vm.runInContext('reset()', context));
  context.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === '/api/agent-events') {
      events.push(body);
      return { ok: true };
    }
    calls.push(body);
    if (calls.length === 1)
      return new Promise((resolve, reject) => {
        waiting = options.signal;
        options.signal.addEventListener(
          'abort',
          () => reject(Object.assign(Error('cancel'), { name: 'AbortError' })),
          { once: true },
        );
      });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"target":1}' } }] }),
    };
  };
  const pending = vm.runInContext("decision(8,'vote')", context);
  await until(() => !!waiting);
  vm.runInContext("busy=true;handleAPIWaitCommand('stop-api')", context);
  await until(() => vm.runInContext('!!apiWaiting', context));
  assert.equal(waiting.aborted, true);
  assert.equal(vm.runInContext('paused', context), true);
  assert.equal(vm.runInContext('apiWaiting.code', context), 'AGENT_WAIT_CANCELLED');
  assert.match(
    vm.runInContext("$('actionPanel').innerHTML", context),
    /供应商仍可能完成处理或计费/,
  );
  vm.runInContext('togglePause()', context);
  assert.equal(calls.length, 1);
  assert.equal(events[0].requestId, calls[0].requestId);
  assert.equal(events[0].code, 'AGENT_WAIT_CANCELLED');
  vm.runInContext('retryAPI();retryAPI()', context);
  assert.equal((await pending).target, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].messages, calls[1].messages);
  assert.notEqual(calls[0].requestId, calls[1].requestId);
});

test('六与十二人手动暂停期间保留同一成功结果，继续后仅使用一次', async (t) => {
  for (const count of [6, 12]) {
    const { context } = setup();
    let release,
      n = 0,
      done = false;
    const read = (code) => vm.runInContext(code, context);
    t.after(() => read('reset()'));
    read(
      'reset(' +
        count +
        ');game.start();game.phase="voting";busy=true;turnDelay=0;profiles[0].control="api";profiles[0].endpoint="https://example.test";profiles[0].model="same"',
    );
    context.fetch = async () => {
      n++;
      return new Promise((resolve) => (release = resolve));
    };
    const pending = read("takeTurn(0,'vote','投票',epoch)").then((result) => {
      done = true;
      return result;
    });
    await until(() => !!release);
    read('togglePause()');
    release({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"target":2}' } }] }),
    });
    await until(() => read('agentPending===null'));
    assert.equal(done, false);
    assert.equal(n, 1);
    read('togglePause()');
    assert.equal((await pending).target, 1);
    assert.equal(n, 1);
  }
});

test('无效JSON、截断、空发言和非法技能结果关联请求日志并暂停', async (t) => {
  for (const item of [
    { task: 'speech', content: '{"speech":"incomplete', code: 'INVALID_AGENT_RESPONSE' },
    {
      task: 'speech',
      content: '{"speech":"valid"}',
      finish_reason: 'length',
      code: 'AGENT_OUTPUT_TRUNCATED',
    },
    {
      task: 'speech',
      content: '{"speech":"   "}',
      code: 'INVALID_AGENT_RESPONSE',
      rule: 'SPEECH_EMPTY',
    },
    {
      task: 'speech',
      content: 'null',
      code: 'INVALID_AGENT_RESPONSE',
      rule: 'ACTION_OBJECT_REQUIRED',
    },
    { task: 'vote', content: '{"target":9}', code: 'INVALID_ACTION', rule: 'TARGET_NOT_ALLOWED' },
    {
      task: 'hunter',
      content: '{"target":99}',
      code: 'INVALID_ACTION',
      rule: 'TARGET_OUT_OF_RANGE',
    },
  ]) {
    const { context } = setup();
    const calls = [],
      events = [];
    const read = (code) => vm.runInContext(code, context);
    t.after(() => read('reset()'));
    context.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (url === '/api/agent-events') {
        events.push(body);
        return { ok: true };
      }
      calls.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ finish_reason: item.finish_reason, message: { content: item.content } }],
        }),
      };
    };
    const pending = read('decision(8,"' + item.task + '")');
    await until(() => read('!!apiWaiting'));
    assert.equal(read('paused'), true);
    assert.equal(read('apiWaiting.code'), item.code);
    assert.equal(calls.length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].requestId, calls[0].requestId);
    assert.equal(events[0].code, item.code);
    if (item.rule) {
      assert.equal(events[0].validation.rule, item.rule);
      assert.equal(events[0].responseChars, Array.from(item.content).length);
    }
    assert.doesNotMatch(JSON.stringify(events), /secret-test-key|content|messages|speechHistory/);
    read('reset()');
    await pending;
  }
});

test('换房丢弃忽略取消信号的迟到响应，不推进下一局', async (t) => {
  const { context } = setup();
  let release,
    signal,
    n = 0;
  const read = (code) => vm.runInContext(code, context);
  t.after(() => read('reset()'));
  context.fetch = async (url, options) => {
    n++;
    signal = options.signal;
    return new Promise((resolve) => (release = resolve));
  };
  read('busy=true;turnDelay=0');
  const pending = read("takeTurn(8,'vote','投票',epoch)");
  await until(() => !!release);
  read('reset(6)');
  release({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"target":1}' } }] }),
  });
  assert.equal(await pending, null);
  assert.equal(signal.aborted, true);
  assert.equal(n, 1);
  assert.equal(read('size'), 6);
  assert.equal(read('game.phase'), 'lobby');
  assert.equal(read('apiWaiting'), null);
});

test('普通观战夜间隐藏持续等待的席位、请求编号和错误细节', async (t) => {
  const { context } = setup(new Map(), true, true, false, true);
  let release;
  const read = (code) => vm.runInContext(code, context);
  t.after(() => read('reset()'));
  context.fetch = async () => new Promise((resolve) => (release = resolve));
  read('game.phase="night";setPortraitMode(true);setPerspective("public")');
  const pending = read("decision(8,'night')");
  await until(() => !!release);
  const requestId = read('agentPending.requestId');
  let html = read(
    '$("actionPanel").innerHTML+$("portraitAPIDialogText").textContent+$("portraitAPIStatus").textContent',
  );
  assert.doesNotMatch(html, /9 号|9号/);
  assert.equal(html.includes(requestId), false);
  release({
    ok: false,
    status: 504,
    json: async () => ({ error: { code: 'UPSTREAM_TIMEOUT', message: '私有诊断详情' } }),
  });
  await until(() => read('!!apiWaiting'));
  html = read(
    '$("actionPanel").innerHTML+$("portraitAPIDialogText").textContent+$("portraitAPIStatus").textContent',
  );
  assert.doesNotMatch(html, /9 号|9号|私有诊断详情/);
  assert.equal(html.includes(requestId), false);
  read('reset()');
  await pending;
});

test('多份行动 JSON 只暂停一次，安全诊断关联原请求且不自动补发', async (t) => {
  const { context } = setup();
  const calls = [],
    events = [];
  const read = (code) => vm.runInContext(code, context);
  t.after(() => read('reset()'));
  const content = '{"speech":"private-draft"}\n{"speech":"private-final"}';
  context.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === '/api/agent-events') {
      events.push(body);
      return { ok: true };
    }
    calls.push(body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const pending = read('decision(8,"speech")');
  await until(() => read('!!apiWaiting'));
  assert.equal(read('paused'), true);
  assert.equal(calls.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].requestId, calls[0].requestId);
  assert.equal(events[0].jsonIssue, 'MULTIPLE_JSON_VALUES');
  assert.equal(events[0].responseChars, content.length);
  assert.doesNotMatch(JSON.stringify(events), /private-draft|private-final|secret-test-key/);
  assert.match(calls[0].messages[0].content, /合法的 JSON 对象/);
  read('reset()');
  await pending;
});

test('服务端兼容纯文字发言后，当前行动正常完成且仅请求一次', async (t) => {
  const { context } = setup();
  const calls = [],
    events = [],
    read = (code) => vm.runInContext(code, context);
  const speech = '我是1号岚，身份是平民。\n\n第一晚是平安夜，我先听大家发言。';
  t.after(() => read('reset()'));
  context.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === '/api/agent-events') {
      events.push(body);
      return { ok: true };
    }
    calls.push(body);
    const response = {
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: speech }],
        },
      ],
    };
    return {
      ok: true,
      status: 200,
      json: async () =>
        context.NightfallAgentRequest.gameResponse(response, { actionTask: body.action.task }),
    };
  };
  read('profiles[0]={...profiles[8]};game.phase="discussion"');
  const action = await read('decision(0,"speech")');
  assert.equal(action.speech, speech);
  assert.equal(read('apiWaiting'), null);
  assert.equal(read('paused'), false);
  assert.equal(read('profiles[0].connection'), 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action.task, 'speech');
  assert.equal(calls[0].action.seat, 1);
  assert.equal(events.length, 0);
});

test('已暂停的纯文字发言在服务端修复后可原地重试并恢复当前行动', async (t) => {
  const { context } = setup();
  const calls = [],
    events = [],
    read = (code) => vm.runInContext(code, context);
  const speech = '我是1号岚，身份是平民。第一晚是平安夜，先听大家发言。';
  let repaired = false;
  t.after(() => read('reset()'));
  context.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === '/api/agent-events') {
      events.push(body);
      return { ok: true };
    }
    calls.push(body);
    const response = {
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: speech }],
        },
      ],
    };
    const result = repaired
      ? context.NightfallAgentRequest.gameResponse(response, { actionTask: body.action.task })
      : { choices: [{ message: { content: speech } }] };
    return { ok: true, status: 200, json: async () => result };
  };
  read('profiles[0]={...profiles[8]};game.phase="discussion"');
  const before = read('JSON.stringify(game)');
  const pending = read('decision(0,"speech")');
  await until(() => read('!!apiWaiting'));
  assert.equal(read('apiWaiting.id'), 0);
  assert.equal(calls.length, 1);
  assert.equal(events[0].jsonIssue, 'MISSING_JSON');
  repaired = true;
  read('handleAPIWaitCommand("retry-api");handleAPIWaitCommand("retry-api")');
  const action = await pending;
  assert.equal(action.speech, speech);
  assert.equal(read('apiWaiting'), null);
  assert.equal(read('paused'), false);
  assert.equal(read('JSON.stringify(game)'), before);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].action, calls[1].action);
  assert.deepEqual(calls[0].messages, calls[1].messages);
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  assert.equal(events.length, 1);
});

test('完整纯文字发言缺少 JSON 时准确暂停且不播放或自动重发', async (t) => {
  const { context } = setup();
  const calls = [],
    events = [],
    read = (code) => vm.runInContext(code, context);
  t.after(() => read('reset()'));
  context.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === '/api/agent-events') {
      events.push(body);
      return { ok: true };
    }
    calls.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'private complete speech' } }] }),
    };
  };
  const pending = read('decision(8,"speech")');
  await until(() => read('!!apiWaiting'));
  assert.equal(read('paused'), true);
  assert.match(read('apiWaiting.message'), /已返回文字.*缺少有效的行动 JSON 对象/);
  assert.equal(read('transcript.length'), 0);
  assert.equal(read('narration'), null);
  assert.equal(calls.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].jsonIssue, 'MISSING_JSON');
  assert.doesNotMatch(JSON.stringify(events), /private complete speech|secret-test-key/);
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  read('reset()');
  await pending;
});

test('六与十二人普通及PK发言仅提前一位，完整采用前文后才请求且按序播放一次', async (t) => {
  for (const size of [6, 12])
    for (const pk of [false, true])
      await t.test(size + '人 ' + (pk ? 'PK' : '普通'), async (t) => {
        const h = speechPipeline(t, { size, pk, portrait: true }),
          { read, chat, playbacks } = h;
        const running = h.start();
        await until(() => chat.length === 1);
        const text = '😀'.repeat(1450),
          finalText = '😀'.repeat(1400);
        chat[0].speech(text);
        await until(() => chat.length === 2 && playbacks.length === 1);
        assert.equal(playbacks[0].text, finalText);
        assert.equal(read('activeSeat'), 0);
        assert.equal(read('portraitFocus()'), 0);
        assert.equal(read('transcript.length'), 1);
        const nextInput = JSON.parse(chat[1].body.messages.at(-1).content);
        assert.equal(nextInput.context.speeches.at(-1).text, finalText);
        assert.equal(nextInput.context.speeches.at(-1).seat, 1);
        assert.equal(nextInput.context.speeches.at(-1).pk, pk);
        assert.equal(
          nextInput.context.players.some((p) => 'role' in p),
          false,
        );
        assert.equal(chat[1].body.purpose, 'game-action');
        assert.equal(chat[1].body.maxTokens, 25000);
        assert.match(read("$('actionPanel').innerHTML"), /1 号.*正在.*发言/);
        assert.match(read("$('portraitAPIStatus').textContent"), /准备下一位/);
        chat[1].speech('第二位完整发言');
        await until(() => read('preparedSpeech.status') === 'ready');
        assert.equal(chat.length, 2);
        assert.equal(read('transcript.length'), 1);
        assert.equal(playbacks.length, 1);
        assert.match(read("$('portraitAPIStatus').textContent"), /下一位已就绪/);
        assert.doesNotMatch(read("$('actionPanel').innerHTML"), /data-command="stop-api"/);
        playbacks[0].finish();
        await until(() => chat.length === 3 && playbacks.length === 2);
        assert.deepEqual(
          playbacks.map((p) => p.id),
          [0, 1],
        );
        const thirdInput = JSON.parse(chat[2].body.messages.at(-1).content);
        assert.equal(thirdInput.context.speeches.at(-1).text, '第二位完整发言');
        assert.equal(thirdInput.context.speeches.length, 2);
        chat[2].speech('第三位结束发言');
        await until(() => read('preparedSpeech.status') === 'ready');
        playbacks[1].finish();
        await until(() => playbacks.length === 3);
        assert.equal(chat.length, 3);
        assert.equal(read('preparedSpeech'), null);
        playbacks[2].finish();
        await running;
        assert.deepEqual(
          playbacks.map((p) => p.id),
          [0, 1, 2],
        );
        assert.equal(read('game.speechHistory.length'), 3);
        assert.equal(read('transcript.length'), 3);
        assert.equal(read('agentPending'), null);
        assert.equal(read('activeSeat'), null);
      });
});

test('下一位慢响应接续同一请求和计时，当前发言结束后才切换人物', async (t) => {
  const h = speechPipeline(t, { actors: [0, 1] }),
    { read, chat, playbacks } = h;
  const running = h.start();
  await until(() => chat.length === 1);
  chat[0].speech('上一位');
  await until(() => chat.length === 2 && playbacks.length === 1);
  const requestId = read('agentPending.requestId'),
    startedAt = read('agentPending.startedAt');
  playbacks[0].finish();
  await until(() => read('activeSeat') === 1);
  assert.equal(chat.length, 2);
  assert.equal(playbacks.length, 1);
  assert.equal(read('agentPending.requestId'), requestId);
  assert.equal(read('agentPending.startedAt'), startedAt);
  assert.equal(read('agentPending.preparing'), false);
  chat[1].speech('等待完成后的发言');
  await until(() => playbacks.length === 2);
  playbacks[1].finish();
  await running;
  assert.equal(chat.length, 2);
});

test('提前请求错误延后至对应席位暂停，普通继续不重发，手动重试只新增一笔请求', async (t) => {
  for (const invalid of [false, true])
    await t.test(invalid ? '无效发言' : '接口错误', async (t) => {
      const h = speechPipeline(t, { actors: [0, 1] }),
        { read, chat, playbacks } = h;
      const running = h.start();
      await until(() => chat.length === 1);
      chat[0].speech('完整播放本句');
      await until(() => chat.length === 2 && playbacks.length === 1);
      if (invalid) chat[1].speech(' ');
      else chat[1].fail();
      await until(() => read('preparedSpeech.status') === 'failed');
      assert.equal(read('paused'), false);
      assert.equal(read('apiWaiting'), null);
      assert.equal(read('activeSeat'), 0);
      assert.equal(read('transcript.length'), 1);
      playbacks[0].finish();
      await until(() => read('!!apiWaiting'));
      assert.equal(read('apiWaiting.id'), 1);
      assert.equal(read('apiWaiting.requestId'), chat[1].body.requestId);
      assert.equal(read('paused'), true);
      assert.equal(playbacks.length, 1);
      read('togglePause()');
      await new Promise(setImmediate);
      assert.equal(chat.length, 2);
      read('retryAPI();retryAPI()');
      await until(() => chat.length === 3);
      assert.equal(
        JSON.parse(chat[2].body.messages.at(-1).content).context.speeches.at(-1).text,
        '完整播放本句',
      );
      assert.notEqual(chat[2].body.requestId, chat[1].body.requestId);
      chat[2].speech('手动重试成功');
      await until(() => playbacks.length === 2);
      playbacks[1].finish();
      await running;
      assert.equal(read('game.speechHistory.length'), 2);
      assert.equal(chat.length, 3);
    });
});

test('暂停期间提前返回结果保留一次，恢复前不提交或开始下一段', async (t) => {
  const h = speechPipeline(t, { actors: [0, 1] }),
    { read, chat, playbacks } = h;
  const running = h.start();
  await until(() => chat.length === 1);
  chat[0].speech('当前发言');
  await until(() => chat.length === 2 && playbacks.length === 1);
  read('togglePause()');
  chat[1].speech('已准备发言');
  await until(() => read('preparedSpeech.status') === 'ready');
  playbacks[0].finish();
  await new Promise(setImmediate);
  assert.equal(read('paused'), true);
  assert.equal(read('transcript.length'), 1);
  assert.equal(playbacks.length, 1);
  read('togglePause()');
  await until(() => playbacks.length === 2);
  assert.equal(chat.length, 2);
  playbacks[1].finish();
  await running;
  assert.equal(read('transcript.length'), 2);
});

test('停止提前等待仅取消目标请求，当前播放保留并在目标席位等待手动重试', async (t) => {
  const h = speechPipeline(t, { actors: [0, 1] }),
    { read, chat, playbacks, events } = h;
  const running = h.start();
  await until(() => chat.length === 1);
  chat[0].speech('本句继续播放');
  await until(() => chat.length === 2 && playbacks.length === 1);
  read('stopAgentWait()');
  await until(() => read('preparedSpeech.status') === 'failed');
  assert.equal(chat[1].signal.aborted, true);
  assert.equal(read('paused'), false);
  assert.equal(read('activeSeat'), 0);
  assert.equal(read('apiWaiting'), null);
  playbacks[0].finish();
  await until(() => read('!!apiWaiting'));
  assert.equal(read('apiWaiting.code'), 'AGENT_WAIT_CANCELLED');
  assert.equal(events[0].requestId, chat[1].body.requestId);
  read('retryAPI()');
  await until(() => chat.length === 3);
  chat[2].speech('确认后重试');
  await until(() => playbacks.length === 2);
  playbacks[1].finish();
  await running;
  assert.equal(chat.length, 3);
});

test('换房取消提前请求与计时器，忽略取消的迟到响应不污染新房间', async (t) => {
  const h = speechPipeline(t, { actors: [0, 1], ignoreAbort: true }),
    { read, chat, playbacks } = h;
  const running = h.start();
  await until(() => chat.length === 1);
  chat[0].speech('旧局发言');
  await until(() => chat.length === 2 && playbacks.length === 1);
  read('reset(12)');
  assert.equal(chat[1].signal.aborted, true);
  assert.equal(read('preparedSpeech'), null);
  assert.equal(read('agentPending'), null);
  assert.equal(read('activeRequest'), null);
  assert.equal(read('transcript.length'), 0);
  chat[1].speech('迟到的旧局结果');
  playbacks[0].finish();
  await running;
  assert.equal(read('game.phase'), 'lobby');
  assert.equal(read('size'), 12);
  assert.equal(read('transcript.length'), 0);
  assert.equal(chat.length, 2);
});

test('手动暂停期间收齐结果仍不公布，继续后只结算一次', async (t) => {
  const h = votingHarness(t),
    { read, groups } = h;
  const running = h.start();
  await until(() => groups.length === 1);
  read('togglePause()');
  h.replyAll();
  await until(() => read('voteBatchStatus().received') === 6);
  assert.equal(read('paused'), true);
  assert.equal(read('Object.keys(votePresentation.votes).length'), 0);
  assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'), 0);
  read('togglePause()');
  await running;
  assert.equal(groups.length, 1);
  assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'), 6);
});

test('行动诊断区分字段、座位和技能约束，六人与十二人都保留具体原因', () => {
  const { context } = setup(),
    read = (code) => vm.runInContext(code, context);
  const cases = [
    { task: 'speech', reply: [], rule: 'ACTION_OBJECT_REQUIRED', field: 'action', type: 'array' },
    { task: 'speech', reply: {}, rule: 'SPEECH_REQUIRED', field: 'speech', type: 'missing' },
    { task: 'speech', reply: { speech: 12 }, rule: 'SPEECH_TYPE', field: 'speech', type: 'number' },
    { task: 'vote', reply: {}, rule: 'TARGET_REQUIRED', field: 'target', type: 'missing' },
    {
      task: 'vote',
      reply: { target: 'private-reply' },
      rule: 'TARGET_TYPE',
      field: 'target',
      type: 'string',
    },
    {
      task: 'hunter',
      reply: { target: 1.5 },
      rule: 'TARGET_TYPE',
      field: 'target',
      type: 'number',
    },
    {
      task: 'night',
      reply: { target: 0 },
      rule: 'TARGET_OUT_OF_RANGE',
      field: 'target',
      type: 'number',
    },
    {
      task: 'night',
      reply: { target: 99 },
      rule: 'TARGET_OUT_OF_RANGE',
      field: 'target',
      type: 'number',
    },
    {
      task: 'night',
      reply: { target: 1 },
      rule: 'TARGET_NOT_ALLOWED',
      field: 'target',
      type: 'number',
    },
    {
      task: 'night',
      reply: { poison: null },
      skill: true,
      rule: 'SAVE_REQUIRED',
      field: 'save',
      type: 'missing',
    },
    {
      task: 'night',
      reply: { save: 'private-reply', poison: null },
      skill: true,
      rule: 'SAVE_TYPE',
      field: 'save',
      type: 'string',
    },
    {
      task: 'night',
      reply: { save: false },
      skill: true,
      rule: 'POISON_REQUIRED',
      field: 'poison',
      type: 'missing',
    },
    {
      task: 'night',
      reply: { save: false, poison: 'private-reply' },
      skill: true,
      rule: 'POISON_TYPE',
      field: 'poison',
      type: 'string',
    },
    {
      task: 'night',
      reply: { save: false, poison: 99 },
      skill: true,
      rule: 'POISON_OUT_OF_RANGE',
      field: 'poison',
      type: 'number',
    },
    {
      task: 'night',
      reply: { save: true, poison: null },
      skill: true,
      saveAvailable: false,
      rule: 'SAVE_UNAVAILABLE',
      field: 'save',
      type: 'boolean',
    },
    {
      task: 'night',
      reply: { save: true, poison: 2 },
      skill: true,
      rule: 'POTION_CONFLICT',
      field: 'poison',
      type: 'number',
    },
    {
      task: 'night',
      reply: { save: false, poison: 2 },
      skill: true,
      poisonAvailable: false,
      rule: 'POISON_UNAVAILABLE',
      field: 'poison',
      type: 'number',
    },
    {
      task: 'night',
      reply: { save: false, poison: 1 },
      skill: true,
      rule: 'POISON_NOT_ALLOWED',
      field: 'poison',
      type: 'number',
    },
  ];
  const { safeEntry } = require('./agent-log.cjs');
  for (const roomSize of [6, 12])
    for (const item of cases) {
      context.validationCase = { ...item, roomSize, text: JSON.stringify(item.reply) };
      read(
        'size=validationCase.roomSize;game=new Nightfall.Game(size).start();game.players[0].role=validationCase.skill?"女巫":"预言家";game.potions={save:validationCase.saveAvailable!==false,poison:validationCase.poisonAvailable!==false}',
      );
      let failure;
      assert.throws(
        () =>
          read(
            'validateAgentDecision(0,validationCase.task,validationCase.text,buildAgentContext(0,validationCase.task,{victim:1}),{victim:1})',
          ),
        (error) => {
          failure = error;
          return true;
        },
      );
      const entry = safeEntry({
        event: 'validation_failed',
        code: failure.code,
        validation: failure.validation,
        responseChars: failure.responseChars,
      });
      assert.equal(entry.validation.rule, item.rule);
      assert.equal(entry.validation.field, item.field);
      assert.equal(entry.validation.actualType, item.type);
      assert.equal(entry.validation.roomSize, roomSize);
      assert.equal(entry.responseChars, Array.from(context.validationCase.text).length);
      if (item.field === 'target' || item.field === 'poison') {
        assert.equal(entry.validation.allowedTargetCount, roomSize - 1);
        assert.equal(
          entry.validation.targetAllowed,
          ['POTION_CONFLICT', 'POISON_UNAVAILABLE'].includes(item.rule),
        );
      }
      assert.doesNotMatch(
        JSON.stringify(entry),
        /private-reply|狼人|女巫|apiKey|allowedTargets|wolfTeammates|potions|reply/,
      );
    }
  for (const roomSize of [6, 12]) {
    context.validationRoomSize = roomSize;
    read(
      'size=validationRoomSize;game=new Nightfall.Game(size).start();game.players[0].role="预言家"',
    );
    assert.equal(
      read(
        'validateAgentDecision(0,"night",JSON.stringify({target:2}),buildAgentContext(0,"night")).target',
      ),
      1,
    );
    assert.equal(
      read(
        'validateAgentDecision(0,"vote",JSON.stringify({target:null}),buildAgentContext(0,"vote")).target',
      ),
      null,
    );
    read('game.players[0].role="女巫"');
    assert.equal(
      read(
        'validateAgentDecision(0,"night",JSON.stringify({save:false,poison:null}),buildAgentContext(0,"night"),{victim:null}).poison',
      ),
      null,
    );
  }
});

test('狼人选刀部分失败后只重试失败席位并保留已成功选择', async (t) => {
  const h = wolfHarness(t, { size: 12 }),
    running = h.start();
  await until(() => h.groups.length === 1);
  const initial = h.groups[0],
    failedSeat = h.wolves[1] + 1;
  for (const id of [h.wolves[0], h.wolves[2], h.wolves[3]]) initial.result(id + 1, id + 1);
  initial.error(failedSeat);
  await until(() => h.read('voteBatchStatus().failed.length') === 1);
  assert.equal(h.read('paused'), true);
  for (const id of [h.wolves[0], h.wolves[2], h.wolves[3]])
    assert.equal(h.read('voteBatch.items[' + id + '].result.target'), id);
  const frozen = JSON.parse(
    initial.requests.find((request) => request.action.seat === failedSeat).messages[1].content,
  );
  h.read('game.logs.push({text:"重试前新增事件",phase:"night",round:4});retryAPI()');
  await until(() => h.groups.length === 2);
  const retry = h.groups[1];
  assert.deepEqual(
    retry.requests.map((request) => request.action.seat),
    [failedSeat],
  );
  assert.deepEqual(JSON.parse(retry.requests[0].messages[1].content), frozen);
  initial.result(failedSeat, 1);
  await new Promise(setImmediate);
  assert.equal(h.read('voteBatch.items[' + h.wolves[1] + '].status'), 'pending');
  retry.result(failedSeat, h.wolves[0] + 1);
  const choices = await running;
  assert.equal(choices[h.wolves[1]].target, h.wolves[0]);
  assert.equal(h.groups.length, 2);
});

test('六与十二人夜间角色音效仅在上帝视角播放', async () => {
  for (const count of [6, 12])
    for (const perspective of ['god', 'public']) {
      const { context } = setup(new Map(), false),
        sounds = [];
      context.recordEffect = (name) => sounds.push(name);
      vm.runInContext(
        `reset(${count});game.start();setPerspective('${perspective}');effects.play=recordEffect;presentationWait=async()=>true`,
        context,
      );
      for (const kind of ['wolf', 'guard', 'seer', 'save', 'poison']) {
        context.currentCue = kind;
        await vm.runInContext(
          "animateEvent({kind:currentCue,private:true,round:1,actors:[],publicText:'',godText:''},epoch)",
          context,
        );
      }
      assert.deepEqual(
        sounds,
        perspective === 'god' ? ['wolf', 'guard', 'seer', 'save', 'poison'] : [],
      );
    }
});

test('等待面板显示当前请求的预计输入 token 数', () => {
  const { context } = setup();
  vm.runInContext(
    "apiWaiting={id:8,requestId:'estimate-test',startedAt:Date.now(),inputTokens:123};renderAction()",
    context,
  );
  assert.match(vm.runInContext("$('actionPanel').innerHTML", context), /预计输入约 123 tokens/);
});

test('狼人仅首轮分歧时再投，首轮记录只给第二轮狼人，女巫收到最终目标', async () => {
  for (const split of [false, true]) {
    const { context } = setup();
    prepareAuto(context, 6);
    context.splitVotes = split;
    const read = (code) => vm.runInContext(code, context);
    read(`game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);
      let turns=[]; flushCommentary=async()=>true;
      localStoryDecision=(id,task,extra)=>{
        const view=buildAgentContext(id,task,extra); turns.push(view);
        if(id<2) return {target:view.firstRoundChoices?5:splitVotes&&id===1?3:4};
        return id===3?{save:false,poison:null}:{target:null};
      };`);
    await read('runNight(epoch)');
    const turns = JSON.parse(read('JSON.stringify(turns)'));
    const second = turns.filter((t) => t.firstRoundChoices);
    assert.equal(second.length, split ? 2 : 0);
    for (const view of second) {
      assert.equal(view.role, '狼人');
      assert.deepEqual(view.firstRoundChoices, [
        { seat: 1, target: 5 },
        { seat: 2, target: 4 },
      ]);
    }
    assert.equal(turns.find((t) => t.role === '女巫').tonightVictim, split ? 6 : 5);
    assert.equal(read('game.alive().length'), 5);
  }
});
