'use strict';

/**
 * imNotify.js — v2.9.39 IM 通知出口（飞书 / 钉钉 自定义机器人）
 *
 * 定位：把「等你处理的事」推到群里，不引入任何第三方依赖——两家自定义机器人都是
 * 「一次 HTTPS POST + 一个 JSON」，Node 内置 fetch + crypto 就够（npm SDK 只会破红线 1）。
 *
 * 纪律（与 webhookOut 同源，逐条有出处）：
 *  - **fire-and-forget**：事件路径上不 await、不抛出，任何失败只 console.error（过 redact）
 *  - **零出网闸**：目标 URL 必过 webhookOut.guardWebhookUrl（http(s) + 私网/回环/链路本地拒绝）
 *  - **凭据不出错误出口**：url 里的 access_token 只经 scrubUrl/hostOf 露出 host；
 *    secret（加签密钥）绝不进日志、不进响应
 *  - **业务失败要认**：两家都用 HTTP 200 + body 里的 errcode/code 表示失败（钉钉 310000=签名错、
 *    飞书 19021=签名错），必须读 body，否则「发送成功」是假的（红线 8：失败必须留痕）
 *  - **不重试**：事件有 task_events 滚动窗兜底；摘要每天最多 3 次尝试，防刷屏
 *
 * 配置（config.im，见 store.DEFAULT_CONFIG 与 mergeConfigDefaults）：
 *   { enabled, digest:{enabled,at:'HH:MM'}, events:{review,completed},
 *     targets:[{platform:'dingtalk'|'feishu', url, secret?}] }
 */

const crypto = require('node:crypto');
const path = require('node:path');

const store = require('./store');
const { redact } = require('./redact');
const { guardWebhookUrl, scrubUrl } = require('./webhookOut');
const { HttpError, sendJSON } = require('./router');

const TIMEOUT_MS = 8000;
const MAX_TARGETS = 4;
const MAX_TEXT_CHARS = 1800;
const DIGEST_MAX_ATTEMPTS = 3;
const DIGEST_MARKER = 'im-digest.json';

const PLATFORMS = { dingtalk: '钉钉', feishu: '飞书' };
// 事件类型 → 人读标签（只推这两类，其余事件不打扰）
const EVENT_LABELS = { review: '待验收', completed: '已完成' };

// ---------- 签名 ----------

function hmacB64(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('base64');
}

/**
 * 钉钉加签：timestamp(ms) + "\n" + secret 作待签串，**secret 作 HMAC key**，base64 后 URL 编码进 query。
 * 未配 secret 则原样返回（机器人可改用「自定义关键词」或「IP 白名单」安全模式）。
 */
function dingtalkSignedUrl(rawUrl, secret) {
  if (!secret) return rawUrl;
  const ts = String(Date.now());
  const u = new URL(rawUrl);
  u.searchParams.set('timestamp', ts);
  u.searchParams.set('sign', hmacB64(secret, `${ts}\n${secret}`));
  return u.toString();
}

/**
 * 飞书签名：timestamp(秒) + "\n" + secret，**整串既作 HMAC key 也作待签串**（官方口径），
 * 结果 base64 后与 timestamp 一起放进 body。
 */
function feishuSign(secret) {
  if (!secret) return null;
  const ts = String(Math.floor(Date.now() / 1000));
  return { timestamp: ts, sign: hmacB64(`${ts}\n${secret}`, '') };
}

// ---------- 报文 ----------

