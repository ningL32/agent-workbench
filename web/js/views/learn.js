// 学习视图：知识库（只读）→ 每日一个**知识点**（术语/概念/机制）→ 先测 → 费曼 → 5-why → 迁移 → 遗忘曲线
//
// 设计要点（docs/SPEC-LEARN.md）：
//  - 学习单元是**原子知识点**，不是 wiki 页面；题面必须点名术语
//  - **先测后学**：第一步只给问题不给材料；提交后才显示知识点卡片（服务端在 turn 响应里给）
//  - 会话状态在服务端（data/learn/sessions.json）：刷新不丢，同知识点同日复用
//  - 引擎失败时服务端已降级（degraded / chainFallback），前端分别提示
import { apiGet, apiPost } from '../api.js';
import { esc, toast, icon, startPolling, openModal } from '../ui.js';

let rootEl = null;
let stopPoll = null;
let status = null;
let session = null;
let queue = [];
let tab = 'today';

const STAGE_LABEL = { study: '读材料', recall: '先测', feynman: '费曼讲解', why5: '五问', transfer: '迁移', done: '完成' };

export async function render(el) {
  rootEl = el;
  el.innerHTML = `
    <div class="act-chips learn-tabs" role="group" aria-label="学习视图切换">
      <button type="button" class="chip on" data-tab="today">${icon('book-open')}<span>今日</span></button>
      <button type="button" class="chip" data-tab="library"><span>知识点</span></button>
      <button type="button" class="chip" data-tab="stats"><span>统计</span></button>
    </div>
    <div class="panelbox" id="learn-body"><div class="loading">加载中…</div></div>`;
  el.querySelector('.learn-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b || b.dataset.tab === tab) return;
    tab = b.dataset.tab;
    el.querySelectorAll('.learn-tabs .chip').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
    draw();
  });
  await refresh();
  stopPoll = startPolling(() => { if (!session && tab === 'today') refresh(); }, 120000);
}

export function destroy() {
  rootEl = null;
  session = null;
  status = null;
  queue = [];
  if (stopPoll) { stopPoll(); stopPoll = null; }
}

function setBody(html) {
  const body = rootEl && rootEl.querySelector('#learn-body');
  if (body) body.innerHTML = html;
}

async function refresh() {
  if (!rootEl) return;
  try {
    status = await apiGet('/api/learn/status');
  } catch (e) {
    setBody(`<div class="loading err">学习状态加载失败：${esc(e.message)}</div>`);
    return;
  }
  if (!status.configured) {
    drawSetup();
    return;
  }
  if (tab === 'today' && !session) await loadToday();
  else draw();
}

// ---------- 初始化向导（陌生库三步接入） ----------

