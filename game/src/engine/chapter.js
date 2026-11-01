// 章节数据：直接读取策划的 design/data/chapter1.json（格式见 design/06_开发说明.md），
// 再用 game/data/chapter1.patch.json 补齐策划数据里缺的部分（文本表、房间名、NPC 名、结局过场等）。
// 合并规则：chapter1.json 里有的字段一律优先；补丁只填空缺。浏览器与 Node 工具共用（无 DOM 依赖）。

export const CHAPTER_URL = '../design/data/chapter1.json';
export const PATCH_URL = 'data/chapter1.patch.json';

const KEY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/; // 形如 t_r1_table 的文本 key

/** 去掉 _说明 之类的下划线键 */
const noMeta = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith('_')));

/** raw = chapter1.json 对象，patch = chapter1.patch.json 对象（可为空） */
export function normalizeChapter(raw, patch = {}) {
  const texts = { ...(patch.texts || {}), ...(raw.texts || {}) };
  const tx = (k) => (k == null ? k : texts[k] ?? k); // v1.1：endingTitle / cutsceneCaptions 填文本键
  const C = {
    raw,
    meta: raw.meta || {},
    items: raw.items || {},
    combine: raw.combine || [],
    evidence: raw.evidence || {},
    rooms: raw.rooms || [],
    puzzles: raw.puzzles || {},
    clueboards: raw.clueboards || {},
    interrogations: raw.interrogations || {},
    deductions: raw.deductions || {},
    sanity: { max: 100, start: 100, floor: 20, chapterResetMin: 70, tiers: [], restorePoints: {}, ...(raw.sanity || {}) },
    cutscenes: raw.cutscenes || {},
    npcs: raw.npcs || {},
    texts,
    // v1.1（06 §11）：以下显示字段一律 chapter1.json 优先，补丁只在 json 缺字段时兜底
    roomNames: { ...(patch.roomNames || {}) },
    hotspotLabels: { ...(patch.hotspotLabels || {}) },
    npcNames: { ...(patch.npcNames || {}) },
    cutsceneCaptions: { ...(patch.cutsceneCaptions || {}) },
    audioAlias: { ...(patch.audioAlias || {}) },
    uiText: { ...(patch.uiText || {}), ...(raw.uiText || {}) }, // v1.2 起 json 有全部 27 条，补丁仅兜底
    intro: raw.meta?.intro ?? patch.intro ?? null,
    ending: raw.meta?.ending ?? patch.ending ?? null,
    endingTitle: raw.meta?.endingTitle != null ? tx(raw.meta.endingTitle) : patch.endingTitle ?? '',
    cardImg: { ...(patch.cardImg || {}) },
    puzzleBg: { ...(patch.puzzleBg || {}) },
    puzzleTitles: { ...(patch.puzzleTitles || {}) },
    // 表现层映射：v1.2 起 chapter1.json 已收录（06 §12），json 优先、补丁兜底
    bgVariants: noMeta(raw.bgVariants ?? patch.bgVariants),   // 房间 id → [{req, bg}]：状态变化后的背景差分（04：_door_open 等）
    symbolNames: noMeta(raw.symbolNames ?? patch.symbolNames), // rotate_grid 符号 → 中文名
    uiSfx: noMeta(raw.uiSfx ?? patch.uiSfx),                   // 通用界面音效
    uiBgm: noMeta(raw.uiBgm ?? patch.uiBgm),                   // 标题/审讯/线索板/结局音乐
    hotspotSfx: noMeta(raw.hotspotSfx ?? patch.hotspotSfx),    // 热点成功交互时附加的音效
    closeups: noMeta(raw.closeups),       // v1.2 特写表（06 §12.1）：id → {title, states[], overlays?, pages?}
    artLayers: {},                        // 房间 id → 美术热区文件里的 layers（NPC/乌鸦站位）
    artFakeHotspots: {},                  // 房间 id → 美术热区文件里的 fakeHotspots（只用于 verify 对照）
    patch,
  };
  for (const r of C.rooms) {
    if (r.name) C.roomNames[r.id] = r.name;
    for (const h of r.hotspots || []) if (h.label) C.hotspotLabels[h.id] = h.label;
  }
  for (const [id, n] of Object.entries(C.npcs)) if (n?.name) C.npcNames[id] = n.name;
  for (const [id, caps] of Object.entries(raw.cutsceneCaptions || {})) C.cutsceneCaptions[id] = caps.map(tx);
  for (const cb of Object.values(C.clueboards)) for (const c of cb.cards || []) if (c.img) C.cardImg[c.id] = c.img;
  for (const [id, p] of Object.entries(C.puzzles)) { if (p.bg) C.puzzleBg[id] = p.bg; if (p.title) C.puzzleTitles[id] = p.title; }
  // 补齐道具/证据描述（chapter1.json 有就用它的）
  for (const [id, it] of Object.entries(C.items)) if (!it.desc && patch.itemDesc?.[id]) it.desc = patch.itemDesc[id];
  for (const [id, ev] of Object.entries(C.evidence)) if (!ev.desc && patch.evidenceDesc?.[id]) ev.desc = patch.evidenceDesc[id];
  C.roomById = Object.fromEntries(C.rooms.map((r) => [r.id, r]));
  C.conclusionOf = {}; // 推理题 id → 所属线索板 id
  for (const [cbId, cb] of Object.entries(C.clueboards)) if (cb.conclusion) C.conclusionOf[cb.conclusion] = cbId;
  return C;
}

