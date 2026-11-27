'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { run, inspect } = require('./video-media.cjs'),
  { speechAudio } = require('./voice.cjs'),
  S = require('./scenario.js'),
  { StoryError } = require('./scenario-store.cjs'),
  { musicTracks } = require('./soundfx.js');
const stamp = (s) => {
  const ticks = Math.max(0, Math.round(s * 100)),
    h = Math.floor(ticks / 360000),
    m = Math.floor(ticks / 6000) % 60,
    sec = Math.floor(ticks / 100) % 60,
    cs = ticks % 100;
  return (
    h +
    ':' +
    String(m).padStart(2, '0') +
    ':' +
    String(sec).padStart(2, '0') +
    '.' +
    String(cs).padStart(2, '0')
  );
};
const safe = (s) => s.replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\r?\n/g, ' ');
function ass(cues) {
  return (
    '[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Microsoft YaHei,32,&H00EAF3FF,&H00FFFFFF,&H00120D08,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,65,65,42,1\nStyle: Label,Microsoft YaHei,21,&H00BAD9EE,&H00FFFFFF,&H00120D08,&H80000000,0,0,0,0,100,100,0,0,1,2,1,8,40,40,20,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n' +
    cues
      .map(
        (c) =>
          'Dialogue: 0,' +
          stamp(c.start) +
          ',' +
          stamp(c.end) +
          ',' +
          (c.label ? 'Label' : 'Default') +
          ',,0,0,0,,' +
          safe(c.text),
      )
      .join('\n') +
    '\n'
  );
}
const filterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
function createPreviewMedia({ synthesize = speechAudio } = {}) {
  return {
    async scene(dir, j, index, { signal, onProgress }) {
      const scene = j.story.scenes[index],
        duration = scene.duration,
        t = S.timing(scene),
        cues = [],
        tracks = [];
      let count = 0;
      const voice = async (text, seat, start, limit) => {
        if (!text) return start;
        const voiceId = seat ? S.previewVoice(j.story.characters[seat - 1]) : 'zh-CN-YunyangNeural',
          stamp = require('node:crypto')
            .createHash('sha256')
            .update(JSON.stringify([voiceId, text]))
            .digest('hex')
            .slice(0, 16);
        const name = 'voice-' + index + '-' + count++ + '-' + stamp + '.mp3',
          file = path.join(dir, name);
        let info;
        try {
          info = await inspect(file, signal);
        } catch {}
        if (!info?.audio) {
          await onProgress(
            'voicing',
            '镜头 ' + (index + 1) + '：' + (seat ? seat + '号人物临时对白' : '免费旁白'),
          );
          const timeout = AbortSignal.timeout(60000);
          let bytes;
          try {
            bytes = await synthesize(
              { provider: 'neural', voice: voiceId, style: 'firm', speed: 1, text },
              { signal: AbortSignal.any([signal, timeout]) },
            );
          } catch (e) {
            if (timeout.aborted && !signal.aborted)
              throw new StoryError(
                504,
                'SPEECH_TIMEOUT',
                '镜头 ' +
                  (index + 1) +
                  ' 的免费配音等待超时，已保留完成素材，请点击“继续本地处理”重试',
              );
            throw e;
          }
          const temp = file + '.part.mp3';
          await fs.writeFile(temp, bytes);
          info = await inspect(temp, signal);
          if (!info.audio)
            throw new StoryError(
              502,
              'PREVIEW_VOICE_INVALID',
              '免费语音返回无效音频，已保留其他素材',
            );
          await fs.rename(temp, file);
        }
        const available = limit - start,
          tempo = Math.max(1, info.duration / available);
        if (available <= 0 || tempo > 1.08)
          throw new StoryError(
            400,
            'PREVIEW_DIALOGUE_TOO_LONG',
            '镜头 ' +
              (index + 1) +
              ' 的' +
              (seat ? seat + '号对白' : '旁白') +
              '实际配音超过时段，请缩短台词后保存新版本；不会截断语音',
          );
        const end = start + info.duration / tempo;
        tracks.push({ file, start, tempo });
        const nameLabel = seat ? j.story.characters[seat - 1].name : '旁白';
        const chunks = text.match(/[^，。！？；]+[，。！？；]?/g) || [text];
        let at = start;
        for (const chunk of chunks) {
          const next = at + ((end - start) * chunk.length) / text.length;
          cues.push({ start: at, end: next, text: nameLabel + '：' + chunk });
          at = next;
        }
        return end;
      };
      if (scene.narration) await voice(scene.narration, 0, t.narrationStart, t.narrationEnd);
      let cursor = t.dialogueStart + 0.2;
      const lines = scene.dialogues || [];
      for (let n = 0; n < lines.length; n++) {
        const line = lines[n],
          remaining = lines
            .slice(n + 1)
            .reduce((sum, d) => sum + d.text.replace(/[\s，。！？；]/g, '').length / 4.5 + 0.25, 0);
        cursor = await voice(line.text, line.seat, cursor, duration - 0.25 - remaining);
        cursor += 0.3;
      }
      const selection = j.sources[index],
        isVideo = selection?.mime === 'video/mp4',
        end = selection?.end ?? (isVideo ? selection.duration : 0),
        available = isVideo ? Math.min(duration, end - selection.start) : 0;
      if (
        isVideo &&
        (selection.start < 0 || available < duration - 0.05 || end > selection.duration + 0.05)
      )
        throw new StoryError(
          400,
          'PREVIEW_SOURCE_TOO_SHORT',
          '镜头 ' +
            (index + 1) +
            ' 所选视频区间不足 ' +
            duration +
            ' 秒，请选择静态分镜或更长片段；不会冻结或慢放补时',
        );
      cues.push({
        start: 0,
        end: duration,
        label: true,
        text:
          '叙事预演 · 镜头 ' +
          (index + 1) +
          ' / ' +
          j.story.scenes.length +
          ' · ' +
          (isVideo
            ? '旧视频画面 / 临时重配对白'
            : selection
              ? '静态分镜 / 临时对白，非正式口型'
              : '缺少素材 / 静态场景示意'),
      });
      const subtitle = path.join(dir, 'subtitle-' + index + '.ass');
      await fs.writeFile(subtitle, ass(cues), 'utf8');
      await onProgress('visual', '镜头 ' + (index + 1) + '：画面、字幕与临时对白处理');
      const input = selection?.file || path.join(__dirname, 'assets/manor/manor-room.webp'),
        args = [
          '-v',
          'error',
          '-y',
          ...(isVideo
            ? ['-ss', String(selection.start), '-i', input]
            : ['-loop', '1', '-framerate', '24', '-i', input]),
          '-f',
          'lavfi',
          '-i',
          'anullsrc=r=48000:cl=stereo',
          ...tracks.flatMap((x) => ['-i', x.file]),
        ];
      const filters = tracks.map(
        (x, i) =>
          `[${i + 2}:a]atempo=${x.tempo},adelay=${Math.round(x.start * 1000)}|${Math.round(x.start * 1000)}[a${i}]`,
      );
      filters.push(
        '[1:a]' +
          tracks.map((_, i) => '[a' + i + ']').join('') +
          `amix=inputs=${tracks.length + 1}:normalize=0,alimiter=limit=0.92[a]`,
      );
      const temp = path.join(dir, 'scene-' + index + '.part.mp4'),
        output = path.join(dir, 'scene-' + index + '.mp4');
      await run(
        [
          ...args,
          '-filter_complex',
          filters.join(';'),
          '-map',
          '0:v:0',
          '-map',
          '[a]',
          '-vf',
          `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x20140e,setsar=1,subtitles=filename='${filterPath(subtitle)}'`,
          '-t',
          String(duration),
          '-r',
          '24',
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-movflags',
          '+faststart',
          temp,
        ],
        180000,
        signal,
      );
      await fs.rename(temp, output);
      return {
        cues,
        visual: isVideo ? 'video' : selection ? 'storyboard' : 'missing',
        voiceTracks: tracks.length,
      };
    },
    async assemble(dir, j, { signal }) {
      await fs.writeFile(
        path.join(dir, 'concat.txt'),
        j.scenes.map((s, i) => "file 'scene-" + i + ".mp4'").join('\n'),
      );
      const raw = path.join(dir, 'joined.mp4');
      await run(
        [
          '-v',
          'error',
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          path.join(dir, 'concat.txt'),
          '-c',
          'copy',
          raw,
        ],
        60000,
        signal,
      );
      const output = path.join(dir, 'preview.part.mp4');
      await run(
        [
          '-v',
          'error',
          '-y',
          '-i',
          raw,
          '-stream_loop',
          '-1',
          '-i',
          path.join(__dirname, musicTracks.candle || Object.values(musicTracks)[0]),
          '-filter_complex',
          `[1:a]volume=0.075,afade=t=in:d=1,afade=t=out:st=${j.duration - 2}:d=2[m];[0:a]asplit=2[v][side];[m][side]sidechaincompress=threshold=0.025:ratio=5:attack=30:release=400[bed];[v][bed]amix=inputs=2:normalize=0,alimiter=limit=0.92[a]`,
          '-map',
          '0:v',
          '-map',
          '[a]',
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-t',
          String(j.duration),
          '-movflags',
          '+faststart',
          output,
        ],
        120000,
        signal,
      );
      const info = await inspect(output, signal);
      if (!info.audio || !info.video || Math.abs(info.duration - j.duration) > 0.1)
        throw new StoryError(502, 'PREVIEW_DURATION', '预演片长或音轨检查失败，已保留各镜头');
      if (j.story.introductions?.enabled) {
        const labeled = path.join(dir, 'preview.titled.mp4');
        await require('./title-media.cjs').renderTitles(output, labeled, j.story, {
          signal,
          run,
          inspect,
        });
        await fs.rename(labeled, path.join(dir, 'preview.mp4'));
      } else await fs.rename(output, path.join(dir, 'preview.mp4'));
    },
  };
}
module.exports = { createPreviewMedia, ass };
