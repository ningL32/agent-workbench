'use strict';

/**
 * agentTranscript.js — v2.3 会话阅读器后端：六源「会话列表 + 归一化全文」适配器与两条端点
 *
 * 端点（§3，契约冻结；插件态经 /fde-api/* 前缀同源生效）：
 *   GET /api/agent-sessions?agent=<id>&limit=&cursor=   会话列表（lastActiveAt 倒序 + 键集游标）
 *   GET /api/agent-session?ref=<opaque>                 会话全文（归一化消息数组，seq 升序）
 *
 * 六源映射（§3.4 + §10 spike 回写，2026-10-20 实测）：
 *   zcode     ~/.zcode/cli/db/db.sqlite（R1：session.id 与 sess_* 目录名同名同形，db 为超集
 *             → 列表/全文均以 db session 表为准；id 三形态 sess_<uuid>/session_<hex>/sess_subagent_agent_<uuid>）
 *             message/part 按 sequence 列排序（R2：message.data={role,...}、part.data={type:text|tool,...}，
 *             tool part state.status ∈ completed|error|...、state.input/output）
 *   claude    ~/.claude/projects <编码项目目录>/<uuid>.jsonl（跳过 isSidechain 与
 *             attachment/queue-operation/last-prompt/summary 等非消息行；tool_use→tool 发起、
 *             tool_result→role:'tool'，按 tool_use_id 配对继承工具名）
 *   dsh       ~/.dsh/sessions <编码项目目录>/session-N/session*.jsonl.zstd（R3：zstd 为多帧拼接，
 *             单次 sync 解码只出首帧——必须按 0x28B52FFD magic 分帧逐帧解压；行形态 {type,seq,time,data}，
 *             消息行 user/message、assistant/message、tool/call、tool/result，其余行跳过不报错；
 *             rollout-*.jsonl 明文分支同构解析）
 *   codex     ~/.codex/sessions YYYY/MM/DD/rollout-*.jsonl（session_meta 头部；response_item
 *             message/function_call/function_call_output；跳过 turn_context/world_state/event_msg）
 *   opencode  ~/.local/share/opencode/opencode.db（session/message/part 三表与 zcode 同构；R2 实测
 *             message/part 无 sequence 列——按 time_created,rowid 排序；凭据红线：不碰
 *             account/credential 等其余表）
 *   workbuddy ~/.workbuddy/workbuddy.db（仅 SELECT sessions 表；transcript 恒降级 D4）
 *
 * 红线（§7）：全链路只读（sqlite {readOnly:true}、文件 openSync 只读、zstd 内存解压）；
 * 服务端统一脱敏（列表 title 与每条 message.text 组装时过 redact）；ref 双闸校验收口
 * lib/sessionRef.js；单源故障隔离（列表按源 try/catch，源故障 → 空页不拖垮服务）。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { HttpError, sendJSON } = require('./router');
const redactMod = require('./redact');
const sessionRef = require('./sessionRef');
const aa = require('./agentActivity');

const {
  normalizeAgentActivity,
  sanitizeText,
  resolveHome,
  defaultRoot,
  readHead,
  readTail,
  parseJsonlBuffer,
  extractLineText,
  toIso,
  toIsoFromValue,
  isPlainObject,
  stateFor,
} = aa;

const SOURCE_IDS = sessionRef.SOURCE_IDS;
const UNNAMED = '（未命名会话）';

// 读入闸（R4）：单 jsonl 全文读入上限 4MB，超出截断（truncated:true）
const TRANSCRIPT_FILE_CAP = 4 * 1024 * 1024;
// dsh：压缩单文件 8MB 不解（与活动流 DSH_ZSTD_CAP 同口径）；解压累计输出 16MB 硬闸
const DSH_ZSTD_CAP = 8 * 1024 * 1024;
const DSH_DECOMPRESS_CAP = 16 * 1024 * 1024;
// dsh 列表标题轻解压：最多解的帧数 / 累计解压字节（找到首条 user 文本即停）
const DSH_LIST_FRAME_CAP = 64;
const DSH_LIST_DECOMPRESS_CAP = 256 * 1024;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// ---------- 通用 ----------

function redactText(t) {
  try {
    return redactMod.redact(t);
  } catch (e) {
    return String(t);
  }
}

/** 文本管线（§3.2）：sanitizeText → 截断（尾部 …[截断]）→ redact */
function finalizeText(raw, maxChars) {
  let t = sanitizeText(raw === null || raw === undefined ? '' : String(raw));
  if (t.length > maxChars) t = t.slice(0, Math.max(0, maxChars)) + '…[截断]';
  return redactText(t);
}

function normalizeTitle(t) {
  const one = sanitizeText(t === null || t === undefined ? '' : String(t)).replace(/\s+/g, ' ').trim();
  return one ? redactText(one.slice(0, 80)) : UNNAMED;
}

/** 归一化消息收集器：seq 连续递增；ts 缺省 null；tool 形状收敛 */
function MessageCollector() {
  const items = [];
  return {
    items,
    get length() {
      return items.length;
    },
    push(role, tsMs, text, tool) {
      items.push({
        seq: items.length + 1,
        role: role === 'user' || role === 'assistant' || role === 'tool' ? role : 'assistant',
        ts: toIso(tsMs),
        text: text === null || text === undefined ? '' : String(text),
        tool:
          tool && typeof tool.name === 'string'
            ? { name: tool.name, status: ['ok', 'error', 'running'].includes(tool.status) ? tool.status : 'ok' }
            : null,
      });
    },
  };
}

/** 键集游标编解码（base64url(JSON{t,id})；非法 → 400 BAD_CURSOR） */
function encodeCursor(t, id) {
  return Buffer.from(JSON.stringify({ t, id }), 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (typeof raw !== 'string' || !raw) throw new HttpError(400, 'BAD_CURSOR', '游标非法');
  try {
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (isPlainObject(o) && Number.isFinite(o.t) && typeof o.id === 'string') return o;
  } catch (e) { /* 落入下方 400 */ }
  throw new HttpError(400, 'BAD_CURSOR', '游标非法');
}

/**
 * 键集分页：raws 按 (lastActiveMs desc, id asc) 全序；cursor 之后取 limit 条，
 * 多取一条判 nextCursor。listId 为会话唯一键（id 类源=会话 id，路径类源=相对路径）。
 */
function paginateRaws(raws, listId, limit, cursor) {
  const arr = (Array.isArray(raws) ? raws : []).slice();
  arr.sort(
    (a, b) =>
      (Number(b.lastActiveMs) || 0) - (Number(a.lastActiveMs) || 0) ||
      String(a[listId] || '').localeCompare(String(b[listId] || ''))
  );
  let start = 0;
  if (cursor) {
    while (
      start < arr.length &&
      !(
        (Number(arr[start].lastActiveMs) || 0) < cursor.t ||
        ((Number(arr[start].lastActiveMs) || 0) === cursor.t &&
          String(arr[start][listId] || '').localeCompare(cursor.id) > 0)
      )
    ) {
      start += 1;
    }
  }
  const page = arr.slice(start, start + limit + 1);
  const hasMore = page.length > limit;
  return { page: page.slice(0, limit), hasMore };
}

function openReadOnlyDb(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** 表是否带 sequence 列（zcode 有、opencode 无——排序策略分叉，R2） */
function hasSequenceColumn(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'sequence');
  } catch (e) {
    return false;
  }
}

