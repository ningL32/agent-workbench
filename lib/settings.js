'use strict';

/**
 * settings.js — B5 设置读写
 * - GET /api/settings：脱敏视图（凭据永不出现，仅显示来源枚举）；dataDir 回显磁盘原值（v1.5 只读）
 * - PATCH /api/settings：按节 deep merge 后整体写回 config.json；host 白名单仅接受
 *   127.0.0.1/0.0.0.0（SPEC-PLUGIN 2.1：与宿主 webServer schema 同源，业主拍板允许显式
 *   配置 LAN 绑定，默认仍 127.0.0.1）；dataDir/webDir 只读（PATCH 忽略，防止相对路径被
 *   持久化为绝对路径，v1.5）
 * - WP6 焊死（SPEC-PLUGIN 2.6）：port 退出 config.json 与设置面——监听参数归宿主
 *   webServer（--port 由 web-startup 解析），本模块不再展示/校验/写回 port
 * - security 节：redactKeys/allowedProtocols/credentialSource 仍仅手改（#10 防改弱脱敏边界）；
 *   唯一例外 trustedHosts（插件态 Host 防线 allowlist 扩展，与脱敏无关）可经 PATCH 修改，
 *   条目须为裸 host 字面量（域名或 IPv4）；回环字面量恒允许（防线内置），配置与否无影响。
 *   注意：Host 防线为启动期快照（plugin/adapter.js createHostGuard），trustedHosts 变更需重启生效
 */

const store = require('./store');
const agentActivity = require('./agentActivity');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError, sendJSON } = require('./router');

const CREDENTIAL_VIEW = {
  'git-config-extraheader': 'GIT_CONFIG_EXTRAHEADER',
};

// v1.5（goose 验收附带 bug）：dataDir/webDir 对 API 只读——不进 PATCH 白名单，
// 一次设置页 PATCH 就曾把 config.json 的相对路径持久化成绝对路径（换机/挪目录部署即漂移）。
// 运行期目录解析仍由装配侧启动时归一化（#6，gitea provider 依赖），但绝不写回磁盘。
// WP6：port 出白名单（监听归宿主 webServer，config.json 不再有 port 键）
// v2.2：agentActivity 入白名单（智能体工作观测：总开关/限额/各源开关与根路径，本机路径无敏感值）
// v2.2：gateway 出白名单（网关集成整体移除，业主 2026-10-20；PATCH 传入即静默忽略）
const TOP_LEVEL_ALLOWED = new Set(['host', 'gitea', 'security', 'dingtalk', 'feishu', 'analyze', 'agentActivity', 'github', 'gitee', 'im', 'learn']);

/** 读磁盘 config.json 的目录原值（不经 store.readJSON——GET 不得触发损坏隔离等副作用） */
function diskDirRaw(configPath, key, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return typeof raw[key] === 'string' ? raw[key] : fallback;
  } catch (e) {
    return fallback;
  }
}

/** 白名单条目非法性检查：拒绝 localhost/IP 字面量/无点号单段主机名（§5-②） */
function forbiddenWhitelistEntry(entry) {
  if (typeof entry !== 'string' || entry.trim() === '') return '空白项';
  const h = entry.trim().toLowerCase();
  if (h === 'localhost' || h === 'localhost.') return 'localhost';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return 'IPv4 字面量';
  if (/^[0-9a-f:]+:[0-9a-f:]*$/i.test(h) && h.includes(':')) return 'IPv6 字面量';
  if (!h.includes('.')) return '缺少点号的单段主机名';
  return null;
}

/**
 * security.trustedHosts 条目校验：仅接受裸 host 字面量（域名或 IPv4）。
 * 禁止协议前缀/路径分隔符/空白字符/userinfo/端口与 IPv6 写法——Host 防线（plugin/adapter.js
 * hostOf）按 authority host 部分比较，条目必须是纯 host 才有确定语义。
 * localhost/127.0.0.1 恒允许（防线内置回环兜底），配置与否无影响——回环条目冗余但无害，
 * 接受之（防「GET 视图原样存回」被 400；迁移模板 pluginDefaultConfig 即含回环条目）。
 * @returns {string|null} 非法原因；合法返回 null
 */
function trustedHostEntryError(entry) {
  if (typeof entry !== 'string' || entry.trim() === '') return '空白项';
  if (/\s/.test(entry)) return '含空白字符';
  if (entry.includes('://')) return '含协议前缀';
  if (entry.includes('/') || entry.includes('\\')) return '含路径分隔符';
  if (entry.includes('@')) return '含 userinfo';
  if (entry.includes(':')) return '含端口或 IPv6 写法（仅支持域名或 IPv4 字面量）';
  if (entry.includes('?') || entry.includes('#') || entry.includes('%')) return '含非 host 字符';
  const h = entry.toLowerCase();
  if (h.length > 253) return '超过 253 字符上限';
  if (!/^[a-z0-9._-]+$/.test(h)) return '含非法字符（仅允许字母/数字/点/连字符）';
  return null;
}

/**
 * v2.2 智能体工作观测视图：节归一化后如实带出（enabled/限额/各源开关与根路径——
 * 本机路径无敏感值，同 dwsBin/dshBin 口径；路径空串 = 运行时回退本机默认位置）。
 * v2.2 移除：gateway 视图节（网关集成整体移除，GET 不再返回该节）。
 */
function agentActivityView(config) {
  return agentActivity.normalizeAgentActivity(config && config.agentActivity);
}

/** baseUrl 校验：协议 ∈ allowedProtocols 且 host 精确命中白名单 */
function baseUrlError(urlStr, whitelist, allowedProtocols) {
  let u;
  try {
    u = new URL(String(urlStr));
  } catch (e) {
    return 'baseUrl 不是合法 URL';
  }
  const proto = u.protocol.replace(/:$/, '');
  if (!allowedProtocols.includes(proto)) return `协议 ${proto} 不在 allowedProtocols`;
  const host = u.hostname.toLowerCase();
  if (!whitelist.some((w) => String(w).trim().toLowerCase() === host)) return 'baseUrl host 不在白名单';
  return null;
}

