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

test('短字幕保留全文、逐字揭示并分句切换，边界字符不抢先跳句', () => {
  const { speechSegments, captionFrame } = require('./observer.js'),
    text = '先别急着投票，我们把线索对一对。下一位请说。',
    parts = speechSegments(text);
  assert.equal(parts.map((p) => p.text).join(''), text);
  assert.ok(parts.every((p) => Array.from(p.text).length <= 20));
  assert.equal(captionFrame(parts, 0).text, '先');
  assert.equal(captionFrame(parts, 1).text, '下一位请说。');
  assert.equal(captionFrame(parts, 0, parts[0].end).index, 0);
  assert.equal(captionFrame(parts, 0, parts[0].end + 1).index, 1);
  assert.ok(captionFrame(parts, 0.15).text.length < text.length);
});

test('字幕按音频进度更新，暂停冻结，重置隔离旧的播放回调', async () => {
  const { context } = setup(new Map(), false, false),
    { audios } = installNatural(context);
  vm.runInContext('voiceEnabled=true', context);
  const playing = vm.runInContext(
    "showPlayerSpeech({id:0,text:'我们先核对线索，再决定投给谁。'})",
    context,
  );
  await until(() => audios.length === 1);
  audios[0].duration = 8;
  audios[0].currentTime = 3;
  audios[0].ontimeupdate();
  const caption = vm.runInContext('speechBubble.caption', context);
  assert.ok(caption.length > 1);
  assert.ok(caption.length < 18);
  vm.runInContext('busy=true;togglePause()', context);
  audios[0].currentTime = 7;
  audios[0].ontimeupdate();
  assert.equal(vm.runInContext('speechBubble.caption', context), caption);
  vm.runInContext('togglePause()', context);
  audios[0].ontimeupdate();
  assert.notEqual(vm.runInContext('speechBubble.caption', context), caption);
  const old = audios[0].ontimeupdate;
  vm.runInContext('reset()', context);
  old();
  await playing;
  assert.equal(vm.runInContext('speechBubble', context), null);
  assert.equal(audios[0].ontimeupdate, null);
});

