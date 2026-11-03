// v2.9.23 工作搜索（考古层）：Ctrl+K 呼出的跨任务/会话/提交/日报统一检索弹层。
// 纯前端消费者：GET /api/work-search?q=（lib/workSearch 四组聚合）。
// 交互：输入 250ms 防抖查询；四组结果各取后端已截断的 ≤8 条；点击行为——
//   任务/日报 → 看板深链 #/board?task=<id>（复用 §4-C 深链，弹层先关）；
//   会话 → openSessionReader(ref) 直达阅读器（复用智能体页导出）；
//   提交/PR → safeHttpUrl 放行才开新窗，否则降级不可点。
// 键盘：↑/↓ 在结果行间移动、Enter 打开当前行（aria-activedescendant 标记）、Esc 关闭走 openModal。
import { api } from '../api.js';
import { esc, icon, toast, openModal, safeHttpUrl, fmtAgo } from '../ui.js';
import { openSessionReader } from './agents.js';

const GROUPS = [
  { key: 'tasks', label: '任务', ic: 'kanban' },
  { key: 'sessions', label: '会话', ic: 'bot' },
  { key: 'commits', label: '提交 / PR', ic: 'git-branch' },
  { key: 'diaries', label: '日报', ic: 'file-text' },
];
const AGENT_LABEL = { zcode: 'ZCode', claude: 'Claude', dsh: 'DSH', workbuddy: 'WorkBuddy', codex: 'Codex', opencode: 'OpenCode' };
const DEBOUNCE_MS = 250;

let m = null; // 当前弹层句柄（单例：重复 Ctrl+K 聚焦既有输入框）

function rowHtml(kind, it, seq) {
  const idx = `ws-r${seq}`;
  if (kind === 'tasks' || kind === 'diaries') {
    const main = kind === 'tasks' ? it.title : `${it.date} 日报`;
    const badge = kind === 'tasks' ? `<span class="badge b-task">${esc(it.status || '')}</span>` : '';
    return `<button type="button" class="ws-row" id="${idx}" data-kind="${kind}" data-id="${esc(it.taskId || it.id)}">
      <span class="ws-main">${badge}<span class="ws-title">${esc(main)}</span><span class="ws-sub">${esc(it.snippet || '')}</span></span>
      <span class="muted small">${fmtAgo(it.updatedAt)}</span></button>`;
  }
  if (kind === 'sessions') {
    const title = String(it.title || '').trim() || '（未命名会话）';
    return `<button type="button" class="ws-row" id="${idx}" data-kind="sessions" data-ref="${esc(it.ref)}">
      <span class="ws-main"><span class="badge b-task">${esc(AGENT_LABEL[it.agent] || it.agent)}</span>
      <span class="ws-title">${esc(title)}</span><span class="ws-sub">${esc(it.projectId || '')}</span></span>
      <span class="muted small">${fmtAgo(it.lastActiveAt)}</span></button>`;
  }
  // commits
  const url = safeHttpUrl(it.url);
  return `<button type="button" class="ws-row" id="${idx}" data-kind="commits" data-url="${esc(url || '')}">
    <span class="ws-main"><span class="badge b-pr">${it.kind === 'pr' ? 'PR' : 'commit'}</span>
    <span class="ws-title">${esc(it.title || '')}</span><span class="ws-sub">${esc(it.snippet || '')}</span></span>
    <span class="muted small">${esc(it.repo || '')} · ${fmtAgo(it.at)}</span></button>`;
}

function resultsHtml(data) {
  const seq = { n: 0 };
  const sections = GROUPS.map((g) => {
    const items = (data.groups && data.groups[g.key]) || [];
    if (!items.length) return '';
    return `<div class="ws-group"><div class="ws-group-h">${icon(g.ic)}${g.label}<span class="muted small">${items.length}</span></div>
      ${items.map((it) => rowHtml(g.key, it, ++seq.n)).join('')}</div>`;
  }).filter(Boolean);
  if (!sections.length) {
    return `<div class="empty-state ws-none">${icon('search')}<span>没有匹配的任务 / 会话 / 提交 / 日报</span></div>`;
  }
  return sections.join('');
}

function openRow(el) {
  if (!el) return;
  const kind = el.dataset.kind;
  if (kind === 'sessions') {
    const ref = el.dataset.ref;
    m.close();
    openSessionReader(ref, {});
    return;
  }
  if (kind === 'commits') {
    const url = safeHttpUrl(el.dataset.url);
    if (url) window.open(url, '_blank', 'noopener');
    return;
  }
  // tasks / diaries → 看板深链
  const id = el.dataset.id;
  if (!id) return;
  m.close();
  if ((location.hash || '') !== `#/board?task=${encodeURIComponent(id)}`) location.hash = `#/board?task=${encodeURIComponent(id)}`;
}

export function openWorkSearch() {
  if (m) {
    const inp = document.getElementById('ws-input');
    if (inp) inp.focus();
    return;
  }
  const box = document.createElement('div');
  box.className = 'ws-box';
  box.innerHTML = `
    <div class="ws-inputbar">${icon('search')}
      <input id="ws-input" type="text" placeholder="搜任务 / 会话 / 提交说明 / 日报…（空格分隔多词，全部命中）"
        autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="ws-results" />
      <span class="kbd">Esc</span>
    </div>
    <div class="ws-results" id="ws-results" role="listbox" aria-label="搜索结果"></div>`;
  m = openModal({ title: '工作搜索', body: box, onClose: () => { m = null; } });

  const input = box.querySelector('#ws-input');
  const out = box.querySelector('#ws-results');
  let seq = 0; // 过期响应丢弃
  let timer = 0;
  let activeIdx = -1;

  const rows = () => [...out.querySelectorAll('.ws-row')];
  const setActive = (i) => {
    const list = rows();
    if (!list.length) return;
    activeIdx = (i + list.length) % list.length;
    list.forEach((r, k) => r.classList.toggle('on', k === activeIdx));
    list[activeIdx].scrollIntoView({ block: 'nearest' });
  };

  async function run() {
    const q = input.value.trim();
    const mySeq = ++seq;
    if (!q) {
      out.innerHTML = `<div class="muted small ws-tip">输入关键词；派工词、会话标题、提交说明、日报全文都在检索范围</div>`;
      return;
    }
    try {
      const r = await api(`/api/work-search?q=${encodeURIComponent(q)}`);
      if (mySeq !== seq || !out.isConnected) return;
      out.innerHTML = resultsHtml(r);
      activeIdx = -1;
      if (!rows().length) return;
    } catch (e) {
      if (mySeq !== seq || !out.isConnected) return;
      out.innerHTML = `<div class="muted small ws-tip">搜索失败：${esc(e.message)}</div>`;
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); openRow(rows()[activeIdx] || rows()[0]); }
  });
  out.addEventListener('click', (e) => {
    const row = e.target.closest('.ws-row');
    if (row) openRow(row);
  });

  run(); // 空态提示
  input.focus();
}
