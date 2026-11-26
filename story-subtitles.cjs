'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {atomic, readAtomic, validId, StoryError} = require('./scenario-store.cjs');
const {run, inspect} = require('./video-media.cjs');
const {safe, stamp} = require('./title-media.cjs');

function suggestedCues(job) {
  const cues = [];
  let offset = 0;
  for (const [index, scene] of job.scenes.entries()) {
    const duration = scene.duration || job.sceneDuration || 10;
    const timing = scene.timing || {};
    if (scene.narration && scene.narrationTranslation) {
      cues.push({scene:index, start:offset+(timing.narrationStart || 0), end:offset+(timing.narrationEnd || scene.narrationSeconds || 1), en:scene.narration, zh:scene.narrationTranslation});
    }
    const lines = (scene.dialogues || []).filter(line => line.text && line.translation);
    const start = Math.min(duration, Math.max(timing.dialogueStart ?? 0, scene.narration && scene.narrationTranslation ? (timing.narrationEnd ?? scene.narrationSeconds ?? 1) : 0));
    const weights = lines.map(line => Math.max(1, line.text.trim().split(/\s+/).length));
    const total = weights.reduce((a,b) => a+b, 0);
    let cursor = start;
    lines.forEach((line, i) => {
      const end = i === lines.length - 1 ? duration : cursor + (duration - start) * weights[i] / total;
      cues.push({scene:index, start:+(offset+cursor).toFixed(2), end:+(offset+end).toFixed(2), en:line.text, zh:line.translation});
      cursor = end;
    });
    offset += duration;
  }
  return cues;
}
function cleanCues(cues, job) {
  if (!Array.isArray(cues) || !cues.length) throw new StoryError(400,'SUBTITLE_EMPTY','请填写至少一条双语字幕');
  const duration = job.scenes.reduce((n,s)=>n+(s.duration || job.sceneDuration || 10),0);
  let previous = 0;
  return cues.map((cue, index) => {
    const start = Number(cue.start), end = Number(cue.end), en = String(cue.en || '').trim(), zh = String(cue.zh || '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previous || end <= start || end > duration + 0.001) throw new StoryError(400,'SUBTITLE_TIME','第 '+(index+1)+' 条字幕的时间无效或与前一句重叠');
    if (!en || !zh || en.length > 500 || zh.length > 500) throw new StoryError(400,'SUBTITLE_TEXT','第 '+(index+1)+' 条字幕需要英文和中文，且每条不超过 500 字');
    previous = end;
    return {scene:Number.isInteger(cue.scene)?cue.scene:null,start,end,en,zh};
  });
}
function srtTime(seconds) { const ms=Math.round(seconds*1000); return [Math.floor(ms/3600000),Math.floor(ms/60000)%60,Math.floor(ms/1000)%60].map(n=>String(n).padStart(2,'0')).join(':')+','+String(ms%1000).padStart(3,'0'); }
function makeSrt(cues, title) {
  const all=title?[...cues,{start:title.duration,end:title.duration+4,zh:title.titleZh+'\n'+title.hookZh,en:title.titleEn+'\n'+title.hookEn}]:cues;
  return all.map((c,i)=>`${i+1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.zh}\n${c.en}\n`).join('\n');
}
function makeAss(cues,duration,titleZh,titleEn,hookZh,hookEn) {
  const rows=cues.map(c=>`Dialogue: 0,${stamp(c.start)},${stamp(c.end)},Sub,,0,0,0,,${safe(c.zh)}\\N${safe(c.en)}`);
  rows.push(`Dialogue: 0,${stamp(duration)},${stamp(duration+4)},Title,,0,0,0,,{\\fad(500,500)}${safe(titleZh)}\\N${safe(titleEn)}\\N\\N${safe(hookZh)}\\N${safe(hookEn)}`);
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Sub,Microsoft YaHei,29,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,90,90,45,1\nStyle: Title,Microsoft YaHei,34,&H00D3E9FF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,5,80,80,0,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${rows.join('\n')}\n`;
}
function createSubtitleJobs({root,jobs}) {
  const active=new Map();
  async function get(id) {if(!validId(id))throw new StoryError(404,'SUBTITLE_NOT_FOUND','找不到字幕副本');try{return await readAtomic(path.join(root,id,'job.json'))}catch(e){if(e.code==='ENOENT')throw new StoryError(404,'SUBTITLE_NOT_FOUND','找不到字幕副本');throw e}}
  const save=j=>atomic(path.join(root,j.id,'job.json'),j);
  const summary=j=>({...j,status:j.status==='running'&&!active.has(j.id)?'failed':j.status,url:j.status==='ready'?`/api/story-subtitle-media/${j.id}/movie.mp4`:null,srtUrl:j.status==='ready'?`/api/story-subtitle-media/${j.id}/subtitles.srt`:null});
  async function work(j) {
    try {
      const dir=path.join(root,j.id), ass=path.join(dir,'subtitles.ass');
      await fs.writeFile(ass,makeAss(j.cues,j.duration,j.titleZh,j.titleEn,j.hookZh,j.hookEn),'utf8');
      await fs.writeFile(path.join(dir,'subtitles.srt'),makeSrt(j.cues,j),'utf8');
      const escaped=ass.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");
      const output=path.join(dir,'movie.tmp.mp4');
      await run(['-v','error','-y','-i',path.join(dir,'original.mp4'),'-filter_complex',`[0:v]tpad=stop_mode=add:stop_duration=4:color=black,subtitles=filename='${escaped}'[v];[0:a]apad=pad_dur=4[a]`,'-map','[v]','-map','[a]','-t',String(j.duration+4),'-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',output],600000);
      const info=await inspect(output);if(!info.video||!info.audio||Math.abs(info.duration-j.duration-4)>.15)throw Error('视频时长或音轨校验未通过');
      await fs.rename(output,path.join(dir,'movie.mp4'));j.status='ready';j.message='双语字幕与片尾副本已完成，请对照实际声音完整观看。';
    } catch(e) {j.status='failed';j.message='本地合成失败，原视频保留。'+e.message}
    await save(j);
  }
  return {
    async suggestions(id) {const job=await jobs.get(id);if(!['ready','accepted'].includes(job.status))throw new StoryError(409,'VIDEO_NOT_READY','请选择已完成的视频');return {duration:job.scenes.reduce((n,s)=>n+(s.duration||job.sceneDuration||10),0),cues:suggestedCues(job)}},
    async create(body) {
      const source=await jobs.get(body.sourceJobId);if(!['ready','accepted'].includes(source.status))throw new StoryError(409,'VIDEO_NOT_READY','请选择已完成的视频');
      const cues=cleanCues(body.cues,source),duration=source.scenes.reduce((n,s)=>n+(s.duration||source.sceneDuration||10),0);
      const text=(v,fallback)=>String(v||fallback).trim().slice(0,100);
      if(body.productionId){const existing=(await service.list(source.id)).find(j=>j.productionId===body.productionId);if(existing)return existing;}
      const j={...(body.productionId?{productionId:body.productionId}:{}),id:randomUUID(),sourceJobId:source.id,storyId:source.storyId,version:source.version,duration,cues,titleZh:text(body.titleZh,'血月停战宴'),titleEn:text(body.titleEn,'The Blood Moon Truce'),hookZh:text(body.hookZh,'谁值得信任？'),hookEn:text(body.hookEn,'Who can you trust?'),status:'running',message:'正在本地合成字幕与片尾',createdAt:new Date().toISOString()};
      const dir=path.join(root,j.id);await fs.mkdir(dir,{recursive:true});await fs.copyFile(await jobs.mediaFile(source.id,'intro.mp4'),path.join(dir,'original.mp4'));await save(j);
      const task=work(j).finally(()=>active.delete(j.id));active.set(j.id,task);return summary(j);
    },
    async applyCandidate(id,changes={}){
      const parent=await get(id);if(parent.status!=='ready')throw new StoryError(409,'SUBTITLE_NOT_READY','仅可修改已完成的字幕与片尾副本');
      const source=await jobs.get(parent.sourceJobId),cues=Array.isArray(changes.subtitleCues)?cleanCues(changes.subtitleCues,source):parent.cues;
      const text=(value,fallback)=>{const v=String(value??fallback).trim();if(!v||v.length>100)throw new StoryError(400,'SUBTITLE_TEXT','片尾文字需为 1 至 100 字');return v};
      const j={...parent,id:randomUUID(),parentSubtitleId:parent.id,revision:(parent.revision||1)+1,cues,titleZh:text(changes.titleZh,parent.titleZh),titleEn:text(changes.titleEn,parent.titleEn),hookZh:text(changes.hookZh,parent.hookZh),hookEn:text(changes.hookEn,parent.hookEn),status:'running',message:'正在复用原视频重新合成双语字幕与片尾',createdAt:new Date().toISOString()};
      const dir=path.join(root,j.id);await fs.mkdir(dir,{recursive:true});await fs.copyFile(path.join(root,parent.id,'original.mp4'),path.join(dir,'original.mp4'));await save(j);
      const task=work(j).finally(()=>active.delete(j.id));active.set(j.id,task);return summary(j);
    },
    async getSummary(id){return summary(await get(id))},
    async list(sourceId){let ids;try{ids=await fs.readdir(root)}catch(e){if(e.code==='ENOENT')return [];throw e}const all=await Promise.all(ids.filter(validId).map(id=>get(id).catch(()=>null)));return all.filter(j=>j&&j.sourceJobId===sourceId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(summary)},
    async mediaFile(id,name){if(!['movie.mp4','subtitles.srt'].includes(name))throw new StoryError(404,'SUBTITLE_NOT_FOUND','找不到字幕文件');const j=await get(id);if(j.status!=='ready')throw new StoryError(404,'SUBTITLE_NOT_READY','副本尚未完成');return path.join(root,id,name)},
    async close(){await Promise.allSettled([...active.values()])}
  };
}
module.exports={suggestedCues,cleanCues,makeSrt,makeAss,createSubtitleJobs};
