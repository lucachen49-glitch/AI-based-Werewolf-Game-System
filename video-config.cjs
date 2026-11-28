'use strict';
const path = require('node:path');
const { protectSecret } = require('./image-config.cjs'),
  { atomic, readAtomic, dataRoot, StoryError } = require('./scenario-store.cjs');
const PROVIDER = 'https://api-fast.hualong-ai.com',
  MODEL = 'grok-imagine-video-1.5';
function normalizeVideoBase(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new StoryError(400, 'INVALID_VIDEO_ENDPOINT', '视频地址格式不正确');
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !['', '/', '/v1', '/v1/'].includes(u.pathname)
  )
    throw new StoryError(400, 'INVALID_VIDEO_ENDPOINT', '请填写 HTTPS 网站根地址或 /v1 地址');
  return u.origin + '/v1';
}
function createVideoConfigStore(
  file = path.join(dataRoot, 'video-provider.json'),
  protect = protectSecret,
) {
  async function read() {
    try {
      const v = await readAtomic(file);
      if (
        v.version !== 1 ||
        v.protection !== 'windows-dpapi-current-user' ||
        typeof v.encryptedKey !== 'string' ||
        v.model !== MODEL
      )
        throw Error();
      normalizeVideoBase(v.provider);
      return v;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new StoryError(500, 'VIDEO_CONFIG_READ_FAILED', '视频配置无法读取，请重新保存');
    }
  }
  return {
    async status() {
      const r = await read();
      return {
        configured: !!r,
        provider: r?.provider || PROVIDER,
        model: MODEL,
        savedAt: r?.savedAt || null,
        storage: 'Windows 当前用户加密保存',
      };
    },
    async save(body) {
      const provider = normalizeVideoBase(body?.provider || PROVIDER);
      const old = await read();
      let encryptedKey =
        old && normalizeVideoBase(old.provider) === provider ? old.encryptedKey : null;
      if (body?.apiKey) {
        if (typeof body.apiKey !== 'string' || !/^\S{8,8192}$/.test(body.apiKey.trim()))
          throw new StoryError(400, 'INVALID_VIDEO_KEY', '请填写有效的视频专用密钥');
        encryptedKey = await protect(body.apiKey.trim());
      }
      if (!encryptedKey) throw new StoryError(400, 'VIDEO_KEY_REQUIRED', '请先填写视频专用密钥');
      if (body?.model && body.model !== MODEL)
        throw new StoryError(
          400,
          'INVALID_VIDEO_MODEL',
          '本次使用 grok-imagine-video-1.5，不自动切换模型',
        );
      await atomic(file, {
        version: 1,
        protection: 'windows-dpapi-current-user',
        provider,
        model: MODEL,
        encryptedKey,
        savedAt: new Date().toISOString(),
      });
      return this.status();
    },
    async loadCredential() {
      const r = await read();
      if (!r) throw new StoryError(400, 'VIDEO_KEY_REQUIRED', '请先在剧本工坊保存视频专用密钥');
      return {
        provider: normalizeVideoBase(r.provider),
        model: MODEL,
        apiKey: await protect(r.encryptedKey, true),
      };
    },
  };
}
module.exports = { createVideoConfigStore, normalizeVideoBase, PROVIDER, MODEL };
