'use strict';

/**
 * migration.js — v2.9.33 JSON→SQLite 一次性导入器核心（SPEC-STORAGE §4）
 *
 * 流程（严格顺序，任一步失败即停，台账未标记=可安全重跑）：
 *   ①前置备份（lib/backup.js 现有机制）→ ②存活实例检查（instanceLock，有活实例拒绝执行）
 *   → ③逐单元：读 JSON → 形状校验（坏行清点，不静默丢）→ 单事务 INSERT → 行数对账
 *   → ④台账登记（meta 表 unit:<name>）→ ⑤JSON 原文件改名 *.migrated-<ts>（保留，回退靠它）
 * 幂等：台账已标记的单元跳过（--force 允许清表重导）；--dry-run 只报告不写。
 * DDL 归本文件（storeDb.openDb 不建表——库与表都由迁移器创建，职责单一）。
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const storeDb = require('./storeDb');
const backup = require('./backup');
const instanceLock = require('./instanceLock');
const { HttpError } = require('./router');

const SCHEMA_VERSION = 2; // v1：messages/task_events；v2：+tasks/activities/inbox/diary/learn_docs

const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // messages（SPEC-STORAGE §2①）：投影列只写不读，data 列=原始对象真源
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     title TEXT, source TEXT, occurred_at TEXT, created_at TEXT,
     analyzed_at TEXT, analyze_state TEXT, analyze_attempts INTEGER DEFAULT 0,
     data TEXT NOT NULL
   )`,
  // task_events（§2②）：字段封闭七列，无 data 列
  `CREATE TABLE IF NOT EXISTS task_events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id TEXT NOT NULL UNIQUE,
     task_id TEXT NOT NULL,
     type TEXT NOT NULL,
     from_v TEXT, to_v TEXT, detail TEXT, at TEXT NOT NULL
   )`,
  // tasks（§2③，批次 2）：投影列只写不读，data 列=完整任务对象真源（含 artifacts[]）
  `CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     priority TEXT, project_dir TEXT, branch TEXT, repo TEXT,
     member_id TEXT, acceptor_id TEXT, due_date TEXT,
     created_at TEXT, updated_at TEXT, completed_at TEXT,
     data TEXT NOT NULL
   )`,
  // activities（§2④，批次 2）：url=归因幂等键
  `CREATE TABLE IF NOT EXISTS activities (
     url TEXT PRIMARY KEY,
     type TEXT NOT NULL, actor TEXT, repo TEXT, branch TEXT, sha TEXT,
     title TEXT, message_body TEXT, occurred_at TEXT, fetched_at TEXT,
     data TEXT NOT NULL
   )`,
  // inbox（§2⑤，批次 2）
  `CREATE TABLE IF NOT EXISTS inbox (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL, message_id TEXT, state TEXT NOT NULL,
     confidence REAL, suggested_member_id TEXT, existing_task_id TEXT,
     created_at TEXT, decided_at TEXT,
     data TEXT NOT NULL
   )`,
  // diary（§2⑥，批次 2）：关系键天然映射
  `CREATE TABLE IF NOT EXISTS diary (
     task_id TEXT NOT NULL, date TEXT NOT NULL,
     content TEXT NOT NULL, updated_at TEXT,
     PRIMARY KEY (task_id, date)
   )`,
  // learn_docs（§2.4，批次 2）：learn 五单元单文档行（items/pages/schedule/sessions/scan）
  `CREATE TABLE IF NOT EXISTS learn_docs (
     unit TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     updated_at TEXT
   )`,
];

/** 迁移单元 → 源文件相对路径（backup.js unitFileOf 同源映射；learn 单元文件在 learn/ 子目录） */
const UNIT_FILES = {
  messages: 'messages.json',
  task_events: 'task_events.json',
  tasks: 'tasks.json',
  activities: 'activities.json',
  inbox: 'inbox.json',
  diary: 'diary.json',
  'learn:items': 'learn/items.json',
  'learn:pages': 'learn/pages.json',
  'learn:schedule': 'learn/schedule.json',
  'learn:sessions': 'learn/sessions.json',
  'learn:scan': 'learn/scan.json',
};

