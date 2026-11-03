// F1 骨架：hash 路由 + 深色主题 + 顶栏状态 + mock 模式装载
import { api, isMock } from './api.js';
import { esc, toast, icon, startPolling } from './ui.js';
import { state } from './state.js';
import * as overviewView from './views/overview.js';
import * as boardView from './views/board.js';
import * as radarView from './views/radar.js';
import * as agentsView from './views/agents.js';
import * as membersView from './views/members.js';
import * as activityView from './views/activity.js';
import * as settingsView from './views/settings.js';
import * as learnView from './views/learn.js';
import { openWorkSearch } from './views/search.js';
import { shouldShowOnboarding, openOnboarding } from './views/onboarding.js';

// mock 模式：注册本地处理器后再开始渲染（零出网）
if (isMock) await import('./mock.js');

const VIEWS = {
  overview: overviewView,
  board: boardView,
  radar: radarView,
  agents: agentsView,
  members: membersView,
  activity: activityView,
  learn: learnView,
  settings: settingsView
};
const ROUTES = {
  overview: '#/overview',
  board: '#/board',
  radar: '#/radar',
  agents: '#/agents',
  members: '#/members',
  activity: '#/activity',
  learn: '#/learn',
  settings: '#/settings'
};
const TITLES = {
  overview: '总览',
  board: '任务看板',
  radar: '任务雷达',
  agents: '智能体',
  members: '成员进度',
  activity: '团队动态',
  learn: '学习',
  settings: '设置'
};
const NAV_ICONS = {
  overview: 'layout-dashboard',
  board: 'kanban',
  radar: 'radar',
  agents: 'bot',
  members: 'users',
  activity: 'activity',
  learn: 'book-open',
  settings: 'settings'
};

const viewEl = document.getElementById('view');
let currentName = null;
let currentHash = ''; // 完整 hash（含 query）：同视图深链（如看板内搜索点任务 #/board?task=x）也要重渲染
let navSeq = 0;
// v2.9.45 学习视图门控：只有设置了知识库（enabled + root 有效）才出现——"配置了才有"，
// 不是灰掉。30s 随顶栏轮询刷新，配好之后不用重启或强刷。
let learnGate = false;

async function refreshLearnGate() {
  let on = false;
  try {
    const st = await api('/api/learn/status');
    on = !!(st && st.configured);
  } catch { on = false; }
  if (on !== learnGate) {
    learnGate = on;
    const btn = document.getElementById('nav-learn');
    if (btn) btn.hidden = !on;
    // 关掉开关时人可能正停在 #/learn：退回总览，别留一个进不去的页面
    if (!on && currentRoute() === 'learn') location.hash = ROUTES.overview;
  }
}

function currentRoute() {
  const h = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  if (h === 'learn' && !learnGate) return 'overview';
  return VIEWS[h] ? h : 'overview';
}

async function navigate() {
  const name = currentRoute();
  const fullHash = location.hash || '';
  if (name === currentName && fullHash === currentHash) return;
  const seq = ++navSeq;
  // 离开旧视图：先销毁（清轮询/监听），再清容器
  const prev = currentName && VIEWS[currentName];
  if (prev && prev.destroy) {
    try { prev.destroy(); } catch { /* 忽略销毁异常 */ }
  }
  currentName = name;
  currentHash = fullHash;
  viewEl.innerHTML = '';

  document.querySelectorAll('#nav button').forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.getElementById('view-title').textContent = TITLES[name];

  try {
    await VIEWS[name].render(viewEl);
    if (seq !== navSeq) {
      // 渲染期间用户已切走：立即回收
      const mod = VIEWS[name];
      if (mod.destroy) { try { mod.destroy(); } catch { /* noop */ } }
    }
  } catch (e) {
    if (seq === navSeq) {
      viewEl.innerHTML = `<div class="loading err">视图加载失败：${esc(e.message)}</div>`;
      toast(e.message);
    }
  }
}

