'use strict';

/**
 * webhookOut.js — v2.9.27 Webhook 事件出口（把钉钉专有雷达泛化成开放集成）
 *
 * 任务事件（artifact/memo/diary/status…）落盘后向用户自配 webhook POST JSON——
 * Slack/Discord/飞书/自建机器人皆可接。纪律：
 *  - fire-and-forget：绝不阻塞任务写路径；任何失败只 console.error（message 过 redact）
 *  - enabled !== true 或 url 空 → 零出网
 *  - URL 校验：仅 http(s)；拒绝回环/私网/链路本地字面量（SSRF 出站末级闸；与数据源白名单
 *    机制不同源——webhook 是用户主动出站，本模块自带私网闸，不经 ssrfGuard 白名单）
 *  - 凭据红线：url 里可含 token（如 Discord ?wait=true&token=xxx）——config.json 是既有
 *    配置落点（同钉钉 dws 凭据先例）；错误出口 scrubUrl 剥 query 值 + redact 双防线
 *  - 超时 8s AbortController；失败不重试（事件流有 500 条滚动窗兜底，下游自行对账）
 */

const gitea = require('./giteaClient');
const { redact } = require('./redact');

const TIMEOUT_MS = 8000;
const MAX_EVENTS_PER_POST = 20;

/** webhook URL 出站闸：http(s) + 私网/回环/链路本地字面量拒绝（返回 {ok, reason}） */
function guardWebhookUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || ''));
  } catch (e) {
    return { ok: false, reason: 'URL 无法解析' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: '仅放行 http/https' };
  const host = String(u.hostname || '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1') {
    return { ok: false, reason: '回环地址禁止' };
  }
  // IPv4 字面量：回环/私网/链路本地（IPv6 完整校验不做——字面量级闸 + 文档声明）
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) return { ok: false, reason: '非法 IPv4' };
    const [a, b] = o;
    const isPrivate =
      a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    if (isPrivate) return { ok: false, reason: '私网/链路本地地址禁止（webhook 目标应为公网可达端点）' };
  }
  return { ok: true, url: u };
}

/** 错误 URL 脱敏：query 值剥为 [REDACTED]（webhook token 常在 query），再过 redact */
function scrubUrl(u) {
  try {
    const c = new URL(String(u));
    for (const k of [...c.searchParams.keys()]) c.searchParams.set(k, '[REDACTED]');
    return redact(c.toString());
  } catch (e) {
    return '[URL]';
  }
}

/**
 * fireTaskEvents(configOrLoader, events, opts) — 同步入口、异步派发（不 await、不抛出）。
 * @param {object|function} configOrLoader cfg 对象（测试直传）或 config 懒加载器（生产：TTL 缓存，
 *        D1 修复——appendEvents 是全系统最热的写路径，禁用态也不该每事件一次 readFileSync）
 * @param {Array<{taskId,type,detail,at}>} events taskEvents.makeEvent 形态
 * @param {{fetcher?:function}} opts fetcher 注入缝（测试用；默认全局 fetch）
 */
const CONFIG_TTL_MS = 60 * 1000; // webhookOut 仅手改 config.json，60s 缓存延迟可接受（与轮询周期同量级）
let cfgCache = { at: 0, sec: null };

function webhookSecOf(configOrLoader) {
  if (typeof configOrLoader !== 'function') {
    return (configOrLoader && configOrLoader.webhookOut) || {};
  }
  const now = Date.now();
  if (now - cfgCache.at < CONFIG_TTL_MS && cfgCache.sec) return cfgCache.sec;
  let sec = {};
  try {
    const cfg = configOrLoader();
    sec = (cfg && cfg.webhookOut) || {};
  } catch (e) {
    sec = {}; // 读配置失败=视为关闭（写路径绝不因出口故障失败）
  }
  cfgCache = { at: now, sec };
  return sec;
}

function fireTaskEvents(configOrLoader, events, opts) {
  const o = opts || {};
  const list = Array.isArray(events) ? events.filter(Boolean).slice(0, MAX_EVENTS_PER_POST) : [];
  if (!list.length) return { fired: 0, reason: '无事件' }; // 先走零成本闸，再碰配置
  const sec = webhookSecOf(configOrLoader);
  if (sec.enabled !== true) return { fired: 0, reason: 'disabled' };
  const url = String(sec.url || '').trim();
  if (!url) return { fired: 0, reason: 'url 未配置' };
  const guard = guardWebhookUrl(url);
  if (!guard.ok) return { fired: 0, reason: guard.reason };

  const fetcher = typeof o.fetcher === 'function' ? o.fetcher : globalThis.fetch;
  if (typeof fetcher !== 'function') return { fired: 0, reason: '无 fetch 实现' };

  const payload = JSON.stringify({ source: 'fde-console', sentAt: new Date().toISOString(), events: list });
  Promise.resolve()
    .then(() =>
      fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'fde-console-webhook/1.0' },
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    )
    .then((res) => {
      if (!res || res.status >= 300) {
        console.error(`[webhook] 下游响应异常 status=${res ? res.status : '无'} url=${scrubUrl(url)}`);
      }
    })
    .catch((e) => {
      console.error(`[webhook] 派发失败 url=${scrubUrl(url)}:`, redact(String((e && e.message) || e)));
    });
  return { fired: list.length };
}

module.exports = { fireTaskEvents, guardWebhookUrl, scrubUrl, MAX_EVENTS_PER_POST, TIMEOUT_MS, clearConfigCache: () => { cfgCache = { at: 0, sec: null }; } };
