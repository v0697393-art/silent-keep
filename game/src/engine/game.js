// 运行时控制器：把纯逻辑（logic.js）接到渲染、界面、音频、存档上。
//   · 场景点击 → tapAt → events → commit()（立即存档 + 逐条表现）
//   · 模态栈（审讯/线索板/推理/谜题/手记/道具/菜单），game.modal = 栈顶
//   · 对话框（打字机 + 埃德里克头像随表情/心烛档切换）、道具栏（5 格分页、选中/组合/检视）、HUD（心烛/手记角标/静音）
//   · 音频：统一用 audio.sfx()/bgm()/amb()（AudioManager 另保留 playSfx/playBgm 别名）；心烛档 → audio.setSanityStage()
//   · 章节（06 §13.1）：结局页“继续：第二章”→ prepareChapter(n+1) → createState + chapterReset（心烛继承、至少 chapterResetMin）；
//     存档按章分键 + hushwold_progress（save.js）；?ch=N（chParam）直接开第 N 章，新开局心烛按 sanity.start
import {
  createState, tapAt, combineItems, useItemSelf, gotoRoom, navTargets, tierOf, tierHas, inRect, pointFor, hotspotActive, interact, reqOk, chapterReset,
} from './logic.js';
import { saveGame, loadGame, hasSave, clearSave, prefs, getProgress, setProgress, chapterOf } from './save.js';
import { chapterInfo } from './chapter.js';
import { PLAY_RECT, LAYOUT } from './layout.js';
import { itemIcon, evidenceCard, portrait } from './assets.js';
import { edricIds } from './characters.js';
import { el, setRich, fmt } from '../ui/dom.js';
import { Interrogation } from '../ui/interrogation.js';
import { Clueboard } from '../ui/clueboard.js';
import { Deduction } from '../ui/deduction.js';
import { Notebook } from '../ui/notebook.js';
import { ItemDetail, Menu, CloseUp, playCutscene, playFrames } from '../ui/misc.js';
import { puzzleClass } from '../puzzles/index.js';
import { extraUIs } from '../ext/index.js';

const PAGE = 6; // 道具栏 ui_inventory_bar 画了 6 格（ui_meta.inventory_slots）
const MUSIC_UI = { interrogation: 'interrogation', clueboard: 'clueboard', deduction: 'clueboard' };

export class Game {
  constructor({ C, assets, audio, renderer, stage, dom, prepareChapter = null, chParam = null }) {
    Object.assign(this, { C, assets, audio, renderer, stage, dom, prepareChapter, chParam });
    this.S = null; this.stack = []; this.pending = [];
    this.selected = null; this.invPage = 0; this.freshItem = null; this.badge = false;
    this.dialogQ = []; this.dialogCur = null; this.expr = 'neutral';
    this.inCutscene = false; this.screen = 'title';
    this.bindDom();
  }
  get modal() { return this.stack[this.stack.length - 1] ?? null; }
  get busy() { return this.screen !== 'game' || this.inCutscene || !!this.modal || !!this.dialogCur; }

  // ---------- DOM ----------
  bindDom() {
    const d = this.dom;
    d.btnNotebook.onclick = () => { this.sfx('page'); this.badge = false; this.open('notebook', 'evidence'); };
    d.btnMenu.onclick = () => { this.sfx('tap'); this.open('menu'); };
    d.btnMute.onclick = () => this.toggleMute();
    d.btnPrev.onclick = () => this.nav('prev');
    d.btnNext.onclick = () => this.nav('next');
    d.btnInvPrev.onclick = () => { this.invPage--; this.sfx('tap'); this.renderInventory(); };
    d.btnInvNext.onclick = () => { this.invPage++; this.sfx('tap'); this.renderInventory(); };
    d.dialogLayer.addEventListener('pointerup', () => this.advanceDialog());
    d.btnNew.onclick = () => this.newGame();
    d.btnContinue.onclick = () => this.continueGame();
  }
  sfx(key, o) { const id = this.C.uiSfx[key] ?? key; if (id) this.audio.sfx(id, o); }
  glitch() { return this.S && tierHas(this.C, this.S, 'text_glitch') ? { chance: 0.15, protectKeys: true, ...(this.C.sanity.textGlitch || {}) } : null; }
  edricAvatar(expr = this.expr) {
    const ids = edricIds(this.C, this.S?.sanity ?? 100, expr, { avatar: true });
    return this.assets.element(this.assets.first(ids), () => portrait('edric', expr === 'shaken' ? 'shaken' : 'calm', '埃德里克'));
  }
  evidenceEl(id) {
    const ev = this.C.evidence[id] || {};
    return this.assets.element(ev.img ?? id, () => evidenceCard(id, ev.name ?? id));
  }
  itemEl(id) { const it = this.C.items[id] || {}; return this.assets.element(it.icon ?? `item_${id}`, () => itemIcon(id, it.name ?? id)); }
  itemName(id) { return this.C.items[id]?.name ?? id; }