// ---- 侧栏导航 ----
document.querySelectorAll('#nav button').forEach((b) => {
  const v = b.dataset.view;
  if (!VIEWS[v]) return;
  const holder = b.querySelector('i[data-icon]');
  if (holder) holder.outerHTML = icon(NAV_ICONS[v] || v);
  b.addEventListener('click', () => {
    if (location.hash !== ROUTES[v]) location.hash = ROUTES[v];
  });
});
// 顶栏与页脚里的静态图标
document.querySelectorAll('.topbar [data-icon], .side [data-icon]').forEach((i) => {
  i.outerHTML = icon(i.dataset.icon);
});

// ---- mock 模式标识 ----
if (isMock) {
  document.getElementById('pill-mock').hidden = false;
  document.getElementById('side-addr').textContent = 'MOCK 数据 · 零出网';
} else {
  // 非 mock：侧栏地址显示实际访问地址（插件态端口任意，硬编码 127.0.0.1:7788 常显错误，SPEC-UX v2.1 W3）
  const addr = document.getElementById('side-addr');
  if (addr) addr.textContent = location.host;
}

// ---- 顶栏「新建任务」：看板内直接弹层，其他视图先跳转 ----
document.getElementById('btn-new-task').addEventListener('click', () => {
  if (currentName === 'board') {
    window.dispatchEvent(new CustomEvent('fde:new-task'));
  } else {
    state.pendingNewTask = true;
    if (location.hash === ROUTES.board) navigate();
    else location.hash = ROUTES.board;
  }
});

// ---- v2.9.23 工作搜索（考古层）：顶栏按钮 + Ctrl/Cmd+K 全局呼出 ----
document.getElementById('btn-search').addEventListener('click', openWorkSearch);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
    e.preventDefault();
    openWorkSearch();
  }
});

// ---- v2.9.26 Onboarding：首访自动弹一次；设置页可重开（自定义事件 onboardingRedo） ----
if (shouldShowOnboarding()) {
  setTimeout(() => { if (document.getElementById('modal-root')) openOnboarding(); }, 600);
}
window.addEventListener('onboardingRedo', openOnboarding);

// ---- 顶栏状态胶囊（30s 轮询，隐藏页暂停）----
let multiWarned = false;

// v2.9.43 多实例告警：同一 base 目录还有别的存活实例 → 顶栏亮「多实例」并只 toast 一次。
// 依据 v2.9.25 真事故：桌面版与 CLI 同跑共享 data/，旧代码每 60s 写脏归因，累计清 156 条。
function drawMultiInstance(inst) {
  const pill = document.getElementById('pill-multi');
  if (!pill) return;
  const others = (inst && inst.others) || [];
  pill.hidden = others.length === 0;
  if (!others.length) return;
  const who = others.map((x) => `pid ${x.pid}${x.port ? ` · :${x.port}` : ''}${x.version ? ` · v${x.version}` : ''}`).join('；');
  pill.title = `检测到其它存活实例：${who}\n多实例共用同一份 data/ 会互相覆盖，请只保留一个`;
  if (!multiWarned) {
    multiWarned = true;
    toast('检测到多实例共用数据目录，请只保留一个实例');
  }
}

async function refreshChrome() {
  const sess = document.getElementById('pill-sessions-text');
  const gitea = document.getElementById('pill-gitea-text');
  const foot = document.getElementById('foot-text');
  const footDot = document.getElementById('foot-dot');
  // v2.9.67 底部运行时版本号（health.version=实例加载时的 package.json，随实例重启更新）
  try {
    const h = await api('/api/health');
    const ver = document.getElementById('foot-version');
    if (ver) ver.textContent = `运行时 v${h.version}`;
  } catch { /* 离线保留占位 */ }
  try {
    const ov = await api('/api/overview');
    // goose v2.3 回归收口：会话登记表退役后 ov.sessionsRunning 字段已删（总览统计卡同步移除），
    // pill 改数进行中任务（同 /api/overview 响应的 tasks.doing，契约 v1.4 既有字段，零后端改动）
    const doing = Number(ov && ov.tasks && ov.tasks.doing) || 0;
    if (sess) sess.textContent = `${doing} 个任务进行中`;
    const ok = !!(ov.gitea && ov.gitea.ok);
    if (gitea) gitea.textContent = ok ? 'Gitea 已连接' : 'Gitea 异常';
    if (foot) foot.textContent = ok ? 'Gitea 已连接 · example-org' : 'Gitea 连接异常';
    if (footDot) footDot.className = 'dot' + (ok ? '' : ' err');
    // v2.9.43 多实例探测：端点不存在（旧版后端）就静默跳过，不打扰
    try {
      drawMultiInstance(await api('/api/instance'));
    } catch { /* 旧版无 /api/instance */ }
    // v2.9.45 学习门控随轮询刷新（设置里配好知识库后 30s 内自动出现）
    await refreshLearnGate();
  } catch {
    if (sess) sess.textContent = '服务离线';
    if (gitea) gitea.textContent = '—';
    if (foot) foot.textContent = isMock ? 'MOCK 模式 · 零出网' : '服务离线：请确认 DSH 宿主已启动、FDE 指挥台插件已启用';
    if (footDot) footDot.className = 'dot err';
  }
}
startPolling(refreshChrome, 30000);
refreshChrome();

