'use strict';

/**
 * agentActivity.js — 智能体工作观测（v2.6）：五数据源适配器 + 聚合
 *
 * 让业主看到每个 AI 智能体「在干什么、哪个项目、产出内容预览」。五个数据源（全部只读）：
 *  - zcode     ~/.zcode/cli        db/db.sqlite 的 session 表（新版主源：id/title/directory/时间/last_outcome）
 *                                    + 旧格式兜底：agents/sess_<uuid>/agent_xxx/metadata.json 与 exec/ 下 call_*.log
 *  - claude    ~/.claude/projects  <编码项目路径> 目录下各 jsonl（每行一个 JSON：queue-operation.content /
 *                                    last-prompt.lastPrompt / cwd 字段）
 *  - dsh       ~/.dsh/sessions     <编码项目路径> 下 session-N 目录内 session*.jsonl.zstd（首行 session 元数据含
 *                                    cwd/createdAt；node:zlib zstd 解压，大小封顶）+ 兼容 rollout-N.jsonl 明文
 *  - workbuddy ~/.workbuddy/workbuddy.db（node:sqlite DatabaseSync {readOnly:true}，仅 SELECT sessions 表
 *                                    id/cwd/title/status/created_at/last_activity_at 五列，凭据红线不碰其余表）
 *  - codex     ~/.codex/sessions   YYYY/MM/DD/rollout-*.jsonl（首行 session_meta 的 id/cwd/timestamp；
 *                                    标题取首条 user response_item，预览取尾部最后一条文本）
 *
 * 另有 opencode = node:sqlite 只读 session 表五列，仅服务桌面成员册派生（不进活动面板）。
 *
 * 统一规则：每源取最近 perSourceLimit(10) 条；合并按 lastActiveAt 倒序；总数 ≤ maxItems(40)；
 * preview = 该会话最后一条消息/输出的前 previewChars(200) 字（读文件尾部实现，不全文读大文件）。
 * 全部路径可配置（config.agentActivity，空串 = 回退本机默认位置）；某源目录不存在 → 该源
 * ok:false 跳过不报错；每源独立 try/catch，单源故障不影响其他源。
 *
 * 红线：对所有数据源一律只读（sqlite {readOnly:true}、文件只 openSync 读、绝不写）；凭据文件
 * （.env/.credentials 等）一律不读不碰；运行中服务不碰。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { encodeRef, locatorShapeOk } = require('./sessionRef');

/** v2.3（D5）：形状合法才发 ref（不透明引用）——可回查的源才填，防死引用进活动流 */
function refOf(loc) {
  try {
    return locatorShapeOk(loc) ? encodeRef(loc) : '';
  } catch (e) {
    return '';
  }
}

// ---------- 配置默认值与归一化 ----------

const SOURCE_IDS = ['zcode', 'claude', 'dsh', 'workbuddy', 'codex'];

// v2.6 桌面成员册专用源：参与 normalize 回填与 settings 校验（codex 已升为活动面板正式源，见 SOURCE_IDS）
// hermes（2026-11-03 第七源）同 opencode 口径：成员册/设置/阅读器，不进活动面板聚合
const ALL_SOURCE_IDS = [...SOURCE_IDS, 'opencode', 'hermes'];

const SOURCE_DEFAULTS = {
  zcode: { enabled: true, root: '' }, // '' = ~/.zcode/cli
  claude: { enabled: true, root: '' }, // '' = ~/.claude/projects
  dsh: { enabled: true, root: '' }, // '' = ~/.dsh/sessions
  workbuddy: { enabled: true, dbPath: '' }, // '' = ~/.workbuddy/workbuddy.db
  codex: { enabled: true, root: '' },       // '' = ~/.codex/sessions（ChatGPT 桌面 rollout 会话）
  opencode: { enabled: true, dbPath: '' },  // '' = ~/.local/share/opencode/opencode.db
  // hermes（2026-11-03 第七源，opencode 同款待遇）：桌面成员册+阅读器，不进活动面板五源
  //（aggregate/snapshot/heatmap/agentContext 走 SOURCE_IDS，见各处注释）；'' = %LOCALAPPDATA%/hermes/state.db
  hermes: { enabled: true, dbPath: '' },
};

// v2.3 会话阅读器：会话列表与全文的限额（normalizeAgentActivity 兜底，F1）
const DEFAULT_SESSION_LIST_LIMITS = { limit: 20, maxLimit: 50 };
const DEFAULT_TRANSCRIPT_LIMITS = { maxMessages: 1000, maxCharsPerMessage: 20000 };

const DEFAULT_AGENT_ACTIVITY = {
  enabled: true,
  perSourceLimit: 10,
  maxItems: 40,
  previewChars: 200,
  sessionList: clone(DEFAULT_SESSION_LIST_LIMITS),
  transcript: clone(DEFAULT_TRANSCRIPT_LIMITS),
  sources: clone(SOURCE_DEFAULTS),
};

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 节归一化：缺省键回填默认值（store.mergeConfigDefaults / settings PATCH 回填共用，防部分 PATCH 抹默认） */
function normalizeAgentActivity(section) {
  const src = isPlainObject(section) ? section : {};
  const out = clone(DEFAULT_AGENT_ACTIVITY);
  if (src.enabled !== undefined) out.enabled = src.enabled === true;
  for (const k of ['perSourceLimit', 'maxItems', 'previewChars']) {
    if (Number.isInteger(src[k]) && src[k] > 0) out[k] = src[k];
  }
  out.sources = {};
  for (const id of ALL_SOURCE_IDS) {
    out.sources[id] = Object.assign(
      clone(SOURCE_DEFAULTS[id]),
      isPlainObject(src.sources) && isPlainObject(src.sources[id]) ? src.sources[id] : {}
    );
  }
  // v2.3 会话阅读器限额：子节兜底（非法/缺失回默认，防手改坏值进运行期）
  for (const [key, def] of [['sessionList', DEFAULT_SESSION_LIST_LIMITS], ['transcript', DEFAULT_TRANSCRIPT_LIMITS]]) {
    const sub = isPlainObject(src[key]) ? src[key] : {};
    out[key] = {};
    for (const k of Object.keys(def)) {
      out[key][k] = Number.isInteger(sub[k]) && sub[k] > 0 ? sub[k] : def[k];
    }
  }
  return out;
}