  // ---------- 章节 ----------
  get chapter() { return chapterOf(this.C); }
  /** 换章节数据：渲染器、音频别名都跟着换（状态 S 由调用方重建） */
  setChapter(C) {
    this.C = C; this.audio.alias = C.audioAlias || {};
    if (this.S) this.renderer.bind(C, this.S);
  }
  async switchChapter(n) {
    if (chapterOf(this.C) === n) return this.C;
    if (!this.prepareChapter || !chapterInfo(n)) throw new Error(`没有第 ${n} 章`);
    this.loadingChapter = n;
    try { this.setChapter(await this.prepareChapter(n)); } finally { this.loadingChapter = null; }
    return this.C;
  }
  /** 新开第 n 章（已切到该章数据）：inherit 为上一章心烛时按 chapterReset 继承（至少 chapterResetMin），否则按 sanity.start */
  freshChapterState(inherit = null) {
    const S = createState(this.C);
    if (Number.isFinite(inherit)) { S.sanity = inherit; chapterReset(this.C, S); }
    return S;
  }
  /** 标题页“继续”：本章有档读档；否则进度里有已解锁的后续章节 → 以继承心烛新开该章 */
  continueTarget() {
    const p = getProgress();
    if (this.chParam != null) return hasSave(this.C) || (this.chParam > 1 && (p?.maxChapter ?? 1) >= this.chParam) ? this.chParam : null;
    if (hasSave(this.C)) return this.chapter;
    if (p && p.maxChapter > 1 && chapterInfo(p.maxChapter)) return p.maxChapter;
    return null;
  }

  // ---------- 标题 / 开局 ----------
  toTitle() {
    this.screen = 'title';
    while (this.stack.length) this.stack.pop().root.remove();
    this.dom.title.hidden = false;
    this.dom.btnContinue.hidden = this.continueTarget() == null;
    const ch = this.dom.title.querySelector('.chapter'), cn = '一二三四五六七八九'[this.chapter - 1] ?? this.chapter;
    if (ch) ch.textContent = `第${cn}章 · ${this.C.meta.name ?? ''}`;
    const foot = this.dom.title.querySelector('.title-foot'); if (foot) foot.textContent = '试玩版';
    this.dom.title.dataset.chapter = this.chapter;
    this.audio.amb(null); this.audio.setSanityStage(0);
    this.audio.bgm(this.C.uiBgm.title ?? null);
  }
  async newGame() {
    this.sfx('tap');
    if (this.chParam != null) clearSave(this.C);          // ?ch=N：只清本章的档，按 sanity.start 新开本章
    else { clearSave('all'); await this.switchChapter(1); } // 标题“新的调查”：从第一章重开，清掉所有章节存档与进度
    this.S = this.freshChapterState();
    this.start(true);
  }
  async continueGame() {
    this.sfx('tap');
    const n = this.continueTarget();
    if (n == null) return this.newGame();
    await this.switchChapter(n);
    const S = loadGame(this.C);
    if (S && !S.ended) { this.S = S; return this.start(false); }
    // 本章没有档（上一章结局后回了标题）或档已是本章结局：以进度里的心烛新开本章
    this.S = this.freshChapterState(getProgress()?.sanity ?? null);
    setProgress({ maxChapter: this.chapter, sanity: this.S.sanity, start: { [this.chapter]: this.S.sanity } });
    this.start(true);
  }
  /** 菜单“重新开始本章”：只清本章存档；第 2 章起沿用进入本章时继承的心烛（?ch=N 直开的按 sanity.start） */
  restartChapter() {
    this.sfx('tap'); clearSave(this.C);
    const inherit = this.chParam == null && this.chapter > 1 ? getProgress()?.starts?.[this.chapter] ?? null : null;
    this.S = this.freshChapterState(inherit);
    this.start(true);
  }
  start(intro) {
    this.dom.title.hidden = true;
    this.screen = 'game'; this.selected = null; this.invPage = 0; this.dialogQ = []; this.hideDialog();
    this.renderer.bind(this.C, this.S);
    saveGame(this.C, this.S);
    if (intro && this.C.intro) this.cutscene(this.C.intro, () => this.enterRoom());
    else this.enterRoom();
  }

