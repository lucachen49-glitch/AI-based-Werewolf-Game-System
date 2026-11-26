'use strict';
function agentResponse(text){return {status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]}]};}
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const Schema = require('./scenario.js');
const {createScenarioStore, atomic} = require('./scenario-store.cjs');
const {createStoryArtJobs} = require('./story-art-jobs.cjs');
const {createProductionJobs, alignCues} = require('./story-production-jobs.cjs');
const {report} = require('./story-production-review.cjs');
const agent = {endpoint:'https://audit.test/v1',model:'vision-test',apiKey:'runtime-only-test-key'};
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(fn) {
  for(let i=0;i<600;i++) { const result=await fn();if(result)return result;await pause(10); }
  throw Error('制作状态等待超时');
}
async function fixture(t, options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-production-'));
  const store=createScenarioStore(root);
  const story=await store.save({...Schema.bloodMoonEnglishSample(options.size||6),confirmed:true});
  const imageCalls=[],videoCalls=[],checks=[],revisionInputs=[];let probes=0;
  const art=createStoryArtJobs({root:path.join(root,'art'),store,
    provider:{generate:async input=>{imageCalls.push(input);return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('image-'+imageCalls.length)]);}},
    config:{status:async()=>({configured:true}),loadCredential:async()=>({model:'mock-image'})},normalize:async(bytes,file)=>fs.writeFile(file,bytes)});
  const videos=new Map();
  const jobs={
    list:async()=>[...videos.values()],get:async id=>videos.get(id),summary:j=>structuredClone(j),
    claim:async id=>videos.get(id),pause:async()=>{},unpause:async()=>{},
    mediaFile:async(id,name)=>path.join(root,id,name),
    create:async body=>{
      videoCalls.push(body);const id=randomUUID();await fs.mkdir(path.join(root,id));
      const j={...body,id,status:'quality_review',scenes:story.scenes.map((s,index)=>({index,status:index?'queued':'done'}))};
      await fs.writeFile(path.join(root,id,'scene-0.mp4'),'scene-0');videos.set(id,j);return j;
    },
    action:async(id,body)=>{
      const j=videos.get(id),scene=j.scenes[body.index];
      if(body.action==='retry') {videoCalls.push(body);await fs.writeFile(path.join(root,id,'scene-'+body.index+'.mp4'),'redone-'+body.index);scene.quality=null;if(options.unknownRedo){scene.status='unknown';j.status='needs_review';}}
      if(body.action==='approveScene') {
        scene.quality='passed';const next=j.scenes.find(s=>s.status==='queued');
        if(next){next.status='done';await fs.writeFile(path.join(root,id,'scene-'+next.index+'.mp4'),'scene-'+next.index);}
        else j.status='ready';
      }
      return j;
    }
  };
  const finals=new Map();let composeCalls=0;
  const subtitles={
    suggestions:async()=>({cues:[]}),
    create:async body=>{composeCalls++;const j={...body,id:randomUUID(),status:options.composeFail?'failed':'ready',url:'/local-final.mp4'};finals.set(j.id,j);return j;},
    getSummary:async id=>finals.get(id),retry:async id=>{finals.get(id).status='ready';}
  };
  const reviewer={
    credential:input=>({...input}),probe:async input=>{probes++;return options.probe?options.probe(input):{image:true};},
    check:async input=>{checks.push(input);return options.review?options.review(input,checks):{verdict:'pass',summary:'checked',findings:[]};},
    revise:async(input)=>{revisionInputs.push(input);return input.key==='script'?{title:input.story.title+' revised'}:{text:input.finding?.suggestion||input.report.findings?.[0]?.suggestion||'reviewed candidate'}},
    videoInput:async()=>({images:[],transcript:{segments:[]}}),
    ...(options.visualAssets ? {visualAssets:async()=>typeof options.visualAssets==='function'?options.visualAssets():options.visualAssets} : {})
  };
  const settings={root:path.join(root,'productions'),store,artJobs:art,jobs,subtitles,reviewer,poll:()=>pause(5)};
  let productions=createProductionJobs(settings);
  t.after(async()=>{await productions.close();await art.close();await fs.rm(root,{recursive:true,force:true});});
  const start=(selectedAgent=agent)=>productions.create({storyId:story.id,version:story.version,agent:selectedAgent});
  const wait=(id,stage,status='awaiting_confirmation')=>until(async()=>{const j=await productions.get(id);return j.stage===stage&&j.status===status&&j;});
  const confirm=async(id,stage,extra={})=>{let j=await productions.get(id),a=j.artId?await art.get(j.artId):null;if(['characters','frames'].includes(stage)&&a){const items=stage==='characters'?a.characters:a.frames,kind=stage==='characters'?'character':'frame';for(let index=0;index<items.length;index++)if(!items[index].confirmed)await productions.action(id,{action:'confirmAsset',stage,index,agent,artRevision:a.revision});j=await productions.get(id);a=await art.get(j.artId)}return productions.action(id,{action:'confirm',stage,agent,authorize:true,artRevision:a?.revision,watched:true,...extra});};
  return {root,store,story,art,jobs,settings,start,wait,confirm,imageCalls,videoCalls,checks,revisionInputs,finals,
    get productions(){return productions;},get probes(){return probes;},get composeCalls(){return composeCalls;},
    async restart(){await productions.close();productions=createProductionJobs(settings);await productions.recover();}
  };
}

