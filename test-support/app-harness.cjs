const { test } = require('node:test');

const assert = require('node:assert/strict');

const vm = require('node:vm');

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const Nightfall = require('../engine.js');

const APP_SCRIPTS = require('../app-manifest.cjs');

function setup(
  saved = new Map(),
  fixture = true,
  systemVoices = true,
  withStory = false,
  withPortrait = false,
  options = {},
) {
  const nodes = new Map(),
    requests = [],
    calls = [],
    timeouts = [];
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set(id.endsWith('Backdrop') ? ['hidden'] : []);
      nodes.set(id, {
        value: '',
        textContent: '',
        innerHTML: '',
        style: {},
        attributes: {},
        listeners: {},
        classList: {
          add(c) {
            classes.add(c);
          },
          remove(c) {
            classes.delete(c);
          },
          toggle(c, force) {
            const on = force ?? !classes.has(c);
            on ? classes.add(c) : classes.delete(c);
            return on;
          },
          contains(c) {
            return classes.has(c);
          },
        },
        addEventListener(k, fn) {
          this.listeners[k] = fn;
        },
        setAttribute(k, v) {
          this.attributes[k] = v;
        },
        focus() {},
      });
    }
    return nodes.get(id);
  }
  const events = {};
  if (withPortrait) {
    for (const id of ['portraitHero', 'portraitFrame']) node(id).dataset = {};
  }
  const context = vm.createContext({
    Nightfall,
    console,
    URL,
    AbortController,
    TextDecoder,
    Uint8Array,
    performance,
    location: { protocol: 'http:' },
    setTimeout: (callback, delay) => {
      timeouts.push(delay);
      return setTimeout(callback, delay);
    },
    clearTimeout,
    document: {
      body: node('body'),
      documentElement: node('html'),
      getElementById: node,
      querySelectorAll: () => [],
      addEventListener(event, fn) {
        (events[event] ??= []).push(fn);
      },
    },
    localStorage: { getItem: (k) => saved.get(k) || null, setItem: (k, v) => saved.set(k, v) },
    fetch: async (url, request) => {
      calls.push({ url, request });
      requests.push(JSON.parse(request.body));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"target":1}' } }] }),
      };
    },
  });
  if (options.fetchImpl) context.fetch = options.fetchImpl;
  if (options.origin) context.location.origin = options.origin;
  context.NightfallAvatar = require('../avatar.js');
  context.NightfallManor = require('../manor.js');
  context.NightfallVoices = require('../voices.js');
  context.NightfallObserver = require('../observer.js');
  context.NightfallAgentRequest = require('../agent-request.js');
  context.NightfallAudio = require('../soundfx.js');
  context.NightfallAPIWait = require('../api-wait.js');
  vm.runInContext(fs.readFileSync('spectator.js', 'utf8'), context);
  if (withStory)
    for (const file of ['scenario-samples.js', 'scenario.js', 'story-player.js', 'story-game.js'])
      vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  // Production loads story globals before app.js; suppress only initial DOM wiring here.
  if (withStory) vm.runInContext('initStory=()=>{}', context);
  if (withPortrait) {
    vm.runInContext(fs.readFileSync('portrait.js', 'utf8'), context);
    vm.runInContext('initPortrait=()=>{}', context);
  }
  for (const file of APP_SCRIPTS) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  vm.runInContext('presentationDelayScale=0', context);
  if (systemVoices)
    vm.runInContext(
      "profiles.forEach(p=>{p.voiceProvider='system';p.voiceMatch='custom'})",
      context,
    );
  if (fixture)
    vm.runInContext(
      "size=12;game=new Nightfall.Game(12).start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[12][i]);game.phase='voting';profiles[8].control='api';profiles[8].endpoint='https://example.test/v1/chat/completions';profiles[8].model='test-model';profiles[8].key='secret-test-key';",
      context,
    );
  return { context, saved, requests, calls, timeouts, events };
}

function voteStream(events) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const event of events)
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        controller.close();
      },
    }),
  };
}

