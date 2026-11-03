// 任务拓扑视图（业主点单，参考 cankao/DSH-better-sidebar Tasks 页思路）：任务 → 派生 AI 会话 → 成果
// v2.9.16 起收敛为树视图单形态（DOM 缩进行，信息密度高）——原 SVG 工作流图模式整体删除：
//   三列图在「单任务几十条成果」场景下要么节点刷屏、要么大片空白（业主实测否决，倒不如只留树）。
// 数据 = 既有端点（GET /api/tasks + /api/agent-sessions，task.artifacts / 会话 taskId/ref 联动），零后端改动、零图形库
// v2.3 B5 会话源切换（SPEC-READER D5 后续收口）：会话节点数据源从退役的 sessions 注册表切到
//   /api/agent-sessions?agent=<src>——面板头加来源下拉（zcode/claude/dsh/workbuddy/codex，默认 zcode），
//   切换即拉该源会话列表渲染会话节点；任务↔会话连线口径：条目显式 taskId，或 ref（base64url(JSON{s,k,v})）
//   解出的会话 id 与任务 id 对齐；加载失败空态 + 重试。会话节点点击 → 宿主视图注入的阅读器回调（只读）
// v2.9 面板迁居：自智能体页迁往总览页（views/overview.js 挂载；模块本身视图无关，mount 签名不变），
//   会话节点点击回调 = overview.js 复用 agents.js 导出的 openSessionReader
// v2.9.15 拓扑瘦身：commit 类成果按「任务 × 仓库」分组合并——同仓几十条提交收敛为一个
//   「commit ×N 仓库」行（悬浮列组内最新提交说明），PR/会话成果语义各异保持单节点
// 轮询沿用 10s tick：宿主视图（overview.js）把最新任务数据 update() 进来，这里按规范化指纹脏比较，
//   无变化跳过重绘（参照 board.js snapshotKey 模式）；切换/过滤/折叠只重绘面板体
import { apiGet } from '../api.js';
import { esc, icon, fmtAgo, fmtFull, avatarColor, safeHttpUrl } from '../ui.js';

// 内置四列 id 固定（SPEC §4）；自定义列名由 columns 映射兜底，状态描边色沿用 v1.3 徽标色语言
const STATUS_COLOR = { todo: '#8b93a3', doing: '#3b82f6', review: '#fbbf24', done: '#34d399' };
const STATUS_LABEL = { todo: '待分配', doing: '进行中', review: '待验证', done: '已完成' };

// 会话源（B5）：下拉枚举与展示名固定五源；state 为源原生状态原样展示（与活动流同口径），
// alive 判定只认 active（呼吸点/「只看活跃」过滤都用它）
const SRC_ORDER = ['zcode', 'claude', 'dsh', 'workbuddy', 'codex'];
const SRC_LABEL = { zcode: 'ZCode', claude: 'Claude', dsh: 'DSH', workbuddy: 'WorkBuddy', codex: 'Codex' };
const STATE_CLS = { active: 'b-alive', waiting: 'st-stale', completed: 'b-dead' };

let cont = null; // 面板宿主（overview.js 提供 .panelbox#ov-topo）
let onDataSessionClick = null; // 会话节点点击回调（overview.js 实现：按 ref 打开会话阅读器）
let data = { tasks: [], agents: [], members: [], columns: [] };
let activeOnly = false;
let collapsed = new Set(); // 树模式已折叠的任务 id（默认全展开）
let selected = null; // { kind:'task'|'session'|'artifact', id } —— 仅视觉高亮，不参与脏比较
let lastKey = null; // 上次渲染的规范化指纹（null=强制重绘）

// 会话源状态（B5）：sessions 为当前源 agent-sessions 条目；加载失败置 sessErr（空态 + 重试，不炸任务层）
let sessSrc = 'zcode';
let sessions = [];
let sessState = 'loading'; // 'loading' | 'ok' | 'error'
let sessErr = '';
let sessSeq = 0; // 切源竞态防护：过期响应直接丢弃

// ---- 工具 ----

// 按显示宽度截断：CJK 记 1、ASCII 记 0.6，maxUnits 为等效 CJK 字数
function truncW(s, maxUnits) {
  const str = String(s == null ? '' : s);
  let units = 0;
  for (let i = 0; i < str.length; i++) {
    units += str.charCodeAt(i) > 0x2e7f ? 1 : 0.6;
    if (units > maxUnits) return str.slice(0, i) + '…';
  }
  return str;
}