test('自动制作四次确认、范围授权、实际镜头检查及重复开始去重',async t=>{
  const f=await fixture(t);const [a,b]=await Promise.all([f.start(),f.start()]);assert.equal(a.id,b.id);
  await f.wait(a.id,'plan');assert.equal(f.imageCalls.length,0);assert.equal(f.probes,1);
  await assert.rejects(()=>f.confirm(a.id,'plan',{authorize:false}),{code:'CHARGE_CONFIRM_REQUIRED'});
  await f.confirm(a.id,'plan');await f.wait(a.id,'characters');assert.equal(f.imageCalls.length,6);assert.equal(f.videoCalls.length,0);
  await f.confirm(a.id,'characters');await f.wait(a.id,'frames');assert.equal(f.imageCalls.length,6+f.story.scenes.length);
  await f.confirm(a.id,'frames');await f.wait(a.id,'final');assert.equal(f.videoCalls.length,1);
  assert.equal(f.checks.filter(c=>c.kind==='video').length,f.story.scenes.length);
  await assert.rejects(()=>f.confirm(a.id,'final',{watched:false}),{code:'FINAL_PREVIEW_REQUIRED'});
  const final=await f.confirm(a.id,'final');assert.equal(final.status,'complete');assert.equal(f.composeCalls,1);
  const stored=await fs.readFile(path.join(f.root,'productions',a.id,'job.json'),'utf8');
  assert.ok(!stored.includes(agent.apiKey));assert.ok(!JSON.stringify(final).includes(f.story.characters[0].secret));
});

test('整改候选必须预览后才能采用，并可用新版本撤销',async t=>{
  const f=await fixture(t,{review:async input=>({verdict:'inspect',summary:'存在结构建议',findings:[{suggestion:'强化围桌决定的因果铺垫'}]})});
  const j=await f.start();await f.wait(j.id,'plan');let view=await f.productions.action(j.id,{action:'createRevisionCandidate',key:'script',agent});const c=view.candidates.at(-1);assert.equal(c.status,'pending');assert.equal((await f.store.get(f.story.id)).version,1);
  await assert.rejects(()=>f.productions.action(j.id,{action:'adoptRevisionCandidate',candidateId:c.id,agent}),{code:'CANDIDATE_PREVIEW_REQUIRED'});
  await f.productions.action(j.id,{action:'previewRevisionCandidate',candidateId:c.id,agent});view=await f.productions.action(j.id,{action:'adoptRevisionCandidate',candidateId:c.id,agent});assert.equal(view.status,'stale');assert.equal((await f.store.get(f.story.id)).version,2);assert.match((await f.store.get(f.story.id)).title,/revised/);
  const reverted=await f.productions.action(j.id,{action:'revertRevisionCandidate',candidateId:c.id,agent});assert.equal(reverted.candidates.find(x=>x.id===c.id).status,'reverted');assert.equal((await f.store.get(f.story.id)).version,3);assert.equal((await f.store.get(f.story.id)).title,f.story.title);
});
test('整改候选逐条关联检查意见，生成输入只包含所选意见并支持同报告多条候选',async t=>{
  const findings=[{evidence:'镜头1的握持接触不清楚',suggestion:'明确拇指与食指夹持信封'},{evidence:'镜头3手部结构异常',suggestion:'要求单手五指并保持与前镜一致'}];
  const f=await fixture(t,{review:async()=>({verdict:'redo',summary:'有两项需处理',findings})});const j=await f.start();await f.wait(j.id,'plan');
  const reportId=(await f.productions.list(f.story.id))[0].reports.script.id;
  assert.ok(reportId);
  await assert.rejects(()=>f.productions.action(j.id,{action:'createRevisionCandidate',key:'script',findingIndex:1,reportId:'outdated-report',agent}),{code:'STALE_REPORT'});
  assert.equal(f.revisionInputs.length,0);
  let view=await f.productions.action(j.id,{action:'createRevisionCandidate',key:'script',findingIndex:1,reportId,agent});
  let candidate=view.candidates.at(-1);assert.equal(candidate.findingIndex,1);assert.deepEqual(candidate.sourceFinding,findings[1]);assert.deepEqual(f.revisionInputs.at(-1).finding,findings[1]);assert.equal(f.revisionInputs.at(-1).report.findings.length,1);
  view=await f.productions.action(j.id,{action:'createRevisionCandidate',key:'script',findingIndex:0,agent});assert.equal(view.candidates.length,2);assert.equal(view.candidates.at(-1).findingIndex,0);
  view=await f.productions.action(j.id,{action:'createRevisionCandidate',key:'script',findingIndex:1,agent});assert.equal(view.candidates.length,2);
  await assert.rejects(()=>f.productions.action(j.id,{action:'createRevisionCandidate',key:'script',findingIndex:3,agent}),{code:'FINDING_NOT_FOUND'});
});

