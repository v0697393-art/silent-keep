// 家谱（扩展位示例）：莫尔德雷克家谱四个“献名年份”节点，随证据解锁；线索板解开后标出 37 年周期。
import { el } from '../ui/dom.js';

const NODES = [
  { year: 1238, name: '希尔德布兰', x: 25, y: 12 },
  { year: 1275, name: '罗泽琳', x: 75, y: 34 },
  { year: 1312, name: '▇▇', x: 25, y: 56, blank: true },
  { year: 1349, name: '？', x: 75, y: 78, now: true },
];
export const FamilyTree = {
  id: 'familytree', label: '家谱',
  render(game, page) {
    const { S } = game;
    const known = S.evidence.includes('ev_revealed_tree');
    const cycle = !!S.flags.cb_cycle_solved;
    page.append(el('h3', { text: '莫尔德雷克家谱（摹本）' }));
    if (!known) page.append(el('div', { class: 'ext-placeholder', text: '家谱上有几处被刮掉的名字。也许能用什么办法让刮痕显出来。' }));
    const tree = el('div', { class: 'ftree' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('preserveAspectRatio', 'none');
    for (let i = 0; i < NODES.length - 1; i++) {
      const a = NODES[i], b = NODES[i + 1];
      const l = document.createElementNS(svg.namespaceURI, 'line');
      Object.entries({ x1: a.x, y1: a.y + 4, x2: b.x, y2: b.y, stroke: cycle ? '#7A2E25' : '#7A5A3E', 'stroke-width': cycle ? 0.8 : 0.4, 'stroke-dasharray': cycle ? '' : '1 1' }).forEach(([k, v]) => l.setAttribute(k, v));
      svg.append(l);
    }
    tree.append(svg);
    for (const n of NODES) tree.append(el('div', { class: `node${n.blank ? ' blank' : ''}${known ? '' : ' unknown'}`, style: { left: `${n.x}%`, top: `${n.y}%` } },
      known ? `${n.name}\n${n.year}` : '？？？', cycle && !n.now ? el('div', { style: { fontSize: '24px', color: '#7A2E25' }, text: '＋37 年 ↓' }) : null));
    page.append(tree);
    page.append(el('div', { class: 'ext-placeholder', text: '〔扩展位〕完整家谱界面（立绘头像、分支展开、第二章新增成员）在 src/ext/familytree.js 扩展。' }));
  },
};
