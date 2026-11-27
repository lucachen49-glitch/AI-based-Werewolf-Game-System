'use strict';
// Security hardening: main-page CSP and avatar validation shared by browser and local service.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createServer } = require('./server.cjs');
const Avatar = require('./avatar.js');
const { createAgentConfigStore } = require('./agent-config.cjs');

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