// ---------- ① zcode（db/db.sqlite 三表） ----------

function zcodeDbPath(sourceCfg) {
  const root = resolveHome(sourceCfg.root) || defaultRoot('zcode');
  return path.join(root, 'db', 'db.sqlite');
}

function listZcodeSessions(sourceCfg) {
  const dbPath = zcodeDbPath(sourceCfg);
  const db = openReadOnlyDb(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        'SELECT id, title, directory, time_created, time_updated FROM session WHERE time_deleted IS NULL ' +
          'ORDER BY time_updated DESC, id ASC LIMIT 2000'
      )
      .all();
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id || ''),
      listId: String(r.id || ''),
      title: typeof r.title === 'string' ? r.title : '',
      projectId: typeof r.directory === 'string' ? r.directory : '',
      startedMs: r.time_created,
      lastActiveMs: r.time_updated,
      locator: { s: 'zcode', k: 'session', v: { id: String(r.id || '') } },
    }));
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

/** zcode/opencode 共用三表全文装配（构型同构；排序差异由 orderMsg/orderPart SQL 表达） */
function threeTableTranscript(db, sessionId, collect, opts) {
  const msgOrder = opts.msgOrder || 'sequence';
  const partOrder = opts.partOrder || 'sequence';
  const cols = opts.hasDeleted ? 'id, title, directory, time_created, time_updated, time_deleted' : 'id, title, directory, time_created, time_updated';
  const sess = db.prepare(`SELECT ${cols} FROM session WHERE id = ?`).get(sessionId);
  if (!sess) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  if (sess.time_deleted) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在'); // 已删会话（zcode；opencode 无此列不查）
  const messages = db
    .prepare(`SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY ${msgOrder}`)
    .all(sessionId);
  const parts = db
    .prepare(`SELECT message_id, data FROM part WHERE session_id = ? ORDER BY ${partOrder}`)
    .all(sessionId);
  const byMessage = new Map();
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!byMessage.has(p.message_id)) byMessage.set(p.message_id, []);
    byMessage.get(p.message_id).push(p);
  }
  let head = null;
  try {
    head = messages.length > 0 && typeof messages[0].data === 'string' ? JSON.parse(messages[0].data) : null;
  } catch (e) { /* 容错 */ }
  for (const m of Array.isArray(messages) ? messages : []) {
    let mdata = null;
    try {
      mdata = typeof m.data === 'string' ? JSON.parse(m.data) : null;
    } catch (e) { /* 坏行跳过 */ }
    const role = mdata && mdata.role === 'user' ? 'user' : 'assistant';
    const tsMs =
      mdata && mdata.time && Number.isFinite(mdata.time.start)
        ? mdata.time.start
        : Number.isFinite(m.time_created)
          ? m.time_created
          : null;
    for (const p of byMessage.get(m.id) || []) {
      let pdata = null;
      try {
        pdata = typeof p.data === 'string' ? JSON.parse(p.data) : null;
      } catch (e) { continue; }
      if (!pdata || typeof pdata.type !== 'string') continue;
      if (pdata.type === 'text' && typeof pdata.text === 'string' && pdata.text.trim()) {
        collect.push(role, tsMs, pdata.text, null);
      } else if (pdata.type === 'tool') {
        const st = pdata.state && isPlainObject(pdata.state) ? pdata.state : {};
        const status = st.status === 'error' ? 'error' : st.status === 'completed' ? 'ok' : 'running';
        const chunks = [];
        if (st.input !== undefined && st.input !== null) {
          try { chunks.push('入参 ' + JSON.stringify(st.input)); } catch (e) { /* 循环引用容错 */ }
        }
        if (typeof st.output === 'string' && st.output) chunks.push(st.output);
        collect.push('tool', tsMs, chunks.join('\n'), { name: String(pdata.tool || ''), status });
      }
      // 其余 part 形态（step-start/step-finish/reasoning/patch/file）不属于阅读正文，跳过
    }
  }
  return {
    title: typeof sess.title === 'string' ? sess.title : '',
    projectId: typeof sess.directory === 'string' ? sess.directory : '',
    startedMs: sess.time_created,
    lastActiveMs: sess.time_updated,
    head,
  };
}

function transcriptZcode(sourceCfg, locator, collect) {
  const db = openReadOnlyDb(zcodeDbPath(sourceCfg));
  if (!db) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  try {
    return threeTableTranscript(db, locator.v.id, collect, {
      msgOrder: 'sequence',
      partOrder: 'sequence',
      hasDeleted: true,
    });
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

// ---------- ② opencode（opencode.db 三表，无 sequence 列） ----------

function opencodeDbPath(sourceCfg) {
  return resolveHome(sourceCfg.dbPath) || defaultRoot('opencode');
}

function listOpencodeSessions(sourceCfg) {
  const dbPath = opencodeDbPath(sourceCfg);
  const db = openReadOnlyDb(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        'SELECT id, directory, title, time_created, time_updated FROM session ' +
          'ORDER BY time_updated DESC, id ASC LIMIT 2000'
      )
      .all();
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id || ''),
      listId: String(r.id || ''),
      title: typeof r.title === 'string' ? r.title : '',
      projectId: typeof r.directory === 'string' ? r.directory : '',
      startedMs: r.time_created,
      lastActiveMs: r.time_updated,
      locator: { s: 'opencode', k: 'session', v: { id: String(r.id || '') } },
    }));
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

