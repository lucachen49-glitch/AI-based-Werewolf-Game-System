const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const Nightfall=require('./engine.js');

// Exercise the real game controller and API adapter; inert elements do not test layout.
function setup(saved=new Map(),fixture=true,systemVoices=true,withStory=false,withPortrait=false){
  const nodes=new Map(),requests=[],calls=[],timeouts=[];
  function node(id){if(!nodes.has(id)){const classes=new Set(id.endsWith('Backdrop')?['hidden']:[]);nodes.set(id,{value:'',textContent:'',innerHTML:'',style:{},attributes:{},listeners:{},classList:{add(c){classes.add(c)},remove(c){classes.delete(c)},toggle(c,force){const on=force??!classes.has(c);on?classes.add(c):classes.delete(c);return on},contains(c){return classes.has(c)}},addEventListener(k,fn){this.listeners[k]=fn},setAttribute(k,v){this.attributes[k]=v},focus(){}})}return nodes.get(id)}
  const events={};
  if(withPortrait){for(const id of ['portraitHero','portraitFrame'])node(id).dataset={}}
  const context=vm.createContext({Nightfall,console,URL,AbortController,TextDecoder,Uint8Array,performance,location:{protocol:'http:'},setTimeout:(callback,delay)=>{timeouts.push(delay);return setTimeout(callback,delay)},clearTimeout,document:{body:node('body'),documentElement:node('html'),getElementById:node,querySelectorAll:()=>[],addEventListener(event,fn){(events[event]??=[]).push(fn)}},localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)},fetch:async(url,request)=>{calls.push({url,request});requests.push(JSON.parse(request.body));return {ok:true,json:async()=>({choices:[{message:{content:'{"target":1}'}}]})}}});
  context.NightfallManor=require('./manor.js');context.NightfallVoices=require('./voices.js');context.NightfallObserver=require('./observer.js');
  context.NightfallAgentRequest=require('./agent-request.js');context.NightfallAudio=require('./soundfx.js');context.NightfallAPIWait=require('./api-wait.js');
  vm.runInContext(fs.readFileSync('spectator.js','utf8'),context);
  if(withStory)for(const file of ['scenario.js','story-player.js','story-game.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
  // Production loads story globals before app.js; suppress only initial DOM wiring here.
  if(withStory)vm.runInContext('initStory=()=>{}',context);
  if(withPortrait){vm.runInContext(fs.readFileSync('portrait.js','utf8'),context);vm.runInContext('initPortrait=()=>{}',context)}
  vm.runInContext(fs.readFileSync('app.js','utf8'),context);
  vm.runInContext('presentationDelayScale=0',context);
  if(systemVoices)vm.runInContext("profiles.forEach(p=>{p.voiceProvider='system';p.voiceMatch='custom'})",context);
  if(fixture)vm.runInContext("size=12;game=new Nightfall.Game(12).start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[12][i]);game.phase='voting';profiles[8].control='api';profiles[8].endpoint='https://example.test/v1/chat/completions';profiles[8].model='test-model';profiles[8].key='secret-test-key';",context);
  return {context,saved,requests,calls,timeouts,events};
}

function voteStream(events){
  const encoder=new TextEncoder();
  return {ok:true,status:200,body:new ReadableStream({start(controller){for(const event of events)controller.enqueue(encoder.encode(JSON.stringify(event)+'\n'));controller.close()}})};
}
function batchCompatibleFetch(handler){
  return async(url,options)=>{
    if(url!=='/api/chat/batch')return handler(url,options);
    const requests=JSON.parse(options.body).requests;
    const events=await Promise.all(requests.map(async request=>{
      // The production adapter now sends Responses bodies. Keep this test shim
      // compatible with handlers that inspect the former Chat Completions shape.
      const legacyMessages=Array.isArray(request.input)?request.input.map(message=>({
        role:message.role,
        content:Array.isArray(message.content)&&message.content.every(part=>part?.type==='input_text')
          ?message.content.map(part=>part.text).join('\n')
          :message.content
      })):request.messages;
      const compatibilityRequest={...request,
        messages:legacyMessages,
        maxTokens:request.max_output_tokens,
        reasoningEffort:request.reasoning?.effort
      };
      const response=await handler('/api/chat',{...options,body:JSON.stringify(compatibilityRequest)}),data=await response.json();
      return {type:response.ok?'result':'error',requestId:request.requestId,seat:request.action.seat,...(response.ok?{result:data}:{error:data.error,status:response.status})};
    }));
    return voteStream([...events,{type:'complete'}]);
  };
}

function installStory(context){
  const story={id:'6a5f75cd-403a-4af2-b9d2-50519e911162',version:1,title:'测试庄园',background:'六位故人来到庄园。',confirmed:true,characters:Array.from({length:6},(_,i)=>({seat:i+1,name:'来客'+(i+1),personality:'谨慎',relationships:'公开关系'+(i+1)})),video:{jobId:'5fef8c97-8b51-48ed-ad4b-f2824d86a84c',url:'/test-intro.mp4'}};
  context.storyFixture=story;
  const video={load(){},pause(){},removeAttribute(){},playCalls:0,async play(){this.playCalls++;this.onplaying?.()}};
  context.introVideo=video;
  vm.runInContext("selectedStoryId=storyFixture.id;storyPlayer=NightfallStoryPlayer.create({video:introVideo});waitForTurn=async()=>true;revealDeal=async()=>true;runGame=async()=>{}",context);
  return {story,video};
}

test('剧情开局不依赖序幕视频；确认剧本后直接发牌且重置清理公开快照',async()=>{
  const {context}=setup(new Map(),false,true,true),{story,video}=installStory(context);let deals=0,chat=0,videoJobs=0;
  context.deal=async()=>{deals++;return true};
  context.fetch=async(url,options)=>{
    if(url==='/api/chat'){chat++;throw Error('开局不应调用 Agent')}
    if(url.startsWith('/api/video-jobs')){videoJobs++;throw Error('开局不应检查视频任务')}
    return {ok:true,json:async()=>story};
  };
  vm.runInContext('animateDeal=deal',context);
  await vm.runInContext('start()',context);
  assert.equal(deals,1);assert.equal(chat,0);assert.equal(videoJobs,0);
  assert.equal(vm.runInContext('game.phase',context),'night');
  assert.equal(vm.runInContext('sessionStory.title',context),story.title);
  assert.equal(vm.runInContext('storyPlayer.state().active',context),false);
  assert.equal(video.playCalls,0);
  vm.runInContext('reset(12)',context);
  assert.equal(vm.runInContext('sessionStory',context),null);
});

test('剧情席位立绘取自本局公开快照，重置后恢复玩家设置',()=>{
  const {context}=setup(new Map(),false,true,true),{story}=installStory(context);
  story.characters[0].portraitId='portrait-04';
  vm.runInContext("profiles[0].manorPortrait='portrait-02';sessionStory=storyFixture",context);
  assert.equal(vm.runInContext('manorPortrait(profiles[0],0).id',context),'portrait-04');
  assert.equal(vm.runInContext('profiles[0].manorPortrait',context),'portrait-02');
  vm.runInContext('reset(6)',context);
  assert.equal(vm.runInContext('manorPortrait(profiles[0],0).id',context),'portrait-02');
});

test('Agent 不接收剧本秘密且上下文缓存，角色名临时替换；12 人不加载剧本',async()=>{
  const {context,saved}=setup(new Map(),false,true,true),{story}=installStory(context);const requests=[],gets=[];
  const originalName=vm.runInContext('profiles[0].name',context),S=require('./scenario.js');
  const privateStory={...story,characters:story.characters.map((c,i)=>({...c,secret:'独有秘密'+(i+1)}))};
  context.fetch=async(url,options)=>{if(url==='/api/chat'){requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({choices:[{message:{content:'{"speech":"我是来客1，先听听大家的判断。"}'}}]})}}gets.push(url);return {ok:true,json:async()=>S.context(privateStory,Number(/context\/(\d)/.exec(url)[1]))}};
  vm.runInContext("sessionStory=storyFixture;game.start();profiles[0].control='api';profiles[0].endpoint='https://chat.test';profiles[0].model='selected-chat';profiles[0].key='test-chat-key'",context);
  await vm.runInContext("decision(0,'speech')",context);await vm.runInContext("decision(0,'speech')",context);
  assert.equal(gets.length,1);assert.match(gets[0],/context\/1\?version=1$/);
  for(const r of requests){const text=JSON.stringify(r.messages);assert.doesNotMatch(text,/独有秘密[1-6]/);assert.match(text,/来客1/)}
  assert.equal(vm.runInContext('name(0)',context),'来客1');assert.equal(vm.runInContext('profiles[0].name',context),originalName);assert.doesNotMatch(JSON.stringify([...saved]),/独有秘密/);
  vm.runInContext('reset(12);game.start()',context);await vm.runInContext("decision(0,'speech')",context);
  assert.equal(gets.length,1);assert.doesNotMatch(JSON.stringify(requests.at(-1).messages),/独有秘密|测试庄园/);
  assert.equal(vm.runInContext('name(0)',context),originalName);
});

test('重置中止剧本私有上下文请求，迟到结果不会调用聊天或污染下一局',async()=>{
  const {context}=setup(new Map(),false,true,true);installStory(context);let signal,chat=0;
  context.fetch=async(url,options)=>{if(url==='/api/chat'){chat++;throw Error('不应发送')}signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{const e=Error('取消');e.name='AbortError';reject(e)},{once:true}))};
  vm.runInContext("sessionStory=storyFixture;game.start();profiles[0].control='api';profiles[0].endpoint='https://chat.test';profiles[0].model='test'",context);
  const pending=vm.runInContext("decision(0,'speech')",context);await until(()=>!!signal);vm.runInContext('reset()',context);await pending;
  assert.equal(signal.aborted,true);assert.equal(chat,0);assert.equal(vm.runInContext('storyContexts.size',context),0);assert.equal(vm.runInContext('sessionStory',context),null);
});

test('庄园立绘旧配置按席位补全，保存恢复兼容头像、声音和独立 API 配置',()=>{
  const stored={name:'自定义访客',avatar:'🐱',control:'api',endpoint:'https://example.test',model:'my-model',key:'test-only-key',rememberKey:true,voice:'zh-CN-YunyangNeural',voiceStyle:'calm',voiceSpeed:.85};
  const saved=new Map([['nightfall-profiles-v1',JSON.stringify([stored])]]);
  const {context}=setup(saved,false,false);
  assert.equal(vm.runInContext('profiles[0].manorPortrait',context),'portrait-01');
  assert.equal(vm.runInContext('profiles[5].manorPortrait',context),'portrait-06');
  vm.runInContext("openAgent(0);$('manorPortraitInput').value='portrait-04';saveAgent()",context);
  const restored=setup(saved,false,false).context;
  for(const [key,value]of Object.entries({...stored,manorPortrait:'portrait-04'}))assert.equal(vm.runInContext('profiles[0][key]',Object.assign(restored,{key})),value,key);
  assert.doesNotMatch(JSON.stringify(vm.runInContext('spectatorExport()',restored)),/test-only-key/);
});

test('六位庄园人物默认男女音色与形象对应，自定义与12人原音色保持独立',()=>{
  const {context,saved}=setup(new Map(),false,false);
  const expected=['zh-CN-XiaoxiaoNeural','zh-CN-YunyangNeural','zh-CN-YunxiNeural','zh-CN-XiaoyiNeural','zh-CN-YunjianNeural','zh-TW-HsiaoChenNeural'];
  assert.deepEqual(Array.from(vm.runInContext('profiles.slice(0,6).map(seatVoice)',context),p=>p.voice),expected);
  const original=vm.runInContext('profiles[0].voice',context);
  vm.runInContext("openAgent(0);$('manorPortraitInput').value='portrait-05';$('manorPortraitInput').listeners.change();saveAgent()",context);
  const restored=setup(saved,false,false).context;
  assert.equal(vm.runInContext('seatVoice(profiles[0],0).voice',restored),'zh-CN-YunjianNeural');
  assert.equal(vm.runInContext('profiles[0].voice',restored),original);
  vm.runInContext("openAgent(0);$('manorPortraitInput').value='avatar';$('manorPortraitInput').listeners.change()",restored);
  assert.equal(vm.runInContext("$('playerVoiceInput').value",restored),original);
  assert.equal(vm.runInContext('modalProfile().voice',restored),original);
  vm.runInContext("reset(12)",restored);assert.equal(vm.runInContext('seatVoice(profiles[0],0).voice',restored),'zh-CN-YunjianNeural');
  vm.runInContext("reset(6);profiles[0].voiceMatch='custom';profiles[0].voice='zh-CN-XiaoyiNeural';profiles[0].manorPortrait='portrait-05'",restored);
  assert.equal(vm.runInContext('seatVoice(profiles[0],0).voice',restored),'zh-CN-XiaoyiNeural');
});

test('短字幕保留全文、逐字揭示并分句切换，边界字符不抢先跳句',()=>{
  const {speechSegments,captionFrame}=require('./observer.js'),text='先别急着投票，我们把线索对一对。下一位请说。',parts=speechSegments(text);
  assert.equal(parts.map(p=>p.text).join(''),text);assert.ok(parts.every(p=>Array.from(p.text).length<=20));
  assert.equal(captionFrame(parts,0).text,'先');assert.equal(captionFrame(parts,1).text,'下一位请说。');
  assert.equal(captionFrame(parts,0,parts[0].end).index,0);
  assert.equal(captionFrame(parts,0,parts[0].end+1).index,1);
  assert.ok(captionFrame(parts,.15).text.length<text.length);
});

test('字幕按音频进度更新，暂停冻结，重置隔离旧的播放回调',async()=>{
  const {context}=setup(new Map(),false,false),{audios}=installNatural(context);
  vm.runInContext('voiceEnabled=true',context);
  const playing=vm.runInContext("showPlayerSpeech({id:0,text:'我们先核对线索，再决定投给谁。'})",context);
  await until(()=>audios.length===1);
  audios[0].duration=8;audios[0].currentTime=3;audios[0].ontimeupdate();
  const caption=vm.runInContext('speechBubble.caption',context);assert.ok(caption.length>1);assert.ok(caption.length<18);
  vm.runInContext('busy=true;togglePause()',context);audios[0].currentTime=7;audios[0].ontimeupdate();
  assert.equal(vm.runInContext('speechBubble.caption',context),caption);
  vm.runInContext('togglePause()',context);audios[0].ontimeupdate();assert.notEqual(vm.runInContext('speechBubble.caption',context),caption);
  const old=audios[0].ontimeupdate;vm.runInContext('reset()',context);old();await playing;
  assert.equal(vm.runInContext('speechBubble',context),null);assert.equal(audios[0].ontimeupdate,null);
});

test('发牌先播放匿名卡背，完成后才开局；暂停与重置不会遗留旧动画或行动',async()=>{
  const {context}=setup(new Map(),false);let release;
  context.gate=()=>new Promise(r=>release=r);
  vm.runInContext('presentationWait=gate;turnDelay=0;voiceEnabled=false',context);
  const running=vm.runInContext('start()',context);
  assert.equal(vm.runInContext('game.phase',context),'lobby');assert.equal(vm.runInContext('busy',context),true);
  const html=vm.runInContext("$('sceneEffect').innerHTML",context);
  assert.equal((html.match(/class="deal-card"/g)||[]).length,6);assert.doesNotMatch(html,/狼人|预言家|女巫/);
  vm.runInContext('togglePause()',context);assert.equal(vm.runInContext("document.body.classList.contains('presentation-paused')",context),true);
  vm.runInContext('reset(12)',context);release(true);await running;
  assert.equal(vm.runInContext('game.phase',context),'lobby');assert.equal(vm.runInContext('sceneMotion',context),null);assert.equal(vm.runInContext('dealState',context),null);
  assert.equal(vm.runInContext("$('sceneEffect').classList.contains('hidden')",context),true);
});

test('关键事件动画与真实事件对应，公开视角不含夜间秘密，视角切换与规则介绍可清除',async()=>{
  const {context}=setup(new Map(),false);const releases=[];
  context.effectWait=()=>new Promise(r=>releases.push(r));
  vm.runInContext("presentationWait=effectWait;game.start();setPerspective('public')",context);
  for(const kind of ['night','dawn','discussion','voting','pk','exile','hunter','hunter-result','winner']){
    vm.runInContext("animateEvent({kind:'"+kind+"',round:1,publicText:'公开结果',godText:'秘密查验 1 号是狼人'},epoch)",context);
    assert.equal(vm.runInContext('sceneMotion.kind',context),kind);
    assert.doesNotMatch(vm.runInContext("$('sceneEffect').innerHTML",context),/秘密查验|1 号是狼人/);
  }
  vm.runInContext("setPerspective('god')",context);assert.equal(vm.runInContext('sceneMotion',context),null);
  for(const release of releases)release();await new Promise(setImmediate);
  assert.equal(vm.runInContext('sceneMotion',context),null);
});

test('普通发言不增加阶段节奏等待，行动仍沿用可配置节奏',async()=>{
  const {context}=setup();const delays=[];
  context.pacing=async(token,delay)=>{delays.push(delay);return true};
  vm.runInContext("waitForTurn=pacing;turnDelay=1200;decision=async()=>({speech:'公开陈述'})",context);
  await vm.runInContext("takeTurn(0,'speech','发言',epoch)",context);
  await vm.runInContext("takeTurn(0,'vote','投票',epoch)",context);
  assert.deepEqual(delays,[0,0,1200,0]);
});

test('6 人间支持立绘与原头像，12 人间使用独立庄园布局且切换不改变配置',()=>{
  const {context}=setup(new Map(),false);
  assert.equal((vm.runInContext("$('playersGrid').innerHTML",context).match(/class="manor-portrait"/g)||[]).length,6);
  vm.runInContext("profiles[1].manorPortrait='avatar';renderPlayers()",context);
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/manor-avatar-fallback/);
  vm.runInContext('reset(12)',context);
  assert.equal((vm.runInContext("$('playersGrid').innerHTML",context).match(/manor-nameplate/g)||[]).length,12);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML",context),/portrait-pending/);assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/portrait-12.webp/);
  assert.equal(vm.runInContext("$('tableScene').classList.contains('manor-twelve')",context),true);
  assert.equal(vm.runInContext("$('tableScene').classList.contains('manor-six')",context),false);
  assert.equal(vm.runInContext("document.body.classList.contains('manor-mode')",context),true);
  vm.runInContext('reset(6)',context);
  assert.equal(vm.runInContext('profiles[1].manorPortrait',context),'avatar');
  assert.equal(vm.runInContext("$('tableScene').classList.contains('manor-six')",context),true);
});

test('庄园人物不跟随身份改变，普通夜间隐藏身份、行动与连接提示，终局才揭晓',()=>{
  const {context}=setup(new Map(),false);
  vm.runInContext("game.start();game.phase='night';activeSeat=0;profiles[0].control='api';profiles[0].connection='testing';setPerspective('public')",context);
  let html=vm.runInContext("$('playersGrid').innerHTML",context);
  assert.doesNotMatch(html,/狼人|预言家|女巫|思考中|acting|API 连接中/);
  assert.equal((html.match(/身份未知/g)||[]).length,6);
  assert.match(html,/portrait-01.webp/);
  vm.runInContext("game.players[0].role='预言家';game.phase='ended';renderPlayers()",context);
  html=vm.runInContext("$('playersGrid').innerHTML",context);
  assert.match(html,/预言家/);assert.match(html,/portrait-01.webp/);
});

test('立绘加载失败立即使用原头像，记录缩略图跟随席位，失效 ID 不发起外部请求',()=>{
  const {context,events}=setup(new Map(),false);
  vm.runInContext("addSpeech(0,'公开发言');profiles[0].manorPortrait='portrait-04';renderAll()",context);
  assert.match(vm.runInContext("$('transcript').innerHTML",context),/portrait-04-thumb.webp/);
  events.error[0]({target:{dataset:{portrait:'portrait-04'}}});
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/manor-avatar-fallback/);
  assert.doesNotMatch(vm.runInContext("$('transcript').innerHTML",context),/portrait-04-thumb.webp/);
  vm.runInContext("profiles[0].manorPortrait='https://foreign.test/asset';renderPlayers()",context);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML",context),/foreign.test/);
});

test('庄园发言沿用声音生命周期，出局名牌保持明确且暂停不脉动',()=>{
  const {context}=setup(new Map(),false);
  vm.runInContext("game.start();game.phase='discussion';game.players[0].alive=false;speechBubble={id:0,text:'我的公开记录',kind:'dialogue',stage:'speaking'};renderPlayers()",context);
  let html=vm.runInContext("$('playersGrid').innerHTML",context);
  assert.match(html,/dead speaking pulsing/);assert.match(html,/life-mark">已出局/);
  vm.runInContext('paused=true;renderPlayers()',context);
  html=vm.runInContext("$('playersGrid').innerHTML",context);assert.doesNotMatch(html,/pulsing/);assert.match(html,/已暂停/);
  vm.runInContext('reset()',context);
  assert.equal(vm.runInContext('speechBubble',context),null);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML",context),/speaking|pulsing|dead /);
});

test('支持音频但不支持系统朗读时提示更换声音，不中断对局',async()=>{
  const {context}=setup();
  context.Audio=function(){};
  assert.equal(await vm.runInContext("speakText('请听我分析',{kind:'preview',seat:0})",context),false);
  assert.equal(vm.runInContext('narration',context),null);
  assert.match(vm.runInContext("$('voicePreviewStatus').textContent",context),/选择自然中文音色/);
});

test('真实请求格式含独立模型和完整规则，不向平民发送隐藏身份',async()=>{
  const {context,requests,calls,timeouts}=setup();
  const result=await vm.runInContext("decision(8,'vote')",context);
  assert.equal(result.target,0);
  const req=requests[0],view=JSON.parse(req.messages[1].content).context;
  assert.equal(req.model,'test-model');
  assert.match(req.messages[0].content,/不能连续守/);
  assert.equal(view.seat,9);
  assert.equal(view.role,'平民');
  assert.ok(view.players.every(p=>!('role' in p)));
  assert.equal(view.wolfTeammates,undefined);
  assert.equal(view.potions,undefined);
  assert.equal(view.allowedTargets.includes(9),false);
  assert.equal(calls[0].url,'/api/chat');
  assert.equal(calls[0].request.headers.Authorization,undefined);
  assert.equal(req.endpoint,'https://example.test/v1/chat/completions');
  assert.equal(req.apiKey,'secret-test-key');
  assert.equal(JSON.stringify(req.messages).includes('secret-test-key'),false);
  assert.equal(timeouts.includes(185000),false);
  assert.equal(req.purpose,'game-action');
  assert.equal(req.action.task,'vote');
  assert.match(req.requestId,/^agent-/);
});

test('非法自投等待重试，不模拟；修复响应后仅返回合法行动且不保存密钥',async()=>{
  const {context,saved}=setup();let requests=0;
  context.fetch=async url=>url==='/api/agent-events'?{ok:true}:{ok:true,json:async()=>({choices:[{message:{content:++requests===1?'中文不是有效响应':'{"target":1}'}}]})};
  const pending=vm.runInContext("decision(8,'vote')",context);await until(()=>vm.runInContext('!!apiWaiting',context));
  assert.equal(vm.runInContext('profiles[8].connection',context),'error');
  vm.runInContext('retryAPI()',context);const result=await pending;assert.equal(result.target,0);assert.equal(requests,2);
  vm.runInContext('profiles[8].rememberKey=false;persist()',context);assert.equal(saved.get('nightfall-profiles-v1').includes('secret-test-key'),false);
});

test('女巫解药耗尽后不再获取狼刀目标，保留自己的药水信息',async()=>{
  const {context,requests}=setup();
  vm.runInContext("profiles[5]={...profiles[8]};game.phase='night';game.potions.save=false;",context);
  context.fetch=async(url,request)=>{requests.push(JSON.parse(request.body));return {ok:true,json:async()=>({choices:[{message:{content:'{"save":false,"poison":null}'}}]})}};
  await vm.runInContext("decision(5,'night',{victim:8})",context);
  const view=JSON.parse(requests[0].messages[1].content).context;
  assert.equal(view.tonightVictim,undefined);
  assert.equal(view.potions.save,false);
  assert.equal(view.potions.poison,true);
});

test('六人和十二人投票与夜间请求使用完整公开历史并按角色隔离私有信息',()=>{
  const {context}=setup(new Map(),false),read=code=>vm.runInContext(code,context);
  for(const roomSize of [6,12]){
    context.historyFixture={roomSize};
    read([
      'size=historyFixture.roomSize;',
      'game=new Nightfall.Game(size).start();',
      'game.players.forEach((player,index)=>player.role=Nightfall.ROLES[size][index]);',
      'game.phase="night";game.round=4;game.players[size-1].alive=false;game.lastGuard=0;',
      'game.potions={save:true,poison:false};',
      'game.speechHistory=Array.from({length:125},(_,index)=>({id:index%size,text:"完整发言"+(index+1),round:Math.floor(index/size)+1,pk:index===123}));',
      'game.logs=Array.from({length:27},(_,index)=>({text:"公开事件"+(index+1),round:Math.floor(index/size)+1,phase:index%2?"voting":"discussion"}));',
      'game.knowledge={};',
      'game.knowledge[game.players.find(player=>player.role==="预言家").id]={[0]:"狼人",[size-1]:"好人"};',
      'game.knowledge[0]={[size-2]:"伪造的非预言家查验"};'
    ].join(''));
    const roles=JSON.parse(read('JSON.stringify(game.players.map(player=>player.role))'));
    const seerId=roles.indexOf('预言家'),witchId=roles.indexOf('女巫'),guardId=roles.indexOf('守卫');
    const wolfIds=roles.map((role,id)=>role==='狼人'?id:null).filter(id=>id!==null);
    for(const seatId of roles.map((_,id)=>id)){
      const vote=JSON.parse(read('JSON.stringify(buildAgentContext('+seatId+',"vote"))'));
      const night=JSON.parse(read('JSON.stringify(buildAgentContext('+seatId+',"night",{victim:1}))'));
      for(const taskContext of [vote,night]){
        assert.equal(taskContext.speeches.length,125);
        assert.equal(taskContext.speeches[0].text,'完整发言1');
        assert.equal(taskContext.speeches.at(-2).pk,true);
        assert.equal(taskContext.speeches.at(-1).text,'完整发言125');
        assert.equal(taskContext.publicEvents.length,27);
        assert.deepEqual(taskContext.publicEvents.at(-1),{round:Math.floor(26/roomSize)+1,phase:'discussion',text:'公开事件27'});
        assert.ok(taskContext.players.every(player=>!('role' in player)));
      }
      assert.equal(vote.role,roles[seatId]);
      assert.equal(night.role,roles[seatId]);
      if(seatId===seerId){
        assert.deepEqual(night.checks,{1:'狼人',[roomSize]:'好人'});
        assert.deepEqual(vote.checks,night.checks);
      }else{
        assert.deepEqual(night.checks,{});
        assert.deepEqual(vote.checks,{});
      }
      if(roles[seatId]==='狼人'){
        assert.deepEqual(night.wolfTeammates,wolfIds.filter(id=>id!==seatId).map(id=>id+1));
        assert.deepEqual(night.allowedTargets,roles.map((_,id)=>id+1).filter(seat=>seat!==roomSize));
        assert.equal('wolfChoices' in night,false);
        assert.equal('choices' in night,false);
      }else{
        assert.equal(night.wolfTeammates,undefined);
      }
      if(seatId===guardId){
        assert.equal(night.lastGuard,1);
        assert.equal(night.allowedTargets.includes(1),false);
      }else{
        assert.equal(night.lastGuard,undefined);
      }
      if(seatId===witchId){
        assert.equal(night.tonightVictim,2);
        assert.deepEqual(night.potions,{save:true,poison:false});
        assert.equal(night.nightRules.poisonAvailable,false);
      }else{
        assert.equal(night.tonightVictim,undefined);
        assert.equal(night.potions,undefined);
      }
    }
    read('game.potions.save=false');
    const spentWitch=JSON.parse(read('JSON.stringify(buildAgentContext('+witchId+',"night",{victim:1}))'));
    assert.equal(spentWitch.tonightVictim,undefined);
    assert.equal(spentWitch.nightRules.canSave,false);
  }
});

test('测试连接使用同一转发通道，保存后保留连接结果与已勾选密钥',async()=>{
  const {context,requests,saved}=setup();
  assert.equal(await vm.runInContext('testConnection(profiles[8],false)',context),true);
  assert.equal(requests[0].messages[0].content,'Reply with OK.');
  assert.equal(requests[0].purpose,'connection-test');
  assert.equal(requests[0].maxTokens,350);
  // The test sends the seat's real reasoning effort so it validates what games will use.
  assert.equal(requests[0].reasoningEffort,vm.runInContext('NightfallAgentRequest.normalizeReasoningEffort(profiles[8].reasoningEffort)',context));
  assert.equal(requests[0].seat,9);
  vm.runInContext("openAgent(8);lastConnectionTest={signature:connectionSignature(profiles[8]),connection:'ok'};saveAgent()",context);
  assert.equal(vm.runInContext('profiles[8].connection',context),'ok');
  assert.equal(JSON.parse(saved.get('nightfall-profiles-v1'))[8].key,'secret-test-key');
});

test('供应商错误提示原样展示为安全中文，不再笼统提示跨域',async()=>{
  const {context}=setup();
  context.fetch=async()=>({ok:false,status:401,json:async()=>({error:{code:'AUTH_FAILED',message:'API Key 无效或未填写，请检查密钥'}})});
  assert.equal(await vm.runInContext('testConnection(profiles[8],false)',context),false);
  assert.equal(vm.runInContext('profiles[8].connection',context),'error');
  assert.match(vm.runInContext("$('toast').textContent",context),/API Key 无效/);
  assert.doesNotMatch(vm.runInContext("$('toast').textContent",context),/跨域/);
});

test('旧本地服务、断网和非法响应分别给出可操作提示',async()=>{
  const {context}=setup();
  context.fetch=async()=>({ok:false,status:404,json:async()=>{throw new SyntaxError('HTML')}});
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])',context),/本地服务需要重启/);
  context.fetch=async()=>{const e=Error('Failed to fetch');e.name='TypeError';throw e;};
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])',context),/启动窗口仍在运行/);
  context.fetch=async()=>({ok:true,json:async()=>({choices:[]})});
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])',context),/返回格式不正确/);
});

