'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  { randomUUID, createHash } = require('node:crypto');
const { atomic, readAtomic, validId, StoryError } = require('./scenario-store.cjs'),
  S = require('./scenario.js'),
  P = require('./workshop-preview.js'),
  { createPreviewMedia } = require('./preview-media.cjs');
const { SpeechError } = require('./voice.cjs');
function createPreviewJobs({ root, store, assets, media = createPreviewMedia() } = {}) {
  const active = new Map();
  let tail = Promise.resolve(),
    closed = false;
  const lock = (fn) => {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  };
  const file = (id) => path.join(root, id, 'job.json'),
    save = (j) => {
      j.updatedAt = new Date().toISOString();
      return atomic(file(j.id), j);
    };
  async function get(id) {
    if (!validId(id)) throw new StoryError(404, 'PREVIEW_NOT_FOUND', '找不到预演任务');
    try {
      return await readAtomic(file(id));
    } catch (e) {
      if (e.code === 'ENOENT') throw new StoryError(404, 'PREVIEW_NOT_FOUND', '找不到预演任务');
      throw e;
    }
  }
  async function list(storyId) {
    let ids;
    try {
      ids = await fs.readdir(root);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const read = await Promise.allSettled(ids.filter(validId).map(get)),
      rows = [];
    for (const result of read) {
      if (result.status === 'fulfilled') rows.push(result.value);
      else if (result.reason.code !== 'PREVIEW_NOT_FOUND') throw result.reason;
    }
    return rows
      .filter((j) => !storyId || j.storyId === storyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  function summary(j) {
    const interrupted = j.status === 'running' && !active.has(j.id),
      status = interrupted ? 'paused' : j.status;
    return {
      id: j.id,
      storyId: j.storyId,
      version: j.version,
      roomSize: j.roomSize,
      status,
      stage: j.stage,
      message: interrupted ? '进度已保存，可继续本地处理；不会调用付费模型' : j.message,
      duration: j.duration,
      fingerprint: j.fingerprint,
      selections: j.selections || null,
      reviews: j.reviews || {},
      confirmed: j.confirmed === true,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      scenes: j.scenes.map((s, i) => ({
        ...s,
        index: i,
        source: j.sources[i]
          ? {
              asset: j.sources[i].asset,
              start: j.sources[i].start,
              end: j.sources[i].end,
              sha256: j.sources[i].sha256,
            }
          : null,
      })),
      url: ['ready', 'confirmed'].includes(status)
        ? '/api/story-preview-media/' + j.id + '/preview.mp4'
        : null,
    };
  }
  async function work(id, signal) {
    const j = await get(id);
    try {
      for (let i = 0; i < j.scenes.length; i++) {
        if (j.scenes[i].status === 'done') continue;
        j.scenes[i].status = 'processing';
        await save(j);
        const result = await media.scene(path.join(root, id), j, i, {
          signal,
          onProgress: async (stage, message) => {
            j.stage = stage;
            j.message = message;
            await save(j);
          },
        });
        j.scenes[i] = { ...j.scenes[i], ...result, status: 'done' };
        await save(j);
      }
      j.stage = 'assembling';
      j.message = '正在连续合成预演、中文字幕与配乐';
      await save(j);
      await media.assemble(path.join(root, id), j, { signal });
      j.stage = 'complete';
      j.status = 'ready';
      j.message = '预演已完成。请连续观看并确认叙事；静态画面和临时对白不代表正式口型效果。';
      await save(j);
    } catch (e) {
      j.status = 'paused';
      j.message =
        e instanceof StoryError || e instanceof SpeechError || e.code === 'SPEECH_TIMEOUT'
          ? e.message
          : signal.aborted
            ? '处理已暂停，完成素材已保留'
            : '预演处理失败，已保留素材，可继续处理';
      j.errorCode = e.code || 'PREVIEW_PROCESS_FAILED';
      await save(j);
    }
  }
  function launch(id) {
    if (active.has(id) || closed) return;
    const controller = new AbortController(),
      promise = work(id, controller.signal).finally(() => active.delete(id));
    active.set(id, { controller, promise });
  }
  return {
    root,
    get,
    summary,
    async list(id) {
      return (await list(id)).map(summary);
    },
    create(body) {
      return lock(async () => {
        const s = await store.get(body?.storyId);
        if (s.version !== body.version)
          throw new StoryError(409, 'STALE_STORY', '剧本版本已改变，请重新载入');
        const state = P.clean(body.rehearsal),
          issues = [
            ...P.preflight(s, state, { requireReviews: false }),
            ...require('./character-intros.js').issues(s),
          ];
        if (issues.length) throw new StoryError(400, 'PREVIEW_PREFLIGHT', issues.join('；'));
        const sourceFiles = await Promise.all(
          s.scenes.map(async (scene, i) => {
            const choice = state.selections[i];
            if (!choice) return null;
            const source = await assets.resolve(choice.asset, s.roomSize || 6),
              bytes = await fs.readFile(source.file),
              sha256 = createHash('sha256').update(bytes).digest('hex'),
              start = choice.start || 0,
              end = choice.end ?? source.duration;
            if (
              source.mime === 'video/mp4' &&
              (start + scene.duration > end + 0.05 || end > source.duration + 0.05)
            )
              throw new StoryError(
                400,
                'PREVIEW_SOURCE_TOO_SHORT',
                '镜头 ' + (i + 1) + ' 的视频区间不足，请换静态分镜或更长视频',
              );
            return { ...source, asset: choice.asset, start, end, sha256 };
          }),
        );
        const fingerprint = P.fingerprint(s, state),
          signature = createHash('sha256')
            .update(
              JSON.stringify([
                s.id,
                s.version,
                fingerprint,
                sourceFiles.map((x) => x && [x.sha256, x.start, x.end]),
              ]),
            )
            .digest('hex'),
          prior = (await list(s.id)).find((j) => j.signature === signature);
        if (prior) return summary(prior);
        const id = randomUUID(),
          dir = path.join(root, id);
        await fs.mkdir(dir, { recursive: true });
        const sources = await Promise.all(
          sourceFiles.map(async (source, i) => {
            if (!source) return null;
            const dest = path.join(
              dir,
              'source-' + i + (source.mime === 'video/mp4' ? '.mp4' : '.png'),
            );
            await fs.copyFile(source.file, dest);
            return {
              asset: source.asset,
              mime: source.mime,
              file: dest,
              start: source.start,
              end: source.end,
              duration: source.duration,
              sha256: source.sha256,
              origin: { taskId: source.id, storyId: source.storyId, version: source.version },
            };
          }),
        );
        const j = {
          id,
          storyId: s.id,
          version: s.version,
          roomSize: s.roomSize || 6,
          status: 'running',
          stage: 'queued',
          message: '预演任务已保存，仅使用本地素材与免费语音',
          createdAt: new Date().toISOString(),
          signature,
          fingerprint,
          selections: state.selections,
          reviews: state.reviews,
          confirmed: false,
          duration: s.scenes.reduce((n, x) => n + x.duration, 0),
          story: {
            title: s.title,
            roomSize: s.roomSize || 6,
            characters: s.characters.map((c) => ({
              ...S.voiceSnapshot(c),
              publicIdentity: c.publicIdentity,
            })),
            voiceContractVersion: 4,
            scenes: s.scenes,
            introductions: s.introductions,
          },
          sources,
          scenes: s.scenes.map((x, i) => ({
            index: i,
            duration: x.duration,
            status: 'queued',
            visual:
              sources[i]?.mime === 'video/mp4' ? 'video' : sources[i] ? 'storyboard' : 'missing',
          })),
        };
        // Only byte-identical source intervals and unchanged public scene content can reuse a rendered preview shot.
        const shotKey = (job, i) =>
          P.signature([
            job.story.voiceContractVersion || 0,
            job.story.characters,
            job.story.scenes.length,
            job.story.scenes[i],
            job.sources[i] && [job.sources[i].sha256, job.sources[i].start, job.sources[i].end],
          ]);
        for (const old of await list(s.id))
          for (let i = 0; i < j.scenes.length; i++)
            if (
              j.scenes[i].status === 'queued' &&
              old.scenes[i]?.status === 'done' &&
              shotKey(old, i) === shotKey(j, i)
            ) {
              try {
                await fs.copyFile(
                  path.join(root, old.id, 'scene-' + i + '.mp4'),
                  path.join(dir, 'scene-' + i + '.mp4'),
                );
                j.scenes[i] = { ...old.scenes[i], reusedPreview: old.id };
              } catch (e) {
                if (e.code !== 'ENOENT') throw e;
              }
            }
        await save(j);
        launch(id);
        return summary(j);
      });
    },
    action(id, body) {
      return lock(async () => {
        if (active.has(id))
          throw new StoryError(409, 'PREVIEW_BUSY', '本地预演正在处理，请等待完成');
        const j = await get(id),
          s = await store.get(j.storyId);
        if (s.version !== j.version)
          throw new StoryError(409, 'STALE_PREVIEW', '这是旧版剧本的预演，修改后需重新制作');
        if (body.action === 'resume') {
          if (['ready', 'confirmed'].includes(j.status)) return summary(j);
          j.status = 'running';
          await save(j);
          launch(id);
          return summary(j);
        }
        if (body.action === 'confirm') {
          if (
            !['ready', 'confirmed'].includes(j.status) ||
            body.watched !== true ||
            body.fingerprint !== j.fingerprint
          )
            throw new StoryError(
              400,
              'PREVIEW_CONFIRM_REQUIRED',
              '请完整观看当前剧本和素材版本的预演，再确认叙事',
            );
          const reviews = P.clean({ reviews: body.rehearsal?.reviews || j.reviews });
          const issues = P.preflight(s, reviews);
          if (issues.length)
            throw new StoryError(400, 'PREVIEW_REVIEW_REQUIRED', issues.join('；'));
          j.reviews = reviews.reviews;
          j.confirmed = true;
          j.confirmedAt = new Date().toISOString();
          j.status = 'confirmed';
          await save(j);
          return summary(j);
        }
        throw new StoryError(400, 'PREVIEW_ACTION', '不支持此预演操作');
      });
    },
    async approved(id, storyId, version) {
      const j = await get(id);
      if (
        j.storyId !== storyId ||
        j.version !== version ||
        j.status !== 'confirmed' ||
        !j.confirmed
      )
        throw new StoryError(
          409,
          'NARRATIVE_PREVIEW_REQUIRED',
          '请先完整观看并确认当前剧本的本地预演，再进行正式制作',
        );
      return j;
    },
    async mediaFile(id, name) {
      if (name !== 'preview.mp4') throw new StoryError(404, 'PREVIEW_MEDIA', '找不到预演媒体');
      const j = await get(id);
      if (!['ready', 'confirmed'].includes(j.status))
        throw new StoryError(404, 'PREVIEW_NOT_READY', '预演尚未完成');
      return path.join(root, id, name);
    },
    async close() {
      closed = true;
      for (const a of active.values()) a.controller.abort();
      await Promise.allSettled([...active.values()].map((a) => a.promise));
    },
  };
}
module.exports = { createPreviewJobs };
