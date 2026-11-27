'use strict';
function agentResponse(text){return {status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]}]};}
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const S=require('./scenario.js'),{createScenarioStore}=require('./scenario-store.cjs'),{createScenarioReviews}=require('./scenario-review.cjs');
const {createServer}=require('./server.cjs'),{once}=require('node:events');

test('审阅只向指定 Agent 发送剧本，秘密不进入报告，确认绑定版本',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-review-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=createScenarioStore(root),story=S.bloodMoonSample(6);story.confirmed=true;const saved=await store.save(story),sent=[];
  const reviews=createScenarioReviews({root:path.join(root,'reviews'),store,validateChat:()=>{},normalizeEndpoint:x=>x,readUpstream:async r=>r.json(),upstreamError:(status)=>Error('upstream '+status),fetchImpl:async(url,options)=>{sent.push({url,body:JSON.parse(options.body),authorization:options.headers.Authorization});return Response.json(agentResponse(JSON.stringify({summary:'整体连贯',strengths:[],findings:[{severity:'important',category:'隐私',location:'镜头 1',issue:story.characters[0].secret,suggestion:'检查公开字段'}]})))}});
  const result=await reviews.review({storyId:saved.id,version:saved.version,endpoint:'https://chosen-agent.test/chat',model:'organizer-model',apiKey:'one-time-key'},new AbortController().signal);
  assert.equal(sent.length,1);assert.equal(sent[0].body.reasoning.effort,'high');assert.equal(sent[0].body.temperature,undefined);assert.equal(sent[0].body.max_output_tokens,25000);assert.equal(sent[0].url,'https://chosen-agent.test/chat');assert.equal(sent[0].authorization,'Bearer one-time-key');assert.ok(JSON.stringify(sent[0].body).includes(story.characters[0].secret));assert.equal(JSON.stringify(result).includes(story.characters[0].secret),false);
  assert.equal(result.protocol,'responses');assert.equal(result.maxOutputTokens,25000);assert.equal(result.reasoningEffort,'high');
  await assert.rejects(()=>reviews.requireApproved(saved.id,saved.version),{code:'STORY_REVIEW_REQUIRED'});
  const accepted=await reviews.confirm({id:result.id,storyId:saved.id,version:saved.version});assert.equal(accepted.decision,'accepted');assert.equal(await reviews.requireApproved(saved.id,saved.version),true);
  const files=await fs.readdir(path.join(root,'reviews'));const persisted=await fs.readFile(path.join(root,'reviews',files[0]),'utf8');assert.equal(persisted.includes('one-time-key'),false);
  const revised=await store.save({...story,id:saved.id,version:saved.version,background:story.background+' revised'});assert.ok(revised.version>saved.version);await assert.rejects(()=>reviews.requireApproved(revised.id,revised.version),{code:'STORY_REVIEW_REQUIRED'});
});