test('庄园发言沿用声音生命周期，出局名牌保持明确且暂停不脉动', () => {
  const { context } = setup(new Map(), false);
  vm.runInContext(
    "game.start();game.phase='discussion';game.players[0].alive=false;speechBubble={id:0,text:'我的公开记录',kind:'dialogue',stage:'speaking'};renderPlayers()",
    context,
  );
  let html = vm.runInContext("$('playersGrid').innerHTML", context);
  assert.match(html, /dead speaking pulsing/);
  assert.match(html, /life-mark">已出局/);
  vm.runInContext('paused=true;renderPlayers()', context);
  html = vm.runInContext("$('playersGrid').innerHTML", context);
  assert.doesNotMatch(html, /pulsing/);
  assert.match(html, /已暂停/);
  vm.runInContext('reset()', context);
  assert.equal(vm.runInContext('speechBubble', context), null);
  assert.doesNotMatch(
    vm.runInContext("$('playersGrid').innerHTML", context),
    /speaking|pulsing|dead /,
  );
});

test('支持音频但不支持系统朗读时提示更换声音，不中断对局', async () => {
  const { context } = setup();
  context.Audio = function () {};
  assert.equal(
    await vm.runInContext("speakText('请听我分析',{kind:'preview',seat:0})", context),
    false,
  );
  assert.equal(vm.runInContext('narration', context), null);
  assert.match(vm.runInContext("$('voicePreviewStatus').textContent", context), /选择自然中文音色/);
});

test('简洁席位不嵌入对白，悬浮对白安全转义，普通观战隐藏身份', () => {
  const { context } = setup();
  vm.runInContext(
    "addSpeech(0,'第一条公开发言');addSpeech(0,'<script>新发言</script>');speechBubble={...transcript.at(-1),caption:transcript.at(-1).text,kind:'dialogue'};renderPlayers()",
    context,
  );
  const html = vm.runInContext("$('playersGrid').innerHTML", context);
  assert.doesNotMatch(html, /seat-dialogue|新发言|第一条公开发言/);
  assert.match(
    vm.runInContext("$('speechBubble').innerHTML", context),
    /&lt;script&gt;新发言&lt;\/script&gt;/,
  );
  vm.runInContext(
    "reset();game.start();game.knowledge[2]={0:'狼人'};setPerspective('public')",
    context,
  );
  assert.doesNotMatch(
    vm.runInContext("$('playersGrid').innerHTML", context),
    /查验|狼刀|毒杀|预言家|女巫/,
  );
});

test('对白必须读完才进入下一位，重置释放等待且旧回调不污染新局', async () => {
  const { context } = setup(),
    { spoken } = installSpeech(context);
  vm.runInContext('voiceEnabled=true', context);
  prepareAuto(context, 6);
  vm.runInContext(
    "game.start();game.phase='discussion';busy=true;decision=async(id)=>({speech:'这是 '+(id+1)+' 号的公开发言'})",
    context,
  );
  const playing = vm.runInContext('aiSpeeches(false,epoch)', context);
  await until(() => spoken.length === 1);
  assert.equal(vm.runInContext('game.speeches.length', context), 1);
  assert.equal(vm.runInContext('activeSeat', context), 0);
  await new Promise(setImmediate);
  assert.equal(spoken.length, 1);
  assert.match(spoken[0].text, /这是 1 号的公开发言/);
  spoken[0].onend();
  await until(() => spoken.length === 2);
  assert.equal(vm.runInContext('game.speeches.length', context), 2);
  const oldEnd = spoken[1].onend;
  vm.runInContext('reset(12)', context);
  oldEnd();
  await playing;
  assert.equal(vm.runInContext('narration', context), null);
  assert.equal(vm.runInContext('transcript.length', context), 0);
  assert.equal(vm.runInContext('game.phase', context), 'lobby');
  assert.equal(spoken.length, 2);
});

test('开局自动朗读全部公开发言，6/12 人整局及音色分配不依赖隐藏角色', async (t) => {
  for (const size of [6, 12])
    await t.test(String(size), async () => {
      const { context } = setup(),
        { spoken } = installSpeech(context, { autoEnd: true });
      prepareAuto(context, size);
      vm.runInContext('voiceEnabled=true', context);
      vm.runInContext('game.random=()=>.9999', context);
      await vm.runInContext('start()', context);
      const history = vm.runInContext('game.speechHistory', context);
      assert.equal(vm.runInContext('game.phase', context), 'ended');
      assert.equal(spoken.length, history.length);
      assert.deepEqual(
        spoken.map((u) => u.text),
        Array.from(history, (l) => l.text),
      );
      assert.ok(spoken.every((u) => u.lang === 'zh-CN' && u.voice.lang.startsWith('zh')));
    });
});

test('暂停和继续同步控制对白，关闭语音会立即释放播放等待', async () => {
  const { context } = setup(),
    { spoken, synth } = installSpeech(context);
  vm.runInContext('voiceEnabled=true', context);
  vm.runInContext('busy=true', context);
  const playing = vm.runInContext("speakText('一段公开对白',{seat:0})", context);
  vm.runInContext('togglePause()', context);
  assert.equal(synth.paused, true);
  assert.equal(vm.runInContext('narration.paused', context), true);
  vm.runInContext('togglePause()', context);
  assert.equal(synth.paused, false);
  assert.equal(vm.runInContext('narration.paused', context), false);
  vm.runInContext('toggleDialogueVoice()', context);
  assert.equal(await playing, false);
  assert.equal(vm.runInContext('voiceEnabled', context), false);
  assert.equal(synth.cancels, 1);
  assert.equal(spoken[0].onend, null);
});

test('规则介绍只朗读所选房间，切换人数不会修改实际房间', async () => {
  const { context } = setup(),
    { spoken } = installSpeech(context);
  const audios = installRuleAudio(context);
  vm.runInContext('readRules(6)', context);
  assert.equal(audios[0].src, '/assets/rules-6.mp3?v=2');
  audios[0].onended();
  vm.runInContext('readRules(12)', context);
  assert.equal(audios[1].src, '/assets/rules-12.mp3?v=2');
  assert.equal(spoken.length, 0, '规则不再回退到机械的浏览器朗读');
  assert.equal(vm.runInContext('size', context), 12);
  audios[1].onended();
});

test('规则和重播暂停对局，取消暂停中的对白后规则仍能播放，讲解后不擅自继续', async () => {
  const { context } = setup(),
    { spoken, synth } = installSpeech(context);
  vm.runInContext('voiceEnabled=true', context);
  const audios = installRuleAudio(context);
  vm.runInContext("busy=true;addSpeech(2,'可以重播的公开发言')", context);
  const dialogue = vm.runInContext("speakText('先前对白',{seat:0})", context);
  vm.runInContext('openRulesIntro()', context);
  assert.equal(await dialogue, false);
  assert.equal(vm.runInContext('paused', context), true);
  assert.equal(audios[0].plays, 1);
  assert.equal(vm.runInContext("$('rulesBackdrop').classList.contains('hidden')", context), false);
  audios[0].onended();
  vm.runInContext('closeRulesIntro()', context);
  assert.equal(vm.runInContext('paused', context), true);
  const replay = vm.runInContext('replaySpeech(2)', context);
  assert.match(spoken.at(-1).text, /可以重播的公开发言/);
  assert.equal(synth.paused, false, '重播时对局已暂停，但语音必须继续播放');
  assert.equal(vm.runInContext('narration.paused', context), false);
  spoken.at(-1).onend();
  await replay;
  assert.equal(vm.runInContext('paused', context), true);
});

test('自然规则音频不依赖系统朗读或模型接口，关闭与重置释放音频', async () => {
  const { context, calls } = setup(),
    audios = installRuleAudio(context);
  const playing = vm.runInContext('playRuleAudio(6)', context);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent", context), /自然女声/);
  assert.match(vm.runInContext("$('voiceStatus').textContent", context), /自然女声/);
  assert.equal(audios[0].playbackRate, 1);
  const lateEnd = audios[0].onended,
    lateError = audios[0].onerror;
  vm.runInContext('closeRulesIntro()', context);
  assert.equal(await playing, false);
  assert.equal(audios[0].pauses, 1);
  assert.equal(audios[0].src, '');
  assert.equal(audios[0].loads, 1);
  const next = vm.runInContext('playRuleAudio(12)', context);
  lateEnd();
  lateError();
  assert.equal(vm.runInContext('narration.audio', context), audios[1]);
  vm.runInContext('reset(6)', context);
  assert.equal(await next, false);
  assert.equal(audios[1].src, '');
  assert.equal(vm.runInContext('narration', context), null);
  assert.equal(calls.length, 0);
});

test('规则音频重复点击停止，继续对局停止讲解，关闭对白不关闭规则音频', () => {
  const { context } = setup(),
    audios = installRuleAudio(context);
  vm.runInContext('busy=true;readRules(6);toggleDialogueVoice()', context);
  assert.equal(vm.runInContext('paused', context), true);
  assert.equal(audios[0].pauses, 0);
  vm.runInContext('readRules(6)', context);
  assert.equal(audios[0].pauses, 1);
  vm.runInContext('readRules(12);togglePause()', context);
  assert.equal(vm.runInContext('paused', context), false);
  assert.equal(audios[1].pauses, 1);
  assert.equal(vm.runInContext('narration', context), null);
});

test('规则音频自动播放受限或文件缺失时显示原因，不偷换机械语音', async () => {
  const { context } = setup(),
    { spoken } = installSpeech(context);
  const blocked = Error('blocked');
  blocked.name = 'NotAllowedError';
  installRuleAudio(context, { reject: blocked });
  assert.equal(await vm.runInContext('playRuleAudio(6)', context), false);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent", context), /重新播放/);
  const audios = installRuleAudio(context),
    missing = vm.runInContext('playRuleAudio(12)', context);
  audios[0].onerror();
  assert.equal(await missing, false);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent", context), /重启游戏服务/);
  assert.equal(spoken.length, 0);
});

test('规则音频加载超时与播放中断可释放状态并重试', async () => {
  const { context } = setup(),
    audios = installRuleAudio(context),
    timers = [];
  context.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return null;
  };
  context.Audio.prototype.play = function () {
    return Promise.resolve();
  };
  const loading = vm.runInContext('playRuleAudio(6)', context);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent", context), /加载/);
  assert.equal(timers.at(-1).ms, 15000);
  timers.at(-1).fn();
  assert.equal(await loading, false);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent", context), /加载超时/);
  const playing = vm.runInContext('playRuleAudio(6)', context);
  audios[1].onplaying();
  assert.equal(timers.at(-1).ms, 600000);
  timers.at(-1).fn();
  assert.equal(await playing, false);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent", context), /播放中断/);
});

test('无语音支持、播放错误和超时均不阻塞，保留文字与原因', async () => {
  const { context } = setup();
  vm.runInContext('voiceEnabled=true', context);
  assert.equal(await vm.runInContext("speakText('文字仍然可读')", context), false);
  assert.match(vm.runInContext("$('voiceStatus').textContent", context), /不支持语音/);
  const { spoken, synth } = installSpeech(context);
  const failed = vm.runInContext("speakText('播放会失败',{seat:0})", context);
  spoken[0].onerror({ error: 'not-allowed' });
  assert.equal(await failed, false);
  assert.match(vm.runInContext("$('voiceStatus').textContent", context), /语音播放失败/);
  let timeout;
  context.setTimeout = (fn, delay) => {
    if (delay >= 15000) {
      timeout = fn;
      return undefined;
    }
    return setTimeout(fn, delay);
  };
  const hanging = vm.runInContext("speakText('底层未返回完成事件',{seat:1})", context);
  timeout();
  assert.equal(await hanging, false);
  assert.equal(synth.cancels, 1);
  assert.match(vm.runInContext("$('voiceStatus').textContent", context), /已跳过/);
});

