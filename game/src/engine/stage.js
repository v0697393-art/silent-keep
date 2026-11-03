// 固定逻辑分辨率 + 等比缩放 + devicePixelRatio 适配 + 安全区
// 触控手机横屏时舞台会缩成一条（高只有三百多像素），盖一层「请把手机竖过来」并挡住操作。桌面不挡。
export const LOGICAL_W = 1080, LOGICAL_H = 1920;

/** 触控手机（短边 < 600）。桌面鼠标（fine + hover）和短边 ≥ 600 的平板都不算。 */
export function isPhone() {
  const w = screen.width || window.innerWidth, h = screen.height || window.innerHeight;
  if (Math.min(w, h) >= 600) return false;
  if (window.matchMedia('(pointer: fine)').matches && window.matchMedia('(hover: hover)').matches) return false;
  return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches || navigator.maxTouchPoints > 0;
}

/** 手机横过来：舞台按短边缩放，格子和顶栏会小到点不准。 */
export function phoneLandscape() {
  if (!isPhone()) return false;
  const vv = window.visualViewport;
  const w = vv?.width || window.innerWidth, h = vv?.height || window.innerHeight;
  return w > h;
}

export class Stage {
  constructor({ safeEl, stageEl, canvas, onResize }) {
    this.safeEl = safeEl; this.stageEl = stageEl; this.canvas = canvas; this.onResize = onResize;
    this.scale = 1; this.pixelRatio = 1;
    this.rotateLock = false;
    this.resize = this.resize.bind(this);
    addEventListener('resize', this.resize);
    addEventListener('orientationchange', () => setTimeout(this.resize, 200));
    window.visualViewport?.addEventListener('resize', this.resize);
    this.resize();
  }
  resize() {
    const r = this.safeEl.getBoundingClientRect();
    const s = Math.min(r.width / LOGICAL_W, r.height / LOGICAL_H);
    this.scale = s;
    const x = Math.round((r.width - LOGICAL_W * s) / 2), y = Math.round((r.height - LOGICAL_H * s) / 2);
    this.stageEl.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    // canvas 后备缓冲 = 实际显示像素（逻辑尺寸 × 缩放 × DPR），上限 1.0 倍逻辑分辨率×2
    const dpr = window.devicePixelRatio || 1;
    this.pixelRatio = Math.min(s * dpr, 2);
    this.canvas.width = Math.round(LOGICAL_W * this.pixelRatio);
    this.canvas.height = Math.round(LOGICAL_H * this.pixelRatio);
    this.updateRotateLock();
    this.onResize?.();
  }
  /** 横屏手机：视口级遮罩（不跟着舞台缩小）。转回竖屏即收起。 */
  updateRotateLock() {
    const lock = phoneLandscape();
    this.rotateLock = lock;
    const el = document.getElementById('rotate-lock');
    if (el) el.hidden = !lock;
    document.body.classList.toggle('rotate-locked', lock);
  }
  /** 屏幕 client 坐标 → 逻辑坐标 */
  toLogical(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return [((clientX - r.left) / r.width) * LOGICAL_W, ((clientY - r.top) / r.height) * LOGICAL_H];
  }
  /** 逻辑坐标 → 屏幕 client 坐标（测试/调试用） */
  toClient(x, y) {
    const r = this.canvas.getBoundingClientRect();
    return [r.left + (x / LOGICAL_W) * r.width, r.top + (y / LOGICAL_H) * r.height];
  }
}
