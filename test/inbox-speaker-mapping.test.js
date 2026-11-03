'use strict';

/**
 * inbox-speaker-mapping.test.js — v1.7 修订「记住映射」语义解耦的回归
 * 缺陷（业主真实使用中踩中）：confirm 带 rememberAlias 时把候选 speakerRaw（说话人昵称）
 * 写到 memberId（任务负责人）名下——负责人 ≠ 说话人（李四说的任务派给张三做，
 * 「李四（硅谷）」被错挂到张三名下）。
 * 修复契约：
 *   ①confirm 请求体新增可选 speakerMemberId（string|null，≤64 字符）= 说话人身份映射目标；
 *   ②rememberAlias:true 时别名写到 speakerMemberId 名下（沿用 resolveAliasTarget 自动建档）；
 *     speakerMemberId 为空 → 不写任何别名，rememberedAlias:null + reason:'SPEAKER_UNRESOLVED'；
 *   ③旧客户端只传 memberId+rememberAlias → 同上不写别名（宁可不学，不可错学）；
 *   ④负责人与说话人不同人时 memberId 名下零污染。
 * 运行：node --test test/inbox-speaker-mapping.test.js（DINGTALK_FIXTURE + DSH_FIXTURE 全离线；
 * 端口运行期随机选取 + 启动重试，避免全量并发/残留监听下的端口冲突）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildApp } = require('./helpers/appAssembler');

let app;
let tmpDir;
let membersPath;
let dshFixturePath;
let dingtalkFixturePath;

// WP3：真端口 spawn（随机端口 + 陈旧孤儿重试）→ 装配器进程内分发——无端口即无撞端口问题，
// 原「新鲜度校验 ×3 重试」的前提（多 server 抢端口）随之消失，断言零改动。
// DINGTALK/DSH_FIXTURE 经 persistentEnv 注入——雷达 job 在响应之后异步执行并读 env（close 还原）。
async function api(method, p, body) {
  return app.fetch(method, p, {
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function waitJob(jobId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const r = await api('GET', `/api/radar/jobs/${jobId}`);
    if (r.status === 200 && r.body.state !== 'running') return r.body;
    await new Promise((res) => setTimeout(res, 120));
  }
  throw new Error('job 未在 20s 内完成');
}

function diskMembers() {
  return JSON.parse(fs.readFileSync(membersPath, 'utf8')).members;
}

/** 别名污染断言基线：owner 无别名、李四仅「李四（硅谷）」、李思琪仅「李思琪」 */
function assertNoOwnerPollution() {
  const ms = diskMembers();
  const owner = ms.find((m) => m.id === 'zhangsan');
  assert.ok(owner, '负责人条目存在');
  assert.ok(!Array.isArray(owner.aliases) || owner.aliases.length === 0,
    `负责人张三名下零别名污染：${JSON.stringify(owner.aliases)}`);
  const zq = ms.find((m) => m.id === 'lisi');
  assert.deepStrictEqual(zq.aliases, ['李四（硅谷）'], '李四名下仅有本人昵称别名');
  const lsq = ms.find((m) => m.id === 'lisiqi');
  assert.ok(!lsq || lsq.aliases.filter((a) => a === '李思琪').length === 1,
    '派生成员（若已建档）名下仅有本人昵称别名');
}