// base64url 解码（与 mock.js 同构；浏览器/Node 通用，零依赖）——仅用于连线对齐，不做安全校验
// （ref 校验闸门在后端 §3.3；这里解码失败一律视为「解不出任务 id」，不弹错）
function refSessionId(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  try {
    const json = decodeURIComponent(escape(atob(ref.replace(/-/g, '+').replace(/_/g, '/'))));
    const obj = JSON.parse(json);
    return (obj && typeof obj === 'object' && obj.v && typeof obj.v.id === 'string') ? obj.v.id : null;
  } catch { return null; }
}

const isAlive = (s) => String((s && s.state) || '') === 'active';
const sessTitle = (s) => (s && s.title) || '（未命名会话）';
const stateCls = (s) => STATE_CLS[String((s && s.state) || '')] || 'b-dead';
const stateText = (s) => String((s && s.state) || '') || (isAlive(s) ? '运行中' : '已退出');

// 会话 ↔ 任务连线键（B5）：优先条目显式 taskId（后端可回填），否则 ref 解出的会话 id 与任务 id 对齐；
// 两路都解不出/任务已不存在 → null（该会话落入「未关联任务的会话」区，不画边）
function sessTaskId(s, taskIds) {
  if (s && s.taskId && taskIds.has(s.taskId)) return s.taskId;
  const rid = refSessionId(s && s.ref);
  return (rid && taskIds.has(rid)) ? rid : null;
}

// 拉当前源会话列表（§3.1，limit 顶格 50）：loading → 成功/失败均强制重绘；
// seq 守卫切源竞态（慢的旧源响应不得覆盖新源数据）
async function loadSessions() {
  const seq = ++sessSeq;
  sessions = [];
  sessErr = '';
  sessState = 'loading';
  lastKey = null;
  draw();
  try {
    const r = await apiGet(`/api/agent-sessions?agent=${encodeURIComponent(sessSrc)}&limit=50`);
    if (!cont || seq !== sessSeq) return;
    sessions = Array.isArray(r && r.items) ? r.items : [];
    sessState = 'ok';
  } catch (e) {
    if (!cont || seq !== sessSeq) return;
    sessions = [];
    sessErr = (e && e.message) ? String(e.message) : String(e);
    sessState = 'error';
  }
  lastKey = null;
  draw();
}

const memName = (mmap, id) => {
  if (!id) return '';
  const m = mmap.get(id);
  return m ? m.name : String(id);
};

// 任务状态显示名：内置 id 用固定中文，自定义列查 columns（列可改名），都缺省回退原始 id
function statusText(cols, id) {
  const c = (cols || []).find((x) => x.id === id);
  return (c && c.name) || STATUS_LABEL[id] || String(id || '—');
}
const statusColor = (id) => STATUS_COLOR[id] || '#8b93a3';

// ---- v2.9.15 拓扑瘦身：commit 成果分组合并 ----
// 同任务同仓库的 commit 成果往往几十条几乎同形——合并成一行「commit ×N 仓库」
// （悬浮列组内最新提交说明）；PR/会话成果语义各异保持单节点。组序 = 首次出现序（新→旧）。

function groupArtifacts(arts) {
  const groups = [];
  const byRepo = new Map(); // repo → commit 组（同任务同仓归一组）
  for (const a of arts) {
    if (a && a.kind === 'commit') {
      const key = a.repo || '';
      let g = byRepo.get(key);
      if (!g) {
        g = { kind: 'commit', repo: a.repo || '', items: [] };
        byRepo.set(key, g);
        groups.push(g);
      }
      g.items.push(a);
    } else {
      groups.push({ kind: (a && a.kind) || 'commit', repo: (a && a.repo) || '', items: [a] });
    }
  }
  return groups;
}

// 组悬浮摘要：单条走原 artifactTip；多条列最新 8 条提交说明（v2.9.15 回填的 title）+ 溢出提示
function groupTip(g) {
  const items = Array.isArray(g.items) ? g.items : [];
  if (items.length <= 1) return artifactTip(items[0]);
  const lines = [
    `commit ×${items.length} · ${g.repo || '（未知仓库）'}`,
    '最近提交：',
    ...items.slice(0, 8).map((a) => `· ${truncW(String(a.title || a.ref || a.url || ''), 32)}（${fmtAgo(a.at)}）`),
    ...(items.length > 8 ? [`…其余 ${items.length - 8} 条`] : []),
    '',
    '完整列表见任务详情「成果」区'
  ];
  return lines.join('\n');
}