test('直接打开文件或填写不安全地址时不发送密钥',async()=>{
  const {context,calls}=setup();
  context.location.protocol='file:';
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])',context),/start-game.cmd/);
  context.location.protocol='http:';
  vm.runInContext("profiles[8].endpoint='http://example.test'",context);
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])',context),/HTTPS/);
  vm.runInContext("profiles[8].endpoint='https://name:password@example.test'",context);
  await assert.rejects(vm.runInContext('apiCall(profiles[8],[])',context),/HTTPS/);
  assert.equal(calls.length,0);
});

test('重置游戏取消进行中的转发，停止旧对局请求',async()=>{
  const {context}=setup();
  context.fetch=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));
  const pending=vm.runInContext('apiCall(profiles[8],[])',context);
  const rejected=assert.rejects(pending,{name:'AbortError'});
  vm.runInContext('reset()',context);
  await rejected;
  assert.equal(vm.runInContext('activeRequest',context),null);
});

async function until(check){
  for(let i=0;i<100;i++){if(check())return;await new Promise(setImmediate)}
  throw Error('Controller did not reach expected state');
}

function prepareAuto(context,size){
  vm.runInContext(`reset(${size});turnDelay=0;profiles.forEach(p=>p.control='local');`,context);
}

function installSpeech(context,{autoEnd=false}={}){
  const spoken=[],synth={paused:false,cancels:0,pauses:0,resumes:0,
    getVoices:()=>[{lang:'zh-CN',name:'中文一'},{lang:'zh-TW',name:'中文二'}],
    speak(utterance){spoken.push(utterance);if(autoEnd)queueMicrotask(()=>utterance.onend?.())},
    cancel(){this.cancels++},pause(){this.paused=true;this.pauses++},resume(){this.paused=false;this.resumes++}
  };
  context.speechSynthesis=synth;context.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};
  return {spoken,synth};
}

function installRuleAudio(context,{reject}={}){
  const audios=[];
  context.Audio=class{
    constructor(src){this.src=src;this.pauses=0;this.loads=0;audios.push(this)}
    play(){this.plays=(this.plays||0)+1;if(reject)return Promise.reject(reject);this.onplaying?.();return Promise.resolve()}
    pause(){this.pauses++}
    removeAttribute(key){if(key==='src')this.src=''}
    load(){this.loads++}
  };
  return audios;
}

test('简洁席位不嵌入对白，悬浮对白安全转义，普通观战隐藏身份',()=>{
  const {context}=setup();
  vm.runInContext("addSpeech(0,'第一条公开发言');addSpeech(0,'<script>新发言</script>');speechBubble={...transcript.at(-1),caption:transcript.at(-1).text,kind:'dialogue'};renderPlayers()",context);
  const html=vm.runInContext("$('playersGrid').innerHTML",context);
  assert.doesNotMatch(html,/seat-dialogue|新发言|第一条公开发言/);
  assert.match(vm.runInContext("$('speechBubble').innerHTML",context),/&lt;script&gt;新发言&lt;\/script&gt;/);
  vm.runInContext("reset();game.start();game.knowledge[2]={0:'狼人'};setPerspective('public')",context);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML",context),/查验|狼刀|毒杀|预言家|女巫/);
});

test('对白必须读完才进入下一位，重置释放等待且旧回调不污染新局',async()=>{
  const {context}=setup(),{spoken}=installSpeech(context);
  vm.runInContext('voiceEnabled=true',context);
  prepareAuto(context,6);
  vm.runInContext("game.start();game.phase='discussion';busy=true;decision=async(id)=>({speech:'这是 '+(id+1)+' 号的公开发言'})",context);
  const playing=vm.runInContext('aiSpeeches(false,epoch)',context);
  await until(()=>spoken.length===1);
  assert.equal(vm.runInContext('game.speeches.length',context),1);
  assert.equal(vm.runInContext('activeSeat',context),0);
  await new Promise(setImmediate);assert.equal(spoken.length,1);
  assert.match(spoken[0].text,/这是 1 号的公开发言/);
  spoken[0].onend();await until(()=>spoken.length===2);
  assert.equal(vm.runInContext('game.speeches.length',context),2);
  const oldEnd=spoken[1].onend;
  vm.runInContext('reset(12)',context);oldEnd();await playing;
  assert.equal(vm.runInContext('narration',context),null);
  assert.equal(vm.runInContext('transcript.length',context),0);
  assert.equal(vm.runInContext('game.phase',context),'lobby');
  assert.equal(spoken.length,2);
});

test('开局自动朗读全部公开发言，6/12 人整局及音色分配不依赖隐藏角色',async t=>{
  for(const size of [6,12])await t.test(String(size),async()=>{
    const {context}=setup(),{spoken}=installSpeech(context,{autoEnd:true});prepareAuto(context,size);
    vm.runInContext('voiceEnabled=true',context);
    vm.runInContext('game.random=()=>.9999',context);
    await vm.runInContext('start()',context);
    const history=vm.runInContext('game.speechHistory',context);
    assert.equal(vm.runInContext('game.phase',context),'ended');assert.equal(spoken.length,history.length);
    assert.deepEqual(spoken.map(u=>u.text),Array.from(history,l=>l.text));
    assert.ok(spoken.every(u=>u.lang==='zh-CN'&&u.voice.lang.startsWith('zh')));
  });
});

test('暂停和继续同步控制对白，关闭语音会立即释放播放等待',async()=>{
  const {context}=setup(),{spoken,synth}=installSpeech(context);
  vm.runInContext('voiceEnabled=true',context);
  vm.runInContext('busy=true',context);
  const playing=vm.runInContext("speakText('一段公开对白',{seat:0})",context);
  vm.runInContext('togglePause()',context);assert.equal(synth.paused,true);
  assert.equal(vm.runInContext('narration.paused',context),true);
  vm.runInContext('togglePause()',context);assert.equal(synth.paused,false);
  assert.equal(vm.runInContext('narration.paused',context),false);
  vm.runInContext('toggleDialogueVoice()',context);assert.equal(await playing,false);
  assert.equal(vm.runInContext('voiceEnabled',context),false);assert.equal(synth.cancels,1);
  assert.equal(spoken[0].onend,null);
});

test('规则介绍只朗读所选房间，切换人数不会修改实际房间',async()=>{
  const {context}=setup(),{spoken}=installSpeech(context);
  const audios=installRuleAudio(context);
  vm.runInContext('readRules(6)',context);
  assert.equal(audios[0].src,'/assets/rules-6.mp3?v=1');
  audios[0].onended();vm.runInContext('readRules(12)',context);
  assert.equal(audios[1].src,'/assets/rules-12.mp3?v=1');
  assert.equal(spoken.length,0,'规则不再回退到机械的浏览器朗读');
  assert.equal(vm.runInContext('size',context),12);
  audios[1].onended();
});

test('规则和重播暂停对局，取消暂停中的对白后规则仍能播放，讲解后不擅自继续',async()=>{
  const {context}=setup(),{spoken,synth}=installSpeech(context);
vm.runInContext('voiceEnabled=true',context);
  const audios=installRuleAudio(context);
  vm.runInContext("busy=true;addSpeech(2,'可以重播的公开发言')",context);
  const dialogue=vm.runInContext("speakText('先前对白',{seat:0})",context);
  vm.runInContext('openRulesIntro()',context);assert.equal(await dialogue,false);
  assert.equal(vm.runInContext('paused',context),true);assert.equal(audios[0].plays,1);
  assert.equal(vm.runInContext("$('rulesBackdrop').classList.contains('hidden')",context),false);
  audios[0].onended();vm.runInContext('closeRulesIntro()',context);
  assert.equal(vm.runInContext('paused',context),true);
  const replay=vm.runInContext('replaySpeech(2)',context);assert.match(spoken.at(-1).text,/可以重播的公开发言/);
  assert.equal(synth.paused,false,'重播时对局已暂停，但语音必须继续播放');
  assert.equal(vm.runInContext('narration.paused',context),false);
  spoken.at(-1).onend();await replay;
  assert.equal(vm.runInContext('paused',context),true);
});

test('自然规则音频不依赖系统朗读或模型接口，关闭与重置释放音频',async()=>{
  const {context,calls}=setup(),audios=installRuleAudio(context);
  const playing=vm.runInContext('playRuleAudio(6)',context);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent",context),/自然女声/);
  assert.match(vm.runInContext("$('voiceStatus').textContent",context),/自然女声/);
  assert.equal(audios[0].playbackRate,1);
  const lateEnd=audios[0].onended,lateError=audios[0].onerror;
  vm.runInContext('closeRulesIntro()',context);assert.equal(await playing,false);
  assert.equal(audios[0].pauses,1);assert.equal(audios[0].src,'');assert.equal(audios[0].loads,1);
  const next=vm.runInContext('playRuleAudio(12)',context);
  lateEnd();lateError();assert.equal(vm.runInContext('narration.audio',context),audios[1]);
  vm.runInContext('reset(6)',context);assert.equal(await next,false);
  assert.equal(audios[1].src,'');assert.equal(vm.runInContext('narration',context),null);
  assert.equal(calls.length,0);
});

test('规则音频重复点击停止，继续对局停止讲解，关闭对白不关闭规则音频',()=>{
  const {context}=setup(),audios=installRuleAudio(context);
  vm.runInContext('busy=true;readRules(6);toggleDialogueVoice()',context);
  assert.equal(vm.runInContext('paused',context),true);assert.equal(audios[0].pauses,0);
  vm.runInContext('readRules(6)',context);assert.equal(audios[0].pauses,1);
  vm.runInContext('readRules(12);togglePause()',context);
  assert.equal(vm.runInContext('paused',context),false);assert.equal(audios[1].pauses,1);
  assert.equal(vm.runInContext('narration',context),null);
});

test('规则音频自动播放受限或文件缺失时显示原因，不偷换机械语音',async()=>{
  const {context}=setup(),{spoken}=installSpeech(context);
  const blocked=Error('blocked');blocked.name='NotAllowedError';
  installRuleAudio(context,{reject:blocked});
  assert.equal(await vm.runInContext('playRuleAudio(6)',context),false);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent",context),/重新播放/);
  const audios=installRuleAudio(context),missing=vm.runInContext('playRuleAudio(12)',context);
  audios[0].onerror();assert.equal(await missing,false);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent",context),/重启游戏服务/);
  assert.equal(spoken.length,0);
});

test('规则音频加载超时与播放中断可释放状态并重试',async()=>{
  const {context}=setup(),audios=installRuleAudio(context),timers=[];
  context.setTimeout=(fn,ms)=>{timers.push({fn,ms});return null};
  context.Audio.prototype.play=function(){return Promise.resolve()};
  const loading=vm.runInContext('playRuleAudio(6)',context);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent",context),/加载/);
  assert.equal(timers.at(-1).ms,15000);timers.at(-1).fn();assert.equal(await loading,false);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent",context),/加载超时/);
  const playing=vm.runInContext('playRuleAudio(6)',context);audios[1].onplaying();
  assert.equal(timers.at(-1).ms,600000);timers.at(-1).fn();assert.equal(await playing,false);
  assert.match(vm.runInContext("$('rulesVoiceStatus').textContent",context),/播放中断/);
});

test('无语音支持、播放错误和超时均不阻塞，保留文字与原因',async()=>{
  const {context}=setup();
vm.runInContext('voiceEnabled=true',context);
  assert.equal(await vm.runInContext("speakText('文字仍然可读')",context),false);
  assert.match(vm.runInContext("$('voiceStatus').textContent",context),/不支持语音/);
  const {spoken,synth}=installSpeech(context);
  const failed=vm.runInContext("speakText('播放会失败',{seat:0})",context);
  spoken[0].onerror({error:'not-allowed'});assert.equal(await failed,false);
  assert.match(vm.runInContext("$('voiceStatus').textContent",context),/语音播放失败/);
  let timeout;
  context.setTimeout=(fn,delay)=>{if(delay>=15000){timeout=fn;return undefined}return setTimeout(fn,delay)};
  const hanging=vm.runInContext("speakText('底层未返回完成事件',{seat:1})",context);
  timeout();assert.equal(await hanging,false);assert.equal(synth.cancels,1);
  assert.match(vm.runInContext("$('voiceStatus').textContent",context),/已跳过/);
});

test('全屏进入、点击退出与浏览器 Esc 退出同步恢复布局，不重置对局',async()=>{
  const {context,events}=setup(),doc=context.document;let requested=0,exited=0;
  doc.documentElement.requestFullscreen=async()=>{requested++;doc.fullscreenElement=doc.documentElement};
  doc.exitFullscreen=async()=>{exited++;doc.fullscreenElement=null};
  const original=vm.runInContext('game',context);
  await vm.runInContext('toggleFullscreen()',context);
  assert.equal(requested,1);assert.equal(doc.body.classList.contains('watch-mode'),true);
  assert.equal(vm.runInContext("$('fullscreenBtn').textContent",context),'⛶ 退出全屏');
  assert.equal(vm.runInContext("$('storyMovieFullscreen').textContent",context),'⛶ 退出全屏');
  assert.equal(vm.runInContext("$('storyMovieFullscreen').attributes['aria-pressed']",context),'true');
  await vm.runInContext('toggleFullscreen()',context);assert.equal(exited,1);
  assert.equal(doc.body.classList.contains('watch-mode'),false);
  assert.equal(vm.runInContext("$('storyMovieFullscreen').textContent",context),'⛶ 全屏观战');
  await vm.runInContext('toggleFullscreen()',context);doc.fullscreenElement=null;
  events.fullscreenchange.forEach(fn=>fn());
  assert.equal(doc.body.classList.contains('watch-mode'),false);
  assert.equal(vm.runInContext('game',context),original);
});

test('全屏被浏览器拒绝时进入沉浸布局，Esc 退出；规则弹窗优先关闭',async()=>{
  const {context,events}=setup();context.document.documentElement.requestFullscreen=async()=>{throw Error('denied')};
  await vm.runInContext('toggleFullscreen()',context);
  assert.equal(vm.runInContext('watchMode',context),true);
  assert.match(vm.runInContext("$('toast').textContent",context),/沉浸观战/);
  vm.runInContext('openRulesIntro()',context);
  const escape={key:'Escape',preventDefault(){}};
  events.keydown.forEach(fn=>fn(escape));
  assert.equal(vm.runInContext("$('rulesBackdrop').classList.contains('hidden')",context),true);
  assert.equal(vm.runInContext('watchMode',context),true);
  events.keydown.forEach(fn=>fn(escape));assert.equal(vm.runInContext('watchMode',context),false);
});

test('6/12 人只调用一次开始即可自动完成整局与再次开局',async t=>{
  for(const size of [6,12])await t.test(`${size} 人`,async()=>{
    const {context}=setup();prepareAuto(context,size);
    vm.runInContext(`
      let seed=35;game.random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
      const actualDecision=decision;let turns=0;
      decision=async(...args)=>{if(++turns>1500)throw Error('Too many turns');return actualDecision(...args)};
      const actualOpenVoting=game.openVoting.bind(game);
      game.openVoting=()=>{if(game.speeches.length!==game.alive().length)throw Error('Missing speech');return actualOpenVoting()};
    `,context);
    await vm.runInContext('start()',context);
    assert.equal(vm.runInContext('runError',context),'');
    assert.equal(vm.runInContext('game.phase',context),'ended');
    assert.ok(vm.runInContext('game.winner',context));
    assert.equal(vm.runInContext('busy',context),false);
    assert.ok(vm.runInContext('game.speechHistory.length',context)>0);
    assert.doesNotMatch(vm.runInContext("$('actionPanel').innerHTML",context),/data-command="(?:vote|hunter|night|speak)"/);
    assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/狼人/);
    const previous=vm.runInContext('game',context);
    await vm.runInContext('start()',context);
    assert.notEqual(vm.runInContext('game',context),previous);
    assert.equal(vm.runInContext('game.phase',context),'ended');
  });
});

test('所有 API 席位包含 1 号位，模型独立且全程自动发言投票',async()=>{
  const {context}=setup(),seen=[];prepareAuto(context,6);
  vm.runInContext(`game.random=()=>.9999;profiles.slice(0,6).forEach((p,i)=>Object.assign(p,{control:'api',endpoint:'https://example.test',model:'seat-'+(i+1),key:'key-'+(i+1)}))`,context);
  context.fetch=batchCompatibleFetch(async(url,{body})=>{
    const request=JSON.parse(body),{task,context:view}=JSON.parse(request.messages[1].content);
    seen.push({task,view,request});
    assert.ok(seen.length<300);
    const result=task==='speech'?{speech:`我是 ${view.seat} 号，我会独立判断。`}:task==='night'&&view.role==='女巫'?{save:!!view.potions.save,poison:null}:{target:view.allowedTargets[0]??null};
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(result)}}]})};
  });
  await vm.runInContext('start()',context);
  assert.equal(vm.runInContext('game.phase',context),'ended');
  assert.equal(vm.runInContext('runError',context),'');
  for(const task of ['night','speech','vote'])assert.ok(seen.some(x=>x.view.seat===1&&x.task===task),`1号位应自动执行 ${task}`);
  for(const {view,request} of seen){
    assert.equal(request.model,'seat-'+view.seat);assert.equal(request.apiKey,'key-'+view.seat);
    assert.ok(view.players.every(p=>!('role' in p)));
  }
  assert.equal(new Set(seen.filter(x=>x.task==='speech'&&!x.view.pk).map(x=>x.view.round+':'+x.view.seat)).size,seen.filter(x=>x.task==='speech'&&!x.view.pk).length);
});

test('自动完成平票 PK 发言及第二轮投票，候选人不参与投票',async()=>{
  const {context}=setup();prepareAuto(context,6);
  vm.runInContext(`
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
  `,context);
  await vm.runInContext('start()',context);
  assert.equal(vm.runInContext('game.phase',context),'ended');
  assert.deepEqual(Array.from(vm.runInContext('pkSpeakers',context)),[2,3]);
  assert.deepEqual(Array.from(vm.runInContext('pkVoters',context)),[0,1,4,5]);
  assert.equal(vm.runInContext('game.speechHistory.filter(s=>s.pk).length',context),2);
});

test('猎人狼刀或放逐出局后自动开枪，并继续剩余流程',async t=>{
  for(const cause of ['night','vote'])await t.test(cause,async()=>{
    const {context}=setup();prepareAuto(context,12);context.hunterCause=cause;
    vm.runInContext(`
      game.random=()=>.9999;let shots=0;
      decision=(id,task)=>{
        if(task==='speech')return {speech:'我将独立判断'};
        if(task==='hunter'){shots++;return {target:0}}
        if(task==='night')return game.players[id].role==='女巫'?{save:false,poison:null}:{target:game.players[id].role==='狼人'&&game.round===1&&hunterCause==='night'?6:null};
        const target=hunterCause==='vote'&&game.round===1?6:game.alive().find(p=>p.role==='狼人').id;
        return {target:id===target?null:target};
      };localStoryDecision=decision;
    `,context);
    await vm.runInContext('start()',context);
    assert.equal(vm.runInContext('runError',context),'');
    assert.equal(vm.runInContext('game.phase',context),'ended');
    assert.equal(vm.runInContext('shots',context),1);
    assert.equal(vm.runInContext('game.players[0].cause',context),'hunter');
  });
});

test('暂停允许当前请求完成，后续行动停止，继续后自动到终局，重复开始无效',async()=>{
  const {context}=setup();prepareAuto(context,6);
  vm.runInContext("game.random=()=>.9999;profiles[0].control='api';profiles[0].endpoint='https://example.test';profiles[0].model='first-seat'",context);
  let release,requests=0;
  context.fetch=batchCompatibleFetch(async(url,options)=>{if(url==='/api/chat')requests++;if(requests===1&&url==='/api/chat')await new Promise(resolve=>release=resolve);const input=JSON.parse(JSON.parse(options.body).messages[1].content);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(input.task==='speech'?{speech:'我会根据发言判断'}:{target:input.context.allowedTargets[0]??null})}}]})}} );
  const playing=vm.runInContext('start()',context);
  await until(()=>!!release);
  const activeSeat=vm.runInContext('activeSeat',context),voteBatch=vm.runInContext('voteBatch',context);
  assert.ok(activeSeat===0||voteBatch,'当前 API 请求应处于单席行动或狼人批次等待状态');
  assert.doesNotMatch(vm.runInContext("$('actionPanel').innerHTML",context),/狼人正在|预言家正在|女巫正在/);
  vm.runInContext('togglePause()',context);release();
  await new Promise(setImmediate);
  await vm.runInContext('start()',context);
  assert.equal(requests,1);
  assert.equal(vm.runInContext('paused',context),true);
  assert.equal(vm.runInContext('game.round',context),1);
  vm.runInContext('togglePause()',context);await playing;
  assert.equal(vm.runInContext('game.phase',context),'ended');
});

test('暂停等待中切房立即释放旧流程，新一局可正常自动完成',async()=>{
  const {context}=setup();prepareAuto(context,6);
  vm.runInContext('turnDelay=2600',context);
  const playing=vm.runInContext('start()',context);
  vm.runInContext('togglePause()',context);await new Promise(setImmediate);
  vm.runInContext('reset(12);turnDelay=0',context);await playing;
  assert.equal(vm.runInContext('game.phase',context),'lobby');
  assert.equal(vm.runInContext('game.size',context),12);
  assert.equal(vm.runInContext('busy',context),false);
  await vm.runInContext('start()',context);
  assert.equal(vm.runInContext('game.phase',context),'ended');
});

test('完整流程重置取消请求，API 故障等待修复后继续终局',async()=>{
  const {context}=setup();prepareAuto(context,6);
  vm.runInContext("game.random=()=>.9999;profiles[0].control='api';profiles[0].endpoint='https://example.test';profiles[0].model='first-seat'",context);
  let cancelled=false;
  context.fetch=batchCompatibleFetch(async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(new DOMException('Cancelled','AbortError'))},{once:true})));
  const playing=vm.runInContext('start()',context);
  await until(()=>vm.runInContext('activeRequest!==null||voteBatch?.controllers?.size>0',context));
  vm.runInContext('reset(12)',context);await playing;
  assert.equal(cancelled,true);
  assert.equal(vm.runInContext('game.phase',context),'lobby');
  assert.equal(vm.runInContext('game.logs.length',context),0);
  assert.equal(vm.runInContext('feed.length',context),1);
  context.fetch=async()=>({ok:false,status:401,json:async()=>({error:{message:'测试密钥无效',code:'AUTH_FAILED'}})});
  const recovering=vm.runInContext('start()',context);
  await until(()=>vm.runInContext('apiWaiting!==null||voteBatch?.errorPause',context));
  assert.notEqual(vm.runInContext('game.phase',context),'ended');
  context.fetch=batchCompatibleFetch(async(url,options)=>{const input=JSON.parse(JSON.parse(options.body).messages[1].content);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(input.task==='speech'?{speech:'按信息判断'}:input.task==='night'&&input.context.role==='女巫'?{save:false,poison:null}:{target:input.context.allowedTargets[0]??null})}}]})}} );
  vm.runInContext('retryAPI()',context);await recovering;
  assert.equal(vm.runInContext('game.phase',context),'ended');
  assert.equal(vm.runInContext('profiles[0].connection',context),'ok');
});

test('重新创建页面后恢复独立密钥，批量测试可用，连接状态重新验证',async()=>{
  const {context,saved}=setup();
  vm.runInContext("profiles[0]={...profiles[8],key:'another-seat-key',model:'another-model'};persist()",context);
  const reloaded=setup(saved,false);
  assert.equal(vm.runInContext('profiles[0].key',reloaded.context),'another-seat-key');
  assert.equal(vm.runInContext('profiles[8].key',reloaded.context),'secret-test-key');
  assert.equal(vm.runInContext('profiles[0].connection',reloaded.context),'untested');
  vm.runInContext('reset(12)',reloaded.context);
  await vm.runInContext('testAll()',reloaded.context);
  assert.deepEqual(reloaded.requests.map(r=>[r.model,r.apiKey]),[['another-model','another-seat-key'],['test-model','secret-test-key']]);
  assert.equal(vm.runInContext('profiles[0].connection',reloaded.context),'ok');
  assert.equal(vm.runInContext('profiles[8].connection',reloaded.context),'ok');
});

test('取消记住并保存删除原密钥，当前页面仍可测试，下次加载为空',async()=>{
  const {context,saved}=setup();
  vm.runInContext('persist();openAgent(8)',context);
  assert.equal(JSON.parse(saved.get('nightfall-profiles-v1'))[8].key,'secret-test-key');
  assert.equal(vm.runInContext("$('rememberKeyInput').checked",context),true);
  vm.runInContext("$('rememberKeyInput').checked=false;saveAgent()",context);
  assert.equal(vm.runInContext('profiles[8].key',context),'secret-test-key');
  assert.equal('key' in JSON.parse(saved.get('nightfall-profiles-v1'))[8],false);
  assert.equal(await vm.runInContext('testConnection(profiles[8],false)',context),true);
  const reloaded=setup(saved,false);
  assert.equal(vm.runInContext('profiles[8].key',reloaded.context),'');
  assert.equal(vm.runInContext('profiles[8].rememberKey',reloaded.context),false);
});

