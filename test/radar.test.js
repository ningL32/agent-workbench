'use strict';

/**
 * radar.test.js — 任务雷达后端（PRD-task-inbox §4/§5/§7）
 * 覆盖：DINGTALK_FIXTURE 同步 + 哈希防重、ref.url 白名单拦截、消息模型字段、
 *       DSH_FIXTURE 分析（候选产出/置信度过滤/疑似重复进 noise）、ANALYZE_FAILED 重试、
 *       确认入库（origin 溯源 + dueDate + rememberAlias 别名闭环）、拒绝与误识率统计、
 *       aliases 端点、CSRF Content-Type 防线、dingtalk 白名单启动期体检、
 *       extractJSON/coerceResult/mapSpeaker/hostAllowed 模块级单测。
 * 运行：node --test test/radar.test.js （DINGTALK_FIXTURE + DSH_FIXTURE 全离线）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7799; // 仅作 fixture 配置留痕（进程内装配不再监听端口）
const FIX = (f) => path.join(__dirname, 'fixtures', f);

const { buildApp } = require('./helpers/appAssembler');

let app;
let tmpDir;
let dataDir;
let membersPath;

// WP3：真端口 spawn → 装配器进程内分发（同一 app.handle 管线，断言零改动）；
// DINGTALK/DSH_FIXTURE 经 persistentEnv 注入——雷达 job 在响应之后异步执行并读 env
async function api(method, p, body, headers = {}) {
  return app.fetch(method, p, {
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 轮询 job 终态（sync/analyze 共用；20s 上限） */
async function waitJob(jobId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const r = await api('GET', `/api/radar/jobs/${jobId}`);
    if (r.status === 200 && r.body.state !== 'running') return r.body;
    await new Promise((res) => setTimeout(res, 120));
  }
  throw new Error('job 未在 20s 内完成');
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-radar-'));
  dataDir = path.join(tmpDir, 'data');
  membersPath = path.join(tmpDir, 'members.json');
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({
      port: PORT,
      host: '127.0.0.1',
      dataDir,
      webDir: path.join(tmpDir, 'web'),
      gitea: { pollIntervalSec: 0 },
      // 故意不写 dingtalk/analyze 节：默认值仅由启动期 mergeConfigDefaults 注入——
      // 「设置 PATCH analysis 节 → 雷达通道被误判关闭」的回归（7795 真实联调复现）只有在
      // 磁盘基线缺节时才会触发，回归用例依赖这一前提
      analyze: { timeoutSec: 120 },
    })
  );
  fs.writeFileSync(
    membersPath,
    JSON.stringify({ members: [
      { id: 'wang.jianguo', name: '王建国', role: '', giteaLogin: '', enabled: true },
      { id: 'li.lei', name: '李雷', role: '', giteaLogin: '', enabled: true },
    ] })
  );
  app = buildApp({
    configPath: path.join(tmpDir, 'config.json'),
    env: {
      DINGTALK_FIXTURE: FIX('dingtalk.json'),
      DSH_FIXTURE: FIX('dsh-ok.txt'),
    },
    persistentEnv: true, // 雷达 job 在响应之后异步执行并读 env（close 还原）
  });
});

test.after(() => {
  if (app) app.close();
});

// ---------- 同步与哈希防重 ----------

test('同步 fixture：3 条列表 → 白名单拦 1 条，2 条入池；再同步 0 新增（哈希防重）', async () => {
  const r1 = await api('POST', '/api/radar/sync', {});
  assert.strictEqual(r1.status, 202);
  const job1 = await waitJob(r1.body.jobId);
  assert.strictEqual(job1.state, 'partial', '第 3 条 ref.url 不在白名单应记 failed → partial');
  const syncRes = job1.results[0];
  assert.strictEqual(syncRes.total, 3);
  assert.strictEqual(syncRes.added, 2);
  assert.strictEqual(syncRes.failed.length, 1);
  assert.match(syncRes.failed[0].error, /不在白名单/);

  // 全量重拉：同一纪要重复同步不出重复（PRD §7-2）
  const r2 = await api('POST', '/api/radar/sync', {});
  const job2 = await waitJob(r2.body.jobId);
  assert.strictEqual(job2.results[0].added, 0, '哈希防重：重复同步 0 新增');
  assert.strictEqual(job2.results[0].skippedExisting, 2);

  const list = await api('GET', '/api/radar/messages');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.length, 2);
  // occurredAt 倒序
  assert.ok(Date.parse(list.body[0].occurredAt) >= Date.parse(list.body[1].occurredAt));
  assert.strictEqual(list.body[0].analyzedAt, null);
  assert.strictEqual(list.body[0].analyzeState, '');
});

