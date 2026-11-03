'use strict';

/**
 * tasks.test.js — B2 任务/列 CRUD
 * 覆盖：列增删改名、删非空列 409、任务增查改删、status 非法 400、title 校验 400、
 *       过滤（status/q）、404 分支、data/ 惰性创建与原子写（无 .tmp 残留）。
 * 运行：node --test test/tasks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7791; // 仅作 fixture 配置留痕（进程内装配不再监听端口）

const { buildApp } = require('./helpers/appAssembler');

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

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-tasks-'));
  dataDir = path.join(tmpDir, 'data');
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({
      port: PORT,
      host: '127.0.0.1',
      dataDir,
      webDir: path.join(tmpDir, 'web'),
      gitea: { pollIntervalSec: 0 },
    })
  );
  app = buildApp({ configPath: path.join(tmpDir, 'config.json') });
});

test.after(() => {
  if (app) app.close();
});

test('GET /api/columns 缺省返回内置四列（data/ 未落盘，惰性）', async () => {
  const r = await api('GET', '/api/columns');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(
    r.body.map((c) => `${c.id}:${c.name}:${c.order}`),
    ['todo:待分配:1', 'doing:进行中:2', 'review:待验证:3', 'done:已完成:4']
  );
  assert.strictEqual(fs.existsSync(dataDir), false, '纯读操作不应创建 data/');
});

test('POST /api/columns 新增列 201，order 递增，id 为 slug 或 col- 前缀', async () => {
  const r = await api('POST', '/api/columns', { name: '阻塞' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.name, '阻塞');
  assert.strictEqual(r.body.order, 5);
  assert.match(r.body.id, /^(blocked|col-[0-9a-z]{2,8})$/);
  assert.ok(fs.existsSync(path.join(dataDir, 'tasks.json')), '首次写应惰性创建 data/tasks.json');
});

test('PATCH /api/columns/:id 改名 200；未知列 404 COLUMN_NOT_FOUND', async () => {
  const created = await api('POST', '/api/columns', { name: '临时列' });
  const id = created.body.id;
  const r = await api('PATCH', `/api/columns/${id}`, { name: '临时列改' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.name, '临时列改');
  const nf = await api('PATCH', '/api/columns/no-such-col', { name: 'x' });
  assert.strictEqual(nf.status, 404);
  assert.strictEqual(nf.body.error.code, 'COLUMN_NOT_FOUND');
  const del = await api('DELETE', `/api/columns/${id}`);
  assert.strictEqual(del.status, 204);
  assert.strictEqual(del.text, '');
});

test('DELETE 非空列 409 COLUMN_NOT_EMPTY，message 含任务数', async () => {
  const t = await api('POST', '/api/tasks', { title: '占位任务' });
  assert.strictEqual(t.status, 201);
  const r = await api('DELETE', '/api/columns/todo');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'COLUMN_NOT_EMPTY');
  assert.match(r.body.error.message, /先移走该列的 1 个任务/);
  await api('DELETE', `/api/tasks/${t.body.id}`);
});

test('POST /api/tasks 创建任务：id/时间戳服务端生成，缺省 status=todo', async () => {
  const r = await api('POST', '/api/tasks', {
    title: '接入SSO',
    agentId: 'claude',
    repo: 'example-org/fde-api',
    branch: 'feat/sso',
    prUrl: null,
    notes: '优先级高',
  });
  assert.strictEqual(r.status, 201);
  assert.match(r.body.id, /^t-[0-9a-z]+-[0-9a-z]{4}$/);
  assert.strictEqual(r.body.status, 'todo');
  assert.strictEqual(r.body.agentId, 'claude');
  assert.strictEqual(r.body.prUrl, null);
  assert.strictEqual(r.body.notes, '优先级高');
  assert.match(r.body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(r.body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('POST /api/tasks 校验：title 空/超长 400，status 非法列 400 COLUMN_NOT_FOUND', async () => {
  const empty = await api('POST', '/api/tasks', { title: '  ' });
  assert.strictEqual(empty.status, 400);
  assert.strictEqual(empty.body.error.code, 'TITLE_INVALID');
  const long = await api('POST', '/api/tasks', { title: 'x'.repeat(201) });
  assert.strictEqual(long.status, 400);
  const badCol = await api('POST', '/api/tasks', { title: 'ok', status: 'nope' });
  assert.strictEqual(badCol.status, 400);
  assert.strictEqual(badCol.body.error.code, 'COLUMN_NOT_FOUND');
  const badJson = await app.fetch('POST', '/api/tasks', {
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.strictEqual(badJson.status, 400);
  const j = await badJson.json();
  assert.strictEqual(j.error.code, 'INVALID_JSON');
});

test('GET /api/tasks 过滤：status 精确、q 模糊匹配 title/branch/notes', async () => {
  const a = await api('POST', '/api/tasks', { title: '接入SSO', branch: 'feat/sso', notes: '优先级高' });
  const b = await api('POST', '/api/tasks', { title: '修复登录', branch: 'fix/login' });
  await api('PATCH', `/api/tasks/${b.body.id}`, { status: 'doing' });

  const doing = await api('GET', '/api/tasks?status=doing');
  assert.strictEqual(doing.status, 200);
  assert.ok(doing.body.every((t) => t.status === 'doing'));
  assert.ok(doing.body.some((t) => t.id === b.body.id));

  const qTitle = await api('GET', '/api/tasks?q=sso');
  assert.ok(qTitle.body.some((t) => t.id === a.body.id));
  const qBranch = await api('GET', '/api/tasks?q=login');
  assert.ok(qBranch.body.some((t) => t.id === b.body.id));
  const qNotes = await api('GET', '/api/tasks?q=优先级');
  assert.ok(qNotes.body.some((t) => t.id === a.body.id));
  const qNone = await api('GET', '/api/tasks?q=不存在关键词xyz');
  assert.deepStrictEqual(qNone.body, []);

  await api('DELETE', `/api/tasks/${a.body.id}`);
  await api('DELETE', `/api/tasks/${b.body.id}`);
});

test('GET/PATCH/DELETE /api/tasks/:id：404、status 非法 400、updatedAt 推进、204 删除', async () => {
  const nf = await api('GET', '/api/tasks/t-none');
  assert.strictEqual(nf.status, 404);
  assert.strictEqual(nf.body.error.code, 'TASK_NOT_FOUND');

  const created = await api('POST', '/api/tasks', { title: '待改任务' });
  const id = created.body.id;
  const before = created.body.updatedAt;
  await new Promise((r) => setTimeout(r, 20));

  const bad = await api('PATCH', `/api/tasks/${id}`, { status: 'bogus' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error.code, 'COLUMN_NOT_FOUND');

  const patched = await api('PATCH', `/api/tasks/${id}`, { status: 'done', notes: '已验收' });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.body.status, 'done');
  assert.strictEqual(patched.body.notes, '已验收');
  assert.ok(patched.body.updatedAt > before, 'updatedAt 应推进');

  const del = await api('DELETE', `/api/tasks/${id}`);
  assert.strictEqual(del.status, 204);
  const gone = await api('GET', `/api/tasks/${id}`);
  assert.strictEqual(gone.status, 404);
  const delAgain = await api('DELETE', `/api/tasks/${id}`);
  assert.strictEqual(delAgain.status, 404);
});

test('原子写：tasks.json 合法 JSON 且无 .tmp-* 残留', async () => {
  await api('POST', '/api/tasks', { title: '原子写检查' });
  const raw = fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.tasks));
  assert.ok(Array.isArray(parsed.columns));
  const leftovers = fs.readdirSync(dataDir).filter((f) => f.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, [], '不应有 .tmp 残留');
});

test('未知 /api/* 返回统一 JSON 404', async () => {
  const r = await api('GET', '/api/definitely-not-exist');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error.code, 'NOT_FOUND');
  assert.ok(typeof r.body.error.message === 'string');
});

// ---------- P0-1 CSRF 双保险 ----------

test('CSRF①：text/plain 写请求（跨源简单请求向量）→ 400 CONTENT_TYPE_REQUIRED', async () => {
  const r = await app.fetch('POST', '/api/tasks', {
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ title: '跨源注入' }),
  });
  assert.strictEqual(r.status, 400);
  const j = await r.json();
  assert.strictEqual(j.error.code, 'CONTENT_TYPE_REQUIRED');

  // urlencoded（表单默认）同样拒绝
  const form = await app.fetch('POST', '/api/tasks', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'title=csrf',
  });
  assert.strictEqual(form.status, 400);
  assert.strictEqual((await form.json()).error.code, 'CONTENT_TYPE_REQUIRED');
});

test('CSRF②：Sec-Fetch-Site: cross-site → 403 CSRF_REJECTED；same-origin/无头放行', async () => {
  const cross = await app.fetch('GET', '/api/tasks', {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.strictEqual(cross.status, 403);
  assert.strictEqual((await cross.json()).error.code, 'CSRF_REJECTED');

  const same = await app.fetch('GET', '/api/health', {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.strictEqual(same.status, 200);
  const none = await app.fetch('GET', '/api/health', {
    headers: { 'Sec-Fetch-Site': 'none' },
  });
  assert.strictEqual(none.status, 200);
});

test('CSRF 前提：OPTIONS 预检无路由 → 404，跨源预检必败', async () => {
  const r = await app.fetch('OPTIONS', '/api/tasks');
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await r.json()).error.code, 'NOT_FOUND');
});

// ---------- #7 prUrl 协议校验 ----------

test('prUrl 仅接受 http(s)：javascript: → 400 URL_INVALID，https 正常落库', async () => {
  const bad = await api('POST', '/api/tasks', { title: '伪协议', prUrl: 'javascript:alert(1)' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error.code, 'URL_INVALID');

  const ok = await api('POST', '/api/tasks', {
    title: '正常PR',
    prUrl: 'https://gitea.example.com/example-org/fde-api/pulls/12',
  });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.prUrl, 'https://gitea.example.com/example-org/fde-api/pulls/12');

  const badPatch = await api('PATCH', `/api/tasks/${ok.body.id}`, { prUrl: 'data:text/html,x' });
  assert.strictEqual(badPatch.status, 400);
  assert.strictEqual(badPatch.body.error.code, 'URL_INVALID');
  await api('DELETE', `/api/tasks/${ok.body.id}`);
});

// ---------- #2 损坏隔离 + degraded 503 ----------

test('tasks.json 截断 → GET 回退空 + *.corrupt 保全 + POST 503 DATA_DEGRADED + 恢复后解除', async () => {
  // 1. 制造损坏（截断 JSON）
  fs.writeFileSync(path.join(dataDir, 'tasks.json'), '{"columns":[{"id":"todo"', 'utf8');

  // 2. GET 返回兜底空表
  const after = await api('GET', '/api/tasks');
  assert.strictEqual(after.status, 200);
  assert.deepStrictEqual(after.body, []);

  // 3. 原文件已保全为 *.corrupt-*
  const files = fs.readdirSync(dataDir);
  const corrupt = files.filter((f) => /^tasks\.json\.corrupt-/.test(f));
  assert.strictEqual(corrupt.length, 1, `应存在一个 corrupt 备份，实际: ${files.join(',')}`);
  assert.ok(fs.readFileSync(path.join(dataDir, corrupt[0]), 'utf8').startsWith('{"columns"'));

  // 4. degraded 期间写被拒
  const denied = await api('POST', '/api/tasks', { title: '降级期写入' });
  assert.strictEqual(denied.status, 503);
  assert.strictEqual(denied.body.error.code, 'DATA_DEGRADED');

  // 5. 恢复合法文件 → 读取成功自动解除降级 → 写恢复
  fs.writeFileSync(
    path.join(dataDir, 'tasks.json'),
    JSON.stringify({ columns: [
      { id: 'todo', name: '待分配', order: 1 },
      { id: 'doing', name: '进行中', order: 2 },
      { id: 'review', name: '待验证', order: 3 },
      { id: 'done', name: '已完成', order: 4 },
    ], tasks: [] })
  );
  const recovered = await api('POST', '/api/tasks', { title: '恢复后写入' });
  assert.strictEqual(recovered.status, 201, `恢复后应可写，实际 ${recovered.status}: ${JSON.stringify(recovered.body)}`);
  await api('DELETE', `/api/tasks/${recovered.body.id}`);
  // corrupt 备份保留作为取证，不清除
  assert.strictEqual(
    fs.readdirSync(dataDir).filter((f) => /^tasks\.json\.corrupt-/.test(f)).length,
    1
  );
});

// ---------- v1.2 列排序：PATCH order 绝对序号 + 归一化 ----------

test('v1.2 PATCH order：设为绝对序号后归一化为 1..n 连续序列，其余列保持相对顺序', async () => {
  // corrupt 用例已把 tasks.json 恢复为内置四列 todo(1) doing(2) review(3) done(4)；把 review 提到第 1 位
  const r = await api('PATCH', '/api/columns/review', { order: 1 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.order, 1, '响应返回归一化后的绝对序号（同号并列时被移列优先）');
  let cols = await api('GET', '/api/columns');
  assert.deepStrictEqual(
    cols.body.map((c) => `${c.id}:${c.order}`),
    ['review:1', 'todo:2', 'doing:3', 'done:4'],
    'review 置顶，todo/doing/done 保持相对顺序顺移'
  );

  // 中段插入：doing 设 order=2 → 插到原第 2 位之前，其余列保持相对顺序
  const r2 = await api('PATCH', '/api/columns/doing', { order: 2 });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.order, 2);
  cols = await api('GET', '/api/columns');
  assert.deepStrictEqual(
    cols.body.map((c) => `${c.id}:${c.order}`),
    ['review:1', 'doing:2', 'todo:3', 'done:4']
  );
});

test('v1.2 PATCH order 超界取末位；name+order 同传均生效', async () => {
  // 当前序：review(1) todo(2) doing(3) done(4)。todo 设 order=99 → 末位归一化，同时改名
  const r = await api('PATCH', '/api/columns/todo', { name: '待办', order: 99 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.name, '待办');
  const cols = await api('GET', '/api/columns');
  assert.deepStrictEqual(
    cols.body.map((c) => `${c.id}:${c.name}:${c.order}`),
    ['review:待验证:1', 'doing:进行中:2', 'done:已完成:3', 'todo:待办:4']
  );
});

test('v1.2 非法 order → 400 ORDER_INVALID（0/负数/小数/字符串/布尔/null）；未知列 404', async () => {
  for (const bad of [0, -1, 1.5, '2', true, null]) {
    const r = await api('PATCH', '/api/columns/doing', { order: bad });
    assert.strictEqual(r.status, 400, `order=${JSON.stringify(bad)} 应 400`);
    assert.strictEqual(r.body.error.code, 'ORDER_INVALID');
  }
  const nf = await api('PATCH', '/api/columns/no-such-col', { order: 1 });
  assert.strictEqual(nf.status, 404);
  assert.strictEqual(nf.body.error.code, 'COLUMN_NOT_FOUND');
});

test('v1.2 order 归一化落盘持久（tasks.json 内为 1..n 连续）', async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));
  const orders = raw.columns.map((c) => c.order).sort((a, b) => a - b);
  assert.deepStrictEqual(orders, [1, 2, 3, 4], '落盘列序应为连续 1..n');
  const todo = raw.columns.find((c) => c.id === 'todo');
  assert.strictEqual(todo.order, 4, '上一用例的排序结果已持久化');
});

// ---------- P1-1 列排序方向对称性（goose 真机验收回归） ----------
// 旧实现「全列按序排序 + 并列时被移列优先」只在 ← 方向成立；→ 方向目标位被并列对象抢占，
// 静默偏移（如 PATCH todo {"order":3} 响应 order:2 且列序不动）。以下每个用例统一断言：
// 响应 order === 请求值、GET 全列 1..n 连续无重复、其余列相对顺序保持。
// 接续上文列序：review(1) doing(2) done(3) todo(4)。

/** 排序断言统一入口：PATCH → 响应 order===请求值 → GET 校验连续性/落位/相对顺序 */
async function reorderAndAssert(colId, reqOrder, expectedIds) {
  const before = (await api('GET', '/api/columns')).body.map((c) => c.id);
  const r = await api('PATCH', `/api/columns/${colId}`, { order: reqOrder });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(
    r.body.order,
    reqOrder,
    `响应 order 应恒等于请求值 ${reqOrder}（P1-1：→ 方向曾静默失效返回偏移值）`
  );
  const after = (await api('GET', '/api/columns')).body;
  assert.deepStrictEqual(
    after.map((c) => c.order).sort((a, b) => a - b),
    after.map((_, i) => i + 1),
    'GET 全列 order 应为 1..n 连续无重复（即归一化已落盘）'
  );
  const ids = after.map((c) => c.id);
  assert.deepStrictEqual(ids, expectedIds, `全列顺序应为 ${expectedIds.join(' → ')}`);
  assert.strictEqual(ids[reqOrder - 1], colId, `被移列应落在第 ${reqOrder} 位`);
  const rel = (list) => list.filter((id) => id !== colId);
  assert.deepStrictEqual(rel(ids), rel(before), '其余列相对顺序应保持');
  return r;
}

