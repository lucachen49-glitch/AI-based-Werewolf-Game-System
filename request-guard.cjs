'use strict';

function assertSameOrigin(req, { write = false } = {}) {
  const origin = req.headers.origin;
  const expected = 'http://' + req.headers.host;
  return !(
    req.headers['sec-fetch-site'] === 'cross-site' ||
    (origin && origin !== expected) ||
    (write && origin !== expected)
  );
}

function assertJSON(req) {
  return /^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '');
}

module.exports = { assertSameOrigin, assertJSON };
