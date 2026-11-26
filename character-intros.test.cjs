'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const I=require('./character-intros.js'),S=require('./scenario.js'),W=require('./workshop-state.js'),{ass}=require('./title-media.cjs'),{createTitleJobs}=require('./story-title-jobs.cjs');
test('人数切换与恢复期间姓名条不读取旧人数表单',async()=>{
 const vm=require('node:vm'),nodes={};const context=vm.createContext({$:id=>nodes[id]??={disabled:false},restoring:true,renderedDraft:{roomSize:12},roomSize:12,rawDraft(){throw Error('Old form must not be read')}});
 vm.runInContext(await fs.readFile('character-intro-ui.js','utf8'),context);vm.runInContext('introUpdate()',context);assert.equal(nodes.createIntroCopy.disabled,true);
 context.restoring=false;context.roomSize=6;nodes.createIntroCopy.disabled=false;vm.runInContext('introUpdate()',context);assert.equal(nodes.createIntroCopy.disabled,true);
});
function fixture(count=6){const s=S.bloodMoonSample(count);s.characters.forEach((c,i)=>c.publicIdentity='公开身份'+(i+1));s.introductions=I.suggest(s);s.introductions.confirmed=true;s.introductions.confirmation=I.signature(s);return s}
test('六与十二人介绍完整覆盖、时间与确认失效，旧剧本不阻断',()=>{
 assert.deepEqual(I.issues(S.bloodMoonSample()),[]);
 for(const count of [6,12]){const s=fixture(count);assert.deepEqual(I.issues(s),[]);assert.equal(I.timeline(s).length,count);assert.equal(I.at(s,I.timeline(s)[0].absoluteStart).seat,1);s.characters[0].secret='private never displayed';assert.deepEqual(I.issues(s),[]);assert.doesNotMatch(ass(s),/private never displayed/);s.characters[0].name+='改';assert.match(I.issues(s).join(),/确认人物介绍/);s.introductions.confirmation=I.signature(s);s.introductions.markers[0].start=999;assert.match(I.issues(s).join(),/超出时间范围/);}
 const s=fixture();s.introductions.markers[1]={...s.introductions.markers[0],seat:2};assert.match(I.issues(s).join(),/重叠/);s.characters[0].publicIdentity='';assert.match(I.issues(s).join(),/公开剧情身份/);
});
test('草稿保存介绍与公开身份，按人数隔离且不保留额外凭据',()=>{
 let value=null;const st={getItem:()=>value,setItem:(k,v)=>value=v};let state=W.read(st);
 for(const count of [6,12]){const d=fixture(count);d.introSourceId=randomUUID();d.apiKey='never-save-key';d.introductions.apiKey='never-save-key';state=W.save(st,state,{draft:d,dirty:true});}
 for(const count of [6,12]){const d=W.latest(W.read(st),count).draft;assert.equal(d.characters.length,count);assert.equal(d.characters[0].publicIdentity,'公开身份1');assert.equal(d.introductions.markers.length,count);assert.ok(d.introSourceId);}
 assert.doesNotMatch(value,/never-save-key/);
});
test('字幕安全转义，不从秘密或随机身份推断姓名条',()=>{
 const s=fixture();s.characters[0].name='{\\pos(0,0)}名字\n下一行';s.characters[0].secret='SECRET';s.characters[0].role='狼人';s.characters[0].publicIdentity='公开称谓';const text=ass(s);assert.doesNotMatch(text,/SECRET|狼人|\\pos\(0,0\)/);assert.match(text,/公开称谓/);assert.match(text,/\\fad\(300,450\)/);
});
test('独立副本去重、重启恢复、确认门槛与源素材保护',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-title-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const s={...fixture(),id:randomUUID(),version:1},source={id:randomUUID(),storyId:s.id,roomSize:6,status:'accepted',scenes:s.scenes.map(x=>({duration:x.duration})),art:{frames:s.scenes.map(x=>({cast:x.cast,description:x.description}))}};
 const original=path.join(root,'source.mp4');await fs.writeFile(original,'untouched source');let binds=0,renders=0,fail=true;
 const options={root:path.join(root,'titles'),store:{get:async()=>s,bindVideo:async(id,v,j,kind)=>{assert.equal(kind,'titles');binds++}},jobs:{get:async()=>source,mediaFile:async()=>original},render:async(input,out,story)=>{renders++;assert.doesNotMatch(JSON.stringify(story),/secret/);if(fail)throw Error('本地暂时不可用');await fs.copyFile(input,out)}};
 let jobs=createTitleJobs(options);t.after(()=>jobs.close());const body={storyId:s.id,version:1,sourceJobId:source.id,characters:s.characters.map(({seat,name,publicIdentity})=>({seat,name,publicIdentity})),introductions:s.introductions,visualConfirmed:true};
 await assert.rejects(()=>jobs.create({...body,visualConfirmed:false}),{code:'TITLE_REVIEW'});
 await assert.rejects(()=>jobs.create({...body,characters:body.characters.map((c,i)=>i?c:{...c,name:'未保存姓名'})}),{code:'TITLE_NAMES'});
 const j=await jobs.create(body);await jobs.close();assert.equal((await jobs.get(j.id)).status,'paused');assert.equal((await jobs.create(body)).id,j.id);assert.equal(renders,1);
 fail=false;jobs=createTitleJobs(options);await jobs.action(j.id,{action:'resume'});for(let n=0;n<100&&(await jobs.summary(await jobs.get(j.id))).status==='running';n++)await new Promise(r=>setTimeout(r,10));
 assert.equal((await jobs.get(j.id)).status,'ready');assert.equal(await fs.readFile(original,'utf8'),'untouched source');assert.equal(binds,0);assert.equal((await jobs.create(body)).id,j.id);assert.equal(renders,2);
 await assert.rejects(()=>jobs.mediaFile(j.id,'original.mp4'),{code:'TITLE_MEDIA'});await assert.rejects(()=>jobs.action(j.id,{action:'accept',watched:false}),{code:'TITLE_WATCH'});await jobs.action(j.id,{action:'accept',watched:true,visualConfirmed:true});assert.equal(binds,1);
});

test('Grok刚完成的未采用成片可直接进行姓名条本地合成',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-title-ready-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const s={...fixture(),id:randomUUID(),version:3},source={id:randomUUID(),storyId:s.id,roomSize:6,status:'ready',scenes:s.scenes.map(x=>({duration:x.duration})),art:{frames:s.scenes.map(x=>({cast:x.cast,description:x.description}))}},original=path.join(root,'original.mp4');
 await fs.writeFile(original,'raw grok movie');let videoCalls=0;
 const jobs=createTitleJobs({root:path.join(root,'titles'),store:{get:async()=>s,bindVideo:async()=>{}},jobs:{get:async()=>source,mediaFile:async()=>original},render:async(input,out)=>{videoCalls++;await fs.copyFile(input,out)}});t.after(()=>jobs.close());
 const j=await jobs.create({storyId:s.id,version:s.version,sourceJobId:source.id,characters:s.characters.map(({seat,name,publicIdentity})=>({seat,name,publicIdentity})),introductions:s.introductions,visualConfirmed:true});
 for(let n=0;n<100&&(await jobs.summary(await jobs.get(j.id))).status==='running';n++)await new Promise(r=>setTimeout(r,10));
 assert.equal((await jobs.summary(await jobs.get(j.id))).status,'ready');assert.equal(videoCalls,1);assert.equal(await fs.readFile(original,'utf8'),'raw grok movie');
});
