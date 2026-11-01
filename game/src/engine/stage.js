// 固定逻辑分辨率 + 等比缩放 + devicePixelRatio 适配 + 安全区
export const LOGICAL_W = 1080, LOGICAL_H = 1920;

export class Stage {
  constructor({ safeEl, stageEl, canvas, onResize }) {
    this.safeEl = safeEl; this.stageEl = stageEl; this.canvas = canvas; this.onResize = onResize;
    this.scale = 1; this.pixelRatio = 1;
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
    this.onResize?.();
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
