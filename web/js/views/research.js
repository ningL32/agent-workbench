// research.js — 调研视图（v2.9.92 布局改版,业主拍板）：
//   流程:新建访谈 → 访谈对话 → AI 识别分析自动产出方案(md) → 方案拆解任务 → 闸门 accept。
//   三区:场景列表 + 草稿闸门内嵌(左栏,业主拍板「草稿进左栏」) | 访谈工作面(中间列纯对话) | 方案面板(右栏)。
import { apiGet, apiPost } from '../api.js';
import { esc, toast, icon, openModal } from '../ui.js';

let rootEl = null;
let state = { interviews: [], selectedId: null, detail: null };

export async function render(el) {
  rootEl = el;
  el.innerHTML = `
    <div class="research-layout">
      <div class="rs-left">
        <div class="rs-left-h">${icon('book-open')} 场景列表 <button type="button" class="btn btn-sm" id="rs-new">${icon('plus')} 新建访谈</button></div>
        <div id="rs-scenes"></div>
        <div id="rs-drafts-left"></div>
      </div>
      <div class="rs-main" id="rs-main"><div class="empty-state">选择或新建一个访谈场景</div></div>
      <div class="rs-right">
        <div class="rs-left-h">${icon('file-text')} 方案（AI 识别分析自动产出）</div>
        <div id="rs-proposal" class="muted small">访谈内容足够后点「生成方案」——AI 通读对话产出结构化方案文档(md),并可一键拆解为任务草稿</div>
      </div>
    </div>`;
  el.querySelector('#rs-new').addEventListener('click', onNew);
  await refresh();
}

async function refresh() {
  try {
    state.interviews = await apiGet('/api/research/interviews');
    renderScenes();
    renderDraftsLeft();
    if (state.selectedId) await openDetail(state.selectedId, { silent: true });
  } catch (e) {
    toast(e.message);
  }
}

function renderScenes() {
  const box = rootEl.querySelector('#rs-scenes');
  if (!state.interviews.length) {
    box.innerHTML = '<div class="muted small">还没有访谈——新建一个开始调研</div>';
    return;
  }
  box.innerHTML = state.interviews
    .map((i) => `
      <button type="button" class="rs-scene${i.id === state.selectedId ? ' active' : ''}" data-id="${esc(i.id)}">
        <b>${esc(i.sceneTitle)}</b>
        <span class="muted small">${esc(i.projectDir || '未绑定项目')} · ${esc(i.status)}${i.pendingDrafts ? ` · 草稿 ${i.pendingDrafts}` : ''}${i.hasProposal ? ' · 方案 ✓' : ''}</span>
      </button>`)
    .join('');
  box.querySelectorAll('.rs-scene').forEach((b) =>
    b.addEventListener('click', () => openDetail(b.dataset.id))
  );
}

/** 左栏草稿闸门(业主拍板「草稿进左栏」):选中场景的草稿内嵌在这里,中间列纯对话 */
function renderDraftsLeft() {
  const box = rootEl.querySelector('#rs-drafts-left');
  if (!box) return;
  const d = state.detail || {};
  const drafts = Array.isArray(d.drafts) ? d.drafts : [];
  if (!state.selectedId || !drafts.length) {
    box.innerHTML = '';
    return;
  }
  // v2.9.93 折叠:业主反馈左栏闸门占屏——点击头部折叠/展开,localStorage 跨刷新记忆
  let folded = false;
  try { folded = localStorage.getItem('fde-research-draft-folded') === '1'; } catch { /* 无 localStorage 忽略 */ }
  const pending = drafts.filter((x) => x.status === 'pending');
  const decided = drafts.filter((x) => x.status !== 'pending');
  let html = `
    <button type="button" class="rs-left-h rs-fold-toggle" id="rs-draft-fold" aria-expanded="${folded ? 'false' : 'true'}" style="width:100%;text-align:left;cursor:pointer;background:none;border:none;color:inherit">
      ${icon('inbox')} 任务草稿闸门(${drafts.length}) <span class="muted small">${pending.length} 待确认</span> <span style="float:right;transform:rotate(${folded ? '-90deg' : '0deg'})">${icon('chevron-down')}</span>
    </button>
    <div id="rs-draft-body" ${folded ? 'hidden' : ''}>
    ${pending.length ? pending.map((dr) => `
      <div class="rs-draft" data-id="${esc(dr.id)}">
        <input type="text" class="d-title" value="${esc(dr.payload.title)}" />
        <textarea class="d-desc" rows="2">${esc(dr.payload.desc)}</textarea>
        <select class="d-prio">
          ${['high', 'medium', 'low'].map((p) => `<option value="${p}"${dr.payload.priority === p ? ' selected' : ''}>${p}</option>`).join('')}
        </select>
        <div class="muted small">引用: ${esc(dr.quote)}</div>
        <div>
          <button type="button" class="btn btn-sm d-accept" data-id="${esc(dr.id)}">${icon('check')} accept</button>
          <button type="button" class="btn btn-sm d-reject" data-id="${esc(dr.id)}">${icon('ban')} reject</button>
        </div>
      </div>`).join('') : '<div class="muted small">待确认草稿已清空</div>'}`;
  if (decided.length) {
    html += `<div class="muted small" style="margin:4px 0">已处置 ${decided.length} 条</div>`;
    html += decided.map((dr) => `
      <div class="rs-draft rs-draft-decided">
        <b>${esc(dr.payload.title)}</b> <span class="muted small">${esc(dr.status)}${dr.taskId ? ` · ${esc(dr.taskId)}` : ''}</span>
      </div>`).join('');
  }
  html += '</div>';
  box.innerHTML = html;
  const foldBtn = box.querySelector('#rs-draft-fold');
  if (foldBtn) foldBtn.addEventListener('click', () => {
    const body = box.querySelector('#rs-draft-body');
    if (body) body.hidden = !body.hidden;
    foldBtn.setAttribute('aria-expanded', String(body.hidden === false));
    try { localStorage.setItem('fde-research-draft-folded', body.hidden ? '1' : '0'); } catch { /* 忽略 */ }
  });
  wireDrafts(box);
}

