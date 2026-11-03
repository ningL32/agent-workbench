'use strict';

/**
 * agent-sessions.test.js — v2.3 会话阅读器后端：ref 双闸 + 六源归一化 + 分页限额 + 降级 + redact
 *
 * 覆盖（SPEC-READER v2.3 §8 A 验收口径）：
 *  - ref 编解码往返与穿越拒绝：坏 base64/坏 JSON/错源/错 kind/dsh `..` 与盘符/claude 文件名
 *    不合 uuid 正则/codex 路径形状不符/workbuddy id 非法字符/junction 越权 realpath（响应不回显路径）
 *  - 六源转录归一化（全合成 fixture）：zcode db 三表（含 time_deleted 排除、tool 状态映射）、
 *    claude JSONL（isSidechain/queue-operation/thinking 跳过、tool_use/tool_result 配对）、
 *    dsh zstd 多帧（R3：逐帧解压、chunks 流水行跳过）+ rollout 明文、codex rollout
 *    （session_meta/turn_context/world_state 处置、function_call/output 配对）、opencode 三表
 *    （无 sequence 列）、workbuddy 恒降级 degraded
 *  - 会话列表端点：条目形状、标题空回退「（未命名会话）」、title redact、lastActiveAt 倒序、
 *    limit 限额（默认/上限钳制）、键集游标翻页、BAD_AGENT、坏游标 400、源禁用空页
 *  - 转录端点：seq 升序、maxMessages 截断（truncated+total）、maxCharsPerMessage 尾部截断、
 *    redact（key 形态 + registerSecret 原值）、SESSION_NOT_FOUND
 *  - 活动流条目可选 ref（D5）：四源 ref 可解码回对应源
 *  - 配置链：normalizeAgentActivity 对 sessionList/transcript 兜底（F1）
 * 纪律：全部临时目录 + 合成数据，绝不触碰六源真实位置；after 统一清理。
 * 运行：node --test test/agent-sessions.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { buildApp } = require('./helpers/appAssembler');
const { createWorkbuddyDb } = require('./helpers/workbuddy-fixture');
const sessionRef = require('../lib/sessionRef');
const {
  listAgentSessions,
  getAgentTranscript,
  getDispatchPrompt,
  listDispatchPrompts,
  zstdDecompressFrames,
} = require('../lib/agentTranscript');
const { normalizeAgentActivity, DEFAULT_AGENT_ACTIVITY, aggregateAgentActivity } = require('../lib/agentActivity');
const redact = require('../lib/redact');

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const MIN = 60 * 1000;

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

// ---------- 合成 db 夹具 ----------

/** zcode：db/db.sqlite 三表（含 sequence 列与 time_deleted，形态与 R1/R2 实测一致） */
function createZcodeDb(dbPath, sessions) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  try { fs.rmSync(dbPath, { force: true }); } catch (e) { /* 首建不存在 */ }
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_deleted INTEGER);' +
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);' +
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);'
  );
  const insS = db.prepare('INSERT INTO session (id, directory, title, time_created, time_updated, time_deleted) VALUES (?,?,?,?,?,?)');
  const insM = db.prepare('INSERT INTO message (id, session_id, time_created, data, sequence) VALUES (?,?,?,?,?)');
  const insP = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data, sequence) VALUES (?,?,?,?,?,?)');
  for (const s of sessions) {
    insS.run(s.id, s.directory || '', s.title === undefined ? null : s.title, s.tc, s.tu, s.deleted ? s.deleted : null);
    let seq = 0;
    for (const m of s.messages || []) {
      const mid = `${s.id}#m${seq}`;
      insM.run(mid, s.id, m.tc, JSON.stringify({ role: m.role, time: { start: m.tc, end: m.tc } }), seq);
      let pseq = 0;
      for (const p of m.parts || []) {
        insP.run(`${mid}#p${pseq}`, mid, s.id, m.tc, JSON.stringify(p), pseq);
        pseq += 1;
      }
      seq += 1;
    }
  }
  db.close();
  return dbPath;
}

/** opencode：opencode.db 三表（无 sequence 列，R2 实测；凭据红线内仅这三张表） */
function createOpencodeReaderDb(dbPath, sessions) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  try { fs.rmSync(dbPath, { force: true }); } catch (e) { /* 首建不存在 */ }
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);' +
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);' +
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);'
  );
  const insS = db.prepare('INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)');
  const insM = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
  const insP = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)');
  for (const s of sessions) {
    insS.run(s.id, s.directory || '', s.title === undefined ? null : s.title, s.tc, s.tu);
    let seq = 0;
    for (const m of s.messages || []) {
      const mid = `${s.id}#m${seq}`;
      insM.run(mid, s.id, m.tc, m.tc, JSON.stringify({ role: m.role, time: { start: m.tc } }));
      let pseq = 0;
      for (const p of m.parts || []) {
        insP.run(`${mid}#p${pseq}`, mid, s.id, m.tc + pseq, m.tc + pseq, JSON.stringify(p));
        pseq += 1;
      }
      seq += 1;
    }
  }
  db.close();
  return dbPath;
}

/** dsh 多帧 zstd：逐行独立 zstd 帧拼接（R3 实测形态：每帧行自带换行） */
function writeMultiFrameZstd(file, lines) {
  const bufs = lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8')));
  return write(file, Buffer.concat(bufs));
}

// ---------- fixture 根 ----------

const UUID1 = '11111111-aaaa-2222-bbbb-cccccccccccc';
const CLAUDE_FILE = '22222222-bbbb-3333-cccc-dddddddddddd.jsonl';
const CODEX_REL = '2026/10/20/rollout-abc123.jsonl';
const DSH_REL = 'proj-beta/session-33333333/session.jsonl.zstd';
const DSH_ROLL_REL = 'proj-beta/session-plain/rollout-9.jsonl';

