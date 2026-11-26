'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {atomic, readAtomic, validId, StoryError, dataRoot} = require('./scenario-store.cjs');
const {createImageProvider} = require('./image-provider.cjs');
const Scenario = require('./scenario.js');

function publicDescriptionContainsSecret(detail, characters = []) {
  const compact = String(detail || '').toLocaleLowerCase().replace(/[\s\u3000，。！？、；：‘’“”"'`~!@#$%^&*()\[\]{}<>\/\\|_-]+/g, '');
  return characters.some(character => {
    const secret = String(character?.secret || '').trim();
    if (!secret) return false;
    const normalized = secret.toLocaleLowerCase().replace(/[\s\u3000，。！？、；：‘’“”"'`~!@#$%^&*()\[\]{}<>\/\\|_-]+/g, '');
    return normalized.length >= 2 && (String(detail).toLocaleLowerCase().includes(secret.toLocaleLowerCase()) || compact.includes(normalized));
  });
}

const SUBJECTS = {
  table: {label: '宴会桌与桌面布置', kind: 'scene', prompt: 'A cinematic continuity reference for the banquet table and its arrangement, shown from a clear elevated three-quarter viewpoint. Keep a clearly visible empty host seat and show candlesticks, a message and other agreed objects in fixed relative positions. Show the full table shape and enough surrounding space to establish direction. Any permitted movement must be described separately. No people, no readable text, no collage.'},
  envelope: {label: '封好的邀请函', kind: 'prop', prompt: 'A cinematic continuity reference of one sealed antique invitation envelope with a wax seal. Show its shape, color, size and seal clearly on a plain dark surface. No hands, no person, no readable text, no collage.'},
  lantern: {label: '提灯', kind: 'prop', prompt: 'A cinematic continuity reference of one antique hand lantern, showing its handle, frame and warm light clearly against a plain dark surface. No hands, no person, no readable text, no collage.'}
};

function readContinuity(body, subject, characters) {
  const fixedLayout = String(body?.fixedLayout ?? body?.detail ?? '').trim();
  const allowedMovements = String(body?.allowedMovements ?? '').trim();
  if (Array.from(fixedLayout).length > 1000 || Array.from(allowedMovements).length > 1000 || publicDescriptionContainsSecret(fixedLayout, characters) || publicDescriptionContainsSecret(allowedMovements, characters)) {
    throw new StoryError(400, 'INVALID_PUBLIC_DESCRIPTION', '固定外观／布局和允许移动说明各不超过 1000 字，且不能包含人物秘密');
  }
  return {fixedLayout, allowedMovements};
}
function continuityPrompt(base, {fixedLayout, allowedMovements}) {
  return base + '\nContinuity lock: treat the approved reference as the exact source of truth for shape, orientation, scale, material, and relative placement. Do not redesign or rearrange it.' +
    (fixedLayout ? '\nFixed public appearance and layout: ' + fixedLayout : '') +
    '\nAllowed story movements only: ' + (allowedMovements || 'No changes unless explicitly shown in the selected scene. Keep all objects in their established positions.') +
    '\nNo other object may appear, disappear, change shape, or move between shots.';
}

function createKeyAssetJobs({root = path.join(dataRoot, 'key-assets'), store, references, config, reviewer, fetchImpl = fetch, provider = createImageProvider({config, fetchImpl}), assetRoot = __dirname} = {}) {
  const active = new Map();
  let tail = Promise.resolve();
  const lock = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  const save = job => atomic(path.join(root, job.id + '.json'), job);
  async function get(id) {
    if (!validId(id)) throw new StoryError(404, 'KEY_ASSET_NOT_FOUND', '找不到关键物品任务');
    try { return await readAtomic(path.join(root, id + '.json')); }
    catch (error) { if (error.code === 'ENOENT') throw new StoryError(404, 'KEY_ASSET_NOT_FOUND', '找不到关键物品任务'); throw error; }
  }
  async function list(storyId, size) {
    if (![6, 12].includes(size)) throw new StoryError(400, 'INVALID_ROOM_SIZE', '请选择六人或十二人');
    let names;
    try { names = await fs.readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const rows = await Promise.all(names.filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(async name => {
      try { return await readAtomic(path.join(root, name)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }));
    return rows.filter(job => job && job.storyId === storyId && job.roomSize === size)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(job => ({...job, status: job.status === 'generating' && !active.has(job.id) ? 'unknown' : job.status}));
  }
  async function run(job) {
    let responseReceived = false;
    try {
      const source = await fs.readFile(path.join(assetRoot, 'assets/manor/manor-room.webp'));
      const bytes = await provider.generate({prompt: job.prompt, references: [source], size: '1536x1024'});
      responseReceived = true;
      const raw = path.join(root, job.id + '.image');
      await fs.writeFile(raw, bytes, {flag: 'wx'});
      job.status = 'received';
      await save(job);
      job.reference = await references.saveGenerated({roomSize: job.roomSize, label: job.label, kind: SUBJECTS[job.subject].kind, bytes});
      job.status = 'done';
      job.message = '图片已保存，请进行检查并确认。';
    } catch (error) {
      job.status = job.status === 'received' ? 'received' : responseReceived || /UNKNOWN|TIMEOUT|UNSAVED|INVALID|CANCELLED/.test(error.code || '') ? 'unknown' : 'failed';
      job.message = job.status === 'received' ? '原始图片已保存，本地处理失败，可免费恢复。' : responseReceived ? '供应商已返回图片，但本地保存失败，结果不明，请检查存储并人工核对，避免重复付费。' : (error.message || '图片生成失败，请检查服务配置。');
      job.errorCode = error.code || 'KEY_ASSET_FAILED';
    }
    job.updatedAt = new Date().toISOString();
    await save(job);
  }
  return {
    list,
    async reuse(body) {
      return lock(async () => {
        const subject = SUBJECTS[body?.subject];
        if (!subject || ![6, 12].includes(body.roomSize)) throw new StoryError(400, 'INVALID_KEY_ASSET', '关键物品或人数无效');
        const story = await store.get(body.storyId);
        if (story.version !== body.version || (story.roomSize || 6) !== body.roomSize) throw new StoryError(409, 'STORY_CHANGED', '剧本版本或人数已变化');
        const ref = await references.get(body.referenceId, body.roomSize);
        if (ref.kind !== subject.kind) throw new StoryError(400, 'INVALID_REFERENCE', '参考图用途与关键物品不匹配');
        const now = new Date().toISOString();
        const continuity = readContinuity(body, subject, story.characters || []);
      const job = {id: randomUUID(), storyId: story.id, version: story.version, roomSize: body.roomSize, subject: body.subject, label: subject.label, ...continuity, status: 'done', reference: references.summary(ref), sourceReferenceId: ref.id, createdAt: now, updatedAt: now, confirmedAt: null, message: '已引用历史参考图，请检查并确认。'};
        await fs.mkdir(root, {recursive: true}); await save(job); return job;
      });
    },
    async applyReferences(body) {
      return lock(async () => {
        if (!Array.isArray(body?.items) || !body.items.length || body.items.length > 3) throw new StoryError(400, 'INVALID_KEY_ASSET_MAPPING', '请选择至少一项、最多三项关键物品映射');
        const story = await store.get(body.storyId);
        if (story.version !== body.version || (story.roomSize || 6) !== body.roomSize) throw new StoryError(409, 'STORY_CHANGED', '剧本版本或人数已变化，请刷新后重新确认映射');
        const seenJobs = new Set();
        const next = structuredClone(story);
        const applied = [];
        for (const selection of body.items) {
          if (!validId(selection?.jobId) || seenJobs.has(selection.jobId) || !Array.isArray(selection.scenes) || !selection.scenes.length) throw new StoryError(400, 'INVALID_KEY_ASSET_MAPPING', '每项关键物品需选择不同任务及至少一个镜头');
          seenJobs.add(selection.jobId);
          const job = await get(selection.jobId);
          if (job.storyId !== story.id || job.roomSize !== body.roomSize || job.version !== story.version || job.status !== 'done' || !job.reference || !job.confirmedAt || !job.review) throw new StoryError(409, 'KEY_ASSET_NOT_CONFIRMED', '只能应用当前剧本版本中已检查并确认的关键物品图');
          const indexes = [...new Set(selection.scenes)];
          if (indexes.some(index => !Number.isInteger(index) || index < 0 || index >= next.scenes.length)) throw new StoryError(400, 'INVALID_KEY_ASSET_MAPPING', '镜头编号超出当前剧本范围');
          const purpose = SUBJECTS[job.subject].kind === 'scene' ? 'scene' : 'prop';
          const continuity = {...(job.fixedLayout ? {fixedLayout: job.fixedLayout} : {}), ...(job.allowedMovements ? {allowedMovements: job.allowedMovements} : {})};
          for (const index of indexes) {
            const refs = next.scenes[index].extraReferences || [];
            const existing = refs.find(ref => ref.id === job.reference.id);
            if (existing) Object.assign(existing, continuity);
            else refs.push({id: job.reference.id, purpose, ...continuity});
            next.scenes[index].extraReferences = refs;
          }
          applied.push({job, scenes: indexes});
        }
        next.confirmed = false;
        let clean;
        try { clean = Scenario.validate(next); }
        catch (error) { throw new StoryError(400, 'INVALID_KEY_ASSET_MAPPING', error.message); }
        const saved = await store.save({...clean, id: story.id, version: story.version, confirmed: false});
        const appliedAt = new Date().toISOString();
        for (const entry of applied) { entry.job.appliedMappings = [...(entry.job.appliedMappings || []), {version: saved.version, scenes: entry.scenes, referenceId: entry.job.reference.id, appliedAt}]; entry.job.updatedAt = appliedAt; await save(entry.job); }
        return {story: saved, mappings: applied.map(({job, scenes}) => ({jobId: job.id, label: job.label, scenes}))};
      });
    },
    async create(body) {
      return lock(async () => {
        const subject = SUBJECTS[body?.subject];
        if (!subject || ![6, 12].includes(body.roomSize)) throw new StoryError(400, 'INVALID_KEY_ASSET', '关键物品或人数无效');
        if (body.confirmCharge !== true) throw new StoryError(400, 'CHARGE_CONFIRM_REQUIRED', '生成一张关键物品图片需要先确认费用');
        const story = await store.get(body.storyId);
        if (story.version !== body.version || (story.roomSize || 6) !== body.roomSize) throw new StoryError(409, 'STORY_CHANGED', '剧本版本或人数已变化，请刷新后重试');
        const continuity = readContinuity(body, subject, story.characters || []);
        const prior = await list(body.storyId, body.roomSize);
        if (prior.some(job => job.subject === body.subject && ['generating', 'unknown', 'received'].includes(job.status))) throw new StoryError(409, 'KEY_ASSET_UNCERTAIN', '该物品已有进行中、待恢复或结果不明的请求，请先处理原任务');
        if (!await config.loadCredential()) throw new StoryError(400, 'IMAGE_KEY_REQUIRED', '请先保存图片专用密钥');
        const now = new Date().toISOString();
        const prompt = continuityPrompt(subject.prompt, continuity);
        const job = {id: randomUUID(), storyId: story.id, version: story.version, roomSize: body.roomSize, subject: body.subject, label: subject.label, ...continuity, prompt, status: 'generating', createdAt: now, updatedAt: now, confirmedAt: null, message: '正在生成，重复打开页面不会重新提交。'};
        await fs.mkdir(root, {recursive: true});
        await save(job);
        const promise = run(job).catch(error => { console.error('关键物品任务本地保存失败', job.id, error.code || 'IO_ERROR'); }).finally(() => active.delete(job.id));
        active.set(job.id, promise);
        return job;
      });
    },
    async action(id, body) {
      if (body?.action === 'review') {
        const job = await get(id);
        const story = await store.get(job.storyId);
        if (story.version !== job.version || (story.roomSize || 6) !== job.roomSize) throw new StoryError(409, 'STORY_CHANGED', '剧本版本已变化，请先切换回对应版本');
        if (job.status !== 'done' || !job.reference) throw new StoryError(409, 'KEY_ASSET_NOT_READY', '图片尚未完成');
        const ref = await references.get(job.reference.id, job.roomSize);
        const agent = reviewer.credential(body.agent);
        const report = await reviewer.check({agent, story, kind: 'keyAsset', images: [{file: ref.file, label: job.label + '定妆参考图'}]});
        return lock(async () => { const latest = await get(id); if (latest.reference?.id !== ref.id) throw new StoryError(409, 'KEY_ASSET_CHANGED', '检查期间图片已变化'); latest.review = report; latest.confirmedAt = null; latest.updatedAt = new Date().toISOString(); await save(latest); return latest; });
      }
      return lock(async () => {
        const job = await get(id);
        if (job.status === 'generating' && !active.has(job.id)) job.status = 'unknown';
        if (body?.action === 'recover' && job.status === 'received') {
          const bytes = await fs.readFile(path.join(root, id + '.image'));
          job.reference = await references.saveGenerated({roomSize: job.roomSize, label: job.label, kind: SUBJECTS[job.subject].kind, bytes});
          job.status = 'done'; job.message = '已从本地原图恢复，请检查并确认。';
        } else if (body?.action === 'resolveUnknown' && job.status === 'unknown') {
          if (body.reconciled !== true) throw new StoryError(400, 'RECONCILIATION_REQUIRED', '请先核对供应商任务和费用，再解除结果不明状态');
          job.status = 'held'; job.message = '已人工核对供应商结果；如需重新生成，须再次确认费用。'; job.reconciledAt = new Date().toISOString();
        } else if (body?.action === 'confirm') {
          const story = await store.get(job.storyId);
          if (story.version !== job.version || (story.roomSize || 6) !== job.roomSize) throw new StoryError(409, 'STORY_CHANGED', '剧本版本已变化，请先切换回对应版本');
          if (job.status !== 'done' || !job.reference || !job.review) throw new StoryError(409, 'KEY_ASSET_NOT_READY', '请先完成图片与 AI 检查');
          job.confirmedAt = new Date().toISOString();
        } else throw new StoryError(400, 'INVALID_ACTION', '操作无效');
        job.updatedAt = new Date().toISOString(); await save(job); return job;
      });
    }
  };
}
module.exports = {createKeyAssetJobs, SUBJECTS};
