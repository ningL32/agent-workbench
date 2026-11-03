// mock 后端：加载 web/mock.json 到内存，按 §3 契约处理全部 /api/* 请求（零出网）
// 写操作直接改内存副本，便于在 mock 模式下完整演示增删改与错误分支
import { ApiError, registerMock } from './api.js';

let db = null;
const bootMs = Date.now();
// v1.7：completedAt（任务完成时间）/ decidedAt（候选决定时间）一并按锚点平移，保证 30 天统计窗口演示数据恒新鲜
const DATE_KEY = /^(createdAt|updatedAt|occurredAt|fetchedAt|startedAt|lastPollAt|lastActivityAt|completedAt|decidedAt)$/;

const clone = (v) => JSON.parse(JSON.stringify(v));
const nowIso = () => new Date().toISOString();
const genTaskId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const genColId = () => `col-${Math.random().toString(16).slice(2, 4)}`;

// ---- dueDate / priority 契约（v1.4）----
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITIES = ['high', 'medium', 'low'];
const p2 = (n) => String(n).padStart(2, '0');
const localYMD = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
// 手工拆解构造（不用 Date.parse）：纯日期串按 UTC 解析会在东八区偏移一天
const parseYMD = (s) => {
  if (typeof s !== 'string' || !YMD_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) ? dt : null;
};
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
// dueDate 距今天的天数（负=逾期）；非法输入返回 null
const dueDayDiff = (ymd) => {
  const d = parseYMD(ymd);
  return d ? Math.round((d.getTime() - today0().getTime()) / 86400000) : null;
};
const validDueDate = (v) => v === null || v === undefined || parseYMD(v) !== null;

function shiftDates(o, delta) {
  if (Array.isArray(o)) { o.forEach((x) => shiftDates(x, delta)); return; }
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string' && DATE_KEY.test(k) && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
        const t = Date.parse(v);
        if (!isNaN(t)) o[k] = new Date(t + delta).toISOString();
      } else {
        shiftDates(v, delta);
      }
    }
  }
}

async function load() {
  if (db) return db;
  const url = new URL('../mock.json', import.meta.url);
  let text;
  if (url.protocol === 'file:') {
    // Node 直测用（浏览器永不走此分支）
    text = (await import('node:fs')).readFileSync(url, 'utf8');
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`mock.json 加载失败（HTTP ${res.status}）`);
    text = await res.text();
  }
  db = JSON.parse(text);
  const base = Date.parse((db.overview && db.overview.gitea && db.overview.gitea.lastPollAt) || '') || 0;
  const delta = Math.max(0, Date.now() - base);
  if (delta > 0) shiftDates(db, delta);
  // dueDate 以 dueAnchor 为书写基准日，加载时按「天数差不变」平移到今天——
  // 逾期/今天到期/明天到期等徽标状态不随真实日期流逝而失效（演示数据恒可用）
  const anchor = parseYMD(db.dueAnchor);
  for (const t of db.tasks || []) {
    if (!PRIORITIES.includes(t.priority)) t.priority = 'medium'; // 契约：缺省 medium
    // v1.7：events[].at 键名太通用（'at' 会误伤听记 speakerSegments），不进 DATE_KEY，这里按同一 delta 平移
    for (const ev of t.events || []) {
      const ts = Date.parse(ev.at);
      if (!isNaN(ts)) ev.at = new Date(ts + delta).toISOString();
    }
    // 叙事线第一批：artifacts[].at 同 events 口径平移，保证演示数据时间恒新鲜
    for (const art of t.artifacts || []) {
      const ts = Date.parse(art.at);
      if (!isNaN(ts)) art.at = new Date(ts + delta).toISOString();
    }
    const td = parseYMD(t.dueDate);
    if (!td) continue;
    if (!anchor) continue;
    const days = Math.round((td.getTime() - anchor.getTime()) / 86400000);
    const shifted = today0();
    shifted.setDate(shifted.getDate() + days);
    t.dueDate = localYMD(shifted);
  }
  // 本批任务日报：diaries[].date 以 diaryAnchor 为书写基准日，按「天数差不变」平移到今天——
  // 「今天/昨天/三天前」的演示语义不随真实日期流逝失效（与 dueAnchor 同一口径）。
  // 条目的 updatedAt 是 ISO 时间戳，已被上方 shiftDates 按 DATE_KEY 平移，无需在此处理
  const diaryAnchor = parseYMD(db.diaryAnchor);
  if (diaryAnchor) {
    for (const list of Object.values(db.diaries || {})) {
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        const ed = parseYMD(e && e.date);
        if (!ed) continue;
        const days = Math.round((ed.getTime() - diaryAnchor.getTime()) / 86400000);
        const shifted = today0();
        shifted.setDate(shifted.getDate() + days);
        e.date = localYMD(shifted);
      }
    }
  }
  // v2.3 智能体动态演示数据：startedAgoSec/lastActiveAgoSec 同口径一次性换算（相对本页会话锚定），
  // 保证「N 分钟前」相对时间与 preview 截断演示不随真实日期流逝而失效
  for (const rec of ((db.agentActivity && db.agentActivity.items) || [])) {
    if (!rec.startedAt && rec.startedAgoSec != null) {
      rec.startedAt = new Date(Date.now() - rec.startedAgoSec * 1000).toISOString();
    }
    if (!rec.lastActiveAt && rec.lastActiveAgoSec != null) {
      rec.lastActiveAt = new Date(Date.now() - rec.lastActiveAgoSec * 1000).toISOString();
    }
    delete rec.startedAgoSec;
    delete rec.lastActiveAgoSec;
  }
  // v2.3 会话列表/全文（SPEC-READER §3.1/§3.2 mock 契约）：相对时间换算 + ref 签发 + 转录 ts/seq 补齐 +
  // 长转录生成 + kind:"session" 成果样例注入。ref = base64url(JSON{s,k,v})（D1），mock 与真实后端同构
  for (const src of Object.keys(db.agentSessions || {})) {
    for (const rec of db.agentSessions[src]) {
      if (!rec.startedAt && rec.startedAgoSec != null) {
        rec.startedAt = new Date(Date.now() - rec.startedAgoSec * 1000).toISOString();
      }
      if (!rec.lastActiveAt && rec.lastActiveAgoSec != null) {
        rec.lastActiveAt = new Date(Date.now() - rec.lastActiveAgoSec * 1000).toISOString();
      }
      delete rec.startedAgoSec;
      delete rec.lastActiveAgoSec;
      rec.ref = signRef(src, rec.id);
    }
  }
  // 静态转录补 ts/seq：ts 按 startedAt 起每条 +45s 递增（startedAgoSec 已换算，时间轴观感成立即可）
  for (const [sid, tr] of Object.entries(db.agentTranscripts || {})) {
    let startMs = 0;
    for (const src of Object.keys(db.agentSessions || {})) {
      const rec = (db.agentSessions[src] || []).find((x) => x.id === sid);
      if (rec) { startMs = Date.parse(rec.startedAt); break; }
    }
    if (!startMs) startMs = Date.now() - 3600 * 1000;
    (tr.messages || []).forEach((msg, i) => {
      msg.seq = i + 1;
      msg.ts = new Date(startMs + i * 45000).toISOString();
      if (!('tool' in msg)) msg.tool = null;
    });
  }
  buildLongTranscript(db);   // zc-long：855 条 user/assistant/tool 交错（阅读器懒渲染验收样例）
  injectSessionArtifact(db); // 「接入 SSO 登录」任务预置一条 kind:"session" 成果（看板会话徽标演示）
  return db;
}

// ---- v2.3 会话 mock 工具 ----
// base64url：浏览器/Node 通用走 btoa/atob + UTF-8 桥（escape/unescape 为引擎级内置，零依赖）
const b64urlEnc = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDec = (s) => decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))));
// D1：ref = base64url(JSON{s:源 id, k:locator 种类, v:locator 对象})，不透明串
const signRef = (src, id) => b64urlEnc(JSON.stringify({ s: src, k: 'session', v: { id } }));

// ref 解析（§3.3 校验的 mock 简化版：解码/源白名单/k/locator 存在性四闸），通过返回 {src, rec}
function resolveSessionRef(ref) {
  const d = db;
  if (!d || !d.agentSessions) return null;
  let obj = null;
  try { obj = JSON.parse(b64urlDec(ref)); } catch { return null; }
  if (!obj || typeof obj !== 'object' || typeof obj.s !== 'string' || obj.k !== 'session') return null;
  if (!Object.prototype.hasOwnProperty.call(d.agentSessions, obj.s)) return null;
  const id = obj.v && obj.v.id;
  const rec = (d.agentSessions[obj.s] || []).find((x) => x.id === id);
  return rec ? { src: obj.s, rec } : null;
}