function transcriptOpencode(sourceCfg, locator, collect) {
  const db = openReadOnlyDb(opencodeDbPath(sourceCfg));
  if (!db) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  try {
    const useSeq = hasSequenceColumn(db, 'message') && hasSequenceColumn(db, 'part');
    return threeTableTranscript(db, locator.v.id, collect, {
      msgOrder: useSeq ? 'sequence' : 'time_created, rowid',
      partOrder: useSeq ? 'sequence' : 'time_created, rowid',
      hasDeleted: false,
    });
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

// ---------- ③ workbuddy（sessions 表；全文恒降级 D4） ----------

function workbuddyDbPath(sourceCfg) {
  return resolveHome(sourceCfg.dbPath) || defaultRoot('workbuddy');
}

function listWorkbuddySessions(sourceCfg) {
  const dbPath = workbuddyDbPath(sourceCfg);
  const db = openReadOnlyDb(dbPath);
  if (!db) return [];
  try {
    // 凭据红线：仅 SELECT sessions 表所需列
    const rows = db
      .prepare(
        'SELECT id, cwd, title, status, created_at, last_activity_at FROM sessions ' +
          'ORDER BY last_activity_at DESC, id ASC LIMIT 2000'
      )
      .all();
    const stateMap = {
      running: 'active',
      'in_progress': 'active',
      'in-progress': 'active',
      completed: 'completed',
      complete: 'completed',
      done: 'completed',
      failed: 'failed',
      error: 'failed',
      cancelled: 'cancelled',
      canceled: 'cancelled',
    };
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id === null || r.id === undefined ? '' : r.id),
      listId: String(r.id === null || r.id === undefined ? '' : r.id),
      title: typeof r.title === 'string' ? r.title : '',
      projectId: typeof r.cwd === 'string' ? r.cwd : '',
      startedMs: r.created_at,
      lastActiveMs: r.last_activity_at,
      state: stateMap[String(r.status || '').toLowerCase()] || 'idle',
      locator: { s: 'workbuddy', k: 'session', v: { id: String(r.id === null || r.id === undefined ? '' : r.id) } },
    }));
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

function transcriptWorkbuddy(sourceCfg, locator) {
  const db = openReadOnlyDb(workbuddyDbPath(sourceCfg));
  if (!db) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  try {
    const row = db.prepare('SELECT id, cwd, title, created_at, last_activity_at FROM sessions WHERE id = ?').get(locator.v.id);
    if (!row) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
    return {
      degraded: true,
      reason: 'SOURCE_NO_TRANSCRIPT',
      title: typeof row.title === 'string' ? row.title : '',
      projectId: typeof row.cwd === 'string' ? row.cwd : '',
      startedMs: row.created_at,
      lastActiveMs: row.last_activity_at,
    };
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

// ---------- ⑤ hermes（%LOCALAPPDATA%/hermes/state.db，2026-11-03 第七源） ----------

function hermesDbPath(sourceCfg) {
  return resolveHome(sourceCfg.dbPath) || defaultRoot('hermes');
}

/** Unix 秒浮点（hermes 时间戳口径）→ ms 整数；无效返回 null */
function hermesSecToMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
}

function listHermesSessions(sourceCfg) {
  const db = openReadOnlyDb(hermesDbPath(sourceCfg));
  if (!db) return [];
  try {
    // 凭据红线：仅 SELECT sessions 表所需列；archived/hidden 会话出局
    const rows = db
      .prepare(
        'SELECT id, title, cwd, started_at, last_activity_at FROM sessions ' +
          'WHERE archived = 0 AND hidden = 0 ORDER BY last_activity_at DESC, id ASC LIMIT 2000'
      )
      .all();
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id === null || r.id === undefined ? '' : r.id),
      listId: String(r.id === null || r.id === undefined ? '' : r.id),
      title: typeof r.title === 'string' ? r.title : '',
      projectId: typeof r.cwd === 'string' ? r.cwd : '',
      startedMs: hermesSecToMs(r.started_at),
      lastActiveMs: hermesSecToMs(r.last_activity_at),
      locator: { s: 'hermes', k: 'session', v: { id: String(r.id === null || r.id === undefined ? '' : r.id) } },
    }));
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

/**
 * hermes 全文阅读器：messages 表按 display_order 装配（真全文，非降级——
 * workbuddy 式 SOURCE_NO_TRANSCRIPT 不适用于 hermes，其 messages 列 content 即消息文本）。
 * 只取 active=1 且未 compacted 的 user/assistant/tool 三种角色（与六源阅读器三分类对齐）。
 */
