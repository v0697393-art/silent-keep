// 章节数据：直接读取策划的 design/data/chapter1.json（格式见 design/06_开发说明.md），
// 再用 game/data/chapter1.patch.json 补齐策划数据里缺的部分（文本表、房间名、NPC 名、结局过场等）。
// 合并规则：chapter1.json 里有的字段一律优先；补丁只填空缺。浏览器与 Node 工具共用（无 DOM 依赖）。

import { PLAY_RECT } from './layout.js';

/** 章节表（06 §13.1）。patch 为 null = 该章不需要开发补丁（显示字段 json 里都有）；walkthrough 是工具用的回放脚本（相对 game/） */
export const CHAPTERS = [
  { n: 1, url: '../design/data/chapter1.json', patch: 'data/chapter1.patch.json', walkthrough: 'tools/walkthrough-ch1.json' },
  // { n: 2, url: '../design/data/chapter2.json', patch: null, walkthrough: 'tools/walkthrough-ch2.json' }, // 发布快照：第二章未完成，暂不开放
];
export const chapterInfo = (n) => CHAPTERS.find((c) => c.n === Number(n)) ?? null;
export const CHAPTER_URL = CHAPTERS[0].url;   // 兼容旧调用（= 第一章）
export const PATCH_URL = CHAPTERS[0].patch;
/** 与章节无关的引擎默认（人物表现、心烛扣减原因、试玩后修订的通用界面文案）。每章都先套它，再套本章补丁；
 *  第二章（06 §13，无补丁）直接继承这些行为。 */
export const DEFAULTS_URL = 'data/engine-defaults.json';

/** 引擎默认 + 本章补丁：对象字段浅合并（本章优先），其余字段本章补丁直接覆盖 */
export function mergePatch(defaults = {}, patch = {}) {
  const out = { ...noMetaKeep(defaults), ...patch };
  for (const k of ['npcPresentation', 'sanityReasons', 'uiTextOverrides', 'uiText', 'moodLabels']) {
    if (defaults[k] && typeof defaults[k] === 'object') out[k] = { ...defaults[k], ...(patch[k] || {}) };
  }
  if (defaults.npcPresentation?.moodLabels) out.npcPresentation.moodLabels = { ...defaults.npcPresentation.moodLabels, ...(patch.npcPresentation?.moodLabels || {}) };
  return out;
}
const noMetaKeep = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith('_')));

const KEY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/; // 形如 t_r1_table 的文本 key

/** 去掉 _说明 之类的下划线键 */
const noMeta = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith('_')));
/** 比较用：去掉所有层级的 _ 键后序列化 */
const stripMeta = (o) => JSON.stringify(o ?? null, (k, v) => (k.startsWith('_') ? undefined : v));

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
    // v1.2 起 json 有全部 27 条，补丁 uiText 仅兜底；uiTextOverrides 是试玩反馈后的界面文案修订（待策划确认，见补丁 _说明）
    uiText: { ...(patch.uiText || {}), ...(raw.uiText || {}), ...noMeta(patch.uiTextOverrides) },
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
    artOverlays: [],                      // [{id, room, show, src}]：美术透明叠加层（1080×1920 贴 (0,0)），见 applyHotspotFile / applyArtOverlayDefs
    artFx: {},                            // 房间 id → 美术热区文件 fx[]（{id, rect, fps, loop, show, onBg}）：按当前背景选特效帧（logic.fxVariant）
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
  applyHotspotPatches(C, patch.hotspots, patch.addHotspots);
  // 在指定效果之间精确插入效果（Pip：开锁音效/字幕；策划日后可原样并入 json，并入后这里自动跳过）
  applyEffectPatches(C, patch.effectPatches);
  // 道具拿走后的背景遮罩（BUGS #2/#3）：[{id, room, req, variants: {bgId: {src, rect}}}]，src 相对 game/
  C.bgOverlays = (patch.bgOverlays || []).filter((o) => o && o.room && o.variants);
  // 心烛扣减原因提示（试玩反馈：扣了心烛不知道为什么）：来源 → 文案
  // chapter1.json v1.3 起收录 sanityReasons：json 优先，补丁/引擎默认兜底（第二章 json 无此字段 → 用默认）
  C.sanityReasons = { ...noMeta(patch.sanityReasons), ...noMeta(raw.sanityReasons) };
  // 谜题解开反馈（BUGS #6）：pz_id → {solvedText}：解开时先在弹窗里显示，再执行 onSolved 的 goto 等
  C.puzzleFeedback = noMeta(patch.puzzleFeedback);
  // 人物表现（补丁 npcPresentation）：mode 'sprite' = 场景里画 NPC 全身立绘、审讯画半身像（旧做法）；
  // 'hotspot' = 不用人物贴图：场景只留可点区域 + 名牌提示 + 字幕，审讯用名牌 + 神色文字。缺省 'sprite'。
  const np = patch.npcPresentation || {};
  C.npcPresentation = { mode: np.mode === 'hotspot' ? 'hotspot' : 'sprite', moodLabels: noMeta(np.moodLabels), tag: np.tag === false ? false : np.tag === true || np.tag === 'always' ? 'always' : 'onTap', tagMs: Number.isFinite(np.tagMs) ? np.tagMs : 2200 };
  C.conclusionOf = {}; // 推理题 id → 所属线索板 id
  for (const [cbId, cb] of Object.entries(C.clueboards)) if (cb.conclusion) C.conclusionOf[cb.conclusion] = cbId;
  return C;
}

