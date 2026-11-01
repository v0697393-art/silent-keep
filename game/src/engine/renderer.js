// 场景渲染（Canvas，逻辑坐标 1080×1920）。
// 有背景图（bg_xxx 或其状态差分，见补丁 bgVariants）就画背景；否则画程序生成的占位房间 + 带标签的热区物件。
// NPC 全身站姿图层（C.npcLayers，见 chapter.js resolveNpcLayers）画进静态层，只是画面，点击判定只看热点 rect。
// 房间特效 rooms[].fx（06 §12.2）画在背景与 NPC 之间。
// 叠加：烛光摇曳、心烛 s3 墨迹触须、s3 假热区微光、点击空白处的热区提示闪光、乌鸦小精灵、换房间墨迹转场、?debug=1 热区框。
import { W, H, PLAY_RECT, LAYOUT } from './layout.js';
import { hotspotActive, reqOk, tierHas, tierOf, roomFxActive } from './logic.js';
import { PAL, FONT, rng, parchment } from './assets.js';

const ROOM_TINT = {
  r1_hall: { wall: ['#3a2a1e', '#1f1712'], floor: '#2b2119', accent: PAL.amber },
  r2_scriptorium: { wall: ['#2f2a20', '#191510'], floor: '#2a2016', accent: PAL.straw },
  r3_crypt: { wall: ['#1f2b22', '#0f1410'], floor: '#18201a', accent: PAL.olive },
};
const LIGHTS = { h_fireplace: 1, h_candles: 0.8, h_window: 0.5 };

export class Renderer {
  constructor(canvas, assets, { debug = false } = {}) {
    this.canvas = canvas; this.g = canvas.getContext('2d'); this.assets = assets; this.debug = debug;
    this.pixelRatio = 1; this.C = null; this.S = null;
    this.cache = { key: null, canvas: null };
    this.flashes = []; this.fade = null; this.crowFly = null; this.t0 = performance.now();
  }
  setPixelRatio(pr) { this.pixelRatio = pr; this.cache.key = null; }
  bind(C, S) { this.C = C; this.S = S; this.cache.key = null; }
  invalidate() { this.cache.key = null; }

  bgId(roomId = this.S.room) {
    const r = this.C.roomById[roomId];
    for (const v of this.C.bgVariants[roomId] || []) if (reqOk(this.S, v.req) && this.assets.has(v.bg)) return v.bg;
    return r?.bg;
  }
  flash(ids) { const t = performance.now(); for (const id of ids) this.flashes.push({ id, t }); }
  transition() { this.fade = { t: performance.now(), dur: 700 }; }
  crowFlyAway() { this.crowFly = performance.now(); }

  /** 静态层（背景 + 热区物件）缓存，状态变化时重画 */
  staticLayer() {
    const { C, S } = this;
    const r = C.roomById[S.room];
    const bg = this.bgId();
    const img = this.assets.image(bg);
    const act = r.hotspots.map((h) => (hotspotActive(S, h) ? 1 : 0)).join('');
    const key = `${S.room}|${bg}|${img ? 1 : 0}|${act}|${this.debug}|${this.pixelRatio}`;
    if (this.cache.key === key) return this.cache.canvas;
    const c = this.cache.canvas ?? document.createElement('canvas');
    c.width = Math.round(W * this.pixelRatio); c.height = Math.round(H * this.pixelRatio);
    const g = c.getContext('2d');
    g.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    if (img) g.drawImage(img, 0, 0, W, H);
    else this.drawPlaceholderRoom(g, r);
    this.cache = { key, canvas: c };
    return c;
  }

  /** 当前房间要画的 NPC 图层：入口热点仍“有反应”（NPC 还在场）且满足可选 req */
  npcLayersHere() {
    const { C, S } = this, r = C.roomById[S.room];
    return (C.npcLayers || []).filter((l) => l.room === S.room && reqOk(S, l.req)
      && (!l.hotspot || r.hotspots.some((h) => h.id === l.hotspot && hotspotActive(S, h))));
  }
  /** 全身图等比缩放进 rect（contain），水平居中、底边对齐（脚踩在 rect 底边），绝不拉伸 */
  drawNpcLayer(g, l) {
    const img = this.assets.image(l.img);
    if (!img) return; // 未交付：占位房间里热区本身已画了人影
    const [x, y, w, hh] = l.rect;
    const k = Math.min(w / img.naturalWidth, hh / img.naturalHeight);
    const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
    g.drawImage(img, x + (w - dw) / 2, y + hh - dh, dw, dh);
  }

