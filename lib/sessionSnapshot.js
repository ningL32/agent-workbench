'use strict';

/**
 * sessionSnapshot.js — v2.9.29 六源会话快照（读时聚合共享层，D3 债务收敛）
 *
 * heatmap / scorecard / agentContext 三个消费方曾各自 listAgentSessions(limit 50)——
 * 同一请求周期内重复全源扫描（scorecard 甚至双倍）。本模块提供 60s TTL 进程内快照：
 *   getSnapshot(config, {now, adapters})
 *     - adapters 提供时 = 纯注入模式（同 heatmap 语义：未注入源零贡献、绝不回落真实路径、绝不走缓存）
 *     - 否则一次扫描六源（limit 50/源，单源故障零贡献），缓存 {at, byAgent}
 * 消费方拿到的每条 item 形状 = listAgentSessions.items（id/title/projectId/startedAt/lastActiveAt/state/ref）。
 * workSearch 暂留自有索引（同 TTL 语义，P1 再并）；dispatchPrompt 缓存独立（粒度不同）。
 */

const at = require('./agentTranscript');

const SNAPSHOT_TTL_MS = 60 * 1000;
const PER_SOURCE_LIMIT = 50;

let cache = { at: 0, byAgent: null };

function scan(config) {
  const byAgent = {};
  for (const agent of at.SOURCE_IDS) {
    try {
      const page = at.listAgentSessions(config, { agent, limit: PER_SOURCE_LIMIT });
      byAgent[agent] = Array.isArray(page.items) ? page.items : [];
    } catch (e) {
      byAgent[agent] = []; // 单源故障隔离：零贡献
    }
  }
  return byAgent;
}

/**
 * getSnapshot(config, opts) → { byAgent: {<agent>: items[]}, fromCache: boolean }
 * @param {{now?:number, adapters?:object}} opts
 */
function getSnapshot(config, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const injectMode = o.adapters !== undefined && o.adapters !== null && typeof o.adapters === 'object';
  if (injectMode) {
    const byAgent = {};
    for (const agent of at.SOURCE_IDS) {
      const injected = typeof o.adapters[agent] === 'function' ? o.adapters[agent] : null;
      if (!injected) { byAgent[agent] = []; continue; }
      try {
        const items = injected();
        byAgent[agent] = Array.isArray(items) ? items : [];
      } catch (e) {
        byAgent[agent] = []; // 注入源抛错 = 该源零贡献（同真实源隔离语义）
      }
    }
    return { byAgent, fromCache: false };
  }
  if (cache.byAgent && now - cache.at < SNAPSHOT_TTL_MS) return { byAgent: cache.byAgent, fromCache: true };
  cache = { at: now, byAgent: scan(config) };
  return { byAgent: cache.byAgent, fromCache: false };
}

/** 测试/换配置场景强制失效 */
function clearSnapshot() {
  cache = { at: 0, byAgent: null };
}

module.exports = { getSnapshot, clearSnapshot, SNAPSHOT_TTL_MS, PER_SOURCE_LIMIT };