test('AI 检查失败可显式跳过并记录版本，继续不会重发素材',async t=>{
  let checks=0;const f=await fixture(t,{review:async input=>{checks++;if(checks===1)throw Error('offline');return {verdict:'pass',summary:'ok',findings:[]}}});const j=await f.start();await f.wait(j.id,'plan','blocked');
  const paused=await f.productions.action(j.id,{action:'skipChecks'});assert.equal(paused.skippedChecks.script.operator,'local-user');await f.productions.action(j.id,{action:'resume',agent});const result=await f.wait(j.id,'plan');assert.equal(result.reports.script.method,'手动跳过');assert.equal(f.imageCalls.length,0);assert.equal(checks,1);
});
test('人物图出现整改建议时保存候选，不自动付费重做',async t=>{
  const f=await fixture(t,{review:async input=>({verdict:input.kind==='character'&&input.index===0?'redo':'pass',summary:'核对',findings:input.kind==='character'&&input.index===0?[{suggestion:'调整眼神和手部动作'}]:[]})});
  const j=await f.start();await f.wait(j.id,'plan');await f.confirm(j.id,'plan');const state=await f.wait(j.id,'characters');
  assert.equal(f.imageCalls.length,6);assert.equal(state.redos['character:0'],undefined);assert.ok(state.candidates.some(c=>c.key==='character:0'));
  assert.equal(state.reports['character:0'].verdict,'redo');assert.equal(f.videoCalls.length,0);
});

test('素材确认绑定实际检查版本，暂停检查失败后仅重试检查',async t=>{
  let failOnce=true;const f=await fixture(t,{review:async input=>{if(input.kind==='character'&&failOnce){failOnce=false;throw Error('offline');}return {verdict:'pass',summary:'检查通过',findings:[]};}});
  const j=await f.start();await f.wait(j.id,'plan');await f.confirm(j.id,'plan');await f.wait(j.id,'characters','blocked');
  await f.productions.action(j.id,{action:'resume',agent});await f.wait(j.id,'characters');assert.equal(f.imageCalls.length,6);
  const a=await f.art.get((await f.productions.get(j.id)).artId);a.revision++;await atomic(path.join(f.root,'art',a.id,'job.json'),a);
  await assert.rejects(()=>f.confirm(j.id,'characters'),{code:'ART_CONFLICT'});
  await f.productions.action(j.id,{action:'pause'});await f.productions.action(j.id,{action:'resume',agent});
  await f.wait(j.id,'characters');await f.confirm(j.id,'characters');await f.wait(j.id,'frames');
});

test('刷新与服务重启保留确认节点，取消后不再生成',async t=>{
  const f=await fixture(t,{size:12});const j=await f.start();await f.wait(j.id,'plan');
  await f.restart();const restored=(await f.productions.list(f.story.id))[0];assert.equal(restored.stage,'plan');
  await f.productions.action(j.id,{action:'pause'});await f.productions.action(j.id,{action:'resume',agent});await f.wait(j.id,'plan');
  await f.productions.action(j.id,{action:'cancel'});assert.equal((await f.productions.get(j.id)).status,'cancelled');assert.equal(f.imageCalls.length,0);
});

test('素材修改会回退到受影响步骤，保留原任务，未知受理状态不自动重发',async t=>{
  const f=await fixture(t);const j=await f.start();await f.wait(j.id,'plan');await f.confirm(j.id,'plan');await f.wait(j.id,'characters');
  await f.confirm(j.id,'characters');await f.wait(j.id,'frames');await f.productions.action(j.id,{action:'pause'});
  const a=await f.art.get((await f.productions.get(j.id)).artId);a.revision++;a.charactersConfirmed=false;a.characters[0].status='unknown';a.status='needs_review';
  await atomic(path.join(f.root,'art',a.id,'job.json'),a);
  await f.productions.action(j.id,{action:'resume',agent});const blocked=await f.wait(j.id,'characters','blocked');
  assert.equal(blocked.errorCode,'SUBMISSION_UNCERTAIN');assert.equal(f.imageCalls.length,6+f.story.scenes.length);assert.equal(f.videoCalls.length,0);
});

