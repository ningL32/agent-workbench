// F2 任务看板：列渲染 + 任务卡 CRUD + 状态下拉移动 + 列管理
// v2.1（SPEC-UX）：任务详情深链 #/board?task=<id>（§4-C）+ 看板 30s 静默轮询与规范化脏比较（§4-F）
import { api, apiGet, apiPost, apiDel } from '../api.js';
import { state } from '../state.js';
import { esc, toast, openModal, confirmModal, icon, fmtAgo, fmtFull, avatarColor, safeHttpUrl, dueBadge, completedBadge, priorityChip, PRIORITIES, startPolling, busyBtn, fmtYMD } from '../ui.js';

let rootEl = null;
let columns = [];
let tasks = [];
let agents = [];
let members = [];
let q = '';
let searchTimer = null;
let onNewTaskEvent = null;
let stopPoll = null; // 30s 轮询句柄（destroy 时回收）
let dataKey = null; // 上次渲染数据的规范化指纹（脏比较基准；null=尚未成功渲染）
let pendingSnap = null; // 焦点占用期间暂存的待应用数据

// busyBtn：提交/点击型操作的 busy 锁（SPEC-UX v2.1 §4-E）——进入即 disabled、finally 恢复、异常必解锁。
// 注意：ui.js 并行岗将导出同名实现，集成时换 ui.js 导出（签名一致）

// 规范化指纹：列按 order 排、任务按 id 排（服务端返回序不保证稳定），stringify 后整体比对。
// agents/members 影响卡片指派名展示，一并纳入；无变化时刷新零重绘（§4-F）
function snapshotKey(cols, ts, ags, mems) {
  const byOrder = (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id));
  const byId = (a, b) => String(a.id).localeCompare(String(b.id));
  return JSON.stringify([
    (cols || []).slice().sort(byOrder),
    (ts || []).slice().sort(byId),
    (ags || []).slice().sort(byId),
    (mems || []).slice().sort(byId)
  ]);
}

// 深链参数解析：#/board?task=<id> → task 值；无参数返回 ''（§4-C）
function deepLinkTaskId() {
  const h = location.hash || '';
  const qi = h.indexOf('?');
  if (qi < 0) return '';
  return new URLSearchParams(h.slice(qi + 1)).get('task') || '';
}

// v2.9.7 项目过滤 chips（projectDir 读侧闭环）：归一口径与会话钻取/项目绑定一致（去尾分隔符+分隔符统一+小写）
function projKey(p) {
  return String(p || '').trim().replace(/[\\/]+$/, '').toLowerCase().replace(/[\\/]+/g, '\\');
}
let curProj = 'all';
try { curProj = localStorage.getItem('fde-board-proj') || 'all'; } catch (e) { /* 无 localStorage 用默认 */ }

// 卡片高亮：滚动到卡 + flash（深链直开与动态流跳转共用，§4-C）
function flashCard(id) {
  const root = rootEl;
  if (!root) return;
  const card = root.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 2600);
}

export async function render(el) {
  rootEl = el;
  // 深链直开（§4-C）：清空既有搜索词与项目过滤，保证深链任务不被过滤（新标签场景 q 本就为空）
  if (deepLinkTaskId()) { q = ''; curProj = 'all'; }
  el.innerHTML = `
    <div class="toolbar">
      <div class="search">
        ${icon('search')}
        <input id="board-q" placeholder="搜索 标题 / 分支 / 备注" value="${esc(q)}" aria-label="搜索任务">
      </div>
      <span class="spacer"></span>
      <button type="button" class="btn ghost" id="btn-cols">${icon('columns')}列管理</button>
    </div>
    <div class="act-chips" id="proj-chips" role="group" aria-label="按项目过滤任务"></div>
    <div class="board-grid" id="board-grid"><div class="loading">加载中…</div></div>`;

  el.querySelector('#board-q').addEventListener('input', (e) => {
    q = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refresh(), 300);
  });
  el.querySelector('#btn-cols').addEventListener('click', openColumnsModal);
  onNewTaskEvent = () => openTaskModal();
  window.addEventListener('fde:new-task', onNewTaskEvent);

  const grid = el.querySelector('#board-grid');
  grid.addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // PR 原始链接放行
    const add = e.target.closest('.col-add');
    if (add) { openTaskModal({ status: add.dataset.col }); return; }
    const mover = e.target.closest('.col-move');
    if (mover && !mover.disabled) { busyBtn(mover, () => moveColumn(mover.dataset.col, mover.dataset.dir)); return; }
    const card = e.target.closest('.task');
    if (card && !e.target.closest('.status-sel')) {
      const t = tasks.find((x) => x.id === card.dataset.id);
      if (t) openTaskDetail(t); // 点卡片开详情（编辑改为详情内快捷操作进入）
    }
  });
  grid.addEventListener('change', (e) => {
    const sel = e.target.closest('.status-sel');
    // busy 锁挂在 select 上：PATCH 期间禁用，防连续 change 重复提交（§4-E）
    if (sel) busyBtn(sel, () => moveTask(sel.dataset.id, sel.value));
  });
  // 焦点离开看板且有待应用快照 → 下一拍应用（setTimeout 0 避开 grid 内部焦点切换中间态，§4-F）
  grid.addEventListener('focusout', () => {
    if (pendingSnap) setTimeout(applyPending, 0);
  });

  await refresh();
  if (!rootEl) return; // await 期间已切走则不再起轮询，否则旧 interval 句柄被覆盖、30s 轮询永久泄漏

  // 顶栏「新建任务」或动态流跳转的挂起动作
  if (state.pendingNewTask) {
    state.pendingNewTask = false;
    openTaskModal();
  }
  focusPending();

  // 深链 #/board?task=<id>：看板加载后直开详情 + 高亮该卡；任务不存在由详情内空态兜底（§4-C）
  const dl = deepLinkTaskId();
  if (dl) {
    const t = tasks.find((x) => x.id === dl);
    openTaskDetail(t || { id: dl });
    flashCard(dl);
  }

  // 看板静默轮询（30s，§4-F）：startPolling 自带 document.hidden / 弹层（modalDepth>0）暂停守卫
  stopPoll = startPolling(refresh, 30000);
}

export function destroy() {
  rootEl = null;
  if (stopPoll) { stopPoll(); stopPoll = null; }
  dataKey = null;
  pendingSnap = null;
  window.removeEventListener('fde:new-task', onNewTaskEvent);
  onNewTaskEvent = null;
  clearTimeout(searchTimer);
}

async function refresh() {
  const root = rootEl;
  if (!root) return;
  try {
    const [cols, ts, ags, mems] = await Promise.all([
      apiGet('/api/columns'),
      apiGet('/api/tasks' + (q ? `?q=${encodeURIComponent(q)}` : '')),
      apiGet('/api/agents'),
      apiGet('/api/members')
    ]);
    if (!rootEl) return;
    // 规范化脏比较（§4-F）：指纹不变则零重绘（DOM 节点引用不动，双窗口对拍无整板闪烁）
    const key = snapshotKey(cols, ts, ags, mems);
    if (key === dataKey) return;
    const grid = root.querySelector('#board-grid');
    // 焦点在看板内（如正操作列下拉）→ 暂存数据延后应用，不立即重绘打断
    if (grid && grid.contains(document.activeElement)) {
      pendingSnap = { cols, ts, ags, mems, key };
      return;
    }
    columns = cols || [];
    tasks = ts || [];
    agents = ags || [];
    members = mems || [];
    dataKey = key;
    pendingSnap = null;
    renderGrid();
  } catch (e) {
    if (!rootEl) return;
    const grid = root.querySelector('#board-grid');
    // 初载失败仍显示错误态；轮询期失败保留既有看板内容（避免瞬时故障清屏），仅提示
    if (grid && dataKey === null) grid.innerHTML = `<div class="loading err">${esc(e.message)}</div>`;
    toast(e.message);
  }
}

// 焦点离开看板后应用暂存快照（§4-F：松开焦点后下一拍呈现）
function applyPending() {
  const p = pendingSnap;
  if (!p || !rootEl) return;
  const grid = rootEl.querySelector('#board-grid');
  if (grid && grid.contains(document.activeElement)) return; // 焦点又回到看板内（如连续操作下拉），等下次
  pendingSnap = null;
  columns = p.cols;
  tasks = p.ts;
  agents = p.ags;
  members = p.mems;
  dataKey = p.key;
  renderGrid();
}

function agentMap() {
  const m = new Map(agents.map((a) => [a.id, a]));
  // v2.5 桌面 agent（workbuddy/zcode/codex/opencode）名字来自成员聚合——并入映射，
  // 卡片指派名/时间轴对桌面执行者显示友好名（而非裸 id）
  for (const mem of members) {
    if (mem.kind === 'agent' && !m.has(mem.id)) m.set(mem.id, { id: mem.id, name: mem.name });
  }
  return m;
}
// 只取真实员工（kind:"human"）；memberId 归领用
function humanMap() { return new Map(members.filter((m) => m.kind === 'human').map((m) => [m.id, m])); }

// 描述首行截断展示（≤40 字，muted 色）；仅取第一行，超长补省略号
function descLine(t) {
  if (!t.desc) return '';
  const first = String(t.desc).split('\n')[0].trim();
  if (!first) return '';
  return first.length > 40 ? first.slice(0, 40) + '…' : first;
}