/**
 * 补丁 hotspots：{ h_id: { prepend?: [interaction], hideWhen?: req } }。
 * chapter1.json 是权威，不改它的交互，只能：① 在交互表最前面插入“完成后”交互（按顺序首个满足 req 的生效，
 * 所以带完成条件的插入项会盖过 json 里交互前的那条）；② hideWhen 满足时热点隐藏（logic.hotspotHidden）。
 * ③ cantUse 给错用道具的针对性提示。插入的交互带 _patch: true，便于 verify/调试区分来源。
 */
export function applyHotspotPatches(C, hp, add) {
  C.hotspotPatches = [];
  // addHotspots：{ room: [hotspot] }，追加在房间热点表末尾（= 最上层），用来给背景里会被误点的物件一个自己的反应（BUGS #11 壁上烛台）
  for (const [rid, list] of Object.entries(noMeta(add))) {
    const r = C.rooms.find((x) => x.id === rid);
    if (!r) { C.hotspotPatches.push({ id: rid, missing: true }); continue; }
    for (const h0 of list || []) {
      if ((r.hotspots ||= []).some((h) => h.id === h0.id)) continue;
      r.hotspots.push({ ...h0, _patchAdded: true, interactions: (h0.interactions || []).map((it) => ({ ...it, _patch: true })) });
      if (h0.label) C.hotspotLabels[h0.id] = h0.label;
      C.hotspotPatches.push({ id: h0.id, room: rid, added: true });
    }
  }
  for (const [id, p] of Object.entries(noMeta(hp))) {
    let found = null;
    for (const r of C.rooms) for (const h of r.hotspots || []) if (h.id === id) found = { r, h };
    if (!found) { C.hotspotPatches.push({ id, missing: true }); continue; }
    const { r, h } = found;
    if (h._patched) continue; // 同一份数据重复 normalize 时不叠加
    // 去重（策划把补丁并入 json 后，如 chapter1.json v1.3）：json 优先——
    //   json 里已有同一条交互（字段全等，忽略 _ 键）→ 跳过（dup，可删）；
    //   json 里已有同触发条件（useItem/default + req 相同）但内容不同的交互 → 也跳过，以 json 为准（superseded）
    const same = (a, b) => stripMeta(a) === stripMeta(b);
    const trig = (it) => JSON.stringify([it.useItem ?? null, !!it.default, JSON.parse(stripMeta(it.req ?? null))]);
    const jsonIts = h.interactions || [];
    const dup = [], superseded = [], pre = [];
    for (const it of p.prepend || []) {
      if (jsonIts.some((j) => same(j, it))) dup.push(it);
      else if (jsonIts.some((j) => trig(j) === trig(it))) superseded.push(it);
      else pre.push({ ...it, _patch: true });
    }
    if (pre.length) h.interactions = [...pre, ...jsonIts];
    let hideWhen = null;
    if (p.hideWhen) { if (h.hideWhen) hideWhen = same(h.hideWhen, p.hideWhen) ? 'dup' : 'json'; else { h.hideWhen = p.hideWhen; hideWhen = 'patch'; } }
    // cantUse：{ item: textKey }——拿错道具时给针对性的提示，而不是通用的“这里用不上”（BUGS #8）；json 已有的道具以 json 为准
    let cantUse = null;
    if (p.cantUse) {
      const pc = noMeta(p.cantUse), jc = h.cantUse || {};
      cantUse = { dup: Object.keys(pc).filter((k) => k in jc && jc[k] === pc[k]), json: Object.keys(pc).filter((k) => k in jc && jc[k] !== pc[k]), added: Object.keys(pc).filter((k) => !(k in jc)) };
      h.cantUse = { ...pc, ...jc };
    }
    h._patched = true;
    C.hotspotPatches.push({ id, room: r.id, prepend: pre.length, dup: dup.length, superseded: superseded.length, hideWhen: p.hideWhen ? hideWhen : null, cantUse,
      redundant: !pre.length && (!p.hideWhen || hideWhen !== 'patch') && (!cantUse || !cantUse.added.length) });
  }
}

