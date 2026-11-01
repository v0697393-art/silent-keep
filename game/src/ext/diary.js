// 日记（扩展位占位）：第二章起开放；目前把手记笔记按时间列出。
import { el } from '../ui/dom.js';

export const Diary = {
  id: 'diary', label: '日记',
  render(game, page) {
    page.append(el('h3', { text: '布伦丹的日记' }));
    page.append(el('div', { class: 'ext-placeholder', text: '〔扩展位〕日记界面将在后续章节开放（翻页、撕页、隐写）。实现见 src/ext/diary.js，用 registerNotebookTab 注册。' }));
  },
};