test('清空已存密钥可删除；旧版本和损坏配置可加载，不伪造旧密钥',()=>{
  const {context,saved}=setup();
  vm.runInContext("persist();openAgent(8);$('keyInput').value='';saveAgent()",context);
  assert.equal(saved.get('nightfall-profiles-v1').includes('secret-test-key'),false);
  assert.equal(vm.runInContext('profiles[8].key',setup(saved,false).context),'');
  saved.set('nightfall-profiles-v1',JSON.stringify([{name:'原玩家',endpoint:'https://example.test',control:'api',model:'old-model'}]));
  const old=setup(saved,false);
  assert.equal(vm.runInContext('profiles[0].model',old.context),'old-model');
  assert.equal(vm.runInContext('profiles[0].key',old.context),'');
  assert.equal(vm.runInContext('profiles[0].rememberKey',old.context),true);
  for(const value of ['null','broken JSON','[null]',JSON.stringify([{rememberKey:false,key:'must-not-load'}])]){
    saved.set('nightfall-profiles-v1',value);
    assert.equal(vm.runInContext('profiles[0].key',setup(saved,false).context),'');
  }
});

test('保存失败保持编辑窗口且不显示成功，不改变原席位配置',()=>{
  const {context}=setup();
  vm.runInContext("openAgent(8);$('keyInput').value='new-key';localStorage.setItem=()=>{throw Error('quota')};saveAgent()",context);
  assert.equal(vm.runInContext('profiles[8].key',context),'secret-test-key');
  assert.match(vm.runInContext("$('toast').textContent",context),/存储空间不足/);
});

test('批量测试失败保留每席位原因，未填写密钥显示补填提示',async()=>{
  const {context,saved}=setup();
  vm.runInContext("profiles[8].key='';reset(12)",context);
  context.fetch=async()=>({ok:false,status:401,json:async()=>({error:{message:'API Key 无效或未填写，请检查密钥'}})});
  await vm.runInContext('testAll()',context);
  assert.match(vm.runInContext("$('agentGrid').innerHTML",context),/API Key 无效或未填写/);
  assert.match(vm.runInContext("$('agentGrid').innerHTML",context),/请补填并保存/);
  vm.runInContext('persist()',context);
  assert.equal(saved.get('nightfall-profiles-v1').includes('connectionError'),false);
});

test('批量测试即时排队、逐席位加载与结果同步，重复操作不会启动新请求',async()=>{
  const {context}=setup();const pending=[];
  // Same host, different models: tested in turn rather than shared or in parallel.
  vm.runInContext("reset(12);profiles[0]={...profiles[8]};profiles[2]={...profiles[8],model:'second-model'};profiles[8].control='local';profiles[0].connection='ok';profiles[2].connection='error';profiles[2].connectionError='旧错误'",context);
  context.fetch=async()=>new Promise(resolve=>pending.push(resolve));
  const run=vm.runInContext('testAll()',context);
  assert.deepEqual(Array.from(vm.runInContext('profiles.slice(0,3).map(p=>connectionInfo(p).state)',context)),['testing','local','queued']);
  assert.match(vm.runInContext("$('agentGrid').innerHTML",context),/连接中…/);
  assert.match(vm.runInContext("$('agentGrid').innerHTML",context),/等待测试…/);
  assert.doesNotMatch(vm.runInContext("$('agentGrid').innerHTML",context),/旧错误/);
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/API 连接中…/);
  assert.match(vm.runInContext("$('testAllBtn').textContent",context),/1 \/ 2 · 1 号/);
  assert.equal(vm.runInContext("$('startBtn').disabled&&$('testAllBtn').disabled&&$('saveAgent').disabled",context),true);
  await vm.runInContext('testAll();testConnection(profiles[0],false);start()',context);
  assert.equal(pending.length,1);assert.equal(vm.runInContext('game.phase',context),'lobby');
  pending[0]({ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})});
  await until(()=>pending.length===2);
  assert.equal(vm.runInContext('profiles[0].connection',context),'ok');
  assert.equal(vm.runInContext('profiles[2].connection',context),'testing');
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/API 在线/);
  assert.match(vm.runInContext("$('testAllBtn').textContent",context),/2 \/ 2 · 3 号/);
  pending[1]({ok:false,status:401,json:async()=>({error:{message:'API Key 无效'}})});
  await run;
  assert.equal(vm.runInContext('profiles[2].connection',context),'error');
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/API 离线/);
  assert.match(vm.runInContext("$('toast').textContent",context),/1 \/ 2 个 API Agent 连接成功/);
  assert.equal(vm.runInContext("$('startBtn').disabled||$('testAllBtn').disabled",context),false);
  context.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})});
  await vm.runInContext('testAll()',context);
  assert.equal(vm.runInContext('profiles[2].connection',context),'ok');
});

test('服务端仍有对局请求时批量连接测试停止并显示明确提示', async () => {
  const {context} = setup();
  let requests = 0;
  vm.runInContext("reset(12);profiles[0]={...profiles[8]};profiles[2]={...profiles[8]}", context);
  context.fetch = async () => {
    requests++;
    return {ok:false, status:409, json:async()=>({error:{code:'GAME_REQUESTS_ACTIVE', message:'当前仍有游戏 Agent 请求正在处理，请等待本局请求完成后再测试连接'}})};
  };
  await vm.runInContext('testAll()', context);
  assert.equal(requests, 1);
  assert.match(vm.runInContext("$('toast').textContent", context), /等待本局请求完成/);
  assert.equal(vm.runInContext('profiles[2].connection', context), 'untested');
  assert.equal(vm.runInContext('connectionBatch', context), null);
});

test('批量测试重置取消后不遗留加载状态，不再请求排队席位',async()=>{
  const {context}=setup();let requests=0;
  vm.runInContext('reset(12);profiles[0]={...profiles[8]}',context);
  context.fetch=async(url,{signal})=>{requests++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}))};
  const run=vm.runInContext('testAll()',context);
  vm.runInContext('reset(6)',context);await run;
  assert.equal(requests,1);
  assert.equal(vm.runInContext('connectionBatch',context),null);
  assert.equal(vm.runInContext('profiles.some(p=>["testing","queued"].includes(p.connection))',context),false);
  assert.equal(vm.runInContext("$('testAllBtn').disabled",context),false);
});

test('游戏请求实时更新席位连接，等待当前行动成功后恢复在线',async()=>{
  const {context}=setup();let finish;
  context.fetch=async()=>new Promise(resolve=>finish=resolve);
  const run=vm.runInContext("decision(8,'vote')",context);
  await until(()=>!!finish);
  assert.equal(vm.runInContext('profiles[8].connection',context),'testing');
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/API 连接中…/);
  await until(()=>!!finish);finish({ok:false,status:503,json:async()=>({error:{message:'服务暂不可用'}})});await until(()=>vm.runInContext('!!apiWaiting',context));
  assert.equal(vm.runInContext('profiles[8].connection',context),'error');
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/API 离线/);
  context.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"target":1}'}}]})});
  vm.runInContext("retryAPI()",context);await run;
  assert.equal(vm.runInContext('profiles[8].connection',context),'ok');
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/API 在线/);
  vm.runInContext('persist()',context);
  assert.equal(vm.runInContext("localStorage.getItem('nightfall-profiles-v1').includes('connection')",context),false);
});

test('修改名称保留连接，修改模型重置状态，草稿测试不覆盖其他配置',async()=>{
  const {context}=setup();
  vm.runInContext("profiles[8].connection='ok';openAgent(8);$('nameInput').value='新名字';saveAgent()",context);
  assert.equal(vm.runInContext('profiles[8].connection',context),'ok');
  vm.runInContext("openAgent(8);$('modelInput').value='another-model'",context);
  await vm.runInContext('testConnection()',context);
  assert.equal(vm.runInContext('profiles[8].model',context),'test-model');
  assert.equal(vm.runInContext('profiles[8].connection',context),'ok');
  vm.runInContext('saveAgent()',context);
  assert.equal(vm.runInContext('profiles[8].connection',context),'ok');
  vm.runInContext("openAgent(8);$('modelInput').value='untested-model';saveAgent()",context);
  assert.equal(vm.runInContext('profiles[8].connection',context),'untested');
});

test('本地服务真正关闭重启后，新页面恢复配置并通过真实 HTTP 批量测试',async()=>{
  const {createServer}=require('./server.cjs'),authorizations=[];
  const fetchImpl=async(url,options)=>{
    authorizations.push(options.headers.Authorization);
    return new Response(JSON.stringify({id:'resp-connection',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]}),{headers:{'Content-Type':'application/json'}});
  };
  let service=createServer({fetchImpl,recoverVideoJobs:false}),port;
  const close=async()=>{service.closeAllConnections();await new Promise(resolve=>service.close(resolve))};
  try{
    await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));port=service.address().port;
    const original=setup();
    vm.runInContext("profiles[0]={...profiles[8],key:'restart-test-key'};persist()",original.context);
    const connect=async client=>{
      const origin='http://127.0.0.1:'+port;
      // Each page uses fresh connections, avoiding Node's stale pooled socket after shutdown.
      client.context.fetch=(url,options)=>fetch(origin+url,{...options,headers:{...options.headers,Origin:origin,Connection:'close'}});
      await vm.runInContext('testAll()',client.context);
      assert.equal(vm.runInContext('profiles[0].connection',client.context),'ok',vm.runInContext('profiles[0].connectionError',client.context));
    };
    await connect(original);
    await close();service=createServer({fetchImpl,recoverVideoJobs:false});
    await new Promise(resolve=>service.listen(port,'127.0.0.1',resolve));
    await connect(setup(original.saved,false));
    assert.equal(authorizations.filter(value=>value==='Bearer restart-test-key').length,2);
  }finally{if(service.listening)await close()}
});
function installNatural(context,{hold=false}={}){
  const audios=installRuleAudio(context),requests=[],revoked=[];
  context.URL=class extends URL{static createObjectURL(){return 'blob:test-'+requests.length}static revokeObjectURL(url){revoked.push(url)}};
  const pending=[];
  context.fetch=async(url,request)=>{requests.push({url,request,body:JSON.parse(request.body)});if(hold)await new Promise(resolve=>pending.push(resolve));return {ok:true,blob:async()=>({size:512,type:'audio/mpeg'})}};
  return {audios,requests,revoked,pending};
}

test('旧配置自动获得独立自然音色，保存声音设置并重载，不随随机身份变化',()=>{
  const saved=new Map([['nightfall-profiles-v1',JSON.stringify([{name:'原玩家',model:'chat-model',key:'chat-key'}])]]);
  const {context}=setup(saved,false,false);
  assert.equal(vm.runInContext('profiles[0].voiceProvider',context),'neural');
  assert.equal(vm.runInContext('new Set(profiles.map(p=>p.voice)).size',context),12);
  vm.runInContext("openAgent(0);$('voiceMatchInput').value='custom';$('playerVoiceInput').value='zh-CN-XiaoxiaoNeural';$('voiceStyleInput').value='firm';$('voiceSpeedInput').value='0.85';saveAgent()",context);
  const next=setup(saved,false,false);
  assert.equal(vm.runInContext('profiles[0].voice',next.context),'zh-CN-XiaoxiaoNeural');
  assert.equal(vm.runInContext('profiles[0].voiceStyle',next.context),'firm');
  assert.equal(vm.runInContext('profiles[0].voiceSpeed',next.context),.85);
  assert.equal(vm.runInContext('profiles[0].key',next.context),'chat-key');
  vm.runInContext('game.start();reset(12);game.start()',next.context);
  assert.equal(vm.runInContext('profiles[0].voice',next.context),'zh-CN-XiaoxiaoNeural');
});
test('自然语音请求与对局发言共用1400个Unicode字符上限',async()=>{
  const {context}=setup(new Map(),false,false),{audios,requests}=installNatural(context);
  vm.runInContext('voiceEnabled=true',context);
  const text='🧛'.repeat(1501);
  const playing=vm.runInContext('speakText('+JSON.stringify(text)+',{seat:0})',context);
  await until(()=>audios.length===1);
  assert.equal(Array.from(requests[0].body.text).length,1400);
  audios[0].onended();await playing;
});
test('自然对白逐席位生成播放，只发送公开台词与声音配置，结束释放音频',async()=>{
  const {context}=setup(new Map(),false,false),{audios,requests,revoked}=installNatural(context);
  vm.runInContext('voiceEnabled=true',context);
  vm.runInContext("game.start();game.phase='discussion';turnDelay=0;busy=true;decision=async(id)=>({speech:'为什么 '+(id+1)+' 号会这样判断？'})",context);
  const playing=vm.runInContext('aiSpeeches(false,epoch)',context);
  await until(()=>audios.length===1);assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/speech');
  assert.equal(requests[0].body.style,'suspicious');assert.equal(requests[0].body.voice,'zh-CN-XiaoxiaoNeural');
  assert.equal(Object.hasOwn(requests[0].body,'apiKey'),false);assert.equal(Object.hasOwn(requests[0].body,'role'),false);assert.equal(Object.hasOwn(requests[0].body,'messages'),false);
  const oldEnd=audios[0].onended;audios[0].onended();await until(()=>audios.length===2);
  assert.equal(revoked[0],'blob:test-1');assert.equal(requests[1].body.voice,'zh-CN-YunyangNeural');
  vm.runInContext('reset(12)',context);oldEnd();await playing;
  assert.equal(audios[1].src,'');assert.equal(revoked.length,2);assert.equal(vm.runInContext('narration',context),null);
});
test('自然语音生成中暂停，生成完成仍等待；继续后播放，关闭声音释放等待',async()=>{
  const {context}=setup(new Map(),false,false),{audios,pending}=installNatural(context,{hold:true});
vm.runInContext('voiceEnabled=true',context);
  vm.runInContext('busy=true',context);
  const playing=vm.runInContext("speakText('别投我，我不是狼！',{seat:0})",context);
  vm.runInContext('togglePause()',context);pending[0]();await until(()=>audios.length===1);
  assert.equal(audios[0].plays,undefined);assert.equal(vm.runInContext('narration.paused',context),true);
  vm.runInContext('togglePause()',context);assert.equal(audios[0].plays,1);
  vm.runInContext('togglePause()',context);assert.equal(audios[0].pauses,1);
  vm.runInContext('toggleDialogueVoice()',context);assert.equal(await playing,false);assert.equal(audios[0].src,'');
});
test('重置取消生成且忽略迟到的音频，不污染下一局',async()=>{
  const {context}=setup(new Map(),false,false),{audios,pending,requests}=installNatural(context,{hold:true});
vm.runInContext('voiceEnabled=true',context);
  const playing=vm.runInContext("speakText('公开台词',{seat:0})",context);
  vm.runInContext('reset(12)',context);assert.equal(await playing,false);assert.equal(requests[0].request.signal.aborted,true);
  pending[0]();await new Promise(setImmediate);assert.equal(audios.length,0);assert.equal(vm.runInContext('narration',context),null);
});
test('试听使用未保存的语音配置、独立密钥；取消记住会删除语音密钥',async()=>{
  const {context,saved}=setup(new Map(),false,false),{requests,audios}=installNatural(context);
  vm.runInContext("openAgent(1);$('voiceMatchInput').value='custom';$('voiceProviderInput').value='api';$('voiceEndpointInput').value='https://speech.example.test';$('voiceModelInput').value='emotional-model';$('voiceApiVoiceInput').value='speaker-2';$('voiceKeyInput').value='voice-only-key';$('voiceStyleInput').value='firm'",context);
  const preview=vm.runInContext('previewVoice()',context);await until(()=>audios.length===1);
  assert.equal(requests[0].body.voice,'speaker-2');assert.equal(requests[0].body.apiKey,'voice-only-key');assert.equal(requests[0].body.model,'emotional-model');assert.equal(requests[0].body.style,'firm');
  assert.equal(vm.runInContext('profiles[1].voiceProvider',context),'neural');
  audios[0].onended();await preview;vm.runInContext('saveAgent()',context);
  assert.equal(JSON.parse(saved.get('nightfall-profiles-v1'))[1].voiceKey,'voice-only-key');
  vm.runInContext("openAgent(1);$('rememberVoiceKeyInput').checked=false;saveAgent()",context);
  assert.equal(saved.get('nightfall-profiles-v1').includes('voice-only-key'),false);
  assert.equal(vm.runInContext('profiles[1].voiceKey',context),'voice-only-key');
  assert.equal(vm.runInContext('profiles[1].voiceKey',setup(saved,false,false).context),'');
});
test('语音接口失败和浏览器禁止播放有提示，不回退成机械语音或修改 Agent 在线状态',async()=>{
  const {context}=setup(new Map(),false,false);const {spoken}=installSpeech(context);vm.runInContext("profiles[0].voiceProvider='neural';profiles[0].connection='ok'",context);installNatural(context);
vm.runInContext('voiceEnabled=true',context);
  context.fetch=async()=>({ok:false,status:401,json:async()=>({error:{message:'语音密钥无效',attempts:1}})});
  const failed=vm.runInContext("speakText('公开台词',{seat:0})",context);await until(()=>!!vm.runInContext('speechFailure',context));
  assert.equal(spoken.length,0);assert.equal(vm.runInContext('profiles[0].connection',context),'ok');
  assert.match(vm.runInContext("$('voiceStatus').textContent",context),/语音密钥无效/);
  assert.equal(vm.runInContext('speechFailure.attempts',context),1);assert.equal(vm.runInContext('paused',context),true);
  vm.runInContext('continueSpeechWithoutAudio()',context);assert.equal(await failed,false);
  const next=installNatural(context);context.Audio.prototype.play=()=>Promise.reject(Object.assign(Error('blocked'),{name:'NotAllowedError'}));
  assert.equal(await vm.runInContext("speakText('公开台词',{seat:0})",context),false);assert.equal(next.revoked.length,1);
  assert.match(vm.runInContext("$('voiceStatus').textContent",context),/浏览器暂停了声音/);
});
test('语音生成超时释放等待和请求；试听关闭时取消，非法旧音色安全恢复',async()=>{
  const {context}=setup(new Map(),false,false),{requests}=installNatural(context,{hold:true});let timeout;
vm.runInContext('voiceEnabled=true',context);
  context.setTimeout=(fn,ms)=>{if(ms===280000)timeout=fn;return undefined};
  const playing=vm.runInContext("speakText('公开台词',{seat:0})",context);timeout();await until(()=>!!vm.runInContext('speechFailure',context));
  assert.equal(requests[0].request.signal.aborted,true);assert.equal(vm.runInContext('speechFailure.attempts',context),3);
  vm.runInContext('continueSpeechWithoutAudio()',context);assert.equal(await playing,false);
  vm.runInContext('openAgent(0)',context);const preview=vm.runInContext('previewVoice()',context);vm.runInContext('closeModal()',context);await preview;assert.equal(requests[1].request.signal.aborted,true);
  const saved=new Map([['nightfall-profiles-v1',JSON.stringify([{voiceProvider:'invalid',voice:'unknown',voiceStyle:'wrong',voiceSpeed:999}])]]);
  const old=setup(saved,false,false);assert.equal(vm.runInContext('profiles[0].voiceProvider',old.context),'neural');assert.equal(vm.runInContext('profiles[0].voiceSpeed',old.context),1);
});
test('语音三次失败后可重试当前原句，不重复调用 Agent；无声继续保留文字阅读流程',async()=>{
  const {context}=setup(new Map(),false,false),natural=installNatural(context);
vm.runInContext('voiceEnabled=true',context);
  vm.runInContext("profiles[0].voiceProvider='api';profiles[0].voiceMatch='custom';profiles[0].voiceEndpoint='https://speech.example.test/v1';profiles[0].voiceModel='voice-model';profiles[0].voiceApiVoice='speaker-a';profiles[0].voiceKey='private-key';game.start();game.players.forEach((p,i)=>{p.alive=i===0});game.phase='discussion';turnDelay=0;busy=true;decisionCalls=0;decision=async()=>{decisionCalls++;return {speech:'同一段公开发言'}}",context);
  context.fetch=async(url,request)=>{
    natural.requests.push({url,request,body:JSON.parse(request.body)});
    if(natural.requests.length===1)return {ok:false,status:503,json:async()=>({error:{code:'VOICE_NETWORK_ERROR',message:'语音服务暂不可用',attempts:3}})};
    return {ok:true,blob:async()=>({size:512,type:'audio/mpeg'})};
  };
  const turn=vm.runInContext('aiSpeeches(false,epoch)',context);
  try{
    await until(()=>!!vm.runInContext('speechFailure',context));
    assert.equal(vm.runInContext('decisionCalls',context),1);assert.equal(vm.runInContext('game.speeches.length',context),1);
    assert.match(vm.runInContext("$('voiceStatus').textContent",context),/1 号.*已尝试 3 次/);
    assert.equal(vm.runInContext("$('speechRecovery').classList.contains('hidden')",context),false);
    vm.runInContext("profiles[0].voiceApiVoice='speaker-b';retryFailedSpeech()",context);await until(()=>natural.audios.length===1);
    assert.equal(natural.requests.length,2);assert.equal(natural.requests[0].body.text,natural.requests[1].body.text);
    assert.equal(natural.requests[1].body.voice,'speaker-b');assert.equal(vm.runInContext('decisionCalls',context),1);
    natural.audios[0].onended();await turn;assert.equal(vm.runInContext('speechBubble',context),null);
    assert.doesNotMatch(vm.runInContext("$('voiceStatus').textContent",context),/private-key/);
  }finally{
    if(vm.runInContext('speechFailure',context))vm.runInContext('continueSpeechWithoutAudio()',context);
    vm.runInContext('reset()',context);
  }
});
test('旁白语音失败后暂停并显示旁白名称；无声继续按全文阅读时间推进',async()=>{
  const {context}=setup(new Map(),false,false);context.requested=[];installNatural(context);
  context.fetch=async()=>({ok:false,status:503,json:async()=>({error:{code:'VOICE_NETWORK_ERROR',message:'语音服务暂不可用',attempts:3}})});
  vm.runInContext("busy=true;game.start();game.players.forEach((p,i)=>{p.alive=i===0});spectatorPrefs.narratorEnabled=true;commentaryQueue=[{kind:'custom',round:1,publicText:'现在进入白天讨论，大家请依次发言。',godText:'现在进入白天讨论，注意身份和发言。'}];presentationDelayScale=1;presentationWait=async(ms)=>{requested.push(ms);return true}",context);
  const commentary=vm.runInContext('flushCommentary(epoch)',context);await until(()=>!!vm.runInContext('speechFailure',context));
  const expected=vm.runInContext('NightfallObserver.readingTime(observerText(currentCommentary))',context);
  assert.match(vm.runInContext("$('voiceStatus').textContent",context),/旁白语音生成失败/);assert.equal(vm.runInContext('paused',context),true);
  vm.runInContext('continueSpeechWithoutAudio()',context);await commentary;
  assert.deepEqual(Array.from(vm.runInContext('requested',context)),[expected]);
});

test('对白和旁白默认关闭，关闭对白不调用语音接口',async()=>{
  const {context}=setup(new Map(),false,false),natural=installNatural(context);installSpeech(context);vm.runInContext('renderVoiceControls()',context);
  assert.equal(vm.runInContext('voiceEnabled',context),false);
  assert.equal(vm.runInContext("$('voiceBtn').attributes['aria-pressed']",context),'false');
  assert.match(vm.runInContext("$('voiceBtn').textContent",context),/对白语音：关/);
  assert.equal(vm.runInContext('spectatorPrefs.narratorEnabled',context),false);
  assert.equal(await vm.runInContext("speakText('只显示字幕',{seat:0})",context),false);
  assert.equal(await vm.runInContext("speakText('旁白也应静音',{kind:'commentary'})",context),false);
  assert.equal(natural.requests.length,0);
});

test('观战控件实际注册，设置持久化；本局旁白重置后不保存',()=>{
  const {context,saved}=setup(new Map(),false);
  assert.equal(vm.runInContext("typeof $('perspectiveInput').listeners.change",context),'function');
  vm.runInContext("$('perspectiveInput').value='public';$('perspectiveInput').listeners.change();$('railToggle').listeners.click();$('narratorBtn').listeners.click();addObserver({round:1,publicText:'公开',godText:'秘密'})",context);
  const p=JSON.parse(saved.get('nightfall-spectator-v1'));
  assert.deepEqual(p,{perspective:'public',railOpen:false,narratorEnabled:true});
  assert.doesNotMatch(saved.get('nightfall-spectator-v1'),/公开|秘密/);
  const next=setup(saved,false);
  assert.equal(vm.runInContext('spectatorPrefs.perspective',next.context),'public');
  assert.equal(vm.runInContext('spectatorPrefs.railOpen',next.context),false);
  assert.equal(vm.runInContext('observerEvents.length',next.context),0);
  assert.equal(vm.runInContext('spectatorPrefs.narratorEnabled',next.context),true);
});

