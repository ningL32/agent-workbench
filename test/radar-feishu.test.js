'use strict';

/**
 * radar-feishu.test.js — 飞书妙记通道装配链（LARK_FIXTURE 全离线）
 * 覆盖：POST /api/radar/sync/feishu 202→job 终态、消息入池（source:'feishu' 徽标字段）、
 *       哈希防重（二次同步 skippedExisting）、ref.url 白名单丢弃、逐字稿缺失留痕、
 *       通道关闭 RADAR_DISABLED、引擎健康 feishu 节。
 * 运行：node --test test/radar-feishu.test.js （LARK_FIXTURE 零进程零出网）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7801; // 仅作 fixture 配置留痕（进程内装配不再监听端口）
const FIX = (f) => path.join(__dirname, 'fixtures', f);

const { buildApp } = require('./helpers/appAssembler');

let app;
let tmpDir;

async function api(method, p, body, headers = {}) {
  return app.fetch(method, p, {
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 轮询 job 终态（与 radar.test.js 同口径；20s 上限） */
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
  tmpDir = fs.mkdtempSync(tmpTemplate());
  const dataDir = path.join(tmpDir, 'data');
  fs.writeFileSync(path.join(tmpDir, 'members.json'), JSON.stringify({ members: [] }));
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({
      port: PORT,
      host: '127.0.0.1',
      dataDir,
      webDir: path.join(tmpDir, 'web'),
      gitea: { pollIntervalSec: 0 },
      // feishu 节显式开启（默认关闭——未配置 lark-cli 的机器 = 功能不存在）；
      // 磁盘缺节的默认注入回归由 settings/migrate 既有用例覆盖
      analyze: { timeoutSec: 120 },
      feishu: { enabled: true },
    })
  );
  app = buildApp({
    configPath: path.join(tmpDir, 'config.json'),
    env: {
      LARK_FIXTURE: FIX('feishu.json'),
    },
    persistentEnv: true, // 同步 job 在响应之后异步执行并读 env（close 还原）
  });
});

function tmpTemplate() {
  return path.join(os.tmpdir(), 'fde-feishu-');
}

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* EPERM 容错 */ }
});

// ------------------------------------------------------------ 同步入池

test('同步 → 202 → job done → 4 条列表、2 入池、2 留痕（白名单 + 缺逐字稿）', async () => {
  const r = await api('POST', '/api/radar/sync/feishu');
  assert.strictEqual(r.status, 202);
  assert.ok(r.body.jobId);
  const job = await waitJob(r.body.jobId);
  assert.strictEqual(job.state, 'partial'); // 有 failed → partial
  const sync = job.results.find((x) => x.item === 'sync-feishu');
  assert.strictEqual(sync.total, 4);
  assert.strictEqual(sync.added, 2);
  assert.strictEqual(sync.failed.length, 2);
  const reasons = sync.failed.map((f) => f.error).join('|');
  assert.ok(/白名单/.test(reasons), '钓鱼域应有白名单留痕');
  assert.ok(/逐字稿缺失/.test(reasons), '无逐字稿条目应留痕');
});

test('入池消息形态：source=feishu、说话人分段解析正确、内容行【raw】text', async () => {
  const r = await api('GET', '/api/radar/messages');
  assert.strictEqual(r.status, 200);
  const mine = r.body.filter((m) => m.source === 'feishu');
  assert.strictEqual(mine.length, 2);
  const week = mine.find((m) => m.ref.minuteToken === 'obcfixture0001aaaa');
  assert.ok(week);
  assert.strictEqual(week.title, '产品周会'); // display_info 首行
  assert.strictEqual(week.segmentCount, 2); // Speaker 1 + Speaker 2（真实口径）
  const detail = await api('GET', `/api/radar/messages/${week.id}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.source, 'feishu');
  assert.strictEqual(detail.body.speakerSegments[0].raw, 'Speaker 1');
  // 时区无关断言：期望值由夹具开始时刻（2026.11.01 09:00:00 本地）+ 行内偏移 2.5s 现算（评审 P2）
  const anchorMs = new Date(2026, 10, 1, 9, 0, 0).getTime();
  assert.strictEqual(detail.body.speakerSegments[0].at, new Date(anchorMs + 2500).toISOString());
  assert.ok(detail.body.speakerSegments[1].text.includes('补充一下'));
  assert.ok(detail.body.content.startsWith('【Speaker 1】'));
});

test('哈希防重：二次同步 added=0、skippedExisting=2（增量锚点生效）', async () => {
  const r = await api('POST', '/api/radar/sync/feishu');
  assert.strictEqual(r.status, 202);
  const job = await waitJob(r.body.jobId);
  const sync = job.results.find((x) => x.item === 'sync-feishu');
  assert.strictEqual(sync.added, 0);
  assert.strictEqual(sync.skippedExisting, 2);
  assert.strictEqual(sync.skippedIgnored, 0);
});

// ------------------------------------------------------------ 关闭态与健康节

test('通道关闭：syncMessages 直接抛 RADAR_DISABLED（409 语义，路由层转 job failed）', async () => {
  const feishu = require('../lib/feishu');
  await assert.rejects(
    () => feishu.syncMessages({ config: { feishu: { enabled: false } } }),
    (e) => e.code === 'RADAR_DISABLED' && /飞书通道未启用/.test(e.message)
  );
});

test('引擎健康节：feishu.enabled/fixtureMode 如实带出（设置页引擎状态灯数据源）', async () => {
  const r = await api('GET', '/api/radar/engine');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.feishu.enabled, true);
  assert.strictEqual(r.body.feishu.fixtureMode, true); // LARK_FIXTURE 经 persistentEnv 在分发期注入
  // larkBin 为机器相关态（本机装了 CLI 就是真实路径，没装是 null）——只断言形态不锁具体值
  assert.ok(r.body.feishu.larkBin === null || /lark-cli\.exe$/i.test(String(r.body.feishu.larkBin)));
});