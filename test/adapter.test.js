'use strict';

/**
 * adapter.test.js — WP2 宿主适配器（SPEC-PLUGIN 2.7 WP2 验收）
 * 覆盖：mock webServer 断言路由注册（/fde-api、/fde prefix 双注册 + interval(60000) + dispose 收尾）、
 *       Host 防线（回环字面量 + security.trustedHosts allowlist；伪造 Host 403 HOST_FORBIDDEN；
 *       P4 实测前提：宿主 fence 不波及第三方路由，防线自持）、统一 500 try/catch（R-S1
 *       插件异常不得击穿 DSH 进程；宿主兜底是 400 而非 500，故自持）、req-res 直委
 *       （P1 实测 Node req/res 单态：adapter 收到的同一实例直交装配器分发，URL 剥前缀）。
 * 运行：node --test test/adapter.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const { createMockReq, createMockRes } = require('./helpers/appAssembler');
const adapter = require('../plugin/adapter');

// v2.9.43：plugin.apply 会往 <DSH_HOME>/fde-console 写 config/数据/实例登记——测试一律指向临时目录，
// 绝不触碰真实 ~/.dsh（AGENTS 红线 3）。必须在调用 apply 之前设置（resolveBaseConfig 在 apply 内解析）。
const DSH_HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-dsh-home-'));
process.env.DSH_HOME = DSH_HOME_TMP;
test.after(() => {
  try {
    fs.rmSync(DSH_HOME_TMP, { recursive: true, force: true });
  } catch (e) {
    /* Windows 临时目录 EPERM 容错 */
  }
});

// ---------- mock 宿主（webServer/timer/dispose 同形态，行为对齐 dsh-host-webserver 契约） ----------

function makeMockCtx() {
  const routes = [];
  const intervals = [];
  const disposeCbs = [];
  const ctx = {
    webServer: {
      register(route) {
        if (routes.some((r) => r.kind === route.kind && r.path === route.path)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
        }
        routes.push(route);
        return () => {
          const i = routes.indexOf(route);
          if (i >= 0) routes.splice(i, 1);
        };
      },
    },
    interval(cb, delay) {
      intervals.push({ cb, delay });
      return () => {};
    },
    // v2.9.33 起 plugin/index.mjs 用 ctx.effect 登记资源（官方规范）；mock 同步支持：
    // 立即执行回调，把它返回的清理函数收进 disposeCbs，宿主销毁时逐个调用
    effect(fn) {
      const d = typeof fn === 'function' ? fn() : undefined;
      if (typeof d === 'function') disposeCbs.push(d);
      return () => {};
    },
    on(ev, cb) {
      if (ev === 'dispose') disposeCbs.push(cb);
    },
  };
  return { ctx, routes, intervals, disposeCbs };
}

/** 经适配层打一个请求：mock req/res → route.handler → 响应视图（同 app.fetch 形状） */
async function hit(route, method, url, headers) {
  const res = createMockRes();
  const req = createMockReq({ method, url, headers: headers || { host: '127.0.0.1:38080' } });
  await route.handler(req, res);
  let json = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch (e) {
    json = null;
  }
  return { status: res.statusCode, headers: res.raw.headers, text: res.text, body: json };
}

// ---------- 纯函数：hostOf / stripPrefix ----------

test('hostOf：authority 取 host 部分（端口不敏感、IPv6 字面量、裸 IPv6）', () => {
  assert.strictEqual(adapter.hostOf('127.0.0.1:38080'), '127.0.0.1');
  assert.strictEqual(adapter.hostOf('localhost'), 'localhost');
  assert.strictEqual(adapter.hostOf('LocalHost:80'.toLowerCase()), 'localhost');
  assert.strictEqual(adapter.hostOf('[::1]:8080'), '::1');
  assert.strictEqual(adapter.hostOf('::1'), '::1');
  assert.strictEqual(adapter.hostOf(''), '');
});

test('stripPrefix：/fde-api→/、带查询、未匹配 null、前缀相近路径不误吞', () => {
  const req = () => createMockReq({ method: 'GET', url: '/x' });
  assert.strictEqual(adapter.stripPrefix(Object.assign(req(), { url: '/fde-api' }), '/fde-api').url, '/');
  assert.strictEqual(
    adapter.stripPrefix(Object.assign(req(), { url: '/fde-api/tasks?a=1' }), '/fde-api').url,
    '/tasks?a=1'
  );
  assert.strictEqual(
    adapter.stripPrefix(Object.assign(req(), { url: '/fde-api?x=1' }), '/fde-api').url,
    '/?x=1'
  );
  assert.strictEqual(adapter.stripPrefix(Object.assign(req(), { url: '/fde-apix' }), '/fde-api'), null);
  assert.strictEqual(adapter.stripPrefix(Object.assign(req(), { url: '/other' }), '/fde-api'), null);
  // 剥离视图保留原型（on/headers 等行为不变，readBody 兼容）
  const r = createMockReq({ method: 'POST', url: '/fde-api/tasks' });
  const v = adapter.stripPrefix(r, '/fde-api');
  assert.strictEqual(v.url, '/tasks');
  assert.strictEqual(v.method, 'POST');
  assert.strictEqual(typeof v.on, 'function');
});

