// research.js — 调研视图（v2.9.92 布局改版,业主拍板；v2.9.94 加访谈出口）：
//   流程:新建访谈 → 访谈对话(每轮更新「访谈出口」缺口清单) → 缺口闸门 → AI 产出方案(范围合同:做/不做/验收) → 方案拆解任务 → 闸门 accept。
//   三区:场景列表 + 草稿闸门内嵌(左栏,业主拍板「草稿进左栏」) | 访谈工作面(中间列纯对话) | 访谈出口 + 方案面板(右栏)。
import { apiGet, apiPost } from '../api.js';
import { esc, toast, icon, openModal } from '../ui.js';

let rootEl = null;
let state = { interviews: [], selectedId: null, detail: null };

/** 方案区的引导文案:没有方案时显示(切换访谈后也要恢复成它,不能残留上一场的方案) */
const PROPOSAL_GUIDE = '访谈出口的缺口处理完后点「生成方案」——AI 通读对话与系统核对过的发现产物,产出方案(做 / 不做 / 验收),并可一键拆解为任务草稿。仍有未处理的缺口时会先提示你确认。';

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
        <div id="rs-exit"></div>
        <div class="rs-left-h">${icon('file-text')} 方案 · 范围合同</div>
        <div id="rs-proposal" class="muted small">${PROPOSAL_GUIDE}</div>
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
        <span class="muted small">${esc(i.projectDir || '未绑定项目')} · ${esc(i.status)}${i.pendingDrafts ? ` · 草稿 ${i.pendingDrafts}` : ''}${i.hasProposal ? ' · 方案 ✓' : ''}${i.openGaps ? ` · 缺口 ${i.openGaps}` : ''}</span>
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
  renderExitPanel();
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
      <button type="button" class="btn btn-sm" id="rs-gen-proposal" ${state.generating ? 'disabled' : ''}>${icon('zap')}${state.generating ? '生成中…(约 2-4 分钟)' : '生成方案'}</button>
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
  if (gen) gen.addEventListener('click', () => requestProposal(gen, false));
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

/**
 * 访谈出口面板(v2.9.94):系统维护的缺口清单——业务环节×四问、干系人、基线、关键假设。
 * 每一项都标着:已有客户原话 / 未问 / 依据核对不上 / 客户暂给不出。
 * 数据全部来自后端(detail.gate:AI 只负责摘录原话,由代码与对话原文逐字核对后判定),前端只负责展示。
 */
const COV_GROUP_TITLE = { step: '业务环节 × 四问', stakeholder: '干系人', baseline: '基线(当前做法的数字)', assumption: '关键假设' };
const COV_MARK = { answered: '✓', confirmed: '✓', unavailable: '—', unverified: '⚠', missing: '○', open: '○', denied: '✕' };

/** 一行检查项。文字之外必须有图标与状态词——不能只靠颜色区分(未问 / 核对不上 / 暂给不出)。 */
function covRow(item, label) {
  const st = item.status;
  const cls = st === 'answered' || st === 'confirmed' ? 'is-ok'
    : st === 'unavailable' ? 'is-na'
      : st === 'unverified' ? 'is-unverified'
        : st === 'denied' ? 'is-denied' : 'is-open';
  let text = '<span class="muted">未问</span>';
  let title = '还没有问到';
  if ((st === 'answered' || st === 'confirmed') && item.group === 'baseline') {
    text = `<b>${esc(item.value || '—')}</b> <span class="rs-cov-tag${item.estimated ? ' is-est' : ''}">${item.estimated ? '估算' : '实测'}</span> <span class="rs-cov-quote">${esc(item.quote)}</span>`;
    title = item.estimated ? '客户口述的估计值(非实测)' : '来自统计或记录的实测值';
  } else if (st === 'answered' || st === 'confirmed') {
    text = `<span class="rs-cov-quote">${esc(item.quote)}</span>`;
    title = item.group === 'assumption' ? '客户亲口确认了这个假设' : '客户原话(已与对话逐字核对)';
  } else if (st === 'unavailable') {
    text = `<span class="muted">${item.group === 'assumption' ? '客户暂无法确认' : '暂给不出'}</span> <span class="rs-cov-quote">${esc(item.quote)}</span>`;
    title = '客户明确表示给不出——不算缺口,但生成方案时会如实写进「风险与前提」';
  } else if (st === 'unverified') {
    text = `<span class="rs-cov-warn">${item.group === 'assumption' ? '待客户确认(摘录未核对上)' : '依据未核对上'}</span> <span class="rs-cov-quote">${esc(item.quote)}</span>`;
    title = 'AI 摘录的这句话在客户发言里找不到,不算已确认;下一轮 AI 会重新摘录。你也可以直接把这个情况再说一遍';
  } else if (st === 'denied') {
    text = `<span class="rs-cov-warn">客户否认</span> <span class="rs-cov-quote">${esc(item.quote)}</span>`;
    title = '客户明确否认了这个假设';
  } else if (item.group === 'assumption') {
    text = '<span class="muted">待客户确认</span>';
    title = 'AI 注意到的前提,客户还没有确认';
  }
  return `<div class="rs-cov-row ${cls}" title="${esc(title)}"><span class="rs-cov-mark" aria-hidden="true">${COV_MARK[st] || '○'}</span><span class="rs-cov-label">${esc(label)}</span><span class="rs-cov-text">${text}</span></div>`;
}