test('自然语音请求与对局发言共用1400个Unicode字符上限', async () => {
  const { context } = setup(new Map(), false, false),
    { audios, requests } = installNatural(context);
  vm.runInContext('voiceEnabled=true', context);
  const text = '🧛'.repeat(1501);
  const playing = vm.runInContext('speakText(' + JSON.stringify(text) + ',{seat:0})', context);
  await until(() => audios.length === 1);
  assert.equal(Array.from(requests[0].body.text).length, 1400);
  audios[0].onended();
  await playing;
});

test('自然语音生成中暂停，生成完成仍等待；继续后播放，关闭声音释放等待', async () => {
  const { context } = setup(new Map(), false, false),
    { audios, pending } = installNatural(context, { hold: true });
  vm.runInContext('voiceEnabled=true', context);
  vm.runInContext('busy=true', context);
  const playing = vm.runInContext("speakText('别投我，我不是狼！',{seat:0})", context);
  vm.runInContext('togglePause()', context);
  pending[0]();
  await until(() => audios.length === 1);
  assert.equal(audios[0].plays, undefined);
  assert.equal(vm.runInContext('narration.paused', context), true);
  vm.runInContext('togglePause()', context);
  assert.equal(audios[0].plays, 1);
  vm.runInContext('togglePause()', context);
  assert.equal(audios[0].pauses, 1);
  vm.runInContext('toggleDialogueVoice()', context);
  assert.equal(await playing, false);
  assert.equal(audios[0].src, '');
});

test('重置取消生成且忽略迟到的音频，不污染下一局', async () => {
  const { context } = setup(new Map(), false, false),
    { audios, pending, requests } = installNatural(context, { hold: true });
  vm.runInContext('voiceEnabled=true', context);
  const playing = vm.runInContext("speakText('公开台词',{seat:0})", context);
  vm.runInContext('reset(12)', context);
  assert.equal(await playing, false);
  assert.equal(requests[0].request.signal.aborted, true);
  pending[0]();
  await new Promise(setImmediate);
  assert.equal(audios.length, 0);
  assert.equal(vm.runInContext('narration', context), null);
});

test('语音生成超时释放等待和请求；试听关闭时取消，非法旧音色安全恢复', async () => {
  const { context } = setup(new Map(), false, false),
    { requests } = installNatural(context, { hold: true });
  let timeout;
  vm.runInContext('voiceEnabled=true', context);
  context.setTimeout = (fn, ms) => {
    if (ms === 280000) timeout = fn;
    return undefined;
  };
  const playing = vm.runInContext("speakText('公开台词',{seat:0})", context);
  timeout();
  await until(() => !!vm.runInContext('speechFailure', context));
  assert.equal(requests[0].request.signal.aborted, true);
  assert.equal(vm.runInContext('speechFailure.attempts', context), 3);
  vm.runInContext('continueSpeechWithoutAudio()', context);
  assert.equal(await playing, false);
  vm.runInContext('openAgent(0)', context);
  const preview = vm.runInContext('previewVoice()', context);
  vm.runInContext('closeModal()', context);
  await preview;
  assert.equal(requests[1].request.signal.aborted, true);
  const saved = new Map([
    [
      'nightfall-profiles-v1',
      JSON.stringify([
        { voiceProvider: 'invalid', voice: 'unknown', voiceStyle: 'wrong', voiceSpeed: 999 },
      ]),
    ],
  ]);
  const old = setup(saved, false, false);
  assert.equal(vm.runInContext('profiles[0].voiceProvider', old.context), 'neural');
  assert.equal(vm.runInContext('profiles[0].voiceSpeed', old.context), 1);
});

test('旁白语音失败后暂停并显示旁白名称；无声继续按全文阅读时间推进', async () => {
  const { context } = setup(new Map(), false, false);
  context.requested = [];
  installNatural(context);
  context.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({
      error: { code: 'VOICE_NETWORK_ERROR', message: '语音服务暂不可用', attempts: 3 },
    }),
  });
  vm.runInContext(
    "busy=true;game.start();game.players.forEach((p,i)=>{p.alive=i===0});spectatorPrefs.narratorEnabled=true;commentaryQueue=[{kind:'custom',round:1,publicText:'现在进入白天讨论，大家请依次发言。',godText:'现在进入白天讨论，注意身份和发言。'}];presentationDelayScale=1;presentationWait=async(ms)=>{requested.push(ms);return true}",
    context,
  );
  const commentary = vm.runInContext('flushCommentary(epoch)', context);
  await until(() => !!vm.runInContext('speechFailure', context));
  const expected = vm.runInContext(
    'NightfallObserver.readingTime(observerText(currentCommentary))',
    context,
  );
  assert.match(vm.runInContext("$('voiceStatus').textContent", context), /旁白语音生成失败/);
  assert.equal(vm.runInContext('paused', context), true);
  vm.runInContext('continueSpeechWithoutAudio()', context);
  await commentary;
  assert.deepEqual(Array.from(vm.runInContext('requested', context)), [expected]);
});

test('对白和旁白默认关闭，关闭对白不调用语音接口', async () => {
  const { context } = setup(new Map(), false, false),
    natural = installNatural(context);
  installSpeech(context);
  vm.runInContext('renderVoiceControls()', context);
  assert.equal(vm.runInContext('voiceEnabled', context), false);
  assert.equal(vm.runInContext("$('voiceBtn').attributes['aria-pressed']", context), 'false');
  assert.match(vm.runInContext("$('voiceBtn').textContent", context), /对白语音：关/);
  assert.equal(vm.runInContext('spectatorPrefs.narratorEnabled', context), false);
  assert.equal(await vm.runInContext("speakText('只显示字幕',{seat:0})", context), false);
  assert.equal(
    await vm.runInContext("speakText('旁白也应静音',{kind:'commentary'})", context),
    false,
  );
  assert.equal(natural.requests.length, 0);
});

