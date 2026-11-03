'use strict';

/**
 * store.js — JSON 文件存储层
 * - 原子写：tmp 文件 + renameSync（进程崩溃不损坏目标文件）
 * - data/ 目录惰性创建：读操作不落盘，首次写操作时 mkdir -p
 * - 配置/注册表缺省时按 SPEC §5 引导生成
 */

const fs = require('fs');
const path = require('path');
const { HttpError } = require('./router');
const storeDb = require('./storeDb');

/**
 * 损坏隔离（qoder #2）：readJSON 解析失败时先把原文件改名 *.corrupt-<时间戳> 保全，
 * 再回退默认值并登记 degraded；degraded 期间对该文件的写操作一律 503 DATA_DEGRADED，
 * 防止一次成功写把原数据永久覆盖。恢复（文件被修复/删除且重新读取成功）后自动解除。
 */
const degradedFiles = new Set();

function markDegraded(file, reason) {
  degradedFiles.add(path.resolve(file));
  console.warn(`[store] ${file} 已进入降级态: ${reason}（写操作将返回 503，恢复合法文件并重新读取后解除）`);
}

function isDegraded(file) {
  return degradedFiles.has(path.resolve(file));
}

function readDegraded() {
  return degradedFiles;
}

// ---------- 内置默认 ----------

const DEFAULT_COLUMNS = [
  { id: 'todo', name: '待分配', order: 1 },
  { id: 'doing', name: '进行中', order: 2 },
  { id: 'review', name: '待验证', order: 3 },
  { id: 'done', name: '已完成', order: 4 },
];

// SPEC §5：内置 9 项 id 固定；commandTemplate 一律 "<command> \"{briefing}\""
const BUILTIN_AGENT_DEFS = [
  ['opencode', 'opencode'],
  ['crush', 'Crush'],
  ['kilo', 'Kilo'],
  ['mcode', 'mcode'],
  ['goose', 'Goose'],
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
  ['dsh', 'DSH'],
  ['demo-team', 'DemoBot'],
];

function builtinAgents() {
  return BUILTIN_AGENT_DEFS.map(([id, name]) => ({
    id,
    name,
    command: id,
    commandTemplate: `${id} "{briefing}"`,
    builtin: true,
    enabled: true,
  }));
}