function drawSetup(result) {
  const cur = (status && status.root) || '';
  setBody(`
    <div class="learn-setup">
      <h4>${icon('book-open')}先把知识库接进来</h4>
      <p class="muted">三步：<b>选目录 → 看探测结果 → 试抽一页确认颗粒度</b>。全程只读，不会改你的笔记。</p>
      <div class="learn-setup-row">
        <input id="learn-setup-root" class="mono" placeholder="E:\\我的笔记  或  /Users/me/notes" value="${esc(cur)}">
        <button type="button" class="btn" id="learn-setup-probe">探测</button>
      </div>
      <div id="learn-setup-out">${result || ''}</div>
    </div>`);

  const input = rootEl.querySelector('#learn-setup-root');
  const probeBtn = rootEl.querySelector('#learn-setup-probe');
  const out = rootEl.querySelector('#learn-setup-out');

  const probe = async () => {
    const root = (input && input.value || '').trim();
    if (!root) { toast('先填知识库目录', 'error'); return; }
    probeBtn.disabled = true;
    out.innerHTML = `<div class="loading">探测中（只读，不写任何东西）…</div>`;
    try {
      const p = await apiPost('/api/learn/probe', { root });
      if (!p.ok) { out.innerHTML = `<div class="learn-setup-err">✗ ${esc(p.reason || '无法读取该目录')}</div>`; return; }
      renderProbe(p);
    } catch (e) {
      out.innerHTML = `<div class="learn-setup-err">✗ ${esc(e.message)}</div>`;
    } finally {
      probeBtn.disabled = false;
    }
  };

  const renderProbe = (p) => {
    const f = p.counts.filtered || {};
    const rows = (p.topDirs || []).map((d) => `
      <label class="learn-scope-row"><input type="checkbox" value="${esc(d.rel)}" checked>
        <span>${esc(d.rel)}</span><span class="muted small">${d.count} 篇</span></label>`).join('');
    out.innerHTML = `
      <div class="learn-probe">
        <div class="learn-kv">
          <span>库类型</span><b>${p.flavor === 'llm-wiki' ? 'LLM Wiki（识别到 AGENTS.md）' : '普通 Markdown 库'}</b>
          <span>可学文档</span><b>${p.counts.md} 篇</b>
          <span>会自动跳过</span><b>${p.counts.filteredTotal || 0} 个（_前缀 ${f.underscore || 0} / README ${f.readme || 0} / outputs ${f.outputs || 0} / en.md ${f.en || 0}）</b>
        </div>
        <div class="muted small">学习范围（默认全选有内容的顶层目录）：</div>
        <div class="learn-scope-list">${rows || '<span class="muted small">根目录下就这些文档</span>'}</div>
        <div class="learn-actions">
          <button type="button" class="btn" id="learn-setup-init">开始初始化（并试抽一页）</button>
          <span class="muted small">初始化只读取，不写入你的库</span>
        </div>
      </div>`;
    rootEl.querySelector('#learn-setup-init').addEventListener('click', () => init(p));
  };

  const init = async (p) => {
    const boxes = Array.from(rootEl.querySelectorAll('.learn-scope-list input[type=checkbox]'));
    const scope = boxes.filter((b) => b.checked).map((b) => b.value);
    if (boxes.length && !scope.length) { toast('至少选一个目录', 'error'); return; }
    const btn = rootEl.querySelector('#learn-setup-init');
    btn.disabled = true;
    btn.textContent = '初始化中：建索引 + 试抽一页…';
    try {
      const r = await apiPost('/api/learn/init', {
        root: p.root,
        scope: scope.length ? scope : undefined,
        dailyNew: 3,
        sample: true,
      });
      renderInit(r);
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = '开始初始化（并试抽一页）';
    }
  };

  const renderInit = (r) => {
    const cs = (r.sample && r.sample.concepts) || [];
    out.innerHTML = `
      <div class="learn-probe">
        <div class="learn-kv">
          <span>结果</span><b>✓ 已接入 ${r.pages} 篇文档${r.flavor === 'llm-wiki' ? '' : '（普通 Markdown 库）'}</b>
          <span>范围</span><b>${esc((r.scope || []).join(' / '))}</b>
        </div>
        ${cs.length ? `<div class="muted small">试抽预览（来自 <span class="mono">${esc(r.sample.page)}</span>，确认没问题就开工）：</div>
          <ul class="learn-sample">${cs.map((c) => `<li><b>${esc(c.term)}</b> — ${esc(c.definition)}</li>`).join('')}</ul>`
          : `<div class="learn-setup-err">试抽没成功：${esc((r.sampleError || '引擎不可用'))}。接入已完成，稍后可在「今日」重试。</div>`}
        <div class="learn-actions">
          <button type="button" class="btn" id="learn-setup-done">开始学习</button>
        </div>
      </div>`;
    rootEl.querySelector('#learn-setup-done').addEventListener('click', () => refresh());
  };

  probeBtn.addEventListener('click', probe);
  if (input) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') probe(); });
    input.focus();
  }
}

async function loadToday() {
  try {
    const r = await apiGet('/api/learn/today');
    queue = (r && r.queue) || [];
    if (r && r.status) status = r.status;
  } catch (e) {
    setBody(`<div class="loading err">${esc(e.message)}</div>`);
    return;
  }
  draw();
}

function draw() {
  if (!rootEl) return;
  if (tab === 'library') return drawLibrary();
  if (tab === 'stats') return drawStats();
  if (session) return drawSession();
  drawToday();
}