test('三个记录入口同步收起双侧记录，保留阅读位置与旁白，人物点击重新展开', () => {
  const { context, saved } = setup(new Map(), false);
  vm.runInContext(
    "recordSeat='2';recordScroll.speeches={top:123,bottom:false,seen:0};recordScroll.activity={top:77,bottom:false,seen:0};recordScroll.commentary={top:91,bottom:false,seen:0};spectatorPrefs.narratorEnabled=true;addObserver({round:1,godText:'保留的旁白',publicText:'公开旁白'});renderSpectator()",
    context,
  );
  for (const id of ['railToggle', 'mobileRecordToggle', 'railClose']) {
    vm.runInContext(`$('${id}').listeners.click()`, context);
    assert.equal(
      vm.runInContext(
        "$('observerRail').classList.contains('hidden')&&$('spectatorRail').classList.contains('collapsed')&&document.body.classList.contains('rail-collapsed')",
        context,
      ),
      true,
    );
    vm.runInContext(
      "$('recordsViewport').scrollTop=0;$('recordsViewport').listeners.scroll()",
      context,
    );
    assert.equal(vm.runInContext('recordScroll.speeches.top', context), 123);
    assert.equal(vm.runInContext('spectatorPrefs.narratorEnabled', context), true);
    assert.equal(JSON.parse(saved.get('nightfall-spectator-v1')).railOpen, false);
    vm.runInContext(`$('${id}').listeners.click()`, context);
    assert.equal(
      vm.runInContext(
        "$('observerRail').classList.contains('hidden')||$('spectatorRail').classList.contains('collapsed')",
        context,
      ),
      false,
    );
    assert.equal(vm.runInContext("$('recordsViewport').scrollTop", context), 123);
    assert.equal(vm.runInContext("$('activityViewport').scrollTop", context), 77);
    assert.equal(vm.runInContext("$('commentaryViewport').scrollTop", context), 91);
    assert.equal(vm.runInContext('recordSeat', context), '2');
  }
  vm.runInContext("$('railClose').listeners.click()", context);
  context.seatEvent = {
    target: {
      closest: (selector) =>
        selector === '[data-replay]' ? null : { closest: () => ({ dataset: { player: '4' } }) },
    },
  };
  vm.runInContext("$('playersGrid').listeners.click(seatEvent)", context);
  assert.equal(vm.runInContext('spectatorPrefs.railOpen', context), true);
  assert.equal(vm.runInContext('recordSeat', context), '4');
  assert.equal(vm.runInContext('observerEvents.length', context), 1);
  const html = fs.readFileSync('index.html', 'utf8');
  assert.doesNotMatch(
    html,
    /interaction-box|interactionTarget|sendShout|shoutInput|互动一下|飞刀|表扬|举杯|喊话/,
  );
  assert.doesNotMatch(
    fs.readFileSync('app.js', 'utf8'),
    /function interaction\(|sendShout|shoutInput|interactionTarget/,
  );
});

test('六与十二人女巫完整解说串行播放，普通视角字幕历史导出和专属音效隐藏', async () => {
  for (const count of [6, 12])
    for (const perspective of ['god', 'public']) {
      const { context } = setup(new Map(), false),
        heard = [],
        sounds = [];
      const witch = count === 6 ? 3 : 5,
        target = count === 6 ? 4 : 8;
      context.hearWitch = async (text) => {
        heard.push(text);
        return true;
      };
      context.effectWitch = (...args) => sounds.push(args);
      vm.runInContext(
        `reset(${count});game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[${count}][i]);setPerspective('${perspective}');turnDelay=0;spectatorPrefs.narratorEnabled=true;speakText=hearWitch;effects.play=effectWitch;decision=(id)=>id===${witch}?{save:true,poison:null}:id<${count === 6 ? 2 : 4}?{target:${target}}:{target:0};localStoryDecision=decision`,
        context,
      );
      await vm.runInContext('runNight()', context);
      const text = vm.runInContext(
        "$('commentaryList').innerHTML+$('commentaryText').textContent+JSON.stringify(spectatorExport())",
        context,
      );
      if (perspective === 'god') {
        const open = heard.findIndex((t) => t.includes('女巫请睁眼')),
          close = heard.findIndex((t) => t.includes('女巫请闭眼'));
        assert.ok(open >= 0 && close > open);
        assert.match(heard[open], /解药剩余一瓶，毒药剩余一瓶/);
        assert.match(heard[close], new RegExp(`${witch + 1} 号女巫对 \\d+ 号 使用解药`));
        assert.match(text, /抵挡本夜的狼刀/);
      } else {
        assert.ok(heard.every((t) => !/女巫请睁眼|解药剩余|使用解药/.test(t)));
        assert.doesNotMatch(text, /witchState|witchOutcome|使用解药|解药剩余|女巫请睁眼/);
        assert.ok(!sounds.some((a) => JSON.stringify(a).includes('save')));
      }
      assert.equal(vm.runInContext(`game.players[${target}].alive`, context), true);
    }
});

test('无声或失败阅读时长按字数计算并封顶280秒，气泡结束收起且暂停停止脉动', async () => {
  const observer = require('./observer.js');
  assert.equal(observer.readingTime('短句'), 4000);
  assert.equal(observer.readingTime('字'.repeat(40)), 8000);
  assert.equal(observer.readingTime('字'.repeat(500)), 100000);
  assert.equal(observer.readingTime('字'.repeat(1400)), 280000);
  assert.equal(observer.readingTime('字'.repeat(2000)), 280000);
  const { context } = setup();
  let done, wait;
  context.hold = (ms) => {
    wait = ms;
    return new Promise((r) => (done = r));
  };
  vm.runInContext('voiceEnabled=false;busy=true;presentationWait=hold', context);
  const reading = vm.runInContext("showPlayerSpeech({id:0,text:'字'.repeat(40)})", context);
  await until(() => !!done);
  assert.equal(wait, 8000);
  assert.equal(vm.runInContext('speechBubble.id', context), 0);
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /speaking pulsing/);
  vm.runInContext('togglePause()', context);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML", context), /pulsing/);
  vm.runInContext('togglePause()', context);
  done();
  await reading;
  assert.equal(vm.runInContext('speechBubble', context), null);
  vm.runInContext('voiceEnabled=true;speakText=async()=>false', context);
  const failed = vm.runInContext("showPlayerSpeech({id:0,text:'失败后继续阅读'})", context);
  await until(() => wait === 4000);
  done();
  await failed;
});

test('生成、播放、暂停和短尾声有独立气泡状态，下一位立即替换', async () => {
  const { context } = setup(new Map(), false, false),
    { pending, audios } = installNatural(context, { hold: true });
  let done, delay;
  vm.runInContext('voiceEnabled=true', context);
  context.hold = (ms) => {
    delay = ms;
    return new Promise((r) => (done = r));
  };
  vm.runInContext('presentationWait=hold;busy=true', context);
  const playing = vm.runInContext("showPlayerSpeech({id:0,text:'第一位发言'})", context);
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /准备声音/);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML", context), /speaking pulsing/);
  pending[0]();
  await until(() => audios.length === 1);
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /speaking pulsing/);
  vm.runInContext('togglePause()', context);
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /已暂停/);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML", context), /speaking pulsing/);
  vm.runInContext('togglePause()', context);
  audios[0].onended();
  await until(() => delay === 250);
  assert.match(vm.runInContext("$('playersGrid').innerHTML", context), /发言结束/);
  done();
  await playing;
  assert.equal(vm.runInContext("$('speechBubble').classList.contains('hidden')", context), true);
});

