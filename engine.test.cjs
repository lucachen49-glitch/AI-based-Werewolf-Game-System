const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Game,ROLES}=require('./engine.js');
function fixed(size=6){const g=new Game(size,()=>.4);g.start();g.players.forEach((p,i)=>p.role=ROLES[size][i]);return g}

test('六与十二人女巫用药前条件、未生效原因与最终结算一致',()=>{
 const O=require('./observer.js');
 for(const size of [6,12])for(const kind of ['save','poison','unused','spent','no-victim','self','invalid','save-spent','poison-spent']){
  const g=fixed(size),w=size===6?3:5,target=size===6?4:8;
  if(kind==='self')g.round=2;
  if(kind==='spent')g.potions={save:false,poison:false};
  if(kind==='save-spent')g.potions.save=false;
  if(kind==='poison-spent')g.potions.poison=false;
  const victim=kind==='no-victim'?null:kind==='self'?w:target;
  const action={save:['save','no-victim','self','save-spent'].includes(kind),poison:kind==='poison'?target:kind==='invalid'?w:kind==='poison-spent'?0:null};
  const choices={[w]:action,...(size===12?{7:{target}}:{})},before=JSON.stringify(g);
  const plan=g.nightPlan(choices,victim);assert.equal(JSON.stringify(g),before);
  assert.deepEqual(plan.witchState,g.witchOptions(victim));
  const result=g.resolveNight(choices,victim);assert.deepEqual(result.witchOutcome,plan.witchOutcome);
  const e=O.nightAction('女巫',plan,[w]),cue=O.nightCue('女巫',g.round,[w],plan.witchState);
  assert.equal(O.project(e,'public'),'');assert.equal(O.project(cue,'public'),'');
  assert.match(cue.godText,/女巫请睁眼/);assert.match(cue.godText,kind==='self'?/今晚不能自救/:/首夜/);
  if(kind==='save'){assert.equal(plan.saved,true);assert.equal(g.players[target].alive,true);assert.match(e.godText,new RegExp(`${w+1} 号女巫对 ${target+1} 号 使用解药`));assert.match(e.godText,/抵挡本夜的狼刀/)}
  else if(kind==='poison'){assert.equal(plan.poisoned,target);assert.equal(g.players[target].cause,'poison');assert.match(e.godText,/毒药无视守护/)}
  else{assert.equal(plan.witchOutcome.type,'none');const expected={unused:'unused',spent:'potions-spent','no-victim':'no-victim',self:'self-save-forbidden',invalid:'invalid-poison','save-spent':'save-spent','poison-spent':'poison-spent'};assert.ok(plan.witchOutcome.reasons.includes(expected[kind]));assert.match(e.godText,/本夜没有使用药水/)}
  assert.doesNotMatch(e.godText,/已经死亡|已经出局|因为害怕|怀疑/);
 }
});

test('狼人可选择任意存活玩家，包括自己和队友，弃权及非法目标仍按规则处理',()=>{
  const g=fixed();g.players[5].alive=false;
  for(const [raw,status,target]of [[4,'selected',4],['3','selected',3],[0,'selected',0],[1,'selected',1],[null,'abstained',null],[undefined,'invalid',null],['','invalid',null],[5,'invalid',null],[99,'invalid',null]]){
    const choices={0:{target:raw},1:{target:null}},before=JSON.stringify(g);
    assert.deepEqual(g.wolfChoices(choices),[{id:0,target,status},{id:1,target:null,status:'abstained'}]);
    assert.equal(JSON.stringify(g),before);assert.equal(g.wolfTarget(choices),target);
  }
  g.players[1].alive=false;assert.equal(g.wolfChoices({}).length,1);
});

