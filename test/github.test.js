'use strict';
// GitHub 组织动态源测试（v2.9）：
//   事件映射（词表与 giteaClient 完全一致 + 7 天窗外丢弃 + 未知事件计数）、
//   enabled=false 零出网零写盘、SSRF 白名单、真 stub 轮询（落盘/两轮去重保号/状态文件）、
//   org 未配置报错、多源刷新编排（GitHub 失败不拖垮 Gitea 源，全失败才 502）。
// AAA 三段式；一个用例一个断言主题。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const githubClient = require('../lib/githubClient.js');
const giteaClient = require('../lib/giteaClient.js');
const routesGitea = require('../lib/routes-gitea.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'gitea.json');
// 与 gitea.test.js 同款技巧：IPv6 映射形态的环回字面量（非危险字面量写法，可入白名单命中本地 stub）
const LOOPBACK_WL = '[::ffff:7f00:1]';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fde-gh-'));
}

function ghCfg(port, dataDir, githubOverrides = {}) {
  const base = giteaClient.loadConfig();
  return {
    ...base,
    dataDir,
    github: {
      enabled: true,
      baseUrl: `http://[::ffff:127.0.0.1]:${port}`,
      org: 'test-org',
      eventsPages: 1,
      hostWhitelist: ['api.github.com', LOOPBACK_WL],
      ...githubOverrides
    },
    security: { ...base.security, allowedProtocols: ['https', 'http'] }
  };
}

/** 事件骨架（键名与 GitHub org events 真实返回一致） */
function ghEvent(type, opts = {}) {
  return {
    type,
    actor: { login: opts.actor || 'octocat' },
    repo: { name: opts.repo || 'test-org/repo-a' },
    created_at: opts.created || '2026-10-21T10:00:00Z',
    payload: opts.payload || {}
  };
}

// ------------------------------------------------------------------ mapEvents

test('mapEvents：Push/PR/分支映射统一词表，未知事件计数，窗外条目丢弃', () => {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const H = 3600e3;
  const events = [
    ghEvent('PushEvent', {
      created: iso(H), actor: 'alice',
      payload: { ref: 'refs/heads/feat/x', commits: [
        { sha: 'a'.repeat(40), message: 'feat: 标题行\n\n正文第一段说明', timestamp: iso(H - 100e3) },
        { sha: 'b'.repeat(40), message: 'fix: 第二条', timestamp: iso(H - 200e3) }
      ] }
    }),
    ghEvent('PullRequestEvent', { created: iso(2 * H), actor: 'bob', payload: { action: 'opened', number: 7,
      pull_request: { title: 'feat: SSO 登录', html_url: 'https://github.com/test-org/repo-a/pull/7', merged: false } } }),
    // 真机实证：GitHub 会发 action:"merged"（文档未列）——必须映射为 pr 而非跳过
    ghEvent('PullRequestEvent', { created: iso(1500e3), actor: 'bob', payload: { action: 'merged', number: 8,
      pull_request: { title: 'fix: 合并态事件', html_url: 'https://github.com/test-org/repo-a/pull/8', merged: true } } }),
    ghEvent('PullRequestEvent', { created: iso(H), payload: { action: 'synchronize', number: 7, pull_request: {} } }),
    ghEvent('CreateEvent', { created: iso(3 * H), payload: { ref_type: 'branch', ref: 'release/v1' } }),
    ghEvent('DeleteEvent', { created: iso(4 * H), payload: { ref_type: 'branch', ref: 'tmp/wip' } }),
    ghEvent('CreateEvent', { created: iso(5 * H), payload: { ref_type: 'repository', ref: 'repo-b' } }),
    ghEvent('WatchEvent', { created: iso(6 * H), payload: { action: 'started' } }),
    // 7 天窗外：整体与单 commit 双重过滤口径
    ghEvent('PushEvent', { created: iso(8 * 24 * H), payload: { ref: 'refs/heads/main',
      commits: [{ sha: 'c'.repeat(40), message: 'chore: 太老', timestamp: iso(8 * 24 * H) }] } })
  ];
  const sinceMs = now - 7 * 24 * H;
  const { activities, skippedEventCount, skippedEventTypes } =
    githubClient.mapEvents(events, sinceMs, '2026-10-21T00:00:00Z', 'https://github.com');

  const commits = activities.filter((a) => a.type === 'commit');
  const prs = activities.filter((a) => a.type === 'pr');
  assert.equal(commits.length, 2, 'PushEvent 拆条为逐 commit');
  assert.equal(prs.length, 2, 'opened 与 action:"merged"（真机实证事件）均映射，synchronize 跳过');
  assert.equal(activities.filter((a) => a.type === 'branch_created').length, 1);
  assert.equal(activities.filter((a) => a.type === 'branch_deleted').length, 1);
  assert.equal(skippedEventCount, 3, 'synchronize + CreateEvent(repository) + Watch 计 3 次跳过');
  assert.ok(skippedEventTypes.includes('WatchEvent'));
  assert.ok(!skippedEventTypes.some((t) => t.includes('merged')), 'action:"merged" 不得进跳过名单');

  const c0 = commits[0];
  assert.deepEqual(
    Object.keys(c0).sort(),
    ['actor', 'branch', 'fetchedAt', 'messageBody', 'occurredAt', 'repo', 'sha', 'title', 'type', 'url'].sort(),
    '映射产物恰为合并前的 10 字段（id 由 mergeActivities 分配）'
  );
  assert.equal(c0.actor, 'alice');
  assert.equal(c0.branch, 'feat/x');
  assert.equal(c0.title, 'feat: 标题行');
  assert.equal(c0.messageBody, '正文第一段说明');
  assert.equal(c0.url, `https://github.com/test-org/repo-a/commit/${'a'.repeat(40)}`);
  assert.equal(prs[0].url, 'https://github.com/test-org/repo-a/pull/7');
  assert.equal(prs[0].title, 'feat: SSO 登录');
  assert.ok(commits.every((a) => !a.occurredAt.startsWith('1970')), 'occurredAt 取 commit timestamp');
});