function wireDrafts(scope) {
  scope.querySelectorAll('.d-accept').forEach((b) =>
    b.addEventListener('click', async () => {
      const box = b.closest('.rs-draft');
      const payload = {
        title: box.querySelector('.d-title').value.trim(),
        desc: box.querySelector('.d-desc').value.trim(),
        priority: box.querySelector('.d-prio').value,
      };
      try {
        const dr = await apiPost(`/api/research/drafts/${b.dataset.id}/accept`, { payload, decidedBy: 'fde' });
        const task = await apiPost('/api/tasks', { title: dr.payload.title, desc: dr.payload.desc, priority: dr.payload.priority, projectDir: ((state.detail || {}).interview || {}).projectDir || '', origin: { source: 'research', interviewId: state.detail.interview.id, quote: dr.quote } });
        await apiPost(`/api/research/drafts/${b.dataset.id}/link`, { taskId: task.id });
        toast(`任务 ${task.id} 已创建并挂接(闭环 A ✓)`);
        await refresh();
      } catch (e) { toast(e.message); }
    })
  );
  scope.querySelectorAll('.d-reject').forEach((b) =>
    b.addEventListener('click', async () => {
      const reason = prompt('拒绝原因(留痕):');
      if (reason === null) return;
      try {
        await apiPost(`/api/research/drafts/${b.dataset.id}/reject`, { reason });
        await refresh();
      } catch (e) { toast(e.message); }
    })
  );
}

async function openDetail(id, opts = {}) {
  state.selectedId = id;
  try {
    state.detail = await apiGet(`/api/research/interviews/${id}`);
  } catch (e) {
    toast(e.message);
    return;
  }
  renderScenes();
  renderDraftsLeft();
  renderMain(opts);
  renderProposalPanel();
}

