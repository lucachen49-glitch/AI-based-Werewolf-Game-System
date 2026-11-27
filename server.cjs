'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { speechAudio, SpeechError } = require('./voice.cjs');
const { createImageConfigStore, ImageConfigError } = require('./image-config.cjs');
const {
  createAgentConfigStore,
  AgentConfigError,
  MAX_BYTES: AGENT_CONFIG_MAX_BYTES,
} = require('./agent-config.cjs');
const AgentRequest = require('./agent-request.js');
const Limits = require('./limits.js');
const { randomUUID } = require('node:crypto');
const { requestAgent, requestAgentWithRetry } = require('./agent-transport.cjs');
const { createAgentLogger, safeEntry } = require('./agent-log.cjs');
const { assertSameOrigin, assertJSON } = require('./request-guard.cjs');
const base = __dirname;
const APP_SCRIPTS = require('./app-manifest.cjs');
const allowed = new Set([
  'index.html',
  'styles.css',
  'limits.js',
  ...APP_SCRIPTS,
  'engine.js',
  'voices.js',
  'observer.js',
  'spectator.js',
  'assets/rules-6.mp3',
  'assets/rules-12.mp3',
  'image-settings.html',
  'image-settings.css',
  'image-settings.js',
  'manor.js',
  'manor.css',
  'manor-twelve.css',
  'theme.css',
  'soundfx.js',
  'assets/music/manor-nocturne.ogg',
  'assets/sfx/wolf-howl-v3.wav',
  ...require('./soundfx.js').names.map((n) => 'assets/sfx/' + n + '.wav'),
  ...[
    'manor-room',
    'manor-table',
    ...Array.from({ length: 12 }, (_, i) => 'portrait-' + String(i + 1).padStart(2, '0')).flatMap(
      (id) => [id, id + '-thumb', id + '-closed'],
    ),
  ].map((id) => 'assets/manor/' + id + '.webp'),
]);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};
allowed.add('assets/sfx/wolf-attack-v4.wav');
for (const name of require('./soundfx.js').names) allowed.add(require('./soundfx.js').source(name));
Object.values(require('./soundfx.js').musicTracks).forEach((file) => allowed.add(file));
[
  'avatar.js',
  'agent-request.js',
  'workshop-auto-ui.js',
  'workshop-auto.css',
  'recording-surface.js',
  'story-subtitle-ui.js',
  'recording.js',
  'recording.css',
  'portrait.js',
  'portrait.css',
  'api-wait.js',
  'fullscreen.css',
  'character-intros.js',
  'character-intro-ui.js',
  'character-intro.css',
  'scenario.js',
  'story-player.js',
  'story-game.js',
  'story.css',
  'scenario-settings.html',
  'scenario-settings.css',
  'scenario-settings.js',
  'scenario-review-ui.js',
  'story-art-ui.js',
  'workshop-state.js',
  'workshop-flow.js',
  'workshop-preview.js',
  'workshop-preview-ui.js',
].forEach((f) => allowed.add(f));
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
// Main page: AI-generated text is rendered as HTML, so scripts are limited to bundled files.
const MAIN_PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const localUpstreamDefault = () => process.env.NIGHTFALL_ALLOW_LOCAL_UPSTREAM === '1';
function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    loopback.has(host) ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '[::]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    /^\[::ffff:(?:127\.|7f)/.test(host)
  );
}
// Upstreams on this machine are opt-in, so the local service cannot be used to probe other local ports.
function normalizeEndpoint(endpoint, { allowLoopback = localUpstreamDefault() } = {}) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ApiError(400, 'INVALID_ENDPOINT', '接口地址格式不正确，请填写完整的网址');
  }
  if (
    url.username ||
    url.password ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url.hostname)))
  ) {
    throw new ApiError(400, 'INVALID_ENDPOINT', '请使用 HTTPS 地址，或本机 HTTP 接口');
  }
  if (!allowLoopback && isLocalHost(url.hostname)) {
    throw new ApiError(
      400,
      'INVALID_ENDPOINT',
      '本机模型接口默认关闭。如需连接 Ollama、LM Studio 等本机服务，请设置环境变量 NIGHTFALL_ALLOW_LOCAL_UPSTREAM=1 后重启游戏服务。',
    );
  }
  return AgentRequest.responsesEndpoint(url.href);
}