// ------------------------------------------------------------------ pollActivities 守卫与开关

test('enabled=false：零出网、零写盘、返回 null', async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('MUST NOT FETCH'); };
  const dir = tmpDir();
  try {
    const r = await githubClient.pollActivities(ghCfg(1, dir, { enabled: false }));
    assert.equal(r, null);
    assert.equal(calls, 0, '关闭态一个请求都不发');
    assert.ok(!fs.existsSync(path.join(dir, 'github-status.json')), '关闭态不写状态文件');
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SSRF：github.baseUrl host 不在白名单 → HOST_NOT_ALLOWED 且零出站', async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('MUST NOT FETCH'); };
  const dir = tmpDir();
  try {
    const cfg = ghCfg(1, dir, { baseUrl: 'http://evil.example.com', hostWhitelist: ['api.github.com'] });
    await assert.rejects(() => githubClient.pollActivities(cfg), (e) => e.code === 'HOST_NOT_ALLOWED');
    assert.equal(calls, 0, '白名单外零出站');
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('org 未配置 → GITHUB_ERROR 且 github-status.json 记 ok:false', async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('MUST NOT FETCH'); };
  const dir = tmpDir();
  try {
    const cfg = ghCfg(1, dir, { org: '' });
    await assert.rejects(() => githubClient.pollActivities(cfg), (e) => e.code === 'GITHUB_ERROR');
    assert.equal(calls, 0);
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'github-status.json'), 'utf8'));
    assert.equal(status.ok, false);
    assert.ok(status.lastError, 'lastError 必须留痕');
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 真 stub 轮询

