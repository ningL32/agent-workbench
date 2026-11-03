'use strict';
// giteaClient.js — FDE 指挥台 Gitea 只读客户端（SPEC §3/§4/§5，B3 包）。
// 数据源（真机 Gitea 28.1.0 探针实证）：各仓库 activities/feeds 事件流，op_type 映射到
//   feeds 词表 activity.type：pr/commit/branch_created/branch_deleted（旧三接口
//   /pulls、/commits、/branches 路径已整体退役，不留 fallback）。
// 红线（SPEC §5-③）：
//   - 凭据 key 由 config.gitea.baseUrl 推导：git config --global http.<baseUrl>/.extraheader
//   - 凭据读入后仅存本模块内存变量（credCache），绝不写文件、绝不进子进程 env、绝不进日志
//   - 所有日志/错误出口必经 lib/redact.js 的 redact()
//   - GITEA_FIXTURE 环境变量指向 fixture JSON 时完全替代真实网络（读文件，零请求）

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { redact, registerSecret, setRedactKeys } = require('./redact.js');
const { assertSafeUrl, validateWhitelist } = require('./ssrfGuard.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const REDACTED = '[REDACTED]';

// SPEC §5 config.json 默认值（config.json 由使用者/设置接口维护，缺失时以此兜底）
const DEFAULTS = {
  port: 7788,
  host: '127.0.0.1',
  dataDir: 'data',
  webDir: 'web',
  gitea: {
    baseUrl: 'https://gitea.example.com',
    apiPrefix: '/api/v1',
    org: 'example-org',
    pollIntervalSec: 60,
    staleWarnSec: 14400,
    staleDangerSec: 86400,
    hostWhitelist: ['gitea.example.com'],
    activityTypes: ['pr', 'commit', 'branch_created', 'branch_deleted'],
    feedsLimit: 50,
    maxActivities: 500,
    // v2.9.2 忽略账号（成员册派生排除名单，与 store.DEFAULT_CONFIG.gitea 同步）
    ignoreLogins: ['admin']
  },
  // v2.9 GitHub 组织动态源（lib/githubClient.js 消费；与 store.DEFAULT_CONFIG.github 同步）
  github: {
    enabled: false,
    baseUrl: 'https://api.github.com',
    org: '',
    eventsPages: 3,
    hostWhitelist: ['api.github.com']
  },
  security: {
    allowedProtocols: ['https'],
    credentialSource: 'git-config-extraheader',
    redactKeys: ['Authorization', 'extraheader']
  },
  // v2.9.39 IM 通知（与 store.DEFAULT_CONFIG.im 同步；消费方 lib/imNotify.js）
  im: {
    enabled: false,
    digest: { enabled: false, at: '09:10' },
    events: { review: false, completed: false },
    targets: []
  },
  // v2.9.41 数据备份（与 store.DEFAULT_CONFIG.backup 同步；v2.9.42 起默认关闭）
  backup: {
    enabled: false,
    keep: 14,
    at: '09:05'
  },
  // v2.9.44 知识库学习（与 store.DEFAULT_CONFIG.learn 同步；消费方 lib/learn.js）
  learn: {
    enabled: false,
    root: '',
    scope: ['wiki'],
    exclude: [],
    seeds: ['模型与推理', 'AI 工程', 'Java', 'Agent 开发', 'Python'],
    dailyNew: 1,
    dailyReview: 3,
    minutes: 15,
    engine: { mode: 'auto', timeoutSec: 180, reasoningEffort: 'off', maxTokens: 1200 }
  }
};

// feeds 词表兼容：老三接口时代的词表（commit_pushed/pr_opened/pr_merged）→ feeds 新词表。
// config.json 由使用方维护，历史部署常带老词表——不归一则 mapper 产出的 commit/pr 每轮
// 被 activityTypes 过滤丢弃（现象：轮询 ok:true 但动态永远不更新）。读取与使用两处都归一。
const LEGACY_ACTIVITY_TYPE_MAP = { commit_pushed: 'commit', pr_opened: 'pr', pr_merged: 'pr' };

/** 老词表名映射新词表并去重（保序、未知名原样保留），返回新数组 */
function normalizeActivityTypes(list) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const m = LEGACY_ACTIVITY_TYPE_MAP[t] || t;
    if (!seen.has(m)) { seen.add(m); out.push(m); }
  }
  return out;
}

