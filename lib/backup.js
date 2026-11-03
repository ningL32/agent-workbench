'use strict';

/**
 * backup.js — v2.9.41 数据备份与恢复（唯一不可逆损失缺口的收口）
 *
 * 背景（AGENTS 红线 3）：`data/` 运行态是唯一副本，task_events/diary 不可重建；
 * 此前只有手动脚本 scripts/backup-data.js，没有任何调度与恢复入口。
 *
 * 本模块同时服务三处（一条代码路径，禁止各写一份）：
 *   ① CLI  scripts/backup-data.js（薄壳，转调这里）
 *   ② 每日自动备份：pollTick → maybeDailyBackup（到点且当日未跑才跑）
 *   ③ REST API：GET /api/backup/list · POST /api/backup/now · POST /api/backup/restore
 *
 * 纪律：
 *  - **源目录只读**：备份/恢复都不删除 data/ 下任何文件；恢复只是覆盖同名文件
 *  - 落点 = `<base>/backups/`（data 的兄弟目录），不进 data，避免污染数据目录
 *  - 恢复是破坏性操作：必须 `confirm:"RESTORE"`；**先给当前状态拍快照再覆盖**，可回滚
 *  - 备份名严格白名单 `backup-YYYYMMDD-HHMMSS(-n)`：恢复接口不吃任意路径
 *  - 失败留痕：任何一步抛错都向上抛（调用方 catch 后写日志），绝不静默吞
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('./store');
const { HttpError, sendJSON } = require('./router');

const KEEP_DEFAULT = 14;
const BACKUP_PREFIX = 'backup-';
const NAME_RE = /^backup-\d{8}-\d{6}(-\d+)?$/;
const STATE_FILE = '.state.json';
const RESTORE_FILE = '.last-restore.json';

// ---------- 基础 ----------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function hhmm(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 默认源：DSH_HOME|~/.dsh 下的 fde-console/data（部署形态真实落点）；不存在则回退仓库 data/ */
function defaultSource() {
  const home = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || path.join(os.homedir(), '.dsh');
  const deployed = path.join(home, 'fde-console', 'data');
  if (fs.existsSync(deployed)) return deployed;
  return path.resolve(__dirname, '..', 'data');
}

/** 备份落点：data 的兄弟目录（<base>/backups），不进 data */
function backupsDirOf(ctx) {
  return path.join(path.dirname(path.resolve(ctx.dataDir)), 'backups');
}

function listBackupDirs(outDir) {
  try {
    return fs.readdirSync(outDir)
      .filter((n) => n.startsWith(BACKUP_PREFIX))
      .filter((n) => {
        try {
          return fs.statSync(path.join(outDir, n)).isDirectory();
        } catch (e) {
          return false;
        }
      })
      .sort()
      .reverse(); // 时间戳名天然可排序，新→旧
  } catch (e) {
    return []; // 目录不存在 = 还没备份过
  }
}

function readManifest(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return d && typeof d === 'object' ? d : null;
  } catch (e) {
    return null;
  }
}

// ---------- 备份 ----------

/**
 * 执行一次备份。返回 {dir, files:[{name,bytes}], pruned:[被清理的旧备份名]}。
 * 幂等：同一秒重复调用会生成 -<序号> 目录，绝不覆盖已有备份。
 */
function backupOnce(options) {
  const o = options || {};
  const src = path.resolve(o.source || defaultSource());
  if (!fs.existsSync(src)) throw new Error(`数据目录不存在: ${src}`);
  const ts = new Date(Number(o.now) || Date.now());
  const stamp = `${ts.getFullYear()}${pad2(ts.getMonth() + 1)}${pad2(ts.getDate())}-${pad2(ts.getHours())}${pad2(ts.getMinutes())}${pad2(ts.getSeconds())}`;
  const outDir = path.resolve(o.out || path.join(path.dirname(src), 'backups'));
  fs.mkdirSync(outDir, { recursive: true });
  let dir = path.join(outDir, `${BACKUP_PREFIX}${stamp}`);
  let suffix = 0;
  while (fs.existsSync(dir)) dir = path.join(outDir, `${BACKUP_PREFIX}${stamp}-${++suffix}`);
  fs.mkdirSync(dir, { recursive: true });

  // v2.9.33 存储迁移配套：data/fde.db 存在时先 WAL checkpoint（合并进主文件，拷贝瞬间一致）。
  // 用完即关的短连接，不进 storeDb 单例（备份与运行态读写互不持锁）
  const dbFile = path.join(src, 'fde.db');
  if (fs.existsSync(dbFile)) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile);
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  }

  const files = [];
  for (const name of fs.readdirSync(src)) {
    const p = path.join(src, name);
    if (!fs.statSync(p).isFile()) continue; // 只备数据文件；子目录（如 session-logs/）不备
    if (/\.migrated-/.test(name) || /\.tmp-/.test(name) || /\.corrupt-/.test(name)) continue; // 归档/残留不进滚动备份
    fs.copyFileSync(p, path.join(dir, name));
    files.push({ name, bytes: fs.statSync(p).size });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    backedUpAt: ts.toISOString(),
    source: src,
    files,
  }, null, 2));

  const keepN = Number(o.keep) > 0 ? Number(o.keep) : KEEP_DEFAULT;
  // 直接按目录名倒序（时间戳可排序；同秒的 -1/-2 后缀按字典序排在前面 = 更新）取前 keepN 份
  const all = listBackupDirs(outDir);
  const pruned = all.slice(keepN);
  for (const name of pruned) {
    try {
      fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
    } catch (e) {
      /* 清理失败不阻断本次备份（下次还会再试） */
    }
  }
  return { dir, files, pruned };
}