// ---------- Host 防线 ----------

test('Host 防线：回环字面量（127.0.0.1/localhost/::1）恒放行，端口不敏感', () => {
  const guard = adapter.createHostGuard({ config: { security: {} } });
  for (const host of ['127.0.0.1:38080', 'localhost:3000', '127.0.0.1', '[::1]:9999']) {
    const res = createMockRes();
    assert.strictEqual(guard(createMockReq({ headers: { host } }), res), true, host);
    assert.strictEqual(res.finished, false, '放行时不代答');
  }
});

test('Host 防线：伪造 Host → 403 HOST_FORBIDDEN（防线自持，不依赖宿主 fence）', () => {
  const guard = adapter.createHostGuard({ config: { security: {} } });
  const res = createMockRes();
  const ok = guard(createMockReq({ headers: { host: 'evil.example.com' } }), res);
  assert.strictEqual(ok, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(JSON.parse(res.text).error.code, 'HOST_FORBIDDEN');
});

test('Host 防线：security.trustedHosts 扩展 allowlist（新 config 键，默认含 127.0.0.1/localhost）', () => {
  const guard = adapter.createHostGuard({ config: { security: { trustedHosts: ['192.168.52.206', 'fde.corp'] } } });
  for (const host of ['192.168.52.206:38080', 'fde.corp', '127.0.0.1:1']) {
    assert.strictEqual(guard(createMockReq({ headers: { host } }), createMockRes()), true, host);
  }
  const res = createMockRes();
  assert.strictEqual(guard(createMockReq({ headers: { host: '192.168.52.207' } }), res), false);
  assert.strictEqual(res.statusCode, 403);
  // trustedHosts 缺省（无 security 节）也不炸：回环字面量兜底
  const guard2 = adapter.createHostGuard({});
  assert.strictEqual(guard2(createMockReq({ headers: { host: '127.0.0.1:7788' } }), createMockRes()), true);
});

// ---------- 统一 500（R-S1） ----------

test('统一 500：handler 抛错 → 500 INTERNAL 统一 JSON，不向宿主击穿', async () => {
  const wrapped = adapter.adaptHttp(async () => {
    throw new Error('boom secret-token');
  }, { label: 'unit' });
  const res = createMockRes();
  await wrapped(createMockReq({ headers: { host: '127.0.0.1' } }), res);
  assert.strictEqual(res.statusCode, 500);
  const body = JSON.parse(res.text);
  assert.strictEqual(body.error.code, 'INTERNAL');
  assert.strictEqual(body.error.message, '服务器内部错误');
  assert.ok(!res.text.includes('secret-token'), '错误细节不外泄（统一文案）');
});

test('统一 500：headersSent 后抛错 → 不再写头，尽力 end 收尾', async () => {
  const wrapped = adapter.adaptHttp(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"partial":true}');
    throw new Error('late failure');
  });
  const res = createMockRes();
  await wrapped(createMockReq({ headers: { host: '127.0.0.1' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.finished, true);
  assert.strictEqual(JSON.parse(res.text).partial, true);
});

// ---------- createRouteHandlers：req-res 直委（P1 单态） ----------

test('createRouteHandlers：/fde-api → /api 重定基直委 handleApi，req/res 原样透传（P1 req-res 单态）', async () => {
  const seen = [];
  const app = {
    async handleApi(req, res) {
      seen.push({ url: req.url, method: req.method, sameRes: res === savedRes });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    },
    async handleStatic() {
      throw new Error('static should not be hit');
    },
    pollTick() {},
  };
  const route = { kind: 'prefix', path: '/fde-api', handler: null };
  const handlers = adapter.createRouteHandlers({ app, hostGuard: null });
  route.handler = handlers.api;
  const savedRes = createMockRes();
  const req = createMockReq({ method: 'POST', url: '/fde-api/tasks', headers: { host: '127.0.0.1:38080' } });
  await route.handler(req, savedRes);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].url, '/api/tasks', '/fde-api/* 已重定基为 lib 路由原路径 /api/*');
  assert.strictEqual(seen[0].method, 'POST');
  assert.strictEqual(seen[0].sameRes, true, '同一 res 实例直委（Node req/res 单态，无再包装）');
  assert.strictEqual(savedRes.statusCode, 201);
});

