'use strict';
let introJobs=[],introSourceId='',introJob=null,introPoll=null,introNavigation=0,introWatched=new Set(),introLastTime=null;
function placeIntroPanel(){const panel=document.querySelector('.intro-panel'),videoSection=document.getElementById('videoHistory')?.closest('section');if(panel&&videoSection){videoSection.after(panel);panel.querySelector('h2').textContent='05 / 成片人物登场介绍';panel.querySelector(':scope > p').textContent='先完成并预览基础视频，再选择实际成片标记人物首次登场。姓名与公开剧情身份会在本地合成为独立副本，不重新调用 Grok；原始成片保留。';const sourceLabel=document.getElementById('introSource').closest('label');if(sourceLabel?.firstChild)sourceLabel.firstChild.textContent='选择已完成成片 ';document.getElementById('createIntroCopy').textContent='合成带姓名条的本地副本';}}
function introBase(d=rawDraft()){
  const source=introJobs.find(x=>x.id===introSourceId);
  return source?{...d,scenes:source.scenes.map(x=>({duration:x.duration||10,cast:x.cast||[],description:x.description||'',startFrame:'',endFrame:''}))}:d;
}
function introRead(){
  return {enabled:$('introEnabled').checked,confirmed:$('introConfirm').checked,confirmation:$('introConfirm').dataset.signature||'',markers:Array.from($('introMarkers').querySelectorAll('[data-intro-row]'),row=>Object.fromEntries(['seat','scene','start','duration','position'].map(key=>{const el=row.querySelector('[data-intro="'+key+'"]');return [key,key==='position'?el.value:Number(el.value)]})))};
}
function introRows(plan,d){
  $('introEnabled').checked=plan?.enabled===true;$('introConfirm').checked=plan?.confirmed===true;$('introConfirm').dataset.signature=plan?.confirmation||'';
  $('introMarkers').innerHTML=(plan?.markers||[]).map((m,i)=>`<div class="intro-row" data-intro-row="${i}"><label>人物<select data-intro="seat">${d.characters.map(c=>`<option value="${c.seat}" ${c.seat===m.seat?'selected':''}>${c.seat} · ${esc(c.name)}</option>`).join('')}</select></label><label>镜头<select data-intro="scene">${d.scenes.map((x,j)=>`<option value="${j}" ${j===m.scene?'selected':''}>镜头 ${j+1} / ${x.duration||10}s</option>`).join('')}</select></label><label>开始秒<input data-intro="start" type="number" min="0" step="0.1" value="${m.start}"></label><label>持续秒<input data-intro="duration" type="number" min="1" max="10" step="0.1" value="${m.duration}"></label><label>位置<select data-intro="position"><option value="left">左下</option><option value="right" ${m.position==='right'?'selected':''}>右下</option></select></label><button type="button" data-intro-delete="${i}">删除</button></div>`).join('');
}
function introUpdate(){
  if(!$('introEnabled'))return;
  if(restoring||renderedDraft&&(renderedDraft.roomSize||6)!==roomSize){$('createIntroCopy').disabled=true;return;}
  const d=introBase(),plan=introRead();d.introductions=plan;
  const issues=NightfallIntros.issues(d,plan,{requireConfirmed:false});$('introIssues').textContent=issues.length?issues.join('\n'):'介绍时间检查通过。仍需对照画面核对首次登场、人物对应和字幕位置。';
  if(plan.confirmation!==NightfallIntros.signature(d,plan))$('introConfirm').checked=false;
  const hasSource=!!introSourceId&&introJobs.some(x=>x.id===introSourceId);$('introEnabled').disabled=!hasSource;$('suggestIntros').disabled=!hasSource;$('addIntro').disabled=!hasSource;$('introMarkers').inert=!hasSource;
  $('introConfirm').disabled=!hasSource||!!issues.length||!plan.enabled;
  const duration=d.scenes.reduce((n,x)=>n+(x.duration||10),0);$('introScrub').max=duration;
  const time=Number($('introScrub').value)||0;introPaint(d,time);
  $('createIntroCopy').disabled=loading||restoring||restoreBlocked||!workshopReady||!current||!hasSource||!plan.enabled||issues.length>0||!$('introConfirm').checked;
}
function introPaint(d,time){
  $('introClock').textContent=time.toFixed(1)+' 秒';const m=NightfallIntros.at(d,time,introRead()),plate=$('introNameplate');plate.hidden=!m;if(m){plate.classList.toggle('right',m.position==='right');plate.style.opacity=String(Math.min(1,(time-m.absoluteStart)/.3,(m.absoluteStart+m.duration-time)/.45));$('introName').textContent=m.name;$('introIdentity').textContent=m.publicIdentity}
  const v=$('introMovie');if(!introSourceId){v.removeAttribute('poster');v.setAttribute('aria-label','生成视频后选择成片，按真实画面设置人物介绍');}
}
function introDirty(){dirty=true;$('introConfirm').checked=false;introUpdate();updateButtons();persistWorkshop()}
async function introRefreshSources(selectId=''){
  const storyId=current?.id;if(!storyId)return;const navigation=introNavigation;let movies;try{movies=await api('/api/video-jobs?storyId='+storyId)}catch(e){$('introCopyMessage').textContent='成片列表暂未刷新，可稍后重新载入工坊：'+e.message;return}if(navigation!==introNavigation||current?.id!==storyId)return;
  const prior=introSourceId;introJobs=movies.filter(x=>['ready','accepted'].includes(x.status));$('introSource').innerHTML='<option value="">先生成视频，再选择成片</option>'+introJobs.map(j=>`<option value="${j.id}">成片 · v${j.version} · ${j.targetDuration}s${j.status==='accepted'?' · 已采用':''}</option>`).join('');
  introSourceId=introJobs.some(x=>x.id===selectId)?selectId:introJobs.some(x=>x.id===prior)?prior:'';$('introSource').value=introSourceId;const source=introJobs.find(x=>x.id===introSourceId);$('introMovie').src=source?.url||'';
  if(selectId&&selectId!==prior){const d=rawDraft();introRows(NightfallIntros.suggest(introBase(d)),introBase(d));introDirty()}else introUpdate();
}
async function introRender(d){
  clearTimeout(introPoll);introJob=null;introJobs=[];introSourceId=d.introSourceId||'';introRows(d.introductions,d);$('introSource').innerHTML='<option value="">先生成视频，再选择成片</option>';$('introMovie').removeAttribute('src');$('introCopyMessage').textContent='先生成视频，再按实际画面设置姓名条；此步骤只做本地合成。';$('acceptIntroCopy').disabled=true;
  const navigation=++introNavigation;introUpdate();if(!current)return;
  try{const [movies,copies]=await Promise.all([api('/api/video-jobs?storyId='+current.id),api('/api/story-title-jobs?storyId='+current.id)]);if(navigation!==introNavigation)return;
    introJobs=movies.filter(x=>['ready','accepted'].includes(x.status));$('introSource').innerHTML='<option value="">先生成视频，再选择成片</option>'+introJobs.map(j=>`<option value="${j.id}">成片 · v${j.version} · ${j.targetDuration}s${j.status==='accepted'?' · 已采用':''}</option>`).join('');
    if(introJobs.some(x=>x.id===introSourceId))$('introSource').value=introSourceId;else introSourceId='';
    if(introSourceId)$('introMovie').src=introJobs.find(x=>x.id===introSourceId).url;
    introRows(d.introductions,introBase(d));if(copies[0])introShowJob(copies[0]);introUpdate();
  }catch(e){if(navigation===introNavigation)$('introCopyMessage').textContent='副本记录读取失败：'+e.message}
}
function introShowJob(j){
  introJob=j;$('introCopyMessage').textContent=j.message;$('resumeIntroCopy').hidden=j.status!=='paused';$('acceptIntroCopy').disabled=true;
  if(j.url){const video=$('introCopyVideo');if(video.dataset.job!==j.id){video.dataset.job=j.id;video.src=j.url;introWatched.clear();introLastTime=null}video.hidden=false;$('downloadIntroCopy').href=j.url;$('downloadIntroCopy').hidden=false}
  if(j.status==='running'){clearTimeout(introPoll);const navigation=introNavigation;introPoll=setTimeout(async()=>{try{const latest=await api('/api/story-title-jobs/'+j.id);if(navigation===introNavigation)introShowJob(latest)}catch(e){if(navigation===introNavigation){$('introCopyMessage').textContent='查询中断：'+e.message;$('resumeIntroCopy').hidden=false}}},1500)}
}
function initCharacterIntros(){
  placeIntroPanel();
  $('introSource').onchange=()=>{introSourceId=$('introSource').value;const source=introJobs.find(j=>j.id===introSourceId);$('introMovie').src=source?.url||'';$('introConfirm').checked=false;if(source)introRows(NightfallIntros.suggest(introBase()),introBase());else introRows({enabled:false,confirmed:false,markers:[]},rawDraft());introDirty()};
  $('suggestIntros').onclick=()=>{introRows(NightfallIntros.suggest(introBase()),introBase());introDirty()};
  $('addIntro').onclick=()=>{const d=introBase(),p=introRead();p.markers.push({seat:1,scene:0,start:.5,duration:3,position:'left'});introRows(p,d);introDirty()};
  $('introMarkers').oninput=introDirty;$('introMarkers').onclick=e=>{const button=e.target.closest('[data-intro-delete]');if(!button)return;const p=introRead();p.markers.splice(Number(button.dataset.introDelete),1);introRows(p,introBase());introDirty()};
  $('introEnabled').onchange=introDirty;
  $('introConfirm').onchange=()=>{const d=introBase(),p=introRead();$('introConfirm').dataset.signature=$('introConfirm').checked?NightfallIntros.signature(d,p):'';dirty=true;introUpdate();updateButtons();persistWorkshop()};
  $('introScrub').oninput=()=>{const t=Number($('introScrub').value),v=$('introMovie');if(v.src&&Number.isFinite(v.duration))v.currentTime=Math.min(v.duration,t);introPaint(introBase(),t)};
  $('introMovie').ontimeupdate=()=>{const t=$('introMovie').currentTime;$('introScrub').value=t;introPaint(introBase(),t)};
  $('createIntroCopy').onclick=guard(async()=>{if(!current||!introSourceId)return;const d=introBase(),p=introRead();const issues=NightfallIntros.issues(d,p);if(issues.length)throw Error(issues.join('；'));$('introCopyMessage').textContent='正在创建本地合成任务，原成片保留…';const j=await api('/api/story-title-jobs',{storyId:current.id,version:current.version,sourceJobId:introSourceId,characters:d.characters.map(({seat,name,publicIdentity})=>({seat,name,publicIdentity})),introductions:p,visualConfirmed:true});introShowJob(j)});
  $('resumeIntroCopy').onclick=guard(async()=>{if(introJob)introShowJob(await api('/api/story-title-jobs/'+introJob.id,{action:'resume'}))});
  const v=$('introCopyVideo');v.addEventListener('timeupdate',()=>{const t=v.currentTime;if(!v.seeking&&!v.paused&&introLastTime!==null&&t>=introLastTime&&t-introLastTime<1.2)for(let n=Math.floor(introLastTime*4);n<=Math.floor(t*4);n++)introWatched.add(n);introLastTime=t;const watched=Number.isFinite(v.duration)&&introWatched.size>=Math.floor(v.duration*4)*.97;$('acceptIntroCopy').disabled=!watched});v.addEventListener('seeking',()=>introLastTime=null);v.addEventListener('play',()=>introLastTime=v.currentTime);
  $('acceptIntroCopy').onclick=guard(async()=>{if(!introJob||$('acceptIntroCopy').disabled)return;if(!confirm('已完整观看，并核对所有姓名与人物对应、字幕避让、声音及片长？采用后将更换游戏开场，原片仍保留。'))return;introShowJob(await api('/api/story-title-jobs/'+introJob.id,{action:'accept',watched:true,visualConfirmed:true}));notice('已采用带人物介绍的独立副本，原视频仍保留。')});
}
