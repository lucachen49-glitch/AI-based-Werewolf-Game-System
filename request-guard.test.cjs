'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertSameOrigin, assertJSON } = require('./request-guard.cjs');

test('来源校验保留读取可缺少 Origin、写入必须同源的规则', () => {
  const request = (headers) => ({ headers: { host: 'localhost:3000', ...headers } });
  assert.equal(assertSameOrigin(request({}), { write: false }), true);
  assert.equal(assertSameOrigin(request({}), { write: true }), false);
  assert.equal(
    assertSameOrigin(request({ origin: 'http://localhost:3000' }), { write: true }),
    true,
  );
  assert.equal(
    assertSameOrigin(request({ origin: 'http://attacker.test' }), { write: false }),
    false,
  );
  assert.equal(
    assertSameOrigin(request({ 'sec-fetch-site': 'cross-site' }), { write: false }),
    false,
  );
});

test('JSON 类型校验接受带参数的 application/json', () => {
  assert.equal(assertJSON({ headers: { 'content-type': 'application/json' } }), true);
  assert.equal(
    assertJSON({ headers: { 'content-type': 'application/json; charset=utf-8' } }),
    true,
  );
  assert.equal(assertJSON({ headers: { 'content-type': 'text/plain' } }), false);
  assert.equal(assertJSON({ headers: {} }), false);
});
