'use strict';
const { guardedFetch } = require('./upstream-guard.cjs');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  { randomUUID, createHash } = require('node:crypto');
const { atomic, readAtomic, validId, StoryError, dataRoot } = require('./scenario-store.cjs'),
  Schema = require('./scenario.js');
const { mediaTools } = require('./video-media.cjs');
const { storyMusic } = require('./soundfx.js');
const MAX_DOWNLOAD = 180 * 1024 * 1024;
function safeProviderDiagnostic(data, authorization = '') {
  const codes = [data?.error?.code, data?.code]
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => /^[a-zA-Z0-9_.:-]{1,80}$/.test(x));
  let message = [data?.error?.message, data?.message].find((x) => typeof x === 'string') || '';
  const secret = String(authorization)
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (secret) message = message.split(secret).join('[已隐藏密钥]');
  message = message
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, '[已隐藏凭据]')
    .replace(/[\r\n\t\x00-\x1f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return [codes[0] ? '错误码 ' + codes[0] : '', message ? '供应商说明：' + message : '']
    .filter(Boolean)
    .join('；');
}
function providerFailure(status, data, authorization = '') {
  const code = [data?.error?.code, data?.code].filter((x) => typeof x === 'string').join(' '),
    detail = safeProviderDiagnostic(data, authorization);
  if (
    status === 400 &&
    /reference_audio|voice_id|voice|audio.format|unsupported.*audio/i.test(
      code + ' ' + String(data?.error?.message || ''),
    )
  )
    return new StoryError(
      502,
      'VIDEO_VOICE_UNSUPPORTED',
      '华龙未接受 Grok 参考音色或音频参数，已停止，不会退回无对白版本；请核对模型音色支持，已完成素材保留',
    );
  if (status === 401)
    return new StoryError(401, 'VIDEO_AUTH_FAILED', '视频密钥无效，请检查独立的视频配置');
  if (status === 402) return new StoryError(402, 'VIDEO_QUOTA', '视频接口余额不足');
  if (/model|permission_denied/i.test(code) || status === 403)
    return new StoryError(
      status,
      'VIDEO_PERMISSION',
      '当前账户未获该视频模型权限，或供应商拒绝访问',
    );
  if ([404, 405].includes(status))
    return new StoryError(502, 'VIDEO_ENDPOINT', '华龙未提供预期的视频接口，请核对其视频调用文档');
  if (status === 429) return new StoryError(429, 'VIDEO_RATE_LIMIT', '视频请求受限，请稍后继续');
  if (status === 503)
    return new StoryError(
      503,
      'VIDEO_SERVICE_UNAVAILABLE',
      '华龙视频服务暂不可用（HTTP 503）。这不是模型参数错误的确认；本镜头未取得任务编号，系统不会自动重试。' +
        (detail ? '供应商返回：' + detail + '。' : '') +
        '请依据错误详情稍后处理或重做这一镜',
    );
  return new StoryError(
    502,
    'VIDEO_UPSTREAM',
    '视频接口返回错误，请核对模型与参数支持（HTTP ' + status + '）' + (detail ? '。' + detail : ''),
  );
}
function displayMessage(message) {
  return typeof message === 'string' &&
    /视频接口返回错误，请核对模型、原生音频与参数支持（HTTP 503）/.test(message)
    ? providerFailure(503, {}).message
    : message || '';
}
const hashFile = async (file) => {
  const hash = createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
function createVideoJobs({
  root = path.join(dataRoot, 'videos'),
  store,
  config,
  artJobs,
  references,
  fetchImpl = guardedFetch,
  media = mediaTools,
  pollMs = 5000,
  maxWaitMs = 15 * 60 * 1000,
  requestTimeoutMs = 45000,
  allowLocalMedia = false,
} = {}) {
  const active = new Map(),
    pauseRequests = new Set(),
    actionTails = new Map();
  let stopped = false,
    createTail = Promise.resolve();
  const file = (id) => path.join(root, id, 'job.json');
  async function get(id) {
    if (!validId(id)) throw new StoryError(404, 'VIDEO_JOB_NOT_FOUND', '找不到视频任务');
    try {
      return await readAtomic(file(id));
    } catch (e) {
      if (e.code === 'ENOENT') throw new StoryError(404, 'VIDEO_JOB_NOT_FOUND', '找不到视频任务');
      throw e;
    }
  }
  const save = (j) => atomic(file(j.id), { ...j, updatedAt: new Date().toISOString() });
  function summary(j) {
    return {
      roomSize: j.roomSize || 6,
      productionId: j.productionId || null,
      id: j.id,
      storyId: j.storyId,
      version: j.version,
      status: j.status,
      stage: j.stage || null,
      profile: j.profile || 'legacy30-v1',
      artId: j.art?.id || null,
      artRevision: j.art?.revision || null,
      language: j.language || 'zh',
      storyTitle: j.storyTitle || null,
      storyBackground: j.storyBackground || null,
      publicCharacters: Array.isArray(j.publicCharacters) ? j.publicCharacters : [],
      targetDuration: j.targetDuration || j.scenes.length * 10,
      sceneDuration: j.sceneDuration === null ? null : j.sceneDuration || 10,
      voiceMap: j.voiceMap || null,
      audioMode: j.audioMode || 'native',
      message: displayMessage(j.message),
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      scenes: j.scenes.map((s, i) => ({
        index: i,
        cast: j.art?.frames?.[i]?.cast || [],
        description: j.art?.frames?.[i]?.description || '',
        duration: s.duration || j.sceneDuration || 10,
        dialogues: s.dialogues || [],
        narration: s.narration || '',
        narrationTranslation: s.narrationTranslation || '',
        timing: s.timing || null,
        quality: s.quality || null,
        status: s.status,
        startSource: s.startSource || 'frame',
        startFrameSource: s.startFrameSource || null,
        message: displayMessage(s.message),
        startedAt: s.startedAt || null,
        lastCheckedAt: s.lastCheckedAt || null,
        providerStatus: s.providerStatus || null,
        progress: s.progress ?? null,
        reuse: s.reuse || null,
        previousVersions: (s.previousVersions || []).map((v) => ({
          createdAt: v.createdAt,
          duration: v.duration,
          url: '/api/story-media/' + j.id + '/' + v.file,
        })),
        url: ['done', 'stale'].includes(s.status)
          ? '/api/story-media/' + j.id + '/scene-' + i + '.mp4'
          : null,
      })),
      url: ['ready', 'accepted'].includes(j.status)
        ? '/api/story-media/' + j.id + '/intro.mp4'
        : null,
    };
  }
  async function list(storyId) {
    let ids;
    try {
      ids = await fs.readdir(root);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const results = await Promise.allSettled(ids.filter(validId).map(get)),
      jobs = [];
    for (const result of results) {
      if (result.status === 'fulfilled') jobs.push(result.value);
      else if (result.reason.code !== 'VIDEO_JOB_NOT_FOUND') throw result.reason;
    }
    return jobs
      .filter((j) => !storyId || j.storyId === storyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function request(url, options, signal) {
    const c = new AbortController();
    const abort = () => c.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => c.abort(), requestTimeoutMs);
    try {
      const r = await fetchImpl(url, { ...options, signal: c.signal, redirect: 'error' });
      const raw = await boundedBody(r, 2 * 1024 * 1024);
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {}
      if (!r.ok) throw providerFailure(r.status, data, options.headers?.Authorization);
      if (!data)
        throw new StoryError(502, 'VIDEO_PROTOCOL', '视频接口返回了非 JSON 内容，请核对转发协议');
      return data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async function boundedBody(r, limit) {
    if (!r.body) throw new StoryError(502, 'VIDEO_EMPTY', '视频接口返回空内容');
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of r.body) {
        size += chunk.length;
        if (size > limit) throw new StoryError(502, 'VIDEO_TOO_LARGE', '视频接口返回内容过大');
        chunks.push(Buffer.from(chunk));
      }
    } catch (e) {
      throw e;
    }
    return Buffer.concat(chunks);
  }
  async function download(url, dest, signal, cred, requestId) {
    let u;
    try {
      if (typeof url !== 'string' || !url.trim()) throw Error();
      u = new URL(url, cred.provider + '/');
    } catch {
      throw new StoryError(502, 'VIDEO_PROTOCOL', '视频结果缺少有效下载地址');
    }
    if (
      u.username ||
      u.password ||
      !(
        u.protocol === 'https:' ||
        (allowLocalMedia && u.protocol === 'http:' && u.hostname === '127.0.0.1')
      )
    )
      throw new StoryError(502, 'VIDEO_PROTOCOL', '供应商返回的视频地址不符合要求');
    const content = new URL(
      cred.provider + '/videos/' + encodeURIComponent(requestId) + '/content',
    );
    const headers =
      u.origin === content.origin && u.pathname === content.pathname
        ? { Authorization: 'Bearer ' + cred.apiKey }
        : undefined;
    const c = new AbortController(),
      abort = () => c.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 180000);
    try {
      const r = await fetchImpl(u.href, {
        signal: c.signal,
        redirect: 'error',
        ...(headers ? { headers } : {}),
      });
      if (!r.ok)
        throw new StoryError(
          502,
          'VIDEO_DOWNLOAD',
          '视频下载失败；继续任务将重新查询同一任务，不会重新生成',
        );
      if (Number(r.headers.get('content-length')) > MAX_DOWNLOAD)
        throw new StoryError(502, 'VIDEO_TOO_LARGE', '视频文件超过本地下载上限');
      const temp = dest + '.part';
      let handle;
      try {
        handle = await fs.open(temp, 'w');
        let bytes = 0;
        for await (const chunk of r.body) {
          bytes += chunk.length;
          if (bytes > MAX_DOWNLOAD) throw new StoryError(502, 'VIDEO_TOO_LARGE', '视频文件过大');
          await handle.write(chunk);
        }
        await handle.close();
        handle = null;
        if (bytes < 32) throw new StoryError(502, 'VIDEO_EMPTY', '视频文件为空或不完整');
        await fs.rename(temp, dest);
      } finally {
        await handle?.close();
        await fs.rm(temp, { force: true }).catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  const wait = (signal) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, pollMs);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  function voiceStory(j, source) {
    return {
      ...source,
      characters: source.characters.map((c) => ({
        ...c,
        ...(j.voiceCharacters?.find((v) => v.seat === c.seat) || {}),
        voiceId: j.voiceMap?.[c.seat] || c.voiceId,
      })),
    };
  }
  function checkVoices(j, source) {
    if (j.audioMode !== 'dialogue-narration') return;
    const issues = Schema.voiceIssues(voiceStory(j, source));
    if (issues.length)
      throw new StoryError(
        400,
        'VIDEO_VOICE_MISMATCH',
        '生成前音色检查未通过：' +
          issues.join('；') +
          '。请修正剧本音色并保存新版本后制作；历史视频保持不变',
      );
  }
  async function reuseScene(j, index, scene, signal) {
    const fingerprint = scene.contentFingerprint;
    const candidates = (await list(j.storyId)).filter(
      (old) => old.id !== j.id && old.roomSize === j.roomSize && old.profile === j.profile,
    );
    for (const old of candidates) {
      const previous = old.scenes[index];
      if (
        previous?.contentFingerprint !== fingerprint ||
        previous.status !== 'done' ||
        (old.productionId && previous.quality !== 'passed') ||
        !previous.outputFingerprint
      )
        continue;
      if (signal.aborted) return false;
      const name = 'scene-' + index + '.mp4',
        src = path.join(root, old.id, name),
        dest = path.join(root, j.id, name);
      try {
        await fs.copyFile(src, dest);
        if ((await hashFile(dest)) !== previous.outputFingerprint) continue;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      scene.status = 'done';
      scene.quality = 'pending';
      scene.outputFingerprint = previous.outputFingerprint;
      scene.reuse = {
        sourceTaskId: old.id,
        sourceAssetId: name,
        scriptVersion: old.version,
        artRevision: old.art?.revision || null,
        contentFingerprint: fingerprint,
        model: scene.model,
        promptVersion: scene.inputAudit?.promptVersion,
        capabilities: scene.capabilities,
        reusedAt: new Date().toISOString(),
      };
      scene.message = '已复用同一制作输入的历史镜头，未提交视频生成。';
      j.status = 'quality_review';
      j.stage = 'checking';
      j.message = scene.message;
      await save(j);
      return true;
    }
    const unresolved = candidates.find(
      (old) =>
        old.scenes[index]?.contentFingerprint === fingerprint &&
        ['submitting', 'unknown', 'pending', 'downloading'].includes(old.scenes[index].status),
    );
    if (unresolved)
      throw new StoryError(
        409,
        'VIDEO_SOURCE_PENDING',
        '同一镜头已有受理结果待确认，未重复提交。请先在历史视频任务 ' +
          unresolved.id +
          ' 继续查询。',
      );
    return false;
  }
  async function processJob(id, signal) {
    let j = await get(id);
    try {
      if (!(await media.available()))
        throw new StoryError(
          503,
          'FFMPEG_REQUIRED',
          '请先运行 setup-video.cmd 安装本地视频工具；尚未提交任何视频请求',
        );
      const cred = await config.loadCredential();
      if (j.provider && j.provider !== cred.provider)
        throw new StoryError(
          409,
          'VIDEO_PROVIDER_CHANGED',
          '接口地址已更改，无法查询原接口的任务，请恢复原地址后继续',
        );
      j.provider = cred.provider;
      j.status = 'running';
      j.message = '';
      await save(j);
      if (['unified', 'dialogue-narration'].includes(j.audioMode)) {
        j.stage = 'voicing';
        j.message = '正在准备统一旁白；先检查配音时长，再提交画面生成';
        await save(j);
        await media.prepareNarration(path.join(root, j.id), j, {
          signal,
          onProgress: async (i) => {
            j.message = '正在制作统一旁白 ' + (i + 1) + ' / ' + j.scenes.length;
            await save(j);
          },
        });
      }
      for (let i = 0; i < j.scenes.length; i++) {
        if (pauseRequests.has(id)) {
          j.status = 'paused';
          j.message = '已在当前镜头完成后暂停。';
          await save(j);
          return;
        }
        const scene = j.scenes[i];
        if (scene.status === 'done') {
          if (j.productionId && scene.quality !== 'passed') {
            j.status = 'quality_review';
            j.stage = 'checking';
            j.message = '镜头 ' + (i + 1) + ' 已完成，等待实际画面与对白检查。';
            await save(j);
            return;
          }
          continue;
        }
        if (signal.aborted) return;
        if (scene.status === 'stale') {
          j.status = 'needs_review';
          j.message =
            '前一镜已重做，本镜使用旧尾帧，请检查后明确确认并单镜重做；已完成的视频保留。';
          await save(j);
          return;
        }
        if (scene.status === 'submitting' || scene.status === 'unknown') {
          scene.status = 'unknown';
          j.status = 'needs_review';
          j.message =
            '上次提交结果不明确，已停止自动重发。请到华龙后台查询是否已计费，并填入任务编号继续。';
          await save(j);
          return;
        }
        if (!scene.requestId) {
          if (scene.status === 'failed') {
            j.status = 'failed';
            j.message = '镜头生成失败，请明确点击重做后再提交';
            await save(j);
            return;
          }
          let referenceInput = {};
          if (['story60-refs-v1', 'cinema-refs-v1'].includes(j.profile)) {
            const frame = j.art.frames[i],
              source = await store.get(j.storyId);
            if (source.version !== j.version)
              throw new StoryError(
                409,
                'STALE_VIDEO',
                '剧本已更新，已停止新镜头提交；已有素材与任务编号保留',
              );
            checkVoices(j, source);
            const promptStory = {
              ...voiceStory(j, source),
              scenes: source.scenes.map((s, n) => ({
                ...s,
                cast: j.art.frames[n].cast,
                description: j.art.frames[n].description || s.description,
              })),
            };
            scene.prompt = Schema.referenceVideoPrompt(promptStory, i, j.art.characters);
            if (j.audioMode === 'dialogue-narration')
              scene.referenceAudios = Schema.audioReferences(promptStory, i);
            const inputs = [];
            const asData = async (name, seat) => {
              const bytes = await fs.readFile(path.join(root, j.id, name));
              inputs.push({
                file: name,
                seat,
                bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              });
              return 'data:image/png;base64,' + bytes.toString('base64');
            };
            let startFile = frame.file;
            if (scene.startSource === 'previous') {
              if (i === 0 || j.scenes[i - 1].status !== 'done')
                throw new StoryError(
                  409,
                  'PREVIOUS_FRAME_REQUIRED',
                  '上一镜尚未完成，无法提取尾帧',
                );
              startFile = 'previous-frame-' + i + '.png';
              await media.extractLastFrame(
                path.join(root, j.id, 'scene-' + (i - 1) + '.mp4'),
                path.join(root, j.id, startFile),
                { signal },
              );
              scene.startFrameSource = { scene: i - 1, file: startFile };
              await save(j);
            }
            const image = { url: await asData(startFile, null) },
              reference_images = [];
            for (const seat of frame.cast)
              reference_images.push({ url: await asData(j.art.characters[seat - 1].file, seat) });
            if (
              frame.cast.length +
                (scene.referenceFrames || []).length +
                (scene.extraReferences || []).length >
              14
            )
              throw new StoryError(
                400,
                'REFERENCE_LIMIT',
                '镜头 ' + (i + 1) + ' 的人物和附加参考图超过14张，请调整出场人物或参考图',
              );
            const purposes = {
              scene: 'setting and architecture',
              costume: 'costume details',
              prop: 'prop appearance and placement',
              general: 'setting, costume and props',
            };
            for (const frameIndex of scene.referenceFrames || []) {
              const item = j.art.frames[frameIndex];
              if (!item?.file)
                throw new StoryError(
                  409,
                  'REFERENCE_MISSING',
                  '镜头 ' + (frameIndex + 1) + ' 的参考图不可用',
                );
              reference_images.push({ url: await asData(item.file, null) });
              const label = purposes[scene.referencePurposes?.[frameIndex] || 'general'];
              scene.prompt +=
                '\n<IMAGE_' +
                reference_images.length +
                '> is an additional reference for ' +
                label +
                '. Preserve these details only; do not introduce unlisted characters.';
            }
            for (const ref of scene.extraReferences || []) {
              reference_images.push({ url: await asData(ref.file, null) });
              scene.prompt +=
                '\n<IMAGE_' +
                reference_images.length +
                '> is a ' +
                ref.purpose +
                ' reference named ' +
                ref.label +
                '. Use its public visual details while preserving the listed cast and their identities.';
            }
            const lastFrame = Number.isInteger(scene.endFrameIndex)
              ? { url: await asData(j.art.frames[scene.endFrameIndex].file, null) }
              : null;
            referenceInput = {
              image,
              reference_images,
              ...(lastFrame ? { last_frame: lastFrame } : {}),
              ...(j.audioMode === 'dialogue-narration' && scene.dialogues?.length
                ? { reference_audios: scene.referenceAudios.map(({ voice_id }) => ({ voice_id })) }
                : {}),
            };
            scene.inputAudit = {
              promptVersion: j.audioMode === 'dialogue-narration' ? 4 : 2,
              voiceCharacters:
                j.audioMode === 'dialogue-narration'
                  ? frame.cast.map((seat) => Schema.voiceSnapshot(promptStory.characters[seat - 1]))
                  : undefined,
              referenceAudios: scene.referenceAudios || [],
              timing: scene.timing || null,
              promptSha256: createHash('sha256').update(scene.prompt).digest('hex'),
              startingFrame: inputs[0],
              characters: inputs.slice(1, 1 + frame.cast.length),
              additionalFrames: inputs
                .slice(
                  1 + frame.cast.length,
                  1 + frame.cast.length + (scene.referenceFrames || []).length,
                )
                .map((input, n) => ({
                  ...input,
                  frameIndex: scene.referenceFrames[n],
                  purpose: scene.referencePurposes?.[scene.referenceFrames[n]] || 'general',
                })),
              extraReferences: scene.extraReferences || [],
              endingFrame: lastFrame ? inputs[inputs.length - 1] : null,
            };
          }
          const requestBody = JSON.stringify({
            model: cred.model,
            prompt: scene.prompt,
            ...referenceInput,
            duration: scene.duration || j.sceneDuration || 10,
            aspect_ratio: '16:9',
            resolution: '720p',
            generate_audio:
              j.audioMode === 'dialogue-narration'
                ? !!scene.dialogues?.length
                : j.audioMode !== 'unified',
          });
          if (j.profile === 'cinema-refs-v1') {
            scene.model = cred.model;
            scene.capabilities = Object.keys(referenceInput).sort();
            scene.contentFingerprint = createHash('sha256')
              .update(
                JSON.stringify([
                  'video-request-v1',
                  j.roomSize,
                  j.storyId,
                  j.profile,
                  j.language || 'zh',
                  j.audioMode,
                  i,
                  cred.provider,
                  scene.model,
                  scene.inputAudit?.promptVersion,
                  scene.inputAudit?.voiceCharacters,
                  scene.capabilities,
                ]),
              )
              .update(requestBody)
              .digest('hex');
            if (j.productionId && !scene.explicitRetry && (await reuseScene(j, i, scene, signal)))
              return;
          }
          if (signal.aborted) return;
          j.stage = 'generating';
          j.message = '正在生成镜头 ' + (i + 1) + ' / ' + j.scenes.length;
          scene.status = 'submitting';
          scene.startedAt = new Date().toISOString();
          scene.message = '';
          scene.providerStatus = null;
          scene.progress = null;
          await save(j);
          let data;
          try {
            data = await request(
              cred.provider + '/videos/generations',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: 'Bearer ' + cred.apiKey,
                },
                body: requestBody,
              },
              signal,
            );
          } catch (e) {
            if (
              e instanceof StoryError &&
              !['VIDEO_PROTOCOL', 'VIDEO_TOO_LARGE', 'VIDEO_EMPTY'].includes(e.code)
            ) {
              scene.status = 'failed';
              scene.message = e.message;
              throw e;
            }
            scene.status = 'unknown';
            throw new StoryError(
              502,
              'VIDEO_SUBMISSION_UNKNOWN',
              '提交连接中断或响应不明确，无法确认是否已创建计费任务；请核对华龙后台后填入任务编号，系统不会自动重发',
            );
          }
          if (
            typeof data.request_id !== 'string' ||
            !data.request_id ||
            data.request_id.length > 300
          ) {
            scene.status = 'unknown';
            throw new StoryError(
              502,
              'VIDEO_PROTOCOL',
              '供应商未返回预期的 request_id，已停止重发；请核对华龙后台与视频接口协议',
            );
          }
          scene.requestId = data.request_id;
          scene.status = 'pending';
          await save(j);
        }
        const queryStarted = Date.now();
        for (;;) {
          if (signal.aborted) return;
          if (Date.now() - queryStarted > maxWaitMs) {
            j.status = 'paused';
            j.message =
              '当前镜头本次查询已达等待上限，任务编号已保存。稍后继续查询，不会重新计费提交。';
            await save(j);
            return;
          }
          const data = await request(
            cred.provider + '/videos/' + encodeURIComponent(scene.requestId),
            { headers: { Authorization: 'Bearer ' + cred.apiKey } },
            signal,
          );
          scene.lastCheckedAt = new Date().toISOString();
          scene.providerStatus = [
            'pending',
            'queued',
            'processing',
            'in_progress',
            'done',
            'failed',
          ].includes(data.status)
            ? data.status
            : null;
          scene.progress =
            typeof data.progress === 'number' &&
            Number.isFinite(data.progress) &&
            data.progress >= 0 &&
            data.progress <= 100
              ? data.progress
              : null;
          if (data.status === 'failed') {
            scene.status = 'failed';
            scene.requestId = null;
            scene.message = '供应商报告镜头生成失败，请检查内容与模型权限后决定是否重做';
            throw new StoryError(502, 'VIDEO_GENERATION_FAILED', scene.message);
          }
          if (data.status === 'done') {
            j.stage = 'downloading';
            scene.status = 'downloading';
            scene.message = '模型已完成，正在下载视频';
            await save(j);
            const dir = path.join(root, j.id);
            await download(
              data.video?.url,
              path.join(dir, 'source-' + i + '.mp4'),
              signal,
              cred,
              scene.requestId,
            );
            scene.message =
              j.audioMode === 'unified'
                ? '下载完成，正在检查时长并处理画面'
                : '下载完成，正在检查音轨并处理画面';
            await save(j);
            const sceneAudioMode =
              j.audioMode === 'dialogue-narration' && !scene.dialogues?.length
                ? 'unified'
                : j.audioMode || 'native';
            await media.normalize(
              path.join(dir, 'source-' + i + '.mp4'),
              path.join(dir, 'scene-' + i + '.mp4'),
              {
                audioMode: sceneAudioMode,
                continuous: j.profile === 'cinema-refs-v1',
                duration: scene.duration || j.sceneDuration || 10,
                signal,
              },
            );
            if (scene.contentFingerprint)
              scene.outputFingerprint = await hashFile(path.join(dir, 'scene-' + i + '.mp4'));
            scene.explicitRetry = false;
            scene.status = 'done';
            scene.quality = j.productionId ? 'pending' : null;
            scene.message =
              j.audioMode === 'unified' ? '画面已保存，统一旁白已准备' : '已下载并检查原生音轨';
            await save(j);
            if (j.productionId) {
              j.status = 'quality_review';
              j.stage = 'checking';
              await save(j);
              return;
            }
            break;
          }
          if (!['pending', 'queued', 'processing', 'in_progress'].includes(data.status))
            throw new StoryError(
              502,
              'VIDEO_PROTOCOL',
              '供应商任务状态不符合预期，请核对华龙接口文档',
            );
          scene.status = 'pending';
          await save(j);
          await wait(signal);
        }
      }
      if (j.productionId && j.scenes.some((s) => s.status === 'done' && s.quality !== 'passed')) {
        j.status = 'quality_review';
        j.stage = 'checking';
        j.message = '镜头已下载，等待逐镜检查。';
        await save(j);
        return;
      }
      if (signal.aborted) return;
      j.stage = 'assembling';
      j.message = '正在合成画面、统一旁白与环境声音';
      await save(j);
      await media.assemble(path.join(root, j.id), j, { signal });
      j.stage = 'complete';
      j.status = 'ready';
      j.message = '成片已保存，请完整预览画面、对白、旁白与字幕后下载';
      await save(j);
    } catch (e) {
      if (signal.aborted || stopped) return;
      j.status = j.scenes.some((s) => s.status === 'unknown' || s.status === 'submitting')
        ? 'needs_review'
        : j.scenes.some((s) => s.status === 'failed')
          ? 'failed'
          : 'paused';
      j.message =
        e instanceof StoryError ? e.message : '视频处理暂时中断，已有任务与镜头已保存，请继续查询';
      await save(j);
    }
  }
  function launch(id) {
    if (active.has(id) || stopped) return;
    const c = new AbortController();
    const promise = processJob(id, c.signal)
      .catch(() => {})
      .finally(() => active.delete(id));
    active.set(id, { c, promise });
  }
  const service = {
    root,
    get,
    summary,
    async claim(id, productionId) {
      const j = await get(id);
      if (j.productionId === productionId) return summary(j);
      if (j.productionId || active.has(id))
        throw new StoryError(
          409,
          'TASK_IN_USE',
          '已有素材任务正在使用，请先暂停原任务后继续自动制作',
        );
      j.productionId = productionId;
      if (j.scenes.some((scene) => scene.status === 'done' && scene.quality !== 'passed')) {
        j.status = 'quality_review';
        j.stage = 'checking';
      }
      await save(j);
      return summary(j);
    },
    async pause(id) {
      pauseRequests.add(id);
      return summary(await get(id));
    },
    async unpause(id) {
      pauseRequests.delete(id);
    },
    async list(storyId) {
      return (await list(storyId)).map(summary);
    },
    create(body) {
      const next = createTail.then(async () => {
        const savedStory = await store.get(body?.storyId);
        const s = body.productionId ? Schema.automaticReferences(savedStory) : savedStory;
        if (s.version !== body?.version)
          throw new StoryError(409, 'STALE_STORY', '剧本版本已更新，请重新载入');
        if (!s.confirmed)
          throw new StoryError(400, 'UNCONFIRMED_STORY', '请先确认剧本人物与随机身份无冲突');
        let plan;
        try {
          plan = Schema.videoPlan(s, body.profile);
        } catch (e) {
          throw new StoryError(400, 'INVALID_VIDEO_PLAN', e.message);
        }
        if (plan.profile !== 'legacy30-v1' && plan.profile !== 'story60-v1') {
          if (!artJobs) throw new StoryError(503, 'ART_REQUIRED', '人物图片服务不可用');
          await artJobs.approved(body.artId, body.artRevision, s.id, s.version);
        }
        const needsArt = plan.profile === 'story60-refs-v1' || plan.profile === 'cinema-refs-v1';
        const prior = (await list(s.id)).find(
          (j) =>
            j.version === s.version &&
            (j.profile || 'legacy30-v1') === plan.profile &&
            (body.productionId ? j.productionId === body.productionId : !j.productionId) &&
            (!needsArt || (j.art?.id === body.artId && j.art?.revision === body.artRevision)),
        );
        if (prior) return summary(prior);
        if (plan.profile === 'cinema-refs-v1' && body.confirmCharge !== true)
          throw new StoryError(
            400,
            'CHARGE_CONFIRM_REQUIRED',
            '电影开场按镜头生成会产生费用，请确认镜头数量和总时长后再制作',
          );
        await config.loadCredential();
        if (!(await media.available()))
          throw new StoryError(503, 'FFMPEG_REQUIRED', '请先运行 setup-video.cmd 安装本地视频工具');
        const id = randomUUID(),
          art = needsArt
            ? await artJobs.snapshot(
                body.artId,
                body.artRevision,
                s.id,
                s.version,
                path.join(root, id),
              )
            : null;
        for (const scene of s.scenes) {
          for (const ref of scene.extraReferences || []) {
            if (!references)
              throw new StoryError(503, 'REFERENCE_UNAVAILABLE', '参考素材服务不可用');
            const asset = await references.get(ref.id, s.roomSize || 6);
            const file = 'extra-' + ref.id + '.png';
            await fs.copyFile(asset.file, path.join(root, id, file));
            ref.file = file;
            ref.label = asset.label;
            ref.sha256 = asset.sha256;
          }
        }
        const publicSnapshot = Schema.publicStory(s);
        const promptStory = art
          ? {
              ...s,
              scenes: s.scenes.map((scene, i) => ({
                ...scene,
                cast: art.frames[i].cast,
                description: art.frames[i].description || scene.description,
              })),
            }
          : s;
        const j = {
          id,
          art,
          ...(body.productionId ? { productionId: body.productionId } : {}),
          ...(s.language === 'en' ? { language: 'en' } : {}),
          roomSize: s.roomSize || 6,
          storyId: s.id,
          version: s.version,
          storyTitle: publicSnapshot.title,
          storyBackground: publicSnapshot.background,
          publicCharacters: publicSnapshot.characters,
          ...plan,
          status: 'running',
          stage: 'queued',
          createdAt: new Date().toISOString(),
          scenes: s.scenes.map((scene, i) => ({
            duration: plan.sceneDurations?.[i] || 10,
            startSource: scene.startSource || 'frame',
            referenceFrames: scene.referenceFrames || [],
            referencePurposes: scene.referencePurposes || {},
            extraReferences: scene.extraReferences || [],
            endFrameIndex: scene.endFrameIndex ?? null,
            status: 'queued',
            prompt: art
              ? Schema.referenceVideoPrompt(promptStory, i, art.characters)
              : Schema.videoPrompt(s, i),
            ...(plan.audioMode !== 'native'
              ? {
                  narration: scene.narration,
                  ...(s.language === 'en'
                    ? { narrationTranslation: scene.narrationTranslation }
                    : {}),
                  musicCue: storyMusic({
                    size: s.roomSize || 6,
                    story: s,
                    scene: promptStory.scenes[i].description,
                  }),
                  dialogues: scene.dialogues || [],
                  ...(plan.audioMode === 'dialogue-narration'
                    ? {
                        timing: Schema.timing(scene),
                        narrationSeconds: Schema.timing(scene).narrationSeconds,
                        referenceAudios: Schema.audioReferences(s, i),
                      }
                    : {}),
                }
              : {}),
          })),
        };
        await save(j);
        launch(j.id);
        return summary(j);
      });
      createTail = next.catch(() => {});
      return next;
    },
    async action(id, body) {
      const j = await get(id);
      if (active.has(id)) {
        if (j.status === 'running')
          throw new StoryError(409, 'VIDEO_BUSY', '该任务正在处理，请等待状态更新');
        await active.get(id).promise;
      }
      const s = await store.get(j.storyId);
      if (s.version !== j.version)
        throw new StoryError(409, 'STALE_VIDEO', '这是旧版剧本的视频，请为当前版本重新制作');
      if (body?.action === 'approveScene') {
        if (
          !j.productionId ||
          body.productionId !== j.productionId ||
          j.status !== 'quality_review' ||
          j.scenes[body.index]?.status !== 'done' ||
          j.scenes[body.index]?.quality === 'passed'
        )
          throw new StoryError(409, 'QUALITY_APPROVAL_INVALID', '镜头检查状态已变化，请刷新');
        j.scenes[body.index].quality = 'passed';
        j.status = 'running';
        await save(j);
        launch(id);
        return summary(j);
      }
      if (body?.action === 'accept') {
        if (body.previewConfirmed !== true)
          throw new StoryError(400, 'PREVIEW_REQUIRED', '请先预览成片并确认采用');
        if (!['ready', 'accepted'].includes(j.status))
          throw new StoryError(409, 'VIDEO_NOT_READY', '成片尚未完成');
        if (['story60-refs-v1', 'cinema-refs-v1'].includes(j.profile))
          await artJobs.approved(j.art.id, j.art.revision, j.storyId, j.version);
        await store.bindVideo(j.storyId, j.version, j.id);
        j.status = 'accepted';
        await save(j);
        return summary(j);
      }
      if (body?.action === 'resume') {
        if (['ready', 'accepted', 'needs_review'].includes(j.status)) return summary(j);
        j.status = 'running';
        await save(j);
        launch(id);
        return summary(j);
      }
      const index = body?.index;
      if (!Number.isInteger(index) || index < 0 || index >= j.scenes.length)
        throw new StoryError(400, 'INVALID_SCENE', '镜头编号无效');
      const scene = j.scenes[index];
      if (body.action === 'attach') {
        if (
          !['unknown', 'submitting'].includes(scene.status) ||
          typeof body.requestId !== 'string' ||
          !/^[a-zA-Z0-9_.:-]{1,300}$/.test(body.requestId)
        )
          throw new StoryError(400, 'INVALID_REQUEST_ID', '请填写华龙后台中的有效任务编号');
        scene.requestId = body.requestId;
        scene.status = 'pending';
      } else if (body.action === 'retry') {
        checkVoices(j, s);
        if (body.confirmCharge !== true)
          throw new StoryError(
            400,
            'CHARGE_CONFIRM_REQUIRED',
            '重做会新增一次镜头生成，请明确确认',
          );
        if (!['done', 'failed', 'unknown', 'submitting', 'stale'].includes(scene.status))
          throw new StoryError(409, 'SCENE_PENDING', '已有任务仍在生成，请继续查询');
        if (scene.status === 'done' || scene.status === 'stale') {
          const old = path.join(root, j.id, 'scene-' + index + '.mp4');
          const archived = 'scene-' + index + '-archived-' + randomUUID() + '.mp4';
          try {
            await fs.copyFile(old, path.join(root, j.id, archived));
            (scene.previousVersions ||= []).push({
              file: archived,
              createdAt: new Date().toISOString(),
              duration: scene.duration,
              requestId: scene.requestId,
            });
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }
        }
        for (
          let n = index + 1;
          n < j.scenes.length && j.scenes[n].startSource === 'previous';
          n++
        ) {
          if (j.scenes[n].status === 'done') {
            j.scenes[n].status = 'stale';
            j.scenes[n].message = '前镜已更改，旧视频保留，需重新确认衔接。';
          }
        }
        scene.requestId = null;
        scene.status = 'queued';
        scene.quality = null;
        scene.message = '';
        scene.explicitRetry = true;
        scene.reuse = null;
        scene.outputFingerprint = null;
      } else throw new StoryError(400, 'INVALID_ACTION', '不支持此任务操作');
      await store.unbindVideo(j.storyId, j.id);
      j.status = 'running';
      await save(j);
      launch(id);
      return summary(j);
    },
    async recover() {
      for (const j of await list()) {
        if (j.status === 'running' && !j.productionId) launch(j.id);
      }
    },
    async check() {
      const cred = await config.loadCredential();
      const data = await request(cred.provider + '/models', {
        headers: { Authorization: 'Bearer ' + cred.apiKey },
      });
      return {
        authenticated: true,
        listed: Array.isArray(data.data) ? data.data.some((m) => m.id === cred.model) : null,
        model: cred.model,
        message:
          '鉴权检查完成。模型列表不代表视频权限和协议已验证；电影方案先验证免费旁白时长，再逐镜检查原生对白；旧制作方案继续兼容。',
      };
    },
    async mediaFile(id, name) {
      if (!validId(id)) throw new StoryError(404, 'MEDIA_NOT_FOUND', '找不到视频');
      const j = await get(id);
      const archived = /^scene-(\d+)-archived-[a-f0-9-]{36}\.mp4$/.exec(name);
      if (archived && j.scenes[Number(archived[1])]?.previousVersions?.some((v) => v.file === name))
        return path.join(root, id, name);
      if (!/^((scene-\d+)|intro)\.mp4$/.test(name))
        throw new StoryError(404, 'MEDIA_NOT_FOUND', '找不到视频');
      if (
        (name === 'intro.mp4' && !['ready', 'accepted'].includes(j.status)) ||
        (name !== 'intro.mp4' &&
          !['done', 'stale'].includes(j.scenes[Number(name.match(/scene-(\d+)/)?.[1])]?.status))
      )
        throw new StoryError(404, 'MEDIA_NOT_READY', '视频尚未准备好');
      return path.join(root, id, name);
    },
    async close() {
      stopped = true;
      for (const { c } of active.values()) c.abort();
      await Promise.all([...active.values()].map((v) => v.promise));
    },
  };
  const performAction = service.action;
  service.action = (id, body) => {
    const next = (actionTails.get(id) || Promise.resolve()).then(() => performAction(id, body));
    const done = next
      .catch(() => {})
      .finally(() => {
        if (actionTails.get(id) === done) actionTails.delete(id);
      });
    actionTails.set(id, done);
    return next;
  };
  return service;
}
module.exports = { createVideoJobs };
