'use strict';
const {
  test,
  assert,
  vm,
  fs,
  os,
  path,
  Nightfall,
  APP_SCRIPTS,
  setup,
  voteStream,
  batchCompatibleFetch,
  installStory,
  until,
  prepareAuto,
  installSpeech,
  installRuleAudio,
  installNatural,
  speechPipeline,
  votingHarness,
  wolfHarness,
  agentConfigFetch,
  settle,
} = require('./test-support/app-harness.cjs');

test('实际语音与字幕完整播放，准备请求取消不停止音频且录屏对白按实际播放记录', async (t) => {
  const h = speechPipeline(t, { actors: [0, 1], realPlayback: true }),
    { context, read, chat } = h;
  const audios = installRuleAudio(context),
    speechRequests = [],
    recorded = [],
    finished = [],
    waits = [];
  context.URL = class extends URL {
    static createObjectURL() {
      return 'blob:pipeline-' + speechRequests.length;
    }
    static revokeObjectURL() {}
  };
  const agentFetch = context.fetch;
  context.fetch = async (url, options) => {
    if (url !== '/api/speech') return agentFetch(url, options);
    speechRequests.push(options);
    return { ok: true, blob: async () => ({ size: 512, type: 'audio/mpeg' }) };
  };
  context.recordingTranscriptBegin = (entry) => {
    recorded.push(entry);
    return String(recorded.length);
  };
  context.recordingTranscriptEnd = (id, status) => finished.push({ id, status });
  context.pipelineWait = () => new Promise((resolve) => waits.push(resolve));
  read(
    'voiceEnabled=true;profiles.forEach(p=>{p.voiceProvider="neural";p.voiceMatch="custom"});presentationWait=pipelineWait',
  );
  const running = h.start();
  await until(() => chat.length === 1);
  chat[0].speech('第一句完整的对白');
  await until(() => chat.length === 2 && audios.length === 1 && recorded.length === 1);
  assert.equal(recorded[0].seat, 0);
  assert.equal(speechRequests.length, 1);
  audios[0].duration = 8;
  audios[0].currentTime = 2;
  audios[0].ontimeupdate();
  const caption = read('speechBubble.caption');
  read('togglePause()');
  audios[0].currentTime = 5;
  audios[0].ontimeupdate();
  assert.equal(read('speechBubble.caption'), caption);
  assert.equal(audios[0].pauses, 1);
  read('togglePause();stopAgentWait()');
  await until(() => read('preparedSpeech.status') === 'failed');
  assert.equal(read('paused'), false);
  assert.equal(read('narration.seat'), 0);
  assert.equal(speechRequests[0].signal.aborted, false);
  assert.equal(audios[0].pauses, 1);
  assert.equal(read('transcript.length'), 1);
  assert.equal(recorded.length, 1);
  audios[0].onended();
  await until(() => waits.length === 1);
  assert.equal(read('speechBubble.caption'), '第一句完整的对白');
  waits.shift()(true);
  await until(() => read('!!apiWaiting'));
  assert.equal(read('apiWaiting.id'), 1);
  assert.equal(recorded.length, 1);
  read('retryAPI()');
  await until(() => chat.length === 3);
  chat[2].speech('第二句完整的对白');
  await until(() => audios.length === 2 && recorded.length === 2);
  assert.equal(recorded[1].seat, 1);
  assert.equal(recorded[1].text, '第二句完整的对白');
  audios[1].onended();
  await until(() => waits.length === 1);
  waits.shift()(true);
  await running;
  assert.deepEqual(
    recorded.map((item) => item.seat),
    [0, 1],
  );
  assert.deepEqual(finished, [
    { id: '1', status: 'played' },
    { id: '2', status: 'played' },
  ]);
  assert.equal(chat.length, 3);
  assert.equal(speechRequests.length, 2);
});

test('无声字幕阅读期间提前结果不提前写入录屏对白，结束后才切换席位', async (t) => {
  const h = speechPipeline(t, { actors: [0, 1], realPlayback: true }),
    { context, read, chat } = h;
  const recorded = [],
    finished = [],
    waits = [];
  context.recordingTranscriptBegin = (entry) => {
    recorded.push(entry);
    return String(recorded.length);
  };
  context.recordingTranscriptEnd = (id, status) => finished.push({ id, status });
  context.pipelineWait = (ms, token, valid, replay, progress) =>
    new Promise((resolve) => waits.push({ ms, progress, finish: resolve }));
  read('voiceEnabled=false;presentationWait=pipelineWait');
  const running = h.start();
  await until(() => chat.length === 1);
  chat[0].speech('阅读第一句全文');
  await until(() => chat.length === 2 && waits.length === 1);
  chat[1].speech('阅读第二句全文');
  await until(() => read('preparedSpeech.status') === 'ready');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].seat, 0);
  waits[0].progress(0.5);
  assert.equal(read('speechBubble.id'), 0);
  waits[0].progress(1);
  assert.equal(read('speechBubble.caption'), '阅读第一句全文');
  waits[0].finish(true);
  await until(() => waits.length === 2);
  assert.equal(recorded.length, 2);
  assert.equal(recorded[1].seat, 1);
  waits[1].finish(true);
  await running;
  assert.deepEqual(finished, [
    { id: '1', status: 'fallback-reading' },
    { id: '2', status: 'fallback-reading' },
  ]);
  assert.equal(chat.length, 2);
});
