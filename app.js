'use strict';
const Limits = globalThis.NightfallLimits || {
  SPEECH_CHAR_LIMIT: 1400,
  AGENT_OUTPUT_MAX_TOKENS: 25000,
  SPEECH_OUTPUT_MAX_TOKENS: 25000,
  ACTION_OUTPUT_MAX_TOKENS: 25000,
  CONNECTION_TEST_OUTPUT_MAX_TOKENS: 350,
  SPEECH_BROWSER_TIMEOUT_MS: 280000,
  AGENT_BROWSER_TIMEOUT_MS: 185000,
  truncateUnicode: (value, limit = 1400) =>
    Array.from(String(value ?? ''))
      .slice(0, limit)
      .join(''),
  unicodeLength: (value) => Array.from(String(value ?? '')).length,
};
const limitSpeech = (value) => Limits.truncateUnicode(value, Limits.SPEECH_CHAR_LIMIT);
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const Avatar = NightfallAvatar;
const AVATARS = Avatar.AVATARS;
const NAMES = [
  '岚',
  '夜莺',
  '白桃',
  '灰塔',
  '阿洛',
  '星野',
  '栗子',
  '白昼',
  '青禾',
  '渡鸦',
  '小满',
  '南枝',
];
const PERSONALITIES = [
  '沉着、有主见，愿意为自己的判断承担风险。',
  '逻辑清晰，习惯对比前后发言。',
  '开朗幽默，擅长用问题试探别人。',
  '谨慎内敛，关注每一处细节。',
  '勇敢直接，总能提出不同的观点。',
  '温柔坚定，善于倾听并总结信息。',
];
const BOARDS = {
  6: {
    title: '经典 6 人局',
    roles: ['狼人 × 2', '预言家 × 1', '女巫 × 1', '平民 × 2'],
    note: '2 狼 · 2 神 · 2 民，轻量入门。',
  },
  12: {
    title: '守卫猎人 12 人局',
    roles: ['狼人 × 4', '预言家 × 1', '女巫 × 1', '猎人 × 1', '守卫 × 1', '平民 × 4'],
    note: '4 狼 · 4 神 · 4 民，无警长标准局。',
  },
};
const Voices = NightfallVoices;
const Manor = NightfallManor,
  failedPortraits = new Set();
const PROFILE_STORAGE_KEY = 'nightfall-profiles-v1',
  PROFILE_SAVED_AT_KEY = 'nightfall-profiles-saved-at-v1';

let apiWaiting = null,
  apiWake = null,
  agentPending = null,
  agentRequestSequence = 0,
  watchRecordBefore = null,
  preparedSpeech = null,
  voteBatch = null;
const decisionConfigs = new WeakMap(),
  decisionAttempts = new WeakMap();
let profiles = loadProfiles();
let game = new Nightfall.Game(6),
  gameId = newGameId(),
  size = 6,
  view = 'table',
  ruleSize = 6,
  busy = false,
  epoch = 0,
  logCursor = 0,
  selectedAgent = 0,
  draftAvatar = '',
  lastFocus = null,
  lastConnectionTest = null;
let feed = [],
  transcript = [],
  toastTimer,
  activeRequest = null;
let paused = false,
  activeSeat = null,
  actionText = '',
  autoTask = null,
  runError = '',
  turnDelay = 1200,
  waitTimer = null,
  waitResolve = null;
let voiceEnabled = false,
  narration = null,
  voiceMessage = '',
  speechFailure = null,
  watchMode = false,
  nativeWatch = false,
  fullscreenPending = false,
  rulesIntroSize = 6,
  rulesFocus = null;
let connectionBatch = null,
  connectionTests = 0;

const phaseLabels = {
  lobby: '准备 · 等待入座',
  night: '夜晚 · 秘密行动',
  discussion: '白天 · 轮流发言',
  voting: '白天 · 公开投票',
  hunter: '技能 · 猎人开枪',
  ended: '终局 · 身份揭晓',
};

let agentPersistenceRevision = 0,
  agentConfigSyncChain = Promise.resolve();

// When the local service is reachable it keeps the DPAPI-encrypted secrets; the browser copy never stores keys.

// Newer browser data wins, but keys now live only in the local service: reuse its stored secrets,
// and rewrite legacy plaintext browser copies only after the service confirms the save.

