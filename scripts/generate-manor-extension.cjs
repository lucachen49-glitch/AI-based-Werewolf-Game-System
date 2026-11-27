'use strict';
// Explicitly authorized one-time artwork production; uses only the saved image credential.
const fs = require('node:fs/promises'),
  path = require('node:path');
const { createImageProvider } = require('../image-provider.cjs');
const { createImageConfigStore } = require('../image-config.cjs');
const root = path.resolve(__dirname, '..'),
  dir = path.join(root, 'output/imagegen/twelve-extension');
const people = [
  [
    7,
    '铜钟匠人',
    'One adult man, age about 38, chestnut curly hair, a neatly groomed short beard, thoughtful kind expression, copper-brown aristocratic suit with antique gold embroidery. No tools or weapons.',
    2,
  ],
  [
    8,
    '青藤信使',
    'One adult woman, age about 28, black hair in an elegant updo, confident attentive expression, deep forest-green aristocratic long dress with antique gold embroidery. No hats or handheld objects.',
    4,
  ],
  [
    9,
    '赤枫向导',
    'One adult man, age about 32, short auburn-red hair, clean-shaven, strong friendly features, charcoal gray aristocratic coat with muted gold lapels. No weapons, armor or outdoor equipment.',
    3,
  ],
  [
    10,
    '霜蓝画师',
    'One adult woman, age about 30, silver-white bob haircut, calm observant expression, midnight navy-blue aristocratic long dress with subdued silver trim. No tools or handheld objects.',
    6,
  ],
  [
    11,
    '暮紫来客',
    'One adult man, age about 45, neatly swept golden-brown hair, clean-shaven, mature reserved expression, dark plum-purple aristocratic suit with antique gold detailing. No weapons or handheld objects.',
    5,
  ],
  [
    12,
    '烛铜学徒',
    'One adult woman, age about 25, long straight dark-brown hair, warm resolute expression, antique bronze-brown aristocratic long dress with fine black lace and gold trim. No medicine, tools or handheld objects.',
    1,
  ],
];
async function writeState(state) {
  const temp = path.join(dir, 'state.tmp');
  await fs.writeFile(temp, JSON.stringify(state, null, 2));
  await fs.rename(temp, path.join(dir, 'state.json'));
}
(async () => {
  await fs.mkdir(dir, { recursive: true });
  let state;
  try {
    state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    state = { model: 'gpt-image-2', createdAt: new Date().toISOString(), items: [] };
  }
  // Any interrupted submission is uncertain; rerunning this script must never resubmit it.
  if (state.items.some((i) => !['done', 'rejected'].includes(i.status)))
    throw Error('已有结果不明或中断的制作，请核对 state.json；不会自动重发。');
  const provider = createImageProvider({ config: createImageConfigStore() });
  for (const [seat, name, description, reference] of people) {
    const id = 'portrait-' + String(seat).padStart(2, '0');
    if (state.items.some((i) => i.id === id)) continue;
    const prompt = `Use case: stylized-concept. Production asset: ONE isolated seated adult character sprite for the same anime mystery manor game as the supplied reference. The reference is for painterly anime rendering, face detail, warm candlelight, camera, full chair framing and composition only: create a NEW distinguishable person, do not copy the reference person's face or clothing. ${description} The person sits naturally in an ornate carved dark walnut high-backed chair upholstered in dark burgundy leather, hands resting together on their lap. Complete chair top and sides, head to knees, upright composition, front three-quarter view with face turned toward the viewer and both eyes clearly visible. Slightly elevated camera and adult realistic proportions matching reference. Head high in frame, centered silhouette occupying 88 percent of canvas height with clear margin around hair, chair and clothing. Warm amber candle rim-light from upper left and subtle cool fill, rich dark browns and antique gold, refined hand-painted Japanese visual novel art. BACKGROUND: perfectly flat solid bright MAGENTA #ff00ff, no shadow, floor, room, gradients, writing or scenery. Magenta is a temporary extraction matte, NOT part of the character: absolutely no pink or magenta material on person or chair. Preserve dark GREEN garments if present. No text, numbers, nameplate, role symbols, wolf ears, fangs, witch hats, magical props, extra people or extra chairs. Use this exact single-person framing; don't reproduce the reference background. Portrait canvas 1024x1536.`;
    await fs.writeFile(path.join(dir, id + '.txt'), prompt);
    const ref = await fs.readFile(
      path.join(root, 'assets/manor/portrait-' + String(reference).padStart(2, '0') + '.webp'),
    );
    const item = {
      id,
      name,
      reference: 'portrait-' + String(reference).padStart(2, '0'),
      status: 'submitting',
      startedAt: new Date().toISOString(),
    };
    state.items.push(item);
    await writeState(state);
    console.log(id + ' submitting');
    try {
      const bytes = await provider.generate({
        prompt,
        references: [ref],
        size: '1024x1536',
        onProgress: async (stage) => {
          item.stage = stage;
          item.updatedAt = new Date().toISOString();
          await writeState(state);
          console.log(id + ' ' + stage);
        },
      });
      await fs.writeFile(path.join(dir, id + '.png'), bytes, { flag: 'wx' });
      item.status = 'done';
      item.bytes = bytes.length;
      item.completedAt = new Date().toISOString();
      await writeState(state);
      console.log(id + ' saved');
    } catch (error) {
      item.status = error.code === 'IMAGE_REJECTED' ? 'rejected' : 'unknown';
      item.code = error.code || 'LOCAL_SAVE_UNKNOWN';
      item.message = error.code
        ? error.message
        : '图片保存未完成，请核对供应商与本地文件；不会自动重发';
      await writeState(state);
      throw Error(id + ': ' + item.message);
    }
  }
  console.log('Six portrait originals saved; no automatic retries.');
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
