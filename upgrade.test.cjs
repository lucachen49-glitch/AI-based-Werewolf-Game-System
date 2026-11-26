'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const S=require('./scenario.js'),W=require('./workshop-state.js'),D=require('./scenario-dedup.cjs'),{createScenarioStore,atomic}=require('./scenario-store.cjs');
const {run}=require('./video-media.cjs');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-upgrade-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=createScenarioStore(path.join(dir,'active'));return {dir,store}}
async function record(store,size,updatedAt,title='血月停战宴'){const s=await store.save({...S.bloodMoonSample(size),title});s.updatedAt=updatedAt;await atomic(path.join(store.root,s.id+'.json'),s);return s}
async function job(store,type,data){const id=data.id||randomUUID();await atomic(path.join(store.root,type,id,'job.json'),{id,...data});return id}

test('去重按人数与去空格名称，优先可解码的已采用成片并映射旧选择',async t=>{
 const {dir,store}=await fixture(t),old=await record(store,6,'2026-11-10'),latest=await record(store,6,'2026-11-14'),twelve=await record(store,12,'2026-11-15');
 const id=await job(store,'videos',{storyId:old.id,version:1,status:'accepted'}),movie=path.join(store.root,'videos',id,'intro.mp4');
 await run(['-v','error','-y','-f','lavfi','-i','color=s=32x32:r=10','-t','0.3','-c:v','libx264','-pix_fmt','yuv420p',movie]);await store.bindVideo(old.id,1,id);
 // Binding changes no ordering; even an older accepted film must win over a newer text draft.
 const rows=await store.list();assert.equal(rows.length,2);assert.equal(rows.find(s=>s.roomSize===6).id,old.id);assert.equal(await store.canonicalId(latest.id),old.id);assert.equal(rows.find(s=>s.roomSize===12).id,twelve.id);
 const broken=await job(store,'videos',{storyId:latest.id,version:1,status:'accepted'});await fs.writeFile(path.join(store.root,'videos',broken,'intro.mp4'),Buffer.from('0000ftyp broken file'));
 await store.bindVideo(latest.id,1,broken);assert.equal(await D.validVideo(store.root,await store.get(latest.id)),false);assert.equal((await store.list()).find(s=>s.roomSize===6).id,old.id);
 assert.equal(D.key({...old,title:' 血月停战宴 '}),D.key(old));
});

test('清理先备份，保护共享/历史引用及未知任务，归档可恢复且不接触凭据',async t=>{
 const {dir,store}=await fixture(t),old=await record(store,6,'2026-11-10'),keep=await record(store,6,'2026-11-15');
 const shared=await job(store,'art',{storyId:old.id,status:'review'}),unknown=await job(store,'art',{storyId:old.id,status:'needs_review',characters:[{status:'unknown'}]}),exclusive=await job(store,'videos',{storyId:old.id,status:'ready'}),history=await job(store,'videos',{storyId:old.id,status:'accepted',artId:shared});
 await atomic(path.join(store.root,'versions',keep.id,'1.json'),{...keep,video:{jobId:history}});
 await fs.writeFile(path.join(store.root,'provider-secret.json'),'do-not-archive');
 const archive=path.join(dir,'archive'),m=await D.archiveDuplicates(store,archive);assert.equal(m.status,'complete');assert.equal((await store.all()).length,1);assert.equal(await store.canonicalId(old.id),keep.id);
 assert.equal((await store.get(old.id,1)).id,old.id);assert.equal((await store.get(old.id)).id,old.id);
 for(const [type,id]of [['art',shared],['art',unknown],['videos',history]])await fs.access(path.join(store.root,type,id,'job.json'));
 await assert.rejects(fs.access(path.join(store.root,'videos',exclusive)));await fs.access(path.join(archive,'backup','videos',exclusive,'job.json'));await fs.access(path.join(archive,'removed',old.id+'.json'));
 assert.ok(!m.moves.some(p=>p.includes('provider')));await assert.rejects(fs.access(path.join(archive,'backup','provider-secret.json')));
 const after=await record(store,6,'2026-11-16');assert.equal((await store.list()).length,1);assert.equal(await store.canonicalId(keep.id),after.id);assert.equal(await store.canonicalId(old.id),after.id);
 await D.restoreArchive(store,archive);assert.equal((await store.all()).length,3);await fs.access(path.join(store.root,'videos',exclusive,'job.json'));assert.equal((await store.index()).aliases[old.id],undefined);await fs.access(path.join(archive,'backup',old.id+'.json'));
});