const zcodeSessions = [
  {
    id: `sess_${UUID1}`,
    directory: 'E:\\proj\\alpha',
    title: '修复登录 bug 并回归',
    tc: NOW - 30 * MIN,
    tu: NOW - 5 * MIN,
    messages: [
      { role: 'user', tc: NOW - 30 * MIN, parts: [{ type: 'text', text: '帮我看看登录页 500 的原因' }] },
      {
        role: 'assistant',
        tc: NOW - 29 * MIN,
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '好的，我先复现。' },
          { type: 'tool', callID: 'call_z1', tool: 'read', state: { status: 'completed', input: { filePath: 'a.js' }, output: 'const x = 1;' } },
        ],
      },
      {
        role: 'assistant',
        tc: NOW - 28 * MIN,
        parts: [{ type: 'tool', callID: 'call_z2', tool: 'write', state: { status: 'error', input: { path: 'b.js' }, output: 'EACCES' } }],
      },
    ],
  },
  {
    id: 'session_4444555566667777888899990000aaaa',
    directory: 'E:\\proj\\alpha',
    title: null, // 空标题 → （未命名会话）
    tc: NOW - 50 * MIN,
    tu: NOW - 40 * MIN,
    messages: [{ role: 'user', tc: NOW - 50 * MIN, parts: [{ type: 'text', text: '第二条会话' }] }],
  },
  {
    id: `sess_${UUID1.replace('11111111', '99999999')}`,
    directory: 'E:\\proj\\gone',
    title: '已删除会话（列表/全文均排除）',
    tc: NOW - 70 * MIN,
    tu: NOW - 60 * MIN,
    deleted: NOW - 10 * MIN,
    messages: [],
  },
];

const claudeLines = [
  JSON.stringify({ type: 'user', timestamp: '2026-10-20T10:00:00.000Z', cwd: 'E:\\proj\\alpha', message: { role: 'user', content: '修一下登录 bug' } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '我来修' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T10:02:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } }),
  JSON.stringify({ type: 'user', timestamp: '2026-10-20T10:03:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a.js\nb.js' }] }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T10:04:00.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '内心戏不进正文' }, { type: 'text', text: '修好了' }] } }),
  JSON.stringify({ type: 'user', isSidechain: true, timestamp: '2026-10-20T10:05:00.000Z', message: { role: 'user', content: '旁支子代理不进主转录' } }),
  JSON.stringify({ type: 'queue-operation', content: '不该出现在转录里' }),
].join('\n');

const dshLines = [
  JSON.stringify({ type: 'session', version: 0, id: 'session-33333333', createdAt: NOW - 90 * MIN, cwd: 'E:\\proj\\beta', delegationDepth: 0 }),
  JSON.stringify({ type: 'permission/preset', seq: 0, time: NOW - 90 * MIN, data: { preset: 'workspace-write' } }),
  JSON.stringify({ type: 'session/title', seq: 1, time: NOW - 89 * MIN, data: { title: '安装graph-memory插件', source: { kind: 'fallback' } } }),
  JSON.stringify({ type: 'user/message', seq: 2, time: NOW - 88 * MIN, data: { content: [{ type: 'text', text: '部署到测试环境' }], role: 'user' } }),
  JSON.stringify({ type: 'assistant/chunk', seq: 3, time: NOW - 87 * MIN, data: { chunk: { type: 'block-start', blockType: 'reasoning' } } }),
  JSON.stringify({ type: 'reasoning-chunks', seq: 4, time: NOW - 87 * MIN, data: { texts: ['思考碎片不进正文'] } }),
  JSON.stringify({ type: 'assistant/message', seq: 5, time: NOW - 86 * MIN, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '开始部署' }] } } }),
  JSON.stringify({ type: 'tool/call', seq: 6, time: NOW - 85 * MIN, data: { callId: 'c1', name: 'pwsh', arguments: '{"cmd":"deploy"}' } }),
  JSON.stringify({ type: 'tool/result', seq: 7, time: NOW - 84 * MIN, data: { message: { source: { kind: 'tool', callId: 'c1' }, role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'deployed ok' }], isError: false }] } } }),
];

const dshRollLines = [
  JSON.stringify({ type: 'session', id: 'session-plain', createdAt: NOW - 200 * MIN, cwd: 'E:\\proj\\plain' }),
  JSON.stringify({ type: 'user/message', seq: 0, time: NOW - 199 * MIN, data: { content: [{ type: 'text', text: '明文 rollout 兼容' }], role: 'user' } }),
];

