'use strict';

function speechAvailable() {
  return (
    typeof globalThis.Audio === 'function' ||
    (!!globalThis.speechSynthesis && typeof globalThis.SpeechSynthesisUtterance === 'function')
  );
}

function renderVoiceControls() {
  renderEffectsControls();
  effects?.sync();
  renderMusicControls();
  music?.setTrack(
    NightfallAudio.storyMusic({
      size,
      story: typeof sessionStory === 'undefined' ? null : sessionStory,
      phase: game.phase,
    }),
  );
  music?.sync();
  const supported = speechAvailable(),
    rules = narration?.kind === 'rules';
  $('voiceBtn').disabled = !supported;
  $('voiceBtn').setAttribute('aria-pressed', String(voiceEnabled && supported));
  $('voiceBtn').textContent = supported
    ? '♫ 对白语音：' + (voiceEnabled ? '开' : '关')
    : '对白语音不可用';
  $('voiceStatus').textContent = speechFailure
    ? `${speechFailure.label}语音生成失败，已尝试 ${speechFailure.attempts} 次：${speechFailure.message}。对局已暂停。`
    : narration
      ? (narration.kind === 'commentary'
          ? narration.loading
            ? '正在准备旁白声音…'
            : '旁白正在讲解'
          : rules
            ? narration.loading
              ? '正在加载讲解音频…'
              : '正在播放自然女声讲解'
            : `${narration.seat + 1} 号 · ${name(narration.seat)} ${narration.loading ? '正在生成语音…' : '正在说话'}`) +
        (narration.paused ? '（已暂停）' : '')
      : voiceMessage ||
        (!supported
          ? '此浏览器不支持语音，仍可阅读席位对白。'
          : voiceEnabled
            ? '独立音色 · 随发言变化语气 · 说完后进入下一位'
            : '对白语音已关闭 · 可在席位重播');
  $('speechRecovery').classList.toggle('hidden', !speechFailure);
  $('voicePreviewBtn').textContent =
    narration?.kind === 'preview' ? '■ 停止试听' : '▷ 试听当前声音';
  $('readRulesBtn').textContent = rules ? '■ 停止介绍' : '▷ 语音介绍规则';
  $('modalReadRulesBtn').textContent = rules ? '■ 停止介绍' : '▷ 重新播放';
  $('rulesVoiceStatus').textContent = rules
    ? narration.loading
      ? '正在加载讲解音频…'
      : '正在播放自然女声讲解…'
    : voiceMessage || '自然中文女声 · 点击可重新播放';
}

