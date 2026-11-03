'use strict';
// githubClient.js — v2.9 GitHub 组织动态源适配器。
// 数据源：GET {baseUrl}/orgs/{org}/events（组织级事件流，最新在前，per_page=100 × eventsPages），
// 事件映射到与 giteaClient 完全相同的 11 字段活动模型与词表（commit/pr/branch_created/branch_deleted）：
//   PushEvent.payload.commits[] 逐条 → 'commit'（sha/message 首行+正文首段/commit timestamp）
//   PullRequestEvent action=opened|reopened → 'pr'；action=closed 且 merged → 'pr'（同 url 经
//     type|url 去重与 gitea 口径一致地坍缩为一条，occurredAt 取最新一次事件）
//   CreateEvent ref_type=branch → 'branch_created'；DeleteEvent ref_type=branch → 'branch_deleted'
//   其他事件类型（Watch/Fork/Issues/Release…）跳过 → skippedEventTypes 计数与 distinct 名单
// 红线（与 giteaClient 同一套）：
//   - 凭据 key：git config --global http.<github.baseUrl>/.extraheader（值形如 "Authorization: Bearer ghp_xxx"）
//   - 凭据仅存本模块内存（credCache）+ 注册进 redact；绝不写文件、不进子进程 env、不进日志
//   - 出站前 assertSafeUrl（白名单 = cfg.github.hostWhitelist）+ redirect:'error'
// 状态落盘：data/github-status.json（独立文件，绝不与 gitea-status.json 互相覆盖）。
// enabled !== true 时零出网、零写盘（pollActivities 直接返回 null）。

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { redact, registerSecret } = require('./redact.js');
const { assertSafeUrl, validateWhitelist } = require('./ssrfGuard.js');
const gitea = require('./giteaClient.js');

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------- credential

/** 凭据缓存：gitKey -> value|null。仅内存，进程退出即消失。 */
const credCache = new Map();

function credentialGitKey(cfg) {
  return `http.${cfg.github.baseUrl}/.extraheader`;
}

/**
 * 读 GitHub 预授权凭据（git config --global http.<baseUrl>/.extraheader）。
 * 纪律与 giteaClient.readCredential 一致：execFileSync 直调、不经 shell、不注入 env、注册脱敏。
 * @returns {string|null} 形如 "Authorization: Bearer ghp_xxx"，未配置返回 null（匿名拉公共组织）
 */
function readCredential(cfg) {
  const gitKey = credentialGitKey(cfg);
  if (credCache.has(gitKey)) return credCache.get(gitKey);
  let value = null;
  try {
    const out = execFileSync('git', ['config', '--global', gitKey], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
      // 不传 env —— 子进程环境变量里绝不出现凭据
    });
    value = String(out || '').trim() || null;
  } catch {
    value = null; // 未配置 = 无凭据，真实请求以匿名发出（公共组织可读，限流 60 次/时/IP）
  }
  if (value) {
    registerSecret(value);
    const idx = value.indexOf(':');
    if (idx > 0) registerSecret(value.slice(idx + 1).trim());
  }
  credCache.set(gitKey, value);
  return value;
}

function authHeaders(credential) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'fde-console-activity-poller' // GitHub API 要求 UA，缺失返回 403
  };
  if (!credential) return headers;
  const idx = credential.indexOf(':');
  if (idx > 0) headers[credential.slice(0, idx).trim()] = credential.slice(idx + 1).trim();
  else headers.Authorization = credential;
  return headers;
}

// -------------------------------------------------------------------- http

