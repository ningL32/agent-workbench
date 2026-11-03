'use strict';
// giteeClient.js — v2.9.18 Gitee（gitee.com）组织动态源适配器。
// 数据源：GET {baseUrl}/api/v5/orgs/{org}/events（组织级事件流，最新在前，per_page=100 × eventsPages），
// 真机探针实证（2026-10-25，示例组织）：事件 GitHub 风格——type=PushEvent 同名，但字段差异：
//   - repo 用 full_name（GitHub 是 repo.name）
//   - payload.commits[] 无 timestamp 字段（GitHub 有）→ occurredAt 退事件 created_at
//   - payload.commits[].url 是 API 地址（/api/v5/...）→ 动态链接自拼 {baseUrl}/{full_name}/commit/{sha}
//   - created_at 带 +08:00 时区（Date.parse 可解析）
// 映射到与 giteaClient/githubClient 完全相同的 11 字段活动模型与词表（commit/pr/branch_created/branch_deleted）：
//   PushEvent.payload.commits[] 逐条 → 'commit'
//   PullRequestEvent / CreateEvent / DeleteEvent 按 GitHub 同构口径容错映射（Gitee v5 与 GitHub 事件
//   类型命名同族；窗口内未实证到样本的类型由 skippedEventTypes 计数兜底，映射不炸）
//   其他事件类型（Issue/Note/PushHook…）跳过 → skippedEventTypes 计数与 distinct 名单
// 红线（与 gitea/github 两 client 同一套）：
//   - 凭据 key：git config --global http.<gitee.baseUrl>/.extraheader（值 = 私人令牌原文，非 header）
//   - 凭据仅存本模块内存（credCache）+ 注册进 redact；绝不写文件、不进子进程 env、不进日志
//   - Gitee v5 令牌走 URL query（access_token）——错误消息出 URL 前先剥参再 redact（双防线）
//   - 出站前 assertSafeUrl（白名单 = gitea ∪ github ∪ gitee 三节）+ redirect:'error'
// 状态落盘：data/gitee-status.json（独立文件，绝不与 gitea/github-status.json 互相覆盖）。
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
  return `http.${cfg.gitee.baseUrl}/.extraheader`;
}

/**
 * 读 Gitee 私人令牌（git config --global http.<baseUrl>/.extraheader，值 = 令牌原文）。
 * 纪律与 gitea/github 两 client 一致：execFileSync 直调、不经 shell、不注入 env、注册脱敏。
 * @returns {string|null} 令牌原文，未配置返回 null（公开组织匿名可拉，限流更严）
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
    value = null;
  }
  if (value) registerSecret(value);
  credCache.set(gitKey, value);
  return value;
}

// -------------------------------------------------------------------- http

/** URL 出错误消息前剥掉 access_token 参数（令牌不进日志/状态文件的第一道防线），再过 redact */
function scrubUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.searchParams.has('access_token')) {
      u.searchParams.set('access_token', REDACTED);
      return u.toString();
    }
    return String(url);
  } catch {
    return String(url);
  }
}

async function fetchJson(url, token, cfg, timeoutMs = 15000) {
  assertSafeUrl(url, cfg); // 出站末级复检（白名单 = gitea ∪ github ∪ gitee 三节）
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'fde-console-activity-poller' },
      signal: ac.signal,
      redirect: 'error'
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      const err = new Error(redact(`Gitee HTTP ${res.status} ${res.statusText} ${detail} (${scrubUrl(url)})`));
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

/** 带 access_token query 参数的事件流 URL（scrubUrl 保证令牌不进任何错误出口） */
function eventsUrl(cfg, org, page) {
  const base = String(cfg.gitee.baseUrl || 'https://gitee.com').replace(/\/+$/, '');
  const token = readCredential(cfg);
  const u = new URL(`${base}/api/v5/orgs/${encodeURIComponent(org)}/events`);
  u.searchParams.set('per_page', '100');
  u.searchParams.set('page', String(page));
  if (token) u.searchParams.set('access_token', token);
  return u.toString();
}

// ------------------------------------------------------------------ mapping

function firstLine(s) {
  return String(s || '').split('\n')[0].trim();
}

