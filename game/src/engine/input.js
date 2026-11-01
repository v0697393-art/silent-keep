// 触控/鼠标统一输入：只把“轻触”（位移小、时间短）当作点击，并阻止页面滚动、缩放、长按菜单。
export function preventBrowserGestures() {
  const block = (e) => e.preventDefault();
  document.addEventListener('touchmove', block, { passive: false });
  document.addEventListener('gesturestart', block);
  document.addEventListener('gesturechange', block);
  document.addEventListener('dblclick', block);
  document.addEventListener('contextmenu', block);
  // iOS 双击缩放：快速连续 touchend 时阻止默认（不影响按钮 click）
  let last = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - last < 300 && !e.target.closest('button')) e.preventDefault();
    last = now;
  }, { passive: false });
}

export class TapInput {
  /** @param el 监听元素  @param toLogical (clientX, clientY) => [x, y]  @param onTap (x, y) => void */
  constructor(el, toLogical, onTap, { maxMove = 12, maxTime = 800 } = {}) {
    const downs = new Map();
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
    });
    el.addEventListener('pointerup', (e) => {
      const d = downs.get(e.pointerId);
      downs.delete(e.pointerId);
      if (!d || downs.size) return; // 多指操作不算点击
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > maxMove || performance.now() - d.t > maxTime) return;
      onTap(...toLogical(e.clientX, e.clientY));
    });
    el.addEventListener('pointercancel', (e) => downs.delete(e.pointerId));
  }
}
