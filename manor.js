(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NightfallManor=api})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const portraits=Object.freeze([
    {id:'portrait-01',name:'绯发来客',description:'赤褐长发 · 黑色蕾丝'},
    {id:'portrait-02',name:'沉静绅士',description:'棕发 · 酒红领巾'},
    {id:'portrait-03',name:'夜色旅人',description:'黑发 · 深蓝礼服'},
    {id:'portrait-04',name:'晚宴宾客',description:'栗色卷发 · 酒红长裙'},
    {id:'portrait-05',name:'银发访客',description:'银发 · 黑色丝绒'},
    {id:'portrait-06',name:'月光来客',description:'金色长发 · 象牙领口'},
    {id:'portrait-07',name:'铜钟匠人',description:'棕卷发 · 铜色礼服'},
    {id:'portrait-08',name:'青藤信使',description:'黑色盘发 · 墨绿长裙'},
    {id:'portrait-09',name:'赤枫向导',description:'赤色短发 · 灰金外套'},
    {id:'portrait-10',name:'霜蓝画师',description:'银白短发 · 藏蓝礼裙'},
    {id:'portrait-11',name:'暮紫来客',description:'金棕发 · 深紫礼服'},
    {id:'portrait-12',name:'烛铜学徒',description:'深棕直发 · 青铜长裙'}
  ]);
  const seats=Object.freeze([{x:23,y:2,front:false},{x:50,y:0,front:false},{x:77,y:2,front:false},{x:82,y:46,front:true},{x:50,y:51,front:true},{x:18,y:46,front:true}]);
  // Two broad arcs with separate face/nameplate lanes, not the six-seat coordinates.
  const twelveSeats=Object.freeze([{x:9,y:3},{x:25.4,y:0},{x:41.8,y:0},{x:58.2,y:0},{x:74.6,y:0},{x:91,y:3},{x:91,y:52,front:true},{x:74.6,y:55,front:true},{x:58.2,y:55,front:true},{x:41.8,y:55,front:true},{x:25.4,y:55,front:true},{x:9,y:52,front:true}]);
  const layout=size=>size===12?twelveSeats:seats;
  const defaultId=seat=>'portrait-'+String(((seat%12)+12)%12+1).padStart(2,'0');
  // Coordinates relative to the complete transparent portrait, including its chair.
  const mouths=Object.freeze({'portrait-01':{x:.503,y:.183},'portrait-02':{x:.495,y:.190},'portrait-03':{x:.515,y:.195},'portrait-04':{x:.490,y:.195},'portrait-05':{x:.520,y:.197},'portrait-06':{x:.500,y:.187},'portrait-07':{x:0.5031,y:0.1889},'portrait-08':{x:0.4788,y:0.1983},'portrait-09':{x:0.4997,y:0.1983},'portrait-10':{x:0.4903,y:0.1833},'portrait-11':{x:0.508,y:0.1978},'portrait-12':{x:0.492,y:0.1833}});
  function normalize(value,seat=0){return value==='avatar'||portraits.some(p=>p.id===value)?value:defaultId(seat)}
  function portrait(profile,seat=0,size=6){const id=normalize(profile?.manorPortrait,seat);return [6,12].includes(size)&&id!=='avatar'?(portraits.find(p=>p.id===id&&!p.pending)||null):null}
  function imagePath(id,thumbnail=false){return portraits.some(p=>p.id===id&&!p.pending)?'assets/manor/'+id+(thumbnail?'-thumb':'')+'.webp':null}
  const voicePairs=Object.freeze([
    {voice:'zh-CN-XiaoxiaoNeural',description:'绯发来客 · 温暖而有主见的女声'},
    {voice:'zh-CN-YunyangNeural',description:'沉静绅士 · 沉稳从容的男声'},
    {voice:'zh-CN-YunxiNeural',description:'夜色旅人 · 清朗克制的男声'},
    {voice:'zh-CN-XiaoyiNeural',description:'晚宴宾客 · 轻柔细腻的女声'},
    {voice:'zh-CN-YunjianNeural',description:'银发访客 · 低沉浑厚的男声'},
    {voice:'zh-TW-HsiaoChenNeural',description:'月光来客 · 明亮柔和的女声（台湾口音）'},
    {voice:'zh-CN-YunyangNeural',description:'铜钟匠人 · 沉着男声'},
    {voice:'zh-CN-XiaoyiNeural',description:'青藤信使 · 清晰女声'},
    {voice:'zh-CN-YunjianNeural',description:'赤枫向导 · 坚定男声'},
    {voice:'zh-CN-XiaoxiaoNeural',description:'霜蓝画师 · 温和女声'},
    {voice:'zh-CN-YunxiNeural',description:'暮紫来客 · 克制男声'},
    {voice:'zh-TW-HsiaoChenNeural',description:'烛铜学徒 · 明亮女声'}
  ]);
  function voiceMatchMode(profile={},seat=0,defaults={}){
    if(['portrait','custom'].includes(profile.voiceMatch))return profile.voiceMatch;
    return ['voiceProvider','voice','voiceStyle','voiceSpeed'].some(k=>profile[k]!=null&&profile[k]!==defaults[k])||profile.voiceEndpoint||profile.voiceModel||profile.voiceKey?'custom':'portrait';
  }
  function recommendedVoice(profile,seat=0,size=6){const art=portraits.find(p=>p.id===normalize(profile?.manorPortrait,seat));return [6,12].includes(size)&&art?voicePairs[portraits.indexOf(art)]:null}
  return {portraits,seats,twelveSeats,layout,defaultId,mouths,normalize,portrait,imagePath,voicePairs,voiceMatchMode,recommendedVoice};
});
