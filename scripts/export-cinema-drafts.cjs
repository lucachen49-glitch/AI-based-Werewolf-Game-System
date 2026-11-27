'use strict';
// Export editable review copies without modifying the story library or contacting a provider.
const fs = require('node:fs/promises');
const path = require('node:path');
const S = require('../scenario.js');

(async () => {
  const dir = path.join(__dirname, '..', 'output', 'cinema-upgrade');
  await fs.mkdir(dir, { recursive: true });
  for (const size of [6, 12]) {
    const draft = S.bloodMoonSample(size);
    const lines = [
      `# 《${draft.title}》${size} 人电影草稿`,
      '',
      `目标片长：${draft.targetDuration} 秒；${draft.scenes.length} 个镜头。`,
      '',
      '这是未确认阅读稿，包含私人秘密，请勿作为公开旁白或直接传入视频模型。角色往事与本局随机身份独立。',
      '',
      '## 公开背景',
      '',
      draft.background,
      '',
      '## 统一视觉设定',
      '',
      draft.visualGuide,
      '',
      '## 人物',
    ];
    for (const c of draft.characters)
      lines.push(
        '',
        `### ${c.seat} 号 · ${c.name}`,
        '',
        `性格：${c.personality}`,
        '',
        `公开关系：${c.relationships}`,
        '',
        `仅本人知道的秘密：${c.secret}`,
        '',
        `视频音色：${c.voiceId}`,
      );
    lines.push('', '## 连续分镜');
    let start = 0;
    for (const [i, s] of draft.scenes.entries()) {
      const t = S.timing(s);
      lines.push(
        '',
        `### 镜头 ${i + 1} · ${start}—${start + s.duration} 秒`,
        '',
        `出场席位：${s.cast.join('、') || '无人环境镜头'}`,
        '',
        s.description,
        '',
        `起始：${s.startFrame}`,
        '',
        `结束：${s.endFrame}`,
      );
      if (s.narration)
        lines.push('', `旁白（本镜 ${t.narrationStart}—${t.narrationEnd} 秒）：${s.narration}`);
      if (s.dialogues.length)
        lines.push(
          '',
          `对白（本镜 ${t.dialogueStart}—${t.dialogueEnd} 秒，依次说）：`,
          '',
          ...s.dialogues.map(
            (d) => `- ${d.seat} 号 ${draft.characters[d.seat - 1].name}：“${d.text}”`,
          ),
        );
      start += s.duration;
    }
    await fs.writeFile(path.join(dir, `blood-moon-${size}.md`), lines.join('\n') + '\n');
    await fs.writeFile(
      path.join(dir, `blood-moon-${size}.json`),
      JSON.stringify(draft, null, 2) + '\n',
    );
    console.log(`${size} 人：${draft.scenes.length} 镜 / ${start} 秒，已导出阅读稿与未确认草稿。`);
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
