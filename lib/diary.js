'use strict';

/**
 * diary.js — 任务日报（v2.7）：多日任务的每日过程留痕
 *
 * - 存储 data/diary.json：[{taskId, date(YYYY-MM-DD), content(1..2000 字), updatedAt}]，裸数组；
 *   唯一键 taskId+date（同日再存 = 覆盖更新，updatedAt 刷新）；原子写走 store.writeJSON
 * - 端点（挂载于 appAssembler，任务路由之后）：
 *   GET    /api/tasks/:id/diary           → 该任务全部日报（按日期倒序）
 *   PUT    /api/tasks/:id/diary           → upsert（同日覆盖）→ 201 新建 / 200 覆盖
 *                                            + 事件流 type:"diary"（detail=`日报 <date>`，仅首存发，重写不重复发）
 *   DELETE /api/tasks/:id/diary/:date     → 204；该日期无日报 404 DIARY_NOT_FOUND
 *   GET    /api/tasks/:id/diary/prefill   → 预填 {date, giteaCommits, memoUpdates, draft}
 * ⚠ 路由注册顺序：prefill（5 段字面量）必须先于 :date（5 段参数）注册——router 先命中先得，
 *   反了会被 :date 吃掉返回 400。
 * - prefill 两数据源（均只读）：
 *   ① giteaCommits：data/activities.json 当天的 commit 类动态（feeds 词表 'commit'；存量
 *     commit_pushed 容错），匹配 = lib/attribute.js 精确规则
 *     （branch 相等 / task/<id> 前缀 / 标题含 [#taskId]）优先，任务 repo 相等兜底（存量动态
 *     branch 多为 null，只按 branch 永远命中不了）；url 非 http(s) 剔除（防伪协议进前端）。
 *   ② memoUpdates：data/task_events.json 该任务当天 type:"memo" 事件，detail 形如
 *     `纪要《标题》：引用原句`（lib/inbox.js 写入），拆为 {note:标题, quote:原句}；不合形态的
 *     旧数据兜底 quote=detail、note=''。
 * - 日期口径：预填 date 缺省 = 服务器本地今天；occurredAt/at（任意时区偏移的 ISO8601）换算到
 *   服务器本地 YYYY-MM-DD 再与参数做字符串相等比较（与 overview 逾期口径同时区，一致可预期）。
 * - 日期校验：正则 + 本地日历回读（与 dueDate 同款，拦 2026-02-30 / 2026-13-99），非法 400。
 * - 删任务顺带清理其全部日报（removeTaskDiaries，与 taskEvents.removeTaskEvents 同纪律）。
 * - 成员联动：/api/members 成员对象增 diaryToday（overview.js 调 taskIdsWithDiaryOn）。
 */

const store = require('./store');
const storeDb = require('./storeDb');
const path = require('node:path');
const { HttpError, sendJSON, noContent } = require('./router');
const taskEvents = require('./taskEvents');
const attribute = require('./attribute');

const CONTENT_MAX = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/i;

// ---------- 日期工具 ----------

function pad2(x) {
  return String(x).padStart(2, '0');
}

/** 时间戳（缺省 now）→ 服务器本地时区 YYYY-MM-DD */
function localYmd(ts) {
  const d = ts === undefined ? new Date() : new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ISO8601（任意时区偏移）→ 服务器本地日期；解析失败 null */
function localDateOf(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? localYmd(t) : null;
}

/** YYYY-MM-DD 校验：正则 + 本地日历回读（拦 2026-02-30 / 2026-13-99 这类正则通过但日历不存在的值） */
function validateYmd(v, label) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) {
    throw new HttpError(400, 'FIELD_INVALID', `${label} 必须为 YYYY-MM-DD 格式字符串`);
  }
  const parts = v.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    throw new HttpError(400, 'FIELD_INVALID', `${label} 不是有效日期`);
  }
  return v;
}

// ---------- 存储（原子写；唯一键 taskId+date） ----------

/** 容错读取：裸数组或 {diaries:[...]} 均容忍；缺失回退 []；剔除缺 taskId/date 的坏行。
 *  v2.9.33 批次 2：diary 迁移 → SQLite（storeDb 路由，返回形状不变） */
function loadDiaries(ctx) {
  if (storeDb.unitBackend(path.dirname(ctx.diaryPath), 'diary').backend === 'sqlite') {
    return storeDb.loadDiaries(storeDb.dbPathFor(path.dirname(ctx.diaryPath)));
  }
  const d = store.readJSON(ctx.diaryPath, null);
  let list = [];
  if (Array.isArray(d)) list = d;
  else if (store.isPlainObject(d) && Array.isArray(d.diaries)) list = d.diaries;
  return list.filter((x) => store.isPlainObject(x) && typeof x.taskId === 'string' && typeof x.date === 'string');
}