/** 提交说明正文首段（与 gitea/github 两 client 同口径：跳过首行与开头空行，收至下一空行，≤300 字） */
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
 * Gitee org events → 活动数组（统一 11 字段，词表与 gitea/github 一致）。
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
    const repo = (e.repo && (e.repo.full_name || e.repo.name)) || ''; // 探针实证：Gitee 用 full_name
    const created = String(e.created_at || '');
    const createdMs = Date.parse(created);
    if (Number.isFinite(createdMs) && createdMs < sinceMs) continue; // 条目整体落窗外

    if (type === 'PushEvent') {
      const payload = e.payload || {};
      const branch = stripRefsPrefix(payload.ref) || null;
      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      for (const c of commits) {
        if (!c || !c.sha) continue;
        // 探针实证：Gitee commit 无 timestamp（GitHub 有）→ occurredAt 退事件 created_at
        activities.push({
          type: 'commit',
          actor,
          repo: repo || null,
          branch,
          sha: String(c.sha),
          title: firstLine(c.message),
          messageBody: messageBodyOf(c.message),
          // commits[].url 是 API 地址（/api/v5/...）——动态链接自拼 web 地址
          url: `${webBase}/${repo}/commit/${c.sha}`,
          occurredAt: created,
          fetchedAt
        });
      }
      continue;
    }

    if (type === 'PullRequestEvent') {
      // GitHub 同构容错：Gitee v5 事件类型命名与 GitHub 同族，PR 事件按同款字段口径映射；
      // 字段缺席自然走 skipped 计数，不炸轮询
      const payload = e.payload || {};
      const pr = payload.pull_request || payload;
      const action = String(payload.action || '');
      const opened = action === 'opened' || action === 'reopened';
      const merged = (action === 'closed' && pr.merged === true) || action === 'merged';
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
        skippedEventCount += 1;
        skippedTypes.add(`${type}:${action || '?'}`);
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
 * 轮询 Gitee 组织事件 → 与 Gitea/GitHub 源共写同一 data/activities.json（mergeActivities 口径一致）。
 * 状态写 data/gitee-status.json（独立文件）。enabled !== true 时零出网零写盘返回 null。
 * @param {object} [cfg] 缺省 gitea.loadConfig()
 * @returns {Promise<object[]|null>} 落盘后的全量 activity 数组（倒序）；源未启用返回 null
 * @throws HOST_NOT_ALLOWED / DANGEROUS_WHITELIST_ENTRY / GITEE_ERROR（message 已脱敏）
 */
async function pollActivities(cfg) {
  const conf = cfg || gitea.loadConfig();
  const ge = conf.gitee || {};
  if (ge.enabled !== true) return null;
  validateWhitelist(conf);

  const fetchedAt = new Date().toISOString();
  const sinceMs = Date.now() - SEVEN_DAYS_MS;
  const base = String(ge.baseUrl || 'https://gitee.com').replace(/\/+$/, '');
  const org = String(ge.org || '').trim();
  const pages = Number(ge.eventsPages) > 0 ? Math.min(Number(ge.eventsPages), 10) : 3;

  let ok = true;
  let lastError = null;
  let rawEvents = [];
  let skippedEventCount = 0;
  const skippedTypeSet = new Set();

  try {
    if (!org) throw new Error('gitee.org 未配置');
    // fetch 期 conf.github/baseUrl 覆写为 gitee 节口径——assertSafeUrl 白名单按节取，构造时透传整包即可
    for (let page = 1; page <= pages; page++) {
      const url = eventsUrl(conf, org, page);
      const arr = await fetchJson(url, readCredential(conf), conf);
      const list = Array.isArray(arr) ? arr : [];
      const mapped = mapEvents(list, sinceMs, fetchedAt, base);
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

  // 与 Gitea/GitHub 源同一存储：读现库 → 合并去重（type|url）→ 滚动 ≤maxActivities → 原子写回
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

  // 归因钩子与 Gitea/GitHub 轮询同款：失败只记日志，不影响已落盘数据
  try {
    require('./attribute.js').attributeAfterPoll(conf);
  } catch (err) {
    console.error('[attribute] Gitee 轮询后归因失败（不影响轮询）:', redact((err && err.message) || String(err)));
  }

  if (!ok) {
    const err = new Error(lastError || 'Gitee 拉取失败');
    err.code = 'GITEE_ERROR';
    throw err;
  }
  return merged;
}

function writeStatus(cfg, status) {
  try {
    gitea.atomicWrite(gitea.resolveDataPath(cfg, 'gitee-status.json'), JSON.stringify(status, null, 2));
  } catch (err) {
    console.error('[gitee] 状态文件写入失败:', redact((err && err.message) || String(err)));
  }
}

/**
 * 连接探测（v2.9.19 设置页「测试连接」后端，镜像 githubClient 同名函数）：
 * 拉 events 第 1 页 per_page=1（最小流量）。不改状态文件、与 enabled 开关无关。
 * @param {{org?:string, baseUrl?:string}} [override] 表单当前值覆盖（保存前先测）
 * @returns {Promise<{ok:boolean, latencyMs:number, hasToken:boolean, total?:number,
 *   latest?:{type:string,repo:string,occurredAt:string}, error?:string, code?:string}>} 永不 throw
 */
async function testConnection(cfg, override = {}) {
  const ge = { ...(cfg.gitee || {}) };
  if (override.org !== undefined && String(override.org).trim()) ge.org = String(override.org).trim();
  if (override.baseUrl !== undefined && String(override.baseUrl).trim()) ge.baseUrl = String(override.baseUrl).trim();
  const conf = { ...cfg, gitee: ge };
  const started = Date.now();
  const org = String(ge.org || '').trim();
  if (!org) return { ok: false, latencyMs: 0, hasToken: false, error: 'org 未配置（先填组织名）' };
  try {
    const base = String(ge.baseUrl || 'https://gitee.com').replace(/\/+$/, '');
    const u = new URL(`${base}/api/v5/orgs/${encodeURIComponent(org)}/events`);
    u.searchParams.set('per_page', '1');
    u.searchParams.set('page', '1');
    const token = readCredential(conf);
    if (token) u.searchParams.set('access_token', token);
    const arr = await fetchJson(u.toString(), token, conf);
    const list = Array.isArray(arr) ? arr : [];
    const latest = list[0];
    return {
      ok: true,
      latencyMs: Date.now() - started,
      hasToken: !!token,
      total: list.length,
      latest: latest
        ? { type: String(latest.type || ''), repo: (latest.repo && (latest.repo.full_name || latest.repo.name)) || '', occurredAt: String(latest.created_at || '') }
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

module.exports = { pollActivities, readCredential, mapEvents, eventsUrl, scrubUrl, testConnection };
