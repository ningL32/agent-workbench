'use strict';

/**
 * postmortem.js — v2.9.28 任务复盘闭环（done 时刻的确定性蒸馏）
 *
 * 「任务验收完成 ≠ 经验沉淀」——本模块把任务关联的证据（会话派工词/提交/日报）蒸馏为
 * 一页复盘数据：数字（会话/提交/日报/跨度）+ 证据列表（当时怎么派工的、做了哪些提交、
 * 哪天留了痕）。确定性聚合零 LLM（引擎蒸馏版待观察窗后评估）。
 *
 * 证据来源（全部只读）：
 *  - session 形态 artifacts（挂接的会话）→ ref 回读派工词（getDispatchPrompt 120s 缓存兜底）
 *  - commit/pr 形态 artifacts → repo/title/at（归因或手动挂接一视同仁）
 *  - diary.json → 本任务日报（日期+首行摘录）
 * 跨度口径：证据时间戳（会话 lastActive / 提交 at / 日报 updatedAt）min..max → 天数；
 * 证据为空 → spans 全 null（诚实空态，不拿任务 createdAt 充数）。
 */

const { HttpError, sendJSON } = require('./router');
const store = require('./store');
const at = require('./agentTranscript');
const diaryMod = require('./diary');

const DAY_MS = 24 * 3600 * 1000;
const EVIDENCE_CAP = 8; // 每类证据列表最多 8 条（复盘是一页纸不是流水账）
const DISPATCH_CAP = 160;
const DIARY_EXCERPT_CAP = 80;

function msOf(v) {
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : null;
}

/**
 * buildPostmortem(ctx, taskId, opts) → 复盘对象；任务不存在 404。
 * @param {{tasksPath:string, diaryPath:string, config:object}} ctx
 * @param {{now?:number}} opts
 */
function buildPostmortem(ctx, taskId, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const data = store.loadTasks(ctx);
  const task = (Array.isArray(data.tasks) ? data.tasks : []).find((t) => t && t.id === taskId);
  if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');

  const arts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const commits = [];
  const dispatchWords = [];
  const seenRefs = new Set();
  const times = [];

  for (const a of arts) {
    if (!a) continue;
    if (a.kind === 'commit' || a.kind === 'pr') {
      commits.push({ kind: a.kind, repo: a.repo || null, title: String(a.title || ''), at: a.at || null });
      const t = msOf(a.at);
      if (t != null) times.push(t);
    } else if (a.kind === 'session' && typeof a.sessionRef === 'string' && !seenRefs.has(a.sessionRef)) {
      seenRefs.add(a.sessionRef);
      let dispatchText = '';
      try {
        const d = at.getDispatchPrompt(ctx.config, a.sessionRef, { now });
        if (d && d.found) dispatchText = String(d.text || '');
      } catch (e) { /* 会话消失/源故障：降级为仅标题 */ }
      dispatchWords.push({
        agent: null, // ref 解码可得源——按需再算，保持 payload 精简
        ref: a.sessionRef,
        title: String(a.title || ''),
        dispatchText: dispatchText.length > DISPATCH_CAP ? dispatchText.slice(0, DISPATCH_CAP) : dispatchText,
        at: a.at || null,
      });
      const t = msOf(a.at);
      if (t != null) times.push(t);
    }
  }
  commits.sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));

  let diaries = [];
  try {
    diaries = diaryMod
      .loadDiaries({ diaryPath: ctx.diaryPath })
      .filter((d) => d && d.taskId === taskId)
      .sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')))
      .slice(0, EVIDENCE_CAP)
      .map((d) => ({
        date: d.date,
        excerpt: String(d.content || '').replace(/\s+/g, ' ').slice(0, DIARY_EXCERPT_CAP),
        updatedAt: d.updatedAt || null,
      }));
    for (const d of diaries) {
      const t = msOf(d.updatedAt);
      if (t != null) times.push(t);
    }
  } catch (e) { /* diary 缺失：日报计数 0 */ }

  // 补充证据时间：任务创建/完成（有证据才有跨度意义，但完成时刻参与 min/max 不虚增下限——
  // 只在已有证据时并入，避免「创建即 0 天」的空任务也出跨度）
  if (times.length > 0) {
    const doneMs = msOf(task.completedAt);
    if (doneMs != null) times.push(doneMs);
  }

  let span = { firstAt: null, lastAt: null, days: null };
  if (times.length > 0) {
    const min = Math.min(...times);
    const max = Math.max(...times);
    span = {
      firstAt: new Date(min).toISOString(),
      lastAt: new Date(max).toISOString(),
      days: Math.round((max - min) / DAY_MS),
    };
  }

  return {
    task: {
      id: task.id,
      title: task.title || '',
      status: task.status || '',
      completedAt: task.completedAt || null,
      acceptorId: task.acceptorId || null,
    },
    counts: {
      commits: commits.length,
      prs: commits.filter((c) => c.kind === 'pr').length,
      sessions: dispatchWords.length,
      diaries: diaries.length,
    },
    span,
    evidence: {
      dispatchWords: dispatchWords.slice(0, EVIDENCE_CAP),
      commits: commits.slice(0, EVIDENCE_CAP),
      diaries,
    },
    generatedAt: new Date(now).toISOString(),
  };
}

/** 路由挂载：GET /api/tasks/:id/postmortem（appAssembler 任务路由之后） */
function registerPostmortemRoute(router, ctx) {
  router.add('GET', '/api/tasks/:id/postmortem', (c) => {
    sendJSON(
      c.res,
      200,
      buildPostmortem({ tasksPath: ctx.tasksPath, diaryPath: ctx.diaryPath, config: ctx.config }, c.params.id, {})
    );
  });
}

module.exports = { buildPostmortem, registerPostmortemRoute, EVIDENCE_CAP };