const DEFAULT_CONFIG = {
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
    // feeds 词表（giteaClient activities/feeds 数据源）：与 giteaClient.DEFAULTS 同步
    activityTypes: ['pr', 'commit', 'branch_created', 'branch_deleted'],
    feedsLimit: 50,
    maxActivities: 500,
    // v2.9.2 忽略账号：Gitea 组织接口派生成员时的排除名单（默认过滤 admin，大小写不敏感）
    ignoreLogins: ['admin'],
  },
  // v2.9 GitHub 组织动态源（lib/githubClient.js）：默认关闭零出网；开启需 config.json 手改
  // （org + enabled），凭据走 git config http.https://api.github.com/.extraheader（零落盘纪律同 Gitea）
  github: {
    enabled: false,
    baseUrl: 'https://api.github.com',
    org: '',
    eventsPages: 3, // 每页 per_page=100，3 页 = GitHub org events 上限 300 条
    hostWhitelist: ['api.github.com'],
  },
  // v2.9.18 Gitee（gitee.com）组织动态源：默认关闭零出网；开启经设置页或 config.json 手改
  // （org + enabled），凭据走 git config http.https://gitee.com/.extraheader（值=私人令牌原文）
  gitee: {
    enabled: false,
    baseUrl: 'https://gitee.com',
    org: '',
    eventsPages: 3,
    hostWhitelist: ['gitee.com'],
  },
  security: {
    allowedProtocols: ['https'],
    credentialSource: 'git-config-extraheader',
    redactKeys: ['Authorization', 'extraheader'],
  },
  // v2.9.27 Webhook 事件出口：默认关闭零出网；url 可含下游令牌（config.json 为既有配置落点，
  // 同钉钉 dws 凭据先例；错误出口 scrubUrl+redact 双防线）；仅 config.json 手改（暂不进设置页）
  webhookOut: {
    enabled: false,
    url: '',
  },
  // v2.9.39 IM 通知出口（飞书/钉钉自定义机器人）：默认关闭零出网。url 内含机器人 token，属凭据——
  // 与 webhookOut 同落点（config.json）同纪律：设置页只回显 host+尾号，错误出口 scrubUrl+redact；
  // secret（加签密钥）只在本进程内存里参与 HMAC，不进日志、不进响应。
  // digest.at 为本地时间 HH:MM；events 只开「待验收/已完成」两类（其余事件不打扰）。
  im: {
    enabled: false,
    digest: { enabled: false, at: '09:10' },
    events: { review: false, completed: false },
    targets: [],
  },
  // v2.9.41 数据备份；v2.9.42 **默认关闭**（业主判断：本地单机数据，不值得每天备一份；
  // 本地备份也防不住盘坏，真要有异地保护应把整个 fde-console 目录挂同步盘）。
  // 需要时改 config.json 的 backup.enabled=true，或直接跑 scripts/backup-data.js。
  backup: {
    enabled: false,
    keep: 14,
    at: '09:05',
  },
  // v2.9.44 知识库学习模式：**默认关闭**（未配置 = 功能不存在）。root 为本地知识库绝对路径，
  // **只读**（只 readdir/stat/readFile，绝不写 vault）；scope 限定扫描目录，exclude 是减压阀。
  // 契约见 docs/SPEC-LEARN.md。
  learn: {
    enabled: false,
    root: '',
    scope: ['wiki'],
    exclude: [],
    // v2.9.52 内置主题（工程侧基础概念，随插件走；与 vault 抽出的知识点按单双日交替出题）。
    // 空数组 = 完全只用知识库；可选主题名见 lib/learnSeeds.js
    seeds: ['模型与推理', 'AI 工程', 'Java', 'Agent 开发', 'Python'],
    dailyNew: 1,
    dailyReview: 3,
    minutes: 15,
    engine: { mode: 'auto', timeoutSec: 180, reasoningEffort: 'off', maxTokens: 1200 },
  },
  // 任务雷达（PRD-task-inbox §4）：钉钉听记通道 + AI 拆解引擎
  // dwsBin/dshBin 缺省空串 = 运行时按已知安装位置自动解析（见 lib/dingtalk.js resolveDwsBin / lib/analyze.js resolveDshBin）
  dingtalk: {
    enabled: true,
    dwsBin: '',
    dwsTimeoutSec: 60,
    maxMessages: 200,
    hostWhitelist: ['dingtalk.com'],
  },
  // 飞书妙记通道（2026-11-03，lark-cli 桥接，与 dingtalk 同构）：enabled 默认 false——
  // 未装 lark-cli/未授权的机器 = 功能不存在（learn 节同款口径）；larkBin 空串 = 运行时自动解析
  //（lib/feishu.js resolveLarkBin）；lookbackDays 回溯期按 ≤31 天分窗搜索（飞书官方约束）
  feishu: {
    enabled: false,
    larkBin: '',
    larkTimeoutSec: 60,
    maxMessages: 200,
    lookbackDays: 90,
    hostWhitelist: ['feishu.cn', 'larksuite.com'],
  },
  analyze: {
    dshBin: '',
    // v1.5（goose 验收 P1-B）：120s 在真实听记下最短条（55 段）都有 2/3 概率超时，缺省提到 300s；
    // 长会上不封顶但可观测——重试自动升压 ×2 且 job 记录 attempt/timeoutSec（见 lib/analyze.js）
    timeoutSec: 300,
    maxTasksPerMessage: 10,
    maxPromptChars: 24000,
  },
};
// v2.2：DEFAULT_CONFIG.gateway 已随 网关集成整体移除（业主 2026-10-20；
// 磁盘旧 config.json 的遗留 gateway 节由 mergeConfigDefaults 静默剥除）
// 智能体工作观测（v2.2）：四源适配器节默认值统一取自 lib/agentActivity.js
//（路径留空串 = 运行时回退本机默认位置 ~/.zcode/cli、~/.claude/projects、~/.dsh/sessions、~/.workbuddy/workbuddy.db）
DEFAULT_CONFIG.agentActivity = require('./agentActivity').DEFAULT_AGENT_ACTIVITY;

// ---------- 基础工具 ----------

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function randomToken(n) {
  let s = '';
  while (s.length < n) s += Math.random().toString(36).slice(2);
  return s.slice(0, n);
}

