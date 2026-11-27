'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const testFiles = fs.readdirSync(projectRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.cjs'))
  .map(entry => entry.name)
  .sort();

if (testFiles.length === 0) {
  process.stderr.write('No root-level *.test.cjs files were found.\n');
  process.exitCode = 1;
} else {
  const logDirectory = path.join(projectRoot, 'logs', 'test');
  fs.mkdirSync(logDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const logPath = path.join(logDirectory, `test-${timestamp}.log`);
  const log = fs.createWriteStream(logPath, { flags: 'wx' });
  const child = spawn(process.execPath, ['--test', ...testFiles], {
    cwd: projectRoot,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true
  });

  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      log.write(chunk);
      (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
    });
  }

  child.on('error', error => {
    log.write(`Test runner failed to start: ${error.stack || error}\n`);
    process.stderr.write(`Test runner failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });

  child.on('close', code => {
    log.end(() => {
      if (code !== 0 && process.exitCode === undefined) {
        process.exitCode = code ?? 1;
      }
      process.stdout.write(`Test log saved to ${path.relative(projectRoot, logPath)}\n`);
    });
  });
}
