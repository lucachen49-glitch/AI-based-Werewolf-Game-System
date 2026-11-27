'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  { spawn } = require('node:child_process'),
  { createHash } = require('node:crypto');
const { StoryError } = require('./scenario-store.cjs');
const { speechAudio } = require('./voice.cjs');
const { musicTracks } = require('./soundfx.js');
const Schema = require('./scenario.js');
async function ffmpegPath() {
  if (process.env.NIGHTFALL_FFMPEG) return process.env.NIGHTFALL_FFMPEG;
  const dir = path.join(
    __dirname,
    '.video-venv',
    'Lib',
    'site-packages',
    'imageio_ffmpeg',
    'binaries',
  );
  try {
    const files = await fs.readdir(dir);
    const exe = files.find((f) => /^ffmpeg.*\.exe$/.test(f));
    if (exe) return path.join(dir, exe);
  } catch {}
  return 'ffmpeg';
}
function cancelled() {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}
async function run(args, timeout = 180000, signal) {
  if (signal?.aborted) throw cancelled();
  const executable = await ffmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let details = '',
      settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(details);
    };
    const abort = () => {
      child.kill();
      finish(cancelled());
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new StoryError(
          503,
          'VIDEO_MEDIA_TIMEOUT',
          '本地音视频处理超时，已保留完成的素材，请稍后继续',
        ),
      );
    }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stderr.on('data', (b) => {
      details = (details + b.toString()).slice(-16000);
    });
    child.on('error', () =>
      finish(
        new StoryError(503, 'VIDEO_MEDIA_ERROR', '本地视频工具不可用，请运行 setup-video.cmd'),
      ),
    );
    child.on('close', (code) =>
      finish(
        code === 0
          ? null
          : new StoryError(
              503,
              'VIDEO_MEDIA_ERROR',
              '本地音视频处理失败，已保留完成的素材，请检查视频格式后继续',
            ),
      ),
    );
  });
}
async function inspect(file, signal) {
  const info = await run(
      ['-hide_banner', '-i', file, '-t', '0.05', '-f', 'null', '-'],
      30000,
      signal,
    ),
    d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(info);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    audio: /Audio:/.test(info),
    video: /Video:/.test(info),
  };
}
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
function createMediaTools({ synthesize = speechAudio } = {}) {
  return {
    async available() {
      try {
        await run(['-version'], 10000);
        return true;
      } catch {
        return false;
      }
    },
    async extractLastFrame(file, output, { signal } = {}) {
      await run(
        [
          '-y',
          '-sseof',
          '-0.5',
          '-i',
          file,
          '-vf',
          'reverse',
          '-frames:v',
          '1',
          '-update',
          '1',
          output,
        ],
        30000,
        signal,
      );
    },
    async normalize(
      file,
      output,
      { audioMode = 'native', duration = 10, continuous = false, signal } = {},
    ) {
      const info = await inspect(file, signal);
      if (['native', 'dialogue-narration'].includes(audioMode) && !info.audio)
        throw new StoryError(
          502,
          'VIDEO_NO_AUDIO',
          '镜头未包含模型对白音轨，已停止后续制作；请确认华龙返回了原生声音',
        );
      if (!info.video || info.duration < duration - 0.05)
        throw new StoryError(
          502,
          'VIDEO_TOO_SHORT',
          '供应商返回的镜头时长不足，已停止后续制作；不会重复或冻结画面补足时长',
        );
      const temp = output + '.tmp.mp4';
      const picture =
        'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1' +
        (audioMode === 'unified' && !continuous
          ? `,fade=t=in:st=0:d=0.125,fade=t=out:st=${duration - 0.125}:d=0.125`
          : '');
      // Continuous clips share an audio track layout, including shots without dialogue.
      const silent = continuous && audioMode === 'unified';
      const audioMap = silent
        ? ['-map', '1:a:0']
        : audioMode === 'unified'
          ? ['-an']
          : ['-map', '0:a:0'];
      const audioEncoding =
        silent || audioMode !== 'unified' ? ['-c:a', 'aac', '-ar', '48000', '-ac', '2'] : [];
      try {
        await run(
          [
            '-hide_banner',
            '-y',
            '-i',
            file,
            ...(silent ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
            '-t',
            String(duration),
            '-map',
            '0:v:0',
            ...audioMap,
            '-vf',
            picture,
            '-r',
            '24',
            '-c:v',
            'libx264',
            '-preset',
            'fast',
            '-crf',
            '21',
            '-pix_fmt',
            'yuv420p',
            ...audioEncoding,
            '-movflags',
            '+faststart',
            temp,
          ],
          180000,
          signal,
        );
        await fs.rename(temp, output);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
      }
    },
    async prepareNarration(dir, job, { signal, onProgress = () => {} } = {}) {
      await fs.mkdir(dir, { recursive: true });
      const voice = {
        provider: 'neural',
        voice: job.language === 'en' ? 'en-US-GuyNeural' : 'zh-CN-YunyangNeural',
        style: 'calm',
        speed: 1,
      };
      const signature = createHash('sha256')
        .update(
          JSON.stringify({
            voice,
            mode: job.audioMode,
            scenes: job.scenes.map((s) => ({
              text: s.narration,
              duration: s.duration || job.sceneDuration || 10,
              timing: s.timing || Schema.timing(s),
            })),
          }),
        )
        .digest('hex');
      let saved;
      try {
        saved = JSON.parse(await fs.readFile(path.join(dir, 'narration.json'), 'utf8'));
      } catch {}
      if (saved?.signature !== signature) saved = { signature, tracks: [] };
      for (let i = 0; i < job.scenes.length; i++) {
        if (signal?.aborted) throw cancelled();
        const file = path.join(dir, 'narration-' + i + '.mp3');
        if (!job.scenes[i].narration?.trim()) {
          saved.tracks[i] = { silent: true, duration: 0, tempo: 1 };
          await fs.writeFile(path.join(dir, 'narration.json'), JSON.stringify(saved));
          continue;
        }
        if (saved.tracks[i] && (await exists(file))) continue;
        await onProgress(i);
        const timeout = AbortSignal.timeout(45000),
          voiceSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let audio;
        try {
          audio = await synthesize(
            { ...voice, text: job.scenes[i].narration },
            { signal: voiceSignal },
          );
        } catch (e) {
          if (signal?.aborted) throw cancelled();
          throw new StoryError(
            503,
            'VIDEO_NARRATION_FAILED',
            '第 ' + (i + 1) + ' 镜头免费旁白暂时生成失败，已保留素材；继续任务只补做缺失配音',
          );
        }
        const temp = file + '.part.mp3';
        await fs.writeFile(temp, audio);
        const info = await inspect(temp, signal);
        if (!info.audio || !info.duration)
          throw new StoryError(
            502,
            'VIDEO_NARRATION_INVALID',
            '免费旁白返回了无效音频，请稍后继续',
          );
        // A small tempo correction is allowed; do not cut words or greatly speed up narration.
        const sceneDuration = job.scenes[i].duration || job.sceneDuration || 10,
          t = job.scenes[i].timing || Schema.timing(job.scenes[i]),
          available =
            job.audioMode === 'dialogue-narration'
              ? t.narrationEnd - t.narrationStart
              : sceneDuration - 0.8,
          tempo = Math.max(1, info.duration / available);
        if (tempo > 1.08 || available <= 0) {
          await fs.rm(temp, { force: true });
          throw new StoryError(
            400,
            'VIDEO_NARRATION_TOO_LONG',
            '第 ' +
              (i + 1) +
              ' 镜头旁白超过预留时段，请缩短文案或增加旁白秒数后保存新版本；尚未提交新的画面生成',
          );
        }
        await fs.rename(temp, file);
        saved.tracks[i] = { duration: info.duration, tempo };
        await fs.writeFile(path.join(dir, 'narration.json'), JSON.stringify(saved));
      }
      return saved;
    },
    async assemble(dir, job = { scenes: [{}, {}, {}], audioMode: 'native' }, { signal } = {}) {
      const count = job.scenes.length,
        duration = job.targetDuration || count * 10;
      await fs.writeFile(
        path.join(dir, 'parts.txt'),
        Array.from({ length: count }, (_, i) => "file 'scene-" + i + ".mp4'").join('\n'),
      );
      const final = path.join(dir, 'intro.tmp.mp4');
      if (job.audioMode === 'dialogue-narration') {
        const narration = JSON.parse(await fs.readFile(path.join(dir, 'narration.json'), 'utf8'));
        const inputs = ['-f', 'concat', '-safe', '1', '-i', path.join(dir, 'parts.txt')],
          cues = job.scenes.map((s) =>
            Object.hasOwn(musicTracks, s.musicCue) ? s.musicCue : 'manor',
          );
        for (let i = 0; i < count; i++)
          if (narration.tracks[i]?.silent)
            inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
          else inputs.push('-i', path.join(dir, 'narration-' + i + '.mp3'));
        for (const cue of cues)
          inputs.push('-stream_loop', '-1', '-i', path.join(__dirname, musicTracks[cue]));
        inputs.push(
          '-f',
          'lavfi',
          '-i',
          'anoisesrc=color=brown:amplitude=0.08:sample_rate=48000:seed=4173',
        );
        const filters = [],
          dialogueWindows = [],
          windWindows = [];
        let offset = 0;
        for (let i = 0; i < count; i++) {
          const scene = job.scenes[i],
            d = scene.duration || 10,
            t = scene.timing || Schema.timing(scene);
          filters.push(
            `[${i + 1}:a]atempo=${narration.tracks[i].tempo},aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(t.narrationStart * 1000)}|${Math.round(t.narrationStart * 1000)},apad,atrim=duration=${d},asetpts=PTS-STARTPTS[n${i}]`,
          );
          if (scene.dialogues?.length)
            dialogueWindows.push(`between(t,${offset + t.dialogueStart},${offset + d})`);
          windWindows.push(
            `${cues[i] === 'snow' ? 0.2 : cues[i] === 'manor' ? 0.08 : 0.015}*between(t,${offset},${offset + d})`,
          );
          filters.push(
            `[${count + 1 + i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${d + (i > 0 ? 0.4 : 0) + (i < count - 1 ? 0.4 : 0)},asetpts=PTS-STARTPTS,volume=0.14[m${i}]`,
          );
          offset += d;
        }
        filters.push(
          Array.from({ length: count }, (_, i) => `[n${i}]`).join('') +
            `concat=n=${count}:v=0:a=1[narr]`,
        );
        // Model audio is audible only in the explicitly reserved dialogue windows.
        // The prompt requests silence elsewhere; this gate also prevents overlap.
        filters.push(
          `[0:a]aresample=48000,aformat=channel_layouts=stereo,volume='0.88*min(1,${dialogueWindows.join('+') || '0'})':eval=frame[dialogue]`,
        );
        filters.push(
          '[dialogue][narr]amix=inputs=2:normalize=0,alimiter=limit=0.95,asplit=2[voice][side]',
        );
        let prior = 'm0';
        for (let i = 1; i < count; i++) {
          filters.push(`[${prior}][m${i}]acrossfade=d=0.8:c1=tri:c2=tri[mix${i}]`);
          prior = 'mix' + i;
        }
        filters.push(`[${prior}]atrim=duration=${duration}[music]`);
        filters.push(
          `[${count * 2 + 1}:a]lowpass=f=700,highpass=f=90,aformat=channel_layouts=stereo,atrim=duration=${duration},volume='${windWindows.join('+')}':eval=frame[ambience]`,
        );
        filters.push('[music][ambience]amix=inputs=2:normalize=0[bed]');
        filters.push(
          '[bed][side]sidechaincompress=threshold=0.025:ratio=5:attack=30:release=500[ducked]',
        );
        filters.push(
          '[voice][ducked]amix=inputs=2:normalize=0,alimiter=limit=0.92,afade=t=in:d=0.5,afade=t=out:st=' +
            Math.max(0, duration - 0.8) +
            ':d=0.8[a]',
        );
        await run(
          [
            '-hide_banner',
            '-y',
            ...inputs,
            '-filter_complex',
            filters.join(';'),
            '-map',
            '0:v:0',
            '-map',
            '[a]',
            '-vf',
            `fade=t=in:st=0:d=0.25,fade=t=out:st=${duration - 0.4}:d=0.4`,
            '-t',
            String(duration),
            '-c:v',
            'libx264',
            '-preset',
            'fast',
            '-crf',
            '21',
            '-pix_fmt',
            'yuv420p',
            '-r',
            '24',
            '-c:a',
            'aac',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-movflags',
            '+faststart',
            final,
          ],
          300000,
          signal,
        );
        const info = await inspect(final, signal);
        if (!info.audio || Math.abs(info.duration - duration) > 0.1)
          throw new StoryError(
            502,
            'VIDEO_FINAL_DURATION',
            '对白与旁白合成片时长不符合要求，已保留完成镜头，请继续合成',
          );
      } else if (job.audioMode !== 'unified') {
        await run(
          [
            '-hide_banner',
            '-y',
            '-f',
            'concat',
            '-safe',
            '1',
            '-i',
            path.join(dir, 'parts.txt'),
            '-map',
            '0:v:0',
            '-map',
            '0:a:0',
            '-c',
            'copy',
            '-movflags',
            '+faststart',
            final,
          ],
          180000,
          signal,
        );
      } else {
        const narration = JSON.parse(await fs.readFile(path.join(dir, 'narration.json'), 'utf8'));
        const inputs = ['-f', 'concat', '-safe', '1', '-i', path.join(dir, 'parts.txt')];
        for (let i = 0; i < count; i++)
          inputs.push('-i', path.join(dir, 'narration-' + i + '.mp3'));
        // Snapshot cues are public scene descriptions classified at task creation.
        const cues = job.scenes.map((s) =>
          Object.hasOwn(musicTracks, s.musicCue) ? s.musicCue : 'manor',
        );
        for (const cue of cues)
          inputs.push('-stream_loop', '-1', '-i', path.join(__dirname, musicTracks[cue]));
        inputs.push(
          '-f',
          'lavfi',
          '-i',
          'anoisesrc=color=brown:amplitude=0.08:sample_rate=48000:seed=4173',
        );
        const filters = [];
        for (let i = 0; i < count; i++)
          filters.push(
            `[${i + 1}:a]atempo=${narration.tracks[i].tempo},aresample=48000,aformat=channel_layouts=stereo,adelay=400|400,apad,atrim=duration=10,asetpts=PTS-STARTPTS[n${i}]`,
          );
        filters.push(
          Array.from({ length: count }, (_, i) => `[n${i}]`).join('') +
            `concat=n=${count}:v=0:a=1,asplit=2[voice][side]`,
        );
        for (let i = 0; i < count; i++)
          filters.push(
            `[${count + 1 + i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${duration / count + (i > 0 ? 0.4 : 0) + (i < count - 1 ? 0.4 : 0)},asetpts=PTS-STARTPTS,volume=0.16[m${i}]`,
          );
        let prior = 'm0';
        for (let i = 1; i < count; i++) {
          const next = 'mix' + i;
          filters.push(`[${prior}][m${i}]acrossfade=d=0.8:c1=tri:c2=tri[${next}]`);
          prior = next;
        }
        filters.push(`[${prior}]atrim=duration=${duration}[music]`);
        const wind = cues
          .map(
            (cue, i) =>
              `${cue === 'snow' ? 0.2 : cue === 'manor' ? 0.08 : 0.015}*between(t,${(i * duration) / count},${((i + 1) * duration) / count})`,
          )
          .join('+');
        filters.push(
          `[${count * 2 + 1}:a]lowpass=f=700,highpass=f=90,aformat=channel_layouts=stereo,atrim=duration=${duration},volume='${wind}':eval=frame[wind]`,
        );
        filters.push('[music][wind]amix=inputs=2:normalize=0[bed]');
        filters.push(
          '[bed][side]sidechaincompress=threshold=0.025:ratio=6:attack=30:release=500[ducked]',
        );
        filters.push(
          `[voice][ducked]amix=inputs=2:normalize=0,alimiter=limit=0.92,afade=t=in:d=0.3,afade=t=out:st=${duration - 0.8}:d=0.8[a]`,
        );
        await run(
          [
            '-hide_banner',
            '-y',
            ...inputs,
            '-filter_complex',
            filters.join(';'),
            '-map',
            '0:v:0',
            '-map',
            '[a]',
            '-vf',
            `fade=t=in:st=0:d=0.25,fade=t=out:st=${duration - 0.4}:d=0.4`,
            '-t',
            String(duration),
            '-c:v',
            'libx264',
            '-preset',
            'fast',
            '-crf',
            '21',
            '-pix_fmt',
            'yuv420p',
            '-r',
            '24',
            '-c:a',
            'aac',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-movflags',
            '+faststart',
            final,
          ],
          300000,
          signal,
        );
        const info = await inspect(final, signal);
        if (!info.audio || Math.abs(info.duration - duration) > 0.1)
          throw new StoryError(
            502,
            'VIDEO_FINAL_DURATION',
            '合成片时长或音轨不符合要求，已有镜头已保存，请继续合成',
          );
      }
      if (job.introStory?.introductions?.enabled) {
        const labeled = path.join(dir, 'intro.titled.mp4');
        await require('./title-media.cjs').renderTitles(final, labeled, job.introStory, {
          signal,
          run,
          inspect,
        });
        await fs.rename(labeled, path.join(dir, 'intro.mp4'));
        await fs.rm(final, { force: true });
      } else await fs.rename(final, path.join(dir, 'intro.mp4'));
    },
  };
}
const mediaTools = createMediaTools();
module.exports = { mediaTools, createMediaTools, ffmpegPath, inspect, run };
