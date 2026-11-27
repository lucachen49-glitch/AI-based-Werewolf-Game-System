(function(root,factory){const api=factory(root.NightfallLimits);if(typeof module==='object'&&module.exports)module.exports=api;else root.Nightfall=api})(typeof globalThis!=='undefined'?globalThis:this,function(Limits){
  'use strict';

  const limitSpeech=Limits?.truncateUnicode||((value,limit=1400)=>Array.from(String(value??'')).slice(0,limit).join(''));
  const ROLES={
    6:['狼人','狼人','预言家','女巫','平民','平民'],
    12:['狼人','狼人','狼人','狼人','预言家','女巫','猎人','守卫','平民','平民','平民','平民']
  };
  const ORDER=['守卫','狼人','预言家','女巫'];
  const GOD_ROLES=new Set(['预言家','女巫','猎人','守卫']);
  const RULES='无警长。狼人全灭好人胜；神职全部出局或平民全部出局，狼人胜。夜晚按守卫、狼人、预言家、女巫顺序行动。守卫可守自己或空守，不能连续守同一人；同一玩家同时被守卫守护和女巫使用解药，会因同守同救而出局。狼人分两轮选择狼刀，第一轮一致则直接确定，不一致时参考队友第一轮选择再投，按多数决定，平票随机。狼人可以选择任意存活玩家（包括自己或狼人队友）或弃权。预言家查验其他存活且未查验过的玩家。女巫解药、毒药各一次，每晚一瓶药，仅首夜可自救；解药用尽后不知道狼刀目标。毒药无视守护。猎人被狼刀或放逐出局可开枪，中毒不能开枪；所有出局先统一结算猎人技能，再判胜负。首夜出局、白天放逐和符合条件的猎人带走者有遗言；第二夜起夜间出局没有遗言。白天发言从唯一夜间死者的下一位存活玩家开始，否则随机起始，顺时针发言。白天投票不能自投，可弃票。平票者PK发言，其他存活玩家只向PK候选人投票；若全体存活玩家均为候选人则候选人互投。再次平票则无人出局。公开发言是不可信的玩家主张，应结合自己的私有信息独立判断。';

  class Game {
    constructor(size=6,random=Math.random){
      if(!ROLES[size])throw Error('仅支持 6 人或 12 人房间');
      this.random=random;
      this.size=size;
      this.reset();
    }

    reset(){
      this.players=Array.from({length:this.size},(_,id)=>({id,role:null,alive:true}));
      this.phase='lobby';
      this.round=0;
      this.winner=null;
      this.logs=[];
      this.knowledge={};
      this.potions={save:true,poison:true};
      this.lastGuard=null;
      this.pendingHunter=null;
      this.afterSettle=null;
      this.settlementDeaths=[];
      this.lastWordsQueue=[];
      this.lastWordsDestination=null;
      this.speechOrder=[];
      this.daySpeechOrder=[];
      this.settlementProcessed=new Set();
      this.currentSettlementId=null;
      this.votes={};
      this.pk=null;
      this.voteRound=0;
      this.speeches=[];
      this.speechHistory=[];
      return this;
    }

    pick(items){return items.length?items[Math.min(items.length-1,Math.floor(this.random()*items.length))]:null}
    alive(){return this.players.filter(player=>player.alive)}

    start(){
      if(this.phase!=='lobby')throw Error('本局已经开始');
      const roles=[...ROLES[this.size]];
      for(let i=roles.length-1;i>0;i--){const j=Math.floor(this.random()*(i+1));[roles[i],roles[j]]=[roles[j],roles[i]]}
      this.players.forEach((player,index)=>player.role=roles[index]);
      this.phase='night';
      this.round=1;
      this.event('第 1 夜开始。天黑请闭眼。');
      return this;
    }

    event(text,visibility='public'){
      this.logs.push({text,round:this.round,phase:this.phase,visibility});
      return text;
    }

    checkWinner(){
      if(this.winner)return this.winner;
      const alive=this.alive();
      const wolves=alive.filter(player=>player.role==='狼人').length;
      const gods=alive.filter(player=>GOD_ROLES.has(player.role)).length;
      const villagers=alive.filter(player=>player.role==='平民').length;
      if(wolves===0)this.winner='好人';
      else if(gods===0||villagers===0)this.winner='狼人';
      if(this.winner){
        this.phase='ended';
        this.event(`${this.winner}阵营获胜。`);
      }
      return this.winner;
    }

    wolfChoices(choices={}){
      return this.alive().filter(player=>player.role==='狼人').map(player=>{
        const raw=choices[player.id]?.target;
        const id=raw===null||raw===undefined||raw===''?null:Number(raw);
        const target=id===null?null:this.players[id];
        const valid=!!target?.alive;
        return {id:player.id,target:valid?id:null,status:valid?'selected':raw===null?'abstained':'invalid'};
      });
    }

    wolfConsensus(choices={}){
      const selections=this.wolfChoices(choices);
      const valid=selections.every(choice=>choice.status==='selected'||choice.status==='abstained');
      const votes=selections.map(choice=>choice.status==='selected'?choice.target:null);
      const unanimous=valid&&votes.length>0&&votes.every(target=>target===votes[0]);
      return {unanimous,target:unanimous?votes[0]:null};
    }

    wolfTarget(choices={}){
      const counts={};
      for(const choice of this.wolfChoices(choices))if(choice.status==='selected')counts[choice.target]=(counts[choice.target]||0)+1;
      const max=Math.max(0,...Object.values(counts));
      const leaders=Object.keys(counts).filter(id=>counts[id]===max).map(Number);
      return leaders.length>1?this.pick(leaders):leaders[0]??null;
    }

    witchOptions(victim){
      const witch=this.alive().find(player=>player.role==='女巫');
      return {witchId:witch?.id??null,victim,saveAvailable:this.potions.save,poisonAvailable:this.potions.poison,selfSaveAllowed:this.round===1,canSave:!!witch&&this.potions.save&&victim!==null&&(victim!==witch.id||this.round===1)};
    }

    nightPlan(choices={},fixedVictim){
      if(this.phase!=='night')throw Error('当前不在夜间');
      let victim=fixedVictim===undefined?this.wolfTarget(choices):fixedVictim;
      if(!this.players[victim]?.alive)victim=null;

      const guard=this.alive().find(player=>player.role==='守卫');
      let guardTarget=guard?choices[guard.id]?.target:null;
      guardTarget=guardTarget===null||guardTarget===undefined||guardTarget===''?null:Number(guardTarget);
      if(!this.players[guardTarget]?.alive||guardTarget===this.lastGuard)guardTarget=null;

      let seerCheck=null;
      const seer=this.alive().find(player=>player.role==='预言家');
      if(seer){
        const raw=choices[seer.id]?.target;
        const target=raw===null||raw===undefined||raw===''?NaN:Number(raw);
        const alreadyChecked=this.knowledge[seer.id]?.[target]!==undefined;
        if(this.players[target]?.alive&&target!==seer.id&&!alreadyChecked){
          seerCheck={id:seer.id,target,result:this.players[target].role==='狼人'?'狼人':'好人'};
        }
      }

      const witch=this.alive().find(player=>player.role==='女巫');
      const action=witch?choices[witch.id]||{}:{};
      let saved=false,poisoned=null;
      if(witch&&action.save&&this.potions.save&&victim!==null&&(victim!==witch.id||this.round===1))saved=true;
      if(witch&&!saved&&this.potions.poison&&action.poison!==null&&action.poison!==undefined&&action.poison!==''){
        const target=Number(action.poison);
        if(this.players[target]?.alive&&target!==witch.id)poisoned=target;
      }

      const witchState=this.witchOptions(victim),rejected=[];
      if(witch&&!saved&&action.save)rejected.push(!this.potions.save?'save-spent':victim===null?'no-victim':victim===witch.id&&this.round!==1?'self-save-forbidden':'invalid-save');
      if(witch&&!saved&&poisoned===null&&action.poison!==null&&action.poison!==undefined&&action.poison!=='')rejected.push(!this.potions.poison?'poison-spent':'invalid-poison');
      const witchOutcome={
        type:saved?'save':poisoned!==null?'poison':'none',
        reasons:saved||poisoned!==null?[]:rejected.length?rejected:!this.potions.save&&!this.potions.poison?['potions-spent']:victim===null?['no-victim','unused']:['unused']
      };
      return {victim,saved,guardTarget,poisoned,guardId:guard?.id??null,witchId:witch?.id??null,seerCheck,witchState,witchOutcome,doubleProtection:saved&&guardTarget===victim};
    }

    resolveNight(choices={},fixedVictim){
      const plan=this.nightPlan(choices,fixedVictim);
      const {victim,saved,guardTarget,poisoned,seerCheck}=plan;
      this.lastGuard=guardTarget;
      if(saved)this.potions.save=false;
      if(poisoned!==null)this.potions.poison=false;
      if(seerCheck){
        this.knowledge[seerCheck.id]||={};
        this.knowledge[seerCheck.id][seerCheck.target]=seerCheck.result;
      }

      const deaths=new Map();
      const guarded=victim!==null&&guardTarget===victim;
      if(victim!==null&&((!saved&&!guarded)||(saved&&guarded)))deaths.set(victim,'wolf');
      if(poisoned!==null)deaths.set(poisoned,'poison');
      const orderedDeaths=[...deaths.keys()].sort((a,b)=>a-b);
      for(const id of orderedDeaths){
        this.players[id].alive=false;
        this.players[id].cause=deaths.get(id);
      }

      this.settlementDeaths=[...orderedDeaths];
      this.pendingHunter=null;
      this.settlementProcessed=new Set();
      this.currentSettlementId=null;
      this.afterSettle='discussion';
      this.lastWordsQueue=this.round===1?[...orderedDeaths]:[];
      this.lastWordsDestination='discussion';
      this.phase='settle';
      this.event(orderedDeaths.length?`天亮了。${orderedDeaths.map(id=>`${id+1} 号`).join('、')}玩家昨夜出局。`:'天亮了。昨夜是平安夜。');
      if(orderedDeaths.length)this.event('出局结算开始。');

      if(!orderedDeaths.length){
        this.lastWordsQueue=[];
        this.continueAfterSettle();
      }
      return {...plan,deaths:orderedDeaths,settlement:orderedDeaths.length>0};
    }

    beginSettlement(afterSettle,deaths,lastWords){
      this.settlementDeaths=[...new Set(deaths)].sort((a,b)=>a-b);
      this.pendingHunter=null;
      this.settlementProcessed=new Set();
      this.currentSettlementId=null;
      this.afterSettle=afterSettle;
      this.lastWordsQueue=lastWords?[...this.settlementDeaths]:[];
      this.lastWordsDestination=afterSettle;
      this.phase='settle';
      this.event('出局结算开始。');
    }

    settlementStep(){
      if(this.phase!=='settle')throw Error('当前不在出局结算阶段');
      if(this.currentSettlementId!==null){
        const id=this.currentSettlementId;
        return {id,hunter:this.pendingHunter===id};
      }
      const id=this.settlementDeaths.find(seat=>!this.settlementProcessed.has(seat));
      if(id===undefined)return null;
      this.currentSettlementId=id;
      const player=this.players[id];
      this.pendingHunter=player.role==='猎人'&&['wolf','vote'].includes(player.cause)?id:null;
      return {id,hunter:this.pendingHunter===id};
    }

    resolveSettlement(target=null){
      const step=this.settlementStep();
      if(!step)throw Error('没有待处理的出局结算步骤');
      const hunterId=this.pendingHunter;
      if(hunterId!==null&&target!==null&&target!==undefined){
        const victimId=Number(target);
        const victim=this.players[victimId];
        if(this.legalTargets(hunterId,'hunter').includes(victimId+1)&&victim?.alive){
          const hunterCanSpeak=this.lastWordsQueue.includes(hunterId);
          victim.alive=false;
          victim.cause='hunter';
          this.settlementDeaths.push(victim.id);
          if(hunterCanSpeak)this.lastWordsQueue.push(victim.id);
          this.event((hunterId+1)+' 号猎人开枪带走 '+(victim.id+1)+' 号玩家。');
        }
      }else if(hunterId!==null){
        this.event('猎人放弃开枪。','private');
      }
      this.settlementProcessed.add(step.id);
      this.pendingHunter=null;
      this.currentSettlementId=null;
      this.settlementDeaths=[...new Set(this.settlementDeaths)].sort((a,b)=>a-b);
      this.lastWordsQueue=[...new Set(this.lastWordsQueue)].sort((a,b)=>a-b);
      if(this.settlementDeaths.some(id=>!this.settlementProcessed.has(id)))return {winner:null,next:true,lastWords:[]};

      if(this.checkWinner()){
        this.lastWordsQueue=[];
        this.lastWordsDestination=null;
        return {winner:this.winner,lastWords:[]};
      }
      if(this.lastWordsQueue.length){
        this.phase='lastWords';
        return {winner:null,lastWords:[...this.lastWordsQueue]};
      }
      this.continueAfterSettle();
      return {winner:null,lastWords:[]};
    }

    shoot(target){return this.resolveSettlement(target)}

    continueAfterSettle(){
      const destination=this.lastWordsDestination||this.afterSettle;
      this.pendingHunter=null;
      this.afterSettle=null;
      this.lastWordsDestination=null;
      this.lastWordsQueue=[];
      if(destination==='discussion'){
        this.phase='discussion';
        this.speeches=[];
        this.speechOrder=this.makeSpeechOrder(this.settlementDeaths);
        this.daySpeechOrder=[...this.speechOrder];
      }else if(destination==='night'){
        this.nextNight();
      }else if(this.phase!=='ended'){
        this.phase='discussion';
        this.speechOrder=this.makeSpeechOrder(this.settlementDeaths);
        this.daySpeechOrder=[...this.speechOrder];
      }
    }

    makeSpeechOrder(deaths=[]){
      const aliveIds=this.alive().map(player=>player.id);
      if(!aliveIds.length)return [];
      let start;
      if(deaths.length===1){
        start=(deaths[0]+1)%this.size;
        while(!this.players[start].alive)start=(start+1)%this.size;
      }else start=this.pick(aliveIds);
      return Array.from({length:this.size},(_,offset)=>(start+offset)%this.size).filter(id=>this.players[id].alive);
    }

    addSpeech(id,text){
      if(this.phase!=='discussion')throw Error('当前不是发言阶段');
      if(!this.players[id]?.alive)throw Error('出局玩家不能发言');
      this.recordSpeech(id,text);
    }

    recordSpeech(id,text){
      const entry={id,text:limitSpeech(text),round:this.round,pk:!!this.pk,lastWords:false};
      this.speeches.push(entry);
      this.speechHistory.push(entry);
      if(!this.pk&&this.speechOrder[0]===id)this.speechOrder.shift();
      return entry;
    }

    addLastWord(id,text){
      if(this.phase!=='lastWords')throw Error('当前不是遗言阶段');
      if(this.lastWordsQueue.length===0||this.lastWordsQueue[0]!==id)throw Error('当前不是该玩家的遗言顺序');
      const entry={id,text:limitSpeech(text),round:this.round,pk:false,lastWords:true};
      this.speeches.push(entry);
      this.speechHistory.push(entry);
      this.lastWordsQueue.shift();
      return entry;
    }

    openVoting(){
      if(this.phase!=='discussion')throw Error('当前不是讨论阶段');
      this.phase='voting';
      this.voteRound=0;
      this.pk=null;
      this.event('开始公开投票。');
      return this;
    }

    finishLastWords(){
      if(this.phase!=='lastWords')throw Error('当前不是遗言阶段');
      if(this.lastWordsQueue.length)throw Error('仍有玩家尚未发表遗言');
      this.continueAfterSettle();
    }

    canVote(id){
      if(!this.players[id]?.alive)return false;
      if(!this.pk?.includes(id))return true;
      const aliveIds=this.alive().map(player=>player.id);
      return this.pk.length===aliveIds.length&&this.pk.every(candidate=>aliveIds.includes(candidate));
    }

    legalTargets(id,task){
      const player=this.players[id];
      if(!player)return [];
      if(task==='hunter'){
        if(this.phase!=='settle'||this.pendingHunter!==id)return [];
        return this.alive().filter(target=>target.id!==id).map(target=>target.id+1);
      }
      if(task==='vote'&&!this.canVote(id))return [];
      return this.alive().filter(target=>{
        if(task==='night'&&player.role==='狼人')return true;
        if(task==='night'&&player.role==='守卫')return target.id!==this.lastGuard;
        if(task==='night'&&player.role==='预言家')return target.id!==id&&this.knowledge[id]?.[target.id]===undefined;
        if(target.id===id)return false;
        if(task==='vote'&&this.pk)return this.pk.includes(target.id);
        return true;
      }).map(target=>target.id+1);
    }

    normalizedVote(id,value){
      if(value===null||value===undefined||value===''||!this.canVote(id))return null;
      const target=Number(value);
      return this.legalTargets(id,'vote').includes(target+1)?target:null;
    }

    resolveVotes(votes){
      if(this.phase!=='voting')throw Error('当前不是投票阶段');
      const counts={};
      this.votes={};
      for(const player of this.alive()){
        const target=this.normalizedVote(player.id,votes[player.id]);
        this.votes[player.id]=target;
        if(target!==null)counts[target]=(counts[target]||0)+1;
      }
      const max=Math.max(0,...Object.values(counts));
      const top=Object.keys(counts).filter(id=>counts[id]===max).map(Number);
      this.event('票型：'+this.alive().map(player=>`${player.id+1}→${this.votes[player.id]===null?'弃票':this.votes[player.id]+1}`).join('，'));
      if(top.length>1&&this.voteRound===0){
        this.pk=top;
        this.voteRound=1;
        this.event(`${top.map(id=>id+1).join('、')} 号平票，进入 PK 发言与第二轮投票。`);
        return {tie:true,pk:top};
      }

      this.pk=null;
      if(top.length===1){
        const player=this.players[top[0]];
        player.alive=false;
        player.cause='vote';
        this.event(`${player.id+1} 号玩家被投票放逐。`);
        this.beginSettlement('night',[player.id],true);
        return {eliminated:player.id,hunter:this.pendingHunter!==null,settlement:true};
      }

      this.event('本轮无人被放逐。');
      if(!this.checkWinner())this.nextNight();
      return {eliminated:null};
    }

    nextNight(){
      this.round++;
      this.phase='night';
      this.speeches=[];
      this.speechOrder=[];
      this.daySpeechOrder=[];
      this.event(`第 ${this.round} 夜开始。天黑请闭眼。`);
    }

    context(id,names=[],{includeAllSpeeches=false,includeAllPublicEvents=false}={}){
      const player=this.players[id];
      const speeches=includeAllSpeeches?this.speechHistory:this.speechHistory.slice(-120);
      const publicEvents=this.logs.filter(event=>event.visibility!=='private');
      const events=includeAllPublicEvents?publicEvents:publicEvents.slice(-16);
      return {
        seat:id+1,
        name:names[id]||`${id+1}号`,
        role:player.role,
        phase:this.phase,
        round:this.round,
        alive:player.alive,
        players:this.players.map(item=>({seat:item.id+1,name:names[item.id]||`${item.id+1}号`,alive:item.alive})),
        wolfTeammates:player.role==='狼人'?this.players.filter(item=>item.role==='狼人'&&item.id!==id).map(item=>item.id+1):undefined,
        checks:Object.fromEntries(Object.entries(player.role==='预言家'?this.knowledge[id]||{}:{}).map(([seat,result])=>[Number(seat)+1,result])),
        potions:player.role==='女巫'?{...this.potions}:undefined,
        lastGuard:player.role==='守卫'?(this.lastGuard===null?null:this.lastGuard+1):undefined,
        pk:this.pk?.map(item=>item+1),
        speeches:speeches.map(item=>({seat:item.id+1,text:item.text,round:item.round,pk:item.pk,...(item.lastWords?{lastWords:true}:{})})),
        publicEvents:events.map(event=>({round:event.round,phase:event.phase,text:event.text}))
      };
    }
  }

  return {Game,ROLES,ORDER,RULES};
});
