'use strict';
// Local-only maintenance: never reads provider credentials or submits generation jobs.
const fs = require('node:fs/promises'),
  path = require('node:path');
const { createScenarioStore } = require('../scenario-store.cjs'),
  D = require('../scenario-dedup.cjs');
(async () => {
  const [mode, archive] = process.argv.slice(2),
    store = createScenarioStore();
  if (mode === '--apply' || mode === '--restore') {
    if (!archive || !path.isAbsolute(archive))
      throw Error('请指定绝对备份目录；操作前关闭游戏服务。');
    const m = await (mode === '--apply'
      ? D.archiveDuplicates(store, archive)
      : D.restoreArchive(store, archive));
    console.log(JSON.stringify(m, null, 2));
  } else
    console.log(
      JSON.stringify(
        (await D.groupStories(store.root, await store.all())).map((g) => ({
          roomSize: g.keep.roomSize || 6,
          title: g.keep.title,
          keep: g.keep.id,
          validVideo: g.validVideo,
          remove: g.remove.map((s) => s.id),
        })),
        null,
        2,
      ),
    );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