const codexLines = [
  JSON.stringify({ timestamp: '2026-10-20T09:00:00.000Z', type: 'session_meta', payload: { id: 'cx1', cwd: 'E:\\proj\\gamma', timestamp: '2026-10-20T09:00:00.000Z' } }),
  JSON.stringify({ timestamp: '2026-10-20T09:00:01.000Z', type: 'turn_context', payload: { cwd: 'E:\\proj\\gamma' } }),
  JSON.stringify({ timestamp: '2026-10-20T09:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: '列出目录' }] } }),
  JSON.stringify({ timestamp: '2026-10-20T09:02:00.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'call_1', arguments: '{"cmd":"dir"}' } }),
  JSON.stringify({ timestamp: '2026-10-20T09:03:00.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' } }),
  JSON.stringify({ timestamp: '2026-10-20T09:04:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: '共 2 个文件' }] } }),
  JSON.stringify({ timestamp: '2026-10-20T09:05:00.000Z', type: 'world_state', payload: { snapshot: 'x' } }),
];

const opencodeSessions = [
  {
    id: 'ses_ea5e4e269ffewd3HsO766sTiNj',
    directory: 'E:\\proj\\delta',
    title: 'OpenCode 阅读器任务',
    tc: NOW - 20 * MIN,
    tu: NOW - 2 * MIN,
    messages: [
      { role: 'user', tc: NOW - 20 * MIN, parts: [{ type: 'text', text: '读一下规格' }] },
      { role: 'assistant', tc: NOW - 19 * MIN, parts: [{ type: 'tool', tool: 'read', callID: 'call_o1', state: { status: 'completed', input: { filePath: 'SPEC.md' }, output: '# SPEC' } }, { type: 'text', text: '读完了' }] },
    ],
  },
];

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-agent-sessions-'));
  // zcode
  const zroot = mk(path.join(tmpRoot, 'zcode', 'cli'));
  createZcodeDb(path.join(zroot, 'db', 'db.sqlite'), zcodeSessions);
  // 活动流适配器仍扫目录（R1：目录名 = db session.id）——建 agents/<id>/ 供 D5 ref 用例
  write(
    path.join(zroot, 'agents', `sess_${UUID1}`, 'agent_00000000', 'metadata.json'),
    JSON.stringify({ createdAt: new Date(NOW - 30 * MIN).toISOString(), cwd: 'E:\\proj\\alpha', description: '活动流元数据标题' }),
    NOW - 5 * MIN
  );
  globalThis.zroot = zroot;
  // claude
  const croot = mk(path.join(tmpRoot, 'claude', 'projects'));
  write(path.join(croot, 'proj-alpha', CLAUDE_FILE), claudeLines + '\n', NOW - 3 * MIN);
  globalThis.croot = croot;
  // dsh
  const droot = mk(path.join(tmpRoot, 'dsh', 'sessions'));
  writeMultiFrameZstd(path.join(droot, ...DSH_REL.split('/')), dshLines);
  write(path.join(droot, ...DSH_ROLL_REL.split('/')), dshRollLines.join('\n') + '\n', NOW - 180 * MIN);
  globalThis.droot = droot;
  // codex
  const xroot = mk(path.join(tmpRoot, 'codex', 'sessions'));
  write(path.join(xroot, ...CODEX_REL.split('/')), codexLines.join('\n') + '\n', NOW - 15 * MIN);
  globalThis.xroot = xroot;
  // opencode
  const oroot = mk(path.join(tmpRoot, 'opencode'));
  createOpencodeReaderDb(path.join(oroot, 'opencode.db'), opencodeSessions);
  globalThis.oroot = oroot;
  // workbuddy
  createWorkbuddyDb(path.join(tmpRoot, 'workbuddy.db'), [
    { id: 'wb-read-01', cwd: 'E:\\proj\\eps', title: 'WorkBuddy 列表可见', status: 'running', created_at: NOW - 10 * MIN, last_activity_at: NOW - 1 * MIN },
  ]);
});

// ---------- 六源源配置与完整 config ----------

function sourcesOverrides() {
  return {
    zcode: { root: globalThis.zroot },
    claude: { root: globalThis.croot },
    dsh: { root: globalThis.droot },
    codex: { root: globalThis.xroot },
    opencode: { dbPath: path.join(globalThis.oroot, 'opencode.db') },
    workbuddy: { dbPath: path.join(tmpRoot, 'workbuddy.db') },
  };
}

function buildCfg(extra) {
  const extraAA = (extra && extra.agentActivity) || {};
  return {
    agentActivity: Object.assign(
      { enabled: true, perSourceLimit: 10, maxItems: 40, previewChars: 200 },
      extraAA,
      {
        sources: Object.assign(sourcesOverrides(), extraAA.sources || {}),
      }
    ),
  };
}

// ---------- ref 双闸（§3.3 / D1） ----------

test('ref：encode/decode 往返一致；decode 形状浅检', () => {
  const ref = sessionRef.encodeRef({ s: 'zcode', k: 'session', v: { id: `sess_${UUID1}` } });
  assert.equal(sessionRef.decodeRef(ref).v.id, `sess_${UUID1}`);
  assert.equal(sessionRef.decodeRef('!!!not-base64url!!!'), null);
  assert.equal(sessionRef.decodeRef(Buffer.from('[1,2]'.padEnd(8, 'x')).toString('base64url')), null, '非对象 JSON → null');
});

test('ref 双闸：会话 id 类 locator 形状校验（zcode 三形态 / opencode uuid / workbuddy 字符集）', () => {
  const cfg = buildCfg();
  // zcode 实测三形态均放行
  for (const id of [`sess_${UUID1}`, 'session_1510f7eae46faeae91707ad89ecc98dd', 'sess_subagent_agent_572b23d3-6f20-42fc-a0ea-c32770278d8d']) {
    const loc = sessionRef.validateRef(sessionRef.encodeRef({ s: 'zcode', k: 'session', v: { id } }), cfg);
    assert.equal(loc.v.id, id);
  }
  sessionRef.validateRef(sessionRef.encodeRef({ s: 'opencode', k: 'session', v: { id: 'ses_ea5e4e269ffewd3HsO766sTiNj' } }), cfg);
  // 非法 id
  for (const bad of [{ s: 'zcode', k: 'session', v: { id: 'not-a-session-id' } }, { s: 'opencode', k: 'session', v: { id: '../etc/passwd' } }, { s: 'opencode', k: 'session', v: { id: '55555555-aaaa-6666-bbbb-cccccccccccc' } }, { s: 'workbuddy', k: 'session', v: { id: 'a/b\\c' } }]) {
    assert.throws(() => sessionRef.validateRef(sessionRef.encodeRef(bad), cfg), (e) => e.status === 400 && e.code === 'BAD_REF');
  }
});

test('ref 双闸：错源/错 kind/坏 base64/坏 JSON 一律 400 BAD_REF', () => {
  const cfg = buildCfg();
  const bads = [
    'not-base64!!',
    Buffer.from('{"s":"zcode"').toString('base64url'), // 坏 JSON
    Buffer.from('"a string"').toString('base64url'), // 非 JSON 对象
    sessionRef.encodeRef({ s: 'nope', k: 'session', v: { id: 'sess_' + UUID1 } }), // 错源
    sessionRef.encodeRef({ s: 'zcode', k: 'file', v: { path: 'x.jsonl' } }), // 错 kind
    sessionRef.encodeRef({ s: 'claude', k: 'session', v: { id: 'x' } }), // claude 无 session 种类
    sessionRef.encodeRef({ s: 'claude', k: 'project', v: { dir: '..', file: CLAUDE_FILE } }),
    sessionRef.encodeRef({ s: 'claude', k: 'project', v: { dir: 'a\\b', file: CLAUDE_FILE } }), // 目录含分隔符
    sessionRef.encodeRef({ s: 'claude', k: 'project', v: { dir: 'proj-alpha', file: 'secret.jsonl' } }), // 文件名不合 uuid 正则
    sessionRef.encodeRef({ s: 'dsh', k: 'file', v: { path: 'proj/../../etc/session.jsonl.zstd' } }), // ..
    sessionRef.encodeRef({ s: 'dsh', k: 'file', v: { path: 'C:/win/session.jsonl.zstd' } }), // 盘符
    sessionRef.encodeRef({ s: 'dsh', k: 'file', v: { path: '\\\\srv\\share\\session.jsonl.zstd' } }), // UNC/绝对
    sessionRef.encodeRef({ s: 'dsh', k: 'file', v: { path: 'proj/other.txt' } }), // 基名不合
    sessionRef.encodeRef({ s: 'codex', k: 'file', v: { path: '2026/10/rollout-x.jsonl' } }), // 段数不符
    sessionRef.encodeRef({ s: 'codex', k: 'file', v: { path: '2026/AB/20/rollout-x.jsonl' } }), // 月不合
    sessionRef.encodeRef({ s: 'codex', k: 'file', v: { path: '2026/10/20/notrollout.jsonl' } }), // 基名不合
  ];
  for (const ref of bads) {
    assert.throws(() => sessionRef.validateRef(ref, cfg), (e) => e.status === 400 && e.code === 'BAD_REF', `应拒: ${ref.slice(0, 40)}`);
  }
});

test('ref 双闸：路径类 locator 越权 realpath（junction 逃逸）→ 400 且响应不回显目标路径', () => {
  const secretDir = mk(path.join(tmpRoot, 'outside-secret'));
  write(path.join(secretDir, 'session.jsonl.zstd'), '密料');
  const root = mk(path.join(tmpRoot, 'dsh-escape', 'sessions', 'proj'));
  fs.symlinkSync(secretDir, path.join(root, 'session-esc'), 'junction');
  const cfgDsh = { agentActivity: { sources: { dsh: { root: path.dirname(root) } } } };
  const ref = sessionRef.encodeRef({ s: 'dsh', k: 'file', v: { path: 'proj/session-esc/session.jsonl.zstd' } });
  let err = null;
  try {
    getAgentTranscript(cfgDsh, ref, { now: NOW });
  } catch (e) {
    err = e;
  }
  assert.ok(err && err.status === 400 && err.code === 'BAD_REF', '越权 realpath 必须 400 BAD_REF');
  assert.ok(!String(err.message).includes('outside-secret'), '错误信息不得回显解析后路径');
});

test('ref 双闸：形状合法但文件不存在 → 400 BAD_REF（realpath 不过，规格字面）', () => {
  const ref = sessionRef.encodeRef({ s: 'dsh', k: 'file', v: { path: 'proj-beta/session-dead/session.jsonl.zstd' } });
  assert.throws(
    () => getAgentTranscript({ agentActivity: { sources: { dsh: { root: globalThis.droot } } } }, ref, { now: NOW }),
    (e) => e.status === 400 && e.code === 'BAD_REF'
  );
});

// ---------- 六源转录归一化（§3.4） ----------

test('zcode 转录：role/text 顺序、tool 状态映射、db 为准、标题与项目取 session 表', () => {
  const cfg = buildCfg();
  const ref = sessionRef.encodeRef({ s: 'zcode', k: 'session', v: { id: `sess_${UUID1}` } });
  const r = getAgentTranscript(cfg, ref, { now: NOW });
  assert.equal(r.degraded, false);
  assert.equal(r.projectId, 'E:\\proj\\alpha');
  assert.ok(r.title.includes('修复登录 bug'));
  assert.deepEqual(
    r.messages.map((m) => [m.role, m.tool && m.tool.status]),
    [
      ['user', null],
      ['assistant', null],
      ['tool', 'ok'],
      ['tool', 'error'],
    ]
  );
  assert.equal(r.messages[0].text, '帮我看看登录页 500 的原因');
  assert.equal(r.messages[2].tool.name, 'read');
  assert.ok(r.messages[2].text.includes('const x = 1;'), 'tool part 应含 state.output');
  assert.equal(r.messages[3].tool.name, 'write');
  assert.ok(r.messages.every((m, i) => m.seq === i + 1), 'seq 连续升序');
  // step-start 等非正文 part 不进转录
  assert.ok(r.messages.every((m) => m.text !== undefined));
});

test('zcode 转录：已删会话（time_deleted 非空）→ 404 SESSION_NOT_FOUND', () => {
  const ref = sessionRef.encodeRef({ s: 'zcode', k: 'session', v: { id: `sess_${UUID1.replace('11111111', '99999999')}` } });
  assert.throws(() => getAgentTranscript(buildCfg(), ref, { now: NOW }), (e) => e.status === 404 && e.code === 'SESSION_NOT_FOUND');
});

test('zcode 转录：id 不存在 → 404 SESSION_NOT_FOUND', () => {
  const ref = sessionRef.encodeRef({ s: 'zcode', k: 'session', v: { id: 'sess_88888888-aaaa-bbbb-cccc-dddddddddddd' } });
  assert.throws(() => getAgentTranscript(buildCfg(), ref, { now: NOW }), (e) => e.status === 404);
});

test('claude 转录：text/tool_use/tool_result 块拆分、isSidechain/queue-op/thinking 跳过、result 配对继承工具名', () => {
  const ref = sessionRef.encodeRef({ s: 'claude', k: 'project', v: { dir: 'proj-alpha', file: CLAUDE_FILE } });
  const r = getAgentTranscript(buildCfg(), ref, { now: NOW });
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'assistant']);
  assert.equal(r.messages[0].text, '修一下登录 bug');
  assert.deepEqual(r.messages[2].tool, { name: 'Bash', status: 'ok' });
  assert.ok(r.messages[2].text.includes('"command"'), 'tool_use 入参进 text');
  assert.deepEqual(r.messages[3].tool, { name: 'Bash', status: 'ok' });
  assert.equal(r.messages[3].text, 'a.js\nb.js');
  assert.equal(r.messages[4].text, '修好了');
  assert.equal(r.projectId, 'E:\\proj\\alpha');
  assert.ok(r.messages.every((m) => !String(m.text).includes('旁支子代理') && !String(m.text).includes('不该出现') && !String(m.text).includes('内心戏')));
  assert.equal(r.messages[0].ts, '2026-10-20T10:00:00.000Z');
});

test('claude 转录：tool_result is_error → status error', () => {
  const croot2 = mk(path.join(tmpRoot, 'claude-err', 'projects'));
  write(
    path.join(croot2, 'proj-err', '33333333-0000-1111-2222-333333333333.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: '跑一下' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', is_error: true, content: 'boom' }] } }),
    ].join('\n') + '\n'
  );
  const cfg = buildCfg({ agentActivity: { sources: { claude: { root: croot2 } } } });
  const ref = sessionRef.encodeRef({ s: 'claude', k: 'project', v: { dir: 'proj-err', file: '33333333-0000-1111-2222-333333333333.jsonl' } });
  const r = getAgentTranscript(cfg, ref, { now: NOW });
  assert.deepEqual(r.messages[2].tool, { name: 'Bash', status: 'error' });
});

