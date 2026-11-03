'use strict';

/**
 * sessionSuggest.js — v2.9.24 会话成果自动归因建议（验收证据自动送货上门）
 *
 * 定位：闭环四环「看见→理解→归因→验收」的归因环补最后一块——commit 已自动归因（lib/attribute.js
 * branch 约定），而会话（AI 干活的直接证据）仍要人工去智能体动态里狩猎挂接。本模块产出
 * 「建议挂接」候选（排序+理由），**绝不自动落库**——人工一键确认走既有 POST artifacts（雷达同款
 * 「AI 提议 → 人工闸门」哲学）。
 *
 * 识别链（宁缺勿滥，attribute.js 同款纪律）：
 *   ① 主键（确定性）：task.projectDir 与 session.projectId 经 normalizeProjectKey 归一相等 → 入候选池。
 *      绑定项目只圈候选不唯一（多任务可绑同一目录）；未绑定项目 → 空建议零扫描。
 *   ② 排序信号（只加分减分不做门禁——真机实证：派工词与任务标题词项重合可为零但分明是同一活）：
 *      - 时间窗：活跃于 [createdAt-7d, completedAt||now] +2；已完成任务完成时刻之后 -3；早于创建 7 天前 -2
 *      - commit 桥：会话活跃时刻 ±24h 内有本任务已归因的 commit/pr 成果 +2
 *      - 文本：派工词命中任务全文 +2；有真人派工词 +1
 *      - 近期：7 天内活跃 +1
 *   ③ 闸门：score < SCORE_THRESHOLD 不出（宁缺）；已挂 sessionRef 出局（幂等）；每源最多取
 *      PER_SOURCE_CAND 条最近会话，总分排序后截 SUGGEST_CAP 条。
 *
 * 数据面：会话候选复用 lib/workSearch 的六源标题索引（60s TTL 共享缓存，项目过滤零重复成本）；
 * 派工词复用 lib/agentTranscript.getDispatchPrompt（120s TTL 缓存）。全部只读零写盘零出网。
 */

const { HttpError, sendJSON } = require('./router');
const store = require('./store');
const at = require('./agentTranscript');
const ws = require('./workSearch');

const DAY_MS = 24 * 3600 * 1000;
const BRIDGE_WINDOW_MS = DAY_MS; // commit 桥：±24h
const CREATED_BEFORE_GRACE_MS = 7 * DAY_MS; // 任务创建前 7 天内的活跃不算「太早」
const RECENT_WINDOW_MS = 7 * DAY_MS;
const SCORE_THRESHOLD = 2;
const PER_SOURCE_CAND = 5; // 每源最近 5 条进候选（后再统一排序截帽）
const SUGGEST_CAP = 5;
const DISPATCH_DISPLAY_CAP = 120; // 建议卡片展示派工词首行长度

function msOf(v) {
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : null;
}

/** 文本信号打分：派工词 vs 任务标题/描述（返回 {score, textHit}） */
function textScore(dispatchText, task) {
  const t = String(dispatchText || '').trim();
  if (!t) return { score: 0, textHit: false };
  let score = 1; // 有真人派工词本身就是信号
  const hay = `${task.title || ''}\n${task.desc || ''}`;
  const needle = String(task.title || '').trim();
  if (needle && needle.length >= 4 && t.includes(needle)) score += 2;
  else if (hay && t.includes(hay.split('\n')[0])) score += 2;
  return { score, textHit: needle.length >= 4 && t.includes(needle) };
}

/**
 * 单任务 × 单会话候选打分（透明规则，逐条给 reasons 供前端展示）
 * @returns {{score:number, reasons:string[]}}
 */
function scoreCandidate(sess, task, nowMs) {
  const reasons = [];
  let score = 0;
  const lastMs = msOf(sess.lastActiveAt);
  const createdMs = msOf(task.createdAt);
  const completedMs = msOf(task.completedAt);

  // 时间窗
  if (lastMs != null) {
    if (completedMs != null && lastMs > completedMs) {
      score -= 3;
      reasons.push('任务完成之后才活跃');
    } else if (createdMs != null && lastMs >= createdMs - CREATED_BEFORE_GRACE_MS && (completedMs == null || lastMs <= completedMs)) {
      score += 2;
      reasons.push('活跃于任务时间窗内');
    } else if (createdMs != null && lastMs < createdMs - CREATED_BEFORE_GRACE_MS) {
      score -= 2;
      reasons.push('远早于任务创建');
    }
    if (nowMs - lastMs <= RECENT_WINDOW_MS) {
      score += 1;
      reasons.push('近期活跃');
    }
  }

  // commit 桥：本任务已归因 commit/pr 的 at与会话活跃 ±24h
  const arts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const bridged = arts.some((a) => {
    if (!a || (a.kind !== 'commit' && a.kind !== 'pr')) return false;
    const atMs = msOf(a.at);
    return atMs != null && lastMs != null && Math.abs(atMs - lastMs) <= BRIDGE_WINDOW_MS;
  });
  if (bridged) {
    score += 2;
    reasons.push('同期有本任务归因提交');
  }

  // 文本信号
  const ts = textScore(sess.dispatchText, task);
  score += ts.score;
  if (ts.textHit) reasons.push('派工词提及本任务');

  return { score, reasons };
}