/** '~' 展开为用户主目录；空串返回 ''（由调用方回退默认位置） */
function resolveHome(p) {
  if (typeof p !== 'string' || p.trim() === '') return '';
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultRoot(id) {
  const h = os.homedir();
  switch (id) {
    case 'zcode':
      return path.join(h, '.zcode', 'cli');
    case 'claude':
      return path.join(h, '.claude', 'projects');
    case 'dsh':
      return path.join(h, '.dsh', 'sessions');
    case 'workbuddy':
      return path.join(h, '.workbuddy', 'workbuddy.db');
    case 'codex':
      return path.join(h, '.codex', 'sessions');
    case 'opencode':
      return path.join(h, '.local', 'share', 'opencode', 'opencode.db');
    case 'hermes': {
      // Hermes Agent 数据目录在本机 %LOCALAPPDATA%\hermes（~/.hermes 只有 skills，考古结论见评审）
      const lad = process.env.LOCALAPPDATA && String(process.env.LOCALAPPDATA).trim();
      return path.join(lad || path.join(h, 'AppData', 'Local'), 'hermes', 'state.db');
    }
    default:
      return '';
  }
}

// ---------- 小工具 ----------

/** 文本净化：控制字符（保留换行/制表）替换为空格 + ANSI 转义剔除 */
function sanitizeText(s) {
  return String(s)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
}

/** 压成单行并截断到 max 字符（中间不省略，尾部截断） */
function truncateOneLine(s, max) {
  const one = sanitizeText(s).replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return one.slice(0, Math.max(0, max));
}

/** 读文件尾部 maxBytes 字节（openSync 只读；小文件全文）。文件缺失/异常返回 null */
function readTail(file, maxBytes) {
  let fd;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    fd = fs.openSync(file, 'r');
    const size = st.size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, start);
    return { buf: buf.subarray(0, got), truncated: start > 0, size };
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (e) { /* 收尾互不阻塞 */ }
    }
  }
}

/** 读文件头部 maxBytes 字节（标题取首条用户消息用） */
function readHead(file, maxBytes) {
  let fd;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, 0);
    return { buf: buf.subarray(0, got), truncated: st.size > maxBytes, size: st.size };
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (e) { /* 收尾互不阻塞 */ }
    }
  }
}

/** JSONL 缓冲 → 逐行 try-parse（截断头的首行丢弃，防半行 JSON） */
function parseJsonlBuffer(r) {
  if (!r) return [];
  let text = r.buf.toString('utf8');
  if (r.truncated) {
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1);
    else return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch (e) { /* 半行/非 JSON 行跳过 */ }
  }
  return out;
}

/** 从一条 JSONL 记录提取人类可读文本（claude/dsh 家族通用：content/lastPrompt/message/text） */
function extractLineText(o) {
  if (!isPlainObject(o)) return null;
  if (typeof o.content === 'string' && o.content.trim()) return o.content;
  if (typeof o.lastPrompt === 'string' && o.lastPrompt.trim()) return o.lastPrompt;
  const m = o.message;
  if (typeof m === 'string' && m.trim()) return m;
  if (isPlainObject(m)) {
    if (typeof m.content === 'string' && m.content.trim()) return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content
        .filter((b) => isPlainObject(b) && typeof b.text === 'string' && b.text.trim())
        .map((b) => b.text)
        .join(' ');
      if (t.trim()) return t;
    }
  }
  if (typeof o.text === 'string' && o.text.trim()) return o.text;
  return null;
}

/** 从 JSONL 记录数组中取最后一条有文本的记录文本 */
function lastText(objs) {
  for (let i = objs.length - 1; i >= 0; i--) {
    const t = extractLineText(objs[i]);
    if (t) return t;
  }
  return null;
}

/** 取第一条有文本的记录文本 */
function firstText(objs) {
  for (const o of objs) {
    const t = extractLineText(o);
    if (t) return t;
  }
  return null;
}

/** tail 缓冲里抓最后一个 "cwd":"..." 字段值（claude jsonl 家族；JSON 转义反转） */
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

/**
 * 编码项目目录名 → 项目路径（尽力解码）。实测 dsh 编码：不安全字符 → `~HEX4`（仅前导波浪号，
 * 连续转义共享分隔，如 `开发` → `~5F00~53D1`），路径分隔符 → `-`，目录名两端 `--` 包裹；
 * 首段单字符视作 Windows 盘符。claude 的编码对项目名里的 `-` 有歧义（有损），
 * 仅作 cwd 字段缺失时的兜底。
 */