test('dsh 转录：多帧 zstd 逐帧解压、流水行跳过、tool/call+result 配对、标题=首条 user 文本', () => {
  const ref = sessionRef.encodeRef({ s: 'dsh', k: 'file', v: { path: DSH_REL } });
  const r = getAgentTranscript(buildCfg(), ref, { now: NOW });
  assert.equal(r.degraded, false);
  assert.deepEqual(
    r.messages.map((m) => [m.role, m.tool && m.tool.status]),
    [
      ['user', null],
      ['assistant', null],
      ['tool', 'running'],
      ['tool', 'ok'],
    ]
  );
  assert.equal(r.messages[0].text, '部署到测试环境');
  assert.equal(r.title, '部署到测试环境');
  assert.equal(r.messages[1].text, '开始部署', 'reasoning 块不进正文');
  assert.deepEqual(r.messages[2].tool, { name: 'pwsh', status: 'running' });
  assert.deepEqual(r.messages[3].tool, { name: 'pwsh', status: 'ok' });
  assert.equal(r.projectId, 'E:\\proj\\beta');
  assert.ok(r.messages.every((m) => !String(m.text).includes('思考碎片') && !String(m.text).includes('不该出现')));
  void dshLines;
});

test('dsh 转录：rollout 明文分支同构', () => {
  const ref = sessionRef.encodeRef({ s: 'dsh', k: 'file', v: { path: DSH_ROLL_REL } });
  const r = getAgentTranscript(buildCfg(), ref, { now: NOW });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, 'user');
  assert.equal(r.messages[0].text, '明文 rollout 兼容');
});

