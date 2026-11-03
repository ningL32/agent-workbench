'use strict';
// GET /api/repos（只读）端点测试：fixture 零出网映射、真机本地 http stub 两页分页聚合 +
// 模块级缓存（TTL 内不增 stub 计数、clearReposCache 后重新拉取）、凭据失败 502 脱敏、
// 空组织 200 []、白名单外 400 HOST_NOT_ALLOWED 且零出站。
// AAA 三段式；缓存为模块级（同进程所有 app 共享）——每个用例开头 clearReposCache()，避免用例间污染。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const FIXTURE = path.join(__dirname, 'fixtures', 'gitea.json');

const giteaClient = require('../lib/giteaClient.js');
const { buildApp } = require('./helpers/appAssembler');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'fde-repos-'));
}

/** 最小 config.json（默认白名单/协议；真机用例在装配后运行期改指向，与 PATCH settings 同形） */
function writeConfig(dir) {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 7788,
    host: '127.0.0.1',
    dataDir: 'data',
    webDir: 'web',
    gitea: {
      baseUrl: 'https://gitea.example.com',
      apiPrefix: '/api/v1',
      org: 'example-org',
      pollIntervalSec: 0,
      hostWhitelist: ['gitea.example.com'],
    },
    security: { allowedProtocols: ['https'] },
  }));
  return configPath;
}

/**
 * 真机模式白名单写法（与 gitea.test.js 同一思路）：validateWhitelist 拒绝 127.0.0.1/localhost
 * 等危险字面量入白名单；本机 stub 采用 IPv4-mapped IPv6 环回形态 [::ffff:127.0.0.1]——
 * 经 WHATWG URL 归一化为 [::ffff:7f00:1]，isDangerousHost 放行，实际连接仍是本机，零外网。
 */
const LOOPBACK_WL = '[::ffff:7f00:1]';

const FIELDS = ['fullName', 'name', 'private', 'updatedAt'];

// ------------------------------------------------------------- fixture 模式