function keepOf(ctx) {
  const k = Number(ctx && ctx.config && ctx.config.backup && ctx.config.backup.keep);
  return k > 0 ? k : KEEP_DEFAULT;
}

/** API/调度用：以 ctx 定位源与落点 */
function backupNow(ctx, opts) {
  const o = opts || {};
  return backupOnce({ source: ctx.dataDir, out: backupsDirOf(ctx), keep: keepOf(ctx), now: o.now });
}

/** 备份清单（新→旧），附带 manifest 里的时间与体积；损坏的备份不隐藏，标记 unreadable */
function listBackups(ctx) {
  const out = backupsDirOf(ctx);
  return listBackupDirs(out).map((name) => {
    const dir = path.join(out, name);
    const manifest = readManifest(dir);
    let bytes = 0;
    let files = 0;
    if (manifest && Array.isArray(manifest.files)) {
      files = manifest.files.length;
      bytes = manifest.files.reduce((s, f) => s + (Number(f && f.bytes) || 0), 0);
    }
    return {
      name,
      backedUpAt: (manifest && manifest.backedUpAt) || null,
      files,
      bytes,
      unreadable: !manifest,
    };
  });
}

// ---------- 恢复 ----------

/**
 * 从备份恢复（破坏性）：先给当前 data 拍快照，再按清单覆盖同名文件。
 * 只覆盖、不删除 —— 备份里没有而 data 里有的文件原样保留（宁可多余，不可误删）。
 */
function restoreBackup(ctx, name, opts) {
  const o = opts || {};
  if (o.confirm !== 'RESTORE') {
    throw new HttpError(400, 'CONFIRM_REQUIRED', '恢复是破坏性操作：请求体需带 {"confirm":"RESTORE"}');
  }
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new HttpError(400, 'BACKUP_INVALID', '备份名非法（只接受 backups 目录下的 backup-YYYYMMDD-HHMMSS[-n]）');
  }
  const out = backupsDirOf(ctx);
  const dir = path.join(out, name);
  if (!fs.existsSync(dir)) throw new HttpError(404, 'BACKUP_NOT_FOUND', `备份不存在: ${name}`);

  const manifest = readManifest(dir);
  const names = manifest && Array.isArray(manifest.files)
    ? manifest.files.map((f) => f && f.name).filter((n) => typeof n === 'string' && (n.endsWith('.json') || n === 'fde.db'))
    : fs.readdirSync(dir).filter((n) => (n.endsWith('.json') && n !== 'manifest.json') || n === 'fde.db');

  // 先拍当前状态的快照（恢复错了还能再恢复回来）；data 目录不存在时无状态可保，跳过
  const snapshot = fs.existsSync(ctx.dataDir)
    ? backupOnce({ source: ctx.dataDir, out, keep: keepOf(ctx), now: o.now })
    : null;

  fs.mkdirSync(ctx.dataDir, { recursive: true });
  const restored = [];
  for (const fileName of names) {
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) continue; // 清单被篡改也不越界
    const from = path.join(dir, fileName);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(ctx.dataDir, fileName));
    restored.push(fileName);
  }

  // v2.9.33 存储迁移配套（SPEC-STORAGE §5 双格式恢复）：
  // ① 档案含 fde.db → 拷回后清 storeDb 连接/台账缓存（下次访问重开新库）
  // ② 旧代纯 JSON 档案 + 当前已有已迁移单元 → 把恢复出的 JSON 自动重导入 db（恢复后系统可用承诺）
  if (restored.includes('fde.db')) {
    require('./storeDb').clearCache();
  } else if (fs.existsSync(path.join(ctx.dataDir, 'fde.db'))) {
    const storeDb = require('./storeDb');
    const dbPath = path.join(ctx.dataDir, 'fde.db');
    const units = [...(storeDb.unitsMigrated(dbPath) || [])]
      .filter((u) => fs.existsSync(path.join(ctx.dataDir, unitFileOf(u))));
    if (units.length) {
      require('./migration').runMigration({ dataDir: ctx.dataDir, units, force: true, now: o.now });
    }
  }

  store.writeJSON(path.join(out, RESTORE_FILE), {
    at: new Date().toISOString(),
    from: name,
    files: restored,
    snapshot: snapshot ? path.basename(snapshot.dir) : null,
  });
  return { name, files: restored, snapshot: snapshot ? snapshot.dir : null };
}

