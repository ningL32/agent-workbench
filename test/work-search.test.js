'use strict';

/**
 * work-search.test.js — v2.9.23 工作搜索（考古层）：四组聚合检索
 *
 * 覆盖：
 *  - 四组命中：任务（标题/描述/成果说明）、会话（claude 文件源标题）、提交（activities.json）、
 *    日报（diary.json）各出命中；组内时间倒序；响应形状 {q,tookMs,total,groups}
 *  - 匹配口径：多词 AND 跨字段命中；任一词缺席不命中；大小写不敏感
 *  - 每组截断 MAX_PER_GROUP=8（造 10 条命中任务取 8）
 *  - 空查询 400 FIELD_INVALID
 *  - redact：注册密钥出现在任务标题 → 出口脱敏
 *  - 隔离降级：activities.json 损坏 → 提交组空返、其余组照常命中
 *  - 会话索引 TTL：默认走缓存（改夹具不反映）、freshIndex 跳过缓存（即时反映）
 *  - 端点：GET /api/work-search 200 / 空 q 400（appAssembler 装配真相）
 * 纪律：全合成夹具 + 临时目录零出网；新测试文件不用 node:sqlite（AGENTS.md 坑 5）——
 * 会话索引用 claude 文件源夹具；模块级会话索引缓存在 TTL 用例外全部 freshIndex 求确定性；
 * redact.registerSecret 用 try/finally clearSecrets 防跨用例泄漏。
 * 运行：node --test test/work-search.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { workSearch, parseTerms, MAX_PER_GROUP } = require('../lib/workSearch');
const { HttpError } = require('../lib/router');
const redact = require('../lib/redact');

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const MIN = 60 * 1000;

let tmpRoot;
let dataDir;
let claudeRoot;
const config = () => ({ dataDir, agentActivity: { enabled: true, sources: { claude: { root: claudeRoot } } } });

function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function write(file, content, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (Number.isFinite(mtimeMs)) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

/** 造一条 claude 会话（首条 user 文本即列表标题） */
function claudeSession(dirName, file, firstText, mtimeMs) {
  return write(
    path.join(claudeRoot, dirName, file),
    JSON.stringify({ type: 'user', timestamp: new Date(mtimeMs).toISOString(), message: { role: 'user', content: firstText } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, cwd: 'C:\\proj\\ws' }) + '\n',
    mtimeMs
  );
}

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-wsearch-'));
  dataDir = mk(path.join(tmpRoot, 'data'));
  claudeRoot = mk(path.join(tmpRoot, 'claude', 'projects'));
  // 四组夹具：共同词「拓扑」+ 专属词
  writeJSON(path.join(dataDir, 'tasks.json'), {
    columns: [
      { id: 'todo', name: '待办' },
      { id: 'doing', name: '进行中' },
      { id: 'done', name: '已完成' },
    ],
    tasks: [
      { id: 't-ws-1', title: '拓扑视图瘦身', desc: '删除 SVG 图模式', status: 'done', updatedAt: new Date(NOW - 5 * MIN).toISOString(), artifacts: [{ url: 'https://gitea/x/commit/1', kind: 'commit', title: 'fix: 拓扑限高 480px', messageBody: '' }] },
      { id: 't-ws-2', title: '日报自动档', desc: 'maybeAutoDaily 挂轮询', status: 'doing', updatedAt: new Date(NOW - 30 * MIN).toISOString(), artifacts: [] },
      { id: 't-ws-3', title: '周报周期修正', desc: '', status: 'done', updatedAt: new Date(NOW - 60 * MIN).toISOString(), artifacts: [] },
    ],
  });
  writeJSON(path.join(dataDir, 'activities.json'), [
    { type: 'commit', repo: 'example-org/fde-console', branch: 'main', title: 'feat: 拓扑限高 480px', messageBody: '面板体限高', url: 'https://gitea/commit/a1', occurredAt: new Date(NOW - 10 * MIN).toISOString(), fetchedAt: new Date(NOW).toISOString() },
    { type: 'pr', repo: 'example-org/fde-console', branch: null, title: '周报完整周期标签', messageBody: '', url: 'https://gitea/pulls/9', occurredAt: new Date(NOW - 40 * MIN).toISOString(), fetchedAt: new Date(NOW).toISOString() },
    { type: 'branch_created', repo: 'example-org/fde-console', branch: 'task/x', title: 'task/x', url: 'https://gitea/tree/x', occurredAt: new Date(NOW - 50 * MIN).toISOString(), fetchedAt: new Date(NOW).toISOString() },
  ]);
  writeJSON(path.join(dataDir, 'diary.json'), [
    { taskId: 't-ws-1', date: '2026-10-29', content: '今天把拓扑面板限高改成 480px 并加了滚动', updatedAt: new Date(NOW - 20 * MIN).toISOString() },
    { taskId: 't-ws-2', date: '2026-10-28', content: '日报自动档守卫序验证', updatedAt: new Date(NOW - 26 * 60 * MIN).toISOString() },
  ]);
  claudeSession('proj-ws', '11111111-0000-1111-2222-333333333301.jsonl', '看下拓扑页为什么会白屏', NOW - 15 * MIN);
  claudeSession('proj-ws', '11111111-0000-1111-2222-333333333302.jsonl', '把周报面板改成 tab 布局', NOW - 45 * MIN);
});

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) { /* Windows 句柄延迟 EPERM 容忍 */ }
});

