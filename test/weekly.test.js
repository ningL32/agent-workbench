'use strict';

/**
 * weekly.test.js — v2.9.5 数字员工周报：
 *   养料聚合（会话注入时间窗 / bot 提交滤除 / 任务动态 / 日报）、prompt 构造、
 *   围栏清理、路由全链（404 → DSH_FIXTURE 生成 → job 轮询 → GET 周报）。
 * 会话收集器经 opts.listSessions 注入（聚合逻辑确定性单测；真实六源列表已有
 * agent-sessions.test.js 覆盖）；路由夹具六源全部指向不存在路径（单源隔离 → 全缺席）。
 * 纪律：全合成夹具零出网；DSH_FIXTURE 替代引擎 stdout；after 统一清理。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildApp } = require('./helpers/appAssembler');
const { collectWeeklyFacts, buildWeeklyPrompt, cleanReport, maybeAutoDaily, localYmd, naturalRange } = require('../lib/weekly');
const jobs = require('../lib/jobs');

const PORT = 7799; // 仅作 fixture 配置留痕（进程内装配不再监听端口）

let app;
let tmpDir;
let dataDir;

const NOW = Date.now();
const DAY = 24 * 3600 * 1000;
// 自然日确定性锚：昨日 12:00 恒在昨日窗内；「今日锚」恒为今日内的过去时刻。
// 修日期边界翻转脆弱（v2.9.18 期发现）：原锚固定今日 01:00，00:00–01:00 区间跑测试时
// 会落在滚动窗 until(=now+60s) 之外导致「今日会话B」被过滤——钳到 min(今日01:00, now-60s) 且不早于今日 00:00:01
const TODAY00 = (() => { const d = new Date(NOW); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const YD_NOON = TODAY00 - 12 * 3600e3;
const TD_ONE = Math.max(TODAY00 + 1e3, Math.min(TODAY00 + 1 * 3600e3, NOW - 60e3));
const LAST_MONDAY = (() => { const d = new Date(TODAY00); const dow = (d.getDay() + 6) % 7; return d.getTime() - (dow + 7) * DAY; })(); // 上周一（本周一再减 7 天）

/** 注入用会话收集器（自然日锚，新→旧）：昨日 12:00 / 今日凌晨（恒在过去）/ 9 天前；其余源缺席；带 ref 供内容萃取 */
function fakeListSessions(agent, cursor) {
  if (agent !== 'zcode') return { items: [], nextCursor: null };
  // 新→旧排序（真实接口口径，AGENTS 坑 6）：今日会话在最前——
  // 2026-11-03 真机事故回归锚：旧实现「出窗即止」被比窗口新的首条直接止住整源（日报采 zcode/codex 全 0）
  const items = [
    { ref: 'r2', title: '今日会话B', projectId: 'E:\\projB', state: 'idle', lastActiveAt: new Date(TD_ONE).toISOString() },
    { ref: 'r1', title: '昨日会话A', projectId: 'E:\\projA', state: 'idle', lastActiveAt: new Date(YD_NOON).toISOString() },
    { ref: 'r3', title: '太老的会话', projectId: 'E:\\projA', state: 'idle', lastActiveAt: new Date(NOW - 9 * DAY).toISOString() },
  ];
  return { items, nextCursor: null };
}

/** 注入用转录取样：r1 有完整首问末答；r2 模拟无转录源 degraded；r3 抛错（单会话失败跳过） */
function fakeGetTranscript(ref) {
  if (ref === 'r1') {
    return { messages: [
      { seq: 1, role: 'user', text: '# 任务 FDE 指挥台周报功能（会话数据做养料，引擎蒸馏）' },
      { seq: 2, role: 'assistant', text: '已完成聚合端点与总览面板，320 测试绿' },
    ] };
  }
  if (ref === 'r2') return { degraded: true, reason: 'SOURCE_NO_TRANSCRIPT', messages: [] };
  throw new Error('转录损坏');
}