function saveDiaries(ctx, diaries) {
  if (storeDb.unitBackend(path.dirname(ctx.diaryPath), 'diary').backend === 'sqlite') {
    return storeDb.saveDiaries(storeDb.dbPathFor(path.dirname(ctx.diaryPath)), diaries);
  }
  store.writeJSON(ctx.diaryPath, diaries);
}

/**
 * upsert：同 taskId+date 覆盖（updatedAt 刷新），否则追加。
 * @returns {{diary:{taskId,date,content,updatedAt}, created:boolean}}
 */
function upsertDiary(ctx, taskId, date, content) {
  const diaries = loadDiaries(ctx);
  const now = new Date().toISOString();
  const found = diaries.find((x) => x.taskId === taskId && x.date === date);
  let created = false;
  if (found) {
    found.content = content;
    found.status = 'published';
    found.updatedAt = now;
  } else {
    diaries.push({ taskId, date, content, status: 'published', updatedAt: now });
    created = true;
  }
  saveDiaries(ctx, diaries);
  return { diary: { taskId, date, content, status: 'published', updatedAt: now }, created };
}

/** WAP 门禁：标记某条日报为 blocked（底层数据异常/质量不达标时人工调用） */
function blockDiary(ctx, taskId, date, reason) {
  const diaries = loadDiaries(ctx);
  const found = diaries.find((x) => x.taskId === taskId && x.date === date);
  if (!found) return false;
  found.status = 'blocked';
  found.blockReason = typeof reason === 'string' ? reason.slice(0, 200) : '';
  saveDiaries(ctx, diaries);
  return true;
}

/** WAP 门禁：解除 blocked（人工确认数据修复后恢复为 published） */
function unblockDiary(ctx, taskId, date) {
  const diaries = loadDiaries(ctx);
  const found = diaries.find((x) => x.taskId === taskId && x.date === date);
  if (!found) return false;
  found.status = 'published';
  delete found.blockReason;
  saveDiaries(ctx, diaries);
  return true;
}

/** 删除某任务某天日报；存在并删除 true，不存在 false（不写盘） */
function removeDiary(ctx, taskId, date) {
  const diaries = loadDiaries(ctx);
  const kept = diaries.filter((x) => !(x.taskId === taskId && x.date === date));
  if (kept.length === diaries.length) return false;
  saveDiaries(ctx, kept);
  return true;
}

/** 删任务顺带清理其全部日报；返回清理条数（无则零写盘） */
function removeTaskDiaries(ctx, taskId) {
  const diaries = loadDiaries(ctx);
  const kept = diaries.filter((x) => x.taskId !== taskId);
  if (kept.length === diaries.length) return 0;
  saveDiaries(ctx, kept);
  return diaries.length - kept.length;
}

