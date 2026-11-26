/* Fixed output pixels, independent of the size of the live preview. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NightfallRecordingSurface = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const width = 1080,
    height = 1920,
    version = "portrait-1080-v2";
  function region(sourceWidth, sourceHeight, rect, viewport, cropped) {
    if (cropped)
      return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
    const scaleX = sourceWidth / viewport.width,
      scaleY = sourceHeight / viewport.height;
    const x = Math.max(0, Math.min(sourceWidth, rect.x * scaleX)),
      y = Math.max(0, Math.min(sourceHeight, rect.y * scaleY));
    return {
      x,
      y,
      width: Math.max(0, Math.min(sourceWidth - x, rect.width * scaleX)),
      height: Math.max(0, Math.min(sourceHeight - y, rect.height * scaleY)),
    };
  }
  function matchesFrame(sourceWidth, sourceHeight, rect) {
    return (
      sourceWidth > 0 &&
      sourceHeight > 0 &&
      Math.abs(sourceWidth - (sourceHeight * rect.width) / rect.height) <= 3
    );
  }
  async function create(
    stream,
    frame,
    { cropped = false, mode = cropped ? "region" : "element" } = {},
  ) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    let stopped = false,
      callback,
      lastRegion;
    try {
      await video.play();
      if (!video.videoWidth)
        await new Promise((resolve, reject) => {
          const loaded = () => {
              cleanup();
              resolve();
            },
            failed = () => {
              cleanup();
              reject(Error("无法读取录屏画面，请重新授权当前标签页。"));
            };
          const cleanup = () => {
            clearTimeout(timer);
            video.removeEventListener("loadeddata", loaded);
            video.removeEventListener("error", failed);
          };
          const timer = setTimeout(failed, 10000);
          video.addEventListener("loadeddata", loaded, { once: true });
          video.addEventListener("error", failed, { once: true });
        });
      if (cropped) {
        await new Promise((resolve, reject) => {
          let settled = false,
            stable = 0,
            previous = "";
          const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            error ? reject(error) : resolve();
          };
          const timer = setTimeout(
            () =>
              finish(
                Error(
                  "录屏画框未被完整采集。请将浏览器窗口完整放在屏幕内，或最大化窗口后重新开始。",
                ),
              ),
            10000,
          );
          const check = () => {
            if (settled) return;
            const dimensions = video.videoWidth + "x" + video.videoHeight;
            stable = matchesFrame(
              video.videoWidth,
              video.videoHeight,
              frame.getBoundingClientRect(),
            )
              ? dimensions === previous
                ? stable + 1
                : 1
              : 0;
            previous = dimensions;
            if (stable >= 3) return finish();
            if (video.requestVideoFrameCallback)
              video.requestVideoFrameCallback(check);
            else requestAnimationFrame(check);
          };
          check();
        });
      }
    } catch (error) {
      video.pause();
      video.srcObject = null;
      throw error;
    }
    function draw() {
      if (stopped) return;
      const rect = frame.getBoundingClientRect();
      lastRegion = region(
        video.videoWidth,
        video.videoHeight,
        rect,
        { width: innerWidth, height: innerHeight },
        cropped,
      );
      context.fillStyle = "#191310";
      context.fillRect(0, 0, width, height);
      const r = lastRegion;
      if (r.width > 0 && r.height > 0)
        context.drawImage(
          video,
          r.x,
          r.y,
          r.width,
          r.height,
          0,
          0,
          width,
          height,
        );
      callback = video.requestVideoFrameCallback
        ? video.requestVideoFrameCallback(draw)
        : requestAnimationFrame(draw);
    }
    draw();
    const output = canvas.captureStream(30);
    for (const track of stream.getAudioTracks()) output.addTrack(track);
    return {
      stream: output,
      metadata: {
        version,
        width,
        height,
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
        mode,
        region: lastRegion,
      },
      stop() {
        stopped = true;
        if (video.cancelVideoFrameCallback)
          video.cancelVideoFrameCallback(callback);
        else cancelAnimationFrame(callback);
        video.pause();
        video.srcObject = null;
        output.getVideoTracks().forEach((track) => track.stop());
      },
    };
  }
  return { width, height, version, region, matchesFrame, create };
});
