'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createMediaTools,run,inspect}=require('./video-media.cjs');

test('真实姓名条合成保留音轨和片长，中文字幕可渲染',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-title-media-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const input=path.join(dir,'source.mp4'),output=path.join(dir,'copy.mp4');
 await run(['-v','error','-y','-f','lavfi','-i','color=c=0x20120a:size=1280x720:rate=24:duration=4','-f','lavfi','-i','sine=frequency=380:duration=4','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',input]);
 const I=require('./character-intros'),story={roomSize:6,characters:[{seat:1,name:'薇拉·绯夜',publicIdentity:'绯夜家族继承人'}],scenes:[{duration:4}],introductions:{enabled:true,confirmed:true,markers:[{seat:1,scene:0,start:.5,duration:3,position:'left'}]}};story.introductions.confirmation=I.signature(story);
 await require('./title-media.cjs').renderTitles(input,output,story);const a=await inspect(input),b=await inspect(output);assert.equal(b.audio,true);assert.equal(b.video,true);assert.ok(Math.abs(a.duration-b.duration)<=.1);assert.notEqual((await fs.stat(input)).size,(await fs.stat(output)).size);
});

test('电影真实合成：变长镜头、原生对白时段、旁白分离及静默镜头不请求配音',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-cinema-media-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const tone=path.join(dir,'voice.mp3');await run(['-v','error','-y','-f','lavfi','-i','sine=frequency=380:duration=0.3','-c:a','libmp3lame',tone]);
  let requests=0;const media=createMediaTools({synthesize:async()=>{requests++;return fs.readFile(tone)}});
  const job={audioMode:'dialogue-narration',targetDuration:7,scenes:[{duration:3,narration:'旁白',narrationSeconds:2,dialogues:[{seat:1,text:'你好'}],musicCue:'snow'},{duration:4,narration:'',narrationSeconds:0,dialogues:[{seat:2,text:'我们到了'}],musicCue:'candle'}]};
  await media.prepareNarration(dir,job);await media.prepareNarration(dir,job);assert.equal(requests,1);
  for(let i=0;i<2;i++)await run(['-v','error','-y','-f','lavfi','-i',`testsrc2=size=320x180:rate=24:duration=${job.scenes[i].duration}`,'-f','lavfi','-i',`sine=frequency=1500:duration=${job.scenes[i].duration}`,'-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',path.join(dir,'scene-'+i+'.mp4')]);
  await media.assemble(dir,job);const output=path.join(dir,'intro.mp4'),info=await inspect(output);assert.equal(info.audio,true);assert.equal(info.video,true);assert.ok(Math.abs(info.duration-7)<=.1);
  // Isolate the synthetic native dialogue frequency: it must be gated during narration.
  const {spawn}=require('node:child_process');
  const binaries=await fs.readdir(path.join(__dirname,'.video-venv/Lib/site-packages/imageio_ffmpeg/binaries')),exe=path.join(__dirname,'.video-venv/Lib/site-packages/imageio_ffmpeg/binaries',binaries.find(x=>/^ffmpeg.*\.exe$/.test(x)));
  async function rms(start){return new Promise((resolve,reject)=>{const p=spawn(exe,['-v','error','-ss',String(start),'-i',output,'-t','0.4','-vn','-af','highpass=f=1400,lowpass=f=1600','-ar','8000','-ac','1','-f','f32le','pipe:1'],{windowsHide:true});const chunks=[];p.stdout.on('data',x=>chunks.push(x));p.on('error',reject);p.on('close',code=>{if(code)return reject(Error('audio inspection'));const b=Buffer.concat(chunks);let sum=0;for(let i=0;i+4<=b.length;i+=4)sum+=b.readFloatLE(i)**2;resolve(Math.sqrt(sum/(b.length/4)))})})}
  const quiet=await rms(1.2),spoken=await rms(2.3),second=await rms(4);assert.ok(spoken>quiet*8,{quiet,spoken});assert.ok(second>quiet*8,{quiet,second});
  const changed={...job,scenes:job.scenes.map((s,i)=>i?s:{...s,narrationSeconds:1})};await media.prepareNarration(dir,changed);assert.equal(requests,2,'changing the reserved narration window invalidates cached timing');
  const mute=path.join(dir,'mute.mp4');await run(['-v','error','-y','-i',path.join(dir,'scene-0.mp4'),'-an','-c:v','copy',mute]);
  await assert.rejects(()=>media.normalize(mute,path.join(dir,'no.mp4'),{audioMode:'dialogue-narration',duration:3}),{code:'VIDEO_NO_AUDIO'});
  await assert.rejects(()=>media.normalize(path.join(dir,'scene-0.mp4'),path.join(dir,'short.mp4'),{audioMode:'dialogue-narration',duration:4}),{code:'VIDEO_TOO_SHORT'});
});
test('真实媒体管线：六段动态画面合成为60秒，原声移除、旁白缓存与超长检查',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-media-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const voiceFile=path.join(dir,'voice.mp3');
  await run(['-v','error','-y','-f','lavfi','-i','sine=frequency=380:duration=1','-c:a','libmp3lame',voiceFile]);
  const audio=await fs.readFile(voiceFile);let requests=0;
  const media=createMediaTools({synthesize:async body=>{assert.equal(body.voice,'zh-CN-YunyangNeural');requests++;return audio}});
  const job={scenes:Array.from({length:6},(_,i)=>({narration:'第'+(i+1)+'段统一旁白。',musicCue:['snow','candle','candle','night','snow','candle'][i]})),audioMode:'unified',targetDuration:60};
  await media.prepareNarration(dir,job);await media.prepareNarration(dir,job);assert.equal(requests,6);
  for(let i=0;i<6;i++){
    const source=path.join(dir,'source-'+i+'.mp4');
    await run(['-v','error','-y','-f','lavfi','-i',`testsrc2=size=320x180:rate=24:duration=10`,'-f','lavfi','-i',`sine=frequency=${800+i*100}:duration=10`,'-vf',`hue=h=${i*50}`,'-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
    if(i===0){await media.normalize(source,path.join(dir,'checked.mp4'),{audioMode:'unified'});assert.equal((await inspect(path.join(dir,'checked.mp4'))).audio,false)}
    await run(['-v','error','-y','-i',source,'-an','-c:v','copy',path.join(dir,'scene-'+i+'.mp4')]);
  }
  await media.assemble(dir,job);const info=await inspect(path.join(dir,'intro.mp4'));
  assert.equal(info.audio,true);assert.equal(info.video,true);assert.ok(Math.abs(info.duration-60)<=.1);
  // Silence is valid for the new video-only sources; legacy still requires audio.
  await assert.rejects(()=>media.normalize(path.join(dir,'scene-0.mp4'),path.join(dir,'bad.mp4')),e=>e.code==='VIDEO_NO_AUDIO');
  const long=path.join(dir,'long.mp3');await run(['-v','error','-y','-f','lavfi','-i','sine=frequency=400:duration=11','-c:a','libmp3lame',long]);
  const tooLong=createMediaTools({synthesize:async()=>fs.readFile(long)});
  await assert.rejects(()=>tooLong.prepareNarration(path.join(dir,'too-long'),job),e=>e.code==='VIDEO_NARRATION_TOO_LONG');
  const controller=new AbortController();controller.abort();await assert.rejects(()=>media.assemble(dir,job,{signal:controller.signal}),e=>e.name==='AbortError');
});

test('连续镜头无对白时保留静音轨且尾帧没有淡黑，真实末帧用于接镜',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nightfall-continuous-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'),clip=path.join(dir,'scene-0.mp4'),tail=path.join(dir,'tail.png');
  await run(['-v','error','-y','-f','lavfi','-i','color=c=red:size=320x180:rate=24:duration=1','-vf',"drawbox=color=lime:t=fill:enable='gte(t,0.958)'",'-c:v','libx264','-preset','ultrafast',source]);
  const media=createMediaTools();await media.normalize(source,clip,{audioMode:'unified',duration:1,continuous:true});
  assert.equal((await inspect(clip)).audio,true);
  await media.extractLastFrame(clip,tail);
  const stats=await run(['-i',tail,'-vf','signalstats,metadata=print','-f','null','-']);
  const y=Number(/lavfi.signalstats.YAVG=([\d.]+)/.exec(stats)?.[1]);
  assert.ok(y>120,'尾帧应为最后一帧的绿色画面，不能取到前面的红色或淡黑帧');
});