function batchCompatibleFetch(handler) {
  return async (url, options) => {
    if (url !== '/api/chat/batch') return handler(url, options);
    const requests = JSON.parse(options.body).requests;
    const events = await Promise.all(
      requests.map(async (request) => {
        // The production adapter now sends Responses bodies. Keep this test shim
        // compatible with handlers that inspect the former Chat Completions shape.
        const legacyMessages = Array.isArray(request.input)
          ? request.input.map((message) => ({
              role: message.role,
              content:
                Array.isArray(message.content) &&
                message.content.every((part) => part?.type === 'input_text')
                  ? message.content.map((part) => part.text).join('\n')
                  : message.content,
            }))
          : request.messages;
        const compatibilityRequest = {
          ...request,
          messages: legacyMessages,
          maxTokens: request.max_output_tokens,
          reasoningEffort: request.reasoning?.effort,
        };
        const response = await handler('/api/chat', {
            ...options,
            body: JSON.stringify(compatibilityRequest),
          }),
          data = await response.json();
        return {
          type: response.ok ? 'result' : 'error',
          requestId: request.requestId,
          seat: request.action.seat,
          ...(response.ok ? { result: data } : { error: data.error, status: response.status }),
        };
      }),
    );
    return voteStream([...events, { type: 'complete' }]);
  };
}

function installStory(context) {
  const story = {
    id: '6a5f75cd-403a-4af2-b9d2-50519e911162',
    version: 1,
    title: '测试庄园',
    background: '六位故人来到庄园。',
    confirmed: true,
    characters: Array.from({ length: 6 }, (_, i) => ({
      seat: i + 1,
      name: '来客' + (i + 1),
      personality: '谨慎',
      relationships: '公开关系' + (i + 1),
    })),
    video: { jobId: '5fef8c97-8b51-48ed-ad4b-f2824d86a84c', url: '/test-intro.mp4' },
  };
  context.storyFixture = story;
  const video = {
    load() {},
    pause() {},
    removeAttribute() {},
    playCalls: 0,
    async play() {
      this.playCalls++;
      this.onplaying?.();
    },
  };
  context.introVideo = video;
  vm.runInContext(
    'selectedStoryId=storyFixture.id;storyPlayer=NightfallStoryPlayer.create({video:introVideo});waitForTurn=async()=>true;revealDeal=async()=>true;runGame=async()=>{}',
    context,
  );
  return { story, video };
}

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  throw Error('Controller did not reach expected state');
}

function prepareAuto(context, size) {
  vm.runInContext(`reset(${size});turnDelay=0;profiles.forEach(p=>p.control='local');`, context);
}

function installSpeech(context, { autoEnd = false } = {}) {
  const spoken = [],
    synth = {
      paused: false,
      cancels: 0,
      pauses: 0,
      resumes: 0,
      getVoices: () => [
        { lang: 'zh-CN', name: '中文一' },
        { lang: 'zh-TW', name: '中文二' },
      ],
      speak(utterance) {
        spoken.push(utterance);
        if (autoEnd) queueMicrotask(() => utterance.onend?.());
      },
      cancel() {
        this.cancels++;
      },
      pause() {
        this.paused = true;
        this.pauses++;
      },
      resume() {
        this.paused = false;
        this.resumes++;
      },
    };
  context.speechSynthesis = synth;
  context.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  return { spoken, synth };
}

function installRuleAudio(context, { reject } = {}) {
  const audios = [];
  context.Audio = class {
    constructor(src) {
      this.src = src;
      this.pauses = 0;
      this.loads = 0;
      audios.push(this);
    }
    play() {
      this.plays = (this.plays || 0) + 1;
      if (reject) return Promise.reject(reject);
      this.onplaying?.();
      return Promise.resolve();
    }
    pause() {
      this.pauses++;
    }
    removeAttribute(key) {
      if (key === 'src') this.src = '';
    }
    load() {
      this.loads++;
    }
  };
  return audios;
}

function installNatural(context, { hold = false } = {}) {
  const audios = installRuleAudio(context),
    requests = [],
    revoked = [];
  context.URL = class extends URL {
    static createObjectURL() {
      return 'blob:test-' + requests.length;
    }
    static revokeObjectURL(url) {
      revoked.push(url);
    }
  };
  const pending = [];
  context.fetch = async (url, request) => {
    requests.push({ url, request, body: JSON.parse(request.body) });
    if (hold) await new Promise((resolve) => pending.push(resolve));
    return { ok: true, blob: async () => ({ size: 512, type: 'audio/mpeg' }) };
  };
  return { audios, requests, revoked, pending };
}