test('P1-1 → 方向后移 1 位：响应 order===请求值，其余列相对顺序保持', async () => {
  await reorderAndAssert('review', 2, ['doing', 'review', 'done', 'todo']);
});

test('P1-1 → 方向跨 2 位跳到末位：响应 order===请求值', async () => {
  await reorderAndAssert('review', 4, ['doing', 'done', 'todo', 'review']);
});

test('P1-1 ← 方向回归（同时覆盖移到首位）：响应 order===请求值', async () => {
  await reorderAndAssert('review', 1, ['review', 'doing', 'done', 'todo']);
});

test('P1-1 中段列移末位与首位往返（done→4、todo→1、doing→4）', async () => {
  await reorderAndAssert('done', 4, ['review', 'doing', 'todo', 'done']);
  await reorderAndAssert('todo', 1, ['todo', 'review', 'doing', 'done']);
  await reorderAndAssert('doing', 4, ['todo', 'review', 'done', 'doing']);
});

test('P1-1 非法 order 补充：对象/数组/字符串 → 400 ORDER_INVALID 且列序不受扰动', async () => {
  const before = await api('GET', '/api/columns');
  for (const bad of [{}, [], 'order']) {
    const r = await api('PATCH', '/api/columns/todo', { order: bad });
    assert.strictEqual(r.status, 400, `order=${JSON.stringify(bad)} 应 400`);
    assert.strictEqual(r.body.error.code, 'ORDER_INVALID');
  }
  const after = await api('GET', '/api/columns');
  assert.deepStrictEqual(after.body, before.body, '非法请求不得扰动列序');
});

