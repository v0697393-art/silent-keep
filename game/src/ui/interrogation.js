// 审讯：选一条证词 → 出示证据 → 拆穿（盖章“拆穿！”、NPC 立绘换表情、侦探头像切 press）。
// 数据：chapter1.json interrogations[id]（npc / portraits / intro / statements[accept,nearMiss,requires,onBreak] / onWrongEvidence / onComplete）
import { Modal } from './modal.js';
import { el, setRich } from './dom.js';
import { availableStatements, intState, intDone, presentEvidence } from '../engine/logic.js';
import { resolveText } from '../engine/chapter.js';
import { portrait as portraitPh, evidenceCard } from '../engine/assets.js';
import { npcIds } from '../engine/characters.js';
import { playFrames } from './misc.js';

// NPC 人声点缀（audio/vo/*，共振峰占位）：拆穿 / 出示错证据 / 审讯完成；近似证据时侦探“嗯?”
const NPC_VO = {
  osbert: { break: 'vo_osbert_sob', complete: 'vo_osbert_sob' },
  ysolde: { wrong: 'vo_ysolde_sneer', break: 'vo_ysolde_sneer', complete: 'vo_ysolde_laugh_break' },
};
const vo = (game, id, delay = 0) => id && setTimeout(() => game.audio.sfx(id), delay);

export class Interrogation extends Modal {
  constructor(game, id) {
    const it = game.C.interrogations[id];
    super(game, { type: 'interrogation', id, title: game.C.npcNames[it.npc] ?? it.npc, sub: '审讯 · 出示证据拆穿谎言', cls: 'm-int' });
    this.it = it; this.selected = null;
    this.expr = intDone(game.C, game.S, id) ? (Object.keys(it.portraits).pop()) : 'calm';
    this.portraitBox = el('div', { class: 'int-portrait' });
    this.detective = el('div', { class: 'int-detective' });
    this.speech = el('div', { class: 'int-speech' });
    this.portraitBox.append(this.speech, this.detective);
    this.stmts = el('div', { class: 'int-stmts' });
    this.presentBtn = el('button', { id: 'btn-present', class: 'parch-btn primary', onclick: () => this.openPicker() }, '出示证据');
    this.body.append(this.portraitBox, this.stmts, el('div', { class: 'int-actions' }, this.presentBtn));
    this.say(resolveText(game.C, it.intro));
  }
  setPortrait(expr) {
    const { game } = this;
    if (expr && this.it.portraits[expr]) this.expr = expr;
    const pid = this.it.portraits[this.expr] ?? Object.values(this.it.portraits)[0];
    const img = game.assets.element(game.assets.first(npcIds(pid)), () => portraitPh(this.it.npc, this.expr, game.C.npcNames[this.it.npc]));
    this.portraitImg?.remove();
    this.portraitImg = img;
    this.portraitBox.prepend(img);
  }
  setDetective(expr) {
    this.detective.replaceChildren(this.game.edricAvatar(expr));
    this.detective.classList.toggle('press', expr === 'press');
  }
  say(text) { setRich(this.speech, text, this.game.glitch()); }
  render() {
    const { C, S } = this.game;
    this.setPortrait(); this.setDetective('neutral');
    this.renderStmts();
    this.message(intDone(C, S, this.id) ? C.uiText.intDone : C.uiText.intSelect);
  }
  renderStmts(fresh = null) {
    const { C, S } = this.game;
    const broken = intState(S, this.id).broken;
    this.stmts.replaceChildren(...availableStatements(C, S, this.id).map((s) => {
      const b = broken.includes(s.id);
      return el('button', { class: `stmt${b ? ' broken' : ''}${this.selected === s.id ? ' selected' : ''}`, 'data-id': s.id, disabled: b || null,
        onclick: () => { this.selected = s.id; this.game.sfx('tap'); this.renderStmts(); } },
      resolveText(C, s.text), b ? el('span', { class: `stamp${fresh === s.id ? ' fresh' : ''}`, text: '拆' }) : null);
    }));
    const done = intDone(C, S, this.id);
    this.presentBtn.hidden = done;
  }
  openPicker() {
    const { C, S } = this.game;
    if (!this.selected) return this.message(C.uiText.intSelect);
    if (!S.evidence.length) return this.message(C.uiText.presentNone);
    this.game.sfx('page');
    const picker = el('div', { class: 'ev-picker' },
      el('div', { class: 'modal-head' }, el('div', { class: 'modal-title', text: '出示哪件证据？' }),
        el('button', { class: 'btn-close', 'data-action': 'cancel', onclick: () => picker.remove() }, '✕')),
      el('div', { class: 'ev-grid' }, S.evidence.map((ev) => el('button', { class: 'ev-pick', 'data-id': ev, onclick: () => { picker.remove(); this.present(ev); } },
        this.game.evidenceEl(ev), el('div', { class: 'ev-name', text: C.evidence[ev]?.name ?? ev })))));
    this.body.append(picker);
  }
  present(ev) {
    const { game } = this;
    const r = presentEvidence(game.C, game.S, this.id, this.selected, ev, Date.now());
    this.lastResult = r.result;
    if (r.result === 'break') {
      const b = r.events.find((e) => e.type === 'break');
      game.sfx('break');
      this.setPortrait(b.portrait); this.setDetective('press');
      this.say(b.text);
      this.message(`<k>拆穿！</k>`);
      const st = this.selected; this.selected = null;
      this.renderStmts(st);
      this.stampFx(st);
      game.commit(r.events.filter((e) => e.type !== 'break'));
      vo(game, NPC_VO[this.it.npc]?.[r.complete ? 'complete' : 'break'], 450);
      if (r.complete) this.message(game.C.uiText.intDone);
    } else if (r.result === 'nearMiss') {
      this.say(r.events[0].text); this.setDetective('think'); game.sfx('testimony'); vo(game, 'vo_edric_hm', 150);
      this.message('……');
    } else if (r.result === 'wrong') {
      this.setDetective('wry'); game.sfx('wrong'); vo(game, NPC_VO[this.it.npc]?.wrong, 300);
      game.commit(r.events);
    }
  }
  /** “拆穿！”：有 fx_stamp_seal 序列帧就按其 .json（6 帧 12fps、不循环、定格末帧）居中盖在被拆穿的证词条上；没有就用 CSS 文字印章 */
  stampFx(stmtId) {
    const { assets } = this.game;
    const frames = assets.frames('fx_stamp_seal');
    const row = stmtId && this.stmts.querySelector(`.stmt[data-id="${stmtId}"]`);
    if (frames.length && row) {
      const meta = assets.meta.fx_stamp_seal || {};
      const imgs = frames.map((id, i) => { const im = new Image(); im.src = `../art/${assets.path(id)}`; im.alt = ''; if (i > 0) im.style.visibility = 'hidden'; return im; });
      const fx = el('div', { class: 'stamp-fx', 'data-fx': 'fx_stamp_seal' }, imgs);
      row.append(fx);
      playFrames(imgs, { fps: meta.fps ?? 12, loop: meta.loop ?? false });
      setTimeout(() => fx.remove(), 1000 * (frames.length / (meta.fps ?? 12)) + 700);
      return;
    }
    const s = el('div', { class: 'int-stamp-big', text: '拆穿！' });
    this.portraitBox.append(s); setTimeout(() => s.remove(), 1400);
  }
}
