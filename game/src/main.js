// 启动：章节数据（章节表 CHAPTERS：design/data/chapter<n>.json + 补丁）+ 素材清单 + 美术热区覆盖/叠加层 → 各模块 → 标题页
// ?ch=2 直接进第二章（测试用）；缺省 = 存档进度里的章节（hushwold_progress.maxChapter），都没有为 1。
import { Stage } from './engine/stage.js';
import { TapInput, preventBrowserGestures } from './engine/input.js';
import { Assets } from './engine/assets.js';
import { AudioManager } from './engine/audio.js';
import { Renderer } from './engine/renderer.js';
import { loadChapter, applyHotspotFile, applyArtOverlayDefs, finalizeChapter, chapterInfo } from './engine/chapter.js';
import { prefs, getProgress } from './engine/save.js';
import { Game } from './engine/game.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

async function fetchJson(url, fallback) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`加载失败：${url}（${e.message}）`);
  }
}

// 界面美术（art/ui）：CSS 里直接引用这些图；全部交付才切到美术皮肤（body.ui-art），否则保留 CSS 画的占位界面，避免 404
const UI_ART = ['ui_heart_candle_top', 'ui_heart_candle_body', 'ui_heart_candle_base', 'ui_flame_s1', 'ui_inventory_bar', 'ui_slot_selected',
  'ui_btn_round_iron', 'ui_btn_round_seal', 'ui_icon_back_light_96', 'ui_icon_journal_light_96', 'ui_icon_gear_light_96', 'ui_icon_close_light_96',
  'ui_button', 'ui_btn_present', 'ui_btn_present_pressed', 'ui_dialog_box', 'ui_dialog_name', 'ui_portrait_frame', 'ui_portrait_mask',
  'ui_tab_blank', 'ui_tab_evidence', 'ui_tab_evidence_on', 'ui_tab_board', 'ui_tab_board_on', 'ui_tab_deduce', 'ui_tab_deduce_on',
  'ui_journal_bg', 'ui_cork_board', 'ui_testimony_strip', 'ui_testimony_strip_selected', 'ui_stamp_seal', 'ui_loading', 'ui_loading_bar_bg', 'ui_loading_bar_fill',
  'ui_crest_v3_256', 'ui_pin', 'fx_dust_01', 'fx_dust_02'];
/** 载入页（ui_loading + 进度条）：预载界面图，进度条按已载入张数走；缺图就直接跳过 */
async function preloadUi(assets) {
  const box = $('#loading'), fill = box?.querySelector('.ld-fill');
  const have = UI_ART.filter((id) => assets.has(id));
  const art = have.length === UI_ART.length;
  document.body.classList.toggle('ui-art', art);
  if (!art) console.info('[ui] 界面美术未交付齐，缺：', UI_ART.filter((id) => !assets.has(id)).join(', '));
  let n = 0;
  await Promise.all(have.map((id) => new Promise((res) => {
    const im = new Image(); im.onload = im.onerror = () => { n++; if (fill) fill.style.width = `${(100 * n) / have.length}%`; res(); };
    im.src = `../art/${assets.path(id)}`;
  })));
  if (box) { box.classList.add('done'); setTimeout(() => box.remove(), 600); }
}

