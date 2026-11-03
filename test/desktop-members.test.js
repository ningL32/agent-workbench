'use strict';

/**
 * desktop-members.test.js — v2.6 硅基成员桌面 agent 注册表（workbuddy/zcode/codex/opencode 四源并列）
 * 覆盖：四源并列派生（fixture/适配器注入，不读本机真实数据；zcode 自 v2.9.14 走 adapters+
 *       listSessions 注入）、任务归因（agentId 命中 zcode/codex）、
 *       单源故障隔离（路径不存在 → 该源缺席不拖垮）、hermes 缺席不报错（本期不实现，仅列待考古）、
 *       手工名册与桌面派生 id 冲突去重（派生胜出）、总开关/单源开关、settings PATCH 六源回填、
 *       codex/opencode 适配器直测（标题/项目/最近会话排序）。
 * 运行：node --test test/desktop-members.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildApp } = require('./helpers/appAssembler');
const { createWorkbuddyDb } = require('./helpers/workbuddy-fixture');
const { createOpencodeDb } = require('./helpers/opencode-fixture');
const { zcodeAdapter, codexAdapter, opencodeAdapter, hermesAdapter } = require('../lib/agentActivity');
const { collectDesktopSourceHealth } = require('../lib/desktopAgents');
const sessionRef = require('../lib/sessionRef');

const PORT = 7797; // 仅作 fixture 配置留痕（进程内装配不再监听端口）

function writeConfig(tmpDir, sources, masterEnabled) {
  const cfg = {
    port: PORT,
    host: '127.0.0.1',
    dataDir: path.join(tmpDir, 'data'),
    webDir: path.join(tmpDir, 'web'),
    gitea: { pollIntervalSec: 0 },
    agentActivity: { enabled: masterEnabled !== false, sources },
  };
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg));
  return cfg;
}

/** codex rollout 夹具：首行 session_meta + 次行用户消息 + 末行助手消息；mtime 用 utimesSync 可控 */
function writeCodexRollout(dayDir, fileName, sessId, cwd, userText, mtimeMs) {
  fs.mkdirSync(dayDir, { recursive: true });
  const full = path.join(dayDir, fileName);
  const lines = [
    JSON.stringify({ timestamp: new Date(mtimeMs).toISOString(), type: 'session_meta', payload: { id: sessId, session_id: sessId, timestamp: new Date(mtimeMs).toISOString(), cwd } }),
    JSON.stringify({ timestamp: new Date(mtimeMs + 1000).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] } }),
    JSON.stringify({ timestamp: new Date(mtimeMs + 2000).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '收到' }] } }),
  ];
  fs.writeFileSync(full, lines.join('\n') + '\n');
  fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
  return full;
}

/** zcode 源注入（AGENTS.md 坑 5：sqlite 夹具会被 Mimosa 写入钩子误判拦截）——经 buildApp 的
 *  adapters 覆盖 + zcodeAdapter 的 listSessions 注入 db session 表五行行数据，不落任何 fs 夹具 */
function zcodeAdaptersOverride(rows) {
  return {
    zcode: (sourceCfg, opts) =>
      zcodeAdapter(sourceCfg, { ...opts, listSessions: () => ({ ok: true, detail: '', rows }) }),
  };
}

let app;
let tmpDir;
let now;

