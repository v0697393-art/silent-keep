// dial：N 位密码轮（0–9），点“开锁”核对。可选 hintFlag（06 §10：flag 为真时显示 uiText.dialHint，只提示不锁输入）。
// v1.1 的 pz_dial 已去掉 hintFlag，改由 h_chest 的 req（cb_cycle_solved）锁住入口。
import { PuzzleBase } from './base.js';
import { el } from '../ui/dom.js';

export class Dial extends PuzzleBase {
  constructor(game, id) {
    super(game, id);
    this.digits = Array(this.p.digits ?? String(this.p.answer).length).fill(0);
    this.hint = el('div', { class: 'pz-hint' });
    this.dial = el('div', { class: 'pz-dial' });
    // 有 cu_chest_lock 底图且是 3 位时，数字轮对准底图的三个空槽（底图 1080×1080 顶对齐，坐标见 css .pz-area.on-art）
    if (this.hasBg && this.digits.length === 3) { this.area.classList.add('on-art'); this.body.querySelector('.pz-bg')?.classList.add('fit-top'); }
    this.area.append(this.dial, el('button', { id: 'btn-confirm', class: 'parch-btn primary', onclick: () => this.confirm() }, '开锁'), this.hint);
  }
  render() {
    const { C, S } = this.game;
    this.dial.replaceChildren(...this.digits.map((d, i) => el('div', { class: 'wheel', 'data-index': i },
      el('button', { 'data-wheel': i, 'data-dir': 'up', 'aria-label': '加', onclick: () => this.spin(i, 1) }, '▲'),
      el('div', { class: 'digit', text: String(d) }),
      el('button', { 'data-wheel': i, 'data-dir': 'down', 'aria-label': '减', onclick: () => this.spin(i, -1) }, '▼'))));
    this.hint.textContent = this.p.hintFlag && S.flags[this.p.hintFlag] ? C.uiText.dialHint ?? '' : '';
  }
  spin(i, d) { if (this.solved) return; this.digits[i] = (this.digits[i] + d + 10) % 10; this.game.sfx('dial'); this.render(); }
  confirm() {
    if (this.solved) return;
    if (this.digits.join('') === String(this.p.answer)) { this.game.sfx('boxOpen'); this.solve(); }
    else { this.game.sfx('wrong'); this.message(this.game.C.uiText.dialWrong); this.dial.animate([{ transform: 'translateX(-12px)' }, { transform: 'translateX(12px)' }, { transform: 'none' }], 300); }
  }
}
