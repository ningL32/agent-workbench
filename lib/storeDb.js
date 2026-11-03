'use strict';

/**
 * storeDb.js — v2.9.33 存储后端抽象的 SQLite 侧核心（红线 3 修订后的执行体）
 *
 * data/fde.db（WAL）：第一批承载 messages / task_events 两单元（SPEC-STORAGE §1.1）。
 * - 单元台账：meta 表 key='unit:<name>'；进程内缓存一次读取——台账无该单元 = 该单元仍走 JSON
 *   （路由以台账为准，绝不以「db 文件存在」为准）；迁移器（lib/migration.js）是台账唯一写入方
 * - 读写全部 prepared statement 参数绑定（零拼接——Mimosa 生成前约束+本仓安全纪律）
 * - 损坏：quick_check 失败 → fde.db 改名 *.corrupt-* → throw 503 DATA_CORRUPT（受影响路由
 *   500 loud；**绝不静默回落 JSON 旧数据**——JSON 原档已在迁移时改名归档，回落=拿旧数据当新数据）
 * - 事务：BEGIN IMMEDIATE / COMMIT / ROLLBACK（同步 API；busy_timeout 5s 跨进程排队）
 * - 本模块不建业务表（DDL 归迁移器）；openDb 只打开已存在的库
 */

const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./router');

const DB_NAME = 'fde.db';
const handles = new Map();      // dbPath -> DatabaseSync（进程内单例）
const ledgerCache = new Map();  // dbPath -> Set(unit)（台账缓存；clearCache 可清）

/** dataDir 或某数据文件路径 → fde.db 绝对路径 */
function dbPathFor(dataDirOrFile) {
  const base = path.extname(dataDirOrFile) ? path.dirname(dataDirOrFile) : dataDirOrFile;
  return path.join(base, DB_NAME);
}