/** 某任务全部日报，按日期倒序（YYYY-MM-DD 字符串序 = 日历序） */
function diariesForTask(ctx, taskId) {
  return loadDiaries(ctx)
    .filter((x) => x.taskId === taskId)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** 某天有日报的任务 id 集合（成员 diaryToday 联动用；纯读不落盘） */
function taskIdsWithDiaryOn(ctx, ymd) {
  const out = new Set();
  for (const d of loadDiaries(ctx)) {
    if (d.date === ymd) out.add(d.taskId);
  }
  return out;
}

// ---------- 预填（两数据源，全部只读） ----------

/**
 * 当天命中的 commit 类活动：attribute 精确规则优先（branch 相等 / task/<id> 前缀 / [#taskId]），
 * 任务 repo 相等兜底；url 非 http(s) 剔除。返回按 occurredAt 倒序（混合时区，按毫秒排）。
 * 提交类型判定：feeds 词表 'commit'（giteaClient activities/feeds 数据源）∪ 存量 'commit_pushed' 容错。
 */
function giteaCommitsFor(ctx, task, date) {
  const activities = store.loadActivities(ctx);
  const out = [];
  for (const act of activities) {
    if (!act || (act.type !== 'commit' && act.type !== 'commit_pushed')) continue;
    if (localDateOf(act.occurredAt) !== date) continue;
    const url = typeof act.url === 'string' ? act.url : '';
    if (!url || !HTTP_URL_RE.test(url)) continue; // 无 url / 伪协议剔除（与成果挂接同门槛）
    const precise = attribute.matchReason(act, task);
    const repoHit =
      precise === null && typeof task.repo === 'string' && task.repo !== '' && act.repo === task.repo;
    if (!precise && !repoHit) continue;
    out.push({
      sha: typeof act.sha === 'string' ? act.sha : null, // v2.0 前落盘的存量动态无 sha → null
      title: typeof act.title === 'string' ? act.title : '',
      url,
      occurredAt: typeof act.occurredAt === 'string' ? act.occurredAt : null,
    });
  }
  out.sort((a, b) => (Date.parse(b.occurredAt) || 0) - (Date.parse(a.occurredAt) || 0));
  return out;
}

/**
 * 当天该任务的 memo 事件 → [{quote, note}]（at 倒序）。
 * detail=`纪要《标题》：引用原句` 拆为 note=标题、quote=原句；不合形态兜底 quote=detail、note=''。
 */
function memoUpdatesFor(ctx, task, date) {
  const events = taskEvents.loadEvents(ctx);
  const out = [];
  for (const e of events) {
    if (!e || e.taskId !== task.id || e.type !== 'memo') continue;
    if (localDateOf(e.at) !== date) continue;
    const detail = typeof e.detail === 'string' ? e.detail : '';
    const m = detail.match(/^纪要《([\s\S]*?)》：([\s\S]*)$/);
    out.push({
      at: typeof e.at === 'string' ? e.at : null,
      quote: m ? m[2] : detail,
      note: m ? m[1] : '',
    });
  }
  out.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return out.map((x) => ({ quote: x.quote, note: x.note }));
}

/** 草稿文本：两块拼装；两块皆空 → ''（前端显示「无预填内容」） */
function buildDraft(giteaCommits, memoUpdates) {
  const lines = [];
  if (giteaCommits.length > 0) {
    lines.push(`■ Gitea 提交（${giteaCommits.length}）`);
    for (const c of giteaCommits) {
      lines.push(`- ${c.title || '(无提交说明)'}`);
      lines.push(`  ${c.url}`);
    }
  }
  if (memoUpdates.length > 0) {
    lines.push(`■ 纪要摘录（${memoUpdates.length}）`);
    for (const m of memoUpdates) {
      lines.push(`- 《${m.note}》：${m.quote}`);
    }
  }
  return lines.join('\n');
}

/** 预填聚合（路由与测试共用） */
function collectPrefill(ctx, task, date) {
  const giteaCommits = giteaCommitsFor(ctx, task, date);
  const memoUpdates = memoUpdatesFor(ctx, task, date);
  return { giteaCommits, memoUpdates, draft: buildDraft(giteaCommits, memoUpdates) };
}

// ---------- 路由 ----------

function validateContent(v) {
  if (typeof v !== 'string') throw new HttpError(400, 'FIELD_INVALID', 'content 必填且为字符串');
  if (v.length < 1 || v.length > CONTENT_MAX) {
    throw new HttpError(400, 'FIELD_INVALID', `content 长度必须为 1..${CONTENT_MAX} 字符`);
  }
  if (v.trim().length < 1) throw new HttpError(400, 'FIELD_INVALID', 'content 不能为纯空白');
  return v;
}

function registerDiaryRoutes(router, ctx) {
  function requireTask(c) {
    const { tasks } = store.loadTasks(ctx);
    const task = tasks.find((t) => t.id === c.params.id);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    return task;
  }

  // ⚠ 必须先于 DELETE/GET :date 同段数路由注册（见文件头「路由注册顺序」）
  router.add('GET', '/api/tasks/:id/diary/prefill', (c) => {
    const task = requireTask(c);
    const q = c.query.get('date');
    const date = q === null || q === '' ? localYmd() : validateYmd(q, 'date');
    const { giteaCommits, memoUpdates, draft } = collectPrefill(ctx, task, date);
    sendJSON(c.res, 200, { date, giteaCommits, memoUpdates, draft });
  });

  router.add('GET', '/api/tasks/:id/diary', (c) => {
    requireTask(c);
    sendJSON(c.res, 200, store.clone(diariesForTask(ctx, c.params.id)));
  });

  router.add('PUT', '/api/tasks/:id/diary', (c) => {
    const task = requireTask(c);
    const body = c.body || {};
    if (body.date === undefined || body.date === null) {
      throw new HttpError(400, 'FIELD_INVALID', 'date 必填（YYYY-MM-DD）');
    }
    const date = validateYmd(body.date, 'date');
    const content = validateContent(body.content);
    const { diary, created } = upsertDiary(ctx, task.id, date, content);
    // 事件流仅首存发（同日重写不重复发，防噪）
    if (created) {
      taskEvents.appendEvents(ctx, [
        taskEvents.makeEvent(task.id, 'diary', null, date, `日报 ${date}`, new Date().toISOString()),
      ]);
    }
    sendJSON(c.res, created ? 201 : 200, diary);
  });

  router.add('DELETE', '/api/tasks/:id/diary/:date', (c) => {
    requireTask(c);
    const date = validateYmd(c.params.date, 'date');
    if (!removeDiary(ctx, c.params.id, date)) {
      throw new HttpError(404, 'DIARY_NOT_FOUND', '该日期没有日报');
    }
    noContent(c.res);
  });
}

module.exports = {
  CONTENT_MAX,
  localYmd,
  localDateOf,
  validateYmd,
  loadDiaries,
  saveDiaries,
  upsertDiary,
  removeDiary,
  removeTaskDiaries,
  diariesForTask,
  taskIdsWithDiaryOn,
  giteaCommitsFor,
  memoUpdatesFor,
  buildDraft,
  collectPrefill,
  registerDiaryRoutes,
  blockDiary,
  unblockDiary,
};
