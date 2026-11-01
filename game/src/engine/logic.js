// 纯逻辑层：直接执行 chapter1.json 的 req / effects / interactions / 线索板 / 审讯 / 推理 / 心烛。
// 无 DOM 依赖，浏览器运行时与 tools/verify.mjs（状态搜索）共用同一份代码，保证“验证的就是实际跑的”。
//
// 所有会改状态的函数都直接修改 S，并返回 events 数组交给表现层：
//   {type:'text', text} {type:'sfx', id} {type:'open', ui, id} {type:'goto', room}
//   {type:'cutscene', id} {type:'sanity', delta, value} {type:'give', item} {type:'take', item}
//   {type:'evidence', id} {type:'note', text} {type:'hint', ...} {type:'restore', point, ok, remain}
import { resolveText } from './chapter.js';

export const EFFECT_TYPES = ['give', 'take', 'flag', 'evidence', 'sanity', 'text', 'goto', 'open', 'sfx', 'restore', 'note', 'cutscene', 'hint'];
export const UI_TYPES = ['interrogation', 'puzzle', 'clueboard', 'deduction', 'notebook', 'item', 'closeup']; // 06 §10 open.ui（v1.2 加 closeup）

export function createState(C) {
  const start = C.meta.start ?? C.rooms[0]?.id;
  return {
    room: start, visited: [start],
    inventory: [], flags: {}, evidence: [], notes: [],
    sanity: C.sanity.start ?? 100,
    cooldowns: {},   // 回复点/道具 id → 冷却结束时刻（ms 时间戳）
    solved: [],      // 已解谜题 / 推理 id
    once: {},        // once:true 的心烛扣减记录：`${来源}#${effect序号}`
    interrogations: {}, // id → { broken: [statementId] }
    clueboards: {},  // id → { links: [linkId] }
    ended: false,
  };
}
export const cloneState = (S) => JSON.parse(JSON.stringify(S));

// ---------- 条件 ----------
/** req: { items:[], flags:[], notFlags:[], evidence:[] }，全部满足才为真；缺省为真 */
export function reqOk(S, req) {
  if (!req) return true;
  if (req.items && !req.items.every((i) => S.inventory.includes(i))) return false;
  if (req.flags && !req.flags.every((f) => S.flags[f])) return false;
  if (req.notFlags && req.notFlags.some((f) => S.flags[f])) return false;
  if (req.evidence && !req.evidence.every((e) => S.evidence.includes(e))) return false;
  return true;
}
export const REQ_KEYS = ['items', 'flags', 'notFlags', 'evidence'];
/** 06 §12：{req?, sanityBelow?} 两者都满足（缺省为真）；sanityBelow N = 当前心烛 < N */
export const condOk = (S, c) => reqOk(S, c?.req) && (c?.sanityBelow == null || S.sanity < c.sanityBelow);

// ---------- 特写 / 房间特效（06 §12，纯表现，不改状态） ----------
/** 打开特写那一刻的画面：states 取第一条满足的（都不满足取最后一条），overlays 取全部满足的，pages 原样 */
export function closeupView(C, S, id) {
  const cu = C.closeups?.[id];
  if (!cu) return null;
  const states = cu.states || [];
  const st = states.find((x) => condOk(S, x)) ?? states[states.length - 1] ?? {};
  return { title: cu.title ?? id, state: st, stateIndex: states.indexOf(st),
    overlays: (cu.overlays || []).filter((o) => condOk(S, o)).map((o) => o.img), pages: cu.pages || [] };
}
/** 当前房间应显示的特效：同 id 多条按 OR 合并、只画一次（取第一条满足的条目的 rect/fps/loop） */
export function roomFxActive(C, S, roomId = S.room) {
  const out = new Map();
  for (const f of C.roomById[roomId]?.fx || []) if (!out.has(f.id) && condOk(S, f)) out.set(f.id, f);
  return [...out.values()];
}

