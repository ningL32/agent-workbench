'use strict';
// B3 Gitea 客户端测试：SSRF 防护（白名单外 400 且零出站）、GITEA_FIXTURE 零网络拉取
// （activities/feeds 数据源：op_type → feeds 词表 commit/pr/branch_created/branch_deleted）、
// 滚动 ≤500、真机模式（本地 http stub）分页/时间窗/去重、handler 契约（§3）。
// AAA 三段式；一个用例一个断言主题。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'gitea.json');

const { assertSafeUrl, validateWhitelist } = require('../lib/ssrfGuard.js');
const giteaClient = require('../lib/giteaClient.js');
const routesGitea = require('../lib/routes-gitea.js');

function baseCfg(overrides = {}) {
  const cfg = giteaClient.loadConfig();
  return {
    ...cfg,
    dataDir: overrides.dataDir || cfg.dataDir,
    gitea: { ...cfg.gitea, ...(overrides.gitea || {}) },
    security: { ...cfg.security, ...(overrides.security || {}) }
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fde-b3-'));
}

// ---------------------------------------------------------------- SSRF

test('SSRF：白名单外 host 与协议违规 → HOST_NOT_ALLOWED 且零出站', () => {
  const cfg = baseCfg();
  // Arrange：抓取型 fetch 计数桩，任何调用都记为出站
  const urls = [
    'https://127.0.0.1/x',
    'https://169.254.169.254/x',
    'https://10.0.0.1/x',
    'https://evil.com/x',
    'http://127.0.0.1:7788',   // http 协议违规（allowedProtocols=[https]）
    'http://evil.com/x',
    'https://gitea.example.com.evil.com/x', // 后缀伪装
    'https://evil-gitea.example.com/x',     // 前缀伪装
    'ftp://gitea.example.com/x'             // 协议白名单外
  ];
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('MUST NOT FETCH'); };
  try {
    for (const u of urls) {
      // Act + Assert
      assert.throws(() => assertSafeUrl(u, cfg),
        (e) => e.code === 'HOST_NOT_ALLOWED', `应拒绝 ${u}`);
    }
    // Act：testConnection 对白名单外地址也必须在任何出站前抛错
    assert.rejects(() => giteaClient.testConnection('https://evil.com', cfg),
      (e) => e.code === 'HOST_NOT_ALLOWED');
    // Assert：零出站
    assert.equal(calls, 0, '白名单校验失败时不得发起任何出站请求');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SSRF：合法 URL 通过且大小写不敏感', () => {
  const cfg = baseCfg();
  // Act + Assert
  assert.doesNotThrow(() => assertSafeUrl('https://gitea.example.com/api/v1', cfg));
  assert.doesNotThrow(() => assertSafeUrl('https://GITEA.EXAMPLE.COM/api/v1', cfg));
  const u = assertSafeUrl('https://Gitea.Example.Com/api/v1', cfg);
  assert.equal(u.hostname, 'gitea.example.com');
});

test('validateWhitelist：localhost/环回/私有/保留段字面量启动即抛错', () => {
  const dangerous = [
    ['localhost'], ['foo.localhost'], ['127.0.0.1'], ['0.0.0.0'], ['10.0.0.1'],
    ['169.254.169.254'], ['172.16.0.1'], ['172.31.255.255'], ['192.168.1.1'],
    ['100.64.0.1'], ['100.127.0.1'], ['192.0.0.1'], ['192.0.2.1'], ['198.18.0.1'],
    ['198.51.100.7'], ['203.0.113.9'], ['224.0.0.1'], ['240.0.0.1'],
    ['255.255.255.255'], ['::1'], ['::'], ['fe80::1'], ['fd00::1']
  ];
  for (const wl of dangerous) {
    const cfg = baseCfg({ gitea: { hostWhitelist: wl } });
    assert.throws(() => validateWhitelist(cfg), `白名单 ${JSON.stringify(wl)} 应被拒绝`);
  }
});

test('validateWhitelist：正常域名放行', () => {
  const cfg = baseCfg();
  assert.doesNotThrow(() => validateWhitelist(cfg));
  const cfg2 = baseCfg({ gitea: { hostWhitelist: ['gitea.example.com', 'gitea2.example.com'] } });
  assert.doesNotThrow(() => validateWhitelist(cfg2));
});

// ------------------------------------------------------- pollActivities (fixture)

test('fixture 模式 pollActivities：零网络、feeds 六条目映射 ≥2 条、恰有 §4 的 11 字段、status 更新（skippedUnknownOps 计未知 op）', async () => {
  const dir = tmpDir();
  process.env.GITEA_FIXTURE = FIXTURE;
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('FIXTURE MODE MUST NOT FETCH'); };
  try {
    // Act
    const acts = await giteaClient.pollActivities(baseCfg({ dataDir: dir }));
    // Assert：内存返回值
    assert.ok(Array.isArray(acts));
    assert.ok(acts.length >= 2, `应 ≥2 条，实际 ${acts.length}`);
    const FIELDS = ['id', 'type', 'actor', 'repo', 'branch', 'sha', 'title', 'messageBody', 'url', 'occurredAt', 'fetchedAt'];
    const cfgTypes = baseCfg().gitea.activityTypes;
    assert.deepEqual(
      [...cfgTypes].sort(),
      ['branch_created', 'branch_deleted', 'commit', 'pr'],
      'activityTypes 应为 feeds 新词表'
    );
    for (const a of acts) {
      for (const f of FIELDS) assert.ok(f in a, `缺字段 ${f}`);
      assert.equal(Object.keys(a).length, FIELDS.length, `activity 恰为 §4 字段: ${JSON.stringify(a)}`);
      assert.equal('matchedTaskIds' in a, false, 'matchedTaskIds 不落盘');
      assert.match(a.id, /^a-\d+$/);
      assert.ok(cfgTypes.includes(a.type), `type ${a.type} 必须在 activityTypes 内`);
    }
    // Assert：落盘文件
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'activities.json'), 'utf8'));
    assert.ok(Array.isArray(saved) && saved.length === acts.length);
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'gitea-status.json'), 'utf8'));
    assert.equal(status.ok, true);
    assert.equal(status.lastError, null);
    assert.equal(status.skippedUnknownOps, 1, 'create_repo 为未知 op_type，应计 1 次跳过');
    assert.ok(!Number.isNaN(Date.parse(status.lastPollAt)));
    // Assert：零出站
    assert.equal(calls, 0, 'fixture 模式一个网络请求都不发');
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.GITEA_FIXTURE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('滚动截断：合并后 ≤ maxActivities 且 id 唯一', async () => {
  const dir = tmpDir();
  process.env.GITEA_FIXTURE = FIXTURE;
  try {
    // Arrange：预置 600 条旧 activity（id a-1..a-600，时间倒序铺开）
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const old = Array.from({ length: 600 }, (_, i) => ({
      id: `a-${i + 1}`, type: 'commit_pushed', actor: 'legacy', repo: 'example-org/legacy',
      branch: null, title: `legacy ${i}`,
      url: `https://gitea.example.com/example-org/legacy/commit/${i}`,
      occurredAt: new Date(now - i * 3600 * 1000).toISOString(),
      fetchedAt: new Date(now).toISOString()
    }));
    fs.writeFileSync(path.join(dir, 'activities.json'), JSON.stringify(old));
    // Act
    const acts = await giteaClient.pollActivities(baseCfg({ dataDir: dir }));
    // Assert
    const max = baseCfg().gitea.maxActivities;
    assert.ok(acts.length <= max, `应 ≤${max}，实际 ${acts.length}`);
    const ids = new Set(acts.map((a) => a.id));
    assert.equal(ids.size, acts.length, 'id 不得重复');
    // 按 occurredAt 倒序
    for (let i = 1; i < acts.length; i++) {
      assert.ok(Date.parse(acts[i - 1].occurredAt) >= Date.parse(acts[i].occurredAt), '应按时间倒序');
    }
  } finally {
    delete process.env.GITEA_FIXTURE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('重复轮询去重：同数据两轮不产生重复条目', async () => {
  const dir = tmpDir();
  process.env.GITEA_FIXTURE = FIXTURE;
  try {
    // Act
    const first = await giteaClient.pollActivities(baseCfg({ dataDir: dir }));
    const second = await giteaClient.pollActivities(baseCfg({ dataDir: dir }));
    // Assert
    assert.equal(second.length, first.length, '去重后数量不变');
    const urls = new Set(second.map((a) => `${a.type}|${a.url}`));
    assert.equal(urls.size, second.length, 'type|url 键唯一');
  } finally {
    delete process.env.GITEA_FIXTURE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('feeds 映射：commit_repo 拆条带 sha/title/messageBody/actor/branch/url；branch_created/deleted actor=操作者；pr 号从 comment 提取', async () => {
  const dir = tmpDir();
  process.env.GITEA_FIXTURE = FIXTURE;
  try {
    // Act
    const acts = await giteaClient.pollActivities(baseCfg({ dataDir: dir }));
    // Assert：commit 条目（commit_repo 拆条）sha/messageBody/actor/branch/url 全链路
    const commit = acts.find((a) => a.type === 'commit');
    assert.ok(commit, 'fixture 应产出 commit 条目');
    assert.equal(commit.sha, 'abc1234def0123456789');
    assert.equal(commit.title, 'fix: SSO 回调校验 state', 'title 取 Message 首行');
    assert.equal(commit.messageBody, '回调未校验 state 参数，存在 CSRF 风险，补充白名单校验。');
    assert.equal(commit.actor, 'zhangsan', 'actor=act_user.login（不再为 null）');
    assert.equal(commit.branch, 'feat/sso', 'ref_name 去 refs/heads/ 前缀');
    assert.equal(commit.url, 'https://gitea.example.com/example-org/fde-api/commit/abc1234def0123456789');
    assert.equal(commit.occurredAt, '2026-10-16T06:10:00Z', 'occurredAt 取 Commit.Timestamp');
    // Assert：branch_created actor=操作者（feeds 提供操作者，不再 null）
    const created = acts.find((a) => a.type === 'branch_created');
    assert.ok(created, 'fixture 应产出 branch_created 条目');
    assert.equal(created.actor, 'zhangsan', 'feeds 词表 branch_created 带操作者');
    assert.equal(created.branch, 'feat/sso');
    assert.equal(created.url, 'https://gitea.example.com/example-org/fde-api/src/branch/feat/sso');
    // Assert：branch_deleted actor=操作者
    const deleted = acts.find((a) => a.type === 'branch_deleted');
    assert.ok(deleted, 'fixture 应产出 branch_deleted 条目');
    assert.equal(deleted.actor, 'zhaoliu');
    assert.equal(deleted.branch, 'chore/bump');
    assert.equal(deleted.url, 'https://gitea.example.com/example-org/fde-api/src/branch/chore/bump');
    // Assert：pr 号从 comment.pull_request_url 提取，actor=操作者
    const prOpened = acts.find((a) => a.type === 'pr' && a.url.endsWith('/pulls/12'));
    assert.ok(prOpened, '应产出 opened PR #12');
    assert.equal(prOpened.actor, 'agent-kilo');
    assert.equal(prOpened.title, 'PR #12');
    const prMerged = acts.find((a) => a.type === 'pr' && a.url.endsWith('/pulls/11'));
    assert.ok(prMerged, '应产出 merged PR #11');
    assert.equal(prMerged.actor, 'qianqi');
    assert.equal(prMerged.title, 'PR #11');
  } finally {
    delete process.env.GITEA_FIXTURE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('feeds 类型映射覆盖：四类 type 全部产出，未知 create_repo 不产出且跳过计数', async () => {
  const dir = tmpDir();
  process.env.GITEA_FIXTURE = FIXTURE;
  try {
    // Act
    const acts = await giteaClient.pollActivities(baseCfg({ dataDir: dir }));
    // Assert：四类 type（commit/branch_created/branch_deleted/pr）一次全产出
    const types = [...new Set(acts.map((a) => a.type))].sort();
    assert.deepEqual(types, ['branch_created', 'branch_deleted', 'commit', 'pr'], '四类 type 全部产出');
    // Assert：create_repo（未知 op_type）未产出任何条目
    assert.ok(acts.every((a) => a.type !== 'create_repo' && !/create_repo/i.test(a.title)), '未知 op_type 不产出');
    // Assert：跳过计数进 status
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'gitea-status.json'), 'utf8'));
    assert.equal(status.skippedUnknownOps, 1, 'create_repo 恰跳过 1 条');
    assert.equal(status.ok, true);
  } finally {
    delete process.env.GITEA_FIXTURE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('feeds messageBody 边界：无正文为空串、多段取第一段、超 300 恰截 300、首行后空行仍取到正文', async () => {
  const dir = tmpDir();
  const fxDir = tmpDir();
  const long = 'A'.repeat(320);
  // Arrange：自定义临时 fixture（feeds 格式：单条 commit_repo 条目 content 内 4 个 Commits）
  const fixturePath = path.join(fxDir, 'edge.json');
  const commitOf = (sha, message) => ({
    Sha1: sha, Message: message, AuthorName: '张伟', Timestamp: '2026-10-16T06:00:00Z'
  });
  fs.writeFileSync(fixturePath, JSON.stringify({
    version: { version: '1.22.0' },
    repos: [{
      full_name: 'example-org/edge',
      html_url: 'https://gitea.example.com/example-org/edge',
      default_branch: 'main'
    }],
    feeds: {
      'example-org/edge': [{
        id: 1, op_type: 'commit_repo',
        act_user: { id: 5, login: 'zhangsan' },
        ref_name: 'refs/heads/main',
        content: JSON.stringify({
          Commits: [
            commitOf('e1', 'feat: 单行无正文'),
            commitOf('e2', 'feat: 多段\n\n第一段正文\n第一段第二行\n\n第二段不应出现'),
            commitOf('e3', `feat: 超长正文\n\n${long}`),
            commitOf('e4', 'feat: 首行后紧跟空行\n\n\n正文段在这里')
          ],
          Len: 4
        }),
        created: '2026-10-16T06:00:00Z',
        comment: null,
        repo: { id: 1, name: 'edge', full_name: 'example-org/edge' }
      }]
    }
  }));
  process.env.GITEA_FIXTURE = fixturePath;
  try {
    // Act
    const acts = await giteaClient.pollActivities(baseCfg({ dataDir: dir }));
    const bySha = new Map(acts.filter((a) => a.type === 'commit').map((a) => [a.sha, a]));
    // Assert：无正文 → ''
    assert.equal(bySha.get('e1').messageBody, '', '单行 message 正文应为空串');
    // Assert：多段 → 仅取第一段（含段内换行）
    assert.equal(bySha.get('e2').messageBody, '第一段正文\n第一段第二行');
    // Assert：超 300 字符 → 恰截断到 300
    assert.equal(bySha.get('e3').messageBody.length, 300);
    assert.equal(bySha.get('e3').messageBody, 'A'.repeat(300));
    // Assert：首行后紧跟空行再正文 → 仍取到正文段
    assert.equal(bySha.get('e4').messageBody, '正文段在这里');
  } finally {
    delete process.env.GITEA_FIXTURE;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fxDir, { recursive: true, force: true });
  }
});

test('v2.0 存量容错：旧 9 字段 unknown 条目再轮询不丢不崩，actor 保持且新字段归一；feeds 新 branch 条目 actor=操作者', async () => {
  const dir = tmpDir();
  process.env.GITEA_FIXTURE = FIXTURE;
  try {
    // Arrange：预置 v1.x 9 字段旧条目（actor='unknown'，无 sha/messageBody）
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      id: 'a-9', type: 'branch_created', actor: 'unknown', repo: 'example-org/legacy',
      branch: 'legacy/x', title: 'legacy/x',
      url: 'https://gitea.example.com/example-org/legacy/src/branch/legacy/x',
      occurredAt: '2026-10-14T00:00:00Z', fetchedAt: '2026-10-14T00:00:00Z'
    };
    fs.writeFileSync(path.join(dir, 'activities.json'), JSON.stringify([legacy]));
    // Act
    const acts = await giteaClient.pollActivities(baseCfg({ dataDir: dir }));
    // Assert：旧条目保留，actor 原样，新字段经 strictActivity 归一补齐
    const kept = acts.find((a) => a.id === 'a-9');
    assert.ok(kept, '旧条目不得丢失');
    assert.equal(kept.actor, 'unknown', '存量 unknown 原样保留');
    assert.equal(kept.sha, null, '旧条目缺失 sha 归一为 null');
    assert.equal(kept.messageBody, '', '旧条目缺失 messageBody 归一为空串');
    assert.equal(Object.keys(kept).length, 11, '旧条目落盘后应恰为 11 字段');
    // Assert：本轮新产生的 branch_created 条目 actor 为 fixture 操作者（feeds 提供操作者）
    const fresh = acts.find((a) => a.type === 'branch_created' && a.id !== 'a-9');
    assert.ok(fresh, '本轮应产出新的 branch_created 条目');
    assert.equal(fresh.actor, 'zhangsan', 'feeds 词表 branch 条目带操作者');
    assert.notEqual(fresh.actor, 'unknown');
  } finally {
    delete process.env.GITEA_FIXTURE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- testConnection

test('testConnection：fixture 模式零网络返回版本；白名单外抛 HOST_NOT_ALLOWED', async () => {
  process.env.GITEA_FIXTURE = FIXTURE;
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('MUST NOT FETCH'); };
  try {
    // Act
    const cfg = baseCfg();
    const r = await giteaClient.testConnection(cfg.gitea.baseUrl, cfg);
    // Assert
    assert.equal(r.ok, true);
    assert.equal(r.apiVersion, '1.22.0');
    assert.ok(Number.isInteger(r.latencyMs) && r.latencyMs >= 0);
    assert.equal(calls, 0, 'fixture 模式零出站');
    // 白名单外
    assert.rejects(() => giteaClient.testConnection('http://127.0.0.1:7788', cfg),
      (e) => e.code === 'HOST_NOT_ALLOWED');
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.GITEA_FIXTURE;
  }
});

// ------------------------------------------------------------------ handlers

test('handler 端到端：/api/activities 契约、/api/gitea/test 白名单 400', async () => {
  const dir = tmpDir();
  process.env.GITEA_FIXTURE = FIXTURE;
  routesGitea.setConfigProvider(() => baseCfg({ dataDir: dir }));
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/activities')) return routesGitea.handleActivities(req, res);
    if (req.url.startsWith('/api/gitea/test')) return routesGitea.handleGiteaTest(req, res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'x' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Act 1：refresh=1 触发 fixture 拉取
    const r1 = await fetch(`${base}/api/activities?refresh=1`);
    const b1 = await r1.json();
    // Assert 1
    assert.equal(r1.status, 200);
    assert.ok(Array.isArray(b1) && b1.length >= 2);
    assert.ok(b1.every((a) => Array.isArray(a.matchedTaskIds)), '响应需带 matchedTaskIds（读取时计算）');
    // Act 2：SSRF 400
    const r2 = await fetch(`${base}/api/gitea/test`, {
      method: 'POST', body: JSON.stringify({ baseUrl: 'http://127.0.0.1:7788' })
    });
    const b2 = await r2.json();
    // Assert 2
    assert.equal(r2.status, 400);
    assert.equal(b2.error.code, 'HOST_NOT_ALLOWED');
    // Act 3：合法地址 fixture 测试连接
    const r3 = await fetch(`${base}/api/gitea/test`, {
      method: 'POST', body: JSON.stringify({ baseUrl: 'https://gitea.example.com' })
    });
    const b3 = await r3.json();
    // Assert 3
    assert.equal(r3.status, 200);
    assert.equal(b3.ok, true);
    assert.equal(b3.apiVersion, '1.22.0');
    // Act 4：坏 JSON
    const r4 = await fetch(`${base}/api/gitea/test`, { method: 'POST', body: '{oops' });
    // Assert 4
    assert.equal(r4.status, 400);
    assert.equal((await r4.json()).error.code, 'INVALID_JSON');
    // Act 5：matchedTaskIds 读取时计算（不落盘）
    fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({
      columns: [], tasks: [{ id: 't-01', title: '接入SSO', status: 'doing', branch: 'feat/sso', repo: 'example-org/fde-api' }]
    }));
    const r5 = await fetch(`${base}/api/activities`);
    const b5 = await r5.json();
    // branch 精确匹配由 feeds commit 条目（branch feat/sso）承担；chore/bump 由 branch_deleted 承担
    const sso = b5.find((a) => a.branch === 'feat/sso' && a.type === 'commit');
    const other = b5.find((a) => a.branch === 'chore/bump' && a.type === 'branch_deleted');
    // Assert 5
    assert.ok(sso.matchedTaskIds.includes('t-01'), `branch 精确匹配应命中: ${JSON.stringify(sso)}`);
    assert.deepEqual(other.matchedTaskIds, []);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'activities.json'), 'utf8'));
    assert.ok(saved.every((a) => !('matchedTaskIds' in a)), '落盘文件不得含 matchedTaskIds');
  } finally {
    server.close();
    delete process.env.GITEA_FIXTURE;
    routesGitea.setConfigProvider(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- getSettingsView

test('getSettingsView：脱敏视图含 credential 来源名且无凭据值', () => {
  // Act
  const view = giteaClient.getSettingsView(baseCfg());
  // Assert
  assert.equal(view.port, 7788);
  assert.equal(view.host, '127.0.0.1');
  assert.equal(view.dataDir, 'data');
  assert.equal(view.gitea.baseUrl, 'https://gitea.example.com');
  assert.deepEqual(view.gitea.hostWhitelist, ['gitea.example.com']);
  assert.equal(view.gitea.maxActivities, 500);
  assert.equal(view.gitea.pollIntervalSec, 60);
  assert.ok(Number.isInteger(view.gitea.staleWarnSec) && Number.isInteger(view.gitea.staleDangerSec));
  assert.equal(view.credential, 'GIT_CONFIG_EXTRAHEADER');
  const flat = JSON.stringify(view);
  assert.ok(!/Basic\s+[A-Za-z0-9+/=]{8,}/.test(flat), '视图中不得出现任何凭据形态的值');
});

// ------------------------------------------- qoder #11 (P2)：末级 URL 复检 + 凭据最小化

test('纵深：恶意 apiPrefix 拼接后末级复检拒绝，零出站且凭据不落 status', async () => {
  const dir = tmpDir();
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('MUST NOT FETCH'); };
  // Arrange：apiPrefix 手改成 userinfo 伪装，最终 URL host 变为 evil.com
  const cfg2 = baseCfg({ dataDir: dir, gitea: { apiPrefix: '@evil.com/' } });
  try {
    // Act
    await assert.rejects(() => giteaClient.pollActivities(cfg2),
      (e) => e.code === 'HOST_NOT_ALLOWED', '拼接后最终 URL 必须复检');
    // Assert：零出站
    assert.equal(calls, 0, '末级复检失败时不得发起任何出站请求');
    // Assert：status 如实记录失败，且 lastError 不含凭据原值
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'gitea-status.json'), 'utf8'));
    assert.equal(status.ok, false);
    assert.ok(typeof status.lastError === 'string' && status.lastError.length > 0);
    const cred = giteaClient.readCredential(baseCfg());
    if (cred) assert.ok(!status.lastError.includes(cred), 'lastError 不得含凭据原值');
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('纵深：testConnection 异 host 目标不附 Authorization（本地 stub 零外网）', async () => {
  // Arrange：本地 stub；该白名单组合在生产会被启动体检拒绝，此处仅验证 testConnection 纵深。
  // 注意断言用布尔形态，任何情况下不得把收到的头值带进测试输出（凭据红线）。
  let seenAuth = 'SENTINEL-NOT-CALLED';
  const stub = http.createServer((req, res) => {
    seenAuth = req.headers.authorization || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: '1.23.4-stub' }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = stub.address().port;
  const cfg2 = baseCfg({
    gitea: { hostWhitelist: ['gitea.example.com', '127.0.0.1'] },
    security: { allowedProtocols: ['https', 'http'] }
  });
  try {
    // Act
    const r = await giteaClient.testConnection(`http://127.0.0.1:${port}`, cfg2);
    // Assert：请求确实打到了 stub（非白名单拦截假阳性）
    assert.equal(r.ok, true, `应成功打到 stub：ok=${r.ok} apiVersion=${r.apiVersion}`);
    assert.equal(r.apiVersion, '1.23.4-stub');
    // Assert：异 host 目标不得附 Authorization（布尔断言，不回显头值）
    assert.ok(seenAuth === null, `异 host 目标不得附 Authorization（附了=${seenAuth !== null}）`);
  } finally {
    stub.close();
  }
});

// --------------------------------------------- 真机模式（本地 http stub，零外网）

/**
 * 真机模式白名单写法说明：pollActivities 入口 validateWhitelist 体检（lib 红线）拒绝
 * 127.0.0.1/localhost 等危险字面量入白名单；本机 stub 采用 IPv4-mapped IPv6 环回形态
 * [::ffff:127.0.0.1] —— 经 WHATWG URL 归一化为 [::ffff:7f00:1]，isDangerousHost 放行，
 * 实际连接仍是本机 127.0.0.1，零外网红线不变（与上方 testConnection stub 同一思路）。
 */
const LOOPBACK_WL = '[::ffff:7f00:1]';

/** 真机模式 cfg：baseUrl 指向本地 stub；feedsLimit=2 使分页用例可控翻页 */
function realModeCfg(port, dataDir) {
  return baseCfg({
    dataDir,
    gitea: {
      baseUrl: `http://[::ffff:127.0.0.1]:${port}`,
      hostWhitelist: ['gitea.example.com', LOOPBACK_WL],
      feedsLimit: 2
    },
    security: { allowedProtocols: ['https', 'http'] }
  });
}

/** feeds 条目骨架（键名与真机一致：id/op_type/act_user/ref_name/content/created/comment/repo） */
function feedEntry(repoFull, opType, login, created, extra = {}) {
  return {
    id: Math.floor(Math.random() * 1e9),
    op_type: opType,
    act_user: { id: 9, login, full_name: login, username: login },
    ref_name: '',
    content: '',
    created,
    comment: null,
    repo: { id: 1, name: repoFull.split('/')[1], full_name: repoFull },
    ...extra
  };
}

test('真机模式：feeds 分页恰 page=1/2 无 page=3、7 天窗外整体跳过、actor 归因、未知 op_type 计数', async () => {
  const now = Date.now();
  const H = 3600 * 1000;
  const iso = (ms) => new Date(ms).toISOString();
  // Arrange：page1=最近 commit + 未知 op；page2=8 天前 commit（应在窗口处停翻/整体跳过）
  const page1 = [
    feedEntry('example-org/demo-hub', 'commit_repo', 'zhaoliu', iso(now - 1 * H), {
      ref_name: 'refs/heads/feat/sso',
      content: JSON.stringify({
        Commits: [{ Sha1: 'feedcafe0001', Message: 'feat: feeds 拉取', Timestamp: iso(now - 1 * H) }],
        Len: 1
      })
    }),
    feedEntry('example-org/demo-hub', 'create_repo', 'admin', iso(now - 2 * H))
  ];
  const page2 = [
    feedEntry('example-org/demo-hub', 'commit_repo', 'zhaoliu', iso(now - 8 * 24 * H), {
      ref_name: 'refs/heads/feat/old',
      content: JSON.stringify({
        Commits: [{ Sha1: 'oldoldold0002', Message: 'feat: 八天前', Timestamp: iso(now - 8 * 24 * H) }],
        Len: 1
      })
    })
  ];
  const reqLog = [];
  const stub = http.createServer((req, res) => {
    reqLog.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/api/v1/orgs/example-org/repos')) {
      return res.end(JSON.stringify([{
        full_name: 'example-org/demo-hub',
        html_url: `http://127.0.0.1:${stub.address().port}/example-org/demo-hub`,
        default_branch: 'main'
      }]));
    }
    if (req.url.includes('/api/v1/repos/example-org/demo-hub/activities/feeds')) {
      const page = Number(/page=(\d+)/.exec(req.url)[1]);
      return res.end(JSON.stringify(page === 1 ? page1 : page2));
    }
    return res.end(JSON.stringify([]));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = stub.address().port;
  const dir = tmpDir();
  try {
    // Act
    const acts = await giteaClient.pollActivities(realModeCfg(port, dir));
    // Assert：分页请求恰 page=1、page=2，无 page=3（page2 仅 1 条 < limit=2 即停，8 天前也早于窗口）
    const feedReqs = reqLog.filter((u) => u.includes('/activities/feeds'));
    assert.equal(feedReqs.length, 2, `feeds 恰两页请求，实际: ${JSON.stringify(feedReqs)}`);
    assert.ok(feedReqs[0].includes('limit=2') && feedReqs[0].includes('page=1'), `page1 应带 limit=2: ${feedReqs[0]}`);
    assert.ok(feedReqs[1].includes('page=2'), `page2 应为 page=2: ${feedReqs[1]}`);
    assert.ok(reqLog.every((u) => !u.includes('page=3')), '不得翻到 page=3');
    // Assert：仅最近 commit 入榜（actor 归因 zhaoliu）；8 天前条目被 7 天窗口整体跳过
    assert.equal(acts.length, 1, `仅最近 1 条 commit 入榜，实际 ${acts.length}`);
    const c = acts[0];
    assert.equal(c.type, 'commit');
    assert.equal(c.actor, 'zhaoliu', 'actor=act_user.login');
    assert.equal(c.branch, 'feat/sso', 'ref_name 去 refs/heads/ 前缀');
    assert.equal(c.sha, 'feedcafe0001');
    assert.equal(c.title, 'feat: feeds 拉取');
    assert.equal(c.url, `http://127.0.0.1:${port}/example-org/demo-hub/commit/feedcafe0001`);
    assert.ok(!acts.some((a) => a.sha === 'oldoldold0002'), '8 天前条目不得入榜');
    // Assert：status 记录未知 op_type 跳过计数
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'gitea-status.json'), 'utf8'));
    assert.equal(status.ok, true);
    assert.equal(status.lastError, null);
    assert.equal(status.skippedUnknownOps, 1, 'create_repo 应计 1 次跳过');
  } finally {
    stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真机模式去重幂等：同一 stub 同一 dataDir 两轮 pollActivities，数量不变且 type|url 键唯一', async () => {
  const now = Date.now();
  const H = 3600 * 1000;
  const page1 = [
    feedEntry('example-org/demo-hub', 'commit_repo', 'zhaoliu', new Date(now - 1 * H).toISOString(), {
      ref_name: 'refs/heads/feat/sso',
      content: JSON.stringify({
        Commits: [{ Sha1: 'dedupe0001aa', Message: 'feat: 幂等', Timestamp: new Date(now - 1 * H).toISOString() }],
        Len: 1
      })
    }),
    feedEntry('example-org/demo-hub', 'create_branch', 'zhaoliu', new Date(now - 2 * H).toISOString(), {
      ref_name: 'feat/sso'
    })
  ];
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/api/v1/orgs/example-org/repos')) {
      return res.end(JSON.stringify([{
        full_name: 'example-org/demo-hub',
        html_url: `http://127.0.0.1:${stub.address().port}/example-org/demo-hub`,
        default_branch: 'main'
      }]));
    }
    if (req.url.includes('/api/v1/repos/example-org/demo-hub/activities/feeds')) {
      return res.end(JSON.stringify(page1));
    }
    return res.end(JSON.stringify([]));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = stub.address().port;
  const dir = tmpDir();
  try {
    // Act：同一 stub 同一 dataDir 连跑两轮
    const cfg = realModeCfg(port, dir);
    const first = await giteaClient.pollActivities(cfg);
    const second = await giteaClient.pollActivities(cfg);
    // Assert：第二轮数量不变（type|url 去重）、键唯一、同条目保号
    assert.equal(first.length, 2, `首轮 commit+branch 共 2 条，实际 ${first.length}`);
    assert.equal(second.length, first.length, '两轮数量不变');
    const keys = new Set(second.map((a) => `${a.type}|${a.url}`));
    assert.equal(keys.size, second.length, 'type|url 键唯一');
    for (const f of first) {
      const s = second.find((a) => a.type === f.type && a.url === f.url);
      assert.ok(s, `首轮条目 ${f.id} 二轮应保留`);
      assert.equal(s.id, f.id, '同 type|url 刷新保号');
    }
  } finally {
    stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- 词表兼容（老词表 config 与存量数据）

test('词表兼容：config.activityTypes 为老词表时归一为 feeds 新词表，commit/pr 正常入库（fixture 零网络）', async () => {
  const dir = tmpDir();
  process.env.GITEA_FIXTURE = FIXTURE;
  try {
    // Arrange：模拟历史部署的 config——老三接口词表（commit_pushed/pr_opened/pr_merged）
    const cfg = baseCfg({
      dataDir: dir,
      gitea: { activityTypes: ['pr_opened', 'pr_merged', 'commit_pushed', 'branch_created', 'branch_deleted'] }
    });
    // Act
    const acts = await giteaClient.pollActivities(cfg);
    // Assert：老词表过滤不再吞掉 mapper 产出的 commit/pr
    assert.ok(acts.some((a) => a.type === 'commit'), 'commit 事件必须入库');
    assert.ok(acts.some((a) => a.type === 'pr'), 'pr 事件必须入库');
    assert.ok(acts.every((a) => a.type !== 'commit_pushed' && a.type !== 'pr_opened' && a.type !== 'pr_merged'),
      '落库类型必须是新词表');
  } finally {
    delete process.env.GITEA_FIXTURE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('词表兼容：存量老词表条目轮询后原地改名，同 url 与新条目坍缩为一条（零数据丢失）', async () => {
  const dir = tmpDir();
  process.env.GITEA_FIXTURE = FIXTURE;
  try {
    // Arrange：先跑一轮拿真实 commit 条目，再注入同 url 的老词表僵尸条目模拟历史 activities.json
    const first = await giteaClient.pollActivities(baseCfg({ dataDir: dir }));
    const sample = first.find((a) => a.type === 'commit' && a.url);
    assert.ok(sample, 'fixture 需产出带 url 的 commit');
    const seeded = [{ ...sample, id: 'a-9001', type: 'commit_pushed', fetchedAt: '2020-01-01T00:00:00.000Z' }];
    fs.writeFileSync(path.join(dir, 'activities.json'), JSON.stringify(seeded, null, 2));
    // Act
    const acts = await giteaClient.pollActivities(baseCfg({ dataDir: dir }));
    // Assert：老词表零残留、同 url 坍缩为一条新词表条目且字段被新拉数据刷新
    assert.ok(!acts.some((a) => a.type === 'commit_pushed'), '老词表条目不得残留');
    const sameUrl = acts.filter((a) => a.url === sample.url);
    assert.equal(sameUrl.length, 1, `同 url 提交必须坍缩为 1 条，实际 ${sameUrl.length}`);
    assert.equal(sameUrl[0].type, 'commit');
    assert.notEqual(sameUrl[0].fetchedAt, '2020-01-01T00:00:00.000Z', '僵尸条目应被本轮 fetchedAt 刷新');
  } finally {
    delete process.env.GITEA_FIXTURE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- v2.9.15：系统凭据管理器兜底（配置里零明文） ----------

test('credentialHelperHeader：git credential fill 输出 → Authorization 头', () => {
  // Arrange
  const out = 'protocol=https\nhost=gitea.example.com\nusername=wangwu\npassword=abc123\n\n';

  // Act
  const header = giteaClient.credentialHelperHeader(out);

  // Assert
  assert.equal(header, 'AUTHORIZATION: Basic ' + Buffer.from('wangwu:abc123', 'utf8').toString('base64'));
});

test('credentialHelperHeader：无 username 时按 git 兜底；缺 password / 空输出一律 null', () => {
  // Arrange / Act / Assert
  assert.equal(
    giteaClient.credentialHelperHeader('password=only\n'),
    'AUTHORIZATION: Basic ' + Buffer.from('git:only', 'utf8').toString('base64')
  );
  assert.equal(giteaClient.credentialHelperHeader('username=x\n\n'), null, '缺 password 不得伪造凭据');
  assert.equal(giteaClient.credentialHelperHeader(''), null);
  assert.equal(giteaClient.credentialHelperHeader(undefined), null);
});
