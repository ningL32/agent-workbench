// 任务雷达（PRD-task-inbox §6）：纪要池（源徽标/时间/分析水位/选中框+分析所选）+ 收件箱候选卡流
// （置信度降序徽标、批量确认/拒绝、标题与负责人可编辑、dueHint 原文词+日期选择器、原文引用折叠、
// 近 30 天拒绝率徽标）。同步/分析走异步 job：202 → 轮询 /api/radar/jobs/:id → 完成刷新。
import { api, apiGet, apiPost, apiDel } from '../api.js';
import { state } from '../state.js';
import { esc, toast, openModal, confirmModal, icon, fmtAgo, fmtClock, fmtFull, fmtSec, startPolling, dueBadge, busyBtn, safeHttpUrl } from '../ui.js';

let rootEl = null;
let stopPoll = null;
let messages = [];
let candidates = [];
let stats = { pending: 0, confirmed: 0, rejected: 0, doneAlready: 0, rejectRate30d: null };
let members = [];
let taskTitles = new Map(); // 叙事线第一批：update 候选的关联任务标题（existingTaskId → title）
let checkedMsg = new Set();
let checkedCand = new Set();
let activeJob = null; // {id, kind} 分析/同步进行中（POST await 前即占位认领；id 在 POST 返回后回填）；sync 与 analyze 经此互斥
let jobTimer = null;
let tab = 'inbox'; // 'pool' | 'inbox' 两段式切换
let foldedGroups = null; // 收件箱分组折叠 key 集（懒加载自 localStorage，v2.9.10）

// 可分析口径（v2.1-A 收敛为单一谓词）：待分析或分析失败；与行勾选禁用、全选、计数同源
const selectableMsg = (m) => !m.analyzedAt || m.analyzeState === 'ANALYZE_FAILED';

export async function render(el) {
  rootEl = el;
  el.innerHTML = `
    <div class="toolbar">
      <button type="button" class="btn ghost" id="radar-sync">${icon('refresh-cw')}同步钉钉听记</button>
      <button type="button" class="btn ghost" id="radar-sync-feishu" title="拉取飞书妙记入池（需在设置页开启飞书通道并装好 lark-cli）">${icon('refresh-cw')}同步飞书妙记</button>
      <button type="button" class="btn ghost" id="radar-text">${icon('file-text')}粘贴转写</button>
      <button type="button" class="btn ghost" id="radar-ignore" title="删过的纪要 + 关键词规则：下次同步直接跳过">${icon('zap')}过滤规则</button>
      <span class="pill" id="radar-engine" title="引擎状态">…</span>
      <span class="spacer"></span>
      <span class="muted small" id="radar-job-hint"></span>
      <button type="button" class="btn" id="radar-analyze" disabled>${icon('zap')}分析所选</button>
    </div>
    <div class="stats" id="radar-stats"><div class="loading">加载中…</div></div>
    <div class="radar-lastjob" id="radar-lastjob" hidden></div>
    <div class="radar-tabs" role="tablist">
      <button type="button" class="seg-btn" data-tab="pool" role="tab">纪要池 <span class="n" id="radar-pool-n"></span></button>
      <button type="button" class="seg-btn" data-tab="inbox" role="tab">收件箱 <span class="n" id="radar-inbox-n"></span></button>
    </div>
    <div id="radar-pool"></div>
    <div id="radar-inbox"></div>`;

  el.querySelector('#radar-sync').addEventListener('click', () => startSync('sync'));
  el.querySelector('#radar-sync-feishu').addEventListener('click', () => startSync('sync-feishu'));
    el.querySelector('#radar-ignore').addEventListener('click', openIgnoreModal);
  el.querySelector('#radar-text').addEventListener('click', openTextInput);
  el.querySelector('#radar-analyze').addEventListener('click', analyzeChecked);
  el.querySelectorAll('.radar-tabs .seg-btn').forEach((b) => {
    b.addEventListener('click', () => { tab = b.dataset.tab; drawTabs(); drawPool(); drawInbox(); });
  });

  await refresh();
  if (!rootEl) return;
  stopPoll = startPolling(refresh, 30000);
}

export function destroy() {
  rootEl = null;
  if (stopPoll) { stopPoll(); stopPoll = null; }
  if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
  checkedMsg = new Set();
  checkedCand = new Set();
  activeJob = null;
}

// v2.1-A：job 触发点禁用态的统一出口——认领/释放/pollJob 终态/视图销毁全收敛到这一处。
// 按 activeJob 同步「同步钉钉听记」「分析所选」与纪要池行/结果条两处「重试」按钮的 disabled；
// 认领（含 POST await 前的占位）、释放、终态兜底、drawPool/drawInbox 重渲染后都调用它
function syncJobControls() {
  const root = rootEl;
  if (!root) return;
  const busy = !!activeJob;
  const syncBtn = root.querySelector('#radar-sync');
  if (syncBtn) syncBtn.disabled = busy;
  const feishuSyncBtn = root.querySelector('#radar-sync-feishu');
  if (feishuSyncBtn) {
    const channelOff = feishuChannelOn === false; // 仅实报关闭时禁用（未知/拉取失败不禁，免误伤）
    feishuSyncBtn.disabled = busy || channelOff;
    feishuSyncBtn.title = channelOff
      ? '飞书妙记通道未开启：先到「设置」页打开「飞书妙记通道」开关'
      : '拉取飞书妙记入池（需在设置页开启飞书通道并装好 lark-cli）';
  }
  const nChecked = [...checkedMsg].filter((id) => messages.some((m) => m.id === id && selectableMsg(m))).length;
  const analyzeBtn = root.querySelector('#radar-analyze');
  if (analyzeBtn) {
    analyzeBtn.disabled = busy || nChecked === 0;
    analyzeBtn.innerHTML = `${icon('zap')}分析所选${nChecked ? `（${nChecked}）` : ''}`;
  }
  // 两处重试入口（池行 + 结果条）在 job 进行中一并禁用，双击/二击无第二发 POST
  root.querySelectorAll('button[data-act=retry], button[data-act=lj-retry]').forEach((b) => { b.disabled = busy; });
}

// 认领/释放 activeJob：认领失败（已有 job 在跑）返回 false，调用方直接返回
function claimJob(kind) {
  if (activeJob) return false;
  activeJob = { id: null, kind };
  syncJobControls();
  return true;
}

function releaseJob() {
  activeJob = null;
  syncJobControls();
}

async function refresh() {
  const root = rootEl;
  if (!root) return;
  try {
    const [msgs, inbox, st, mems, tsks] = await Promise.all([
      apiGet('/api/radar/messages'),
      apiGet('/api/inbox?state=pending'),
      apiGet('/api/inbox/stats'),
      apiGet('/api/members').catch(() => []),
      apiGet('/api/tasks').catch(() => []) // update 候选要展示关联任务标题
    ]);
    if (!rootEl) return;
    messages = msgs || [];
    candidates = inbox || [];
    stats = st || stats;
    members = (mems || []).filter((m) => m.kind === 'human' && m.enabled !== false);
    taskTitles = new Map((tsks || []).map((t) => [t.id, t.title]));
    renderAll();
  } catch (e) {
    const box = root.querySelector('#radar-stats');
    if (box) box.innerHTML = `<div class="loading err">${esc(e.message)}</div>`;
    toast(e.message);
  }
}

function renderAll() {
  drawStats();
  drawTabs();
  drawPool();
  drawInbox();
  drawEnginePill();
  drawLastJob();
  syncJobControls(); // 重渲染后重申 job 触发点禁用态（单一路径收敛）
}

function drawTabs() {
  const root = rootEl;
  if (!root) return;
  root.querySelectorAll('.radar-tabs .seg-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === tab);
  });
  root.querySelector('#radar-pool').hidden = tab !== 'pool';
  root.querySelector('#radar-inbox').hidden = tab !== 'inbox';
  root.querySelector('#radar-pool-n').textContent = messages.length;
  root.querySelector('#radar-inbox-n').textContent = candidates.length;
}

function drawStats() {
  const root = rootEl;
  if (!root) return;
  const pending = messages.filter((m) => !m.analyzedAt).length;
  const failed = messages.filter((m) => m.analyzeState === 'ANALYZE_FAILED').length;
  const rate = stats.rejectRate30d;
  // P2-4 口径修正：大字一律用 30 天值（confirmed30d/rejected30d/doneAlready30d），全量累计只进提示，
  // 避免出现 30 天前数据后大字与「近30天」标签永久不一致
  const c30 = stats.confirmed30d;
  const r30 = stats.rejected30d;
  const d30 = stats.doneAlready30d;
  // v1.7 误识率新口径：拒/(确+已完成+拒)——已完成不再推高分母外的拒绝占比
  const den30 = (c30 ?? 0) + (r30 ?? 0) + (d30 ?? 0);
  root.querySelector('#radar-stats').innerHTML = `
    <div class="stat"><b>${messages.length}</b><span>纪要池（待分析 ${pending}${failed ? ` · 失败 ${failed}` : ''}）</span></div>
    <div class="stat"><b style="color:var(--accent)">${stats.pending}</b><span>待确认候选</span></div>
    <div class="stat" title="口径：仅统计近 30 天确认；全量累计确认 ${stats.confirmed ?? 0}"><b>${c30 ?? 0}</b><span>近 30 天确认</span></div>
    <div class="stat" title="口径：候选被标记为已完成（入统计、不入看板）；全量累计 ${stats.doneAlready ?? 0}"><b>${d30 ?? 0}</b><span>近 30 天已完成</span></div>
    <div class="stat"><b style="color:${(rate ?? 0) > 0.5 ? 'var(--red)' : 'var(--green)'}">${rate == null ? '—' : Math.round(rate * 100) + '%'}</b>
      <span title="v1.7 口径：近 30 天 rejected/(confirmed+doneAlready+rejected)">误识率 = 拒/(确+已完成+拒)（拒 ${r30 ?? 0} / 确 ${c30 ?? 0} / 已完成 ${d30 ?? 0}，分母 ${den30}）</span></div>`;
}