test('阅读计时暂停时冻结，重置立即取消等待和旧气泡', async () => {
  const { context } = setup();
  vm.runInContext('busy=true;paused=true;voiceEnabled=false;presentationDelayScale=1', context);
  let ended = false;
  const waiting = vm.runInContext('presentationWait(30,epoch)', context).then(() => (ended = true));
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(ended, false);
  vm.runInContext('togglePause()', context);
  await waiting;
  const reading = vm.runInContext("showPlayerSpeech({id:0,text:'长时间阅读的对白'})", context);
  await new Promise(setImmediate);
  vm.runInContext('reset(12)', context);
  await reading;
  assert.equal(vm.runInContext('speechBubble', context), null);
  assert.equal(vm.runInContext('presentationWaiters.size', context), 0);
});

test('旁白串行等待结束再播放下一条，独立云扬音色，重复同步不会重复入队', async () => {
  const { context } = setup(new Map(), false, false),
    { audios, requests } = installNatural(context);
  vm.runInContext(
    'game.start();syncLogs();syncLogs();spectatorPrefs.narratorEnabled=true;busy=true',
    context,
  );
  assert.equal(vm.runInContext('commentaryQueue.length', context), 1);
  vm.runInContext(
    "addObserver({kind:'discussion',round:1,publicText:'开始讨论',godText:'开始讨论'})",
    context,
  );
  const playing = vm.runInContext('flushCommentary(epoch)', context);
  await until(() => audios.length === 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.voice, 'zh-CN-YunyangNeural');
  assert.equal(requests[0].body.style, 'calm');
  assert.equal(requests[0].body.speed, 1);
  audios[0].onended();
  await until(() => audios.length === 2);
  assert.equal(audios[0].src, '');
  audios[1].onended();
  await playing;
  assert.equal(vm.runInContext('commentaryQueue.length', context), 0);
});

test('旁白暂停恢复、单独关闭，失败保留字幕，切换视角停止旧声音不重播', async () => {
  const { context } = setup(new Map(), false, false),
    { audios, requests } = installNatural(context);
  vm.runInContext(
    "busy=true;spectatorPrefs.narratorEnabled=true;addObserver({round:1,publicText:'公开夜间流程',godText:'私有查验结果'})",
    context,
  );
  const playing = vm.runInContext('flushCommentary(epoch)', context);
  await until(() => audios.length === 1);
  vm.runInContext('toggleDialogueVoice()', context);
  assert.equal(audios[0].src.startsWith('blob:'), true);
  vm.runInContext('togglePause()', context);
  assert.equal(audios[0].pauses, 1);
  vm.runInContext('togglePause()', context);
  assert.equal(audios[0].plays, 2);
  vm.runInContext("setPerspective('public')", context);
  await playing;
  assert.equal(audios[0].src, '');
  assert.equal(requests.length, 1);
  assert.equal(vm.runInContext("$('commentaryText').textContent", context), '公开夜间流程');
  context.fetch = async () => ({ ok: false, json: async () => ({ error: { message: '失败' } }) });
  vm.runInContext("addObserver({round:1,publicText:'下一条字幕',godText:'下一条字幕'})", context);
  await vm.runInContext('flushCommentary(epoch)', context);
  assert.equal(vm.runInContext("$('commentaryText').textContent", context), '下一条字幕');
});

test('旁白生成中重置隔离迟到响应并清空队列与历史', async () => {
  const { context } = setup(new Map(), false, false),
    { pending, audios } = installNatural(context, { hold: true });
  vm.runInContext(
    "spectatorPrefs.narratorEnabled=true;addObserver({round:1,publicText:'第一条',godText:'第一条'});addObserver({round:1,publicText:'第二条',godText:'第二条'})",
    context,
  );
  const old = vm.runInContext('flushCommentary(epoch)', context);
  await until(() => pending.length === 1);
  vm.runInContext('reset()', context);
  pending[0]();
  await old;
  await new Promise(setImmediate);
  assert.equal(audios.length, 0);
  assert.equal(vm.runInContext('observerEvents.length+commentaryQueue.length', context), 0);
  assert.equal(vm.runInContext('currentCommentary', context), null);
});

test('两种视角统一投影字幕、历史、行动高亮和导出，普通观战终局前无角色表', async () => {
  const { context, requests } = setup();
  vm.runInContext(
    "game.phase='night';game.players[0].role='狼人';activeSeat=0;actionText='1 号正在秘密行动';addObserver({round:1,publicText:'天亮了，平安夜',godText:'1 号守卫守护 5 号。私有信息标记',result:{secret:'observer-only'}});currentCommentary=observerEvents[0];setPerspective('public')",
    context,
  );
  assert.doesNotMatch(
    vm.runInContext("$('playersGrid').innerHTML", context),
    /acting |预言家|女巫|狼人|API 连接中/,
  );
  assert.doesNotMatch(vm.runInContext("$('actionPanel').innerHTML", context), /1 号/);
  assert.doesNotMatch(
    vm.runInContext(
      "$('commentaryList').innerHTML+$('commentaryText').textContent+JSON.stringify(spectatorExport())",
      context,
    ),
    /私有信息标记|observer-only|守护 5/,
  );
  assert.equal(vm.runInContext("'roles' in spectatorExport()", context), false);
  vm.runInContext("setPerspective('god')", context);
  assert.match(vm.runInContext("$('commentaryList').innerHTML", context), /私有信息标记/);
  await vm.runInContext("decision(8,'vote')", context);
  assert.doesNotMatch(
    JSON.stringify(requests.at(-1).messages),
    /私有信息标记|observer-only|commentary|guardTarget/,
  );
  vm.runInContext("game.phase='ended';setPerspective('public')", context);
  assert.equal(vm.runInContext('spectatorExport().roles.length', context), 12);
});