test('三个记录入口同步收起双侧记录，保留阅读位置与旁白，人物点击重新展开',()=>{
 const {context,saved}=setup(new Map(),false);
 vm.runInContext("recordSeat='2';recordScroll.speeches={top:123,bottom:false,seen:0};recordScroll.activity={top:77,bottom:false,seen:0};recordScroll.commentary={top:91,bottom:false,seen:0};spectatorPrefs.narratorEnabled=true;addObserver({round:1,godText:'保留的旁白',publicText:'公开旁白'});renderSpectator()",context);
 for(const id of ['railToggle','mobileRecordToggle','railClose']){
  vm.runInContext(`$('${id}').listeners.click()`,context);
  assert.equal(vm.runInContext("$('observerRail').classList.contains('hidden')&&$('spectatorRail').classList.contains('collapsed')&&document.body.classList.contains('rail-collapsed')",context),true);
  vm.runInContext("$('recordsViewport').scrollTop=0;$('recordsViewport').listeners.scroll()",context);
  assert.equal(vm.runInContext('recordScroll.speeches.top',context),123);
  assert.equal(vm.runInContext('spectatorPrefs.narratorEnabled',context),true);
  assert.equal(JSON.parse(saved.get('nightfall-spectator-v1')).railOpen,false);
  vm.runInContext(`$('${id}').listeners.click()`,context);
  assert.equal(vm.runInContext("$('observerRail').classList.contains('hidden')||$('spectatorRail').classList.contains('collapsed')",context),false);
  assert.equal(vm.runInContext("$('recordsViewport').scrollTop",context),123);
  assert.equal(vm.runInContext("$('activityViewport').scrollTop",context),77);
  assert.equal(vm.runInContext("$('commentaryViewport').scrollTop",context),91);
  assert.equal(vm.runInContext('recordSeat',context),'2');
 }
 vm.runInContext("$('railClose').listeners.click()",context);
 context.seatEvent={target:{closest:selector=>selector==='[data-replay]'?null:{closest:()=>({dataset:{player:'4'}})}}};
 vm.runInContext("$('playersGrid').listeners.click(seatEvent)",context);
 assert.equal(vm.runInContext('spectatorPrefs.railOpen',context),true);assert.equal(vm.runInContext('recordSeat',context),'4');
 assert.equal(vm.runInContext('observerEvents.length',context),1);
 const html=fs.readFileSync('index.html','utf8');assert.doesNotMatch(html,/interaction-box|interactionTarget|sendShout|shoutInput|互动一下|飞刀|表扬|举杯|喊话/);
 assert.doesNotMatch(fs.readFileSync('app.js','utf8'),/function interaction\(|sendShout|shoutInput|interactionTarget/);
});

test('六与十二人女巫完整解说串行播放，普通视角字幕历史导出和专属音效隐藏',async()=>{
 for(const count of [6,12])for(const perspective of ['god','public']){
  const {context}=setup(new Map(),false),heard=[],sounds=[];const witch=count===6?3:5,target=count===6?4:8;
  context.hearWitch=async text=>{heard.push(text);return true};context.effectWitch=(...args)=>sounds.push(args);
  vm.runInContext(`reset(${count});game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[${count}][i]);setPerspective('${perspective}');turnDelay=0;spectatorPrefs.narratorEnabled=true;speakText=hearWitch;effects.play=effectWitch;decision=async(id)=>id===${witch}?{save:true,poison:null}:id<${count===6?2:4}?{target:${target}}:{target:0}`,context);
  await vm.runInContext('runNight()',context);
  const text=vm.runInContext("$('commentaryList').innerHTML+$('commentaryText').textContent+JSON.stringify(spectatorExport())",context);
  if(perspective==='god'){
   const open=heard.findIndex(t=>t.includes('女巫请睁眼')),close=heard.findIndex(t=>t.includes('女巫请闭眼'));
   assert.ok(open>=0&&close>open);assert.match(heard[open],/解药剩余一瓶，毒药剩余一瓶/);assert.match(heard[close],new RegExp(`${witch+1} 号女巫对 \\d+ 号 使用解药`));assert.match(text,/抵挡本夜的狼刀/);
  }else{assert.ok(heard.every(t=>!/女巫请睁眼|解药剩余|使用解药/.test(t)));assert.doesNotMatch(text,/witchState|witchOutcome|使用解药|解药剩余|女巫请睁眼/);assert.ok(!sounds.some(a=>JSON.stringify(a).includes('save')))}
  assert.equal(vm.runInContext(`game.players[${target}].alive`,context),true);
 }
});

test('完整发言跨轮保留，按席位筛选，保留 PK、时间和独立重播索引',()=>{
  const {context}=setup();
  vm.runInContext("for(let i=0;i<150;i++){game.round=1+Math.floor(i/12);game.pk=i%2?[0,1]:null;addSpeech(i%12,'公开发言 '+i)}recordSeat='0';renderTranscript()",context);
  assert.equal(vm.runInContext('transcript.length',context),150);
  assert.equal(vm.runInContext('filteredSpeeches().length',context),13);
  const html=vm.runInContext("$('transcript').innerHTML",context);
  assert.match(html,/公开发言 0<|公开发言 0</);assert.match(html,/公开发言 144/);assert.match(html,/data-record-replay="144"/);
  vm.runInContext("recordSeat='1';renderTranscript()",context);
  assert.match(vm.runInContext("$('transcript').innerHTML",context),/PK发言/);
  assert.doesNotMatch(vm.runInContext("$('transcript').innerHTML",context),/公开发言 144/);
  vm.runInContext('reset()',context);assert.equal(vm.runInContext('transcript.length',context),0);
});

test('查看旧记录不跳底，新消息提示可回到最新，左右三栏独立保留位置',()=>{
  const {context}=setup();
  vm.runInContext("addSpeech(0,'第一条');Object.assign($('recordsViewport'),{scrollTop:20,scrollHeight:1000,clientHeight:200});$('recordsViewport').listeners.scroll();addSpeech(1,'第二条')",context);
  assert.equal(vm.runInContext("$('recordsViewport').scrollTop",context),20);
  assert.equal(vm.runInContext("$('newRecordsBtn').classList.contains('hidden')",context),false);
  assert.match(vm.runInContext("$('newRecordsBtn').textContent",context),/1 条新记录/);
  vm.runInContext("Object.assign($('commentaryViewport'),{scrollTop:30,scrollHeight:700,clientHeight:200});$('commentaryViewport').listeners.scroll();addObserver({round:1,publicText:'新旁白',godText:'新旁白'})",context);
  assert.equal(vm.runInContext("$('recordsViewport').scrollTop",context),20);
  vm.runInContext('jumpToLatest()',context);
  assert.equal(vm.runInContext("$('recordsViewport').scrollTop",context),1000);
  assert.equal(vm.runInContext("$('newRecordsBtn').classList.contains('hidden')",context),true);
});

test('无声或失败阅读时长按字数计算并封顶280秒，气泡结束收起且暂停停止脉动',async()=>{
  const observer=require('./observer.js');assert.equal(observer.readingTime('短句'),4000);assert.equal(observer.readingTime('字'.repeat(40)),8000);assert.equal(observer.readingTime('字'.repeat(500)),100000);assert.equal(observer.readingTime('字'.repeat(1400)),280000);assert.equal(observer.readingTime('字'.repeat(2000)),280000);
  const {context}=setup();let done,wait;
  context.hold=(ms)=>{wait=ms;return new Promise(r=>done=r)};
  vm.runInContext("voiceEnabled=false;busy=true;presentationWait=hold",context);
  const reading=vm.runInContext("showPlayerSpeech({id:0,text:'字'.repeat(40)})",context);
  await until(()=>!!done);
  assert.equal(wait,8000);assert.equal(vm.runInContext('speechBubble.id',context),0);
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/speaking pulsing/);
  vm.runInContext('togglePause()',context);assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML",context),/pulsing/);
  vm.runInContext('togglePause()',context);done();await reading;assert.equal(vm.runInContext('speechBubble',context),null);
  vm.runInContext("voiceEnabled=true;speakText=async()=>false",context);
  const failed=vm.runInContext("showPlayerSpeech({id:0,text:'失败后继续阅读'})",context);await until(()=>wait===4000);done();await failed;
});

test('生成、播放、暂停和短尾声有独立气泡状态，下一位立即替换',async()=>{
  const {context}=setup(new Map(),false,false),{pending,audios}=installNatural(context,{hold:true});let done,delay;
vm.runInContext('voiceEnabled=true',context);
  context.hold=(ms)=>{delay=ms;return new Promise(r=>done=r)};
  vm.runInContext('presentationWait=hold;busy=true',context);
  const playing=vm.runInContext("showPlayerSpeech({id:0,text:'第一位发言'})",context);
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/准备声音/);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML",context),/speaking pulsing/);
  pending[0]();await until(()=>audios.length===1);
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/speaking pulsing/);
  vm.runInContext('togglePause()',context);assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/已暂停/);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML",context),/speaking pulsing/);
  vm.runInContext('togglePause()',context);audios[0].onended();await until(()=>delay===250);
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/发言结束/);done();await playing;
  assert.equal(vm.runInContext("$('speechBubble').classList.contains('hidden')",context),true);
});

test('重播在对局暂停时正常结束，不抢占自动对局的继续等待',async()=>{
  const {context}=setup(),{spoken}=installSpeech(context);vm.runInContext("busy=true;paused=true;addSpeech(0,'重播公开发言')",context);
vm.runInContext('voiceEnabled=true',context);
  let resumed=false;const waiting=vm.runInContext('waitForTurn(epoch,0)',context).then(()=>resumed=true);
  const replay=vm.runInContext('replaySpeech(0)',context);spoken[0].onend();await replay;
  assert.equal(vm.runInContext('speechBubble',context),null);assert.equal(resumed,false);
  vm.runInContext('togglePause()',context);await waiting;assert.equal(resumed,true);
});

test('阅读计时暂停时冻结，重置立即取消等待和旧气泡',async()=>{
  const {context}=setup();vm.runInContext('busy=true;paused=true;voiceEnabled=false;presentationDelayScale=1',context);
  let ended=false;const waiting=vm.runInContext('presentationWait(30,epoch)',context).then(()=>ended=true);
  await new Promise(r=>setTimeout(r,130));assert.equal(ended,false);
  vm.runInContext('togglePause()',context);await waiting;
  const reading=vm.runInContext("showPlayerSpeech({id:0,text:'长时间阅读的对白'})",context);await new Promise(setImmediate);
  vm.runInContext('reset(12)',context);await reading;
  assert.equal(vm.runInContext('speechBubble',context),null);assert.equal(vm.runInContext('presentationWaiters.size',context),0);
});

test('旁白串行等待结束再播放下一条，独立云扬音色，重复同步不会重复入队',async()=>{
  const {context}=setup(new Map(),false,false),{audios,requests}=installNatural(context);
  vm.runInContext('game.start();syncLogs();syncLogs();spectatorPrefs.narratorEnabled=true;busy=true',context);
  assert.equal(vm.runInContext('commentaryQueue.length',context),1);
  vm.runInContext("addObserver({kind:'discussion',round:1,publicText:'开始讨论',godText:'开始讨论'})",context);
  const playing=vm.runInContext('flushCommentary(epoch)',context);
  await until(()=>audios.length===1);assert.equal(requests.length,1);assert.equal(requests[0].body.voice,'zh-CN-YunyangNeural');assert.equal(requests[0].body.style,'calm');
  assert.equal(requests[0].body.speed,1);audios[0].onended();await until(()=>audios.length===2);
  assert.equal(audios[0].src,'');audios[1].onended();await playing;assert.equal(vm.runInContext('commentaryQueue.length',context),0);
});

test('旁白暂停恢复、单独关闭，失败保留字幕，切换视角停止旧声音不重播',async()=>{
  const {context}=setup(new Map(),false,false),{audios,requests}=installNatural(context);
  vm.runInContext("busy=true;spectatorPrefs.narratorEnabled=true;addObserver({round:1,publicText:'公开夜间流程',godText:'私有查验结果'})",context);
  const playing=vm.runInContext('flushCommentary(epoch)',context);await until(()=>audios.length===1);
  vm.runInContext('toggleDialogueVoice()',context);assert.equal(audios[0].src.startsWith('blob:'),true);
  vm.runInContext('togglePause()',context);assert.equal(audios[0].pauses,1);
  vm.runInContext('togglePause()',context);assert.equal(audios[0].plays,2);
  vm.runInContext("setPerspective('public')",context);await playing;assert.equal(audios[0].src,'');assert.equal(requests.length,1);
  assert.equal(vm.runInContext("$('commentaryText').textContent",context),'公开夜间流程');
  context.fetch=async()=>({ok:false,json:async()=>({error:{message:'失败'}})});
  vm.runInContext("addObserver({round:1,publicText:'下一条字幕',godText:'下一条字幕'})",context);
  await vm.runInContext('flushCommentary(epoch)',context);assert.equal(vm.runInContext("$('commentaryText').textContent",context),'下一条字幕');
});

test('旁白生成中重置隔离迟到响应并清空队列与历史',async()=>{
  const {context}=setup(new Map(),false,false),{pending,audios}=installNatural(context,{hold:true});
  vm.runInContext("spectatorPrefs.narratorEnabled=true;addObserver({round:1,publicText:'第一条',godText:'第一条'});addObserver({round:1,publicText:'第二条',godText:'第二条'})",context);
  const old=vm.runInContext('flushCommentary(epoch)',context);await until(()=>pending.length===1);vm.runInContext('reset()',context);pending[0]();await old;await new Promise(setImmediate);
  assert.equal(audios.length,0);assert.equal(vm.runInContext('observerEvents.length+commentaryQueue.length',context),0);assert.equal(vm.runInContext('currentCommentary',context),null);
});

test('两种视角统一投影字幕、历史、行动高亮和导出，普通观战终局前无角色表',async()=>{
  const {context,requests}=setup();
  vm.runInContext("game.phase='night';game.players[0].role='狼人';activeSeat=0;actionText='1 号正在秘密行动';addObserver({round:1,publicText:'天亮了，平安夜',godText:'1 号守卫守护 5 号。私有信息标记',result:{secret:'observer-only'}});currentCommentary=observerEvents[0];setPerspective('public')",context);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML",context),/acting |预言家|女巫|狼人|API 连接中/);
  assert.doesNotMatch(vm.runInContext("$('actionPanel').innerHTML",context),/1 号/);
  assert.doesNotMatch(vm.runInContext("$('commentaryList').innerHTML+$('commentaryText').textContent+JSON.stringify(spectatorExport())",context),/私有信息标记|observer-only|守护 5/);
  assert.equal(vm.runInContext("'roles' in spectatorExport()",context),false);
  vm.runInContext("setPerspective('god')",context);assert.match(vm.runInContext("$('commentaryList').innerHTML",context),/私有信息标记/);
  await vm.runInContext("decision(8,'vote')",context);assert.doesNotMatch(JSON.stringify(requests.at(-1).messages),/私有信息标记|observer-only|commentary|guardTarget/);
  vm.runInContext("game.phase='ended';setPerspective('public')",context);assert.equal(vm.runInContext('spectatorExport().roles.length',context),12);
});

test('夜间 API 失败的私有席位与原因不会通过普通观战动态泄露',async()=>{
  const {context}=setup();vm.runInContext("game.phase='night';setPerspective('public')",context);
  context.fetch=async()=>({ok:false,status:401,json:async()=>({error:{code:'AUTH_FAILED',message:'专用接口故障'}})});const pending=vm.runInContext("decision(8,'night')",context);await until(()=>vm.runInContext('!!apiWaiting',context));
  assert.doesNotMatch(vm.runInContext("$('actionPanel').innerHTML",context),/9 号|专用接口故障/);
  vm.runInContext("setPerspective('god');renderAction()",context);assert.match(vm.runInContext("$('actionPanel').innerHTML",context),/9 号|专用接口故障/);
  vm.runInContext('reset()',context);await pending;
});

test('夜间说明只取规则引擎确认结果，无效或旧查验不被当作新行动',()=>{
  const Observer=require('./observer.js'),g=new Nightfall.Game(12).start();g.players.forEach((p,i)=>p.role=Nightfall.ROLES[12][i]);
  g.players[8].alive=false;g.knowledge[4]={8:'好人'};
  const result=g.resolveNight({4:{target:8},5:{save:false,poison:5},7:{target:7}},null);
  assert.equal(result.seerCheck,null);assert.equal(result.poisoned,null);assert.equal(result.guardTarget,7);
  const e=Observer.commentary(g.logs.find(l=>/^天亮了/.test(l.text)),result);
  assert.doesNotMatch(e.godText,/查验 9|使用毒药/);assert.match(e.godText,/8 号守卫守护了 8 号/);assert.doesNotMatch(e.publicText,/守护|预言家|未使用药水/);
  const next=new Nightfall.Game(6).start();next.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);
  assert.deepEqual(next.resolveNight({2:{target:0}},null).seerCheck,{id:2,target:0,result:'狼人'});
});

test('完整自动对局关键旁白按事件顺序播放，旁白不进入玩家上下文',async()=>{
  const {context}=setup();prepareAuto(context,12);const seen=[];
  context.capture=(text)=>{seen.push(text);return Promise.resolve(true)};
  vm.runInContext('spectatorPrefs.narratorEnabled=true;voiceEnabled=false;speakText=capture;game.random=()=>.9999',context);
  await vm.runInContext('start()',context);
  assert.match(seen[0],/随机发牌/);assert.match(seen[1],/第 1 夜开始/);assert.ok(seen.some(t=>/天亮了/.test(t)));assert.ok(seen.some(t=>/开始公开投票/.test(t)));assert.match(seen.at(-1),/阵营获胜/);
  assert.equal(seen.length,vm.runInContext('observerEvents.length',context));
  assert.doesNotMatch(vm.runInContext('JSON.stringify(game.context(8))',context),/守护了|随机发牌完成|夜间角色将依次/);
});

test('只随机一次，翻牌按席位揭晓且翻牌期间没有任何 Agent 行动',async()=>{
  const {context}=setup(new Map(),false);let starts=0,actions=0;const frames=[];
  context.onStart=()=>starts++;context.onAction=()=>actions++;
  context.frame=()=>{frames.push(vm.runInContext("({stage:dealState?.stage,revealed:dealState?.revealed,phase:game.phase,html:$('playersGrid').innerHTML})",context));return Promise.resolve(true)};
  vm.runInContext('const realStart=game.start.bind(game);game.start=()=>{onStart();return realStart()};presentationWait=frame;runGame=async()=>{onAction()}',context);
  await vm.runInContext('start()',context);
  assert.equal(starts,1);assert.equal(actions,1);
  const reveal=frames.filter(f=>f.stage==='reveal');assert.equal(reveal.length,7);
  assert.equal(reveal[0].revealed,0);assert.doesNotMatch(reveal[0].html,/role-wolf|role-seer|role-witch/);
  assert.equal(reveal.at(-1).revealed,6);
  assert.equal(vm.runInContext('sceneMotion',context),null);
});

test('普通翻牌不包含真实身份，切换视角不会中断发牌或触发行动',async()=>{
  const {context}=setup(new Map(),false);let release;context.flipWait=()=>new Promise(r=>release=r);
  vm.runInContext("game.start();presentationWait=flipWait;setPerspective('public')",context);
  const playing=vm.runInContext('revealDeal(epoch)',context);
  assert.doesNotMatch(vm.runInContext("$('sceneEffect').innerHTML+$('playersGrid').innerHTML",context),/狼人|女巫|预言家/);
  vm.runInContext("setPerspective('god')",context);assert.equal(vm.runInContext('sceneMotion.kind',context),'reveal');
  vm.runInContext('reset()',context);release(false);await playing;
  assert.equal(vm.runInContext('sceneMotion',context),null);
});

test('夜间分步顺序来自规则校验，行动展示前不结算死亡，普通观战无私有旁白与目标',async()=>{
  for(const mode of ['god','public']){
    const {context}=setup(new Map(),false);const shown=[];
    context.capture=()=>{shown.push(vm.runInContext('({alive:game.alive().length,kind:currentCommentary.kind,phase:game.phase})',context));return Promise.resolve(true)};
    vm.runInContext("reset(12);game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[12][i]);turnDelay=0;speakText=capture;spectatorPrefs.narratorEnabled=true;spectatorPrefs.perspective='"+mode+"';localDecision=(id)=>id===7?{target:8}:id<4?{target:8}:id===4?{target:0}:{save:false,poison:6}",context);
    await vm.runInContext('runNight(epoch)',context);
    assert.equal(vm.runInContext('game.players[8].alive',context),true);
    assert.equal(vm.runInContext('game.players[6].alive',context),false);
    assert.equal(vm.runInContext('game.pendingHunter',context),null);
    const kinds=Array.from(vm.runInContext('observerEvents.filter(e=>e.private).map(e=>e.kind)',context));
    assert.deepEqual(kinds,['night-cue','guard','night-cue','wolf','night-cue','seer','night-cue','poison']);
    if(mode==='god'){assert.equal(shown.length,8);assert.ok(shown.every(x=>x.alive===12&&x.phase==='night'))}
    else{assert.equal(shown.length,0);assert.doesNotMatch(vm.runInContext("JSON.stringify(spectatorExport().commentary)+$('commentaryList').innerHTML",context),/守护|毒药|查验|选择袭击/)}
    assert.doesNotMatch(vm.runInContext('JSON.stringify(game.context(8))',context),/private|godText|最终存亡|守护目标/);
  }
});

test('每夜闭眼与天亮睁眼口令完整，角色口令在请求前播放，结果后闭眼',async()=>{
  const observer=require('./observer.js');
  for(const round of [1,2,3]){
    const event=observer.commentary({text:'第 '+round+' 夜开始。'+(round===1?'天黑请闭眼。':''),round,phase:'night'});
    assert.equal((event.godText.match(/天黑请闭眼/g)||[]).length,1);
  }
  assert.match(observer.commentary({text:'天亮了。昨夜是平安夜。',round:1,phase:'discussion'}).publicText,/天亮了，请睁眼/);
  const {context}=setup(new Map(),false),order=[];
  context.hear=text=>{order.push(text);return Promise.resolve(true)};
  context.choose=id=>{order.push('行动:'+vm.runInContext('game.players['+id+'].role',context));return Promise.resolve({target:null,save:false,poison:null})};
  vm.runInContext('game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);speakText=hear;takeTurn=choose;spectatorPrefs.narratorEnabled=true',context);
  await vm.runInContext('runNight(epoch)',context);
  for(const role of ['狼人','预言家','女巫']){
    const cue=order.findIndex(t=>t.startsWith(role+'请睁眼'));
    const action=role==='狼人'?order.findIndex(t=>/提议袭击|没有形成有效的袭击目标/.test(t)):order.findIndex(t=>t==='行动:'+role);
    const closed=role==='狼人'?action:order.findIndex((t,i)=>i>action&&t.includes(role+'请闭眼'));
    assert.ok(cue>=0&&cue<action&&(role==='狼人'?closed>=action:closed>action),role+': '+order.join('|'));
  }
  assert.ok(order.some(t=>t.includes('狼人请杀人')));
});

test('重置发生在夜间口令时，旧回调不再请求角色行动',async()=>{
  const {context}=setup(new Map(),false);let release,calls=0;
  context.waitCue=()=>new Promise(r=>release=r);context.choose=()=>{calls++;return Promise.resolve({})};
  vm.runInContext('game.start();speakText=waitCue;takeTurn=choose;spectatorPrefs.narratorEnabled=true',context);
  const running=vm.runInContext('runNight(epoch)',context);
  await until(()=>!!release);vm.runInContext('reset()',context);release(true);await running;
  assert.equal(calls,0);assert.equal(vm.runInContext('observerEvents.length',context),0);
});

test('逐席唱票说明目标或弃票，完成收票后播报且记录不进入玩家上下文',async()=>{
  const {context}=setup(new Map(),false),spoken=[];let collected=0;
  context.choose=id=>{collected++;return {target:id===0?null:0}};
  context.hear=text=>{spoken.push({text,collected});return Promise.resolve(true)};
  vm.runInContext('game.start();game.phase="discussion";game.openVoting();localStoryDecision=choose;speakText=hear;spectatorPrefs.narratorEnabled=true',context);
  await vm.runInContext('vote()',context);
  assert.ok(spoken.every(s=>s.collected===6));assert.equal(spoken.length,6);
  assert.equal(spoken[0].text,'1 号玩家弃票。');assert.equal(spoken[4].text,'5 号玩家投给 1 号。');
  const events=JSON.parse(vm.runInContext('JSON.stringify(observerEvents.filter(e=>e.kind==="vote-reveal"))',context));
  assert.deepEqual(events.map(e=>e.voter),[0,1,2,3,4,5]);
  assert.doesNotMatch(vm.runInContext('JSON.stringify(game.context(2))',context),/vote-reveal|godText|voter/);
  assert.match(vm.runInContext('seatDecorations(game.players[4])',context),/seat-overlay.*投给 1 号/);
});

test('出局原因使用引擎结果，六人与十二人文字和标记一致，普通观战隐藏狼刀与毒药',()=>{
  for(const count of [6,12]){
    const {context}=setup(new Map(),false);
    vm.runInContext('reset('+count+');game.start();game.phase="discussion";["wolf","vote","poison","hunter"].forEach((cause,i)=>Object.assign(game.players[i],{alive:false,cause}));renderPlayers()',context);
    let html=vm.runInContext("$('playersGrid').innerHTML",context);
    for(const [kind,label]of [['wolf','遭狼袭'],['vote','投票放逐'],['poison','中毒出局'],['hunter','猎人击中']]){assert.match(html,new RegExp('eliminated-'+kind));assert.match(html,new RegExp(label))}
    vm.runInContext("setPerspective('public')",context);html=vm.runInContext("$('playersGrid').innerHTML",context);
    assert.doesNotMatch(html,/遭狼袭|中毒出局|eliminated-wolf|eliminated-poison/);
    assert.equal((html.match(/eliminated-night/g)||[]).length,2);assert.match(html,/投票放逐/);assert.match(html,/猎人击中/);
    vm.runInContext("game.phase='ended';renderPlayers()",context);html=vm.runInContext("$('playersGrid').innerHTML",context);assert.match(html,/遭狼袭/);assert.match(html,/中毒出局/);
    vm.runInContext('reset()',context);assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML",context),/elimination-mark|eliminated-/);
  }
});

test('投票收齐后才按座位揭示，票数与引擎一致，PK 候选人排除且第二轮清空',async()=>{
  const {context}=setup(new Map(),false);const collected=[],frames=[];
  context.choose=id=>{collected.push(vm.runInContext('JSON.stringify(votePresentation)',context));return {target:[2,2,3,2,3,3][id]}};
  context.voteFrame=()=>{frames.push(vm.runInContext('JSON.stringify(votePresentation)',context));return Promise.resolve(true)};
  vm.runInContext('game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);game.phase="discussion";game.openVoting();localStoryDecision=(...args)=>choose(...args);presentationWait=voteFrame;aiSpeeches=async()=>{}',context);
  await vm.runInContext('vote()',context);
  assert.ok(collected.every(x=>Object.keys(JSON.parse(x).votes).length===0));
  const reveal=frames.map(JSON.parse).filter(x=>x&&Object.keys(x.votes).length);
  assert.equal(Object.keys(reveal[0].votes).length,1);
  assert.deepEqual(reveal.at(-1).counts,{2:3,3:3});
  assert.deepEqual(Array.from(vm.runInContext('game.pk',context)),[2,3]);
  collected.length=0;frames.length=0;
  context.choose=id=>{collected.push(vm.runInContext('JSON.stringify(votePresentation)',context));return {target:id%2?3:2}};
  await vm.runInContext('vote()',context);
  const begin=JSON.parse(collected[0]);assert.equal(begin.states[2],'excluded');assert.equal(begin.states[3],'excluded');assert.deepEqual(begin.counts,{});
  assert.equal(vm.runInContext('game.votes[2]',context),null);assert.equal(vm.runInContext('game.votes[3]',context),null);
  assert.equal(vm.runInContext('game.alive().length',context),6);
});

test('视角切换立即清除夜间目标，私有记录不留空行，胜方已出局成员仍高亮',async()=>{
  const {context}=setup(new Map(),false);
  vm.runInContext("game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);addObserver({private:true,kind:'poison',actors:[3],target:0,round:1,godText:'秘密用药',publicText:''},false);nightFocus=observerEvents[0];currentCommentary=nightFocus;renderAll()",context);
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/action-target/);
  vm.runInContext("setPerspective('public')",context);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML+$('commentaryList').innerHTML+$('commentaryText').textContent",context),/action-target|秘密用药|narrator-record/);
  vm.runInContext("game.phase='ended';game.winner='狼人';game.players[0].alive=false;renderPlayers()",context);
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/dead .*winner-seat/);
  assert.equal((vm.runInContext("$('playersGrid').innerHTML",context).match(/winner-seat/g)||[]).length,2);
});

test('三种试听文本不改变用户音色，只生成整句一次，嘴部锚点覆盖六位形象',async()=>{
  const {context}=setup(new Map(),false,false),{audios,requests}=installNatural(context);
  vm.runInContext('openAgent(0)',context);
  for(const option of ['analysis','question','defense']){
    context.option=option;vm.runInContext("$('voicePreviewTextInput').value=option",context);
    const playing=vm.runInContext('previewVoice()',context);await until(()=>audios.length===requests.length&&audios.length>0);
    assert.equal(requests.at(-1).body.text,vm.runInContext('voicePreviewTexts[option]',context));audios.at(-1).onended();await playing;
  }
  assert.equal(requests.length,3);
  assert.equal(Object.keys(require('./manor.js').mouths).length,12);
  assert.ok(Object.values(require('./manor.js').mouths).every(p=>p.x>0&&p.x<1&&p.y>0&&p.y<1));
});

