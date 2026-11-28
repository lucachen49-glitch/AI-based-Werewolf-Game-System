'use strict';
const { guardedFetch } = require('./upstream-guard.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const V = require('./voices.js');
const Limits = require('./limits.js');
const MAX_AUDIO = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
class SpeechError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function validateSpeech(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    !['neural', 'api'].includes(body.provider) ||
    typeof body.text !== 'string' ||
    !body.text.trim() ||
    Limits.unicodeLength(body.text) > Limits.SPEECH_CHAR_LIMIT
  )
    throw new SpeechError(400, 'INVALID_SPEECH', '发言内容为空或过长，请缩短后重试');
  if (
    !Object.hasOwn(V.styles, body.style) ||
    body.style === 'auto' ||
    ![0.85, 1, 1.15].includes(body.speed)
  )
    throw new SpeechError(400, 'INVALID_VOICE_STYLE', '声音风格或语速设置不正确');
  if (body.provider === 'neural' && !V.voices.some((v) => v.id === body.voice))
    throw new SpeechError(400, 'INVALID_VOICE', '请选择列表中的自然音色');
  if (body.provider === 'api') {
    if (
      typeof body.model !== 'string' ||
      !body.model.trim() ||
      body.model.length > 200 ||
      typeof body.voice !== 'string' ||
      !body.voice.trim() ||
      body.voice.length > 100
    )
      throw new SpeechError(400, 'INVALID_SPEECH_CONFIG', '请填写语音模型和音色 ID');
    if (typeof body.apiKey !== 'string' || body.apiKey.length > 8192 || /[\r\n]/.test(body.apiKey))
      throw new SpeechError(400, 'INVALID_SPEECH_KEY', '语音密钥格式不正确');
    normalizeSpeechEndpoint(body.endpoint);
  }
}
function normalizeSpeechEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new SpeechError(400, 'INVALID_SPEECH_ENDPOINT', '请填写完整的语音接口地址');
  }
  if (
    url.username ||
    url.password ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw new SpeechError(400, 'INVALID_SPEECH_ENDPOINT', '语音接口需使用 HTTPS 或本机 HTTP 地址');
  const p = url.pathname.replace(/\/+$/, '');
  if (!p || p === '/v1') url.pathname = '/v1/audio/speech';
  if (/\/chat\/completions$/.test(p))
    throw new SpeechError(
      400,
      'INVALID_SPEECH_ENDPOINT',
      '这里需要语音接口地址，请填写网站根地址或 /v1/audio/speech',
    );
  url.hash = '';
  return url.href;
}
function pythonSpeech(body, { signal, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const local = path.join(
      __dirname,
      '.voice-venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
    const python =
      process.env.NIGHTFALL_VOICE_PYTHON ||
      (fs.existsSync(local) ? local : process.platform === 'win32' ? 'python' : 'python3');
    const child = spawnImpl(python, [path.join(__dirname, 'scripts/synthesize-speech.py')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let chunks = [],
      bytes = 0,
      diagnostic = '',
      settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(data);
    };
    const abort = () => {
      child.kill();
      const error = new Error('Cancelled');
      error.name = 'AbortError';
      finish(error);
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () =>
      finish(
        new SpeechError(503, 'VOICE_NOT_READY', '自然语音尚未安装，请双击 setup-voice.cmd 后重试'),
      ),
    );
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_AUDIO) {
        child.kill();
        finish(new SpeechError(502, 'VOICE_TOO_LARGE', '语音文件过大，请缩短发言'));
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (diagnostic.length < 128) diagnostic += chunk.toString('utf8').slice(0, 128);
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      if (code !== 0 || bytes < 128)
        return finish(
          new SpeechError(
            503,
            diagnostic.includes('VOICE_DEPENDENCY') ? 'VOICE_NOT_READY' : 'VOICE_NETWORK_ERROR',
            diagnostic.includes('VOICE_DEPENDENCY')
              ? '自然语音尚未安装，请双击 setup-voice.cmd 后重试'
              : '自然语音服务暂不可用，请检查网络或稍后重试；可在声音设置中更换语音方式',
          ),
        );
      finish(null, Buffer.concat(chunks));
    });
    if (signal?.aborted) return abort();
    child.stdin.end(
      JSON.stringify({
        text: V.spokenText(body.text),
        voice: body.voice,
        ...V.prosody(body.style, body.speed, body.voice),
      }),
    );
  });
}
function abortError() {
  const error = new Error('Cancelled');
  error.name = 'AbortError';
  return error;
}
function withAttemptTimeout(operation, { signal, timeoutMs }) {
  if (signal?.aborted) return Promise.reject(abortError());
  const controller = new AbortController();
  let timer,
    timedOut = false,
    abort;
  const externalAbort = new Promise((_, reject) => {
    if (!signal) return;
    abort = () => {
      controller.abort();
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new SpeechError(504, 'VOICE_TIMEOUT', '单次语音生成超过 90 秒'));
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(() => operation(controller.signal)),
    timeout,
    externalAbort,
  ])
    .catch((error) => {
      if (signal?.aborted) throw abortError();
      if (timedOut) throw new SpeechError(504, 'VOICE_TIMEOUT', '单次语音生成超过 90 秒');
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    });
}
function waitForRetry(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function validateAudio(data) {
  const audio = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (
    audio.length < 128 ||
    audio.length > MAX_AUDIO ||
    !(audio.subarray(0, 3).toString() === 'ID3' || (audio[0] === 255 && (audio[1] & 224) === 224))
  )
    throw new SpeechError(502, 'INVALID_AUDIO', '语音接口返回的音频格式不正确，需要 MP3');
  return audio;
}
function retryable(error) {
  if (error.name === 'AbortError') return false;
  if (
    error.code === 'VOICE_NETWORK_ERROR' ||
    error.code === 'VOICE_TIMEOUT' ||
    error.code === 'INVALID_AUDIO'
  )
    return true;
  if (error.code === 'SPEECH_UPSTREAM_ERROR')
    return error.status === 408 || error.status === 429 || error.status >= 500;
  return !(error instanceof SpeechError) && error.name !== 'AbortError';
}
function normalizeFailure(error) {
  if (error instanceof SpeechError) return error;
  if (
    ['UPSTREAM_PRIVATE_ADDRESS', 'ERR_UPSTREAM_REDIRECT', 'ERR_UPSTREAM_UPGRADE'].includes(
      error?.code,
    )
  )
    return new SpeechError(error.status || 502, error.code, error.message);
  if (error?.name === 'AbortError') return error;
  const messages = {
    VOICE_NOT_READY: '自然语音尚未安装，请双击 setup-voice.cmd 后重试',
    VOICE_NETWORK_ERROR: '语音服务暂不可用，请检查网络或声音设置',
    VOICE_TIMEOUT: '语音生成超时，请稍后重试',
    INVALID_AUDIO: '语音接口返回的音频格式不正确，需要 MP3',
    VOICE_TOO_LARGE: '语音文件过大，请缩短发言',
  };
  if (messages[error?.code])
    return new SpeechError(
      Number.isInteger(error.status) ? error.status : 502,
      error.code,
      messages[error.code],
    );
  return new SpeechError(502, 'VOICE_NETWORK_ERROR', '语音服务暂不可用，请检查网络或声音设置');
}
async function synthesizeApi(body, { signal, fetchImpl }) {
  const response = await fetchImpl(normalizeSpeechEndpoint(body.endpoint), {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(body.apiKey ? { Authorization: `Bearer ${body.apiKey.trim()}` } : {}),
    },
    body: JSON.stringify({
      model: body.model.trim(),
      voice: body.voice.trim(),
      input: body.text,
      response_format: 'mp3',
      speed: body.speed,
      instructions:
        '请用自然口语中文演绎这位桌游玩家的原句，像真人坐在桌边交谈，保留自然的停顿和轻重音，避免播音腔、逐字朗读或增加台词。' +
        V.styles[body.style].instruction,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const msg =
      response.status === 401
        ? '语音密钥无效，请检查声音设置'
        : response.status === 403
          ? '语音服务拒绝访问，请检查权限'
          : response.status === 404
            ? '语音接口或模型不存在，请检查声音设置'
            : response.status === 408
              ? '语音服务处理超时'
              : response.status === 429
                ? '语音服务请求过于频繁，请稍后重试'
                : response.status >= 500
                  ? '语音服务暂不可用，请稍后重试'
                  : '语音服务返回请求错误，请核对模型、音色和接口配置';
    throw new SpeechError(response.status, 'SPEECH_UPSTREAM_ERROR', msg);
  }
  if (
    !/^(audio\/(?:mpeg|mp3)|application\/octet-stream)(?:;|$)/i.test(
      response.headers.get('content-type') || '',
    )
  ) {
    await response.body?.cancel();
    throw new SpeechError(502, 'INVALID_AUDIO', '语音接口未返回 MP3 音频，请核对模型和接口');
  }
  if (!response.body) throw new SpeechError(502, 'INVALID_AUDIO', '语音接口没有返回音频');
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_AUDIO) {
        await reader.cancel();
        throw new SpeechError(502, 'VOICE_TOO_LARGE', '语音文件过大，请缩短发言');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
async function speechAudio(
  body,
  {
    signal,
    fetchImpl = guardedFetch,
    synthesizeImpl = pythonSpeech,
    attemptTimeoutMs = Limits.SPEECH_ATTEMPT_TIMEOUT_MS,
  } = {},
) {
  validateSpeech(body);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const audio = await withAttemptTimeout(
        async (attemptSignal) => {
          const raw =
            body.provider === 'neural'
              ? await synthesizeImpl(body, { signal: attemptSignal })
              : await synthesizeApi(body, { signal: attemptSignal, fetchImpl });
          return validateAudio(raw);
        },
        { signal, timeoutMs: attemptTimeoutMs },
      );
      return audio;
    } catch (rawError) {
      const error = normalizeFailure(rawError);
      error.attempts = attempt;
      if (signal?.aborted) {
        error.name = 'AbortError';
        throw error;
      }
      if (!retryable(error) || attempt === MAX_ATTEMPTS) throw error;
      try {
        await waitForRetry(attempt === 1 ? 350 : 700, signal);
      } catch (abort) {
        abort.attempts = attempt;
        throw abort;
      }
    }
  }
  throw new SpeechError(502, 'VOICE_NETWORK_ERROR', '语音服务暂不可用，请稍后重试');
}
module.exports = {
  speechAudio,
  pythonSpeech,
  validateSpeech,
  normalizeSpeechEndpoint,
  SpeechError,
};