// ---- v2.9.38 待办提醒（页内）：顶栏铃铛计数 + 宿主侧栏图标红点 ----
// 口径复用既有端点，零后端改动：逾期=/api/overview tasks.overdue；待验收=tasks.review；
// 收件箱=/api/inbox/stats pending（只有这三类会被"等你看一眼"卡住）。
const ATTN = { overdue: 0, review: 0, pending: 0 };
let attnMenuOpen = false;
const attnTotal = () => ATTN.overdue + ATTN.review + ATTN.pending;

function renderAttention() {
  const n = attnTotal();
  const badge = document.getElementById('attn-count');
  if (badge) {
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = n === 0;
  }
  for (const [id, key] of [['attn-overdue', 'overdue'], ['attn-review', 'review'], ['attn-pending', 'pending']]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = String(ATTN[key]);
    const row = el.closest('.attn-row');
    if (row) row.dataset.zero = ATTN[key] === 0 ? '1' : '0'; // 0 项灰显，仍可点（去该视图看一眼）
  }
}

async function refreshAttention() {
  try {
    const [o, s] = await Promise.all([api('/api/overview'), api('/api/inbox/stats')]);
    ATTN.overdue = Number(o && o.tasks && o.tasks.overdue) || 0;
    ATTN.review = Number(o && o.tasks && o.tasks.review) || 0;
    ATTN.pending = Number(s && s.pending) || 0;
  } catch { /* 拉不到就保留上次数值：宁可红点旧，也不要把提醒清空骗人 */ }
  renderAttention();
  // 同步给宿主页的侧栏图标（同 origin 的父窗口）——面板关着时红点也要亮
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'fde:attention', overdue: ATTN.overdue, review: ATTN.review, pending: ATTN.pending }, location.origin);
    }
  } catch { /* 无父窗口/跨域：忽略 */ }
}

function setAttnMenu(open) {
  const menu = document.getElementById('attn-menu');
  const btn = document.getElementById('btn-attn');
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  attnMenuOpen = open;
}

document.getElementById('btn-attn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!attnMenuOpen && attnTotal() === 0) {
    toast('暂无待处理');
    refreshAttention();
    return;
  }
  setAttnMenu(!attnMenuOpen);
});
document.getElementById('attn-menu').addEventListener('click', (e) => {
  const row = e.target.closest('.attn-row');
  if (!row) return;
  setAttnMenu(false);
  const go = row.dataset.go === 'radar' ? ROUTES.radar : ROUTES.board;
  if (location.hash !== go) location.hash = go;
  else navigate();
});
// 点外即收 / Esc 收起（与宿主浮层同款手感，避免菜单挂在那儿）
document.addEventListener('click', (e) => {
  if (attnMenuOpen && !(e.target.closest && e.target.closest('.attn-wrap'))) setAttnMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && attnMenuOpen) setAttnMenu(false);
});

startPolling(refreshAttention, 30000);
refreshAttention();

// ---- 启动路由 ----
// 先定学习门控再首渲：否则直接打开 #/learn 的人会看到"进不去的页面"闪一下
await refreshLearnGate();
window.addEventListener('hashchange', navigate);
navigate();
