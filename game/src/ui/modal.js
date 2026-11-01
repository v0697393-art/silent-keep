// 全屏模态界面基类：标题栏（标题/副标题/关闭）+ 主体 + 底部羊皮纸消息条。
// 打开期间，游戏事件里的 text 会显示在消息条里（而不是场景对话框）。
import { el, setRich } from './dom.js';

export class Modal {
  constructor(game, { type, id = '', title = '', sub = '', cls = '', closable = true } = {}) {
    this.game = game; this.type = type; this.id = id;
    this.closeBtn = closable ? el('button', { class: 'btn-close', 'data-action': 'close', 'aria-label': '关闭', onclick: () => this.close() }, '✕') : null;
    this.titleEl = el('div', { class: 'modal-title', text: title });
    this.subEl = el('div', { class: 'modal-sub', text: sub });
    this.body = el('div', { class: 'modal-body' });
    this.msg = el('div', { class: 'modal-msg' });
    this.root = el('div', { class: `modal ${cls}`, 'data-ui': `${type}:${id}` },
      el('div', { class: 'modal-head' }, el('div', { style: { flex: 1 } }, this.titleEl, this.subEl), this.closeBtn),
      this.body, this.msg);
  }
  mount() { this.game.dom.modalRoot.append(this.root); this.render?.(); return this; }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.root.remove();
    this.onClose?.();
    this.game.afterModalClose(this);
  }
  message(text) { setRich(this.msg, text, this.game.glitch()); }
  onEvent(_ev) {}
}