test('不可读任务在清理前中止，恢复冲突不覆盖活动数据',async t=>{
 const {dir,store}=await fixture(t),a=await record(store,6,'2026-11-10');await record(store,6,'2026-11-15');const id=randomUUID(),task=path.join(store.root,'art',id);await fs.mkdir(task,{recursive:true});await fs.writeFile(path.join(task,'job.json'),'broken');
 await assert.rejects(D.archiveDuplicates(store,path.join(dir,'bad')));assert.equal((await store.all()).length,2);await fs.rm(task,{recursive:true});
 const archive=path.join(dir,'good');await D.archiveDuplicates(store,archive);await atomic(path.join(store.root,a.id+'.json'),a);await assert.rejects(D.restoreArchive(store,archive),/活动数据已存在/);
});

test('12 人独立剧本、分组镜头、旧数据默认与每席秘密隔离',()=>{
 const six=S.bloodMoonSample(),s=S.bloodMoonSample(12);assert.equal(s.characters.length,12);assert.equal(s.confirmed,false);assert.equal(s.scenes.length,12);assert.equal(S.videoPlan(s).targetDuration,s.scenes.reduce((sum,scene)=>sum+scene.duration,0));assert.equal(new Set(s.characters.map(c=>c.name)).size,12);
 assert.deepEqual(s.characters.slice(0,6),six.characters);assert.ok(s.scenes.every(x=>x.cast.length<=6));assert.deepEqual(new Set(s.scenes.flatMap(x=>x.cast)),new Set(Array.from({length:12},(_,i)=>i+1)));
 s.characters.forEach((c,i)=>c.secret='PRIVATE_MARKER_'+String(i+1).padStart(2,'0'));
 for(let seat=1;seat<=12;seat++){const ctx=JSON.stringify(S.context(s,seat));for(const c of s.characters)assert.ok(!ctx.includes(c.secret))}
 for(let i=0;i<s.scenes.length;i++)for(const c of s.characters){assert.ok(!S.videoPrompt(s,i).includes(c.secret));assert.ok(!S.referenceVideoPrompt(s,i,s.characters).includes(c.secret))}
 assert.throws(()=>S.validate({...s,scenes:s.scenes.map((x,i)=>i?x:{...x,cast:[1,2,3,4,5,6,7]})}),/最多6人/);assert.throws(()=>S.context(s,13));assert.throws(()=>S.validate({...s,roomSize:6}));const legacy={...six};delete legacy.roomSize;assert.equal(S.validate(legacy).roomSize,6);
});

test('六与十二人不完整草稿互不覆盖，12号未提交外观保留且无密钥',()=>{
 const values=new Map(),st={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};let state=W.read(st);const six=S.bloodMoonSample(),twelve=S.bloodMoonSample(12);six.title='';twelve.characters[11].name='';twelve.apiKey='never-store';
 state=W.save(st,state,{dirty:true,draft:six});state=W.save(st,state,{dirty:true,draft:twelve,artEdits:{'task:1':{'character-11':'最后一席未提交描述',apiKey:'never-store'}}});
 const restored=W.read(st);assert.equal(restored.entries.new.draft.characters.length,6);assert.equal(restored.entries['new:12'].draft.characters.length,12);assert.equal(restored.lastKey,'new:12');assert.equal(restored.entries['new:12'].artEdits['task:1']['character-11'],'最后一席未提交描述');assert.ok(!JSON.stringify(restored).includes('never-store'));
});
