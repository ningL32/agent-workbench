'use strict';

/**
 * inbox-merge.test.js — v2.9.12 合并入库（收件箱扩展）
 * 覆盖：合并建任务（人工标题/描述/负责人/优先级）、N-1 候选转 merged + memo 事件
 *       + relatedMemos 溯源、pending 过滤消失、stats.merged30d、
 *       非 pending 409、update 候选 400、ids<2/重复 id/空标题 400。
 * 运行：node --test test/inbox-merge.test.js（直写 inbox.json 夹具，全离线）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildApp } = require('./helpers/appAssembler');

let app;
let dataDir;

async function api(method, p, body) {
  return app.fetch(method, p, {
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cand(id, over = {}) {
  return { id, state: 'pending', kind: 'task', title: '候选 ' + id, desc: '描述 ' + id, quote: '引用 ' + id, confidence: 0.7, priority: 'medium', messageId: 'msg-' + id, messageTitle: '会议 X', createdAt: new Date().toISOString(), suggestedMemberId: null, dueDate: null, ...over };
}

function seed(cands) {
  fs.writeFileSync(path.join(dataDir, 'inbox.json'), JSON.stringify({ candidates: cands }));
}

test.before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-inbox-merge-'));
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    port: 7798,
    host: '127.0.0.1',
    dataDir,
    webDir: path.join(tmp, 'web'),
    gitea: { pollIntervalSec: 0 },
  }));
  fs.writeFileSync(path.join(tmp, 'members.json'), JSON.stringify({ members: [
    { id: 'lei', name: '李雷', role: '', giteaLogin: '', enabled: true },
  ] }));
  app = buildApp({
    configPath: path.join(tmp, 'config.json'),
    env: { DINGTALK_FIXTURE: path.join(__dirname, 'fixtures', 'dingtalk.json'), DSH_FIXTURE: path.join(__dirname, 'fixtures', 'dsh-ok.txt') },
    persistentEnv: true,
  });
});

test.after(() => { if (app) app.close(); });

test('v2.9.12 合并入库：2 候选 → 1 任务（人工标题/描述）+ 全部转 merged + memo 事件 + relatedMemos', async () => {
  seed([
    cand('c1', { confidence: 0.9, title: 'SOP 梳理' }),
    cand('c2', { confidence: 0.7, title: '分类清单' }),
    cand('c3'),
  ]);
  const r = await api('POST', '/api/inbox/confirm-merged', { ids: ['c1', 'c2'], title: '财务AI需求调研整合', desc: '人工填写的合并说明', memberId: 'lei', priority: 'high' });
  assert.strictEqual(r.status, 200);
  const task = r.body.task;
  assert.strictEqual(task.title, '财务AI需求调研整合');
  assert.strictEqual(task.desc, '人工填写的合并说明');
  assert.strictEqual(task.memberId, 'lei');
  assert.strictEqual(task.priority, 'high');
  assert.strictEqual(task.origin.type, 'inbox');
  assert.strictEqual(task.origin.refId, 'c1', '主候选 = ids[0]（置信度最高者由前端排序保证）');
  assert.strictEqual(task.origin.relatedMemos.length, 2);
  // 候选转 merged 且挂到任务
  const list = await api('GET', '/api/inbox');
  const byId = Object.fromEntries(list.body.filter((x) => ['c1', 'c2', 'c3'].includes(x.id)).map((x) => [x.id, x]));
  assert.strictEqual(byId.c1.state, 'merged');
  assert.strictEqual(byId.c1.mergedInto, task.id);
  assert.ok(byId.c1.mergedAt);
  assert.strictEqual(byId.c2.state, 'merged');
  assert.strictEqual(byId.c3.state, 'pending', '未参与合并的候选不受影响');
  // pending 列表不再包含已并入候选
  const pending = await api('GET', '/api/inbox?state=pending');
  assert.ok(!pending.body.some((x) => x.id === 'c1' || x.id === 'c2'));
  // 事件流：两条候选各记一条 memo 事件
  const ev = await api('GET', `/api/tasks/${task.id}`);
  assert.strictEqual(ev.status, 200);
  const memos = ev.body.events.filter((e) => e.type === 'memo');
  assert.strictEqual(memos.length, 2, '两条候选各记一条 memo 事件');
  // stats.merged30d
  const stats = await api('GET', '/api/inbox/stats');
  assert.strictEqual(stats.body.merged30d, 2);
  assert.strictEqual(stats.body.merged, 2);
});

test('v2.9.12 合并入库：非 pending 409 / update 候选 400 / ids<2 / 重复 id / 空标题 400', async () => {
  seed([
    cand('d1', { state: 'rejected', rejectReason: 'duplicate', decidedAt: new Date().toISOString() }),
    cand('d2'),
    cand('d3', { kind: 'update', existingTaskId: 't-nope' }),
    cand('d4'),
  ]);
  const r409 = await api('POST', '/api/inbox/confirm-merged', { ids: ['d1', 'd2'], title: 'X' });
  assert.strictEqual(r409.status, 409);
  assert.strictEqual(r409.body.error.code, 'ALREADY_DECIDED');
  const r400u = await api('POST', '/api/inbox/confirm-merged', { ids: ['d2', 'd3'], title: 'X' });
  assert.strictEqual(r400u.status, 400);
  assert.strictEqual(r400u.body.error.code, 'UPDATE_KIND_UNSUPPORTED');
  const r400n = await api('POST', '/api/inbox/confirm-merged', { ids: ['d2'], title: 'X' });
  assert.strictEqual(r400n.status, 400);
  const r400d = await api('POST', '/api/inbox/confirm-merged', { ids: ['d2', 'd2'], title: 'X' });
  assert.strictEqual(r400d.status, 400);
  const r400t = await api('POST', '/api/inbox/confirm-merged', { ids: ['d2', 'd4'], title: '  ' });
  assert.strictEqual(r400t.status, 400);
});