test('待确认分镜单图重做后重新核查本镜与相邻镜，保留人物确认和其他图片',async t=>{
  let reportDefect=false;
  const f=await fixture(t,{review:async input=>({verdict:reportDefect&&input.kind==='frame'&&input.index===0?'redo':'pass',summary:'checked',findings:[]})});const j=await f.start();
  await f.wait(j.id,'plan');await f.confirm(j.id,'plan');await f.wait(j.id,'characters');
  await f.confirm(j.id,'characters');const before=await f.wait(j.id,'frames');
  const original=await f.art.get(before.artId),files=original.frames.map(frame=>frame.file);
  const charactersApproval=structuredClone(before.approvals.characters);
  const initialChecks=f.checks.length,initialImages=f.imageCalls.length;
  reportDefect=true;
  await f.productions.action(j.id,{action:'pause',checkOnly:true});
  await f.art.action(original.id,{action:'retry',kind:'frame',index:0,revision:original.revision,
    description:'Vera grips the sealed envelope at waist height, thumb on the front and fingers supporting the back.',confirmCharge:true});
  const changed=await until(async()=>{const current=await f.art.get(original.id);return current.status==='review'&&current;});
  assert.equal(changed.charactersConfirmed,true);assert.equal(changed.framesConfirmed,false);
  assert.equal(f.imageCalls.length,initialImages+1);
  assert.match(f.imageCalls.at(-1).prompt,/thumb on the front/);
  assert.match(f.imageCalls.at(-1).prompt,/visible contact and natural occlusion/);
  assert.match(f.imageCalls.at(-1).prompt,/reserve the later action and ending for subsequent animation/);
  assert.notEqual(changed.frames[0].file,files[0]);
  assert.deepEqual(changed.frames.slice(1).map(frame=>frame.file),files.slice(1));
  assert.ok(changed.history.some(item=>item.kind==='frame'&&item.index===0&&item.file===files[0]));
  await f.productions.action(j.id,{action:'resume',agent});
  const reviewed=await f.wait(j.id,'frames');
  assert.deepEqual(reviewed.approvals.characters,charactersApproval);
  assert.equal(reviewed.checkpoint.artRevision,changed.revision);
  assert.notEqual(reviewed.checkpoint.material,before.checkpoint.material);
  assert.deepEqual(f.checks.slice(initialChecks).map(check=>[check.kind,check.index]),f.story.scenes.map((_,index)=>['frame',index]));
  assert.equal(f.imageCalls.length,initialImages+1);assert.equal(f.videoCalls.length,0);
});

test('指定分镜复核只检查镜头1和镜头2并复用新素材版本', async t => {
  const f = await fixture(t);
  const j = await f.start();
  await f.wait(j.id, 'plan');
  await f.confirm(j.id, 'plan');
  await f.wait(j.id, 'characters');
  await f.confirm(j.id, 'characters');
  const before = await f.wait(j.id, 'frames');
  const artBefore = await f.art.get(before.artId);
  const checksBefore = f.checks.length;
  const imagesBefore = f.imageCalls.length;
  await f.productions.action(j.id, {action:'pause', checkOnly:true});
  await f.art.action(artBefore.id, {
    action:'retry', kind:'frame', index:0, revision:artBefore.revision,
    description:'Vera holds the sealed invitation with a clear thumb and finger grip.',
    confirmCharge:true
  });
  const artAfter = await until(async () => {
    const current = await f.art.get(artBefore.id);
    return current.status === 'review' && current.revision > artBefore.revision ? current : null;
  });
  const reviewed = await f.productions.action(j.id, {
    action:'reviewFrames', frames:[0,1], artRevision:artAfter.revision, agent
  });
  assert.equal(reviewed.status, 'awaiting_confirmation');
  assert.equal(reviewed.stage, 'frames');
  const stored = await f.productions.get(j.id);
  assert.equal(stored.checkpoint.artRevision, artAfter.revision);
  assert.deepEqual(f.checks.slice(checksBefore).map(check => [check.kind, check.index]), [['frame',0],['frame',1]]);
  assert.equal(f.imageCalls.length, imagesBefore + 1);
  assert.equal(f.videoCalls.length, 0);
  assert.equal(reviewed.reports['frame:0'].verdict, 'pass');
  assert.equal(reviewed.reports['frame:1'].verdict, 'pass');
});

test('本地合成失败继续只合成，视频复用且不会重复付费',async t=>{
  const f=await fixture(t,{composeFail:true});const j=await f.start();await f.wait(j.id,'plan');await f.confirm(j.id,'plan');await f.wait(j.id,'characters');
  await f.confirm(j.id,'characters');await f.wait(j.id,'frames');await f.confirm(j.id,'frames');const blocked=await f.wait(j.id,'video','blocked');
  assert.equal(blocked.errorCode,'LOCAL_COMPOSE_FAILED');await f.productions.action(j.id,{action:'resume',agent});await f.wait(j.id,'final');assert.equal(f.videoCalls.length,1);assert.equal(f.composeCalls,1);
});

test('字幕按可信实际转写对齐，不匹配时保留待核对时间；报告隐藏秘密与凭据',()=>{
  const cue={scene:0,en:'Come to the table now',start:0,end:3};
  assert.deepEqual(alignCues([cue],{0:{segments:[{text:cue.en,start:1,end:2}]}},{scenes:[{duration:5}]}),[{...cue,start:1,end:2}]);
  const r=report({verdict:'redo',summary:agent.apiKey,findings:[{severity:'critical',evidence:'private-exact-secret',suggestion:'Bearer test-key'}]},{characters:[{secret:'private-exact-secret'}]},agent);
  assert.ok(!JSON.stringify(r).includes(agent.apiKey));assert.ok(!JSON.stringify(r).includes('private-exact-secret'));assert.ok(!JSON.stringify(r).includes('Bearer'));
});