async function api(method, p, body) {
  return app.fetch(method, p, {
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test.before(async () => {
  now = Date.now();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-desktop-members-'));
  const wbDb = createWorkbuddyDb(path.join(tmpDir, 'workbuddy.db'), [
    { id: 'wb-live-01', cwd: tmpDir, title: '评审输入整理', status: 'running', created_at: now - 3600e3, last_activity_at: now - 60e3 },
  ]);
  // zcode：db session 表行数据注入（v2.9.14 起适配器读 db/db.sqlite，行形状五列）
  const zcodeRows = [
    { id: 'sess_zc01aaaa', directory: tmpDir, title: 'ZCode 夹具：重构登录模块', time_created: now - 3600e3, time_updated: now - 60e3 },
  ];
  writeCodexRollout(path.join(tmpDir, 'codex-sessions', '2026', '10', '19'), 'rollout-2026-10-19T10-00-00-c0de0001-1111-2222-3333-444455556666.jsonl', 'c0de0001-1111-2222-3333-444455556666', tmpDir, '把成员册泛化成桌面注册表', now - 60e3);
  createOpencodeDb(path.join(tmpDir, 'opencode.db'), [
    { id: 'ses_fix0001TEST', directory: tmpDir, title: 'OpenCode 夹具任务', time_created: now - 7200e3, time_updated: now - 60e3 },
  ]);
  // 手工名册：含与桌面派生 id 冲突的 workbuddy 条目（应被派生胜出去重）+ 普通人类条目 alice
  fs.writeFileSync(path.join(tmpDir, 'members.json'), JSON.stringify({ members: [
    { id: 'workbuddy', name: '手工WB', role: '旧条目' },
    { id: 'alice', name: '爱丽丝' },
  ] }));
  writeConfig(tmpDir, {
    workbuddy: { dbPath: wbDb },
    zcode: { root: path.join(tmpDir, 'zcode-cli') },
    codex: { root: path.join(tmpDir, 'codex-sessions') },
    opencode: { dbPath: path.join(tmpDir, 'opencode.db') },
    hermes: { enabled: false }, // 第七源默认关（测试零真机数据纪律）；注入正例见专用用例
  });
  app = buildApp({ configPath: path.join(tmpDir, 'config.json'), adapters: zcodeAdaptersOverride(zcodeRows) });
});

test.after(() => {
  if (app) app.close();
});

test('v2.6 四源并列：桌面 agent 注册表全部入册（kind/role/manual/source/session/名字）', async () => {
  const r = await api('GET', '/api/members');
  assert.strictEqual(r.status, 200);
  const ms = r.body;
  const by = (id) => ms.find((m) => m.id === id);

  for (const id of ['workbuddy', 'zcode', 'codex', 'opencode']) {
    const m = by(id);
    assert.ok(m, id + ' 应在成员册');
    assert.strictEqual(m.kind, 'agent');
    assert.strictEqual(m.manual, false);
    assert.strictEqual(m.role, '桌面 Agent');
    assert.strictEqual(m.source, id, 'source 字段标注桌面来源');
    assert.strictEqual(m.todayCommits, 0, '桌面 agent 无 Gitea 身份');
    assert.strictEqual(m.openPrs, 0);
    assert.ok(m.session && m.session.alive === true, id + ' 最近会话活跃 → alive');
    assert.strictEqual(m.status, 'working');
    assert.ok(typeof m.lastActivityAt === 'string' && m.lastActivityAt.length > 0, id + ' lastActivityAt 有值');
  }
  assert.strictEqual(by('workbuddy').name, 'WorkBuddy');
  assert.strictEqual(by('zcode').name, 'ZCode');
  assert.strictEqual(by('codex').name, 'Codex (ChatGPT 桌面)');
  assert.strictEqual(by('opencode').name, 'OpenCode');

  // 会话 id：四源均透传源会话主键（v2.9.14 起 zcode 条目直接来自 db.sqlite session 表，
  // id 即阅读器回查主键；此前目录扫描版靠 spike R1 的同名同形结论透传目录名）
  assert.strictEqual(by('workbuddy').session.id, 'wb-live-01');
  assert.strictEqual(by('zcode').session.id, 'sess_zc01aaaa');
  assert.strictEqual(by('codex').session.id, 'c0de0001-1111-2222-3333-444455556666');
  assert.strictEqual(by('opencode').session.id, 'ses_fix0001TEST');

  // 冲突去重：手工 workbuddy 条目不重复出现（整个册子只有一个 id=workbuddy，且是派生条目）
  assert.strictEqual(ms.filter((m) => m.id === 'workbuddy').length, 1);
  // CLI 注册表仍不进成员册（v2.5 方向保持）
  assert.ok(!ms.some((m) => m.id === 'claude' || m.id === 'kilo'));
  // hermes 默认关（主 fixture 未启用；2026-11-03 起为第七源，注入正例见专用用例）
  assert.ok(!ms.some((m) => String(m.id).toLowerCase() === 'hermes'));
  // 手工人类条目照常
  const alice = by('alice');
  assert.ok(alice && alice.kind === 'human' && alice.manual === true);
});

test('v2.6 归因推广：任务 agentId= zcode/codex 命中对应桌面成员（currentTask 沿用同一推导）', async () => {
  const t1 = await api('POST', '/api/tasks', { title: 'ZCode 重构登录', agentId: 'zcode' });
  await api('PATCH', `/api/tasks/${t1.body.id}`, { status: 'doing' });
  const t2 = await api('POST', '/api/tasks', { title: 'Codex 迁移配置', agentId: 'codex' });
  await api('PATCH', `/api/tasks/${t2.body.id}`, { status: 'doing' });

  const r = await api('GET', '/api/members');
  const zc = r.body.find((m) => m.id === 'zcode');
  const cx = r.body.find((m) => m.id === 'codex');
  const wb = r.body.find((m) => m.id === 'workbuddy');
  const oc = r.body.find((m) => m.id === 'opencode');
  assert.ok(zc.currentTask, 'zcode 应领到任务');
  assert.strictEqual(zc.currentTask.title, 'ZCode 重构登录');
  assert.strictEqual(zc.currentTask.progress, 0.3, 'doing 无匹配 PR → 0.3');
  assert.ok(cx.currentTask, 'codex 应领到任务');
  assert.strictEqual(cx.currentTask.title, 'Codex 迁移配置');
  assert.strictEqual(wb.currentTask, null, 'workbuddy 不领别人的任务（归因按源隔离）');
  assert.strictEqual(oc.currentTask, null, 'opencode 不领别人的任务');

  await api('DELETE', `/api/tasks/${t1.body.id}`);
  await api('DELETE', `/api/tasks/${t2.body.id}`);
});

test('单源故障隔离：codex/opencode 路径不存在 → 两源缺席，其余源与人类派生照常', async () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-desktop-fault-'));
  try {
    const wbDb = createWorkbuddyDb(path.join(tmp2, 'workbuddy.db'), [
      { id: 'wb-fault-01', cwd: tmp2, title: '故障隔离夹具', status: 'running', created_at: now - 60e3, last_activity_at: now - 30e3 },
    ]);
    fs.writeFileSync(path.join(tmp2, 'config.json'), JSON.stringify({
      port: PORT, host: '127.0.0.1', dataDir: path.join(tmp2, 'data'), webDir: path.join(tmp2, 'web'),
      gitea: { pollIntervalSec: 0 },
      agentActivity: { sources: {
        workbuddy: { dbPath: wbDb },
        zcode: { root: path.join(tmp2, 'zcode-cli') },
        codex: { root: path.join(tmp2, 'no-such-codex') },          // 目录不存在
        opencode: { dbPath: path.join(tmp2, 'no-such-opencode.db') }, // db 不存在
        hermes: { enabled: false },
      } },
    }));
    fs.mkdirSync(path.join(tmp2, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmp2, 'data', 'gitea-members.json'), JSON.stringify([
      { login: 'bob', full_name: '鲍勃', name: '鲍勃' },
    ]));
    fs.writeFileSync(path.join(tmp2, 'data', 'activities.json'), JSON.stringify([
      { id: 'a-f1', type: 'commit_pushed', actor: 'carol', repo: 'example-org/x', branch: 'f', title: 't', url: 'https://gitea.example.com/example-org/x/commit/1', occurredAt: new Date(now - 60e3).toISOString(), fetchedAt: new Date(now).toISOString() },
    ]));
    const app2 = buildApp({
      configPath: path.join(tmp2, 'config.json'),
      adapters: zcodeAdaptersOverride([
        { id: 'sess_zcfault1', directory: tmp2, title: '故障隔离 ZCode', time_created: now - 3600e3, time_updated: now - 30e3 },
      ]),
    });
    try {
      const r = await app2.fetch('GET', '/api/members');
      assert.strictEqual(r.status, 200, '单源故障不拖垮整体响应');
      const ms = r.body;
      assert.ok(ms.some((m) => m.id === 'workbuddy'), 'workbuddy 照常');
      assert.ok(ms.some((m) => m.id === 'zcode'), 'zcode 照常');
      assert.ok(!ms.some((m) => m.id === 'codex'), 'codex 缺席');
      assert.ok(!ms.some((m) => m.id === 'opencode'), 'opencode 缺席');
      // v2.9.1：动态 actor 不派生入册；Gitea 成员缓存路径不受桌面源故障影响
      const bob = ms.find((m) => m.id === 'bob');
      assert.ok(bob && bob.kind === 'human', 'Gitea 缓存成员不受桌面源故障影响');
      assert.ok(!ms.some((m) => m.id === 'carol'), '动态 actor carol 不得派生入册');
    } finally { app2.close(); }
  } finally { fs.rmSync(tmp2, { recursive: true, force: true }); }
});

test('全源缺席 + hermes 缺席：响应 200、无桌面成员、人类/手工照常、不报错', async () => {
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-desktop-empty-'));
  try {
    fs.writeFileSync(path.join(tmp3, 'config.json'), JSON.stringify({
      port: PORT, host: '127.0.0.1', dataDir: path.join(tmp3, 'data'), webDir: path.join(tmp3, 'web'),
      gitea: { pollIntervalSec: 0 },
      agentActivity: { sources: {
        workbuddy: { dbPath: path.join(tmp3, 'no-wb.db') },
        zcode: { root: path.join(tmp3, 'no-zc') },
        codex: { root: path.join(tmp3, 'no-cx') },
        opencode: { dbPath: path.join(tmp3, 'no-oc.db') },
        hermes: { enabled: false },
      } },
    }));
    fs.writeFileSync(path.join(tmp3, 'members.json'), JSON.stringify({ members: [{ id: 'eve', name: '伊芙' }] }));
    fs.mkdirSync(path.join(tmp3, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmp3, 'data', 'gitea-members.json'), JSON.stringify([
      { login: 'frank', full_name: '弗兰克', name: '弗兰克' },
    ]));
    fs.writeFileSync(path.join(tmp3, 'data', 'activities.json'), JSON.stringify([
      { id: 'a-e1', type: 'commit_pushed', actor: 'dave', repo: 'example-org/x', branch: 'f', title: 't', url: 'https://gitea.example.com/example-org/x/commit/2', occurredAt: new Date(now - 60e3).toISOString(), fetchedAt: new Date(now).toISOString() },
    ]));
    const app3 = buildApp({ configPath: path.join(tmp3, 'config.json') });
    try {
      const r = await app3.fetch('GET', '/api/members');
      assert.strictEqual(r.status, 200);
      const ms = r.body;
      for (const id of ['workbuddy', 'zcode', 'codex', 'opencode', 'hermes']) {
        assert.ok(!ms.some((m) => m.id === id), id + ' 缺席（hermes 本期不实现）');
      }
      assert.ok(ms.some((m) => m.id === 'eve' && m.manual === true));
      // v2.9.1：Gitea 缓存成员照常入册；仅出现在动态里的 actor（dave）不再派生
      assert.ok(ms.some((m) => m.id === 'frank' && m.kind === 'human'));
      assert.ok(!ms.some((m) => m.id === 'dave'), '动态 actor dave 不得派生入册');
    } finally { app3.close(); }
  } finally { fs.rmSync(tmp3, { recursive: true, force: true }); }
});

test('开关：agentActivity.enabled=false → 四源全缺席；sources.codex.enabled=false → 仅 codex 缺席', async () => {
  // 总开关
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-desktop-sw1-'));
  try {
    const wbDb = createWorkbuddyDb(path.join(tmp4, 'workbuddy.db'), [
      { id: 'wb-sw-01', cwd: tmp4, title: '总开关夹具', status: 'running', created_at: now - 60e3, last_activity_at: now - 30e3 },
    ]);
    writeConfig(tmp4, { workbuddy: { dbPath: wbDb }, zcode: { root: path.join(tmp4, 'no-zc') }, codex: { root: path.join(tmp4, 'no-cx') }, opencode: { dbPath: path.join(tmp4, 'no-oc.db') }, hermes: { enabled: false } }, false);
    const app4 = buildApp({ configPath: path.join(tmp4, 'config.json') });
    try {
      const ms = (await app4.fetch('GET', '/api/members')).body;
      for (const id of ['workbuddy', 'zcode', 'codex', 'opencode']) {
        assert.ok(!ms.some((m) => m.id === id), '总关时 ' + id + ' 缺席');
      }
    } finally { app4.close(); }
  } finally { fs.rmSync(tmp4, { recursive: true, force: true }); }

  // 单源开关
  const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-desktop-sw2-'));
  try {
    const wbDb = createWorkbuddyDb(path.join(tmp5, 'workbuddy.db'), [
      { id: 'wb-sw2-01', cwd: tmp5, title: '单源开关夹具', status: 'running', created_at: now - 60e3, last_activity_at: now - 30e3 },
    ]);
    writeCodexRollout(path.join(tmp5, 'codex-sessions', '2026', '10', '19'), 'rollout-2026-10-19T11-00-00-c0de0002-1111-2222-3333-444455556666.jsonl', 'c0de0002-1111-2222-3333-444455556666', tmp5, '开关夹具', now - 30e3);
    writeConfig(tmp5, {
      workbuddy: { dbPath: wbDb },
      zcode: { root: path.join(tmp5, 'no-zc') },
      codex: { root: path.join(tmp5, 'codex-sessions'), enabled: false },
      hermes: { enabled: false },
      opencode: { dbPath: path.join(tmp5, 'no-oc.db') },
    });
    const app5 = buildApp({ configPath: path.join(tmp5, 'config.json') });
    try {
      const ms = (await app5.fetch('GET', '/api/members')).body;
      assert.ok(!ms.some((m) => m.id === 'codex'), '单源关 → codex 缺席');
      assert.ok(ms.some((m) => m.id === 'workbuddy'), '其余源不受影响');
    } finally { app5.close(); }
  } finally { fs.rmSync(tmp5, { recursive: true, force: true }); }
});

test('settings PATCH 回填：codex/opencode 键参与归一化（局部 PATCH 不丢、磁盘六源齐全）', async () => {
  const p = await api('PATCH', '/api/settings', { agentActivity: { sources: { codex: { root: 'C:/some/codex-root' } } } });
  assert.strictEqual(p.status, 200);
  const s = await api('GET', '/api/settings');
  assert.strictEqual(s.body.agentActivity.sources.codex.root, 'C:/some/codex-root', 'codex 键 PATCH 生效');
  assert.strictEqual(s.body.agentActivity.sources.opencode.enabled, true, 'opencode 缺省键（enabled）归一化回填');
  const disk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  assert.deepStrictEqual(
    Object.keys(disk.agentActivity.sources).sort(),
    ['claude', 'codex', 'dsh', 'hermes', 'opencode', 'workbuddy', 'zcode'],
    '磁盘 sources 七源齐全（hermes 2026-11-03 第七源参与归一化回填）'
  );
});

// ---------- hermes 第七源（2026-11-03，注入缝正例 + 开关注入直测） ----------

test('hermes 第七源：注入缝正例入册（member 形状/source/session.id），默认关不入册', async () => {
  const tmpH = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-desktop-hermes-'));
  try {
    const wbDb = createWorkbuddyDb(path.join(tmpH, 'workbuddy.db'), [
      { id: 'wb-h-01', cwd: tmpH, title: 'hermes 批次夹具', status: 'running', created_at: now - 3600e3, last_activity_at: now - 30e3 },
    ]);
    fs.writeFileSync(path.join(tmpH, 'config.json'), JSON.stringify({
      port: PORT, host: '127.0.0.1', dataDir: path.join(tmpH, 'data'), webDir: path.join(tmpH, 'web'),
      gitea: { pollIntervalSec: 0 },
      agentActivity: { sources: {
        workbuddy: { dbPath: wbDb },
        zcode: { root: path.join(tmpH, 'no-zc') },
        codex: { root: path.join(tmpH, 'no-cx') },
        opencode: { dbPath: path.join(tmpH, 'no-oc.db') },
        hermes: { enabled: true },
      } },
    }));
    const hermesAdapters = {
      hermes: (sourceCfg, opts) =>
        hermesAdapter(sourceCfg, {
          ...opts,
          listSessions: () => ({
            ok: true,
            rows: [{ id: '20261101_120000_her1aa', title: 'Hermes 注入会话', cwd: tmpH, started_at: (now - 600e3) / 1000, last_activity_at: (now - 60e3) / 1000 }],
          }),
        }),
    };
    const appH = buildApp({ configPath: path.join(tmpH, 'config.json'), adapters: hermesAdapters });
    try {
      const r = await appH.fetch('GET', '/api/members');
      assert.strictEqual(r.status, 200);
      const h = r.body.find((m) => m.id === 'hermes');
      assert.ok(h, 'hermes 成员应在册');
      assert.strictEqual(h.kind, 'agent');
      assert.strictEqual(h.source, 'hermes');
      assert.strictEqual(h.name, 'Hermes');
      assert.strictEqual(h.session.id, '20261101_120000_her1aa', 'Unix 秒浮点时间戳行透传源主键');
      assert.strictEqual(h.session.alive, true, '60 秒前活跃 → alive');
      // 健康探针同链路：hermes ok:true
      const hp = await appH.fetch('GET', '/api/members/source-health');
      const hh = (Array.isArray(hp.body) ? hp.body : []).find((x) => x.id === 'hermes');
      assert.ok(hh && hh.enabled === true && hh.ok === true, '健康探针 hermes ok:true');
    } finally { appH.close(); }
  } finally { fs.rmSync(tmpH, { recursive: true, force: true }); }
});

test('hermesAdapter 直测：注入行归一化（Unix 秒 → ms、ref 可过 sessionRef 校验）', () => {
  const r = hermesAdapter({}, {
    limit: 10,
    listSessions: () => ({
      ok: true,
      rows: [{ id: '20261018_223147_c80c5b', title: '', cwd: 'E:/p/h', started_at: 1792333908.89, last_activity_at: 1792333915.17 }],
    }),
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.items.length, 1);
  const it = r.items[0];
  assert.strictEqual(it.id, '20261018_223147_c80c5b');
  assert.strictEqual(it.agentName, 'Hermes');
  assert.strictEqual(it.startedAt, new Date(Math.round(1792333908.89 * 1000)).toISOString(), 'Unix 秒浮点 ×1000');
  assert.ok(it.title.includes('Hermes 会话'), '空标题回退技术名');
  assert.ok(it.ref, 'ref 已编码');
  // ref 必须能过 sessionRef 校验（阅读器回查主键，否则成员册「会话」列一点就 400 死引用）
  const loc = sessionRef.validateRef(it.ref, {});
  assert.strictEqual(loc.s, 'hermes');
  assert.strictEqual(loc.v.id, '20261018_223147_c80c5b');
});

// ---------- 适配器直测（fixture 注入） ----------

test('codexAdapter：最近会话排序 + session_meta 提取（id/cwd/用户消息标题）', () => {
  const root = path.join(tmpDir, 'codex-sessions');
  writeCodexRollout(path.join(root, '2026', '10', '15'), 'rollout-2026-10-15T09-00-00-c0de0009-1111-2222-3333-444455556666.jsonl', 'c0de0009-1111-2222-3333-444455556666', 'C:/old/project', '旧会话', now - 5 * 86400e3);
  const r = codexAdapter({ root }, { limit: 10, previewChars: 200, now });
  assert.strictEqual(r.ok, true);
  assert.ok(r.items.length >= 2);
  assert.strictEqual(r.items[0].id, 'c0de0001-1111-2222-3333-444455556666', '按 mtime 取最新在前');
  assert.strictEqual(r.items[0].agent, 'codex');
  assert.strictEqual(r.items[0].agentName, 'Codex (ChatGPT 桌面)');
  assert.strictEqual(r.items[0].projectId, tmpDir, 'cwd 透传为项目');
  assert.strictEqual(r.items[0].title, '把成员册泛化成桌面注册表', '首条用户消息作标题');
  assert.strictEqual(r.items[0].state, 'active', 'mtime 在活跃窗内');
});

test('codexAdapter：目录不存在 → ok:false 空列表（不抛错）', () => {
  const r = codexAdapter({ root: path.join(tmpDir, 'no-such-dir') }, { limit: 10, previewChars: 200, now });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.items, []);
});

test('opencodeAdapter：session 表倒序 + 五列提取；db 不存在 → ok:false', () => {
  const r = opencodeAdapter({ dbPath: path.join(tmpDir, 'opencode.db') }, { limit: 10, previewChars: 200, now });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.items[0].id, 'ses_fix0001TEST');
  assert.strictEqual(r.items[0].agent, 'opencode');
  assert.strictEqual(r.items[0].agentName, 'OpenCode');
  assert.strictEqual(r.items[0].title, 'OpenCode 夹具任务');
  assert.strictEqual(r.items[0].projectId, tmpDir);
  assert.strictEqual(r.items[0].state, 'active');
  const r2 = opencodeAdapter({ dbPath: path.join(tmpDir, 'no-such.db') }, { limit: 10, previewChars: 200, now });
  assert.strictEqual(r2.ok, false);
  assert.deepStrictEqual(r2.items, []);
});

// ------------------------------------------------ 桌面源健康探针（2026-11-03 评审尾巴）

test('collectDesktopSourceHealth：逐源 ok/detail；抛错源 ok:false 带 detail；路径缺失源 ok:false 不抛', () => {
  const health = collectDesktopSourceHealth(
    { enabled: true, sources: {
      workbuddy: { dbPath: path.join(tmpDir, 'no-such-wb.db') },
      zcode: { root: 'irrelevant' },
      codex: { root: 'no-such-codex' },
      opencode: { dbPath: path.join(tmpDir, 'no-such-oc.db') },
      hermes: { enabled: false }, // 显式关（评审 P2：缺键=默认启用会真探本机库，违反测试零真机数据纪律）
    } },
    { now, adapters: {
      zcode: () => { throw new Error('zcode 探针炸了'); },
    } }
  );
  assert.strictEqual(health.length, 5); // workbuddy/zcode/codex/opencode/hermes（2026-11-03 起五源）
  const byId = Object.fromEntries(health.map((h) => [h.id, h]));
  assert.strictEqual(byId.hermes.ok, null, '显式关闭的 hermes → ok:null 不计分母');
  assert.strictEqual(byId.zcode.ok, false, '适配器抛错 → ok:false（不再静默吞）');
  assert.ok(/zcode 探针炸了/.test(byId.zcode.detail), 'detail 带错误信息');
  assert.strictEqual(byId.codex.ok, false, '目录不存在 → ok:false');
  assert.ok(/不存在/.test(byId.codex.detail));
  assert.strictEqual(byId.opencode.ok, false, 'db 不存在 → ok:false');
  assert.ok(health.every((h) => typeof h.scannedAt === 'string' && h.name));
});

test('collectDesktopSourceHealth：正常源 ok:true；关闭源 ok=null 且不调适配器', () => {
  let codexCalled = 0;
  const health = collectDesktopSourceHealth(
    { enabled: true, sources: {
      zcode: { root: 'irrelevant' },
      codex: { enabled: false },
    } },
    { now, adapters: {
      zcode: () => ({ ok: true, detail: '1 会话', items: [{}] }),
      codex: () => { codexCalled += 1; return { ok: true, detail: '不该被调', items: [] }; },
    } }
  );
  const byId = Object.fromEntries(health.map((h) => [h.id, h]));
  assert.strictEqual(byId.zcode.ok, true);
  assert.strictEqual(byId.zcode.detail, '1 会话');
  assert.strictEqual(byId.codex.ok, null, '关闭源 ok=null（不计入健康分母）');
  assert.strictEqual(byId.codex.enabled, false);
  assert.strictEqual(codexCalled, 0, '关闭源不得调适配器');
});

test('总开关关闭：全部源 ok=null enabled=false', () => {
  const health = collectDesktopSourceHealth({ enabled: false, sources: {} }, { now });
  assert.ok(health.length === 5 && health.every((h) => h.enabled === false && h.ok === null));
});

test('路由级 GET /api/members/source-health：200 数组五源齐全，注入源 ok:true、默认关的 hermes ok:null', async () => {
  const r = await api('GET', '/api/members/source-health');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body) && r.body.length === 5);
  const zc = r.body.find((h) => h.id === 'zcode');
  assert.ok(zc && zc.ok === true, '主 fixture 的 zcode 注入源应 ok:true');
  const hm = r.body.find((h) => h.id === 'hermes');
  assert.ok(hm && hm.enabled === false && hm.ok === null, '主 fixture hermes 默认关 → ok:null 不计分母');
  assert.ok(r.body.every((h) => typeof h.id === 'string' && typeof h.name === 'string'));
});
