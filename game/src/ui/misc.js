// 道具详情、菜单、过场
import { Modal } from './modal.js';
import { el, setRich } from './dom.js';
import { itemIcon, evidenceCard } from '../engine/assets.js';
import { closeupView } from '../engine/logic.js';

export class ItemDetail extends Modal {
  constructor(game, item) {
    const it = game.C.items[item];
    super(game, { type: 'item', id: item, title: '检视', sub: it?.name ?? item, cls: 'm-item' });
    this.item = item;
  }
  render() {
    const { C, assets } = this.game, it = C.items[this.item] || {};
    const desc = el('div', { class: 'desc' });
    setRich(desc, it.desc ?? '', this.game.glitch());
    this.body.replaceChildren(el('div', { class: 'detail' },
      assets.element(it.icon ?? `item_${this.item}`, () => itemIcon(this.item, it.name)),
      el('div', { class: 'name', text: it.name ?? this.item }), desc,
      it.use ? el('button', { id: 'btn-use-item', class: 'parch-btn primary', onclick: () => this.game.useSelf(this.item) }, C.uiText.useItem) : null));
  }
}

/**
 * 特写（只看不改状态，06 §12.1）。两种来源：
 *  1) C.closeups[id]（v1.2 特写表，open {ui:'closeup', id:'cu_xxx'}）：打开那一刻按 states 取第一条满足的
 *     （req + sanityBelow，之后不再随状态变化）；img=静态图，anim={frames,fps,loop} 自动播放（loop:false 停在最后一帧），
 *     点按不切换；overlays 为同尺寸透明叠层（左上对齐）；只有 pages 才能点按翻页、才显示页点。
 *  2) 谜题 id（道具解开带 bg 的谜题时先看一眼，pz_contract_read → cu_contract）：依次可翻看 bg、bg_fine、bg_seal，
 *     进入后 0.9s 自动换到 _fine（戴上眼镜看清细字）。
 */
export class CloseUp extends Modal {
  constructor(game, id) {
    const C = game.C, view = closeupView(C, game.S, id);
    super(game, { type: 'closeup', id, title: view?.title ?? C.puzzleTitles[id] ?? '特写', sub: '', cls: 'm-closeup' });
    this.view = view;
    if (view) {
      const st = view.state;
      const main = st.anim ? { anim: st.anim } : { img: st.img };
      this.frames = [main, ...view.pages.map((p) => (typeof p === 'string' ? { img: p } : p))];
      if (this.frames.length > 1) this.subEl.textContent = '轻触画面翻页';
    } else {
      const bg = C.puzzleBg[id];
      this.frames = [bg, `${bg}_fine`, `${bg}_seal`].filter((x, i) => i === 0 || game.assets.has(x)).map((img) => ({ img }));
      this.subEl.textContent = '轻触画面翻看';
      if (this.frames.length > 1) this.timer = setTimeout(() => this.show(1), 900);
    }
    this.idx = 0;
  }
  show(i) {
    clearTimeout(this.timer);
    this.idx = (i + this.frames.length) % this.frames.length;
    this.render();
  }
  onClose() { clearTimeout(this.timer); this.stopAnim?.(); }
  render() {
    const { assets } = this.game;
    this.stopAnim?.(); this.stopAnim = null;
    const f = this.frames[this.idx];
    const title = this.titleEl.textContent;
    const ph = (id) => () => evidenceCard(id, title);
    const stack = el('div', { class: 'cu-stack' });
    const view = el('div', { class: 'cu-view', 'data-state': this.view ? String(this.view.stateIndex) : null }, stack);
    if (f.anim) {
      const ids = f.anim.frames || [];
      const imgs = ids.map((id, k) => { const e = assets.element(id, ph(id)); e.classList.add(k ? 'cu-frame' : 'cu-base'); if (k) e.style.visibility = 'hidden'; return e; });
      stack.append(...imgs);
      view.dataset.frame = ids[0]; view.dataset.anim = ids.join(',');
      this.stopAnim = playFrames(imgs, { fps: f.anim.fps, loop: f.anim.loop !== false, onFrame: (k) => { view.dataset.frame = ids[k]; } });
    } else {
      const e = assets.element(f.img, ph(f.img)); e.classList.add('cu-base');
      stack.append(e); view.dataset.frame = f.img;
    }
    if (this.idx === 0 && this.view?.overlays.length) {
      for (const o of this.view.overlays) if (assets.has(o)) { const e = assets.element(o, () => document.createElement('i')); e.classList.add('cu-overlay'); stack.append(e); }
      view.dataset.overlays = this.view.overlays.join(',');
    }
    if (this.frames.length > 1) view.onclick = () => { this.game.sfx('page'); this.show(this.idx + 1); };
    const dots = this.frames.length > 1 ? el('div', { class: 'cu-dots' }, ...this.frames.map((_, i) => el('span', { class: i === this.idx ? 'on' : '' }))) : null;
    this.body.replaceChildren(...[view, dots].filter(Boolean));
  }
}

