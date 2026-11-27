'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const S = require('./scenario.js'),
  W = require('./workshop-state.js');

for (const size of [6, 12])
  test(size + ' 人电影剧本：可变时间轴、全员对白、固定音色和秘密隔离', () => {
    const s = S.bloodMoonSample(size),
      plan = S.videoPlan(s);
    assert.deepEqual(S.validate(s), s);
    assert.equal(plan.profile, 'cinema-refs-v1');
    assert.equal(
      plan.targetDuration,
      plan.sceneDurations.reduce((a, b) => a + b, 0),
    );
    assert.ok(Number.isInteger(plan.targetDuration) && plan.targetDuration >= 1);
    assert.equal(plan.sceneDuration, null);
    assert.equal(
      plan.sceneDurations.reduce((a, b) => a + b, 0),
      plan.targetDuration,
    );
    assert.ok(new Set(plan.sceneDurations).size > 1);
    assert.deepEqual(
      new Set(s.scenes.flatMap((x) => x.dialogues.map((d) => d.seat))),
      new Set(s.characters.map((c) => c.seat)),
    );
    for (let i = 0; i < s.scenes.length; i++) {
      const scene = s.scenes[i],
        refs = S.audioReferences(s, i),
        prompt = S.referenceVideoPrompt(
          s,
          i,
          s.characters.map((c) => ({ ...c, appearance: S.appearance(c) })),
        );
      assert.ok(scene.duration >= 1 && scene.duration <= 15);
      assert.ok(scene.cast.length <= 6);
      assert.ok(refs.length <= 3);
      assert.deepEqual(
        refs.map((x) => x.seat),
        [...new Set(scene.dialogues.map((d) => d.seat))],
      );
      for (const [n, ref] of refs.entries()) {
        assert.equal(ref.voice_id, plan.voiceMap[ref.seat]);
        assert.ok(prompt.includes('<AUDIO_' + n + '>'));
      }
      for (const line of scene.dialogues) {
        assert.ok(prompt.includes(line.text));
        assert.ok(scene.cast.includes(line.seat));
      }
      const t = S.timing(scene);
      assert.ok(t.narrationEnd <= t.dialogueStart);
      for (const c of s.characters) {
        assert.ok(!prompt.includes(c.secret));
        assert.ok(!JSON.stringify(S.context(s, c.seat)).includes(c.secret));
      }
    }
    const prompt = S.prepareForRoom(size);
    assert.match(prompt, /1至15秒/);
    assert.match(prompt, /不固定90秒/);
    assert.match(prompt, /不固定90秒、120秒/);
    assert.match(prompt, /镜头数量和总时长由故事完整性决定/);
  });

test('电影生成前拒绝非法时长、缺席角色、过多说话者、无效音色与对白时段', () => {
  const rejects = (change, pattern) => {
    const s = S.bloodMoonSample();
    change(s);
    assert.throws(() => S.validate(s), pattern);
  };
  for (const duration of [0, 16, 1.5]) rejects((s) => (s.scenes[0].duration = duration), /1—15/);
  const changed = S.bloodMoonSample();
  changed.scenes[0].duration++;
  const validated = S.validate(changed);
  assert.equal(validated.scenes[0].duration, changed.scenes[0].duration);
  assert.equal(
    validated.targetDuration,
    changed.scenes.reduce((sum, scene) => sum + scene.duration, 0),
  );
  assert.equal(
    S.videoPlan(changed).targetDuration,
    changed.scenes.reduce((sum, scene) => sum + scene.duration, 0),
  );
  rejects(
    (s) => s.scenes.forEach((x) => (x.dialogues = x.dialogues.filter((d) => d.seat !== 6))),
    /全部6位/,
  );
  rejects((s) => {
    s.scenes[1].dialogues = [1, 2, 3, 4].map((seat) => ({ seat, text: '嗯' }));
    s.scenes[1].cast = [1, 2, 3, 4];
  }, /三位/);
  rejects((s) => (s.scenes[1].dialogues = [{ seat: 7, text: '嗯' }]), /席位无效/);
  rejects((s) => (s.scenes[1].cast = []), /出场人物/);
  rejects((s) => (s.characters[0].voiceId = 'invented'), /音色/);
  rejects((s) => {
    const x = s.scenes[1];
    x.narration = '旁白';
    x.narrationSeconds = x.duration;
  }, /预留时段/);
  rejects((s) => (s.scenes[1].dialogues[0].text = '话'.repeat(200)), /对白过长/);
  const s = S.bloodMoonSample();
  s.scenes[1].dialogues = [
    { seat: 2, text: '第一句' },
    { seat: 1, text: '第二句' },
    { seat: 2, text: '第三句' },
  ];
  assert.deepEqual(
    S.audioReferences(s, 1).map((x) => x.seat),
    [2, 1],
  );
});

