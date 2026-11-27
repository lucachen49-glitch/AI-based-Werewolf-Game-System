'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRestartBackoff, STABLE_RUN_MS } = require('./service-manager.cjs');

test('服务连续运行满 60 秒后重启退避恢复到 1 秒', () => {
  const timers = [];
  const cleared = [];
  const backoff = createRestartBackoff({
    steps: [1000, 2000, 5000],
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer: (id) => cleared.push(id),
  });
  assert.equal(backoff.next(), 1000);
  assert.equal(backoff.next(), 2000);
  backoff.started();
  assert.equal(timers[0].delay, STABLE_RUN_MS);
  timers[0].callback();
  backoff.exited();
  assert.equal(backoff.attempts, 0);
  assert.equal(backoff.next(), 1000);
  backoff.started();
  backoff.exited();
  assert.ok(cleared.includes(2));
});
