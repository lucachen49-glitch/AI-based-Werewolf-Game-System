'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  { randomUUID } = require('node:crypto');
const Schema = require('./scenario.js');
const { groupStories } = require('./scenario-dedup.cjs');
const dataRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'NightfallWerewolf',
  'stories',
);
class StoryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const validId = (id) =>
  typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const fileQueues = new Map();
function withFile(file, fn) {
  const next = (fileQueues.get(file) || Promise.resolve()).then(fn);
  const done = next
    .catch(() => {})
    .finally(() => {
      if (fileQueues.get(file) === done) fileQueues.delete(file);
    });
  fileQueues.set(file, done);
  return next;
}
const readAtomic = (file) => withFile(file, () => fs.readFile(file, 'utf8').then(JSON.parse));
async function atomic(file, data) {
  return withFile(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(temp, file);
          break;
        } catch (e) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 20) throw e;
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  });
}
function createScenarioStore(root = dataRoot) {
  let tail = Promise.resolve();
  const locked = (fn) => {
    const next = tail.then(fn);
    tail = next.catch(() => {});
    return next;
  };
  const index = async () => {
    try {
      return await readAtomic(path.join(root, '.dedup-index.json'));
    } catch (e) {
      if (e.code === 'ENOENT') return { aliases: {}, archives: {} };
      throw e;
    }
  };
  async function get(id, version) {
    if (!validId(id) || (version !== undefined && (!Number.isSafeInteger(version) || version < 1)))
      throw new StoryError(404, 'STORY_NOT_FOUND', '找不到这个剧本');
    const relative =
        version === undefined ? id + '.json' : path.join('versions', id, version + '.json'),
      file = path.join(root, relative);
    try {
      return await readAtomic(file);
    } catch (e) {
      if (e.code === 'ENOENT') {
        const archive = (await index()).archives[id];
        if (archive) {
          try {
            return await readAtomic(path.join(archive, relative));
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
          }
        }
        if (version !== undefined) {
          const latest = await get(id);
          if (latest.version === version) return latest;
        }
        throw new StoryError(404, 'STORY_NOT_FOUND', '找不到这个剧本版本');
      }
      throw new StoryError(500, 'STORY_READ_FAILED', '剧本无法读取，请检查本机保存目录');
    }
  }
  async function all() {
    let files;
    try {
      files = await fs.readdir(root);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    return Promise.all(
      files
        .filter((f) => validId(f.slice(0, -5)) && f.endsWith('.json'))
        .map((f) => get(f.slice(0, -5))),
    );
  }
  async function list() {
    const groups = await groupStories(root, await all()),
      aliases = (await index()).aliases;
    return groups
      .map(({ keep, remove }) => ({
        ...Schema.publicStory(keep),
        aliasIds: [
          ...new Set([
            ...remove.map((s) => s.id),
            ...Object.keys(aliases).filter((id) => {
              let target = aliases[id],
                seen = new Set([id]);
              while (aliases[target] && !seen.has(target)) {
                seen.add(target);
                target = aliases[target];
              }
              return target === keep.id || remove.some((s) => s.id === target);
            }),
          ]),
        ],
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const write = async (s) => {
    await atomic(path.join(root, 'versions', s.id, s.version + '.json'), s);
    await atomic(path.join(root, s.id + '.json'), s);
  };
  return {
    root,
    get,
    all,
    index,
    list,
    writeIndex: (data) => atomic(path.join(root, '.dedup-index.json'), data),
    async canonicalId(id) {
      const rows = await list();
      return rows.find((s) => s.id === id || s.aliasIds.includes(id))?.id || id;
    },
    save(body) {
      return locked(async () => {
        let clean;
        try {
          clean = Schema.validate(body);
        } catch (e) {
          throw new StoryError(400, 'INVALID_STORY', e.message);
        }
        const prior = body.id ? await get(body.id) : null;
        if (prior && body.version !== prior.version)
          throw new StoryError(409, 'STORY_CONFLICT', '剧本已在其他页面更新，请重新载入后编辑');
        if (prior)
          await atomic(path.join(root, 'versions', prior.id, prior.version + '.json'), prior);
        const record = {
          ...clean,
          id: prior?.id || randomUUID(),
          version: (prior?.version || 0) + 1,
          updatedAt: new Date().toISOString(),
          video: null,
        };
        await write(record);
        return record;
      });
    },
    bindVideo(id, version, jobId, kind) {
      return locked(async () => {
        const story = await get(id);
        if (story.version !== version)
          throw new StoryError(409, 'STALE_VIDEO', '剧本已修改，这段视频不能绑定到新版剧本');
        story.video = {
          jobId,
          ...(kind === 'titles' ? { kind: 'titles' } : {}),
          url:
            (kind === 'titles' ? '/api/story-title-media/' : '/api/story-media/') +
            jobId +
            '/intro.mp4',
        };
        await write(story);
        return Schema.publicStory(story);
      });
    },
    unbindVideo(id, jobId) {
      return locked(async () => {
        const story = await get(id);
        if (story.video?.jobId === jobId) {
          story.video = null;
          await write(story);
        }
      });
    },
  };
}
module.exports = { createScenarioStore, StoryError, atomic, readAtomic, validId, dataRoot };