function releaseRuleAudio(audio) {
  if (!audio) return;
  audio.onended =
    audio.onerror =
    audio.onplaying =
    audio.ontimeupdate =
    audio.onloadedmetadata =
    audio.onwaiting =
      null;
  try {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch {}
}

function releaseDialogue(current) {
  clearTimeout(current.captionTimer);
  current.controller?.abort();
  if (current.audio) releaseRuleAudio(current.audio);
  if (current.objectURL) {
    URL.revokeObjectURL(current.objectURL);
    current.objectURL = null;
  }
}

function stopNarration() {
  const current = narration;
  if (!current) return;
  narration = null;
  clearTimeout(current.timer);
  releaseDialogue(current);
  if (current.utterance) {
    current.utterance.onend =
      current.utterance.onerror =
      current.utterance.onstart =
      current.utterance.onboundary =
        null;
    try {
      globalThis.speechSynthesis.cancel();
    } catch {}
  }
  current.resolve(false);
  renderVoiceControls();
  renderPlayers();
}

function armSpeechTimeout(current) {
  clearTimeout(current.timer);
  current.timer = setTimeout(
    () => {
      if (narration !== current) return;
      voiceMessage = '语音未能完成，已跳过；可点击席位重播。';
      stopNarration();
    },
    Math.max(15000, (current.text || current.utterance?.text || '').length * 450 + 8000),
  );
}

function speakText(text, { kind = 'dialogue', seat = null, profile = null } = {}) {
  text = limitSpeech(text);
  if (
    (kind === 'dialogue' && !voiceEnabled) ||
    (kind === 'commentary' && !spectatorPrefs.narratorEnabled)
  )
    return Promise.resolve(false);
  if (!speechAvailable()) {
    stopNarration();
    voiceMessage = '';
    renderVoiceControls();
    return Promise.resolve(false);
  }
  const config = Voices.settings(profile || seatVoice(profiles[seat] || {}, seat || 0), seat || 0);
  if (config.voiceProvider !== 'system') return speakNatural(text, { kind, seat, profile: config });
  stopNarration();
  voiceMessage = '';
  if (!globalThis.speechSynthesis || typeof globalThis.SpeechSynthesisUtterance !== 'function') {
    voiceMessage = '此浏览器不支持系统朗读，请在声音设置中选择自然中文音色。';
    if (kind === 'preview') $('voicePreviewStatus').textContent = voiceMessage;
    renderVoiceControls();
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const utterance = new globalThis.SpeechSynthesisUtterance(text),
      current = {
        utterance,
        resolve,
        kind,
        seat,
        text,
        speed: config.voiceSpeed,
        paused: false,
        playing: false,
        timer: null,
        transcriptId: null,
        transcriptStarted: false,
        transcriptConfig: config,
      };
    utterance.lang = 'zh-CN';
    utterance.rate = config.voiceSpeed;
    utterance.pitch = 1;
    narration = current;
    const finish = (failed) => {
      if (narration !== current) return;
      clearTimeout(current.timer);
      clearTimeout(current.captionTimer);
      if (current.transcriptId && typeof recordingTranscriptEnd === 'function')
        recordingTranscriptEnd(current.transcriptId, failed ? 'failed' : 'played');
      narration = null;
      if (failed) voiceMessage = '语音播放失败，请检查浏览器语音设置；对白仍显示在席位。';
      else if (kind === 'rules')
        voiceMessage = busy && paused ? '规则介绍完毕，点击“继续对局”返回观战。' : '规则介绍完毕';
      resolve(!failed);
      renderVoiceControls();
      renderPlayers();
    };
    utterance.onend = () => finish(false);
    utterance.onerror = () => finish(true);
    utterance.onstart = () => {
      if (narration !== current) return;
      if (
        ['dialogue', 'commentary'].includes(kind) &&
        typeof recordingTranscriptBegin === 'function'
      ) {
        current.transcriptId = recordingTranscriptBegin({
          kind,
          seat,
          name: seat == null ? '' : name(seat),
          text,
          voiceProvider: config.voiceProvider,
          voice: config.voice,
          voiceModel: config.voiceModel,
          speechStatus: 'played',
        });
        current.transcriptStarted = true;
      }
      current.playing = true;
      startCaptionClock(current);
      renderPlayers();
    };
    utterance.onboundary = (e) => {
      if (narration === current && Number.isFinite(e.charIndex))
        updateSpeechCaption(current, null, e.charIndex + Math.max(1, e.charLength || 1));
    };
    try {
      const voices = globalThis.speechSynthesis
        .getVoices()
        .filter((v) => /^zh(?:[-_]|$)/i.test(v.lang));
      if (voices.length) utterance.voice = voices[(seat ?? 0) % voices.length];
      // Cancelling a paused utterance does not clear the browser's paused flag.
      globalThis.speechSynthesis.resume();
      armSpeechTimeout(current);
      globalThis.speechSynthesis.speak(utterance);
      if (['dialogue', 'commentary'].includes(kind) && busy && paused) {
        current.paused = true;
        clearTimeout(current.timer);
        globalThis.speechSynthesis.pause();
      }
    } catch {
      finish(true);
    }
    renderVoiceControls();
    renderPlayers();
  });
}

