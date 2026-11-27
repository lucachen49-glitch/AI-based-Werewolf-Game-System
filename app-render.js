'use strict';

function setWatchMode(enabled) {
  if (enabled === watchMode) return;
  const portrait = typeof portraitMode !== 'undefined' && portraitMode;
  if (!portrait) {
    if (enabled) {
      watchRecordBefore = spectatorPrefs.railOpen;
      spectatorPrefs.railOpen = false;
    } else {
      spectatorPrefs.railOpen = watchRecordBefore ?? true;
      watchRecordBefore = null;
      saveSpectatorPrefs();
    }
  }
  watchMode = enabled;
  renderWatchMode();
  renderSpectator();
}

function renderWatchMode() {
  document.body?.classList.toggle('watch-mode', watchMode);
  $('fullscreenBtn').textContent = watchMode ? '⛶ 退出全屏' : '⛶ 全屏观战';
  $('fullscreenBtn').setAttribute('aria-pressed', String(watchMode));
  if ($('storyMovieFullscreen')) {
    $('storyMovieFullscreen').textContent = watchMode ? '⛶ 退出全屏' : '⛶ 全屏观战';
    $('storyMovieFullscreen').setAttribute('aria-pressed', String(watchMode));
  }
}

async function toggleFullscreen() {
  if (fullscreenPending) return;
  fullscreenPending = true;
  $('fullscreenBtn').disabled = true;
  try {
    if (watchMode) {
      setWatchMode(false);
      if (nativeWatch && document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          toast('请按 Esc 退出浏览器全屏');
        }
      }
      nativeWatch = false;
      return;
    }
    setWatchMode(true);
    try {
      if (typeof document.documentElement?.requestFullscreen !== 'function') throw Error();
      await document.documentElement.requestFullscreen();
      nativeWatch = true;
    } catch {
      nativeWatch = false;
      toast('已进入沉浸观战；浏览器不支持全屏，可按 Esc 返回');
    }
  } finally {
    fullscreenPending = false;
    $('fullscreenBtn').disabled = false;
  }
}

function avatarHTML(p) {
  return Avatar.valid(p.avatar) && p.avatar.startsWith('data:image/')
    ? `<img src="${esc(p.avatar)}" alt="${esc(p.name)}的卡通形象">`
    : `<span>${esc(p.avatar)}</span>`;
}

function manorPortrait(profile, seat) {
  const storyPortrait =
    typeof sessionStory !== 'undefined' && (sessionStory?.roomSize || 6) === size
      ? sessionStory?.characters[seat]?.portraitId
      : null;
  const art = Manor.portrait(
    storyPortrait ? { ...profile, manorPortrait: storyPortrait } : profile,
    seat,
    size,
  );
  return art && !failedPortraits.has(art.id) ? art : null;
}

function seatAvatarHTML(profile, seat) {
  const art = manorPortrait(profile, seat);
  return art
    ? '<img src="' +
        Manor.imagePath(art.id, true) +
        '" data-portrait="' +
        art.id +
        '" alt="' +
        esc(profile.name) +
        '的庄园形象">'
    : avatarHTML(profile);
}

function name(id) {
  return (
    (typeof sessionStory !== 'undefined' && (sessionStory?.roomSize || 6) === size
      ? sessionStory?.characters[id]?.name
      : null) ||
    profiles[id]?.name ||
    `${id + 1}号`
  );
}

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3300);
}

function addFeed(icon, text, type = '', publicText = text) {
  feed.push({ icon, text, publicText, type, time: stamp() });
  renderFeed();
  syncRecordScroll();
}

function addSpeech(id, text) {
  text = limitSpeech(text);
  transcript.push({ id, text, time: stamp(), round: game.round, pk: !!game.pk });
  renderTranscript();
  renderSpectator();
  renderPlayers();
}

function syncLogs(night) {
  game.logs.slice(logCursor).forEach((l) => {
    addFeed(l.phase === 'night' ? '☾' : '✦', l.text, 'notice');
    const e = NightfallObserver.commentary(l, /^天亮了/.test(l.text) ? night : null);
    if (e) addObserver(e);
  });
  logCursor = game.logs.length;
}

function renderAll() {
  renderSidebar();
  renderStatus();
  renderPlayers();
  renderAction();
  renderFeed();
  renderTranscript();
  renderAgents();
  renderRules();
  renderSpectator();
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('profileBtn').innerHTML =
    `<span class="mini-avatar">${avatarHTML(profiles[0])}</span><span>${esc(name(0))}</span><span class="chevron">⌄</span>`;
}