function clip(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 平台差异只在这里：钉钉走 markdown，飞书走 text（飞书 text 不渲染 markdown 语法） */
function buildBody(platform, title, lines, secret) {
  const body = Array.isArray(lines) ? lines : [];
  if (platform === 'dingtalk') {
    const text = clip([`### ${title}`, '', ...body].join('\n\n'), MAX_TEXT_CHARS);
    return { msgtype: 'markdown', markdown: { title: clip(title, 60), text } };
  }
  if (platform === 'feishu') {
    const text = clip([title, '', ...body].join('\n'), MAX_TEXT_CHARS);
    const out = { msg_type: 'text', content: { text } };
    const s = feishuSign(secret);
    if (s) Object.assign(out, s);
    return out;
  }
  throw new Error(`不支持的平台: ${platform}`);
}

/** 200 里的业务失败识别：钉钉 errcode / 飞书 code（两者 0 才是成功） */
function businessError(platform, detail) {
  if (!detail || typeof detail !== 'object') return null;
  if (platform === 'dingtalk') {
    const code = detail.errcode;
    if (code === undefined || code === 0) return null;
    return `钉钉拒绝: ${code} ${detail.errmsg || ''}`.trim();
  }
  const code = detail.code !== undefined ? detail.code : detail.StatusCode;
  if (code === undefined || code === 0) return null;
  return `飞书拒绝: ${code} ${detail.msg || detail.StatusMessage || ''}`.trim();
}

function hostOf(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).host;
  } catch (e) {
    return '[invalid-url]';
  }
}

/** 目标列表归一化：丢掉无效项但**留痕**（静默缺席视为缺陷，红线 8） */
function normalizeTargets(config) {
  const sec = (config && config.im) || {};
  const list = Array.isArray(sec.targets) ? sec.targets.slice(0, MAX_TARGETS) : [];
  const targets = [];
  const skipped = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') {
      skipped.push({ reason: '条目不是对象' });
      continue;
    }
    const platform = PLATFORMS[t.platform] ? t.platform : null;
    const url = String(t.url || '').trim();
    if (!platform) {
      skipped.push({ platform: String(t.platform || ''), reason: '平台仅支持 dingtalk/feishu' });
      continue;
    }
    if (!url) {
      skipped.push({ platform, reason: 'url 为空' });
      continue;
    }
    const guard = guardWebhookUrl(url);
    if (!guard.ok) {
      skipped.push({ platform, host: hostOf(url), reason: guard.reason });
      continue;
    }
    targets.push({ platform, url, secret: typeof t.secret === 'string' ? t.secret.trim() : '' });
  }
  return { targets, skipped };
}

// ---------- 发送 ----------

/**
 * 单目标发送（唯一出网点）。永不抛出：失败返回 {ok:false,error}。
 * @param {{platform:string,url:string,secret:string}} target
 * @param {{fetcher?:function}} opts 测试注入缝（零出网断言请求体）
 */
async function sendOne(target, title, lines, opts) {
  const o = opts || {};
  const fetcher = typeof o.fetcher === 'function' ? o.fetcher : globalThis.fetch;
  if (typeof fetcher !== 'function') return { platform: target.platform, ok: false, error: '无 fetch 实现' };

  let url;
  let payload;
  try {
    url = target.platform === 'dingtalk' ? dingtalkSignedUrl(target.url, target.secret) : target.url;
    payload = buildBody(target.platform, title, lines, target.secret);
  } catch (e) {
    return { platform: target.platform, ok: false, error: String((e && e.message) || e) };
  }

  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'fde-console-im/1.0' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let detail = null;
    try {
      detail = await res.json();
    } catch (e) {
      detail = null; // 非 JSON 响应：只看 HTTP 码
    }
    const biz = businessError(target.platform, detail);
    if (!res.ok || biz) {
      return { platform: target.platform, ok: false, status: res.status, error: biz || `HTTP ${res.status}` };
    }
    return { platform: target.platform, ok: true, status: res.status };
  } catch (e) {
    // 错误信息可能含完整 URL（token 在 query），出口统一 scrub + redact
    return {
      platform: target.platform,
      ok: false,
      error: redact(String((e && e.message) || e).replace(target.url, scrubUrl(target.url))),
    };
  }
}

/** 向所有可用目标发同一内容；返回 {ok, results, skipped} */
async function sendAll(config, title, lines, opts) {
  const { targets, skipped } = normalizeTargets(config);
  if (!targets.length) return { ok: false, results: [], skipped };
  const results = await Promise.all(targets.map((t) => sendOne(t, title, lines, opts)));
  return { ok: results.some((r) => r.ok), results, skipped };
}

