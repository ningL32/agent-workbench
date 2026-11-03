'use strict';

/**
 * migrate.test.js — WP5 数据迁移脚本（scripts/migrate-data.js）
 * 覆盖：pluginDefaultConfig 模板形状（无 port/host、绝对 dataDir/webDir、security.trustedHosts、
 *       不污染 store.DEFAULT_CONFIG）、resolveHome/resolveBase（DSH_HOME 跟随 / 删除回退 ~/.dsh /
 *       base 覆盖）、首次迁移落位（data 子树 + agents/members + config 剥 port/host 与绝对路径
 *       重写）、幂等重跑全 SKIP 且 config 不变、已有目标哨兵不被覆盖、深合并（独有键保留 +
 *       源数组键整体覆盖）、dry-run 零写入且 status 与实跑一致、源 config 损坏 ERR 回退默认模板、
 *       main() CLI 退出码（正常 0 / 含 ERR 1）与 [OK]/[SKIP]/[ERR] 行输出、
 *       v2.2：遗留 gateway 节一律剥除（网关集成已移除）。
 * 纪律：全部临时目录（os.tmpdir() + mkdtemp），after 统一清理；绝不触碰仓库真实 data/ 与真实 DSH_HOME。
 * 运行：node --test test/migrate.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate-data.js');
const mig = require('../scripts/migrate-data.js'); // TDD 红：实现前 require 失败
const { DEFAULT_CONFIG } = require('../lib/store.js');

// 临时根：每个用例独立 case-* 子目录；after 统一清理
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-migrate-'));

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function caseDir(name) {
  return fs.mkdtempSync(path.join(tmpRoot, `${name}-`));
}

/** 标准源目录：data/ 子树 + agents/members + 带 port/host 与自定义 dingtalk.dwsBin 的 config */
function makeSource(root, cfgExtra) {
  fs.mkdirSync(path.join(root, 'data', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'sessions.json'), JSON.stringify({ sessions: [{ id: 's-1' }] }));
  fs.writeFileSync(path.join(root, 'data', 'tasks', 'tasks.json'), JSON.stringify({ tasks: [{ id: 't-1' }] }));
  fs.writeFileSync(path.join(root, 'agents.json'), JSON.stringify({ agents: [{ id: 'opencode', name: 'opencode' }] }));
  fs.writeFileSync(path.join(root, 'members.json'), JSON.stringify({ members: [{ id: 'm-1', name: '张三' }] }));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify(
      Object.assign(
        {
          port: 9999,
          host: '0.0.0.0',
          gitea: { baseUrl: 'https://gitea.example.com' },
          dingtalk: { dwsBin: 'C:/custom/dws.exe' },
        },
        cfgExtra || {}
      )
    )
  );
}

test('pluginDefaultConfig：无 port/host、绝对 dataDir/webDir、trustedHosts、不污染 DEFAULT_CONFIG', () => {
  const base = path.join(caseDir('tpl'), 'base');
  const before = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const cfg = mig.pluginDefaultConfig(base);
  // 无 port/host 键
  assert.equal('port' in cfg, false, 'port 键必须删除');
  assert.equal('host' in cfg, false, 'host 键必须删除');
  // dataDir = base 下绝对路径；webDir = 插件包自带 web（缺省 base/web，可显式指定）
  assert.equal(cfg.dataDir, path.join(base, 'data'));
  assert.equal(cfg.webDir, path.join(base, 'web'));
  assert.ok(path.isAbsolute(cfg.dataDir), 'dataDir 必须是绝对路径');
  assert.ok(path.isAbsolute(cfg.webDir), 'webDir 必须是绝对路径');
  // 显式 webDir 参数（插件首启传包内 web）
  const cfg2 = mig.pluginDefaultConfig(base, path.join(base, 'pkg', 'web'));
  assert.equal(cfg2.webDir, path.join(base, 'pkg', 'web'));
  // security.trustedHosts 深等于目标数组
  assert.deepEqual(cfg.security.trustedHosts, ['127.0.0.1', 'localhost']);
  // store.DEFAULT_CONFIG 原值不被污染：port 键仍在、全量深等
  assert.equal('port' in DEFAULT_CONFIG, true, '原对象 port 键必须仍在');
  assert.equal(DEFAULT_CONFIG.port, before.port);
  assert.deepEqual(DEFAULT_CONFIG, before, 'store.DEFAULT_CONFIG 不得被改写');
  assert.notEqual(cfg, DEFAULT_CONFIG, '必须返回全新对象');
  // 多次调用互不影响（返回全新对象）
  cfg.security.trustedHosts.push('evil.example.com');
  assert.deepEqual(mig.pluginDefaultConfig(base).security.trustedHosts, ['127.0.0.1', 'localhost']);
});