// ---------------------------------------------------------------- config

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!over || typeof over !== 'object' || Array.isArray(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 读项目根 config.json（不存在/坏 JSON 用 DEFAULTS 兜底），深合并后返回 cfg */
function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config.json'), 'utf8'));
  } catch {
    fileCfg = {};
  }
  const cfg = deepMerge(DEFAULTS, fileCfg);
  cfg.gitea.activityTypes = normalizeActivityTypes(cfg.gitea.activityTypes); // 历史部署老词表归一
  setRedactKeys(cfg.security && cfg.security.redactKeys);
  return cfg;
}

// ------------------------------------------------------------- credential

/** 凭据缓存：gitKey -> value|null。仅内存，进程退出即消失（SPEC §5-③）。 */
const credCache = new Map();

function credentialGitKey(cfg) {
  return `http.${cfg.gitea.baseUrl}/.extraheader`;
}

/**
 * 系统凭据管理器兜底（v2.9.15）：`git credential fill` 走 credential.helper（wincred/manager），
 * 让「配置里零明文」的部署也能用指挥台——凭据由 OS 保管，不再写进 ~/.gitconfig 的 extraheader。
 * 该写法与 git push 共用同一份凭据，不会出现「两个 Authorization 头打架」。
 * 失败/未配置/无 helper 一律返回 null；GIT_TERMINAL_PROMPT=0 保证绝不弹交互框。
 * @returns {string|null} 形如 "AUTHORIZATION: Basic xxx"
 */
function readCredentialFromHelper(cfg) {
  let url;
  try {
    url = new URL(cfg.gitea.baseUrl);
  } catch {
    return null;
  }
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: `protocol=${url.protocol.replace(':', '')}\nhost=${url.host}\n\n`,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      // 只放「不许交互」的开关；凭据本身绝不经环境变量传递
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo' })
    });
    return credentialHelperHeader(out);
  } catch {
    return null;
  }
}

/** git credential fill 的 `key=value` 输出 → Authorization 头；缺 password 返回 null（纯函数，供单测） */
function credentialHelperHeader(stdout) {
  const fields = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
  }
  if (!fields.password) return null;
  const user = fields.username || 'git';
  return 'AUTHORIZATION: Basic ' + Buffer.from(`${user}:${fields.password}`, 'utf8').toString('base64');
}

/**
 * 读取 Gitea 预授权凭据：`git config --global http.<baseUrl>/.extraheader` 优先，
 * 没有配置时回退到系统凭据管理器（见 readCredentialFromHelper）。
 * 用 execFileSync 直调、不经 shell；值注册进 redact 注册表。
 * @returns {string|null} 凭据原值（形如 "Authorization: Basic xxx"），无则 null
 */
function readCredential(cfg) {
  const c = cfg || loadConfig();
  const gitKey = credentialGitKey(c);
  if (credCache.has(gitKey)) return credCache.get(gitKey);
  let value = null;
  try {
    const out = execFileSync('git', ['config', '--global', gitKey], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
      // 注意：不传 env —— 子进程环境变量里绝不出现凭据（凭据也绝不作为参数传给任何写命令）
    });
    value = String(out || '').trim() || null;
  } catch {
    value = null; // 未配置 = 无凭据，真实请求将以匿名方式发出
  }
  if (!value) value = readCredentialFromHelper(c);
  if (value) {
    registerSecret(value);
    const idx = value.indexOf(':');
    if (idx > 0) registerSecret(value.slice(idx + 1).trim()); // 头值部分单独注册，双保险
  }
  credCache.set(gitKey, value);
  return value;
}

/** 由 extraheader 原值构造请求头："Name: value" 拆开；无冒号则整体作为 Authorization 值 */
function authHeaders(credential) {
  if (!credential) return {};
  const idx = credential.indexOf(':');
  if (idx > 0) return { [credential.slice(0, idx).trim()]: credential.slice(idx + 1).trim() };
  return { Authorization: credential };
}

// ---------------------------------------------------------------- fixture

