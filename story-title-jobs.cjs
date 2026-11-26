'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {atomic,readAtomic,validId,StoryError}=require('./scenario-store.cjs'),I=require('./character-intros.js'),{renderTitles}=require('./title-media.cjs');
function createTitleJobs({root,store,jobs,render=renderTitles}={}){
  const active=new Map();let tail=Promise.resolve(),closed=false;
  const locked=fn=>{const p=tail.then(fn);tail=p.catch(()=>{});return p};
  const file=id=>path.join(root,id,'job.json');
  async function get(id){if(!validId(id))throw new StoryError(404,'TITLE_NOT_FOUND','找不到人物介绍副本');try{return await readAtomic(file(id))}catch(e){if(e.code==='ENOENT')throw new StoryError(404,'TITLE_NOT_FOUND','找不到人物介绍副本');throw e}}
  const save=j=>atomic(file(j.id),{...j,updatedAt:new Date().toISOString()});
  function summary(j){const status=j.status==='running'&&!active.has(j.id)?'paused':j.status;return {id:j.id,storyId:j.storyId,version:j.version,roomSize:j.story.roomSize||6,sourceJobId:j.sourceJobId,status,message:j.message,createdAt:j.createdAt,introductions:j.story.introductions,characters:j.story.characters,url:['ready','accepted'].includes(status)?'/api/story-title-media/'+j.id+'/intro.mp4':null}}
  async function list(storyId){let ids;try{ids=await fs.readdir(root)}catch(e){if(e.code==='ENOENT')return [];throw e}const results=await Promise.allSettled(ids.filter(validId).map(get)),all=[];for(const result of results){if(result.status==='fulfilled')all.push(result.value);else if(result.reason.code!=='TITLE_NOT_FOUND')throw result.reason;}return all.filter(j=>!storyId||j.storyId===storyId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}
  async function work(id,signal){const j=await get(id);try{j.message='正在本地加入人物姓名条，保留原片画面、音轨与片长';await save(j);const dest=path.join(root,id,'intro.part.mp4');await render(path.join(root,id,'original.mp4'),dest,j.story,{signal});await fs.rename(dest,path.join(root,id,'intro.mp4'));j.status='ready';j.message='独立副本已完成。完整预览并确认后才会替换游戏开场。';await save(j)}catch(e){j.status='paused';j.message=signal.aborted?'本地合成已暂停，原片与设置已保留':e.message;await save(j)}}
  function launch(id){if(closed||active.has(id))return;const controller=new AbortController(),promise=work(id,controller.signal).finally(()=>active.delete(id));active.set(id,{controller,promise})}
  return {get,summary,
    async list(storyId){return (await list(storyId)).map(summary)},
    create(body){return locked(async()=>{
      const s=await store.get(body.storyId),source=await jobs.get(body.sourceJobId);
      if(s.version!==body.version)throw new StoryError(409,'STALE_TITLES','剧本已更新，请重新载入');
      if(source.storyId!==s.id||(source.roomSize||6)!==(s.roomSize||6)||!['ready','accepted'].includes(source.status))throw new StoryError(400,'TITLE_SOURCE','请选择本剧本同人数已经完成的成片');
      const chars=s.characters.map(c=>{const edit=body.characters?.find(x=>x.seat===c.seat);if(edit?.name!==undefined&&edit.name!==c.name)throw new StoryError(409,'TITLE_NAMES','人物姓名尚未保存，请先保存剧本，再制作介绍副本');return {seat:c.seat,name:c.name,publicIdentity:String(edit?.publicIdentity??c.publicIdentity??'').trim()}});
      if(chars.some(c=>!c.publicIdentity||c.publicIdentity.length>40))throw new StoryError(400,'TITLE_IDENTITY','请填写每位人物的公开剧情身份（最多40字）');
      // Timeline follows the original movie's real segments, never a newer draft's durations.
      const scenes=source.scenes.map((x,i)=>({duration:x.duration||source.sceneDuration||10,cast:source.art?.frames?.[i]?.cast||[],description:source.art?.frames?.[i]?.description||'',startFrame:'',endFrame:''}));
      const story={roomSize:s.roomSize||6,characters:chars,scenes,introductions:I.clean(body.introductions)};
      if(!story.introductions?.enabled)throw new StoryError(400,'TITLE_REQUIRED','请启用并确认人物介绍');
      // The editor confirms actual frames. Bind that confirmation to this immutable movie snapshot.
      if(body.visualConfirmed!==true)throw new StoryError(400,'TITLE_REVIEW','请对照实际画面确认人物与登场时刻');
      story.introductions.confirmed=true;story.introductions.confirmation=I.signature(story);
      const errors=I.issues(story);if(errors.length)throw new StoryError(400,'TITLE_MARKERS',errors.join('；'));
      const input=await jobs.mediaFile(source.id,'intro.mp4'),stat=await fs.stat(input);
      const signature=createHash('sha256').update(JSON.stringify([source.id,stat.size,stat.mtimeMs,s.version,story])).digest('hex');
      const prior=(await list(s.id)).find(j=>j.signature===signature);if(prior)return summary(prior);
      const id=randomUUID(),dir=path.join(root,id);await fs.mkdir(dir,{recursive:true});await fs.copyFile(input,path.join(dir,'original.mp4'));
      const j={id,sourceJobId:source.id,storyId:s.id,version:s.version,story,status:'running',message:'本地任务已保存，不调用图片或视频生成模型',signature,createdAt:new Date().toISOString()};await save(j);launch(id);return summary(j);
    })},
    action(id,body){return locked(async()=>{const j=await get(id);if(active.has(id))throw new StoryError(409,'TITLE_BUSY','正在本地合成，请稍候');if(body.action==='resume'){if(!['ready','accepted'].includes(j.status)){j.status='running';await save(j);launch(id)}return summary(j)}if(body.action==='accept'){if(!['ready','accepted'].includes(j.status)||body.watched!==true||body.visualConfirmed!==true)throw new StoryError(400,'TITLE_WATCH','请完整观看并核对姓名、画面及字幕位置后采用');await store.bindVideo(j.storyId,j.version,j.id,'titles');j.status='accepted';await save(j);return summary(j)}throw new StoryError(400,'TITLE_ACTION','不支持此操作')})},
    async mediaFile(id,name){const j=await get(id);if(name!=='intro.mp4'||!['ready','accepted'].includes(j.status))throw new StoryError(404,'TITLE_MEDIA','人物介绍副本尚未完成');return path.join(root,id,'intro.mp4')},
    async close(){closed=true;for(const x of active.values())x.controller.abort();await Promise.allSettled([...active.values()].map(x=>x.promise))}
  };
}
module.exports={createTitleJobs};