function sendJSON(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function validHost(req) {
  try {
    const url = new URL(`http://${req.headers.host}`);
    return (
      !url.username &&
      !url.password &&
      loopback.has(url.hostname) &&
      Number(url.port || 80) === req.socket.localPort
    );
  } catch {
    return false;
  }
}

function readJSON(req, limit) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    function cleanup() {
      req.off('data', data);
      req.off('end', end);
      req.off('aborted', aborted);
      req.off('error', error);
    }
    function fail(reason) {
      cleanup();
      req.resume();
      reject(reason);
    }
    function data(chunk) {
      bytes += chunk.length;
      if (bytes > limit)
        return fail(
          new ApiError(
            413,
            'REQUEST_TOO_LARGE',
            '完整历史上下文超过本地服务的请求容量上限，系统未删减或概括内容，请检查容量后手动处理',
          ),
        );
      chunks.push(chunk);
    }
    function end() {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, 'INVALID_JSON', '请求内容不是有效的 JSON'));
      }
    }
    function aborted() {
      fail(new ApiError(400, 'REQUEST_CANCELLED', '请求已取消'));
    }
    function error() {
      fail(new ApiError(400, 'REQUEST_READ_ERROR', '读取请求失败，请重试'));
    }
    req.on('data', data);
    req.once('end', end);
    req.once('aborted', aborted);
    req.once('error', error);
  });
}

function validateChat(body) {
  if (body?.purpose !== undefined && !['connection-test', 'game-action'].includes(body.purpose))
    throw new ApiError(400, 'INVALID_CONFIG', 'Agent 请求用途无效');
  if (
    body?.requestId !== undefined &&
    (typeof body.requestId !== 'string' || !/^[-a-zA-Z0-9_]{1,80}$/.test(body.requestId))
  )
    throw new ApiError(400, 'INVALID_CONFIG', 'Agent 请求编号无效');
  if (
    body?.gameId !== undefined &&
    (typeof body.gameId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.gameId))
  )
    throw new ApiError(400, 'INVALID_CONFIG', '对局编号无效');
  if (
    body?.action !== undefined &&
    (!body.action ||
      typeof body.action !== 'object' ||
      !['speech', 'night', 'vote', 'hunter'].includes(body.action.task) ||
      (body.action.role !== undefined &&
        !['狼人', '守卫', '预言家', '女巫', '猎人', '平民'].includes(body.action.role)) ||
      !Number.isInteger(body.action.seat) ||
      body.action.seat < 1 ||
      body.action.seat > 12 ||
      !Number.isInteger(body.action.round) ||
      body.action.round < 1 ||
      (body.action.allowedTargets !== undefined &&
        (!Array.isArray(body.action.allowedTargets) ||
          body.action.allowedTargets.length > 12 ||
          body.action.allowedTargets.some(
            (seat) => !Number.isInteger(seat) || seat < 1 || seat > 12,
          ))))
  )
    throw new ApiError(400, 'INVALID_CONFIG', 'Agent 行动信息无效');
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    typeof body.endpoint !== 'string' ||
    body.endpoint.length > 4096 ||
    typeof body.model !== 'string' ||
    !body.model.trim() ||
    body.model.length > 200
  ) {
    throw new ApiError(400, 'INVALID_CONFIG', '请填写接口地址和模型名称');
  }
  if (
    body.reasoningEffort !== undefined &&
    !AgentRequest.SUPPORTED_REASONING_EFFORTS.includes(body.reasoningEffort)
  ) {
    throw new ApiError(400, 'INVALID_REASONING_EFFORT', '推理强度请使用 high 或 xhigh。');
  }
  if (
    body.maxTokens !== undefined &&
    ![350, 4000, Limits.AGENT_OUTPUT_MAX_TOKENS].includes(body.maxTokens)
  ) {
    throw new ApiError(
      400,
      'INVALID_MAX_TOKENS',
      'Agent 输出预算为 25000 tokens，兼容旧页面的 350 或 4000 设置。',
    );
  }
  if (
    body.apiKey !== undefined &&
    (typeof body.apiKey !== 'string' || body.apiKey.length > 8192 || /[\r\n]/.test(body.apiKey))
  ) {
    throw new ApiError(400, 'INVALID_KEY', 'API Key 格式不正确，请重新填写');
  }
  if (
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.length > 128 ||
    body.messages.some(
      (m) =>
        !m ||
        !['system', 'developer', 'user', 'assistant'].includes(m.role) ||
        typeof m.content !== 'string',
    )
  ) {
    throw new ApiError(400, 'INVALID_MESSAGES', '消息内容格式不正确');
  }
}

function isContextCapacityError(detail) {
  const patterns = [
    /context[_\s-]*(?:length|window|size)/,
    /(?:上下文|提示词|输入|请求内容).{0,32}(?:超出|超过|超限|过长|过大|容量.{0,8}不足)/,
    /(?:maximum|max(?:imum)?|exceed(?:s|ed)?|too many).{0,48}(?:context|(?:input|prompt) tokens?)/,
    /(?:context|prompt|input).{0,48}(?:exceed|too (?:long|large)|(?:maximum|max)(?:imum)? (?:length|size|tokens?)|limit)/,
    /(?:prompt|input)(?:_tokens?)?.{0,48}(?:exceed|too (?:long|large)|maximum|max|limit)/,
  ];
  return patterns.some((pattern) => pattern.test(detail));
}

