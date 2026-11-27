(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NightfallAvatar = api;
})(globalThis, () => {
  // Built-in emoji avatars; uploaded avatars must be base64 PNG, JPEG or WebP data URLs.
  const AVATARS = Object.freeze([
    '🦊',
    '🦉',
    '🐺',
    '🐼',
    '🦁',
    '🐰',
    '🐸',
    '🐯',
    '🐨',
    '🦌',
    '🐱',
    '🐙',
    '🦝',
    '🐻',
    '🐹',
    '🦄',
  ]);
  const DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  const MAX_DATA_URL_CHARS = 1400000;
  function valid(value) {
    if (typeof value !== 'string') return false;
    if (AVATARS.includes(value)) return true;
    return value.length <= MAX_DATA_URL_CHARS && DATA_URL.test(value);
  }
  function normalize(value, seat = 0) {
    return valid(value)
      ? value
      : AVATARS[((seat % AVATARS.length) + AVATARS.length) % AVATARS.length];
  }
  return { AVATARS, valid, normalize, MAX_DATA_URL_CHARS };
});
