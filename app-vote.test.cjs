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

test('六人和十二人投票与夜间请求使用完整公开历史并按角色隔离私有信息', () => {
  const { context } = setup(new Map(), false),
    read = (code) => vm.runInContext(code, context);
  for (const roomSize of [6, 12]) {
    context.historyFixture = { roomSize };
    read(
      [
        'size=historyFixture.roomSize;',
        'game=new Nightfall.Game(size).start();',
        'game.players.forEach((player,index)=>player.role=Nightfall.ROLES[size][index]);',
        'profiles.forEach(profile=>profile.historyContext="full");',
        'game.phase="night";game.round=4;game.players[size-1].alive=false;game.lastGuard=0;',
        'game.potions={save:true,poison:false};',
        'game.speechHistory=Array.from({length:125},(_,index)=>({id:index%size,text:"完整发言"+(index+1),round:Math.floor(index/size)+1,pk:index===123}));',
        'game.logs=Array.from({length:27},(_,index)=>({text:"公开事件"+(index+1),round:Math.floor(index/size)+1,phase:index%2?"voting":"discussion"}));',
        'game.knowledge={};',
        'game.knowledge[game.players.find(player=>player.role==="预言家").id]={[0]:"狼人",[size-1]:"好人"};',
        'game.knowledge[0]={[size-2]:"伪造的非预言家查验"};',
      ].join(''),
    );
    const roles = JSON.parse(read('JSON.stringify(game.players.map(player=>player.role))'));
    const seerId = roles.indexOf('预言家'),
      witchId = roles.indexOf('女巫'),
      guardId = roles.indexOf('守卫');
    const wolfIds = roles
      .map((role, id) => (role === '狼人' ? id : null))
      .filter((id) => id !== null);
    for (const seatId of roles.map((_, id) => id)) {
      const vote = JSON.parse(read('JSON.stringify(buildAgentContext(' + seatId + ',"vote"))'));
      const night = JSON.parse(
        read('JSON.stringify(buildAgentContext(' + seatId + ',"night",{victim:1}))'),
      );
      for (const taskContext of [vote, night]) {
        assert.equal(taskContext.speeches.length, 125);
        assert.equal(taskContext.speeches[0].text, '完整发言1');
        assert.equal(taskContext.speeches.at(-2).pk, true);
        assert.equal(taskContext.speeches.at(-1).text, '完整发言125');
        assert.equal(taskContext.publicEvents.length, 27);
        assert.deepEqual(taskContext.publicEvents.at(-1), {
          round: Math.floor(26 / roomSize) + 1,
          phase: 'discussion',
          text: '公开事件27',
        });
        assert.ok(taskContext.players.every((player) => !('role' in player)));
      }
      assert.equal(vote.role, roles[seatId]);
      assert.equal(night.role, roles[seatId]);
      if (seatId === seerId) {
        assert.deepEqual(night.checks, { 1: '狼人', [roomSize]: '好人' });
        assert.deepEqual(vote.checks, night.checks);
      } else {
        assert.deepEqual(night.checks, {});
        assert.deepEqual(vote.checks, {});
      }
      if (roles[seatId] === '狼人') {
        assert.deepEqual(
          night.wolfTeammates,
          wolfIds.filter((id) => id !== seatId).map((id) => id + 1),
        );
        assert.deepEqual(
          night.allowedTargets,
          roles.map((_, id) => id + 1).filter((seat) => seat !== roomSize),
        );
        assert.equal('wolfChoices' in night, false);
        assert.equal('choices' in night, false);
      } else {
        assert.equal(night.wolfTeammates, undefined);
      }
      if (seatId === guardId) {
        assert.equal(night.lastGuard, 1);
        assert.equal(night.allowedTargets.includes(1), false);
      } else {
        assert.equal(night.lastGuard, undefined);
      }
      if (seatId === witchId) {
        assert.equal(night.tonightVictim, 2);
        assert.deepEqual(night.potions, { save: true, poison: false });
        assert.equal(night.nightRules.poisonAvailable, false);
      } else {
        assert.equal(night.tonightVictim, undefined);
        assert.equal(night.potions, undefined);
      }
    }
    read('game.potions.save=false');
    const spentWitch = JSON.parse(
      read('JSON.stringify(buildAgentContext(' + witchId + ',"night",{victim:1}))'),
    );
    assert.equal(spentWitch.tonightVictim, undefined);
    assert.equal(spentWitch.nightRules.canSave, false);
  }
});

