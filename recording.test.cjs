'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createServer}=require('./server.cjs');
const {run,inspect}=require('./video-media.cjs');
const {recordingLatestPlayback,recordingStatusForJobs}=require('./recording.js');

async function setup(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-recording-'));
  const server=createServer({recoverVideoJobs:false,recordingOptions:{root,...options}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true})});
  async function request(url,method='GET',body){
    const headers={Origin:base};
    if(body!==undefined&&!(body instanceof Buffer)){headers['Content-Type']='application/json';body=JSON.stringify(body)}
    const response=await fetch(base+url,{method,headers,body});
    return {response,data:await response.json()};
  }
  async function wait(id,status){
    for(let i=0;i<300;i++){const {data}=await request('/api/recordings/'+id);if(data.status===status)return data;await new Promise(r=>setTimeout(r,50))}
    throw Error('录像未到达状态 '+status);
  }
  return {root,server,request,wait,base};
}

test('录制片段按顺序写入，重复上传去重，合成失败后保留原始录像并可重试',async t=>{
  let attempts=0;
  const {request,wait,root,base}=await setup(t,{transcode:async(source,target)=>{
    attempts++;if(attempts===1)throw Error('测试合成失败');
    await fs.copyFile(source,target);
  }});
  const {data:job}=await request('/api/recordings','POST',{roomSize:6});
  const prefix='/api/recordings/'+job.id;
  assert.equal((await request(prefix+'/chunks/1','PUT',Buffer.from('b'))).response.status,409);
  await request(prefix+'/chunks/0','PUT',Buffer.from('a'));
  await request(prefix+'/chunks/0','PUT',Buffer.from('different'));
  await request(prefix+'/chunks/1','PUT',Buffer.from('b'));
  await request(prefix+'/finish','POST',{complete:true,expected:2});
  const failed=await wait(job.id,'failed');
  assert.equal(failed.complete,true);
  assert.equal(await (await fetch(base+failed.rawUrl)).text(),'ab');
  await request(prefix+'/retry','POST',{});
  const ready=await wait(job.id,'ready');
  assert.equal(await fs.readFile(path.join(root,ready.filename),'utf8'),'ab');
  assert.equal((await fetch(base+prefix+'/media/webm')).status,404);
  assert.equal((await fetch(base+prefix+'/media/mp4',{headers:{Origin:'http://example.com'}})).status,403);
});

test('剪辑稿条目按稳定编号合并并导出 JSON、TXT、SRT、VTT',async t=>{
  const {request,root,server,base}=await setup(t);
  const {data:job}=await request('/api/recordings','POST',{roomSize:6});
  const prefix='/api/recordings/'+job.id;
  const first=[
    {id:'speech-1',kind:'dialogue',seat:0,name:'薇拉',round:1,phase:'discussion',text:'第一句发言',startedMs:100,endedMs:240,speechStatus:'played',attempts:1},
    {id:'commentary-1',kind:'commentary',text:'旁白说明',startedMs:300,endedMs:520,speechStatus:'fallback-reading',attempts:1}
  ];
  let result=await request(prefix+'/transcript','PUT',{entries:first});
  assert.equal(result.response.status,200);assert.equal(result.data.transcriptCount,2);
  const long='长'.repeat(1401);
  result=await request(prefix+'/transcript','PUT',{entries:[
    {...first[0],text:'修订后的发言',endedMs:260},
    {id:'speech-2',kind:'dialogue',seat:1,name:'莱恩',text:long,startedMs:600,endedMs:900,speechStatus:'played'}
  ]});
  assert.equal(result.data.transcriptCount,3);
  const json=(await request(prefix+'/transcript')).data;
  assert.equal(json.entries.length,3);assert.equal(json.entries.find(entry=>entry.id==='speech-1').text,'修订后的发言');
  assert.equal(json.entries.find(entry=>entry.id==='speech-2').text.length,1400);
  await request(prefix+'/chunks/0','PUT',Buffer.from('fixture'));
  const list=(await request('/api/recordings')).data.recordings.find(entry=>entry.id===job.id);
  assert.equal(list.transcriptCount,3);assert.match(list.transcriptUrl,/transcript\/json$/);
  for(const [format,needle] of [['txt','修订后的发言'],['srt','00:00:00,100 --> 00:00:00,260'],['vtt','WEBVTT']]){
    const response=await fetch(base+prefix+'/transcript/'+format,{headers:{Origin:base}});const body=await response.text();
    assert.equal(response.status,200);assert.ok(body.includes(needle),format+' export mismatch');
  }
  await new Promise(resolve=>server.close(resolve));
  const recovered=createServer({recoverVideoJobs:false,recordingOptions:{root}});
  await new Promise(resolve=>recovered.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>recovered.close(resolve)));
  const recoveredBase='http://127.0.0.1:'+recovered.address().port;
  const recoveredResponse=await fetch(recoveredBase+prefix,{headers:{Origin:recoveredBase}});const recoveredJob=await recoveredResponse.json();
  assert.equal(recoveredJob.transcriptCount,3);
  // 等待恢复任务写入最终状态后再清理目录，避免后台合成与测试清理并发。
  let recoveredState = recoveredJob;
  for(let attempt=0;attempt<100 && recoveredState.status==='saving';attempt++){
    await new Promise(resolve=>setTimeout(resolve,20));
    recoveredState=await (await fetch(recoveredBase+prefix,{headers:{Origin:recoveredBase}})).json();
  }
  assert.notEqual(recoveredState.status,'saving');
  await new Promise(resolve=>recovered.close(resolve));
});