test('夜间口令驱动闭眼和行动者睁眼，普通观战不泄露身份，天亮恢复',()=>{
 const {context}=setup();
 vm.runInContext("beginEyeEvent({kind:'night'});",context);
 assert.equal(vm.runInContext('game.players.every(eyesClosed)',context),true);
 vm.runInContext("beginEyeEvent({kind:'night-cue',actors:[0,1]})",context);
 assert.deepEqual(Array.from(vm.runInContext('game.players.map(eyesClosed)',context)),[false,false,true,true,true,true,true,true,true,true,true,true]);
 vm.runInContext("setPerspective('public')",context);
 assert.equal(vm.runInContext('game.players.every(eyesClosed)',context),true);
 assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML",context),/data-eyes="open"/);
 vm.runInContext("setPerspective('god');endEyeEvent({kind:'wolf'})",context);
 assert.equal(vm.runInContext('game.players.every(eyesClosed)',context),true);
 vm.runInContext("beginEyeEvent({kind:'dawn'});game.players[0].alive=false",context);
 assert.equal(vm.runInContext('eyesClosed(game.players[0])&&!eyesClosed(game.players[1])',context),true);
 vm.runInContext('reset()',context);assert.equal(vm.runInContext('eyeNight||nightAwake.length>0',context),false);
});
test('眨眼时间跨重绘保持连续，暂停冻结，普通视角立即遮蔽，闭眼图失败保留人物',()=>{
 const {context}=setup();vm.runInContext('let eyeTestNow=1000;performance={now:()=>eyeTestNow};resetEyes();eyeVisual(game.players[0]);eyeTestNow+=100;eyeClock();paused=true;eyeClock();eyeTestNow+=900;',context);
 assert.equal(vm.runInContext('eyeClock()',context),100);
 vm.runInContext('paused=false;eyeClock();eyeTestNow+=50',context);assert.equal(vm.runInContext('eyeClock()',context),150);
 vm.runInContext("beginEyeEvent({kind:'night-cue',actors:[0]});eyeVisual(game.players[0]);spectatorPrefs.perspective='public'",context);
 assert.equal(vm.runInContext("eyeVisual(game.players[0]).classes",context),'eyes-closed');
 vm.runInContext("failedEyePortraits.add('portrait-01')",context);assert.equal(vm.runInContext("eyeMarkup(game.players[0],{id:'portrait-01'})",context),'');
});
test('实际夜间行动期间只有当前角色睁眼，闭眼不改变Agent上下文，旧旁白不能跨重置恢复',async()=>{
 const {context}=setup();vm.runInContext("game.phase='night';turnDelay=0;let eyeActions=[];decision=async(id,task,extra)=>{eyeActions.push({id,open:game.players.filter(p=>!eyesClosed(p)).map(p=>p.id),context:game.context(id)});return localDecision(id,task,extra)}",context);
 await vm.runInContext('runNight()',context);
 const observations=vm.runInContext('eyeActions',context);assert.ok(observations.length>0);
 for(const step of observations){assert.ok(step.open.includes(step.id));assert.equal(vm.runInContext('game.players.filter(p=>'+JSON.stringify(Array.from(step.open))+'.includes(p.id)).every(p=>p.role===game.players['+step.id+'].role)',context),true);assert.doesNotMatch(JSON.stringify(step.context),/nightAwake|eyeNight|eyeStates/)}
 assert.equal(vm.runInContext('nightAwake.length',context),0);
 vm.runInContext("spectatorPrefs.narratorEnabled=true;let releaseEye;commentaryQueue=[];speakText=()=>new Promise(r=>releaseEye=r);addObserver({kind:'night-cue',private:true,actors:[0],godText:'请睁眼'});let oldEyeFlush=flushCommentary(epoch)",context);
 await until(()=>vm.runInContext("typeof releaseEye==='function'",context));
 vm.runInContext('reset();releaseEye(true)',context);await vm.runInContext('oldEyeFlush',context);
 assert.equal(vm.runInContext('eyeNight||nightAwake.length>0',context),false);
});
test('六人个人狼刀同刀、平票、单狼、放弃和无效目标与女巫及天亮结算一致',async()=>{
  for(const spec of [
    {targets:[4,4],victim:4,tie:false},
    {targets:[4,5],victim:5,tie:true},
    {targets:[4,null],victim:4,tie:false,deadWolf:true},
    {targets:[null,null],victim:null,tie:false},
    {targets:[1,99],victim:null,tie:false},
    {targets:[4,4],victim:4,tie:false,save:true}
  ]){
    const {context}=setup(new Map(),false),spoken=[],choosing=[];let witchVictim,rolls=0;
    context.spec=spec;context.roll=()=>{rolls++;return .99};
    context.choose=async(id,task,extra)=>{
      if(id<2)choosing.push(vm.runInContext('seatDecorations(game.players['+id+'])',context));
      if(id===3)witchVictim=extra.victim;
      return id<2?{target:spec.targets[id]}:id===3?{save:!!spec.save,poison:null}:{target:0};
    };
    context.hear=async text=>{spoken.push(text);return true};
    vm.runInContext("game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);if(spec.deadWolf)game.players[1].alive=false;game.random=roll;decision=choose;speakText=hear;turnDelay=0;spectatorPrefs.narratorEnabled=true",context);
    await vm.runInContext('runNight(epoch)',context);
    const event=vm.runInContext("observerEvents.find(e=>e.kind==='wolf')",context);
    assert.equal(event.target,witchVictim);
    assert.equal(event.wolfChoices.length,spec.deadWolf?1:2);assert.equal(event.private,true);
    assert.ok(event.wolfChoices.every(choice=>choice.status==='selected'||choice.status==='abstained'||choice.status==='invalid'));
    assert.ok(choosing.every(html=>html.includes('正在选刀')));
    assert.equal(spoken.filter(text=>/提议袭击|放弃袭击|未形成有效选择/.test(text)).length,1);
    if(event.target!==null)assert.match(event.godText,new RegExp('今晚袭击 '+(event.target+1)+' 号'));
    assert.equal(vm.runInContext('wolfPresentation',context),null);
    assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML",context),/wolf-choice/);
  }
});

test('个人选刀在上帝历史和导出保留，普通观战及实际 Agent 请求不增加观众信息',async()=>{
  const {context,requests}=setup(new Map(),false);const shown=[];
  context.fetch=async(url,request)=>{requests.push(JSON.parse(request.body));return {ok:true,json:async()=>({choices:[{message:{content:'{"speech":"请说明判断依据。"}'}}]})}};
  context.capture=async text=>{shown.push(text);return true};
  vm.runInContext("var productionDecision=decision;game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[6][i]);turnDelay=0;spectatorPrefs.narratorEnabled=true;speakText=capture;decision=async(id)=>id<2?{target:id+4}:id===3?{save:false,poison:null}:{target:0}",context);
  await vm.runInContext('runNight()',context);
  assert.match(vm.runInContext("$('commentaryList').innerHTML+JSON.stringify(spectatorExport())",context),/1 号狼人提议袭击 \d+ 号/);
  vm.runInContext("setPerspective('public')",context);
  assert.doesNotMatch(vm.runInContext("$('playersGrid').innerHTML+$('commentaryText').textContent+$('commentaryList').innerHTML+JSON.stringify(spectatorExport())",context),/提议袭击|票数相同|wolfChoices|wolf-choice/);
  vm.runInContext("decision=productionDecision;profiles[0].control='api';profiles[0].endpoint='https://chat.test';profiles[0].model='test'",context);
  await vm.runInContext("decision(0,'speech')",context);
  assert.equal(requests.length,1);assert.doesNotMatch(JSON.stringify(requests[0].messages),/wolfChoices|提议袭击|票数相同|godText|wolf-choice/);
  vm.runInContext("setPerspective('god')",context);
  assert.match(vm.runInContext("$('commentaryList').innerHTML",context),/1 号狼人提议袭击 \d+ 号/);
});

test('普通观战全夜不展示个人狼刀，不播放私有合并旁白，六与十二人一致',async()=>{
  for(const count of [6,12]){
    const {context}=setup(new Map(),false),hints=[],spoken=[];
    context.inspect=async id=>{hints.push(vm.runInContext("$('playersGrid').innerHTML",context));return {target:id<2?4:0,save:false,poison:null}};
    context.hear=async text=>{spoken.push(text);return true};
    vm.runInContext(`reset(${count});game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[${count}][i]);setPerspective('public');turnDelay=0;decision=inspect;speakText=hear;spectatorPrefs.narratorEnabled=true`,context);
    await vm.runInContext('runNight()',context);
    assert.ok(hints.every(html=>!/wolf-choice|正在选刀|提议袭击/.test(html)));
    const event=vm.runInContext("observerEvents.find(e=>e.kind==='wolf')",context);
    assert.equal(event.wolfChoices.length,count===12?4:2);assert.equal(spoken.length,0);assert.doesNotMatch(vm.runInContext('JSON.stringify(spectatorExport())',context),/提议袭击|wolfChoices/)
  }
});

test('十二人四狼分刀只确定一次目标，个人明细与女巫及结算一致',async()=>{
 const {context}=setup(new Map(),false),hints=[],spoken=[];let rolls=0,victim;
 context.roll12=()=>{rolls++;return .99};context.pick12=async(id,task,extra)=>{if(id<4)hints.push(vm.runInContext('seatDecorations(game.players['+id+'])',context));if(id===5)victim=extra.victim;return id<4?{target:id<2?8:9}:id===7?{target:10}:id===5?{save:false,poison:null}:{target:0}};
 context.hear12=async text=>{spoken.push(text);return true};
 vm.runInContext("reset(12);game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[12][i]);game.random=roll12;decision=pick12;speakText=hear12;turnDelay=0;spectatorPrefs.narratorEnabled=true",context);
 await vm.runInContext('runNight()',context);const e=vm.runInContext("observerEvents.find(e=>e.kind==='wolf')",context);
 assert.equal(e.wolfChoices.length,4);assert.equal(e.target,victim);assert.ok(e.target===null||rolls>=1);assert.ok(hints.every(h=>h.includes('正在选刀')));assert.ok(spoken.filter(t=>/提议袭击/.test(t)).length>=1);if(e.target!==null)assert.equal(vm.runInContext('game.players['+e.target+'].alive',context),false);
 vm.runInContext("setPerspective('public')",context);assert.doesNotMatch(vm.runInContext("$('commentaryList').innerHTML+JSON.stringify(spectatorExport())+$('playersGrid').innerHTML",context),/wolfChoices|提议袭击|票数相同|wolf-choice/);
});

test('十二人 Agent 不接收人物秘密，剧情选择按人数保存并映射去重项',async()=>{
 const {context}=setup(new Map(),false,true,true),S=require('./scenario.js'),s={...S.bloodMoonSample(12),id:'12-story',version:1},sent=[];
 s.characters.forEach((c,i)=>c.secret='ONLY_PRIVATE_'+String(i+1).padStart(2,'0'));context.s12=s;
 context.fetch=async(url,options)=>url==='/api/chat'?(sent.push(JSON.parse(options.body)),{ok:true,json:async()=>({choices:[{message:{content:'{"speech":"请说明依据。"}'}}]})}):{ok:true,json:async()=>S.context(s,Number(/context\/(\d+)/.exec(url)[1]))};
 vm.runInContext("reset(12);sessionStory=s12;game.start();profiles.forEach(p=>{p.control='api';p.endpoint='https://chat.test';p.model='test'})",context);
 for(let i=0;i<12;i++){await vm.runInContext(`decision(${i},'speech')`,context);const text=JSON.stringify(sent[i].messages);for(let k=0;k<12;k++)assert.ok(!text.includes(s.characters[k].secret))}
 vm.runInContext("reset(6);storyLibrary=[{id:'keep6',roomSize:6,title:'同名',version:1,aliasIds:['old6']},{id:'keep12',roomSize:12,title:'同名',version:1,aliasIds:['old12']}];selectedStoryId='old6';storyOptions();rememberStory()",context);
 assert.equal(vm.runInContext('selectedStoryId',context),'keep6');assert.doesNotMatch(vm.runInContext("$('storyChoice').innerHTML",context),/keep12/);
 vm.runInContext("reset(12);selectedStoryId='old12';storyOptions();rememberStory();reset(6)",context);assert.equal(vm.runInContext('selectedStoryId',context),'keep6');vm.runInContext('reset(12)',context);assert.equal(vm.runInContext('selectedStoryId',context),'keep12');
});

test('狼人 API 离线停留原行动，恢复后选刀与最终目标一致',async t=>{
  const h=wolfHarness(t,{size:6}),{read,groups}=h;
  const running=h.start();await until(()=>groups.length===1);
  const first=groups[0].requests[0].action.seat;
  groups[0].error(first,'UPSTREAM_ERROR');
  await until(()=>read('voteBatch?.errorPause===true'));
  assert.equal(read("observerEvents.filter(e=>e.kind==='wolf').length"),0);
  groups[0].result(groups[0].requests[1].action.seat,2);
  read('retryVoteBatch()');await until(()=>groups.length===2);
  const retry=groups[1].requests.find(request=>request.action.seat===first);assert.ok(retry);
  groups[1].result(first,3);const output=await running;
  assert.equal(output[first-1].target,2);
  assert.equal(read('paused'),false);
  assert.equal(read('voteBatch'),null);
  assert.equal(groups.length,2);
});

test('狼刀提示暂停保留、切视角立即隐藏，重置及换房隔离迟到结果',async t=>{
  for(const resetSize of [6,12]){
    const h=wolfHarness(t,{size:resetSize}),{read,groups}=h;
    read('wolfPresentation={round:game.round,states:{}};renderPlayers()');
    const running=h.start();await until(()=>groups.length===1);
    read('renderPlayers()');
    assert.match(read("$('playersGrid').innerHTML"),/正在选刀/);
    read('togglePause()');assert.match(read("$('playersGrid').innerHTML"),/正在选刀/);
    read("setPerspective('public')");assert.doesNotMatch(read("$('playersGrid').innerHTML"),/wolf-choice|正在选刀/);
    read("setPerspective('god')");assert.match(read("$('playersGrid').innerHTML"),/正在选刀/);
    read('reset('+resetSize+')');for(const group of groups)group.close();await running;
    assert.equal(read('wolfPresentation'),null);assert.equal(read('observerEvents.length'),0);
    assert.doesNotMatch(read("$('playersGrid').innerHTML"),/wolf-choice|提议袭击/);
  }
});

test('音乐开关和音量单独保存，刷新恢复且不改动玩家配置',()=>{
 const {context,saved}=setup(new Map(),false);const before=vm.runInContext('JSON.stringify(profiles)',context);
 vm.runInContext("music.setVolume(.23);toggleMusic()",context);assert.deepEqual(JSON.parse(saved.get('nightfall-music-v1')),{enabled:false,volume:.23});
 assert.equal(vm.runInContext('JSON.stringify(profiles)',context),before);
 const restored=setup(saved,false).context;assert.equal(vm.runInContext("$('musicBtn').textContent",restored),'♫ 音乐：关');assert.equal(vm.runInContext("$('musicVolume').value",restored),23);
});



test('鉴权失败暂停且普通继续不重试，重置释放当前行动',async t=>{
  const {context}=setup();let n=0;
  t.after(()=>vm.runInContext('reset()',context));
  context.fetch=async()=>{n++;return {ok:false,status:401,json:async()=>({error:{code:'AUTH_FAILED',message:'鉴权失败'}})}};
  const pending=vm.runInContext("decision(8,'vote')",context);await until(()=>vm.runInContext('!!apiWaiting',context));
  assert.equal(vm.runInContext('paused',context),true);
  assert.equal(vm.runInContext('apiWaiting.nextAt',context),null);
  vm.runInContext('busy=true;togglePause();wakeAPIWait()',context);
  await new Promise(r=>setTimeout(r,50));assert.equal(n,1);
  assert.equal(vm.runInContext('paused',context),true);
  vm.runInContext('reset()',context);await pending;
  assert.equal(n,1);assert.equal(vm.runInContext('apiWaiting',context),null);
});

test('全屏默认隐藏记录，退出恢复原有偏好',async()=>{
 const {context}=setup();vm.runInContext('spectatorPrefs.railOpen=true',context);await vm.runInContext('toggleFullscreen()',context);assert.equal(vm.runInContext('spectatorPrefs.railOpen',context),false);
 vm.runInContext('spectatorPrefs.railOpen=true',context);await vm.runInContext('toggleFullscreen()',context);assert.equal(vm.runInContext('spectatorPrefs.railOpen',context),true);
});
test('暂停期间修改接口丢弃旧响应，修改配置和继续均不隐式请求',async t=>{
 const {context}=setup();let release,n=0;
 t.after(()=>vm.runInContext('reset()',context));
 context.fetch=async url=>{if(url==='/api/agent-events')return {ok:true};n++;if(n===1)return new Promise(r=>release=r);return {ok:true,json:async()=>({choices:[{message:{content:'{"target":2}'}}]})}};
 vm.runInContext('busy=true;turnDelay=0',context);
 const pending=vm.runInContext("takeTurn(8,'vote','投票',epoch)",context);
 await until(()=>!!release);vm.runInContext("togglePause();profiles[8].model='new-model'",context);
 release({ok:true,json:async()=>({choices:[{message:{content:'{"target":1}'}}]})});
 await until(()=>vm.runInContext('!!apiWaiting',context));
 vm.runInContext('togglePause()',context);assert.equal(n,1);
 vm.runInContext('retryAPI()',context);
 await until(()=>n===2);assert.equal(vm.runInContext('paused',context),true);
 vm.runInContext('togglePause()',context);assert.equal((await pending).target,1);
 assert.equal(n,2);
});

test('已暂存成功结果之后修改配置，需要明确重试才能重新请求',async t=>{
 const {context}=setup();let release,n=0;
 t.after(()=>vm.runInContext('reset()',context));
 context.fetch=async url=>{if(url==='/api/agent-events')return {ok:true};n++;if(n===1)return new Promise(r=>release=r);return {ok:true,json:async()=>({choices:[{message:{content:'{"target":2}'}}]})}};
 vm.runInContext('busy=true;turnDelay=0',context);
 const pending=vm.runInContext("takeTurn(8,'vote','投票',epoch)",context);await until(()=>!!release);
 vm.runInContext('togglePause()',context);
 release({ok:true,json:async()=>({choices:[{message:{content:'{"target":1}'}}]})});
 await until(()=>vm.runInContext('agentPending===null',context));
 vm.runInContext("profiles[8].model='new-model';togglePause()",context);
 await until(()=>vm.runInContext('!!apiWaiting',context));assert.equal(n,1);
 vm.runInContext('togglePause()',context);assert.equal(n,1);
 vm.runInContext('retryAPI()',context);assert.equal((await pending).target,1);assert.equal(n,2);
});

test('限流及临时故障持续暂停，只有手动重试发起一笔新请求',async t=>{
 const {context}=setup();let n=0;const sent=[];
 context.fetch=async(u,o)=>{sent.push(JSON.parse(o.body));n++;return n===1?{ok:false,status:429,json:async()=>({error:{code:'RATE_LIMITED',message:'稍后重试'}})}:{ok:true,json:async()=>({choices:[{message:{content:'{"target":2}'}}]})}};
 context.clock=1000;vm.runInContext('Date.now=()=>clock;busy=true',context);t.after(()=>vm.runInContext('reset()',context));
 const pending=vm.runInContext("decision(8,'vote')",context);await until(()=>vm.runInContext('!!apiWaiting',context));
 vm.runInContext('clock+=600000;togglePause();wakeAPIWait()',context);
 await new Promise(r=>setTimeout(r,30));assert.equal(n,1);
 assert.equal(vm.runInContext('paused',context),true);
 vm.runInContext('retryAPI();retryAPI()',context);
 assert.equal((await pending).target,1);assert.equal(n,2);
 assert.notEqual(sent[0].requestId,sent[1].requestId);
 assert.deepEqual(sent[0].messages,sent[1].messages);
});

test('模型上下文容量不足时保留完整输入、暂停并仅在手动重试后重新请求',async t=>{
 const {context}=setup();let n=0;const sent=[];
 t.after(()=>vm.runInContext('reset()',context));
 context.fetch=async(url,options)=>{
  if(url==='/api/agent-events')return {ok:true};
  sent.push(JSON.parse(options.body));n++;
  return n===1
   ?{ok:false,status:400,json:async()=>({error:{code:'CONTEXT_CAPACITY_EXCEEDED',message:'完整对局上下文超过当前模型或接口的容量上限。系统未删减或概括历史信息。'}})}
   :{ok:true,json:async()=>({choices:[{message:{content:'{"target":2}'}}]})};
 };
 vm.runInContext('busy=true',context);
 const pending=vm.runInContext("decision(8,'vote')",context);
 await until(()=>vm.runInContext('!!apiWaiting',context));
 assert.equal(vm.runInContext('paused',context),true);
 assert.equal(vm.runInContext("apiWaiting.code",context),'CONTEXT_CAPACITY_EXCEEDED');
 assert.match(vm.runInContext("apiWaiting.message",context),/未删减或概括历史信息/);
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(n,1);
 vm.runInContext('retryAPI()',context);
 assert.equal((await pending).target,1);assert.equal(n,2);
 assert.deepEqual(sent[0].messages,sent[1].messages);
});
test('浏览器Esc退出原生全屏恢复进入前记录状态',()=>{
 const {context,events}=setup();vm.runInContext('spectatorPrefs.railOpen=true;setWatchMode(true);nativeWatch=true',context);events.fullscreenchange[0]();assert.equal(vm.runInContext('watchMode',context),false);assert.equal(vm.runInContext('spectatorPrefs.railOpen',context),true);
});

test('竖屏普通及PK发言先亮相500毫秒，切回圆桌不中断或重复生成声音',async()=>{
  for(const pk of [false,true]){
    const {context}=setup(new Map(),false,false,false,true),{audios,requests}=installNatural(context);
vm.runInContext('voiceEnabled=true',context);
    let enter;const waits=[];
    context.entrance=ms=>{waits.push(ms);return ms===500?new Promise(r=>enter=r):Promise.resolve(true)};
    vm.runInContext(`game.start();game.phase='discussion';game.pk=${pk?'[0,1]':'null'};busy=true;setPortraitMode(true);presentationWait=entrance`,context);
    const playing=vm.runInContext("showPlayerSpeech({id:0,text:'先看清每条线索，再决定相信谁。'})",context);
    assert.equal(vm.runInContext("$('portraitHeroState').textContent",context),'即将发言');
    assert.equal(requests.length,0);assert.equal(waits[0],500);
    enter(true);await until(()=>audios.length===1);
    assert.equal(vm.runInContext("$('portraitHeroName').textContent",context),'1 号 · 岚');
    assert.equal(vm.runInContext("$('portraitHeroState').textContent",context),'正在发言');
    audios[0].duration=10;audios[0].currentTime=3;audios[0].ontimeupdate();
    const caption=vm.runInContext('speechBubble.caption',context),current=vm.runInContext('narration',context),pauses=audios[0].pauses;
    vm.runInContext("apiWaiting={id:0,message:'接口等待',failures:1,startedAt:Date.now(),nextAt:Date.now()+5000};renderAction();apiWaiting.failures=2;renderAction();apiWaiting=null;renderAction()",context);
    assert.equal(vm.runInContext('narration',context),current);assert.equal(requests.length,1);
    assert.equal(audios[0].currentTime,3);assert.equal(audios[0].pauses,pauses);
    assert.equal(vm.runInContext("$('portraitCaption').textContent",context),caption);
    vm.runInContext('setPortraitMode(false);setPortraitMode(true)',context);
    assert.equal(vm.runInContext('narration',context),current);assert.equal(requests.length,1);assert.equal(audios[0].currentTime,3);assert.equal(audios[0].pauses,pauses);
    assert.equal(vm.runInContext("$('portraitCaption').textContent",context),caption);
    vm.runInContext('togglePause()',context);
    assert.equal(vm.runInContext("$('portraitHeroState').textContent",context),'已暂停');
    assert.equal(vm.runInContext("$('portraitHero').classList.contains('pulsing')",context),false);
    vm.runInContext('togglePause()',context);audios[0].onended();await playing;
    assert.equal(requests.length,1);assert.equal(vm.runInContext('speechBubble',context),null);
  }
});

test('竖屏亮相可暂停、切换和重置取消，圆桌不增加亮相等待',async()=>{
  const {context}=setup(new Map(),false,true,false,true),{spoken}=installSpeech(context,{autoEnd:true});
vm.runInContext('voiceEnabled=true',context);
  vm.runInContext('setPortraitMode(true);busy=true;paused=true;presentationDelayScale=1',context);
  const playing=vm.runInContext("showPlayerSpeech({id:0,text:'这条发言不应在暂停期间开始。'})",context);
  await new Promise(r=>setTimeout(r,130));assert.equal(spoken.length,0);
  vm.runInContext('setPortraitMode(false)',context);await new Promise(setImmediate);assert.equal(spoken.length,0);
  vm.runInContext('togglePause();presentationDelayScale=0',context);await playing;assert.equal(spoken.length,1);
  vm.runInContext('setPortraitMode(true);presentationDelayScale=1',context);
  const cancelled=vm.runInContext("showPlayerSpeech({id:1,text:'旧局不能播放。'})",context);
  vm.runInContext('reset(12)',context);await cancelled;
  assert.equal(spoken.length,1);assert.equal(vm.runInContext('speechBubble',context),null);
  assert.equal(vm.runInContext("$('portraitHeroArt').innerHTML",context),'');
  assert.equal(vm.runInContext("$('portraitFrame').dataset.size",context),'12');
  const waits=[];context.trackWait=async ms=>{waits.push(ms);return true};
  vm.runInContext('setPortraitMode(false);presentationWait=trackWait',context);
  await vm.runInContext("showPlayerSpeech({id:2,text:'圆桌直接开始声音。'})",context);
  assert.ok(!waits.includes(500));assert.equal(spoken.length,2);
});

test('竖屏6和12席共享视角隐私，私有夜间提示与旁白不泄漏，头像故障可回退',()=>{
  const {context}=setup(new Map(),false,true,false,true);
  for(const count of [6,12]){
    vm.runInContext(`reset(${count});game.start();game.phase='night';setPortraitMode(true);setPerspective('god');wolfPresentation={round:game.round,states:{0:{status:'selected',target:2}}};currentCommentary={private:true,godText:'秘密狼刀 3 号',publicText:''};renderAll()`,context);
    const html=()=>vm.runInContext("$('portraitSeatsLeft').innerHTML+$('portraitSeatsRight').innerHTML",context);
    assert.equal((html().match(/data-portrait-seat=/g)||[]).length,count);assert.match(html(),/提议 3 号/);
    assert.equal(vm.runInContext("$('portraitCaption').textContent",context),'秘密狼刀 3 号');
    vm.runInContext("setPerspective('public');currentCommentary={private:true,godText:'不得显示的秘密',publicText:''};apiWaiting={id:0};activeSeat=0;renderAll()",context);
    assert.doesNotMatch(html(),/提议|狼人|女巫|预言家|正在选刀/);
    assert.doesNotMatch(vm.runInContext("$('portraitCaption').textContent",context),/秘密狼刀|不得显示|1 号/);
    vm.runInContext("apiWaiting=null;game.phase='discussion';speechBubble={id:0,kind:'dialogue',stage:'reading',caption:'公开发言'};renderAll()",context);
    assert.doesNotMatch(vm.runInContext("$('portraitHeroRole').innerHTML",context),/狼人|女巫|预言家/);
    vm.runInContext("failedPortraits.add(profiles[0].manorPortrait);renderPlayers()",context);
    assert.match(vm.runInContext("$('portraitHeroArt').innerHTML",context),/portrait-avatar-fallback/);
    vm.runInContext("game.phase='ended';game.winner='好人';renderAll()",context);
    assert.doesNotMatch(vm.runInContext("$('portraitHeroRole').innerHTML",context),/身份隐藏/);
  }
});

test('竖屏、全屏任意嵌套切换均恢复圆桌记录偏好',()=>{
  for(const sequence of [
    ['setPortraitMode(true)','setWatchMode(true)','setPortraitMode(false)','setWatchMode(false)'],
    ['setWatchMode(true)','setPortraitMode(true)','setWatchMode(false)','setPortraitMode(false)'],
    ['setPortraitMode(true)','setWatchMode(true)','setWatchMode(false)','setPortraitMode(false)'],
  ]){
    const {context}=setup(new Map(),false,true,false,true);
    vm.runInContext('spectatorPrefs.railOpen=true',context);
    sequence.forEach(code=>vm.runInContext(code,context));
    assert.equal(vm.runInContext('spectatorPrefs.railOpen',context),true,sequence.join(' → '));
  }
});

test('PK仍处投票阶段时，等待回复就展示中央人物，投票请求不误显示',()=>{
  const {context}=setup(new Map(),false,true,false,true);
  vm.runInContext("game.start();game.phase='voting';game.pk=[0,1];activeSeat=0;actionText='1 号 正在进行 PK 发言';setPortraitMode(true)",context);
  assert.equal(vm.runInContext('portraitFocus()',context),0);
  assert.equal(vm.runInContext("$('portraitHeroState').textContent",context),'思考中');
  vm.runInContext("activeSeat=2;actionText='3 号 正在投票';renderPlayers()",context);
  assert.equal(vm.runInContext('portraitFocus()',context),null);
});

