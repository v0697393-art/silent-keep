// 线索板：卡片（钉在软木板上）两两连线；连线需要选对关系选项，错选扣心烛。全部连好后“得出结论”进入 conclusion 推理。
// 操作：依次轻触两张卡片，或从一张拖到另一张。
import { Modal } from './modal.js';
import { el } from './dom.js';
import { cbUnlocked, cbState, cbFindLink, cbAllLinked, cbChoose, ddAvailable } from '../engine/logic.js';
import { evidenceCard } from '../engine/assets.js';

const SVG = 'http://www.w3.org/2000/svg';
const CARD_W = 300, CARD_H = 330;

export class Clueboard extends Modal {
  constructor(game, id) {
    super(game, { type: 'clueboard', id, title: '线索板', sub: '连线并说明关系', cls: 'm-cb' });
    this.cb = game.C.clueboards[id]; this.sel = null;
    this.board = el('div', { class: 'cb-board' });
    this.foot = el('div', { class: 'cb-foot' });
    this.body.append(this.board);
    this.root.insertBefore(this.foot, this.msg);
  }
  layout() {
    // 卡片自动排布：3 列网格（板内 1020 宽）
    const n = this.cb.cards.length, cols = 3, rows = Math.ceil(n / cols);
    const bw = 1020, bh = this.board.clientHeight || 1300;
    const pos = {};
    this.cb.cards.forEach((c, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      pos[c.id] = [Math.round((bw / cols) * (col + 0.5) - CARD_W / 2), Math.round(((bh - 40) / rows) * (row + 0.5) - CARD_H / 2 + (col === 1 ? 40 : 0))];
    });
    return pos;
  }
  render() {
    const { C, S } = this.game;
    this.board.replaceChildren(); this.foot.replaceChildren();
    if (!cbUnlocked(C, S, this.id)) return this.renderLocked();
    this.pos = this.layout();
    const svg = document.createElementNS(SVG, 'svg');
    this.board.append(svg); this.svg = svg;
    for (const c of this.cb.cards) {
      const [x, y] = this.pos[c.id];
      const imgId = C.cardImg[c.id];
      const img = this.game.assets.element(imgId, () => evidenceCard(c.id, c.label));
      const card = el('button', { class: `card${this.sel === c.id ? ' selected' : ''}`, 'data-id': c.id, style: { left: `${x}px`, top: `${y}px` } },
        img, el('div', { class: 'label', text: c.label }));
      card.addEventListener('click', () => this.tapCard(c.id));
      card.addEventListener('pointerdown', (e) => { this.dragFrom = c.id; this.dragStart = [e.clientX, e.clientY]; });
      card.addEventListener('pointerup', (e) => this.dragEnd(e));
      this.board.append(card);
    }
    this.drawLinks();
    const st = cbState(S, this.id), total = this.cb.links.length;
    this.foot.append(el('div', { class: 'cb-progress', text: `已连线 ${st.links.length} / ${total}` }));
    if (cbAllLinked(C, S, this.id)) {
      if (this.cb.conclusion && ddAvailable(C, S, this.cb.conclusion))
        this.foot.append(el('button', { id: 'btn-conclusion', class: 'parch-btn primary', onclick: () => this.game.open('deduction', this.cb.conclusion) }, C.uiText.cbConclusion));
      else this.message(C.uiText.cbDone);
    } else if (!this.msg.textContent) this.message(C.uiText.cbPick);
  }
  renderLocked() {
    const { C, S } = this.game;
    const need = this.cb.unlock?.evidence || [];
    // BUGS #9：标题放进独立的羊皮纸标签（不再压在虚线格上），格子用浅底深字；另给“已找到 n/3”
    const got = need.filter((e) => S.evidence.includes(e)).length;
    this.board.append(el('div', { class: 'cb-locked' },
      el('div', { class: 'cb-locked-title' }, C.uiText.cbLockedTab.replace(/[：:]\s*$/, ''), el('small', { text: `已找到 ${got} / ${need.length}` })),
      el('div', { class: 'slots-need' }, need.map((e) => el('div', { class: S.evidence.includes(e) ? 'got' : '', text: S.evidence.includes(e) ? `✓ ${C.evidence[e]?.name}` : '？' })))));
    this.message(C.uiText.cbLocked);
  }
  center(id) { const [x, y] = this.pos[id]; return [x + CARD_W / 2, y + CARD_H / 2]; }
  drawLinks() {
    const { S } = this.game;
    const done = cbState(S, this.id).links;
    this.svg.replaceChildren();
    for (const l of this.cb.links) if (done.includes(l.id)) {
      const [x1, y1] = this.center(l.a), [x2, y2] = this.center(l.b);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 + 30;
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', `M${x1},${y1} Q${mx},${my + 40} ${x2},${y2}`);
      p.setAttribute('stroke', '#7A2E25'); p.setAttribute('stroke-width', '8'); p.setAttribute('fill', 'none'); p.setAttribute('stroke-linecap', 'round');
      const t = document.createElementNS(SVG, 'text');
      t.setAttribute('x', mx); t.setAttribute('y', my + 20); t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'link-tag');
      t.textContent = l.options[l.answer];
      const bg = document.createElementNS(SVG, 'rect');
      bg.setAttribute('x', mx - 110); bg.setAttribute('y', my - 10); bg.setAttribute('width', 220); bg.setAttribute('height', 42); bg.setAttribute('rx', 8); bg.setAttribute('fill', 'rgba(26,20,16,.85)');
      this.svg.append(p, bg, t);
    }
  }
  tapCard(id) {
    if (this.suppressClick) { this.suppressClick = false; return; }
    this.game.sfx('tap');
    if (!this.sel) { this.sel = id; this.render(); return; }
    if (this.sel === id) { this.sel = null; this.render(); return; }
    const a = this.sel; this.sel = null; this.pair(a, id);
  }
  dragEnd(e) {
    const from = this.dragFrom; this.dragFrom = null;
    if (!from || Math.hypot(e.clientX - this.dragStart[0], e.clientY - this.dragStart[1]) < 30) return;
    const to = document.elementFromPoint(e.clientX, e.clientY)?.closest('.card')?.dataset.id;
    if (to && to !== from) { this.suppressClick = true; setTimeout(() => (this.suppressClick = false), 50); this.sel = null; this.pair(from, to); }
  }
  pair(a, b) {
    const { C, S } = this.game;
    const link = cbFindLink(C, this.id, a, b);
    if (!link) { this.message(C.uiText.cbNoRelation); this.render(); return; }
    if (cbState(S, this.id).links.includes(link.id)) { this.message(C.uiText.cbAlready); this.render(); return; }
    this.render();
    const la = this.cb.cards.find((c) => c.id === link.a).label, lb = this.cb.cards.find((c) => c.id === link.b).label;
    const panel = el('div', { class: 'cb-options parch-panel' }, el('div', { class: 'q', text: `${la} ⟷ ${lb}` }),
      link.options.map((o, i) => el('button', { class: 'link-opt', 'data-index': i, onclick: () => { panel.remove(); this.choose(link, i); } }, o)),
      el('button', { class: 'link-opt', 'data-action': 'cancel', style: { background: 'transparent' }, onclick: () => panel.remove() }, '再想想'));
    this.board.append(panel);
  }
  choose(link, i) {
    const r = cbChoose(this.game.C, this.game.S, this.id, link.id, i, Date.now());
    if (r.ok) { this.game.sfx('clueOk'); this.message(`连上了：<k>${link.options[i]}</k>`); }
    else this.game.sfx('clueFail');
    this.game.commit(r.events);
    this.render();
  }
}