test('两种人数的不完整电影草稿按版本恢复，嵌套对白不保存密钥', () => {
  const values = new Map(),
    storage = { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v) };
  let state = W.read(storage);
  for (const roomSize of [6, 12]) {
    const draft = S.bloodMoonSample(roomSize);
    draft.title = '';
    draft.scenes[1].dialogues[0].apiKey = 'do-not-save';
    draft.scenes[0].duration = 0;
    state = W.save(storage, state, {
      draft,
      dirty: true,
      artEdits: { 'art:2': { 'frame-11': '未提交分镜描述' } },
    });
  }
  const restored = W.read(storage);
  assert.equal(restored.lastByRoom[6], 'new');
  assert.equal(restored.lastByRoom[12], 'new:12');
  for (const [size, key] of [
    [6, 'new'],
    [12, 'new:12'],
  ]) {
    const entry = restored.entries[key];
    assert.equal(entry.draft.roomSize, size);
    assert.equal(entry.draft.scenes[0].duration, 0);
    assert.ok(entry.draft.characters[0].voiceId);
    assert.ok(entry.draft.scenes[1].dialogues.length);
    assert.equal(entry.artEdits['art:2']['frame-11'], '未提交分镜描述');
  }
  assert.ok(!JSON.stringify(restored).includes('do-not-save'));
});

for (const size of [6, 12])
  test(size + ' 人生成前阻止错配或未核对音色，明确绑定图片、性别、声音与台词', () => {
    const s = S.bloodMoonSample(size);
    assert.deepEqual(S.voiceIssues(s), []);
    for (const c of s.characters) {
      assert.equal(S.VOICE_INFO[S.voiceId(c)].gender, S.characterGender(c));
    }
    s.characters[0].voiceId = 'leo';
    assert.throws(() => S.videoPlan(s), /1号.*女性.*男声/);
    s.characters[0].voiceId = 'altair';
    assert.throws(() => S.videoPlan(s), /男女声尚未核对/);
    s.characters[0].voiceId = S.matchedVoice(s.characters[0]);
    const scene = s.scenes[1];
    scene.cast = [1, 5, 6];
    scene.dialogues = [
      { seat: 5, text: '请看这里。' },
      { seat: 1, text: '我听见了。' },
      { seat: 6, text: '请继续。' },
      { seat: 5, text: '好。' },
    ];
    const prompt = S.referenceVideoPrompt(s, 1, s.characters);
    assert.match(prompt, /Seat 5 .*?man, MALE voice.*?<IMAGE_2>.*?<AUDIO_0>/);
    assert.match(prompt, /Seat 1 .*?woman, FEMALE voice.*?<IMAGE_1>.*?<AUDIO_1>/);
    assert.match(prompt, /Seat 6 .*?woman, FEMALE voice.*?<IMAGE_3>.*?<AUDIO_2>/);
    assert.equal((prompt.match(/<AUDIO_0>/g) || []).length, 2);
    assert.deepEqual(
      S.audioReferences(s, 1).map((r) => r.seat),
      [5, 1, 6],
    );
    const plan = S.videoPlan(s);
    assert.equal(plan.voiceContractVersion, 4);
    assert.equal(plan.voiceCharacters[0].gender, 'female');
  });