function transcriptHermes(sourceCfg, locator, collect) {
  const db = openReadOnlyDb(hermesDbPath(sourceCfg));
  if (!db) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  try {
    const row = db
      .prepare('SELECT id, cwd, title, started_at, last_activity_at FROM sessions WHERE id = ? AND archived = 0 AND hidden = 0')
      .get(locator.v.id);
    if (!row) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
    const msgs = db
      .prepare(
        "SELECT role, content, timestamp FROM messages WHERE session_id = ? AND active = 1 AND compacted = 0 " +
          "AND role IN ('user','assistant','tool') ORDER BY display_order ASC"
      )
      .all(locator.v.id);
    for (const m of Array.isArray(msgs) ? msgs : []) {
      const text = typeof m.content === 'string' ? m.content : '';
      if (!text) continue; // 空内容行（如纯 reasoning 的 assistant 占位）跳过
      const tsMs = hermesSecToMs(m.timestamp);
      collect.push(m.role, tsMs, text, m.role === 'tool' ? { name: '', status: 'ok' } : null);
    }
    return {
      title: typeof row.title === 'string' ? row.title : '',
      projectId: typeof row.cwd === 'string' ? row.cwd : '',
      startedMs: hermesSecToMs(row.started_at),
      lastActiveMs: hermesSecToMs(row.last_activity_at),
    };
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

// ---------- ④ claude（projects/<编码目录>/<uuid>.jsonl） ----------

/** 扫描全部会话 jsonl（列表按 (mtimeMs desc, 相对键 asc) 键集分页） */
function scanClaudeFiles(sourceCfg) {
  const root = resolveHome(sourceCfg.root) || defaultRoot('claude');
  if (!isDir(root)) return { root, files: [] };
  const files = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    return { root, files: [] };
  }
  for (const pd of projectDirs) {
    const pdir = path.join(root, pd.name);
    let entries;
    try {
      entries = fs.readdirSync(pdir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      try {
        const st = fs.statSync(path.join(pdir, ent.name));
        files.push({ dirName: pd.name, file: ent.name, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
      } catch (e) { /* 竞态删除容忍 */ }
    }
  }
  return { root, files };
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function claudeFileMeta(f, root) {
  const full = path.join(root, f.dirName, f.file);
  const head = parseJsonlBuffer(readHead(full, 32 * 1024));
  const titleText = firstTextOf(head);
  const cwd = cwdFromBuffer(readTail(full, 32 * 1024)) || aa.decodeProjectDirName(f.dirName);
  return { title: titleText || '', projectId: cwd, full };
}

/** 复用活动流同款取法：第一条有文本行（content/lastPrompt/message/text 多形态） */
function firstTextOf(objs) {
  for (const o of objs || []) {
    const t = extractLineText(o);
    if (t) return t;
  }
  return null;
}

/** tail 缓冲抓最后一个 "cwd":"..."（与 agentActivity.cwdFromBuffer 同构） */
function cwdFromBuffer(r) {
  if (!r) return '';
  const text = r.buf.toString('utf8');
  const re = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (last === null) return '';
  try {
    return JSON.parse(`"${last}"`);
  } catch (e) {
    return '';
  }
}

function listClaudeSessions(sourceCfg) {
  const { root, files } = scanClaudeFiles(sourceCfg);
  return files.map((f) => {
    const meta = claudeFileMeta(f, root);
    return {
      id: `${f.dirName}/${f.file}`,
      listId: `${f.dirName}/${f.file}`,
      title: meta.title,
      projectId: meta.projectId,
      startedMs: f.birthtimeMs,
      lastActiveMs: f.mtimeMs,
      locator: { s: 'claude', k: 'project', v: { dir: f.dirName, file: f.file } },
    };
  });
}

/** claude 单行 → 0..n 条归一化消息（text/tool_use/tool_result 块拆分；isSidechain 与非消息行跳过） */
function claudeLineToMessages(o, collect, callNames) {
  if (!isPlainObject(o) || o.isSidechain === true) return;
  if (o.type !== 'user' && o.type !== 'assistant') return; // attachment/queue-operation/last-prompt/summary 等跳过
  const tsMs = toIsoFromValueMs(o.timestamp);
  const lineRole = o.type === 'user' ? 'user' : 'assistant';
  const m = o.message;
  const content = isPlainObject(m) ? m.content : undefined;
  if (typeof content === 'string') {
    if (content.trim()) collect.push(lineRole, tsMs, content, null);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim()) collect.push(lineRole, tsMs, block.text, null);
    } else if (block.type === 'tool_use') {
      if (typeof block.id === 'string' && block.id && typeof block.name === 'string') {
        callNames.set(block.id, block.name);
      }
      let inputText = '';
      try {
        inputText = block.input === undefined ? '' : JSON.stringify(block.input);
      } catch (e) { /* 循环引用容错 */ }
      collect.push('tool', tsMs, inputText, { name: String(block.name || ''), status: 'ok' }); // §3.4：tool_use → 发起（status ok）
    } else if (block.type === 'tool_result') {
      const name = typeof block.tool_use_id === 'string' ? callNames.get(block.tool_use_id) || '' : '';
      const status = block.is_error === true ? 'error' : 'ok';
      let text = '';
      if (typeof block.content === 'string') text = block.content;
      else if (Array.isArray(block.content)) {
        text = block.content
          .filter((b) => isPlainObject(b) && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n');
      }
      collect.push('tool', tsMs, text, { name, status });
    }
    // thinking 等其余块跳过
  }
}

function toIsoFromValueMs(v) {
  const t = toIsoFromValue(v);
  return t === null ? null : Date.parse(t);
}

function transcriptClaude(sourceCfg, locator, collect) {
  const { absolute } = (() => sessionRef.resolveLocatorPath(locator, sourceCfgFullOf(sourceCfg)))();
  const r = readHead(absolute, TRANSCRIPT_FILE_CAP);
  if (!r) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  const st = fs.statSync(absolute);
  const callNames = new Map();
  const lines = parseJsonlBuffer(r);
  for (const o of lines) claudeLineToMessages(o, collect, callNames);
  const cwd = cwdFromBuffer(readTail(absolute, 32 * 1024)) || '';
  return {
    title: firstTextOf(lines) || '',
    projectId: cwd,
    startedMs: st.birthtimeMs,
    lastActiveMs: st.mtimeMs,
    readTruncated: r.truncated || st.size > TRANSCRIPT_FILE_CAP,
  };
}

/** resolveLocatorPath 需要 config 形状：把单源 sources 节包成全量形（路径类三源共用） */
function sourceCfgFullOf(sourceCfg) {
  return { agentActivity: { sources: { claude: sourceCfg, dsh: sourceCfg, codex: sourceCfg } } };
}

// ---------- ⑤ dsh（session*.jsonl.zstd 多帧 / rollout-*.jsonl 明文） ----------

/** zstd 多帧分帧解压（R3：单次 sync 只出首帧，必须按 magic 逐帧）；超过 decompressCap 停止 → truncated */
function zstdDecompressFrames(buf, decompressCap) {
  const caps = decompressCap || DSH_DECOMPRESS_CAP;
  const outs = [];
  let total = 0;
  let truncated = false;
  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    offs.push(i);
    i += ZSTD_MAGIC.length;
    if (offs.length > 200000) break; // 防御：异常巨型帧表
  }
  for (let k = 0; k < offs.length; k++) {
    if (total > caps) {
      truncated = true;
      break;
    }
    const chunk = buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length);
    try {
      const out = zlib.zstdDecompressSync(chunk);
      total += out.length;
      outs.push(out);
    } catch (e) { /* 伪 magic/损坏帧跳过（列表标题/全文均降级容忍） */ }
  }
  return { text: Buffer.concat(outs).toString('utf8'), truncated: truncated || total > caps };
}

/** 扫描 dsh 会话文件（两层布局兼容，同活动流 dshAdapter） */
function scanDshFiles(sourceCfg) {
  const root = resolveHome(sourceCfg.root) || defaultRoot('dsh');
  const files = [];
  if (!isDir(root)) return { root, files };
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    return { root, files };
  }
  for (const pd of projectDirs) {
    const pdir = path.join(root, pd.name);
    let entries;
    try {
      entries = fs.readdirSync(pdir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      const rel1 = (n) => /^rollout-.*\.jsonl$/.test(n);
      if (ent.isFile() && rel1(ent.name)) {
        pushDshFile(files, root, pd.name, pd.name, 'rollout', ent.name);
        continue;
      }
      if (!ent.isDirectory()) continue;
      let inner;
      try {
        inner = fs.readdirSync(path.join(pdir, ent.name), { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const f2 of inner) {
        if (!f2.isFile()) continue;
        if (/^session.*\.jsonl\.zstd$/.test(f2.name)) pushDshFile(files, root, pd.name, ent.name, 'zstd', f2.name);
        else if (/^rollout-.*\.jsonl$/.test(f2.name)) pushDshFile(files, root, pd.name, ent.name, 'rollout', f2.name);
      }
    }
  }
  return { root, files };
}

function pushDshFile(files, root, dirName, sessDirName, kind, fileName) {
  const rel = `${dirName}/${sessDirName}/${fileName}`;
  try {
    const st = fs.statSync(path.join(root, dirName, sessDirName, fileName));
    files.push({ dirName, sessDirName, kind, file: fileName, rel, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
  } catch (e) { /* 竞态删除容忍 */ }
}

/** dsh 标题：首条 user 文本前 60 字（§3.1）；zstd 轻解压（帧数/字节双帽）找首个 user/message */
function dshTitleOf(root, f) {
  const full = path.join(root, f.dirName, f.sessDirName, f.file);
  let lines = [];
  let header = null;
  if (f.kind === 'zstd') {
    let buf;
    try {
      if (fs.statSync(full).size > DSH_ZSTD_CAP) return { title: '', header: null };
      buf = fs.readFileSync(full);
    } catch (e) {
      return { title: '', header: null };
    }
    const dec = zstdDecompressFrames(buf, DSH_LIST_DECOMPRESS_CAP);
    let acc = 0;
    for (const line of dec.text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let o = null;
      try {
        o = JSON.parse(t);
      } catch (e) { continue; }
      if (!isPlainObject(o)) continue;
      if (!header && o.type === 'session') header = o;
      if (o.type === 'user/message') {
        const txt = dshContentText(o.data && o.data.content);
        if (txt) {
          lines = [txt];
          break;
        }
      }
      acc += 1;
      if (acc >= DSH_LIST_FRAME_CAP) break;
    }
  } else {
    const head = parseJsonlBuffer(readHead(full, 32 * 1024));
    for (const o of head) {
      if (isPlainObject(o) && o.type === 'session') header = o;
      if (isPlainObject(o) && o.type === 'user/message') {
        const txt = dshContentText(o.data && o.data.content);
        if (txt) {
          lines = [txt];
          break;
        }
      }
    }
    if (lines.length === 0) {
      const t = firstTextOf(head.filter((o) => !(isPlainObject(o) && o.type === 'session')));
      if (t) lines = [t];
    }
  }
  const raw = lines[0] || '';
  return { title: raw.replace(/\s+/g, ' ').trim().slice(0, 60), header };
}

function dshContentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => isPlainObject(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

function listDshSessions(sourceCfg) {
  const { root, files } = scanDshFiles(sourceCfg);
  return files.map((f) => {
    const { title, header } = dshTitleOf(root, f);
    return {
      id: f.rel,
      listId: f.rel,
      title,
      projectId: (header && typeof header.cwd === 'string' && header.cwd) || aa.decodeProjectDirName(f.dirName),
      startedMs: header && Number.isFinite(header.createdAt) ? header.createdAt : f.birthtimeMs,
      lastActiveMs: f.mtimeMs,
      locator: { s: 'dsh', k: 'file', v: { path: f.rel } },
    };
  });
}

/** dsh 行 → 归一化消息（R3 形态；解析不出文本的行跳过不报错） */
function dshLineToMessages(o, collect, callNames) {
  if (!isPlainObject(o) || typeof o.type !== 'string') return;
  const tsMs = Number.isFinite(o.time) ? o.time : null;
  const d = o.data;
  switch (o.type) {
    case 'user/message':
    case 'assistant/message': {
      const role = o.type === 'user/message' ? 'user' : 'assistant';
      const content =
        role === 'user' ? (isPlainObject(d) ? d.content : undefined) : isPlainObject(d) && isPlainObject(d.message) ? d.message.content : undefined;
      const text = dshContentText(content);
      if (text) collect.push(role, tsMs, text, null);
      break;
    }
    case 'tool/call': {
      if (!isPlainObject(d)) break;
      if (typeof d.callId === 'string' && d.callId && typeof d.name === 'string') {
        callNames.set(d.callId, d.name);
      }
      collect.push('tool', tsMs, typeof d.arguments === 'string' ? d.arguments : '', {
        name: String(d.name || ''),
        status: 'running',
      });
      break;
    }
    case 'tool/result': {
      if (!isPlainObject(d)) break;
      const msg = isPlainObject(d.message) ? d.message : {};
      const callId = isPlainObject(msg.source) && typeof msg.source.callId === 'string' ? msg.source.callId : '';
      const chunks = [];
      let isError = false;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!isPlainObject(block) || block.type !== 'tool-result') continue;
          if (block.isError === true) isError = true;
          if (Array.isArray(block.content)) {
            for (const inner of block.content) {
              if (isPlainObject(inner) && inner.type === 'text' && typeof inner.text === 'string') chunks.push(inner.text);
            }
          }
        }
      }
      collect.push('tool', tsMs, chunks.join('\n'), {
        name: callId ? callNames.get(callId) || '' : '',
        status: isError ? 'error' : 'ok',
      });
      break;
    }
    default:
      break; // session 元数据/标题/step/turn/请求头/chunks 流水行等一概跳过
  }
}

function transcriptDsh(sourceCfg, locator, collect) {
  sessionRef.resolveLocatorPath(locator, sourceCfgFullOf(sourceCfg));
  const root = resolveHome(sourceCfg.root) || defaultRoot('dsh');
  const rel = String(locator.v.path).split(/[\\/]/).join(path.sep);
  const full = path.join(root, rel);
  let st;
  try {
    st = fs.statSync(full);
  } catch (e) {
    throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  }
  let header = null;
  let readTruncated = false;
  const callNames = new Map();
  if (st.size > DSH_ZSTD_CAP) {
    // 超限不解压（R4 读入闸）：正文空、truncated 标记，头部信息尽力从活动流同款来源补
    return { title: '', projectId: '', startedMs: st.birthtimeMs, lastActiveMs: st.mtimeMs, readTruncated: true };
  }
  if (/\.zstd$/.test(full)) {
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (e) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
    }
    const dec = zstdDecompressFrames(buf, DSH_DECOMPRESS_CAP);
    readTruncated = dec.truncated;
    for (const line of dec.text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let o = null;
      try {
        o = JSON.parse(t);
      } catch (e) { continue; }
      if (isPlainObject(o) && o.type === 'session') {
        header = o;
        continue;
      }
      dshLineToMessages(o, collect, callNames);
    }
  } else {
    const r = readHead(full, TRANSCRIPT_FILE_CAP);
    if (!r) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
    readTruncated = st.size > TRANSCRIPT_FILE_CAP;
    for (const o of parseJsonlBuffer(r)) {
      if (isPlainObject(o) && o.type === 'session') {
        header = o;
        continue;
      }
      dshLineToMessages(o, collect, callNames);
    }
  }
  return {
    title: collectFirstUserText(collect), // §3.1：dsh 标题=首条 user 文本前 60 字（与列表同源）
    projectId: (header && typeof header.cwd === 'string' && header.cwd) || '',
    startedMs: header && Number.isFinite(header.createdAt) ? header.createdAt : st.birthtimeMs,
    lastActiveMs: st.mtimeMs,
    readTruncated,
  };
}

function collectFirstUserText(collect) {
  for (const m of collect.items) {
    if (m.role === 'user' && m.text.trim()) return m.text.replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  return '';
}

// ---------- ⑥ codex（YYYY/MM/DD/rollout-*.jsonl） ----------

function scanCodexFiles(sourceCfg) {
  const root = resolveHome(sourceCfg.root) || defaultRoot('codex');
  const files = [];
  if (!isDir(root)) return { root, files };
  const listDirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (e) {
      return [];
    }
  };
  let yearDirs;
  try {
    yearDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    return { root, files };
  }
  for (const yd of yearDirs) {
    for (const md of listDirs(path.join(root, yd.name))) {
      for (const dd of listDirs(path.join(root, yd.name, md.name))) {
        const dayDir = path.join(root, yd.name, md.name, dd.name);
        let entries;
        try {
          entries = fs.readdirSync(dayDir, { withFileTypes: true });
        } catch (e) {
          continue;
        }
        for (const ent of entries) {
          if (!ent.isFile() || !/^rollout-.*\.jsonl$/.test(ent.name)) continue;
          try {
            const st = fs.statSync(path.join(dayDir, ent.name));
            files.push({
              rel: `${yd.name}/${md.name}/${dd.name}/${ent.name}`,
              mtimeMs: st.mtimeMs,
              birthtimeMs: st.birthtimeMs,
            });
          } catch (e) { /* 竞态删除容忍 */ }
        }
      }
    }
  }
  return { root, files };
}

function listCodexSessions(sourceCfg) {
  const { root, files } = scanCodexFiles(sourceCfg);
  return files.map((f) => {
    const head = parseJsonlBuffer(readHead(path.join(root, f.rel.split('/').join(path.sep)), 64 * 1024));
    const metaRec = head.find((o) => o && o.type === 'session_meta' && isPlainObject(o.payload));
    const meta = (metaRec && metaRec.payload) || {};
    const firstUser = codexUserTextOf(head);
    return {
      id: f.rel,
      listId: f.rel,
      title: firstUser ? firstUser.replace(/\s+/g, ' ').trim().slice(0, 60) : '',
      projectId: typeof meta.cwd === 'string' ? meta.cwd : '',
      startedMs: Date.parse(meta.timestamp) || f.birthtimeMs,
      lastActiveMs: f.mtimeMs,
      locator: { s: 'codex', k: 'file', v: { path: f.rel } },
    };
  });
}

function codexTextOf(payload) {
  if (!isPlainObject(payload)) return null;
  if (Array.isArray(payload.content)) {
    const t = payload.content
      .filter((b) => b && typeof b.text === 'string' && b.text)
      .map((b) => b.text)
      .join('');
    if (t) return t;
  }
  if (typeof payload.message === 'string' && payload.message) return payload.message;
  return null;
}

function codexUserTextOf(objs) {
  for (const o of objs || []) {
    if (o && o.type === 'response_item' && isPlainObject(o.payload) && o.payload.type === 'message' && o.payload.role === 'user') {
      const t = codexTextOf(o.payload);
      if (t) return t;
    }
  }
  return null;
}

function transcriptCodex(sourceCfg, locator, collect) {
  sessionRef.resolveLocatorPath(locator, sourceCfgFullOf(sourceCfg));
  const root = resolveHome(sourceCfg.root) || defaultRoot('codex');
  const rel = String(locator.v.path).split(/[\\/]/).join(path.sep);
  const full = path.join(root, rel);
  let st;
  try {
    st = fs.statSync(full);
  } catch (e) {
    throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  }
  const r = readHead(full, TRANSCRIPT_FILE_CAP);
  if (!r) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  const callNames = new Map();
  let meta = {};
  const lines = parseJsonlBuffer(r);
  for (const o of lines) {
    if (!isPlainObject(o)) continue;
    const tsMs = toIsoFromValueMs(o.timestamp);
    if (o.type === 'session_meta' && isPlainObject(o.payload)) {
      meta = o.payload;
      continue;
    }
    if (o.type !== 'response_item' || !isPlainObject(o.payload)) continue; // turn_context/world_state/event_msg 跳过
    const p = o.payload;
    if (p.type === 'message') {
      const text = codexTextOf(p);
      if (text && (p.role === 'user' || p.role === 'assistant')) collect.push(p.role, tsMs, text, null);
    } else if (p.type === 'function_call') {
      if (typeof p.call_id === 'string' && p.call_id && typeof p.name === 'string') callNames.set(p.call_id, p.name);
      collect.push('tool', tsMs, typeof p.arguments === 'string' ? p.arguments : '', { name: String(p.name || ''), status: 'running' });
    } else if (p.type === 'function_call_output') {
      collect.push('tool', tsMs, typeof p.output === 'string' ? p.output : '', {
        name: typeof p.call_id === 'string' ? callNames.get(p.call_id) || '' : '',
        status: 'ok',
      });
    }
    // reasoning 等其余 payload 跳过
  }
  return {
    title: codexUserTextOf(lines) ? codexUserTextOf(lines).replace(/\s+/g, ' ').trim().slice(0, 60) : '',
    projectId: typeof meta.cwd === 'string' ? meta.cwd : '',
    startedMs: Date.parse(meta.timestamp) || st.birthtimeMs,
    lastActiveMs: st.mtimeMs,
    readTruncated: r.truncated || st.size > TRANSCRIPT_FILE_CAP,
  };
}

// ---------- ⑦ 派工词（v2.9.21）：会话首条「真人指令」 ----------

/**
 * 派工词 = 归一化转录里第一条非注入的 user 文本（复用六源全文适配器，含脱敏/截断/读入闸）。
 * 实证（2026-10-29 真机抽样）：zcode db 首条 user part 即派工词；codex 前几条 user 是注入包裹
 * （AGENTS.md 指令块 / # Files mentioned 文件引用 / <environment_context>），真指令在后；
 * claude 首条基本干净但偶有 <system-reminder> 注入。故清洗分两层：全源标签块剔除 + codex 专属跳过。
 */

const DISPATCH_TEXT_CAP = 800; // 派工词返回上限（超出尾部 …[截断]；展示侧另做钳制）
const DISPATCH_SOURCES = ['zcode', 'claude', 'codex']; // v2.9.21 首批三源（dsh/opencode 按需扩）
const DISPATCH_CACHE_TTL_MS = 120 * 1000; // ref → 派工词 内存缓存（会话首条不变，TTL 防长驻陈旧）
const DISPATCH_CACHE_MAX = 200;
const dispatchCache = new Map(); // ref -> { at, item }（Map 保序，超帽删最旧）

// 注入标签块整段剔除（DOTALL 多行）；剔除后剩空 → 该条不算派工词，继续找下一条 user
const DISPATCH_NOISE_BLOCK_RES = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<untrusted_gen_ui_state>[\s\S]*?<\/untrusted_gen_ui_state>/g,
];

/**
 * 单条 user 文本 → 派工词候选（'' = 纯注入，跳过）。
 * @param {string} agent 源 id（codex 有专属包裹规则）
 * @param {string} raw 归一化 user 文本（未 finalize）
 */
function dispatchTextOf(agent, raw) {
  let t = String(raw || '');
  for (const re of DISPATCH_NOISE_BLOCK_RES) t = t.replace(re, '');
  t = t.trim();
  if (!t) return '';
  if (agent === 'codex') {
    const s = t.replace(/^\s+/, '');
    if (s.startsWith('# AGENTS.md instructions') || s.startsWith('<user_instructions>')) return '';
    if (s.startsWith('# Files mentioned by the user:')) {
      // 文件引用包裹块：真指令在最后一个 ## 文件条目之后；取不到即纯引用，跳过
      const lines = s.split(/\r?\n/);
      let last = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) last = i;
      }
      if (last >= 0) t = lines.slice(last + 1).join('\n').trim();
      if (!t) return '';
    }
  }
  return t;
}

