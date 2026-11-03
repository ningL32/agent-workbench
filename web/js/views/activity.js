// F4 团队动态（v2.0 产品化）：actor 头像 + 动词化标题 + 提交说明行 + 相邻提交分组 + 过滤 chips + bot 提交静音
// 既有能力保留：倒序流 + 类型徽标 + matchedTaskIds 跳看板高亮 + 「归属任务」挂接 + 手动刷新 + 60s 轮询
// 契约 v2.0：commit 事件带 sha / messageBody（正文首段 ≤300 字，可空）；branch 事件 actor 可为 null/空（不再合成 unknown）
import { apiGet, apiPost } from '../api.js';
import { state } from '../state.js';
import { esc, toast, openModal, icon, fmtAgo, fmtFull, startPolling, safeHttpUrl, avatarColor, initials, ACTIVITY_TYPES } from '../ui.js';

let rootEl = null;
let stopPoll = null;
let taskTitles = new Map();
let tasks = []; // 全量任务（含 artifacts）：归属弹层的下拉与同链接去重粗查都用它
let members = []; // 名册：actor → 头像配色/显示名（id / giteaLogin / alias 三路匹配）
let currentList = []; // 全量倒序动态（过滤/分组前），归属按钮按 id 找回条目

// 过滤 chips（本地过滤，选中态主色）；未知类型只在「全部」出现。
// 词表双容错：feeds 新词表 commit/pr ∪ 存量老词表 commit_pushed/pr_opened/pr_merged
const ACT_FILTERS = {
  all: { label: '全部', match: () => true },
  commit: { label: '提交', match: (t) => t === 'commit' || t === 'commit_pushed' },
  pr: { label: 'PR', match: (t) => t === 'pr' || t === 'pr_opened' || t === 'pr_merged' },
  branch: { label: '分支', match: (t) => t === 'branch_created' || t === 'branch_deleted' }
};
let curFilter = 'all';
// bot 提交静音（面板头开关，默认开，localStorage 记忆）：屏蔽 title 以 [demo-team] 开头的提交
let muteBot = true;
try { muteBot = localStorage.getItem('fde-act-mute-bot') !== '0'; } catch (e) { /* localStorage 不可用则用默认 */ }
let mutedCount = 0; // 当前筛选下被静音的条数（面板头「已静音 N 条」）

const isCommitType = (t) => t === 'commit' || t === 'commit_pushed';
const isPrType = (t) => t === 'pr' || t === 'pr_opened' || t === 'pr_merged';

// 动态类型 → 成果 kind 契约：pr/commit 词表（含存量名）映射，其余按 commit 兜底
function actKind(type) {
  return isPrType(type) ? 'pr' : 'commit';
}