/**
 * NPC 场景图层（全身站姿 char_<npc>_full）。热区文件应用之后调用。
 * 站姿图：npcs[npc].fullBody（json）→ 补丁 npcLayers[npc].img → char_<npc>_full。
 * 位置优先级：json npcs[npc].rect/room → 美术热区文件 layers（id = 站姿图）→ 补丁 npcLayers[npc] → 该 NPC 审讯入口热点的 rect。
 * 图层只画在画布上，点击判定只看热点 rect，所以立绘永远不会挡住热区点击。
 */
export function resolveNpcLayers(C) {
  const out = [];
  const npcIds = new Set([...Object.keys(C.npcs), ...Object.values(C.interrogations).map((i) => i.npc).filter(Boolean)]);
  for (const npc of npcIds) {
    const j = C.npcs[npc] || {}, pl = C.patch.npcLayers?.[npc] || {};
    const img = j.fullBody ?? pl.img ?? `char_${npc}_full`;
    // 入口热点：打开该 NPC 审讯的热点
    const intIds = Object.entries(C.interrogations).filter(([, it]) => it.npc === npc).map(([id]) => id);
    let entry = null;
    for (const r of C.rooms) for (const h of r.hotspots || []) {
      if (!entry && (h.interactions || []).some((it) => (it.effects || []).some((e) => e.type === 'open' && e.ui === 'interrogation' && intIds.includes(e.id)))) entry = { room: r.id, h };
    }
    let room = j.room ?? null, rect = Array.isArray(j.rect) ? j.rect : null, src = rect ? 'chapter1.json npcs' : null;
    if (!rect) for (const [rid, layers] of Object.entries(C.artLayers)) {
      const l = layers.find((x) => x.id === img && Array.isArray(x.rect));
      if (l && (!room || room === rid)) { room = rid; rect = l.rect; src = '美术热区文件 layers'; break; }
    }
    if (!rect && Array.isArray(pl.rect)) { room = pl.room ?? room ?? entry?.room; rect = pl.rect; src = '补丁 npcLayers'; }
    if (!rect && entry) { rect = entry.h.rect; src = `热点 ${entry.h.id}`; }
    room ??= pl.room ?? entry?.room ?? null;
    if (!room || !rect) continue;
    out.push({ npc, img, room, rect, src, hotspot: entry?.h.id ?? null, req: j.req ?? pl.req ?? null });
  }
  C.npcLayers = out;
  return out;
}

export async function loadChapter(readJson) {
  const raw = await readJson(CHAPTER_URL);
  let patch = {};
  try { patch = await readJson(PATCH_URL); } catch { /* 无补丁也能跑 */ }
  return normalizeChapter(raw, patch);
}

export const isTextKey = (s) => typeof s === 'string' && KEY_RE.test(s);

/** 文本 key → 文本；非 key（审讯里的内联台词）原样返回；缺失的 key 显示占位 */
export function resolveText(C, s) {
  if (s == null) return '';
  if (C.texts[s] != null) return C.texts[s];
  if (isTextKey(s)) return `〔缺文本：${s}〕`;
  return s;
}

/** 去掉 <k>…</k> 关键词标记 */
export const stripKeys = (s) => String(s).replace(/<\/?k>/g, '');

/**
 * 心烛 s3 的 text_glitch：随机把非关键词片段替换成 ▇▇。
 * <k>…</k> 包住的关键词在 protectKeys=true 时不替换。rng 可注入以便测试。
 */