test('夜间分步顺序来自规则校验，行动展示前不结算死亡，普通观战无私有旁白与目标', async () => {
  for (const mode of ['god', 'public']) {
    const { context } = setup(new Map(), false);
    const shown = [];
    context.capture = () => {
      shown.push(
        vm.runInContext(
          '({alive:game.alive().length,kind:currentCommentary.kind,phase:game.phase})',
          context,
        ),
      );
      return Promise.resolve(true);
    };
    vm.runInContext(
      "reset(12);game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[12][i]);turnDelay=0;speakText=capture;spectatorPrefs.narratorEnabled=true;spectatorPrefs.perspective='" +
        mode +
        "';localDecision=(id)=>id===7?{target:8}:id<4?{target:8}:id===4?{target:0}:{save:false,poison:6}",
      context,
    );
    await vm.runInContext('runNight(epoch)', context);
    assert.equal(vm.runInContext('game.players[8].alive', context), true);
    assert.equal(vm.runInContext('game.players[6].alive', context), false);
    assert.equal(vm.runInContext('game.pendingHunter', context), null);
    const kinds = Array.from(
      vm.runInContext('observerEvents.filter(e=>e.private).map(e=>e.kind)', context),
    );
    assert.deepEqual(kinds, [
      'night-cue',
      'guard',
      'night-cue',
      'wolf',
      'night-cue',
      'seer',
      'night-cue',
      'poison',
    ]);
    if (mode === 'god') {
      assert.equal(shown.length, 8);
      assert.ok(shown.every((x) => x.alive === 12 && x.phase === 'night'));
    } else {
      assert.equal(shown.length, 0);
      assert.doesNotMatch(
        vm.runInContext(
          "JSON.stringify(spectatorExport().commentary)+$('commentaryList').innerHTML",
          context,
        ),
        /守护|毒药|查验|选择袭击/,
      );
    }
    assert.doesNotMatch(
      vm.runInContext('JSON.stringify(game.context(8))', context),
      /private|godText|最终存亡|守护目标/,
    );
  }
});

test('白天讨论旁白报出实际起点，两种视角均在旁白结束后按引擎顺序发言一次', async (t) => {
  const scenarios = [];
  for (const size of [6, 12]) {
    const afterFirstSeat = Array.from({ length: size - 1 }, (_, id) => id + 1);
    scenarios.push(
      { name: size + ' 人单人夜死', size, round: 2, victim: 0, order: afterFirstSeat },
      {
        name: size + ' 人平安夜随机起点',
        size,
        round: 1,
        victim: null,
        order: size === 6 ? [1, 2, 3, 4, 5, 0] : [3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2],
      },
      {
        name: size + ' 人多人夜死随机起点',
        size,
        round: 2,
        victim: 0,
        poison: 4,
        order: size === 6 ? [2, 3, 5, 1] : [3, 5, 6, 7, 8, 9, 10, 11, 1, 2],
      },
      {
        name: size + ' 人跨最大座位号',
        size,
        round: 2,
        victim: size - 2,
        order: [size - 1, ...Array.from({ length: size - 2 }, (_, id) => id)],
      },
      { name: size + ' 人首夜遗言', size, round: 1, victim: 0, order: afterFirstSeat },
    );
  }
  scenarios.push(
    {
      name: '猎人放弃开枪后进入讨论',
      size: 12,
      round: 2,
      victim: 6,
      order: [7, 8, 9, 10, 11, 0, 1, 2, 3, 4, 5],
    },
    {
      name: '猎人开枪后跳过已出局席位',
      size: 12,
      round: 2,
      victim: 6,
      hunterTarget: 7,
      order: [8, 9, 10, 11, 0, 1, 2, 3, 4, 5],
    },
    {
      name: '首夜猎人技能和双方遗言结束',
      size: 12,
      round: 1,
      victim: 6,
      hunterTarget: 7,
      order: [8, 9, 10, 11, 0, 1, 2, 3, 4, 5],
    },
  );
  for (const scenario of scenarios)
    for (const perspective of ['public', 'god'])
      await t.test(scenario.name + ' · ' + perspective, async (t) => {
        const { context } = setup(new Map(), false);
        const read = (code) => vm.runInContext(code, context);
        prepareAuto(context, scenario.size);
        context.discussionFixture = scenario;
        const spoken = [];
        const discussionRequests = [];
        context.discussionDecision = (id, task) => {
          if (task === 'speech') {
            if (read('game.phase') === 'discussion') discussionRequests.push(id);
            return { speech: id + 1 + ' 号的公开发言' };
          }
          if (task === 'hunter') return { target: scenario.hunterTarget ?? null };
          const role = read('game.players[' + id + '].role');
          if (role === '狼人') return { target: scenario.victim };
          if (role === '女巫') return { save: false, poison: scenario.poison ?? null };
          return { target: null };
        };
        let release, running;
        context.hearDiscussion = (text) => {
          if (read('currentCommentary.kind') !== 'discussion') return Promise.resolve(true);
          spoken.push({ text, caption: read("$('commentaryText').textContent") });
          return new Promise((resolve) => (release = resolve));
        };
        context.finishAtVoting = () => read('epoch++');
        t.after(async () => {
          read('reset()');
          release?.(true);
          await running;
        });
        read(`
          game.start();
          game.players.forEach((p, i) => p.role = Nightfall.ROLES[size][i]);
          game.round = discussionFixture.round;
          game.random = () => 0.25;
          busy = true;
          voiceEnabled = false;
          spectatorPrefs.narratorEnabled = true;
          speakText = hearDiscussion;
          vote = finishAtVoting;
          localDecision = discussionDecision;
        `);
        read('spectatorPrefs.perspective=' + JSON.stringify(perspective));
        await read('runNight(epoch)');
        const initiallyDiscussing = read("game.phase==='discussion'");
        assert.equal(
          read("observerEvents.filter(e=>e.kind==='discussion').length"),
          initiallyDiscussing ? 1 : 0,
        );
        read('syncLogs();syncLogs();renderAll()');
        running = read('runGame(epoch)');
        await until(() => !!release);
        assert.equal(read('game.phase'), 'discussion');
        assert.equal(read('game.lastWordsQueue.length'), 0);
        assert.equal(read('game.pendingHunter'), null);
        assert.deepEqual(Array.from(read('game.speechOrder')), scenario.order);
        assert.equal(discussionRequests.length, 0);
        assert.equal(read('game.speeches.length'), 0);
        const event = read("observerEvents.find(e=>e.kind==='discussion')");
        const introduction =
          '现在进入白天讨论，本轮从 ' +
          (scenario.order[0] + 1) +
          ' 号玩家开始，存活玩家按座位顺序顺时针依次发言。';
        assert.equal(event.publicText, introduction + '公开发言只是玩家的主张，请结合票型判断。');
        assert.equal(event.godText, introduction + '留意他们如何表达信息、隐藏身份或试探对手。');
        assert.deepEqual(spoken, [
          {
            text: perspective === 'public' ? event.publicText : event.godText,
            caption: perspective === 'public' ? event.publicText : event.godText,
          },
        ]);
        release(true);
        await running;
        assert.equal(read('runError'), '');
        assert.deepEqual(Array.from(read('game.speeches.map(s=>s.id)')), scenario.order);
        assert.deepEqual(discussionRequests, scenario.order);
        assert.equal(read("observerEvents.filter(e=>e.kind==='discussion').length"), 1);
        assert.equal(spoken.length, 1);
      });
});

