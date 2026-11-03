'use strict';

/**
 * task-events.test.js — v1.7 任务完成日期（completedAt）+ 任务事件流
 * 覆盖：completedAt 置/清/重进 done 刷新/不带 status 不 touch；
 *       事件流 created/status/completed/assign/due/priority/edit 各类型、
 *       v2.0 accept 事件（验收人变更/清除/进 done 验收通过联动），
 *       同次 PATCH 多字段防噪合并、每任务 100 条截断、删任务清理事件、
 *       存量老任务详情空数组不回填、存储层全局 5000 上限（模块级）。
 * 运行：node --test test/task-events.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7801; // 仅作 fixture 配置留痕（进程内装配不再监听端口）

const { buildApp } = require('./helpers/appAssembler');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function diskEvents() {
  const file = path.join(dataDir, 'task_events.json');
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : raw.events || [];
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-taskev-'));
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

// ---------- created 事件与 completedAt 缺省 ----------

test('v1.7 POST 建任务：详情带 created 事件（手工创建）、completedAt=null；列表带 completedAt 无 events', async () => {
  const r = await api('POST', '/api/tasks', { title: '事件流样板任务' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.completedAt, null, '非 done 创建 completedAt=null');
  assert.strictEqual(r.body.events, undefined, 'POST 响应不带 events（仅详情带）');

  const det = await api('GET', `/api/tasks/${r.body.id}`);
  assert.strictEqual(det.status, 200);
  assert.strictEqual(det.body.completedAt, null);
  assert.ok(Array.isArray(det.body.events));
  assert.strictEqual(det.body.events.length, 1);
  const ev = det.body.events[0];
  assert.strictEqual(ev.type, 'created');
  assert.strictEqual(ev.taskId, r.body.id);
  assert.strictEqual(ev.from, null);
  assert.strictEqual(ev.to, 'todo', 'created 的 to 为初始状态');
  assert.strictEqual(ev.detail, '手工创建');
  assert.match(ev.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(ev.id, /^e-/);

  const list = await api('GET', '/api/tasks');
  const item = list.body.find((t) => t.id === r.body.id);
  assert.ok(item, '列表可见');
  assert.strictEqual(item.completedAt, null, '列表自然带出 completedAt');
  assert.strictEqual(item.events, undefined, '列表不带 events（仅详情）');
});

test('v1.7 POST status=done 直接创建：completedAt=当前时间，created 事件 to=done', async () => {
  const before = Date.now() - 1000;
  const r = await api('POST', '/api/tasks', { title: '创建即完成', status: 'done' });
  assert.strictEqual(r.status, 201);
  assert.ok(r.body.completedAt, 'completedAt 落值');
  const ts = Date.parse(r.body.completedAt);
  assert.ok(ts >= before && ts <= Date.now() + 1000, 'completedAt 为当前时间（ISO）');

  const det = await api('GET', `/api/tasks/${r.body.id}`);
  assert.strictEqual(det.body.events[0].to, 'done', 'created 事件 to=初始状态 done');
  await api('DELETE', `/api/tasks/${r.body.id}`);
});

// ---------- completedAt 置 / 清 / 重进刷新 / 不 touch ----------

test('v1.7 completedAt：进 done 置值、移出清 null、重进 done 刷新为最新', async () => {
  const r = await api('POST', '/api/tasks', { title: '完成日期状态机' });
  const id = r.body.id;
  assert.strictEqual(r.body.completedAt, null);

  const doing = await api('PATCH', `/api/tasks/${id}`, { status: 'doing' });
  assert.strictEqual(doing.body.completedAt, null, '移出/未到 done 保持 null');

  await sleep(25);
  const done1 = await api('PATCH', `/api/tasks/${id}`, { status: 'done' });
  assert.ok(done1.body.completedAt, '进 done 置 completedAt');
  const first = done1.body.completedAt;

  await sleep(25);
  const back = await api('PATCH', `/api/tasks/${id}`, { status: 'doing' });
  assert.strictEqual(back.body.completedAt, null, '移出 done 清 null');

  await sleep(25);
  const done2 = await api('PATCH', `/api/tasks/${id}`, { status: 'done' });
  assert.ok(done2.body.completedAt, '重进 done 重新置值');
  assert.ok(done2.body.completedAt > first, '重进 done 刷新为最新（大于首次值）');

  await sleep(25);
  const touch = await api('PATCH', `/api/tasks/${id}`, { notes: '改备注不动状态' });
  assert.strictEqual(touch.body.status, 'done');
  assert.strictEqual(touch.body.completedAt, done2.body.completedAt, 'PATCH 不带 status 不 touch completedAt');

  await sleep(25);
  const refresh = await api('PATCH', `/api/tasks/${id}`, { status: 'done' });
  assert.ok(refresh.body.completedAt > done2.body.completedAt, '已是 done 再提交 status=done 也刷新为最新');
  await api('DELETE', `/api/tasks/${id}`);
});

// ---------- 事件类型：status/completed/assign/due/priority/edit ----------

test('v1.7 status/completed 事件：普通迁移 type=status，进 done 特化为 completed（from→to）', async () => {
  const r = await api('POST', '/api/tasks', { title: '状态事件样板' });
  const id = r.body.id;
  await api('PATCH', `/api/tasks/${id}`, { status: 'doing' });
  await sleep(5);
  await api('PATCH', `/api/tasks/${id}`, { status: 'done' });

  const det = await api('GET', `/api/tasks/${id}`);
  const evs = det.body.events; // 倒序：最新在前
  assert.strictEqual(evs.length, 3, 'created + status + completed');
  assert.strictEqual(evs[0].type, 'completed', 'to==="done" 时 type 用 completed');
  assert.strictEqual(evs[0].from, 'doing');
  assert.strictEqual(evs[0].to, 'done');
  assert.strictEqual(evs[1].type, 'status');
  assert.strictEqual(evs[1].from, 'todo');
  assert.strictEqual(evs[1].to, 'doing');
  assert.strictEqual(evs[2].type, 'created');
  // 同毫秒内 created 与 status 事件按文件序保持先后：倒序后 completed 在最前
  assert.ok(Date.parse(evs[0].at) >= Date.parse(evs[2].at));
  await api('DELETE', `/api/tasks/${id}`);
});

test('v1.7 assign 事件：agentId+memberId 同次变更合并一条；双向清空也记（to=未指派）', async () => {
  const r = await api('POST', '/api/tasks', { title: '指派事件样板' });
  const id = r.body.id;

  const set = await api('PATCH', `/api/tasks/${id}`, { agentId: 'claude', memberId: 'li.na' });
  assert.strictEqual(set.status, 200);
  let det = await api('GET', `/api/tasks/${id}`);
  let ev = det.body.events[0];
  assert.strictEqual(det.body.events.length, 2, 'created + assign（防噪：两字段一条）');
  assert.strictEqual(ev.type, 'assign');
  assert.strictEqual(ev.from, '未指派');
  assert.strictEqual(ev.to, 'agent:claude + member:li.na');
  assert.match(ev.detail, /agentId/);
  assert.match(ev.detail, /memberId/);

  const clear = await api('PATCH', `/api/tasks/${id}`, { agentId: null });
  det = await api('GET', `/api/tasks/${id}`);
  ev = det.body.events[0];
  assert.strictEqual(ev.type, 'assign');
  assert.strictEqual(ev.from, 'agent:claude + member:li.na');
  assert.strictEqual(ev.to, 'member:li.na', '双向清空也记（agentId 侧清空）');

  await api('PATCH', `/api/tasks/${id}`, { memberId: null });
  det = await api('GET', `/api/tasks/${id}`);
  ev = det.body.events[0];
  assert.strictEqual(ev.to, '未指派', '全部清空记为未指派');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v1.7 due 事件：设置 from=null to=日期；清空 to="清除"', async () => {
  const r = await api('POST', '/api/tasks', { title: '截止事件样板' });
  const id = r.body.id;

  await api('PATCH', `/api/tasks/${id}`, { dueDate: '2026-12-31' });
  let det = await api('GET', `/api/tasks/${id}`);
  let ev = det.body.events[0];
  assert.strictEqual(ev.type, 'due');
  assert.strictEqual(ev.from, null);
  assert.strictEqual(ev.to, '2026-12-31');

  await api('PATCH', `/api/tasks/${id}`, { dueDate: null });
  det = await api('GET', `/api/tasks/${id}`);
  ev = det.body.events[0];
  assert.strictEqual(ev.type, 'due');
  assert.strictEqual(ev.from, '2026-12-31');
  assert.strictEqual(ev.to, '清除', '清除时 to 为「清除」字面量');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v1.7 priority 事件：medium→high from/to 记录', async () => {
  const r = await api('POST', '/api/tasks', { title: '优先级事件样板', priority: 'medium' });
  const id = r.body.id;
  await api('PATCH', `/api/tasks/${id}`, { priority: 'high' });
  const det = await api('GET', `/api/tasks/${id}`);
  const ev = det.body.events[0];
  assert.strictEqual(ev.type, 'priority');
  assert.strictEqual(ev.from, 'medium');
  assert.strictEqual(ev.to, 'high');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v1.7 edit 事件：title/desc/notes 同次变更一条，detail 注明字段不存全文', async () => {
  const r = await api('POST', '/api/tasks', { title: '编辑事件样板' });
  const id = r.body.id;
  const longText = '很长的正文'.repeat(50);
  await api('PATCH', `/api/tasks/${id}`, { title: '编辑事件样板（改）', desc: longText, notes: '新备注' });
  const det = await api('GET', `/api/tasks/${id}`);
  const ev = det.body.events[0];
  assert.strictEqual(det.body.events.length, 2, 'created + edit（三字段合并一条）');
  assert.strictEqual(ev.type, 'edit');
  assert.match(ev.detail, /title/);
  assert.match(ev.detail, /desc/);
  assert.match(ev.detail, /notes/);
  assert.ok(!JSON.stringify(ev).includes('很长的正文'), '事件不存全文');
  assert.strictEqual(ev.from, null);
  assert.strictEqual(ev.to, null);
  await api('DELETE', `/api/tasks/${id}`);
});

test('v1.7 防噪：一次 PATCH 五类字段 → 恰好 status/assign/due/priority/edit 各一条', async () => {
  const r = await api('POST', '/api/tasks', { title: '多字段防噪样板' });
  const id = r.body.id;
  await api('PATCH', `/api/tasks/${id}`, {
    status: 'doing',
    agentId: 'dsh',
    dueDate: '2026-11-30',
    priority: 'low',
    notes: '一次改五类',
  });
  const det = await api('GET', `/api/tasks/${id}`);
  const types = det.body.events.map((e) => e.type).sort();
  assert.deepStrictEqual(types, ['assign', 'created', 'due', 'edit', 'priority', 'status'], '每字段类型最多一条');
  await api('DELETE', `/api/tasks/${id}`);
});

// ---------- v2.0 验收人 accept 事件 ----------

test('v2.0 PATCH 设置 acceptorId → accept 事件（from=null，to=新 id，detail=验收人变更）', async () => {
  const r = await api('POST', '/api/tasks', { title: '验收事件样板' });
  const id = r.body.id;
  await api('PATCH', `/api/tasks/${id}`, { acceptorId: 'qianqi' });
  const det = await api('GET', `/api/tasks/${id}`);
  const ev = det.body.events[0];
  assert.strictEqual(ev.type, 'accept');
  assert.strictEqual(ev.from, null);
  assert.strictEqual(ev.to, 'qianqi');
  assert.strictEqual(ev.detail, '验收人变更');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v2.0 PATCH 改派验收人 → accept 事件 from=旧值 to=新值', async () => {
  const r = await api('POST', '/api/tasks', { title: '验收改派样板', acceptorId: 'qianqi' });
  const id = r.body.id;
  await api('PATCH', `/api/tasks/${id}`, { acceptorId: 'li.na' });
  const det = await api('GET', `/api/tasks/${id}`);
  const ev = det.body.events[0];
  assert.strictEqual(ev.type, 'accept');
  assert.strictEqual(ev.from, 'qianqi');
  assert.strictEqual(ev.to, 'li.na');
  assert.strictEqual(ev.detail, '验收人变更');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v2.0 PATCH acceptorId:null → accept 事件 detail=清除验收人、to=null', async () => {
  const r = await api('POST', '/api/tasks', { title: '验收清除样板', acceptorId: 'qianqi' });
  const id = r.body.id;
  await api('PATCH', `/api/tasks/${id}`, { acceptorId: null });
  const det = await api('GET', `/api/tasks/${id}`);
  const ev = det.body.events[0];
  assert.strictEqual(ev.type, 'accept');
  assert.strictEqual(ev.from, 'qianqi');
  assert.strictEqual(ev.to, null);
  assert.strictEqual(ev.detail, '清除验收人');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v2.0 PATCH {status:"done"} 且已有验收人 → completed 之外额外一条 accept 事件（detail=验收通过：by）', async () => {
  const r = await api('POST', '/api/tasks', { title: '验收通过样板', acceptorId: 'qianqi' });
  const id = r.body.id;
  await api('PATCH', `/api/tasks/${id}`, { status: 'done' });
  const det = await api('GET', `/api/tasks/${id}`);
  const evs = det.body.events; // 倒序：最新在前
  assert.strictEqual(evs.length, 3, 'created + completed + accept 联动');
  assert.strictEqual(evs[0].type, 'accept', '联动 accept 事件追加在末尾，倒序后最新在前');
  assert.strictEqual(evs[0].from, null);
  assert.strictEqual(evs[0].to, 'qianqi');
  assert.strictEqual(evs[0].detail, '验收通过：by qianqi');
  assert.strictEqual(evs[1].type, 'completed');
  assert.strictEqual(evs[2].type, 'created');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v2.0 PATCH {status:"done"} 无验收人 → 不发 accept 联动事件', async () => {
  const r = await api('POST', '/api/tasks', { title: '无验收人完成样板' });
  const id = r.body.id;
  await api('PATCH', `/api/tasks/${id}`, { status: 'done' });
  const det = await api('GET', `/api/tasks/${id}`);
  const types = det.body.events.map((e) => e.type).sort();
  assert.deepStrictEqual(types, ['completed', 'created'], '仅 created + completed，无 accept');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v2.0 同一次 PATCH {acceptorId, status:"done"} → 两条 accept 事件（变更 + 验收通过联动）', async () => {
  const r = await api('POST', '/api/tasks', { title: '一次提交双验收事件样板' });
  const id = r.body.id;
  await api('PATCH', `/api/tasks/${id}`, { acceptorId: 'li.na', status: 'done' });
  const det = await api('GET', `/api/tasks/${id}`);
  const evs = det.body.events; // 倒序：联动事件追加在函数末尾 → 倒序后最前
  assert.strictEqual(evs.length, 4, 'created + completed + accept 变更 + accept 联动');
  assert.strictEqual(evs[0].type, 'accept');
  assert.strictEqual(evs[0].from, null);
  assert.strictEqual(evs[0].to, 'li.na');
  assert.strictEqual(evs[0].detail, '验收通过：by li.na');
  assert.strictEqual(evs[1].type, 'accept');
  assert.strictEqual(evs[1].from, null);
  assert.strictEqual(evs[1].to, 'li.na');
  assert.strictEqual(evs[1].detail, '验收人变更');
  assert.strictEqual(evs[2].type, 'completed');
  assert.strictEqual(evs[3].type, 'created');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v2.0 PATCH 只改其他字段 → 不产生 accept 事件', async () => {
  const r = await api('POST', '/api/tasks', { title: '无关字段样板', acceptorId: 'qianqi' });
  const id = r.body.id;
  await api('PATCH', `/api/tasks/${id}`, { notes: '只改备注', priority: 'high' });
  const det = await api('GET', `/api/tasks/${id}`);
  const types = det.body.events.map((e) => e.type).sort();
  assert.deepStrictEqual(types, ['created', 'edit', 'priority'], '仅 created + 本次变更类型，无 accept');
  await api('DELETE', `/api/tasks/${id}`);
});

// ---------- 100 条截断 + 删任务清理 ----------

test('v1.7 每任务保留最近 100 条：105 次编辑后详情/磁盘均 100 条且最新在前', async () => {
  const r = await api('POST', '/api/tasks', { title: '截断样板 v0' });
  const id = r.body.id;
  for (let i = 1; i <= 105; i++) {
    const p = await api('PATCH', `/api/tasks/${id}`, { title: `截断样板 v${i}` });
    assert.strictEqual(p.status, 200);
  }
  const det = await api('GET', `/api/tasks/${id}`);
  assert.strictEqual(det.body.events.length, 100, '详情倒序最近 100 条');
  assert.ok(
    det.body.events.every((e, i, a) => i === 0 || Date.parse(a[i - 1].at) >= Date.parse(e.at)),
    '事件按 at 倒序（最新在前）'
  );
  const mine = diskEvents().filter((e) => e.taskId === id);
  assert.strictEqual(mine.length, 100, '磁盘文件中该任务恰保留 100 条（超出丢最旧）');
  assert.ok(mine.every((e) => e.type === 'edit'), '最旧的 created 事件已被挤出（106 进 100，丢最旧）');
  await api('DELETE', `/api/tasks/${id}`);
});

test('v1.7 删任务顺带清理其事件（磁盘无残留）', async () => {
  const r = await api('POST', '/api/tasks', { title: '删除清理样板' });
  const id = r.body.id;
  await api('PATCH', `/api/tasks/${id}`, { status: 'doing' });
  assert.ok(diskEvents().some((e) => e.taskId === id), '删除前事件在盘');

  const del = await api('DELETE', `/api/tasks/${id}`);
  assert.strictEqual(del.status, 204);
  assert.deepStrictEqual(diskEvents().filter((e) => e.taskId === id), [], '删任务后其事件全部清理');

  const gone = await api('GET', `/api/tasks/${id}`);
  assert.strictEqual(gone.status, 404);
});

// ---------- 存量老任务：空数组不回填 ----------

test('v1.7 存量老任务（无 completedAt/无事件）：详情 events=[]，PATCH 后只有新事件不回填 created', async () => {
  // 直接写 tasks.json 模拟 v1.7 之前落盘的存量任务
  const legacyId = 't-legacy0-old-xxxx';
  fs.writeFileSync(
    path.join(dataDir, 'tasks.json'),
    JSON.stringify({
      columns: [
        { id: 'todo', name: '待分配', order: 1 },
        { id: 'doing', name: '进行中', order: 2 },
        { id: 'review', name: '待验证', order: 3 },
        { id: 'done', name: '已完成', order: 4 },
      ],
      tasks: [{ id: legacyId, title: '存量老任务', status: 'doing', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }],
    })
  );
  // 清空事件文件，隔离前序用例的孤儿事件
  fs.writeFileSync(path.join(dataDir, 'task_events.json'), JSON.stringify({ events: [] }));

  const det = await api('GET', `/api/tasks/${legacyId}`);
  assert.strictEqual(det.status, 200);
  assert.deepStrictEqual(det.body.events, [], '存量老任务事件为空数组，不回填');
  assert.strictEqual(det.body.completedAt, undefined, '存量字段不动，自然缺省');

  const done = await api('PATCH', `/api/tasks/${legacyId}`, { status: 'done' });
  assert.strictEqual(done.status, 200);
  assert.ok(done.body.completedAt, '存量任务 PATCH 后照常获得 completedAt');

  const det2 = await api('GET', `/api/tasks/${legacyId}`);
  assert.strictEqual(det2.body.events.length, 1, '只有本次变更的事件，created 不回填');
  assert.strictEqual(det2.body.events[0].type, 'completed');
});

// ---------- 模块级：appendEvents 双重上限 ----------

const taskEvents = require('../lib/taskEvents.js');

test('模块级 appendEvents：全局 5000 上限丢最旧；每任务 100 上限；eventsForTask 倒序', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-taskev-mod-'));
  const ctx = { taskEventsPath: path.join(dir, 'task_events.json') };

  // 每任务上限：单任务 150 条 → 只留最新 100
  const bulkA = Array.from({ length: 150 }, (_, i) =>
    taskEvents.makeEvent('taskA', 'edit', null, null, `#${i}`, new Date(2026, 0, 1, 0, 0, 0, i).toISOString())
  );
  taskEvents.appendEvents(ctx, bulkA);
  let disk = taskEvents.loadEvents(ctx);
  assert.strictEqual(disk.length, 100);
  assert.strictEqual(disk[0].detail, '#50', '最旧的 50 条被丢弃');
  assert.strictEqual(disk[99].detail, '#149');
  assert.deepStrictEqual(taskEvents.eventsForTask(ctx, 'taskA').map((e) => e.detail).slice(0, 3), ['#149', '#148', '#147'], '倒序（最新在前）');
  assert.deepStrictEqual(taskEvents.eventsForTask(ctx, 'no-such'), []);

  // 全局上限：再灌另一任务 4950 条 → 先全局丢最旧（taskA 剩 50），再按任务上限裁 B 至 100
  const bulkB = Array.from({ length: 4950 }, (_, i) =>
    taskEvents.makeEvent('taskB', 'edit', null, null, `B#${i}`, new Date(2026, 0, 2, 0, 0, 0, i % 1000).toISOString())
  );
  taskEvents.appendEvents(ctx, bulkB);
  disk = taskEvents.loadEvents(ctx);
  assert.ok(disk.length <= taskEvents.GLOBAL_LIMIT, '全文件不超 5000 上限');
  const aLeft = disk.filter((e) => e.taskId === 'taskA');
  const bLeft = disk.filter((e) => e.taskId === 'taskB');
  assert.strictEqual(aLeft.length, 50, '全局 5000 截断丢最旧：taskA 只剩 50 条');
  assert.strictEqual(aLeft[0].detail, '#100');
  assert.strictEqual(bLeft.length, taskEvents.PER_TASK_LIMIT, '每任务 100 硬上限：taskB 裁至最新 100 条');
  assert.strictEqual(bLeft[bLeft.length - 1].detail, 'B#4949', '保留的是最新段');
  assert.strictEqual(taskEvents.eventsForTask(ctx, 'taskB').length, 100);

  // 真·全局 5000 触发：55 个任务 × 各 100 条 = 5500 → 全文件收敛到 5000（丢最旧 500 条）
  const ctx2 = { taskEventsPath: path.join(dir, 'task_events_55.json') };
  for (let t = 0; t < 55; t++) {
    const bulk = Array.from({ length: 100 }, (_, i) =>
      taskEvents.makeEvent(`task${String(t).padStart(2, '0')}`, 'edit', null, null, `T${t}-${i}`, new Date(2026, 0, 3, 0, 0, 0, i).toISOString())
    );
    taskEvents.appendEvents(ctx2, bulk);
  }
  disk = taskEvents.loadEvents(ctx2);
  assert.strictEqual(disk.length, taskEvents.GLOBAL_LIMIT, '55×100=5500 → 全文件恰 5000');
  const byTask = new Map();
  for (const e of disk) byTask.set(e.taskId, (byTask.get(e.taskId) || 0) + 1);
  assert.ok([...byTask.values()].every((n) => n <= taskEvents.PER_TASK_LIMIT), '全局截断后每任务仍 ≤100');
  assert.strictEqual(byTask.size, 50, '增量追加下每次新任务进池挤掉最旧整任务：55 → 50 个任务');
  assert.strictEqual(byTask.get('task00'), undefined, '最旧的 task00 已被整体挤出');
  assert.strictEqual(byTask.get('task05'), 100, '滑窗内首个幸存任务全保留');
  assert.strictEqual(byTask.get('task54'), 100, '最新任务全保留');
});

// ---------- v2.9.33 存储路由：task_events 迁 SQLite 后语义逐条同构（SPEC-STORAGE §3.2） ----------
// 用 lib/migration.runMigration 从 JSON 夹具建库（测试文件自身零 node:sqlite——Mimosa 钩子约束），
// 再经 taskEvents 公开 API 断言路由后行为；tmp 目录独立，不与上方共享 app 夹具耦合。

test('存储路由：task_events 迁 SQLite 后 loadEvents/追加/裁剪/removeTaskEvents 语义同构', () => {
  const { runMigration } = require('../lib/migration');
  const storeDb = require('../lib/storeDb');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-te-sqlite-'));
  const ctx = { taskEventsPath: path.join(dir, 'task_events.json') };
  const ev = (id, taskId, at) => ({ id, taskId, type: 'status', from: 'todo', to: 'doing', detail: `d-${id}`, at });
  fs.writeFileSync(ctx.taskEventsPath, JSON.stringify({ events: [ev('e-old-2', 't-a', '2026-10-01T00:00:00Z'), ev('e-old-1', 't-a', '2026-09-30T00:00:00Z')] }));

  // 迁移：JSON → db + 台账 + 原档改名
  const rep = runMigration({ dataDir: dir, units: ['task_events'], now: Date.parse('2026-10-31T00:00:00Z') });
  assert.equal(rep.units[0].unit, 'task_events');
  assert.equal(rep.units[0].sourceRows, 2);
  assert.ok(fs.existsSync(path.join(dir, 'fde.db')), 'db 已建');
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('task_events.json.migrated-')), '原档改名保留');

  // 路由生效：loadEvents 走 db（迁移保序：文件数组序原样保留）
  assert.equal(storeDb.unitBackend(dir, 'task_events').backend, 'sqlite');
  assert.deepEqual(taskEvents.loadEvents(ctx).map((e) => e.id), ['e-old-2', 'e-old-1'], '迁移保序：文件序原样进库');

  // 追加：新事件落 db，读出在尾
  taskEvents.appendEvents(ctx, [ev('e-new-1', 't-a', '2026-10-31T00:00:00Z')]);
  assert.deepEqual(taskEvents.loadEvents(ctx).map((e) => e.id), ['e-old-2', 'e-old-1', 'e-new-1']);

  // 每任务裁剪：t-b 造 102 条 → 剩 100 且丢的是最旧
  taskEvents.appendEvents(ctx, Array.from({ length: 102 }, (_, i) => ev(`e-b-${i}`, 't-b', new Date(Date.parse('2026-10-31T00:00:00Z') + i * 1000).toISOString())));
  const b = taskEvents.loadEvents(ctx).filter((e) => e.taskId === 't-b');
  assert.equal(b.length, 100, '每任务上限 100');
  assert.ok(b[0].id === 'e-b-2' && b[b.length - 1].id === 'e-b-101', '丢的是最旧两条');

  // removeTaskEvents：db 路径清理
  const removed = taskEvents.removeTaskEvents(ctx, 't-b');
  assert.equal(removed, 100);
  assert.equal(taskEvents.loadEvents(ctx).filter((e) => e.taskId === 't-b').length, 0);

  storeDb.clearCache();
  fs.rmSync(dir, { recursive: true, force: true });
});