function corrupt(dbPath, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${dbPath}.corrupt-${stamp}`;
  try {
    fs.renameSync(dbPath, backup);
    console.error(`[storeDb] ${dbPath} quick_check 失败（${reason}），已保全为 ${backup}；受影响数据路由将 500，请用备份恢复`);
  } catch (e) {
    console.error(`[storeDb] ${dbPath} 损坏且隔离失败: ${e.message}`);
  }
  handles.delete(dbPath);
  ledgerCache.delete(dbPath);
}

/** 打开已存在的库（单例）。损坏 → 改名保全并 throw；库不存在 → null（调用方走 JSON 路径） */
function openDb(dbPath) {
  if (handles.has(dbPath)) return handles.get(dbPath);
  if (!fs.existsSync(dbPath)) return null;
  const { DatabaseSync } = require('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    const qc = db.prepare('PRAGMA quick_check').get();
    if (!qc || !/^ok/i.test(String(qc.quick_check || ''))) {
      corrupt(dbPath, String(qc && qc.quick_check));
      throw new HttpError(503, 'DATA_CORRUPT', 'fde.db 完整性检查失败，原库已隔离为 *.corrupt-*，请用备份恢复');
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    corrupt(dbPath, (e && e.message) || 'open failed');
    throw new HttpError(503, 'DATA_CORRUPT', `fde.db 打开失败：${(e && e.message) || e}`);
  }
  handles.set(dbPath, db);
  return db;
}

/** 读台账（缓存）：meta 表 key LIKE 'unit:%' → Set(unit)；无 meta 表 = 空台账 */
function readLedger(db) {
  const set = new Set();
  try {
    const rows = db.prepare("SELECT key FROM meta WHERE key LIKE 'unit:%'").all();
    for (const r of rows) set.add(String(r.key).slice('unit:'.length));
  } catch (e) {
    return set; // meta 表不存在 = 尚未迁移任何单元
  }
  return set;
}

/** 已迁移单元集合（备份恢复的自动重导入用；库不存在返回 null） */
function unitsMigrated(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const db = openDb(dbPath);
  if (!ledgerCache.has(dbPath)) ledgerCache.set(dbPath, readLedger(db));
  return ledgerCache.get(dbPath);
}

/** 单元路由：'sqlite' | 'json'。库不存在/台账无该单元 → json（零行为变更的默认态） */
function unitBackend(dataDirOrFile, unit) {
  const dbPath = dbPathFor(dataDirOrFile);
  if (!fs.existsSync(dbPath)) return { backend: 'json', dbPath };
  const db = openDb(dbPath);
  if (!ledgerCache.has(dbPath)) ledgerCache.set(dbPath, readLedger(db));
  return {
    backend: ledgerCache.get(dbPath).has(unit) ? 'sqlite' : 'json',
    dbPath,
  };
}

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 已回滚/连接异常 */ }
    throw e;
  }
}

// ---------- messages（第一批） ----------

const MSG_COLS = 'id, title, source, occurred_at, created_at, analyzed_at, analyze_state, analyze_attempts, data';

/** → 消息数组（形状与 JSON 后端逐字段同构：data 列=原始对象真源，投影列只写不读） */
function loadMessages(dbPath) {
  const db = openDb(dbPath);
  const rows = db.prepare(`SELECT ${MSG_COLS} FROM messages ORDER BY rowid`).all();
  return rows.map((r) => {
    let obj = {};
    try { obj = JSON.parse(r.data); } catch (e) { obj = {}; }
    // data 为真源；投影列仅兜底（防御 data 缺键的极端行）
    return Object.assign(obj, {
      id: obj.id || r.id,
      title: obj.title === undefined ? r.title : obj.title,
    });
  });
}

/** 全量替换语义（与 JSON 后端同构）：事务内 DELETE ALL + INSERT 全量 */
function saveMessages(dbPath, messages) {
  const db = openDb(dbPath);
  const ins = db.prepare(
    `INSERT INTO messages (${MSG_COLS}) VALUES (?,?,?,?,?,?,?,?,?)`
  );
  inTransaction(db, () => {
    db.exec('DELETE FROM messages');
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || typeof m.id !== 'string') continue; // 坏行不静默入库（与 JSON 形状校验同口径）
      ins.run(
        m.id,
        m.title === undefined ? null : String(m.title),
        m.source === undefined ? null : String(m.source),
        m.occurredAt === undefined ? null : String(m.occurredAt),
        m.createdAt === undefined ? null : String(m.createdAt),
        m.analyzedAt === undefined ? null : String(m.analyzedAt),
        m.analyzeState === undefined ? null : String(m.analyzeState),
        Number.isFinite(m.analyzeAttempts) ? m.analyzeAttempts : 0,
        JSON.stringify(m)
      );
    }
  });
}

// ---------- task_events（第一批） ----------

/** → 事件数组（列封闭七字段，映射回 JSON 后端键名 id/taskId/from/to） */
function loadEvents(dbPath) {
  const db = openDb(dbPath);
  const rows = db
    .prepare('SELECT event_id, task_id, type, from_v, to_v, detail, at FROM task_events ORDER BY seq')
    .all();
  return rows.map((r) => ({
    id: r.event_id,
    taskId: r.task_id,
    type: r.type,
    from: r.from_v,
    to: r.to_v,
    detail: r.detail,
    at: r.at,
  }));
}

/** 全量替换语义（含双重裁剪）：事务内 DELETE ALL + INSERT 全量 + 裁剪（saveEvents 的 db 路径） */
function saveEventsSqlite(dbPath, events, globalLimit, perTaskLimit) {
  const db = openDb(dbPath);
  const ins = db.prepare(
    'INSERT INTO task_events (event_id, task_id, type, from_v, to_v, detail, at) VALUES (?,?,?,?,?,?,?)'
  );
  inTransaction(db, () => {
    db.exec('DELETE FROM task_events');
    for (const e of Array.isArray(events) ? events : []) {
      if (!e || typeof e.id !== 'string' || typeof e.taskId !== 'string') continue;
      ins.run(e.id, e.taskId, String(e.type || ''), e.from === undefined ? null : String(e.from), e.to === undefined ? null : String(e.to), e.detail === undefined ? null : String(e.detail), String(e.at || ''));
    }
    trimEvents(db, Number(globalLimit), Number(perTaskLimit));
  });
}

/** 双重裁剪：全局 5000 丢最旧 + 每任务 100 丢最旧（保留条数语义与 JSON 版逐条同构）
 *  边界用 seq <（严格小于）第 N 新的 seq——`<=` 会把边界行也删掉（差一缺陷，单测抓到）。
 *  全程 prepared statement 参数绑定（LIMIT/OFFSET 亦可绑定——零字符串拼装 SQL） */
function trimEvents(db, globalLimit, perTaskLimit) {
  db.prepare(
    `DELETE FROM task_events WHERE seq < (
       SELECT seq FROM task_events ORDER BY seq DESC LIMIT 1 OFFSET ?
     )`
  ).run(Number(globalLimit) - 1);
  const tasks = db.prepare('SELECT DISTINCT task_id FROM task_events').all();
  for (const t of tasks) {
    db.prepare(
      `DELETE FROM task_events WHERE task_id = ? AND seq < (
         SELECT seq FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?
       )`
    ).run(t.task_id, t.task_id, Number(perTaskLimit) - 1);
  }
}

/**
 * 追加 + 双重裁剪（全局 5000 / 每任务 100），单事务（消除 JSON 读-改-写竞态）。
 * 与 JSON 版语义逐条同构：追加 list → 全局超限丢最旧 → 每任务超限丢最旧。
 */
function appendEvents(dbPath, list, globalLimit, perTaskLimit) {
  const db = openDb(dbPath);
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return;
  const ins = db.prepare(
    'INSERT INTO task_events (event_id, task_id, type, from_v, to_v, detail, at) VALUES (?,?,?,?,?,?,?)'
  );
  inTransaction(db, () => {
    for (const e of items) {
      if (!e || typeof e.id !== 'string' || typeof e.taskId !== 'string') continue;
      ins.run(e.id, e.taskId, String(e.type || ''), e.from === undefined ? null : String(e.from), e.to === undefined ? null : String(e.to), e.detail === undefined ? null : String(e.detail), String(e.at || ''));
    }
    trimEvents(db, Number(globalLimit), Number(perTaskLimit));
  });
}

/** 删除某任务全部事件（removeTaskEvents 的 db 路径）；返回删除条数（与 JSON 版返回语义同构） */
function deleteEventsForTask(dbPath, taskId) {
  const db = openDb(dbPath);
  const r = db.prepare('DELETE FROM task_events WHERE task_id = ?').run(String(taskId));
  return Number(r.changes);
}

/** 测试/运维：清进程内缓存（连接与台账） */
function clearCache() {
  for (const db of handles.values()) {
    try { db.close(); } catch (e) { /* 幂等 */ }
  }
  handles.clear();
  ledgerCache.clear();
}

// ---------- tasks / activities / inbox / diary（第二批） ----------
// 语义均为「全量替换」（调用方契约不变）：事务内 DELETE ALL + INSERT 全量；tasks diff 键=id。
// 投影列只写不读（data 列唯一真源，SPEC-STORAGE §2.1）。

const TASK_COLS = 'id, status, priority, project_dir, branch, repo, member_id, acceptor_id, due_date, created_at, updated_at, completed_at, data';

function loadTasks(dbPath) {
  const db = openDb(dbPath);
  const rows = db.prepare(`SELECT ${TASK_COLS} FROM tasks ORDER BY rowid`).all();
  return rows.map((r) => {
    let obj = {};
    try { obj = JSON.parse(r.data); } catch (e) { obj = {}; }
    return Object.assign(obj, { id: obj.id || r.id });
  });
}

function saveTasks(dbPath, data) {
  const db = openDb(dbPath);
  const list = Array.isArray(data && data.tasks) ? data.tasks : [];
  const ins = db.prepare(
    `INSERT INTO tasks (${TASK_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  inTransaction(db, () => {
    db.exec('DELETE FROM tasks');
    for (const t of list) {
      if (!t || typeof t.id !== 'string') continue;
      ins.run(
        t.id,
        String(t.status || ''),
        t.priority === undefined ? null : String(t.priority),
        t.projectDir === undefined ? null : String(t.projectDir),
        t.branch === undefined ? null : String(t.branch),
        t.repo === undefined ? null : String(t.repo),
        t.memberId === undefined ? null : String(t.memberId),
        t.acceptorId === undefined ? null : String(t.acceptorId),
        t.dueDate === undefined ? null : String(t.dueDate),
        t.createdAt === undefined ? null : String(t.createdAt),
        t.updatedAt === undefined ? null : String(t.updatedAt),
        t.completedAt === undefined ? null : String(t.completedAt),
        JSON.stringify(t)
      );
    }
  });
}

function loadActivities(dbPath) {
  const db = openDb(dbPath);
  const rows = db.prepare('SELECT data FROM activities ORDER BY rowid').all();
  return rows.map((r) => {
    try { return JSON.parse(r.data); } catch (e) { return {}; }
  });
}

function saveActivities(dbPath, activities) {
  const db = openDb(dbPath);
  const ins = db.prepare(
    'INSERT INTO activities (url, type, actor, repo, branch, sha, title, message_body, occurred_at, fetched_at, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  inTransaction(db, () => {
    db.exec('DELETE FROM activities');
    for (const a of Array.isArray(activities) ? activities : []) {
      if (!a || typeof a.url !== 'string' || !a.url) continue; // 幂等键必须有
      ins.run(
        a.url,
        String(a.type || ''),
        a.actor === undefined ? null : String(a.actor),
        a.repo === undefined ? null : String(a.repo),
        a.branch === undefined ? null : String(a.branch),
        a.sha === undefined ? null : String(a.sha),
        a.title === undefined ? null : String(a.title),
        a.messageBody === undefined ? null : String(a.messageBody),
        a.occurredAt === undefined ? null : String(a.occurredAt),
        a.fetchedAt === undefined ? null : String(a.fetchedAt),
        JSON.stringify(a)
      );
    }
  });
}

function loadInbox(dbPath) {
  const db = openDb(dbPath);
  const rows = db.prepare('SELECT data FROM inbox ORDER BY rowid').all();
  return rows.map((r) => {
    try { return JSON.parse(r.data); } catch (e) { return {}; }
  });
}

function saveInbox(dbPath, candidates) {
  const db = openDb(dbPath);
  const ins = db.prepare(
    'INSERT INTO inbox (id, kind, message_id, state, confidence, suggested_member_id, existing_task_id, created_at, decided_at, data) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  inTransaction(db, () => {
    db.exec('DELETE FROM inbox');
    for (const c of Array.isArray(candidates) ? candidates : []) {
      if (!c || typeof c.id !== 'string') continue;
      ins.run(
        c.id,
        String(c.kind || 'task'),
        c.messageId === undefined ? null : String(c.messageId),
        String(c.state || 'pending'),
        Number.isFinite(c.confidence) ? c.confidence : null,
        c.suggestedMemberId === undefined ? null : String(c.suggestedMemberId),
        c.existingTaskId === undefined ? null : String(c.existingTaskId),
        c.createdAt === undefined ? null : String(c.createdAt),
        c.decidedAt === undefined ? null : String(c.decidedAt),
        JSON.stringify(c)
      );
    }
  });
}

