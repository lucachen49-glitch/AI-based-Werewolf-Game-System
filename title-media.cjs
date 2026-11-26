'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const I=require('./character-intros.js');
function safe(s){return String(s).replace(/[{}\\\r\n]/g,' ').replace(/\s+/g,' ').trim()}
function stamp(n){n=Math.max(0,Math.round(n*100));return Math.floor(n/360000)+':'+String(Math.floor(n/6000)%60).padStart(2,'0')+':'+String(Math.floor(n/100)%60).padStart(2,'0')+'.'+String(n%100).padStart(2,'0')}
function ass(story){
  const rows=I.timeline(story).flatMap(m=>{const right=m.position==='right',x=right?1160:120,anchor=right?3:1,start=stamp(m.absoluteStart),end=stamp(m.absoluteStart+m.duration);return [
    `Dialogue: 0,${start},${end},Name,,0,0,0,,{\\an${anchor}\\pos(${x},535)\\fad(300,450)}${safe(m.name)}`,
    `Dialogue: 1,${start},${end},Identity,,0,0,0,,{\\an${anchor}\\pos(${x},574)\\fad(300,450)}${safe(m.publicIdentity)}`]});
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 2\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Name,Microsoft YaHei,36,&H00EDF5FF,&H00EDF5FF,&HBB0B0805,&H990B0805,0,0,0,0,100,100,3,0,1,1.4,1.5,1,80,80,160,1\nStyle: Identity,Microsoft YaHei,22,&H0083B7DF,&H0083B7DF,&HBB0B0805,&H990B0805,0,0,0,0,100,100,2,0,1,1.2,1,1,80,80,120,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${rows.join('\n')}\n`;
}
async function renderTitles(input,output,story,{signal,run,inspect}={}){
  const issues=I.issues(story);if(issues.length)throw Error(issues.join('；'));
  if(!story.introductions?.enabled){await fs.copyFile(input,output);return}
  if(!run||!inspect)({run,inspect}=require('./video-media.cjs'));
  const subtitle=path.join(path.dirname(output),'introductions.ass');await fs.writeFile(subtitle,ass(story),'utf8');
  const escaped=subtitle.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");
  await run(['-v','error','-y','-i',input,'-map','0:v:0','-map','0:a?','-vf',`subtitles=filename='${escaped}'`,'-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',output],600000,signal);
  const [a,b]=await Promise.all([inspect(input,signal),inspect(output,signal)]);if(!b.video||a.audio!==b.audio||Math.abs(a.duration-b.duration)>.1)throw Error('人物介绍副本的画面、声音或时长校验未通过');
}
module.exports={ass,safe,stamp,renderTitles};
