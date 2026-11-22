// research.js — 调研视图（SPEC-RESEARCH §7,R5）：场景列表 | 访谈工作面 | 知识库面板
// 闭环 A 在 UI 走通:草稿 accept(可改)→ 既有 POST /api/tasks 单写路径 → link 绑回。
import { apiGet, apiPost } from '../api.js';
import { esc, toast, icon } from '../ui.js';

let rootEl = null;
let state = { interviews: [], selectedId: null, detail: null, eligible: 0 };

export async function render(el) {
  rootEl = el;
  el.innerHTML = `
    <div class="research-layout">
      <div class="rs-left">
        <div class="rs-left-h">${icon('book-open')} 场景列表 <button type="button" class="btn btn-sm" id="rs-new">${icon('plus')} 新建访谈</button></div>
        <div id="rs-scenes"></div>
      </div>
      <div class="rs-main" id="rs-main"><div class="empty-state">选择或新建一个访谈场景</div></div>
      <div class="rs-right">
        <div class="rs-left-h">${icon('search')} 知识库检索</div>
        <div class="rs-kb-form">
          <input type="text" id="rs-kb-q" placeholder="多词 AND,如: 报表 导出" />
          <button type="button" class="btn btn-sm" id="rs-kb-go">${icon('search')} 检索</button>
        </div>
        <div id="rs-kb-hits" class="muted small">输入关键词检索历史沉淀</div>
        <div class="rs-left-h">${icon('inbox')} 沉淀(验收任务入知识库)</div>
        <div class="rs-kb-form">
          <input type="text" id="rs-kb-task" placeholder="任务 id(done)" />
          <input type="text" id="rs-kb-title" placeholder="标题" />
          <textarea id="rs-kb-body" rows="2" placeholder="做了什么/踩了什么坑"></textarea>
          <button type="button" class="btn btn-sm" id="rs-kb-sed">${icon('plus')} 沉淀</button>
        </div>
        <div id="rs-kb-eligible" class="muted small"></div>
      </div>
    </div>`;
  el.querySelectorAll('#rs-new').forEach((b) => b.addEventListener('click', onNew));
  el.querySelector('#rs-kb-go').addEventListener('click', onKbSearch);
  el.querySelector('#rs-kb-sed').addEventListener('click', onSediment);
  await refresh();
}

async function refresh() {
  try {
    const [list, elig] = await Promise.all([
      apiGet('/api/research/interviews'),
      apiGet('/api/research/kb/eligible').catch(() => ({ count: 0 })),
    ]);
    state.interviews = Array.isArray(list) ? list : [];
    state.eligible = Number(elig && elig.count) || 0;
    renderScenes();
    renderEligible();
    if (state.selectedId) await openDetail(state.selectedId, { silent: true });
  } catch (e) {
    toast(e.message);
  }
}

function renderScenes() {
  const box = rootEl.querySelector('#rs-scenes');
  if (!state.interviews.length) {
    box.innerHTML = '<div class="muted small">还没有访谈——新建一个,或用「演示数据」体验</div>';
    return;
  }
  box.innerHTML = state.interviews
    .map((i) => `
      <button type="button" class="rs-scene${i.id === state.selectedId ? ' active' : ''}" data-id="${esc(i.id)}">
        <b>${esc(i.sceneTitle)}</b>
        <span class="muted small">${esc(i.projectDir || '未绑定项目')} · ${esc(i.status)}${i.pendingDrafts ? ` · 草稿 ${i.pendingDrafts}` : ''}</span>
      </button>`)
    .join('');
  box.querySelectorAll('.rs-scene').forEach((b) =>
    b.addEventListener('click', () => openDetail(b.dataset.id))
  );
}

function renderEligible() {
  const el = rootEl.querySelector('#rs-kb-eligible');
  if (el) el.textContent = state.eligible > 0 ? `可沉淀 ${state.eligible} 条(已完成未沉淀)` : '没有待沉淀的任务';
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
  renderMain(opts);
}

