'use strict';

/**
 * agent-activity.test.js — v2.2 智能体工作观测：四源适配器（离线合成数据）+ 聚合/过滤/故障隔离
 * 覆盖：
 *  - zcode 适配器：agents/sess_N/metadata.json 标题+cwd、exec 下 call 日志尾部预览、目录不存在 ok:false
 *  - claude 适配器：jsonl 首行标题/尾行预览/cwd 字段项目、目录名解码兜底、mtime 排序、长文本截断
 *  - dsh 适配器：zstd 会话（首行元数据 cwd/createdAt、内容行预览）、rollout 明文兼容、损坏 zstd 降级
 *  - workbuddy 适配器：临时 SQLite 库（node:sqlite 建库写 ourselves，读取恒 {readOnly:true}）、
 *    last_activity_at 倒序、status→state 映射、库缺失 ok:false
 *  - 聚合：跨源 lastActiveAt 倒序、perSourceLimit/maxItems 封顶、?agent= 过滤、单源故障隔离、
 *    源禁用、previewChars 配置
 *  - 配置链：normalizeAgentActivity 缺省回填 / store.mergeConfigDefaults 深合并 / settings GET 视图
 *    与 PATCH 白名单校验 / GET /api/agent-activity 端点
 * 运行：node --test test/agent-activity.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('node:zlib');

const {
  DEFAULT_AGENT_ACTIVITY,
  normalizeAgentActivity,
  aggregateAgentActivity,
  zcodeAdapter,
  claudeAdapter,
  dshAdapter,
  workbuddyAdapter,
  decodeProjectDirName,
} = require('../lib/agentActivity');

const { buildApp } = require('./helpers/appAssembler');

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const OPTS = { limit: 10, previewChars: 200, now: NOW };

let tmpRoot;

function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function write(file, content, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (Number.isFinite(mtimeMs)) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

/** 目录 mtime（适配器以 sess 目录 mtime 排序/取 lastActiveAt，合成数据必须显式设置） */
function touchDir(dir, mtimeMs) {
  fs.utimesSync(dir, new Date(mtimeMs), new Date(mtimeMs));
}

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-agent-activity-'));
});

// ---------- 工具函数 ----------

test('decodeProjectDirName：dsh 实测编码（~XXXX~ 码点 + 盘符）与兜底', () => {
  assert.equal(decodeProjectDirName('--E-agent~5F00~53D1-FdeHarness--'), `E:\\agent开发\\FdeHarness`);
  assert.equal(
    decodeProjectDirName('--C-Users-Administrator-AppData-Local-Temp--'),
    `C:\\Users\\Administrator\\AppData\\Local\\Temp`
  );
  // claude 编码对项目名内 - 有损（已知，cwd 字段为主、此处仅兜底不炸）
  assert.equal(typeof decodeProjectDirName('E--agent---FdeHarness'), 'string');
  assert.equal(decodeProjectDirName(''), '');
});

// ---------- 适配器①：zcode ----------

test('zcode 适配器：metadata.json 标题/cwd + exec 日志尾部预览 + startedAt', () => {
  const root = mk(path.join(tmpRoot, 'zcode-basic', 'cli'));
  const t = (min) => NOW - min * 60 * 1000;
  const sess = 'sess_11111111-aaaa-2222-bbbb-cccccccccccc';
  const sessDir = path.join(root, 'agents', sess);
  write(
    path.join(sessDir, 'agent_99999999', 'metadata.json'),
    JSON.stringify({
      agentId: 'agent_99999999',
      createdAt: '2026-10-20T10:00:00.000Z',
      cwd: 'E:\\proj\\alpha',
      description: '摸清SkillHub工具箱机制',
    })
  );
  write(path.join(root, 'exec', sess, 'call_001-stdout.log'), 'earlier line\ndsh web: http://127.0.0.1:38082\n');
  // 写完子项后再 touch：目录 mtime 会因子目录/文件创建被刷新
  touchDir(sessDir, t(30));
  touchDir(path.join(root, 'exec', sess), t(20));

  const r = zcodeAdapter({ root }, OPTS);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.equal(it.agent, 'zcode');
  assert.equal(it.title, '摸清SkillHub工具箱机制');
  assert.equal(it.projectId, 'E:\\proj\\alpha');
  assert.equal(it.preview, 'dsh web: http://127.0.0.1:38082');
  assert.equal(it.startedAt, '2026-10-20T10:00:00.000Z');
  // lastActiveAt 取同会话 sess 目录簇的最大 mtime（exec 目录 NOW-20min 晚于 agents 目录 NOW-30min）
  assert.equal(it.lastActiveAt, new Date(t(20)).toISOString());
});

