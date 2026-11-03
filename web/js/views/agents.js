// 智能体页：智能体动态（跨源活动流 + 会话钻取）
// v2.3 智能体动态：跨源活动流（zcode/claude/dsh/workbuddy 本地会话库），来源健康徽标 + 手动刷新，
//   30s 轮询并入既有 10s tick 节流；项目目录 tab（#act-tabs）筛选；条目含项目/预览/状态
// v2.6 项目目录 tab：分段 tab（.seg/.seg-btn）按去重项目目录短名筛选，选择记忆 localStorage['fde-act-proj']
// v2.7 注册表退役：agents.json 注册表卡移除（桌面 agent 经 WorkBuddy/ZCode 桌面自助启动，指挥台仅观测）
// v2.8 会话钻取 + 双 UI 退役（SPEC-READER v2.3，业主确认动线）：
//   ① 钻取动线：活动条目点击 → 会话列表弹层（时间+标题+项目，「加载更多」键集游标分页）→
//      内容阅读器弹层（user/assistant/tool 按序只读渲染；D2 首批最新 100 条、IntersectionObserver
//      哨兵向上续染、已染节点保留、「回到底部」浮动按钮；workbuddy 恒降级提示 D4）；Esc 逐层回退，
//      阅读器「← 返回列表」只关栈顶，列表滚动位置与分页态保留（modalStack/ui.js 既有语义）
//   ② 挂接闭环（§5）：阅读器/列表行「挂到任务成果区」→ 任务下拉（复用归属任务交互范式）→
//      POST /api/tasks/:id/artifacts {kind:"session", sessionRef, title}（D3：不带 url，独立字段）
//      → toast「已挂到任务《X》」；同 task 同 sessionRef 去重提示
//   ③ 双 UI 退役（§6）：agents-grid 观测卡阵（含「最近工作」行）与会话登记表（10s tick/停止/日志弹层）
//      整体移除；本页仅剩 act-panel（唯一主面板）；GET /api/sessions 前端不再消费
// v2.3 收尾 B5（拓扑会话源）→ v2.9 迁出：任务拓扑面板整体迁往总览页（views/overview.js 承接，
//   mount({onSessionClick}) 仍复用本文件导出的 openSessionReader 直达阅读器）；本页不再挂载
//   拓扑、不再喂任务层数据（挂接弹层的任务下拉打开时现拉 /api/tasks，不依赖页面轮询）
import { apiGet, apiPost, apiPatch } from '../api.js';
import { state } from '../state.js';
import { esc, toast, openModal, confirmModal, icon, fmtAgo, fmtFull, startPolling } from '../ui.js';

let rootEl = null;
let tasks = []; // 挂接弹层任务下拉的兜底缓存（打开弹层时现拉 /api/tasks，此处仅兜失败重试）
let stopPoll = null;
let act = null; // 最近一次 /api/agent-activity 结果（{allOk, items, sources, checkedAt}）
let actSet = null; // /api/settings 的 agentActivity 节（各源开关，本期只读展示）

// 五源徽标文案兜底与配色类（zcode 蓝 / claude 橙 / dsh 绿 / workbuddy 粉 / codex 青，色值对齐 v1.3 徽标词表；
// 契约 agentName 缺失时回退，未知 agent 走中性兜底类）。列表/阅读器/挂接弹层共用
const ACT_AGENT_FALLBACK = { zcode: 'ZCode', claude: 'Claude', dsh: 'DSH', workbuddy: 'WorkBuddy', codex: 'Codex' };
const ACT_AGENT_CLS = { zcode: 'ag-zcode', claude: 'ag-claude', dsh: 'ag-dsh', workbuddy: 'ag-workbuddy', codex: 'ag-codex' };
// 会话原生状态 → 徽标档（原样展示不翻译，与活动流 act-state 同口径）
const SESSION_STATE_CLS = { active: 'b-alive', waiting: 'st-stale', completed: 'b-dead' };
// D2 长转录懒渲染：首批渲染「最新 100 条」并定位到底部，哨兵进视口向上续染 100 条，已染节点保留
const READER_BATCH = 100;

export async function render(el) {
  rootEl = el;
  el.innerHTML = `
    <div class="panelbox" id="act-panel">
      <h4 class="panel-title">
        <span>智能体动态 <span class="muted small">（各智能体本地会话库 · 点击条目查看会话 · 每 30s 自动刷新）</span></span>
        <span id="act-sources" class="act-sources"></span>
        <span class="spacer"></span>
        <button type="button" class="btn ghost small" id="btn-act-refresh">${icon('refresh-cw')}刷新</button>
      </h4>
      <div class="seg" id="act-tabs" role="tablist" aria-label="按项目目录筛选活动流" style="margin:0 14px 10px"></div>
      <div id="act-list"><div class="loading">加载中…</div></div>
    </div>`;

  el.querySelector('#btn-act-refresh').addEventListener('click', () => refreshActivity(true)); // 手动刷新绕过 30s 节流
  // 项目目录筛选 tab（v2.6）：委托挂在 #act-tabs 容器上（30s 重绘只换 innerHTML 不丢监听）；
  // 交互与记忆套路同成员页 #mem-tabs（fde-members-tab ↔ fde-act-proj）
  el.querySelector('#act-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b || b.getAttribute('data-tab') === actTab) return;
    actTab = b.getAttribute('data-tab');
    try { localStorage.setItem('fde-act-proj', actTab); } catch (e2) { /* localStorage 不可用则仅本页生效 */ }
    renderActivity(); // act 未就绪时内部自行 early-return，选中态待首拉渲染生效
  });
  // v2.9.31 D：「更多」下拉选项目
  el.querySelector('#act-tabs').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-more]');
    if (!sel || !sel.value || sel.value === actTab) return;
    actTab = sel.value;
    try { localStorage.setItem('fde-act-proj', actTab); } catch (e2) { /* 仅本页生效 */ }
    renderActivity();
  });
  // 钻取动线（§4）：活动条目点击 → 会话列表弹层。委托挂在 #act-list 上（30s 重绘不丢监听）。
  // v2.9.3：携带条目 projectId——弹层只出该项目的会话（修复跨项目串组）
  // v2.9.31：合并行/「更早」的折叠切换先行守卫（不触发钻取）；折叠内子条目点击=各自钻取
  el.querySelector('#act-list').addEventListener('click', (e) => {
    const tg = e.target.closest('.act-fold-toggle');
    if (tg) {
      const body = tg.nextElementSibling;
      if (body && body.classList.contains('act-fold-body')) {
        if (!tg.dataset.origLabel) tg.dataset.origLabel = tg.textContent;
        body.hidden = !body.hidden;
        tg.setAttribute('aria-expanded', String(!body.hidden));
        tg.textContent = body.hidden ? tg.dataset.origLabel : '收起';
      }
      return; // 折叠按钮点击绝不触发钻取
    }
    const item = e.target.closest('.act-item[data-agent]');
    if (item) openSessionListModal(item.getAttribute('data-agent'), item.getAttribute('data-project') || '');
  });

  await refreshAll();
  if (!rootEl) return;
  refreshActivity(true); // 首挂强制拉一次活动流（后续 30s 节流并入下方 tick；异步不阻塞轮询起跑）
  stopPoll = startPolling(tick, 10000);
}