// ---------- 心烛 ----------
export function clampSanity(C, v) {
  const { floor = 20, max = 100 } = C.sanity;
  return Math.max(floor, Math.min(max, v));
}
export function tierOf(C, v) {
  const tiers = [...(C.sanity.tiers || [])].sort((a, b) => b.min - a.min);
  return tiers.find((t) => v >= t.min) ?? tiers[tiers.length - 1] ?? { id: 's1', min: 0, fx: [] };
}
export const tierHas = (C, S, fx) => (tierOf(C, S.sanity).fx || []).includes(fx);

function changeSanity(C, S, delta, events) {
  const before = S.sanity;
  S.sanity = clampSanity(C, S.sanity + delta);
  if (S.sanity !== before || delta) events.push({ type: 'sanity', delta: S.sanity - before, requested: delta, value: S.sanity });
}

function restore(C, S, pointId, delta, cooldownSec, now, events) {
  const until = S.cooldowns[pointId] ?? 0;
  if (now < until) {
    events.push({ type: 'restore', point: pointId, ok: false, remain: Math.ceil((until - now) / 1000) });
    return;
  }
  S.cooldowns[pointId] = now + (cooldownSec ?? 60) * 1000;
  events.push({ type: 'restore', point: pointId, ok: true });
  changeSanity(C, S, delta, events);
}

// ---------- 效果 ----------
/**
 * 执行 effects 数组。ctx.source 用于 once 记录（热点 id / 谜题 id 等）；ctx.now 为当前时间（冷却用）。
 */
export function runEffects(C, S, effects = [], ctx = {}) {
  const events = [];
  const now = ctx.now ?? Date.now();
  effects.forEach((e, idx) => {
    switch (e.type) {
      case 'give':
        if (!S.inventory.includes(e.item)) { S.inventory.push(e.item); events.push({ type: 'give', item: e.item }); }
        break;
      case 'take':
        if (S.inventory.includes(e.item)) { S.inventory = S.inventory.filter((i) => i !== e.item); events.push({ type: 'take', item: e.item }); }
        break;
      case 'flag':
        if (e.set) S.flags[e.set] = true;
        if (e.clear) delete S.flags[e.clear];
        break;
      case 'evidence':
        if (!S.evidence.includes(e.add)) { S.evidence.push(e.add); events.push({ type: 'evidence', id: e.add }); }
        break;
      case 'sanity': {
        if (e.once) {
          const key = `${ctx.source ?? '?'}#${idx}`;
          if (S.once[key]) break;
          S.once[key] = true;
        }
        changeSanity(C, S, e.delta ?? 0, events);
        break;
      }
      case 'restore': {
        const p = C.sanity.restorePoints?.[e.point];
        if (p) restore(C, S, e.point, p.delta, p.cooldownSec, now, events);
        break;
      }
      case 'text': events.push({ type: 'text', key: e.key, text: resolveText(C, e.key) }); break;
      case 'note':
        // 06 §10：未记录过才追加并发事件
        if (!S.notes.includes(e.add)) { S.notes.push(e.add); events.push({ type: 'note', text: e.add }); }
        break;
      case 'goto': if (C.roomById[e.room]) { gotoRoom(C, S, e.room); events.push({ type: 'goto', room: e.room }); } break; // 06 §10：房间不存在则忽略
      case 'open': events.push({ type: 'open', ui: e.ui, id: e.id }); break;
      case 'sfx': events.push({ type: 'sfx', id: e.id }); break;
      case 'cutscene':
        if (e.id === C.ending) S.ended = true;
        events.push({ type: 'cutscene', id: e.id });
        break;
      case 'hint': events.push({ type: 'hint', mode: e.mode, ...ctx.hint }); break;
      default: events.push({ type: 'unknown', effect: e });
    }
  });
  return events;
}

export function gotoRoom(C, S, room) {
  if (!C.roomById[room]) return;
  S.room = room;
  if (!S.visited.includes(room)) S.visited.push(room);
}

/** 底部左右箭头：rooms 数组里相邻且已到访过的房间（R1⇄R2⇄R3） */
export function navTargets(C, S) {
  const i = C.rooms.findIndex((r) => r.id === S.room);
  const prev = C.rooms[i - 1], next = C.rooms[i + 1];
  return {
    prev: prev && S.visited.includes(prev.id) ? prev.id : null,
    next: next && S.visited.includes(next.id) ? next.id : null,
  };
}