test('夜间展示计划无副作用，固定狼刀不再次随机且与结算结果一致',()=>{
  const g=fixed(12);let rolls=0;g.random=()=>{rolls++;return .2};
  const choices={0:{target:6},1:{target:8},4:{target:0},5:{save:true,poison:0},7:{target:6}};
  const victim=g.wolfTarget(choices),before=JSON.stringify(g);const plan=g.nightPlan(choices,victim);
  assert.equal(JSON.stringify(g),before);assert.equal(rolls,1);assert.equal(g.potions.save,true);assert.deepEqual(g.knowledge,{});
  const result=g.resolveNight(choices,victim);assert.equal(rolls,1);
  for(const key of Object.keys(plan))assert.deepEqual(result[key],plan[key]);
  assert.equal(result.saved,true);assert.equal(result.poisoned,null);assert.deepEqual(result.deaths,[]);
});

test('夜间无效目标与药水限制在展示和结算采用相同规则',()=>{
  const g=fixed(12);g.lastGuard=8;g.round=2;
  const choices={4:{target:4},5:{save:true,poison:6},7:{target:8}};
  const plan=g.nightPlan(choices,5);assert.equal(plan.guardTarget,null);assert.equal(plan.seerCheck,null);assert.equal(plan.saved,false);assert.equal(plan.poisoned,6);
  g.resolveNight(choices,5);assert.equal(g.pendingHunter,null);assert.equal(g.players[6].cause,'poison');assert.equal(g.potions.poison,false);
});

test('跨轮保留公开发言，重开清空历史',()=>{const g=fixed();g.phase='discussion';g.addSpeech(4,'我怀疑1号。');g.openVoting();g.resolveVotes({});g.resolveNight({});assert.equal(g.context(5).speeches[0].text,'我怀疑1号。');assert.equal(g.context(5).speeches[0].round,1);assert.equal(g.speeches.length,0);g.reset();assert.equal(g.speechHistory.length,0)});
test('投票上下文可带入超过120条的完整公开发言并保留轮次和PK标记',()=>{
 const g=fixed(12);
 for(let i=0;i<125;i++)g.speechHistory.push({id:i%12,text:`发言${i+1}`,round:Math.floor(i/12)+1,pk:i===123});
 assert.equal(g.context(0).speeches.length,120);
 const vote=g.context(0,[],{includeAllSpeeches:true});
 assert.equal(vote.speeches.length,125);
 assert.deepEqual(vote.speeches[0],{seat:1,text:'发言1',round:1,pk:false});
 assert.deepEqual(vote.speeches.at(-2),{seat:4,text:'发言124',round:11,pk:true});
 assert.deepEqual(vote.speeches.at(-1),{seat:5,text:'发言125',round:11,pk:false});
 for(let i=0;i<25;i++)g.logs.push({text:`公开事件${i+1}`,round:Math.floor(i/6)+1,phase:'voting'});
 const night=g.context(0,[],{includeAllSpeeches:true,includeAllPublicEvents:true});
 assert.equal(night.speeches.length,125);
 assert.equal(night.publicEvents.length,26);
 assert.deepEqual(night.publicEvents.at(-1),{round:5,phase:'voting',text:'公开事件25'});
});
test('recent 上下文只保留最近两轮发言，full 保留全部，6/12 人公开事件始终完整',()=>{
 for(const size of [6,12]){
  const g=fixed(size);g.round=4;
  g.speechHistory=Array.from({length:size*4},(_,i)=>({id:i%size,text:'发言'+(i+1),round:Math.floor(i/size)+1,pk:i%7===0}));
  g.logs=Array.from({length:19},(_,i)=>({text:'事件'+(i+1),round:Math.floor(i/size)+1,phase:'voting'}));
  const recent=g.context(0,[],{recentSpeechRounds:2,includeAllPublicEvents:true});
  const full=g.context(0,[],{includeAllSpeeches:true,includeAllPublicEvents:true});
  assert.equal(recent.speeches.length,size*2);
  assert.equal(recent.speeches[0].round,3);assert.equal(recent.speeches.at(-1).round,4);
  assert.equal(full.speeches.length,size*4);
  assert.equal(recent.publicEvents.length,19);assert.equal(full.publicEvents.length,19);
 }
});

