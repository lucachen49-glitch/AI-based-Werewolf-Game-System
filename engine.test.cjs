const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Game,ROLES,RULES}=require('./engine.js');

function fixed(size=6,random=()=>.4){
  const game=new Game(size,random).start();
  game.players.forEach((player,index)=>player.role=ROLES[size][index]);
  return game;
}

function settleAll(game,shoot=()=>null){
  while(game.phase==='settle'){
    const step=game.settlementStep();
    assert.ok(step,'每个出局者都应有统一结算步骤');
    game.resolveSettlement(step.hunter?shoot(step.id,game):null);
  }
}

function finishLastWords(game){
  while(game.phase==='lastWords')game.addLastWord(game.lastWordsQueue[0],'最后陈述');
  if(game.phase==='lastWords')game.finishLastWords();
}

test('规则说明明确采用屠边、遗言、发言顺序和两轮狼刀',()=>{
  assert.match(RULES,/神职全部出局或平民全部出局/);
  assert.match(RULES,/第二夜起夜间出局没有遗言/);
  assert.match(RULES,/第一轮一致则直接确定/);
  assert.match(RULES,/发言从唯一夜间死者的下一位存活玩家开始/);
});

test('6 人与 12 人均按屠边判胜，狼队全灭优先判好人胜',()=>{
  for(const size of [6,12]){
    for(const eliminatedRole of ['神职','平民']){
      const game=fixed(size);
      const protectedRole=eliminatedRole==='神职'?'狼人':'神职';
      for(const player of game.players){
        if(eliminatedRole==='神职'&&['预言家','女巫','猎人','守卫'].includes(player.role))player.alive=false;
        if(eliminatedRole==='平民'&&player.role==='平民')player.alive=false;
      }
      assert.equal(game.checkWinner(),'狼人',`${size} 人屠${eliminatedRole==='神职'?'神':'民'}边应判狼人胜`);
    }
    const game=fixed(size);
    for(const player of game.players)if(player.role==='狼人')player.alive=false;
    assert.equal(game.checkWinner(),'好人');
    assert.equal(game.phase,'ended');
  }
  const simultaneous=fixed();
  for(const player of simultaneous.players)player.alive=false;
  assert.equal(simultaneous.checkWinner(),'好人');
});

test('狼人数量暂时不少于好人时不会提前结束',()=>{
  const game=fixed();
  for(const player of game.players)player.alive=player.role==='狼人'||player.role==='预言家'||player.role==='平民'&&player.id===4;
  assert.equal(game.alive().filter(player=>player.role==='狼人').length,2);
  assert.equal(game.alive().filter(player=>player.role!=='狼人').length,2);
  assert.equal(game.checkWinner(),null);
});

test('同守同救仍出局，死因为狼刀且解药消耗',()=>{
  const game=fixed(12);
  const result=game.resolveNight({5:{save:true},7:{target:6}},6);
  assert.equal(result.saved,true);
  assert.equal(result.doubleProtection,true);
  assert.equal(game.players[6].alive,false);
  assert.equal(game.players[6].cause,'wolf');
  assert.equal(game.potions.save,false);
});

test('天亮死讯按座位号排列且不公开死因',()=>{
  const game=fixed(12);
  game.resolveNight({5:{poison:1}},6);
  const dawn=game.logs.find(entry=>entry.text.startsWith('天亮了。'));
  assert.match(dawn.text,/2 号、7 号/);
  assert.doesNotMatch(dawn.text,/狼袭|中毒|毒药|狼刀/);
});

test('预言家不能重复查验，已查验目标不会再次进入合法目标',()=>{
  const game=fixed();
  game.resolveNight({2:{target:0}},null);
  assert.equal(game.knowledge[2][0],'狼人');
  assert.equal(game.legalTargets(2,'night').includes(1),false);
  game.nextNight();
  const result=game.resolveNight({2:{target:0}},null);
  assert.equal(result.seerCheck,null);
  assert.equal(Object.keys(game.knowledge[2]).length,1);
});

test('狼刀两轮先看是否一致，再按多数与随机平票定刀',()=>{
  const game=fixed();
  assert.deepEqual(game.wolfConsensus({0:{target:4},1:{target:4}}),{unanimous:true,target:4});
  assert.deepEqual(game.wolfConsensus({0:{target:4},1:{target:5}}),{unanimous:false,target:null});
  assert.equal(game.wolfTarget({0:{target:4},1:{target:5}}),4);
  assert.equal(game.wolfTarget({0:{target:4},1:{target:4}}),4);
  const randomTie=fixed(6,()=>.99);
  assert.equal(randomTie.wolfTarget({0:{target:4},1:{target:5}}),5);
});

test('女巫药剂每晚只能用一种且药效与夜间结算一致',()=>{
  const game=fixed();
  const result=game.resolveNight({0:{target:4},1:{target:4},3:{save:true,poison:0}});
  assert.equal(result.saved,true);
  assert.equal(result.poisoned,null);
  assert.equal(game.potions.save,false);
  assert.equal(game.potions.poison,true);
  assert.equal(game.players[4].alive,true);
});