test('遗言后入夜、猎人结算终局和 PK 发言均按各自阶段处理旁白', async (t) => {
  for (const hunterExiled of [false, true])
    await t.test(hunterExiled ? '猎人放逐及遗言后入夜' : '普通放逐遗言后入夜', async () => {
      const { context } = setup(new Map(), false);
      const read = (code) => vm.runInContext(code, context);
      prepareAuto(context, 12);
      context.finishAtNight = () => read('epoch++');
      read(`
        game.start();
        game.players.forEach((p, i) => p.role = Nightfall.ROLES[12][i]);
        game.resolveNight({}, null);
        game.openVoting();
        voiceEnabled = false;
        spectatorPrefs.narratorEnabled = false;
        runNight = finishAtNight;
        localDecision = (id, task) => task === 'speech' ? { speech: '遗言内容' } : { target: null };
      `);
      context.exileId = hunterExiled ? 6 : 8;
      read('game.resolveVotes(Object.fromEntries(game.alive().map(p=>[p.id,exileId])))');
      if (hunterExiled) {
        await read('hunter(epoch)');
        assert.equal(read('game.phase'), 'lastWords');
      }
      await read('runGame(epoch)');
      assert.equal(read('runError'), '');
      assert.equal(read('game.phase'), 'night');
      assert.equal(read('game.round'), 2);
      assert.equal(read("observerEvents.filter(e=>e.kind==='discussion').length"), 0);
      assert.equal(read('transcript.length'), 1);
    });

  await t.test('猎人带走最后一狼结束游戏', async () => {
    const { context } = setup(new Map(), false);
    const read = (code) => vm.runInContext(code, context);
    prepareAuto(context, 12);
    read(`
      game.start();
      game.players.forEach((p, i) => p.role = Nightfall.ROLES[12][i]);
      [1, 2, 3].forEach(id => game.players[id].alive = false);
      game.round = 2;
      game.resolveNight({}, 6);
      localDecision = () => ({ target: 0 });
    `);
    await read('hunter(epoch)');
    assert.equal(read('game.phase'), 'ended');
    assert.equal(read('game.winner'), '好人');
    assert.equal(read("observerEvents.filter(e=>e.kind==='discussion').length"), 0);
  });

  await t.test('夜间结算结束游戏', async () => {
    const { context } = setup(new Map(), false);
    const read = (code) => vm.runInContext(code, context);
    prepareAuto(context, 6);
    read(`
      game.start();
      game.players.forEach((p, i) => p.role = Nightfall.ROLES[6][i]);
      game.players[4].alive = false;
      game.round = 2;
      spectatorPrefs.narratorEnabled = false;
      localDecision = id => {
        if (id < 2) return { target: 5 };
        if (id === 3) return { save: false, poison: null };
        return { target: null };
      };
    `);
    await read('runNight(epoch)');
    assert.equal(read('game.phase'), 'ended');
    assert.equal(read('game.winner'), '狼人');
    assert.equal(read("observerEvents.filter(e=>e.kind==='discussion').length"), 0);
  });

  await t.test('平票进入 PK 发言', async () => {
    const { context } = setup(new Map(), false);
    const read = (code) => vm.runInContext(code, context);
    prepareAuto(context, 6);
    read(`
      game.start();
      game.players.forEach((p, i) => p.role = Nightfall.ROLES[6][i]);
      game.resolveNight({}, null);
      game.openVoting();
      voiceEnabled = false;
      spectatorPrefs.narratorEnabled = false;
      localDecision = (id, task) => task === 'speech' ? { speech: 'PK 发言' } : { target: [2, 2, 3, 2, 3, 3][id] };
    `);
    await read('vote(epoch)');
    assert.deepEqual(Array.from(read('game.pk')), [2, 3]);
    assert.deepEqual(Array.from(read('game.speeches.map(s=>s.id)')), [2, 3]);
    assert.equal(read('game.speeches.every(s=>s.pk)'), true);
    assert.equal(read("observerEvents.filter(e=>e.kind==='discussion').length"), 0);
  });
});

test('三种试听文本不改变用户音色，只生成整句一次，嘴部锚点覆盖六位形象', async () => {
  const { context } = setup(new Map(), false, false),
    { audios, requests } = installNatural(context);
  vm.runInContext('openAgent(0)', context);
  for (const option of ['analysis', 'question', 'defense']) {
    context.option = option;
    vm.runInContext("$('voicePreviewTextInput').value=option", context);
    const playing = vm.runInContext('previewVoice()', context);
    await until(() => audios.length === requests.length && audios.length > 0);
    assert.equal(requests.at(-1).body.text, vm.runInContext('voicePreviewTexts[option]', context));
    audios.at(-1).onended();
    await playing;
  }
  assert.equal(requests.length, 3);
  assert.equal(Object.keys(require('./manor.js').mouths).length, 12);
  assert.ok(
    Object.values(require('./manor.js').mouths).every(
      (p) => p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1,
    ),
  );
});

test('普通观战全夜不展示个人狼刀，不播放私有合并旁白，六与十二人一致', async () => {
  for (const count of [6, 12]) {
    const { context } = setup(new Map(), false),
      hints = [],
      spoken = [];
    context.inspect = async (id) => {
      hints.push(vm.runInContext("$('playersGrid').innerHTML", context));
      return { target: id < 2 ? 4 : 0, save: false, poison: null };
    };
    context.hear = async (text) => {
      spoken.push(text);
      return true;
    };
    vm.runInContext(
      `reset(${count});game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[${count}][i]);setPerspective('public');turnDelay=0;decision=inspect;speakText=hear;spectatorPrefs.narratorEnabled=true`,
      context,
    );
    await vm.runInContext('runNight()', context);
    assert.ok(hints.every((html) => !/wolf-choice|正在选刀|提议袭击/.test(html)));
    const event = vm.runInContext("observerEvents.find(e=>e.kind==='wolf')", context);
    assert.equal(event.wolfChoices.length, count === 12 ? 4 : 2);
    assert.equal(spoken.length, 0);
    assert.doesNotMatch(
      vm.runInContext('JSON.stringify(spectatorExport())', context),
      /提议袭击|wolfChoices/,
    );
  }
});