function upstreamError(status, data, reasoningEffort) {
  const detail = [
    data?.error?.code,
    data?.error?.type,
    data?.error?.message,
    data?.error,
    data?.code,
    data?.message,
  ]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  // Classify provider details without echoing them: they may contain credentials.
  if (isContextCapacityError(detail))
    return new ApiError(
      status,
      'CONTEXT_CAPACITY_EXCEEDED',
      '完整对局上下文超过当前模型或接口的容量上限。系统未删减或概括历史信息，当前行动已暂停，请检查接口容量后手动处理。',
    );
  const reasoning =
    AgentRequest.reasoningFailure(status, data, reasoningEffort) ||
    AgentRequest.protocolFailure(status, data);
  if (reasoning) return new ApiError(reasoning.status, reasoning.code, reasoning.message);
  if (
    status === 401 ||
    /invalid_api_key|api_key_required|incorrect api key|invalid api key/.test(detail)
  )
    return new ApiError(status, 'AUTH_FAILED', 'API Key 无效或未填写，请检查密钥');
  if (status === 402 || /insufficient_quota|insufficient balance|余额不足/.test(detail))
    return new ApiError(status, 'QUOTA_EXCEEDED', '接口余额或额度不足，请检查供应商账户');
  if (
    /model_not_found|invalid_model|model.*(not found|does not exist|not available|not supported|access|permission)|unknown model|模型.*(不存在|不可用|无权限|不支持)/.test(
      detail,
    )
  )
    return new ApiError(
      status,
      'MODEL_UNAVAILABLE',
      '模型不存在、暂不可用或当前账户无权使用，请核对模型名称和权限',
    );
  if (status === 403)
    return new ApiError(status, 'ACCESS_DENIED', '供应商拒绝访问，请检查账户权限或接口访问限制');
  if (status === 404 || status === 405)
    return new ApiError(
      status,
      'ENDPOINT_NOT_FOUND',
      '接口路径不正确，请核对完整的 Responses 地址',
    );
  if (status === 429)
    return new ApiError(status, 'RATE_LIMITED', '请求过于频繁或额度受限，请稍后重试');
  if (status === 408 || status === 504)
    return new ApiError(status, 'UPSTREAM_TIMEOUT', '供应商响应超时，请稍后重试');
  return new ApiError(
    status,
    'UPSTREAM_ERROR',
    `供应商返回错误（HTTP ${status}），请检查接口配置或稍后重试`,
  );
}
function upstreamNetworkError(error) {
  const code = error?.cause?.code || error?.code;
  if (code === 'EACCES' || code === 'EPERM')
    return new ApiError(
      502,
      'UPSTREAM_NETWORK_PERMISSION_DENIED',
      '游戏服务的外网连接被系统权限阻止，请重新启动游戏服务；若仍失败，请检查防火墙或安全软件的网络访问权限。',
    );
  return new ApiError(
    502,
    'UPSTREAM_NETWORK_ERROR',
    '无法连接模型接口，请检查接口地址、网络或证书',
  );
}

async function readUpstream(response, controller) {
  if (!response.body) return null;
  const chunks = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        controller.abort();
        throw new ApiError(502, 'INVALID_RESPONSE', '接口返回内容过大，请检查接口地址');
      }
      chunks.push(Buffer.from(value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return null;
    }
  } finally {
    reader.releaseLock();
  }
}

function validateChatEnvelope(req, limit) {
  if (!assertSameOrigin(req, { write: true }))
    throw new ApiError(403, 'INVALID_ORIGIN', '请从游戏本机启动地址访问页面');
  if (!assertJSON(req)) throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请使用 JSON 格式发送请求');
  if (Number(req.headers['content-length']) > limit)
    throw new ApiError(
      413,
      'REQUEST_TOO_LARGE',
      '完整历史上下文超过本地服务的请求容量上限，系统未删减或概括内容，请检查容量后手动处理',
    );
}

// Single actions and batch items share protocol validation, diagnostics and transport.
function assistantOutputText(data) {
  if (!Array.isArray(data?.output)) return undefined;
  const items = data.output.filter(
    (item) => item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content),
  );
  const finals = items.filter((item) => item.phase === 'final_answer');
  const selected = finals.length ? finals : items.filter((item) => item.phase !== 'commentary');
  const text = selected
    .flatMap((item) =>
      item.content
        .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
        .map((part) => part.text),
    )
    .join('\n');
  return text || undefined;
}