test('zcode 适配器：无 metadata 时占位标题「ZCode 会话 <短id>」', () => {
  const root = mk(path.join(tmpRoot, 'zcode-placeholder', 'cli'));
  const sess = 'sess_ab12cd34-0000-0000-0000-000000000000';
  const dir = mk(path.join(root, 'agents', sess));
  fs.utimesSync(dir, new Date(NOW - 60_000), new Date(NOW - 60_000));
  const r = zcodeAdapter({ root }, OPTS);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, 'ZCode 会话 ab12cd34');
  assert.equal(r.items[0].projectId, '');
});

test('zcode 适配器：db.sqlite 为主源（新版布局）——已删会话出局、旧 sess_* 目录兜底且同 id 不重复', () => {
  const base = mk(path.join(tmpRoot, 'zcode-db'));
  const root = mk(path.join(base, 'cli'));
  mk(path.join(root, 'db'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'db', 'db.sqlite'));
  try {
    db.exec(
      'CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_deleted INTEGER, last_outcome TEXT)'
    );
    const ins = db.prepare(
      'INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_deleted, last_outcome) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    ins.run('session_aaaa', 'p1', null, 'C:\\proj\\a', '新会话 A', NOW - 3600_000, NOW - 60_000, null, 'completed');
    ins.run('sess_bbbb', 'p2', null, 'C:\\proj\\b', '新会话 B', NOW - 7200_000, NOW - 120_000, null, 'error');
    ins.run('session_dead', 'p3', null, 'C:\\proj\\dead', '已删会话', NOW - 7200_000, NOW - 60_000, NOW - 30_000, 'completed');
  } finally {
    db.close();
  }
  // 旧格式目录：独有 id 应补进来，同 id 不应重复
  const legacyDir = mk(path.join(root, 'agents', 'sess_cccc'));
  write(
    path.join(legacyDir, 'agent_x', 'metadata.json'),
    JSON.stringify({ cwd: 'C:\\proj\\c', description: '旧目录会话', createdAt: new Date(NOW - 9000_000).toISOString() })
  );
  touchDir(legacyDir, NOW - 10 * 60_000);

  const r = zcodeAdapter({ root }, OPTS);
  assert.equal(r.ok, true);
  const ids = r.items.map((i) => i.id);
  assert.ok(ids.includes('session_aaaa') && ids.includes('sess_bbbb') && ids.includes('sess_cccc'), 'db 与旧目录合并');
  assert.ok(!ids.includes('session_dead'), 'time_deleted 的会话不入流');
  assert.equal(ids.filter((id) => id === 'session_aaaa').length, 1, '同 id 不重复');

  const a = r.items.find((i) => i.id === 'session_aaaa');
  assert.equal(a.title, '新会话 A');
  assert.equal(a.projectId, 'C:\\proj\\a');
  assert.equal(a.state, 'completed');
  assert.equal(r.items.find((i) => i.id === 'sess_bbbb').state, 'failed');
});

test('zcode 适配器：根目录不存在 → ok:false 不抛错', () => {
  const r = zcodeAdapter({ root: path.join(tmpRoot, 'zcode-missing') }, OPTS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.items, []);
  assert.match(r.detail, /目录不存在/);
});

// ---------- 适配器②：claude ----------

test('claude 适配器：首行标题/尾行预览/cwd 项目 + mtime 倒序', () => {
  const root = mk(path.join(tmpRoot, 'claude-basic', 'projects'));
  const dir = path.join(root, 'E--proj--beta');
  const t = (min) => NOW - min * 60 * 1000;
  const older = path.join(dir, 'aaaa1111-0000-0000-0000-000000000000.jsonl');
  const newer = path.join(dir, 'bbbb2222-0000-0000-0000-000000000000.jsonl');
  write(
    older,
    [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-20T09:00:00.000Z', sessionId: 'aaaa1111', content: '旧会话第一条消息' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: '旧会话最后输入' }),
    ].join('\n') + '\n',
    t(50)
  );
  const longTail = 'x'.repeat(500);
  write(
    newer,
    [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '新会话第一条：评审 FdeHarness 观测端点设计' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '中间回复' }] } }),
      JSON.stringify({ type: 'user', cwd: 'E:\\proj\\beta', message: { content: [{ type: 'text', text: `最后输出前缀 ${longTail}` }] } }),
    ].join('\n') + '\n',
    t(5)
  );

  const r = claudeAdapter({ root }, OPTS);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
  const [first, second] = r.items;
  // 新者在前（mtime 倒序）
  assert.equal(first.title, '新会话第一条：评审 FdeHarness 观测端点设计');
  assert.ok(first.preview.startsWith('最后输出前缀 xxxx'), '预览取最后一条有文本消息');
  assert.ok(first.preview.length <= 200, 'preview ≤ 200 字');
  assert.equal(first.projectId, 'E:\\proj\\beta', 'cwd 从文件内容提取');
  assert.equal(second.title, '旧会话第一条消息');
  assert.equal(second.preview, '旧会话最后输入');
  assert.equal(second.projectId, 'E:\\proj\\beta');
});

