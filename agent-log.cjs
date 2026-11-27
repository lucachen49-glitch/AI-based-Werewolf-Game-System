'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { cleanSystemLogs } = require('./system-logs.cjs');
const tasks = new Set(['speech', 'night', 'vote', 'hunter']);
const events = new Set([
  'started',
  'response_received',
  'failed',
  'cancelled',
  'validation_failed',
  'stopped',
  'action_validated',
]);

const validationRules = {
  ACTION_OBJECT_REQUIRED: {
    field: 'action',
    expected: 'object',
    reason: '行动结果必须是 JSON 对象',
  },
  SPEECH_REQUIRED: {
    field: 'speech',
    expected: 'non_empty_string',
    reason: '缺少 speech 发言字段',
  },
  SPEECH_TYPE: { field: 'speech', expected: 'non_empty_string', reason: 'speech 字段必须是字符串' },
  SPEECH_EMPTY: {
    field: 'speech',
    expected: 'non_empty_string',
    reason: 'speech 发言为空或仅有空白',
  },
  TARGET_REQUIRED: { field: 'target', expected: 'seat_or_null', reason: '缺少 target 目标字段' },
  TARGET_TYPE: {
    field: 'target',
    expected: 'seat_or_null',
    reason: 'target 必须是整数座位号或 null',
  },
  TARGET_OUT_OF_RANGE: {
    field: 'target',
    expected: 'seat_or_null',
    reason: 'target 座位号超出本房间范围',
  },
  TARGET_NOT_ALLOWED: {
    field: 'target',
    expected: 'allowed_seat_or_null',
    reason: 'target 不在本次行动的合法目标中',
  },
  SAVE_REQUIRED: { field: 'save', expected: 'boolean', reason: '缺少 save 行动字段' },
  SAVE_TYPE: { field: 'save', expected: 'boolean', reason: 'save 字段必须是布尔值' },
  POISON_REQUIRED: { field: 'poison', expected: 'seat_or_null', reason: '缺少 poison 目标字段' },
  POISON_TYPE: {
    field: 'poison',
    expected: 'seat_or_null',
    reason: 'poison 必须是整数座位号或 null',
  },
  POISON_OUT_OF_RANGE: {
    field: 'poison',
    expected: 'seat_or_null',
    reason: 'poison 座位号超出本房间范围',
  },
  SAVE_UNAVAILABLE: {
    field: 'save',
    expected: 'available_action',
    reason: '当前规则或资源状态不允许执行 save 行动',
  },
  POTION_CONFLICT: {
    field: 'poison',
    expected: 'one_action_only',
    reason: '同一晚同时使用两种互斥技能',
  },
  POISON_UNAVAILABLE: {
    field: 'poison',
    expected: 'available_action',
    reason: '当前资源状态不允许执行 poison 行动',
  },
  POISON_NOT_ALLOWED: {
    field: 'poison',
    expected: 'allowed_seat_or_null',
    reason: 'poison 不在本次行动的合法目标中',
  },
};
const validationTypes = new Set([
  'missing',
  'null',
  'array',
  'object',
  'string',
  'number',
  'boolean',
]);