export async function render(el) {
  rootEl = el;
  el.innerHTML = `
    <div class="panelbox">
      <h4 class="panel-title">
        <span>团队动态 · <span id="act-org" class="muted">Gitea 组织</span></span>
        <span class="spacer"></span>
        <span class="muted small" id="act-updated"></span>
        <button type="button" class="btn ghost small" id="act-refresh">${icon('refresh-cw')}立即刷新</button>
      </h4>
      <div class="act-toolbar">
        <div class="act-chips" id="act-chips" role="group" aria-label="动态类型过滤">
          ${Object.keys(ACT_FILTERS).map((k) =>
            `<button type="button" class="chip${k === curFilter ? ' on' : ''}" data-f="${k}" aria-pressed="${k === curFilter}">${ACT_FILTERS[k].label}</button>`).join('')}
        </div>
        <span class="spacer"></span>
        <span class="switch-line" title="静音 bot 提交：屏蔽标题以 [demo-team] 开头的自动化提交">
          <button type="button" class="switch${muteBot ? '' : ' off'}" id="act-mute" aria-pressed="${muteBot}" aria-label="静音 bot 提交"></button>
          <span class="muted small" id="act-mute-count"></span>
        </span>
      </div>
      <div class="feed" id="act-feed"><div class="loading">加载中…</div></div>
    </div>`;

  const btn = el.querySelector('#act-refresh');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    await load(true);
    if (btn.isConnected) btn.disabled = false;
  });

  // 过滤 chips：本地过滤当前缓存，不重新拉取
  el.querySelector('#act-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || b.dataset.f === curFilter) return;
    curFilter = ACT_FILTERS[b.dataset.f] ? b.dataset.f : 'all';
    el.querySelectorAll('#act-chips .chip').forEach((x) => {
      const on = x.dataset.f === curFilter;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', String(on));
    });
    const feed = rootEl && rootEl.querySelector('#act-feed');
    if (feed) renderFeed(feed, currentList);
  });

  // bot 静音开关：切换本地过滤并记忆；计数同步更新
  el.querySelector('#act-mute').addEventListener('click', (e) => {
    const sw = e.currentTarget;
    muteBot = !muteBot;
    sw.classList.toggle('off', !muteBot);
    sw.setAttribute('aria-pressed', String(muteBot));
    try { localStorage.setItem('fde-act-mute-bot', muteBot ? '1' : '0'); } catch (e2) { /* 忽略 */ }
    const feed = rootEl && rootEl.querySelector('#act-feed');
    if (feed) renderFeed(feed, currentList);
  });

  // 匹配任务链接（事件委托）
  el.querySelector('#act-feed').addEventListener('click', (e) => {
    const a = e.target.closest('.match-link');
    if (!a) return;
    e.preventDefault();
    state.pendingTaskFocus = a.dataset.task;
    if (location.hash !== '#/board') location.hash = '#/board';
  });

  // 「归属任务」按钮（事件委托，按 data-aid 找回当前动态；分组卡内的提交行同样命中）
  el.querySelector('#act-feed').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act=attach]');
    if (!btn) return;
    const act = (currentList || []).find((x) => x.id === btn.dataset.aid);
    if (act) openAttachModal(act);
  });

  await load(false);
  if (!rootEl) return;
  stopPoll = startPolling(() => load(false), 60000);
}

export function destroy() {
  rootEl = null;
  if (stopPoll) { stopPoll(); stopPoll = null; }
  currentList = [];
}

async function load(refresh) {
  const root = rootEl;
  if (!root) return;
  const feed = root.querySelector('#act-feed');
  try {
    const [acts, tsks, mems, cfgView] = await Promise.all([
      apiGet('/api/activities' + (refresh ? '?refresh=1' : '')),
      apiGet('/api/tasks'),
      apiGet('/api/members').catch(() => []), // 名册拉取失败不阻塞动态流：actor 全按未登记降级
      apiGet('/api/settings').catch(() => null) // 来源标示用（GitHub 启用态）；失败降级为只显示 Gitea
    ]);
    if (!rootEl) return;
    tasks = tsks || [];
    members = mems || [];
    taskTitles = new Map(tasks.map((t) => [t.id, t.title]));
    // 来源标示（v2.9）：按实际启用源显示，启用 GitHub 时附组织名便于辨认数据归属
    const orgEl = root.querySelector('#act-org');
    if (orgEl) {
      const gh = cfgView && cfgView.github;
      orgEl.textContent = gh && gh.enabled ? `Gitea · GitHub（${gh.org || 'org 未配置'}）` : 'Gitea 组织';
    }
    // 倒序（服务端应已倒序，客户端兜底排序）
    const list = (acts || []).slice().sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    currentList = list;
    root.querySelector('#act-updated').textContent = `共 ${list.length} 条 · 拉取于 ${fmtAgo(new Date().toISOString())}`;
    renderFeed(feed, list);
  } catch (e) {
    if (feed) feed.innerHTML = `<div class="loading err">${esc(e.message)}</div>`;
    toast(e.message);
  }
}

// ---- v2.0 渲染管线：类型过滤 → bot 静音 → 相邻提交分组 ----
// bot 标记双认（读取时归一，AGENTS 词表纪律）：开源换名 [demo-team] 与存量历史 [teamai]
const BOT_MARKERS = ['[demo-team]', '[teamai]'];
function isBotCommit(a) {
  const title = String((a && a.title) || '').toLowerCase();
  return isCommitType(a.type) && BOT_MARKERS.some((m) => title.startsWith(m));
}

