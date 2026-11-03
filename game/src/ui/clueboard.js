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
      // 卡片本身是 button，里面不能再套 button（浏览器会把内层按钮拆出去）
      const zoom = el('span', { class: 'card-zoom', role: 'button', tabindex: '0', 'aria-label': `放大：${c.label}`, text: '看' });
      zoom.addEventListener('pointerdown', (e) => e.stopPropagation());
      zoom.addEventListener('pointerup', (e) => e.stopPropagation());
      zoom.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); this.openZoom(c, imgId); });
      const card = el('button', { class: `card${this.sel === c.id ? ' selected' : ''}`, 'data-id': c.id, style: { left: `${x}px`, top: `${y}px` } },
        img, el('div', { class: 'label', text: c.label }), zoom);
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
  /** 超过一行的关系说明从中间折成两行，底框由 CSS 按文字收缩 */
  wrapTag(text) {
    const chars = [...text];
    if (chars.length <= 14) return text;
    const cut = Math.ceil(chars.length / 2);
    return `${chars.slice(0, cut).join('')}\n${chars.slice(cut).join('')}`;
  }
  drawLinks() {
    const { S } = this.game;
    const done = cbState(S, this.id).links;
    this.svg.replaceChildren();
    this.tags?.remove();
    const tags = el('div', { class: 'cb-tags' });
    const placed = [];
    for (const l of this.cb.links) if (done.includes(l.id)) {
      const [x1, y1] = this.center(l.a), [x2, y2] = this.center(l.b);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', `M${x1},${y1} Q${mx},${(y1 + y2) / 2 + 40} ${x2},${y2}`);
      p.setAttribute('stroke', '#7A2E25'); p.setAttribute('stroke-width', '8'); p.setAttribute('fill', 'none'); p.setAttribute('stroke-linecap', 'round');
      this.svg.append(p);
      const tag = el('div', { class: 'link-tag', text: this.wrapTag(l.options[l.answer]) });
      tag.style.left = `${mx}px`; tag.style.top = `${my}px`;
      tags.append(tag);
      placed.push({ tag, x: mx, y: my, dx: x2 - x1, dy: y2 - y1 });
    }
    this.board.append(tags); this.tags = tags;
    this.separateTags(placed);
  }
  /** 标签中点靠在一起时错开，避免两层字叠在同一块上 */
  separateTags(placed) {
    if (placed.length < 2) return;
    const board = this.board;
    const boxOf = (node) => {
      const br = board.getBoundingClientRect(), k = br.width / board.clientWidth || 1, r = node.getBoundingClientRect();
      return { x: (r.left - br.left) / k, y: (r.top - br.top) / k, w: r.width / k, h: r.height / k };
    };
    const relax = () => {
      for (let pass = 0; pass < 24; pass++) {
        let moved = false;
        for (let i = 0; i < placed.length; i++) {
          for (let j = 0; j < i; j++) {
            const a = boxOf(placed[i].tag), b = boxOf(placed[j].tag), gap = 12;
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (ox <= 0 || oy <= 0) continue;
            // 两边一起推，避免一条被上下邻居夹住时来回弹
            if (ox < oy) {
              const sign = (a.x + a.w / 2) >= (b.x + b.w / 2) ? 1 : -1;
              const push = (ox + gap) / 2;
              placed[i].x += sign * push; placed[j].x -= sign * push;
            } else {
              const sign = (a.y + a.h / 2) >= (b.y + b.h / 2) ? 1 : -1;
              const push = (oy + gap) / 2;
              placed[i].y += sign * push; placed[j].y -= sign * push;
            }
            placed[i].tag.style.left = `${placed[i].x}px`;
            placed[i].tag.style.top = `${placed[i].y}px`;
            placed[j].tag.style.left = `${placed[j].x}px`;
            placed[j].tag.style.top = `${placed[j].y}px`;
            moved = true;
          }
        }
        if (!moved) break;
      }
    };
    relax();
    const bw = board.clientWidth, bh = board.clientHeight, pad = 10;
    for (const p of placed) {
      const r = boxOf(p.tag);
      let dx = 0, dy = 0;
      if (r.x < pad) dx = pad - r.x;
      if (r.y < pad) dy = pad - r.y;
      if (r.x + r.w > bw - pad) dx = (bw - pad) - (r.x + r.w);
      if (r.y + r.h > bh - pad) dy = (bh - pad) - (r.y + r.h);
      if (dx || dy) { p.x += dx; p.y += dy; p.tag.style.left = `${p.x}px`; p.tag.style.top = `${p.y}px`; }
    }
    relax();
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
  /** 把卡片放大到几乎铺满竖屏，桌面上才能读清图里的年份和说明。点空白或 ✕ 关掉，不改变连线。 */
  openZoom(card, imgId) {
    this.zoomEl?.remove();
    this.game.sfx('page');
    const img = this.game.assets.element(imgId, () => evidenceCard(card.id, card.label));
    const close = () => { box.remove(); if (this.zoomEl === box) this.zoomEl = null; };
    const box = el('div', { class: 'cb-zoom', onclick: close },
      el('div', { class: 'cb-zoom-card', onclick: (e) => e.stopPropagation() },
        img,
        el('div', { class: 'cb-zoom-label', text: card.label }),
        el('button', { class: 'btn-close', type: 'button', 'aria-label': '关闭', onclick: (e) => { e.stopPropagation(); close(); } }, '✕')));
    this.root.append(box);
    this.zoomEl = box;
  }
  choose(link, i) {
    const r = cbChoose(this.game.C, this.game.S, this.id, link.id, i, Date.now());
    if (r.ok) { this.game.sfx('clueOk'); this.message(`连上了：<k>${link.options[i]}</k>`); }
    else this.game.sfx('clueFail');
    this.game.commit(r.events);
    this.render();
  }
}