function renderSidebar() {
  const c = BOARDS[size];
  $('boardTitle').textContent = c.title;
  $('boardNote').textContent = c.note;
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('rolePills').innerHTML = c.roles
    .map((x) => `<span class="role-pill ${x.includes('狼人') ? 'wolf' : ''}">${esc(x)}</span>`)
    .join('');
  document.querySelectorAll('.room-option').forEach((b) => {
    b.classList.toggle('active', +b.dataset.room === size);
    b.setAttribute('aria-selected', String(+b.dataset.room === size));
  });
}

function renderStatus() {
  const remote = profiles.slice(0, size).filter((p) => p.control === 'api').length;
  $('phaseName').textContent = phaseLabels[game.phase];
  $('phaseCard').className = 'phase-card ' + game.phase;
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('roundValue').innerHTML = String(game.round).padStart(2, '0') + ' <small>轮</small>';
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('aliveValue').innerHTML =
    String(game.alive().length).padStart(2, '0') + ' <small>/ ' + size + '</small>';
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('aiValue').innerHTML =
    String(remote).padStart(2, '0') + ' <small>API / ' + size + ' AI</small>';
  const stages = ['lobby', 'night', 'discussion', 'voting'];
  $('progressText').textContent =
    game.phase === 'ended' ? '已结束' : paused ? '已暂停' : '自动推进';
  $('progressBar').style.width =
    (game.phase === 'ended'
      ? 100
      : game.phase === 'hunter'
        ? 85
        : (stages.indexOf(game.phase) + 1) * 20) + '%';
  $('startText').textContent = runError
    ? '重新开局'
    : game.phase === 'ended'
      ? '再来一局'
      : game.phase === 'lobby'
        ? '开始游戏'
        : paused
          ? '对局已暂停'
          : '自动对局中';
  $('startBtn').disabled = busy || !!connectionBatch || connectionTests > 0;
  $('testAllBtn').disabled = busy || !!connectionBatch || connectionTests > 0;
  $('testAllBtn').textContent = connectionBatch
    ? `连接测试 ${connectionBatch.index} / ${connectionBatch.total}${connectionBatch.seat === null ? '' : ` · ${connectionBatch.seat + 1} 号`}`
    : '▷ 批量测试连接';
  $('testConnection').disabled = busy || !!connectionBatch || connectionTests > 0;
  $('saveAgent').disabled = !!connectionBatch || connectionTests > 0;
  $('pauseBtn').disabled = !busy || !!speechFailure || !!apiWaiting || !!voteBatch?.errorPause;
  $('pauseBtn').textContent = paused ? '▶ 继续对局' : 'Ⅱ 暂停';
  $('pauseBtn').setAttribute('aria-pressed', String(paused));
  $('gameKicker').textContent = BOARDS[size].title + ' · 全 AI 自动对局';
  $('centerHint').textContent =
    game.phase === 'lobby'
      ? '一键开始 · 随机发牌'
      : game.phase === 'ended'
        ? game.winner + '阵营获胜'
        : paused
          ? '已暂停 · 等待继续'
          : activeSeat === null
            ? '按规则自动推进'
            : publicNight()
              ? '夜间角色正在秘密行动'
              : activeSeat + 1 + ' 号正在' + (game.phase === 'discussion' ? '发言' : '行动');
  $('autoState').textContent = runError
    ? '对局已停止'
    : game.phase === 'ended'
      ? '本局已结束'
      : busy
        ? paused
          ? '已暂停'
          : '自动进行中'
        : '全 AI 托管';
  renderVoiceControls();
  renderWatchMode();
  if (typeof renderStory === 'function') renderStory();
  if (typeof recordingUpdateControls === 'function') recordingUpdateControls();
}