// ---------- v1.2 任务负责成员 memberId ----------

test('v1.2 POST 带 memberId 创建：响应与落盘均含 memberId；未传为 null', async () => {
  const r = await api('POST', '/api/tasks', { title: '带负责成员', memberId: 'qianqi' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.memberId, 'qianqi');
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));
  const saved = raw.tasks.find((t) => t.id === r.body.id);
  assert.strictEqual(saved.memberId, 'qianqi', 'memberId 应落盘');

  const noMember = await api('POST', '/api/tasks', { title: '未传负责成员' });
  assert.strictEqual(noMember.status, 201);
  assert.strictEqual(noMember.body.memberId, null);
  await api('DELETE', `/api/tasks/${noMember.body.id}`);
  await api('DELETE', `/api/tasks/${r.body.id}`);
});

test('v1.2 memberId 校验：65 字符 → 400 FIELD_INVALID；非字符串（123）→ 400 FIELD_INVALID', async () => {
  const long = await api('POST', '/api/tasks', { title: '超长 memberId', memberId: 'x'.repeat(65) });
  assert.strictEqual(long.status, 400);
  assert.strictEqual(long.body.error.code, 'FIELD_INVALID');
  assert.match(long.body.error.message, /memberId/);

  const badType = await api('POST', '/api/tasks', { title: '类型错误', memberId: 123 });
  assert.strictEqual(badType.status, 400);
  assert.strictEqual(badType.body.error.code, 'FIELD_INVALID');

  // 边界：64 字符合法
  const edge = await api('POST', '/api/tasks', { title: '边界 64 字符', memberId: 'x'.repeat(64) });
  assert.strictEqual(edge.status, 201);
  await api('DELETE', `/api/tasks/${edge.body.id}`);
});

