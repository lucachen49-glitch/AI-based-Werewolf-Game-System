(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NightfallWorkshopState=api})(typeof globalThis==='object'?globalThis:this,()=>{
  'use strict';
  const KEY='nightfall-workshop-v2',fields=['roomSize','title','source','background','visualGuide','narrativeMode','language'],characterFields=['seat','name','publicIdentity','personality','relationships','secret','portraitId','appearance','voiceId','gender'],sceneFields=['description','narration','narrationTranslation','startFrame','endFrame','cast','duration','narrationSeconds','startSource','referenceFrames','referencePurposes','extraReferences','endFrameIndex'];
  const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
  function draft(value){if(!value||!Array.isArray(value.characters)||![6,12].includes(value.characters.length)||!Array.isArray(value.scenes)||!value.scenes.length)throw Error('草稿格式无效');if(![6,12].includes(value.roomSize||6)||value.characters.length!==(value.roomSize||6))throw Error('草稿人数不匹配');return {roomSize:value.roomSize||6,...pick(value,fields),confirmed:value.confirmed===true,characters:value.characters.map(c=>pick(c,characterFields)),scenes:value.scenes.map(s=>({...pick(s,sceneFields),...(Array.isArray(s.dialogues)?{dialogues:s.dialogues.slice(0,12).map(d=>pick(d,['seat','text','translation']))}:{})}))}}
  const baseDraft=draft;
  draft=function(value){const result=baseDraft(value),I=typeof module==='object'&&module.exports?require('./character-intros.js'):globalThis.NightfallIntros;if(value.introductions)result.introductions=I.clean(value.introductions);if(typeof value.introSourceId==='string'&&/^[a-f0-9-]{36}$/i.test(value.introSourceId))result.introSourceId=value.introSourceId;return result};
  function read(storage){const raw=storage.getItem(KEY);if(!raw)return {schema:1,lastKey:'',entries:{}};const data=JSON.parse(raw);if(data.schema!==1||!data.entries||typeof data.entries!=='object')throw Error('本地草稿格式无法读取，原记录仍保留');return data}
  const key=(id,version,roomSize=6)=>id?id+':'+version:roomSize===12?'new:12':'new';
  function latest(state,roomSize){
    const entries=state.entries||{},matches=entry=>entry&&(entry.draft?.roomSize||6)===roomSize;
    for(const k of [state.lastByRoom?.[roomSize],state.lastKey])if(matches(entries[k]))return entries[k];
    return Object.values(entries).filter(matches).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))[0];
  }
  function save(storage,state,entry){const k=key(entry.storyId,entry.version,entry.draft.roomSize||6),clean={storyId:entry.storyId||null,version:entry.version||null,dirty:!!entry.dirty,activeStep:Number.isInteger(entry.activeStep)&&entry.activeStep>=0&&entry.activeStep<6?entry.activeStep:0,draft:draft(entry.draft),artEdits:{},artId:entry.artId||null,videoId:entry.videoId||null,updatedAt:new Date().toISOString()};
    for(const [task,edits] of Object.entries(entry.artEdits||{})){clean.artEdits[task]={};for(const [field,text] of Object.entries(edits))if(/^(?:character-(?:[0-9]|1[01])|frame-(?:[0-9]|[1-5][0-9]))$/.test(field)&&typeof text==='string')clean.artEdits[task][field]=text}
    const preview=typeof module==='object'&&module.exports?require('./workshop-preview.js'):globalThis.NightfallPreview;
    clean.rehearsal=preview.clean(entry.rehearsal);
    const next={schema:1,lastKey:k,lastByRoom:{...state.lastByRoom,[clean.draft.roomSize]:k},entries:{...state.entries,[k]:clean}};storage.setItem(KEY,JSON.stringify(next));return next;
  }
  // Re-index references by the identity of the retained scene after an edit.
  function remapReferences(previous, scenes) {
    const positions = new Map(scenes.map((scene, index) => [scene, index]));
    const nextIndex = oldIndex => positions.get(previous[oldIndex]);
    scenes.forEach((scene, index) => {
      const purposes = scene.referencePurposes || {};
      scene.referenceFrames = (scene.referenceFrames || [])
        .map(nextIndex).filter(value => value !== undefined && value !== index);
      scene.referencePurposes = Object.fromEntries(Object.entries(purposes)
        .map(([oldIndex, purpose]) => [nextIndex(Number(oldIndex)), purpose])
        .filter(([value]) => value !== undefined && value !== index));
      scene.endFrameIndex = scene.endFrameIndex == null ? null : nextIndex(scene.endFrameIndex) ?? null;
      const oldIndex = previous.indexOf(scene);
      if (scene.startSource === 'previous' &&
          (index === 0 || oldIndex > 0 && scenes[index - 1] !== previous[oldIndex - 1])) {
        scene.startSource = 'frame';
      }
    });
    return scenes;
  }
  return {KEY,key,draft,read,save,latest,remapReferences};
});