/** 脱敏视图（SPEC §3；另含 F5 需要的时效阈值 staleWarnSec/staleDangerSec 与雷达配置视图） */
function redactedView(config) {
  const g = config.gitea || {};
  const dt = config.dingtalk || {};
  const fx = config.feishu || {};
  const az = config.analyze || {};
  const sec = config.security || {};
  return {
    host: config.host,
    dataDir: config.dataDir,
    gitea: {
      baseUrl: g.baseUrl,
      apiPrefix: g.apiPrefix,
      org: g.org,
      pollIntervalSec: g.pollIntervalSec,
      hostWhitelist: store.clone(g.hostWhitelist || []),
      staleWarnSec: g.staleWarnSec,
      staleDangerSec: g.staleDangerSec,
      // v2.9.2 忽略账号（成员册派生排除名单）如实带出
      ignoreLogins: store.clone(Array.isArray(g.ignoreLogins) ? g.ignoreLogins : []),
    },
    // 任务雷达（PRD §6 设置页）：钉钉通道开关 + 引擎超时；dwsBin/dshBin 为可编辑键如实带出
    //（本机路径无敏感值；空串 = 运行时按已知安装位置自动解析）
    dingtalk: {
      enabled: dt.enabled !== false,
      dwsBin: typeof dt.dwsBin === 'string' ? dt.dwsBin : '',
      dwsTimeoutSec: Number(dt.dwsTimeoutSec) || 60,
      maxMessages: Number(dt.maxMessages) || 200,
      hostWhitelist: store.clone(dt.hostWhitelist || []),
    },
    // 飞书妙记通道（与 dingtalk 同构；larkBin 为本机路径无敏感值，空串 = 运行时自动解析）
    feishu: {
      enabled: fx.enabled === true,
      larkBin: typeof fx.larkBin === 'string' ? fx.larkBin : '',
      larkTimeoutSec: Number(fx.larkTimeoutSec) || 60,
      maxMessages: Number(fx.maxMessages) || 200,
      lookbackDays: Number(fx.lookbackDays) || 90,
      hostWhitelist: store.clone(fx.hostWhitelist || []),
    },
    analyze: {
      dshBin: typeof az.dshBin === 'string' ? az.dshBin : '',
      timeoutSec: Number(az.timeoutSec) || 300,
      maxTasksPerMessage: Number(az.maxTasksPerMessage) || 10,
    },
    // v2.2 智能体工作观测（本期仅设置视图带出，字段留好；设置 UI 后续接入）
    agentActivity: agentActivityView(config),
    // v2.9 GitHub 组织动态源（v2.9.17 页面化：enabled/org/baseUrl 可经设置页 PATCH，
    // hot-apply 随下个轮询周期生效；凭据仍走 git config 零落盘不进页面体系）
    github: {
      enabled: !!(config.github && config.github.enabled === true),
      baseUrl: config.github ? config.github.baseUrl : '',
      org: config.github ? config.github.org : '',
      hostWhitelist: store.clone(config.github && Array.isArray(config.github.hostWhitelist) ? config.github.hostWhitelist : []),
    },
    // v2.9.18 Gitee 组织动态源（同 github 口径：三键可 PATCH 热生效，凭据 git config 零落盘）
    gitee: {
      enabled: !!(config.gitee && config.gitee.enabled === true),
      baseUrl: config.gitee ? config.gitee.baseUrl : '',
      org: config.gitee ? config.gitee.org : '',
      hostWhitelist: store.clone(config.gitee && Array.isArray(config.gitee.hostWhitelist) ? config.gitee.hostWhitelist : []),
    },
    security: {
      trustedHosts: store.clone(Array.isArray(sec.trustedHosts) ? sec.trustedHosts : []),
    },
    // v2.9.29 D4：新配置节只读可见性（webhookOut/agentContext 仅 config.json 手改——
    // 页面只展示状态不给编辑面；url 只出 host 不出 query，下游令牌不进设置视图）
    webhookOut: {
      enabled: !!(config.webhookOut && config.webhookOut.enabled === true),
      urlHost: urlHostOf(config.webhookOut && config.webhookOut.url),
    },
    agentContext: {
      enabled: !!(config.agentContext && config.agentContext.enabled === true),
      dirsCount: Array.isArray(config.agentContext && config.agentContext.dirs) ? config.agentContext.dirs.length : 0,
    },
    credential: CREDENTIAL_VIEW[sec.credentialSource] || 'UNKNOWN',
    // v2.9.39 IM 通知（飞书/钉钉）：只读回显配置状态；token 只出 host + 尾 4 位，secret 只报有无
    im: imView(config),
    // v2.9.44 知识库学习：只读回显（root 是本机路径，无敏感值；rootOk 由 lib/learn 校验）
    learn: learnView(config),
  };
}

/** 学习模式视图：路径与范围如实带出，rootOk 由调用方补（需要 fs 校验，放在路由层） */
function learnView(config) {
  const l = (config && config.learn) || {};
  return {
    enabled: l.enabled === true,
    root: typeof l.root === 'string' ? l.root : '',
    scope: store.clone(Array.isArray(l.scope) ? l.scope : []),
    exclude: store.clone(Array.isArray(l.exclude) ? l.exclude : []),
    seeds: store.clone(Array.isArray(l.seeds) ? l.seeds : []),
    dailyNew: Number(l.dailyNew) || 1,
    dailyReview: Number(l.dailyReview) || 3,
    minutes: Number(l.minutes) || 15,
    engine: {
      mode: (l.engine && l.engine.mode) || 'auto',
      timeoutSec: Number(l.engine && l.engine.timeoutSec) || 180,
      reasoningEffort: (l.engine && l.engine.reasoningEffort) || 'off',
      maxTokens: Number(l.engine && l.engine.maxTokens) || 1200,
    },
  };
}