/** 原子写：tmp + renameSync（finally 清理 tmp）；目录不存在则惰性创建；degraded 文件拒绝写 */
function writeJSON(file, data) {
  const resolved = path.resolve(file);
  if (degradedFiles.has(resolved)) {
    throw new HttpError(
      503,
      'DATA_DEGRADED',
      `${path.basename(file)} 此前损坏已隔离为 *.corrupt-* 备份，请先恢复该文件再写（详见服务日志）`
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${randomToken(6)}`;
  let done = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    done = true;
  } finally {
    if (!done) {
      try {
        fs.unlinkSync(tmp);
      } catch (e) { /* tmp 不存在 */ }
    }
  }
}

/** 读取 JSON；缺失回退；损坏时隔离原文件为 *.corrupt-<时间戳> 后回退（qoder #2） */
function readJSON(file, fallback) {
  const resolved = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // 注意：ENOENT 不解除降级——隔离正是通过改名使文件暂缺，此处清标志会让写保护失效；
    // 唯一解除途径是恢复的合法文件被成功解析
    if (e && e.code === 'ENOENT') return clone(fallback);
    throw e;
  }
  try {
    const parsed = JSON.parse(raw);
    degradedFiles.delete(resolved); // 真实文件解析成功，解除降级
    return parsed;
  } catch (e) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.corrupt-${stamp}`;
    try {
      fs.renameSync(file, backup);
      console.warn(`[store] ${file} 解析失败，原文件已保全为 ${backup}`);
    } catch (renameErr) {
      console.error(`[store] ${file} 解析失败且隔离失败: ${renameErr.message}`);
    }
    markDegraded(file, e.message);
    return clone(fallback);
  }
}

// ---------- config.json ----------

function mergeConfigDefaults(cfg) {
  const d = clone(DEFAULT_CONFIG);
  const out = {};
  for (const k of ['port', 'host', 'dataDir', 'webDir']) {
    out[k] = cfg && cfg[k] !== undefined ? cfg[k] : d[k];
  }
  out.gitea = Object.assign(d.gitea, isPlainObject(cfg && cfg.gitea) ? cfg.gitea : {});
  // v2.9 GitHub 源节（不并入会被这里的显式键名单静默剥掉——历史教训见 gitea 老词表事故）
  out.github = Object.assign(d.github, isPlainObject(cfg && cfg.github) ? cfg.github : {});
  // v2.9.18 Gitee 源节（同款显式键名单纪律——不并入会被静默剥掉）
  out.gitee = Object.assign(d.gitee, isPlainObject(cfg && cfg.gitee) ? cfg.gitee : {});
  out.security = Object.assign(d.security, isPlainObject(cfg && cfg.security) ? cfg.security : {});
  out.dingtalk = Object.assign(d.dingtalk, isPlainObject(cfg && cfg.dingtalk) ? cfg.dingtalk : {});
  // 飞书妙记通道节（同款显式键名单纪律——不并入会被静默剥掉）
  out.feishu = Object.assign(d.feishu, isPlainObject(cfg && cfg.feishu) ? cfg.feishu : {});
  out.analyze = Object.assign(d.analyze, isPlainObject(cfg && cfg.analyze) ? cfg.analyze : {});
  // v2.9.27 Webhook 事件出口（同款显式键名单纪律——不并入会被静默剥掉）
  out.webhookOut = Object.assign(d.webhookOut, isPlainObject(cfg && cfg.webhookOut) ? cfg.webhookOut : {});
  // v2.9.39 IM 通知（同纪律；digest/events 子节深合并，targets 数组整体替换）
  const im = isPlainObject(cfg && cfg.im) ? cfg.im : {};
  out.im = Object.assign({}, d.im, im, {
    digest: Object.assign({}, d.im.digest, isPlainObject(im.digest) ? im.digest : {}),
    events: Object.assign({}, d.im.events, isPlainObject(im.events) ? im.events : {}),
    targets: Array.isArray(im.targets) ? im.targets : [],
  });
  // v2.9.41 数据备份（同款显式键名单纪律——不并入会被静默剥掉）
  out.backup = Object.assign(d.backup, isPlainObject(cfg && cfg.backup) ? cfg.backup : {});
  // v2.9.44 知识库学习（engine 子节深合并；scope/exclude 数组直取，防部分配置丢默认值）
  const learn = isPlainObject(cfg && cfg.learn) ? cfg.learn : {};
  out.learn = Object.assign({}, d.learn, learn, {
    scope: Array.isArray(learn.scope) && learn.scope.length ? learn.scope : d.learn.scope,
    exclude: Array.isArray(learn.exclude) ? learn.exclude : [],
    seeds: Array.isArray(learn.seeds) ? learn.seeds : d.learn.seeds.slice(),
    engine: Object.assign({}, d.learn.engine, isPlainObject(learn.engine) ? learn.engine : {}),
  });
  // v2.2：网关集成已移除——磁盘遗留 gateway 节不并入运行期 config（静默剥除）
  // v2.2 智能体工作观测：sources 子节需深合并（局部配置不得丢其他源默认开关/路径）
  out.agentActivity = require('./agentActivity').normalizeAgentActivity(cfg && cfg.agentActivity);
  return out;
}

/** 读取配置；文件缺失则按 §5 默认值引导生成 */
function loadOrCreateConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    writeJSON(configPath, DEFAULT_CONFIG);
    console.log(`[config] 已生成默认 config.json: ${configPath}`);
  }
  const raw = readJSON(configPath, null);
  if (!isPlainObject(raw)) {
    throw new Error(`config.json 无法解析为对象: ${configPath}`);
  }
  return mergeConfigDefaults(raw);
}