function speechPipeline(
  t,
  {
    size = 6,
    actors = [0, 1, 2],
    api = actors,
    pk = false,
    portrait = false,
    ignoreAbort = false,
    realPlayback = false,
  } = {},
) {
  const { context } = setup(new Map(), false, false, false, portrait),
    chat = [],
    events = [],
    playbacks = [];
  const read = (code) => vm.runInContext(code, context);
  read(
    'reset(' +
      size +
      ');game.start();busy=true;turnDelay=0;game.phase="' +
      (pk ? 'voting' : 'discussion') +
      '";game.pk=' +
      (pk ? JSON.stringify(actors) : 'null') +
      ';game.players.forEach(p=>p.alive=' +
      JSON.stringify(actors) +
      '.includes(p.id));profiles.forEach((p,id)=>{p.control=' +
      JSON.stringify(api) +
      '.includes(id)?"api":"local";p.endpoint="https://example.test/v1";p.model="pipeline-model";p.key="pipeline-test-key"});',
  );
  if (portrait) read('portraitMode=true');
  context.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === '/api/agent-events') {
      events.push(body);
      return { ok: true };
    }
    assert.equal(url, '/api/chat');
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' }));
      const reply = (value) => {
        options.signal.removeEventListener('abort', abort);
        resolve(value);
      };
      chat.push({
        body,
        signal: options.signal,
        reply,
        speech: (text) =>
          reply({
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ message: { content: JSON.stringify({ speech: text }) } }],
            }),
          }),
        fail: (code = 'UPSTREAM_ERROR', message = '模拟接口失败') =>
          reply({ ok: false, status: 503, json: async () => ({ error: { code, message } }) }),
      });
      if (!ignoreAbort) options.signal.addEventListener('abort', abort, { once: true });
    });
  };
  if (!realPlayback) {
    context.pipelinePlayback = (entry) =>
      new Promise((resolve) => playbacks.push({ id: entry.id, text: entry.text, finish: resolve }));
    read('showPlayerSpeech=pipelinePlayback');
  }
  let running;
  t.after(async () => {
    read('reset()');
    for (const item of playbacks) item.finish();
    for (const item of chat) item.speech('迟到结果');
    await running;
  });
  return {
    context,
    read,
    chat,
    events,
    playbacks,
    start() {
      running = read('aiSpeeches(' + pk + ',epoch)');
      return running;
    },
  };
}

function votingHarness(
  t,
  {
    size = 6,
    pk = false,
    locals = [],
    dead = [],
    ignoreAbort = false,
    extraSpeeches = 0,
    historyContext = 'recent',
  } = {},
) {
  const { context } = setup(new Map(), false, true, false, true),
    groups = [],
    events = [],
    uploads = [];
  const read = (code) => vm.runInContext(code, context);
  read(
    'reset(' +
      size +
      ');game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[' +
      size +
      '][i]);game.phase="discussion";game.players.forEach(p=>game.addSpeech(p.id,"公开完整发言"+(p.id+1)));game.openVoting();busy=true;turnDelay=0;portraitMode=true;flushCommentary=async()=>true;aiSpeeches=async()=>{};profiles.slice(0,' +
      size +
      ').forEach((p,i)=>Object.assign(p,{control:"api",endpoint:"https://example.test/v1",model:"seat-"+(i+1),key:"private-key-"+(i+1),reasoningEffort:i%2?"high":"xhigh",historyContext:"' +
      historyContext +
      '"}));',
  );
  if (extraSpeeches)
    read(
      'for(let i=0;i<' +
        extraSpeeches +
        ';i++)game.speechHistory.push({id:i%size,text:"历史发言"+(i+1),round:Math.floor(i/' +
        size +
        ')+2,pk:i%19===0})',
    );
  for (const id of locals) read('profiles[' + id + '].control="local"');
  for (const id of dead) read('game.players[' + id + '].alive=false');
  if (pk) read('game.pk=[1,3];game.voteRound=2');
  context.fetch = async (url, options) => {
    if (url === '/api/agent-events') {
      events.push(JSON.parse(options.body));
      return { ok: true };
    }
    if (url.startsWith('/api/recordings')) {
      uploads.push(url);
      return { ok: true, json: async () => ({ saved: true }) };
    }
    assert.equal(url, '/api/chat/batch');
    const requests = JSON.parse(options.body).requests,
      encoder = new TextEncoder();
    let streamController;
    const group = {
      requests,
      signal: options.signal,
      emit(event) {
        try {
          streamController.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {}
      },
      result(seat, target) {
        const request = requests.find((item) => item.action.seat === seat);
        assert.ok(request);
        this.emit({
          type: 'result',
          seat,
          requestId: request.requestId,
          result: { choices: [{ message: { content: JSON.stringify({ target }) } }] },
        });
      },
      error(seat, code = 'UPSTREAM_ERROR') {
        const request = requests.find((item) => item.action.seat === seat);
        this.emit({
          type: 'error',
          seat,
          requestId: request.requestId,
          status: 503,
          error: { code, message: '模拟投票接口错误' },
        });
      },
      close() {
        try {
          streamController.close();
        } catch {}
      },
    };
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
        if (!ignoreAbort)
          options.signal.addEventListener(
            'abort',
            () => {
              try {
                controller.error(Object.assign(Error('cancelled'), { name: 'AbortError' }));
              } catch {}
            },
            { once: true },
          );
      },
    });
    groups.push(group);
    return { ok: true, status: 200, body };
  };
  let running;
  t.after(async () => {
    read('reset()');
    for (const group of groups) group.close();
    await running;
  });
  return {
    context,
    read,
    groups,
    events,
    uploads,
    start() {
      running = read('vote(epoch)');
      return running;
    },
    replyAll(group = groups.at(-1), target = null) {
      for (const request of group.requests) group.result(request.action.seat, target);
    },
  };
}