function visibleRoleBadge(player, reveal, card = false) {
  const role =
    game.phase === 'lobby' ||
    (!card && dealState && (dealState.stage !== 'reveal' || player.id >= dealState.revealed))
      ? '等待发牌'
      : reveal
        ? player.role
        : card
          ? '已分配'
          : '身份未知';
  const styles = {
    狼人: ['wolf', '☾'],
    预言家: ['seer', '◉'],
    女巫: ['witch', '✦'],
    平民: ['villager', '❖'],
    猎人: ['hunter', '⌖'],
    守卫: ['guard', '♜'],
  };
  const [style, icon] = styles[role] || ['unknown', '◇'];
  if (card)
    return (
      '<span class="reveal-identity role-' +
      style +
      '"><span class="reveal-role-icon" aria-hidden="true">' +
      icon +
      '</span><strong class="reveal-role-name">' +
      esc(role) +
      '</strong></span>'
    );
  return (
    '<span class="player-role role-' +
    style +
    '"><span aria-hidden="true">' +
    icon +
    '</span> ' +
    esc(role) +
    '</span>'
  );
}

function renderPlayers() {
  const reveal = spectatorPrefs.perspective === 'god' || game.phase === 'ended';
  $('tableScene').classList.toggle('twelve', size === 12);
  $('tableScene').classList.toggle('manor-six', size === 6);
  $('tableScene').classList.toggle('manor-twelve', size === 12);
  document.body.classList.add('manor-mode');
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('playersGrid').innerHTML = game.players
    .map((p, i) => {
      const profile = { ...profiles[i], name: name(i) },
        active = activeSeat === i && !publicNight(),
        angle = -Math.PI / 2 + (i * 2 * Math.PI) / size,
        radius = size === 12 ? 39 : 36,
        x = 50 + radius * Math.cos(angle),
        y = 50 + radius * Math.sin(angle);
      const current = narration?.seat === i ? narration : null,
        bubble = speechBubble?.id === i ? speechBubble : null;
      const speaking = !!(
          bubble &&
          bubble.stage !== 'tail' &&
          (!current || (!current.loading && (!current.controller || current.playing)))
        ),
        pulsing = speaking && (!paused || bubble.kind === 'replay') && !current?.paused;
      const status = connectionInfo(profile),
        seatStatus =
          publicNight() && game.phase !== 'lobby'
            ? { ...status, className: '', state: 'hidden' }
            : status;
      const state =
        current?.paused || (paused && bubble?.kind === 'dialogue')
          ? '已暂停'
          : current?.loading || (current && current.controller && !current.playing)
            ? '准备声音'
            : speaking
              ? '正在发言'
              : bubble?.stage === 'tail'
                ? '发言结束'
                : !p.alive
                  ? eliminationInfo(p).label
                  : active
                    ? '思考中'
                    : '存活';
      if (size === 6 || size === 12) {
        const at = Manor.layout(size)[i],
          art = manorPortrait(profile, i);
        return (
          '<article class="player manor-player ' +
          (at.front ? 'front-seat ' : 'rear-seat ') +
          seatStatus.className +
          ' ' +
          (p.alive ? '' : 'dead ') +
          (active ? 'acting ' : '') +
          (speaking ? 'speaking ' : '') +
          (pulsing ? 'pulsing' : '') +
          seatEffectClass(p) +
          '" style="--seat-x:' +
          at.x +
          '%;--seat-y:' +
          at.y +
          '%" data-player="' +
          i +
          '" data-connection="' +
          seatStatus.state +
          '" data-eyes="' +
          (eyesClosed(p) ? 'closed' : 'open') +
          '"><button class="manor-art-button" aria-label="' +
          (i + 1) +
          ' 号 ' +
          esc(profile.name) +
          '，查看发言记录">' +
          (art
            ? '<img class="manor-portrait" src="' +
              Manor.imagePath(art.id) +
              '" data-portrait="' +
              art.id +
              '" alt="' +
              esc(profile.name) +
              '坐在庄园皮椅上" draggable="false">' +
              eyeMarkup(p, art) +
              '<span class="player-avatar face-anchor" aria-hidden="true"></span>'
            : '<span class="manor-avatar-fallback player-avatar">' +
              avatarHTML(profile) +
              eyeMarkup(p) +
              '</span>') +
          '</button><div class="manor-nameplate"><button class="seat-profile" aria-label="' +
          (i + 1) +
          ' 号 ' +
          esc(profile.name) +
          '，' +
          state +
          '，查看发言记录"><span class="plate-heading"><span class="seat-number">' +
          (i + 1) +
          '</span><span class="player-name">' +
          esc(profile.name) +
          '</span><span class="life-mark">' +
          (p.alive ? '存活' : '已出局') +
          '</span></span><span class="plate-details">' +
          visibleRoleBadge(p, reveal) +
          '<span class="player-state">' +
          state +
          '</span></span></button>' +
          (publicNight()
            ? '<span class="seat-connection">夜间秘密行动</span>'
            : connectionBadge(profile, true)) +
          '</div>' +
          (size === 12 &&
          !art &&
          Manor.portraits.find((a) => a.id === profile.manorPortrait)?.pending
            ? '<span class="portrait-pending">专属立绘待制作</span>'
            : '') +
          seatDecorations(p) +
          '</article>'
        );
      }
      return (
        '<article class="player ' +
        seatStatus.className +
        ' ' +
        (p.alive ? '' : 'dead ') +
        (active ? 'acting ' : '') +
        (speaking ? 'speaking ' : '') +
        (pulsing ? 'pulsing' : '') +
        seatEffectClass(p) +
        '" style="--seat-x:' +
        x.toFixed(3) +
        '%;--seat-y:' +
        y.toFixed(3) +
        '%" data-player="' +
        i +
        '" data-connection="' +
        seatStatus.state +
        '" data-eyes="' +
        (eyesClosed(p) ? 'closed' : 'open') +
        '"><button class="seat-profile" aria-label="' +
        (i + 1) +
        ' 号 ' +
        esc(profile.name) +
        '，' +
        state +
        '，查看发言记录"><div class="player-avatar-wrap"><div class="player-avatar">' +
        avatarHTML(profile) +
        eyeMarkup(p) +
        '</div><span class="seat-number">' +
        (i + 1) +
        '</span></div><span class="player-name">' +
        esc(profile.name) +
        '</span>' +
        visibleRoleBadge(p, reveal) +
        '<span class="player-state">' +
        state +
        '</span></button>' +
        (publicNight()
          ? '<span class="seat-connection">夜间秘密行动</span>'
          : connectionBadge(profile, true)) +
        seatDecorations(p) +
        '</article>'
      );
    })
    .join('');
  $('seatCount').textContent = game.alive().length + ' / ' + size;
  positionSeatOverlays();
  renderBubble();
  if (typeof renderPortrait === 'function') renderPortrait();
}

