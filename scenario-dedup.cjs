'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const key=s=>(s.roomSize||6)+':'+s.title.trim();
const newest=(a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))||b.version-a.version||a.id.localeCompare(b.id);
const mediaChecks=new Map();
async function validVideo(root,s){
  if(!s.video?.jobId||!/^[a-f0-9-]{36}$/.test(s.video.jobId))return false;
  try{const dir=path.join(root,'videos',s.video.jobId),j=JSON.parse(await fs.readFile(path.join(dir,'job.json'),'utf8'));
    if(j.status!=='accepted'||j.storyId!==s.id||j.version!==s.version||(j.roomSize||6)!==(s.roomSize||6))return false;
    const movie=path.join(dir,'intro.mp4'),stat=await fs.stat(movie),stamp=stat.size+':'+stat.mtimeMs;
    if(mediaChecks.get(movie)?.stamp===stamp)return mediaChecks.get(movie).valid;
    // Lazy import avoids the store/media error-class dependency during module initialization.
    const info=await require('./video-media.cjs').inspect(movie),valid=info.video&&info.duration>0;
    mediaChecks.set(movie,{stamp,valid});return valid;
  }catch{return false}
}
async function groupStories(root,rows){const groups=new Map();for(const s of rows){const k=key(s);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(s)}
  return Promise.all([...groups.values()].map(async group=>{const ordered=group.slice().sort(newest),valid=await Promise.all(ordered.map(s=>validVideo(root,s)));const keep=ordered[valid.indexOf(true)]||ordered[0];return {keep,remove:ordered.filter(s=>s.id!==keep.id),validVideo:valid.some(Boolean)}}));
}
// Only metadata is read. Credentials and browser configuration are never included.
async function archiveDuplicates(store,archiveRoot){
  const root=path.resolve(store.root),dest=path.resolve(archiveRoot);
  if(dest.toLowerCase()===root.toLowerCase()||dest.toLowerCase().startsWith((root+path.sep).toLowerCase()))throw Error('备份目录必须位于活动数据目录以外');
  const rows=await store.all(),groups=await groupStories(root,rows),removed=new Set(groups.flatMap(g=>g.remove.map(s=>s.id))),jobs=[];
  for(const type of ['art','videos'])for(const id of await fs.readdir(path.join(root,type)).catch(()=>[])){
    if(!/^[a-f0-9-]{36}$/.test(id))continue;
    // An unreadable job makes protection unverifiable. Stop before any move.
    const j=JSON.parse(await fs.readFile(path.join(root,type,id,'job.json'),'utf8'));jobs.push({type,id,j});
  }
  const protectedIds=new Set(jobs.filter(({j})=>['running','needs_review','queued'].includes(j.status)||[...(j.characters||[]),...(j.frames||[]),...(j.scenes||[])].some(i=>['unknown','submitting','pending','downloading','saved_raw'].includes(i.status))).map(x=>x.id));
  for(const {id,j} of jobs)if(!removed.has(j.storyId))protectedIds.add(id);
  for(const s of rows.filter(s=>!removed.has(s.id)))if(s.video?.jobId)protectedIds.add(s.video.jobId);
  // Historical retained versions can still reference an older/shared video or art task.
  for(const s of rows.filter(s=>!removed.has(s.id))){
    const dir=path.join(root,'versions',s.id);
    for(const file of await fs.readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e})){
      if(!/^\d+\.json$/.test(file))continue;
      const v=JSON.parse(await fs.readFile(path.join(dir,file),'utf8'));
      if(v.video?.jobId)protectedIds.add(v.video.jobId);
    }
  }
  let changed=true;while(changed){changed=false;for(const {id,j} of jobs)if(protectedIds.has(id))for(const ref of [j.artId,j.art?.id,j.video?.jobId])if(ref&&!protectedIds.has(ref)){protectedIds.add(ref);changed=true}}
  const moves=[];for(const s of rows.filter(s=>removed.has(s.id))){moves.push(s.id+'.json');try{await fs.access(path.join(root,'versions',s.id));moves.push(path.join('versions',s.id))}catch{}}
  for(const {type,id,j} of jobs)if(removed.has(j.storyId)&&!protectedIds.has(id))moves.push(path.join(type,id));
  const prior=await store.index(),index={...prior,aliases:{...prior.aliases},archives:{...prior.archives}};
  for(const g of groups)for(const s of g.remove){index.aliases[s.id]=g.keep.id;index.archives[s.id]=path.join(dest,'removed');}
  for(const [id,target] of Object.entries(index.aliases))if(index.aliases[target])index.aliases[id]=index.aliases[target];
  const manifest={id:randomUUID(),createdAt:new Date().toISOString(),root,archive:dest,groups:groups.map(g=>({roomSize:g.keep.roomSize||6,title:g.keep.title.trim(),keep:g.keep.id,validVideo:g.validVideo,remove:g.remove.map(s=>s.id)})),protectedJobs:jobs.filter(x=>protectedIds.has(x.id)).map(({id,type,j})=>({id,type,status:j.status})),moves,status:'backing_up'};
  await fs.mkdir(dest,{recursive:false});
  const write=()=>fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2));await write();
  // Full recoverable snapshot of affected story data, never provider configuration.
  for(const rel of moves)await fs.cp(path.join(root,rel),path.join(dest,'backup',rel),{recursive:true,errorOnExist:true});
  await fs.writeFile(path.join(dest,'previous-index.json'),JSON.stringify(prior,null,2));
  manifest.status='backed_up';await write();
  // Persist lookup before moves so in-flight historical version requests remain readable.
  await store.writeIndex(index);
  for(const rel of moves){const to=path.join(dest,'removed',rel);await fs.mkdir(path.dirname(to),{recursive:true});await fs.rename(path.join(root,rel),to)}
  manifest.status='complete';await write();return manifest;
}
async function restoreArchive(store,archiveRoot){
  const dest=path.resolve(archiveRoot),manifest=JSON.parse(await fs.readFile(path.join(dest,'manifest.json'),'utf8'));
  if(path.resolve(store.root).toLowerCase()!==path.resolve(manifest.root).toLowerCase()||manifest.status!=='complete')throw Error('备份不属于当前数据目录，或清理未完成');
  const prior=JSON.parse(await fs.readFile(path.join(dest,'previous-index.json'),'utf8')),index=await store.index();
  for(const rel of manifest.moves){
    const target=path.resolve(store.root,rel);
    if(!target.toLowerCase().startsWith((path.resolve(store.root)+path.sep).toLowerCase()))throw Error('备份路径无效');
    try{await fs.access(target);throw Error('活动数据已存在，停止恢复以免覆盖：'+rel)}catch(e){if(e.code!=='ENOENT')throw e}
    await fs.access(path.join(dest,'backup',rel));
  }
  // Restore copies, leaving both the original snapshot and archive intact.
  for(const rel of manifest.moves){const target=path.join(store.root,rel);await fs.mkdir(path.dirname(target),{recursive:true});await fs.cp(path.join(dest,'backup',rel),target,{recursive:true,errorOnExist:true,force:false})}
  for(const g of manifest.groups)for(const id of g.remove){if(prior.aliases?.[id])index.aliases[id]=prior.aliases[id];else delete index.aliases[id];if(prior.archives?.[id])index.archives[id]=prior.archives[id];else delete index.archives[id]}
  await store.writeIndex(index);manifest.status='restored';manifest.restoredAt=new Date().toISOString();await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2));return manifest;
}
module.exports={key,groupStories,validVideo,archiveDuplicates,restoreArchive};
