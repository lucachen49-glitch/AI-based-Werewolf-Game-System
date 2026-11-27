(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NightfallAudio=api})(globalThis,function(){
  'use strict';
  const names=['shuffle','deal','flip','night','wolf','guard','seer','save','poison','vote','exile','hunter','good-win','wolf-win'];
  const source=name=>'assets/sfx/'+name+'-bell-v1.wav';
  const musicTracks={manor:'assets/music/manor-nocturne.ogg',snow:'assets/music/snow-arrival.ogg',candle:'assets/music/candle-intrigue.ogg',night:'assets/music/bloodmoon-night.ogg',vote:'assets/music/verdict-pulse.ogg',dawn:'assets/music/dawn-accord.ogg'};
  // Only public setting, current picture and public phase affect music, never roles or targets.
  function storyMusic({size=6,story,phase='lobby',scene}={}){
    if(!story||(story.roomSize||6)!==size)return 'manor';
    const setting=String(story.title||'')+' '+String(story.background||'');
    if(scene!==undefined){
      const text=String(scene);
      if(/失踪|断裂|危机|退路|袭击|missing|broken|danger/i.test(text))return 'night';
      if(/雪|风暴|吊桥|室外|snow|storm|exterior/i.test(text))return 'snow';
      return 'candle';
    }
    if(phase==='night')return 'night';
    if(phase==='voting'||phase==='hunter')return 'vote';
    if(phase==='ended')return 'dawn';
    if(phase==='lobby'&&/雪|北境|snow|storm/i.test(setting))return 'snow';
    return 'candle';
  }
  function create({AudioImpl=globalThis.Audio,isSpeaking=()=>false,save=()=>{}}={}){
    let enabled=true,volume=.3,unlocked=false,paused=false,timer=null;const active=new Set(),seen=new Set();
    const sync=()=>{for(const a of active)a.volume=volume*(isSpeaking() ? .28 : 1)};
    const finish=a=>{active.delete(a);a.onended=a.onerror=null;if(!active.size){clearInterval(timer);timer=null}};
    const stop=()=>{for(const a of [...active]){try{a.pause();a.src=''}catch{}finish(a)}};
    return {
      configure(p={}){enabled=p.enabled!==false;const n=Number(p.volume);volume=Number.isFinite(n)?Math.max(0,Math.min(1,n)):.3;if(!enabled)stop();sync()},
      preferences(){return {enabled,volume}},
      unlock(){unlocked=true},
      play(name,id){if(!enabled||!unlocked||paused||!AudioImpl||!names.includes(name)||id&&seen.has(id))return false;if(id)seen.add(id);let a;try{a=new AudioImpl(source(name));active.add(a);a.onended=a.onerror=()=>finish(a);sync();a.play()?.catch(()=>finish(a));if(active.size&&!timer)timer=setInterval(sync,120);return true}catch{if(a)finish(a);return false}},
      pause(value){paused=!!value;for(const a of active)try{if(paused)a.pause();else a.play()?.catch(()=>finish(a))}catch{finish(a)}},
      stop,
      reset(){stop();seen.clear();paused=false},
      toggle(){enabled=!enabled;if(!enabled)stop();save({enabled,volume});return enabled},
      setVolume(value){const n=Number(value);if(Number.isFinite(n))volume=Math.max(0,Math.min(1,n));sync();save({enabled,volume})},
      sync
    };
  }
  // Stable loops across renders, with a two-second crossfade when public scenes change.
  function createMusic({AudioImpl=globalThis.Audio,isSpeaking=()=>false,save=()=>{},schedule=setInterval,cancel=clearInterval}={}){
    let enabled=true,volume=.15,unlocked=false,wanted=false,paused=false,current=null,timer=null,failed=false,track='manor';
    const retiring=new Set();
    const preferences=()=>({enabled,volume});
    const release=r=>{r.audio.onerror=r.audio.onplaying=null;try{r.audio.pause();r.audio.src=''}catch{}retiring.delete(r)};
    const sync=()=>{
      if(paused)return;
      if(current?.ready){current.gain=Math.min(1,current.gain+.04);for(const r of [...retiring]){r.gain=Math.max(0,r.gain-.04);if(!r.gain)release(r)}}
      const target=volume*(isSpeaking()?.22:1);
      for(const r of [current,...retiring])if(r){const goal=target*r.gain;r.audio.volume=Math.abs(goal-r.audio.volume)<.002?goal:r.audio.volume+(goal-r.audio.volume)*.22}
    };
    const clearTimer=()=>{if(timer!==null)cancel(timer);timer=null};
    const dispose=()=>{clearTimer();const old=current;current=null;if(old)release(old);for(const r of [...retiring])release(r)};
    const fail=r=>{if(current!==r){if(retiring.has(r))release(r);return}failed=true;release(r);current=[...retiring].at(-1)||null;if(current){retiring.delete(current);current.gain=1}else clearTimer()};
    const play=r=>{try{r.audio.play()?.then(()=>{if(current===r)r.ready=true}).catch(()=>fail(r))}catch{fail(r)}};
    const resume=()=>{
      if(!enabled||!unlocked||!wanted||paused||failed||!AudioImpl)return;
      try{
        if(!current||current.track!==track){
          const audio=new AudioImpl(musicTracks[track]),r={audio,track,gain:current?0:1,ready:false};
          for(const old of [...retiring])release(old);
          if(current)retiring.add(current);current=r;
          audio.loop=true;audio.volume=0;audio.preload='auto';audio.onerror=()=>fail(r);audio.onplaying=()=>{if(current===r)r.ready=true};
        }
        for(const r of [current,...retiring])if(r?.audio.paused!==false)play(r);
        if(current&&timer===null)timer=schedule(sync,80);
      }catch{failed=true;if(!current)dispose()}
    };
    return {
      configure(p={}){enabled=p.enabled!==false;const n=Number(p.volume);volume=Number.isFinite(n)?Math.max(0,Math.min(1,n)):.15;if(!enabled)dispose()},
      preferences,
      unlock(){unlocked=true;failed=false},
      start(){wanted=true;resume()},
      setTrack(value){const next=Object.hasOwn(musicTracks,value)?value:'manor';if(next===track)return;track=next;failed=false;resume()},
      currentTrack(){return current?.track||track},
      pause(value){paused=!!value;if(paused){clearTimer();for(const r of [current,...retiring])try{r?.audio.pause()}catch{}}else resume()},
      stop(){wanted=false;paused=false;failed=false;dispose()},
      toggle(){enabled=!enabled;if(enabled){failed=false;resume()}else dispose();save(preferences());return enabled},
      setVolume(value){const n=Number(value);if(Number.isFinite(n))volume=Math.max(0,Math.min(1,n));if(volume===0)for(const r of [current,...retiring])if(r)r.audio.volume=0;save(preferences())},
      sync
    };
  }
  return {names,source,create,createMusic,musicTracks,storyMusic};
});