test('v1.2 PATCH memberId：设置生效，PATCH null 清空', async () => {
  const created = await api('POST', '/api/tasks', { title: '待指派任务' });
  const id = created.body.id;
  assert.strictEqual(created.body.memberId, null);

  const set = await api('PATCH', `/api/tasks/${id}`, { memberId: 'li.na' });
  assert.strictEqual(set.status, 200);
  assert.strictEqual(set.body.memberId, 'li.na');

  const clear = await api('PATCH', `/api/tasks/${id}`, { memberId: null });
  assert.strictEqual(clear.status, 200);
  assert.strictEqual(clear.body.memberId, null);
  await api('DELETE', `/api/tasks/${id}`);
});

test('v1.2 GET /api/tasks?memberId= 过滤：精确匹配、与 status 叠加、未知 id 为空数组', async () => {
  const a = await api('POST', '/api/tasks', { title: '张伟的任务', memberId: 'qianqi' });
  const b = await api('POST', '/api/tasks', { title: '王芳的任务', memberId: 'wang.fang' });
  await api('PATCH', `/api/tasks/${b.body.id}`, { status: 'doing' });

  const mine = await api('GET', '/api/tasks?memberId=qianqi');
  assert.strictEqual(mine.status, 200);
  assert.deepStrictEqual(mine.body.map((t) => t.id), [a.body.id], 'memberId 精确相等匹配');

  const both = await api('GET', '/api/tasks?memberId=wang.fang&status=doing');
  assert.deepStrictEqual(both.body.map((t) => t.id), [b.body.id], '与 status 叠加过滤');
  const none = await api('GET', '/api/tasks?memberId=wang.fang&status=done');
  assert.deepStrictEqual(none.body, [], '叠加后无命中为空数组');

  const unknown = await api('GET', '/api/tasks?memberId=no.such.member');
  assert.strictEqual(unknown.status, 200);
  assert.deepStrictEqual(unknown.body, [], '未知 id 过滤为空数组');

  await api('DELETE', `/api/tasks/${a.body.id}`);
  await api('DELETE', `/api/tasks/${b.body.id}`);
});

