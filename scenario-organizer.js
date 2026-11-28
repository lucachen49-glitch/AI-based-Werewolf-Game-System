'use strict';

let agents = [],
  temporaryOrganizerKey = '',
  temporaryOrganizerSignature = '';

function organizerSignature(profile) {
  return profile ? `${profile.seat}|${profile.endpoint}|${profile.model}` : '';
}

function selectedOrganizer() {
  return agents[Number($('organizer')?.value)] || null;
}

function organizerAgent(profile = selectedOrganizer()) {
  if (!profile) return null;
  const signature = organizerSignature(profile);
  const key =
    profile.key || (temporaryOrganizerSignature === signature ? temporaryOrganizerKey : '');
  return { ...profile, key };
}

function organizerCredential(agent) {
  return agent.key
    ? { apiKey: agent.key }
    : agent.hasKey
      ? { profileSeat: agent.seat }
      : { apiKey: '' };
}

function updateOrganizerCredentialStatus() {
  const profile = selectedOrganizer(),
    agent = organizerAgent(profile),
    label = $('organizerTemporaryKeyLabel'),
    input = $('organizerTemporaryKey'),
    status = $('organizerStatus');
  if (label) label.hidden = !profile || !!(profile.key || profile.hasKey);
  if (input) {
    const value =
      profile &&
      !(profile.key || profile.hasKey) &&
      temporaryOrganizerSignature === organizerSignature(profile)
        ? temporaryOrganizerKey
        : '';
    if (input.value !== value) input.value = value;
  }
  if (!status) return;
  if (!agents.length) {
    status.textContent =
      '尚未找到可用的 API Agent。请返回游戏 Agent 配置页补全接口地址和模型后刷新。';
    return;
  }
  if (agent?.key || agent?.hasKey) {
    status.textContent =
      profile.key || profile.hasKey
        ? '当前整理 Agent 已配置密钥。密钥仅用于本次请求。'
        : '临时密钥仅保存在当前页面内存，关闭或刷新页面后自动清除。';
    return;
  }
  status.textContent =
    '当前整理 Agent 未保存密钥。请在此输入本次临时密钥，或返回游戏 Agent 配置页完成配置。';
}

let organizerRefreshEpoch = 0;
async function refreshOrganizerAgents() {
  const epoch = ++organizerRefreshEpoch;
  const select = $('organizer'),
    previous = agents[Number(select?.value)],
    previousKey = previous ? `${previous.seat}|${previous.endpoint}|${previous.model}` : '';
  let profiles = [];
  try {
    const saved = JSON.parse(localStorage.getItem('nightfall-profiles-v1') || '[]');
    profiles = Array.isArray(saved) ? saved : Object.values(saved || {});
  } catch {}
  try {
    const response = await fetch('/api/agent-config', { cache: 'no-store' });
    const remote = await response.json();
    if (epoch !== organizerRefreshEpoch) return agents;
    if (response.ok && remote.configured && Array.isArray(remote.profiles)) {
      const localTime = Date.parse(localStorage.getItem('nightfall-profiles-saved-at-v1') || '');
      profiles =
        localTime > Date.parse(remote.savedAt)
          ? profiles.map((profile, i) => ({
              ...profile,
              hasKey:
                profile.endpoint === remote.profiles[i]?.endpoint && remote.profiles[i]?.hasKey,
              keyRevision: remote.profiles[i]?.keyRevision || 0,
            }))
          : remote.profiles;
    }
  } catch {}
  if (epoch !== organizerRefreshEpoch) return agents;
  const eligible = profiles.filter((profile, index) => index < 12 && profile?.control === 'api');
  agents = eligible
    .filter((profile) => profile.endpoint && profile.model)
    .map((profile, index) => ({
      seat: profiles.indexOf(profile) + 1,
      ...profile,
      reasoningEffort: NightfallAgentRequest.normalizeReasoningEffort(profile.reasoningEffort),
    }));
  if (!select) return agents;
  if (agents.length) {
    // eslint-disable-next-line no-unsanitized/property -- Dynamic story text and URLs are escaped, with remaining values fixed enums or numeric indices.
    select.innerHTML = agents
      .map(
        (a, i) =>
          `<option value="${i}">${a.seat} 号 · ${esc(a.name || '未命名 Agent')} / ${esc(a.model)}</option>`,
      )
      .join('');
    const keep = agents.findIndex((a) => `${a.seat}|${a.endpoint}|${a.model}` === previousKey);
    select.value = String(keep >= 0 ? keep : 0);
  } else select.innerHTML = '<option value="">暂无可用整理 Agent</option>';
  updateOrganizerCredentialStatus();
  updateButtons();
  return agents;
}