function staleBanner() {
  const v = (status && status.version) || {};
  if (!v.stale) return '';
  return `<div class="learn-stale">${icon('alert-triangle')}实例运行 v${esc(v.loaded)}，仓库已是 v${esc(v.disk)}——新接口要重启插件实例才生效（下面的按钮可能点不动）</div>`;
}

// ---------- 今日 ----------

function drawToday() {
  const st = status || {};
  const c = st.counts || {};
  const head = `
    <div class="learn-head">
      <span class="muted small">到期 ${c.due || 0} · 未学知识点 ${c.fresh || 0} · 待抽取页面 ${c.pagesPending || 0} · 今日已完成 ${st.todayDone || 0}</span>
      <span class="spacer"></span>
      <button type="button" class="btn ghost xs" id="learn-scan-top">${icon('refresh-cw')}重建索引</button>
    </div>`;

  if (!queue.length) {
    setBody(`${staleBanner()}${head}<div class="empty-state">${icon('check-circle')}
      <span>今天没有到期的知识点，也没有新的了。点「重建索引」重新扫一遍知识库，或去「知识点」页看看已有哪些。</span></div>`);
    bindScan();
    return;
  }

  const cards = queue.map((q, i) => `
    <div class="learn-card">
      <div class="learn-card-top">
        <span class="chip tiny">${q.reason === 'due' ? '复习' : '新'}</span>
        <b>${esc(q.item.term || q.item.title)}</b>
        <span class="spacer"></span>
        <span class="muted small">${q.level ? `掌握度 ${q.level}/3` : '未学'}${q.dueAt ? ` · 到期 ${esc(q.dueAt)}` : ''}</span>
      </div>
      <div class="muted small">来源：《${esc(q.item.pageTitle || '')}》<span class="mono">${esc(q.item.sourcePath || '')}</span></div>
      <div class="learn-actions"><button type="button" class="btn" data-start="${i}">开始（约 5 分钟）</button></div>
    </div>`).join('');

  setBody(`${staleBanner()}${head}<div class="learn-list">${cards}</div>
    <div class="muted small" style="margin-top:10px">顺序：先测（不给材料）→ 费曼讲解 → 五问 → 迁移题。一次只学一个知识点，中途刷新不丢。</div>`);

  rootEl.querySelectorAll('[data-start]').forEach((b) => {
    b.addEventListener('click', () => startSession(queue[Number(b.dataset.start)].item.id));
  });
  bindScan();
}

async function startSession(itemId) {
  try {
    const s = await apiPost('/api/learn/session', { itemId });
    session = {
      id: s.id,
      stage: s.stage || 'recall',
      item: s.item,
      question: s.question,
      isReview: s.isReview === true,
      // v2.9.58 修复：新学（study）的材料随建会话响应下发，之前这里硬写 null 把它丢了
      material: s.material || null,
      source: s.source || null,
      feedback: null,
      degraded: false,
      chainFallback: false,
      whyIndex: 0,
      whyTotal: 0,
      root: null,
      result: null,
    };
    draw();
  } catch (e) {
    const msg = String((e && e.message) || '');
    toast(/接口不存在|404/.test(msg) ? '这个功能要重启一下插件实例（后端还是旧进程）' : msg, 'error');
  }
}

// ---------- 会话 ----------

function progressBar(stage, isReview) {
  // 新学从「读材料」开始，复习从「先测」开始（v2.9.60：之前写死 study，复习时进度条与题面互相矛盾）
  const order = isReview ? ['recall', 'feynman', 'why5', 'transfer'] : ['study', 'feynman', 'why5', 'transfer'];
  const idx = order.indexOf(stage === 'done' ? 'transfer' : stage);
  return `<div class="learn-progress">${order.map((s, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'now' : '';
    return `<span class="learn-step ${cls}">${esc(STAGE_LABEL[s])}</span>`;
  }).join('<i>→</i>')}</div>`;
}

