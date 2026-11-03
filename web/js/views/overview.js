// F4 总览：统计卡绑 /api/overview + 任务拓扑（10s 轮询）
// v2.5 移除 cli-gateway 监控展示（与智能体页同批）：运行中会话只数指挥台 alive 会话，
//   外部经网关调用行及其「前往智能体页网关动态」深链一并下线（后端 gatewayExternalRunning 字段保留）
// goose v2.3 回归收口（P1-B）：/api/sessions 端点已随会话登记表退役删除，「运行中会话」面板
//   与统计卡整体移除（指挥台不再派活，会话观测唯一入口=智能体页动态面板）；顶栏 pill 同步改任务口径
// v2.9 页面重构：「最近动态 · Gitea」预览面板移除（完整活动流唯一入口=团队动态视图，总览不再
//   重复预览；/api/activities 拉取与 #ov-feed 匹配任务深链随面板一并清理，统计卡「24h 团队动态」
//   仍来自 /api/overview 不受影响）；「任务拓扑」面板自智能体页迁入——views/topology.js 已是独立
//   可复用模块，mount(host, { onSessionClick }) 签名原样复用，会话节点点击经 agents.js 导出的
//   openSessionReader 直开阅读器（跨文件导出零障碍，未提升共享位置）；任务层数据供给沿用 agents 页
//   syncTopology 模式：agents/members/columns 首挂拉取缓存，tasks 随 10s tick 刷新喂 topo.update
//   （内部规范化指纹脏比较，无变化跳过重绘，参照 board.js snapshotKey 模式）
import { apiGet, apiPost } from '../api.js';
import { esc, toast, fmtAgo, fmtFull, startPolling, icon } from '../ui.js';
import { mount as mountTopology } from './topology.js';
import { openSessionReader } from './agents.js';

let rootEl = null;
let stopPoll = null;
let topo = null; // 拓扑面板句柄 { update, destroy }
let tasks = []; // 拓扑任务层数据（10s tick 刷新，artifacts/新增任务独立变化）
let agents = []; // 拓扑任务卡显示名映射（首挂缓存，同 agents 页口径；GET /api/agents 看板执行者下拉共用）
let members = []; // 拓扑节点「负责人/验收人」显示名（失败降级空数组，humanMap 兜底原始 id）
let columns = []; // 拓扑任务状态列名（自定义列改名后仍显示人读名；失败降级内置列中文）
let inboxPending = 0; // 收件箱待处理数（行动条用；tick 顺带刷新，失败沿用旧值）

export async function render(el) {
  rootEl = el;
  el.innerHTML = `
    <div class="stats" id="ov-stats"><div class="loading">加载中…</div></div>
    <div id="ov-actions" style="margin:-6px 0 10px"></div>
    <div class="panelbox" id="ov-heatmap"></div>
    <div class="panelbox" id="ov-weekly"></div>
    <div class="panelbox" id="ov-topo"></div>
    <div class="panelbox" id="ov-matrix"></div>`;

  // v2.9.37 版本与兼容性矩阵（BACKLOG「下一轮队列」首项）：把文档里的版本对照表搬进产品内。
  // 位置=页面最末、默认折叠（业主口径：诊断信息不该抢首屏）；兼容徽标留在标题行，收起也可见。
  initMatrixPanel(rootEl.querySelector('#ov-matrix'));

  // v2.9.26 Agent 时间线热力图（「AI 编码时代的 WakaTime」）：六源会话 日×agent 活跃聚合
  initHeatmapPanel(rootEl.querySelector('#ov-heatmap'));

  // v2.9.5 数字员工周报面板：会话数据聚合 → harness 引擎蒸馏（生成走 job 轮询，独立于 10s tick）
  initWeeklyPanel(rootEl.querySelector('#ov-weekly'));

  // 任务拓扑面板（渲染逻辑独立在 views/topology.js，自智能体页迁入）：本页第二面板。
  // 会话节点点击 → 复用 agents.js 导出的 openSessionReader 直达阅读器（只读，
  // 挂接闭环同源；onSessionClick 语义与原智能体页接线逐字一致）
  const topoHost = rootEl.querySelector('#ov-topo');
  topo = mountTopology(topoHost, {
    onSessionClick: (ref) => { if (ref) openSessionReader(ref); }
  });

  await refreshAll();
  if (!rootEl) return;
  // mount 后立即喂数据，不等首个 10s tick——原先拓扑首挂带「暂无任务」空态空转一个 tick 周期，
  // 误导「任务丢了」（agents 页 P2② 同款教训，draw/update 同步执行，无空态闪帧）
  syncTopology();
  stopPoll = startPolling(tick, 10000);
}

