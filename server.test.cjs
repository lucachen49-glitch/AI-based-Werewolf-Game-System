'use strict';
function agentResponse(text) {
  return {
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
  };
}
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { createServer, normalizeEndpoint } = require('./server.cjs');
const AgentRequest = require('./agent-request.js');

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, options = {}) {
  const seen = [];
  const provider = http.createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const entry = { url: req.url, headers: req.headers, body: JSON.parse(text) };
      seen.push(entry);
      if (options.handler) return await options.handler(req, res, entry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          ...agentResponse('OK'),
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        }),
      );
    } catch {
      if (!res.destroyed) res.end();
    }
  });
  const endpoint = await listen(t, provider);
  const base = await listen(
    t,
    createServer({
      agentLogger: () => {},
      allowLoopbackUpstream: true,
      ...options,
      recoverVideoJobs: false,
    }),
  );
  const profile = {
    endpoint,
    apiKey: 'test-secret-only',
    model: 'gpt-6-astra',
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  };
  const post = (body = {}, config = {}) =>
    fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', ...config.headers },
      body: JSON.stringify({ ...profile, ...body }),
      ...config,
    });
  return { base, endpoint, profile, post, seen };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('等待取消信号超时')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('隔离测试服务不恢复用户视频任务，正式服务仍自动恢复', async (t) => {
  for (const recoverVideoJobs of [false, true]) {
    let recovered = 0;
    const videoJobs = {
      recover: async () => {
        recovered++;
      },
      close: async () => {},
    };
    await listen(t, createServer({ recoverVideoJobs, videoJobs }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recovered, recoverVideoJobs ? 1 : 0);
  }
});

test('地址补全只处理根地址和 /v1，保留完整自定义路径', () => {
  for (const suffix of ['', '/', '/v1', '/v1/', '/v1///'])
    assert.equal(
      normalizeEndpoint(`https://api.hualong-ai.com${suffix}`),
      'https://api.hualong-ai.com/v1/responses',
    );
  for (const endpoint of [
    'https://example.test/v1/chat/completions',
    'https://example.test/custom/chat?version=2',
    'http://localhost:1234/v1/chat/completions',
  ])
    assert.equal(
      normalizeEndpoint(endpoint, { allowLoopback: true }),
      endpoint.replace(/\/chat\/completions(?=\?|$)/, '/responses'),
    );
  for (const endpoint of [
    'bad address',
    'ftp://example.test',
    'http://example.test',
    'https://user:password@example.test',
  ])
    assert.throws(() => normalizeEndpoint(endpoint));
});

test('本机 Agent 上游默认关闭，显式开启后允许回环 HTTP', async (t) => {
  for (const endpoint of [
    'http://localhost:11434/api',
    'http://127.0.0.2:1234/v1',
    'http://[::1]:8080/v1',
  ]) {
    assert.throws(
      () => normalizeEndpoint(endpoint),
      (error) => error.status === 400 && /NIGHTFALL_ALLOW_LOCAL_UPSTREAM=1/.test(error.message),
    );
    assert.equal(
      normalizeEndpoint(endpoint, { allowLoopback: true }),
      AgentRequest.responsesEndpoint(endpoint),
    );
  }
  let targetHit = false;
  const target = await listen(
    t,
    http.createServer((req, res) => {
      targetHit = true;
      res.end(JSON.stringify(agentResponse('OK')));
    }),
  );
  const { base, post } = await fixture(t, { allowLoopbackUpstream: false });
  const response = await post({ endpoint: target });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /NIGHTFALL_ALLOW_LOCAL_UPSTREAM=1/);
  assert.equal(targetHit, false);
  const enabled = await fixture(t, { allowLoopbackUpstream: true });
  const allowedResponse = await enabled.post({ endpoint: target });
  assert.equal(allowedResponse.status, 200);
  assert.equal(targetHit, true);
});

test('本机 Agent 上游默认值由环境变量显式控制', () => {
  const previous = process.env.NIGHTFALL_ALLOW_LOCAL_UPSTREAM;
  try {
    delete process.env.NIGHTFALL_ALLOW_LOCAL_UPSTREAM;
    assert.throws(
      () => normalizeEndpoint('http://localhost:11434/v1'),
      (error) => error.status === 400,
    );
    process.env.NIGHTFALL_ALLOW_LOCAL_UPSTREAM = '1';
    assert.equal(
      normalizeEndpoint('http://localhost:11434/v1'),
      AgentRequest.responsesEndpoint('http://localhost:11434/v1'),
    );
  } finally {
    if (previous === undefined) delete process.env.NIGHTFALL_ALLOW_LOCAL_UPSTREAM;
    else process.env.NIGHTFALL_ALLOW_LOCAL_UPSTREAM = previous;
  }
});

test('关键视觉素材接口通过统一故事路由暴露', async (t) => {
  const { base } = await fixture(t);
  const storyId = randomUUID();
  const list = await fetch(`${base}/api/story-key-assets?storyId=${storyId}&roomSize=6`);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), []);
  const create = await fetch(`${base}/api/story-key-assets`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(create.status, 400);
  assert.equal((await create.json()).error.code, 'INVALID_KEY_ASSET');
  const action = await fetch(`${base}/api/story-key-assets/${randomUUID()}`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'confirm' }),
  });
  assert.equal(action.status, 404);
  assert.equal((await action.json()).error.code, 'KEY_ASSET_NOT_FOUND');
});
test('真实 HTTP 转发不依赖供应商 CORS，模型密钥独立，响应保持兼容', async (t) => {
  const { post, seen } = await fixture(t);
  const first = await post();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await first.json(), {
    id: 'mock',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  });
  assert.equal(seen[0].url, '/v1/responses');
  assert.equal(seen[0].headers.authorization, 'Bearer test-secret-only');
  assert.equal(seen[0].headers.origin, undefined);
  assert.deepEqual(seen[0].body, {
    model: 'gpt-6-astra',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }],
    max_output_tokens: 350,
    stream: false,
    store: false,
  });
  const second = await post({ model: 'another-model', apiKey: 'another-key' });
  assert.equal(second.status, 200);
  assert.equal(seen[1].body.model, 'another-model');
  assert.equal(seen[1].headers.authorization, 'Bearer another-key');
  assert.equal(seen[1].body.max_output_tokens, 350);
  assert.equal(seen[1].body.reasoning, undefined);
  const speech = await post({ maxTokens: 4000 });
  assert.equal(speech.status, 200);
  assert.equal(seen[2].body.max_output_tokens, 350);
  assert.equal(seen[2].body.reasoning, undefined);
  for (const maxTokens of [0, 351, 3999, 4001])
    assert.equal((await post({ maxTokens })).status, 400);
  assert.equal(JSON.stringify(seen.map((s) => s.body)).includes('test-secret-only'), false);
});

test('完整接口地址不重复补全，不携带密钥时不伪造鉴权', async (t) => {
  const { endpoint, post, seen } = await fixture(t);
  await post({ endpoint: `${endpoint}/custom/chat?test=1`, apiKey: '' });
  assert.equal(seen[0].url, '/custom/chat?test=1');
  assert.equal(seen[0].headers.authorization, undefined);
});

test('供应商错误分类且不回显包含密钥的原始报错', async (t) => {
  const cases = [
    [401, 'API_KEY_REQUIRED', 'AUTH_FAILED'],
    [402, 'insufficient_quota', 'QUOTA_EXCEEDED'],
    [404, 'model_not_found', 'MODEL_UNAVAILABLE'],
    [403, 'model_permission_denied', 'MODEL_UNAVAILABLE'],
    [403, 'forbidden', 'ACCESS_DENIED'],
    [404, 'not_found', 'ENDPOINT_NOT_FOUND'],
    [405, 'method_not_allowed', 'ENDPOINT_NOT_FOUND'],
    [429, 'rate_limit', 'RATE_LIMITED'],
    [504, 'timeout', 'UPSTREAM_TIMEOUT'],
    [500, 'internal_error', 'UPSTREAM_ERROR'],
  ];
  for (const [status, code, expected] of cases)
    await t.test(`${status} ${code}`, async (t) => {
      const { post } = await fixture(t, {
        handler(req, res) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code, message: 'test-secret-only' } }));
        },
      });
      const response = await post();
      assert.equal(response.status, status);
      const data = await response.json();
      assert.equal(data.error.code, expected);
      assert.equal(JSON.stringify(data).includes('test-secret-only'), false);
    });
});

