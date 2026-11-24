'use strict';

/**
 * poller-gate.test.js — issue #1（v2.9.81）：插件模式尊重 gitea.pollIntervalSec，0 = 关闭轮询器
 *
 * 回归的真实场景（issue #1，隔离演示实例上发现）：插件模式下 config.json 写
 * `gitea.pollIntervalSec: 0`，Gitea 轮询照样每 60s 跑一次并把 data/gitea-status.json 覆写成
 * {ok:false}——顶栏因此恒显示「Gitea 异常」且关不掉；而 settings 的注释说 0 = 关闭轮询器。
 * 根因：插件态 tick 由宿主 ctx.interval 固定 60s 驱动，间隔节流只存在于独立版的 reschedule。
 *
 * 修法（issue 建议的方案，保持文档契约）：两种模式对 pollIntervalSec 同语义——
 *   >0 = 轮询器间隔（秒）；0 = 关闭轮询器（整个 pollOnce 不执行，含日报/摘要/备份等 tick 职责）。
 *   插件态在每次宿主 tick 上按「距上次运行是否已满间隔」决定跑不跑（实际间隔 = max(配置, 宿主 60s）。
 *   另：GET /api/overview 的 gitea 增 disabled 字段，界面据它显示中性态而不是「异常」。
 *
 * 零出网手法：Gitea baseUrl 指向白名单外主机——pollActivities 出站前的首道守卫即抛
 * HOST_NOT_ALLOWED（不发任何请求），随后照常落 gitea-status.json {ok:false}，正好复刻 issue 里
 * 「每次失败都覆写 {ok:false}」的现象。时钟经 buildApp({ now }) 注入，不依赖真实时间。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildApp } = require('./helpers/appAssembler');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可拨动的假时钟（轮询器的间隔判定只认它） */
function fakeClock(start = 1700000000000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
  };
}

function makeApp(t, { pollIntervalSec, poller, clock }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-gate-'));
  t.after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      /* Windows EPERM 容错 */
    }
  });
  const dataDir = path.join(tmp, 'data');
  fs.writeFileSync(
    path.join(tmp, 'config.json'),
    JSON.stringify({
      host: '127.0.0.1',
      dataDir,
      webDir: path.join(tmp, 'web'),
      gitea: {
        baseUrl: 'https://gitea.example.com',
        org: 'example-org',
        // 白名单故意不含 baseUrl 的主机：守卫在出站前快速失败（零网络）
        hostWhitelist: ['not-the-gitea-host.example.com'],
        pollIntervalSec,
      },
    })
  );
  const app = buildApp({
    poller,
    configPath: path.join(tmp, 'config.json'),
    // DSH_FIXTURE 随行作保险：本夹具的 Gitea 轮询在首行即抛错，tick 的副业不会执行；
    // 万一执行到日报自动档，fixture 让引擎路径短路（绝不 spawn 真引擎）
    env: { DSH_FIXTURE: path.join(__dirname, 'fixtures', 'dsh-ok.txt') },
    persistentEnv: true,
    now: clock.now,
  });
  t.after(() => app.close());
  const statusFile = path.join(dataDir, 'gitea-status.json');
  const exists = () => fs.existsSync(statusFile);
  const forget = () => fs.rmSync(statusFile, { force: true });
  const patchInterval = (sec) => app.fetch('PATCH', '/api/settings', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gitea: { pollIntervalSec: sec } }),
  });
  return { app, dataDir, statusFile, exists, forget, patchInterval };
}

const HOST_TICK = 60_000; // 宿主 ctx.interval 的固定节拍（plugin/index.mjs）

test('issue#1 插件态 pollIntervalSec=0：轮询器关闭——不再触碰 Gitea，状态标 disabled', async (t) => {
  // arrange
  const f = makeApp(t, { pollIntervalSec: 0, poller: 'manual', clock: fakeClock() });
  // act：模拟宿主三轮 tick
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await f.app.pollTick());
  // assert
  assert.deepEqual(results, ['disabled', 'disabled', 'disabled']);
  assert.strictEqual(f.exists(), false, '关闭态不应触碰 Gitea（issue 现象是每轮覆写 {ok:false}）');
  const ov = await f.app.fetch('GET', '/api/overview');
  assert.strictEqual(ov.body.gitea.disabled, true, 'overview.gitea.disabled——界面据此显示中性态而非「异常」');
});