function renderMain(opts = {}) {
  const main = rootEl.querySelector('#rs-main');
  if (!main) return;
  const d = state.detail || {};
  const iv = d.interview || {};
  const msgs = Array.isArray(d.messages) ? d.messages : [];
  main.innerHTML = `
    <div class="rs-main-h">
      <b>${esc(iv.sceneTitle || '')}</b>
      <span class="muted small">${esc(iv.projectDir || '未绑定项目')} · ${esc(iv.status)}</span>
      ${iv.status === 'open' ? `<button type="button" class="btn btn-sm" id="rs-close">${icon('x')} 关闭访谈</button>` : ''}
      <button type="button" class="btn btn-sm" id="rs-gen-proposal" ${state.generating ? 'disabled' : ''}>${icon('zap')}${state.generating ? '生成中…(1-3分钟)' : '生成方案'}</button>
      <button type="button" class="btn btn-sm" id="rs-decompose">${icon('kanban')} 方案拆解任务</button>
      <button type="button" class="btn btn-sm" id="rs-exp-report">${icon('file-text')} 交付报告</button>
      <button type="button" class="btn btn-sm" id="rs-exp-bpmn">${icon('git-branch')} BPMN</button>
    </div>
    <div class="rs-msgs" id="rs-msgs">
      ${msgs.length ? msgs.map((m) => `
        <div class="rs-msg rs-msg-${esc(m.role)}${m.kind !== 'normal' ? ' rs-msg-kind' : ''}">
          <span class="muted small">${m.role === 'client' ? '客户' : m.role === 'AI' ? 'AI 调研顾问' : esc(m.role)}${m.kind !== 'normal' ? ` · ${esc(m.kind)}` : ''} · ${esc(String(m.ts || '').slice(0, 19).replace('T', ' '))}</span>
          <div class="rs-msg-body">${esc(m.text)}</div>
        </div>`).join('') : '<div class="muted small">还没有发言——我是 AI 调研顾问,直接说说你的业务现状,我来帮你梳理(支持语音/附件)</div>'}
      ${(iv.attachments || []).length ? `<div class="rs-att-chips">${iv.attachments.map((a) => {
        const shortName = a.name.length > 24 ? a.name.slice(0, 14) + '…' + a.name.slice(-7) : a.name;
        const kb = a.bytes >= 1024 ? Math.round(a.bytes / 1024) + 'KB' : a.bytes + 'B';
        return `<span class="chip tiny" title="${esc(a.name)} · ${kb}${a.kind === 'text' ? ' · AI 可读内容' : ' · 图片型,AI 仅参考文件名'}">${icon('paperclip')} ${esc(shortName)} (${kb})</span>`;
      }).join('')}</div>` : ''}
    </div>
    ${iv.status === 'open' ? `
    <div class="rs-atts" id="rs-atts"></div>
    <div class="rs-input">
      <button type="button" class="rs-icon-btn" id="rs-mic" title="语音输入(浏览器识别)" hidden>${icon('mic')}</button>
      <button type="button" class="rs-icon-btn" id="rs-paperclip" title="上传附件(需求文档/模板)">${icon('paperclip')}</button>
      <input type="file" id="rs-file" multiple hidden />
      <textarea id="rs-text" rows="2" placeholder="直接和 AI 调研顾问说说你的业务…(支持语音/附件)"></textarea>
      <button type="button" class="btn" id="rs-send">${icon('zap')} 发送</button>
    </div>` : ''}
    <div class="rs-flow">
      <div class="rs-flow-h">
        ${icon('git-branch')} <b>任务流程图</b>
        <span class="muted small" id="rs-flow-meta">${(d.drafts || []).length ? `${(d.drafts || []).length} 个任务` : '拆解方案后展示依赖关系'}</span>
        <span class="spacer"></span>
        <button type="button" class="btn ghost xs" id="rs-flow-refresh" title="刷新流程图(重新读取草稿与状态)">${icon('refresh-cw')} 刷新</button>
        <button type="button" class="btn ghost xs" id="rs-flow-mmd" title="查看 Mermaid 文本(可自行渲染/截图)">${icon('file-text')} Mermaid</button>
      </div>
      <div class="rs-flow-body" id="rs-flow-body"></div>
    </div>`;
  wireMain(opts);
  loadFlow();
  // 对话流自动滚底(新发言/AI 回复后视线跟随)
  const msgsEl = rootEl && rootEl.querySelector('#rs-msgs');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
}

/**
 * 加载任务流程图(v2.9.94):
 *   - 结构化 {nodes, edges} 经 apiGet 拉取(可断言);SVG 经带 cache-bust 的 URL 拉取后**内联**注入
 *     (服务端渲染,零依赖;Cache-Control: no-cache + 时间戳参数保证「刷新」必取新图)
 *   - 空草稿时显示引导文案,不出错
 */
