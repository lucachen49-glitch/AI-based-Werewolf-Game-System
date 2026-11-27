'use strict';
const AgentRequest = require('./agent-request.js');
const Limits = require('./limits.js');
const { assertSameOrigin, assertJSON } = require('./request-guard.cjs');
const fs = require('node:fs'),
  fsp = require('node:fs/promises');
const Schema = require('./scenario.js');
const Preview = require('./workshop-preview.js');
const { StoryError, createScenarioStore } = require('./scenario-store.cjs');
const { createVideoConfigStore } = require('./video-config.cjs');
const { createVideoJobs } = require('./video-jobs.cjs');
const { createStoryArtJobs } = require('./story-art-jobs.cjs');
const { createImageConfigStore } = require('./image-config.cjs');
const path = require('node:path');
const { createStoryAssets } = require('./story-assets.cjs');
const { createPreviewJobs } = require('./story-preview-jobs.cjs');
const { createScenarioReviews } = require('./scenario-review.cjs');
function createStoryAPI({
  fetchImpl = fetch,
  store = createScenarioStore(),
  config = createVideoConfigStore(),
  jobs,
  imageConfig = createImageConfigStore(),
  artJobs,
  readJSON,
  sendJSON,
  validateChat,
  normalizeEndpoint,
  readUpstream,
  upstreamError,
} = {}) {
  const references = require('./story-references.cjs').createStoryReferences({
    root: path.join(store.root || require('./scenario-store.cjs').dataRoot, 'references'),
  });
  artJobs = artJobs || createStoryArtJobs({ store, config: imageConfig, fetchImpl, references });
  jobs = jobs || createVideoJobs({ store, config, artJobs, fetchImpl, references });
  const assets = createStoryAssets({ jobs, artJobs });
  const previews = createPreviewJobs({
    root: path.join(store.root || require('./scenario-store.cjs').dataRoot, 'previews'),
    store,
    assets,
  });
  const reviews = createScenarioReviews({
    root: path.join(store.root || require('./scenario-store.cjs').dataRoot, 'reviews'),
    store,
    fetchImpl,
    validateChat,
    normalizeEndpoint,
    readUpstream,
    upstreamError,
  });
  const titles = require('./story-title-jobs.cjs').createTitleJobs({
    root: path.join(store.root || require('./scenario-store.cjs').dataRoot, 'titles'),
    store,
    jobs,
  });
  const subtitles = require('./story-subtitles.cjs').createSubtitleJobs({
    root: path.join(store.root || require('./scenario-store.cjs').dataRoot, 'subtitles'),
    jobs,
  });
  const reviewer = require('./story-production-review.cjs').createProductionReviewer({
    fetchImpl,
    validateChat,
    normalizeEndpoint,
  });
  const keyAssets = require('./story-key-assets.cjs').createKeyAssetJobs({
    root: path.join(store.root || require('./scenario-store.cjs').dataRoot, 'key-assets'),
    store,
    references,
    config: imageConfig,
    fetchImpl,
    reviewer,
  });
  const productions = require('./story-production-jobs.cjs').createProductionJobs({
    root: path.join(store.root || require('./scenario-store.cjs').dataRoot, 'productions'),
    store,
    artJobs,
    jobs,
    subtitles,
    reviewer,
  });
  async function managedEdit(service, id) {
    const task = await service.get(id);
    if (task.productionId) {
      const production = await productions.get(task.productionId);
      if (!['paused', 'blocked', 'cancelled', 'complete'].includes(production.status))
        throw new StoryError(
          409,
          'AUTOMATIC_TASK_ACTIVE',
          '该素材由自动制作管理，请先暂停自动制作，再进入高级编辑。',
        );
    }
  }
  async function checkProduction(body) {
    const story = await store.get(body?.storyId);
    if (story.version !== body?.version)
      throw new StoryError(409, 'STALE_STORY', '剧本版本已更新，请重新载入');
    if (story.cinematic) {
      const issues = [
        ...Preview.preflight(story, {}, { requireReviews: false }),
        ...Schema.voiceIssues(story),
      ];
      if (issues.length) throw new StoryError(400, 'PRODUCTION_CHECK_FAILED', issues.join('；'));
    }
  }
  async function prepare(body, signal) {
    if (body?.roomSize !== undefined && ![6, 12].includes(body.roomSize))
      throw new StoryError(400, 'INVALID_ROOM_SIZE', '房间人数仅支持 6 或 12');
    if (typeof body?.source !== 'string' || !body.source.trim() || body.source.length > 16000)
      throw new StoryError(400, 'INVALID_SOURCE', '请填写不超过 16000 字的原始剧本');
    const messages = [
      { role: 'system', content: Schema.prepareForRoom(body.roomSize === 12 ? 12 : 6) },
      { role: 'user', content: body.source },
    ];
    const chat = { ...body, messages };
    validateChat(chat);
    const c = new AbortController(),
      abort = () => c.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Limits.AGENT_UPSTREAM_TIMEOUT_MS);
    try {
      const r = await fetchImpl(normalizeEndpoint(chat.endpoint), {
        method: 'POST',
        redirect: 'error',
        signal: c.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(chat.apiKey ? { Authorization: 'Bearer ' + chat.apiKey.trim() } : {}),
        },
        body: JSON.stringify(
          AgentRequest.responsesBody({
            model: chat.model,
            messages,
            reasoning_effort: chat.reasoningEffort,
          }),
        ),
      });
      const data = await readUpstream(r, c);
      if (!r.ok) throw upstreamError(r.status, data, chat.reasoningEffort);
      let draft;
      try {
        draft = Schema.parse(AgentRequest.responseText(data));
        draft.roomSize = body.roomSize === 12 ? 12 : 6;
        draft.source = body.source;
        draft.confirmed = false;
        if (draft.roomSize === 6) draft.narrativeMode = 'continuity-v1';
        const clean = Schema.validate(draft);
        return {
          draft: clean,
          warnings: Array.isArray(draft.warnings)
            ? draft.warnings.filter((x) => typeof x === 'string').slice(0, 10)
            : [],
        };
      } catch (e) {
        if (e instanceof AgentRequest.ResponseError) throw e;
        throw new StoryError(502, 'STORY_PREPARE_INVALID', '整理结果需要调整：' + e.message);
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  async function media(req, res, id, name, service = jobs, mime = 'video/mp4') {
    const file = await service.mediaFile(id, name),
      stat = await fsp.stat(file),
      size = stat.size;
    let start = 0,
      end = size - 1,
      status = 200;
    if (req.headers.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!m || (!m[1] && !m[2])) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + size });
        return res.end();
      }
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), end) : end;
      } else start = Math.max(0, size - Number(m[2]));
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      ) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + size });
        return res.end();
      }
      status = 206;
    }
    res.writeHead(status, {
      'Content-Type': mime,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start, end });
    res.once('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
  async function handle(req, res, name) {
    const controller = new AbortController(),
      abort = () => controller.abort(),
      close = () => {
        if (!res.writableFinished) abort();
      };
    req.once('aborted', abort);
    res.once('close', close);
    try {
      const origin = 'http://' + req.headers.host;
      if (!assertSameOrigin(req, { write: !['GET', 'HEAD'].includes(req.method) }))
        throw new StoryError(403, 'INVALID_ORIGIN', '请从本机游戏页面打开剧本工坊');
      let match;
      if (
        (match = /^api\/story-subtitle-media\/([^/]+)\/(movie\.mp4|subtitles\.srt)$/.exec(name)) &&
        ['GET', 'HEAD'].includes(req.method)
      )
        return await media(
          req,
          res,
          match[1],
          match[2],
          subtitles,
          match[2].endsWith('.srt') ? 'text/plain; charset=utf-8' : 'video/mp4',
        );
      if (
        (match = /^api\/story-title-media\/([^/]+)\/([^/]+)$/.exec(name)) &&
        ['GET', 'HEAD'].includes(req.method)
      )
        return await media(req, res, match[1], match[2], titles);
      if (
        (match = /^api\/story-preview-media\/([^/]+)\/([^/]+)$/.exec(name)) &&
        ['GET', 'HEAD'].includes(req.method)
      )
        return await media(req, res, match[1], match[2], previews);
      if (
        (match = /^api\/story-assets\/references\/([^/]+)\/image$/.exec(name)) &&
        ['GET', 'HEAD'].includes(req.method)
      ) {
        const r = await references.get(
          match[1],
          Number(new URL(req.url, origin).searchParams.get('roomSize') || 6),
        );
        return await media(req, res, '', '', { mediaFile: async () => r.file }, 'image/png');
      }
      if (
        (match = /^api\/story-assets\/media\/([^/]+)$/.exec(name)) &&
        ['GET', 'HEAD'].includes(req.method)
      ) {
        const asset = await assets.resolve(
          decodeURIComponent(match[1]),
          Number(new URL(req.url, origin).searchParams.get('roomSize') || 6),
        );
        return await media(req, res, '', '', { mediaFile: async () => asset.file }, asset.mime);
      }
      if (
        (match = /^api\/story-media\/([^/]+)\/([^/]+)$/.exec(name)) &&
        ['GET', 'HEAD'].includes(req.method)
      )
        return await media(req, res, match[1], match[2]);
      if (
        (match = /^api\/story-art-media\/([^/]+)\/([^/]+)$/.exec(name)) &&
        ['GET', 'HEAD'].includes(req.method)
      ) {
        const file = await artJobs.mediaFile(match[1], match[2]),
          stat = await fsp.stat(file);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': stat.size,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(file);
        res.once('close', () => stream.destroy());
        stream.on('error', () => res.destroy());
        return stream.pipe(res);
      }
      let body;
      if (req.method === 'POST') {
        if (!assertJSON(req))
          throw new StoryError(415, 'INVALID_CONTENT_TYPE', '请使用剧本工坊保存');
        body = await readJSON(
          req,
          name === 'api/story-assets/references' ? 12 * 1024 * 1024 : 320000,
        );
      }
      let result;
      if (name === 'api/story-productions' && req.method === 'GET')
        result = await productions.list(new URL(req.url, origin).searchParams.get('storyId'));
      else if (name === 'api/story-productions' && req.method === 'POST')
        result = await productions.create(body);
      else if ((match = /^api\/story-productions\/([^/]+)$/.exec(name)) && req.method === 'GET')
        result = await productions.view(await productions.get(match[1]));
      else if (match && req.method === 'POST') result = await productions.action(match[1], body);
      else if (name === 'api/story-key-assets' && req.method === 'GET') {
        const url = new URL(req.url, origin);
        result = await keyAssets.list(
          url.searchParams.get('storyId'),
          Number(url.searchParams.get('roomSize')),
        );
      } else if (name === 'api/story-key-assets' && req.method === 'POST')
        result =
          body?.action === 'reuse'
            ? await keyAssets.reuse(body)
            : body?.action === 'applyReferences'
              ? await keyAssets.applyReferences(body)
              : await keyAssets.create(body);
      else if ((match = /^api\/story-key-assets\/([^/]+)$/.exec(name)) && req.method === 'POST')
        result = await keyAssets.action(match[1], body);
      else if (name === 'api/story-assets/references' && req.method === 'GET')
        result = await references.list(
          Number(new URL(req.url, origin).searchParams.get('roomSize') || 6),
        );
      else if (name === 'api/story-assets/references' && req.method === 'POST')
        result = await references.upload(body, controller.signal);
      else if (name === 'api/story-subtitles/suggestions' && req.method === 'GET')
        result = await subtitles.suggestions(new URL(req.url, origin).searchParams.get('sourceId'));
      else if (name === 'api/story-subtitles' && req.method === 'GET')
        result = await subtitles.list(new URL(req.url, origin).searchParams.get('sourceId'));
      else if (name === 'api/story-subtitles' && req.method === 'POST')
        result = await subtitles.create(body);
      else if ((match = /^api\/story-subtitles\/([^/]+)$/.exec(name)) && req.method === 'GET')
        result = await subtitles.getSummary(match[1]);
      else if (name === 'api/scenario-reviews' && req.method === 'GET') {
        const url = new URL(req.url, origin);
        result = await reviews.list(
          url.searchParams.get('storyId'),
          url.searchParams.has('version') ? Number(url.searchParams.get('version')) : undefined,
        );
      } else if (name === 'api/scenario-reviews' && req.method === 'POST')
        result = await reviews.review(body, controller.signal);
      else if (name === 'api/scenario-reviews/skip' && req.method === 'POST')
        result = await reviews.skip(body);
      else if (
        (match = /^api\/scenario-reviews\/([0-9a-f-]{36})\/revise$/.exec(name)) &&
        req.method === 'POST'
      )
        result = await reviews.revise({ ...body, id: match[1] }, controller.signal);
      else if (
        (match = /^api\/scenario-reviews\/([0-9a-f-]{36})$/.exec(name)) &&
        req.method === 'POST'
      ) {
        if (body?.action !== 'confirm')
          throw new StoryError(400, 'INVALID_REVIEW_ACTION', '不支持此核对操作');
        result = await reviews.confirm({ ...body, id: match[1] });
      } else if (name === 'api/story-title-jobs' && req.method === 'GET')
        result = await titles.list(new URL(req.url, origin).searchParams.get('storyId'));
      else if (name === 'api/story-title-jobs' && req.method === 'POST')
        result = await titles.create(body);
      else if ((match = /^api\/story-title-jobs\/([^/]+)$/.exec(name)) && req.method === 'GET')
        result = titles.summary(await titles.get(match[1]));
      else if (match && req.method === 'POST') result = await titles.action(match[1], body);
      else if (name === 'api/story-assets' && req.method === 'GET') {
        const size = Number(new URL(req.url, origin).searchParams.get('roomSize') || 6);
        result = await assets.catalog(size);
      } else if (name === 'api/story-preview-jobs' && req.method === 'GET')
        result = await previews.list(new URL(req.url, origin).searchParams.get('storyId'));
      else if (name === 'api/story-preview-jobs' && req.method === 'POST')
        throw new StoryError(
          410,
          'STORY_PREVIEW_RETIRED',
          '新版本已改为 AI 核对，不再创建本地叙事预演；历史预演仍可查看',
        );
      else if ((match = /^api\/story-preview-jobs\/([^/]+)$/.exec(name)) && req.method === 'GET')
        result = previews.summary(await previews.get(match[1]));
      else if (match && req.method === 'POST') result = await previews.action(match[1], body);
      else if (name === 'api/story-art-import' && req.method === 'POST') {
        await checkProduction(body);
        result = await artJobs.importAssets(body, assets.resolve);
      } else if (name === 'api/scenarios' && req.method === 'GET') result = await store.list();
      else if (name === 'api/scenarios' && req.method === 'POST') result = await store.save(body);
      else if (name === 'api/scenarios/prepare' && req.method === 'POST')
        result = await prepare(body, controller.signal);
      else if (
        (match = /^api\/scenarios\/([^/]+)(?:\/(edit|context\/(1[0-2]|[1-9])))?$/.exec(name)) &&
        req.method === 'GET'
      ) {
        const url = new URL(req.url, origin),
          s = await store.get(
            url.searchParams.has('version') ? match[1] : await store.canonicalId(match[1]),
            url.searchParams.has('version') ? Number(url.searchParams.get('version')) : undefined,
          );
        result =
          match[2] === 'edit'
            ? s
            : match[3]
              ? Schema.context(s, Number(match[3]))
              : Schema.publicStory(s);
      } else if (name === 'api/story-art-jobs' && req.method === 'POST') {
        await checkProduction(body);
        result = await artJobs.create({ ...body, productionId: undefined });
      } else if (name === 'api/story-art-jobs' && req.method === 'GET')
        result = await artJobs.list(new URL(req.url, origin).searchParams.get('storyId'));
      else if ((match = /^api\/story-art-jobs\/([^/]+)$/.exec(name)) && req.method === 'GET')
        result = artJobs.summary(await artJobs.get(match[1]));
      else if (match && req.method === 'POST') {
        await managedEdit(artJobs, match[1]);
        result = await artJobs.action(match[1], body);
      } else if (name === 'api/video-config' && req.method === 'GET')
        result = await config.status();
      else if (name === 'api/video-config' && req.method === 'POST')
        result = await config.save(body);
      else if (name === 'api/video-config/check' && req.method === 'POST')
        result = await jobs.check();
      else if (name === 'api/video-jobs' && req.method === 'POST') {
        await checkProduction(body);
        result = await jobs.create({ ...body, productionId: undefined });
      } else if (name === 'api/video-jobs' && req.method === 'GET')
        result = await jobs.list(new URL(req.url, origin).searchParams.get('storyId'));
      else if ((match = /^api\/video-jobs\/([^/]+)$/.exec(name)) && req.method === 'GET')
        result = jobs.summary(await jobs.get(match[1]));
      else if (match && req.method === 'POST') {
        await managedEdit(jobs, match[1]);
        if (body.action === 'approveScene')
          throw new StoryError(400, 'INVALID_ACTION', '请通过自动制作确认镜头');
        result = await jobs.action(match[1], body);
      } else throw new StoryError(404, 'STORY_ROUTE_NOT_FOUND', '找不到这个剧本功能');
      sendJSON(res, 200, result);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      const safe =
        e.status && typeof e.code === 'string'
          ? e
          : new StoryError(
              502,
              'STORY_SERVICE_FAILED',
              '剧本服务暂不可用，请重试；视频任务可稍后继续查询',
            );
      sendJSON(res, safe.status, { error: { code: safe.code, message: safe.message } });
    } finally {
      req.off('aborted', abort);
      res.off('close', close);
    }
  }
  return {
    handle,
    titles,
    jobs,
    artJobs,
    previews,
    reviews,
    assets,
    productions,
    recover: async () => {
      await Promise.all([jobs.recover(), artJobs.recover()]);
      await productions.recover();
    },
    close: async () => {
      await productions.close();
      await Promise.all([
        jobs.close(),
        artJobs.close(),
        previews.close(),
        titles.close(),
        subtitles.close(),
      ]);
    },
  };
}
module.exports = { createStoryAPI };