test('人物声音性别独立保存、默认与预演按性别匹配，公开人物字段进入玩家上下文', () => {
  const s = S.bloodMoonSample(12);
  s.characters[7].gender = 'male';
  s.characters[7].voiceId = S.matchedVoice(s.characters[7]);
  const clean = S.validate(s),
    draft = W.draft(clean);
  assert.equal(draft.characters[7].gender, 'male');
  assert.equal(S.characterGender({ seat: 2, appearance: '成年红发女性' }), 'female');
  assert.equal(S.characterGender({ seat: 2, portraitId: 'portrait-08' }), 'female');
  assert.equal(S.characterGender({ seat: 2, appearance: '成年男性', gender: 'female' }), 'female');
  for (const c of clean.characters) {
    assert.equal(S.VOICE_INFO[S.voiceId(c)].gender, S.characterGender(c));
    assert.match(S.previewVoice(c), S.characterGender(c) === 'female' ? /Xiao|Hsiao/ : /Yun/);
  }
  const changed = structuredClone(clean);
  changed.characters[0].gender = 'male';
  const P = require('./workshop-preview.js');
  assert.notEqual(P.fingerprint(clean, {}), P.fingerprint(changed, {}));
  for (const c of clean.characters) {
    const ctx = JSON.stringify(S.context(clean, c.seat));
    for (const field of ['previewVoice', 'voiceContractVersion']) assert.ok(!ctx.includes(field));
    assert.ok(ctx.includes('voiceId'));
    assert.ok(ctx.includes('gender'));
    assert.ok(!ctx.includes(c.secret));
  }
});

test('人物介绍标记只影响后期合成，不改变Grok视频制作版本签名', () => {
  const s = S.bloodMoonSample(6);
  s.confirmed = true;
  const pending = { enabled: true, confirmed: false, markers: [] };
  assert.equal(
    S.productionSignature(s),
    S.productionSignature({ ...s, introductions: pending, introSourceId: 'local-draft' }),
  );
  const legacy = structuredClone(s);
  legacy.characters.forEach((c) => delete c.gender);
  assert.equal(S.productionSignature(s), S.productionSignature(legacy));
  const changed = structuredClone(s);
  changed.scenes[0].description += ' 调整镜头。';
  assert.notEqual(S.productionSignature(s), S.productionSignature(changed));
});

test('视频提示词中的语言说明与英文或中文剧本一致', () => {
  const story = S.bloodMoonSample(6);
  const english = { ...story, language: 'en' };
  const prompt = S.referenceVideoPrompt(english, 0, english.characters);
  assert.match(prompt, /Generate natural English character speech/);
  assert.doesNotMatch(prompt, /Generate natural Mandarin character speech/);
  assert.match(
    S.referenceVideoPrompt(story, 0, story.characters),
    /Generate natural Mandarin character speech/,
  );
});

for (const size of [6, 12]) {
  test(`${size}人双语草稿可校验，英文对白有逐句译文且覆盖所有人物`, () => {
    const draft = S.bloodMoonEnglishSample(size);
    const lines = draft.scenes.flatMap((scene) => scene.dialogues);
    assert.equal(draft.language, 'en');
    assert.equal(draft.confirmed, false);
    assert.equal(new Set(lines.map((line) => line.seat)).size, size);
    assert.ok(
      lines.every((line) => /[A-Za-z]/.test(line.text) && /[\u4e00-\u9fff]/.test(line.translation)),
    );
    assert.ok(draft.scenes.every((scene) => !scene.narration || scene.narrationTranslation));
    assert.doesNotThrow(() => S.validate(draft));
  });
}