/** IM 目标脱敏视图：平台 + host + token 尾 4 位（机器人 URL 含令牌，绝不整串回显） */
function imTargetView(t) {
  const url = t && typeof t.url === 'string' ? t.url : '';
  let tail = '';
  try {
    const u = new URL(url);
    const lastSeg = u.pathname.split('/').filter(Boolean).pop() || '';
    const token = u.searchParams.get('access_token') || lastSeg;
    tail = token ? token.slice(-4) : '';
  } catch (e) {
    tail = '';
  }
  const platform = t && (t.platform === 'dingtalk' || t.platform === 'feishu') ? t.platform : '';
  return {
    platform,
    urlHost: urlHostOf(url),
    tokenTail: tail,
    hasSecret: !!(t && typeof t.secret === 'string' && t.secret.trim() !== ''),
  };
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function imView(config) {
  const im = (config && config.im) || {};
  const dg = im.digest || {};
  const ev = im.events || {};
  return {
    enabled: im.enabled === true,
    digest: { enabled: dg.enabled === true, at: HHMM_RE.test(String(dg.at || '')) ? dg.at : '09:10' },
    events: { review: ev.review === true, completed: ev.completed === true },
    targets: (Array.isArray(im.targets) ? im.targets : []).map(imTargetView),
  };
}

/** webhook url → 仅协议+host（query 里的下游令牌不进设置视图） */
function urlHostOf(u) {
  try {
    const p = new URL(String(u || ''));
    return `${p.protocol}//${p.host}`;
  } catch (e) {
    return '';
  }
}

function deepMerge(target, patch) {
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (store.isPlainObject(v) && store.isPlainObject(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = store.isPlainObject(v) ? store.clone(v) : v;
    }
  }
  return target;
}

function requirePositiveInt(obj, key, label) {
  if (obj[key] !== undefined && (!Number.isInteger(obj[key]) || obj[key] <= 0)) {
    throw new HttpError(400, 'SETTINGS_INVALID', `${label} 必须为正整数`);
  }
}

function applyPatch(config, body, configPath) {
  if (!store.isPlainObject(body)) throw new HttpError(400, 'SETTINGS_INVALID', '请求体必须是 JSON 对象');

  // ① host 白名单：仅接受 127.0.0.1/0.0.0.0（SPEC-PLUGIN 2.1 与宿主 webServer schema 同源）
  if (body.host !== undefined && body.host !== '127.0.0.1' && body.host !== '0.0.0.0') {
    throw new HttpError(400, 'HOST_FORBIDDEN', 'host 仅接受 127.0.0.1/0.0.0.0');
  }
  // ② 目录（v1.5：dataDir/webDir 只读，PATCH 一律忽略，不再校验也不再写回；WP6：port 出白名单，传入即静默忽略）
  // ③ gitea 节
  let nextWhitelist = store.clone((config.gitea || {}).hostWhitelist || []);
  if (body.gitea !== undefined) {
    const g = body.gitea;
    if (!store.isPlainObject(g)) throw new HttpError(400, 'SETTINGS_INVALID', 'gitea 必须为对象');
    if (g.hostWhitelist !== undefined) {
      if (!Array.isArray(g.hostWhitelist) || g.hostWhitelist.length === 0) {
        throw new HttpError(400, 'WHITELIST_INVALID', 'hostWhitelist 必须为非空字符串数组');
      }
      for (const entry of g.hostWhitelist) {
        const bad = forbiddenWhitelistEntry(entry);
        if (bad) throw new HttpError(400, 'WHITELIST_INVALID', `白名单含禁止项 "${entry}"（${bad}）`);
      }
      nextWhitelist = g.hostWhitelist;
    }
    if (g.baseUrl !== undefined) {
      const err = baseUrlError(g.baseUrl, nextWhitelist, config.security.allowedProtocols);
      if (err) throw new HttpError(400, 'HOST_NOT_ALLOWED', err);
    }
    requirePositiveInt(g, 'staleWarnSec', 'staleWarnSec');
    requirePositiveInt(g, 'staleDangerSec', 'staleDangerSec');
    requirePositiveInt(g, 'maxActivities', 'maxActivities');
    // v2.9.2 忽略账号：字符串数组（成员册派生排除名单）
    if (g.ignoreLogins !== undefined) {
      if (!Array.isArray(g.ignoreLogins) || g.ignoreLogins.some((t) => typeof t !== 'string')) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'ignoreLogins 必须为字符串数组');
      }
    }
    // pollIntervalSec 允许 0（= 关闭轮询器），其余须正整数
    if (g.pollIntervalSec !== undefined && (!Number.isInteger(g.pollIntervalSec) || g.pollIntervalSec < 0)) {
      throw new HttpError(400, 'SETTINGS_INVALID', 'pollIntervalSec 必须为 ≥0 的整数（0 表示关闭轮询器）');
    }
    if (g.apiPrefix !== undefined && (typeof g.apiPrefix !== 'string' || !g.apiPrefix.startsWith('/'))) {
      throw new HttpError(400, 'SETTINGS_INVALID', 'apiPrefix 必须为以 / 开头的字符串');
    }
    if (g.org !== undefined && (typeof g.org !== 'string' || g.org.trim() === '')) {
      throw new HttpError(400, 'SETTINGS_INVALID', 'org 必须为非空字符串');
    }
    if (g.activityTypes !== undefined) {
      if (!Array.isArray(g.activityTypes) || g.activityTypes.some((t) => typeof t !== 'string')) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'activityTypes 必须为字符串数组');
      }
    }
  }
  // ④ security 节（路由层已先行拦截：仅 trustedHosts 可经 API 修改，其余键仍 #10 仅手改）
  if (body.security !== undefined) {
    const s = body.security;
    if (!store.isPlainObject(s)) throw new HttpError(400, 'SETTINGS_INVALID', 'security 必须为对象');
    if (s.trustedHosts !== undefined) {
      if (!Array.isArray(s.trustedHosts)) {
        throw new HttpError(400, 'WHITELIST_INVALID', 'security.trustedHosts 必须为字符串数组');
      }
      if (s.trustedHosts.length > 64) {
        throw new HttpError(400, 'WHITELIST_INVALID', 'security.trustedHosts 最多 64 项');
      }
      for (const entry of s.trustedHosts) {
        const bad = trustedHostEntryError(entry);
        if (bad) throw new HttpError(400, 'WHITELIST_INVALID', `trustedHosts 含非法项 "${entry}"（${bad}）`);
      }
    }
    if (s.allowedProtocols !== undefined) {
      if (!Array.isArray(s.allowedProtocols) || s.allowedProtocols.some((p) => typeof p !== 'string')) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'allowedProtocols 必须为字符串数组');
      }
    }
    if (s.credentialSource !== undefined && typeof s.credentialSource !== 'string') {
      throw new HttpError(400, 'SETTINGS_INVALID', 'credentialSource 必须为字符串');
    }
    if (s.redactKeys !== undefined) {
      if (!Array.isArray(s.redactKeys) || s.redactKeys.some((k) => typeof k !== 'string')) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'redactKeys 必须为字符串数组');
      }
    }
  }
  // ⑤ dingtalk 节（任务雷达；hostWhitelist 与 gitea 同一红线）
  if (body.dingtalk !== undefined) {
    const dt = body.dingtalk;
    if (!store.isPlainObject(dt)) throw new HttpError(400, 'SETTINGS_INVALID', 'dingtalk 必须为对象');
    if (dt.enabled !== undefined && typeof dt.enabled !== 'boolean') {
      throw new HttpError(400, 'SETTINGS_INVALID', 'dingtalk.enabled 必须为布尔值');
    }
    if (dt.hostWhitelist !== undefined) {
      if (!Array.isArray(dt.hostWhitelist) || dt.hostWhitelist.length === 0) {
        throw new HttpError(400, 'WHITELIST_INVALID', 'dingtalk.hostWhitelist 必须为非空字符串数组');
      }
      for (const entry of dt.hostWhitelist) {
        const bad = forbiddenWhitelistEntry(entry);
        if (bad) throw new HttpError(400, 'WHITELIST_INVALID', `白名单含禁止项 "${entry}"（${bad}）`);
      }
    }
    // dwsBin：字符串即可（空串 = 重置为运行时按已知安装位置自动解析，见 lib/dingtalk.js resolveDwsBin）
    if (dt.dwsBin !== undefined && typeof dt.dwsBin !== 'string') {
      throw new HttpError(400, 'SETTINGS_INVALID', 'dingtalk.dwsBin 必须为字符串（空串 = 重置为自动解析）');
    }
    requirePositiveInt(dt, 'dwsTimeoutSec', 'dingtalk.dwsTimeoutSec');
    requirePositiveInt(dt, 'maxMessages', 'dingtalk.maxMessages');
  }
  // ⑤-b feishu 节（飞书妙记通道；hostWhitelist 与 dingtalk 同一红线）
  if (body.feishu !== undefined) {
    const fx = body.feishu;
    if (!store.isPlainObject(fx)) throw new HttpError(400, 'SETTINGS_INVALID', 'feishu 必须为对象');
    if (fx.enabled !== undefined && typeof fx.enabled !== 'boolean') {
      throw new HttpError(400, 'SETTINGS_INVALID', 'feishu.enabled 必须为布尔值');
    }
    if (fx.hostWhitelist !== undefined) {
      if (!Array.isArray(fx.hostWhitelist) || fx.hostWhitelist.length === 0) {
        throw new HttpError(400, 'WHITELIST_INVALID', 'feishu.hostWhitelist 必须为非空字符串数组');
      }
      for (const entry of fx.hostWhitelist) {
        const bad = forbiddenWhitelistEntry(entry);
        if (bad) throw new HttpError(400, 'WHITELIST_INVALID', `白名单含禁止项 "${entry}"（${bad}）`);
      }
    }
    // larkBin：字符串即可（空串 = 重置为运行时按已知安装位置自动解析，见 lib/feishu.js resolveLarkBin）
    if (fx.larkBin !== undefined && typeof fx.larkBin !== 'string') {
      throw new HttpError(400, 'SETTINGS_INVALID', 'feishu.larkBin 必须为字符串（空串 = 重置为自动解析）');
    }
    requirePositiveInt(fx, 'larkTimeoutSec', 'feishu.larkTimeoutSec');
    requirePositiveInt(fx, 'maxMessages', 'feishu.maxMessages');
    requirePositiveInt(fx, 'lookbackDays', 'feishu.lookbackDays');
  }
  // ⑥ analyze 节
  if (body.analyze !== undefined) {
    const az = body.analyze;
    if (!store.isPlainObject(az)) throw new HttpError(400, 'SETTINGS_INVALID', 'analyze 必须为对象');
    // dshBin：字符串即可（空串 = 重置为运行时自动解析，见 lib/analyze.js resolveDshBin）
    if (az.dshBin !== undefined && typeof az.dshBin !== 'string') {
      throw new HttpError(400, 'SETTINGS_INVALID', 'analyze.dshBin 必须为字符串（空串 = 重置为自动解析）');
    }
    requirePositiveInt(az, 'timeoutSec', 'analyze.timeoutSec');
    requirePositiveInt(az, 'maxTasksPerMessage', 'analyze.maxTasksPerMessage');
    requirePositiveInt(az, 'maxPromptChars', 'analyze.maxPromptChars');
  }
  // ⑦ gateway 节：v2.2 已随 网关集成整体移除——不校验、不合并、不回填，
  // PATCH 中的 gateway 键被 TOP_LEVEL_ALLOWED 白名单静默丢弃（同 port 口径）

  // ⑥⑦ github 节（v2.9.17 页面化）：仅 enabled/org/baseUrl 三键可经 API——凭据仍走 git config
  // 零落盘（不进页面体系）；eventsPages/hostWhitelist 保持仅手改（携带即 400 防误配）。
  // baseUrl 校验协议 + host 是否在 github.hostWhitelist（自建 GitHub Enterprise 需先手改白名单）
  if (body.github !== undefined) {
    const gh = body.github;
    if (!store.isPlainObject(gh)) throw new HttpError(400, 'SETTINGS_INVALID', 'github 必须为对象');
    const ghForeign = Object.keys(gh).filter((k) => !['enabled', 'org', 'baseUrl'].includes(k));
    if (ghForeign.length > 0) {
      throw new HttpError(
        400,
        'SETTINGS_INVALID',
        `github.${ghForeign[0]} 不可通过 API 修改（仅 enabled/org/baseUrl；eventsPages/hostWhitelist 仅手改 config.json）`
      );
    }
    if (gh.enabled !== undefined && typeof gh.enabled !== 'boolean') {
      throw new HttpError(400, 'SETTINGS_INVALID', 'github.enabled 必须为布尔值');
    }
    if (gh.org !== undefined && (typeof gh.org !== 'string' || gh.org.trim().length > 100)) {
      throw new HttpError(400, 'SETTINGS_INVALID', 'github.org 必须为 ≤100 字符的字符串（空串 = 清除）');
    }
    if (gh.baseUrl !== undefined && gh.baseUrl !== '') {
      let u;
      try { u = new URL(String(gh.baseUrl)); } catch (e) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'github.baseUrl 不是合法 URL');
      }
      const proto = u.protocol.replace(/:$/, '');
      if (!(config.security.allowedProtocols || []).includes(proto)) {
        throw new HttpError(400, 'SETTINGS_INVALID', `github.baseUrl 协议 ${proto} 不在 allowedProtocols`);
      }
      const ghWl = (config.github && Array.isArray(config.github.hostWhitelist)) ? config.github.hostWhitelist : [];
      const ghHost = u.hostname.toLowerCase();
      if (!ghWl.some((w) => String(w).trim().toLowerCase() === ghHost)) {
        throw new HttpError(
          400,
          'HOST_NOT_ALLOWED',
          `github.baseUrl host "${u.hostname}" 不在 github.hostWhitelist（默认 api.github.com；自建 GitHub Enterprise 先手改 config.json 白名单）`
        );
      }
    }
  }

  // ⑥⑧ gitee 节（v2.9.18 页面化）：镜像 github 节口径——仅 enabled/org/baseUrl 三键可经 API；
  // eventsPages/hostWhitelist 仅手改（携带即 400）；baseUrl host 须在 gitee.hostWhitelist
  if (body.gitee !== undefined) {
    const ge = body.gitee;
    if (!store.isPlainObject(ge)) throw new HttpError(400, 'SETTINGS_INVALID', 'gitee 必须为对象');
    const geForeign = Object.keys(ge).filter((k) => !['enabled', 'org', 'baseUrl'].includes(k));
    if (geForeign.length > 0) {
      throw new HttpError(
        400,
        'SETTINGS_INVALID',
        `gitee.${geForeign[0]} 不可通过 API 修改（仅 enabled/org/baseUrl；eventsPages/hostWhitelist 仅手改 config.json）`
      );
    }
    if (ge.enabled !== undefined && typeof ge.enabled !== 'boolean') {
      throw new HttpError(400, 'SETTINGS_INVALID', 'gitee.enabled 必须为布尔值');
    }
    if (ge.org !== undefined && (typeof ge.org !== 'string' || ge.org.trim().length > 100)) {
      throw new HttpError(400, 'SETTINGS_INVALID', 'gitee.org 必须为 ≤100 字符的字符串（空串 = 清除）');
    }
    if (ge.baseUrl !== undefined && ge.baseUrl !== '') {
      let gu;
      try { gu = new URL(String(ge.baseUrl)); } catch (e) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'gitee.baseUrl 不是合法 URL');
      }
      const gproto = gu.protocol.replace(/:$/, '');
      if (!(config.security.allowedProtocols || []).includes(gproto)) {
        throw new HttpError(400, 'SETTINGS_INVALID', `gitee.baseUrl 协议 ${gproto} 不在 allowedProtocols`);
      }
      const geWl = (config.gitee && Array.isArray(config.gitee.hostWhitelist)) ? config.gitee.hostWhitelist : [];
      const geHost = gu.hostname.toLowerCase();
      if (!geWl.some((w) => String(w).trim().toLowerCase() === geHost)) {
        throw new HttpError(
          400,
          'HOST_NOT_ALLOWED',
          `gitee.baseUrl host "${gu.hostname}" 不在 gitee.hostWhitelist（默认 gitee.com；自建/企业实例先手改 config.json 白名单）`
        );
      }
    }
  }

  // ⑧ agentActivity 节（v2.2 智能体工作观测）：总开关/限额为正整数，sources 各源
  // enabled 布尔 + root/dbPath 字符串（空串 = 回退本机默认位置），含桌面成员源 codex/opencode
  let agentActivityPatch;
  if (body.agentActivity !== undefined) {
    const aa = body.agentActivity;
    if (!store.isPlainObject(aa)) throw new HttpError(400, 'SETTINGS_INVALID', 'agentActivity 必须为对象');
    if (aa.enabled !== undefined && typeof aa.enabled !== 'boolean') {
      throw new HttpError(400, 'SETTINGS_INVALID', 'agentActivity.enabled 必须为布尔值');
    }
    for (const k of ['perSourceLimit', 'maxItems', 'previewChars']) {
      requirePositiveInt(aa, k, `agentActivity.${k}`);
    }
    // v2.3 会话阅读器限额：sessionList/transcript 子节（正整数键；normalize 兜底缺省，F1）
    for (const sub of ['sessionList', 'transcript']) {
      if (aa[sub] === undefined) continue;
      if (!store.isPlainObject(aa[sub])) {
        throw new HttpError(400, 'SETTINGS_INVALID', `agentActivity.${sub} 必须为对象`);
      }
      for (const k of Object.keys(agentActivity.DEFAULT_AGENT_ACTIVITY[sub])) {
        if (aa[sub][k] !== undefined) requirePositiveInt(aa[sub], k, `agentActivity.${sub}.${k}`);
      }
    }
    if (aa.sources !== undefined) {
      if (!store.isPlainObject(aa.sources)) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'agentActivity.sources 必须为对象');
      }
      for (const id of agentActivity.ALL_SOURCE_IDS) {
        const s = aa.sources[id];
        if (s === undefined) continue;
        if (!store.isPlainObject(s)) {
          throw new HttpError(400, 'SETTINGS_INVALID', `agentActivity.sources.${id} 必须为对象`);
        }
        if (s.enabled !== undefined && typeof s.enabled !== 'boolean') {
          throw new HttpError(400, 'SETTINGS_INVALID', `agentActivity.sources.${id}.enabled 必须为布尔值`);
        }
        for (const k of ['root', 'dbPath']) {
          if (s[k] !== undefined && typeof s[k] !== 'string') {
            throw new HttpError(400, 'SETTINGS_INVALID', `agentActivity.sources.${id}.${k} 必须为字符串（空串 = 默认位置）`);
          }
        }
      }
    }
    agentActivityPatch = aa; // 全节参与合并（normalize 回填兜底缺省键）
  }

  // ⑨ im 节（v2.9.39 IM 通知：飞书/钉钉自定义机器人）。URL 必过出站闸（私网/回环拒绝），
  // secret 只校验类型与长度——值本身不回显、不进日志（HMAC 用，属加签密钥）
  if (body.im !== undefined) {
    const im = body.im;
    if (!store.isPlainObject(im)) throw new HttpError(400, 'SETTINGS_INVALID', 'im 必须为对象');
    if (im.enabled !== undefined && typeof im.enabled !== 'boolean') {
      throw new HttpError(400, 'SETTINGS_INVALID', 'im.enabled 必须为布尔值');
    }
    if (im.digest !== undefined) {
      if (!store.isPlainObject(im.digest)) throw new HttpError(400, 'SETTINGS_INVALID', 'im.digest 必须为对象');
      if (im.digest.enabled !== undefined && typeof im.digest.enabled !== 'boolean') {
        throw new HttpError(400, 'SETTINGS_INVALID', 'im.digest.enabled 必须为布尔值');
      }
      if (im.digest.at !== undefined && !HHMM_RE.test(String(im.digest.at))) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'im.digest.at 必须为 HH:MM（24 小时制本地时间）');
      }
    }
    if (im.events !== undefined) {
      if (!store.isPlainObject(im.events)) throw new HttpError(400, 'SETTINGS_INVALID', 'im.events 必须为对象');
      for (const k of ['review', 'completed']) {
        if (im.events[k] !== undefined && typeof im.events[k] !== 'boolean') {
          throw new HttpError(400, 'SETTINGS_INVALID', `im.events.${k} 必须为布尔值`);
        }
      }
    }
    if (im.targets !== undefined) {
      if (!Array.isArray(im.targets)) throw new HttpError(400, 'SETTINGS_INVALID', 'im.targets 必须为数组');
      if (im.targets.length > 4) throw new HttpError(400, 'SETTINGS_INVALID', 'im.targets 最多 4 个');
      // 懒加载：settings 与 webhookOut 互不依赖初始化顺序（webhookOut 又 require giteaClient）
      const { guardWebhookUrl } = require('./webhookOut');
      im.targets.forEach((t, i) => {
        if (!store.isPlainObject(t)) throw new HttpError(400, 'SETTINGS_INVALID', `im.targets[${i}] 必须为对象`);
        if (t.platform !== 'dingtalk' && t.platform !== 'feishu') {
          throw new HttpError(400, 'SETTINGS_INVALID', `im.targets[${i}].platform 仅支持 dingtalk/feishu`);
        }
        if (typeof t.url !== 'string' || t.url.trim() === '') {
          throw new HttpError(400, 'SETTINGS_INVALID', `im.targets[${i}].url 必填`);
        }
        if (t.url.length > 500) throw new HttpError(400, 'SETTINGS_INVALID', `im.targets[${i}].url 超过 500 字符`);
        const guard = guardWebhookUrl(t.url);
        if (!guard.ok) throw new HttpError(400, 'HOST_NOT_ALLOWED', `im.targets[${i}].url: ${guard.reason}`);
        if (t.secret !== undefined && (typeof t.secret !== 'string' || t.secret.length > 200)) {
          throw new HttpError(400, 'SETTINGS_INVALID', `im.targets[${i}].secret 必须为不超过 200 字符的字符串`);
        }
      });
    }
  }

  // ⑩ learn 节（v2.9.44 知识库学习）。root 只做"绝对路径"形状校验——存在性/AGENTS 标记由
  // /api/learn/status 与「测试根路径」校验（配路径时盘可能还没挂，不该拦住保存）
  if (body.learn !== undefined) {
    const l = body.learn;
    if (!store.isPlainObject(l)) throw new HttpError(400, 'SETTINGS_INVALID', 'learn 必须为对象');
    if (l.enabled !== undefined && typeof l.enabled !== 'boolean') {
      throw new HttpError(400, 'SETTINGS_INVALID', 'learn.enabled 必须为布尔值');
    }
    if (l.root !== undefined) {
      if (typeof l.root !== 'string') throw new HttpError(400, 'SETTINGS_INVALID', 'learn.root 必须为字符串');
      if (l.root.length > 400) throw new HttpError(400, 'SETTINGS_INVALID', 'learn.root 超过 400 字符');
      if (l.root.trim() !== '' && !path.isAbsolute(l.root.trim())) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'learn.root 必须是绝对路径（如 D:\\\\knowledge\\\\my-vault）');
      }
    }
    for (const k of ['scope', 'exclude']) {
      if (l[k] === undefined) continue;
      if (!Array.isArray(l[k]) || l[k].some((x) => typeof x !== 'string')) {
        throw new HttpError(400, 'SETTINGS_INVALID', `learn.${k} 必须为字符串数组`);
      }
      if (l[k].length > 50) throw new HttpError(400, 'SETTINGS_INVALID', `learn.${k} 最多 50 项`);
      if (l[k].some((x) => x.length > 200)) throw new HttpError(400, 'SETTINGS_INVALID', `learn.${k} 单项超过 200 字符`);
    }
    // v2.9.52 内置主题：只接受 lib/learnSeeds.js 里声明过的名字（空数组 = 只用知识库）
    if (l.seeds !== undefined) {
      if (!Array.isArray(l.seeds) || l.seeds.some((x) => typeof x !== 'string')) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'learn.seeds 必须为字符串数组');
      }
      const known = require('./learnSeeds').DOMAINS;
      const bad = l.seeds.filter((x) => !known.includes(x));
      if (bad.length) throw new HttpError(400, 'SETTINGS_INVALID', `learn.seeds 含未知主题：${bad.join('、')}（可选：${known.join('、')}）`);
      if (l.seeds.length > 10) throw new HttpError(400, 'SETTINGS_INVALID', 'learn.seeds 最多 10 个主题');
    }
    for (const k of ['dailyNew', 'dailyReview']) {
      if (l[k] === undefined) continue;
      if (!Number.isInteger(l[k]) || l[k] < 0 || l[k] > 10) {
        throw new HttpError(400, 'SETTINGS_INVALID', `learn.${k} 必须为 0..10 的整数`);
      }
    }
    if (l.minutes !== undefined && (!Number.isInteger(l.minutes) || l.minutes < 1 || l.minutes > 240)) {
      throw new HttpError(400, 'SETTINGS_INVALID', 'learn.minutes 必须为 1..240 的整数');
    }
    if (l.engine !== undefined) {
      if (!store.isPlainObject(l.engine)) throw new HttpError(400, 'SETTINGS_INVALID', 'learn.engine 必须为对象');
      if (l.engine.mode !== undefined && !['auto', 'host', 'dsh', 'off'].includes(l.engine.mode)) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'learn.engine.mode 仅支持 auto/host/dsh/off');
      }
      if (l.engine.reasoningEffort !== undefined && (typeof l.engine.reasoningEffort !== 'string' || !['off', 'low', 'medium', 'high', 'max'].includes(l.engine.reasoningEffort))) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'learn.engine.reasoningEffort 仅支持 off/low/medium/high/max');
      }
      if (l.engine.maxTokens !== undefined && (!Number.isInteger(l.engine.maxTokens) || l.engine.maxTokens < 100 || l.engine.maxTokens > 8000)) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'learn.engine.maxTokens 必须为 100..8000 的整数');
      }
      if (l.engine.timeoutSec !== undefined && (!Number.isInteger(l.engine.timeoutSec) || l.engine.timeoutSec < 10 || l.engine.timeoutSec > 1800)) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'learn.engine.timeoutSec 必须为 10..1800 的整数');
      }
    }
  }

    // 仅取白名单顶层键做校验；合并基线取磁盘现值（#8：保留 API 不认识的手改键，
    // 包括 PATCH 间隔期间直接写入磁盘的未知顶层/嵌套键），整体写回
    const patch = {};
    for (const k of TOP_LEVEL_ALLOWED) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    // gateway 节：v2.2 已移除，白名单外顶层键静默丢弃（不合并、不回填）
    // agentActivity 节整体参与合并（normalizeAgentActivity 回填 sources 缺省源）
    if (agentActivityPatch) patch.agentActivity = agentActivityPatch;
    const diskRaw = configPath ? store.readJSON(configPath, null) : null;
    const base = store.isPlainObject(diskRaw) ? diskRaw : store.clone(config);
    const next = deepMerge(base, patch);
    // v2.9.39 im.targets：按平台合并——PATCH 只填一个平台时另一个不得被数组整体替换冲掉；
    // 同平台未给 secret 则沿用旧密钥（页面永远拿不到密钥原文）。显式空数组 = 清空全部。
    if (Array.isArray(body.im && body.im.targets)) {
      const patchTargets = body.im.targets;
      next.im = store.isPlainObject(next.im) ? next.im : {};
      if (patchTargets.length === 0) {
        next.im.targets = [];
      } else {
        const baseList = store.isPlainObject(base.im) && Array.isArray(base.im.targets) ? base.im.targets : [];
        const pool = new Map();
        for (const t of baseList) if (t && typeof t.platform === 'string') pool.set(t.platform, t);
        const merged = [];
        for (const t of patchTargets) {
          const prev = pool.get(t.platform) || {};
          const secret = typeof t.secret === 'string' && t.secret.trim() !== ''
            ? t.secret
            : (typeof prev.secret === 'string' ? prev.secret : undefined);
          merged.push(Object.assign({}, prev, t, secret === undefined ? {} : { secret }));
          pool.delete(t.platform);
        }
        for (const rest of pool.values()) merged.push(rest);
        next.im.targets = merged;
      }
    }
    // 任务雷达节缺省回填：PATCH 基线取磁盘现值，而旧 config.json 尚无 dingtalk/analyze 节——
    // 不回填的话，首次 PATCH 会把运行期 config 的默认注入一并抹掉，雷达被误判「通道未启用」
    //（真实联调 7795 实测复现，勿回退）。按缺省键级合并：局部 PATCH（如只写 enabled）
    // 也不得丢掉 hostWhitelist 等未涉及键的默认值
    next.dingtalk = Object.assign(store.clone(store.DEFAULT_CONFIG.dingtalk), store.isPlainObject(next.dingtalk) ? next.dingtalk : {});
    // 飞书妙记节缺省回填（同 dingtalk 口径）：磁盘无 feishu 节时 PATCH 不得丢掉默认注入
    next.feishu = Object.assign(store.clone(store.DEFAULT_CONFIG.feishu), store.isPlainObject(next.feishu) ? next.feishu : {});
    next.analyze = Object.assign(store.clone(store.DEFAULT_CONFIG.analyze), store.isPlainObject(next.analyze) ? next.analyze : {});
    // v2.2：gateway 节缺省回填已随 网关集成移除——磁盘遗留 gateway 键在 PATCH 写回时一并剥除
    delete next.gateway;
    // security 节缺省回填（同 dingtalk/analyze 口径）：磁盘无 security 节时 PATCH trustedHosts
    // 不得丢掉 allowedProtocols/credentialSource/redactKeys 默认注入（baseUrl 校验依赖 allowedProtocols）
    next.security = Object.assign(store.clone(store.DEFAULT_CONFIG.security), store.isPlainObject(next.security) ? next.security : {});
    // v2.9.17 github 节缺省回填（同 dingtalk/analyze 口径）：磁盘无 github 节或节内无 hostWhitelist/
    // eventsPages 时补默认值，页面 PATCH enabled/org/baseUrl 不得丢掉白名单等手改键的默认注入
    next.github = Object.assign(store.clone(store.DEFAULT_CONFIG.github), store.isPlainObject(next.github) ? next.github : {});
    // v2.9.18 gitee 节缺省回填（同 github 口径）
    next.gitee = Object.assign(store.clone(store.DEFAULT_CONFIG.gitee), store.isPlainObject(next.gitee) ? next.gitee : {});
    // v2.9.39 im 节缺省回填（digest/events 按缺省键级合并，targets 数组整体替换——
    // 旧 config.json 无 im 节时，首次 PATCH 不得抹掉默认开关结构）
    const imBase = store.isPlainObject(next.im) ? next.im : {};
    next.im = Object.assign({}, store.clone(store.DEFAULT_CONFIG.im), imBase, {
      digest: Object.assign({}, store.clone(store.DEFAULT_CONFIG.im.digest), store.isPlainObject(imBase.digest) ? imBase.digest : {}),
      events: Object.assign({}, store.clone(store.DEFAULT_CONFIG.im.events), store.isPlainObject(imBase.events) ? imBase.events : {}),
      targets: Array.isArray(imBase.targets) ? imBase.targets : [],
    });
    // v2.2：智能体工作观测节缺省回填（sources 深合并，防局部 PATCH 抹掉其他源默认开关/路径）
    next.agentActivity = agentActivity.normalizeAgentActivity(next.agentActivity);
    // v2.9.44 learn 节缺省回填（engine 深合并；scope/exclude 数组整体替换，防首次 PATCH 抹掉默认结构）
    const learnBase = store.isPlainObject(next.learn) ? next.learn : {};
    next.learn = Object.assign({}, store.clone(store.DEFAULT_CONFIG.learn), learnBase, {
      scope: Array.isArray(learnBase.scope) && learnBase.scope.length ? learnBase.scope : store.clone(store.DEFAULT_CONFIG.learn.scope),
      exclude: Array.isArray(learnBase.exclude) ? learnBase.exclude : [],
      seeds: Array.isArray(learnBase.seeds) ? learnBase.seeds : store.clone(store.DEFAULT_CONFIG.learn.seeds),
      engine: Object.assign({}, store.clone(store.DEFAULT_CONFIG.learn.engine), store.isPlainObject(learnBase.engine) ? learnBase.engine : {}),
    });
    // 运行期归一化字段回填（磁盘可能是首次写回前的人改值；WP6：port 不再回填——
    // 磁盘无 port 即保持无 port，监听参数不进 config.json）
    if (typeof next.host !== 'string') next.host = config.host;
    return next;
}

