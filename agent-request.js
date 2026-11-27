(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NightfallAgentRequest = api;
})(globalThis, () => {
  const PROTOCOL = 'responses';
  const OUTPUT_MAX_TOKENS = 25000;
  const DEFAULT_REASONING_EFFORT = 'medium';
  const SUPPORTED_REASONING_EFFORTS = ['medium', 'high', 'xhigh'];
  function normalizeReasoningEffort(value) {
    return SUPPORTED_REASONING_EFFORTS.includes(value) ? value : DEFAULT_REASONING_EFFORT;
  }

  function inputContent(content) {
    if (typeof content === 'string') return [{ type: 'input_text', text: content }];
    if (!Array.isArray(content)) throw Error('Agent 消息内容格式不正确');
    return content.map((part) => {
      if (part?.type === 'text' && typeof part.text === 'string')
        return { type: 'input_text', text: part.text };
      if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
        return {
          type: 'input_image',
          image_url: part.image_url.url,
          ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
        };
      }
      throw Error('Agent 消息包含不支持的素材类型');
    });
  }

  function responsesEndpoint(endpoint) {
    const url = new URL(endpoint);
    const pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname || pathname === '/v1') url.pathname = '/v1/responses';
    else if (pathname.endsWith('/chat/completions'))
      url.pathname = pathname.slice(0, -'/chat/completions'.length) + '/responses';
    url.hash = '';
    return url.href;
  }

  function responsesBody({
    model,
    messages,
    reasoning_effort = DEFAULT_REASONING_EFFORT,
    max_tokens = OUTPUT_MAX_TOKENS,
    actionTask,
    actionRole,
    allowedTargets,
    nightOptions,
  }) {
    const body = {
      model: model.trim(),
      input: messages.map((message) => ({
        role: message.role,
        content: inputContent(message.content),
      })),
      max_output_tokens: max_tokens,
      stream: false,
      store: false,
    };
    if (reasoning_effort !== null)
      body.reasoning = { effort: normalizeReasoningEffort(reasoning_effort) };
    if (actionTask === 'speech')
      body.text = {
        format: {
          type: 'json_schema',
          name: 'werewolf_speech',
          strict: true,
          schema: {
            type: 'object',
            properties: { speech: { type: 'string' } },
            required: ['speech'],
            additionalProperties: false,
          },
        },
      };
    if (actionTask === 'vote') {
      const targetSchema = Array.isArray(allowedTargets)
        ? {
            type: ['integer', 'null'],
            enum: [...new Set(allowedTargets.filter(Number.isInteger)), null],
          }
        : { type: ['integer', 'null'] };
      body.text = {
        format: {
          type: 'json_schema',
          name: 'werewolf_vote',
          strict: true,
          schema: {
            type: 'object',
            properties: { target: targetSchema },
            required: ['target'],
            additionalProperties: false,
          },
        },
      };
    }
    if (actionTask === 'night') {
      const targetSchema = Array.isArray(allowedTargets)
        ? {
            type: ['integer', 'null'],
            enum: [...new Set(allowedTargets.filter(Number.isInteger)), null],
          }
        : { type: ['integer', 'null'] };
      const witch = actionRole === '女巫';
      body.text = {
        format: {
          type: 'json_schema',
          name:
            {
              狼人: 'werewolf_night_wolf',
              守卫: 'werewolf_night_guard',
              预言家: 'werewolf_night_seer',
              女巫: 'werewolf_night_witch',
            }[actionRole] || 'werewolf_night_target',
          strict: true,
          schema: witch
            ? {
                type: 'object',
                properties: {
                  save: {
                    type: 'boolean',
                    enum: nightOptions?.canSave === false ? [false] : [false, true],
                  },
                  poison:
                    nightOptions?.poisonAvailable === false
                      ? { type: ['integer', 'null'], enum: [null] }
                      : targetSchema,
                },
                required: ['save', 'poison'],
                additionalProperties: false,
              }
            : {
                type: 'object',
                properties: { target: targetSchema },
                required: ['target'],
                additionalProperties: false,
              },
        },
      };
    }
    return body;
  }

  class ResponseError extends Error {
    constructor(code, message, responseId) {
      const safeId =
        typeof responseId === 'string' && /^resp_[a-zA-Z0-9_-]{1,192}$/.test(responseId)
          ? responseId
          : null;
      super(message + (safeId ? '（Responses 编号 ' + safeId + '）' : ''));
      this.name = 'AgentResponseError';
      this.status = 502;
      this.code = code;
      if (safeId) this.responseId = safeId;
    }
  }

  function responseText(data) {
    if (data?.status === 'incomplete') {
      if (data.incomplete_details?.reason === 'max_output_tokens')
        throw new ResponseError(
          'AGENT_OUTPUT_TRUNCATED',
          'Agent 推理与回答已达到 25000 token 上限，结果不完整，请手动重试。',
          data?.id,
        );
      throw new ResponseError(
        'AGENT_RESPONSE_INCOMPLETE',
        'Responses 返回内容不完整或受到内容限制，请检查后手动重试。',
        data?.id,
      );
    }
    if (data?.status === 'failed' || data?.error) {
      const reason =
        {
          server_error: '供应商内部错误',
          rate_limit_exceeded: '供应商限流',
          invalid_prompt: '供应商拒绝当前输入',
        }[data?.error?.code] || '供应商未能完成任务';
      throw new ResponseError(
        'AGENT_RESPONSE_FAILED',
        'Responses 任务执行失败（' + reason + '），请检查后手动重试。',
        data?.id,
      );
    }
    if (['queued', 'in_progress', 'cancelled'].includes(data?.status))
      throw new ResponseError(
        'AGENT_RESPONSE_INCOMPLETE',
        'Responses 未同步完成本次请求，请检查供应商的同步返回支持情况后手动重试。',
        data?.id,
      );
    if (data?.status !== 'completed' || !Array.isArray(data.output))
      throw new ResponseError(
        'INVALID_AGENT_RESPONSE',
        '接口未返回完整的 Responses 结果，请检查 Responses 地址和模型支持情况。',
        data?.id,
      );
    const messages = [];
    const assistantMessages = data.output.filter(
      (item) => item?.type === 'message' && item.role === 'assistant',
    );
    const hasFinalAnswer = assistantMessages.some((item) => item.phase === 'final_answer');
    for (const item of assistantMessages) {
      if (item.phase === 'commentary' || (hasFinalAnswer && item.phase !== 'final_answer'))
        continue;
      if (item.status !== undefined && item.status !== 'completed')
        throw new ResponseError(
          'AGENT_RESPONSE_INCOMPLETE',
          'Responses 助手消息尚未完整生成，请手动重试。',
          data?.id,
        );
      if (!Array.isArray(item.content))
        throw new ResponseError(
          'INVALID_AGENT_RESPONSE',
          'Responses 助手消息格式不正确。',
          data?.id,
        );
      let text = '';
      for (const part of item.content) {
        if (part?.type === 'refusal')
          throw new ResponseError(
            'AGENT_REFUSED',
            '当前模型拒绝回答本次请求，请检查提示或模型配置后手动重试。',
            data?.id,
          );
        if (part?.type !== 'output_text') continue;
        if (typeof part.text !== 'string')
          throw new ResponseError(
            'INVALID_AGENT_RESPONSE',
            'Responses 返回的文字格式不正确。',
            data?.id,
          );
        text += part.text;
      }
      if (text.trim()) messages.push(text);
    }
    if (!messages.length)
      throw new ResponseError(
        'INVALID_AGENT_RESPONSE',
        'Responses 未返回有效的助手文字，请检查模型与输出预算后手动重试。',
        data?.id,
      );
    return messages.join('\n');
  }

  function parseActionJSON(raw) {
    const text = String(raw)
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const responseChars = Array.from(text).length;
    function invalid(jsonIssue) {
      const messages = {
        MISSING_JSON: '接口已返回文字，但缺少有效的行动 JSON 对象，已暂停当前行动，请手动重试。',
        INCOMPLETE_JSON: '接口返回的 JSON 尚未闭合，已暂停当前行动，请手动重试。',
        MULTIPLE_JSON_VALUES: '接口返回了多份 JSON，无法确定当前行动，已暂停，请手动重试。',
        INVALID_JSON: '接口返回的 JSON 格式错误，已暂停当前行动，请手动重试。',
      };
      return Object.assign(Error(messages[jsonIssue]), {
        code: 'INVALID_AGENT_RESPONSE',
        jsonIssue,
        responseChars,
      });
    }
    try {
      return JSON.parse(text);
    } catch {}
    const first = text.indexOf('{');
    if (first < 0) throw invalid('MISSING_JSON');
    if (text.startsWith('[')) throw invalid('INVALID_JSON');
    let depth = 0,
      inString = false,
      escaped = false,
      end = -1;
    for (let index = first; index < text.length; index++) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        end = index + 1;
        break;
      }
    }
    if (end < 0) throw invalid('INCOMPLETE_JSON');
    const suffix = text.slice(end);
    if (/[{}\[\]]/.test(suffix)) throw invalid('MULTIPLE_JSON_VALUES');
    try {
      return JSON.parse(text.slice(first, end));
    } catch {
      throw invalid('INVALID_JSON');
    }
  }

  // Keep the local game response shape compatible with pages already open.
  function gameResponse(data, { actionTask } = {}) {
    let content = responseText(data);
    if (actionTask === 'speech') {
      try {
        parseActionJSON(content);
      } catch (error) {
        // Some providers ignore the speech schema and return the completed speech directly.
        if (error.jsonIssue === 'MISSING_JSON' && !/[{}`]|^\s*[\[\]"]/.test(content))
          content = JSON.stringify({ speech: content });
      }
    }
    return {
      id: data.id,
      model: data.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      ...(data.usage
        ? {
            usage: {
              prompt_tokens: data.usage.input_tokens,
              completion_tokens: data.usage.output_tokens,
              total_tokens: data.usage.total_tokens,
            },
          }
        : {}),
    };
  }

  function reasoningFailure(status, data, reasoningEffort = DEFAULT_REASONING_EFFORT) {
    if (![400, 422].includes(status)) return null;
    const detail = [
      data?.error?.code,
      data?.error?.type,
      data?.error?.param,
      data?.error?.message,
      data?.error,
      data?.code,
      data?.param,
      data?.message,
    ]
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    const namesParameter = /reasoning[_ .-]?effort|reasoning[.\[\] ]|推理强度/.test(detail);
    const rejectsParameter =
      /unsupported|not[_ ]supported|does not support|not support|unknown|unrecognized|unrecognised|invalid|not[_ ]allowed|not[_ ]permitted|not[_ ]compatible|不支持|无效|不允许/.test(
        detail,
      );
    if (!namesParameter || !rejectsParameter) return null;
    return {
      status,
      code: 'REASONING_EFFORT_UNSUPPORTED',
      message:
        '当前模型或接口不支持推理强度 ' +
        normalizeReasoningEffort(reasoningEffort) +
        '（reasoning.effort，HTTP ' +
        status +
        '）。请在 Agent 配置中选择支持该参数的模型或接口，再重试当前操作。',
    };
  }

  function protocolFailure(status, data) {
    if (![400, 404, 405, 422].includes(status)) return null;
    const detail = [
      data?.error?.code,
      data?.error?.type,
      data?.error?.param,
      data?.error?.message,
      data?.error,
      data?.code,
      data?.param,
      data?.message,
    ]
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    const rejects =
      /unsupported|not.support|unknown|unrecognized|invalid|not.allowed|not.permitted|不支持|无效|不允许/.test(
        detail,
      );
    if (!rejects) return null;
    const structuredOutput =
      /text[.\[\] _-]*format|json_schema|response_format|structured[_ -]?outputs?/.test(detail) ||
      data?.error?.param === 'text';
    if (structuredOutput)
      return {
        status,
        code: 'STRUCTURED_OUTPUT_UNSUPPORTED',
        message:
          '当前模型或接口拒绝结构化行动输出（text.format / json_schema，HTTP ' +
          status +
          '）。请检查模型与接口的结构化输出支持，再手动重试当前行动。',
      };
    const parameter = ['max_output_tokens', 'input', 'stream', 'store'].find((name) =>
      new RegExp('\\b' + name + '\\b').test(detail),
    );
    if (!parameter && !/responses/.test(detail)) return null;
    return {
      status,
      code: 'RESPONSES_UNSUPPORTED',
      message: parameter
        ? '当前模型或接口拒绝 Responses 参数 ' +
          parameter +
          '（HTTP ' +
          status +
          '）。请检查模型支持和接口配置后手动重试。'
        : '当前模型或接口不支持 Responses（HTTP ' +
          status +
          '）。请检查 Responses 地址和模型支持情况后手动重试。',
    };
  }

  // Rough input size for the waiting panel: CJK characters ~1 token each, other characters ~4 per token.
  const CJK =
    /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;
  function estimateInputTokens(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    let cjk = 0,
      other = 0;
    for (const ch of text)
      if (CJK.test(ch)) cjk++;
      else other++;
    return cjk + Math.ceil(other / 4);
  }
  return {
    estimateInputTokens,
    PROTOCOL,
    OUTPUT_MAX_TOKENS,
    DEFAULT_REASONING_EFFORT,
    SUPPORTED_REASONING_EFFORTS,
    normalizeReasoningEffort,
    responsesEndpoint,
    responsesBody,
    responseText,
    parseActionJSON,
    gameResponse,
    ResponseError,
    reasoningFailure,
    protocolFailure,
  };
});