test('AI按核对建议生成合法未保存修订稿，保留原稿、角色配置并阻止秘密泄漏',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-review-revise-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=createScenarioStore(root),story=S.bloodMoonSample(6);story.confirmed=true;const saved=await store.save(story),sent=[];
  const reviews=createScenarioReviews({root:path.join(root,'reviews'),store,validateChat:()=>{},normalizeEndpoint:x=>x,readUpstream:async r=>r.json(),upstreamError:(status)=>Error('upstream '+status),fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);sent.push({body,authorization:options.headers.Authorization});
    if(sent.length===1)return Response.json(agentResponse(JSON.stringify({summary:'因果可以加强',strengths:[],findings:[{severity:'important',category:'因果',location:'镜头 2',issue:'人物抵达宴厅的动机不够清楚',suggestion:'补充邀请与赴约目的的关联'}]})));
    const input=JSON.parse(body.input[1].content[0].text).currentStory;
    input.background+=' 六位来客依照邀请赴宴。';input.scenes[0].description+=' 镜头保持同一古堡空间。';
    return Response.json(agentResponse(JSON.stringify(input)));
  }});
  const report=await reviews.review({storyId:saved.id,version:saved.version,endpoint:'https://chosen-agent.test/chat',model:'organizer-model',apiKey:'one-time-key'},new AbortController().signal);
  const revised=await reviews.revise({id:report.id,storyId:saved.id,version:saved.version,endpoint:'https://chosen-agent.test/chat',model:'organizer-model',apiKey:'one-time-key'},new AbortController().signal);
  assert.equal(sent.length,2);assert.equal(sent[1].body.reasoning.effort,'high');assert.equal(sent[1].body.temperature,undefined);assert.equal(sent[1].body.max_output_tokens,25000);assert.equal(sent[1].authorization,'Bearer one-time-key');assert.ok(JSON.stringify(sent[1].body.input).includes(report.findings[0].suggestion));
  assert.equal(revised.draft.confirmed,false);assert.equal(revised.draft.id,undefined);assert.equal(revised.draft.characters[0].secret,saved.characters[0].secret);
  assert.equal(revised.draft.characters[0].name,saved.characters[0].name);assert.equal(revised.draft.characters[0].voiceId,saved.characters[0].voiceId);assert.equal(revised.draft.scenes[0].description.endsWith('镜头保持同一古堡空间。'),true);
  assert.equal(await store.get(saved.id,saved.version).then(x=>x.background),saved.background);
  const files=await fs.readdir(path.join(root,'reviews'));const persisted=await fs.readFile(path.join(root,'reviews',files[0]),'utf8');assert.equal(persisted.includes('one-time-key'),false);
});

test('AI修订违反影视剧本规则或泄露秘密时拒绝应用并保留原剧本',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-review-revise-invalid-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=createScenarioStore(root),story=S.bloodMoonSample(6);story.confirmed=true;const saved=await store.save(story);let candidate;
  const reviews=createScenarioReviews({root:path.join(root,'reviews'),store,validateChat:()=>{},normalizeEndpoint:x=>x,readUpstream:async r=>r.json(),upstreamError:()=>Error('unused'),fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);if(!candidate)return Response.json(agentResponse(JSON.stringify({summary:'需修改',strengths:[],findings:[{issue:'检查公开文本',suggestion:'避免泄密'}]})));return Response.json(agentResponse(JSON.stringify(candidate)))}});
  const report=await reviews.review({storyId:saved.id,version:saved.version,endpoint:'https://agent.test',model:'m'},new AbortController().signal);
  candidate={...saved,background:saved.characters[0].secret};
  await assert.rejects(()=>reviews.revise({id:report.id,storyId:saved.id,version:saved.version,endpoint:'https://agent.test',model:'m'},new AbortController().signal),{code:'STORY_REVISION_INVALID'});
  assert.equal((await store.get(saved.id,saved.version)).background,saved.background);
});

test('AI 建议不能自动放行，失败时手动跳过有独立记录',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-review-skip-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=createScenarioStore(root),story=S.bloodMoonSample(12);story.confirmed=true;const saved=await store.save(story);
  const reviews=createScenarioReviews({root:path.join(root,'reviews'),store,validateChat:()=>{},normalizeEndpoint:x=>x,readUpstream:async r=>r.json(),upstreamError:()=>Error('upstream down'),fetchImpl:async()=>Response.json(agentResponse(JSON.stringify({summary:'建议复核',strengths:[],findings:[{severity:'suggestion',category:'节奏',location:'镜头 3',issue:'转场稍快',suggestion:'加长动作'}]})))});
  const report=await reviews.review({storyId:saved.id,version:saved.version,endpoint:'https://agent.test',model:'m',apiKey:'k'},new AbortController().signal);await assert.rejects(()=>reviews.requireApproved(saved.id,saved.version),{code:'STORY_REVIEW_REQUIRED'});
  assert.equal((await reviews.confirm({id:report.id,storyId:saved.id,version:saved.version})).decision,'accepted');assert.equal(await reviews.requireApproved(saved.id,saved.version),true);
  const saved2=await store.save({...story,id:undefined,version:undefined,title:'另一个故事'});const skipped=await reviews.skip({storyId:saved2.id,version:saved2.version});assert.equal(skipped.decision,'skipped');assert.equal(await reviews.requireApproved(saved2.id,saved2.version),true);
});

