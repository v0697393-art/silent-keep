// 扩展位：家谱 / 日记等手记分页与独立界面在这里注册，不需要改引擎。
//   registerNotebookTab({ id, label, visible(game)?, render(game, pageEl) })
//   registerUI(type, ModalClass)  → 事件 {type:'open', ui:type, id} 即可打开
import { FamilyTree } from './familytree.js';
import { Diary } from './diary.js';

export const notebookTabs = [];
export const extraUIs = new Map();
export const registerNotebookTab = (tab) => notebookTabs.push(tab);
export const registerUI = (type, cls) => extraUIs.set(type, cls);

registerNotebookTab(FamilyTree);
registerNotebookTab(Diary);
