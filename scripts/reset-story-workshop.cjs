'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const root = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'NightfallWerewolf',
);
const stories = path.join(root, 'stories');
const backup = path.join(
  root,
  'backups',
  'story-workshop-reset-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
async function files(dir, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(dir, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...(await files(dir, name)));
    else if (entry.isFile()) result.push(name);
    else throw Error('不支持的文件类型，已停止清理：' + name);
  }
  return result.sort();
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  const data = await fs.readFile(file);
  hash.update(data);
  return { size: data.length, sha256: hash.digest('hex') };
}
(async () => {
  const sourceFiles = await files(stories);
  const removable = sourceFiles.filter((name) => name !== 'video-provider.json');
  await fs.mkdir(path.join(backup, 'data'), { recursive: true });
  const entries = [];
  for (const name of removable) {
    const source = path.join(stories, name);
    const target = path.join(backup, 'data', name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, require('node:fs').constants.COPYFILE_EXCL);
    const original = await digest(source);
    const copy = await digest(target);
    if (original.size !== copy.size || original.sha256 !== copy.sha256)
      throw Error('备份校验失败：' + name);
    entries.push({ path: name, ...original });
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    sourceRoot: stories,
    cleared: entries,
    preserved: [
      'stories/video-provider.json',
      'image-provider.json',
      'Agent、席位、声音及游戏配置',
      '浏览器配置',
    ],
    remoteTasks: '远端任务未删除，运行中或结果不明的任务仅停止本地追踪。',
  };
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    flag: 'wx',
  });
  await fs.writeFile(
    path.join(backup, 'RESTORE.md'),
    '恢复前请先停止游戏服务并备份当前工坊数据。将 data 目录中的文件按原相对路径复制回 stories 目录。恢复时注意不要覆盖需要保留的新剧本。配置文件留在原位置。\n',
    { flag: 'wx' },
  );
  if (JSON.stringify(await files(stories)) !== JSON.stringify(sourceFiles))
    throw Error('备份期间源目录发生变化，未清理任何文件');
  for (const row of entries) {
    const now = await digest(path.join(stories, row.path));
    if (now.size !== row.size || now.sha256 !== row.sha256)
      throw Error('备份期间文件发生变化，未清理任何文件：' + row.path);
  }
  for (const row of entries) await fs.unlink(path.join(stories, row.path));
  for (const name of ['versions', 'art', 'videos', 'previews', 'titles', 'reviews'])
    await fs.mkdir(path.join(stories, name), { recursive: true });
  console.log(
    JSON.stringify({
      backup,
      verifiedFiles: entries.length,
      bytes: entries.reduce((n, row) => n + row.size, 0),
      manifest: path.join(backup, 'manifest.json'),
    }),
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