let flowCache = { id: null, data: null };
async function loadFlow() {
  const body = rootEl && rootEl.querySelector('#rs-flow-body');
  if (!body || !state.selectedId) return;
  const wanted = state.selectedId; // 竞态守卫:await 期间用户可能切了场景
  try {
    const [flow, res] = await Promise.all([
      apiGet(`/api/research/interviews/${wanted}/flow`),
      fetch(`/fde-api/research/interviews/${wanted}/flow.svg?_=${Date.now()}`, { cache: 'no-store' }),
    ]);
    if (state.selectedId !== wanted) return;
    flowCache = { id: wanted, data: flow };
    if (!flow.nodes.length) {
      body.innerHTML = '<div class="muted small" style="padding:14px 0">还没有任务草稿——点「生成方案」→「方案拆解任务」后,这里展示任务依赖关系图</div>';
      return;
    }
    const meta = rootEl.querySelector('#rs-flow-meta');
    if (meta) meta.textContent = `${flow.nodes.length} 个任务 · ${flow.edges.length} 条依赖 · 已建任务 ${flow.nodes.filter((n) => n.status === 'accepted').length}`;
    if (res.ok) {
      // 内联 SVG(非 <img>):<img> 会隔离 SVG 内部事件,做不了节点点击/悬停。
      // 内容出自本服务端 toSvg()——节点标题经 escXml 转义,非用户原文直插。
      const svg = await res.text();
      if (!/^<svg[\s>]/.test(svg)) throw new Error('流程图响应不是 SVG');
      body.innerHTML = `<div class="rs-flow-svg">${svg}</div>`;
      wireFlowNodes(body);
    } else {
      body.innerHTML = `<div class="muted small">流程图渲染失败(HTTP ${res.status})</div>`;
    }
  } catch (e) {
    body.innerHTML = `<div class="muted small">流程图加载失败: ${esc(e.message)}</div>`;
  }
}

/**
 * 流程图节点交互(v2.9.94):点击节点 → 弹层展示该任务全貌(标题/状态/优先级/依赖/引用/描述)。
 * 数据取自 flowCache(与 SVG 同一次拉取),不依赖 SVG 文本内容。
 */
function wireFlowNodes(scope) {
  const nodes = (flowCache.data && flowCache.data.nodes) || [];
  scope.querySelectorAll('.rs-flow-svg g[data-draft-id]').forEach((g) => {
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    const open = () => {
      const nd = nodes.find((x) => x.id === g.dataset.draftId);
      if (!nd) return;
      const draft = ((state.detail && state.detail.drafts) || []).find((x) => x.id === nd.id);
      const depText = nd.deps.length ? `任务 ${nd.deps.join('、任务')}` : '无';
      const box = document.createElement('div');
      box.innerHTML = `
        <p><b>${esc(nd.n === null ? '' : nd.n + '. ')}${esc(nd.title)}</b></p>
        <p class="muted small">状态 ${esc(nd.status === 'accepted' ? '已建任务' : nd.status === 'pending' ? '待确认' : nd.status === 'rejected' ? '已拒绝' : nd.status)} · 优先级 ${esc(nd.priority)}${nd.taskId ? ` · 任务 <span class="mono">${esc(nd.taskId)}</span>` : ''}</p>
        <p class="muted small">依赖:${esc(depText)}</p>
        ${draft && draft.quote ? `<p class="muted small">引用:${esc(draft.quote)}</p>` : ''}
        <pre style="white-space:pre-wrap;font-size:12px;max-height:240px;overflow:auto">${esc((draft && draft.payload && draft.payload.desc) || '')}</pre>`;
      openModal({ title: '流程图节点', body: box });
    };
    g.addEventListener('click', open);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

function wireMain(opts = {}) {
  const main = rootEl.querySelector('#rs-main');
  if (!main) return;
  const send = main.querySelector('#rs-send');
  const text = main.querySelector('#rs-text');
  if (send && text) {
    send.addEventListener('click', async () => {
      const v = text.value.trim();
      if (!v) return;
      send.disabled = true;
      text.disabled = true;
      try {
        const r = await apiPost(`/api/research/interviews/${state.selectedId}/messages`, { text: v });
        if (r && r.aiMessage && r.aiMessage.kind === 'parse_error') toast('模型返回无法解析,已留痕');
        if (r && r.drafts && r.drafts.length) toast(`产出 ${r.drafts.length} 条草稿(左栏闸门待确认)`);
        await openDetail(state.selectedId, { silent: true });
      } catch (e) {
        toast(e.message);
      } finally {
        // 不论成败都恢复输入区:原先失败时按钮会一直禁用,用户没法重发
        send.disabled = false;
        text.disabled = false;
      }
    });
  }
  const close = main.querySelector('#rs-close');
  if (close) close.addEventListener('click', async () => {
    try { await apiPost(`/api/research/interviews/${state.selectedId}/close`, {}); await refresh(); } catch (e) { toast(e.message); }
  });
  const gen = main.querySelector('#rs-gen-proposal');
  if (gen) gen.addEventListener('click', async () => {
    gen.disabled = true;
    gen.textContent = '生成中…(1-3分钟)';
    try {
      await apiPost(`/api/research/interviews/${state.selectedId}/proposal`, {});
      toast('方案已产出(右栏)');
      await openDetail(state.selectedId, { silent: true });
    } catch (e) { toast(e.message); gen.disabled = false; }
  });
  const dec = main.querySelector('#rs-decompose');
  if (dec) dec.addEventListener('click', async () => {
    dec.disabled = true;
    try {
      const r = await apiPost(`/api/research/interviews/${state.selectedId}/decompose`, {});
      toast(`方案拆解出 ${r.drafts.length} 条草稿(左栏待确认)`);
      await openDetail(state.selectedId, { silent: true });
    } catch (e) { toast(e.message); dec.disabled = false; }
  });
  const doExport = async (format) => {
    const iv = (state.detail && state.detail.interview) || {};
    try {
      const res = await fetch(`/fde-api/research/export?scene=${encodeURIComponent(iv.projectDir || '')}&format=${format}`, {
        headers: { Authorization: `Bearer ${new URLSearchParams(location.search).get('token') || ''}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `scene.${format === 'bpmn' ? 'bpmn' : 'md'}`;
      a.click();
    } catch (e) { toast(e.message); }
  };
  const exR = main.querySelector('#rs-exp-report');
  const exB = main.querySelector('#rs-exp-bpmn');
  if (exR) exR.addEventListener('click', () => doExport('report'));
  if (exB) exB.addEventListener('click', () => doExport('bpmn'));
  // v2.9.94 流程图:刷新(重取 SVG+结构数据)与 Mermaid 文本(查看/复制/下载——业主自行渲染截图)
  const flowRefresh = main.querySelector('#rs-flow-refresh');
  if (flowRefresh) flowRefresh.addEventListener('click', async () => {
    flowRefresh.disabled = true;
    await loadFlow();
    flowRefresh.disabled = false;
    toast('流程图已刷新');
  });
  const flowMmd = main.querySelector('#rs-flow-mmd');
  if (flowMmd) flowMmd.addEventListener('click', async () => {
    try {
      const r = await fetch(`/fde-api/research/interviews/${state.selectedId}/flow.mmd?_=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const mmd = await r.text();
      const box = document.createElement('div');
      const pre = document.createElement('pre');
      pre.style.cssText = 'white-space:pre-wrap;font-size:12px;max-height:360px;overflow:auto;user-select:text';
      pre.textContent = mmd;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-sm';
      copy.textContent = '复制';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(mmd); toast('Mermaid 文本已复制'); } catch (e) { toast('复制失败,请手动选择'); }
      });
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'btn btn-sm';
      dl.textContent = '下载 .mmd';
      dl.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([mmd], { type: 'text/plain' }));
        a.download = 'flow.mmd';
        a.click();
      });
      box.append(copy, ' ', dl, pre);
      openModal({ title: 'Mermaid 流程图文本(粘贴到任意 Mermaid 渲染器)', body: box, wide: true });
    } catch (e) { toast(e.message); }
  });
}