// ---- 视图模型：过滤 + 排序 ----

function model() {
  const mmap = new Map(data.members.filter((m) => m.kind === 'human').map((m) => [m.id, m]));
  const taskIds = new Set(data.tasks.map((t) => t.id));
  // 「只看活跃」：任务须有运行中（state=active）会话，且已退出会话一并隐藏；成果不属活跃语义，始终跟随任务展示
  const items = data.tasks.slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((t) => {
      let ss = sessions.filter((s) => sessTaskId(s, taskIds) === t.id);
      if (activeOnly) ss = ss.filter(isAlive);
      return { t, sessions: ss, artifacts: Array.isArray(t.artifacts) ? t.artifacts : [] };
    })
    .filter((it) => !activeOnly || it.sessions.length > 0);
  // 未关联任务的会话（B5）：当前源解不出任务 id 的条目，在面板底部独立区罗列（不画边、可点开阅读器）
  let unlinked = sessions.filter((s) => !sessTaskId(s, taskIds));
  if (activeOnly) unlinked = unlinked.filter(isAlive);
  return { mmap, items, unlinked };
}

// ---- 脏比较指纹（参照 board.js snapshotKey）：排序后 stringify，无变化跳过重绘 ----
// activeOnly/会话源与其加载态在指纹内（切换/过滤必须重绘）；selected/collapsed 是视觉态，不入指纹
function buildKey() {
  return JSON.stringify([
    data.tasks.map((t) => [t.id, t.title, t.status, t.updatedAt,
      (Array.isArray(t.artifacts) ? t.artifacts : []).map((a) => [a.url, a.kind, a.repo, a.ref, a.at, a.attributedBy, a.title || ''])]).sort(),
    sessions.map((s) => [s.id, s.ref, s.title, s.taskId || '', s.state || '', s.projectId || '', s.lastActiveAt || '']).sort(),
    data.agents.map((a) => [a.id, a.name]).sort(),
    data.members.map((m) => [m.id, m.name, m.kind]).sort(),
    data.columns.map((c) => [c.id, c.name]).sort(),
    activeOnly, sessSrc, sessState, sessErr
  ]);
}

// ---- 挂载：面板头（来源下拉 + 只看活跃）+ 面板体；返回 { update, destroy } ----

export function mount(host, opts = {}) {
  cont = host;
  onDataSessionClick = typeof opts.onSessionClick === 'function' ? opts.onSessionClick : null;
  const srcOpts = SRC_ORDER.map((id) =>
    `<option value="${id}"${id === sessSrc ? ' selected' : ''}>${SRC_LABEL[id] || id}</option>`).join('');
  cont.innerHTML = `
    <div class="topo-head">
      <h4 class="panel-title">
        <span>任务拓扑 <span class="muted small">（任务 → 智能体会话 → 成果 · 任务数据每 10s 刷新）</span></span>
      </h4>
      <span class="spacer"></span>
      <label class="topo-src" title="会话节点数据源：切换即拉取该智能体的本地会话列表（agent-sessions 端点）">
        会话源 <select id="topo-src" aria-label="会话来源">${srcOpts}</select>
      </label>
      <span class="muted small" id="topo-count"></span>
      <label class="topo-only-active" title="只显示有运行中会话的任务（已退出会话同时隐藏）">
        <input type="checkbox" id="topo-active-only"${activeOnly ? ' checked' : ''}>只看活跃
      </label>
    </div>
    <div class="topo-body" id="topo-body"><div class="loading">拓扑加载中…</div></div>`;

  cont.querySelector('#topo-active-only').addEventListener('change', (e) => {
    activeOnly = !!e.target.checked;
    lastKey = null;
    draw();
  });
  // 会话源切换（B5）：重拉该源会话列表再渲染（loadSessions 内部自带 loading/错误重绘）
  cont.querySelector('#topo-src').addEventListener('change', (e) => {
    const v = String(e.target.value || '');
    if (!v || v === sessSrc) return;
    sessSrc = v;
    selected = null; // 旧源选中引用随节点失效，一并复位
    loadSessions();
  });
  // 面板体点击委托（轮询只重绘 #topo-body，监听挂在面板上不丢失）
  cont.addEventListener('click', (e) => {
    const retry = e.target.closest('[data-act="topo-sess-retry"]');
    if (retry) { loadSessions(); return; }
    const twist = e.target.closest('[data-twist]');
    if (twist) {
      const id = twist.dataset.twist;
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      lastKey = null;
      draw();
      return;
    }
    if (e.target.closest('a')) return; // 成果原始链接放行（target=_blank），不触发选中
    const node = e.target.closest('[data-kind]');
    if (!node) { clearSelection(); return; } // 点空白取消高亮
    onNodeClick(node.dataset.kind, node.dataset.id, node.dataset.ref || '');
  });

  draw();
  loadSessions(); // 首挂拉默认源（zcode）会话列表，异步不阻塞任务层首绘
  return { update, destroy };
}