// 长转录样例：zc-long 固定 855 条，user/assistant/tool 交错（每 6 条一轮：
// 用户指令 → 助手拆解 → 工具读 → 助手结论 → 工具改/跑 → 工具状态汇报），少量 error/running 状态点缀
function buildLongTranscript(d) {
  if (!d.agentSessions || !d.agentSessions.zcode) return;
  const rec = d.agentSessions.zcode.find((x) => x.id === 'zc-long');
  if (!rec || (d.agentTranscripts && d.agentTranscripts['zc-long'])) return;
  d.agentTranscripts = d.agentTranscripts || {};
  const TOOLS = ['read_file', 'grep', 'edit_file', 'run_tests'];
  const msgs = [];
  const total = 855;
  for (let i = 0; i < total; i++) {
    if (i === total - 1) {
      // 收尾消息固定 running 工具态（阅读器「进行中」徽标演示），不随 phase 轮换
      msgs.push({ role: 'tool', tool: { name: 'run_tests', status: 'running' }, text: '全量回归执行中…（阅读器懒渲染样例：最后一条保持 running 态演示）' });
      continue;
    }
    const phase = i % 6;
    if (phase === 0) {
      msgs.push({ role: 'user', text: `第 ${Math.floor(i / 6) + 1} 轮：继续对照确认稿核查动态面板，本轮先处理上一轮遗留的 ${['徽标透明度', '行距偏差', '轮询节流', '空态文案', '滚动抖动', '转义遗漏'][i % 6]}。` });
    } else if (phase === 1) {
      msgs.push({ role: 'assistant', text: `收到。第 ${i + 1} 步：先读现状定位差异来源，再决定改样式层还是渲染层；改动会控制在单文件内，避免波及七视图。` });
    } else if (phase === 2) {
      msgs.push({ role: 'tool', tool: { name: TOOLS[i % 2], status: 'ok' }, text: `web/js/views/agents.js · 定位到行 ${320 + (i % 300)}\n确认差异：${['徽标底透明度 .16→.13', '组头字重 600→500', '行高 1.45→1.5', '空态图标规格 22→20'][i % 4]}` });
    } else if (phase === 3) {
      msgs.push({ role: 'assistant', text: `定位完成（消息 ${i + 1}/855）。差异在样式层，改一行即可；顺手核对该选择器无其他视图复用，零波及。` });
    } else if (phase === 4) {
      const bad = i % 61 === 59;
      msgs.push({ role: 'tool', tool: { name: bad ? 'run_tests' : TOOLS[2 + (i % 2)], status: bad ? 'error' : 'ok' }, text: bad ? 'node --test 1 项失败：badge 透明度断言期望 .13 实际 .16\n→ 上一步编辑未保存（编辑器缓冲），已重新写入' : `web/css/app.css +1 -1（消息 ${i + 1}）\n改动落地：视觉回归通过` });
    } else {
      msgs.push({ role: 'tool', tool: { name: 'run_tests', status: 'ok' }, text: `node --check 4 文件通过 · node --test ${240 + (i % 10)} 项全绿（消息 ${i + 1}）` });
    }
  }
  // ts 按 startedAt→lastActiveAt 区间线性铺满，seq 升序
  const startMs = Date.parse(rec.startedAt);
  const step = Math.max(1, (Date.parse(rec.lastActiveAt) - startMs) / total);
  msgs.forEach((m, i) => {
    m.seq = i + 1;
    m.ts = new Date(startMs + i * step).toISOString();
    if (!('tool' in m)) m.tool = null;
  });
  d.agentTranscripts['zc-long'] = { messages: msgs };
}

// kind:"session" 成果样例：注入「接入 SSO 登录」任务（D3 契约：url/repo/ref 一律 null + sessionRef/title 独立字段），
// 让看板成果区/时间轴开箱即有会话徽标演示数据；重复加载有幂等守卫
function injectSessionArtifact(d) {
  const task = (d.tasks || []).find((t) => t.id === 't-m4ek9a-3f21');
  const rec = d.agentSessions && d.agentSessions.claude
    ? d.agentSessions.claude.find((x) => x.id === 'cl-sso') : null;
  if (!task || !rec) return;
  if ((task.artifacts || []).some((a) => a && a.kind === 'session')) return;
  const at = new Date(Date.now() - 7200 * 1000).toISOString();
  task.artifacts = task.artifacts || [];
  task.artifacts.push({ kind: 'session', sessionRef: rec.ref, title: rec.title, url: null, repo: null, ref: null, attributedBy: 'auto', at });
  task.events = task.events || [];
  task.events.push({ type: 'artifact', from: null, to: null, detail: `自动归因：session ${String(rec.title).slice(0, 40)}`, at });
}

function computedOverview(d) {
  const counts = { todo: 0, doing: 0, review: 0, done: 0 };
  for (const t of d.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  // 契约 v1.4：overdue = 有截止且已过期且未完成（done 列不追责）
  const overdue = d.tasks.filter((t) => t.status !== 'done' && t.dueDate && dueDayDiff(t.dueDate) < 0).length;
  const dayAgo = Date.now() - 86400 * 1000;
  const acts24h = d.activities.filter((a) => Date.parse(a.occurredAt) >= dayAgo).length;
  // v1.8.1 外部经网关的运行中调用数已随 cli-gateway 监控整体退役（业主 2026-10-20）：
  // 契约字段保留恒 0（overview.js/顶栏 v2.5 起不再并入展示）
  // v2.3 会话退役：sessionsRunning 同口径恒 0（指挥台本地会话表已退役，会话观测唯一入口
  //   是智能体动态面板；overview.js/顶栏契约字段保留，消费方默认 0 展示）
  return {
    tasks: Object.assign(counts, { overdue }),
    agents: d.agents.length,
    sessionsRunning: 0,
    gatewayExternalRunning: 0,
    activities24h: acts24h,
    gitea: clone(d.overview.gitea)
  };
}

// 演示开关（headless 验收用）：localStorage['fde-mock-topo'] = 'ok'(默认) | 'empty'(任务列表清空，
// 供总览页「任务拓扑」空态点击验证；仅影响 /api/tasks 列表，验证后立即清除)
function topoSimMode() {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('fde-mock-topo') === 'empty') ? 'empty' : 'ok';
  } catch { return 'ok'; }
}

// 演示开关（headless 验收用）：localStorage['fde-mock-act'] = 'ok'(默认) | 'empty'(活动流空态) |
//   'allfail'(四源全失败态)；仅影响 /api/agent-activity，验证后立即清除
function actSimMode() {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('fde-mock-act') : null;
    return ['ok', 'empty', 'allfail'].includes(v) ? v : 'ok';
  } catch { return 'ok'; }
}

const columnIds = (d) => d.columns.map((c) => c.id);
const requireTask = (d, id) => {
  const t = d.tasks.find((x) => x.id === id);
  if (!t) throw new ApiError(404, 'TASK_NOT_FOUND', '任务不存在');
  return t;
};
// v1.7 任务动态事件：追加到 task.events（内存按时间正序存，GET 详情返回倒序）
const pushEvent = (t, type, { from = null, to = null, detail = '' } = {}) => {
  if (!Array.isArray(t.events)) t.events = [];
  t.events.push({ type, from, to, detail, at: nowIso() });
};
// PATCH 事件文案：字段键 → 中文名（edit 事件 detail 用）
const EDIT_LABELS = { title: '标题', desc: '描述', repo: '仓库', branch: '分支', prUrl: 'PR 链接', notes: '备注' };
const requireColumn = (d, id) => {
  const c = d.columns.find((x) => x.id === id);
  if (!c) throw new ApiError(404, 'COLUMN_NOT_FOUND', '列不存在');
  return c;
};
// 本批任务日报：db.diaries 以任务 id 为键的条目数组 [{date,content,updatedAt}]（内存态，写操作直接改副本）
const diariesOf = (d, taskId) => {
  const map = d.diaries || (d.diaries = {});
  if (!Array.isArray(map[taskId])) map[taskId] = [];
  return map[taskId];
};