test('检查中暂停不会越过确认节点或提交图片，继续后复用检查结果', async t => {
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {review: async input => {
    if (input.kind === 'script') { entered(); await gate; }
    return {verdict:'pass',summary:'checked',findings:[]};
  }});
  const j = await f.start(); await reached;
  await f.productions.action(j.id,{action:'pause'}); release();
  await pause(50);
  assert.equal((await f.productions.get(j.id)).status,'paused');
  assert.equal(f.imageCalls.length,0);
  await f.productions.action(j.id,{action:'resume',agent}); await f.wait(j.id,'plan');
  assert.equal(f.checks.filter(c=>c.kind==='script').length,1);
});

test('更换整理模型时丢弃旧检查响应，重新核查后再显示确认', async t => {
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t,{review:async input=>{
    if(input.agent.model===agent.model){entered();await gate;}
    return {verdict:'pass',summary:input.agent.model,findings:[]};
  }});
  const j=await f.start();await reached;
  await f.start({...agent,model:'replacement-vision'});release();
  const state=await f.wait(j.id,'plan');
  assert.equal(state.reports.script.summary,'replacement-vision');
  assert.equal(f.imageCalls.length,0);assert.equal(f.probes,2);
});

test('视频自动重做最多一次，第二次仍有问题暂停等待人工决定', async t=>{
  const f=await fixture(t,{review:async input=>({verdict:input.kind==='video'&&input.index===0?'redo':'pass',summary:'核对',findings:[]})});
  const j=await f.start();await f.wait(j.id,'plan');await f.confirm(j.id,'plan');await f.wait(j.id,'characters');
  await f.confirm(j.id,'characters');await f.wait(j.id,'frames');await f.confirm(j.id,'frames');
  const blocked=await f.wait(j.id,'video','blocked');
  assert.equal(blocked.errorCode,'SHOT_INSPECTION_REQUIRED');assert.equal(blocked.redos['video:0'],undefined);
  assert.equal(f.videoCalls.length,1);
  await f.productions.action(j.id,{action:'acceptShot',agent});await f.wait(j.id,'final');
  assert.equal(f.videoCalls.length,1);
});

test('AI 检查发现视频问题时不自动重做；继续不会重复提交', async t=>{
  const f=await fixture(t,{unknownRedo:true,review:async input=>({verdict:input.kind==='video'?'redo':'pass',summary:'核对',findings:[]})});
  const j=await f.start();await f.wait(j.id,'plan');await f.confirm(j.id,'plan');await f.wait(j.id,'characters');
  await f.confirm(j.id,'characters');await f.wait(j.id,'frames');await f.confirm(j.id,'frames');
  await f.wait(j.id,'video','blocked');assert.equal(f.videoCalls.length,1);
  await f.productions.action(j.id,{action:'resume',agent});await f.wait(j.id,'video','blocked');
  assert.equal(f.videoCalls.length,1);
});

test('自动参考规划保留明确选择，补充前镜和场景基准，并遵守14张上限',()=>{
  const s=Schema.bloodMoonEnglishSample(12), original=JSON.stringify(s);
  const planned=Schema.automaticReferences(s);
  assert.deepEqual(planned.scenes[0].referenceFrames,[]);
  assert.deepEqual(planned.scenes[1].referenceFrames,[0]);
  assert.deepEqual(planned.scenes[3].referenceFrames,[2,0]);
  assert.equal(JSON.stringify(s),original);
  s.scenes[3].referenceFrames=[5];s.scenes[3].referencePurposes={5:'prop'};
  s.scenes[3].extraReferences=Array.from({length:14-s.scenes[3].cast.length-1},()=>({id:'test',purpose:'prop'}));
  const limited=Schema.automaticReferences(s).scenes[3];
  assert.deepEqual(limited.referenceFrames,[5]);assert.equal(limited.referencePurposes[5],'prop');
});