test('claude 适配器：文件无 cwd 时回退目录名解码', () => {
  const root = mk(path.join(tmpRoot, 'claude-decode', 'projects'));
  write(
    path.join(root, '--D-survey-work--', 'cccc3333-0000-0000-0000-000000000000.jsonl'),
    JSON.stringify({ type: 'queue-operation', content: '你好' }) + '\n',
    NOW - 120_000
  );
  const r = claudeAdapter({ root }, OPTS);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].projectId, 'D:\\survey\\work');
});

test('claude 适配器：目录不存在 → ok:false', () => {
  const r = claudeAdapter({ root: path.join(tmpRoot, 'claude-missing') }, OPTS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.items, []);
});

// ---------- 适配器③：dsh ----------

test('dsh 适配器：zstd 会话首行元数据（cwd/createdAt）+ rollout 明文兼容', () => {
  const root = mk(path.join(tmpRoot, 'dsh-basic', 'sessions'));
  const t = (min) => NOW - min * 60 * 1000;

  if (typeof zlib.zstdCompressSync !== 'function') {
    test.skip('node 缺 zstdCompressSync，跳过 zstd 用例');
    return;
  }
  const zstdLines = [
    JSON.stringify({ type: 'session', version: 4, id: 'session-e1234567', createdAt: NOW - 40 * 60_000, cwd: 'E:\\data\\deepseekarness' }),
    JSON.stringify({ type: 'message', content: 'dsh 会话中间产出内容' }),
  ].join('\n');
  write(
    path.join(root, '--E-data-deepseekarness--', 'session-e1234567-0000-0000-0000-000000000000', 'session.v4.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(zstdLines + '\n')),
    t(40)
  );

  write(
    path.join(root, 'rollout-layout', 'rollout-2026-10-20.jsonl'),
    [
      JSON.stringify({ type: 'session', cwd: 'E:\\legacy\\rollout' }),
      JSON.stringify({ type: 'message', content: 'rollout 旧布局最后一条消息' }),
    ].join('\n') + '\n',
    t(10)
  );

  const r = dshAdapter({ root }, OPTS);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
  const [newest, older] = r.items; // rollout t(10) 晚于 zstd t(40)，新者在前
  // zstd 会话（较旧者）
  assert.equal(older.agent, 'dsh');
  assert.equal(older.title, 'DSH 会话 e1234567');
  assert.equal(older.projectId, 'E:\\data\\deepseekarness');
  assert.equal(older.preview, 'dsh 会话中间产出内容');
  assert.equal(older.startedAt, new Date(t(40)).toISOString());
  // rollout 明文布局（较新者）
  assert.ok(newest.title.startsWith('DSH 会话 '), 'rollout 无 session- 目录名时占位标题不炸');
  assert.equal(newest.projectId, 'E:\\legacy\\rollout');
  assert.equal(newest.preview, 'rollout 旧布局最后一条消息');
});

test('dsh 适配器：损坏 zstd 降级为占位条目，不影响 ok:true', () => {
  const root = mk(path.join(tmpRoot, 'dsh-corrupt', 'sessions'));
  write(
    path.join(root, '--D-corrupt--', 'session-f0000000-0000-0000-0000-000000000000', 'session.jsonl.zstd'),
    Buffer.from('not-a-zstd-stream'),
    NOW - 300_000
  );
  const r = dshAdapter({ root }, OPTS);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, 'DSH 会话 f0000000');
  assert.equal(r.items[0].projectId, 'D:\\corrupt', '目录名解码兜底');
  assert.equal(r.items[0].preview, '');
});