function renderFeed() {
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('feedList').innerHTML = feed.length
    ? feed
        .map(
          (f) =>
            `<div class="feed-item ${esc(f.type)}"><div class="feed-avatar">${esc(f.icon)}</div><div class="feed-content"><p>${esc(spectatorPrefs.perspective === 'god' ? f.text : f.publicText)}</p><span class="feed-time">${esc(f.time)}</span></div></div>`,
        )
        .join('')
    : '<div class="empty-feed">风很轻，故事还没开始。</div>';
  $('unreadCount').textContent = feed.length;
}

function renderTranscript() {
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('transcript').innerHTML =
    filteredSpeeches()
      .map(
        (l) =>
          '<article class="record-entry"><div><span class="record-avatar">' +
          seatAvatarHTML(profiles[l.id], l.id) +
          '</span><b>' +
          esc(l.id + 1 + ' 号 · ' + name(l.id)) +
          '</b><small>第 ' +
          l.round +
          ' 轮 · ' +
          (l.pk ? 'PK' : '普通') +
          '发言 · ' +
          esc(l.time) +
          '</small></div><p>' +
          esc(l.text) +
          '</p><button class="replay-btn" data-record-replay="' +
          transcript.indexOf(l) +
          '" ' +
          (!speechAvailable() ? 'disabled' : '') +
          '>▷ 重播</button></article>',
      )
      .join('') || '<p class="record-empty">暂无发言，天亮后玩家将依次讨论。</p>';
  $('speechState').textContent =
    game.phase === 'ended' ? '本局全部发言' : '公开发言 · ' + transcript.length + ' 条';
  syncRecordScroll();
}