/**
 * 补丁 effectPatches：[{ target, after?, before?, insert: [effect] }]
 *   target：{ hotspot, useItem? | default?: true }（只在 json 原有交互里找，不含补丁 prepend 的）
 *           或 { puzzle | deduction | clueboard: id, field?: 'onSolved' }
 *   after / before：用“字段全等”匹配 effects 里的某一条（after 定位插入点：插在它后面；
 *           before 是校验：插入点后面紧接着必须是它；只给 before 时插在它前面；都不给则追加到末尾）。
 *   insert 里的效果若已在该列表中（策划已并入 json）则跳过，不会重复。
 *   结果记在 C.effectPatchLog（verify 列出；定位失败为 error）。
 */
export function applyEffectPatches(C, list) {
  C.effectPatchLog = [];
  const same = (a, b) => b && Object.entries(b).every(([k, v]) => JSON.stringify(a?.[k]) === JSON.stringify(v));
  const eqEff = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  for (const [n, ep] of (Array.isArray(list) ? list : []).entries()) {
    const t = ep.target || {}, rec = { n, target: t, insert: ep.insert || [] };
    C.effectPatchLog.push(rec);
    let owner = null, field = 'effects', where = '';
    if (t.hotspot) {
      const h = findHotspot(C, t.hotspot);
      const cands = (h?.interactions || []).filter((it) => !it._patch && (t.useItem ? it.useItem === t.useItem : t.default ? it.default : true));
      if (!h) rec.error = `找不到热点 ${t.hotspot}`;
      else if (cands.length !== 1) rec.error = `${t.hotspot} 里匹配 ${JSON.stringify(t)} 的交互有 ${cands.length} 条（需唯一）`;
      else { owner = cands[0]; where = `${t.hotspot}${t.useItem ? `<${t.useItem}` : ''}`; }
    } else {
      const kind = ['puzzle', 'deduction', 'clueboard'].find((k) => t[k]);
      const table = { puzzle: C.puzzles, deduction: C.deductions, clueboard: C.clueboards }[kind];
      owner = kind ? table[t[kind]] : null; field = t.field || 'onSolved'; where = `${kind}:${t[kind]}.${field}`;
      if (!owner) { rec.error = `找不到目标 ${JSON.stringify(t)}`; owner = null; }
    }
    rec.where = where;
    if (!owner) continue;
    const effs = [...(owner[field] || [])];
    const todo = rec.insert.filter((e) => !effs.some((x) => eqEff(x, e)));
    if (!todo.length) { rec.status = 'already'; continue; }
    let at = effs.length;
    if (ep.after) { const i = effs.findIndex((e) => same(e, ep.after)); if (i < 0) { rec.error = `${where} 里找不到 after ${JSON.stringify(ep.after)}`; continue; } at = i + 1; }
    else if (ep.before) { const i = effs.findIndex((e) => same(e, ep.before)); if (i < 0) { rec.error = `${where} 里找不到 before ${JSON.stringify(ep.before)}`; continue; } at = i; }
    if (ep.after && ep.before && !same(effs[at], ep.before)) { rec.error = `${where}：after 后面紧接的不是 before ${JSON.stringify(ep.before)}（json 已变动，请重新确认插入位置）`; continue; }
    effs.splice(at, 0, ...todo.map((e) => ({ ...e, _patch: true })));
    owner[field] = effs;
    rec.status = 'inserted'; rec.at = at; rec.result = effs.map((e) => e.type + (e.id ? `:${e.id}` : e.key ? `:${e.key}` : e.room ? `:${e.room}` : e.set ? `:${e.set}` : e.item ? `:${e.item}` : ''));
  }
}

