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

test('六位庄园人物默认男女音色与形象对应，自定义与12人原音色保持独立', () => {
  const { context, saved } = setup(new Map(), false, false);
  const expected = [
    'zh-CN-XiaoxiaoNeural',
    'zh-CN-YunyangNeural',
    'zh-CN-YunxiNeural',
    'zh-CN-XiaoyiNeural',
    'zh-CN-YunjianNeural',
    'zh-TW-HsiaoChenNeural',
  ];
  assert.deepEqual(
    Array.from(vm.runInContext('profiles.slice(0,6).map(seatVoice)', context), (p) => p.voice),
    expected,
  );
  const original = vm.runInContext('profiles[0].voice', context);
  vm.runInContext(
    "openAgent(0);$('manorPortraitInput').value='portrait-05';$('manorPortraitInput').listeners.change();saveAgent()",
    context,
  );
  const restored = setup(saved, false, false).context;
  assert.equal(vm.runInContext('seatVoice(profiles[0],0).voice', restored), 'zh-CN-YunjianNeural');
  assert.equal(vm.runInContext('profiles[0].voice', restored), original);
  vm.runInContext(
    "openAgent(0);$('manorPortraitInput').value='avatar';$('manorPortraitInput').listeners.change()",
    restored,
  );
  assert.equal(vm.runInContext("$('playerVoiceInput').value", restored), original);
  assert.equal(vm.runInContext('modalProfile().voice', restored), original);
  vm.runInContext('reset(12)', restored);
  assert.equal(vm.runInContext('seatVoice(profiles[0],0).voice', restored), 'zh-CN-YunjianNeural');
  vm.runInContext(
    "reset(6);profiles[0].voiceMatch='custom';profiles[0].voice='zh-CN-XiaoyiNeural';profiles[0].manorPortrait='portrait-05'",
    restored,
  );
  assert.equal(vm.runInContext('seatVoice(profiles[0],0).voice', restored), 'zh-CN-XiaoyiNeural');
});

test('发牌先播放匿名卡背，完成后才开局；暂停与重置不会遗留旧动画或行动', async () => {
  const { context } = setup(new Map(), false);
  let release;
  context.gate = () => new Promise((r) => (release = r));
  vm.runInContext('presentationWait=gate;turnDelay=0;voiceEnabled=false', context);
  const running = vm.runInContext('start()', context);
  assert.equal(vm.runInContext('game.phase', context), 'lobby');
  assert.equal(vm.runInContext('busy', context), true);
  const html = vm.runInContext("$('sceneEffect').innerHTML", context);
  assert.equal((html.match(/class="deal-card"/g) || []).length, 6);
  assert.doesNotMatch(html, /狼人|预言家|女巫/);
  vm.runInContext('togglePause()', context);
  assert.equal(
    vm.runInContext("document.body.classList.contains('presentation-paused')", context),
    true,
  );
  vm.runInContext('reset(12)', context);
  release(true);
  await running;
  assert.equal(vm.runInContext('game.phase', context), 'lobby');
  assert.equal(vm.runInContext('sceneMotion', context), null);
  assert.equal(vm.runInContext('dealState', context), null);
  assert.equal(vm.runInContext("$('sceneEffect').classList.contains('hidden')", context), true);
});

test('立绘加载失败立即使用原头像，记录缩略图跟随席位，失效 ID 不发起外部请求', () => {
  const { context, events } = setup(new Map(), false);
  vm.runInContext(
    "addSpeech(0,'公开发言');profiles[0].manorPortrait='portrait-04';renderAll()",
    context,
  );
  assert.match(vm.runInContext("$('transcript').innerHTML", context), /portrait-04-thumb.webp/);
  events.error[0]({ target: { dataset: { portrait: 'portrait-04' } } });
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /manor-avatar-fallback/);
  assert.doesNotMatch(
    vm.runInContext("$('transcript').innerHTML", context),
    /portrait-04-thumb.webp/,
  );
  vm.runInContext(
    "profiles[0].manorPortrait='https://foreign.test/asset';renderPlayers()",
    context,
  );
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML", context), /foreign.test/);
});