function writeData(file, obj) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(obj));
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-weekly-'));
  dataDir = path.join(tmpDir, 'data');
  const nope = path.join(tmpDir, 'no-such');
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    port: PORT,
    host: '127.0.0.1',
    dataDir,
    webDir: path.join(tmpDir, 'web'),
    gitea: { pollIntervalSec: 0 },
    agentActivity: { sources: {
      zcode: { root: nope },
      claude: { root: nope },
      dsh: { root: nope },
      codex: { root: nope },
      opencode: { dbPath: `${nope}.db` },
      workbuddy: { dbPath: `${nope}.db` },
    } },
  }));
  app = buildApp({ configPath: path.join(tmpDir, 'config.json') });

  // Gitea 活动：2 条真人（不同 actor）+ 1 条 bot（须滤除）
  writeData('activities.json', [
    { id: 'a-1', type: 'commit', actor: 'zhaoliu', repo: 'example-org/x', branch: 'f', title: 'feat: 真人提交一', url: 'https://x/1', occurredAt: new Date(NOW - 3600e3).toISOString(), fetchedAt: new Date(NOW).toISOString() },
    { id: 'a-2', type: 'pr', actor: 'wangwu', repo: 'example-org/x', branch: null, title: 'PR #7', url: 'https://x/2', occurredAt: new Date(NOW - 2 * 3600e3).toISOString(), fetchedAt: new Date(NOW).toISOString() },
    { id: 'a-3', type: 'commit', actor: 'zhangsan', repo: 'example-org/x', branch: 'f', title: '[demo-team] Update session stats', url: 'https://x/3', occurredAt: new Date(NOW - 3 * 3600e3).toISOString(), fetchedAt: new Date(NOW).toISOString() },
  ]);
  // 人工日报：挂在稍后创建的任务上（updatedAt 在窗内）
  writeData('diary.json', [
    { taskId: 'PLACEHOLDER', date: '2026-10-22', content: '完成了周报功能的聚合端点', updatedAt: new Date(NOW - 4 * 3600e3).toISOString() },
  ]);
});

test.after(() => {
  if (app) app.close();
});

