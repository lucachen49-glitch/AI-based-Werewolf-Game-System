'use strict';

let referenceCatalog = [],
  referenceCatalogRoom = 0,
  referenceEpoch = 0;

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
