// F5 成员进度 + 成员名册管理：六列表格 + 状态徽标（working/idle/stale→超阈值升红）+ 进度条 + 汇总卡 + 10s 轮询
// 名册管理：manual:true 行可编辑/删除（弹层表单，400/409 错误码+文案直出）；manual:false 行只读徽标
import { apiGet, apiPost, apiPatch, apiDel } from '../api.js';
import { esc, toast, openModal, confirmModal, icon, fmtSec, fmtAgo, fmtFull, avatarColor, initials, startPolling, dueBadge, busyBtn } from '../ui.js';

let rootEl = null;
let stopPoll = null;
let cache = { members: [], warnSec: 14400, dangerSec: 86400 };
let memTab = 'agent'; // 分组：硅基(agent) | 人类(human)，记忆上次选择
try { if (localStorage.getItem('fde-members-tab') === 'human') memTab = 'human'; } catch (e) { /* localStorage 不可用则用默认 */ }

// busyBtn：提交/点击型操作的 busy 锁（SPEC-UX v2.1 §4-E）——进入即 disabled、finally 恢复、异常必解锁。
// 注意：ui.js 并行岗将导出同名实现，集成时换 ui.js 导出（签名一致）

export async function render(el) {
  rootEl = el;
  el.innerHTML = `
    <div class="stats" id="mem-stats"><div class="loading">加载中…</div></div>
    <div class="panelbox">
      <h4 class="panel-title">
        <span>成员进度</span>
        <span class="muted small" id="mem-rule"></span>
        <span class="spacer"></span>
        <button type="button" class="btn small" id="mem-add">${icon('plus')}新增成员</button>
        <button type="button" class="btn ghost small" id="mem-refresh">${icon('refresh-cw')}刷新</button>
      </h4>
      <div class="seg" id="mem-tabs" role="tablist" aria-label="成员分组" style="margin:0 14px 10px">
        <button type="button" class="seg-btn" data-tab="agent" role="tab">硅基 <span class="n" id="mem-tab-agent" style="opacity:.65;margin-left:2px"></span></button>
        <button type="button" class="seg-btn" data-tab="human" role="tab">人类 <span class="n" id="mem-tab-human" style="opacity:.65;margin-left:2px"></span></button>
        <span id="mem-src-health" style="margin-left:auto;align-self:center;margin-right:14px"></span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th style="width:19%">成员</th><th>状态</th><th style="width:24%">当前任务 / 进度</th>
            <th>时效</th><th>今日产出</th><th id="mem-th-sess">会话</th><th style="width:14%">操作</th>
          </tr></thead>
          <tbody id="mem-tbody"><tr><td colspan="${memTab === 'agent' ? 7 : 6}" class="muted">加载中…</td></tr></tbody>
        </table>
      </div>
    </div>`;
  el.querySelector('#mem-refresh').addEventListener('click', refresh);
  el.querySelector('#mem-add').addEventListener('click', () => openMemberModal());
  el.querySelector('#mem-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b || b.getAttribute('data-tab') === memTab) return;
    memTab = b.getAttribute('data-tab');
    try { localStorage.setItem('fde-members-tab', memTab); } catch (e2) { /* 忽略 */ }
    renderAll();
  });
  // 行内操作走事件委托：轮询只重绘 tbody，监听挂在 tbody 元素上不丢失
  el.querySelector('#mem-tbody').addEventListener('click', onRowClick);
  await refresh();
  if (!rootEl) return;
  stopPoll = startPolling(refresh, 10000);
}

export function destroy() {
  rootEl = null;
  if (stopPoll) { stopPoll(); stopPoll = null; }
}

