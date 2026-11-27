'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { createVideoConfigStore } = require('../video-config.cjs');
const artDir = path.join(
  process.env.LOCALAPPDATA,
  'NightfallWerewolf',
  'stories',
  'art',
  '7d70a7c0-fd7f-45dd-97c7-4171c7b5d115',
);
const out = path.join(process.cwd(), 'output', 'reference-video-test-20261121');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  await fs.mkdir(out, { recursive: true });
  const statusFile = path.join(out, 'status-2.json');
  try {
    await fs.access(statusFile);
    console.log('已有测试记录，停止重复提交：' + statusFile);
    return;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const cred = await createVideoConfigStore().loadCredential();
  const data = async (file) =>
    'data:image/' +
    (file.endsWith('.webp') ? 'webp' : 'png') +
    ';base64,' +
    (await fs.readFile(file)).toString('base64');
  const frame = path.join(out, 'scene-1-last.png');
  const portrait = path.join(artDir, 'f3b278e0-bd45-49cc-9ede-9594960dcdf2.png');
  const room = path.join(process.cwd(), 'assets', 'manor', 'manor-room.webp');
  const body = {
    model: cred.model,
    prompt:
      'Continue immediately from the opening frame in the same candlelit manor hall as <IMAGE_2>. The woman from <IMAGE_1> lowers the sealed invitation slowly and looks toward the empty doorway. She says in English using <AUDIO_0>: "Then why were we invited?" Preserve her face, attire, the invitation, the man beside her, and the room layout. One continuous shot.',
    image: { url: await data(frame) },
    reference_images: [
      { url: await data(portrait) },
      { url: await data(room) },
      { url: await data(frame) },
    ],
    reference_audios: [{ voice_id: 'ara' }],
    duration: 3,
    aspect_ratio: '16:9',
    resolution: '720p',
    generate_audio: true,
  };
  const state = {
    status: 'submitting',
    startedAt: new Date().toISOString(),
    model: cred.model,
    duration: 3,
    images: ['现有分镜起始图', '薇拉人物定妆', '庄园场景', '分镜画面作为道具参考'],
    audio: 'ara',
    firstFrame: '第一镜实际末帧',
  };
  const save = () => fs.writeFile(statusFile, JSON.stringify(state, null, 2));
  await save();
  let response;
  try {
    response = await fetch(cred.provider + '/videos/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cred.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    state.status = 'unknown';
    state.message = '提交结果不明，停止重发';
    await save();
    console.log(JSON.stringify(state));
    return;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    state.status = 'failed';
    state.httpStatus = response.status;
    state.message = String(payload?.error?.message || payload?.message || '供应商未提供说明')
      .replaceAll(cred.apiKey, '[redacted]')
      .slice(0, 1000);
    await save();
    console.log(JSON.stringify(state));
    return;
  }
  if (typeof payload.request_id !== 'string' || !payload.request_id) {
    state.status = 'unknown';
    state.message = '未返回任务编号，停止重发';
    await save();
    console.log(JSON.stringify(state));
    return;
  }
  state.status = 'pending';
  state.requestId = payload.request_id;
  await save();
  console.log('任务已提交，编号 ' + state.requestId);
  for (let i = 0; i < 90; i++) {
    await wait(10000);
    let r;
    try {
      r = await fetch(cred.provider + '/videos/' + encodeURIComponent(state.requestId), {
        headers: { Authorization: 'Bearer ' + cred.apiKey },
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      continue;
    }
    const j = await r.json().catch(() => ({}));
    state.providerStatus = j.status || null;
    await save();
    if (j.status === 'failed') {
      state.status = 'failed';
      state.message = String(j.error?.message || j.message || '供应商报告失败').replaceAll(
        cred.apiKey,
        '[redacted]',
      );
      await save();
      console.log(JSON.stringify(state));
      return;
    }
    if (j.status === 'done') {
      const url = j.video?.url;
      if (!url) {
        state.status = 'unknown';
        state.message = '已完成但未提供下载地址';
        await save();
        console.log(JSON.stringify(state));
        return;
      }
      const resolved = new URL(url, cred.provider + '/');
      const same =
        resolved.origin === new URL(cred.provider).origin &&
        resolved.pathname === '/v1/videos/' + encodeURIComponent(state.requestId) + '/content';
      const v = await fetch(resolved, {
        headers: same ? { Authorization: 'Bearer ' + cred.apiKey } : {},
        signal: AbortSignal.timeout(120000),
        redirect: 'error',
      });
      if (!v.ok) {
        state.status = 'download_failed';
        await save();
        console.log(JSON.stringify(state));
        return;
      }
      const bytes = Buffer.from(await v.arrayBuffer());
      await fs.writeFile(path.join(out, 'scene-2.mp4'), bytes);
      state.status = 'done';
      state.bytes = bytes.length;
      await save();
      console.log(JSON.stringify(state));
      return;
    }
  }
  state.status = 'pending';
  state.message = '查询达到等待上限，保留编号';
  await save();
  console.log(JSON.stringify(state));
}
main().catch((e) => {
  console.error('测试无法继续：' + e.message);
  process.exitCode = 1;
});