test('竖屏思考和PK等待使用人物字幕区，不携带已结束的阶段旁白',()=>{
  for(const count of [6,12])for(const pk of [false,true]){
    const {context}=setup(new Map(),false,true,false,true);
    vm.runInContext(`reset(${count});game.start();game.phase='${pk?'voting':'discussion'}';game.pk=${pk?'[2,3]':'null'};activeSeat=2;actionText='3 号 ${pk?'PK ':''}发言';currentCommentary={godText:'旧的白天阶段长旁白',publicText:'旧的公开旁白'};setPortraitMode(true)`,context);
    const read=code=>vm.runInContext(code,context);
    assert.equal(read("$('portraitHero').classList.contains('hidden')"),false);
    assert.equal(read("$('portraitFrame').dataset.caption"),'speaker');
    assert.match(read("$('portraitCaption').textContent"),/整理思路/);
    assert.doesNotMatch(read("$('portraitCaption').textContent"),/旧的/);
    read('apiWaiting={id:2};renderAll()');
    assert.equal(read("$('portraitFrame').dataset.caption"),'speaker');
    assert.match(read("$('portraitCaption').textContent"),/3 号的当前行动已暂停，请手动重试/);
    read('apiWaiting=null;paused=true;renderAll()');
    assert.match(read("$('portraitCaption').textContent"),/已暂停/);
    read("paused=false;narration={seat:2,loading:true};renderAll()");
    assert.match(read("$('portraitCaption').textContent"),/准备声音/);
    read("speechBubble={id:2,kind:'dialogue',stage:'reading',caption:'当前逐句字幕'};renderAll()");
    assert.equal(read("$('portraitCaption').textContent"),'当前逐句字幕');
    assert.equal(read('currentCommentary.godText'),'旧的白天阶段长旁白');
    read('narration=null;speechBubble=null;activeSeat=null;renderAll()');
    assert.equal(read("$('portraitFrame').dataset.caption"),'narration');
    assert.equal(read("$('portraitCaption').textContent"),'旧的白天阶段长旁白');
  }
});

test('十二人竖屏独立显示真实连接状态，行动提示不替代连接，夜间隐藏私有信息',()=>{
  const {context}=setup(new Map(),false,true,false,true);
  const read=code=>vm.runInContext(code,context);
  read("reset(12);game.start();game.phase='discussion';setPortraitMode(true)");
  const expected={ok:'在线',error:'离线',testing:'连接中',queued:'待测',untested:'未测',invalid:'未测'};
  for(const [connection,label]of Object.entries(expected)){
    read(`profiles[0].control='api';profiles[0].connection='${connection}';activeSeat=0;renderAll()`);
    assert.match(read('portraitConnectionBadge(profiles[0])'),new RegExp('>'+label+'<'));
    assert.match(read("$('portraitSeatsLeft').innerHTML"),/思考中/);
  }
  read("profiles[0].control='local';renderAll()");
  assert.match(read('portraitConnectionBadge(profiles[0])'),/>模拟</);
  read("profiles[0].control='api';profiles[0].connection='error';game.phase='night';setPerspective('god');wolfPresentation={round:game.round,states:{0:{status:'selected',target:2}}};renderAll()");
  assert.match(read("$('portraitSeatsLeft').innerHTML"),/提议 3 号/);
  assert.match(read('portraitConnectionBadge(profiles[0])'),/>离线</);
  read("wolfPresentation.states[0].target=11;renderAll()");
  assert.match(read("$('portraitSeatsLeft').innerHTML"),/portrait-seat-connection[\s\S]*portrait-avatar[\s\S]*portrait-seat-info[\s\S]*portrait-seat-role[\s\S]*portrait-seat-state[^>]*title="提议 12 号">提议<span class="portrait-seat-number">12<\/span>号<\/span><\/span><\/button>/);
  assert.equal(read("portraitActionLabel('投 10 号')"),'投给<span class="portrait-seat-number">10</span>号');
  assert.equal(read("portraitActionLabel('弃票')"),'弃票');
  const rightHtml=read("$('portraitSeatsRight').innerHTML");
  const rightSeats=Array.from(rightHtml.matchAll(/data-portrait-seat="(\d+)"/g),match=>match[1]).join(',');
  assert.equal(rightSeats,'6,7,8,9,10,11','右侧保持7至12号自上而下，玩家 ID 与座位号一致；DOM：'+rightHtml);
  read("game.phase='voting';wolfPresentation=null;votePresentation={states:{0:'revealed'},votes:{0:9},counts:{9:1}};renderAll()");
  assert.match(read("$('portraitSeatsLeft').innerHTML"),/title="投 10 号">投给<span class="portrait-seat-number">10<\/span>号/);
  for(const [state,label]of Object.entries({pending:'待投票',choosing:'投票中',submitted:'已投票',excluded:'本轮不投票'})){
    read(`votePresentation.states[0]='${state}';renderAll()`);
    assert.equal(read('portraitSeatHint(game.players[0])'),label);
  }
  read("game.phase='night';votePresentation=null;wolfPresentation={round:game.round,states:{0:{status:'selected',target:11}}};renderAll()");
  read("setPerspective('public');renderAll()");
  const html=read("$('portraitSeatsLeft').innerHTML+$('portraitSeatsRight').innerHTML");
  assert.doesNotMatch(html,/提议|正在选刀|狼人|女巫|预言家|data-connection="error"/);
  assert.match(read('portraitConnectionBadge(profiles[0])'),/data-connection="hidden"/);
  assert.match(read('portraitConnectionBadge(profiles[0])'),/>夜间</);
  read("reset(6);renderAll()");
  assert.doesNotMatch(read("$('portraitSeatsLeft').innerHTML"),/portrait-seat-info|portrait-seat-connection/);
});

test('翻牌使用独立横排角色名称，公开翻牌及未知身份不带真实角色标记',()=>{
  for(const count of [6,12]){
    const {context}=setup(new Map(),false,true,false,true),read=code=>vm.runInContext(code,context);
    read('reset('+count+');game.start();setPortraitMode(true)');
    for(const [role,style]of Object.entries({'狼人':'wolf','预言家':'seer','女巫':'witch','猎人':'hunter','守卫':'guard','平民':'villager'})){
      read('game.players[0].role='+JSON.stringify(role));
      const card=read('visibleRoleBadge(game.players[0],true,true)');
      assert.match(card,new RegExp('reveal-identity role-'+style));
      assert.match(card,new RegExp('<strong class="reveal-role-name">'+role+'</strong>'));
      assert.doesNotMatch(card,/class="player-role/);
      const hidden=read('visibleRoleBadge(game.players[0],false,true)');
      assert.match(hidden,/reveal-identity role-unknown/);assert.match(hidden,/>已分配</);
      assert.doesNotMatch(hidden,/role-(wolf|seer|witch|hunter|guard|villager)/);
      assert.doesNotMatch(read('visibleRoleBadge(game.players[0],false)'),/role-(wolf|seer|witch|hunter|guard|villager)/);
    }
    read("spectatorPrefs.perspective='public';dealState={stage:'reveal',revealed:size};sceneMotion={kind:'reveal'};renderSceneMotion();renderPortrait()");
    const publicHTML=read("$('sceneEffect').innerHTML+$('portraitSeatsLeft').innerHTML+$('portraitSeatsRight').innerHTML");
    assert.doesNotMatch(publicHTML,/role-(wolf|seer|witch|hunter|guard|villager)/);
    read('reset()');
  }
});

test('竖屏真实API断连与恢复立即同步人物和字幕，不重建媒体或重播亮相',async t=>{
  for(const count of [6,12]){
    const {context}=setup(new Map(),false,true,false,true),read=code=>vm.runInContext(code,context);
    t.after(()=>read('reset()'));
    read(`reset(${count});game.start();game.phase='discussion';activeSeat=0;busy=true;profiles[0].control='api';profiles[0].endpoint='https://example.test/v1/chat/completions';profiles[0].model='test-model';profiles[0].key='test-key';setPortraitMode(true)`);
    let requests=0;
    context.fetch=async()=>++requests===1?{ok:false,status:503,json:async()=>({error:{code:'UPSTREAM_NETWORK_ERROR',message:'服务暂时不可用'}})}:{ok:true,json:async()=>({choices:[{message:{content:'{"speech":"先听听大家的意见。"}'}}]})};
    const focus=read("$('portraitHero').dataset.focus"),running=read("decision(0,'speech')");
    await until(()=>read('!!apiWaiting'));
    assert.equal(read("$('portraitHeroState').textContent"),'已暂停');
    assert.match(read("$('portraitCaption').textContent"),/1 号的当前行动已暂停，请手动重试/);
    assert.match(read("$('portraitAPIStatus').textContent"),/1号.*已暂停/);
    assert.equal(read("$('portraitAPIBar').classList.contains('waiting')"),true);
    assert.equal(read("$('portraitHero').dataset.focus"),focus);
    read('paused=true;renderAction()');assert.equal(read("$('portraitAPIRetry').disabled"),false);
    assert.equal(read("$('portraitHeroState').textContent"),'已暂停');
    read("paused=false;renderAction();handleAPIWaitCommand('retry-api')");
    assert.equal((await running).speech,'先听听大家的意见。');assert.equal(requests,2);
    assert.equal(read('apiWaiting'),null);
    assert.equal(read("$('portraitAPIStatus').textContent"),'接口等待：无');
    assert.equal(read("$('portraitHeroState').textContent"),'思考中');
    assert.doesNotMatch(read("$('portraitCaption').textContent"),/当前行动已暂停/);
    assert.equal(read("$('portraitHero').dataset.focus"),focus);
    assert.equal(read('narration'),null);assert.equal(read('speechBubble'),null);
  }
});

test('竖屏等待详情随视角即时清除秘密，恢复或退出竖屏关闭详情',()=>{
  const {context}=setup(new Map(),false,true,false,true),read=code=>vm.runInContext(code,context);
  read("game.start();game.phase='night';activeSeat=2;spectatorPrefs.perspective='god';setPortraitMode(true);apiWaiting={id:2,message:'私有供应商错误',failures:3,startedAt:Date.now()-10000,nextAt:null};renderAction()");
  assert.match(read("$('portraitAPIDialogText').textContent"),/私有供应商错误/);
  assert.match(read("$('portraitAPIStatus').textContent"),/等待手动重试/);
  read("$('portraitAPIDialog').open=true;$('portraitAPIDialog').close=()=>{$('portraitAPIDialog').open=false};setPerspective('public')");
  assert.equal(read("$('portraitAPIDialog').open"),true);
  assert.doesNotMatch(read("$('portraitAPIDialogText').textContent+$('portraitAPIDialogTitle').textContent+$('portraitAPIStatus').textContent"),/私有供应商错误|3号|3 号/);
  assert.match(read("$('portraitAPIStatus').textContent"),/夜间行动/);
  read('apiWaiting=null;renderAction()');assert.equal(read("$('portraitAPIDialog').open"),false);
  assert.equal(read("$('portraitAPIDialogText').textContent"),'');
  read("apiWaiting={id:2,failures:1,startedAt:Date.now(),nextAt:null};renderAction();$('portraitAPIDialog').open=true;setPortraitMode(false)");
  assert.equal(read("$('portraitAPIDialog').open"),false);
  read("setPortraitMode(true);setWatchMode(true);handleAPIWaitCommand('edit-api')");
  assert.equal(read('view'),'agents');assert.equal(read('portraitMode'),false);assert.equal(read('watchMode'),false);
});


test('六人与十二人旧 Agent 配置恢复后发言上限、token预算及 xhigh 可核对', async () => {
  for (const count of [6, 12]) {
    const {context, saved, requests} = setup(new Map(), false);
    const read = code => vm.runInContext(code, context);
    context.fetch = async (url, options) => {
      requests.push(JSON.parse(options.body));
      return {ok:true, json:async () => ({choices:[{message:{content:JSON.stringify({speech:'发'.repeat(1501),target:null,save:false,poison:null})}}]})};
    };
    read('reset(' + count + ')');
    read("profiles[0].control='api';profiles[0].endpoint='https://example.test/v1';profiles[0].model='test-model-" + count + "';profiles[0].key='test-key';persist();game.start();game.players[0].role='狼人'");
    assert.equal(read('profiles[0].reasoningEffort'), 'xhigh');
    for (const task of ['night', 'speech', 'vote', 'hunter']) {
      const result=await read('decision(0,' + JSON.stringify(task) + ')');
      assert.equal(requests.at(-1).reasoningEffort, 'xhigh');
      assert.equal(requests.at(-1).maxTokens, 25000);
      assert.equal(requests.at(-1).model, 'test-model-' + count);
      if(task==='speech')assert.equal(Array.from(result.speech).length,1400);
    }
    read("game.pk=[0,1]");
    const pkSpeech=await read("decision(0,'speech')");
    assert.equal(requests.at(-1).reasoningEffort, 'xhigh');
    assert.equal(requests.at(-1).maxTokens,25000);
    assert.equal(Array.from(pkSpeech.speech).length,1400);
    read('renderAgents();openAgent(0)');
    assert.match(read("$('agentGrid').innerHTML"), /推理强度 · 超高（xhigh）/);
    read('closeModal()');
    const before = requests.length;
    read("profiles[1].control='local'");
    await read("decision(1,'speech')");
    assert.equal(requests.length, before);
    const restored = setup(saved, false);
    vm.runInContext('reset(' + count + ')', restored.context);
    assert.equal(vm.runInContext('profiles[0].model', restored.context), 'test-model-' + count);
    assert.equal(vm.runInContext('profiles[0].reasoningEffort', restored.context), 'xhigh');
    await vm.runInContext("apiCall(profiles[0],[{role:'user',content:'test'}])", restored.context);
    assert.equal(restored.requests.at(-1).purpose, 'connection-test');
    assert.equal(restored.requests.at(-1).maxTokens, 350);
    assert.equal(restored.requests.at(-1).reasoningEffort, 'xhigh');
    vm.runInContext('renderAgents()', restored.context);
    assert.match(vm.runInContext("$('agentGrid').innerHTML", restored.context), /推理强度 · 超高（xhigh）/);
  }
});

test('Agent 推理强度 medium 可在配置页保存、恢复、展示并传给 API',async()=>{
  assert.match(fs.readFileSync('index.html','utf8'),/<option value="medium">中（medium）<\/option>/);
  const {context,saved}=setup(new Map(),false);
  const read=code=>vm.runInContext(code,context);
  read("openAgent(0);$('controlInput').value='api';$('endpointInput').value='https://example.test/v1';$('modelInput').value='medium-model';$('keyInput').value='medium-key';$('reasoningEffortInput').value='medium';saveAgent();renderAgents()");
  assert.equal(read('profiles[0].reasoningEffort'),'medium');
  assert.equal(JSON.parse(saved.get('nightfall-profiles-v1'))[0].reasoningEffort,'medium');
  assert.match(read("$('agentGrid').innerHTML"),/推理强度 · 中（medium）/);
  const restored=setup(saved,false);
  assert.equal(vm.runInContext('profiles[0].reasoningEffort',restored.context),'medium');
  await vm.runInContext("apiCall(profiles[0],[{role:'user',content:'test'}])",restored.context);
  assert.equal(restored.requests.at(-1).reasoningEffort,'medium');
  vm.runInContext('renderAgents()',restored.context);
  assert.match(vm.runInContext("$('agentGrid').innerHTML",restored.context),/推理强度 · 中（medium）/);
});

test('达到发言 token 上限时拒绝不完整 JSON 且不自动重复请求',async()=>{
  const {context,requests}=setup(new Map(),false);
  vm.runInContext("profiles[0].endpoint='https://example.test/v1';profiles[0].model='test-model'",context);
  context.fetch=async(url,options)=>{
    requests.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{\"speech\":\"未完成'}}]})};
  };
  await assert.rejects(vm.runInContext("apiCall(profiles[0],[{role:'user',content:'test'}],{maxTokens:4000})",context),{code:'AGENT_OUTPUT_TRUNCATED'});
  assert.equal(requests.length,1);
  assert.equal(requests[0].maxTokens,4000);
});
test('xhigh 参数被拒绝后停留当前行动并等待手动处理', async () => {
  const {context} = setup();
  let requests = 0;
  context.fetch = async () => {
    requests++;
    return {ok:false, status:422, json:async () => ({error:{code:'REASONING_EFFORT_UNSUPPORTED',
      message:'当前模型不支持推理强度 xhigh，请修改配置。'}})};
  };
  const read = code => vm.runInContext(code, context);
  const before = read('JSON.stringify(game)');
  const pending = read("decision(8,'vote')");
  await until(() => read('!!apiWaiting'));
  assert.equal(read('apiWaiting.nextAt'), null);
  assert.match(read('apiWaiting.message'), /xhigh/);
  assert.equal(read('JSON.stringify(game)'), before);
  read('busy=true;togglePause()');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests, 1);
  read('reset()');
  await pending;
  assert.equal(requests, 1);
  assert.equal(read('apiWaiting'), null);
});




test('对局持续等待显示请求编号和用时，连接测试仍设185秒浏览器期限',async t=>{
  const {context,timeouts}=setup();let release,signal;const sent=[];
  t.after(()=>vm.runInContext('reset()',context));
  context.fetch=async(url,options)=>{sent.push(JSON.parse(options.body));signal=options.signal;return new Promise(resolve=>release=resolve)};
  const pending=vm.runInContext("decision(8,'vote')",context);await until(()=>!!release);
  assert.equal(timeouts.includes(185000),false);
  assert.equal(sent[0].purpose,'game-action');assert.equal(sent[0].action.seat,9);
  assert.match(vm.runInContext("$('actionPanel').innerHTML",context),/正在等待接口返回|停止等待/);
  vm.runInContext('agentPending.startedAt-=1100000;renderAction()',context);
  assert.match(vm.runInContext("$('actionPanel').innerHTML",context),/1100 秒/);
  assert.equal(signal.aborted,false);
  release({ok:true,json:async()=>({choices:[{message:{content:'{"target":1}'}}]})});await pending;
  context.fetch=async(url,options)=>{sent.push(JSON.parse(options.body));return {ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})}};
  await vm.runInContext("apiCall(profiles[8],[{role:'user',content:'OK'}])",context);
  assert.equal(timeouts.includes(185000),true);assert.equal(sent.at(-1).purpose,'connection-test');
});

test('停止等待取消当前请求并暂停，重试使用相同内容且只发一次',async t=>{
  const {context}=setup();const calls=[],events=[];let waiting;
  t.after(()=>vm.runInContext('reset()',context));
  context.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url==='/api/agent-events'){events.push(body);return {ok:true};}
    calls.push(body);
    if(calls.length===1)return new Promise((resolve,reject)=>{waiting=options.signal;options.signal.addEventListener('abort',()=>reject(Object.assign(Error('cancel'),{name:'AbortError'})),{once:true})});
    return {ok:true,json:async()=>({choices:[{message:{content:'{"target":1}'}}]})};
  };
  const pending=vm.runInContext("decision(8,'vote')",context);await until(()=>!!waiting);
  vm.runInContext("busy=true;handleAPIWaitCommand('stop-api')",context);
  await until(()=>vm.runInContext('!!apiWaiting',context));
  assert.equal(waiting.aborted,true);assert.equal(vm.runInContext('paused',context),true);
  assert.equal(vm.runInContext('apiWaiting.code',context),'AGENT_WAIT_CANCELLED');
  assert.match(vm.runInContext("$('actionPanel').innerHTML",context),/供应商仍可能完成处理或计费/);
  vm.runInContext('togglePause()',context);assert.equal(calls.length,1);
  assert.equal(events[0].requestId,calls[0].requestId);assert.equal(events[0].code,'AGENT_WAIT_CANCELLED');
  vm.runInContext('retryAPI();retryAPI()',context);assert.equal((await pending).target,0);
  assert.equal(calls.length,2);assert.deepEqual(calls[0].messages,calls[1].messages);
  assert.notEqual(calls[0].requestId,calls[1].requestId);
});

test('六与十二人手动暂停期间保留同一成功结果，继续后仅使用一次',async t=>{
  for(const count of [6,12]){
    const {context}=setup();let release,n=0,done=false;
    const read=code=>vm.runInContext(code,context);t.after(()=>read('reset()'));
    read('reset('+count+');game.start();game.phase="voting";busy=true;turnDelay=0;profiles[0].control="api";profiles[0].endpoint="https://example.test";profiles[0].model="same"');
    context.fetch=async()=>{n++;return new Promise(resolve=>release=resolve)};
    const pending=read("takeTurn(0,'vote','投票',epoch)").then(result=>{done=true;return result});
    await until(()=>!!release);read('togglePause()');
    release({ok:true,json:async()=>({choices:[{message:{content:'{"target":2}'}}]})});
    await until(()=>read('agentPending===null'));assert.equal(done,false);assert.equal(n,1);
    read('togglePause()');assert.equal((await pending).target,1);assert.equal(n,1);
  }
});

test('在途请求修改配置会暂停，保存配置和普通继续不能隐式发新请求',async t=>{
  const {context}=setup();let n=0,signal;
  const read=code=>vm.runInContext(code,context);t.after(()=>read('reset()'));
  context.fetch=async(url,options)=>{
    if(url==='/api/agent-events')return {ok:true};n++;
    if(n===1)return new Promise((resolve,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(Object.assign(Error('abort'),{name:'AbortError'})),{once:true})});
    return {ok:true,json:async()=>({choices:[{message:{content:'{"target":1}'}}]})};
  };
  read('busy=true');const pending=read("decision(8,'vote')");await until(()=>!!signal);
  read('togglePause();openAgent(8);$("modelInput").value="updated-model";saveAgent()');
  await until(()=>read('!!apiWaiting'));assert.equal(signal.aborted,true);
  read('openAgent(8);$("modelInput").value="updated-again";saveAgent();togglePause()');
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(n,1);assert.equal(read('paused'),true);
  read('retryAPI()');assert.equal((await pending).target,0);assert.equal(n,2);
});

test('无效JSON、截断、空发言和非法技能结果关联请求日志并暂停',async t=>{
  for(const item of [
    {task:'speech',content:'{"speech":"incomplete',code:'INVALID_AGENT_RESPONSE'},
    {task:'speech',content:'{"speech":"valid"}',finish_reason:'length',code:'AGENT_OUTPUT_TRUNCATED'},
    {task:'speech',content:'{"speech":"   "}',code:'INVALID_AGENT_RESPONSE',rule:'SPEECH_EMPTY'},
    {task:'speech',content:'null',code:'INVALID_AGENT_RESPONSE',rule:'ACTION_OBJECT_REQUIRED'},
    {task:'vote',content:'{"target":9}',code:'INVALID_ACTION',rule:'TARGET_NOT_ALLOWED'},
    {task:'hunter',content:'{"target":99}',code:'INVALID_ACTION',rule:'TARGET_OUT_OF_RANGE'}
  ]){
    const {context}=setup();const calls=[],events=[];const read=code=>vm.runInContext(code,context);t.after(()=>read('reset()'));
    context.fetch=async(url,options)=>{const body=JSON.parse(options.body);if(url==='/api/agent-events'){events.push(body);return {ok:true};}calls.push(body);return {ok:true,status:200,json:async()=>({choices:[{finish_reason:item.finish_reason,message:{content:item.content}}]})}};
    const pending=read('decision(8,"'+item.task+'")');await until(()=>read('!!apiWaiting'));
    assert.equal(read('paused'),true);assert.equal(read('apiWaiting.code'),item.code);
    assert.equal(calls.length,1);assert.equal(events.length,1);
    assert.equal(events[0].requestId,calls[0].requestId);assert.equal(events[0].code,item.code);
    if(item.rule){assert.equal(events[0].validation.rule,item.rule);assert.equal(events[0].responseChars,Array.from(item.content).length);}
    assert.doesNotMatch(JSON.stringify(events),/secret-test-key|content|messages|speechHistory/);
    read('reset()');await pending;
  }
});

test('换房丢弃忽略取消信号的迟到响应，不推进下一局',async t=>{
  const {context}=setup();let release,signal,n=0;
  const read=code=>vm.runInContext(code,context);t.after(()=>read('reset()'));
  context.fetch=async(url,options)=>{n++;signal=options.signal;return new Promise(resolve=>release=resolve)};
  read('busy=true;turnDelay=0');const pending=read("takeTurn(8,'vote','投票',epoch)");await until(()=>!!release);
  read('reset(6)');release({ok:true,json:async()=>({choices:[{message:{content:'{"target":1}'}}]})});
  assert.equal(await pending,null);assert.equal(signal.aborted,true);assert.equal(n,1);
  assert.equal(read('size'),6);assert.equal(read('game.phase'),'lobby');assert.equal(read('apiWaiting'),null);
});

test('普通观战夜间隐藏持续等待的席位、请求编号和错误细节',async t=>{
  const {context}=setup(new Map(),true,true,false,true);let release;
  const read=code=>vm.runInContext(code,context);t.after(()=>read('reset()'));
  context.fetch=async()=>new Promise(resolve=>release=resolve);
  read('game.phase="night";setPortraitMode(true);setPerspective("public")');
  const pending=read("decision(8,'night')");await until(()=>!!release);
  const requestId=read('agentPending.requestId');
  let html=read('$("actionPanel").innerHTML+$("portraitAPIDialogText").textContent+$("portraitAPIStatus").textContent');
  assert.doesNotMatch(html,/9 号|9号/);assert.equal(html.includes(requestId),false);
  release({ok:false,status:504,json:async()=>({error:{code:'UPSTREAM_TIMEOUT',message:'私有诊断详情'}})});
  await until(()=>read('!!apiWaiting'));
  html=read('$("actionPanel").innerHTML+$("portraitAPIDialogText").textContent+$("portraitAPIStatus").textContent');
  assert.doesNotMatch(html,/9 号|9号|私有诊断详情/);assert.equal(html.includes(requestId),false);
  read('reset()');await pending;
});


test('多份行动 JSON 只暂停一次，安全诊断关联原请求且不自动补发',async t=>{
  const {context}=setup();const calls=[],events=[];const read=code=>vm.runInContext(code,context);
  t.after(()=>read('reset()'));
  const content='{"speech":"private-draft"}\n{"speech":"private-final"}';
  context.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url==='/api/agent-events'){events.push(body);return {ok:true}}
    calls.push(body);
    return {ok:true,status:200,json:async()=>({choices:[{message:{content}}]})};
  };
  const pending=read('decision(8,"speech")');
  await until(()=>read('!!apiWaiting'));
  assert.equal(read('paused'),true);assert.equal(calls.length,1);assert.equal(events.length,1);
  assert.equal(events[0].requestId,calls[0].requestId);
  assert.equal(events[0].jsonIssue,'MULTIPLE_JSON_VALUES');assert.equal(events[0].responseChars,content.length);
  assert.doesNotMatch(JSON.stringify(events),/private-draft|private-final|secret-test-key/);
  assert.match(calls[0].messages[0].content,/合法的 JSON 对象/);
  read('reset()');await pending;
});


test('服务端兼容纯文字发言后，当前行动正常完成且仅请求一次',async t=>{
  const {context}=setup();
  const calls=[],events=[],read=code=>vm.runInContext(code,context);
  const speech='我是1号岚，身份是平民。\n\n第一晚是平安夜，我先听大家发言。';
  t.after(()=>read('reset()'));
  context.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url==='/api/agent-events'){events.push(body);return {ok:true}}
    calls.push(body);
    const response={status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:speech}]}]};
    return {ok:true,status:200,json:async()=>context.NightfallAgentRequest.gameResponse(response,{actionTask:body.action.task})};
  };
  read('profiles[0]={...profiles[8]};game.phase="discussion"');
  const action=await read('decision(0,"speech")');
  assert.equal(action.speech,speech);
  assert.equal(read('apiWaiting'),null);
  assert.equal(read('paused'),false);
  assert.equal(read('profiles[0].connection'),'ok');
  assert.equal(calls.length,1);
  assert.equal(calls[0].action.task,'speech');
  assert.equal(calls[0].action.seat,1);
  assert.equal(events.length,0);
});