function renderMain(opts = {}) {
  const main = rootEl.querySelector('#rs-main');
  if (!main) return;
  const d = state.detail || {};
  const iv = d.interview || {};
  const msgs = Array.isArray(d.messages) ? d.messages : [];
  const drafts = Array.isArray(d.drafts) ? d.drafts : [];
  main.innerHTML = `
    <div class="rs-main-h">
      <b>${esc(iv.sceneTitle || '')}</b>
      <span class="muted small">${esc(iv.projectDir || '未绑定项目')} · ${esc(iv.status)}</span>
      ${iv.status === 'open' ? `<button type="button" class="btn btn-sm" id="rs-close">${icon('x')} 关闭访谈</button>` : ''}
      <button type="button" class="btn btn-sm" id="rs-exp-report">${icon('file-text')} 交付报告</button>
      <button type="button" class="btn btn-sm" id="rs-exp-bpmn">${icon('git-branch')} BPMN</button>
    </div>
    <div class="rs-msgs" id="rs-msgs">
      ${msgs.length ? msgs.map((m) => `
        <div class="rs-msg rs-msg-${esc(m.role)}">
          <span class="muted small">${esc(m.role)}${m.kind !== 'normal' ? ` · ${esc(m.kind)}` : ''} · ${esc(String(m.ts || '').slice(0, 19).replace('T', ' '))}</span>
          <div>${esc(m.text)}</div>
        </div>`).join('') : '<div class="muted small">还没有发言——在下方输入第一句</div>'}
    </div>
    ${iv.status === 'open' ? `
    <div class="rs-input">
      <textarea id="rs-text" rows="2" placeholder="记录客户/业务的原话…"></textarea>
      <button type="button" class="btn" id="rs-send">${icon('zap')} 发送</button>
    </div>` : ''}
    <div class="rs-drafts">
      <div class="rs-left-h">${icon('inbox')} 草稿闸门(${drafts.length})</div>
      ${drafts.length ? drafts.map((dr, idx) => `
        <div class="rs-draft" data-idx="${idx}">
          ${dr.status === 'pending' ? `
          <input type="text" class="d-title" value="${esc(dr.payload.title)}" />
          <textarea class="d-desc" rows="2">${esc(dr.payload.desc)}</textarea>
          <select class="d-prio">
            ${['high', 'medium', 'low'].map((p) => `<option value="${p}"${dr.payload.priority === p ? ' selected' : ''}>${p}</option>`).join('')}
          </select>
          <div class="muted small">引用: ${esc(dr.quote)}</div>
          <div>
            <button type="button" class="btn btn-sm d-accept" data-id="${esc(dr.id)}">${icon('check')} accept → 建任务</button>
            <button type="button" class="btn btn-sm d-reject" data-id="${esc(dr.id)}">${icon('ban')} reject</button>
          </div>` : `
          <b>${esc(dr.payload.title)}</b> <span class="muted small">${esc(dr.status)}${dr.taskId ? ` · 任务 ${esc(dr.taskId)}` : ''}${dr.rejectReason ? ` · ${esc(dr.rejectReason)}` : ''}</span>
          <div class="muted small">引用: ${esc(dr.quote)}</div>`}
        </div>`).join('') : '<div class="muted small">暂无草稿</div>'}
    </div>`;
  wireMain(opts);
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
      try {
        const r = await apiPost(`/api/research/interviews/${state.selectedId}/messages`, { text: v });
        if (r && r.aiMessage && r.aiMessage.kind === 'parse_error') toast('模型返回无法解析,已留痕(system 行)');
        if (r && r.drafts && r.drafts.length) toast(`产出 ${r.drafts.length} 条草稿,待人工闸门`);
        await openDetail(state.selectedId, { silent: true });
      } catch (e) {
        toast(e.message);
      }
    });
  }
  const close = main.querySelector('#rs-close');
  if (close) {
    close.addEventListener('click', async () => {
      try {
        await apiPost(`/api/research/interviews/${state.selectedId}/close`, {});
        await refresh();
      } catch (e) { toast(e.message); }
    });
  }
  const doExport = async (format) => {
    const iv = (state.detail && state.detail.interview) || {};
    try {
      const res = await fetch(`/fde-api/api/research/export?scene=${encodeURIComponent(iv.projectDir || '')}&format=${format}`, {
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
  main.querySelectorAll('.d-accept').forEach((b) =>
    b.addEventListener('click', async () => {
      const box = b.closest('.rs-draft');
      const payload = {
        title: box.querySelector('.d-title').value.trim(),
        desc: box.querySelector('.d-desc').value.trim(),
        priority: box.querySelector('.d-prio').value,
      };
      try {
        const dr = await apiPost(`/api/research/drafts/${b.dataset.id}/accept`, { payload, decidedBy: 'fde' });
        const task = await apiPost('/api/tasks', { title: dr.payload.title, desc: dr.payload.desc, priority: dr.payload.priority, projectDir: (state.detail.interview.projectDir || '') });
        await apiPost(`/api/research/drafts/${b.dataset.id}/link`, { taskId: task.id });
        toast(`任务 ${task.id} 已创建并挂接(闭环 A ✓)`);
        await openDetail(state.selectedId, { silent: true });
      } catch (e) { toast(e.message); }
    })
  );
  main.querySelectorAll('.d-reject').forEach((b) =>
    b.addEventListener('click', async () => {
      const reason = prompt('拒绝原因(留痕):');
      if (reason === null) return;
      try {
        await apiPost(`/api/research/drafts/${b.dataset.id}/reject`, { reason });
        await openDetail(state.selectedId, { silent: true });
      } catch (e) { toast(e.message); }
    })
  );
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

async function onKbSearch() {
  const q = rootEl.querySelector('#rs-kb-q').value.trim();
  try {
    const hits = await apiGet(`/api/research/kb/search?q=${encodeURIComponent(q)}`);
    const box = rootEl.querySelector('#rs-kb-hits');
    if (!hits.length) { box.innerHTML = '<div class="muted small">未命中</div>'; return; }
    box.innerHTML = hits.map((h) => `
      <div class="rs-kb-hit"><b>${esc(h.title)}</b> <span class="muted small">${esc(h.kind)} · 任务 ${esc(h.source_task_id || '-')}</span>
      <div class="muted small">${esc(String(h.body).slice(0, 120))}</div></div>`).join('');
  } catch (e) { toast(e.message); }
}

async function onSediment() {
  const body = {
    sourceTaskId: rootEl.querySelector('#rs-kb-task').value.trim(),
    title: rootEl.querySelector('#rs-kb-title').value.trim(),
    body: rootEl.querySelector('#rs-kb-body').value.trim(),
    kind: 'evidence',
  };
  try {
    await apiPost('/api/research/kb/documents', body);
    toast('已沉淀进知识库(闭环 B ✓)');
    await refresh();
  } catch (e) { toast(e.message); }
}