/** ref → 首条真人指令。响应 {found,text,ts,agent,ref,startedAt,lastActiveAt}；会话不存在 404。 */
function getDispatchPrompt(config, ref, opts) {
  const o = opts || {};
  const loc = sessionRef.validateRef(ref, config);
  const agent = loc.s;
  const sec = normalizeAgentActivity(isPlainObject(config) ? config.agentActivity : null);
  const src = sec.sources[agent] || {};
  if (sec.enabled === false || src.enabled === false) {
    throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  }
  const adapters = o.adapters && isPlainObject(o.adapters) ? o.adapters : TRANSCRIPT_SOURCES;
  const fn = adapters[agent];
  if (typeof fn !== 'function') throw new HttpError(400, 'BAD_AGENT', '该源不支持派工词读取');
  const collect = MessageCollector();
  let meta;
  try {
    meta = fn(src, loc, collect) || {};
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, 'INTERNAL', '服务器内部错误');
  }
  let first = null;
  for (const m of collect.items) {
    if (m.role !== 'user' || !m.text.trim()) continue;
    const cleaned = dispatchTextOf(agent, m.text);
    if (cleaned) {
      first = { text: cleaned, ts: m.ts };
      break;
    }
  }
  return {
    ref,
    agent,
    found: !!first,
    text: first ? finalizeText(first.text, o.maxChars || DISPATCH_TEXT_CAP) : '',
    ts: first ? first.ts : null,
    startedAt: toIso(meta.startedMs),
    lastActiveAt: toIso(meta.lastActiveMs),
  };
}