function wolfHarness(
  t,
  { size = 12, extraSpeeches = 130, extraEvents = 22, historyContext = 'full' } = {},
) {
  const { context } = setup(new Map(), false, true, false, true),
    groups = [];
  const read = (code) => vm.runInContext(code, context);
  read(
    [
      'reset(' +
        size +
        ');game.start();game.players.forEach((p,i)=>p.role=Nightfall.ROLES[' +
        size +
        '][i]);',
      'game.phase="night";game.round=4;',
      'game.speechHistory=Array.from({length:' +
        extraSpeeches +
        '},(_,i)=>({id:i%size,text:"夜间公开发言"+(i+1),round:Math.floor(i/' +
        size +
        ')+1,pk:i%29===0}));',
      'game.logs=Array.from({length:' +
        extraEvents +
        '},(_,i)=>({text:"公开事件"+(i+1),round:Math.floor(i/' +
        size +
        ')+1,phase:i%2?"voting":"discussion"}));',
      'profiles.forEach(profile=>profile.historyContext="' +
        historyContext +
        '");busy=true;paused=false;portraitMode=true;flushCommentary=async()=>true;',
      'profiles.forEach(p=>Object.assign(p,{control:"local"}));',
      'game.players.filter(p=>p.role==="狼人").forEach(p=>Object.assign(profiles[p.id],{control:"api",endpoint:"https://example.test/v1",model:"wolf-seat-"+(p.id+1),key:"wolf-private-key-"+(p.id+1),reasoningEffort:p.id%2?"high":"xhigh"}));',
    ].join(''),
  );
  const wolves = JSON.parse(
    read('JSON.stringify(game.players.filter(p=>p.role==="狼人").map(p=>p.id))'),
  );
  context.fetch = async (url, options) => {
    if (url === '/api/agent-events') return { ok: true };
    assert.equal(url, '/api/chat/batch');
    const requests = JSON.parse(options.body).requests,
      encoder = new TextEncoder();
    let streamController;
    const group = {
      requests,
      signal: options.signal,
      emit(event) {
        try {
          streamController.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {}
      },
      result(seat, target) {
        const request = requests.find((item) => item.action.seat === seat);
        assert.ok(request);
        this.emit({
          type: 'result',
          seat,
          requestId: request.requestId,
          result: { choices: [{ message: { content: JSON.stringify({ target }) } }] },
        });
      },
      error(seat, code = 'UPSTREAM_ERROR') {
        const request = requests.find((item) => item.action.seat === seat);
        assert.ok(request);
        this.emit({
          type: 'error',
          seat,
          requestId: request.requestId,
          status: 503,
          error: { code, message: '模拟夜间接口错误' },
        });
      },
      close() {
        try {
          streamController.close();
        } catch {}
      },
    };
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
        options.signal.addEventListener(
          'abort',
          () => {
            try {
              controller.error(Object.assign(Error('cancelled'), { name: 'AbortError' }));
            } catch {}
          },
          { once: true },
        );
      },
    });
    groups.push(group);
    return { ok: true, status: 200, body };
  };
  let running;
  t.after(async () => {
    read('reset()');
    for (const group of groups) group.close();
    await running;
  });
  return {
    context,
    read,
    groups,
    wolves,
    start() {
      running = read('collectWolfChoices(game.alive().filter(p=>p.role==="狼人"),epoch,null)');
      return running;
    },
  };
}

function agentConfigFetch(handler) {
  return async (url, request = {}) => {
    if (url === '/api/agent-config') return handler(request);
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

const settle = async (context) => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await vm.runInContext('agentConfigSyncChain', context);
  }
};

module.exports = {
  test,
  assert,
  vm,
  fs,
  os,
  path,
  Nightfall,
  APP_SCRIPTS,
  setup,
  voteStream,
  batchCompatibleFetch,
  installStory,
  until,
  prepareAuto,
  installSpeech,
  installRuleAudio,
  installNatural,
  speechPipeline,
  votingHarness,
  wolfHarness,
  agentConfigFetch,
  settle,
};
