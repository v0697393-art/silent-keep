// 谜题插件注册表：chapter1.json puzzles[id].type → 界面类。
// 新谜题类型：在这里 register('type', Class)，Class 继承 PuzzleBase（见 rotate-grid.js / dial.js）。
// use_on_item 类型没有界面：在道具栏里把两件道具组合即触发（logic.combineItems → findItemPuzzle）。
import { RotateGrid } from './rotate-grid.js';
import { Dial } from './dial.js';

const registry = new Map();
export const register = (type, cls) => registry.set(type, cls);
export const puzzleClass = (type) => registry.get(type) ?? null;
register('rotate_grid', RotateGrid);
register('dial', Dial);