test('HTTP 审阅可选，未核对时图片、素材复用与视频制作可继续',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-review-http-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=createScenarioStore(path.join(root,'scenarios')),story=S.bloodMoonSample(12);story.confirmed=true;const saved=await store.save(story);let artCalls=0,videoCalls=0;
  const artJobs={root:path.join(root,'art'),list:async()=>[],get:async()=>{throw Error('unused')},summary:x=>x,mediaFile:async()=>'',create:async()=>{artCalls++;return {id:'art'}},importAssets:async()=>{artCalls++;return {id:'import'}},close:async()=>{}};
  const jobs={root:path.join(root,'videos'),list:async()=>[],get:async()=>{throw Error('unused')},summary:x=>x,mediaFile:async()=>'',create:async()=>{videoCalls++;return {id:'video'}},close:async()=>{}};
  const server=createServer({storyStore:store,artJobs,videoJobs:jobs,recoverVideoJobs:false});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));const base='http://127.0.0.1:'+server.address().port;
  const get=await fetch(base+'/api/scenario-reviews?storyId='+saved.id+'&version=1');assert.equal(get.status,200);assert.deepEqual(await get.json(),[]);
  const retired=await fetch(base+'/api/story-preview-jobs',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({storyId:saved.id,version:1})});assert.equal(retired.status,410);assert.equal((await retired.json()).error.code,'STORY_PREVIEW_RETIRED');
  for(const [pathName,body]of [['/api/story-art-jobs',{storyId:saved.id,version:1,confirmCharge:true}],['/api/story-art-import',{storyId:saved.id,version:1}],['/api/video-jobs',{storyId:saved.id,version:1,profile:'cinema-refs-v1',confirmCharge:true}]]){const response=await fetch(base+pathName,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,JSON.stringify(await response.json()))}
  assert.equal(artCalls,2);assert.equal(videoCalls,1);
});

test('HTTP 修订路由使用已确认报告返回草稿且不保存到剧本库',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-review-revise-http-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=createScenarioStore(path.join(root,'scenarios')),story=S.bloodMoonSample(6);story.confirmed=true;const saved=await store.save(story);let calls=0;
  const fetchImpl=async(url,options)=>{
    calls++;const body=JSON.parse(options.body);
    if(calls===1)return Response.json(agentResponse(JSON.stringify({summary:'因果建议',strengths:[],findings:[{issue:'动机略弱',suggestion:'补充赴宴目的'}]})));
    const draft=JSON.parse(body.input[1].content[0].text).currentStory;draft.background+=' 人物依据邀请再次相聚。';return Response.json(agentResponse(JSON.stringify(draft)));
  };
  const server=createServer({fetchImpl,storyStore:store,recoverVideoJobs:false});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));const base='http://127.0.0.1:'+server.address().port,headers={Origin:base,'Content-Type':'application/json'};
  const request={storyId:saved.id,version:saved.version,endpoint:'https://organizer.test/v1/chat/completions',model:'organizer',apiKey:'temporary'};
  const reviewResponse=await fetch(base+'/api/scenario-reviews',{method:'POST',headers,body:JSON.stringify(request)});assert.equal(reviewResponse.status,200);const report=await reviewResponse.json();
  const reviseResponse=await fetch(base+'/api/scenario-reviews/'+report.id+'/revise',{method:'POST',headers,body:JSON.stringify(request)});const reviseData=await reviseResponse.json();assert.equal(reviseResponse.status,200,JSON.stringify(reviseData));const revised=reviseData;
  assert.equal(revised.draft.confirmed,false);assert.ok(revised.draft.background.includes('依据邀请再次相聚'));assert.equal((await store.get(saved.id,saved.version)).background,saved.background);
});