function feedbackHtml(fb) {
  if (!fb) return '';
  const row = (label, arr, cls) => (Array.isArray(arr) && arr.length
    ? `<div class="learn-fb-row ${cls}"><b>${label}</b><span>${arr.map((x) => esc(String(x))).join('；')}</span></div>` : '');
  return `<div class="learn-fb">
    ${row('讲对了', fb.good, 'ok')}
    ${row('漏掉了', fb.missing, 'warn')}
    ${row('术语替代', fb.jargon, 'warn')}
    ${row('与材料相反', fb.misconception, 'err')}
    ${fb.probe ? `<div class="learn-fb-row"><b>追问</b><span>${esc(fb.probe)}</span></div>` : ''}
  </div>`;
}

function drawSession() {
  const s = session;
  if (!s) return;
  if (s.stage === 'done') return drawDone();

  const prompts = {
    study: s.question || '先读材料，再用一句话概括。',
    recall: s.question || '先别看资料：这个知识点是什么？',
    feynman: `合上材料，给完全外行解释「${s.item.term || s.item.title}」：不许用这个术语本身，必须有一个类比。`,
    why5: s.question || '为什么？',
    transfer: s.prompt || '举一个知识库之外的例子，并说明它在什么条件下不成立。',
  };

  const material = s.material
    ? `<details class="learn-material" open><summary>学习材料（只读，来自你的知识库）</summary>
         <div class="learn-material-body">${esc(s.material)}</div>
         <div class="learn-material-foot">
           <span class="muted small mono">${esc(s.source || '')}</span>
           ${s.source ? '<button type="button" class="btn ghost xs" id="learn-open-src">查看原文</button>' : ''}
         </div></details>`
    : '';

  const whyMeta = s.stage === 'why5' && s.whyTotal
    ? `<span class="muted small">第 ${s.whyIndex + 1}/${s.whyTotal} 问</span>` : '';

  setBody(`
    <div class="learn-head">
      <b>${esc(s.item.term || s.item.title)}</b>
      <span class="spacer"></span>${whyMeta}
      ${s.degraded ? '<span class="chip tiny warn">本次无 AI 批改</span>' : ''}
      ${s.chainFallback && !s.degraded ? '<span class="chip tiny">五问为通用追问</span>' : ''}
      <span class="muted small">《${esc(s.item.pageTitle || '')}》</span>
    </div>
    ${progressBar(s.stage, s.isReview)}
    <div class="muted small learn-mode-hint">${s.isReview ? '复习模式：先自己回忆（不给材料），提交后才对照原文' : '新学模式：先读材料，再用自己的话讲一遍'}</div>
    ${s.stage === 'feynman' ? feedbackHtml(s.feedback) : ''}
    ${material}
    <div class="learn-q">${esc(prompts[s.stage] || '')}</div>
    <textarea id="learn-answer" class="learn-input" rows="5" placeholder="${s.stage === 'study' ? '读完用一句话概括它讲的是什么（写下来才算数）' : '写下来才算数——不写就没有反馈，也不计入复习计划。'}"></textarea>
    <div class="learn-actions">
      <button type="button" class="btn" id="learn-submit">提交（Ctrl+Enter）</button>
      <button type="button" class="btn ghost" id="learn-quit">稍后再学</button>
      <span class="muted small">AI 批改通常几秒；若明显变慢，别关页面（会话本身已存盘）</span>
    </div>`);

  const ta = rootEl.querySelector('#learn-answer');
  const submit = rootEl.querySelector('#learn-submit');
  if (ta) {
    ta.focus();
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitAnswer(); }
    });
  }
  if (submit) submit.addEventListener('click', submitAnswer);
  const srcBtn = rootEl.querySelector('#learn-open-src');
  if (srcBtn) srcBtn.addEventListener('click', () => openSource(s.source));
  const quit = rootEl.querySelector('#learn-quit');
  if (quit) quit.addEventListener('click', () => { session = null; refresh(); });
}