async function api(method, p, body) {
  return app.fetch(method, p, {
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('collectWeeklyFacts：四路养料聚合（会话时间窗/bot 滤除/任务/日报）', async () => {
  // 任务：一完成（completedAt=now 在窗内）一进行中
  const t1 = await api('POST', '/api/tasks', { title: '已完成任务甲' });
  await api('PATCH', `/api/tasks/${t1.body.id}`, { status: 'done' });
  const t2 = await api('POST', '/api/tasks', { title: '进行中任务乙' });
  await api('PATCH', `/api/tasks/${t2.body.id}`, { status: 'doing' });
  // 日报挂到已完成任务
  const diary = JSON.parse(fs.readFileSync(path.join(dataDir, 'diary.json'), 'utf8'));
  diary[0].taskId = t1.body.id;
  writeData('diary.json', diary);

  const facts = collectWeeklyFacts(app.ctx, { now: NOW + 60000, listSessions: fakeListSessions, getTranscript: fakeGetTranscript });
  // ① 会话：7 天滚动窗 2 条（昨日+今日；9 天前出局），agent 归属正确
  assert.strictEqual(facts.sessions.length, 2, `滚动窗会话应 2 条，实际 ${facts.sessions.length}`);
  assert.ok(facts.sessions.every((s) => s.agent === 'zcode'));
  assert.ok(facts.sessions.some((s) => s.title === '昨日会话A'));
  assert.strictEqual(facts.stats.perAgent.zcode, 2);
  assert.strictEqual(facts.stats.perAgent.codex, 0, '缺席源计 0');
  // ①b 内容萃取：r1 抽到首问⇒末答，r2 degraded / r3 抛错均跳过不炸
  assert.strictEqual(facts.stats.contentSessions, 1);
  const sa = facts.sessions.find((s) => s.title === '昨日会话A');
  assert.ok(sa.digest.includes('周报功能'), '首问进摘要');
  assert.ok(sa.digest.includes('320 测试绿'), '末答进摘要');
  assert.ok(sa.digest.includes('⇒'), '首问⇒末答连接');
  // v2.9.6 日报自然窗（昨日 00:00 → 今日 00:00）：今日 01:00 的会话严格出局（不混入名义周期外数据）
  const dailyFacts = collectWeeklyFacts(app.ctx, { now: NOW + 60000, range: naturalRange('daily', NOW), listSessions: fakeListSessions, getTranscript: fakeGetTranscript });
  assert.strictEqual(dailyFacts.sessions.length, 1, '昨日自然窗应 1 条');
  assert.ok(dailyFacts.sessions.some((s) => s.title === '昨日会话A'));
  assert.ok(!dailyFacts.sessions.some((s) => s.title === '今日会话B'), '今日会话不得混入昨日日报');
  assert.strictEqual(dailyFacts.stats.perAgent.zcode, 1, '比窗口新的首条只能跳过不能止住整源（2026-11-03 日报 zcode/codex 全 0 事故回归）');
  // 周报自然窗（上周一 00:00 → 本周一 00:00）：不变式=任何 lastActiveAt ≥ 本周一的会话绝不入上周报。
  // 修 v2.9.18 期发现的潜伏断言反转：原比对 < LAST_MONDAY（=窗起点上周一）语义颠倒——
  // 上周报的会话天然 ≥ 上周一，只有周一运行才暴露（其余六天窗内空集空洞通过）。正确边界=本周一（until）
  const wkFacts = collectWeeklyFacts(app.ctx, { now: NOW + 60000, range: naturalRange('weekly', NOW), listSessions: fakeListSessions, getTranscript: fakeGetTranscript });
  assert.ok(wkFacts.sessions.every((s) => Date.parse(s.lastActiveAt) < TODAY00), '上周报不得含本周及以后会话');
  // 上界必须是「本周一 00:00」而不是 LAST_MONDAY：周二~周日时上周窗内没有夹具会话，
  // every 空集恒真，边界写错也一直绿；只有周一「昨日=周日」落进上周窗才暴露。
  assert.ok(
    wkFacts.sessions.every((s) => Date.parse(s.lastActiveAt) >= LAST_MONDAY),
    '上周报不得早于上周一（窗口下界）'
  );
  assert.ok(!wkFacts.sessions.some((s) => s.title === '今日会话B'), '今日会话不得混入上周周报');
  // ② 提交：bot 出局，按 actor 汇总
  assert.strictEqual(facts.stats.commitsTotal, 2);
  const zhaoliu = facts.commits.find((c) => c.actor === 'zhaoliu');
  assert.ok(zhaoliu && zhaoliu.count === 1 && zhaoliu.titles[0].includes('真人提交一'));
  assert.ok(!facts.commits.some((c) => c.actor === 'zhangsan'), '[demo-team] bot 须滤除');
  // ③④ 任务与日报
  assert.strictEqual(facts.stats.doneTotal, 1);
  assert.strictEqual(facts.stats.doingTotal, 1);
  assert.strictEqual(facts.stats.diaryTotal, 1);
  assert.strictEqual(facts.diaries[0].taskTitle, '已完成任务甲');
});

test('buildWeeklyPrompt：结构齐备、会话行与 bot 滤除生效', () => {
  const facts = collectWeeklyFacts(app.ctx, { now: NOW + 60000, listSessions: fakeListSessions, getTranscript: fakeGetTranscript });
  const p = buildWeeklyPrompt(facts);
  assert.ok(p.includes('【素材 · 数字员工会话】'));
  assert.ok(p.includes('昨日会话A'));
  assert.ok(p.includes('内容：# 任务 FDE 指挥台周报功能'), '内容摘要是归纳主要依据（业主拍板依靠对话内容）');
  assert.ok(p.includes('320 测试绿'));
  assert.ok(p.includes('【素材 · Gitea 提交/PR（已滤机器人）】'));
  assert.ok(!p.includes('demo-team'), 'bot 提交不得进 prompt');
  assert.ok(p.includes('已完成任务甲'));
  assert.ok(p.includes('只依据素材事实'), '防编造约束在列');
});

test('cleanReport：去首尾代码围栏', () => {
  assert.strictEqual(cleanReport('```markdown\n## 周报\n- a\n```'), '## 周报\n- a');
  assert.strictEqual(cleanReport('  ## 直接正文  '), '## 直接正文');
});

test('naturalRange(weekly)：周一到周日任一天，窗口恒为「上周一 00:00 → 本周一 00:00」', () => {
  // 2026-10-26 是周一：周一当天最容易把「本周一 00:00」写成「今天此刻」或「上周一」
  const monday = new Date(2026, 9, 26, 9, 39, 0, 0).getTime();
  const r = naturalRange('weekly', monday);
  assert.strictEqual(new Date(r.since).getTime(), new Date(2026, 9, 19, 0, 0, 0, 0).getTime(), '下界=上周一 00:00');
  assert.strictEqual(new Date(r.until).getTime(), new Date(2026, 9, 26, 0, 0, 0, 0).getTime(), '上界=本周一 00:00');
  // 同一周内换个钟点（周三 23:59）窗口不变
  const wednesdayLate = new Date(2026, 9, 28, 23, 59, 0, 0).getTime();
  assert.deepStrictEqual(naturalRange('weekly', wednesdayLate), r);
});

test('路由全链：未生成 404 → DSH_FIXTURE 生成 → job 轮询 done → GET 周报 200', async () => {
  const before = await api('GET', '/api/weekly');
  assert.strictEqual(before.status, 404);
  assert.strictEqual(before.body.error.code, 'WEEKLY_NOT_FOUND');

  const fix = path.join(tmpDir, 'dsh-fixture.txt');
  fs.writeFileSync(fix, '## 本周周报\n- 亮点一：周报功能上线\n', 'utf8');
  process.env.DSH_FIXTURE = fix;
  try {
    const r = await api('POST', '/api/weekly/generate');
    assert.strictEqual(r.status, 202);
    assert.ok(r.body.jobId);
    // 轮询 job（fixture 模式即刻完成）
    let job = null;
    for (let i = 0; i < 100; i++) {
      job = jobs.getJob(r.body.jobId);
      if (job && job.state !== 'running') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.ok(job, 'job 存在');
    assert.strictEqual(job.state, 'done');
    assert.strictEqual(job.results[0].ok, true);

    const w = await api('GET', '/api/weekly');
    assert.strictEqual(w.status, 200);
    assert.ok(w.body.report.includes('亮点一'), 'report 来自引擎 stdout（fixture 文本）');
    assert.strictEqual(w.body.stats.sessionsTotal, 0, '夹具源全缺席 → 会话 0（隔离不拖垮生成）');
    // v2.9.6 口径：周报=上周自然周，weekKey=上周一（严格不含本周数据）
    assert.strictEqual(w.body.weekKey, localYmd(new Date(LAST_MONDAY)), 'weekKey 必须是上周一');
  } finally {
    delete process.env.DSH_FIXTURE;
  }
});

// ---------- v2.9.6 数字员工日报（自动档 + daily 路由） ----------

test('v2.9.6 日报路由全链：404 → DSH_FIXTURE 生成 → dayKey=今天；自动档守卫（too-early/exists/throttled）', async () => {
  const before = await api('GET', '/api/daily');
  assert.strictEqual(before.status, 404);
  assert.strictEqual(before.body.error.code, 'DAILY_NOT_FOUND');

  const fix = path.join(tmpDir, 'dsh-fixture-daily.txt');
  fs.writeFileSync(fix, '## 日报\n- 昨日完成周报内容萃取\n', 'utf8');
  process.env.DSH_FIXTURE = fix;
  try {
    // 手动生成日报（与周报同管线，走 /api/daily/*）
    const r = await api('POST', '/api/daily/generate');
    assert.strictEqual(r.status, 202);
    let job = null;
    for (let i = 0; i < 100; i++) {
      job = jobs.getJob(r.body.jobId);
      if (job && job.state !== 'running') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.strictEqual(job.state, 'done');
    const w = await api('GET', '/api/daily');
    assert.strictEqual(w.status, 200);
    assert.ok(w.body.report.includes('昨日完成'));
    // v2.9.6 口径：日报=昨日自然日，dayKey=昨天；generatedDay=今天（自动档守卫键）
    assert.strictEqual(w.body.dayKey, localYmd(new Date(TODAY00 - DAY)), 'dayKey 必须是昨天');
    assert.strictEqual(w.body.generatedDay, localYmd(), 'generatedDay 必须是今天');

    // 自动档守卫①：今天已生成（generatedDay=今天）→ exists（不再烧引擎）
    const d = new Date();
    const todayNoon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).getTime();
    assert.strictEqual(await maybeAutoDaily(app.ctx, { now: todayNoon }), 'exists');

    // 自动档守卫②：未到 08:00 → too-early（清掉今日文件后验证）
    fs.rmSync(path.join(dataDir, 'report-daily.json'));
    const today7am = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 7, 0, 0).getTime();
    assert.strictEqual(await maybeAutoDaily(app.ctx, { now: today7am }), 'too-early');
    assert.ok(!fs.existsSync(path.join(dataDir, 'report-daily.json')), 'too-early 不得生成');

    // 自动档守卫③：到点且无今日文件 → generated（fixture 离线）
    assert.strictEqual(await maybeAutoDaily(app.ctx, { now: todayNoon }), 'generated');
    assert.ok(fs.existsSync(path.join(dataDir, 'report-daily.json')));

    // 自动档守卫④：删除文件后 1h 内重试 → throttled（不烧引擎）
    fs.rmSync(path.join(dataDir, 'report-daily.json'));
    assert.strictEqual(await maybeAutoDaily(app.ctx, { now: todayNoon }), 'throttled');
  } finally {
    delete process.env.DSH_FIXTURE;
  }
});