function renderExitGroups(items) {
  const byGroup = {};
  for (const it of items) (byGroup[it.group] = byGroup[it.group] || []).push(it);
  const out = [];
  for (const g of ['step', 'stakeholder', 'baseline', 'assumption']) {
    const list = byGroup[g] || [];
    out.push(`<div class="rs-cov-group"><div class="rs-cov-group-h">${COV_GROUP_TITLE[g]}</div>`);
    if (!list.length) {
      // 环节/假设是动态的,可能确实还没有;干系人/基线的槽位恒在,不会走到这里
      out.push(`<div class="muted small rs-cov-empty">${g === 'step' ? '尚未识别业务环节' : '暂无'}</div>`);
    } else if (g === 'step') {
      let cur = null;
      for (const it of list) {
        const m = /^环节「(.+?)」·(.+)$/.exec(it.label);
        if (!m) continue;
        if (m[1] !== cur) { cur = m[1]; out.push(`<div class="rs-cov-step">${esc(cur)}</div>`); }
        out.push(covRow(it, m[2]));
      }
    } else {
      for (const it of list) out.push(covRow(it, g === 'assumption' ? it.text : it.label));
    }
    out.push('</div>');
  }
  return out.join('');
}

function renderExitPanel() {
  const el = rootEl && rootEl.querySelector('#rs-exit');
  if (!el) return;
  const d = state.detail || {};
  const iv = d.interview || null;
  const gate = d.gate || null;
  if (!iv || !gate) { el.innerHTML = ''; return; }
  const cov = iv.contextMeta && iv.contextMeta.coverage;
  const hasProp = !!(iv.proposal && iv.proposal.md);
  // 折叠:用户点过就记住;没点过时,有方案就默认收起,把空间让给方案
  let folded = null;
  try {
    const v = localStorage.getItem('fde-research-exit-folded');
    if (v === '1' || v === '0') folded = v === '1';
  } catch { /* 无 localStorage 忽略 */ }
  if (folded === null) folded = hasProp;
  const c = gate.counts;
  const pct = gate.assessed && c.total ? Math.round(((c.answered + c.unavailable) / c.total) * 100) : 0;
  const clientRows = (d.messages || []).filter((m) => m.role === 'client' && m.kind === 'normal').length;
  const stale = gate.assessed && cov && Number.isInteger(cov.turns) && cov.turns < clientRows;
  let body = '<div class="muted small" style="padding:6px 0 2px">还没有缺口清单。发送一条消息后,AI 会开始逐项记录,并附上你的原话。</div>';
  if (gate.assessed) {
    body = renderExitGroups(gate.items)
      + (stale ? `<div class="rs-cov-note">${icon('alert-triangle')} <span>清单截至第 ${cov.turns} 条发言(最新一条尚未计入,再发一条消息即可更新)</span></div>` : '')
      + (cov && cov.truncated ? `<div class="rs-cov-note">${icon('alert-triangle')} <span>上一轮有摘录没能完成近似核对,已按「未核对」处理</span></div>` : '');
  }
  el.innerHTML = `
    <section class="rs-exit" aria-label="访谈出口">
      <button type="button" class="rs-exit-h" id="rs-exit-fold" aria-expanded="${!folded}">
        ${icon('check-circle')} <b>访谈出口</b>
        <span class="rs-exit-counts muted small">${gate.assessed
          ? `已确认 ${c.answered} · 暂给不出 ${c.unavailable} · <b class="${c.open ? 'rs-cov-open-n' : ''}">缺口 ${c.open}</b>`
          : '未评估'}</span>
        <span class="spacer"></span>
        <span class="rs-exit-chev">${icon('chevron-down')}</span>
      </button>
      ${gate.assessed ? `<div class="rs-exit-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="访谈出口完成度"><i style="width:${pct}%"></i></div>` : ''}
      <div class="rs-exit-body" ${folded ? 'hidden' : ''}>${body}</div>
    </section>`;
  el.querySelector('.rs-exit-chev').style.transform = `rotate(${folded ? '-90deg' : '0deg'})`;
  el.querySelector('#rs-exit-fold').addEventListener('click', () => {
    const b = el.querySelector('.rs-exit-body');
    const nowFolded = !b.hidden;
    b.hidden = nowFolded;
    el.querySelector('#rs-exit-fold').setAttribute('aria-expanded', String(!nowFolded));
    el.querySelector('.rs-exit-chev').style.transform = `rotate(${nowFolded ? '-90deg' : '0deg'})`;
    try { localStorage.setItem('fde-research-exit-folded', nowFolded ? '1' : '0'); } catch { /* 忽略 */ }
  });
}

/**
 * 生成方案(v2.9.94):闸门在后端。还有未处理的缺口时,后端回 409 GAPS_OPEN 且不花模型调用——
 * 这里刷新详情(拿到最新的缺口清单)并弹窗让用户选「回去补缺口」或「仍然生成方案」。
 */
async function requestProposal(btn, force) {
  const id = state.selectedId;
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '生成中…(约 2-4 分钟)';
  try {
    await apiPost(`/api/research/interviews/${id}/proposal`, force ? { force: true } : {});
    toast(force ? '方案已产出(带着未处理的缺口,见右栏提示)' : '方案已产出(右栏)');
    await openDetail(id, { silent: true });
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = label;
    if (e && e.code === 'GAPS_OPEN') {
      await openDetail(id, { silent: true }); // 主区域会重画(按钮恢复可用),再弹确认
      showGateDialog();
      return;
    }
    toast(e.message);
  }
}

/** 闸门确认弹窗:列出未处理的缺口,说明继续生成的后果;「仍然生成」带 force 重发,并由后端在方案上留痕 */
function showGateDialog() {
  const gate = (state.detail && state.detail.gate) || { open: [], unavailable: [] };
  const open = gate.open || [];
  const show = open.slice(0, 12);
  const box = document.createElement('div');
  box.innerHTML = `
    <p>访谈还有 <b>${open.length}</b> 项缺口未处理。现在生成的话,方案只能在「风险与前提」里把它们写成待确认项,验收指标也会缺少对比基线。</p>
    <ul class="rs-gate-list">
      ${show.map((g) => `<li><span class="rs-cov-mark ${g.status === 'unverified' ? 'is-unverified' : ''}" aria-hidden="true">${g.status === 'unverified' ? '⚠' : '○'}</span><span>${esc(g.label)}</span> <span class="muted small">${g.status === 'unverified' ? '依据未核对上' : g.group === 'assumption' ? '待客户确认' : '未问'}</span></li>`).join('')}
    </ul>
    ${open.length > show.length ? `<p class="muted small">等 ${open.length} 项(完整清单见右栏「访谈出口」)</p>` : ''}
    <p class="muted small">「客户暂给不出」的 ${(gate.unavailable || []).length} 项不算缺口,会如实写进方案。</p>`;
  const actions = document.createElement('div');
  actions.className = 'rs-gate-actions';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-sm';
  back.textContent = '回去补缺口';
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'btn btn-sm';
  go.textContent = '仍然生成方案';
  const modal = openModal({ title: '生成方案前:还有未处理的缺口', body: box });
  back.addEventListener('click', () => {
    modal.close();
    const inp = rootEl.querySelector('#rs-text');
    if (inp) inp.focus();
  });
  go.addEventListener('click', () => {
    modal.close();
    const btn = rootEl.querySelector('#rs-gen-proposal');
    if (btn) requestProposal(btn, true);
  });
  actions.append(back, ' ', go);
  box.appendChild(actions);
}

function renderProposalPanel() {
  const el = rootEl.querySelector('#rs-proposal');
  if (!el) return;
  const prop = (state.detail && state.detail.interview && state.detail.interview.proposal) || null;
  if (!prop || !prop.md) {
    // 没有方案就恢复引导文案。原先在这里直接 return:从"有方案的访谈"切到"没有方案的访谈"时,
    // 右栏会残留上一场的方案(现在还带着"生成时有 N 项缺口"的留痕,更容易误导)。
    el.textContent = PROPOSAL_GUIDE;
    return;
  }
  // 闸门留痕 + 范围合同完整性(都是后端判定,这里只如实显示)
  const g = prop.gate;
  const notes = [];
  if (g && g.assessed === false) {
    notes.push(`<div class="rs-prop-note is-warn">${icon('alert-triangle')} <span>生成时缺口清单未评估:基线、干系人、假设都没有经过核对,请重点看「风险与前提」</span></div>`);
  } else if (g && g.open > 0) {
    notes.push(`<div class="rs-prop-note is-warn" title="${esc((g.openItems || []).map((x) => x.label).join('、'))}">${icon('alert-triangle')} <span>生成时有 ${g.open} 项缺口未处理${g.forced ? '(你确认后仍然生成)' : ''},已写入「风险与前提」</span></div>`);
  } else if (g) {
    notes.push(`<div class="rs-prop-note is-ok">${icon('check-circle')} <span>生成时访谈出口没有未处理的缺口${g.unavailable ? `;${g.unavailable} 项客户暂给不出` : ''}</span></div>`);
  }
  if (Array.isArray(prop.missingSections) && prop.missingSections.length) {
    notes.push(`<div class="rs-prop-note is-bad">${icon('alert-triangle')} <span>方案缺少章节:${prop.missingSections.map(esc).join('、')}——没按范围合同模板输出,建议点「生成方案」重试</span></div>`);
  }
  el.innerHTML = `
    <div class="rs-prop-meta muted small">${esc(String(prop.generatedAt).slice(0, 19).replace('T', ' '))} · ${esc(prop.channel || '')}${prop.promptVersion ? ` · 提示词 v${esc(prop.promptVersion)}` : ''}</div>
    ${notes.join('')}
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
