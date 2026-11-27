(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NightfallObserver=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const seat=id=>`${id+1} 号`;
  const limits=typeof globalThis!=='undefined'&&globalThis.NightfallLimits?globalThis.NightfallLimits:null;
  function readingTime(text){const chars=limits?.unicodeLength?limits.unicodeLength(text):Array.from(String(text??'')).length;return Math.max(4000,Math.min(limits?.SPEECH_READING_MAX_MS??280000,chars*200))}
  // Short subtitle windows, with punctuation contributing a little breathing room.
  function speechSegments(text){
    const chars=Array.from(String(text)),parts=[];let chunk='',start=0,offset=0;
    for(const char of chars){
      chunk+=char;offset+=char.length;
      if(/[，。！？；：、,.!?;:\n]/u.test(char)||Array.from(chunk).length>=16){parts.push({text:chunk,start,end:offset});chunk='';start=offset}
    }
    if(chunk)parts.push({text:chunk,start,end:offset});
    return parts.map(p=>({...p,weight:Array.from(p.text).reduce((n,c)=>n+(/[。！？.!?\n]/u.test(c)?2.2:/[，；：、,;:]/u.test(c)?1.5:1),0)}));
  }
  function captionFrame(parts,progress=0,charIndex=null){
    if(!parts.length)return {text:'',index:0};
    let index=0,fraction=0;
    if(charIndex!=null){
      index=parts.findIndex(p=>charIndex<=p.end);if(index<0)index=parts.length-1;
      const p=parts[index];return {index,text:p.text.slice(0,Math.max(1,charIndex-p.start))};
    }
    let at=Math.max(0,Math.min(1,Number(progress)||0))*parts.reduce((n,p)=>n+p.weight,0);
    for(let i=0;i<parts.length;i++){index=i;if(at<parts[i].weight||i===parts.length-1){fraction=Math.min(1,at/parts[i].weight);break}at-=parts[i].weight}
    const chars=Array.from(parts[index].text);
    return {index,text:chars.slice(0,Math.max(1,Math.ceil(chars.length*fraction))).join('')};
  }
  function nightSummary(r){
    const parts=[];
    if(r.guardId!=null)parts.push(`${seat(r.guardId)}守卫${r.guardTarget==null?'选择空守':`守护了 ${seat(r.guardTarget)}`}`);
    parts.push(r.victim==null?'狼人没有形成有效狼刀目标':`狼人最终选择袭击 ${seat(r.victim)}`);
    if(r.seerCheck)parts.push(`${seat(r.seerCheck.id)}预言家查验 ${seat(r.seerCheck.target)}，结果是${r.seerCheck.result}`);
    if(r.witchId!=null)parts.push(`${seat(r.witchId)}女巫${r.saved?`使用解药救下 ${seat(r.victim)}`:r.poisoned!=null?`对 ${seat(r.poisoned)} 使用毒药`:'未使用药水'}`);
    return parts.join('。')+'。';
  }
  function nightAction(role,r,actors=[]){
    const actor=actors[0]??null,common={private:true,actors,round:r.round,phase:'night',publicText:''};
    if(role==='守卫')return {...common,kind:'guard',target:r.guardTarget,godText:`${seat(actor)}守卫${r.guardTarget==null?'选择空守。':`选择守护 ${seat(r.guardTarget)}，最终保护结果在天亮结算。`}`};
    if(role==='狼人'){
      if(!r.wolfChoices)return {...common,kind:'wolf',target:r.victim,godText:r.victim==null?'狼人没有形成有效的袭击目标。':`狼人选择袭击 ${seat(r.victim)}。是否出局，还要看接下来的守护和用药。`};
      const wolfChoices=r.wolfChoices.map(c=>({...c})),counts={};
      for(const c of wolfChoices)if(c.status==='selected')counts[c.target]=(counts[c.target]||0)+1;
      const max=Math.max(0,...Object.values(counts)),tied=Object.values(counts).filter(n=>n===max).length>1;
      const describe=choices=>choices.map(c=>`${seat(c.id)}狼人${c.status==='selected'?`选择袭击 ${seat(c.target)}`:c.status==='abstained'?'放弃袭击':'未形成有效选择'}`).join('，');
      const firstRound=r.firstRoundChoices?`第一轮选择。${describe(r.firstRoundChoices)}。`:'';
      const roundLabel=r.wolfRound===2?'第二轮最终选择。':'第一轮独立选择。';
      const detail=describe(wolfChoices);
      const decision=r.victim==null?'狼人没有形成有效的袭击目标。':`${r.wolfRound===2&&tied?'第二轮票数相同，按规则随机确定':'狼队确定'}今晚袭击 ${seat(r.victim)}。最终是否出局，还要看守护和用药。`;
      return {...common,kind:'wolf',target:r.victim,wolfChoices,firstRoundChoices:r.firstRoundChoices?.map(c=>({...c})),godText:firstRound+roundLabel+detail+'。'+decision};
    }
    if(role==='预言家')return {...common,kind:'seer',target:r.seerCheck?.target??null,godText:r.seerCheck?`${seat(actor)}预言家查验 ${seat(r.seerCheck.target)}，结果是${r.seerCheck.result}。这条信息只有预言家知道。`:`${seat(actor)}预言家本夜未完成有效查验。`};
    if(role==='女巫'){
      const reasons={'save-spent':'解药已经用完，本次救援未生效','no-victim':'今晚没有有效的狼刀目标，不能使用解药','self-save-forbidden':'仅首夜可以自救，本次自救未生效','invalid-save':'本次解药选择不符合规则，未生效','poison-spent':'毒药已经用完，本次投毒未生效','invalid-poison':'毒药目标必须是其他存活玩家，本次选择未生效','potions-spent':'解药和毒药均已用完','unused':'本夜选择保留药水'};
      const explanation=(r.witchOutcome?.reasons||[]).map(k=>reasons[k]).filter(Boolean).join('；');
      return {...common,kind:r.saved?'save':r.poisoned!=null?'poison':'witch-idle',target:r.saved?r.victim:r.poisoned,witchState:r.witchState,witchOutcome:r.witchOutcome,godText:r.saved?`${seat(actor)}女巫对 ${seat(r.victim)} 使用解药，抵挡本夜的狼刀。解药已用完，毒药${r.witchState?.poisonAvailable===false?'也已用完':'仍然保留，本夜不能再使用'}。最终存亡在天亮统一公布。`:r.poisoned!=null?`${seat(actor)}女巫对 ${seat(r.poisoned)} 使用毒药。毒药无视守护，使用后耗尽，本夜不能再使用解药。最终结果在天亮结算。`:`${seat(actor)}女巫本夜没有使用药水。${explanation?explanation+'。':''}`};
    }
    return null;
  }
  function nightCue(role,round,actors=[],witchState=null){
    const commands={'守卫':'守卫请睁眼，请选择今晚守护的对象。','狼人':'狼人请睁眼，狼人请杀人，请共同选择今晚袭击的对象。','预言家':'预言家请睁眼，请选择今晚查验的对象。','女巫':'女巫请睁眼，请决定是否使用解药或毒药。'};
    let text=commands[role];
    if(role==='女巫'&&witchState){
      const w=witchState;
      text=`女巫请睁眼。${seat(actors[0])}女巫，${w.victim===null?'今晚狼人没有形成有效的袭击目标。':`上帝视角可见，今晚 ${seat(w.victim)} 遭到狼人袭击。`}解药${w.saveAvailable?'剩余一瓶':'已用完'}，毒药${w.poisonAvailable?'剩余一瓶':'已用完'}。${!w.saveAvailable?'解药耗尽后，女巫本人不再获知狼刀目标。':''}${w.selfSaveAllowed?'今晚是首夜，允许使用解药自救。':'仅首夜可以自救，今晚不能自救。'}${!w.saveAvailable&&!w.poisonAvailable?'本夜已无药可用。':'每晚最多使用一瓶药，请决定救人、使用毒药或不用药。'}`;
    }
    return {kind:'night-cue',private:true,round,phase:'night',actors,publicText:'',godText:text};
  }
  function voteReveal(id,target,round,voteRound){
    const text=target==null?`${seat(id)}玩家弃票。`:`${seat(id)}玩家投给 ${seat(target)}。`;
    return {kind:'vote-reveal',round,voteRound,phase:'voting',voter:id,target,publicText:text,godText:text};
  }
  function commentary(log,night){
    let text=log.text,detail='',kind='phase';
    if(/夜开始/.test(text)){kind='night';if(!/天黑请闭眼/.test(text))text+='天黑请闭眼。';detail=' 夜间角色将依次秘密行动，白天再公布出局结果。'}
    else if(/^天亮了/.test(text)){kind='dawn';text=text.replace(/^天亮了。/,'天亮了，请睁眼。');detail=' 接下来先处理技能与胜负，再由存活玩家依次发言。'}
    else if(/开始公开投票/.test(text)){kind='voting';detail=' 每位存活玩家可以投票或弃票，不能投自己。'}
    else if(/进入 PK/.test(text)){kind='pk';detail=' 平票玩家补充发言，随后由其他存活玩家再次投票。'}
    else if(/无人被放逐/.test(text)){kind='exile';detail=' 本轮没有玩家因投票出局。'}
    else if(/被投票放逐/.test(text)){kind='exile';detail=' 接下来会先处理出局技能和胜负，再决定是否进入下一夜。'}
    else if(/猎人开枪带走/.test(text)){kind='hunter-result';detail=' 出局结算继续进行。'}
    else if(/出局结算开始/.test(text)){kind='exile';detail=' 正在按统一流程结算出局状态与技能。'}
    else if(/阵营获胜/.test(text)){kind='winner';detail=' 本局结束，所有玩家身份现已揭晓。'}
    if(/^票型/.test(text))return null;
    return {kind,round:log.round,phase:log.phase,publicText:text+detail,godText:text+detail+(night&&!night.narrated?' '+nightSummary(night):''),...(night?{result:night}:{})};
  }
  function project(event,mode){return mode==='god'?event.godText:event.private?'':event.publicText}
  return {readingTime,speechSegments,captionFrame,nightSummary,nightAction,nightCue,voteReveal,commentary,project};
});

