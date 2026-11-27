'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Agent = require('./agent-request.js');
const Limits = require('./limits.js');

function message(text) {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

test('Responses 地址保留部署前缀、查询参数和自定义路径', () => {
  for (const [input, output] of [
    ['https://api.test', 'https://api.test/v1/responses'],
    ['https://api.test/v1/?tenant=one', 'https://api.test/v1/responses?tenant=one'],
    [
      'https://api.test/deploy/v1/chat/completions/?api-version=2026',
      'https://api.test/deploy/v1/responses?api-version=2026',
    ],
    ['https://api.test/responses?x=1', 'https://api.test/responses?x=1'],
    ['https://api.test/custom/invoke/?x=1', 'https://api.test/custom/invoke/?x=1'],
  ])
    assert.equal(Agent.responsesEndpoint(input), output);
});

test('Responses 统一预算和推理强度，保持角色、文本、图片顺序', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'developer', content: 'developer' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'first' },
        { type: 'image_url', image_url: { url: 'https://image.test/p.png', detail: 'high' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
    { role: 'assistant', content: 'previous answer' },
    { role: 'user', content: 'next' },
  ];
  const before = JSON.stringify(messages);
  for (const effort of ['high', 'xhigh', undefined]) {
    const body = Agent.responsesBody({
      model: ' model ',
      messages,
      reasoning_effort: effort,
      temperature: 0.75,
      max_tokens: 350,
    });
    assert.deepEqual(body, {
      model: 'model',
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'system' }] },
        { role: 'developer', content: [{ type: 'input_text', text: 'developer' }] },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'first' },
            { type: 'input_image', image_url: 'https://image.test/p.png', detail: 'high' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          ],
        },
        { role: 'assistant', content: [{ type: 'input_text', text: 'previous answer' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
      ],
      reasoning: { effort: effort || Agent.DEFAULT_REASONING_EFFORT },
      max_output_tokens: 350,
      stream: false,
      store: false,
    });
  }
  const connection = Agent.responsesBody({
    model: 'model',
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    reasoning_effort: null,
    max_tokens: 350,
  });
  assert.deepEqual(connection, {
    model: 'model',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }],
    max_output_tokens: 350,
    stream: false,
    store: false,
  });
  assert.equal(JSON.stringify(messages), before);
  assert.equal(Limits.AGENT_OUTPUT_MAX_TOKENS, Agent.OUTPUT_MAX_TOKENS);
  assert.equal(Limits.SPEECH_CHAR_LIMIT, 1400);
  assert.throws(
    () =>
      Agent.responsesBody({
        model: 'x',
        messages: [{ role: 'user', content: [{ type: 'unknown' }] }],
      }),
    /不支持/,
  );
});

test('默认推理强度为 high，输入 token 估算区分中日韩与其他字符', () => {
  assert.equal(Agent.DEFAULT_REASONING_EFFORT, 'high');
  assert.equal(Agent.estimateInputTokens('狼人'), 2);
  assert.equal(Agent.estimateInputTokens('abcdefghi'), 3);
  assert.equal(
    Agent.estimateInputTokens({ text: '狼人' }),
    Agent.estimateInputTokens('{"text":"狼人"}'),
  );
});

test('Responses 只读取助手最终文字，兼容多个输出项并保留本地结构', () => {
  const response = {
    id: 'resp-test',
    model: 'model',
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'private reasoning' }] },
      { type: 'message', role: 'user', content: [{ type: 'output_text', text: 'ignore' }] },
      {
        ...message('first'),
        content: [
          { type: 'output_text', text: 'first' },
          { type: 'output_text', text: ' answer' },
        ],
      },
      message('second answer'),
    ],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  };
  assert.equal(Agent.responseText(response), 'first answer\nsecond answer');
  assert.deepEqual(Agent.gameResponse(response), {
    id: 'resp-test',
    model: 'model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'first answer\nsecond answer' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
});