test('真实制作检查请求在剧本、人物、分镜和视频路径统一使用 xhigh', async () => {
  const {createProductionReviewer} = require('./story-production-review.cjs');
  const seen = [];
  const reviewer = createProductionReviewer({
    normalizeEndpoint: endpoint => endpoint + '/responses',
    fetchImpl: async (url, options) => {
      seen.push({url, headers:options.headers, body:JSON.parse(options.body)});
      return new Response(JSON.stringify(agentResponse(JSON.stringify({
        verdict:'pass', summary:'checked', findings:[]
      }))));
    }
  });
  const story = Schema.bloodMoonEnglishSample(6);
  for (const kind of ['script', 'character', 'frame', 'video']) {
    const result = await reviewer.check({agent, story, kind, index:0});
    assert.equal(result.verdict, 'pass');
    const sent = seen.at(-1);
    assert.equal(sent.url, agent.endpoint + '/responses');
    assert.equal(sent.headers.Authorization, 'Bearer ' + agent.apiKey);
    assert.deepEqual(Object.keys(sent.body).sort(), ['model','input','reasoning','max_output_tokens','stream','store'].sort());
    assert.equal(sent.body.reasoning.effort, 'xhigh');
    assert.equal(sent.body.model, agent.model);
    assert.equal(sent.body.temperature,undefined);
    assert.equal(sent.body.max_output_tokens, 25000);
    assert.match(sent.body.input[0].content[0].text, /checking a cinematic story production/);
    if (kind==='character'||kind==='frame') {
      assert.match(sent.body.input[0].content[0].text, /physical hand-to-prop contact, support, and occlusion/);
      assert.match(sent.body.input[0].content[0].text, /actual supplied still images/);
    }
    assert.equal(JSON.stringify(sent.body).includes(agent.apiKey), false);
  }
});

test('图片能力检测及制作核查拒绝 xhigh 时返回明确错误，不重发或降级', async () => {
  const {createProductionReviewer} = require('./story-production-review.cjs');
  let calls = 0;
  const reviewer = createProductionReviewer({
    normalizeEndpoint: endpoint => endpoint,
    fetchImpl: async (url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.reasoning.effort, 'xhigh');
      assert.equal(body.temperature,undefined);
      assert.equal(body.max_output_tokens, 25000);
      return new Response(JSON.stringify({error:{param:'reasoning_effort',code:'unsupported_parameter',
        message:'Unsupported reasoning_effort xhigh ' + agent.apiKey}}), {status:422});
    }
  });
  const rejects = error => {
    assert.equal(error.code, 'REASONING_EFFORT_UNSUPPORTED');
    assert.equal(error.status, 422);
    assert.match(error.message, /xhigh/);
    assert.equal(error.message.includes(agent.apiKey), false);
    return true;
  };
  await assert.rejects(reviewer.probe(agent), rejects);
  assert.equal(calls, 1);
  await assert.rejects(reviewer.check({agent, story:Schema.bloodMoonEnglishSample(12), kind:'video', index:0}), rejects);
  assert.equal(calls, 2);
});

test('制作检查拒绝 xhigh 时任务暂停，保留素材并等待手动继续', async t => {
  const {StoryError} = require('./scenario-store.cjs');
  const f = await fixture(t, {review:async input => {
    if (input.kind === 'character') {
      throw new StoryError(422, 'REASONING_EFFORT_UNSUPPORTED', '当前模型不支持推理强度 xhigh，请修改配置。');
    }
    return {verdict:'pass', summary:'checked', findings:[]};
  }});
  const created = await f.start();
  await f.wait(created.id, 'plan');
  await f.confirm(created.id, 'plan');
  const job = await until(async () => {
    const state = await f.productions.get(created.id);
    return state.status === 'blocked' && state;
  });
  assert.match(JSON.stringify(job), /REASONING_EFFORT_UNSUPPORTED/);
  const generated = f.imageCalls.length;
  assert.ok(generated > 0);
  await pause(50);
  assert.equal(f.imageCalls.length, generated);
  const art = await f.art.get(job.artId);
  assert.ok(art.characters.some(item => item.status === 'done' && item.file));
});



test('检查结果卡片逐条展示意见，点击整改时传递对应报告和意见', async () => {
  const vm = require('node:vm');
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      innerHTML: '',
      closest() { return this; },
      append() {},
      removeAttribute() {},
      load() {},
      addEventListener() {},
      getAttribute() { return null; },
    });
    return nodes.get(id);
  }
  const task = {
    id: 'ui-production', version: 1, status: 'awaiting_confirmation', stage: 'plan',
    approvals: {}, message: '待核对',
    plan: {characters: 6, shots: 9, duration: 90, imageRequests: 15, videoRequests: 9},
    reports: {
      'frame:1': {
        id: 'specific-report', verdict: 'inspect', summary: '两项需处理',
        findings: [
          {evidence: '信封与手指穿模', suggestion: '明确夹持接触'},
          {evidence: '提灯交接不连续', suggestion: '明确开始和结束状态'},
        ],
      },
    },
  };
  const posted = [];
  const sandbox = {
    document: {getElementById: node, addEventListener() {}},
    setInterval() {},
    confirm() { return true; },
  };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, 'workshop-auto-ui.js'), 'utf8'), sandbox);
  sandbox.NightfallAutoWorkshop.mount({
    context: () => ({story: {id: 'ui-story', version: 1}, roomSize: 6, ready: true,
      agent: {endpoint: 'https://audit.test/v1', model: 'test-audit'}}),
    save: async () => {},
    request: async (url, body) => {
      if (!body) return [task];
      posted.push({url, body});
      return task;
    },
  });
  await until(() => node('autoReports').innerHTML.includes('为意见 2 生成整改候选'));
  const cards = node('autoReports').innerHTML.match(/<section class="auto-finding-card"[\s\S]*?<\/section>/g);
  assert.equal(cards.length, 2);
  assert.match(cards[0], /信封与手指穿模/);
  assert.doesNotMatch(cards[0], /提灯交接不连续/);
  assert.match(cards[0], /data-auto-finding-index="0"/);
  assert.match(cards[1], /提灯交接不连续/);
  assert.match(cards[1], /data-auto-finding-index="1"/);
  assert.ok(cards.every(card => card.includes('data-auto-report-id="specific-report"')));
  const button = {dataset: {autoCreateCandidate: 'frame:1', autoFindingIndex: '1', autoReportId: 'specific-report'}};
  node('autoReports').onclick({target: {
    closest(selector) { return selector === '[data-auto-create-candidate]' ? button : null; },
  }});
  await until(() => posted.length === 1);
  assert.equal(posted[0].url, '/api/story-productions/ui-production');
  assert.equal(posted[0].body.key, 'frame:1');
  assert.equal(posted[0].body.findingIndex, 1);
  assert.equal(posted[0].body.reportId, 'specific-report');
});