function renderAction() {
  let title, detail, kicker;
  if (game.phase === 'lobby') {
    kicker = 'READY TO WATCH';
    title = '配置好 AI，剩下的交给这张桌子。';
    detail =
      '点击开始，系统随机发牌；全部 ' +
      size +
      ' 个席位自动行动、发言、投票，直到分出胜负。未配置的席位使用本地模拟。';
  } else if (game.phase === 'ended') {
    kicker = 'THE TRUTH IS OUT';
    title = game.winner === '好人' ? '☀ 好人找到了真相' : '☾ 狼人赢得了黑夜';
    detail = '本局共进行 ' + game.round + ' 轮，所有身份已揭晓。点击“再来一局”重新随机发牌。';
  } else if (runError) {
    kicker = 'GAME STOPPED';
    title = '对局已停止';
    detail = runError + '。请点击“重新开局”。';
  } else {
    kicker = paused ? 'PAUSED' : 'AUTO PLAY · ROUND ' + game.round;
    title = paused
      ? '对局已暂停'
      : publicNight()
        ? '夜间角色正在秘密行动'
        : actionText || phaseLabels[game.phase];
    detail = paused
      ? '当前已发出的请求会完成，后续行动等待你点击“继续对局”。'
      : '夜间技能 → 白天发言 → 投票 / 平票 PK → 猎人技能 → 胜负结算；阶段自动切换。';
  }
  const preparation = preparedSpeech && !preparedSpeech.active ? preparedSpeech : null;
  const voting = voteBatchStatus();
  const secretNightBatch = voting?.batch.kind === 'night';
  const hiddenBatch = secretNightBatch && publicNight();
  const currentAPI = voting?.batch || apiWaiting || agentPending || preparation?.attempt;
  let apiTitle = title,
    apiDetail = '';
  if (voting) {
    const nightBatch = voting.batch.kind === 'night',
      hiddenNight = nightBatch && publicNight();
    const labels = {
      pending: '正在等待接口返回',
      done: nightBatch ? '选择已收' : '已收票',
      failed: '失败，待手动重试',
      cancelled: '已停止，待手动重试',
    };
    kicker = nightBatch
      ? voting.failed.length
        ? 'NIGHT ACTION PAUSED'
        : 'NIGHT ACTIONS'
      : voting.failed.length
        ? 'VOTING PAUSED'
        : 'COLLECTING VOTES';
    title = hiddenNight
      ? '夜间秘密行动处理中'
      : nightBatch
        ? '狼人独立选择 · 已收 ' + voting.received + ' / ' + voting.total + ' 项'
        : '公开投票 · 已收 ' + voting.received + ' / ' + voting.total + ' 票';
    if (voting.failed.length) title += ' · 待手动重试';
    else if (paused) title += ' · 已暂停';
    detail = hiddenNight
      ? '夜间行动正在等待处理。普通观战不会显示行动席位、角色或诊断信息。'
      : nightBatch
        ? '所有狼人各自独立提交选择，结果收齐后按现有多数规则结算。' +
          (paused ? ' 对局已暂停，已返回结果会保留。' : '')
        : '全部有效结果收齐后，按座位顺序公布。' +
          (paused ? ' 对局已暂停，其余请求继续收票。' : '');
    apiTitle = title;
    apiDetail = hiddenNight
      ? '夜间秘密行动正在等待接口或本地席位处理。'
      : Object.values(voting.batch.items)
          .map((item) => {
            const attempt = item.attempt,
              elapsed = Math.max(
                0,
                Math.floor(
                  ((attempt?.endedAt || Date.now()) - (attempt?.startedAt || voting.startedAt)) /
                    1000,
                ),
              );
            return (
              item.id +
              1 +
              ' 号 · ' +
              labels[item.status] +
              ' · ' +
              elapsed +
              ' 秒。' +
              (item.error ? ' ' + item.error.message : '') +
              (attempt?.requestId ? ' 请求编号 ' + attempt.requestId + '。' : '') +
              inputTokenNote(attempt)
            );
          })
          .join('\n');
    if (!hiddenNight) detail += ' ' + apiDetail;
  } else if (currentAPI) {
    const hidden = publicNight(),
      elapsed = Math.max(
        0,
        Math.floor(
          ((apiWaiting?.endedAt || currentAPI.endedAt || Date.now()) - currentAPI.startedAt) / 1000,
        ),
      );
    if (preparation && !apiWaiting) {
      apiTitle =
        preparation.id +
        1 +
        ' 号 · ' +
        (preparation.status === 'ready'
          ? '下一位已就绪'
          : preparation.status === 'failed'
            ? '准备未完成，轮到时处理'
            : '准备下一位');
      apiDetail =
        preparation.status === 'ready'
          ? '发言结果已暂存，当前人物完整播放后依次使用。'
          : preparation.status === 'failed'
            ? '准备请求已结束，当前人物完整播放后，将在该席位暂停并显示原因。'
            : '下一位正在等待接口返回，已等待 ' + elapsed + ' 秒。';
      apiDetail += ' 请求编号 ' + currentAPI.requestId + '。';
      detail += ' ' + apiTitle + '。' + apiDetail;
    } else {
      kicker = apiWaiting ? 'ACTION PAUSED' : 'WAITING FOR RESPONSE';
      title = apiWaiting
        ? '已暂停 · 当前行动未完成'
        : hidden
          ? '正在等待接口返回'
          : currentAPI.id + 1 + ' 号 · 正在等待接口返回';
      detail = apiWaiting
        ? (hidden
            ? '夜间行动遇到接口问题，请检查配置并手动重试。'
            : currentAPI.message + ' 本次用时 ' + elapsed + ' 秒。') +
          ' 点击“重试当前行动”后重新请求。'
        : (hidden
            ? '夜间秘密行动正在等待接口返回，已等待 ' + elapsed + ' 秒。'
            : '当前行动正在等待接口返回，已等待 ' + elapsed + ' 秒。') +
          (paused ? ' 对局已暂停，返回结果会保留至继续对局。' : '');
      if (!hidden)
        detail += ' 请求编号 ' + currentAPI.requestId + '。' + inputTokenNote(currentAPI);
      apiTitle = title;
      apiDetail = detail;
    }
  }
  $('portraitAPIDialogTitle').textContent = currentAPI ? apiTitle : '接口状态';
  $('portraitAPIDialogText').textContent = currentAPI ? apiDetail : '';
  if (!currentAPI && $('portraitAPIDialog').open) $('portraitAPIDialog').close();
  const stages = [
    ['night', '秘密行动'],
    ['discussion', '依次发言'],
    ['voting', '公开投票'],
    ['ended', '揭晓胜负'],
  ];
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('actionPanel').innerHTML =
    '<div class="auto-summary"><span class="panel-kicker">' +
    esc(kicker) +
    '</span><h3>' +
    (busy && !paused ? '<i class="thinking-dot"></i> ' : '') +
    esc(title) +
    '</h3><p>' +
    esc(detail) +
    '</p><div class="auto-stages">' +
    stages
      .map(
        ([phase, label]) =>
          '<span class="' +
          (game.phase === phase || (phase === 'voting' && game.phase === 'hunter')
            ? 'active'
            : '') +
          '">' +
          label +
          '</span>',
      )
      .join('') +
    '</div></div>' +
    (currentAPI
      ? '<div class="api-wait-actions">' +
        (voting
          ? (voting.failed.length
              ? '<button class="primary-btn" data-command="retry-api">重试失败' +
                (secretNightBatch ? '夜间行动' : '投票') +
                '</button><button class="secondary-btn" data-command="edit-api">修改配置</button>'
              : '') +
            (voting.pending
              ? '<button class="secondary-btn" data-command="stop-api">停止等待</button>'
              : '')
          : apiWaiting
            ? '<button class="primary-btn" data-command="retry-api">重试当前行动</button><button class="secondary-btn" data-command="edit-api">修改配置</button>'
            : agentPending
              ? '<button class="secondary-btn" data-command="stop-api">停止等待</button>'
              : '') +
        '<button class="secondary-btn" data-command="details-api">查看详情</button></div>'
      : '') +
    (game.phase === 'lobby'
      ? '<button class="secondary-btn" data-command="agents">配置 AI 玩家 ↗</button>'
      : '');
  if (typeof renderPortraitAPIStatus === 'function') renderPortraitAPIStatus(apiTitle, apiDetail);
}

