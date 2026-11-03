'use strict';

/**
 * task-linkage.test.js — v1.9 任务叙事线第一批：任务更新提案（Q1）+ Gitea 成果手动挂接（Q3-L1）
 * 覆盖：taskUpdates 解析（DSH_FIXTURE 全链路 + coerceResult 合计截断单测）、
 *       update 候选确认 → memo 事件 + origin.relatedMemos 追加（origin 缺失创建 / 已有追加）、
 *       existingTaskId 失效 400 TASK_NOT_FOUND、done-already 对 update 候选 409 NOT_APPLICABLE、
 *       统计口径不变（update 确认计入 confirmed30d）、
 *       artifacts 挂接/解除/校验/事件/updatedAt、存量任务与存量候选无新字段容错、
 *       v2.3 D3 kind=session 会话挂接（sessionRef/title 必填校验、url 置 null、事件 detail 截断）。
 * 运行：node --test test/task-linkage.test.js（DINGTALK_FIXTURE + DSH_FIXTURE 全离线）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7802; // 仅作 fixture 配置留痕（进程内装配不再监听端口）
const FIX = (f) => path.join(__dirname, 'fixtures', f);

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

async function waitJob(jobId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const r = await api('GET', `/api/radar/jobs/${jobId}`);
    if (r.status === 200 && r.body.state !== 'running') return r.body;
    await sleep(120);
  }
  throw new Error('job 未在 20s 内完成');
}

function diskTasks() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8')).tasks;
}

function diskEvents() {
  const file = path.join(dataDir, 'task_events.json');
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : raw.events || [];
}

/** 直接落盘造一个 pending 更新提案（失败路径用例：目标任务已删后的确认/处置语义） */
function craftUpdateCandidate(existingTaskId) {
  const file = path.join(dataDir, 'inbox.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const candidates = Array.isArray(raw) ? raw : raw.candidates;
  candidates.push({
    id: 'cand-craft-gone1',
    kind: 'update',
    messageId: 'm-craft-1',
    messageTitle: '周五碰头会',
    occurredAt: '2026-10-17T00:00:00.000Z',
    existingTaskId,
    quote: 'SSO 又被提了一嘴',
    note: '手工造的失效提案',
    confidence: 0.8,
    speakerRaw: '',
    state: 'pending',
    decidedAt: null,
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(file, JSON.stringify({ candidates }, null, 2) + '\n');
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-link-'));
  dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({ port: PORT, host: '127.0.0.1', dataDir, webDir: path.join(tmpDir, 'web'), gitea: { pollIntervalSec: 0 } })
  );
  fs.writeFileSync(
    path.join(tmpDir, 'members.json'),
    JSON.stringify({ members: [
      { id: 'wang.jianguo', name: '王建国', role: '', giteaLogin: '', enabled: true },
      { id: 'li.lei', name: '李雷', role: '', giteaLogin: '', enabled: true },
    ] })
  );
  // 预置看板（存量形态）：t-seed-sso-0001 无 artifacts/无 origin（老任务容错）；
  // t-seed-diary-0002 带 origin 但无 relatedMemos（relatedMemos 字段容错）
  fs.writeFileSync(
    path.join(dataDir, 'tasks.json'),
    JSON.stringify({
      columns: [
        { id: 'todo', name: '待分配', order: 1 },
        { id: 'doing', name: '进行中', order: 2 },
        { id: 'review', name: '待验证', order: 3 },
        { id: 'done', name: '已完成', order: 4 },
      ],
      tasks: [
        { id: 't-seed-sso-0001', title: '接入 SSO', status: 'doing', createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z' },
        { id: 't-seed-diary-0002', title: '周报自动化', status: 'todo', createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z', origin: { type: 'inbox', refId: 'cand-legacy', quote: '旧来源引用' } },
      ],
    })
  );
  // DINGTALK/DSH_FIXTURE 经 persistentEnv 注入——雷达 job 在响应之后异步执行并读 env（close 还原）
  app = buildApp({
    configPath: path.join(tmpDir, 'config.json'),
    env: { DINGTALK_FIXTURE: FIX('dingtalk.json'), DSH_FIXTURE: FIX('dsh-taskupdates.txt') },
    persistentEnv: true,
  });
});

test.after(() => {
  if (app) app.close();
});

// ---------- Q1：taskUpdates 提案解析（fixture 全链路） ----------

let updateU1 = null; // 周三需求对齐会产出的更新提案
let taskT1 = null;   // 同会话产出的新任务候选（两类卡共存）

test('同步 fixture：2 条纪要入池', async () => {
  const r = await api('POST', '/api/radar/sync', {});
  assert.strictEqual(r.status, 202);
  const job = await waitJob(r.body.jobId);
  assert.strictEqual(job.results[0].added, 2);
  const list = await api('GET', '/api/radar/messages');
  assert.strictEqual(list.body.length, 2);
});

test('分析产出更新提案：kind:update 候选带 existingTaskId/quote/note，与任务候选共存；<0.5 提案进 noise', async () => {
  const list = await api('GET', '/api/radar/messages');
  const target = list.body.find((m) => m.title === '周三需求对齐会');
  const r = await api('POST', '/api/radar/analyze', { messageIds: [target.id] });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.body.accepted, 1);
  const job = await waitJob(r.body.jobId);
  assert.strictEqual(job.state, 'done');
  assert.strictEqual(job.results[0].added, 2, '1 任务候选 + 1 更新提案（0.3 提案不产出）');

  const pend = await api('GET', '/api/inbox?state=pending');
  assert.strictEqual(pend.body.length, 2);
  updateU1 = pend.body.find((c) => c.kind === 'update');
  taskT1 = pend.body.find((c) => c.kind === 'task');
  assert.ok(updateU1 && taskT1, '两类候选卡都在，且 kind 字段显式');

  // 更新提案字段
  assert.strictEqual(updateU1.existingTaskId, 't-seed-sso-0001');
  assert.strictEqual(updateU1.quote, 'SSO 这块周五前要上线，小王你来跟进部署文档。');
  assert.match(updateU1.note, /SSO 定于周五上线/);
  assert.strictEqual(updateU1.confidence, 0.8);
  assert.strictEqual(updateU1.messageTitle, '周三需求对齐会');
  assert.strictEqual(updateU1.speakerRaw, '建国', 'quote 反查说话人照常工作');
  assert.strictEqual(updateU1.state, 'pending');
  assert.strictEqual(taskT1.title, '测试环境搭建方案');

  // <0.5 的更新提案不产出候选，进消息 noise 留痕（与任务候选同一置信度闸门）
  const det = await api('GET', `/api/radar/messages/${encodeURIComponent(target.id)}`);
  const noiseReasons = JSON.stringify(det.body.noise || []);
  assert.match(noiseReasons, /低置信度 0.3，不产出更新提案/);
});

// ---------- Q1：确认语义 ----------

test('确认更新提案：不建任务，memo 事件 + origin.relatedMemos 创建（origin 缺失的存量任务）', async () => {
  const before = diskTasks().length;
  const r = await api('POST', `/api/inbox/${encodeURIComponent(updateU1.id)}/confirm`, {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.task.id, 't-seed-sso-0001', '响应 task = 关联任务本身（非新建）');
  assert.strictEqual(r.body.candidate.state, 'confirmed');
  assert.strictEqual(r.body.candidate.confirmedTaskId, 't-seed-sso-0001');
  assert.strictEqual(diskTasks().length, before, '不建任务');

  // 时间轴 memo 节点
  const det = await api('GET', '/api/tasks/t-seed-sso-0001');
  const memo = det.body.events.find((e) => e.type === 'memo');
  assert.ok(memo, '事件流出现 memo 节点');
  assert.strictEqual(memo.detail, '纪要《周三需求对齐会》：SSO 这块周五前要上线，小王你来跟进部署文档。');
  assert.strictEqual(memo.from, null);
  assert.strictEqual(memo.to, null);

  // 磁盘 origin：老任务原本无 origin → 兜底创建，relatedMemos 落 1 条
  const onDisk = diskTasks().find((t) => t.id === 't-seed-sso-0001');
  assert.deepStrictEqual(onDisk.origin.type, 'inbox');
  assert.strictEqual(onDisk.origin.quote, '', '兜底 origin 的 quote 为空串');
  assert.strictEqual(onDisk.origin.refId, updateU1.messageId, '兜底 origin.refId = 候选的 messageId');
  assert.strictEqual(onDisk.origin.relatedMemos.length, 1);
  const memoRec = onDisk.origin.relatedMemos[0];
  assert.strictEqual(memoRec.refId, updateU1.messageId);
  assert.strictEqual(memoRec.title, '周三需求对齐会');
  assert.strictEqual(memoRec.quote, 'SSO 这块周五前要上线，小王你来跟进部署文档。');
  assert.match(memoRec.at, /^\d{4}-\d{2}-\d{2}T/);
  // 不改任务业务字段
  assert.strictEqual(onDisk.title, '接入 SSO');
  assert.strictEqual(onDisk.status, 'doing');
});

test('确认任务候选（回归）：照常建任务，新任务带 artifacts 空数组', async () => {
  const r = await api('POST', `/api/inbox/${encodeURIComponent(taskT1.id)}/confirm`, { memberId: 'li.lei' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.task.title, '测试环境搭建方案');
  assert.deepStrictEqual(r.body.task.artifacts, [], '收件箱建的任务同样带 artifacts:[]');
});

test('二次确认更新提案（origin 已存在）：relatedMemos 追加为 2 条', async () => {
  const list = await api('GET', '/api/radar/messages');
  const target = list.body.find((m) => m.title === 'SSO 技术评审');
  const r = await api('POST', '/api/radar/analyze', { messageIds: [target.id] });
  assert.strictEqual(r.status, 202);
  const job = await waitJob(r.body.jobId);
  assert.strictEqual(job.results[0].added, 2);
  const pend = await api('GET', '/api/inbox?state=pending');
  const u2 = pend.body.find((c) => c.kind === 'update');
  assert.ok(u2, '第二条纪要同样产出更新提案（静态 fixture，按消息隔离去重）');

  const r2 = await api('POST', `/api/inbox/${encodeURIComponent(u2.id)}/confirm`, {});
  assert.strictEqual(r2.status, 200);
  const onDisk = diskTasks().find((t) => t.id === 't-seed-sso-0001');
  assert.strictEqual(onDisk.origin.relatedMemos.length, 2, '已有 origin 上追加，不重建不覆盖');
  assert.deepStrictEqual(
    onDisk.origin.relatedMemos.map((m) => m.title),
    ['周三需求对齐会', 'SSO 技术评审'],
    '任务 × 听记 N:N 关联'
  );
});

// ---------- Q1：失效目标任务与处置闸门 ----------

test('existingTaskId 失效：确认 400 TASK_NOT_FOUND 且候选保持待决；done-already 409 NOT_APPLICABLE', async () => {
  // 真·全链路失效：提案产出于任务在盘时，随后任务被删
  const del = await api('DELETE', '/api/tasks/t-seed-sso-0001');
  assert.strictEqual(del.status, 204);

  craftUpdateCandidate('t-seed-sso-0001'); // 失效目标任务上的 pending 提案
  const pend = await api('GET', '/api/inbox?state=pending');
  const gone = pend.body.find((c) => c.id === 'cand-craft-gone1');
  assert.ok(gone, '手工落盘的失效提案可见');

  const done = await api('POST', `/api/inbox/cand-craft-gone1/done-already`, { note: '试试图已完成' });
  assert.strictEqual(done.status, 409);
  assert.strictEqual(done.body.error.code, 'NOT_APPLICABLE');

  const conf = await api('POST', `/api/inbox/cand-craft-gone1/confirm`, {});
  assert.strictEqual(conf.status, 400);
  assert.strictEqual(conf.body.error.code, 'TASK_NOT_FOUND');
  const after = (await api('GET', '/api/inbox?state=pending')).body.find((c) => c.id === 'cand-craft-gone1');
  assert.ok(after, '400 后候选保持待决（不产生半截状态）');

  // 拒绝闸门对更新提案照常开放（与任务候选同规则）
  const rej = await api('POST', `/api/inbox/cand-craft-gone1/reject`, { reason: 'duplicate' });
  assert.strictEqual(rej.status, 200);
  assert.strictEqual(rej.body.state, 'rejected');

  // 清掉残余任务候选 T2（拒绝路径对任务候选不回归即可）
  const rest = await api('GET', '/api/inbox?state=pending');
  for (const c of rest.body) {
    const r = await api('POST', `/api/inbox/${encodeURIComponent(c.id)}/reject`, { reason: 'wont_do' });
    assert.strictEqual(r.status, 200);
  }
});

test('统计口径不变：更新提案确认计入 confirmed/confirmed30d，拒绝照常进分母', async () => {
  const s = await api('GET', '/api/inbox/stats');
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.confirmed, 3, '2 更新提案 + 1 任务候选');
  assert.strictEqual(s.body.rejected, 2, '1 失效提案 + 1 任务候选');
  assert.strictEqual(s.body.pending, 0);
  assert.strictEqual(s.body.doneAlready, 0);
  assert.strictEqual(s.body.confirmed30d, 3, 'update 确认算「已采纳」');
  assert.strictEqual(s.body.rejected30d, 2);
  assert.strictEqual(s.body.rejectRate30d, 0.4, '2/(3+0+2)，口径未被更新提案扰动');
});

// ---------- Q3-L1：artifacts 挂接 / 解除 / 校验 / 事件 ----------

let artifactTaskId = null;

test('挂接成果：201 追加 + artifact 事件 + updatedAt 刷新；列表与详情自然带出', async () => {
  const created = await api('POST', '/api/tasks', { title: '挂接样板任务' });
  artifactTaskId = created.body.id;
  assert.deepStrictEqual(created.body.artifacts, [], '新任务 artifacts 以空数组起');

  const before = (await api('GET', `/api/tasks/${artifactTaskId}`)).body.updatedAt;
  await sleep(15);
  const r = await api('POST', `/api/tasks/${artifactTaskId}/artifacts`, {
    url: 'https://gitea.example.com/example-org/fde-harness/commit/9abc123',
    kind: 'commit',
    repo: 'fde-harness',
    ref: '9abc123',
  });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(r.body, {
    url: 'https://gitea.example.com/example-org/fde-harness/commit/9abc123',
    kind: 'commit',
    repo: 'fde-harness',
    ref: '9abc123',
    at: r.body.at,
  });

  const det = await api('GET', `/api/tasks/${artifactTaskId}`);
  assert.strictEqual(det.body.artifacts.length, 1, '详情带出 artifacts');
  assert.strictEqual(det.body.updatedAt > before, true, 'updatedAt 刷新');
  const ev = det.body.events[0];
  assert.strictEqual(ev.type, 'artifact', '事件流出现 artifact 节点');
  assert.strictEqual(ev.detail, '挂接成果：commit fde-harness');

  // 无 repo/ref 的 PR：detail 不留空洞
  const r2 = await api('POST', `/api/tasks/${artifactTaskId}/artifacts`, {
    url: 'https://gitea.example.com/example-org/web/pulls/12',
    kind: 'pr',
  });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.body.repo, null);
  assert.strictEqual(r2.body.ref, null);
  const det2 = await api('GET', `/api/tasks/${artifactTaskId}`);
  assert.strictEqual(det2.body.events[0].detail, '挂接成果：pr');

  // 列表自然带出
  const list = await api('GET', '/api/tasks');
  const item = list.body.find((t) => t.id === artifactTaskId);
  assert.strictEqual(item.artifacts.length, 2);
  // 磁盘落盘形态（随 tasks.json 读写）
  const onDisk = diskTasks().find((t) => t.id === artifactTaskId);
  assert.strictEqual(onDisk.artifacts.length, 2);
});

test('挂接校验：缺 url/伪协议/非 http(s)/坏 kind/坏 repo → 400 FIELD_INVALID；任务不存在 404', async () => {
  const bad = async (body) => api('POST', `/api/tasks/${artifactTaskId}/artifacts`, body);
  assert.strictEqual((await bad({ kind: 'commit' })).status, 400, '缺 url');
  assert.strictEqual((await bad({ url: 'javascript:alert(1)', kind: 'commit' })).status, 400, '伪协议');
  assert.strictEqual((await bad({ url: 'ftp://gitea.example.com/x', kind: 'commit' })).status, 400, '非 http(s)');
  assert.strictEqual((await bad({ url: 'https://gitea.example.com/x', kind: 'note' })).status, 400, 'kind 枚举外');
  assert.strictEqual((await bad({ url: 'https://gitea.example.com/x' })).status, 400, '缺 kind');
  assert.strictEqual((await bad({ url: 'https://gitea.example.com/x', kind: 'pr', repo: 42 })).status, 400, 'repo 非字符串');
  assert.strictEqual((await bad({ url: 'https://gitea.example.com/x', kind: 'pr', ref: 'x'.repeat(201) })).status, 400, 'ref 超长');
  const missing = await api('POST', '/api/tasks/t-no-such/artifacts', { url: 'https://gitea.example.com/x', kind: 'pr' });
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.body.error.code, 'TASK_NOT_FOUND');
  // 校验失败不产生半截状态
  const det = await api('GET', `/api/tasks/${artifactTaskId}`);
  assert.strictEqual(det.body.artifacts.length, 2);
});

test('解除挂接：204 按下标移除、不记事件；越界/非法下标/任务不存在 404', async () => {
  const evBefore = (await api('GET', `/api/tasks/${artifactTaskId}`)).body.events.length;
  const del = await api('DELETE', `/api/tasks/${artifactTaskId}/artifacts/0`);
  assert.strictEqual(del.status, 204);
  const det = await api('GET', `/api/tasks/${artifactTaskId}`);
  assert.strictEqual(det.body.artifacts.length, 1, 'commit 被移除');
  assert.strictEqual(det.body.artifacts[0].kind, 'pr', '剩下的是 pr');
  assert.strictEqual(det.body.events.length, evBefore, '解除不记事件（列表即真相）');

  assert.strictEqual((await api('DELETE', `/api/tasks/${artifactTaskId}/artifacts/5`)).status, 404, '越界');
  assert.strictEqual((await api('DELETE', `/api/tasks/${artifactTaskId}/artifacts/abc`)).status, 404, '非法下标');
  assert.strictEqual((await api('DELETE', `/api/tasks/${artifactTaskId}/artifacts/-1`)).status, 404, '负下标');
  const goneTask = await api('DELETE', '/api/tasks/t-no-such/artifacts/0');
  assert.strictEqual(goneTask.status, 404);
  assert.strictEqual(goneTask.body.error.code, 'TASK_NOT_FOUND');
});

test('存量任务无 artifacts 字段容错：详情自然缺省、首次挂接时初始化', async () => {
  const det = await api('GET', '/api/tasks/t-seed-diary-0002');
  assert.strictEqual(det.status, 200);
  assert.strictEqual(det.body.artifacts, undefined, '存量字段不动，自然缺省（不回填）');

  const r = await api('POST', '/api/tasks/t-seed-diary-0002/artifacts', {
    url: 'https://gitea.example.com/example-org/diary/pulls/7',
    kind: 'pr',
    repo: 'diary',
  });
  assert.strictEqual(r.status, 201, '首次挂接在存量任务上初始化 artifacts');
  const det2 = await api('GET', '/api/tasks/t-seed-diary-0002');
  assert.strictEqual(det2.body.artifacts.length, 1);
  assert.strictEqual(det2.body.events[0].detail, '挂接成果：pr diary');
});

// ---------- v2.3 D3（SMOKE v2.3 回归 P0-A）：kind=session 会话挂接 ----------

const sessionRefMod = require('../lib/sessionRef');

test('挂接会话成果：sessionRef+title 无 url → 201，url/repo/ref 置 null 落库，事件 detail 取 title 前 40 字', async () => {
  const ref = sessionRefMod.encodeRef({
    s: 'zcode',
    k: 'session',
    v: { id: 'sess_0123456789abcdef0123456789abcdef' },
  });
  const before = (await api('GET', `/api/tasks/${artifactTaskId}`)).body.updatedAt;
  await sleep(15);
  const title45 = '字'.repeat(45); // >40 字：验证 detail 截断
  const r = await api('POST', `/api/tasks/${artifactTaskId}/artifacts`, {
    kind: 'session',
    sessionRef: ref,
    title: title45,
  });
  assert.strictEqual(r.status, 201, 'kind=session 无 url 可挂接（D3 契约，回归 P0-A 本体）');
  assert.deepStrictEqual(r.body, {
    url: null,
    kind: 'session',
    repo: null,
    ref: null,
    sessionRef: ref,
    title: title45,
    at: r.body.at,
  });

  const det = await api('GET', `/api/tasks/${artifactTaskId}`);
  const art = det.body.artifacts.find((a) => a.kind === 'session');
  assert.ok(art, '详情带出 session 成果');
  assert.strictEqual(art.url, null, 'url 不入库置 null');
  assert.strictEqual(art.sessionRef, ref);
  assert.strictEqual(det.body.updatedAt > before, true, 'updatedAt 刷新');
  const ev = det.body.events[0];
  assert.strictEqual(ev.type, 'artifact');
  assert.strictEqual(ev.detail, `挂接成果：session ${title45.slice(0, 40)}`, 'detail = title 前 40 字');

  // 落盘形态：session 成果随 tasks.json 持久化（url 保持 null）
  const onDisk = diskTasks().find((t) => t.id === artifactTaskId);
  const diskArt = onDisk.artifacts.find((a) => a.kind === 'session');
  assert.strictEqual(diskArt.url, null);
  assert.strictEqual(diskArt.sessionRef, ref);

  // 多带 url 提交同样 url 不入库（字段语义按 kind 切换，不双存）
  const r2 = await api('POST', `/api/tasks/${artifactTaskId}/artifacts`, {
    kind: 'session',
    sessionRef: sessionRefMod.encodeRef({ s: 'opencode', k: 'session', v: { id: 'ses_ABCDEFGHIJKLMNOPQRSTUVWX' } }),
    title: '评审会话',
    url: 'https://gitea.example.com/x',
  });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.body.url, null, 'url 带了也不入库');
  assert.strictEqual(r2.body.title, '评审会话');
});