test('Responses 拒绝、截断、失败和异常输出均不能作为成功结果', () => {
  const cases = [
    [
      {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [message('partial')],
      },
      'AGENT_OUTPUT_TRUNCATED',
    ],
    [
      { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
      'AGENT_RESPONSE_INCOMPLETE',
    ],
    [
      { status: 'failed', error: { code: 'server_error', message: 'private-key' } },
      'AGENT_RESPONSE_FAILED',
    ],
    [{ status: 'in_progress', output: [] }, 'AGENT_RESPONSE_INCOMPLETE'],
    [
      {
        status: 'completed',
        output: [{ ...message(''), content: [{ type: 'refusal', refusal: 'private' }] }],
      },
      'AGENT_REFUSED',
    ],
    [
      { status: 'completed', output: [{ type: 'reasoning', summary: [] }] },
      'INVALID_AGENT_RESPONSE',
    ],
    [{ status: 'completed', output: [message(' ')] }, 'INVALID_AGENT_RESPONSE'],
    [
      { status: 'completed', output: [{ ...message('partial'), status: 'in_progress' }] },
      'AGENT_RESPONSE_INCOMPLETE',
    ],
    [{ status: 'completed', output: [message(123)] }, 'INVALID_AGENT_RESPONSE'],
    [{ choices: [{ message: { content: 'legacy' } }] }, 'INVALID_AGENT_RESPONSE'],
  ];
  for (const [data, code] of cases)
    assert.throws(
      () => Agent.responseText(data),
      (e) =>
        e instanceof Agent.ResponseError &&
        e.status === 502 &&
        e.code === code &&
        !/private-key|legacy/.test(e.message),
    );
});

test('Responses 参数拒绝保留安全原因，不泄露供应商原始凭据', () => {
  assert.match(
    Agent.reasoningFailure(
      422,
      { error: { param: 'reasoning.effort', message: 'unsupported reasoning.effort private-key' } },
      'high',
    ).message,
    /high/,
  );
  for (const parameter of ['input', 'store', 'stream', 'max_output_tokens']) {
    const failure = Agent.protocolFailure(400, {
      error: { param: parameter, message: 'unsupported parameter private-key' },
    });
    assert.equal(failure.code, 'RESPONSES_UNSUPPORTED');
    assert.ok(failure.message.includes(parameter));
    assert.ok(!failure.message.includes('private-key'));
  }
});

test('Responses 异常保留安全编号，异常编号不进入提示', () => {
  for (const id of ['resp_budget_test', 'https://example.test/?key=private-key', null]) {
    assert.throws(
      () =>
        Agent.responseText({
          id,
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      (error) => {
        assert.equal(error.code, 'AGENT_OUTPUT_TRUNCATED');
        assert.equal(error.responseId, id === 'resp_budget_test' ? id : undefined);
        assert.equal(error.message.includes('resp_budget_test'), id === 'resp_budget_test');
        assert.doesNotMatch(error.message, /private-key|example.test/);
        return true;
      },
    );
  }
});

test('Responses 只读取最终答案，阶段说明与旧式中间消息不混入行动 JSON', () => {
  const final = { ...message('{"speech":"最终发言"}'), phase: 'final_answer' };
  const response = {
    status: 'completed',
    output: [
      { ...message('{"speech":"准备稿"}'), phase: 'commentary' },
      message('{"speech":"中间稿"}'),
      final,
    ],
  };
  const text = Agent.gameResponse(response).choices[0].message.content;
  assert.equal(text, '{"speech":"最终发言"}');
  assert.deepEqual(Agent.parseActionJSON(text), { speech: '最终发言' });
  assert.equal(
    Agent.responseText({
      status: 'completed',
      output: [{ ...message('处理中'), phase: 'commentary' }, message('{"target":2}')],
    }),
    '{"target":2}',
  );
  assert.throws(
    () =>
      Agent.responseText({
        status: 'completed',
        output: [{ ...message('{"target":2}'), phase: 'commentary' }],
      }),
    { code: 'INVALID_AGENT_RESPONSE' },
  );
});

test('行动 JSON 保留完整发言及转义，兼容单一对象包装', () => {
  const action = { speech: '我会看 {线索}，再说"判断"。\n下一句，🌙', details: { target: null } };
  const fence = String.fromCharCode(96).repeat(3);
  for (const text of [
    JSON.stringify(action),
    fence + 'json\n' + JSON.stringify(action) + '\n' + fence,
    '最终答案\n' + JSON.stringify(action) + '\n结束',
  ]) {
    assert.deepEqual(Agent.parseActionJSON(text), action);
  }
});

test('行动 JSON 拒绝残缺、格式错误和多份候选，只提供安全诊断', () => {
  for (const [text, jsonIssue] of [
    ['{"speech":"private-secret', 'INCOMPLETE_JSON'],
    ['{"speech":"private-secret",}', 'INVALID_JSON'],
    ['{"speech":"private-secret\nnewline"}', 'INVALID_JSON'],
    ['{"speech":"private-secret"}\n{"speech":"other"}', 'MULTIPLE_JSON_VALUES'],
    ['[{"speech":"private-secret"}', 'INVALID_JSON'],
    ['plain private-secret', 'MISSING_JSON'],
  ]) {
    assert.throws(
      () => Agent.parseActionJSON(text),
      (error) => {
        assert.equal(error.code, 'INVALID_AGENT_RESPONSE');
        assert.equal(error.jsonIssue, jsonIssue);
        assert.equal(error.responseChars, Array.from(text).length);
        assert.doesNotMatch(error.message, /private-secret|other|newline/);
        return true;
      },
    );
  }
});

test('完整纯文字发言按原文包装为 speech，保留段落、引号和 Unicode', () => {
  const speech =
    '我是1号岚，身份是平民。\n\n1. 我会听大家的发言。\n2. 先记下"判断"与路径 C:\\notes。🌙';
  const response = { status: 'completed', output: [message(speech)] };
  const result = Agent.gameResponse(response, { actionTask: 'speech' });
  assert.deepEqual(Agent.parseActionJSON(result.choices[0].message.content), { speech });
  assert.equal(response.output[0].content[0].text, speech);
  for (const task of [undefined, 'vote', 'night', 'hunter']) {
    assert.equal(
      Agent.gameResponse(response, { actionTask: task }).choices[0].message.content,
      speech,
    );
  }
});

test('发言兼容处理保留 JSON 校验，残缺、数组和多份候选继续交给严格校验', () => {
  for (const content of [
    '{"speech":"完整发言"}',
    '{"speech":"残缺发言',
    '{"speech":"格式错误",}',
    '{"speech":"第一份"}\n{"speech":"第二份"}',
    '[{"speech":"数组"}]',
    '["残缺数组"',
    '"speech":"缺少左括号"}',
    '\x60\x60\x60json\n缺少行动对象\n\x60\x60\x60',
    'null',
    'true',
    '2',
    '"只有 JSON 字符串"',
  ]) {
    const response = { status: 'completed', output: [message(content)] };
    assert.equal(
      Agent.gameResponse(response, { actionTask: 'speech' }).choices[0].message.content,
      content,
    );
  }
});

test('纯文字发言兼容处理仅采用完整最终答案，拒绝截断、未完成和拒答', () => {
  const response = {
    status: 'completed',
    output: [
      { ...message('这是准备阶段的说明'), phase: 'commentary' },
      { ...message('这是我的完整发言。'), phase: 'final_answer' },
    ],
  };
  const content = Agent.gameResponse(response, { actionTask: 'speech' }).choices[0].message.content;
  assert.deepEqual(Agent.parseActionJSON(content), { speech: '这是我的完整发言。' });
  for (const [value, code] of [
    [
      { ...response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      'AGENT_OUTPUT_TRUNCATED',
    ],
    [{ ...response, status: 'in_progress' }, 'AGENT_RESPONSE_INCOMPLETE'],
    [
      { status: 'completed', output: [{ ...message('仍在生成'), status: 'in_progress' }] },
      'AGENT_RESPONSE_INCOMPLETE',
    ],
    [
      {
        status: 'completed',
        output: [{ ...message(''), content: [{ type: 'refusal', refusal: '拒答' }] }],
      },
      'AGENT_REFUSED',
    ],
    [{ status: 'completed', output: [message('   ')] }, 'INVALID_AGENT_RESPONSE'],
  ])
    assert.throws(() => Agent.gameResponse(value, { actionTask: 'speech' }), { code });
});

test('发言请求通过 Responses 结构化输出约束 speech 字段', () => {
  const options = {
    model: 'test-model',
    messages: [{ role: 'user', content: '本轮发言' }],
    reasoning_effort: 'high',
  };
  const body = Agent.responsesBody({ ...options, actionTask: 'speech' });
  assert.deepEqual(body.text, {
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
  });
  assert.equal(body.reasoning.effort, 'high');
  assert.equal(body.max_output_tokens, 25000);
  for (const task of [undefined, 'hunter']) {
    assert.equal(Agent.responsesBody({ ...options, actionTask: task }).text, undefined);
  }
  assert.equal(
    Agent.responsesBody({
      ...options,
      actionTask: 'night',
      actionRole: '狼人',
      allowedTargets: [1, 2, 3],
    }).text.format.name,
    'werewolf_night_wolf',
  );
});

test('投票 Responses Schema 只允许本轮合法目标或弃票', () => {
  const body = Agent.responsesBody({
    model: 'test-model',
    messages: [{ role: 'user', content: 'vote' }],
    actionTask: 'vote',
    allowedTargets: [2, 4, 6, 2],
  });
  assert.deepEqual(body.text, {
    format: {
      type: 'json_schema',
      name: 'werewolf_vote',
      strict: true,
      schema: {
        type: 'object',
        properties: { target: { type: ['integer', 'null'], enum: [2, 4, 6, null] } },
        required: ['target'],
        additionalProperties: false,
      },
    },
  });
  const noTargets = Agent.responsesBody({
    model: 'test-model',
    messages: [{ role: 'user', content: 'vote' }],
    actionTask: 'vote',
    allowedTargets: [],
  });
  assert.deepEqual(noTargets.text.format.schema.properties.target, {
    type: ['integer', 'null'],
    enum: [null],
  });
});

test('夜间 Responses Schema 按角色限制行动字段与可选目标', () => {
  const messages = [{ role: 'user', content: 'night' }];
  const wolf = Agent.responsesBody({
    model: 'm',
    messages,
    actionTask: 'night',
    actionRole: '狼人',
    allowedTargets: [1, 2, 3],
  });
  assert.deepEqual(wolf.text.format.schema.properties.target, {
    type: ['integer', 'null'],
    enum: [1, 2, 3, null],
  });
  const guard = Agent.responsesBody({
    model: 'm',
    messages,
    actionTask: 'night',
    actionRole: '守卫',
    allowedTargets: [2, 3],
  });
  assert.equal(guard.text.format.name, 'werewolf_night_guard');
  assert.deepEqual(guard.text.format.schema.properties.target.enum, [2, 3, null]);
  const seer = Agent.responsesBody({
    model: 'm',
    messages,
    actionTask: 'night',
    actionRole: '预言家',
    allowedTargets: [2, 3],
  });
  assert.equal(seer.text.format.name, 'werewolf_night_seer');
  const witch = Agent.responsesBody({
    model: 'm',
    messages,
    actionTask: 'night',
    actionRole: '女巫',
    allowedTargets: [2, 3],
    nightOptions: { canSave: false, poisonAvailable: true },
  });
  assert.deepEqual(witch.text.format.schema.properties.save, { type: 'boolean', enum: [false] });
  assert.deepEqual(witch.text.format.schema.properties.poison.enum, [2, 3, null]);
  const spent = Agent.responsesBody({
    model: 'm',
    messages,
    actionTask: 'night',
    actionRole: '女巫',
    allowedTargets: [2, 3],
    nightOptions: { canSave: false, poisonAvailable: false },
  });
  assert.deepEqual(spent.text.format.schema.properties.poison, {
    type: ['integer', 'null'],
    enum: [null],
  });
});

test('缺少 JSON 对象的完整文字回复使用准确的错误提示', () => {
  assert.throws(
    () => Agent.parseActionJSON('private complete speech'),
    (error) => {
      assert.equal(error.jsonIssue, 'MISSING_JSON');
      assert.match(error.message, /已返回文字.*缺少有效的行动 JSON 对象/);
      assert.doesNotMatch(error.message, /private|尚未闭合|未返回完整/);
      return true;
    },
  );
});

test('结构化输出参数拒绝显示专门原因并过滤原始错误', () => {
  for (const param of ['text.format', 'text.format.type', 'json_schema', 'text']) {
    const failure = Agent.protocolFailure(400, {
      error: { param, message: 'Unsupported parameter private-key' },
    });
    assert.equal(failure.code, 'STRUCTURED_OUTPUT_UNSUPPORTED');
    assert.match(failure.message, /text.format.*json_schema/);
    assert.doesNotMatch(failure.message, /private-key/);
  }
});