test('消息详情：统一消息模型字段齐全（speakerSegments/content/ref/contentHash）', async () => {
  const list = await api('GET', '/api/radar/messages');
  const id = list.body.find((m) => m.title === '周三需求对齐会').id;
  const det = await api('GET', `/api/radar/messages/${encodeURIComponent(id)}`);
  assert.strictEqual(det.status, 200);
  const m = det.body;
  for (const k of ['id', 'source', 'kind', 'title', 'speakerSegments', 'content', 'occurredAt', 'ref', 'contentHash', 'analyzedAt']) {
    assert.ok(k in m, `缺字段 ${k}`);
  }
  assert.strictEqual(m.source, 'dingtalk');
  assert.strictEqual(m.kind, 'minutes');
  assert.strictEqual(m.speakerSegments.length, 4);
  assert.strictEqual(m.speakerSegments[0].raw, '建国');
  assert.strictEqual(m.speakerSegments[0].memberId, null);
  assert.match(m.content, /【建国】SSO 这块周五前要上线/);
  assert.match(m.ref.url, /^https:\/\/shanji\.dingtalk\.com\//);
  assert.strictEqual(m.contentHash.length, 64);
});

test('CSRF：text/plain POST /api/radar/sync → 400 CONTENT_TYPE_REQUIRED', async () => {
  const r = await app.fetch('POST', '/api/radar/sync', {
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).error.code, 'CONTENT_TYPE_REQUIRED');
});

// ---------- 分析（DSH_FIXTURE） ----------

let candidateA = null; // 高置信度候选（SSO）
let candidateB = null; // 待决候选（纪要）

test('分析：202 异步 job → 候选进池（置信度降序、<0.5 不产出、疑似重复进 noise）', async () => {
  const list = await api('GET', '/api/radar/messages');
  // DSH_FIXTURE 是静态文件（每次调用返回同一份输出），因此只分析目标消息，
  // 断言才能精确到张数；批量 job 的推进由 job.results/accepted 覆盖
  const target = list.body.find((m) => m.title === '周三需求对齐会');
  const r = await api('POST', '/api/radar/analyze', { messageIds: [target.id] });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.body.accepted, 1);
  const job = await waitJob(r.body.jobId);
  assert.strictEqual(job.state, 'done');
  assert.ok(job.results.every((x) => x.ok), `全部分析成功: ${JSON.stringify(job.results)}`);

  const inbox = await api('GET', '/api/inbox?state=pending');
  assert.strictEqual(inbox.status, 200);
  const cands = inbox.body;
  assert.strictEqual(cands.length, 2, '0.3 疑似重复候选不产出 + 茶话会 0 候选');
  // 置信度降序
  assert.ok(cands[0].confidence >= cands[1].confidence);
  candidateA = cands.find((c) => c.title === 'SSO 周五前上线');
  candidateB = cands.find((c) => c.title === '整理评审结论纪要');
  assert.ok(candidateA && candidateB, '两张候选卡都在');

  // 候选模型字段
  for (const k of ['id', 'messageId', 'messageTitle', 'title', 'desc', 'priority', 'suggestedMemberId', 'dueHint', 'confidence', 'quote', 'rationale', 'state', 'createdAt']) {
    assert.ok(k in candidateA, `候选缺字段 ${k}`);
  }
  assert.strictEqual(candidateA.state, 'pending');
  assert.strictEqual(candidateA.suggestedMemberId, 'wang.jianguo');
  assert.strictEqual(candidateA.dueHint, '周五');
  assert.strictEqual(candidateA.speakerRaw, '建国', 'quote 反查说话人');
  assert.strictEqual(candidateB.priority, 'medium', '模型给定优先级透传（unset 路径由 coerceResult 单测覆盖）');

  // 疑似重复标注可见（消息 noise 留痕）
  const det = await api('GET', `/api/radar/messages/${encodeURIComponent(candidateA.messageId)}`);
  const noiseReasons = JSON.stringify(det.body.noise || []);
  assert.match(noiseReasons, /疑似重复/);
  assert.match(noiseReasons, /我看看/);
});