  drawPlaceholderRoom(g, r) {
    const tint = ROOM_TINT[r.id] ?? ROOM_TINT.r1_hall;
    const R = rng(r.id);
    const wall = g.createLinearGradient(0, 0, 0, 1250);
    wall.addColorStop(0, tint.wall[1]); wall.addColorStop(1, tint.wall[0]);
    g.fillStyle = wall; g.fillRect(0, 0, W, 1250);
    // 石块
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 3;
    for (let y = 0, row = 0; y < 1250; y += 90, row++) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      for (let x = (row % 2) * 80; x < W; x += 160 + R() * 20) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 90); g.stroke(); }
    }
    // 地面（一点透视）
    const fl = g.createLinearGradient(0, 1250, 0, H);
    fl.addColorStop(0, tint.floor); fl.addColorStop(1, PAL.ink);
    g.fillStyle = fl; g.fillRect(0, 1250, W, H - 1250);
    g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 2;
    for (let i = -6; i <= 6; i++) { g.beginPath(); g.moveTo(540 + i * 40, 1250); g.lineTo(540 + i * 260, H); g.stroke(); }
    for (let y = 1290; y < H; y += (y - 1200) * 0.35) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    // 热区物件：按数组顺序（后面的在上层）
    for (const h of r.hotspots) this.drawHotspotPlaceholder(g, h, tint);
    // 角落文字
    g.fillStyle = 'rgba(168,134,92,.5)'; g.font = `24px ${FONT}`; g.textAlign = 'left';
    g.fillText(`〔占位场景 ${r.bg ?? r.id}，美术交付后自动替换〕`, 24, LAYOUT.playBottom - 16);
  }

  drawHotspotPlaceholder(g, h, tint) {
    const { S, C } = this;
    const [x, y, w, hh] = h.rect;
    const active = hotspotActive(S, h);
    const label = C.hotspotLabels[h.id] ?? h.id;
    const small = w * hh < 40000;
    g.save();
    g.globalAlpha = active ? 1 : 0.45;
    if (small) {
      // 回复点、灰堆之类的小区域：虚线框
      g.setLineDash([12, 10]); g.strokeStyle = 'rgba(201,162,90,.55)'; g.lineWidth = 3;
      g.strokeRect(x + 4, y + 4, w - 8, hh - 8); g.setLineDash([]);
    } else {
      const grd = g.createLinearGradient(x, y, x, y + hh);
      grd.addColorStop(0, 'rgba(122,90,62,.55)'); grd.addColorStop(1, 'rgba(43,33,25,.75)');
      g.fillStyle = grd;
      this.roughRect(g, x + 6, y + 6, w - 12, hh - 12, h.id);
      g.fill();
      g.strokeStyle = PAL.ink; g.lineWidth = 5; g.stroke();
      g.strokeStyle = 'rgba(201,162,90,.35)'; g.lineWidth = 2; g.stroke();
      this.drawGlyph(g, h, x, y, w, hh);
    }
    // 标签
    g.font = `${small ? 26 : 32}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(label).width + 28, cx = x + w / 2, cy = small ? y + hh / 2 : y + Math.min(hh - 30, 44);
    parchment(g, cx - tw / 2, cy - 22, tw, 44, h.id);
    g.strokeStyle = PAL.ink; g.lineWidth = 2; g.strokeRect(cx - tw / 2, cy - 22, tw, 44);
    g.fillStyle = PAL.umber; g.fillText(label, cx, cy + 1);
    g.restore();
  }
  roughRect(g, x, y, w, h, seed) {
    const R = rng(seed), j = () => (R() - 0.5) * 8;
    g.beginPath(); g.moveTo(x + j(), y + j()); g.lineTo(x + w + j(), y + j()); g.lineTo(x + w + j(), y + h + j()); g.lineTo(x + j(), y + h + j()); g.closePath();
  }
  /** 极简墨线示意（让占位房间可读）：门拱、窗、火、井口、棺、人影 */
  drawGlyph(g, h, x, y, w, hh) {
    const id = h.id; g.save(); g.strokeStyle = 'rgba(232,223,200,.35)'; g.lineWidth = 4; g.lineCap = 'round';
    const cx = x + w / 2, cy = y + hh / 2 + 20;
    g.beginPath();
    if (/door/.test(id)) { g.moveTo(x + 30, y + hh - 10); g.lineTo(x + 30, y + hh * 0.45); g.quadraticCurveTo(cx, y + 40, x + w - 30, y + hh * 0.45); g.lineTo(x + w - 30, y + hh - 10); }
    else if (/window/.test(id)) { g.rect(x + 40, y + 80, w - 80, hh - 120); g.moveTo(cx, y + 80); g.lineTo(cx, y + hh - 40); }
    else if (/fireplace/.test(id)) { g.moveTo(x + 40, y + hh - 10); g.lineTo(x + 40, y + 120); g.lineTo(x + w - 40, y + 120); g.lineTo(x + w - 40, y + hh - 10); }
    else if (/well|chain/.test(id)) { g.ellipse(cx, cy, w / 2.6, hh / 4, 0, 0, 7); }
    else if (/steward|lady/.test(id)) { g.arc(cx, y + 150, 46, 0, 7); g.moveTo(cx - 80, y + hh - 20); g.quadraticCurveTo(cx, y + 180, cx + 80, y + hh - 20); }
    else if (/coffin/.test(id)) { for (let i = 0; i < 3; i++) g.rect(x + 30, y + 90 + i * (hh - 120) / 3, w - 60, (hh - 120) / 3 - 20); }
    else if (/portrait|tapestry|board|relief|drawing/.test(id)) { g.rect(x + 30, y + 70, w - 60, hh - 100); }
    else if (/armor/.test(id)) { g.arc(cx, y + 130, 45, 0, 7); g.rect(cx - 60, y + 190, 120, hh - 260); }
    g.stroke(); g.restore();
  }

  frame(now = performance.now()) {
    const { C, S, g } = this;
    if (!C || !S) return;
    const pr = this.pixelRatio;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.staticLayer(), 0, 0);
    g.setTransform(pr, 0, 0, pr, 0, 0);
    const r = C.roomById[S.room];
    const t = (now - this.t0) / 1000;
    // 房间特效（06 §12.2：背景之上、热点高亮与 NPC 立绘之下；同 id 多条 OR 合并只画一次；不参与点击判定）
    for (const f of roomFxActive(C, S)) {
      const img = this.assets.frameImage(f.id, t, f.fps);
      if (img) g.drawImage(img, ...f.rect);
    }
    // NPC 全身站姿（每帧画，叠在房间特效之上）
    for (const l of this.npcLayersHere()) this.drawNpcLayer(g, l);
    // 烛光摇曳
    for (const h of r.hotspots) {
      const k = LIGHTS[h.id]; if (!k) continue;
      const [x, y, w, hh] = h.rect, cx = x + w / 2, cy = y + hh / 2;
      const a = (0.10 + 0.05 * Math.sin(t * 7.3 + x) + 0.03 * Math.sin(t * 13.1)) * k;
      const grd = g.createRadialGradient(cx, cy, 10, cx, cy, Math.max(w, hh) * 1.1);
      grd.addColorStop(0, `rgba(201,162,90,${a * 2})`); grd.addColorStop(1, 'rgba(201,162,90,0)');
      g.fillStyle = grd; g.fillRect(cx - w * 1.2, cy - hh * 1.2, w * 2.4, hh * 2.4);
    }
    // 可交互物件呼吸光晕（只在有美术背景时；占位图已有标签）
    if (this.assets.image(this.bgId())) {
      const a = 0.12 * (0.5 + 0.5 * Math.sin(t * Math.PI));
      for (const h of r.hotspots) if (hotspotActive(S, h)) {
        const [x, y, w, hh] = h.rect;
        const grd = g.createRadialGradient(x + w / 2, y + hh / 2, 4, x + w / 2, y + hh / 2, Math.min(w, hh) / 2);
        grd.addColorStop(0, `rgba(201,162,90,${a})`); grd.addColorStop(1, 'rgba(201,162,90,0)');
        g.fillStyle = grd; g.fillRect(x, y, w, hh);
      }
    }
    this.drawCrow(g, r, now);
    // 提示闪光
    this.flashes = this.flashes.filter((f) => now - f.t < 900);
    for (const f of this.flashes) {
      const h = r.hotspots.find((x) => x.id === f.id); if (!h) continue;
      const p = (now - f.t) / 900, [x, y, w, hh] = h.rect;
      g.strokeStyle = `rgba(201,162,90,${0.8 * Math.sin(p * Math.PI)})`; g.lineWidth = 6;
      g.strokeRect(x + 8, y + 8, w - 16, hh - 16);
    }
    // 心烛 s3：假热区微光 + 边缘墨迹触须
    if (tierHas(C, S, 'fake_hotspots')) for (const f of C.sanity.fakeHotspots?.[S.room] || []) {
      const [x, y, w, hh] = f.rect, a = 0.18 + 0.12 * Math.sin(t * 2.3 + x);
      const grd = g.createRadialGradient(x + w / 2, y + hh / 2, 2, x + w / 2, y + hh / 2, w / 2);
      grd.addColorStop(0, `rgba(110,122,90,${a})`); grd.addColorStop(1, 'rgba(110,122,90,0)');
      g.fillStyle = grd; g.fillRect(x, y, w, hh);
    }
    if (tierHas(C, S, 'fx_ink_tendril')) this.drawTendrils(g, t);
    // 转场：墨迹晕染
    if (this.fade) {
      const p = (now - this.fade.t) / this.fade.dur;
      if (p >= 1) this.fade = null;
      else { g.fillStyle = `rgba(26,20,16,${1 - p})`; g.fillRect(0, 0, W, H); }
    }
    if (this.debug) this.drawDebug(g, r);
  }

  drawCrow(g, r, now) {
    const win = r.hotspots.find((h) => h.id === 'h_window'); if (!win) return;
    const [x, y, w, hh] = win.rect;
    const lay = (this.C.artLayers?.[r.id] || []).find((l) => l.id === 'char_crow_perch' && Array.isArray(l.rect));
    let frame = null, px = lay ? lay.rect[0] : x + w / 2 - 96, py = lay ? lay.rect[1] : y + hh - 230;
    if (this.crowFly && now - this.crowFly < 1400) {
      const p = (now - this.crowFly) / 1400; frame = 'char_crow_fly'; px += p * 500; py -= p * 420;
    } else if (!this.S.flags.got_spectacles) frame = Math.floor(now / 1800) % 3 === 2 ? 'char_crow_tilt' : 'char_crow_perch';
    if (!frame) return;
    const img = this.assets.image(frame);
    if (img) g.drawImage(img, px, py, 192, 192);
    else { // 占位乌鸦剪影
      g.fillStyle = PAL.ink; g.beginPath(); g.ellipse(px + 96, py + 120, 50, 34, 0, 0, 7); g.arc(px + 140, py + 84, 22, 0, 7); g.fill();
      g.beginPath(); g.moveTo(px + 160, py + 80); g.lineTo(px + 186, py + 90); g.lineTo(px + 160, py + 94); g.fill();
    }
  }

  drawTendrils(g, t) {
    // 帧序列 fx_ink_tendril_01…_NN（数量由交付决定）；有同名 .json 用其 fps，没有按 8fps 循环；没交付才画程序触须
    const img = this.assets.frameImage('fx_ink_tendril', t, this.assets.meta.fx_ink_tendril?.fps ?? 8);
    if (img) { g.globalAlpha = 0.8; g.drawImage(img, 0, 0, W, H); g.globalAlpha = 1; return; }
    g.save(); g.strokeStyle = 'rgba(26,20,16,.85)'; g.lineCap = 'round';
    const R = rng('tendril');
    for (let i = 0; i < 14; i++) {
      const side = i % 4, base = R() * (side < 2 ? H : W), len = 120 + R() * 220 + Math.sin(t * 0.8 + i) * 40;
      let x0, y0, dx, dy;
      if (side === 0) { x0 = 0; y0 = base; dx = 1; dy = 0; } else if (side === 1) { x0 = W; y0 = base; dx = -1; dy = 0; }
      else if (side === 2) { x0 = base; y0 = LAYOUT.hudBottom; dx = 0; dy = 1; } else { x0 = base; y0 = LAYOUT.playBottom; dx = 0; dy = -1; }
      const wob = Math.sin(t * 1.3 + i * 2) * 50;
      g.lineWidth = 10 + R() * 12;
      g.beginPath(); g.moveTo(x0, y0);
      g.bezierCurveTo(x0 + dx * len * 0.4 + dy * wob, y0 + dy * len * 0.4 + dx * wob, x0 + dx * len * 0.7 - dy * wob, y0 + dy * len * 0.7 - dx * wob, x0 + dx * len, y0 + dy * len);
      g.stroke();
    }
    g.restore();
  }

  drawDebug(g, r) {
    g.save(); g.lineWidth = 2; g.font = `22px ${FONT}`; g.textAlign = 'left';
    g.strokeStyle = 'rgba(0,255,255,.6)'; g.strokeRect(...PLAY_RECT);
    for (const h of r.hotspots) {
      g.strokeStyle = hotspotActive(this.S, h) ? 'rgba(255,60,60,.9)' : 'rgba(120,120,120,.7)';
      g.strokeRect(...h.rect); g.fillStyle = '#ff6'; g.fillText(h.id + (h.rectDesign ? ' *' : ''), h.rect[0] + 4, h.rect[1] + 22);
    }
    g.setLineDash([10, 6]);
    for (const f of this.C.sanity.fakeHotspots?.[r.id] || []) { g.strokeStyle = 'rgba(255,0,255,.9)'; g.strokeRect(...f.rect); g.fillStyle = '#f6f'; g.fillText('fake', f.rect[0] + 4, f.rect[1] + 22); }
    for (const l of this.npcLayersHere?.() || []) { g.strokeStyle = 'rgba(0,200,255,.8)'; g.strokeRect(...l.rect); g.fillStyle = '#6cf'; g.fillText(l.img, l.rect[0] + 4, l.rect[1] + l.rect[3] - 8); }
    g.setLineDash([]);
    g.fillStyle = '#ff6'; g.fillText(`sanity ${this.S.sanity} ${tierOf(this.C, this.S.sanity).id}`, 20, 160);
    g.restore();
  }
}