function renderFeed(feed, list) {
  if (!feed) return;
  const f = ACT_FILTERS[curFilter] || ACT_FILTERS.all;
  const filtered = list.filter((a) => f.match(a.type));
  const shown = muteBot ? filtered.filter((a) => !isBotCommit(a)) : filtered;
  mutedCount = filtered.length - shown.length;
  const cnt = rootEl && rootEl.querySelector('#act-mute-count');
  if (cnt) cnt.textContent = `已静音 ${mutedCount} 条`;
  if (!shown.length) {
    feed.innerHTML = `<div class="empty-state">${icon('activity')}<span>${list.length ? '该筛选下暂无动态' : '暂无动态'}</span></div>`;
    return;
  }
  // 相邻合并：同 actor + 同 repo + 同分支 的提交（新旧词表均可）连续出现（≥2 条）→ 合并为一张组卡；
  // 孤条提交回落单条卡（保留「推送了提交到」动词行）。分支一并入键：组头需如实，跨分支合并会谎报分支
  const blocks = [];
  for (const a of shown) {
    const prev = blocks[blocks.length - 1];
    if (isCommitType(a.type)) {
      if (prev && prev.items
        && prev.items[0].actor === a.actor
        && prev.items[0].repo === a.repo
        && prev.items[0].branch === a.branch) {
        prev.items.push(a);
        continue;
      }
      blocks.push({ items: [a] });
    } else {
      blocks.push({ item: a });
    }
  }
  feed.innerHTML = blocks.map((b) => {
    const items = b.items;
    return (items && items.length >= 2) ? groupCardHtml(items) : singleItemHtml(items ? items[0] : b.item);
  }).join('');
}

// ---- actor 头像与显示名 ----
// 名册命中（id / giteaLogin / alias）→ 彩色缩写圆 + 名册显示名；
// actor 空/unknown → 中性机器人图标，绝不显示 "unknown" 字样；名册外的实名 actor → 中性图标 + 原名
function actorInfo(actor) {
  const raw = String(actor == null ? '' : actor).trim();
  if (!raw || /^unknown$/i.test(raw)) return { unknown: true, name: '' };
  const m = members.find((x) => x.id === raw
    || (x.giteaLogin && x.giteaLogin === raw)
    || (x.githubLogin && x.githubLogin === raw)
    || (Array.isArray(x.aliases) && x.aliases.some((al) => String(al).toLowerCase() === raw.toLowerCase())));
  if (m) return { unknown: false, name: m.name, color: avatarColor(m.id), ini: initials(m.name) };
  return { unknown: false, name: raw, color: null, ini: null };
}

function avatarHtml(info) {
  if (info.color) {
    return `<span class="act-avatar" style="background:${info.color}" title="${esc(info.name)}">${esc(info.ini)}</span>`;
  }
  const tip = info.unknown ? '操作者未知' : esc(info.name);
  return `<span class="act-avatar bot" title="${tip}">${icon('bot')}</span>`;
}

// 动词化标题（v2.0）：commit → 「推送了提交到 <repo>/<branch>」、PR → 提交了/合并了 PR、分支 → 创建了/删除了分支
function targetHtml(a) {
  if (!a.repo && !a.branch) return '';
  const text = isCommitType(a.type)
    ? `${a.repo || ''}${a.branch ? '/' + a.branch : ''}`
    : `${a.repo || ''}${a.branch ? ' · ' + a.branch : ''}`;
  return `<span class="mono muted">${esc(text)}</span>`;
}

function verbOf(a) {
  switch (a.type) {
    case 'commit': return '推送了提交到';
    case 'commit_pushed': return '推送了提交到';
    case 'pr': return '更新了 PR';
    case 'pr_opened': return '提交了 PR';
    case 'pr_merged': return '合并了 PR';
    case 'branch_created': return '创建了分支';
    case 'branch_deleted': return '删除了分支';
    default: return '';
  }
}

// 提交说明行：messageBody 非空才渲染；muted 单行截断（CSS ellipsis），title 挂全文
function msgHtml(a) {
  const body = String(a.messageBody || '').trim();
  if (!body) return '';
  return `<div class="fi-msg" title="${esc(body)}">${esc(body)}</div>`;
}

// 原始链接 / 匹配任务 / 归属按钮：单条与组内行共用（safeHttpUrl 仅放行 http/https）
function urlHtmlOf(a) {
  const urlHref = safeHttpUrl(a.url);
  if (!a.url) return '';
  return urlHref
    ? `<a href="${esc(urlHref)}" target="_blank" rel="noreferrer noopener" class="link small" style="margin-left:8px">原始链接</a>`
    : `<span class="muted small" style="margin-left:8px" title="非 http(s) 链接已拦截">原始链接（已拦截）</span>`;
}

