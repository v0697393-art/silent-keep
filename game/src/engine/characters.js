// 角色立绘/头像 id 规则（art/characters/manifest.json，design/04 §4–5）：
//   半身 char_<npc>_<state>（1024×1536）  对话头像 char_<npc>_<state>_portrait_384  手记头像 char_<npc>_avatar_256  全身 char_<npc>_full
//   侦探 edric 6 表情 neutral/think/press/wry/shaken/relief × 心烛三档（s1 无后缀，s2 → _s2，s3 → _s3）
import { tierOf } from './logic.js';

export const EDRIC_EXPR = ['neutral', 'think', 'press', 'wry', 'shaken', 'relief'];
export const tierSuffix = (C, sanity) => { const t = tierOf(C, sanity).id; return t && t !== 's1' ? `_${t}` : ''; };

/** 侦探表情 → 候选 id（先当前心烛档，再退回 s1，再退回 neutral） */
export function edricIds(C, sanity, expr = 'neutral', { avatar = false } = {}) {
  const suf = tierSuffix(C, sanity), e = EDRIC_EXPR.includes(expr) ? expr : 'neutral';
  const base = [...new Set([`char_edric_${e}${suf}`, `char_edric_${e}`, `char_edric_neutral${suf}`, 'char_edric_neutral'])];
  return avatar ? base.flatMap((b) => [`${b}_portrait_384`, b]) : base;
}
/** 审讯 NPC：chapter1.json portraits 里的 id（如 char_osbert_calm）→ 立绘 / 头像候选 */
export function npcIds(portraitId, { avatar = false } = {}) {
  return avatar ? [`${portraitId}_portrait_384`, portraitId] : [portraitId];
}
export const npcAvatar256 = (npc) => `char_${npc}_avatar_256`;