test('只随机一次，翻牌按席位揭晓且翻牌期间没有任何 Agent 行动', async () => {
  const { context } = setup(new Map(), false);
  let starts = 0,
    actions = 0;
  const frames = [];
  context.onStart = () => starts++;
  context.onAction = () => actions++;
  context.frame = () => {
    frames.push(
      vm.runInContext(
        "({stage:dealState?.stage,revealed:dealState?.revealed,phase:game.phase,html:$('playersGrid').innerHTML})",
        context,
      ),
    );
    return Promise.resolve(true);
  };
  vm.runInContext(
    'const realStart=game.start.bind(game);game.start=()=>{onStart();return realStart()};presentationWait=frame;runGame=async()=>{onAction()}',
    context,
  );
  await vm.runInContext('start()', context);
  assert.equal(starts, 1);
  assert.equal(actions, 1);
  const reveal = frames.filter((f) => f.stage === 'reveal');
  assert.equal(reveal.length, 7);
  assert.equal(reveal[0].revealed, 0);
  assert.doesNotMatch(reveal[0].html, /role-wolf|role-seer|role-witch/);
  assert.equal(reveal.at(-1).revealed, 6);
  assert.equal(vm.runInContext('sceneMotion', context), null);
});

test('普通翻牌不包含真实身份，切换视角不会中断发牌或触发行动', async () => {
  const { context } = setup(new Map(), false);
  let release;
  context.flipWait = () => new Promise((r) => (release = r));
  vm.runInContext("game.start();presentationWait=flipWait;setPerspective('public')", context);
  const playing = vm.runInContext('revealDeal(epoch)', context);
  assert.doesNotMatch(
    vm.runInContext("$('sceneEffect').innerHTML+$('playersGrid').innerHTML", context),
    /狼人|女巫|预言家/,
  );
  vm.runInContext("setPerspective('god')", context);
  assert.equal(vm.runInContext('sceneMotion.kind', context), 'reveal');
  vm.runInContext('reset()', context);
  release(false);
  await playing;
  assert.equal(vm.runInContext('sceneMotion', context), null);
});

test('眨眼时间跨重绘保持连续，暂停冻结，普通视角立即遮蔽，闭眼图失败保留人物', () => {
  const { context } = setup();
  vm.runInContext(
    'let eyeTestNow=1000;performance={now:()=>eyeTestNow};resetEyes();eyeVisual(game.players[0]);eyeTestNow+=100;eyeClock();paused=true;eyeClock();eyeTestNow+=900;',
    context,
  );
  assert.equal(vm.runInContext('eyeClock()', context), 100);
  vm.runInContext('paused=false;eyeClock();eyeTestNow+=50', context);
  assert.equal(vm.runInContext('eyeClock()', context), 150);
  vm.runInContext(
    "beginEyeEvent({kind:'night-cue',actors:[0]});eyeVisual(game.players[0]);spectatorPrefs.perspective='public'",
    context,
  );
  assert.equal(vm.runInContext('eyeVisual(game.players[0]).classes', context), 'eyes-closed');
  vm.runInContext("failedEyePortraits.add('portrait-01')", context);
  assert.equal(vm.runInContext("eyeMarkup(game.players[0],{id:'portrait-01'})", context), '');
});