/**
 * NPC 场景图层（全身站姿 char_<npc>_full）。热区文件应用之后调用。
 * 站姿图：npcs[npc].fullBody（json）→ 补丁 npcLayers[npc].img → char_<npc>_full。
 * 位置优先级：json npcs[npc].rect/room → 美术热区文件 layers（id = 站姿图）→ 补丁 npcLayers[npc] → 该 NPC 审讯入口热点的 rect。
 * 图层只画在画布上，点击判定只看热点 rect，所以立绘永远不会挡住热区点击。
 */
/**
 * 热区收进游戏区（06 §14 自检 / 第二章 #4）：rect 与 PLAY_RECT（y 120–1660）求交。越出部分本来就点不到（顶栏 / 道具栏先吃掉点击），
 * 收进后点击判定、点位计算、debug 框都与实际可点范围一致。原值留在 h.rectRaw，记到 C.rectClamps 给 verify 报 note。
 * 交集为空（整块在游戏区外）不收，留给 verify 报错。
 */
export function clampHotspotsToPlayArea(C, play = PLAY_RECT) {
  const [px, py, pw, ph] = play;
  C.rectClamps = [];
  for (const r of C.rooms) for (const h of r.hotspots || []) {
    if (!Array.isArray(h.rect)) continue;
    const [x, y, w, hh] = h.rect;
    const x0 = Math.max(x, px), y0 = Math.max(y, py), x1 = Math.min(x + w, px + pw), y1 = Math.min(y + hh, py + ph);
    if (x0 === x && y0 === y && x1 === x + w && y1 === y + hh) continue;
    if (x1 <= x0 || y1 <= y0) { C.rectClamps.push({ room: r.id, id: h.id, from: h.rect, to: null }); continue; }
    h.rectRaw ??= h.rect;
    h.rect = [x0, y0, x1 - x0, y1 - y0];
    C.rectClamps.push({ room: r.id, id: h.id, from: h.rectRaw, to: h.rect, keep: +((h.rect[2] * h.rect[3]) / (w * hh)).toFixed(2) });
  }
  return C.rectClamps;
}
/** 美术数据都接好之后的收尾（浏览器 main.js 与 tools/lib.mjs 共用）：热区收进游戏区 → NPC 站位 */
export function finalizeChapter(C) {
  applyNpcArtRects(C);
  clampHotspotsToPlayArea(C);
  resolveNpcLayers(C);
  return C;
}

const npcIdsOf = (C) => new Set([...Object.keys(C.npcs || {}), ...Object.values(C.interrogations || {}).map((i) => i.npc).filter(Boolean)]);
/** 人物的入口热点：打开该 NPC 审讯的热点 */
function npcEntry(C, npc) {
  const intIds = Object.entries(C.interrogations).filter(([, it]) => it.npc === npc).map(([id]) => id);
  for (const r of C.rooms) for (const h of r.hotspots || []) {
    if ((h.interactions || []).some((it) => (it.effects || []).some((e) => e.type === 'open' && e.ui === 'interrogation' && intIds.includes(e.id)))) return { room: r.id, h };
  }
  return null;
}
/**
 * 美术把人物画进背景时给的 rect（C.artNpcRects，来自 art/bg/*_hotspots.json）→ 人物入口热点的 rect 对准画出来的人。
 * 入口热点自己已被同一热区文件按 id 覆盖时以 id 那条为准。之后再统一收进游戏区。
 */
