'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NightfallWorkshopFlow = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  function derive(input) {
    if (input.mode === 'legacy') {
      const story = !!input.storyReady,
        video = !!input.videoReady,
        adopted = !!input.adopted;
      return [
        {
          id: 'story',
          label: '剧本编辑',
          status: story ? 'complete' : input.hasStory ? 'stale' : 'active',
          accessible: true,
        },
        {
          id: 'video',
          label: '正式视频',
          status: input.videoRunning
            ? 'running'
            : video
              ? 'complete'
              : input.hasVideo && !story
                ? 'stale'
                : story
                  ? 'active'
                  : 'locked',
          accessible: story || !!input.hasVideo,
        },
        {
          id: 'adopt',
          label: '预览采用',
          status: adopted
            ? video
              ? 'complete'
              : 'stale'
            : video
              ? input.previewConfirmed
                ? 'ready'
                : input.previewed
                  ? 'acknowledge'
                  : 'preview'
              : input.hasAdopted
                ? 'stale'
                : 'locked',
          accessible: video || !!input.hasAdopted,
        },
      ];
    }
    const story = !!input.storyReady,
      review = !!input.reviewReady,
      art = !!input.artReady,
      video = !!input.videoReady,
      adopted = !!input.adopted;
    const reviewStatus = input.reviewRunning
      ? 'running'
      : review
        ? 'complete'
        : input.hasReview && !input.reviewCurrent
          ? 'stale'
          : input.hasReview
            ? 'optional'
            : story
              ? 'optional'
              : 'locked';
    const artReady = story,
      videoReady = artReady && art;
    const artStatus = input.artRunning
      ? 'running'
      : art
        ? 'complete'
        : input.hasArt && !artReady
          ? 'stale'
          : artReady
            ? input.artConfirmPending
              ? 'confirm'
              : 'active'
            : input.hasArt
              ? 'stale'
              : 'locked';
    const videoStatus = input.videoRunning
      ? 'running'
      : video
        ? 'complete'
        : input.hasVideo && !videoReady
          ? 'stale'
          : videoReady
            ? 'active'
            : 'locked';
    const adoptStatus = adopted
      ? video
        ? 'complete'
        : 'stale'
      : video
        ? input.previewConfirmed
          ? 'ready'
          : input.previewed
            ? 'acknowledge'
            : 'preview'
        : input.hasAdopted
          ? 'stale'
          : 'locked';
    return [
      {
        id: 'story',
        label: '剧本编辑',
        status: story ? 'complete' : input.hasStory ? 'stale' : 'active',
        accessible: true,
      },
      {
        id: 'review',
        label: 'AI 核对',
        status: reviewStatus,
        accessible: story || !!input.hasReview,
      },
      { id: 'art', label: '人物与分镜', status: artStatus, accessible: artReady || !!input.hasArt },
      {
        id: 'video',
        label: '独立视频',
        status: videoStatus,
        accessible: videoReady || !!input.hasVideo,
      },
      {
        id: 'adopt',
        label: '预览采用',
        status: adoptStatus,
        accessible: video || !!input.hasAdopted,
      },
    ];
  }
  function activeIndex(steps) {
    const i = steps.findIndex(
      (s) => s.id !== 'review' && !['complete', 'optional'].includes(s.status),
    );
    return i < 0 ? steps.length - 1 : i;
  }
  return { derive, activeIndex };
});