test('完整对局上下文超出供应商容量时明确分类并安全暂停', async (t) => {
  const cases = [
    [
      400,
      {
        code: 'context_length_exceeded',
        message: 'private-vendor-detail: maximum context length exceeded',
      },
    ],
    [
      400,
      {
        type: 'invalid_request_error',
        message: 'The input is too long for this model context window',
      },
    ],
    [413, { code: 'request_too_large', message: 'input tokens exceed provider capacity' }],
    [400, { code: 'invalid_request', message: '本次输入的上下文超过模型容量，请缩短输入' }],
  ];
  for (const [status, error] of cases)
    await t.test(error.code || error.type || String(status), async (t) => {
      const entries = [];
      const { post, seen } = await fixture(t, {
        agentLogger: (entry) => entries.push(entry),
        handler(req, res) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error }));
        },
      });
      const response = await post({
        purpose: 'game-action',
        requestId: 'context-capacity-check',
        action: { task: 'night', role: '狼人', seat: 2, round: 5, allowedTargets: [1, 2] },
        messages: [{ role: 'user', content: '全部公开发言与事件历史' }],
      });
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body.error.code, 'CONTEXT_CAPACITY_EXCEEDED');
      assert.match(body.error.message, /完整对局上下文超过.*容量上限/);
      assert.match(body.error.message, /未删减或概括历史信息/);
      assert.equal(body.requestId, 'context-capacity-check');
      assert.equal(seen.length, 1);
      const failure = entries.at(-1);
      assert.equal(failure.event, 'failed');
      assert.equal(failure.code, 'CONTEXT_CAPACITY_EXCEEDED');
      assert.equal(failure.requestId, 'context-capacity-check');
      assert.match(failure.requestContext[0].content, /全部公开发言与事件历史/);
      assert.doesNotMatch(JSON.stringify([body, entries]), /private-vendor-detail/);
    });
  const { post } = await fixture(t, {
    handler(req, res) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { param: 'max_output_tokens', message: 'maximum output tokens is 25000' },
        }),
      );
    },
  });
  const outputLimit = await post();
  assert.equal((await outputLimit.json()).error.code, 'UPSTREAM_ERROR');
});
test('HTML、缺失字段和空响应不被误判为连接成功', async (t) => {
  for (const content of [
    '<html>homepage</html>',
    JSON.stringify({ choices: [] }),
    JSON.stringify(agentResponse('')),
    '',
  ])
    await t.test(content || 'empty', async (t) => {
      const { post } = await fixture(t, {
        handler(req, res) {
          res.end(content);
        },
      });
      const response = await post();
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, 'INVALID_AGENT_RESPONSE');
    });
});

test('网络和证书异常给出安全错误，不返回底层敏感信息', async (t) => {
  const { post } = await fixture(t, {
    fetchImpl: async () => {
      throw Error('TLS failed test-secret-only');
    },
  });
  const response = await post();
  assert.equal(response.status, 502);
  const data = await response.json();
  assert.equal(data.error.code, 'UPSTREAM_NETWORK_ERROR');
  assert.match(data.error.message, /网络或证书/);
  assert.equal(JSON.stringify(data).includes('test-secret-only'), false);
});

test('服务网络权限错误给出重启提示，保留安全错误边界且不重复请求', async (t) => {
  for (const code of ['EACCES', 'EPERM']) {
    let attempts = 0;
    const { post } = await fixture(t, {
      fetchImpl: async () => {
        attempts++;
        throw new TypeError('fetch failed test-secret-only', {
          cause: Object.assign(Error('test-secret-only'), { code }),
        });
      },
    });
    const response = await post();
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.error.code, 'UPSTREAM_NETWORK_PERMISSION_DENIED');
    assert.match(data.error.message, /系统权限阻止.*重新启动游戏服务/);
    assert.doesNotMatch(JSON.stringify(data), /test-secret-only/);
    assert.equal(attempts, 1);
  }
});

