// 共享 UI 基础件：转义、时间格式化、toast、弹层、轮询、配色
import { icon } from './icons.js';

// 视图统一从 ui.js 取 icon，避免多一处 import 路径
export { icon };

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 秒 → 人读时长：45 秒 / 30 分钟 / 6.5h / 26h / 1.1 天
export function fmtSec(sec) {
  sec = Number(sec);
  if (!isFinite(sec) || sec < 0) return '—';
  if (sec < 90) return `${Math.max(1, Math.round(sec))} 秒`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
  if (sec < 48 * 3600) {
    const h = sec / 3600;
    const v = h >= 10 ? Math.round(h) : Math.round(h * 10) / 10;
    return `${v}h`;
  }
  return `${Math.round((sec / 86400) * 10) / 10} 天`;
}

export function fmtAgo(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (isNaN(t)) return '—';
  return fmtSec((Date.now() - t) / 1000) + '前';
}

export function fmtClock(iso) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getHours())}:${p(t.getMinutes())}`;
}

// 头像/智能体圆点：按 id 稳定取色
const PALETTE = ['#d97757', '#3b82f6', '#22c55e', '#a78bfa', '#eab308', '#fb923c', '#10b981', '#8b93a3', '#f472b6', '#60a5fa'];
export function avatarColor(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function initials(name) {
  const s = String(name || '?').trim();
  const clean = s.replace(/[.\-_]/g, ' ');
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

// 仅放行 http/https 绝对 URL 渲染为 <a href>；其余（含 javascript: 等伪协议）返回 null，
// 调用方须降级为纯文本/不可点元素——前端防御独立于服务端校验成立
export function safeHttpUrl(u) {
  return (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : null;
}

// ---- 截止时间/优先级徽标（v1.4 产品化）----
const p2 = (n) => String(n).padStart(2, '0');

// "YYYY-MM-DD" → 本地时区当日 0 点 Date；非法（含 null/非字符串/假日期）返回 null。
// 必须手工拆解构造而非 Date.parse：后者把纯日期串按 UTC 解析，东八区会整体偏移一天
export function parseYMD(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) ? dt : null;
}

export function fmtYMD(d) {
  return d ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : '';
}

// ISO → 本地完整时间 "YYYY-MM-DD HH:mm"（详情弹层 title 属性用的绝对时间）
export function fmtFull(iso) {
  const t = new Date(iso);
  if (isNaN(t.getTime())) return '';
  return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
}

// 截止分级（纯前端日期推导，服务器本地时区语义 = 浏览器即用户机，时区一致）：
// <今天 → 红「逾期 N 天」；=今天 → 橙「今天到期」；≤今天+2 → 黄「剩 N 天」（N=1 显「明天到期」）；
// 其余 → 灰 MM-DD；null/非法 → null（调用方不渲染）
export function dueInfo(dueDate) {
  const d = parseYMD(dueDate);
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { diff, cls: 'due-over', label: `逾期 ${-diff} 天`, full: fmtYMD(d) };
  if (diff === 0) return { diff, cls: 'due-today', label: '今天到期', full: fmtYMD(d) };
  if (diff === 1) return { diff, cls: 'due-soon', label: '明天到期', full: fmtYMD(d) };
  if (diff <= 2) return { diff, cls: 'due-soon', label: `剩 ${diff} 天`, full: fmtYMD(d) };
  return { diff, cls: 'due-later', label: `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, full: fmtYMD(d) };
}

// 截止徽标：卡片/成员行默认小号，详情弹层传 lg 大号；null 恒返回 ''（不渲染）
export function dueBadge(dueDate, { lg = false } = {}) {
  const info = dueInfo(dueDate);
  if (!info) return '';
  return `<span class="badge due-badge ${info.cls}${lg ? ' due-lg' : ''}" title="截止 ${info.full} · ${esc(info.label)}">${esc(info.label)}</span>`;
}