test('挂接会话成果校验：缺 sessionRef/超 512/坏 ref/穿越 ref/缺空超 title → 400；校验失败零落盘', async () => {
  const ref = sessionRefMod.encodeRef({ s: 'zcode', k: 'session', v: { id: 'sess_fedcba9876543210fedcba98' } });
  const bad = async (body) => api('POST', `/api/tasks/${artifactTaskId}/artifacts`, body);

  const noRef = await bad({ kind: 'session', title: '无 ref' });
  assert.strictEqual(noRef.status, 400, '反例：无 sessionRef');
  assert.strictEqual(noRef.body.error.code, 'FIELD_INVALID');

  assert.strictEqual((await bad({ kind: 'session', sessionRef: 'x'.repeat(513), title: 't' })).status, 400, 'sessionRef 超 512');

  const badRef = await bad({ kind: 'session', sessionRef: 'not-a-ref', title: 't' });
  assert.strictEqual(badRef.status, 400, '坏 ref（非 base64url JSON）');
  assert.strictEqual(badRef.body.error.code, 'BAD_REF', '坏 ref 走 sessionRef §3.3 校验闸');

  const traversal = await bad({
    kind: 'session',
    sessionRef: sessionRefMod.encodeRef({ s: 'dsh', k: 'file', v: { path: '../../etc/passwd.jsonl' } }),
    title: 't',
  });
  assert.strictEqual(traversal.status, 400, '路径穿越 ref 拒绝');
  assert.strictEqual(traversal.body.error.code, 'BAD_REF');

  assert.strictEqual((await bad({ kind: 'session', sessionRef: ref })).status, 400, '缺 title');
  assert.strictEqual((await bad({ kind: 'session', sessionRef: ref, title: '   ' })).status, 400, '空白 title');
  assert.strictEqual((await bad({ kind: 'session', sessionRef: ref, title: 'x'.repeat(201) })).status, 400, 'title 超 200');

  // 校验失败零落盘：session 成果仍只有此前正例挂上的 2 条
  const det = await api('GET', `/api/tasks/${artifactTaskId}`);
  assert.strictEqual(det.body.artifacts.filter((a) => a.kind === 'session').length, 2, '校验失败零落盘');
});