test('dsh 适配器：目录不存在 → ok:false', () => {
  const r = dshAdapter({ root: path.join(tmpRoot, 'dsh-missing') }, OPTS);
  assert.equal(r.ok, false);
});

// ---------- 适配器④：workbuddy ----------

test('workbuddy 适配器：临时库倒序 + status→state 映射 + 库缺失 ok:false', () => {
  const dbPath = path.join(tmpRoot, 'workbuddy-basic', 'workbuddy.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath); // 测试自建临时库；被测侧恒 readOnly
  try {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, status TEXT, created_at INTEGER, last_activity_at INTEGER)');
    const ins = db.prepare('INSERT INTO sessions (id, cwd, title, status, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run('w-2', 'D:/env/workbuddy', '接入MCP Streamable HTTP服务', 'completed', NOW - 3600_000, NOW - 600_000);
    ins.run('w-1', 'D:/env/workbuddy', '运行中会话', 'running', NOW - 120_000, NOW - 60_000);
    ins.run('w-3', 'C:/other', null, 'weird-status', NOW - 7200_000, NOW - 5400_000);
  } finally {
    db.close();
  }

  const r = workbuddyAdapter({ dbPath }, OPTS);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 3);
  const [first, second, third] = r.items;
  assert.equal(first.agent, 'workbuddy');
  assert.equal(first.title, '运行中会话');
  assert.equal(first.state, 'active', 'running → active');
  assert.equal(second.title, '接入MCP Streamable HTTP服务');
  assert.equal(second.state, 'completed');
  assert.equal(third.title, 'WorkBuddy 会话 w-3', 'title 为空时占位');
  assert.equal(third.state, 'idle', '未知 status → idle');
  assert.equal(third.preview, '', '凭据红线：不读消息表，preview 恒空');

  const missing = workbuddyAdapter({ dbPath: path.join(tmpRoot, 'wb-missing.db') }, OPTS);
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /数据库不存在/);
});

// ---------- 聚合：排序 / 封顶 / 过滤 / 故障隔离 ----------