function updatePauseState() {
  if (typeof recordingSetPauseReason === 'function') recordingSetPauseReason('game', paused);
  if (!paused) {
    effects?.unlock();
    music?.unlock();
  }
  effects?.pause(paused);
  music?.pause(paused);
  document.body.classList.toggle('presentation-paused', paused);
  releaseWait();
  wakeAPIWait();
  wakeVoteBatch();
  wakePresentation();
}

function settleSpeechFailure(choice) {
  const failure = speechFailure;
  if (!failure) return;
  speechFailure = null;
  failure.resolve(choice);
  paused = false;
  voiceMessage = choice === 'retry' ? '正在重试当前语音…' : '本句将以文字继续播放。';
  updatePauseState();
  renderAll();
}

async function waitForSpeechDecision(failure) {
  return new Promise((resolve) => {
    speechFailure = { ...failure, resolve };
    paused = true;
    effects?.pause(true);
    music?.pause(true);
    document.body.classList.add('presentation-paused');
    releaseWait();
    wakeAPIWait();
    wakeVoteBatch();
    wakePresentation();
    renderAll();
  });
}

function retryFailedSpeech() {
  settleSpeechFailure('retry');
}

function continueSpeechWithoutAudio() {
  settleSpeechFailure('silent');
}

function speakNatural(text, { kind, seat, profile }) {
  stopNarration();
  voiceMessage = '';
  return new Promise((resolve) => {
    const current = {
      kind,
      seat,
      resolve,
      text,
      speed: profile.voiceSpeed,
      paused: ['dialogue', 'commentary'].includes(kind) && busy && paused,
      loading: true,
      timer: null,
      controller: new AbortController(),
      transcriptId: null,
      transcriptStarted: false,
      transcriptConfig: profile,
    };
    narration = current;
    const finish = (message = '', { deferResolve = false } = {}) => {
      if (narration !== current) return;
      if (current.transcriptId && typeof recordingTranscriptEnd === 'function')
        recordingTranscriptEnd(current.transcriptId, message ? 'failed' : 'played');
      narration = null;
      clearTimeout(current.timer);
      releaseDialogue(current);
      voiceMessage = message;
      if (kind === 'preview')
        $('voicePreviewStatus').textContent = message || '试听结束，保存后将用于此席位的公开发言。';
      if (!deferResolve) resolve(!message);
      renderVoiceControls();
      renderPlayers();
    };
    const fail = async (error, attempts = 1) => {
      if (narration !== current) return;
      const message = error?.message || '语音服务暂不可用，请检查声音设置';
      if (kind === 'preview') {
        finish(message);
        return;
      }
      if (!['dialogue', 'commentary'].includes(kind)) {
        finish(message);
        return;
      }
      // Older local servers may return a bare error without the server retry
      // metadata. Keep the text-reading fallback for that legacy response.
      // Current /api/speech responses always include a safe code and attempt
      // count, so exhausted retries and configuration errors still pause.
      if (!error?.code && !Number.isInteger(error?.attempts)) {
        finish(message);
        return;
      }
      finish('', { deferResolve: true });
      const label = kind === 'commentary' ? '旁白' : `${seat + 1} 号 · ${name(seat)}`;
      const decision = await waitForSpeechDecision({
        text,
        kind,
        seat,
        profile,
        label,
        message,
        attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 1,
      });
      if (decision === 'retry') {
        const retryProfile = kind === 'commentary' ? profile : null;
        resolve(await speakText(text, { kind, seat, profile: retryProfile }));
      } else resolve(false);
    };
    current.timer = setTimeout(() => {
      const error = Error('语音服务等待超时');
      error.code = 'VOICE_TIMEOUT';
      void fail(error, 3);
    }, Limits.SPEECH_BROWSER_TIMEOUT_MS);
    if (kind === 'preview') $('voicePreviewStatus').textContent = '正在生成试听，请稍候…';
    renderVoiceControls();
    renderPlayers();
    void (async () => {
      try {
        if (globalThis.location?.protocol === 'file:')
          throw Error('请通过游戏启动地址访问，以使用自然语音');
        if (typeof globalThis.Audio !== 'function')
          throw Error('此浏览器无法播放音频，请使用支持音频的浏览器');
        const style = Voices.emotion(text, profile.voiceStyle);
        const response = await fetch('/api/speech', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          redirect: 'error',
          signal: current.controller.signal,
          body: JSON.stringify({
            provider: profile.voiceProvider,
            text: limitSpeech(text),
            voice: profile.voiceProvider === 'api' ? profile.voiceApiVoice : profile.voice,
            style,
            speed: profile.voiceSpeed,
            ...(profile.voiceProvider === 'api'
              ? {
                  endpoint: profile.voiceEndpoint,
                  model: profile.voiceModel,
                  apiKey: profile.voiceKey,
                }
              : {}),
          }),
        });
        if (narration !== current) return;
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          const error = Error(
            data?.error?.message ||
              (response.status === 404
                ? '请重启游戏服务并刷新页面，以启用自然语音'
                : '语音生成失败，请检查声音设置'),
          );
          error.code = data?.error?.code;
          error.attempts = data?.error?.attempts;
          throw error;
        }
        const blob = await response.blob();
        if (narration !== current) return;
        if (!/^audio\/mpeg/.test(blob.type) || blob.size < 128) {
          const error = Error('语音服务未返回可播放的 MP3 音频');
          error.code = 'INVALID_AUDIO';
          throw error;
        }
        current.objectURL = URL.createObjectURL(blob);
        const audio = (current.audio = new globalThis.Audio(current.objectURL));
        audio.preload = 'auto';
        current.loading = false;
        clearTimeout(current.timer);
        audio.onplaying = () => {
          if (narration !== current) return;
          if (
            ['dialogue', 'commentary'].includes(kind) &&
            !current.transcriptStarted &&
            typeof recordingTranscriptBegin === 'function'
          ) {
            current.transcriptId = recordingTranscriptBegin({
              kind,
              seat,
              name: seat == null ? '' : name(seat),
              text,
              voiceProvider: profile.voiceProvider,
              voice: profile.voiceProvider === 'api' ? profile.voiceApiVoice : profile.voice,
              voiceModel: profile.voiceModel,
              speechStatus: 'played',
              attempts: 1,
            });
            current.transcriptStarted = true;
          }
          current.playing = true;
          startCaptionClock(current);
          renderVoiceControls();
          renderPlayers();
        };
        audio.onended = () => finish();
        audio.onerror = () => finish('语音播放失败；文字已保留，可稍后重播。');
        audio.ontimeupdate = () => {
          if (
            narration === current &&
            current.playing &&
            Number.isFinite(audio.duration) &&
            audio.duration > 0
          )
            updateSpeechCaption(current, audio.currentTime / audio.duration);
        };
        audio.onwaiting = () => {
          if (narration === current) {
            current.playing = false;
            renderPlayers();
          }
        };
        current.play = () => {
          if (narration !== current || current.paused) return;
          current.playing = false;
          armSpeechTimeout(current);
          audio
            .play()
            ?.catch((error) =>
              finish(
                error?.name === 'NotAllowedError'
                  ? '浏览器暂停了声音，请点击席位重播或声音试听。'
                  : '语音播放失败，请重试。',
              ),
            );
        };
        if (!current.paused) current.play();
        renderVoiceControls();
        renderPlayers();
      } catch (error) {
        if (narration === current) {
          if (error.name === 'TypeError') {
            error.message = '无法连接语音服务，请确认游戏启动窗口仍在运行。';
            error.code = 'VOICE_NETWORK_ERROR';
          }
          void fail(error, error.attempts || 1);
        }
      }
    })();
  });
}