// ---------- 热点 ----------
/** 按顺序匹配：选中道具时找 useItem===道具 的交互；否则找 default 交互。都要满足 req。 */
export function matchInteraction(S, hotspot, item = null) {
  for (const it of hotspot.interactions || []) {
    if (!reqOk(S, it.req)) continue;
    if (item ? it.useItem === item : it.default) return it;
  }
  return null;
}
/** 热点当前是否“有反应”（有任何满足 req 的交互）。没有反应的热点在点击时视为透明，点击落到下层热点。 */
export const hotspotActive = (S, h) => (h.interactions || []).some((it) => reqOk(S, it.req));

export const room = (C, S) => C.roomById[S.room];

/** 点在逻辑坐标 (x,y) 上的热点，从上到下（数组后面的在上层），只返回“有反应”的 */
export function hotspotsAt(C, S, x, y) {
  const r = room(C, S);
  return (r?.hotspots || []).filter((h) => inRect(h.rect, x, y) && hotspotActive(S, h)).reverse();
}
export const inRect = ([rx, ry, rw, rh], x, y) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;

/**
 * 点击热点（可带选中道具）。返回 { ok, events }。
 * ok=false 表示该道具在此处无效（表现层给出“用不上”提示）。
 */
export function interact(C, S, hotspotId, item = null, now) {
  const r = room(C, S);
  const h = r?.hotspots.find((x) => x.id === hotspotId);
  if (!h) return { ok: false, events: [] };
  const it = matchInteraction(S, h, item);
  if (!it) return { ok: false, events: [] };
  const events = runEffects(C, S, it.effects, { source: `${r.id}/${h.id}`, now });
  // 心烛 <below 时的隐藏文字
  for (const rv of C.sanity.lowSanityReveals || []) {
    if (rv.room === r.id && rv.hotspot === h.id && S.sanity < rv.below) events.push({ type: 'text', text: rv.text, reveal: true });
  }
  return { ok: true, events };
}

/** 在 (x,y) 点击：选中道具时，取最上层能接受该道具的热点；否则取最上层有 default 交互的热点 */
export function tapAt(C, S, x, y, item = null, now) {
  const hs = hotspotsAt(C, S, x, y);
  if (!hs.length) return { hit: null, ok: false, events: [] };
  if (item) {
    const h = hs.find((h) => matchInteraction(S, h, item));
    if (h) return { hit: h.id, ...interact(C, S, h.id, item, now) };
    return { hit: hs[0].id, ok: false, events: [] };
  }
  const h = hs.find((h) => matchInteraction(S, h, null));
  if (!h) return { hit: hs[0].id, ok: false, events: [] };
  return { hit: h.id, ...interact(C, S, h.id, null, now) };
}

// ---------- 道具 ----------
export function findRecipe(C, a, b) {
  return C.combine.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a)) ?? null;
}
/** 道具对道具使用的谜题（type: use_on_item），如【布伦丹的眼镜】读【半份契约】 */
export function findItemPuzzle(C, S, a, b) {
  for (const [id, p] of Object.entries(C.puzzles)) {
    if (p.type !== 'use_on_item' || S.solved.includes(id)) continue;
    if ((p.item === a && p.with === b) || (p.item === b && p.with === a)) return id;
  }
  return null;
}
/** 组合两个道具：先查 combine 配方，再查 use_on_item 谜题。返回 events 或 null（组合不了） */
export function combineItems(C, S, a, b, now) {
  if (!S.inventory.includes(a) || !S.inventory.includes(b) || a === b) return null;
  const r = findRecipe(C, a, b);
  if (r) {
    const consume = r.consume ?? [a, b];
    S.inventory = S.inventory.filter((i) => !consume.includes(i));
    const events = consume.map((i) => ({ type: 'take', item: i }));
    events.push(...runEffects(C, S, [{ type: 'give', item: r.result }, ...(r.effects || [])], { source: `combine:${r.result}`, now }));
    events.push({ type: 'combined', result: r.result });
    return events;
  }
  const pz = findItemPuzzle(C, S, a, b);
  if (pz) return solvePuzzle(C, S, pz, now);
  return null;
}
/** 道具自身的“使用”（如完整的念珠：心烛 +15，冷却 90 秒） */
export function useItemSelf(C, S, itemId, now = Date.now()) {
  const u = C.items[itemId]?.use;
  if (!u || !S.inventory.includes(itemId)) return null;
  const events = [];
  if (u.sanity) restore(C, S, `item:${itemId}`, u.sanity, u.cooldownSec, now, events);
  return events;
}