// 卡片 hover 提示：完整描述，超 300 字截断加省略号；多行保留 \n（title 属性原生支持换行显示）
function descTitle(t) {
  if (!t.desc) return '';
  const s = String(t.desc).trim();
  if (!s) return '';
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

// P2-1 origin 溯源徽标：任务来自雷达确认入库时显示小雷达图标，hover 看「任务为什么而来」
// （title = 原文引用前 80 字，浏览器原生 tooltip）
function originBadge(t) {
  if (!t || !t.origin) return '';
  const q = String(t.origin.quote || '');
  return `<span class="badge b-pr origin-tag" title="${esc(q.slice(0, 80))}">${icon('radar')}</span>`;
}

// ---- v2.0 验收人 ----
// 待验证态判定：review 列 id 或列名含「验证」（列可改名/重排，不硬编码列序）
function isReviewLike(t) {
  if (t.status === 'review') return true;
  const col = columns.find((c) => c.id === t.status);
  return !!(col && /验证/.test(col.name || ''));
}

// 验收人显示名：名册取名称，已删除成员回退原始 id
function acceptorName(t, mmap) {
  const mem = mmap.get(t.acceptorId);
  return mem ? mem.name : String(t.acceptorId);
}

// 详情指派行验收人徽标：恒显示（有 acceptorId 即出）；done/待验证态换 acc-hot 金色高亮更醒目
function acceptorBadge(t, mmap, { hot = false } = {}) {
  if (!t.acceptorId) return '';
  const name = acceptorName(t, mmap);
  const hotOn = hot && (t.status === 'done' || isReviewLike(t));
  return `<span class="badge b-acc${hotOn ? ' acc-hot' : ''}" title="验收人：${esc(name)}">${icon('user')}${esc(name)}</span>`;
}

// 任务卡 meta 验收人小徽标：仅 done / 待验证 且有 acceptorId 的卡显示（人形+名）
function cardAcceptorBadge(t, mmap) {
  if (!t.acceptorId) return '';
  if (t.status !== 'done' && !isReviewLike(t)) return '';
  const name = acceptorName(t, mmap);
  return `<span class="badge b-acc acc-tag" title="验收人：${esc(name)}">${icon('user')}${esc(name)}</span>`;
}

function taskCard(t, amap, mmap, idx) {
  const ag = t.agentId && amap.get(t.agentId);
  const mem = t.memberId && mmap.get(t.memberId);
  const opts = columns.map((c) =>
    `<option value="${esc(c.id)}"${c.id === t.status ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  // prUrl 仅放行 http/https 渲染为链接，其余降级为不可点图标（XSS 防御，不依赖服务端）
  const prHref = safeHttpUrl(t.prUrl);
  const prIcon = t.prUrl
    ? (prHref
      ? `<a href="${esc(prHref)}" target="_blank" rel="noreferrer noopener" title="查看 PR">${icon('git-pull-request')}</a>`
      : `<span class="muted" title="链接已拦截：仅放行 http/https">${icon('git-pull-request')}</span>`)
    : '';
  const dl = descLine(t);
  const dt = descTitle(t);
  return `
    <div class="task" data-id="${esc(t.id)}" data-status="${esc(t.status)}" style="--i:${idx}">
      <div class="tt">${esc(t.title)}${prIcon}</div>
      ${dl ? `<div class="t-desc" title="${esc(dt)}">${esc(dl)}</div>` : ''}
      <div class="meta">
        ${ag ? `<span class="agent-dot" style="background:${avatarColor(t.agentId)}"></span><span class="agent-name" title="${esc(ag.name)}">${esc(ag.name)}</span>` : ''}
        ${mem ? `<span class="badge b-ro member-tag" title="负责成员">${icon('user')}${esc(mem.name)}</span>` : ''}
        ${cardAcceptorBadge(t, mmap)}
        ${priorityChip(t.priority, { compact: true })}
        ${originBadge(t)}
        ${t.branch ? `<span class="branch" title="${esc(t.branch)}">${esc(t.branch)}</span>` : ''}
        ${/* v1.7：done 任务（completedAt 有值）只亮绿色「完成于」，不再喊逾期/到期 */ ''}
        ${t.completedAt ? completedBadge(t.completedAt) : dueBadge(t.dueDate)}
        <span class="ago">${fmtAgo(t.updatedAt)}</span>
        <select class="status-sel" data-id="${esc(t.id)}" title="移动到其他列">${opts}</select>
      </div>
    </div>`;
}

function renderGrid() {
  const root = rootEl;
  if (!root) return;
  const grid = root.querySelector('#board-grid');
  if (!grid) return;
  drawProjChips();
  const amap = agentMap();
  const mmap = humanMap();
  // v2.9.7 项目过滤：'all' 出全量；选中项目只出 projectDir 归一命中的任务（客户端过滤，不重拉）
  const visible = curProj === 'all' ? tasks : tasks.filter((t) => projKey(t.projectDir) === curProj);
  grid.innerHTML = columns.map((c, i) => {
    const list = visible.filter((t) => t.status === c.id);
    // 列排序：hover 出现 ←/→，首列禁 ←、末列禁 →（服务端把 order 归一化为 1..n）
    const canLeft = i > 0;
    const canRight = i < columns.length - 1;
    return `
      <div class="col" data-col="${esc(c.id)}">
        <div class="col-h">
          <span class="col-name">${esc(c.name)}</span><span class="n">${list.length}</span>
          <span class="col-movers">
            <button type="button" class="col-move" data-dir="left" data-col="${esc(c.id)}"
              title="左移一位" aria-label="左移列 ${esc(c.name)}"${canLeft ? '' : ' disabled'}>←</button>
            <button type="button" class="col-move" data-dir="right" data-col="${esc(c.id)}"
              title="右移一位" aria-label="右移列 ${esc(c.name)}"${canRight ? '' : ' disabled'}>→</button>
          </span>
          <button type="button" class="icon-btn add col-add" data-col="${esc(c.id)}" title="在此列新建任务">${icon('plus')}</button>
        </div>
        <div class="cards">${list.map((t, i) => taskCard(t, amap, mmap, i)).join('') ||
          `<div class="empty-state">${icon('inbox')}<span>无任务</span></div>`}</div>
      </div>`;
  }).join('') || `<div class="empty-state">${icon('columns')}<span>暂无列，请先在「列管理」新增</span></div>`;
}

// v2.9.7 项目 chips：项目名单从任务现存的 projectDir 自动收集（未绑定项目的任务只在「全部」出现，
// 不做「未绑定」chip——显式选择优于隐式桶）；chips 切换纯客户端过滤不重拉（30s 轮询照常喂数据）
function drawProjChips() {
  const root = rootEl;
  if (!root) return;
  const box = root.querySelector('#proj-chips');
  if (!box) return;
  const seen = new Map(); // 归一键 → 展示名（首见 projectDir 末段）
  for (const t of tasks) {
    const raw = String(t.projectDir || '').trim();
    if (!raw) continue;
    const key = projKey(raw);
    if (!seen.has(key)) seen.set(key, raw.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || raw);
  }
  // 记忆的选中项在当前任务里已不存在（全解绑/换机）→ 回退「全部」
  if (curProj !== 'all' && !seen.has(curProj)) {
    curProj = 'all';
    try { localStorage.setItem('fde-board-proj', 'all'); } catch (e2) { /* 本页生效 */ }
  }
  box.innerHTML = `<button type="button" class="chip${curProj === 'all' ? ' on' : ''}" data-p="all" aria-pressed="${curProj === 'all'}">全部 ${tasks.length}</button>`
    + [...seen.entries()].map(([key, disp]) => {
      const n = tasks.filter((t) => projKey(t.projectDir) === key).length;
      return `<button type="button" class="chip${curProj === key ? ' on' : ''}" data-p="${esc(key)}" aria-pressed="${curProj === key}">${esc(disp)} ${n}</button>`;
    }).join('');
  box.querySelectorAll('.chip').forEach((b) => {
    b.addEventListener('click', () => {
      curProj = b.dataset.p || 'all';
      try { localStorage.setItem('fde-board-proj', curProj); } catch (e2) { /* 本页生效 */ }
      drawProjChips();
      renderGrid();
    });
  });
}

// 列左移/右移：PATCH {order: 目标位次} → 服务端归一化 → 重拉列与任务重渲染；失败 toast
async function moveColumn(id, dir) {
  const idx = columns.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const targetIdx = dir === 'left' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= columns.length) return;
  try {
    await api(`/api/columns/${encodeURIComponent(id)}`, { method: "PATCH", body: { order: targetIdx + 1 } });
    await refresh();
  } catch (e) {
    toast(e.message);
    refresh();
  }
}

async function moveTask(id, status) {
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } });
    await refresh();
    if (state.pendingTaskFocus) focusPending();
  } catch (e) {
    toast(e.message);
    refresh();
  }
}

// ---- 仓库可搜索下拉（本批）：数据源 GET /api/repos（后端并行开发中，按 mock 契约）
// → [{fullName, name, private, updatedAt}]。自定义 combobox（输入框+下拉面板，零依赖手写）：
// 聚焦/输入展开，fullName/name 双字段大小写不敏感过滤全量列表；点选填 fullName；
// 无匹配显示手填兜底提示并保留输入值；键盘 ↑↓ 选择、Enter 确认、Esc 仅关面板不关弹层
// （stopPropagation 拦在输入层，openModal 挂在 document 上的 Esc 收不到）。
// 仓库仍存 fullName 字符串（任务数据结构不变）；列表不可用时静默降级纯手填，不打扰。
let reposCache = null; // 会话级缓存：弹层反复开关不重复拉取
function loadRepos() {
  if (reposCache) return Promise.resolve(reposCache);
  return apiGet('/api/repos').then((list) => {
    reposCache = (Array.isArray(list) ? list : []).filter((r) => r && r.fullName);
    return reposCache;
  }).catch(() => {
    reposCache = []; // 后端未就绪/接口失败 → 空列表 = 纯手填兜底（不 toast）
    return reposCache;
  });
}

// 给任务表单绑仓库下拉；返回 dispose（弹层 onClose 时摘除 document 监听）
function wireRepoCombo(box) {
  const wrap = box.querySelector('#task-repo-combo');
  if (!wrap) return () => {};
  const input = wrap.querySelector('input[name=repo]');
  const panel = wrap.querySelector('.combo-panel');
  let all = null;   // 全量仓库（null=尚未加载完，面板显示加载态）
  let items = [];   // 当前过滤结果
  let active = -1;  // 键盘高亮项下标
  let open = false;
  loadRepos().then((list) => { all = list; if (open) paint(); });

  const paint = () => {
    const kw = input.value.trim().toLowerCase();
    items = !all ? [] : all.filter((r) => !kw
      || String(r.fullName).toLowerCase().includes(kw)
      || String(r.name || '').toLowerCase().includes(kw));
    active = items.length ? 0 : -1;
    panel.innerHTML = !all
      ? '<div class="combo-none">仓库列表加载中…</div>'
      : (all.length
        ? (items.length
          ? items.map((r, i) => `
            <button type="button" class="combo-opt${i === active ? ' on' : ''}" role="option" data-i="${i}"
              id="task-repo-opt-${i}" data-full="${esc(r.fullName)}" aria-selected="${i === active}" title="${esc(r.fullName)}">
              ${icon('git-branch')}<span class="combo-name">${esc(r.fullName)}</span>${r.private
                ? `<span class="combo-priv" title="私有仓库">${icon('lock')}私有</span>` : ''}</button>`).join('')
          : '<div class="combo-none">无匹配仓库，将按手填提交</div>')
        : '<div class="combo-none">仓库列表不可用，可直接手填</div>');
    if (active >= 0) input.setAttribute('aria-activedescendant', `task-repo-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const setActive = (i) => {
    if (!items.length) return;
    active = (i + items.length) % items.length; // 首尾循环
    panel.querySelectorAll('.combo-opt').forEach((el, k) => {
      const on = k === active;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', String(on));
    });
    input.setAttribute('aria-activedescendant', `task-repo-opt-${active}`);
    const cur = panel.children[active];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  };
  const openPanel = () => {
    if (open) return;
    open = true; panel.hidden = false; input.setAttribute('aria-expanded', 'true'); paint();
  };
  const closePanel = () => {
    if (!open) return;
    open = false; panel.hidden = true; input.setAttribute('aria-expanded', 'false');
  };
  const choose = (i) => {
    const r = items[i];
    if (!r) return;
    input.value = r.fullName; // 契约：repo 字段仍存 fullName 字符串
    closePanel();
    input.focus();
  };

  input.addEventListener('focus', () => { loadRepos().then(() => openPanel()); });
  // 点输入框也展开：choose() 后焦点已在输入框，再次点击不触发 focus，需 click 兜底重开面板
  input.addEventListener('click', () => { if (!open) openPanel(); });
  input.addEventListener('input', () => { if (open) paint(); else openPanel(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openPanel(); return; }
      setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      // 面板开着且有候选：确认高亮项并拦下表单提交；无匹配/已关：放行默认提交（手填兜底路径）
      if (open && items.length && active >= 0) { e.preventDefault(); choose(active); }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); closePanel(); } // 只关面板，弹层不关
    } else if (e.key === 'Tab') {
      closePanel();
    }
  });
  panel.addEventListener('mousedown', (e) => {
    // mousedown 阶段选填并 preventDefault：输入框不失焦、面板不闪关
    const opt = e.target.closest('.combo-opt');
    if (!opt) return;
    e.preventDefault();
    choose(Number(opt.dataset.i));
  });
  const outside = (e) => { if (open && !wrap.contains(e.target)) closePanel(); };
  document.addEventListener('mousedown', outside);
  return () => document.removeEventListener('mousedown', outside);
}