export function destroy() {
  rootEl = null;
  if (stopPoll) { stopPoll(); stopPoll = null; }
}

async function refreshAll() {
  const root = rootEl;
  if (!root) return;
  try {
    // tasks 仅挂接弹层任务下拉用（打开时现拉，此处首挂预热兜底缓存）；失败 toast 提示
    // （活动流独立拉取自带空态兜底，不炸整页）
    tasks = (await apiGet('/api/tasks')) || [];
  } catch (e) {
    toast(e.message);
  }
}

// 10s tick：活动流 30s 节流刷新（v2.9 任务拓扑迁往总览页后，本页不再轮询任务数据——
// 原「任务/成果变化喂拓扑」职责随面板一并迁出）
async function tick() {
  refreshActivity(); // 内部按 actLastFetch 30s 节流，自带 catch
}

// ---- 智能体动态：跨源活动流（zcode/claude/dsh/workbuddy 本地会话库聚合，只读监控）----
// 轮询策略：30s 自动刷新不另起定时器，并入既有 10s tick 按 actLastFetch 节流（tick 每 3 跳实拉一次）；
// 手动刷新按钮与首挂渲染 force 绕过节流。actLastFetch 不随视图销毁复位：快速切回复用缓存，首挂 force 兜底
let actLastFetch = 0;
// v2.6 项目目录筛选 tab（键=归一化 projectId，'all'=全部）：模块级记忆 + localStorage 持久化
// （键名 fde-act-proj，与成员页 fde-members-tab 同套路），30s 重绘与快速切换都不丢选中态；
// 存储键失效由 renderActivity 的 effTab 兜底回退「全部」，不动存储值
let actTab = 'all';
try { if (localStorage.getItem('fde-act-proj')) actTab = localStorage.getItem('fde-act-proj'); } catch (e) { /* localStorage 不可用则用默认 */ }

// projectId 归一化分组键：去尾分隔符 + 分隔符统一（WorkBuddy 实测存 D:/xxx 正斜杠，与其余源的反斜杠同盘同目录）
// + 小写（Windows 盘符/目录大小写差异归同组）；空串=未知项目组。展示路径仍用首见原始写法
const actGroupKey = (p) =>
  String(p || '').trim().replace(/[\\/]+$/, '').toLowerCase().replace(/[\\/]+/g, '\\');

async function refreshActivity(force = false) {
  const root = rootEl;
  if (!root) return;
  if (!force && Date.now() - actLastFetch < 30000) return; // 30s 节流：见节首注释
  actLastFetch = Date.now();
  const listEl = root.querySelector('#act-list');
  if (!listEl) return;
  try {
    // settings.agentActivity 节（各源开关）本期只读展示：读取失败不阻断活动流
    const [data, set] = await Promise.all([
      apiGet('/api/agent-activity'),
      apiGet('/api/settings').then((s) => (s && s.agentActivity) || null).catch(() => null)
    ]);
    if (!rootEl || !listEl.isConnected) return;
    act = data || { allOk: false, items: [], sources: [], checkedAt: null };
    actSet = set;
    renderActivity();
  } catch (e) {
    // 后端未就绪/不可达：面板内静默降级提示（不 toast 轰炸）
    act = null;
    if (rootEl && listEl.isConnected) {
      listEl.innerHTML = `<div class="empty-state">${icon('radio')}<span>智能体动态暂不可用：${esc(e.message)}</span></div>`;
    }
  }
}

