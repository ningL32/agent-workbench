'use strict';

/**
 * overview.test.js — B5 总览聚合 + 成员进度
 * 覆盖：overview 各字段汇总（任务分布/agents/activities24h/gitea 健康；
 *       v2.2 起 gatewayExternalRunning、v2.3 起 sessionsRunning 字段均随退役移除），
 *       gitea-status.json 缺失 → {"ok":false,"lastPollAt":null,"lastError":"尚未轮询"}，
 *       members 聚合（kind/status/currentTask/session/统计）。
 * 运行：node --test test/overview.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7793; // 仅作 fixture 配置留痕（进程内装配不再监听端口）

const { buildApp } = require('./helpers/appAssembler');
const { createWorkbuddyDb } = require('./helpers/workbuddy-fixture');

let app;
let tmpDir;
let dataDir;

// WP3：真端口 spawn → 装配器进程内分发（同一 app.handle 管线，断言零改动）
async function api(method, p, body) {
  return app.fetch(method, p, {
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function writeData(file, obj) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(obj));
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-overview-'));
  dataDir = path.join(tmpDir, 'data');
  // v2.5 硅基成员=workbuddy 源：注入夹具 db，避免 computeMembers 读到本机真实 ~/.workbuddy
  const wbDb = createWorkbuddyDb(path.join(tmpDir, 'workbuddy.db'), [
    { id: 'wb-live-01', cwd: tmpDir, title: '评审输入整理', status: 'running', created_at: Date.now() - 3600e3, last_activity_at: Date.now() - 60e3 },
    { id: 'wb-done-01', cwd: tmpDir, title: '周报汇总', status: 'completed', created_at: Date.now() - 26 * 3600e3, last_activity_at: Date.now() - 25 * 3600e3 },
  ]);
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({
      port: PORT,
      host: '127.0.0.1',
      dataDir,
      webDir: path.join(tmpDir, 'web'),
      gitea: { pollIntervalSec: 0 },
      // v2.6：codex/opencode 指向不存在路径（确定性：不读本机真实数据；workbuddy 沿用夹具 db）
      agentActivity: { sources: { workbuddy: { dbPath: wbDb }, codex: { root: path.join(tmpDir, 'no-codex') }, opencode: { dbPath: path.join(tmpDir, 'no-opencode.db') } } },
    })
  );
  app = buildApp({ configPath: path.join(tmpDir, 'config.json') });
});

test.after(() => {
  if (app) app.close();
});

test('冷启动 overview：全零 + gitea 未轮询默认值', async () => {
  const r = await api('GET', '/api/overview');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.tasks, { todo: 0, doing: 0, review: 0, done: 0, overdue: 0 });
  assert.strictEqual(r.body.agents, 9);
  assert.strictEqual(r.body.sessionsRunning, undefined, 'v2.3：sessionsRunning 已随会话登记表退役移除');
  assert.strictEqual(r.body.activities24h, 0);
  assert.deepStrictEqual(r.body.gitea, { ok: false, lastPollAt: null, lastError: '尚未轮询' });
});

test('建任务后 tasks 分布汇总正确', async () => {
  await api('POST', '/api/tasks', { title: '任务一' });
  await api('POST', '/api/tasks', { title: '任务二' });
  const b = await api('POST', '/api/tasks', { title: '任务三' });
  await api('PATCH', `/api/tasks/${b.body.id}`, { status: 'doing' });

  const r = await api('GET', '/api/overview');
  assert.deepStrictEqual(r.body.tasks, { todo: 2, doing: 1, review: 0, done: 0, overdue: 0 });
});

test('diaryMissing 只增字段：名下 doing 无当天日报的负责人去重计数（驾驶舱行动条数据源）', async () => {
  const localToday = () => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  };
  // 共享 fixture 里此前用例可能已留下无日报的 doing 负责人——用增量断言不锁绝对值
  const before = (await api('GET', '/api/overview')).body.diaryMissing;
  // alice 两个 doing 都没日报 → +1；bob 的 doing 填了日报 → 不计；todo 任务不参与
  const a = await api('POST', '/api/tasks', { title: '无日报任务甲', memberId: 'alice' });
  const b = await api('POST', '/api/tasks', { title: '无日报任务乙', memberId: 'alice' });
  const c = await api('POST', '/api/tasks', { title: '已填日报任务丙', memberId: 'bob' });
  const todo = await api('POST', '/api/tasks', { title: '/todo/ 不参与', memberId: 'carol' });
  const p1 = await api('PATCH', `/api/tasks/${a.body.id}`, { status: 'doing' });
  const p2 = await api('PATCH', `/api/tasks/${b.body.id}`, { status: 'doing' });
  const p3 = await api('PATCH', `/api/tasks/${c.body.id}`, { status: 'doing' });
  assert.strictEqual(p1.status, 200, 'PATCH doing 甲');
  assert.strictEqual(p2.status, 200, 'PATCH doing 乙');
  assert.strictEqual(p3.status, 200, 'PATCH doing 丙');
  const pd = await api('PUT', `/api/tasks/${c.body.id}/diary`, { date: localToday(), content: 'bob 今天填了日报' });
  assert.ok(pd.status === 201 || pd.status === 200, `diary PUT 应成功，实得 ${pd.status}: ${JSON.stringify(pd.body)}`);

  let r = await api('GET', '/api/overview');
  assert.strictEqual(r.body.diaryMissing, before + 1, 'alice 计 +1、bob 已填不计、carol 的 todo 不参与');

  await api('PUT', `/api/tasks/${a.body.id}/diary`, { date: localToday(), content: 'alice 补填其一' });
  r = await api('GET', '/api/overview');
  const afterAlice = r.body.diaryMissing;
  assert.strictEqual(afterAlice, before, '任一 doing 任务当天有日报即视为已填（diaryToday 同口径）');

  // agent 属主排除（评审 P1：diary 是人工日报，硅基属主恒计「未填」属虚计）
  const ag = await api('POST', '/api/tasks', { title: '硅基属主任务', agentId: 'workbuddy' });
  await api('PATCH', `/api/tasks/${ag.body.id}`, { status: 'doing' });
  r = await api('GET', '/api/overview');
  assert.strictEqual(r.body.diaryMissing, afterAlice, 'agentId 属主的 doing 任务不计入日报未填');
});

test('gitea-status.json 存在时 overview 读取其内容（只读）', async () => {
  writeData('gitea-status.json', {
    ok: true,
    lastPollAt: '2026-10-16T08:00:00Z',
    lastError: null,
  });
  const r = await api('GET', '/api/overview');
  assert.deepStrictEqual(r.body.gitea, { ok: true, lastPollAt: '2026-10-16T08:00:00Z', lastError: null });
});

test('activities.json 按数组存储可被统计（24h 内计数）', async () => {
  const now = Date.now();
  writeData('activities.json', [
    {
      id: 'a-01', type: 'commit_pushed', actor: 'agent-kilo', repo: 'example-org/fde-api',
      branch: 'feat/x', title: 'feat: x', url: 'https://gitea.example.com/example-org/fde-api/commit/1',
      occurredAt: new Date(now - 3600 * 1000).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
    {
      id: 'a-02', type: 'pr_opened', actor: 'qianqi', repo: 'example-org/fde-api',
      branch: 'feat/sso', title: 'feat: SSO 登录', url: 'https://gitea.example.com/example-org/fde-api/pulls/12',
      occurredAt: new Date(now - 2 * 3600 * 1000).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
    {
      id: 'a-03', type: 'commit_pushed', actor: 'agent-kilo', repo: 'example-org/fde-api',
      branch: 'feat/y', title: 'feat: y', url: 'https://gitea.example.com/example-org/fde-api/commit/2',
      occurredAt: new Date(now - 48 * 3600 * 1000).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
  ]);
  const r = await api('GET', '/api/overview');
  assert.strictEqual(r.body.activities24h, 2, '48h 前的一条不计入');
});

// ---------- v2.3：sessionsRunning 字段已随会话登记表退役移除（原「活会话计入 sessionsRunning」用例一并删除） ----------

// ---------- v2.2：gatewayExternalRunning 字段已随 网关集成移除 ----------
// （原 v1.8.1 统计口径用例与 cli-gateway 日志夹具一并删除；overview 响应不再含该字段）

test('GET /api/members：硅基成员=指定桌面 agent（workbuddy），CLI 注册表不再逐个入册，动态 actor 不入册（v2.9.1）', async () => {
  const r = await api('GET', '/api/members');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body));

  // v2.5：agents.json 注册表（claude/kilo…）只是启动器，不再作为硅基成员逐个列出
  assert.ok(!r.body.some((m) => m.id === 'claude'), 'claude 不再是成员（启动器在智能体页）');
  assert.ok(!r.body.some((m) => m.id === 'kilo'), 'kilo 不再是成员');

  const wb = r.body.find((m) => m.id === 'workbuddy');
  assert.ok(wb, '指定桌面 agent 应在花名册');
  assert.strictEqual(wb.kind, 'agent');
  assert.strictEqual(wb.manual, false);
  assert.strictEqual(wb.role, '桌面 Agent');
  assert.strictEqual(wb.status, 'working', 'running 会话 → working');
  assert.ok(wb.session && wb.session.alive === true, 'running 会话视作 alive');
  assert.strictEqual(wb.todayCommits, 0, '桌面 agent 无 Gitea 身份，提交统计恒 0');

  // v2.9.1：动态流 actor 自动派生整条退役——qianqi 仅在动态里出现过，不得入册
  assert.ok(!r.body.some((m) => m.id === 'qianqi'), '动态 actor qianqi 不得派生入册');
});

test('doing 任务 + 匹配 PR → progress 0.6 / 无 PR 0.3（任务挂桌面 agent）', async () => {
  // 写一个 doing 任务 branch=feat/sso（与上面 qianqi 的 pr_opened branch 匹配），挂 workbuddy
  const t = await api('POST', '/api/tasks', { title: '接入SSO', branch: 'feat/sso', agentId: 'workbuddy' });
  await api('PATCH', `/api/tasks/${t.body.id}`, { status: 'doing' });

  const r = await api('GET', '/api/members');
  const wb = r.body.find((m) => m.id === 'workbuddy');
  assert.ok(wb.currentTask, 'workbuddy 应有当前任务');
  assert.strictEqual(wb.currentTask.progress, 0.6, 'doing 且分支命中开放 PR → 0.6');
  assert.strictEqual(wb.status, 'working');

  // 无 PR 匹配的 doing 任务（更新更晚 → 成为 currentTask）
  const t2 = await api('POST', '/api/tasks', { title: '普通任务无PR', agentId: 'workbuddy' });
  await api('PATCH', `/api/tasks/${t2.body.id}`, { status: 'doing' });
  const r2 = await api('GET', '/api/members');
  const wb2 = r2.body.find((m) => m.id === 'workbuddy');
  assert.strictEqual(wb2.currentTask.progress, 0.3, 'doing 无匹配 PR → 0.3');
});

// ---------- #19 actorMatches 收紧 + #4 unknown 过滤 ----------

test('#19 前缀相似 actor：v2.9.1 起 actor 一律不入册，agent-kilo/kilotest 均缺席', async () => {
  const now = Date.now();
  writeData('activities.json', [
    {
      id: 'a-10', type: 'commit_pushed', actor: 'agent-kilo', repo: 'example-org/fde-api',
      branch: 'feat/x', title: 'feat: x', url: 'https://gitea.example.com/example-org/fde-api/commit/10',
      occurredAt: new Date(now - 600000).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
    {
      id: 'a-11', type: 'commit_pushed', actor: 'kilotest', repo: 'example-org/fde-api',
      branch: 'feat/y', title: 'feat: y', url: 'https://gitea.example.com/example-org/fde-api/commit/11',
      occurredAt: new Date(now - 600000).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
  ]);
  const r = await api('GET', '/api/members');
  // v2.5：CLI 注册表不再是成员来源；v2.9.1：动态 actor 派生整条退役——动态再热也不长出成员
  assert.ok(!r.body.some((m) => m.id === 'kilo'), 'kilo 不再是成员');
  assert.ok(!r.body.some((m) => m.id === 'agent-kilo'), 'agent-kilo 不得入册');
  assert.ok(!r.body.some((m) => m.id === 'kilotest'), '动态 actor kilotest 不得派生入册');
});

test('#4 合成 actor unknown 不入花名册', async () => {
  const now = Date.now();
  writeData('activities.json', [
    {
      id: 'a-20', type: 'branch_created', actor: 'unknown', repo: 'example-org/fde-api',
      branch: 'feat/z', title: 'feat: z', url: 'https://gitea.example.com/example-org/fde-api/commit/20',
      occurredAt: new Date(now - 600000).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
  ]);
  const r = await api('GET', '/api/members');
  assert.ok(!r.body.some((m) => String(m.id).toLowerCase() === 'unknown'), 'unknown 不得出现在花名册');
});

test('#7 非法协议 url 的动态不参与统计', async () => {
  const now = Date.now();
  // v2.9.1：actor 不再派生入册，kilotest 经 Gitea 成员缓存入册以验证统计过滤
  writeData('gitea-members.json', [{ login: 'kilotest', full_name: 'kilotest', name: 'kilotest' }]);
  writeData('activities.json', [
    {
      id: 'a-30', type: 'pr_opened', actor: 'kilotest', repo: 'example-org/fde-api',
      branch: 'feat/bad', title: 'feat: bad', url: 'javascript:alert(1)',
      occurredAt: new Date(now - 600000).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
  ]);
  const r = await api('GET', '/api/members');
  const kilotest = r.body.find((m) => m.id === 'kilotest');
  assert.ok(kilotest, 'kilotest 经 Gitea 缓存在册');
  assert.strictEqual(kilotest.openPrs, 0, 'javascript: url 的 pr_opened 不得计入开放 PR');
});

// ---------- v2.9.2 gitea.ignoreLogins 忽略账号 ----------

test('v2.9.2 ignoreLogins：默认过滤 admin；自定义名单覆盖默认且大小写不敏感', async () => {
  const mkApp = async (tmp, giteaOverrides) => {
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
      port: PORT, host: '127.0.0.1', dataDir: path.join(tmp, 'data'), webDir: path.join(tmp, 'web'),
      gitea: { pollIntervalSec: 0, ...giteaOverrides },
      agentActivity: { sources: { workbuddy: { dbPath: path.join(tmp, 'no-wb.db') } } },
    }));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'data', 'gitea-members.json'), JSON.stringify([
      { login: 'admin', full_name: '管理员', name: '管理员' },
      { login: 'carol', full_name: '卡罗尔', name: '卡罗尔' },
    ]));
    const a = buildApp({ configPath: path.join(tmp, 'config.json') });
    const res = await a.fetch('GET', '/api/members');
    return { a, body: await res.json() };
  };

  // 默认（config 无 ignoreLogins 键）→ DEFAULT_CONFIG 的 ["admin"] 生效
  const t1 = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-ign-def-'));
  try {
    const { a, body } = await mkApp(t1, {});
    try {
      assert.ok(!body.some((m) => String(m.id).toLowerCase() === 'admin'), '默认须过滤 admin');
      assert.ok(body.some((m) => m.id === 'carol'), '非忽略成员照常入册');
    } finally { a.close(); }
  } finally { fs.rmSync(t1, { recursive: true, force: true }); }

  // 自定义名单覆盖默认：["CAROL"]（大小写不敏感）→ carol 出局、admin 回归
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-ign-cfg-'));
  try {
    const { a, body } = await mkApp(t2, { ignoreLogins: ['CAROL'] });
    try {
      assert.ok(!body.some((m) => m.id === 'carol'), '自定义名单命中（大小写不敏感）');
      assert.ok(body.some((m) => m.id === 'admin'), '自定义名单整体替换默认，admin 回归在册');
    } finally { a.close(); }
  } finally { fs.rmSync(t2, { recursive: true, force: true }); }
});

// ---------- #3 轮询器（fixture 模式端到端） ----------

test('#3 轮询器：pollIntervalSec=1 + GITEA_FIXTURE 自动写 activities/gitea-status，PATCH 重排不崩', async () => {
  const PORT2 = 7795; // 仅作 fixture 配置留痕（进程内装配不再监听端口）
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-poller-'));
  const dataDir2 = path.join(tmp2, 'data');
  fs.writeFileSync(
    path.join(tmp2, 'config.json'),
    JSON.stringify({
      port: PORT2,
      host: '127.0.0.1',
      dataDir: dataDir2,
      webDir: path.join(tmp2, 'web'),
      gitea: { pollIntervalSec: 1 },
    })
  );
  // WP3：独立子实例 → 装配器第二 app；轮询定时器在响应之外异步触发并读 env，
  // 故 persistentEnv（build 即写入、close 还原）
  const app2 = buildApp({
    configPath: path.join(tmp2, 'config.json'),
    // DSH_FIXTURE 必须随行：日报自动档在本地 ≥08:00 会经 maybeAutoDaily 真拉 dsh 引擎
    // 子进程，close 不收割 → 测试进程挂死（时间依赖：上午跑绿、下午跑挂）
    env: {
      GITEA_FIXTURE: path.join(__dirname, 'fixtures', 'gitea.json'),
      DSH_FIXTURE: path.join(__dirname, 'fixtures', 'dsh-ok.txt'),
    },
    persistentEnv: true,
  });
  try {
    // 首轮立即拉取 → activities.json/gitea-status.json 应很快出现
    const pollDeadline = Date.now() + 8000;
    let activities = null;
    while (Date.now() < pollDeadline) {
      if (fs.existsSync(path.join(dataDir2, 'activities.json'))) {
        try {
          activities = JSON.parse(fs.readFileSync(path.join(dataDir2, 'activities.json'), 'utf8'));
          if (Array.isArray(activities) && activities.length > 0) break;
        } catch (e) { /* 写入中 */ }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(Array.isArray(activities) && activities.length >= 2, '轮询器应已把 fixture 活动落盘');
    const status = JSON.parse(fs.readFileSync(path.join(dataDir2, 'gitea-status.json'), 'utf8'));
    assert.strictEqual(status.ok, true, 'gitea-status.json 应为 ok:true');
    assert.ok(typeof status.lastPollAt === 'string');

    // PATCH pollIntervalSec 1→2：重排不崩、设置生效
    const patch = await app2.fetch('PATCH', '/api/settings', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitea: { pollIntervalSec: 2 } }),
    });
    assert.strictEqual(patch.status, 200);
    const health = await app2.fetch('GET', '/api/health');
    assert.strictEqual(health.status, 200, '重排后服务仍存活');
  } finally {
    app2.close();
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

// ---------- v1.4 逾期计数 + currentTask 透传 ----------

/** 本地时区按天偏移取 YYYY-MM-DD（用 setDate 而非毫秒加减，避开夏令时/月末边界） */
function ymd(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('v1.4 overview overdue 计数：昨天到期计入，今天/明天到期不计入', async () => {
  const a = await api('POST', '/api/tasks', { title: '逾期任务', dueDate: ymd(-1) });
  const b = await api('POST', '/api/tasks', { title: '今天到期任务', dueDate: ymd(0) });
  const c = await api('POST', '/api/tasks', { title: '明天到期任务', dueDate: ymd(1) });

  const r = await api('GET', '/api/overview');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.tasks.overdue, 1, '仅昨天到期计入 overdue（库里其余任务 dueDate 为 null）');

  await api('DELETE', `/api/tasks/${a.body.id}`);
  await api('DELETE', `/api/tasks/${b.body.id}`);
  await api('DELETE', `/api/tasks/${c.body.id}`);
});

test('v1.4 currentTask 透传 dueDate/priority', async () => {
  const t = await api('POST', '/api/tasks', {
    title: '透传检查任务',
    agentId: 'workbuddy',
    dueDate: ymd(-1),
    priority: 'high',
  });
  // PATCH 成 doing 刷新 updatedAt，确保成为 workbuddy 最新未完成任务
  await api('PATCH', `/api/tasks/${t.body.id}`, { status: 'doing' });

  const r = await api('GET', '/api/members');
  const wb = r.body.find((m) => m.id === 'workbuddy');
  assert.ok(wb && wb.currentTask, 'workbuddy 应有当前任务');
  assert.strictEqual(wb.currentTask.dueDate, ymd(-1), 'currentTask.dueDate 应透传');
  assert.strictEqual(wb.currentTask.priority, 'high', 'currentTask.priority 应透传');

  await api('DELETE', `/api/tasks/${t.body.id}`);
});