  // ---------- 房间 ----------
  enterRoom() {
    const r = this.C.roomById[this.S.room];
    this.renderer.bind(this.C, this.S); this.renderer.transition();
    this.renderer.npcTag = null; // 换房间收起人物名牌
    if (!this.musicModal()) this.audio.bgm(r.bgm ?? null);
    this.audio.amb(r.amb ?? null);
    const next = this.C.rooms[this.C.rooms.indexOf(r) + 1];
    this.audio.preload([next?.bgm, next?.amb]);
    // 预加载本房间全部背景差分 + 道具遮罩（BUGS #10：状态切换时不再出现未加载的背景）
    this.renderer.preloadRoom().then(() => this.renderer.invalidate());
    this.updateHud();
  }
  nav(dir) {
    const to = navTargets(this.C, this.S)[dir];
    if (!to || this.busy) return;
    this.sfx('tap'); this.selected = null;
    gotoRoom(this.C, this.S, to); saveGame(this.C, this.S);
    this.enterRoom();
  }

  // ---------- 场景点击 ----------
  onTap(x, y) {
    if (this.busy) return;
    if (y < LAYOUT.hudBottom || y > LAYOUT.playBottom) return;
    const { C, S } = this;
    if (tierHas(C, S, 'fake_hotspots')) {
      const f = (C.sanity.fakeHotspots?.[S.room] || []).find((fh) => inRect(fh.rect, x, y));
      if (f) { this.expr = 'shaken'; this.audio.sfx('vo_edric_gasp'); return this.say(f.text, { reveal: true }); }
    }
    const item = this.selected;
    const flagsBefore = { ...S.flags };
    const spots = this.renderer.npcSpotsHere?.() || [];
    const r = tapAt(C, S, x, y, item, Date.now());
    const who = r.hit && spots.find((sp) => sp.hotspot === r.hit);
    if (who) this.renderer.showNpcTag(who.npc); // 名牌不常驻：点到人物才短暂显示（对白期间保持）
    if (!r.hit) {
      if (item) { this.selected = null; this.renderInventory(); return; }
      // 点空：闪一下当前有反应的热点（轻提示）
      this.renderer.flash(C.roomById[S.room].hotspots.filter((h) => hotspotActive(S, h)).map((h) => h.id));
      return;
    }
    if (!r.ok) {
      if (item) {
        this.sfx('wrong'); this.expr = 'wry'; this.audio.sfx('vo_edric_sneer');
        this.say(this.cantUseText(r.hit, item));
        this.selected = null; this.renderInventory();
      }
      return;
    }
    if (item) { this.selected = null; this.renderInventory(); } // 用完即取消选中（与失败时一致）
    if (item) this.sfx('use');
    const extra = C.hotspotSfx[r.hit];
    if (extra) this.audio.sfx(extra);
    if (!flagsBefore.got_spectacles && S.flags.got_spectacles) this.renderer.crowFlyAway();
    this.commit(r.events);
    if (who && this.renderer.npcTag) this.renderer.npcTag.hold = !!this.dialogCur;
  }