function renderActivity() {
  const root = rootEl;
  if (!root || !act) return;
  const listEl = root.querySelector('#act-list');
  const srcEl = root.querySelector('#act-sources');
  if (!listEl || !srcEl) return;

  // 面板头来源健康徽标：N/N 源正常（全正常绿 / 有失败黄），title 逐源列 detail（失败详情）+ 扫描时间
  const sources = act.sources || [];
  const okCnt = sources.filter((s) => s.ok).length;
  const allOk = sources.length > 0 && okCnt === sources.length;
  const healthTitle = (sources.length ? sources.map((s) => `${s.id}：${s.ok ? '正常' : (s.detail || '失败')}`).join('\n') : '未返回来源健康信息')
    + (act.checkedAt ? `\n最近扫描：${fmtFull(act.checkedAt)}` : '');
  let srcHtml = `<span class="badge ${allOk ? 'b-alive' : 'st-stale'}" title="${esc(healthTitle)}">${okCnt}/${sources.length} 源正常</span>`;
  // 设置里已关闭的源（本期只读展示，指引去设置页）
  const offSrcs = actSet && actSet.sources
    ? Object.keys(actSet.sources).filter((k) => actSet.sources[k] && actSet.sources[k].enabled === false) : [];
  if (offSrcs.length) srcHtml += ` <span class="muted small" title="本期只读，可在设置页开启">已关闭：${esc(offSrcs.join('、'))}</span>`;
  srcEl.innerHTML = srcHtml;

  const items = (act.items || []).slice()
    .sort((a, b) => Date.parse(b.lastActiveAt || 0) - Date.parse(a.lastActiveAt || 0));

  // v2.6 项目目录 tab：projectId（工作目录）经 actGroupKey 归一化聚拢去重；tab 标签=目录短名
  // （projectId 末段，未知目录归「未知项目」）；tab 顺序按组内最新活动倒序，「全部」恒在首位
  const groups = new Map(); // 归一键 → { key, disp, short, items }
  for (const it of items) {
    const key = actGroupKey(it.projectId);
    if (!groups.has(key)) {
      const disp = String(it.projectId || '').trim();
      groups.set(key, {
        key,
        disp,
        short: disp ? (disp.split(/[\\/]+/).filter(Boolean).pop() || disp) : '未知项目',
        items: []
      });
    }
    groups.get(key).items.push(it);
  }
  const glist = [...groups.values()];
  glist.sort((a, b) => Date.parse(b.items[0].lastActiveAt || 0) - Date.parse(a.items[0].lastActiveAt || 0));

  // 记忆的 tab 失效（该目录在最新数据里已无活动）→ 本轮显示回退「全部」，不动存储值
  // （目录重新出现活动即自动恢复选中）；tab 高亮始终跟随 effTab
  const effTab = actTab !== 'all' && groups.has(actTab) ? actTab : 'all';
  // v2.9.31 D：项目 tab 收敛——只出最近 6 个，其余进「更多」下拉；未知项目组灰色降权
  const MAX_VISIBLE_TABS = 6;
  const visibleGroups = glist.slice(0, MAX_VISIBLE_TABS);
  const moreGroups = glist.slice(MAX_VISIBLE_TABS);
  const moreHasSel = moreGroups.some((g) => g.key === effTab);
  const tabsEl = root.querySelector('#act-tabs');
  if (tabsEl) {
    const tabBtn = (t, label, n, on, extraCls) =>
      `<button type="button" class="seg-btn${extraCls || ''}${on ? ' on' : ''}" data-tab="${esc(t)}" role="tab"` +
      ` aria-selected="${on}">${esc(label)} <span class="n" style="opacity:.65;margin-left:2px">${n}</span></button>`;
    tabsEl.innerHTML = tabBtn('all', '全部', items.length, effTab === 'all') +
      visibleGroups.map((g) => tabBtn(g.key, g.short, g.items.length, effTab === g.key, g.disp ? '' : ' seg-unknown')).join('') +
      (moreGroups.length
        ? `<select class="seg-select" aria-label="更多项目" data-more>${moreGroups
            .map((g) => `<option value="${esc(g.key)}"${g.key === effTab ? ' selected' : ''}>${esc(g.short)} (${g.items.length})</option>`)
            .join('')}${moreHasSel ? '' : `<option value="" hidden selected>更多 (${moreGroups.length})</option>`}</select>`
        : '');
  }

  // 空态 / 全失败态：同一引导文案（来源失败详情已在面板头徽标 title 交代）
  if (!items.length) {
    listEl.innerHTML = `<div class="empty-state">${icon('bot')}<span>各智能体的本地会话库暂无活动</span></div>`;
    return;
  }

  // v2.9.31 A/B/C 重构：运行中区块 + 保守合并 + 天分桶 + 状态中文化（数据接口零改动）
  const shown = effTab === 'all' ? items : groups.get(effTab).items;

  // C：来源状态 → 中文徽标（原值进 title；未带状态不渲染——运行中的由运行区块表达）
  const STATE_VIEW = {
    active: { label: '运行中', cls: 'st-run' },
    completed: { label: '已完成', cls: 'st-done' },
    failed: { label: '失败', cls: 'st-fail' },
    error: { label: '失败', cls: 'st-fail' },
    idle: { label: '空闲', cls: 'st-idle' },
    cancelled: { label: '已取消', cls: 'st-idle' },
    canceled: { label: '已取消', cls: 'st-idle' },
  };
  const stateBadge = (it) => {
    const v = STATE_VIEW[String(it.state || '').toLowerCase()];
    return v ? `<span class="badge ${v.cls}" title="来源状态：${esc(it.state)}">${v.label}</span>` : '';
  };
  // alive 口径与成员页一致（state==='active' = 10min 窗口内）
  const isRunning = (it) => String(it.state || '').toLowerCase() === 'active';
  const running = shown.filter(isRunning);
  const rest = shown.filter((it) => !isRunning(it));

  // B：保守合并——同 agent + 同项目 + 标题前 20 字符（规范化空白）一致 → 一行 ×N（巡检类定时会话治理）
  const projectShort = (pid) => (pid ? String(pid).split(/[\\/]+/).filter(Boolean).pop() || '' : '未知项目');
  function mergeKeyOf(it) {
    return `${it.agent}|${actGroupKey(it.projectId)}|${String(it.title || '').replace(/\s+/g, ' ').trim().slice(0, 20)}`;
  }
  const mergeMap = new Map();
  for (const it of rest) {
    const k = mergeKeyOf(it);
    if (!mergeMap.has(k)) mergeMap.set(k, []);
    mergeMap.get(k).push(it); // items 已倒序，[0]=最新
  }
  const mergedRows = [...mergeMap.values()].map((arr) => ({ head: arr[0], items: arr }));

  // A：天分桶（按合并后代表条目的最近活跃时间）
  const DAY_MS = 24 * 3600 * 1000;
  const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today0 = startOfDay(Date.now());
  const buckets = [
    { label: '今天', rows: [] },
    { label: '昨天', rows: [] },
    { label: '更早', rows: [], fold: true },
  ];
  for (const row of mergedRows) {
    const ts = Date.parse(row.head.lastActiveAt || 0);
    const d0 = Number.isFinite(ts) ? startOfDay(ts) : 0;
    if (d0 === today0) buckets[0].rows.push(row);
    else if (d0 === today0 - DAY_MS) buckets[1].rows.push(row);
    else buckets[2].rows.push(row);
  }

  function rowHtml(it, extraTitle) {
    const cls = ACT_AGENT_CLS[it.agent] || 'ag-zcode';
    const name = it.agentName || ACT_AGENT_FALLBACK[it.agent] || it.agent;
    const hover = extraTitle || it.preview || it.title || '';
    return `
      <div class="act-item" data-agent="${esc(it.agent)}" data-project="${esc(it.projectId || '')}" role="button" tabindex="0" aria-label="查看 ${esc(name)} 在 ${esc(projectShort(it.projectId))} 的会话列表">
        <span class="badge act-agent ${cls}">${esc(name)}</span>
        <div class="act-body">
          <div class="act-h">
            <span class="act-proj-chip" title="${esc(it.projectId || '未知项目')}">${esc(projectShort(it.projectId))}</span>
            <b class="act-title" title="${esc(hover)}">${esc(it.title)}</b>
            ${stateBadge(it)}
            <span class="muted small act-ago" title="${esc(fmtFull(it.lastActiveAt))}">${esc(fmtAgo(it.lastActiveAt))}</span>
          </div>
        </div>
        <span class="act-go">${icon('file-text')}查看会话</span>
      </div>`;
  }

  function mergedRowHtml(row) {
    if (row.items.length < 2) return rowHtml(row.head);
    const head = row.head;
    const cls = ACT_AGENT_CLS[head.agent] || 'ag-zcode';
    const name = head.agentName || ACT_AGENT_FALLBACK[head.agent] || head.agent;
    const sub = row.items.map((it) => `<div class="act-sub">${rowHtml(it)}</div>`).join('');
    return `
      <div class="act-item" data-agent="${esc(head.agent)}" data-project="${esc(head.projectId || '')}" role="button" tabindex="0" aria-label="查看 ${esc(name)} 在 ${esc(projectShort(head.projectId))} 的会话列表（${row.items.length} 条同类）">
        <span class="badge act-agent ${cls}">${esc(name)}</span>
        <div class="act-body">
          <div class="act-h">
            <span class="act-proj-chip" title="${esc(head.projectId || '未知项目')}">${esc(projectShort(head.projectId))}</span>
            <b class="act-title" title="${esc(head.preview || head.title)}">${esc(head.title)}</b>
            ${stateBadge(head)}
            <span class="badge b-ro act-merge-n" title="同类会话已合并（同 agent 同项目同标题前缀），点「展开」看逐条">×${row.items.length}</span>
            <span class="muted small act-ago" title="${esc(fmtFull(head.lastActiveAt))}">${esc(fmtAgo(head.lastActiveAt))}</span>
          </div>
          <button type="button" class="act-fold-toggle" aria-expanded="false">展开其余 ${row.items.length - 1} 条</button>
          <div class="act-fold-body" hidden>${sub}</div>
        </div>
        <span class="act-go">${icon('file-text')}查看会话</span>
      </div>`;
  }

  const runningHtml = running.length
    ? `<div class="act-running"><div class="act-day-h"><span class="pulse-dot"></span>正在运行 · ${running.length}</div>${running.map((it) => rowHtml(it)).join('')}</div>`
    : '';
  const bucketHtml = buckets.map((b) => {
    if (!b.rows.length) return '';
    const rowsHtml = b.rows.map((row) => mergedRowHtml(row)).join('');
    if (!b.fold) return `<div class="act-day"><div class="act-day-h">${b.label} · ${b.rows.length}</div>${rowsHtml}</div>`;
    return `<div class="act-day"><div class="act-day-h">更早 · ${b.rows.length}</div>
      <button type="button" class="act-fold-toggle act-day-toggle" aria-expanded="false">展开更早 ${b.rows.length} 条</button>
      <div class="act-fold-body" hidden>${rowsHtml}</div></div>`;
  }).join('');

  listEl.innerHTML = runningHtml + (bucketHtml || `<div class="empty-state">${icon('bot')}<span>无历史会话</span></div>`);
}

