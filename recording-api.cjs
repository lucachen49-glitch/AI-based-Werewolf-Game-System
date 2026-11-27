'use strict';
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { run } = require('./video-media.cjs');

const rootDir = path.join(__dirname, 'output', 'recordings');
const idPattern = /^[a-f0-9-]{36}$/;
const chunkLimit = 24 * 1024 * 1024;
const GiB = 1024 * 1024 * 1024;
const gb = (bytes) => String(Math.round((bytes / GiB) * 10) / 10);
// Free space of the volume holding dir; null when the platform or Node version cannot tell.
async function diskFreeBytes(dir) {
  if (typeof fs.statfs !== 'function') return null;
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
class RecordingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
async function convert(source, target, job = {}) {
  await run(
    [
      '-hide_banner',
      '-y',
      '-i',
      source,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      job.capture?.version === 'portrait-1080-v2'
        ? 'scale=1080:1920,setsar=1'
        : 'scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x191310,setsar=1',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      target,
    ],
    2 * 60 * 60 * 1000,
  );
}
function createRecordingAPI({
  sendJSON,
  readJSON,
  root = rootDir,
  transcode = convert,
  leaseMs = 45000,
  maxTotalBytes = 4 * GiB,
  minFreeBytes = 2 * GiB,
  freeBytes = diskFreeBytes,
}) {
  const jobs = new Map(),
    processing = new Map();
  let loaded,
    interval,
    queue = Promise.resolve();
  const dir = (job) => path.join(root, job.id);
  const raw = (job) => path.join(dir(job), job.filename + '.webm');
  const output = (job) => path.join(root, job.filename + '.mp4');
  const transcriptFile = (job) => path.join(dir(job), 'transcript.json');
  const files = async (folder) =>
    fs.readdir(folder).catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
  const chunks = async (job) =>
    (await files(dir(job))).filter((n) => /^\d{9}\.chunk$/.test(n)).sort();
  async function save(job, patch = {}) {
    const { liveUntil, pending, transcriptEntries, bytes, ...data } = { ...job, ...patch };
    const file = path.join(dir(job), 'recording.json');
    await fs.writeFile(file + '.tmp', JSON.stringify(data));
    await fs.rename(file + '.tmp', file);
    Object.assign(job, patch);
  }
  function publicJob(job) {
    const media = '/api/recordings/' + job.id + '/media',
      transcript = '/api/recordings/' + job.id + '/transcript';
    const count = Number.isFinite(job.transcriptCount)
      ? job.transcriptCount
      : Array.isArray(job.transcriptEntries)
        ? job.transcriptEntries.length
        : 0;
    return {
      id: job.id,
      createdAt: job.createdAt,
      roomSize: job.roomSize,
      story: job.story,
      status: job.status,
      capture: job.capture || null,
      complete: job.complete,
      filename: job.filename + '.mp4',
      chunks: job.chunks,
      transcriptCount: count,
      transcriptUrl: transcript + '/json',
      transcriptTxtUrl: transcript + '/txt',
      transcriptSrtUrl: transcript + '/srt',
      transcriptVttUrl: transcript + '/vtt',
      reason: job.reason || '',
      url: job.status === 'ready' ? media + '/mp4' : null,
      rawUrl: job.status === 'failed' && job.hasRaw ? media + '/webm' : null,
    };
  }
  function normalizeTranscriptEntry(entry) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.text !== 'string'
    )
      return null;
    const startedMs = Math.max(0, Math.round(Number(entry.startedMs) || 0));
    const endedMs = Math.max(startedMs, Math.round(Number(entry.endedMs) || startedMs));
    const text = Array.from(entry.text).slice(0, 1400).join('');
    if (!text) return null;
    const allowedKind = entry.kind === 'commentary' ? 'commentary' : 'dialogue';
    return {
      id: entry.id.slice(0, 100),
      kind: allowedKind,
      seat: Number.isInteger(entry.seat) && entry.seat >= 0 && entry.seat < 12 ? entry.seat : null,
      name: typeof entry.name === 'string' ? entry.name.slice(0, 120) : '',
      round: Number.isInteger(entry.round) && entry.round >= 0 ? entry.round : null,
      phase: typeof entry.phase === 'string' ? entry.phase.slice(0, 80) : '',
      text,
      startedMs,
      endedMs,
      durationMs: endedMs - startedMs,
      voiceProvider:
        typeof entry.voiceProvider === 'string' ? entry.voiceProvider.slice(0, 40) : '',
      voice: typeof entry.voice === 'string' ? entry.voice.slice(0, 120) : '',
      voiceModel: typeof entry.voiceModel === 'string' ? entry.voiceModel.slice(0, 120) : '',
      speechStatus: typeof entry.speechStatus === 'string' ? entry.speechStatus.slice(0, 40) : '',
      attempts: Number.isInteger(entry.attempts) && entry.attempts > 0 ? entry.attempts : 1,
      pausedMs: Math.max(0, Math.round(Number(entry.pausedMs) || 0)),
    };
  }
  async function readTranscript(job) {
    if (Array.isArray(job.transcriptEntries)) return job.transcriptEntries;
    try {
      const value = JSON.parse(await fs.readFile(transcriptFile(job), 'utf8'));
      job.transcriptEntries = Array.isArray(value.entries)
        ? value.entries.map(normalizeTranscriptEntry).filter(Boolean)
        : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      job.transcriptEntries = [];
    }
    job.transcriptCount = job.transcriptEntries.length;
    return job.transcriptEntries;
  }
  async function writeTranscript(job, entries) {
    const normalized = entries
      .map(normalizeTranscriptEntry)
      .filter(Boolean)
      .sort((a, b) => a.startedMs - b.startedMs || a.id.localeCompare(b.id));
    await fs.writeFile(
      transcriptFile(job) + '.tmp',
      JSON.stringify({ version: 1, recordingId: job.id, entries: normalized }),
    );
    await fs.rename(transcriptFile(job) + '.tmp', transcriptFile(job));
    job.transcriptEntries = normalized;
    job.transcriptCount = normalized.length;
  }
  function formatTimestamp(ms, separator = ',') {
    const value = Math.max(0, Math.round(ms));
    const h = Math.floor(value / 3600000),
      m = Math.floor((value % 3600000) / 60000),
      s = Math.floor((value % 60000) / 1000),
      f = value % 1000;
    return (
      String(h).padStart(2, '0') +
      ':' +
      String(m).padStart(2, '0') +
      ':' +
      String(s).padStart(2, '0') +
      separator +
      String(f).padStart(3, '0')
    );
  }
  function transcriptText(entries) {
    return (
      entries
        .map((entry) => {
          const who =
            entry.kind === 'commentary'
              ? '旁白'
              : (entry.seat == null ? '' : String(entry.seat + 1) + '号 · ') +
                (entry.name || '玩家');
          return (
            '[' +
            formatTimestamp(entry.startedMs, '.') +
            ' - ' +
            formatTimestamp(entry.endedMs, '.') +
            '] ' +
            who +
            '\n' +
            entry.text
          );
        })
        .join('\n\n') + '\n'
    );
  }
  function transcriptSrt(entries) {
    return entries
      .map(
        (entry, index) =>
          String(index + 1) +
          '\n' +
          formatTimestamp(entry.startedMs) +
          ' --> ' +
          formatTimestamp(Math.max(entry.startedMs + 1, entry.endedMs)) +
          '\n' +
          (entry.kind === 'commentary'
            ? '旁白'
            : (entry.seat == null ? '' : String(entry.seat + 1) + '号 · ') +
              (entry.name || '玩家')) +
          '：' +
          entry.text +
          '\n',
      )
      .join('\n');
  }
  function transcriptVtt(entries) {
    return (
      'WEBVTT\n\n' +
      entries
        .map(
          (entry) =>
            formatTimestamp(entry.startedMs, '.') +
            ' --> ' +
            formatTimestamp(Math.max(entry.startedMs + 1, entry.endedMs), '.') +
            '\n' +
            (entry.kind === 'commentary'
              ? '旁白'
              : (entry.seat == null ? '' : String(entry.seat + 1) + '号 · ') +
                (entry.name || '玩家')) +
            '：' +
            entry.text +
            '\n',
        )
        .join('\n')
    );
  }
  function transcriptResponse(res, job, format) {
    const entries = job.transcriptEntries || [];
    let body, type;
    if (format === 'txt') {
      body = transcriptText(entries);
      type = 'text/plain; charset=utf-8';
    } else if (format === 'srt') {
      body = transcriptSrt(entries);
      type = 'application/x-subrip; charset=utf-8';
    } else if (format === 'vtt') {
      body = transcriptVtt(entries);
      type = 'text/vtt; charset=utf-8';
    } else {
      body = JSON.stringify({ version: 1, recordingId: job.id, entries }, null, 2);
      type = 'application/json; charset=utf-8';
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      'Content-Disposition':
        'attachment; filename="' + job.filename + '.transcript.' + format + '"',
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }
  async function* readParts(job, parts) {
    for (const name of parts) yield* createReadStream(path.join(dir(job), name));
  }
  function assemble(job) {
    if (processing.has(job.id)) return;
    // Serializing encodes keeps simultaneous saves from taking resources away from play.
    const task = queue.then(async () => {
      const source = raw(job),
        target = output(job),
        temp = target + '.part.mp4';
      try {
        const parts = await chunks(job);
        if (
          !(await fs.stat(source).then(
            (s) => s.size > 0,
            () => false,
          ))
        ) {
          if (!parts.length) {
            await save(job, { status: 'empty', reason: '未收到可保存的录制片段。' });
            return;
          }
          await pipeline(Readable.from(readParts(job, parts)), createWriteStream(source + '.part'));
          await fs.rename(source + '.part', source);
        }
        await transcode(source, temp, job);
        await fs.rename(temp, target);
        await save(job, { status: 'ready', hasRaw: true });
        await fs.rm(source, { force: true }).catch(() => {});
        for (const part of parts)
          await fs.rm(path.join(dir(job), part), { force: true }).catch(() => {});
      } catch {
        await fs.rm(temp, { force: true }).catch(() => {});
        const hasRaw = await fs.stat(source).then(
          (s) => s.size > 0,
          () => false,
        );
        const reason =
          job.reason ||
          (hasRaw ? 'MP4 合成失败，已保留原始 WebM。' : '暂时无法合并，已保留收到的录制片段。');
        await save(job, { status: 'failed', hasRaw, reason }).catch(() => {});
      }
    });
    processing.set(job.id, task);
    queue = task.catch(() => {}).finally(() => processing.delete(job.id));
  }
  const storageFull = (message) => new RecordingError(507, message);
  async function recordedBytes(job) {
    if (Number.isFinite(job.bytes)) return job.bytes;
    let total = 0;
    for (const name of await chunks(job)) {
      try {
        total += (await fs.stat(path.join(dir(job), name))).size;
      } catch {}
    }
    return (job.bytes = total);
  }
  async function finish(job, complete, expected, reason) {
    if (job.status !== 'recording') return;
    const count = (await chunks(job)).length;
    await save(job, {
      status: 'saving',
      chunks: count,
      complete: complete && count === expected,
      reason: complete && count === expected ? '' : reason || '录制中断，保存已收到的片段。',
    });
    assemble(job);
  }
  function exclusive(job, action) {
    const pending = (job.pending || Promise.resolve()).then(action);
    job.pending = pending.catch(() => {});
    return pending;
  }
  async function recover() {
    for (const name of await files(root)) {
      if (!idPattern.test(name)) continue;
      try {
        const job = JSON.parse(await fs.readFile(path.join(root, name, 'recording.json'), 'utf8'));
        if (
          job.id !== name ||
          !/^nightfall-\d{4}-\d{2}-\d{2}T[\d-]+-(6|12)-[a-f0-9-]{36}$/.test(job.filename)
        )
          continue;
        jobs.set(job.id, job);
        await readTranscript(job);
        if (job.status === 'recording') await finish(job, false);
        else if (job.status === 'saving') assemble(job);
      } catch {
        /* Other local files do not prevent recovery. */
      }
    }
  }
  function sweep() {
    for (const job of jobs.values())
      if (job.status === 'recording' && Date.now() >= job.liveUntil) {
        void exclusive(job, () =>
          Date.now() >= job.liveUntil ? finish(job, false) : undefined,
        ).catch(() => {});
      }
  }
  async function putChunk(req, job, index) {
    if (job.status !== 'recording') throw new RecordingError(409, '这局录制已经结束。');
    job.liveUntil = Date.now() + leaseMs;
    if (index > job.chunks) throw new RecordingError(409, '录制片段顺序不一致。');
    if (index < job.chunks) {
      req.resume();
      return;
    }
    if (Number(req.headers['content-length']) > chunkLimit)
      throw new RecordingError(413, '录制片段过大。');
    const used = await recordedBytes(job),
      declared = Number(req.headers['content-length']) || 0;
    const totalMessage =
      '本局录像已达到 ' + gb(maxTotalBytes) + ' GB 上限，已停止录制并保存已录片段。';
    const diskMessage = '磁盘剩余空间不足 ' + gb(minFreeBytes) + ' GB，已停止录制并保存已录片段。';
    if (used + declared > maxTotalBytes) {
      req.resume();
      await finish(job, false, undefined, totalMessage);
      throw storageFull(totalMessage);
    }
    const free = await freeBytes(root);
    if (free !== null && free - declared < minFreeBytes) {
      req.resume();
      await finish(job, false, undefined, diskMessage);
      throw storageFull(diskMessage);
    }
    const file = path.join(dir(job), String(index).padStart(9, '0') + '.chunk');
    let length = 0;
    try {
      // A complete chunk is renamed into place only after its bytes reach disk.
      await pipeline(
        Readable.from(
          (async function* () {
            for await (const buffer of req) {
              length += buffer.length;
              if (length > chunkLimit) throw new RecordingError(413, '录制片段过大。');
              if (used + length > maxTotalBytes) throw storageFull(totalMessage);
              const available = await freeBytes(root);
              if (available !== null && available - buffer.length < minFreeBytes)
                throw storageFull(diskMessage);
              yield buffer;
            }
          })(),
        ),
        createWriteStream(file + '.part'),
      );
      if (!length) throw new RecordingError(400, '录制片段为空。');
      await fs.rename(file + '.part', file);
      job.chunks++;
      job.bytes = used + length;
    } catch (error) {
      if (error?.status === 507 && job.status === 'recording')
        await finish(job, false, undefined, error.message);
      throw error;
    } finally {
      job.liveUntil = Date.now() + leaseMs;
      await fs.rm(file + '.part', { force: true }).catch(() => {});
    }
  }
  async function sendMedia(req, res, job, extension, download) {
    if (
      (extension === 'mp4' && job.status !== 'ready') ||
      (extension === 'webm' && (job.status !== 'failed' || !job.hasRaw))
    )
      throw new RecordingError(404, '此录像文件暂不可用。');
    const file = extension === 'mp4' ? output(job) : raw(job);
    const { size } = await fs.stat(file);
    let from = 0,
      to = size - 1,
      status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match && (match[1] || match[2])) {
        from = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        if (match[1] && match[2]) to = Math.min(to, Number(match[2]));
      } else from = size;
      if (from >= size || from > to) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + size });
        return res.end();
      }
      status = 206;
      res.setHeader('Content-Range', `bytes ${from}-${to}/${size}`);
    }
    res.writeHead(status, {
      'Content-Type': 'video/' + extension,
      'Content-Length': to - from + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${job.filename}.${extension}"`,
    });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file, { start: from, end: to });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
  async function handle(req, res, name) {
    try {
      const sameOrigin = 'http://' + req.headers.host;
      const reading = req.method === 'GET' || req.method === 'HEAD';
      if (
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== sameOrigin) ||
        (!reading && req.headers.origin !== sameOrigin)
      )
        throw new RecordingError(403, '请从游戏本机地址打开录制功能。');
      res.setHeader('Cache-Control', 'no-store');
      loaded ??= recover();
      await loaded;
      if (!interval) {
        interval = setInterval(sweep, 3000);
        interval.unref();
      }
      if (name === 'api/recordings') {
        if (req.method === 'GET')
          return sendJSON(res, 200, {
            recordings: [...jobs.values()]
              .filter((j) => j.chunks || j.status === 'saving')
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map(publicJob),
          });
        if (req.method === 'POST') {
          const { roomSize, story, capture } = await readJSON(req, 4096);
          if (
            capture &&
            (capture.version !== 'portrait-1080-v2' ||
              capture.width !== 1080 ||
              capture.height !== 1920 ||
              !['region', 'element'].includes(capture.mode) ||
              ![capture.sourceWidth, capture.sourceHeight].every(
                (n) => Number.isFinite(n) && n > 0 && n <= 16384,
              ) ||
              !capture.region ||
              capture.region.width <= 0 ||
              capture.region.height <= 0 ||
              capture.region.x + capture.region.width > capture.sourceWidth + 1 ||
              capture.region.y + capture.region.height > capture.sourceHeight + 1 ||
              ![
                capture.region.x,
                capture.region.y,
                capture.region.width,
                capture.region.height,
              ].every((n) => Number.isFinite(n) && n >= 0 && n <= 16384))
          )
            throw new RecordingError(400, '录屏画面尺寸无效，请重新开始。');
          if (roomSize !== 6 && roomSize !== 12)
            throw new RecordingError(400, '录制房间人数无效。');
          await fs.mkdir(root, { recursive: true });
          const free = await freeBytes(root);
          if (free !== null && free < minFreeBytes)
            throw storageFull(
              '磁盘剩余空间不足 ' + gb(minFreeBytes) + ' GB，暂不能开始录制，请清理磁盘后重试。',
            );
          const id = randomUUID(),
            createdAt = new Date().toISOString();
          const job = {
            id,
            createdAt,
            roomSize,
            ...(capture
              ? {
                  capture: {
                    version: capture.version,
                    width: 1080,
                    height: 1920,
                    mode: capture.mode,
                    sourceWidth: capture.sourceWidth,
                    sourceHeight: capture.sourceHeight,
                    region: capture.region,
                  },
                }
              : {}),
            story: story === true,
            complete: false,
            chunks: 0,
            status: 'recording',
            liveUntil: Date.now() + leaseMs,
            filename:
              'nightfall-' +
              createdAt.replace(/[:.]/g, '-').replace('Z', '') +
              '-' +
              roomSize +
              '-' +
              id,
          };
          await fs.mkdir(dir(job), { recursive: true });
          await save(job);
          jobs.set(id, job);
          return sendJSON(res, 201, publicJob(job));
        }
      }
      const match = /^api\/recordings\/([a-f0-9-]{36})(?:\/(.*))?$/.exec(name);
      const job = match && jobs.get(match[1]),
        action = match?.[2] || '';
      if (!job) throw new RecordingError(404, '找不到这局录制。');
      if (!action && req.method === 'GET') {
        await readTranscript(job);
        return sendJSON(res, 200, publicJob(job));
      }
      if (reading && /^media\/(mp4|webm)$/.test(action))
        return await sendMedia(
          req,
          res,
          job,
          action.slice(6),
          new URL(req.url, sameOrigin).searchParams.has('download'),
        );
      if (reading && /^transcript\/(json|txt|srt|vtt)$/.test(action)) {
        await readTranscript(job);
        return transcriptResponse(res, job, action.slice(11));
      }
      if (req.method === 'GET' && action === 'transcript') {
        await readTranscript(job);
        return sendJSON(res, 200, {
          version: 1,
          recordingId: job.id,
          entries: job.transcriptEntries,
        });
      }
      if (req.method === 'PUT' && action === 'transcript') {
        const body = await readJSON(req, 2 * 1024 * 1024),
          incoming = Array.isArray(body?.entries) ? body.entries : [];
        const current = await readTranscript(job),
          merged = new Map(current.map((entry) => [entry.id, entry]));
        for (const entry of incoming) {
          const normalized = normalizeTranscriptEntry(entry);
          if (normalized) merged.set(normalized.id, normalized);
        }
        await writeTranscript(job, [...merged.values()]);
        return sendJSON(res, 200, { recordingId: job.id, transcriptCount: job.transcriptCount });
      }
      if (req.method === 'PUT' && /^chunks\/\d{1,7}$/.test(action)) {
        await exclusive(job, () => putChunk(req, job, Number(action.slice(7))));
        return sendJSON(res, 200, { chunks: job.chunks });
      }
      if (req.method === 'POST' && action === 'heartbeat') {
        if (job.status === 'recording') job.liveUntil = Date.now() + leaseMs;
        return sendJSON(res, 200, publicJob(job));
      }
      if (req.method === 'POST' && action === 'finish') {
        const { complete, expected } = await readJSON(req, 2048);
        await exclusive(job, () => finish(job, complete === true, expected));
        return sendJSON(res, 200, publicJob(job));
      }
      if (req.method === 'POST' && action === 'retry') {
        await exclusive(job, async () => {
          if (job.status === 'failed') {
            await save(job, { status: 'saving' });
            assemble(job);
          }
        });
        return sendJSON(res, 200, publicJob(job));
      }
      throw new RecordingError(405, '该录制操作不可用。');
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        sendJSON(res, error.status || 500, {
          error: { message: error.status ? error.message : '无法写入或读取本地录制目录。' },
        });
    }
  }
  return {
    handle,
    close() {
      clearInterval(interval);
      interval = null;
    },
  };
}
module.exports = { createRecordingAPI };