test('dsh：zstdDecompressFrames 与单帧文件兼容；伪 magic 帧跳过不致命', () => {
  const single = zlib.zstdCompressSync(Buffer.from('{"type":"session"}\n'));
  assert.equal(zstdDecompressFrames(single).text, '{"type":"session"}\n');
  const bogus = Buffer.concat([single, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('garbage')]);
  const r2 = zstdDecompressFrames(bogus);
  assert.ok(r2.text.includes('{"type":"session"}'));
});

test('codex 转录：session_meta 头部、function_call/output 配对、turn_context/world_state 跳过', () => {
  const ref = sessionRef.encodeRef({ s: 'codex', k: 'file', v: { path: CODEX_REL } });
  const r = getAgentTranscript(buildCfg(), ref, { now: NOW });
  assert.deepEqual(
    r.messages.map((m) => [m.role, m.tool && m.tool.status]),
    [
      ['user', null],
      ['tool', 'running'],
      ['tool', 'ok'],
      ['assistant', null],
    ]
  );
  assert.deepEqual(r.messages[1].tool, { name: 'shell', status: 'running' });
  assert.deepEqual(r.messages[2].tool, { name: 'shell', status: 'ok' });
  assert.equal(r.messages[2].text, 'a.txt\nb.txt');
  assert.equal(r.projectId, 'E:\\proj\\gamma');
  assert.ok(r.messages[0].ts === '2026-10-20T09:01:00.000Z');
});

test('opencode 转录：无 sequence 列按 time_created,rowid 排序；tool 状态映射', () => {
  const ref = sessionRef.encodeRef({ s: 'opencode', k: 'session', v: { id: 'ses_ea5e4e269ffewd3HsO766sTiNj' } });
  const r = getAgentTranscript(buildCfg(), ref, { now: NOW });
  assert.deepEqual(
    r.messages.map((m) => [m.role, m.tool && m.tool.status]),
    [
      ['user', null],
      ['tool', 'ok'],
      ['assistant', null],
    ]
  );
  assert.equal(r.title, 'OpenCode 阅读器任务');
  assert.equal(r.projectId, 'E:\\proj\\delta');
  assert.equal(r.messages[2].text, '读完了');
});

test('workbuddy 转录：恒降级 200 degraded（D4），ref/title 仍齐备', () => {
  const ref = sessionRef.encodeRef({ s: 'workbuddy', k: 'session', v: { id: 'wb-read-01' } });
  const r = getAgentTranscript(buildCfg(), ref, { now: NOW });
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'SOURCE_NO_TRANSCRIPT');
  assert.deepEqual(r.messages, []);
  assert.equal(r.title, 'WorkBuddy 列表可见');
  assert.equal(r.ref, ref);
});

test('workbuddy 转录：id 不存在 → 404', () => {
  const ref = sessionRef.encodeRef({ s: 'workbuddy', k: 'session', v: { id: 'no-such-row' } });
  assert.throws(() => getAgentTranscript(buildCfg(), ref, { now: NOW }), (e) => e.status === 404);
});

// ---------- 会话列表（§3.1） ----------