export function applyNpcArtRects(C) {
  for (const [npc, a] of Object.entries(C.artNpcRects || {})) {
    const entry = npcEntry(C, npc);
    if (!entry || entry.room !== a.room) { a.unmatched = entry ? `入口热点在 ${entry.room}` : '没有入口热点'; continue; }
    const byId = (C.hotspotOverrides || []).some((r) => r.room === a.room && r.applied.includes(entry.h.id));
    if (byId) { a.hotspot = entry.h.id; a.byId = true; continue; }
    entry.h.rectDesign ??= entry.h.rect;
    entry.h.rect = [...a.rect];
    a.hotspot = entry.h.id;
  }
}

export function resolveNpcLayers(C) {
  const out = [];
  for (const npc of npcIdsOf(C)) {
    const j = C.npcs[npc] || {}, pl = C.patch.npcLayers?.[npc] || {}, art = C.artNpcRects?.[npc];
    // npcs.*.inScene（06 §14）或美术热区文件给了人物 rect：人物已画进房间背景（在不在场靠 bgVariants），任何模式都不画人物图层，也不回退 char_<npc>_full
    const inScene = j.inScene === true || !!(art && !art.unmatched);
    const img = inScene ? null : j.fullBody ?? pl.img ?? `char_${npc}_full`;
    const entry = npcEntry(C, npc);
    let room = j.room ?? null, rect = Array.isArray(j.rect) ? j.rect : null, src = rect ? '章节 json npcs' : null;
    if (!rect && art && !art.unmatched) { room = art.room; rect = art.rect; src = `美术热区文件 ${art.file}（人物画在背景里）`; }
    if (!rect && img) for (const [rid, layers] of Object.entries(C.artLayers)) {
      const l = layers.find((x) => x.id === img && Array.isArray(x.rect));
      if (l && (!room || room === rid)) { room = rid; rect = l.rect; src = '美术热区文件 layers'; break; }
    }
    if (!rect && Array.isArray(pl.rect)) { room = pl.room ?? room ?? entry?.room; rect = pl.rect; src = '补丁 npcLayers'; }
    if (!rect && entry) { rect = entry.h.rect; src = `热点 ${entry.h.id}`; }
    room ??= pl.room ?? entry?.room ?? null;
    if (!room || !rect) continue;
    out.push({ npc, img, room, rect, src, hotspot: entry?.h.id ?? null, req: j.req ?? pl.req ?? null, ...(inScene ? { inScene } : {}) });
  }
  // 人物不用贴图（npcPresentation.mode = 'hotspot'）：不画立绘，只记下人物所在的可点区域，渲染器在那里画名牌提示
  C.npcSpots = out.map((l) => ({ npc: l.npc, room: l.room, hotspot: l.hotspot, rect: (l.hotspot && findHotspot(C, l.hotspot)?.rect) || l.rect, req: l.req, ...(l.inScene ? { inScene: true } : {}) }));
  C.npcLayers = C.npcPresentation?.mode === 'hotspot' ? [] : out.filter((l) => !l.inScene && l.img);
  return C.npcLayers;
}

const findHotspot = (C, id) => { for (const r of C.rooms) for (const h of r.hotspots || []) if (h.id === id) return h; return null; };

/** loadChapter(readJson, { n: 2 }) 读章节表；也可直接给 url / patchUrl（patchUrl: null = 无补丁） */
export async function loadChapter(readJson, { n = null, url, patchUrl } = {}) {
  const info = chapterInfo(n ?? 1) ?? CHAPTERS[0];
  url ??= info.url;
  if (patchUrl === undefined) patchUrl = info.patch;
  const raw = await readJson(url);
  let patch = {}, defaults = {};
  if (patchUrl) try { patch = await readJson(patchUrl); } catch { /* 无补丁也能跑 */ }
  try { defaults = await readJson(DEFAULTS_URL); } catch { /* 无默认也能跑 */ }
  defaults = await withSeriesFallbacks(readJson, raw, defaults);
  return normalizeChapter(raw, mergePatch(defaults, patch));
}