test('前三镜检查发送高清实际图和两个同画面局部，其余图片保持原送检尺寸', async t => {
  const {createProductionReviewer} = require('./story-production-review.cjs');
  const {run} = require('./video-media.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nightfall-review-detail-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const source = path.join(root, 'actual.png');
  await run(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1600x900',
    '-frames:v', '1', source]);
  const sent = [];
  const reviewer = createProductionReviewer({
    normalizeEndpoint: endpoint => endpoint,
    fetchImpl: async (url, options) => {
      sent.push(JSON.parse(options.body));
      return new Response(JSON.stringify(agentResponse(JSON.stringify({
        verdict:'inspect', summary:'检查手部', findings:[]
      }))));
    }
  });
  for (const index of [0, 1, 2, 3]) {
    await reviewer.check({agent, story:Schema.bloodMoonEnglishSample(6), kind:'frame', index,
      images:[{file:source, label:'实际分镜图'}, {file:source, label:'已确认人物参考'}]});
    const body = sent.at(-1);
    const content = body.input[1].content;
    const images = content.filter(item => item.type === 'input_image');
    assert.equal(images.length, index < 3 ? 4 : 2);
    const sizes = [];
    for (let position = 0; position < images.length; position++) {
      const file = path.join(root, 'sent-' + index + '-' + position + '.jpg');
      const data = images[position].image_url;
      assert.ok(data.startsWith('data:image/jpeg;base64,'));
      await fs.writeFile(file, Buffer.from(data.split(',')[1], 'base64'));
      const info = await run(['-hide_banner', '-i', file, '-frames:v', '1', '-f', 'null', '-']);
      const size = /Video: mjpeg[^\r\n]*? (\d+)x(\d+)[, ]/.exec(info);
      assert.ok(size, '送检 JPEG 必须可以解码并读取尺寸');
      sizes.push(size[1] + 'x' + size[2]);
    }
    assert.deepEqual(sizes, index < 3
      ? ['1280x720', '1280x900', '1280x900', '640x360']
      : ['640x360', '640x360']);
    if (index < 3) {
      assert.notEqual(images[1].image_url, images[2].image_url);
      assert.ok(content.some(item => item.type === 'input_text' && item.text.includes('与整图为同一画面')));
      assert.match(body.input[0].content[0].text, /if anatomy or contact is not readable, choose inspect/);
    }
  }
  await reviewer.check({agent, story:Schema.bloodMoonEnglishSample(12), kind:'frame', index:0,
    images:[{file:source, label:'十二人实际分镜图'}]});
  assert.equal(sent.at(-1).input[1].content.filter(item => item.type === 'input_image').length, 1);
});


test('旧协议检查报告归档可看，切换 Responses 后复核且复用已有图片',async t=>{
  const f=await fixture(t);
  const first=await f.start();await f.wait(first.id,'plan');
  const job=await f.productions.get(first.id);
  job.agentIdentity='legacy-chat-completions';
  job.agentProtocol='chat-completions';
  job.agentMaxOutputTokens=4000;
  const checks=f.checks.length;
  await f.productions.close();
  await atomic(path.join(f.root,'productions',first.id,'job.json'),job);
  await f.restart();
  const current=await f.start();assert.equal(current.id,first.id);
  assert.equal(current.status,'paused');
  await f.productions.action(first.id,{action:'resume',agent});
  await f.wait(first.id,'plan');
  const restored=await f.productions.create({storyId:f.story.id,version:f.story.version,agent});
  assert.equal(restored.agentProtocol,'responses');
  assert.equal(restored.agentMaxOutputTokens,25000);
  assert.equal(restored.reportHistory.length,1);
  assert.equal(restored.reportHistory[0].key,'script');
  assert.equal(restored.reportHistory[0].report.summary,'checked');
  assert.ok(f.checks.length>checks);
  assert.equal(f.imageCalls.length,0);
});


