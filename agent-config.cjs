'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { protectSecret } = require('./image-config.cjs');
const Avatar = require('./avatar.js');
const { credentialEndpoint } = require('./agent-request.js');

const configPath = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'NightfallWerewolf',
  'agent-profiles.json',
);
const MAX_BYTES = 2 * 1024 * 1024;

class AgentConfigError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function serializedProfiles(value) {
  if (!Array.isArray(value) || value.length !== 12)
    throw new AgentConfigError(400, 'INVALID_AGENT_CONFIG', 'Agent 配置需要包含 12 个席位。');
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AgentConfigError(400, 'INVALID_AGENT_CONFIG', 'Agent 配置格式不正确。');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES)
    throw new AgentConfigError(
      413,
      'AGENT_CONFIG_TOO_LARGE',
      'Agent 配置文件过大，请缩小自定义头像后重试。',
    );
  return serialized;
}

function validateAvatars(value) {
  if (!Array.isArray(value)) return;
  for (const profile of value) {
    if (
      profile &&
      typeof profile === 'object' &&
      profile.avatar !== undefined &&
      !Avatar.valid(profile.avatar)
    )
      throw new AgentConfigError(
        400,
        'INVALID_AGENT_AVATAR',
        '头像格式不正确，请选择内置头像或上传 PNG、JPG、WebP 图片。',
      );
  }
}

function encryptionFailure() {
  return new AgentConfigError(
    500,
    'AGENT_CONFIG_ENCRYPTION_FAILED',
    '本机配置加密暂不可用，请重试；原有配置没有改变。',
  );
}