test('普通与PK发言记录、Agent上下文统一截断到1400个Unicode字符',()=>{const g=fixed();g.phase='discussion';const long='狼人🧛'.repeat(500);g.addSpeech(0,long);assert.equal(Array.from(g.speeches[0].text).length,1400);assert.equal(g.speechHistory[0].text,g.speeches[0].text);assert.equal(g.context(1).speeches[0].text,g.speeches[0].text);g.pk=[0,1];g.recordSpeech(1,long);assert.equal(Array.from(g.speeches[0].text).length,1400);assert.equal(g.speechHistory[1].text,g.speeches[0].text)});

test('API 目标统一使用1起始座位号，守卫信息只对自己可见',()=>{const g=fixed(12);g.lastGuard=0;assert.equal(g.context(7).lastGuard,1);assert.equal(g.context(8).lastGuard,undefined);assert.equal(g.legalTargets(7,'night').includes(1),false);assert.ok(g.legalTargets(7,'night').includes(8));assert.deepEqual(g.legalTargets(0,'night'),[1,2,3,4,5,6,7,8,9,10,11,12]);g.pk=[8,9];assert.deepEqual(g.legalTargets(8,'vote'),[]);assert.deepEqual(g.legalTargets(7,'vote'),[9,10])});
test('6/12 人角色数量正确且随机发牌',()=>{for(const n of [6,12]){const g=new Game(n).start();assert.equal(g.alive().length,n);assert.equal(g.players.filter(p=>p.role==='狼人').length,n===6?2:4);assert.deepEqual(g.players.map(p=>p.role).sort(),[...ROLES[n]].sort())}});
test('预言家信息私有，不向平民暴露任何身份',()=>{const g=fixed();g.resolveNight({0:{target:4},1:{target:4},2:{target:0},3:{save:true}});assert.equal(g.knowledge[2][0],'狼人');assert.deepEqual(g.context(4).checks,{});assert.ok(g.context(4).players.every(p=>!('role'in p)));assert.equal(g.context(4).wolfTeammates,undefined);assert.deepEqual(g.context(0).wolfTeammates,[2])});
test('女巫解药只用一次，且每晚不得同时用毒',()=>{const g=fixed();let result=g.resolveNight({0:{target:4},1:{target:4},3:{save:true,poison:0}});assert.equal(result.saved,true);assert.equal(result.poisoned,null);assert.equal(g.potions.save,false);assert.equal(g.potions.poison,true);g.phase='night';g.round=2;result=g.resolveNight({0:{target:5},1:{target:5},3:{save:true}});assert.equal(result.saved,false);assert.equal(g.players[5].alive,false)});
test('女巫仅首夜可自救',()=>{for(const round of [1,2]){const g=fixed();g.round=round;g.resolveNight({0:{target:3},1:{target:3},3:{save:true}});assert.equal(g.players[3].alive,round===1)}});
test('守卫不能连续守同一人，毒药无视守护',()=>{const g=fixed(12);g.resolveNight({0:{target:8},1:{target:8},2:{target:8},3:{target:8},7:{target:8}});assert.equal(g.players[8].alive,true);g.phase='night';g.round=2;g.resolveNight({0:{target:8},1:{target:8},2:{target:8},3:{target:8},7:{target:8},5:{poison:9}});assert.equal(g.players[8].alive,false);assert.equal(g.players[9].alive,false)});
test('猎人被狼刀可开枪，中毒不能开枪',()=>{const g=fixed(12);g.resolveNight({0:{target:6},1:{target:6},2:{target:6},3:{target:6}});assert.equal(g.phase,'hunter');g.shoot(0);assert.equal(g.players[0].alive,false);assert.equal(g.phase,'discussion');const poisoned=fixed(12);poisoned.resolveNight({5:{poison:6}});assert.equal(poisoned.pendingHunter,null);assert.equal(poisoned.phase,'discussion')});
test('首轮平票 PK、二轮平票无人出局，PK 候选人不能投票',()=>{const g=fixed();g.phase='discussion';g.openVoting();let r=g.resolveVotes({0:2,1:2,2:3,3:2,4:3,5:3});assert.equal(r.tie,true);assert.deepEqual(g.pk,[2,3]);r=g.resolveVotes({0:2,1:3,2:3,3:2,4:2,5:3});assert.equal(r.eliminated,null);assert.equal(g.alive().length,6);assert.equal(g.phase,'night');assert.equal(g.votes[2],null);assert.equal(g.votes[3],null)});
test('自投与出局玩家选票无效，全员弃票进入下一夜',()=>{const g=fixed();g.phase='discussion';g.openVoting();g.resolveVotes({0:0,1:1,2:2,3:3,4:4,5:5});assert.equal(g.alive().length,6);assert.equal(g.round,2)});
test('最终狼人被放逐，好人获胜',()=>{const g=fixed();g.players[0].alive=false;g.phase='discussion';g.openVoting();g.resolveVotes({1:2,2:1,3:1,4:1,5:1});assert.equal(g.winner,'好人');assert.equal(g.phase,'ended')});
test('狼人数量不小于好人时狼人胜',()=>{const g=fixed();g.players[4].alive=false;g.resolveNight({0:{target:5},1:{target:5}});assert.equal(g.winner,'狼人')});
test('随机全 AI 对局在 6/12 人下能完成并保持状态一致',()=>{for(const size of [6,12])for(let run=0;run<60;run++){const g=new Game(size).start();let steps=0;while(!g.winner&&steps++<100){if(g.phase==='night'){const choices={};for(const p of g.alive()){const targets=g.alive().filter(t=>p.role==='狼人'?t.role!=='狼人':t.id!==p.id);choices[p.id]={target:g.pick(targets)?.id??null};if(p.role==='女巫')choices[p.id]={save:g.potions.save,poison:null}}g.resolveNight(choices)}else if(g.phase==='discussion')g.openVoting();else if(g.phase==='voting'){const votes={};for(const p of g.alive()){const targets=g.alive().filter(t=>t.id!==p.id&&(!g.pk||g.pk.includes(t.id)));votes[p.id]=g.pick(targets)?.id??null}g.resolveVotes(votes)}else if(g.phase==='hunter')g.shoot(g.pick(g.alive())?.id??null);assert.equal(g.players.length,size)}assert.ok(g.winner,`${size} 人对局应能结束`);assert.equal(g.phase,'ended')}});

test('Agent 上下文不暴露全员身份表，并仅提供角色有权知道的私有信息', () => {
  const g = fixed(12);
  g.knowledge[4] = { 0: '狼人' };
  g.lastGuard = 2;
  g.potions = { save: false, poison: true };

  for (let id = 0; id < g.size; id++) {
    const context = g.context(id, [], { includeAllSpeeches: true, includeAllPublicEvents: true });
    assert.equal(Object.hasOwn(context, 'board'), false);
    assert.ok(context.players.every(player => !Object.hasOwn(player, 'role')));
    if (id !== 4) assert.deepEqual(context.checks, {});
    if (id !== 5) assert.equal(context.potions, undefined);
    if (id !== 7) assert.equal(context.lastGuard, undefined);
    if (id < 4) assert.deepEqual(context.wolfTeammates, [1, 2, 3, 4].filter(seat => seat !== id + 1));
    else assert.equal(context.wolfTeammates, undefined);
  }

  assert.deepEqual(g.context(4).checks, { 1: '狼人' });
  assert.deepEqual(g.context(5).potions, { save: false, poison: true });
  assert.equal(g.context(7).lastGuard, 3);
});
