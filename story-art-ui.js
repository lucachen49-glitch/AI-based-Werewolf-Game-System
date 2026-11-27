'use strict';
let art = null,
  artTimer = null,
  artView = '',
  artSubmitting = false,
  imageModel = 'gpt-image-2.5-sunburst';
function clearArt() {
  clearTimeout(artTimer);
  art = null;
  artView = '';
  for (const id of ['characterArt', 'frameArt', 'artHistoryItems'])
    document.getElementById(id).replaceChildren();
  document.getElementById('characterCount').textContent = '';
  document.getElementById('frameCount').textContent = '';
  document.getElementById('artMessage').textContent = '保存并确认电影剧本后，才可制作图片。';
  document.getElementById('artActivity').classList.add('hidden');
  document.getElementById('retryJobs').classList.add('hidden');
}
function artUpdateButtons() {
  const productionChanged =
      typeof generationDraftChanged === 'function' ? generationDraftChanged() : dirty,
    valid =
      !restoreBlocked &&
      !!current?.confirmed &&
      !productionChanged &&
      (cinematic || sceneCount === 6),
    busy = loading || restoring || !workshopReady || artSubmitting || art?.status === 'running',
    done = (items) =>
      items?.every((x) => x.confirmed === true || (x.confirmedAt !== undefined && !!x.confirmedAt));
  const pending = current?.characters?.some(
    (c) => !NightfallManor.imagePath(c.portraitId || NightfallManor.defaultId(c.seat - 1)),
  );
  $('createArt').disabled = !valid || busy || !!art || pending;
  $('createArt').title = pending ? '部分参考立绘待确认费用并制作，暂不能开始定妆任务' : '';
  $('createArt').textContent = artSubmitting
    ? '正在创建人物制作任务…'
    : art?.status === 'running'
      ? '人物图片制作中…'
      : '制作 ' + roomSize + ' 位人物定妆照';
  $('createArt').setAttribute('aria-busy', String(artSubmitting || art?.status === 'running'));
  $('artRequirement').textContent =
    restoring || !workshopReady
      ? '正在恢复剧本和制作记录，请稍候…'
      : artSubmitting
        ? '正在保存任务，随后显示每位人物的制作进度。'
        : !current?.confirmed || productionChanged
          ? '请先保存并确认当前剧本版本。'
          : pending
            ? '部分参考立绘尚未准备好，请更换为可用立绘。'
            : art
              ? '当前版本已有图片任务，进度显示在下方；已完成图片不会自动重做。'
              : '剧本已确认，可以制作人物定妆照；点击后需确认图片费用。';
  $('confirmCharacters').disabled =
    !valid || busy || !done(art?.characters) || art?.charactersConfirmed;
  $('generateFrames').disabled =
    !valid ||
    busy ||
    !art?.charactersConfirmed ||
    (art?.frames?.length > 0 && art.frames.every((x) => x.status === 'done'));
  $('confirmFrames').disabled =
    !valid || busy || !art?.charactersConfirmed || !done(art?.frames) || art?.framesConfirmed;
  $('resumeArt').classList.toggle(
    'hidden',
    !art ||
      !['paused', 'review', 'failed', 'needs_review'].includes(art.status) ||
      !(art.charactersConfirmed ? art.frames : art.characters).some((x) => x.status === 'queued'),
  );
  $('resumeArt').disabled = !valid || busy;
  document
    .querySelectorAll('[data-art-retry],[data-art-process],[data-art-continue],[data-art-confirm]')
    .forEach((el) => {
      const kind = el.dataset.kind,
        reason = restoreBlocked
          ? '请先处理页面顶部的草稿恢复提示。'
          : restoring || !workshopReady
            ? '正在恢复剧本和图片任务。'
            : loading || artSubmitting || art?.status === 'running'
              ? '当前制作步骤完成后即可操作。'
              : !current
                ? '请先载入并保存剧本。'
                : art?.storyId !== current.id || art?.version !== current.version
                  ? '此图片任务属于其他剧本版本；请切换到对应版本或在当前版本建立图片任务。'
                  : !current.confirmed
                    ? '请先在剧本区确认并保存当前剧本。'
                    : productionChanged
                      ? '剧本草稿尚未保存；保存为新版本后再制作对应图片。'
                      : kind === 'frame' && !art?.charactersConfirmed
                        ? '请先确认全部人物定妆照。'
                        : '';
      const blocked = !!reason;
      el.disabled = blocked;
      el.title = reason || '修改后重做会产生新的图片生成费用';
      if (typeof document.createElement === 'function') {
        let note = el.nextElementSibling;
        if (!note?.classList.contains('art-action-reason')) {
          note = document.createElement('p');
          note.className = 'hint art-action-reason';
          note.setAttribute('aria-live', 'polite');
          el.insertAdjacentElement('afterend', note);
        }
        note.textContent = blocked ? reason : '';
        note.hidden = !blocked;
      }
    });
  $('confirmCharacters').textContent = art?.charactersConfirmed
    ? '人物已确认 ✓'
    : '确认 ' + roomSize + ' 位人物';
  $('confirmFrames').textContent = art?.framesConfirmed
    ? '分镜已确认 ✓'
    : '确认 ' + (art?.frames.length || sceneCount) + ' 个分镜';
}
function artActivity(title, detail, { done = 0, total = roomSize, busy = false } = {}) {
  $('artActivity').classList.remove('hidden');
  $('artActivity').classList.toggle('busy', busy);
  $('artActivityTitle').textContent = title;
  $('artActivityDetail').textContent = detail;
  $('artOverall').max = total;
  $('artOverall').value = done;
  $('artOverall').setAttribute('aria-label', '已保存 ' + done + ' / ' + total + ' 张图片');
}
function artProgress(item) {
  let text =
    item.status === 'submitting'
      ? {
          waiting: '等待图片接口响应',
          downloading: '正在下载图片',
          processing: '正在本地处理图片',
        }[item.phase] || '正在等待图片接口'
      : artState[item.status] || item.status;
  if (item.status === 'submitting' && item.startedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(item.startedAt)) / 1000));
    text += ' · 已等待 ' + Math.floor(seconds / 60) + '分' + (seconds % 60) + '秒';
  }
  return esc(text);
}
function artDraftKey() {
  return art ? art.id + ':' + art.revision : '';
}
const artState = {
  queued: '尚未制作',
  submitting: '正在生成，请稍候',
  done: '已保存 · 待检查',
  unknown: '提交结果待核对',
  failed: '接口拒绝或制作失败',
  saved_raw: '原图已保存，等待本地处理',
  held: '等待当前重做结束',
};
function artCard(item, kind, index) {
  const text =
    artEdits[artDraftKey()]?.[kind + '-' + index] ??
    (kind === 'character' ? item.appearance : item.description);
  const scene = current?.scenes?.[index],
    start = current?.scenes?.slice(0, index).reduce((n, s) => n + (s.duration || 10), 0) || 0,
    end = start + (scene?.duration || 10);
  return `<article class="art-card"><div class="art-card-head"><strong>${kind === 'character' ? item.seat + '号 · ' + esc(item.name) : '镜头 ' + (index + 1) + ' · ' + start + '—' + end + '秒'}</strong><span data-art-status="${kind}-${index}" class="art-state ${item.status === 'done' ? 'ready' : ''}">${artProgress(item)}</span></div>${item.url ? `<button class="art-image" data-art-url="${esc(item.url)}" data-caption="${kind === 'character' ? esc(item.name) : '镜头 ' + (index + 1)}" aria-label="放大查看${kind === 'character' ? esc(item.name) : '分镜' + (index + 1)}"><img src="${esc(item.url)}" alt="${kind === 'character' ? esc(item.name) + '定妆照' : '分镜' + (index + 1) + '起始图'}" loading="lazy"></button>` : `<div class="art-placeholder">${kind === 'character' && NightfallManor.imagePath(item.portraitId, true) ? `<img src="${esc(NightfallManor.imagePath(item.portraitId, true))}" alt="原始参考立绘"><span>原始参考 · 尚未生成定妆照</span>` : kind === 'character' ? '参考立绘待制作' : '16:9 · 尚未生成起始图'}</div>`}<p class="hint">${kind === 'frame' ? '出场：' + (item.cast.length ? item.cast.map((n) => n + '号').join('、') : '环境镜头，无人物') : '参考：' + esc(item.portraitId)}${item.message ? ' · ' + esc(item.message) : ''}</p>${item.confirmed ? '<p class="art-state ready">本项已确认</p>' : item.url && !item.needsRegeneration ? '<button data-art-confirm="' + index + '" data-kind="' + kind + '">确认此' + (kind === 'character' ? '人物定妆' : '分镜图') + '</button>' : ''}<label>${kind === 'character' ? '公开外观' : '公开画面'}<textarea data-art-description="${kind}-${index}" rows="3" maxlength="${kind === 'character' ? 800 : 1000}">${esc(text)}</textarea></label><button data-art-retry="${index}" data-kind="${kind}">${item.status === 'queued' ? '单独制作' : '修改并重做此图'}</button>${kind === 'frame' && art.frames.slice(index + 1).some((f) => f.status === 'queued') && item.status !== 'done' ? `<button data-art-continue="${index}" data-kind="frame">重做此图并继续剩余镜头</button>` : ''}${item.status === 'saved_raw' ? `<button data-art-process="${index}" data-kind="${kind}">继续处理原图（不计费）</button>` : ''}${item.prompt ? `<details><summary>本图实际提示词</summary><pre>${esc(item.prompt)}</pre></details>` : ''}</article>`;
}
function showArt(j) {
  art = j;
  if (typeof renderReferencePreviews === 'function') renderReferencePreviews();
  $('artMessage').textContent = '图片 r' + j.revision + ' · ' + j.message;
  $('characterCount').textContent =
    j.characters.filter((x) => x.status === 'done').length + '/' + j.characters.length;
  $('frameCount').textContent =
    j.frames.filter((x) => x.status === 'done').length + '/' + j.frames.length;
  const items = j.stage === 'frame' || j.stage === 'complete' ? j.frames : j.characters,
    done = items.filter((x) => x.status === 'done').length,
    active = items.findIndex((x) => x.status === 'submitting'),
    kind = j.stage === 'frame' || j.stage === 'complete' ? '分镜' : '人物';
  artActivity(
    kind + '已保存 ' + done + ' / ' + items.length + ' 张',
    active >= 0
      ? '正在制作' +
          (kind === '人物'
            ? items[active].seat + '号 · ' + items[active].name
            : '镜头 ' + (active + 1)) +
          '：' +
          artProgress(items[active])
      : j.message || '任务已保存，正在读取制作进度…',
    { done, total: items.length, busy: j.status === 'running' },
  );
  const signature =
      JSON.stringify(j) + (j.status === 'running' ? Math.floor(Date.now() / 2500) : ''),
    editing = document.activeElement?.matches('[data-art-description]');
  if (signature !== artView && !editing) {
    artView = signature;
    $('characterArt').innerHTML = j.characters.map((x, i) => artCard(x, 'character', i)).join('');
    $('frameArt').innerHTML = j.frames.map((x, i) => artCard(x, 'frame', i)).join('');
    $('artHistoryItems').innerHTML = j.history.length
      ? j.history
          .map(
            (h) =>
              `<div class="art-history-row"><button data-art-url="${esc(h.url)}" data-caption="历史 r${h.revision}"><img src="${esc(h.url)}" alt="历史图片" loading="lazy"></button><span>r${h.revision} · ${h.kind === 'character' ? '人物' : '镜头'} ${h.index + 1}</span><button data-art-restore="${h.index}" data-kind="${h.kind}" data-file="${esc(h.file)}">恢复为候选</button><details><summary>提示词</summary><pre>${esc(h.prompt)}</pre></details></div>`,
          )
          .join('')
      : '暂无历史图片。重做后，旧图会保留在这里。';
  }
  for (const [kind, items] of [
    ['character', j.characters],
    ['frame', j.frames],
  ])
    items.forEach((item, i) => {
      const status = document.querySelector('[data-art-status="' + kind + '-' + i + '"]');
      if (status) {
        status.innerHTML = artProgress(item);
        status.classList.toggle('ready', item.status === 'done');
      }
    });
  updateButtons();
  persistWorkshop();
  clearTimeout(artTimer);
  if (j.status === 'running') artTimer = setTimeout(pollArt, 2500);
}
async function pollArt() {
  const id = art?.id;
  if (!id) return;
  try {
    const latest = await api('/api/story-art-jobs/' + id);
    if (art?.id === id) showArt(latest);
  } catch (e) {
    if (art?.id !== id) return;
    const text =
      '进度查询中断，6 秒后重新查询。已有图片仍保存在本机，不会重新提交生成。' + e.message;
    $('artMessage').textContent = text;
    $('artActivityDetail').textContent = text;
    $('retryJobs').classList.remove('hidden');
    artTimer = setTimeout(pollArt, 6000);
  }
}
async function loadArtJobs() {
  const id = current?.id,
    version = current?.version;
  if (!id || (!cinematic && sceneCount !== 6)) return;
  const list = await api('/api/story-art-jobs?storyId=' + id);
  if (current?.id !== id || current?.version !== version) return;
  const latest = list.find((j) => j.version === version);
  if (latest) showArt(latest);
}
async function artAction(body) {
  if (!current?.confirmed || generationDraftChanged())
    throw Error('当前剧本有未保存的实际内容修改；请保存新版本后再操作图片');
  if (!art || art.storyId !== current.id || art.version !== current.version)
    throw Error('当前图片任务不属于已载入的剧本版本，请先切换回对应版本');
  const id = art.id,
    result = await api('/api/story-art-jobs/' + id, { revision: art.revision, ...body });
  if (art?.id === id) showArt(result);
}
function initArtUI() {
  api('/api/image-config')
    .then((c) => {
      imageModel = c.model;
      $('imageConfigStatus').textContent = c.configured
        ? '独立图片密钥已保存 · ' + c.model
        : '尚未保存图片专用密钥，请先设置。';
    })
    .catch((e) => ($('imageConfigStatus').textContent = e.message));
  $('createArt').onclick = guard(async () => {
    if (!current?.confirmed || dirty) throw Error('请先保存并确认剧本');
    if (cinematic) {
      const issues = reviewIssues();
      if (issues.length) throw Error(issues.join('；'));
    }
    if (
      !confirm(
        '将调用 ' +
          imageModel +
          ' 制作 ' +
          roomSize +
          ' 张人物定妆照，可能产生图片生成费用。继续？',
      )
    )
      return;
    const storyId = current.id,
      version = current.version;
    artSubmitting = true;
    updateButtons();
    artActivity(
      '正在创建 ' + roomSize + ' 位人物制作任务',
      '正在提交到本地服务。任务保存后将逐张显示状态，请勿重复点击。',
      { busy: true },
    );
    $('artMessage').textContent = '正在创建人物图片任务…';
    $('artActivity').scrollIntoView({ block: 'center', behavior: 'smooth' });
    notice('正在创建人物制作任务，进度显示在“人物与分镜图片”区域。');
    try {
      const created = await api(
        '/api/story-art-jobs',
        { storyId, version, confirmCharge: true },
        { timeoutMs: 15000 },
      );
      if (current?.id !== storyId || current?.version !== version) return;
      showArt(created);
      notice('人物图片任务已保存，正在逐张制作。下方显示当前人物、已保存张数与等待时间。');
    } catch (e) {
      if (current?.id === storyId && current?.version === version) {
        artActivity(
          '未能取得人物任务进度',
          e.message + '。请先重新查询制作进度；提交结果不明时不要重复制作。',
        );
        $('artMessage').textContent = e.message;
        $('retryJobs').classList.remove('hidden');
      }
      throw e;
    } finally {
      artSubmitting = false;
      updateButtons();
    }
  });
  $('confirmCharacters').onclick = guard(async () => {
    if (!confirm('已逐张检查脸型、头发、服装及配饰，确认这 ' + roomSize + ' 位人物？')) return;
    await artAction({ action: 'confirmCharacters' });
  });
  $('generateFrames').onclick = guard(async () => {
    const n = art.frames.filter((f) => f.status === 'queued').length;
    if (!confirm('将为 ' + n + ' 个分镜生成起始图，可能产生图片生成费用。继续？')) return;
    await artAction({ action: 'generateFrames', confirmCharge: true });
  });
  $('confirmFrames').onclick = guard(async () => {
    if (
      !confirm(
        '已检查全部 ' +
          (art?.frames.length || sceneCount) +
          ' 个分镜的人物数量、外观、位置和前后衔接，确认用于视频？',
      )
    )
      return;
    await artAction({ action: 'confirmFrames' });
  });
  $('resumeArt').onclick = guard(async () => {
    const items = art.charactersConfirmed ? art.frames : art.characters,
      n = items.filter((x) => x.status === 'queued').length;
    if (
      !confirm(
        '继续制作 ' + n + ' 张尚未提交的图片，可能产生新的图片生成费用；已保存图片不会重做。继续？',
      )
    )
      return;
    await artAction({ action: 'resume', confirmCharge: true });
  });
  const click = guard(async (e) => {
    const restore = e.target.closest('[data-art-restore]');
    if (restore) {
      if (
        !confirm(
          '恢复历史图片为当前候选？原图及当前版本都会保留，恢复后需重新检查和确认，不会产生生成费用。',
        )
      )
        return;
      await artAction({
        action: 'restoreAssetRevision',
        kind: restore.dataset.kind,
        index: Number(restore.dataset.artRestore),
        file: restore.dataset.file,
      });
      return;
    }
    const single = e.target.closest('[data-art-confirm]');
    if (single) {
      if (!confirm('确认此图片符合当前人物或镜头要求？')) return;
      await artAction({
        action: single.dataset.kind === 'character' ? 'confirmCharacter' : 'confirmFrame',
        kind: single.dataset.kind,
        index: Number(single.dataset.artConfirm),
      });
      return;
    }
    const zoom = e.target.closest('[data-art-url]');
    if (zoom) {
      $('artZoomImage').src = zoom.dataset.artUrl;
      $('artZoomCaption').textContent = zoom.dataset.caption || '图片预览';
      $('artZoom').showModal();
      return;
    }
    const continuation = e.target.closest('[data-art-continue]'),
      retry = continuation || e.target.closest('[data-art-retry]'),
      process = e.target.closest('[data-art-process]');
    if (process) {
      await artAction({
        action: 'processSaved',
        kind: process.dataset.kind,
        index: Number(process.dataset.artProcess),
      });
      return;
    }
    if (!retry) return;
    const kind = retry.dataset.kind,
      index = Number(continuation ? continuation.dataset.artContinue : retry.dataset.artRetry),
      description = document.querySelector(
        '[data-art-description="' + kind + '-' + index + '"]',
      ).value;
    if (
      !confirm(
        (continuation
          ? '将重做此镜头，成功后继续尚未提交的后续镜头；每张均可能产生费用。'
          : kind === 'character'
            ? '重做人物会使相关分镜需要重新制作、确认。'
            : '重做后需要重新确认分镜。') +
          '这会新增一次图片生成费用。结果不明时请先核对华龙后台，确定继续？',
      )
    )
      return;
    await artAction({
      action: 'retry',
      kind,
      index,
      description,
      confirmCharge: true,
      reconciled: art[kind === 'character' ? 'characters' : 'frames'][index].status === 'unknown',
      continueQueued: !!continuation,
    });
  });
  for (const id of ['characterArt', 'frameArt', 'artHistoryItems']) {
    $(id).addEventListener('click', click);
    $(id).addEventListener('input', (e) => {
      if (!e.target.matches('[data-art-description]') || !art) return;
      const key = artDraftKey();
      (artEdits[key] ??= {})[e.target.dataset.artDescription] = e.target.value;
      persistWorkshop();
    });
  }
  $('closeArtZoom').onclick = () => {
    $('artZoom').close();
    $('artZoomImage').removeAttribute('src');
  };
}