// ---------- agents.json ----------

function loadAgents(agentsPath) {
  const d = readJSON(agentsPath, null);
  if (d && Array.isArray(d.agents)) {
    return d.agents.filter((a) => a && typeof a.id === 'string');
  }
  return builtinAgents();
}

function saveAgents(agentsPath, agents) {
  writeJSON(agentsPath, { agents });
}

/** 首次运行引导生成 agents.json（内置 9 项） */
function loadOrCreateAgentsFile(agentsPath) {
  if (!fs.existsSync(agentsPath)) {
    const agents = builtinAgents();
    saveAgents(agentsPath, agents);
    console.log(`[agents] 已生成默认 agents.json（内置 ${agents.length} 项）: ${agentsPath}`);
    return agents;
  }
  return loadAgents(agentsPath);
}

// ---------- members.json（v1.2 手工名册；项目根配置文件，API 写回） ----------

/** 容错读取手工名册：缺失/形态不符回退 []；损坏时走 readJSON 的隔离+降级保护 */
function loadMembers(membersPath) {
  const d = readJSON(membersPath, null);
  let list = [];
  if (isPlainObject(d) && Array.isArray(d.members)) list = d.members;
  else if (Array.isArray(d)) list = d; // 容忍裸数组形态
  return list.filter((m) => m && isPlainObject(m) && typeof m.id === 'string' && typeof m.name === 'string');
}

function saveMembers(membersPath, members) {
  writeJSON(membersPath, { members });
}

/**
 * 聚合名册快照（v1.5 goose 验收 P1-A）：说话人映射与负责人建议的统一匹配源——
 * 手工名册（enabled≠false 的条目，aliases/name）∪ Gitea 成员缓存（id=login，name=full_name）。
 * 智能体不入册（负责人建议只对人）；手工条目已认领的 giteaLogin 吸收为其别名（与
 * overview 的 claimedLogins 归因口径一致，防同人双 id 分裂），该派生条目不再重复出现。
 * @returns [{id, name, aliases, source:'manual'|'gitea'}]
 * analyze 的 prompt 名册 / resolveSpeaker 匹配 / coerceResult 校验共用此快照，勿在调用方各自拼装。
 */
function aggregateRoster(ctx) {
  const out = [];
  const seen = new Set();
  const claimedLogins = new Map(); // 小写 login → 手工条目（吸收为别名）
  if (ctx.membersPath) {
    for (const m of loadMembers(ctx.membersPath)) {
      if (m.enabled === false) continue; // 停用成员不参与匹配（与 v1.5 前行为一致）
      const entry = {
        id: m.id,
        name: m.name,
        aliases: Array.isArray(m.aliases) ? m.aliases.filter((a) => typeof a === 'string') : [],
        source: 'manual',
      };
      const login = typeof m.giteaLogin === 'string' ? m.giteaLogin.trim().toLowerCase() : '';
      if (login) claimedLogins.set(login, entry);
      seen.add(m.id);
      out.push(entry);
    }
  }
  for (const h of ctx.giteaMembersPath ? loadGiteaMembers(ctx) : []) {
    if (!h.id || seen.has(h.id)) continue;
    const key = String(h.id).toLowerCase();
    const claimed = claimedLogins.get(key);
    if (claimed) {
      // 手工条目认领了该 login：把 login 吸收为别名，派生条目不出现（同人单 id）
      if (!claimed.aliases.some((a) => String(a).trim().toLowerCase() === key)) {
        claimed.aliases.push(h.id);
      }
      continue;
    }
    seen.add(h.id);
    out.push({ id: h.id, name: h.name || h.id, aliases: [], source: 'gitea' });
  }
  return out;
}