// 看板任务新建/编辑弹层（顶栏与看板共用）
// 执行方式不入库、由指派推导：有 agent 无 member=AI；有 member 无 agent=人工；两者都有=协作；
// 都没有=未指派（编辑时归入 AI 段作默认，提交按当前模式决定字段归属）
export function openTaskModal({ task = null, status = '' } = {}) {
  const isEdit = !!task;
  const prio = (task && task.priority) || 'medium'; // 契约：priority 缺省 medium
  // 状态默认值（两个入口语义不同）：
  // - 列头「+」：status 显式传入该列 id → 默认即该列；
  // - 顶栏「新建任务」/动态流跳转：status 为空 → 固定选「待分配」（id=todo）。
  //   不取 columns[0]：列可重排，首列未必是待分配（曾默认落进「已完成」语义错位）；
  //   todo 列被删除/改名时回退第一列兜底
  const defaultStatus = status
    || (columns.find((c) => c.id === 'todo') || columns[0] || {}).id
    || '';
  const opts = (selected) => columns.map((c) =>
    `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  // 负责智能体 = 桌面 agent 注册表（v2.5 方向：WorkBuddy/ZCode/Codex/OpenCode 是执行者，
  // agents.json 的 CLI 已退役为纯启动器）——数据源切到 members 聚合的桌面源，归因 id 对齐
  const DESKTOP_SOURCES = ['workbuddy', 'zcode', 'codex', 'opencode'];
  const desktopAgents = members.filter((m) => m.kind === 'agent' && DESKTOP_SOURCES.includes(m.source));
  const agentOpts = (selected) => {
    const known = desktopAgents.some((m) => m.id === selected);
    return `<option value="">（未分配）</option>` +
      desktopAgents.map((m) => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)}</option>`).join('') +
      // 边界：任务原 agentId 不在桌面注册表（历史 CLI 指派）时补保留项，避免编辑保存时静默清空
      (selected && !known ? `<option value="${esc(selected)}" selected>${esc(selected)}（历史执行者，已不可选）</option>` : '');
  };
  // 负责成员 = 真实员工（kind:"human"）；已停用（enabled:false）直接排除不进选项。
  // 边界：任务原 memberId 指向已删除/已停用成员时补一个保留项，避免编辑保存时静默清空指派
  const memberOpts = (selected) => {
    const humans = members.filter((m) => m.kind === 'human' && m.enabled !== false);
    const known = humans.some((m) => m.id === selected);
    return `<option value="">（未分配）</option>` +
      humans.map((m) => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)}</option>`).join('') +
      (selected && !known ? `<option value="${esc(selected)}" selected>${esc(selected)}（当前指派，已不可选）</option>` : '');
  };
  // v2.0 验收人：（未指定）+ 全部成员；新建时默认跟随负责成员的当前值（仅表单打开时取一次，之后不联动）；
  // 编辑预填 acceptorId；原验收人已删除/停用时同样补保留项，避免保存时静默清空
  const acceptorOpts = (selected) => {
    const humans = members.filter((m) => m.kind === 'human' && m.enabled !== false);
    const known = humans.some((m) => m.id === selected);
    return `<option value="">（未指定）</option>` +
      humans.map((m) => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)}</option>`).join('') +
      (selected && !known ? `<option value="${esc(selected)}" selected>${esc(selected)}（当前验收人，已不可选）</option>` : '');
  };
  const deriveMode = (t) => {
    if (t && t.agentId && t.memberId) return 'collab';
    if (t && t.memberId) return 'human';
    return 'ai';
  };

  const box = document.createElement('div');
  box.innerHTML = `
    <form id="task-form">
      <div class="form-row"><label class="req">标题</label>
        <input name="title" maxlength="200" required value="${esc(task ? task.title : '')}" placeholder="如：接入 SSO 登录"></div>
      <div class="form-row"><label>状态（列）</label>
        <select name="status">${opts(task ? task.status : defaultStatus)}</select></div>
      <div class="form-row"><label>执行方式</label>
        <div class="seg" id="task-mode-seg" role="group" aria-label="执行方式">
          <button type="button" class="seg-btn" data-mode="ai">AI 执行</button>
          <button type="button" class="seg-btn" data-mode="human">人工执行</button>
          <button type="button" class="seg-btn" data-mode="collab">人机协作</button>
        </div></div>
      <div class="form-row"><label>优先级</label>
        <select name="priority" aria-label="优先级">
          <option value="high"${prio === 'high' ? ' selected' : ''}>高</option>
          <option value="medium"${prio === 'medium' ? ' selected' : ''}>中</option>
          <option value="low"${prio === 'low' ? ' selected' : ''}>低</option>
        </select></div>
      <div class="form-row"><label>截止日期（可选，到期后卡片亮预警徽标）</label>
        <input type="date" name="dueDate" value="${esc(task && task.dueDate ? task.dueDate : '')}"></div>
      <div class="form-row" data-field="agent"><label>负责智能体</label>
        <select name="agentId">${agentOpts(task ? task.agentId : '')}</select></div>
      <div class="form-row" data-field="member"><label>负责成员</label>
        <select name="memberId">${memberOpts(task ? task.memberId : '')}</select></div>
      <div class="form-row" data-field="acceptor"><label>验收人（可选，任务交付后由 TA 验收）</label>
        <select name="acceptorId">${acceptorOpts(task ? task.acceptorId : '')}</select></div>
      <div class="fold" data-field="repo">
        <button type="button" class="fold-toggle" id="task-repo-fold" aria-expanded="false" aria-controls="task-repo-body">
          ${icon('chevron-down')}<span>关联仓库（可选）</span>
        </button>
        <div class="fold-body" id="task-repo-body" hidden>
          <div class="form-row"><label>仓库（可搜索下拉；列表外的仓库直接手填）</label>
            <div class="combo" id="task-repo-combo">
              <input name="repo" value="${esc(task ? task.repo : '')}" placeholder="example-org/fde-api" autocomplete="off"
                role="combobox" aria-expanded="false" aria-controls="task-repo-list" aria-autocomplete="list">
              <div class="combo-panel" id="task-repo-list" role="listbox" aria-label="仓库候选" hidden></div>
            </div></div>
          <div class="form-row"><label>分支</label>
            <input name="branch" value="${esc(task ? task.branch : '')}" placeholder="feat/sso"></div>
          <div class="form-row"><label>PR 链接</label>
            <input name="prUrl" value="${esc(task ? task.prUrl : '')}" placeholder="https://gitea.example.com/..."></div>
        </div>
      </div>
      <div class="form-row"><label>描述</label>
        <textarea name="desc" rows="4" placeholder="做什么 + 验收标准：背景一句话，完成以什么为验收依据">${esc(task ? task.desc : '')}</textarea>
        <div class="char-count" id="desc-count" aria-live="polite"></div></div>
      <div class="form-row"><label>备注</label>
        <textarea name="notes" maxlength="2000">${esc(task ? task.notes : '')}</textarea></div>
      <div class="form-err" id="task-form-err"></div>
      <div class="modal-actions">
        ${isEdit ? '<button type="button" class="btn danger" id="task-del">删除任务</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="submit" class="btn">${isEdit ? '保存修改' : '创建任务'}</button>
      </div>
    </form>`;
  const disposeRepoCombo = wireRepoCombo(box); // 仓库可搜索下拉（本批）；随弹层关闭摘 document 监听
  const m = openModal({ title: isEdit ? `编辑任务 · ${task.id}` : '新建任务', body: box, onClose: disposeRepoCombo });
  const errEl = box.querySelector('#task-form-err');
  const showErr = (msg) => { errEl.textContent = msg; errEl.classList.add('show'); };

  box.querySelector('[data-act=cancel]').addEventListener('click', m.close);

  // ---- 执行方式切换：仅显隐字段，不清值（用户可能切来切去）；提交时按模式决定字段归属 ----
  let mode = deriveMode(task);
  const seg = box.querySelector('#task-mode-seg');
  const fieldRows = {
    agent: box.querySelector('[data-field=agent]'),
    member: box.querySelector('[data-field=member]'),
    repo: box.querySelector('[data-field=repo]')
  };
  const applyMode = () => {
    seg.querySelectorAll('.seg-btn').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    fieldRows.agent.hidden = mode === 'human';   // 人工执行：真人任务交付物不在 git，仓库字段属错误暗示，一并隐藏
    fieldRows.member.hidden = mode === 'ai';
    fieldRows.repo.hidden = mode === 'human';
  };
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b || b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    applyMode();
  });

  // ---- 仓库折叠段：默认收起；编辑时已有仓库信息则自动展开，避免「填了却看不见」 ----
  const foldBtn = box.querySelector('#task-repo-fold');
  const foldBody = box.querySelector('#task-repo-body');
  const setFold = (open) => {
    foldBody.hidden = !open;
    foldBtn.setAttribute('aria-expanded', String(open));
    foldBtn.classList.toggle('open', open);
  };
  foldBtn.addEventListener('click', () => setFold(foldBody.hidden));
  if (isEdit && (task.repo || task.branch || task.prUrl)) setFold(true);

  // ---- 描述实时计数：超 2000 红字，提交兜底拦截 ----
  const descEl = box.querySelector('[name=desc]');
  const descCount = box.querySelector('#desc-count');
  const updateCount = () => {
    const n = descEl.value.length;
    descCount.textContent = `${n} / 2000`;
    descCount.classList.toggle('over', n > 2000);
  };
  descEl.addEventListener('input', updateCount);
  updateCount();
  applyMode();

  // v2.0：新建时验收人默认跟随负责成员的当前值（仅表单打开此刻取一次；之后改负责成员不联动；
  // 编辑模式不覆盖，保持 acceptorId 预填）
  if (!isEdit) {
    const accSel = box.querySelector('[name=acceptorId]');
    const memSel = box.querySelector('[name=memberId]');
    if (accSel && memSel && memSel.value) accSel.value = memSel.value;
  }

  const delBtn = box.querySelector('#task-del');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      const ok = await confirmModal('该操作不可恢复。', { title: `删除任务「${task.title}」？` });
      if (!ok) return;
      try {
        await apiDel(`/api/tasks/${encodeURIComponent(task.id)}`);
        toast('任务已删除', 'success');
        m.close();
        refresh();
      } catch (e) { showErr(e.message); toast(e.message); }
    });
  }
  box.querySelector('#task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    // busy 锁：await 期间提交按钮 disabled，双击只发一次（§4-E）
    busyBtn(f.querySelector('[type=submit]'), async () => {
      // 注意：form.title/id/name 与 HTMLElement 内建属性冲突，必须走 elements.namedItem
      const val = (n) => f.elements.namedItem(n).value;
      const desc = val('desc');
      if (desc.length > 2000) {
        showErr(`描述不能超过 2000 字（当前 ${desc.length} 字），请精简后再保存`);
        return;
      }
      const payload = {
        title: val('title').trim(),
        status: val('status'),
        desc,
        priority: val('priority') || 'medium',
        dueDate: val('dueDate') || null, // date input 空值即清空截止，与契约 null 对齐
        // 按当前执行方式决定提交字段：人工提交 memberId 且 agentId=null；AI 反之；协作两者都提交。
        // 人工模式仓库字段不可见，视为不适用 → 一并置空，避免隐藏残留值静默入库
        agentId: mode === 'human' ? null : (val('agentId') || null),
        memberId: mode === 'ai' ? null : (val('memberId') || null),
        acceptorId: val('acceptorId') || null, // v2.0：验收人与执行方式解耦（AI 交付也可指定人工验收）
        repo: mode === 'human' ? null : (val('repo').trim() || null),
        branch: mode === 'human' ? null : (val('branch').trim() || null),
        prUrl: mode === 'human' ? null : (val('prUrl').trim() || null),
        notes: val('notes')
      };
      try {
        if (isEdit) {
          await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", body: payload });
          toast('任务已更新', 'success');
        } else {
          await apiPost('/api/tasks', payload);
          toast('任务已创建', 'success');
        }
        m.close();
        refresh();
      } catch (err) { showErr(err.message); toast(err.message); }
    });
  });
}