// ---- 会话列表弹层（§3.1/§4）：该 agent 的会话，lastActiveAt 倒序，「加载更多」键集游标分页 ----
// 弹层不因打开阅读器而销毁：阅读器叠加在其上（modalStack），返回/逐层关后滚动位置与分页态天然保留
// v2.9.3：从项目分组条目钻取时按 projectId 过滤（修复跨项目串组），「全部项目」键可切全量
async function openSessionListModal(agentId, projectId) {
  const agentName = ACT_AGENT_FALLBACK[agentId] || agentId || '未知来源';
  const cls = ACT_AGENT_CLS[agentId] || 'ag-zcode';
  let scopeProject = projectId || null; // null=全量；字符串=按项目过滤（后端归一化比较，含空串=未知项目组）
  const scopeShort = scopeProject
    ? String(scopeProject).trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || ''
    : '';
  let items = []; // 已载入条目（跨页累计）
  let nextCursor = null;
  let firstPage = true;
  let loading = false;

  const box = document.createElement('div');
  box.innerHTML = `
    <div id="sl-bind" class="sl-bind"></div>
    <div class="slist" id="sl-rows"><div class="loading">加载中…</div></div>
    <div class="modal-actions">
      <span class="muted small" id="sl-count"></span>
      <span class="spacer"></span>
      ${scopeProject ? `<button type="button" class="btn ghost small" id="sl-scope">${icon('folder')}全部项目</button>` : ''}
      <button type="button" class="btn ghost small" id="sl-more" hidden>${icon('chevron-down')}加载更多</button>
    </div>`;
  const modalHandle = openModal({ title: `会话列表 · ${agentName}${scopeShort ? ` · ${scopeShort}` : ''}`, body: box, wide: true });
  const rowsEl = box.querySelector('#sl-rows');
  const countEl = box.querySelector('#sl-count');
  const moreBtn = box.querySelector('#sl-more');
  const scopeBtn = box.querySelector('#sl-scope');
  let drawnCount = 0; // 已渲染行数：append 只补新页（整表重插会让已渲染行翻倍）
  // v2.9.33 C 方案：绑定作用域内行按钮 = 「设为证据」一键挂绑定任务（目标无歧义免弹层）；
  // 未绑定作用域保留「挂接」弹层（需选任务）。boundTask 由 renderBindArea 维护
  let boundTask = null;

  function rowHtml(s) {
    const stCls = SESSION_STATE_CLS[s.state] || 'b-dead';
    let action;
    if (boundTask) {
      const attached = (boundTask.artifacts || []).some((x) => x && x.kind === 'session' && x.sessionRef === s.ref);
      action = attached
        ? `<span class="badge b-ro sr-attached" title="已是《${esc(boundTask.title)}》的验收证据">已挂 ✓</span>`
        : `<button type="button" class="btn ghost xs sr-evidence" data-ref="${esc(s.ref)}" title="一键挂为《${esc(boundTask.title)}》的验收证据">${icon('link')}设为证据</button>`;
    } else {
      action = `<button type="button" class="btn ghost xs sr-attach" data-ref="${esc(s.ref)}" title="把该会话挂到任务成果区（选择任务）">${icon('link')}挂接</button>`;
    }
    return `
      <div class="slist-row" data-ref="${esc(s.ref)}">
        <span class="badge act-agent ${cls}">${esc(agentName)}</span>
        <div class="sr-body">
          <div class="sr-t" title="${esc(s.title || '')}">${esc(s.title || '（未命名会话）')}</div>
          ${s.projectId ? `<div class="sr-p mono" title="${esc(s.projectId)}">${esc(s.projectId)}</div>` : '<div class="sr-p muted">未知项目</div>'}
        </div>
        ${s.state ? `<span class="badge ${stCls}" title="来源原生状态（原样展示不翻译）">${esc(s.state)}</span>` : ''}
        <span class="sr-ago muted small" title="${esc(fmtFull(s.lastActiveAt))}">${esc(fmtAgo(s.lastActiveAt))}</span>
        ${action}
      </div>`;
  }

  function draw() {
    const fresh = items.slice(drawnCount);
    const rows = fresh.map(rowHtml).join('');
    if (drawnCount === 0) rowsEl.innerHTML = rows || `<div class="empty-state">${icon('file-text')}<span>该智能体暂无会话记录</span></div>`;
    else rowsEl.insertAdjacentHTML('beforeend', rows);
    drawnCount = items.length;
    countEl.textContent = `已载入 ${items.length} 条${scopeProject ? ' · 仅本项目' : ''}${nextCursor ? ' · 还有更早会话' : ''}`;
    moreBtn.hidden = !nextCursor;
    refreshAttachAllBtn(); // 加载更多后批量按钮计数跟随（0 条隐藏）
  }

  async function loadPage() {
    if (loading) return;
    loading = true;
    moreBtn.disabled = true;
    try {
      const q = new URLSearchParams({ agent: agentId, limit: '20' });
      if (nextCursor) q.set('cursor', nextCursor);
      if (scopeProject) q.set('project', scopeProject);
      const r = await apiGet('/api/agent-sessions?' + q.toString());
      if (!box.isConnected) return;
      items = items.concat(r.items || []);
      nextCursor = r.nextCursor || null;
      draw();
      firstPage = false;
    } catch (e) {
      if (firstPage) rowsEl.innerHTML = `<div class="form-err show">${esc(`${e.code || 'ERROR'}: ${e.message}`)}</div>`;
      else toast(e.message);
    }
    loading = false;
    moreBtn.disabled = false;
  }

  // 「全部项目」切换：重置分页态并按新范围重拉（仅本项目 ↔ 全量来回切）
  if (scopeBtn) {
    scopeBtn.addEventListener('click', () => {
      scopeProject = scopeProject ? null : (projectId || '');
      scopeBtn.innerHTML = scopeProject ? `${icon('folder')}全部项目` : `${icon('folder')}仅本项目`;
      items = [];
      nextCursor = null;
      drawnCount = 0;
      firstPage = true;
      rowsEl.innerHTML = '<div class="loading">加载中…</div>';
      loadPage();
      renderBindArea(); // 全量态不显示绑定条（绑定是项目粒度概念）
    });
  }

  // ---- v2.9.4 项目级绑定（ambient 关联，不产生 artifacts）：本项目 ↔ 任务的归属显示与改绑 ----
  async function renderBindArea() {
    const el = box.querySelector('#sl-bind');
    if (!el) return;
    if (!scopeProject) { el.innerHTML = ''; boundTask = null; rerenderRows(); return; }
    let snap = tasks;
    try { snap = (await apiGet('/api/tasks')) || tasks; tasks = snap; } catch { /* 缓存兜底 */ }
    if (!el.isConnected) return;
    boundTask = (snap || []).find((t) => t.projectDir && actGroupKey(t.projectDir) === actGroupKey(scopeProject)) || null;
    if (!boundTask) {
      el.innerHTML = `<div class="sl-bind-row">
        <span class="muted small">${icon('folder')} 本项目尚未绑定任务</span>
        <span class="spacer"></span>
        <button type="button" class="btn ghost xs" data-act="bind-new" title="把该项目整体关联到一个任务（不逐条挂会话）">${icon('link')}绑定到任务…</button>
      </div>`;
      el.querySelector('[data-act=bind-new]').addEventListener('click', () => openProjectBind(scopeProject, renderBindArea));
      rerenderRows();
      return;
    }
    el.innerHTML = `<div class="sl-bind-row bound">
      ${icon('folder')}<span>本项目已绑定任务</span><b class="sl-bind-task" title="${esc(boundTask.title)}">${esc(boundTask.title)}</b>
      <span class="muted small">会话自动归属本任务 · 行内「设为证据」一键挂为验收证据</span>
      <span class="spacer"></span>
      ${icon('link')}<button type="button" class="btn ghost xs" data-act="bind-attach-all" hidden title="把本列表未挂的会话一次性全部挂为该任务的验收证据">全部设为证据</button>
      <button type="button" class="btn ghost xs" data-act="bind-open">查看任务</button>
      <button type="button" class="btn ghost xs" data-act="bind-unbind" title="解除项目与任务的绑定（已挂接的会话成果不受影响）">解绑</button>
    </div>`;
    el.querySelector('[data-act=bind-open]').addEventListener('click', () => {
      modalHandle.close();
      state.pendingTaskFocus = boundTask.id;
      if (location.hash !== '#/board') location.hash = '#/board';
    });
    el.querySelector('[data-act=bind-unbind]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await apiPatch(`/api/tasks/${encodeURIComponent(boundTask.id)}`, { projectDir: null });
        toast(`已解绑项目与任务《${boundTask.title}》`, 'success');
        renderBindArea();
      } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
    });
    const allBtn = el.querySelector('[data-act=bind-attach-all]');
    if (allBtn) allBtn.addEventListener('click', attachAllEvidence);
    refreshAttachAllBtn(); // 关键：横幅渲染常早于会话列表加载（items 尚空）——按钮恒渲染、由本函数驱动可见性与计数
    rerenderRows(); // 绑定态影响行按钮形态（设为证据 vs 弹层挂接）——行已渲染时整表重放
  }
  renderBindArea();

  /** 绑定态变化后整表重放（drawnCount 归零重 draw；append 语义不变） */
  function rerenderRows() {
    if (drawnCount === 0) return;
    rowsEl.innerHTML = '';
    drawnCount = 0;
    draw();
  }

  // ---- v2.9.33 批量挂接：绑定作用域内未挂会话一键全部挂为验收证据 ----
  const attachedRefs = () => new Set(
    ((boundTask && boundTask.artifacts) || [])
      .filter((x) => x && x.kind === 'session' && x.sessionRef)
      .map((x) => x.sessionRef)
  );
  function pendingEvidenceCount() {
    if (!boundTask) return 0;
    const set = attachedRefs();
    return items.filter((s) => s.ref && !set.has(s.ref)).length;
  }
  function refreshAttachAllBtn() {
    const btn = box.querySelector('[data-act=bind-attach-all]');
    if (!btn || btn.disabled) return;
    const n = pendingEvidenceCount();
    btn.hidden = n === 0;
    btn.textContent = `全部设为证据（${n}）`;
  }

  /** 批量挂接：串行 POST（服务端 tasks.json 是读-改-写，并发会丢更新）；单个失败计数不中断 */
  async function attachAllEvidence() {
    if (!boundTask) return;
    const set = attachedRefs();
    const targets = items.filter((s) => s.ref && !set.has(s.ref));
    if (!targets.length) return;
    const ok = await confirmModal(
      `将把本列表 ${targets.length} 条未挂会话一次性挂为《${boundTask.title}》的验收证据。`,
      { title: '全部设为证据？', okText: '全部挂接' }
    );
    if (!ok) return;
    const btn = box.querySelector('[data-act=bind-attach-all]');
    if (btn) btn.disabled = true;
    let done = 0;
    let fail = 0;
    for (const s of targets) {
      if (btn) btn.textContent = `${icon('link')}挂接中 ${done + 1}/${targets.length}`;
      try {
        await apiPost(`/api/tasks/${encodeURIComponent(boundTask.id)}/artifacts`, {
          kind: 'session',
          sessionRef: s.ref,
          title: String(s.title || '（未命名会话）').slice(0, 200),
        });
        boundTask.artifacts = [...(boundTask.artifacts || []), { kind: 'session', sessionRef: s.ref }];
        done += 1;
      } catch (err) {
        fail += 1;
        console.error('[attach-all] 单条失败:', err.message);
      }
    }
    toast(fail ? `批量挂接完成：${done} 成功 / ${fail} 失败` : `已全部挂接（${done} 条）`, fail ? 'error' : 'success');
    renderBindArea(); // 计数归零后按钮消失
    rerenderRows();   // 全部行变「已挂 ✓」
  }

  moreBtn.addEventListener('click', loadPage);
  rowsEl.addEventListener('click', (e) => {
    const at = e.target.closest('.sr-attach');
    if (at) {
      const s = items.find((x) => x.ref === at.getAttribute('data-ref'));
      if (s) openSessionAttach(s.ref, s.title || '（未命名会话）', agentId);
      return;
    }
    // v2.9.33 C：绑定作用域一键「设为证据」——直接挂到绑定任务（无弹层），幂等由后端去重保证
    const evBtn = e.target.closest('.sr-evidence');
    if (evBtn) {
      const s = items.find((x) => x.ref === evBtn.getAttribute('data-ref'));
      if (!s || !boundTask) return;
      const ref = s.ref;
      evBtn.disabled = true;
      (async () => {
        try {
          await apiPost(`/api/tasks/${encodeURIComponent(boundTask.id)}/artifacts`, {
            kind: 'session',
            sessionRef: ref,
            title: String(s.title || '（未命名会话）').slice(0, 200),
          });
          boundTask.artifacts = [...(boundTask.artifacts || []), { kind: 'session', sessionRef: ref }];
          toast(`已挂为《${boundTask.title}》的验收证据`, 'success');
        } catch (err) {
          toast(err.message);
        } finally {
          rerenderRows(); // 成功=变「已挂 ✓」；失败=恢复按钮
        }
      })();
      return;
    }
    const row = e.target.closest('.slist-row');
    if (row) openSessionReader(row.getAttribute('data-ref'), { fromList: true });
  });
  loadPage();
}

