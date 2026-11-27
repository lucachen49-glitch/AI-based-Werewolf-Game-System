'use strict';
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');

// Game actions wait for the provider until cancellation or a connection error.
// A dedicated socket avoids the response deadlines in the shared fetch client.
function requestAgent(
  endpoint,
  { method = 'POST', headers = {}, body = '', signal, timeoutMs = 0 },
) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      {
        method,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        agent: false,
        timeout: timeoutMs,
        signal,
      },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          reject(Object.assign(Error('Agent endpoint redirected'), { code: 'ERR_AGENT_REDIRECT' }));
          return;
        }
        response.setTimeout(timeoutMs);
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          body: Readable.toWeb(response),
        });
      },
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(Object.assign(Error('Agent request timed out'), { code: 'ETIMEDOUT' })),
    );
    request.on('socket', (socket) => socket.setTimeout(timeoutMs));
    request.on('error', reject);
    request.end(body);
  });
}

const retryableCodes = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
]);
function networkCode(error) {
  return error?.code || error?.cause?.code;
}
function isRetryableNetworkError(error) {
  return retryableCodes.has(networkCode(error));
}
function waitForRetry(signal, delayMs) {
  if (!delayMs) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(
        Object.assign(Error('Agent request cancelled'), { name: 'AbortError', code: 'ABORT_ERR' }),
      );
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
async function requestAgentWithRetry(endpoint, options = {}) {
  const retries = Number.isInteger(options.retries) && options.retries >= 0 ? options.retries : 1;
  const retryDelayMs =
    Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0 ? options.retryDelayMs : 150;
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestAgent(endpoint, options);
    } catch (error) {
      if (attempt >= retries || options.signal?.aborted || !isRetryableNetworkError(error))
        throw error;
      await waitForRetry(options.signal, retryDelayMs);
    }
  }
}
module.exports = { requestAgent, requestAgentWithRetry, isRetryableNetworkError };