test('守卫不能连续守同一人，毒药无视守护',()=>{
  const game=fixed(12);
  game.resolveNight({0:{target:8},1:{target:8},2:{target:8},3:{target:8},7:{target:8}},8);
  assert.equal(game.players[8].alive,true);
  game.nextNight();
  game.resolveNight({0:{target:8},1:{target:8},2:{target:8},3:{target:8},7:{target:8},5:{poison:9}},8);
  assert.equal(game.players[8].alive,false);
  assert.equal(game.players[9].alive,false);
  assert.equal(game.lastGuard,null);
});

test('猎人统一结算，不开枪时不产生公开消息，狼刀出局可开枪',()=>{
  const skipped=fixed(12);
  skipped.resolveNight({},6);
  assert.equal(skipped.phase,'settle');
  const step=skipped.settlementStep();
  assert.equal(step.hunter,true);
  skipped.resolveSettlement(null);
  assert.equal(skipped.phase,'lastWords');
  finishLastWords(skipped);
  assert.equal(skipped.phase,'discussion');
  assert.equal(skipped.logs.some(entry=>/猎人.*(放弃|选择是否|可选择)/.test(entry.text)),false);

  const shot=fixed(12);
  shot.resolveNight({},6);
  shot.resolveSettlement(0);
  assert.equal(shot.phase,'lastWords');
  finishLastWords(shot);
  assert.equal(shot.players[6].alive,false);
  assert.equal(shot.players[0].alive,false);
  assert.ok(shot.logs.some(entry=>/7 号猎人开枪带走 1 号/.test(entry.text)));
});

test('中毒猎人不触发开枪，其他出局者仍完成相同的结算步骤',()=>{
  const game=fixed(12);
  game.resolveNight({5:{poison:6}},null);
  const step=game.settlementStep();
  assert.deepEqual(step,{id:6,hunter:false});
  game.resolveSettlement();
  assert.equal(game.pendingHunter,null);
  assert.equal(game.phase,'lastWords');
  finishLastWords(game);
  assert.equal(game.phase,'discussion');
});

test('首夜遗言按座位顺序，猎人带走者仅在猎人可遗言时获得遗言',()=>{
  const game=fixed(12);
  game.resolveNight({5:{target:0}},6);
  settleAll(game,()=>0);
  assert.equal(game.phase,'lastWords');
  assert.deepEqual(game.lastWordsQueue,[0,6]);
  finishLastWords(game);
  assert.equal(game.phase,'discussion');
  assert.deepEqual(game.speechHistory.map(entry=>entry.id),[0,6]);
  assert.ok(game.speechHistory.every(entry=>entry.lastWords));
});

test('第二夜夜间出局没有遗言，单人死亡从下一位存活席位开始发言',()=>{
  const game=fixed();
  game.nextNight();
  game.resolveNight({},2);
  settleAll(game);
  assert.equal(game.phase,'discussion');
  assert.equal(game.lastWordsQueue.length,0);
  assert.equal(game.speechOrder[0],3);
});

test('多人夜间出局后随机选择存活起始位，且首夜死者遗言在胜负后跳过',()=>{
  const game=fixed(12,()=>0);
  game.resolveNight({5:{poison:1}},6);
  settleAll(game);
  assert.equal(game.phase,'lastWords');
  finishLastWords(game);
  assert.equal(game.phase,'discussion');
  assert.ok(game.alive().some(player=>player.id===game.speechOrder[0]));

  const ended=fixed();
  ended.players.forEach(player=>player.alive=player.role==='狼人');
  ended.players.find(player=>player.role==='狼人').alive=false;
  ended.resolveNight({},null);
  settleAll(ended);
  assert.equal(ended.phase,'ended');
  assert.equal(ended.lastWordsQueue.length,0);
});

test('白天放逐者有遗言，结束游戏时省略遗言',()=>{
  const game=fixed();
  game.phase='discussion';
  game.openVoting();
  game.resolveVotes({0:2,1:2,2:1,3:1,4:1,5:1});
  assert.equal(game.phase,'voting');
  const result=game.resolveVotes({0:2,1:2,2:1,3:1,4:1,5:1});
  assert.equal(result.eliminated,0);
  settleAll(game);
  assert.equal(game.phase,'lastWords');
  assert.deepEqual(game.lastWordsQueue,[0]);

  const ended=fixed();
  ended.phase='discussion';
  ended.players.forEach(player=>player.alive=player.role==='狼人');
  ended.players.find(player=>player.role==='狼人').alive=false;
  ended.openVoting();
  ended.resolveVotes({});
  assert.equal(ended.phase,'ended');
});