function decodeProjectDirName(name) {
  if (typeof name !== 'string' || !name) return '';
  const decoded = name.replace(/~([0-9A-Fa-f]{4})/g, (_, h) => {
    try { return String.fromCharCode(parseInt(h, 16)); } catch (e) { return '-'; }
  });
  const trimmed = decoded.replace(/^-+|-+$/g, '');
  const segs = trimmed.split('-').filter((s) => s.length > 0);
  if (segs.length === 0) return '';
  if (segs[0].length === 1 && segs.length > 1) return `${segs[0]}:\\${segs.slice(1).join('\\')}`;
  return segs.join(path.sep);
}

function toIso(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return null;
  try {
    return new Date(t).toISOString();
  } catch (e) {
    return null;
  }
}

function toIsoFromValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return toIso(v < 1e12 ? v * 1000 : v); // 秒/毫秒自适应
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && /^\d+$/.test(v.trim())) return toIso(n < 1e12 ? n * 1000 : n);
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/** 最近活动距今 < ACTIVE_WINDOW_MS 视作运行中 */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

function stateFor(lastActiveMs, now, explicit) {
  if (typeof explicit === 'string' && explicit) return explicit;
  if (Number.isFinite(lastActiveMs) && now - lastActiveMs >= 0 && now - lastActiveMs < ACTIVE_WINDOW_MS) {
    return 'active';
  }
  return 'idle';
}

/** 统一条目形状（缺字段容错 + preview/title 截断）；id=来源会话标识（workbuddy 透传主键，其余源暂空） */
function makeItem(partial, opts) {
  const o = partial || {};
  const previewChars = (opts && opts.previewChars) || 200;
  const now = (opts && opts.now) || Date.now();
  const lastMs = o.lastActiveMs;
  const item = {
    id: String(o.id || ''),
    agent: String(o.agent || ''),
    agentName: String(o.agentName || o.agent || ''),
    projectId: typeof o.projectId === 'string' ? o.projectId : '',
    title: truncateOneLine(o.title || '', 80),
    preview: truncateOneLine(o.preview || '', previewChars),
    startedAt: toIso(o.startedMs) || toIso(lastMs) || toIso(now),
    lastActiveAt: toIso(lastMs) || toIso(now),
    state: stateFor(lastMs, now, o.state),
  };
  // v2.3（D5）：可回查源增可选 ref（不透明引用，lib/sessionRef.js 编码）——无则不出键，形状兼容
  if (typeof o.ref === 'string' && o.ref) item.ref = o.ref;
  return item;
}

/** 目录 mtime（不存在返回 null） */
function dirMtime(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch (e) {
    return null;
  }
}

/** 目录是否存在 */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

// ---------- 适配器①：ZCode（~/.zcode/cli） ----------

/**
 * ZCode 新版把会话迁进 db/db.sqlite（session 表与 opencode 同构），旧的 sess_* 目录只剩残留。
 * 只 SELECT session 表所需列（凭据红线：不碰 message/part 之外的任何表也不写库）。
 * 返回 null = 该库不可用（无 node:sqlite / 打不开 / 查询失败），由文件兜底。
 */
