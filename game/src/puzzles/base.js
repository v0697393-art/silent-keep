import { Modal } from '../ui/modal.js';
import { el } from '../ui/dom.js';
import { solvePuzzle, reqOk } from '../engine/logic.js';

export class PuzzleBase extends Modal {
  constructor(game, id) {
    super(game, { type: 'puzzle', id, title: game.C.puzzleTitles[id] ?? '谜题', sub: '', cls: 'm-pz' });
    this.p = game.C.puzzles[id];
    this.area = el('div', { class: 'pz-area' });
    const bg = game.C.puzzleBg[id];
    this.hasBg = !!(bg && game.assets.has(bg));
    if (this.hasBg) { const im = game.assets.element(bg, () => el('div')); im.classList.add('pz-bg'); this.body.append(im); }
    this.body.append(this.area);
  }
  /** 补丁 puzzleFeedback[id].hints：[{req, text}]，取第一条满足的（箱子年份等线索加强，见补丁 _说明） */
  feedbackHintEntry() { return (this.game.C.puzzleFeedback?.[this.id]?.hints || []).find((x) => !x.req || reqOk(this.game.S, x.req)) ?? null; }
  feedbackHint() { const h = this.feedbackHintEntry(); return h ? (this.game.C.texts[h.text] ?? h.text) : ''; }
  /** 解开：音效立刻播（BUGS #6：以前 sfx 也被延后到关窗后、和转场挤在一起听不见），
   *  弹窗里先显示补丁 puzzleFeedback[id].solvedText 停留片刻，再关闭并把 goto/text 等交给场景 */
  solve() {
    if (this.solved) return;
    this.solved = true;
    const { C, S } = this.game;
    const events = solvePuzzle(C, S, this.id, Date.now());
    this.area.classList.add('pz-solved');
    for (const e of events) if (e.type === 'sfx') this.game.handle(e);
    // 解开字幕：补丁 solvedText 优先；否则 onSolved 里的第一条 text 效果直接显示在弹窗里（不再关窗后在场景里重复一遍）；都没有 → uiText.puzzleSolved
    const fb = C.puzzleFeedback?.[this.id];
    const firstText = fb?.solvedText ? null : events.find((e) => e.type === 'text');
    this.game.commit(events.filter((e) => e.type !== 'sfx' && e !== firstText), { deferAll: true });
    const txt = fb?.solvedText ? (C.texts[fb.solvedText] ?? fb.solvedText) : firstText ? firstText.text ?? C.texts[firstText.key] : C.uiText.puzzleSolved;
    if (txt) this.message(txt);
    this.hint?.classList.add('done');
    setTimeout(() => this.close(), txt ? (fb?.holdMs ?? 2200) : 1300);
  }
}