test('服务恢复后保存未完局片段，真实转码输出竖屏且保留音轨',async t=>{
  const {request,wait,root,server}=await setup(t);
  const input=path.join(root,'sample.webm');
  await run(['-hide_banner','-y','-f','lavfi','-i','color=c=black:s=320x320:r=10','-f','lavfi','-i','sine=frequency=440','-t','1','-vf','drawbox=x=70:y=0:w=180:h=320:color=red:t=fill','-c:v','libvpx','-c:a','libopus',input],30000);
  const {data:job}=await request('/api/recordings','POST',{roomSize:12,story:true});
  await request('/api/recordings/'+job.id+'/chunks/0','PUT',await fs.readFile(input));
  await new Promise(resolve=>server.close(resolve));
  const recovered=createServer({recoverVideoJobs:false,recordingOptions:{root}});
  await new Promise(resolve=>recovered.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>recovered.close(resolve)));
  const address=`http://127.0.0.1:${recovered.address().port}`;
  let data;
  for(let i=0;i<300;i++){data=await (await fetch(address+'/api/recordings/'+job.id)).json();if(data.status==='ready')break;await new Promise(r=>setTimeout(r,100))}
  assert.equal(data.status,'ready');assert.equal(data.complete,false);
  const details=await run(['-hide_banner','-i',path.join(root,data.filename),'-t','0.05','-f','null','-'],30000);
  assert.match(details,/1080x1920/);assert.match(details,/Audio:/);
  // Keep the square source intact within the portrait output, including its black sides.
  for (const [x, y, expectedBlack] of [[0, 960, 100], [250, 960, 0], [1070, 960, 100], [540, 10, 0]]) {
    const pixels = await run(['-hide_banner', '-i', path.join(root, data.filename), '-vf',
      'crop=10:10:' + x + ':' + y + ',blackframe=amount=0:threshold=32',
      '-frames:v', '1', '-f', 'null', '-'], 30000);
    assert.equal(Number(/pblack:(\d+)/.exec(pixels)?.[1]), expectedBlack, 'unexpected pixel region at ' + x + ',' + y);
  }
  assert.ok((await inspect(path.join(root,data.filename))).duration>0);
});


test('最新录像回放入口只指向最新且已完成合成的 MP4',()=>{
  const old={id:'old',createdAt:'2026-11-19T10:00:00.000Z',status:'ready',url:'/old.mp4'};
  const saving={id:'new',createdAt:'2026-11-20T10:00:00.000Z',status:'saving',url:null};
  assert.equal(recordingLatestPlayback([old,saving]),null);
  assert.equal(recordingLatestPlayback([{...saving,status:'failed',url:null},old]),null);
  const ready={...saving,status:'ready',url:'/new.mp4'};
  assert.equal(recordingLatestPlayback([old,ready]),ready);
});


test('录像任务状态会同步到顶部状态栏',()=>{
  const base={id:'latest',createdAt:'2026-11-20T10:00:00.000Z',chunks:12};
  assert.equal(recordingStatusForJobs([]),'录屏准备就绪 · 查看本地录像');
  assert.equal(recordingStatusForJobs([{...base,status:'saving'}]),'录像合成中 · 已收到 12 个片段，完成后可打开回放。');
  assert.equal(recordingStatusForJobs([{...base,status:'ready',complete:true}]),'录像已保存 · 可打开最新回放。');
  assert.equal(recordingStatusForJobs([{...base,status:'ready',complete:false}]),'未完局录像已保存 · 可打开最新回放。');
  assert.equal(recordingStatusForJobs([{...base,status:'failed',reason:'MP4 合成失败，已保留原始 WebM。'}]),'录像合成失败 · MP4 合成失败，已保留原始 WebM。');
});


test('录制画布采用完整元素像素，回退区域按边界裁定且不会误用全标签页',()=>{
  const surface=require('./recording-surface.js');
  assert.equal(surface.width,1080);assert.equal(surface.height,1920);
  const bounds={x:120,y:40,width:360,height:640};
  assert.deepEqual(surface.region(720,1280,bounds,{width:720,height:1280},true),{x:0,y:0,width:720,height:1280});
  assert.deepEqual(surface.region(720,1280,bounds,{width:720,height:1280},false),bounds);
  assert.deepEqual(surface.region(100,100,{x:90,y:95,width:30,height:20},{width:100,height:100},false),{x:90,y:95,width:10,height:5});
});

test('录屏元数据保存有效区域和版本，非法边界拒绝创建',async t=>{
  let converted;
  const f=await setup(t,{transcode:async(source,target,job)=>{converted=job;await fs.copyFile(source,target);}});
  const capture={version:'portrait-1080-v2',width:1080,height:1920,mode:'region',sourceWidth:540,sourceHeight:960,region:{x:0,y:0,width:540,height:960}};
  const {data:job,response}=await f.request('/api/recordings','POST',{roomSize:12,capture});
  assert.equal(response.status,201);assert.deepEqual(job.capture,capture);
  await f.request('/api/recordings/'+job.id+'/chunks/0','PUT',Buffer.from('fixture'));
  await f.request('/api/recordings/'+job.id+'/finish','POST',{complete:true,expected:1});
  await f.wait(job.id,'ready');assert.deepEqual(converted.capture,capture);
  assert.equal((await f.request('/api/recordings','POST',{roomSize:6,capture:{...capture,region:{...capture.region,x:200}}})).response.status,400);
});


test('录屏启动校验完整取景框，拒绝截断比例并容纳像素取整',()=>{
  const surface=require('./recording-surface.js');
  const rect={width:423.5625,height:753};
  assert.equal(surface.matchesFrame(608,1080,rect),true);
  assert.equal(surface.matchesFrame(642,1080,rect),false);
  assert.equal(surface.matchesFrame(0,0,rect),false);
});