function dispatchCacheGet(ref, now) {
  const hit = dispatchCache.get(ref);
  if (!hit) return null;
  if (now - hit.at > DISPATCH_CACHE_TTL_MS) {
    dispatchCache.delete(ref);
    return null;
  }
  return hit.item;
}

function dispatchCachePut(ref, item, now) {
  if (dispatchCache.size >= DISPATCH_CACHE_MAX) {
    const oldest = dispatchCache.keys().next().value;
    if (oldest !== undefined) dispatchCache.delete(oldest);
  }
  dispatchCache.set(ref, { at: now, item });
}

/**
 * 按绑定项目列派工词：首批三源各取最近 perSource 条有真人指令的会话（startedAt 倒序合并）。
 * project 为空直接空返回（未绑定项目的任务没有会话归属，零扫描零出网）。
 * 单源故障隔离：列表/转录失败该源跳过，不拖垮整体（与六源阅读器同纪律）。
 * 代价注记：每会话一次全文读入（≤4MB 闸），经 dispatchCache TTL 缓存兜底重复打开。
 * @param {{project:string, perSource?:number, agents?:string[], noCache?:boolean, now?:number, adapters?:object}} opts
 */
function listDispatchPrompts(config, opts) {
  const o = opts || {};
  const project = typeof o.project === 'string' ? o.project.trim() : '';
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const perSource = Math.min(Math.max(Number(o.perSource) || 2, 1), 3);
  const agents = Array.isArray(o.agents) && o.agents.length ? o.agents : DISPATCH_SOURCES;
  const items = [];
  if (!project) return { project, items };
  for (const agent of agents) {
    let page;
    try {
      page = listAgentSessions(config, { agent, limit: perSource * 4, project, now });
    } catch (e) {
      continue; // 单源隔离：未知源/源故障该源跳过
    }
    let got = 0;
    for (const it of page.items) {
      if (got >= perSource) break;
      const cached = o.noCache ? null : dispatchCacheGet(it.ref, now);
      if (cached) {
        items.push(cached);
        got += 1;
        continue;
      }
      let d;
      try {
        d = getDispatchPrompt(config, it.ref, { now, adapters: o.adapters });
      } catch (e) {
        continue; // 404（会话消失/已删）/源故障：跳过该会话
      }
      if (!d.found) continue; // 全注入无真人指令 → 不展示
      const item = { agent, ref: d.ref, startedAt: d.startedAt, lastActiveAt: it.lastActiveAt, text: d.text };
      if (!o.noCache) dispatchCachePut(d.ref, item, now);
      items.push(item);
      got += 1;
    }
  }
  items.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return { project, items: items.slice(0, perSource * DISPATCH_SOURCES.length) };
}