test('issue#1 插件态 pollIntervalSec=60：距上次运行不满 60s 的宿主 tick 被跳过', async (t) => {
  // arrange
  const clock = fakeClock();
  const f = makeApp(t, { pollIntervalSec: 60, poller: 'manual', clock });
  // act / assert：首个宿主 tick 即运行（与修复前一致）
  assert.strictEqual(await f.app.pollTick(), 'ran');
  assert.strictEqual(f.exists(), true, '运行过的证据：Gitea 守卫失败已落 gitea-status.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(f.statusFile, 'utf8')).ok, false);
  // 紧接着的宿主 tick：未满间隔 → 跳过，且确实没有执行（删掉状态文件后不再出现）
  f.forget();
  clock.advance(HOST_TICK - 1);
  assert.strictEqual(await f.app.pollTick(), 'skipped');
  assert.strictEqual(f.exists(), false, '被跳过的 tick 不得执行 pollOnce');
  // 满 60s → 再次运行
  clock.advance(1);
  assert.strictEqual(await f.app.pollTick(), 'ran');
  assert.strictEqual(f.exists(), true);
});

test('issue#1 插件态尊重间隔数值：pollIntervalSec=300 时每 5 个宿主 tick 才运行一次', async (t) => {
  // arrange：issue「Why it matters」第二条——副业不该无视配置的间隔每拍都触发
  const clock = fakeClock();
  const f = makeApp(t, { pollIntervalSec: 300, poller: 'manual', clock });
  assert.strictEqual(await f.app.pollTick(), 'ran');
  f.forget();
  // act / assert
  for (let i = 1; i <= 4; i++) {
    clock.advance(HOST_TICK);
    assert.strictEqual(await f.app.pollTick(), 'skipped', `第 ${i} 拍（${i * 60}s）未满 300s`);
    assert.strictEqual(f.exists(), false, `第 ${i} 拍不得执行`);
  }
  clock.advance(HOST_TICK);
  assert.strictEqual(await f.app.pollTick(), 'ran', '满 300s 的宿主 tick 运行');
  assert.strictEqual(f.exists(), true);
});

test('issue#1 插件态 PATCH pollIntervalSec：下一宿主 tick 生效（0↔60），overview.gitea.disabled 同步翻转', async (t) => {
  // arrange
  const clock = fakeClock();
  const f = makeApp(t, { pollIntervalSec: 0, poller: 'manual', clock });
  assert.strictEqual(await f.app.pollTick(), 'disabled');
  // act：开启
  assert.strictEqual((await f.patchInterval(60)).status, 200);
  // assert
  assert.strictEqual((await f.app.fetch('GET', '/api/overview')).body.gitea.disabled, false);
  assert.strictEqual(await f.app.pollTick(), 'ran', 'PATCH 后下一宿主 tick 即运行');
  f.forget();
  clock.advance(HOST_TICK);
  assert.strictEqual(await f.app.pollTick(), 'ran', '开启后按间隔持续运行');
  // act：关闭
  assert.strictEqual((await f.patchInterval(0)).status, 200);
  // assert
  assert.strictEqual((await f.app.fetch('GET', '/api/overview')).body.gitea.disabled, true);
  f.forget();
  clock.advance(3600_000); // 即使过了很久
  assert.strictEqual(await f.app.pollTick(), 'disabled');
  assert.strictEqual(f.exists(), false, '关闭后不再触碰 Gitea');
});

test('issue#1 关闭态下残留的旧失败状态如实带出 disabled（界面不再被染红）', async (t) => {
  // arrange：修复前留下的失败状态——issue 里那台演示实例的现场
  const f = makeApp(t, { pollIntervalSec: 0, poller: 'manual', clock: fakeClock() });
  fs.mkdirSync(path.dirname(f.statusFile), { recursive: true }); // 关闭态下还没人建过 data/
  fs.writeFileSync(
    f.statusFile,
    JSON.stringify({ ok: false, lastPollAt: '2026-11-22T06:00:00.000Z', lastError: 'getaddrinfo ENOTFOUND gitea' })
  );
  // act
  const ov = await f.app.fetch('GET', '/api/overview');
  // assert：ok/lastError 如实保留（不篡改历史），只增 disabled 供界面判定
  assert.deepStrictEqual(ov.body.gitea, {
    ok: false,
    lastPollAt: '2026-11-22T06:00:00.000Z',
    lastError: 'getaddrinfo ENOTFOUND gitea',
    disabled: true,
  });
});

test('issue#1 时钟回拨不会让轮询器永久跳过', async (t) => {
  // arrange：本机有过系统时钟跳变的先例——elapsed 为负时不能一直判「未满间隔」
  const clock = fakeClock();
  const f = makeApp(t, { pollIntervalSec: 60, poller: 'manual', clock });
  assert.strictEqual(await f.app.pollTick(), 'ran');
  // act：回拨一小时
  clock.set(clock.now() - 3600_000);
  // assert
  assert.strictEqual(await f.app.pollTick(), 'ran', '回拨后按「从未运行」处理');
  assert.strictEqual(await f.app.pollTick(), 'skipped', '随后恢复按间隔节流');
});

test('issue#1 独立版 auto 模式语义不变：0 = 定时器不启动；运行中 PATCH 成 0 = 定时器停', async (t) => {
  // arrange (a)：0 → 不启动
  const a = makeApp(t, { pollIntervalSec: 0, poller: 'auto', clock: fakeClock() });
  await sleep(400);
  assert.strictEqual(a.exists(), false, 'auto 模式 pollIntervalSec=0 不启动轮询（历史语义）');
  // arrange (b)：1s → 运行
  const b = makeApp(t, { pollIntervalSec: 1, poller: 'auto', clock: fakeClock() });
  const deadline = Date.now() + 4000;
  while (!b.exists() && Date.now() < deadline) await sleep(100);
  assert.strictEqual(b.exists(), true, '开启态应运行轮询');
  // act：PATCH 关闭
  assert.strictEqual((await b.patchInterval(0)).status, 200);
  await sleep(1500); // 让在途的一轮跑完
  b.forget();
  await sleep(1500); // 越过原 1s 节拍
  // assert
  assert.strictEqual(b.exists(), false, 'PATCH 为 0 后定时器应停');
  assert.strictEqual((await b.app.fetch('GET', '/api/overview')).body.gitea.disabled, true);
});