// ---- 内容阅读器弹层（§3.2/§4/D2）：会话全文按 seq 升序只读渲染 ----
// 三分视觉：用户提示=左 accent 竖条+「用户」标浅底块；助手回复=「助手」标常规底块；
// 工具调用=灰底 mono 折叠块（折叠态=工具名+状态徽标，点击展开全文），与对话流显著区分。
// D2 懒渲染：首批渲染「最新 100 条」并定位到底部，顶部哨兵进视口向上续染 100 条（已染节点保留），
// 插入后按高度差补偿 scrollTop（视觉锚定不跳屏）；「回到底部」浮动按钮随滚动位置出现。
// workbuddy 等无转录源（D4）：degraded 提示「该源暂不支持全文阅读」，挂接入口保留。
// 导出复用（B5/D5 起）：会话节点直达阅读器——v2.9 拓扑迁总览页后由 overview.js 经
// mount({onSessionClick}) 继续复用本函数；本页活动流钻取动线不变
export async function openSessionReader(ref, opts = {}) {
  const box = document.createElement('div');
  box.innerHTML = '<div class="loading">加载中…</div>';
  const m = openModal({ title: '会话阅读器', body: box, wide: true, cls: 'modal-reader' });
  let data = null;
  try {
    data = await apiGet('/api/agent-session?ref=' + encodeURIComponent(ref));
  } catch (e) {
    if (box.isConnected) box.innerHTML = `<div class="form-err show">${esc(`${e.code || 'ERROR'}: ${e.message}`)}</div>`;
    return m;
  }
  if (!box.isConnected) return m; // 加载期间弹层已被关闭：丢弃渲染
  const agentName = ACT_AGENT_FALLBACK[data.agent] || data.agent || '未知来源';
  const cls = ACT_AGENT_CLS[data.agent] || 'ag-zcode';
  const totalStr = data.total != null ? String(data.total) : '';

  // 头部元信息（§4）：来源徽标 + 标题 + 项目 + 起止 + 条数
  const metaHtml = `
    <div class="rd-meta">
      <div class="rd-meta-h">
        <span class="badge act-agent ${cls}">${esc(agentName)}</span>
        ${data.degraded ? '<span class="badge st-stale" title="该源暂不支持全文阅读">全文不可读</span>' : ''}
        <b class="rd-title" title="${esc(data.title || '')}">${esc(data.title || '（未命名会话）')}</b>
      </div>
      <div class="rd-meta-s muted small">
        ${data.projectId ? `<span class="mono" title="${esc(data.projectId)}">${esc(data.projectId)}</span>` : '<span>未知项目</span>'}
        <span title="起止：${esc(fmtFull(data.startedAt))} → ${esc(fmtFull(data.lastActiveAt))}">${esc(fmtFull(data.startedAt))} → ${esc(fmtAgo(data.lastActiveAt))}</span>
        <span id="rd-count">${data.degraded ? '' : `共 ${esc(totalStr)} 条`}</span>
      </div>
    </div>`;

  // 底部操作：返回列表（仅列表叠开时出现）+ 挂到任务成果区（降级态同样可用，§5）
  const footerHtml = `
    <div class="modal-actions rd-actions">
      ${opts.fromList ? '<button type="button" class="btn ghost" data-act="back">← 返回列表</button>' : ''}
      <span class="muted small">只读快照 · 不可编辑</span>
      <span class="spacer"></span>
      <button type="button" class="btn" data-act="attach">${icon('link')}挂到任务成果区</button>
    </div>`;
  const wireFooter = () => {
    const back = box.querySelector('[data-act=back]');
    if (back) back.addEventListener('click', () => m.close());
    box.querySelector('[data-act=attach]').addEventListener('click', () =>
      openSessionAttach(ref, data.title || '（未命名会话）', data.agent));
  };

  if (data.degraded) {
    box.innerHTML = `${metaHtml}
      <div class="empty-state rd-degraded">${icon('alert-triangle')}<span>该源暂不支持全文阅读（${esc(data.reason || 'SOURCE_NO_TRANSCRIPT')}）</span><span class="muted">会话列表与「挂到任务成果区」不受影响</span></div>
      ${footerHtml}`;
    wireFooter();
    return m;
  }

  const msgs = Array.isArray(data.messages) ? data.messages : [];
  box.innerHTML = `${metaHtml}
    ${data.truncated ? `<div class="rd-trunc">${icon('alert-triangle')}<span>仅载入前 ${esc(String(msgs.length))} / 共 ${esc(totalStr)} 条（服务端截断）</span></div>` : ''}
    <div class="rd-body">
      <div class="rd-scroll" id="rd-scroll">
        <div class="rd-sentinel" id="rd-sentinel"><span class="muted small" id="rd-early-hint"></span></div>
        <div class="rd-feed" id="rd-feed"></div>
      </div>
      <button type="button" class="btn rd-gobottom" id="rd-gobottom" hidden title="回到底部（最新消息）">${icon('chevron-down')}底部</button>
    </div>
    ${footerHtml}`;
  wireFooter();

  const scrollEl = box.querySelector('#rd-scroll');
  const feedEl = box.querySelector('#rd-feed');
  const sentinel = box.querySelector('#rd-sentinel');
  const goBtn = box.querySelector('#rd-gobottom');
  const countEl = box.querySelector('#rd-count');
  const earlyHint = box.querySelector('#rd-early-hint');

  function msgHtml(msg) {
    const ts = `<span class="rd-ts" title="${esc(fmtFull(msg.ts))}">#${esc(msg.seq)}${msg.ts ? ' · ' + esc(fmtFull(msg.ts)) : ''}</span>`;
    if (msg.role === 'tool') {
      const st = (msg.tool && msg.tool.status) || 'ok';
      const stCls = st === 'error' ? 'st-danger' : st === 'running' ? 'st-stale' : 'b-commit';
      return `
        <div class="rd-msg rd-tool">
          <button type="button" class="rd-tool-h" aria-expanded="false" title="点击展开/收起工具入参与结果">
            ${icon('terminal')}<span class="rd-tool-name">${esc((msg.tool && msg.tool.name) || 'tool')}</span>
            <span class="badge ${stCls}">${esc(st)}</span>
            <span class="rd-chev">${icon('chevron-down')}</span>
          </button>
          <div class="rd-tool-b" hidden><pre>${esc(msg.text || '')}</pre></div>
          ${ts}
        </div>`;
    }
    const isUser = msg.role === 'user';
    return `
      <div class="rd-msg ${isUser ? 'rd-user' : 'rd-asst'}">
        <div class="rd-role">${isUser ? '用户' : '助手'}</div>
        <div class="rd-text">${esc(msg.text || '')}</div>
        ${ts}
      </div>`;
  }

  // D2 懒渲染：renderedFrom = 已染最早一条的下标；初始窗口 = 最新 READER_BATCH 条
  let renderedFrom = Math.max(0, msgs.length - READER_BATCH);
  let rendering = false; // 观察器重入保护（回调同步置位，插入完即释放）

  function updateCount() {
    if (countEl) countEl.textContent = `共 ${esc(totalStr || String(msgs.length))} 条 · 已载入 ${msgs.length - renderedFrom} 条`;
    if (earlyHint) earlyHint.textContent = renderedFrom > 0 ? '向上滚动加载更早内容' : '';
  }

  function renderOlder() {
    if (rendering || renderedFrom <= 0) return;
    rendering = true;
    const from = Math.max(0, renderedFrom - READER_BATCH);
    const holder = document.createElement('div');
    holder.innerHTML = msgs.slice(from, renderedFrom).map(msgHtml).join('');
    const frag = document.createDocumentFragment();
    while (holder.firstChild) frag.appendChild(holder.firstChild);
    const prevHeight = scrollEl.scrollHeight;
    feedEl.prepend(frag);
    renderedFrom = from;
    // 锚定：上方插入后按高度差补偿 scrollTop，阅读位置视觉不动
    scrollEl.scrollTop += scrollEl.scrollHeight - prevHeight;
    updateCount();
    rendering = false;
  }

  // 哨兵观察（零依赖，IntersectionObserver；不可用引擎降级为滚顶触发）。
  // 另加滚动位置兜底：接近顶部（≤60px）直接续染——个别引擎/无头环境 IO 回调依赖出帧，可能长时间不投递
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) renderOlder();
    }, { root: scrollEl, rootMargin: '240px 0px 0px 0px' });
    io.observe(sentinel);
  }
  scrollEl.addEventListener('scroll', () => { if (scrollEl.scrollTop <= 60) renderOlder(); });

  // 工具折叠块展开/收起（委托：懒渲染持续插入节点也不丢监听）
  feedEl.addEventListener('click', (e) => {
    const h = e.target.closest('.rd-tool-h');
    if (!h) return;
    const bodyEl = h.parentElement.querySelector('.rd-tool-b');
    const open = bodyEl.hidden;
    bodyEl.hidden = !open;
    h.setAttribute('aria-expanded', String(open));
    h.classList.toggle('open', open);
  });

  // 「回到底部」浮动按钮：距底 >480px 时出现（读历史时一键回最新）
  const nearBottom = () => scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 480;
  scrollEl.addEventListener('scroll', () => { goBtn.hidden = nearBottom(); });
  goBtn.addEventListener('click', () => scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' }));

  // 首批渲染 + 定位到底部（最新消息先读；哨兵在顶部，向上滚动触发向上续染）
  feedEl.innerHTML = msgs.slice(renderedFrom).map(msgHtml).join('');
  updateCount();
  scrollEl.scrollTop = scrollEl.scrollHeight;
  goBtn.hidden = true;
  return m;
}