test('v1.2 agentId 与 memberId 可同时设置（互不覆盖）', async () => {
  const r = await api('POST', '/api/tasks', { title: '双负责', agentId: 'claude', memberId: 'qianqi' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.agentId, 'claude');
  assert.strictEqual(r.body.memberId, 'qianqi');
  await api('DELETE', `/api/tasks/${r.body.id}`);
});

// ---------- v1.2 任务描述 desc ----------

test('v1.2 POST 带 desc 创建：响应原样含 \\n，落盘持久；未传缺省 ""', async () => {
  const r = await api('POST', '/api/tasks', { title: '带描述任务', desc: '第一行\n第二行 密钥轮换' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.desc, '第一行\n第二行 密钥轮换', 'desc 应原样保留换行');

  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));
  const saved = raw.tasks.find((t) => t.id === r.body.id);
  assert.strictEqual(saved.desc, '第一行\n第二行 密钥轮换', 'desc 应落盘持久化');

  const noDesc = await api('POST', '/api/tasks', { title: '未传描述任务' });
  assert.strictEqual(noDesc.status, 201);
  assert.strictEqual(noDesc.body.desc, '', '缺省 desc 应为空串');
  await api('DELETE', `/api/tasks/${noDesc.body.id}`);
  await api('DELETE', `/api/tasks/${r.body.id}`);
});

test('v1.2 PATCH desc：更新为新值生效；{ desc: "" } 清空后为空串', async () => {
  const created = await api('POST', '/api/tasks', { title: '待改描述任务' });
  const id = created.body.id;

  const set = await api('PATCH', `/api/tasks/${id}`, { desc: '新方案说明\n第二行' });
  assert.strictEqual(set.status, 200);
  assert.strictEqual(set.body.desc, '新方案说明\n第二行');

  const clear = await api('PATCH', `/api/tasks/${id}`, { desc: '' });
  assert.strictEqual(clear.status, 200);
  assert.strictEqual(clear.body.desc, '');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v1.2 desc 校验：2001 字符 400 FIELD_INVALID 且 message 含 desc；数字 123 → 400；恰好 2000 字符 201', async () => {
  const long = await api('POST', '/api/tasks', { title: '超长描述', desc: 'x'.repeat(2001) });
  assert.strictEqual(long.status, 400);
  assert.strictEqual(long.body.error.code, 'FIELD_INVALID');
  assert.match(long.body.error.message, /desc/);

  const badType = await api('POST', '/api/tasks', { title: '类型错误', desc: 123 });
  assert.strictEqual(badType.status, 400);
  assert.strictEqual(badType.body.error.code, 'FIELD_INVALID');

  const edge = await api('POST', '/api/tasks', { title: '边界 2000 字符', desc: 'y'.repeat(2000) });
  assert.strictEqual(edge.status, 201);
  await api('DELETE', `/api/tasks/${edge.body.id}`);
});