async function executeChat(body, options, controller, onRequest = () => {}) {
  const startedAt = Date.now(),
    gameAction = body?.purpose === 'game-action';
  let timer,
    timedOut = false,
    diagnostic = null,
    httpStatus,
    responseData,
    gameRequestKey = null;
  const log = (event, code, details = {}) => {
    if (diagnostic)
      options.agentLogger({
        ...diagnostic,
        event,
        code,
        httpStatus,
        durationMs: Date.now() - startedAt,
        activeGameRequests: options.activeGameRequests?.size || 0,
        ...details,
      });
  };
  try {
    if (gameAction) {
      const metadata = safeEntry({
        requestId: body.requestId,
        gameId: body.gameId,
        task: body.action?.task,
        seat: body.action?.seat,
        round: body.action?.round,
      });
      diagnostic = {
        requestId: metadata.requestId || randomUUID(),
        gameId: metadata.gameId,
        task: metadata.task,
        seat: metadata.seat,
        round: metadata.round,
      };
      onRequest(diagnostic.requestId);
      log('started');
    }
    validateChat(body);
    if (diagnostic && ['speech', 'vote', 'night', 'hunter'].includes(body.action?.task))
      diagnostic.requestContext = body.messages;
    if (Buffer.byteLength(JSON.stringify(body)) > options.maxRequestBytes)
      throw new ApiError(
        413,
        'REQUEST_TOO_LARGE',
        '完整历史上下文超过本地服务的请求容量上限，系统未删减或概括内容，请检查容量后手动处理',
      );
    const endpoint = (options.normalizeEndpoint || normalizeEndpoint)(body.endpoint);
    if (!gameAction && options.activeGameRequests?.size)
      throw new ApiError(
        409,
        'GAME_REQUESTS_ACTIVE',
        '当前仍有游戏 Agent 请求正在处理，请等待本局请求完成后再测试连接',
      );
    const requestTimeoutMs = gameAction
      ? options.gameRequestTimeoutMs
      : Math.min(options.upstreamTimeoutMs, options.connectionTimeoutMs);
    if (requestTimeoutMs > 0)
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, requestTimeoutMs);
    const requestBody = AgentRequest.responsesBody({
      model: body.model,
      messages: body.messages,
      reasoning_effort: gameAction ? body.reasoningEffort : null,
      max_tokens: gameAction
        ? Limits.ACTION_OUTPUT_MAX_TOKENS
        : Limits.CONNECTION_TEST_OUTPUT_MAX_TOKENS,
      actionTask: gameAction ? body.action?.task : undefined,
      actionRole: gameAction ? body.action?.role : undefined,
      allowedTargets: body.action?.allowedTargets,
      nightOptions: body.action?.nightOptions,
    });
    if (diagnostic && requestBody.text) diagnostic.requestedFormat = requestBody.text.format.type;
    if (controller.signal.aborted) throw Object.assign(Error('Cancelled'), { name: 'AbortError' });
    if (gameAction) {
      gameRequestKey = randomUUID();
      options.beginGameRequest?.(gameRequestKey, {
        requestId: diagnostic?.requestId,
        gameId: diagnostic?.gameId,
        task: diagnostic?.task,
        seat: diagnostic?.seat,
        round: diagnostic?.round,
      });
    }
    const upstream = await (gameAction ? options.gameFetchImpl : options.connectionFetchImpl)(
      endpoint,
      {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        timeoutMs: requestTimeoutMs,
        ...(gameAction
          ? {}
          : { retries: options.connectionRetries, retryDelayMs: options.connectionRetryDelayMs }),
        headers: {
          'Content-Type': 'application/json',
          ...(body.apiKey ? { Authorization: 'Bearer ' + body.apiKey.trim() } : {}),
        },
        body: JSON.stringify(requestBody),
      },
    );
    httpStatus = upstream.status;
    const data = await readUpstream(upstream, controller);
    responseData = data;
    if (!upstream.ok) throw upstreamError(upstream.status, data, body.reasoningEffort);
    if (diagnostic && ['speech', 'vote', 'night', 'hunter'].includes(body.action?.task))
      diagnostic.assistantResponse = assistantOutputText(data);
    const result = AgentRequest.gameResponse(data, {
      actionTask: gameAction ? body.action?.task : undefined,
    });
    if (controller.signal.aborted) throw Object.assign(Error('Cancelled'), { name: 'AbortError' });
    if (diagnostic) {
      const content = AgentRequest.responseText(data);
      diagnostic.assistantResponse = content;
      const messages = data.output.filter(
        (item) => item?.type === 'message' && item.role === 'assistant',
      );
      diagnostic.reportedFormat = data.text?.format?.type;
      diagnostic.responseChars = Array.from(content).length;
      diagnostic.assistantMessageCount = messages.length;
      diagnostic.commentaryMessageCount = messages.filter(
        (item) => item.phase === 'commentary',
      ).length;
      diagnostic.finalMessageCount = messages.filter(
        (item) => item.phase === 'final_answer',
      ).length;
      try {
        AgentRequest.parseActionJSON(content);
      } catch (error) {
        diagnostic.jsonIssue = error.jsonIssue;
      }
    }
    log('response_received', undefined, {
      assistantResponse: diagnostic?.assistantResponse ?? result.choices[0].message.content,
    });
    return result;
  } catch (error) {
    const failure = timedOut
      ? new ApiError(
          504,
          'UPSTREAM_TIMEOUT',
          `接口等待超过 ${Math.ceil((gameAction ? options.gameRequestTimeoutMs : options.connectionTimeoutMs) / 1000)} 秒，请稍后重试`,
        )
      : controller.signal.aborted
        ? new ApiError(499, 'REQUEST_CANCELLED', '请求已取消')
        : error instanceof ApiError || error instanceof AgentRequest.ResponseError
          ? error
          : upstreamNetworkError(error);
    httpStatus ??= failure.status;
    if (
      diagnostic &&
      ['speech', 'vote', 'night', 'hunter'].includes(body.action?.task) &&
      !diagnostic.assistantResponse
    )
      diagnostic.assistantResponse = assistantOutputText(responseData);
    log(controller.signal.aborted && !timedOut ? 'cancelled' : 'failed', failure.code, {
      errorMessage: failure.message,
      assistantResponse: diagnostic?.assistantResponse,
    });
    if (diagnostic) failure.requestId = diagnostic.requestId;
    throw failure;
  } finally {
    clearTimeout(timer);
    if (gameRequestKey) options.endGameRequest?.(gameRequestKey);
  }
}