// ---------- 谜题 ----------
export function solvePuzzle(C, S, id, now) {
  const p = C.puzzles[id];
  if (!p || S.solved.includes(id)) return [];
  S.solved.push(id);
  return [{ type: 'solved', id }, ...runEffects(C, S, p.onSolved, { source: `puzzle:${id}`, now })];
}

// ---------- 审讯 ----------
export function intState(S, id) { return (S.interrogations[id] ??= { broken: [] }); }
/** 当前可见证词（requires 的前置证词都已拆穿） */
export function availableStatements(C, S, id) {
  const it = C.interrogations[id];
  const st = S.interrogations[id]?.broken ?? [];
  return (it?.statements || []).filter((s) => (s.requires || []).every((r) => st.includes(r)));
}
export function intDone(C, S, id) {
  const it = C.interrogations[id];
  const st = S.interrogations[id]?.broken ?? [];
  return (it?.statements || []).filter((s) => s.lie).every((s) => st.includes(s.id));
}
/** 玩家手里是否已有能拆穿这条证词的证据（界面上的“？”提示） */
export const hasAcceptEvidence = (S, stmt) => (stmt.accept || []).some((e) => S.evidence.includes(e));

/**
 * 出示证据。返回 { result: 'break'|'nearMiss'|'wrong'|'invalid', events, complete }
 */
export function presentEvidence(C, S, intId, stmtId, evId, now) {
  const it = C.interrogations[intId];
  const stmt = availableStatements(C, S, intId).find((s) => s.id === stmtId);
  const st = intState(S, intId);
  if (!it || !stmt || st.broken.includes(stmtId) || !S.evidence.includes(evId)) return { result: 'invalid', events: [] };
  if (stmt.lie && (stmt.accept || []).includes(evId)) {
    st.broken.push(stmtId);
    const events = [{ type: 'break', statement: stmtId, text: resolveText(C, stmt.onBreak?.text), portrait: stmt.onBreak?.portrait }];
    const complete = intDone(C, S, intId);
    if (complete) events.push(...runEffects(C, S, it.onComplete, { source: `int:${intId}:complete`, now }));
    return { result: 'break', events, complete };
  }
  if (stmt.nearMiss?.[evId]) return { result: 'nearMiss', events: [{ type: 'text', text: resolveText(C, stmt.nearMiss[evId]) }] };
  return { result: 'wrong', events: runEffects(C, S, it.onWrongEvidence, { source: `int:${intId}:wrong`, now }) };
}

// ---------- 线索板 ----------
export const cbUnlocked = (C, S, id) => reqOk(S, C.clueboards[id]?.unlock);
export function cbState(S, id) { return (S.clueboards[id] ??= { links: [] }); }
export function cbFindLink(C, id, a, b) {
  return (C.clueboards[id]?.links || []).find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a)) ?? null;
}
export function cbAllLinked(C, S, id) {
  const done = S.clueboards[id]?.links ?? [];
  return (C.clueboards[id]?.links || []).every((l) => done.includes(l.id));
}
/** 为一条连线选择关系标签。返回 { ok, events, allLinked } */
export function cbChoose(C, S, id, linkId, option, now) {
  const cb = C.clueboards[id];
  const link = cb?.links.find((l) => l.id === linkId);
  if (!link || !cbUnlocked(C, S, id)) return { ok: false, events: [] };
  const st = cbState(S, id);
  if (st.links.includes(linkId)) return { ok: true, events: [], allLinked: cbAllLinked(C, S, id) };
  if (option === link.answer) {
    st.links.push(linkId);
    const allLinked = cbAllLinked(C, S, id);
    const events = [{ type: 'linked', link: linkId }];
    // 没有 conclusion 的线索板：连完即完成
    if (allLinked && !cb.conclusion) events.push(...finishClueboard(C, S, id, now));
    return { ok: true, events, allLinked };
  }
  return { ok: false, events: runEffects(C, S, cb.onWrongLink, { source: `cb:${id}:wrong`, now }) };
}
function finishClueboard(C, S, id, now) {
  if (S.solved.includes(id)) return [];
  S.solved.push(id);
  return runEffects(C, S, C.clueboards[id].onSolved, { source: `cb:${id}`, now });
}