test('已暂停的纯文字发言在服务端修复后可原地重试并恢复当前行动',async t=>{
  const {context}=setup();
  const calls=[],events=[],read=code=>vm.runInContext(code,context);
  const speech='我是1号岚，身份是平民。第一晚是平安夜，先听大家发言。';
  let repaired=false;
  t.after(()=>read('reset()'));
  context.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url==='/api/agent-events'){events.push(body);return {ok:true}}
    calls.push(body);
    const response={status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:speech}]}]};
    const result=repaired?context.NightfallAgentRequest.gameResponse(response,{actionTask:body.action.task}):{choices:[{message:{content:speech}}]};
    return {ok:true,status:200,json:async()=>result};
  };
  read('profiles[0]={...profiles[8]};game.phase="discussion"');
  const before=read('JSON.stringify(game)');
  const pending=read('decision(0,"speech")');
  await until(()=>read('!!apiWaiting'));
  assert.equal(read('apiWaiting.id'),0);
  assert.equal(calls.length,1);
  assert.equal(events[0].jsonIssue,'MISSING_JSON');
  repaired=true;
  read('handleAPIWaitCommand("retry-api");handleAPIWaitCommand("retry-api")');
  const action=await pending;
  assert.equal(action.speech,speech);
  assert.equal(read('apiWaiting'),null);
  assert.equal(read('paused'),false);
  assert.equal(read('JSON.stringify(game)'),before);
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0].action,calls[1].action);
  assert.deepEqual(calls[0].messages,calls[1].messages);
  assert.notEqual(calls[0].requestId,calls[1].requestId);
  assert.equal(events.length,1);
});

test('完整纯文字发言缺少 JSON 时准确暂停且不播放或自动重发',async t=>{
  const {context}=setup();
  const calls=[],events=[],read=code=>vm.runInContext(code,context);
  t.after(()=>read('reset()'));
  context.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url==='/api/agent-events'){events.push(body);return {ok:true}}
    calls.push(body);
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:'private complete speech'}}]})};
  };
  const pending=read('decision(8,"speech")');
  await until(()=>read('!!apiWaiting'));
  assert.equal(read('paused'),true);
  assert.match(read('apiWaiting.message'),/已返回文字.*缺少有效的行动 JSON 对象/);
  assert.equal(read('transcript.length'),0);
  assert.equal(read('narration'),null);
  assert.equal(calls.length,1);
  assert.equal(events.length,1);
  assert.equal(events[0].jsonIssue,'MISSING_JSON');
  assert.doesNotMatch(JSON.stringify(events),/private complete speech|secret-test-key/);
  await new Promise(setImmediate);
  assert.equal(calls.length,1);
  read('reset()');await pending;
});


function speechPipeline(t,{size=6,actors=[0,1,2],api=actors,pk=false,portrait=false,ignoreAbort=false,realPlayback=false}={}){
  const {context}=setup(new Map(),false,false,false,portrait),chat=[],events=[],playbacks=[];
  const read=code=>vm.runInContext(code,context);
  read('reset('+size+');game.start();busy=true;turnDelay=0;game.phase="'+(pk?'voting':'discussion')+'";game.pk='+(pk?JSON.stringify(actors):'null')+';game.players.forEach(p=>p.alive='+JSON.stringify(actors)+'.includes(p.id));profiles.forEach((p,id)=>{p.control='+JSON.stringify(api)+'.includes(id)?"api":"local";p.endpoint="https://example.test/v1";p.model="pipeline-model";p.key="pipeline-test-key"});');
  if(portrait)read('portraitMode=true');
  context.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url==='/api/agent-events'){events.push(body);return {ok:true};}
    assert.equal(url,'/api/chat');
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(Object.assign(Error('cancelled'),{name:'AbortError'}));
      const reply=value=>{options.signal.removeEventListener('abort',abort);resolve(value)};
      chat.push({body,signal:options.signal,reply,speech:text=>reply({ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({speech:text})}}]})}),fail:(code='UPSTREAM_ERROR',message='模拟接口失败')=>reply({ok:false,status:503,json:async()=>({error:{code,message}})})});
      if(!ignoreAbort)options.signal.addEventListener('abort',abort,{once:true});
    });
  };
  if(!realPlayback){
    context.pipelinePlayback=entry=>new Promise(resolve=>playbacks.push({id:entry.id,text:entry.text,finish:resolve}));
    read('showPlayerSpeech=pipelinePlayback');
  }
  let running;
  t.after(async()=>{read('reset()');for(const item of playbacks)item.finish();for(const item of chat)item.speech('迟到结果');await running;});
  return {context,read,chat,events,playbacks,start(){running=read('aiSpeeches('+pk+',epoch)');return running}};
}

test('六与十二人普通及PK发言仅提前一位，完整采用前文后才请求且按序播放一次',async t=>{
  for(const size of [6,12])for(const pk of [false,true])await t.test(size+'人 '+(pk?'PK':'普通'),async t=>{
    const h=speechPipeline(t,{size,pk,portrait:true}),{read,chat,playbacks}=h;
    const running=h.start();await until(()=>chat.length===1);
    const text='😀'.repeat(1450),finalText='😀'.repeat(1400);
    chat[0].speech(text);
    await until(()=>chat.length===2&&playbacks.length===1);
    assert.equal(playbacks[0].text,finalText);
    assert.equal(read('activeSeat'),0);assert.equal(read('portraitFocus()'),0);
    assert.equal(read('transcript.length'),1);
    const nextInput=JSON.parse(chat[1].body.messages.at(-1).content);
    assert.equal(nextInput.context.speeches.at(-1).text,finalText);
    assert.equal(nextInput.context.speeches.at(-1).seat,1);
    assert.equal(nextInput.context.speeches.at(-1).pk,pk);
    assert.equal(nextInput.context.players.some(p=>'role' in p),false);
    assert.equal(chat[1].body.purpose,'game-action');
    assert.equal(chat[1].body.maxTokens,25000);
    assert.match(read("$('actionPanel').innerHTML"),/1 号.*正在.*发言/);
    assert.match(read("$('portraitAPIStatus').textContent"),/准备下一位/);
    chat[1].speech('第二位完整发言');
    await until(()=>read('preparedSpeech.status')==='ready');
    assert.equal(chat.length,2);assert.equal(read('transcript.length'),1);assert.equal(playbacks.length,1);
    assert.match(read("$('portraitAPIStatus').textContent"),/下一位已就绪/);
    assert.doesNotMatch(read("$('actionPanel').innerHTML"),/data-command="stop-api"/);
    playbacks[0].finish();await until(()=>chat.length===3&&playbacks.length===2);
    assert.deepEqual(playbacks.map(p=>p.id),[0,1]);
    const thirdInput=JSON.parse(chat[2].body.messages.at(-1).content);
    assert.equal(thirdInput.context.speeches.at(-1).text,'第二位完整发言');
    assert.equal(thirdInput.context.speeches.length,2);
    chat[2].speech('第三位结束发言');await until(()=>read('preparedSpeech.status')==='ready');
    playbacks[1].finish();await until(()=>playbacks.length===3);
    assert.equal(chat.length,3);assert.equal(read('preparedSpeech'),null);
    playbacks[2].finish();await running;
    assert.deepEqual(playbacks.map(p=>p.id),[0,1,2]);
    assert.equal(read('game.speechHistory.length'),3);assert.equal(read('transcript.length'),3);
    assert.equal(read('agentPending'),null);assert.equal(read('activeSeat'),null);
  });
});

test('下一位慢响应接续同一请求和计时，当前发言结束后才切换人物',async t=>{
  const h=speechPipeline(t,{actors:[0,1]}),{read,chat,playbacks}=h;
  const running=h.start();await until(()=>chat.length===1);chat[0].speech('上一位');
  await until(()=>chat.length===2&&playbacks.length===1);
  const requestId=read('agentPending.requestId'),startedAt=read('agentPending.startedAt');
  playbacks[0].finish();await until(()=>read('activeSeat')===1);
  assert.equal(chat.length,2);assert.equal(playbacks.length,1);
  assert.equal(read('agentPending.requestId'),requestId);assert.equal(read('agentPending.startedAt'),startedAt);
  assert.equal(read('agentPending.preparing'),false);
  chat[1].speech('等待完成后的发言');await until(()=>playbacks.length===2);
  playbacks[1].finish();await running;assert.equal(chat.length,2);
});

test('模拟席位在轮到时计算，写入前文后才提前请求紧邻API席位',async t=>{
  const h=speechPipeline(t,{actors:[0,1,2,3],api:[0,2,3]}),{read,chat,playbacks,context}=h;
  context.localTurns=[];
  read('const actualLocalDecision=localStoryDecision;localStoryDecision=(id,task,extra)=>{localTurns.push(id);return actualLocalDecision(id,task,extra)}');
  const running=h.start();await until(()=>chat.length===1);chat[0].speech('第一位');
  await until(()=>playbacks.length===1);
  assert.equal(chat.length,1);assert.equal(context.localTurns.length,0);
  playbacks[0].finish();await until(()=>playbacks.length===2&&chat.length===2);
  assert.deepEqual(context.localTurns,[1]);
  assert.equal(JSON.parse(chat[1].body.messages.at(-1).content).context.speeches.at(-1).seat,2);
  chat[1].speech('第三位');await until(()=>read('preparedSpeech.status')==='ready');
  assert.equal(chat.length,2);playbacks[1].finish();await until(()=>playbacks.length===3&&chat.length===3);
  chat[2].speech('第四位');await until(()=>read('preparedSpeech.status')==='ready');
  playbacks[2].finish();await until(()=>playbacks.length===4);playbacks[3].finish();await running;
  assert.deepEqual(playbacks.map(p=>p.id),[0,1,2,3]);
});

test('提前请求错误延后至对应席位暂停，普通继续不重发，手动重试只新增一笔请求',async t=>{
  for(const invalid of [false,true])await t.test(invalid?'无效发言':'接口错误',async t=>{
    const h=speechPipeline(t,{actors:[0,1]}),{read,chat,playbacks}=h;
    const running=h.start();await until(()=>chat.length===1);chat[0].speech('完整播放本句');
    await until(()=>chat.length===2&&playbacks.length===1);
    if(invalid)chat[1].speech(' ');else chat[1].fail();
    await until(()=>read('preparedSpeech.status')==='failed');
    assert.equal(read('paused'),false);assert.equal(read('apiWaiting'),null);
    assert.equal(read('activeSeat'),0);assert.equal(read('transcript.length'),1);
    playbacks[0].finish();await until(()=>read('!!apiWaiting'));
    assert.equal(read('apiWaiting.id'),1);assert.equal(read('apiWaiting.requestId'),chat[1].body.requestId);
    assert.equal(read('paused'),true);assert.equal(playbacks.length,1);
    read('togglePause()');await new Promise(setImmediate);assert.equal(chat.length,2);
    read('retryAPI();retryAPI()');await until(()=>chat.length===3);
    assert.equal(JSON.parse(chat[2].body.messages.at(-1).content).context.speeches.at(-1).text,'完整播放本句');
    assert.notEqual(chat[2].body.requestId,chat[1].body.requestId);
    chat[2].speech('手动重试成功');await until(()=>playbacks.length===2);
    playbacks[1].finish();await running;
    assert.equal(read('game.speechHistory.length'),2);assert.equal(chat.length,3);
  });
});

test('暂停期间提前返回结果保留一次，恢复前不提交或开始下一段',async t=>{
  const h=speechPipeline(t,{actors:[0,1]}),{read,chat,playbacks}=h;
  const running=h.start();await until(()=>chat.length===1);chat[0].speech('当前发言');
  await until(()=>chat.length===2&&playbacks.length===1);read('togglePause()');
  chat[1].speech('已准备发言');await until(()=>read('preparedSpeech.status')==='ready');
  playbacks[0].finish();await new Promise(setImmediate);
  assert.equal(read('paused'),true);assert.equal(read('transcript.length'),1);assert.equal(playbacks.length,1);
  read('togglePause()');await until(()=>playbacks.length===2);
  assert.equal(chat.length,2);playbacks[1].finish();await running;
  assert.equal(read('transcript.length'),2);
});

test('停止提前等待仅取消目标请求，当前播放保留并在目标席位等待手动重试',async t=>{
  const h=speechPipeline(t,{actors:[0,1]}),{read,chat,playbacks,events}=h;
  const running=h.start();await until(()=>chat.length===1);chat[0].speech('本句继续播放');
  await until(()=>chat.length===2&&playbacks.length===1);read('stopAgentWait()');
  await until(()=>read('preparedSpeech.status')==='failed');
  assert.equal(chat[1].signal.aborted,true);assert.equal(read('paused'),false);
  assert.equal(read('activeSeat'),0);assert.equal(read('apiWaiting'),null);
  playbacks[0].finish();await until(()=>read('!!apiWaiting'));
  assert.equal(read('apiWaiting.code'),'AGENT_WAIT_CANCELLED');
  assert.equal(events[0].requestId,chat[1].body.requestId);
  read('retryAPI()');await until(()=>chat.length===3);chat[2].speech('确认后重试');
  await until(()=>playbacks.length===2);playbacks[1].finish();await running;
  assert.equal(chat.length,3);
});

test('已准备及在途目标配置变化均使旧结果失效，恢复播放后要求显式重试',async t=>{
  for(const ready of [false,true])await t.test(ready?'已就绪':'在途',async t=>{
    const h=speechPipeline(t,{actors:[0,1]}),{read,chat,playbacks}=h;
    const running=h.start();await until(()=>chat.length===1);chat[0].speech('当前发言');
    await until(()=>chat.length===2&&playbacks.length===1);
    if(ready){chat[1].speech('旧配置发言');await until(()=>read('preparedSpeech.status')==='ready');}
    read('togglePause();openAgent(1);$("modelInput").value="updated-model";saveAgent()');
    await until(()=>read('preparedSpeech.status')==='failed');
    if(!ready)assert.equal(chat[1].signal.aborted,true);
    assert.equal(chat.length,2);assert.equal(read('apiWaiting'),null);
    read('togglePause()');playbacks[0].finish();await until(()=>read('!!apiWaiting'));
    assert.equal(read('apiWaiting.code'),'AGENT_CONFIG_CHANGED');assert.equal(playbacks.length,1);
    read('retryAPI()');await until(()=>chat.length===3);
    assert.equal(chat[2].body.model,'updated-model');chat[2].speech('新配置发言');
    await until(()=>playbacks.length===2);assert.equal(playbacks[1].text,'新配置发言');
    playbacks[1].finish();await running;
    assert.equal(read('transcript.some(s=>s.text==="旧配置发言")'),false);
  });
});

test('换房取消提前请求与计时器，忽略取消的迟到响应不污染新房间',async t=>{
  const h=speechPipeline(t,{actors:[0,1],ignoreAbort:true}),{read,chat,playbacks}=h;
  const running=h.start();await until(()=>chat.length===1);chat[0].speech('旧局发言');
  await until(()=>chat.length===2&&playbacks.length===1);
  read('reset(12)');assert.equal(chat[1].signal.aborted,true);
  assert.equal(read('preparedSpeech'),null);assert.equal(read('agentPending'),null);
  assert.equal(read('activeRequest'),null);assert.equal(read('transcript.length'),0);
  chat[1].speech('迟到的旧局结果');playbacks[0].finish();await running;
  assert.equal(read('game.phase'),'lobby');assert.equal(read('size'),12);
  assert.equal(read('transcript.length'),0);assert.equal(chat.length,2);
});


test('实际语音与字幕完整播放，准备请求取消不停止音频且录屏对白按实际播放记录',async t=>{
  const h=speechPipeline(t,{actors:[0,1],realPlayback:true}),{context,read,chat}=h;
  const audios=installRuleAudio(context),speechRequests=[],recorded=[],finished=[],waits=[];
  context.URL=class extends URL{static createObjectURL(){return 'blob:pipeline-'+speechRequests.length}static revokeObjectURL(){}};
  const agentFetch=context.fetch;
  context.fetch=async(url,options)=>{
    if(url!=='/api/speech')return agentFetch(url,options);
    speechRequests.push(options);return {ok:true,blob:async()=>({size:512,type:'audio/mpeg'})};
  };
  context.recordingTranscriptBegin=entry=>{recorded.push(entry);return String(recorded.length)};
  context.recordingTranscriptEnd=(id,status)=>finished.push({id,status});
  context.pipelineWait=()=>new Promise(resolve=>waits.push(resolve));
  read('voiceEnabled=true;profiles.forEach(p=>{p.voiceProvider="neural";p.voiceMatch="custom"});presentationWait=pipelineWait');
  const running=h.start();await until(()=>chat.length===1);chat[0].speech('第一句完整的对白');
  await until(()=>chat.length===2&&audios.length===1&&recorded.length===1);
  assert.equal(recorded[0].seat,0);assert.equal(speechRequests.length,1);
  audios[0].duration=8;audios[0].currentTime=2;audios[0].ontimeupdate();
  const caption=read('speechBubble.caption');
  read('togglePause()');audios[0].currentTime=5;audios[0].ontimeupdate();
  assert.equal(read('speechBubble.caption'),caption);assert.equal(audios[0].pauses,1);
  read('togglePause();stopAgentWait()');await until(()=>read('preparedSpeech.status')==='failed');
  assert.equal(read('paused'),false);assert.equal(read('narration.seat'),0);
  assert.equal(speechRequests[0].signal.aborted,false);assert.equal(audios[0].pauses,1);
  assert.equal(read('transcript.length'),1);assert.equal(recorded.length,1);
  audios[0].onended();await until(()=>waits.length===1);
  assert.equal(read('speechBubble.caption'),'第一句完整的对白');
  waits.shift()(true);await until(()=>read('!!apiWaiting'));
  assert.equal(read('apiWaiting.id'),1);assert.equal(recorded.length,1);
  read('retryAPI()');await until(()=>chat.length===3);chat[2].speech('第二句完整的对白');
  await until(()=>audios.length===2&&recorded.length===2);
  assert.equal(recorded[1].seat,1);assert.equal(recorded[1].text,'第二句完整的对白');
  audios[1].onended();await until(()=>waits.length===1);waits.shift()(true);await running;
  assert.deepEqual(recorded.map(item=>item.seat),[0,1]);
  assert.deepEqual(finished,[{id:'1',status:'played'},{id:'2',status:'played'}]);
  assert.equal(chat.length,3);assert.equal(speechRequests.length,2);
});

test('语音失败暂停期间下一位结果只暂存，无声继续后按实际阅读顺序记录',async t=>{
  const h=speechPipeline(t,{actors:[0,1],realPlayback:true}),{context,read,chat}=h;
  installRuleAudio(context);const recorded=[],waits=[];let speechCalls=0;
  const agentFetch=context.fetch;
  context.fetch=async(url,options)=>{
    if(url!=='/api/speech')return agentFetch(url,options);
    speechCalls++;return {ok:false,status:503,json:async()=>({error:{message:'语音三次失败',attempts:3}})};
  };
  context.recordingTranscriptBegin=entry=>{recorded.push(entry);return String(recorded.length)};
  context.pipelineWait=()=>new Promise(resolve=>waits.push(resolve));
  read('voiceEnabled=true;profiles.forEach(p=>{p.voiceProvider="neural";p.voiceMatch="custom"});presentationWait=pipelineWait');
  const running=h.start();await until(()=>chat.length===1);chat[0].speech('语音失败但保留的原句');
  await until(()=>chat.length===2&&read('!!speechFailure'));
  chat[1].speech('下一位已完成');await until(()=>read('preparedSpeech.status')==='ready');
  assert.equal(read('paused'),true);assert.equal(read('activeSeat'),0);
  assert.equal(read('transcript.length'),1);assert.equal(recorded.length,0);
  read('continueSpeechWithoutAudio();voiceEnabled=false');await until(()=>waits.length===1);
  assert.equal(recorded[0].text,'语音失败但保留的原句');assert.equal(chat.length,2);
  waits.shift()(true);await until(()=>recorded.length===2&&waits.length===1);
  assert.equal(recorded[1].text,'下一位已完成');assert.equal(recorded[1].seat,1);
  waits.shift()(true);await running;
  assert.equal(chat.length,2);assert.equal(speechCalls,1);
});

test('无声字幕阅读期间提前结果不提前写入录屏对白，结束后才切换席位',async t=>{
  const h=speechPipeline(t,{actors:[0,1],realPlayback:true}),{context,read,chat}=h;
  const recorded=[],finished=[],waits=[];
  context.recordingTranscriptBegin=entry=>{recorded.push(entry);return String(recorded.length)};
  context.recordingTranscriptEnd=(id,status)=>finished.push({id,status});
  context.pipelineWait=(ms,token,valid,replay,progress)=>new Promise(resolve=>waits.push({ms,progress,finish:resolve}));
  read('voiceEnabled=false;presentationWait=pipelineWait');
  const running=h.start();await until(()=>chat.length===1);chat[0].speech('阅读第一句全文');
  await until(()=>chat.length===2&&waits.length===1);chat[1].speech('阅读第二句全文');
  await until(()=>read('preparedSpeech.status')==='ready');
  assert.equal(recorded.length,1);assert.equal(recorded[0].seat,0);
  waits[0].progress(.5);assert.equal(read('speechBubble.id'),0);
  waits[0].progress(1);assert.equal(read('speechBubble.caption'),'阅读第一句全文');
  waits[0].finish(true);await until(()=>waits.length===2);
  assert.equal(recorded.length,2);assert.equal(recorded[1].seat,1);
  waits[1].finish(true);await running;
  assert.deepEqual(finished,[{id:'1',status:'fallback-reading'},{id:'2',status:'fallback-reading'}]);
  assert.equal(chat.length,2);
});

function votingHarness(t,{size=6,pk=false,locals=[],dead=[],ignoreAbort=false,extraSpeeches=0}={}){
  const {context}=setup(new Map(),false,true,false,true),groups=[],events=[],uploads=[];
  const read=code=>vm.runInContext(code,context);
  read('reset('+size+');game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES['+size+'][i]);game.phase="discussion";game.players.forEach(p=>game.addSpeech(p.id,"公开完整发言"+(p.id+1)));game.openVoting();busy=true;turnDelay=0;portraitMode=true;flushCommentary=async()=>true;aiSpeeches=async()=>{};profiles.slice(0,'+size+').forEach((p,i)=>Object.assign(p,{control:"api",endpoint:"https://example.test/v1",model:"seat-"+(i+1),key:"private-key-"+(i+1),reasoningEffort:i%2?"high":"xhigh"}));');
  if(extraSpeeches)read('for(let i=0;i<'+extraSpeeches+';i++)game.speechHistory.push({id:i%size,text:"历史发言"+(i+1),round:Math.floor(i/'+size+')+2,pk:i%19===0})');
  for(const id of locals)read('profiles['+id+'].control="local"');
  for(const id of dead)read('game.players['+id+'].alive=false');
  if(pk)read('game.pk=[1,3];game.voteRound=2');
  context.fetch=async(url,options)=>{
    if(url==='/api/agent-events'){events.push(JSON.parse(options.body));return {ok:true};}
    if(url.startsWith('/api/recordings')){uploads.push(url);return {ok:true,json:async()=>({saved:true})};}
    assert.equal(url,'/api/chat/batch');
    const requests=JSON.parse(options.body).requests,encoder=new TextEncoder();let streamController;
    const group={requests,signal:options.signal,emit(event){try{streamController.enqueue(encoder.encode(JSON.stringify(event)+'\n'))}catch{}},result(seat,target){const request=requests.find(item=>item.action.seat===seat);assert.ok(request);this.emit({type:'result',seat,requestId:request.requestId,result:{choices:[{message:{content:JSON.stringify({target})}}]}})},error(seat,code='UPSTREAM_ERROR'){const request=requests.find(item=>item.action.seat===seat);this.emit({type:'error',seat,requestId:request.requestId,status:503,error:{code,message:'模拟投票接口错误'}})},close(){try{streamController.close()}catch{}}};
    const body=new ReadableStream({start(controller){streamController=controller;if(!ignoreAbort)options.signal.addEventListener('abort',()=>{try{controller.error(Object.assign(Error('cancelled'),{name:'AbortError'}))}catch{}},{once:true})}});
    groups.push(group);return {ok:true,status:200,body};
  };
  let running;
  t.after(async()=>{read('reset()');for(const group of groups)group.close();await running});
  return {context,read,groups,events,uploads,start(){running=read('vote(epoch)');return running},replyAll(group=groups.at(-1),target=null){for(const request of group.requests)group.result(request.action.seat,target)}};
}


function wolfHarness(t,{size=12,extraSpeeches=130,extraEvents=22}={}){
  const {context}=setup(new Map(),false,true,false,true),groups=[];
  const read=code=>vm.runInContext(code,context);
  read([
    'reset('+size+');game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES['+size+'][i]);',
    'game.phase="night";game.round=4;',
    'game.speechHistory=Array.from({length:'+extraSpeeches+'},(_,i)=>({id:i%size,text:"夜间公开发言"+(i+1),round:Math.floor(i/'+size+')+1,pk:i%29===0}));',
    'game.logs=Array.from({length:'+extraEvents+'},(_,i)=>({text:"公开事件"+(i+1),round:Math.floor(i/'+size+')+1,phase:i%2?"voting":"discussion"}));',
    'busy=true;paused=false;portraitMode=true;flushCommentary=async()=>true;',
    'profiles.forEach(p=>Object.assign(p,{control:"local"}));',
    'game.players.filter(p=>p.role==="狼人").forEach(p=>Object.assign(profiles[p.id],{control:"api",endpoint:"https://example.test/v1",model:"wolf-seat-"+(p.id+1),key:"wolf-private-key-"+(p.id+1),reasoningEffort:p.id%2?"high":"xhigh"}));'
  ].join(''));
  const wolves=JSON.parse(read('JSON.stringify(game.players.filter(p=>p.role==="狼人").map(p=>p.id))'));
  context.fetch=async(url,options)=>{
    if(url==='/api/agent-events')return {ok:true};
    assert.equal(url,'/api/chat/batch');
    const requests=JSON.parse(options.body).requests,encoder=new TextEncoder();let streamController;
    const group={requests,signal:options.signal,emit(event){try{streamController.enqueue(encoder.encode(JSON.stringify(event)+'\n'))}catch{}},result(seat,target){const request=requests.find(item=>item.action.seat===seat);assert.ok(request);this.emit({type:'result',seat,requestId:request.requestId,result:{choices:[{message:{content:JSON.stringify({target})}}]}})},error(seat,code='UPSTREAM_ERROR'){const request=requests.find(item=>item.action.seat===seat);assert.ok(request);this.emit({type:'error',seat,requestId:request.requestId,status:503,error:{code,message:'模拟夜间接口错误'}})},close(){try{streamController.close()}catch{}}};
    const body=new ReadableStream({start(controller){streamController=controller;options.signal.addEventListener('abort',()=>{try{controller.error(Object.assign(Error('cancelled'),{name:'AbortError'}))}catch{}},{once:true})}});
    groups.push(group);return {ok:true,status:200,body};
  };
  let running;
  t.after(async()=>{read('reset()');for(const group of groups)group.close();await running});
  return {context,read,groups,wolves,start(){running=read('collectWolfChoices(game.alive().filter(p=>p.role==="狼人"),epoch,null)');return running}};
}