// ---------- 事件推送 ----------

function eventKind(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'completed') return 'completed';
  if (event.type === 'status' && event.to === 'review') return 'review';
  return null;
}

/**
 * 任务事件即时推（在 taskEvents.appendEvents 落盘之后调用）：
 * 只认 config.im.events 打开的两类（待验收 / 已完成），未知事件一律不出网。
 * @param {object} ctx 应用上下文（取 task 标题用；缺 tasks 也能发，只是标题退化为 taskId）
 */
function fireTaskEvents(ctx, events, opts) {
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  if (!list.length) return { fired: 0, reason: '无事件' };

  const sec = (ctx && ctx.config && ctx.config.im) || {};
  if (sec.enabled !== true) return { fired: 0, reason: 'disabled' };
  const switches = sec.events || {};
  const picked = list.map((e) => ({ e, kind: eventKind(e) })).filter((x) => x.kind && switches[x.kind] === true);
  if (!picked.length) return { fired: 0, reason: '无匹配事件类型' };

  const { targets } = normalizeTargets(ctx.config);
  if (!targets.length) return { fired: 0, reason: '未配置可用目标' };

  // fire-and-forget：不 await、不抛出，失败只留痕
  Promise.resolve()
    .then(() => {
      const titles = new Map();
      try {
        const data = store.loadTasks(ctx);
        for (const t of data.tasks || []) titles.set(t.id, t.title || t.id);
      } catch (e) {
        /* 标题拿不到不影响推送：退化为 taskId */
      }
      const lines = picked.map(({ e, kind }) => {
        const title = titles.get(e.taskId) || e.taskId;
        const detail = String(e.detail || '').trim();
        return `· **${title}** → ${EVENT_LABELS[kind]}${detail ? `（${detail}）` : ''}`;
      });
      return sendAll(ctx.config, 'FDE 指挥台 · 任务动态', lines, opts).then((r) => {
        for (const bad of r.results.filter((x) => !x.ok)) {
          console.error(`[im] 事件推送失败 platform=${bad.platform} status=${bad.status || '-'}:`, redact(String(bad.error || '')));
        }
      });
    })
    .catch((e) => console.error('[im] 事件派发异常（不影响任务写路径）:', redact(String((e && e.message) || e))));

  return { fired: picked.length * targets.length };
}

// ---------- 每日摘要 ----------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function hhmm(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 摘要内容：逾期 / 待验收 / 收件箱待确认 / 昨日完成（全部读时聚合，零新存储） */
function buildDigest(ctx, now) {
  const today = ymd(now);
  const yesterday = ymd(new Date(now.getTime() - 24 * 3600 * 1000));
  const tasks = (store.loadTasks(ctx).tasks || []);
  const overdue = tasks.filter((t) => typeof t.dueDate === 'string' && t.dueDate < today && t.status !== 'done');
  const review = tasks.filter((t) => t.status === 'review');
  let pending = [];
  try {
    pending = (store.loadInbox(ctx) || []).filter((c) => c && c.state === 'pending');
  } catch (e) {
    pending = [];
  }
  const doneYesterday = tasks.filter((t) => typeof t.completedAt === 'string' && t.completedAt.slice(0, 10) === yesterday);

  const brief = (list) => list.slice(0, 3).map((t) => `· ${t.title || t.id}${t.dueDate ? `（${t.dueDate}）` : ''}`);
  const lines = [
    `逾期 ${overdue.length} · 待验收 ${review.length} · 收件箱待确认 ${pending.length} · 昨日完成 ${doneYesterday.length}`,
  ];
  if (overdue.length) lines.push('', '**逾期**', ...brief(overdue));
  if (review.length) lines.push('', '**待验收**', ...brief(review));
  if (pending.length) lines.push('', '**收件箱**', ...pending.slice(0, 3).map((c) => `· ${c.title || c.id}`));
  if (!overdue.length && !review.length && !pending.length) lines.push('', '今天没有卡住的事。');
  return { title: `FDE 指挥台 · ${today} 待办`, lines, counts: { overdue: overdue.length, review: review.length, pending: pending.length, doneYesterday: doneYesterday.length } };
}

