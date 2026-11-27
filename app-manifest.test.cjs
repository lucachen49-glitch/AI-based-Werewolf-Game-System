'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const APP_SCRIPTS = require('./app-manifest.cjs');

test('主页面按 app-manifest.cjs 声明的顺序加载应用脚本', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const scriptTags = [...html.matchAll(/<script src="([^"]+)"\s*><\/script>/g)]
    .map((match) => match[1])
    .filter((src) => /^app(?:-[a-z-]+)?\.js$/.test(src));
  assert.deepEqual(scriptTags, APP_SCRIPTS);
  for (const script of APP_SCRIPTS) assert.equal(fs.existsSync(script), true, `${script} exists`);
});
