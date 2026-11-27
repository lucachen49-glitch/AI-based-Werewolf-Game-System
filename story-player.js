(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NightfallStoryPlayer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create({ video, onState = () => {}, onError = () => {} }) {
    let current = null;
    function state() {
      return current
        ? { active: true, paused: current.paused, blocked: current.blocked }
        : { active: false, paused: false, blocked: false };
    }
    const emit = () => onState(state());
    function finish(proceed) {
      const c = current;
      if (!c) return;
      current = null;
      video.onended = video.onerror = video.onplaying = null;
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {}
      emit();
      c.resolve(proceed);
    }
    async function resume() {
      const c = current;
      if (!c) return;
      const attempt = (c.attempt = (c.attempt || 0) + 1);
      c.paused = false;
      c.blocked = false;
      emit();
      try {
        await video.play();
      } catch (e) {
        if (current !== c || c.attempt !== attempt) return;
        c.paused = true;
        c.blocked = true;
        onError(
          e?.name === 'NotAllowedError'
            ? '点击“继续播放”以播放开场声音。'
            : '视频暂时无法播放，可以重试或跳过开场。',
        );
        emit();
      }
    }
    return {
      state,
      play(url) {
        finish(false);
        return new Promise((resolve) => {
          const c = { resolve, paused: false, blocked: false };
          current = c;
          video.onended = () => {
            if (current === c) finish(true);
          };
          video.onerror = () => {
            if (current !== c) return;
            c.paused = true;
            c.blocked = true;
            onError('开场视频加载失败，可以重试或跳过。');
            emit();
          };
          video.onplaying = () => {
            if (current === c) {
              c.paused = false;
              c.blocked = false;
              emit();
            }
          };
          video.src = url;
          video.load();
          emit();
          void resume();
        });
      },
      pause() {
        if (!current) return;
        current.attempt = (current.attempt || 0) + 1;
        current.paused = true;
        try {
          video.pause();
        } catch {}
        emit();
      },
      resume,
      skip() {
        finish(true);
      },
      cancel() {
        finish(false);
      },
    };
  }
  return { create };
});