/** 搭一个五源合成环境（mtime 交错，验证跨源排序；codex 为 v2.9.14 起新增的活动面板第五源） */
function buildFourSources(tag) {
  const base = mk(path.join(tmpRoot, tag));
  const zRoot = mk(path.join(base, 'zcode-cli'));
  const cRoot = mk(path.join(base, 'claude-projects'));
  const dRoot = mk(path.join(base, 'dsh-sessions'));
  const dbPath = path.join(base, 'workbuddy.db');

  // zcode：mtime NOW-3min（sess 目录本身 mtime 是适配器排序/lastActive 依据，写完子项后再 touch）
  const zSessDir = mk(path.join(zRoot, 'agents', 'sess_22222222-0000-0000-0000-000000000000'));
  write(
    path.join(zSessDir, 'agent_x', 'metadata.json'),
    JSON.stringify({ cwd: 'E:\\p\\z', description: 'zcode 活', createdAt: '2026-10-20T11:00:00.000Z' })
  );
  touchDir(zSessDir, NOW - 3 * 60_000);
  // claude：mtime NOW-8min
  write(
    path.join(cRoot, 'proj', 'dddd4444-0000-0000-0000-000000000000.jsonl'),
    JSON.stringify({ type: 'queue-operation', content: 'claude 活' }) + '\n',
    NOW - 8 * 60_000
  );
  // dsh（rollout 明文即可）：mtime NOW-1min
  write(
    path.join(dRoot, 'proj', 'rollout-1.jsonl'),
    JSON.stringify({ type: 'session', cwd: 'E:\\p\\d' }) + '\n' + JSON.stringify({ content: 'dsh 活' }) + '\n',
    NOW - 60_000
  );
  // codex（v2.9.14 起进活动面板）：rollout-*.jsonl 首行 session_meta，mtime NOW-5min
  const xRoot = mk(path.join(base, 'codex-sessions'));
  write(
    path.join(xRoot, '2026', '10', '20', 'rollout-2026-10-20T10-00-00-codex-1.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-1', cwd: 'E:\\p\\c', timestamp: '2026-10-20T10:00:00.000Z' } }) +
      '\n' +
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'codex 活' }] } }) +
      '\n',
    NOW - 5 * 60_000
  );
  // workbuddy：last_activity NOW-15min
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, status TEXT, created_at INTEGER, last_activity_at INTEGER)');
    db.prepare('INSERT INTO sessions (id, cwd, title, status, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'wb-1', 'D:/p/w', 'wb 活', 'running', NOW - 3600_000, NOW - 15 * 60_000
    );
  } finally {
    db.close();
  }
  return {
    agentActivity: {
      enabled: true,
      sources: { zcode: { root: zRoot }, claude: { root: cRoot }, dsh: { root: dRoot }, workbuddy: { dbPath }, codex: { root: xRoot } },
    },
  };
}

test('聚合：跨源 lastActiveAt 倒序 + sources 全 ok', () => {
  const cfg = buildFourSources('agg-order');
  const r = aggregateAgentActivity(cfg, { now: NOW });
  assert.deepEqual(
    r.sources.map((s) => [s.id, s.ok]),
    [['zcode', true], ['claude', true], ['dsh', true], ['workbuddy', true], ['codex', true]]
  );
  assert.deepEqual(r.items.map((i) => i.agent), ['dsh', 'zcode', 'codex', 'claude', 'workbuddy'], '按 lastActiveAt 倒序交错');
  assert.ok(r.checkedAt);
  for (const it of r.items) {
    for (const k of ['agent', 'agentName', 'projectId', 'title', 'preview', 'startedAt', 'lastActiveAt', 'state']) {
      assert.ok(k in it, `条目字段 ${k} 存在`);
    }
  }
});

test('聚合：perSourceLimit 每源封顶 + maxItems 总量封顶', () => {
  const cfg = buildFourSources('agg-limit');
  // 另造 2 个 dsh 会话（共 3）验证 perSourceLimit=2
  const dRoot = cfg.agentActivity.sources.dsh.root;
  write(path.join(dRoot, 'proj', 'rollout-2.jsonl'), JSON.stringify({ content: 'd2' }) + '\n', NOW - 2 * 60_000);
  write(path.join(dRoot, 'proj', 'rollout-3.jsonl'), JSON.stringify({ content: 'd3' }) + '\n', NOW - 90_000);
  cfg.agentActivity.perSourceLimit = 2;
  cfg.agentActivity.maxItems = 3;

  const r = aggregateAgentActivity(cfg, { now: NOW });
  const dshCount = r.items.filter((i) => i.agent === 'dsh').length;
  assert.ok(dshCount <= 2, `dsh ≤ perSourceLimit(2)，实际 ${dshCount}`);
  assert.ok(r.items.length <= 3, `总量 ≤ maxItems(3)，实际 ${r.items.length}`);
});