// ---- v1.7 详情弹层「动态」时间轴 ----
// 事件类型 → 中文标签/配色档：completed 绿、status 蓝、assign 紫、due 黄、priority 橙、edit/created 灰；
// 叙事线第一批新增：memo 青色（纪要提及）、artifact 绿色系（成果挂接/解除）
const TL_META = {
  completed: { label: '完成', cls: 'tl-green' },
  status: { label: '状态', cls: 'tl-blue' },
  assign: { label: '指派', cls: 'tl-purple' },
  accept: { label: '验收', cls: 'tl-gold' }, // v2.0：验收人设置/变更，金色节点，detail 直出
  due: { label: '截止', cls: 'tl-yellow' },
  priority: { label: '优先级', cls: 'tl-orange' },
  memo: { label: '纪要提及', cls: 'tl-teal' },
  artifact: { label: '成果', cls: 'tl-green' },
  bind: { label: '项目绑定', cls: 'tl-purple' }, // v2.9.4：项目目录绑定/解绑
  edit: { label: '编辑', cls: 'tl-gray' },
  created: { label: '创建', cls: 'tl-gray' }
};

// from/to 原始值 → 人读文案：优先级枚举转中文、状态列 id 转列名、成员/智能体 id 转名称，空值按语义给「无/—」
function tlVal(v, type) {
  if (v == null || v === '') return type === 'due' ? '无' : '—';
  const s = String(v);
  if (type === 'priority') return (PRIORITIES[s] || { label: s }).label;
  if (type === 'status') {
    const col = columns.find((c) => c.id === s);
    return col ? col.name : s;
  }
  if (type === 'assign') {
    const mem = humanMap().get(s);
    const ag = agentMap().get(s);
    if (mem) return mem.name;
    if (ag) return ag.name;
    return s;
  }
  return s;
}

// 事件 → 一行文案：detail 优先，否则按类型语义组装 from→to（created/assign 有专属句式）
function tlText(ev) {
  if (ev.detail) return esc(String(ev.detail));
  switch (ev.type) {
    case 'created':
      return ev.to ? `创建于「${esc(tlVal(ev.to, 'status'))}」` : '任务已创建';
    case 'completed':
      return '任务完成';
    case 'assign': {
      if (ev.to != null && ev.to !== '' && (ev.from == null || ev.from === '')) return `指派给 ${esc(tlVal(ev.to, 'assign'))}`;
      if (ev.from != null && ev.from !== '' && (ev.to == null || ev.to === '')) return `取消指派（原：${esc(tlVal(ev.from, 'assign'))}）`;
      return `${esc(tlVal(ev.from, 'assign'))} → ${esc(tlVal(ev.to, 'assign'))}`;
    }
    default:
      return `${esc(tlVal(ev.from, ev.type))} → ${esc(tlVal(ev.to, ev.type))}`;
  }
}

// 时间轴区块：契约 events 倒序（最新在前），客户端直接采用不重排——
// 同毫秒事件（如 status→done 后紧接 completed）的先后语义只有服务端插入序知道，二次排序会翻转 tie
function timelineHtml(events, state) {
  if (state === 'loading') return '<div class="muted small">动态加载中…</div>';
  if (!Array.isArray(events) || !events.length) {
    return `<div class="empty-state tl-empty">${icon('activity')}<span>暂无动态记录（旧任务不回填）</span></div>`;
  }
  // 叙事线第一批：artifact 挂接事件（to=链接）渲染为可点链接（仅放行 http/https），点击打开成果原文
  const tlRow = (ev) => {
    const meta = TL_META[ev.type] || TL_META.edit;
    let textHtml;
    const artUrl = ev.type === 'artifact' ? safeHttpUrl(ev.to) : null;
    if (artUrl) {
      textHtml = `<a class="link tl-art-link" href="${esc(artUrl)}" target="_blank" rel="noreferrer noopener"
        title="打开成果链接（仅 http/https 可点）">${esc(String(ev.detail || artUrl))}</a>`;
    } else {
      textHtml = tlText(ev);
    }
    return `<div class="tl-item ${meta.cls}">
      <span class="tl-dot" aria-hidden="true"></span>
      <span class="tl-body"><span class="tl-label">${esc(meta.label)}</span><span class="tl-text">${textHtml}</span><span class="tl-time" title="${esc(fmtFull(ev.at))}">${fmtAgo(ev.at)}</span></span>
    </div>`;
  };
  // v2.9.15：动态长列表统一折叠（详情接口倒序 100 条，前 5 条即最近 5 条）
  const { main, extra } = foldListHtml(events, (f, t) => `<div class="tl">${events.slice(f, t).map(tlRow).join('')}</div>`, 'fold-tl');
  return main + extra;
}

// v2.9.15：任务详情弹层长列表统一折叠（成果/动态/日报三处同构）——最近 5 条直接展示，
// 其余进折叠体；展开/收起按钮通用 data-act="fold-list"，aria-controls 指向折叠体 id。
// rowHtml(from, to) 渲染 [from,to) 区间（成果的 data-idx 须用数组原下标，由调用方自行偏移）
const DETAIL_FOLD_AFTER = 5;
function foldListHtml(items, rowHtml, bodyId) {
  if (items.length <= DETAIL_FOLD_AFTER) return { main: rowHtml(0, items.length), extra: '' };
  const n = items.length - DETAIL_FOLD_AFTER;
  return {
    main: rowHtml(0, DETAIL_FOLD_AFTER),
    extra: `<button type="button" class="btn ghost xs" data-act="fold-list" data-count="${n}" aria-expanded="false" aria-controls="${bodyId}">${icon('chevron-down')}<span>展开其余 ${n} 条</span></button><div class="fold-list-body" id="${bodyId}" hidden>${rowHtml(DETAIL_FOLD_AFTER, items.length)}</div>`,
  };
}

// 成果行——kind 徽标（PR 蓝 / commit 绿 / v2.3 session 青会话）+ repo + 链接（仅 http/https 可点）+ ref + 时间 + 解除
// kind=session（D3 契约：url/repo/ref 一律 null，独立 sessionRef/title 字段）：专属「会话」徽标（b-upd 词表）
// + title 主文案（全文进悬浮）。只读快照引用无外链、不渲染死链；点击重开阅读器列规格 §9 backlog
function artItemHtml(art, idx) {
  const isSess = art.kind === 'session';
  const isPr = art.kind === 'pr';
  const href = safeHttpUrl(art.url);
  const badge = isSess
    ? `<span class="badge b-upd" title="会话成果：智能体会话的只读快照引用（无外链）">${icon('file-text')}会话</span>`
    : `<span class="badge ${isPr ? 'b-pr' : 'b-commit'}" title="成果类型">${isPr ? 'PR' : 'commit'}</span>`;
  const autoBadge = art.attributedBy === 'auto'
    ? `<span class="badge b-auto" title="自动归因：AI 会话提交匹配分支约定（活动分支=任务分支 / task/任务id 前缀 / 提交信息含 [#任务id]），系统自动挂接">自动归因</span>`
    : '';
  const atHtml = `<span class="muted small art-at" title="${esc(fmtFull(art.at))}">${fmtAgo(art.at)}</span>`;
  const delBtn = `<button type="button" class="btn danger xs" data-act="art-del" data-idx="${idx}" title="解除挂接，任务时间轴同步记录">${icon('x')}解除</button>`;

  // v2.9.15：commit/PR 有提交说明时说明做主行（图2 动态流同构），仓库/链接/ref 降为元信息行、
  // 正文首段（messageBody）做第三行弱化展示；无说明（手动挂接/活动窗外存量）保持原单行布局
  const title = !isSess && typeof art.title === 'string' ? art.title.trim() : '';
  const body = !isSess && typeof art.messageBody === 'string' ? art.messageBody.trim() : '';
  if (!isSess && title) {
    const meta = `${art.repo ? `<span class="mono muted">${esc(art.repo)}</span>` : ''}${href ? `<a class="link" href="${esc(href)}" target="_blank" rel="noreferrer noopener" title="${esc(art.url)}">${isPr ? '打开 PR ↗' : '打开提交 ↗'}</a>` : ''}${art.ref ? `<span class="mono muted" title="ref">${esc(art.ref)}</span>` : ''}`;
    return `<div class="art-item art-card">
      <div class="art-head">${badge}${autoBadge}<span class="art-title" title="${esc(title)}">${esc(title)}</span>${atHtml}${delBtn}</div>
      ${meta ? `<div class="art-meta">${meta}</div>` : ''}
      ${body ? `<div class="art-body" title="${esc(body)}">${esc(body)}</div>` : ''}
    </div>`;
  }
  const main = isSess
    ? `<span class="art-url" title="会话：${esc(art.title || '')}（只读快照引用，无外链）">${esc(art.title || '（未命名会话）')}</span>`
    : (href
      ? `<a class="link art-url" href="${esc(href)}" target="_blank" rel="noreferrer noopener" title="${esc(art.url)}">${esc(art.url)}</a>`
      : `<span class="art-url muted" title="非 http(s) 链接已拦截">${esc(art.url || '')}</span>`);
  return `<div class="art-item">
    ${badge}
    ${/* 分支约定：自动归因成果带紫色小徽标，与手动「挂接成果」区分 */ ''}
    ${autoBadge}
    ${isSess ? '' : art.repo ? `<span class="mono muted">${esc(art.repo)}</span>` : ''}
    ${main}
    ${isSess ? '' : art.ref ? `<span class="mono muted" title="ref（PR 序号 / commit 哈希）">${esc(art.ref)}</span>` : ''}
    ${atHtml}
    ${delBtn}
  </div>`;
}

