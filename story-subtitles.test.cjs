'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { suggestedCues, cleanCues, makeSrt, createSubtitleJobs } = require('./story-subtitles.cjs');
const { run, inspect } = require('./video-media.cjs');

test('字幕建议保留两种语言，旁白与对白时间不重叠', () => {
  const job = {
    scenes: [
      {
        duration: 5,
        narration: 'Welcome.',
        narrationTranslation: '欢迎。',
        narrationSeconds: 1,
        dialogues: [{ text: 'Come in.', translation: '请进。' }],
      },
      { duration: 3, dialogues: [{ text: 'Wait.', translation: '等等。' }] },
    ],
  };
  const cues = suggestedCues(job);
  assert.equal(cues[1].start, 1);
  assert.equal(cues[2].start, 5);
  assert.deepEqual(cleanCues(cues, job), cues);
  assert.throws(
    () =>
      cleanCues(
        [
          { start: 0, end: 3, en: 'a', zh: '甲' },
          { start: 2, end: 4, en: 'b', zh: '乙' },
        ],
        job,
      ),
    /重叠/,
  );
  assert.throws(() => cleanCues([{ start: 0, end: 9, en: 'a', zh: '甲' }], job), /时间无效/);
  assert.throws(() => cleanCues([{ start: 0, end: 1, en: 'a', zh: '' }], job), /需要英文和中文/);
  assert.match(
    makeSrt(cues, {
      duration: 8,
      titleZh: '血月停战宴',
      titleEn: 'The Blood Moon Truce',
      hookZh: '谁值得信任？',
      hookEn: 'Who can you trust?',
    }),
    /血月停战宴/,
  );
});

test('本地字幕副本保存双语字幕和片尾，保留源文件', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '剧情字幕-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, '原片.mp4');
  await run(
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x180:r=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      source,
    ],
    30000,
  );
  const id = randomUUID(),
    storyId = randomUUID();
  const snapshot = {
    id,
    storyId,
    version: 1,
    status: 'ready',
    scenes: [{ duration: 2, dialogues: [{ text: 'Welcome.', translation: '欢迎。' }] }],
  };
  const service = createSubtitleJobs({
    root: path.join(root, '字幕'),
    jobs: { get: async () => snapshot, mediaFile: async () => source },
  });
  const result = await service.create({ sourceJobId: id, cues: suggestedCues(snapshot) });
  await service.close();
  const completed = await service.getSummary(result.id);
  assert.equal(completed.status, 'ready', completed.message);
  const output = await service.mediaFile(result.id, 'movie.mp4'),
    info = await inspect(output);
  assert.ok(info.audio && info.video);
  assert.ok(Math.abs(info.duration - 6) < 0.15);
  assert.equal((await inspect(source)).duration, 2);
  assert.match(
    await fs.readFile(await service.mediaFile(result.id, 'subtitles.srt'), 'utf8'),
    /欢迎。/,
  );
  assert.match(
    await fs.readFile(await service.mediaFile(result.id, 'subtitles.srt'), 'utf8'),
    /血月停战宴/,
  );
  const original = await fs.readFile(source);
  const revision = await service.applyCandidate(result.id, {
    titleEn: 'The Truce at Blood Moon Manor',
  });
  let revised;
  for (let i = 0; i < 1200; i++) {
    revised = await service.getSummary(revision.id);
    if (revised.status === 'ready' || revised.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(revised.status, 'ready', revised.message);
  assert.equal(revised.sourceJobId, id);
  assert.match(
    await fs.readFile(await service.mediaFile(revised.id, 'subtitles.srt'), 'utf8'),
    /The Truce at Blood Moon Manor/,
  );
  assert.deepEqual(await fs.readFile(source), original, '仅重新合成本地字幕和片尾，原视频保持不变');
  assert.equal((await inspect(await service.mediaFile(revised.id, 'movie.mp4'))).video, true);
  await service.close();
});
