'use strict';
const fs = require('node:fs');
const path = require('node:path');
const RETENTION_MS = 72 * 60 * 60 * 1000;
const SYSTEM_LOGS = [
  'agent-requests.jsonl',
  'game-lifecycle.log',
  'game.stdout.log',
  'game.stderr.log',
];

function timestampFromLine(file, line) {
  if (file === 'agent-requests.jsonl') {
    try {
      const time = Date.parse(JSON.parse(line).time);
      return Number.isFinite(time) ? time : null;
    } catch {
      return null;
    }
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/.exec(line);
  if (!match) return null;
  const time = Date.parse(match[1]);
  return Number.isFinite(time) ? time : null;
}

function cleanSystemLogs({
  directory = path.join(__dirname, 'logs'),
  now = Date.now(),
  files = SYSTEM_LOGS,
} = {}) {
  const cutoff = now - RETENTION_MS;
  const cleaned = [];
  for (const name of files) {
    if (!SYSTEM_LOGS.includes(name)) continue;
    const file = path.join(directory, name);
    let stat, text;
    try {
      stat = fs.statSync(file);
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const keepByModification = stat.mtimeMs >= cutoff;
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const retained = lines.filter((line) => {
      const timestamp = timestampFromLine(name, line);
      return timestamp === null ? keepByModification : timestamp >= cutoff;
    });
    const next = retained.length ? retained.join('\n') + '\n' : '';
    if (next !== text) {
      fs.writeFileSync(file, next, 'utf8');
      cleaned.push({ file, removed: lines.length - retained.length });
    }
  }
  return cleaned;
}

function createTimestampedWriter(
  file,
  append = (target, text) => fs.appendFileSync(target, text, { encoding: 'utf8' }),
) {
  let pending = '';
  function writeLine(line) {
    append(file, new Date().toISOString() + ' ' + line + '\n');
  }
  return {
    write(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) writeLine(line);
    },
    flush() {
      if (pending.length) {
        writeLine(pending);
        pending = '';
      }
    },
  };
}

module.exports = { RETENTION_MS, SYSTEM_LOGS, cleanSystemLogs, createTimestampedWriter };
