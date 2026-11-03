'use strict';
// routes-gitea.js — §3 动态/连接测试两个 handler（原生 http，供主路由挂载）。
// 职责边界：只写 handler，不建服务器、不做 Host 头校验（主路由/服务骨架职责）。
// matchedTaskIds 在读取响应时由本 handler 现算（§3 读取口径），绝不落盘（§4）。

const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./redact.js');
const giteaClient = require('./giteaClient.js');
const githubClient = require('./githubClient.js');
const giteeClient = require('./giteeClient.js');
const store = require('./store.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');

/** 测试可注入 cfg 提供器（默认 loadConfig()，每次请求现读，设置 PATCH 后即时生效） */
let configProvider = null;
function setConfigProvider(fn) {
  configProvider = typeof fn === 'function' ? fn : null;
}
function currentCfg() {
  return configProvider ? configProvider() : giteaClient.loadConfig();
}

function dataPath(cfg, name) {
  const dir = path.isAbsolute(cfg.dataDir) ? cfg.dataDir : path.join(PROJECT_ROOT, cfg.dataDir);
  return path.join(dir, name);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

/** SSRF 守卫错误 → §3 的 400 响应（协议违规/host 违规统一 code=HOST_NOT_ALLOWED） */
function guardErrorResponse(res, err) {
  if (err && err.code === 'HOST_NOT_ALLOWED') {
    sendError(res, 400, 'HOST_NOT_ALLOWED', err.message || 'host 不在白名单');
    return true;
  }
  if (err && err.code === 'DANGEROUS_WHITELIST_ENTRY') {
    sendError(res, 400, 'HOST_NOT_ALLOWED', 'host 不在白名单（白名单配置含禁止地址）');
    return true;
  }
  return false;
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error('请求体过大');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ------------------------------------------------------- matchedTaskIds 现算

/** 读任务/动态：v2.9.33 批次 2 收敛到 store 路由（存储迁移后 fs 直读会静默读空——
 *  本地 fs 版 loader 已删除；cfg 形状换为 store 需要的 ctx 形状；返回 .tasks 数组保持调用方契约） */
function loadTasks(cfg) {
  return store.loadTasks({ tasksPath: dataPath(cfg, 'tasks.json') }).tasks;
}

/** 互为 ≥4 字子串（双向 includes，两边都须 ≥4 字符） */
function mutualSubstring(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (x.length < 4 || y.length < 4) return false;
  return x.includes(y) || y.includes(x);
}

/** §3 口径：仓库护栏（跨仓同名 branch/标题不匹配，attribute.repoMismatch 单一事实源）→ branch 精确相等，或 title/branch 互为 ≥4 字子串 */
function matchTaskIds(activity, tasks) {
  const ids = [];
  for (const t of tasks) {
    if (!t || !t.id) continue;
    if (require('./attribute.js').repoMismatch(activity, t)) continue;
    if (t.branch && activity.branch && String(t.branch) === String(activity.branch)) {
      ids.push(t.id);
      continue;
    }
    if (
      mutualSubstring(t.title, activity.title) ||
      mutualSubstring(t.title, activity.branch) ||
      mutualSubstring(t.branch, activity.title) ||
      mutualSubstring(t.branch, activity.branch)
    ) {
      ids.push(t.id);
    }
  }
  return ids;
}

function loadActivities(cfg) {
  return store.loadActivities({ activitiesPath: dataPath(cfg, 'activities.json') });
}

// ------------------------------------------------------------------ handlers

/**
 * GET /api/activities?refresh=1（§3）
 * refresh=1 强制拉取 Gitea；成功/缺省返回 200 数组（响应带 matchedTaskIds，不落盘）。
 * 拉取失败：HOST_NOT_ALLOWED → 400；其他 → 502 GITEA_ERROR（message 已脱敏）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleActivities(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1'); // 仅用于解析 query，host 无关
    const refresh = url.searchParams.get('refresh') === '1';
    const cfg = currentCfg();

    if (refresh) {
      // v2.9 多源编排：Gitea 恒启用 + GitHub 可选；全部启用源都失败才报错，
      // 单源失败不拖垮其余源的数据回流（各源自落 status 文件）
      const errors = [];
      const githubOn = !!(cfg.github && cfg.github.enabled === true);
      try {
        await giteaClient.pollActivities(cfg);
      } catch (err) {
        if (guardErrorResponse(res, err)) return; // 守卫类维持 400 快速失败（config 级错误，重试无意义）
        errors.push(`gitea: ${redact((err && err.message) || String(err))}`);
      }
      if (githubOn) {
        try {
          await githubClient.pollActivities(cfg);
        } catch (err) {
          if (err && (err.code === 'HOST_NOT_ALLOWED' || err.code === 'DANGEROUS_WHITELIST_ENTRY')) {
            return sendError(res, 400, err.code, redact((err && err.message) || String(err)));
          }
          errors.push(`github: ${redact((err && err.message) || String(err))}`);
        }
      }
      // v2.9.18 Gitee 源：同款独立 try/catch——单源失败不拖垮其他源
      const giteeOn = !!(cfg.gitee && cfg.gitee.enabled === true);
      if (giteeOn) {
        try {
          await giteeClient.pollActivities(cfg);
        } catch (err) {
          if (err && (err.code === 'HOST_NOT_ALLOWED' || err.code === 'DANGEROUS_WHITELIST_ENTRY')) {
            return sendError(res, 400, err.code, redact((err && err.message) || String(err)));
          }
          errors.push(`gitee: ${redact((err && err.message) || String(err))}`);
        }
      }
      const enabledSources = 1 + (githubOn ? 1 : 0) + (giteeOn ? 1 : 0);
      if (errors.length > 0 && errors.length === enabledSources) {
        return sendError(res, 502, 'GITEA_ERROR', errors.join('; '));
      }
    }

    const tasks = loadTasks(cfg);
    const out = loadActivities(cfg).map((a) => ({ ...a, matchedTaskIds: matchTaskIds(a, tasks) }));
    return sendJson(res, 200, out);
  } catch (err) {
    return sendError(res, 500, 'INTERNAL_ERROR', redact((err && err.message) || String(err)));
  }
}

/**
 * POST /api/gitea/test（§3）：{"baseUrl"} 省略用 config 值。
 * 白名单外 → 400 HOST_NOT_ALLOWED；否则 200 {ok,latencyMs,apiVersion}。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleGiteaTest(req, res) {
  try {
    const cfg = currentCfg();
    let body = {};
    const raw = await readBody(req);
    if (raw && raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return sendError(res, 400, 'INVALID_JSON', '请求体不是合法 JSON');
      }
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return sendError(res, 400, 'INVALID_JSON', '请求体必须是 JSON 对象');
    }
    const baseUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : cfg.gitea.baseUrl;

    let result;
    try {
      result = await giteaClient.testConnection(baseUrl, cfg);
    } catch (err) {
      if (guardErrorResponse(res, err)) return;
      return sendError(res, 502, 'GITEA_ERROR', redact((err && err.message) || String(err)));
    }
    const payload = { ok: result.ok, latencyMs: result.latencyMs, apiVersion: result.apiVersion };
    if (!result.ok) payload.error = result.error;
    return sendJson(res, 200, payload);
  } catch (err) {
    const code = err && err.code;
    if (code === 'PAYLOAD_TOO_LARGE') return sendError(res, 400, 'INVALID_JSON', '请求体过大');
    return sendError(res, 500, 'INTERNAL_ERROR', redact((err && err.message) || String(err)));
  }
}

/**
 * POST /api/sources/test（v2.9.19 设置页「测试连接」扩展到 GitHub/Gitee 源）：
 * {"source":"github"|"gitee", "org"?, "baseUrl"?}——org/baseUrl 缺省用 config 值（表单当前值可覆盖，
 * 保存前先测）。探测只拉 events 第 1 页 per_page=1，与 enabled 开关无关、不改任何状态文件。
 * 白名单/守卫类错误 → 400；其余失败 → 200 {ok:false,error}（测试语义不 5xx）。
 */
async function handleSourceTest(req, res) {
  try {
    let body = {};
    const raw = await readBody(req);
    if (raw && raw.trim()) {
      try { body = JSON.parse(raw); } catch { return sendError(res, 400, 'INVALID_JSON', '请求体不是合法 JSON'); }
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return sendError(res, 400, 'INVALID_JSON', '请求体必须是 JSON 对象');
    }
    const source = String(body.source || '');
    if (source !== 'github' && source !== 'gitee') {
      return sendError(res, 400, 'SOURCE_INVALID', 'source 必须为 github/gitee');
    }
    const override = {};
    for (const k of ['org', 'baseUrl']) {
      if (body[k] !== undefined) {
        if (typeof body[k] !== 'string') return sendError(res, 400, 'SETTINGS_INVALID', `github.${k} 必须为字符串`);
        override[k] = body[k];
      }
    }
    const cfg = currentCfg();
    const result = source === 'github'
      ? await githubClient.testConnection(cfg, override)
      : await giteeClient.testConnection(cfg, override);
    if (result.code === 'HOST_NOT_ALLOWED' || result.code === 'DANGEROUS_WHITELIST_ENTRY') {
      return sendError(res, 400, result.code, result.error || '出站地址被守卫拒绝');
    }
    return sendJson(res, 200, result);
  } catch (err) {
    const code = err && err.code;
    if (code === 'PAYLOAD_TOO_LARGE') return sendError(res, 400, 'INVALID_JSON', '请求体过大');
    return sendError(res, 500, 'INTERNAL_ERROR', redact((err && err.message) || String(err)));
  }
}

module.exports = { handleActivities, handleGiteaTest, handleSourceTest, setConfigProvider, matchTaskIds };