export function glitchText(s, { chance = 0.15, protectKeys = true, rng = Math.random } = {}) {
  const parts = String(s).split(/(<k>.*?<\/k>)/g);
  return parts.map((p) => {
    if (/^<k>.*<\/k>$/.test(p)) return protectKeys ? stripKeys(p) : glitchPlain(stripKeys(p), chance, rng);
    return glitchPlain(p, chance, rng);
  }).join('');
}
function glitchPlain(p, chance, rng) {
  // 以 2 个汉字/一个英文词为单位，标点不替换
  return p.replace(/[\u4e00-\u9fa5]{2}|[A-Za-z]+/g, (m) => (rng() < chance ? '▇▇' : m));
}

// ---------- 美术交付的热区坐标覆盖（art/**/bg_xxx_hotspots.json 或 *hotspots*.json） ----------
// 格式不确定，以下几种都接受（坐标均为 1080×1920 逻辑像素，rect = [x, y, w, h]）：
//   {"room":"r1_hall","hotspots":[{"id":"h_table","rect":[x,y,w,h]} | {"id":"h_table","x":..,"y":..,"w":..,"h":..}]}
//   [{"id":"h_table","rect":[...]}, ...]
//   {"h_table":[x,y,w,h], "h_armor":{"x":..,"y":..,"w":..,"h":..}}
// id 可写全名 h_table 或省略 h_ 前缀；只覆盖坐标，交互逻辑仍以 chapter1.json 为准。
export const HOTSPOT_FILE_RE = /hotspots?[^/]*\.json$/i;

/** 判断热区文件属于哪个房间：文件内 room 字段 → 路径里的房间 id → 路径里的背景 id */
export function roomForHotspotFile(C, relPath, data) {
  const r = data && !Array.isArray(data) ? (data.room ?? data.roomId) : null;
  if (r && C.roomById[r]) return r;
  const base = relPath.toLowerCase();
  const byBg = [...C.rooms].sort((a, b) => (b.bg || '').length - (a.bg || '').length).find((x) => x.bg && base.includes(x.bg.toLowerCase()));
  if (byBg) return byBg.id;
  return C.rooms.find((x) => base.includes(x.id.toLowerCase()))?.id ?? null;
}

function toRect(v) {
  if (Array.isArray(v) && v.length === 4 && v.every(Number.isFinite)) return v.map(Math.round);
  if (v && typeof v === 'object') {
    if (v.rect) return toRect(v.rect);
    if (v.bbox) return toRect(v.bbox);
    const w = v.w ?? v.width, h = v.h ?? v.height;
    if ([v.x, v.y, w, h].every(Number.isFinite)) return [v.x, v.y, w, h].map(Math.round);
  }
  return null;
}

export function parseHotspotFile(data) {
  const out = {};
  const list = Array.isArray(data) ? data : Array.isArray(data?.hotspots) ? data.hotspots : null;
  if (list) { for (const e of list) { const r = toRect(e); if (e?.id && r) out[e.id] = r; } return out; }
  const obj = data?.hotspots && typeof data.hotspots === 'object' ? data.hotspots : data;
  for (const [k, v] of Object.entries(obj || {})) { const r = toRect(v); if (r) out[k] = r; }
  return out;
}

/** 把一个热区文件应用到 C（就地修改）。返回 {room, file, applied, unknown} 记录，也追加到 C.hotspotOverrides */
export function applyHotspotFile(C, relPath, data) {
  const room = roomForHotspotFile(C, relPath, data);
  const rec = { file: relPath, room, applied: [], unknown: [] };
  (C.hotspotOverrides ??= []).push(rec);
  if (!room) return rec;
  if (data && !Array.isArray(data)) {
    if (Array.isArray(data.layers)) (C.artLayers ??= {})[room] = data.layers;
    if (Array.isArray(data.fakeHotspots)) (C.artFakeHotspots ??= {})[room] = data.fakeHotspots;
  }
  const hs = C.roomById[room].hotspots || [];
  for (const [id, rect] of Object.entries(parseHotspotFile(data))) {
    const h = hs.find((x) => x.id === id || x.id === `h_${id}`);
    if (!h) { rec.unknown.push(id); continue; }
    if (JSON.stringify(h.rect) === JSON.stringify(rect)) { (rec.same ??= []).push(h.id); continue; }
    h.rectDesign ??= h.rect;
    h.rect = rect;
    rec.applied.push(h.id);
  }
  return rec;
}
