'use strict';
let storyReview = null,
  storyReviewError = '',
  storyReviewRunning = false,
  storyReviewAction = '';
function storyReviewRequired() {
  return !!cinematic || (typeof requiresNarrative === 'function' && requiresNarrative());
}
function storyReviewReady() {
  return (
    storyReviewRequired() &&
    !!current?.id &&
    !!storyReview &&
    storyReview.storyId === current.id &&
    storyReview.version === current.version &&
    !generationDraftChanged() &&
    ['accepted', 'skipped'].includes(storyReview.decision)
  );
}
function reviewIssues() {
  try {
    return [
      ...NightfallPreview.preflight(rawDraft(), typeof rehearsal === 'object' ? rehearsal : {}, {
        requireReviews: false,
      }),
      ...S.voiceIssues(rawDraft()),
    ];
  } catch (e) {
    return [e.message];
  }
}
function renderStoryReview() {
  const panel = $('storyReviewPanel');
  if (!panel) return;
  panel.hidden = !storyReviewRequired();
  if (panel.hidden) return;
  const dirtyDraft = !current || generationDraftChanged(),
    issues = reviewIssues(),
    agent = typeof agents !== 'undefined' ? agents[Number($('organizer')?.value)] : null;
  // eslint-disable-next-line no-unsanitized/property -- Issue text is escaped with esc() and the remaining markup is static.
  $('reviewPreflight').innerHTML = issues.length
    ? '<ul>' + issues.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
    : '<p>本地规则检查通过：镜头时长、角色覆盖、对白负载与制作限制符合配置。</p>';
  $('reviewButton').disabled =
    loading ||
    restoring ||
    storyReviewRunning ||
    !workshopReady ||
    restoreBlocked ||
    dirtyDraft ||
    !current?.confirmed ||
    issues.length > 0 ||
    !agent ||
    storyReviewReady();
  $('reviewButton').textContent = storyReviewReady() ? '当前版本已核对' : '使用已选 Agent 核对剧本';
  $('reviewConfirm').hidden =
    storyReview?.status !== 'awaiting_confirmation' ||
    storyReview.storyId !== current?.id ||
    storyReview.version !== current?.version ||
    dirtyDraft;
  $('reviewConfirm').disabled = loading || restoring;
  $('reviewRevise').hidden = $('reviewConfirm').hidden || !storyReview?.findings?.length;
  $('reviewRevise').disabled = loading || restoring || storyReviewRunning || !agent;
  $('reviewSkip').hidden =
    !storyReviewError || dirtyDraft || !current?.confirmed || !storyReviewRequired();
  $('reviewSkip').disabled = loading || restoring || !workshopReady;
  const status = $('reviewStatus');
  if (dirtyDraft)
    status.textContent =
      '请先保存并确认剧本版本，再进行 AI 核对。修改后旧核对报告保留为历史，但不再用于当前版本。';
  else if (issues.length)
    status.textContent = '请先修正本地规则检查列出的问题；修正并保存后再核对。';
  else if (storyReviewReady())
    status.textContent =
      (storyReview.decision === 'skipped' ? '已手动跳过 AI 核对。' : '已确认按当前稿继续。') +
      ' · ' +
      storyReview.model;
  else if (storyReviewRunning)
    status.textContent =
      '正在向 ' + (agent?.model || '所选 Agent') + ' 发送当前已保存剧本，请稍候…';
  else if (storyReview?.status === 'awaiting_confirmation')
    status.textContent =
      '核对完成 · ' +
      storyReview.model +
      '。可选择 AI 生成修订草稿，或直接继续制作；报告不会自动改动已保存版本。';
  else if (storyReviewError)
    status.textContent = 'AI 核对未完成：' + storyReviewError + '。可以重试，或手动跳过。';
  else
    status.textContent =
      '将核对故事因果、人物关系与秘密铺垫、镜头衔接、对白时长及公开内容泄密。人物秘密会发送给你选定的 Agent；每次请求可能产生聊天费用。';
  const report = $('reviewReport');
  report.replaceChildren();
  if (
    storyReview &&
    storyReview.storyId === current?.id &&
    storyReview.version === current?.version &&
    !dirtyDraft
  ) {
    const heading = document.createElement('h3');
    heading.textContent =
      storyReview.decision === 'skipped'
        ? '核对已跳过'
        : storyReview.decision === 'accepted'
          ? '已确认当前稿'
          : storyReview.status === 'awaiting_confirmation'
            ? '核对建议'
            : '旧版核对记录';
    report.append(heading);
    if (storyReview.summary) {
      const p = document.createElement('p');
      p.textContent = storyReview.summary;
      report.append(p);
    }
    for (const item of storyReview.strengths || []) {
      const p = document.createElement('p');
      p.className = 'review-strength';
      p.textContent = '可保留：' + item;
      report.append(p);
    }
    if (storyReview.findings?.length) {
      const list = document.createElement('ul');
      for (const item of storyReview.findings) {
        const li = document.createElement('li'),
          strong = document.createElement('strong');
        strong.textContent =
          (item.location ? item.location + ' · ' : '') + (item.category || '建议') + '：';
        li.append(
          strong,
          document.createTextNode(
            item.issue + (item.suggestion ? ' 建议：' + item.suggestion : ''),
          ),
        );
        list.append(li);
      }
      report.append(list);
    } else if (storyReview.status === 'awaiting_confirmation') {
      const p = document.createElement('p');
      p.textContent = '没有发现需要列出的具体问题。仍请结合你的创作意图判断是否继续。';
      report.append(p);
    }
  }
}
async function loadStoryReview() {
  storyReview = null;
  storyReviewError = '';
  if (!current?.id || !storyReviewRequired()) {
    renderStoryReview();
    return null;
  }
  const id = current.id,
    version = current.version;
  try {
    const rows = await api(
      '/api/scenario-reviews?storyId=' + encodeURIComponent(id) + '&version=' + version,
    );
    if (current?.id !== id || current?.version !== version) return null;
    storyReview = rows[0] || null;
  } catch (e) {
    if (current?.id === id && current?.version === version) storyReviewError = e.message;
  }
  renderStoryReview();
  return storyReview;
}
function updateStoryReviewButtons() {
  renderStoryReview();
}
function initStoryReview() {
  let panel = $('storyReviewPanel');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'storyReviewPanel';
    panel.className = 'panel';
    panel.innerHTML =
      '<h2>AI 核对（可选）</h2><p class="hint">按需使用当前选择的剧本整理 Agent 检查已保存剧本，未核对也可继续制作。核对只检查文字，最终画面需逐镜预览检查。</p><div id="reviewPreflight" class="review-preflight"></div><div id="reviewReport" class="review-report"></div><div class="row wrap"><button id="reviewButton" class="primary">使用已选 Agent 核对剧本</button><button id="reviewRevise" hidden>AI 根据建议生成修订草稿</button><button id="reviewConfirm" hidden>确认按当前稿继续</button><button id="reviewSkip" hidden>手动跳过核对</button></div><p id="reviewStatus" class="hint" role="status" aria-live="polite"></p>';
    document.querySelector('aside')?.prepend(panel);
  }
  $('reviewButton').onclick = guard(async () => {
    if (!current?.confirmed || generationDraftChanged()) throw Error('请先保存并确认当前剧本');
    const errors = reviewIssues();
    if (errors.length) throw Error(errors.join('；'));
    const agent = agents[Number($('organizer').value)];
    if (!agent) throw Error('请选择剧本整理 Agent');
    if (
      !confirm(
        '将使用 ' +
          agent.model +
          ' 核对当前剧本，并把人物秘密一并发送给该 Agent。该请求可能产生聊天费用。继续？',
      )
    )
      return;
    const id = current.id,
      version = current.version;
    storyReviewError = '';
    storyReviewRunning = true;
    storyReviewAction = 'review';
    renderStoryReview();
    renderWorkflow();
    try {
      const result = await api(
        '/api/scenario-reviews',
        {
          storyId: id,
          version,
          endpoint: agent.endpoint,
          model: agent.model,
          apiKey: agent.rememberKey === false ? '' : agent.key,
          reasoningEffort: agent.reasoningEffort || 'xhigh',
        },
        { timeoutMs: 185000 },
      );
      if (current?.id === id && current?.version === version && !generationDraftChanged()) {
        storyReview = result;
        storyReviewError = '';
        notice('AI 核对完成。可查看建议、生成修订草稿，或直接继续制作。');
      }
    } catch (e) {
      if (current?.id === id && current?.version === version) {
        storyReviewError = e.message;
        notice('AI 核对未完成，可重试或手动跳过。', true);
      }
    } finally {
      storyReviewRunning = false;
      storyReviewAction = '';
      renderStoryReview();
      updateButtons();
    }
  });
  $('reviewRevise').onclick = guard(async () => {
    if (!current?.confirmed || generationDraftChanged() || !storyReview?.findings?.length)
      throw Error('请先载入与核对报告对应的已确认剧本');
    const agent = agents[Number($('organizer').value)];
    if (!agent) throw Error('请选择剧本整理 Agent');
    if (
      !confirm(
        '将使用 ' +
          agent.model +
          ' 根据核对建议生成修订草稿。人物秘密和核对报告会发送给该 Agent，可能产生聊天费用。继续？',
      )
    )
      return;
    const id = current.id,
      version = current.version,
      reviewId = storyReview.id;
    const result = await api(
      '/api/scenario-reviews/' + reviewId + '/revise',
      {
        storyId: id,
        version,
        endpoint: agent.endpoint,
        model: agent.model,
        apiKey: agent.rememberKey === false ? '' : agent.key,
        reasoningEffort: agent.reasoningEffort || 'xhigh',
      },
      { timeoutMs: 185000 },
    );
    if (current?.id !== id || current?.version !== version || generationDraftChanged())
      throw Error('剧本已切换或修改，修订结果未覆盖当前编辑内容，请重新操作');
    dirty = true;
    render(result.draft);
    persistWorkshop();
    notice('AI 修订草稿已载入，请检查后保存。原版本及素材仍然保留。');
  });
  $('reviewConfirm').onclick = guard(async () => {
    if (!storyReview?.id) throw Error('当前没有可确认的核对报告');
    storyReview = await api('/api/scenario-reviews/' + storyReview.id, {
      action: 'confirm',
      storyId: current.id,
      version: current.version,
    });
    storyReviewError = '';
    renderStoryReview();
    notice('已记录按当前稿继续。');
  });
  $('reviewSkip').onclick = guard(async () => {
    if (!confirm('AI 接口当前不可用。跳过后仍可继续制作，但不会获得模型核对建议。继续？')) return;
    storyReview = await api('/api/scenario-reviews/skip', {
      storyId: current.id,
      version: current.version,
    });
    storyReviewError = '';
    renderStoryReview();
    notice('已记录手动跳过 AI 核对。');
  });
  $('organizer').addEventListener('change', renderStoryReview);
}