function scrubText(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(
      /(["']?(?:x-api-key|api[_ -]?key|authorization|access[_ -]?token|client[_ -]?secret|token|secret|password|key)["']?\s*:\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      '$1"[redacted]"',
    )
    .replace(
      /\b(api[_ -]?key|authorization|access[_ -]?token|token|secret|password)\s*=\s*[^\s,;]+/gi,
      '$1=[redacted]',
    )
    .replace(
      /([?&](?:api[_-]?key|authorization|access[_-]?token|key|token|secret|signature|sig)=)[^&\s]+/gi,
      '$1[redacted]',
    )
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '[redacted-key]');
}
function diagnosticMessages(messages) {
  if (!Array.isArray(messages) || messages.length > 128) return;
  return messages.map((message) => ({
    role: ['system', 'developer', 'user', 'assistant'].includes(message?.role)
      ? message.role
      : 'unknown',
    content:
      typeof message?.content === 'string'
        ? scrubText(message.content)
        : Array.isArray(message?.content)
          ? message.content.map((part) =>
              typeof part === 'string'
                ? scrubText(part)
                : part && typeof part === 'object'
                  ? {
                      type: part.type,
                      text: typeof part.text === 'string' ? scrubText(part.text) : undefined,
                    }
                  : part,
            )
          : undefined,
  }));
}

function safeValidation(input) {
  if (
    !input ||
    input.version !== 1 ||
    typeof input.rule !== 'string' ||
    !Object.hasOwn(validationRules, input.rule)
  )
    return;
  const rule = validationRules[input.rule];
  const result = {
    version: 1,
    rule: input.rule,
    field: rule.field,
    expected: rule.expected,
    reason: rule.reason,
  };
  if (validationTypes.has(input.actualType)) result.actualType = input.actualType;
  if (input.roomSize === 6 || input.roomSize === 12) result.roomSize = input.roomSize;
  if (input.fieldTypes && typeof input.fieldTypes === 'object') {
    result.fieldTypes = {};
    for (const field of ['target', 'save', 'poison', 'speech']) {
      if (validationTypes.has(input.fieldTypes[field]))
        result.fieldTypes[field] = input.fieldTypes[field];
    }
  }
  if (rule.field === 'target' || rule.field === 'poison') {
    for (const field of ['isInteger', 'inSeatRange', 'targetAllowed']) {
      if (typeof input[field] === 'boolean') result[field] = input[field];
    }
    if (
      Number.isInteger(input.allowedTargetCount) &&
      input.allowedTargetCount >= 0 &&
      input.allowedTargetCount <= (result.roomSize || 12)
    )
      result.allowedTargetCount = input.allowedTargetCount;
  }
  return result;
}

function safeEntry(entry) {
  const result = {
    time: new Date().toISOString(),
    event: events.has(entry.event) ? entry.event : 'failed',
  };
  if (typeof entry.requestId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(entry.requestId))
    result.requestId = entry.requestId;
  if (typeof entry.gameId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(entry.gameId))
    result.gameId = entry.gameId;
  if (tasks.has(entry.task)) result.task = entry.task;
  if (Number.isInteger(entry.seat) && entry.seat >= 1 && entry.seat <= 12) result.seat = entry.seat;
  if (Number.isInteger(entry.round) && entry.round >= 1) result.round = entry.round;
  if (Number.isFinite(entry.durationMs) && entry.durationMs >= 0)
    result.durationMs = Math.round(entry.durationMs);
  if (Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599)
    result.httpStatus = entry.httpStatus;
  if (typeof entry.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(entry.code))
    result.code = entry.code;
  if (
    ['MISSING_JSON', 'INCOMPLETE_JSON', 'MULTIPLE_JSON_VALUES', 'INVALID_JSON'].includes(
      entry.jsonIssue,
    )
  )
    result.jsonIssue = entry.jsonIssue;
  for (const field of ['requestedFormat', 'reportedFormat']) {
    if (['json_schema', 'json_object', 'text'].includes(entry[field])) result[field] = entry[field];
  }
  for (const field of [
    'responseChars',
    'assistantMessageCount',
    'commentaryMessageCount',
    'finalMessageCount',
  ]) {
    if (Number.isInteger(entry[field]) && entry[field] >= 0 && entry[field] <= 2 * 1024 * 1024)
      result[field] = entry[field];
  }
  if (
    result.event === 'validation_failed' &&
    ['INVALID_ACTION', 'INVALID_AGENT_RESPONSE'].includes(result.code)
  ) {
    const validation = safeValidation(entry.validation);
    if (validation) result.validation = validation;
  }
  if (
    result.event === 'action_validated' &&
    result.code === 'ACTION_VALIDATED' &&
    entry.validatedAction &&
    typeof entry.validatedAction === 'object'
  ) {
    const action = {};
    if (
      entry.validatedAction.target === null ||
      (Number.isInteger(entry.validatedAction.target) &&
        entry.validatedAction.target >= 1 &&
        entry.validatedAction.target <= 12)
    )
      action.target = entry.validatedAction.target;
    if (typeof entry.validatedAction.save === 'boolean') action.save = entry.validatedAction.save;
    if (
      entry.validatedAction.poison === null ||
      (Number.isInteger(entry.validatedAction.poison) &&
        entry.validatedAction.poison >= 1 &&
        entry.validatedAction.poison <= 12)
    )
      action.poison = entry.validatedAction.poison;
    if (Object.keys(action).length) result.validatedAction = action;
  }
  if (['speech', 'vote', 'night', 'hunter'].includes(result.task)) {
    const messages = diagnosticMessages(entry.requestContext);
    if (messages) result.requestContext = messages;
    if (typeof entry.assistantResponse === 'string')
      result.assistantResponse = scrubText(entry.assistantResponse).slice(0, 2 * 1024 * 1024);
  }
  if (typeof entry.errorMessage === 'string')
    result.errorMessage = scrubText(entry.errorMessage).slice(0, 2000);
  return result;
}
function cleanGameLogs(directory, now = Date.now()) {
  const cutoff = now - 72 * 60 * 60 * 1000;
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]{1,80}\.jsonl$/.test(name)) continue;
    const file = path.join(directory, name);
    let stat, text;
    try {
      stat = fs.statSync(file);
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const retained = lines.filter((line) => {
      try {
        const time = Date.parse(JSON.parse(line).time);
        return Number.isFinite(time) ? time >= cutoff : stat.mtimeMs >= cutoff;
      } catch {
        return stat.mtimeMs >= cutoff;
      }
    });
    if (!retained.length) {
      if (stat.mtimeMs < cutoff) fs.rmSync(file, { force: true });
      else if (text) fs.writeFileSync(file, '', 'utf8');
      continue;
    }
    const next = retained.join('\n') + '\n';
    if (next !== text) fs.writeFileSync(file, next, 'utf8');
  }
}

function createAgentLogger({
  file = path.join(__dirname, 'logs', 'agent-requests.jsonl'),
  gameDirectory = path.join(path.dirname(file), 'agent-games'),
} = {}) {
  let warned = false,
    nextCleanupAt = 0;
  const directory = path.dirname(file);
  return (entry) => {
    try {
      fs.mkdirSync(directory, { recursive: true });
      const now = Date.now();
      if (now >= nextCleanupAt) {
        cleanSystemLogs({ directory, files: ['agent-requests.jsonl'], now });
        cleanGameLogs(gameDirectory, now);
        nextCleanupAt = now + 60 * 60 * 1000;
      }
      const safe = safeEntry(entry);
      const line = JSON.stringify(safe) + '\n';
      fs.appendFileSync(file, line, 'utf8');
      if (safe.gameId) {
        fs.mkdirSync(gameDirectory, { recursive: true });
        fs.appendFileSync(path.join(gameDirectory, safe.gameId + '.jsonl'), line, 'utf8');
      }
    } catch {
      if (!warned) {
        warned = true;
        console.error('Agent 请求诊断日志写入失败，请检查 logs 文件夹的写入权限。');
      }
    }
  };
}
module.exports = { createAgentLogger, safeEntry, cleanGameLogs };