function zcodeDbItems(dbPath, limit, opts) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return null;
  }
  try {
    let rows;
    try {
      rows = db
        .prepare(
          'SELECT id, directory, title, time_created, time_updated, last_outcome FROM session WHERE time_deleted IS NULL ORDER BY time_updated DESC LIMIT ?'
        )
        .all(limit);
    } catch (e) {
      // 老库无 time_deleted/last_outcome 列 → 退到最小列集
      rows = db
        .prepare('SELECT id, directory, title, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT ?')
        .all(limit);
    }
    return (Array.isArray(rows) ? rows : []).map((r) =>
      makeItem(
        {
          id: String(r.id === null || r.id === undefined ? '' : r.id),
          agent: 'zcode',
          agentName: 'ZCode',
          projectId: typeof r.directory === 'string' ? r.directory : '',
          title: (typeof r.title === 'string' && r.title.trim()) || `ZCode 会话 ${String(r.id || '').slice(0, 8)}`,
          preview: '',
          startedMs: r.time_created,
          lastActiveMs: r.time_updated,
          // v2.9.21 合并修正：last_outcome 为空（运行中/未知）不传 explicit，stateFor 按时间窗判 active——
          // 远端原实现强制 idle 会把正在工作的 ZCode 打回「空闲」（业主最初报的缺陷回归）
          state: r.last_outcome === 'error' ? 'failed' : r.last_outcome === 'completed' ? 'completed' : undefined,
          ref: refOf({ s: 'zcode', k: 'session', v: { id: String(r.id === null || r.id === undefined ? '' : r.id) } }),
        },
        opts
      )
    );
  } catch (e) {
    return null;
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

/**
 * zcode：db.sqlite 为主、旧 sess_* 目录兜底（两者同 id 视作同一会话，db 优先）。
 * 旧格式（无 db 目录 / db 打不开 / 空库）行为与原实现完全一致。
 */
function zcodeAdapter(sourceCfg, opts) {
  const limit = (opts && opts.limit) || 10;
  // 测试注入缝（v2.9.21 合并保留）：opts.listSessions(sourceCfg, limit) → { ok, detail, rows }，
  // 行形状 = db session 表列；提供时跳过 db/目录双源（AGENTS.md 坑 5：测试不建 sqlite 夹具）
  const injected = opts && typeof opts.listSessions === 'function' ? opts.listSessions(sourceCfg, limit) : null;
  if (injected) {
    if (!injected || injected.ok === false) return { ok: false, detail: (injected && injected.detail) || '会话清单不可用', items: [] };
    const items = (Array.isArray(injected.rows) ? injected.rows : []).map((r) =>
      makeItem(
        {
          id: String(r.id === null || r.id === undefined ? '' : r.id),
          agent: 'zcode',
          agentName: 'ZCode',
          projectId: typeof r.directory === 'string' ? r.directory : '',
          title: (typeof r.title === 'string' && r.title.trim()) || `ZCode 会话 ${String(r.id || '').slice(0, 8)}`,
          preview: '',
          startedMs: r.time_created,
          lastActiveMs: r.time_updated,
          ref: refOf({ s: 'zcode', k: 'session', v: { id: String(r.id === null || r.id === undefined ? '' : r.id) } }),
        },
        opts
      )
    );
    return { ok: true, detail: `${items.length} 会话`, items };
  }
  const root = resolveHome(sourceCfg.root) || defaultRoot('zcode');
  if (!isDir(root)) return { ok: false, detail: `目录不存在: ${root}`, items: [] };

  const legacy = zcodeLegacyAdapter(root, limit, opts);
  const dbPath = path.join(root, 'db', 'db.sqlite');
  if (!fs.existsSync(dbPath)) return legacy;

  const dbItems = zcodeDbItems(dbPath, limit, opts);
  if (!dbItems || dbItems.length === 0) return legacy;

  const seen = new Set(dbItems.map((it) => it.id));
  const merged = dbItems.concat(legacy.items.filter((it) => !seen.has(it.id)));
  merged.sort((a, b) => (Date.parse(b.lastActiveAt) || 0) - (Date.parse(a.lastActiveAt) || 0));
  return { ok: true, detail: `${merged.length} 会话`, items: merged.slice(0, limit) };
}

/**
 * sess_* 目录散布在 root/sess_*、root/agents/sess_*、root/exec/sess_*（同 id 视作同一会话合并）。
 * 标题/项目：agents 下 agent_N 目录 metadata.json 的 description/cwd/createdAt（实测含中文描述）；
 * 预览：exec/<id>/ 最新 call_N-stdout.log 尾部（缺则 agent_N 目录 output.txt 尾部）。
 */
function zcodeLegacyAdapter(root, limit, opts) {
  const candidates = new Map(); // sessId → { dirs:[], mtimeMs }
  const scanDir = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith('sess_')) continue;
      const full = path.join(dir, ent.name);
      const mt = dirMtime(full);
      const prev = candidates.get(ent.name) || { dirs: [], mtimeMs: 0 };
      prev.dirs.push(full);
      if (mt !== null && mt > prev.mtimeMs) prev.mtimeMs = mt;
      candidates.set(ent.name, prev);
    }
  };
  scanDir(root);
  scanDir(path.join(root, 'agents'));
  scanDir(path.join(root, 'exec'));

  const sorted = [...candidates.entries()].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs).slice(0, limit);

  const items = [];
  for (const [sessId, info] of sorted) {
    const agentsDir = path.join(root, 'agents', sessId);
    const execDir = path.join(root, 'exec', sessId);

    // 元数据：agents/<id>/agent_*/metadata.json（取 mtime 最新的一个）
    let meta = null;
    let newestAgentDir = null;
    let newestAgentMtime = -1;
    try {
      for (const ent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !ent.name.startsWith('agent_')) continue;
        const ad = path.join(agentsDir, ent.name);
        const mt = dirMtime(ad);
        if (mt !== null && mt > newestAgentMtime) {
          newestAgentMtime = mt;
          newestAgentDir = ad;
        }
      }
    } catch (e) { /* 无 agents 目录 */ }
    if (newestAgentDir) {
      const r = readHead(path.join(newestAgentDir, 'metadata.json'), 64 * 1024);
      if (r) {
        try {
          meta = JSON.parse(r.buf.toString('utf8'));
        } catch (e) { /* 半截元数据容错 */ }
      }
    }

    // 预览：exec/<id>/ 最新 call_*-stdout.log 尾部 → 兜底 agent_*/output.txt 尾部
    let previewText = null;
    const execFiles = [];
    try {
      for (const ent of fs.readdirSync(execDir, { withFileTypes: true })) {
        if (ent.isFile() && ent.name.startsWith('call_') && ent.name.endsWith('.log')) {
          const f = path.join(execDir, ent.name);
          try {
            execFiles.push({ f, mt: fs.statSync(f).mtimeMs });
          } catch (e) { /* 竞态删除容忍 */ }
        }
      }
    } catch (e) { /* 无 exec 目录 */ }
    execFiles.sort((a, b) => b.mt - a.mt);
    if (execFiles.length > 0) {
      const r = readTail(execFiles[0].f, 4 * 1024);
      if (r) {
        const lines = r.buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0) previewText = lines[lines.length - 1];
      }
    }
    if (previewText === null && newestAgentDir) {
      const r = readTail(path.join(newestAgentDir, 'output.txt'), 4 * 1024);
      if (r) {
        const lines = r.buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0) previewText = lines[lines.length - 1];
      }
    }

    const core = sessId.replace(/^sess_/, '').replace(/^subagent_agent_/, 'subagent-');
    const shortId = core.slice(0, 8);
    const metaCwd = meta && typeof meta.cwd === 'string' ? meta.cwd : '';
    const metaDesc = meta && typeof meta.description === 'string' && meta.description.trim() ? meta.description : '';
    items.push(
      makeItem(
        {
          agent: 'zcode',
          agentName: 'ZCode',
          id: sessId, // v2.3 spike R1：db.sqlite session.id 与目录名同名同形（db 为超集），透传即回查主键
          projectId: metaCwd,
          title: metaDesc || `ZCode 会话 ${shortId}`,
          preview: previewText || '',
          startedMs: meta && meta.createdAt ? Date.parse(meta.createdAt) : info.mtimeMs,
          lastActiveMs: info.mtimeMs,
          ref: refOf({ s: 'zcode', k: 'session', v: { id: sessId } }),
        },
        opts
      )
    );
  }
  return { ok: true, detail: `${items.length} 会话`, items };
}