// ---------- data/*.json ----------

function loadTasks(ctx) {
  // v2.9.33 批次 2 存储路由：tasks 迁移 → SQLite（data 列真源，投影列只写不读）
  if (storeDb.unitBackend(path.dirname(ctx.tasksPath), 'tasks').backend === 'sqlite') {
    const d = readJSON(columnsPathOf(ctx), null);
    const columns = Array.isArray(d) && d.length > 0 ? d : clone(DEFAULT_COLUMNS);
    return { columns, tasks: storeDb.loadTasks(storeDb.dbPathFor(path.dirname(ctx.tasksPath))) };
  }
  const d = readJSON(ctx.tasksPath, null);
  if (!isPlainObject(d)) return { columns: clone(DEFAULT_COLUMNS), tasks: [] };
  const columns = Array.isArray(d.columns) && d.columns.length > 0 ? d.columns : clone(DEFAULT_COLUMNS);
  const tasks = Array.isArray(d.tasks) ? d.tasks : [];
  return { columns, tasks };
}

/** 列定义恒走 JSON 伴生文件（配置型小数据，SPEC-STORAGE §1.3）；仅 db 路径使用 */
function columnsPathOf(ctx) {
  return path.join(path.dirname(ctx.tasksPath), 'columns.json');
}

function saveTasks(ctx, data) {
  if (storeDb.unitBackend(path.dirname(ctx.tasksPath), 'tasks').backend === 'sqlite') {
    // 列定义伴生 JSON 原样写（不入库）；任务行进 db（全量替换事务）
    writeJSON(columnsPathOf(ctx), Array.isArray(data.columns) && data.columns.length > 0 ? data.columns : clone(DEFAULT_COLUMNS));
    return storeDb.saveTasks(storeDb.dbPathFor(path.dirname(ctx.tasksPath)), data);
  }
  writeJSON(ctx.tasksPath, data);
}

// v2.3：loadSessions/saveSessions 已随会话登记表退役移除（规格 §6；
// 会话观测唯一入口 = GET /api/agent-sessions / /api/agent-session）

/** SPEC §4：activities.json 按数组存储；容忍 {activities:[...]} 包装。
 *  v2.9.33 批次 2：activities 迁移 → SQLite（写路由经 saveActivities 统一出口，三 poller 客户端共用） */
function loadActivities(ctx) {
  if (storeDb.unitBackend(path.dirname(ctx.activitiesPath), 'activities').backend === 'sqlite') {
    return storeDb.loadActivities(storeDb.dbPathFor(path.dirname(ctx.activitiesPath)));
  }
  const d = readJSON(ctx.activitiesPath, null);
  if (Array.isArray(d)) return d;
  if (isPlainObject(d) && Array.isArray(d.activities)) return d.activities;
  return [];
}

/** v2.9.33 批次 2：activities 写统一出口（gitea/github/gitee 三 poller 与测试共用） */
function saveActivities(ctx, activities) {
  if (storeDb.unitBackend(path.dirname(ctx.activitiesPath), 'activities').backend === 'sqlite') {
    return storeDb.saveActivities(storeDb.dbPathFor(path.dirname(ctx.activitiesPath)), activities);
  }
  writeJSON(ctx.activitiesPath, activities);
}

/** gitea 健康状态：mcode 的 B3 写入，本侧只读；缺失时返回未轮询默认值 */
function loadGiteaStatus(ctx) {
  const d = readJSON(ctx.giteaStatusPath, null);
  if (!isPlainObject(d)) return { ok: false, lastPollAt: null, lastError: '尚未轮询' };
  return {
    ok: !!d.ok,
    lastPollAt: typeof d.lastPollAt === 'string' ? d.lastPollAt : null,
    lastError: d.lastError === undefined || d.lastError === null ? (d.ok ? null : '尚未轮询') : String(d.lastError),
  };
}