/**
 * suggestSessionsForTask(ctx, taskId, opts)
 * → {task:{id,title,projectDir}, items:[{agent,ref,title,dispatchText,lastActiveAt,score,reasons}]}
 * 任务不存在 404；未绑定项目 → items:[]（零扫描）；阈值下不显示（宁缺勿滥）。
 * @param {{tasksPath:string, config:object}} ctx
 * @param {{freshIndex?:boolean, now?:number}} opts
 */
function suggestSessionsForTask(ctx, taskId, opts) {
  const o = opts || {};
  const nowMs = Number.isFinite(o.now) ? o.now : Date.now();
  const data = store.loadTasks(ctx);
  const task = (Array.isArray(data.tasks) ? data.tasks : []).find((t) => t && t.id === taskId);
  if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
  const projectDir = typeof task.projectDir === 'string' ? task.projectDir.trim() : '';
  const base = { task: { id: task.id, title: task.title || '', projectDir }, items: [] };
  if (!projectDir) return base; // 未绑定：零扫描

  const want = at.normalizeProjectKey(projectDir);
  const existingRefs = new Set(
    (Array.isArray(task.artifacts) ? task.artifacts : [])
      .filter((a) => a && a.kind === 'session' && typeof a.sessionRef === 'string')
      .map((a) => a.sessionRef)
  );

  // 候选池：六源标题索引（TTL 共享）项目过滤，每源截最近 PER_SOURCE_CAND 条
  const index = ws.buildSessionIndex(ctx.config, nowMs, !!o.freshIndex);
  const perSourceCount = new Map();
  const cands = [];
  for (const it of index) {
    if (at.normalizeProjectKey(it.projectId) !== want) continue;
    if (existingRefs.has(it.ref)) continue; // 幂等：已挂不重推
    const n = perSourceCount.get(it.agent) || 0;
    if (n >= PER_SOURCE_CAND) continue;
    perSourceCount.set(it.agent, n + 1);
    cands.push(it);
  }

  const items = [];
  for (const c of cands) {
    let dispatchText = '';
    try {
      const d = at.getDispatchPrompt(ctx.config, c.ref, { now: nowMs });
      if (d && d.found) dispatchText = String(d.text || '');
    } catch (e) { /* 会话消失/源故障：该候选降级为无派工词继续参评 */ }
    const { score, reasons } = scoreCandidate(
      { lastActiveAt: c.lastActiveAt, dispatchText },
      task,
      nowMs
    );
    if (score < SCORE_THRESHOLD) continue; // 闸门：宁缺勿滥
    items.push({
      agent: c.agent,
      ref: c.ref,
      title: c.title || '',
      dispatchText: dispatchText.length > DISPATCH_DISPLAY_CAP ? dispatchText.slice(0, DISPATCH_DISPLAY_CAP) : dispatchText,
      lastActiveAt: c.lastActiveAt,
      score,
      reasons,
    });
  }
  items.sort((a, b) => b.score - a.score || String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')));
  base.items = items.slice(0, SUGGEST_CAP);
  return base;
}

/** 路由挂载：GET /api/tasks/:id/session-suggestions（appAssembler 任务路由之后调用） */
function registerSessionSuggestRoute(router, ctx) {
  router.add('GET', '/api/tasks/:id/session-suggestions', (c) => {
    sendJSON(c.res, 200, suggestSessionsForTask({ tasksPath: ctx.tasksPath, config: ctx.config }, c.params.id, {}));
  });
}

module.exports = {
  suggestSessionsForTask,
  registerSessionSuggestRoute,
  scoreCandidate,
  textScore,
  SCORE_THRESHOLD,
  PER_SOURCE_CAND,
  SUGGEST_CAP,
};
