'use strict';
const node = (id) => document.getElementById(id);
let saving = false,
  ready = false;
function renderStatus(config) {
  node('imageProvider').textContent = config.provider;
  node('imageModel').textContent = config.model;
  node('statusDot').classList.toggle('configured', config.configured);
  node('savedTitle').textContent = config.configured
    ? '图片密钥已加密保存在本机'
    : '尚未保存图片密钥';
  node('savedDetail').textContent = config.configured
    ? '保存时间：' +
      new Date(config.savedAt).toLocaleString('zh-CN') +
      '。接口与模型权限待制作时验证。'
    : '填写下方密钥后即可保存，不需要在聊天中发送。';
  node('imageKey').placeholder = config.configured
    ? '已保存；如需更换，请填写新密钥'
    : '在此填写华龙图片接口 API Key';
}
function message(text, error = false) {
  node('result').textContent = text;
  node('result').classList.toggle('error', error);
}
async function request(options) {
  const response = await fetch('/api/image-config', {
    cache: 'no-store',
    redirect: 'error',
    ...options,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data)
    throw Error(
      data?.error?.message ||
        (response.status === 404
          ? '请重新启动游戏服务，再刷新此页面。'
          : '本机配置服务暂不可用，请检查游戏启动窗口。'),
    );
  return data;
}
node('toggleKey').addEventListener('click', () => {
  const show = node('imageKey').type === 'password';
  node('imageKey').type = show ? 'text' : 'password';
  node('toggleKey').textContent = show ? '隐藏' : '显示';
  node('toggleKey').setAttribute('aria-pressed', String(show));
  node('toggleKey').setAttribute('aria-label', show ? '隐藏密钥' : '显示密钥');
});
node('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saving || !ready) return;
  if (node('imageKey').value.trim().length < 8) {
    message('请填写有效的图片接口密钥。', true);
    return;
  }
  saving = true;
  node('saveButton').disabled = true;
  node('imageKey').disabled = true;
  node('saveButton').textContent = '正在加密保存…';
  message('');
  try {
    const data = await request({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: node('imageKey').value.trim() }),
    });
    node('imageKey').value = '';
    node('imageKey').type = 'password';
    node('toggleKey').textContent = '显示';
    node('toggleKey').setAttribute('aria-pressed', 'false');
    node('toggleKey').setAttribute('aria-label', '显示密钥');
    renderStatus(data);
    message('已保存。请回到聊天告诉我“已保存”，即可继续验证接口并制作庄园素材。');
  } catch (error) {
    message(
      error instanceof TypeError ? '无法连接本机服务，请确认游戏启动窗口仍在运行。' : error.message,
      true,
    );
  } finally {
    saving = false;
    node('saveButton').disabled = false;
    node('imageKey').disabled = false;
    node('saveButton').textContent = '加密保存到本机';
  }
});
void (async () => {
  try {
    renderStatus(await request());
    ready = true;
    node('saveButton').disabled = false;
  } catch (error) {
    node('savedTitle').textContent = '配置状态读取失败';
    node('savedDetail').textContent =
      error instanceof TypeError ? '请通过游戏启动地址打开此页面，并保持服务运行。' : error.message;
    message('请重启游戏服务后刷新页面。', true);
  }
})();