async function submitAnswer() {
  const s = session;
  const root = rootEl;
  if (!s || !root) return;
  const ta = root.querySelector('#learn-answer');
  const text = ta ? ta.value.trim() : '';
  if (text.length < 2) { toast('先写两句再提交', 'error'); return; }

  const btn = root.querySelector('#learn-submit');
  if (btn) { btn.disabled = true; btn.textContent = '提交中… 0s'; }
  const t0 = Date.now();
  const timer = setInterval(() => {
    const b = rootEl && rootEl.querySelector('#learn-submit');
    if (b) b.textContent = `AI 批改中… ${Math.round((Date.now() - t0) / 1000)}s`;
  }, 1000);
  try {
    const r = await apiPost(`/api/learn/session/${encodeURIComponent(s.id)}/turn`, { stage: s.stage, text });
    applyTurn(r);
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '提交（Ctrl+Enter）'; }
  } finally {
    clearInterval(timer);
  }
}

function applyTurn(r) {
  const s = session;
  if (!s || !r) return;
  s.stage = r.stage;
  if (r.material) s.material = r.material;
  if (r.source) s.source = r.source;
  if (r.feedback) s.feedback = r.feedback;
  if (r.degraded) s.degraded = true;
  if (r.chainFallback) s.chainFallback = true;
  if (r.stage === 'why5') { s.question = r.question; s.whyIndex = r.index || 0; s.whyTotal = r.total || 0; }
  if (r.stage === 'transfer') { s.prompt = r.prompt; s.root = r.root || null; }
  if (r.stage === 'done') s.result = r;
  draw();
}

function drawDone() {
  const r = (session && session.result) || {};
  const levelText = ['基本没懂', '只会复述', '能讲清', '能迁移'][Number(r.level) || 0] || '未知';
  setBody(`
    <div class="learn-done">
      <h4>${icon('check-circle')}本次完成：${esc(levelText)}</h4>
      <div class="learn-kv">
        <span>知识点</span><b>${esc((session && session.item && (session.item.term || session.item.title)) || '')}</b>
        <span>下次复习</span><b>${esc(r.nextReviewAt || '—')}</b>
        <span>间隔</span><b>${Number(r.intervalDays) || 0} 天</b>
        <span>掌握度</span><b>${Number(r.level) || 0}/3</b>
      </div>
      ${r.needsRewrite ? '<p class="muted small warn">这条已连续 3 次没讲清——可能是材料太绕或这个知识点本身不成立，建议换素材（可在「知识点」页剔除）。</p>' : ''}
      ${session && session.degraded ? '<p class="muted small">本次引擎不可用，掌握度由流程推断，未经过 AI 批改。</p>' : ''}
      <div class="learn-actions">
        <button type="button" class="btn" id="learn-next">回到今日</button>
        <button type="button" class="btn ghost" id="learn-lib">去知识点</button>
      </div>
    </div>`);
  rootEl.querySelector('#learn-next').addEventListener('click', () => { session = null; refresh(); });
  rootEl.querySelector('#learn-lib').addEventListener('click', () => {
    session = null;
    tab = 'library';
    rootEl.querySelectorAll('.learn-tabs .chip').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'library'));
    draw();
  });
}

// ---------- 知识点列表 ----------