async function fetchJson(url, credential, cfg, timeoutMs = 15000) {
  assertSafeUrl(url, cfg); // 出站末级复检（白名单 = gitea ∪ github 两节）
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(credential),
      signal: ac.signal,
      redirect: 'error'
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      const err = new Error(redact(`GitHub HTTP ${res.status} ${res.statusText} ${detail} (${url})`));
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

// ------------------------------------------------------------------ mapping

/** api 基址 → 网页基址（https://api.github.com → https://github.com；GHES https://host/api/v3 → https://host） */
function webBaseOf(baseUrl) {
  const u = new URL(String(baseUrl));
  const host = u.hostname.startsWith('api.') ? u.hostname.slice(4) : u.hostname;
  return `${u.protocol}//${host}`;
}

function firstLine(s) {
  return String(s || '').split('\n')[0].trim();
}

/** 提交说明正文首段（与 giteaClient.messageBodyOf 同口径：跳过首行与开头空行，收至下一空行，≤300 字） */
function messageBodyOf(message) {
  const lines = String(message || '').split('\n').slice(1);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  const para = [];
  while (i < lines.length && lines[i].trim() !== '') { para.push(lines[i]); i += 1; }
  const text = para.join('\n').trim();
  return text.length > 300 ? text.slice(0, 300) : text;
}

function stripRefsPrefix(ref) {
  return String(ref || '').replace(/^refs\/heads\//, '');
}

/**
 * GitHub org events → 活动数组（统一 11 字段，词表与 gitea 一致）。
 * @returns {{activities: object[], skippedEventCount: number, skippedEventTypes: string[]}}
 */
function mapEvents(events, sinceMs, fetchedAt, webBase) {
  const activities = [];
  const skippedTypes = new Set();
  let skippedEventCount = 0;

  for (const e of events || []) {
    if (!e) continue;
    const type = String(e.type || '');
    const actor = (e.actor && e.actor.login) || null;
    const repo = (e.repo && e.repo.name) || '';
    const created = String(e.created_at || '');
    const createdMs = Date.parse(created);
    if (Number.isFinite(createdMs) && createdMs < sinceMs) continue; // 条目整体落窗外

    if (type === 'PushEvent') {
      const payload = e.payload || {};
      const branch = stripRefsPrefix(payload.ref) || null;
      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      for (const c of commits) {
        if (!c || !c.sha) continue;
        const ts = Date.parse(c.timestamp);
        const occurredAt = Number.isFinite(ts) ? String(c.timestamp) : created;
        const occMs = Number.isFinite(ts) ? ts : createdMs;
        if (Number.isFinite(occMs) && occMs < sinceMs) continue;
        activities.push({
          type: 'commit',
          actor,
          repo: repo || null,
          branch,
          sha: String(c.sha),
          title: firstLine(c.message),
          messageBody: messageBodyOf(c.message),
          url: `${webBase}/${repo}/commit/${c.sha}`,
          occurredAt,
          fetchedAt
        });
      }
      continue;
    }

    if (type === 'PullRequestEvent') {
      const payload = e.payload || {};
      const pr = payload.pull_request || {};
      const opened = payload.action === 'opened' || payload.action === 'reopened';
      // 真机探针实证：GitHub 会发 action:"merged"（文档未列）——与 closed+merged 同样映射为 pr
      const merged = (payload.action === 'closed' && pr.merged === true) || payload.action === 'merged';
      if (opened || merged) {
        const num = payload.number != null ? payload.number : pr.number;
        activities.push({
          type: 'pr',
          actor,
          repo: repo || null,
          branch: null,
          sha: null,
          title: firstLine(pr.title) || (num != null ? `PR #${num}` : 'PR'),
          messageBody: '',
          url: String(pr.html_url || (num != null && repo ? `${webBase}/${repo}/pulls/${num}` : '')),
          occurredAt: created,
          fetchedAt
        });
      } else {
        skippedEventCount += 1; // synchronize/closed(未合并)/assigned 等不进动态流
        skippedTypes.add(`${type}:${payload.action || '?'}`);
      }
      continue;
    }

    if (type === 'CreateEvent' || type === 'DeleteEvent') {
      const payload = e.payload || {};
      if (payload.ref_type === 'branch' && payload.ref) {
        const branch = String(payload.ref);
        activities.push({
          type: type === 'CreateEvent' ? 'branch_created' : 'branch_deleted',
          actor,
          repo: repo || null,
          branch,
          sha: null,
          title: branch,
          messageBody: '',
          url: `${webBase}/${repo}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`,
          occurredAt: created,
          fetchedAt
        });
        continue;
      }
      skippedEventCount += 1; // ref_type=repository/tag 等
      skippedTypes.add(`${type}:${payload.ref_type || '?'}`);
      continue;
    }

    skippedEventCount += 1;
    if (type) skippedTypes.add(type);
  }
  return { activities, skippedEventCount, skippedEventTypes: [...skippedTypes] };
}

// -------------------------------------------------------------------- poll

/**
 * 轮询 GitHub 组织事件 → 与 Gitea 源共写同一 data/activities.json（mergeActivities 口径一致）。
 * 状态写 data/github-status.json（独立文件）。enabled !== true 时零出网零写盘返回 null。
 * @param {object} [cfg] 缺省 gitea.loadConfig()
 * @returns {Promise<object[]|null>} 落盘后的全量 activity 数组（倒序）；源未启用返回 null
 * @throws HOST_NOT_ALLOWED / DANGEROUS_WHITELIST_ENTRY / GITHUB_ERROR（message 已脱敏）
 */
async function pollActivities(cfg) {
  const conf = cfg || gitea.loadConfig();
  const gh = conf.github || {};
  if (gh.enabled !== true) return null;
  validateWhitelist(conf);

  const fetchedAt = new Date().toISOString();
  const sinceMs = Date.now() - SEVEN_DAYS_MS;
  const base = String(gh.baseUrl || 'https://api.github.com').replace(/\/+$/, '');
  const org = String(gh.org || '').trim();
  const pages = Number(gh.eventsPages) > 0 ? Math.min(Number(gh.eventsPages), 10) : 3;

  let ok = true;
  let lastError = null;
  let rawEvents = [];
  let skippedEventCount = 0;
  const skippedTypeSet = new Set();

  try {
    if (!org) throw new Error('github.org 未配置');
    const credential = readCredential(conf);
    for (let page = 1; page <= pages; page++) {
      const arr = await fetchJson(`${base}/orgs/${encodeURIComponent(org)}/events?per_page=100&page=${page}`, credential, conf);
      const list = Array.isArray(arr) ? arr : [];
      const mapped = mapEvents(list, sinceMs, fetchedAt, webBaseOf(base));
      rawEvents.push(...mapped.activities);
      skippedEventCount += mapped.skippedEventCount;
      for (const t of mapped.skippedEventTypes) skippedTypeSet.add(t);
      if (list.length < 100) break; // 末页
    }
  } catch (err) {
    ok = false;
    lastError = redact((err && err.message) || String(err));
    if (err && (err.code === 'HOST_NOT_ALLOWED' || err.code === 'DANGEROUS_WHITELIST_ENTRY')) {
      // 守卫错误：状态照记，错误原码上抛（路由映射 400 而非 502）
      writeStatus(conf, { enabled: true, ok: false, lastPollAt: fetchedAt, lastError, skippedEventCount, skippedEventTypes: [...skippedTypeSet] });
      throw err;
    }
  }

  // 与 Gitea 源同一存储：读现库 → 合并去重（type|url）→ 滚动 ≤maxActivities → 原子写回
  const max = (conf.gitea && conf.gitea.maxActivities) || 500;
  const merged = gitea.mergeActivities(gitea.readExistingActivities(conf), rawEvents, max);
  // v2.9.33 批次 2：activities 写统一出口（存储迁移后经 store.saveActivities 路由）
  require('./store.js').saveActivities({ activitiesPath: gitea.resolveDataPath(conf, 'activities.json') }, merged);
  writeStatus(conf, {
    enabled: true,
    ok,
    lastPollAt: fetchedAt,
    lastError,
    skippedEventCount,
    skippedEventTypes: [...skippedTypeSet]
  });

  // 归因钩子与 Gitea 轮询同款：失败只记日志，不影响已落盘数据
  try {
    require('./attribute.js').attributeAfterPoll(conf);
  } catch (err) {
    console.error('[attribute] GitHub 轮询后归因失败（不影响轮询）:', redact((err && err.message) || String(err)));
  }

  if (!ok) {
    const err = new Error(lastError || 'GitHub 拉取失败');
    err.code = 'GITHUB_ERROR';
    throw err;
  }
  return merged;
}

function writeStatus(cfg, status) {
  try {
    gitea.atomicWrite(gitea.resolveDataPath(cfg, 'github-status.json'), JSON.stringify(status, null, 2));
  } catch (err) {
    console.error('[github] 状态文件写入失败:', redact((err && err.message) || String(err)));
  }
}

/**
 * 连接探测（v2.9.19 设置页「测试连接」后端）：拉 events 第 1 页 per_page=1（最小流量），
 * 返回 ok/延迟/是否带令牌/最新一条摘要。**不改任何状态文件、与 enabled 开关无关**（开之前先试）。
 * @param {object} cfg 运行期配置
 * @param {{org?:string, baseUrl?:string}} [override] 表单当前值覆盖（保存前先测）
 * @returns {Promise<{ok:boolean, latencyMs:number, hasToken:boolean, total?:number,
 *   latest?:{type:string,repo:string,occurredAt:string}, error?:string, code?:string}>} 永不 throw
 */
async function testConnection(cfg, override = {}) {
  const gh = { ...(cfg.github || {}) };
  if (override.org !== undefined && String(override.org).trim()) gh.org = String(override.org).trim();
  if (override.baseUrl !== undefined && String(override.baseUrl).trim()) gh.baseUrl = String(override.baseUrl).trim();
  const conf = { ...cfg, github: gh };
  const started = Date.now();
  const org = String(gh.org || '').trim();
  if (!org) return { ok: false, latencyMs: 0, hasToken: false, error: 'org 未配置（先填组织名）' };
  try {
    const credential = readCredential(conf);
    const base = String(gh.baseUrl || 'https://api.github.com').replace(/\/+$/, '');
    const arr = await fetchJson(`${base}/orgs/${encodeURIComponent(org)}/events?per_page=1&page=1`, credential, conf);
    const list = Array.isArray(arr) ? arr : [];
    const latest = list[0];
    return {
      ok: true,
      latencyMs: Date.now() - started,
      hasToken: !!credential,
      total: list.length,
      latest: latest
        ? { type: String(latest.type || ''), repo: (latest.repo && latest.repo.name) || '', occurredAt: String(latest.created_at || '') }
        : null
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      hasToken: !!readCredential(conf),
      error: redact((err && err.message) || String(err)),
      code: err && err.code
    };
  }
}

module.exports = { pollActivities, readCredential, mapEvents, webBaseOf, testConnection };