test('真 stub 轮询：事件落盘同一 activities.json，github-status ok:true，两轮 type|url 去重保号', async () => {
  // v2.9.21 合并修正：事件日期用相对锚（原写死 2026-10-21，时钟过 10-28 后跌出 7 日窗恒红——日期炸弹，与 weekly.test 同类）
  const iso = (daysAgo, h) => new Date(Date.now() - daysAgo * 86400000 - h * 3600000).toISOString();
  const events = [
    ghEvent('PushEvent', { created: iso(2, 3), payload: { ref: 'refs/heads/main',
      commits: [{ sha: 'ab12'.repeat(10), message: 'feat: 真桩提交', timestamp: iso(2, 3) }] } }),
    ghEvent('PullRequestEvent', { created: iso(2, 4), payload: { action: 'opened', number: 3,
      pull_request: { title: 'chore: bump deps', html_url: 'https://github.com/test-org/repo-a/pull/3', merged: false } } }),
    ghEvent('CreateEvent', { created: iso(2, 5), payload: { ref_type: 'branch', ref: 'feat/gh' } })
  ];
  const stub = http.createServer((req, res) => {
    if (req.url.includes('/orgs/test-org/events')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(events));
    }
    res.writeHead(404);
    return res.end('{}');
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = stub.address().port;
  const dir = tmpDir();
  try {
    const cfg = ghCfg(port, dir);
    const first = await githubClient.pollActivities(cfg);
    assert.equal(first.length, 3, 'commit+pr+branch_created 共 3 条');
    assert.ok(first.some((a) => a.type === 'commit' && a.title === 'feat: 真桩提交'));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'activities.json'), 'utf8'));
    assert.equal(saved.length, first.length, '与 activities.json 落盘一致');
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'github-status.json'), 'utf8'));
    assert.equal(status.ok, true);
    assert.equal(status.enabled, true);
    assert.equal(status.skippedEventCount, 0);
    // 第二轮：同数据 type|url 去重，数量不变且保号
    const second = await githubClient.pollActivities(cfg);
    assert.equal(second.length, first.length, '两轮数量不变（type|url 去重）');
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

// ------------------------------------------------------------------ 多源刷新编排

test('多源编排：GitHub 失败不拖垮 Gitea 源（200），全失败才 502', async () => {
  const dir = tmpDir();
  process.env.GITEA_FIXTURE = FIXTURE; // Gitea 源 fixture 必成功
  routesGitea.setConfigProvider(() => ghCfg(1, dir, { baseUrl: 'http://[::ffff:127.0.0.1]:1' })); // github 指向必拒端口
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/activities')) return routesGitea.handleActivities(req, res);
    res.writeHead(404);
    return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Act 1：github 失败、gitea 成功 → 200
    const r1 = await fetch(`${base}/api/activities?refresh=1`);
    assert.equal(r1.status, 200, '单源失败不得拖垮整体刷新');
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'github-status.json'), 'utf8'));
    assert.equal(status.ok, false, '失败源必须在 status 留痕');
    // Act 2：全失败（gitea 也指向必拒端口）→ 502
    delete process.env.GITEA_FIXTURE;
    routesGitea.setConfigProvider(() => {
      const cfg = ghCfg(1, dir, { baseUrl: 'http://[::ffff:127.0.0.1]:1' });
      cfg.gitea = { ...cfg.gitea, baseUrl: 'http://[::ffff:127.0.0.1]:1', hostWhitelist: ['gitea.example.com', LOOPBACK_WL] };
      return cfg;
    });
    const r2 = await fetch(`${base}/api/activities?refresh=1`);
    assert.equal(r2.status, 502);
    const body2 = await r2.json();
    assert.equal(body2.error.code, 'GITEA_ERROR');
    assert.ok(body2.error.message.includes('github'), '502 消息须含两源错误');
  } finally {
    server.close();
    delete process.env.GITEA_FIXTURE;
    routesGitea.setConfigProvider(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('githubClient testConnection：org 缺失 fail-fast 不出网；白名单外 baseUrl 守卫 400 语义（离线）', async () => {
  const cfg = { github: { enabled: false, baseUrl: 'https://api.github.com', org: '', hostWhitelist: ['api.github.com'] }, security: { allowedProtocols: ['https'] } };
  const r0 = await githubClient.testConnection(cfg, {});
  assert.strictEqual(r0.ok, false);
  assert.match(r0.error, /org 未配置/);
  const r1 = await githubClient.testConnection(cfg, { org: 'some-org', baseUrl: 'https://localhost/api' });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.code, 'HOST_NOT_ALLOWED');
  assert.ok(!('total' in r1), '守卫失败不产生拉取结果');
});