function markerPath(ctx) {
  return path.join(ctx.dataDir, DIGEST_MARKER);
}

function readMarker(ctx) {
  try {
    const d = store.readJSON(markerPath(ctx), null);
    return store.isPlainObject(d) ? d : {};
  } catch (e) {
    return {};
  }
}

/**
 * 每日摘要调度（由 pollTick 每分钟调用）：到点且当日未成功发过才发；一天最多 3 次尝试，防刷屏。
 * 标记先写后发：宁可当天发不出（下次再看），也不要在群里连刷同样的内容。
 */
async function maybeRunDigest(ctx, opts) {
  const o = opts || {};
  const sec = (ctx && ctx.config && ctx.config.im) || {};
  if (sec.enabled !== true) return { sent: false, reason: 'disabled' };
  const dg = sec.digest || {};
  if (dg.enabled !== true) return { sent: false, reason: 'digest disabled' };
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(dg.at || '')) ? dg.at : '09:10';

  const now = o.now instanceof Date ? o.now : new Date();
  if (hhmm(now) < at) return { sent: false, reason: '未到点' };

  const today = ymd(now);
  const marker = readMarker(ctx);
  if (marker.lastSentDate === today) return { sent: false, reason: '今日已发' };
  const attempts = marker.date === today ? Number(marker.attempts) || 0 : 0;
  if (attempts >= DIGEST_MAX_ATTEMPTS) return { sent: false, reason: '今日尝试次数已用完' };

  const { targets } = normalizeTargets(ctx.config);
  if (!targets.length) return { sent: false, reason: '未配置可用目标' };

  // 先落尝试记录（失败也能被下次看到，且不会无限重试）
  store.writeJSON(markerPath(ctx), { date: today, attempts: attempts + 1, at, lastAttemptAt: now.toISOString(), lastSentDate: marker.lastSentDate || null });

  const digest = buildDigest(ctx, now);
  const r = await sendAll(ctx.config, digest.title, digest.lines, opts);
  for (const bad of r.results.filter((x) => !x.ok)) {
    console.error(`[im] 摘要推送失败 platform=${bad.platform} status=${bad.status || '-'}:`, redact(String(bad.error || '')));
  }
  if (r.ok) {
    store.writeJSON(markerPath(ctx), { date: today, attempts: attempts + 1, at, lastAttemptAt: now.toISOString(), lastSentDate: today });
  }
  return { sent: r.ok, results: r.results, counts: digest.counts };
}

// ---------- 路由 ----------

function registerImRoutes(router, ctx) {
  // 配置校验专用：保存前先发一条，收到即通道可用（与 /api/sources/test 同款语义：失败走 200 + ok:false）
  router.add('POST', '/api/im/test', async (c) => {
    const { targets } = normalizeTargets(ctx.config);
    if (!targets.length) {
      throw new HttpError(400, 'IM_NOT_CONFIGURED', '未配置可用的 IM 目标（config.im.targets，平台仅 dingtalk/feishu）');
    }
    const r = await sendAll(ctx.config, 'FDE 指挥台 · 通道测试', ['这条是配置校验消息，收到即代表通道可用。']);
    sendJSON(c.res, 200, {
      ok: r.ok,
      results: r.results.map((x) => ({ platform: x.platform, ok: x.ok, status: x.status || null, error: x.error || null })),
    });
  });
}

module.exports = {
  PLATFORMS,
  MAX_TARGETS,
  TIMEOUT_MS,
  dingtalkSignedUrl,
  feishuSign,
  buildBody,
  normalizeTargets,
  sendOne,
  sendAll,
  buildDigest,
  fireTaskEvents,
  maybeRunDigest,
  registerImRoutes,
};
