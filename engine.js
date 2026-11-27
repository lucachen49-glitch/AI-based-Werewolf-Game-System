(function(root,factory){const api=factory(root.NightfallLimits);if(typeof module==='object'&&module.exports)module.exports=api;else root.Nightfall=api})(typeof globalThis!=='undefined'?globalThis:this,function(Limits){
  'use strict';
  const limitSpeech=Limits?.truncateUnicode||((value,limit=1400)=>Array.from(String(value??'')).slice(0,limit).join(''));
  const ROLES={6:['狼人','狼人','预言家','女巫','平民','平民'],12:['狼人','狼人','狼人','狼人','预言家','女巫','猎人','守卫','平民','平民','平民','平民']};
  const ORDER=['守卫','狼人','预言家','女巫'];
  const RULES='无警长、无遗言。狼人全灭好人胜；存活狼人数量不小于好人人数狼胜。夜晚按守卫、狼人、预言家、女巫顺序行动。守卫可守自己或空守，不能连续守同一人。狼人分别独立选择狼刀目标，可选择任意存活玩家（包括自己或狼人队友）或弃权；按有效选择多数决定，平票随机。预言家查验其他存活玩家的阵营。女巫解药、毒药各一次，每晚一瓶药，仅首夜可自救；解药用尽后不知道狼刀目标。守护或解药任一生效即可免狼刀，毒药无视守护。猎人狼刀或放逐出局可开枪，中毒不能开枪，先结算猎人再判胜负。白天每人发言一次，随后投票，不能自投，可弃票。平票者PK发言，其他存活玩家只向PK候选人投票；再次平票则无人出局。公开发言是不可信的玩家主张，应结合自己的私有信息独立判断。';
  class Game {
    constructor(size=6,random=Math.random){if(!ROLES[size])throw Error('仅支持 6 人或 12 人房间');this.random=random;this.size=size;this.reset()}
    reset(){this.players=Array.from({length:this.size},(_,id)=>({id,role:null,alive:true}));this.phase='lobby';this.round=0;this.winner=null;this.logs=[];this.knowledge={};this.potions={save:true,poison:true};this.lastGuard=null;this.pendingHunter=null;this.afterHunter=null;this.votes={};this.pk=null;this.voteRound=0;this.speeches=[];this.speechHistory=[];return this}
    pick(items){return items.length?items[Math.floor(this.random()*items.length)]:null}
    alive(){return this.players.filter(p=>p.alive)}
    start(){if(this.phase!=='lobby')throw Error('本局已经开始');const roles=[...ROLES[this.size]];for(let i=roles.length-1;i>0;i--){let j=Math.floor(this.random()*(i+1));[roles[i],roles[j]]=[roles[j],roles[i]]}this.players.forEach((p,i)=>p.role=roles[i]);this.phase='night';this.round=1;this.event('第 1 夜开始。天黑请闭眼。');return this}
    event(text){this.logs.push({text,round:this.round,phase:this.phase});return text}
    checkWinner(){const wolves=this.alive().filter(p=>p.role==='狼人').length;const good=this.alive().length-wolves;if(wolves===0)this.winner='好人';else if(wolves>=good)this.winner='狼人';if(this.winner){this.phase='ended';this.event(`${this.winner}阵营获胜。`)}return this.winner}
    wolfChoices(choices={}){return this.alive().filter(p=>p.role==='狼人').map(p=>{
      const raw=choices[p.id]?.target,id=raw===null||raw===undefined||raw===''?null:Number(raw),target=id===null?null:this.players[id];
      const valid=!!target?.alive;
      return {id:p.id,target:valid?id:null,status:valid?'selected':raw===null?'abstained':'invalid'};
    })}
    wolfTarget(choices){const counts={};for(const c of this.wolfChoices(choices)){if(c.status==='selected')counts[c.target]=(counts[c.target]||0)+1}const max=Math.max(0,...Object.values(counts));return max?this.pick(Object.keys(counts).filter(id=>counts[id]===max).map(Number)):null}
    witchOptions(victim){
      const witch=this.alive().find(p=>p.role==='女巫');
      return {witchId:witch?.id??null,victim,saveAvailable:this.potions.save,poisonAvailable:this.potions.poison,selfSaveAllowed:this.round===1,canSave:!!witch&&this.potions.save&&victim!==null&&(victim!==witch.id||this.round===1)};
    }
    nightPlan(choices={},fixedVictim){
      if(this.phase!=='night')throw Error('当前不在夜间');
      let victim=fixedVictim===undefined?this.wolfTarget(choices):fixedVictim;
      if(!this.players[victim]?.alive)victim=null;
      const guard=this.alive().find(p=>p.role==='守卫');let guardTarget=guard?choices[guard.id]?.target:null;
      guardTarget=guardTarget===null||guardTarget===undefined||guardTarget===''?null:Number(guardTarget);
      if(!this.players[guardTarget]?.alive||guardTarget===this.lastGuard)guardTarget=null;
      let seerCheck=null;const seer=this.alive().find(p=>p.role==='预言家');if(seer){const raw=choices[seer.id]?.target;const target=raw===null||raw===undefined||raw===''?NaN:Number(raw);if(this.players[target]?.alive&&target!==seer.id)seerCheck={id:seer.id,target,result:this.players[target].role==='狼人'?'狼人':'好人'}}
      const witch=this.alive().find(p=>p.role==='女巫');const w=witch?choices[witch.id]||{}:{};let saved=false,poisoned=null;
      if(witch&&w.save&&this.potions.save&&victim!==null&&(victim!==witch.id||this.round===1))saved=true;
      if(witch&&!saved&&this.potions.poison&&w.poison!==null&&w.poison!==undefined&&w.poison!==''){const t=Number(w.poison);if(this.players[t]?.alive&&t!==witch.id)poisoned=t}
      const witchState=this.witchOptions(victim),rejected=[];
      if(witch&&!saved&&w.save)rejected.push(!this.potions.save?'save-spent':victim===null?'no-victim':victim===witch.id&&this.round!==1?'self-save-forbidden':'invalid-save');
      if(witch&&!saved&&poisoned===null&&w.poison!==null&&w.poison!==undefined&&w.poison!=='')rejected.push(!this.potions.poison?'poison-spent':'invalid-poison');
      const witchOutcome={type:saved?'save':poisoned!==null?'poison':'none',reasons:saved||poisoned!==null?[]:rejected.length?rejected:!this.potions.save&&!this.potions.poison?['potions-spent']:victim===null?['no-victim','unused']:['unused']};
      return {victim,saved,guardTarget,poisoned,guardId:guard?.id??null,witchId:witch?.id??null,seerCheck,witchState,witchOutcome};
    }
    resolveNight(choices={},fixedVictim){
      const plan=this.nightPlan(choices,fixedVictim),{victim,saved,guardTarget,poisoned,seerCheck}=plan;
      this.lastGuard=guardTarget;if(saved)this.potions.save=false;if(poisoned!==null)this.potions.poison=false;
      if(seerCheck){this.knowledge[seerCheck.id]||={};this.knowledge[seerCheck.id][seerCheck.target]=seerCheck.result}
      const deaths=new Map();if(victim!==null&&!saved&&guardTarget!==victim)deaths.set(victim,'wolf');if(poisoned!==null)deaths.set(poisoned,'poison');for(const [id,cause]of deaths){this.players[id].alive=false;this.players[id].cause=cause}
      this.phase='discussion';this.speeches=[];this.event(deaths.size?`天亮了。${[...deaths.keys()].map(i=>`${i+1} 号`).join('、')}玩家昨夜出局。`:'天亮了。昨夜是平安夜。');
      const hunter=[...deaths].find(([id,cause])=>this.players[id].role==='猎人'&&cause!=='poison');if(hunter){this.pendingHunter=hunter[0];this.afterHunter='discussion';this.phase='hunter';this.event('猎人出局，可选择是否发动技能。')}else this.checkWinner();return {...plan,deaths:[...deaths.keys()]}
    }
    addSpeech(id,text){if(this.phase!=='discussion')throw Error('当前不是发言阶段');if(!this.players[id]?.alive)throw Error('出局玩家不能发言');this.recordSpeech(id,text);}
    recordSpeech(id,text){const entry={id,text:limitSpeech(text),round:this.round,pk:!!this.pk};this.speeches.push(entry);this.speechHistory.push(entry)}
    legalTargets(id,task){const p=this.players[id];if(task==='vote'&&this.pk?.includes(id))return [];return this.alive().filter(t=>{
      if(task==='night'&&p.role==='狼人')return true;
      if(task==='night'&&p.role==='守卫')return t.id!==this.lastGuard;
      if(t.id===id)return false;
      if(task==='vote'&&this.pk)return this.pk.includes(t.id);
      return true;
    }).map(t=>t.id+1)}
    openVoting(){if(this.phase!=='discussion')throw Error('当前不是发言阶段');this.phase='voting';this.votes={};this.pk=null;this.voteRound=0;this.event('开始公开投票。可弃票。')}
    normalizedVote(id,value){
      if(value===null||value===undefined||value===''||this.pk?.includes(id)||!this.players[id]?.alive)return null;
      const target=Number(value);return this.legalTargets(id,'vote').includes(target+1)?target:null;
    }
    resolveVotes(votes){if(this.phase!=='voting')throw Error('当前不是投票阶段');const counts={};this.votes={};for(const p of this.alive()){const t=this.normalizedVote(p.id,votes[p.id]);this.votes[p.id]=t;if(t!==null)counts[t]=(counts[t]||0)+1}const max=Math.max(0,...Object.values(counts));const top=Object.keys(counts).filter(i=>counts[i]===max).map(Number);this.event('票型：'+this.alive().map(p=>`${p.id+1}→${this.votes[p.id]===null?'弃票':this.votes[p.id]+1}`).join('，'));
      if(top.length>1&&this.voteRound===0){this.pk=top;this.voteRound=1;this.event(`${top.map(i=>i+1).join('、')} 号平票，进入 PK 发言与第二轮投票。`);return {tie:true,pk:top}}
      this.pk=null;if(top.length===1){const p=this.players[top[0]];p.alive=false;p.cause='vote';this.event(`${p.id+1} 号玩家被投票放逐。`);if(p.role==='猎人'){this.pendingHunter=p.id;this.afterHunter='night';this.phase='hunter';this.event('猎人可选择开枪。');return {eliminated:p.id,hunter:true}}}else this.event('本轮无人被放逐。');if(!this.checkWinner())this.nextNight();return {eliminated:top.length===1?top[0]:null}
    }
    shoot(target){if(this.phase!=='hunter')throw Error('当前没有猎人技能');if(target!==null&&target!==undefined){const p=this.players[Number(target)];if(p?.alive){p.alive=false;p.cause='hunter';this.event(`猎人带走了 ${p.id+1} 号玩家。`)}}else this.event('猎人放弃开枪。');this.pendingHunter=null;if(!this.checkWinner()){if(this.afterHunter==='night')this.nextNight();else this.phase='discussion'}}
    nextNight(){this.round++;this.phase='night';this.speeches=[];this.event(`第 ${this.round} 夜开始。`)}
    context(id, names = [], { includeAllSpeeches = false, includeAllPublicEvents = false, recentSpeechRounds = null } = {}) {
      const player = this.players[id];
      // recentSpeechRounds keeps every speech from the latest N rounds (current round included).
      const speeches = includeAllSpeeches
        ? this.speechHistory
        : Number.isInteger(recentSpeechRounds) && recentSpeechRounds > 0
          ? this.speechHistory.filter(item => item.round > this.round - recentSpeechRounds)
          : this.speechHistory.slice(-120);
      const events = includeAllPublicEvents ? this.logs : this.logs.slice(-16);
      return {
        seat: id + 1,
        name: names[id] || String(id + 1) + '号',
        role: player.role,
        phase: this.phase,
        round: this.round,
        alive: player.alive,
        players: this.players.map(item => ({
          seat: item.id + 1,
          name: names[item.id] || String(item.id + 1) + '号',
          alive: item.alive
        })),
        wolfTeammates: player.role === '狼人'
          ? this.players.filter(item => item.role === '狼人' && item.id !== id).map(item => item.id + 1)
          : undefined,
        checks: Object.fromEntries(Object.entries(player.role === '预言家' ? this.knowledge[id] || {} : {})
          .map(([seat, result]) => [Number(seat) + 1, result])),
        potions: player.role === '女巫' ? this.potions : undefined,
        lastGuard: player.role === '守卫' ? (this.lastGuard === null ? null : this.lastGuard + 1) : undefined,
        pk: this.pk?.map(item => item + 1),
        speeches: speeches.map(item => ({ seat: item.id + 1, text: item.text, round: item.round, pk: item.pk })),
        publicEvents: events.map(event => ({ round: event.round, phase: event.phase, text: event.text }))
      };
    }
  }
  return {Game,ROLES,ORDER,RULES};
});


