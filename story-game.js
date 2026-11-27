'use strict';
let storyLibrary = [],
  selectedStoryId = '',
  sessionStory = null,
  storyPlayer = null,
  storyPreparing = false,
  storyController = null;
const storyContexts = new Map();
const storyContextRequests = new Set();
try {
  selectedStoryId = localStorage.getItem('nightfall-story-id') || '';
} catch {}
let storySelectionRoom = 6,
  storySelections = { 6: selectedStoryId, 12: '' };
try {
  storySelections = {
    ...storySelections,
    ...JSON.parse(localStorage.getItem('nightfall-story-selections-v2') || '{}'),
  };
  selectedStoryId = storySelections[6] || '';
} catch {}
function rememberStory() {
  storySelections[size] = selectedStoryId;
  try {
    localStorage.setItem('nightfall-story-selections-v2', JSON.stringify(storySelections));
    if (size === 6) localStorage.setItem('nightfall-story-id', selectedStoryId);
  } catch {}
}
function storyOptions() {
  const list = storyLibrary.filter((s) => (s.roomSize || 6) === size),
    mapped = list.find((s) => s.id === selectedStoryId || s.aliasIds?.includes(selectedStoryId));
  if (mapped && mapped.id !== selectedStoryId) {
    selectedStoryId = mapped.id;
    rememberStory();
  }
  // eslint-disable-next-line no-unsanitized/property -- Story identifiers and titles are escaped, with remaining values numeric or boolean.
  $('storyChoice').innerHTML =
    '<option value="">标准狼人杀</option>' +
    list
      .map(
        (s) =>
          `<option value="${esc(s.id)}">${esc(s.title)} · v${esc(s.version)}${s.video ? ' · 已有独立视频' : ' · 可在工坊独立制作'}</option>`,
      )
      .join('');
  $('storyChoice').value = selectedStoryId;
}
function storyIntroActive() {
  return !!storyPlayer?.state().active;
}
async function storyFetch(url, signal) {
  const r = await fetch(url, { cache: 'no-store', signal });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw Error(d?.error?.message || '剧本服务暂不可用，请重启游戏后刷新');
  return d;
}
function renderStory() {
  if (!$('storyBar')) return;
  if (typeof portraitMode !== 'undefined')
    $('portraitMovieTools').classList.toggle('hidden', !portraitMode || !storyIntroActive());
  $('storyRoomLabel').textContent = size + ' 人剧本';
  $('storyChoice').setAttribute('aria-label', size + ' 人剧本');
  $('storyBar').classList.remove('hidden');
  if (storySelectionRoom !== size) {
    storySelections[storySelectionRoom] = selectedStoryId;
    storySelectionRoom = size;
    selectedStoryId = storySelections[size] || '';
    storyOptions();
  }
  $('storyChoice').disabled = busy;
  $('storyRefresh').disabled = busy;
  const chosen = storyLibrary.find((s) => s.id === selectedStoryId);
  $('storyHint').textContent = sessionStory
    ? '本局剧本：' + sessionStory.title + ' · 已冻结公开人物资料，剧情视频可在工坊独立预览和下载'
    : selectedStoryId
      ? '已选择《' + (chosen?.title || '当前剧本') + '》，开始游戏只载入已确认的公开人物资料'
      : '标准玩法，不载入剧情人物资料。';
  if (storyIntroActive()) {
    $('phaseName').textContent = '对局准备 · ' + (sessionStory?.title || '剧情人物');
    $('startText').textContent = '正在准备对局';
    $('autoState').textContent = '即将发牌';
  } else if (storyPreparing) $('startText').textContent = '正在准备剧本';
}
async function refreshStoryLibrary() {
  const list = await storyFetch('/api/scenarios');
  if (busy) return;
  storyLibrary = list;
  if (storySelectionRoom !== size) {
    storySelectionRoom = size;
    selectedStoryId = storySelections[size] || '';
  }
  storyOptions();
  if (
    selectedStoryId &&
    !list.some((s) => (s.roomSize || 6) === size && s.id === selectedStoryId)
  ) {
    selectedStoryId = '';
    rememberStory();
    storyOptions();
  }
  renderStory();
}
function resetStory() {
  storyController?.abort();
  storyController = null;
  for (const c of storyContextRequests) c.abort();
  storyContextRequests.clear();
  storyPlayer?.cancel();
  storyPreparing = false;
  sessionStory = null;
  storyContexts.clear();
}
async function prepareStory(token) {
  if (!selectedStoryId) return true;
  storyPreparing = true;
  const c = (storyController = new AbortController());
  renderAll();
  try {
    const s = await storyFetch('/api/scenarios/' + selectedStoryId, c.signal);
    if (token !== epoch) return false;
    if ((s.roomSize || 6) !== size) throw Error('剧本人数与房间不匹配，请重新选择');
    if (!s.confirmed) throw Error('请先在剧本工坊确认剧本，再开始这一局。');
    const snapshot =
      typeof NightfallScenario !== 'undefined' && NightfallScenario.publicStory
        ? NightfallScenario.publicStory(s)
        : s;
    sessionStory = Object.freeze(snapshot);
    return true;
  } finally {
    if (storyController === c) {
      storyPreparing = false;
      storyController = null;
    }
  }
}
async function playStoryIntro(token) {
  if (!sessionStory) return true;
  music?.stop();
  effects?.stop();
  stopNarration();
  clearBubble();
  $('storyMovieTitle').textContent = sessionStory.title;
  $('storyMovieMessage').textContent = '序幕结束后自动进入随机发牌。';
  const proceed = await storyPlayer.play(sessionStory.video.url);
  if (proceed && token === epoch) {
    paused = false;
    document.body.classList.remove('presentation-paused');
    releaseWait();
  }
  return proceed && token === epoch;
}
async function storyContext(id) {
  if (!sessionStory || (sessionStory.roomSize || 6) !== size) return null;
  const snapshot = sessionStory,
    key = snapshot.id + ':' + snapshot.version + ':' + id;
  if (storyContexts.has(key)) return storyContexts.get(key);
  const controller = new AbortController();
  storyContextRequests.add(controller);
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const data = await storyFetch(
      '/api/scenarios/' + snapshot.id + '/context/' + (id + 1) + '?version=' + snapshot.version,
      controller.signal,
    );
    if (sessionStory !== snapshot) throw Error('对局已重置');
    storyContexts.set(key, data);
    return data;
  } finally {
    clearTimeout(timer);
    storyContextRequests.delete(controller);
  }
}
function initStory() {
  storyPlayer = NightfallStoryPlayer.create({
    video: $('storyMovie'),
    onState: (state) => {
      $('storyMovieOverlay').classList.toggle('hidden', !state.active);
      $('storyMoviePause').textContent = state.paused ? '▶ 继续播放' : 'Ⅱ 暂停序幕';
      $('storyMoviePause').setAttribute('aria-pressed', String(state.paused));
      if (state.active && paused !== state.paused) {
        paused = state.paused;
        releaseWait();
      }
      renderStory();
    },
    onError: (text) => {
      $('storyMovieMessage').textContent = text;
    },
  });
  $('storyChoice').addEventListener('change', () => {
    if (busy) return;
    selectedStoryId = $('storyChoice').value;
    rememberStory();
    renderStory();
  });
  $('storyRefresh').addEventListener('click', () => {
    void refreshStoryLibrary().catch((e) => toast(e.message));
  });
  $('storyMoviePause').addEventListener('click', () => {
    if (!storyIntroActive()) return;
    if (storyPlayer.state().paused) {
      if (narration?.kind === 'rules') stopNarration();
      void storyPlayer.resume();
    } else storyPlayer.pause();
    renderAll();
  });
  $('storyMovieSkip').addEventListener('click', () => storyPlayer.skip());
  $('storyMovieFullscreen').addEventListener('click', () => {
    void toggleFullscreen();
  });
  globalThis.addEventListener?.('focus', () => {
    if (!busy) void refreshStoryLibrary().catch(() => {});
  });
  void refreshStoryLibrary().catch((e) => {
    $('storyHint').textContent = e.message;
  });
}
