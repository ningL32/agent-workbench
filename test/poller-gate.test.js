'use strict';

/**
 * poller-gate.test.js — issue #1（v2.9.81）：pollIntervalSec=0 必须关闭 Gitea 源轮询
 *
 * 回归的真实场景（业主在隔离演示实例上发现）：插件模式下 config.json 写
 * `gitea.pollIntervalSec: 0`，Gitea 轮询照样每 60s 跑一次，没有 Gitea 的实例每轮把
 * `data/gitea-status.json` 覆写成 `{ok:false}`——而 settings 的注释说 0 = 关闭。
 *
 * 根因：插件态 tick 由宿主 ctx.interval 固定驱动，pollOnce 无条件调 giteaClient.pollActivities；
 * `sec<=0` 的节流只存在于独立版 auto 模式的 reschedule 里。
 *
 * 修法语义（最小修复）：pollOnce 每轮读 ctx.config 实时判定「Gitea 源开/关」——
 *   插件态：tick 由宿主固定驱动，关闭态下跳过 Gitea 段（活动流 + 成员缓存），
 *           日报自动档/IM 摘要/自动备份/已启用的 GitHub、Gitee 源照常；PATCH 改值下一 tick 生效。
 *   独立版：0 = 轮询定时器不启动（历史语义不变）；运行中 PATCH 成 0 则定时器停。
 *
 * 判定手法：不挂 GITEA_FIXTURE、baseUrl 指向 .invalid 保留域（必然解析失败、零出网）——
 *   源开启 → pollActivities 失败 → 写 gitea-status.json {ok:false}（= issue 现象）
 *   源关闭 → 根本不调 pollActivities → 该文件不出现（零出网）
 *
 * ⏰ 时间依赖纪律：每个实例都带 DSH_FIXTURE——本地 ≥08:00 时 tick 内的日报自动档会真拉
 *    dsh 引擎子进程（不收割则测试进程挂死），fixture 让引擎路径短路。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildApp } = require('./helpers/appAssembler');

function makeApp(t, { pollIntervalSec, poller }) {
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
      // 不可解析主机（.invalid = RFC 2606 保留域，必然解析失败、零出网）：
      // 无 fixture、无凭据，pollActivities 一旦被调必然失败并落 {ok:false}
      gitea: { baseUrl: 'https://gitea.invalid', org: 'gate-org', hostWhitelist: ['gitea.invalid'], pollIntervalSec },
    })
  );
  const app = buildApp({
    poller,
    configPath: path.join(tmp, 'config.json'),
    // DSH_FIXTURE 随行：日报自动档在本地 ≥08:00 会经 maybeAutoDaily 真拉 dsh 引擎子进程
    env: { DSH_FIXTURE: path.join(__dirname, 'fixtures', 'dsh-ok.txt') },
    persistentEnv: true,
  });
  t.after(() => app.close());
  return { app, dataDir };
}

async function waitFor(file, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fs.existsSync(file);
}

test('issue#1 插件态 pollIntervalSec=0：tick 照跑但不碰 Gitea 源（不写 gitea-status.json）', async (t) => {
  // arrange
  const { app, dataDir } = makeApp(t, { pollIntervalSec: 0, poller: 'manual' });
  // act：模拟宿主连续三轮 60s tick
  for (let i = 0; i < 3; i++) await app.pollTick();
  await new Promise((r) => setTimeout(r, 300));
  // assert：源关闭 = pollActivities 一次都没调 → 状态文件不出现（issue 现象是每轮覆写 {ok:false}）
  assert.strictEqual(
    fs.existsSync(path.join(dataDir, 'gitea-status.json')), false,
    'pollIntervalSec=0 时不应触碰 Gitea 源（gitea-status.json 不应出现）'
  );
});

test('issue#1 插件态 pollIntervalSec>0：Gitea 源照常轮询（失败才落 ok:false，行为不变）', async (t) => {
  // arrange
  const { app, dataDir } = makeApp(t, { pollIntervalSec: 60, poller: 'manual' });
  // act
  await app.pollTick();
  // assert：源开启 → pollActivities 被调 → 不可达故失败 → 落 {ok:false}（与修复前一致，无行为变更）
  assert.strictEqual(
    await waitFor(path.join(dataDir, 'gitea-status.json'), 3000), true,
    'pollIntervalSec>0 时应照常轮询 Gitea 源'
  );
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'gitea-status.json'), 'utf8')).ok, false);
});

test('issue#1 插件态 PATCH pollIntervalSec 60→0：下一 tick 即关闭', async (t) => {
  // arrange
  const { app, dataDir } = makeApp(t, { pollIntervalSec: 0, poller: 'manual' });
  // act：先开启 → 一轮 tick（应触碰 Gitea 源）→ PATCH 关闭 → 再两轮 tick
  const on = await app.fetch('PATCH', '/api/settings', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gitea: { pollIntervalSec: 60 } }),
  });
  assert.strictEqual(on.status, 200);
  await app.pollTick();
  const touched = await waitFor(path.join(dataDir, 'gitea-status.json'), 3000);
  assert.strictEqual(touched, true, '开启后应触碰 Gitea 源');

  fs.rmSync(path.join(dataDir, 'gitea-status.json'), { force: true });
  const off = await app.fetch('PATCH', '/api/settings', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gitea: { pollIntervalSec: 0 } }),
  });
  assert.strictEqual(off.status, 200);
  for (let i = 0; i < 2; i++) await app.pollTick();
  await new Promise((r) => setTimeout(r, 300));
  // assert
  assert.strictEqual(
    fs.existsSync(path.join(dataDir, 'gitea-status.json')), false,
    'PATCH 为 0 后下一 tick 起不再触碰 Gitea 源'
  );
});

test('issue#1 独立版 auto 模式 pollIntervalSec=0：历史语义不变（定时器不启动、不碰 Gitea 源）', async (t) => {
  // arrange：独立版 0 = 轮询定时器整个不启动（既有配置语义，本次修复不改变）
  const { app, dataDir } = makeApp(t, { pollIntervalSec: 0, poller: 'auto' });
  // act：若定时器误启动，500ms 内 pollOnce 至少跑一轮并触碰 Gitea 源
  await new Promise((r) => setTimeout(r, 500));
  // assert
  assert.strictEqual(
    fs.existsSync(path.join(dataDir, 'gitea-status.json')), false,
    'auto 模式 pollIntervalSec=0 不应启动轮询（历史语义）'
  );
  // 重排为合法正值可随时开启（PATCH 入口仍在）
  assert.doesNotThrow(() => app.reschedulePoller(60));
});

test('issue#1 独立版 auto 模式运行中 PATCH 成 0：定时器停、不再碰 Gitea 源', async (t) => {
  // arrange：间隔 1s 起轮询
  const { app, dataDir } = makeApp(t, { pollIntervalSec: 1, poller: 'auto' });
  // act：等首轮触碰（证明轮询确实在跑）→ PATCH 关闭
  const touched = await waitFor(path.join(dataDir, 'gitea-status.json'), 4000);
  assert.strictEqual(touched, true, '开启态应触碰 Gitea 源');
  const off = await app.fetch('PATCH', '/api/settings', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gitea: { pollIntervalSec: 0 } }),
  });
  assert.strictEqual(off.status, 200);
  await new Promise((r) => setTimeout(r, 1500)); // 越过原 1s 节拍
  fs.rmSync(path.join(dataDir, 'gitea-status.json'), { force: true });
  await new Promise((r) => setTimeout(r, 1500));
  // assert：关闭后两个原节拍周期内文件不再出现
  assert.strictEqual(
    fs.existsSync(path.join(dataDir, 'gitea-status.json')), false,
    'PATCH 为 0 后定时器应停、不再触碰 Gitea 源'
  );
});
