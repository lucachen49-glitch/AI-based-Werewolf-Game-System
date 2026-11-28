/* Four saved checkpoints share the existing workshop's selected story and Agent. */
(function (root) {
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c, i) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );
  const stages = [
    ['plan', '剧情与制作方案'],
    ['characters', '人物定妆'],
    ['frames', '分镜与衔接'],
    ['final', '最终成片'],
  ];
  function reportLabel(name) {
    const [kind, index] = name.split(':');
    if (name === 'script') return '剧情';
    if (name === 'final') return '字幕与片尾';
    return (
      ({ character: '人物 ', frame: '分镜 ', video: '视频镜头 ' }[kind] || '检查 ') +
      (Number(index) + 1)
    );
  }
  function referenceList(refs, title = '视频参考规划') {
    return (
      '<details class="auto-references"><summary>' +
      esc(title) +
      ' ' +
      refs.length +
      ' 张 · 按提交顺序</summary><ol>' +
      refs
        .map(
          (ref) =>
            '<li>' +
            (ref.url
              ? '<button type="button" data-reference-zoom="' +
                esc(ref.url) +
                '" data-reference-caption="' +
                esc(ref.label) +
                '"><img src="' +
                esc(ref.url) +
                '" alt="' +
                esc(ref.label) +
                '" loading="lazy"></button>'
              : '') +
            '<span>' +
            esc(ref.label) +
            '</span></li>',
        )
        .join('') +
      '</ol></details>'
    );
  }
  function mount({ context, save, request, onStoryUpdated }) {
    const panel = document.getElementById('automaticWorkshop');
    if (!panel) return;
    for (const id of ['roomSize', 'library', 'organizer']) {
      const node = document.getElementById(id),
        label = node.closest('label');
      document.getElementById('autoSelectors').append(label);
    }
    let current = null,
      key = '',
      epoch = 0,
      pending = false,
      renderKey = '',
      watched = false,
      keyAssets = [],
      referenceCatalog = [],
      keyAssetsSignature = '';
    const candidateStates = new Map();
    const $ = (id) => document.getElementById(id),
      status = (text) => {
        $('autoMessage').textContent = text;
      };
    const agent = () => {
      const a = context().agent;
      if (!a) throw Error('请先在游戏中配置并选择一个整理 Agent');
      return {
        endpoint: a.endpoint,
        model: a.model,
        ...(a.key ? { apiKey: a.key } : a.hasKey ? { profileSeat: a.seat } : { apiKey: '' }),
        reasoningEffort: NightfallAgentRequest.normalizeReasoningEffort(a.reasoningEffort),
      };
    };
    function itemControls(j, kind, index, item) {
      const stage = kind === 'frame' ? 'frames' : 'characters';
      const canManage =
        j.stage === stage && ['awaiting_confirmation', 'blocked', 'paused'].includes(j.status);
      const controls = [];
      if (canManage && item?.url) {
        const label =
          kind === 'character'
            ? '\u4eba\u7269\u5b9a\u5986\u7167'
            : kind === 'visual'
              ? '\u5173\u952e\u89c6\u89c9\u7d20\u6750'
              : '\u5206\u955c\u56fe';
        controls.push(
          '<button type="button" data-auto-art-action="retry" data-auto-art-kind="' +
            esc(kind) +
            '" data-auto-art-index="' +
            index +
            '">\u5355\u9879\u91cd\u505a' +
            label +
            '（\u9700\u786e\u8ba4\u8d39\u7528）</button>',
        );
      }
      const history = (j.art?.history || []).filter(
        (entry) => entry.kind === kind && entry.index === index && entry.url,
      );
      if (history.length) {
        controls.push(
          '<details class="auto-asset-history"><summary>\u5386\u53f2\u7248\u672c（' +
            history.length +
            '）</summary><ol>' +
            history
              .map(
                (entry) =>
                  '<li><img src="' +
                  esc(entry.url) +
                  '" alt="\u5386\u53f2\u56fe\u7247" loading="lazy"><span>\u7248\u672c ' +
                  esc(entry.revision || '') +
                  ' · ' +
                  esc(entry.archivedAt || '') +
                  '</span>' +
                  (canManage
                    ? '<button type="button" data-auto-art-action="restore" data-auto-art-kind="' +
                      esc(kind) +
                      '" data-auto-art-index="' +
                      index +
                      '" data-auto-art-file="' +
                      esc(entry.file) +
                      '">\u6062\u590d\u6b64\u7248\u672c</button>'
                    : '') +
                  '</li>',
              )
              .join('') +
            '</ol></details>',
        );
      }
      return controls.length
        ? '<div class="auto-asset-controls">' + controls.join('') + '</div>'
        : '';
    }
    async function load() {
      const c = context(),
        next = (c.story?.id || '') + ':' + (c.story?.version || '') + ':' + c.roomSize;
      if (next !== key) {
        key = next;
        epoch++;
        current = null;
        renderKey = '';
        watched = false;
        keyAssets = [];
        referenceCatalog = [];
        keyAssetsSignature = '';
        $('autoFinalVideo').removeAttribute('src');
        $('autoFinalVideo').load();
        render();
      }
      $('keyAssetsSection').hidden = !c.story?.id;
      if (!c.story?.id) return;
      const token = epoch;
      try {
        const [tasks, assetResult, refResult] = await Promise.all([
          request('/api/story-productions?storyId=' + encodeURIComponent(c.story.id)),
          request(
            '/api/story-key-assets?storyId=' +
              encodeURIComponent(c.story.id) +
              '&roomSize=' +
              c.roomSize,
          ).then(
            (value) => ({ value }),
            (error) => ({ error }),
          ),
          request('/api/story-assets/references?roomSize=' + c.roomSize).then(
            (value) => ({ value }),
            (error) => ({ error }),
          ),
        ]);
        if (token !== epoch) return;
        if (assetResult.value) keyAssets = assetResult.value;
        if (refResult.value) referenceCatalog = refResult.value;
        renderKeyAssets();
        if (assetResult.error || refResult.error)
          status(
            '关键物品或参考图读取失败，请刷新重试。' +
              (assetResult.error?.message || refResult.error?.message || ''),
          );
        current =
          tasks.find((t) => t.version === c.story.version && t.status !== 'cancelled') || null;
        render();
      } catch (e) {
        if (token === epoch) status(e.message);
      }
    }
    function renderKeyAssets() {
      const c = context();
      const taskAssets = Array.isArray(current?.visualAssets) ? current.visualAssets : [];
      const signature = JSON.stringify([c.story?.version, taskAssets, keyAssets, referenceCatalog]);
      if (signature === keyAssetsSignature) return;
      keyAssetsSignature = signature;
      const controls = $('keyAssetsControls'),
        list = $('keyAssetsList'),
        apply = $('applyKeyAssets');
      if (apply) apply.hidden = true;
      if (taskAssets.length) {
        // eslint-disable-next-line no-unsanitized/property -- API-provided text and URLs are escaped, with remaining values fixed enums or numeric indices.
        controls.innerHTML =
          '<p class="hint">以下关键场景与道具由系统根据当前剧本自动识别并生成提示词。它们会在人物定妆阶段并列生成和核对，确认后自动用于关联镜头。</p>' +
          taskAssets
            .map(
              (asset, index) =>
                '<article class="auto-visual-card"><h3>' +
                esc(asset.label || '视觉素材 ' + (index + 1)) +
                '</h3><p class="hint">类型：' +
                esc(asset.kind === 'scene' ? '场景' : '道具') +
                ' · 关联镜头：' +
                esc(
                  (asset.scenes || []).map((n) => '镜头 ' + (Number(n) + 1)).join('、') ||
                    '系统判断',
                ) +
                '</p><p>' +
                esc(asset.appearance || '系统根据剧本生成公开外观描述。') +
                '</p><details open><summary>系统生成的图片提示词</summary><pre>' +
                esc(asset.prompt || '系统将根据当前剧本自动补全公开提示词。') +
                '</pre></details></article>',
            )
            .join('');
      } else {
        controls.innerHTML =
          '<p class="hint">尚未生成当前剧本的关键视觉素材清单。点击“开始制作”后，系统会根据公开背景、视觉设定和分镜自动识别需要跨镜保持的场景与道具，并生成提示词。</p>';
      }
      // eslint-disable-next-line no-unsanitized/property -- API-provided text and URLs are escaped, with remaining values fixed enums or numeric indices.
      list.innerHTML = keyAssets
        .map(
          (item) =>
            '<article><h3>' +
            esc(item.label) +
            ' · 剧本 v' +
            esc(item.version) +
            '</h3>' +
            (item.reference?.url
              ? '<button type="button" data-reference-zoom="' +
                esc(item.reference.url) +
                '" data-reference-caption="' +
                esc(item.label) +
                '"><img src="' +
                esc(item.reference.url) +
                '" alt="' +
                esc(item.label) +
                '"></button>'
              : '') +
            '<p>' +
            esc(item.message || item.status) +
            (item.confirmedAt ? ' · 已确认 ' + esc(item.confirmedAt) : '') +
            '</p>' +
            (item.fixedLayout
              ? '<p class="hint">固定外观及位置 · ' + esc(item.fixedLayout) + '</p>'
              : '') +
            (item.allowedMovements
              ? '<p class="hint">允许移动 · ' + esc(item.allowedMovements) + '</p>'
              : '') +
            (item.review
              ? '<p>AI 检查 · ' +
                esc(item.review.verdict) +
                ' · ' +
                esc(item.review.summary) +
                '</p>' +
                (item.review.findings || [])
                  .map(
                    (f) =>
                      '<p>' + esc([f.evidence, f.suggestion].filter(Boolean).join(' · ')) + '</p>',
                  )
                  .join('')
              : '') +
            (item.status === 'unknown'
              ? '<button type="button" data-key-action="resolveUnknown" data-key-id="' +
                esc(item.id) +
                '">已核对供应商，解除待处理状态</button>'
              : '') +
            (item.status === 'received'
              ? '<button type="button" data-key-action="recover" data-key-id="' +
                esc(item.id) +
                '">恢复已保存原图</button>'
              : '') +
            (item.status === 'done' && item.version === c.story?.version
              ? '<button type="button" data-key-action="review" data-key-id="' +
                esc(item.id) +
                '">AI 检查</button> ' +
                (item.review && !item.confirmedAt
                  ? '<button type="button" data-key-action="confirm" data-key-id="' +
                    esc(item.id) +
                    '">确认此图</button>'
                  : '')
              : '') +
            (item.confirmedAt && item.version === c.story?.version
              ? '<fieldset><legend>选择引用此图的镜头</legend>' +
                (c.story.scenes || [])
                  .map(
                    (scene, index) =>
                      '<label><input type="checkbox" data-key-map-scene data-key-id="' +
                      esc(item.id) +
                      '" value="' +
                      index +
                      '">镜头 ' +
                      (index + 1) +
                      (scene.location ? ' · ' + esc(scene.location) : '') +
                      '</label>',
                  )
                  .join(' ') +
                '</fieldset>'
              : '') +
            (item.appliedMappings || [])
              .map(
                (mapping) =>
                  '<p class="hint">已加入剧本 v' +
                  esc(mapping.version) +
                  ' · 镜头 ' +
                  mapping.scenes.map((i) => i + 1).join('、') +
                  '</p>',
              )
              .join('') +
            '</article>',
        )
        .join('');
    }

    function render() {
      const c = context(),
        j = current,
        busy = pending || ['running'].includes(j?.status);
      $('autoStart').disabled =
        pending || !c.ready || (!!j && !['cancelled', 'stale'].includes(j.status));
      $('autoPause').hidden = j?.status !== 'running';
      $('autoContinue').hidden = !['paused', 'blocked'].includes(j?.status);
      $('autoCancel').hidden = !j || ['complete', 'cancelled', 'stale'].includes(j.status);
      $('autoContinue').textContent =
        j?.errorCode?.startsWith('AUDIT') || j?.errorCode === 'VISION_REQUIRED'
          ? '重试检查'
          : '继续制作／查询';
      $('autoAcceptShot').hidden = j?.errorCode !== 'SHOT_INSPECTION_REQUIRED';
      $('autoConfirm').hidden = j?.status !== 'awaiting_confirmation';
      const itemsToConfirm =
        j?.stage === 'characters'
          ? [...(j.art?.characters || []), ...(j.art?.visualAssets || [])]
          : j?.stage === 'frames'
            ? j.art?.frames
            : null;
      $('autoConfirm').disabled =
        pending ||
        (j?.stage === 'final' && !watched) ||
        !!itemsToConfirm?.some((x) => !x.confirmed);
      $('autoAuthorization').hidden = !(
        j?.status === 'awaiting_confirmation' && j.stage === 'plan'
      );
      $('autoSkipChecks').hidden = !(
        j?.status === 'blocked' && String(j.errorCode || '').startsWith('AUDIT_')
      );
      $('autoConfirm').textContent =
        j?.stage === 'plan'
          ? '确认方案并授权制作'
          : j?.stage === 'final'
            ? '完整观看后确认成片'
            : '确认此阶段，自动继续';
      const active =
        j?.stage === 'video'
          ? 3
          : Math.max(
              0,
              stages.findIndex((s) => s[0] === j?.stage),
            );
      // eslint-disable-next-line no-unsanitized/property -- API-provided text and URLs are escaped, with remaining values fixed enums or numeric indices.
      $('autoStages').innerHTML = stages
        .map(
          ([id, label], i) =>
            '<li class="' +
            (j?.approvals[id] ? 'done' : j && i === active ? 'active' : '') +
            '"><button type="button" data-auto-section="' +
            id +
            '">' +
            label +
            '<small>' +
            (j?.approvals[id]
              ? '已确认'
              : j && i === active
                ? j.status === 'awaiting_confirmation'
                  ? '待确认'
                  : j.status === 'running'
                    ? '进行中'
                    : '待处理'
                : '待进行') +
            '</small></button></li>',
        )
        .join('');
      if (!j) {
        status(
          c.story
            ? '点击开始后先检查剧本与图片理解能力，方案确认后才生成素材。'
            : '请选择或在高级编辑中载入新版剧本。',
        );
        $('autoResults').hidden = true;
        return;
      }
      status(j.message);
      $('autoResults').hidden = false;
      const p = j.plan;
      $('autoScope').textContent =
        p.characters + ' 位人物 · ' + p.shots + ' 个镜头 · 画面 ' + p.duration + ' 秒＋片尾约 4 秒';
      const backfill = $('autoVisualAssetBackfill');
      if (backfill) {
        if (p.visualAssetsReady === false) {
          backfill.hidden = false;
          // eslint-disable-next-line no-unsanitized/property -- API-provided text and URLs are escaped, with remaining values fixed enums or numeric indices.
          backfill.innerHTML =
            '<p><b>此历史任务还没有关键视觉素材清单。</b>可以先调用整理 Agent 根据当前公开剧本识别场景和道具并生成提示词。这一步不会生成图片，也不会产生生图费用。</p><button type="button" data-auto-backfill-visual-assets' +
            (pending || j.status === 'running' ? ' disabled' : '') +
            '>补齐关键视觉素材清单</button>';
        } else {
          backfill.hidden = true;
          backfill.innerHTML = '';
        }
      }
      $('autoChargeScope').textContent =
        '本次范围为 ' +
        p.imageRequests +
        ' 张图片、' +
        p.videoRequests +
        ' 个视频镜头。不会自动重做图片或视频；整改候选需你预览采用，单项生成另行确认费用。检查使用所选 Agent，可能产生聊天费用。';
      $('autoCapabilities').textContent = j.capabilities
        ? '图片理解已实测通过。视频检查使用实际关键帧、相邻接点与本地英文语音转写。'
        : '';
      const signature = JSON.stringify([
        j.reports,
        j.reportHistory,
        j.redos,
        j.candidates,
        j.art?.revision,
        j.art?.characters.map((x) => [
          x.status,
          x.url,
          x.confirmed,
          x.needsRegeneration,
          x.review?.fingerprint,
        ]),
        j.art?.visualAssets?.map((x) => [
          x.status,
          x.url,
          x.confirmed,
          x.needsRegeneration,
          x.review?.fingerprint,
          x.prompt,
        ]),
        j.art?.frames.map((x) => [
          x.status,
          x.url,
          x.confirmed,
          x.needsRegeneration,
          x.review?.fingerprint,
        ]),
        j.art?.history?.map((x) => [x.kind, x.index, x.file, x.revision, x.archivedAt]),
        j.video?.scenes.map((s) => [s.status, s.url]),
        j.final?.url,
      ]);
      if (signature !== renderKey) {
        renderKey = signature;
        // eslint-disable-next-line no-unsanitized/property -- API-provided text and URLs are escaped, with remaining values fixed enums or numeric indices.
        $('autoReports').innerHTML =
          Object.entries(j.reports)
            .map(
              ([name, r]) =>
                '<article><h3>' +
                esc(name === 'script' ? '剧情检查' : reportLabel(name)) +
                ' · ' +
                esc({ pass: '检查通过', inspect: '需核对', redo: '发现问题' }[r.verdict]) +
                '</h3><p>' +
                esc(r.summary) +
                '</p>' +
                (r.findings || [])
                  .map(
                    (f, findingIndex) =>
                      '<section class="auto-finding-card" id="auto-finding-' +
                      esc(name) +
                      '-' +
                      findingIndex +
                      '" data-finding-key="' +
                      esc(name + ':' + findingIndex) +
                      '">' +
                      '<div class="auto-finding-heading"><strong>意见 ' +
                      (findingIndex + 1) +
                      '</strong>' +
                      (f.severity
                        ? '<span class="auto-finding-severity severity-' +
                          esc(f.severity) +
                          '">' +
                          esc(
                            { critical: '严重', warning: '警告', info: '提示' }[f.severity] ||
                              f.severity,
                          ) +
                          '</span>'
                        : '') +
                      (f.shot ? '<span>镜头 ' + esc(f.shot) + '</span>' : '') +
                      (f.seat ? '<span>座位 ' + esc(f.seat) + '</span>' : '') +
                      (f.time !== null && f.time !== undefined
                        ? '<span>' + esc(f.time) + ' 秒</span>'
                        : '') +
                      '</div>' +
                      (f.evidence
                        ? '<div class="auto-finding-detail"><b>检查发现</b><p>' +
                          esc(f.evidence) +
                          '</p></div>'
                        : '') +
                      (f.suggestion
                        ? '<div class="auto-finding-detail"><b>整改建议</b><p>' +
                          esc(f.suggestion) +
                          '</p></div>'
                        : '') +
                      (() => {
                        const findingKey = name + ':' + findingIndex;
                        const candidate = (j.candidates || [])
                          .filter(
                            (c) =>
                              c.key === name &&
                              c.findingIndex === findingIndex &&
                              (!r.id || !c.reportId || c.reportId === r.id),
                          )
                          .at(-1);
                        const state = candidateStates.get(findingKey);
                        const status =
                          state?.status === 'generating'
                            ? '<p class="auto-finding-status is-running" role="status">正在生成此意见的整改候选…</p>'
                            : state?.status === 'error'
                              ? '<p class="auto-finding-status is-error" role="alert">整改候选生成失败：' +
                                esc(state.message) +
                                '</p>'
                              : state?.status === 'success'
                                ? '<p class="auto-finding-status is-success" role="status">此意见的整改候选已生成并已关联。</p>'
                                : '';
                        const action = candidate
                          ? ''
                          : '<div class="auto-finding-actions"><span>此操作仅针对意见 ' +
                            (findingIndex + 1) +
                            '，会把当前意见单独交给整理 Agent 生成可预览候选。</span>' +
                            (state?.status === 'generating'
                              ? '<button disabled>正在生成整改候选…</button>'
                              : '<button aria-label="为意见 ' +
                                (findingIndex + 1) +
                                ' 生成整改候选" aria-describedby="auto-finding-' +
                                esc(name) +
                                '-' +
                                findingIndex +
                                '" data-auto-create-candidate="' +
                                esc(name) +
                                '" data-auto-finding-index="' +
                                findingIndex +
                                '" data-auto-report-id="' +
                                esc(r.id || '') +
                                '">' +
                                (state?.status === 'error'
                                  ? '重试生成此意见候选'
                                  : '为意见 ' + (findingIndex + 1) + ' 生成整改候选') +
                                '</button>') +
                            '</div>';
                        const inline = candidate
                          ? '<div class="auto-finding-candidate"><b>对应整改候选 · ' +
                            esc(candidate.status) +
                            '</b><p>' +
                            esc(JSON.stringify(candidate.changes || {}, null, 2)) +
                            '</p>' +
                            (candidate.affected?.length
                              ? '<small>影响：' + esc(candidate.affected.join('、')) + '</small>'
                              : '') +
                            '<div class="auto-finding-candidate-actions">' +
                            (candidate.status === 'pending'
                              ? (candidate.previewedAt
                                  ? '<span>已预览，可采用</span><button data-auto-adopt-candidate="' +
                                    esc(candidate.id) +
                                    '">采用此候选</button>'
                                  : '<button data-auto-preview-candidate="' +
                                    esc(candidate.id) +
                                    '">预览并记录候选</button>') +
                                ' <button data-auto-withdraw-candidate="' +
                                esc(candidate.id) +
                                '">撤回候选</button>'
                              : candidate.status === 'adopted'
                                ? '<button data-auto-revert-candidate="' +
                                  esc(candidate.id) +
                                  '">撤销已采用候选</button>'
                                : '') +
                            '</div></div>'
                          : '';
                        return status + action + inline;
                      })() +
                      '</section>',
                  )
                  .join('') +
                '<small>' +
                esc(r.method || '') +
                (r.reuse ? ' · 复用了兼容检查报告' : '') +
                '</small></article>',
            )
            .join('') +
          (j.candidates || [])
            .map(
              (c) =>
                '<article class="revision-candidate"><h3>整改候选 · ' +
                esc(reportLabel(c.key)) +
                (Number.isInteger(c.findingIndex)
                  ? ' · 意见 ' + (c.findingIndex + 1)
                  : ' · 整份报告') +
                '</h3>' +
                (c.sourceFinding
                  ? '<p>对应意见：' +
                    esc(
                      [c.sourceFinding.evidence, c.sourceFinding.suggestion]
                        .filter(Boolean)
                        .join(' · '),
                    ) +
                    '</p>'
                  : '') +
                '<p>状态：' +
                esc(c.status) +
                ' · 影响：' +
                esc((c.affected || []).join('、') || '对应报告') +
                '</p><pre>' +
                esc(JSON.stringify(c.changes, null, 2)) +
                '</pre>' +
                (c.status === 'pending'
                  ? (c.previewedAt
                      ? '<p>已预览：' + esc(c.previewedAt) + '</p>'
                      : '<button data-auto-preview-candidate="' +
                        esc(c.id) +
                        '">预览并记录候选</button>') +
                    (c.previewedAt
                      ? '<button data-auto-adopt-candidate="' + esc(c.id) + '">采用此候选</button>'
                      : '') +
                    ' <button data-auto-withdraw-candidate="' +
                    esc(c.id) +
                    '">撤回候选</button>'
                  : c.status === 'adopted'
                    ? '<button data-auto-revert-candidate="' +
                      esc(c.id) +
                      '">撤销已采用候选</button>'
                    : '') +
                '</article>',
            )
            .join('');
        if (j.reportHistory?.length)
          // eslint-disable-next-line no-unsanitized/property -- API-provided text and URLs are escaped, with remaining values fixed enums or numeric indices.
          $('autoReports').innerHTML +=
            '<details><summary>历史检查报告（' +
            j.reportHistory.length +
            '）</summary>' +
            j.reportHistory
              .map(
                (h) =>
                  '<article><h3>' +
                  esc(reportLabel(h.key)) +
                  '</h3><p>' +
                  esc(h.report.summary || '') +
                  '</p>' +
                  (h.report.findings || [])
                    .map(
                      (f) =>
                        '<p>' +
                        esc([f.evidence, f.suggestion].filter(Boolean).join(' · ')) +
                        '</p>',
                    )
                    .join('') +
                  '<small>' +
                  esc(h.report.protocol || '旧版协议') +
                  ' · ' +
                  esc(h.report.checkedAt || h.archivedAt) +
                  '</small></article>',
              )
              .join('') +
            '</details>';
        // eslint-disable-next-line no-unsanitized/property -- API-provided text and URLs are escaped, with remaining values fixed enums or numeric indices.
        $('autoCharacters').innerHTML = (j.art?.characters || [])
          .map(
            (c, i) =>
              '<figure>' +
              (c.url
                ? '<button type="button" data-reference-zoom="' +
                  esc(c.url) +
                  '" data-reference-caption="' +
                  esc(c.name) +
                  '"><img src="' +
                  esc(c.url) +
                  '" alt="' +
                  esc(c.name) +
                  '" loading="lazy"></button>'
                : '<span>等待图片</span>') +
              '<figcaption>' +
              esc(c.seat + ' 号 ' + c.name) +
              '</figcaption>' +
              (c.appearance ? '<p class="hint">' + esc(c.appearance) + '</p>' : '') +
              (c.confirmed
                ? '<p>本项已确认</p>'
                : j.stage === 'characters' &&
                    j.status === 'awaiting_confirmation' &&
                    c.url &&
                    !c.needsRegeneration
                  ? '<button data-auto-confirm-kind="character" data-auto-confirm-index="' +
                    esc((j.art.characters || []).indexOf(c)) +
                    '">逐项确认定妆照</button>'
                  : '') +
              itemControls(j, 'character', i, c) +
              '</figure>',
          )
          .join('');
        // eslint-disable-next-line no-unsanitized/property -- API-provided text and URLs are escaped, with remaining values fixed enums or numeric indices.
        $('autoVisualAssets').innerHTML = (j.art?.visualAssets || [])
          .map((asset, i) => {
            const kindLabel =
              asset.kind === 'scene'
                ? '场景'
                : asset.kind === 'prop'
                  ? '道具'
                  : asset.kind === 'costume'
                    ? '服装'
                    : asset.kind || '视觉素材';
            const review = asset.review;
            const reviewText = review
              ? review.verdict === 'pass'
                ? 'AI 检查通过'
                : review.summary || 'AI 检查待人工复核'
              : '尚未完成单项 AI 检查';
            return (
              '<article class="auto-visual-card"><figure>' +
              (asset.url
                ? '<button type=\"button\" data-reference-zoom=\"' +
                  esc(asset.url) +
                  '\" data-reference-caption=\"' +
                  esc(asset.label || '关键视觉素材') +
                  '\"><img src=\"' +
                  esc(asset.url) +
                  '\" alt=\"' +
                  esc(asset.label || '关键视觉素材') +
                  '\" loading=\"lazy\"></button>'
                : '<span>等待图片</span>') +
              '<figcaption>' +
              esc(asset.label || kindLabel + ' ' + (i + 1)) +
              ' · ' +
              esc(kindLabel) +
              '</figcaption></figure><p class="hint">' +
              esc(asset.appearance || '暂无外观描述') +
              '</p><details><summary>图片提示词</summary><pre>' +
              esc(asset.prompt || '暂无提示词') +
              '</pre></details><p class="hint">关联镜头：' +
              esc(
                (asset.scenes || []).map((n) => '镜头 ' + (Number(n) + 1)).join('、') ||
                  '由系统根据剧本判断',
              ) +
              '</p><p class="auto-asset-review">' +
              esc(reviewText) +
              '</p>' +
              (asset.message ? '<p class="hint">' + esc(asset.message) + '</p>' : '') +
              (asset.confirmed
                ? '<p>本项已确认</p>'
                : j.stage === 'characters' &&
                    j.status === 'awaiting_confirmation' &&
                    asset.url &&
                    !asset.needsRegeneration
                  ? '<button data-auto-confirm-kind=\"visual\" data-auto-confirm-index=\"' +
                    esc(i) +
                    '\">逐项确认' +
                    esc(kindLabel) +
                    '定妆图</button>'
                  : '') +
              itemControls(j, 'visual', i, asset) +
              '</article>'
            );
          })
          .join('');
        // eslint-disable-next-line no-unsanitized/property -- API-provided text and URLs are escaped, with remaining values fixed enums or numeric indices.
        $('autoFrames').innerHTML = (j.art?.frames || [])
          .map(
            (f, i) =>
              '<article><h3>镜头 ' +
              (i + 1) +
              '</h3><div class="auto-pair">' +
              (i && j.art.frames[i - 1].url
                ? '<figure><img src="' +
                  esc(j.art.frames[i - 1].url) +
                  '" alt="前镜分镜"><figcaption>前镜分镜</figcaption></figure>'
                : '') +
              '<figure>' +
              (f.url
                ? '<button type="button" data-reference-zoom="' +
                  esc(f.url) +
                  '" data-reference-caption="镜头 ' +
                  (i + 1) +
                  '"><img src="' +
                  esc(f.url) +
                  '" alt="本镜分镜" loading="lazy"></button>'
                : '<span>等待分镜</span>') +
              '<figcaption>本镜开始</figcaption></figure></div><p>' +
              esc(
                j.plan.relationships[i].startSource === 'previous'
                  ? '以前镜实际结束画面起拍'
                  : '以本镜已确认分镜图起拍',
              ) +
              '</p><p class="hint">前镜结束 ' +
              esc(i ? j.plan.relationships[i - 1].endFrame || '请对照高级编辑' : '序幕开始') +
              '<br>本镜开始 ' +
              esc(j.plan.relationships[i].startFrame || '请对照高级编辑') +
              '</p>' +
              (f.referenceManifest?.length
                ? referenceList(
                    f.referenceManifest.map((ref) => ({
                      label:
                        ({
                          character: '人物',
                          scene: '场景',
                          prop: '道具',
                          costume: '服装',
                          'previous-frame': '前序分镜',
                        }[ref.purpose] || ref.purpose) +
                        ' · ' +
                        (ref.label || ref.source || '参考图'),
                      url: ref.url,
                    })),
                    '该图实际使用的生图参考',
                  )
                : '<p class="hint">此历史图片没有记录完整生图参考清单。</p>') +
              referenceList(j.plan.relationships[i].references || [], '视频参考规划') +
              (f.confirmed
                ? '<p>本项已确认</p>'
                : j.stage === 'frames' &&
                    j.status === 'awaiting_confirmation' &&
                    f.url &&
                    !f.needsRegeneration
                  ? '<button data-auto-confirm-kind="frame" data-auto-confirm-index="' +
                    esc(i) +
                    '">逐项确认分镜图</button>'
                  : '') +
              itemControls(j, 'frame', i, f) +
              '</article>',
          )
          .join('');
        // eslint-disable-next-line no-unsanitized/property -- API-provided text and URLs are escaped, with remaining values fixed enums or numeric indices.
        $('autoShots').innerHTML = (j.video?.scenes || [])
          .filter((s) => s.url)
          .map(
            (s) =>
              '<article><h3>镜头 ' +
              (s.index + 1) +
              ' · ' +
              esc(s.status) +
              '</h3>' +
              (s.reuse
                ? '<p class="hint">复用了兼容镜头 · 来源任务 ' +
                  esc(s.reuse.sourceTaskId) +
                  ' · ' +
                  esc(s.reuse.reusedAt || '') +
                  '</p>'
                : '') +
              '<video controls playsinline preload="metadata" src="' +
              esc(s.url) +
              '"></video></article>',
          )
          .join('');
      }
      const final = j.final;
      if (final?.url) {
        $('autoFinal').hidden = false;
        if ($('autoFinalVideo').getAttribute('src') !== final.url) {
          watched = false;
          $('autoFinalVideo').src = final.url;
        }
        $('autoDownload').href = final.url;
        $('autoSrt').href = final.srtUrl;
      } else $('autoFinal').hidden = true;
      $('autoCharactersSection').hidden =
        !j.art || (!(j.art.characters || []).length && !(j.art.visualAssets || []).length);
      $('autoFramesSection').hidden = !j.art?.frames.some((f) => f.url);
      $('autoShotsSection').hidden = !j.video?.scenes.some((s) => s.url);
      for (const id of ['autoPause', 'autoContinue', 'autoCancel', 'autoAcceptShot'])
        $(id).disabled = pending;
    }
    async function operation(fn) {
      if (pending) return;
      $('autoError').textContent = '';
      pending = true;
      render();
      try {
        await fn();
      } catch (e) {
        $('autoError').textContent = e.message;
      } finally {
        pending = false;
        render();
      }
    }
    $('keyAssetsSection').addEventListener('click', (e) => {
      const generate = e.target.closest('[data-key-generate]');
      const reuse = e.target.closest('[data-key-reuse]');
      const actionButton = e.target.closest('[data-key-action]');
      const apply = e.target.closest('#applyKeyAssets');
      if (!generate && !reuse && !actionButton && !apply) return;
      operation(async () => {
        const c = context();
        if (!c.story?.id) throw Error('请先保存并选择剧本。');
        if (apply) {
          const selections = new Map();
          $('keyAssetsList')
            .querySelectorAll('[data-key-map-scene]:checked')
            .forEach((input) => {
              const key = input.dataset.keyId;
              if (!selections.has(key)) selections.set(key, []);
              selections.get(key).push(Number(input.value));
            });
          if (!selections.size) throw Error('请先检查并确认关键物品图片，再选择要引用它的镜头。');
          if (
            !confirm(
              '将把所选参考图写入新剧本版本。旧剧本和旧制作任务会保留，需重新确认新版本。继续？',
            )
          )
            return;
          const result = await request('/api/story-key-assets', {
            action: 'applyReferences',
            storyId: c.story.id,
            version: c.story.version,
            roomSize: c.roomSize,
            items: Array.from(selections, ([jobId, scenes]) => ({ jobId, scenes })),
          });
          if (onStoryUpdated) await onStoryUpdated(result.story);
          await load();
          return;
        }
        if (generate) {
          if (!confirm('将提交一张关键物品图片生成并产生费用。确认后开始？')) return;
          const subject = generate.dataset.keyGenerate;
          const fixedLayout = $('keyAssetsControls').querySelector(
            '[data-key-detail="' + subject + '"]',
          ).value;
          const allowedMovements = $('keyAssetsControls').querySelector(
            '[data-key-movement="' + subject + '"]',
          ).value;
          await request('/api/story-key-assets', {
            storyId: c.story.id,
            version: c.story.version,
            roomSize: c.roomSize,
            subject,
            fixedLayout,
            allowedMovements,
            confirmCharge: true,
          });
        } else if (reuse) {
          const subject = reuse.dataset.keyReuse;
          const referenceId = $('keyAssetsControls').querySelector(
            '[data-key-reference="' + subject + '"]',
          ).value;
          if (!referenceId) throw Error('请选择对应人数和用途的历史参考图。');
          await request('/api/story-key-assets', {
            action: 'reuse',
            storyId: c.story.id,
            version: c.story.version,
            roomSize: c.roomSize,
            subject,
            referenceId,
          });
        } else {
          const action = actionButton.dataset.keyAction;
          if (
            action === 'review' &&
            !confirm('将使用所选 Agent 检查图片，可能产生模型调用费用。继续？')
          )
            return;
          if (
            action === 'resolveUnknown' &&
            !confirm('请先核对供应商任务与费用。解除后可再次付费生成，是否已完成核对？')
          )
            return;
          if (action === 'confirm' && !confirm('已检查图片及报告，确认此参考图？')) return;
          await request('/api/story-key-assets/' + actionButton.dataset.keyId, {
            action,
            ...(action === 'review' ? { agent: agent() } : {}),
            ...(action === 'resolveUnknown' ? { reconciled: true } : {}),
          });
        }
        await load();
        if (typeof loadReferenceCatalog === 'function') await loadReferenceCatalog(true);
      });
    });
    $('autoStart').onclick = () =>
      operation(async () => {
        const selected = agent();
        if (
          !confirm(
            '将使用 ' +
              selected.model +
              ' 检查剧本和实际素材，可能产生聊天请求费用。人物秘密仅发送至这个检查 Agent。现在保存当前剧本并开始检查？',
          )
        )
          return;
        await save();
        const c = context();
        epoch++;
        key = (c.story?.id || '') + ':' + (c.story?.version || '') + ':' + c.roomSize;
        current = await request('/api/story-productions', {
          storyId: c.story.id,
          version: c.story.version,
          agent: selected,
        });
        renderKey = '';
      });
    const action = (name, extra = {}) =>
      operation(async () => {
        const id = current?.id,
          token = epoch;
        if (!id) return;
        const result = await request('/api/story-productions/' + id, {
          action: name,
          ...(['pause', 'cancel'].includes(name) ? {} : { agent: agent() }),
          ...extra,
        });
        if (token === epoch) current = result;
      });
    $('autoPause').onclick = () => action('pause');
    $('autoSkipChecks').onclick = () => {
      if (confirm('记录本节点 AI 检查失败并手动跳过？不会抹除素材或检查记录。'))
        action('skipChecks');
    };
    $('autoContinue').onclick = () => action('resume');
    $('autoCancel').onclick = () => {
      if (confirm('取消后续制作？已完成素材和已受理任务会保留。')) action('cancel');
    };
    $('autoAcceptShot').onclick = () => {
      if (confirm('已查看当前镜头及检查报告，接受该镜头并继续后续制作？')) action('acceptShot');
    };
    $('autoConfirm').onclick = () => {
      if (current?.stage === 'plan' && !$('autoAuthorize').checked) {
        status('请先确认制作范围与预算授权。');
        return;
      }
      action('confirm', {
        stage: current.stage,
        authorize: $('autoAuthorize').checked,
        artRevision: current.art?.revision,
        watched,
      });
    };
    $('autoFinalVideo').addEventListener('ended', () => {
      const v = $('autoFinalVideo');
      let coverage = 0;
      for (let i = 0; i < v.played.length; i++) coverage += v.played.end(i) - v.played.start(i);
      watched = Number.isFinite(v.duration) && coverage >= v.duration * 0.95;
      render();
    });
    $('autoVisualAssetBackfill')?.addEventListener('click', (e) => {
      if (!e.target.closest('[data-auto-backfill-visual-assets]')) return;
      operation(async () => {
        const result = await request('/api/story-productions/' + current.id, {
          action: 'backfillVisualAssets',
          agent: agent(),
        });
        current = result;
      });
    });
    $('autoReports').onclick = (e) => {
      const create = e.target.closest('[data-auto-create-candidate]'),
        preview = e.target.closest('[data-auto-preview-candidate]'),
        adopt = e.target.closest('[data-auto-adopt-candidate]'),
        withdraw = e.target.closest('[data-auto-withdraw-candidate]'),
        revert = e.target.closest('[data-auto-revert-candidate]');
      if (create) {
        const findingKey =
          create.dataset.autoCreateCandidate + ':' + create.dataset.autoFindingIndex;
        candidateStates.set(findingKey, { status: 'generating' });
        render();
        operation(async () => {
          try {
            const result = await request('/api/story-productions/' + current.id, {
              action: 'createRevisionCandidate',
              agent: agent(),
              key: create.dataset.autoCreateCandidate,
              findingIndex: Number(create.dataset.autoFindingIndex),
              reportId: create.dataset.autoReportId,
            });
            current = result;
            candidateStates.set(findingKey, { status: 'success' });
          } catch (error) {
            candidateStates.set(findingKey, { status: 'error', message: error.message });
            $('autoError').textContent = error.message;
          }
          render();
        });
        return;
      }
      if (preview) {
        action('previewRevisionCandidate', { candidateId: preview.dataset.autoPreviewCandidate });
        return;
      }
      if (adopt) {
        if (
          confirm(
            '采用该整改候选？剧本候选会创建新版本；人物、关键视觉素材或分镜候选只更新提示词并标记需单独重做，不会自动产生生成费用。',
          )
        )
          action('adoptRevisionCandidate', { candidateId: adopt.dataset.autoAdoptCandidate });
        return;
      }
      if (withdraw)
        action('withdrawRevisionCandidate', {
          candidateId: withdraw.dataset.autoWithdrawCandidate,
        });
      if (
        revert &&
        confirm('撤销此候选？会保留新旧素材，并将受影响内容恢复为候选前版本；图片需重新检查确认。')
      )
        action('revertRevisionCandidate', { candidateId: revert.dataset.autoRevertCandidate });
    };
    document.addEventListener('click', (e) => {
      const artButton = e.target.closest('[data-auto-art-action]');
      if (artButton) {
        const kind = artButton.dataset.autoArtKind,
          index = Number(artButton.dataset.autoArtIndex),
          operationName = artButton.dataset.autoArtAction;
        if (operationName === 'retry') {
          if (
            !confirm(
              '\u5355\u9879\u91cd\u505a\u4f1a\u65b0\u589e\u4e00\u6b21\u56fe\u7247\u751f\u6210\u8d39\u7528\uff0c\u539f\u56fe\u548c\u5386\u53f2\u7248\u672c\u4f1a\u4fdd\u7559\u3002\u786e\u8ba4\u540e\u63d0\u4ea4\uff1f',
            )
          )
            return;
          const name =
            kind === 'character'
              ? 'retryCharacter'
              : kind === 'visual'
                ? 'retryVisualAsset'
                : 'retryFrame';
          action(name, {
            stage: current.stage,
            kind,
            index,
            artRevision: current.art?.revision,
            confirmCharge: true,
          });
        } else if (operationName === 'restore') {
          if (
            !confirm(
              '\u6062\u590d\u5386\u53f2\u56fe\u7247\uff1f\u6062\u590d\u540e\u9700\u91cd\u65b0\u68c0\u67e5\u548c\u786e\u8ba4\uff0c\u4e0d\u4f1a\u65b0\u589e\u751f\u6210\u8d39\u7528\u3002',
            )
          )
            return;
          action('restoreAssetRevision', {
            stage: current.stage,
            kind,
            index,
            file: artButton.dataset.autoArtFile,
            artRevision: current.art?.revision,
          });
        }
        return;
      }
      const button = e.target.closest('[data-auto-confirm-kind]');
      if (!button) return;
      const kind = button.dataset.autoConfirmKind,
        index = Number(button.dataset.autoConfirmIndex);
      if (!confirm('确认这张图片并采用当前版本？')) return;
      action('confirmAsset', {
        stage: current.stage,
        kind,
        index,
        artRevision: current.art?.revision,
      });
    });
    $('autoStages').onclick = (e) => {
      const step = e.target.closest('[data-auto-section]');
      if (!step) return;
      const target = {
        plan: 'autoReports',
        characters: 'autoCharactersSection',
        frames: 'autoFramesSection',
        final: 'autoFinal',
      }[step.dataset.autoSection];
      if (!$(target).hidden) $(target).scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    $('autoRefresh').onclick = load;
    setInterval(() => {
      if (!document.hidden && !pending) load();
    }, 1800);
    load();
    return { refresh: load };
  }
  root.NightfallAutoWorkshop = { mount };
})(globalThis);