// 任务详情弹层（点卡片进入；「编辑」快捷操作切换到既有编辑表单）：
// 毛玻璃/3 级阴影/缩放淡入/Escape 关闭全部由 openModal 承担；空值字段整行隐藏（不显示「无」，
// 描述除外——规格要求空描述给空态文案）。数据变更（改状态）后 draw() 重绘弹层体内联刷新。
// 状态切换下拉收进头部徽标排（与优先级/截止同排，即列的当前值，可下拉改列），
// 替代原先的静态列徽标（同一信息不重复展示）；底部操作行只留删除/编辑
export function openTaskDetail(ref) {
  const id = ref.id;
  // 深链双向同步（§4-C）：hash 一律 history.replaceState——不进历史栈、不触发 hashchange；
  // 关闭（Esc/遮罩/×/m.close 四条路径统一走 onClose）恢复 #/board
  const taskHash = `#/board?task=${encodeURIComponent(id)}`;
  const syncHash = () => { try { history.replaceState(null, '', taskHash); } catch { /* 非 http(s) 环境忽略 */ } };
  const clearHash = () => {
    // 仅当 hash 仍是本任务深链时回写（期间用户经侧栏导航改写 hash 时不覆盖）
    if ((location.hash || '') === taskHash) {
      try { history.replaceState(null, '', '#/board'); } catch { /* ignore */ }
    }
  };
  const box = document.createElement('div');
  const m = openModal({ title: '任务详情', body: box, wide: true, onClose: clearHash });
  syncHash();
  let drawSeq = 0; // 异步补「查看原文」链接期间弹层可能重绘/关闭，过期响应直接丢弃
  // v1.7 动态时间轴：events 只在 GET /api/tasks/:id 返回，异步补拉；加载中/失败降级不阻塞主信息
  let detail = null;
  let eventsState = 'loading'; // 'loading' | 'ok' | 'error'

  async function loadDetail() {
    try {
      detail = await apiGet(`/api/tasks/${encodeURIComponent(id)}`);
      eventsState = 'ok';
    } catch { eventsState = 'error'; } // 拉不到动态按空态降级，不影响详情主体
    if (box.isConnected) draw();
    // v2.9.21：绑定项目可能只在详情接口里才有（列表数据未带时首拉空转），detail 回来后补拉一次
    if (eventsState === 'ok' && detail && detail.projectDir && dispatchState === 'none') loadDispatch();
    if (eventsState === 'ok' && detail && detail.projectDir && suggState === 'none') loadSuggest();
    // v2.9.28：detail 回来后才知道 done 态——由此触发复盘拉取
    if (eventsState === 'ok' && detail && detail.status === 'done' && pmState === 'idle') loadPostmortem();
  }

  // 本批任务日报：diary 列表异步补拉（与 events 同模式），失败降级不阻塞详情主体
  let diaryState = 'loading'; // 'loading' | 'ok' | 'error'
  let diaries = [];
  async function loadDiary() {
    try {
      diaries = await apiGet(`/api/tasks/${encodeURIComponent(id)}/diary`);
      diaryState = 'ok';
    } catch { diaryState = 'error'; }
    if (box.isConnected) draw();
  }

  // v2.9.21 派工词：绑定项目下最近会话的首条真人指令（首批三源 zcode/claude/codex，每源 ≤2 条，
  // 服务端 /api/agent-dispatch 聚合）。异步补拉同 diary 模式，失败降级不阻塞详情主体
  let dispatchState = 'loading'; // 'none'（未绑定项目） | 'loading' | 'ok' | 'error'
  let dispatchItems = [];
  async function loadDispatch() {
    const dir = String(
      (detail && typeof detail.projectDir === 'string' && detail.projectDir) ||
      (tasks.find((x) => x.id === id) || {}).projectDir || ''
    ).trim();
    if (!dir) {
      dispatchState = 'none';
      if (box.isConnected) draw();
      return;
    }
    dispatchState = 'loading';
    try {
      const r = await apiGet(`/api/agent-dispatch?project=${encodeURIComponent(dir)}`);
      dispatchItems = Array.isArray(r && r.items) ? r.items : [];
      dispatchState = 'ok';
    } catch { dispatchState = 'error'; }
    if (box.isConnected) draw();
  }

  // v2.9.24 会话归因建议：本任务绑定项目下值得挂接的最近会话（服务端排序打分，人工一键确认）。
  // 与派工词同款异步补拉模式；未绑定项目 none 不渲染
  let suggState = 'none'; // 'none' | 'loading' | 'ok' | 'error'
  let suggItems = [];
  let suggBusy = new Set(); // 正在挂接中的 ref（防双击重复挂）
  async function loadSuggest() {
    const dir = String(
      (detail && typeof detail.projectDir === 'string' && detail.projectDir) ||
      (tasks.find((x) => x.id === id) || {}).projectDir || ''
    ).trim();
    if (!dir) {
      suggState = 'none';
      if (box.isConnected) draw();
      return;
    }
    suggState = 'loading';
    try {
      const r = await apiGet(`/api/tasks/${encodeURIComponent(id)}/session-suggestions`);
      suggItems = Array.isArray(r && r.items) ? r.items : [];
      suggState = 'ok';
    } catch { suggState = 'error'; }
    if (box.isConnected) draw();
  }

  // v2.9.28 任务复盘：done/待验证任务的证据蒸馏（会话派工词/提交/日报 + 跨度），异步补拉
  let pmState = 'idle'; // 'idle' | 'loading' | 'ok' | 'error'
  let pmData = null;
  async function loadPostmortem() {
    const t0 = tasks.find((x) => x.id === id);
    const isDone = (detail && detail.status === 'done') || (t0 && t0.status === 'done');
    if (!isDone) { pmState = 'idle'; return; }
    pmState = 'loading';
    try {
      pmData = await apiGet(`/api/tasks/${encodeURIComponent(id)}/postmortem`);
      pmState = 'ok';
    } catch { pmState = 'error'; }
    if (box.isConnected) draw();
  }

  const row = (key, valHtml) =>
    `<div class="td-row"><span class="td-key">${key}</span><span class="td-val">${valHtml}</span></div>`;

  // 本批任务日报区块：按日倒序列表 + 写/编辑入口。today 判定用本地日期字符串（与契约 YMD 口径一致）；
  // 当天已有日报 → 头部按钮变「编辑今日日报」并预填已有内容（轻过程留痕，不做强制）
  const todayYMD = fmtYMD(new Date());
  const diaryHtml = () => {
    const hasToday = diaries.some((x) => x.date === todayYMD);
    const head = `
        <div class="diary-actions">
          <button type="button" class="btn ghost xs" data-act="diary-write"
            title="${hasToday ? '今天已有日报，点击编辑' : '记录今天的进展 / 卡点 / 下一步'}">${icon('file-text')}${hasToday ? '编辑今日日报' : '写日报'}</button>
          ${diaryState === 'ok' && diaries.length ? `<span class="muted small">共 ${diaries.length} 篇 · 按日倒序</span>` : ''}
        </div>`;
    if (diaryState === 'loading') return `${head}<div class="muted small diary-none">日报加载中…</div>`;
    if (diaryState === 'error') return `${head}<div class="muted small diary-none">日报加载失败（不影响其他信息），可稍后重试</div>`;
    if (!diaries.length) {
      return `${head}<div class="empty-state diary-empty">${icon('file-text')}<span>暂无日报——多日任务建议按日留痕</span></div>`;
    }
    const diaryRow = (en) => `
      <div class="diary-item">
        <div class="diary-h">
          <span class="badge b-task diary-date">${esc(en.date)}</span>
          ${en.date === todayYMD ? '<span class="badge b-diary-ok" title="今天">今天</span>' : ''}
          <span class="muted small diary-ago" title="${esc(fmtFull(en.updatedAt))}">${fmtAgo(en.updatedAt)}</span>
          <button type="button" class="icon-btn" data-act="diary-edit" data-date="${esc(en.date)}" title="编辑该日日报">${icon('pencil')}</button>
          <button type="button" class="icon-btn" data-act="diary-del" data-date="${esc(en.date)}" title="删除该日日报">${icon('trash')}</button>
        </div>
        <div class="diary-content">${esc(en.content)}</div>
      </div>`;
    // v2.9.15：日报长列表统一折叠（按日倒序，前 5 条即最近 5 天）
    const diaryFold = foldListHtml(diaries, (f, t) => `<div class="diary-list">${diaries.slice(f, t).map(diaryRow).join('')}</div>`, 'fold-diary');
    return `${head}${diaryFold.main}${diaryFold.extra}`;
  };

  // v2.9.24 派工词区块：「这单当时是怎么派工的」。长文本 2 行钳制 + .fold-toggle 折叠展开全文
  const DP_AGENT_LABEL = { zcode: 'ZCode', claude: 'Claude', codex: 'Codex', dsh: 'DSH', workbuddy: 'WorkBuddy', opencode: 'OpenCode' };
  const dispatchHtml = () => {
    const head = `<div class="dp-hint muted small">绑定项目下最近会话的首条指令（zcode / claude / codex，各最多 2 条）</div>`;
    if (dispatchState === 'loading') return `${head}<div class="muted small dp-none">派工词加载中…</div>`;
    if (dispatchState === 'error') return `${head}<div class="muted small dp-none">派工词加载失败（不影响其他信息），可稍后重试</div>`;
    if (!dispatchItems.length) return `${head}<div class="muted small dp-none">最近会话未取到真人指令（纯注入或会话在别处）</div>`;
    const dpItem = (it) => {
      const text = String(it.text || '');
      const long = text.length > 140;
      const when = it.startedAt ? `<span class="muted small" title="${esc(fmtFull(it.startedAt))}">${fmtAgo(it.startedAt)}</span>` : '';
      return `
        <div class="dp-item">
          <div class="dp-h">
            <span class="badge b-task">${esc(DP_AGENT_LABEL[it.agent] || it.agent)}</span>
            ${when}
          </div>
          <div class="dp-text${long ? ' dp-clamp' : ''}">${esc(text)}</div>
          ${long ? `<div class="fold"><button type="button" class="fold-toggle" aria-expanded="false">${icon('chevron-down')}<span>展开全文</span></button><div class="fold-body" hidden><div class="dp-text">${esc(text)}</div></div></div>` : ''}
        </div>`;
    };
    return `${head}<div class="dp-list">${dispatchItems.slice(0, 6).map(dpItem).join('')}</div>`;
  };

  // v2.9.24 会话归因建议区块：绑定项目下值得挂接的会话（服务端打分，人工一键确认走既有 artifacts 通道）
  const suggestHtml = () => {
    if (suggState === 'none') return '';
    const head = suggItems.length
      ? `<div class="sugg-head">${icon('zap')}建议挂接<span class="badge b-task">${suggItems.length}</span><span class="muted small">绑定项目下与任务同期活跃的会话，点击确认挂接</span></div>`
      : '';
    if (suggState === 'loading') return `${head}<div class="muted small sugg-none">建议加载中…</div>`;
    if (suggState === 'error') return `${head}<div class="muted small sugg-none">建议加载失败（不影响其他信息）</div>`;
    if (!suggItems.length) return '';
    const row = (it) => {
      const text = String(it.dispatchText || it.title || '').trim() || '（未命名会话）';
      const busy = suggBusy.has(it.ref);
      return `
        <div class="sugg-item">
          <span class="badge b-task">${esc(DP_AGENT_LABEL[it.agent] || it.agent)}</span>
          <span class="sugg-text" title="${esc(it.reasons ? it.reasons.join(' · ') : '')}">${esc(text)}</span>
          <span class="muted small" title="${esc(fmtFull(it.lastActiveAt))}">${fmtAgo(it.lastActiveAt)}</span>
          <button type="button" class="btn ghost xs" data-act="sugg-attach" data-ref="${esc(it.ref)}"
            data-title="${esc(text.slice(0, 200))}" ${busy ? 'disabled' : ''}
            title="挂接为会话成果（验收证据）">${icon('paperclip')}${busy ? '挂接中…' : '挂接'}</button>
        </div>`;
    };
    return `${head}<div class="sugg-list">${suggItems.slice(0, 5).map(row).join('')}</div>`;
  };

  // v2.9.28 任务复盘区块：done 任务的证据蒸馏（数字 + 派工词 + 提交 + 日报），一页纸
  const postmortemHtml = () => {
    if (pmState !== 'ok' || !pmData) return '';
    const c = pmData.counts || {};
    const span = pmData.span || {};
    const statLine = `会话 ${c.sessions || 0} · 提交 ${c.commits || 0}（含 PR ${c.prs || 0}）· 日报 ${c.diaries || 0}${span.days != null ? ` · 跨度 ${span.days} 天` : ''}`;
    const dw = (pmData.evidence && pmData.evidence.dispatchWords) || [];
    const cm = (pmData.evidence && pmData.evidence.commits) || [];
    const dr = (pmData.evidence && pmData.evidence.diaries) || [];
    const sec = (label, items, render) => (items.length
      ? `<div class="pm-sec"><div class="pm-sec-h">${label}</div>${items.map(render).join('')}</div>`
      : '');
    const body = `
      <div class="muted small pm-stat">${esc(statLine)}</div>
      ${sec('当时怎么派工的', dw, (w) => `<div class="pm-line" title="${esc(w.ref)}">${icon('mic')}<span>${esc(String(w.dispatchText || w.title || '（未命名会话）').slice(0, 120))}</span></div>`)}
      ${sec('做了什么提交', cm, (k) => `<div class="pm-line">${icon(k.kind === 'pr' ? 'git-pull-request' : 'git-commit')}<span>${esc(String(k.title || '').slice(0, 120))}</span><span class="muted small">${esc(k.repo || '')}</span></div>`)}
      ${sec('哪天留了痕', dr, (d) => `<div class="pm-line">${icon('file-text')}<span>${esc(d.date)}</span><span class="muted small">${esc(d.excerpt)}</span></div>`)}
      ${(dw.length || cm.length || dr.length) ? '' : '<div class="muted small pm-stat">暂无关联证据——复盘随成果挂接逐步充实</div>'}`;
    return `
      <div class="fold pm-fold">
        <button type="button" class="fold-toggle" aria-expanded="false">${icon('chevron-down')}<span>复盘 · ${esc(statLine)}</span></button>
        <div class="fold-body" hidden><div class="pm-body">${body}</div></div>
      </div>`;
  };

  // P2-1：origin.refId（候选卡 id）→ 候选的 messageId → 纪要 ref.url；
  // 任一环拿不到（接口失败/数据缺失）返回 null，前端降级为只显示引用文本
  async function resolveOriginUrl(refId) {
    if (!refId) return null;
    const cands = await apiGet('/api/inbox');
    const cand = (cands || []).find((c) => c.id === refId);
    if (!cand || !cand.messageId) return null;
    const msg = await apiGet(`/api/radar/messages/${encodeURIComponent(cand.messageId)}`);
    return safeHttpUrl(msg && msg.ref && msg.ref.url);
  }

  const draw = () => {
    const t = tasks.find((x) => x.id === id);
    if (!t) {
      box.innerHTML = `<div class="empty-state">${icon('inbox')}<span>任务已不存在</span></div>`;
      return;
    }
    const ag = t.agentId && agentMap().get(t.agentId);
    const mem = t.memberId && humanMap().get(t.memberId);
    // 指派可点 → 成员页（默认 hash 导航继续，仅收起本弹层）；验收人徽标同行展示（v2.0）
    const assign = [
      ag ? `<a href="#/members" class="td-nav link"><span class="agent-dot" style="background:${avatarColor(t.agentId)}"></span>${esc(ag.name)}</a>` : '',
      mem ? `<a href="#/members" class="td-nav"><span class="badge b-ro member-tag">${icon('user')}${esc(mem.name)}</span></a>` : '',
      acceptorBadge(t, humanMap(), { hot: true })
    ].filter(Boolean).join('');
    // prUrl 仅放行 http/https 为可点链接（与卡片一致，遵守 safeHttpUrl），否则降级纯文本
    const prHref = safeHttpUrl(t.prUrl);
    const prCell = t.prUrl
      ? (prHref
        ? `<a href="${esc(prHref)}" target="_blank" rel="noreferrer noopener">${esc(t.prUrl)}</a>`
        : `<span class="muted" title="链接已拦截：仅放行 http/https">${esc(t.prUrl)}</span>`)
      : '';
    // 分支约定（本批）：约定分支名 = task/<任务id>，AI 会话启动（launch 带 taskId）时后端自动注入，
    // 提交按归因规则自动挂回任务。「仓库」行升级为「分支 / 仓库」并恒渲染——
    // 「复制分支名」复制的是约定名 task/<id>，与 task.branch 是否已填无关（无分支任务也要能取到约定名）
    const convBranch = `task/${t.id}`;
    const repoLine = [t.repo ? `<span class="mono muted">${esc(t.repo)}</span>` : '', prCell]
      .filter(Boolean).join('<span class="muted"> · </span>');
    const branchRow = `
        <div class="td-row"><span class="td-key">分支 / 仓库</span>
          <div class="td-val td-branch">
            <div class="branch-line">
              ${t.branch ? `<span class="mono" title="任务当前分支">${esc(t.branch)}</span>` : ''}
              <button type="button" class="btn ghost xs" data-act="branch-copy"
                title="复制约定分支名 ${esc(convBranch)}（AI 会话启动时自动携带）">${icon('copy')}复制分支名</button>
              <span class="muted small">AI 会话启动时自动携带此约定</span>
            </div>
            ${repoLine ? `<div class="repo-line">${repoLine}</div>` : ''}
          </div>
        </div>`;
    // v2.9.4：项目绑定显示行（ambient 归属；detail 接口优先取最新值，绑定/解绑经会话列表弹层操作）
    const boundDir = (eventsState === 'ok' && detail && detail.projectDir !== undefined) ? detail.projectDir : t.projectDir;
    const projectRow = boundDir
      ? `<div class="td-row"><span class="td-key">绑定项目</span>
          <div class="td-val"><span class="mono" title="${esc(boundDir)}">${esc(boundDir)}</span>
          <span class="muted small">该项目下的智能体会话归属本任务（在智能体动态的会话列表里管理）</span></div>
        </div>`
      : '';
    const statusOpts = columns.map((c) =>
      `<option value="${esc(c.id)}"${c.id === t.status ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    // P2-1 来源区块：来源类型（听记）+ 原文引用折叠（斜体引文）+ 查看原文链接（异步补，失败只留引用）
    const origin = t.origin || null;
    const originQuote = origin ? String(origin.quote || '') : '';
    // 叙事线第一批：任务更新的 memo 留痕落在 origin.relatedMemos；纯手动任务更新后 origin.type 可能是 manual
    const originTypeLabel = origin ? (origin.type === 'inbox' ? '听记' : origin.type === 'manual' ? '手动更新' : origin.type) : '';
    const originRow = origin ? `
        <div class="td-row"><span class="td-key">来源</span>
          <div class="td-val td-origin">
            <span class="badge b-pr origin-type" title="来自任务雷达 · 钉钉听记 AI 拆解，经人工确认入库">${icon('radar')}${esc(originTypeLabel)}</span>
            ${originQuote ? `
            <div class="fold origin-fold">
              <button type="button" class="fold-toggle" aria-expanded="false">${icon('chevron-down')}<span>原文引用</span></button>
              <div class="fold-body" hidden><div class="radar-quote">“${esc(originQuote)}”</div></div>
            </div>` : ''}
            ${origin.refId ? `<a class="link origin-link" href="#" target="_blank" rel="noreferrer noopener" hidden>查看原文</a>
            <span class="muted small origin-link-none" hidden>（未取到原文链接）</span>` : ''}
          </div></div>` : '';

    // 叙事线第一批：成果区块——PR/commit 挂接列表 + 挂接入口；详情接口优先（含最新 artifacts），列表数据兜底
    const arts = (eventsState === 'ok' && detail && Array.isArray(detail.artifacts))
      ? detail.artifacts
      : (Array.isArray(t.artifacts) ? t.artifacts : []);
    // 分支约定：无分支且尚无自动归因成果 → 成果区顶部淡提示引导业主取约定分支名；
    // 有 branch 或已有自动归因成果（归因链路已跑通）任一成立即不显示
    const showBranchHint = !t.branch && !arts.some((a) => a && a.attributedBy === 'auto');
    // v2.9.15：成果长列表统一折叠（数组序即动态落盘序，最新在前）；解除挂接 data-idx 恒为数组原下标
    const artsFold = foldListHtml(arts, (f, t) => `<div class="art-list">${arts.slice(f, t).map((a, i) => artItemHtml(a, f + i)).join('')}</div>`, 'fold-arts');
    const artRow = `
        <div class="td-row"><span class="td-key">成果</span>
          <div class="td-val td-art">
            ${showBranchHint ? `<div class="branch-hint">${icon('git-branch')}<span>提示：复制分支名给 AI 会话（启动时自动携带），提交会自动归因到这里</span></div>` : ''}
            ${artsFold.main || `<div class="muted small art-none">暂无成果——把 PR / commit 挂到任务上，验收可溯源</div>`}
            ${artsFold.extra}
            ${suggestHtml()}
            <div style="margin-top:${arts.length ? '2px' : '8px'}">
              <button type="button" class="btn ghost xs" data-act="art-add" title="手动挂接 PR / commit 链接">${icon('paperclip')}挂接成果</button>
            </div>
          </div></div>`;

    box.innerHTML = `
      <div class="td-title">${esc(t.title)}</div>
      <div class="td-head">
        <select class="status-sel td-status-sel" aria-label="移动到其他列" title="改列即保存">${statusOpts}</select>
        ${priorityChip(t.priority)}
        ${/* v1.7：done 任务状态行旁显示完成时间（徽标 title 绝对 + 相对时间），不再亮逾期/到期徽标 */ ''}
        ${t.completedAt
          ? `${completedBadge(t.completedAt, { lg: true })}<span class="muted small" title="${esc(fmtFull(t.completedAt))}">完成于 ${fmtAgo(t.completedAt)}</span>`
          : dueBadge(t.dueDate, { lg: true })}
        ${t.dueDate ? `<span class="mono muted small">${esc(t.dueDate)}</span>` : ''}
      </div>
      <div class="td-grid">
        ${t.desc
          ? row('描述', `<span class="td-desc">${esc(t.desc)}</span>`)
          : row('描述', `<div class="empty-state td-empty">${icon('inbox')}<span>暂无描述</span></div>`)}
        ${assign ? row('指派', `<span class="td-assign">${assign}</span>`) : ''}
        ${branchRow}
        ${projectRow}
        ${originRow}
        ${artRow}
        ${boundDir && dispatchState !== 'none'
          ? `<div class="td-row td-dispatch-row"><span class="td-key">派工词</span>
              <div class="td-val td-dispatch">${dispatchHtml()}</div></div>`
          : ''}
        ${pmState !== 'idle'
          ? `<div class="td-row td-pm-row"><span class="td-key">复盘</span>
              <div class="td-val">${postmortemHtml() || (pmState === 'loading' ? '<span class="muted small">复盘加载中…</span>' : '')}</div></div>`
          : ''}
        <div class="td-row"><span class="td-key">创建 / 更新</span>
          <span class="td-val muted"><span title="${esc(fmtFull(t.createdAt))}">${fmtAgo(t.createdAt)}</span>
          · <span title="${esc(fmtFull(t.updatedAt))}">${fmtAgo(t.updatedAt)}</span></span></div>
        <div class="td-row td-diary-row"><span class="td-key">日报</span>
          <div class="td-val">${diaryHtml()}</div></div>
        <div class="td-row td-tl-row"><span class="td-key">动态</span>
          <div class="td-val">${timelineHtml(eventsState === 'ok' && detail ? detail.events : null, eventsState)}</div></div>
      </div>
      <div class="td-actions">
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="copy-link" title="复制本任务的直达链接（#/board?task=…）">${icon('link')}复制链接</button>
        <button type="button" class="btn danger" data-act="del">${icon('trash')}删除</button>
        <button type="button" class="btn" data-act="edit">${icon('pencil')}编辑</button>
      </div>`;

    // 异步补「查看原文」：候选数据只带 messageId，需两跳查询；拿不到就显示占位文案
    if (origin && origin.refId) {
      const seq = ++drawSeq;
      resolveOriginUrl(origin.refId).then((url) => {
        if (seq !== drawSeq || !box.isConnected) return;
        const a = box.querySelector('.origin-link');
        const none = box.querySelector('.origin-link-none');
        if (a && url) { a.href = url; a.hidden = false; }
        else if (none) none.hidden = false;
      }).catch(() => {
        if (seq !== drawSeq || !box.isConnected) return;
        const none = box.querySelector('.origin-link-none');
        if (none) none.hidden = false;
      });
    }
  };
  draw();
  loadDetail(); // v1.7：异步补拉 events（详情接口独有），返回后重绘时间轴
  loadDiary(); // 本批：异步补拉日报列表，返回后重绘日报区
  loadDispatch(); // v2.9.21：异步补拉派工词（绑定项目下最近会话首条真人指令）
  loadSuggest(); // v2.9.24：异步补拉会话归因建议（绑定项目下值得挂接的最近会话）
  loadPostmortem(); // v2.9.28：done 任务异步补拉复盘蒸馏

  // 分支约定复制：navigator.clipboard 优先（安全上下文 + 授权时可用）；
  // 权限拒绝 / 非安全上下文 / 异常时降级隐藏 textarea + document.execCommand('copy')，
  // 两条路径都失败才报错，toast 文案带约定名便于手动复制
  async function copyBranchName() {
    const conv = `task/${id}`;
    let ok = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(conv);
        ok = true;
      }
    } catch { ok = false; }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = conv;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (ok) toast(`已复制 ${conv}`, 'success');
    else toast(`复制失败，请手动复制：${conv}`);
  }

  // 深链复制（§4-C）：navigator.clipboard 优先、execCommand 兜底（复用 copyBranchName 模式），
  // 两条路径都失败才报错，toast 文案给完整 URL 便于手动复制
  async function copyTaskLink() {
    const url = `${location.origin}${location.pathname}#/board?task=${encodeURIComponent(id)}`;
    let ok = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch { ok = false; }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (ok) toast('链接已复制，可直接分享 / 收藏', 'success');
    else toast(`复制失败，请手动复制：${url}`);
  }

  // 叙事线第一批：挂接成果弹层（独立于动态页入口）——url/kind/repo/ref → POST artifacts
  function openArtifactModal() {
    const box = document.createElement('div');
    box.innerHTML = `
      <form id="art-form">
        <div class="form-row"><label class="req">成果链接（http/https）</label>
          <input name="url" required placeholder="https://gitea.example.com/example-org/fde-api/pulls/12"></div>
        <div class="form-row"><label>类型</label>
          <select name="kind" aria-label="成果类型">
            <option value="pr">PR</option>
            <option value="commit">commit</option>
          </select></div>
        <div class="form-row"><label>仓库（可选）</label>
          <input name="repo" list="art-repo-list" placeholder="example-org/fde-api">
          <datalist id="art-repo-list"></datalist>
        </div>
        <div class="form-row"><label>ref（可选：PR 序号 / commit 哈希）</label>
          <input name="ref" placeholder="12 / 9f2c1ab"></div>
        <div class="form-err" id="art-form-err"></div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-act="cancel">取消</button>
          <button type="submit" class="btn">${icon('paperclip')}挂接</button>
        </div>
      </form>`;
    const m = openModal({ title: '挂接成果', body: box });
    const errEl = box.querySelector('#art-form-err');
    box.querySelector('[data-act=cancel]').addEventListener('click', m.close);
    // v2.9.25 仓库下拉（datalist：Gitea 组织仓库建议，保留手输——GitHub/Gitee 链接的仓库名不在组织清单内）；
    // 任务已绑仓库直接预填。拉取失败降级纯手输，不阻塞表单
    (async () => {
      const inp = box.querySelector('input[name=repo]');
      const cur = tasks.find((x) => x.id === id);
      if (inp && cur && cur.repo && !inp.value) inp.value = cur.repo;
      try {
        const repos = await apiGet('/api/repos');
        const dl = box.querySelector('#art-repo-list');
        if (dl && Array.isArray(repos)) dl.innerHTML = repos.map((r) => `<option value="${esc(r.fullName || '')}"></option>`).join('');
      } catch { /* 组织仓库拉不到：纯手输 */ }
    })();
    box.querySelector('#art-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      // busy 锁：POST 期间「挂接」按钮 disabled，防重复提交（§4-E）
      busyBtn(f.querySelector('[type=submit]'), async () => {
        errEl.classList.remove('show');
        const val = (n) => f.elements.namedItem(n).value;
        const url = val('url').trim();
        if (!safeHttpUrl(url)) { errEl.textContent = 'url 必须为 http(s) 链接'; errEl.classList.add('show'); return; }
        try {
          await apiPost(`/api/tasks/${encodeURIComponent(id)}/artifacts`, {
            url,
            kind: val('kind') === 'commit' ? 'commit' : 'pr',
            repo: val('repo').trim() || null,
            ref: val('ref').trim() || null
          });
          m.close();
          toast('成果已挂接，任务时间轴同步记录', 'success');
          await refresh();
          await loadDetail(); // 重拉 artifacts 与 events（挂接动作本身也是一条 artifact 事件）
        } catch (err) {
          errEl.textContent = `${err.code ? `${err.code}: ` : ''}${err.message}`;
          errEl.classList.add('show');
        }
      });
    });
  }

  // 本批任务日报编辑器：日期（默认今天，编辑时预填该日）+ 内容 ≤2000 字（实时计数）+ 从今日动态预填
  // （prefill 端点取拼好的草稿，已有内容追加不覆盖；giteaCommits/memoUpdates 以小徽标列出供参考）
  function openDiaryEditor(entry = null) {
    const box2 = document.createElement('div');
    box2.innerHTML = `
      <form id="diary-form">
        <div class="form-row"><label class="req">日期（同日保存即覆盖该日日报）</label>
          <input type="date" name="date" required value="${esc(entry ? entry.date : todayYMD)}"></div>
        <div class="form-row"><label>今日内容（做了什么 / 卡在哪 / 下一步）</label>
          <textarea name="content" rows="7" maxlength="2000"
            placeholder="例：完成回调地址编码并自测通过；卡在网关白名单未放行；明天联调登出失效。">${esc(entry ? entry.content : '')}</textarea>
          <div class="char-count" aria-live="polite"></div></div>
        <div class="diary-prefill">
          <div class="diary-prefill-line">
            <button type="button" class="btn ghost xs" data-act="diary-prefill"
              title="拉取当日 Gitea 提交与纪要提及，自动拼草稿">${icon('zap')}从今日动态预填</button>
            <span class="muted small">按上方所选日期拉取；已有内容则追加不覆盖</span>
          </div>
          <div class="diary-prefill-src" hidden></div>
        </div>
        <div class="form-err"></div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-act="cancel">取消</button>
          <button type="submit" class="btn">${entry ? '保存修改' : '保存日报'}</button>
        </div>
      </form>`;
    const m2 = openModal({ title: entry ? `编辑日报 · ${entry.date}` : '写日报', body: box2 });
    const errEl = box2.querySelector('.form-err');
    const showErr = (msg) => { errEl.textContent = msg; errEl.classList.add('show'); };
    const dateEl = box2.querySelector('[name=date]');
    const ta = box2.querySelector('[name=content]');
    const count = box2.querySelector('.char-count');
    const preBtn = box2.querySelector('[data-act=diary-prefill]');
    const updateCount = () => {
      const n = ta.value.length;
      count.textContent = `${n} / 2000`;
      count.classList.toggle('over', n > 2000);
    };
    ta.addEventListener('input', updateCount);
    updateCount();
    box2.querySelector('[data-act=cancel]').addEventListener('click', m2.close);

    // 从今日动态预填：draft 填入编辑器；两数据源以小徽标列出（commit 可点开原文，纪要悬浮看引用+备注）
    preBtn.addEventListener('click', () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEl.value)) { showErr('请先选择有效日期，再预填该日动态'); return; }
      busyBtn(preBtn, async () => {
        errEl.classList.remove('show');
        try {
          const pre = await apiGet(`/api/tasks/${encodeURIComponent(id)}/diary/prefill?date=${encodeURIComponent(dateEl.value)}`);
          const draft = String((pre && pre.draft) || '');
          const cur = ta.value.trim(); // 已有内容追加不覆盖（空行分隔），空内容直接填入
          ta.value = cur ? `${cur}\n\n${draft}` : draft;
          updateCount();
          const src = box2.querySelector('.diary-prefill-src');
          const commits = Array.isArray(pre && pre.giteaCommits) ? pre.giteaCommits : [];
          const memos = Array.isArray(pre && pre.memoUpdates) ? pre.memoUpdates : [];
          const srcHtml = commits.map((c) => {
            const href = safeHttpUrl(c && c.url);
            const tip = esc(`${(c && c.title) || ''}${c && c.sha ? ` · ${c.sha}` : ''}`);
            const inner = `${icon('git-commit')}${esc((c && c.sha) || 'commit')}`;
            return href
              ? `<a class="badge b-commit diary-src" href="${esc(href)}" target="_blank" rel="noreferrer noopener" title="${tip}">${inner}</a>`
              : `<span class="badge b-commit diary-src" title="${tip}">${inner}</span>`;
          }).join('') + memos.map((mm) => {
            const quote = String((mm && mm.quote) || '');
            const tip = esc(`纪要：${quote}${mm && mm.note ? `（备注：${mm.note}）` : ''}`);
            return `<span class="badge b-upd diary-src" title="${tip}">${icon('file-text')}${esc(quote.slice(0, 10) + (quote.length > 10 ? '…' : '')) || '纪要'}</span>`;
          }).join('');
          src.innerHTML = srcHtml || '<span class="muted small">当日暂无 Gitea 提交与纪要动态</span>';
          src.hidden = false;
        } catch (err) {
          showErr(err.message);
          toast(err.message);
        }
      });
    });

    box2.querySelector('#diary-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      busyBtn(f.querySelector('[type=submit]'), async () => {
        const val = (n) => f.elements.namedItem(n).value;
        errEl.classList.remove('show');
        const date = val('date');
        const content = val('content');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { showErr('日期必填（YYYY-MM-DD）'); return; }
        if (!content.trim()) { showErr('内容不能为空'); return; }
        if (content.length > 2000) { showErr(`内容不能超过 2000 字（当前 ${content.length} 字）`); return; }
        try {
          await api(`/api/tasks/${encodeURIComponent(id)}/diary`, { method: 'PUT', body: { date, content } });
          toast('日报已保存', 'success');
          m2.close();
          await loadDiary(); // 重拉列表：当天有日报后头部按钮自动变「编辑今日日报」
        } catch (err) {
          showErr(err.message);
          toast(err.message);
        }
      });
    });
  }

  // 事件委托挂在 box 上：draw() 重绘体内联后监听不丢
  box.addEventListener('click', async (e) => {
    if (e.target.closest('a.td-nav')) { m.close(); return; } // 跳成员页：放行默认导航
    if (e.target.closest('a.origin-link, a.tl-art-link, a.art-url, a.diary-src')) return; // 外链放行（target=_blank）
    const fold = e.target.closest('.fold-toggle');
    if (fold) {
      const body = fold.parentElement.querySelector('.fold-body');
      if (body) {
        body.hidden = !body.hidden;
        fold.classList.toggle('open', !body.hidden);
        fold.setAttribute('aria-expanded', String(!body.hidden));
      }
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    if (btn.dataset.act === 'edit') {
      m.close();
      openTaskModal({ task: t }); // 现有编辑表单，字段全部预填
    } else if (btn.dataset.act === 'del') {
      const ok = await confirmModal('该操作不可恢复。', { title: `删除任务「${t.title}」？` });
      if (!ok) return;
      try {
        await apiDel(`/api/tasks/${encodeURIComponent(t.id)}`);
        toast('任务已删除', 'success');
        m.close(); // 204 后先关详情弹层再刷新看板，卡片随之消失
        refresh();
      } catch (err) { toast(err.message); }
    } else if (btn.dataset.act === 'branch-copy') {
      copyBranchName();
    } else if (btn.dataset.act === 'copy-link') {
      copyTaskLink();
    } else if (btn.dataset.act === 'fold-list') {
      // v2.9.15：详情弹层长列表统一「展开其余 N 条 / 收起」（成果/动态/日报三处通用）——
      // 只切显隐与文案，不重绘（重绘会丢展开态）；条数取渲染时的 data-count，兼容各列表结构
      const targetId = btn.getAttribute('aria-controls');
      const body = targetId ? box.querySelector(`#${targetId}`) : null;
      if (body) {
        body.hidden = !body.hidden;
        btn.classList.toggle('open', !body.hidden);
        btn.setAttribute('aria-expanded', String(!body.hidden));
        const span = btn.querySelector('span');
        if (span) span.textContent = body.hidden ? `展开其余 ${btn.dataset.count} 条` : '收起';
      }
    } else if (btn.dataset.act === 'art-add') {
      openArtifactModal();
    } else if (btn.dataset.act === 'sugg-attach') {
      // v2.9.24 建议一键挂接：session 形态走既有 artifacts 通道；成功后重拉成果与建议（幂等出局）
      const ref = btn.dataset.ref;
      if (!ref || suggBusy.has(ref)) return;
      suggBusy.add(ref);
      draw();
      try {
        await apiPost(`/api/tasks/${encodeURIComponent(t.id)}/artifacts`, {
          kind: 'session',
          sessionRef: ref,
          title: btn.dataset.title || '会话成果',
        });
        toast('已挂接会话成果', 'success');
        suggItems = suggItems.filter((x) => x.ref !== ref);
        await loadDetail();
      } catch (err) {
        toast(err.message);
      } finally {
        suggBusy.delete(ref);
        if (box.isConnected) draw();
      }
    } else if (btn.dataset.act === 'art-del') {
      // 叙事线第一批：解除成果挂接（按当前列表 idx，DELETE 后重拉详情与看板缓存）
      const idx = Number(btn.dataset.idx);
      const arts = (eventsState === 'ok' && detail && Array.isArray(detail.artifacts))
        ? detail.artifacts
        : (Array.isArray(t.artifacts) ? t.artifacts : []);
      const art = arts[idx];
      if (!art) return;
      // 会话成果无 url（D3）：确认文案退到 title，避免出现「挂接：null」
      const ok = await confirmModal(`将解除该成果与任务的挂接：${art.url || art.title || ''}`, { title: '解除成果挂接？', okText: '解除' });
      if (!ok) return;
      try {
        await apiDel(`/api/tasks/${encodeURIComponent(id)}/artifacts/${idx}`);
        toast('已解除成果挂接，任务时间轴同步记录', 'success');
        await refresh();
        await loadDetail();
      } catch (err) { toast(err.message); }
    } else if (btn.dataset.act === 'diary-write') {
      // 本批：当天已有日报 → 预填已有内容进编辑器（变相「编辑今日日报」）；否则新建
      const cur = diaries.find((x) => x.date === todayYMD);
      openDiaryEditor(cur || null);
    } else if (btn.dataset.act === 'diary-edit') {
      const cur = diaries.find((x) => x.date === btn.dataset.date);
      if (cur) openDiaryEditor(cur);
    } else if (btn.dataset.act === 'diary-del') {
      const en = diaries.find((x) => x.date === btn.dataset.date);
      if (!en) return;
      const ok = await confirmModal(`将删除 ${en.date} 的日报，该操作不可恢复。`, { title: '删除日报？', okText: '删除' });
      if (!ok) return;
      try {
        await apiDel(`/api/tasks/${encodeURIComponent(id)}/diary/${encodeURIComponent(en.date)}`);
        toast('日报已删除', 'success');
        await loadDiary();
      } catch (err) { toast(err.message); }
    }
  });
  box.addEventListener('change', async (e) => {
    const sel = e.target.closest('.td-status-sel');
    if (!sel) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: sel.value } });
      await refresh();
      await loadDetail(); // 重拉 events：改列/完成会在时间轴追加状态/完成事件
    } catch (err) {
      toast(err.message);
      refresh();
    }
  });
}

