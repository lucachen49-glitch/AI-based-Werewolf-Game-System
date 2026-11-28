'use strict';
const { guardedFetch } = require('./upstream-guard.cjs');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  { randomUUID, createHash } = require('node:crypto');
const { atomic, readAtomic, validId, StoryError, dataRoot } = require('./scenario-store.cjs'),
  S = require('./scenario.js'),
  Manor = require('./manor.js');
const { createImageProvider, validateImageInputs } = require('./image-provider.cjs');
const { run } = require('./video-media.cjs');
const fail = (code, message, status = 409) => {
  throw new StoryError(status, code, message);
};
async function normalizeImage(bytes, dest, { kind, signal }) {
  const input = dest + '.input';
  await fs.writeFile(input, bytes, { flag: 'wx' });
  try {
    const size = kind === 'character' ? '1024:1536' : '1536:864';
    await run(
      [
        '-y',
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        'scale=' +
          size +
          ':force_original_aspect_ratio=decrease,pad=' +
          size +
          ':(ow-iw)/2:(oh-ih)/2:color=0x241b17',
        dest,
      ],
      120000,
      signal,
    );
  } finally {
    await fs.rm(input, { force: true });
  }
}
function createStoryArtJobs({
  root = path.join(dataRoot, 'art'),
  store,
  config,
  fetchImpl = guardedFetch,
  provider = createImageProvider({ config, fetchImpl }),
  references: referenceLibrary,
  normalize = normalizeImage,
  assetRoot = __dirname,
} = {}) {
  const active = new Map(),
    pauseRequests = new Set();
  let tail = Promise.resolve(),
    stopped = false;
  const lock = (fn) => {
    const next = tail.then(fn);
    tail = next.catch(() => {});
    return next;
  };
  const file = (id) => path.join(root, id, 'job.json');
  async function get(id) {
    if (!validId(id)) fail('ART_NOT_FOUND', '找不到图片任务', 404);
    try {
      return await readAtomic(file(id));
    } catch (e) {
      if (e.code === 'ENOENT') fail('ART_NOT_FOUND', '找不到图片任务', 404);
      throw e;
    }
  }
  const save = (j) => {
    j.updatedAt = new Date().toISOString();
    return atomic(file(j.id), j);
  };
  const url = (j, item) => (item.file ? '/api/story-art-media/' + j.id + '/' + item.file : null);
  const now = () => new Date().toISOString();
  const digest = (value) =>
    createHash('sha256')
      .update(Buffer.isBuffer(value) ? value : JSON.stringify(value))
      .digest('hex');
  const promptVersion = 'workshop-art-v3';
  const itemPromptVersion = (kind, index, roomSize) =>
    kind === 'frame' && roomSize === 6 && index < 3
      ? 'workshop-art-v7-hand-opening'
      : promptVersion;
  const ready = (x) => x.status === 'done' && !!x.file;
  const confirmed = (j, kind, x) =>
    ready(x) &&
    !x.needsReview &&
    !x.needsRegeneration &&
    (x.confirmedAt === undefined
      ? !!(kind === 'character' || kind === 'visual' ? j.charactersConfirmed : j.framesConfirmed)
      : !!x.confirmedAt);
  const itemAt = (j, kind, i) =>
    (kind === 'character' ? j.characters : kind === 'visual' ? j.visualAssets || [] : j.frames)[i];
  const frameDeps = (j, s, i) =>
    [
      ...new Set([
        ...(s.scenes[i]?.referenceFrames || []),
        ...((j.productionId || ['previous-end', 'previous'].includes(s.scenes[i]?.startSource)) &&
        i > 0
          ? [i - 1]
          : []),
      ]),
    ].filter((k) => Number.isInteger(k) && k >= 0 && k < i);
  const deps = (j, s, kind, i) =>
    kind === 'character' || kind === 'visual'
      ? []
      : [
          ...(j.frames[i].cast || []).map((n) => 'character:' + (n - 1)),
          ...(j.visualAssets || [])
            .map((asset, index) => ((asset.scenes || []).includes(i) ? 'visual:' + index : null))
            .filter(Boolean),
          ...frameDeps(j, s, i).map((n) => 'frame:' + n),
        ];
  function bind(j, s) {
    for (const [kind, items] of [
      ['character', j.characters],
      ['visual', j.visualAssets || []],
      ['frame', j.frames],
    ])
      for (const [i, x] of items.entries()) {
        if (x.confirmedAt === undefined)
          x.confirmedAt = confirmed(j, kind, x) ? j.updatedAt || j.createdAt : null;
        x.dependencyIds = deps(j, s, kind, i);
      }
  }
  function invalidate(j, s, kind, i) {
    const item = itemAt(j, kind, i);
    item.confirmedAt = null;
    item.needsReview = true;
    delete item.review;
    if (kind === 'character' || kind === 'visual') j.charactersConfirmed = false;
    j.framesConfirmed = false;
    const affected = new Set();
    for (const [k, f] of j.frames.entries())
      if (
        (kind === 'character' && f.cast.includes(item.seat)) ||
        (kind === 'visual' && (item.scenes || []).includes(k)) ||
        (kind === 'frame' && i === k) ||
        frameDeps(j, s, k).some((n) => affected.has(n))
      ) {
        affected.add(k);
        f.confirmedAt = null;
        f.needsReview = true;
        delete f.review;
      }
  }
  async function inputs(j, s, kind, i) {
    const x = itemAt(j, kind, i),
      dir = path.join(root, j.id);
    const sceneStory =
      kind === 'frame'
        ? {
            ...s,
            scenes: s.scenes.map((scene, k) =>
              k === i ? { ...scene, description: x.description, cast: x.cast } : scene,
            ),
          }
        : s;
    let prompt = kind === 'visual' ? x.prompt : S.artPrompt(sceneStory, kind, i, j.characters);
    const names =
      kind === 'character'
        ? ['source-' + (i + 1) + '.webp']
        : kind === 'visual'
          ? []
          : x.cast.length
            ? x.cast.map((n) => j.characters[n - 1]?.file)
            : ['environment.webp'];
    if (kind === 'frame' && j.productionId) {
      if (x.cast.length) names.push('environment.webp');
      prompt +=
        '\nThe next reference after the listed characters is the shared manor architecture and visual style. Match the current script location; do not force outdoor and indoor shots to share one viewpoint.';
    }
    if (kind === 'frame')
      for (const asset of j.visualAssets || [])
        if ((asset.scenes || []).includes(i) && asset.file) {
          names.push(asset.file);
          prompt +=
            '\nA confirmed continuity reference for ' +
            asset.label +
            ' is included. Match its appearance and keep it stable unless this shot explicitly moves it.';
        }
    if (kind === 'frame')
      for (const k of frameDeps(j, s, i))
        if (j.frames[k]?.file) {
          names.push(j.frames[k].file);
          prompt +=
            '\nA reference from storyboard ' +
            (k + 1) +
            ' is included. Preserve costumes, lighting, props, action contact and screen direction as intended for the current shot; depict only its listed cast.';
        }
    if (names.some((n) => !n)) fail('ART_REFERENCE_REQUIRED', '对应人物参考图尚未完成');
    const references = await Promise.all(names.map((n) => fs.readFile(path.join(dir, n))));
    const referenceManifest = names.map((name, index) => ({
      order: index + 1,
      purpose:
        kind === 'character'
          ? 'character'
          : kind === 'visual'
            ? 'visual-asset'
            : name === 'environment.webp'
              ? 'scene'
              : (j.visualAssets || []).some((asset) => asset.file === name)
                ? 'visual-asset'
                : index < x.cast.length
                  ? 'character'
                  : 'previous-frame',
      source: name,
      sha256: digest(references[index]),
    }));
    if (kind === 'frame' && (s.scenes[i]?.extraReferences || []).length) {
      if (!referenceLibrary)
        fail(
          'ART_REFERENCE_LIBRARY_REQUIRED',
          '本镜选择了附加参考图，但参考素材库不可用；未提交生成请求',
        );
      for (const selected of s.scenes[i].extraReferences) {
        const reference = await referenceLibrary.get(selected.id, j.roomSize || 6);
        const bytes = await fs.readFile(reference.file);
        references.push(bytes);
        referenceManifest.push({
          order: references.length,
          purpose: selected.purpose,
          sourceId: reference.id,
          label: reference.label,
          fixedLayout: selected.fixedLayout || '',
          allowedMovements: selected.allowedMovements || '',
          sha256: digest(bytes),
        });
        prompt +=
          '\nReference ' +
          references.length +
          ' is ' +
          selected.purpose +
          ' reference ' +
          reference.label +
          '. Preserve its identifying features and the scripted arrangement and allowed movements.';
        if (selected.fixedLayout || selected.allowedMovements)
          prompt +=
            '\nCONTINUITY LOCK for this reference: fixed public appearance and layout: ' +
            (selected.fixedLayout || 'preserve the approved reference exactly') +
            '. Allowed story movements only: ' +
            (selected.allowedMovements || 'none; keep all objects in their established positions') +
            '. Do not introduce, remove, reshape or reposition any other object.';
      }
    }
    const mode = kind === 'visual' ? 'generation' : 'edit';
    validateImageInputs(prompt, references, { allowEmpty: mode === 'generation' });
    const cfg = await config.status?.();
    const identity =
      kind === 'character'
        ? s.characters[i]
        : kind === 'visual'
          ? { label: x.label, kind: x.kind, appearance: x.appearance, scenes: x.scenes }
          : x.cast.map((n) => s.characters[n - 1]);
    const publicIdentity = (Array.isArray(identity) ? identity : [identity]).map(
      ({ secret, ...c }) => c,
    );
    // Version is provenance; exact per-item inputs allow unchanged assets to survive a script revision.
    const itemVersion =
      kind === 'visual' ? 'workshop-visual-asset-v1' : itemPromptVersion(kind, i, j.roomSize || 6);
    return {
      prompt,
      references,
      referenceManifest,
      mode,
      model: cfg?.model || null,
      provider: cfg?.provider || null,
      promptVersion: itemVersion,
      contentFingerprint: digest([
        itemVersion,
        mode,
        cfg?.model,
        cfg?.provider,
        j.storyId,
        j.roomSize || 6,
        kind,
        i,
        publicIdentity,
        prompt,
        references.map(digest),
      ]),
    };
  }
  async function reuse(j, s, kind, i, source, selected) {
    if (
      !source ||
      source.id === j.id ||
      source.storyId !== j.storyId ||
      (source.roomSize || 6) !== (j.roomSize || 6)
    )
      return false;
    const x = itemAt(j, kind, i),
      y = selected || itemAt(source, kind, i);
    if (!y || !ready(y) || y.needsRegeneration || !y.contentFingerprint) return false;
    const expected = await inputs(j, s, kind, i);
    if (
      !expected.model ||
      !expected.provider ||
      y.contentFingerprint !== expected.contentFingerprint
    )
      return false;
    const file = await service.mediaFile(source.id, y.file);
    const bytes = await fs.readFile(file).catch(() => null);
    if (!bytes || digest(bytes) !== y.fileFingerprint) return false;
    const referenceManifest = [];
    for (const ref of y.referenceManifest || []) {
      const copy = { ...ref };
      if (ref.snapshotFile) {
        const snapshot = await fs
          .readFile(await service.mediaFile(source.id, ref.snapshotFile))
          .catch(() => null);
        if (!snapshot || digest(snapshot) !== ref.sha256) return false;
        copy.snapshotFile = randomUUID() + '.png';
        await fs.writeFile(path.join(root, j.id, copy.snapshotFile), snapshot, { flag: 'wx' });
      }
      referenceManifest.push(copy);
    }
    archive(j, kind, i);
    if (x.file !== y.file) invalidate(j, s, kind, i);
    const name = randomUUID() + '.png';
    await fs.writeFile(path.join(root, j.id, name), bytes, { flag: 'wx' });
    Object.assign(x, {
      file: name,
      referenceManifest,
      received: null,
      status: 'done',
      prompt: expected.prompt,
      contentFingerprint: expected.contentFingerprint,
      fileFingerprint: y.fileFingerprint,
      assetRevision: j.revision,
      promptVersion: expected.promptVersion,
      model: expected.model,
      needsReview: false,
      needsRegeneration: false,
      confirmedAt: null,
      message: '已复用兼容历史图片，未产生生成费用',
      sourceTaskId: source.id,
      sourceAssetId: y.file,
      reuse: {
        taskId: source.id,
        asset: y.file,
        assetRevision: y.assetRevision || source.revision,
        storyId: source.storyId,
        version: source.version,
        fingerprint: y.contentFingerprint,
        model: y.model,
        provider: expected.provider,
        reusedAt: now(),
      },
    });
    return true;
  }
  function summary(j) {
    const image = (kind, item) => ({
      ...item,
      referenceManifest: (item.referenceManifest || []).map((ref) => ({
        ...ref,
        url: ref.snapshotFile ? '/api/story-art-media/' + j.id + '/' + ref.snapshotFile : null,
      })),
      url: url(j, item),
      scriptId: j.storyId,
      scriptVersion: j.version,
      roomSize: j.roomSize || 6,
      confirmed: confirmed(j, kind, item),
      confirmationStatus: confirmed(j, kind, item) ? 'confirmed' : item.status,
    });
    return {
      roomSize: j.roomSize || 6,
      productionId: j.productionId || null,
      id: j.id,
      storyId: j.storyId,
      version: j.version,
      revision: j.revision,
      status: j.status,
      stage: j.stage,
      message: j.message || '',
      charactersConfirmed: j.charactersConfirmed,
      framesConfirmed: j.framesConfirmed,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      characters: j.characters.map((x) => image('character', x)),
      visualAssets: (j.visualAssets || []).map((x) => image('visual', x)),
      frames: j.frames.map((x) => image('frame', x)),
      history: j.history.map((h) => ({ ...h, url: url(j, h) })),
    };
  }
  async function list(storyId) {
    let ids;
    try {
      ids = await fs.readdir(root);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const results = await Promise.allSettled(ids.filter(validId).map(get)),
      jobs = [];
    for (const result of results) {
      if (result.status === 'fulfilled') jobs.push(result.value);
      else if (result.reason.code !== 'ART_NOT_FOUND') throw result.reason;
    }
    return jobs
      .filter((j) => !storyId || j.storyId === storyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function work(id, kind, signal, onlyIndex, continueQueued = false) {
    let j = await get(id),
      currentItem = null,
      currentKind = kind;
    try {
      const story = await store.get(j.storyId, j.version);
      const groups =
        kind === 'character'
          ? [
              ['character', j.characters],
              ['visual', j.visualAssets || []],
            ]
          : [[kind, kind === 'visual' ? j.visualAssets || [] : j.frames]];
      bind(j, story);
      j.status = 'running';
      j.stage = kind;
      await save(j);
      const sources = (await list(j.storyId)).filter(
        (source) => source.version < j.version && (source.roomSize || 6) === (j.roomSize || 6),
      );
      for (const [assetKind, items] of groups) {
        currentKind = assetKind;
        for (let i = 0; i < items.length; i++) {
          if (pauseRequests.has(id)) {
            j.status = 'paused';
            j.message = '已在当前图片完成后暂停，素材与提交记录已保存。';
            await save(j);
            return;
          }
          const item = items[i];
          if (
            (onlyIndex !== undefined &&
              assetKind === kind &&
              i !== onlyIndex &&
              !(continueQueued && i > onlyIndex && item.status === 'queued')) ||
            ['done', 'held'].includes(item.status)
          )
            continue;
          if (signal.aborted) return;
          if (item.status === 'submitting' || item.status === 'unknown') {
            item.status = 'unknown';
            j.status = 'needs_review';
            j.message = '上次图片提交结果不明，请先核对华龙后台，系统不会自动重发。';
            await save(j);
            return;
          }
          if (item.status === 'failed') {
            j.status = 'failed';
            await save(j);
            return;
          }
          if (onlyIndex === undefined) {
            let reused = false;
            for (const prior of sources)
              if (await reuse(j, story, assetKind, i, prior)) {
                reused = true;
                break;
              }
            if (reused) {
              await save(j);
              continue;
            }
          }
          currentItem = item;
          const { prompt, references, referenceManifest, mode, model, contentFingerprint } =
            await inputs(j, story, assetKind, i);
          for (const ref of referenceManifest.filter((ref) => ref.sourceId)) {
            const name = randomUUID() + '.png';
            await fs.writeFile(path.join(root, id, name), references[ref.order - 1], {
              flag: 'wx',
            });
            ref.snapshotFile = name;
          }
          Object.assign(item, {
            prompt,
            referenceManifest,
            model,
            promptVersion:
              assetKind === 'visual'
                ? 'workshop-visual-asset-v1'
                : itemPromptVersion(assetKind, i, j.roomSize || 6),
            contentFingerprint,
            assetRevision: j.revision,
            confirmedAt: null,
            needsReview: false,
            needsRegeneration: false,
          });
          delete item.review;
          delete item.reuse;
          delete item.sourceTaskId;
          delete item.sourceAssetId;
          item.status = 'submitting';
          item.startedAt = new Date().toISOString();
          item.phase = 'waiting';
          delete item.errorCode;
          item.message = '';
          j.message =
            '正在制作' +
            (assetKind === 'character'
              ? '人物定妆 '
              : assetKind === 'visual'
                ? '关键视觉素材 '
                : '分镜起始图 ') +
            (i + 1) +
            ' / ' +
            items.length;
          await save(j);
          const bytes = await provider.generate({
            prompt: item.prompt,
            references,
            mode,
            size: assetKind === 'character' ? '1024x1536' : '1536x864',
            signal,
            onProgress: async (phase) => {
              item.phase = phase;
              await save(j);
            },
          });
          const raw = 'received-' + randomUUID() + '.bin';
          await fs.writeFile(path.join(root, id, raw), bytes, { flag: 'wx' });
          item.received = raw;
          item.phase = 'processing';
          await save(j);
          const name = randomUUID() + '.png';
          await normalize(bytes, path.join(root, id, name), {
            kind: assetKind === 'character' ? 'character' : 'frame',
            signal,
          });
          item.fileFingerprint = digest(await fs.readFile(path.join(root, id, name)));
          item.file = name;
          item.status = 'done';
          item.phase = 'complete';
          item.message = '已保存，请检查';
          await save(j);
        }
      }
      j.status = [...j.characters, ...(j.visualAssets || []), ...j.frames].some(
        (x) => x.status === 'unknown',
      )
        ? 'needs_review'
        : 'review';
      j.message =
        onlyIndex !== undefined && !continueQueued
          ? '此图已保存，请检查；其他图片的制作进度保持不变。'
          : kind === 'character'
            ? '人物定妆与关键视觉素材已保存，请逐项检查并确认。'
            : kind === 'visual'
              ? '关键视觉素材已保存，请逐项检查并确认。'
              : j.frames.length + '张分镜已保存，请检查人物、位置和衔接，再整组确认。';
      await save(j);
    } catch (e) {
      const items =
          currentKind === 'character'
            ? j.characters
            : currentKind === 'visual'
              ? j.visualAssets || []
              : j.frames,
        item = items.find((x) => x.status === 'submitting') || currentItem;
      if (item) {
        item.errorCode = e instanceof StoryError ? e.code : 'IMAGE_PROCESSING_FAILED';
        item.failedPhase = item.phase;
        item.status = item.received
          ? 'saved_raw'
          : item.status !== 'submitting' ||
              (e instanceof StoryError && (e.status === 400 || e.code === 'IMAGE_REJECTED'))
            ? 'failed'
            : 'unknown';
        item.message = item.received
          ? '原始图片已保存，可继续本地处理，不会重新生成'
          : e instanceof StoryError
            ? e.message
            : '图片提交结果不明，请先核对后台';
      }
      j.status = item?.status === 'unknown' ? 'needs_review' : 'failed';
      j.message =
        item?.message || (e instanceof StoryError ? e.message : '图片处理失败，已保存进度。');
      await save(j);
    }
  }
  function launch(id, kind, onlyIndex, continueQueued = false) {
    if (active.has(id) || stopped) return;
    const c = new AbortController(),
      promise = work(id, kind, c.signal, onlyIndex, continueQueued)
        .finally(() => active.delete(id))
        .catch(() => {});
    active.set(id, { c, promise });
  }
  function archive(j, kind, index) {
    const item = (
      kind === 'character' ? j.characters : kind === 'visual' ? j.visualAssets || [] : j.frames
    )[index];
    if (
      item.file &&
      !j.history.some((h) => h.kind === kind && h.index === index && h.file === item.file)
    )
      j.history.push({ ...item, kind, index, revision: j.revision, archivedAt: now() });
  }
  async function current(j, revision) {
    const s = await store.get(j.storyId);
    if (s.version !== j.version) fail('STALE_ART', '这是旧剧本版本的图片，请为新版制作');
    if (revision !== j.revision) fail('ART_CONFLICT', '图片版本已更新，请刷新后重试');
    return s;
  }
  const service = {
    root,
    get,
    summary,
    async claim(id, productionId) {
      const j = await get(id);
      if (j.productionId === productionId) return summary(j);
      if (j.productionId || active.has(id))
        throw new StoryError(
          409,
          'TASK_IN_USE',
          '已有素材任务正在使用，请先暂停原任务后继续自动制作',
        );
      j.productionId = productionId;
      await save(j);
      return summary(j);
    },
    async pause(id) {
      pauseRequests.add(id);
      return summary(await get(id));
    },
    async unpause(id) {
      pauseRequests.delete(id);
    },
    importAssets(body, resolve) {
      return lock(async () => {
        const s = await store.get(body?.storyId),
          size = s.roomSize || 6;
        if (
          s.version !== body.version ||
          !s.confirmed ||
          ![6, 12].includes(size) ||
          (body.roomSize !== undefined && body.roomSize !== size)
        )
          fail('REUSE_STORY_REQUIRED', '请先保存并确认当前人数的剧本版本');
        if ((await list(s.id)).some((j) => j.version === s.version))
          fail('REUSE_EXISTING_TASK', '当前版本已有图片任务，请在新修订版中复用，避免覆盖原素材');
        const input = body.characters || {},
          frames = body.frames || {},
          id = randomUUID(),
          dir = path.join(root, id);
        const j = {
          roomSize: size,
          id,
          storyId: s.id,
          version: s.version,
          revision: 1,
          status: 'review',
          stage: 'character',
          charactersConfirmed: false,
          framesConfirmed: false,
          createdAt: new Date().toISOString(),
          characters: s.characters.map((c) => ({
            seat: c.seat,
            name: c.name,
            appearance: S.appearance(c),
            portraitId: c.portraitId || Manor.defaultId(c.seat - 1),
            status: 'queued',
          })),
          frames: s.scenes.map((x, i) => ({
            index: i,
            cast: S.sceneCast(s, i),
            description: x.description,
            status: 'queued',
          })),
          history: [],
          message: '旧素材已复制为新版待确认图片；未调用生成模型，未继承旧确认状态。',
        };
        const copies = [];
        for (const c of j.characters) {
          if (!input[c.seat]) continue;
          const source = await resolve(input[c.seat], size);
          if (
            source.kind !== 'character' ||
            source.item.seat !== c.seat ||
            source.storyId !== s.id ||
            source.version >= s.version ||
            source.roomSize !== size ||
            source.mime !== 'image/png' ||
            source.item.appearance !== c.appearance ||
            source.item.name !== c.name
          )
            fail(
              'REUSE_APPEARANCE_CHANGED',
              c.seat + '号外观或人物已变，请重新制作定妆照，不能直接复用旧确认',
            );
          copies.push({ item: c, source, key: input[c.seat] });
        }
        for (const f of j.frames) {
          if (!frames[f.index]) continue;
          const source = await resolve(frames[f.index], size);
          if (
            source.kind !== 'frame' ||
            source.storyId !== s.id ||
            source.version >= s.version ||
            source.roomSize !== size ||
            source.item.description !== f.description ||
            JSON.stringify(source.item.cast || []) !== JSON.stringify(f.cast || []) ||
            source.mime !== 'image/png'
          )
            fail('REUSE_FRAME_REQUIRED', '分镜复用仅支持已有分镜图片');
          copies.push({ item: f, source, key: frames[f.index] });
        }
        if (!copies.length) fail('REUSE_EMPTY', '请至少选择一张可复用图片');
        await fs.mkdir(dir, { recursive: true });
        for (const c of j.characters)
          await fs.copyFile(
            path.join(assetRoot, Manor.imagePath(c.portraitId)),
            path.join(dir, 'source-' + c.seat + '.webp'),
          );
        await fs.copyFile(
          path.join(assetRoot, 'assets/manor/manor-room.webp'),
          path.join(dir, 'environment.webp'),
        );
        for (const { item, source, key } of copies) {
          item.file = randomUUID() + '.png';
          await fs.copyFile(source.file, path.join(dir, item.file));
          item.status = 'done';
          item.message = '复用副本，请重新检查确认';
          item.reuse = {
            asset: key,
            taskId: source.id,
            storyId: source.storyId,
            version: source.version,
            confirmed: false,
          };
        }
        await save(j);
        return summary(j);
      });
    },
    async list(storyId) {
      return (await list(storyId)).map(summary);
    },
    create(body) {
      return lock(async () => {
        const s = await store.get(body?.storyId);
        if (s.version !== body?.version || !s.confirmed || !(s.cinematic || s.scenes.length === 6))
          fail('ART_STORY_REQUIRED', '请先保存并确认新版电影剧本或旧六镜头剧本', 400);
        const prior = (await list(s.id)).find((j) => j.version === s.version);
        if (prior) return summary(prior);
        if (body.confirmCharge !== true)
          fail('CHARGE_CONFIRM_REQUIRED', '制作人物定妆照需要明确确认图片费用', 400);
        if (!(await config.loadCredential()))
          fail('IMAGE_KEY_REQUIRED', '请先保存图片专用密钥', 400);
        for (const c of s.characters) {
          const asset = Manor.imagePath(c.portraitId || Manor.defaultId(c.seat - 1));
          if (!asset)
            fail(
              'PORTRAIT_MISSING',
              '人物参考素材不可用，请恢复立绘后再制作；未提交任何图片请求',
              400,
            );
          try {
            await fs.access(path.join(assetRoot, asset));
          } catch {
            fail(
              'PORTRAIT_MISSING',
              `${c.seat} 号人物参考素材缺失，请恢复立绘后再制作；未提交任何图片请求`,
              400,
            );
          }
        }
        const visualAssets = Array.isArray(body.visualAssets)
          ? body.visualAssets.slice(0, 8).map((x, i) => ({
              id: String(x.id || 'visual-' + (i + 1)),
              label: String(x.label || '视觉素材 ' + (i + 1)).slice(0, 80),
              kind: x.kind === 'scene' ? 'scene' : 'prop',
              appearance: String(x.appearance || '').slice(0, 1000),
              prompt: String(x.prompt || '').slice(0, 4000),
              scenes: [
                ...new Set(
                  (Array.isArray(x.scenes) ? x.scenes : []).filter(
                    (n) => Number.isInteger(n) && n >= 0 && n < s.scenes.length,
                  ),
                ),
              ],
              status: 'queued',
            }))
          : [];
        if (
          visualAssets.some(
            (x) =>
              !x.appearance ||
              !x.prompt ||
              !x.scenes.length ||
              s.characters.some((c) => c.secret && x.prompt.includes(c.secret)),
          )
        )
          fail('INVALID_VISUAL_ASSETS', '关键视觉素材方案无效或包含私人资料', 400);
        const j = {
          ...(body.productionId ? { productionId: body.productionId } : {}),
          roomSize: s.roomSize || 6,
          id: randomUUID(),
          storyId: s.id,
          version: s.version,
          revision: 1,
          status: 'running',
          stage: 'character',
          charactersConfirmed: false,
          framesConfirmed: false,
          createdAt: new Date().toISOString(),
          chargeAuthorization: {
            operator: 'local-user',
            at: now(),
            scope: '人物定妆、关键视觉素材及后续分镜，复用兼容素材不产生生成费用',
          },
          visualAssets,
          characters: s.characters.map((c) => ({
            seat: c.seat,
            name: c.name,
            appearance: S.appearance(c),
            portraitId: c.portraitId || Manor.defaultId(c.seat - 1),
            status: 'queued',
            chargeConfirmation: { operator: 'local-user', at: now(), kind: 'initial-character' },
          })),
          frames: s.scenes.map((scene, i) => ({
            index: i,
            cast: S.sceneCast(s, i),
            description: scene.description,
            status: 'queued',
          })),
          history: [],
        };
        await fs.mkdir(path.join(root, j.id), { recursive: true });
        for (const c of j.characters)
          await fs.copyFile(
            path.join(assetRoot, Manor.imagePath(c.portraitId)),
            path.join(root, j.id, 'source-' + c.seat + '.webp'),
          );
        await fs.copyFile(
          path.join(assetRoot, 'assets/manor/manor-room.webp'),
          path.join(root, j.id, 'environment.webp'),
        );
        await save(j);
        launch(j.id, 'character');
        return summary(j);
      });
    },
    action(id, body) {
      return lock(async () => {
        if (active.has(id)) {
          if ((await get(id)).status === 'running')
            fail('ART_BUSY', '图片正在制作，请等待当前步骤结束');
          await active.get(id)?.promise;
        }
        const j = await get(id),
          s = await current(j, body?.revision);
        bind(j, s);
        if (body.action === 'addVisualAssets') {
          if (!Array.isArray(body.visualAssets) || body.visualAssets.length === 0)
            fail('INVALID_VISUAL_ASSETS', '关键视觉素材清单为空，请重试方案检查', 400);
          const existing = j.visualAssets || [],
            incoming = body.visualAssets;
          if (existing.length + incoming.length > 8)
            fail('INVALID_VISUAL_ASSETS', '关键视觉素材最多保留 8 项', 400);
          const secrets = s.characters
              .map((c) => c.secret)
              .filter((x) => typeof x === 'string' && x.length > 3),
            additions = [];
          for (const raw of incoming) {
            if (!raw || typeof raw !== 'object')
              fail('INVALID_VISUAL_ASSETS', '关键视觉素材条目无效', 400);
            const label = String(raw.label || '')
                .trim()
                .slice(0, 80),
              kind = raw.kind === 'scene' ? 'scene' : raw.kind === 'prop' ? 'prop' : null,
              appearance = String(raw.appearance || '')
                .trim()
                .slice(0, 1000),
              prompt = String(raw.prompt || '')
                .trim()
                .slice(0, 4000);
            const scenes = [
              ...new Set(
                (Array.isArray(raw.scenes) ? raw.scenes : []).filter(
                  (n) => Number.isInteger(n) && n >= 0 && n < s.scenes.length,
                ),
              ),
            ];
            if (
              !label ||
              !kind ||
              !appearance ||
              !prompt ||
              !scenes.length ||
              secrets.some((secret) => appearance.includes(secret) || prompt.includes(secret))
            )
              fail('INVALID_VISUAL_ASSETS', '关键视觉素材字段无效或包含人物秘密', 400);
            const contentFingerprint = String(
              raw.contentFingerprint || digest({ label, kind, appearance, prompt, scenes }),
            );
            if (!/^[a-f0-9]{64}$/i.test(contentFingerprint))
              fail('INVALID_VISUAL_ASSETS', '关键视觉素材指纹无效', 400);
            if (
              existing.some((item) => item.contentFingerprint === contentFingerprint) ||
              additions.some((item) => item.contentFingerprint === contentFingerprint)
            )
              continue;
            additions.push({
              id: String(raw.id || 'visual-' + (existing.length + additions.length + 1)),
              label,
              kind,
              appearance,
              prompt,
              scenes,
              promptVersion: String(raw.promptVersion || 'visual-auto-v2'),
              contentFingerprint,
              status: 'queued',
              confirmedAt: null,
              needsReview: true,
              needsRegeneration: false,
              message: '关键视觉素材清单已补齐，尚未生成图片。',
            });
          }
          if (!additions.length) return summary(j);
          j.visualAssets = [...existing, ...additions];
          j.revision++;
          j.charactersConfirmed = false;
          j.framesConfirmed = false;
          for (const asset of additions)
            for (const frame of j.frames) {
              if (!(asset.scenes || []).includes(frame.index)) continue;
              frame.confirmedAt = null;
              frame.needsReview = true;
              frame.needsRegeneration = true;
              delete frame.review;
            }
          bind(j, s);
          j.stage = 'character';
          j.status = 'review';
          j.message = '关键视觉素材清单已补齐，图片尚未生成。请在制作范围和费用确认后继续。';
          await save(j);
          return summary(j);
        }
        if (body.action === 'confirmCharacters') {
          if (
            !j.characters.every((c) => confirmed(j, 'character', c)) ||
            (j.visualAssets || []).some((c) => !confirmed(j, 'visual', c))
          )
            fail('CHARACTERS_NOT_READY', '请先逐项确认全部人物与关键视觉素材');
          j.charactersConfirmed = true;
          j.stage = 'frame';
          j.message = '人物已确认，可制作分镜起始图。';
          await save(j);
          return summary(j);
        }
        if (body.action === 'confirmFrames') {
          if (!j.charactersConfirmed || !j.frames.every((c) => confirmed(j, 'frame', c)))
            fail('FRAMES_NOT_READY', '请先整组确认人物，再逐项确认全部分镜');
          j.framesConfirmed = true;
          j.stage = 'complete';
          j.message = '分镜已确认，可制作参考图视频。';
          await save(j);
          return summary(j);
        }
        if (body.action === 'resume') {
          const kind = j.charactersConfirmed ? 'frame' : 'character',
            items = kind === 'character' ? [...j.characters, ...(j.visualAssets || [])] : j.frames;
          if (
            items.some((x) => ['unknown', 'submitting', 'failed', 'saved_raw'].includes(x.status))
          )
            fail('ART_REVIEW_REQUIRED', '请先处理结果不明、失败或待处理的图片');
          if (!items.some((x) => x.status === 'queued' || x.status === 'held')) return summary(j);
          if (body.confirmCharge !== true)
            fail('CHARGE_CONFIRM_REQUIRED', '继续未完成图片会提交新的生成请求，请先确认费用', 400);
          for (const x of items) if (x.status === 'held') x.status = 'queued';
          for (const x of items)
            if (x.status === 'queued')
              x.chargeConfirmation = { operator: 'local-user', at: now(), kind: 'resume' };
          j.status = 'running';
          await save(j);
          launch(id, kind);
          return summary(j);
        }
        if (body.action === 'generateFrames') {
          if (!j.charactersConfirmed) fail('CHARACTERS_NOT_CONFIRMED', '请先整组确认人物');
          if (body.confirmCharge !== true)
            fail('CHARGE_CONFIRM_REQUIRED', '请确认分镜图片费用', 400);
          if (
            j.frames.some((f) =>
              ['unknown', 'submitting', 'failed', 'saved_raw'].includes(f.status),
            )
          )
            fail('FRAME_REVIEW_REQUIRED', '请先处理结果不明或失败的镜头');
          if (j.frames.every((f) => f.status === 'done')) return summary(j);
          for (const x of j.frames)
            if (x.status === 'queued')
              x.chargeConfirmation = { operator: 'local-user', at: now(), kind: 'storyboard' };
          j.status = 'running';
          await save(j);
          launch(id, 'frame');
          return summary(j);
        }
        const kind = ['confirmCharacter', 'retryCharacter'].includes(body.action)
            ? 'character'
            : ['confirmVisualAsset', 'retryVisualAsset'].includes(body.action)
              ? 'visual'
              : ['confirmFrame', 'retryFrame'].includes(body.action)
                ? 'frame'
                : body.kind,
          items =
            kind === 'character'
              ? j.characters
              : kind === 'visual'
                ? j.visualAssets || []
                : kind === 'frame'
                  ? j.frames
                  : null,
          index = body.index;
        if (!items || !Number.isInteger(index) || index < 0 || index >= items.length)
          fail('INVALID_ART_ITEM', '图片编号无效', 400);
        const item = items[index];
        if (body.action === 'recordReview') fail('INVALID_ART_ACTION', '不支持这个图片操作', 400);
        if (
          body.action === 'confirmCharacter' ||
          body.action === 'confirmVisualAsset' ||
          body.action === 'confirmFrame'
        ) {
          if (!ready(item) || item.needsRegeneration)
            fail('ART_ITEM_NOT_READY', '请先完成当前版本图片；引用已变更的定妆需单独重做');
          if (j.productionId && item.review?.file !== item.file)
            fail('ART_CHECK_REQUIRED', '请先完成当前图片的 AI 检查，或明确手动跳过');
          if (
            kind === 'frame' &&
            (!j.charactersConfirmed ||
              frameDeps(j, s, index).some(
                (i) => !confirmed(j, 'frame', j.frames[i]) || j.frames[i].needsRegeneration,
              ))
          )
            fail('ART_REFERENCE_REQUIRED', '请先确认人物并准备前置分镜');
          item.confirmedAt = now();
          item.needsReview = false;
          await save(j);
          return summary(j);
        }
        if (body.action === 'restoreAssetRevision') {
          const old = j.history.find(
            (h) => h.kind === kind && h.index === index && h.file === body.file,
          );
          if (!old || old.file === item.file || !ready(old))
            fail('ART_HISTORY_NOT_FOUND', '找不到这个历史版本');
          await fs.access(path.join(root, id, old.file));
          archive(j, kind, index);
          invalidate(j, s, kind, index);
          j.revision++;
          items[index] = {
            ...old,
            status: 'done',
            assetRevision: j.revision,
            confirmedAt: null,
            review: null,
            needsReview: true,
            needsRegeneration: false,
            message: '已恢复历史图片，请重新检查确认',
          };
          if (kind === 'frame' && old.contentFingerprint) {
            const expected = await inputs(j, s, kind, index);
            items[index].needsRegeneration = expected.contentFingerprint !== old.contentFingerprint;
          }
          await save(j);
          return summary(j);
        }
        if (body.action === 'reuseAsset') {
          const source = await get(body.sourceTaskId);
          j.revision++;
          const old = body.file
            ? source.history.find(
                (h) => h.kind === kind && h.index === index && h.file === body.file,
              )
            : undefined;
          if ((body.file && !old) || !(await reuse(j, s, kind, index, source, old)))
            fail('ART_REUSE_INCOMPATIBLE', '无法证明该历史图片与当前剧本和参考素材兼容');
          await save(j);
          return summary(j);
        }
        if (body.action === 'applyCandidate')
          fail('INVALID_ART_ACTION', '请通过制作任务采用候选', 400);
        if (body.action === 'processSaved') {
          if (!item.received || item.status !== 'saved_raw')
            fail('NO_SAVED_IMAGE', '没有待处理的原始图片');
          const name = randomUUID() + '.png';
          await normalize(
            await fs.readFile(path.join(root, id, item.received)),
            path.join(root, id, name),
            { kind },
          );
          item.fileFingerprint = digest(await fs.readFile(path.join(root, id, name)));
          item.file = name;
          item.status = 'done';
          j.status = 'review';
          await save(j);
          return summary(j);
        }
        if (!['retry', 'retryCharacter', 'retryVisualAsset', 'retryFrame'].includes(body.action))
          fail('INVALID_ART_ACTION', '不支持这个图片操作', 400);
        if (body.confirmCharge !== true)
          fail('CHARGE_CONFIRM_REQUIRED', '重做会新增一次图片生成，请先确认', 400);
        if (kind === 'frame' && !j.charactersConfirmed)
          fail('CHARACTERS_NOT_CONFIRMED', '请先确认人物');
        const text = body.description;
        if (
          text !== undefined &&
          (typeof text !== 'string' ||
            !text.trim() ||
            text.length > (kind === 'character' ? 800 : kind === 'visual' ? 4000 : 1000) ||
            s.characters.some((c) => c.secret && text.includes(c.secret)))
        )
          fail('INVALID_PUBLIC_DESCRIPTION', '请填写有效的公开外观或分镜描述，不包含人物秘密', 400);
        if (item.status === 'unknown' && body.reconciled !== true)
          fail('SUBMISSION_UNCERTAIN', '请先核对原供应商提交结果，再明确确认重做');
        if (body.continueQueued === true && kind !== 'frame')
          fail('INVALID_ART_ACTION', '仅分镜支持重做后继续', 400);
        if (
          body.continueQueued === true &&
          items.slice(index + 1).some((x) => !['queued', 'done'].includes(x.status))
        )
          fail('ART_REVIEW_REQUIRED', '后续镜头存在结果不明或失败，请先逐一处理');
        archive(j, kind, index);
        invalidate(j, s, kind, index);
        item.chargeConfirmation = {
          operator: 'local-user',
          at: now(),
          kind: 'single-retry',
          reconciled: body.reconciled === true,
        };
        if (text !== undefined)
          item[kind === 'character' ? 'appearance' : kind === 'visual' ? 'prompt' : 'description'] =
            text.trim();
        j.revision++;
        items[index] = { ...item, status: 'queued', received: null, message: '' };
        j.status = 'running';
        await save(j);
        pauseRequests.delete(id);
        launch(id, kind, index, body.continueQueued === true);
        return summary(j);
      });
    },
    recordReview(id, revision, kind, index, review) {
      return lock(async () => {
        const j = await get(id),
          x = itemAt(j, kind, index);
        if (j.revision !== revision || !ready(x)) fail('ART_CONFLICT', '检查期间图片已变更');
        x.review = { file: x.file, ...review };
        await save(j);
        return summary(j);
      });
    },
    revertCandidate(id, revision, kind, index, text, expectedFile) {
      return lock(async () => {
        const j = await get(id),
          s = await current(j, revision),
          x = itemAt(j, kind, index);
        if (active.has(id) || j.status === 'running') fail('ART_BUSY', '图片正在制作');
        if (!x || x.file !== expectedFile || typeof text !== 'string')
          fail('CANDIDATE_CHANGED', '当前图片已变化，请从历史版本手动恢复');
        invalidate(j, s, kind, index);
        x[kind === 'character' ? 'appearance' : kind === 'visual' ? 'prompt' : 'description'] =
          text;
        x.needsRegeneration = false;
        x.status = x.file ? 'done' : 'queued';
        x.message = '已撤销候选提示词；原图片已保留，请重新检查确认';
        j.revision++;
        await save(j);
        return summary(j);
      });
    },
    applyCandidate(id, revision, kind, index, text) {
      return lock(async () => {
        const j = await get(id),
          s = await current(j, revision),
          x = itemAt(j, kind, index);
        if (active.has(id) || j.status === 'running') fail('ART_BUSY', '图片正在制作');
        if (
          !x ||
          typeof text !== 'string' ||
          !text.trim() ||
          text.length > (kind === 'character' ? 800 : 1000) ||
          s.characters.some((c) => c.secret && text.includes(c.secret))
        )
          fail('INVALID_PUBLIC_DESCRIPTION', '整改内容无效或包含私人资料', 400);
        bind(j, s);
        archive(j, kind, index);
        invalidate(j, s, kind, index);
        x[kind === 'character' ? 'appearance' : kind === 'visual' ? 'prompt' : 'description'] =
          text.trim();
        x.needsRegeneration = true;
        x.message = '已采用新提示词，请确认费用后单独重做；原图已保留';
        j.revision++;
        await save(j);
        return summary(j);
      });
    },
    async approved(id, revision, storyId, version) {
      const j = await get(id);
      if (
        j.storyId !== storyId ||
        j.version !== version ||
        j.revision !== revision ||
        !j.charactersConfirmed ||
        !j.framesConfirmed ||
        !j.characters.every((x) => confirmed(j, 'character', x)) ||
        (j.visualAssets || []).some((x) => !confirmed(j, 'visual', x)) ||
        !j.frames.every((x) => confirmed(j, 'frame', x))
      )
        fail('ART_APPROVAL_REQUIRED', '请确认当前剧本版本的全部人物和分镜');
      return j;
    },
    async snapshot(id, revision, storyId, version, dest) {
      const j = await service.approved(id, revision, storyId, version);
      await fs.mkdir(dest, { recursive: true });
      const copy = async (item) => {
        const name = 'ref-' + randomUUID() + '.png';
        await fs.copyFile(path.join(root, id, item.file), path.join(dest, name));
        return name;
      };
      return {
        roomSize: j.roomSize || 6,
        id: j.id,
        revision: j.revision,
        characters: await Promise.all(
          j.characters.map(async (c) => ({
            seat: c.seat,
            name: c.name,
            appearance: c.appearance,
            file: await copy(c),
          })),
        ),
        visualAssets: await Promise.all(
          (j.visualAssets || []).map(async (asset) => ({
            id: asset.id,
            label: asset.label,
            kind: asset.kind,
            appearance: asset.appearance,
            scenes: asset.scenes,
            file: await copy(asset),
          })),
        ),
        frames: await Promise.all(
          j.frames.map(async (f) => ({
            index: f.index,
            cast: f.cast,
            description: f.description,
            file: await copy(f),
          })),
        ),
      };
    },
    async mediaFile(id, name) {
      if (!validId(id) || !validId(name?.replace(/\.png$/, '')) || !name.endsWith('.png'))
        fail('ART_MEDIA_NOT_FOUND', '找不到图片', 404);
      const j = await get(id);
      if (
        ![...j.characters, ...(j.visualAssets || []), ...j.frames, ...j.history].some(
          (x) =>
            x.file === name || (x.referenceManifest || []).some((ref) => ref.snapshotFile === name),
        )
      )
        fail('ART_MEDIA_NOT_FOUND', '找不到图片', 404);
      return path.join(root, id, name);
    },
    async recover() {
      for (const j of await list()) {
        let changed = false;
        for (const item of [...j.characters, ...(j.visualAssets || []), ...j.frames]) {
          if (item.status === 'submitting') {
            item.status = item.received ? 'saved_raw' : 'unknown';
            changed = true;
          }
        }
        if (changed || j.status === 'running') {
          j.status = [...j.characters, ...(j.visualAssets || []), ...j.frames].some(
            (x) => x.status === 'unknown',
          )
            ? 'needs_review'
            : 'paused';
          j.message = '服务已重启。已完成图片保留；未确认的提交不会自动重发。';
          await save(j);
        }
      }
    },
    async close() {
      stopped = true;
      for (const v of active.values()) v.c.abort();
      await Promise.all([...active.values()].map((v) => v.promise));
    },
  };
  return service;
}
module.exports = { createStoryArtJobs, normalizeImage };