  // ---------- 事件 ----------
  /** 存档 + 表现事件。deferText：文本等模态关闭后在场景对话框显示；deferAll：全部事件延后 */
  commit(events = [], { deferText = false, deferAll = false } = {}) {
    saveGame(this.C, this.S);
    for (const e of events) {
      if (deferAll || (deferText && e.type === 'text')) this.pending.push(e);
      else this.handle(e);
    }
    this.renderer.invalidate();
    this.updateHud();
  }
  handle(e) {
    const { C } = this, m = this.modal;
    switch (e.type) {
      case 'text':
        if (m) m.message(e.text); else this.say(e.text, { reveal: e.reveal });
        break;
      case 'note':
        this.toast(`记下：${e.text}`); this.badge = true; break;
      case 'sfx': this.audio.sfx(e.id); break;
      case 'give':
        this.sfx('pickup'); this.freshItem = e.item;
        this.toast(`获得 <k>${this.itemName(e.item)}</k>`);
        this.invPage = Math.floor(this.S.inventory.indexOf(e.item) / PAGE);
        break;
      case 'take': if (this.selected === e.item) this.selected = null; break;
      case 'combined': this.sfx('combineOk'); break;
      case 'evidence':
        this.sfx('evidence'); this.badge = true;
        this.toast(`新证据：<k>${C.evidence[e.id]?.name ?? e.id}</k>`);
        break;
      case 'sanity': this.onSanity(e); break;
      case 'restore':
        if (e.ok) { this.sfx('restore'); this.expr = 'relief'; }
        else if (m) m.message(fmt(C.uiText.restoreCooldown, { sec: e.remain })); else this.say(fmt(C.uiText.restoreCooldown, { sec: e.remain }));
        this.lastRestore = e;
        break;
      case 'goto': if (m) this.pending.push(e); else this.enterRoom(); break;
      case 'open': if (m && m.type !== 'notebook') this.pending.push(e); else this.open(e.ui, e.id); break;
      case 'cutscene':
        if (m) { this.pending.push(e); break; }
        if (e.id === C.ending) this.ending(); else this.cutscene(e.id);
        break;
      case 'hint': m?.onEvent?.(e); break;
      default: m?.onEvent?.(e);
    }
  }
  reqOkNow(req) { return reqOk(this.S, req); }
  /** 对指定热点使用道具（特写界面里的“用道具”行调用，BUGS #8）：与在场景上选中道具再点该热点完全等价 */
  useOn(hotspotId, item) {
    const { C, S } = this;
    const flagsBefore = { ...S.flags };
    const r = interact(C, S, hotspotId, item, Date.now());
    this.selected = null; this.renderInventory();
    if (!r.ok) { this.sfx('wrong'); this.say(this.cantUseText(hotspotId, item)); return false; }
    this.sfx('use');
    const extra = C.hotspotSfx[hotspotId];
    if (extra) this.audio.sfx(extra);
    if (!flagsBefore.got_spectacles && S.flags.got_spectacles) this.renderer.crowFlyAway();
    this.commit(r.events);
    return true;
  }
  /** 拿错道具的提示：热点补丁 cantUse[item] / cantUse['*'] 优先，否则通用 uiText.cantUse（BUGS #8） */
  cantUseText(hotspotId, item) {
    const { C, S } = this;
    const h = C.roomById[S.room]?.hotspots.find((x) => x.id === hotspotId);
    const key = h?.cantUse?.[item] ?? h?.cantUse?.['*'];
    const t = key != null ? C.texts[key] : null;
    return fmt(t ?? C.uiText.cantUse, { item: this.itemName(item) });
  }
  /** 心烛扣减的原因（试玩反馈：100→77 不知道为什么）：按当时所在界面取补丁 sanityReasons 的文案 */
  sanityReason(e) {
    const R = this.C.sanityReasons || {};
    const m = this.modal?.type;
    return e.reason ?? (m && R[m]) ?? R.scene ?? '';
  }
  onSanity(e) {
    const { C } = this;
    const before = e.value - e.delta;
    const tb = tierOf(C, before).id, ta = tierOf(C, e.value).id;
    const f = el('div', { class: `sanity-float${e.delta < 0 ? ' neg' : ''}`, text: `${e.delta > 0 ? '+' : ''}${e.delta}` });
    this.dom.sanity.append(f); setTimeout(() => f.remove(), 1600);
    if (e.delta < 0) {
      const why = this.sanityReason(e);
      this.lastSanityReason = why;
      if (why) this.toast(`<k>心烛 ${e.delta}</k>　${why}`);
    }
    if (e.delta < 0) { this.expr = 'shaken'; if (ta !== tb) this.audio.sfx('vo_edric_gasp'); }
    else if (e.delta > 0) {
      const msg = fmt(C.uiText.restoreOk, { delta: e.delta });
      if (this.modal) this.modal.message(msg); else this.toast(msg);
    }
    if (ta !== tb) this.renderer.invalidate();
  }
  /** 心烛 → 音频阶段：s1(≥85)=0，s1(<85)=1，s2=2，s3=3 */
  audioStage() {
    const t = tierOf(this.C, this.S.sanity).id;
    return t === 's3' ? 3 : t === 's2' ? 2 : this.S.sanity < 85 ? 1 : 0;
  }