// 完成日期徽标（v1.7）：done 任务绿色「完成于 MM-DD」，与 dueBadge 同一徽标语言
// （复用 .due-badge/.due-lg 尺寸档 + .due-done 绿色配色）；非法/空 ISO 恒返回 ''
export function completedBadge(completedAt, { lg = false } = {}) {
  const t = new Date(completedAt);
  if (!completedAt || isNaN(t.getTime())) return '';
  const md = `${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
  return `<span class="badge due-badge due-done${lg ? ' due-lg' : ''}" title="完成于 ${esc(fmtFull(completedAt))}">完成于 ${esc(md)}</span>`;
}

// 优先级三档（契约：缺省 medium）；徽标统一旗形语言，low 中性灰不抢视线
export const PRIORITIES = {
  high: { label: '高', cls: 'prio-high' },
  medium: { label: '中', cls: 'prio-med' },
  low: { label: '低', cls: 'prio-low' }
};
// 卡片模式传 compact：仅 high 出红旗徽标、medium 出橙旗小标（icon-only）、low 不渲染（降噪：
// 看板只让例外一眼可见）；详情/表单模式三档完整可见
export function priorityChip(p, { compact = false } = {}) {
  const key = PRIORITIES[p] ? p : 'medium';
  const meta = PRIORITIES[key];
  if (compact) {
    if (key === 'low') return '';
    if (key === 'medium') return `<span class="badge prio-med prio-icon" title="中优先级">${icon('flag')}</span>`;
  }
  return `<span class="badge prio-badge ${meta.cls}" title="${key} 优先级">${icon('flag')}${esc(meta.label)}</span>`;
}

// ---- toast（统一错误出口：红色顶部横幅）----
export function toast(msg, type = 'error') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.setAttribute('role', 'alert');
  t.textContent = String(msg || '');
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 350);
  }, 4200);
}

// ---- busy-lock（v2.1-E）：提交/点击型操作统一防重入包装 ----
// 进入即 disabled、finally 恢复（异常路径必解锁）；已在忙（disabled）则直接忽略本次触发——
// 双击只发一次请求，失败后按钮恢复可重试。返回 fn 的返回值（调用方需要时可接住）。
// 注意：与雷达视图 job 触发点的 syncJobControls 互不覆盖——busyBtn 只包自己接管时的按钮，
// 不触碰由 syncJobControls 管理的 #radar-sync/#radar-analyze/重试按钮
export async function busyBtn(btn, fn) {
  if (!btn) return fn();
  if (btn.disabled) return undefined; // 已被本锁或其他守卫占住：忽略重复触发
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
  }
}

// ---- 弹层 ----
// 注意：overlay 关闭监听必须用 click 且仅 e.target===overlay 自身；
// 用 mousedown 会在点按钮时先于 click 触发（mousedown 先冒泡），导致确认/取消点击落空（P0 竞态）
let modalDepth = 0; // 打开中的弹层数：>0 时 startPolling 跳过刷新（业主要求：弹层打开时暂停轮询，防阅读中重绘跳屏）
// 弹层 close 句柄栈（v2.1-G）：按 Esc 只关栈顶，叠加弹层（详情+删除确认）不再一次全关、丢上下文；
// 遮罩 / × / 按钮路径行为不变（各自只关自己那一层）
const modalStack = [];
export function openModal({ title, body, wide = false, cls = '', onClose = null }) {
  const root = document.getElementById('modal-root') || document.body;
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.innerHTML = `
    <div class="modal${wide ? ' modal-wide' : ''}${cls ? ' ' + cls : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-h"><h4>${esc(title)}</h4><button type="button" class="modal-x" aria-label="关闭">${icon('x')}</button></div>
      <div class="modal-b"></div>
    </div>`;
  const bodyEl = wrap.querySelector('.modal-b');
  if (body instanceof Element) bodyEl.appendChild(body);
  else bodyEl.innerHTML = body;
  root.appendChild(wrap);
  modalDepth++;

  const onKey = (e) => {
    // v2.1-G：Esc 只对栈顶弹层生效——底层弹层（如任务详情）保持上下文
    if (e.key === 'Escape' && modalStack[modalStack.length - 1] === close) close();
  };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    const at = modalStack.indexOf(close);
    if (at >= 0) modalStack.splice(at, 1);
    modalDepth = Math.max(0, modalDepth - 1);
    document.removeEventListener('keydown', onKey);
    if (onClose) { try { onClose(); } catch { /* 关闭回调异常不阻断 */ } }
    // 退场动效：缩放+淡出后再移除；prefers-reduced-motion 下 CSS 过渡被禁用，定时兜底仍会移除
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 170);
  }
  modalStack.push(close);
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.modal-x').addEventListener('click', close);
  const first = wrap.querySelector('input:not([type=hidden]), textarea, select');
  if (first) first.focus();
  return { close, el: wrap };
}

export function confirmModal(message, { title = '确认操作', okText = '删除' } = {}) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="confirm-msg">${esc(message)}</p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="button" class="btn danger" data-act="ok">${esc(okText)}</button>
      </div>`;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      m.close(); // 会触发 onClose → finish(false)，由 done 标志保证结果不被覆盖
    };
    // onClose 兜底：Escape / 右上角 × / 点击遮罩关闭时也要 resolve，避免 await 永久挂起
    const m = openModal({ title, body: box, onClose: () => finish(false) });
    box.querySelector('[data-act=cancel]').addEventListener('click', () => finish(false));
    box.querySelector('[data-act=ok]').addEventListener('click', () => finish(true));
  });
}

// ---- 轮询：document.hidden 时暂停，回到前台立即补一次 ----
export function startPolling(fn, ms) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running || document.hidden || modalDepth > 0) return;
    running = true;
    try { await fn(); } catch (e) { /* 轮询失败静默，不打扰 */ }
    running = false;
  };
  const id = setInterval(tick, ms);
  const onVis = () => { if (!document.hidden) tick(); };
  document.addEventListener('visibilitychange', onVis);
  return () => {
    stopped = true;
    clearInterval(id);
    document.removeEventListener('visibilitychange', onVis);
  };
}

// ---- 动态流类型徽标（activity 与 overview 共用）----
// feeds 新词表（commit/pr）与存量老词表（commit_pushed/pr_opened/pr_merged）双容错：
// 老条目经轮询原地改名后消失，但首轮轮询前渲染的存量数据仍是老名
export const ACTIVITY_TYPES = {
  pr: { label: 'PR', cls: 'b-pr', color: '#93c5fd', icon: 'git-pull-request', verb: 'updated' },
  commit: { label: '提交', cls: 'b-commit', color: '#6ee7b7', icon: 'git-commit', verb: 'pushed' },
  pr_opened: { label: 'PR', cls: 'b-pr', color: '#93c5fd', icon: 'git-pull-request', verb: 'opened' },
  pr_merged: { label: '已合并', cls: 'b-merge', color: '#c4b5fd', icon: 'git-merge', verb: 'merged' },
  commit_pushed: { label: '提交', cls: 'b-commit', color: '#6ee7b7', icon: 'git-commit', verb: 'pushed' },
  branch_created: { label: '分支', cls: 'b-branch', color: '#fcd34d', icon: 'git-branch', verb: 'created' },
  branch_deleted: { label: '删分支', cls: 'b-dead', color: '#8b93a3', icon: 'git-branch', verb: 'deleted' }
};