test('v1.2 q 命中 desc：单行关键词命中；多行 desc 第二行关键词命中一次', async () => {
  const a = await api('POST', '/api/tasks', { title: '描述检索甲', desc: '密钥轮换方案' });
  const q1 = await api('GET', '/api/tasks?q=轮换');
  assert.strictEqual(q1.status, 200);
  assert.deepStrictEqual(q1.body.map((t) => t.id), [a.body.id], 'q=轮换 应命中 desc 含密钥轮换方案的任务');

  const b = await api('POST', '/api/tasks', { title: '描述检索乙', desc: '第一行说明\n轮换复盘' });
  const q2 = await api('GET', '/api/tasks?q=复盘');
  assert.deepStrictEqual(q2.body.map((t) => t.id), [b.body.id], 'q=复盘 应命中多行 desc 第二行关键词各一次');

  await api('DELETE', `/api/tasks/${a.body.id}`);
  await api('DELETE', `/api/tasks/${b.body.id}`);
});

test('v1.2 q 不命中：全库无关关键词返回空数组', async () => {
  const r = await api('GET', '/api/tasks?q=zzz无此词Qx7');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, []);
});

test('v2.0 响应形状：字段集合恰为既有字段 + desc/dueDate/priority/completedAt（v1.7）+ artifacts（v1.9）+ acceptorId（v2.0）+ projectDir（v2.9.4）', async () => {
  const r = await api('POST', '/api/tasks', { title: '形状检查任务' });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(
    Object.keys(r.body).sort(),
    ['acceptorId', 'agentId', 'artifacts', 'branch', 'completedAt', 'createdAt', 'desc', 'dueDate', 'id', 'memberId', 'notes', 'prUrl', 'priority', 'projectDir', 'repo', 'status', 'title', 'updatedAt'].sort()
  );
  assert.deepStrictEqual(r.body.artifacts, [], 'v1.9：新任务 artifacts 以空数组起');
  assert.strictEqual(r.body.acceptorId, null, 'v2.0：新任务 acceptorId 缺省 null');
  assert.strictEqual(r.body.projectDir, null, 'v2.9.4：新任务 projectDir 缺省 null');
  await api('DELETE', `/api/tasks/${r.body.id}`);
});

// ---------- v2.0 任务验收人 acceptorId ----------

test('v2.0 POST 带 acceptorId 创建：响应与落盘均含 acceptorId；未传缺省 null', async () => {
  const r = await api('POST', '/api/tasks', { title: '带验收人任务', acceptorId: 'wang.fang' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.acceptorId, 'wang.fang');

  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));
  const saved = raw.tasks.find((t) => t.id === r.body.id);
  assert.strictEqual(saved.acceptorId, 'wang.fang', 'acceptorId 应落盘持久化');

  const noAcceptor = await api('POST', '/api/tasks', { title: '未传验收人任务' });
  assert.strictEqual(noAcceptor.status, 201);
  assert.strictEqual(noAcceptor.body.acceptorId, null, 'POST 未传 acceptorId 缺省 null');
  await api('DELETE', `/api/tasks/${noAcceptor.body.id}`);
  await api('DELETE', `/api/tasks/${r.body.id}`);
});

test('v2.0 acceptorId 校验：非字符串（123）→ 400 FIELD_INVALID；65 字符 → 400 FIELD_INVALID 且 message 含 acceptorId', async () => {
  const badType = await api('POST', '/api/tasks', { title: '类型错误', acceptorId: 123 });
  assert.strictEqual(badType.status, 400);
  assert.strictEqual(badType.body.error.code, 'FIELD_INVALID');

  const long = await api('POST', '/api/tasks', { title: '超长验收人', acceptorId: 'x'.repeat(65) });
  assert.strictEqual(long.status, 400);
  assert.strictEqual(long.body.error.code, 'FIELD_INVALID');
  assert.match(long.body.error.message, /acceptorId/);

  // 边界：64 字符合法
  const edge = await api('POST', '/api/tasks', { title: '边界 64 字符', acceptorId: 'y'.repeat(64) });
  assert.strictEqual(edge.status, 201);
  await api('DELETE', `/api/tasks/${edge.body.id}`);
});

test('v2.0 PATCH acceptorId：设置 → 改派 → null 清空往返，落盘读回一致', async () => {
  const created = await api('POST', '/api/tasks', { title: '验收人往返任务' });
  const id = created.body.id;
  assert.strictEqual(created.body.acceptorId, null, 'POST 未传 acceptorId 缺省 null');

  const set = await api('PATCH', `/api/tasks/${id}`, { acceptorId: 'qianqi' });
  assert.strictEqual(set.status, 200);
  assert.strictEqual(set.body.acceptorId, 'qianqi');

  const reassign = await api('PATCH', `/api/tasks/${id}`, { acceptorId: 'li.na' });
  assert.strictEqual(reassign.status, 200);
  assert.strictEqual(reassign.body.acceptorId, 'li.na', '改派为新验收人');

  const clear = await api('PATCH', `/api/tasks/${id}`, { acceptorId: null });
  assert.strictEqual(clear.status, 200);
  assert.strictEqual(clear.body.acceptorId, null, 'PATCH null 清空验收人');

  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));
  const saved = raw.tasks.find((t) => t.id === id);
  assert.strictEqual(saved.acceptorId, null, '清空结果应落盘，读回一致');
  await api('DELETE', `/api/tasks/${id}`);
});