function connectionInfo(profile) {
  if (profile.control !== 'api')
    return {
      state: 'local',
      className: 'local',
      label: '本地模拟',
      seatLabel: '本地模拟',
      detail: '此席位使用本地模拟，无需连接网络。',
    };
  const states = {
    ok: {
      className: 'online',
      label: '连接成功',
      seatLabel: 'API 在线',
      detail: '最近一次请求成功；测试连接及游戏请求时更新。',
    },
    error: {
      className: 'offline',
      label: '连接失败',
      seatLabel: 'API 离线',
      detail: profile.connectionError || '最近一次请求失败，对局将等待接口恢复后继续。',
    },
    testing: {
      className: 'connecting',
      label: '连接中…',
      seatLabel: 'API 连接中…',
      detail: '正在请求此席位配置的模型接口。',
    },
    queued: {
      className: 'queued',
      label: '等待测试…',
      seatLabel: 'API 等待测试…',
      detail: '已加入本轮测试，等待前面的席位完成。',
    },
    untested: {
      className: 'unknown',
      label: '尚未测试',
      seatLabel: 'API 未测试',
      detail: '尚未验证连接，请先到 Agent 配置页测试连接。',
    },
  };
  const state = Object.hasOwn(states, profile.connection) ? profile.connection : 'untested';
  return { state, ...states[state] };
}