// ---------- 适配器②：claude（~/.claude/projects） ----------

/** <编码项目路径>/*.jsonl，mtime 排序取最近 N；标题=首条有文本行，预览=末条有文本行，项目=文件内 cwd */
function claudeAdapter(sourceCfg, opts) {
  const limit = (opts && opts.limit) || 10;
  const root = resolveHome(sourceCfg.root) || defaultRoot('claude');
  if (!isDir(root)) return { ok: false, detail: `目录不存在: ${root}`, items: [] };

  const files = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    return { ok: false, detail: `目录读取失败: ${e.message}`, items: [] };
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
      const full = path.join(pdir, ent.name);
      try {
        const st = fs.statSync(full);
        files.push({ full, dirName: pd.name, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, size: st.size });
      } catch (e) { /* 竞态删除容忍 */ }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const items = [];
  for (const f of files.slice(0, limit)) {
    const head = parseJsonlBuffer(readHead(f.full, 32 * 1024));
    const tail = parseJsonlBuffer(readTail(f.full, 32 * 1024));
    const titleText = firstText(head);
    const previewText = lastText(tail);
    const cwd = cwdFromBuffer(readTail(f.full, 32 * 1024)) || decodeProjectDirName(f.dirName);
    const sessionId = (f.full.match(/([0-9a-f-]{16,})\.jsonl$/i) || [])[1] || path.basename(f.full, '.jsonl');
    items.push(
      makeItem(
        {
          agent: 'claude',
          agentName: 'claude',
          id: sessionId,
          projectId: cwd,
          title: titleText || `claude 会话 ${sessionId.slice(0, 8)}`,
          preview: previewText || '',
          startedMs: f.birthtimeMs,
          lastActiveMs: f.mtimeMs,
          ref: refOf({ s: 'claude', k: 'project', v: { dir: f.dirName, file: path.basename(f.full) } }),
        },
        opts
      )
    );
  }
  return { ok: true, detail: `${items.length} 会话`, items };
}

// ---------- 适配器③：dsh（~/.dsh/sessions） ----------

const DSH_ZSTD_CAP = 8 * 1024 * 1024; // 超过 8MB 的 zstd 不解压（预览留空，条目照常输出）

/** dsh 解压单文件 → {header, previewText}；zstd 不可用/超限/损坏降级为 null 字段 */
function dshDecompressSession(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return {};
  }
  if (st.size > DSH_ZSTD_CAP) return {};
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return {};
  }
  let out;
  try {
    out = zlib.zstdDecompressSync(buf);
  } catch (e) {
    return {}; // 非 zstd/损坏 → 降级，不致命
  }
  const lines = out.toString('utf8').split('\n');
  let header = null;
  let previewText = null;
  for (let i = 0; i < lines.length && i < 5; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    try {
      header = JSON.parse(t);
      break;
    } catch (e) { /* 首行半截继续 */ }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.type === 'session') continue; // 元数据行不当预览
      const txt = extractLineText(o);
      if (txt) {
        previewText = txt;
        break;
      }
    } catch (e) { /* 跳过坏行 */ }
  }
  return { header, previewText };
}

/**
 * <编码项目路径> 下 session-N 目录内 sessionN.jsonl.zstd（实测；zstd 解压读首行元数据 cwd/createdAt）
 * + 兼容 rollout-N.jsonl 明文（briefing 情报的旧布局，向前兼容不破坏）。
 */