  // ---------- 模态栈 ----------
  open(ui, id) {
    const { C } = this;
    let M;
    if (ui === 'interrogation') M = Interrogation;
    else if (ui === 'clueboard') M = Clueboard;
    else if (ui === 'deduction') M = Deduction;
    else if (ui === 'notebook') M = Notebook;
    else if (ui === 'item') M = ItemDetail;
    else if (ui === 'menu') M = Menu;
    else if (ui === 'closeup') M = CloseUp;
    else if (ui === 'puzzle') {
      if (this.S.solved.includes(id)) return null;
      M = puzzleClass(C.puzzles[id]?.type);
    } else M = extraUIs.get(ui);
    if (!M) { console.warn('[game] 未知界面', ui, id); return null; }
    const top = this.modal;
    if (top) top.root.hidden = true;
    const m = new M(this, id);
    this.stack.push(m);
    m.mount();
    this.music();
    this.updateHud();
    return m;
  }
  afterModalClose(m) {
    const i = this.stack.indexOf(m);
    if (i >= 0) this.stack.splice(i, 1);
    const top = this.modal;
    if (top) { top.root.hidden = false; top.render?.(); }
    this.music();
    this.renderer.invalidate();
    this.updateHud();
    // 栈空：把延后的事件交给场景；否则下一拍（可能还会继续关）再看
    setTimeout(() => this.flushPending(), 0);
  }
  flushPending() {
    if (!this.pending.length) return;
    if (this.modal && this.modal.type !== 'notebook') return; // 还在别的界面里，等它关闭
    const evs = this.pending; this.pending = [];
    if (this.modal) { const nb = this.modal; this.stack.pop(); nb.closed = true; nb.root.remove(); }
    for (const e of evs) {
      if (e.type === 'goto') { this.enterRoom(); }
      else this.handle(e);
    }
    this.updateHud();
  }
  musicModal() { return [...this.stack].reverse().find((m) => MUSIC_UI[m.type]); }
  music() {
    if (this.screen !== 'game') return;
    const mm = this.musicModal();
    this.audio.bgm(mm ? this.C.uiBgm[MUSIC_UI[mm.type]] : this.C.roomById[this.S.room]?.bgm ?? null);
  }

