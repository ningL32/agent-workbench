'use strict';

/**
 * radar-v15.test.js — goose 真机验收第五轮 P1×3 修复的回归（docs/SMOKE.md 任务雷达 v1.5 章节）
 * 覆盖：
 *   P1-A 聚合名册匹配——store.aggregateRoster（手工 ∪ Gitea 缓存、认领 login 吸收、停用过滤）、
 *        resolveSpeaker 四优先级（alias/name/gitea 精确 → 小写双向包含 ≥2 字）、候选卡 matchSource、
 *        buildPrompt 名册含 Gitea 成员；
 *   P1-B 超时——analyze 节缺省时默认 300s、重试升压 ×2（job.results 记录 attempt/timeoutSec）、
 *        202 响应带 items[].segmentCount；
 *   P1-C 派生 id 记别名——aliases 端点自动建关联手工条目（201+created:true）、
 *        确认弹层 rememberAlias 对派生 id 自动落条目（rememberedAlias.memberCreated）。
 * 运行：node --test test/radar-v15.test.js（DINGTALK_FIXTURE + DSH_FIXTURE 全离线）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7797; // 仅作 fixture 配置留痕（进程内装配不再监听端口）

const { buildApp } = require('./helpers/appAssembler');

let app;
let tmpDir;
let dataDir;
let membersPath;
let dshFixturePath;
let dingtalkFixturePath;

// WP3：真端口 spawn → 装配器进程内分发（同一 app.handle 管线，断言零改动）；
// DINGTALK/DSH_FIXTURE 经 persistentEnv 注入——雷达 job 在响应之后异步执行并读 env
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

const DSH_BAD = '引擎任性，这次不输出 JSON。';
const DSH_GOOD = JSON.stringify({
  tasks: [
    {
      title: '更新部署文档', desc: '', priority: 'high', suggestedMemberId: 'zhaoliu', dueHint: '今天',
      confidence: 0.9, quote: '部署文档今天要更新一下', rationale: '明确动作+负责人（Gitea 名册映射）',
    },
    {
      title: 'SSO 周五前上线', desc: '', priority: 'high', suggestedMemberId: 'wang.jianguo', dueHint: '周五',
      confidence: 0.85, quote: 'SSO 这块周五前要上线', rationale: '明确动作+负责人+时间',
    },
  ],
  noise: [],
});

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-radar-v15-'));
  dataDir = path.join(tmpDir, 'data');
  membersPath = path.join(tmpDir, 'members.json');
  const fixDir = path.join(tmpDir, 'fixtures');
  fs.mkdirSync(fixDir);
  dshFixturePath = path.join(fixDir, 'dsh-out.txt');
  dingtalkFixturePath = path.join(fixDir, 'dingtalk.json');
  fs.writeFileSync(dshFixturePath, DSH_BAD, 'utf8');
  fs.writeFileSync(dingtalkFixturePath, JSON.stringify({
    list: {
      minutes: [{
        taskUuid: 'aaaa1111bbbb',
        title: 'v15 验收会',
        startTime: 1792140000000,
        endTime: 1792143600000,
        status: 4,
        url: 'https://shanji.dingtalk.com/app/transcribes/aaaa1111bbbb',
      }],
    },
    transcripts: {
      aaaa1111bbbb: {
        complete: true,
        paragraphList: [
          { paragraph: '部署文档今天要更新一下', nickName: '赵六', gmtCreate: 1792140000000 },
          { paragraph: 'SSO 这块周五前要上线', nickName: '建国', gmtCreate: 1792140060000 },
        ],
      },
    },
  }), 'utf8');
  // 注意：config 不写 analyze 节——timeoutSec 缺省 300 只能由启动期 mergeConfigDefaults 注入（P1-B 断言前提）
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    port: PORT,
    host: '127.0.0.1',
    dataDir: 'data',
    webDir: 'web',
    gitea: { pollIntervalSec: 0 },
  }));
  // 手工名册只有王建国（带别名「建国」）；赵六/李四只存在于 Gitea 成员缓存（P1-A/C 的口径分裂复现前提）
  fs.writeFileSync(membersPath, JSON.stringify({ members: [
    { id: 'wang.jianguo', name: '王建国', role: '', giteaLogin: '', aliases: ['建国'], enabled: true },
  ] }));
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'gitea-members.json'), JSON.stringify([
    { login: 'zhaoliu', full_name: '赵六', name: '' },
    { login: 'lisi', full_name: '李四', name: '' },
  ]));
  app = buildApp({
    configPath: path.join(tmpDir, 'config.json'),
    env: {
      DINGTALK_FIXTURE: dingtalkFixturePath,
      DSH_FIXTURE: dshFixturePath,
    },
    persistentEnv: true, // 雷达 job 在响应之后异步执行并读 env（close 还原）
  });
});

test.after(() => {
  if (app) app.close();
});

// ---------- P1-B：缺省超时 300 ----------

test('P1-B：config 无 analyze 节时引擎超时取新缺省 300s；settings GET 回显磁盘原值', async () => {
  const e = await api('GET', '/api/radar/engine');
  assert.strictEqual(e.status, 200);
  assert.strictEqual(e.body.dsh.timeoutSec, 300, '缺省 300（原 120 必超时的根因之一）');
  const g = await api('GET', '/api/settings');
  assert.strictEqual(g.body.dataDir, 'data', 'GET 回显磁盘原值而非运行期绝对路径');
  assert.strictEqual(g.body.analyze.timeoutSec, 300);
});

// ---------- 首次分析：坏 fixture → FAILED（attempt 1 / 基础超时） ----------

let messageId = null;

test('同步 fixture 1 条入池', async () => {
  const s = await api('POST', '/api/radar/sync', {});
  const job = await waitJob(s.body.jobId);
  assert.strictEqual(job.state, 'done');
  assert.strictEqual(job.results[0].added, 1);

  const list = await api('GET', '/api/radar/messages');
  assert.strictEqual(list.body.length, 1);
  messageId = list.body[0].id;
  assert.strictEqual(list.body[0].segmentCount, 2);
  // v2.9.5 摘要预览：首 2 段拼合（串场识别），且 slim 列表不携带全文
  assert.strictEqual(list.body[0].excerpt, '部署文档今天要更新一下 SSO 这块周五前要上线');
  assert.ok(!('speakerSegments' in list.body[0]), 'slim 列表不得携带全文段');
});

test('P1-B：202 带 items[].segmentCount；首次分析 attempt=1 基础超时 300；坏输出 → ANALYZE_FAILED', async () => {
  const r = await api('POST', '/api/radar/analyze', { messageIds: [messageId] });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.body.accepted, 1);
  assert.deepStrictEqual(r.body.items, [{ id: messageId, segmentCount: 2 }], 'segmentCount 透出供长会预估提示');

  const j = await waitJob(r.body.jobId);
  assert.strictEqual(j.state, 'partial');
  assert.strictEqual(j.results.length, 1);
  assert.strictEqual(j.results[0].ok, false);
  assert.strictEqual(j.results[0].attempt, 1);
  assert.strictEqual(j.results[0].timeoutSec, 300, '首次尝试用配置超时（缺省 300）');
  assert.match(j.results[0].error, /两次解析失败/);

  const det = await api('GET', `/api/radar/messages/${encodeURIComponent(messageId)}`);
  assert.strictEqual(det.body.analyzeState, 'ANALYZE_FAILED');
  assert.strictEqual(det.body.analyzedAt, null);
});

// ---------- 重试升压 + P1-A 候选卡 matchSource ----------

test('P1-B：重试 attempt=2 超时升压 ×2=600（job 记录可观测）；产出候选', async () => {
  fs.writeFileSync(dshFixturePath, DSH_GOOD, 'utf8'); // 引擎这次“成功”（fixture 文本每次调用现读）
  const r = await api('POST', '/api/radar/analyze', { messageIds: [messageId] });
  assert.strictEqual(r.status, 202);
  const j = await waitJob(r.body.jobId);
  assert.strictEqual(j.state, 'done');
  assert.strictEqual(j.results[0].ok, true);
  assert.strictEqual(j.results[0].attempt, 2, '对已失败纪要的重试');
  assert.strictEqual(j.results[0].timeoutSec, 600, '升压 ×2');
});

let zhaoliuCand = null;

test('P1-A：候选带 matchSource——gitea 成员归人 + 手工别名归人', async () => {
  const inbox = await api('GET', '/api/inbox?state=pending');
  assert.strictEqual(inbox.status, 200);
  assert.strictEqual(inbox.body.length, 2);
  zhaoliuCand = inbox.body.find((c) => c.title === '更新部署文档');
  const wangCand = inbox.body.find((c) => c.title === 'SSO 周五前上线');
  assert.ok(zhaoliuCand && wangCand);

  // 赵六：说话人原文「赵六」经 Gitea 缓存（login/FullName）命中 → matchSource 'gitea'
  assert.strictEqual(zhaoliuCand.suggestedMemberId, 'zhaoliu', '聚合名册校验放行 Gitea 派生 id');
  assert.strictEqual(zhaoliuCand.matchSource, 'gitea');
  assert.strictEqual(zhaoliuCand.speakerRaw, '赵六');
  // 王建国：说话人原文「建国」= 手工别名 → matchSource 'alias'
  assert.strictEqual(wangCand.suggestedMemberId, 'wang.jianguo');
  assert.strictEqual(wangCand.matchSource, 'alias');
});

// ---------- P1-C：派生 id 记别名自动建手工条目 ----------

test('P1-C：确认候选 + 记住映射选 Gitea 派生成员 → 200 不再 404，自动建条目', async () => {
  const r = await api('POST', `/api/inbox/${encodeURIComponent(zhaoliuCand.id)}/confirm`, {
    memberId: 'zhaoliu',
    // v1.7 修订：别名挂 speakerMemberId（说话人「赵六」本人，Gitea 派生 id），与任务负责人解耦
    speakerMemberId: 'zhaoliu',
    rememberAlias: true,
  });
  assert.strictEqual(r.status, 200, 'v1.5 前此处必 404 MEMBER_NOT_FOUND');
  assert.strictEqual(r.body.task.memberId, 'zhaoliu');
  assert.deepStrictEqual(
    { ...r.body.rememberedAlias, alias: r.body.rememberedAlias.alias },
    { memberId: 'zhaoliu', alias: '赵六', memberCreated: true },
    '响应带 rememberedAlias 落点'
  );
  const entry = diskMembers().find((m) => m.id === 'zhaoliu');
  assert.ok(entry, '手工名册自动落盘关联条目');
  assert.strictEqual(entry.name, '赵六');
  assert.strictEqual(entry.giteaLogin, 'zhaoliu');
  assert.ok(entry.aliases.includes('赵六'));
});

test('P1-C：aliases 端点对派生 id 自动建条目（201+created:true）；已存在 200 去重；两边都不沾 404', async () => {
  const r1 = await api('POST', '/api/members/lisi/aliases', { alias: '强哥' });
  assert.strictEqual(r1.status, 201);
  assert.strictEqual(r1.body.created, true);
  assert.strictEqual(r1.body.name, '李四');
  assert.strictEqual(r1.body.giteaLogin, 'lisi');
  assert.ok(r1.body.aliases.includes('强哥'));
  assert.ok(diskMembers().some((m) => m.id === 'lisi'), '落盘确认');

  const r2 = await api('POST', '/api/members/lisi/aliases', { alias: '强哥' });
  assert.strictEqual(r2.status, 200, '条目已存在 → 走普通 200 路径');
  assert.strictEqual(r2.body.created, undefined);
  assert.strictEqual(r2.body.aliases.filter((a) => a === '强哥').length, 1, '大小写不敏感去重');

  const ghost = await api('POST', '/api/members/ghost/aliases', { alias: 'x' });
  assert.strictEqual(ghost.status, 404, '手工名册与 Gitea 缓存都不在 → 仍 404');
  const agent = await api('POST', '/api/members/claude/aliases', { alias: 'x' });
  assert.strictEqual(agent.status, 404, '智能体不参与说话人映射');
});

// ---------- v1.7：已完成处置（done-already）+ 误识率新口径 ----------

test('v1.7 done-already：state=done_already、decidedAt 落盘，不入看板（不建任务）', async () => {
  const pend = await api('GET', '/api/inbox?state=pending');
  assert.strictEqual(pend.status, 200);
  const cand = pend.body.find((c) => c.title === 'SSO 周五前上线');
  assert.ok(cand, 'P1-A 遗留的待决候选仍在');

  // note 校验：超长 400 FIELD_INVALID
  const badNote = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/done-already`, { note: 'x'.repeat(501) });
  assert.strictEqual(badNote.status, 400);
  assert.strictEqual(badNote.body.error.code, 'FIELD_INVALID');

  const before = (await api('GET', '/api/tasks')).body;
  const r = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/done-already`, { note: '会上已顺手做完' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.state, 'done_already');
  assert.ok(r.body.decidedAt, 'decidedAt 落盘');
  assert.strictEqual(r.body.doneNote, '会上已顺手做完');

  // 不入看板：任务总数不变，且无 origin.refId 指向该候选的新任务
  const after = (await api('GET', '/api/tasks')).body;
  assert.strictEqual(after.length, before.length, '不得新建任务');
  assert.ok(!after.some((t) => t.origin && t.origin.refId === cand.id), '无该候选的确认任务');

  // 重复决定 409（已决候选不可再 reject / done-already / confirm）
  const again = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/done-already`, {});
  assert.strictEqual(again.status, 409);
  const rej = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/reject`, { reason: 'other' });
  assert.strictEqual(rej.status, 409);
});

test('v1.7 误识率新口径：rejectRate30d = rejected30d/(confirmed30d+doneAlready30d+rejected30d)', async () => {
  const s = await api('GET', '/api/inbox/stats');
  assert.strictEqual(s.status, 200);
  // 本实例：1 confirmed（P1-C zhaoliuCand）+ 1 done_already（上一用例），0 rejected
  assert.strictEqual(s.body.confirmed, 1);
  assert.strictEqual(s.body.doneAlready, 1);
  assert.strictEqual(s.body.rejected, 0);
  assert.strictEqual(s.body.confirmed30d, 1);
  assert.strictEqual(s.body.doneAlready30d, 1, 'done_already 计入 30 天分母');
  assert.strictEqual(s.body.rejected30d, 0);
  assert.strictEqual(s.body.rejectRate30d, 0, '0/(1+1+0)=0——分母含 done_already（与「无数据返回 null」可区分）');
});

// ---------- 模块级单测（无服务） ----------

const store = require('../lib/store.js');
const analyze = require('../lib/analyze.js');

test('P1-A：store.aggregateRoster——并集/认领 login 吸收/停用过滤/id 去重', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-r15-roster-'));
  const ctx = {
    membersPath: path.join(dir, 'members.json'),
    giteaMembersPath: path.join(dir, 'gitea-members.json'),
  };
  fs.writeFileSync(ctx.membersPath, JSON.stringify({ members: [
    { id: 'qianqi', name: '张伟', giteaLogin: 'wangwu', enabled: true },
    { id: 'ghost', name: '停用者', enabled: false },
  ] }));
  fs.writeFileSync(ctx.giteaMembersPath, JSON.stringify([
    { login: 'wangwu', full_name: '张伟（Gitea）', name: '' },
    { login: 'zhaoliu', full_name: '赵六', name: '' },
  ]));
  const roster = store.aggregateRoster(ctx);
  // 手工 2 条（含停用者被滤掉 → 1）+ gitea 2 条，其中 wangwu 被张优认领吸收 → 共 2 条
  assert.deepStrictEqual(roster.map((m) => [m.id, m.source]), [
    ['qianqi', 'manual'],
    ['zhaoliu', 'gitea'],
  ]);
  assert.ok(roster[0].aliases.includes('wangwu'), '认领 login 吸收为别名（同人单 id）');
  assert.strictEqual(roster[1].name, '赵六', 'gitea 条目 name 取 full_name');
  // 空 ctx 防御：两个路径都缺也不炸
  assert.deepStrictEqual(store.aggregateRoster({}), []);
});

const ROSTER4 = [
  { id: 'a.wang', name: '王建国', aliases: ['建国'], source: 'manual' },
  { id: 'zhaoliu', name: '赵六', aliases: [], source: 'gitea' },
];

test('P1-A：resolveSpeaker 四优先级——alias > name > gitea 精确 > 小写双向包含（≥2 字）', () => {
  // ① 手工 alias 精确 胜过 手工 name 精确（同名不同人，alias 档先赢）
  const two = [
    { id: 'nameguy', name: '建国', aliases: [], source: 'manual' },
    { id: 'aliasguy', name: '别的名', aliases: ['建国'], source: 'manual' },
  ];
  assert.deepStrictEqual(analyze.resolveSpeaker('建国', two), { id: 'aliasguy', source: 'alias' });
  // ② 手工 name 精确 胜过 gitea 同名
  const manualFirst = [
    { id: 'm.li', name: '赵六', aliases: [], source: 'manual' },
    { id: 'zhaoliu', name: '赵六', source: 'gitea' },
  ];
  assert.deepStrictEqual(analyze.resolveSpeaker('赵六', manualFirst), { id: 'm.li', source: 'name' });
  // ③ gitea 精确：login 与 full_name 两路都命中
  assert.deepStrictEqual(analyze.resolveSpeaker('zhaoliu', ROSTER4), { id: 'zhaoliu', source: 'gitea' });
  assert.deepStrictEqual(analyze.resolveSpeaker('赵六', ROSTER4), { id: 'zhaoliu', source: 'gitea' });
  // ④ 包含档：raw 含字段（称呼带缀）双向命中；alias 档在包含层同样优先
  assert.deepStrictEqual(analyze.resolveSpeaker('建国同学', ROSTER4), { id: 'a.wang', source: 'alias' });
  assert.deepStrictEqual(analyze.resolveSpeaker('王建国总', ROSTER4), { id: 'a.wang', source: 'alias' },
    'raw「王建国总」同时包含别名「建国」→ alias 档先赢');
  // name 档包含：成员无别名、raw 带缀 → name
  assert.deepStrictEqual(
    analyze.resolveSpeaker('王建国总', [{ id: 'l.wang', name: '王建国', source: 'manual' }]),
    { id: 'l.wang', source: 'name' }
  );
  // gitea 档包含：raw 含 login/名（≥2 字）
  assert.deepStrictEqual(
    analyze.resolveSpeaker('zhaoliu同学', ROSTER4),
    { id: 'zhaoliu', source: 'gitea' }
  );
  // 防误伤：单字不上包含档；完全无关 → null；空串 → null
  assert.strictEqual(analyze.resolveSpeaker('王', ROSTER4), null);
  assert.strictEqual(analyze.resolveSpeaker('无此人', ROSTER4), null);
  assert.strictEqual(analyze.resolveSpeaker('', ROSTER4), null);
  // mapSpeaker 旧接口形状兼容；无 source 字段按 manual（旧测试夹具不回归）
  assert.strictEqual(analyze.mapSpeaker('建国', ROSTER4), 'a.wang');
  assert.deepStrictEqual(
    analyze.resolveSpeaker('建国', [{ id: 'a.wang', name: '王建国', aliases: ['建国'] }]),
    { id: 'a.wang', source: 'alias' }
  );
});

test('P1-B：effectiveTimeoutSec——首试取配置，重试 ×2 且封顶不指数', () => {
  assert.strictEqual(analyze.effectiveTimeoutSec(300, 1), 300);
  assert.strictEqual(analyze.effectiveTimeoutSec(300, 2), 600);
  assert.strictEqual(analyze.effectiveTimeoutSec(300, 5), 600, '升压一次封顶');
  assert.strictEqual(analyze.effectiveTimeoutSec(120, 2), 240, '显式配置同样升压');
  assert.strictEqual(analyze.effectiveTimeoutSec(undefined, 1), 300, '缺省 300');
});

test('P1-A：buildPrompt 名册含 Gitea 成员；逐字稿行预匹配 memberId', () => {
  const message = {
    title: 't',
    speakerSegments: [{ raw: '赵六', memberId: null, text: '部署文档今天要更新一下' }],
  };
  const prompt = analyze.buildPrompt(message, ROSTER4, [], {});
  assert.match(prompt, /- zhaoliu \| 赵六/, 'Gitea 派生成员进名册（手工名册为空时 AI 不再「无法映射」）');
  assert.match(prompt, /【赵六\|zhaoliu】/, '说话人预匹配 memberId 写入逐字稿行');
});