const DSH_GOOD = JSON.stringify({
  tasks: [
    {
      title: '更新部署文档', desc: '', priority: 'high', suggestedMemberId: 'zhangsan', dueHint: '今天',
      confidence: 0.9, quote: '部署文档今天要更新一下', rationale: '明确动作+负责人（李四说的任务派给张三）',
    },
    {
      title: 'SSO 周五前上线', desc: '', priority: 'high', suggestedMemberId: 'lisiqi', dueHint: '周五',
      confidence: 0.85, quote: 'SSO 这块周五前要上线', rationale: '明确动作+负责人（Gitea 派生成员）+时间',
    },
    {
      title: '整理评审纪要', desc: '', priority: 'medium', suggestedMemberId: 'zhangsan', dueHint: '',
      confidence: 0.8, quote: '评审纪要会后整理好发出来', rationale: '明确动作',
    },
    {
      title: '清理测试环境', desc: '', priority: 'low', suggestedMemberId: 'zhangsan', dueHint: '周五',
      confidence: 0.75, quote: '测试环境周五前清理完毕', rationale: '明确动作+时间',
    },
    {
      title: '归档会议材料', desc: '', priority: 'low', suggestedMemberId: 'zhangsan', dueHint: '',
      confidence: 0.7, quote: '会议材料会后归档到共享盘', rationale: '明确动作',
    },
  ],
  noise: [],
});

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-inbox-speaker-'));
  const dataDir = path.join(tmpDir, 'data');
  membersPath = path.join(tmpDir, 'members.json');
  const fixDir = path.join(tmpDir, 'fixtures');
  fs.mkdirSync(fixDir);
  dshFixturePath = path.join(fixDir, 'dsh-out.txt');
  dingtalkFixturePath = path.join(fixDir, 'dingtalk.json');
  fs.writeFileSync(dshFixturePath, DSH_GOOD, 'utf8');
  fs.writeFileSync(dingtalkFixturePath, JSON.stringify({
    list: {
      minutes: [{
        taskUuid: 'cccc3333dddd',
        title: '解耦验收会',
        startTime: 1792140000000,
        endTime: 1792143600000,
        status: 4,
        url: 'https://shanji.dingtalk.com/app/transcribes/cccc3333dddd',
      }],
    },
    transcripts: {
      cccc3333dddd: {
        complete: true,
        paragraphList: [
          { paragraph: '部署文档今天要更新一下', nickName: '李四（硅谷）', gmtCreate: 1792140000000 },
          { paragraph: 'SSO 这块周五前要上线', nickName: '李思琪', gmtCreate: 1792140060000 },
          { paragraph: '评审纪要会后整理好发出来', nickName: '李四（硅谷）', gmtCreate: 1792140120000 },
          { paragraph: '测试环境周五前清理完毕', nickName: '李四（硅谷）', gmtCreate: 1792140180000 },
          { paragraph: '会议材料会后归档到共享盘', nickName: '李四（硅谷）', gmtCreate: 1792140240000 },
        ],
      },
    },
  }), 'utf8');
  // 名册复刻业主真实场景：负责人张三 + 说话人李四（手工成员，无预置别名）；
  // 李思琪仅存在于 Gitea 成员缓存（派生成员自动建档用例的前提）
  fs.writeFileSync(membersPath, JSON.stringify({ members: [
    { id: 'zhangsan', name: '张三', role: '', giteaLogin: 'zhangsan', aliases: [], enabled: true },
    { id: 'lisi', name: '李四', role: '', giteaLogin: 'lisi', aliases: [], enabled: true },
  ] }));
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'gitea-members.json'), JSON.stringify([
    { login: 'lisiqi', full_name: '李思琪', name: '' },
  ]));

  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    port: 27777, // 进程内装配不监听，端口仅作 fixture 留痕（装配校验要求 1..65535）
    host: '127.0.0.1',
    dataDir: 'data',
    webDir: 'web',
    gitea: { pollIntervalSec: 0 },
  }));
  app = buildApp({
    configPath: path.join(tmpDir, 'config.json'),
    env: {
      DINGTALK_FIXTURE: dingtalkFixturePath,
      DSH_FIXTURE: dshFixturePath,
    },
    persistentEnv: true,
  });
  const fresh = await app.fetch('GET', '/api/inbox');
  if (!fresh.ok || !Array.isArray(fresh.body)) throw new Error('app 未就绪或 inbox 视图异常');
});

test.after(() => {
  if (app) app.close();
});

// ---------- 产候选：说话人与负责人不同人 ----------

let cands = null;

