'use strict';

/**
 * heatmap.js — v2.9.26 Agent 时间线热力图（「AI 编码时代的 WakaTime」）
 *
 * 六源会话按「日 × agent」聚合会话数与活跃时长。数据面=listAgentSessions 每源最近 50 条
 * （startedAt/lastActiveAt 现成，零新读入；50 条帽=概览口径，审计走会话阅读器）。
 * 口径：会话计入 lastActiveAt 所在日（本地时区）；时长=clamp(lastActive-started, 1min, 6h)——
 * 跨夜挂起会话整段计入最后活跃日、钳 6h 防单会话撑爆一格。
 * 输出：{days:[{date, agents:{<agent>:{sessions,minutes}}}], agents, totalSessions, totalMinutes, generatedAt}
 * 全只读零写盘零出网；单源故障该源零贡献不拖垮整体。
 */

const { sendJSON } = require('./router');
const at = require('./agentTranscript');
const snapshot = require('./sessionSnapshot');

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_DAYS = 28;
const MAX_DAYS = 90;
const MINUTES_CAP_PER_SESSION = 360; // 单会话时长钳制 6h
const MINUTES_FLOOR = 1; // 有会话活动至少计 1 分钟

/** 本地时区 YYYY-MM-DD（与日报/周报 dayKey 同口径） */
function localYmd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * buildHeatmap(config, opts) → 聚合结果（见文件头）
 * @param {{days?:number, now?:number, adapters?:object}} opts
 *   adapters: 源 id → () => items[] 注入缝（测试用；返回与 listAgentSessions.items 同形状）
 */
function buildHeatmap(config, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const days = Math.min(Math.max(Number(o.days) || DEFAULT_DAYS, 1), MAX_DAYS);
  const sinceDayStart = new Date(now - (days - 1) * DAY_MS);
  sinceDayStart.setHours(0, 0, 0, 0);
  const sinceMs = sinceDayStart.getTime();

  const perDayAgent = new Map(); // ymd -> Map(agent -> {sessions, minutes})
  const agentSet = new Set();
  let totalSessions = 0;
  let totalMinutes = 0;

  // v2.9.29 D3：六源会话统一走 sessionSnapshot（60s TTL 共享快照；adapters 纯注入语义不变）
  const { byAgent: snapByAgent } = snapshot.getSnapshot(config, { now, adapters: o.adapters });

  for (const agent of at.SOURCE_IDS) {
    const items = snapByAgent[agent] || [];
    for (const it of items) {
      const lastMs = Date.parse(it.lastActiveAt);
      if (!Number.isFinite(lastMs) || lastMs < sinceMs) continue;
      const startMs = Date.parse(it.startedAt);
      let minutes = MINUTES_FLOOR;
      if (Number.isFinite(startMs) && lastMs > startMs) {
        minutes = Math.min(Math.max(Math.round((lastMs - startMs) / 60000), MINUTES_FLOOR), MINUTES_CAP_PER_SESSION);
      }
      const ymd = localYmd(lastMs);
      if (!perDayAgent.has(ymd)) perDayAgent.set(ymd, new Map());
      const byAgent = perDayAgent.get(ymd);
      if (!byAgent.has(agent)) byAgent.set(agent, { sessions: 0, minutes: 0 });
      const entry = byAgent.get(agent);
      entry.sessions += 1;
      entry.minutes += minutes;
      agentSet.add(agent);
      totalSessions += 1;
      totalMinutes += minutes;
    }
  }

  return {
    days: Array.from({ length: days }, (_, i) => {
      const ymd = localYmd(sinceMs + i * DAY_MS);
      const byAgent = perDayAgent.get(ymd) || new Map();
      return {
        date: ymd,
        agents: Object.fromEntries([...byAgent].map(([a, c]) => [a, { sessions: c.sessions, minutes: c.minutes }])),
      };
    }),
    agents: [...agentSet],
    totalSessions,
    totalMinutes,
    generatedAt: new Date(now).toISOString(),
  };
}

/** 路由挂载：GET /api/agent-heatmap?days=28（days 钳 1..90） */
function registerHeatmapRoute(router, ctx) {
  router.add('GET', '/api/agent-heatmap', (c) => {
    const raw = c.query.get('days');
    const n = raw === null || raw === '' ? undefined : Number(raw);
    sendJSON(c.res, 200, buildHeatmap(ctx.config, { days: n }));
  });
}

module.exports = { buildHeatmap, registerHeatmapRoute, localYmd, DEFAULT_DAYS, MAX_DAYS };
