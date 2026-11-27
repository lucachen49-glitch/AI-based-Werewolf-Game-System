let referenceCatalog = [],
  referenceCatalogRoom = 0,
  referenceEpoch = 0;
('use strict');
const $ = (id) => document.getElementById(id),
  S = NightfallScenario;
const esc = (x) =>
  String(x ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let current = null,
  job = null,
  dirty = false,
  loading = false,
  pollTimer = null,
  previewed = null,
  sceneCount = 6,
  roomSize = 6,
  cinematic = false,
  renderedDraft = null,
  activeWorkflowStep = 0,
  workflowRestored = false;
let workshopState = { schema: 1, lastKey: '', entries: {} },
  workshopReady = false,
  restoring = false,
  restoreBlocked = false,
  restorePending = null,
  artEdits = {},
  jobsEpoch = 0,
  navigationEpoch = 0;
function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
}
async function api(url, body, { timeoutMs = body === undefined ? 15000 : 0 } = {}) {
  const controller = new AbortController(),
    timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const r = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch((e) => {
      if (controller.signal.aborted) throw e;
      return null;
    });
    if (!r.ok) {
      const error = Error(d?.error?.message || '本地服务暂不可用，请重启游戏后刷新');
      error.status = r.status;
      error.code = d?.error?.code;
      throw error;
    }
    return d;
  } catch (e) {
    if (controller.signal.aborted) throw Error('本地服务响应超时，请重新查询进度');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
function guard(fn) {
  return async function (...args) {
    if (loading || restoring) return;
    loading = true;
    try {
      updateButtons();
      await fn(...args);
    } catch (e) {
      notice(e.message, true);
    } finally {
      loading = false;
      updateButtons();
      persistWorkshop();
    }
  };
}
function generationDraftChanged() {
  if (!current) return true;
  try {
    return S.productionSignature(rawDraft()) !== S.productionSignature(current);
  } catch {
    return true;
  }
}
function workflowSteps() {
  const mode = storyReviewRequired()
      ? requiresNarrative()
        ? 'continuity'
        : 'cinematic'
      : 'legacy',
    draftChanged = generationDraftChanged(),
    storyReady = !!current?.confirmed && !draftChanged && !restoreBlocked,
    reviewCurrent =
      !!storyReview &&
      storyReview.storyId === current?.id &&
      storyReview.version === current?.version &&
      !draftChanged,
    reviewReady = storyReviewReady(),
    artReady =
      !!art?.charactersConfirmed &&
      !!art?.framesConfirmed &&
      art.storyId === current?.id &&
      art.version === current?.version,
    artConfirmPending =
      !!art &&
      art.storyId === current?.id &&
      art.version === current?.version &&
      ((!art.charactersConfirmed &&
        art.characters?.length > 0 &&
        art.characters.every((x) => x.status === 'done')) ||
        (art.charactersConfirmed &&
          !art.framesConfirmed &&
          art.frames?.length > 0 &&
          art.frames.every((x) => x.status === 'done'))),
    hasReview = !!storyReview,
    hasArt = !!art,
    hasVideo = !!job,
    videoUsesCurrentArt =
      !cinematic || (job?.artId === art?.id && job?.artRevision === art?.revision),
    videoReady =
      !!job?.url &&
      job.storyId === current?.id &&
      job.version === current?.version &&
      videoUsesCurrentArt,
    adopted =
      (!!job && job.status === 'accepted') || (!!current?.video && current.video.jobId === job?.id),
    hasAdopted = !!current?.video;
  return NightfallWorkshopFlow.derive({
    mode,
    storyReady,
    hasStory: !!current?.confirmed,
    reviewReady,
    reviewCurrent,
    reviewRunning: typeof storyReviewRunning !== 'undefined' && storyReviewRunning,
    hasReview,
    artReady,
    artConfirmPending,
    artRunning: art?.status === 'running',
    videoReady,
    videoRunning: job?.status === 'running',
    previewed: previewed === job?.id,
    previewConfirmed: $('acceptCheck').checked,
    adopted,
    hasArt,
    hasVideo,
    hasAdopted,
  });
}
function renderWorkflow() {
  const steps = workflowSteps(),
    labels = {
      complete: '已完成',
      active: '进行中',
      running: '制作中',
      confirm: '待确认',
      preview: '待完整预览',
      acknowledge: '待勾选确认',
      ready: '待采用',
      optional: '可选阶段',
      locked: '未开放',
      stale: '待重新确认',
    };
  if (!workflowRestored && workshopReady) {
    activeWorkflowStep = NightfallWorkshopFlow.activeIndex(steps);
    workflowRestored = true;
  }
  if (!steps[activeWorkflowStep]?.accessible)
    activeWorkflowStep = NightfallWorkshopFlow.activeIndex(steps);
  const busy = loading || restoring || !workshopReady,
    currentIndex = NightfallWorkshopFlow.activeIndex(steps);
  // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
  $('workshopSteps').innerHTML = steps
    .map(
      (s, i) =>
        `<li data-state="${esc(s.status)}" data-current="${i === currentIndex}" data-viewing="${i === activeWorkflowStep}" class="${i === activeWorkflowStep ? 'viewing' : ''}"><button type="button" data-workflow-step="${i}" ${!s.accessible || busy ? 'disabled' : ''} aria-current="${i === currentIndex ? 'step' : 'false'}" title="${s.accessible ? (i === currentIndex ? '当前制作步骤；点击可返回查看' : '返回或查看' + s.label) : '完成前序步骤后开放'}"><span>${i + 1} · ${esc(s.label)}</span><small class="workflow-state">${labels[s.status] || '待处理'}</small></button></li>`,
    )
    .join('');
  const title = (selector, text) => {
    const el = document.querySelector(selector);
    if (el) el.textContent = text;
  };
  title('.editor .section-title h2', '剧本编辑');
  title('.art-panel > h2', '人物与分镜');
  const configTitle = $('provider')?.closest('section')?.querySelector('h2');
  if (configTitle) configTitle.textContent = '视频接口设置';
  const videoTitle = $('generate')?.closest('section')?.querySelector('h2');
  if (videoTitle) videoTitle.textContent = '独立剧情视频';
  if (!document.querySelector('[data-workflow-heading="adopt"]')) {
    const heading = document.createElement('h3');
    heading.dataset.workflowHeading = 'adopt';
    heading.textContent = '预览采用';
    $('preview')?.before(heading);
  }
}
function workflowTarget(index) {
  const steps = workflowSteps(),
    id = steps[index]?.id;
  return {
    story: document.querySelector('.editor'),
    review: $('storyReviewPanel'),
    art: document.querySelector('.art-panel'),
    video: $('generate')?.closest('section'),
    adopt: $('acceptLabel')?.classList.contains('hidden')
      ? $('preview')?.closest('section')
      : $('acceptLabel')?.closest('section'),
  }[id];
}
function goToWorkflowStep(index) {
  const steps = workflowSteps(),
    step = steps[index];
  if (!step?.accessible || loading || restoring) return;
  activeWorkflowStep = index;
  workflowRestored = true;
  renderWorkflow();
  persistWorkshop();
  const target = workflowTarget(index);
  target?.scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
}
function updateButtons() {
  const voiceProblems = cinematic ? S.voiceIssues(rawDraft()) : [];
  const busy = loading || restoring || !workshopReady;
  $('prepare').disabled = busy || !agents.length;
  $('save').disabled = busy || restoreBlocked;
  $('expand60').disabled = busy || cinematic || sceneCount === 6;
  $('generate').disabled =
    busy ||
    restoreBlocked ||
    generationDraftChanged() ||
    !current?.confirmed ||
    (cinematic && !art?.framesConfirmed) ||
    !!voiceProblems.length;
  for (const id of ['roomSize', 'library', 'newStory', 'sample', 'bloodMoonSample'])
    $(id).disabled = busy;
  document.querySelector('.editor').inert = restoring || (restoreBlocked && !!restorePending);
  if (typeof artUpdateButtons === 'function') artUpdateButtons();
  if (typeof updateStoryReviewButtons === 'function') updateStoryReviewButtons();
  const reuseButton = $('importOldArt');
  if (reuseButton)
    reuseButton.disabled =
      busy || restoreBlocked || !current?.confirmed || generationDraftChanged() || !!art;
  $('accept').disabled = busy || !$('acceptCheck').checked || previewed !== job?.id;
  previewChecks();
  if (typeof introUpdate === 'function') introUpdate();
  renderWorkflow();
}
function blank() {
  return {
    roomSize,
    ...(roomSize === 6 ? { narrativeMode: 'continuity-v1' } : {}),
    title: '',
    source: '',
    background: '',
    confirmed: false,
    characters: Array.from({ length: roomSize }, (_, i) => ({
      seat: i + 1,
      name: '',
      personality: '',
      relationships: '',
      secret: '',
    })),
    scenes: Array.from({ length: roomSize === 6 ? 10 : 12 }, (_, i) => ({
      duration: roomSize === 6 ? 9 : 10,
      cast: [],
      description: '',
      narration: '',
      dialogues: [],
      narrationSeconds: 0,
    })),
  };
}
function render(d) {
  renderedDraft = structuredClone(d);
  roomSize = d.roomSize || 6;
  $('roomSize').value = String(roomSize);
  $('characterTitle').textContent = roomSize + ' 位人物';
  $('prepare').textContent = '整理为 ' + roomSize + ' 人剧本';
  $('createArt').textContent = '制作 ' + roomSize + ' 位人物定妆照';
  $('roomHint').textContent =
    roomSize === 12
      ? '12 人间 · 同主题独立剧本，分组呈现，每镜最多六位人物。'
      : '6 人间 · 剧情模式';
  sceneCount = d.scenes.length;
  cinematic =
    !!d.cinematic || d.scenes.some((s) => s.duration !== undefined || s.dialogues !== undefined);
  const total = d.scenes.reduce((n, s) => n + (s.duration || 10), 0);
  $('visualGuide').value = d.visualGuide || '';
  $('sceneTitle').textContent = '开场分镜 / ' + sceneCount + ' 镜 · ' + total + ' 秒';
  $('expand60').textContent = cinematic ? '电影镜头时长按剧情调整' : '扩展为 60 秒草稿';
  $('productionHint').textContent = cinematic
    ? '按剧情拆分 ' +
      sceneCount +
      ' 个镜头，共 ' +
      total +
      ' 秒；单镜 1—15 秒，旁白与角色对白分别混音。'
    : '旧版 ' + sceneCount + ' 镜头 · ' + total + ' 秒。旧任务和成片继续兼容。';
  $('generate').textContent = '生成独立剧情视频';
  $('title').value = d.title;
  $('source').value = d.source;
  $('background').value = d.background;
  $('confirmed').checked = d.confirmed;
  // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
  $('characters').innerHTML = d.characters
    .map(
      (c) =>
        `<details open><summary>${c.seat} 号人物</summary><label>姓名<input data-seat="${esc(c.seat)}" data-field="name" maxlength="16" value="${esc(c.name)}"></label><label>公开剧情身份<input data-seat="${esc(c.seat)}" data-field="publicIdentity" maxlength="40" placeholder="例如：绯夜家族继承人（不填本局游戏身份）" value="${esc(c.publicIdentity || '')}"></label><label>性格<textarea data-seat="${esc(c.seat)}" data-field="personality" rows="2" maxlength="400">${esc(c.personality)}</textarea></label><label>公开关系<textarea data-seat="${esc(c.seat)}" data-field="relationships" rows="2" maxlength="600">${esc(c.relationships)}</textarea></label>${cinematic ? `<label>参考立绘（制作任务会保存副本）<select data-seat="${esc(c.seat)}" data-field="portraitId">${NightfallManor.portraits.map((p) => `<option value="${esc(p.id)}" ${(c.portraitId || NightfallManor.defaultId(c.seat - 1)) === p.id ? 'selected' : ''}>${esc(p.name)} · ${esc(p.description)}${p.pending ? ' · 正式立绘待制作' : ''}</option>`).join('')}</select></label><label>人物声音性别<select data-seat="${esc(c.seat)}" data-field="gender"><option value="female" ${S.characterGender(c) === 'female' ? 'selected' : ''}>女性</option><option value="male" ${S.characterGender(c) === 'male' ? 'selected' : ''}>男性</option></select></label><label>视频固定音色<select data-seat="${esc(c.seat)}" data-field="voiceId">${S.VOICES.map((id) => `<option value="${id}" ${S.voiceId(c) === id ? 'selected' : ''}>${esc(S.voiceLabel(id))}</option>`).join('')}</select><span class="hint">生成前校验男女声；同一角色跨镜头固定音色。只影响新制作，不改变历史视频或游戏发言声音。</span></label><p class="hint" data-voice-hint="${c.seat}"></p><button type="button" data-match-voice="${c.seat}">匹配男女声</button><label>公开外观描述<textarea data-seat="${esc(c.seat)}" data-field="appearance" rows="3" maxlength="800">${esc(S.appearance(c))}</textarea></label>` : ''}<label class="private">仅本人知道的秘密<textarea data-seat="${esc(c.seat)}" data-field="secret" rows="3" maxlength="800">${esc(c.secret)}</textarea></label></details>`,
    )
    .join('');
  // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
  $('scenes').innerHTML = d.scenes
    .map((s, i) => {
      const duration = s.duration || 10,
        offset = d.scenes.slice(0, i).reduce((n, x) => n + (x.duration || 10), 0);
      return `<div class="scene"><strong class="scene-time" data-scene-time="${i}">${String(offset).padStart(2, '0')}—${String(offset + duration).padStart(2, '0')} 秒 · 镜头 ${i + 1}</strong>${cinematic ? `<div class="row wrap scene-tools"><button type="button" data-scene-add="${i}">后插镜头</button><button type="button" data-scene-split="${i}">拆分镜头</button><button type="button" data-scene-remove="${i}">删除镜头</button></div><label>镜头时长（1—15 秒）<input type="number" min="1" max="15" step="1" data-scene="${i}" data-field="duration" value="${duration}"></label>` : ''}<label>公开画面<textarea data-scene="${i}" data-field="description" rows="2" maxlength="1000">${esc(s.description)}</textarea></label><label>${cinematic ? (d.language === 'en' ? '英文旁白' : '中文旁白') : '解说'}<textarea data-scene="${i}" data-field="narration" rows="2" maxlength="1000">${esc(s.narration || '')}</textarea></label>${d.language === 'en' ? `<label>旁白中文译文<textarea data-scene="${i}" data-field="narrationTranslation" rows="2" maxlength="1000">${esc(s.narrationTranslation || '')}</textarea></label>` : ''}${
        cinematic
          ? `<label>旁白占用开头秒数（无旁白填 0）<input type="number" min="0" max="15" step="1" data-scene="${i}" data-field="narrationSeconds" value="${S.timing(s).narrationSeconds}"></label><p class="hint" data-audio-time="${i}"></p><fieldset class="scene-cast"><legend>本镜出场人物（最多六位）</legend>${d.characters.map((c) => `<label><input type="checkbox" data-cast="${i}" value="${c.seat}" ${(s.cast || S.sceneCast(d, i)).includes(c.seat) ? 'checked' : ''}>${c.seat}号</label>`).join('')}</fieldset><div class="dialogues"><strong>人物对白（最多三位）</strong>${Array.from(
              { length: Math.max(3, s.dialogues?.length || 0) },
              (_, n) => n,
            )
              .map((n) => {
                const line = s.dialogues?.[n];
                return `<div class="dialogue-row"><select data-dialogue-seat="${i}-${n}"><option value="">选择席位</option>${d.characters.map((c) => `<option value="${c.seat}" ${line?.seat === c.seat ? 'selected' : ''}>${c.seat}号 · ${esc(c.name)}</option>`).join('')}</select><input data-dialogue-text="${i}-${n}" maxlength="240" value="${esc(line?.text || '')}" placeholder="${d.language === 'en' ? '英文台词' : '角色台词'}">${d.language === 'en' ? `<input data-dialogue-translation="${i}-${n}" maxlength="240" value="${esc(line?.translation || '')}" placeholder="中文译文">` : ``}</div>`;
              })
              .join(
                '',
              )}<button type="button" data-dialogue-add="${i}">增加一句对白</button></div><label>附加画面参考（按镜头编号顺序，最多与人物参考合计14张）<select multiple data-reference-frame="${i}" size="3">${d.scenes.map((x, n) => (n === i ? '' : `<option value="${n}" ${(s.referenceFrames || []).includes(n) ? 'selected' : ''}>镜头 ${n + 1} · ${esc(x.description.slice(0, 28))}</option>`)).join('')}</select><span class="hint">可选择已确认的其他分镜图作为场景、服装或道具参考。人物定妆照按出场顺序自动附加；下方可设置附加图片的用途和先后顺序。</span></label><div data-reference-previews="${i}" class="reference-previews"></div><label>独立参考素材<select multiple size="4" data-extra-reference="${i}"></select></label><div data-extra-reference-preview="${i}" class="reference-previews"></div><label>结束参考帧（可选）<select data-scene="${i}" data-field="endFrameIndex"><option value="" ${s.endFrameIndex == null ? 'selected' : ''}>不约束结束帧</option>${d.scenes.map((x, n) => `<option value="${n}" ${s.endFrameIndex === n ? 'selected' : ''}>镜头 ${n + 1} 的分镜图</option>`).join('')}</select><span class="hint">此图作为结束画面约束。需要结合实际视频检查动作是否自然衔接。</span></label><label>起始图片来源<select data-scene="${i}" data-field="startSource"><option value="frame" ${s.startSource !== 'previous' ? 'selected' : ''}>已确认的本镜分镜图</option>${i ? `<option value="previous" ${s.startSource === 'previous' ? 'selected' : ''}>上一镜生成视频的实际尾帧</option>` : ''}</select><span class="hint">选择尾帧后，上一镜完成时自动提取；生成后的连贯性仍需逐镜预览。</span></label><label>起始画面<input data-scene="${i}" data-field="startFrame" maxlength="400" value="${esc(s.startFrame || '')}"></label><label>结束画面<input data-scene="${i}" data-field="endFrame" maxlength="400" value="${esc(s.endFrame || '')}"></label>`
          : ''
      }</div>`;
    })
    .join('');
  $('version').textContent = current
    ? 'v' + current.version + ' · ' + (current.video ? '开场视频已采用' : '开场视频未绑定')
    : '未保存';
  previewSceneTools(d);
  renderReferencePreviews();
  renderExtraReferences(d);
  void loadReferenceCatalog();
  updateTimeline();
  $('sample').hidden = roomSize !== 6;
  if (typeof introRender === 'function') void introRender(d);
  updateButtons();
}
function renderReferencePreviews() {
  document.querySelectorAll('[data-reference-previews]').forEach((box) => {
    const i = Number(box.dataset.referencePreviews),
      select = document.querySelector('[data-reference-frame="' + i + '"]');
    const previous = new Map(
      Array.from(box.querySelectorAll('[data-reference-item]'), (el) => [
        Number(el.dataset.referenceItem),
        {
          order: Number(el.querySelector('[data-reference-order]').value),
          purpose: el.querySelector('[data-reference-purpose]').value,
        },
      ]),
    );
    const scene = renderedDraft?.scenes?.[i] || {},
      selected = Array.from(select?.selectedOptions || [], (option) => Number(option.value));
    const ordered = selected.map((n) => ({
      n,
      ...(previous.get(n) || {
        order: (scene.referenceFrames || []).indexOf(n) + 1 || selected.indexOf(n) + 1,
        purpose: scene.referencePurposes?.[n] || 'general',
      }),
    }));
    // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
    box.innerHTML = ordered
      .map(({ n, order, purpose }) => {
        const image = art?.frames?.[n]?.url;
        return `<div data-reference-item="${esc(n)}">${image ? `<a href="${esc(image)}" target="_blank" rel="noopener"><img src="${esc(image)}" alt="镜头 ${n + 1} 参考图"></a>` : `<span>镜头 ${n + 1} 的参考图尚未完成</span>`}<label>顺序 <input type="number" min="1" max="14" data-reference-order value="${esc(order)}"></label><label>用途 <select data-reference-purpose>${[
          ['general', '综合'],
          ['scene', '场景'],
          ['costume', '服装'],
          ['prop', '道具'],
        ]
          .map(
            ([value, label]) =>
              `<option value="${value}" ${purpose === value ? 'selected' : ''}>${label}</option>`,
          )
          .join('')}</select></label></div>`;
      })
      .join('');
  });
}
function rawDraft() {
  const d = blank();
  if (typeof introRead === 'function') {
    d.introductions = introRead();
    if (introSourceId) d.introSourceId = introSourceId;
  }
  if (renderedDraft?.narrativeMode) d.narrativeMode = renderedDraft.narrativeMode;
  if (renderedDraft?.language) d.language = renderedDraft.language;
  d.characters = d.characters.map((c, i) => ({ ...renderedDraft?.characters[i], ...c }));
  d.scenes = Array.from({ length: sceneCount }, (_, i) => ({
    ...renderedDraft?.scenes[i],
    description: '',
    narration: '',
  }));
  d.visualGuide = $('visualGuide').value;
  for (const f of ['title', 'source', 'background']) d[f] = $(f).value;
  d.confirmed = $('confirmed').checked;
  $('characters')
    .querySelectorAll('[data-seat][data-field]')
    .forEach((el) => {
      const character = d.characters[Number(el.dataset.seat) - 1];
      if (character) character[el.dataset.field] = el.value;
    });
  $('scenes')
    .querySelectorAll('[data-scene][data-field]')
    .forEach((el) => {
      const scene = d.scenes[Number(el.dataset.scene)];
      if (scene)
        scene[el.dataset.field] =
          el.dataset.field === 'endFrameIndex'
            ? el.value === ''
              ? null
              : Number(el.value)
            : el.type === 'number'
              ? Number(el.value)
              : el.value;
    });
  if (cinematic)
    d.scenes.forEach((s, i) => {
      s.cast = Array.from(document.querySelectorAll('[data-cast="' + i + '"]:checked'), (el) =>
        Number(el.value),
      );
      const references = Array.from(
        document.querySelectorAll('[data-reference-previews="' + i + '"] [data-reference-item]'),
        (el) => ({
          frame: Number(el.dataset.referenceItem),
          order: Number(el.querySelector('[data-reference-order]').value),
          purpose: el.querySelector('[data-reference-purpose]').value,
        }),
      ).sort((a, b) => a.order - b.order || a.frame - b.frame);
      s.referenceFrames = references.map((x) => x.frame);
      s.referencePurposes = Object.fromEntries(references.map((x) => [x.frame, x.purpose]));
      s.extraReferences = Array.from(
        document.querySelectorAll('[data-extra-reference-preview="' + i + '"] [data-extra-item]'),
        (el) => ({
          id: el.dataset.extraItem,
          purpose: el.querySelector('[data-extra-purpose]').value,
          order: Number(el.querySelector('[data-extra-order]').value),
          fixedLayout: el.querySelector('[data-extra-fixed-layout]')?.value || '',
          allowedMovements: el.querySelector('[data-extra-allowed-movements]')?.value || '',
        }),
      )
        .sort((a, b) => a.order - b.order)
        .map((ref) => ({
          id: ref.id,
          purpose: ref.purpose,
          ...(ref.fixedLayout ? { fixedLayout: ref.fixedLayout } : {}),
          ...(ref.allowedMovements ? { allowedMovements: ref.allowedMovements } : {}),
        }));
      s.dialogues = Array.from(
        document.querySelectorAll('[data-dialogue-seat^="' + i + '-"]'),
        (el) => ({
          seat: Number(el.value),
          text:
            document.querySelector('[data-dialogue-text="' + el.dataset.dialogueSeat + '"]')
              ?.value || '',
          ...(d.language === 'en'
            ? {
                translation:
                  document.querySelector(
                    '[data-dialogue-translation="' + el.dataset.dialogueSeat + '"]',
                  )?.value || '',
              }
            : {}),
        }),
      ).filter((x) => x.seat || x.text.trim());
    });
  return d;
}
function updateTimeline() {
  if (!document.querySelector('[data-scene]')) return;
  const d = rawDraft();
  let start = 0;
  const speakers = new Set();
  d.scenes.forEach((scene, i) => {
    const duration = Number.isFinite(scene.duration) ? scene.duration : 10,
      end = start + duration;
    document
      .querySelector('[data-scene-time="' + i + '"]')
      ?.replaceChildren(document.createTextNode(start + '—' + end + ' 秒 · 镜头 ' + (i + 1)));
    const el = document.querySelector('[data-audio-time="' + i + '"]');
    if (el) {
      const t = S.timing(scene);
      el.textContent =
        '本镜声音：' +
        (scene.narration ? '旁白 0—' + t.narrationSeconds + ' 秒；' : '') +
        (scene.dialogues.length
          ? '人物对白 ' + t.dialogueStart + '—' + duration + ' 秒'
          : '无人物对白');
    }
    scene.dialogues?.forEach((x) => {
      if (x.seat) speakers.add(x.seat);
    });
    start = end;
  });
  updateVoiceHints(d);
  updateContinuity(d);
  $('sceneTitle').textContent = '开场分镜 / ' + sceneCount + ' 镜 · ' + start + ' 秒';
  $('generate').textContent = '生成独立剧情视频';
  $('productionHint').textContent = cinematic
    ? sceneCount +
      ' 个镜头 · 实际总时长 ' +
      start +
      ' 秒 · 已有对白 ' +
      speakers.size +
      ' / ' +
      roomSize +
      ' 位人物。每镜最多六人、三位说话者；音色固定，旁白与对白错开。'
    : '旧版 ' + sceneCount + ' 镜头 · ' + start + ' 秒。旧任务、成片继续可用。';
  if (cinematic) {
    const issues = S.voiceIssues(d);
    if (issues.length) $('productionHint').textContent += ' 生成前需修正：' + issues.join('；');
  }
}
function updateVoiceHints(d) {
  if (!cinematic) return;
  for (const c of d.characters) {
    const el = document.querySelector('[data-voice-hint="' + c.seat + '"]');
    if (!el) continue;
    const issues = S.voiceIssues({ characters: [c] });
    el.textContent =
      issues[0] ||
      '已匹配：' +
        (S.characterGender(c) === 'female' ? '女性' : '男性') +
        ' / ' +
        S.voiceLabel(S.voiceId(c));
    el.classList.toggle('error', !!issues.length);
  }
}
$('characters').addEventListener('click', (e) => {
  const button = e.target.closest('[data-match-voice]');
  if (!button || loading || restoring || restoreBlocked) return;
  const seat = Number(button.dataset.matchVoice),
    d = rawDraft(),
    c = d.characters[seat - 1],
    select = document.querySelector('select[data-seat="' + seat + '"][data-field="voiceId"]');
  select.value = S.matchedVoice(c);
  select.dispatchEvent(new Event('input', { bubbles: true }));
  notice('已在当前草稿中匹配 ' + seat + ' 号人物的男女声。请检查后保存；未发起生成请求。');
});
$('scenes').addEventListener('click', (e) => {
  const el = e.target.closest('button');
  if (!el || loading) return;
  const d = rawDraft(),
    previousScenes = [...d.scenes];
  let index;
  if (el.dataset.dialogueAdd !== undefined) {
    index = Number(el.dataset.dialogueAdd);
    const lines = d.scenes[index].dialogues,
      rowCount = el.closest('.dialogues').querySelectorAll('.dialogue-row').length;
    if (rowCount >= 12) {
      notice('每镜最多十二句对白。', true);
      return;
    }
    while (lines.length < rowCount) lines.push({ seat: 0, text: '' });
    lines.push({ seat: 0, text: '' });
  } else if (el.dataset.sceneAdd !== undefined) {
    index = Number(el.dataset.sceneAdd);
    d.scenes.splice(index + 1, 0, {
      duration: 5,
      description: '',
      narration: '',
      cast: [],
      dialogues: [],
      narrationSeconds: 0,
    });
  } else if (el.dataset.sceneRemove !== undefined) {
    if (sceneCount <= 1) return;
    index = Number(el.dataset.sceneRemove);
    if (!confirm('删除镜头 ' + (index + 1) + '？已保存版本会保留。')) return;
    d.scenes.splice(index, 1);
  } else if (el.dataset.sceneSplit !== undefined) {
    index = Number(el.dataset.sceneSplit);
    const scene = d.scenes[index];
    if (scene.duration < 2) {
      notice('至少两秒的镜头才能拆分。', true);
      return;
    }
    const first = Math.floor(scene.duration / 2),
      second = scene.duration - first;
    d.scenes.splice(index + 1, 0, {
      duration: second,
      description: '承接前镜：' + scene.description,
      startFrame: '',
      endFrame: scene.endFrame || '',
      narration: '',
      narrationSeconds: 0,
      cast: [...scene.cast],
      dialogues: [],
      startSource: 'previous',
      endFrameIndex: scene.endFrameIndex ?? null,
    });
    scene.duration = first;
    scene.narrationSeconds = scene.narration ? Math.min(scene.narrationSeconds, first) : 0;
    scene.endFrame = '';
    scene.endFrameIndex = null;
    notice('已保持总片长拆分；请重新安排两镜台词、旁白时段与衔接。');
  } else return;
  NightfallWorkshopState.remapReferences(previousScenes, d.scenes);
  dirty = true;
  render(d);
  $('confirmed').checked = false;
  persistWorkshop();
});
function read() {
  return {
    ...S.validate(rawDraft()),
    ...(current ? { id: current.id, version: current.version } : {}),
  };
}
let agents = [],
  temporaryOrganizerKey = '',
  temporaryOrganizerSignature = '';
function organizerSignature(profile) {
  return profile ? `${profile.seat}|${profile.endpoint}|${profile.model}` : '';
}
function selectedOrganizer() {
  return agents[Number($('organizer')?.value)] || null;
}
function organizerAgent(profile = selectedOrganizer()) {
  if (!profile) return null;
  const signature = organizerSignature(profile);
  const key =
    profile.key || (temporaryOrganizerSignature === signature ? temporaryOrganizerKey : '');
  return { ...profile, key };
}
function updateOrganizerCredentialStatus() {
  const profile = selectedOrganizer(),
    agent = organizerAgent(profile),
    label = $('organizerTemporaryKeyLabel'),
    input = $('organizerTemporaryKey'),
    status = $('organizerStatus');
  if (label) label.hidden = !profile || !!profile.key;
  if (input) {
    const value =
      profile && !profile.key && temporaryOrganizerSignature === organizerSignature(profile)
        ? temporaryOrganizerKey
        : '';
    if (input.value !== value) input.value = value;
  }
  if (!status) return;
  if (!agents.length) {
    status.textContent =
      '尚未找到可用的 API Agent。请返回游戏 Agent 配置页补全接口地址和模型后刷新。';
    return;
  }
  if (agent?.key) {
    status.textContent = profile.key
      ? '当前整理 Agent 已配置密钥。密钥仅用于本次请求。'
      : '临时密钥仅保存在当前页面内存，关闭或刷新页面后自动清除。';
    return;
  }
  status.textContent =
    '当前整理 Agent 未保存密钥。请在此输入本次临时密钥，或返回游戏 Agent 配置页完成配置。';
}
function refreshOrganizerAgents() {
  const select = $('organizer'),
    previous = agents[Number(select?.value)],
    previousKey = previous ? `${previous.seat}|${previous.endpoint}|${previous.model}` : '';
  let profiles = [];
  try {
    const saved = JSON.parse(localStorage.getItem('nightfall-profiles-v1') || '[]');
    profiles = Array.isArray(saved) ? saved : Object.values(saved || {});
  } catch {}
  const eligible = profiles.filter((profile, index) => index < 12 && profile?.control === 'api');
  agents = eligible
    .filter((profile) => profile.endpoint && profile.model)
    .map((profile, index) => ({
      seat: profiles.indexOf(profile) + 1,
      ...profile,
      reasoningEffort: NightfallAgentRequest.normalizeReasoningEffort(profile.reasoningEffort),
    }));
  if (!select) return agents;
  if (agents.length) {
    // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
    select.innerHTML = agents
      .map(
        (a, i) =>
          `<option value="${i}">${a.seat} 号 · ${esc(a.name || '未命名 Agent')} / ${esc(a.model)}</option>`,
      )
      .join('');
    const keep = agents.findIndex((a) => `${a.seat}|${a.endpoint}|${a.model}` === previousKey);
    select.value = String(keep >= 0 ? keep : 0);
  } else select.innerHTML = '<option value="">暂无可用整理 Agent</option>';
  updateOrganizerCredentialStatus();
  updateButtons();
  return agents;
}
refreshOrganizerAgents();
async function library(selected = current?.id) {
  const list = (await api('/api/scenarios')).filter((s) => (s.roomSize || 6) === roomSize);
  // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
  $('library').innerHTML =
    '<option value="">新建剧本</option>' +
    list
      .map(
        (s) =>
          `<option value="${esc(s.id)}">${s.roomSize || 6}人 · ${esc(s.title)} · v${s.version}</option>`,
      )
      .join('');
  const canonical = list.find((s) => s.id === selected || s.aliasIds?.includes(selected));
  $('library').value = canonical?.id || '';
  return list;
}
$('organizerRefresh')?.addEventListener('click', () => {
  refreshOrganizerAgents();
  notice('已刷新整理 Agent 配置。');
});
$('organizer')?.addEventListener('change', () => {
  temporaryOrganizerKey = '';
  temporaryOrganizerSignature = '';
  updateOrganizerCredentialStatus();
});
$('organizerTemporaryKey')?.addEventListener('input', (event) => {
  temporaryOrganizerKey = event.target.value;
  temporaryOrganizerSignature = temporaryOrganizerKey
    ? organizerSignature(selectedOrganizer())
    : '';
  updateOrganizerCredentialStatus();
});
window.addEventListener('focus', refreshOrganizerAgents);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshOrganizerAgents();
});
window.addEventListener('storage', (e) => {
  if (e.key === 'nightfall-profiles-v1') refreshOrganizerAgents();
});
function clearJob() {
  if (typeof subtitleSetSource === 'function') void subtitleSetSource(null);
  resetRehearsal();
  clearArt();
  clearTimeout(pollTimer);
  job = null;
  previewed = null;
  $('preview').pause();
  $('preview').removeAttribute('src');
  $('preview').load();
  for (const id of ['preview', 'accept', 'acceptLabel', 'resume']) $(id).classList.add('hidden');
  $('downloadVideo').hidden = true;
  $('downloadVideo').removeAttribute('href');
  $('acceptCheck').checked = false;
  $('acceptCheck').disabled = true;
  $('jobs').innerHTML = '';
  $('jobMessage').textContent = '保存并确认剧本后开始制作。';
}
const states = {
  queued: '等待制作',
  submitting: '正在提交',
  pending: '模型生成中',
  downloading: '下载与音轨检查',
  done: '已保存',
  failed: '生成失败',
  unknown: '需核对任务编号',
};
function sceneProgress(s, j) {
  let label =
    s.status === 'pending' && s.providerStatus === 'queued'
      ? '供应商排队中'
      : states[s.status] || s.status;
  if (s.status === 'pending' && typeof s.progress === 'number')
    label += ' · 供应商进度 ' + s.progress + '%';
  const start = Date.parse(s.startedAt || (s.index === 0 ? j.createdAt : ''));
  if (['submitting', 'pending', 'downloading'].includes(s.status) && Number.isFinite(start)) {
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    label += ' · 已等待 ' + Math.floor(seconds / 60) + '分' + (seconds % 60) + '秒';
  }
  if (s.lastCheckedAt)
    label +=
      ' · 最近查询 ' + new Date(s.lastCheckedAt).toLocaleTimeString('zh-CN', { hour12: false });
  if (s.message) label += ' · ' + s.message;
  return label;
}
function sceneReviewKey(id, index) {
  return 'nightfall-scene-review-' + id + '-' + index;
}
function sceneReviewRead(id, index) {
  try {
    return JSON.parse(localStorage.getItem(sceneReviewKey(id, index)) || '{}');
  } catch {
    return {};
  }
}
function sceneReviewMarkup(j, s) {
  if (!s.url) return '';
  const review = sceneReviewRead(j.id, s.index);
  const checks = [
    ['appearance', '人物形象'],
    ['voice', '声音对应'],
    ['dialogue', '实际对白'],
    ['subtitle', '字幕时间'],
    ['action', '动作接点'],
    ['continuity', '前后衔接'],
  ];
  return `<details class="scene-review"><summary>记录此镜检查结果</summary><div class="scene-review-options">${checks.map(([key, label]) => `<label><input type="checkbox" data-scene-review="${s.index}" data-review-field="${key}" ${review[key] ? 'checked' : ''}>${label}有问题</label>`).join('')}</div><label>问题说明<textarea data-scene-review="${s.index}" data-review-field="note" maxlength="1000" rows="2" placeholder="记录具体时间或需要修改的内容">${esc(review.note || '')}</textarea></label><small>检查记录保存在此浏览器，重做该镜头后清除。</small></details>`;
}
function showJob(j) {
  if (typeof subtitleSetSource === 'function') void subtitleSetSource(j);
  const changed = job?.id !== j.id || job?.status !== j.status;
  job = j;
  const total =
    j.targetDuration || j.scenes.reduce((n, s) => n + (s.duration || j.sceneDuration || 10), 0);
  $('jobMessage').textContent =
    j.scenes.length +
    ' 个镜头 · ' +
    total +
    ' 秒 · ' +
    ({
      voicing: '统一配音',
      generating: '画面生成',
      downloading: '下载检查',
      assembling: '成片合成',
      complete: '制作完成',
    }[j.stage] || '独立视频任务') +
    ' · ' +
    (j.message || '任务已保存，关闭页面不影响制作。');
  // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
  $('jobs').innerHTML = j.scenes
    .map(
      (s) =>
        `<div class="job-scene"><strong>镜头 ${s.index + 1} / ${j.scenes.length} · ${s.duration || j.sceneDuration || 10} 秒</strong><span class="job-state">${esc(sceneProgress(s, j))}</span>${s.url ? `<br><a href="${esc(s.url)}" target="_blank" rel="noopener">预览此镜头 ↗</a>` : ''}${s.previousVersions?.length ? `<details><summary>查看保留的旧镜头（${s.previousVersions.length}）</summary>${s.previousVersions.map((v, i) => `<a href="${esc(v.url)}" target="_blank" rel="noopener">旧版 ${i + 1} · ${esc(new Date(v.createdAt).toLocaleString())} ↗</a>`).join(' · ')}</details>` : ''}${sceneReviewMarkup(j, s)}${['done', 'failed', 'unknown', 'submitting', 'stale'].includes(s.status) && j.status !== 'running' ? `<button data-retry="${s.index}">重新生成此镜头</button>` : ''}${s.status === 'unknown' || (j.status === 'needs_review' && s.status === 'submitting') ? `<input data-request="${s.index}" placeholder="粘贴华龙后台的原任务编号"><button data-attach="${s.index}">用原编号继续</button>` : ''}</div>`,
    )
    .join('');
  $('resume').classList.toggle('hidden', !['paused', 'needs_review'].includes(j.status));
  if (j.url) {
    $('downloadVideo').href = j.url;
    $('downloadVideo').hidden = false;
    for (const id of ['preview', 'accept', 'acceptLabel']) $(id).classList.remove('hidden');
    if (changed) {
      previewed = null;
      $('acceptCheck').checked = false;
      $('acceptCheck').disabled = true;
      $('preview').src = j.url;
      $('preview').load();
    }
  } else {
    $('downloadVideo').hidden = true;
    $('downloadVideo').removeAttribute('href');
    for (const id of ['preview', 'accept', 'acceptLabel']) $(id).classList.add('hidden');
    $('preview').pause();
    previewed = null;
  }
  updateButtons();
  if (j.url && changed && typeof introRefreshSources === 'function') void introRefreshSources(j.id);
  if (j.status === 'running') {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 2500);
  }
}
async function poll() {
  if (!job) return;
  const id = job.id;
  try {
    const latest = await api('/api/video-jobs/' + id);
    if (job?.id === id) showJob(latest);
  } catch (e) {
    if (job?.id !== id) return;
    notice('查询暂时中断，已保存的任务不会重发。' + e.message, true);
    pollTimer = setTimeout(poll, 6000);
  }
}
function restorePanel(message, conflict = false, canCopy = false) {
  $('restorePanel').classList.remove('hidden');
  $('restoreMessage').textContent = message;
  $('retryRestore').classList.toggle('hidden', conflict);
  $('restoreCopy').classList.toggle('hidden', !conflict && !canCopy);
  $('useLatest').classList.toggle('hidden', !conflict);
}
function persistWorkshop() {
  if (!workshopReady || restoring || restoreBlocked) return;
  try {
    workshopState = NightfallWorkshopState.save(
      localStorage,
      NightfallWorkshopState.read(localStorage),
      {
        storyId: current?.id,
        version: current?.version,
        dirty,
        activeStep: activeWorkflowStep,
        draft: rawDraft(),
        artEdits,
        artId: art?.id,
        videoId: job?.id,
        rehearsal,
      },
    );
    $('draftStatus').textContent = dirty
      ? '草稿已自动暂存在当前浏览器，刷新或返回后可恢复；尚未保存为正式版本。'
      : '已记住当前剧本和制作任务，刷新后自动恢复。';
  } catch {
    restoreBlocked = true;
    $('draftStatus').textContent = '草稿暂存失败，请保留当前页面并重试。';
    restorePanel('草稿暂存失败，原记录仍保留。请重试恢复。');
  }
}
function pendingEntry(id) {
  const entries = Object.values(workshopState.entries);
  return entries
    .filter((e) => (e.storyId || '') === (id || '') && (id || (e.draft.roomSize || 6) === roomSize))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
async function loadJobs(entry, keepProgress = false) {
  const epoch = ++jobsEpoch,
    id = current?.id,
    version = current?.version;
  if (!keepProgress) clearJob();
  $('videoHistory').innerHTML = '<option value="">暂无任务</option>';
  if (!id) {
    await loadRehearsals();
    return;
  }
  const results = await Promise.allSettled([
    api('/api/video-jobs?storyId=' + id),
    cinematic || sceneCount === 6 ? api('/api/story-art-jobs?storyId=' + id) : Promise.resolve([]),
  ]);
  if (epoch !== jobsEpoch || current?.id !== id || current?.version !== version) return;
  const [videos, images] = results;
  if (videos.status === 'fulfilled') {
    const jobs = videos.value;
    // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
    $('videoHistory').innerHTML =
      '<option value="">选择已保存任务</option>' +
      jobs
        .map(
          (j) =>
            `<option value="${esc(j.id)}">v${esc(j.version)} · ${['story60-refs-v1', 'cinema-refs-v1'].includes(j.profile) ? '参考图 r' + esc(j.artRevision) : '原方案'} · ${esc(j.targetDuration)}秒 · ${esc(j.status)}</option>`,
        )
        .join('');
    const latest =
      jobs.find((j) => j.id === entry?.videoId) || jobs.find((j) => j.version === version);
    if (latest) {
      showJob(latest);
      $('videoHistory').value = latest.id;
    }
  }
  if (images.status === 'fulfilled') {
    const imagesForVersion = images.value.filter((j) => j.version === version),
      latest = imagesForVersion.find((j) => j.id === entry?.artId) || imagesForVersion[0];
    if (latest) showArt(latest);
    else if (!art)
      $('artMessage').textContent = '当前版本尚无图片任务。保存并确认剧本后，可以制作人物定妆照。';
  }
  // Task queries must never prevent restored text from being saved locally.
  if (videos.status === 'rejected')
    $('jobMessage').textContent =
      '视频进度暂未读取：' + videos.reason.message + '。已保存素材不受影响，可重新查询。';
  if (images.status === 'rejected')
    $('artMessage').textContent =
      '图片进度暂未读取：' + images.reason.message + '。已保存素材不受影响，可重新查询。';
  await loadRehearsals();
  const failed = results.some((r) => r.status === 'rejected');
  $('retryJobs').classList.toggle('hidden', !failed);
  return failed;
}
async function loadStory(id, entry = pendingEntry(id)) {
  const navigation = ++navigationEpoch;
  activeWorkflowStep = Number.isInteger(entry?.activeStep) ? entry.activeStep : 0;
  workflowRestored = Number.isInteger(entry?.activeStep);
  storyReview = null;
  storyReviewError = '';
  restoring = true;
  updateButtons();
  try {
    restoreBlocked = true;
    let latest;
    try {
      latest = id ? await api('/api/scenarios/' + id + '/edit') : null;
    } catch (e) {
      if (navigation !== navigationEpoch) return;
      if (e.status !== 404 || e.code !== 'STORY_NOT_FOUND' || !entry) throw e;
      current = null;
      clearJob();
      rehearsal = P.clean(entry.rehearsal);
      rehearsal.previewId = null;
      artEdits = {};
      dirty = true;
      render(NightfallWorkshopState.draft(entry.draft));
      $('confirmed').checked = false;
      $('library').value = '';
      restoreBlocked = false;
      restorePending = null;
      workshopReady = true;
      $('restorePanel').classList.add('hidden');
      $('version').textContent = '原剧本已不可用 · 已恢复为未保存草稿';
      $('warnings').textContent =
        '原剧本记录已不存在，已完整恢复浏览器草稿。请检查、勾选确认并保存到本机，再继续人物制作。旧制作记录未删除，也不会关联到这个新草稿。';
      notice('原剧本记录已不存在，已恢复为可编辑草稿。请检查、确认并保存后继续。');
      return 'missing';
    }
    if (navigation !== navigationEpoch) return;
    current = latest;
    dirty = false;
    rehearsal = P.clean(entry?.rehearsal);
    artEdits = entry?.artEdits || {};
    render(latest || blank());
    $('library').value = id || '';
    $('warnings').textContent = '';
    $('library').value = latest?.id || '';
    const conflict =
      entry?.dirty && latest && (entry.version !== latest.version || entry.storyId !== latest.id);
    if (entry && !conflict) {
      if (entry.dirty || !latest) {
        render(NightfallWorkshopState.draft(entry.draft));
        dirty = !!entry.dirty;
        if (dirty)
          $('version').textContent =
            (latest ? 'v' + latest.version + ' · ' : '') + '已恢复未保存草稿';
      }
      updateButtons();
    }
    if (conflict) {
      restorePending = entry;
      restorePanel(
        '服务器已有 v' +
          latest.version +
          '，本地保留基于 v' +
          entry.version +
          ' 的未保存修改。请选择恢复为独立草稿，或继续最新版本。',
        true,
      );
    }
    const reviewLoad = loadStoryReview(),
      jobsLoad = loadJobs(conflict ? null : entry);
    await Promise.all([reviewLoad, jobsLoad]);
    const incomplete = await jobsLoad;
    if (navigation !== navigationEpoch) return;
    restoreBlocked = !!conflict;
    workshopReady = true;
    if (!conflict) $('restorePanel').classList.add('hidden');
    return incomplete;
  } finally {
    if (navigation === navigationEpoch) {
      restoring = false;
      updateButtons();
    }
  }
}
document.getElementById('workshopSteps').addEventListener('click', (e) => {
  const button = e.target.closest('[data-workflow-step]');
  if (button) goToWorkflowStep(Number(button.dataset.workflowStep));
});
async function restoreWorkshop() {
  let entry;
  restoreBlocked = true;
  restoring = true;
  updateButtons();
  try {
    workshopState = NightfallWorkshopState.read(localStorage);
    const requested = Number(new URLSearchParams(location.search).get('roomSize'));
    roomSize = [6, 12].includes(requested)
      ? requested
      : workshopState.entries[workshopState.lastKey]?.draft.roomSize || 6;
    const requestedStory = new URLSearchParams(location.search).get('storyId');
    entry = requestedStory
      ? pendingEntry(requestedStory)
      : NightfallWorkshopState.latest(workshopState, roomSize);
    if (entry) render(NightfallWorkshopState.draft(entry.draft));
    const list = await library();
    const target = list.find(
      (s) =>
        s.id === (requestedStory || entry?.storyId) ||
        s.aliasIds?.includes(requestedStory || entry?.storyId),
    );
    const incomplete = await loadStory(
      target?.id || entry?.storyId || (!entry ? list[0]?.id : '') || '',
      entry,
    );
    workshopReady = true;
    if (!restoreBlocked) {
      persistWorkshop();
      if (incomplete !== 'missing')
        notice(
          (entry ? '已恢复上次编辑内容。' : '已载入本机剧本。') +
            (incomplete
              ? '部分制作进度暂未读取，可点击重新查询；不影响草稿暂存。'
              : '制作进度已同步。'),
        );
    }
  } catch (e) {
    workshopReady = true;
    restorePending = entry || null;
    restorePanel(
      '恢复暂未完成：' +
        e.message +
        '。本地草稿和已保存素材仍保留。' +
        (entry
          ? '可重试恢复，或将本地内容恢复为独立草稿。'
          : '可重试恢复，或选择本机剧本、新建剧本继续。'),
      false,
      !!entry,
    );
    notice('恢复中断，可重试恢复' + (entry ? '或恢复为独立草稿。' : '或选择其他剧本。'), true);
  } finally {
    restoring = false;
    updateButtons();
  }
}
$('retryRestore').onclick = guard(restoreWorkshop);
$('retryJobs').onclick = guard(async () => {
  const failed = await loadJobs({ artId: art?.id, videoId: job?.id }, true);
  notice(
    failed ? '部分制作进度仍未读取，可稍后重试；不会重新提交生成。' : '制作进度已重新同步。',
    failed,
  );
});
$('restoreCopy').onclick = guard(async () => {
  const entry = restorePending;
  if (!entry) return;
  current = null;
  clearJob();
  rehearsal = P.clean(entry.rehearsal);
  rehearsal.previewId = null;
  artEdits = {};
  dirty = true;
  render(NightfallWorkshopState.draft(entry.draft));
  $('confirmed').checked = false;
  $('library').value = '';
  restoreBlocked = false;
  restorePending = null;
  $('restorePanel').classList.add('hidden');
  notice('已恢复为独立草稿。原版本、素材与旧草稿均保留；请检查后另行保存。');
});
$('useLatest').onclick = guard(async () => {
  restorePending = null;
  restoreBlocked = false;
  $('restorePanel').classList.add('hidden');
  notice('正在使用最新保存版本；旧版本草稿仍保留。');
});
document.querySelector('.editor').addEventListener('input', (e) => {
  if (e.target.matches('[data-reference-frame]')) renderReferencePreviews();
  if (e.target.matches('[data-extra-reference]'))
    renderExtraReferencePreview(Number(e.target.dataset.extraReference));
  if (
    e.target.closest('#referenceLibrary') ||
    e.target.matches(
      '[data-transition-check],[data-rehearsal-asset],[data-rehearsal-start],[data-rehearsal-end]',
    )
  )
    return;
  if (
    e.target.id === 'roomSize' ||
    e.target.id === 'library' ||
    e.target.id === 'organizer' ||
    e.target.id === 'import'
  )
    return;
  dirty = true;
  if (e.target.id !== 'confirmed') $('confirmed').checked = false;
  $('version').textContent =
    (current ? 'v' + current.version + ' · ' : '') +
    '有未保存修改；保存后需重新确认剧本和受影响的后续步骤';
  updateTimeline();
  if (typeof introUpdate === 'function') introUpdate();
  updateButtons();
  persistWorkshop();
});
$('library').addEventListener(
  'change',
  guard(async () => {
    if (dirty && !confirm('当前修改已在本机暂存，切换到其他剧本？')) {
      $('library').value = current?.id || '';
      return;
    }
    await loadStory($('library').value);
  }),
);
$('roomSize').onchange = guard(async () => {
  const next = Number($('roomSize').value);
  if (next === roomSize) return;
  persistWorkshop();
  roomSize = next;
  current = null;
  artEdits = {};
  dirty = false;
  const list = await library(),
    entry = NightfallWorkshopState.latest(workshopState, next);
  await loadStory(entry ? entry.storyId || '' : list[0]?.id || '', entry);
  notice('已切换到 ' + roomSize + ' 人草稿；原人数的草稿仍保留。');
});
$('newStory').onclick = guard(async () => {
  if (dirty && !confirm('当前修改已在本机暂存，切换到其他剧本？')) return;
  await loadStory('');
  $('library').value = '';
  notice('已新建空白剧本。');
});
$('import').onchange = guard(async () => {
  const file = $('import').files[0];
  if (!file) return;
  if (file.size > 100000) throw Error('TXT 文件过大，请控制在 16000 字以内');
  const text = await file.text();
  if (text.length > 16000) throw Error('原始剧本最多 16000 字');
  $('source').value = text.replace(/^\uFEFF/, '');
  dirty = true;
  notice('已导入原始剧本，可选择 Agent 整理。');
});
$('prepare').onclick = guard(async () => {
  const agent = organizerAgent();
  if (!agent) throw Error('请先配置并选择一个 API Agent');
  if (!agent.key)
    throw Error('请在整理 Agent 配置旁输入本次临时 API 密钥，或返回游戏 Agent 配置页补全密钥');
  if (current && !confirm('整理将替换当前编辑区，未保存的内容会丢失。继续？')) return;
  notice('正在整理人物关系与分镜，最长约两分钟…');
  const r = await api('/api/scenarios/prepare', {
    roomSize,
    source: $('source').value,
    endpoint: agent.endpoint,
    model: agent.model,
    apiKey: agent.key,
    reasoningEffort: agent.reasoningEffort || 'xhigh',
  });
  render(r.draft);
  dirty = true;
  $('warnings').textContent = r.warnings.length ? '待检查：' + r.warnings.join('；') : '';
  notice('已整理。请逐一检查 ' + roomSize + ' 位人物、秘密和公开分镜，再保存。');
});
$('expand60').onclick = guard(async () => {
  const expanded = S.expand60(read());
  clearJob();
  dirty = true;
  render(expanded);
  $('confirmed').checked = false;
  $('version').textContent =
    (current ? '基于 v' + current.version + ' · ' : '') + '60 秒未保存草稿';
  notice(
    '已展开为六个连续镜头草稿。请检查前后镜头与旁白，确认后保存新版本；旧剧本和旧视频仍保留，未调用模型。',
  );
});
$('save').onclick = guard(async () => {
  let draft = read();
  if (current?.video && dirty) {
    delete draft.id;
    delete draft.version;
    draft.title = (draft.title.replace(/·连贯修订$/, '') + '·连贯修订').slice(0, 60);
  }
  current = await api('/api/scenarios', draft);
  dirty = false;
  storyReview = null;
  storyReviewError = '';
  render(current);
  await library();
  await Promise.all([loadJobs(), loadStoryReview()]);
  notice(
    '剧本 v' +
      current.version +
      ' 已保存到本机。旧核对报告保留在历史记录中，但不能用于这个新版本。',
  );
});
$('saveConfig').onclick = guard(async () => {
  try {
    const r = await api('/api/video-config', {
      provider: $('provider').value,
      model: $('model').value,
      apiKey: $('videoKey').value,
    });
    $('configStatus').textContent = '已加密保存 · ' + r.model;
    notice('视频专用密钥已保存，仅用于视频制作。');
  } finally {
    $('videoKey').value = '';
  }
});
$('checkConfig').onclick = guard(async () => {
  notice('正在检查视频接口鉴权…');
  const r = await api('/api/video-config/check', {});
  $('configStatus').textContent =
    r.message + (r.listed === false ? ' 模型列表中未找到指定模型。' : '');
  notice(r.message);
});
$('generate').onclick = guard(async () => {
  if (generationDraftChanged() || !current?.confirmed)
    throw Error('请先保存已确认的剧本；人物登场介绍可在视频生成后设置');
  if (cinematic) {
    const issues = reviewIssues();
    if (issues.length) throw Error(issues.join('；'));
  }
  const plan = S.videoPlan(current),
    hasArt = ['story60-refs-v1', 'cinema-refs-v1'].includes(plan.profile),
    seconds = plan.targetDuration;
  if (hasArt && !art?.framesConfirmed) throw Error('请先确认全部人物定妆照与分镜起始图');
  if (
    !confirm(
      '将制作 ' +
        current.scenes.length +
        ' 个镜头，共 ' +
        seconds +
        ' 秒；每镜 ' +
        (hasArt ? '使用已确认参考图' : '按旧方案制作') +
        '，可能产生华龙视频生成费用。' +
        (cinematic
          ? '原生' +
            (current.language === 'en' ? '英文' : '中文') +
            '口型对白；旁白独立混音。音色不受支持时将停止，不改为无对白视频。'
          : '') +
        '继续？',
    )
  )
    return;
  showJob(
    await api('/api/video-jobs', {
      storyId: current.id,
      version: current.version,
      profile: plan.profile,
      confirmCharge: true,
      ...(hasArt ? { artId: art.id, artRevision: art.revision } : {}),
    }),
  );
  notice('制作任务已保存，逐镜生成并保留任务编号；完成后可在下方为实际成片添加人物介绍。');
});
$('videoHistory').onchange = guard(async () => {
  const id = $('videoHistory').value;
  if (id) {
    clearTimeout(pollTimer);
    showJob(await api('/api/video-jobs/' + id));
  }
});
$('resume').onclick = guard(async () => {
  await api('/api/video-jobs/' + job.id, { action: 'resume' });
  await poll();
});
$('jobs').addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.sceneReview === undefined || !job) return;
  const key = sceneReviewKey(job.id, Number(el.dataset.sceneReview)),
    review = sceneReviewRead(job.id, Number(el.dataset.sceneReview));
  review[el.dataset.reviewField] = el.type === 'checkbox' ? el.checked : el.value;
  try {
    localStorage.setItem(key, JSON.stringify(review));
  } catch {
    notice('镜头检查记录无法保存到浏览器，请检查浏览器存储空间。', true);
  }
});
$('jobs').onclick = guard(async (e) => {
  const el = e.target;
  if (el.dataset.retry !== undefined) {
    if (
      !confirm(
        '重新生成会新增一次镜头生成费用。结果不明时请先查华龙后台，或填写原任务编号。确定重做？',
      )
    )
      return;
    const retryId = job.id,
      retryIndex = Number(el.dataset.retry);
    const retried = await api('/api/video-jobs/' + retryId, {
      action: 'retry',
      index: retryIndex,
      confirmCharge: true,
    });
    try {
      localStorage.removeItem(sceneReviewKey(retryId, retryIndex));
    } catch {}
    showJob(retried);
    await poll();
  }
  if (el.dataset.attach !== undefined) {
    const index = Number(el.dataset.attach);
    const requestId = $('jobs')
      .querySelector('[data-request="' + index + '"]')
      .value.trim();
    showJob(await api('/api/video-jobs/' + job.id, { action: 'attach', index, requestId }));
    await poll();
  }
});
$('preview').addEventListener('ended', () => {
  const video = $('preview'),
    ranges = video.played;
  let covered = 0;
  for (let i = 0; i < ranges.length; i++) covered += ranges.end(i) - ranges.start(i);
  if (!Number.isFinite(video.duration) || covered < video.duration - 0.5) {
    notice('请从头完整播放成片，再确认采用；跳到结尾不会完成预览。');
    return;
  }
  previewed = job?.id;
  $('acceptCheck').disabled = false;
  notice('预览结束。确认画面和声音无误后，勾选并采用这版开场。');
});
$('acceptCheck').onchange = updateButtons;
$('accept').onclick = guard(async () => {
  if (previewed !== job?.id || !$('acceptCheck').checked) throw Error('请完整预览并确认成片');
  showJob(await api('/api/video-jobs/' + job.id, { action: 'accept', previewConfirmed: true }));
  current = await api('/api/scenarios/' + current.id + '/edit');
  $('version').textContent = 'v' + current.version + ' · 开场视频已采用';
  notice('开场视频已采用。返回 ' + roomSize + ' 人游戏桌，选择这个剧本即可开始。');
});
$('sample').onclick = guard(async () => {
  if (dirty && !confirm('用示例替换当前编辑区？')) return;
  const names = ['沈砚', '顾晚宁', '陆承舟', '许知微', '周临', '林若雪'];
  const relations = [
    '庄园继承人，与顾晚宁共同收到一封旧信',
    '档案修复师，受沈砚邀请来整理家族文书',
    '旧友兼商人，曾与周临一同经营航运',
    '医生，与林若雪是多年好友',
    '庄园管家，熟悉所有来客的旧事',
    '音乐家，受邀在庄园晚宴演奏',
  ];
  const secrets = [
    '一直没有公开那封旧信的最后一页',
    '在旧档案中发现自己的家人与庄园有过往来',
    '一笔旧债尚未向周临交代清楚',
    '曾答应替一位故人保守承诺',
    '保存着旧年失火之夜的值班记录',
    '那首未完成的曲子来自一位失联朋友',
  ];
  const d = {
    roomSize: 6,
    title: '雾锁归鸦庄园',
    source:
      '六位故人应邀回到归鸦庄园，一封没有署名的信令旧事浮出水面。风雨隔断了山路，他们决定围桌进行一场推理游戏，试探彼此的判断。人物往事不代表本局随机身份。',
    background:
      '深秋的归鸦庄园，六位来客收到同一封没有署名的邀请函。晚宴时，钟声忽然停了，山路被暴雨阻断。桌上留着一句话：今夜，答案藏在你们的选择里。旧日关系让信任变得脆弱，但往事不能证明谁属于本局的哪一方。众人围桌，以一场狼人杀试探彼此。',
    confirmed: false,
    characters: names.map((name, i) => ({
      seat: i + 1,
      name,
      personality: [
        '沉稳克制，重视承诺',
        '细心敏锐，习惯追问依据',
        '直率自信，善于交涉',
        '温和坚定，善于倾听',
        '寡言谨慎，注重细节',
        '幽默灵动，愿意表达不同看法',
      ][i],
      relationships: relations[i],
      secret: secrets[i],
    })),
    scenes: [
      {
        description: '雨夜远景，乌鸦飞过古老庄园，烛光从窗内透出，镜头缓慢推向大门。',
        narration: '风雨封住了归鸦庄园。六封相同的邀请，让六位故人在今夜重逢。',
      },
      {
        description: '六位成年贵族来客穿过烛光长廊，彼此交换目光，镜头扫过一封无字样的旧信。',
        narration: '有人带着未说出口的承诺，有人藏着尘封的往事。信任，从来没有看起来那么简单。',
      },
      {
        description: '六人围坐雕花圆木桌，窗外闪过远处雷光，镜头落在桌上的六张无文字卡背。',
        narration: '钟声停了，游戏开始。往事不代表身份，今夜的选择，将决定谁能等到天明。',
      },
    ],
  };
  current = null;
  clearJob();
  restoreBlocked = false;
  restorePending = null;
  $('restorePanel').classList.add('hidden');
  render(S.expand60(d));
  $('library').value = '';
  dirty = true;
  notice('已载入示例。请检查、修改并确认后保存；尚未调用任何视频模型。');
});
$('bloodMoonSample').onclick = guard(async () => {
  if (
    (dirty || current) &&
    !confirm('用《血月停战宴》替换当前编辑区？已保存的剧本会继续保留在本机剧本库。')
  )
    return;
  const draft = S.bloodMoonEnglishSample(roomSize);
  draft.title += '·双语连贯修订';
  current = null;
  clearJob();
  rehearsal = P.clean();
  restoreBlocked = false;
  restorePending = null;
  $('restorePanel').classList.add('hidden');
  dirty = true;
  render(draft);
  $('library').value = '';
  $('warnings').textContent = '';
  $('version').textContent = '未保存 · 请检查并确认新剧本';
  notice(
    '已载入《血月停战宴》草稿。血统不决定本局身份；请检查、确认后保存。尚未调用模型或制作视频。',
  );
});
window.addEventListener('pagehide', persistWorkshop);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistWorkshop();
});
window.addEventListener('beforeunload', (e) => {
  persistWorkshop();
  if (dirty && restoreBlocked) {
    e.preventDefault();
    e.returnValue = '';
  }
});
async function initializeWorkshopPage() {
  let phase = '准备工坊界面';
  try {
    try {
      localStorage.removeItem('nightfall-workshop-v1');
    } catch {}
    phase = '初始化预演面板';
    initRehearsalUI();
    phase = '载入空白编辑器';
    render(blank());
    phase = '初始化核对面板';
    initStoryReview();
    phase = '初始化图片面板';
    initArtUI();
    phase = '恢复本地剧本';
    await restoreWorkshop();
    phase = '连接自动制作流程';
    NightfallAutoWorkshop.mount({
      context: () => ({
        story: current,
        roomSize,
        ready: workshopReady && !restoring && !restoreBlocked,
        agent: organizerAgent(),
      }),
      request: api,
      onStoryUpdated: async (story) => {
        current = story;
        dirty = false;
        render(story);
        await library();
        await loadJobs();
        persistWorkshop();
        notice('已另存为 v' + story.version + '。请检查分镜引用并确认新剧本后再继续。');
      },
      save: async () => {
        if (loading || restoring || restoreBlocked) throw Error('请先完成当前剧本读取或恢复');
        if (!current || generationDraftChanged() || !current.confirmed) {
          const draft = { ...read(), confirmed: true };
          current = await api('/api/scenarios', draft);
          dirty = false;
          render(current);
          await library();
          await loadJobs();
          persistWorkshop();
        }
      },
    });
    try {
      const c = await api('/api/video-config');
      $('provider').value = c.provider;
      $('configStatus').textContent = c.configured
        ? '视频密钥已加密保存。尚需检查鉴权与首镜头。'
        : '尚未保存视频专用密钥。';
    } catch (e) {
      notice(e.message, true);
    }
  } catch (e) {
    workshopReady = true;
    restorePending = restorePending || null;
    const detail = e?.message || String(e);
    try {
      restorePanel(
        '工坊初始化未完成：' + detail + '。可以刷新页面重试；已读取的本地剧本和素材不会被删除。',
        false,
        !!restorePending,
      );
    } catch {}
    notice(phase + '失败：' + detail + '。可以刷新页面重试。', true);
  } finally {
    restoring = false;
    workshopReady = true;
    try {
      updateButtons();
    } catch {}
  }
}
void initializeWorkshopPage();