const RECENT_HISTORY_ROUNDS = 2;

const voicePreviewTexts = {
  analysis: '我把前后两轮的发言对了一遍。现在还不能确定身份，我们先看理由，再看票型。',
  question: '等一下，你刚才的说法和上一轮不一样吧？为什么突然改票？我想听听你的解释。',
  defense: '我理解大家在怀疑我，但请先听我把话说完。我没有拿到查验信息，这一票是根据发言判断的。',
};

document.querySelectorAll('.room-option').forEach((b) =>
  b.addEventListener('click', () => {
    if (+b.dataset.room !== size) requestReset(+b.dataset.room);
  }),
);
document
  .querySelectorAll('.nav-item[data-view]')
  .forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
document.querySelectorAll('.rule-mode').forEach((b) =>
  b.addEventListener('click', () => {
    if (narration?.kind === 'rules') stopNarration();
    ruleSize = +b.dataset.rule;
    renderRules();
  }),
);
$('fullscreenBtn').addEventListener('click', toggleFullscreen);
$('voiceBtn').addEventListener('click', toggleDialogueVoice);
$('speechRetryBtn').addEventListener('click', retryFailedSpeech);
$('speechSkipBtn').addEventListener('click', continueSpeechWithoutAudio);
$('ruleIntroBtn').addEventListener('click', openRulesIntro);
$('readRulesBtn').addEventListener('click', () => readRules(ruleSize));
$('modalReadRulesBtn').addEventListener('click', () => readRules(rulesIntroSize));
$('closeRulesIntro').addEventListener('click', closeRulesIntro);
$('returnToTableBtn').addEventListener('click', closeRulesIntro);
$('rulesBackdrop').addEventListener('click', (e) => {
  if (e.target === $('rulesBackdrop')) closeRulesIntro();
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && nativeWatch) {
    nativeWatch = false;
    setWatchMode(false);
  }
});
document.addEventListener('keydown', (e) => {
  if (!$('rulesBackdrop').classList.contains('hidden')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeRulesIntro();
    }
    if (e.key === 'Tab') {
      const first = $('closeRulesIntro'),
        last = $('returnToTableBtn');
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (e.key === 'Escape' && watchMode && !document.fullscreenElement) void toggleFullscreen();
});
$('startBtn').addEventListener('click', start);
$('pauseBtn').addEventListener('click', togglePause);
$('speedInput').addEventListener('change', () => {
  turnDelay = Number($('speedInput').value);
});
$('resetBtn').addEventListener('click', () => requestReset());
$('actionPanel').addEventListener('click', (e) => {
  const command = e.target.closest('[data-command]')?.dataset.command;
  if (command === 'agents') switchView('agents');
  handleAPIWaitCommand(command);
});
$('playersGrid').addEventListener('click', (e) => {
  const replay = e.target.closest('[data-replay]');
  if (replay) {
    void replaySpeech(+replay.dataset.replay);
    return;
  }
  const button = e.target.closest('.seat-profile,.manor-art-button')?.closest('[data-player]');
  if (!button) return;
  const id = +button.dataset.player;
  recordSeat = String(id);
  recordTab = 'speeches';
  spectatorPrefs.railOpen = true;
  Object.assign(recordScroll.speeches, { top: 0, bottom: true, seen: 0 });
  saveSpectatorPrefs();
  renderTranscript();
  renderSpectator();
});
$('agentGrid').addEventListener('click', (e) => {
  const id = e.target.closest('[data-agent]')?.dataset.agent;
  if (id !== undefined) openAgent(+id);
});
$('profileBtn').addEventListener('click', () => openAgent(0));
$('voiceProviderInput').addEventListener('change', updateVoiceForm);
$('voicePreviewBtn').addEventListener('click', previewVoice);
$('modalClose').addEventListener('click', closeModal);
$('modalBackdrop').addEventListener('click', (e) => {
  if (e.target === $('modalBackdrop')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if ($('modalBackdrop').classList.contains('hidden')) return;
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Tab') {
    const items = [
      ...document.querySelectorAll('.modal button,.modal input,.modal select,.modal textarea'),
    ].filter((x) => !x.disabled);
    const first = items[0],
      last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
$('avatarPicker').addEventListener('click', (e) => {
  const a = e.target.closest('[data-avatar]')?.dataset.avatar;
  if (a) {
    draftAvatar = a;
    renderAvatarPicker();
  }
});
$('avatarUpload').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) {
    toast('请选择不大于 1MB 的 PNG、JPG 或 WebP 图片');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    if (!Avatar.valid(reader.result)) {
      toast('请选择不大于 1MB 的 PNG、JPG 或 WebP 图片');
      e.target.value = '';
      return;
    }
    draftAvatar = reader.result;
    renderAvatarPicker();
  };
  reader.readAsDataURL(file);
});
$('saveAgent').addEventListener('click', saveAgent);
$('testConnection').addEventListener('click', () => testConnection());
$('testAllBtn').addEventListener('click', testAll);
$('saveAllAgents').addEventListener('click', () => {
  if (persist(true)) toast('全部配置已保存；勾选记住的密钥将在本机游戏服务加密保存');
});
$('showKey').addEventListener('click', () => {
  const hidden = $('keyInput').type === 'password';
  $('keyInput').type = hidden ? 'text' : 'password';
  $('showKey').textContent = hidden ? '隐藏' : '显示';
});
$('copyRoomBtn').textContent = '↗ 导出对局记录';
$('copyRoomBtn').addEventListener('click', () => {
  const data = spectatorExport();
  const a = document.createElement('a'),
    url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
  a.href = url;
  a.download = '夜幕之下-对局记录.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('对局记录已导出，不包含密钥');
});
$('downloadGameLogBtn')?.addEventListener('click', async () => {
  try {
    const url = `/api/game-logs/${encodeURIComponent(gameId)}`;
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) {
      toast(
        response.status === 404
          ? '本局还没有 Agent 请求日志。'
          : '本局日志暂时不可下载，请稍后重试。',
      );
      return;
    }
    const link = document.createElement('a');
    link.href = url;
    link.download = `夜幕之下-${gameId}-Agent日志.jsonl`;
    link.click();
  } catch {
    toast('本局日志暂时不可下载，请稍后重试。');
  }
});
$('musicBtn').addEventListener('click', toggleMusic);
$('musicVolume').addEventListener('input', () => {
  music?.setVolume(Number($('musicVolume').value) / 100);
  renderMusicControls();
});
$('soundBtn').addEventListener('click', toggleEffects);
$('effectsBtn').addEventListener('click', toggleEffects);
$('effectsVolume').addEventListener('input', () => {
  effects?.setVolume(Number($('effectsVolume').value) / 100);
  renderEffectsControls();
});