/** 行投影与读取（messages/task_events 沿用批次 1 形态；批次 2 各单元 data 真源 + 投影列） */
function insertRow(db, unit, row) {
  if (unit === 'messages') {
    db.prepare('INSERT INTO messages (id,title,source,occurred_at,created_at,analyzed_at,analyze_state,analyze_attempts,data) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.title === undefined ? null : String(row.title), row.source === undefined ? null : String(row.source), row.occurredAt === undefined ? null : String(row.occurredAt), row.createdAt === undefined ? null : String(row.createdAt), row.analyzedAt === undefined ? null : String(row.analyzedAt), row.analyzeState === undefined ? null : String(row.analyzeState), Number.isFinite(row.analyzeAttempts) ? row.analyzeAttempts : 0, JSON.stringify(row));
    return;
  }
  if (unit === 'task_events') {
    db.prepare('INSERT INTO task_events (event_id,task_id,type,from_v,to_v,detail,at) VALUES (?,?,?,?,?,?,?)')
      .run(row.id, row.taskId, String(row.type || ''), row.from === undefined ? null : String(row.from), row.to === undefined ? null : String(row.to), row.detail === undefined ? null : String(row.detail), String(row.at || ''));
    return;
  }
  if (unit === 'tasks') {
    db.prepare('INSERT INTO tasks (id,status,priority,project_dir,branch,repo,member_id,acceptor_id,due_date,created_at,updated_at,completed_at,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.id, String(row.status || ''), row.priority === undefined ? null : String(row.priority), row.projectDir === undefined ? null : String(row.projectDir), row.branch === undefined ? null : String(row.branch), row.repo === undefined ? null : String(row.repo), row.memberId === undefined ? null : String(row.memberId), row.acceptorId === undefined ? null : String(row.acceptorId), row.dueDate === undefined ? null : String(row.dueDate), row.createdAt === undefined ? null : String(row.createdAt), row.updatedAt === undefined ? null : String(row.updatedAt), row.completedAt === undefined ? null : String(row.completedAt), JSON.stringify(row));
    return;
  }
  if (unit === 'activities') {
    db.prepare('INSERT INTO activities (url,type,actor,repo,branch,sha,title,message_body,occurred_at,fetched_at,data) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(String(row.url), String(row.type || ''), row.actor === undefined ? null : String(row.actor), row.repo === undefined ? null : String(row.repo), row.branch === undefined ? null : String(row.branch), row.sha === undefined ? null : String(row.sha), row.title === undefined ? null : String(row.title), row.messageBody === undefined ? null : String(row.messageBody), row.occurredAt === undefined ? null : String(row.occurredAt), row.fetchedAt === undefined ? null : String(row.fetchedAt), JSON.stringify(row));
    return;
  }
  if (unit === 'inbox') {
    db.prepare('INSERT INTO inbox (id,kind,message_id,state,confidence,suggested_member_id,existing_task_id,created_at,decided_at,data) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(row.id, String(row.kind || 'task'), row.messageId === undefined ? null : String(row.messageId), String(row.state || 'pending'), Number.isFinite(row.confidence) ? row.confidence : null, row.suggestedMemberId === undefined ? null : String(row.suggestedMemberId), row.existingTaskId === undefined ? null : String(row.existingTaskId), row.createdAt === undefined ? null : String(row.createdAt), row.decidedAt === undefined ? null : String(row.decidedAt), JSON.stringify(row));
    return;
  }
  if (unit === 'diary') {
    db.prepare('INSERT INTO diary (task_id,date,content,updated_at) VALUES (?,?,?,?)')
      .run(row.taskId, row.date, String(row.content || ''), row.updatedAt === undefined ? null : String(row.updatedAt));
    return;
  }
  // learn:* 单文档行（unit 键 = 'learn:items' 等）
  if (unit.startsWith('learn:')) {
    db.prepare('INSERT INTO learn_docs (unit, data, updated_at) VALUES (?,?,?)')
      .run(unit, JSON.stringify(row), row.updatedAt === undefined ? null : String(row.updatedAt));
  }
}

/** 单元文件路径：显式根目录边界校验（def.file 虽为 UNITS 硬编码常量，边界闸照设——纵深防御） */
function unitFile(dataDir, unit, def) {
  const root = path.resolve(dataDir);
  const target = path.resolve(root, def.file);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new HttpError(400, 'FIELD_INVALID', `单元文件路径越界: ${unit}`);
  }
  return target;
}

/** 单元定义：源文件（相对 dataDir）+ 读取（→行数组）+ 校验（rows/bad）+ 表名/清理 SQL */
function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function arrOf(j, wrapKey) {
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j[wrapKey])) return j[wrapKey];
  throw new Error('无法识别的单元数组形态');
}

const UNITS = {
  messages: {
    file: 'messages.json',
    table: 'messages',
    read: (file) => arrOf(readJsonFile(file), 'messages'),
    validate: (arr) => {
      const bad = [];
      const rows = [];
      for (const m of arr) {
        if (m && typeof m.id === 'string' && m.id) rows.push(m);
        else bad.push(JSON.stringify(m).slice(0, 80));
      }
      return { rows, bad };
    },
    clear: (db) => { db.exec('DELETE FROM messages'); },
    count: (db) => db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
  },
  task_events: {
    file: 'task_events.json',
    table: 'task_events',
    read: (file) => arrOf(readJsonFile(file), 'events'),
    validate: (arr) => {
      const bad = [];
      const rows = [];
      for (const e of arr) {
        if (e && typeof e.id === 'string' && e.id && typeof e.taskId === 'string' && e.taskId) rows.push(e);
        else bad.push(JSON.stringify(e).slice(0, 80));
      }
      return { rows, bad };
    },
    clear: (db) => { db.exec('DELETE FROM task_events'); },
    count: (db) => db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n,
  },
  tasks: {
    file: 'tasks.json',
    table: 'tasks',
    // 列定义抽取：源 tasks.json 的 columns 字段迁移时抽到伴生文件 columns.json
    // （loadTasks 的 db 路径从伴生文件读列定义——抽不走它，首次保存前列定义回落默认）
    read: (file) => {
      const j = readJsonFile(file);
      const arr = arrOf(j, 'tasks');
      if (j && Array.isArray(j.columns)) arr.__columns = j.columns;
      return arr;
    },
    validate: (arr) => {
      const bad = [];
      const rows = [];
      for (const t of arr) {
        if (t && typeof t.id === 'string' && t.id) rows.push(t);
        else bad.push(JSON.stringify(t).slice(0, 80));
      }
      return { rows, bad };
    },
    clear: (db) => { db.exec('DELETE FROM tasks'); },
    count: (db) => db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
    // 台账登记后抽列伴生文件（arr.__columns 由 read 附着）
    afterImport: (dataDir, arr) => {
      if (Array.isArray(arr.__columns) && arr.__columns.length) {
        store.writeJSON(path.join(dataDir, 'columns.json'), arr.__columns);
      }
    },
  },
  activities: {
    file: 'activities.json',
    table: 'activities',
    read: (file) => arrOf(readJsonFile(file), 'activities'),
    validate: (arr) => {
      const bad = [];
      const rows = [];
      for (const a of arr) {
        if (a && typeof a.url === 'string' && a.url) rows.push(a);
        else bad.push(JSON.stringify(a).slice(0, 80));
      }
      return { rows, bad };
    },
    clear: (db) => { db.exec('DELETE FROM activities'); },
    count: (db) => db.prepare('SELECT COUNT(*) AS n FROM activities').get().n,
  },
  inbox: {
    file: 'inbox.json',
    table: 'inbox',
    read: (file) => arrOf(readJsonFile(file), 'candidates'),
    validate: (arr) => {
      const bad = [];
      const rows = [];
      for (const c of arr) {
        if (c && typeof c.id === 'string' && c.id) rows.push(c);
        else bad.push(JSON.stringify(c).slice(0, 80));
      }
      return { rows, bad };
    },
    clear: (db) => { db.exec('DELETE FROM inbox'); },
    count: (db) => db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n,
  },
  diary: {
    file: 'diary.json',
    table: 'diary',
    read: (file) => arrOf(readJsonFile(file), 'diaries'),
    validate: (arr) => {
      const bad = [];
      const rows = [];
      for (const d of arr) {
        if (d && typeof d.taskId === 'string' && typeof d.date === 'string') rows.push(d);
        else bad.push(JSON.stringify(d).slice(0, 80));
      }
      return { rows, bad };
    },
    clear: (db) => { db.exec('DELETE FROM diary'); },
    count: (db) => db.prepare('SELECT COUNT(*) AS n FROM diary').get().n,
  },
};

// learn 五单元（单文档行——SPEC-STORAGE §2.4）：整个文档 = 一行，零形状风险
for (const [name] of [['items'], ['pages'], ['schedule'], ['sessions'], ['scan']]) {
  const unit = `learn:${name}`;
  UNITS[unit] = {
    file: `learn/${name}.json`,
    table: 'learn_docs',
    read: (file) => [readJsonFile(file)], // 整文档 = 单行
    validate: (arr) => {
      const bad = [];
      const rows = [];
      for (const doc of arr) {
        if (doc && typeof doc === 'object') rows.push(doc);
        else bad.push(JSON.stringify(doc).slice(0, 80));
      }
      return { rows, bad };
    },
    clear: (db) => { db.prepare('DELETE FROM learn_docs WHERE unit = ?').run(unit); },
    count: (db) => db.prepare('SELECT COUNT(*) AS n FROM learn_docs WHERE unit = ?').get(unit).n,
  };
}

/**
 * runMigration(options) → 迁移报告
 * @param {{dataDir:string, units?:string[], force?:boolean, dryRun?:boolean, now?:number}} options
 * dataDir = 运行态数据目录（~/.dsh/fde-console/data）；base 目录取其上级（instanceLock/备份落点）
 */
function runMigration(options) {
  const o = options || {};
  const dataDir = String(o.dataDir || '').trim();
  if (!dataDir) throw new HttpError(400, 'FIELD_INVALID', 'dataDir 必填');
  const baseDir = path.dirname(dataDir);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const dryRun = !!o.dryRun;
  const force = !!o.force;

  // ① 存活实例检查（instanceLock）：有其它活实例共用 base → 拒绝（写库期间被旧代码并发写 JSON/db 皆危险）
  const others = instanceLock.othersLive(baseDir, process.pid);
  if (others.length && !dryRun) {
    throw new HttpError(409, 'INSTANCE_LIVE', `检测到 ${others.length} 个存活实例共用本数据目录（pid: ${others.map((x) => x.pid).join(',')}），请先停止所有实例再执行迁移`);
  }

  // ② 前置备份（dry-run 不动任何东西）
  let backupDir = null;
  if (!dryRun) {
    const b = backup.backupOnce({ source: dataDir, now });
    backupDir = b.dir;
  }

  const dbPath = storeDb.dbPathFor(dataDir);
  const report = { dbPath, backupDir, dryRun, units: [], skipped: [] };

  // ③ 建库建表（幂等）；dry-run 到此为止
  if (!dryRun) {
    fs.mkdirSync(dataDir, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      for (const sql of DDL) db.exec(sql);
    } finally {
      db.close();
    }
  }

  for (const [unit, def] of Object.entries(UNITS)) {
    if (Array.isArray(o.units) && o.units.length && !o.units.includes(unit)) continue;
    const file = unitFile(dataDir, unit, def);
    if (!fs.existsSync(file)) {
      report.skipped.push({ unit, reason: '源文件不存在（可能已迁移）' });
      continue;
    }
    let arr;
    try {
      arr = def.read(file);
    } catch (e) {
      report.skipped.push({ unit, reason: `源 JSON 解析失败，需人工裁决: ${e.message}` });
      continue;
    }
    const { rows, bad } = def.validate(arr);
    if (dryRun) {
      report.units.push({ unit, sourceRows: arr.length, validRows: rows.length, badRows: bad.length, dryRun: true });
      continue;
    }
    // 幂等：台账已标记（且非 force）→ 跳过
    if (storeDb.unitBackend(dataDir, unit).backend === 'sqlite' && !force) {
      report.skipped.push({ unit, reason: '台账已标记（--force 可重导）' });
      continue;
    }
    // 单事务导入（清理与投影经单元定义分发表——全单元通用）
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('BEGIN IMMEDIATE');
      try {
        def.clear(db);
        for (const row of rows) insertRow(db, unit, row);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (e2) { /* 已回滚 */ }
        throw e;
      }
      // 行数对账
      const dbCount = def.count(db);
      if (dbCount !== rows.length) {
        throw new Error(`行数对账失败：源 ${rows.length} vs 库 ${dbCount}`);
      }
      // 台账登记
      db.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(`unit:${unit}`, new Date(now).toISOString());
      db.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('schema_version', String(SCHEMA_VERSION));
      db.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('migrated_at', new Date(now).toISOString());
    } finally {
      db.close();
    }
    // 单元级后置：tasks 抽列伴生文件（columns.json——db 路径列定义来源）
    if (typeof def.afterImport === 'function') def.afterImport(dataDir, arr);
    // JSON 原档保留：成功后改名（回退靠它）
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archived = `${file}.migrated-${stamp}`;
    fs.renameSync(file, archived);
    report.units.push({ unit, sourceRows: arr.length, validRows: rows.length, badRows: bad.length, archived });
    if (bad.length) report.units[report.units.length - 1].badSamples = bad.slice(0, 5);
    // v2.9.33 关键：台账在本迁移器连接里提交后，必须失效 storeDb 的台账缓存——
    // 否则同进程内先于导入发生的 unitBackend 调用已缓存空台账，路由永远回 json（真机复现的缺陷）
    storeDb.clearCache();
  }
  report.schemaVersion = SCHEMA_VERSION;
  report.migratedAt = new Date(now).toISOString();
  return report;
}

module.exports = { runMigration, UNITS, SCHEMA_VERSION };
