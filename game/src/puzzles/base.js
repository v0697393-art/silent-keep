import { Modal } from '../ui/modal.js';
import { el } from '../ui/dom.js';
import { solvePuzzle } from '../engine/logic.js';

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
  /** 解开：播放下沉动画后关闭，再把 onSolved 的 goto/text 等交给场景 */
  solve() {
    if (this.solved) return;
    this.solved = true;
    const events = solvePuzzle(this.game.C, this.game.S, this.id, Date.now());
    this.area.classList.add('pz-solved');
    this.game.commit(events, { deferAll: true });
    setTimeout(() => this.close(), 1300);
  }
}
