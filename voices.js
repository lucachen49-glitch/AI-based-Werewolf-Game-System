(function(root,factory){const value=factory();if(typeof module==='object'&&module.exports)module.exports=value;else root.NightfallVoices=value})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const voices=[
    {id:'zh-CN-YunxiNeural',name:'云希 · 清朗男声'},
    {id:'zh-CN-XiaoxiaoNeural',name:'晓晓 · 温暖女声'},
    {id:'zh-CN-XiaoyiNeural',name:'晓伊 · 轻柔女声'},
    {id:'zh-CN-YunjianNeural',name:'云健 · 浑厚男声'},
    {id:'zh-CN-YunyangNeural',name:'云扬 · 稳重男声'},
    {id:'zh-CN-YunxiaNeural',name:'云夏 · 年轻男声'},
    {id:'zh-TW-HsiaoChenNeural',name:'晓臻 · 台湾女声'},
    {id:'zh-TW-YunJheNeural',name:'云哲 · 台湾男声'},
    {id:'zh-TW-HsiaoYuNeural',name:'晓雨 · 台湾女声'},
    {id:'zh-HK-HiuGaaiNeural',name:'晓佳 · 粤语女声'},
    {id:'zh-HK-HiuMaanNeural',name:'晓曼 · 粤语女声'},
    {id:'zh-HK-WanLungNeural',name:'云龙 · 粤语男声'},
    {id:'en-US-GuyNeural',name:'Guy · 英语旁白男声'}
  ];
  const styles={
    auto:{name:'随发言变化',instruction:'根据这句台词的语义自然变化语气，不要夸张表演。',rate:0,pitch:0},
    calm:{name:'冷静分析',instruction:'冷静、从容地分析，留出思考停顿，像面对面讨论。',rate:-7,pitch:-1},
    cheerful:{name:'轻松活泼',instruction:'轻松、明快，有一点笑意，像和朋友玩桌游。',rate:5,pitch:2},
    suspicious:{name:'怀疑追问',instruction:'带着疑问和审慎追问，重点词略加重，但不要愤怒。',rate:-3,pitch:0},
    firm:{name:'坚定反驳',instruction:'有把握、坚定地表达观点，适当强调，避免喊叫。',rate:3,pitch:-1},
    anxious:{name:'紧张辩解',instruction:'稍显紧张、急于解释，保留自然的停顿和呼吸，不要戏剧化。',rate:8,pitch:1},
    sad:{name:'低落遗憾',instruction:'低落、遗憾，语速略慢，克制地表达失望。',rate:-10,pitch:-2}
  };
  const providers={neural:'自然中文音色',api:'情感语音接口',system:'系统基础朗读'};
  function defaults(seat=0){return {voiceProvider:'neural',voice:voices[seat%voices.length].id,voiceStyle:'auto',voiceSpeed:1,voiceEndpoint:'',voiceModel:'',voiceApiVoice:'coral',voiceKey:'',rememberVoiceKey:true}}
  function settings(profile={},seat=0){const d=defaults(seat);return {...d,...profile,voiceProvider:Object.hasOwn(providers,profile.voiceProvider)?profile.voiceProvider:d.voiceProvider,voice:voices.some(v=>v.id===profile.voice)?profile.voice:d.voice,voiceStyle:Object.hasOwn(styles,profile.voiceStyle)?profile.voiceStyle:'auto',voiceSpeed:[.85,1,1.15].includes(Number(profile.voiceSpeed))?Number(profile.voiceSpeed):1}}
  function emotion(text,hint){
    if(hint&&hint!=='auto'&&Object.hasOwn(styles,hint))return hint;
    if(/别投我|不是狼|冤枉|听我解释|救命/.test(text))return 'anxious';
    if(/遗憾|可惜|抱歉|对不起/.test(text))return 'sad';
    if(/哈哈|开心|谢谢|太好了|漂亮/.test(text))return 'cheerful';
    if(/[？?]|为什么|追问|矛盾|怀疑/.test(text))return 'suspicious';
    if(/确定|负责|反对|不同意|坚持|绝对/.test(text))return 'firm';
    return 'calm';
  }
  function prosody(style,speed=1,voice=''){
    const s=styles[style]||styles.calm;
    // Keep each voice's timbre: restrained prosody, never a character-changing pitch shift.
    const bias=/Yunjian|Yunyang/.test(voice)?-2:/Xiaoyi/.test(voice)?-1:0;
    const n=Math.max(-25,Math.min(25,Math.round((speed-1)*100+s.rate*.65+bias)));
    const pitch=Math.max(-2,Math.min(2,Math.round(s.pitch*.5)));
    return {rate:(n>=0?'+':'')+n+'%',pitch:(pitch>=0?'+':'')+pitch+'Hz'};
  }
  function spokenText(text){return String(text).replace(/([，。！？；：、])\1+/g,'$1').replace(/\.{3,}|…+/g,'……').replace(/([。！？])(?=\S)/g,'$1 ').trim()}
  function label(profile,seat=0){const p=settings(profile,seat);return p.voiceProvider==='neural'?voices.find(v=>v.id===p.voice).name:p.voiceProvider==='api'?'情感音色 · '+(p.voiceApiVoice||'未填写'):providers.system}
  return {voices,styles,providers,defaults,settings,emotion,prosody,spokenText,label};
});