test('列表：zcode 以 db session 表为准（已删排除、空标题回退、倒序、条目形状、ref 可回查）', () => {
  const r = listAgentSessions(buildCfg(), { agent: 'zcode', now: NOW });
  assert.equal(r.agent, 'zcode');
  assert.equal(r.items.length, 2, '已删会话不出现');
  assert.ok(r.items[0].lastActiveAt >= r.items[1].lastActiveAt, 'lastActiveAt 倒序');
  assert.ok(r.items[0].title.includes('修复登录 bug'));
  assert.equal(r.items[1].title, '（未命名会话）');
  for (const it of r.items) {
    for (const k of ['ref', 'id', 'title', 'projectId', 'startedAt', 'lastActiveAt', 'state']) {
      assert.ok(Object.prototype.hasOwnProperty.call(it, k), `条目应含 ${k}`);
    }
    assert.equal(sessionRef.decodeRef(it.ref).s, 'zcode');
  }
  assert.equal(r.items[0].state, 'active', '5 分钟前活跃 → active');
  assert.equal(r.items[1].state, 'idle', '40 分钟前 → idle');
  assert.equal(r.nextCursor, null);
});

test('列表：六源各自可出清单（dsh 标题=首条 user 文本、codex 标题=首条 user、claude 标题=首条有文本行）', () => {
  for (const agent of ['claude', 'dsh', 'codex', 'opencode', 'workbuddy']) {
    const r = listAgentSessions(buildCfg(), { agent, now: NOW });
    assert.ok(Array.isArray(r.items) && r.items.length >= 1, `${agent} 至少 1 条`);
    assert.equal(sessionRef.decodeRef(r.items[0].ref).s, agent);
  }
  const dshList = listAgentSessions(buildCfg(), { agent: 'dsh', now: NOW });
  assert.ok(dshList.items.some((i) => i.title === '部署到测试环境'), 'dsh 标题取首条 user 文本前 60 字');
  const claudeList = listAgentSessions(buildCfg(), { agent: 'claude', now: NOW });
  assert.ok(claudeList.items.some((i) => i.title === '修一下登录 bug'));
  const wb = listAgentSessions(buildCfg(), { agent: 'workbuddy', now: NOW });
  assert.equal(wb.items[0].state, 'active', 'workbuddy running → active');
});

test('列表：limit 缺省 20、超上限按 maxLimit 钳制、键集游标翻页不重不漏', () => {
  // 造 5 条 zcode 会话（独立夹具）
  const zroot2 = mk(path.join(tmpRoot, 'zcode-page', 'cli'));
  createZcodeDb(
    path.join(zroot2, 'db', 'db.sqlite'),
    [1, 2, 3, 4, 5].map((n) => ({
      id: `sess_${UUID1.replace('11111111', String(10000000 + n))}`,
      directory: 'E:\\p',
      title: `第 ${n} 条`,
      tc: NOW - n * MIN,
      tu: NOW - n * MIN,
      messages: [{ role: 'user', tc: NOW - n * MIN, parts: [{ type: 'text', text: `消息 ${n}` }] }],
    }))
  );
  const cfg = buildCfg({ agentActivity: { sessionList: { limit: 20, maxLimit: 2 }, sources: { zcode: { root: zroot2 } } } });
  const page1 = listAgentSessions(cfg, { agent: 'zcode', limit: 5, now: NOW }); // 5 > maxLimit(2) → 钳 2
  assert.equal(page1.items.length, 2);
  assert.deepEqual(page1.items.map((i) => i.title), ['第 1 条', '第 2 条']);
  assert.ok(page1.nextCursor, '有下一页');
  const page2 = listAgentSessions(cfg, { agent: 'zcode', limit: 5, cursor: page1.nextCursor, now: NOW });
  assert.deepEqual(page2.items.map((i) => i.title), ['第 3 条', '第 4 条']);
  const page3 = listAgentSessions(cfg, { agent: 'zcode', limit: 5, cursor: page2.nextCursor, now: NOW });
  assert.deepEqual(page3.items.map((i) => i.title), ['第 5 条']);
  assert.equal(page3.nextCursor, null, '翻尽后 nextCursor=null');
  // 缺省 limit=20：分页夹具（5 条）全量一页拉平
  const all = listAgentSessions({ agentActivity: { sources: { zcode: { root: zroot2 } } } }, { agent: 'zcode', now: NOW });
  assert.equal(all.items.length, 5);
  void zroot2;
});

test('列表：project 过滤只出该项目（v2.9.3 钻取防跨项目串组），过滤态游标翻页不串组', () => {
  // 造 4 条 zcode 会话：2 条在 FdeHarness、1 条在 FilesAdmin、1 条无目录（未知项目组）
  const zroot3 = mk(path.join(tmpRoot, 'zcode-proj', 'cli'));
  createZcodeDb(
    path.join(zroot3, 'db', 'db.sqlite'),
    [
      { id: `sess_${UUID1.replace('11111111', '20000001')}`, directory: 'E:\\agent开发\\FdeHarness', title: 'FdeHarness 会话A', tc: NOW - 1 * MIN, tu: NOW - 1 * MIN, messages: [] },
      { id: `sess_${UUID1.replace('11111111', '20000002')}`, directory: 'E:\\agent开发\\FdeHarness', title: 'FdeHarness 会话B', tc: NOW - 2 * MIN, tu: NOW - 2 * MIN, messages: [] },
      { id: `sess_${UUID1.replace('11111111', '20000003')}`, directory: 'E:\\agent开发\\FilesAdmin', title: '别的项目会话', tc: NOW - 3 * MIN, tu: NOW - 3 * MIN, messages: [] },
      { id: `sess_${UUID1.replace('11111111', '20000004')}`, directory: '', title: '未知项目会话', tc: NOW - 4 * MIN, tu: NOW - 4 * MIN, messages: [] },
    ]
  );
  const cfg = buildCfg({ agentActivity: { sources: { zcode: { root: zroot3 } } } });

  // 无 project 参数 → 全量 4 条（旧行为不回归）
  const all = listAgentSessions(cfg, { agent: 'zcode', now: NOW });
  assert.equal(all.items.length, 4);

  // 指定项目 → 只出该项目（正斜杠/大小写/尾分隔符归一化同组）
  const scoped = listAgentSessions(cfg, { agent: 'zcode', project: 'e:/agent开发/FdeHarness/', now: NOW });
  assert.deepEqual(scoped.items.map((i) => i.title), ['FdeHarness 会话A', 'FdeHarness 会话B']);
  assert.ok(scoped.items.every((i) => i.projectId === 'E:\\agent开发\\FdeHarness'), '不得混入其他项目');

  // project= 空串 → 只出未知项目组
  const unknown = listAgentSessions(cfg, { agent: 'zcode', project: '', now: NOW });
  assert.deepEqual(unknown.items.map((i) => i.title), ['未知项目会话']);

  // 过滤态游标翻页：limit=1 逐页拉，不重不漏、不串组
  const p1 = listAgentSessions(cfg, { agent: 'zcode', project: 'E:\\agent开发\\FdeHarness', limit: 1, now: NOW });
  assert.deepEqual(p1.items.map((i) => i.title), ['FdeHarness 会话A']);
  const p2 = listAgentSessions(cfg, { agent: 'zcode', project: 'E:\\agent开发\\FdeHarness', limit: 1, cursor: p1.nextCursor, now: NOW });
  assert.deepEqual(p2.items.map((i) => i.title), ['FdeHarness 会话B']);
  assert.equal(p2.nextCursor, null, '过滤集翻尽');
});

