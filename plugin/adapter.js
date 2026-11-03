'use strict';

/**
 * adapter.js — DSH 宿主适配层（WP2）：Host 防线 + 前缀剥离 + 统一 500
 *
 * 职责边界（SPEC-PLUGIN 2.1/2.5，P1/P4 实测定型）：
 * - P1：webServer route.handler = Node (IncomingMessage, ServerResponse) 双参单态
 *   （源码 `await route.handler(req, res)`）→ adaptHttp 定型单态 req/res 适配，无双态实现；
 * - Host 防线只护自有路由（/fde-api/* 与 /fde/*）：DSH 的 /api browser-trust fence 不波及
 *   第三方 prefix 路由（P4 实测：伪造 Host 打 /fde-api → 200），防线必须自持，不依赖宿主（R-S2）。
 *   allowlist = 回环字面量（127.0.0.1 / localhost / ::1，恒在）+ config.security.trustedHosts
 *   （新 config 键，默认 ["127.0.0.1","localhost"]，对齐 DSH fence 的 extra-authority 思路）；
 *   其余 Host 一律 403 HOST_FORBIDDEN。Host 头比较取 authority 的 host 部分（端口不敏感，
 *   因宿主端口运行期才确定）；IPv6 字面量按 [::1]:port 形态解析。
 * - CSRF 防线①（写请求 Content-Type: application/json）在 lib/router.dispatch 内，两态共用；
 *   防线②（Sec-Fetch-Site）留在装配器边界管线（独立版过渡路径），插件态按 2.5 安全表以
 *   Host 防线 + CSRF① 承接，不重复实现。
 * - R-S1 进程内共生：插件异常不得击穿 DSH 进程——adaptHttp 全路由 try/catch + 统一 500 JSON
 *   （宿主对 handler 抛错的兜底是 warn + 400，非 500，故统一 500 必须自持）。错误文本过 redact。
 * - 本文件不触碰任何 DSH API（那是 plugin/index.mjs 的专属职责），可独立单测。
 */

const { sendError } = require('../lib/router');

let redactFn = null;
let redactTried = false;
/** #9 同款纪律：日志出口过 redact（redact.js 缺位时原样输出，绝不因日志崩溃） */
function redactText(text) {
  if (!redactTried) {
    redactTried = true;
    try {
      redactFn = require('../lib/redact.js').redact;
    } catch (e) {
      redactFn = null;
    }
  }
  try {
    return redactFn ? redactFn(String(text)) : String(text);
  } catch (e) {
    return String(text);
  }
}

/**
 * 统一 500 包装：handler 抛错 → 记日志（redact）→ 未发送头则 500 INTERNAL JSON，已发送则尽力收尾。
 * 返回的函数即 webServer route.handler 形态：async (req, res)。
 */
function adaptHttp(handler, opts) {
  const label = (opts && opts.label) || 'handler';
  return async function adapted(req, res) {
    try {
      await handler(req, res);
    } catch (e) {
      console.error(`[fde-adapter] ${label} 未捕获错误:`, redactText((e && e.stack) || e));
      if (!res.headersSent) {
        sendError(res, 500, 'INTERNAL', '服务器内部错误');
      } else {
        try {
          res.end();
        } catch (_) { /* 已断开 */ }
      }
    }
  };
}

/** Host 头 authority → host 部分：'127.0.0.1:7788'→'127.0.0.1'；'[::1]:80'→'::1'；无端口原样 */
function hostOf(authority) {
  const s = String(authority || '').trim().toLowerCase();
  if (s.startsWith('[')) {
    const i = s.indexOf(']');
    return i > 0 ? s.slice(1, i) : s;
  }
  const first = s.indexOf(':');
  const last = s.lastIndexOf(':');
  // 单冒号视为 host:port；多冒号为裸 IPv6 字面量
  if (first > -1 && first === last) return s.slice(0, first);
  return s;
}

const LOOPBACK_LITERALS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Host 防线工厂。config.security.trustedHosts（字符串数组）在回环字面量基础上扩展 allowlist。
 * 返回 guard(req, res) → true（放行）/ false（已代答 403）。
 */
function createHostGuard(opts) {
  const config = opts && opts.config;
  const extra = (config && config.security && config.security.trustedHosts) || [];
  const allow = new Set(LOOPBACK_LITERALS);
  for (const entry of Array.isArray(extra) ? extra : []) {
    const h = hostOf(entry);
    if (h) allow.add(h);
  }
  return function hostGuard(req, res) {
    const host = hostOf(req.headers && req.headers.host);
    if (allow.has(host)) return true;
    sendError(
      res,
      403,
      'HOST_FORBIDDEN',
      'Host 不在受信任列表（fde-console 防线自持，不依赖宿主 fence）'
    );
    return false;
  };
}

/**
 * 剥 prefix 后的 req 视图（原型链保留，readBody/on 等行为不变）；不匹配返回 null。
 * '/fde-api' → '/'；'/fde-api?x=1' → '/?x=1'；'/fde-apix' → null（防前缀误吞）。
 */
function stripPrefix(req, prefix) {
  const url = req.url || '/';
  if (url !== prefix && !url.startsWith(prefix + '/') && !url.startsWith(prefix + '?')) return null;
  let rest = url.slice(prefix.length);
  if (rest === '' || rest.startsWith('?')) rest = '/' + rest;
  const view = Object.create(req);
  view.url = rest;
  return view;
}

/**
 * 生成挂到 webServer 的一对 handler（/fde-api → app.handleApi、/fde → app.handleStatic）与轮询 tick。
 * app 形态 = 装配器 buildApp() 产物（handleApi/handleStatic/pollTick）；hostGuard 可注入替换。
 * 每个 handler 依次过：Host 防线（403 代答）→ 前缀剥离（404）→ adaptHttp 统一 500。
 */
function createRouteHandlers(opts) {
  const app = opts.app;
  const guard = opts.hostGuard || null;
  const apiPrefix = opts.apiPrefix || '/fde-api';
  const staticPrefix = opts.staticPrefix || '/fde';

  const api = adaptHttp(async (req, res) => {
    if (guard && !guard(req, res)) return;
    const stripped = stripPrefix(req, apiPrefix);
    if (!stripped) return sendError(res, 404, 'NOT_FOUND', '接口不存在');
    // /fde-api/* → /api/* 同构重定基：SPA 原 fetch 路径（/api/tasks 等）在 lib 路由零改动的前提下
    // 经宿主前缀原样到达（/fde-api/ping ↔ /api/ping，对齐 WP1 spike 契约）
    const rebased = Object.create(stripped);
    rebased.url = '/api' + (stripped.url === '/' ? '' : stripped.url);
    await app.handleApi(rebased, res);
  }, { label: '/fde-api' });

  const staticHandler = adaptHttp(async (req, res) => {
    if (guard && !guard(req, res)) return;
    const stripped = stripPrefix(req, staticPrefix);
    if (!stripped) return sendError(res, 404, 'NOT_FOUND', '静态资源不存在');
    await app.handleStatic(stripped, res);
  }, { label: '/fde' });

  return {
    api,
    static: staticHandler,
    pollTick: () => app.pollTick(),
  };
}

module.exports = { adaptHttp, createHostGuard, createRouteHandlers, stripPrefix, hostOf, LOOPBACK_LITERALS };