test('竖屏普通及PK发言先亮相500毫秒，切回圆桌不中断或重复生成声音', async () => {
  for (const pk of [false, true]) {
    const { context } = setup(new Map(), false, false, false, true),
      { audios, requests } = installNatural(context);
    vm.runInContext('voiceEnabled=true', context);
    let enter;
    const waits = [];
    context.entrance = (ms) => {
      waits.push(ms);
      return ms === 500 ? new Promise((r) => (enter = r)) : Promise.resolve(true);
    };
    vm.runInContext(
      `game.start();game.phase='discussion';game.pk=${pk ? '[0,1]' : 'null'};busy=true;setPortraitMode(true);presentationWait=entrance`,
      context,
    );
    const playing = vm.runInContext(
      "showPlayerSpeech({id:0,text:'先看清每条线索，再决定相信谁。'})",
      context,
    );
    assert.equal(vm.runInContext("$('portraitHeroState').textContent", context), '即将发言');
    assert.equal(requests.length, 0);
    assert.equal(waits[0], 500);
    enter(true);
    await until(() => audios.length === 1);
    assert.equal(vm.runInContext("$('portraitHeroName').textContent", context), '1 号 · 岚');
    assert.equal(vm.runInContext("$('portraitHeroState').textContent", context), '正在发言');
    audios[0].duration = 10;
    audios[0].currentTime = 3;
    audios[0].ontimeupdate();
    const caption = vm.runInContext('speechBubble.caption', context),
      current = vm.runInContext('narration', context),
      pauses = audios[0].pauses;
    vm.runInContext(
      "apiWaiting={id:0,message:'接口等待',failures:1,startedAt:Date.now(),nextAt:Date.now()+5000};renderAction();apiWaiting.failures=2;renderAction();apiWaiting=null;renderAction()",
      context,
    );
    assert.equal(vm.runInContext('narration', context), current);
    assert.equal(requests.length, 1);
    assert.equal(audios[0].currentTime, 3);
    assert.equal(audios[0].pauses, pauses);
    assert.equal(vm.runInContext("$('portraitCaption').textContent", context), caption);
    vm.runInContext('setPortraitMode(false);setPortraitMode(true)', context);
    assert.equal(vm.runInContext('narration', context), current);
    assert.equal(requests.length, 1);
    assert.equal(audios[0].currentTime, 3);
    assert.equal(audios[0].pauses, pauses);
    assert.equal(vm.runInContext("$('portraitCaption').textContent", context), caption);
    vm.runInContext('togglePause()', context);
    assert.equal(vm.runInContext("$('portraitHeroState').textContent", context), '已暂停');
    assert.equal(
      vm.runInContext("$('portraitHero').classList.contains('pulsing')", context),
      false,
    );
    vm.runInContext('togglePause()', context);
    audios[0].onended();
    await playing;
    assert.equal(requests.length, 1);
    assert.equal(vm.runInContext('speechBubble', context), null);
  }
});

test('竖屏思考和PK等待使用人物字幕区，不携带已结束的阶段旁白', () => {
  for (const count of [6, 12])
    for (const pk of [false, true]) {
      const { context } = setup(new Map(), false, true, false, true);
      vm.runInContext(
        `reset(${count});game.start();game.phase='${pk ? 'voting' : 'discussion'}';game.pk=${pk ? '[2,3]' : 'null'};activeSeat=2;actionText='3 号 ${pk ? 'PK ' : ''}发言';currentCommentary={godText:'旧的白天阶段长旁白',publicText:'旧的公开旁白'};setPortraitMode(true)`,
        context,
      );
      const read = (code) => vm.runInContext(code, context);
      assert.equal(read("$('portraitHero').classList.contains('hidden')"), false);
      assert.equal(read("$('portraitFrame').dataset.caption"), 'speaker');
      assert.match(read("$('portraitCaption').textContent"), /整理思路/);
      assert.doesNotMatch(read("$('portraitCaption').textContent"), /旧的/);
      read('apiWaiting={id:2};renderAll()');
      assert.equal(read("$('portraitFrame').dataset.caption"), 'speaker');
      assert.match(read("$('portraitCaption').textContent"), /3 号的当前行动已暂停，请手动重试/);
      read('apiWaiting=null;paused=true;renderAll()');
      assert.match(read("$('portraitCaption').textContent"), /已暂停/);
      read('paused=false;narration={seat:2,loading:true};renderAll()');
      assert.match(read("$('portraitCaption').textContent"), /准备声音/);
      read(
        "speechBubble={id:2,kind:'dialogue',stage:'reading',caption:'当前逐句字幕'};renderAll()",
      );
      assert.equal(read("$('portraitCaption').textContent"), '当前逐句字幕');
      assert.equal(read('currentCommentary.godText'), '旧的白天阶段长旁白');
      read('narration=null;speechBubble=null;activeSeat=null;renderAll()');
      assert.equal(read("$('portraitFrame').dataset.caption"), 'narration');
      assert.equal(read("$('portraitCaption').textContent"), '旧的白天阶段长旁白');
    }
});

test('语音失败暂停期间下一位结果只暂存，无声继续后按实际阅读顺序记录', async (t) => {
  const h = speechPipeline(t, { actors: [0, 1], realPlayback: true }),
    { context, read, chat } = h;
  installRuleAudio(context);
  const recorded = [],
    waits = [];
  let speechCalls = 0;
  const agentFetch = context.fetch;
  context.fetch = async (url, options) => {
    if (url !== '/api/speech') return agentFetch(url, options);
    speechCalls++;
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: { message: '语音三次失败', attempts: 3 } }),
    };
  };
  context.recordingTranscriptBegin = (entry) => {
    recorded.push(entry);
    return String(recorded.length);
  };
  context.pipelineWait = () => new Promise((resolve) => waits.push(resolve));
  read(
    'voiceEnabled=true;profiles.forEach(p=>{p.voiceProvider="neural";p.voiceMatch="custom"});presentationWait=pipelineWait',
  );
  const running = h.start();
  await until(() => chat.length === 1);
  chat[0].speech('语音失败但保留的原句');
  await until(() => chat.length === 2 && read('!!speechFailure'));
  chat[1].speech('下一位已完成');
  await until(() => read('preparedSpeech.status') === 'ready');
  assert.equal(read('paused'), true);
  assert.equal(read('activeSeat'), 0);
  assert.equal(read('transcript.length'), 1);
  assert.equal(recorded.length, 0);
  read('continueSpeechWithoutAudio();voiceEnabled=false');
  await until(() => waits.length === 1);
  assert.equal(recorded[0].text, '语音失败但保留的原句');
  assert.equal(chat.length, 2);
  waits.shift()(true);
  await until(() => recorded.length === 2 && waits.length === 1);
  assert.equal(recorded[1].text, '下一位已完成');
  assert.equal(recorded[1].seat, 1);
  waits.shift()(true);
  await running;
  assert.equal(chat.length, 2);
  assert.equal(speechCalls, 1);
});
