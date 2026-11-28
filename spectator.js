'use strict';
let spectatorPrefs = { perspective: 'god', railOpen: true, narratorEnabled: false };
try {
  const p = JSON.parse(localStorage.getItem('nightfall-spectator-v1') || '{}');
  spectatorPrefs = {
    perspective: p.perspective === 'public' ? 'public' : 'god',
    railOpen: p.railOpen !== false,
    narratorEnabled: p.narratorEnabled === true,
  };
} catch {}
let observerEvents = [],
  commentaryQueue = [],
  currentCommentary = null,
  recordTab = 'speeches',
  recordSeat = 'all',
  speechBubble = null,
  bubbleVersion = 0,
  commentaryVersion = 0;
let presentationDelayScale = 1;
let dealState = null,
  sceneMotion = null,
  motionVersion = 0;
let nightFocus = null,
  votePresentation = null,
  wolfPresentation = null,
  observerSequence = 0;
let eyeNight = false,
  nightAwake = [],
  eyeElapsed = 0,
  eyeLastTick = performance.now(),
  eyeWasPaused = false;
const eyeStates = new Map(),
  failedEyePortraits = new Set();
function eyeClock() {
  const now = performance.now();
  if (!eyeWasPaused) eyeElapsed += Math.max(0, now - eyeLastTick);
  eyeLastTick = now;
  eyeWasPaused = paused;
  return eyeElapsed;
}
function resetEyes() {
  eyeNight = false;
  nightAwake = [];
  eyeStates.clear();
  eyeElapsed = 0;
  eyeLastTick = performance.now();
  eyeWasPaused = false;
}
function beginEyeEvent(event) {
  if (event.kind === 'night') {
    eyeNight = true;
    nightAwake = [];
  }
  if (event.kind === 'night-cue') {
    eyeNight = true;
    nightAwake = [...event.actors];
  }
  if (['dawn', 'discussion', 'winner'].includes(event.kind)) {
    eyeNight = false;
    nightAwake = [];
  }
  renderPlayers();
}
function endEyeEvent(event) {
  if (['guard', 'wolf', 'seer', 'save', 'poison', 'witch-idle'].includes(event.kind)) {
    nightAwake = [];
    renderPlayers();
  }
}
function eyesClosed(p) {
  return (
    !p.alive || (eyeNight && (spectatorPrefs.perspective !== 'god' || !nightAwake.includes(p.id)))
  );
}
function eyeVisual(p) {
  const closed = eyesClosed(p),
    now = eyeClock();
  let prior = eyeStates.get(p.id);
  // View switches hide private wake state immediately, without a revealing fade.
  const privateNight = eyeNight && spectatorPrefs.perspective === 'public';
  if (!prior || prior.closed !== closed) {
    prior = { closed, at: !prior || privateNight ? now - 400 : now };
    eyeStates.set(p.id, prior);
  }
  const elapsed = now - prior.at,
    cycle = 4700 + p.id * 317;
  return {
    closed,
    classes:
      elapsed < 360
        ? closed
          ? 'eyes-closing'
          : 'eyes-opening'
        : closed
          ? 'eyes-closed'
          : 'eyes-open',
    style:
      '--eye-progress:-' +
      Math.min(360, elapsed) +
      'ms;--blink-cycle:' +
      cycle +
      'ms;--blink-delay:-' +
      ((now + p.id * 977) % cycle) +
      'ms',
  };
}
function eyeMarkup(p, art = null) {
  const e = eyeVisual(p),
    label = e.closed ? '闭眼' : '睁眼';
  if (art && failedEyePortraits.has(art.id)) return '';
  if (art && !failedEyePortraits.has(art.id))
    return (
      '<img class="portrait-eyelids eye-layer ' +
      e.classes +
      '" style="' +
      e.style +
      '" src="assets/manor/' +
      art.id +
      '-closed.webp" data-eye-portrait="' +
      art.id +
      '" alt="" aria-hidden="true" draggable="false">'
    );
  return (
    '<span class="avatar-eyelids eye-layer ' +
    e.classes +
    '" style="' +
    e.style +
    '" aria-label="' +
    label +
    '"><i></i><i></i><small>闭眼</small></span>'
  );
}
const effects = globalThis.NightfallAudio?.create({
  isSpeaking: () => !!narration && !narration.paused && !narration.loading,
  save: (p) => {
    try {
      localStorage.setItem('nightfall-effects-v1', JSON.stringify(p));
    } catch {}
  },
});
try {
  effects?.configure(JSON.parse(localStorage.getItem('nightfall-effects-v1') || '{}'));
} catch {}
const music = globalThis.NightfallAudio?.createMusic({
  isSpeaking: () => !!narration && !narration.paused && !narration.loading,
  save: (p) => {
    try {
      localStorage.setItem('nightfall-music-v1', JSON.stringify(p));
    } catch {}
  },
});
try {
  music?.configure(JSON.parse(localStorage.getItem('nightfall-music-v1') || '{}'));
} catch {}
const sceneTitles = {
  start: ['✦', '命运已定'],
  night: ['☾', '夜幕降临'],
  dawn: ['☀', '天光初现'],
  discussion: ['❝', '围桌论辩'],
  voting: ['⚖', '公开投票'],
  pk: ['⚔', '平票 · 最后陈述'],
  exile: ['♜', '放逐结算'],
  hunter: ['⌖', '猎人抉择'],
  'hunter-result': ['⌖', '枪声落定'],
  winner: ['♛', '阵营胜利'],
  guard: ['♜', '守卫 · 守护'],
  wolf: ['☾', '狼人 · 袭击'],
  seer: ['◉', '预言家 · 查验'],
  save: ['✦', '女巫 · 解药'],
  poison: ['⚗', '女巫 · 毒药'],
  'witch-idle': ['⚗', '女巫 · 收起药瓶'],
};
function clearSceneMotion() {
  motionVersion++;
  sceneMotion = null;
  const focused = nightFocus;
  nightFocus = null;
  $('sceneEffect').classList.add('hidden');
  $('sceneEffect').innerHTML = '';
  if (focused) renderPlayers();
}
function positionRevealCards() {
  const node = $('sceneEffect');
  if (
    sceneMotion?.kind !== 'reveal' ||
    typeof document.querySelector !== 'function' ||
    !node.getBoundingClientRect
  )
    return;
  const host = node.getBoundingClientRect();
  game.players.forEach((p) => {
    const portrait = typeof portraitSeatFace === 'function' && portraitSeatFace(p.id),
      anchor = portrait || document.querySelector('[data-player="' + p.id + '"] .player-avatar'),
      face = anchor?.getBoundingClientRect(),
      card = node.querySelector('[data-reveal="' + p.id + '"]');
    if (!face || !card) return;
    // Portrait rows reveal over the avatar; the round table retains its scrollable seat positions.
    if (portrait)
      card.style.maxHeight =
        Math.max(1, portrait.closest('.portrait-seat').getBoundingClientRect().height - 2) + 'px';
    const w = card.offsetWidth,
      h = card.offsetHeight,
      x = face.left + face.width / 2 - host.left,
      y = (portrait ? face.top + face.height / 2 : face.bottom + 14) - host.top;
    card.style.left =
      (portrait ? Math.max(w / 2 + 2, Math.min(host.width - w / 2 - 2, x)) : x) + 'px';
    card.style.top =
      (portrait ? Math.max(h / 2 + 2, Math.min(host.height - h / 2 - 2, y)) : y) + 'px';
  });
}
function renderSceneMotion() {
  const node = $('sceneEffect');
  if (!sceneMotion) {
    node.classList.add('hidden');
    return;
  }
  node.classList.remove('hidden');
  node.setAttribute('data-effect', sceneMotion.kind);
  if (sceneMotion.kind === 'deal') {
    // eslint-disable-next-line no-unsanitized/property -- Dynamic speech is escaped and the remaining markup values are game enums or numeric state.
    node.innerHTML =
      '<div class="deal-label">命运洗牌中 <small>身份随机分配 · 外观与身份无关</small></div>' +
      game.players
        .map((p, i) => {
          const at = Manor.layout(size)[i];
          return (
            '<span class="deal-card" style="--card-x:' +
            at.x +
            '%;--card-y:' +
            (at.y + 20) +
            '%;--delay:' +
            i * 110 +
            'ms;--tilt:' +
            (i % 2 ? 8 : -8) +
            'deg"><i>✦</i><b>' +
            (i + 1) +
            '</b></span>'
          );
        })
        .join('');
    // Use rendered seats so dealing also aligns with a letterboxed or scrolled table.
    if (typeof document.querySelector === 'function' && node.getBoundingClientRect) {
      const host = node.getBoundingClientRect();
      game.players.forEach((p, i) => {
        const seat =
            (typeof portraitSeatFace === 'function' && portraitSeatFace(p.id)) ||
            document.querySelector('[data-player="' + p.id + '"] .player-avatar'),
          card = node.querySelectorAll('.deal-card')[i];
        if (!seat || !card) return;
        const r = seat.getBoundingClientRect();
        card.style.setProperty('--card-x', r.left + r.width / 2 - host.left + 'px');
        card.style.setProperty('--card-y', r.bottom - host.top + 'px');
      });
    }
  } else if (sceneMotion.kind === 'reveal') {
    // eslint-disable-next-line no-unsanitized/property -- Dynamic speech is escaped and the remaining markup values are game enums or numeric state.
    node.innerHTML =
      '<div class="deal-label">' +
      (spectatorPrefs.perspective === 'god' ? '命运揭晓' : '身份已分配') +
      '<small>人物形象与身份无关</small></div>' +
      game.players
        .map(
          (p) =>
            '<div class="reveal-card ' +
            (p.id < dealState.revealed ? 'flipped' : '') +
            '" data-reveal="' +
            p.id +
            '"><div class="reveal-inner"><span class="reveal-back">✦<small>' +
            (p.id + 1) +
            ' 号</small></span><span class="reveal-front">' +
            visibleRoleBadge(p, spectatorPrefs.perspective === 'god', true) +
            '</span></div></div>',
        )
        .join('');
    positionRevealCards();
  } else {
    const [icon, title] = sceneTitles[sceneMotion.kind],
      win = sceneMotion.kind === 'winner';
    node.setAttribute('data-faction', win ? (game.winner === '狼人' ? 'wolf' : 'good') : '');
    // eslint-disable-next-line no-unsanitized/property -- Dynamic speech is escaped and the remaining markup values are game enums or numeric state.
    node.innerHTML =
      '<div class="phase-atmosphere"></div>' +
      (win
        ? '<div class="victory-particles">' +
          Array.from(
            { length: 36 },
            (_, i) =>
              '<i style="--x:' +
              ((i * 47) % 100) +
              '%;--d:' +
              (i % 9) * 0.17 +
              's;--r:' +
              i * 37 +
              'deg"></i>',
          ).join('') +
          '</div>'
        : '') +
      '<div class="phase-cinematic"><span>' +
      esc(icon) +
      '</span><div><small>第 ' +
      esc(sceneMotion.event.round) +
      ' 轮</small><strong>' +
      (win ? esc(game.winner) + '阵营胜利' : esc(title)) +
      '</strong><p>' +
      esc(win || sceneMotion.event.private ? observerText(sceneMotion.event) : '') +
      '</p></div></div>';
  }
}
async function animateDeal(token) {
  const version = ++motionVersion;
  dealState = { dealt: 0, revealed: 0, stage: 'flight' };
  sceneMotion = { kind: 'deal' };
  renderAll();
  renderSceneMotion();
  effects?.play('shuffle', epoch + ':shuffle');
  const valid = () => version === motionVersion;
  const ok = await presentationWait(size === 6 ? 1600 : 2200, token, valid, false, (progress) => {
    if (valid() && dealState) {
      const count = Math.min(size, Math.floor(progress * size));
      if (count > dealState.dealt) effects?.play('deal', epoch + ':deal:' + count);
      dealState.dealt = count;
    }
  });
  if (token !== epoch) return false;
  dealState = null;
  if (valid()) clearSceneMotion();
  renderAll();
  return ok || token === epoch;
}
async function revealDeal(token) {
  const version = ++motionVersion;
  dealState = { dealt: size, revealed: 0, stage: 'reveal' };
  sceneMotion = { kind: 'reveal' };
  renderAll();
  renderSceneMotion();
  for (let i = 0; i < size; i++) {
    if (!(await presentationWait(i ? 130 : 100, token, () => version === motionVersion)))
      return false;
    dealState.revealed = i + 1;
    renderPlayers();
    const card =
      typeof document.querySelector === 'function'
        ? $('sceneEffect').querySelector('[data-reveal="' + i + '"]')
        : null;
    card?.classList.add('flipped');
    effects?.play('flip', epoch + ':flip:' + i);
  }
  if (!(await presentationWait(850, token, () => version === motionVersion))) return false;
  dealState = null;
  clearSceneMotion();
  renderAll();
  return true;
}
function animateEvent(event, token) {
  if (!sceneTitles[event.kind] || (event.private && spectatorPrefs.perspective !== 'god'))
    return Promise.resolve();
  const version = ++motionVersion;
  nightFocus = event.private && event.actors ? event : null;
  sceneMotion = { kind: event.kind, event };
  renderPlayers();
  renderSceneMotion();
  const cue = {
    night: 'night',
    wolf: 'wolf',
    guard: 'guard',
    seer: 'seer',
    save: 'save',
    poison: 'poison',
    voting: 'vote',
    exile: 'exile',
    'hunter-result': 'hunter',
    winner: game.winner === '狼人' ? 'wolf-win' : 'good-win',
  }[event.kind];
  if (cue && !(event.kind === 'hunter-result' && !/猎人带走/.test(event.publicText || '')))
    effects?.play(cue, event.id || epoch + ':' + event.round + ':' + event.kind);
  return presentationWait(
    event.kind === 'winner' ? 5000 : 1800,
    token,
    () => version === motionVersion,
  ).then(() => {
    if (version === motionVersion) clearSceneMotion();
  });
}
function visibleObserverEvents() {
  return observerEvents.filter((e) => spectatorPrefs.perspective === 'god' || !e.private);
}
function eliminationInfo(p) {
  if (p.alive) return null;
  const visible = spectatorPrefs.perspective === 'god' || game.phase === 'ended';
  const causes = {
    wolf: { label: '遭狼袭', icon: '≋', kind: 'wolf' },
    poison: { label: '中毒出局', icon: '⚗', kind: 'poison' },
    vote: { label: '投票放逐', icon: '⚖', kind: 'vote' },
    hunter: { label: '猎人击中', icon: '⌖', kind: 'hunter' },
  };
  if (!visible && ['wolf', 'poison'].includes(p.cause))
    return { label: '夜间出局', icon: '☾', kind: 'night' };
  return causes[p.cause] || { label: '已出局', icon: '◇', kind: 'unknown' };
}
function seatEffectClass(p) {
  return (
    (!p.alive ? ' eliminated-' + eliminationInfo(p).kind + ' ' : '') +
    (game.phase === 'ended' && (p.role === '狼人') === (game.winner === '狼人')
      ? ' winner-seat '
      : '') +
    (spectatorPrefs.perspective === 'god' && nightFocus
      ? (nightFocus.actors.includes(p.id) ? ' action-actor ' : '') +
        (nightFocus.target === p.id ? ' action-target action-' + nightFocus.kind + ' ' : '')
      : '') +
    (dealState?.stage === 'reveal' && p.id < dealState.revealed ? ' identity-revealed ' : '')
  );
}
function seatDecorations(p) {
  const eliminated = eliminationInfo(p),
    mark = eliminated
      ? '<span class="elimination-mark"><i aria-hidden="true">' +
        eliminated.icon +
        '</i>' +
        eliminated.label +
        '</span>'
      : '';
  const choice =
    game.phase === 'night' &&
    spectatorPrefs.perspective === 'god' &&
    wolfPresentation?.round === game.round
      ? wolfPresentation.states[p.id]
      : null;
  if (choice) {
    const label =
      choice.status === 'choosing'
        ? '正在选刀'
        : choice.status === 'selected'
          ? '提议袭击 ' + (choice.target + 1) + ' 号'
          : choice.status === 'abstained'
            ? '放弃袭击'
            : '未形成有效选择';
    return (
      '<div class="seat-overlay" role="status" aria-label="' +
      (p.id + 1) +
      ' 号狼人选刀状态">' +
      mark +
      '<span class="vote-hint wolf-choice vote-' +
      (choice.status === 'choosing' ? 'choosing' : 'revealed') +
      '">' +
      label +
      '</span></div>'
    );
  }
  const status = votePresentation?.states[p.id];
  if (!status) return mark ? '<div class="seat-overlay">' + mark + '</div>' : '';
  const label =
    status === 'failed'
      ? '投票失败，待重试'
      : status === 'cancelled'
        ? '已停止，待重试'
        : status === 'choosing'
          ? '正在投票'
          : status === 'submitted'
            ? '已投票'
            : status === 'excluded'
              ? '本轮不投票'
              : status === 'revealed'
                ? votePresentation.votes[p.id] == null
                  ? '弃票'
                  : '投给 ' + (votePresentation.votes[p.id] + 1) + ' 号'
                : '待投票';
  const count = votePresentation.counts[p.id] || 0;
  return (
    '<div class="seat-overlay" role="status" aria-label="' +
    (p.id + 1) +
    ' 号玩家投票状态">' +
    mark +
    '<span class="vote-hint vote-' +
    status +
    '">' +
    label +
    '</span>' +
    (count ? '<span class="vote-count">收到 ' + count + ' 票</span>' : '') +
    '</div>'
  );
}
function positionSeatOverlays() {
  if (typeof document.querySelector !== 'function') return;
  const scene = $('tableScene').getBoundingClientRect();
  const players = Array.from(document.querySelectorAll('[data-player]'));
  const faces = players
      .map((p) => p.querySelector('.player-avatar')?.getBoundingClientRect())
      .filter(Boolean),
    placed = [];
  const overlap = (a, b) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  for (const player of players) {
    const overlay = player.querySelector('.seat-overlay'),
      avatar = player.querySelector('.player-avatar');
    if (!overlay || !avatar) continue;
    const face = avatar.getBoundingClientRect(),
      root = player.getBoundingClientRect();
    const bounds = overlay.getBoundingClientRect(),
      w = bounds.width,
      h = bounds.height;
    let best = null;
    // Stay at the upper-right corner, lifting above the face on dense tables.
    for (const dx of [4, 12, 24])
      for (const dy of [-8, -h - 4, -h - 20, -h - 36, -h - 52]) {
        const left = Math.max(scene.left + 6, Math.min(face.right + dx, scene.right - w - 6));
        const top = Math.max(scene.top + 6, Math.min(face.top + dy, scene.bottom - h - 6));
        const box = { left, top, right: left + w, bottom: top + h };
        const collision =
          faces.reduce((n, r) => n + overlap(box, r), 0) +
          placed.reduce((n, r) => n + overlap(box, r), 0);
        const score = collision * 1000 + Math.hypot(left - face.right - 4, top - face.top + 8);
        if (!best || score < best.score) best = { ...box, score };
      }
    placed.push(best);
    overlay.style.left = best.left - root.left - player.clientLeft + 'px';
    overlay.style.top = best.top - root.top - player.clientTop + 'px';
  }
}
const recordScroll = {
  speeches: { top: 0, bottom: true, seen: 0 },
  activity: { top: 0, bottom: true, seen: 0 },
  commentary: { top: 0, bottom: true, seen: 0 },
};
function saveSpectatorPrefs() {
  try {
    localStorage.setItem('nightfall-spectator-v1', JSON.stringify(spectatorPrefs));
  } catch {}
}
function publicNight() {
  return spectatorPrefs.perspective === 'public' && ['night', 'hunter'].includes(game.phase);
}
function observerText(event) {
  return NightfallObserver.project(event, spectatorPrefs.perspective);
}
function addObserver(event, queue = true) {
  event = { ...event, id: epoch + ':event:' + ++observerSequence, time: stamp() };
  observerEvents.push(event);
  if (queue) commentaryQueue.push(event);
  renderSpectator();
  return event;
}
function clearBubble() {
  bubbleVersion++;
  speechBubble = null;
  wakePresentation();
  renderPlayers();
}
function renderBubble(reposition = true) {
  const node = $('speechBubble'),
    line = speechBubble;
  node.classList.toggle('hidden', !line);
  if (!line) return;
  node.setAttribute('aria-label', line.id + 1 + ' 号 ' + name(line.id) + '的发言');
  // eslint-disable-next-line no-unsanitized/property -- Dynamic speech is escaped and the remaining markup values are game enums or numeric state.
  node.innerHTML = '<p>' + esc(line.caption || '…') + '</p>';
  if (reposition) positionBubble();
}
function applyCaption(line, frame) {
  if (line !== speechBubble) return;
  if (line.caption === frame.text && line.chunkIndex === frame.index) return;
  const moved = line.chunkIndex !== frame.index;
  line.caption = frame.text;
  line.chunkIndex = frame.index;
  renderBubble(moved);
  if (typeof renderPortraitCaption === 'function') renderPortraitCaption();
}
function updateSpeechCaption(current, progress = null, charIndex = null) {
  const line = speechBubble;
  if (
    narration !== current ||
    !line ||
    line.id !== current.seat ||
    line.text !== (current.text || current.utterance?.text) ||
    current.paused ||
    (paused && line.kind !== 'replay')
  )
    return;
  if (charIndex != null) current.captionBoundary = true;
  else if (current.captionBoundary) return;
  applyCaption(line, NightfallObserver.captionFrame(line.segments, progress ?? 0, charIndex));
}
function startCaptionClock(current) {
  if (!['dialogue', 'replay'].includes(current.kind)) return;
  clearTimeout(current.captionTimer);
  current.captionTick = performance.now();
  const tick = () => {
    if (narration !== current) return;
    const now = performance.now(),
      waiting = current.paused || (paused && current.kind !== 'replay') || !current.playing;
    if (!waiting) {
      current.captionElapsed =
        (current.captionElapsed || 0) + Math.max(0, now - current.captionTick);
      const audio = current.audio,
        duration = Number(audio?.duration);
      const estimated = Math.max(
        1,
        Array.from(current.text || current.utterance?.text || '').length /
          (5 * (current.speed || 1)),
      );
      updateSpeechCaption(
        current,
        audio && Number.isFinite(duration) && duration > 0
          ? audio.currentTime / duration
          : Math.min(0.98, current.captionElapsed / 1000 / estimated),
      );
    }
    current.captionTick = now;
    current.captionTimer = setTimeout(tick, 120);
  };
  tick();
}
function positionBubble() {
  if (!speechBubble || typeof document.querySelector !== 'function') return;
  const player = document.querySelector('[data-player="' + speechBubble.id + '"]'),
    bubble = $('speechBubble'),
    viewport = $('tableViewport');
  if (!player?.getBoundingClientRect || !viewport?.getBoundingClientRect) return;
  const face =
      player.querySelector('.player-avatar')?.getBoundingClientRect() ||
      player.getBoundingClientRect(),
    v = viewport.getBoundingClientRect(),
    host = $('tableStage').getBoundingClientRect();
  const art = player.querySelector('.manor-portrait'),
    anchor = art && Manor.mouths[art.dataset.portrait];
  let mx = face.left + face.width * 0.5,
    my = face.top + face.height * 0.75;
  if (anchor) {
    const r = art.getBoundingClientRect();
    const scale = Math.min(r.width / art.naturalWidth, r.height / art.naturalHeight);
    if (Number.isFinite(scale) && scale > 0) {
      const w = art.naturalWidth * scale,
        h = art.naturalHeight * scale;
      mx = r.left + (r.width - w) / 2 + w * anchor.x;
      my = r.bottom - h + h * anchor.y;
    }
  }
  const boxes = Array.from(
    document.querySelectorAll(
      '.player-avatar,.manor-nameplate,.seat-overlay,.table-scene:not(.manor-six):not(.manor-twelve) .player-role',
    ),
  ).map((x) => x.getBoundingClientRect());
  const overlap = (x, y, w, h) =>
    boxes.reduce(
      (n, b) =>
        n +
        Math.max(0, Math.min(x + w, b.right) - Math.max(x, b.left)) *
          Math.max(0, Math.min(y + h, b.bottom) - Math.max(y, b.top)),
      0,
    );
  let best = null;
  const consider = (left, top, width, h) => {
    const collision = overlap(left, top, width, h),
      score =
        collision * 1000 +
        Math.hypot(left + width / 2 - mx, top + h / 2 - my) +
        Math.abs(176 - width) * 0.5;
    if (!best || score < best.score) best = { left, top, width, h, score, collision };
  };
  for (const width of [176, 156, 136].map((w) => Math.min(w, v.width - 20))) {
    bubble.style.width = width + 'px';
    const h = bubble.offsetHeight || 60;
    for (const side of ['left', 'right'])
      for (const extra of [0, 24, 48, 80])
        for (const dy of [-h * 0.35, -h - 8, 10, -h - 40, 40, 72, -h - 80, 112, -h - 120, 152]) {
          const gap =
            Math.max(22, side === 'left' ? mx - face.left + 8 : face.right - mx + 8) + extra;
          const rawX = side === 'left' ? mx - width - gap : mx + gap,
            left = Math.max(v.left + 8, Math.min(rawX, v.right - width - 8)),
            top = Math.max(v.top + 8, Math.min(my + dy, v.bottom - h - 8));
          consider(left, top, width, h);
        }
  }
  // Dense twelve-seat tables may need a diagonal position in the open table center.
  if (best.collision > 0)
    for (const width of [176, 156, 136].map((w) => Math.min(w, v.width - 20))) {
      bubble.style.width = width + 'px';
      const h = bubble.offsetHeight || 60;
      for (let top = v.top + 8; top <= v.bottom - h - 8; top += 12)
        for (let left = v.left + 8; left <= v.right - width - 8; left += 12)
          consider(left, top, width, h);
    }
  bubble.style.width = best.width + 'px';
  bubble.style.left = best.left - host.left + 'px';
  bubble.style.top = best.top - host.top + 'px';
  const side =
    mx < best.left
      ? 'left'
      : mx > best.left + best.width
        ? 'right'
        : my < best.top
          ? 'top'
          : 'bottom';
  bubble.dataset.tail = side;
  bubble.style.setProperty(
    '--tail-x',
    Math.max(10, Math.min(best.width - 10, mx - best.left)) + 'px',
  );
  bubble.style.setProperty('--tail-y', Math.max(10, Math.min(best.h - 10, my - best.top)) + 'px');
}
function focusSpeakingSeat(id) {
  if (typeof document.querySelector !== 'function') return;
  const player = document.querySelector('[data-player="' + id + '"]'),
    viewport = $('tableViewport');
  if (player?.getBoundingClientRect && viewport?.getBoundingClientRect) {
    const p = player.getBoundingClientRect(),
      v = viewport.getBoundingClientRect();
    if (p.left < v.left || p.right > v.right)
      viewport.scrollLeft += p.left + p.width / 2 - v.left - v.width / 2;
    // In short fullscreen windows the scene can scroll vertically too. Keep the
    // speaker's face and nameplate visible without moving the fixed toolbar.
    if (viewport.scrollHeight > viewport.clientHeight) {
      const face = player.querySelector('.player-avatar')?.getBoundingClientRect() || p,
        plate = player.querySelector('.manor-nameplate')?.getBoundingClientRect() || face;
      const top = Math.min(face.top, plate.top),
        bottom = Math.max(face.bottom, plate.bottom);
      if (top < v.top + 8 || bottom > v.bottom - 8)
        viewport.scrollTop +=
          bottom - top <= v.height - 16
            ? top < v.top + 8
              ? top - v.top - 8
              : bottom - v.bottom + 8
            : face.top + face.height / 2 - v.top - v.height / 2;
    }
    if (
      globalThis.innerWidth <= 1100 &&
      typeof viewport.scrollIntoView === 'function' &&
      (p.top < 70 || p.bottom > globalThis.innerHeight - 64)
    )
      viewport.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  positionBubble();
}
const presentationWaiters = new Set();
function wakePresentation() {
  for (const wake of [...presentationWaiters]) wake();
}
async function presentationWait(
  ms,
  token = epoch,
  valid = () => true,
  ignorePause = false,
  onProgress = null,
) {
  let remaining = ms * presentationDelayScale;
  const total = remaining;
  onProgress?.(0);
  while (remaining > 0 && token === epoch && valid()) {
    const waiting = paused && !ignorePause,
      chunk = waiting ? 100 : Math.min(remaining, 100),
      start = performance.now();
    await new Promise((resolve) => {
      let timer;
      const wake = () => {
        clearTimeout(timer);
        presentationWaiters.delete(wake);
        resolve();
      };
      presentationWaiters.add(wake);
      timer = setTimeout(wake, chunk);
    });
    if (!waiting && (!paused || ignorePause)) {
      remaining -= Math.min(chunk, Math.max(0, performance.now() - start));
      onProgress?.(1 - remaining / total);
    }
  }
  return token === epoch && valid();
}
async function showPlayerSpeech(line, { kind = 'dialogue', token = epoch } = {}) {
  const version = ++bubbleVersion;
  wakePresentation();
  speechBubble = {
    ...line,
    kind,
    stage: 'speaking',
    segments: NightfallObserver.speechSegments(line.text),
    caption: '',
    chunkIndex: -1,
  };
  renderPlayers();
  focusSpeakingSeat(line.id);
  if (kind === 'dialogue' && typeof portraitMode !== 'undefined' && portraitMode) {
    speechBubble.stage = 'entrance';
    renderPlayers();
    // Reuse the cancellable, pause-aware subtitle clock. Leaving portrait skips
    // the remaining entrance without restarting any speech or request.
    await presentationWait(500, token, () => version === bubbleVersion && portraitMode);
    if (version !== bubbleVersion || token !== epoch) return;
    if (!(await waitForTurn(token, 0)) || version !== bubbleVersion || token !== epoch) return;
    speechBubble.stage = 'speaking';
    renderPlayers();
  }
  const ok =
    voiceEnabled || kind === 'replay' ? await speakText(line.text, { kind, seat: line.id }) : false;
  if (version !== bubbleVersion || token !== epoch) return;
  if (kind !== 'replay' && !(await waitForTurn(token, 0))) return;
  if (version !== bubbleVersion || token !== epoch) return;
  if (ok) {
    speechBubble.stage = 'tail';
    applyCaption(speechBubble, NightfallObserver.captionFrame(speechBubble.segments, 1));
    renderPlayers();
    await presentationWait(250, token, () => version === bubbleVersion, kind === 'replay');
  } else {
    const fallbackTranscriptId =
      kind !== 'replay' && typeof recordingTranscriptBegin === 'function'
        ? recordingTranscriptBegin({
            kind,
            seat: line.id,
            name: name(line.id),
            text: line.text,
            speechStatus: 'fallback-reading',
          })
        : null;
    speechBubble.stage = 'reading';
    renderPlayers();
    await presentationWait(
      NightfallObserver.readingTime(line.text),
      token,
      () => version === bubbleVersion,
      kind === 'replay',
      (progress) => {
        if (version === bubbleVersion && token === epoch && speechBubble)
          applyCaption(
            speechBubble,
            NightfallObserver.captionFrame(speechBubble.segments, progress),
          );
      },
    );
    if (fallbackTranscriptId && typeof recordingTranscriptEnd === 'function')
      recordingTranscriptEnd(fallbackTranscriptId, 'fallback-reading');
  }
  if (version === bubbleVersion && token === epoch) {
    speechBubble = null;
    renderPlayers();
  }
}
async function flushCommentary(token) {
  while (commentaryQueue.length && token === epoch) {
    if (!(await waitForTurn(token, 0)) || token !== epoch) return;
    const event = commentaryQueue.shift();
    beginEyeEvent(event);
    if (event.private && spectatorPrefs.perspective !== 'god') {
      endEyeEvent(event);
      continue;
    }
    clearBubble();
    currentCommentary = event;
    renderSpectator();
    const animation = animateEvent(event, token);
    const version = commentaryVersion;
    const text = observerText(event);
    const narratorRequested = spectatorPrefs.narratorEnabled;
    const silentCommentaryId =
      !narratorRequested && typeof recordingTranscriptBegin === 'function'
        ? recordingTranscriptBegin({ kind: 'commentary', text, speechStatus: 'fallback-reading' })
        : null;
    const ok = narratorRequested
      ? await speakText(text, {
          kind: 'commentary',
          profile: {
            voiceProvider: 'neural',
            voice: 'zh-CN-YunyangNeural',
            voiceStyle: 'calm',
            voiceSpeed: 1,
          },
        })
      : false;
    await animation;
    if (token !== epoch) {
      if (silentCommentaryId && typeof recordingTranscriptEnd === 'function')
        recordingTranscriptEnd(silentCommentaryId, 'interrupted');
      return;
    }
    if (!(await waitForTurn(token, 0)) || token !== epoch) {
      if (silentCommentaryId && typeof recordingTranscriptEnd === 'function')
        recordingTranscriptEnd(silentCommentaryId, 'interrupted');
      return;
    }
    const duration = ok ? 120 : narratorRequested ? NightfallObserver.readingTime(text) : 150;
    const fallbackCommentaryId =
      !ok && narratorRequested && typeof recordingTranscriptBegin === 'function'
        ? recordingTranscriptBegin({ kind: 'commentary', text, speechStatus: 'fallback-reading' })
        : silentCommentaryId;
    await presentationWait(duration, token, () => version === commentaryVersion);
    if (fallbackCommentaryId && typeof recordingTranscriptEnd === 'function')
      recordingTranscriptEnd(
        fallbackCommentaryId,
        token === epoch ? 'fallback-reading' : 'interrupted',
      );
    if (token === epoch) endEyeEvent(event);
  }
}
function setPerspective(value) {
  spectatorPrefs.perspective = value === 'public' ? 'public' : 'god';
  commentaryVersion++;
  wakePresentation();
  if (narration?.kind === 'commentary') stopNarration();
  effects?.stop();
  nightFocus = null;
  if (currentCommentary?.private) currentCommentary = null;
  if (!['deal', 'reveal'].includes(sceneMotion?.kind)) clearSceneMotion();
  else renderSceneMotion();
  saveSpectatorPrefs();
  renderAll();
}
function renderSpectator() {
  $('perspectiveInput').value = spectatorPrefs.perspective;
  $('narratorBtn').textContent = '♫ 旁白：' + (spectatorPrefs.narratorEnabled ? '开' : '关');
  $('narratorBtn').setAttribute('aria-pressed', String(spectatorPrefs.narratorEnabled));
  $('commentaryText').textContent = currentCommentary
    ? observerText(currentCommentary)
    : game.phase === 'lobby'
      ? '点击开始，旁白将带你了解对局。'
      : '正在按规则推进对局。';
  if ($('fullscreenCaption')) $('fullscreenCaption').textContent = $('commentaryText').textContent;
  $('perspectiveLabel').textContent =
    spectatorPrefs.perspective === 'god'
      ? '上帝视角 · 可见身份与已结算行动'
      : '普通观战 · 隐藏夜间秘密';
  document.body.classList.toggle('rail-collapsed', !spectatorPrefs.railOpen);
  $('railToggle').textContent = spectatorPrefs.railOpen ? '收起记录' : '展开记录';
  $('mobileRecordToggle').textContent = spectatorPrefs.railOpen ? '收起记录 ↓' : '查看观战记录 ↑';
  $('mobileRecordToggle').setAttribute('aria-expanded', String(spectatorPrefs.railOpen));
  $('railToggle').setAttribute('aria-expanded', String(spectatorPrefs.railOpen));
  $('spectatorRail').classList.toggle('collapsed', !spectatorPrefs.railOpen);
  $('observerRail').classList.toggle('hidden', !spectatorPrefs.railOpen);
  // eslint-disable-next-line no-unsanitized/property -- Dynamic speech is escaped and the remaining markup values are game enums or numeric state.
  $('recordSeat').innerHTML =
    '<option value="all">全部玩家</option>' +
    game.players
      .map(
        (p) =>
          '<option value="' +
          esc(p.id) +
          '">' +
          esc(p.id + 1) +
          ' 号 · ' +
          esc(name(p.id)) +
          '</option>',
      )
      .join('');
  $('recordSeat').value = recordSeat;
  // eslint-disable-next-line no-unsanitized/property -- Dynamic speech is escaped and the remaining markup values are game enums or numeric state.
  $('commentaryList').innerHTML =
    visibleObserverEvents()
      .map(
        (e) =>
          '<article class="record-entry narrator-record"><div><b>旁白</b><small>第 ' +
          esc(e.round) +
          ' 轮 · ' +
          esc(e.time) +
          '</small></div><p>' +
          esc(observerText(e)) +
          '</p></article>',
      )
      .join('') || '<p class="record-empty">开局后，这里将记录关键节点的讲解。</p>';
  $('mobileRecordToggle').classList.toggle('hidden', view !== 'table');
  renderBubble();
  syncRecordScroll();
  if (typeof renderPortrait === 'function') renderPortrait();
}
function recordCount(tab = 'speeches') {
  return tab === 'speeches'
    ? filteredSpeeches().length
    : tab === 'activity'
      ? feed.length
      : visibleObserverEvents().length;
}
function filteredSpeeches() {
  return transcript.filter((l) => recordSeat === 'all' || l.id === Number(recordSeat));
}
const recordPanels = {
  speeches: ['recordsViewport', 'newRecordsBtn'],
  activity: ['activityViewport', 'newActivityBtn'],
  commentary: ['commentaryViewport', 'newCommentaryBtn'],
};
function syncRecordScroll() {
  for (const [tab, [viewport, button]] of Object.entries(recordPanels)) {
    const box = $(viewport),
      state = recordScroll[tab];
    if (spectatorPrefs.railOpen) {
      if (state.bottom) {
        box.scrollTop = box.scrollHeight || 0;
        state.seen = recordCount(tab);
      } else box.scrollTop = state.top;
    }
    const fresh = Math.max(0, recordCount(tab) - state.seen);
    $(button).classList.toggle('hidden', !fresh);
    $(button).textContent = fresh + ' 条新记录 · 回到最新';
  }
}
function jumpToLatest(tab = 'speeches') {
  const s = recordScroll[tab];
  s.bottom = true;
  s.seen = recordCount(tab);
  syncRecordScroll();
}
function spectatorExport() {
  return {
    perspective: spectatorPrefs.perspective,
    mode: BOARDS[size].title,
    round: game.round,
    phase:
      game.phase === 'hunter' && spectatorPrefs.perspective === 'public'
        ? 'settlement'
        : game.phase,
    winner: game.winner,
    log: game.logs
      .filter((l) => !l.private || spectatorPrefs.perspective === 'god')
      .map((l) => l.text),
    speeches: transcript.map((t) => ({ ...t, name: name(t.id) })),
    commentary: visibleObserverEvents().map((e) => ({
      round: e.round,
      time: e.time,
      text: observerText(e),
    })),
    ...(spectatorPrefs.perspective === 'god' || game.phase === 'ended'
      ? { roles: game.players.map((p) => ({ seat: p.id + 1, name: name(p.id), role: p.role })) }
      : {}),
  };
}
function resetSpectator() {
  music?.stop();
  resetEyes();
  effects?.reset();
  nightFocus = null;
  votePresentation = null;
  wolfPresentation = null;
  observerSequence = 0;
  bubbleVersion++;
  commentaryVersion++;
  clearSceneMotion();
  dealState = null;
  document.body.classList.remove('presentation-paused');
  wakePresentation();
  speechBubble = null;
  observerEvents = [];
  commentaryQueue = [];
  currentCommentary = null;
  recordSeat = 'all';
  for (const s of Object.values(recordScroll)) Object.assign(s, { top: 0, bottom: true, seen: 0 });
}
function initSpectator() {
  $('perspectiveInput').addEventListener('change', () =>
    setPerspective($('perspectiveInput').value),
  );
  $('narratorBtn').addEventListener('click', () => {
    spectatorPrefs.narratorEnabled = !spectatorPrefs.narratorEnabled;
    if (!spectatorPrefs.narratorEnabled && narration?.kind === 'commentary') stopNarration();
    saveSpectatorPrefs();
    renderSpectator();
  });
  const toggleRail = () => {
    spectatorPrefs.railOpen = !spectatorPrefs.railOpen;
    saveSpectatorPrefs();
    renderSpectator();
    positionBubble();
  };
  for (const id of ['railToggle', 'railClose', 'mobileRecordToggle'])
    $(id).addEventListener('click', toggleRail);
  $('recordSeat').addEventListener('change', () => {
    recordSeat = $('recordSeat').value;
    Object.assign(recordScroll.speeches, { top: 0, bottom: true, seen: 0 });
    renderTranscript();
    renderSpectator();
  });
  for (const [tab, [viewport, button]] of Object.entries(recordPanels)) {
    $(viewport).addEventListener('scroll', () => {
      if (!spectatorPrefs.railOpen) return;
      const b = $(viewport),
        s = recordScroll[tab];
      s.top = b.scrollTop;
      s.bottom = b.scrollHeight - b.scrollTop - b.clientHeight < 36;
      if (s.bottom) s.seen = recordCount(tab);
      $(button).classList.toggle('hidden', s.bottom || recordCount(tab) <= s.seen);
    });
    $(button).addEventListener('click', () => jumpToLatest(tab));
  }
  $('recordsViewport').addEventListener('click', (e) => {
    const button = e.target.closest('[data-record-replay]');
    if (button) void replaySpeech(Number(button.dataset.recordReplay), true);
  });
  $('tableViewport').addEventListener('scroll', () => {
    positionBubble();
    positionRevealCards();
  });
  if (typeof ResizeObserver === 'function') {
    const fit = () => {
      const stage = $('tableStage');
      // Measure the actual free row, including wrapped controls and the story bar.
      const width = Math.max(0, stage.clientWidth - 16),
        height = stage.clientHeight;
      stage.style.setProperty(
        '--stage-fit-width',
        Math.floor(
          typeof watchMode !== 'undefined' && watchMode
            ? Math.max(width, size === 12 ? 1050 : 700)
            : Math.min(width, Math.max(640, height * (size === 12 ? 2.35 : 1.6))),
        ) + 'px',
      );
      positionSeatOverlays();
      positionBubble();
      positionRevealCards();
    };
    const resize = new ResizeObserver(fit);
    resize.observe($('tableStage'));
    resize.observe($('tableScene'));
    fit();
  }
}

function renderEffectsControls() {
  const p = effects?.preferences() || { enabled: true, volume: 0.3 };
  $('effectsBtn').textContent = '♪ 音效：' + (p.enabled ? '开' : '关');
  $('effectsBtn').setAttribute('aria-pressed', String(p.enabled));
  $('effectsVolume').value = Math.round(p.volume * 100);
  $('effectsVolumeLabel').textContent = Math.round(p.volume * 100) + '%';
  $('soundBtn').textContent = p.enabled ? '♪' : '♩';
  $('soundBtn').title = p.enabled ? '关闭音效' : '开启音效';
  $('soundBtn').setAttribute('aria-pressed', String(p.enabled));
}
function toggleEffects() {
  effects?.unlock();
  effects?.toggle();
  renderEffectsControls();
}

function renderMusicControls() {
  const p = music?.preferences() || { enabled: true, volume: 0.15 };
  $('musicBtn').textContent = '♫ 音乐：' + (p.enabled ? '开' : '关');
  $('musicBtn').setAttribute('aria-pressed', String(p.enabled));
  $('musicVolume').value = Math.round(p.volume * 100);
  $('musicVolumeLabel').textContent = Math.round(p.volume * 100) + '%';
}
function toggleMusic() {
  music?.unlock();
  music?.toggle();
  if (busy && !(typeof storyIntroActive === 'function' && storyIntroActive())) {
    music?.pause(paused);
    music?.start();
  }
  renderMusicControls();
}