export function destroy() {
  rootEl = null;
  if (topo) { topo.destroy(); topo = null; } // 先销毁拓扑（内部状态复位），再清轮询
  if (stopPoll) { stopPoll(); stopPoll = null; }
  members = [];
  columns = [];
}

async function refreshAll() {
  const root = rootEl;
  if (!root) return;
  try {
    // members/columns 仅拓扑节点显示名与状态列名用，失败降级空数组（原始 id / 内置列中文名兜底）；
    // overview 与 tasks 为主数据，失败走 catch（统计卡错误态 + toast，拓扑空态兜底不炸整页）
    const [ov, ts, ags, mems, cols, istats] = await Promise.all([
      apiGet('/api/overview'),
      apiGet('/api/tasks'),
      apiGet('/api/agents'),
      apiGet('/api/members').catch(() => []),
      apiGet('/api/columns').catch(() => []),
      apiGet('/api/inbox/stats').catch(() => null)
    ]);
    if (!rootEl) return;
    tasks = ts || [];
    agents = ags || [];
    members = mems || [];
    columns = cols || [];
    if (istats) inboxPending = Number(istats.pending) || 0;
    renderStats(ov);
  } catch (e) {
    const stats = root.querySelector('#ov-stats');
    if (stats) stats.innerHTML = `<div class="loading err" style="grid-column:1/-1">${esc(e.message)}</div>`;
    toast(e.message);
  }
}

// 拓扑数据供给：tasks 随 10s tick 刷新，agents/members/columns 用首挂缓存（同 agents 页模式）；
// 会话层不在此喂（topology 自拉 agent-sessions，来源由其面板头下拉管理）
function syncTopology() {
  if (!topo || !rootEl) return;
  topo.update({ tasks, agents, members, columns });
}

// 10s tick：统计卡刷新 + 任务/成果变化喂拓扑（topology.update 内部脏比较，无变化跳过重绘）；
// tick 失败静默：统计卡与拓扑用旧数据兜底（首挂 refreshAll 已报过错，轮询期不 toast 轰炸）
async function tick() {
  try {
    const [ov, ts, istats] = await Promise.all([
      apiGet('/api/overview'),
      apiGet('/api/tasks'),
      apiGet('/api/inbox/stats').catch(() => null)
    ]);
    if (!rootEl) return;
    tasks = ts || tasks;
    if (istats) inboxPending = Number(istats.pending) || 0;
    renderStats(ov);
  } catch { /* 旧数据兜底，等下一 tick */ }
  syncTopology();
}

function renderStats(ov) {
  const root = rootEl;
  if (!root) return;
  const t = (ov && ov.tasks) || {};
  const total = ['todo', 'doing', 'review', 'done'].reduce((s, k) => s + (Number(t[k]) || 0), 0);
  // 契约 v1.4：/api/overview 的 tasks 带 overdue 计数（服务端口径；旧后端无此字段时按 0 展示）
  const overdue = Number(t.overdue) || 0;
  const g = (ov && ov.gitea) || {};
  const ok = !!g.ok;
  root.querySelector('#ov-stats').innerHTML = `
    <div class="stat"><b>${total}</b><span>任务总数（进行中 ${Number(t.doing) || 0}）</span></div>
    <div class="stat"><b style="color:${overdue > 0 ? 'var(--red)' : 'var(--muted)'}">${overdue}</b><span>逾期任务</span></div>
    <div class="stat"><b>${Number(ov.agents) || 0}</b><span>在册智能体</span></div>
    <div class="stat"><b>${Number(ov.activities24h) || 0}</b><span>24h 团队动态</span></div>
    <div class="stat"><b style="color:${ok ? 'var(--green)' : 'var(--red)'}">${ok ? '已连接' : '异常'}</b>
      <span>Gitea · ${g.lastError ? esc(String(g.lastError)).slice(0, 24) : `拉取于 ${fmtAgo(g.lastPollAt)}`}</span></div>`;
  renderActions(ov);
}