async function handleChat(req, res, options) {
  const controller = new AbortController();
  let disconnected = false;
  const cancel = () => {
    disconnected = true;
    controller.abort();
  };
  const close = () => {
    if (!res.writableFinished) cancel();
  };
  req.once('aborted', cancel);
  res.once('close', close);
  try {
    validateChatEnvelope(req, options.maxRequestBytes);
    const body = await readJSON(req, options.maxRequestBytes);
    if (controller.signal.aborted) return;
    if (body?.purpose === 'game-action') {
      req.socket.setTimeout(0);
      res.setTimeout(0);
    }
    const result = await executeChat(body, options, controller, (id) =>
      res.setHeader('X-Agent-Request-Id', id),
    );
    if (!controller.signal.aborted) sendJSON(res, 200, result);
  } catch (error) {
    if (disconnected || res.destroyed) return;
    const failure =
      error instanceof ApiError || error instanceof AgentRequest.ResponseError
        ? error
        : upstreamNetworkError(error);
    if (failure.code === 'GAME_REQUESTS_ACTIVE') res.setHeader('Retry-After', '1');
    sendJSON(res, failure.status, {
      error: { code: failure.code, message: failure.message },
      ...(failure.requestId ? { requestId: failure.requestId } : {}),
    });
  } finally {
    req.off('aborted', cancel);
    res.off('close', close);
  }
}

async function handleChatBatch(req, res, options) {
  const controllers = new Set();
  let disconnected = false;
  const cancel = () => {
    disconnected = true;
    for (const controller of controllers) controller.abort();
  };
  const close = () => {
    if (!res.writableFinished) cancel();
  };
  req.once('aborted', cancel);
  res.once('close', close);
  const emit = (event) => {
    if (!disconnected && !res.destroyed && !res.writableEnded)
      res.write(JSON.stringify(event) + '\n');
  };
  try {
    const limit = options.maxRequestBytes * 12;
    validateChatEnvelope(req, limit);
    const body = await readJSON(req, limit);
    if (disconnected) return;
    if (
      body?.gameId !== undefined &&
      (typeof body.gameId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.gameId))
    )
      throw new ApiError(400, 'INVALID_CONFIG', '对局编号无效');
    if (!Array.isArray(body?.requests) || body.requests.length < 1 || body.requests.length > 12)
      throw new ApiError(400, 'INVALID_BATCH', '批次需要 1 至 12 个独立席位');
    const seats = new Set(),
      ids = new Set();
    const batchTask = body.requests[0]?.action?.task;
    if (!['vote', 'night'].includes(batchTask))
      throw new ApiError(400, 'INVALID_BATCH', '批次仅支持投票或狼人独立选刀');
    for (const item of body.requests) {
      const validTask =
        item?.action?.task === batchTask && (batchTask === 'vote' || item.action.role === '狼人');
      if (
        !item ||
        item.purpose !== 'game-action' ||
        !validTask ||
        !Number.isInteger(item.action.seat) ||
        item.action.seat < 1 ||
        item.action.seat > 12 ||
        !Number.isInteger(item.action.round) ||
        item.action.round < 1 ||
        typeof item.requestId !== 'string' ||
        !/^[-a-zA-Z0-9_]{1,80}$/.test(item.requestId) ||
        seats.has(item.action.seat) ||
        ids.has(item.requestId)
      )
        throw new ApiError(400, 'INVALID_BATCH', '批次席位、行动类型或请求编号无效');
      seats.add(item.action.seat);
      ids.add(item.requestId);
    }
    req.socket.setTimeout(0);
    res.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    await Promise.all(
      body.requests.map(async (item) => {
        const controller = new AbortController();
        controllers.add(controller);
        if (disconnected) controller.abort();
        const identity = { requestId: item.requestId, seat: item.action.seat };
        emit({ type: 'started', ...identity });
        try {
          const result = await executeChat(item, options, controller);
          emit({ type: 'result', ...identity, result });
        } catch (error) {
          emit({
            type: 'error',
            ...identity,
            status: error.status,
            error: { code: error.code, message: error.message },
          });
        } finally {
          controllers.delete(controller);
        }
      }),
    );
    emit({ type: 'complete' });
    if (!disconnected && !res.destroyed) res.end();
  } catch (error) {
    if (!disconnected && !res.destroyed) {
      const failure =
        error instanceof ApiError
          ? error
          : new ApiError(500, 'BATCH_ERROR', '投票批次请求失败，请手动重试');
      if (res.headersSent) {
        emit({ type: 'batch-error', error: { code: failure.code, message: failure.message } });
        res.end();
      } else
        sendJSON(res, failure.status, { error: { code: failure.code, message: failure.message } });
    }
  } finally {
    req.off('aborted', cancel);
    res.off('close', close);
  }
}

