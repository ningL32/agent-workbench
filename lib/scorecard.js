'use strict';

/**
 * scorecard.js — v2.9.27 数字员工 Scorecard 传播卡（README 徽章式 SVG）
 *
 * GET /api/scorecard/<agent>.svg → 深色主题 SVG 卡片：
 *   agent 名 + 近 28 天 会话数 / 活跃分钟 / 触达项目数 / 最近活跃。
 * 数据面：复用 heatmap.buildHeatmap（listAgentSessions 每源 50 条帽，只读零写盘）。
 * 无该源数据 → 404 SCORECARD_NOT_FOUND（徽章显示 0 无意义，宁缺）。
 * 输出 Content-Type: image/svg+xml（sendJSON 不适用，原生 res 写）。
 * 数字全部来自本机观测，文案不夸大（传播卡纪律：数字即事实）。
 */

const at = require('./agentTranscript');
const heatmap = require('./heatmap');
const snapshot = require('./sessionSnapshot');
const { HttpError } = require('./router');

const AGENT_LABEL = { zcode: 'ZCode', claude: 'Claude Code', dsh: 'DSH', workbuddy: 'WorkBuddy', codex: 'Codex', opencode: 'OpenCode' };

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 分钟 → 人读（如 3.2h / 45m） */
function fmtMinutes(m) {
  if (m >= 600) return (m / 60).toFixed(1) + 'h';
  return String(m) + 'm';
}

/**
 * buildScorecard(config, agent, opts) → {agent,label,sessions,minutes,projects,lastActive,svg}
 * @param {{now?:number, adapters?:object}} opts（adapters 同 heatmap 纯注入语义）
 */
function buildScorecard(config, agent, opts) {
  const o = opts || {};
  if (!at.SOURCE_IDS.includes(agent)) throw new HttpError(400, 'BAD_AGENT', 'agent 必须为六源 id 之一');
  // v2.9.29 D3：直接吃共享快照（原实现寄居 buildHeatmap 再补一遍 list——双倍扫描已消灭）
  const { byAgent } = snapshot.getSnapshot(config, { now: o.now, adapters: o.adapters });
  const DAY_MS = 24 * 3600 * 1000;
  const WINDOW_MS = 28 * DAY_MS;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  let mySessions = 0;
  let myMinutes = 0;
  let lastActiveMs = null;
  const projects = new Set();
  for (const it of byAgent[agent] || []) {
    const lastMs = Date.parse(it.lastActiveAt);
    if (!Number.isFinite(lastMs) || lastMs < now - WINDOW_MS) continue; // 与热力图同窗口径
    mySessions += 1;
    const startMs = Date.parse(it.startedAt);
    myMinutes += Number.isFinite(startMs) && lastMs > startMs
      ? Math.min(Math.max(Math.round((lastMs - startMs) / 60000), 1), 360)
      : 1;
    if (lastMs && (lastActiveMs === null || lastMs > lastActiveMs)) lastActiveMs = lastMs;
    if (it.projectId) projects.add(String(it.projectId));
  }
  if (mySessions === 0) throw new HttpError(404, 'SCORECARD_NOT_FOUND', '该源近 28 天无会话数据');
  const lastActiveDaysAgo = lastActiveMs !== null
    ? Math.max(0, Math.round((now - lastActiveMs) / DAY_MS))
    : null;
  const label = AGENT_LABEL[agent] || agent;
  const svg = renderSvg({ agent, label, sessions: mySessions, minutes: myMinutes, projects: projects.size, lastActiveDaysAgo });
  return { agent, label, sessions: mySessions, minutes: myMinutes, projects: projects.size, svg };
}

function renderSvg(m) {
  const W = 460;
  const H = 132;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.label)} scorecard">
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="10" fill="#0f1216" stroke="rgba(148,163,184,.26)"/>
  <text x="20" y="34" font-family="Segoe UI,sans-serif" font-size="17" font-weight="700" fill="#e7ebf2">${esc(m.label)}</text>
  <text x="${W - 20}" y="34" text-anchor="end" font-family="Segoe UI,sans-serif" font-size="11" fill="#8b93a3">FDE Console · 28d</text>
  ${statCell(20, 58, String(m.sessions), 'sessions')}
  ${statCell(130, 58, fmtMinutes(m.minutes), 'active time')}
  ${statCell(240, 58, String(m.projects), 'projects')}
  ${statCell(350, 58, esc(fmtAgoDays(m.lastActiveDaysAgo)), 'last active')}
  <text x="20" y="${H - 14}" font-family="Segoe UI,sans-serif" font-size="10" fill="#8b93a3">local-only · cap 50 sessions/src · docs/ADAPTERS.md</text>
</svg>`;
}

function fmtAgoDays(d) {
  if (d === null || d === undefined) return '—';
  if (d === 0) return 'today';
  return d + 'd ago';
}

function statCell(x, y, value, label) {
  return `<text x="${x}" y="${y + 22}" font-family="Consolas,monospace" font-size="22" font-weight="700" fill="#34d399">${esc(value)}</text>
  <text x="${x}" y="${y + 40}" font-family="Segoe UI,sans-serif" font-size="10" fill="#8b93a3">${esc(label)}</text>`;
}

/** 路由挂载：GET /api/scorecard/<agent>[.svg]（router :param 捕获整段，.svg 后缀在 handler 内剥） */
function registerScorecardRoute(router, ctx) {
  router.add('GET', '/api/scorecard/:agent', (c) => {
    let r;
    try {
      r = buildScorecard(ctx.config, String(c.params.agent || '').replace(/\.svg$/i, ''), {});
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const body = JSON.stringify({ error: { code: (e && e.code) || 'INTERNAL', message: (e && e.message) || 'internal' } });
      c.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      c.res.end(body);
      return;
    }
    c.res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' });
    c.res.end(r.svg);
  });
}

module.exports = { buildScorecard, renderSvg, registerScorecardRoute, AGENT_LABEL };