test('列表：agent 缺失/非法 → 400 BAD_AGENT；坏游标 → 400 BAD_CURSOR；源禁用 → 空页', () => {
  assert.throws(() => listAgentSessions(buildCfg(), { agent: 'kilo', now: NOW }), (e) => e.status === 400 && e.code === 'BAD_AGENT');
  assert.throws(() => listAgentSessions(buildCfg(), { agent: '', now: NOW }), (e) => e.status === 400 && e.code === 'BAD_AGENT');
  assert.throws(() => listAgentSessions(buildCfg(), { agent: 'zcode', cursor: '%%bad%%', now: NOW }), (e) => e.status === 400 && e.code === 'BAD_CURSOR');
  const off = buildCfg({ agentActivity: { sources: { zcode: { enabled: false } } } });
  const r = listAgentSessions(off, { agent: 'zcode', now: NOW });
  assert.deepEqual(r.items, []);
  assert.equal(r.nextCursor, null);
});

test('列表：单源故障隔离（zcode db 损坏路径 → 空页不抛）', () => {
  const cfg = buildCfg({ agentActivity: { sources: { zcode: { root: path.join(tmpRoot, 'no-zcode-here') } } } });
  const r = listAgentSessions(cfg, { agent: 'zcode', now: NOW });
  assert.deepEqual(r.items, []);
});

// ---------- 端点层（appAssembler 装配真相） ----------

let app;
let cfgPath;

test.before(() => {
  cfgPath = path.join(tmpRoot, 'config.json');
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      port: 7842,
      host: '127.0.0.1',
      dataDir: path.join(tmpRoot, 'data'),
      webDir: path.join(tmpRoot, 'web'),
      gitea: { pollIntervalSec: 0 },
      agentActivity: Object.assign(
        { enabled: true, perSourceLimit: 10, maxItems: 40, previewChars: 200, sessionList: { limit: 20, maxLimit: 50 }, transcript: { maxMessages: 3, maxCharsPerMessage: 20000 } },
        { sources: sourcesOverrides() }
      ),
    })
  );
  app = buildApp({ poller: 'manual', warmProbe: false, configPath: cfgPath });
});

test.after(() => {
  if (app) app.close();
});