function registerSettingsRoutes(router, ctx) {
  router.add('GET', '/api/settings', (c) => {
    const view = redactedView(ctx.config);
    // v1.5：dataDir 只读——回显磁盘原值（相对路径），而非主服务运行期归一化的绝对路径
    view.dataDir = diskDirRaw(ctx.configPath, 'dataDir', view.dataDir);
    // v2.9.41 数据备份状态（只读：份数/最近备份/最近恢复）；懒加载避免 settings↔backup 初始化耦合
    try {
      view.backup = require('./backup').backupStatus(ctx);
    } catch (e) {
      view.backup = null;
    }
    sendJSON(c.res, 200, view);
  });

  router.add('PATCH', '/api/settings', (c) => {
    // #10：security 节默认不可经 API 改动，防改弱脱敏边界；唯一例外 trustedHosts
    //（插件态 Host 防线 allowlist 扩展，与脱敏无关）。注意：Host 防线为启动期快照
    //（plugin/adapter.js createHostGuard），trustedHosts 变更需重启生效。
    if (c.body !== null && typeof c.body === 'object' && !Array.isArray(c.body) && c.body.security !== undefined) {
      const s = c.body.security;
      if (!store.isPlainObject(s)) {
        throw new HttpError(400, 'SETTINGS_INVALID', 'security 必须为对象');
      }
      const foreign = Object.keys(s).filter((k) => k !== 'trustedHosts');
      if (foreign.length > 0) {
        throw new HttpError(
          400,
          'SETTINGS_INVALID',
          `security.${foreign[0]} 不可通过 API 修改（仅允许手改 config.json 后重启；仅 trustedHosts 可经 API 修改）`
        );
      }
    }
    const next = applyPatch(ctx.config, c.body, ctx.configPath);
    // v1.5：dataDir/webDir 已从 PATCH 白名单移除——next 里是磁盘原值，视图先取再恢复运行期值
    const view = redactedView(next);
    view.dataDir = diskDirRaw(ctx.configPath, 'dataDir', view.dataDir);
    store.writeJSON(ctx.configPath, next);
    // #3：pollIntervalSec 变更即时重排轮询器（改前取旧值，ctx.config 覆写后再比较）
    const prevInterval = (ctx.config.gitea || {}).pollIntervalSec;
    // #6：运行期 config 的目录保持启动期归一化后的绝对路径（gitea provider 依赖），
    // PATCH 只改其他键，绝不把绝对路径写回磁盘
    next.dataDir = ctx.config.dataDir;
    next.webDir = ctx.config.webDir;
    ctx.config = next;
    const newInterval = (next.gitea || {}).pollIntervalSec;
    if (typeof ctx.reschedulePoller === 'function' && newInterval !== prevInterval) {
      ctx.reschedulePoller(newInterval);
    }
    sendJSON(c.res, 200, view);
  });
}

module.exports = {
  registerSettingsRoutes,
  redactedView,
  deepMerge,
  forbiddenWhitelistEntry,
  trustedHostEntryError,
  baseUrlError,
};