test('所有 API 席位包含 1 号位，模型独立且全程自动发言投票', async () => {
  const { context } = setup(),
    seen = [];
  prepareAuto(context, 6);
  vm.runInContext(
    `game.random=()=>.9999;profiles.slice(0,6).forEach((p,i)=>Object.assign(p,{control:'api',endpoint:'https://example.test',model:'seat-'+(i+1),key:'key-'+(i+1)}))`,
    context,
  );
  context.fetch = batchCompatibleFetch(async (url, { body }) => {
    const request = JSON.parse(body),
      { task, context: view } = JSON.parse(request.messages[1].content);
    seen.push({ task, view, request });
    assert.ok(seen.length < 300);
    const result =
      task === 'speech'
        ? { speech: `我是 ${view.seat} 号，我会独立判断。` }
        : task === 'night' && view.role === '女巫'
          ? { save: !!view.potions.save, poison: null }
          : { target: view.allowedTargets[0] ?? null };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(result) } }] }),
    };
  });
  await vm.runInContext('start()', context);
  assert.equal(vm.runInContext('game.phase', context), 'ended');
  assert.equal(vm.runInContext('runError', context), '');
  for (const task of ['night', 'speech', 'vote'])
    assert.ok(
      seen.some((x) => x.view.seat === 1 && x.task === task),
      `1号位应自动执行 ${task}`,
    );
  for (const { view, request } of seen) {
    assert.equal(request.model, 'seat-' + view.seat);
    assert.equal(request.apiKey, 'key-' + view.seat);
    assert.ok(view.players.every((p) => !('role' in p)));
  }
  assert.equal(
    new Set(
      seen
        .filter((x) => x.task === 'speech' && !x.view.pk && !x.view.lastWords)
        .map((x) => x.view.round + ':' + x.view.seat),
    ).size,
    seen.filter((x) => x.task === 'speech' && !x.view.pk && !x.view.lastWords).length,
  );
});

test('自动完成平票 PK 发言及第二轮投票，候选人不参与投票', async () => {
  const { context } = setup();
  prepareAuto(context, 6);
  vm.runInContext(
    `
    game.random=()=>.9999;const realDecision=decision;let pkSpeakers=[],pkVoters=[];
    decision=(id,task,extra)=>{
      if(task==='speech'){if(game.pk)pkSpeakers.push(id);return {speech:'独立 PK 判断'}}
      if(task==='night')return game.players[id].role==='女巫'?{save:false,poison:null}:{target:null};
      if(task==='vote'){
        if(game.pk){pkVoters.push(id);return {target:2}}
        if(game.round===1)return {target:[2,3,3,2,2,3][id]};
        const target=game.alive().find(p=>p.role==='狼人').id;return {target:id===target?null:target};
      }
      return realDecision(id,task,extra);
    };localStoryDecision=decision;
  `,
    context,
  );
  await vm.runInContext('start()', context);
  assert.equal(vm.runInContext('game.phase', context), 'ended');
  assert.deepEqual(Array.from(vm.runInContext('pkSpeakers', context)), [2, 3]);
  assert.deepEqual(Array.from(vm.runInContext('pkVoters', context)), [0, 1, 4, 5]);
  assert.equal(vm.runInContext('game.speechHistory.filter(s=>s.pk).length', context), 2);
});