async function handleAgentEvent(req, res, agentLogger) {
  try {
    if (req.method !== 'POST')
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', '此接口仅支持 POST 请求');
    if (!assertSameOrigin(req, { write: true }))
      throw new ApiError(403, 'INVALID_ORIGIN', '请从游戏本机启动地址访问页面');
    if (!assertJSON(req))
      throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请使用 JSON 格式发送请求');
    const body = await readJSON(req, 4096);
    const codes = new Set([
      'ACTION_VALIDATED',
      'INVALID_AGENT_RESPONSE',
      'AGENT_OUTPUT_TRUNCATED',
      'INVALID_ACTION',
      'AGENT_WAIT_CANCELLED',
      'AGENT_CONFIG_CHANGED',
    ]);
    if (
      !body ||
      typeof body.requestId !== 'string' ||
      !/^[-a-zA-Z0-9_]{1,80}$/.test(body.requestId) ||
      (body.gameId !== undefined &&
        (typeof body.gameId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.gameId))) ||
      !codes.has(body.code)
    )
      throw new ApiError(400, 'INVALID_CONFIG', 'Agent 诊断信息无效');
    const event =
      body.code === 'ACTION_VALIDATED'
        ? 'action_validated'
        : body.code === 'AGENT_WAIT_CANCELLED'
          ? 'stopped'
          : 'validation_failed';
    agentLogger(safeEntry({ ...body, event }));
    sendJSON(res, 200, { saved: true });
  } catch (error) {
    const failure =
      error instanceof ApiError ? error : new ApiError(500, 'AGENT_LOG_ERROR', '诊断日志暂不可用');
    sendJSON(res, failure.status, { error: { code: failure.code, message: failure.message } });
  }
}

