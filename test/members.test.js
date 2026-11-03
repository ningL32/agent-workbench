'use strict';

/**
 * members.test.js — v1.2 手工名册 CRUD + GET /api/members 聚合扩展
 * 覆盖：POST/PATCH/DELETE /api/members 全流程、409 三态（MEMBER_EXISTS / MEMBER_IMMUTABLE 的
 *       智能体与 Gitea 派生分支）、字段校验 400 MEMBER_INVALID、CSRF Content-Type 防线、
 *       聚合视图 manual 字段、giteaLogin 活动归因（todayCommits/openPrs/lastActivityAt）、
 *       手工 giteaLogin 认领后派生成员去重、members.json 落盘形态。
 * 运行：node --test test/members.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7796; // 仅作 fixture 配置留痕（进程内装配不再监听端口）

const { buildApp } = require('./helpers/appAssembler');
const { createWorkbuddyDb } = require('./helpers/workbuddy-fixture');

let app;
let tmpDir;
let dataDir;

// WP3：真端口 spawn → 装配器进程内分发（同一 app.handle 管线，断言零改动）
async function api(method, p, body, headers = {}) {
  return app.fetch(method, p, {
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function writeData(file, obj) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(obj));
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-members-'));
  dataDir = path.join(tmpDir, 'data');
  // v2.5 硅基成员=workbuddy 源：注入夹具 db（running 会话→working/alive），避免读本机真实 ~/.workbuddy
  const wbDb = createWorkbuddyDb(path.join(tmpDir, 'workbuddy.db'), [
    { id: 'wb-live-01', cwd: tmpDir, title: '成员册测试会话', status: 'running', created_at: Date.now() - 1800e3, last_activity_at: Date.now() - 120e3 },
  ]);
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({
      port: PORT,
      host: '127.0.0.1',
      dataDir,
      webDir: path.join(tmpDir, 'web'),
      gitea: { pollIntervalSec: 0 },
      // v2.6：codex/opencode 指向不存在路径（确定性：不读本机真实数据）
      agentActivity: { sources: { workbuddy: { dbPath: wbDb }, codex: { root: path.join(tmpDir, 'no-codex') }, opencode: { dbPath: path.join(tmpDir, 'no-opencode.db') } } },
    })
  );
  app = buildApp({ configPath: path.join(tmpDir, 'config.json') });
});

test.after(() => {
  if (app) app.close();
});

// ---------- CSRF 防线 ----------

test('写请求 Content-Type 防线：text/plain POST /api/members → 400 CONTENT_TYPE_REQUIRED', async () => {
  const r = await app.fetch('POST', '/api/members', {
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ id: 'evil.x', name: '跨源' }),
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).error.code, 'CONTENT_TYPE_REQUIRED');
});

// ---------- POST ----------

test('POST /api/members 201：完整对象 + 缺省值（role/giteaLogin=""、enabled=true），落盘 members.json', async () => {
  const r = await api('POST', '/api/members', {
    id: 'qianqi',
    name: '张伟',
    role: '后端',
    giteaLogin: 'wangwu',
  });
  assert.strictEqual(r.status, 201);
  // 任务雷达（PRD §4）：memberView 加法式扩展 aliases:[]（历史数据缺字段回退空数组）
  // v2.9：加法式扩展 githubLogin:''（GitHub 组织动态源归因用，历史数据缺字段回退空串）
  assert.deepStrictEqual(r.body, {
    id: 'qianqi',
    name: '张伟',
    role: '后端',
    giteaLogin: 'wangwu',
    githubLogin: '',
    aliases: [],
    enabled: true,
  });

  // enabled/可选字段全缺省
  const r2 = await api('POST', '/api/members', { id: 'li.na', name: '李娜' });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.body.giteaLogin, '');
  assert.strictEqual(r2.body.role, '');
  assert.strictEqual(r2.body.enabled, true);

  // members.json 落盘在项目根（configDir），形态 {"members":[...]}，原子写无 .tmp 残留
  const membersFile = path.join(tmpDir, 'members.json');
  assert.ok(fs.existsSync(membersFile), 'members.json 应落盘于项目根');
  const raw = JSON.parse(fs.readFileSync(membersFile, 'utf8'));
  assert.ok(Array.isArray(raw.members) && raw.members.length === 2);
  assert.ok(raw.members.every((m) => m.id && m.name));
  assert.deepStrictEqual(
    fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-')),
    [],
    '不应有 .tmp 残留'
  );
});

test('POST /api/members id 重复 → 409 MEMBER_EXISTS', async () => {
  const r = await api('POST', '/api/members', { id: 'qianqi', name: '另一个张伟' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'MEMBER_EXISTS');
});

test('POST /api/members 字段非法 → 400 MEMBER_INVALID（id 规则/name 长度/可选字段类型）', async () => {
  const cases = [
    { body: { id: 'Zhang.Wei', name: '大写开头' }, why: 'id 大写' },
    { body: { id: '1zhang', name: '数字开头' }, why: 'id 数字开头' },
    { body: { id: '-zhang', name: '连字符开头' }, why: 'id 连字符开头' },
    { body: { id: 'z'.repeat(33), name: '超长' }, why: 'id 超 32 字符' },
    { body: { id: 'ok.id' }, why: 'name 缺失' },
    { body: { id: 'ok.id', name: '   ' }, why: 'name 全空白' },
    { body: { id: 'ok.id', name: '字'.repeat(51) }, why: 'name 超 50 字' },
    { body: { id: 'ok.id', name: 'ok', role: '字'.repeat(51) }, why: 'role 超 50 字' },
    { body: { id: 'ok.id', name: 'ok', giteaLogin: 123 }, why: 'giteaLogin 非字符串' },
    { body: { id: 'ok.id', name: 'ok', enabled: 'yes' }, why: 'enabled 非布尔' },
    { body: { name: '缺 id' }, why: 'id 缺失' },
  ];
  for (const c of cases) {
    const r = await api('POST', '/api/members', c.body);
    assert.strictEqual(r.status, 400, `用例「${c.why}」应 400`);
    assert.strictEqual(r.body.error.code, 'MEMBER_INVALID', `用例「${c.why}」错误码应为 MEMBER_INVALID`);
  }
});

// ---------- PATCH ----------

test('PATCH /api/members/:id 任意子集更新 → 200 更新后对象；未知 id → 404 MEMBER_NOT_FOUND', async () => {
  const r = await api('PATCH', '/api/members/li.na', { role: '前端', giteaLogin: 'lina', enabled: false });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { id: 'li.na', name: '李娜', role: '前端', giteaLogin: 'lina', githubLogin: '', aliases: [], enabled: false });

  const r2 = await api('PATCH', '/api/members/li.na', { name: '李娜（实习）' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.name, '李娜（实习）');
  assert.strictEqual(r2.body.role, '前端', '未传字段不受影响');

  const nf = await api('PATCH', '/api/members/ghost.member', { name: 'x' });
  assert.strictEqual(nf.status, 404);
  assert.strictEqual(nf.body.error.code, 'MEMBER_NOT_FOUND');

  // 智能体 id 不在手工名册 → 同样 404（改名走 /api/agents）
  const agentPatch = await api('PATCH', '/api/members/claude', { name: '劫持' });
  assert.strictEqual(agentPatch.status, 404);
  assert.strictEqual(agentPatch.body.error.code, 'MEMBER_NOT_FOUND');

  const bad = await api('PATCH', '/api/members/li.na', { name: '' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error.code, 'MEMBER_INVALID');
});

// ---------- GET 聚合（manual 字段 + giteaLogin 归因） ----------

test('GET /api/members：硅基=桌面 agent（workbuddy），CLI 注册表不入册；手工条目 manual:true 并入', async () => {
  const r = await api('GET', '/api/members');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body));

  // v2.5：agents.json 只是启动器注册表，不再逐个派生成员
  assert.ok(!r.body.some((m) => m.id === 'claude'), 'claude 不再是成员');

  const wb = r.body.find((m) => m.id === 'workbuddy');
  assert.ok(wb, '指定桌面 agent 应在聚合视图');
  assert.strictEqual(wb.kind, 'agent');
  assert.strictEqual(wb.manual, false);
  assert.strictEqual(wb.role, '桌面 Agent');
  assert.strictEqual(wb.status, 'working', '夹具 running 会话 → working');
  assert.ok(wb.session && wb.session.alive === true, 'running 会话视作 alive');

  const zhang = r.body.find((m) => m.id === 'qianqi');
  assert.ok(zhang, '手工名册条目应并入聚合视图（此刻无任何 Gitea 缓存/动态）');
  assert.strictEqual(zhang.manual, true);
  assert.strictEqual(zhang.kind, 'human');
  assert.strictEqual(zhang.name, '张伟');
  assert.strictEqual(zhang.role, '后端');
  assert.strictEqual(zhang.status, 'idle');
  assert.strictEqual(zhang.todayCommits, 0);
  assert.strictEqual(zhang.openPrs, 0);
  assert.strictEqual(zhang.lastActivityAt, null);
  assert.strictEqual(zhang.currentTask, null);

  // enabled:false 的手工条目仍在名册视图（enabled 为配置位，不隐藏成员）
  const lina = r.body.find((m) => m.id === 'li.na');
  assert.ok(lina, 'enabled:false 手工条目也出现');
  assert.strictEqual(lina.manual, true);
});

test('GET /api/members：giteaLogin 命中动态 actor → 活动归因；派生成员不重复；动态 actor 不再入册（v2.9.1）', async () => {
  const now = Date.now();
  writeData('gitea-members.json', [
    { login: 'wangwu', full_name: '王五', name: '王五' },
    { login: 'zhaoming', full_name: '赵明', name: '赵明' },
  ]);
  writeData('activities.json', [
    {
      id: 'a-m1', type: 'commit_pushed', actor: 'wangwu', repo: 'example-org/fde-api',
      branch: 'feat/sso', title: 'feat: sso', url: 'https://gitea.example.com/example-org/fde-api/commit/1',
      occurredAt: new Date(now - 3600 * 1000).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
    {
      id: 'a-m2', type: 'commit_pushed', actor: 'wangwu', repo: 'example-org/fde-api',
      branch: 'fix/login', title: 'fix: login', url: 'https://gitea.example.com/example-org/fde-api/commit/2',
      occurredAt: new Date(now - 2 * 3600 * 1000).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
    {
      id: 'a-m3', type: 'pr_opened', actor: 'wangwu', repo: 'example-org/fde-api',
      branch: 'feat/sso', title: 'feat: SSO 登录', url: 'https://gitea.example.com/example-org/fde-api/pulls/12',
      occurredAt: new Date(now - 3 * 3600 * 1000).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
    {
      id: 'a-m4', type: 'pr_opened', actor: 'wang.fang', repo: 'example-org/fde-api',
      branch: 'feat/other', title: 'feat: other', url: 'https://gitea.example.com/example-org/fde-api/pulls/13',
      occurredAt: new Date(now - 4 * 3600 * 1000).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
  ]);

  const r = await api('GET', '/api/members');
  assert.strictEqual(r.status, 200);

  // 归因：qianqi（giteaLogin=wangwu）拿到 wangwu 的活动数据
  const zhang = r.body.find((m) => m.id === 'qianqi');
  assert.strictEqual(zhang.todayCommits, 2, '24h 内 2 条 commit_pushed');
  assert.strictEqual(zhang.openPrs, 1, '7d 内 1 个开放 PR');
  assert.ok(zhang.lastActivityAt, 'lastActivityAt 应有值');
  assert.ok(Math.abs(Date.parse(zhang.lastActivityAt) - (now - 3600 * 1000)) < 60000, '取最近一条动态时间');
  assert.strictEqual(zhang.manual, true);

  // 去重：wangwu 被手工条目认领，不再输出 Gitea 缓存/动态派生条目
  assert.ok(!r.body.some((m) => m.id === 'wangwu'), '被认领的 login 不得重复出现为派生成员');

  // Gitea 缓存中未被认领的成员照常派生，manual:false，名字取 full_name
  const zhao = r.body.find((m) => m.id === 'zhaoming');
  assert.ok(zhao, '缓存成员 zhaoming 应派生出现');
  assert.strictEqual(zhao.manual, false);
  assert.strictEqual(zhao.kind, 'human');
  assert.strictEqual(zhao.name, '赵明');

  // v2.9.1：动态流 actor 自动派生整条退役——wang.fang 仅在动态里出现过、不在手工名册
  // 与 Gitea 成员缓存中，不得入册（其动态在团队动态页仍按未登记 actor 降级展示）
  const wang = r.body.find((m) => m.id === 'wang.fang');
  assert.ok(!wang, '动态 actor wang.fang 不得派生入册');

  // 无 giteaLogin 的手工条目不受他人动态影响；聚合视图不暴露 giteaLogin 字段（响应形状只增 manual）
  const lina = r.body.find((m) => m.id === 'li.na');
  assert.strictEqual(lina.giteaLogin, undefined, '聚合视图不新增 giteaLogin 字段');
  assert.strictEqual(lina.todayCommits, 0, '未配置 giteaLogin 的手工条目活动数据为零');
  assert.strictEqual(lina.lastActivityAt, null);
});

// ---------- DELETE（MEMBER_IMMUTABLE 两分支 + 204 + 404） ----------

test('DELETE /api/members/claude（智能体 id）→ 409 MEMBER_IMMUTABLE，message 指明走 /api/agents', async () => {
  const r = await api('DELETE', '/api/members/claude');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'MEMBER_IMMUTABLE');
  assert.match(r.body.error.message, /智能体走 \/api\/agents/);
  // 智能体本身仍在注册表
  const agents = await api('GET', '/api/agents');
  assert.ok(agents.body.some((a) => a.id === 'claude'), 'claude 不应被删掉');
});

test('DELETE Gitea 缓存派生成员 → 409 MEMBER_IMMUTABLE；未知 id → 404', async () => {
  const r = await api('DELETE', '/api/members/zhaoming');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'MEMBER_IMMUTABLE');
  assert.match(r.body.error.message, /派生只读/);

  const nf = await api('DELETE', '/api/members/ghost.member');
  assert.strictEqual(nf.status, 404);
  assert.strictEqual(nf.body.error.code, 'MEMBER_NOT_FOUND');
});

test('DELETE 手工条目 → 204，聚合视图与 members.json 同步移除', async () => {
  const r = await api('DELETE', '/api/members/li.na');
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.text, '');

  const members = await api('GET', '/api/members');
  assert.ok(!members.body.some((m) => m.id === 'li.na'), '删除后不再出现在聚合视图');
  assert.ok(members.body.some((m) => m.id === 'qianqi'), '其余条目不受影响');

  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'members.json'), 'utf8'));
  assert.deepStrictEqual(raw.members.map((m) => m.id), ['qianqi']);

  const again = await api('DELETE', '/api/members/li.na');
  assert.strictEqual(again.status, 404);
  assert.strictEqual(again.body.error.code, 'MEMBER_NOT_FOUND');
});

// ---------- v1.2 任务负责成员：human 条目按 memberId 归领任务 ----------

test('v1.2 memberId 归领：手工条目 qianqi 的 currentTask/status/weekDone 按 memberId 推导，派生人类 wang.fang 同规则，清理后复原', async () => {
  // 先 A 后 B，间隔 20ms 保证 updatedAt 有序（currentTask 取 updatedAt 最新的未完成任务）
  const a = await api('POST', '/api/tasks', { title: '张伟任务A', memberId: 'qianqi' });
  assert.strictEqual(a.status, 201);
  await new Promise((r) => setTimeout(r, 20));
  const b = await api('POST', '/api/tasks', { title: '张伟任务B', memberId: 'qianqi' });
  assert.strictEqual(b.status, 201);
  const patchB = await api('PATCH', `/api/tasks/${b.body.id}`, { status: 'doing' });
  assert.strictEqual(patchB.status, 200);
  const patchA = await api('PATCH', `/api/tasks/${a.body.id}`, { status: 'done' });
  assert.strictEqual(patchA.status, 200);

  const r = await api('GET', '/api/members');
  assert.strictEqual(r.status, 200);
  const zhang = r.body.find((m) => m.id === 'qianqi');
  assert.ok(zhang, 'qianqi 应在聚合视图');
  assert.ok(zhang.currentTask, 'memberId 命中的 doing 任务 B 应成为当前任务');
  assert.strictEqual(zhang.currentTask.id, b.body.id);
  assert.strictEqual(zhang.currentTask.status, 'doing');
  assert.strictEqual(zhang.status, 'working', '有 doing 任务 → working');
  assert.strictEqual(typeof zhang.currentTask.ageSec, 'number', 'ageSec 为数字非 null');
  assert.strictEqual(typeof zhang.currentTask.sinceUpdateSec, 'number', 'sinceUpdateSec 为数字非 null');
  assert.strictEqual(typeof zhang.currentTask.progress, 'number', 'progress 为数字');
  assert.strictEqual(zhang.weekDone, 1, 'A 在 7 天内 done，计入本周完成');

  // 非手工人类条目（Gitea 成员缓存派生，manual:false）同样按 memberId 归领
  writeData('gitea-members.json', [{ login: 'wang.fang', full_name: '王芳', name: '王芳' }]);
  const w = await api('POST', '/api/tasks', { title: '王芳任务', memberId: 'wang.fang' });
  assert.strictEqual(w.status, 201);
  await api('PATCH', `/api/tasks/${w.body.id}`, { status: 'doing' });
  const r2 = await api('GET', '/api/members');
  const wang = r2.body.find((m) => m.id === 'wang.fang');
  assert.ok(wang, 'wang.fang 应作为 Gitea 缓存成员出现在聚合视图');
  assert.strictEqual(wang.manual, false);
  assert.ok(wang.currentTask, '缓存成员条目 currentTask 应按 memberId 归领');
  assert.strictEqual(wang.currentTask.id, w.body.id);
  assert.strictEqual(typeof wang.currentTask.ageSec, 'number', '缓存成员 ageSec 为数字非 null');

  // 清理：删除三个测试任务后 qianqi 回到 currentTask:null
  for (const id of [a.body.id, b.body.id, w.body.id]) {
    const del = await api('DELETE', `/api/tasks/${id}`);
    assert.strictEqual(del.status, 204);
  }
  const r3 = await api('GET', '/api/members');
  const zhangAfter = r3.body.find((m) => m.id === 'qianqi');
  assert.strictEqual(zhangAfter.currentTask, null, '清理后 qianqi 回到 currentTask:null');
});

// ---------- v1.4 修订（goose 真机验收 P1-2）：成员活动锚点 = max(名下未完成任务最新 updatedAt, 最近 Gitea 动态) ----------
// 旧口径 sinceUpdateSec 仅锚定 Gitea 动态：刚派 2 分钟的任务与 37h 前的动态同屏矛盾（误报超时危险）。

test('P1-2 刚派任务 + 37h 前 Gitea 动态 → working 且 sinceUpdateSec<300，不再误报超时危险', async () => {
  const now = Date.now();
  const H = 3600 * 1000;
  writeData('activities.json', [
    {
      id: 'a-p2old', type: 'commit_pushed', actor: 'wangwu', repo: 'example-org/fde-api',
      branch: 'feat/old', title: 'feat: old', url: 'https://gitea.example.com/example-org/fde-api/commit/99',
      occurredAt: new Date(now - 37 * H).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
  ]);
  const t = await api('POST', '/api/tasks', { title: '赵六场景刚派任务', memberId: 'qianqi' });
  assert.strictEqual(t.status, 201);
  const p = await api('PATCH', `/api/tasks/${t.body.id}`, { status: 'doing' });
  assert.strictEqual(p.status, 200);

  const r = await api('GET', '/api/members');
  const zhang = r.body.find((m) => m.id === 'qianqi');
  assert.ok(zhang && zhang.currentTask, 'qianqi 应有当前任务');
  assert.strictEqual(zhang.currentTask.id, t.body.id);
  assert.strictEqual(zhang.status, 'working', '刚派任务应 working，不得因 37h 前 Gitea 动态误报 stale');
  assert.ok(
    zhang.currentTask.sinceUpdateSec < 300,
    `sinceUpdateSec=${zhang.currentTask.sinceUpdateSec} 应锚定任务 updatedAt（<300s），而非 37h 前动态`
  );
  assert.ok(zhang.currentTask.ageSec < 300, 'ageSec 与 sinceUpdateSec 不应同屏自相矛盾');
  assert.ok(
    Math.abs(Date.parse(zhang.lastActivityAt) - Date.parse(t.body.updatedAt)) < 60000,
    'lastActivityAt 应为合并锚点（取较新的任务 updatedAt 而非 37h 前动态）'
  );
  await api('DELETE', `/api/tasks/${t.body.id}`);
});

test('P1-2 无任务成员维持纯 Gitea 锚点：37h 前动态 → lastActivityAt 为动态时间、status idle', async () => {
  const now = Date.now();
  const H = 3600 * 1000;
  writeData('activities.json', [
    {
      id: 'a-p2wf', type: 'commit_pushed', actor: 'wang.fang', repo: 'example-org/fde-api',
      branch: 'feat/wf', title: 'feat: wf', url: 'https://gitea.example.com/example-org/fde-api/commit/98',
      occurredAt: new Date(now - 37 * H).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
  ]);
  const r = await api('GET', '/api/members');
  const wang = r.body.find((m) => m.id === 'wang.fang');
  assert.ok(wang, 'wang.fang 应在花名册（派生人类）');
  assert.strictEqual(wang.currentTask, null, '无任务成员 currentTask 为 null');
  assert.strictEqual(wang.status, 'idle', '无 doing 任务不得 stale');
  assert.ok(
    Math.abs(Date.parse(wang.lastActivityAt) - (now - 37 * H)) < 60000,
    '无任务成员锚点仍为最近一条 Gitea 动态时间（锚点规则不变）'
  );
});

test('P1-2 陈旧 doing 任务 + 更旧 Gitea 动态 → stale，锚点取 max 语义下较新的任务 updatedAt', async () => {
  const now = Date.now();
  const H = 3600 * 1000;
  writeData('activities.json', [
    {
      id: 'a-p2b1', type: 'commit_pushed', actor: 'wangwu', repo: 'example-org/fde-api',
      branch: 'feat/ancient', title: 'feat: ancient', url: 'https://gitea.example.com/example-org/fde-api/commit/97',
      occurredAt: new Date(now - 40 * H).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
    {
      id: 'a-p2b2', type: 'commit_pushed', actor: 'wang.fang', repo: 'example-org/fde-api',
      branch: 'feat/wf', title: 'feat: wf', url: 'https://gitea.example.com/example-org/fde-api/commit/96',
      occurredAt: new Date(now - 37 * H).toISOString(), fetchedAt: new Date(now).toISOString(),
    },
  ]);
  const t = await api('POST', '/api/tasks', { title: '陈年在办任务', memberId: 'qianqi' });
  await api('PATCH', `/api/tasks/${t.body.id}`, { status: 'doing' });
  // 直接回写 tasks.json 把 updatedAt 回拨 37h（模拟 37h 无更新的在办任务）
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));
  const saved = raw.tasks.find((x) => x.id === t.body.id);
  saved.updatedAt = new Date(now - 37 * H).toISOString();
  fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify(raw));

  const r = await api('GET', '/api/members');
  const zhang = r.body.find((m) => m.id === 'qianqi');
  assert.ok(zhang && zhang.currentTask);
  assert.strictEqual(zhang.status, 'stale', '37h 无更新的 doing 任务应 stale');
  assert.ok(zhang.currentTask.sinceUpdateSec > 86400, 'sinceUpdateSec 超 24h（前端危险色区间）');
  assert.ok(
    Math.abs(zhang.currentTask.sinceUpdateSec - 37 * 3600) < 600,
    `锚点应为 max(任务37h, 动态40h)=37h，实际 ${zhang.currentTask.sinceUpdateSec}s（不得取更旧的动态 40h）`
  );
  assert.ok(
    Math.abs(Date.parse(zhang.lastActivityAt) - (now - 37 * H)) < 120000,
    'lastActivityAt 同步用合并锚点（37h 任务，而非 40h 动态）'
  );
  await api('DELETE', `/api/tasks/${t.body.id}`);
});

// ---------- feeds 词表成员联动回归（任务书交付③） ----------

test('feeds 词表联动：activities type commit×2/pr×1（actor wangwu）→ giteaLogin=wangwu 成员 todayCommits=2、openPrs=1', async () => {
  // Arrange：独立 dataDir 独立 app 实例（不污染共享夹具），复用 writeData 的落盘模式
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-members-feeds-'));
  const dataDir3 = path.join(tmp3, 'data');
  const wbDb = createWorkbuddyDb(path.join(tmp3, 'workbuddy.db'), []);
  fs.writeFileSync(
    path.join(tmp3, 'config.json'),
    JSON.stringify({
      port: 7798,
      host: '127.0.0.1',
      dataDir: dataDir3,
      webDir: path.join(tmp3, 'web'),
      gitea: { pollIntervalSec: 0 },
      agentActivity: {
        sources: {
          workbuddy: { dbPath: wbDb },
          codex: { root: path.join(tmp3, 'no-codex') },
          opencode: { dbPath: path.join(tmp3, 'no-opencode.db') },
        },
      },
    })
  );
  const app3 = buildApp({ configPath: path.join(tmp3, 'config.json') });
  try {
    // 手工名册：qianqi 认领 gitea 账号 wangwu
    const mk = await app3.fetch('POST', '/api/members', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'qianqi', name: '张伟', giteaLogin: 'wangwu' }),
    });
    assert.strictEqual(mk.status, 201);

    // activities.json 用 feeds 新词表：type 'commit' ×2 + type 'pr' ×1（actor 全为 wangwu）
    const now = Date.now();
    const H = 3600 * 1000;
    const feedsActs = [
      {
        id: 'a-feeds-c1', type: 'commit', actor: 'wangwu', repo: 'example-org/fde-api',
        branch: 'feat/sso', title: 'feat: sso', sha: 'f00d0001', messageBody: '',
        url: 'https://gitea.example.com/example-org/fde-api/commit/f00d0001',
        occurredAt: new Date(now - 1 * H).toISOString(), fetchedAt: new Date(now).toISOString(),
      },
      {
        id: 'a-feeds-c2', type: 'commit', actor: 'wangwu', repo: 'example-org/fde-api',
        branch: 'fix/login', title: 'fix: login', sha: 'f00d0002', messageBody: '',
        url: 'https://gitea.example.com/example-org/fde-api/commit/f00d0002',
        occurredAt: new Date(now - 2 * H).toISOString(), fetchedAt: new Date(now).toISOString(),
      },
      {
        id: 'a-feeds-p1', type: 'pr', actor: 'wangwu', repo: 'example-org/fde-api',
        branch: null, title: 'PR #12', sha: null, messageBody: '',
        url: 'https://gitea.example.com/example-org/fde-api/pulls/12',
        occurredAt: new Date(now - 3 * H).toISOString(), fetchedAt: new Date(now).toISOString(),
      },
    ];
    fs.mkdirSync(dataDir3, { recursive: true });
    fs.writeFileSync(path.join(dataDir3, 'activities.json'), JSON.stringify(feedsActs));

    // Act
    const r = await app3.fetch('GET', '/api/members');
    assert.strictEqual(r.status, 200);

    // Assert：feeds 词表下 actor 归因照常命中 giteaLogin
    const zhang = r.body.find((m) => m.id === 'qianqi');
    assert.ok(zhang, '手工条目 qianqi 应在聚合视图');
    assert.strictEqual(zhang.todayCommits, 2, '24h 内 2 条 feeds type commit');
    assert.strictEqual(zhang.openPrs, 1, '7d 内 1 条 feeds type pr');
    assert.ok(zhang.lastActivityAt, 'lastActivityAt 应有值');
    assert.ok(
      Math.abs(Date.parse(zhang.lastActivityAt) - (now - 1 * H)) < 60000,
      'lastActivityAt 取最近一条动态时间'
    );
  } finally {
    app3.close();
    fs.rmSync(tmp3, { recursive: true, force: true });
  }
});