function fixtureFile() {
  const p = process.env.GITEA_FIXTURE;
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

/** 读 fixture JSON；GITEA_FIXTURE 未设置时返回 null */
function readFixture() {
  const file = fixtureFile();
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ------------------------------------------------------------------- http

/**
 * 出站 GET。安全前置（qoder #11，纵深防御）：
 *   1. 对拼接完成后的最终 URL 再跑一次 assertSafeUrl——防 config 手改
 *      （如 apiPrefix 写成 "@evil.com/"，借助 userinfo 伪装把请求连同凭据导向白名单外）；
 *   2. 校验通过之后才构造带凭据的 headers——凭据绝不会附到发往白名单外 host 的请求上；
 *   3. redirect:'error' 防重定向绕过；全部错误 message 经 redact()。
 */
async function giteaFetch(url, credential, cfg, timeoutMs = 10000) {
  assertSafeUrl(url, cfg || loadConfig()); // 末级复检：任何出站前
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...authHeaders(credential) },
      signal: ac.signal,
      redirect: 'error'
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      const err = new Error(redact(`Gitea HTTP ${res.status} ${res.statusText} ${detail} (${url})`));
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err instanceof Error && !err.message.includes(REDACTED)) err.message = redact(err.message);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 分页拉全（Gitea limit/page 风格），页数与每页条数设上限防失控。
 * 可选 stopWhen(arr) 谓词：对某页返回 true（如本页末条目 created 早于时间窗起点）即提前停翻。
 */
async function listAll(urlBase, credential, cfg, { maxPages = 10, perPage = 50, stopWhen = null } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = urlBase.includes('?') ? '&' : '?';
    const data = await giteaFetch(`${urlBase}${sep}limit=${perPage}&page=${page}`, credential, cfg);
    const arr = Array.isArray(data) ? data : [];
    out.push(...arr);
    if (arr.length < perPage) break;
    if (stopWhen && arr.length > 0 && stopWhen(arr)) break;
  }
  return out;
}

/** host 归一化：小写 + 去末尾点（FQDN），用于凭据最小化的同 host 判定 */
function normalizeHost(h) {
  return String(h || '').toLowerCase().replace(/\.$/, '');
}

// ---------------------------------------------------------------- mapping

function firstLine(s) {
  return String(s || '').split('\n')[0].trim();
}

/**
 * v2.0 功能B：提取提交说明正文首段（title 首行之后的正文第一段）。
 * 规则：按 '\n' 切分丢首行；跳过正文开头的空行；收集至下一个空行之前的所有行；
 * 以 '\n' 连接后去首尾空白；总长超 300 字符则截断到 300；无正文返回 ''。
 * @param {string} message commit 完整 message（首行为 title）
 * @returns {string} 正文第一段（无正文时为 ''）
 */
function messageBodyOf(message) {
  const lines = String(message || '').split('\n').slice(1);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1; // 跳过正文开头空行
  const para = [];
  while (i < lines.length && lines[i].trim() !== '') { // 收集至下一个空行之前
    para.push(lines[i]);
    i += 1;
  }
  const text = para.join('\n').trim();
  return text.length > 300 ? text.slice(0, 300) : text;
}