// ---------- 聚合入口 ----------

const LIST_SOURCES = {
  zcode: listZcodeSessions,
  claude: listClaudeSessions,
  dsh: listDshSessions,
  codex: listCodexSessions,
  opencode: listOpencodeSessions,
  workbuddy: listWorkbuddySessions,
  hermes: listHermesSessions,
};

/**
 * listAgentSessions(config, {agent, limit, cursor, now})
 * → {agent, items:[{ref,id,title,projectId,startedAt,lastActiveAt,state}], nextCursor}
 * 单源故障隔离：该源适配器异常 → 空页（不拖垮服务，§7-5 暴露面零新增语义内收敛）。
 */
/** v2.9.3 项目归一化键（与前端 actGroupKey 同口径）：去尾分隔符 + 分隔符统一为 \ + 小写 */
function normalizeProjectKey(p) {
  return String(p || '').trim().replace(/[\\/]+$/, '').toLowerCase().replace(/[\\/]+/g, '\\');
}

function listAgentSessions(config, opts) {
  const o = opts || {};
  const agent = typeof o.agent === 'string' ? o.agent.trim().toLowerCase() : '';
  if (!SOURCE_IDS.includes(agent)) throw new HttpError(400, 'BAD_AGENT', 'agent 必须为七源 id 之一');
  const sec = normalizeAgentActivity(isPlainObject(config) ? config.agentActivity : null);
  const limitDef = sec.sessionList;
  let limit = Number.isInteger(o.limit) && o.limit > 0 ? o.limit : limitDef.limit;
  if (limit > limitDef.maxLimit) limit = limitDef.maxLimit;
  const cursor = o.cursor ? decodeCursor(o.cursor) : null;
  const now = Number.isFinite(o.now) ? o.now : Date.now();

  const src = sec.sources[agent] || {};
  let raws = [];
  if (sec.enabled !== false && src.enabled !== false) {
    try {
      raws = LIST_SOURCES[agent](src) || [];
    } catch (e) {
      if (e instanceof HttpError) throw e;
      console.error(`[agent-sessions] ${agent} 列表失败（单源隔离）:`, (e && e.message) || e);
      raws = [];
    }
  }

  // v2.9.3：项目过滤（智能体动态按项目分组钻取时，会话列表只出该项目）——
  // project 参数存在即过滤（含空串=「未知项目」组），缺省不过滤；必须先滤后分页，游标分页才不串组
  if (o.project !== undefined && o.project !== null) {
    const want = normalizeProjectKey(o.project);
    raws = raws.filter((r) => normalizeProjectKey(r.projectId) === want);
  }

  const { page, hasMore } = paginateRaws(raws, 'listId', limit, cursor);
  const items = page.map((r) => {
    const lastMs = Number(r.lastActiveMs) || 0;
    const ref = sessionRef.encodeRef(r.locator);
    return {
      ref,
      id: String(r.id || ''),
      title: normalizeTitle(r.title),
      projectId: typeof r.projectId === 'string' ? r.projectId : '',
      startedAt: toIso(r.startedMs) || toIso(lastMs) || toIso(now),
      lastActiveAt: toIso(lastMs) || toIso(now),
      state: r.state || stateFor(lastMs, now),
    };
  });
  const last = page[page.length - 1];
  return {
    agent,
    items,
    nextCursor: hasMore && last ? encodeCursor(Number(last.lastActiveMs) || 0, String(last.listId || '')) : null,
  };
}

