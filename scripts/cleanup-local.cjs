'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { dataRoot } = require('../scenario-store.cjs');
const TARGETS = ['output', '.playwright-cli', 'logs/test'];
async function inspectTree(directory, visit) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name),
      stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      await inspectTree(file, visit);
      await visit(file, stat);
    } else if (stat.isFile()) await visit(file, stat);
  }
}
async function cleanupLocal({
  root = path.resolve(__dirname, '..'),
  days = 14,
  apply = false,
  now = Date.now(),
  stories = dataRoot,
} = {}) {
  if (!Number.isFinite(days) || days < 0) throw Error('--days 需要为非负天数');
  const base = await fs.realpath(root),
    cutoff = now - days * 86400000,
    results = [];
  for (const name of TARGETS) {
    const target = path.resolve(base, name),
      report = { directory: name, files: 0, bytes: 0, removed: 0 };
    if (!target.startsWith(base + path.sep)) throw Error('清理目录超出项目范围');
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        results.push(report);
        continue;
      }
      const resolved = await fs.realpath(target);
      if (!resolved.startsWith(base + path.sep)) throw Error('清理目录超出项目范围');
      await inspectTree(target, async (file, item) => {
        if (item.isDirectory()) {
          if (apply && item.mtimeMs < cutoff)
            await fs.rmdir(file).catch((error) => {
              if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error;
            });
        } else if (item.mtimeMs < cutoff) {
          report.files++;
          report.bytes += item.size;
          if (apply) {
            await fs.unlink(file);
            report.removed++;
          }
        }
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    results.push(report);
  }
  let storyBytes = 0;
  if (stories) {
    const stat = await fs.lstat(stories).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat?.isDirectory() && !stat.isSymbolicLink())
      await inspectTree(stories, async (_, item) => {
        if (item.isFile()) storyBytes += item.size;
      });
  }
  return { apply, days, results, storyBytes };
}
async function main(args) {
  let apply = false,
    days = 14;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--days' && args[i + 1] !== undefined) days = Number(args[++i]);
    else throw Error('用法 npm run cleanup -- [--apply] [--days 14]');
  }
  console.log(JSON.stringify(await cleanupLocal({ apply, days }), null, 2));
}
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { cleanupLocal };