async function refresh() {
  const root = rootEl;
  if (!root) return;
  try {
    // 时效阈值取自 /api/settings（gitea.staleWarnSec / staleDangerSec）
    const [members, settings] = await Promise.all([apiGet('/api/members'), apiGet('/api/settings').catch(() => null)]);
    if (!rootEl) return;
    cache.members = members || [];
    cache.warnSec = (settings && settings.gitea && settings.gitea.staleWarnSec) || 14400;
    cache.dangerSec = (settings && settings.gitea && settings.gitea.staleDangerSec) || 86400;
    renderAll();
    drawSourceHealth(); // 桌面源健康徽标（独立轻探针，失败静默不拖垮成员表）
  } catch (e) {
    const tbody = root.querySelector('#mem-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="${memTab === 'agent' ? 7 : 6}" class="loading err">${esc(e.message)}</td></tr>`;
    toast(e.message);
  }
}

// 桌面源健康徽标（N/N 源正常，title 逐源 detail；与智能体动态页同款语义）——
// 治「桌面源故障时成员静默缺席无信号」（2026-11-03 评审尾巴）
function drawSourceHealth() {
  const root = rootEl;
  if (!root) return;
  const elH = root.querySelector('#mem-src-health');
  if (!elH) return;
  apiGet('/api/members/source-health').then((list) => {
    if (!rootEl) return;
    const sources = Array.isArray(list) ? list.filter((s) => s && s.enabled !== false) : [];
    const target = root.querySelector('#mem-src-health');
    if (!target) return;
    if (!sources.length) { target.innerHTML = ''; return; }
    const okCnt = sources.filter((s) => s.ok).length;
    const allOk = okCnt === sources.length;
    const title = sources.map((s) => `${s.id}：${s.ok ? '正常' : (s.detail || '失败')}`).join('\n');
    target.innerHTML = `<span class="badge ${allOk ? 'b-alive' : 'st-stale'}" title="${esc(title)}&#10;最近扫描：${esc(fmtFull(sources[0].scannedAt))}">${okCnt}/${sources.length} 源正常</span>`;
  }).catch(() => { /* 探针失败不拖垮成员表，徽标维持空白 */ });
}

function onRowClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = btn.closest('tr[data-id]');
  const m = cache.members.find((x) => x.id === (row && row.dataset.id));
  if (!m) return;
  if (btn.dataset.act === 'edit') openMemberModal(m);
  else if (btn.dataset.act === 'del') deleteMember(m);
}

async function deleteMember(m) {
  const ok = await confirmModal(`ID：${m.id}，该操作不可恢复。`, { title: `删除成员「${m.name}」？` });
  if (!ok) return;
  try {
    await apiDel(`/api/members/${encodeURIComponent(m.id)}`);
    toast('成员已删除', 'success');
    refresh();
  } catch (e) {
    toast(e.message); // 409 MEMBER_IMMUTABLE（派生条目不可删）红色 toast 直出
  }
}

function isDanger(m) {
  return m.status === 'stale' && !!(m.currentTask && m.currentTask.sinceUpdateSec > cache.dangerSec);
}

function renderAll() {
  const root = rootEl;
  if (!root) return;
  const ms = cache.members;
  const nAgent = ms.filter((m) => m.kind === 'agent').length;
  const nHuman = ms.filter((m) => m.kind === 'human').length;
  const nWorking = ms.filter((m) => m.status === 'working' && m.enabled !== false).length;
  const nIdle = ms.filter((m) => m.status === 'idle' && m.enabled !== false).length;
  const nDanger = ms.filter(isDanger).length;
  const nStale = ms.filter((m) => m.status === 'stale').length;

  root.querySelector('#mem-stats').innerHTML = `
    <div class="stat"><b>${ms.length}</b><span>成员（智能体 ${nAgent} · 人类 ${nHuman}）</span></div>
    <div class="stat"><b style="color:var(--green)">${nWorking}</b><span>工作中</span></div>
    <div class="stat"><b>${nIdle}</b><span>空闲</span></div>
    <div class="stat"><b style="color:${nDanger > 0 ? 'var(--red)' : 'var(--yellow)'}">${nStale}</b>
      <span>超时预警${nDanger > 0 ? `（${nDanger} 个已危险）` : ''}</span></div>`;
  root.querySelector('#mem-rule').textContent =
    `时效规则：进行中 ${fmtSec(cache.warnSec)} 无更新预警 · ${fmtSec(cache.dangerSec)} 无更新危险（阈值取自设置）`;

  // 分组 tab：硅基 | 人类（表格只渲染当前组；汇总卡保持全量口径）。
  // v2.9.68：会话列仅对硅基有意义（人类不产生本机 agent 会话，恒「无会话」= 噪音）——人类 tab 整列隐藏
  const rows = ms.filter((m) => (memTab === 'agent' ? m.kind === 'agent' : m.kind === 'human'));
  const thSess = root.querySelector('#mem-th-sess');
  if (thSess) thSess.hidden = memTab !== 'agent';
  const tabAgent = root.querySelector('#mem-tab-agent');
  const tabHuman = root.querySelector('#mem-tab-human');
  if (tabAgent) tabAgent.textContent = nAgent;
  if (tabHuman) tabHuman.textContent = nHuman;
  root.querySelectorAll('#mem-tabs .seg-btn').forEach((b) => {
    b.classList.toggle('on', b.getAttribute('data-tab') === memTab);
    b.setAttribute('aria-selected', b.getAttribute('data-tab') === memTab ? 'true' : 'false');
  });

  root.querySelector('#mem-tbody').innerHTML = rows.map(memberRow).join('') ||
    `<tr><td colspan="${memTab === 'agent' ? 7 : 6}" class="muted">${memTab === 'agent' ? '暂无硅基成员' : '暂无人类成员'}</td></tr>`;
}