// ---------- 模块级单测（无服务） ----------

const analyze = require('../lib/analyze.js');

const ROSTER = [
  { id: 'wang.jianguo', name: '王建国', aliases: ['建国'] },
  { id: 'li.lei', name: '李雷', aliases: [] },
];

test('coerceResult：taskUpdates 钳制/裁剪/无 existingTaskId 丢弃；无 taskUpdates 输入回退空数组', () => {
  const out = analyze.coerceResult(
    {
      tasks: [{ title: 'T', confidence: 0.9 }],
      taskUpdates: [
        { existingTaskId: 't-1', quote: 'q', note: 'n', confidence: 1.7 },
        { existingTaskId: '  t-2  ', quote: 'q2', note: 'n2', confidence: -1 },
        { quote: '没有目标 id', confidence: 0.9 },
        'garbage',
      ],
      noise: [],
    },
    ROSTER,
    {}
  );
  assert.strictEqual(out.taskUpdates.length, 2, '无 existingTaskId / 非对象条目丢弃');
  assert.strictEqual(out.taskUpdates[0].confidence, 1, '置信度钳到 1');
  assert.strictEqual(out.taskUpdates[1].confidence, 0, '置信度钳到 0');
  assert.strictEqual(out.taskUpdates[1].existingTaskId, 't-2', 'id 去空白');
  assert.strictEqual(out.tasks.length, 1);

  const legacy = analyze.coerceResult({ tasks: [{ title: '旧输出', confidence: 0.8 }] }, ROSTER, {});
  assert.deepStrictEqual(legacy.taskUpdates, [], '旧引擎输出（无 taskUpdates 键）回退空数组');
});

