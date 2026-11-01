// 本地存档（localStorage）。存的是 logic.js 的状态对象 S，读档时按当前章节数据校验/补齐，坏档直接丢弃。
import { createState } from './logic.js';

// 按章分键（06 §13.1）：第一章继续用旧键 hushwold_save_v1（兼容已上线的存档），第 n 章用 hushwold_save_v1_ch<n>；
// 另存 hushwold_progress = {maxChapter, sanity}：标题页“继续”默认进哪一章、章节衔接时继承的心烛。
export const SAVE_KEY = 'hushwold_save_v1';
export const PROGRESS_KEY = 'hushwold_progress';
export const chapterOf = (C) => C?.meta?.chapter ?? 1;
export const saveKey = (n = 1) => (Number(n) === 1 ? SAVE_KEY : `${SAVE_KEY}_ch${n}`);
const store = () => { try { return window.localStorage; } catch { return null; } };
const readJson = (k) => { try { return JSON.parse(store()?.getItem(k) || 'null'); } catch { return null; } };

export function saveGame(C, S) {
  try {
    store()?.setItem(saveKey(chapterOf(C)), JSON.stringify({ v: 1, chapter: chapterOf(C), dataVersion: C.meta.version ?? null, savedAt: Date.now(), state: S }));
    return true;
  } catch { return false; }
}

export function hasSave(C) { return !!loadGame(C); }

/**
 * 进度：{maxChapter, sanity}。没有进度键时从旧存档推断（兼容只有第一章存档的老玩家）：
 * 旧键里的第一章档已 ended → 视为可进第二章（maxChapter 2，心烛取档里的值）；否则 maxChapter 1。都没有返回 null。
 */
export function getProgress() {
  const p = readJson(PROGRESS_KEY);
  if (p && Number.isFinite(p.maxChapter)) return { maxChapter: p.maxChapter, sanity: Number.isFinite(p.sanity) ? p.sanity : null, ...(p.cleared ? { cleared: p.cleared } : {}), ...(p.starts ? { starts: p.starts } : {}) };
  const old = readJson(SAVE_KEY);
  if (old?.state && (old.chapter ?? 1) === 1) return { maxChapter: old.state.ended ? 2 : 1, sanity: Number.isFinite(old.state.sanity) ? old.state.sanity : null, legacy: true };
  return null;
}
/** 只往前推：maxChapter 取较大值；sanity 记最近一次（章节衔接时用） */
export function setProgress({ maxChapter, sanity, cleared, start } = {}) {
  const cur = readJson(PROGRESS_KEY) || {};
  const next = { maxChapter: Math.max(cur.maxChapter ?? 1, maxChapter ?? 1), sanity: Number.isFinite(sanity) ? sanity : cur.sanity ?? null };
  // start：{章: 开局心烛}——“重新开始本章”时沿用进入该章时继承的心烛
  const starts = { ...(cur.starts || {}), ...(start || {}) };
  if (Object.keys(starts).length) next.starts = starts;
  const cl = [...new Set([...(cur.cleared || []), ...(cleared != null ? [cleared] : [])])];
  if (cl.length) next.cleared = cl;
  try { store()?.setItem(PROGRESS_KEY, JSON.stringify(next)); return true; } catch { return false; }
}

/** 读档并校验；返回状态或 null */
export function loadGame(C) {
  const data = readJson(saveKey(chapterOf(C)));
  if (!data || data.v !== 1 || !data.state) return null;
  if (data.chapter != null && C.meta.chapter != null && data.chapter !== C.meta.chapter) return null;
  const s = data.state, base = createState(C);
  if (!C.roomById[s.room]) return null;
  const arr = (a, ok) => (Array.isArray(a) ? a.filter(ok) : []);
  return {
    ...base,
    room: s.room,
    visited: arr(s.visited, (r) => C.roomById[r]),
    inventory: arr(s.inventory, (i) => C.items[i]),
    flags: typeof s.flags === 'object' && s.flags ? s.flags : {},
    evidence: arr(s.evidence, (e) => C.evidence[e]),
    notes: arr(s.notes, (n) => typeof n === 'string'),
    sanity: Number.isFinite(s.sanity) ? Math.max(C.sanity.floor ?? 20, Math.min(C.sanity.max ?? 100, s.sanity)) : base.sanity,
    cooldowns: s.cooldowns && typeof s.cooldowns === 'object' ? s.cooldowns : {},
    solved: arr(s.solved, (x) => typeof x === 'string'),
    once: s.once && typeof s.once === 'object' ? s.once : {},
    interrogations: s.interrogations && typeof s.interrogations === 'object' ? s.interrogations : {},
    clueboards: s.clueboards && typeof s.clueboards === 'object' ? s.clueboards : {},
    seen: arr(s.seen, (x) => typeof x === 'string'), // 旧档没有 seen：按“都没看过”处理，只影响重复点击时的台词
    ended: !!s.ended,
  };
}

/** clearSave(C) 只清该章的档；clearSave() / clearSave('all') 清全部章节存档 + 进度（标题页“新的调查”从第一章重开） */
export function clearSave(C = 'all') {
  try {
    const st = store(); if (!st) return;
    if (C && C !== 'all') { st.removeItem(saveKey(chapterOf(C))); return; }
    const keys = []; for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k === SAVE_KEY || k?.startsWith(`${SAVE_KEY}_ch`) || k === PROGRESS_KEY) keys.push(k); }
    for (const k of keys) st.removeItem(k);
  } catch { /* ignore */ }
}

/** 静音等偏好设置（与存档分开） */
export const prefs = {
  get(k, d) { try { const v = store()?.getItem('hushwold_pref_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { store()?.setItem('hushwold_pref_' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
