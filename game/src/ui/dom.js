// 小型 DOM 工具 + 富文本（<k>关键词</k> 高亮、s3 文字故障）
import { glitchText } from '../engine/chapter.js';

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

/** 把带 <k>…</k> 的文本填进元素；glitch={chance,protectKeys} 时按 s3 规则打码 */
export function setRich(node, text, glitch = null) {
  node.textContent = '';
  for (const part of String(text ?? '').split(/(<k>.*?<\/k>)/g)) {
    if (!part) continue;
    const m = part.match(/^<k>(.*)<\/k>$/);
    if (m) {
      const t = glitch && !glitch.protectKeys ? glitchText(m[1], glitch) : m[1];
      node.append(el('span', { class: 'kw', text: t }));
    } else {
      node.append(document.createTextNode(glitch ? glitchText(part, { ...glitch, protectKeys: true }) : part));
    }
  }
  return node;
}

export const fmt = (s, vars = {}) => String(s ?? '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