function renderProposalPanel() {
  const el = rootEl.querySelector('#rs-proposal');
  if (!el) return;
  const prop = (state.detail && state.detail.interview && state.detail.interview.proposal) || null;
  if (!prop || !prop.md) return; // 保持初始引导文案
  el.innerHTML = `
    <div class="rs-prop-meta muted small">${esc(String(prop.generatedAt).slice(0, 19).replace('T', ' '))} · ${esc(prop.channel || '')}${prop.promptVersion ? ` · 提示词 v${esc(prop.promptVersion)}` : ''}</div>
    <pre class="rs-prop-md">${esc(prop.md)}</pre>
    <div class="rs-prop-actions">
      <button type="button" class="btn btn-sm" id="rs-prop-copy">${icon('copy')} 复制 md</button>
      <button type="button" class="btn btn-sm" id="rs-prop-dl">${icon('file-text')} 下载 .md</button>
    </div>`;
  el.querySelector('#rs-prop-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(prop.md); toast('方案已复制'); } catch (e) { toast('复制失败'); }
  });
  el.querySelector('#rs-prop-dl').addEventListener('click', () => {
    const blob = new Blob([prop.md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'proposal.md';
    a.click();
  });
}

async function onNew() {
  const sceneTitle = prompt('场景标题:');
  if (!sceneTitle || !sceneTitle.trim()) return;
  const projectDir = prompt('绑定项目目录(可留空):') || '';
  try {
    const iv = await apiPost('/api/research/interviews', { sceneTitle, projectDir });
    state.selectedId = iv.id;
    await refresh();
  } catch (e) { toast(e.message); }
}