function matchesHtmlOf(a) {
  return (a.matchedTaskIds || []).map((tid) =>
    `<a href="#/board" class="match-link" data-task="${esc(tid)}">→ 匹配任务「${esc(taskTitles.get(tid) || tid)}」</a>`).join('');
}

function attachBtnHtml(a) {
  if (!a.url) return '';
  return `<button type="button" class="btn ghost xs act-attach" data-act="attach" data-aid="${esc(a.id || '')}"
      title="把这条动态的链接作为成果挂接到任务">${icon('link')}归属任务</button>`;
}

// 单条动态卡：头像 + 「名 动词 目标」标题行 + 原始 title + 提交说明行
function singleItemHtml(a) {
  const meta = ACTIVITY_TYPES[a.type] || { label: a.type, cls: 'b-dead', color: '#8b93a3', icon: 'git-branch' };
  const info = actorInfo(a.actor);
  const verb = verbOf(a);
  const matches = matchesHtmlOf(a);
  const attachBtn = attachBtnHtml(a);
  return `
    <div class="feed-item line" data-aid="${esc(a.id || '')}">
      ${avatarHtml(info)}
      <div class="fi-body">
        <div class="fi-h">
          <span class="badge ${meta.cls}">${esc(meta.label)}</span>
          ${info.name ? `<b>${esc(info.name)}</b>` : ''}
          ${verb ? `<span class="act-verb">${esc(verb)}</span>` : ''}
          ${targetHtml(a)}
        </div>
        <div class="fi-t">${esc(a.title)}${urlHtmlOf(a)}
          ${matches ? `<div style="margin-top:3px">${matches}</div>` : ''}
        </div>
        ${msgHtml(a)}
        ${attachBtn ? `<div class="fi-actions" style="margin-top:6px">${attachBtn}</div>` : ''}
      </div>
      <span class="t">${fmtAgo(a.occurredAt)}</span>
    </div>`;
}

// 提交组卡：组头「推送了 N 个提交到 <repo>/<branch>」，组内逐条 sha 前 7 位（可点开原链接）+ title
function groupCardHtml(items) {
  const head = items[0];
  const meta = ACTIVITY_TYPES[head.type] || { label: head.type, cls: 'b-dead' };
  const info = actorInfo(head.actor);
  const target = `${head.repo || ''}${head.branch ? '/' + head.branch : ''}`;
  const rows = items.map((a) => {
    const shaFull = String(a.sha || '');
    const sha = (shaFull || String(a.url || '').split('/').filter(Boolean).pop() || '').slice(0, 7);
    const href = safeHttpUrl(a.url);
    const shaHtml = href && sha
      ? `<a class="act-sha mono" href="${esc(href)}" target="_blank" rel="noreferrer noopener" title="${esc(shaFull || sha)} · 打开原始提交">${esc(sha)}</a>`
      : `<span class="act-sha mono muted">${esc(sha || '—')}</span>`;
    const matches = matchesHtmlOf(a);
    const attachBtn = attachBtnHtml(a);
    return `
      <div class="act-commit" data-aid="${esc(a.id || '')}">
        ${shaHtml}
        <span class="ac-title" title="${esc(a.title)}">${esc(a.title)}</span>
        ${matches ? `<span class="ac-matches">${matches}</span>` : ''}
        <span class="t" title="${esc(fmtFull(a.occurredAt))}">${fmtAgo(a.occurredAt)}</span>
        ${msgHtml(a)}
        ${attachBtn ? `<span class="ac-actions">${attachBtn}</span>` : ''}
      </div>`;
  }).join('');
  return `
    <div class="feed-item line act-group" data-aid="${esc(head.id || '')}">
      ${avatarHtml(info)}
      <div class="fi-body">
        <div class="fi-h">
          <span class="badge ${meta.cls}">${esc(meta.label)}</span>
          ${info.name ? `<b>${esc(info.name)}</b>` : ''}
          <span class="act-verb">推送了 ${items.length} 个提交到</span>
          ${target ? `<span class="mono muted">${esc(target)}</span>` : ''}
        </div>
        <div class="act-group-list">${rows}</div>
      </div>
      <span class="t" title="${esc(fmtFull(head.occurredAt))}">${fmtAgo(head.occurredAt)}</span>
    </div>`;
}