const TRANSCRIPT_SOURCES = {
  zcode: transcriptZcode,
  claude: transcriptClaude,
  dsh: transcriptDsh,
  codex: transcriptCodex,
  opencode: transcriptOpencode,
  workbuddy: transcriptWorkbuddy,
  hermes: transcriptHermes,
};

/**
 * getAgentTranscript(config, ref, {now})
 * → §3.2 响应对象（正常/降级）；ref 非法 400 BAD_REF、会话不存在 404 SESSION_NOT_FOUND。
 */
function getAgentTranscript(config, ref, opts) {
  const o = opts || {};
  const loc = sessionRef.validateRef(ref, config);
  const agent = loc.s;
  const sec = normalizeAgentActivity(isPlainObject(config) ? config.agentActivity : null);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const limits = sec.transcript;
  const src = sec.sources[agent] || {};
  if (sec.enabled === false || src.enabled === false) {
    throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  }

  const collect = MessageCollector();
  let meta;
  try {
    meta = TRANSCRIPT_SOURCES[agent](src, loc, collect) || {};
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, 'INTERNAL', '服务器内部错误');
  }

  const base = {
    ref,
    agent,
    title: normalizeTitle(meta.title),
    projectId: typeof meta.projectId === 'string' ? meta.projectId : '',
    startedAt: toIso(meta.startedMs),
    lastActiveAt: toIso(meta.lastActiveMs) || toIso(now),
  };

  if (meta.degraded) {
    return Object.assign(base, { degraded: true, reason: meta.reason || 'SOURCE_NO_TRANSCRIPT', messages: [] });
  }

  const total = collect.length;
  const truncatedByCount = total > limits.maxMessages;
  const capped = truncatedByCount ? collect.items.slice(0, limits.maxMessages) : collect.items;
  const messages = capped.map((m) => ({
    seq: m.seq,
    role: m.role,
    ts: m.ts,
    text: finalizeText(m.text, limits.maxCharsPerMessage),
    tool: m.tool,
  }));
  return Object.assign(base, {
    degraded: false,
    total,
    truncated: truncatedByCount || !!meta.readTruncated,
    messages,
  });
}

// ---------- 路由挂载 ----------

/** 两条新端点（§3）：GET /api/agent-sessions、GET /api/agent-session */
function registerAgentSessionRoutes(router, ctx) {
  router.add('GET', '/api/agent-sessions', (c) => {
    const limitRaw = c.query.get('limit');
    const limit = limitRaw === null || limitRaw === '' ? undefined : Number(limitRaw);
    const result = listAgentSessions(ctx.config, {
      agent: c.query.get('agent') || '',
      limit: Number.isInteger(limit) ? limit : undefined,
      cursor: c.query.get('cursor') || null,
      // v2.9.3：project 参数存在即过滤（含空串=未知项目组），缺省不过滤
      project: c.query.has('project') ? (c.query.get('project') || '') : undefined,
    });
    sendJSON(c.res, 200, result);
  });

  router.add('GET', '/api/agent-session', (c) => {
    const ref = c.query.get('ref') || '';
    sendJSON(c.res, 200, getAgentTranscript(ctx.config, ref, {}));
  });

  // v2.9.21 派工词：GET /api/agent-dispatch?project=<绑定项目>（project 缺省/空 → 空列表，不扫源）
  router.add('GET', '/api/agent-dispatch', (c) => {
    sendJSON(c.res, 200, listDispatchPrompts(ctx.config, { project: c.query.get('project') || '' }));
  });
}

// 供测试直通的适配器单测口
module.exports = {
  SOURCE_IDS,
  listAgentSessions,
  normalizeProjectKey,
  getAgentTranscript,
  registerAgentSessionRoutes,
  // v2.9.21 派工词
  DISPATCH_SOURCES,
  dispatchTextOf,
  getDispatchPrompt,
  listDispatchPrompts,
  // 内部实现直通（测试用）
  listZcodeSessions,
  listClaudeSessions,
  listDshSessions,
  listCodexSessions,
  listOpencodeSessions,
  listWorkbuddySessions,
  transcriptZcode,
  transcriptClaude,
  transcriptDsh,
  transcriptCodex,
  transcriptOpencode,
  transcriptWorkbuddy,
  zstdDecompressFrames,
  finalizeText,
};
