'use strict';

/**
 * sessionRef.js — 会话不透明引用（SPEC-READER v2.3 D1）：编解码 + 双闸校验单一收口
 *
 * 结构：base64url(JSON {s:源 id, k:locator 种类, v:locator 对象})。仅后端构造，出现在
 * 会话列表条目、activity 条目（可选 ref）中；客户端永不持有原始路径，穿越面收口到本模块。
 *
 * 校验流水线（§3.3，任一不过 → HttpError 400 BAD_REF，错误信息一律不回显解析后路径）：
 *   ① base64url + JSON 解码；
 *   ② s ∈ 六源、k ∈ 该源 locator 白名单；
 *   ③ v 逐字段过白名单正则（形态见 §3.4 映射表 + §10 spike 回写：zcode id 实测含
 *      sess_<uuid> / session_<hex32> / sess_subagent_agent_<uuid> 三形态，与目录名同名同形）；
 *   ④ 路径类 locator（claude/dsh/codex）：path.resolve 后 realpath 必须 startsWith 对应源根
 *     （config.agentActivity.sources.*.root 推导）；文件不存在同样按 BAD_REF 处理（规格字面：
 *      realpath 任一不过 → 400；id 类 locator 不触 fs，无此闸）；
 *   ⑤ 无状态、不落库、无失效问题。
 *
 * 红线：本模块对任何源零写入；绝不把解码后的 v 原文拼进错误消息（防探测）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./router');

const SOURCE_IDS = ['zcode', 'claude', 'dsh', 'codex', 'opencode', 'workbuddy', 'hermes'];

/** 各源 locator 种类白名单（§3.4） */
const LOCATOR_KINDS = {
  zcode: ['session'],
  claude: ['project'],
  dsh: ['file'],
  codex: ['file'],
  opencode: ['session'],
  workbuddy: ['session'],
  hermes: ['session'],
};

// ---------- 各源 locator 字段正则（§3.4 + spike R1 回写） ----------

/** zcode session id 实测三形态：sess_<uuid> / session_<hex32> / sess_subagent_agent_<uuid>（R1） */
const ZCODE_ID_RE = /^(?:sess(?:_subagent_agent)?|session)_[0-9a-f][0-9a-f-]{7,120}$/i;
/** opencode session id 实测形态：ses_ + 24 位大小写字母数字（spike 回写：非 uuid） */
const OPENCODE_ID_RE = /^ses_[A-Za-z0-9]{8,64}$/;
/** workbuddy session id：sessions 表主键（保守字符集，杜绝路径/SQL 元字符） */
const WORKBUDDY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** hermes session id：20261018_223147_c80c5b 形态（sessions 表主键；与 workbuddy 同款保守字符集） */
const HERMES_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** claude：项目编码目录名（无路径分隔符）+ <uuid>.jsonl 文件名 */
const CLAUDE_DIR_RE = /^[^\\/]{1,200}$/;
const CLAUDE_FILE_RE = /^[0-9a-f][0-9a-f-]{15,120}\.jsonl$/i;
/** dsh：相对路径（正斜杠或反斜杠段），末段 session*.jsonl.zstd 或 rollout-*.jsonl（明文分支同构） */
const DSH_BASENAME_RE = /^(?:session[^\\/]*\.jsonl\.zstd|rollout-[^\\/]*\.jsonl)$/;
/** codex：YYYY/MM/DD/rollout-*.jsonl */
const CODEX_SEG_RE = { y: /^\d{4}$/, m: /^\d{2}$/, d: /^\d{2}$/, f: /^rollout-[^\\/]{1,160}\.jsonl$/ };

const BAD_REF_MSG = '会话引用非法';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validString(v, re) {
  return typeof v === 'string' && v.length > 0 && re.test(v);
}

/** 相对路径段通用闸：禁 .. 段、禁盘符、禁绝对/UNC 路径、段数与单段长度受限 */
function safeRelativeSegments(relPath, maxSegs) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 600) return null;
  if (/^[A-Za-z]:/.test(relPath)) return null; // 盘符
  if (/^[\\/]/.test(relPath)) return null; // 绝对路径 / UNC（\\srv\share）
  const segs = relPath.split(/[\\/]/).filter((s) => s.length > 0);
  if (segs.length === 0 || segs.length > maxSegs) return null;
  for (const s of segs) {
    if (s === '.' || s === '..') return null;
  }
  return segs;
}

/** base64url 编码（无填充） */
function encodeRef(locator) {
  return Buffer.from(JSON.stringify(locator), 'utf8').toString('base64url');
}