function statusBadge(m) {
  if (m.enabled === false) return '<span class="badge st-off">已停用</span>';
  if (m.status === 'working') return '<span class="badge st-working">工作中</span>';
  if (m.status === 'stale') {
    return isDanger(m) ? '<span class="badge st-danger">超时危险</span>' : '<span class="badge st-stale">超时预警</span>';
  }
  return '<span class="badge st-idle">空闲</span>';
}

// 本批任务日报：diaryToday 两态轻提醒（只提示不阻断）——
// 仅真人行渲染（日报是人的过程留痕，智能体已有会话/提交观测，agent 行不出标记避免整屏噪音）；
// 无进行中任务不提醒；amber=今日未填，绿=已填。写入口在任务详情「日报」区
function diaryBadge(m) {
  if (m.kind !== 'human' || !m.currentTask) return '';
  if (m.currentTask.status === 'done') return '';
  return m.diaryToday
    ? '<span class="badge b-diary-ok" title="今日已填写任务日报">已填</span>'
    : '<span class="badge b-diary-miss" title="今日尚未填写任务日报（轻提醒，不阻断）">今日未填日报</span>';
}

// 操作列：manual:true → 编辑/删除；manual:false → 只读徽标（智能体 / Gitea 同步）
function actionsCell(m) {
  if (m.manual !== true) {
    const badge = m.kind === 'agent'
      ? '<span class="badge b-agent">智能体</span>'
      : '<span class="badge b-ro">Gitea 同步</span>';
    return `<td class="mem-actions-cell">${badge}</td>`;
  }
  return `
    <td class="mem-actions-cell"><span class="mem-actions">
      <button type="button" class="btn ghost xs" data-act="edit">${icon('pencil')}编辑</button>
      <button type="button" class="btn danger xs" data-act="del">${icon('trash')}删除</button>
    </span></td>`;
}

function memberRow(m) {
  const color = avatarColor(m.id);
  const kindLabel = (m.kind === 'human' ? '人类' : '智能体') + (m.role ? ` · ${esc(m.role)}` : '') +
    (m.giteaLogin ? ` · <span class="mono">${esc(m.giteaLogin)}</span>` : '');
  const ct = m.currentTask;
  const off = m.enabled === false;

  let taskCell = '<span class="muted">—</span>';
  let timeCell;
  let progClass = '';
  if (isDanger(m)) progClass = ' danger';
  else if (m.status === 'stale') progClass = ' warn';

  if (ct) {
    const pct = Math.round((Number(ct.progress) || 0) * 100);
    taskCell = `
      <div class="task-line">${esc(ct.title)} ${dueBadge(ct.dueDate)}
        <span class="mono muted" title="${esc(ct.id)}">${esc(ct.id.length > 14 ? ct.id.slice(0, 13) + '…' : ct.id)}</span></div>
      <div class="prog"><span class="${progClass.trim()}" style="width:${pct}%"></span></div>`;
    const updCls = isDanger(m) ? 'st-danger' : (m.status === 'stale' ? '' : 'st-working');
    const updStyle = isDanger(m) ? 'color:var(--red)' : (m.status === 'stale' ? 'color:var(--yellow)' : 'color:var(--green)');
    timeCell = `已进行 ${fmtSec(ct.ageSec)}<br><span style="${updStyle}">最近更新 ${fmtSec(ct.sinceUpdateSec)}前</span>`;
  } else {
    timeCell = `上次活跃 ${fmtAgo(m.lastActivityAt)}`;
  }

  const outCell = `${Number(m.todayCommits) || 0} 提交 · ${Number(m.openPrs) || 0} PR` +
    (m.weekDone ? `<br><span class="muted">本周完成 ${m.weekDone}</span>` : '');

  let sessCell = '';
  if (memTab === 'agent') {
    // 会话列仅硅基 tab 渲染（人类不产生本机 agent 会话）
    sessCell = '<span class="badge b-dead">无会话</span>';
    if (m.session) {
      // 桌面 agent 会话是长 UUID（workbuddy），截 13 字符展示，全文走 title
      const sid = m.session.id || '';
      const sidShort = sid.length > 14 ? sid.slice(0, 13) + '…' : sid;
      sessCell = m.session.alive
        ? `<span class="badge b-alive mono" title="${esc(sid)}">${esc(sidShort)}</span>`
        : `<span class="badge b-dead mono" title="${esc(sid)}">${esc(sidShort)} 已退出</span>`;
    }
  }

  return `
    <tr data-id="${esc(m.id)}"${off ? ' class="row-off"' : ''}>
      <td><div class="member-cell">
        <span class="avatar" style="background:${color}">${esc(initials(m.name))}</span>
        <div><b>${esc(m.name)}</b><div class="muted" style="font-size:11px">${kindLabel}</div></div>
      </div></td>
      <td><span class="st-line">${statusBadge(m)}${diaryBadge(m)}</span></td>
      <td>${taskCell}</td>
      <td style="font-size:12px">${timeCell}</td>
      <td style="font-size:12px">${outCell}</td>
      ${memTab === 'agent' ? `<td>${sessCell}</td>` : ''}
      ${actionsCell(m)}
    </tr>`;
}