/**
 * DOM 逐帧播放：els 为叠放的同尺寸元素，按 fps 轮流显示其一；loop:false 时停在最后一帧。返回停止函数。
 * （特写 anim、心烛火苗、拆穿印章共用）
 */
export function playFrames(els, { fps = 12, loop = true, onFrame, onEnd } = {}) {
  if (els.length < 2) return () => {};
  let k = 0;
  const tick = () => {
    const next = k + 1;
    if (next >= els.length && !loop) { clearInterval(h); onEnd?.(); return; }
    els[k].style.visibility = 'hidden'; k = next % els.length; els[k].style.visibility = ''; onFrame?.(k);
  };
  const h = setInterval(tick, 1000 / Math.max(1, fps || 12));
  return () => clearInterval(h);
}

export class Menu extends Modal {
  constructor(game) { super(game, { type: 'menu', id: 'main', title: '菜单', cls: 'm-menu' }); this.msg.remove(); }
  render() {
    const g = this.game;
    this.body.replaceChildren(el('div', { class: 'menu-list' },
      el('button', { class: 'parch-btn', onclick: () => this.close() }, '继续调查'),
      el('button', { class: 'parch-btn', 'data-action': 'mute', onclick: () => { g.toggleMute(); this.render(); } }, g.audio.muted ? '打开声音' : '静音'),
      el('button', { class: 'parch-btn', onclick: () => { this.close(); g.toTitle(); } }, '回到标题'),
      el('button', { class: 'parch-btn', 'data-action': 'restart', onclick: () => { this.close(); g.newGame(); } }, '重新开始本章')));
  }
}

/** 过场：逐张显示 C.cutscenes[id] 的图（bg_intro_01…，缺图则用文字卡），配补丁里的字幕；轻触翻页，可跳过 */
export function playCutscene(game, id, { onEnd } = {}) {
  const { C, assets, dom } = game;
  const frames = C.cutscenes[id] || [];
  const caps = C.cutsceneCaptions[id] || [];
  const n = Math.max(frames.length, caps.length);
  const box = dom.cutscene;
  let i = -1, done = false;
  const finish = () => { if (done) return; done = true; box.hidden = true; box.replaceChildren(); onEnd?.(); };
  const next = () => {
    i++;
    if (i >= n) return finish();
    game.sfx('page');
    const ph = () => { const c = document.createElement('canvas'); c.width = 1080; c.height = 1920; const g = c.getContext('2d');
      const grd = g.createRadialGradient(540, 800, 50, 540, 900, 1100); grd.addColorStop(0, '#2b2119'); grd.addColorStop(1, '#000'); g.fillStyle = grd; g.fillRect(0, 0, 1080, 1920);
      g.fillStyle = 'rgba(168,134,92,.35)'; g.font = '30px sans-serif'; g.textAlign = 'center'; g.fillText(`〔过场 ${frames[i] ?? id}〕`, 540, 160); return c; };
    const img = assets.element(frames[i], ph);
    const cap = el('div', { class: 'cs-caption' }); setRich(cap, caps[i] ?? '');
    box.replaceChildren(img, cap, el('div', { class: 'cs-tap', text: '轻触继续' }),
      el('button', { class: 'cs-skip', 'data-action': 'skip', onclick: (e) => { e.stopPropagation(); finish(); } }, '跳过 ▸▸'));
  };
  box.hidden = false;
  box.onpointerup = (e) => { if (!e.target.closest('button')) next(); };
  box.dataset.id = id;
  next();
  return { next, finish };
}