test('逐席唱票说明目标或弃票，完成收票后播报且记录不进入玩家上下文', async () => {
  const { context } = setup(new Map(), false),
    spoken = [];
  let collected = 0;
  context.choose = (id) => {
    collected++;
    return { target: id === 0 ? null : 0 };
  };
  context.hear = (text) => {
    spoken.push({ text, collected });
    return Promise.resolve(true);
  };
  vm.runInContext(
    'game.start();game.phase="discussion";game.openVoting();localStoryDecision=choose;speakText=hear;spectatorPrefs.narratorEnabled=true',
    context,
  );
  await vm.runInContext('vote()', context);
  assert.ok(spoken.every((s) => s.collected === 6));
  assert.equal(spoken.length, 6);
  assert.equal(spoken[0].text, '1 号玩家弃票。');
  assert.equal(spoken[4].text, '5 号玩家投给 1 号。');
  const events = JSON.parse(
    vm.runInContext('JSON.stringify(observerEvents.filter(e=>e.kind==="vote-reveal"))', context),
  );
  assert.deepEqual(
    events.map((e) => e.voter),
    [0, 1, 2, 3, 4, 5],
  );
  assert.doesNotMatch(
    vm.runInContext('JSON.stringify(game.context(2))', context),
    /vote-reveal|godText|voter/,
  );
  assert.match(
    vm.runInContext('seatDecorations(game.players[4])', context),
    /seat-overlay.*投给 1 号/,
  );
});

test('投票收齐后才按座位揭示，票数与引擎一致，PK 候选人排除且第二轮清空', async () => {
  const { context } = setup(new Map(), false);
  const collected = [],
    frames = [];
  context.choose = (id) => {
    collected.push(vm.runInContext('JSON.stringify(votePresentation)', context));
    return { target: [2, 2, 3, 2, 3, 3][id] };
  };
  context.voteFrame = () => {
    frames.push(vm.runInContext('JSON.stringify(votePresentation)', context));
    return Promise.resolve(true);
  };
  vm.runInContext(
    'game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);game.phase="discussion";game.openVoting();localStoryDecision=(...args)=>choose(...args);presentationWait=voteFrame;aiSpeeches=async()=>{}',
    context,
  );
  await vm.runInContext('vote()', context);
  assert.ok(collected.every((x) => Object.keys(JSON.parse(x).votes).length === 0));
  const reveal = frames.map(JSON.parse).filter((x) => x && Object.keys(x.votes).length);
  assert.equal(Object.keys(reveal[0].votes).length, 1);
  assert.deepEqual(reveal.at(-1).counts, { 2: 3, 3: 3 });
  assert.deepEqual(Array.from(vm.runInContext('game.pk', context)), [2, 3]);
  collected.length = 0;
  frames.length = 0;
  context.choose = (id) => {
    collected.push(vm.runInContext('JSON.stringify(votePresentation)', context));
    return { target: id % 2 ? 3 : 2 };
  };
  await vm.runInContext('vote()', context);
  const begin = JSON.parse(collected[0]);
  assert.equal(begin.states[2], 'excluded');
  assert.equal(begin.states[3], 'excluded');
  assert.deepEqual(begin.counts, {});
  assert.equal(vm.runInContext('game.votes[2]', context), null);
  assert.equal(vm.runInContext('game.votes[3]', context), null);
  assert.equal(vm.runInContext('game.alive().length', context), 6);
});

test('PK仍处投票阶段时，等待回复就展示中央人物，投票请求不误显示', () => {
  const { context } = setup(new Map(), false, true, false, true);
  vm.runInContext(
    "game.start();game.phase='voting';game.pk=[0,1];activeSeat=0;actionText='1 号 正在进行 PK 发言';setPortraitMode(true)",
    context,
  );
  assert.equal(vm.runInContext('portraitFocus()', context), 0);
  assert.equal(vm.runInContext("$('portraitHeroState').textContent", context), '思考中');
  vm.runInContext("activeSeat=2;actionText='3 号 正在投票';renderPlayers()", context);
  assert.equal(vm.runInContext('portraitFocus()', context), null);
});

