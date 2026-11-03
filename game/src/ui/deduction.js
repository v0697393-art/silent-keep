// 三问推理（以及线索板的结论推理）：每题单选，提交后指出第一道错题；submit:"all" 时一次提交全部。
import { Modal } from './modal.js';
import { el, setRich } from './dom.js';
import { ddSubmit } from '../engine/logic.js';
import { resolveText } from '../engine/chapter.js';

export class Deduction extends Modal {
  constructor(game, id) {
    const d = game.C.deductions[id];
    super(game, { type: 'deduction', id, title: d.questions.length > 1 ? '三问推理' : '推理', sub: '回答所有问题，然后提交', cls: 'm-dd' });
    this.d = d; this.answers = d.questions.map(() => null); this.firstWrong = -1; this.hint = '';
    this.list = el('div', { class: 'dd-body' });
    this.body.append(this.list);
    this.body.style.overflowY = 'auto';
  }
  render() {
    const { C } = this.game;
    this.list.replaceChildren(...this.d.questions.map((q, qi) => el('div', { class: `dd-q parch-panel${this.firstWrong === qi ? ' wrong' : ''}` },
      el('div', { class: 'q', text: `${qi + 1}. ${resolveText(C, q.q)}` }),
      el('div', { class: 'opts' }, q.options.map((o, i) => el('button', { class: `dd-opt${this.answers[qi] === i ? ' chosen' : ''}`, 'data-q': qi, 'data-index': i,
        onclick: () => { this.answers[qi] = i; this.firstWrong = -1; this.game.sfx('tap'); this.render(); } }, resolveText(C, o)))),
      this.firstWrong === qi && this.hint ? el('div', { class: 'hint', text: this.hint }) : null)));
    if (this.solved) this.list.append(el('div', { class: 'dd-solved', text: `— ${C.uiText.ddSolved} —` }));
    else this.list.append(el('div', { class: 'dd-actions' }, el('button', { id: 'btn-submit', class: 'parch-btn primary', disabled: this.answers.includes(null) || null, onclick: () => this.submit() }, '提交推理')));
    if (!this.msg.textContent) this.message(C.uiText.ddPick);
  }
  onEvent(ev) { if (ev.type === 'hint') this.hint = ev.text || ''; }
  submit() {
    const { game } = this;
    const r = ddSubmit(game.C, game.S, this.id, this.answers, Date.now());
    if (r.ok) {
      this.solved = true; game.sfx('deduce');
      game.clearToasts(); // 答错时的「推理出了岔子」不要和「推理成立」叠在同一屏
      this.message(`<k>${game.C.uiText.ddSolved}</k>`);
      this.render();
      // 成功：盖章停留后关闭，后续文本（如线索板结论）转到场景对话框
      game.commit(r.events, { deferText: true });
      setTimeout(() => { this.close(); if (game.modal?.type === 'clueboard') game.modal.close(); }, 1300);
    } else {
      this.firstWrong = r.firstWrong; this.hint = '';
      game.sfx('wrong');
      game.commit(r.events);
      this.message(game.C.uiText.ddWrong);
      this.render();
    }
  }
}