function update(d) {
  data = {
    tasks: (d && d.tasks) || [],
    agents: (d && d.agents) || [],
    members: (d && d.members) || [],
    columns: (d && d.columns) || []
  };
  if (!cont) return;
  draw();
}

function destroy() {
  cont = null;
  onDataSessionClick = null;
  data = { tasks: [], agents: [], members: [], columns: [] };
  selected = null;
  lastKey = null;
  collapsed.clear();
  activeOnly = false;
  sessSrc = 'zcode';
  sessions = [];
  sessState = 'loading';
  sessErr = '';
  sessSeq += 1; // 使在途响应过期
}

function draw() {
  if (!cont) return;
  const key = buildKey();
  if (key === lastKey) return; // 脏比较：无变化零重绘（10s tick 的空转成本≈一次 stringify）
  lastKey = key;
  selected = null; // 重绘后旧选中引用失效，一并复位
  const m = model();
  const body = cont.querySelector('#topo-body');
  if (!body) return;
  const nSess = m.items.reduce((n, it) => n + it.sessions.length, 0);
  const nArt = m.items.reduce((n, it) => n + it.artifacts.length, 0);
  const countEl = cont.querySelector('#topo-count');
  if (countEl) countEl.textContent = `${m.items.length} 任务 · ${nSess} 会话 · ${nArt} 成果 · 源 ${SRC_LABEL[sessSrc] || sessSrc}`;

  if (!data.tasks.length) {
    body.innerHTML = `<div class="empty-state">${icon('bot')}<span>暂无任务——先在看板创建任务，链路会出现在这里</span></div>`;
    return;
  }
  if (!m.items.length) {
    body.innerHTML = `<div class="empty-state">${icon('radio')}<span>没有运行中会话的任务——关闭「只看活跃」查看全部</span></div>`;
    return;
  }
  // 会话源状态条（B5）：加载中提示 / 失败空态（含重试）/ 未关联任务的会话独立区，恒位于任务层之下
  let strip = '';
  if (sessState === 'loading') {
    strip = `<div class="topo-note muted small">会话源 ${esc(SRC_LABEL[sessSrc] || sessSrc)} 加载中…</div>`;
  } else if (sessState === 'error') {
    strip = `<div class="empty-state topo-err">${icon('alert-triangle')}
      <span>会话源加载失败：${esc(sessErr)}<br>任务链路不受影响，可切换会话来源或稍后重试</span>
      <button type="button" class="btn ghost xs" data-act="topo-sess-retry">${icon('refresh-cw')}重试</button></div>`;
  } else if (m.unlinked.length) {
    strip = `<div class="topo-unlinked">
      <div class="topo-ul-h muted small" title="这些会话启动时未关联任务（taskId/ref 均解不出任务 id），不出现在连线中">
        ${icon('file-text')}未关联任务的会话（${m.unlinked.length}）
      </div>
      ${m.unlinked.map((s) => treeSessionHtml(s)).join('')}
    </div>`;
  }
  body.innerHTML = `<div class="topo-tree">${m.items.map((it) => treeTaskHtml(it, m)).join('')}</div>` + strip;
}

// ---- 行小字与悬浮提示 ----

function taskTip(t, mmap, cols) {
  const lines = [
    t.title,
    `状态：${statusText(cols, t.status)} · 任务 ${t.id}`,
    t.memberId ? `负责人：${memName(mmap, t.memberId)}` : '',
    t.acceptorId ? `验收人：${memName(mmap, t.acceptorId)}` : '',
    `创建 ${fmtFull(t.createdAt)} · 更新 ${fmtAgo(t.updatedAt)}`
  ];
  return lines.filter(Boolean).join('\n');
}

