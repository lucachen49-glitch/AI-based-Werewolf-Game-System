'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {atomic,readAtomic,validId,StoryError,dataRoot}=require('./scenario-store.cjs');
const {mime}=require('./image-provider.cjs');
const {normalizeImage}=require('./story-art-jobs.cjs');
const KINDS=['character','scene','costume','prop'];
function createStoryReferences({root=path.join(dataRoot,'references'),normalize=normalizeImage}={}){
  const url=id=>'/api/story-assets/references/'+id+'/image';
  const summary=r=>({id:r.id,roomSize:r.roomSize,label:r.label,kind:r.kind,sha256:r.sha256,createdAt:r.createdAt,url:url(r.id)+'?roomSize='+r.roomSize});
  async function get(id,size){
    if(!validId(id))throw new StoryError(404,'REFERENCE_NOT_FOUND','参考素材不存在，请重新选择');
    let r;try{r=await readAtomic(path.join(root,id,'reference.json'))}catch(e){if(e.code==='ENOENT')throw new StoryError(404,'REFERENCE_NOT_FOUND','参考素材不存在，请重新选择');throw e}
    if(r.roomSize!==size)throw new StoryError(404,'REFERENCE_NOT_FOUND','参考素材与当前人数不匹配');
    return {...r,file:path.join(root,id,'image.png')};
  }
  async function saveGenerated({roomSize,label,kind,bytes}){
    if(![6,12].includes(roomSize)||!KINDS.includes(kind))throw new StoryError(400,'INVALID_REFERENCE','参考素材信息无效');
    mime(bytes);
    const id=randomUUID(),dir=path.join(root,id);await fs.mkdir(dir,{recursive:true});
    await normalize(bytes,path.join(dir,'image.png'),{kind:'frame'});
    const r={id,roomSize,label,kind,sha256:createHash('sha256').update(await fs.readFile(path.join(dir,'image.png'))).digest('hex'),createdAt:new Date().toISOString()};
    await atomic(path.join(dir,'reference.json'),r);return summary(r);
  }
  return {get,summary,saveGenerated,
    async list(size){
      if(![6,12].includes(size))throw new StoryError(400,'INVALID_ROOM_SIZE','请选择六人或十二人');
      let names;try{names=await fs.readdir(root)}catch(e){if(e.code==='ENOENT')return [];throw e}
      const records=await Promise.all(names.filter(validId).map(async id=>{try{return await readAtomic(path.join(root,id,'reference.json'))}catch(e){if(e.code==='ENOENT')return null;throw e}}));
      return records.filter(r=>r&&r.roomSize===size).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(summary);
    },
    async upload(body,signal){
      if(![6,12].includes(body?.roomSize)||!KINDS.includes(body.kind)||typeof body.label!=='string'||!body.label.trim()||body.label.length>80)throw new StoryError(400,'INVALID_REFERENCE','请填写参考素材名称、用途和人数');
      const match=/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.data||'');
      if(!match||match[1].length>12*1024*1024)throw new StoryError(400,'INVALID_REFERENCE_IMAGE','请选择不超过8MB的 PNG、JPEG 或 WebP 图片');
      const bytes=Buffer.from(match[1],'base64');if(bytes.length>8*1024*1024)throw new StoryError(400,'INVALID_REFERENCE_IMAGE','图片超过8MB');
      try{mime(bytes)}catch{throw new StoryError(400,'INVALID_REFERENCE_IMAGE','图片格式无法识别')}
      const id=randomUUID(),dir=path.join(root,id);await fs.mkdir(dir,{recursive:true});
      try{
        await normalize(bytes,path.join(dir,'image.png'),{kind:body.kind==='character'?'character':'frame',signal});
        const r={id,roomSize:body.roomSize,label:body.label.trim(),kind:body.kind,sha256:createHash('sha256').update(await fs.readFile(path.join(dir,'image.png'))).digest('hex'),createdAt:new Date().toISOString()};
        await atomic(path.join(dir,'reference.json'),r);return summary(r);
      }catch(e){await fs.rm(path.join(dir,'image.png'),{force:true});if(signal?.aborted)throw e;throw new StoryError(400,'REFERENCE_DECODE_FAILED','无法读取这张图片，请换用有效的 PNG、JPEG 或 WebP 文件')}
    }
  };
}
module.exports={createStoryReferences};