async function drawLibrary() {
  let items = [];
  try {
    items = await apiGet('/api/learn/items');
  } catch (e) {
    setBody(`<div class="loading err">${esc(e.message)}</div>`);
    return;
  }
  const rows = items.map((it) => `
    <tr class="${it.excluded ? 'learn-excluded' : ''}">
      <td><b>${esc(it.term || it.title)}</b><div class="muted small">${esc(it.definition || '')}</div></td>
      <td class="muted small">《${esc(it.pageTitle || '')}》<div class="mono">${esc(it.sourcePath || '')}</div>
        ${it.sourcePath ? `<button type="button" class="btn ghost xs" data-src="${esc(it.sourcePath)}">读原文</button>` : ''}</td>
      <td>${Number(it.level) || 0}/3</td>
      <td>${it.dueAt ? esc(it.dueAt) : '—'}</td>
      <td>${it.needsRewrite ? '<span class="chip tiny warn">需重写</span>' : ''}</td>
      <td><button type="button" class="btn ghost xs" data-exclude="${esc(it.id)}">${it.excluded ? '恢复' : '剔除'}</button></td>
    </tr>`).join('');

  setBody(`
    <div class="learn-head">
      <span class="muted small">共 ${items.length} 个知识点（剔除后不再出题；只影响本地学习库，不动知识库）</span>
      <span class="spacer"></span>
      <button type="button" class="btn ghost xs" id="learn-scan">${icon('refresh-cw')}重建索引</button>
    </div>
    <div class="learn-table-wrap"><table class="learn-table">
      <thead><tr><th>知识点</th><th>来源页</th><th>掌握</th><th>下次复习</th><th></th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">还没有知识点——回「今日」点一次开始，系统会按需从页面里抽。</td></tr>'}</tbody>
    </table></div>`);

  rootEl.querySelectorAll('[data-src]').forEach((b) => {
    b.addEventListener('click', () => openSource(b.dataset.src));
  });

  rootEl.querySelectorAll('[data-exclude]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await apiPost(`/api/learn/items/${encodeURIComponent(b.dataset.exclude)}/exclude`, {});
        toast('已更新', 'success');
        drawLibrary();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
  bindScan();
}

// ---------- 统计 ----------

async function drawStats() {
  let items = [];
  try {
    items = await apiGet('/api/learn/items');
  } catch (e) {
    setBody(`<div class="loading err">${esc(e.message)}</div>`);
    return;
  }
  const dist = [0, 0, 0, 0];
  for (const it of items) dist[Math.max(0, Math.min(3, Number(it.level) || 0))] += 1;
  const needRewrite = items.filter((it) => it.needsRewrite);
  const today = new Date().toISOString().slice(0, 10);
  const due = items.filter((it) => it.dueAt && it.dueAt <= today).length;
  const c = (status && status.counts) || {};

  setBody(`
    <div class="learn-stats">
      <div class="stat"><b>${items.length}</b><span>知识点</span></div>
      <div class="stat"><b>${c.pages || 0}</b><span>来源页</span></div>
      <div class="stat"><b>${due}</b><span>当前到期</span></div>
      <div class="stat"><b>${(status && status.todayDone) || 0}</b><span>今日已完成</span></div>
    </div>
    <div class="learn-dist">
      ${dist.map((n, i) => `<div class="learn-dist-row"><span>掌握度 ${i}</span><span class="learn-bar"><i style="width:${items.length ? Math.round((n / items.length) * 100) : 0}%"></i></span><b>${n}</b></div>`).join('')}
    </div>
    ${needRewrite.length ? `<div class="learn-needrewrite"><h4>${icon('alert-triangle')}这几条建议换素材或拆小</h4>
      <ul>${needRewrite.map((it) => `<li>${esc(it.term || it.title)} <span class="muted small mono">${esc(it.sourcePath || '')}</span></li>`).join('')}</ul></div>` : ''}
    <div class="muted small" style="margin-top:10px">口径：一个知识点一条调度；「需换素材」= 同一知识点连续 3 次没讲清。数据只在本地 data/learn/，知识库只读。</div>`);
}

function bindScan() {
  const btn = rootEl && rootEl.querySelector('#learn-scan, #learn-scan-top');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await apiPost('/api/learn/scan', {});
      toast(`索引已重建：${r.pages} 个页面待/已抽取知识点`, 'success');
      await refresh();
      if (tab !== 'today') draw();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
async function openSource(pageRel) {
  if (!pageRel) { toast('这条没有本地原文（内置主题）', 'error'); return; }
  try {
    const r = await apiGet('/api/learn/source?page=' + encodeURIComponent(pageRel));
    const box = document.createElement('div');
    box.innerHTML = '<div class="muted small mono" style="margin-bottom:8px">' + esc(r.rel) + (r.truncated ? ' · 已截断（超过 400KB）' : '') + '</div>'
      + '<pre class="learn-src">' + esc(r.content) + '</pre>';
    openModal({ title: '原文 · ' + (r.title || pageRel), body: box, wide: true });
  } catch (e) {
    const msg = String((e && e.message) || '');
    toast(/接口不存在|404/.test(msg) ? '这个功能要重启一下插件实例（后端还是旧进程）' : msg, 'error');
  }
}
