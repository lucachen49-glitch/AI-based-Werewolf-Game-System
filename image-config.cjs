'use strict';
// Production-art credentials belong to the Windows account, never player profiles.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const PROVIDER = 'https://api-fast.hualong-ai.com/v1';
const MODEL = 'gpt-image-2.5-sunburst';
const credentialPath = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'NightfallWerewolf',
  'image-provider.json',
);

class ImageConfigError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function protectSecret(value, decrypt = false) {
  if (process.platform !== 'win32')
    return Promise.reject(
      new ImageConfigError(
        503,
        'WINDOWS_REQUIRED',
        '此密钥保存方式需要 Windows，请在这台 Windows 电脑上打开设置。',
      ),
    );
  // Only constant code is passed as an argument. Secret input travels over stdin.
  const script =
    "$ErrorActionPreference='Stop';[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);[void][System.Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');$value=[Console]::In.ReadToEnd();" +
    (decrypt
      ? '$bytes=[byte[]]::new($value.Length/2);for($i=0;$i -lt $bytes.Length;$i++){$bytes[$i]=[Convert]::ToByte($value.Substring($i*2,2),16)};$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);try{[Console]::Write([Text.Encoding]::UTF8.GetString($plain))}finally{[Array]::Clear($plain,0,$plain.Length)}'
      : "$plain=[Text.Encoding]::UTF8.GetBytes($value);try{$encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([BitConverter]::ToString($encrypted).Replace('-','').ToLowerInvariant())}finally{[Array]::Clear($plain,0,$plain.Length)}");
  return new Promise((resolve, reject) => {
    const executable = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const child = spawn(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '',
      settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error)
        reject(
          new ImageConfigError(
            500,
            'ENCRYPTION_FAILED',
            'Windows 密钥保护暂不可用，请重试；原有配置没有改变。',
          ),
        );
      else resolve(output);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(true);
    }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      output += data;
      if (output.length > Math.max(65536, Buffer.byteLength(value, 'utf8') * 2 + 8192)) {
        child.kill();
        finish(true);
      }
    });
    child.stderr.resume(); // Never forward diagnostics that could include secret input.
    child.on('error', () => finish(true));
    child.on('close', (code) => finish(code !== 0 || !output));
    child.stdin.on('error', () => finish(true));
    child.stdin.end(value, 'utf8');
  });
}
function createImageConfigStore(file = credentialPath) {
  async function read() {
    try {
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      if (
        record.version !== 1 ||
        record.protection !== 'windows-dpapi-current-user' ||
        typeof record.encryptedKey !== 'string' ||
        !/^01000000[0-9a-f]+$/i.test(record.encryptedKey) ||
        typeof record.savedAt !== 'string'
      )
        throw Error();
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new ImageConfigError(500, 'CONFIG_READ_FAILED', '图片配置无法读取，请重新填写并保存。');
    }
  }
  return {
    async status() {
      const record = await read();
      return {
        configured: !!record,
        provider: PROVIDER,
        model: MODEL,
        savedAt: record?.savedAt || null,
        storage: 'Windows 当前用户加密保存',
        verified: false,
      };
    },
    async save(body) {
      if (
        !body ||
        Array.isArray(body) ||
        typeof body.apiKey !== 'string' ||
        !/^\S{8,8192}$/.test(body.apiKey.trim())
      )
        throw new ImageConfigError(400, 'INVALID_IMAGE_KEY', '请填写有效的图片接口密钥。');
      const encryptedKey = await protectSecret(body.apiKey.trim());
      const record = {
        version: 1,
        protection: 'windows-dpapi-current-user',
        provider: PROVIDER,
        model: MODEL,
        encryptedKey,
        savedAt: new Date().toISOString(),
      };
      const temp = file + '.' + process.pid + '.' + require('node:crypto').randomUUID() + '.tmp';
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, file);
      } catch {
        throw new ImageConfigError(
          500,
          'CONFIG_SAVE_FAILED',
          '无法保存图片配置，请检查当前 Windows 账户的文件权限后重试。',
        );
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
      }
      return this.status();
    },
    async loadCredential() {
      const record = await read();
      if (!record) return null;
      return {
        provider: PROVIDER,
        model: MODEL,
        apiKey: await protectSecret(record.encryptedKey, true),
      };
    },
  };
}
module.exports = {
  createImageConfigStore,
  ImageConfigError,
  credentialPath,
  PROVIDER,
  MODEL,
  protectSecret,
};