test('createRouteHandlers：Host 403 短路（handleApi 不触达）+ 前缀外 404 + 静态前缀剥离', async () => {
  let apiHits = 0;
  let staticUrls = [];
  const app = {
    async handleApi(req, res) {
      apiHits += 1;
      res.writeHead(200);
      res.end('{}');
    },
    async handleStatic(req, res) {
      staticUrls.push(req.url);
      res.writeHead(200);
      res.end('static');
    },
    pollTick() {},
  };
  const guard = adapter.createHostGuard({ config: { security: {} } });
  const handlers = adapter.createRouteHandlers({ app, hostGuard: guard });

  const r403 = await hit({ handler: handlers.api }, 'GET', '/fde-api/tasks', { host: 'evil.example.com' });
  assert.strictEqual(r403.status, 403);
  assert.strictEqual(apiHits, 0, '防线拒绝后不触达业务分发');

  const rStatic = await hit({ handler: handlers.static }, 'GET', '/fde/index.html');
  assert.strictEqual(rStatic.status, 200);
  assert.deepStrictEqual(staticUrls, ['/index.html'], '静态路径剥 /fde 前缀');

  // 防御性：/fde-apix 这类相近前缀不落入 API 分发（404，不误吞）
  const r404 = await hit({ handler: handlers.api }, 'GET', '/fde-apix');
  assert.strictEqual(r404.status, 404);
  assert.strictEqual(apiHits, 0);
});

// ---------- plugin/index.mjs 端到端（mock 宿主 + 真实装配器） ----------

test('apply：双 prefix 路由注册 + ctx.interval(60000, tick)（callback 在前）+ dispose 收尾', async () => {
  const plugin = await import(pathToFileURL(path.join(ROOT, 'plugin', 'index.mjs')).href);
  assert.strictEqual(plugin.name, 'fde-console');
  assert.deepStrictEqual(plugin.inject, ['webServer', 'timer']);

  const { ctx, routes, intervals, disposeCbs } = makeMockCtx();
  plugin.apply(ctx);

  assert.deepStrictEqual(
    routes.map((r) => `${r.kind}:${r.path}`),
    ['prefix:/fde-api', 'prefix:/fde'],
    'webServer 双 prefix 路由注册'
  );
  assert.ok(routes.every((r) => typeof r.handler === 'function'));
  assert.strictEqual(intervals.length, 1, '恰好一个轮询 interval');
  assert.strictEqual(intervals[0].delay, 60000, '60s 轮询');
  assert.strictEqual(typeof intervals[0].cb, 'function', 'callback 在前（P5 实测参数序）');
  // v2.9.33 起资源统一经 ctx.effect 登记：/fde-api、/fde、interval、app 收尾 = 四个清理函数
  assert.strictEqual(disposeCbs.length, 4, '四个 ctx.effect 已登记（两条路由 + interval + app 收尾）');
});

test('apply 端到端：GET /fde-api/ping → 200 pong（经适配层）；伪造 Host → 403；/fde 静态可达', async () => {
  const plugin = await import(pathToFileURL(path.join(ROOT, 'plugin', 'index.mjs')).href);
  const { ctx, routes } = makeMockCtx();
  plugin.apply(ctx);

  const apiRoute = routes.find((r) => r.path === '/fde-api');
  const staticRoute = routes.find((r) => r.path === '/fde');

  // 存活探针：/fde-api/ping → 剥前缀 → 装配器 router /api/ping → pong
  const pong = await hit(apiRoute, 'GET', '/fde-api/ping');
  assert.strictEqual(pong.status, 200);
  assert.strictEqual(pong.body.pong, true);
  assert.strictEqual(pong.body.name, 'fde-console');

  // 业务路由穿透性：健康检查同管线可达
  const health = await hit(apiRoute, 'GET', '/fde-api/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.body.ok, true);

  // 未知接口 → 装配器统一 JSON 404（非宿主 404）
  const nf = await hit(apiRoute, 'GET', '/fde-api/no-such');
  assert.strictEqual(nf.status, 404);
  assert.strictEqual(nf.body.error.code, 'NOT_FOUND');

  // P4：宿主 fence 不护第三方路由 → 适配层自持 Host 防线拦伪造 Host
  const forged = await hit(apiRoute, 'GET', '/fde-api/ping', { host: 'evil.example.com' });
  assert.strictEqual(forged.status, 403);
  assert.strictEqual(forged.body.error.code, 'HOST_FORBIDDEN');

  // 静态：/fde/index.html → repo web/ 真文件
  const page = await hit(staticRoute, 'GET', '/fde/index.html');
  assert.strictEqual(page.status, 200);
  assert.match(String(page.headers['content-type']), /text\/html/);
  assert.ok(fs.existsSync(path.join(ROOT, 'web', 'index.html')), 'web/index.html 存在（kilo 并行域不触碰）');
});

test('apply dispose：宿主 dispose 后路由注销、app 收尾不抛', async () => {
  const plugin = await import(pathToFileURL(path.join(ROOT, 'plugin', 'index.mjs')).href);
  const { ctx, routes, disposeCbs } = makeMockCtx();
  plugin.apply(ctx);
  assert.strictEqual(routes.length, 2);
  for (const cb of disposeCbs) cb(); // 宿主销毁插件
  assert.strictEqual(routes.length, 0, '路由已全部注销');
});