// 列管理弹层：增 / 改名 / 删（删非空列 409 提示直出）
function openColumnsModal() {
  const box = document.createElement('div');
  const m = openModal({ title: '列管理', body: box });

  const drawRows = () => {
    box.innerHTML = `
      ${columns.map((c) => `
        <div class="col-row" data-id="${esc(c.id)}">
          <input value="${esc(c.name)}" aria-label="列名">
          <button type="button" class="btn ghost xs" data-act="save">保存</button>
          <button type="button" class="btn danger xs" data-act="del">删除</button>
        </div>`).join('')}
      <div class="col-row">
        <input placeholder="新列名，如：阻塞" aria-label="新列名">
        <button type="button" class="btn xs" data-act="add">${icon('plus')}新增列</button>
      </div>
      <p class="muted small" style="margin:8px 0 0">删除非空列会被拒绝（409），需先移走该列任务。</p>`;
  };
  drawRows();

  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.col-row');
    const input = row.querySelector('input');
    const act = btn.dataset.act;
    try {
      if (act === 'save') {
        const id = row.dataset.id;
        await api(`/api/columns/${encodeURIComponent(id)}`, { method: "PATCH", body: { name: input.value.trim() } });
        toast('列名已更新', 'success');
      } else if (act === 'del') {
        const id = row.dataset.id;
        const col = columns.find((c) => c.id === id);
        const ok = await confirmModal('删除后不可恢复；非空列需先移走任务。', { title: `删除列「${col ? col.name : id}」？` });
        if (!ok) return;
        await apiDel(`/api/columns/${encodeURIComponent(id)}`);
        toast('列已删除', 'success');
      } else if (act === 'add') {
        await apiPost('/api/columns', { name: input.value.trim() });
        toast('列已新增', 'success');
      }
      await refresh();
      if (box.isConnected) drawRows();
    } catch (err) {
      toast(err.message); // 409 COLUMN_NOT_EMPTY 等文案直出
    }
  });
}

// 动态流「匹配任务」跳转高亮（滚动+flash 与深链共用 flashCard）
function focusPending() {
  const root = rootEl;
  if (!root || !state.pendingTaskFocus) return;
  const id = state.pendingTaskFocus;
  state.pendingTaskFocus = null;
  const tryFocus = (attempt) => {
    const cur = rootEl;
    const card = cur && cur.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
    if (!card) {
      // 任务可能被搜索过滤掉了：清空搜索重取一次
      if (attempt === 0 && rootEl && q) { q = ''; refresh().then(() => tryFocus(1)); }
      return;
    }
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 2600);
  };
  tryFocus(0);
}
