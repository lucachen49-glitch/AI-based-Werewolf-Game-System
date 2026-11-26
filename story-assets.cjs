'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {StoryError,validId}=require('./scenario-store.cjs');
function createStoryAssets({jobs,artJobs}){
  const fail=()=>{throw new StoryError(404,'REUSE_ASSET_NOT_FOUND','原素材不存在或尚未完成，请重新选择')};
  async function resolve(key,size){
    const m=/^(art|video):([a-f0-9-]{36}):(character|frame|scene):(\d+)$/.exec(key||'');if(!m||!validId(m[2]))return fail();const [,type,id,kind,n]=m,index=+n,service=type==='art'?artJobs:jobs,j=await service.get(id);if((j.roomSize||6)!==size)return fail();let item,file,mime;
    if(type==='video'&&kind==='scene'){item=j.scenes[index];if(item?.status!=='done')return fail();file=await jobs.mediaFile(id,'scene-'+index+'.mp4');mime='video/mp4'}
    else {item=(type==='art'?kind==='character'?j.characters:kind==='frame'?j.frames:[]:kind==='character'?j.art?.characters:kind==='frame'?j.art?.frames:[])?.[index];if(!item?.file||type==='art'&&item.status!=='done')return fail();if(type==='art')file=await artJobs.mediaFile(id,item.file);else{if(!/^ref-[a-f0-9-]{36}\.png$/.test(item.file))return fail();file=path.join(jobs.root,id,item.file)}mime='image/png'}
    await fs.access(file);return {file,mime,type,id,kind,index,item,storyId:j.storyId,version:j.version,duration:item.duration||j.sceneDuration||10,roomSize:j.roomSize||6};
  }
  async function catalog(size=6){const out=[];for(const [type,service]of [['art',artJobs],['video',jobs]]){const rows=await service.list();for(const row of rows.filter(j=>(j.roomSize||6)===size).slice(0,60)){const j=await service.get(row.id),groups=type==='art'?[['character',j.characters],['frame',j.frames]]:[['character',j.art?.characters],['frame',j.art?.frames],['scene',j.scenes]];for(const [kind,items]of groups)for(const [i,item]of (items||[]).entries()){if(kind==='scene'?item.status!=='done':!item.file||type==='art'&&item.status!=='done')continue;const id=type+':'+j.id+':'+kind+':'+i;out.push({id,type,kind,index:i,seat:item.seat||null,name:item.name||'',appearance:item.appearance||'',cast:item.cast||[],storyId:j.storyId,version:j.version,taskId:j.id,createdAt:j.createdAt,duration:kind==='scene'?item.duration||j.sceneDuration||10:null,label:(type==='art'?'图片':'视频')+' v'+j.version+' · '+(kind==='character'?(item.seat||i+1)+'号 '+(item.name||'人物'):kind==='frame'?'分镜 '+(i+1):'动态镜头 '+(i+1))+' · '+j.id.slice(0,8),url:'/api/story-assets/media/'+encodeURIComponent(id)+'?roomSize='+size,...(kind==='scene'?{dialogues:item.dialogues||[],narration:item.narration||''}:{})});}}}return out;}
  return {resolve,catalog};
}
module.exports={createStoryAssets};
