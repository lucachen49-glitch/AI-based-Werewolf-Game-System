'use strict';
let subtitleSource = '', subtitleCues = [], subtitleTimer = null, subtitleEpoch = 0;
function subtitleSave() {
  if (!subtitleSource) return;
  const values={cues:subtitleCues,titleZh:$('subtitleTitleZh').value,titleEn:$('subtitleTitleEn').value,hookZh:$('subtitleHookZh').value,hookEn:$('subtitleHookEn').value};
  try {localStorage.setItem('nightfall-subtitles-'+subtitleSource,JSON.stringify(values))} catch {}
}
function subtitleRender() {
  $('subtitleRows').innerHTML=subtitleCues.map((c,i)=>`<div class="subtitle-row"><strong>第 ${i+1} 句 · 镜头 ${Number.isInteger(c.scene)?c.scene+1:'自定'}</strong><label>开始秒数<input type="number" min="0" step="0.01" data-subtitle="${i}" data-part="start" value="${esc(c.start)}"></label><label>结束秒数<input type="number" min="0" step="0.01" data-subtitle="${i}" data-part="end" value="${esc(c.end)}"></label><label>中文字幕<textarea data-subtitle="${i}" data-part="zh" rows="2">${esc(c.zh)}</textarea></label><label>English<textarea data-subtitle="${i}" data-part="en" rows="2">${esc(c.en)}</textarea></label></div>`).join('');
}
async function subtitleShowCopies(id) {
  const copies=await api('/api/story-subtitles?sourceId='+encodeURIComponent(id));
  if(subtitleSource!==id)return;
  $('subtitleCopies').innerHTML=copies.map(c=>`<div class="job-scene"><span>${esc(c.message)}</span>${c.url?`<video controls playsinline preload="metadata" src="${esc(c.url)}"></video><a class="button-link" href="${esc(c.url)}" download="剧情视频-双语字幕.mp4">下载双语视频</a> <a class="button-link" href="${esc(c.srtUrl)}" download="双语字幕.srt">下载字幕文件</a>`:''}</div>`).join('');
  if(copies.some(c=>c.status==='running'))subtitleTimer=setTimeout(()=>subtitleShowCopies(id).catch(e=>{if(subtitleSource===id)$('subtitleMessage').textContent=e.message}),2500);
}
async function subtitleSetSource(j) {
  const panel=$('subtitlePanel');
  if(!j?.url){panel.hidden=true;subtitleSource='';subtitleEpoch++;clearTimeout(subtitleTimer);return}
  if(subtitleSource===j.id)return;
  clearTimeout(subtitleTimer);const epoch=++subtitleEpoch;subtitleSource=j.id;panel.hidden=false;$('subtitleMessage').textContent='正在读取字幕建议…';
  try {
    const result=await api('/api/story-subtitles/suggestions?sourceId='+encodeURIComponent(j.id));
    if(epoch!==subtitleEpoch||subtitleSource!==j.id)return;
    let saved;try{saved=JSON.parse(localStorage.getItem('nightfall-subtitles-'+j.id)||'null')}catch{}
    subtitleCues=Array.isArray(saved?.cues)?saved.cues:result.cues;
    for(const [id,key,fallback] of [['subtitleTitleZh','titleZh','血月停战宴'],['subtitleTitleEn','titleEn','The Blood Moon Truce'],['subtitleHookZh','hookZh','谁值得信任？'],['subtitleHookEn','hookEn','Who can you trust?']])$(id).value=saved?.[key]||fallback;
    subtitleRender();$('subtitleMessage').textContent=subtitleCues.length?'时间为按剧本估算的起点，请逐句对照实际视频调整。':'此任务没有可用的双语对白，请先在剧本中填写英文与中文译文。';
    await subtitleShowCopies(j.id);
  }catch(e){if(epoch===subtitleEpoch)$('subtitleMessage').textContent=e.message}
}
document.addEventListener('DOMContentLoaded',()=>{
  $('subtitlePanel').addEventListener('input',event=>{const el=event.target;if(el.dataset.subtitle!==undefined){const cue=subtitleCues[Number(el.dataset.subtitle)],key=el.dataset.part;if(cue)cue[key]=['start','end'].includes(key)?Number(el.value):el.value;}subtitleSave()});
  $('subtitleCreate').addEventListener('click',async()=>{if(!subtitleSource)return;const id=subtitleSource;try{$('subtitleCreate').disabled=true;subtitleSave();const result=await api('/api/story-subtitles',{sourceJobId:id,cues:subtitleCues,titleZh:$('subtitleTitleZh').value,titleEn:$('subtitleTitleEn').value,hookZh:$('subtitleHookZh').value,hookEn:$('subtitleHookEn').value});if(subtitleSource===id){$('subtitleMessage').textContent=result.message;await subtitleShowCopies(id)}}catch(e){if(subtitleSource===id)$('subtitleMessage').textContent=e.message}finally{$('subtitleCreate').disabled=false}});
});