test('PK 候选人按当天顺序发言，候选人全员时可以互投且不能自投',()=>{
  const game=fixed();
  game.phase='discussion';
  game.speechOrder=[0,1,2,3,4,5];
  game.daySpeechOrder=[0,1,2,3,4,5];
  game.openVoting();
  const tie=game.resolveVotes({0:1,1:0,2:0,3:0,4:1,5:1});
  assert.deepEqual(tie.pk,[0,1]);
  assert.equal(game.canVote(0),false);
  game.pk=[0,1,2,3,4,5];
  for(let id=0;id<game.size;id++){
    assert.equal(game.canVote(id),true);
    assert.equal(game.legalTargets(id,'vote').includes(id+1),false);
  }
  game.pk=[0,1];
  const result=game.resolveVotes({0:1,1:0,2:0,3:0,4:0,5:0});
  assert.equal(result.eliminated,0);
  assert.equal(game.phase,'settle');
});

test('狼队全灭获胜判定发生在猎人技能之后',()=>{
  const game=fixed(12);
  for(const player of game.players)if(player.role==='狼人'&&player.id!==0)player.alive=false;
  game.players[6].alive=false;
  game.players[6].cause='vote';
  game.beginSettlement('night',[6],true);
  settleAll(game,()=>0);
  assert.equal(game.players[0].alive,false);
  assert.equal(game.winner,'好人');
  assert.equal(game.phase,'ended');
  assert.equal(game.lastWordsQueue.length,0);
});

test('完整历史包含全部公开事件与发言并保留遗言标记',()=>{
  const game=fixed(12);
  for(let index=0;index<20;index++)game.event(`公开事件${index}`);
  game.event('隐藏事件','private');
  for(let index=0;index<125;index++)game.speechHistory.push({id:index%12,text:`公开发言${index}`,round:1,pk:index%2===0,lastWords:index===0});
  const context=game.context(4,[],{includeAllSpeeches:true,includeAllPublicEvents:true});
  assert.equal(context.publicEvents.length,21);
  assert.equal(context.publicEvents[0].text,'第 1 夜开始。天黑请闭眼。');
  assert.equal(context.publicEvents.at(-1).text,'公开事件19');
  assert.equal(context.speeches.length,125);
  assert.equal(context.speeches.at(-1).text,'公开发言124');
  assert.equal(context.speeches[0].lastWords,true);
  assert.ok(context.speeches.every(speech=>!Object.hasOwn(speech,'role')));
});

test('6 人与 12 人随机 AI 完整对局支持结算与遗言阶段',()=>{
  for(const size of [6,12])for(let run=0;run<30;run++){
    const game=new Game(size).start();
    let steps=0;
    while(!game.winner&&steps++<100){
      if(game.phase==='night'){
        const choices={};
        for(const player of game.alive()){
          if(player.role==='狼人'){
            const targets=game.alive().filter(target=>target.role!=='狼人');
            choices[player.id]={target:game.pick(targets)?.id??null};
          }else if(player.role==='预言家'){
            choices[player.id]={target:game.pick(game.legalTargets(player.id,'night').map(seat=>game.players[seat-1]))?.id??null};
          }else if(player.role==='守卫'){
            choices[player.id]={target:game.pick(game.legalTargets(player.id,'night').map(seat=>game.players[seat-1]))?.id??null};
          }else if(player.role==='女巫')choices[player.id]={save:false,poison:null};
        }
        game.resolveNight(choices);
      }else if(game.phase==='settle')settleAll(game);
      else if(game.phase==='lastWords')finishLastWords(game);
      else if(game.phase==='discussion'){
        for(const id of [...game.speechOrder])if(game.players[id].alive)game.addSpeech(id,'讨论发言');
        game.openVoting();
      }else if(game.phase==='voting'){
        if(game.pk)for(const id of game.pk)game.recordSpeech(id,'PK 发言');
        const votes={};
        for(const player of game.alive()){
          const targets=game.legalTargets(player.id,'vote').map(seat=>seat-1);
          votes[player.id]=game.pick(targets);
        }
        game.resolveVotes(votes);
      }
      assert.equal(game.players.length,size);
    }
    assert.ok(game.winner,`${size} 人对局应能结束`);
    assert.equal(game.phase,'ended');
  }
});

test('角色身份仅向有权限的玩家提供，预言家查验与女巫药剂保持私有',()=>{
  const game=fixed(12);
  game.knowledge[4]={0:'狼人'};
  game.potions={save:false,poison:true};
  for(let id=0;id<game.size;id++){
    const context=game.context(id);
    assert.ok(context.players.every(player=>!Object.hasOwn(player,'role')));
    if(id!==4)assert.deepEqual(context.checks,{});
    if(id!==5)assert.equal(context.potions,undefined);
    if(id<4)assert.ok(Array.isArray(context.wolfTeammates));
    else assert.equal(context.wolfTeammates,undefined);
  }
  assert.deepEqual(game.context(4).checks,{1:'狼人'});
  assert.deepEqual(game.context(5).potions,{save:false,poison:true});
});