const saveQueues = new Map();
function publicAgentConfig(record) {
  if (!record) return record;
  return {
    ...record,
    profiles: record.profiles?.map(({ key, voiceKey, clearKey, clearVoiceKey, ...profile }) => ({
      ...profile,
      hasKey: key !== undefined ? !!key : !!profile.hasKey,
      hasVoiceKey: voiceKey !== undefined ? !!voiceKey : !!profile.hasVoiceKey,
      keyRevision: profile.keyRevision || 0,
      voiceKeyRevision: profile.voiceKeyRevision || 0,
    })),
  };
}
function createAgentConfigStore(file = configPath) {
  async function readRecord() {
    try {
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      if (
        record.version !== 1 ||
        record.protection !== 'windows-dpapi-current-user' ||
        typeof record.encryptedProfiles !== 'string' ||
        !/^01000000[0-9a-f]+$/i.test(record.encryptedProfiles) ||
        typeof record.savedAt !== 'string'
      )
        throw Error();
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new AgentConfigError(
        500,
        'AGENT_CONFIG_READ_FAILED',
        '本机 Agent 配置无法读取，请重新保存一次配置。',
      );
    }
  }
  async function load() {
    const record = await readRecord();
    if (!record) return null;
    let profiles;
    try {
      profiles = JSON.parse(await protectSecret(record.encryptedProfiles, true));
    } catch {
      throw new AgentConfigError(
        500,
        'AGENT_CONFIG_READ_FAILED',
        '本机 Agent 配置无法读取，请重新保存一次配置。',
      );
    }
    serializedProfiles(profiles);
    return { profiles, savedAt: record.savedAt };
  }
  return {
    async loadPublic() {
      return publicAgentConfig(await load());
    },
    async credential(seat, kind = 'agent') {
      if (!Number.isInteger(seat) || seat < 1 || seat > 12)
        throw new AgentConfigError(400, 'INVALID_PROFILE_SEAT', 'Agent 席位需要在 1 至 12 之间。');
      const profile = (await load())?.profiles[seat - 1];
      if (!profile) throw new AgentConfigError(409, 'PROFILE_CHANGED', '请先保存 Agent 配置。');
      return {
        endpoint: kind === 'voice' ? profile.voiceEndpoint : profile.endpoint,
        apiKey: (kind === 'voice' ? profile.voiceKey : profile.key) || '',
      };
    },
    async status() {
      const loaded = await load();
      return {
        configured: !!loaded,
        savedAt: loaded?.savedAt || null,
        storage: 'Windows 当前用户加密保存',
      };
    },
    async load() {
      return load();
    },
    async save(profiles, { clientSavedAt, baseSavedAt } = {}) {
      // Snapshot input before joining the queue so concurrent callers cannot change it.
      const input = JSON.parse(serializedProfiles(profiles));
      const queueKey = path.resolve(file);
      const operation = (saveQueues.get(queueKey) || Promise.resolve()).then(async () => {
        validateAvatars(input);
        const loaded = await load();
        profiles = input.map((profile, i) => {
          if (!profile || typeof profile !== 'object' || Array.isArray(profile))
            throw new AgentConfigError(400, 'INVALID_AGENT_CONFIG', '席位配置格式不正确。');
          const previous = loaded?.profiles[i] || {};
          const { hasKey, hasVoiceKey, clearKey, clearVoiceKey, ...next } = profile;
          for (const [field, remember, clear, revision] of [
            ['key', 'rememberKey', clearKey, 'keyRevision'],
            ['voiceKey', 'rememberVoiceKey', clearVoiceKey, 'voiceKeyRevision'],
          ]) {
            const endpoint = field === 'key' ? 'endpoint' : 'voiceEndpoint';
            const kind = field === 'key' ? 'agent' : 'voice';
            const sameEndpoint =
              credentialEndpoint(next[endpoint], kind) ===
              credentialEndpoint(previous[endpoint], kind);
            if (
              (next[field] !== undefined && typeof next[field] !== 'string') ||
              (clear !== undefined && typeof clear !== 'boolean')
            )
              throw new AgentConfigError(400, 'INVALID_AGENT_KEY', '密钥格式不正确。');
            const value =
              clear || next[remember] === false
                ? ''
                : typeof next[field] === 'string' &&
                    next[field].trim() &&
                    (sameEndpoint || next[field].trim() !== previous[field])
                  ? next[field].trim()
                  : sameEndpoint
                    ? previous[field] || ''
                    : '';
            if (value.length > 8192 || /[\r\n]/.test(value))
              throw new AgentConfigError(400, 'INVALID_AGENT_KEY', '密钥格式不正确。');
            next[field] = value;
            next[revision] =
              (Number.isSafeInteger(previous[revision]) && previous[revision] >= 0
                ? previous[revision]
                : 0) + (value !== (previous[field] || '') ? 1 : 0);
          }
          return next;
        });
        const serialized = serializedProfiles(profiles);
        const current = await readRecord();
        if (baseSavedAt !== undefined && baseSavedAt !== (current?.savedAt || null))
          throw new AgentConfigError(
            409,
            'AGENT_CONFIG_CONFLICT',
            '本机已有更新的 Agent 配置，请重新打开页面后再保存。',
          );
        if (baseSavedAt === undefined && current && typeof clientSavedAt === 'string') {
          const requested = Date.parse(clientSavedAt),
            stored = Date.parse(current.savedAt);
          if (Number.isFinite(requested) && Number.isFinite(stored) && requested <= stored)
            throw new AgentConfigError(
              409,
              'AGENT_CONFIG_CONFLICT',
              '本机已有更新的 Agent 配置，请重新打开页面后再保存。',
            );
        }
        let encryptedProfiles;
        try {
          encryptedProfiles = await protectSecret(serialized);
        } catch {
          throw encryptionFailure();
        }
        const record = {
          version: 1,
          protection: 'windows-dpapi-current-user',
          encryptedProfiles,
          savedAt: new Date(
            Math.max(Date.now(), (Date.parse(current?.savedAt) || 0) + 1),
          ).toISOString(),
        };
        const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
        try {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
          await fs.rename(temp, file);
        } catch {
          throw new AgentConfigError(
            500,
            'AGENT_CONFIG_SAVE_FAILED',
            '本机 Agent 配置保存失败，请检查当前 Windows 账户的文件权限后重试。',
          );
        } finally {
          await fs.rm(temp, { force: true }).catch(() => {});
        }
        return {
          ...publicAgentConfig({ profiles, savedAt: record.savedAt }),
          storage: 'Windows 当前用户加密保存',
        };
      });
      const done = operation
        .catch(() => {})
        .finally(() => {
          if (saveQueues.get(queueKey) === done) saveQueues.delete(queueKey);
        });
      saveQueues.set(queueKey, done);
      return operation;
    },
  };
}

module.exports = {
  AgentConfigError,
  createAgentConfigStore,
  publicAgentConfig,
  configPath,
  MAX_BYTES,
};
