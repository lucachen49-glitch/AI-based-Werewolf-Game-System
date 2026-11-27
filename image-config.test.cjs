'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const http = require('node:http');
const { createImageConfigStore, MODEL, PROVIDER } = require('./image-config.cjs');
const { createServer } = require('./server.cjs');
async function fixture(t, store) {
  const server = createServer({ imageConfigStore: store, recoverVideoJobs: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (body) =>
    fetch(base + '/api/image-config', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { base, post };
}
test(
  '图片密钥由 Windows 当前用户加密，重启存储后可读取且 HTTP 仅返回状态',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nightfall-image-config-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'image-provider.json'),
      secret = 'test-only-image-secret-' + require('node:crypto').randomUUID();
    const store = createImageConfigStore(file),
      { base, post } = await fixture(t, store);
    assert.equal((await (await fetch(base + '/api/image-config')).json()).configured, false);
    const saved = await post({ apiKey: secret });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get('cache-control'), 'no-store');
    const text = await saved.text();
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes('encryptedKey'), false);
    const status = JSON.parse(text);
    assert.equal(status.configured, true);
    assert.equal(status.verified, false);
    assert.equal(status.model, MODEL);
    assert.equal(status.provider, PROVIDER);
    const raw = await fs.readFile(file, 'utf8');
    assert.equal(raw.includes(secret), false);
    assert.match(JSON.parse(raw).encryptedKey, /^01000000/);
    // Earlier saved records retain their encrypted key when the production model changes.
    const oldRecord = JSON.parse(raw);
    oldRecord.provider = 'https://api.hualong-ai.com';
    oldRecord.model = 'gpt-image-2';
    await fs.writeFile(file, JSON.stringify(oldRecord));
    const restored = createImageConfigStore(file),
      credential = await restored.loadCredential();
    assert.equal(credential.apiKey, secret);
    assert.equal(credential.provider, 'https://api-fast.hualong-ai.com/v1');
    assert.equal(credential.model, 'gpt-image-2.5-sunburst');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).encryptedKey, oldRecord.encryptedKey);
    assert.equal((await restored.status()).configured, true);
    const restarted = await fixture(t, restored);
    const after = await (await fetch(restarted.base + '/api/image-config')).text();
    assert.equal(JSON.parse(after).configured, true);
    assert.equal(after.includes(secret), false);
    const bad = await post({ apiKey: '' });
    assert.equal(bad.status, 400);
    assert.equal((await restored.loadCredential()).apiKey, secret);
    const replacement = secret + '-replacement';
    assert.equal((await post({ apiKey: replacement })).status, 200);
    assert.equal((await restored.loadCredential()).apiKey, replacement);
    assert.deepEqual(await fs.readdir(dir), ['image-provider.json']);
  },
);
test('图片配置拒绝跨站、非法 Host、非 JSON、超限和不支持的方法', async (t) => {
  let calls = 0;
  const { base } = await fixture(t, {
    status: async () => ({ configured: false }),
    save: async () => {
      calls++;
      return { configured: true };
    },
  });
  const url = base + '/api/image-config';
  const cases = [
    [
      {
        method: 'POST',
        headers: { Origin: 'https://foreign.test', 'Content-Type': 'application/json' },
        body: '{}',
      },
      403,
    ],
    [{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 403],
    [{ headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403],
    [{ headers: { Origin: 'https://foreign.test' } }, 403],
    [{ method: 'POST', headers: { Origin: base, 'Content-Type': 'text/plain' }, body: '{}' }, 415],
    [
      { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{' },
      400,
    ],
    [
      {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'x'.repeat(17000) }),
      },
      413,
    ],
    [{ method: 'DELETE', headers: { Origin: base } }, 405],
  ];
  for (const [options, status] of cases) assert.equal((await fetch(url, options)).status, status);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { Host: 'foreign.test' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal(calls, 0);
});
test('制作密钥不会进入静态资源、错误响应或聊天请求，网页没有运行时出图接口', async (t) => {
  const secret = 'test-only-private-error';
  const { base, post } = await fixture(t, {
    status: async () => ({ configured: false }),
    save: async () => {
      throw Error(secret);
    },
  });
  const failed = await post({ apiKey: 'test-only-valid-input' });
  assert.equal(failed.status, 500);
  assert.equal((await failed.text()).includes(secret), false);
  for (const file of [
    'image-config.cjs',
    'image-config.test.cjs',
    'image-provider.json',
    '.local/image-provider.json',
    'api/image-generate',
    'api/image-config/key',
  ])
    assert.equal((await fetch(base + '/' + file)).status, 404);
  for (const file of ['image-settings.html', 'image-settings.css', 'image-settings.js']) {
    const response = await fetch(base + '/' + file);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  const source = await fs.readFile('image-settings.js', 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\./);
});
test('旧配置缺失、损坏及不合法密钥不会被当成已保存', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nightfall-image-invalid-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'image-provider.json'),
    store = createImageConfigStore(file);
  assert.equal(await store.loadCredential(), null);
  for (const body of [
    null,
    [],
    {},
    { apiKey: 'tiny' },
    { apiKey: 'test\nkey' },
    { apiKey: 'x'.repeat(8193) },
  ])
    await assert.rejects(store.save(body), { code: 'INVALID_IMAGE_KEY' });
  await fs.writeFile(file, 'not JSON');
  await assert.rejects(store.status(), { code: 'CONFIG_READ_FAILED' });
});