// ---------- v1.4 截止时间与优先级 ----------

test('v1.4 POST 带 dueDate+priority 创建：响应与落盘同值（过去日期允许=补录逾期场景）', async () => {
  const r = await api('POST', '/api/tasks', { title: '带截止与优先级', dueDate: '2020-01-01', priority: 'high' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.dueDate, '2020-01-01');
  assert.strictEqual(r.body.priority, 'high');

  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));
  const saved = raw.tasks.find((t) => t.id === r.body.id);
  assert.strictEqual(saved.dueDate, '2020-01-01', 'dueDate 应落盘持久化');
  assert.strictEqual(saved.priority, 'high', 'priority 应落盘持久化');

  await api('DELETE', `/api/tasks/${r.body.id}`);
});

test('v1.4 dueDate 校验：非法格式/溢出日期 → 400 FIELD_INVALID 且 message 含 dueDate；闰年 2 月 29 合法', async () => {
  // 2026-13-99 正则能通过但 Date 不可解析；2026-02-30 日历不存在（V8 的 new Date 会滚动到 3 月 2 日，
  // 服务端靠年月日回读拦截）；2026 非闰年故 2026-02-29 非法
  for (const bad of ['2026/10/01', '2026-1-1', 'abc', '2026-13-99', '2026-02-30', '2026-02-29', 123, true]) {
    const r = await api('POST', '/api/tasks', { title: '非法截止', dueDate: bad });
    assert.strictEqual(r.status, 400, `dueDate=${JSON.stringify(bad)} 应 400`);
    assert.strictEqual(r.body.error.code, 'FIELD_INVALID');
    assert.match(r.body.error.message, /dueDate/);
  }

  // 边界：2028 为闰年，2028-02-29 成立
  const leap = await api('POST', '/api/tasks', { title: '闰日任务', dueDate: '2028-02-29' });
  assert.strictEqual(leap.status, 201);
  assert.strictEqual(leap.body.dueDate, '2028-02-29');
  await api('DELETE', `/api/tasks/${leap.body.id}`);
});

test('v1.4 priority 缺省与校验：POST 宽缺省 medium、非法 400；PATCH 严枚举 null 也 400', async () => {
  const dft = await api('POST', '/api/tasks', { title: '缺省优先级' });
  assert.strictEqual(dft.status, 201);
  assert.strictEqual(dft.body.priority, 'medium', 'POST 未传 priority 缺省 medium');

  const nullPost = await api('POST', '/api/tasks', { title: 'x', priority: null });
  assert.strictEqual(nullPost.status, 201);
  assert.strictEqual(nullPost.body.priority, 'medium', 'POST 传 null 属宽缺省，归一为 medium');

  const urgent = await api('POST', '/api/tasks', { title: 'x', priority: 'urgent' });
  assert.strictEqual(urgent.status, 400);
  assert.strictEqual(urgent.body.error.code, 'FIELD_INVALID');
  assert.match(urgent.body.error.message, /priority/);

  const num = await api('POST', '/api/tasks', { title: 'x', priority: 123 });
  assert.strictEqual(num.status, 400);

  // PATCH 的 priority 必须严格属于枚举，null 也非法（不同于 POST 的宽缺省）
  const finishing = await api('POST', '/api/tasks', { title: 'finishing 任务', priority: 'high' });
  const patchNull = await api('PATCH', `/api/tasks/${finishing.body.id}`, { priority: null });
  assert.strictEqual(patchNull.status, 400);
  assert.strictEqual(patchNull.body.error.code, 'FIELD_INVALID');
  assert.match(patchNull.body.error.message, /priority/);

  await api('DELETE', `/api/tasks/${finishing.body.id}`);
  await api('DELETE', `/api/tasks/${nullPost.body.id}`);
  await api('DELETE', `/api/tasks/${dft.body.id}`);
});

test('v1.4 PATCH dueDate：POST 缺省 null、设置生效、PATCH null 清空', async () => {
  const created = await api('POST', '/api/tasks', { title: '截止时间增改任务' });
  const id = created.body.id;
  assert.strictEqual(created.body.dueDate, null, 'POST 未传 dueDate 缺省 null');

  const set = await api('PATCH', `/api/tasks/${id}`, { dueDate: '2026-12-31' });
  assert.strictEqual(set.status, 200);
  assert.strictEqual(set.body.dueDate, '2026-12-31');

  const clear = await api('PATCH', `/api/tasks/${id}`, { dueDate: null });
  assert.strictEqual(clear.status, 200);
  assert.strictEqual(clear.body.dueDate, null, 'PATCH null 清空 dueDate');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v1.4 GET /api/tasks?priority= 过滤：精确匹配、与 status 叠加、非法取值为空数组', async () => {
  const a = await api('POST', '/api/tasks', { title: '高优先级任务', priority: 'high' });
  const b = await api('POST', '/api/tasks', { title: '低优先级任务', priority: 'low' });
  await api('PATCH', `/api/tasks/${b.body.id}`, { status: 'doing' });

  const high = await api('GET', '/api/tasks?priority=high');
  assert.strictEqual(high.status, 200);
  assert.ok(high.body.every((t) => t.priority === 'high'));
  assert.ok(high.body.some((t) => t.id === a.body.id), '?priority=high 应含高优先级任务 a');

  const lowDoing = await api('GET', '/api/tasks?priority=low&status=doing');
  assert.deepStrictEqual(lowDoing.body.map((t) => t.id), [b.body.id], 'priority 与 status 叠加过滤');

  const medium = await api('GET', '/api/tasks?priority=medium');
  assert.ok(medium.body.every((t) => t.priority === 'medium'));

  const nope = await api('GET', '/api/tasks?priority=nope');
  assert.deepStrictEqual(nope.body, [], '非法取值过滤为空数组');

  await api('DELETE', `/api/tasks/${a.body.id}`);
  await api('DELETE', `/api/tasks/${b.body.id}`);
});