let feishuChannelOn = null; // null=未知（引擎状态未返回前不禁用按钮）；true/false=引擎健康实报

function drawEnginePill() {
  const root = rootEl;
  if (!root) return;
  const pill = root.querySelector('#radar-engine');
  apiGet('/api/radar/engine').then((e) => {
    if (!rootEl) return;
    const dshOk = e.dsh.found || e.dsh.fixtureMode;
    const dtOn = e.dingtalk.enabled;
    const fx = e.feishu || {};
    feishuChannelOn = fx.enabled === true;
    pill.innerHTML = `${icon('zap')}引擎 ${dshOk ? '可达' : '未找到'} · 钉钉 ${dtOn ? '开' : '关'} · 飞书 ${fx.enabled ? '开' : '关'}`;
    pill.classList.toggle('warn', !dshOk || !dtOn);
    syncJobControls(); // 通道开关状态到位后重申同步按钮可用性
  }).catch(() => { if (rootEl) pill.textContent = '引擎状态未知'; });
}

// ---------------- 纪要池 ----------------

function poolRow(m) {
  const checked = checkedMsg.has(m.id);
  const reAnalyzable = !m.analyzedAt || m.analyzeState === 'ANALYZE_FAILED';
  let stateBadge;
  if (m.analyzeState === 'ANALYZE_FAILED') {
    stateBadge = `<span class="badge st-danger" title="${esc(m.analyzeError || '分析失败')}">分析失败</span>
      <button type="button" class="btn ghost xs" data-act="retry" data-id="${esc(m.id)}"${activeJob ? ' disabled' : ''}>${icon('refresh-cw')}重试</button>`;
  } else if (m.analyzedAt) {
    stateBadge = `<span class="badge st-working" title="${esc(fmtFull(m.analyzedAt))}">已分析</span>`;
  } else {
    stateBadge = '<span class="badge st-idle">待分析</span>';
  }
  // 来源徽标：钉钉/飞书有专属色，其余（text/gitea…）回落灰底技术名
  const src = m.source === 'dingtalk'
    ? '<span class="badge b-pr" title="钉钉听记">钉钉</span>'
    : m.source === 'feishu'
      ? '<span class="badge b-pr" title="飞书妙记">飞书</span>'
      : `<span class="badge b-ro">${esc(m.source)}</span>`;
  // W9：无合法 http(s) 原文链接时降级纯文本——不再渲染 href="#" 死链（跳页顶 + 未过 safeHttpUrl）
  const refUrl = safeHttpUrl(m.ref && m.ref.url);
  const refLabel = m.source === 'feishu' ? '飞书原文' : '钉钉原文';
  const refLink = refUrl
    ? `<a class="link" href="${esc(refUrl)}" target="_blank" rel="noreferrer noopener">${refLabel}</a>`
    : `<span title="该纪要无原文链接">${refLabel}</span>`;
  return `
    <tr data-id="${esc(m.id)}">
      <td class="radar-check"><input type="checkbox" data-act="check" data-id="${esc(m.id)}" aria-label="选中 ${esc(m.title)}"${checked ? ' checked' : ''}${reAnalyzable ? '' : ' disabled'}></td>
      <td>${src}${m.truncated ? '<span class="badge b-dead" title="逐字稿超长已截断">截断</span>' : ''}</td>
      <td><div class="radar-title" title="${esc(m.title)}">${esc(m.title)}</div>
        <div class="muted small">${m.segmentCount} 段 · ${refLink}</div>
        ${m.excerpt ? `<div class="radar-excerpt" title="${esc(m.excerpt)}">${esc(m.excerpt)}${m.excerpt.length >= 120 ? '…' : ''}</div>` : ''}</td>
      <td class="muted small" title="${esc(fmtFull(m.occurredAt))}">${fmtAgo(m.occurredAt)}</td>
      <td class="radar-state">${stateBadge}</td>
      <td class="radar-actions"><button type="button" class="btn ghost xs" data-act="view" data-id="${esc(m.id)}">查看原文</button><button type="button" class="btn ghost xs" data-act="del" data-id="${esc(m.id)}" title="移出纪要池（已产出的收件箱候选不受影响）">删除</button></td>
    </tr>`;
}

