'use strict';
// A presentation of the existing controller, never a second game or audio player.
let portraitMode = false,
  portraitPortals = null,
  portraitRecordBefore = null;
let portraitAPIWaiting = null,
  portraitAPIPaused = false;
function renderPortraitAPIStatus(title, detail) {
  const bar = $('portraitAPIBar'),
    dialog = $('portraitAPIDialog');
  if (!portraitMode) return;
  const preparation = preparedSpeech && !preparedSpeech.active ? preparedSpeech : null;
  const voting = voteBatchStatus();
  const current = voting?.batch || apiWaiting || agentPending || preparation?.attempt,
    waiting = !!current;
  bar.classList.toggle('waiting', waiting);
  const elapsed = current
    ? Math.max(
        0,
        Math.floor(
          ((apiWaiting?.endedAt || current.endedAt || Date.now()) - current.startedAt) / 1000,
        ),
      )
    : 0;
  const text = voting
    ? '投票 · 已收 ' +
      voting.received +
      '/' +
      voting.total +
      ' 票 · ' +
      Math.floor((Date.now() - voting.startedAt) / 1000) +
      '秒' +
      (voting.failed.length ? ' · 待重试' : paused ? ' · 已暂停' : '')
    : current
      ? (publicNight() ? '夜间行动' : current.id + 1 + '号') +
        ' · ' +
        (apiWaiting
          ? '已暂停，等待手动重试'
          : preparation
            ? preparation.status === 'ready'
              ? '下一位已就绪'
              : preparation.status === 'failed'
                ? '准备未完成，轮到时处理'
                : '准备下一位 ' + elapsed + '秒'
            : '等待接口 ' + elapsed + '秒' + (paused ? ' · 已暂停' : ''))
      : '接口等待：无';
  const status = $('portraitAPIStatus');
  if (status.textContent !== text) status.textContent = text;
  status.setAttribute('title', text);
  $('portraitAPIStop').hidden = voting ? !voting.pending : !agentPending;
  $('portraitAPIStop').disabled = voting
    ? !voting.pending
    : !agentPending || agentPending.controller.signal.aborted;
  $('portraitAPIRetry').textContent = voting ? '重试失败投票' : '重试当前行动';
  $('portraitAPIRetry').hidden = voting ? !voting.failed.length : !apiWaiting;
  $('portraitAPIRetry').disabled = $('portraitAPIRetry').hidden;
  $('portraitAPIEdit').hidden = voting ? !voting.failed.length : !apiWaiting;
  $('portraitAPIEdit').disabled = $('portraitAPIEdit').hidden;
  $('portraitAPIDetails').disabled = !waiting;
  $('portraitAPIDialogTitle').textContent = waiting ? title : '接口连接状态';
  $('portraitAPIDialogText').textContent = waiting ? detail : '';
  if (!waiting && dialog.open) dialog.close();
  if (portraitAPIWaiting !== current || portraitAPIPaused !== paused) {
    portraitAPIWaiting = current;
    portraitAPIPaused = paused;
    renderPortrait();
  }
}
function portraitSetHTML(id, html) {
  const node = $(id);
  if (node && node.innerHTML !== html) node.innerHTML = html;
}
function portraitMove(node, parent, before = null) {
  // Atomic DOM moves preserve media, focus and animation state in supporting browsers.
  if (typeof parent.moveBefore === 'function') parent.moveBefore(node, before);
  else parent.insertBefore(node, before);
}
function portraitFocus() {
  if (speechBubble && ['dialogue', 'replay'].includes(speechBubble.kind)) return speechBubble.id;
  return activeSeat !== null &&
    (game.phase === 'discussion' ||
      (game.pk?.includes(activeSeat) && actionText.includes('PK 发言')))
    ? activeSeat
    : null;
}
function portraitSeatState(p) {
  const line = speechBubble?.id === p.id ? speechBubble : null,
    current = narration?.seat === p.id ? narration : null;
  const active = activeSeat === p.id && !publicNight();
  const speaking =
    !!line &&
    line.stage !== 'entrance' &&
    line.stage !== 'tail' &&
    (!current || (!current.loading && current.playing));
  const frozen = (paused && line?.kind !== 'replay') || current?.paused;
  const status =
    frozen && (line || active)
      ? '已暂停'
      : line?.stage === 'entrance'
        ? '即将发言'
        : current && (current.loading || !current.playing)
          ? '准备声音'
          : speaking
            ? '正在发言'
            : line?.stage === 'tail'
              ? '发言结束'
              : active
                ? apiWaiting
                  ? '等待连接'
                  : '思考中'
                : !p.alive
                  ? eliminationInfo(p).label
                  : '存活';
  return { active, speaking, pulsing: speaking && !frozen, status };
}
function portraitSeatHint(p) {
  const wolf =
    game.phase === 'night' &&
    spectatorPrefs.perspective === 'god' &&
    wolfPresentation?.round === game.round
      ? wolfPresentation.states[p.id]
      : null;
  if (wolf)
    return wolf.status === 'choosing'
      ? '正在选刀'
      : wolf.status === 'selected'
        ? '提议 ' + (wolf.target + 1) + ' 号'
        : wolf.status === 'abstained'
          ? '放弃袭击'
          : '无有效选择';
  const vote = votePresentation?.states[p.id];
  if (!vote) return '';
  return vote === 'revealed'
    ? votePresentation.votes[p.id] == null
      ? '弃票'
      : '投 ' + (votePresentation.votes[p.id] + 1) + ' 号'
    : {
        pending: '待投票',
        choosing: '投票中',
        submitted: '已投票',
        failed: '投票失败',
        cancelled: '等待重试',
        excluded: '本轮不投票',
      }[vote] || '';
}
function portraitConnectionBadge(profile) {
  const hidden = publicNight(),
    connection = connectionInfo(profile);
  const labels = {
    ok: '在线',
    error: '离线',
    testing: '连接中',
    queued: '待测',
    untested: '未测',
    local: '模拟',
  };
  return (
    '<span class="portrait-seat-connection ' +
    (hidden ? 'hidden-connection' : connection.className) +
    '" data-connection="' +
    (hidden ? 'hidden' : connection.state) +
    '" title="' +
    esc(hidden ? '夜间秘密行动' : connection.seatLabel) +
    '"><i aria-hidden="true"></i><span>' +
    (hidden ? '夜间' : labels[connection.state]) +
    '</span></span>'
  );
}
function portraitActionLabel(status) {
  const text = status.replace(/^投 (\d+) 号$/, '投给$1号').replace(/^提议 (\d+) 号$/, '提议$1号');
  // Keep a two-digit seat number upright as one unit in the vertical column.
  return text
    .split(/(\d+)/)
    .map((part) =>
      /^\d+$/.test(part) ? '<span class="portrait-seat-number">' + part + '</span>' : esc(part),
    )
    .join('');
}
function renderPortraitCaption() {
  if (!portraitMode || !$('portraitFrame')) return;
  const line = speechBubble,
    focus = portraitFocus(),
    privateNight = publicNight(),
    event =
      currentCommentary && (!currentCommentary.private || spectatorPrefs.perspective === 'god')
        ? currentCommentary
        : null;
  // A speaker is visible while awaiting the model too, before a bubble exists.
  $('portraitFrame').dataset.caption = focus !== null ? 'speaker' : 'narration';
  let label = '旁白',
    text = '';
  if (line) {
    label = line.id + 1 + ' 号 · ' + name(line.id) + (line.kind === 'replay' ? ' · 重播' : '');
    text =
      line.caption ||
      (line.stage === 'entrance'
        ? '请听这位来客的发言。'
        : narration?.loading
          ? '声音准备中…'
          : '…');
  } else if (apiWaiting) {
    label = '行动已暂停';
    text = privateNight
      ? '夜间行动遇到接口问题，请手动重试当前行动。'
      : apiWaiting.id + 1 + ' 号的当前行动已暂停，请手动重试。已完成的行动保留。';
  } else if (focus !== null) {
    label = portraitSeatState(game.players[focus]).status;
    text = paused
      ? '对局已暂停，继续后接着发言。'
      : narration?.seat === focus && narration.loading
        ? '正在准备声音，请稍候。'
        : '正在整理思路，请稍候。';
  } else if (game.phase === 'ended') {
    label = '终局';
    text = game.winner + '阵营获胜。所有身份现已揭晓。';
  } else if (game.phase === 'lobby') {
    label = '序章';
    text = '六位来客，今夜聚首。点击开始，随机发牌。';
    if (size === 12) text = '十二位来客，同赴长桌。点击开始，随机发牌。';
  } else if (event) text = observerText(event);
  else
    text = privateNight
      ? '天黑请闭眼，夜间角色正在秘密行动。'
      : phaseLabels[game.phase] + '，请留意人物发言与选择。';
  $('portraitCaptionLabel').textContent = label;
  $('portraitCaption').textContent = text;
}
function renderPortrait() {
  if (!portraitMode || !$('portraitFrame')) return;
  const frame = $('portraitFrame'),
    reveal = spectatorPrefs.perspective === 'god' || game.phase === 'ended',
    focus = portraitFocus();
  frame.dataset.size = String(size);
  frame.dataset.phase = game.phase;
  frame.dataset.winner = game.phase === 'ended' ? game.winner : '';
  frame.classList.toggle('portrait-paused', paused);
  $('portraitTitle').textContent =
    (typeof sessionStory !== 'undefined' && sessionStory?.title) || '血月下的长桌';
  $('portraitPhase').textContent =
    game.phase === 'lobby'
      ? size + ' 人局 · 等待开场'
      : '第 ' +
        game.round +
        ' 轮 · ' +
        (phaseLabels[game.phase] || '对局中') +
        (game.pk?.length && game.phase === 'discussion' ? ' · PK' : '');
  $('portraitPerspective').textContent =
    spectatorPrefs.perspective === 'god' ? '上帝视角' : '普通观战';
  $('portraitAlive').textContent = game.alive().length + ' / ' + size + ' 人存活';
  // Portrait capture reads down each column in real seat order, independently of the table.
  const players = size === 12 ? [...game.players].sort((a, b) => a.id - b.id) : game.players;
  const seats = players.map((p) => {
    const state = portraitSeatState(p),
      profile = { ...profiles[p.id], name: name(p.id) },
      hint = portraitSeatHint(p),
      death = !p.alive ? eliminationInfo(p) : null;
    const connection = publicNight() ? '夜间秘密行动' : connectionInfo(profile).seatLabel;
    if (size === 12) {
      const status = hint || death?.label || (state.active || state.speaking ? state.status : '');
      return (
        '<button class="portrait-seat ' +
        (!p.alive ? 'dead ' : '') +
        (state.active ? 'acting ' : '') +
        (state.pulsing ? 'pulsing ' : '') +
        (focus === p.id ? 'focused ' : '') +
        seatEffectClass(p) +
        '" data-portrait-seat="' +
        p.id +
        '" aria-label="' +
        esc(
          p.id + 1 + ' 号 · ' + profile.name + ' · ' + (status || state.status) + '，查看发言记录',
        ) +
        '">' +
        portraitConnectionBadge(profile) +
        '<span class="portrait-avatar">' +
        seatAvatarHTML(profile, p.id) +
        '<b>' +
        (p.id + 1) +
        '</b></span><span class="portrait-seat-name" title="' +
        esc(profile.name) +
        '">' +
        esc(profile.name) +
        '</span><span class="portrait-seat-info"><span class="portrait-seat-role">' +
        visibleRoleBadge(p, reveal) +
        '</span><span class="portrait-seat-state" title="' +
        esc(status) +
        '">' +
        portraitActionLabel(status) +
        '</span></span></button>'
      );
    }
    return (
      '<button class="portrait-seat ' +
      (!p.alive ? 'dead ' : '') +
      (state.active ? 'acting ' : '') +
      (state.pulsing ? 'pulsing ' : '') +
      (focus === p.id ? 'focused ' : '') +
      seatEffectClass(p) +
      '" data-portrait-seat="' +
      p.id +
      '" aria-label="' +
      esc(p.id + 1 + ' 号 · ' + profile.name + ' · ' + state.status + '，查看发言记录') +
      '"><span class="portrait-avatar">' +
      seatAvatarHTML(profile, p.id) +
      '<b>' +
      (p.id + 1) +
      '</b></span><span class="portrait-seat-name">' +
      esc(profile.name) +
      '</span><span class="portrait-seat-role">' +
      visibleRoleBadge(p, reveal) +
      '</span><span class="portrait-seat-state" title="' +
      esc(connection) +
      '">' +
      esc(hint || death?.label || (state.active || state.speaking ? state.status : connection)) +
      '</span></button>'
    );
  });
  portraitSetHTML('portraitSeatsLeft', seats.slice(0, size / 2).join(''));
  portraitSetHTML('portraitSeatsRight', seats.slice(size / 2).join(''));
  $('portraitHero').classList.toggle('hidden', focus === null);
  $('portraitIdle').classList.toggle('hidden', focus !== null);
  if (focus !== null) {
    const p = game.players[focus],
      profile = { ...profiles[focus], name: name(focus) },
      art = manorPortrait(profile, focus),
      state = portraitSeatState(p);
    const hero = $('portraitHero');
    hero.classList.toggle('pulsing', state.pulsing);
    const key = epoch + ':' + focus;
    if (hero.dataset.focus !== key) {
      hero.dataset.focus = key;
      hero.classList.remove('entering');
      void hero.offsetWidth;
      hero.classList.add('entering');
    }
    portraitSetHTML(
      'portraitHeroArt',
      art
        ? '<img src="' +
            Manor.imagePath(art.id) +
            '" data-portrait="' +
            art.id +
            '" alt="' +
            esc(profile.name) +
            '的立绘" draggable="false">'
        : '<div class="portrait-avatar-fallback">' + avatarHTML(profile) + '</div>',
    );
    $('portraitHeroState').textContent = state.status;
    $('portraitHeroName').textContent = focus + 1 + ' 号 · ' + profile.name;
    portraitSetHTML('portraitHeroRole', visibleRoleBadge(p, reveal));
  } else {
    $('portraitHero').dataset.focus = '';
    portraitSetHTML('portraitHeroArt', '');
    $('portraitHeroName').textContent = '';
    $('portraitHeroState').textContent = '';
    portraitSetHTML('portraitHeroRole', '');
    const event = sceneMotion?.event,
      visibleEvent =
        event && (!event.private || spectatorPrefs.perspective === 'god') ? event : null;
    const titles = {
      lobby: ['✦', '长桌已备 · 等待来客', '等待开场'],
      night: ['☾', '烛火将熄 · 请闭上眼', '夜幕降临'],
      discussion: ['❖', '线索藏在每句话里', '白昼议事'],
      voting: ['⚖', '每一票，皆是选择', '公开投票'],
      hunter: ['⌖', '最后的选择', '技能结算'],
      ended: [game.winner === '狼人' ? '☾' : '☀', '尘埃落定 · 身份揭晓', game.winner + '阵营胜利'],
    };
    const [symbol, kicker, title] = titles[game.phase] || titles.lobby;
    $('portraitSymbol').textContent = symbol;
    $('portraitIdleKicker').textContent = kicker;
    $('portraitIdleTitle').textContent = dealState
      ? dealState.stage === 'reveal'
        ? '命运揭晓'
        : '命运洗牌中'
      : visibleEvent && sceneTitles[visibleEvent.kind]
        ? sceneTitles[visibleEvent.kind][1]
        : title;
    const counts = votePresentation?.counts;
    portraitSetHTML(
      'portraitVoteSummary',
      game.phase === 'voting' && counts
        ? Object.entries(counts)
            .filter(([, v]) => v > 0)
            .map(([id, n]) => '<span>' + esc(+id + 1 + ' 号 · ' + n + ' 票') + '</span>')
            .join('')
        : '',
    );
  }
  renderPortraitCaption();
  fitPortrait();
}
function portraitSeatFace(id) {
  return portraitMode
    ? document.querySelector?.('[data-portrait-seat="' + id + '"] .portrait-avatar')
    : null;
}
function fitPortrait() {
  if (!portraitMode) return;
  const stage = $('tableStage'),
    frame = $('portraitFrame');
  if (!stage?.getBoundingClientRect) return;
  const w = Math.max(1, Math.min(stage.clientWidth, (stage.clientHeight * 9) / 16));
  frame.style.setProperty('--portrait-unit', w / 100 + 'px');
  frame.style.width = w + 'px';
  frame.style.height = (w * 16) / 9 + 'px';
  positionRevealCards();
}
function setPortraitMode(enabled, forConfig = false) {
  if (!enabled && !forConfig && typeof activeRecording !== 'undefined' && activeRecording) {
    toast('录制期间请保持竖屏画面');
    return;
  }
  if (!!enabled === portraitMode) return;
  if (enabled) {
    portraitRecordBefore = spectatorPrefs.railOpen;
    spectatorPrefs.railOpen = false;
  } else {
    if (watchMode) {
      if (watchRecordBefore === null) watchRecordBefore = portraitRecordBefore;
    } else {
      spectatorPrefs.railOpen = watchRecordBefore ?? portraitRecordBefore ?? true;
      watchRecordBefore = null;
    }
    portraitRecordBefore = null;
  }
  if (!enabled && $('portraitAPIDialog').open) $('portraitAPIDialog').close();
  portraitMode = !!enabled;
  document.body.classList.toggle('portrait-mode', portraitMode);
  $('portraitBtn').textContent = portraitMode ? '▯ 返回圆桌' : '▯ 竖屏录制';
  $('portraitBtn').setAttribute('aria-pressed', String(portraitMode));
  $('storyMoviePortrait').textContent = $('portraitBtn').textContent;
  $('storyMoviePortrait').setAttribute('aria-pressed', String(portraitMode));
  $('portraitFrame').classList.toggle('hidden', !portraitMode);
  // Move the existing overlays and video, retaining their playback position/listeners.
  const movie = $('storyMovieOverlay'),
    effect = $('sceneEffect');
  if (portraitPortals) {
    if (portraitMode) {
      portraitMove(effect, $('portraitFrame'));
      portraitMove(movie, $('portraitFrame'));
      portraitMove(portraitPortals.controls, $('portraitMovieTools'));
    } else {
      portraitMove(effect, portraitPortals.effectParent, $('speechBubble'));
      portraitMove(movie, portraitPortals.movieParent);
      portraitMove(portraitPortals.controls, portraitPortals.shell);
    }
    $('portraitMovieTools').classList.toggle('hidden', !portraitMode || !storyIntroActive());
  }
  wakePresentation();
  renderPlayers();
  renderSpectator();
  renderAction();
  fitPortrait();
  if (sceneMotion) renderSceneMotion();
}
function initPortrait() {
  const movie = $('storyMovieOverlay');
  portraitPortals = {
    effectParent: $('sceneEffect').parentNode,
    movieParent: movie.parentNode,
    shell: movie.querySelector('.story-movie-shell'),
    controls: movie.querySelector('.story-movie-controls'),
  };
  $('portraitBtn').addEventListener('click', () => setPortraitMode(!portraitMode));
  $('storyMoviePortrait').addEventListener('click', () => setPortraitMode(!portraitMode));
  $('portraitResetBtn').addEventListener('click', () => requestReset());
  $('portraitAPIBar').addEventListener('click', (e) => {
    const command = e.target.closest('[data-command]')?.dataset.command;
    if (command) handleAPIWaitCommand(command);
  });
  $('portraitAPIDetails').addEventListener('click', () => {
    if ((!apiWaiting && !agentPending && !preparedSpeech && !voteBatch) || !portraitMode) return;
    renderAction();
    const dialog = $('portraitAPIDialog');
    if (!dialog.open) dialog.showModal();
  });
  $('portraitFrame').addEventListener('click', (e) => {
    const seat = e.target.closest('[data-portrait-seat]');
    if (!seat) return;
    recordSeat = seat.dataset.portraitSeat;
    recordTab = 'speeches';
    spectatorPrefs.railOpen = true;
    Object.assign(recordScroll.speeches, { top: 0, bottom: true, seen: 0 });
    saveSpectatorPrefs();
    renderTranscript();
    renderSpectator();
  });
  if (typeof ResizeObserver === 'function')
    new ResizeObserver(fitPortrait).observe($('tableStage'));
}