test('同步 + 分析：5 条候选，speakerRaw 各就各位（说话人=李四（硅谷）/李思琪）', async () => {
  const s = await api('POST', '/api/radar/sync', {});
  const syncJob = await waitJob(s.body.jobId);
  assert.strictEqual(syncJob.state, 'done');
  assert.strictEqual(syncJob.results[0].added, 1);

  const list = await api('GET', '/api/radar/messages');
  const target = list.body.find((m) => m.title === '解耦验收会');
  const r = await api('POST', '/api/radar/analyze', { messageIds: [target.id] });
  assert.strictEqual(r.status, 202);
  const job = await waitJob(r.body.jobId);
  assert.strictEqual(job.state, 'done');
  assert.ok(job.results.every((x) => x.ok), JSON.stringify(job.results));

  const inbox = await api('GET', '/api/inbox?state=pending');
  assert.strictEqual(inbox.status, 200);
  assert.strictEqual(inbox.body.length, 5);
  cands = {};
  for (const c of inbox.body) cands[c.title] = c;
  assert.strictEqual(cands['更新部署文档'].speakerRaw, '李四（硅谷）', '负责人候选的说话人仍是李四');
  assert.strictEqual(cands['整理评审纪要'].speakerRaw, '李四（硅谷）');
  assert.strictEqual(cands['清理测试环境'].speakerRaw, '李四（硅谷）');
  assert.strictEqual(cands['SSO 周五前上线'].speakerRaw, '李思琪');
  // 真实场景复刻：李四说的任务 AI 建议派给张三
  assert.strictEqual(cands['更新部署文档'].suggestedMemberId, 'zhangsan');
});

// ---------- ①核心修复：speakerMemberId 指向手工成员，别名与负责人解耦 ----------

test('①负责人=张三、说话人=李四（硅谷）、speakerMemberId=李四 → 别名到李四名下，张三零污染', async () => {
  const cand = cands['更新部署文档'];
  const r = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/confirm`, {
    memberId: 'zhangsan',
    speakerMemberId: 'lisi',
    rememberAlias: true,
  });
  assert.strictEqual(r.status, 200);
  // 任务负责人正确
  assert.strictEqual(r.body.task.memberId, 'zhangsan');
  assert.strictEqual(r.body.task.origin.type, 'inbox');
  // rememberedAlias 形状：memberId = 映射目标（说话人），非任务负责人
  assert.deepStrictEqual(
    r.body.rememberedAlias,
    { memberId: 'lisi', alias: '李四（硅谷）', memberCreated: false },
    '别名落点 = speakerMemberId'
  );
  // 磁盘落点：李四有别名，张三名下无任何别名
  const ms = diskMembers();
  assert.deepStrictEqual(
    ms.find((m) => m.id === 'lisi').aliases,
    ['李四（硅谷）'],
    '别名「李四（硅谷）」写到李四名下'
  );
  const owner = ms.find((m) => m.id === 'zhangsan');
  assert.ok(!Array.isArray(owner.aliases) || owner.aliases.length === 0,
    `负责人张三名下不得出现别名（错学即本缺陷）：${JSON.stringify(owner.aliases)}`);
  assert.ok(!('reason' in r.body), '成功写别名时无 reason 字段');
});

// ---------- ②speakerMemberId 指向派生成员：自动建档（resolveAliasTarget 机制不变） ----------

test('②speakerMemberId=Gitea 派生 id → 自动建关联手工条目并写别名（memberCreated:true）', async () => {
  const cand = cands['SSO 周五前上线'];
  const r = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/confirm`, {
    memberId: 'zhangsan',
    speakerMemberId: 'lisiqi',
    rememberAlias: true,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.task.memberId, 'zhangsan', '任务负责人不受映射目标影响');
  assert.deepStrictEqual(
    r.body.rememberedAlias,
    { memberId: 'lisiqi', alias: '李思琪', memberCreated: true },
    '派生 id 自动建档且别名落点正确'
  );
  const entry = diskMembers().find((m) => m.id === 'lisiqi');
  assert.ok(entry, '手工名册自动落盘关联条目');
  assert.strictEqual(entry.name, '李思琪');
  assert.strictEqual(entry.giteaLogin, 'lisiqi');
  assert.deepStrictEqual(entry.aliases, ['李思琪']);
  assertNoOwnerPollution();
});

// ---------- ③旧客户端兼容：只传 memberId+rememberAlias → 宁可不学，不可错学 ----------