// ---- v2.9.4 项目绑定弹层：项目目录 → 任务（一对一，改绑自动解旧）----
// PATCH /api/tasks/:id {projectDir}；与逐会话挂接完全独立（绑定不产生 artifacts）
async function openProjectBind(projectId, onDone) {
  let snap = tasks;
  try { snap = (await apiGet('/api/tasks')) || tasks; tasks = snap; } catch { /* 缓存兜底 */ }
  const boundElsewhere = (snap || []).find((t) => t.projectDir && actGroupKey(t.projectDir) === actGroupKey(projectId));
  const options = (snap || []).slice()
    .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt))
    .map((t) => `<option value="${esc(t.id)}"${boundElsewhere && t.id === boundElsewhere.id ? ' selected' : ''}>${esc(t.title)}</option>`)
    .join('');
  const box = document.createElement('div');
  box.innerHTML = `
    <div class="attach-summary">
      <div class="fi-h">
        <span class="badge b-ro">项目绑定</span>
        <span class="mono muted">${esc(projectId)}</span>
      </div>
      <div class="attach-title">把该项目目录整体关联到一个任务</div>
      <div class="muted small">绑定是 ambient 归属：会话列表顶部显示归属、任务详情可溯源；不自动产生会话成果，逐条挂接照常独立使用</div>
    </div>
    <form id="pb-form">
      <div class="form-row"><label>绑定到任务</label>
        <select name="taskId" required aria-label="选择要绑定到的任务">
          <option value="" disabled>请选择任务（必选）</option>
          ${options}
        </select>
        ${boundElsewhere ? `<div class="match-hint warn"><span class="mdot"></span>该项目当前绑定在任务《${esc(boundElsewhere.title)}》，确认后将改绑到所选任务（原任务自动解绑）</div>` : ''}
      </div>
      <div class="form-err" id="pb-err"></div>
      <div class="modal-actions">
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="submit" class="btn">${icon('link')}绑定</button>
      </div>
    </form>`;
  const m = openModal({ title: '绑定项目到任务', body: box });
  const errEl = box.querySelector('#pb-err');
  const showErr = (msg) => { errEl.textContent = msg; errEl.classList.add('show'); };
  box.querySelector('[data-act=cancel]').addEventListener('click', () => m.close());
  box.querySelector('#pb-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.classList.remove('show');
    const tid = e.target.elements.namedItem('taskId').value;
    if (!tid) { showErr('请选择要绑定到的任务'); return; }
    const subBtn = e.target.querySelector('[type=submit]');
    subBtn.disabled = true;
    try {
      if (boundElsewhere && boundElsewhere.id !== tid) {
        await apiPatch(`/api/tasks/${encodeURIComponent(boundElsewhere.id)}`, { projectDir: null });
      }
      await apiPatch(`/api/tasks/${encodeURIComponent(tid)}`, { projectDir: projectId });
      m.close();
      toast('项目绑定成功', 'success');
      if (onDone) onDone();
    } catch (err) {
      showErr(`${err.code ? `${err.code}: ` : ''}${err.message}`);
      subBtn.disabled = false;
    }
  });
}