/** 迁移单元名 → 源 JSON 文件名（恢复重导入用；与 lib/migration.UNITS 同源） */
function unitFileOf(unit) {
  const map = { messages: 'messages.json', task_events: 'task_events.json' };
  return map[unit] || `${unit}.json`;
}

// ---------- 每日自动备份 ----------

function statePath(ctx) {
  return path.join(backupsDirOf(ctx), STATE_FILE);
}

function readState(ctx) {
  try {
    const d = store.readJSON(statePath(ctx), null);
    return store.isPlainObject(d) ? d : {};
  } catch (e) {
    return {};
  }
}

/**
 * 每日自动备份（pollTick 每分钟调用）：到点 + 当日未跑才跑。
 * 默认开启（本地拷贝，无出站），失败只影响当天这一次。
 */
function maybeDailyBackup(ctx, opts) {
  const o = opts || {};
  const cfg = (ctx && ctx.config && ctx.config.backup) || {};
  if (cfg.enabled === false) return { ran: false, reason: 'disabled' };
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(cfg.at || '')) ? cfg.at : '09:05';
  const now = o.now instanceof Date ? o.now : new Date();
  if (hhmm(now) < at) return { ran: false, reason: '未到点' };

  const today = ymd(now);
  const state = readState(ctx);
  if (state.lastDate === today) return { ran: false, reason: '今日已备份' };

  // 空目录（首启/数据被清）不产垃圾备份：没有 .json 就当没东西可备
  let hasData = false;
  try {
    hasData = fs.readdirSync(ctx.dataDir).some((n) => n.endsWith('.json'));
  } catch (e) {
    hasData = false;
  }
  if (!hasData) return { ran: false, reason: '数据目录为空' };

  const r = backupOnce({ source: ctx.dataDir, out: backupsDirOf(ctx), keep: keepOf(ctx), now: now.getTime() });
  store.writeJSON(statePath(ctx), {
    lastDate: today,
    lastAt: new Date().toISOString(),
    dir: path.basename(r.dir),
    pruned: r.pruned.length,
  });
  return { ran: true, dir: r.dir, pruned: r.pruned.length };
}

/** 备份状态（给设置页/体检用；读不到就如实说「从未备份」） */
function backupStatus(ctx) {
  const state = readState(ctx);
  const items = listBackups(ctx);
  const last = items[0] || null;
  let restore = null;
  try {
    restore = store.readJSON(path.join(backupsDirOf(ctx), RESTORE_FILE), null);
  } catch (e) {
    restore = null;
  }
  return {
    enabled: !((ctx.config && ctx.config.backup && ctx.config.backup.enabled) === false),
    keep: keepOf(ctx),
    at: (ctx.config && ctx.config.backup && ctx.config.backup.at) || '09:05',
    dir: backupsDirOf(ctx),
    count: items.length,
    lastBackupAt: (last && last.backedUpAt) || state.lastAt || null,
    lastBackupName: (last && last.name) || state.dir || null,
    lastRestore: restore && typeof restore === 'object' ? { at: restore.at, from: restore.from, files: Array.isArray(restore.files) ? restore.files.length : 0 } : null,
  };
}

// ---------- 路由 ----------

function registerBackupRoutes(router, ctx) {
  router.add('GET', '/api/backup/list', (c) => {
    sendJSON(c.res, 200, Object.assign(backupStatus(ctx), { items: listBackups(ctx) }));
  });

  router.add('POST', '/api/backup/now', (c) => {
    const r = backupNow(ctx);
    sendJSON(c.res, 200, {
      ok: true,
      name: path.basename(r.dir),
      files: r.files.length,
      bytes: r.files.reduce((s, f) => s + f.bytes, 0),
      pruned: r.pruned.length,
    });
  });

  // 破坏性：必须显式 confirm；服务端先快照再覆盖（出错可再恢复）
  router.add('POST', '/api/backup/restore', (c) => {
    const body = c.body || {};
    const r = restoreBackup(ctx, body.name, { confirm: body.confirm });
    sendJSON(c.res, 200, {
      ok: true,
      name: r.name,
      files: r.files.length,
      snapshot: r.snapshot ? path.basename(r.snapshot) : null,
    });
  });
}

module.exports = {
  KEEP_DEFAULT,
  NAME_RE,
  defaultSource,
  backupsDirOf,
  backupOnce,
  backupNow,
  listBackups,
  restoreBackup,
  maybeDailyBackup,
  backupStatus,
  registerBackupRoutes,
};
