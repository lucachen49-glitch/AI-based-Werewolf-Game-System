'use strict';
const path = require('node:path');
function createProductionVideo({
  submit,
  artJobs,
  jobs,
  patch,
  subtitles,
  alignCues,
  checkpoint,
  blocked,
  poll,
  fail,
  assetHash,
  reviewer,
  audit,
  get,
  running,
}) {
  async function videoStep(j) {
    if (!j.videoId) {
      await submit(j.id, async () => {
        const art = await artJobs.get(j.artId);
        let video = (await jobs.list(j.storyId)).find(
          (v) =>
            v.version === j.version &&
            v.artId === art.id &&
            v.artRevision === art.revision &&
            (!v.productionId || v.productionId === j.id),
        );
        if (video) video = await jobs.claim(video.id, j.id);
        else
          video = await jobs.create({
            storyId: j.storyId,
            version: j.version,
            profile: 'cinema-refs-v1',
            artId: art.id,
            artRevision: art.revision,
            productionId: j.id,
            confirmCharge: true,
          });
        await patch(j.id, { videoId: video.id });
      });
      return;
    }
    const video = await jobs.get(j.videoId);
    if (['ready', 'accepted'].includes(video.status)) {
      if (!j.subtitleId) {
        const suggested = await subtitles.suggestions(video.id);
        const cues = alignCues(suggested.cues, j.transcripts || {}, j.snapshot);
        const final = await subtitles.create({
          productionId: j.id,
          sourceJobId: video.id,
          cues,
          titleZh: '血月停战宴',
          titleEn: 'The Blood Moon Truce',
          hookZh: '席位已定。你会相信谁？',
          hookEn: 'The seats are set. Who will you trust?',
        });
        await patch(j.id, {
          subtitleId: final.id,
          message: '镜头检查完成，正在本地合成双语字幕与主题片尾。',
        });
        return;
      }
      const final = await subtitles.getSummary(j.subtitleId);
      if (final.status === 'ready') {
        await checkpoint(j.id, 'final', '成片已完成，请完整观看并核对故事、画面、声音和双语字幕。');
        return;
      }
      if (final.status === 'failed') {
        await blocked(
          j.id,
          final.message || '本地合成中断，继续时复用视频重新合成。',
          'LOCAL_COMPOSE_FAILED',
        );
        return;
      }
      await poll();
      return;
    }
    if (video.status === 'running') {
      await poll();
      return;
    }
    if (video.status === 'quality_review') {
      const index = video.scenes.findIndex((s) => s.status === 'done' && s.quality !== 'passed');
      if (index < 0) fail('QUALITY_STATE', '镜头检查状态不一致，请继续查询');
      const asset = await jobs.mediaFile(video.id, 'scene-' + index + '.mp4'),
        hash = await assetHash(asset),
        key = 'video:' + index;
      let report = j.reports[key];
      if (report?.fingerprint !== hash) {
        await patch(j.id, {
          message:
            '正在检查镜头 ' +
            (index + 1) +
            ' 的实际画面、接点与英文语音，首次转写可能需要下载本地语音模型。',
        });
        const previous = index
            ? await jobs.mediaFile(video.id, 'scene-' + (index - 1) + '.mp4')
            : null,
          input = await reviewer.videoInput(asset, previous, j.snapshot, index);
        const art = await artJobs.get(j.artId);
        for (const seat of j.snapshot.scenes[index].cast || [])
          input.images.push({
            file: path.join(artJobs.root, art.id, art.characters[seat - 1].file),
            label: seat + '号定妆参考',
          });
        const frame = art.frames[index];
        if (frame?.file)
          input.images.push({
            file: await artJobs.mediaFile(art.id, frame.file),
            label: '本镜分镜起始图，仅用于对照，非实际视频画面',
          });
        for (const ref of frame?.referenceManifest || []) {
          if (ref.snapshotFile && ['scene', 'prop', 'costume'].includes(ref.purpose)) {
            input.images.push({
              file: await artJobs.mediaFile(art.id, ref.snapshotFile),
              label: '生成分镜时使用的' + ref.purpose + '参考图 ' + (ref.label || ''),
            });
          }
        }
        report = await audit(j.id, key, { kind: 'video', index, ...input }, hash);
        if (!report) return;
        const latest = await get(j.id);
        await patch(j.id, {
          transcripts: { ...latest.transcripts, [index]: input.transcript },
        });
      }
      if (!(await running(j.id))) return;
      if (report.verdict !== 'pass' && j.acceptedIssues?.[key] !== hash) {
        await blocked(
          j.id,
          '镜头 ' + (index + 1) + ' 需要人工确认。请查看检查依据及实际片段，再选择接受此镜头继续。',
          'SHOT_INSPECTION_REQUIRED',
        );
        return;
      }
      await submit(j.id, async () => {
        await jobs.unpause(video.id);
        await jobs.action(video.id, {
          action: 'approveScene',
          index,
          productionId: j.id,
        });
      });
      return;
    }
    if (video.scenes.some((s) => ['unknown', 'submitting', 'stale', 'failed'].includes(s.status))) {
      await blocked(
        j.id,
        video.message || '视频提交或素材状态需要处理，原任务编号已保留。',
        'VIDEO_REVIEW_REQUIRED',
      );
      return;
    }
    await submit(j.id, async () => {
      await jobs.unpause(video.id);
      await jobs.action(video.id, { action: 'resume' });
    });
    await poll();
  }

  return videoStep;
}
module.exports = { createProductionVideo };