test('狼人批次状态按当前席位显示，后续狼人不会复用第一位狼人的结果', async (t) => {
  const h = wolfHarness(t),
    { read, groups, wolves } = h;
  h.read('wolfPresentation={round:game.round,states:{}}');
  const running = h.start();
  await until(() => groups.length === 1);
  assert.ok(wolves.length > 1);
  const pending = wolves.at(-1);
  for (const seat of wolves.slice(0, -1)) {
    const target = seat + 1 === 12 ? 1 : seat + 2;
    groups[0].result(seat + 1, target);
  }
  await until(() => read('voteBatchStatus().received') === wolves.length - 1);
  for (const seat of wolves.slice(0, -1)) {
    const target = seat + 1 === 12 ? 1 : seat + 2;
    const state = JSON.parse(read('JSON.stringify(wolfPresentation.states[' + seat + '])'));
    assert.equal(state.id, seat);
    assert.equal(state.status, 'selected');
    assert.equal(state.target, target - 1);
  }
  assert.equal(read('wolfPresentation.states[' + pending + '].status'), 'choosing');
  groups[0].result(pending + 1, pending + 1 === 12 ? 1 : pending + 2);
  await running;
  assert.equal(read('voteBatch'), null);
});

test('超过120条的本局公开发言全部进入并发投票请求', async (t) => {
  const h = votingHarness(t, { size: 6, extraSpeeches: 125, historyContext: 'full' }),
    { groups } = h;
  const running = h.start();
  await until(() => groups.length === 1);
  for (const request of groups[0].requests) {
    const context = JSON.parse(request.messages[1].content).context;
    assert.equal(context.speeches.length, 131);
    assert.equal(context.speeches[0].text, '公开完整发言1');
    assert.equal(context.speeches[5].text, '公开完整发言6');
    assert.equal(context.speeches[6].text, '历史发言1');
    assert.equal(context.speeches.at(-1).text, '历史发言125');
    assert.equal(context.speeches.filter((speech) => speech.pk).length, 7);
  }
  h.replyAll(groups[0]);
  await running;
});

test('并发投票冻结完整发言和各席私有信息，乱序返回后按座位公布，六十二人与PK规则一致', async (t) => {
  for (const size of [6, 12])
    for (const pk of [false, true])
      await t.test(size + '人 ' + (pk ? 'PK' : '普通'), async (t) => {
        const h = votingHarness(t, { size, pk, dead: size === 12 ? [11] : [] }),
          { read, groups } = h;
        const expectedSeats = Array.from({ length: size }, (_, i) => i + 1).filter(
          (seat) => seat !== 12 && (!pk || ![2, 4].includes(seat)),
        );
        const running = h.start();
        await until(() => groups.length === 1);
        assert.deepEqual(
          groups[0].requests.map((item) => item.action.seat),
          expectedSeats,
        );
        for (const request of groups[0].requests) {
          const input = JSON.parse(request.messages[1].content),
            context = input.context;
          assert.equal(input.task, 'vote');
          assert.equal(context.speeches.length, size);
          assert.equal(context.speeches.at(-1).text, '公开完整发言' + size);
          assert.equal(request.reasoningEffort, context.seat % 2 ? 'xhigh' : 'high');
          assert.equal(request.maxTokens, 25000);
          assert.equal(
            context.players.some((p) => 'role' in p),
            false,
          );
          assert.equal(context.role, read('game.players[' + (context.seat - 1) + '].role'));
          assert.equal(context.allowedTargets.includes(context.seat), false);
          if (pk) assert.ok(context.allowedTargets.every((seat) => [2, 4].includes(seat)));
        }
        const reversed = groups[0].requests.slice().reverse();
        for (const request of reversed.slice(0, -1)) groups[0].result(request.action.seat, null);
        await until(() => read('voteBatchStatus().received') === expectedSeats.length - 1);
        assert.equal(read('Object.keys(votePresentation.votes).length'), 0);
        assert.equal(read('Object.keys(votePresentation.counts).length'), 0);
        assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'), 0);
        assert.match(read("$('portraitAPIStatus').textContent"), /投票.*已收/);
        await h.context.fetch('/api/recordings/mock/chunks', { body: 'test' });
        assert.equal(h.uploads.length, 1);
        groups[0].result(reversed.at(-1).action.seat, null);
        await running;
        assert.deepEqual(
          Array.from(read('observerEvents.filter(e=>e.kind==="vote-reveal").map(e=>e.voter+1)')),
          expectedSeats,
        );
        assert.equal(read('voteBatch'), null);
        assert.equal(
          read('observerEvents.filter(e=>e.kind==="vote-reveal").every(e=>e.target==null)'),
          true,
        );
      });
});