test('fixture 模式：GET /api/repos → 200 数组 ≥1 项、每项恰 4 字段、值与 fixture repos 一致、零出网', async () => {
  giteaClient.clearReposCache();
  const dir = tmpDir();
  const configPath = writeConfig(dir);
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const app = buildApp({ configPath, poller: 'manual', env: { GITEA_FIXTURE: FIXTURE } });
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('FIXTURE MODE MUST NOT FETCH'); };
  try {
    // Act
    const res = await app.fetch('GET', '/api/repos');
    // Assert：200 数组 ≥1 项、恰 4 字段
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body) && res.body.length >= 1, `应 ≥1 项，实际 ${JSON.stringify(res.body)}`);
    for (const item of res.body) {
      assert.equal(Object.keys(item).length, FIELDS.length, `恰 4 字段: ${JSON.stringify(item)}`);
      for (const f of FIELDS) assert.ok(f in item, `缺字段 ${f}`);
    }
    // Assert：值与 fixture repos 一致（fixture repo 无 name/private/updated_at：
    // name 回退 full_name 第二段；private=false；updatedAt=null）
    assert.equal(res.body[0].fullName, fx.repos[0].full_name);
    assert.equal(res.body[0].name, 'fde-api');
    assert.equal(res.body[0].private, false, '无 private → false');
    assert.equal(res.body[0].updatedAt, null, '无 updated_at → null');
    // Assert：零出网
    assert.equal(calls, 0, 'fixture 模式一个网络请求都不发');
  } finally {
    globalThis.fetch = origFetch;
    app.close();
    giteaClient.clearReposCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- 真机模式（本地 http stub）

test('真机模式：stub 两页分页聚合映射正确；TTL 内缓存命中计数不增；clearReposCache 后重新拉取', async () => {
  giteaClient.clearReposCache();
  const dir = tmpDir();
  const configPath = writeConfig(dir);
  const app = buildApp({ configPath, poller: 'manual' });

  // Arrange：page1=50 条（默认 perPage=50 满页）、page2=2 条（<50 即停翻，无 page=3）
  const repoOf = (i) => ({
    id: i + 1,
    name: `r-${String(i).padStart(4, '0')}`,
    full_name: `example-org/r-${String(i).padStart(4, '0')}`,
    owner: { id: 1, login: 'example-org' },
    private: i % 2 === 0,
    updated_at: i === 3 ? null : '2026-10-20T08:00:00Z',
  });
  const page1 = Array.from({ length: 50 }, (_, i) => repoOf(i));
  const page2 = Array.from({ length: 2 }, (_, i) => repoOf(50 + i));
  let orgHits = 0;
  const reqLog = [];
  const stub = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v1/orgs/example-org/repos')) {
      orgHits += 1;
      const page = Number(/page=(\d+)/.exec(req.url)[1]);
      reqLog.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(page === 1 ? page1 : page2));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end('{}');
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = stub.address().port;

  // 运行期改指向（直接改 ctx.config，与 PATCH /api/settings 同形）：
  // 白名单加环回映射形态、协议放行 http
  app.config.gitea.baseUrl = `http://[::ffff:127.0.0.1]:${port}`;
  app.config.gitea.hostWhitelist = ['gitea.example.com', LOOPBACK_WL];
  app.config.security.allowedProtocols = ['https', 'http'];

  try {
    // Act 1：首拉
    const r1 = await app.fetch('GET', '/api/repos');
    // Assert 1：两页聚合、恰两次 stub 命中（page=1/page=2，无 page=3）、映射正确
    assert.equal(r1.status, 200);
    assert.equal(r1.body.length, 52, `50+2 两页聚合，实际 ${r1.body.length}`);
    assert.equal(orgHits, 2, `恰两次 stub 命中，实际 ${orgHits}`);
    assert.ok(reqLog[0].includes('page=1') && reqLog[0].includes('limit=50'), `page1 应带 limit=50&page=1: ${reqLog[0]}`);
    assert.ok(reqLog[1].includes('page=2'), `page2 应为 page=2: ${reqLog[1]}`);
    assert.ok(reqLog.every((u) => !u.includes('page=3')), '不得翻到 page=3');
    for (const item of r1.body) {
      assert.equal(Object.keys(item).length, FIELDS.length, `恰 4 字段: ${JSON.stringify(item)}`);
    }
    assert.equal(r1.body[0].fullName, 'example-org/r-0000', 'fullName = full_name');
    assert.equal(r1.body[0].name, 'r-0000', 'name = repo.name');
    assert.equal(r1.body[0].private, true, 'private = !!repo.private');
    assert.equal(r1.body[0].updatedAt, '2026-10-20T08:00:00Z', 'updatedAt = updated_at');
    assert.equal(r1.body[3].updatedAt, null, 'updated_at 为 null → updatedAt null');
    assert.equal(r1.body[50].fullName, 'example-org/r-0050', '第二页条目聚合在内');

    // Act 2：同 app 立即第二次 GET（TTL 内）
    const r2 = await app.fetch('GET', '/api/repos');
    // Assert 2：缓存生效——stub 命中计数不增
    assert.equal(r2.status, 200);
    assert.equal(r2.body.length, 52);
    assert.equal(orgHits, 2, '缓存生效：第二次 GET 不发请求');

    // Act 3：clearReposCache() 后再 GET
    giteaClient.clearReposCache();
    const r3 = await app.fetch('GET', '/api/repos');
    // Assert 3：重新分页拉全（计数 +2）
    assert.equal(r3.status, 200);
    assert.equal(r3.body.length, 52);
    assert.equal(orgHits, 4, '清缓存后重新拉取：计数 +2');
  } finally {
    stub.close();
    app.close();
    giteaClient.clearReposCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('凭据失败：stub 返回 401 → 502 GITEA_ERROR，响应体不含任何凭据形态字符串；失败结果不入缓存', async () => {
  giteaClient.clearReposCache();
  const dir = tmpDir();
  const configPath = writeConfig(dir);
  const app = buildApp({ configPath, poller: 'manual' });
  let orgHits = 0;
  const stub = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v1/orgs/example-org/repos')) {
      orgHits += 1;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'token does not exist or has expired' }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end('{}');
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = stub.address().port;
  app.config.gitea.baseUrl = `http://[::ffff:127.0.0.1]:${port}`;
  app.config.gitea.hostWhitelist = ['gitea.example.com', LOOPBACK_WL];
  app.config.security.allowedProtocols = ['https', 'http'];
  try {
    // Act：两次 GET（验证失败结果不入缓存——第二次仍真实出站）
    const r1 = await app.fetch('GET', '/api/repos');
    const r2 = await app.fetch('GET', '/api/repos');
    // Assert：502 GITEA_ERROR、无凭据形态字符串
    assert.equal(r1.status, 502);
    assert.equal(r1.body.error.code, 'GITEA_ERROR');
    assert.ok(typeof r1.body.error.message === 'string' && r1.body.error.message.length > 0);
    const flat = `${r1.text}${r2.text}`;
    assert.ok(!/Basic\s+[A-Za-z0-9+/=]{8,}/.test(flat), '不得出现 Basic 凭据形态');
    assert.ok(!/Bearer\s+[A-Za-z0-9\-_.]{8,}/.test(flat), '不得出现 Bearer 凭据形态');
    // Assert：仅成功结果入缓存——失败后第二次 GET 仍真实出站（计数 +1 而非命中缓存）
    assert.equal(orgHits, 2, `失败结果不得入缓存：两次 GET 应各出站一次，实际 ${orgHits}`);
  } finally {
    stub.close();
    app.close();
    giteaClient.clearReposCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('空组织：stub 返回 [] → 200 []', async () => {
  giteaClient.clearReposCache();
  const dir = tmpDir();
  const configPath = writeConfig(dir);
  const app = buildApp({ configPath, poller: 'manual' });
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([]));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = stub.address().port;
  app.config.gitea.baseUrl = `http://[::ffff:127.0.0.1]:${port}`;
  app.config.gitea.hostWhitelist = ['gitea.example.com', LOOPBACK_WL];
  app.config.security.allowedProtocols = ['https', 'http'];
  try {
    // Act
    const res = await app.fetch('GET', '/api/repos');
    // Assert
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  } finally {
    stub.close();
    app.close();
    giteaClient.clearReposCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('白名单外 baseUrl：400 HOST_NOT_ALLOWED 且零出站', async () => {
  giteaClient.clearReposCache();
  const dir = tmpDir();
  const configPath = writeConfig(dir);
  const app = buildApp({ configPath, poller: 'manual' });
  // Arrange：运行期把 baseUrl 指向白名单外 host（后缀伪装形态）
  app.config.gitea.baseUrl = 'https://gitea.example.com.evil.com';
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('MUST NOT FETCH'); };
  try {
    // Act
    const res = await app.fetch('GET', '/api/repos');
    // Assert
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'HOST_NOT_ALLOWED');
    assert.equal(calls, 0, '白名单校验失败时不得发起任何出站请求');
  } finally {
    globalThis.fetch = origFetch;
    app.close();
    giteaClient.clearReposCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