test('重复分析已分析纪要 → skipped ALREADY_ANALYZED', async () => {
  const list = await api('GET', '/api/radar/messages');
  const id = list.body[0].id;
  const r = await api('POST', '/api/radar/analyze', { messageIds: [id] });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.body.accepted, 0);
  assert.strictEqual(r.body.skipped[0].reason, 'ALREADY_ANALYZED');
});

test('analyze 参数防线：messageIds 缺失/非数组 → 400', async () => {
  const r1 = await api('POST', '/api/radar/analyze', {});
  assert.strictEqual(r1.status, 400);
  const r2 = await api('POST', '/api/radar/analyze', { messageIds: 'x' });
  assert.strictEqual(r2.status, 400);
});

// ---------- 确认 / 拒绝 / 统计 / 别名 ----------

test('确认入库：编辑字段 + dueDate + rememberAlias → 任务带 origin 溯源、别名落盘', async () => {
  const r = await api('POST', `/api/inbox/${encodeURIComponent(candidateA.id)}/confirm`, {
    title: 'SSO 上线（编辑后）',
    memberId: 'wang.jianguo',
    // v1.7 修订：别名写到 speakerMemberId（说话人「建国」= 王建国本人）名下，与任务负责人解耦
    speakerMemberId: 'wang.jianguo',
    dueDate: '2026-10-24',
    priority: 'high',
    rememberAlias: true,
  });
  assert.strictEqual(r.status, 200);
  const { task, candidate } = r.body;
  assert.strictEqual(task.status, 'todo');
  assert.strictEqual(task.title, 'SSO 上线（编辑后）');
  assert.strictEqual(task.dueDate, '2026-10-24');
  assert.strictEqual(task.priority, 'high');
  assert.deepStrictEqual(task.origin, { type: 'inbox', refId: candidateA.id, quote: candidateA.quote });
  assert.strictEqual(candidate.state, 'confirmed');
  assert.ok(candidate.decidedAt);
  assert.deepStrictEqual(
    r.body.rememberedAlias,
    { memberId: 'wang.jianguo', alias: '建国', memberCreated: false },
    'v1.7 修订：rememberedAlias.memberId = 映射目标（说话人）而非任务负责人'
  );

  // 看板可查
  const tasks = await api('GET', '/api/tasks');
  const t = tasks.body.find((x) => x.id === task.id);
  assert.ok(t, '看板出现该任务');
  assert.strictEqual(t.origin.type, 'inbox');

  // 记住映射：说话人 raw「建国」进入 wang.jianguo 的别名（PRD §6 闭环）
  const members = JSON.parse(fs.readFileSync(membersPath, 'utf8'));
  const wjg = members.members.find((m) => m.id === 'wang.jianguo');
  assert.ok(wjg.aliases.includes('建国'), '别名「建国」已落盘');

  // 确认后的候选不再出现在待确认流
  const pend = await api('GET', '/api/inbox?state=pending');
  assert.strictEqual(pend.body.length, 1);
});