  // ---------- 道具 ----------
  renderInventory() {
    const { C, S, dom } = this;
    const pages = Math.max(1, Math.ceil(S.inventory.length / PAGE));
    this.invPage = Math.max(0, Math.min(pages - 1, this.invPage));
    const list = S.inventory.slice(this.invPage * PAGE, this.invPage * PAGE + PAGE);
    const slots = list.map((id) => el('button', {
      class: `slot${this.selected === id ? ' selected' : ''}${this.freshItem === id ? ' new' : ''}`, 'data-item': id, 'aria-label': this.itemName(id),
      onclick: () => this.tapItem(id),
    }, this.itemEl(id)));
    while (slots.length < PAGE) slots.push(el('button', { class: 'slot empty', disabled: true }));
    dom.slots.replaceChildren(...slots);
    dom.btnInvPrev.disabled = this.invPage <= 0;
    dom.btnInvNext.disabled = this.invPage >= pages - 1;
    dom.invLabel.classList.toggle('sel', !!this.selected); // BUGS #12：选中时字号略小 + 文案缩短，整句放得下
    if (this.selected) setRich(dom.invLabel, `<k>${this.itemName(this.selected)}</k>　${C.uiText.itemHint}`);
    else dom.invLabel.textContent = S.inventory.length ? `行囊 ${S.inventory.length} 件` : '行囊空空';
    this.freshItem = null;
  }
  tapItem(id) {
    if (this.busy) return;
    const { C, S } = this;
    if (!this.selected) { this.selected = id; this.sfx('tap'); return this.renderInventory(); }
    if (this.selected === id) { this.selected = null; this.sfx('page'); this.renderInventory(); return this.open('item', id); }
    const a = this.selected; this.selected = null;
    const evs = combineItems(C, S, a, id, Date.now());
    if (!evs) {
      this.sfx('combineFail'); this.expr = 'wry';
      this.say(fmt(C.uiText.cantCombine, { a: this.itemName(a), b: this.itemName(id) }));
      return this.renderInventory();
    }
    if (!evs.some((e) => e.type === 'combined')) this.sfx('use');
    this.closeupFor(evs);
    this.commit(evs);
  }
  /** 道具解开的谜题（use_on_item）若有 bg 特写图，先弹特写（只加画面，效果与流程不变；事件文本显示在特写下方） */
  closeupFor(evs) {
    const sv = (evs || []).find((e) => e.type === 'solved' && this.C.puzzles[e.id]?.type === 'use_on_item' && this.C.puzzleBg[e.id]);
    if (sv && this.assets.has(this.C.puzzleBg[sv.id])) return this.open('closeup', sv.id);
    return null;
  }
  useSelf(id) {
    const evs = useItemSelf(this.C, this.S, id, Date.now());
    if (evs) { this.closeupFor(evs); this.commit(evs); }
  }

  // ---------- 对话框 ----------
  say(text, { reveal = false } = {}) {
    if (!text) return;
    this.dialogQ.push({ text, reveal, expr: this.expr });
    this.expr = 'neutral';
    if (!this.dialogCur) this.nextDialog();
  }
  nextDialog() {
    const d = this.dialogQ.shift();
    if (!d) return this.hideDialog();
    const { dom } = this;
    this.dialogCur = d;
    dom.dialogLayer.hidden = false;
    dom.dialogAvatar.replaceChildren(this.edricAvatar(d.expr));
    dom.dialogName.textContent = '埃德里克';
    dom.dialogText.className = d.reveal ? 'reveal' : '';
    setRich(dom.dialogText, d.text, this.glitch());
    // 打字机：逐字显示文本节点
    const nodes = []; const walk = (n) => { for (const c of n.childNodes) c.nodeType === 3 ? nodes.push([c, c.textContent]) : walk(c); };
    walk(dom.dialogText);
    for (const [n] of nodes) n.textContent = '';
    let ni = 0, ci = 0;
    clearInterval(this.typer);
    d.typing = true;
    this.typer = setInterval(() => {
      for (let k = 0; k < 2; k++) {
        if (ni >= nodes.length) { clearInterval(this.typer); d.typing = false; return; }
        const [n, full] = nodes[ni];
        n.textContent = full.slice(0, ++ci);
        if (ci >= full.length) { ni++; ci = 0; }
      }
    }, 28);
    d.finish = () => { clearInterval(this.typer); for (const [n, full] of nodes) n.textContent = full; d.typing = false; };
  }
  advanceDialog() {
    const d = this.dialogCur;
    if (!d) return;
    if (d.typing) return d.finish();
    this.sfx('tap');
    this.nextDialog();
  }
  hideDialog() { clearInterval(this.typer); this.dialogCur = null; this.dom.dialogLayer.hidden = true; if (this.renderer?.npcTag) this.renderer.npcTag.hold = false; }