test('一席失败立即暂停公布，其余继续收票，手动重试仅提交失败席位并复用冻结上下文', async (t) => {
  const h = votingHarness(t),
    { read, groups } = h;
  const running = h.start();
  await until(() => groups.length === 1);
  const initial = groups[0];
  initial.result(1, 2);
  initial.error(2);
  await until(() => read('voteBatchStatus().failed.length') === 1);
  assert.equal(read('paused'), true);
  assert.equal(read('voteBatch.items[0].result.target'), 1);
  assert.match(read("$('actionPanel').innerHTML"), /重试失败投票/);
  read('togglePause()');
  assert.equal(read('paused'), true);
  assert.equal(groups.length, 1);
  for (const seat of [3, 4, 5, 6]) initial.result(seat, seat === 3 ? null : 2);
  await until(() => read('voteBatchStatus().received') === 5);
  assert.equal(read('Object.keys(votePresentation.votes).length'), 0);
  const frozen = JSON.parse(initial.requests[1].messages[1].content);
  read(
    'game.logs.push({text:"迟到公开内容",phase:"voting",round:1});profiles[1].model="new-model"',
  );
  read('retryAPI()');
  await until(() => groups.length === 2);
  assert.deepEqual(
    groups[1].requests.map((x) => x.action.seat),
    [2],
  );
  assert.equal(groups[1].requests[0].model, 'new-model');
  assert.deepEqual(JSON.parse(groups[1].requests[0].messages[1].content), frozen);
  assert.equal(read('voteBatch.items[0].result.target'), 1);
  groups[1].result(2, null);
  await running;
  assert.equal(read('game.votes[0]'), 1);
  assert.equal(read('game.votes[1]'), null);
  assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'), 6);
});

test('停止收票取消全部在途请求，保留成功票并只为未完成席位手动重试', async (t) => {
  const h = votingHarness(t),
    { read, groups } = h;
  const running = h.start();
  await until(() => groups.length === 1);
  groups[0].result(1, 2);
  groups[0].result(2, 1);
  await until(() => read('voteBatchStatus().received') === 2);
  read('stopAgentWait()');
  assert.equal(groups[0].signal.aborted, true);
  assert.equal(read('voteBatchStatus().failed.length'), 4);
  assert.equal(read('voteBatchStatus().received'), 2);
  assert.match(read("$('portraitAPIDialogText').textContent"), /供应商仍可能完成处理或计费/);
  read('retryAPI()');
  await until(() => groups.length === 2);
  assert.deepEqual(
    groups[1].requests.map((item) => item.action.seat),
    [3, 4, 5, 6],
  );
  h.replyAll();
  await running;
  assert.equal(read('game.votes[0]'), 1);
  assert.equal(read('game.votes[1]'), 0);
});

