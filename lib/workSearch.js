'use strict';

/**
 * workSearch.js — v2.9.23 工作搜索（考古层）：跨任务/会话/提交/日报的统一只读检索
 *
 * 定位：把观测层的「看见」升级成「找到」——程序员工作台的找回入口（Ctrl+K）。
 * 数据面=全部既有数据的读时聚合，零新存储、零写盘、零出网：
 *   ① tasks.json      标题+描述+成果提交说明（artifacts.title/messageBody）
 *   ② 六源会话标题     listAgentSessions 聚合（60s TTL 索引；标题即首问/首条文本，4/6 源原生；
 *                      zcode 为客户端会话题名）——不做全文转录提取（每会话 ≤4MB 读入，搜索场景不经济）
 *   ③ activities.json  统一动态流的 commit/pr（title+messageBody+repo，≤500 条滚动窗）
 *   ④ diary.json       日报全文（≤2000 字/篇）
 * 匹配口径：查询按空白拆词（≤6 词），全部词项出现在该条目的字段拼接文本中才算命中
 * （AND across terms / OR across fields）；大小写不敏感；摘要=首个命中字段词项首现 ± 窗口。
 * 脱敏：全部出口文本过 redact（会话标题在 listAgentSessions 内已过，其余在此补）。
 * 红线：单源/单文件故障该组空返不拖垮整体；响应只增不改（新端点）。
 */

const path = require('node:path');
const { HttpError, sendJSON } = require('./router');
const store = require('./store');
const redactMod = require('./redact');
const diaryMod = require('./diary');
const at = require('./agentTranscript');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const MAX_TERMS = 6; // 查询最多取前 6 个词项（防病态长查询）
const MAX_PER_GROUP = 8;
const SESSION_INDEX_TTL_MS = 60 * 1000;
const SESSION_INDEX_LIMIT = 50; // 每源最近 50 条（sessionList.maxLimit 上限，单次调用不翻页）
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 90;

/** 会话标题索引（进程内 TTL 缓存；重建=六源 listAgentSessions，源失败该源跳过） */
let sessionIndex = { at: 0, items: [] };

function redactText(t) {
  try {
    return redactMod.redact(t);
  } catch (e) {
    return String(t);
  }
}

function parseTerms(q) {
  return String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
}

/** 命中判定：全部词项出现在字段拼接的小写文本里（AND across terms / OR across fields） */
function fieldsHit(fields, lowerTerms) {
  const hay = fields.map((f) => String(f || '').toLowerCase()).join('\n');
  return lowerTerms.every((t) => hay.includes(t));
}

/** 摘要：首个命中字段取词项首现位置 ± 窗口；压平空白；无命中兜底首字段截断 */
function snippetOf(fields, lowerTerms) {
  for (const raw of fields) {
    if (!raw) continue;
    const s = String(raw);
    const low = s.toLowerCase();
    let idx = -1;
    for (const t of lowerTerms) {
      const i = low.indexOf(t);
      if (i >= 0 && (idx < 0 || i < idx)) idx = i;
    }
    if (idx >= 0) {
      const start = Math.max(0, idx - SNIPPET_BEFORE);
      const end = Math.min(s.length, idx + SNIPPET_AFTER);
      return (start > 0 ? '…' : '') + s.slice(start, end).replace(/\s+/g, ' ').trim() + (end < s.length ? '…' : '');
    }
  }
  return String(fields.find(Boolean) || '').slice(0, 80);
}

function buildSessionIndex(config, now, fresh) {
  if (!fresh && now - sessionIndex.at < SESSION_INDEX_TTL_MS) return sessionIndex.items;
  const items = [];
  for (const agent of at.SOURCE_IDS) {
    try {
      const page = at.listAgentSessions(config, { agent, limit: SESSION_INDEX_LIMIT });
      for (const it of page.items || []) {
        items.push({
          agent,
          ref: it.ref,
          title: it.title,
          projectId: it.projectId,
          lastActiveAt: it.lastActiveAt,
        });
      }
    } catch (e) { /* 单源故障隔离：该源跳过（HttpError 也在内——索引场景没有可上报语义） */ }
  }
  sessionIndex = { at: now, items };
  return items;
}

/** 相对 dataDir 以项目根兜底（与 lib/attribute.js dataPath 同口径；只拼路径不建目录） */
function dataPath(cfg, name) {
  const dir = path.isAbsolute(cfg.dataDir) ? cfg.dataDir : path.join(PROJECT_ROOT, cfg.dataDir);
  return path.join(dir, name);
}

