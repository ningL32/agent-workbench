'use strict';

/**
 * gitee.test.js — v2.9.18 Gitee（gitee.com）组织动态源适配器单测。
 * 覆盖：mapEvents 按真机探针实测契约合成夹具（PushEvent：repo.full_name / commits 无 timestamp /
 * commits[].url 为 API 地址）、PR/分支事件 GitHub 同构容错、未知类型跳过计数、七日窗外过滤、
 * eventsUrl 令牌进 query 且 scrubUrl 出错出口剥参。全合成夹具零出网（凭据纪律：测试不读 git config）。
 * 运行：node --test test/gitee.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const gitee = require('../lib/giteeClient.js');

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const FETCHED = '2026-10-25T12:00:00.000Z';
const sinceMs = NOW - 24 * 3600 * 1000; // 一日窗

// 真机探针实测形态（2026-10-25，示例组织）合成：repo.full_name / commits 无 timestamp / commit.url 为 API 地址
function pushEvent(partial) {
  return {
    id: '1534985427866161152',
    type: 'PushEvent',
    actor: { id: 1277007, login: 'demo_user', name: '示例用户' },
    repo: { full_name: 'example-org/demo-repo', human_name: 'example-org/demo-repo' },
    payload: {
      ref: 'refs/heads/master',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      created: false,
      deleted: false,
      size: 1,
      commits: [
        {
          sha: '2aad0e39a45e080d7767d6033800f7d63b86c0c1',
          message: 'fix: CDN_BASE_URL 恢复默认 aiautos.chat 公共服务，用户只需配 CDN_API_KEY\n\n正文首段说明。\n',
          url: 'https://gitee.com/api/v5/repos/example-org/demo-repo/commits/2aad0e39a45e080d7767d6033800f7d63b86c0c1',
          author: { email: 'ning32@163.com', name: 'ningL32' }
        }
      ]
    },
    created_at: '2026-10-25T18:04:04+08:00',
    public: true,
    ...partial
  };
}

test('gitee mapEvents：PushEvent 逐 commit 映射（full_name/自拼 web 链接/正文首段/分支去前缀）', () => {
  const r = gitee.mapEvents([pushEvent()], sinceMs, FETCHED, 'https://gitee.com');
  assert.strictEqual(r.activities.length, 1);
  const a = r.activities[0];
  assert.strictEqual(a.type, 'commit');
  assert.strictEqual(a.actor, 'demo_user');
  assert.strictEqual(a.repo, 'example-org/demo-repo', 'repo 取 full_name（探针实证差异点）');
  assert.strictEqual(a.branch, 'master', 'ref 去 refs/heads/ 前缀');
  assert.strictEqual(a.sha, '2aad0e39a45e080d7767d6033800f7d63b86c0c1');
  assert.strictEqual(a.title, 'fix: CDN_BASE_URL 恢复默认 aiautos.chat 公共服务，用户只需配 CDN_API_KEY');
  assert.strictEqual(a.messageBody, '正文首段说明。');
  // commits[].url 是 API 地址——动态链接必须自拼 web 地址
  assert.strictEqual(a.url, 'https://gitee.com/example-org/demo-repo/commit/2aad0e39a45e080d7767d6033800f7d63b86c0c1');
  // commits 无 timestamp（探针实证）→ occurredAt 退事件 created_at
  assert.strictEqual(a.occurredAt, '2026-10-25T18:04:04+08:00');
  assert.strictEqual(r.skippedEventCount, 0);
});

test('gitee mapEvents：未知类型跳过计数 + 窗外条目丢弃 + 空提交容忍', () => {
  const r = gitee.mapEvents(
    [
      pushEvent({ id: 'e2', type: 'IssueAction', created_at: '2026-10-25T10:00:00+08:00' }),
      pushEvent({ id: 'e3', created_at: '2026-08-01T10:00:00+08:00' }), // 七日窗外
      pushEvent({ id: 'e4', payload: { ref: 'refs/heads/dev', commits: [] }, created_at: '2026-10-25T10:30:00+08:00' }),
      null
    ],
    sinceMs, FETCHED, 'https://gitee.com'
  );
  assert.strictEqual(r.activities.length, 0, '空提交/窗外条目不产活动');
  assert.strictEqual(r.skippedEventCount, 1, '未知类型计数（窗外条目不计 skip）');
  assert.deepStrictEqual(r.skippedEventTypes, ['IssueAction']);
});

test('gitee mapEvents：PR 事件 GitHub 同构容错（opened/merged 映射，closed 未合跳过）', () => {
  const base = {
    actor: { login: 'dev1' },
    repo: { full_name: 'example-org/repo-a' },
    created_at: '2026-10-25T10:00:00+08:00'
  };
  const opened = { ...base, type: 'PullRequestEvent', payload: { action: 'opened', number: 7, pull_request: { title: '新增导出修复', html_url: 'https://gitee.com/example-org/repo-a/pulls/7' } } };
  const merged = { ...base, type: 'PullRequestEvent', payload: { action: 'closed', number: 8, pull_request: { title: 'PR 八', merged: true } } };
  const closed = { ...base, type: 'PullRequestEvent', payload: { action: 'closed', number: 9, pull_request: { title: 'PR 九', merged: false } } };
  const r = gitee.mapEvents([opened, merged, closed], sinceMs, FETCHED, 'https://gitee.com');
  assert.strictEqual(r.activities.length, 2, 'opened + closed(merged) 两条，closed(未合) 跳过');
  assert.strictEqual(r.activities[0].type, 'pr');
  assert.strictEqual(r.activities[0].title, '新增导出修复');
  assert.strictEqual(r.activities[0].url, 'https://gitee.com/example-org/repo-a/pulls/7');
  assert.strictEqual(r.activities[1].url, 'https://gitee.com/example-org/repo-a/pulls/8');
  assert.strictEqual(r.skippedEventCount, 1);
});

test('gitee scrubUrl：access_token 参数值出错误出口前剥为 [REDACTED]（令牌不进日志红线）', () => {
  const url = 'https://gitee.com/api/v5/orgs/demo-gitee-org/events?per_page=100&page=1&access_token=secret-token-value';
  const scrubbed = gitee.scrubUrl(url);
  assert.ok(!scrubbed.includes('secret-token-value'), '令牌原文不得残留在 URL 中');
  assert.ok(scrubbed.includes('access_token=%5BREDACTED%5D'), '参数保留但值脱敏');
  assert.ok(scrubbed.includes('per_page=100'), '非敏感参数不动');
  assert.strictEqual(gitee.scrubUrl('https://gitee.com/api/v5/orgs/x/events'), 'https://gitee.com/api/v5/orgs/x/events', '无令牌 URL 原样返回');
  assert.strictEqual(gitee.scrubUrl('not-a-url'), 'not-a-url', '非法 URL 容错原样返回');
});

test('gitee testConnection：org 缺失 fail-fast 不出网；白名单外 baseUrl 守卫 400 语义（离线）', async () => {
  const cfg = { gitee: { enabled: false, baseUrl: 'https://gitee.com', org: '', hostWhitelist: ['gitee.com'] }, security: { allowedProtocols: ['https'] } };
  const r0 = await gitee.testConnection(cfg, {});
  assert.strictEqual(r0.ok, false);
  assert.match(r0.error, /org 未配置/);
  const r1 = await gitee.testConnection(cfg, { org: 'some-org', baseUrl: 'https://localhost/api' });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.code, 'HOST_NOT_ALLOWED');
  assert.ok(!('total' in r1), '守卫失败不产生拉取结果');
});
