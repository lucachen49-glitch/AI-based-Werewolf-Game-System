const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {create,names}=require('./soundfx.js');
function musicFixture(){
 const audios=[],saved=[];let talking=false,tick=null;
 class Audio{constructor(src){this.src=src;this.paused=true;this.currentTime=0;this.calls=0;audios.push(this)}play(){this.paused=false;this.calls++;return Promise.resolve()}pause(){this.paused=true}}
 const music=require('./soundfx.js').createMusic({AudioImpl:Audio,isSpeaking:()=>talking,save:p=>saved.push(p),schedule:f=>{tick=f;return 1},cancel:()=>{tick=null}});
 return {music,audios,saved,speak:v=>{talking=v},tick:()=>tick?.()};
}
test('背景音乐需用户手势，单实例循环，人声自动压低后平滑恢复',()=>{
 const f=musicFixture();assert.deepEqual(f.music.preferences(),{enabled:true,volume:.15});f.music.start();assert.equal(f.audios.length,0);
 f.music.unlock();f.music.start();f.music.start();assert.equal(f.audios.length,1);assert.equal(f.audios[0].calls,1);assert.equal(f.audios[0].loop,true);
 for(let i=0;i<40;i++)f.tick();assert.ok(Math.abs(f.audios[0].volume-.15)<.003);
 f.speak(true);for(let i=0;i<40;i++)f.tick();assert.ok(f.audios[0].volume<.04);
 f.speak(false);for(let i=0;i<40;i++)f.tick();assert.ok(f.audios[0].volume>.14);f.music.stop();
});
test('音乐暂停保留进度，偏好独立保存，停止和旧失败回调不影响下一局',()=>{
 const f=musicFixture();f.music.unlock();f.music.start();const first=f.audios[0],late=first.onerror;first.currentTime=12;
 f.music.pause(true);assert.equal(first.paused,true);f.music.start();assert.equal(first.calls,1);f.music.pause(false);assert.equal(first.currentTime,12);assert.equal(first.calls,2);
 f.music.setVolume(.25);f.music.toggle();assert.equal(first.src,'');assert.deepEqual(f.saved.at(-1),{enabled:false,volume:.25});f.music.toggle();assert.equal(f.audios.length,2);
 late();assert.notEqual(f.audios[1].src,'');f.music.stop();assert.equal(f.audios[1].src,'');f.music.pause(false);assert.equal(f.audios.length,2);
 f.music.configure({enabled:false,volume:.4});assert.deepEqual(f.music.preferences(),{enabled:false,volume:.4});
});
test('音乐播放被拒绝或资源失败时静默停止，可在下一次手势重试',async()=>{
 let count=0;class Denied{constructor(){count++}play(){return Promise.reject(Error('blocked'))}pause(){}}
 const m=require('./soundfx.js').createMusic({AudioImpl:Denied});m.unlock();assert.doesNotThrow(()=>m.start());await new Promise(setImmediate);m.start();assert.equal(count,1);m.unlock();m.start();await new Promise(setImmediate);assert.equal(count,2);m.stop();
 const f=musicFixture();f.music.unlock();f.music.start();f.audios[0].onerror();assert.equal(f.audios[0].src,'');f.music.stop();
});
test('背景音乐本地有效且循环接缝连续，闭眼素材和音乐可通过白名单加载',async t=>{
 const {createServer}=require('./server.cjs'),{once}=require('node:events');const server=createServer({recoverVideoJobs:false});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});const base='http://127.0.0.1:'+server.address().port;
 const data=fs.readFileSync('assets/music/manor-nocturne.wav');assert.equal(data.toString('ascii',0,4),'RIFF');assert.equal((data.length-44)/data.readUInt32LE(28),64);assert.ok(Math.abs(data.readInt16LE(44)-data.readInt16LE(data.length-2))<1000);
 for(const file of ['assets/music/manor-nocturne.wav',...Array.from({length:6},(_,i)=>'assets/manor/portrait-0'+(i+1)+'-closed.webp')]){const r=await fetch(base+'/'+file);assert.equal(r.status,200);assert.ok((await r.arrayBuffer()).byteLength>1000)}
 assert.equal((await fetch(base+'/scripts/generate-music.py')).status,404);
});
test('剧情配乐只使用公开背景与阶段，分镜按画面选曲，标准局与12人局保留旧曲',()=>{
 const {storyMusic}=require('./soundfx.js'),story={title:'血月停战宴',background:'北境风雪中的古堡'};
 assert.equal(storyMusic({story}),'snow');assert.equal(storyMusic({story,phase:'discussion'}),'candle');
 assert.equal(storyMusic({story,phase:'night'}),'night');assert.equal(storyMusic({story,phase:'voting'}),'vote');assert.equal(storyMusic({story,phase:'ended'}),'dawn');
 assert.equal(storyMusic({story,scene:'雪夜里的古堡外景'}),'snow');assert.equal(storyMusic({story,scene:'烛光中围桌交谈'}),'candle');assert.equal(storyMusic({story,scene:'发现伯爵失踪'}),'night');
 assert.equal(storyMusic({size:12,story,phase:'night'}),'manor');assert.equal(storyMusic({phase:'night'}),'manor');
 const privateStory={...story,source:'不使用的原文',characters:[{secret:'投票 / 暴风雪 / 袭击'}],roles:['狼人'],target:2};
 for(const phase of ['lobby','night','discussion','voting','ended'])assert.equal(storyMusic({story:privateStory,phase}),storyMusic({story,phase}));
});
test('剧情曲目平滑交接、暂停冻结、重复渲染不重启，旧回调及停止不会恢复声音',async()=>{
 const f=musicFixture();f.music.unlock();f.music.start();const first=f.audios[0];for(let i=0;i<40;i++)f.tick();
 f.music.setTrack('night');await new Promise(setImmediate);const next=f.audios[1],oldFailure=first.onerror;
 for(let i=0;i<10;i++)f.tick();assert.ok(first.volume>0&&next.volume>0);assert.ok(next.volume<.15);
 f.music.pause(true);const levels=[first.volume,next.volume];for(let i=0;i<40;i++)f.tick();assert.deepEqual([first.volume,next.volume],levels);assert.equal(next.paused,true);
 f.music.setTrack('night');f.music.start();assert.equal(f.audios.length,2);f.music.pause(false);
 for(let i=0;i<70;i++)f.tick();assert.equal(first.src,'');assert.ok(next.volume>.14);oldFailure();assert.notEqual(next.src,'');
 for(let i=0;i<20;i++){f.music.setTrack('night');f.music.start()}assert.equal(f.audios.length,2);
 f.music.setTrack('candle');const late=f.audios[2].onplaying;f.music.stop();late();await new Promise(setImmediate);f.music.sync();assert.ok(f.audios.every(a=>a.src===''));
});
test('新配乐失败保留上一曲，快速切换只保留两轨；所有原创配乐有效且可访问',async t=>{
 const f=musicFixture();f.music.unlock();f.music.start();f.music.setTrack('night');f.audios[1].onerror();assert.equal(f.music.currentTrack(),'manor');assert.notEqual(f.audios[0].src,'');
 f.music.setTrack('candle');f.music.setTrack('vote');assert.ok(f.audios.filter(a=>a.src).length<=2);f.music.stop();
 const {createServer}=require('./server.cjs'),{once}=require('node:events');const server=createServer({recoverVideoJobs:false});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});
 for(const [id,file]of Object.entries(require('./soundfx.js').musicTracks)){
   const data=fs.readFileSync(file);assert.equal(data.toString('ascii',0,4),'RIFF');assert.equal((data.length-44)/data.readUInt32LE(28),id==='manor'?64:32);assert.ok(Math.abs(data.readInt16LE(44)-data.readInt16LE(data.length-2))<1000);
   const r=await fetch('http://127.0.0.1:'+server.address().port+'/'+file);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/audio\/wav/);assert.equal((await r.arrayBuffer()).byteLength,data.length);
 }
});
function fixture(){const audios=[];let speaking=false;const prefs=[];class FakeAudio{constructor(src){this.src=src;this.plays=0;this.pauses=0;audios.push(this)}play(){this.plays++;return Promise.resolve()}pause(){this.pauses++}}
return {audios,prefs,setSpeaking(v){speaking=v},audio:create({AudioImpl:FakeAudio,isSpeaking:()=>speaking,save:p=>prefs.push(p)})}}
test('音效只在用户启用后播放，默认30%，说话时降低音量，事件去重',()=>{
 const f=fixture();assert.deepEqual(f.audio.preferences(),{enabled:true,volume:.3});assert.equal(f.audio.play('wolf','w'),false);
 f.audio.unlock();assert.equal(f.audio.play('wolf','w'),true);assert.equal(f.audios[0].volume,.3);assert.equal(f.audio.play('wolf','w'),false);
 assert.equal(f.audios[0].src,'assets/sfx/wolf-bell-v1.wav');
 f.setSpeaking(true);f.audio.sync();assert.ok(f.audios[0].volume<.1);f.audio.pause(true);assert.equal(f.audios[0].pauses,1);assert.equal(f.audio.play('seer','s'),false);
 f.audio.pause(false);assert.equal(f.audios[0].plays,2);f.audio.setVolume(.6);assert.equal(f.prefs.at(-1).volume,.6);f.audio.reset();assert.equal(f.audios[0].src,'');assert.equal(f.audio.play('wolf','w'),true);f.audio.stop();
});
test('音效开关保存偏好，素材失败或禁止播放静默跳过，不会阻塞游戏',async()=>{
 const f=fixture();f.audio.unlock();f.audio.play('night','n');f.audio.toggle();assert.equal(f.audios[0].src,'');assert.deepEqual(f.prefs.at(-1),{enabled:false,volume:.3});assert.equal(f.audio.play('night','n2'),false);
 f.audio.configure({enabled:true,volume:2});assert.equal(f.audio.preferences().volume,1);f.audio.play('vote','v');const late=f.audios.at(-1).onended;f.audio.reset();late();assert.equal(f.audios.at(-1).src,'');
 class Denied{play(){return Promise.reject(Error('blocked'))}pause(){}}
 const denied=create({AudioImpl:Denied});denied.unlock();assert.equal(denied.play('wolf','x'),true);await new Promise(setImmediate);denied.stop();
 class Throws{play(){throw Error('blocked')}pause(){throw Error('unavailable')}}
 const throws=create({AudioImpl:Throws});throws.unlock();assert.equal(throws.play('wolf','x'),false);assert.doesNotThrow(()=>throws.reset());
});
test('原创音效全部为本地有效短 WAV，静态白名单可访问而制作脚本不公开',async t=>{
 const {createServer}=require('./server.cjs'),{once}=require('node:events');const server=createServer({recoverVideoJobs:false});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});const base='http://127.0.0.1:'+server.address().port;
 for(const name of names){const data=fs.readFileSync('assets/sfx/'+name+'.wav');assert.equal(data.toString('ascii',0,4),'RIFF');assert.equal(data.toString('ascii',8,12),'WAVE');const duration=(data.length-44)/data.readUInt32LE(28);assert.ok(duration>.1&&duration<5,name);const res=await fetch(base+'/assets/sfx/'+name+'.wav');assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/audio\/wav/);assert.equal((await res.arrayBuffer()).byteLength,data.length)}
 const {source}=require('./soundfx.js'),newFiles=new Set();
 for(const name of names){
   const file=source(name),data=fs.readFileSync(file),res=await fetch(base+'/'+file);
   assert.equal(res.status,200,name);assert.match(res.headers.get('content-type'),/audio\/wav/);
   assert.equal(data.toString('ascii',0,4),'RIFF');assert.equal(data.toString('ascii',8,12),'WAVE');
   assert.equal((data.length-44)/data.readUInt32LE(28),.4,name);
   let peak=0;for(let i=44;i<data.length;i+=2)peak=Math.max(peak,Math.abs(data.readInt16LE(i)));
   assert.ok(peak>17500&&peak<18500,name);assert.ok(Math.abs(data.readInt16LE(44))<100,name);assert.ok(Math.abs(data.readInt16LE(data.length-2))<100,name);
   assert.deepEqual(Buffer.from(await res.arrayBuffer()),data);newFiles.add(data.toString('base64'));
 }
 assert.equal(newFiles.size,names.length);
 assert.equal((await fetch(base+'/scripts/generate-effects.py')).status,404);
 const versioned=await fetch(base+'/assets/sfx/wolf-attack-v4.wav');assert.equal(versioned.status,200);const current=Buffer.from(await versioned.arrayBuffer());assert.deepEqual(current,fs.readFileSync('assets/sfx/wolf.wav'));
 const old=await fetch(base+'/assets/sfx/wolf-howl-v3.wav');assert.equal(old.status,200);assert.notDeepEqual(Buffer.from(await old.arrayBuffer()),current);
 assert.equal((current.length-44)/current.readUInt32LE(28),2.8);let peak=0;for(let i=44;i<current.length;i+=2)peak=Math.max(peak,Math.abs(current.readInt16LE(i)));assert.ok(peak>20000&&peak<30000);
});
test('免费语音语气变化范围有限，标点调整不新增台词且参数符合服务格式',()=>{
 const v=require('./voices.js');for(const style of Object.keys(v.styles))for(const voice of v.voices){const p=v.prosody(style,1,voice.id);assert.match(p.rate,/^[+-]\d+%$/);assert.match(p.pitch,/^[+-]\d+Hz$/);assert.ok(Math.abs(parseInt(p.rate))<=25);assert.ok(Math.abs(parseInt(p.pitch))<=2)}
 const input='等一下！！为什么改票？我没有说谎……请听完。';assert.equal(v.spokenText(input).replace(/[\s，。！？；：、…]/g,''),input.replace(/[\s，。！？；：、…]/g,''));assert.equal(v.emotion('请听我解释，我不是狼','auto'),'anxious');
});
