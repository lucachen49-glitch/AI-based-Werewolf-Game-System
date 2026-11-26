'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),F=require('./workshop-flow.js');

test('电影剧本使用五阶段 AI 核对流程',()=>{
  let steps=F.derive({mode:'continuity'});
  assert.deepEqual(steps.map(x=>x.label),['剧本编辑','AI 核对','人物与分镜','独立视频','预览采用']);
  assert.equal(steps[0].status,'active');assert.ok(steps.slice(1).every(x=>!x.accessible));
  steps=F.derive({mode:'continuity',storyReady:true});assert.equal(steps[1].status,'optional');assert.ok(steps[1].accessible);assert.ok(steps[2].accessible);
  steps=F.derive({mode:'continuity',storyReady:true,hasReview:true,reviewCurrent:true});assert.equal(steps[1].status,'optional');assert.ok(steps[2].accessible);
  steps=F.derive({mode:'continuity',storyReady:true,reviewReady:true,artReady:true,videoReady:true,previewed:true});assert.equal(steps[4].status,'acknowledge');
  steps=F.derive({mode:'continuity',storyReady:true,reviewReady:true,artReady:true,videoReady:true,adopted:true});assert.ok(steps.every(x=>x.status==='complete'));assert.equal(F.activeIndex(steps),4);
});

test('剧本发生变化时旧核对与制作成果保留但标记待确认',()=>{
  const steps=F.derive({mode:'continuity',hasStory:true,storyReady:false,hasReview:true,reviewCurrent:false,hasArt:true,hasVideo:true,hasAdopted:true});
  assert.equal(steps[0].status,'stale');assert.equal(steps[1].status,'stale');assert.equal(steps[2].status,'stale');assert.equal(steps[3].status,'stale');assert.equal(steps[4].status,'stale');
  assert.ok(steps.slice(1).every(x=>x.accessible));
});

test('六人和十二人电影剧本的 AI 核对可选',()=>{
  for(const mode of ['continuity','cinematic']){const steps=F.derive({mode,storyReady:true});assert.equal(steps[1].label,'AI 核对');assert.equal(steps[1].status,'optional');assert.ok(steps[2].accessible);assert.equal(F.activeIndex(steps),2)}
});

test('图片确认与全片预览采用显示待处理状态',()=>{
  let steps=F.derive({mode:'continuity',storyReady:true,reviewReady:true,hasArt:true,artConfirmPending:true});
  assert.equal(steps[2].status,'confirm');assert.ok(steps[2].accessible);
  steps=F.derive({mode:'continuity',storyReady:true,reviewReady:true,artReady:true,videoReady:true,previewed:true});assert.equal(steps[4].status,'acknowledge');
  steps=F.derive({mode:'continuity',storyReady:true,reviewReady:true,artReady:true,videoReady:true,previewed:true,previewConfirmed:true});assert.equal(steps[4].status,'ready');
});

test('已确认剧本修改后要求重新核对，旧版成果可返回查看',()=>{
  const steps=F.derive({mode:'continuity',hasStory:true,storyReady:false,hasReview:true,hasArt:true,hasVideo:true});
  assert.equal(steps[0].status,'stale');assert.equal(steps[1].status,'stale');assert.ok(steps[1].accessible);assert.ok(steps[2].accessible);assert.ok(steps[3].accessible);
});

test('旧版剧本只展示其实际需要的三个阶段',()=>{
  const steps=F.derive({mode:'legacy'});
  assert.deepEqual(steps.map(x=>x.label),['剧本编辑','正式视频','预览采用']);
  assert.deepEqual(steps.map(x=>x.accessible),[true,false,false]);
});

test('旧核对记录不会阻止流程进入人物与分镜',()=>{const steps=F.derive({mode:'cinematic',storyReady:true,hasReview:true,reviewCurrent:false});assert.equal(steps[1].status,'stale');assert.equal(F.activeIndex(steps),2)});