/** 解码（不抛错）：非法返回 null；只做形状浅检，白名单校验在 validateRef */
function decodeRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 1024) return null;
  let json;
  try {
    json = Buffer.from(ref, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
  let o;
  try {
    o = JSON.parse(json);
  } catch (e) {
    return null;
  }
  if (!isPlainObject(o)) return null;
  if (typeof o.s !== 'string' || typeof o.k !== 'string' || !isPlainObject(o.v)) return null;
  return o;
}

/**
 * 双闸校验单一收口：非法一律 throw HttpError(400,'BAD_REF')，合法返回 {s,k,v}。
 * cfg：全量 config（读 config.agentActivity.sources.*.root 推导源根）。
 */
function validateRef(ref, cfg) {
  const loc = decodeRef(ref);
  if (!loc) throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
  const { s, k, v } = loc;
  if (!SOURCE_IDS.includes(s)) throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
  if (!LOCATOR_KINDS[s].includes(k)) throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);

  if (k === 'session') {
    // id 类 locator：仅白名单正则，不触 fs
    const re = s === 'zcode'
      ? ZCODE_ID_RE
      : s === 'opencode'
        ? OPENCODE_ID_RE
        : s === 'hermes'
          ? HERMES_ID_RE
          : WORKBUDDY_ID_RE;
    if (!validString(v.id, re)) throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
    return loc;
  }

  // 路径类 locator
  if (s === 'claude') {
    if (k !== 'project') throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
    if (!validString(v.dir, CLAUDE_DIR_RE) || v.dir === '.' || v.dir === '..') {
      throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
    }
    if (!validString(v.file, CLAUDE_FILE_RE)) throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
    return loc;
  }

  const relPath = typeof v.path === 'string' ? v.path : '';
  if (s === 'dsh') {
    const segs = safeRelativeSegments(relPath, 6);
    if (!segs || !DSH_BASENAME_RE.test(segs[segs.length - 1])) {
      throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
    }
    return loc;
  }
  if (s === 'codex') {
    const segs = safeRelativeSegments(relPath, 4);
    if (
      !segs ||
      segs.length !== 4 ||
      !CODEX_SEG_RE.y.test(segs[0]) ||
      !CODEX_SEG_RE.m.test(segs[1]) ||
      !CODEX_SEG_RE.d.test(segs[2]) ||
      !CODEX_SEG_RE.f.test(segs[3])
    ) {
      throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
    }
    return loc;
  }
  throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
}

/** 六源根路径推导（与 agentActivity.defaultRoot 同口径；dbPath 源无 root 语义返回 ''） */
function sourceRoot(s, cfg) {
  const sec = (cfg && cfg.agentActivity) || {};
  const sc = (sec.sources && sec.sources[s]) || {};
  if (s === 'workbuddy' || s === 'opencode' || s === 'hermes') return ''; // id 类 locator 不触 fs
  const { resolveHome, defaultRoot } = require('./agentActivity');
  return resolveHome(sc.root) || defaultRoot(s);
}

/**
 * 路径类 locator → 绝对路径 + realpath 双闸（包含校验）。
 * 合法返回 { absolute }（realpath 后）；否则 throw 400 BAD_REF。不回显路径。
 */
function resolveLocatorPath(loc, cfg) {
  const { s, k, v } = loc;
  const root = sourceRoot(s, cfg);
  if (!root) throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
  let rel;
  if (s === 'claude') {
    if (k !== 'project') throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
    rel = path.join(v.dir, v.file);
  } else {
    rel = v.path;
  }
  const abs = path.resolve(root, rel);
  // 双闸②：realpath 包含校验（realpath 失败 = 文件缺失/不可达，同样按 BAD_REF，规格字面）
  let realFile;
  let realRoot;
  try {
    realFile = fs.realpathSync(abs);
    realRoot = fs.realpathSync(root);
  } catch (e) {
    throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
  }
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realFile !== realRoot && !realFile.startsWith(rootWithSep)) {
    throw new HttpError(400, 'BAD_REF', BAD_REF_MSG);
  }
  return { absolute: abs };
}

/**
 * 形状预检（不触 fs、不抛错）：activity 适配器发 ref 前用——形状必不过的 locator 不发，
 * 避免活动流出现「一点就 400」的死引用。完整双闸仍以 validateRef/resolveLocatorPath 为准。
 */
function locatorShapeOk(loc) {
  try {
    validateRef(encodeRef(loc), {});
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  SOURCE_IDS,
  LOCATOR_KINDS,
  encodeRef,
  decodeRef,
  validateRef,
  resolveLocatorPath,
  sourceRoot,
  locatorShapeOk,
};