async function handle(path, { method = 'GET', body } = {}) {
  const d = await load();
  const u = new URL(path, 'http://mock.local');
  const seg = u.pathname.split('/').filter(Boolean).slice(1); // 去掉 'api'
  const m = method.toUpperCase();
  const q = u.searchParams;

  // ---- 通用 / 总览 ----
  if (seg[0] === 'health' && seg.length === 1 && m === 'GET') {
    return { ok: true, version: '1.1.0-mock', uptimeSec: Math.round((Date.now() - bootMs) / 1000) };
  }
  if (seg[0] === 'overview' && seg.length === 1 && m === 'GET') return computedOverview(d);
  // v2.9.37 版本与兼容性矩阵：ping 契约与后端同形（engines/runtime 只增不改）
  if (seg[0] === 'ping' && seg.length === 1 && m === 'GET') {
    return {
      pong: true,
      name: 'fde-console',
      version: '1.1.0-mock',
      uptimeSec: Math.round((Date.now() - bootMs) / 1000),
      pid: 0,
      engines: { node: '>=22.13', dsh: '>=0.2.1-rc.2 <0.3.0-0' },
      runtime: { node: 'v22.13.0-mock', platform: 'mock', arch: 'mock' }
    };
  }

  // ---- 列 ----
  if (seg[0] === 'columns' && seg.length === 1) {
    if (m === 'GET') return clone(d.columns).sort((a, b) => a.order - b.order);
    if (m === 'POST') {
      const name = String((body && body.name) || '').trim();
      if (!name || name.length > 20) throw new ApiError(400, 'VALIDATION', '列名必填且不超过 20 字');
      const col = { id: genColId(), name, order: d.columns.length + 1 };
      d.columns.push(col);
      return clone(col);
    }
  }
  if (seg[0] === 'columns' && seg.length === 2) {
    const col = requireColumn(d, seg[1]);
    if (m === 'PATCH') {
      if (body && body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name || name.length > 20) throw new ApiError(400, 'VALIDATION', '列名必填且不超过 20 字');
        col.name = name;
      }
      if (body && body.order !== undefined) {
        // 契约：order 必须为正整数，服务端归一化为 1..n（其余列顺次让位）
        const n = d.columns.length;
        const req = Number(body.order);
        if (!Number.isInteger(req) || req < 1) throw new ApiError(400, 'VALIDATION', 'order 必须为正整数');
        const target = Math.min(req, n);
        const old = col.order;
        if (target !== old) {
          for (const c of d.columns) {
            if (c.id === col.id) continue;
            if (old < target && c.order > old && c.order <= target) c.order -= 1;
            else if (old > target && c.order >= target && c.order < old) c.order += 1;
          }
          col.order = target;
        }
      }
      return clone(col);
    }
    if (m === 'DELETE') {
      const n = d.tasks.filter((t) => t.status === col.id).length;
      if (n > 0) throw new ApiError(409, 'COLUMN_NOT_EMPTY', `先移走该列的 ${n} 个任务`);
      d.columns = d.columns.filter((c) => c.id !== col.id);
      return null;
    }
  }

  // ---- 任务 ----
  if (seg[0] === 'tasks' && seg.length === 1 && m === 'GET') {
    let list = d.tasks.slice();
    if (topoSimMode() === 'empty') list = []; // 演示开关：拓扑空态验证用（见 topoSimMode 注释）
    const status = q.get('status');
    const memberId = q.get('memberId');
    const priority = q.get('priority'); // 契约 v1.4：?priority= 过滤（前端暂无 UI 入口，backlog）
    const kw = (q.get('q') || '').toLowerCase();
    if (status) list = list.filter((t) => t.status === status);
    if (memberId) list = list.filter((t) => t.memberId === memberId);
    if (priority) list = list.filter((t) => (t.priority || 'medium') === priority);
    if (kw) list = list.filter((t) => [t.title, t.branch, t.notes, t.desc].some((s) => s && String(s).toLowerCase().includes(kw)));
    // 契约：events 仅 GET /api/tasks/:id 返回，列表不携带（卡片无需动态）
    return clone(list).map((x) => { delete x.events; return x; })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  if (seg[0] === 'tasks' && seg.length === 1 && m === 'POST') {
    const title = String((body && body.title) || '').trim();
    if (!title || title.length > 200) throw new ApiError(400, 'VALIDATION', '标题必填且不超过 200 字');
    const desc = (body && body.desc !== undefined) ? body.desc : '';
    if (typeof desc !== 'string' || desc.length > 2000) throw new ApiError(400, 'VALIDATION', 'desc 必须为不超过 2000 字的字符串');
    const status = (body && body.status) || 'todo';
    if (!columnIds(d).includes(status)) throw new ApiError(400, 'COLUMN_NOT_FOUND', '状态列不存在');
    if (!validDueDate(body && body.dueDate)) throw new ApiError(400, 'VALIDATION', 'dueDate 必须为 YYYY-MM-DD 格式或 null');
    const priority = (body && body.priority) || 'medium';
    if (!PRIORITIES.includes(priority)) throw new ApiError(400, 'VALIDATION', 'priority 必须为 high/medium/low');
    // v2.0 契约：创建即带验收人时，时间轴同步落一条 accept 事件（detail 含验收人名）
    const accId = (body && body.acceptorId) || null;
    const accMem = accId ? (d.members || []).find((x) => x.id === accId) : null;
    const accName = accMem ? accMem.name : accId;
    const t = {
      id: genTaskId(),
      title,
      status,
      desc,
      priority,
      dueDate: (body && body.dueDate) || null,
      agentId: (body && body.agentId) || null,
      memberId: (body && body.memberId) || null,
      acceptorId: accId, // v2.0 契约：验收人（成员 id 或 null）
      repo: (body && body.repo) || null,
      branch: (body && body.branch) || null,
      prUrl: (body && body.prUrl) || null,
      notes: (body && body.notes) || '',
      artifacts: [], // 叙事线第一批：成果挂接列表（POST/DELETE /api/tasks/:id/artifacts 维护）
      completedAt: null, // v1.7 契约：status 进 done 自动置、移出清空
      createdAt: nowIso(),
      updatedAt: nowIso(),
      events: [
        { type: 'created', from: null, to: status, detail: '', at: nowIso() },
        ...(accId ? [{ type: 'accept', from: null, to: accName, detail: `验收人：${accName}`, at: nowIso() }] : [])
      ]
    };
    d.tasks.push(t);
    return clone(t);
  }
  if (seg[0] === 'tasks' && seg.length === 2) {
    const t = requireTask(d, seg[1]);
    if (m === 'GET') {
      const out = clone(t);
      // v1.7 契约：events 倒序（最新在前）。先稳定升序再整体反转：
      // 同毫秒事件（一次 PATCH 记多条）保持“后插入 = 更新”语义（如 completed 排在 status 前）
      out.events = (out.events || []).slice()
        .sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0))
        .reverse();
      return out;
    }
    if (m === 'PATCH') {
      const writable = ['title', 'status', 'desc', 'priority', 'dueDate', 'agentId', 'memberId', 'acceptorId', 'repo', 'branch', 'prUrl', 'notes'];
      // v1.7 动态事件：名称解析（列名/成员名/智能体名），from/to 存人读值
      const colName = (cid) => (d.columns.find((c) => c.id === cid) || {}).name || cid || null;
      const memName = (mid) => {
        if (!mid) return null;
        const mm = (d.members || []).find((x) => x.id === mid);
        return mm ? mm.name : mid;
      };
      const agName = (aid) => {
        if (!aid) return null;
        const aa = d.agents.find((x) => x.id === aid);
        return aa ? aa.name : aid;
      };
      const changed = (a, b) => JSON.stringify(a === undefined ? null : a) !== JSON.stringify(b === undefined ? null : b);
      for (const k of writable) {
        if (body && body[k] !== undefined) {
          if (k === 'status' && !columnIds(d).includes(body[k])) throw new ApiError(400, 'COLUMN_NOT_FOUND', '状态列不存在');
          if (k === 'title' && (!String(body[k]).trim() || String(body[k]).length > 200)) throw new ApiError(400, 'VALIDATION', '标题必填且不超过 200 字');
          if (k === 'desc' && (typeof body[k] !== 'string' || body[k].length > 2000)) throw new ApiError(400, 'VALIDATION', 'desc 必须为不超过 2000 字的字符串');
          if (k === 'dueDate' && !validDueDate(body[k])) throw new ApiError(400, 'VALIDATION', 'dueDate 必须为 YYYY-MM-DD 格式或 null');
          if (k === 'priority' && !PRIORITIES.includes(body[k])) throw new ApiError(400, 'VALIDATION', 'priority 必须为 high/medium/low');
          const prev = t[k];
          t[k] = body[k];
          if (!changed(prev, body[k])) continue; // 值没变不记动态
          if (k === 'status') {
            pushEvent(t, 'status', { from: colName(prev), to: colName(body[k]) });
            // 契约：status 进 done 自动置 completedAt，移出清空
            if (body[k] === 'done') {
              t.completedAt = nowIso();
              pushEvent(t, 'completed', { from: null, to: null, detail: '任务完成' });
            } else if (prev === 'done') {
              t.completedAt = null;
            }
          } else if (k === 'priority') {
            pushEvent(t, 'priority', { from: prev || null, to: body[k] });
          } else if (k === 'dueDate') {
            pushEvent(t, 'due', { from: prev || null, to: body[k] || null });
          } else if (k === 'memberId') {
            pushEvent(t, 'assign', { from: memName(prev), to: memName(body[k]), detail: body[k] ? `负责成员：${memName(body[k])}` : '取消负责成员' });
          } else if (k === 'acceptorId') {
            // v2.0 契约：events 新增 type:"accept"，detail 含验收人名（时间轴金色「验收」节点）
            pushEvent(t, 'accept', { from: memName(prev), to: memName(body[k]), detail: body[k] ? `验收人：${memName(body[k])}` : '取消验收人' });
          } else if (k === 'agentId') {
            pushEvent(t, 'assign', { from: agName(prev), to: agName(body[k]), detail: body[k] ? `负责智能体：${agName(body[k])}` : '取消负责智能体' });
          } else {
            pushEvent(t, 'edit', { from: null, to: null, detail: `更新了${EDIT_LABELS[k] || k}` });
          }
        }
      }
      t.updatedAt = nowIso();
      return clone(t);
    }
    if (m === 'DELETE') {
      d.tasks = d.tasks.filter((x) => x.id !== t.id);
      return null;
    }
  }

  // ---- 叙事线第一批：任务成果挂接（POST 挂 / DELETE 按 idx 解），动作都写 artifact 事件 ----
  // v2.3 D3 契约扩展：kind 增 'session'——不带 url，sessionRef（≤512）/title（≤200）为独立必填字段，
  // url/repo/ref 一律不入库置 null（不复用 ref 字段：board.js 按「PR 序号/commit 哈希」语义渲染，双义会漏）
  if (seg[0] === 'tasks' && seg.length === 3 && seg[2] === 'artifacts' && m === 'POST') {
    const t = requireTask(d, seg[1]);
    const kind = String((body && body.kind) || '');
    if (!Array.isArray(t.artifacts)) t.artifacts = [];
    if (kind === 'session') {
      const sessionRef = String((body && body.sessionRef) || '').trim();
      const title = String((body && body.title) || '').trim();
      if (!sessionRef || sessionRef.length > 512) throw new ApiError(400, 'VALIDATION', 'sessionRef 必填且不超过 512 字符');
      if (!title || title.length > 200) throw new ApiError(400, 'VALIDATION', 'title 必填且不超过 200 字符');
      if (!resolveSessionRef(sessionRef)) throw new ApiError(400, 'BAD_REF', 'sessionRef 无法解析或会话不存在');
      t.artifacts.push({ kind, sessionRef, title, url: null, repo: null, ref: null, at: nowIso() });
      pushEvent(t, 'artifact', { from: null, to: null, detail: `挂接成果：session ${title.slice(0, 40)}` });
      t.updatedAt = nowIso();
      return clone(t);
    }
    const url = String((body && body.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new ApiError(400, 'VALIDATION', 'url 必填且必须为 http(s) 链接');
    if (!['commit', 'pr'].includes(kind)) throw new ApiError(400, 'VALIDATION', 'kind 必须为 commit、pr 或 session');
    const repo = (body && body.repo != null && String(body.repo).trim()) ? String(body.repo).trim() : null;
    const ref = (body && body.ref != null && String(body.ref).trim()) ? String(body.ref).trim() : null;
    t.artifacts.push({ url, kind, repo, ref, at: nowIso() });
    pushEvent(t, 'artifact', { from: null, to: url, detail: `挂接成果：${kind === 'pr' ? 'PR' : 'commit'}${repo ? ' · ' + repo : ''}` });
    t.updatedAt = nowIso();
    return clone(t);
  }
  if (seg[0] === 'tasks' && seg.length === 4 && seg[2] === 'artifacts' && m === 'DELETE') {
    const t = requireTask(d, seg[1]);
    const idx = Number(seg[3]);
    if (!Array.isArray(t.artifacts) || !Number.isInteger(idx) || idx < 0 || idx >= t.artifacts.length) {
      throw new ApiError(404, 'ARTIFACT_NOT_FOUND', '成果不存在或已被解除');
    }
    const rm = t.artifacts.splice(idx, 1)[0];
    const kindLabel = rm.kind === 'pr' ? 'PR' : rm.kind === 'session' ? 'session' : 'commit';
    pushEvent(t, 'artifact', { from: rm.url, to: null, detail: `解除成果挂接：${kindLabel}${rm.kind === 'session' ? ' ' + String(rm.title || '').slice(0, 40) : rm.repo ? ' · ' + rm.repo : ''}` });
    t.updatedAt = nowIso();
    return clone(t);
  }

  // ---- 本批任务日报（diary）：多日任务的过程留痕（后端并行开发中，前端按此 mock 契约先行）----
  // GET    /api/tasks/:id/diary                → [{date,content,updatedAt}]（date 倒序）
  // PUT    /api/tasks/:id/diary {date,content} → upsert（同日覆盖），返回该条
  // DELETE /api/tasks/:id/diary/:date          → 204
  // GET    /api/tasks/:id/diary/prefill?date=  → {giteaCommits:[{sha,title,url}], memoUpdates:[{quote,note}], draft}
  if (seg[0] === 'tasks' && seg.length === 3 && seg[2] === 'diary') {
    const t = requireTask(d, seg[1]);
    if (m === 'GET') {
      return clone(diariesOf(d, t.id)).sort((a, b) => (a.date < b.date ? 1 : -1));
    }
    if (m === 'PUT') {
      const date = body && body.date;
      if (parseYMD(date) === null) throw new ApiError(400, 'VALIDATION', 'date 必须为 YYYY-MM-DD 格式');
      const content = body && body.content;
      if (typeof content !== 'string' || !content.trim()) throw new ApiError(400, 'VALIDATION', 'content 必填（1..2000 字）');
      if (content.length > 2000) throw new ApiError(400, 'VALIDATION', `content 不能超过 2000 字（当前 ${content.length} 字）`);
      const list = diariesOf(d, t.id);
      const hit = list.find((x) => x.date === date); // 同日覆盖（upsert 语义）
      if (hit) {
        hit.content = content;
        hit.updatedAt = nowIso();
      } else {
        list.push({ date, content, updatedAt: nowIso() });
      }
      return clone(list.find((x) => x.date === date));
    }
  }
  if (seg[0] === 'tasks' && seg.length === 4 && seg[2] === 'diary' && m === 'DELETE') {
    const t = requireTask(d, seg[1]);
    const date = decodeURIComponent(seg[3]);
    if (parseYMD(date) === null) throw new ApiError(400, 'VALIDATION', 'date 必须为 YYYY-MM-DD 格式');
    const list = diariesOf(d, t.id);
    const at = list.findIndex((x) => x.date === date);
    if (at < 0) throw new ApiError(404, 'DIARY_NOT_FOUND', '该日期无日报');
    list.splice(at, 1);
    return null; // 204
  }
  if (seg[0] === 'tasks' && seg.length === 4 && seg[2] === 'diary' && seg[3] === 'prefill' && m === 'GET') {
    const t = requireTask(d, seg[1]);
    const date = q.get('date') || localYMD(new Date());
    if (parseYMD(date) === null) throw new ApiError(400, 'VALIDATION', 'date 必须为 YYYY-MM-DD 格式');
    // 数据源一 Gitea 提交：活动流中按匹配归到本任务的 commit_pushed（分支约定 / [#任务id] 归因）。
    // 优先取请求日期当天的；演示数据时间随加载平移可能不完全落在当天，取不到再退回最近匹配的 5 条
    const matched = (d.activities || []).filter((a) => a.type === 'commit_pushed' && (a.matchedTaskIds || []).includes(t.id));
    const onDate = matched.filter((a) => localYMD(new Date(a.occurredAt)) === date);
    const giteaCommits = (onDate.length ? onDate : matched).slice(0, 5).map((a) => ({
      sha: a.sha || String(a.url || '').split('/').filter(Boolean).pop() || '',
      title: a.title || a.messageBody || '',
      url: a.url || ''
    }));
    // 数据源二 纪要提及：任务更新提案确认时落在 origin.relatedMemos 的结构化留痕（quote+note）
    const rel = (t.origin && Array.isArray(t.origin.relatedMemos)) ? t.origin.relatedMemos : [];
    const memoUpdates = rel.slice(-3).reverse()
      .map((mm) => ({ quote: String((mm && mm.quote) || ''), note: String((mm && mm.note) || '') }));
    // 拼好的草稿文本：前端「从今日动态预填」直接填入编辑器（已有内容则追加不覆盖）
    const lines = [];
    if (giteaCommits.length) {
      lines.push('今日提交：');
      for (const c of giteaCommits) lines.push(`· ${c.title}${c.sha ? `（${c.sha}）` : ''}`);
    }
    if (memoUpdates.length) {
      lines.push('纪要同步：');
      for (const mm of memoUpdates) lines.push(`· “${mm.quote}”${mm.note ? `（备注：${mm.note}）` : ''}`);
    }
    if (!lines.length) lines.push('（当日暂无 Gitea 提交与纪要提及，可手动记录进展 / 卡点 / 下一步）');
    lines.push('', '（草稿由当日动态自动拼装，可修改后保存）');
    return { giteaCommits, memoUpdates, draft: lines.join('\n') };
  }

  // ---- 组织仓库（本批：看板任务表单「仓库」可搜索下拉数据源，后端并行开发中按此 mock 契约先行）----
  // GET /api/repos → [{fullName, name, private, updatedAt}]（配置组织下全部仓库，无分页；
  // updatedAt 键在 DATE_KEY 内，加载时随全局锚点平移，演示数据时间恒新鲜）。
  // 过滤不做在 mock 侧：board.js 下拉对全量列表按 fullName/name 大小写不敏感过滤
  if (seg[0] === 'repos' && seg.length === 1 && m === 'GET') return clone(d.repos || []);

  // ---- 智能体 ----
  // v2.7 注册表退役（业主 2026-10-20「退役本地 CLI 启动体系」）：POST/PATCH/DELETE /api/agents 与
  // /api/agents/:id/launch 随本地 CLI 启动体系下线——前端已无调用入口（真实后端由并行岗同步移除），
  // gwStatus/gwSimMode 启动判定与 BRIEFING 黑名单校验一并删除；GET 保留：看板「AI 执行」执行者下拉、
  // 智能体观测卡、会话表/拓扑的名称映射仍依赖
  if (seg[0] === 'agents' && seg.length === 1 && m === 'GET') return clone(d.agents);

  // ---- 会话（v2.3 退役 + 新增）----
  // GET /api/sessions 过渡桩：会话登记表/停止/日志已随 v2.3 退役（真实后端由并行岗同步下线）。
  // 总览页「运行中会话」面板仍消费该端点（其退役未列入 SPEC-READER §6 清单），暂回空列表保七视图可用；
  // overview.js 收口后此桩一并删除
  if (seg[0] === 'sessions' && seg.length === 1 && m === 'GET') return [];

  // GET /api/agent-sessions?agent=&limit=&cursor=（§3.1）：该源会话列表，lastActiveAt 倒序 + 键集游标分页
  // 演示开关（headless 验收用）：localStorage['fde-mock-sess'] = 'fail' → 本端点 500（拓扑会话源加载失败空态验证）
  if (seg[0] === 'agent-sessions' && seg.length === 1 && m === 'GET') {
    const sessFail = (() => {
      try {
        return (typeof localStorage !== 'undefined' && localStorage.getItem('fde-mock-sess') === 'fail');
      } catch { return false; }
    })();
    if (sessFail) throw new ApiError(500, 'SOURCE_DOWN', '会话源探测失败（fde-mock-sess=fail 演示态）');
    const agent = q.get('agent') || '';
    if (!d.agentSessions || !Object.prototype.hasOwnProperty.call(d.agentSessions, agent)) {
      throw new ApiError(400, 'BAD_AGENT', `agent 必填且须为已接入会话源（现有：${Object.keys(d.agentSessions || {}).join('、') || '无'}）`);
    }
    let limit = Number(q.get('limit') || 20);
    if (!isFinite(limit) || limit < 1) limit = 20;
    if (limit > 50) limit = 50; // §3.1：上限 50，超出按 50
    const sorted = d.agentSessions[agent].slice()
      .sort((a, b) => Date.parse(b.lastActiveAt || 0) - Date.parse(a.lastActiveAt || 0) || (a.id < b.id ? 1 : -1));
    let start = 0;
    const cur = q.get('cursor');
    if (cur) {
      let c = null;
      try { c = JSON.parse(b64urlDec(cur)); } catch { c = null; }
      // 键集游标：定位 (lastActiveAt, id) 锚点取其后一页；游标失效（数据已翻页翻过）→ 空页，客户端停止加载
      const at = c ? sorted.findIndex((x) => x.lastActiveAt === c.t && x.id === c.id) : -1;
      start = at >= 0 ? at + 1 : sorted.length;
    }
    const page = sorted.slice(start, start + limit);
    const anchor = start + limit < sorted.length ? sorted[start + limit - 1] : null;
    return {
      agent,
      items: page.map((rec) => ({
        ref: rec.ref, id: rec.id, title: rec.title, projectId: rec.projectId,
        startedAt: rec.startedAt, lastActiveAt: rec.lastActiveAt, state: rec.state || '',
        // 可选 taskId（B5 拓扑联动）：会话与任务的显式关联，真实后端按源能力回填（缺省 null）
        taskId: rec.taskId || null
      })),
      nextCursor: anchor ? b64urlEnc(JSON.stringify({ t: anchor.lastActiveAt, id: anchor.id })) : null
    };
  }

  // GET /api/agent-session?ref=（§3.2）：会话全文；workbuddy 恒降级（D4，不造数据）
  if (seg[0] === 'agent-session' && seg.length === 1 && m === 'GET') {
    const ref = q.get('ref') || '';
    const hit = resolveSessionRef(ref);
    if (!hit) throw new ApiError(400, 'BAD_REF', 'ref 无效（解码 / 来源白名单 / 会话存在性任一不过）');
    const { src, rec } = hit;
    const base = { ref, agent: src, title: rec.title, projectId: rec.projectId, startedAt: rec.startedAt, lastActiveAt: rec.lastActiveAt };
    if (src === 'workbuddy') {
      return Object.assign(base, { degraded: true, reason: 'SOURCE_NO_TRANSCRIPT', messages: [] });
    }
    const tr = (d.agentTranscripts || {})[rec.id];
    const messages = tr && Array.isArray(tr.messages) ? clone(tr.messages) : [];
    return Object.assign(base, { degraded: false, total: messages.length, truncated: false, messages });
  }

  // ---- 成员 ----
  // 契约对齐 lib/members.js：id ^[a-z][a-z0-9.-]{0,31}$；name 必填 1..50；role/giteaLogin 可选 ≤50 字
  // 聚合视图每条带 manual:true/false（manual 为手工名册条目，其余由智能体注册表/Gitea 同步派生）
  const MEMBER_ID_RE = /^[a-z][a-z0-9.-]{0,31}$/;
  const requireMemberName = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (s.length < 1 || s.length > 50) throw new ApiError(400, 'MEMBER_INVALID', 'name 必填且为 1..50 字符');
    return s;
  };
  const optionalMemberField = (v, label) => {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v !== 'string' || v.trim().length > 50) {
      throw new ApiError(400, 'MEMBER_INVALID', `${label} 可省略，提供时必须为 ≤50 字符的字符串`);
    }
    return v.trim();
  };
  if (seg[0] === 'members' && seg.length === 1 && m === 'GET') {
    // 契约 v1.4：currentTask 附带 dueDate/priority，从任务源实时带出（mock 编辑任务后成员行同步）
    // 本批：diaryToday = 该成员当前任务今日已有日报（写入口在任务详情「日报」区，两态供成员页轻提醒）
    const today = localYMD(new Date());
    return clone(d.members).map((x) => {
      if (x.manual !== true) x = Object.assign({ manual: false }, x);
      if (x.currentTask) {
        const t = d.tasks.find((y) => y.id === x.currentTask.id);
        if (t) {
          x.currentTask.dueDate = t.dueDate || null;
          x.currentTask.priority = t.priority || 'medium';
        }
      }
      x.diaryToday = !!(x.currentTask && diariesOf(d, x.currentTask.id).some((e) => e && e.date === today));
      return x;
    });
  }
  if (seg[0] === 'members' && seg.length === 1 && m === 'POST') {
    const b = body || {};
    if (typeof b.id !== 'string' || !MEMBER_ID_RE.test(b.id)) {
      throw new ApiError(400, 'MEMBER_INVALID', 'id 必填且须匹配 ^[a-z][a-z0-9.-]{0,31}$');
    }
    if (d.members.some((x) => x.id === b.id)) throw new ApiError(409, 'MEMBER_EXISTS', '该 id 已存在于手工名册');
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
      throw new ApiError(400, 'MEMBER_INVALID', 'enabled 必须为布尔值');
    }
    const row = {
      id: b.id,
      name: requireMemberName(b.name),
      kind: 'human',
      role: optionalMemberField(b.role, 'role'),
      giteaLogin: optionalMemberField(b.giteaLogin, 'giteaLogin'),
      enabled: b.enabled === undefined ? true : b.enabled,
      manual: true,
      status: 'idle',
      currentTask: null,
      lastActivityAt: null,
      todayCommits: 0,
      openPrs: 0,
      weekDone: 0,
      session: null
    };
    d.members.push(row);
    return clone(row);
  }
  if (seg[0] === 'members' && seg.length === 2) {
    const row = d.members.find((x) => x.id === seg[1]);
    if (m === 'PATCH') {
      // 与后端一致：手工名册之外的 id（含派生成员）一律 404
      if (!row || row.manual !== true) throw new ApiError(404, 'MEMBER_NOT_FOUND', '手工名册中不存在该成员（智能体与 Gitea 派生成员不经此接口修改）');
      const b = body || {};
      if (b.name !== undefined) row.name = requireMemberName(b.name);
      if (b.role !== undefined) row.role = optionalMemberField(b.role, 'role');
      if (b.giteaLogin !== undefined) row.giteaLogin = optionalMemberField(b.giteaLogin, 'giteaLogin');
      if (b.enabled !== undefined) {
        if (typeof b.enabled !== 'boolean') throw new ApiError(400, 'MEMBER_INVALID', 'enabled 必须为布尔值');
        row.enabled = b.enabled;
      }
      return clone(row);
    }
    if (m === 'DELETE') {
      if (!row) throw new ApiError(404, 'MEMBER_NOT_FOUND', '成员不存在');
      if (row.manual !== true) throw new ApiError(409, 'MEMBER_IMMUTABLE', '该成员非手工名册条目，不可删除（智能体走 /api/agents，Gitea 成员为派生只读）');
      d.members = d.members.filter((x) => x.id !== row.id);
      return null; // 204
    }
  }

  // ---- 动态 ----
  if (seg[0] === 'activities' && seg.length === 1 && m === 'GET') {
    const list = clone(d.activities).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    void q.get('refresh'); // mock 下刷新等于重读缓存
    return list;
  }

  // ---- 设置 ----
  if (seg[0] === 'settings') {
    if (m === 'GET') return clone(d.settings);
    if (m === 'PATCH') {
      if (body && body.host !== undefined && body.host !== '127.0.0.1') throw new ApiError(400, 'HOST_FORBIDDEN', 'host 仅允许 127.0.0.1');
      const src = body && body.gitea;
      if (src && typeof src === 'object') {
        for (const k of Object.keys(src)) {
          if (k in d.settings.gitea) d.settings.gitea[k] = src[k];
        }
      }
      const dt = body && body.dingtalk;
      if (dt && typeof dt === 'object') {
        if (!d.settings.dingtalk) d.settings.dingtalk = { enabled: true, hostWhitelist: ['dingtalk.com'] };
        for (const k of Object.keys(dt)) {
          if (k in d.settings.dingtalk) d.settings.dingtalk[k] = dt[k];
        }
      }
      const az = body && body.analyze;
      if (az && typeof az === 'object') {
        if (!d.settings.analyze) d.settings.analyze = { timeoutSec: 120, maxTasksPerMessage: 10 };
        for (const k of Object.keys(az)) {
          if (k in d.settings.analyze) d.settings.analyze[k] = az[k];
        }
      }
      const gw = body && body.gateway;
      if (gw && typeof gw === 'object') {
        if (!d.settings.gateway) d.settings.gateway = { enabled: true, timeoutSec: 600, bin: 'cli-gateway', minVersion: '0.9.0' };
        if (gw.enabled !== undefined && typeof gw.enabled !== 'boolean') {
          throw new ApiError(400, 'VALIDATION', 'gateway.enabled 必须为布尔值');
        }
        if (gw.timeoutSec !== undefined) {
          const v = Number(gw.timeoutSec);
          if (!isFinite(v) || v < 30 || v > 3600) {
            throw new ApiError(400, 'VALIDATION', 'gateway.timeoutSec 必须为 30..3600 的数字');
          }
          gw.timeoutSec = v;
        }
        // 契约：gateway 节仅 enabled/timeoutSec 可改；bin/minVersion 只读展示（传入即忽略）
        for (const k of ['enabled', 'timeoutSec']) {
          if (gw[k] !== undefined) d.settings.gateway[k] = gw[k];
        }
      }
      // 环境体检二期新键：security.trustedHosts（字符串数组；localhost/127.0.0.1 为后端内置信任，存盘值不含）
      const sec = body && body.security;
      if (sec && typeof sec === 'object') {
        if (!d.settings.security) d.settings.security = { trustedHosts: [] };
        if (sec.trustedHosts !== undefined) {
          if (!Array.isArray(sec.trustedHosts) || sec.trustedHosts.some((h) => typeof h !== 'string')) {
            throw new ApiError(400, 'VALIDATION', 'security.trustedHosts 必须为字符串数组');
          }
          const seen = new Set();
          d.settings.security.trustedHosts = [];
          for (const raw of sec.trustedHosts) {
            const h = raw.trim();
            const key = h.toLowerCase();
            if (!h || seen.has(key)) continue;
            seen.add(key);
            d.settings.security.trustedHosts.push(h);
          }
        }
      }
      return clone(d.settings);
    }
  }

  // ---- 环境体检（设置页产品化二期）：GET /api/setup/check，六项 node/dws/dsh/llmRoute/gitea/cliGateway ----
  // 演示开关（headless 验收用）：localStorage['fde-mock-setup'] = 'ok'(默认全过) | 'fail'(2 项失败演示态)
  if (seg[0] === 'setup' && seg[1] === 'check' && seg.length === 2 && m === 'GET') {
    const setupSim = (() => {
      try {
        return (typeof localStorage !== 'undefined' && localStorage.getItem('fde-mock-setup') === 'fail') ? 'fail' : 'ok';
      } catch { return 'ok'; }
    })();
    await new Promise((r) => setTimeout(r, 300)); // 模拟真实探测耗时，让「体检中」骨架态可见
    const out = clone(d.setupCheck);
    if (setupSim === 'fail' && d.setupCheckFail && d.setupCheckFail.overrides) {
      for (const it of out.items) {
        const o = d.setupCheckFail.overrides[it.id];
        if (o) { it.ok = !!o.ok; it.detail = o.detail; it.hint = o.hint; }
      }
      out.allOk = out.items.every((i) => i.ok);
    }
    out.checkedAt = nowIso();
    return out;
  }

  // ---- Gitea 测试 ----
  if (seg[0] === 'gitea' && seg[1] === 'test' && m === 'POST') {
    const raw = String((body && body.baseUrl) || d.settings.gitea.baseUrl);
    let host = '';
    try { host = new URL(raw).hostname.toLowerCase(); } catch { throw new ApiError(400, 'VALIDATION', 'baseUrl 不是合法 URL'); }
    if (!d.settings.gitea.hostWhitelist.some((h) => h.toLowerCase() === host)) {
      throw new ApiError(400, 'HOST_NOT_ALLOWED', 'host 不在白名单');
    }
    return { ok: true, latencyMs: 80 + Math.floor(Math.random() * 120), apiVersion: '1.22.0' };
  }

  // ---- cli-gateway（v1.5.1 → v2.6 退役）：/api/gateway/* mock 路由已随网关监控整体下线；
  // v2.7 注册表退役：launch 路由与 gwStatus 启动判定一并下线；
  // v2.3 会话退役：sessions/:id/log 路由与 sessionLogs 样例随会话表「日志」弹层一并删除（该端点后端本无注册，死链） ----

  // ---- 网关动态（v1.7.2 → v2.6 随 cli-gateway 监控整体退役）：gateway/invocations 列表与
  // 详情 mock 路由及 gatewayInvocations 样例已删除，演示开关 fde-mock-gwinv 一并下线 ----

  // ---- 智能体动态（v2.3）：跨源活动流聚合（契约：items 四字段 agent/agentName/projectId/title/
  // preview(≤200字)/startedAt/lastActiveAt/state；state 为各源原生状态，原样展示不翻译）----
  // 演示开关（headless 验收用）：localStorage['fde-mock-act'] = 'ok'(默认) | 'empty'(活动流空态) |
  //   'allfail'(四源全失败态)；仅影响本接口，验证后立即清除
  if (seg[0] === 'agent-activity' && seg.length === 1 && m === 'GET') {
    const sim = actSimMode();
    const src = d.agentActivity || { items: [], sources: [] };
    const srcs = clone(src.sources || []);
    if (sim === 'empty') {
      return { allOk: true, items: [], sources: srcs.map((s) => ({ id: s.id, ok: true, detail: s.detail })), checkedAt: nowIso() };
    }
    if (sim === 'allfail') {
      return {
        allOk: false, items: [],
        sources: srcs.map((s) => ({ id: s.id, ok: false, detail: `${s.id} 会话库探测超时（allfail 演示态）` })),
        checkedAt: nowIso()
      };
    }
    const items = (src.items || []).slice()
      .sort((a, b) => Date.parse(b.lastActiveAt || 0) - Date.parse(a.lastActiveAt || 0));
    return { allOk: srcs.length > 0 && srcs.every((s) => s.ok), items: clone(items), sources: srcs, checkedAt: nowIso() };
  }

  // ---- 任务雷达（PRD-task-inbox）：同步/分析走异步 job，收件箱/统计/别名同步返回 ----
  const radarJobs = d.__radarJobs || (d.__radarJobs = {});
  let jobSeq = d.__jobSeq || (d.__jobSeq = 0);
  const mkJob = (kind, total) => {
    const id = `job-${++jobSeq}-${Math.random().toString(36).slice(2, 6)}`;
    const job = { id, kind, state: 'running', total, done: 0, current: null, results: [], startedAt: nowIso(), finishedAt: null, error: null };
    radarJobs[id] = job;
    return job;
  };
  const finishMockJob = (job) => { job.state = 'done'; job.finishedAt = nowIso(); };

  if (seg[0] === 'radar' && seg[1] === 'sync' && m === 'POST') {
    const job = mkJob('sync', (d.radarMessages || []).length);
    setTimeout(() => { job.done = job.total; job.results.push({ item: 'sync', ok: true, added: 0, skippedExisting: (d.radarMessages || []).length, failed: [] }); finishMockJob(job); }, 500);
    return { jobId: job.id };
  }
  if (seg[0] === 'radar' && seg[1] === 'jobs' && seg.length === 3 && m === 'GET') {
    const job = radarJobs[seg[2]];
    if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', '任务不存在');
    return clone(job);
  }
  if (seg[0] === 'radar' && seg[1] === 'messages' && seg.length === 2 && m === 'GET') {
    return clone(d.radarMessages || [])
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      .map((x) => ({
        id: x.id, source: x.source, kind: x.kind, title: x.title, occurredAt: x.occurredAt,
        ref: x.ref, analyzedAt: x.analyzedAt, analyzeState: x.analyzeState || '', analyzeError: x.analyzeError || null,
        segmentCount: (x.speakerSegments || []).length, truncated: !!x.truncated
      }));
  }
  if (seg[0] === 'radar' && seg[1] === 'messages' && seg.length === 3 && m === 'GET') {
    const msg = (d.radarMessages || []).find((x) => x.id === seg[2]);
    if (!msg) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '消息不存在');
    return clone(msg);
  }
  if (seg[0] === 'radar' && seg[1] === 'engine' && seg.length === 2 && m === 'GET') {
    const dt = d.settings.dingtalk || {};
    const az = d.settings.analyze || {};
    return {
      dingtalk: { enabled: dt.enabled !== false, dwsBin: 'C:\\mock\\dws.exe', fixtureMode: false },
      dsh: { bin: 'C:\\mock\\dsh-bin.js', found: true, fixtureMode: false, timeoutSec: az.timeoutSec || 120 }
    };
  }
  if (seg[0] === 'radar' && seg[1] === 'engine' && seg[2] === 'test' && m === 'POST') {
    return { ok: true, latencyMs: 900 + Math.floor(Math.random() * 800), reply: 'OK（mock）' };
  }
  if (seg[0] === 'radar' && seg[1] === 'analyze' && seg.length === 2 && m === 'POST') {
    const ids = (body && body.messageIds) || [];
    if (!Array.isArray(ids) || !ids.length || ids.length > 50) throw new ApiError(400, 'FIELD_INVALID', 'messageIds 必填且为 1..50 个消息 id 的数组');
    const eligible = [];
    const skipped = [];
    for (const id of ids) {
      const msg = (d.radarMessages || []).find((x) => x.id === id);
      if (!msg) { skipped.push({ messageId: id, reason: 'NOT_FOUND' }); continue; }
      if (msg.analyzedAt && msg.analyzeState !== 'ANALYZE_FAILED') { skipped.push({ messageId: id, reason: 'ALREADY_ANALYZED' }); continue; }
      eligible.push(msg);
    }
    const job = mkJob('analyze', eligible.length);
    setTimeout(() => {
      for (const msg of eligible) {
        const fx = msg.mockAnalysis;
        if (!fx) { job.results.push({ item: msg.id, ok: false, error: 'mock 数据缺 mockAnalysis' }); msg.analyzeState = 'ANALYZE_FAILED'; msg.analyzedAt = null; }
        else {
          let added = 0;
          for (const t of (fx.tasks || [])) {
            if ((t.confidence || 0) < 0.5) continue;
            if ((d.inbox || []).some((c) => c.messageId === msg.id && c.quote === t.quote && c.title === t.title)) continue;
            d.inbox.push({
              id: `cand-${Math.random().toString(36).slice(2, 8)}`,
              messageId: msg.id, messageTitle: msg.title, occurredAt: msg.occurredAt,
              title: t.title, desc: t.desc || '', priority: t.priority || 'unset',
              suggestedMemberId: t.suggestedMemberId || '',
              matchSource: t.matchSource || null, // v1.8 透传：归人依据（真实后端 analyze 已带，预选说话人依赖它）
              dueHint: t.dueHint || '',
              confidence: t.confidence, quote: t.quote || '', rationale: t.rationale || '',
              speakerRaw: t.speakerRaw || '', state: 'pending', decidedAt: null, createdAt: nowIso()
            });
            added += 1;
          }
          msg.analyzedAt = nowIso();
          msg.analyzeState = 'ok';
          msg.analyzeError = null;
          msg.noise = (fx.noise || []).map((n) => ({ quote: n.quote || '', reason: n.reason || '' }));
          job.results.push({ item: msg.id, ok: true, added });
        }
        job.done += 1;
      }
      finishMockJob(job);
    }, 900);
    return { jobId: job.id, accepted: eligible.length, skipped };
  }
  if (seg[0] === 'inbox' && seg.length === 1 && m === 'GET') {
    const state = q.get('state');
    let list = (d.inbox || []).slice();
    if (state) list = list.filter((x) => x.state === state);
    list.sort((a, b) => (a.state === 'pending' && b.state === 'pending')
      ? b.confidence - a.confidence || Date.parse(b.createdAt) - Date.parse(a.createdAt)
      : Date.parse(b.decidedAt || b.createdAt) - Date.parse(a.decidedAt || a.createdAt));
    return clone(list);
  }
  if (seg[0] === 'inbox' && seg[1] === 'stats' && seg.length === 2 && m === 'GET') {
    const cutoff = Date.now() - 30 * 86400 * 1000;
    const counts = { pending: 0, confirmed: 0, rejected: 0, done_already: 0 };
    let c30 = 0, r30 = 0, d30 = 0;
    for (const c of d.inbox || []) {
      if (counts[c.state] !== undefined) counts[c.state] += 1;
      if ((c.state === 'confirmed' || c.state === 'rejected' || c.state === 'done_already')
        && c.decidedAt && Date.parse(c.decidedAt) >= cutoff) {
        if (c.state === 'confirmed') c30 += 1;
        else if (c.state === 'rejected') r30 += 1;
        else d30 += 1;
      }
    }
    // v1.7 契约：rejectRate30d = 拒/(确+已完成+拒)——已完成不再被当作误识
    const den = c30 + d30 + r30;
    return {
      ...counts,
      doneAlready: counts.done_already,
      confirmed30d: c30,
      rejected30d: r30,
      doneAlready30d: d30,
      rejectRate30d: den ? Math.round((r30 / den) * 10000) / 10000 : null
    };
  }
  if (seg[0] === 'inbox' && seg.length === 3 && seg[2] === 'confirm' && m === 'POST') {
    const cand = (d.inbox || []).find((x) => x.id === seg[1]);
    if (!cand) throw new ApiError(404, 'CANDIDATE_NOT_FOUND', '候选卡不存在');
    if (cand.state !== 'pending') throw new ApiError(409, 'ALREADY_DECIDED', `该候选已${cand.state === 'confirmed' ? '确认' : '拒绝'}，不可重复决定`);
    const b = body || {};
    // 叙事线第一批：任务更新提案（kind:"update"）——不建任务，memo 事件写入关联任务时间轴 + origin.relatedMemos 留痕
    if (cand.kind === 'update') {
      const target = d.tasks.find((x) => x.id === cand.existingTaskId);
      if (!target) throw new ApiError(400, 'TASK_NOT_FOUND', '关联任务不存在（可能已被删除），无法记入时间轴');
      const note = (b.note != null && b.note !== undefined) ? String(b.note).trim() : '';
      if (note.length > 500) throw new ApiError(400, 'VALIDATION', 'note 备注不能超过 500 字');
      const now = nowIso();
      pushEvent(target, 'memo', {
        from: null, to: null,
        detail: `${cand.messageTitle || '纪要'}：“${cand.quote || ''}”${note ? ' · 备注：' + note : ''}`
      });
      if (!target.origin) target.origin = { type: 'manual', relatedMemos: [] };
      if (!Array.isArray(target.origin.relatedMemos)) target.origin.relatedMemos = [];
      target.origin.relatedMemos.push({
        candidateId: cand.id, messageId: cand.messageId || null,
        quote: cand.quote || '', note, at: now
      });
      target.updatedAt = now;
      cand.state = 'confirmed';
      cand.decidedAt = now;
      cand.note = note;
      return clone({ task: target, candidate: cand, memoRecorded: true });
    }
    const title = b.title !== undefined ? String(b.title).trim() : cand.title;
    if (!title || title.length > 200) throw new ApiError(400, 'FIELD_INVALID', 'title 必填且为 1..200 字符');
    let memberId = b.memberId !== undefined ? b.memberId : cand.suggestedMemberId;
    memberId = memberId || null;
    let priority = b.priority !== undefined ? b.priority : cand.priority;
    if (!PRIORITIES.includes(priority)) priority = 'medium';
    const dueDate = b.dueDate || null;
    // v1.8 说话人/负责人解耦：别名写「说话人」的名册身份 speakerMemberId（谁说的），与负责成员 memberId（谁做）无关；
    // 契约：rememberAlias:true 但说话人未映射（未选人/无原始昵称）→ 不写别名，响应 rememberedAlias:null + reason:'SPEAKER_UNRESOLVED'
    const speakerMemberId = (b.speakerMemberId !== undefined ? b.speakerMemberId : '') || null;
    let aliasReason = null;
    let created = false; // 说话人映射目标自动建档/转正时置 true，响应带回（P1-C 语义沿用，落点改为说话人）
    let rememberedAlias = null;
    if (b.rememberAlias === true) {
      if (!cand.speakerRaw || !speakerMemberId) {
        aliasReason = 'SPEAKER_UNRESOLVED'; // 静默跳过别名，不阻断任务入库
      } else {
        let mem = (d.members || []).find((x) => x.id === speakerMemberId);
        if (!mem) {
          // P1-C 契约：目标成员不存在（手工名册 + 派生都没有）→ 自动建立名册档案，created:true
          mem = {
            id: speakerMemberId, name: String(speakerMemberId), kind: 'human', role: '', giteaLogin: '',
            enabled: true, manual: true, aliases: [], status: 'idle', currentTask: null,
            lastActivityAt: null, todayCommits: 0, openPrs: 0, weekDone: 0, session: null
          };
          d.members.push(mem);
          created = true;
        } else if (mem.manual !== true) {
          mem.manual = true; // Gitea 派生成员转正为名册条目，created:true
          created = true;
        }
        if (!Array.isArray(mem.aliases)) mem.aliases = [];
        if (!mem.aliases.some((a) => String(a).toLowerCase() === cand.speakerRaw.toLowerCase())) mem.aliases.push(cand.speakerRaw);
        rememberedAlias = { memberId: mem.id, alias: cand.speakerRaw, memberCreated: created };
      }
    }
    const now = nowIso();
    const task = {
      id: genTaskId(), title, status: 'todo', agentId: null, memberId, repo: null, branch: null, prUrl: null,
      notes: '', desc: b.desc !== undefined ? b.desc : (cand.desc || ''), dueDate, priority,
      artifacts: [],
      completedAt: null,
      createdAt: now, updatedAt: now,
      events: [{ type: 'created', from: null, to: 'todo', detail: '来自任务雷达确认入库', at: now }],
      origin: { type: 'inbox', refId: cand.id, quote: cand.quote || '' }
    };
    d.tasks.push(task);
    cand.state = 'confirmed';
    cand.decidedAt = now;
    cand.confirmedTaskId = task.id;
    cand.title = title;
    cand.suggestedMemberId = memberId;
    cand.speakerMemberId = speakerMemberId; // v1.8 审计留痕：说话人最终映射的身份（null=未映射）
    cand.dueDate = dueDate;
    const resp = { task, candidate: cand, created, rememberedAlias };
    if (aliasReason) resp.reason = aliasReason;
    return clone(resp);
  }
  if (seg[0] === 'inbox' && seg.length === 3 && seg[2] === 'reject' && m === 'POST') {
    const cand = (d.inbox || []).find((x) => x.id === seg[1]);
    if (!cand) throw new ApiError(404, 'CANDIDATE_NOT_FOUND', '候选卡不存在');
    if (cand.state !== 'pending') throw new ApiError(409, 'ALREADY_DECIDED', `该候选已决定过（${cand.state}），不可重复决定`);
    // v1.7 契约：reason 必填（duplicate/wont_do/invalid/other），缺失 → 400 REASON_REQUIRED
    const REASONS = ['duplicate', 'wont_do', 'invalid', 'other'];
    const reason = body && body.reason;
    if (!REASONS.includes(reason)) {
      throw new ApiError(400, 'REASON_REQUIRED', '缺少必填的拒绝原因 reason（duplicate / wont_do / invalid / other 四选一）');
    }
    const note = (body && body.note !== undefined && body.note !== null) ? String(body.note) : '';
    if (note.length > 500) throw new ApiError(400, 'VALIDATION', 'note 备注不能超过 500 字');
    cand.state = 'rejected';
    cand.reason = reason;
    cand.note = note;
    cand.decidedAt = nowIso();
    return clone(cand);
  }
  // v1.7 新增：标记为已完成（这事已经做完了）→ state=done_already，不入看板、计入误识率分母
  if (seg[0] === 'inbox' && seg.length === 3 && seg[2] === 'done-already' && m === 'POST') {
    const cand = (d.inbox || []).find((x) => x.id === seg[1]);
    if (!cand) throw new ApiError(404, 'CANDIDATE_NOT_FOUND', '候选卡不存在');
    if (cand.state !== 'pending') throw new ApiError(409, 'ALREADY_DECIDED', `该候选已决定过（${cand.state}），不可重复决定`);
    // 叙事线第一批契约：任务更新提案不适用「已完成」（它不是待办，是对已有任务的补充）
    if (cand.kind === 'update') {
      throw new ApiError(409, 'NOT_APPLICABLE', '任务更新提案不适用「已完成」：请确认以记入关联任务时间轴，或拒绝');
    }
    const note = (body && body.note !== undefined && body.note !== null) ? String(body.note) : '';
    if (note.length > 500) throw new ApiError(400, 'VALIDATION', 'note 备注不能超过 500 字');
    cand.state = 'done_already';
    cand.note = note;
    cand.decidedAt = nowIso();
    return clone(cand);
  }
  if (seg[0] === 'members' && seg.length === 3 && seg[2] === 'aliases' && m === 'POST') {
    const row = (d.members || []).find((x) => x.id === seg[1] && x.manual === true);
    if (!row) throw new ApiError(404, 'MEMBER_NOT_FOUND', '手工名册中不存在该成员');
    const alias = String((body && body.alias) || '').trim();
    if (!alias || alias.length > 50) throw new ApiError(400, 'MEMBER_INVALID', 'alias 必填且为 1..50 字符');
    if (!Array.isArray(row.aliases)) row.aliases = [];
    if (!row.aliases.some((a) => String(a).toLowerCase() === alias.toLowerCase())) row.aliases.push(alias);
    return clone(row);
  }

  throw new ApiError(404, 'NOT_FOUND', `接口不存在（mock）：${m} ${u.pathname}`);
}

registerMock(handle);