// ---- 驾驶舱行动条（2026-11-03，业主早期拍板「薄条+跳转不做仪表盘」）：统计卡下一行 thin chips，
// 只显示非零项，全零整条隐藏（零噪音）；每项带跳转直达对应页面。数据全部来自既有端点
// （overview.tasks/ diaryMissing 只增字段 + inbox/stats.pending + members 首挂缓存的 alive 推导）
function renderActions(ov) {
  const root = rootEl;
  if (!root) return;
  const el = root.querySelector('#ov-actions');
  if (!el) return;
  const t = (ov && ov.tasks) || {};
  const overdue = Number(t.overdue) || 0;
  const review = Number(t.review) || 0;
  const inbox = Number(inboxPending) || 0;
  const diaryMissing = Number(ov && ov.diaryMissing) || 0;
  const alive = members.filter((m) => m && m.kind === 'agent' && m.session && m.session.alive).length;
  const parts = [];
  if (overdue > 0) parts.push(`<a class="badge st-danger" href="#/board" title="有截止时间的任务已逾期，点击打开任务看板">逾期 ${overdue}</a>`);
  if (review > 0) parts.push(`<a class="badge st-working" href="#/board" title="已进待验收（review）列的任务，点击打开任务看板">待验收 ${review}</a>`);
  if (inbox > 0) parts.push(`<a class="badge b-pr" href="#/radar" title="收件箱待处理候选：AI 拆解产出等你确认/拒绝/合并">收件箱待处理 ${inbox}</a>`);
  if (diaryMissing > 0) parts.push(`<a class="badge st-stale" href="#/members" title="名下有进行中任务但今天还没填日报的成员数">日报未填 ${diaryMissing}</a>`);
  if (alive > 0) parts.push(`<a class="badge b-alive" href="#/members" title="当前在岗的桌面 agent 数（最近会话活跃）">在岗 ${alive}</a>`);
  el.innerHTML = parts.length
    ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${parts.join('')}</div>`
    : '';
}

// ---- v2.9.26 Agent 时间线热力图：GET /api/agent-heatmap（28 天 × 六源，格深=活跃分钟）----
// 悬浮显示 会话数/分钟；无活动源时整卡降级一行提示（不占版面）。强度分 4 档，色弱可辨（深浅而非色相）。
const HM_AGENT_LABEL = { zcode: 'ZCode', claude: 'Claude', dsh: 'DSH', workbuddy: 'WorkBuddy', codex: 'Codex', opencode: 'OpenCode' };

function initHeatmapPanel(host) {
  if (!host) return;
  apiGet('/api/agent-heatmap?days=28').then((r) => {
    if (!host.isConnected) return;
    const agents = (r.agents || []).filter((a) => (r.days || []).some((d) => d.agents && d.agents[a]));
    if (!agents.length) {
      host.innerHTML = `
        <h4 class="panel-title"><span>Agent 活跃热力图</span><span class="spacer"></span>
          <span class="muted small">近 28 天六源会话活跃（越深=干得越久）</span></h4>
        <div class="empty-state">${icon('bot')}<span>近 28 天暂无 agent 会话活动——去智能体页看看数据源状态</span></div>`;
      return;
    }
    const maxMin = Math.max(1, ...r.days.flatMap((d) => Object.values(d.agents).map((c) => c.minutes)));
    const lvl = (m) => (m <= 0 ? 0 : m < maxMin * 0.1 ? 1 : m < maxMin * 0.35 ? 2 : m < maxMin * 0.7 ? 3 : 4);
    const todayYmd = (r.days[r.days.length - 1] || {}).date;
    const head = `<h4 class="panel-title"><span>Agent 活跃热力图</span><span class="spacer"></span>
      <span class="muted small" title="口径：每源取最近 50 条会话（极活跃项目可能少算，属概览视图）">近 28 天 · ${r.totalSessions} 会话 · ${r.totalMinutes} 分钟 · 格越深干得越久</span></h4>`;
    const rows = agents.map((a) => {
      const cells = (r.days || []).map((d) => {
        const c = (d.agents || {})[a];
        const m = c ? c.minutes : 0;
        return `<span class="hm-cell hm-l${lvl(m)}${d.date === todayYmd ? ' hm-today' : ''}" title="${esc(d.date)} · ${c ? c.sessions : 0} 会话 · ${m} 分钟"></span>`;
      }).join('');
      return `<div class="hm-row"><span class="hm-label">${esc(HM_AGENT_LABEL[a] || a)}</span><span class="hm-cells">${cells}</span></div>`;
    }).join('');
    const scale = `<div class="hm-scale"><span class="muted small">浅</span>
      ${[1, 2, 3, 4].map((l) => `<span class="hm-cell hm-l${l}"></span>`).join('')}
      <span class="muted small">深 · 今天在最后</span></div>`;
    host.innerHTML = `${head}<div class="hm-grid">${rows}${scale}</div>`;
  }).catch(() => {
    host.innerHTML = `
      <h4 class="panel-title"><span>Agent 活跃热力图</span></h4>
      <div class="muted small">热力图加载失败（不影响其他面板）</div>`;
  });
}

// ---- v2.9.6 数字员工报告面板（日报 | 周报）：会话数据聚合 → harness 引擎蒸馏 ----
// 周报手动生成；日报自动档（后端每天 ≥08:00 首个 tick 自动跑昨日窗口，此处可手动重生成）。
// 生成走 job 轮询（引擎耗时 30~120s+，与雷达拆解同款 202+job 模式）；Markdown 用极简渲染
// （标题/加粗/列表/段落，先 esc 后转换防注入），「复制 Markdown」给钉钉粘贴用。

function mdToHtml(md) {
  const esc2 = (s) => esc(s);
  const inline = (s) => esc2(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let inList = false;
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (h) out.push(`<h${Math.min(h[1].length + 3, 6)}>${inline(h[2])}</h${Math.min(h[1].length + 3, 6)}>`);
    else if (line.trim() === '') out.push('');
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

const REPORT_KINDS = {
  daily: { label: '日报', gen: '/api/daily/generate', job: (id) => `/api/daily/job/${encodeURIComponent(id)}`, get: '/api/daily', genLabel: '生成今日日报', empty: '还没有日报——每天上午会自动生成昨日窗口，也可点右上角立即生成' },
  weekly: { label: '周报', gen: '/api/weekly/generate', job: (id) => `/api/weekly/job/${encodeURIComponent(id)}`, get: '/api/weekly', genLabel: '生成本周周报', empty: '还没有周报——点右上角生成，聚合本周数字员工会话蒸馏成稿' },
};

function initWeeklyPanel(host) {
  if (!host) return;
  let polling = null;
  let curKind = 'daily';
  try { curKind = localStorage.getItem('fde-report-tab') === 'weekly' ? 'weekly' : 'daily'; } catch (e) { /* 无 localStorage 用默认 */ }
  let currentReport = '';
  let currentMeta = null;

  function renderIdle(doc) {
    const k = REPORT_KINDS[curKind];
    const stats = doc && doc.stats;
    const statLine = stats
      ? `<span class="muted small">养料：${stats.sessionsTotal} 会话（${Object.entries(stats.perAgent || {}).filter(([, v]) => v > 0).map(([k2, v]) => `${k2} ${v}`).join(' / ') || '无'}） · ${stats.commitsTotal} 提交 · 完成 ${stats.doneTotal} 任务${stats.truncated ? ' · 已截断' : ''}</span>`
      : `<span class="muted small">${curKind === 'daily' ? '日报自动档：每天上午生成昨日窗口（含内容萃取），此处可手动重生成' : '聚合本周各数字员工会话、提交、任务与日报，经引擎蒸馏成稿'}</span>`;
    const keyLabel = doc
      ? (curKind === 'daily'
            ? `今日日报（${esc(doc.dayKey || '')}）`
            : (() => { // v2.9.19：周报标签显示完整七日区间（weekKey 起点 + 6 天），消除「起」的单端歧义
                const m = String(doc.weekKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
                if (!m) return `周（${esc(doc.weekKey || '')}）`;
                const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 6);
                const pad = (n) => String(n).padStart(2, '0');
                const endYmd = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
                return `周（${esc(doc.weekKey)} → ${endYmd}，即 ${m[2]}-${m[3]} → ${pad(end.getMonth() + 1)}-${pad(end.getDate())}）`;
              })())
      : '';
    host.innerHTML = `
      <h4 class="panel-title"><span>数字员工报告</span>
        <span class="act-chips" role="group" aria-label="报告周期切换">
          ${Object.keys(REPORT_KINDS).map((id) => `<button type="button" class="chip${id === curKind ? ' on' : ''}" data-k="${id}" aria-pressed="${id === curKind}">${REPORT_KINDS[id].label}</button>`).join('')}
        </span>
        <span class="spacer"></span>${statLine}
        <button type="button" class="btn ghost small" id="wk-gen">${icon('zap')}${doc ? '重新生成' : k.genLabel}</button>
      </h4>
      <div id="wk-body">${doc
        ? `<div class="muted small" style="margin-bottom:6px">${keyLabel} · 生成于 <span title="${esc(fmtFull(doc.generatedAt))}">${fmtAgo(doc.generatedAt)}</span>
             <button type="button" class="btn ghost xs" id="wk-copy" style="margin-left:6px">${icon('copy')}复制 Markdown</button>
             <button type="button" class="btn ghost xs" id="wk-export" style="margin-left:6px" title="下载 .md 文件">${icon('external-link')}导出 .md</button></div>
           <div class="weekly-md">${mdToHtml(doc.report)}</div>`
        : `<div class="empty-state">${icon('file-text')}<span>${k.empty}</span></div>`}</div>`;
    host.querySelector('#wk-gen').addEventListener('click', generate);
    host.querySelectorAll('.act-chips .chip').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.k === curKind) return;
        curKind = b.dataset.k;
        try { localStorage.setItem('fde-report-tab', curKind); } catch (e2) { /* 本页生效即可 */ }
        load();
      });
    });
    const copyBtn = host.querySelector('#wk-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(currentReport);
          toast(`${k.label} Markdown 已复制`, 'success');
        } catch (e) { toast('复制失败：' + e.message); }
      });
    }
    // v2.9.26 报告导出：Blob 下载 .md（开源用户无钉钉，文件出口；文件名带类型与周期键）
    const exportBtn = host.querySelector('#wk-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        if (!currentReport) { toast('还没有可导出的报告'); return; }
        const stamp = curKind === 'daily'
          ? String((currentMeta && currentMeta.dayKey) || '')
          : String((currentMeta && currentMeta.weekKey) || '');
        const name = `fde-${curKind}-${stamp || new Date().toISOString().slice(0, 10)}.md`;
        const blob = new Blob([currentReport], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        toast(`已导出 ${name}`, 'success');
      });
    }
  }

  function renderRunning() {
    const genBtn = host.querySelector('#wk-gen');
    if (genBtn) { genBtn.disabled = true; genBtn.innerHTML = `${icon('refresh-cw')}蒸馏中…（约 2~5 分钟）`; }
    const body = host.querySelector('#wk-body');
    if (body && !body.querySelector('.weekly-md')) body.innerHTML = '<div class="loading">正在聚合窗内会话（含内容萃取）并交引擎蒸馏…</div>';
  }

  async function generate() {
    const k = REPORT_KINDS[curKind];
    try {
      const r = await apiPost(k.gen, {});
      renderRunning();
      const jobId = r.jobId;
      const started = Date.now();
      polling = setInterval(async () => {
        try {
          const j = await apiGet(k.job(jobId));
          if (j.state === 'running') {
            if (Date.now() - started > 12 * 60000) stop(true, '生成超时（12 分钟未完成），请重试');
            return;
          }
          const okResult = (j.results || []).find((x) => x.ok);
          stop(false);
          if (okResult) await load();
          else {
            const err = (j.results || []).find((x) => !x.ok);
            toast(`${k.label}生成失败：${(err && err.error) || j.state}`);
            await load();
          }
        } catch (e) { stop(true, e.message); }
      }, 3000);
      function stop(fail, msg) {
        if (polling) { clearInterval(polling); polling = null; }
        const btn = host.querySelector('#wk-gen');
        if (btn) { btn.disabled = false; btn.innerHTML = `${icon('zap')}重新生成`; }
        if (fail && msg) toast(msg);
      }
    } catch (e) {
      toast(e.message);
      await load(); // 回填面板（按钮态复位）
    }
  }

  async function load() {
    if (!host.isConnected) return;
    const k = REPORT_KINDS[curKind];
    try {
      const doc = await apiGet(k.get);
      currentReport = doc.report || '';
      currentMeta = doc;
      renderIdle(doc);
    } catch (e) {
      currentReport = '';
      currentMeta = null;
      renderIdle(null); // 404 → 空态（该周期从未生成）
    }
  }
  load();
}

// ---- v2.9.37 版本与兼容性矩阵（BACKLOG「下一轮队列」首项）----
// 数据源两处，都是一手事实：GET /api/ping（package.json 的 version/engines + 进程运行时）
// 与宿主页面引导清单 window.__DSH_BOOT__（同 origin 的父窗口，release.version = DSH 版本）。
// 目的：把 DISTRIBUTION/README 里靠手改的版本对照表搬进产品，杜绝「文档写 2.9.28、实际 2.9.32」漂移。

/** 读宿主引导清单：{dsh, commit, ids}。独立打开（无父页面）或跨域时全 null/空。 */
function readHostBoot() {
  const out = { dsh: null, commit: null, ids: [] };
  try {
    const win = (typeof window !== 'undefined' && window.parent && window.parent !== window) ? window.parent : window;
    const boot = win && win.__DSH_BOOT__;
    if (!boot || typeof boot !== 'object') return out;
    const rel = boot.release;
    if (rel && typeof rel.version === 'string') out.dsh = rel.version;
    if (rel && typeof rel.commit === 'string') out.commit = rel.commit.slice(0, 7);
    if (Array.isArray(boot.entries)) {
      for (const e of boot.entries) if (e && typeof e.id === 'string') out.ids.push(e.id);
    }
  } catch (e) { /* 跨域/非嵌入形态：视为未知 */ }
  return out;
}

/** 极简 semver 解析：只服务「>=x <y」这类声明式范围（可带预发布），不实现 npm 全语法。 */
function parseVer(v) {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** semver 偏序比较（预发布低于同版本正式版；数字标识符低于字母标识符） */
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) {
    if (a.pre.length === b.pre.length) return 0;
    return a.pre.length ? -1 : 1; // 有预发布 < 无预发布（正式版）
  }
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 范围判定：全部比较符都满足才 true；任一无法解析返回 null（调用方显示「未知」，绝不瞎猜）。 */
function satisfiesRange(version, range) {
  const v = parseVer(version);
  if (!v) return null;
  const parts = String(range || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    const m = part.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
    if (!m) return null;
    const target = parseVer(m[2]);
    if (!target) return null;
    const c = cmpVer(v, target);
    const op = m[1] || '=';
    const bad = (op === '>=' && c < 0) || (op === '>' && c <= 0) || (op === '<=' && c > 0)
      || (op === '<' && c >= 0) || (op === '=' && c !== 0);
    if (bad) return false;
  }
  return true;
}

function initMatrixPanel(host) {
  if (!host) return;
  const boot = readHostBoot();
  apiGet('/api/ping').then((p) => {
    if (!host.isConnected) return;
    const engines = (p && p.engines) || {};
    const rt = (p && p.runtime) || {};
    const pluginVer = (p && p.version) || '未知';
    const dshVer = boot.dsh;
    let pill = { cls: '', text: '兼容性未知', title: '缺少宿主版本或引擎声明，无法判定（不猜）' };
    if (dshVer && engines.dsh) {
      const ok = satisfiesRange(dshVer, engines.dsh);
      if (ok === true) pill = { cls: ' ok', text: '兼容', title: `宿主 ${dshVer} 满足 engines.dsh ${engines.dsh}` };
      else if (ok === false) pill = { cls: ' err', text: '不兼容', title: `宿主 ${dshVer} 不满足 engines.dsh ${engines.dsh}——宿主升级后需重验` };
    }
    const betterInstalled = boot.ids.some((id) => /better-sidebar/i.test(id));
    // 折叠态：默认收起（诊断信息不抢版面），用户展开后记忆；兼容徽标始终在标题行可见
    let open = false;
    try { open = localStorage.getItem('fde-matrix-open') === '1'; } catch (e) { /* 无存储则用默认收起 */ }
    const row = (k, v, hint) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span><span class="h muted small">${hint || ''}</span>`;
    host.innerHTML = `
      <h4 class="panel-title">
        <button type="button" class="fold-toggle mx-fold${open ? ' open' : ''}" id="mx-fold"
          aria-expanded="${open}" aria-controls="mx-body" title="展开/收起版本明细">
          ${icon('chevron-down')}<span>版本与兼容性</span>
        </button>
        <span class="spacer"></span>
        <span class="pill${pill.cls}" title="${esc(pill.title)}">${esc(pill.text)}</span></h4>
      <div class="fold-body" id="mx-body"${open ? '' : ' hidden'}>
        <div class="vmatrix">
          ${row('FDE 指挥台', `v${pluginVer}`, engines.dsh ? `要求 DSH ${esc(engines.dsh)}` : '')}
          ${row('DSH 宿主', dshVer ? `${dshVer}${boot.commit ? ` (${boot.commit})` : ''}` : '未知',
            dshVer ? '来自宿主页面引导清单' : '未嵌入 DSH 页面时不可知')}
          ${row('Node.js', rt.node || '未知', engines.node ? `要求 ${esc(engines.node)}（node:sqlite 门槛）` : '')}
          ${row('dsh-better-sidebar', betterInstalled ? '已安装' : '未检测到', '可选：原生侧栏 tab（版本不随引导清单下发）')}
        </div>
        <div class="muted small" style="margin-top:8px">宿主升级后先在一台机器重跑冒烟三连 + 核心动线，再推全员（AGENTS 红线 9）。</div>
      </div>`;
    const foldBtn = host.querySelector('#mx-fold');
    const foldBody = host.querySelector('#mx-body');
    if (foldBtn && foldBody) {
      foldBtn.addEventListener('click', () => {
        foldBody.hidden = !foldBody.hidden;
        foldBtn.classList.toggle('open', !foldBody.hidden);
        foldBtn.setAttribute('aria-expanded', String(!foldBody.hidden));
        try { localStorage.setItem('fde-matrix-open', foldBody.hidden ? '0' : '1'); } catch (e) { /* 本页生效即可 */ }
      });
    }
  }).catch(() => {
    host.innerHTML = `<h4 class="panel-title"><span>${icon('terminal')}版本与兼容性</span></h4>
      <div class="muted small">版本信息加载失败（/fde-api/ping 不可达，不影响其他面板）</div>`;
  });
}