// ---------- 基础 ----------

test('parseTerms：空白拆词取前 6，空查询空数组', () => {
  assert.deepEqual(parseTerms('  拓扑   限高 '), ['拓扑', '限高']);
  assert.deepEqual(parseTerms('a b c d e f g h'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(parseTerms('   '), []);
  assert.deepEqual(parseTerms(null), []);
});

test('四组命中：同一词跨任务/会话/提交/日报全部出结果，响应形状完整', () => {
  const r = workSearch(config(), '拓扑', { now: NOW, freshIndex: true });
  assert.equal(r.q, '拓扑');
  assert.ok(Number.isFinite(r.tookMs));
  assert.equal(r.total, r.groups.tasks.length + r.groups.sessions.length + r.groups.commits.length + r.groups.diaries.length);
  // 任务组：标题命中
  assert.ok(r.groups.tasks.some((t) => t.id === 't-ws-1' && t.snippet.includes('拓扑')));
  // 会话组：标题（首条 user 文本）命中
  assert.ok(r.groups.sessions.some((s) => s.agent === 'claude' && s.title.includes('拓扑') && typeof s.ref === 'string'));
  // 提交组：commit 标题命中、branch_created 不参与
  assert.equal(r.groups.commits.length, 1);
  assert.equal(r.groups.commits[0].kind, 'commit');
  assert.ok(r.groups.commits[0].url.startsWith('https://'));
  // 日报组：全文命中
  assert.ok(r.groups.diaries.some((d) => d.taskId === 't-ws-1' && d.date === '2026-10-29' && d.snippet.includes('拓扑')));
});

test('匹配口径：多词 AND 跨字段命中（词1在标题、词2在描述）；缺任一词不命中；大小写不敏感', () => {
  const hit = workSearch(config(), '日报 maybeAutoDaily', { now: NOW, freshIndex: true });
  assert.ok(hit.groups.tasks.some((t) => t.id === 't-ws-2'), '跨字段 AND 命中');
  const miss = workSearch(config(), '日报 SVG', { now: NOW, freshIndex: true });
  assert.ok(!miss.groups.tasks.some((t) => t.id === 't-ws-2') && !miss.groups.tasks.some((t) => t.id === 't-ws-1'), '两词分属两任务 → 都不命中');
  const ci = workSearch(config(), 'MAYBEAUTODAILY', { now: NOW, freshIndex: true });
  assert.ok(ci.groups.tasks.some((t) => t.id === 't-ws-2'), '大小写不敏感');
});

test('组内时间倒序 + 每组截断 8 条', () => {
  const dir = mk(path.join(tmpRoot, 'data-many'));
  const tasks = [];
  for (let i = 0; i < 10; i++) {
    tasks.push({ id: `t-many-${i}`, title: `批量条目 ${i}`, status: 'todo', updatedAt: new Date(NOW - i * MIN).toISOString(), artifacts: [] });
  }
  writeJSON(path.join(dir, 'tasks.json'), {
    columns: [{ id: 'todo', name: '待办' }],
    tasks,
  });
  const r = workSearch({ dataDir: dir, agentActivity: { sources: {} } }, '批量条目', { now: NOW });
  assert.equal(r.groups.tasks.length, MAX_PER_GROUP);
  assert.equal(r.groups.tasks[0].id, 't-many-0', '最新在前');
});

test('空查询 400 FIELD_INVALID', () => {
  assert.throws(() => workSearch(config(), '   ', { now: NOW }), (e) => e instanceof HttpError && e.status === 400 && e.code === 'FIELD_INVALID');
  assert.throws(() => workSearch(config(), '', { now: NOW }), (e) => e.status === 400);
});

// ---------- 脱敏与隔离 ----------

test('redact：注册密钥出现在任务标题 → 搜索出口脱敏', () => {
  const dir = mk(path.join(tmpRoot, 'data-redact'));
  writeJSON(path.join(dir, 'tasks.json'), {
    columns: [{ id: 'todo', name: '待办' }],
    tasks: [{ id: 't-r', title: '轮询凭据 sk-live-abc123456 审计', status: 'todo', updatedAt: new Date(NOW).toISOString(), artifacts: [] }],
  });
  redact.registerSecret('sk-live-abc123456');
  try {
    const r = workSearch({ dataDir: dir, agentActivity: { sources: {} } }, '凭据', { now: NOW });
    const t = r.groups.tasks.find((x) => x.id === 't-r');
    assert.ok(t, '命中');
    assert.equal(t.title.includes('sk-live-abc123456'), false, '标题已脱敏');
    assert.ok(t.title.includes('[REDACTED]'));
  } finally {
    redact.clearSecrets();
  }
});

test('隔离降级：activities.json 损坏 → 提交组空返，其余组照常命中', () => {
  const dir = mk(path.join(tmpRoot, 'data-broken'));
  writeJSON(path.join(dir, 'tasks.json'), {
    columns: [{ id: 'todo', name: '待办' }],
    tasks: [{ id: 't-b', title: '拓扑回归', status: 'todo', updatedAt: new Date(NOW).toISOString(), artifacts: [] }],
  });
  fs.writeFileSync(path.join(dir, 'activities.json'), '{oops 不是 JSON');
  const r = workSearch({ dataDir: dir, agentActivity: { sources: {} } }, '拓扑', { now: NOW });
  assert.deepEqual(r.groups.commits, [], '损坏文件组空返');
  assert.equal(r.groups.tasks.length, 1, '其余组不受拖累');
});

// ---------- 会话索引 TTL ----------

test('会话索引 TTL：TTL 内走缓存（改动不反映），freshIndex 即时反映', () => {
  const f = claudeSession('proj-ttl', '22222222-0000-1111-2222-333333333301.jsonl', '缓存探针会话阿尔法', NOW - 3 * MIN);
  const r1 = workSearch(config(), '阿尔法', { now: NOW, freshIndex: true });
  assert.equal(r1.groups.sessions.length, 1, 'fresh 首查命中');
  // TTL 内不 fresh：夹具改成贝塔后，旧缓存里仍是阿尔法 → 旧词命中、新词不命中
  write(f, JSON.stringify({ type: 'user', timestamp: new Date(NOW).toISOString(), message: { role: 'user', content: '缓存探针会话贝塔' } }) + '\n');
  const stale = workSearch(config(), '阿尔法', { now: NOW + 5 * 1000 });
  assert.equal(stale.groups.sessions.length, 1, 'TTL 内旧缓存：旧词仍命中');
  const missNew = workSearch(config(), '贝塔', { now: NOW + 5 * 1000 });
  assert.equal(missNew.groups.sessions.length, 0, 'TTL 内旧缓存：新词不命中');
  const fresh = workSearch(config(), '贝塔', { now: NOW + 5 * 1000, freshIndex: true });
  assert.equal(fresh.groups.sessions.length, 1, 'freshIndex 即时反映改动');
});

test('buildSessionIndex：TTL 内返回同一缓存引用，超时后重扫出新引用', () => {
  claudeSession('proj-ttl2', '33333333-0000-1111-2222-333333333301.jsonl', '索引重扫探针', NOW - 2 * MIN);
  const first = require('../lib/workSearch').buildSessionIndex(config(), NOW, true); // 重建，at=NOW
  const cached = require('../lib/workSearch').buildSessionIndex(config(), NOW + 30 * 1000, false);
  assert.strictEqual(cached, first, 'TTL 内返回同一数组（未重扫）');
  const rebuilt = require('../lib/workSearch').buildSessionIndex(config(), NOW + 61 * 1000, false);
  assert.notStrictEqual(rebuilt, first, '超时后重扫出新数组');
  assert.ok(rebuilt.some((i) => i.title.includes('索引重扫探针')), '重扫后数据可用');
});

// ---------- 端点层（appAssembler 装配真相） ----------

test('端点：GET /api/work-search 200 契约与空 q 400', async () => {
  const cfgPath = path.join(tmpRoot, 'ws-endpoint', 'config.json');
  writeJSON(cfgPath, {
    port: 7845,
    host: '127.0.0.1',
    dataDir,
    webDir: path.join(tmpRoot, 'ws-endpoint', 'web'),
    gitea: { pollIntervalSec: 0 },
    agentActivity: { enabled: true, sources: { claude: { root: claudeRoot } } },
  });
  const { buildApp } = require('./helpers/appAssembler');
  const app = buildApp({ poller: 'manual', warmProbe: false, configPath: cfgPath });
  try {
    const hit = await app.fetch('GET', `/api/work-search?q=${encodeURIComponent('拓扑 限高')}`, {});
    assert.equal(hit.status, 200);
    assert.ok(Array.isArray(hit.body.groups.tasks));
    assert.ok(hit.body.groups.tasks.some((t) => t.id === 't-ws-1'), '端点路径命中任务组（成果提交说明「拓扑限高」跨字段）');
    const bad = await app.fetch('GET', '/api/work-search?q=%20%20', {});
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'FIELD_INVALID');
    const none = await app.fetch('GET', `/api/work-search?q=${encodeURIComponent('不存在的词组xyzq')}`, {});
    assert.equal(none.status, 200);
    assert.equal(none.body.total, 0);
    for (const k of ['tasks', 'sessions', 'commits', 'diaries']) {
      assert.ok(Array.isArray(none.body.groups[k]), `空结果四组数组齐全：${k}`);
    }
  } finally {
    app.close();
  }
});