test('竖屏6和12席共享视角隐私，私有夜间提示与旁白不泄漏，头像故障可回退', () => {
  const { context } = setup(new Map(), false, true, false, true);
  for (const count of [6, 12]) {
    vm.runInContext(
      `reset(${count});game.start();game.phase='night';setPortraitMode(true);setPerspective('god');wolfPresentation={round:game.round,states:{0:{status:'selected',target:2}}};currentCommentary={private:true,godText:'秘密狼刀 3 号',publicText:''};renderAll()`,
      context,
    );
    const html = () =>
      vm.runInContext(
        "$('portraitSeatsLeft').innerHTML+$('portraitSeatsRight').innerHTML",
        context,
      );
    assert.equal((html().match(/data-portrait-seat=/g) || []).length, count);
    assert.match(html(), /提议 3 号/);
    assert.equal(vm.runInContext("$('portraitCaption').textContent", context), '秘密狼刀 3 号');
    vm.runInContext(
      "setPerspective('public');currentCommentary={private:true,godText:'不得显示的秘密',publicText:''};apiWaiting={id:0};activeSeat=0;renderAll()",
      context,
    );
    assert.doesNotMatch(html(), /提议|狼人|女巫|预言家|正在选刀/);
    assert.doesNotMatch(
      vm.runInContext("$('portraitCaption').textContent", context),
      /秘密狼刀|不得显示|1 号/,
    );
    vm.runInContext(
      "apiWaiting=null;game.phase='discussion';speechBubble={id:0,kind:'dialogue',stage:'reading',caption:'公开发言'};renderAll()",
      context,
    );
    assert.doesNotMatch(
      vm.runInContext("$('portraitHeroRole').innerHTML", context),
      /狼人|女巫|预言家/,
    );
    vm.runInContext('failedPortraits.add(profiles[0].manorPortrait);renderPlayers()', context);
    assert.match(
      vm.runInContext("$('portraitHeroArt').innerHTML", context),
      /portrait-avatar-fallback/,
    );
    vm.runInContext("game.phase='ended';game.winner='好人';renderAll()", context);
    assert.doesNotMatch(vm.runInContext("$('portraitHeroRole').innerHTML", context), /身份隐藏/);
  }
});

test('翻牌使用独立横排角色名称，公开翻牌及未知身份不带真实角色标记', () => {
  for (const count of [6, 12]) {
    const { context } = setup(new Map(), false, true, false, true),
      read = (code) => vm.runInContext(code, context);
    read('reset(' + count + ');game.start();setPortraitMode(true)');
    for (const [role, style] of Object.entries({
      狼人: 'wolf',
      预言家: 'seer',
      女巫: 'witch',
      猎人: 'hunter',
      守卫: 'guard',
      平民: 'villager',
    })) {
      read('game.players[0].role=' + JSON.stringify(role));
      const card = read('visibleRoleBadge(game.players[0],true,true)');
      assert.match(card, new RegExp('reveal-identity role-' + style));
      assert.match(card, new RegExp('<strong class="reveal-role-name">' + role + '</strong>'));
      assert.doesNotMatch(card, /class="player-role/);
      const hidden = read('visibleRoleBadge(game.players[0],false,true)');
      assert.match(hidden, /reveal-identity role-unknown/);
      assert.match(hidden, />已分配</);
      assert.doesNotMatch(hidden, /role-(wolf|seer|witch|hunter|guard|villager)/);
      assert.doesNotMatch(
        read('visibleRoleBadge(game.players[0],false)'),
        /role-(wolf|seer|witch|hunter|guard|villager)/,
      );
    }
    read(
      "spectatorPrefs.perspective='public';dealState={stage:'reveal',revealed:size};sceneMotion={kind:'reveal'};renderSceneMotion();renderPortrait()",
    );
    const publicHTML = read(
      "$('sceneEffect').innerHTML+$('portraitSeatsLeft').innerHTML+$('portraitSeatsRight').innerHTML",
    );
    assert.doesNotMatch(publicHTML, /role-(wolf|seer|witch|hunter|guard|villager)/);
    read('reset()');
  }
});

test('非法头像回退为默认头像，图片地址插入页面前转义', () => {
  const { context } = setup();
  const AVATARS = require('./avatar.js').AVATARS;
  for (const avatar of [
    'x" onerror="alert(1)',
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,AA"><script>',
  ])
    assert.equal(
      vm.runInContext(`buildProfiles([${JSON.stringify({ avatar })}])[0].avatar`, context),
      AVATARS[0],
    );
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(
    vm.runInContext(`buildProfiles([${JSON.stringify({ avatar: png })}])[0].avatar`, context),
    png,
  );
  assert.match(
    vm.runInContext(`avatarHTML({name:'<b>',avatar:${JSON.stringify(png)}})`, context),
    /^<img src="data:image\/png;base64,iVBORw0KGgo=" alt="&lt;b&gt;/,
  );
  assert.equal(
    vm
      .runInContext(`avatarHTML({name:'n',avatar:'x" onerror="alert(1)'})`, context)
      .includes('<img'),
    false,
  );
});
