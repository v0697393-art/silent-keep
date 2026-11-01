// 素材查找约定（浏览器与 Node 工具共用）。
// chapter1.json 里的素材都用 id 引用（bg_r1_hall、item_candle、char_osbert_calm、ev_rosary、bgm_r1_hall、sfx_stone_sink…）。
// 文件名 = id 本身，或 id 后加尺寸/规格后缀；放在 art/ 或 audio/ 的任意子目录都行：
//   art/bg/bg_r1_hall.png  或  art/bg/bg_r1_hall_1080x1920.png  （style-guide：类别_对象_变体_宽x高.png）
//   art/characters/char_osbert_calm.png（美术现有交付）
//   audio/sfx/sfx_stone_sink.m4a|ogg|mp3
// 音频优先按 audio/audio_manifest.json 的 files[id].src 查找（只采用磁盘上确实存在的文件）。
export const IMG_EXT = ['webp', 'png', 'jpg', 'jpeg', 'svg'];
export const AUD_EXT = ['m4a', 'ogg', 'mp3', 'aac', 'wav']; // 与 audio_manifest 的 iOS 优先顺序一致

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 在文件列表里找 id 对应的文件，返回按优先级排序的相对路径数组（精确名优先，其次带 _宽x高 后缀） */
export function findById(list, id, kind = 'img') {
  if (!id) return [];
  const exts = kind === 'aud' ? AUD_EXT : IMG_EXT;
  const re = new RegExp(`(^|/)${esc(id)}(_\\d+x\\d+)?\\.(${exts.join('|')})$`, 'i');
  return list
    .map((f) => [f, f.match(re)])
    .filter(([, m]) => m)
    .sort((a, b) => (a[1][2] ? 1 : 0) - (b[1][2] ? 1 : 0) || exts.indexOf(a[1][3].toLowerCase()) - exts.indexOf(b[1][3].toLowerCase()))
    .map(([f]) => f);
}

/**
 * 帧序列：id 本身没有文件、但有 id_01、id_02… 时视为逐帧动画（style-guide：6–12 帧，12fps）。
 * 返回按帧号排序的帧 id 数组（如 ['fx_ink_tendril_01', … '_04']），同一帧号多种格式只取一次。
 */
export function findFrames(list, id, kind = 'img') {
  if (!id) return [];
  const exts = kind === 'aud' ? AUD_EXT : IMG_EXT;
  const re = new RegExp(`(^|/)${esc(id)}_(\\d{2,3})(_\\d+x\\d+)?\\.(${exts.join('|')})$`, 'i');
  const nums = new Map();
  for (const f of list) { const m = f.match(re); if (m && !nums.has(m[2])) nums.set(m[2], `${id}_${m[2]}`); }
  return [...nums.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, fid]) => fid);
}

/** 从 audio_manifest.json 找 id 的音频，只返回 existing 列表里存在的（路径相对 audio/） */
export function audioFromManifest(audioManifest, id, existing) {
  const e = audioManifest?.files?.[id];
  if (!e?.src) return [];
  const order = audioManifest.formats_by_preference_ios_first ?? AUD_EXT;
  return order.map((fmt) => e.src[fmt]).filter((p) => p && existing.includes(p));
}

/** 音频 id → 候选文件（相对 audio/）：manifest → 文件名 → 别名（patch.audioAlias） */
export function resolveAudio(id, { manifest, files, alias = {} }) {
  const tryId = (x) => {
    const m = audioFromManifest(manifest, x, files);
    return m.length ? m : findById(files, x, 'aud');
  };
  let r = tryId(id);
  if (!r.length && alias[id]) r = tryId(alias[id]);
  return r;
}