async function boot() {
  preventBrowserGestures();
  const manifest = await fetchJson('assets-manifest.json', { art: [], audio: [], hotspots: [], audioManifest: null });
  const hotspotData = new Map(); // 热区文件只拉一次，切章时复用
  /** 载入第 n 章并接好美术数据（热区坐标、叠加层、特效差分、NPC 站位）；章节衔接时 Game 再调用 */
  const prepareChapter = async (n) => {
    const C = await loadChapter((u) => fetchJson(u), { n });
    // 美术交付的 *hotspots*.json 覆盖热区坐标（清单里有才请求，避免 404）；不属于本章房间的文件自动跳过
    for (const rel of manifest.hotspots || []) {
      if (!hotspotData.has(rel)) hotspotData.set(rel, await fetchJson(`../art/${rel}`, null));
      const data = hotspotData.get(rel);
      if (data) applyHotspotFile(C, rel, data);
    }
    applyArtOverlayDefs(C, manifest.overlayDefs || []); // art/bg/manifest.json 里带 layer+show 的叠加层
    finalizeChapter(C); // 热区收进游戏区（记 C.rectClamps）→ NPC 站位：json → 美术热区文件 layers → 补丁 npcLayers → 入口热点（inScene 不画）
    return C;
  };
  const chParam = params.has('ch') ? Number(params.get('ch')) : null;
  const startCh = chapterInfo(chParam) ? chParam : chapterInfo(getProgress()?.maxChapter) ? getProgress().maxChapter : 1;
  const C = await prepareChapter(startCh);
  // 音频清单优先用 audio/audio_manifest.json（音乐那边更新后不必重跑扫描也能拿到最新循环点）
  const audioManifest = await fetchJson('../audio/audio_manifest.json', null) ?? manifest.audioManifest ?? null;

  const canvas = $('#scene');
  let renderer;
  const stage = new Stage({ safeEl: $('#safe'), stageEl: $('#stage'), canvas, onResize: () => renderer?.setPixelRatio(stage.pixelRatio) });
  const assets = new Assets(manifest.art || [], manifest.meta || {});
  await preloadUi(assets);
  const audio = new AudioManager({ files: manifest.audio || [], manifest: audioManifest, alias: C.audioAlias, muted: prefs.get('muted', false) });
  renderer = new Renderer(canvas, assets, { debug: params.has('debug') });
  renderer.setPixelRatio(stage.pixelRatio);
  assets.onLoad = () => renderer.invalidate();
  if (params.has('debug')) document.body.classList.add('debug-on');

  const dom = {
    stage: $('#stage'), title: $('#title-screen'), btnNew: $('#btn-new'), btnContinue: $('#btn-continue'),
    sanity: $('#sanity'), sanityValue: $('#sanity-value'), waxFill: $('.wax-fill'), roomName: $('#room-name'),
    btnNotebook: $('#btn-notebook'), btnMute: $('#btn-mute'), btnMenu: $('#btn-menu'),
    invLabel: $('#inv-label'), slots: $('#slots'), btnPrev: $('#btn-prev-room'), btnNext: $('#btn-next-room'),
    btnInvPrev: $('#btn-inv-prev'), btnInvNext: $('#btn-inv-next'),
    dialogLayer: $('#dialog-layer'), dialogAvatar: $('#dialog-avatar'), dialogName: $('#dialog-name'), dialogText: $('#dialog-text'),
    toasts: $('#toasts'), modalRoot: $('#modal-root'), cutscene: $('#cutscene'),
  };
  dom.btnMute.classList.toggle('muted', audio.muted);
  const game = new Game({ C, assets, audio, renderer, stage, dom, prepareChapter, chParam: chapterInfo(chParam) ? chParam : null });

  // 首次触摸解锁音频（iOS/Chrome 自动播放策略）
  const unlock = () => audio.unlock();
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('touchend', unlock, { capture: true });

  new TapInput(canvas, (cx, cy) => stage.toLogical(cx, cy), (x, y) => game.onTap(x, y));
  addEventListener('pagehide', () => game.S && game.commit([]));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.ctx?.suspend().catch(() => {}); else audio.ctx?.resume().catch(() => {});
  });

  // BUGS #10：先排下一帧再画——某一帧抛异常也不会让渲染循环停掉（以前画面会定格在上一个房间，而 HUD 照常更新）
  const loop = (t) => {
    requestAnimationFrame(loop);
    try { if (renderer.S && game.screen === 'game') renderer.frame(t); } catch (err) {
      (window.__renderErrors ??= []).push(`frame: ${err?.message || err}`);
      if (window.__renderErrors.length < 4) console.error('[loop]', err);
    }
  };
  requestAnimationFrame(loop);
  game.toTitle();
  window.__game = { game, get C() { return game.C; }, stage, assets, audio, prepareChapter, snap: () => game.snapshot(), point: (id, item) => game.clientPointFor(id, item) };
}

boot().catch((e) => {
  console.error(e);
  const b = $('#boot-error'); b.hidden = false; b.textContent = `启动失败：${e.message}`;
});
