// 图片素材：按 id 在 assets-manifest.json 的 art 列表里找文件（见 asset-names.js 的命名约定）；
// 找不到就用程序绘制的占位图（暗色羊皮纸/烛光风格），美术交付后无需改代码即自动替换。
import { findById, findFrames } from './asset-names.js';

const ART_BASE = '../art/';
export const PAL = {
  ink: '#1A1410', umber: '#2B2119', walnut: '#4A3626', bronze: '#7A5A3E', straw: '#A8865C', parch: '#D9C7A3',
  bog: '#1F2B22', moss: '#3E4F3A', olive: '#6E7A5A', amber: '#C9A25A', blood: '#7A2E25', bone: '#E8DFC8',
};
export const FONT = '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "Noto Sans CJK SC", serif';

export class Assets {
  constructor(list = [], meta = {}) {
    this.list = list;
    this.meta = meta; // art/fx/<id>.json 等参数（frames/fps/anchor/loop），见 scan-assets
    this.frameCache = new Map();
    this.images = new Map(); // id → {img, ok}
    this.onLoad = null;
  }
  path(id) { return findById(this.list, id, 'img')[0] ?? null; }
  has(id) { return !!this.path(id); }
  /** 帧序列 id（fx_ink_tendril → _01…_04），结果缓存 */
  frames(id) {
    if (!this.frameCache.has(id)) this.frameCache.set(id, findFrames(this.list, id));
    return this.frameCache.get(id);
  }
  /** 单图或帧序列都算已交付 */
  hasAny(id) { return this.has(id) || this.frames(id).length > 0; }
  /** 逐帧动画：t 秒时应显示的帧图（未加载完的帧退回已加载的上一帧）；id 本身是单图时直接返回它 */
  frameImage(id, t, fps) {
    fps ??= this.meta[id]?.fps ?? 12;
    const fr = this.frames(id);
    if (!fr.length) return this.image(id);
    fr.forEach((f) => this.image(f)); // 预取全部帧，避免第一轮闪烁
    const loop = this.meta[id]?.loop !== false;
    const n = loop ? Math.floor(t * fps) % fr.length : Math.min(fr.length - 1, Math.floor(t * fps));
    for (let k = 0; k < fr.length; k++) { const img = this.image(fr[(n - k + fr.length) % fr.length]); if (img) return img; }
    return null;
  }
  /** 候选 id 里第一个已交付的（都没有则返回最后一个，用于占位） */
  first(ids) { return ids.find((id) => this.has(id)) ?? ids[ids.length - 1]; }
  /** 已加载完成的 HTMLImageElement；未交付/未加载完返回 null（同时触发加载） */
  image(id) {
    if (!id) return null;
    let e = this.images.get(id);
    if (!e) {
      const p = this.path(id);
      if (!p) { this.images.set(id, (e = { img: null, ok: false, missing: true })); return null; }
      const img = new Image();
      e = { img, ok: false };
      img.onload = () => { e.ok = true; this.onLoad?.(id); };
      img.onerror = () => { e.missing = true; };
      img.src = ART_BASE + p;
      this.images.set(id, e);
    }
    return e.ok ? e.img : null;
  }
  preload(ids) { return Promise.all(ids.filter(Boolean).map((id) => new Promise((res) => {
    if (!this.has(id)) return res(false);
    const img = this.image(id); if (img) return res(true);
    const e = this.images.get(id);
    if (!e?.img) return res(false);
    e.img.addEventListener('load', () => res(true), { once: true });
    e.img.addEventListener('error', () => res(false), { once: true });
  }))); }
  /** DOM 用：有图返回 <img>，否则返回绘制好的占位 canvas */
  element(id, placeholder) {
    if (this.has(id)) {
      const img = new Image();
      img.alt = ''; img.draggable = false; img.dataset.asset = id;
      img.src = ART_BASE + this.path(id);
      img.onerror = () => img.replaceWith(placeholder());
      return img;
    }
    const c = placeholder(); c.dataset.placeholder = id; return c;
  }
}

// ---------- 占位图绘制 ----------
export function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function hash(s) { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }
export function rng(seed) { let s = hash(seed) || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ Math.imul(s ^ (s >>> 13), 3266489917)) >>> 0) / 4294967296; }

/** 羊皮纸纹理底 */
export function parchment(g, x, y, w, h, seed = 'p', base = PAL.parch) {
  g.save();
  g.fillStyle = base; g.fillRect(x, y, w, h);
  const r = rng(seed);
  for (let i = 0; i < (w * h) / 900; i++) {
    g.fillStyle = `rgba(122,90,62,${0.04 + r() * 0.08})`;
    g.beginPath(); g.arc(x + r() * w, y + r() * h, 2 + r() * 18, 0, 7); g.fill();
  }
  const grd = g.createRadialGradient(x + w / 2, y + h / 2, Math.min(w, h) * 0.3, x + w / 2, y + h / 2, Math.max(w, h) * 0.75);
  grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(74,54,38,.55)');
  g.fillStyle = grd; g.fillRect(x, y, w, h);
  g.restore();
}