function toggleDialogueVoice() {
  voiceEnabled = !voiceEnabled;
  voiceMessage = '';
  if (!voiceEnabled && narration && ['dialogue', 'replay'].includes(narration.kind))
    stopNarration();
  renderVoiceControls();
  renderPlayers();
}

async function replaySpeech(id, byIndex = false) {
  const line = byIndex ? transcript[id] : transcript.findLast((l) => l.id === id);
  if (!line) return;
  if (busy && !paused) togglePause();
  await showPlayerSpeech(line, { kind: 'replay' });
}

function ruleSections(room) {
  return [
    [
      '角色与阵营',
      `${BOARDS[room].roles.join('、')}。角色开局随机分配。无警长、无遗言；出局后不再发言。`,
    ],
    [
      '夜间技能',
      `${room === 12 ? '守卫、狼人、预言家、女巫' : '狼人、预言家、女巫'}依次秘密行动。狼人分别独立选择狼刀目标，可选择任意存活玩家或弃权，按多数决定，平票随机；预言家查验一人阵营。女巫解药和毒药各一瓶，每晚只能用一瓶，仅首夜可自救。`,
    ],
    [
      '白天与平票',
      '天亮公布出局席位，不公开身份。存活玩家轮流发言，再公开投票，不可自投。平票候选人进行 PK 发言，候选人不参与第二轮投票。再次平票或全员弃票则无人出局，进入下一夜。',
    ],
    ...(room === 12
      ? [
          [
            '猎人与守卫',
            '守卫可空守或守自己，不可连续守同一人。守护或解药任一生效即可免狼刀，毒药无视守护。猎人被狼刀或放逐可以开枪，中毒不能开枪；先结算猎人技能，再判断胜负。',
          ],
        ]
      : []),
    [
      '胜负与信息',
      '狼人全部出局，好人获胜。神职全部出局或平民全部出局，狼人获胜。两种胜利条件同时满足时好人获胜。AI 只读取自己的身份、技能信息及公开发言票型；狼人还知道自己的队友。',
    ],
    [
      '自动观战',
      '配置完成后点击开始，系统全自动执行规则。玩家对白依次语音播放，可暂停、重播或关闭对白语音；点击人物可筛选完整发言记录。',
    ],
  ];
}