test('聚合：?agent= 过滤（大小写不敏感）', () => {
  const cfg = buildFourSources('agg-filter');
  const all = aggregateAgentActivity(cfg, { now: NOW });
  assert.equal(all.items.length, 5);
  const filtered = aggregateAgentActivity(cfg, { agent: 'DSH', now: NOW });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].agent, 'dsh');
  assert.equal(filtered.sources.length, 5, '过滤不影响 sources 汇报');
});

test('聚合：单源故障隔离——dsh 根目录指向文件（非法）不影响其他四源', () => {
  const cfg = buildFourSources('agg-isolate');
  cfg.agentActivity.sources.dsh.root = cfg.agentActivity.sources.workbuddy.dbPath; // 文件路径非目录
  const r = aggregateAgentActivity(cfg, { now: NOW });
  const dsh = r.sources.find((s) => s.id === 'dsh');
  assert.equal(dsh.ok, false);
  const others = r.sources.filter((s) => s.id !== 'dsh');
  assert.ok(others.every((s) => s.ok === true), '其余四源不受影响');
  assert.equal(r.items.length, 4);
  assert.ok(!r.items.some((i) => i.agent === 'dsh'));
});

test('聚合：总开关/单源禁用 → ok:false + detail 标注，不产条目', () => {
  const cfg = buildFourSources('agg-disabled');
  cfg.agentActivity.sources.claude.enabled = false;
  const r = aggregateAgentActivity(cfg, { now: NOW });
  const claude = r.sources.find((s) => s.id === 'claude');
  assert.equal(claude.ok, false);
  assert.match(claude.detail, /未启用/);
  assert.ok(!r.items.some((i) => i.agent === 'claude'));

  const off = buildFourSources('agg-all-off');
  off.agentActivity = { enabled: false };
  const rOff = aggregateAgentActivity(off, { now: NOW });
  assert.deepEqual(rOff.items, []);
  assert.equal(rOff.sources.length, 5, '总关时五源均汇报 disabled');
});

test('聚合：previewChars 配置生效', () => {
  const cRoot = mk(path.join(tmpRoot, 'agg-preview', 'claude-projects'));
  write(
    path.join(cRoot, 'proj', 'eeee5555-0000-0000-0000-000000000000.jsonl'),
    JSON.stringify({ type: 'queue-operation', content: 'y'.repeat(300) }) + '\n',
    NOW - 60_000
  );
  const r = aggregateAgentActivity(
    { agentActivity: { previewChars: 50, sources: { claude: { root: cRoot }, zcode: { enabled: false }, dsh: { enabled: false }, workbuddy: { enabled: false }, codex: { enabled: false } } } },
    { now: NOW }
  );
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].preview.length, 50);
});

test('normalizeAgentActivity：缺省回填 + 部分配置不丢其他源默认', () => {
  const n = normalizeAgentActivity({ perSourceLimit: 3, sources: { zcode: { enabled: false } } });
  assert.equal(n.perSourceLimit, 3);
  assert.equal(n.maxItems, DEFAULT_AGENT_ACTIVITY.maxItems);
  assert.equal(n.sources.zcode.enabled, false);
  assert.equal(n.sources.claude.enabled, true, '未涉及的源保持默认开启');
  assert.equal(n.sources.workbuddy.dbPath, '', '未涉及的源路径保持默认空串');
  assert.deepEqual(normalizeAgentActivity(null), DEFAULT_AGENT_ACTIVITY);
  // 不污染默认常量
  assert.notEqual(n, DEFAULT_AGENT_ACTIVITY);
});

