const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {createServer}=require('./server.cjs');
const {speechAudio,normalizeSpeechEndpoint}=require('./voice.cjs');
const V=require('./voices.js');
const audio=Buffer.concat([Buffer.from('ID3'),Buffer.alloc(512)]);
const body={provider:'neural',text:'为什么你上一轮没有说？',voice:V.voices[0].id,style:'suspicious',speed:1};
async function fixture(t,options={}){
  const server=createServer({...options,recoverVideoJobs:false});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  const base=`http://127.0.0.1:${server.address().port}`;
  return {base,post:(data=body,extra={})=>fetch(base+'/api/speech',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...extra.headers},body:JSON.stringify(data),...extra})};
}
function bounded(p){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Cancellation not received')),1500)})]).finally(()=>clearTimeout(timer))}
test('12 个独立默认音色、情绪从公开台词判定，固定风格优先',()=>{
  assert.equal(new Set(Array.from({length:12},(_,i)=>V.defaults(i).voice)).size,12);
  for(const [text,style] of [['我不是狼，别投我','anxious'],['谢谢，哈哈','cheerful'],['为什么？','suspicious'],['可惜了','sad'],['我坚持这个判断','firm'],['看看票型','calm']])assert.equal(V.emotion(text,'auto'),style);
  assert.equal(V.emotion('为什么？','calm'),'calm');
  assert.notDeepEqual(V.prosody('sad'),V.prosody('cheerful'));
});
test('语音地址独立补全、禁止聊天路径和不安全地址',()=>{
  for(const suffix of ['','/','/v1/'])assert.equal(normalizeSpeechEndpoint('https://example.test'+suffix),'https://example.test/v1/audio/speech');
  assert.equal(normalizeSpeechEndpoint('https://example.test/custom/speech'),'https://example.test/custom/speech');
  for(const endpoint of ['http://example.test','https://user:key@example.test','https://example.test/v1/chat/completions','file:///test'])assert.throws(()=>normalizeSpeechEndpoint(endpoint));
});
test('自然语音 HTTP 返回 MP3、不缓存、生成参数不含聊天身份或密钥',async t=>{
  let seen;const {post}=await fixture(t,{synthesizeImpl:async (data)=>{seen=data;return audio}});
  const response=await post();assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/mpeg');assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),audio);assert.deepEqual(seen,body);
});
test('自然语音临时网络错误有限重试，恢复后返回音频',async()=>{
  let calls=0;
  const result=await speechAudio(body,{synthesizeImpl:async()=>{
    calls++;
    if(calls<3){const error=new Error('temporary network failure');error.code='VOICE_NETWORK_ERROR';throw error}
    return audio;
  }});
  assert.deepEqual(result,audio);assert.equal(calls,3);
});
test('自然语音安装或配置错误不重试',async()=>{
  let calls=0;const error=new Error('voice dependency missing');error.code='VOICE_NOT_READY';
  await assert.rejects(speechAudio(body,{synthesizeImpl:async()=>{calls++;throw error}}),e=>e.code==='VOICE_NOT_READY');
  assert.equal(calls,1);
});
test('自然语音重试等待期间取消会立即停止',async()=>{
  let calls=0;const controller=new AbortController();
  const pending=speechAudio(body,{signal:controller.signal,synthesizeImpl:async()=>{
    calls++;const error=new Error('temporary network failure');error.code='VOICE_NETWORK_ERROR';throw error;
  }});
  setTimeout(()=>controller.abort(),30);
  await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,1);
});
test('情绪语音接口接收独立音色、模型、语速和语气指令，不把密钥写进正文',async()=>{
  let request,url;const key='voice-key-only';
  assert.deepEqual(await speechAudio({...body,provider:'api',endpoint:'https://example.test',model:'voice-model',voice:'coral',apiKey:key},{fetchImpl:async(u,r)=>{url=u;request=r;return new Response(audio,{headers:{'Content-Type':'audio/mpeg'}})}}),audio);
  const data=JSON.parse(request.body);assert.equal(url,'https://example.test/v1/audio/speech');assert.equal(request.headers.Authorization,'Bearer '+key);
  assert.equal(data.voice,'coral');assert.equal(data.model,'voice-model');assert.equal(data.input,body.text);assert.match(data.instructions,/审慎追问/);assert.equal(request.body.includes(key),false);
});
test('自定义 API 前两次失败后第三次成功，复用同一文本和音色',async()=>{
  const config={...body,provider:'api',endpoint:'https://example.test',model:'voice-model',voice:'coral',apiKey:'secret-voice-key'};
  let calls=0;const inputs=[];
  const result=await speechAudio(config,{fetchImpl:async(u,r)=>{calls++;inputs.push(JSON.parse(r.body));if(calls<3)return new Response('temporary',{status:503});return new Response(audio,{headers:{'Content-Type':'audio/mpeg'}})}});
  assert.deepEqual(result,audio);assert.equal(calls,3);assert.deepEqual(inputs.map(x=>[x.input,x.voice,x.model]),[['为什么你上一轮没有说？','coral','voice-model'],['为什么你上一轮没有说？','coral','voice-model'],['为什么你上一轮没有说？','coral','voice-model']]);
});
test('自定义 API 三次失败后保留尝试次数，确定性配置错误只请求一次',async()=>{
  const config={...body,provider:'api',endpoint:'https://example.test',model:'voice-model',voice:'coral',apiKey:'secret-voice-key'};
  let calls=0;await assert.rejects(speechAudio(config,{fetchImpl:async()=>{calls++;return new Response('temporary',{status:503})}}),e=>e.code==='SPEECH_UPSTREAM_ERROR'&&e.attempts===3);assert.equal(calls,3);
  calls=0;await assert.rejects(speechAudio(config,{fetchImpl:async()=>{calls++;return new Response('denied',{status:401})}}),e=>e.code==='SPEECH_UPSTREAM_ERROR'&&e.attempts===1);assert.equal(calls,1);
});
test('无效 MP3 在三次尝试内重试，最终失败带有尝试次数',async()=>{
  const config={...body,provider:'api',endpoint:'https://example.test',model:'voice-model',voice:'coral',apiKey:'secret-voice-key'};
  let calls=0;await assert.rejects(speechAudio(config,{fetchImpl:async()=>{calls++;return new Response(Buffer.alloc(512),{headers:{'Content-Type':'audio/mpeg'}})}}),e=>e.code==='INVALID_AUDIO'&&e.attempts===3);assert.equal(calls,3);
});
test('供应商异常、假音频及超大音频均安全拒绝，不回显密钥',async()=>{
  const config={...body,provider:'api',endpoint:'https://example.test',model:'voice-model',voice:'coral',apiKey:'secret-voice-key'};
  for(const status of [401,403,404,429,500])await assert.rejects(speechAudio(config,{fetchImpl:async()=>new Response('secret-voice-key',{status})}),e=>!e.message.includes(config.apiKey));
  for(const response of [new Response('{}',{headers:{'Content-Type':'application/json'}}),new Response(Buffer.alloc(512),{headers:{'Content-Type':'audio/mpeg'}}),new Response(new Uint8Array(8*1024*1024+1),{headers:{'Content-Type':'audio/mpeg'}})])await assert.rejects(speechAudio(config,{fetchImpl:async()=>response}),/音频|语音文件/);
});
test('语音来源、格式、大小、文本、音色与风格校验；后台源码不可访问',async t=>{
  const {post,base}=await fixture(t,{synthesizeImpl:async()=>audio});
  assert.equal((await fetch(base+'/api/speech')).status,405);
  for(const data of [{...body,voice:'unknown'},{...body,style:'auto'},{...body,speed:9},{...body,text:''},{...body,text:'长'.repeat(1401)},{...body,provider:'api',endpoint:'https://example.test',model:'m',voice:'coral',apiKey:'key\nInjected'}])assert.equal((await post(data)).status,400);
  assert.equal((await post({...body,text:'长'.repeat(1400)})).status,200);
  let attempts=0;const retryFixture=await fixture(t,{fetchImpl:async()=>{attempts++;return new Response('temporary',{status:503})}});
  const failed=await retryFixture.post({...body,provider:'api',endpoint:'https://example.test',model:'voice-model',voice:'coral',apiKey:'voice-key'});
  assert.equal(failed.status,503);assert.deepEqual((await failed.json()).error.attempts,3);assert.equal(attempts,3);
  assert.equal((await post(body,{headers:{Origin:'https://other.test','Content-Type':'application/json'}})).status,403);
  assert.equal((await post(body,{headers:{Origin:base,'Content-Type':'text/plain'}})).status,415);
  assert.equal((await post({...body,text:'长'.repeat(33000)})).status,413);
  for(const file of ['voice.cjs','scripts/synthesize-speech.py','setup-voice.cmd','.voice-venv/Scripts/python.exe'])assert.equal((await fetch(base+'/'+file)).status,404);
  assert.equal((await fetch(base+'/voices.js')).status,200);
});
test('生成超时中止后台任务；浏览器取消停止生成',async t=>{
  let wasAborted=false;
  const {post}=await fixture(t,{speechTimeoutMs:20,synthesizeImpl:(data,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{wasAborted=true;reject(Error('aborted'))},{once:true}))});
  const response=await post();assert.equal(response.status,504);assert.equal(wasAborted,true);assert.equal((await response.json()).error.code,'VOICE_TIMEOUT');
  let started,aborted;const begin=new Promise(r=>started=r),end=new Promise(r=>aborted=r);
  const next=await fixture(t,{synthesizeImpl:(data,{signal})=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>{aborted();reject(Error('aborted'))},{once:true})})});
  const controller=new AbortController(),pending=next.post(body,{signal:controller.signal});const result=assert.rejects(pending,{name:'AbortError'});
  await bounded(begin);controller.abort();await result;await bounded(end);
});
test('同时生成有上限，避免重复试听占满后台',async t=>{
  const waiting=[];const {post}=await fixture(t,{synthesizeImpl:()=>new Promise(r=>waiting.push(r))});
  const a=post(),b=post();while(waiting.length<2)await new Promise(setImmediate);
  assert.equal((await post()).status,429);waiting.forEach(r=>r(audio));assert.equal((await a).status,200);assert.equal((await b).status,200);
});
