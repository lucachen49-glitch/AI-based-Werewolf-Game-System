(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NightfallIntros = api;
})(globalThis, () => {
  'use strict';
  const roles = [
    '绯夜家族继承人',
    '银牙氏族议事代表',
    '边境巡夜人',
    '暮烛家族医师',
    '古堡档案官',
    '绯夜家族乐师',
    '古堡执事',
    '家族使者',
    '北境信使',
    '盟约研究者',
    '古堡管家',
    '家族调停人',
  ];
  function clean(value) {
    if (!value) return null;
    if (!Array.isArray(value.markers) || value.markers.length > 60)
      throw Error('人物介绍标记须为列表，最多60条');
    return {
      enabled: value.enabled === true,
      confirmed: value.confirmed === true,
      confirmation: typeof value.confirmation === 'string' ? value.confirmation : '',
      markers: value.markers.map((m) => ({
        seat: Number(m.seat),
        scene: Number(m.scene),
        start: Number(m.start),
        duration: Number(m.duration),
        position: m.position === 'right' ? 'right' : 'left',
      })),
    };
  }
  function signature(s, plan = s.introductions) {
    return JSON.stringify([
      s.roomSize || 6,
      s.characters.map((c) => [c.seat, c.name, c.publicIdentity || '']),
      s.scenes.map((x) => [
        x.duration || 10,
        x.cast || [],
        x.description,
        x.startFrame || '',
        x.endFrame || '',
        x.dialogues || [],
        x.narration || '',
      ]),
      plan?.markers || [],
    ]);
  }
  function issues(s, plan = s.introductions, { requireConfirmed = true } = {}) {
    if (!plan?.enabled) return [];
    const errors = [],
      seen = new Set(),
      byScene = {};
    for (const m of plan.markers) {
      const who = s.characters.find((c) => c.seat === m.seat),
        shot = s.scenes[m.scene];
      if (!who || !Number.isInteger(m.scene) || !shot) {
        errors.push('介绍人物或镜头无效');
        continue;
      }
      if (seen.has(m.seat)) errors.push(m.seat + '号人物重复介绍');
      seen.add(m.seat);
      if (!who.publicIdentity?.trim()) errors.push(m.seat + '号缺少公开剧情身份');
      if (
        !Number.isFinite(m.start) ||
        !Number.isFinite(m.duration) ||
        m.start < 0 ||
        m.duration < 1 ||
        m.duration > 10 ||
        m.start + m.duration > (shot.duration || 10) + 0.001
      )
        errors.push('镜头' + (m.scene + 1) + '的人物介绍超出时间范围');
      (byScene[m.scene] ??= []).push(m);
    }
    for (const c of s.characters) if (!seen.has(c.seat)) errors.push(c.seat + '号尚未安排介绍');
    for (const rows of Object.values(byScene)) {
      rows.sort((a, b) => a.start - b.start);
      for (let i = 1; i < rows.length; i++)
        if (rows[i].start < rows[i - 1].start + rows[i - 1].duration - 0.001)
          errors.push('同镜人物介绍时间重叠，请依次显示');
    }
    if (requireConfirmed && (!plan.confirmed || plan.confirmation !== signature(s, plan)))
      errors.push('请对照实际画面检查登场时机、人物对应与字幕避让，再确认人物介绍');
    return [...new Set(errors)];
  }
  function suggest(s) {
    const seen = new Set(),
      markers = [];
    s.scenes.forEach((x, scene) => {
      const newcomers = (x.cast || []).filter((seat) => !seen.has(seat));
      const duration = Math.min(3, (x.duration || 10) / Math.max(1, newcomers.length));
      let start = 0;
      for (const seat of newcomers) {
        seen.add(seat);
        markers.push({
          seat,
          scene,
          start,
          duration,
          position: markers.length % 2 ? 'right' : 'left',
        });
        start += duration;
      }
    });
    return { enabled: true, confirmed: false, confirmation: '', markers };
  }
  function timeline(s, plan = s.introductions) {
    let offset = 0;
    const starts = s.scenes.map((x) => {
      const a = offset;
      offset += x.duration || 10;
      return a;
    });
    return (plan?.markers || [])
      .map((m) => ({
        ...m,
        name: s.characters[m.seat - 1]?.name || '',
        publicIdentity: s.characters[m.seat - 1]?.publicIdentity || '',
        absoluteStart: starts[m.scene] + m.start,
      }))
      .sort((a, b) => a.absoluteStart - b.absoluteStart);
  }
  function at(s, time, plan = s.introductions) {
    return (
      timeline(s, plan).find(
        (m) => time >= m.absoluteStart && time < m.absoluteStart + m.duration,
      ) || null
    );
  }
  return { clean, signature, issues, suggest, timeline, at, roles };
});