test('resolveHome/resolveBase：DSH_HOME 跟随、删除回退 ~/.dsh、base 覆盖生效', () => {
  const dir = caseDir('resolve');
  const prev = process.env.DSH_HOME;
  try {
    // 设 DSH_HOME 时跟随
    process.env.DSH_HOME = path.join(dir, 'dsh-home');
    assert.equal(mig.resolveHome(), path.join(dir, 'dsh-home'));
    assert.equal(mig.resolveBase({}), path.normalize(path.join(dir, 'dsh-home', 'fde-console')));
    // 删除后回退 os.homedir() 下 .dsh
    delete process.env.DSH_HOME;
    assert.equal(mig.resolveHome(), path.join(os.homedir(), '.dsh'));
    assert.equal(mig.resolveBase({}), path.normalize(path.join(os.homedir(), '.dsh', 'fde-console')));
    // base 覆盖优先，且 path.normalize
    const custom = path.join(dir, 'custom-base');
    assert.equal(mig.resolveBase({ base: custom }), path.normalize(custom));
  } finally {
    // 恢复现场，绝不污染真实 DSH_HOME
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('首次迁移：data 子树落位、agents/members 落位、config 剥 port/host 并重写绝对路径、dwsBin 保留', () => {
  const dir = caseDir('first');
  const src = path.join(dir, 'src');
  const base = path.join(dir, 'base');
  makeSource(src);
  const { steps, errors } = mig.runMigration({ sourceRoot: src, base });
  assert.deepEqual(errors, [], '首次迁移不应有错误');
  for (const s of steps) {
    assert.equal(s.status, 'OK', `步骤 ${s.id} 应 OK: ${s.detail}`);
  }
  // data 子树（含子目录）存在
  assert.equal(fs.existsSync(path.join(base, 'data', 'tasks', 'tasks.json')), true);
  assert.equal(fs.existsSync(path.join(base, 'data', 'sessions.json')), true);
  // agents/members 落位且内容一致
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'agents.json'), 'utf8')), {
    agents: [{ id: 'opencode', name: 'opencode' }],
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'members.json'), 'utf8')), {
    members: [{ id: 'm-1', name: '张三' }],
  });
  // config：无 port/host；dataDir 重写为 base 下绝对路径、webDir 指向插件包自带 web；源自定义值保留；模板键兜底
  const cfg = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
  assert.equal('port' in cfg, false, 'config 不得含 port');
  assert.equal('host' in cfg, false, 'config 不得含 host');
  assert.equal(cfg.dataDir, path.join(base, 'data'));
  assert.equal(cfg.webDir, path.join(mig.defaultSourceRoot(), 'web'));
  assert.equal(cfg.dingtalk.dwsBin, 'C:/custom/dws.exe', 'dingtalk.dwsBin 自定义值必须保留');
  assert.equal(cfg.gitea.baseUrl, 'https://gitea.example.com', '源键优先覆盖默认');
  assert.equal(cfg.gitea.pollIntervalSec, DEFAULT_CONFIG.gitea.pollIntervalSec, '模板键兜底');
  assert.deepEqual(cfg.security.trustedHosts, ['127.0.0.1', 'localhost']);
});