test('确认参数防线：坏 dueDate 400 / 重复决定 409 / 不存在候选 404', async () => {
  const pend = await api('GET', '/api/inbox?state=pending');
  const cand = pend.body[0];
  const bad1 = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/confirm`, { dueDate: '2026-02-30' });
  assert.strictEqual(bad1.status, 400);
  const bad2 = await api('POST', `/api/inbox/${encodeURIComponent(cand.id)}/confirm`, { priority: 'urgent' });
  assert.strictEqual(bad2.status, 400);
  const bad3 = await api('POST', '/api/inbox/nonexistent/confirm', {});
  assert.strictEqual(bad3.status, 404);
});

test('v1.7 拒绝：缺 reason 400 REASON_REQUIRED；带原因落盘 rejectReason/rejectNote；重复拒绝 409', async () => {
  // v1.7 起 reason 必选：缺失 / 枚举外取值 / note 超长均 400
  const noReason = await api('POST', `/api/inbox/${encodeURIComponent(candidateB.id)}/reject`, {});
  assert.strictEqual(noReason.status, 400);
  assert.strictEqual(noReason.body.error.code, 'REASON_REQUIRED');
  const badReason = await api('POST', `/api/inbox/${encodeURIComponent(candidateB.id)}/reject`, { reason: 'nope' });
  assert.strictEqual(badReason.status, 400);
  assert.strictEqual(badReason.body.error.code, 'REASON_REQUIRED');
  const longNote = await api('POST', `/api/inbox/${encodeURIComponent(candidateB.id)}/reject`, { reason: 'other', note: 'x'.repeat(501) });
  assert.strictEqual(longNote.status, 400);
  assert.strictEqual(longNote.body.error.code, 'FIELD_INVALID');

  const r = await api('POST', `/api/inbox/${encodeURIComponent(candidateB.id)}/reject`, { reason: 'duplicate', note: '与上周纪要重复' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.state, 'rejected');
  assert.strictEqual(r.body.rejectReason, 'duplicate', '拒绝原因落盘');
  assert.strictEqual(r.body.rejectNote, '与上周纪要重复', '拒绝附言落盘');
  const again = await api('POST', `/api/inbox/${encodeURIComponent(candidateB.id)}/reject`, { reason: 'other' });
  assert.strictEqual(again.status, 409);
  const pend = await api('GET', '/api/inbox?state=pending');
  assert.strictEqual(pend.body.length, 0);
});

test('v1.7 误识率统计：rejectRate30d = rejected30d/(confirmed30d+doneAlready30d+rejected30d)', async () => {
  const s = await api('GET', '/api/inbox/stats');
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.confirmed, 1);
  assert.strictEqual(s.body.rejected, 1);
  assert.strictEqual(s.body.pending, 0);
  assert.strictEqual(s.body.doneAlready, 0, 'v1.7 新增 doneAlready 计数');
  assert.strictEqual(s.body.confirmed30d, 1);
  assert.strictEqual(s.body.rejected30d, 1);
  assert.strictEqual(s.body.doneAlready30d, 0, 'v1.7 新增 doneAlready30d 计数');
  // 本实例无 done_already：1/(1+0+1) = 0.5（与旧口径数值巧合一致，分母构成已变）
  assert.strictEqual(s.body.rejectRate30d, 0.5);
});

test('别名端点：POST /api/members/:id/aliases 去重追加 + 400/404', async () => {
  const r1 = await api('POST', '/api/members/wang.jianguo/aliases', { alias: '老王' });
  assert.strictEqual(r1.status, 200);
  assert.ok(r1.body.aliases.includes('老王'));
  assert.ok(r1.body.aliases.includes('建国'));
  const r2 = await api('POST', '/api/members/wang.jianguo/aliases', { alias: '老王' });
  assert.strictEqual(r2.body.aliases.filter((a) => a === '老王').length, 1, '大小写不敏感去重');
  const bad = await api('POST', '/api/members/wang.jianguo/aliases', { alias: '' });
  assert.strictEqual(bad.status, 400);
  const missing = await api('POST', '/api/members/nobody/aliases', { alias: 'x' });
  assert.strictEqual(missing.status, 404);
});

test('引擎状态：GET /api/radar/engine 报告双引擎可达性', async () => {
  const r = await api('GET', '/api/radar/engine');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.dingtalk.enabled, true);
  assert.strictEqual(r.body.dingtalk.fixtureMode, true);
  assert.strictEqual(r.body.dsh.fixtureMode, true);
  assert.ok('found' in r.body.dsh);
});

test('设置视图：dingtalk/analyze 节脱敏可见且可 PATCH', async () => {
  const g = await api('GET', '/api/settings');
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.body.dingtalk.enabled, true);
  assert.deepStrictEqual(g.body.dingtalk.hostWhitelist, ['dingtalk.com']);
  const p = await api('PATCH', '/api/settings', { dingtalk: { enabled: false } });
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.body.dingtalk.enabled, false);
  const bad = await api('PATCH', '/api/settings', { dingtalk: { hostWhitelist: ['localhost'] } });
  assert.strictEqual(bad.status, 400);
  // 还原开关，避免影响后续/并行用例
  await api('PATCH', '/api/settings', { dingtalk: { enabled: true } });
});

test('回归：磁盘无 dingtalk 节时 PATCH 其他节不抹掉运行期通道默认注入（真实联调 7795 复现）', async () => {
  // 本测试实例的磁盘 config.json 没有 dingtalk 节（mergeConfigDefaults 仅启动期注入默认值）——
  // PATCH analyze 节后，GET /api/settings 的 dingtalk.enabled 必须仍是 true，
  // 否则下一次 POST /api/radar/sync 会被误判 409 RADAR_DISABLED
  const p = await api('PATCH', '/api/settings', { analyze: { timeoutSec: 240 } });
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.body.analyze.timeoutSec, 240);
  const g = await api('GET', '/api/settings');
  assert.strictEqual(g.body.dingtalk.enabled, true, 'dingtalk 默认注入不得被 PATCH 抹掉');
  assert.deepStrictEqual(g.body.dingtalk.hostWhitelist, ['dingtalk.com']);
  // 同步链路真实可用性：sync 端点不再因通道误判关闭而 409
  const s = await api('POST', '/api/radar/sync', {});
  assert.notStrictEqual(s.status, 409, '通道不得被误判关闭');
  if (s.status === 202) {
    const job = await waitJob(s.body.jobId);
    assert.ok(job.results[0].skippedExisting >= 2, '哈希防重：重同步全部 skipped');
  }
});

// ---------- 启动期白名单体检（SPEC-PLUGIN 2.2：server.js 启动行为 → 装配器等价行为） ----------
// 独立版：buildApp 校验 throw → server.js catch 打印 [config] 并 process.exit(2)；
// 装配器语义：同一校验在 buildApp 直接拒绝（消息同源，含 dingtalk.hostWhitelist）。

test('启动期体检：dingtalk.hostWhitelist 含 127.0.0.1 → 装配期拒绝（独立版退出码 2 等价）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-radar-guard-'));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: 7798, host: '127.0.0.1', dataDir: path.join(dir, 'data'), webDir: path.join(dir, 'web'),
    gitea: { pollIntervalSec: 0 },
    dingtalk: { hostWhitelist: ['127.0.0.1'] },
  }));
  assert.throws(() => buildApp({ configPath: cfg }), /dingtalk\.hostWhitelist/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 模块级单测（无服务） ----------

const analyze = require('../lib/analyze.js');
const dingtalk = require('../lib/dingtalk.js');
const ssrf = require('../lib/ssrfGuard.js');
const storeMod = require('../lib/store.js');

test('extractJSON：围栏/夹带散文/纯 JSON/垃圾输入', () => {
  assert.deepStrictEqual(analyze.extractJSON('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(analyze.extractJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(analyze.extractJSON('结果如下：\n{"a":{"b":2}}\n以上。'), { a: { b: 2 } });
  assert.throws(() => analyze.extractJSON('完全没有 JSON'));
  assert.throws(() => analyze.extractJSON('{"a":1')); // 截断
});

const ROSTER = [
  { id: 'wang.jianguo', name: '王建国', aliases: ['建国', '老王'] },
  { id: 'li.lei', name: '李雷', aliases: ['Lei'] },
];

test('coerceResult：截断到 10、置信度钳制、非法成员 id 清空、无标题丢弃', () => {
  const many = { tasks: Array.from({ length: 12 }, (_, i) => ({
    title: `任务${i}`, confidence: 1 - i * 0.05, suggestedMemberId: 'ghost', priority: 'nope',
  })), noise: [] };
  const out = analyze.coerceResult(many, ROSTER, {});
  assert.strictEqual(out.tasks.length, 10, '≤10 截断');
  assert.strictEqual(out.tasks[0].confidence, 1);
  assert.ok(out.tasks[0].confidence >= out.tasks[9].confidence, '置信度降序');
  assert.strictEqual(out.tasks[0].suggestedMemberId, '', '名册外 id 清空');
  assert.strictEqual(out.tasks[0].priority, 'unset', '非法优先级 → unset');
  const noTitle = analyze.coerceResult({ tasks: [{ desc: '没有标题', confidence: 0.9 }], noise: [] }, ROSTER, {});
  assert.strictEqual(noTitle.tasks.length, 0);
  const clamp = analyze.coerceResult({ tasks: [{ title: 'x', confidence: 7 }], noise: [] }, ROSTER, {});
  assert.strictEqual(clamp.tasks[0].confidence, 1);
});

test('mapSpeaker：name/别名精确匹配（大小写不敏感），未命中 null', () => {
  assert.strictEqual(analyze.mapSpeaker('王建国', ROSTER), 'wang.jianguo');
  assert.strictEqual(analyze.mapSpeaker('建国', ROSTER), 'wang.jianguo');
  assert.strictEqual(analyze.mapSpeaker(' 老王 ', ROSTER), 'wang.jianguo');
  assert.strictEqual(analyze.mapSpeaker('LEI', ROSTER), 'li.lei', '别名大小写不敏感');
  assert.strictEqual(analyze.mapSpeaker('张三', ROSTER), null);
  assert.strictEqual(analyze.mapSpeaker('', ROSTER), null);
});

test('hostAllowed：精确 + 子域命中；前缀/后缀伪装不命中', () => {
  const wl = ['dingtalk.com'];
  assert.strictEqual(ssrf.hostAllowed('dingtalk.com', wl), true);
  assert.strictEqual(ssrf.hostAllowed('shanji.dingtalk.com', wl), true);
  assert.strictEqual(ssrf.hostAllowed('SHANJI.DINGTALK.COM', wl), true);
  assert.strictEqual(ssrf.hostAllowed('evil-dingtalk.com', wl), false);
  assert.strictEqual(ssrf.hostAllowed('dingtalk.com.evil.com', wl), false);
  assert.strictEqual(ssrf.hostAllowed('', wl), false);
});

test('validateWhitelistEntries：危险字面量/含协议条目抛错', () => {
  assert.throws(() => ssrf.validateWhitelistEntries(['localhost']), (e) => e.code === 'DANGEROUS_WHITELIST_ENTRY');
  assert.throws(() => ssrf.validateWhitelistEntries(['10.0.0.1']));
  assert.throws(() => ssrf.validateWhitelistEntries(['http://dingtalk.com']));
  assert.doesNotThrow(() => ssrf.validateWhitelistEntries(['dingtalk.com', 'api.dingtalk.com']));
});

test('normalizeMinutes：dws 形态 → 统一消息模型；身份哈希稳定', () => {
  const fx = JSON.parse(fs.readFileSync(FIX('dingtalk.json'), 'utf8'));
  const item = fx.list.minutes[0];
  const tr = fx.transcripts[item.taskUuid];
  const m1 = dingtalk.normalizeMinutes(item, tr);
  const m2 = dingtalk.normalizeMinutes(item, tr);
  assert.strictEqual(m1.id, m2.id, '同纪要同 id（幂等锚点）');
  assert.strictEqual(m1.id, dingtalk.messageIdFor(item).id);
  assert.strictEqual(m1.contentHash.length, 64);
  assert.strictEqual(m1.truncated, false);
  assert.strictEqual(dingtalk.normalizeMinutes(item, { paragraphList: [] }), null, '空逐字稿拒绝');
});

test('ANALYZE_FAILED：坏输出重试一次后标记失败且可重试恢复', async () => {
  // 独立临时 ctx（不经服务端）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-radar-mod-'));
  const ctx = {
    config: { dingtalk: { enabled: true, hostWhitelist: ['dingtalk.com'], dwsTimeoutSec: 10, maxMessages: 50 }, analyze: { timeoutSec: 120, maxTasksPerMessage: 10, maxPromptChars: 24000 } },
    membersPath: path.join(dir, 'members.json'),
    tasksPath: path.join(dir, 'tasks.json'),
    inboxPath: path.join(dir, 'inbox.json'),
    messagesPath: path.join(dir, 'messages.json'),
  };
  fs.writeFileSync(ctx.membersPath, JSON.stringify({ members: ROSTER.map((r) => ({ ...r, role: '', giteaLogin: '', enabled: true })) }));
  fs.writeFileSync(ctx.tasksPath, JSON.stringify({ columns: [{ id: 'todo', name: '待分配', order: 1 }], tasks: [] }));

  const fx = JSON.parse(fs.readFileSync(FIX('dingtalk.json'), 'utf8'));
  const item = fx.list.minutes[0];
  const message = dingtalk.normalizeMinutes(item, fx.transcripts[item.taskUuid]);
  storeMod.saveMessages(ctx, [message]);

  // ① 坏输出：两次解析失败 → ANALYZE_FAILED、analyzedAt 保持 null（可重试）
  const prevDsh = process.env.DSH_FIXTURE;
  process.env.DSH_FIXTURE = FIX('dsh-bad.txt');
  let failedMsg = null;
  try {
    await analyze.analyzeMessage(ctx, message);
    assert.fail('应当抛出');
  } catch (e) {
    assert.strictEqual(e.code, 'ANALYZE_PARSE_FAILED');
    analyze.markFailed(ctx, message, e);
    failedMsg = storeMod.loadMessages(ctx)[0];
  } finally {
    process.env.DSH_FIXTURE = prevDsh;
  }
  assert.strictEqual(failedMsg.analyzeState, 'ANALYZE_FAILED');
  assert.strictEqual(failedMsg.analyzedAt, null);
  assert.match(failedMsg.analyzeError, /两次解析失败/);

  // ② 换好 fixture 重试 → 成功出候选（FAILED 状态可重试的闭环）
  process.env.DSH_FIXTURE = FIX('dsh-ok.txt');
  try {
    const retried = storeMod.loadMessages(ctx)[0];
    const result = await analyze.analyzeMessage(ctx, retried);
    const added = analyze.applyAnalysis(ctx, retried, result);
    storeMod.saveMessages(ctx, [retried]);
    assert.ok(added >= 1);
    const okMsg = storeMod.loadMessages(ctx)[0];
    assert.strictEqual(okMsg.analyzeState, 'ok');
    assert.ok(okMsg.analyzedAt);
    const inbox = storeMod.loadInbox(ctx);
    assert.strictEqual(inbox.length, 2, '<0.5 过滤后 2 张候选');
  } finally {
    process.env.DSH_FIXTURE = prevDsh;
  }
});

test('store：loadMessages/loadInbox 容错形态 + genTaskId 唯一', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-radar-store-'));
  const ctx = { messagesPath: path.join(dir, 'messages.json'), inboxPath: path.join(dir, 'inbox.json') };
  assert.deepStrictEqual(storeMod.loadMessages(ctx), []);
  storeMod.writeJSON(ctx.messagesPath, { messages: [{ id: 'm1' }] });
  assert.strictEqual(storeMod.loadMessages(ctx).length, 1);
  storeMod.writeJSON(ctx.inboxPath, [{ id: 'c1' }]); // 裸数组形态
  assert.strictEqual(storeMod.loadInbox(ctx).length, 1);
  const ids = new Set();
  for (let i = 0; i < 20; i++) ids.add(storeMod.genTaskId([]));
  assert.strictEqual(ids.size, 20);
});

// ---------- v2.9.9 纪要删除（重复同步/误入池清理口） ----------

test('v2.9.9 删除纪要：DELETE 后列表不再包含、重复删除 404', async () => {
  // Arrange：确保池内至少一条（fixture 同步哈希幂等，重同步 0 新增）
  const sync = await api('POST', '/api/radar/sync', {});
  assert.strictEqual(sync.status, 202);
  await waitJob(sync.body.jobId);
  const before = await api('GET', '/api/radar/messages');
  assert.strictEqual(before.status, 200);
  const target = before.body[0];
  assert.ok(target, '夹具同步应至少产出一条纪要');

  // Act
  const del = await api('DELETE', `/api/radar/messages/${encodeURIComponent(target.id)}`);

  // Assert：删除成功；列表不再包含；重复删除 404 MESSAGE_NOT_FOUND
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.ok, true);
  assert.strictEqual(del.body.deleted, target.id);
  const after = await api('GET', '/api/radar/messages');
  assert.strictEqual(after.status, 200);
  assert.ok(!after.body.some((m) => m.id === target.id), '删除后列表不应再包含该纪要');
  const again = await api('DELETE', `/api/radar/messages/${encodeURIComponent(target.id)}`);
  assert.strictEqual(again.status, 404);
  assert.strictEqual(again.body.error.code, 'MESSAGE_NOT_FOUND');
});