// ---------- 推理 ----------
/** 推理是否可作答：有 req 的看 req；作为线索板结论的，要求线索板全部连完 */
export function ddAvailable(C, S, id) {
  const d = C.deductions[id];
  if (!d || S.solved.includes(id)) return false;
  if (!reqOk(S, d.req)) return false;
  const cb = C.conclusionOf[id];
  if (cb && !cbAllLinked(C, S, cb)) return false;
  return true;
}
/** 提交答案数组。返回 { ok, firstWrong, events } */
export function ddSubmit(C, S, id, answers, now) {
  const d = C.deductions[id];
  if (!ddAvailable(C, S, id)) return { ok: false, firstWrong: -1, events: [] };
  const firstWrong = d.questions.findIndex((q, i) => answers[i] !== q.answer);
  if (firstWrong === -1) {
    S.solved.push(id);
    const events = [{ type: 'solved', id }, ...runEffects(C, S, d.onSolved, { source: `dd:${id}`, now })];
    const cb = C.conclusionOf[id];
    if (cb) events.push(...finishClueboard(C, S, cb, now));
    return { ok: true, firstWrong: -1, events };
  }
  const q = d.questions[firstWrong];
  const events = runEffects(C, S, d.onWrong, { source: `dd:${id}:wrong`, now, hint: { question: firstWrong, text: q.hint ? resolveText(C, q.hint) : '' } });
  return { ok: false, firstWrong, events };
}

// ---------- 章节切换 ----------
/** 进入新章节时心烛回到至少 chapterResetMin */
export function chapterReset(C, S) {
  S.sanity = clampSanity(C, Math.max(S.sanity, C.sanity.chapterResetMin ?? 70));
}

// ---------- 点击坐标（自动测试 / verify 用） ----------
/**
 * 找一个逻辑坐标点：点下去 tapAt 恰好命中 hotspotId（考虑上层热点遮挡、透明热点），且落在 playRect 内。
 * 找不到返回 null（说明该交互在当前状态下点不到 → 设计问题）。
 */
export function pointFor(C, S, hotspotId, item = null, playRect = null) {
  const h = room(C, S)?.hotspots.find((x) => x.id === hotspotId);
  if (!h) return null;
  const [x0, y0, w, h0] = h.rect;
  const pr = playRect ?? [0, 0, Infinity, Infinity];
  const cands = [];
  const step = 12;
  for (let y = y0 + 2; y <= y0 + h0 - 2; y += step) for (let x = x0 + 2; x <= x0 + w - 2; x += step) {
    if (!inRect(pr, x, y)) continue;
    const hs = hotspotsAt(C, S, x, y);
    const target = item ? hs.find((t) => matchInteraction(S, t, item)) : hs.find((t) => matchInteraction(S, t, null));
    if (target?.id === hotspotId) cands.push([x, y]);
  }
  if (!cands.length) return null;
  // 取离可点区域“质心”最近的点，远离边缘
  const cx = cands.reduce((a, p) => a + p[0], 0) / cands.length, cy = cands.reduce((a, p) => a + p[1], 0) / cands.length;
  cands.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  return { x: Math.round(cands[0][0]), y: Math.round(cands[0][1]), area: cands.length * step * step };
}