/** Gitea 组织成员缓存（B3 轮询时顺带缓存）；缺失返回 []；容忍多种形态 */
function loadGiteaMembers(ctx) {
  const d = readJSON(ctx.giteaMembersPath, null);
  let list = [];
  if (Array.isArray(d)) list = d;
  else if (isPlainObject(d) && Array.isArray(d.members)) list = d.members;
  const out = [];
  for (const m of list) {
    if (typeof m === 'string') out.push({ id: m, name: m, role: '' });
    else if (isPlainObject(m) && typeof m.login === 'string') {
      out.push({
        id: m.login,
        name: m.full_name || m.name || m.login,
        role: m.role || '',
      });
    } else if (isPlainObject(m) && typeof m.id === 'string') {
      out.push({ id: m.id, name: m.name || m.id, role: m.role || '' });
    }
  }
  return out;
}

// ---------- 任务雷达（PRD-task-inbox §4）：雷达池 messages.json + 候选池 inbox.json ----------

/** 雷达池：{messages:[...]} 或裸数组均容忍；缺失回退空池 */
function loadMessages(ctx) {
  // v2.9.33 存储后端路由（红线 3 修订）：台账标记 messages 已迁移 → SQLite 路径
  //（形状与 JSON 后端同构；ctx.messagesPath 在 sqlite 路径下仅用于推导 data 目录）
  if (storeDb.unitBackend(path.dirname(ctx.messagesPath), 'messages').backend === 'sqlite') {
    return storeDb.loadMessages(storeDb.dbPathFor(path.dirname(ctx.messagesPath)));
  }
  const d = readJSON(ctx.messagesPath, null);
  if (Array.isArray(d)) return d;
  if (isPlainObject(d) && Array.isArray(d.messages)) return d.messages;
  return [];
}

function saveMessages(ctx, messages) {
  if (storeDb.unitBackend(path.dirname(ctx.messagesPath), 'messages').backend === 'sqlite') {
    return storeDb.saveMessages(storeDb.dbPathFor(path.dirname(ctx.messagesPath)), messages);
  }
  writeJSON(ctx.messagesPath, messages);
}

/** 候选池：{candidates:[...]} 或裸数组均容忍；缺失回退空池。
 *  v2.9.33 批次 2：inbox 迁移 → SQLite */
function loadInbox(ctx) {
  if (storeDb.unitBackend(path.dirname(ctx.inboxPath), 'inbox').backend === 'sqlite') {
    return storeDb.loadInbox(storeDb.dbPathFor(path.dirname(ctx.inboxPath)));
  }
  const d = readJSON(ctx.inboxPath, null);
  if (Array.isArray(d)) return d;
  if (isPlainObject(d) && Array.isArray(d.candidates)) return d.candidates;
  return [];
}

function saveInbox(ctx, candidates) {
  if (storeDb.unitBackend(path.dirname(ctx.inboxPath), 'inbox').backend === 'sqlite') {
    return storeDb.saveInbox(storeDb.dbPathFor(path.dirname(ctx.inboxPath)), candidates);
  }
  // JSON 形态保持 {candidates:[...]} 包装（历史契约）
  writeJSON(ctx.inboxPath, { candidates });
}

/** 任务 id：t-<base36 时间戳>-<4 位随机>（与 server.js genTaskId 同构；候选确认入库用） */
function genTaskId(existing) {
  const taken = new Set((existing || []).map((t) => t.id));
  let id;
  do {
    id = `t-${Date.now().toString(36)}-${randomToken(4)}`;
  } while (taken.has(id));
  return id;
}

module.exports = {
  DEFAULT_COLUMNS,
  DEFAULT_CONFIG,
  mergeConfigDefaults,
  builtinAgents,
  clone,
  isPlainObject,
  randomToken,
  writeJSON,
  readJSON,
  loadOrCreateConfig,
  loadAgents,
  saveAgents,
  loadOrCreateAgentsFile,
  loadMembers,
  saveMembers,
  aggregateRoster,
  loadTasks,
  saveTasks,
  loadActivities,
  saveActivities,
  loadGiteaStatus,
  loadGiteaMembers,
  loadMessages,
  saveMessages,
  loadInbox,
  saveInbox,
  genTaskId,
};
