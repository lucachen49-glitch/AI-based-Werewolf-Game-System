'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const S=require('./scenario.js'),P=require('./workshop-preview.js'),W=require('./workshop-state.js');
const {createScenarioStore,StoryError}=require('./scenario-store.cjs'),{createPreviewJobs}=require('./story-preview-jobs.cjs'),{createStoryAssets}=require('./story-assets.cjs'),{createStoryArtJobs}=require('./story-art-jobs.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-preview-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=createScenarioStore(root),story=await store.save({...S.bloodMoonSample(6),confirmed:true}),state=P.clean();story.scenes.forEach((x,i)=>{if(i)state.reviews[i]=P.transition(story,i)});return {root,store,story,state}}
async function done(service,id){for(let n=0;n<200;n++){const j=service.summary(await service.get(id));if(j.status!=='running')return j;await new Promise(r=>setTimeout(r,5))}throw Error('Preview did not finish')}
test('电影剧本按实际镜头时长检查，不再强制90/120秒；人物覆盖和检查失效仍生效',()=>{const s=S.validate(S.bloodMoonSample(6)),r=P.clean();assert.ok(s.scenes.every(x=>x.duration>=1&&x.duration<=15));assert.equal(s.targetDuration,s.scenes.reduce((sum,x)=>sum+x.duration,0));s.scenes.forEach((x,i)=>{if(i)r.reviews[i]=P.transition(s,i)});assert.deepEqual(P.preflight(s,r),[]);const source=S.bloodMoonSample(6),variable=S.validate({...source,scenes:source.scenes.map((scene,i)=>i===0?{...scene,duration:9,narrationSeconds:9}:i===7?{...scene,duration:9,narrationSeconds:9}:scene)}),variableState=P.clean();variable.scenes.forEach((x,i)=>{if(i)variableState.reviews[i]=P.transition(variable,i)});assert.equal(variable.targetDuration,variable.scenes.reduce((sum,x)=>sum+x.duration,0));assert.deepEqual(P.preflight(variable,variableState),[]);const hash=P.fingerprint(s,r);s.scenes[2].dialogues[0].text+='谁？';assert.notEqual(hash,P.fingerprint(s,r));assert.match(P.preflight(s,r).join(' '),/镜头 3.*尚未人工确认/);assert.match(P.preflight(s,r).join(' '),/镜头 4.*尚未人工确认/);s.scenes[0].duration=16;s.scenes[1].dialogues[0].seat=6;const invalid=P.preflight(s,r).join(' ');assert.match(invalid,/镜头 1.*时长应为1—15/);assert.match(invalid,/镜头 2.*6号说话者没有出场/);const twelve=S.bloodMoonSample(12);assert.equal(twelve.narrativeMode,undefined);assert.equal(twelve.targetDuration,twelve.scenes.reduce((sum,x)=>sum+x.duration,0));assert.equal(twelve.characters.length,12)});
test('草稿保存素材片段、待复用图片与人工检查；不保存额外密钥且旧数据兼容',()=>{let raw;const storage={getItem:()=>raw,setItem:(k,v)=>raw=v},s=S.bloodMoonSample(6),asset='video:'+randomUUID()+':scene:1',portrait='art:'+randomUUID()+':character:0',rehearsal={selections:{0:{asset,start:1,end:12,apiKey:'never-store-credential'}},reuse:{1:portrait},reviews:{1:P.transition(s,1)},apiKey:'never-store-credential'};const w=W.save(storage,W.read(storage),{draft:s,dirty:true,rehearsal});const entry=W.latest(w,6);assert.equal(entry.rehearsal.selections[0].end,12);assert.equal(entry.rehearsal.reuse[1],portrait);assert.equal(entry.draft.narrativeMode,'continuity-v1');assert.ok(!raw.includes('never-store-credential'));assert.deepEqual(P.clean(undefined).selections,{});assert.deepEqual(P.clean({selections:{0:{asset:'../secret'}}}).selections,{});W.save(storage,w,{draft:S.bloodMoonSample(12),dirty:true});assert.equal(W.latest(W.read(storage),6).rehearsal.selections[0].asset,asset)});
test('本地预演去重、失败继续、私有信息隔离、确认与版本门槛',async t=>{const {root,store,story,state}=await fixture(t);let failed=false,assembled=0;const called=[];const media={async scene(dir,j,i,{onProgress}){called.push(i);await onProgress('voicing','配音 '+i);if(i===2&&!failed){failed=true;throw new StoryError(503,'VOICE_FAILED','免费语音暂时中断')}await fs.writeFile(path.join(dir,'scene-'+i+'.mp4'),'fixture');return {cues:[],voiceTracks:1}},async assemble(dir){assembled++;await fs.writeFile(path.join(dir,'preview.mp4'),'fixture')}};let service=createPreviewJobs({root:path.join(root,'previews'),store,assets:{resolve(){throw Error('No selected asset expected')}},media});t.after(()=>service.close());const body={storyId:story.id,version:1,rehearsal:state};const [a,b]=await Promise.all([service.create(body),service.create(body)]);assert.equal(a.id,b.id);let j=await done(service,a.id);assert.equal(j.status,'paused');assert.equal(j.message,'免费语音暂时中断');assert.equal(j.scenes[0].status,'done');await service.close();service=createPreviewJobs({root:path.join(root,'previews'),store,assets:{},media});await service.action(a.id,{action:'resume'});j=await done(service,a.id);assert.equal(j.status,'ready');assert.equal(called.filter(i=>i===0).length,1);assert.equal(assembled,1);await assert.rejects(service.approved(a.id,story.id,1));await assert.rejects(service.action(a.id,{action:'confirm',watched:true,fingerprint:'stale'}));j=await service.action(a.id,{action:'confirm',watched:true,fingerprint:j.fingerprint});assert.equal(j.confirmed,true);await service.approved(j.id,story.id,1);const saved=JSON.stringify(await service.get(j.id));for(const c of story.characters)assert.ok(!saved.includes(c.secret));await assert.rejects(service.mediaFile(j.id,'../job.json'));await store.save({...story,title:'修订'});await assert.rejects(service.action(j.id,{action:'resume'}),e=>e.code==='STALE_PREVIEW');await assert.rejects(service.approved(j.id,story.id,2));const twelve=await store.save({...S.bloodMoonSample(12),confirmed:true});const twelveState=P.clean();twelve.scenes.forEach((x,i)=>{if(i)twelveState.reviews[i]=P.transition(twelve,i)});const twelveJob=await service.create({storyId:twelve.id,version:1,rehearsal:twelveState});assert.equal(twelveJob.roomSize,12);assert.equal((await done(service,twelveJob.id)).status,'ready')});
test('素材按任务白名单读取，房间隔离，视频区间不足不冻结补时',async t=>{const {root,store,story,state}=await fixture(t),id=randomUUID();await fs.mkdir(path.join(root,id));await fs.writeFile(path.join(root,id,'scene-0.mp4'),'clip');const source={id,roomSize:6,storyId:story.id,version:1,scenes:[{status:'done',duration:8}],art:{characters:[{file:'../../secret'}]}};const jobs={root,get:async()=>source,list:async()=>[source],mediaFile:async()=>path.join(root,id,'scene-0.mp4')},assets=createStoryAssets({jobs,artJobs:{list:async()=>[]}});await assert.rejects(assets.resolve('video:'+id+':scene:0',12));await assert.rejects(assets.resolve('video:'+id+':character:0',6));await assert.rejects(assets.resolve('../../secret',6));assert.equal((await assets.catalog(6)).find(x=>x.kind==='scene').duration,8);state.selections[0]={asset:'video:'+id+':scene:0',start:0};const preview=createPreviewJobs({root:path.join(root,'preview'),store,assets});t.after(()=>preview.close());await assert.rejects(preview.create({storyId:story.id,version:1,rehearsal:state}),e=>e.code==='PREVIEW_SOURCE_TOO_SHORT');await assert.rejects(fs.access(path.join(root,'preview')))});
test('图片复用复制为待确认副本，保留来源，不改原任务且不调用生成模型',async t=>{const {root,store,story}=await fixture(t);const current=await store.save({...story,title:story.title+' 新版',confirmed:true}),sourceFile=path.join(root,'original.png');await fs.writeFile(sourceFile,'image');const before=await fs.readFile(sourceFile);let paid=0;const art=createStoryArtJobs({root:path.join(root,'art'),store,fetchImpl:async()=>{paid++;throw Error('Must not generate')}});t.after(()=>art.close());const asset='video:'+randomUUID()+':character:0',frame='video:'+randomUUID()+':frame:0';const resolve=async key=>({kind:key===asset?'character':'frame',mime:'image/png',file:sourceFile,item:key===asset?{seat:1,name:story.characters[0].name,appearance:S.appearance(story.characters[0])}:{description:story.scenes[0].description,cast:S.sceneCast(story,0)},id:'original-task',storyId:story.id,roomSize:6,version:1});const j=await art.importAssets({storyId:story.id,version:current.version,roomSize:6,characters:{1:asset},frames:{0:frame}},resolve),full=await art.get(j.id);assert.equal(paid,0);assert.equal(j.charactersConfirmed,false);assert.equal(j.framesConfirmed,false);assert.equal(full.characters[0].reuse.asset,asset);assert.equal(full.characters[0].reuse.confirmed,false);assert.notEqual(full.characters[0].file,sourceFile);assert.equal(full.characters[0].status,'done');assert.equal(full.characters[1].status,'queued');assert.equal(full.frames[0].status,'done');assert.deepEqual(await fs.readFile(sourceFile),before);await assert.rejects(art.importAssets({storyId:story.id,version:current.version,roomSize:6,characters:{1:asset}},resolve),e=>e.code==='REUSE_EXISTING_TASK')});
test('12 人剧本可从同人数旧任务复用定妆照与分镜图，仍需重新确认',async t=>{const {root,store,story}=await fixture(t);const oldTwelve=await store.save({...S.bloodMoonSample(12),confirmed:true}),twelve=await store.save({...oldTwelve,title:oldTwelve.title+' 新版',confirmed:true}),source=path.join(root,'old.png');await fs.writeFile(source,'old-image');const art=createStoryArtJobs({root:path.join(root,'art-12'),store,fetchImpl:async()=>{throw Error('image generation must not run')}});t.after(()=>art.close());const id=randomUUID(),character='video:'+id+':character:11',frame='video:'+id+':frame:0',calls=[];const resolve=async(key,size)=>{calls.push([key,size]);return key===character?{kind:'character',mime:'image/png',file:source,item:{seat:12,name:twelve.characters[11].name,appearance:S.appearance(twelve.characters[11])},id,storyId:twelve.id,roomSize:12,version:1}:{kind:'frame',mime:'image/png',file:source,item:{description:twelve.scenes[0].description,cast:S.sceneCast(twelve,0)},id,storyId:twelve.id,roomSize:12,version:1}};const job=await art.importAssets({storyId:twelve.id,version:twelve.version,roomSize:12,characters:{12:character},frames:{0:frame}},resolve),saved=await art.get(job.id);assert.equal(saved.roomSize,12);assert.deepEqual(calls,[[character,12],[frame,12]]);assert.equal(saved.characters[11].status,'done');assert.equal(saved.frames[0].status,'done');assert.equal(saved.charactersConfirmed,false);assert.equal(saved.framesConfirmed,false);assert.equal(saved.characters[11].reuse.confirmed,false)});

test('字幕时间进位、控制字符转义和静态预演标记',()=>{const {ass}=require('./preview-media.cjs');const text=ass([{start:59.999,end:61,text:'{override}\\secret\n台词'},{start:0,end:90,text:'静态分镜 / 临时对白',label:true}]);assert.match(text,/0:01:00.00,0:01:01.00/);assert.ok(!text.includes('{override}'));assert.match(text,/Label.*静态分镜/)});

test('浏览器显式默认外观与旧保存字段匹配；改外观才使检查失效',()=>{const saved=S.bloodMoonSample(6),shown=structuredClone(saved);shown.characters.forEach(c=>{c.appearance=S.appearance(c);c.portraitId||='portrait-'+String(c.seat).padStart(2,'0');c.voiceId=S.voiceId(c)});assert.equal(P.fingerprint(saved,{}),P.fingerprint(shown,{}));assert.equal(P.transition(saved,1),P.transition(shown,1));shown.characters[0].appearance+='，银色耳坠';assert.notEqual(P.fingerprint(saved,{}),P.fingerprint(shown,{}));assert.notEqual(P.transition(saved,1),P.transition(shown,1));});

test('空白起止画面与保存后的缺省字段一致，真实画面修改仍使预演失效',()=>{const saved=S.bloodMoonSample(6),shown=structuredClone(saved);delete saved.scenes[0].startFrame;delete saved.scenes[0].endFrame;shown.scenes[0].startFrame=' ';shown.scenes[0].endFrame='';shown.scenes[0].description=' '+saved.scenes[0].description+' ';assert.equal(P.fingerprint(saved,{}),P.fingerprint(shown,{}));assert.equal(P.transition(saved,1),P.transition(shown,1));shown.scenes[0].endFrame='薇拉已经坐下';assert.notEqual(P.fingerprint(saved,{}),P.fingerprint(shown,{}));assert.notEqual(P.transition(saved,1),P.transition(shown,1));});

test('退役的本地预演界面保持隐藏，不再参与人物与分镜流程',async()=>{const vm=require('node:vm'),nodes={};const node=id=>nodes[id]??=( {disabled:false,hidden:false});const context=vm.createContext({NightfallPreview:P,document:{getElementById:node},$:node});vm.runInContext(await fs.readFile('workshop-preview-ui.js','utf8'),context);vm.runInContext('previewChecks()',context);assert.equal(nodes.rehearsalPanel.hidden,true);assert.equal(nodes.preflightPanel.hidden,true);});

test('预演恢复保留未填写视频终点的原始选择，不把服务端默认值写成新素材版本',async t=>{const {root,store,story,state}=await fixture(t),id=randomUUID(),source=path.join(root,'frame.png');await fs.writeFile(source,'fixture-image');state.selections[0]={asset:'video:'+id+':frame:0',start:0};const media={async scene(dir,j,i){await fs.writeFile(path.join(dir,'scene-'+i+'.mp4'),'fixture');return {}},async assemble(dir){await fs.writeFile(path.join(dir,'preview.mp4'),'fixture')}};const service=createPreviewJobs({root:path.join(root,'previews'),store,assets:{resolve:async()=>({file:source,mime:'image/png',duration:10,id,storyId:story.id,version:1})},media});t.after(()=>service.close());const created=await service.create({storyId:story.id,version:1,rehearsal:state});await done(service,created.id);const restored=(await service.list(story.id))[0];assert.deepEqual(restored.selections,state.selections);assert.equal(restored.scenes[0].source.end,10);assert.equal(restored.selections[0].end,undefined);assert.equal(restored.fingerprint,P.fingerprint(story,{selections:restored.selections}));assert.equal((await service.create({storyId:story.id,version:1,rehearsal:state})).id,created.id);});

test('修订版本只复用未变的已渲染预演镜头，不继承叙事确认',async t=>{const {root,store,story,state}=await fixture(t);const calls=[];const media={async scene(dir,j,i){calls.push([j.version,i]);await fs.writeFile(path.join(dir,'scene-'+i+'.mp4'),'rendered-'+i);return {cues:[]}},async assemble(dir){await fs.writeFile(path.join(dir,'preview.mp4'),'assembled')}};const service=createPreviewJobs({root:path.join(root,'previews'),store,assets:{},media});t.after(()=>service.close());const first=await service.create({storyId:story.id,version:1,rehearsal:state});await done(service,first.id);const revised=structuredClone(story);revised.scenes[5].dialogues[0].text='让每个人说完。';const saved=await store.save(revised);saved.scenes.forEach((x,i)=>{if(i)state.reviews[i]=P.transition(saved,i)});const next=await service.create({storyId:saved.id,version:2,rehearsal:state}),ready=await done(service,next.id);assert.deepEqual(calls.filter(x=>x[0]===2),[[2,5]]);assert.equal(ready.confirmed,false);assert.equal(ready.scenes[0].reusedPreview,first.id);assert.equal(ready.scenes[5].reusedPreview,undefined);});


test('未检查衔接可先制作预演，完整观看且逐镜检查后才可确认，不跳过结构校验',async t=>{
  const {root,store,story,state}=await fixture(t),unchecked=P.clean();
  assert.equal(P.preflight(story,unchecked).length,7);
  assert.deepEqual(P.preflight(story,unchecked,{requireReviews:false}),[]);
  const invalid=structuredClone(story);invalid.scenes[0].duration=16;
  assert.match(P.preflight(invalid,unchecked,{requireReviews:false}).join(' '),/镜头 1.*时长应为1—15/);
  const media={async scene(dir,j,i){await fs.writeFile(path.join(dir,'scene-'+i+'.mp4'),'fixture');return {}},async assemble(dir){await fs.writeFile(path.join(dir,'preview.mp4'),'fixture')}};
  const service=createPreviewJobs({root:path.join(root,'previews'),store,assets:{},media});t.after(()=>service.close());
  const first=await service.create({storyId:story.id,version:1,rehearsal:unchecked});const ready=await done(service,first.id);
  assert.equal(ready.status,'ready');
  const confirm={action:'confirm',watched:true,fingerprint:ready.fingerprint};
  await assert.rejects(service.action(first.id,confirm),e=>e.code==='PREVIEW_REVIEW_REQUIRED');
  // Marking checks does not change footage or cause a second job.
  assert.equal(P.fingerprint(story,state),ready.fingerprint);
  assert.equal((await service.create({storyId:story.id,version:1,rehearsal:state})).id,first.id);
  assert.equal((await service.action(first.id,{...confirm,rehearsal:state})).confirmed,true);
});


test('免费语音断网保留具体原因，继续处理复用已完成镜头',async t=>{
  const {root,store,story}=await fixture(t);const {SpeechError}=require('./voice.cjs');let interrupted=false;const called=[];
  const media={async scene(dir,j,i){called.push(i);if(i===1&&!interrupted){interrupted=true;throw new SpeechError(503,'VOICE_NETWORK_ERROR','自然语音服务暂不可用，请稍后继续')}await fs.writeFile(path.join(dir,'scene-'+i+'.mp4'),'fixture');return {}},async assemble(dir){await fs.writeFile(path.join(dir,'preview.mp4'),'fixture')}};
  const service=createPreviewJobs({root:path.join(root,'previews'),store,assets:{},media});t.after(()=>service.close());
  const j=await service.create({storyId:story.id,version:1,rehearsal:{}}),paused=await done(service,j.id);
  assert.equal(paused.status,'paused');assert.match(paused.message,/自然语音服务暂不可用/);assert.equal(paused.scenes[0].status,'done');
  await service.action(j.id,{action:'resume'});assert.equal((await done(service,j.id)).status,'ready');assert.equal(called.filter(x=>x===0).length,1);
});

test('确认按钮列出观看、人工衔接、旧版本和未保存原因；全部完成才可继续',()=>{
  const s=S.bloodMoonSample(6),state=P.clean(),current={id:randomUUID(),version:2};
  const job={id:randomUUID(),storyId:current.id,version:2,status:'ready',url:'/preview.mp4',fingerprint:P.fingerprint(s,state)};
  let opts={job,current,watched:true};assert.equal(P.confirmationIssues(s,state,opts).length,7);
  s.scenes.forEach((x,i)=>{if(i)state.reviews[i]=P.transition(s,i)});
  assert.deepEqual(P.confirmationIssues(s,state,opts),[]);
  assert.match(P.confirmationIssues(s,state,{...opts,watched:false}).join('；'),/完整观看/);
  assert.match(P.confirmationIssues(s,state,{...opts,dirty:true}).join('；'),/保存当前剧本/);
  for(const stale of [{version:1},{storyId:randomUUID()},{fingerprint:'old'}])assert.match(P.confirmationIssues(s,state,{...opts,job:{...job,...stale}}).join('；'),/旧配置或旧版本.*免费/);
  assert.match(P.confirmationIssues(s,state,{...opts,job:{...job,status:'paused'}}).join('；'),/完成当前版本/);
  assert.deepEqual(P.confirmationIssues(s,state,{...opts,watched:false,job:{...job,confirmed:true}}),[]);
  assert.match(P.confirmationIssues(s,state,{...opts,errors:['对白超时']}).join('；'),/对白超时/);
});

test('完整观看合并实际播放区间，跳到结尾、局部重播或未知时长不算完成',()=>{
  assert.equal(P.fullPlayback([[0,89.7]],90),true);
  assert.equal(P.fullPlayback([[0,30],[30,65],[65,90]],90),true);
  assert.equal(P.fullPlayback([[0,30],[20,60],[50,90]],90),true);
  assert.equal(P.fullPlayback([[0,30],[60,90]],90),false);
  assert.equal(P.fullPlayback([[0,40],[0,40],[80,90]],90),false);
  assert.equal(P.fullPlayback([[89,90]],90),false);
  assert.equal(P.fullPlayback([],Infinity),false);assert.equal(P.fullPlayback([],0),false);
  assert.equal(P.fullPlayback([[0,.6]],1),false);
});

test('观看凭据随草稿恢复且不改变素材版本；只保留任务与版本标记',()=>{
  let raw;const storage={getItem:()=>raw,setItem:(k,v)=>raw=v},story=S.bloodMoonSample(6),id=randomUUID(),fingerprint=P.fingerprint(story,{});
  const saved=W.save(storage,W.read(storage),{draft:story,rehearsal:{previewId:id,watchedPreview:{id,fingerprint,apiKey:'do-not-store'}}});
  const restored=W.latest(W.read(storage),6).rehearsal;
  assert.deepEqual(restored.watchedPreview,{id,fingerprint});assert.equal(P.fingerprint(story,restored),fingerprint);assert.ok(!raw.includes('do-not-store'));
  assert.equal(P.clean({watchedPreview:{id:'../wrong',fingerprint}}).watchedPreview,undefined);
  assert.equal(P.clean({watchedPreview:{id,fingerprint:'invalid'}}).watchedPreview,undefined);
});


test('英文双语新稿按单词检查自然语速，长对白和旁白仍阻止制作',()=>{
  for(const size of [6,12]){
    const story=S.validate(S.bloodMoonEnglishSample(size));
    assert.deepEqual(P.preflight(story,{}, {requireReviews:false}),[]);
    story.scenes[0].dialogues[0].text='This is an intentionally overlong line. '.repeat(20);
    assert.match(P.preflight(story,{}, {requireReviews:false}).join(' '),/镜头 1.*对白偏长/);
    story.scenes[1].narration='This narration cannot fit. '.repeat(20);
    story.scenes[1].narrationSeconds=1;
    assert.match(P.preflight(story,{}, {requireReviews:false}).join(' '),/镜头 2.*旁白可能超过/);
  }
});
