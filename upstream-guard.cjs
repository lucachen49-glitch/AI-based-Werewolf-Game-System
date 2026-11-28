'use strict';
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { Readable, pipeline } = require('node:stream');
const { createGunzip, createInflate, createBrotliDecompress } = require('node:zlib');
const allowLocal = () => process.env.NIGHTFALL_ALLOW_LOCAL_UPSTREAM === '1';
function privateAddress(address) {
  address = address.replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    const canonical = new URL('http://[' + address + ']').hostname.slice(1, -1);
    if (canonical.startsWith('::ffff:')) {
      const words = canonical.slice(7).split(':');
      const v = (parseInt(words[0], 16) * 65536 + parseInt(words[1], 16)) >>> 0;
      return privateAddress([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.'));
    }
    if (canonical.startsWith('2002:')) {
      const parts = canonical.split(':');
      const v = parseInt(parts[1], 16) * 65536 + parseInt(parts[2], 16);
      return privateAddress([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.'));
    }
    return !/^[23]/.test(canonical) || /^2001:(?::|0:|db8:)/.test(canonical);
  }
  return true;
}
function blocked() {
  return Object.assign(
    Error('上游地址解析到本机或私有网络，请检查地址或启用 NIGHTFALL_ALLOW_LOCAL_UPSTREAM=1。'),
    { status: 400, code: 'UPSTREAM_PRIVATE_ADDRESS' },
  );
}
function connectionOptions(url, { allowLoopback = allowLocal(), lookup = dns.lookup } = {}) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) && !allowLoopback && privateAddress(hostname)) throw blocked();
  return {
    lookup(host, options, callback) {
      lookup(host, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error);
        if (
          !addresses.length ||
          (!allowLoopback && addresses.some((item) => privateAddress(item.address)))
        )
          return callback(blocked());
        // These checked addresses are returned directly to the connecting socket.
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      });
    },
  };
}
function createGuardedFetch(options = {}) {
  return async (input, init = {}) => {
    const prepared = new Request(input, init);
    const url = new URL(prepared.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw Object.assign(Error('上游地址格式不正确。'), { status: 400, code: 'INVALID_ENDPOINT' });
    const connect = connectionOptions(url, options);
    // Request serializes multipart FormData and sets its boundary without opening a connection.
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(
        url,
        {
          ...connect,
          method: prepared.method,
          headers: Object.fromEntries(prepared.headers),
          signal: prepared.signal,
          agent: false,
        },
        (response) => {
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.statusCode !== 304
          ) {
            response.destroy();
            reject(Object.assign(Error('上游重定向被拒绝。'), { code: 'ERR_UPSTREAM_REDIRECT' }));
            return;
          }
          const headers = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2)
            headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          const empty = prepared.method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
          if (empty) response.resume();
          let body = response;
          if (!empty) {
            const decoders = {
              gzip: createGunzip,
              deflate: createInflate,
              br: createBrotliDecompress,
            };
            const encodings = (headers.get('content-encoding') || '')
              .toLowerCase()
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean);
            if (encodings.length && encodings.every((encoding) => decoders[encoding])) {
              const transforms = encodings.reverse().map((encoding) => decoders[encoding]());
              body = transforms[transforms.length - 1];
              pipeline(response, ...transforms, () => {});
            }
          }
          resolve(
            new Response(empty ? null : Readable.toWeb(body), {
              status: response.statusCode,
              headers,
            }),
          );
        },
      );
      request.on('error', reject);
      request.on('upgrade', (_response, socket) => {
        socket.destroy();
        reject(Object.assign(Error('上游协议切换被拒绝。'), { code: 'ERR_UPSTREAM_UPGRADE' }));
      });
      if (prepared.body) {
        const body = Readable.fromWeb(prepared.body);
        body.on('error', (error) => request.destroy(error));
        request.once('error', () => body.destroy());
        body.pipe(request);
      } else request.end();
    });
  };
}
const guardedFetch = createGuardedFetch();
module.exports = { privateAddress, connectionOptions, createGuardedFetch, guardedFetch };
