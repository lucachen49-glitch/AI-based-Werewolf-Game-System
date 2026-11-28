'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createAgentConfigStore } = require('./agent-config.cjs');
const { createCredentialResolver } = require('./credential-resolver.cjs');
const { privateAddress, connectionOptions, createGuardedFetch } = require('./upstream-guard.cjs');
const { createServer } = require('./server.cjs');
const { sendFile } = require('./file-response.cjs');
const { cleanupLocal } = require('./scripts/cleanup-local.cjs');
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nightfall-hardening-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}
const profiles = () =>
  Array.from({ length: 12 }, (_, i) => ({
    name: '席位' + (i + 1),
    endpoint: 'https://provider.example/v1',
    model: 'model',
    voiceEndpoint: 'https://voice.example/v1',
    rememberKey: true,
    rememberVoiceKey: true,
  }));
test(
  '加密配置只公开凭据标志与版本，省略和空值保留，显式取消记住清除',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await temporary(t),
      file = path.join(root, 'profiles.json'),
      store = createAgentConfigStore(file);
    const input = profiles();
    input[0].key = 'saved-agent';
    input[0].voiceKey = 'saved-voice';
    input[0].hasKey = false;
    input[0].hasVoiceKey = false;
    input[1].personality = '长'.repeat(40000);
    const first = await store.save(input);
    assert.equal(first.profiles[0].hasKey, true);
    assert.equal(first.profiles[0].hasVoiceKey, true);
    assert.equal(first.profiles[0].keyRevision, 1);
    assert.equal(JSON.stringify(first).includes('saved-agent'), false);
    assert.equal((await fs.readFile(file, 'utf8')).includes('saved-voice'), false);
    const metadata = (await store.loadPublic()).profiles;
    metadata[0].key = '';
    await store.save(metadata);
    assert.equal((await store.credential(1)).apiKey, 'saved-agent');
    assert.equal((await store.credential(1, 'voice')).apiKey, 'saved-voice');
    metadata[0].clearKey = true;
    metadata[0].rememberVoiceKey = false;
    const cleared = await store.save(metadata);
    assert.equal(cleared.profiles[0].hasKey, false);
    assert.equal(cleared.profiles[0].keyRevision, 2);
    assert.equal(cleared.profiles[0].hasVoiceKey, false);
    await assert.rejects(store.save([null]), { code: 'INVALID_AGENT_CONFIG' });
    const bad = profiles();
    bad[0].key = 12;
    await assert.rejects(store.save(bad), { code: 'INVALID_AGENT_KEY' });
  },
);
test('并发保存按顺序合并密钥并拒绝过期配置', { skip: process.platform !== 'win32' }, async (t) => {
  const store = createAgentConfigStore(path.join(await temporary(t), 'profiles.json'));
  const a = profiles(),
    b = profiles();
  a[0].key = 'first';
  b[0].voiceKey = 'second';
  await Promise.all([store.save(a), store.save(b)]);
  assert.equal((await store.credential(1)).apiKey, 'first');
  assert.equal((await store.credential(1, 'voice')).apiKey, 'second');
  await assert.rejects(store.save(profiles(), { clientSavedAt: '2000-01-01T00:00:00Z' }), {
    code: 'AGENT_CONFIG_CONFLICT',
  });
});
test('凭据解析规范化端点，临时密钥优先，席位和端点变更可诊断', async () => {
  const resolve = createCredentialResolver({
    credential: async (_seat, kind) => ({
      endpoint: kind === 'voice' ? 'https://voice.example/v1' : 'https://provider.example/v1',
      apiKey: 'server-secret',
    }),
  });
  assert.equal(
    (await resolve({ profileSeat: 1, endpoint: 'https://provider.example/v1/responses' })).apiKey,
    'server-secret',
  );
  assert.equal(
    (await resolve({ profileSeat: 1, endpoint: 'https://voice.example/v1/audio/speech' }, 'voice'))
      .apiKey,
    'server-secret',
  );
  assert.equal(
    (await resolve({ profileSeat: 1, endpoint: 'https://other.example', apiKey: 'temporary' }))
      .apiKey,
    'temporary',
  );
  await assert.rejects(resolve({ profileSeat: 1, endpoint: 'https://other.example' }), {
    status: 409,
    code: 'PROFILE_CHANGED',
  });
  for (const seat of [0, 13, '1', null, 1.5])
    await assert.rejects(resolve({ profileSeat: seat }), { code: 'INVALID_PROFILE_SEAT' });
});
test('配置 GET 和 POST、聊天、批量行动、语音及工坊入口使用公开凭据契约', async (t) => {
  const input = profiles();
  input[0].key = 'saved-agent';
  input[0].voiceKey = 'saved-voice';
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.Authorization });
    if (String(url).includes('/audio/speech'))
      return new Response(Buffer.from('ID3' + 'x'.repeat(200)), {
        headers: { 'content-type': 'audio/mpeg' },
      });
    return new Response(
      JSON.stringify({
        id: 'resp-hardening',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '{"target":2}' }],
          },
        ],
      }),
    );
  };
  const store = {
    load: async () => ({ profiles: input }),
    save: async () => ({ profiles: input }),
  };
  const base = await listen(
    t,
    createServer({
      fetchImpl: transport,
      gameFetchImpl: transport,
      agentConfigStore: store,
      agentLogger: () => {},
      recoverVideoJobs: false,
    }),
  );
  const post = (route, body) =>
    fetch(base + route, {
      method: 'POST',
      headers: { Origin: base, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const publicConfig = await (
    await fetch(base + '/api/agent-config', { headers: { Origin: base } })
  ).json();
  assert.equal(publicConfig.profiles[0].hasKey, true);
  assert.equal(JSON.stringify(publicConfig).includes('saved-agent'), false);
  const saved = await (await post('/api/agent-config', { profiles: profiles() })).json();
  assert.equal(JSON.stringify(saved).includes('saved-agent'), false);
  const chat = {
    endpoint: input[0].endpoint,
    model: 'model',
    profileSeat: 1,
    messages: [{ role: 'user', content: 'OK' }],
  };
  let response = await post('/api/chat', chat);
  assert.equal(response.status, 200, await response.text());
  response = await post('/api/chat', { ...chat, endpoint: 'https://changed.example' });
  assert.equal(response.status, 409);
  response = await post('/api/chat/batch', {
    requests: [
      {
        ...chat,
        requestId: 'batch-one',
        purpose: 'game-action',
        action: { task: 'vote', seat: 1, round: 1, allowedTargets: [2] },
      },
    ],
  });
  assert.equal(response.status, 200);
  await response.text();
  response = await post('/api/speech', {
    endpoint: input[0].voiceEndpoint,
    profileSeat: 1,
    provider: 'api',
    model: 'voice',
    voice: 'speaker',
    text: '你好',
    speed: 1,
    style: 'calm',
  });
  assert.equal(response.status, 200, await response.text());
  response = await post('/api/speech', { endpoint: 'https://changed.example', profileSeat: 1 });
  assert.equal(response.status, 409);
  response = await post('/api/scenarios/prepare', {
    ...chat,
    source: '六个人来到庄园',
    roomSize: 6,
  });
  await response.text();
  assert.equal(calls.filter((c) => c.authorization === 'Bearer saved-agent').length, 3);
  assert.equal(calls.filter((c) => c.authorization === 'Bearer saved-voice').length, 1);
});
test('IPv4、IPv6 和映射地址拦截本地与私网，允许公网', () => {
  for (const ip of [
    '127.0.0.1',
    '0.0.0.0',
    '10.2.3.4',
    '172.31.2.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.1.1',
    '198.18.0.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:c0a8:101',
    '2001::1',
    '2001:0:1234::1',
    '2002:c0a8:101::1',
    '64:ff9b::7f00:1',
  ])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])
    assert.equal(privateAddress(ip), false, ip);
});
test('DNS 返回任何私网地址都拒绝，连接直接使用已校验的地址', async () => {
  for (const addresses of [
    [{ address: '127.0.0.1', family: 4 }],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
  ]) {
    const options = connectionOptions(new URL('https://public.example'), {
      allowLoopback: false,
      lookup: (_host, _options, callback) => callback(null, addresses),
    });
    await assert.rejects(
      new Promise((resolve, reject) =>
        options.lookup('public.example', { all: true }, (error, result) =>
          error ? reject(error) : resolve(result),
        ),
      ),
      { code: 'UPSTREAM_PRIVATE_ADDRESS' },
    );
  }
  let lookups = 0;
  const addresses = [{ address: '8.8.8.8', family: 4 }];
  const options = connectionOptions(new URL('https://public.example'), {
    allowLoopback: false,
    lookup: (_host, _options, callback) => {
      lookups++;
      callback(null, addresses);
    },
  });
  const checked = await new Promise((resolve, reject) =>
    options.lookup('public.example', { all: true }, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
  assert.equal(checked, addresses);
  assert.equal(lookups, 1);
});
test('Guarded fetch 默认拦截本机，显式启用支持表单、流取消与重定向拒绝', async (t) => {
  let redirected = false,
    cancelled;
  const closed = new Promise((resolve) => {
    cancelled = resolve;
  });
  const base = await listen(
    t,
    http.createServer(async (req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: base + '/target' });
        res.end();
        return;
      }
      if (req.url === '/target') redirected = true;
      if (req.url === '/stream') {
        res.write('start');
        req.once('close', cancelled);
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.end(
        JSON.stringify({
          method: req.method,
          type: req.headers['content-type'],
          body: Buffer.concat(chunks).toString(),
        }),
      );
    }),
  );
  await assert.rejects(createGuardedFetch({ allowLoopback: false })(base), {
    code: 'UPSTREAM_PRIVATE_ADDRESS',
  });
  const fetchLocal = createGuardedFetch({ allowLoopback: true });
  const form = new FormData();
  form.append('label', 'test');
  const data = await (await fetchLocal(base, { method: 'POST', body: form })).json();
  assert.match(data.type, /multipart\/form-data; boundary=/);
  assert.match(data.body, /test/);
  await assert.rejects(fetchLocal(base + '/redirect'), { code: 'ERR_UPSTREAM_REDIRECT' });
  assert.equal(redirected, false);
  const controller = new AbortController();
  const stream = await fetchLocal(new Request(base + '/stream', { signal: controller.signal }));
  controller.abort();
  await assert.rejects(stream.text());
  await closed;
});
test('流式文件支持首段、尾段、HEAD、空文件、缓存验证及无效范围', async (t) => {
  const root = await temporary(t),
    file = path.join(root, 'media.mp3'),
    empty = path.join(root, 'empty');
  await fs.writeFile(file, '0123456789');
  await fs.writeFile(empty, '');
  const base = await listen(
    t,
    http.createServer((req, res) => {
      void sendFile(req, res, req.url === '/empty' ? empty : file, {
        type: 'audio/mpeg',
        cache: 'public, max-age=86400',
        etag: true,
      }).catch(() => res.destroy());
    }),
  );
  const full = await fetch(base),
    etag = full.headers.get('etag');
  assert.equal(await full.text(), '0123456789');
  assert.match(etag, /^W\//);
  for (const [range, expected] of [
    ['bytes=2-4', '234'],
    ['bytes=-3', '789'],
    ['bytes=8-', '89'],
    ['bytes=0-99', '0123456789'],
  ]) {
    const response = await fetch(base, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), expected);
  }
  for (const range of [
    'bytes=-0',
    'bytes=10-',
    'bytes=4-2',
    'bytes=0-1,4-5',
    'bytes=999999999999999999999-',
  ]) {
    const response = await fetch(base, { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
  }
  const head = await fetch(base, { method: 'HEAD', headers: { Range: 'bytes=2-4' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '3');
  assert.equal(await head.text(), '');
  const cached = await fetch(base, { headers: { 'If-None-Match': '"other", ' + etag } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
  assert.equal(
    (await fetch(base, { headers: { Range: 'bytes=1-2', 'If-Range': '"stale"' } })).status,
    200,
  );
  const zero = await fetch(base + '/empty');
  assert.equal(zero.status, 200);
  assert.equal(await zero.text(), '');
  assert.equal((await fetch(base + '/empty', { headers: { Range: 'bytes=0-' } })).status, 416);
});
test('静态清单中的文件及 HTML 资源引用均存在，新模块加载顺序正确', async () => {
  const { allowed } = require('./static-manifest.cjs');
  for (const name of allowed)
    assert.equal((await fs.stat(path.join(__dirname, name))).isFile(), true, name);
  for (const name of [...allowed].filter((file) => file.endsWith('.html'))) {
    const html = await fs.readFile(path.join(__dirname, name), 'utf8');
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"#?]+)"/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(match[1])) continue;
      assert.equal(allowed.has(match[1].replace(/^\.\//, '')), true, name + ' -> ' + match[1]);
    }
    if (html.includes('scenario.js'))
      assert.ok(html.indexOf('scenario-samples.js') < html.indexOf('src="scenario.js"'));
  }
});
test('本地清理默认预览，按保留期清理并跳过链接和故事资料', async (t) => {
  const root = await temporary(t),
    outside = await temporary(t);
  await fs.mkdir(path.join(root, 'output'), { recursive: true });
  await fs.mkdir(path.join(root, 'stories'), { recursive: true });
  const stale = path.join(root, 'output', 'old.txt'),
    recent = path.join(root, 'output', 'new.txt'),
    story = path.join(root, 'stories', 'saved.txt');
  await fs.writeFile(stale, 'old');
  await fs.writeFile(recent, 'new');
  await fs.writeFile(story, 'valuable');
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  const old = new Date(Date.now() - 20 * 86400000);
  await fs.utimes(stale, old, old);
  await fs.symlink(
    outside,
    path.join(root, 'output', 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const options = { root, stories: path.join(root, 'stories') };
  const preview = await cleanupLocal(options);
  assert.equal(preview.results[0].files, 1);
  assert.equal(preview.results[0].removed, 0);
  assert.equal(preview.storyBytes, 8);
  assert.equal(await fs.readFile(stale, 'utf8'), 'old');
  const applied = await cleanupLocal({ ...options, apply: true });
  assert.equal(applied.results[0].removed, 1);
  await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
  assert.equal(await fs.readFile(recent, 'utf8'), 'new');
  assert.equal(await fs.readFile(story, 'utf8'), 'valuable');
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(cleanupLocal({ ...options, days: -1 }));
});

test(
  '配置使用确认版本执行并发校验，允许同页连续保存并拒绝其他页面旧版本',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await temporary(t),
      store = createAgentConfigStore(path.join(root, 'profiles.json'));
    const first = await store.save(profiles(), { baseSavedAt: null });
    const second = await store.save(profiles(), {
      baseSavedAt: first.savedAt,
      clientSavedAt: '2000-01-01T00:00:00Z',
    });
    assert.ok(Date.parse(second.savedAt) > Date.parse(first.savedAt));
    await assert.rejects(store.save(profiles(), { baseSavedAt: first.savedAt }), {
      code: 'AGENT_CONFIG_CONFLICT',
    });
  },
);

test('私网阻断在聊天和语音入口返回明确错误，语音仅尝试一次', async (t) => {
  let attempts = 0;
  const blocked = async () => {
    attempts++;
    throw Object.assign(Error('blocked private upstream'), {
      status: 400,
      code: 'UPSTREAM_PRIVATE_ADDRESS',
    });
  };
  const base = await listen(
    t,
    createServer({
      fetchImpl: blocked,
      gameFetchImpl: blocked,
      agentLogger: () => {},
      recoverVideoJobs: false,
    }),
  );
  const post = (route, body) =>
    fetch(base + route, {
      method: 'POST',
      headers: { Origin: base, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const chat = await post('/api/chat', {
    endpoint: 'https://provider.example/v1',
    model: 'model',
    messages: [{ role: 'user', content: 'OK' }],
  });
  assert.equal(chat.status, 400);
  assert.equal((await chat.json()).error.code, 'UPSTREAM_PRIVATE_ADDRESS');
  attempts = 0;
  const speech = await post('/api/speech', {
    apiKey: 'test-key',
    endpoint: 'https://provider.example/v1',
    provider: 'api',
    model: 'voice',
    voice: 'speaker',
    text: '测试',
    speed: 1,
    style: 'calm',
  });
  assert.equal(speech.status, 400);
  assert.equal((await speech.json()).error.code, 'UPSTREAM_PRIVATE_ADDRESS');
  assert.equal(attempts, 1);
});

test('Guarded fetch 解码上游压缩响应并传播损坏压缩流错误', async (t) => {
  const { gzipSync, deflateSync, brotliCompressSync } = require('node:zlib');
  const encoders = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
  const base = await listen(
    t,
    http.createServer((req, res) => {
      const encoding = req.url.slice(1);
      res.writeHead(200, { 'content-encoding': encoding === 'broken' ? 'gzip' : encoding });
      res.end(encoding === 'broken' ? 'invalid' : encoders[encoding](Buffer.from('压缩后的响应')));
    }),
  );
  const fetchLocal = createGuardedFetch({ allowLoopback: true });
  for (const encoding of Object.keys(encoders))
    assert.equal(await (await fetchLocal(base + '/' + encoding)).text(), '压缩后的响应');
  await assert.rejects((await fetchLocal(base + '/broken')).text());
});

const Avatar = require('./avatar.js');
const memoryStore = {
  async load() {
    return null;
  },
  async save() {
    return { savedAt: new Date().toISOString() };
  },
};

test('主页面返回内容安全策略并禁止被嵌入', async (t) => {
  const base = await listen(
    t,
    createServer({ agentConfigStore: memoryStore, recoverVideoJobs: false }),
  );
  for (const pathname of ['/', '/index.html']) {
    const response = await fetch(base + pathname);
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.equal((await fetch(base + '/avatar.js')).status, 200);
});

test('头像只接受内置表情或 PNG、JPEG、WebP base64 图片', () => {
  for (const value of Avatar.AVATARS) assert.equal(Avatar.valid(value), true);
  for (const value of [
    'data:image/png;base64,iVBORw0KGgo=',
    'data:image/jpeg;base64,/9j/4AAQ',
    'data:image/webp;base64,UklGRg==',
  ])
    assert.equal(Avatar.valid(value), true);
  for (const value of [
    undefined,
    null,
    1,
    '',
    'x',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,AA" onerror="x',
    'data:text/html;base64,PGI+',
    'data:image/png,raw',
    'data:image/png;base64,' + 'A'.repeat(Avatar.MAX_DATA_URL_CHARS),
  ])
    assert.equal(Avatar.valid(value), false, String(value).slice(0, 40));
  assert.equal(Avatar.normalize('bad', 13), Avatar.AVATARS[13]);
});

test('本机 Agent 配置拒绝保存非法头像', async () => {
  const store = createAgentConfigStore(
    path.join(os.tmpdir(), 'nightfall-avatar-' + process.pid + '.json'),
  );
  const profiles = Array.from({ length: 12 }, () => ({}));
  profiles[3].avatar = 'javascript:alert(1)';
  await assert.rejects(store.save(profiles), { status: 400, code: 'INVALID_AGENT_AVATAR' });
});