test('收票阶段配置变化仅使对应成功票失效，其他结果继续收取，旧请求号无法覆盖新结果', async (t) => {
  const h = votingHarness(t, { ignoreAbort: true }),
    { read, groups } = h;
  const running = h.start();
  await until(() => groups.length === 1);
  groups[0].result(1, 2);
  await until(() => read('voteBatchStatus().received') === 1);
  read('profiles[0].reasoningEffort="high";invalidateVoteAgent(0)');
  assert.equal(read('voteBatch.items[0].status'), 'failed');
  assert.equal(read('voteBatch.items[1].status'), 'pending');
  read('retryAPI()');
  await until(() => groups.length === 2);
  assert.deepEqual(
    groups[1].requests.map((x) => x.action.seat),
    [1],
  );
  assert.equal(groups[1].requests[0].reasoningEffort, 'high');
  groups[0].result(1, 3);
  await new Promise(setImmediate);
  assert.equal(read('voteBatch.items[0].status'), 'pending');
  for (const seat of [2, 3, 4, 5, 6]) groups[0].result(seat, null);
  groups[1].result(1, null);
  await running;
  assert.equal(read('game.votes[0]'), null);
});

test('API与模拟席位混用时模拟票在开始时暂存，换房清理计时及迟到批次结果', async (t) => {
  const h = votingHarness(t, { size: 12, locals: [0, 2, 5], ignoreAbort: true }),
    { read, groups } = h;
  const running = h.start();
  await until(() => groups.length === 1);
  assert.equal(read('voteBatchStatus().received'), 3);
  assert.equal(groups[0].requests.length, 9);
  assert.equal(read('Object.keys(votePresentation.votes).length'), 0);
  const batch = read('voteBatch');
  read('reset(6)');
  groups[0].result(2, 1);
  groups[0].close();
  await running;
  assert.equal(groups[0].signal.aborted, true);
  assert.equal(read('voteBatch'), null);
  assert.equal(read('game.size'), 6);
  assert.equal(read('game.phase'), 'lobby');
  assert.equal(read('game.logs.length'), 0);
  assert.equal(batch.wake, null);
});

test('原本手动暂停时发生投票错误，重试成功后仍需用户继续', async (t) => {
  const h = votingHarness(t),
    { read, groups } = h;
  const running = h.start();
  await until(() => groups.length === 1);
  read('togglePause()');
  groups[0].error(1);
  for (const seat of [2, 3, 4, 5, 6]) groups[0].result(seat, null);
  await until(() => read('voteBatchStatus().received') === 5);
  read('retryAPI()');
  await until(() => groups.length === 2);
  h.replyAll();
  await until(() => read('voteBatchStatus().received') === 6);
  assert.equal(read('paused'), true);
  assert.equal(read('Object.keys(votePresentation.votes).length'), 0);
  read('togglePause()');
  await running;
});

test('收票连接中断保留已成功票，仅重试未完成席位', async (t) => {
  const h = votingHarness(t),
    { read, groups } = h;
  const running = h.start();
  await until(() => groups.length === 1);
  groups[0].result(1, 2);
  groups[0].result(3, null);
  await until(() => read('voteBatchStatus().received') === 2);
  groups[0].close();
  await until(() => read('voteBatchStatus().failed.length') === 4);
  assert.equal(read('paused'), true);
  assert.equal(read('voteBatch.items[0].result.target'), 1);
  assert.equal(read('Object.keys(votePresentation.votes).length'), 0);
  read('retryAPI()');
  await until(() => groups.length === 2);
  assert.deepEqual(
    groups[1].requests.map((item) => item.action.seat),
    [2, 4, 5, 6],
  );
  h.replyAll();
  await running;
  assert.equal(read('game.votes[0]'), 1);
  assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'), 6);
});

