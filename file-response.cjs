'use strict';
const fs = require('node:fs/promises');
function byteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const first = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const last = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    (!match[1] && (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0)) ||
    first < 0 ||
    first > last ||
    first >= size
  )
    return null;
  return { start: first, end: last };
}
async function sendFile(
  req,
  res,
  file,
  { type = 'application/octet-stream', cache = 'no-store', etag = false } = {},
) {
  const handle = await fs.open(file, 'r');
  let streaming = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(Error('File not found'), { code: 'ENOENT' });
    const tag = 'W/"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
    const headers = {
      'Content-Type': type,
      'Cache-Control': cache,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      ...(etag ? { ETag: tag, 'Last-Modified': stat.mtime.toUTCString() } : {}),
    };
    const matches = (req.headers['if-none-match'] || '').split(',').map((part) => part.trim());
    if (
      etag &&
      (matches.includes('*') || matches.some((part) => part.replace(/^W\//, '') === tag.slice(2)))
    ) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const ifRange = req.headers['if-range'];
    const useRange =
      req.headers.range &&
      (!ifRange ||
        (etag &&
          Number.isFinite(Date.parse(ifRange)) &&
          Math.floor(stat.mtimeMs / 1000) <= Date.parse(ifRange) / 1000));
    const range = useRange ? byteRange(req.headers.range, stat.size) : null;
    if (useRange && !range) {
      res.writeHead(416, {
        ...headers,
        'Content-Range': 'bytes */' + stat.size,
        'Content-Length': 0,
      });
      res.end();
      return;
    }
    const length = range ? range.end - range.start + 1 : stat.size;
    res.writeHead(range ? 206 : 200, {
      ...headers,
      'Content-Length': length,
      ...(range
        ? { 'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + stat.size }
        : {}),
    });
    if (req.method === 'HEAD' || !length || res.destroyed) {
      res.end();
      return;
    }
    const stream = handle.createReadStream(range || {});
    streaming = true;
    const cancel = () => stream.destroy();
    res.once('close', cancel);
    stream.once('close', () => res.off('close', cancel));
    stream.once('error', () => res.destroy());
    stream.pipe(res);
  } finally {
    if (!streaming) await handle.close();
  }
}
module.exports = { sendFile, byteRange };