test('v2.2：源带遗留 gateway 节 → 迁移后剥除；模板无 gateway 键', () => {
  const dir = caseDir('gateway-strip');
  const src = path.join(dir, 'src');
  const base = path.join(dir, 'base');

  // ① 源带 gateway 节（旧独立版典型形态）→ 合并重写后剥除，不进目标 config
  makeSource(src, { gateway: { enabled: true, bin: 'cli-gateway', logDir: 'data/session-logs' } });
  const first = mig.runMigration({ sourceRoot: src, base });
  assert.deepEqual(first.errors, [], '带遗留 gateway 节迁移不应有错误');
  const cfg = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
  assert.equal('gateway' in cfg, false, '遗留 gateway 节必须剥除');

  // ② 幂等：重跑结果不变（gateway 剥除是确定性动作）
  mig.runMigration({ sourceRoot: src, base });
  const cfgAgain = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
  assert.equal('gateway' in cfgAgain, false, '重跑后 gateway 节仍不存在');

  // ③ 模板兜底：源无 gateway 键时目标同样无 gateway 键（DEFAULT_CONFIG 已无该节）
  const base2 = path.join(dir, 'base2');
  makeSource(src, {});
  const third = mig.runMigration({ sourceRoot: src, base: base2 });
  assert.deepEqual(third.errors, []);
  const cfg2 = JSON.parse(fs.readFileSync(path.join(base2, 'config.json'), 'utf8'));
  assert.equal('gateway' in cfg2, false, '模板与源均无 gateway → 目标无 gateway 键');
  // 剥除不影响同批其他节的保留（dwsBin 自定义值仍在）
  assert.equal(cfg2.dingtalk.dwsBin, 'C:/custom/dws.exe', 'gateway 剥除不得连坐其他节');
});

test('幂等重跑：第二遍 data/agents/members 三步全 SKIP，config 与第一遍后完全一致', () => {
  const dir = caseDir('idem');
  const src = path.join(dir, 'src');
  const base = path.join(dir, 'base');
  makeSource(src);
  mig.runMigration({ sourceRoot: src, base });
  // 先快照（原文与解析结果双份）
  const snapshotRaw = fs.readFileSync(path.join(base, 'config.json'), 'utf8');
  const snapshot = JSON.parse(snapshotRaw);
  const { steps, errors } = mig.runMigration({ sourceRoot: src, base });
  assert.deepEqual(errors, []);
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  for (const id of ['data', 'agents.json', 'members.json']) {
    assert.equal(byId[id].status, 'SKIP', `${id} 第二遍应 SKIP: ${byId[id] && byId[id].detail}`);
    assert.ok(byId[id].detail, 'SKIP 必须 detail 报告跳过原因');
  }
  // 内容级 deepEqual + 原文逐字节一致
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8')), snapshot);
  assert.equal(fs.readFileSync(path.join(base, 'config.json'), 'utf8'), snapshotRaw);
});