// 「归属任务」弹层——动态摘要只读 + 任务下拉 → POST /api/tasks/:id/artifacts
// （url/kind 由动态类型映射/repo 由动态携带）；同 url 已挂接在已知任务时先提示，重复挂同一任务直接拦截
function openAttachModal(a) {
  const kind = actKind(a.type);
  const urlHref = safeHttpUrl(a.url);
  const meta = ACTIVITY_TYPES[a.type] || { label: a.type, cls: 'b-dead' };
  const info = actorInfo(a.actor);
  // 同链接去重粗查（前端按已知任务 artifacts，后端不强校验）
  const dupTask = tasks.find((t) => (t.artifacts || []).some((x) => x.url === a.url));
  const options = tasks.slice()
    .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt))
    .map((t) => `<option value="${esc(t.id)}"${dupTask && t.id === dupTask.id ? ' selected' : ''}>${esc(t.title)}</option>`)
    .join('');
  const box = document.createElement('div');
  box.innerHTML = `
    <div class="attach-summary">
      <div class="fi-h">
        <span class="badge ${meta.cls}">${esc(meta.label)}</span>
        ${info.name ? `<b>${esc(info.name)}</b>` : ''}
        <span class="mono muted">${esc(a.repo || '')}</span>
        <span class="muted small" title="${esc(fmtFull(a.occurredAt))}">${fmtAgo(a.occurredAt)}</span>
      </div>
      <div class="attach-title">${esc(a.title)}</div>
      ${urlHref
        ? `<a class="link small" href="${esc(urlHref)}" target="_blank" rel="noreferrer noopener">${esc(a.url)}</a>`
        : `<span class="muted small" title="非 http(s) 链接会被服务端拒绝">${esc(a.url || '')}</span>`}
    </div>
    <form id="attach-form">
      <div class="form-row"><label>挂接到任务</label>
        <select name="taskId" required aria-label="选择要挂接到的任务">
          <option value="" disabled${dupTask ? '' : ' selected'}>请选择任务（必选）</option>
          ${options}
        </select>
        <div class="hint">挂接后出现在任务详情的「成果」区块与时间轴，验收可溯源</div></div>
      ${dupTask ? `<div class="match-hint warn"><span class="mdot"></span>该链接已挂接在任务《${esc(dupTask.title)}》，重复挂接同一任务会被拦截</div>` : ''}
      <div class="form-err" id="attach-form-err"></div>
      <div class="modal-actions">
        <span class="muted small">成果类型：${kind === 'pr' ? 'PR' : 'commit'}（由动态类型映射）</span>
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="submit" class="btn">${icon('link')}挂接</button>
      </div>
    </form>`;
  const m = openModal({ title: '归属任务', body: box });
  const errEl = box.querySelector('#attach-form-err');
  const showErr = (msg) => { errEl.textContent = msg; errEl.classList.add('show'); };
  box.querySelector('[data-act=cancel]').addEventListener('click', m.close);
  box.querySelector('#attach-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.classList.remove('show');
    const tid = e.target.elements.namedItem('taskId').value;
    if (!tid) { showErr('请选择要挂接到的任务'); return; }
    const target = tasks.find((t) => t.id === tid);
    if (!target) { showErr('任务不存在，请刷新后重试'); return; }
    // 前端兜底：同任务已挂接过同 url 不再发请求（后端契约不强校验）
    if ((target.artifacts || []).some((x) => x.url === a.url)) {
      showErr(`任务《${target.title}》已挂接过此链接，无需重复挂接`);
      return;
    }
    try {
      await apiPost(`/api/tasks/${encodeURIComponent(tid)}/artifacts`, {
        url: a.url,
        kind,
        repo: a.repo || null,
        // ref 从链接尾段提取（commit 哈希 / PR 序号），提取失败省略
        ref: (() => { try { return decodeURIComponent((a.url || '').split('/').filter(Boolean).pop() || ''); } catch { return ''; } })() || null
      });
      m.close();
      toast(`已挂接到任务《${target.title}》`, 'success');
      await load(false); // 刷新任务缓存（去重粗查同步）与动态列表
    } catch (err) {
      showErr(`${err.code ? `${err.code}: ` : ''}${err.message}`);
    }
  });
}
