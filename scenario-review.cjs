'use strict';
const AgentRequest = require('./agent-request.js');
const Limits = require('./limits.js');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  { randomUUID, createHash } = require('node:crypto');
const Schema = require('./scenario.js');
const { StoryError, atomic, readAtomic, validId, dataRoot } = require('./scenario-store.cjs');
const fail = (status, code, message) => {
  throw new StoryError(status, code, message);
};
const summary = (r) => ({
  id: r.id,
  storyId: r.storyId,
  version: r.version,
  roomSize: r.roomSize,
  model: r.model,
  protocol: r.protocol,
  maxOutputTokens: r.maxOutputTokens,
  reasoningEffort: r.reasoningEffort,
  agentIdentity: r.agentIdentity,
  status: r.status,
  decision: r.decision || null,
  createdAt: r.createdAt,
  summary: r.summary || '',
  strengths: r.strengths || [],
  findings: r.findings || [],
});
const needsReview = (s) => !!s && (!!s.cinematic || s.narrativeMode === 'continuity-v1');
function content(s) {
  return {
    roomSize: s.roomSize || 6,
    title: s.title,
    source: s.source,
    background: s.background,
    visualGuide: s.visualGuide || '',
    characters: s.characters.map((c) => ({
      seat: c.seat,
      name: c.name,
      personality: c.personality,
      relationships: c.relationships,
      secret: c.secret,
    })),
    scenes: s.scenes.map((x) => ({
      duration: x.duration,
      cast: x.cast,
      description: x.description,
      startFrame: x.startFrame || '',
      endFrame: x.endFrame || '',
      narration: x.narration || '',
      narrationSeconds: x.narrationSeconds || 0,
      dialogues: x.dialogues || [],
    })),
  };
}
function revisionContent(s) {
  return {
    roomSize: s.roomSize || 6,
    title: s.title,
    source: s.source,
    background: s.background,
    visualGuide: s.visualGuide || '',
    narrativeMode: s.narrativeMode,
    cinematic: s.cinematic,
    targetDuration: s.targetDuration,
    introductions: s.introductions,
    characters: s.characters.map((c) => ({ ...c })),
    scenes: s.scenes.map((x) => ({ ...x, cast: x.cast || [], dialogues: x.dialogues || [] })),
  };
}
function fingerprint(s) {
  return createHash('sha256').update(Schema.productionSignature(s)).digest('hex');
}
function parseReport(text, secrets = []) {
  if (typeof text !== 'string' || text.length > 50000) throw Error('报告为空或过长');
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) text = match[1];
  const start = text.indexOf('{'),
    end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw Error('没有返回结构化审阅报告');
  const raw = JSON.parse(text.slice(start, end + 1));
  const redact = (value) => {
    let out = typeof value === 'string' ? value : '';
    for (const secret of secrets)
      if (typeof secret === 'string' && secret.trim().length >= 4)
        out = out.split(secret.trim()).join('[已隐藏私人信息]');
    return out;
  };
  const cleanLine = (value, max) => redact(value).trim().slice(0, max);
  if (!Array.isArray(raw.findings)) throw Error('报告缺少问题清单');
  return {
    summary: cleanLine(raw.summary, 1200),
    strengths: Array.isArray(raw.strengths)
      ? raw.strengths
          .slice(0, 12)
          .map((x) => cleanLine(x, 300))
          .filter(Boolean)
      : [],
    findings: raw.findings
      .slice(0, 40)
      .map((x) => ({
        severity: ['important', 'suggestion'].includes(x?.severity) ? x.severity : 'suggestion',
        category: cleanLine(x?.category, 60),
        location: cleanLine(x?.location, 100),
        issue: cleanLine(x?.issue, 500),
        suggestion: cleanLine(x?.suggestion, 600),
      }))
      .filter((x) => x.issue),
  };
}
function createScenarioReviews({
  root = path.join(dataRoot, 'reviews'),
  store,
  fetchImpl = fetch,
  validateChat,
  normalizeEndpoint,
  readUpstream,
  upstreamError,
} = {}) {
  const file = (id) => path.join(root, id + '.json');
  async function get(id) {
    if (!validId(id)) fail(404, 'REVIEW_NOT_FOUND', '找不到剧本核对记录');
    try {
      return await readAtomic(file(id));
    } catch (e) {
      if (e.code === 'ENOENT') fail(404, 'REVIEW_NOT_FOUND', '找不到剧本核对记录');
      throw e;
    }
  }
  async function list(storyId, version) {
    if (!validId(storyId)) fail(400, 'INVALID_STORY', '剧本编号无效');
    const s = await store.get(storyId, version);
    let files;
    try {
      files = await fs.readdir(root);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const rows = [];
    for (const name of files) {
      if (!name.endsWith('.json') || !validId(name.slice(0, -5))) continue;
      const r = await get(name.slice(0, -5));
      if (r.storyId === s.id && r.version === s.version && r.fingerprint === fingerprint(s))
        rows.push(summary(r));
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function review(body, signal) {
    if (!validId(body?.storyId) || !Number.isSafeInteger(body?.version))
      fail(400, 'INVALID_STORY', '剧本编号或版本无效');
    const s = await store.get(body.storyId, body.version);
    if (s.version !== body.version) fail(409, 'STALE_STORY', '剧本已更新，请重新载入');
    if (!s.confirmed) fail(400, 'UNCONFIRMED_STORY', '请先保存并确认剧本');
    if (!needsReview(s)) fail(400, 'REVIEW_NOT_REQUIRED', '此旧版剧本不需要 AI 核对');
    const messages = [
      {
        role: 'system',
        content:
          '你是剧本审阅编辑，只检查用户提供的剧本，不改写、不生成新剧本。检查故事因果与动机、人物关系和私人秘密之间的铺垫、每位角色的出场与对白、镜头动作和起止衔接、叙事节奏及对白/旁白时长，并检查私人秘密是否泄露到公开背景、分镜、旁白或对白。私人秘密已获用户授权供本次核对，但报告不得复述秘密原文；只用席位号、镜头号和字段位置描述问题。狼人杀身份随机发牌，背景血统不能推断游戏身份，不评判模型画面生成结果。不要提供或推断任何本局随机身份。只返回 JSON：{"summary":"总体评价","strengths":["有效之处"],"findings":[{"severity":"important 或 suggestion","category":"因果/人物/衔接/节奏/隐私/其他","location":"人物席位或镜头编号","issue":"具体问题，不复述秘密","suggestion":"可供作者选择的建议"}]}。没有问题时 findings 返回空数组。',
      },
      { role: 'user', content: JSON.stringify(content(s)) },
    ];
    const chat = { ...body, messages };
    validateChat(chat);
    const fp = fingerprint(s);
    const agentIdentity = createHash('sha256')
      .update(
        JSON.stringify([
          normalizeEndpoint(body.endpoint),
          body.model?.trim(),
          AgentRequest.normalizeReasoningEffort(body.reasoningEffort),
          AgentRequest.PROTOCOL,
          AgentRequest.OUTPUT_MAX_TOKENS,
        ]),
      )
      .digest('hex');
    const prior = (await list(s.id, s.version)).find(
      (r) =>
        r.agentIdentity === agentIdentity && (r.status === 'awaiting_confirmation' || r.decision),
    );
    if (prior) return prior;
    const controller = new AbortController(),
      abort = () => controller.abort(),
      timer = setTimeout(() => controller.abort(), Limits.AGENT_UPSTREAM_TIMEOUT_MS);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl(normalizeEndpoint(chat.endpoint), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
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
      const data = await readUpstream(response, controller);
      if (!response.ok) throw upstreamError(response.status, data, chat.reasoningEffort);
      let report;
      try {
        report = parseReport(
          AgentRequest.responseText(data),
          s.characters.map((c) => c.secret),
        );
      } catch (e) {
        if (e instanceof AgentRequest.ResponseError) throw e;
        throw new StoryError(
          502,
          'STORY_REVIEW_INVALID',
          'AI 核对结果无法读取：' + e.message + '。请重试，或手动跳过。',
        );
      }
      const row = {
        id: randomUUID(),
        storyId: s.id,
        version: s.version,
        roomSize: s.roomSize || 6,
        fingerprint: fp,
        agentIdentity,
        protocol: AgentRequest.PROTOCOL,
        maxOutputTokens: AgentRequest.OUTPUT_MAX_TOKENS,
        reasoningEffort: AgentRequest.normalizeReasoningEffort(chat.reasoningEffort),
        model: chat.model.trim().slice(0, 200),
        status: 'awaiting_confirmation',
        decision: null,
        createdAt: new Date().toISOString(),
        ...report,
      };
      await atomic(file(row.id), row);
      return summary(row);
    } catch (e) {
      if (controller.signal.aborted)
        throw new StoryError(
          504,
          'STORY_REVIEW_TIMEOUT',
          'AI 核对请求超时或已取消。可重试，或手动跳过本次核对。',
        );
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async function revise(body, signal) {
    if (!validId(body?.storyId) || !Number.isSafeInteger(body?.version) || !validId(body?.id))
      fail(400, 'INVALID_REVIEW', '剧本或核对编号无效');
    const s = await store.get(body.storyId, body.version),
      r = await get(body.id);
    if (
      s.version !== body.version ||
      r.storyId !== s.id ||
      r.version !== s.version ||
      r.fingerprint !== fingerprint(s)
    )
      fail(409, 'STALE_REVIEW', '核对结果对应旧剧本，请重新载入并核对');
    if (r.status !== 'awaiting_confirmation' || !r.findings?.length)
      fail(409, 'REVISION_NOT_AVAILABLE', '当前核对报告没有待处理建议');
    if (!needsReview(s)) fail(400, 'REVIEW_NOT_REQUIRED', '此旧版剧本不支持 AI 修订');
    const chat = { ...body };
    const messages = [
      {
        role: 'system',
        content:
          '你是剧本编辑，根据提供的核对报告和用户明确授权的修改建议，直接修订剧本。只修改解决问题所需的内容，尽量保留原故事主题、因果、角色关系、人物姓名、性别、立绘、音色与其余有效内容。必须保留所有席位和镜头数量的合理性；严格遵守给定的片长、每镜时长、角色覆盖、对白限制。人物秘密可以用于完善铺垫，但绝不能把私人秘密写入公开背景、公开关系、画面、旁白或角色对白；不可在公开字段复述或暗示任何秘密。血统不决定狼人杀身份，不添加随机身份或新胜负规则。不要返回解释、建议或 Markdown，只返回完整 JSON 剧本对象，字段结构与输入一致。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          currentStory: revisionContent(s),
          review: { summary: r.summary, strengths: r.strengths, findings: r.findings },
        }),
      },
    ];
    chat.messages = messages;
    validateChat(chat);
    const controller = new AbortController(),
      abort = () => controller.abort(),
      timer = setTimeout(() => controller.abort(), Limits.AGENT_UPSTREAM_TIMEOUT_MS);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl(normalizeEndpoint(chat.endpoint), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
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
      const data = await readUpstream(response, controller);
      if (!response.ok) throw upstreamError(response.status, data, chat.reasoningEffort);
      let draft;
      try {
        draft = Schema.parse(AgentRequest.responseText(data));
        if (!draft || typeof draft !== 'object' || Array.isArray(draft))
          throw Error('修订稿格式不正确');
        draft.roomSize = s.roomSize || 6;
        draft.confirmed = false;
        draft.id = s.id;
        draft.version = s.version;
        if (s.cinematic) {
          draft.cinematic = true;
          draft.targetDuration = s.targetDuration;
          draft.narrativeMode = s.narrativeMode || draft.narrativeMode;
        }
        if (!Array.isArray(draft.characters) || draft.characters.length !== s.characters.length)
          throw Error('修订稿人物数量与原剧本不一致');
        draft.characters = draft.characters.map((c, i) => ({
          ...c,
          seat: i + 1,
          name: s.characters[i].name,
          ...Object.fromEntries(
            ['gender', 'voiceId', 'portraitId', 'appearance']
              .filter((k) => s.characters[i][k] !== undefined)
              .map((k) => [k, s.characters[i][k]]),
          ),
        }));
        const clean = Schema.validate(draft);
        const publicText = [
          clean.background,
          clean.visualGuide,
          ...clean.characters.flatMap((c) => [c.relationships]),
          ...clean.scenes.flatMap((x) => [
            x.description,
            x.narration,
            ...(x.dialogues || []).map((d) => d.text),
          ]),
        ].join('\n');
        if (
          clean.characters.some(
            (c) => c.secret && c.secret.trim().length >= 12 && publicText.includes(c.secret.trim()),
          )
        )
          throw Error('修订稿将人物秘密写入公开内容');
        return {
          draft: clean,
          protocol: AgentRequest.PROTOCOL,
          maxOutputTokens: AgentRequest.OUTPUT_MAX_TOKENS,
          reasoningEffort: AgentRequest.normalizeReasoningEffort(chat.reasoningEffort),
          model: chat.model.trim().slice(0, 200),
          reviewId: r.id,
          sourceVersion: s.version,
        };
      } catch (e) {
        if (e instanceof AgentRequest.ResponseError) throw e;
        throw new StoryError(
          502,
          'STORY_REVISION_INVALID',
          'AI 修订稿不符合剧本规则：' + e.message + '。原剧本未被修改，可重试或继续编辑。',
        );
      }
    } catch (e) {
      if (controller.signal.aborted)
        throw new StoryError(
          504,
          'STORY_REVISION_TIMEOUT',
          'AI 修订请求超时或已取消。原剧本未被修改，可重试。',
        );
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async function decision(body, forced) {
    if (!validId(body?.storyId) || !Number.isSafeInteger(body?.version))
      fail(400, 'INVALID_STORY', '剧本编号或版本无效');
    const s = await store.get(body.storyId, body.version);
    if (s.version !== body.version) fail(409, 'STALE_STORY', '剧本已更新，旧核对记录不能用于新版');
    if (!s.confirmed || !needsReview(s))
      fail(400, 'REVIEW_NOT_REQUIRED', '当前剧本不需要此核对操作');
    const r = forced === 'skip' ? null : await get(body.id);
    if (forced === 'confirm' && !r) fail(404, 'REVIEW_NOT_FOUND', '找不到可确认的核对报告');
    if (r && (r.storyId !== s.id || r.version !== s.version || r.fingerprint !== fingerprint(s)))
      fail(409, 'STALE_REVIEW', '核对结果对应旧剧本，请重新核对');
    if (forced === 'confirm' && r.status !== 'awaiting_confirmation') return summary(r);
    const row = r || {
      id: randomUUID(),
      storyId: s.id,
      version: s.version,
      roomSize: s.roomSize || 6,
      fingerprint: fingerprint(s),
      model: '',
      status: 'awaiting_confirmation',
      decision: null,
      createdAt: new Date().toISOString(),
      summary: 'AI 接口不可用，用户选择手动跳过核对。',
      strengths: [],
      findings: [],
    };
    row.decision = forced === 'skip' ? 'skipped' : 'accepted';
    row.status = forced === 'skip' ? 'skipped' : 'confirmed';
    row.decidedAt = new Date().toISOString();
    await atomic(file(row.id), row);
    return summary(row);
  }
  async function requireApproved(storyId, version) {
    const s = await store.get(storyId, version);
    if (!needsReview(s)) return null;
    const rows = await list(s.id, s.version);
    if (!rows.some((r) => ['accepted', 'skipped'].includes(r.decision)))
      fail(
        409,
        'STORY_REVIEW_REQUIRED',
        '请先完成当前剧本的 AI 核对，或在核对接口失败时明确手动跳过',
      );
    return true;
  }
  return {
    review,
    revise,
    list,
    get,
    confirm: (body) => decision(body, 'confirm'),
    skip: (body) => decision(body, 'skip'),
    requireApproved,
    needsReview,
    fingerprint,
  };
}
module.exports = { createScenarioReviews, parseReport, needsReview, fingerprint };
