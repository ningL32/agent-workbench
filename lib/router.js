'use strict';

/**
 * router.js — 方法+路径分发、统一 JSON 错误出口、gitea 路由挂载兼容
 * 零依赖；路径模式支持 :param 段；未知 /api/* 统一 JSON 404。
 */

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 统一错误体：{"error":{"code":"<大写蛇形>","message":"<中文>"}} */
function sendError(res, status, code, message) {
  sendJSON(res, status, { error: { code, message: message || '' } });
}

function noContent(res) {
  res.statusCode = 204;
  res.setHeader('Content-Length', 0);
  res.end();
}

const BODY_LIMIT = 1024 * 1024; // 1MB

/** CSRF 防线①（qoder P0-1）：带请求体的写方法必须 Content-Type: application/json。
 * 跨源 text/plain 简单请求被 400 拒绝 → 迫使浏览器走预检，而本服务不处理 OPTIONS（404），预检必败。 */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function contentTypeError(req) {
  if (!WRITE_METHODS.has(req.method)) return null;
  const hasBody =
    (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'] !== undefined);
  if (!hasBody) return null;
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') {
    return new HttpError(400, 'CONTENT_TYPE_REQUIRED', '写请求必须携带 Content-Type: application/json');
  }
  return null;
}

/** #9：错误堆栈输出前过 redact()（redact.js 缺位时原样输出，绝不因日志崩溃） */
let redactFn = null;
let redactTried = false;
function redactText(text) {
  if (!redactTried) {
    redactTried = true;
    try {
      redactFn = require('./redact.js').redact;
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

/** 读取请求体并按 JSON 解析；空体 → {}；非法 JSON → 400 INVALID_JSON */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (ch) => {
      size += ch.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'BODY_TOO_LARGE', '请求体超过 1MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(ch);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed === null || parsed === undefined ? {} : parsed);
      } catch (e) {
        reject(new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * add('GET', '/api/tasks/:id', handler)
   * options.rawBody=true：跳过统一 readBody 预读，由 handler 自行消费请求体
   * （用于挂载自读 body 的外部 handler，如 routes-gitea.js 的 handleGiteaTest）
   */
  add(method, pattern, handler, options) {
    const segs = pattern
      .split('/')
      .filter(Boolean)
      .map((s) => (s.startsWith(':') ? { name: s.slice(1) } : { literal: s.toLowerCase() }));
    this.routes.push({
      method: method.toUpperCase(),
      segs,
      pattern,
      handler,
      rawBody: !!(options && options.rawBody),
    });
  }

  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.segs.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < r.segs.length; i++) {
        const seg = r.segs[i];
        if (seg.name) {
          try {
            params[seg.name] = decodeURIComponent(parts[i]);
          } catch (e) {
            ok = false;
            break;
          }
        } else if (seg.literal !== parts[i].toLowerCase()) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: r.handler, params, route: r };
    }
    return null;
  }

  /** 分发一个 /api/* 请求；统一 JSON 错误出口 */
  async dispatch(ctx, req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (e) {
      return sendError(res, 400, 'BAD_REQUEST', '非法请求路径');
    }
    const pathname = url.pathname;
    let found;
    try {
      found = this.match(req.method, pathname);
    } catch (e) {
      return sendError(res, 400, 'BAD_REQUEST', '非法请求路径');
    }
    if (!found) return sendError(res, 404, 'NOT_FOUND', '接口不存在');
    try {
      const ctErr = contentTypeError(req);
      if (ctErr) throw ctErr;
      const body = found.route.rawBody ? {} : await readBody(req);
      await found.handler({
        req,
        res,
        params: found.params,
        query: url.searchParams,
        body,
        config: ctx.config,
        ctx,
      });
    } catch (e) {
      if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
      console.error('[api] 未捕获错误:', redactText((e && e.stack) || e));
      if (!res.headersSent) return sendError(res, 500, 'INTERNAL', '服务器内部错误');
      try {
        res.end();
      } catch (_) { /* 已断开 */ }
    }
  }
}

/**
 * gitea 路由挂载兼容（另一岗 mcode 负责 lib/routes-gitea.js，本侧绝不创建该文件）。
 * 识别两种导出形态：
 * ① register/mount(router, ctx) 函数；
 * ② 裸 handler 对 {handleActivities(req,res), handleGiteaTest(req,res), setConfigProvider(fn)}——
 *    由本侧代为挂到 GET /api/activities 与 POST /api/gitea/test，
 *    rawBody 挂载（对方自读请求体），并接 setConfigProvider(() => ctx.config) 使设置 PATCH 即时生效。
 * WP6 焊死（业主代决）：插件态无独立端口即无 stub 场景——routes-gitea-stub.js 已删除，
 * 模块不存在/形态不符/加载失败时不再兜底 502，两路径自然 404（路由未挂载即不存在）。
 */
function mountGiteaRoutes(router, ctx) {
  let mounted = false;
  try {
    const mod = require('./routes-gitea.js');
    if (typeof mod === 'function' || typeof (mod && (mod.register || mod.mount)) === 'function') {
      const reg = typeof mod === 'function' ? mod : mod.register || mod.mount;
      reg(router, ctx);
      mounted = true;
      console.log('[gitea] routes-gitea.js 已以 register 形态挂载');
    } else if (mod && (typeof mod.handleActivities === 'function' || typeof mod.handleGiteaTest === 'function')) {
      if (typeof mod.setConfigProvider === 'function') {
        mod.setConfigProvider(() => ctx.config);
      }
      if (typeof mod.handleActivities === 'function') {
        router.add('GET', '/api/activities', (c) => mod.handleActivities(c.req, c.res), { rawBody: true });
      }
      if (typeof mod.handleGiteaTest === 'function') {
        router.add('POST', '/api/gitea/test', (c) => mod.handleGiteaTest(c.req, c.res), { rawBody: true });
      }
      if (typeof mod.handleSourceTest === 'function') {
        router.add('POST', '/api/sources/test', (c) => mod.handleSourceTest(c.req, c.res), { rawBody: true });
      }
      mounted = true;
      console.log('[gitea] routes-gitea.js 已以 handler 形态挂载 /api/activities、/api/gitea/test 与 /api/sources/test');
    } else {
      console.error('[gitea] routes-gitea.js 存在但无已知导出形态，路由未挂载（WP6：stub 兜底已删）');
    }
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') {
      console.error('[gitea] routes-gitea.js 加载失败，路由未挂载:', e.message);
    }
    mounted = false;
  }
}

module.exports = {
  HttpError,
  sendJSON,
  sendError,
  noContent,
  readBody,
  Router,
  mountGiteaRoutes,
};