/**
 * 跨章兜底（最低优先级，低于补丁和本章 json）：本章 json 没写 sanityReasons（第二章 v2.1）时，沿用第一章 json 的
 * 顶层 sanityReasons（v1.3 起由策划维护，文案按界面类型、不含章节内容）。engine-defaults 不再存这份文案。
 */
export async function withSeriesFallbacks(readJson, raw, defaults = {}) {
  if (raw?.sanityReasons || defaults?.sanityReasons || (raw?.meta?.chapter ?? 1) === 1) return defaults;
  try { const c1 = await readJson(CHAPTERS[0].url); if (c1?.sanityReasons) return { ...defaults, sanityReasons: c1.sanityReasons }; } catch { /* 读不到就没有原因提示 */ }
  return defaults;
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
  // 文件写明了 room 但不是本章的房间（如第一章加载时遇到 r4~r6 的热区文件）：属于别的章节，跳过（verify 记为提示，不算问题）
  if (!room && data && !Array.isArray(data) && typeof (data.room ?? data.roomId) === 'string') { rec.otherChapter = data.room ?? data.roomId; return rec; }
  // 文件没写 room（06 §14 自检提到的第一章 3 个文件）：按文件名 bg_<房间 id>_hotspots.json 推断；推断出的房间不在本章 → 别的章节
  if (!room) { const m = /(?:^|\/)bg_(r\d+_[a-z0-9]+)_hotspots\.json$/i.exec(relPath); if (m) rec.otherChapter = m[1]; return rec; }
  if (data && !Array.isArray(data) && !(data.room ?? data.roomId)) rec.roomInferred = true;
  if (data && !Array.isArray(data)) {
    if (Array.isArray(data.layers)) (C.artLayers ??= {})[room] = data.layers;
    if (Array.isArray(data.fakeHotspots)) (C.artFakeHotspots ??= {})[room] = data.fakeHotspots;
    // 叠加层：{id, file:'art/bg/ovl_xxx.png', show:{flags|notFlags|sanityBelow|any}}，整幅 1080×1920 贴 (0,0)
    for (const o of Array.isArray(data.overlays) ? data.overlays : []) addArtOverlay(C, { ...o, room }, `热区文件 ${relPath}`);
    // 特效差分：{id, frames, rect, fps, show, onBg:[背景 id]}；显示条件仍以章节 json rooms[].fx 为准，这里只决定画哪套帧/rect
    if (Array.isArray(data.fx)) (C.artFx ??= {})[room] = data.fx.filter((f) => f?.id).map((f) => ({ id: f.id, rect: toRect(f.rect), fps: f.fps, loop: f.loop, show: f.show ?? null, onBg: Array.isArray(f.onBg) ? f.onBg : null, specRect: f.specRect ?? null }));
  }
  const hs = C.roomById[room].hotspots || [];
  // 人物画在背景里（Vicente：人物保留，不单独贴立绘）：美术在热区文件里给人物 rect——hotspots 条目带 npc 字段，
  // 或 id 为 <npc> / npc_<npc> / char_<npc>[_full]，或 npcs:{<npc>: rect}。记到 C.artNpcRects，finalize 时对准该人物的入口热点
  const npcOf = (id) => { const n = String(id).replace(/^(h_|npc_|char_)/, '').replace(/_full$/, ''); return npcIdsOf(C).has(n) ? n : null; };
  const setNpc = (npc, rect, id) => { (C.artNpcRects ??= {})[npc] = { room, rect, file: relPath, id }; (rec.npcs ??= []).push(npc); };
  if (data && !Array.isArray(data) && data.npcs && typeof data.npcs === 'object') for (const [n, v] of Object.entries(data.npcs)) { const r = toRect(v); if (r && npcIdsOf(C).has(n)) setNpc(n, r, n); }
  for (const e of Array.isArray(data) ? data : Array.isArray(data?.hotspots) ? data.hotspots : []) if (e?.npc && npcIdsOf(C).has(e.npc) && toRect(e)) setNpc(e.npc, toRect(e), e.id ?? e.npc);
  // 美术热区文件 npcInScene:[{npc, hotspot, rect, variants, show}] 与 layers:[{id:'char_<npc>_full', rect, inScene:true}] 同义
  for (const e of Array.isArray(data?.npcInScene) ? data.npcInScene : []) if (e?.npc && npcIdsOf(C).has(e.npc) && toRect(e.rect) && !C.artNpcRects?.[e.npc]) setNpc(e.npc, toRect(e.rect), e.hotspot ?? e.npc);
  for (const l of Array.isArray(data?.layers) ? data.layers : []) if (l?.inScene && npcOf(l.id) && toRect(l.rect) && !C.artNpcRects?.[npcOf(l.id)]) setNpc(npcOf(l.id), toRect(l.rect), l.id);
  // 美术给了 suggestedRect（rect 按成图实测、越出游戏区时的建议可点范围）：rect 越界就用 suggestedRect；仍越界的之后统一 clamp
  const sugg = {};
  for (const e of Array.isArray(data) ? data : Array.isArray(data?.hotspots) ? data.hotspots : []) if (e?.id && toRect(e.suggestedRect)) sugg[e.id] = toRect(e.suggestedRect);
  const outOfPlay = ([x, y, w, hh]) => x < PLAY_RECT[0] || y < PLAY_RECT[1] || x + w > PLAY_RECT[0] + PLAY_RECT[2] || y + hh > PLAY_RECT[1] + PLAY_RECT[3];
  for (let [id, rect] of Object.entries(parseHotspotFile(data))) {
    if (sugg[id] && outOfPlay(rect)) { (rec.suggested ??= []).push({ id, from: rect, to: sugg[id] }); rect = sugg[id]; }
    const h = hs.find((x) => x.id === id || x.id === `h_${id}`);
    if (!h && npcOf(id)) { if (!C.artNpcRects?.[npcOf(id)]) setNpc(npcOf(id), rect, id); continue; }
    if (!h) { rec.unknown.push(id); continue; }
    if (JSON.stringify(h.rect) === JSON.stringify(rect)) { (rec.same ??= []).push(h.id); continue; }
    h.rectDesign ??= h.rect;
    h.rect = rect;
    rec.applied.push(h.id);
  }
  return rec;
}