async function api(method, p, body) {
  return app.fetch(method, p, {
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('端点：GET /api/agent-sessions 200 → ref 回查 GET /api/agent-session 200 且 seq 升序（§8 冒烟口径）', async () => {
  const list = await api('GET', '/api/agent-sessions?agent=zcode');
  assert.equal(list.status, 200);
  assert.equal(list.body.agent, 'zcode');
  assert.ok(list.body.items.length >= 1);
  const first = list.body.items[0];
  const tr = await api('GET', `/api/agent-session?ref=${encodeURIComponent(first.ref)}`);
  assert.equal(tr.status, 200);
  assert.equal(tr.body.degraded, false);
  const seqs = tr.body.messages.map((m) => m.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'seq 连续升序');
});

test('端点：BAD_AGENT 400；坏 ref 400 BAD_REF；ref 未知 id 404；坏游标 400', async () => {
  const badAgent = await api('GET', '/api/agent-sessions?agent=nonsense');
  assert.equal(badAgent.status, 400);
  assert.equal(badAgent.body.error.code, 'BAD_AGENT');

  const badRef = await api('GET', '/api/agent-session?ref=%%');
  assert.equal(badRef.status, 400);
  assert.equal(badRef.body.error.code, 'BAD_REF');

  const missing = await api('GET', `/api/agent-session?ref=${encodeURIComponent(sessionRef.encodeRef({ s: 'zcode', k: 'session', v: { id: 'sess_77777777-aaaa-bbbb-cccc-000000000000' } }))}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'SESSION_NOT_FOUND');

  const badCursor = await api('GET', '/api/agent-sessions?agent=zcode&cursor=zzzz');
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.body.error.code, 'BAD_CURSOR');
});

test('端点：transcript maxMessages 截断（truncated+total=实际总数）与 maxCharsPerMessage 尾部截断', async () => {
  const ref = sessionRef.encodeRef({ s: 'zcode', k: 'session', v: { id: `sess_${UUID1}` } });
  const tr = await api('GET', `/api/agent-session?ref=${encodeURIComponent(ref)}`);
  assert.equal(tr.body.total, 4, 'total=实际消息总数');
  assert.equal(tr.body.truncated, true, 'maxMessages=3 → 截断标记');
  assert.equal(tr.body.messages.length, 3);
  assert.equal(tr.body.messages[tr.body.messages.length - 1].tool.status, 'ok', '保留前 N 条');
  // 长文本截断：独立 config 注入 maxCharsPerMessage=20
  const tinyCfg = { agentActivity: { transcript: { maxMessages: 1000, maxCharsPerMessage: 20 }, sources: sourcesOverrides() } };
  const r2 = getAgentTranscript(tinyCfg, ref, { now: NOW });
  const long = r2.messages.find((m) => m.text.length > 20);
  assert.ok(long, '应存在被截断的长文本');
  assert.ok(long.text.endsWith('…[截断]'));
  assert.ok(long.text.length <= 20 + '…[截断]'.length);
});

test('端点：transcript 统一脱敏——key 形态与 registerSecret 原值均被 redact（§7-3）', async () => {
  const croot3 = mk(path.join(tmpRoot, 'claude-redact', 'projects'));
  const leak = '请用这个凭据调用：Authorization: Bearer sk-live-1234567890，以及 my-super-secret-token-9876 结束';
  write(
    path.join(croot3, 'proj-redact', '44444444-9999-8888-7777-666666666666.jsonl'),
    JSON.stringify({ type: 'user', timestamp: '2026-10-20T11:00:00.000Z', message: { role: 'user', content: leak } }) + '\n'
  );
  redact.registerSecret('my-super-secret-token-9876');
  try {
    const cfg = { agentActivity: { sources: { claude: { root: croot3 } } } };
    const ref = sessionRef.encodeRef({ s: 'claude', k: 'project', v: { dir: 'proj-redact', file: '44444444-9999-8888-7777-666666666666.jsonl' } });
    const r = getAgentTranscript(cfg, ref, { now: NOW });
    assert.equal(r.messages[0].text.includes('sk-live-1234567890'), false, 'key 形态值被脱敏');
    assert.equal(r.messages[0].text.includes('my-super-secret-token-9876'), false, '注册凭据原值被脱敏');
    assert.ok(r.messages[0].text.includes('[REDACTED]'));
    // 列表标题同样过 redact
    const t = listAgentSessions(cfg, { agent: 'claude', now: NOW });
    assert.equal(t.items[0].title.includes('sk-live-1234567890'), false);
  } finally {
    redact.clearSecrets();
  }
});

test('活动流条目可选 ref（D5）：四源 ref 齐备且可解码回对应源；形状保证合法（非死引用）', () => {
  const r = aggregateAgentActivity(buildCfg(), { now: NOW });
  const byAgent = {};
  for (const it of r.items) byAgent[it.agent] = it;
  for (const agent of ['zcode', 'claude', 'dsh', 'workbuddy']) {
    assert.ok(byAgent[agent], `${agent} 条目在活动流`);
    assert.ok(typeof byAgent[agent].ref === 'string' && byAgent[agent].ref.length > 0, `${agent} 条目带 ref`);
    const loc = sessionRef.decodeRef(byAgent[agent].ref);
    assert.equal(loc.s, agent);
    // ref 必须能通过双闸（不死引用）
    assert.doesNotThrow(() => sessionRef.validateRef(byAgent[agent].ref, buildCfg()));
  }
});

test('normalizeAgentActivity：sessionList/transcript 缺省回填 + 非法值兜底（F1）', () => {
  const n = normalizeAgentActivity({ sessionList: { limit: 3 }, transcript: { maxMessages: -5 } });
  assert.equal(n.sessionList.limit, 3);
  assert.equal(n.sessionList.maxLimit, DEFAULT_AGENT_ACTIVITY.sessionList.maxLimit);
  assert.equal(n.transcript.maxMessages, DEFAULT_AGENT_ACTIVITY.transcript.maxMessages, '非法值回默认');
  assert.equal(normalizeAgentActivity(null).transcript.maxCharsPerMessage, 20000);
  assert.notEqual(n, DEFAULT_AGENT_ACTIVITY, '不污染默认常量');
});

test('settings：agentActivity.sessionList/transcript PATCH 校验（非法 400、合法生效）', async () => {
  const p1 = await api('PATCH', '/api/settings', { agentActivity: { transcript: { maxMessages: 500 } } });
  assert.equal(p1.status, 200);
  const s = await api('GET', '/api/settings');
  assert.equal(s.body.agentActivity.transcript.maxMessages, 500);
  assert.equal(s.body.agentActivity.sessionList.limit, 20, '未涉及键保持默认');

  const p2 = await api('PATCH', '/api/settings', { agentActivity: { sessionList: { maxLimit: 0 } } });
  assert.equal(p2.status, 400);
  const p3 = await api('PATCH', '/api/settings', { agentActivity: { transcript: 'nope' } });
  assert.equal(p3.status, 400);
});

// ---------- v2.9.21 派工词（zcode 源；claude/codex 见 dispatch-prompt.test.js——新测试文件规避 node:sqlite 钩子） ----------

test('派工词：zcode db 首条真人指令（注入 part 跳过）+ 列表按项目过滤', () => {
  const zdpRoot = mk(path.join(tmpRoot, 'zcode-dp', 'cli'));
  createZcodeDb(path.join(zdpRoot, 'db', 'db.sqlite'), [
    {
      id: 'session_dd000001',
      directory: 'C:\\proj\\dp',
      title: '派工词夹具',
      tc: NOW - 30 * MIN,
      tu: NOW - 5 * MIN,
      messages: [
        { tc: NOW - 30 * MIN, role: 'user', parts: [{ type: 'text', text: '<system-reminder>注入上下文</system-reminder>' }] },
        { tc: NOW - 30 * MIN, role: 'user', parts: [{ type: 'text', text: '把拓扑限高改成 480px' }] },
        { tc: NOW - 25 * MIN, role: 'assistant', parts: [{ type: 'text', text: '好的' }] },
      ],
    },
  ]);
  const cfg = { agentActivity: { sources: { zcode: { root: zdpRoot } } } };
  const ref = sessionRef.encodeRef({ s: 'zcode', k: 'session', v: { id: 'session_dd000001' } });
  const d = getDispatchPrompt(cfg, ref, { now: NOW });
  assert.equal(d.found, true);
  assert.equal(d.agent, 'zcode');
  assert.equal(d.text, '把拓扑限高改成 480px', '纯注入 user part 跳过，取首条真人指令');

  const l = listDispatchPrompts(cfg, { project: 'C:\\proj\\dp', now: NOW, noCache: true });
  assert.equal(l.items.length, 1);
  assert.equal(l.items[0].text, '把拓扑限高改成 480px');
  assert.equal(l.items[0].agent, 'zcode');
  assert.ok(l.items[0].ref, 'ref 回传可溯源');
});