const tips = [
  '观察同一名玩家前后两轮的观点有没有变化，通常比只听一句话更有用。',
  '女巫每晚只能用一瓶药，解药和毒药都只有一次。',
  '点击人物查看其完整发言；收起记录可获得更宽的圆桌视野。',
  '打开 Agent 配置，可以独立更换每个席位的头像、模型与性格。',
];
let tip = 0;
$('closeTip').textContent = '↻';
$('closeTip').title = '换一条提示';
$('closeTip').addEventListener('click', () => {
  $('tipText').textContent = tips[++tip % tips.length];
});
$('manorPortraitInput').addEventListener('change', () => {
  renderManorPreview();
  updateVoiceMatch();
});
$('voiceMatchInput').addEventListener('change', updateVoiceForm);
document.addEventListener(
  'error',
  (e) => {
    const img = e.target,
      id = img?.dataset?.portrait;
    if (img?.dataset?.eyePortrait) {
      failedEyePortraits.add(img.dataset.eyePortrait);
      img.style.display = 'none';
      return;
    }
    if (id && Manor.imagePath(id) && !failedPortraits.has(id)) {
      failedPortraits.add(id);
      renderPlayers();
      renderTranscript();
    } else if (img?.dataset?.manorAsset) {
      img.classList.add('asset-failed');
    }
  },
  true,
);
for (const img of document.querySelectorAll('img[data-manor-asset]'))
  if (img.complete && !img.naturalWidth) img.classList.add('asset-failed');
initSpectator();
if (typeof initPortrait === 'function') initPortrait();
reset();
if (typeof initStory === 'function') initStory();
if (typeof initRecording === 'function') initRecording();
void restoreAgentProfiles();