function rulesHTML(room) {
  return ruleSections(room)
    .map(
      ([h, p], i) =>
        `<div class="rule-section"><h3>${String(i + 1).padStart(2, '0')} / ${h}</h3><p>${esc(p)}</p></div>`,
    )
    .join('');
}

function playRuleAudio(room) {
  stopNarration();
  voiceMessage = '';
  if (!BOARDS[room] || typeof globalThis.Audio !== 'function') {
    voiceMessage = '此浏览器无法播放讲解音频，请阅读下方规则。';
    renderVoiceControls();
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const current = {
      kind: 'rules',
      seat: null,
      resolve,
      paused: false,
      loading: true,
      timer: null,
      audio: null,
    };
    narration = current;
    const finish = (message) => {
      if (narration !== current) return;
      narration = null;
      clearTimeout(current.timer);
      releaseRuleAudio(current.audio);
      voiceMessage =
        message || (busy && paused ? '规则介绍完毕，点击“继续对局”返回观战。' : '规则介绍完毕');
      resolve(!message);
      renderVoiceControls();
      renderPlayers();
    };
    try {
      const audio = (current.audio = new globalThis.Audio(`/assets/rules-${room}.mp3?v=1`));
      audio.preload = 'auto';
      audio.playbackRate = 1;
      audio.onended = () => finish('');
      audio.onerror = () => finish('讲解音频加载失败，请重启游戏服务并刷新页面后重试。');
      audio.onplaying = () => {
        if (narration !== current) return;
        current.loading = false;
        clearTimeout(current.timer);
        current.timer = setTimeout(() => finish('讲解音频播放中断，请点击重新播放。'), 600000);
        renderVoiceControls();
      };
      current.timer = setTimeout(() => finish('讲解音频加载超时，请点击重新播放。'), 15000);
      // Call play directly from the click so browser autoplay restrictions are respected.
      const playing = audio.play();
      playing?.catch((error) =>
        finish(
          error?.name === 'NotAllowedError'
            ? '浏览器暂停了声音，请点击“重新播放”开始讲解。'
            : '讲解音频播放失败，请点击重新播放。',
        ),
      );
    } catch {
      finish('讲解音频无法播放，请阅读下方规则。');
    }
    renderVoiceControls();
    renderPlayers();
  });
}