function sessionTip(s) {
  return [
    sessTitle(s),
    `${SRC_LABEL[sessSrc] || sessSrc} · 会话 ${s.id}`,
    s.state ? `状态：${stateText(s)}${isAlive(s) ? '（运行中）' : ''}` : '',
    s.projectId ? `项目：${s.projectId}` : '',
    `最近活动：${fmtFull(s.lastActiveAt)}（${fmtAgo(s.lastActiveAt)}）`,
    '点击查看会话全文（只读）'
  ].filter(Boolean).join('\n');
}

function artifactTip(a) {
  const head = a.kind === 'session'
    ? `会话成果 · ${sessTitle(a)}`
    : `${a.kind === 'pr' ? 'PR' : 'commit'}${a.repo ? ' · ' + a.repo : ''}${a.ref ? ' · ' + a.ref : ''}`;
  return [
    head,
    a.title || '',
    a.attributedBy === 'auto' ? '自动归因（AI 会话按分支约定提交）' : '',
    a.url || '',
    a.at ? `挂接：${fmtFull(a.at)}（${fmtAgo(a.at)}）` : ''
  ].filter(Boolean).join('\n');
}

// ---- 树（DOM 缩进行）----

function treeTaskHtml(it, m) {
  const t = it.t;
  const open = !collapsed.has(t.id);
  const nSess = it.sessions.length;
  const nArt = it.artifacts.length;
  // v2.9.15：成果按组渲染（commit 同仓 ×N 一行），悬浮看组内最新提交说明
  const artGroups = groupArtifacts(it.artifacts);
  const kids = open ? `
    <div class="topo-tkids">
      ${it.sessions.map((s) => treeSessionHtml(s)).join('')}
      ${artGroups.map((g, gi) => treeArtifactGroupHtml(g, t.id, gi)).join('')}
      ${(nSess + nArt) ? '' : '<div class="topo-trow none muted">无关联会话 / 成果</div>'}
    </div>` : '';
  return `
    <div class="topo-ttask" data-kind="task" data-id="${esc(t.id)}" title="${esc(taskTip(t, m.mmap, data.columns))}">
      <button type="button" class="twist${open ? ' open' : ''}" data-twist="${esc(t.id)}"
        aria-expanded="${open}" aria-label="${open ? '折叠' : '展开'} ${esc(t.title)}">${icon('chevron-down')}</button>
      <b class="tt">${esc(truncW(t.title, 30))}</b>
      <span class="badge topo-st" style="color:${statusColor(t.status)};background:transparent;border-color:${statusColor(t.status)}55">${esc(statusText(data.columns, t.status))}</span>
      ${t.memberId ? `<span class="muted small" title="负责人">${icon('user')}${esc(memName(m.mmap, t.memberId))}</span>` : ''}
      ${t.acceptorId ? `<span class="muted small" title="验收人">${icon('check')}${esc(memName(m.mmap, t.acceptorId))}</span>` : ''}
      <span class="spacer"></span>
      <span class="muted small">${nSess ? `会话 ${nSess}` : ''}${nSess && nArt ? ' · ' : ''}${nArt ? `成果 ${nArt}` : ''}${(nSess + nArt) ? '' : '单节点'}</span>
    </div>${kids}`;
}

// 会话行（树模式任务子行与「未关联任务的会话」区共用）：源原生状态徽标 + 标题 + id，点击开阅读器
function treeSessionHtml(s) {
  return `
      <div class="topo-trow" data-kind="session" data-id="${esc(s.id)}" data-ref="${esc(s.ref || '')}" title="${esc(sessionTip(s))}">
        <span class="badge ${isAlive(s) ? 'b-alive' : stateCls(s)}">${isAlive(s) ? '<span class="gwdot-pulse"></span>' : ''}${esc(stateText(s))}</span>
        <span class="agent-dot" style="background:${avatarColor(sessSrc)}"></span>
        <b>${esc(truncW(sessTitle(s), 24))}</b>
        <span class="mono muted">${esc(s.id)}</span>
        <span class="spacer"></span>
        <span class="muted small" title="${esc(fmtFull(s.lastActiveAt))}">${fmtAgo(s.lastActiveAt)}</span>
      </div>`;
}