test('③旧客户端只传 memberId+rememberAlias → 200 不报错、不写任何别名，rememberedAlias:null + reason', async () => {
  const before = diskMembers();
  const cand = cands['整理评审纪要'];
  const r = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/confirm`, {
    memberId: 'zhangsan',
    rememberAlias: true,
  });
  assert.strictEqual(r.status, 200, '不报错——旧请求照常确认入库');
  assert.strictEqual(r.body.task.memberId, 'zhangsan');
  assert.strictEqual(r.body.candidate.state, 'confirmed');
  assert.strictEqual(r.body.rememberedAlias, null, '不写别名');
  assert.strictEqual(r.body.reason, 'SPEAKER_UNRESOLVED', '语义修订留痕：映射目标未指定');
  // 名册零写入（宁可不学，不可错学）
  assert.deepStrictEqual(diskMembers(), before, '名册与请求前逐字节一致');
  assertNoOwnerPollution();
});

// ---------- ④显式 speakerMemberId:null：用户有权不映射 ----------

test('④映射目标不在名册 → 404 前置拦截不建任务；speakerMemberId:null → 不写别名不报错', async () => {
  const cand = cands['清理测试环境'];
  const tasksBefore = (await api('GET', '/api/tasks')).body.length;

  // 映射目标不存在：404 前置拦截（任务不得已建）
  const ghost = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/confirm`, {
    memberId: 'zhangsan',
    speakerMemberId: 'ghost',
    rememberAlias: true,
  });
  assert.strictEqual(ghost.status, 404);
  assert.strictEqual(ghost.body.error.code, 'MEMBER_NOT_FOUND');
  assert.strictEqual((await api('GET', '/api/tasks')).body.length, tasksBefore, '404 时不建任务');
  assert.strictEqual((await api('GET', '/api/inbox?state=pending')).body.length, 2,
    '候选仍 pending（本候选 + ⑤号参数防线候选）');

  // 显式不映射：null → rememberedAlias:null + reason，确认照常
  const r = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/confirm`, {
    memberId: 'zhangsan',
    speakerMemberId: null,
    rememberAlias: true,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.rememberedAlias, null);
  assert.strictEqual(r.body.reason, 'SPEAKER_UNRESOLVED');
  assertNoOwnerPollution();
});

// ---------- ⑤参数防线：speakerMemberId 类型校验；不勾 rememberAlias 时该字段被忽略 ----------

test('⑤speakerMemberId 类型非法 → 400 FIELD_INVALID 不建任务；未请求 remember → 无 reason 字段', async () => {
  const before = diskMembers();
  const tasksBefore = (await api('GET', '/api/tasks')).body.length;
  const cand = cands['归档会议材料'];

  // 类型防线：非字符串非 null → 400 FIELD_INVALID，且先于任务创建/别名写入
  const bad = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/confirm`, {
    memberId: 'zhangsan',
    speakerMemberId: 123,
    rememberAlias: true,
  });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error.code, 'FIELD_INVALID');
  assert.match(bad.body.error.message, /speakerMemberId/);
  assert.strictEqual((await api('GET', '/api/tasks')).body.length, tasksBefore, '400 时不建任务');
  assert.strictEqual((await api('GET', '/api/inbox?state=pending')).body.length, 1, '候选仍 pending');
  assert.deepStrictEqual(diskMembers(), before, '名册零写入');

  // 不勾 rememberAlias：即使带 speakerMemberId 也被忽略——不写别名、无 reason 字段
  const r = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/confirm`, {
    memberId: 'zhangsan',
    speakerMemberId: 'lisi',
    rememberAlias: false,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.rememberedAlias, null);
  assert.ok(!('reason' in r.body), '未请求记住映射时不带 reason');
  assert.deepStrictEqual(diskMembers(), before, '名册零写入');
});

test('⑥收尾对账：5 任务全部负责人=张三；事件流照常记 created；名册零污染', async () => {
  const tasks = (await api('GET', '/api/tasks')).body;
  assert.strictEqual(tasks.length, 5);
  assert.ok(tasks.every((t) => t.memberId === 'zhangsan'), '全部任务负责人=张三');
  assert.ok(tasks.every((t) => t.origin && t.origin.type === 'inbox'), 'origin 溯源不变');

  // 事件流：每任务 1 条 created（候选落库/事件流不变的口径）
  for (const t of tasks) {
    const det = await api('GET', `/api/tasks/${encodeURIComponent(t.id)}`);
    assert.strictEqual(det.status, 200);
    assert.strictEqual(det.body.events.length, 1);
    assert.strictEqual(det.body.events[0].type, 'created');
  }

  // 统计口径不受影响
  const s = await api('GET', '/api/inbox/stats');
  assert.strictEqual(s.body.confirmed, 5);
  assert.strictEqual(s.body.rejectRate30d, 0);

  assertNoOwnerPollution();
});