function loadDiaries(dbPath) {
  const db = openDb(dbPath);
  const rows = db.prepare('SELECT task_id, date, content, updated_at FROM diary ORDER BY rowid').all();
  return rows.map((r) => ({ taskId: r.task_id, date: r.date, content: r.content, updatedAt: r.updated_at }));
}

function saveDiaries(dbPath, diaries) {
  const db = openDb(dbPath);
  const ins = db.prepare(
    'INSERT INTO diary (task_id, date, content, updated_at) VALUES (?,?,?,?)'
  );
  inTransaction(db, () => {
    db.exec('DELETE FROM diary');
    for (const d of Array.isArray(diaries) ? diaries : []) {
      if (!d || typeof d.taskId !== 'string' || typeof d.date !== 'string') continue;
      ins.run(d.taskId, d.date, String(d.content || ''), d.updatedAt === undefined ? null : String(d.updatedAt));
    }
  });
}

// ---------- learn（第二批，单文档行——SPEC-STORAGE §2.4） ----------

/** → 文档对象或 null（无该单元行）；形状与 learn/*.json 完全一致 */
function loadLearnDoc(dbPath, unit) {
  const db = openDb(dbPath);
  const r = db.prepare('SELECT data FROM learn_docs WHERE unit = ?').get(String(unit));
  if (!r) return null;
  try { return JSON.parse(r.data); } catch (e) { return null; }
}

/** 单文档 upsert（learn_docs 五单元） */
function saveLearnDoc(dbPath, unit, doc) {
  const db = openDb(dbPath);
  db.prepare(
    'INSERT INTO learn_docs (unit, data, updated_at) VALUES (?,?,?) ON CONFLICT(unit) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at'
  ).run(String(unit), JSON.stringify(doc), new Date().toISOString());
}

module.exports = {
  DB_NAME,
  dbPathFor,
  unitBackend,
  unitsMigrated,
  loadMessages,
  saveMessages,
  loadEvents,
  saveEventsSqlite,
  appendEvents,
  deleteEventsForTask,
  loadTasks,
  saveTasks,
  loadActivities,
  saveActivities,
  loadInbox,
  saveInbox,
  loadDiaries,
  saveDiaries,
  loadLearnDoc,
  saveLearnDoc,
  clearCache,
};