// 成员新增/编辑弹层（同一表单；编辑时 id 只读 + enabled 停用开关；错误码+文案直出弹层内）
function openMemberModal(member = null) {
  const isEdit = !!member;
  const box = document.createElement('div');
  box.innerHTML = `
    <form id="member-form">
      <div class="form-row"><label class="req">ID（唯一，小写字母开头）</label>
        <input name="id" maxlength="32" ${isEdit ? `readonly value="${esc(member.id)}"` : 'placeholder="如 wang.lei"'} required></div>
      <div class="form-row"><label class="req">名称</label>
        <input name="name" maxlength="50" required value="${esc(member ? member.name : '')}" placeholder="如 王磊"></div>
      <div class="form-row"><label>角色</label>
        <input name="role" maxlength="50" value="${esc(member ? member.role : '')}" placeholder="如 前端 / 测试"></div>
      <div class="form-row"><label>Gitea 账号（用于动态流归人）</label>
        <input name="giteaLogin" maxlength="50" value="${esc(member ? member.giteaLogin : '')}" placeholder="如 wanglei"></div>
      ${isEdit ? `
      <div class="form-row"><label>启用状态</label>
        <span class="switch-line">
          <button type="button" class="switch${member.enabled === false ? ' off' : ''}" id="mem-enabled"
            aria-pressed="${member.enabled !== false}" aria-label="成员启停开关"></button>
          <span class="muted small" id="mem-enabled-tip">${member.enabled === false ? '已停用' : '已启用'}</span>
        </span></div>` : ''}
      <div class="form-err" id="member-form-err"></div>
      <div class="modal-actions">
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="submit" class="btn">${isEdit ? '保存修改' : '新增成员'}</button>
      </div>
    </form>`;
  const m = openModal({ title: isEdit ? `编辑成员 · ${member.name}` : '新增成员', body: box });
  const errEl = box.querySelector('#member-form-err');
  const showErr = (err) => {
    errEl.textContent = `${err && err.code ? err.code : 'ERROR'}: ${(err && err.message) || String(err)}`;
    errEl.classList.add('show');
  };

  box.querySelector('[data-act=cancel]').addEventListener('click', m.close);

  const sw = box.querySelector('#mem-enabled');
  if (sw) {
    sw.addEventListener('click', () => {
      const on = sw.getAttribute('aria-pressed') !== 'true';
      sw.setAttribute('aria-pressed', String(on));
      sw.classList.toggle('off', !on);
      box.querySelector('#mem-enabled-tip').textContent = on ? '已启用' : '已停用';
    });
  }

  box.querySelector('#member-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    // busy 锁：await 期间提交按钮 disabled，双击只发一次（§4-E）
    busyBtn(f.querySelector('[type=submit]'), async () => {
      // form.id/form.name 与 HTMLElement 内建属性冲突，必须走 elements.namedItem
      const val = (n) => f.elements.namedItem(n).value;
      errEl.classList.remove('show');
      const id = val('id').trim();
      const name = val('name').trim();
      const role = val('role').trim();
      const giteaLogin = val('giteaLogin').trim();
      try {
        if (!isEdit) {
          // id 规则与后端 lib/members.js 一致（pattern 属性在部分引擎的 v-flag 下会抛 SyntaxError 且静默失效）
          if (!/^[a-z][a-z0-9.-]{0,31}$/.test(id)) {
            showErr({ code: 'MEMBER_INVALID', message: 'id 必填且须匹配 ^[a-z][a-z0-9.-]{0,31}$（小写字母开头，可含小写字母/数字/点/连字符）' });
            return;
          }
        }
        if (isEdit) {
          await apiPatch(`/api/members/${encodeURIComponent(member.id)}`, {
            name, role, giteaLogin: giteaLogin || null,
            enabled: sw ? sw.getAttribute('aria-pressed') === 'true' : true
          });
          toast('成员已更新', 'success');
        } else {
          await apiPost('/api/members', { id, name, role, giteaLogin: giteaLogin || null });
          toast('成员已新增', 'success');
        }
        m.close();
        refresh();
      } catch (err) {
        showErr(err); // 400 MEMBER_INVALID / 409 MEMBER_EXISTS 等错误码+文案直出
        toast(err.message);
      }
    });
  });
}