test('狼人批次状态按当前席位显示，后续狼人不会复用第一位狼人的结果',async t=>{
  const h=wolfHarness(t),{read,groups,wolves}=h;
  h.read('wolfPresentation={round:game.round,states:{}}');
  const running=h.start();
  await until(()=>groups.length===1);
  assert.ok(wolves.length>1);
  const pending=wolves.at(-1);
  for(const seat of wolves.slice(0,-1)){
    const target=seat+1===12?1:seat+2;
    groups[0].result(seat+1,target);
  }
  await until(()=>read('voteBatchStatus().received')===wolves.length-1);
  for(const seat of wolves.slice(0,-1)){
    const target=seat+1===12?1:seat+2;
    const state=JSON.parse(read('JSON.stringify(wolfPresentation.states['+seat+'])'));
    assert.equal(state.id,seat);
    assert.equal(state.status,'selected');
    assert.equal(state.target,target-1);
  }
  assert.equal(read('wolfPresentation.states['+pending+'].status'),'choosing');
  groups[0].result(pending+1,pending+1===12?1:pending+2);
  await running;
  assert.equal(read('voteBatch'),null);
});

test('超过120条的本局公开发言全部进入并发投票请求',async t=>{
  const h=votingHarness(t,{size:6,extraSpeeches:125}),{groups}=h;
  const running=h.start();await until(()=>groups.length===1);
  for(const request of groups[0].requests){
    const context=JSON.parse(request.messages[1].content).context;
    assert.equal(context.speeches.length,131);
    assert.equal(context.speeches[0].text,'公开完整发言1');
    assert.equal(context.speeches[5].text,'公开完整发言6');
    assert.equal(context.speeches[6].text,'历史发言1');
    assert.equal(context.speeches.at(-1).text,'历史发言125');
    assert.equal(context.speeches.filter(speech=>speech.pk).length,7);
  }
  h.replyAll(groups[0]);await running;
});

test('并发投票冻结完整发言和各席私有信息，乱序返回后按座位公布，六十二人与PK规则一致',async t=>{
  for(const size of [6,12])for(const pk of [false,true])await t.test(size+'人 '+(pk?'PK':'普通'),async t=>{
    const h=votingHarness(t,{size,pk,dead:size===12?[11]:[]}),{read,groups}=h;
    const expectedSeats=Array.from({length:size},(_,i)=>i+1).filter(seat=>seat!==12&&(!pk||![2,4].includes(seat)));
    const running=h.start();await until(()=>groups.length===1);
    assert.deepEqual(groups[0].requests.map(item=>item.action.seat),expectedSeats);
    for(const request of groups[0].requests){
      const input=JSON.parse(request.messages[1].content),context=input.context;
      assert.equal(input.task,'vote');assert.equal(context.speeches.length,size);
      assert.equal(context.speeches.at(-1).text,'公开完整发言'+size);
      assert.equal(request.reasoningEffort,context.seat%2?'xhigh':'high');assert.equal(request.maxTokens,25000);
      assert.equal(context.players.some(p=>'role' in p),false);
      assert.equal(context.role,read('game.players['+(context.seat-1)+'].role'));
      assert.equal(context.allowedTargets.includes(context.seat),false);
      if(pk)assert.ok(context.allowedTargets.every(seat=>[2,4].includes(seat)));
    }
    const reversed=groups[0].requests.slice().reverse();
    for(const request of reversed.slice(0,-1))groups[0].result(request.action.seat,null);
    await until(()=>read('voteBatchStatus().received')===expectedSeats.length-1);
    assert.equal(read('Object.keys(votePresentation.votes).length'),0);assert.equal(read('Object.keys(votePresentation.counts).length'),0);
    assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'),0);
    assert.match(read("$('portraitAPIStatus').textContent"),/投票.*已收/);
    await h.context.fetch('/api/recordings/mock/chunks',{body:'test'});assert.equal(h.uploads.length,1);
    groups[0].result(reversed.at(-1).action.seat,null);await running;
    assert.deepEqual(Array.from(read('observerEvents.filter(e=>e.kind==="vote-reveal").map(e=>e.voter+1)')),expectedSeats);
    assert.equal(read('voteBatch'),null);
    assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").every(e=>e.target==null)'),true);
  });
});

test('一席失败立即暂停公布，其余继续收票，手动重试仅提交失败席位并复用冻结上下文',async t=>{
  const h=votingHarness(t),{read,groups}=h;const running=h.start();await until(()=>groups.length===1);
  const initial=groups[0];initial.result(1,2);initial.error(2);
  await until(()=>read('voteBatchStatus().failed.length')===1);
  assert.equal(read('paused'),true);assert.equal(read('voteBatch.items[0].result.target'),1);
  assert.match(read("$('actionPanel').innerHTML"),/重试失败投票/);
  read('togglePause()');assert.equal(read('paused'),true);assert.equal(groups.length,1);
  for(const seat of [3,4,5,6])initial.result(seat,seat===3?null:2);
  await until(()=>read('voteBatchStatus().received')===5);
  assert.equal(read('Object.keys(votePresentation.votes).length'),0);
  const frozen=JSON.parse(initial.requests[1].messages[1].content);
  read('game.logs.push({text:"迟到公开内容",phase:"voting",round:1});profiles[1].model="new-model"');
  read('retryAPI()');await until(()=>groups.length===2);
  assert.deepEqual(groups[1].requests.map(x=>x.action.seat),[2]);assert.equal(groups[1].requests[0].model,'new-model');
  assert.deepEqual(JSON.parse(groups[1].requests[0].messages[1].content),frozen);
  assert.equal(read('voteBatch.items[0].result.target'),1);
  groups[1].result(2,null);await running;
  assert.equal(read('game.votes[0]'),1);assert.equal(read('game.votes[1]'),null);
  assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'),6);
});

test('手动暂停期间收齐结果仍不公布，继续后只结算一次',async t=>{
  const h=votingHarness(t),{read,groups}=h;const running=h.start();await until(()=>groups.length===1);
  read('togglePause()');h.replyAll();await until(()=>read('voteBatchStatus().received')===6);
  assert.equal(read('paused'),true);assert.equal(read('Object.keys(votePresentation.votes).length'),0);
  assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'),0);
  read('togglePause()');await running;
  assert.equal(groups.length,1);assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'),6);
});

test('停止收票取消全部在途请求，保留成功票并只为未完成席位手动重试',async t=>{
  const h=votingHarness(t),{read,groups}=h;const running=h.start();await until(()=>groups.length===1);
  groups[0].result(1,2);groups[0].result(2,1);await until(()=>read('voteBatchStatus().received')===2);
  read('stopAgentWait()');assert.equal(groups[0].signal.aborted,true);
  assert.equal(read('voteBatchStatus().failed.length'),4);assert.equal(read('voteBatchStatus().received'),2);
  assert.match(read("$('portraitAPIDialogText').textContent"),/供应商仍可能完成处理或计费/);
  read('retryAPI()');await until(()=>groups.length===2);
  assert.deepEqual(groups[1].requests.map(item=>item.action.seat),[3,4,5,6]);h.replyAll();await running;
  assert.equal(read('game.votes[0]'),1);assert.equal(read('game.votes[1]'),0);
});

test('收票阶段配置变化仅使对应成功票失效，其他结果继续收取，旧请求号无法覆盖新结果',async t=>{
  const h=votingHarness(t,{ignoreAbort:true}),{read,groups}=h;const running=h.start();await until(()=>groups.length===1);
  groups[0].result(1,2);await until(()=>read('voteBatchStatus().received')===1);
  read('profiles[0].reasoningEffort="high";invalidateVoteAgent(0)');
  assert.equal(read('voteBatch.items[0].status'),'failed');assert.equal(read('voteBatch.items[1].status'),'pending');
  read('retryAPI()');await until(()=>groups.length===2);
  assert.deepEqual(groups[1].requests.map(x=>x.action.seat),[1]);assert.equal(groups[1].requests[0].reasoningEffort,'high');
  groups[0].result(1,3);await new Promise(setImmediate);assert.equal(read('voteBatch.items[0].status'),'pending');
  for(const seat of [2,3,4,5,6])groups[0].result(seat,null);
  groups[1].result(1,null);await running;assert.equal(read('game.votes[0]'),null);
});

test('非法自投、非PK目标和残缺JSON分别暂停，成功席位保留，错误不会自动重发',async t=>{
  const h=votingHarness(t,{pk:true}),{read,groups}=h;const running=h.start();await until(()=>groups.length===1);
  groups[0].result(1,1);groups[0].result(3,6);
  const request=groups[0].requests.find(x=>x.action.seat===5);
  groups[0].emit({type:'result',seat:5,requestId:request.requestId,result:{choices:[{message:{content:'{"target":'}}]}});
  groups[0].result(6,2);await until(()=>read('voteBatchStatus().failed.length')===3);
  assert.equal(read('voteBatchStatus().received'),1);assert.equal(groups.length,1);
  assert.equal(read('Object.keys(votePresentation.votes).length'),0);
  assert.deepEqual(h.events.map(e=>e.code),['INVALID_ACTION','INVALID_ACTION','INVALID_AGENT_RESPONSE','ACTION_VALIDATED']);
  assert.deepEqual(h.events.map(e=>e.validation?.rule),['TARGET_NOT_ALLOWED','TARGET_NOT_ALLOWED',undefined,undefined]);
  assert.deepEqual(h.events.slice(0,2).map(e=>e.validation.targetAllowed),[false,false]);
  read('retryAPI()');await until(()=>groups.length===2);assert.deepEqual(groups[1].requests.map(x=>x.action.seat),[1,3,5]);h.replyAll();await running;
});

test('API与模拟席位混用时模拟票在开始时暂存，换房清理计时及迟到批次结果',async t=>{
  const h=votingHarness(t,{size:12,locals:[0,2,5],ignoreAbort:true}),{read,groups}=h;
  const running=h.start();await until(()=>groups.length===1);
  assert.equal(read('voteBatchStatus().received'),3);assert.equal(groups[0].requests.length,9);
  assert.equal(read('Object.keys(votePresentation.votes).length'),0);
  const batch=read('voteBatch');read('reset(6)');groups[0].result(2,1);groups[0].close();await running;
  assert.equal(groups[0].signal.aborted,true);assert.equal(read('voteBatch'),null);
  assert.equal(read('game.size'),6);assert.equal(read('game.phase'),'lobby');assert.equal(read('game.logs.length'),0);
  assert.equal(batch.wake,null);
});

test('原本手动暂停时发生投票错误，重试成功后仍需用户继续',async t=>{
  const h=votingHarness(t),{read,groups}=h;const running=h.start();await until(()=>groups.length===1);
  read('togglePause()');groups[0].error(1);for(const seat of [2,3,4,5,6])groups[0].result(seat,null);
  await until(()=>read('voteBatchStatus().received')===5);read('retryAPI()');await until(()=>groups.length===2);
  h.replyAll();await until(()=>read('voteBatchStatus().received')===6);
  assert.equal(read('paused'),true);assert.equal(read('Object.keys(votePresentation.votes).length'),0);
  read('togglePause()');await running;
});


test('收票连接中断保留已成功票，仅重试未完成席位',async t=>{
  const h=votingHarness(t),{read,groups}=h;
  const running=h.start();
  await until(()=>groups.length===1);
  groups[0].result(1,2);
  groups[0].result(3,null);
  await until(()=>read('voteBatchStatus().received')===2);
  groups[0].close();
  await until(()=>read('voteBatchStatus().failed.length')===4);
  assert.equal(read('paused'),true);
  assert.equal(read('voteBatch.items[0].result.target'),1);
  assert.equal(read('Object.keys(votePresentation.votes).length'),0);
  read('retryAPI()');
  await until(()=>groups.length===2);
  assert.deepEqual(groups[1].requests.map(item=>item.action.seat),[2,4,5,6]);
  h.replyAll();
  await running;
  assert.equal(read('game.votes[0]'),1);
  assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'),6);
});

test('剧本上下文准备时停止收票，旧准备完成不会发出额外投票',async t=>{
  const h=votingHarness(t),{context,read,groups}=h,pending=[];
  context.storyContext=id=>new Promise(resolve=>pending.push({id,resolve}));
  const running=h.start();
  await until(()=>pending.length===6);
  read('stopAgentWait()');
  assert.equal(read('voteBatchStatus().failed.length'),6);
  assert.equal(groups.length,0);
  context.storyContext=async()=>null;
  read('retryAPI()');
  await until(()=>groups.length===1);
  for(const item of pending)item.resolve({self:{name:'迟到的旧资料'}});
  await new Promise(setImmediate);
  assert.equal(groups.length,1);
  assert.equal(read('voteBatchStatus().failed.length'),0);
  h.replyAll();
  await running;
});

test('剧本准备期间修改单席配置，旧准备错误不覆盖新尝试，其余席位继续收票',async t=>{
  const h=votingHarness(t),{context,read,groups}=h;
  let rejectOld,first=true;
  context.storyContext=id=>{
    if(id===0&&first){first=false;return new Promise((resolve,reject)=>{rejectOld=reject})}
    return Promise.resolve(null);
  };
  const running=h.start();
  await until(()=>typeof rejectOld==='function');
  read('profiles[0].model="updated-seat-1";invalidateVoteAgent(0);retryAPI()');
  await until(()=>groups.length===1);
  assert.deepEqual(groups[0].requests.map(item=>item.action.seat),[1]);
  assert.equal(groups[0].requests[0].model,'updated-seat-1');
  rejectOld(Error('旧准备失败'));
  await until(()=>groups.length===2);
  assert.deepEqual(groups[1].requests.map(item=>item.action.seat),[2,3,4,5,6]);
  assert.equal(read('voteBatch.items[0].status'),'pending');
  h.replyAll(groups[0]);
  h.replyAll(groups[1]);
  await running;
});

test('本地模拟PK票在开始时规范为合法目标，公布后修改配置不改变已锁定票型',async t=>{
  const h=votingHarness(t,{pk:true,locals:[2]}),{read,groups}=h;
  read('game.players[2].role="预言家";game.knowledge[2]={0:"狼人"}');
  let updated=false;
  h.context.flushCommentary=async()=>{
    if(!updated){updated=true;read('profiles[0].model="changed-during-reveal";invalidateVoteAgent(0)')}
    return true;
  };
  const running=h.start();
  await until(()=>groups.length===1);
  assert.equal(read('voteBatch.items[2].result.target'),null);
  assert.equal(read('Object.keys(votePresentation.votes).length'),0);
  groups[0].result(1,2);
  for(const seat of [5,6])groups[0].result(seat,null);
  await running;
  assert.equal(read('game.votes[0]'),1);
  assert.equal(read('game.votes[2]'),null);
  assert.equal(groups.length,1);
  assert.equal(read('observerEvents.filter(e=>e.kind==="vote-reveal").length'),4);
});


test('行动诊断区分字段、座位和技能约束，六人与十二人都保留具体原因',()=>{
  const {context}=setup(),read=code=>vm.runInContext(code,context);
  const cases=[
    {task:'speech',reply:[],rule:'ACTION_OBJECT_REQUIRED',field:'action',type:'array'},
    {task:'speech',reply:{},rule:'SPEECH_REQUIRED',field:'speech',type:'missing'},
    {task:'speech',reply:{speech:12},rule:'SPEECH_TYPE',field:'speech',type:'number'},
    {task:'vote',reply:{},rule:'TARGET_REQUIRED',field:'target',type:'missing'},
    {task:'vote',reply:{target:'private-reply'},rule:'TARGET_TYPE',field:'target',type:'string'},
    {task:'hunter',reply:{target:1.5},rule:'TARGET_TYPE',field:'target',type:'number'},
    {task:'night',reply:{target:0},rule:'TARGET_OUT_OF_RANGE',field:'target',type:'number'},
    {task:'night',reply:{target:99},rule:'TARGET_OUT_OF_RANGE',field:'target',type:'number'},
    {task:'night',reply:{target:1},rule:'TARGET_NOT_ALLOWED',field:'target',type:'number'},
    {task:'night',reply:{poison:null},skill:true,rule:'SAVE_REQUIRED',field:'save',type:'missing'},
    {task:'night',reply:{save:'private-reply',poison:null},skill:true,rule:'SAVE_TYPE',field:'save',type:'string'},
    {task:'night',reply:{save:false},skill:true,rule:'POISON_REQUIRED',field:'poison',type:'missing'},
    {task:'night',reply:{save:false,poison:'private-reply'},skill:true,rule:'POISON_TYPE',field:'poison',type:'string'},
    {task:'night',reply:{save:false,poison:99},skill:true,rule:'POISON_OUT_OF_RANGE',field:'poison',type:'number'},
    {task:'night',reply:{save:true,poison:null},skill:true,saveAvailable:false,rule:'SAVE_UNAVAILABLE',field:'save',type:'boolean'},
    {task:'night',reply:{save:true,poison:2},skill:true,rule:'POTION_CONFLICT',field:'poison',type:'number'},
    {task:'night',reply:{save:false,poison:2},skill:true,poisonAvailable:false,rule:'POISON_UNAVAILABLE',field:'poison',type:'number'},
    {task:'night',reply:{save:false,poison:1},skill:true,rule:'POISON_NOT_ALLOWED',field:'poison',type:'number'}
  ];
  const {safeEntry}=require('./agent-log.cjs');
  for(const roomSize of [6,12])for(const item of cases){
    context.validationCase={...item,roomSize,text:JSON.stringify(item.reply)};
    read('size=validationCase.roomSize;game=new Nightfall.Game(size).start();game.players[0].role=validationCase.skill?"女巫":"平民";game.potions={save:validationCase.saveAvailable!==false,poison:validationCase.poisonAvailable!==false}');
    let failure;
    assert.throws(()=>read('validateAgentDecision(0,validationCase.task,validationCase.text,buildAgentContext(0,validationCase.task,{victim:1}),{victim:1})'),error=>{failure=error;return true});
    const entry=safeEntry({event:'validation_failed',code:failure.code,validation:failure.validation,responseChars:failure.responseChars});
    assert.equal(entry.validation.rule,item.rule);
    assert.equal(entry.validation.field,item.field);
    assert.equal(entry.validation.actualType,item.type);
    assert.equal(entry.validation.roomSize,roomSize);
    assert.equal(entry.responseChars,Array.from(context.validationCase.text).length);
    if(item.field==='target'||item.field==='poison'){
      assert.equal(entry.validation.allowedTargetCount,roomSize-1);
      assert.equal(entry.validation.targetAllowed,['POTION_CONFLICT','POISON_UNAVAILABLE'].includes(item.rule));
    }
    assert.doesNotMatch(JSON.stringify(entry),/private-reply|狼人|女巫|apiKey|allowedTargets|wolfTeammates|potions|reply/);
  }
  for(const roomSize of [6,12]){
    context.validationRoomSize=roomSize;
    read('size=validationRoomSize;game=new Nightfall.Game(size).start();game.players[0].role="平民"');
    assert.equal(read('validateAgentDecision(0,"night",JSON.stringify({target:2}),buildAgentContext(0,"night")).target'),1);
    assert.equal(read('validateAgentDecision(0,"vote",JSON.stringify({target:null}),buildAgentContext(0,"vote")).target'),null);
    read('game.players[0].role="女巫"');
    assert.equal(read('validateAgentDecision(0,"night",JSON.stringify({save:false,poison:null}),buildAgentContext(0,"night"),{victim:null}).poison'),null);
  }
});



test('六人和十二人狼队请求并发携带完整历史且看不到队友选择',async t=>{
  for(const size of [6,12])await t.test(size+'人',async t=>{
    const h=wolfHarness(t,{size}),running=h.start();
    await until(()=>h.groups.length===1);
    const group=h.groups[0];
    assert.deepEqual(group.requests.map(request=>request.action.seat),h.wolves.map(id=>id+1));
    assert.equal(group.requests.length,size===6?2:4);
    for(const request of group.requests){
      const input=JSON.parse(request.messages[1].content),ctx=input.context;
      assert.equal(input.task,'night');
      assert.equal(ctx.speeches.length,130);
      assert.equal(ctx.speeches[0].text,'夜间公开发言1');
      assert.equal(ctx.speeches.at(-1).text,'夜间公开发言130');
      assert.equal(ctx.publicEvents.length,22);
      assert.equal(ctx.publicEvents.at(-1).text,'公开事件22');
      assert.ok(ctx.speeches.some(speech=>speech.pk));
      assert.equal(ctx.role,'狼人');
      assert.deepEqual(Array.from(ctx.wolfTeammates),h.wolves.filter(id=>id+1!==request.action.seat).map(id=>id+1));
      assert.deepEqual(Array.from(ctx.allowedTargets),Array.from({length:size},(_,i)=>i+1));
      assert.ok(ctx.players.every(player=>!('role' in player)));
      assert.equal('wolfChoices' in ctx,false);
      assert.equal('choices' in ctx,false);
      assert.equal(request.action.role,'狼人');
      assert.equal(request.maxTokens,25000);
      assert.equal(request.reasoningEffort,request.action.seat%2?'xhigh':'high');
    }
    for(const request of group.requests)group.result(request.action.seat,request.action.seat);
    const choices=await running;
    for(const id of h.wolves)assert.equal(choices[id].target,id);
  });
});

test('狼人选刀部分失败后只重试失败席位并保留已成功选择',async t=>{
  const h=wolfHarness(t,{size:12}),running=h.start();
  await until(()=>h.groups.length===1);
  const initial=h.groups[0],failedSeat=h.wolves[1]+1;
  for(const id of [h.wolves[0],h.wolves[2],h.wolves[3]])initial.result(id+1,id+1);
  initial.error(failedSeat);
  await until(()=>h.read('voteBatchStatus().failed.length')===1);
  assert.equal(h.read('paused'),true);
  for(const id of [h.wolves[0],h.wolves[2],h.wolves[3]])assert.equal(h.read('voteBatch.items['+id+'].result.target'),id);
  const frozen=JSON.parse(initial.requests.find(request=>request.action.seat===failedSeat).messages[1].content);
  h.read('game.logs.push({text:"重试前新增事件",phase:"night",round:4});retryAPI()');
  await until(()=>h.groups.length===2);
  const retry=h.groups[1];
  assert.deepEqual(retry.requests.map(request=>request.action.seat),[failedSeat]);
  assert.deepEqual(JSON.parse(retry.requests[0].messages[1].content),frozen);
  initial.result(failedSeat,1);
  await new Promise(setImmediate);
  assert.equal(h.read('voteBatch.items['+h.wolves[1]+'].status'),'pending');
  retry.result(failedSeat,h.wolves[0]+1);
  const choices=await running;
  assert.equal(choices[h.wolves[1]].target,h.wolves[0]);
  assert.equal(h.groups.length,2);
});

test('六与十二人夜间角色音效仅在上帝视角播放',async()=>{
 for(const count of [6,12])for(const perspective of ['god','public']){
  const {context}=setup(new Map(),false),sounds=[];
  context.recordEffect=(name)=>sounds.push(name);
  vm.runInContext(`reset(${count});game.start();setPerspective('${perspective}');effects.play=recordEffect;presentationWait=async()=>true`,context);
  for(const kind of ['wolf','guard','seer','save','poison']){
   context.currentCue=kind;
   await vm.runInContext("animateEvent({kind:currentCue,private:true,round:1,actors:[],publicText:'',godText:''},epoch)",context);
  }
  assert.deepEqual(sounds,perspective==='god'?['wolf','guard','seer','save','poison']:[]);
 }
});

test('批量测试中相同接口、模型、密钥和推理强度的席位只请求一次并共享结果',async()=>{
  const {context}=setup();const sent=[];
  vm.runInContext("reset(12);profiles[0]={...profiles[8]};profiles[2]={...profiles[8]}",context);
  context.fetch=async(url,options)=>{sent.push(JSON.parse(options.body));return {ok:true,json:async()=>({connection:{ok:true,mode:'stream'}})}};
  await vm.runInContext('testAll()',context);
  assert.equal(sent.length,1);
  assert.deepEqual(Array.from(vm.runInContext('[0,2,8].map(i=>profiles[i].connection)',context)),['ok','ok','ok']);
  assert.match(vm.runInContext("$('toast').textContent",context),/3 \/ 3 个 API Agent 连接成功/);
  vm.runInContext("profiles[2].reasoningEffort='high'",context);sent.length=0;
  await vm.runInContext('testAll()',context);
  assert.equal(sent.length,2);
  assert.deepEqual(sent.map(r=>r.reasoningEffort).sort(),['high','xhigh']);
});

test('批量测试不同接口并发进行且最多同时三个，按钮显示正在测试的全部席位',async()=>{
  const {context}=setup();const pending=[];
  vm.runInContext("reset(12);for(const [i,host] of [[0,'a'],[1,'b'],[2,'c'],[3,'d']])profiles[i]={...profiles[8],endpoint:'https://'+host+'.example.test/v1'};profiles[8].control='local'",context);
  context.fetch=async(url,options)=>new Promise(resolve=>pending.push({resolve,body:JSON.parse(options.body)}));
  const run=vm.runInContext('testAll()',context);
  await until(()=>pending.length===3);
  assert.deepEqual(pending.map(p=>p.body.endpoint),['https://a.example.test/v1','https://b.example.test/v1','https://c.example.test/v1']);
  assert.match(vm.runInContext("$('testAllBtn').textContent",context),/3 \/ 4 · 1、2、3 号/);
  assert.equal(vm.runInContext('profiles[3].connection',context),'queued');
  pending[1].resolve({ok:true,json:async()=>({connection:{ok:true,mode:'stream'}})});
  await until(()=>pending.length===4);
  assert.match(vm.runInContext("$('testAllBtn').textContent",context),/4 \/ 4 · 1、3、4 号/);
  for(const p of [pending[0],pending[2],pending[3]])p.resolve({ok:true,json:async()=>({connection:{ok:true,mode:'stream'}})});
  await run;
  assert.match(vm.runInContext("$('toast').textContent",context),/4 \/ 4 个 API Agent 连接成功/);
});

test('响应头已返回但模型超时显示“已连通 · 响应较慢”，不计为连接失败',async()=>{
  const {context}=setup();
  const message='接口已连通（HTTP 200），但 60 秒内未返回模型结果，响应较慢';
  context.fetch=async()=>({ok:false,status:504,json:async()=>({error:{code:'UPSTREAM_TIMEOUT',stage:'response',message}})});
  assert.equal(await vm.runInContext('testConnection(profiles[8],false)',context),false);
  assert.equal(vm.runInContext('profiles[8].connection',context),'slow');
  assert.match(vm.runInContext("$('toast').textContent",context),/已连通但响应较慢/);
  vm.runInContext('reset(12)',context);
  await vm.runInContext('testAll()',context);
  assert.match(vm.runInContext("$('agentGrid').innerHTML",context),/已连通 · 响应较慢/);
  assert.match(vm.runInContext("$('agentGrid').innerHTML",context),/agent-error agent-slow/);
  assert.doesNotMatch(vm.runInContext("$('agentGrid').innerHTML",context),/请补填并保存/);
  assert.match(vm.runInContext("$('playersGrid').innerHTML",context),/API 响应慢/);
  assert.match(vm.runInContext("$('toast').textContent",context),/0 \/ 1 个 API Agent 连接成功，1 个已连通但响应较慢/);
  context.fetch=async()=>({ok:false,status:504,json:async()=>({error:{code:'UPSTREAM_TIMEOUT',stage:'connect',message:'连接接口超时'}})});
  await vm.runInContext('testAll()',context);
  assert.equal(vm.runInContext('profiles[8].connection',context),'error');
});

test('批量测试重置时中止全部并发中的连接请求',async()=>{
  const {context}=setup();let aborted=0;
  vm.runInContext("reset(12);profiles[0]={...profiles[8],endpoint:'https://a.example.test'};profiles[1]={...profiles[8],endpoint:'https://b.example.test'}",context);
  context.fetch=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('Cancelled','AbortError'))},{once:true}));
  const run=vm.runInContext('testAll()',context);
  await until(()=>vm.runInContext('connectionBatch?.controllers.size',context)===3);
  vm.runInContext('reset(6)',context);await run;
  assert.equal(aborted,3);
  assert.equal(vm.runInContext('profiles.some(p=>["testing","queued"].includes(p.connection))',context),false);
});