// ---- 挂接闭环（§5）：复用 activity.js openAttachModal 范式（任务下拉 updatedAt 倒序 + 摘要只读 +
// 去重提示）→ POST /api/tasks/:id/artifacts {kind:"session", sessionRef, title}（D3：不带 url）。
// 去重口径：同 url 去重对 session 不适用，改「同 task 下同 sessionRef」提示 + 同任务拦截
async function openSessionAttach(ref, title, agentId) {
  const agentName = ACT_AGENT_FALLBACK[agentId] || agentId || '';
  const cls = ACT_AGENT_CLS[agentId] || 'ag-zcode';
  // 去重粗查需要最新 artifacts：拉一次任务列表（失败回退模块缓存，不阻断弹层）
  let snap = tasks;
  try { snap = (await apiGet('/api/tasks')) || tasks; } catch { /* 缓存兜底 */ }
  const hasRef = (t) => (t.artifacts || []).some((x) => x && x.kind === 'session' && x.sessionRef === ref);
  const dupTask = snap.find(hasRef);
  const options = snap.slice()
    .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt))
    .map((t) => `<option value="${esc(t.id)}"${dupTask && t.id === dupTask.id ? ' selected' : ''}>${esc(t.title)}</option>`)
    .join('');
  const box = document.createElement('div');
  box.innerHTML = `
    <div class="attach-summary">
      <div class="fi-h">
        <span class="badge act-agent ${cls}">${esc(agentName)}</span>
        <span class="badge b-ro">会话成果</span>
        <span class="muted small">只读快照引用 · 不带外链</span>
      </div>
      <div class="attach-title">${esc(title)}</div>
    </div>
    <form id="sa-form">
      <div class="form-row"><label>挂接到任务</label>
        <select name="taskId" required aria-label="选择要挂接到的任务">
          <option value="" disabled${dupTask ? '' : ' selected'}>请选择任务（必选）</option>
          ${options}
        </select>
        <div class="hint">挂接后出现在任务详情的「成果」区块与时间轴（来源徽标：会话），验收可溯源</div></div>
      ${dupTask ? `<div class="match-hint warn"><span class="mdot"></span>该会话已挂接在任务《${esc(dupTask.title)}》，重复挂接同一任务会被拦截</div>` : ''}
      <div class="form-err" id="sa-err"></div>
      <div class="modal-actions">
        <span class="muted small">成果类型：session</span>
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="submit" class="btn">${icon('link')}挂接</button>
      </div>
    </form>`;
  const m = openModal({ title: '挂到任务成果区', body: box });
  const errEl = box.querySelector('#sa-err');
  const showErr = (msg) => { errEl.textContent = msg; errEl.classList.add('show'); };
  box.querySelector('[data-act=cancel]').addEventListener('click', () => m.close());
  box.querySelector('#sa-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.classList.remove('show');
    const tid = e.target.elements.namedItem('taskId').value;
    if (!tid) { showErr('请选择要挂接到的任务'); return; }
    const target = snap.find((t) => t.id === tid);
    if (!target) { showErr('任务不存在，请刷新后重试'); return; }
    // 前端兜底：同任务已挂接过同会话不再发请求（后端契约不强校验，同 commit/pr 口径）
    if (hasRef(target)) {
      showErr(`任务《${target.title}》已挂接过此会话，无需重复挂接`);
      return;
    }
    try {
      await apiPost(`/api/tasks/${encodeURIComponent(tid)}/artifacts`, {
        kind: 'session',
        sessionRef: ref,
        title
      });
      m.close();
      toast(`已挂到任务《${target.title}》`, 'success');
      // 本页兜底缓存同步：拉最新任务（v2.9 拓扑已迁总览页，总览页自轮询刷新成果区，此处不再喂）
      try { tasks = (await apiGet('/api/tasks')) || tasks; } catch { /* 静默 */ }
    } catch (err) {
      showErr(`${err.code ? `${err.code}: ` : ''}${err.message}`);
    }
  });
}