test('连续片段混合静音与对白时，合成音轨保持原位置', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nightfall-mixed-audio-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const silent = path.join(dir, 'silent.mp4');
  const spoken = path.join(dir, 'spoken.mp4');
  await run(['-v','error','-y','-f','lavfi','-i','color=c=red:size=320x180:rate=24:duration=2',
    '-c:v','libx264','-preset','ultrafast',silent]);
  await run(['-v','error','-y','-f','lavfi','-i','color=c=blue:size=320x180:rate=24:duration=2',
    '-f','lavfi','-i','sine=frequency=1500:duration=2','-c:v','libx264','-preset','ultrafast',
    '-c:a','aac','-shortest',spoken]);
  const media = createMediaTools({synthesize:async () => { throw Error('No narration expected'); }});
  const job = {audioMode:'dialogue-narration',targetDuration:4,scenes:[
    {duration:2,narration:'',narrationSeconds:0,dialogues:[],musicCue:'candle'},
    {duration:2,narration:'',narrationSeconds:0,dialogues:[{seat:1,text:'Stay close.'}],musicCue:'candle'}
  ]};
  await media.normalize(silent,path.join(dir,'scene-0.mp4'),{duration:2,audioMode:'unified',continuous:true});
  await media.normalize(spoken,path.join(dir,'scene-1.mp4'),{duration:2,audioMode:'dialogue-narration',continuous:true});
  await media.prepareNarration(dir,job);
  await media.assemble(dir,job);
  const output = path.join(dir,'intro.mp4');
  const info = await inspect(output);
  assert.ok(info.audio && info.video);
  assert.ok(Math.abs(info.duration - 4) <= .1);
  async function level(start) {
    const stats = await run(['-hide_banner','-ss',String(start),'-i',output,'-t','0.4',
      '-vn','-af','highpass=f=1400,lowpass=f=1600,volumedetect','-f','null','-']);
    return Number(/mean_volume: ([-\d.]+)/.exec(stats)?.[1]);
  }
  const first = await level(.8), second = await level(2.8);
  assert.ok(second > first + 15, 'dialogue should remain in the second shot: ' + first + ' / ' + second);
});
