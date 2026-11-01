// rotate_grid：cols×rows 石盘，每格轻触切换到下一个符号（symbols 顺序循环），与 answer 一致即解开。
// 美术：cu_crest_door_<symbol>（如 cu_crest_door_eye_closed）有图就用，否则程序绘制符号。
import { PuzzleBase } from './base.js';
import { el } from '../ui/dom.js';
import { canvas, PAL, FONT } from '../engine/assets.js';

export function drawSymbol(sym, size = 260) {
  const c = canvas(size, size), g = c.getContext('2d'), s = size / 260;
  g.scale(s, s); g.translate(130, 130);
  g.strokeStyle = PAL.parch; g.fillStyle = PAL.parch; g.lineWidth = 12; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  if (sym === 'eye_closed') {
    g.moveTo(-90, -10); g.quadraticCurveTo(0, 60, 90, -10); g.stroke();
    g.beginPath(); for (const x of [-60, -20, 20, 60]) { g.moveTo(x, 22 - Math.abs(x) * 0.3); g.lineTo(x * 1.15, 60 - Math.abs(x) * 0.3); } g.stroke();
  } else if (sym === 'water') {
    for (let i = 0; i < 3; i++) { const y = -50 + i * 50; g.moveTo(-90, y); for (let x = -90; x <= 90; x += 45) g.quadraticCurveTo(x + 22, y - 24 * (i % 2 ? -1 : 1), x + 45, y); }
    g.stroke();
  } else if (sym === 'key') {
    g.arc(-50, 0, 38, 0, 7); g.moveTo(-12, 0); g.lineTo(95, 0); g.moveTo(60, 0); g.lineTo(60, 38); g.moveTo(85, 0); g.lineTo(85, 28); g.stroke();
  } else if (sym === 'well') {
    g.ellipse(0, -20, 80, 30, 0, 0, 7); g.moveTo(-80, -20); g.lineTo(-80, 60); g.moveTo(80, -20); g.lineTo(80, 60);
    g.moveTo(-80, 60); g.quadraticCurveTo(0, 95, 80, 60); g.stroke();
    g.beginPath(); g.fillStyle = PAL.ink; g.ellipse(0, -20, 60, 18, 0, 0, 7); g.fill();
  } else { g.font = `bold 90px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(sym.slice(0, 2), 0, 0); }
  return c;
}

export class RotateGrid extends PuzzleBase {
  constructor(game, id) {
    super(game, id);
    this.cur = [...(this.p.initial ?? this.p.symbols)];
    this.grid = el('div', { class: 'pz-crest', style: { gridTemplateColumns: `repeat(${this.p.cols}, 330px)` } });
    this.hint = el('div', { class: 'pz-hint' });
    const motto = game.S.flags.has_motto ? game.C.uiText.crestHint : '';
    this.area.append(motto ? el('div', { class: 'pz-motto', text: motto }) : null, this.grid, this.hint);
    this.area.firstChild || this.area.prepend(this.grid);
  }
  render() {
    const { C, assets } = this.game;
    this.grid.replaceChildren(...this.cur.map((sym, i) => {
      const img = assets.element(`cu_crest_door_${sym}`, () => drawSymbol(sym));
      const t = el('button', { class: 'tile', 'data-index': i, 'data-symbol': sym, 'aria-label': C.symbolNames[sym] ?? sym, onclick: () => this.turn(i, t) }, img);
      return t;
    }));
    this.hint.textContent = `${C.uiText.crestTap} · ${this.cur.map((s) => C.symbolNames[s] ?? s).join(' ')}`;
    if (!this.msg.textContent) this.message(this.game.S.flags.has_motto ? '' : C.uiText.crestTap);
  }
  turn(i) {
    if (this.solved) return;
    const syms = this.p.symbols;
    this.cur[i] = syms[(syms.indexOf(this.cur[i]) + 1) % syms.length];
    this.game.sfx('rotate');
    this.render();
    if (this.cur.every((s, k) => s === this.p.answer[k])) setTimeout(() => this.solve(), 250);
  }
}