// 成果组行：组内 >1（commit 同仓合并）→ ×N 计数 + 仓库 + 最新提交说明；单条退化为原单成果行
function treeArtifactGroupHtml(g, taskId, gi) {
  const items = Array.isArray(g.items) ? g.items : [];
  if (items.length <= 1) return treeArtifactHtml(items[0], taskId, gi);
  const a = items[0];
  const href = safeHttpUrl(a.url);
  return `
      <div class="topo-trow" data-kind="artifact" data-id="${esc(taskId)}:g:${gi}" title="${esc(groupTip(g))}">
        <span class="badge b-commit">commit</span>
        <span class="badge topo-xn" title="同仓库 commit 合并展示，悬浮看最近提交说明">×${items.length}</span>
        <b>${esc(truncW(g.repo || '', 22))}</b>
        <span class="muted">最新 ${esc(truncW(String(a.title || a.ref || a.url || ''), 24))}</span>
        <span class="spacer"></span>
        ${href ? `<a class="link" href="${esc(href)}" target="_blank" rel="noreferrer noopener" title="${esc(a.url)}">最新提交 ↗</a>` : ''}
        <span class="muted small" title="${esc(fmtFull(a.at))}">${fmtAgo(a.at)}</span>
      </div>`;
}

function treeArtifactHtml(a, taskId, idx) {
  const isSess = a.kind === 'session';
  const isPr = a.kind === 'pr';
  const href = isSess ? null : safeHttpUrl(a.url);
  const badge = isSess
    ? '<span class="badge b-upd" title="会话成果：智能体会话的只读快照引用（无外链）">会话</span>'
    : `<span class="badge ${isPr ? 'b-pr' : 'b-commit'}">${isPr ? 'PR' : 'commit'}</span>`;
  // session 成果无 url（D3）：主文案 = 会话标题（全文进悬浮），不渲染死链
  const main = isSess
    ? `<span class="art-url" title="会话：${esc(sessTitle(a))}（只读快照引用，无外链）">${esc(truncW(sessTitle(a), 26))}</span>`
    : (href
      ? `<a class="link art-url" href="${esc(href)}" target="_blank" rel="noreferrer noopener" title="${esc(a.url || '')}">${esc(truncW(`${a.repo ? a.repo + ' · ' : ''}${a.ref || a.url || ''}`, 26))}</a>`
      : `<span class="muted" title="非 http(s) 链接已拦截">${esc(truncW(a.url || '', 26))}</span>`);
  return `
      <div class="topo-trow" data-kind="artifact" data-id="${esc(taskId)}:${idx}" title="${esc(artifactTip(a))}">
        ${badge}
        ${a.attributedBy === 'auto' ? '<span class="badge b-auto" title="自动归因：AI 会话提交匹配分支约定">自动归因</span>' : ''}
        ${main}
        <span class="spacer"></span>
        <span class="muted small" title="${esc(fmtFull(a.at))}">${fmtAgo(a.at)}</span>
      </div>`;
}

// ---- 选中高亮：选中行保持原样，其余行降透明度（再点同行或空白取消）----

function onNodeClick(kind, id, ref) {
  // 会话节点附带动作：按 ref 打开会话阅读器（宿主经 onSessionClick 注入）。
  // v2.9.32 修复「阅读器打不开」：原实现把会话点击纳入选中切换语义——同一节点第二次点击
  // 被当作「取消选中」吞掉（wasOn → return），阅读器不再打开；用户视角=「同一个会话
  // 第二次点没反应」。会话节点改为每次点击都打开（高亮保持不切换），取消选中仅
  // 适用于任务/成果节点。
  if (kind === 'session') {
    selected = { kind, id };
    applySelection();
    if (onDataSessionClick && ref) onDataSessionClick(ref);
    return;
  }
  const wasOn = selected && selected.kind === kind && selected.id === id;
  if (wasOn) { clearSelection(); return; }
  selected = { kind, id };
  applySelection();
}

function applySelection() {
  if (!cont || !selected) return;
  const scope = cont.querySelector('.topo-tree');
  if (!scope) return;
  scope.classList.add('sel');
  // 选中行高亮覆盖任务层与「未关联任务的会话」区（后者跨在 .topo-tree 之外，单独扫）
  cont.querySelectorAll('[data-kind]').forEach((n) => {
    n.classList.toggle('on', n.dataset.kind === selected.kind && n.dataset.id === selected.id);
  });
}

function clearSelection() {
  selected = null;
  if (!cont) return;
  cont.querySelectorAll('.topo-tree.sel').forEach((el) => el.classList.remove('sel'));
  cont.querySelectorAll('[data-kind].on').forEach((el) => el.classList.remove('on'));
}