function dshAdapter(sourceCfg, opts) {
  const limit = (opts && opts.limit) || 10;
  const root = resolveHome(sourceCfg.root) || defaultRoot('dsh');
  if (!isDir(root)) return { ok: false, detail: `目录不存在: ${root}`, items: [] };

  const files = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    return { ok: false, detail: `目录读取失败: ${e.message}`, items: [] };
  }
  for (const pd of projectDirs) {
    const pdir = path.join(root, pd.name);
    let entries;
    try {
      entries = fs.readdirSync(pdir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    // 两层布局兼容：rollout-*.jsonl 直接位于项目目录（旧年/月/日布局）或 session-N 目录
    for (const ent of entries) {
      if (ent.isFile() && /^rollout-.*\.jsonl$/.test(ent.name)) {
        const full = path.join(pdir, ent.name);
        try {
          const st = fs.statSync(full);
          files.push({
            full,
            dirName: pd.name,
            sessDirName: pd.name,
            kind: 'rollout',
            mtimeMs: st.mtimeMs,
            birthtimeMs: st.birthtimeMs,
          });
        } catch (e) { /* 竞态删除容忍 */ }
        continue;
      }
      if (!ent.isDirectory()) continue;
      const sdir = path.join(pdir, ent.name);
      let inner;
      try {
        inner = fs.readdirSync(sdir, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const f2 of inner) {
        if (!f2.isFile()) continue;
        const isZstd = /^session.*\.jsonl\.zstd$/.test(f2.name);
        const isRollout = /^rollout-.*\.jsonl$/.test(f2.name);
        if (!isZstd && !isRollout) continue;
        const full = path.join(sdir, f2.name);
        try {
          const st = fs.statSync(full);
          files.push({
            full,
            dirName: pd.name,
            sessDirName: ent.name,
            kind: isZstd ? 'zstd' : 'rollout',
            mtimeMs: st.mtimeMs,
            birthtimeMs: st.birthtimeMs,
          });
        } catch (e) { /* 竞态删除容忍 */ }
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const items = [];
  for (const f of files.slice(0, limit)) {
    let header = null;
    let previewText = null;
    if (f.kind === 'zstd') {
      ({ header = null, previewText = null } = dshDecompressSession(f.full));
    } else {
      const head = parseJsonlBuffer(readHead(f.full, 32 * 1024));
      const tail = parseJsonlBuffer(readTail(f.full, 32 * 1024));
      header = head[0] || null;
      previewText = lastText(tail);
    }
    const cwd =
      (header && typeof header.cwd === 'string' && header.cwd) || decodeProjectDirName(f.dirName);
    const m = f.sessDirName.match(/session-([0-9a-f-]+)/i);
    const shortId = (m ? m[1] : f.sessDirName).slice(0, 8);
    items.push(
      makeItem(
        {
          agent: 'dsh',
          agentName: 'DSH',
          id: f.full, // v2.3：全文回查主键 = 相对路径（locator file.path）
          projectId: cwd,
          title: `DSH 会话 ${shortId}`,
          preview: previewText || '',
          startedMs: header && Number.isFinite(header.createdAt) ? header.createdAt : f.birthtimeMs,
          lastActiveMs: f.mtimeMs,
          ref: refOf({
            s: 'dsh',
            k: 'file',
            v: { path: path.relative(root, f.full).split(path.sep).join('/') },
          }),
        },
        opts
      )
    );
  }
  return { ok: true, detail: `${items.length} 会话`, items };
}

// ---------- 适配器④：WorkBuddy（~/.workbuddy/workbuddy.db，node:sqlite 只读） ----------

const WORKBUDDY_STATE_MAP = {
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

/** 仅 SELECT sessions 表所需列；{readOnly:true} 打开（实测可用）；node:sqlite 缺位降级 ok:false */
function workbuddyAdapter(sourceCfg, opts) {
  const limit = (opts && opts.limit) || 10;
  const dbPath = resolveHome(sourceCfg.dbPath) || defaultRoot('workbuddy');
  if (!fs.existsSync(dbPath)) return { ok: false, detail: `数据库不存在: ${dbPath}`, items: [] };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    return { ok: false, detail: `node:sqlite 不可用: ${e.message}`, items: [] };
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return { ok: false, detail: `数据库打开失败（只读）: ${e.message}`, items: [] };
  }

  try {
    const rows = db
      .prepare(
        'SELECT id, cwd, title, status, created_at, last_activity_at FROM sessions ORDER BY last_activity_at DESC LIMIT ?'
      )
      .all(limit);
    const items = (Array.isArray(rows) ? rows : []).map((r) =>
      makeItem(
        {
          id: String(r.id === null || r.id === undefined ? '' : r.id),
          agent: 'workbuddy',
          agentName: 'WorkBuddy',
          projectId: typeof r.cwd === 'string' ? r.cwd : '',
          title: (typeof r.title === 'string' && r.title.trim()) || `WorkBuddy 会话 ${String(r.id || '').slice(0, 8)}`,
          preview: '', // 凭据红线：只 SELECT sessions 表所需列，不读消息表
          startedMs: r.created_at,
          lastActiveMs: r.last_activity_at,
          state: WORKBUDDY_STATE_MAP[String(r.status || '').toLowerCase()] || 'idle',
          ref: refOf({ s: 'workbuddy', k: 'session', v: { id: String(r.id === null || r.id === undefined ? '' : r.id) } }),
        },
        opts
      )
    );
    return { ok: true, detail: `${items.length} 会话`, items };
  } catch (e) {
    return { ok: false, detail: `sessions 查询失败: ${e.message}`, items: [] };
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

// ---------- 适配器⑤：codex（~/.codex/sessions，ChatGPT 桌面 rollout 会话；v2.6 桌面成员册专用） ----------

/** 列子目录（withFileTypes 过滤 isDirectory；异常返回 []） */
function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    return [];
  }
}

/** codex rollout payload → 人类可读文本：content 数组各元素 .text 拼接 / message 字符串；取不到返回 null */
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

/** codex 会话开头常被注入环境上下文（<environment_context>/<INSTRUCTIONS>/AGENTS.md 说明），不能当标题 */
const CODEX_INJECTED_PREFIX = /^\s*(?:<environment_context>|<INSTRUCTIONS>|# AGENTS\.md instructions|# Files mentioned by the user:)/i;

/** codex head 记录中首条 user response_item 的文本（跳过注入上下文；全是注入时返回 null 交给 id 兜底） */
function codexUserText(objs) {
  for (const o of objs) {
    if (
      o &&
      o.type === 'response_item' &&
      isPlainObject(o.payload) &&
      o.payload.type === 'message' &&
      o.payload.role === 'user'
    ) {
      const t = codexTextOf(o.payload);
      if (!t) continue;
      if (!CODEX_INJECTED_PREFIX.test(t)) return t;
    }
  }
  return null;
}

/** codex tail 记录倒序取最后一条文本（跳过 session_meta/turn_context/world_state 元数据行） */
function codexLastText(objs) {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o && (o.type === 'session_meta' || o.type === 'turn_context' || o.type === 'world_state')) continue;
    const t = codexTextOf(o && o.payload);
    if (t) return t;
  }
  return null;
}

/**
 * root/YYYY/MM/DD/rollout-*.jsonl，mtime 排序取最近 N；首行 session_meta 提供 id/cwd/timestamp。
 * 标题 = 首条 user response_item 文本，预览 = 尾部最后一条文本。v2.9.14 起进 ADAPTERS（活动面板第五源）。
 */
function codexAdapter(sourceCfg, opts) {
  const limit = (opts && opts.limit) || 10;
  const root = resolveHome(sourceCfg.root) || defaultRoot('codex');
  if (!isDir(root)) return { ok: false, detail: `目录不存在: ${root}`, items: [] };
  const files = [];
  let yearDirs;
  try { yearDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (e) { return { ok: false, detail: `目录读取失败: ${e.message}`, items: [] }; }
  for (const yd of yearDirs) {
    for (const md of listDirs(path.join(root, yd.name))) {
      for (const dd of listDirs(path.join(root, yd.name, md.name))) {
        const dayDir = path.join(root, yd.name, md.name, dd.name);
        let entries;
        try { entries = fs.readdirSync(dayDir, { withFileTypes: true }); } catch (e) { continue; }
        for (const ent of entries) {
          if (!ent.isFile() || !/^rollout-.*\.jsonl$/.test(ent.name)) continue;
          const full = path.join(dayDir, ent.name);
          try { const st = fs.statSync(full); files.push({ full, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs }); } catch (e) { /* 竞态删除容忍 */ }
        }
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const items = [];
  for (const f of files.slice(0, limit)) {
    const head = parseJsonlBuffer(readHead(f.full, 256 * 1024));
    const metaRec = head.find((o) => o && o.type === 'session_meta' && isPlainObject(o.payload));
    const meta = (metaRec && metaRec.payload) || {};
    const title = codexUserText(head) || `Codex 会话 ${String(meta.id || meta.session_id || '').slice(0, 8)}`;
    const preview = codexLastText(parseJsonlBuffer(readTail(f.full, 32 * 1024)));
    items.push(makeItem({
      id: String(meta.id || meta.session_id || ''),
      agent: 'codex',
      agentName: 'Codex (ChatGPT 桌面)',
      projectId: typeof meta.cwd === 'string' ? meta.cwd : '',
      title,
      preview: preview || '',
      startedMs: Date.parse(meta.timestamp) || f.birthtimeMs,
      lastActiveMs: f.mtimeMs,
      ref: refOf({ s: 'codex', k: 'file', v: { path: path.relative(root, f.full).split(path.sep).join('/') } }),
    }, opts));
  }
  return { ok: true, detail: `${items.length} 会话`, items };
}

// ---------- 适配器⑥：opencode（~/.local/share/opencode/opencode.db，node:sqlite 只读；v2.6 桌面成员册专用） ----------

/** 仅 SELECT session 表五列（凭据红线不碰 account/credential 等其余表）；node:sqlite 缺位降级 ok:false */
function opencodeAdapter(sourceCfg, opts) {
  const limit = (opts && opts.limit) || 10;
  const dbPath = resolveHome(sourceCfg.dbPath) || defaultRoot('opencode');
  if (!fs.existsSync(dbPath)) return { ok: false, detail: `数据库不存在: ${dbPath}`, items: [] };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { return { ok: false, detail: `node:sqlite 不可用: ${e.message}`, items: [] }; }
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (e) { return { ok: false, detail: `数据库打开失败（只读）: ${e.message}`, items: [] }; }
  try {
    // 凭据红线：仅 SELECT session 表五列，不碰 account/credential 等其余表
    const rows = db
      .prepare('SELECT id, directory, title, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT ?')
      .all(limit);
    const items = (Array.isArray(rows) ? rows : []).map((r) =>
      makeItem({
        id: String(r.id === null || r.id === undefined ? '' : r.id),
        agent: 'opencode',
        agentName: 'OpenCode',
        projectId: typeof r.directory === 'string' ? r.directory : '',
        title: (typeof r.title === 'string' && r.title.trim()) || `OpenCode 会话 ${String(r.id || '').slice(0, 8)}`,
        preview: '',
        startedMs: r.time_created,
        lastActiveMs: r.time_updated,
        ref: refOf({ s: 'opencode', k: 'session', v: { id: String(r.id === null || r.id === undefined ? '' : r.id) } }),
      }, opts)
    );
    return { ok: true, detail: `${items.length} 会话`, items };
  } catch (e) {
    return { ok: false, detail: `session 查询失败: ${e.message}`, items: [] };
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

// ---------- 聚合 ----------

const ADAPTERS = {
  zcode: zcodeAdapter,
  claude: claudeAdapter,
  dsh: dshAdapter,
  workbuddy: workbuddyAdapter,
  codex: codexAdapter,
};

/**
 * aggregateAgentActivity(config, opts)
 *   config 全量配置（读 config.agentActivity 节，缺省回默认）；
 *   opts.agent  过滤（agent id 精确匹配，忽略大小写）；
 *   opts.now    时间原点（测试注入）。
 * → { items:[{id,agent,agentName,projectId,title,preview,startedAt,lastActiveAt,state}],
 *     sources:[{id,ok,detail}], checkedAt }
 */
function aggregateAgentActivity(config, opts) {
  const o = opts || {};
  const sec = normalizeAgentActivity(isPlainObject(config) ? config.agentActivity : null);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const sources = [];
  const items = [];

  for (const id of SOURCE_IDS) {
    const s = sec.sources[id] || {};
    if (sec.enabled === false || s.enabled === false) {
      sources.push({ id, ok: false, detail: 'disabled（未启用）' });
      continue;
    }
    try {
      const r = ADAPTERS[id](s, { limit: sec.perSourceLimit, previewChars: sec.previewChars, now });
      sources.push({ id, ok: r.ok !== false, detail: r.detail || '' });
      if (Array.isArray(r.items)) items.push(...r.items);
    } catch (e) {
      // 单源故障隔离：记录后继续下一源，绝不影响其他源与整体响应
      sources.push({ id, ok: false, detail: `适配器异常: ${(e && e.message) || e}` });
    }
  }

  items.sort((a, b) => {
    const ta = Date.parse(a.lastActiveAt) || 0;
    const tb = Date.parse(b.lastActiveAt) || 0;
    return tb - ta;
  });
  let out = items.slice(0, sec.maxItems);
  const agent = typeof o.agent === 'string' ? o.agent.trim().toLowerCase() : '';
  if (agent) out = out.filter((it) => String(it.agent).toLowerCase() === agent);

  // v2.2 契约补齐：allOk = 全部启用源探测成功（前端健康徽标备用品；当前徽标用 sources 计数）
  const allOk = sources.length > 0 && sources.every((s) => s.ok);
  return { allOk, items: out, sources, checkedAt: new Date(now).toISOString() };
}

// ---------- 路由挂载 ----------

/** GET /api/agent-activity（?agent= 过滤）— 独立版/插件态经 appAssembler 同源生效 */
function registerAgentActivityRoutes(router, ctx) {
  const { sendJSON } = require('./router');
  router.add('GET', '/api/agent-activity', (c) => {
    sendJSON(c.res, 200, aggregateAgentActivity(ctx.config, { agent: c.query.get('agent') || '' }));
  });
}

/**
 * hermes（2026-11-03 第七源，opencode 同款待遇）：%LOCALAPPDATA%/hermes/state.db sessions 表
 * （明文 SQLite，只读；活库带 auto-maintenance lock——readOnly 打开+失败按源故障返回，绝不写）。
 * 时间戳 Unix 秒浮点（×1000 转 ms）；archived/hidden 会话出局；title 为 LLM 生成。
 * 测试注入缝与 zcode 同款：opts.listSessions(sourceCfg, limit) → { ok, detail, rows }。
 */
function hermesAdapter(sourceCfg, opts) {
  const limit = (opts && opts.limit) || 10;
  const secToMs = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
  };
  const mapRow = (r) =>
    makeItem(
      {
        id: String(r.id === null || r.id === undefined ? '' : r.id),
        agent: 'hermes',
        agentName: 'Hermes',
        projectId: typeof r.cwd === 'string' ? r.cwd : '',
        title: (typeof r.title === 'string' && r.title.trim()) || `Hermes 会话 ${String(r.id || '').slice(0, 8)}`,
        preview: '',
        startedMs: secToMs(r.started_at),
        lastActiveMs: secToMs(r.last_activity_at),
        ref: refOf({ s: 'hermes', k: 'session', v: { id: String(r.id === null || r.id === undefined ? '' : r.id) } }),
      },
      opts
    );
  // 测试注入缝（AGENTS.md 坑 5：sqlite 夹具走注入，不落 fs 夹具）
  const injected = opts && typeof opts.listSessions === 'function' ? opts.listSessions(sourceCfg, limit) : null;
  if (injected) {
    if (injected.ok === false) return { ok: false, detail: injected.detail || '会话清单不可用', items: [] };
    const items = (Array.isArray(injected.rows) ? injected.rows : []).map(mapRow);
    return { ok: true, detail: `${items.length} 会话`, items };
  }
  const dbPath = resolveHome(sourceCfg.dbPath) || defaultRoot('hermes');
  if (!fs.existsSync(dbPath)) return { ok: false, detail: `数据库不存在: ${dbPath}`, items: [] };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    return { ok: false, detail: `node:sqlite 不可用: ${e.message}`, items: [] };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return { ok: false, detail: `数据库打开失败（只读）: ${e.message}`, items: [] };
  }
  try {
    const rows = db
      .prepare(
        'SELECT id, title, cwd, started_at, last_activity_at FROM sessions WHERE archived = 0 AND hidden = 0 ' +
          'ORDER BY last_activity_at DESC LIMIT ?'
      )
      .all(limit);
    const items = (Array.isArray(rows) ? rows : []).map(mapRow);
    return { ok: true, detail: `${items.length} 会话`, items };
  } catch (e) {
    return { ok: false, detail: `sessions 查询失败: ${e.message}`, items: [] };
  } finally {
    try { db.close(); } catch (e) { /* 收尾互不阻塞 */ }
  }
}

module.exports = {
  DEFAULT_AGENT_ACTIVITY,
  SOURCE_IDS,
  ALL_SOURCE_IDS,
  normalizeAgentActivity,
  aggregateAgentActivity,
  registerAgentActivityRoutes,
  // 适配器单测直通
  zcodeAdapter,
  claudeAdapter,
  dshAdapter,
  workbuddyAdapter,
  codexAdapter,
  opencodeAdapter,
  hermesAdapter,
  // 工具导出（测试复用）
  decodeProjectDirName,
  truncateOneLine,
  // v2.3 会话阅读器复用（lib/agentTranscript.js；避免同款实现两份漂移）
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
  refOf,
};
