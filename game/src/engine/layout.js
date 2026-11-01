// 画面布局常量（逻辑坐标 1080×1920），依据 art/style-guide.md §5/§6 与 design/04：
//   顶部安全区 120（心烛、房间名、手记、菜单）
//   游戏区 1080×1540（y 120–1660），主要解谜物件放在这里
//   底部安全区 260（y 1660–1920）：40px 道具说明条 + 1080×220 道具栏（y 1700–1920）
// 浏览器 UI 与 tools/verify.mjs 共用，verify 用它检查热区是否落在游戏区外。
export const W = 1080, H = 1920;
export const LAYOUT = {
  W, H,
  hudBottom: 120,              // 顶部安全区
  playBottom: 1660,            // 游戏区下沿 = 120 + 1540
  safeBottom: 260,             // 底部安全区高度
  invTop: H - 220,             // 道具栏本体 1080×220
  dialogBottom: 1660 - 20,     // 对话框下沿（盖在游戏区底部，点击任意处关闭）
};
/** 场景里可点击的区域 = 游戏区 1080×1540 */
export const PLAY_RECT = [0, LAYOUT.hudBottom, W, LAYOUT.playBottom - LAYOUT.hudBottom];