test('Responses 截断后制作停止并显示具体原因和编号，仅手动继续才重试',async t=>{
  const AgentRequest=require('./agent-request.js');let fails=true;
  const f=await fixture(t,{probe:async()=>{
    if(fails)throw new AgentRequest.ResponseError('AGENT_OUTPUT_TRUNCATED','Agent 推理与回答已达到 25000 token 上限，结果不完整，请手动重试。','resp_workshop_limit');
    return {image:true};
  }});
  const first=await f.start();await f.wait(first.id,'plan','blocked');
  const stopped=await f.productions.view(await f.productions.get(first.id));
  assert.equal(stopped.errorCode,'AGENT_OUTPUT_TRUNCATED');
  assert.match(stopped.message,/25000 token/);
  assert.match(stopped.message,/resp_workshop_limit/);
  assert.equal(f.probes,1);assert.equal(f.imageCalls.length,0);
  fails=false;
  await f.productions.action(first.id,{action:'resume',agent});
  await f.wait(first.id,'plan');
  assert.equal(f.probes,2);assert.equal(f.imageCalls.length,0);
});


test('历史任务补齐关键视觉素材只调用整理 Agent 一次且不提交图片请求', async t => {
  let visualCalls = 0;
  const visualAssets = [{
    id: 'banquet-table',
    label: '固定宴会桌与桌面布置',
    kind: 'scene',
    appearance: '深色圆桌，中央烛台、空主位和留言保持固定相对位置。',
    prompt: 'A dark round banquet table with a fixed candelabrum, an empty head seat, and a sealed note in a consistent arrangement, cinematic manor interior, no people.',
    scenes: [0, 1]
  }];
  const f = await fixture(t);
  const created = await f.start();
  await f.wait(created.id, 'plan');
  await f.confirm(created.id, 'plan');
  const characters = await f.wait(created.id, 'characters');
  const legacyFile=path.join(f.root,'productions',created.id,'job.json');
  const legacyJob=JSON.parse(await fs.readFile(legacyFile,'utf8'));
  legacyJob.visualAssets=null;legacyJob.visualAssetsSource=null;await atomic(legacyFile,legacyJob);
  f.settings.reviewer.visualAssets=async()=>{visualCalls++;return visualAssets};
  const imageCount = f.imageCalls.length;
  const updated = await f.productions.action(created.id, {action: 'backfillVisualAssets', agent});
  assert.equal(visualCalls, 1);
  assert.equal(f.imageCalls.length, imageCount);
  assert.equal(updated.status, 'paused');
  assert.equal(updated.stage, 'characters');
  assert.equal(updated.visualAssetsSource.type, 'agent');
  assert.equal(updated.plan.visualAssetsReady, true);
  assert.equal(updated.plan.visualAssets.length, 1);
  const art = await f.art.get(updated.artId);
  assert.equal(art.visualAssets.length, 1);
  assert.equal(art.visualAssets[0].status, 'queued');
  const repeated = await f.productions.action(created.id, {action: 'backfillVisualAssets', agent});
  assert.equal(visualCalls, 1);
  assert.equal(repeated.plan.visualAssets.length, 1);
  assert.equal(f.imageCalls.length, imageCount);
});

test('已有图片任务中的关键视觉素材直接复用，重复补齐不重新调用整理 Agent', async t => {
  let visualCalls = 0;
  const visualAssets = [{
    id: 'lantern',
    label: '古堡提灯',
    kind: 'prop',
    appearance: '铜制提灯，暖色火光，旧但完整。',
    prompt: 'A single aged brass lantern with warm candlelight, stable shape and handle, cinematic gothic manor, no people.',
    scenes: [0]
  }];
  const f = await fixture(t);
  const created = await f.start();
  await f.wait(created.id, 'plan');
  await f.confirm(created.id, 'plan');
  await f.wait(created.id, 'characters');
  const artBefore = await f.art.get((await f.productions.get(created.id)).artId);
  await f.art.action(artBefore.id, {action: 'addVisualAssets', visualAssets, revision: artBefore.revision});
  const productionFile=path.join(f.root,'productions',created.id,'job.json');
  const legacy=JSON.parse(await fs.readFile(productionFile,'utf8'));
  legacy.visualAssets=null;legacy.visualAssetsSource=null;await atomic(productionFile,legacy);
  f.settings.reviewer.visualAssets=async()=>{visualCalls++;return visualAssets};
  const visualCallsBeforeBackfill=visualCalls;
  const imageCount = f.imageCalls.length;
  const updated = await f.productions.action(created.id, {action: 'backfillVisualAssets', agent});
  assert.equal(visualCalls, visualCallsBeforeBackfill);
  assert.equal(f.imageCalls.length, imageCount);
  assert.equal(updated.visualAssetsSource.type, 'existing-art');
  assert.equal(updated.plan.visualAssets[0].label, '古堡提灯');
  const repeated = await f.productions.action(created.id, {action: 'backfillVisualAssets', agent});
  assert.equal(visualCalls, visualCallsBeforeBackfill);
  assert.equal(repeated.plan.visualAssets.length, 1);
});