export function wrapText(g, text, x, y, maxW, lh, maxLines = 9) {
  const lines = []; let cur = '';
  for (const ch of String(text)) {
    if (g.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) lines.push(cur);
  lines.slice(0, maxLines).forEach((l, i) => g.fillText(l, x, y + i * lh));
  return lines.length;
}

/** 道具图标 256×256 */
export function itemIcon(id, name = id) {
  const c = canvas(256, 256), g = c.getContext('2d'), r = rng(id);
  const grd = g.createRadialGradient(110, 100, 10, 128, 128, 128);
  grd.addColorStop(0, '#5a4430'); grd.addColorStop(1, PAL.ink);
  g.fillStyle = grd; g.beginPath(); g.arc(128, 128, 120, 0, 7); g.fill();
  g.strokeStyle = PAL.amber; g.lineWidth = 6; g.beginPath(); g.arc(128, 128, 112, 0, 7); g.stroke();
  g.strokeStyle = 'rgba(201,162,90,.35)'; g.lineWidth = 2;
  for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(128, 128, 60 + r() * 40, r() * 6, r() * 6 + 1.5); g.stroke(); }
  g.fillStyle = PAL.bone; g.textAlign = 'center'; g.textBaseline = 'middle';
  const ch = [...String(name).replace(/[（(].*$/, '')];
  const glyph = ch.length > 2 ? ch.slice(-2).join('') : ch.join('');
  g.font = `bold ${glyph.length > 1 ? 84 : 120}px ${FONT}`;
  g.fillText(glyph, 128, 132);
  return c;
}

/** 证据卡 360×480 */
export function evidenceCard(id, name = id, sub = '') {
  const c = canvas(360, 480), g = c.getContext('2d'), r = rng(id);
  parchment(g, 0, 0, 360, 480, id);
  g.strokeStyle = PAL.ink; g.lineWidth = 4; g.strokeRect(10, 10, 340, 460);
  // 小插图：墨线随机符号
  g.save(); g.translate(180, 190); g.strokeStyle = PAL.umber; g.lineWidth = 5; g.lineCap = 'round';
  const kind = hash(id) % 4;
  g.beginPath();
  if (kind === 0) { g.arc(0, 0, 80, 0, 7); g.moveTo(-50, 0); g.quadraticCurveTo(0, 50, 50, 0); }
  else if (kind === 1) { for (let i = 0; i < 4; i++) { g.moveTo(-90, -40 + i * 28); g.bezierCurveTo(-30, -60 + i * 28, 30, -20 + i * 28, 90, -40 + i * 28); } }
  else if (kind === 2) { g.rect(-70, -90, 140, 180); for (let i = 0; i < 6; i++) { g.moveTo(-50, -60 + i * 26); g.lineTo(-50 + 60 + r() * 40, -60 + i * 26); } }
  else { g.moveTo(0, -95); g.lineTo(0, 95); g.moveTo(-60, -40); g.lineTo(60, -40); g.arc(0, 40, 30, 0, 7); }
  g.stroke(); g.restore();
  g.fillStyle = PAL.blood; g.beginPath(); g.arc(180, 26, 12, 0, 7); g.fill();
  g.fillStyle = PAL.umber; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.font = `bold 40px ${FONT}`; wrapText(g, name, 180, 360, 310, 46, 2);
  if (sub) { g.font = `24px ${FONT}`; g.fillStyle = PAL.bronze; g.fillText(sub, 180, 450); }
  return c;
}

/** 半身立绘占位 512×768（实际素材 1024×1536） */
export function portrait(npc, expr, name = npc) {
  const c = canvas(512, 768), g = c.getContext('2d');
  const tone = { calm: PAL.walnut, nervous: '#5a4a2e', cold: '#2f3a33', shaken: '#4b3a3a', broken: '#3d2420' }[expr] ?? PAL.walnut;
  const grd = g.createLinearGradient(0, 0, 0, 768); grd.addColorStop(0, tone); grd.addColorStop(1, PAL.ink);
  g.fillStyle = grd;
  g.beginPath(); g.ellipse(256, 250, 105, 130, 0, 0, 7); g.fill();               // 头
  g.beginPath(); g.moveTo(40, 768); g.quadraticCurveTo(60, 430, 256, 410); g.quadraticCurveTo(452, 430, 472, 768); g.fill(); // 肩
  g.strokeStyle = PAL.amber; g.lineWidth = 3; g.globalAlpha = 0.6;
  g.beginPath(); g.ellipse(256, 250, 105, 130, 0, 0, 7); g.stroke(); g.globalAlpha = 1;
  // 表情：眼睛
  g.strokeStyle = PAL.bone; g.lineWidth = 6; g.lineCap = 'round';
  const eye = (x) => {
    g.beginPath();
    if (expr === 'calm') { g.moveTo(x - 22, 240); g.quadraticCurveTo(x, 228, x + 22, 240); }
    else if (expr === 'cold') { g.moveTo(x - 24, 240); g.lineTo(x + 24, 236); }
    else if (expr === 'nervous' || expr === 'shaken') { g.arc(x, 240, 12, 0, 7); }
    else { g.moveTo(x - 20, 230); g.lineTo(x + 20, 250); g.moveTo(x + 20, 230); g.lineTo(x - 20, 250); }
    g.stroke();
  };
  eye(214); eye(298);
  if (expr === 'nervous' || expr === 'shaken') { g.strokeStyle = 'rgba(232,223,200,.5)'; g.lineWidth = 4; g.beginPath(); g.moveTo(350, 190); g.lineTo(358, 220); g.moveTo(366, 200); g.lineTo(372, 226); g.stroke(); }
  if (expr === 'broken') { g.strokeStyle = PAL.blood; g.lineWidth = 4; g.beginPath(); g.moveTo(256, 130); g.lineTo(240, 200); g.lineTo(270, 260); g.lineTo(250, 330); g.stroke(); }
  g.fillStyle = PAL.parch; g.textAlign = 'center'; g.font = `bold 44px ${FONT}`; g.fillText(name, 256, 640);
  g.font = `28px ${FONT}`; g.fillStyle = PAL.straw; g.fillText(`〔占位立绘 · ${expr}〕`, 256, 690);
  return c;
}