test('跳过已有：预置目标 agents.json 哨兵内容，重跑后不被覆盖', () => {
  const dir = caseDir('sentinel');
  const src = path.join(dir, 'src');
  const base = path.join(dir, 'base');
  makeSource(src);
  fs.mkdirSync(base, { recursive: true });
  const sentinel = { agents: [{ id: 'sentinel', name: '哨兵' }] };
  fs.writeFileSync(path.join(base, 'agents.json'), JSON.stringify(sentinel));
  const { steps, errors } = mig.runMigration({ sourceRoot: src, base });
  assert.deepEqual(errors, []);
  const step = steps.find((s) => s.id === 'agents.json');
  assert.equal(step.status, 'SKIP', `已有目标应 SKIP: ${step.detail}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'agents.json'), 'utf8')), sentinel, '哨兵不得被覆盖');
});

test('深合并：目标独有键保留；源数组键整体覆盖（非逐元素合并）', () => {
  const dir = caseDir('merge');
  const src = path.join(dir, 'src');
  const base = path.join(dir, 'base');
  // 源带数组键 security.allowedProtocols（整体覆盖用）
  makeSource(src, { security: { allowedProtocols: ['http'] } });
  fs.mkdirSync(base, { recursive: true });
  // 预置目标 config：独有键 customKey + 覆盖默认的 analyze.timeoutSec + 自带 trustedHosts
  fs.writeFileSync(
    path.join(base, 'config.json'),
    JSON.stringify({
      customKey: { keep: 'yes', nested: { deep: 1 } },
      analyze: { timeoutSec: 123 },
      security: { allowedProtocols: ['https'], trustedHosts: ['10.0.0.1'] },
    })
  );
  mig.runMigration({ sourceRoot: src, base });
  const cfg = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.customKey, { keep: 'yes', nested: { deep: 1 } }, '目标独有键必须保留');
  assert.equal(cfg.analyze.timeoutSec, 123, '目标对默认键的改写保留（源无此键）');
  assert.deepEqual(cfg.security.allowedProtocols, ['http'], '源数组键必须整体覆盖');
  assert.deepEqual(cfg.security.trustedHosts, ['10.0.0.1'], '目标有而源无的键保持目标值');
  // 合并后仍强制 base 下绝对路径（webDir 指向插件包自带 web）
  assert.equal(cfg.dataDir, path.join(base, 'data'));
  assert.equal(cfg.webDir, path.join(mig.defaultSourceRoot(), 'web'));
});

test('dry-run：零写入（base 目录不被创建），步骤 status 与实跑一致', () => {
  const dir = caseDir('dry');
  const src = path.join(dir, 'src');
  makeSource(src);
  const baseDry = path.join(dir, 'base-dry');
  const dry = mig.runMigration({ sourceRoot: src, base: baseDry, dryRun: true });
  assert.equal(fs.existsSync(baseDry), false, 'dry-run 不得创建 base 目录');
  assert.deepEqual(dry.errors, []);
  // 同构源实跑一份，比对 status 序列一致
  const baseReal = path.join(dir, 'base-real');
  const real = mig.runMigration({ sourceRoot: src, base: baseReal });
  assert.deepEqual(
    dry.steps.map((s) => [s.id, s.status]),
    real.steps.map((s) => [s.id, s.status]),
    'dry-run 与实跑的步骤 status 必须一致'
  );
});

test('源 config 损坏：该步 status=ERR 且 errors 非空，实跑仍回退写出默认模板（无 host/port）', () => {
  const dir = caseDir('corrupt');
  const src = path.join(dir, 'src');
  const base = path.join(dir, 'base');
  makeSource(src);
  fs.writeFileSync(path.join(src, 'config.json'), '{ invalid json !!');
  const { steps, errors } = mig.runMigration({ sourceRoot: src, base });
  const step = steps.find((s) => s.id === 'config.json');
  assert.equal(step.status, 'ERR', '损坏源 config 该步必须 ERR');
  assert.ok(errors.length >= 1, 'errors 必须非空');
  assert.equal(errors[0].id, 'config.json', '错误必须归到 config.json 步');
  // 回退写默认模板
  const cfg = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
  assert.equal('port' in cfg, false);
  assert.equal('host' in cfg, false);
  assert.equal(cfg.dataDir, path.join(base, 'data'));
  assert.equal(cfg.webDir, path.join(base, 'web'));
  assert.deepEqual(cfg.security.trustedHosts, ['127.0.0.1', 'localhost']);
  // 其余步骤不受影响
  const dataStep = steps.find((s) => s.id === 'data');
  assert.equal(dataStep.status, 'OK', 'config 损坏不连坐 data 步');
});

test('缺省源 = 仓库根：defaultSourceRoot 钉死；main 无 --source 时源目录走仓库根（dry-run 零写入）', () => {
  // 工单口径：迁移源缺省是仓库根（旧独立版布局），不是 DSH_HOME
  assert.equal(typeof mig.defaultSourceRoot, 'function', '必须导出 defaultSourceRoot');
  assert.equal(mig.defaultSourceRoot(), ROOT, 'defaultSourceRoot 必须等于仓库根');
  // main 无 --source：dry-run 读仓库根、零写入；stdout 头部源目录必须是仓库根
  const dir = caseDir('default-source');
  const base = path.join(dir, 'base');
  const origLog = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const rc = mig.main(['--base', base, '--dry-run']);
    assert.equal(rc, 0);
  } finally {
    console.log = origLog;
  }
  assert.ok(lines.some((l) => l.includes(`源目录: ${ROOT}`)), `头部源目录必须是仓库根，实际输出: ${lines[0]}`);
  assert.equal(fs.existsSync(base), false, 'dry-run 仍必须零写入');
});

test('main() CLI 层：正常退出码 0；含 ERR 退出码 1；输出含 [OK]/[SKIP]/[ERR] 行与汇总', () => {
  const dir = caseDir('cli');
  const src = path.join(dir, 'src');
  const base = path.join(dir, 'base');
  makeSource(src);
  // 进程内调用：返回码（不污染进程退出码）
  assert.equal(mig.main(['--source', src, '--base', base]), 0, '正常迁移返回 0');
  assert.equal(mig.main(['--source', src, '--base', base, '--dry-run']), 0, 'dry-run 返回 0');
  // 子进程真实退出码 + 输出格式
  const ok = spawnSync(process.execPath, [SCRIPT, '--source', src, '--base', base], { encoding: 'utf8' });
  assert.equal(ok.status, 0, '正常迁移子进程退出码 0');
  assert.ok(/\[OK\]/.test(ok.stdout), '输出应含 [OK] 前缀行');
  assert.ok(/\[SKIP\]/.test(ok.stdout), '重跑输出应含 [SKIP] 前缀行');
  assert.ok(/汇总/.test(ok.stdout), '输出应含汇总行');
  // 损坏源 → ERR → 退出码 1
  const bad = path.join(dir, 'bad');
  makeSource(bad);
  fs.writeFileSync(path.join(bad, 'config.json'), 'not-json');
  assert.equal(mig.main(['--source', bad, '--base', path.join(dir, 'base-err2')]), 1, '进程内含 ERR 返回 1');
  const err = spawnSync(process.execPath, [SCRIPT, '--source', bad, '--base', path.join(dir, 'base-err')], {
    encoding: 'utf8',
  });
  assert.equal(err.status, 1, '含 ERR 时子进程退出码必须为 1');
  assert.ok(/\[ERR\]/.test(err.stdout), '输出应含 [ERR] 前缀行');
});

// ---------- v2.9.33 JSON→SQLite 迁移器（SPEC-STORAGE §4；messages 单元 + store 路由往返） ----------
// 测试文件自身零 node:sqlite（Mimosa 钩子约束）——建库走 lib/migration.runMigration，
// 断言走 store.loadMessages/saveMessages 公开 API（即被测的真实路由路径）。

test('迁移器 dry-run：只报告不写（无 fde.db、原文件不动、坏行计数）', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { runMigration } = require('../lib/migration');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-mig-dry-'));
  const msgs = [
    { id: 'm1', title: '甲', occurredAt: '2026-10-30T00:00:00Z' },
    { id: 'm2', title: '乙', occurredAt: '2026-10-31T00:00:00Z' },
    { noId: true }, // 坏行：无 id
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(msgs));
  const r = runMigration({ dataDir: dir, units: ['messages'], dryRun: true, now: 0 });
  assert.equal(r.dryRun, true);
  assert.equal(r.units[0].sourceRows, 3);
  assert.equal(r.units[0].validRows, 2);
  assert.equal(r.units[0].badRows, 1, '坏行计数入报告');
  assert.ok(!fs.existsSync(path.join(dir, 'fde.db')), 'dry-run 不建库');
  assert.ok(fs.existsSync(path.join(dir, 'messages.json')), '原文件不动');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('迁移器：messages 迁移后 store 路由往返同构（坏行剔除并报告；原档归档）', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { runMigration } = require('../lib/migration');
  const store = require('../lib/store');
  const storeDb = require('../lib/storeDb');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-mig-run-'));
  const ctx = { messagesPath: path.join(dir, 'messages.json') };
  const msgs = [
    { id: 'm-1', title: '会话一', source: 'dingtalk', occurredAt: '2026-10-30T00:00:00Z', speakerSegments: [{ raw: '甲', text: '内容一' }] },
    { id: 'm-2', title: '会话二', source: 'dingtalk', occurredAt: '2026-10-31T00:00:00Z', speakerSegments: [{ raw: '乙', text: '内容二' }] },
    { broken: true }, // 坏行
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ctx.messagesPath, JSON.stringify(msgs));

  const r = runMigration({ dataDir: dir, units: ['messages'], now: 0 });
  assert.equal(r.units[0].sourceRows, 3, '源 3 行');
  assert.equal(r.units[0].badRows, 1, '坏行 1 报告');
  assert.ok(fs.existsSync(path.join(dir, 'fde.db')));
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('messages.json.migrated-')), '原档归档');

  // 路由生效 + 读回同构（data 真源；坏行未入库）
  assert.equal(storeDb.unitBackend(dir, 'messages').backend, 'sqlite');
  const loaded = store.loadMessages(ctx);
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded.map((m) => m.id), ['m-1', 'm-2']);
  assert.equal(loaded[0].speakerSegments[0].text, '内容一', '开放字段经 data 真源还原');

  // 写路径（db）：saveMessages 全量替换语义
  store.saveMessages(ctx, [msgs[0], { id: 'm-3', title: '新增', occurredAt: '2026-11-01T00:00:00Z' }]);
  assert.deepEqual(store.loadMessages(ctx).map((m) => m.id), ['m-1', 'm-3']);

  storeDb.clearCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- v2.9.65 批次 2：tasks/activities/inbox/diary/learn 五域往返同构 ----------

test('批次 2 五域：全单元一次迁移 → store/diary/learn 公开 API 读回同构 + 写路由生效', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { runMigration } = require('../lib/migration');
  const store = require('../lib/store');
  const storeDb = require('../lib/storeDb');
  const diaryMod = require('../lib/diary');
  const learn = require('../lib/learn');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-mig-b2-'));

  // 夹具：五域源 JSON
  const tasks = [{ id: 't-b2', title: '批次二任务', status: 'doing', priority: 'high', projectDir: 'C:\\p\\b2', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z', artifacts: [{ url: 'https://x/c/1', kind: 'commit' }] }];
  const activities = [{ url: 'https://x/c/1', type: 'commit', repo: 'example-org/x', branch: 'main', sha: 'abc', title: 'c1', messageBody: '', occurredAt: '2026-10-30T00:00:00Z', fetchedAt: '2026-10-31T00:00:00Z' }];
  const inbox = [{ id: 'cand-1', kind: 'task', messageId: 'm-9', state: 'pending', confidence: 0.9, title: '候选甲', quote: '引用', createdAt: '2026-10-30T00:00:00Z' }];
  const diaries = [{ taskId: 't-b2', date: '2026-10-31', content: '批次二日报', updatedAt: '2026-10-31T01:00:00Z' }];
  fs.mkdirSync(path.join(dir, 'learn'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ columns: [{ id: 'doing', name: '进行中' }], tasks }));
  fs.writeFileSync(path.join(dir, 'activities.json'), JSON.stringify(activities));
  fs.writeFileSync(path.join(dir, 'inbox.json'), JSON.stringify({ candidates: inbox }));
  fs.writeFileSync(path.join(dir, 'diary.json'), JSON.stringify(diaries));
  fs.writeFileSync(path.join(dir, 'learn', 'items.json'), JSON.stringify({ version: 2, items: [{ id: 'C-x', term: '术语', pages: ['p1'] }], updatedAt: '2026-10-31T00:00:00Z' }));
  fs.writeFileSync(path.join(dir, 'learn', 'pages.json'), JSON.stringify({ pages: [{ id: 'p1', title: '页', content: '全文' }], updatedAt: '2026-10-31T00:00:00Z' }));
  fs.writeFileSync(path.join(dir, 'learn', 'schedule.json'), JSON.stringify({ items: { 'C-x': { due: '2026-11-02' } }, updatedAt: '2026-10-31T00:00:00Z' }));
  fs.writeFileSync(path.join(dir, 'learn', 'sessions.json'), JSON.stringify({ sessions: [{ id: 's1', itemId: 'C-x', score: 3 }] }));
  fs.writeFileSync(path.join(dir, 'learn', 'scan.json'), JSON.stringify({ root: 'E:\\vault', scannedAt: '2026-10-30T00:00:00Z', pages: 2 }));

  // 一次迁移全部单元（批次 1 两单元源文件不在 → 正确跳过）
  const r = runMigration({ dataDir: dir, now: 0 });
  assert.equal(r.units.length, 9, '九个有源单元全部迁移');
  assert.ok(r.skipped.some((s) => s.unit === 'messages' && s.reason.includes('不存在')), '无源单元正确跳过');
  for (const u of ['tasks', 'activities', 'inbox', 'diary', 'learn:items', 'learn:pages', 'learn:schedule', 'learn:sessions', 'learn:scan']) {
    assert.equal(storeDb.unitBackend(dir, u).backend, 'sqlite', `${u} 路由生效`);
  }

  // store 读回同构（data 真源开放字段完整）
  const t = store.loadTasks({ tasksPath: path.join(dir, 'tasks.json') });
  assert.equal(t.tasks.length, 1);
  assert.equal(t.tasks[0].artifacts[0].url, 'https://x/c/1', 'artifacts 随 data 真源还原');
  assert.equal(t.columns[0].id, 'doing', '列定义走 JSON 伴生文件');
  assert.deepEqual(store.loadActivities({ activitiesPath: path.join(dir, 'activities.json') }), activities);
  assert.deepEqual(store.loadInbox({ inboxPath: path.join(dir, 'inbox.json') }), inbox);

  // diary 读回
  const dl = diaryMod.loadDiaries({ diaryPath: path.join(dir, 'diary.json') });
  assert.equal(dl.length, 1);
  assert.equal(dl[0].content, '批次二日报');

  // learn 读回（单文档行 → loadJSON 形状不变；loadItems 业务语义不变）
  const lctx = { dataDir: dir, config: {} };
  assert.equal(learn.loadItems(lctx).length, 1, '学习条目经 learn_docs 读回');
  assert.deepEqual(Object.keys(learn.loadSchedule(lctx)), ['C-x'], '调度键读回');

  // 写路由：tasks/diary 经 API 写后落 db（无 JSON 文件再生）
  store.saveTasks({ tasksPath: path.join(dir, 'tasks.json') }, { columns: t.columns, tasks: [Object.assign({}, t.tasks[0], { title: '改后' })] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'columns.json'), 'utf8')).length, 1, '伴生列文件更新');
  assert.ok(!fs.existsSync(path.join(dir, 'tasks.json')), 'db 路径不再写 tasks.json');
  diaryMod.saveDiaries({ diaryPath: path.join(dir, 'diary.json') }, dl);
  assert.ok(!fs.existsSync(path.join(dir, 'diary.json')), 'diary db 路径不再写 JSON 文件');
  assert.equal(store.loadTasks({ tasksPath: path.join(dir, 'tasks.json') }).tasks[0].title, '改后');

  storeDb.clearCache();
  fs.rmSync(dir, { recursive: true, force: true });
});
