'use strict';
const { StoryError } = require('./scenario-store.cjs');
const LIMIT = 48 * 1024 * 1024;
const MAX_INPUT_BYTES = 50 * 1024 * 1024,
  MAX_REFERENCES = 16,
  MAX_PROMPT_CHARACTERS = 32000;
function validateImageInputs(prompt, references, { allowEmpty = false } = {}) {
  if (
    typeof prompt !== 'string' ||
    !prompt.trim() ||
    Array.from(prompt).length > MAX_PROMPT_CHARACTERS
  )
    throw new StoryError(
      400,
      'IMAGE_PROMPT_INVALID',
      '图片提示词须为 1 至 32000 个字符，未提交生成请求',
    );
  const minimum = allowEmpty ? 0 : 1;
  if (
    !Array.isArray(references) ||
    references.length < minimum ||
    references.length > MAX_REFERENCES
  )
    throw new StoryError(
      400,
      'IMAGE_REFERENCE_COUNT',
      allowEmpty
        ? '图片请求最多支持 16 张参考图，请调整后重试，未提交生成请求'
        : '图片编辑需要 1 至 16 张参考图，请调整后重试，未提交生成请求',
    );
  for (const [index, bytes] of references.entries()) {
    if (!Buffer.isBuffer(bytes) || bytes.length >= MAX_INPUT_BYTES)
      throw new StoryError(
        400,
        'IMAGE_REFERENCE_SIZE',
        '第 ' + (index + 1) + ' 张参考图必须小于 50 MB，未提交生成请求',
      );
    try {
      mime(bytes);
    } catch {
      throw new StoryError(
        400,
        'IMAGE_REFERENCE_FORMAT',
        '第 ' + (index + 1) + ' 张参考图须为 PNG、JPEG 或 WebP，未提交生成请求',
      );
    }
  }
}
async function bounded(response, limit = LIMIT) {
  let size = 0;
  const chunks = [];
  if (!response.body) throw Error('empty');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Error('large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function mime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  throw new StoryError(
    502,
    'IMAGE_RESULT_INVALID',
    '图片结果不是有效的 PNG、JPEG 或 WebP；请核对后台，本次不会自动重发',
  );
}
function createImageProvider({ config, fetchImpl = fetch, timeoutMs = 600000 } = {}) {
  return {
    async generate({
      prompt,
      references,
      size,
      mode = 'edit',
      signal,
      onProgress = async () => {},
    }) {
      const generation = mode === 'generation';
      validateImageInputs(prompt, references, { allowEmpty: generation });
      if (generation && references.length !== 0)
        throw new StoryError(
          400,
          'IMAGE_GENERATION_REFERENCES',
          '纯文字生图请求不能携带参考图，请调整素材后重试，未提交生成请求',
        );
      const cred = await config.loadCredential();
      if (!cred)
        throw new StoryError(400, 'IMAGE_KEY_REQUIRED', '请先在图片设置中保存图片专用密钥');
      const form = generation ? null : new FormData();
      if (!generation) {
        form.set('model', cred.model);
        form.set('prompt', prompt);
        form.set('n', '1');
        form.set('size', size);
        form.set('quality', 'high');
        form.set('output_format', 'png');
        for (let i = 0; i < references.length; i++)
          form.append(
            'image[]',
            new Blob([references[i]], { type: mime(references[i]) }),
            'reference-' + i + '.' + mime(references[i]).split('/')[1],
          );
      }
      const endpoint =
        cred.provider.replace(/\/+$/, '').replace(/\/v1$/, '') +
        '/v1/images/' +
        (generation ? 'generations' : 'edits');
      const requestHeaders = { Authorization: 'Bearer ' + cred.apiKey };
      const requestBody = generation
        ? JSON.stringify({
            model: cred.model,
            prompt,
            n: 1,
            size,
            quality: 'high',
            output_format: 'png',
          })
        : form;
      if (generation) requestHeaders['Content-Type'] = 'application/json';
      const c = new AbortController(),
        abort = () => c.abort();
      let timedOut = false;
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, timeoutMs);
      if (signal?.aborted) c.abort();
      try {
        await onProgress('waiting');
        let r, data, body;
        try {
          r = await fetchImpl(endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: requestHeaders,
            body: requestBody,
            signal: c.signal,
          });
          body = await bounded(r);
        } catch {
          throw new StoryError(
            502,
            timedOut
              ? 'IMAGE_TIMEOUT'
              : signal?.aborted
                ? 'IMAGE_CANCELLED'
                : 'IMAGE_NETWORK_UNKNOWN',
            timedOut
              ? '图片等待超过 ' +
                  Math.round(timeoutMs / 60000) +
                  ' 分钟，本地未收到完整结果；供应商是否完成或计费仍未知，请核对后台。系统不会自动重发'
              : signal?.aborted
                ? '本地等待已停止，供应商结果未知；不会自动重发'
                : '图片接口网络中断，本地未收到完整结果；请核对后台，系统不会自动重发',
          );
        }
        if (!r.ok) {
          if (r.status >= 500 || [408, 504].includes(r.status))
            throw new StoryError(
              502,
              'IMAGE_SUBMISSION_UNKNOWN',
              '供应商处理结果不明确，请核对后台后决定是否重做；系统不会自动重发',
            );
          throw new StoryError(
            r.status,
            'IMAGE_REJECTED',
            r.status === 401
              ? '图片专用密钥无效'
              : r.status === 402
                ? '图片接口余额不足'
                : r.status === 403
                  ? '当前账户没有图片模型权限'
                  : r.status === 429
                    ? '图片请求过于频繁，请稍后手动重试'
                    : '图片接口拒绝请求（HTTP ' +
                      r.status +
                      '），请确认当前图片模型支持' +
                      (generation ? '纯文字生成' : '参考图编辑') +
                      '及对应参数；不会自动切换请求方式',
          );
        }
        try {
          data = JSON.parse(body.toString());
        } catch {
          throw new StoryError(
            502,
            'IMAGE_RESPONSE_INVALID',
            '图片接口返回异常响应，无法确认制作结果；请核对后台，系统不会自动重发',
          );
        }
        const item = data?.data?.[0];
        let bytes;
        if (
          typeof item?.b64_json === 'string' &&
          item.b64_json.length < LIMIT * 1.4 &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json)
        )
          bytes = Buffer.from(item.b64_json, 'base64');
        else if (typeof item?.url === 'string') {
          await onProgress('downloading');
          try {
            const u = new URL(item.url);
            if (
              u.protocol !== 'https:' ||
              u.username ||
              u.password ||
              require('node:net').isIP(u.hostname.replace(/[\[\]]/g, '')) ||
              /^(localhost|.*\.localhost|.*\.local)$/i.test(u.hostname)
            )
              throw Error();
            const out = await fetchImpl(u.href, { redirect: 'error', signal: c.signal });
            if (!out.ok) throw Error();
            bytes = await bounded(out);
          } catch {
            throw new StoryError(
              502,
              timedOut ? 'IMAGE_DOWNLOAD_TIMEOUT' : 'IMAGE_RESULT_UNSAVED',
              timedOut
                ? '供应商已响应，但下载图片时达到等待上限；请核对后台，不会自动重新生成'
                : '供应商已响应，但图片下载失败。请核对后台后决定是否重做；不会自动重新计费生成',
            );
          }
        } else
          throw new StoryError(
            502,
            'IMAGE_RESULT_UNSAVED',
            '图片接口未返回可保存的图片，请核对后台；不会自动重发',
          );
        if (bytes.length > LIMIT)
          throw new StoryError(502, 'IMAGE_RESULT_INVALID', '返回图片过大，请核对后台');
        mime(bytes);
        return bytes;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
module.exports = { createImageProvider, mime, validateImageInputs };
