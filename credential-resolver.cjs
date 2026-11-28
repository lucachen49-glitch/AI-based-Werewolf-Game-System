'use strict';
const { AgentConfigError } = require('./agent-config.cjs');
const AgentRequest = require('./agent-request.js');
const { normalizeSpeechEndpoint } = require('./voice.cjs');
function createCredentialResolver(store) {
  return async (body, kind = 'agent') => {
    if (
      !body ||
      body.profileSeat === undefined ||
      (typeof body.apiKey === 'string' && body.apiKey.trim())
    )
      return body;
    if (!Number.isInteger(body.profileSeat) || body.profileSeat < 1 || body.profileSeat > 12)
      throw new AgentConfigError(400, 'INVALID_PROFILE_SEAT', 'Agent 席位需要在 1 至 12 之间。');
    const profile = store.credential
      ? null
      : (await store.load())?.profiles?.[body.profileSeat - 1];
    const credential = store.credential
      ? await store.credential(body.profileSeat, kind)
      : {
          endpoint: kind === 'voice' ? profile?.voiceEndpoint : profile?.endpoint,
          apiKey: (kind === 'voice' ? profile?.voiceKey : profile?.key) || '',
        };
    const normalize = kind === 'voice' ? normalizeSpeechEndpoint : AgentRequest.responsesEndpoint;
    let matches = false;
    try {
      matches =
        !!credential.endpoint && normalize(body.endpoint) === normalize(credential.endpoint);
    } catch {}
    if (!matches)
      throw new AgentConfigError(409, 'PROFILE_CHANGED', '配置已修改，请先保存后重试。');
    return { ...body, apiKey: credential.apiKey };
  };
}
module.exports = { createCredentialResolver };