// ---------- 美术叠加层（ovl_*.png） ----------
/** 叠加层 id：显式 id → layer → 文件名 */
const ovlId = (o) => o.id ?? o.layer ?? String(o.file || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '');

function addArtOverlay(C, o, from) {
  const id = ovlId(o);
  if (!id || !o.room || !C.roomById[o.room]) return null;
  const list = (C.artOverlays ??= []);
  let e = list.find((x) => x.id === id);
  if (!e) { e = { id, room: o.room, show: o.show ?? null, file: o.file ?? null, bbox: o.bbox ?? null, from: [from] }; list.push(e); }
  else { e.from.push(from); e.show ??= o.show ?? null; e.file ??= o.file ?? null; e.bbox ??= o.bbox ?? null; if (o.show && JSON.stringify(o.show) !== JSON.stringify(e.show)) (e.conflicts ??= []).push({ from, show: o.show }); }
  // 美术正式的“道具已拿走”差分：ovl_<房间前缀>_<遮罩 id>_taken（或显式 replaces）→ 停用补丁 bgOverlays 里同房间同 id 的临时遮罩
  const m = /^ovl_(r\d+)_(.+)_taken$/.exec(id);
  const repl = o.replaces ?? (m && o.room.startsWith(`${m[1]}_`) ? m[2] : null);
  if (repl) for (const b of C.bgOverlays || []) if (b.room === o.room && b.id === repl) { b.replacedBy = id; e.replaces = repl; }
  return e;
}

/**
 * 美术 manifest（art/**\/manifest.json 的 assets[]）里带 layer + show 的条目也登记为叠加层（与热区文件 overlays[] 按 id 合并）。
 * defs 由 tools/scan-assets.mjs 汇总进 assets-manifest.json 的 overlayDefs（浏览器）或 lib.readArtOverlayDefs（Node）。
 */
export function applyArtOverlayDefs(C, defs = []) {
  for (const d of defs) if (d && (d.layer || d.id) && d.show && d.room && C.roomById[d.room]) addArtOverlay(C, d, d.source ?? 'art manifest');
  return C.artOverlays;
}