function connectionBadge(profile, seat = false) {
  const status = connectionInfo(profile),
    loading = ['testing', 'queued'].includes(status.state);
  return `<span class="${seat ? 'seat-connection' : 'agent-status'} connection-badge ${status.className}" data-connection-status="${status.state}" role="status" aria-live="polite" aria-busy="${loading}" title="${esc(status.detail)}"><i aria-hidden="true"></i>${seat ? status.seatLabel : status.label}</span>`;
}

function renderConnectionViews() {
  renderAgents();
  renderPlayers();
  renderStatus();
}

function setConnection(profile, state, error = '') {
  profile.connection = state;
  profile.connectionError = error;
  if (profiles.includes(profile)) renderConnectionViews();
}

function renderAgents() {
  $('agentCount').textContent = `${size} 个席位`;
  $('configuredCount').textContent = profiles
    .slice(0, size)
    .filter((p) => p.control === 'api').length;
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('agentGrid').innerHTML = profiles
    .slice(0, size)
    .map(
      (p, i) =>
        `<article class="agent-card" data-agent-card="${i}" data-connection="${connectionInfo(p).state}"><div class="agent-head"><div class="agent-avatar">${avatarHTML(p)}</div><div><h3>${esc(p.name)}</h3><span class="agent-meta">${i + 1} 号位 · 独立人格 · 自动行动</span></div></div>${connectionBadge(p)}<p class="personality-preview">${esc(p.personality)}</p>${p.control === 'api' && p.connection === 'error' && p.connectionError ? `<p class="agent-error">${esc(p.connectionError)}${!p.key ? '；此席位未填写密钥，请补填并保存。' : ''}</p>` : ''}<div class="agent-fields"><div class="agent-field"><span>模型</span><strong>${esc(p.control === 'local' ? '规则模拟引擎' : p.model || '未填写')}</strong></div><div class="agent-field"><span>接口</span><strong>${esc(p.control === 'local' ? '无需网络' : p.endpoint || '未填写')}</strong></div></div>${p.control === 'api' ? `<p class="agent-reasoning">API 协议 · Responses</p><p class="agent-reasoning">推理强度 · ${NightfallAgentRequest.normalizeReasoningEffort(p.reasoningEffort) === 'high' ? '高（high）' : '超高（xhigh）'}</p><p class="agent-reasoning">历史上下文 · ${p.historyContext === 'full' ? '完整历史' : '最近两轮发言'}</p>` : ''}<p class="agent-voice">♫ ${esc(Voices.label(seatVoice(p, i), i))} · ${esc(Voices.styles[Voices.settings(seatVoice(p, i), i).voiceStyle].name)}</p><div class="agent-foot"><button class="avatar-edit" data-agent="${i}">✎ 形象与人格</button><button class="config-btn" data-agent="${i}">配置 Agent / 声音 →</button></div></article>`,
    )
    .join('');
}

function renderRules() {
  $('ruleTitle').textContent = BOARDS[ruleSize].title;
  document
    .querySelectorAll('.rule-mode')
    .forEach((b) => b.classList.toggle('active', +b.dataset.rule === ruleSize));
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('ruleSections').innerHTML = rulesHTML(ruleSize);
}

function switchView(next) {
  if (
    typeof recordingOpenConfig === 'function' &&
    typeof activeRecording !== 'undefined' &&
    activeRecording
  ) {
    if (next !== 'table') {
      recordingOpenConfig();
      if (portraitMode) setPortraitMode(false, true);
    } else recordingCloseConfig();
  }
  if (
    next !== 'rules' &&
    narration?.kind === 'rules' &&
    $('rulesBackdrop').classList.contains('hidden')
  )
    stopNarration();
  view = next;
  document.querySelectorAll('.content').forEach((x) => x.classList.add('hidden'));
  $(next + 'View').classList.remove('hidden');
  document
    .querySelectorAll('.nav-item')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === next));
  renderSpectator();
}
