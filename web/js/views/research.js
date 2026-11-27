// research.js — 调研视图（v2.9.90 重设计,业主产品方向）：
//   流程:新建访谈 → 访谈对话 → AI 识别分析自动产出方案(md) → 方案拆解任务 → 闸门 accept。
//   三区:场景列表 | 访谈工作面(中间列,本轮前端优化) | 方案面板(右栏,替代原知识库检索/沉淀)。
import { apiGet, apiPost } from '../api.js';
import { esc, toast, icon } from '../ui.js';

let rootEl = null;
let state = { interviews: [], selectedId: null, detail: null };

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
  renderProposalPanel();
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
      ${(iv.attachments || []).length ? `<div class="rs-att-chips">${iv.attachments.map((a) => `<span class="chip tiny" title="${esc(a.name)} · ${a.bytes}B">${icon('paperclip')} ${esc(a.name)}</span>`).join('')}</div>` : ''}
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
    <div class="rs-drafts">
      <div class="rs-left-h">${icon('inbox')} 任务草稿闸门(${drafts.length})</div>
      ${drafts.length ? drafts.map((dr) => `
        <div class="rs-draft">
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
        </div>`).join('') : '<div class="muted small">暂无草稿——访谈内容足够后,点「生成方案」自动产出方案与任务草稿</div>'}
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
      send.disabled = true;
      text.disabled = true;
      try {
        const r = await apiPost(`/api/research/interviews/${state.selectedId}/messages`, { text: v });
        if (r && r.aiMessage && r.aiMessage.kind === 'parse_error') toast('模型返回无法解析,已留痕');
        if (r && r.drafts && r.drafts.length) toast(`产出 ${r.drafts.length} 条草稿`);
        await openDetail(state.selectedId, { silent: true });
      } catch (e) { toast(e.message); }
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
      const r = await apiPost(`/api/research/interviews/${state.selectedId}/proposal`, {});
      toast('方案已产出(右栏)');
      await openDetail(state.selectedId, { silent: true });
    } catch (e) { toast(e.message); gen.disabled = false; }
  });
  const dec = main.querySelector('#rs-decompose');
  if (dec) dec.addEventListener('click', async () => {
    dec.disabled = true;
    try {
      const r = await apiPost(`/api/research/interviews/${state.selectedId}/decompose`, {});
      toast(`方案拆解出 ${r.drafts.length} 条草稿,待闸门确认`);
      await openDetail(state.selectedId, { silent: true });
    } catch (e) { toast(e.message); dec.disabled = false; }
  });
  // v2.9.91 语音输入(Web Speech API,浏览器原生;不支持时隐藏麦克风)
  const mic = main.querySelector('#rs-mic');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (mic && !SR) mic.hidden = true;
  if (mic && SR) {
    let recog = null;
    mic.addEventListener('click', () => {
      if (recog) { recog.stop(); return; }
      const r = new SR();
      r.lang = 'zh-CN';
      r.interimResults = true;
      const base = text ? text.value : '';
      r.onresult = (ev) => {
        let finalText = '';
        let interim = '';
        for (const res of ev.results) {
          if (res.isFinal) finalText += res[0].transcript;
          else interim += res[0].transcript;
        }
        if (text) text.value = (base ? base + ' ' : '') + finalText + interim;
      };
      r.onend = () => { recog = null; mic.classList.remove('recording'); };
      r.onerror = () => { recog = null; mic.classList.remove('recording'); toast('语音识别失败,请用键盘输入'); };
      recog = r;
      mic.classList.add('recording');
      mic.title = '录音中…点击停止';
      r.start();
    });
  }
  // v2.9.91 附件上传:选择即传(base64 JSON),成功后显示芯片;发送时附件已在库
  const clip = main.querySelector('#rs-paperclip');
  const fileInput = main.querySelector('#rs-file');
  if (clip && fileInput) {
    clip.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      for (const f of fileInput.files) {
        if (f.size > 8 * 1024 * 1024) { toast(`附件 ${f.name} 超过 8MB 上限`, 'error'); continue; }
        try {
          const b64 = await new Promise((resolve, reject) => {
            const rd = new FileReader();
            rd.onload = () => resolve(String(rd.result).split(',')[1] || '');
            rd.onerror = () => reject(new Error('读取失败'));
            rd.readAsDataURL(f);
          });
          await apiPost(`/api/research/interviews/${state.selectedId}/attachments`, { name: f.name, dataBase64: b64 });
          toast(`附件 ${f.name} 已上传`);
        } catch (e) { toast(`附件 ${f.name} 上传失败: ${e.message}`); }
      }
      fileInput.value = '';
      await openDetail(state.selectedId, { silent: true });
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
        const task = await apiPost('/api/tasks', { title: dr.payload.title, desc: dr.payload.desc, priority: dr.payload.priority, projectDir: (state.detail.interview.projectDir || ''), origin: { source: 'research', interviewId: state.detail.interview.id, quote: dr.quote } });
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
