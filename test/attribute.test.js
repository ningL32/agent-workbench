'use strict';

/**
 * attribute.test.js — v1.9 分支约定最小切片②：Gitea 轮询落盘后成果自动归因
 * 覆盖：精确规则三分支（分支精确 / task/<id> 前缀 / 提交关键字 [#id]）、无命中零写盘、
 *       同 url 去重幂等（重扫不重复挂）、kind 映射（commit_pushed→commit、pr_*→pr）、
 *       branch_created/branch_deleted 与无 url 跳过、artifact 形状 + artifact 事件 detail、
 *       无任务零写盘、以及 pollActivities→归因 的真机接线（GITEA_FIXTURE + refresh=1）。
 * 运行：node --test test/attribute.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7806; // 仅作 fixture 配置留痕（进程内装配不再监听端口）

const attribute = require('../lib/attribute.js');
const { buildApp } = require('./helpers/appAssembler');

// ---------------------------------------------------------------- 单元：attributeActivities

function seedDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-attr-'));
  return dir;
}

function writeTasks(dir, tasks) {
  fs.writeFileSync(
    path.join(dir, 'tasks.json'),
    JSON.stringify({
      columns: [
        { id: 'todo', name: '待分配', order: 1 },
        { id: 'doing', name: '进行中', order: 2 },
        { id: 'review', name: '待验证', order: 3 },
        { id: 'done', name: '已完成', order: 4 },
      ],
      tasks,
    })
  );
}

function writeActivities(dir, activities) {
  fs.writeFileSync(path.join(dir, 'activities.json'), JSON.stringify(activities));
}

function readTasks(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8')).tasks;
}

function readEvents(dir) {
  const file = path.join(dir, 'task_events.json');
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : raw.events || [];
}

function pathsOf(dir) {
  return {
    tasksPath: path.join(dir, 'tasks.json'),
    taskEventsPath: path.join(dir, 'task_events.json'),
    activitiesPath: path.join(dir, 'activities.json'),
  };
}

function act(partial) {
  return {
    id: 'a-1',
    type: 'commit_pushed',
    actor: 'agent-kilo',
    repo: 'example-org/demo',
    branch: null,
    title: '',
    url: '',
    occurredAt: '2026-10-17T00:00:00.000Z',
    fetchedAt: '2026-10-18T00:00:00.000Z',
    ...partial,
  };
}

test('matchReason：三分支精确规则逐条命中，跨任务 id 不误命中', () => {
  const task = { id: 't-x-0001', branch: 'feat/sso' };
  assert.strictEqual(attribute.matchReason({ branch: 'feat/sso' }, task).rule, 'branch_equal', '规则 a：精确相等');
  assert.strictEqual(
    attribute.matchReason({ branch: 'task/t-x-0001' }, { id: 't-x-0001', branch: null }).rule,
    'branch_prefix',
    '规则 b：task/<id> 前缀'
  );
  assert.strictEqual(
    attribute.matchReason({ branch: null, title: 'fix: 处理 [#t-x-0001] 超时' }, task).rule,
    'commit_ref',
    '规则 c：提交关键字'
  );
  assert.strictEqual(attribute.matchReason({ branch: 'feat/other' }, task), null, '无关分支不命中');
  assert.strictEqual(
    attribute.matchReason({ branch: 'task/t-y-9999' }, { id: 't-x-0001', branch: null }),
    null,
    '他任务的约定分支不命中本任务'
  );
  assert.strictEqual(attribute.matchReason({ branch: 'feat/sso' }, { id: 't-x-0001', branch: null }), null, 'task.branch 为空时规则 a 不生效');
  assert.strictEqual(attribute.matchReason({ branch: '', title: '' }, task), null, '双空不命中');
});

test('仓库护栏：跨仓同名 branch 不命中（demo-plan main 曾灌进 fde-console 任务），同仓/单方未知维持旧口径', () => {
  const task = { id: 't-x-0001', branch: 'main', repo: 'example-org/fde-console' };
  // 跨仓同名 branch：护栏拦截（本 bug 的直接复现）
  assert.strictEqual(
    attribute.matchReason({ branch: 'main', repo: 'example-org/demo-plan', title: 'chore: 局域网' }, task),
    null,
    '跨仓同名 branch 不命中'
  );
  // 同仓同名 branch：正常命中
  assert.strictEqual(
    attribute.matchReason({ branch: 'main', repo: 'example-org/fde-console' }, task).rule,
    'branch_equal',
    '同仓同名 branch 正常命中'
  );
  // 任一方 repo 未知：维持旧口径（不做更强推断）
  assert.strictEqual(
    attribute.matchReason({ branch: 'main', repo: null }, task).rule,
    'branch_equal',
    'activity.repo 未知不拦'
  );
  assert.strictEqual(
    attribute.matchReason({ branch: 'main', repo: 'example-org/other' }, { id: 't-x-0001', branch: 'main', repo: null }).rule,
    'branch_equal',
    'task.repo 未知不拦'
  );
  // 跨仓时带任务 id 的标记仍不出（护栏统一最前；[#id] 跨仓本就是异常信号）
  assert.strictEqual(
    attribute.matchReason({ branch: null, title: 'fix: [#t-x-0001] 超时', repo: 'example-org/tds' }, task),
    null,
    '跨仓连 commit_ref 标记也不命中'
  );
  // repoMismatch 直测
  assert.strictEqual(attribute.repoMismatch({ repo: 'a/b' }, { repo: 'c/d' }), true);
  assert.strictEqual(attribute.repoMismatch({ repo: 'a/b' }, { repo: 'a/b' }), false);
  assert.strictEqual(attribute.repoMismatch({ repo: 'a/b' }, { repo: null }), false);
  assert.strictEqual(attribute.repoMismatch({ repo: null }, { repo: 'a/b' }), false);
});

test('全量扫描：三分支各一例命中、kind 映射、branch_*/无 url 跳过、artifact 形状与事件 detail', () => {
  const dir = seedDir();
  try {
    writeTasks(dir, [
      { id: 't-a-0001', title: '分支精确任务', branch: 'feat/sso', updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 't-b-0002', title: '前缀任务（无 branch 字段）', updatedAt: '2026-10-01T00:00:00.000Z' }, // 存量形态：无 artifacts
      { id: 't-c-0003', title: '提交关键字任务', branch: 'feat/other', updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 't-d-0004', title: '无关任务', branch: null, updatedAt: '2026-10-01T00:00:00.000Z' },
    ]);
    writeActivities(dir, [
      act({ id: 'a-1', type: 'commit_pushed', branch: 'feat/sso', title: 'fix: x', url: 'https://gitea.example/example-org/demo/commit/1' }),
      act({ id: 'a-2', type: 'pr_opened', branch: 'task/t-b-0002', title: 'pr for b', url: 'https://gitea.example/example-org/demo/pulls/2' }),
      act({ id: 'a-3', type: 'pr_merged', branch: 'task/t-b-0002', title: 'pr for b', url: 'https://gitea.example/example-org/demo/pulls/2' }), // 同 url：去重
      act({ id: 'a-4', type: 'commit_pushed', branch: null, title: 'fix: 修复 [#t-c-0003] 登录超时', url: 'https://gitea.example/example-org/demo/commit/4' }),
      act({ id: 'a-5', type: 'branch_created', branch: 'feat/sso', title: 'feat/sso', url: 'https://gitea.example/example-org/demo/src/branch/feat/sso' }), // 跳过
      act({ id: 'a-6', type: 'branch_deleted', branch: 'feat/sso', title: 'feat/sso', url: 'https://gitea.example/example-org/demo/src/branch/feat/sso?deleted' }), // 跳过
      act({ id: 'a-7', type: 'commit_pushed', branch: 'feat/zzz', title: 'unrelated', url: 'https://gitea.example/example-org/demo/commit/7' }), // 无命中
      act({ id: 'a-8', type: 'pr_opened', branch: 'feat/sso', title: 'no url', url: '' }), // 无 url 跳过
    ]);

    const result = attribute.attributeActivities(pathsOf(dir));
    assert.strictEqual(result.attributed, 3, '恰 3 条成果挂上（同 url 去重 + 5 条跳过/无命中）');
    assert.strictEqual(result.touched, 3, '3 个任务被更新');

    const tasks = readTasks(dir);
    const [ta, tb, tc, td] = tasks;

    // 规则 a：kind 映射 commit_pushed→commit，ref=branch，at=occurredAt，attributedBy=auto
    // v2.9.15：title/messageBody 随归因落库（activity 无 messageBody 字段时存 null）
    assert.strictEqual(ta.artifacts.length, 1);
    assert.deepStrictEqual(ta.artifacts[0], {
      url: 'https://gitea.example/example-org/demo/commit/1',
      kind: 'commit',
      repo: 'example-org/demo',
      ref: 'feat/sso',
      at: '2026-10-17T00:00:00.000Z',
      title: 'fix: x',
      messageBody: null,
      attributedBy: 'auto',
    });
    assert.notStrictEqual(ta.updatedAt, '2026-10-01T00:00:00.000Z', 'updatedAt 已刷新');

    // 规则 b：pr_opened→pr；同 PR 的 pr_merged 同 url 不重复挂
    assert.strictEqual(tb.artifacts.length, 1, '同 url 去重：opened+merged 只挂一条');
    assert.strictEqual(tb.artifacts[0].kind, 'pr');
    assert.strictEqual(tb.artifacts[0].ref, 'task/t-b-0002');
    assert.strictEqual(tb.artifacts[0].attributedBy, 'auto');

    // 规则 c：提交关键字命中（与 task.branch 无关），branch 为 null → ref null
    assert.strictEqual(tc.artifacts.length, 1);
    assert.strictEqual(tc.artifacts[0].kind, 'commit');
    assert.strictEqual(tc.artifacts[0].ref, null);

    assert.ok(!Array.isArray(td.artifacts), '无命中任务不产生 artifacts 字段');

    // 事件流：3 条 artifact 事件，detail 与命中规则对应
    const events = readEvents(dir).filter((e) => e.type === 'artifact');
    assert.strictEqual(events.length, 3);
    const details = events.map((e) => e.detail).sort();
    assert.deepStrictEqual(details, [
      '自动归因：branch feat/sso',
      '自动归因：branch task/t-b-0002',
      '自动归因：提交 [#t-c-0003]',
    ]);
    assert.ok(events.every((e) => e.from === null && e.to === null), 'artifact 事件 from/to 为 null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backfillArtifactMeta：url 命中回填 title/messageBody；session/已有值/窗外 url 不动', () => {
  const tasks = [
    {
      id: 't-1',
      artifacts: [
        { url: 'https://x/c/1', kind: 'commit', attributedBy: 'auto' }, // 窗内：回填
        { url: 'https://x/c/2', kind: 'commit', title: '已有说明', attributedBy: 'auto' }, // 已有：不覆盖
        { url: 'https://x/c/3', kind: 'commit', attributedBy: 'manual' }, // 窗外：不动
        { sessionRef: 'ref', title: '会话成果', kind: 'session', url: null }, // session：不参与
      ],
    },
  ];
  const acts = [
    { url: 'https://x/c/1', title: 'feat: 回填说明', messageBody: '正文首段' },
    { url: 'https://x/c/2', title: '不应覆盖', messageBody: 'x' },
  ];
  const filled = attribute.backfillArtifactMeta(tasks, acts);
  const [a, b, c, sess] = tasks[0].artifacts;
  assert.strictEqual(filled, 1, '恰回填 1 条');
  assert.strictEqual(a.title, 'feat: 回填说明');
  assert.strictEqual(a.messageBody, '正文首段');
  assert.strictEqual(b.title, '已有说明');
  assert.strictEqual(c.title, undefined);
  assert.strictEqual(sess.title, '会话成果');
  assert.strictEqual(attribute.backfillArtifactMeta([], acts), 0, '空任务零回填');
  assert.strictEqual(attribute.backfillArtifactMeta(tasks, null), 0, 'activities 非数组容错');
});

test('归因写路径：title/messageBody 随归因落库且 ≤300 字截帽', () => {
  const dir = seedDir();
  try {
    writeTasks(dir, [{ id: 't-cap-0001', title: '截帽任务', branch: 'feat/cap', updatedAt: '2026-10-01T00:00:00.000Z' }]);
    writeActivities(dir, [
      act({
        id: 'a-cap', type: 'commit_pushed', branch: 'feat/cap', url: 'https://gitea.example/example-org/demo/commit/cap',
        title: 'x'.repeat(400), messageBody: 'y'.repeat(400),
      }),
    ]);
    attribute.attributeActivities(pathsOf(dir));
    const [t] = readTasks(dir);
    assert.strictEqual(t.artifacts[0].title.length, 300, 'title 截到 300');
    assert.strictEqual(t.artifacts[0].messageBody.length, 300, 'messageBody 截到 300');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('幂等：同输入重扫 attributed=0，落盘内容逐字节不变', () => {
  const dir = seedDir();
  try {
    writeTasks(dir, [{ id: 't-a-0001', title: 'x', branch: 'feat/sso', updatedAt: '2026-10-01T00:00:00.000Z' }]);
    writeActivities(dir, [
      act({ id: 'a-1', branch: 'feat/sso', url: 'https://gitea.example/example-org/demo/commit/1' }),
    ]);
    const first = attribute.attributeActivities(pathsOf(dir));
    assert.strictEqual(first.attributed, 1);
    const snapshot = fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8');
    const eventsSnapshot = fs.readFileSync(path.join(dir, 'task_events.json'), 'utf8');

    const second = attribute.attributeActivities(pathsOf(dir));
    assert.strictEqual(second.attributed, 0, 'url 去重 → 重扫零新增');
    assert.strictEqual(second.touched, 0);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'), snapshot, 'tasks.json 未被改写');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'task_events.json'), 'utf8'), eventsSnapshot, '事件未重复追加');
    assert.strictEqual(readEvents(dir).length, 1, '仍只有首扫的 1 条事件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('零写盘：无任务 / 无动态 / 无命中均不写任何文件', () => {
  // 无任务：只有 activities.json → tasks.json 不被创建
  const dirNoTasks = seedDir();
  try {
    writeActivities(dirNoTasks, [act({ branch: 'feat/sso', url: 'https://gitea.example/c/1' })]);
    const r1 = attribute.attributeActivities(pathsOf(dirNoTasks));
    assert.deepStrictEqual(r1, { attributed: 0, touched: 0 });
    assert.strictEqual(fs.existsSync(path.join(dirNoTasks, 'tasks.json')), false, '无任务零写盘');
  } finally {
    fs.rmSync(dirNoTasks, { recursive: true, force: true });
  }

  // 无动态：只有 tasks.json → tasks.json 与 task_events.json 均不动
  const dirNoActs = seedDir();
  try {
    writeTasks(dirNoActs, [{ id: 't-a-0001', title: 'x', branch: 'feat/sso' }]);
    const snapshot = fs.readFileSync(path.join(dirNoActs, 'tasks.json'), 'utf8');
    const r2 = attribute.attributeActivities(pathsOf(dirNoActs));
    assert.deepStrictEqual(r2, { attributed: 0, touched: 0 });
    assert.strictEqual(fs.readFileSync(path.join(dirNoActs, 'tasks.json'), 'utf8'), snapshot);
    assert.strictEqual(fs.existsSync(path.join(dirNoActs, 'task_events.json')), false, '无命中零写盘');
  } finally {
    fs.rmSync(dirNoActs, { recursive: true, force: true });
  }

  // 有任务有动态但全不命中
  const dirNoHit = seedDir();
  try {
    writeTasks(dirNoHit, [{ id: 't-a-0001', title: 'x', branch: 'feat/sso' }]);
    writeActivities(dirNoHit, [act({ branch: 'feat/zzz', title: 'unrelated', url: 'https://gitea.example/c/9' })]);
    const snapshot = fs.readFileSync(path.join(dirNoHit, 'tasks.json'), 'utf8');
    const r3 = attribute.attributeActivities(pathsOf(dirNoHit));
    assert.deepStrictEqual(r3, { attributed: 0, touched: 0 });
    assert.strictEqual(fs.readFileSync(path.join(dirNoHit, 'tasks.json'), 'utf8'), snapshot);
  } finally {
    fs.rmSync(dirNoHit, { recursive: true, force: true });
  }
});

// ------------------------------------------------- 集成：pollActivities 落盘后自动归因（真机接线）

let app;
let tmpDir;
let fixtureFile;

// WP3：真端口 spawn → 装配器进程内分发（同一 app.handle 管线，断言零改动）；
// GITEA_FIXTURE 经 buildApp env 注入（分发期间生效，等价独立版子进程 env）
async function api(method, p, body) {
  return app.fetch(method, p, {
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-attr-int-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({
      port: PORT,
      host: '127.0.0.1',
      dataDir,
      webDir: path.join(tmpDir, 'web'),
      gitea: { pollIntervalSec: 0 }, // 不自动轮询，refresh=1 手动触发，断言确定
    })
  );
  // 种两个任务：一个分支精确（规则 a），一个无分支靠提交关键字（规则 c）（dataDir 已在上方声明）
  writeTasks(dataDir, [
    { id: 't-int-a-0001', title: '集成·分支精确', branch: 'feat/sso', updatedAt: '2026-10-01T00:00:00.000Z' },
    { id: 't-int-c-0002', title: '集成·提交关键字', branch: null, updatedAt: '2026-10-01T00:00:00.000Z' },
  ]);
  // fixture 覆盖三规则素材（feeds 新格式）：commit_repo×2（分支精确 feat/sso / [#id] 关键字）
  // + 约定分支创建 create_branch（branch_created → 归因跳过）
  fixtureFile = path.join(tmpDir, 'fixture.json');
  const demoRepo = { id: 1, name: 'demo', full_name: 'example-org/demo' };
  const demoFeed = (id, opType, login, refName, content, created) => ({
    id,
    op_type: opType,
    act_user: { login },
    ref_name: refName,
    content,
    created,
    comment: null,
    repo: demoRepo,
  });
  fs.writeFileSync(
    fixtureFile,
    JSON.stringify({
      version: { version: '1.22.0' },
      repos: [
        {
          full_name: 'example-org/demo',
          html_url: 'https://gitea.example.com/example-org/demo',
          default_branch: 'main',
        },
      ],
      feeds: {
        'example-org/demo': [
          // 规则 a：commit_repo（branch=ref_name 去 refs/heads/ → feat/sso 精确命中）
          demoFeed(201, 'commit_repo', 'agent-kilo', 'refs/heads/feat/sso',
            JSON.stringify({
              Commits: [{ Sha1: 'abc1234def', Message: 'feat: sso 登录', Timestamp: '2026-10-17T00:00:00Z' }],
              Len: 1,
            }),
            '2026-10-17T00:00:00Z'),
          // 规则 c：commit_repo（提交信息带 [#t-int-c-0002] 关键字）
          demoFeed(202, 'commit_repo', 'zhangsan', 'refs/heads/main',
            JSON.stringify({
              Commits: [{ Sha1: 'def5678ab', Message: `fix: 修复 [#t-int-c-0002] 登录超时`, Timestamp: '2026-10-17T01:00:00Z' }],
              Len: 1,
            }),
            '2026-10-17T01:00:00Z'),
          // 约定分支创建（branch_created → 归因跳过）
          demoFeed(203, 'create_branch', 'agent-kilo', 'task/t-int-a-0001', '', '2026-10-17T02:00:00Z'),
        ],
      },
    })
  );

  app = buildApp({
    configPath: path.join(tmpDir, 'config.json'),
    env: { GITEA_FIXTURE: fixtureFile },
  });
});

test.after(() => {
  if (app) app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true }); // 测试临时目录用完即清
});

test('refresh=1 轮询落盘后自动归因：三分支归位、branch 类跳过；重复 refresh 靠 url 去重不重复挂', async () => {
  const r1 = await api('GET', '/api/activities?refresh=1');
  assert.strictEqual(r1.status, 200);
  assert.ok(r1.body.length >= 2, 'fixture 动态已落盘（2 commit + 1 branch_created）');

  const dataDir2 = path.join(tmpDir, 'data');
  const tasks = readTasks(dataDir2);
  const ta = tasks.find((t) => t.id === 't-int-a-0001');
  const tc = tasks.find((t) => t.id === 't-int-c-0002');

  // 规则 a：commit 分支 === task.branch（feeds commit_repo 拆条，branch=ref_name 去前缀）→ kind commit
  // v2.9.15：title/messageBody 随归因落库（fixture messageBody 为空串）
  assert.strictEqual(ta.artifacts.length, 1, '分支精确命中且 branch_created（约定分支创建）被跳过');
  assert.deepStrictEqual(ta.artifacts[0], {
    url: 'https://gitea.example.com/example-org/demo/commit/abc1234def',
    kind: 'commit',
    repo: 'example-org/demo',
    ref: 'feat/sso',
    at: '2026-10-17T00:00:00Z',
    title: 'feat: sso 登录',
    messageBody: '',
    attributedBy: 'auto',
  });

  // 规则 c：提交信息 [#id] → kind commit
  assert.strictEqual(tc.artifacts.length, 1);
  assert.strictEqual(tc.artifacts[0].kind, 'commit');
  assert.strictEqual(tc.artifacts[0].url, 'https://gitea.example.com/example-org/demo/commit/def5678ab');

  const events = readEvents(dataDir2).filter((e) => e.type === 'artifact');
  assert.strictEqual(events.length, 2, '恰好 2 条自动归因事件');

  // 重复 refresh（重复轮询落盘）→ url 去重，不重复挂
  const r2 = await api('GET', '/api/activities?refresh=1');
  assert.strictEqual(r2.status, 200);
  const tasks2 = readTasks(dataDir2);
  assert.strictEqual(tasks2.find((t) => t.id === 't-int-a-0001').artifacts.length, 1, '重复轮询不重复挂（commit·分支精确）');
  assert.strictEqual(tasks2.find((t) => t.id === 't-int-c-0002').artifacts.length, 1, '重复轮询不重复挂（commit）');
  assert.strictEqual(
    readEvents(dataDir2).filter((e) => e.type === 'artifact').length,
    2,
    '重复轮询不重复记事件'
  );
});

// ---------- v2.9.25 读侧 matchedTaskIds 同款仓库护栏（routes-gitea matchTaskIds） ----------

test('matchTaskIds：跨仓同名 branch/标题不提示匹配；同仓正常；单方 repo 未知维持旧口径', () => {
  const { matchTaskIds } = require('../lib/routes-gitea');
  const tasks = [
    { id: 't-fde', title: 'FDE工作台优化', branch: 'main', repo: 'example-org/fde-console' },
    { id: 't-sg', title: '生产看板项目', branch: 'main', repo: 'example-org/demo-plan' },
  ];
  // 张三的 demo-plan main 提交 → 只匹配生产看板任务（跨仓护栏拦截 FDE 任务）
  assert.deepEqual(
    matchTaskIds({ branch: 'main', repo: 'example-org/demo-plan', title: 'chore: 局域网改造' }, tasks),
    ['t-sg']
  );
  // fde-console main 提交 → 只匹配 FDE 任务
  assert.deepEqual(
    matchTaskIds({ branch: 'main', repo: 'example-org/fde-console', title: 'fix: 搜索高亮' }, tasks),
    ['t-fde']
  );
  // repo 未知 → 旧口径两任务都提示（branch 同名 + 单方未知不拦）
  assert.deepEqual(
    matchTaskIds({ branch: 'main', repo: null, title: '' }, tasks),
    ['t-fde', 't-sg']
  );
});