function readRules(room) {
  clearBubble();
  effects?.stop();
  nightFocus = null;
  votePresentation = null;
  if (!dealState) clearSceneMotion();
  if (narration?.kind === 'rules') {
    stopNarration();
    return;
  }
  if (busy && !paused) togglePause();
  void playRuleAudio(room);
}

function openRulesIntro() {
  rulesIntroSize = size;
  rulesFocus = document.activeElement;
  $('narratedRulesTitle').textContent = BOARDS[size].title + ' · 规则介绍';
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('narratedRuleSections').innerHTML = rulesHTML(size);
  $('rulesBackdrop').classList.remove('hidden');
  $('closeRulesIntro').focus();
  readRules(size);
}

function closeRulesIntro() {
  if (narration?.kind === 'rules') stopNarration();
  $('rulesBackdrop').classList.add('hidden');
  rulesFocus?.focus();
}

function speechConfigSignature(profile) {
  return JSON.stringify([connectionSignature(profile), profile.name, profile.personality]);
}

function speechSequenceCurrent(sequence) {
  return (
    sequence.token === epoch &&
    sequence.round === game.round &&
    sequence.phase === game.phase &&
    sequence.pk === (game.pk?.join(',') || '')
  );
}

function cancelPreparedSpeech() {
  const prepared = preparedSpeech;
  preparedSpeech = null;
  if (!prepared?.attempt) return;
  prepared.attempt.controller.abort();
  endAgentAttempt(prepared.attempt);
}

function prepareNextSpeech(id, sequence) {
  if (profiles[id].control !== 'api' || !speechSequenceCurrent(sequence)) return;
  cancelPreparedSpeech();
  const prepared = {
    ...sequence,
    id,
    signature: speechConfigSignature(profiles[id]),
    status: 'preparing',
    active: false,
    attempt: null,
    promise: null,
  };
  preparedSpeech = prepared;
  prepared.promise = requestAgentDecision(id, 'speech', {}, sequence.token, prepared).then(
    (outcome) => {
      if (preparedSpeech === prepared && speechSequenceCurrent(prepared)) {
        prepared.status = outcome.error || prepared.invalidated ? 'failed' : 'ready';
        renderAction();
      }
      return outcome;
    },
  );
}

async function aiSpeeches(pkOnly = false, token = epoch) {
  const actors = game
    .alive()
    .filter((p) => (pkOnly ? game.pk?.includes(p.id) : !game.speeches.some((s) => s.id === p.id)));
  const sequence = { token, round: game.round, phase: game.phase, pk: game.pk?.join(',') || '' };
  try {
    for (let index = 0; index < actors.length; index++) {
      if (!speechSequenceCurrent(sequence)) return;
      const p = actors[index],
        prepared = preparedSpeech?.id === p.id ? preparedSpeech : null;
      const result = await takeTurn(
        p.id,
        'speech',
        p.id + 1 + ' 号 · ' + name(p.id) + (pkOnly ? ' 正在进行 PK 发言' : ' 正在发言'),
        token,
        {},
        prepared,
      );
      if (result === null || !speechSequenceCurrent(sequence)) return;
      const text = limitSpeech(String(result.speech || '本轮我还需要更多信息。'));
      if (pkOnly) game.recordSpeech(p.id, text);
      else game.addSpeech(p.id, text);
      activeSeat = p.id;
      addSpeech(p.id, text);
      renderAll();
      if (!(await waitForTurn(token, 0)) || !speechSequenceCurrent(sequence)) return;
      const next = actors[index + 1];
      if (next) prepareNextSpeech(next.id, sequence);
      await showPlayerSpeech(transcript.at(-1), { token });
      if (!speechSequenceCurrent(sequence)) return;
      activeSeat = null;
      renderAll();
    }
  } finally {
    if (preparedSpeech?.token === token) cancelPreparedSpeech();
  }
}