test('v2.9.4 项目绑定：POST/PATCH projectDir、绑定与解绑进时间轴（bind 事件）、非字符串 400', async () => {
  // Arrange：创建任务（不带 projectDir → 字段为 null）
  const c = await api('POST', '/api/tasks', { title: '绑定口径任务' });
  assert.strictEqual(c.status, 201);
  assert.strictEqual(c.body.projectDir, null, '缺省 projectDir=null');

  // Act 1：POST 直接带 projectDir
  const d = await api('POST', '/api/tasks', { title: '带绑定任务', projectDir: 'E:\\agent开发\\FdeHarness' });
  assert.strictEqual(d.status, 201);
  assert.strictEqual(d.body.projectDir, 'E:\\agent开发\\FdeHarness');

  // Act 2：PATCH 绑定 → 详情含 projectDir + bind 事件（detail 带路径）
  const p = await api('PATCH', `/api/tasks/${c.body.id}`, { projectDir: 'E:/agent开发/FilesAdmin' });
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.body.projectDir, 'E:/agent开发/FilesAdmin');
  const det = await api('GET', `/api/tasks/${c.body.id}`);
  const bindEv = (det.body.events || []).find((e) => e.type === 'bind');
  assert.ok(bindEv, '绑定应产生 bind 事件');
  assert.ok(String(bindEv.detail).includes('FilesAdmin'), 'bind 事件 detail 带项目路径');

  // Act 3：PATCH null 解绑 → projectDir 回 null + 解绑事件
  const u = await api('PATCH', `/api/tasks/${c.body.id}`, { projectDir: null });
  assert.strictEqual(u.status, 200);
  assert.strictEqual(u.body.projectDir, null);
  const det2 = await api('GET', `/api/tasks/${c.body.id}`);
  const unbindEv = (det2.body.events || []).find((e) => e.type === 'bind' && e.to === null);
  assert.ok(unbindEv, '解绑应产生 to=null 的 bind 事件');

  // Act 4：非字符串 → 400 FIELD_INVALID
  const bad = await api('PATCH', `/api/tasks/${c.body.id}`, { projectDir: 123 });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error.code, 'FIELD_INVALID');

  await api('DELETE', `/api/tasks/${c.body.id}`);
  await api('DELETE', `/api/tasks/${d.body.id}`);
});

test('v2.9.15 成果提交说明：GET 列表/详情按 url 从 activities 回填 title/messageBody（仅响应不落盘）', async () => {
  const t = await api('POST', '/api/tasks', { title: '成果说明回填', branch: 'feat/backfill' });
  assert.strictEqual(t.status, 201);
  // 手动挂接一条成果（POST 路径不写 title）+ 往 activities.json 放同 url 动态（含说明）
  const a = await api('POST', `/api/tasks/${t.body.id}/artifacts`, {
    url: 'https://gitea.example.com/example-org/demo/commit/backfill01',
    kind: 'commit', repo: 'example-org/demo', ref: 'feat/backfill',
  });
  assert.strictEqual(a.status, 201);
  fs.writeFileSync(path.join(dataDir, 'activities.json'), JSON.stringify([
    { id: 'act-bf1', type: 'commit', actor: 'dev', repo: 'example-org/demo', branch: 'feat/backfill',
      sha: 'backfill01', title: 'feat: 成果说明回填用例', messageBody: '正文首段，验证读取时归一。',
      url: 'https://gitea.example.com/example-org/demo/commit/backfill01',
      occurredAt: new Date().toISOString(), fetchedAt: new Date().toISOString() },
  ]));

  const d = await api('GET', `/api/tasks/${t.body.id}`);
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.body.artifacts[0].title, 'feat: 成果说明回填用例', '详情：说明已回填');
  assert.strictEqual(d.body.artifacts[0].messageBody, '正文首段，验证读取时归一。');
  const list = await api('GET', '/api/tasks');
  const lt = list.body.find((x) => x.id === t.body.id);
  assert.strictEqual(lt.artifacts[0].title, 'feat: 成果说明回填用例', '列表：同样回填');
  // 仅响应回填：磁盘 tasks.json 的成果仍无 title（下一次活动窗口滚动后口径不固化）
  const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));
  const dt = disk.tasks.find((x) => x.id === t.body.id);
  assert.strictEqual(dt.artifacts[0].title, undefined, '磁盘原值未被写穿');
  await api('DELETE', `/api/tasks/${t.body.id}`);
});
