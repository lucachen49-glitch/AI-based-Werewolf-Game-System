/* The recorder captures the same portrait element that the game renders. */
let activeRecording = null,
  recordingPreparing = false,
  recordingConfigPause = null,
  recordingNotice = '';
const recordingKey = 'nightfall-auto-record-v1';
let autoRecording = false;
const recordingTranscriptPendingKey = 'nightfall-recording-transcript-pending-v1';
function recordingTimelineNow(session = activeRecording) {
  if (!session) return 0;
  const pause = Number(session.pausedMs) || 0;
  const livePause = session.timelinePausedAt ? Date.now() - session.timelinePausedAt : 0;
  return Math.max(0, Date.now() - session.started - pause - livePause);
}
function recordingSetPauseReason(reason, value) {
  const session = activeRecording;
  if (!session || !reason) return;
  if (!session.pauseReasons) session.pauseReasons = new Set();
  const had = session.pauseReasons.has(reason);
  if (value && !had) {
    if (!session.pauseReasons.size) session.timelinePausedAt = Date.now();
    session.pauseReasons.add(reason);
  } else if (!value && had) {
    session.pauseReasons.delete(reason);
    if (!session.pauseReasons.size && session.timelinePausedAt) {
      session.pausedMs = (Number(session.pausedMs) || 0) + Date.now() - session.timelinePausedAt;
      session.timelinePausedAt = 0;
    }
  }
  session.pausedAt = session.timelinePausedAt || 0;
}
function recordingTranscriptPending() {
  try {
    const value = JSON.parse(localStorage.getItem(recordingTranscriptPendingKey) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
function recordingTranscriptSavePending(session) {
  try {
    const pending = recordingTranscriptPending();
    pending[session.id] = { recordingId: session.id, entries: session.transcriptEntries };
    localStorage.setItem(recordingTranscriptPendingKey, JSON.stringify(pending));
  } catch {}
}
function recordingTranscriptClearPending(id) {
  try {
    const pending = recordingTranscriptPending();
    delete pending[id];
    localStorage.setItem(recordingTranscriptPendingKey, JSON.stringify(pending));
  } catch {}
}
function recordingTranscriptUpload(session) {
  if (!session || !session.id || !Array.isArray(session.transcriptEntries)) return;
  recordingTranscriptSavePending(session);
  const snapshot = session.transcriptEntries.map((entry) => ({ ...entry }));
  const revision = (session.transcriptRevision || 0) + 1;
  session.transcriptRevision = revision;
  session.transcriptQueue = (session.transcriptQueue || Promise.resolve())
    .then(async () => {
      await recordingRequest('/api/recordings/' + session.id + '/transcript', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: snapshot }),
      });
      if (session.transcriptRevision === revision) recordingTranscriptClearPending(session.id);
    })
    .catch(() => {});
}
function recordingTranscriptBegin(meta = {}) {
  const session = activeRecording;
  if (!session || session.stopping) return null;
  const text = String(meta.text ?? '').trim();
  if (!text) return null;
  const id = globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : 'entry-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const entry = {
    id,
    kind: meta.kind === 'commentary' ? 'commentary' : 'dialogue',
    seat: Number.isInteger(meta.seat) ? meta.seat : null,
    name: String(meta.name || ''),
    round: Number.isInteger(meta.round)
      ? meta.round
      : typeof game !== 'undefined' && Number.isInteger(game.round)
        ? game.round
        : null,
    phase: String(meta.phase || (typeof game !== 'undefined' && game.phase) || ''),
    text,
    startedMs: recordingTimelineNow(session),
    endedMs: 0,
    durationMs: 0,
    voiceProvider: String(meta.voiceProvider || ''),
    voice: String(meta.voice || ''),
    voiceModel: String(meta.voiceModel || ''),
    speechStatus: String(meta.speechStatus || 'playing'),
    attempts: Number.isInteger(meta.attempts) && meta.attempts > 0 ? meta.attempts : 1,
    pausedMs: 0,
  };
  session.transcriptEntries.push(entry);
  recordingTranscriptSavePending(session);
  recordingTranscriptUpload(session);
  return id;
}
function recordingTranscriptUpdate(id, patch = {}) {
  const session = activeRecording;
  if (!session || !id) return;
  const entry = session.transcriptEntries.find((item) => item.id === id);
  if (!entry) return;
  Object.assign(entry, patch);
  if (Number.isFinite(entry.endedMs))
    entry.durationMs = Math.max(0, entry.endedMs - entry.startedMs);
  recordingTranscriptSavePending(session);
  recordingTranscriptUpload(session);
}
function recordingTranscriptEnd(id, status = 'played') {
  const session = activeRecording;
  if (!session || !id) return;
  const entry = session.transcriptEntries.find((item) => item.id === id);
  if (!entry) return;
  const ended = recordingTimelineNow(session);
  recordingTranscriptUpdate(id, {
    endedMs: Math.max(entry.startedMs, ended),
    durationMs: Math.max(0, ended - entry.startedMs),
    speechStatus: status,
    pausedMs: Number(session.pausedMs) || 0,
  });
}
function recordingTranscriptFinalize(session) {
  if (!session) return;
  const ended = recordingTimelineNow(session);
  for (const entry of session.transcriptEntries) {
    if (!entry.endedMs) {
      entry.endedMs = Math.max(entry.startedMs, ended);
      entry.durationMs = entry.endedMs - entry.startedMs;
      entry.speechStatus = 'interrupted';
    }
  }
  recordingTranscriptSavePending(session);
  recordingTranscriptUpload(session);
}
async function recordingFlushPending(items = []) {
  const pending = recordingTranscriptPending();
  for (const [id, data] of Object.entries(pending)) {
    if (!items.some((job) => job.id === id) || !Array.isArray(data?.entries)) continue;
    try {
      await recordingRequest('/api/recordings/' + id + '/transcript', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: data.entries }),
      });
      recordingTranscriptClearPending(id);
    } catch {}
  }
}
function recordingSupported() {
  return !!(
    navigator.mediaDevices?.getDisplayMedia &&
    globalThis.MediaRecorder &&
    (globalThis.CropTarget || globalThis.RestrictionTarget) &&
    navigator.mediaDevices.setCaptureHandleConfig
  );
}
function recordingPreference() {
  try {
    return localStorage.getItem(recordingKey) !== 'off';
  } catch {
    return true;
  }
}
function recordingStatus(text, options = {}) {
  if (options.sticky) recordingNotice = text;
  const node = document.getElementById('recordingStatus');
  if (node) node.textContent = text;
}
function recordingClearNotice() {
  recordingNotice = '';
}
function recordingUpdateControls() {
  const checkbox = document.getElementById('autoRecord');
  if (!checkbox) return;
  checkbox.checked = autoRecording;
  checkbox.disabled = !recordingSupported() || busy || recordingPreparing;
  document.getElementById('recordingSupport').textContent = recordingSupported()
    ? ''
    : '当前浏览器暂不支持自动录屏';
  if (recordingPreparing) document.getElementById('startBtn').disabled = true;
}
async function recordingRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(Error(data.error?.message || '本地录像服务不可用'), {
      status: response.status,
    });
  return data;
}
function recordingJSON(data) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}
function recordingTime(ms) {
  const seconds = Math.floor(ms / 1000);
  return (
    String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0')
  );
}
function recordingLatestPlayback(items) {
  const latest = [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return latest?.status === 'ready' && latest.url ? latest : null;
}
function recordingUpdateLatestPlayback(items) {
  const link = document.getElementById('latestRecordingPlayback');
  if (!link) return;
  const latest = recordingLatestPlayback(items);
  if (!latest) {
    link.hidden = true;
    link.removeAttribute('href');
    link.removeAttribute('data-recording-id');
    return;
  }
  link.href = latest.url;
  link.dataset.recordingId = latest.id;
  link.hidden = false;
}
function recordingLatestJob(items) {
  return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
}
function recordingStatusForJobs(items) {
  const latest = recordingLatestJob(items);
  if (!latest) return '录屏准备就绪 · 查看本地录像';
  const chunks = Number.isFinite(Number(latest.chunks)) ? Number(latest.chunks) : 0;
  if (latest.status === 'saving')
    return '录像合成中 · 已收到 ' + chunks + ' 个片段，完成后可打开回放。';
  if (latest.status === 'ready')
    return latest.complete
      ? '录像已保存 · 可打开最新回放。'
      : '未完局录像已保存 · 可打开最新回放。';
  if (latest.status === 'failed')
    return '录像合成失败 · ' + (latest.reason || '可在录像列表中重新合成。');
  if (latest.status === 'recording')
    return (
      '录像仍在进行 · 已收到 ' +
      chunks +
      ' 个片段 · 已记录 ' +
      (latest.transcriptCount || 0) +
      ' 条对白/旁白。'
    );
  if (latest.status === 'empty') return '没有可保存的录像片段。';
  return '录像状态 · ' + (latest.status || '未知');
}
function recordingUpdateStatusFromList(items) {
  // Recording, authorization, pause, and configuration messages are more current
  // than the five-second list refresh and must remain visible while active.
  if (activeRecording || recordingPreparing) return;
  recordingStatus(recordingStatusForJobs(items));
}
function recordingRenderList(items) {
  recordingUpdateLatestPlayback(items);
  recordingUpdateStatusFromList(items);
  const box = document.getElementById('recordingList');
  if (!box) return;
  box.replaceChildren();
  for (const job of items.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'recording-item';
    const label = document.createElement('span');
    const states = {
      recording: '录制中',
      saving: '正在合成',
      ready: job.complete ? '已保存' : '未完局 · 已保存',
      failed: '合成失败',
      empty: '没有录制片段',
    };
    label.textContent =
      (states[job.status] || job.status) +
      ' · ' +
      job.filename +
      (job.transcriptCount ? ' · ' + job.transcriptCount + ' 条对白/旁白' : '') +
      (job.reason ? ' · ' + job.reason : '');
    row.append(label);
    if (job.url) {
      for (const [title, suffix] of [
        ['播放', ''],
        ['下载', '?download=1'],
      ]) {
        const a = document.createElement('a');
        a.href = job.url + suffix;
        a.textContent = title;
        if (title === '播放') {
          a.target = '_blank';
          a.rel = 'noopener';
        }
        row.append(a);
      }
    }
    if (job.rawUrl) {
      const a = document.createElement('a');
      a.href = job.rawUrl + '?download=1';
      a.textContent = '下载原始录像';
      row.append(a);
    }
    if (job.transcriptCount) {
      for (const [title, url] of [
        ['剪辑稿 JSON', job.transcriptUrl],
        ['TXT', job.transcriptTxtUrl],
        ['SRT', job.transcriptSrtUrl],
        ['VTT', job.transcriptVttUrl],
      ]) {
        const a = document.createElement('a');
        a.href = url;
        a.textContent = title;
        a.download = '';
        row.append(a);
      }
    }
    if (job.status === 'failed') {
      const button = document.createElement('button');
      button.textContent = '重新合成';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await recordingRequest('/api/recordings/' + job.id + '/retry', recordingJSON({}));
          await refreshRecordings();
        } catch (e) {
          recordingStatus(e.message);
        } finally {
          button.disabled = false;
        }
      });
      row.append(button);
    }
    box.append(row);
  }
}
async function refreshRecordings() {
  try {
    const result = await recordingRequest('/api/recordings');
    await recordingFlushPending(result.recordings);
    recordingRenderList(result.recordings);
  } catch {}
}
function initRecording() {
  autoRecording = recordingSupported() && recordingPreference();
  const checkbox = document.getElementById('autoRecord');
  checkbox.addEventListener('change', () => {
    autoRecording = checkbox.checked;
    try {
      localStorage.setItem(recordingKey, autoRecording ? 'on' : 'off');
    } catch {}
    recordingUpdateControls();
  });
  recordingUpdateControls();
  void refreshRecordings();
  setInterval(() => {
    if (!document.hidden) void refreshRecordings();
  }, 5000);
  window.addEventListener('pagehide', () => {
    if (activeRecording) stopRecording(false);
  });
}
async function prepareRecording(token) {
  if (!autoRecording) return true;
  recordingPreparing = true;
  recordingUpdateControls();
  recordingUpdateLatestPlayback([]);
  recordingStatus('请选择当前游戏标签页，并勾选分享标签页音频。');
  let stream, job, session, surface;
  try {
    const handle = crypto.randomUUID();
    navigator.mediaDevices.setCaptureHandleConfig({
      handle,
      exposeOrigin: true,
      permittedOrigins: [location.origin],
    });
    // This call is made directly from the click handler, before awaiting any work.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    });
    if (token !== epoch) throw Error('对局已重置，请重新开始。');
    const track = stream.getVideoTracks()[0],
      capture = track?.getCaptureHandle?.();
    if (
      track?.getSettings().displaySurface !== 'browser' ||
      capture?.handle !== handle ||
      capture.origin !== location.origin
    )
      throw Error('请选择当前游戏标签页，再重新开始。');
    if (!stream.getAudioTracks().length) throw Error('请勾选“分享标签页音频”，再重新开始。');
    if (typeof track.cropTo !== 'function' && typeof track.restrictTo !== 'function')
      throw Error('当前浏览器无法只录制游戏画框，请使用支持此功能的桌面 Chrome。');
    setPortraitMode(true);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const frame = document.getElementById('portraitFrame');
    const cropped = typeof track.cropTo === 'function' && !!globalThis.CropTarget;
    if (cropped) await track.cropTo(await CropTarget.fromElement(frame));
    else await track.restrictTo(await RestrictionTarget.fromElement(frame));
    surface = await NightfallRecordingSurface.create(stream, frame, {
      cropped: true,
      mode: cropped ? 'region' : 'element',
    });
    if (token !== epoch) throw Error('对局已重置，请重新开始。');
    job = await recordingRequest(
      '/api/recordings',
      recordingJSON({ roomSize: size, story: !!selectedStoryId, capture: surface.metadata }),
    );
    if (token !== epoch) throw Error('对局已重置，请重新开始。');
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(
      (type) => MediaRecorder.isTypeSupported(type),
    );
    if (!mime) throw Error('浏览器无法创建录像，请关闭自动录屏后开始。');
    const recorder = new MediaRecorder(surface.stream, {
      mimeType: mime,
      videoBitsPerSecond: 5000000,
      audioBitsPerSecond: 160000,
    });
    session = {
      id: job.id,
      stream,
      track,
      recorder,
      surface,
      queue: Promise.resolve(),
      transcriptQueue: Promise.resolve(),
      transcriptRevision: 0,
      transcriptEntries: [],
      count: 0,
      started: Date.now(),
      pausedAt: 0,
      timelinePausedAt: 0,
      pauseReasons: new Set(),
      pausedMs: 0,
      complete: false,
      failed: false,
      stopping: false,
    };
    activeRecording = session;
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      const index = session.count++;
      session.queue = session.queue
        .then(async () => {
          let lastError;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await recordingRequest('/api/recordings/' + session.id + '/chunks/' + index, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: event.data,
              });
              return;
            } catch (error) {
              lastError = error;
              if (error.status === 507) break;
              await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
            }
          }
          throw lastError;
        })
        .catch((error) => {
          session.failed = true;
          recordingStatus('录像写入失败，正在保留已保存片段。' + error.message);
          if (!session.stopping) stopRecording(false);
        });
    };
    recorder.onerror = () => {
      session.failed = true;
      stopRecording(false);
    };
    recorder.onstop = () => {
      void finishRecording(session);
    };
    track.addEventListener('ended', () => {
      if (activeRecording === session && !session.stopping) {
        recordingStatus('标签页共享已停止，本局录像将保存为未完局。');
        stopRecording(false);
      }
    });
    recorder.start(3000);
    session.timer = setInterval(() => {
      if (activeRecording !== session) return;
      const elapsed = (session.pausedAt || Date.now()) - session.started - session.pausedMs;
      recordingStatus(
        (session.timelinePausedAt ? '录制已暂停' : '正在录制') +
          ' · ' +
          recordingTime(recordingTimelineNow(session)) +
          ' · 已记录 ' +
          session.transcriptEntries.length +
          ' 条对白/旁白',
      );
      void recordingRequest(
        '/api/recordings/' + session.id + '/heartbeat',
        recordingJSON({}),
      ).catch(() => {});
    }, 1000);
    recordingStatus('正在录制 · 00:00');
    return true;
  } catch (error) {
    if (activeRecording === session) activeRecording = null;
    surface?.stop();
    stream?.getTracks().forEach((track) => track.stop());
    if (job)
      void recordingRequest(
        '/api/recordings/' + job.id + '/finish',
        recordingJSON({ complete: false, expected: 0 }),
      ).catch(() => {});
    recordingStatus(
      error.name === 'NotAllowedError' ? '未授权录屏，可重新开始或关闭自动录屏。' : error.message,
      { sticky: true },
    );
    return false;
  } finally {
    recordingPreparing = false;
    recordingUpdateControls();
    void refreshRecordings();
  }
}
function stopRecording(complete) {
  const session = activeRecording;
  if (!session || session.stopping) return;
  session.stopping = true;
  session.complete = complete;
  clearInterval(session.timer);
  recordingTranscriptFinalize(session);
  if (session.recorder.state !== 'inactive') session.recorder.stop();
  else void finishRecording(session);
  session.surface?.stop();
  session.stream.getTracks().forEach((track) => track.stop());
  recordingStatus(complete ? '录制结束，正在保存。' : '录制已中断，正在保存已收到的片段。');
}
async function finishRecording(session) {
  if (session.finished) return;
  session.finished = true;
  await session.queue;
  await session.transcriptQueue;
  try {
    await recordingRequest(
      '/api/recordings/' + session.id + '/finish',
      recordingJSON({ complete: session.complete && !session.failed, expected: session.count }),
    );
    if (activeRecording === session)
      recordingStatus(
        session.complete && !session.failed
          ? '录像正在合成，完成后可在下方播放。'
          : '未完局录像正在保存。',
      );
  } catch {
    if (activeRecording === session)
      recordingStatus('保存请求未完成，已收到的片段将在服务恢复后找回。');
  }
  if (activeRecording === session) activeRecording = null;
  recordingUpdateControls();
  void refreshRecordings();
}
function recordingOpenConfig() {
  if (!activeRecording || recordingConfigPause) return;
  recordingConfigPause = { wasPaused: paused, portrait: portraitMode };
  if (busy && !paused) togglePause();
  recordingSetPauseReason('config', true);
  if (activeRecording.recorder.state === 'recording') activeRecording.recorder.pause();
}
function recordingCloseConfig() {
  const state = recordingConfigPause;
  if (!state) return;
  recordingConfigPause = null;
  if (!activeRecording) return;
  if (state.portrait && !portraitMode) setPortraitMode(true);
  if (activeRecording.recorder.state === 'paused') activeRecording.recorder.resume();
  recordingSetPauseReason('config', false);
  if (busy && !state.wasPaused && paused) togglePause();
}

if (typeof module === 'object' && module.exports)
  module.exports = { recordingLatestPlayback, recordingLatestJob, recordingStatusForJobs };