function drawPool() {
  const root = rootEl;
  if (!root) return;
  const box = root.querySelector('#radar-pool');
  // 选中集合先剔除已不可分析的残留（已分析行），防勾选残留在「分析所选」里重复分析烧钱（业主实测反馈）
  for (const id of [...checkedMsg]) {
    const m = messages.find((x) => x.id === id);
    if (m && !selectableMsg(m)) checkedMsg.delete(id);
  }
  // v2.1-D 表头全选：口径与行勾选一致——只勾可分析行（待分析/分析失败）
  const selectableIds = messages.filter(selectableMsg).map((m) => m.id);
  const allChecked = selectableIds.length > 0 && selectableIds.every((id) => checkedMsg.has(id));
  const someChecked = selectableIds.some((id) => checkedMsg.has(id));
  box.innerHTML = `
    <div class="panelbox">
      <h4 class="panel-title"><span>纪要池</span>
        <span class="muted small">进池 ≠ 分析：选中纪要 → 「分析所选」触发 AI 拆解 → 候选卡进收件箱</span></h4>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th style="width:34px" class="radar-check"><input type="checkbox" data-act="check-all" aria-label="全选可分析纪要（不含已分析行）"${allChecked ? ' checked' : ''}></th><th style="width:70px">源</th><th>标题</th><th style="width:90px">时间</th><th style="width:170px">分析水位</th><th style="width:132px"></th></tr></thead>
          <tbody>${messages.map(poolRow).join('') || '<tr><td colspan="6"><div class="empty-state">' + icon('radio') + '<span>还没有听记，点上方「同步钉钉听记 / 同步飞书妙记」拉取</span></div></td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  const allCb = box.querySelector('input[data-act=check-all]');
  if (allCb) allCb.indeterminate = !allChecked && someChecked;
  syncJobControls(); // 重渲染后重申「分析所选」计数/禁用与池行重试按钮禁用态

  box.onchange = (e) => {
    const all = e.target.closest('input[data-act=check-all]');
    if (all) {
      if (all.checked) selectableIds.forEach((id) => checkedMsg.add(id));
      else selectableIds.forEach((id) => checkedMsg.delete(id));
      drawPool();
      return;
    }
    const cb = e.target.closest('input[data-act=check]');
    if (!cb) return;
    if (cb.checked) checkedMsg.add(cb.dataset.id); else checkedMsg.delete(cb.dataset.id);
    drawPool();
  };
  box.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'retry') {
      await runAnalyzeJob([btn.dataset.id]);
    } else if (btn.dataset.act === 'view') {
      const m = messages.find((x) => x.id === btn.dataset.id);
      if (m) openMessageDetail(m);
    } else if (btn.dataset.act === 'del') {
      const m = messages.find((x) => x.id === btn.dataset.id);
      if (!m) return;
      const ok = await confirmModal(`将把「${m.title}」移出纪要池（已产出的收件箱候选不受影响），并加入**忽略名单**——以后同步不再拉回来。`, { title: '删除这条纪要？', okText: '删除并忽略' });
      if (!ok) return;
      try {
        await apiDel(`/api/radar/messages/${encodeURIComponent(m.id)}`);
        checkedMsg.delete(m.id);
        messages = messages.filter((x) => x.id !== m.id);
        toast(`已删除「${m.title}」`, 'success');
        drawPool(); drawTabs(); drawStats();
      } catch (err) { toast(err.message); }
    }
  };
}

async function openMessageDetail(m) {
  let full = m;
  try { full = await apiGet(`/api/radar/messages/${encodeURIComponent(m.id)}`); } catch (e) { /* 列表数据兜底 */ }
  const box = document.createElement('div');
  const segs = (full.speakerSegments || []).slice(0, 400)
    .map((s) => `<div class="radar-seg"><span class="radar-spk">${esc(s.raw)}</span><span class="radar-seg-text">${esc(s.text)}</span></div>`)
    .join('');
  const noise = (full.noise || []).map((n) =>
    `<div class="radar-noise-item"><span class="radar-quote">“${esc(n.quote)}”</span><span class="muted small">${esc(n.reason)}</span></div>`).join('');
  // W9：同池行口径——无合法 url 降级纯文本，不出 href="#" 死链
  const fullRefUrl = safeHttpUrl(full.ref && full.ref.url);
  const fullRefLink = fullRefUrl
    ? `<a class="link" href="${esc(fullRefUrl)}" target="_blank" rel="noreferrer noopener">在钉钉中打开</a>`
    : '<span title="该纪要无原文链接">在钉钉中打开</span>';
  box.innerHTML = `
    <div class="td-title">${esc(full.title)}</div>
    <div class="muted small" style="margin-bottom:10px">${esc(fmtFull(full.occurredAt))} · ${(full.speakerSegments || []).length} 段 ·
      ${fullRefLink}</div>
    ${noise ? `<div class="fold"><button type="button" class="fold-toggle" aria-expanded="false">${icon('chevron-down')}<span>判为非任务的部分（${noise.length}）</span></button><div class="fold-body" hidden>${noise}</div></div>` : ''}
    <div class="radar-transcript">${segs || '<div class="empty-state">' + icon('inbox') + '<span>无逐字稿内容</span></div>'}</div>`;
  const foldBtn = box.querySelector('.fold-toggle');
  if (foldBtn) {
    foldBtn.addEventListener('click', () => {
      const body = box.querySelector('.fold-body');
      body.hidden = !body.hidden;
      foldBtn.classList.toggle('open', !body.hidden);
      foldBtn.setAttribute('aria-expanded', String(!body.hidden));
    });
  }
  openModal({ title: '纪要原文', body: box, wide: true });
}

// ---------------- 收件箱候选卡流 ----------------

function confBadge(c) {
  const pct = Math.round((c.confidence || 0) * 100);
  const cls = c.confidence >= 0.9 ? 'conf-high' : c.confidence >= 0.7 ? 'conf-mid' : 'conf-low';
  const label = c.confidence >= 0.9 ? '高' : c.confidence >= 0.7 ? '中' : '低';
  return `<span class="badge ${cls}" title="置信度 ${pct}%（0.9+ 动作/人/时间全明确 · 0.7~0.9 动作明确 · 0.5~0.7 推断性）">${pct}% ${label}</span>`;
}

// 叙事线第一批：update 候选的关联任务行——在册任务可点（跳看板高亮）；已删除降级为灰字（确认时会收到 400）
function updTaskLine(c) {
  const title = c.existingTaskId ? taskTitles.get(c.existingTaskId) : null;
  if (title) {
    return `<div class="upd-task-line">${icon('kanban')}<a class="link" data-act="open-task" data-task="${esc(c.existingTaskId)}" href="#/board"
      title="跳转任务看板并高亮该任务">关联任务「${esc(title)}」</a></div>`;
  }
  return `<div class="upd-task-line muted" title="关联任务已删除或不存在">${icon('kanban')}<span>关联任务已删除（确认将提示无法记入）</span></div>`;
}

// 候选卡两卡型：kind 缺省按 task；update（任务更新提案）不建任务、确认后记入关联任务时间轴，
// 故不渲染「已完成」按钮，也不展示负责人/优先级/日期（更新提案不带这些字段）
function candCard(c, idx) {
  const isUpd = c.kind === 'update';
  if (isUpd) {
    // 更新提案卡主标题 = 关联任务标题（update 候选无自身 title，空标题卡会让业主误判为坏卡——真实反馈修复）
    const linkedTitle = c.existingTaskId ? taskTitles.get(c.existingTaskId) : null;
    const cardTitle = linkedTitle ? `更新「${linkedTitle}」` : (c.title || '任务更新提案');
    return `
    <div class="cand cand-upd" data-id="${esc(c.id)}" style="--i:${idx}">
      <div class="cand-h">
        <input type="checkbox" data-act="check-cand" data-id="${esc(c.id)}" aria-label="选中 ${esc(cardTitle)}"${checkedCand.has(c.id) ? ' checked' : ''}>
        <div class="cand-title" title="${esc(cardTitle)}">${esc(cardTitle)}</div>
        <span class="badge b-upd" title="任务更新提案：不新建任务，确认后作为「纪要提及」记入关联任务时间轴">${icon('file-text')}任务更新</span>
        ${confBadge(c)}
      </div>
      ${c.note ? `<div class="cand-desc">${esc(c.note)}</div>` : ''}
      ${updTaskLine(c)}
      ${c.quote ? `<div class="radar-quote" title="候选引用原文">“${esc(c.quote)}”</div>` : ''}
      <div class="cand-meta muted small">
        <span title="${esc(fmtFull(c.createdAt))}">${fmtAgo(c.createdAt)}由 AI 提议${c.createdAt ? ' · 创建于 ' + esc(fmtFull(c.createdAt)) : ''}</span>
        · 来自 <span class="link" data-act="open-msg" data-id="${esc(c.messageId)}">${esc(c.messageTitle || c.messageId)}</span>
      </div>
      <div class="cand-actions">
        <button type="button" class="btn xs" data-act="confirm" data-id="${esc(c.id)}">${icon('check')}确认更新</button>
        <span class="spacer"></span>
        <button type="button" class="btn danger xs" data-act="reject" data-id="${esc(c.id)}">${icon('ban')}拒绝</button>
      </div>
    </div>`;
  }
  const mem = members.find((m) => m.id === c.suggestedMemberId);
  const memberChip = mem
    ? `<span class="badge b-ro member-tag">${icon('user')}${esc(mem.name)}</span>`
    : (c.suggestedMemberId ? `<span class="badge b-ro">${esc(c.suggestedMemberId)}</span>` : '<span class="badge b-dead">未归人</span>');
  const prio = { high: '<span class="badge prio-high">高</span>', medium: '<span class="badge prio-med">中</span>', low: '<span class="badge prio-low">低</span>' }[c.priority] || '';
  return `
    <div class="cand" data-id="${esc(c.id)}" style="--i:${idx}">
      <div class="cand-h">
        <input type="checkbox" data-act="check-cand" data-id="${esc(c.id)}" aria-label="选中 ${esc(c.title)}"${checkedCand.has(c.id) ? ' checked' : ''}>
        <div class="cand-title" title="${esc(c.title)}">${esc(c.title)}</div>
        ${confBadge(c)}${prio}${memberChip}
        ${c.dueHint ? `<span class="badge b-branch" title="原文日期词（不自动换算为日期）">${esc(c.dueHint)}</span>` : ''}
      </div>
      ${c.desc ? `<div class="cand-desc">${esc(c.desc)}</div>` : ''}
      ${c.rationale ? `<div class="cand-why muted small" title="${esc(c.rationale)}">${icon('zap')}${esc(c.rationale)}</div>` : ''}
      <div class="cand-meta muted small">
        <span title="${esc(fmtFull(c.createdAt))}">${fmtAgo(c.createdAt)}由 AI 提议${c.createdAt ? ' · 创建于 ' + esc(fmtFull(c.createdAt)) : ''}</span>
        · 来自 <span class="link" data-act="open-msg" data-id="${esc(c.messageId)}">${esc(c.messageTitle || c.messageId)}</span>
      </div>
      ${c.quote ? `
      <div class="fold">
        <button type="button" class="fold-toggle" aria-expanded="false">${icon('chevron-down')}<span>原文引用</span></button>
        <div class="fold-body" hidden><div class="radar-quote">“${esc(c.quote)}”</div>
          ${c.speakerRaw ? `<div class="muted small">— ${esc(c.speakerRaw)}</div>` : ''}</div>
      </div>` : ''}
      <div class="cand-actions">
        <button type="button" class="btn xs" data-act="confirm" data-id="${esc(c.id)}">${icon('check')}确认入库</button>
        <button type="button" class="btn ghost xs" data-act="done" data-id="${esc(c.id)}" title="这事已经做完了：计入统计，不会入看板">${icon('check-circle')}已完成</button>
        <span class="spacer"></span>
        <button type="button" class="btn danger xs" data-act="reject" data-id="${esc(c.id)}">${icon('ban')}拒绝</button>
      </div>
    </div>`;
}

  // 折叠状态：模块 Set + localStorage（fde-radar-folded-groups）跨刷新记忆；
  // key = 会议标题（与分组 key 同源），drawInbox 渲染时剪除已不存在的 key
  function groupKey(c) {
    return c.messageTitle || c.messageId || '未命名会议';
  }
  function loadFoldedGroups() {
    if (foldedGroups == null) {
      foldedGroups = new Set();
      try {
        const arr = JSON.parse(localStorage.getItem('fde-radar-folded-groups') || '[]');
        if (Array.isArray(arr)) arr.forEach((k) => foldedGroups.add(String(k)));
      } catch (e) { /* 存储不可用则仅会话内记忆 */ }
    }
    return foldedGroups;
  }
  function saveFoldedGroups() {
    try { localStorage.setItem('fde-radar-folded-groups', JSON.stringify([...loadFoldedGroups()])); } catch (e) { /* 同上 */ }
  }
  // v2.9.9 收件箱按会议标题分组：组 = messageTitle（缺失降级 messageId/未命名会议），
  // 组序按组内最新候选倒序，组内按创建时间倒序；组头带条数与最近提议时间
  function inboxGroupsHtml() {
    const groups = [];
    const byKey = new Map();
    for (const c of candidates) {
      const key = groupKey(c);
      if (!byKey.has(key)) {
        const g = { key, items: [], latest: '', earliest: '' };
        byKey.set(key, g);
        groups.push(g);
      }
      const g = byKey.get(key);
      g.items.push(c);
      if (!g.latest || Date.parse(c.createdAt) > Date.parse(g.latest)) g.latest = c.createdAt;
      if (!g.earliest || Date.parse(c.createdAt) < Date.parse(g.earliest)) g.earliest = c.createdAt;
    }
    groups.sort((a, b) => Date.parse(b.latest || 0) - Date.parse(a.latest || 0));
    let idx = 0;
    return groups.map((g) => {
      const items = g.items.slice().sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
      const folded = loadFoldedGroups().has(g.key);
      return `<div class="cand-group">
        <div class="cand-group-h" role="button" tabindex="0" aria-expanded="${!folded}"
          data-act="toggle-group" data-group="${esc(g.key)}" title="${folded ? '展开该组' : '折叠该组'}">
          <span class="fold-chevron${folded ? '' : ' open'}">${icon('chevron-down')}</span>
          <span class="cand-group-title" title="${esc(g.key)}">${esc(g.key)}</span>
          <span class="badge b-ro">${g.items.length} 条</span>
          <span class="muted small" title="组内最新候选：${esc(fmtFull(g.latest))}">最近 ${fmtAgo(g.latest)}</span>
          ${g.earliest ? `<span class="muted small" title="组内最早候选：${esc(fmtFull(g.earliest))}">创建于 ${esc(fmtFull(g.earliest))}</span>` : ''}
        </div>
        <div class="cand-group-body"${folded ? ' hidden' : ''}>${items.map((c) => candCard(c, idx++)).join('')}</div>
      </div>`;
    }).join('');
  }

  function drawInbox() {
  const root = rootEl;
  if (!root) return;
  const box = root.querySelector('#radar-inbox');
  const n = [...checkedCand].filter((id) => candidates.some((c) => c.id === id)).length;
  const rate = stats.rejectRate30d;
  // v2.9.12 合并入库：勾选中可参与合并的候选（排除 update 提案——语义是记入既有任务）
  const mergeList = candidates.filter((c) => checkedCand.has(c.id) && c.kind !== 'update');
  const mergeN = mergeList.length;
  const groupKeys = [...new Set(candidates.map(groupKey))];
  const foldedSet = loadFoldedGroups();
  const allFolded = groupKeys.length > 0 && groupKeys.every((k) => foldedSet.has(k));
  // v2.1-D 收件箱全选：勾全部待确认候选
  const allIds = candidates.map((c) => c.id);
  const allChecked = allIds.length > 0 && allIds.every((id) => checkedCand.has(id));
  const someChecked = allIds.some((id) => checkedCand.has(id));
  box.innerHTML = `
    <div class="panelbox">
      <h4 class="panel-title"><span>收件箱</span>
        <span class="badge ${rate != null && rate > 0.5 ? 'st-danger' : 'st-idle'}" title="v1.7 口径：近 30 天 rejected/(confirmed+doneAlready+rejected)——误识率仪表，一个月后据此决定是否放开高置信度自动入库">误识率 ${rate == null ? '暂无数据' : Math.round(rate * 100) + '%'}</span>
        ${groupKeys.length > 1 ? `<button type="button" class="btn ghost xs" id="cand-fold-all">${icon('chevron-down')}${allFolded ? '全部展开' : '全部折叠'}</button>` : ''}
        <label class="cand-all muted small"><input type="checkbox" data-act="check-cand-all" aria-label="全选候选"${allChecked ? ' checked' : ''}>全选</label>
        <span class="spacer"></span>
        <button type="button" class="btn danger xs" id="cand-reject-all" ${n === 0 ? 'disabled' : ''}>${icon('ban')}拒绝所选${n ? `（${n}）` : ''}</button>
        <button type="button" class="btn xs" id="cand-confirm-all" ${n === 0 ? 'disabled' : ''}>${icon('check')}按建议入库所选${n ? `（${n}）` : ''}</button>
        <button type="button" class="btn ghost xs" id="cand-merge" ${mergeN < 2 ? 'disabled' : ''} title="把勾选的多条候选合并为一个人工命名的新任务">${icon('kanban')}合并入库${mergeN >= 2 ? `（${mergeN}）` : ''}</button>
      </h4>
      <div class="cand-flow">${inboxGroupsHtml() ||
        `<div class="empty-state">${icon('inbox')}<span>收件箱是空的——到纪要池选中听记点「分析所选」</span></div>`}</div>
    </div>`;
  const allCb = box.querySelector('input[data-act=check-cand-all]');
  if (allCb) allCb.indeterminate = !allChecked && someChecked;

  // 折叠剪枝：只保留当前仍在列的分组 key（会议删除/过滤后不积攒）
  if (foldedSet.size) {
    const alive = new Set(groupKeys);
    for (const k of [...foldedSet]) if (!alive.has(k)) foldedSet.delete(k);
  }
  const foldAllBtn = box.querySelector('#cand-fold-all');
  if (foldAllBtn) foldAllBtn.addEventListener('click', () => {
    if (allFolded) groupKeys.forEach((k) => foldedSet.delete(k));
    else groupKeys.forEach((k) => foldedSet.add(k));
    saveFoldedGroups();
    drawInbox();
  });
  box.querySelector('#cand-confirm-all').addEventListener('click', () => batchConfirm());
  box.querySelector('#cand-reject-all').addEventListener('click', () => batchReject());
  box.querySelector('#cand-merge').addEventListener('click', () => openMergeModal(mergeList));
  // 组头键盘可达：Enter/Space 等价点击
  box.onkeydown = (e) => {
    const grp = e.target.closest && e.target.closest('[data-act=toggle-group]');
    if (grp && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      grp.click();
    }
  };
  box.onclick = async (e) => {
    const grp = e.target.closest('[data-act=toggle-group]');
    if (grp) {
      const set = loadFoldedGroups();
      const k = grp.dataset.group;
      if (set.has(k)) set.delete(k); else set.add(k);
      saveFoldedGroups();
      drawInbox();
      return;
    }
    const link = e.target.closest('[data-act=open-msg]');
    if (link) {
      const m = messages.find((x) => x.id === link.dataset.id);
      if (m) openMessageDetail(m);
      return;
    }
    // 叙事线第一批：update 候选的关联任务链接 → 看板高亮（复用动态流「匹配任务」同一挂起态）
    const taskLink = e.target.closest('[data-act=open-task]');
    if (taskLink) {
      e.preventDefault();
      state.pendingTaskFocus = taskLink.dataset.task;
      if (location.hash !== '#/board') location.hash = '#/board';
      return;
    }
    const fold = e.target.closest('.fold-toggle');
    if (fold) {
      const body = fold.parentElement.querySelector('.fold-body');
      body.hidden = !body.hidden;
      fold.classList.toggle('open', !body.hidden);
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const c = candidates.find((x) => x.id === btn.dataset.id);
    if (!c) return;
    if (btn.dataset.act === 'confirm') {
      if (c.kind === 'update') openUpdateConfirmModal(c); // 更新提案：精简弹层，只写备注
      else openConfirmModal(c);
    }
    else if (btn.dataset.act === 'done') {
      // v1.7 三动作之一：这事已经做完了 → 确认后 POST done-already，候选转 done_already 不入看板
      const ok = await confirmModal(`将把「${c.title}」标记为已完成。该候选不会入看板，但计入误识率分母。`, { title: '标记为已完成？该候选不会入看板', okText: '标记为已完成' });
      if (!ok) return;
      try {
        await apiPost(`/api/inbox/${encodeURIComponent(c.id)}/done-already`, {});
        toast(`已标记「${c.title}」为已完成`, 'success');
        await refresh();
      } catch (err) { toast(err.message); }
    }
    else if (btn.dataset.act === 'reject') openRejectModal([c]);
  };
  box.onchange = (e) => {
    const all = e.target.closest('input[data-act=check-cand-all]');
    if (all) {
      if (all.checked) allIds.forEach((id) => checkedCand.add(id));
      else allIds.forEach((id) => checkedCand.delete(id));
      drawInbox();
      return;
    }
    const cb = e.target.closest('input[data-act=check-cand]');
    if (!cb) return;
    if (cb.checked) checkedCand.add(cb.dataset.id); else checkedCand.delete(cb.dataset.id);
    drawInbox();
  };
}

// 叙事线第一批：update 候选确认弹层——精简版（无负责人/优先级/日期/说话人映射行，只有备注）；
// 确认 = POST confirm{note} → 不建任务，服务端把「纪要提及」写进关联任务时间轴；
// 关联任务已删除时服务端 400 TASK_NOT_FOUND，错误直出弹层可改后重试
function openUpdateConfirmModal(c) {
  const knownTitle = c.existingTaskId ? taskTitles.get(c.existingTaskId) : null;
  const box = document.createElement('div');
  box.innerHTML = `
    <form id="cand-upd-form">
      <p class="confirm-msg">这是任务更新提案：不会新建任务，确认后作为「纪要提及」记入关联任务的时间轴。</p>
      <div class="form-row"><label>关联任务</label>
        ${knownTitle
          ? `<div class="upd-modal-task">${icon('kanban')}「${esc(knownTitle)}」</div>`
          : `<div class="upd-modal-task muted" title="服务端将拒绝：关联任务不存在">${icon('kanban')}已删除或不存在（${esc(c.existingTaskId || '无')}）</div>`}
      </div>
      ${c.quote ? `<div class="radar-quote">“${esc(c.quote)}”</div>` : ''}
      <div class="form-row"><label>更新备注（可选，≤500 字，随「纪要提及」一起入时间轴）</label>
        <textarea name="note" rows="3" maxlength="500" placeholder="补充说明，如：验收标准有新增">${esc(c.note || '')}</textarea>
        <div class="char-count" id="upd-note-count" aria-live="polite"></div></div>
      <div class="form-err" id="upd-form-err"></div>
      <div class="modal-actions">
        <span class="muted small">${confBadge(c)}</span>
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="submit" class="btn">${icon('check')}记入时间轴</button>
      </div>
    </form>`;
  const m = openModal({ title: '确认任务更新', body: box });
  const errEl = box.querySelector('#upd-form-err');
  box.querySelector('[data-act=cancel]').addEventListener('click', m.close);
  const noteEl = box.querySelector('[name=note]');
  const countEl = box.querySelector('#upd-note-count');
  const syncCount = () => {
    countEl.textContent = `${noteEl.value.length} / 500`;
    countEl.classList.toggle('over', noteEl.value.length > 500);
  };
  noteEl.addEventListener('input', syncCount);
  syncCount();
  const updSubmitBtn = box.querySelector('#cand-upd-form button[type=submit]');
  box.querySelector('#cand-upd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.classList.remove('show');
    // v2.1-E：提交进 busy-lock，await 期间双击/回车只发一次请求，失败后按钮恢复可重试
    await busyBtn(updSubmitBtn, async () => {
      try {
        const resp = await apiPost(`/api/inbox/${encodeURIComponent(c.id)}/confirm`, { note: noteEl.value.trim() });
        m.close();
        // 成功文案落在关联任务上：resp.task 为服务端回传的最新任务
        const tTitle = (resp && resp.task && resp.task.title) || (c.existingTaskId && taskTitles.get(c.existingTaskId)) || c.existingTaskId || '';
        toast(`已记入任务《${tTitle}》的时间轴`, 'success');
        await refresh();
      } catch (err) {
        errEl.textContent = `${err.code || 'ERROR'}: ${err.message}`;
        errEl.classList.add('show');
      }
    });
  });
}

// 确认入库弹层：标题/描述/负责人/优先级可编辑，dueHint 原文词 + 日期选择器；
// v1.8 说话人/负责人解耦：「谁说的」（说话人行）与「谁做」（负责成员）各自独立选人，
// 记住映射只把 speakerRaw 挂到说话人身份（speakerMemberId），不再跟随负责成员
function openConfirmModal(c) {
  const humanOpts = members.map((m) =>
    `<option value="${esc(m.id)}"${m.id === c.suggestedMemberId ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  const known = members.some((m) => m.id === c.suggestedMemberId);
  const prio = ['high', 'medium', 'low'].includes(c.priority) ? c.priority : 'medium';
  // P1-A：匹配依据可见化（后端 matchSource: alias|name|gitea）。名册命中 → 绿点一行小字；
  // 名册外（gitea 派生/未归人）→ amber 引导，不再静默降级
  const src = c.matchSource;
  const matched = known && src !== 'gitea';
  const matchHint = matched
    ? `<div class="match-hint ok"><span class="mdot"></span>按名册${src === 'name' ? '姓名' : src === 'alias' ? '别名' : ''}匹配</div>`
    : `<div class="match-hint warn"><span class="mdot"></span>未归人：从下拉选人，确认时可勾「记住映射」自动建档</div>`;
  // v1.8 说话人预选：AI 已把说话人归到名册某人（matchSource 存在且成员在名册可选）→ 预选该成员（用户可改）；
  // 否则默认「暂不映射」——负责人下拉的值不自动带过来（负责人是做事的人，不默认等于说话人）
  const speakerPre = (src && known) ? c.suggestedMemberId : '';
  const speakerOpts = members.map((m) =>
    `<option value="${esc(m.id)}"${m.id === speakerPre ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  const box = document.createElement('div');
  box.innerHTML = `
    <form id="cand-form">
      <div class="form-row"><label class="req">标题</label>
        <input name="title" maxlength="200" required value="${esc(c.title)}"></div>
      <div class="form-row"><label>描述</label>
        <textarea name="desc" rows="3" maxlength="2000">${esc(c.desc || '')}</textarea></div>
      ${matchHint}
      ${c.speakerRaw ? `
      <div class="form-row"><label>说话人（这句话是谁说的，与负责成员相互独立）</label>
        <span class="spk-line">
          <span class="spk-raw" title="说话人原始昵称（来自听记转写）">${icon('mic')}${esc(c.speakerRaw)}</span>
          <span class="muted small">TA 是谁？</span>
          <select name="speakerMemberId" aria-label="说话人对应的名册成员">
            <option value=""${speakerPre ? '' : ' selected'}>（暂不映射）</option>
            ${speakerOpts}
          </select>
        </span></div>
      <div class="form-row"><label>记住说话人映射</label>
        <span class="switch-line">
          <button type="button" class="switch off" id="cand-remember" aria-pressed="false" aria-label="记住说话人映射开关" disabled
            title="先选择说话人对应的名册成员"></button>
          <span class="muted small">记住：该说话人 = 所选成员，下条同说话人自动归人</span>
        </span></div>` : ''}
      <div class="form-row"><label>负责成员（AI 建议${known && matched ? '已预填' : known ? '：名册外成员' : '：未能归人'}）</label>
        <select name="memberId"><option value="">（未分配）</option>${humanOpts}${c.suggestedMemberId && !known ? `<option value="${esc(c.suggestedMemberId)}" selected>${esc(c.suggestedMemberId)}（当前建议，已不可选）</option>` : ''}</select></div>
      <div class="form-row"><label>优先级</label>
        <select name="priority">
          <option value="high"${prio === 'high' ? ' selected' : ''}>高</option>
          <option value="medium"${prio === 'medium' ? ' selected' : ''}>中</option>
          <option value="low"${prio === 'low' ? ' selected' : ''}>低</option>
        </select></div>
      <div class="form-row"><label>截止日期（AI 从原文提取的日期词：${c.dueHint ? `“${esc(c.dueHint)}”` : '无'}）</label>
        <input type="date" name="dueDate">
        <div class="hint">原文词不自动换算，需要具体日期时在此选择</div></div>
      <div class="form-err" id="cand-form-err"></div>
      <div class="modal-actions">
        <span class="muted small">${confBadge(c)}</span>
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="submit" class="btn">${icon('check')}确认入库</button>
      </div>
    </form>`;
  const m = openModal({ title: '确认入库', body: box });
  const errEl = box.querySelector('#cand-form-err');
  box.querySelector('[data-act=cancel]').addEventListener('click', m.close);
  const spkSel = box.querySelector('[name=speakerMemberId]');
  const sw = box.querySelector('#cand-remember');
  // 勾选映射必须先选说话人：未选 → 开关禁用（并复位），选中 → 可勾
  const syncRemember = () => {
    if (!sw) return;
    const has = !!(spkSel && spkSel.value);
    sw.disabled = !has;
    sw.title = has ? '记住该说话人与名册成员的对应关系，下条同说话人自动归人' : '先选择说话人对应的名册成员';
    if (!has) {
      sw.setAttribute('aria-pressed', 'false');
      sw.classList.add('off');
    }
  };
  if (sw) {
    sw.addEventListener('click', () => {
      if (sw.disabled) return;
      const on = sw.getAttribute('aria-pressed') !== 'true';
      sw.setAttribute('aria-pressed', String(on));
      sw.classList.toggle('off', !on);
    });
    if (spkSel) spkSel.addEventListener('change', syncRemember);
    syncRemember();
  }
  const candSubmitBtn = box.querySelector('#cand-form button[type=submit]');
  box.querySelector('#cand-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const val = (n) => f.elements.namedItem(n).value;
    errEl.classList.remove('show');
    // v2.1-E：提交进 busy-lock，await 期间双击/回车只发一次请求，失败后按钮恢复可重试
    await busyBtn(candSubmitBtn, async () => {
      try {
        const resp = await apiPost(`/api/inbox/${encodeURIComponent(c.id)}/confirm`, {
          title: val('title').trim(),
          desc: val('desc'),
          memberId: val('memberId') || null,
          speakerMemberId: spkSel ? (spkSel.value || null) : null, // 说话人的名册身份，null=不映射
          priority: val('priority'),
          dueDate: val('dueDate') || null,
          rememberAlias: sw ? sw.getAttribute('aria-pressed') === 'true' : false
        });
        m.close();
        // v1.8 别名 toast 只跟随说话人映射结果（rememberedAlias 落点为说话人，非负责成员）；
        // 说话人未映射（rememberedAlias:null + reason:SPEAKER_UNRESOLVED）→ 轻提示，不弹成功别名 toast
        const ra = resp && resp.rememberedAlias;
        if (ra && ra.memberCreated) {
          // P1-C：后端为名册外说话人自动建档时，明确告知而非静默
          const memName = (members.find((x) => x.id === ra.memberId) || {}).name || ra.memberId || '';
          toast(`已为「${memName}」自动建立名册档案并记住别名`, 'success');
        } else if (ra && ra.alias) {
          const memName = (members.find((x) => x.id === ra.memberId) || {}).name || ra.memberId || '';
          toast(`已记住：「${c.speakerRaw}」→ ${memName}，下条同说话人自动归人`, 'success');
        } else if (resp && resp.reason === 'SPEAKER_UNRESOLVED') {
          toast('说话人未映射，未记录别名', 'info');
        } else {
          toast('任务已入库，看板可见（带溯源引用）', 'success');
        }
        await refresh();
      } catch (err) {
        errEl.textContent = `${err.code || 'ERROR'}: ${err.message}`;
        errEl.classList.add('show');
      }
    });
  });
}

async function batchConfirm() {
  const ids = [...checkedCand].filter((id) => candidates.some((c) => c.id === id));
  if (!ids.length) return;
  // 叙事线第一批：批量里混有任务更新提案时如实说明（更新不建任务，直接记入关联任务时间轴）
  const list = ids.map((id) => candidates.find((c) => c.id === id)).filter(Boolean);
  const ok = await openBatchConfirmModal(list); // v2.1-D：二次核对带所选清单，不再只报数量
  if (!ok) return;
  let done = 0;
  const failures = [];
  for (const c of list) {
    try {
      await apiPost(`/api/inbox/${encodeURIComponent(c.id)}/confirm`, {});
      done += 1;
    } catch (e) {
      failures.push({ title: batchItemTitle(c), message: e.message });
    }
  }
  checkedCand = new Set();
  // v2.1-D/W12：取消逐条 error toast，末条汇总一条（成功 N/共 M，失败 X + 明细）
  if (!failures.length) {
    toast(`成功 ${done}/共 ${list.length}，已按建议入库`, 'success');
  } else {
    toast(`成功 ${done}/共 ${list.length}，失败 ${failures.length}：${failures.map((f) => `「${f.title}」${f.message}`).join('；')}`, 'error');
  }
  await refresh();
}

// 批量清单/失败明细里的候选展示标题：update 候选无自身业务标题，落到关联任务口径
// v2.9.12 合并入库弹层：多条候选 → 一个人工命名的新任务。标题/描述全人工填（不做
// 智能拼装），候选只读预览；确认 = POST /api/inbox/confirm-merged（服务端原子建任务
// + 候选全部转 merged + 各自 memo 引用记入时间轴）
function openMergeModal(list) {
  const sorted = list.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const humanOpts = members.map((m) =>
    `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  const box = document.createElement('div');
  box.innerHTML = `
    <form id="cand-merge-form">
      <p class="confirm-msg">把勾选的 ${list.length} 条候选合并为一个人工命名的新任务：各条候选将以「纪要引用」记入该任务的时间轴（原文可溯），任务标题与描述由你填写。</p>
      <div class="form-row"><label class="req">任务标题（人工填写）</label>
        <input name="title" maxlength="200" required placeholder="合并后的任务标题"></div>
      <div class="form-row"><label>任务描述（可选）</label>
        <textarea name="desc" rows="3" maxlength="2000" placeholder="合并说明或任务背景（可空）"></textarea></div>
      <div class="form-row"><label>负责成员</label>
        <select name="memberId"><option value="">（未分配）</option>${humanOpts}</select></div>
      <div class="form-row"><label>优先级</label>
        <select name="priority">
          <option value="medium" selected>中</option>
          <option value="high">高</option>
          <option value="low">低</option>
        </select></div>
      <div class="form-row"><label>截止日期</label>
        <input type="date" name="dueDate"></div>
      <div class="fold"><button type="button" class="fold-toggle" aria-expanded="false">${icon('chevron-down')}<span>并入的候选（${list.length}）</span></button>
        <div class="fold-body" hidden>${sorted.map((c) => `<div class="radar-quote">${confBadge(c)}「${esc(c.title)}」<span class="muted small">· ${esc(fmtFull(c.createdAt))}</span></div>`).join('')}</div></div>
      <div class="form-err" id="merge-form-err"></div>
      <div class="modal-actions">
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="submit" class="btn">${icon('check')}合并入库</button>
      </div>
    </form>`;
  const m = openModal({ title: '合并入库', body: box });
  const errEl = box.querySelector('#merge-form-err');
  box.querySelector('[data-act=cancel]').addEventListener('click', m.close);
  const foldBtn = box.querySelector('.fold-toggle');
  foldBtn.addEventListener('click', () => {
    const foldBody = foldBtn.parentElement.querySelector('.fold-body');
    foldBody.hidden = !foldBody.hidden;
    foldBtn.classList.toggle('open', !foldBody.hidden);
  });
  const mergeSubmitBtn = box.querySelector('#cand-merge-form button[type=submit]');
  box.querySelector('#cand-merge-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const val = (n) => f.elements.namedItem(n).value;
    const title = val('title').trim();
    if (!title) {
      errEl.textContent = '任务标题必填（合并后的任务由人工命名）';
      errEl.classList.add('show');
      return;
    }
    errEl.classList.remove('show');
    await busyBtn(mergeSubmitBtn, async () => {
      try {
        const resp = await apiPost('/api/inbox/confirm-merged', {
          ids: sorted.map((c) => c.id),
          title,
          desc: val('desc'),
          memberId: val('memberId') || null,
          priority: val('priority'),
          dueDate: val('dueDate') || null,
        });
        m.close();
        toast(`已合并 ${list.length} 条候选为任务「${(resp.task && resp.task.title) || title}」`, 'success');
        for (const c of list) checkedCand.delete(c.id);
        await refresh();
      } catch (err) {
        errEl.textContent = `${err.code || 'ERROR'}: ${err.message}`;
        errEl.classList.add('show');
      }
    });
  });
}

function batchItemTitle(c) {
  if (c.kind === 'update') {
    const t = c.existingTaskId ? taskTitles.get(c.existingTaskId) : null;
    return t ? `更新「${t}」` : (c.title || '任务更新提案');
  }
  return c.title || c.id;
}

// v2.1-D：批量确认弹层列出所选清单（标题+建议负责人+优先级；update 提案带「任务更新」标），
// 清单区可滚动（max-height），确认按钮带数量
function openBatchConfirmModal(list) {
  return new Promise((resolve) => {
    const nUpd = list.filter((c) => c.kind === 'update').length;
    const updNote = nUpd ? `其中 ${nUpd} 条任务更新提案将记入各自关联任务的时间轴（不建任务）。` : '';
    const rows = list.map((c) => {
      const isUpd = c.kind === 'update';
      const title = isUpd ? batchItemTitle(c) : (c.title || c.id);
      const mem = isUpd ? null : members.find((m) => m.id === c.suggestedMemberId);
      const who = isUpd ? '—' : (mem ? mem.name : (c.suggestedMemberId || '未归人'));
      const prioKey = isUpd ? '' : (['high', 'medium', 'low'].includes(c.priority) ? c.priority : '');
      const prioCls = { high: 'prio-high', medium: 'prio-med', low: 'prio-low' }[prioKey] || 'b-dead';
      const prioLabel = { high: '高', medium: '中', low: '低' }[prioKey] || '—';
      return `
        <div class="bc-item">
          <span class="bc-title" title="${esc(title)}">${isUpd ? '<span class="badge b-upd" title="任务更新提案：不建任务，记入关联任务时间轴">任务更新</span>' : ''}<span class="bc-title-text">${esc(title)}</span></span>
          <span class="bc-who muted" title="建议负责人">${icon('user')}${esc(who)}</span>
          <span class="badge ${prioCls}" title="优先级">${esc(prioLabel)}</span>
        </div>`;
    }).join('');
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="confirm-msg">按 AI 建议原样入库以下 ${list.length} 张候选卡（负责人取建议值，不记住映射）。${esc(updNote)}</p>
      <div class="bc-list">${rows}</div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="button" class="btn" data-act="ok">${icon('check')}入库（${list.length}）</button>
      </div>`;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      m.close(); // 会触发 onClose → finish(false)，由 done 标志保证结果不被覆盖
    };
    const m = openModal({ title: '批量确认入库', body: box, onClose: () => finish(false) });
    box.querySelector('[data-act=cancel]').addEventListener('click', () => finish(false));
    box.querySelector('[data-act=ok]').addEventListener('click', (e) => {
      // v2.1-E：确认瞬间进 busy-lock——关闭动效期间的双击不会再触发第二次入库流程
      busyBtn(e.currentTarget, async () => finish(true));
    });
  });
}

// ---- v1.7 拒绝弹层：原因必选 + 备注≤500（单卡与批量共用，批量一次选因逐张提交） ----
const REJECT_REASONS = [
  { v: 'duplicate', label: '重复提议' },
  { v: 'wont_do', label: '不做' },
  { v: 'invalid', label: '无效识别' },
  { v: 'other', label: '其他' }
];

function openRejectModal(list, { onDone = null } = {}) {
  const cands = (list || []).filter(Boolean);
  if (!cands.length) return;
  const single = cands.length === 1;
  const box = document.createElement('div');
  box.innerHTML = `
    <form id="cand-reject-form">
      <p class="confirm-msg">${single
        ? `将拒绝「${esc(cands[0].title)}」，计入误识率统计且不再出现在待确认列表。`
        : `将拒绝所选 ${cands.length} 张候选卡，计入误识率统计且不再出现在待确认列表。`}</p>
      <div class="form-row"><label class="req">拒绝原因</label>
        <select name="reason" aria-label="拒绝原因（必选）">
          <option value="" selected disabled>请选择拒绝原因（必选）</option>
          ${REJECT_REASONS.map((r) => `<option value="${r.v}">${r.label}</option>`).join('')}
        </select></div>
      <div class="form-row"><label>备注（可选，≤500 字）</label>
        <textarea name="note" rows="3" maxlength="500" placeholder="补充说明，如：与看板已有任务重复"></textarea>
        <div class="char-count" id="rej-note-count" aria-live="polite"></div></div>
      <div class="form-err" id="rej-form-err"></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="submit" class="btn danger">${icon('ban')}${single ? '拒绝' : `拒绝（${cands.length}）`}</button>
      </div>
    </form>`;
  const m = openModal({ title: single ? '拒绝候选任务' : '批量拒绝', body: box });
  const errEl = box.querySelector('#rej-form-err');
  const showErr = (msg) => { errEl.textContent = msg; errEl.classList.add('show'); };
  box.querySelector('[data-act=cancel]').addEventListener('click', m.close);
  const noteEl = box.querySelector('[name=note]');
  const countEl = box.querySelector('#rej-note-count');
  noteEl.addEventListener('input', () => {
    countEl.textContent = `${noteEl.value.length} / 500`;
    countEl.classList.toggle('over', noteEl.value.length > 500);
  });
  const submitBtn = box.querySelector('#cand-reject-form button[type=submit]');
  box.querySelector('#cand-reject-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.classList.remove('show');
    const f = e.target;
    const reason = f.elements.namedItem('reason').value;
    if (!reason) { showErr('请选择拒绝原因（必选）'); return; } // 前端拦截：未选原因不发请求
    const note = noteEl.value.trim();
    if (note.length > 500) { showErr(`备注不能超过 500 字（当前 ${note.length} 字）`); return; }
    // v2.1-E：提交进 busy-lock，双击/回车重复提交只发一轮请求
    await busyBtn(submitBtn, async () => {
      const failures = [];
      let done = 0;
      for (const c of cands) {
        try {
          await apiPost(`/api/inbox/${encodeURIComponent(c.id)}/reject`, { reason, note: note || undefined });
          done += 1;
        } catch (err) {
          failures.push({ c, err });
        }
      }
      if (!failures.length) {
        m.close();
        if (onDone) { try { onDone(); } catch { /* 回调异常不阻断 */ } }
        toast(single ? `已拒绝「${cands[0].title}」` : `成功 ${done}/共 ${cands.length}，全部拒绝`, 'success');
        await refresh();
        return;
      }
      if (single) {
        // 服务端校验兜底：400 REASON_REQUIRED 等文案直出，弹层不关可改后重试
        const err = failures[0].err;
        showErr(`${err.code ? `${err.code}: ` : ''}${err.message}`);
        return;
      }
      // v2.1-D/W12：批量部分失败不再逐条 toast——弹层关闭，末条汇总（成功 N/共 M，失败 X + 明细）
      m.close();
      if (onDone) { try { onDone(); } catch { /* 回调异常不阻断 */ } }
      const detail = failures.map((x) => `「${x.c.title || x.c.id}」${x.err.message}`).join('；');
      toast(`成功 ${done}/共 ${cands.length}，失败 ${failures.length}：${detail}`, 'error');
      await refresh();
    });
  });
}

async function batchReject() {
  const ids = [...checkedCand].filter((id) => candidates.some((c) => c.id === id));
  if (!ids.length) return;
  // v1.7 契约：reject 必带 reason → 批量改为先在弹层选一次原因，再逐张提交（原 confirmModal 直拒会被 400 拒掉）
  const list = ids.map((id) => candidates.find((c) => c.id === id)).filter(Boolean);
  openRejectModal(list, { onDone: () => { checkedCand = new Set(); } });
}

// ---------------- 异步 job：同步 / 分析（v2.1-A 单飞与反馈修复） ----------------

// 触发点守卫统一走 claimJob/runAnalyzeJob：
// 1) POST await 之前同步占位认领 activeJob（消除 POST RTT 窗口内的二击双 POST）；
// 2) accepted===0 / catch / pollJob 终态 / 视图销毁全出口都释放，恢复逻辑收敛在 syncJobControls；
// 3) sync 与 analyze 共享 activeJob 天然互斥：任一在跑，另一方的触发点全部禁用。
// kind: 'sync'（钉钉）/ 'sync-feishu'（飞书妙记）——同一 job 互斥管线，按钮文案由各自触发点表达
async function startSync(kind) {
  if (!claimJob('sync')) return;
  try {
    const r = await apiPost(kind === 'sync-feishu' ? '/api/radar/sync/feishu' : '/api/radar/sync', {});
    activeJob = { id: r.jobId, kind }; // 回填 jobId（认领仍是同一份，不重新抢）
    await pollJob(r.jobId, kind);
  } catch (e) {
    releaseJob();
    toast(e.message);
  }
}

// v2.9.28 粘贴转写：任意文本（会议记录/纪要/长文）→ 合成消息入池 → 自动触发既有分析 job。
// 零钉钉依赖——开源用户的转写入口
function openTextInput() {
  const box = document.createElement('div');
  box.innerHTML = `
    <form id="rt-form">
      <div class="form-row"><label class="req">标题</label>
        <input name="title" required maxlength="200" placeholder="如：周三生产看板需求讨论"></div>
      <div class="form-row"><label class="req">转写正文（≥10 字）</label>
        <textarea name="text" rows="10" required style="width:100%" placeholder="粘贴会议记录 / 纪要 / 任意需要拆解任务的文本…"></textarea>
        <div class="hint"><span id="rt-n">0</span> 字 · 分析经 AI 引擎（约 1~5 分钟），完成后候选出收件箱</div></div>
      <div class="form-err" id="rt-err"></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="submit" class="btn">${icon('zap')}入池并分析</button>
      </div>
    </form>`;
  const m = openModal({ title: '粘贴转写', body: box, wide: true });
  const errEl = box.querySelector('#rt-err');
  const textEl = box.querySelector('textarea[name=text]');
  textEl.addEventListener('input', () => { box.querySelector('#rt-n').textContent = String(textEl.value.length); });
  box.querySelector('[data-act=cancel]').addEventListener('click', m.close);
  box.querySelector('#rt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    errEl.classList.remove('show');
    await busyBtn(f.querySelector('[type=submit]'), async () => {
      try {
        const r = await apiPost('/api/radar/text', {
          title: f.elements.namedItem('title').value.trim(),
          text: textEl.value.trim(),
        });
        m.close();
        toast('已入纪要池，开始分析…', 'success');
        await refresh();
        runAnalyzeJob([r.messageId]); // 复用既有分析 job（202+轮询），收件箱出候选
      } catch (err) {
        errEl.textContent = `${err.code ? `${err.code}: ` : ''}${err.message}`;
        errEl.classList.add('show');
      }
    });
  });
}

async function analyzeChecked() {
  const ids = [...checkedMsg].filter((id) => messages.some((m) => m.id === id && selectableMsg(m)));
  if (!ids.length) return;
  await runAnalyzeJob(ids);
}

// 两条「重试」入口（纪要池行 + 结果条）与「分析所选」都汇到这里，统一守卫：activeJob 在跑直接返回
async function runAnalyzeJob(ids) {
  if (!ids || !ids.length) return;
  if (!claimJob('analyze')) return;
  try {
    const r = await apiPost('/api/radar/analyze', { messageIds: ids });
    if (!r || r.accepted === 0) {
      releaseJob();
      // reason → 人话分级（W1：不再出现「没有可分析的消息（ALREADY_RUNNING）」式机器码红 toast）
      const g = (!r || r.accepted == null)
        ? { msg: '分析请求未返回结果，请重试', type: 'error' }
        : describeSkips(r.skipped);
      toast(g.msg, g.type);
      await refresh(); // 回填列表真实状态（如已分析水位）
      return;
    }
    checkedMsg = new Set();
    activeJob = { id: r.jobId, kind: 'analyze' };
    syncJobControls(); // 清勾后立即刷新「分析所选」计数与各触发点禁用态
    await pollJob(r.jobId, 'analyze');
  } catch (e) {
    releaseJob();
    toast(e.message);
  }
}

// accepted===0 时的 skipped reason 分级（v2.1-A.4）：
// 单一原因 → 规格固定人话文案；混合 → 计数汇总。杜绝机器码拼接
function describeSkips(skipped) {
  const list = Array.isArray(skipped) ? skipped : [];
  if (!list.length) return { msg: '没有可分析的纪要，请刷新后重试', type: 'error' };
  const nRunning = list.filter((s) => s && s.reason === 'ALREADY_RUNNING').length;
  const nAnalyzed = list.filter((s) => s && s.reason === 'ALREADY_ANALYZED').length;
  const nMissing = list.filter((s) => s && s.reason === 'NOT_FOUND').length;
  if (list.length === nRunning) return { msg: '所选纪要已在分析中，请等当前批次完成', type: 'info' };
  if (list.length === nAnalyzed) return { msg: '所选纪要均已分析过', type: 'info' };
  if (list.length === nMissing) return { msg: '所选纪要不存在，请刷新后重试', type: 'error' };
  const parts = [];
  if (nRunning) parts.push(`已在分析中 ${nRunning} 条`);
  if (nAnalyzed) parts.push(`已分析过 ${nAnalyzed} 条`);
  if (nMissing) parts.push(`不存在 ${nMissing} 条`);
  const nOther = list.length - nRunning - nAnalyzed - nMissing;
  if (nOther > 0) parts.push(`其他原因 ${nOther} 条`);
  return { msg: `所选纪要未能分析：${parts.join('、')}`, type: nMissing ? 'error' : 'info' };
}

/** 轮询 job 至终态：分析约 10-25s/条，进度写进 toolbar 提示位；
 * 逐 tick 记录每条 result 首次完成的观测时刻（轮询粒度），供结果条展示单条耗时；
 * v2.1-A.3 终态兜底：404（服务重启丢 job）/ 连续失败 ≥10 次 / 总时长 >10min → 清态 + 人话提示 + 可重发，
 * 不再 1.2s 死循环把工具栏永久锁死 */
function pollJob(jobId, kind) {
  return new Promise((resolve) => {
    activeJob = { id: jobId, kind };
    syncJobControls();
    const seen = new Map(); // result.item → 首次观测到完成的时刻
    const startedAt = Date.now();
    let fails = 0;
    const tick = async () => {
      if (!rootEl) { releaseJob(); resolve(null); return; }
      try {
        const job = await apiGet(`/api/radar/jobs/${encodeURIComponent(jobId)}`);
        fails = 0;
        for (const r of job.results || []) if (!seen.has(r.item)) seen.set(r.item, Date.now());
        const hint = rootEl.querySelector('#radar-job-hint');
        if (hint) {
          hint.textContent = job.state === 'running'
            ? `${kind === 'sync' ? '同步中' : 'AI 分析中'} ${job.done}/${job.total}${job.current ? ` · ${job.current}` : ''}…`
            : '';
        }
        if (job.state !== 'running') {
          releaseJob();
          reportJob(job, kind, seen);
          await refresh();
          resolve(job);
          return;
        }
      } catch (e) {
        fails += 1;
        const lost = e && e.status === 404; // server 重启丢 job
        const tooManyFails = fails >= 10;
        const tooLong = Date.now() - startedAt > 10 * 60 * 1000;
        if (lost || tooManyFails || tooLong) {
          releaseJob();
          const hint = rootEl && rootEl.querySelector('#radar-job-hint');
          if (hint) hint.textContent = '';
          toast(
            lost ? '任务状态丢失（服务可能已重启），请重新发起'
              : tooLong ? '任务等待超时，已停止轮询，请重新发起'
                : '任务状态查询连续失败，已停止等待，请重新发起',
            'error'
          );
          await refresh();
          resolve(null);
          return;
        }
        // 单次轮询失败不中断：1.2s 后重试，连败达阈值按终态兜底
      }
      jobTimer = setTimeout(tick, 1200);
    };
    tick();
  });
}

// ---------------- 最近一次操作结果条（P2-3）：同步/分析结果持久化，刷新后仍可见 ----------------

const LASTJOB_KEY = 'fde-radar-lastjob';

function loadLastJob() {
  try {
    const v = JSON.parse(localStorage.getItem(LASTJOB_KEY) || 'null');
    return v && typeof v === 'object' && v.kind ? v : null;
  } catch { return null; }
}

function saveLastJob(rec) {
  try { localStorage.setItem(LASTJOB_KEY, JSON.stringify(rec)); } catch { /* 存储不可用不影响主流程 */ }
  drawLastJob();
}

function drawLastJob() {
  const root = rootEl;
  if (!root) return;
  const box = root.querySelector('#radar-lastjob');
  if (!box) return;
  const rec = loadLastJob();
  if (!rec) { box.hidden = true; box.innerHTML = ''; return; }
  const when = `<span title="${esc(fmtFull(rec.at))}">${fmtClock(rec.at)}</span>`;
  const dur = rec.totalMs != null ? `<span>耗时 ${fmtSec(rec.totalMs / 1000)}</span>` : '';
  const failBit = `<span class="lj-err">${esc(rec.error || '未知错误')}</span>`;
  let head;
  let body = '';
  if (rec.kind === 'sync' || rec.kind === 'sync-feishu') {
    const chLabel = rec.kind === 'sync-feishu' ? '飞书妙记同步' : '同步';
    head = rec.state === 'failed'
      ? `<b>${chLabel}失败</b>${failBit}${dur}${when}`
      : `<b>${chLabel}完成</b><span>新增 ${rec.added ?? 0} · 已存在 ${rec.skippedExisting ?? 0} · 失败 ${rec.failedCount ?? 0}${rec.failedCount ? '（下次同步自动重试）' : ''}</span>${dur}${when}`;
  } else {
    const bad = (rec.items || []).filter((x) => !x.ok);
    const label = rec.state === 'failed' ? '分析失败' : (bad.length ? '分析完成（部分失败）' : '分析完成');
    head = `<b>${label}</b>${rec.state === 'failed' ? failBit : ''}${dur}${when}`;
    body = `<div class="lj-items">${(rec.items || []).map((it) => `
      <div class="lj-item ${it.ok ? 'ok' : 'bad'}">
        <span class="lj-state">${it.ok ? '成功' : '失败'}</span>
        <span class="lj-title" title="${esc(it.title)}">${esc(it.title)}</span>
        ${it.ok
          ? `<span class="lj-extra">候选 ${it.added ?? 0} 张</span>`
          : `<span class="lj-extra" title="${esc(it.error || '分析失败')}">${esc(String(it.error || '分析失败').slice(0, 60))}</span>`}
        <span class="lj-dur">${it.durationMs != null ? fmtSec(it.durationMs / 1000) : '—'}</span>
        ${it.ok ? '' : `<button type="button" class="btn ghost xs" data-act="lj-retry" data-id="${esc(it.messageId)}"${activeJob ? ' disabled' : ''}>${icon('refresh-cw')}重试</button>`}
      </div>`).join('')}</div>`;
  }
  box.hidden = false;
  box.innerHTML = `<div class="lj-h"><span class="lj-cap muted small">最近一次操作</span>${head}</div>${body}`;
  box.onclick = (e) => {
    const btn = e.target.closest('button[data-act=lj-retry]');
    if (!btn) return;
    runAnalyzeJob([btn.dataset.id]);
  };
}

function reportJob(job, kind, seen) {
  if (!rootEl) return;
  const hint = rootEl.querySelector('#radar-job-hint');
  if (hint) hint.textContent = '';
  // 结果改为页面内「最近一次操作」结果条呈现（P2-3），不再用一闪而过的 toast
  const startedMs = Date.parse(job.startedAt);
  const totalMs = job.finishedAt && !isNaN(startedMs)
    ? Math.max(0, Date.parse(job.finishedAt) - startedMs)
    : null;
  const at = job.finishedAt || new Date().toISOString();
  if (job.state === 'failed') {
    saveLastJob({ kind, at, state: 'failed', error: job.error || '未知错误', totalMs, items: [] });
    return;
  }
  if (kind === 'sync' || kind === 'sync-feishu') {
    const r = job.results[0] || {};
    saveLastJob({
      kind, at, state: 'done', totalMs, // partial（有留痕失败）按完成呈现，failedCount 已如实带出
      added: r.added ?? 0,
      skippedExisting: r.skippedExisting ?? 0,
      failedCount: (r.failed || []).length
    });
    return;
  }
  // analyze：每条 message 一行（成功/失败 + 耗时 + 失败可重试）；
  // 耗时来源：单条 job 用总耗时；批量时用轮询观测到的逐条完成时刻差（粒度 1.2s，测不出则显示 —）
  const results = job.results || [];
  const items = results.map((r, i) => {
    const msg = messages.find((m) => m.id === r.item);
    let durationMs = null;
    if (results.length === 1 && totalMs != null) {
      durationMs = totalMs;
    } else {
      const endT = seen && seen.get(r.item);
      const prevT = i > 0 ? seen && seen.get(results[i - 1].item) : (isNaN(startedMs) ? null : startedMs);
      if (endT != null && prevT != null && endT > prevT) durationMs = endT - prevT;
    }
    return {
      messageId: r.item,
      title: msg ? msg.title : r.item,
      ok: !!r.ok,
      added: r.added || 0,
      error: r.error || null,
      durationMs
    };
  });
  saveLastJob({ kind: 'analyze', at, state: job.state, totalMs, items });
}

// v2.9.63 过滤规则（忽略名单）：删过的纪要 + 关键词/标题规则
async function openIgnoreModal() {
  let data = null;
  try {
    data = await apiGet('/api/radar/ignore');
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const box = document.createElement('div');
  const rows = (data.messages || []).map((m) => `<li><span class="mono small">${esc(m.id)}</span> ${esc(m.title || '（无标题）')} <button type="button" class="btn ghost xs" data-unignore="${esc(m.id)}">恢复</button></li>`).join('');
  box.innerHTML = `
    <div class="muted small">命中以下任一条，下次同步就直接跳过（不再拉取逐字稿、不再产候选）。</div>
    <div class="frow" style="margin-top:10px"><label>关键词</label>
      <div><input id="ig-keywords" class="mono" placeholder="多个用逗号分隔，例如：周会,复盘,团建">
        <div class="hint">匹配听记标题与正文（不区分大小写）</div></div></div>
    <div class="frow"><label>标题片段</label>
      <div><input id="ig-titles" class="mono" placeholder="多个用逗号分隔，例如：周例会,招聘"></div></div>
    <div class="frow"><label>已删除（${(data.messages || []).length}）</label>
      <div>${rows ? `<ul class="ig-list">${rows}</ul>` : '<span class="muted small">还没有删除过纪要</span>'}</div></div>
    <div class="learn-actions"><button type="button" class="btn" id="ig-save">保存规则</button></div>`;
  box.querySelector('#ig-keywords').value = (data.rules.keywords || []).join(',');
  box.querySelector('#ig-titles').value = (data.rules.titles || []).join(',');
  openModal({ title: '过滤规则（同步时跳过）', body: box, wide: true });
  box.querySelector('#ig-save').addEventListener('click', async () => {
    const split = (v) => String(v || '').split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
    try {
      await api('/api/radar/ignore', {
        method: 'POST',
        body: { rules: { keywords: split(box.querySelector('#ig-keywords').value), titles: split(box.querySelector('#ig-titles').value) } },
      });
      toast('规则已保存，下次同步生效', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  box.querySelectorAll('[data-unignore]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await apiDel('/api/radar/ignore/messages/' + encodeURIComponent(b.dataset.unignore));
        b.closest('li').remove();
        toast('已恢复：这条纪要学会被重新同步', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });
}