/** 去掉 refs/heads/ 前缀（feeds 分支类条目的 ref_name 可能带完整 ref 形态） */
function stripRefsPrefix(ref) {
  return String(ref || '').replace(/^refs\/heads\//, '');
}

/** 分支网页 URL：按段 encodeURIComponent 后 '/' 连接（沿用旧 /branches 映射口径） */
function branchUrlOf(htmlUrl, repoFull, branch) {
  const tail = branch.split('/').map(encodeURIComponent).join('/');
  return htmlUrl ? `${htmlUrl}/src/branch/${tail}` : `https://gitea.invalid/${repoFull}/src/branch/${tail}`;
}

/** PR 号提取顺序：comment.pull_request_url → comment.issue_url → comment.html_url → content "#N" */
function prNumberOf(entry) {
  const comment = entry.comment || {};
  for (const u of [comment.pull_request_url, comment.issue_url, comment.html_url]) {
    if (typeof u !== 'string' || u === '') continue;
    const m = /pulls\/(\d+)/.exec(u) || /issues\/(\d+)/.exec(u);
    if (m) return m[1];
  }
  const m = /#(\d+)/.exec(String(entry.content || ''));
  return m ? m[1] : null;
}

/**
 * feeds 条目 → activity（Gitea activities/feeds 数据源，真机 28.1.0 探针实证口径）：
 * - op_type 映射：commit_repo 拆条（content.Commits 逐条 → 'commit'，Timestamp 为 occurredAt）；
 *   create_branch/delete_branch → branch_created/branch_deleted（ref_name 去 refs/heads/ 前缀）；
 *   merge_pull_request/create_pull_request/pull_request → 'pr'（PR 号按序提取，无号退化 op_type 原文）；
 *   其他 op_type（含 create_repo）跳过 → 计数 skippedUnknownOps + distinct 名单 unknownOpTypes
 * - 时间窗：条目 created 早于 sinceMs 整体跳过（fixture 传 -Infinity = 不做窗口过滤）；
 *   commit_repo 拆条后单 commit occurredAt 落窗外则丢弃该条
 * - 所有产物带 fetchedAt，并显式补齐 branch/sha/messageBody（null/null/'' 兜底）保证 strictActivity 输入完整
 * @returns {{activities: object[], skippedUnknownOps: number, unknownOpTypes: string[]}}
 */
function mapFeedEntries(entries, repo, sinceMs, fetchedAt) {
  const activities = [];
  const unknownOps = new Set();
  let skippedUnknownOps = 0;
  const full = (repo && (repo.full_name || `${(repo.owner && repo.owner.login) || ''}/${repo.name}`)) || '';
  const html = (repo && repo.html_url) || '';

  for (const entry of entries || []) {
    if (!entry) continue;
    const created = String(entry.created || '');
    const createdMs = Date.parse(created);
    if (Number.isFinite(createdMs) && createdMs < sinceMs) continue; // 条目整体落窗外
    const actor = (entry.act_user && entry.act_user.login) || 'unknown';
    const op = String(entry.op_type || '');

    if (op === 'commit_repo') {
      // content 为 JSON 字符串：{"Commits":[...],"HeadCommit":{...},"CompareURL":"...","Len":N}
      let content = null;
      try { content = JSON.parse(entry.content); } catch { content = null; }
      const commits = content && Array.isArray(content.Commits) ? content.Commits : [];
      const branch = stripRefsPrefix(String(entry.ref_name || '').split(',')[0]) || null; // 多分支逗号分隔 → 取第一段
      for (const c of commits) {
        if (!c) continue;
        const ts = Date.parse(c.Timestamp);
        const occurredAt = Number.isFinite(ts) ? String(c.Timestamp) : created; // 解析失败退条目 created
        const occMs = Number.isFinite(ts) ? ts : createdMs;
        if (Number.isFinite(occMs) && occMs < sinceMs) continue; // 该 commit 落窗外 → 丢弃
        const sha = c.Sha1 == null ? null : String(c.Sha1);
        activities.push({
          type: 'commit',
          actor,
          repo: full,
          branch,
          sha,
          title: firstLine(c.Message),
          messageBody: messageBodyOf(c.Message),
          url: sha && html ? `${html}/commit/${sha}` : '',
          occurredAt,
          fetchedAt
        });
      }
      continue;
    }

    if (op === 'create_branch' || op === 'delete_branch') {
      const branch = stripRefsPrefix(entry.ref_name) || null;
      activities.push({
        type: op === 'create_branch' ? 'branch_created' : 'branch_deleted',
        actor,
        repo: full,
        branch,
        sha: null,
        title: branch || '',
        messageBody: '',
        url: branch ? branchUrlOf(html, full, branch) : '',
        occurredAt: created,
        fetchedAt
      });
      continue;
    }

    if (op === 'merge_pull_request' || op === 'create_pull_request' || op === 'pull_request') {
      const num = prNumberOf(entry);
      activities.push({
        type: 'pr',
        actor,
        repo: full,
        branch: null,
        sha: null,
        title: num ? `PR #${num}` : op, // 无号：title=op_type 原文
        messageBody: '',
        url: num ? (html ? `${html}/pulls/${num}` : '') : String(html || ''), // 无号：url=repo.html_url
        occurredAt: created,
        fetchedAt
      });
      continue;
    }

    skippedUnknownOps += 1;
    if (op) unknownOps.add(op);
  }
  return { activities, skippedUnknownOps, unknownOpTypes: [...unknownOps] };
}

/**
 * fixture 数据 → 原始事件映射结果（不做 7 天窗口过滤：fixture 为策展数据，sinceMs=-Infinity）。
 * 新格式 {version:{version}, repos:[{full_name,html_url,default_branch}], feeds:{"<full_name>":[条目…]}}：
 * 各仓库条目走与真实模式同一 mapFeedEntries；version 键继续供 testConnection 用。
 */
function activitiesFromFixture(fx, fetchedAt) {
  const activities = [];
  let skippedUnknownOps = 0;
  const unknownOps = new Set();
  for (const r of fx.repos || []) {
    const full = r.full_name || `${(r.owner && r.owner.login) || ''}/${r.name}`;
    const entries = (fx.feeds && fx.feeds[full]) || [];
    const mapped = mapFeedEntries(entries, r, -Infinity, fetchedAt);
    activities.push(...mapped.activities);
    skippedUnknownOps += mapped.skippedUnknownOps;
    for (const op of mapped.unknownOpTypes) unknownOps.add(op);
  }
  return { activities, skippedUnknownOps, unknownOpTypes: [...unknownOps] };
}

// ---------------------------------------------------------------- persist

/**
 * §4 activity 恰好 11 字段（v2.0 功能B 增补 sha/messageBody；matchedTaskIds 仍永不出现在此）。
 * actor 允许 null（branch 事件无操作者）；存量已落盘的 'unknown' 原样保留（容错）。
 */
function strictActivity(a) {
  return {
    id: String(a.id),
    type: String(a.type),
    actor: a.actor == null ? null : String(a.actor),
    repo: a.repo == null ? null : String(a.repo),
    branch: a.branch == null ? null : String(a.branch),
    sha: a.sha == null ? null : String(a.sha),
    title: String(a.title || ''),
    messageBody: a.messageBody == null ? '' : String(a.messageBody),
    url: String(a.url || ''),
    occurredAt: String(a.occurredAt),
    fetchedAt: String(a.fetchedAt)
  };
}

/** 合并去重（键 type|url）→ occurredAt 倒序 → 滚动 ≤max；已有条目保号，新条目递增序号 */
function mergeActivities(existing, incoming, max) {
  const byKey = new Map();
  let maxSeq = 0;
  for (const a of existing || []) {
    const key = `${a.type}|${a.url}`;
    if (!byKey.has(key) && a.url) byKey.set(key, a);
    const m = /^a-(\d+)$/.exec(String(a.id || ''));
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }
  const ordered = [...incoming].sort((x, y) => Date.parse(x.occurredAt) - Date.parse(y.occurredAt));
  for (const a of ordered) {
    if (!a.url) continue;
    const key = `${a.type}|${a.url}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.occurredAt = a.occurredAt;
      prev.fetchedAt = a.fetchedAt;
      prev.title = a.title;
      prev.sha = a.sha; // v2.0 功能B：刷新时同步新字段（存量旧条目再轮询时自然补齐）
      prev.messageBody = a.messageBody;
      continue;
    }
    maxSeq += 1;
    byKey.set(key, { ...a, id: `a-${maxSeq}` });
  }
  return [...byKey.values()]
    .sort((x, y) => Date.parse(y.occurredAt) - Date.parse(x.occurredAt))
    .slice(0, max)
    .map(strictActivity);
}

/** 原子写（tmp + renameSync），SPEC §2 选型口径 */
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function resolveDataPath(cfg, name) {
  const dir = path.isAbsolute(cfg.dataDir) ? cfg.dataDir : path.join(PROJECT_ROOT, cfg.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function readExistingActivities(cfg) {
  // v2.9.33 批次 2：读走 store 路由（activities 迁 SQLite 后这里必须读 db——
  // fs 直读会拿空基线 merge，轮询一次即丢失全部历史）
  try {
    return require('./store.js').loadActivities({ activitiesPath: resolveDataPath(cfg, 'activities.json') });
  } catch {
    return [];
  }
}

// -------------------------------------------------------------------- API

/**
 * 轮询组织仓库最近 7 天 feeds 事件（Gitea activities/feeds）→ §4 activity 数组。
 * 滚动 ≤maxActivities 写 data/activities.json，同时写 data/gitea-status.json
 * （additive 计数字段 skippedUnknownOps = 本轮因未知 op_type 跳过的条目总数）。
 * GITEA_FIXTURE 设置时读 fixture 替代网络（零请求，且不做窗口过滤：sinceMs=-Infinity）。
 * @param {object} [cfg] 缺省 loadConfig()
 * @returns {Promise<object[]>} 落盘后的 activity 数组（倒序）
 * @throws HOST_NOT_ALLOWED / DANGEROUS_WHITELIST_ENTRY / GITEA_ERROR（message 已脱敏）
 */
async function pollActivities(cfg) {
  const conf = cfg || loadConfig();
  validateWhitelist(conf); // 白名单体检：危险字面量直接拒绝（§5-②）

  const fetchedAt = new Date().toISOString();
  const sinceMs = Date.now() - SEVEN_DAYS_MS;
  const types = new Set(normalizeActivityTypes(conf.gitea.activityTypes)); // 使用点归一：cfg 可经 configProvider 注入，绕过 loadConfig
  const feedsLimit = Number(conf.gitea.feedsLimit) > 0 ? Number(conf.gitea.feedsLimit) : 50;
  let rawEvents = [];
  let skippedUnknownOps = 0; // 本轮未知 op_type 跳过总数（additive，进 gitea-status.json）
  const unknownOps = new Set(); // 本轮 distinct 未知 op_type 名单
  let ok = true;
  let lastError = null;
  let guardCode = null; // 守卫错误码透传（HOST_NOT_ALLOWED 等），供路由映射 400

  try {
    const fx = readFixture();
    if (fx) {
      const mapped = activitiesFromFixture(fx, fetchedAt);
      rawEvents = mapped.activities;
      skippedUnknownOps += mapped.skippedUnknownOps;
      for (const op of mapped.unknownOpTypes) unknownOps.add(op);
    } else {
      assertSafeUrl(conf.gitea.baseUrl, conf); // 出站前的首道防线（§5-②，快速失败）
      const credential = readCredential(conf);
      const api = `${String(conf.gitea.baseUrl).replace(/\/+$/, '')}${conf.gitea.apiPrefix || '/api/v1'}`;
      const repos = await listAll(
        `${api}/orgs/${encodeURIComponent(conf.gitea.org)}/repos`, credential, conf, { maxPages: 10 }
      );
      const wanted = repos
        .map((r) => r.full_name || `${(r.owner && r.owner.login) || ''}/${r.name}`)
        .filter(Boolean)
        .slice(0, 50);
      for (const full of wanted) {
        const enc = full.split('/').map(encodeURIComponent).join('/');
        const repo = repos.find((r) => (r.full_name || '') === full) || null;
        // 单仓库失败不拖垮整轮：该仓库 feeds 记 0 条，最终 ok 仍为 false 上报
        const entries = await listAll(
          `${api}/repos/${enc}/activities/feeds?only-performed-by=false`,
          credential, conf,
          {
            maxPages: 2, // 页数兜底
            perPage: feedsLimit,
            stopWhen: (arr) => { // 本页末条目 created 早于窗口起点 → 提前停翻
              const t = Date.parse(arr[arr.length - 1] && arr[arr.length - 1].created);
              return Number.isFinite(t) && t < sinceMs;
            }
          }
        ).catch(() => null);
        if (entries === null) {
          ok = false;
          lastError = lastError || redact(`Gitea 拉取失败: ${full}`);
        }
        const mapped = mapFeedEntries(entries || [], repo || { full_name: full, html_url: '' }, sinceMs, fetchedAt);
        rawEvents.push(...mapped.activities);
        skippedUnknownOps += mapped.skippedUnknownOps;
        for (const op of mapped.unknownOpTypes) unknownOps.add(op);
      }
    }
  } catch (err) {
    ok = false;
    lastError = redact((err && err.message) || String(err));
    if (err && (err.code === 'HOST_NOT_ALLOWED' || err.code === 'DANGEROUS_WHITELIST_ENTRY')) {
      guardCode = err.code; // 末级复检/白名单体检失败 → 保留守卫码，让路由映射 400 而非 502
    }
  }

  // 每轮 poll 结束：对 distinct 未知 op_type 各 warn 一次（文案经 redact）
  for (const op of unknownOps) {
    console.warn(`[gitea] feeds 未知 op_type 已跳过: ${redact(op)}`);
  }

  const filtered = rawEvents.filter((e) => types.has(e.type));
  // 存量条目老词表原地改名：type|url 去重键随改名对齐新词表，同 url 的新拉条目直接坍缩进既有条目
  // （不丢任何历史；pr_opened/pr_merged 同 url 并入 pr，合并态语义与现役 mapper 口径一致）
  const existing = readExistingActivities(conf).map((a) => (
    LEGACY_ACTIVITY_TYPE_MAP[a.type] ? { ...a, type: LEGACY_ACTIVITY_TYPE_MAP[a.type] } : a
  ));
  const merged = mergeActivities(existing, filtered, conf.gitea.maxActivities || 500);

  // v2.9.33 批次 2：activities 写统一出口（存储迁移后经 store.saveActivities 路由）
  require('./store.js').saveActivities({ activitiesPath: resolveDataPath(conf, 'activities.json') }, merged);
  atomicWrite(
    resolveDataPath(conf, 'gitea-status.json'),
    JSON.stringify(
      { ok, lastPollAt: fetchedAt, lastError: lastError === null ? null : String(lastError), skippedUnknownOps },
      null,
      2
    )
  );

  // v1.9 分支约定切片：轮询落盘后按精确规则自动归因（lib/attribute.js）。
  // 惰性 require 防模块环；归因失败只记日志——绝不影响轮询成败与已落盘的 activities/status。
  try {
    require('./attribute.js').attributeAfterPoll(conf);
  } catch (err) {
    console.error('[attribute] 自动归因失败（不影响轮询）:', redact((err && err.message) || String(err)));
  }

  if (!ok) {
    const err = new Error(lastError || 'Gitea 拉取失败');
    err.code = guardCode || 'GITEA_ERROR';
    throw err;
  }
  return merged;
}

// ------------------------------------------------------------------- repos

/**
 * GET /api/repos 仓库列表缓存（模块级，同进程共享）：键 `${baseUrl}|${org}`，值 {at, list}。
 * 仅成功结果入缓存；TTL 内重复调用直接返回缓存（不发请求）。测试经 clearReposCache() 清空。
 */
const reposCache = new Map();
const REPOS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

/**
 * 仓库 → 恰 4 字段视图（mock 契约口径，web/js/views/board.js 仓库下拉消费）：
 * fullName = full_name 缺省回退 `${owner.login}/${name}`（与 pollActivities 现有口径一致）；
 * name = repo.name（fixture 策展数据缺 name 时回退 full_name 第二段，保证恰 4 字段完整）；
 * private = !!repo.private；updatedAt = repo.updated_at || null。
 */
function repoView(r) {
  const fullName = r.full_name || `${(r.owner && r.owner.login) || ''}/${r.name}`;
  const name = r.name || String(fullName).split('/')[1] || '';
  return {
    fullName,
    name,
    private: !!r.private,
    updatedAt: r.updated_at || null
  };
}

/**
 * 列出配置 Gitea 组织下全部仓库（只读，GET /api/repos 后端；任务表单仓库下拉数据源）。
 * fixture 模式读 fixture repos 数组映射（零出网）；真机模式 assertSafeUrl 首检 → readCredential →
 * listAll 分页拉全 /orgs/{org}/repos（maxPages 10，与 pollActivities 同参数风格）→ 映射。
 * 只读红线：绝不写 data/ 任何文件、不写 config。
 * @param {object} [cfg] 缺省 loadConfig()
 * @returns {Promise<object[]>} 恰 4 字段（fullName/name/private/updatedAt）的仓库数组
 * @throws HOST_NOT_ALLOWED / DANGEROUS_WHITELIST_ENTRY（原码原样抛出）/ GITEA_ERROR（message 已脱敏）
 */
async function listOrgRepos(cfg) {
  const conf = cfg || loadConfig();
  validateWhitelist(conf); // 白名单体检：危险字面量直接拒绝（§5-②，沿用 pollActivities 模式）

  const fx = readFixture();
  if (fx) return (fx.repos || []).map(repoView); // fixture 模式：零出网

  const base = String(conf.gitea.baseUrl || '');
  const org = String(conf.gitea.org || '');
  const key = `${base}|${org}`;
  const hit = reposCache.get(key);
  if (hit && Date.now() - hit.at < REPOS_CACHE_TTL_MS) return hit.list; // TTL 内不发请求

  try {
    assertSafeUrl(conf.gitea.baseUrl, conf); // 出站前的首道防线（§5-②，快速失败）
    const credential = readCredential(conf);
    const api = `${base.replace(/\/+$/, '')}${conf.gitea.apiPrefix || '/api/v1'}`;
    const repos = await listAll(
      `${api}/orgs/${encodeURIComponent(org)}/repos`, credential, conf, { maxPages: 10 }
    );
    const list = repos.map(repoView);
    reposCache.set(key, { at: Date.now(), list }); // 仅成功结果入缓存
    return list;
  } catch (err) {
    if (err && (err.code === 'HOST_NOT_ALLOWED' || err.code === 'DANGEROUS_WHITELIST_ENTRY')) throw err;
    const wrapped = new Error(redact((err && err.message) || String(err)));
    wrapped.code = 'GITEA_ERROR';
    throw wrapped;
  }
}

/** 清空仓库列表缓存（测试隔离用：缓存为模块级，同进程所有 app 共享） */
function clearReposCache() {
  reposCache.clear();
}

/**
 * 连接测试（§3 POST /api/gitea/test 后端）。
 * 白名单外/协议外：任何出站前抛 HOST_NOT_ALLOWED；fixture 模式零网络返回版本。
 * 凭据最小化（qoder #11）：仅当目标 host 与 config.gitea.baseUrl 的 host 归一化后
 * 相同时才附 Authorization；异 host 只裸请求（白名单先拦是第一道，这里是纵深）。
 * @param {string} baseUrl
 * @param {object} [cfg]
 * @returns {Promise<{ok:boolean,latencyMs:number,apiVersion:string|null,error?:string}>}
 */
async function testConnection(baseUrl, cfg) {
  const conf = cfg || loadConfig();
  const target = assertSafeUrl(baseUrl || conf.gitea.baseUrl, conf); // 违规即抛，零出站
  const started = Date.now();

  const fx = readFixture();
  if (fx) {
    const version = (fx.version && fx.version.version) || null;
    return { ok: true, latencyMs: Date.now() - started, apiVersion: version };
  }

  let baseHost = '';
  try {
    baseHost = normalizeHost(new URL(String(conf.gitea.baseUrl)).hostname);
  } catch { /* baseUrl 非法 → 视为异 host，不附凭据 */ }
  const targetHost = normalizeHost(target.hostname);
  const credential = targetHost === baseHost ? readCredential(conf) : null;
  const api = `${target.origin}${conf.gitea.apiPrefix || '/api/v1'}`;
  try {
    const data = await giteaFetch(`${api}/version`, credential, conf, 5000);
    return { ok: true, latencyMs: Date.now() - started, apiVersion: (data && data.version) || null };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      apiVersion: null,
      error: redact((err && err.message) || String(err))
    };
  }
}

/**
 * §3 GET /api/settings 脱敏视图（credential 只报来源名，绝不含凭据值）。
 * @param {object} [cfg]
 */
function getSettingsView(cfg) {
  const conf = cfg || loadConfig();
  const g = conf.gitea;
  return {
    port: conf.port,
    host: conf.host,
    dataDir: conf.dataDir,
    gitea: {
      baseUrl: g.baseUrl,
      apiPrefix: g.apiPrefix,
      org: g.org,
      pollIntervalSec: g.pollIntervalSec,
      staleWarnSec: g.staleWarnSec,
      staleDangerSec: g.staleDangerSec,
      hostWhitelist: [...(g.hostWhitelist || [])],
      activityTypes: [...(g.activityTypes || [])],
      ignoreLogins: [...(g.ignoreLogins || [])],
      feedsLimit: g.feedsLimit,
      maxActivities: g.maxActivities
    },
    // v2.9 GitHub 源视图（enabled/baseUrl/org 无敏感值；凭据恒走 GIT_CONFIG_EXTRAHEADER）
    github: {
      enabled: !!(conf.github && conf.github.enabled === true),
      baseUrl: conf.github ? conf.github.baseUrl : '',
      org: conf.github ? conf.github.org : ''
    },
    credential: 'GIT_CONFIG_EXTRAHEADER'
  };
}

module.exports = {
  loadConfig,
  readCredential,
  readCredentialFromHelper,
  credentialHelperHeader,
  pollActivities,
  testConnection,
  getSettingsView,
  listOrgRepos,
  clearReposCache,
  DEFAULTS,
  // v2.9 GitHub 源复用的内部工具（同一 activities.json 合并落盘，口径必须完全一致）
  mergeActivities,
  readExistingActivities,
  resolveDataPath,
  atomicWrite
};