test('拒绝跨来源、伪造 Host、非法协议、消息和非 JSON 请求', async (t) => {
  const { base, post, seen } = await fixture(t);
  for (const origin of ['https://foreign.example', 'null', '']) {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const forgedHost = await new Promise((resolve, reject) => {
    const request = http.request(
      `${base}/api/chat`,
      {
        method: 'POST',
        headers: { Host: 'foreign.example', Origin: base, 'Content-Type': 'application/json' },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(forgedHost, 403);
  assert.equal(
    (
      await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'text/plain' },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal((await fetch(`${base}/api/chat`)).status, 405);
  for (const body of [
    { endpoint: 'http://foreign.example' },
    { endpoint: 'file:///private' },
    { model: '' },
    { apiKey: 'key\r\ninjected-header:value' },
    { messages: [] },
    { messages: [{ role: 'user', content: 42 }] },
  ])
    assert.equal((await post(body)).status, 400);
  assert.equal(
    (
      await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
    400,
  );
  assert.equal(seen.length, 0);
});

test('请求大小限制覆盖 Content-Length 和分块发送', async (t) => {
  const { base, post, seen, profile } = await fixture(t, { maxRequestBytes: 1024 });
  assert.equal(
    (await post({ messages: [{ role: 'user', content: '字'.repeat(1100) }] })).status,
    413,
  );
  const body = Readable.from([
    JSON.stringify({ ...profile, messages: [{ role: 'user', content: 'x'.repeat(1500) }] }),
  ]);
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body,
    duplex: 'half',
  });
  assert.equal(response.status, 413);
  assert.equal(seen.length, 0);
});

test('超时会中断上游，包括响应头已返回但响应体卡住的情况', async (t) => {
  let providerClosed;
  const closed = new Promise((resolve) => {
    providerClosed = resolve;
  });
  const { post } = await fixture(t, {
    upstreamTimeoutMs: 80,
    handler(req, res) {
      res.on('close', providerClosed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
    },
  });
  const response = await post();
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'UPSTREAM_TIMEOUT');
  await bounded(closed);
});

test('网页取消时关闭正在等待的上游请求', async (t) => {
  let providerStarted, providerClosed;
  const started = new Promise((resolve) => {
      providerStarted = resolve;
    }),
    closed = new Promise((resolve) => {
      providerClosed = resolve;
    });
  const { post } = await fixture(t, {
    handler(req, res) {
      res.on('close', providerClosed);
      providerStarted();
    },
  });
  const controller = new AbortController(),
    pending = post({}, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await bounded(started);
  controller.abort();
  await rejected;
  await bounded(closed);
});

test('接口重定向不会携带密钥继续请求其他地址', async (t) => {
  let targetHit = false;
  const target = await listen(
    t,
    http.createServer((req, res) => {
      targetHit = true;
      res.end('secret destination');
    }),
  );
  const { post } = await fixture(t, {
    handler(req, res) {
      res.writeHead(307, { Location: target });
      res.end();
    },
  });
  const response = await post();
  assert.equal(response.status, 502);
  assert.equal(targetHit, false);
});

test('原页面静态资源可用，服务端源码与测试不对网页开放', async (t) => {
  const { base } = await fixture(t);
  assert.equal((await fetch(base)).status, 200);
  for (const file of [...require('./app-manifest.cjs'), 'observer.js', 'spectator.js'])
    assert.equal((await fetch(`${base}/${file}`)).status, 200);
  const workshop = await (await fetch(`${base}/scenario-settings.html`)).text(),
    scripts = [...workshop.matchAll(/<script src="([^"]+)"/g)].map((x) => x[1]);
  assert.ok(scripts.includes('scenario-review-ui.js'));
  for (const script of scripts)
    assert.equal(
      (await fetch(`${base}/${script}`)).status,
      200,
      `workshop script ${script} must be served`,
    );
  assert.equal((await fetch(`${base}/scenario-review-ui.js`)).status, 200);
  assert.equal((await fetch(`${base}/server.cjs`)).status, 404);
  assert.equal((await fetch(`${base}/server.test.cjs`)).status, 404);
});

test('庄园仅提供白名单本地 WebP 素材，制作原图、提示词和凭据不可访问', async (t) => {
  const { base } = await fixture(t),
    Manor = require('./manor.js');
  assert.equal(new Set(Manor.portraits.map((p) => p.id)).size, 12);
  assert.equal(Manor.normalize('../private', 2), 'portrait-03');
  assert.equal(Manor.imagePath('https://foreign.test/file'), null);
  assert.equal(Manor.portrait({}, 0, 12).id, 'portrait-01');
  assert.equal(Manor.portrait({}, 6, 12).id, 'portrait-07');
  assert.equal(Manor.portraits.filter((p) => p.pending).length, 0);
  for (const file of ['manor.js', 'manor.css', 'manor-twelve.css', 'theme.css'])
    assert.equal((await fetch(base + '/' + file)).status, 200);
  const files = [
    'assets/manor/manor-room.webp',
    'assets/manor/manor-table.webp',
    ...Manor.portraits
      .filter((p) => !p.pending)
      .flatMap((p) => [
        Manor.imagePath(p.id),
        Manor.imagePath(p.id, true),
        Manor.imagePath(p.id).replace('.webp', '-closed.webp'),
      ]),
  ];
  for (const file of files) {
    const response = await fetch(base + '/' + file);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 4).toString(), 'RIFF');
    assert.equal(buffer.subarray(8, 12).toString(), 'WEBP');
    assert.ok(buffer.length > 1000);
    assert.equal(Number(response.headers.get('content-length')), buffer.length);
    assert.equal((await fetch(base + '/' + file, { method: 'HEAD' })).status, 200);
  }
  for (const file of [
    'assets/manor/portrait-13.webp',
    'assets/manor/private.json',
    'output/imagegen/manor-room.png',
    'output/imagegen/prompts/manor-room.txt',
    'scripts/prepare-manor-assets.py',
    'image-config.cjs',
    'image-provider.json',
  ])
    assert.equal((await fetch(base + '/' + file)).status, 404, file);
});

test('6/12 人自然讲解 MP3 可播放下载及 HEAD 查询，制作脚本和元数据不对网页开放', async (t) => {
  const fs = require('node:fs'),
    crypto = require('node:crypto');
  const { base } = await fixture(t);
  const source = JSON.parse(fs.readFileSync('assets/rules-narration.json', 'utf8'));
  const metadata = JSON.parse(fs.readFileSync('assets/rules-audio-metadata.json', 'utf8'));
  for (const room of [6, 12]) {
    const response = await fetch(`${base}/assets/rules-${room}.mp3?v=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    const audio = Buffer.from(await response.arrayBuffer()),
      entry = metadata.rooms[room];
    assert.ok(audio.length > 10000);
    assert.equal(Number(response.headers.get('content-length')), audio.length);
    assert.equal(audio.length, entry.bytes);
    assert.equal(crypto.createHash('sha256').update(audio).digest('hex'), entry.audioSha256);
    assert.equal(
      crypto.createHash('sha256').update(source.narrations[room]).digest('hex'),
      entry.textSha256,
    );
    assert.ok(
      (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) ||
        audio.subarray(0, 3).toString() === 'ID3',
      'MP3 frame or ID3 header',
    );
    const head = await fetch(`${base}/assets/rules-${room}.mp3`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), audio.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  assert.doesNotMatch(source.narrations[6], /猎人|守卫/);
  assert.match(source.narrations[12], /先结算猎人的技能，再判断胜负/);
  for (const file of [
    'assets/rules-8.mp3',
    'assets/rules-narration.json',
    'assets/rules-audio-metadata.json',
    'scripts/generate-rule-audio.py',
  ])
    assert.equal((await fetch(`${base}/${file}`)).status, 404);
});

test('推理强度缺省和显式值按配置转发，其他值在提交前拒绝', async (t) => {
  const { post, seen } = await fixture(t);
  for (const [body, expected] of [
    [{ purpose: 'game-action' }, 'medium'],
    [{ purpose: 'game-action', reasoningEffort: 'xhigh' }, 'xhigh'],
    [{ purpose: 'game-action', reasoningEffort: 'high' }, 'high'],
    [{ purpose: 'game-action', reasoningEffort: 'medium' }, 'medium'],
  ]) {
    assert.equal((await post(body)).status, 200);
    assert.equal(seen.at(-1).body.reasoning.effort, expected);
  }
  for (const value of ['low', 'max', '', null, 1, {}, ['xhigh']]) {
    const response = await post({ reasoningEffort: value });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_REASONING_EFFORT');
  }
  assert.equal(seen.length, 4);
});

test('供应商拒绝 xhigh 时保留明确错误且不泄露凭据、不自动降级或重发', async (t) => {
  for (const status of [400, 422]) {
    const { post, seen } = await fixture(t, {
      handler(req, res) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'unsupported_value',
              param: 'reasoning_effort',
              message: 'reasoning_effort xhigh is not supported; test-secret-only',
            },
          }),
        );
      },
    });
    const response = await post({ purpose: 'game-action', reasoningEffort: 'xhigh' });
    assert.equal(response.status, status);
    const data = await response.json();
    assert.equal(data.error.code, 'REASONING_EFFORT_UNSUPPORTED');
    assert.match(data.error.message, /xhigh/);
    assert.doesNotMatch(JSON.stringify(data), /test-secret-only/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.reasoning.effort, 'xhigh');
  }
});

test('对局请求使用独立通道，慢响应头和慢响应体超过测试上限仍可完成', async (t) => {
  for (const stage of ['headers', 'body']) {
    const entries = [];
    const { post, seen } = await fixture(t, {
      upstreamTimeoutMs: 25,
      agentLogger: (entry) => entries.push(entry),
      fetchImpl: () => {
        throw Error('对局请求不应使用有限等待通道');
      },
      handler(req, res) {
        if (stage === 'body') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{');
        }
        setTimeout(() => {
          if (res.destroyed) return;
          const json = JSON.stringify(agentResponse('{"target":1}'));
          res.end(stage === 'body' ? json.slice(1) : json);
        }, 120);
      },
    });
    const response = await post({
      purpose: 'game-action',
      requestId: 'slow-' + stage,
      action: { task: 'vote', seat: 9, round: 2 },
      reasoningEffort: 'high',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-agent-request-id'), 'slow-' + stage);
    assert.equal((await response.json()).choices[0].message.content, '{"target":1}');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.reasoning.effort, 'high');
    assert.equal(seen[0].body.max_output_tokens, 25000);
    assert.equal(seen[0].body.temperature, undefined);
    assert.equal(seen[0].body.purpose, undefined);
    assert.equal(seen[0].body.action, undefined);
    assert.deepEqual(
      entries.map((x) => x.event),
      ['started', 'response_received'],
    );
    assert.ok(entries[1].durationMs >= 100);
    assert.equal(entries[1].httpStatus, 200);
  }
});

test('旧页面与连接测试保持有限等待，对局可在相同接口继续等待', async (t) => {
  const { post } = await fixture(t, {
    upstreamTimeoutMs: 1000,
    connectionTimeoutMs: 30,
    agentLogger: () => {},
    handler(req, res) {
      setTimeout(() => {
        if (!res.destroyed) res.end(JSON.stringify(agentResponse('OK')));
      }, 110);
    },
  });
  for (const body of [{}, { purpose: 'connection-test' }]) {
    const response = await post(body);
    assert.equal(response.status, 504);
    const error = await response.json();
    assert.equal(error.error.code, 'UPSTREAM_TIMEOUT');
    assert.equal(error.error.message, '接口等待超过 1 秒，请稍后重试');
  }
  assert.equal((await post({ purpose: 'game-action' })).status, 200);
});

test('对局关闭本地空闲截止时间，手动取消同时中止上游响应头和响应体等待', async (t) => {
  for (const stage of ['headers', 'body']) {
    let started, closed;
    const ready = new Promise((resolve) => (started = resolve)),
      done = new Promise((resolve) => (closed = resolve)),
      entries = [];
    const { post } = await fixture(t, {
      agentLogger: (entry) => entries.push(entry),
      handler(req, res) {
        res.once('close', closed);
        if (stage === 'body') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{');
        }
        started();
      },
    });
    const controller = new AbortController(),
      pending = post(
        { purpose: 'game-action', requestId: 'cancel-' + stage },
        { signal: controller.signal },
      );
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await bounded(ready);
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await rejected;
    await bounded(done);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(entries.at(-1).event, 'cancelled');
    assert.equal(entries.at(-1).code, 'REQUEST_CANCELLED');
    assert.equal(entries.filter((e) => e.event === 'response_received').length, 0);
  }
});

test('对局供应商504、断连和无效回复只提交一次并记录安全错误', async (t) => {
  for (const failure of ['504', 'disconnect', 'empty', 'json']) {
    const entries = [];
    const { post, seen } = await fixture(t, {
      agentLogger: (entry) => entries.push(entry),
      handler(req, res) {
        if (failure === 'disconnect') {
          res.writeHead(200);
          res.write('{');
          setTimeout(() => res.destroy(), 10);
          return;
        }
        if (failure === '504') {
          res.writeHead(504);
          res.end(JSON.stringify({ error: { message: 'test-secret-only' } }));
          return;
        }
        res.end(failure === 'empty' ? JSON.stringify(agentResponse('')) : '{');
      },
    });
    const response = await post({
      purpose: 'game-action',
      requestId: 'failure-' + failure,
      action: { task: 'speech', seat: 5, round: 2 },
    });
    assert.equal(response.status, failure === '504' ? 504 : 502);
    const data = await response.json();
    assert.equal(data.requestId, 'failure-' + failure);
    assert.equal(
      data.error.code,
      failure === '504'
        ? 'UPSTREAM_TIMEOUT'
        : failure === 'disconnect'
          ? 'UPSTREAM_NETWORK_ERROR'
          : 'INVALID_AGENT_RESPONSE',
    );
    assert.equal(seen.length, 1);
    assert.equal(entries.at(-1).event, 'failed');
    assert.doesNotMatch(JSON.stringify(data) + JSON.stringify(entries), /test-secret-only/);
    assert.equal(entries.at(-1).requestContext[0].content, 'Reply with OK.');
  }
});

test('对局通道拒绝重定向，错误中不带鉴权信息', async (t) => {
  let hit = false;
  const destination = await listen(
    t,
    http.createServer((req, res) => {
      hit = true;
      res.end();
    }),
  );
  const { post, seen } = await fixture(t, {
    agentLogger: () => {},
    handler(req, res) {
      res.writeHead(307, { Location: destination });
      res.end();
    },
  });
  const response = await post({ purpose: 'game-action' });
  assert.equal(response.status, 502);
  assert.equal(hit, false);
  assert.equal(seen.length, 1);
  assert.doesNotMatch(await response.text(), /test-secret-only/);
});

test('前端行动校验可关联安全日志，日志文件不对网页开放', async (t) => {
  const entries = [],
    { base } = await fixture(t, { agentLogger: (entry) => entries.push(entry) });
  const body = {
    requestId: 'validation-1',
    task: 'vote',
    seat: 9,
    round: 2,
    durationMs: 23,
    httpStatus: 200,
    code: 'INVALID_ACTION',
    apiKey: 'secret-log-only',
    role: '狼人',
    messages: ['private'],
    reply: 'private',
  };
  const send = (payload, origin = base) =>
    fetch(base + '/api/agent-events', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  assert.equal((await send(body)).status, 200);
  assert.equal(entries[0].event, 'validation_failed');
  assert.equal(entries[0].requestId, 'validation-1');
  assert.doesNotMatch(
    JSON.stringify(entries),
    /secret-log-only|狼人|private|apiKey|messages|reply/,
  );
  assert.equal((await send({ ...body, code: 'AGENT_WAIT_CANCELLED' })).status, 200);
  assert.equal(entries[1].event, 'stopped');
  assert.equal((await send({ ...body, code: 'invalid-secret' })).status, 400);
  assert.equal((await send(body, 'https://foreign.test')).status, 403);
  for (const name of ['logs/agent-requests.jsonl', 'agent-transport.cjs', 'agent-log.cjs'])
    assert.equal((await fetch(base + '/' + name)).status, 404);
});

test('请求日志文件记录关联时间和结束原因，舍弃正文、身份和凭据', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const { createAgentLogger } = require('./agent-log.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightfall-agent-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logs', 'agent-requests.jsonl'),
    log = createAgentLogger({ file });
  log({
    requestId: 'log-1',
    event: 'started',
    task: 'night',
    seat: 3,
    round: 2,
    apiKey: 'SECRET',
    role: '狼人',
  });
  log({
    requestId: 'log-1',
    event: 'failed',
    task: 'night',
    seat: 3,
    round: 2,
    durationMs: 123,
    httpStatus: 504,
    code: 'UPSTREAM_TIMEOUT',
    body: 'PRIVATE',
  });
  await log.flush();
  const text = fs.readFileSync(file, 'utf8'),
    rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].requestId, rows[1].requestId);
  assert.ok(Number.isFinite(Date.parse(rows[0].time)));
  assert.ok(Date.parse(rows[1].time) >= Date.parse(rows[0].time));
  assert.equal(rows[1].durationMs, 123);
  assert.equal(rows[1].code, 'UPSTREAM_TIMEOUT');
  assert.doesNotMatch(text, /SECRET|PRIVATE|狼人|apiKey|body/);
});

test('对局配置校验错误保留请求编号并记录安全日志，不请求供应商', async (t) => {
  const entries = [];
  const { post, seen } = await fixture(t, { agentLogger: (entry) => entries.push(entry) });
  const response = await post({
    purpose: 'game-action',
    requestId: 'game-config-invalid',
    endpoint: 'not-a-url',
    action: { task: 'vote', seat: 2, round: 1 },
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('x-agent-request-id'), 'game-config-invalid');
  assert.equal((await response.json()).requestId, 'game-config-invalid');
  assert.equal(seen.length, 0);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].event, 'failed');
  assert.equal(entries[1].httpStatus, 400);
  assert.equal(entries[1].code, 'INVALID_ENDPOINT');
  assert.equal(entries[1].requestId, 'game-config-invalid');
  assert.equal(entries[1].requestContext[0].content, 'Reply with OK.');
  assert.doesNotMatch(JSON.stringify(entries), /test-secret-only|not-a-url/);
});

test('Responses 失败状态关联请求编号，仅提交一次并保留具体错误', async (t) => {
  for (const [data, code] of [
    [
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      'AGENT_OUTPUT_TRUNCATED',
    ],
    [
      { status: 'failed', error: { code: 'server_error', message: 'test-secret-only' } },
      'AGENT_RESPONSE_FAILED',
    ],
    [
      {
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'refusal', refusal: 'declined' }],
          },
        ],
      },
      'AGENT_REFUSED',
    ],
  ])
    await t.test(code, async (t) => {
      const events = [];
      const { post, seen } = await fixture(t, {
        agentLogger: (e) => events.push(e),
        handler(req, res) {
          res.end(JSON.stringify(data));
        },
      });
      const response = await post({
        purpose: 'game-action',
        requestId: 'responses-error',
        action: { task: 'speech', seat: 1, round: 1 },
        maxTokens: 25000,
      });
      assert.equal(response.status, 502);
      assert.equal(response.headers.get('X-Agent-Request-Id'), 'responses-error');
      const body = await response.json();
      assert.equal(body.error.code, code);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].body.max_output_tokens, 25000);
      assert.ok(events.some((e) => e.code === code));
      assert.doesNotMatch(JSON.stringify([events, body]), /test-secret-only/);
    });
});

test('对局响应只返回最终行动并记录安全格式摘要', async (t) => {
  for (const invalid of [false, true]) {
    const entries = [];
    const content = invalid ? '{"speech":"private-speech",}' : '{"speech":"private-speech"}';
    const { post, seen } = await fixture(t, {
      agentLogger: (entry) => entries.push(entry),
      handler(req, res) {
        const response = agentResponse(content);
        response.output[0].phase = 'final_answer';
        response.output.unshift({
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"speech":"private-draft"}' }],
        });
        res.end(JSON.stringify(response));
      },
    });
    const response = await post({
      purpose: 'game-action',
      requestId: 'json-diagnostic-' + invalid,
      action: { task: 'speech', seat: 5, round: 1 },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, content);
    assert.equal(seen.length, 1);
    assert.equal(entries.at(-1).event, 'response_received');
    assert.equal(entries.at(-1).responseChars, Array.from(content).length);
    assert.equal(entries.at(-1).assistantMessageCount, 2);
    assert.equal(entries.at(-1).commentaryMessageCount, 1);
    assert.equal(entries.at(-1).finalMessageCount, 1);
    assert.equal(entries.at(-1).jsonIssue, invalid ? 'INVALID_JSON' : undefined);
    assert.equal(entries.at(-1).assistantResponse, content);
    assert.match(JSON.stringify(entries), /private-speech/);
    assert.doesNotMatch(JSON.stringify(entries), /private-draft|test-secret-only/);
  }
});

test('日志白名单保存格式原因和计数，过滤错误正文和异常诊断', () => {
  const { safeEntry } = require('./agent-log.cjs');
  const entry = safeEntry({
    jsonIssue: 'INVALID_JSON',
    responseChars: 120,
    assistantMessageCount: 2,
    commentaryMessageCount: 1,
    finalMessageCount: 1,
    reply: 'private',
    parseMessage: 'private',
  });
  assert.equal(entry.jsonIssue, 'INVALID_JSON');
  assert.equal(entry.responseChars, 120);
  assert.equal(entry.assistantMessageCount, 2);
  assert.equal(entry.commentaryMessageCount, 1);
  assert.equal(entry.finalMessageCount, 1);
  assert.doesNotMatch(JSON.stringify(entry), /private|reply|parseMessage/);
  const rejected = safeEntry({
    jsonIssue: 'private',
    responseChars: -1,
    assistantMessageCount: Infinity,
    commentaryMessageCount: 1.5,
    finalMessageCount: 2097153,
  });
  assert.equal(rejected.jsonIssue, undefined);
  assert.equal(rejected.responseChars, undefined);
  assert.equal(rejected.assistantMessageCount, undefined);
  assert.equal(rejected.commentaryMessageCount, undefined);
  assert.equal(rejected.finalMessageCount, undefined);
});

test('完整纯文字发言经过本地服务后成为有效行动，兼容已打开的游戏页面', async (t) => {
  for (const seat of [1, 6, 12])
    await t.test(String(seat), async (t) => {
      const speech = '我是' + seat + '号，第一晚是平安夜。\n\n我先听大家的发言，再给出"判断"。🌙';
      const entries = [];
      const { post, seen } = await fixture(t, {
        agentLogger: (entry) => entries.push(entry),
        handler(req, res) {
          res.end(JSON.stringify(agentResponse(speech)));
        },
      });
      const response = await post({
        purpose: 'game-action',
        requestId: 'plain-speech-' + seat,
        action: { task: 'speech', seat, round: 1 },
      });
      assert.equal(response.status, 200);
      const content = (await response.json()).choices[0].message.content;
      assert.deepEqual(require('./agent-request.js').parseActionJSON(content), { speech });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].body.text.format.type, 'json_schema');
      assert.deepEqual(
        entries.map((entry) => entry.event),
        ['started', 'response_received'],
      );
      assert.equal(entries.at(-1).assistantResponse, speech);
      assert.equal(entries.at(-1).responseChars, Array.from(speech).length);
      assert.equal(entries.at(-1).jsonIssue, 'MISSING_JSON');
      assert.doesNotMatch(JSON.stringify(entries), /test-secret-only/);
    });
});

test('响应分片拼接后保留准确的原始发言和格式诊断', async (t) => {
  for (const content of ['这是完整发言。', '{"speech":"这是完整发言。"}'])
    await t.test(content, async (t) => {
      const entries = [];
      const { post } = await fixture(t, {
        agentLogger: (entry) => entries.push(entry),
        handler(req, res) {
          const response = agentResponse('');
          response.output[0].content = [content.slice(0, 4), content.slice(4)].map((text) => ({
            type: 'output_text',
            text,
          }));
          res.end(JSON.stringify(response));
        },
      });
      const response = await post({
        purpose: 'game-action',
        action: { task: 'speech', seat: 1, round: 1 },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse((await response.json()).choices[0].message.content), {
        speech: '这是完整发言。',
      });
      assert.equal(entries.at(-1).assistantResponse, content);
      assert.equal(entries.at(-1).responseChars, Array.from(content).length);
      assert.equal(entries.at(-1).jsonIssue, content.startsWith('{') ? undefined : 'MISSING_JSON');
    });
});

test('投票、夜间、猎人和连接测试的纯文字响应保留原文供各自校验', async (t) => {
  for (const task of ['vote', 'night', 'hunter', null])
    await t.test(String(task), async (t) => {
      const speech = '我选择2号。';
      const { post, seen } = await fixture(t, {
        handler(req, res) {
          res.end(JSON.stringify(agentResponse(speech)));
        },
      });
      const body = task ? { purpose: 'game-action', action: { task, seat: 1, round: 1 } } : {};
      const response = await post(body);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).choices[0].message.content, speech);
      assert.equal(seen.length, 1);
    });
});

test('六与十二人发言按服务端行动信息添加结构化输出约束', async (t) => {
  for (const seat of [6, 12])
    await t.test(String(seat), async (t) => {
      const entries = [];
      const { post, seen } = await fixture(t, {
        agentLogger: (entry) => entries.push(entry),
        handler(req, res) {
          const response = agentResponse('{"speech":"有效的完整发言"}');
          response.text = { format: { type: 'json_schema' } };
          res.end(JSON.stringify(response));
        },
      });
      const response = await post({
        purpose: 'game-action',
        requestId: 'speech-schema-' + seat,
        action: { task: 'speech', seat, round: 1 },
        maxTokens: 350,
        reasoningEffort: 'high',
      });
      assert.equal(response.status, 200);
      assert.equal(
        (await response.json()).choices[0].message.content,
        '{"speech":"有效的完整发言"}',
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0].body.text.format.type, 'json_schema');
      assert.equal(seen[0].body.text.format.strict, true);
      assert.deepEqual(seen[0].body.text.format.schema.required, ['speech']);
      assert.equal(seen[0].body.max_output_tokens, 25000);
      assert.equal(seen[0].body.reasoning.effort, 'high');
      assert.equal(entries.at(-1).requestedFormat, 'json_schema');
      assert.equal(entries.at(-1).reportedFormat, 'json_schema');
      assert.equal(entries.at(-1).jsonIssue, undefined);
    });
});

test('连接测试不加行动格式，投票和夜间按合法目标与角色添加结构化约束', async (t) => {
  const { post, seen } = await fixture(t);
  const connection = await post({ purpose: 'connection-test' });
  assert.equal(connection.status, 200);
  assert.equal(seen.at(-1).body.max_output_tokens, 350);
  assert.equal(seen.at(-1).body.reasoning, undefined);
  assert.equal(seen.at(-1).body.text, undefined);
  const genericNight = await post({
    purpose: 'game-action',
    action: { task: 'night', seat: 6, round: 1, allowedTargets: [1, 3, 5] },
  });
  assert.equal(genericNight.status, 200);
  assert.equal(seen.at(-1).body.text.format.name, 'werewolf_night_target');
  assert.deepEqual(seen.at(-1).body.text.format.schema.properties.target, {
    type: ['integer', 'null'],
    enum: [1, 3, 5, null],
  });
  for (const [role, name] of [
    ['狼人', 'werewolf_night_wolf'],
    ['守卫', 'werewolf_night_guard'],
    ['预言家', 'werewolf_night_seer'],
  ]) {
    const response = await post({
      purpose: 'game-action',
      action: { task: 'night', role, seat: 6, round: 1, allowedTargets: [1, 3, 5] },
    });
    assert.equal(response.status, 200);
    assert.equal(seen.at(-1).body.text.format.name, name);
    assert.deepEqual(seen.at(-1).body.text.format.schema.properties.target, {
      type: ['integer', 'null'],
      enum: [1, 3, 5, null],
    });
  }
  const witch = await post({
    purpose: 'game-action',
    action: {
      task: 'night',
      role: '女巫',
      seat: 6,
      round: 1,
      allowedTargets: [1, 3, 5],
      nightOptions: { canSave: false, poisonAvailable: false },
    },
  });
  assert.equal(witch.status, 200);
  assert.equal(seen.at(-1).body.text.format.name, 'werewolf_night_witch');
  assert.deepEqual(seen.at(-1).body.text.format.schema.properties.save, {
    type: 'boolean',
    enum: [false],
  });
  assert.deepEqual(seen.at(-1).body.text.format.schema.properties.poison, {
    type: ['integer', 'null'],
    enum: [null],
  });
  const vote = await post({
    purpose: 'game-action',
    action: { task: 'vote', seat: 6, round: 1, allowedTargets: [1, 3, 5] },
  });
  assert.equal(vote.status, 200);
  assert.deepEqual(seen.at(-1).body.text.format.schema.properties.target, {
    type: ['integer', 'null'],
    enum: [1, 3, 5, null],
  });
});

test('供应商拒绝结构化输出时明确报错且只提交一次', async (t) => {
  const entries = [];
  const { post, seen } = await fixture(t, {
    agentLogger: (entry) => entries.push(entry),
    handler(req, res) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { param: 'text.format', message: 'Unsupported json_schema test-secret-only' },
        }),
      );
    },
  });
  const response = await post({
    purpose: 'game-action',
    requestId: 'schema-rejected',
    action: { task: 'speech', seat: 6, round: 1 },
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'STRUCTURED_OUTPUT_UNSUPPORTED');
  assert.equal(body.requestId, 'schema-rejected');
  assert.equal(seen.length, 1);
  assert.equal(entries.at(-1).requestedFormat, 'json_schema');
  assert.equal(entries.at(-1).code, 'STRUCTURED_OUTPUT_UNSUPPORTED');
  assert.doesNotMatch(JSON.stringify([body, entries]), /test-secret-only/);
});

test('投票请求日志记录实际上下文和最终回复并脱敏凭据', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const { createAgentLogger } = require('./agent-log.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightfall-vote-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'logs', 'agent-requests.jsonl');
  const logger = createAgentLogger({ file });
  const { post, seen } = await fixture(t, {
    agentLogger: logger,
    handler(req, res) {
      const response = agentResponse('{"target":3}');
      response.text = { format: { type: 'json_schema' } };
      res.end(JSON.stringify(response));
    },
  });
  const response = await post({
    purpose: 'game-action',
    requestId: 'vote-context-log',
    action: { task: 'vote', seat: 5, round: 3, allowedTargets: [2, 3] },
    messages: [
      { role: 'system', content: '规则及私有席位背景' },
      {
        role: 'user',
        content:
          '完整发言历史：第1轮 1号：我怀疑3号。 PK发言：3号：我会弃票。 api_key: never-log-this Bearer never-log-bearer',
      },
    ],
  });
  assert.equal(response.status, 200);
  assert.equal(seen[0].body.text.format.name, 'werewolf_vote');
  await logger.flush();
  const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const received = entries.find((entry) => entry.event === 'response_received');
  assert.equal(received.requestId, 'vote-context-log');
  assert.equal(received.task, 'vote');
  assert.equal(received.seat, 5);
  assert.equal(received.round, 3);
  assert.equal(received.requestContext[1].content.includes('完整发言历史'), true);
  assert.equal(received.assistantResponse, '{"target":3}');
  assert.equal(received.requestedFormat, 'json_schema');
  assert.equal(received.reportedFormat, 'json_schema');
  assert.ok(received.requestContext[1].content.includes('api_key: "[redacted]"'));
  assert.match(received.requestContext[1].content, /Bearer \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(entries), /test-secret-only|never-log-this|never-log-bearer/);
});

test('夜间请求日志保留有权限的私有上下文及最终回复并脱敏凭据', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const { createAgentLogger } = require('./agent-log.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightfall-night-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'logs', 'agent-requests.jsonl');
  const logger = createAgentLogger({ file });
  const { post, seen } = await fixture(t, {
    agentLogger: logger,
    handler(req, res) {
      const response = agentResponse('{"save":false,"poison":null}');
      response.text = { format: { type: 'json_schema' } };
      res.end(JSON.stringify(response));
    },
  });
  const response = await post({
    purpose: 'game-action',
    requestId: 'night-context-log',
    action: {
      task: 'night',
      role: '女巫',
      seat: 6,
      round: 3,
      allowedTargets: [1, 2, 3],
      nightOptions: { canSave: false, poisonAvailable: true },
    },
    messages: [
      { role: 'system', content: '你是女巫，只能使用自己有权获知的信息。' },
      {
        role: 'user',
        content:
          '完整公开发言和事件历史。自身药水：解药已用，毒药可用。不得包含今晚狼刀目标。 api_key: never-log-this Bearer never-log-bearer',
      },
    ],
  });
  assert.equal(response.status, 200);
  assert.equal(seen[0].body.text.format.name, 'werewolf_night_witch');
  await logger.flush();
  const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const received = entries.find((entry) => entry.event === 'response_received');
  assert.equal(received.requestId, 'night-context-log');
  assert.equal(received.task, 'night');
  assert.equal(received.seat, 6);
  assert.equal(received.round, 3);
  assert.match(received.requestContext[1].content, /完整公开发言和事件历史/);
  assert.match(received.requestContext[1].content, /解药已用，毒药可用/);
  assert.equal(received.assistantResponse, '{"save":false,"poison":null}');
  assert.equal(received.requestedFormat, 'json_schema');
  assert.equal(received.reportedFormat, 'json_schema');
  assert.ok(received.requestContext[1].content.includes('api_key: "[redacted]"'));
  assert.ok(received.requestContext[1].content.includes('Bearer [redacted]'));
  assert.doesNotMatch(JSON.stringify(entries), /never-log-this|never-log-bearer/);
});
test('投票 JSON Schema 被供应商拒绝时保留请求编号和安全错误日志', async (t) => {
  const entries = [];
  const { post, seen } = await fixture(t, {
    agentLogger: (entry) => entries.push(entry),
    handler(req, res) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { param: 'text.format', message: 'Unsupported json_schema test-secret-only' },
        }),
      );
    },
  });
  const response = await post({
    purpose: 'game-action',
    requestId: 'vote-schema-rejected',
    action: { task: 'vote', seat: 4, round: 2, allowedTargets: [1, 2] },
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'STRUCTURED_OUTPUT_UNSUPPORTED');
  assert.equal(body.requestId, 'vote-schema-rejected');
  assert.equal(seen.length, 1);
  assert.equal(entries.at(-1).requestedFormat, 'json_schema');
  assert.equal(entries.at(-1).code, 'STRUCTURED_OUTPUT_UNSUPPORTED');
  assert.doesNotMatch(JSON.stringify([body, entries]), /test-secret-only/);
});

test('格式诊断仅保存允许的请求与返回格式名称', () => {
  const { safeEntry } = require('./agent-log.cjs');
  assert.equal(
    safeEntry({ requestedFormat: 'json_schema', reportedFormat: 'text' }).requestedFormat,
    'json_schema',
  );
  assert.equal(
    safeEntry({ requestedFormat: 'json_schema', reportedFormat: 'text' }).reportedFormat,
    'text',
  );
  const invalid = safeEntry({
    requestedFormat: 'private-key',
    reportedFormat: { secret: 'private' },
  });
  assert.equal(invalid.requestedFormat, undefined);
  assert.equal(invalid.reportedFormat, undefined);
});

test('单个对局请求进行中时连接测试立即返回忙碌，结束后恢复正常', async (t) => {
  let gameResponse;
  let gameStarted;
  const started = new Promise((resolve) => (gameStarted = resolve));
  const f = await fixture(t, {
    handler(req, res, entry) {
      if (entry.body.max_output_tokens === 25000) {
        gameResponse = res;
        gameStarted();
        return;
      }
      res.end(JSON.stringify(agentResponse('OK')));
    },
  });
  const game = f.post({
    purpose: 'game-action',
    requestId: 'active-single',
    action: { task: 'vote', seat: 1, round: 1 },
  });
  await bounded(started);
  const begin = Date.now();
  const blocked = await f.post({ purpose: 'connection-test' });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, 'GAME_REQUESTS_ACTIVE');
  assert.ok(Date.now() - begin < 500);
  gameResponse.end(JSON.stringify(agentResponse('{"target":1}')));
  assert.equal((await game).status, 200);
  const recovered = await f.post({ purpose: 'connection-test' });
  assert.equal(recovered.status, 200);
});

test('单个对局请求取消后清理活跃状态，连接测试可以继续', async (t) => {
  let gameStarted;
  const started = new Promise((resolve) => (gameStarted = resolve));
  const f = await fixture(t, {
    handler(req, res, entry) {
      if (entry.body.max_output_tokens === 25000) {
        gameStarted();
        return;
      }
      res.end(JSON.stringify(agentResponse('OK')));
    },
  });
  const controller = new AbortController();
  const game = f.post(
    {
      purpose: 'game-action',
      requestId: 'cancel-active',
      action: { task: 'vote', seat: 1, round: 1 },
    },
    { signal: controller.signal },
  );
  await bounded(started);
  controller.abort();
  await assert.rejects(game, { name: 'AbortError' });
  const recovered = await f.post({ purpose: 'connection-test' });
  assert.equal(recovered.status, 200);
});

test('对局批次的所有席位都纳入活跃请求计数并在批次结束后清理', async (t) => {
  const waiting = [];
  const f = await fixture(t, {
    handler(req, res, entry) {
      if (entry.body.max_output_tokens === 25000) {
        waiting.push(res);
        return;
      }
      res.end(JSON.stringify(agentResponse('OK')));
    },
  });
  const requests = batchRequests(f.profile, 2);
  const batch = await batchPost(f, requests);
  await eventually(() => waiting.length === 2);
  const blocked = await f.post({ purpose: 'connection-test' });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, 'GAME_REQUESTS_ACTIVE');
  for (const res of waiting) res.end(JSON.stringify(agentResponse('{"target":1}')));
  assert.match(await batch.text(), /"type":"complete"/);
  const recovered = await f.post({ purpose: 'connection-test' });
  assert.equal(recovered.status, 200);
});

test('对局请求达到独立超时后清理活跃状态并返回超时错误', async (t) => {
  const f = await fixture(t, {
    gameRequestTimeoutMs: 25,
    handler(req, res, entry) {
      if (entry.body.max_output_tokens === 25000) return;
      res.end(JSON.stringify(agentResponse('OK')));
    },
  });
  const response = await f.post({
    purpose: 'game-action',
    requestId: 'game-timeout',
    action: { task: 'vote', seat: 1, round: 1 },
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'UPSTREAM_TIMEOUT');
  const recovered = await f.post({ purpose: 'connection-test' });
  assert.equal(recovered.status, 200);
});

async function batchPost(f, requests, options = {}) {
  return fetch(f.base + '/api/chat/batch', {
    method: 'POST',
    headers: { Origin: f.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
    ...options,
  });
}
function batchRequests(profile, count = 6) {
  return Array.from({ length: count }, (_, i) => ({
    ...profile,
    model: 'seat-' + (i + 1),
    purpose: 'game-action',
    requestId: 'batch-request-' + (i + 1),
    action: { task: 'vote', seat: i + 1, round: 2 },
    reasoningEffort: i % 2 ? 'high' : 'xhigh',
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          seat: i + 1,
          public: '完整公开发言',
          private: '仅供席位' + (i + 1),
        }),
      },
    ],
  }));
}
async function eventually(check) {
  await bounded(
    (async () => {
      while (!check()) await new Promise((resolve) => setTimeout(resolve, 5));
    })(),
  );
}

test('投票批次并行发出六或十二席，独立Responses参数、乱序完成和其他HTTP请求可用', async (t) => {
  for (const count of [6, 12])
    await t.test(count + ' seats', async (t) => {
      const waiting = [],
        logs = [];
      const f = await fixture(t, {
        upstreamTimeoutMs: 5,
        agentLogger: (entry) => logs.push(entry),
        handler(req, res, entry) {
          waiting.push({ res, entry });
        },
      });
      const response = await batchPost(f, batchRequests(f.profile, count));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /ndjson/);
      await eventually(() => waiting.length === count);
      assert.equal((await fetch(f.base + '/')).status, 200);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(logs.filter((x) => x.event === 'failed').length, 0);
      for (const { res, entry } of waiting.slice().reverse()) {
        const seat = Number(entry.body.model.split('-')[1]);
        assert.equal(entry.body.reasoning.effort, seat % 2 ? 'xhigh' : 'high');
        assert.equal(entry.body.max_output_tokens, 25000);
        assert.equal(entry.body.stream, false);
        assert.equal(entry.url, '/v1/responses');
        assert.equal(
          entry.body.input[0].content[0].text,
          JSON.stringify({ seat, public: '完整公开发言', private: '仅供席位' + seat }),
        );
        res.end(JSON.stringify(agentResponse('{"target":null}')));
      }
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      assert.equal(events.filter((x) => x.type === 'started').length, count);
      assert.deepEqual(
        events.filter((x) => x.type === 'result').map((x) => x.seat),
        Array.from({ length: count }, (_, i) => count - i),
      );
      assert.equal(events.at(-1).type, 'complete');
      assert.equal(logs.filter((x) => x.event === 'started').length, count);
      assert.equal(logs.filter((x) => x.event === 'response_received').length, count);
      assert.doesNotMatch(JSON.stringify(logs), /test-secret-only/);
      assert.match(JSON.stringify(logs), /完整公开发言/);
      assert.match(JSON.stringify(logs), /仅供席位/);
    });
});

test('狼人夜间批次接受狼人席并应用狼刀结构化目标约束', async (t) => {
  const f = await fixture(t, {
    handler(req, res) {
      res.end(JSON.stringify(agentResponse('{"target":2}')));
    },
  });
  const wolves = batchRequests(f.profile, 2).map((request, index) => ({
    ...request,
    action: { ...request.action, task: 'night', role: '狼人', allowedTargets: [1, 2, 3] },
  }));
  const response = await batchPost(f, wolves);
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((event) => event.type === 'result').length, 2);
  assert.equal(f.seen.length, 2);
  for (const entry of f.seen) {
    assert.equal(entry.body.text.format.name, 'werewolf_night_wolf');
    assert.deepEqual(entry.body.text.format.schema.properties.target.enum, [1, 2, 3, null]);
    const seat = Number(entry.body.model.split('-')[1]);
    assert.equal(entry.body.reasoning.effort, seat % 2 ? 'xhigh' : 'high');
  }
  const mixedRole = [wolves[0], { ...wolves[1], action: { ...wolves[1].action, role: '女巫' } }];
  const mixedTask = [wolves[0], { ...wolves[1], action: { ...wolves[1].action, task: 'vote' } }];
  assert.equal((await batchPost(f, mixedRole)).status, 400);
  assert.equal((await batchPost(f, mixedTask)).status, 400);
  assert.equal(f.seen.length, 2);
});

test('投票批次独立返回错误并继续收取其他结果，断开只取消未完成项', async (t) => {
  const waiting = [],
    logs = [];
  const f = await fixture(t, {
    agentLogger: (entry) => logs.push(entry),
    handler(req, res, entry) {
      waiting.push({ res, entry });
    },
  });
  const controller = new AbortController(),
    response = await batchPost(f, batchRequests(f.profile, 3), { signal: controller.signal });
  await eventually(() => waiting.length === 3);
  waiting[0].res.end(JSON.stringify(agentResponse('{"target":2}')));
  waiting[1].res.writeHead(504, { 'Content-Type': 'application/json' });
  waiting[1].res.end(JSON.stringify({ error: { code: 'timeout', message: 'test-secret-only' } }));
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let data = '';
  while (!data.includes('"type":"error"')) data += decoder.decode((await reader.read()).value);
  assert.match(data, /"type":"result"/);
  assert.match(data, /UPSTREAM_TIMEOUT/);
  assert.doesNotMatch(data, /test-secret-only/);
  assert.equal(logs.filter((x) => x.event === 'response_received').length, 1);
  assert.equal(logs.filter((x) => x.event === 'failed').length, 1);
  controller.abort();
  await reader.read().catch(() => {});
  reader.releaseLock();
  await eventually(() => logs.some((x) => x.event === 'cancelled' && x.seat === 3));
  assert.equal(logs.filter((x) => x.event === 'cancelled').length, 1);
});

test('投票批次在任何上游调用前拒绝不合法、跨站、重复席位或非投票请求', async (t) => {
  const f = await fixture(t),
    good = batchRequests(f.profile, 2);
  for (const requests of [
    [],
    batchRequests(f.profile, 13),
    [good[0], good[0]],
    [good[0], { ...good[1], requestId: good[0].requestId }],
    [{ ...good[0], purpose: 'connection-test' }],
    [{ ...good[0], action: { ...good[0].action, task: 'speech' } }],
  ]) {
    assert.equal((await batchPost(f, requests)).status, 400);
  }
  const isolated = await batchPost(f, [{ ...good[0], reasoningEffort: 'low' }]);
  assert.equal(isolated.status, 200);
  assert.match(await isolated.text(), /INVALID_REASONING_EFFORT/);
  const denied = await batchPost(f, good, {
    headers: { Origin: 'https://untrusted.test', 'Content-Type': 'application/json' },
  });
  assert.equal(denied.status, 403);
  assert.equal(f.seen.length, 0);
});

test('批次单席配置错误不阻止其他有效席位调用与返回', async (t) => {
  const logs = [];
  const f = await fixture(t, { agentLogger: (entry) => logs.push(entry) });
  const requests = batchRequests(f.profile, 3);
  requests[1].reasoningEffort = 'low';
  const response = await batchPost(f, requests);
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(f.seen.length, 2);
  assert.deepEqual(
    events
      .filter((event) => event.type === 'result')
      .map((event) => event.seat)
      .sort(),
    [1, 3],
  );
  const failure = events.find((event) => event.type === 'error');
  assert.equal(failure.seat, 2);
  assert.equal(failure.requestId, requests[1].requestId);
  assert.equal(failure.error.code, 'INVALID_REASONING_EFFORT');
  assert.equal(logs.filter((entry) => entry.event === 'failed').length, 1);
  assert.equal(logs.filter((entry) => entry.event === 'response_received').length, 2);
});

test('行动校验诊断经真实接口写入文件，保存具体规则并过滤私有内容', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const { createAgentLogger } = require('./agent-log.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightfall-validation-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agent-requests.jsonl');
  const logger = createAgentLogger({ file });
  const { base } = await fixture(t, { agentLogger: logger });
  const diagnostic = {
    version: 1,
    rule: 'TARGET_NOT_ALLOWED',
    field: 'private-data',
    expected: 'private-data',
    reason: 'private-data',
    actualType: 'number',
    roomSize: 12,
    isInteger: true,
    inSeatRange: true,
    targetAllowed: false,
    allowedTargetCount: 8,
    fieldTypes: {
      target: 'number',
      save: 'missing',
      poison: 'missing',
      speech: 'missing',
      apiKey: 'private-data',
    },
    value: 4,
    allowedTargets: [2, 3],
    reply: 'private-data',
    apiKey: 'private-data',
    role: '狼人',
    context: { private: 'private-data' },
  };
  const response = await fetch(base + '/api/agent-events', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: 'detailed-validation-1',
      task: 'night',
      seat: 11,
      round: 1,
      durationMs: 2093,
      httpStatus: 200,
      code: 'INVALID_ACTION',
      responseChars: 12,
      validation: diagnostic,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).saved, true);
  await logger.flush();
  const text = fs.readFileSync(file, 'utf8'),
    entry = JSON.parse(text);
  assert.equal(entry.requestId, 'detailed-validation-1');
  assert.equal(entry.task, 'night');
  assert.equal(entry.seat, 11);
  assert.equal(entry.httpStatus, 200);
  assert.equal(entry.durationMs, 2093);
  assert.equal(entry.responseChars, 12);
  assert.deepEqual(entry.validation, {
    version: 1,
    rule: 'TARGET_NOT_ALLOWED',
    field: 'target',
    expected: 'allowed_seat_or_null',
    reason: 'target 不在本次行动的合法目标中',
    actualType: 'number',
    roomSize: 12,
    fieldTypes: { target: 'number', save: 'missing', poison: 'missing', speech: 'missing' },
    isInteger: true,
    inSeatRange: true,
    targetAllowed: false,
    allowedTargetCount: 8,
  });
  assert.doesNotMatch(text, /private-data|狼人|apiKey|allowedTargets|reply|context|"value"/);
});

test('诊断字段仅接受已知规则、类型和有界计数，兼容旧版事件', () => {
  const { safeEntry } = require('./agent-log.cjs');
  const base = { event: 'validation_failed', code: 'INVALID_ACTION' };
  for (const rule of ['private-rule', 'constructor', '__proto__', { toString: 'private-rule' }]) {
    assert.equal(safeEntry({ ...base, validation: { version: 1, rule } }).validation, undefined);
  }
  const entry = safeEntry({
    ...base,
    validation: {
      version: 1,
      rule: 'TARGET_TYPE',
      actualType: 'private-type',
      roomSize: 99,
      allowedTargetCount: 99,
      isInteger: 'private-data',
      inSeatRange: 1,
      targetAllowed: null,
      fieldTypes: { target: 'private-data', save: 'boolean', unknown: 'number' },
    },
  });
  assert.deepEqual(entry.validation, {
    version: 1,
    rule: 'TARGET_TYPE',
    field: 'target',
    expected: 'seat_or_null',
    reason: 'target 必须是整数座位号或 null',
    fieldTypes: { save: 'boolean' },
  });
  assert.equal(safeEntry(base).validation, undefined);
  assert.equal(
    safeEntry({
      ...base,
      validation: { version: 1, rule: 'TARGET_REQUIRED', roomSize: 6, allowedTargetCount: 7 },
    }).validation.allowedTargetCount,
    undefined,
  );
  assert.equal(
    safeEntry({
      ...base,
      code: 'AGENT_CONFIG_CHANGED',
      validation: { version: 1, rule: 'TARGET_TYPE' },
    }).validation,
    undefined,
  );
});

test('每局 Agent 请求与安全上下文分别保存，可独立下载', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const { createAgentLogger } = require('./agent-log.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightfall-game-logs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = createAgentLogger({ file: path.join(directory, 'logs', 'agent-requests.jsonl') });
  log({
    gameId: 'game-one',
    requestId: 'request-one',
    event: 'response_received',
    task: 'vote',
    seat: 3,
    round: 2,
    durationMs: 321,
    httpStatus: 200,
    requestContext: [{ role: 'user', content: '公开发言和本席位可见的私有信息' }],
    assistantResponse: '{"target":4}',
    apiKey: 'must-not-appear',
  });
  log({
    gameId: 'game-two',
    requestId: 'request-two',
    event: 'response_received',
    task: 'night',
    seat: 5,
    round: 1,
    durationMs: 654,
    httpStatus: 200,
    requestContext: [{ role: 'user', content: '第二局独立上下文' }],
    assistantResponse: '{"save":false,"poison":null}',
  });
  await log.flush();
  const first = fs.readFileSync(
    path.join(directory, 'logs', 'agent-games', 'game-one.jsonl'),
    'utf8',
  );
  const second = fs.readFileSync(
    path.join(directory, 'logs', 'agent-games', 'game-two.jsonl'),
    'utf8',
  );
  assert.match(first, /request-one/);
  assert.match(first, /公开发言和本席位可见的私有信息/);
  assert.equal(JSON.parse(first.trim()).assistantResponse, '{"target":4}');
  assert.doesNotMatch(first, /must-not-appear|game-two|request-two/);
  assert.match(second, /request-two/);
  assert.match(second, /第二局独立上下文/);
  assert.doesNotMatch(second, /game-one|request-one/);
  const { base } = await fixture(t, {
    agentGameLogDirectory: path.join(directory, 'logs', 'agent-games'),
  });
  const download = await fetch(base + '/api/game-logs/game-one');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal(await download.text(), first);
  const head = await fetch(base + '/api/game-logs/game-one', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(first)));
  assert.equal(await head.text(), '');
  const missing = await fetch(base + '/api/game-logs/no-such-game');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'GAME_LOG_NOT_FOUND');
  const wrongMethod = await fetch(base + '/api/game-logs/game-one', { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD');
});
