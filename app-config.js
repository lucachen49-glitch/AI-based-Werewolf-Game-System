'use strict';

let agentProfileRestorePromise = null;
let agentConfigBaseSavedAt;

const sameCredentialEndpoint = (left, right, kind) =>
  NightfallAgentRequest.credentialEndpoint(left, kind) ===
  NightfallAgentRequest.credentialEndpoint(right, kind);

function newGameId() {
  const id = globalThis.crypto?.randomUUID?.();
  return id || `game-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readLocalProfileRecord() {
  let profiles = null;
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || 'null');
    if (Array.isArray(value) || (value && typeof value === 'object')) profiles = value;
  } catch {}
  let savedAt = localStorage.getItem(PROFILE_SAVED_AT_KEY) || null;
  if (savedAt && !Number.isFinite(Date.parse(savedAt))) savedAt = null;
  return { profiles, savedAt };
}

function buildProfiles(saved) {
  const source = Array.isArray(saved) || (saved && typeof saved === 'object') ? saved : {};
  return Array.from({ length: 12 }, (_, i) => {
    const stored = source[i] && typeof source[i] === 'object' ? source[i] : {};
    const rememberKey = stored.rememberKey !== false;
    const reasoningEffort = NightfallAgentRequest.normalizeReasoningEffort(stored.reasoningEffort);
    const historyContext = stored.historyContext === 'full' ? 'full' : 'recent';
    return {
      name: NAMES[i],
      avatar: AVATARS[i],
      control: 'local',
      endpoint: '',
      model: '',
      personality: PERSONALITIES[i % 6],
      ...stored,
      reasoningEffort,
      historyContext,
      profileSeat: i + 1,
      hasKey: !!stored.hasKey,
      hasVoiceKey: !!stored.hasVoiceKey,
      keyRevision: stored.keyRevision || 0,
      voiceKeyRevision: stored.voiceKeyRevision || 0,
      ...Voices.settings(stored, i),
      avatar: Avatar.normalize(stored.avatar, i),
      voiceMatch: Manor.voiceMatchMode(stored, i, Voices.defaults(i)),
      manorPortrait: Manor.normalize(stored.manorPortrait, i),
      rememberKey,
      key: rememberKey && typeof stored.key === 'string' ? stored.key : '',
      voiceKey:
        stored.rememberVoiceKey !== false && typeof stored.voiceKey === 'string'
          ? stored.voiceKey
          : '',
      connection: 'untested',
      connectionError: '',
    };
  });
}

function loadProfiles() {
  return buildProfiles(readLocalProfileRecord().profiles);
}

function agentConfigServiceAvailable() {
  return (
    typeof location !== 'undefined' &&
    location.protocol === 'http:' &&
    location.origin &&
    location.origin !== 'null'
  );
}

function serializedProfilesFor(value, { includeSecrets = true } = {}) {
  return value.map(({ key, voiceKey, connection, connectionError, ...p }) => ({
    ...p,
    ...(includeSecrets && p.rememberKey && key ? { key } : {}),
    ...(p.rememberKey === false ? { clearKey: true } : {}),
    ...(includeSecrets && p.rememberVoiceKey !== false && voiceKey ? { voiceKey } : {}),
    ...(p.rememberVoiceKey === false ? { clearVoiceKey: true } : {}),
  }));
}

function serializedProfiles() {
  return serializedProfilesFor(profiles);
}

function localProfileCopy(data, migrated = false) {
  const legacy = migrated ? null : readLocalProfileRecord().profiles;
  const strip = (p, i) => {
    if (!p || typeof p !== 'object') return p;
    const { key, voiceKey, ...rest } = p;
    const old = legacy?.[i];
    return {
      ...rest,
      ...(old?.key &&
      p.rememberKey !== false &&
      !p.clearKey &&
      sameCredentialEndpoint(old.endpoint, p.endpoint, 'agent')
        ? { key: old.key }
        : {}),
      ...(old?.voiceKey &&
      p.rememberVoiceKey !== false &&
      !p.clearVoiceKey &&
      sameCredentialEndpoint(old.voiceEndpoint, p.voiceEndpoint, 'voice')
        ? { voiceKey: old.voiceKey }
        : {}),
    };
  };
  return Array.isArray(data)
    ? data.map(strip)
    : data && typeof data === 'object'
      ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, strip(v, k)]))
      : data;
}

function localProfilesHaveSecrets(saved) {
  const source = Array.isArray(saved)
    ? saved
    : saved && typeof saved === 'object'
      ? Object.values(saved)
      : [];
  return source.some(
    (p) =>
      p &&
      typeof p === 'object' &&
      ((typeof p.key === 'string' && p.key) || (typeof p.voiceKey === 'string' && p.voiceKey)),
  );
}

function writeLocalProfiles(data, savedAt, migrated = false) {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(localProfileCopy(data, migrated)));
  if (savedAt) localStorage.setItem(PROFILE_SAVED_AT_KEY, savedAt);
}

function queueAgentConfigSync(data, clientSavedAt, onSaved) {
  if (!agentConfigServiceAvailable()) return;
  agentConfigSyncChain = agentConfigSyncChain.then(async () => {
    try {
      const response = await fetch('/api/agent-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          profiles: data,
          clientSavedAt,
          baseSavedAt: agentConfigBaseSavedAt,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(body.error?.message || '本机 Agent 配置保存失败，浏览器中的配置仍可使用');
        return;
      }
      if (body.savedAt) agentConfigBaseSavedAt = body.savedAt;
      if (Array.isArray(body.profiles)) {
        body.profiles.forEach((stored, i) => {
          const current = profiles[i],
            sent = data[i];
          if (JSON.stringify(serializedProfilesFor([current])) !== JSON.stringify([sent])) return;
          Object.assign(current, {
            hasKey: stored.hasKey,
            hasVoiceKey: stored.hasVoiceKey,
            keyRevision: stored.keyRevision,
            voiceKeyRevision: stored.voiceKeyRevision,
          });
          // Newly entered keys stay in page memory so in-flight signatures remain stable.
        });
        writeLocalProfiles(serializedProfiles(), readLocalProfileRecord().savedAt, true);
      }
      if (typeof onSaved === 'function') onSaved(body);
    } catch {
      toast('本机 Agent 配置保存失败，浏览器中的配置仍可使用');
    }
  });
}

function persist(sync = false) {
  const data = serializedProfiles(),
    savedAt = new Date().toISOString();
  try {
    writeLocalProfiles(data, savedAt);
    agentPersistenceRevision++;
    if (sync) queueAgentConfigSync(data, savedAt);
    return true;
  } catch {
    toast('本地存储空间不足，请缩小头像图片后重试');
    return false;
  }
}

function adoptLocalProfiles(local, remote, revision) {
  const merged = buildProfiles(local.profiles),
    stored = remote?.profiles ? buildProfiles(remote.profiles) : null,
    savedAt = local.savedAt || new Date().toISOString();
  if (stored)
    merged.forEach((p, i) => {
      const agentMatches = sameCredentialEndpoint(p.endpoint, stored[i].endpoint, 'agent');
      const voiceMatches = sameCredentialEndpoint(
        p.voiceEndpoint,
        stored[i].voiceEndpoint,
        'voice',
      );
      if (!p.key && p.rememberKey && agentMatches && stored[i].key) p.key = stored[i].key;
      if (!p.voiceKey && p.rememberVoiceKey !== false && voiceMatches && stored[i].voiceKey)
        p.voiceKey = stored[i].voiceKey;
      p.hasKey = p.rememberKey && agentMatches && stored[i].hasKey;
      p.hasVoiceKey = p.rememberVoiceKey !== false && voiceMatches && stored[i].hasVoiceKey;
      p.keyRevision = stored[i].keyRevision;
      p.voiceKeyRevision = stored[i].voiceKeyRevision;
    });
  if (revision === agentPersistenceRevision) {
    let filled = false;
    profiles.forEach((p, i) => {
      p.hasKey = merged[i].hasKey;
      p.hasVoiceKey = merged[i].hasVoiceKey;
      p.keyRevision = merged[i].keyRevision;
      p.voiceKeyRevision = merged[i].voiceKeyRevision;
      if (!p.key && p.rememberKey && merged[i].key) {
        p.key = merged[i].key;
        filled = true;
      }
      if (!p.voiceKey && p.rememberVoiceKey !== false && merged[i].voiceKey) {
        p.voiceKey = merged[i].voiceKey;
        filled = true;
      }
    });
    if (filled) renderAll();
  }
  const legacy = localProfilesHaveSecrets(local.profiles);
  queueAgentConfigSync(serializedProfilesFor(merged), savedAt, () => {
    if (!legacy) return;
    const current = readLocalProfileRecord();
    if (current.profiles && current.savedAt === local.savedAt)
      writeLocalProfiles(current.profiles, current.savedAt, true);
  });
}

function restoreAgentProfiles() {
  if (!agentConfigServiceAvailable()) return Promise.resolve();
  if (agentProfileRestorePromise) return agentProfileRestorePromise;
  const restorePromise = (async () => {
    const revision = agentPersistenceRevision,
      local = readLocalProfileRecord();
    try {
      const response = await fetch('/api/agent-config', { cache: 'no-store' });
      const remote = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(remote.error?.message || '本机 Agent 配置暂不可用');
      agentConfigBaseSavedAt = remote.savedAt || null;
      if (remote.configured && Array.isArray(remote.profiles)) {
        const localTime = local.savedAt ? Date.parse(local.savedAt) : NaN,
          remoteTime = remote.savedAt ? Date.parse(remote.savedAt) : NaN;
        if (
          local.profiles &&
          Number.isFinite(localTime) &&
          Number.isFinite(remoteTime) &&
          localTime > remoteTime
        ) {
          adoptLocalProfiles(local, remote, revision);
          return;
        }
        if (revision !== agentPersistenceRevision) return;
        if (localProfilesHaveSecrets(local.profiles)) {
          const migrated = buildProfiles(remote.profiles);
          const legacy = buildProfiles(local.profiles);
          let conflict = false;
          migrated.forEach((p, i) => {
            for (const [key, endpoint, flag] of [
              ['key', 'endpoint', 'hasKey'],
              ['voiceKey', 'voiceEndpoint', 'hasVoiceKey'],
            ]) {
              if (!legacy[i][key]) continue;
              if (legacy[i][endpoint] !== p[endpoint]) {
                conflict = true;
                continue;
              }
              if (!p[flag]) p[key] = legacy[i][key];
            }
          });
          if (conflict) {
            toast(
              '本机配置已更新，浏览器旧密钥对应的接口不同，已保留浏览器旧配置。请核对接口与密钥后保存。',
            );
            return;
          }
          profiles = migrated;
          renderAll();
          queueAgentConfigSync(serializedProfiles(), new Date().toISOString(), () => {
            if (revision === agentPersistenceRevision)
              writeLocalProfiles(serializedProfiles(), remote.savedAt, true);
          });
          return;
        }
        profiles = buildProfiles(remote.profiles);
        writeLocalProfiles(serializedProfiles(), remote.savedAt || new Date().toISOString(), true);
        renderAll();
        return;
      }
      if (local.profiles) adoptLocalProfiles(local, null, revision);
    } catch {}
  })().finally(() => {
    if (agentProfileRestorePromise === restorePromise) agentProfileRestorePromise = null;
  });
  agentProfileRestorePromise = restorePromise;
  return restorePromise;
}

function openAgent(id) {
  if (connectionBatch || connectionTests) {
    toast('正在测试连接，请等待测试完成后修改配置');
    return;
  }
  if (busy && !paused && !apiWaiting) {
    toast('请先暂停对局，再修改席位配置');
    return;
  }
  if (typeof recordingOpenConfig === 'function') recordingOpenConfig();
  selectedAgent = id;
  lastConnectionTest = null;
  const p = profiles[id];
  draftAvatar = p.avatar;
  lastFocus = document.activeElement;
  $('modalTitle').textContent = `${id + 1} 号 · ${p.name}`;
  $('modalSubtitle').textContent = '独立配置形象、人格与模型，不会暴露本局身份。';
  $('nameInput').value = p.name;
  $('controlInput').value = p.control;
  $('modelInput').value = p.model;
  $('endpointInput').value = p.endpoint;
  $('reasoningEffortInput').value = NightfallAgentRequest.normalizeReasoningEffort(
    p.reasoningEffort,
  );
  $('historyContextInput').value = p.historyContext === 'full' ? 'full' : 'recent';
  $('keyInput').value = p.key;
  $('keyInput').placeholder = p.hasKey ? '已由本机加密保存，留空继续使用' : '输入 API 密钥';
  $('rememberKeyInput').checked = p.rememberKey;
  $('keyInput').type = 'password';
  $('showKey').textContent = '显示';
  $('personalityInput').value = p.personality;
  $('avatarUpload').value = '';
  fillVoiceForm(p, id);
  fillManorForm(p, id);
  updateVoiceMatch();
  $('connectionState').textContent =
    'API 协议 · Responses，支持网站地址、/v1 或完整路径，测试会产生一次请求';
  renderAvatarPicker();
  $('modalBackdrop').classList.remove('hidden');
  $('nameInput').focus();
}

function fillManorForm(profile, seat) {
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('manorPortraitInput').innerHTML =
    Manor.portraits
      .map(
        (p) =>
          '<option value="' +
          esc(p.id) +
          '">' +
          esc(p.name + ' · ' + p.description + (p.pending ? '（立绘待制作）' : '')) +
          '</option>',
      )
      .join('') + '<option value="avatar">使用当前头像</option>';
  $('manorPortraitInput').value = Manor.normalize(profile.manorPortrait, seat);
  renderManorPreview();
}

function renderManorPreview() {
  const id = $('manorPortraitInput').value,
    art = Manor.portraits.find((p) => p.id === id);
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('manorPortraitPreview').innerHTML =
    art && !art.pending
      ? '<img src="' +
        esc(Manor.imagePath(id, true)) +
        '" alt="' +
        esc(art.name) +
        '"><span>' +
        esc(art.description) +
        '<small>6 / 12 人间通用 · 外观不代表身份</small></span>'
      : '<span>使用当前卡通头像<small>新增六位专属立绘待确认制作；原头像与配置保留</small></span>';
}

function renderAvatarPicker() {
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('avatarPicker').innerHTML =
    AVATARS.map(
      (a) =>
        `<button class="avatar-option ${draftAvatar === a ? 'selected' : ''}" data-avatar="${esc(a)}" aria-label="选择 ${esc(a)}">${esc(a)}</button>`,
    ).join('') +
    (Avatar.valid(draftAvatar) && draftAvatar.startsWith('data:')
      ? `<img class="uploaded-preview" src="${esc(draftAvatar)}" alt="已上传的头像">`
      : '');
}

function modalProfile() {
  const previous = profiles[selectedAgent];
  const next = {
    ...previous,
    name: $('nameInput').value.trim() || NAMES[selectedAgent],
    avatar: Avatar.normalize(draftAvatar, selectedAgent),
    manorPortrait: Manor.normalize($('manorPortraitInput').value, selectedAgent),
    control: $('controlInput').value,
    model: $('modelInput').value.trim(),
    endpoint: $('endpointInput').value.trim(),
    reasoningEffort: NightfallAgentRequest.normalizeReasoningEffort(
      $('reasoningEffortInput').value,
    ),
    historyContext: $('historyContextInput').value === 'full' ? 'full' : 'recent',
    key: $('keyInput').value.trim(),
    rememberKey: $('rememberKeyInput').checked,
    personality: $('personalityInput').value.trim() || PERSONALITIES[selectedAgent % 6],
    ...voiceForm(),
    connection: 'untested',
    connectionError: '',
  };
  for (const [endpoint, key, saved, kind] of [
    ['endpoint', 'key', 'hasKey', 'agent'],
    ['voiceEndpoint', 'voiceKey', 'hasVoiceKey', 'voice'],
  ]) {
    if (sameCredentialEndpoint(previous[endpoint], next[endpoint], kind)) continue;
    if (next[key] === previous[key]) next[key] = '';
    next[saved] = false;
  }
  return next;
}

function updateCredentialInput(kind) {
  const voice = kind === 'voice';
  const previous = profiles[selectedAgent];
  const endpoint = $(voice ? 'voiceEndpointInput' : 'endpointInput').value.trim();
  const key = $(voice ? 'voiceKeyInput' : 'keyInput');
  if (sameCredentialEndpoint(endpoint, voice ? previous.voiceEndpoint : previous.endpoint, kind))
    return;
  if (key.value === (voice ? previous.voiceKey : previous.key)) key.value = '';
  key.placeholder = '地址已更换，请填写该地址的密钥';
}

function fillVoiceForm(profile, seat) {
  const p = Voices.settings(profile, seat);
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('voiceProviderInput').innerHTML = Object.entries(Voices.providers)
    .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`)
    .join('');
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('playerVoiceInput').innerHTML = Voices.voices
    .map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`)
    .join('');
  // eslint-disable-next-line no-unsanitized/property -- Values are escaped or come from local render helpers that escape dynamic content.
  $('voiceStyleInput').innerHTML = Object.entries(Voices.styles)
    .map(([id, s]) => `<option value="${esc(id)}">${esc(s.name)}</option>`)
    .join('');
  for (const [id, key] of [
    ['voiceProviderInput', 'voiceProvider'],
    ['playerVoiceInput', 'voice'],
    ['voiceStyleInput', 'voiceStyle'],
    ['voiceSpeedInput', 'voiceSpeed'],
    ['voiceEndpointInput', 'voiceEndpoint'],
    ['voiceModelInput', 'voiceModel'],
    ['voiceApiVoiceInput', 'voiceApiVoice'],
    ['voiceKeyInput', 'voiceKey'],
  ])
    $(id).value = p[key];
  $('voiceMatchInput').value = profile.voiceMatch || 'custom';
  $('rememberVoiceKeyInput').checked = p.rememberVoiceKey;
  $('voiceKeyInput').placeholder = p.hasVoiceKey
    ? '已由本机加密保存，留空继续使用'
    : '语音服务专用密钥';
  $('voicePreviewStatus').textContent = '试听当前设置，满意后点击保存配置。';
  updateVoiceForm();
}

function seatVoice(profile, seat) {
  const rec =
    profile.voiceMatch === 'portrait' ? Manor.recommendedVoice(profile, seat, size) : null;
  return rec
    ? { ...profile, voiceProvider: 'neural', voice: rec.voice, voiceStyle: 'auto', voiceSpeed: 1 }
    : profile;
}

function voiceForm() {
  const automatic =
      $('voiceMatchInput').value === 'portrait' &&
      Manor.recommendedVoice({ manorPortrait: $('manorPortraitInput').value }, selectedAgent, 6),
    stored = profiles[selectedAgent];
  return {
    voiceMatch: $('voiceMatchInput').value,
    voiceProvider: automatic ? stored.voiceProvider : $('voiceProviderInput').value,
    voice: automatic ? stored.voice : $('playerVoiceInput').value,
    voiceStyle: automatic ? stored.voiceStyle : $('voiceStyleInput').value,
    voiceSpeed: automatic ? stored.voiceSpeed : Number($('voiceSpeedInput').value),
    voiceEndpoint: $('voiceEndpointInput').value.trim(),
    voiceModel: $('voiceModelInput').value.trim(),
    voiceApiVoice: $('voiceApiVoiceInput').value.trim(),
    voiceKey: $('voiceKeyInput').value.trim(),
    rememberVoiceKey: $('rememberVoiceKeyInput').checked,
  };
}

function updateVoiceMatch() {
  const rec = Manor.recommendedVoice(
      { manorPortrait: $('manorPortraitInput').value },
      selectedAgent,
      6,
    ),
    auto = $('voiceMatchInput').value === 'portrait';
  if (auto && !rec) {
    const stored = profiles[selectedAgent];
    for (const [id, key] of [
      ['voiceProviderInput', 'voiceProvider'],
      ['playerVoiceInput', 'voice'],
      ['voiceStyleInput', 'voiceStyle'],
      ['voiceSpeedInput', 'voiceSpeed'],
    ])
      $(id).value = stored[key];
    $('neuralVoiceFields').classList.toggle('hidden', stored.voiceProvider !== 'neural');
    $('apiVoiceFields').classList.toggle('hidden', stored.voiceProvider !== 'api');
  }
  $('voiceMatchNote').textContent =
    auto && rec
      ? rec.description + '；6 / 12 人间发言和试听使用此推荐。'
      : auto
        ? '当前使用头像，沿用席位声音。'
        : '保留你的自定义音色、情绪与语速。';
  for (const id of ['voiceProviderInput', 'playerVoiceInput', 'voiceStyleInput', 'voiceSpeedInput'])
    $(id).disabled = !!(auto && rec);
  if ($('voiceProviderInput').value === 'system') $('voiceStyleInput').disabled = true;
  if (auto && rec) {
    $('voiceProviderInput').value = 'neural';
    $('playerVoiceInput').value = rec.voice;
    $('voiceStyleInput').value = 'auto';
    $('voiceSpeedInput').value = 1;
    $('neuralVoiceFields').classList.remove('hidden');
    $('apiVoiceFields').classList.add('hidden');
    $('voiceHelp').textContent =
      '推荐声音随庄园立绘切换，自动按对白内容调整语气。切换为自定义可另选音色。';
  }
}

function updateVoiceForm() {
  const provider = $('voiceProviderInput').value;
  $('neuralVoiceFields').classList.toggle('hidden', provider !== 'neural');
  $('apiVoiceFields').classList.toggle('hidden', provider !== 'api');
  $('voiceStyleInput').disabled = provider === 'system';
  $('voiceHelp').textContent =
    provider === 'api'
      ? '独立语音服务，需支持 MP3 和情绪指令。填写语音模型及音色 ID；语音密钥单独保存，不使用聊天密钥。'
      : provider === 'neural'
        ? '自然合成音色，需联网；随语气调整节奏和音高。免费声音仅有限调整停顿、语速与音高，不支持完整情绪表演。港澳音色使用粤语。'
        : '系统基础朗读的自然度取决于浏览器，不支持情绪表演。';
  updateVoiceMatch();
  if (provider === 'system' && $('voiceMatchInput').value !== 'portrait')
    $('voiceStyleInput').disabled = true;
}

async function previewVoice() {
  if (narration?.kind === 'preview') {
    stopNarration();
    $('voicePreviewStatus').textContent = '试听已停止';
    return;
  }
  const profile = seatVoice(modalProfile(), selectedAgent);
  await speakText(
    voicePreviewTexts[$('voicePreviewTextInput').value] || voicePreviewTexts.analysis,
    { kind: 'preview', seat: selectedAgent, profile },
  );
}

function requestCredential(profile, kind = 'agent') {
  const key = kind === 'voice' ? profile.voiceKey : profile.key;
  const configured = kind === 'voice' ? profile.hasVoiceKey : profile.hasKey;
  return key
    ? { apiKey: key }
    : configured && profile.profileSeat
      ? { profileSeat: profile.profileSeat }
      : { apiKey: '' };
}

function connectionSignature(p) {
  return JSON.stringify([
    p.control,
    p.endpoint,
    p.model,
    p.key || p.keyRevision || '',
    p.reasoningEffort,
  ]);
}

function saveAgent() {
  if (connectionBatch || connectionTests) {
    toast('请等待连接测试完成后保存配置');
    return;
  }
  const p = modalProfile(),
    previous = profiles[selectedAgent];
  if (lastConnectionTest?.signature === connectionSignature(p)) {
    p.connection = lastConnectionTest.connection;
    p.connectionError = lastConnectionTest.connectionError || '';
  } else if (connectionSignature(previous) === connectionSignature(p)) {
    p.connection = previous.connection;
    p.connectionError = previous.connectionError;
  }
  if (p.control === 'api' && (!p.endpoint || !p.model)) {
    toast('请填写接口地址与模型名称');
    return;
  }
  profiles[selectedAgent] = p;
  if (!persist(true)) {
    profiles[selectedAgent] = previous;
    return;
  }
  invalidateVoteAgent(selectedAgent);
  const preparationChanged =
    preparedSpeech?.id === selectedAgent && speechConfigSignature(p) !== preparedSpeech.signature;
  if (preparationChanged) {
    preparedSpeech.invalidated = true;
    preparedSpeech.status = 'failed';
  }
  if (
    agentPending?.id === selectedAgent &&
    (preparationChanged || connectionSignature(previous) !== connectionSignature(p))
  ) {
    agentPending.stopCode = 'AGENT_CONFIG_CHANGED';
    agentPending.controller.abort();
  } else if (apiWaiting?.id === selectedAgent) wakeAPIWait();
  closeModal();
  renderAll();
  toast(
    `${p.name} 的配置已保存；${p.rememberKey ? '密钥由本机服务加密保存' : '密钥仅在本次页面使用，已删除本地保存'}`,
  );
}

function closeModal() {
  if (narration?.kind === 'preview') stopNarration();
  $('modalBackdrop').classList.add('hidden');
  if (view === 'table' && typeof recordingCloseConfig === 'function') recordingCloseConfig();
  lastFocus?.focus();
}

async function testConnection(profile = modalProfile(), updateModal = true, batchRequest = false) {
  if (busy) {
    toast('请在对局结束或重置后测试连接');
    return false;
  }
  if ((connectionTests && !batchRequest) || (connectionBatch && updateModal)) {
    toast('正在测试连接，请等待当前测试完成');
    return false;
  }
  const begin = performance.now(),
    batch = batchRequest ? connectionBatch : null,
    seat = profiles.indexOf(profile),
    savedProfile = updateModal ? profiles[selectedAgent] : profile,
    signature = connectionSignature(profile),
    requestController = batch ? new AbortController() : null;
  if (batch) {
    batch.controllers.add(requestController);
    batch.activeSeats.add(seat);
    batch.seat = seat;
  }
  const update = (state, error = '') => {
    profile.connection = state;
    profile.connectionError = error;
    // A draft only updates a saved card when it tests the exact same API settings.
    if (
      savedProfile !== profile &&
      profiles.includes(savedProfile) &&
      connectionSignature(savedProfile) === signature
    ) {
      savedProfile.connection = state;
      savedProfile.connectionError = error;
    }
    renderConnectionViews();
  };
  connectionTests++;
  update('testing');
  if (updateModal) $('connectionState').textContent = '正在请求接口…';
  try {
    if (profile.control !== 'api') throw Error('当前选择的是本地模拟，请先切换为 API Agent');
    await apiCall(profile, [{ role: 'user', content: 'Reply with OK.' }], {
      requestController,
    });
    if (batch?.cancelled || batch?.blockedReason) {
      update('untested');
      return false;
    }
    update('ok');
    const text = `连接成功 · ${Math.round(performance.now() - begin)}ms`;
    if (updateModal) $('connectionState').textContent = text;
    if (!batch) toast(text);
    return true;
  } catch (e) {
    if (batch?.cancelled || batch?.blockedReason) {
      update('untested');
      return false;
    }
    const msg = e.name === 'AbortError' ? '请求超时或已取消' : e.message;
    if (batch && e.code === 'GAME_REQUESTS_ACTIVE') {
      batch.blockedReason = msg;
      for (const controller of batch.controllers)
        if (controller !== requestController) controller.abort();
      update('untested', msg);
      if (updateModal) $('connectionState').textContent = msg;
      return false;
    }
    update('error', msg);
    if (updateModal) $('connectionState').textContent = msg;
    if (!batch) toast(`连接失败：${msg}`);
    return false;
  } finally {
    connectionTests--;
    if (batch) {
      batch.controllers.delete(requestController);
      batch.activeSeats.delete(seat);
      batch.completed++;
      batch.seat = batch.activeSeats.values().next().value ?? null;
    }
    if (updateModal)
      lastConnectionTest = {
        signature,
        connection: profile.connection,
        connectionError: profile.connectionError,
      };
    renderConnectionViews();
  }
}

async function testAll() {
  if (busy) {
    toast('请在对局结束或重置后测试连接');
    return;
  }
  if (connectionBatch || connectionTests) {
    toast('正在测试连接，请等待当前测试完成');
    return;
  }
  const api = profiles.slice(0, size).filter((p) => p.control === 'api');
  if (!api.length) {
    toast('尚未配置 API Agent，本地模拟无需连接');
    return;
  }
  const batch = {
    completed: 0,
    total: api.length,
    seat: null,
    activeSeats: new Set(),
    controllers: new Set(),
    nextIndex: 0,
    cancelled: false,
    blockedReason: '',
  };
  connectionBatch = batch;
  let ok = 0;
  for (const p of api) {
    p.connection = 'queued';
    p.connectionError = '';
  }
  renderConnectionViews();
  try {
    async function worker() {
      while (!batch.cancelled && !batch.blockedReason) {
        const index = batch.nextIndex++;
        if (index >= api.length) return;
        if (await testConnection(api[index], false, true)) ok++;
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, api.length) }, () => worker()));
  } finally {
    for (const p of api)
      if (['queued', 'testing'].includes(p.connection)) {
        p.connection = 'untested';
        p.connectionError = '';
      }
    connectionBatch = null;
    renderConnectionViews();
  }
  toast(
    batch.cancelled
      ? '连接测试已停止'
      : batch.blockedReason || `${ok} / ${api.length} 个 API Agent 连接成功`,
  );
}