try {
  if (typeof initCharacterIntros === 'function') initCharacterIntros();
} catch (e) {
  notice('人物介绍面板初始化失败：' + (e?.message || String(e)) + '。其他剧本功能仍可使用。', true);
}

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-reference-frame]')) renderReferencePreviews();
});

async function loadReferenceCatalog(force = false) {
  const size = roomSize;
  if (!force && referenceCatalogRoom === size) return;
  const epoch = ++referenceEpoch;
  try {
    const rows = await api('/api/story-assets/references?roomSize=' + size);
    if (epoch !== referenceEpoch || roomSize !== size) return;
    const draft = rawDraft();
    referenceCatalog = rows;
    referenceCatalogRoom = size;
    renderExtraReferences(draft);
    $('referenceStatus').textContent = rows.length
      ? '当前人数已保存 ' + rows.length + ' 张参考图。'
      : '当前人数尚未导入独立参考图。';
  } catch (e) {
    if (epoch === referenceEpoch)
      $('referenceStatus').textContent =
        '参考图目录读取失败，可重新打开工坊或重试导入。' + e.message;
  }
}
function renderExtraReferences(draft) {
  const rows = referenceCatalogRoom === roomSize ? referenceCatalog : [];
  document.querySelectorAll('[data-extra-reference]').forEach((select) => {
    const i = Number(select.dataset.extraReference),
      refs = draft.scenes[i]?.extraReferences || [];
    const available = new Map(rows.map((r) => [r.id, r]));
    refs.forEach((r) => {
      if (!available.has(r.id))
        available.set(r.id, { id: r.id, label: '已选择的参考素材（正在读取）', kind: r.purpose });
    });
    // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
    select.innerHTML = Array.from(
      available.values(),
      (r) =>
        `<option value="${esc(r.id)}" ${refs.some((x) => x.id === r.id) ? 'selected' : ''}>${esc(r.label)}</option>`,
    ).join('');
    renderExtraReferencePreview(i, refs);
  });
  // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
  $('referenceLibraryPreview').innerHTML = rows
    .map(
      (r) =>
        `<button type="button" data-reference-zoom="${esc(r.url)}" data-reference-caption="${esc(r.label)}"><img src="${esc(r.url)}" alt="${esc(r.label)}"><span>${esc(r.label)}</span></button>`,
    )
    .join('');
}
function renderExtraReferencePreview(i, initial) {
  const box = document.querySelector('[data-extra-reference-preview="' + i + '"]'),
    select = document.querySelector('[data-extra-reference="' + i + '"]');
  if (!box || !select) return;
  const old =
    initial ||
    Array.from(box.querySelectorAll('[data-extra-item]'), (el) => ({
      id: el.dataset.extraItem,
      purpose: el.querySelector('[data-extra-purpose]').value,
      order: Number(el.querySelector('[data-extra-order]').value),
      fixedLayout: el.querySelector('[data-extra-fixed-layout]')?.value || '',
      allowedMovements: el.querySelector('[data-extra-allowed-movements]')?.value || '',
    }));
  // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
  box.innerHTML = Array.from(select.selectedOptions, (option, n) => {
    const r = referenceCatalog.find((x) => x.id === option.value),
      saved = old.find((x) => x.id === option.value);
    return `<div data-extra-item="${esc(option.value)}">${r ? `<button type="button" data-reference-zoom="${esc(r.url)}" data-reference-caption="${esc(r.label)}"><img src="${esc(r.url)}" alt="${esc(r.label)}"></button>` : ''}<span>${esc(r?.label || option.textContent)}</span><label>顺序<input type="number" min="1" max="14" data-extra-order value="${saved?.order || old.findIndex((x) => x.id === option.value) + 1 || n + 1}"></label><label>用途<select data-extra-purpose>${[
      ['character', '人物'],
      ['scene', '场景'],
      ['costume', '服装'],
      ['prop', '道具'],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}" ${(saved?.purpose || r?.kind) === value ? 'selected' : ''}>${label}</option>`,
      )
      .join(
        '',
      )}</select></label><label>固定外观及相对位置<textarea data-extra-fixed-layout maxlength="1000" rows="2">${esc(saved?.fixedLayout || '')}</textarea></label><label>剧情中允许的移动<textarea data-extra-allowed-movements maxlength="1000" rows="2">${esc(saved?.allowedMovements || '')}</textarea></label></div>`;
  }).join('');
}
$('referenceUpload').onclick = guard(async () => {
  const file = $('referenceFile').files[0],
    size = roomSize;
  if (!file) throw Error('请先选择参考图片');
  if (file.size > 8 * 1024 * 1024) throw Error('图片不能超过8MB');
  const label = $('referenceLabel').value.trim() || file.name.replace(/\.[^.]+$/, '');
  $('referenceUpload').disabled = true;
  $('referenceStatus').textContent = '正在保存参考图片…';
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(Error('图片读取失败'));
      reader.readAsDataURL(file);
    });
    await api('/api/story-assets/references', {
      roomSize: size,
      label,
      kind: $('referenceKind').value,
      data,
    });
    if (roomSize === size) {
      await loadReferenceCatalog(true);
      $('referenceFile').value = '';
      $('referenceLabel').value = '';
      notice('参考图片已保存，请在所需镜头选择使用。');
    }
  } finally {
    $('referenceUpload').disabled = false;
  }
});
document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-reference-zoom]');
  if (!button) return;
  $('artZoomImage').src = button.dataset.referenceZoom;
  $('artZoomCaption').textContent = button.dataset.referenceCaption || '';
  $('artZoom').showModal();
});
