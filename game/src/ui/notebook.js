// 手记：证据 / 笔记 / 线索板 / 推理 + 扩展分页（家谱、日记…，见 src/ext）。
import { Modal } from './modal.js';
import { el, setRich } from './dom.js';
import { cbUnlocked, ddAvailable } from '../engine/logic.js';
import { notebookTabs } from '../ext/index.js';

export class Notebook extends Modal {
  constructor(game, tab = 'evidence') {
    super(game, { type: 'notebook', id: tab, title: '手记', sub: '埃德里克的蜡板', cls: 'm-nb' });
    this.tab = tab;
    this.tabs = el('div', { class: 'nb-tabs' });
    this.page = el('div', { class: 'nb-page' });
    this.root.insertBefore(this.tabs, this.body);
    this.body.append(this.page);
    this.msg.remove();
  }
  allTabs() {
    return [{ id: 'evidence', label: '证据' }, { id: 'notes', label: '笔记' }, { id: 'clueboard', label: '线索板' }, { id: 'deduction', label: '推理' },
      ...notebookTabs.map((t) => ({ ...t, ext: true }))];
  }
  show(tab) { this.tab = tab; this.id = tab; this.root.dataset.ui = `notebook:${tab}`; this.game.sfx('page'); this.render(); }
  render() {
    this.tabs.replaceChildren(...this.allTabs().map((t) => el('button', { class: `tab${t.ext ? ' ext' : ''}${this.tab === t.id ? ' active' : ''}`, 'data-tab': t.id, onclick: () => this.show(t.id) }, t.label)));
    this.page.replaceChildren();
    const { C, S } = this.game;
    const p = this.page;
    if (this.tab === 'evidence') {
      if (!S.evidence.length) return p.append(el('div', { class: 'empty', text: C.uiText.noEvidence }));
      const detail = el('div', { class: 'ev-detail' });
      p.append(el('div', { class: 'ev-grid' }, S.evidence.map((id) => el('button', { class: 'ev-card', 'data-id': id, onclick: () => {
        const ev = C.evidence[id]; this.game.sfx('page');
        setRich(detail, `<k>${ev?.name ?? id}</k>　${ev?.desc ?? ''}`);
      } }, this.game.evidenceEl(id), el('div', { class: 'ev-name', text: C.evidence[id]?.name ?? id })))), detail);
    } else if (this.tab === 'notes') {
      // 试玩反馈：已有证据时笔记页仍写“还没有记下什么”像是坏了——改为说明证据在哪一页、笔记何时出现
      if (!S.notes.length) return p.append(el('div', { class: 'empty', text: S.evidence.length && C.uiText.noNotesHasEvidence
        ? C.uiText.noNotesHasEvidence.replace('{n}', S.evidence.length) : C.uiText.noNotes }));
      p.append(el('h3', { text: '笔记' }), el('ul', { class: 'notes' }, S.notes.map((n) => el('li', { text: n }))));
    } else if (this.tab === 'clueboard') {
      const ids = Object.keys(C.clueboards);
      p.append(el('div', { class: 'nb-actions' }, ids.map((id) => cbUnlocked(C, S, id)
        ? el('button', { id: 'btn-open-clueboard', class: 'parch-btn primary', 'data-id': id, onclick: () => this.game.open('clueboard', id) }, '打开线索板')
        : el('div', { class: 'ext-placeholder' }, C.uiText.cbLockedTab, el('br'), (C.clueboards[id].unlock?.evidence || []).map((e) => `${S.evidence.includes(e) ? '✓' : '·'} ${C.evidence[e]?.name ?? e}`).join('　')))));
    } else if (this.tab === 'deduction') {
      const avail = Object.keys(C.deductions).filter((id) => ddAvailable(C, S, id));
      if (!avail.length) return p.append(el('div', { class: 'empty', text: C.uiText.noDeduction }));
      p.append(el('div', { class: 'nb-actions' }, avail.map((id) => el('button', { class: 'parch-btn dd-open', 'data-id': id, onclick: () => this.game.open('deduction', id) }, C.deductions[id].questions[0].q.slice(0, 12) + '…'))));
    } else {
      notebookTabs.find((t) => t.id === this.tab)?.render(this.game, p);
    }
  }
}
