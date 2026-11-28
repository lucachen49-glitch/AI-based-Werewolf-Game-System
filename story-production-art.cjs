'use strict';
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
function createProductionArt({ reportId, now, patch, running, artJobs, assetHash, audit, get }) {
  function candidateFor(j, key, r, changes, affected, findingIndex = null, sourceFinding = null) {
    return {
      id: randomUUID(),
      key,
      reportId: r.id || reportId(key, r),
      reportVersion: r.checkedAt || null,
      originalFingerprint: j.fingerprint,
      assetFingerprint: r.fingerprint,
      artRevision: j.artRevision || null,
      videoId: j.videoId || null,
      findingIndex,
      sourceFinding,
      changes,
      affected,
      createdAt: now(),
      status: 'pending',
    };
  }
  function affectedFrames(art, kind, index) {
    const visited = new Set([kind + ':' + index]);
    for (const f of art.frames)
      if ((f.dependencyIds || []).some((x) => visited.has(x))) visited.add('frame:' + f.index);
    return [...visited];
  }
  async function suggestArt(j, key, result, art, kind, i) {
    if (
      result.verdict !== 'redo' ||
      j.candidates?.some(
        (c) =>
          c.key === key && c.assetFingerprint === result.fingerprint && c.status !== 'withdrawn',
      )
    )
      return;
    const items =
        kind === 'character'
          ? art.characters
          : kind === 'visual'
            ? art.visualAssets || []
            : art.frames,
      item = items[i],
      base =
        item[kind === 'character' ? 'appearance' : kind === 'visual' ? 'prompt' : 'description'];
    const notes = (result.findings || [])
      .map((f) => f.suggestion)
      .filter(Boolean)
      .join('；');
    const handFixes = [
      '镜头1：中近景完整显示薇拉右前臂、手腕、整只手和邀请函。只用右手在信封侧边作明确指尖夹持，拇指垫压正面，食指尖从背面正对支撑，中指托住背面边缘；信封底边悬空，不接触掌心。掌心绝不能托在信封下方。手与纸张轮廓分离，接触点清楚，恰好五指且自然连接。禁止信封贴手、穿手、悬浮、额外手或畸形指。',
      '镜头2结尾：薇拉继续由同一只右手在腰前竖直夹持同一封邀请函，完整露出前臂、手腕和手，背景为深色裙身。拇指在纸张正面，食指在纸边背面相抵，中指支撑背面，其余两指自然弯曲。只有薇拉右手参与握信，其他人物的手按本镜起始状态自然放置，每只可见手均为自然连接的五指。纸张不贴掌、不穿模、不浮空。起始静帧只呈现本镜开始姿势，递灯和行走留给后续动画。',
      '镜头3开始：严格复制镜头2结尾参考中的薇拉、画面侧、右臂角度、手腕、手势、邀请函大小方向、封蜡和光线。同一封邀请函仍由薇拉右手在侧边用拇指与食指相对夹持，中指支撑背面，另两指自然弯曲。完整展示自然连接的五指、手腕和纸张，禁止六指、重复指、掌心托信、信封贴手或穿模。只有薇拉拿邀请函。空主位前的封口留言是另一件道具，按本镜起始状态留在桌上或由艾琳取阅，不提前执行结尾动作。',
    ];
    const fixed =
      kind === 'frame' &&
      j.roomSize === 6 &&
      i < 3 &&
      /薇拉|Vera/i.test(j.snapshot.characters[0]?.name)
        ? handFixes[i]
        : '';
    if (!notes && !fixed) return;
    const candidate = candidateFor(
      { ...j, artRevision: art.revision },
      key,
      result,
      {
        text: [fixed, base, notes]
          .filter(Boolean)
          .join('\n')
          .slice(0, kind === 'character' ? 800 : kind === 'visual' ? 4000 : 1000),
      },
      affectedFrames(art, kind, i),
    );
    await patch(j.id, (latest) => ({ candidates: [...(latest.candidates || []), candidate] }));
  }
  async function checkArt(j, kind, art, selectedIndexes = null) {
    const items =
      kind === 'character'
        ? art.characters
        : kind === 'visual'
          ? art.visualAssets || []
          : art.frames;
    const indexes = selectedIndexes
      ? [...new Set(selectedIndexes)].filter(
          (index) => Number.isInteger(index) && index >= 0 && index < items.length,
        )
      : items.map((_, index) => index);
    for (const i of indexes) {
      if (!(await running(j.id))) return false;
      const item = items[i],
        key = kind + ':' + i,
        asset = await artJobs.mediaFile(art.id, item.file),
        hash = await assetHash(asset);
      const refs =
        kind === 'frame'
          ? (item.cast || []).map((seat) => ({
              file: path.join(artJobs.root, art.id, art.characters[seat - 1].file),
              label: '人物 ' + seat + ' 已确认定妆参考',
            }))
          : [];
      if (kind === 'frame') {
        for (const dependency of new Set([
          ...(i > 0 ? [i - 1] : []),
          ...(j.snapshot.scenes[i]?.referenceFrames || []),
        ]))
          if (art.frames[dependency]?.file)
            refs.push({
              file: await artJobs.mediaFile(art.id, art.frames[dependency].file),
              label: '镜头 ' + (dependency + 1) + ' 分镜起始图，仅供空间或道具对照；它不是实际尾帧',
            });
        for (const asset of art.visualAssets || [])
          if (asset.file && (asset.scenes || []).includes(i))
            refs.push({
              file: await artJobs.mediaFile(art.id, asset.file),
              label: asset.label + ' 已确认视觉参考',
            });
      }
      if (kind === 'frame')
        for (const ref of item.referenceManifest || [])
          if (ref.snapshotFile)
            refs.push({
              file: await artJobs.mediaFile(art.id, ref.snapshotFile),
              label:
                '生成时使用的' +
                ref.purpose +
                '参考图 ' +
                (ref.label || '') +
                '，用于核对物品和场景一致性',
            });
      const referenceHashes = await Promise.all(refs.map((ref) => assetHash(ref.file)));
      const checkVersion =
        kind === 'frame' && j.roomSize === 6 && i < 3
          ? 'media-check-v4-hand-detail'
          : 'media-check-v3';
      const reviewHash = createHash('sha256')
        .update(
          JSON.stringify([
            checkVersion,
            j.storyId,
            j.roomSize,
            hash,
            referenceHashes,
            item.contentFingerprint || null,
            kind === 'character'
              ? j.snapshot.characters[i]
              : kind === 'visual'
                ? j.visualAssets?.[i]
                : j.snapshot.scenes[i],
            j.snapshot.visualGuide,
          ]),
        )
        .digest('hex');
      const result = await audit(
        j.id,
        key,
        {
          kind,
          index: i,
          images: [
            {
              file: asset,
              label:
                kind === 'character'
                  ? '实际人物定妆照'
                  : kind === 'visual'
                    ? '实际关键视觉素材图'
                    : '实际分镜图',
            },
            ...refs,
          ],
        },
        reviewHash,
      );
      if (!result) return false;
      const stored = { ...result, id: result.id || reportId(key, result) };
      await artJobs.recordReview?.(art.id, art.revision, kind, i, {
        id: stored.id,
        fingerprint: reviewHash,
        verdict: stored.verdict,
        checkedAt: stored.checkedAt,
      });
      await suggestArt(await get(j.id), key, stored, art, kind, i);
    }
    return true;
  }

  return { candidateFor, affectedFrames, checkArt };
}
module.exports = { createProductionArt };
