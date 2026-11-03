'use strict';

/**
 * static.js — web/ 静态托管（自 server.js 原样抽出，WP2）
 *
 * - 独立版：挂根路径（urlPath 原样，'/' → /index.html）
 * - DSH 插件态：adapter 层剥掉 /fde 前缀后复用同一实现（SPA hash 路由零 base-path 改写）
 * - 目录缺失优雅 404 不崩；越界/软链逃逸复检；#18 安全头；仅 GET/HEAD
 */

const fs = require('fs');
const path = require('path');
const { sendError } = require('../lib/router');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// #18：静态响应统一安全头；style/img 放行应用自身行内样式与 data: 图标（goose 回归 P1-NEW）
// X-Frame-Options 用 SAMEORIGIN 而非 DENY：插件态 SPA 经 DSH shell.overlay 的同源 iframe 嵌入
//（goose 插件验收 P0-A——DENY 连同源 iframe 一并拒绝，overlay 开合被自家安全头锁死）
const STATIC_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
};

function sendStaticError(res, status, code, message) {
  for (const [k, v] of Object.entries(STATIC_SECURITY_HEADERS)) res.setHeader(k, v);
  sendError(res, status, code, message);
}

/** 托管 ctx.webDir 下的静态文件；rawUrl 为已剥前缀的 URL（含查询串，本函数只取路径部分） */
function serveStatic(ctx, req, res, rawUrl) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendStaticError(res, 405, 'METHOD_NOT_ALLOWED', '静态资源仅支持 GET');
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(String(rawUrl).split('?')[0]);
  } catch (e) {
    return sendStaticError(res, 400, 'BAD_REQUEST', '非法路径');
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const webRoot = path.resolve(ctx.webDir);
  const target = path.join(webRoot, urlPath);
  if (target !== webRoot && !target.startsWith(webRoot + path.sep)) {
    return sendStaticError(res, 403, 'FORBIDDEN', '路径越界');
  }

  let filePath = target;
  try {
    const st = fs.statSync(filePath);
    if (st.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch (e) {
    return sendStaticError(res, 404, 'NOT_FOUND', 'web/ 尚未部署或文件不存在');
  }

  // #18：realpath 消解符号链接后复检，防 web/ 内软链逃逸
  let realWebRoot;
  let realTarget;
  try {
    realWebRoot = fs.realpathSync(webRoot);
    realTarget = fs.realpathSync(filePath);
  } catch (e) {
    return sendStaticError(res, 404, 'NOT_FOUND', 'web/ 尚未部署或文件不存在');
  }
  if (realTarget !== realWebRoot && !realTarget.startsWith(realWebRoot + path.sep)) {
    return sendStaticError(res, 403, 'FORBIDDEN', '路径越界');
  }

  let data;
  try {
    data = fs.readFileSync(realTarget);
  } catch (e) {
    return sendStaticError(res, 404, 'NOT_FOUND', '文件不存在');
  }
  const ext = path.extname(realTarget).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
    ...STATIC_SECURITY_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

module.exports = { serveStatic, MIME, STATIC_SECURITY_HEADERS };