async function handleGameLog(req, res, gameDirectory, gameId) {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', '此接口仅支持下载本局日志');
    }
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(gameId))
      throw new ApiError(400, 'INVALID_CONFIG', '对局编号无效');
    const root = path.resolve(gameDirectory),
      file = path.resolve(root, gameId + '.jsonl');
    if (!file.startsWith(root + path.sep))
      throw new ApiError(400, 'INVALID_CONFIG', '对局编号无效');
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new ApiError(404, 'GAME_LOG_NOT_FOUND', '本局还没有 Agent 请求日志');
      throw error;
    }
    if (!stat.isFile()) throw new ApiError(404, 'GAME_LOG_NOT_FOUND', '本局还没有 Agent 请求日志');
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename=\"nightfall-game-${gameId}.jsonl\"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': stat.size,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file)
      .on('error', (error) => {
        if (!res.headersSent)
          sendJSON(res, 500, {
            error: { code: 'GAME_LOG_READ_ERROR', message: '本局日志暂时不可读取' },
          });
        else res.destroy(error);
      })
      .pipe(res);
  } catch (error) {
    const failure =
      error instanceof ApiError
        ? error
        : new ApiError(500, 'GAME_LOG_READ_ERROR', '本局日志暂时不可读取');
    if (!res.writableEnded)
      sendJSON(res, failure.status, { error: { code: failure.code, message: failure.message } });
  }
}
async function handleSpeech(req, res, options) {
  const controller = new AbortController();
  let timedOut = false,
    entered = false,
    timer;
  const cancel = () => controller.abort();
  const close = () => {
    if (!res.writableFinished) cancel();
  };
  req.once('aborted', cancel);
  res.once('close', close);
  try {
    if (!assertSameOrigin(req, { write: true }))
      throw new ApiError(403, 'INVALID_ORIGIN', '请从游戏本机启动地址访问页面');
    if (!assertJSON(req))
      throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请使用 JSON 格式发送请求');
    if (Number(req.headers['content-length']) > 32768)
      throw new ApiError(413, 'REQUEST_TOO_LARGE', '语音请求内容过大');
    const body = await readJSON(req, 32768);
    if (controller.signal.aborted) return;
    if (options.state.active >= 2)
      throw new ApiError(429, 'VOICE_BUSY', '语音正在生成，请稍候再试听');
    options.state.active++;
    entered = true;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.speechTimeoutMs);
    const data = await speechAudio(body, {
      signal: controller.signal,
      fetchImpl: options.fetchImpl,
      synthesizeImpl: options.synthesizeImpl,
    });
    if (controller.signal.aborted || res.destroyed) return;
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch (error) {
    if (res.destroyed) return;
    const failure = timedOut
      ? new ApiError(504, 'VOICE_TIMEOUT', '语音生成总等待时间已用完，请重试当前语音')
      : error instanceof ApiError || error instanceof SpeechError
        ? error
        : new ApiError(502, 'VOICE_NETWORK_ERROR', '语音服务暂不可用，请检查网络或声音设置');
    const attempts = Number.isInteger(error?.attempts) ? error.attempts : timedOut ? 3 : 1;
    sendJSON(res, failure.status, {
      error: { code: failure.code, message: failure.message, attempts },
    });
  } finally {
    clearTimeout(timer);
    if (entered) options.state.active--;
    req.off('aborted', cancel);
    res.off('close', close);
  }
}
async function handleImageConfig(req, res, store) {
  try {
    if (!assertSameOrigin(req, { write: req.method === 'POST' }))
      throw new ApiError(403, 'INVALID_ORIGIN', '请从游戏本机启动地址打开图片设置。');
    if (req.method === 'GET') return sendJSON(res, 200, await store.status());
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', '此接口仅支持读取和保存图片配置。');
    }
    if (!assertJSON(req))
      throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请使用图片设置页面保存。');
    if (Number(req.headers['content-length']) > 16384)
      throw new ApiError(413, 'REQUEST_TOO_LARGE', '图片配置内容过大。');
    const body = await readJSON(req, 16384);
    return sendJSON(res, 200, await store.save(body));
  } catch (error) {
    const failure =
      error instanceof ApiError || error instanceof ImageConfigError
        ? error
        : new ApiError(500, 'IMAGE_CONFIG_ERROR', '图片配置暂不可用，请稍后重试。');
    sendJSON(res, failure.status, { error: { code: failure.code, message: failure.message } });
  }
}
async function handleAgentConfig(req, res, store) {
  try {
    if (!assertSameOrigin(req, { write: req.method === 'POST' }))
      throw new ApiError(403, 'INVALID_ORIGIN', '请从游戏本机启动地址打开 Agent 配置。');
    if (req.method === 'GET') {
      const loaded = await store.load();
      return sendJSON(
        res,
        200,
        loaded
          ? { configured: true, ...loaded, storage: 'Windows 当前用户加密保存' }
          : {
              configured: false,
              profiles: null,
              savedAt: null,
              storage: 'Windows 当前用户加密保存',
            },
      );
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', '此接口仅支持读取和保存 Agent 配置。');
    }
    if (!assertJSON(req))
      throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请使用游戏页面保存 Agent 配置。');
    if (Number(req.headers['content-length']) > AGENT_CONFIG_MAX_BYTES + 16384)
      throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Agent 配置内容过大，请缩小自定义头像后重试。');
    const body = await readJSON(req, AGENT_CONFIG_MAX_BYTES + 16384);
    if (!body || Array.isArray(body) || !Array.isArray(body.profiles))
      throw new ApiError(400, 'INVALID_AGENT_CONFIG', 'Agent 配置格式不正确。');
    return sendJSON(res, 200, {
      configured: true,
      ...(await store.save(body.profiles, { clientSavedAt: body.clientSavedAt })),
      storage: 'Windows 当前用户加密保存',
    });
  } catch (error) {
    const failure =
      error instanceof ApiError || error instanceof AgentConfigError
        ? error
        : new ApiError(500, 'AGENT_CONFIG_ERROR', '本机 Agent 配置暂不可用，请稍后重试。');
    sendJSON(res, failure.status, { error: { code: failure.code, message: failure.message } });
  }
}
function createServer({
  fetchImpl = fetch,
  gameFetchImpl = requestAgent,
  connectionFetchImpl = fetchImpl === fetch ? requestAgentWithRetry : fetchImpl,
  connectionTimeoutMs = Limits.AGENT_CONNECTION_TIMEOUT_MS,
  connectionRetries = 1,
  connectionRetryDelayMs = 150,
  agentLogger = createAgentLogger(),
  agentGameLogDirectory = path.join(base, 'logs', 'agent-games'),
  upstreamTimeoutMs = Limits.AGENT_UPSTREAM_TIMEOUT_MS,
  gameRequestTimeoutMs = Limits.AGENT_UPSTREAM_TIMEOUT_MS,
  maxRequestBytes = 1024 * 1024,
  speechTimeoutMs = Limits.SPEECH_UPSTREAM_TIMEOUT_MS,
  synthesizeImpl,
  imageConfigStore = createImageConfigStore(),
  storyStore,
  videoConfigStore,
  videoJobs,
  artJobs,
  recordingOptions,
  recoverVideoJobs = true,
  agentConfigStore = createAgentConfigStore(),
  allowLoopbackUpstream = localUpstreamDefault(),
} = {}) {
  const instanceVersion = randomUUID();
  const activeGameRequests = new Map();
  const beginGameRequest = (key, details) =>
    activeGameRequests.set(key, { ...details, startedAt: Date.now() });
  const endGameRequest = (key) => activeGameRequests.delete(key);
  const endpointFor = (endpoint) =>
    normalizeEndpoint(endpoint, { allowLoopback: allowLoopbackUpstream });
  const chatOptions = {
    normalizeEndpoint: endpointFor,
    fetchImpl,
    connectionFetchImpl,
    gameFetchImpl,
    connectionTimeoutMs,
    connectionRetries,
    connectionRetryDelayMs,
    upstreamTimeoutMs,
    gameRequestTimeoutMs,
    maxRequestBytes,
    agentLogger,
    activeGameRequests,
    beginGameRequest,
    endGameRequest,
  };
  const speechOptions = { fetchImpl, speechTimeoutMs, synthesizeImpl, state: { active: 0 } };
  const stories = require('./story-api.cjs').createStoryAPI({
    fetchImpl,
    store: storyStore,
    config: videoConfigStore,
    jobs: videoJobs,
    artJobs,
    imageConfig: imageConfigStore,
    readJSON,
    sendJSON,
    validateChat,
    normalizeEndpoint: endpointFor,
    readUpstream,
    upstreamError,
  });
  const recordings = require('./recording-api.cjs').createRecordingAPI({
    sendJSON,
    readJSON,
    ...recordingOptions,
  });
  const server = http.createServer((req, res) => {
    if (!validHost(req))
      return sendJSON(res, 403, {
        error: { code: 'INVALID_HOST', message: '请使用本机游戏地址访问' },
      });
    let name;
    try {
      name =
        decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\//, '') ||
        'index.html';
    } catch {
      res.writeHead(400);
      return res.end('Bad request');
    }
    if (
      /^api\/(scenarios|scenario-reviews|video-config|video-jobs|story-media|story-art-jobs|story-art-media|story-assets|story-art-import|story-key-assets|story-preview-jobs|story-preview-media|story-title-jobs|story-title-media|story-subtitles|story-subtitle-media|story-productions)(?:\/|$)/.test(
        name,
      )
    ) {
      void stories.handle(req, res, name);
      return;
    }
    if (/^api\/recordings(?:\/|$)/.test(name)) {
      void recordings.handle(req, res, name);
      return;
    }
    if (name === 'api/image-config') {
      void handleImageConfig(req, res, imageConfigStore);
      return;
    }
    if (name === 'api/agent-config') {
      void handleAgentConfig(req, res, agentConfigStore);
      return;
    }
    if (name === 'api/agent-events') {
      void handleAgentEvent(req, res, agentLogger);
      return;
    }
    const gameLogMatch = /^api\/game-logs\/([a-zA-Z0-9_-]{1,80})$/.exec(name);
    if (gameLogMatch) {
      void handleGameLog(req, res, agentGameLogDirectory, gameLogMatch[1]);
      return;
    }
    if (name === 'api/chat/batch') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJSON(res, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: '此接口仅支持 POST 请求' },
        });
      }
      void handleChatBatch(req, res, chatOptions);
      return;
    }
    if (name === 'api/chat') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJSON(res, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: '此接口仅支持 POST 请求' },
        });
      }
      void handleChat(req, res, chatOptions);
      return;
    }
    if (name === 'api/speech') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJSON(res, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: '此接口仅支持 POST 请求' },
        });
      }
      void handleSpeech(req, res, speechOptions);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end('Method not allowed');
    }
    if (!allowed.has(name)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    if (name === 'index.html') {
      res.setHeader('Content-Security-Policy', MAIN_PAGE_CSP);
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
    }
    if (name.startsWith('image-settings.') || name.startsWith('scenario-settings.')) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
    }
    fs.readFile(path.join(base, name), (error, data) => {
      if (error) {
        res.writeHead(500);
        return res.end('Read error');
      }
      res.writeHead(200, {
        'Content-Type': types[path.extname(name)],
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
  server.once('listening', () => {
    if (recoverVideoJobs) void stories.recover();
  });
  server.once('close', () => {
    recordings.close();
    void stories.close();
  });
  server.storyService = stories;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4173);
  createServer().listen(port, '127.0.0.1', () =>
    console.log(`夜幕之下已就绪：http://127.0.0.1:${port}`),
  );
}
module.exports = { createServer, normalizeEndpoint };