  toast(html) {
    const t = el('div', { class: 'toast' }); setRich(t, html);
    this.dom.toasts.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ---------- HUD ----------
  updateHud() {
    if (!this.S) return;
    const { C, S, dom } = this;
    const tier = tierOf(C, S.sanity).id;
    dom.stage.className = `tier-${tier}`;
    // 暗角：美术交付了 fx_vignette_s2/s3 就用图替换 CSS 渐变
    const vig = (tierOf(C, S.sanity).fx || []).find((f) => f.startsWith('fx_vignette'));
    const vigEl = (dom.vignette ??= document.getElementById('vignette'));
    if (vigEl) {
      const p = vig && this.assets.path(vig);
      vigEl.classList.toggle('art', !!p);
      vigEl.style.backgroundImage = p ? `url("../art/${p}")` : '';
    }
    dom.sanityValue.textContent = S.sanity;
    dom.waxFill.style.height = `${S.sanity}%`;
    dom.sanity.style.setProperty('--san', Math.max(0, Math.min(100, S.sanity)) / 100);
    dom.sanity.dataset.tier = tier;
    this.setFlame(tier);
    dom.roomName.textContent = C.roomNames[S.room] ?? S.room;
    dom.btnNotebook.classList.toggle('notebook-badge', this.badge);
    const nav = navTargets(C, S);
    for (const [btn, to] of [[dom.btnPrev, nav.prev], [dom.btnNext, nav.next]]) {
      btn.disabled = !to; btn.querySelector('.nav-name').textContent = to ? (C.roomNames[to] ?? to) : '';
      btn.title = to ? `前往${C.roomNames[to] ?? to}` : '';
    }
    this.audio.setSanityStage(this.screen === 'game' ? this.audioStage() : 0);
    this.renderInventory();
  }
  /** 心烛火焰（style-guide §6）：s1 稳定暗琥珀 = ui_flame_s1 静帧；s2 摇曳 = fx_candle_flicker 16fps；s3 发绿 = fx_candle_flicker_s3 12fps */
  setFlame(tier) {
    if (this.flameTier === tier) return;
    const box = (this.dom.flame ??= document.querySelector('#sanity .hc-flame'));
    if (!box) return;
    this.flameTier = tier;
    this.flameStop?.(); this.flameStop = null;
    const { assets } = this;
    const seq = tier === 's3' ? 'fx_candle_flicker_s3' : tier === 's2' ? 'fx_candle_flicker' : null;
    const frames = seq ? assets.frames(seq) : [];
    const still = `ui_flame_${tier === 's3' ? 's3' : tier === 's2' ? 's2' : 's1'}`;
    const ids = frames.length ? frames : assets.has(still) ? [still] : [];
    const imgs = ids.map((id, i) => { const im = new Image(); im.src = `../art/${assets.path(id)}`; im.alt = ''; if (i > 0) im.style.visibility = 'hidden'; return im; });
    box.replaceChildren(...imgs);
    box.dataset.flame = ids.length > 1 ? `${seq}@${tier === 's2' ? 16 : assets.meta[seq]?.fps ?? 12}` : ids[0] ?? '';
    if (imgs.length > 1) this.flameStop = playFrames(imgs, { fps: tier === 's2' ? 16 : assets.meta[seq]?.fps ?? 12, loop: true });
  }
  toggleMute() {
    const m = !this.audio.muted;
    this.audio.unlock(); this.audio.setMuted(m); prefs.set('muted', m);
    this.dom.btnMute.classList.toggle('muted', m);
    if (!m) this.sfx('tap');
  }

  // ---------- 过场 / 结局 ----------
  cutscene(id, onEnd) {
    this.inCutscene = true;
    playCutscene(this, id, { onEnd: () => { this.inCutscene = false; onEnd?.(); this.updateHud(); } });
  }
  ending() {
    this.S.ended = true; saveGame(this.C, this.S);
    const n = this.chapter, next = chapterInfo(n + 1) && this.prepareChapter ? n + 1 : null;
    setProgress({ maxChapter: next ?? n, sanity: this.S.sanity, cleared: n });
    this.audio.amb(null); this.audio.setSanityStage(0);
    this.audio.bgm(this.C.uiBgm.ending ?? null);
    this.cutscene(this.C.ending, () => {
      this.inCutscene = true;
      const box = this.dom.cutscene;
      box.hidden = false; box.onpointerup = null; box.dataset.id = 'end';
      const crest = this.assets.has('ui_crest_v3_256') ? el('img', { class: 'cs-crest', src: `../art/${this.assets.path('ui_crest_v3_256')}`, alt: '' }) : null;
      const U = this.C.uiText, cn = '一二三四五六七八九'[n] ?? n + 1;
      const close = () => { box.hidden = true; box.replaceChildren(); this.inCutscene = false; };
      const card = el('div', { class: 'cs-end', 'data-chapter': n }, crest, el('h2', { text: this.C.endingTitle || `第${'一二三四五六七八九'[n - 1] ?? n}章 · 完` }),
        el('p', { text: next ? (U.chapterNextSub ?? '故事还没有结束。') : (U.chapterEnd ?? '未完待续。') }),
        next ? el('button', { class: 'parch-btn primary', id: 'btn-next-chapter', onclick: () => { close(); this.nextChapter(); } }, fmt(U.chapterNext ?? '继续：第{cn}章', { cn, n: n + 1 })) : null,
        // 回到标题：清掉本章（已结局）的档；进度已记下，标题页“继续”会进下一章
        el('button', { class: 'parch-btn', id: 'btn-end-title', onclick: () => { close(); clearSave(this.C); this.toTitle(); } }, U.backToTitle ?? '回到标题'));
      box.replaceChildren(card);
    });
  }

  /** 第一章结局 →“继续：第二章”：载入下一章，心烛继承（至少 chapterResetMin），背包/证据/flag 不继承（06 §13.1） */
  async nextChapter() {
    const sanity = this.S?.sanity ?? null, prev = this.C;
    this.sfx('tap');
    await this.switchChapter(this.chapter + 1);
    clearSave(prev);               // 上一章已结局，档不再需要（进度里留着 maxChapter/sanity）
    this.S = this.freshChapterState(sanity);
    setProgress({ maxChapter: this.chapter, sanity: this.S.sanity, start: { [this.chapter]: this.S.sanity } });
    this.start(true);
  }

  // ---------- 测试 / 调试接口 ----------
  /** 热点在屏幕上的 client 坐标（smoke-test 用真实点击） */
  clientPointFor(hotspotId, item = null) {
    const p = pointFor(this.C, this.S, hotspotId, item, PLAY_RECT);
    if (!p) return null;
    const [x, y] = this.stage.toClient(p.x, p.y);
    return { x, y };
  }
  snapshot() {
    const S = this.S;
    if (!S) return { chapter: this.chapter, screen: this.screen, modal: null, dialog: null, dialogQ: 0, cutscene: null, audio: this.audio.debugState() };
    return {
      chapter: this.chapter, room: S.room, sanity: S.sanity, tier: tierOf(this.C, S.sanity).id, inventory: [...S.inventory], evidence: [...S.evidence],
      flags: Object.keys(S.flags), solved: [...S.solved], seen: [...(S.seen || [])], once: Object.keys(S.once || {}), ended: S.ended, selected: this.selected, invPage: this.invPage,
      modal: this.modal ? `${this.modal.type}:${this.modal.id}` : null, stack: this.stack.map((m) => `${m.type}:${m.id}`),
      dialog: this.dialogCur?.text ?? null, dialogQ: this.dialogQ.length, cutscene: this.inCutscene ? this.dom.cutscene.dataset.id : null,
      screen: this.screen, audio: this.audio.debugState(), bg: this.renderer?.S ? this.renderer.bgId() : null,
      drawnBg: this.renderer?.cache?.bg ?? null, overlays: this.renderer?.cache?.overlays ?? [], artOverlays: this.renderer?.cache?.artOverlays ?? [], fx: [...(this.renderer?.drawnFx || [])], npcTags: [...(this.renderer?.drawnNpcTags || [])], npcSpots: [...(this.renderer?.drawnNpcSpots || [])], crow: this.renderer?.drawnCrow ?? null, renderErrors: [...(window.__renderErrors || [])],
      lastSanityReason: this.lastSanityReason ?? null,
    };
  }
}