test('剧本上下文准备时停止收票，旧准备完成不会发出额外投票', async (t) => {
  const h = votingHarness(t),
    { context, read, groups } = h,
    pending = [];
  context.storyContext = (id) => new Promise((resolve) => pending.push({ id, resolve }));
  const running = h.start();
  await until(() => pending.length === 6);
  read('stopAgentWait()');
  assert.equal(read('voteBatchStatus().failed.length'), 6);
  assert.equal(groups.length, 0);
  context.storyContext = async () => null;
  read('retryAPI()');
  await until(() => groups.length === 1);
  for (const item of pending) item.resolve({ self: { name: '迟到的旧资料' } });
  await new Promise(setImmediate);
  assert.equal(groups.length, 1);
  assert.equal(read('voteBatchStatus().failed.length'), 0);
  h.replyAll();
  await running;
});

test('剧本准备期间修改单席配置，旧准备错误不覆盖新尝试，其余席位继续收票', async (t) => {
  const h = votingHarness(t),
    { context, read, groups } = h;
  let rejectOld,
    first = true;
  context.storyContext = (id) => {
    if (id === 0 && first) {
      first = false;
      return new Promise((resolve, reject) => {
        rejectOld = reject;
      });
    }
    return Promise.resolve(null);
  };
  const running = h.start();
  await until(() => typeof rejectOld === 'function');
  read('profiles[0].model="updated-seat-1";invalidateVoteAgent(0);retryAPI()');
  await until(() => groups.length === 1);
  assert.deepEqual(
    groups[0].requests.map((item) => item.action.seat),
    [1],
  );
  assert.equal(groups[0].requests[0].model, 'updated-seat-1');
  rejectOld(Error('旧准备失败'));
  await until(() => groups.length === 2);
  assert.deepEqual(
    groups[1].requests.map((item) => item.action.seat),
    [2, 3, 4, 5, 6],
  );
  assert.equal(read('voteBatch.items[0].status'), 'pending');
  h.replyAll(groups[0]);
  h.replyAll(groups[1]);
  await running;
});

test('六人和十二人狼队请求并发携带完整历史且看不到队友选择', async (t) => {
  for (const size of [6, 12])
    await t.test(size + '人', async (t) => {
      const h = wolfHarness(t, { size }),
        running = h.start();
      await until(() => h.groups.length === 1);
      const group = h.groups[0];
      assert.deepEqual(
        group.requests.map((request) => request.action.seat),
        h.wolves.map((id) => id + 1),
      );
      assert.equal(group.requests.length, size === 6 ? 2 : 4);
      for (const request of group.requests) {
        const input = JSON.parse(request.messages[1].content),
          ctx = input.context;
        assert.equal(input.task, 'night');
        assert.equal(ctx.speeches.length, 130);
        assert.equal(ctx.speeches[0].text, '夜间公开发言1');
        assert.equal(ctx.speeches.at(-1).text, '夜间公开发言130');
        assert.equal(ctx.publicEvents.length, 22);
        assert.equal(ctx.publicEvents.at(-1).text, '公开事件22');
        assert.ok(ctx.speeches.some((speech) => speech.pk));
        assert.equal(ctx.role, '狼人');
        assert.deepEqual(
          Array.from(ctx.wolfTeammates),
          h.wolves.filter((id) => id + 1 !== request.action.seat).map((id) => id + 1),
        );
        assert.deepEqual(
          Array.from(ctx.allowedTargets),
          Array.from({ length: size }, (_, i) => i + 1),
        );
        assert.ok(ctx.players.every((player) => !('role' in player)));
        assert.equal('wolfChoices' in ctx, false);
        assert.equal('choices' in ctx, false);
        assert.equal(request.action.role, '狼人');
        assert.equal(request.maxTokens, 25000);
        assert.equal(request.reasoningEffort, request.action.seat % 2 ? 'xhigh' : 'high');
      }
      for (const request of group.requests) group.result(request.action.seat, request.action.seat);
      const choices = await running;
      for (const id of h.wolves) assert.equal(choices[id].target, id);
    });
});
