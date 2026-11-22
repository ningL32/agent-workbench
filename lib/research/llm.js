'use strict';

/**
 * lib/research/llm.js — 调研模块 LLM 路由器（SPEC-RESEARCH §5,唯一出站点）
 *
 * 三通道二选一（优先级 direct 显式启用 > dsh 默认 > paper 兜底）:
 *   ① direct — OpenAI 兼容端点:内置 fetch,key 只走 env(RESEARCH_LLM_API_KEY),零落盘零日志;
 *      启用前提 = config.research.hostWhitelist 含端点 host(沿 github 节先例,默认关)
 *   ② dsh    — 雷达引擎同款本机 headless(runHeadless 复用,零新配置)
 *   ③ paper  — 未配置任何通道时显式降级:消息 kind=paper 留痕,绝不静默
 *
 * 红线:出站文本过 redact(防任务标题里的密钥出网,work-search 先例);解析失败由调用方落
 * system/parse_error 行留痕(红线 8);同访谈禁在途并发,全局 LLM 有界并发(信号量语义)。
 */

const { redact } = require('../redact');
const { assertSafeUrl } = require('../ssrfGuard');

const DIRECT_TIMEOUT_MS = 120 * 1000;
const MAX_INFLIGHT = 2; // 有界并发:调研访谈是交互式单会话场景,2 足够且防打爆端点
let inflight = 0;

function notConfigured(reason) {
  const e = new Error(redact(`LLM 通道未配置: ${reason}`));
  e.code = 'LLM_NOT_CONFIGURED';
  return e;
}

/** 通道选择:显式 direct(且白名单放行) > dsh 可用 > paper。返回 {channel, reason} */
function pickChannel(cfg) {
  const rc = (cfg && cfg.research) || {};
  const directHost = String(rc.directApiHost || '').trim();
  if (directHost) {
    if (!process.env.RESEARCH_LLM_API_KEY) return { channel: 'paper', reason: 'directApiHost 已配但 RESEARCH_LLM_API_KEY 未设置' };
    const whitelist = Array.isArray(rc.hostWhitelist) ? rc.hostWhitelist : [];
    if (!whitelist.includes(directHost)) return { channel: 'paper', reason: `directApiHost 不在 research.hostWhitelist 白名单内` };
    return { channel: 'direct', reason: '' };
  }
  return { channel: 'dsh', reason: '' };
}

/** direct 通道:OpenAI 兼容 /chat/completions,内置 fetch。ssrfGuard 放行已在 pickChannel 校验 host 白名单 */
async function callDirect(cfg, prompt, opts) {
  const rc = cfg.research || {};
  const host = String(rc.directApiHost || '').trim();
  const model = String(rc.directApiModel || '').trim();
  const url = `https://${host}/v1/chat/completions`;
  try {
    assertSafeUrl(url, { allowedProtocols: ['https'], hostWhitelist: [host] });
  } catch (e) {
    throw notConfigured(`端点未过 SSRF 白名单: ${(e && e.message) || e}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEARCH_LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const body = String(await res.text().catch(() => '')).slice(0, 200);
      throw Object.assign(new Error(redact(`LLM 端点 HTTP ${res.status}: ${body}`)), { code: 'LLM_HTTP_ERROR' });
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw Object.assign(new Error('LLM 响应缺 choices[0].message.content'), { code: 'LLM_EMPTY' });
    }
    return { text, channel: 'direct', modelId: model || 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/** 统一入口:路由通道并调用。opts.timeoutSec 透传 dsh 通道(重试升压同雷达语义) */
async function chat(cfg, prompt, opts = {}) {
  if (inflight >= MAX_INFLIGHT) {
    throw Object.assign(new Error('LLM 并发已达上限,请稍后重试'), { code: 'LLM_BUSY' });
  }
  const pick = pickChannel(cfg);
  if (pick.channel === 'paper') {
    // 纸面模式:显式降级不抛错——调用方据此落 kind=paper 消息(可观测,绝不静默)
    return { text: '', channel: 'paper', modelId: '', paperReason: pick.reason };
  }
  inflight += 1;
  try {
    if (pick.channel === 'direct') return await callDirect(cfg, prompt, opts);
    const analyze = require('../analyze'); // 延迟 require 防 circular(dsh 引擎复用雷达管线)
    const text = await analyze.runHeadless(cfg, prompt, { timeoutSec: opts.timeoutSec });
    return { text: String(text || ''), channel: 'dsh', modelId: 'dsh-headless' };
  } finally {
    inflight -= 1;
  }
}

module.exports = { chat, pickChannel };