test('coerceResult：tasks+taskUpdates 合计 ≤ 上限，按置信度合并截断', () => {
  const tasks = Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, confidence: 0.95 - i * 0.05 }));
  const taskUpdates = Array.from({ length: 6 }, (_, i) => ({
    existingTaskId: `t-${i}`,
    quote: 'q',
    note: 'n',
    confidence: 0.96 - i * 0.05,
  }));
  const out = analyze.coerceResult({ tasks, taskUpdates, noise: [] }, ROSTER, {});
  assert.strictEqual(out.tasks.length + out.taskUpdates.length, 10, '合计恰为上限 10');
  assert.strictEqual(out.taskUpdates[0].confidence, 0.96, '全局最高分是更新提案，截断后保留');
  assert.ok(out.tasks.every((t, i, a) => i === 0 || a[i - 1].confidence >= t.confidence), 'tasks 仍降序');
  assert.ok(
    out.taskUpdates.every((u, i, a) => i === 0 || a[i - 1].confidence >= u.confidence),
    'taskUpdates 仍降序'
  );
  assert.ok(out.tasks.every((t) => t.confidence >= 0.71), '被截掉的是各类尾部低分项');
});

test('buildPrompt：schema/规则/正反例含 taskUpdates，看板行带任务 id', () => {
  const prompt = analyze.buildPrompt(
    { title: 't', speakerSegments: [] },
    ROSTER,
    [{ id: 't-9', status: 'doing', title: '接入 SSO' }],
    {}
  );
  assert.match(prompt, /"taskUpdates":\[\{"existingTaskId"/, 'schema 含 taskUpdates');
  assert.match(prompt, /tasks 与 taskUpdates 合计最多 10 条/, '合计上限写进规则');
  assert.match(prompt, /- t-9 \| \[doing\] 接入 SSO/, '看板清单带任务 id（existingTaskId 参考）');
  assert.match(prompt, /跟进讨论.*taskUpdate ✓/, '正例：跟进讨论产更新提案');
  assert.match(prompt, /顺带提了一句旧任务名.*✗/, '反例：顺带提名不产');
  assert.match(prompt, /查重分诊/);
});

test('applyAnalysis：update 结果落 kind:update 候选，同批重复提案去重', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-link-mod-'));
  const ctx = {
    config: { analyze: {} },
    membersPath: path.join(dir, 'members.json'),
    giteaMembersPath: '',
    inboxPath: path.join(dir, 'inbox.json'),
    messagesPath: path.join(dir, 'messages.json'),
  };
  const message = { id: 'm1', title: '纪要A', occurredAt: '2026-10-17T00:00:00.000Z', speakerSegments: [] };
  const result = {
    tasks: [],
    taskUpdates: [
      { existingTaskId: 't-1', quote: '同一句引用', note: 'n', confidence: 0.8 },
      { existingTaskId: 't-1', quote: '同一句引用', note: 'n', confidence: 0.8 },
    ],
    noise: [],
  };
  const added = analyze.applyAnalysis(ctx, message, result);
  assert.strictEqual(added, 1, '同批重复提案按 引用+目标任务 去重');
  const inbox = JSON.parse(fs.readFileSync(ctx.inboxPath, 'utf8'));
  const candidates = Array.isArray(inbox) ? inbox : inbox.candidates;
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].kind, 'update');
  assert.strictEqual(candidates[0].existingTaskId, 't-1');
  assert.ok(!('title' in candidates[0]) || candidates[0].title === undefined, '更新提案无任务标题字段');
});