/**
 * workSearch(config, q, opts) → { q, tookMs, total, groups:{tasks,sessions,commits,diaries} }
 * 四组各截 MAX_PER_GROUP 条；组序固定=任务/会话/提交/日报。组内按各自时间倒序。
 * @param {{freshIndex?:boolean, now?:number}} opts freshIndex=跳过会话索引 TTL（测试用）
 */
function workSearch(config, q, opts) {
  const o = opts || {};
  const started = Date.now();
  const terms = parseTerms(q);
  if (!terms.length) throw new HttpError(400, 'FIELD_INVALID', '搜索词不能为空');
  const lowerTerms = terms.map((t) => t.toLowerCase());
  const now = Number.isFinite(o.now) ? o.now : Date.now();

  // ① 任务（标题+描述+成果说明；时间倒序）
  const tasks = [];
  try {
    const data = store.loadTasks({ tasksPath: dataPath(config, 'tasks.json') });
    for (const t of Array.isArray(data.tasks) ? data.tasks : []) {
      if (!t || typeof t.id !== 'string') continue;
      const arts = Array.isArray(t.artifacts) ? t.artifacts : [];
      const artText = arts
        .map((a) => [a && a.title, a && a.messageBody].filter(Boolean).join(' '))
        .join(' ');
      const fields = [t.title, t.desc, artText];
      if (!fieldsHit(fields, lowerTerms)) continue;
      tasks.push({
        id: t.id,
        title: redactText(String(t.title || '')),
        status: typeof t.status === 'string' ? t.status : '',
        snippet: redactText(snippetOf(fields, lowerTerms)),
        updatedAt: t.updatedAt || null,
      });
    }
    tasks.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  } catch (e) { /* tasks.json 缺失/损坏：任务组空返 */ }

  // ② 会话（六源标题索引，TTL；标题已被 listAgentSessions redact）
  const sessions = [];
  try {
    for (const it of buildSessionIndex(config, now, o.freshIndex)) {
      if (!fieldsHit([it.title, it.projectId], lowerTerms)) continue;
      sessions.push({
        agent: it.agent,
        ref: it.ref,
        title: it.title,
        projectId: it.projectId,
        lastActiveAt: it.lastActiveAt,
      });
    }
    sessions.sort((a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')));
  } catch (e) { /* 索引失败：会话组空返 */ }

  // ③ 提交 / PR（activities.json 统一动态流；无 url 的条目仍返回、前端降级不可点）
  const commits = [];
  try {
    const acts = store.loadActivities({ activitiesPath: dataPath(config, 'activities.json') });
    for (const a of Array.isArray(acts) ? acts : []) {
      if (!a || (a.type !== 'commit' && a.type !== 'pr')) continue;
      const fields = [a.title, a.messageBody, a.repo];
      if (!fieldsHit(fields, lowerTerms)) continue;
      commits.push({
        kind: a.type,
        title: redactText(String(a.title || '')),
        repo: a.repo == null ? null : String(a.repo),
        url: typeof a.url === 'string' ? a.url : '',
        at: a.occurredAt || null,
        snippet: redactText(snippetOf(fields, lowerTerms)),
      });
    }
    commits.sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
  } catch (e) { /* activities.json 缺失：提交组空返 */ }

  // ④ 日报（diary.json 全文；命中挂 taskId 深链）
  const diaries = [];
  try {
    const list = diaryMod.loadDiaries({ diaryPath: dataPath(config, 'diary.json') });
    for (const d of list) {
      const fields = [d.content, d.date];
      if (!fieldsHit(fields, lowerTerms)) continue;
      diaries.push({
        taskId: d.taskId,
        date: d.date,
        snippet: redactText(snippetOf(fields, lowerTerms)),
        updatedAt: d.updatedAt || null,
      });
    }
    diaries.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  } catch (e) { /* diary.json 缺失：日报组空返 */ }

  const groups = {
    tasks: tasks.slice(0, MAX_PER_GROUP),
    sessions: sessions.slice(0, MAX_PER_GROUP),
    commits: commits.slice(0, MAX_PER_GROUP),
    diaries: diaries.slice(0, MAX_PER_GROUP),
  };
  let total = 0;
  for (const k of Object.keys(groups)) total += groups[k].length;
  return { q: String(q || ''), tookMs: Date.now() - started, total, groups };
}

/** 路由挂载：GET /api/work-search?q=（空 q → 400 FIELD_INVALID） */
function registerWorkSearchRoute(router, ctx) {
  router.add('GET', '/api/work-search', (c) => {
    const q = c.query.get('q') || '';
    sendJSON(c.res, 200, workSearch(ctx.config, q, {}));
  });
}

module.exports = {
  workSearch,
  registerWorkSearchRoute,
  parseTerms,
  fieldsHit,
  snippetOf,
  buildSessionIndex,
  MAX_PER_GROUP,
  MAX_TERMS,
};
