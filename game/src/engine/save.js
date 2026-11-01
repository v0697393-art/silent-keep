// 本地存档（localStorage）。存的是 logic.js 的状态对象 S，读档时按当前章节数据校验/补齐，坏档直接丢弃。
import { createState } from './logic.js';

export const SAVE_KEY = 'hushwold_save_v1';
const store = () => { try { return window.localStorage; } catch { return null; } };

export function saveGame(C, S) {
  try {
    store()?.setItem(SAVE_KEY, JSON.stringify({ v: 1, chapter: C.meta.chapter ?? 1, dataVersion: C.meta.version ?? null, savedAt: Date.now(), state: S }));
    return true;
  } catch { return false; }
}

export function hasSave(C) { return !!loadGame(C); }

/** 读档并校验；返回状态或 null */
export function loadGame(C) {
  let data;
  try { data = JSON.parse(store()?.getItem(SAVE_KEY) || 'null'); } catch { return null; }
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

export function clearSave() { try { store()?.removeItem(SAVE_KEY); } catch { /* ignore */ } }

/** 静音等偏好设置（与存档分开） */
export const prefs = {
  get(k, d) { try { const v = store()?.getItem('hushwold_pref_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { store()?.setItem('hushwold_pref_' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