test('store.mergeConfigDefaults：旧配置（无 agentActivity 节）回填默认；部分节深合并', () => {
  const store = require('../lib/store');
  const merged = store.mergeConfigDefaults({ dataDir: 'data' });
  assert.deepEqual(merged.agentActivity, DEFAULT_AGENT_ACTIVITY);
  const partial = store.mergeConfigDefaults({
    agentActivity: { enabled: true, sources: { dsh: { enabled: false, root: 'X:\\custom' } } },
  });
  assert.equal(partial.agentActivity.sources.dsh.enabled, false);
  assert.equal(partial.agentActivity.sources.dsh.root, 'X:\\custom');
  assert.equal(partial.agentActivity.sources.zcode.enabled, true, '其他源默认不被抹掉');
  assert.equal(partial.agentActivity.previewChars, DEFAULT_AGENT_ACTIVITY.previewChars);
});

// ---------- 端点 + settings 集成 ----------

test('端点与 settings：GET /api/agent-activity + settings 视图带出 + PATCH 白名单', async () => {
  const cfg = buildFourSources('endpoint');
  const cfgPath = path.join(path.dirname(cfg.agentActivity.sources.workbuddy.dbPath), 'config.json');
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ port: 7831, host: '127.0.0.1', dataDir: 'data', webDir: 'web', gitea: { pollIntervalSec: 0 }, agentActivity: cfg.agentActivity })
  );
  const app = buildApp({ poller: 'manual', warmProbe: false, configPath: cfgPath });
  try {
    // 端点聚合
    const r = await app.fetch('GET', '/api/agent-activity');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items) && r.body.items.length === 5);
    assert.ok(Array.isArray(r.body.sources) && r.body.sources.length === 5);
    assert.ok(r.body.checkedAt);
    // agent 过滤
    const f = await app.fetch('GET', '/api/agent-activity?agent=workbuddy');
    assert.equal(f.body.items.length, 1);
    assert.equal(f.body.items[0].agent, 'workbuddy');
    // settings GET 视图带出
    const s = await app.fetch('GET', '/api/settings');
    assert.equal(s.body.agentActivity.enabled, true);
    assert.equal(s.body.agentActivity.perSourceLimit, 10);
    assert.equal(typeof s.body.agentActivity.sources.zcode.root, 'string');
    // settings PATCH：改单源开关生效且不丢其他源默认
    const p = await app.fetch('PATCH', '/api/settings', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentActivity: { sources: { zcode: { enabled: false } } } }),
    });
    assert.equal(p.status, 200);
    const s2 = await app.fetch('GET', '/api/settings');
    assert.equal(s2.body.agentActivity.sources.zcode.enabled, false);
    assert.equal(s2.body.agentActivity.sources.claude.enabled, true, 'PATCH 局部不抹其他源');
    const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    // 磁盘写回：sources 七源齐全（v2.6 桌面成员源 codex/opencode 参与 normalize 回填；hermes 2026-11-03
    // 第七源同款待遇；局部 PATCH 未抹掉其他源与键）
    assert.deepEqual(Object.keys(disk.agentActivity.sources).sort(), ['claude', 'codex', 'dsh', 'hermes', 'opencode', 'workbuddy', 'zcode']);
    assert.equal(disk.agentActivity.sources.dsh.root, cfg.agentActivity.sources.dsh.root, '未涉及源的原值保留');
    // settings PATCH：非法值 400
    const bad = await app.fetch('PATCH', '/api/settings', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentActivity: { perSourceLimit: 0 } }),
    });
    assert.equal(bad.status, 400);
    const bad2 = await app.fetch('PATCH', '/api/settings', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentActivity: { sources: { zcode: { enabled: 'yes' } } } }),
    });
    assert.equal(bad2.status, 400);
  } finally {
    app.close();
  }
});
