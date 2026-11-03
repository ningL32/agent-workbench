'use strict';

/**
 * dispatch-prompt.test.js — v2.9.21 派工词：会话首条「真人指令」提取
 *
 * 覆盖：
 *  - dispatchTextOf 清洗：system-reminder/environment_context 块剔除；codex AGENTS.md 指令块、
 *    <user_instructions> 跳过，# Files mentioned 包裹取最后一个 ## 条目之后的真指令
 *  - getDispatchPrompt：claude（isSidechain/纯注入 user 跳过，取首条真人指令）与
 *    codex（AGENTS.md 包裹跳过、Files-mentioned 取尾）；全注入 → found:false；会话不存在 404
 *  - listDispatchPrompts：project 过滤（normalizeProjectKey 口径）、perSource 钳制、startedAt 倒序、
 *    未知源单源隔离跳过、空 project 零扫描、TTL 缓存命中与 noCache 绕过
 *  - 端点：GET /api/agent-dispatch?project=…（200 形状契约；project 缺省 → 200 空列表）
 * 纪律：全合成夹具 + 临时目录，绝不触碰六源真实位置；注入 now 固定时钟防日期炸弹；
 * 新测试文件不使用 node:sqlite（Mimosa 写入钩子，AGENTS.md 坑5）——zcode 派工词用例在
 * agent-sessions.test.js（复用其三表夹具）。after 清理容忍 Windows EPERM。
 * 运行：node --test test/dispatch-prompt.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sessionRef = require('../lib/sessionRef');
const {
  DISPATCH_SOURCES,
  dispatchTextOf,
  getDispatchPrompt,
  listDispatchPrompts,
} = require('../lib/agentTranscript');

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

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-dispatch-'));
});

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) { /* Windows 句柄延迟 EPERM 容忍 */ }
});

// ---------- dispatchTextOf 清洗 ----------

test('dispatchTextOf：注入标签块剔除，余文为空判纯注入', () => {
  assert.equal(dispatchTextOf('zcode', '先看下代码，核查下'), '先看下代码，核查下');
  assert.equal(dispatchTextOf('zcode', '<system-reminder>\n背景上下文\n</system-reminder>\n真实指令'), '真实指令');
  assert.equal(dispatchTextOf('zcode', '<system-reminder>x</system-reminder>'), '');
  assert.equal(dispatchTextOf('claude', '<environment_context>\n<current_date>2026-10-20</current_date>\n</environment_context>\n帮我看下'), '帮我看下');
  assert.equal(dispatchTextOf('claude', '<untrusted_gen_ui_state>{"a":1}</untrusted_gen_ui_state>改一下'), '改一下');
  assert.equal(dispatchTextOf('zcode', ''), '');
  assert.equal(dispatchTextOf('zcode', null), '');
});

test('dispatchTextOf：codex 专属包裹——AGENTS.md 指令块/user_instructions 跳过，Files-mentioned 取尾', () => {
  // 真机实测：codex 首条 user 是 23KB 的 AGENTS.md 指令包裹，真指令在后续 user 消息
  assert.equal(dispatchTextOf('codex', '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n大段注入\n</INSTRUCTIONS>'), '');
  assert.equal(dispatchTextOf('codex', '<user_instructions>\nfoo\n</user_instructions>'), '');
  assert.equal(
    dispatchTextOf('codex', '# Files mentioned by the user:\n\n## a.mcp.json: C:/x/a.json\n\n如何使用？\n'),
    '如何使用？'
  );
  assert.equal(dispatchTextOf('codex', '# Files mentioned by the user:\n\n## a.json: C:/x'), '');
  // 非 codex 源不做该规则（zcode 真指令可能真以 # 开头）
  assert.equal(dispatchTextOf('zcode', '# AGENTS.md instructions'), '# AGENTS.md instructions');
});

// ---------- claude ----------

function claudeFixtureDir() {
  const root = mk(path.join(tmpRoot, 'dp-claude', 'projects'));
  return root;
}

test('getDispatchPrompt·claude：sidechain 与纯注入 user 跳过，取首条真人指令（数组块形态）', () => {
  const root = claudeFixtureDir();
  const lines = [
    JSON.stringify({ type: 'user', isSidechain: true, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: '子代理消息不算派工词' } }),
    JSON.stringify({ type: 'attachment', attachment: { x: 1 } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-20T10:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>纯注入</system-reminder>' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-20T10:02:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '把看板列宽改成可拖拽' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T10:03:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } }),
  ].join('\n');
  write(path.join(root, 'proj-dp', 'aaaaaaaa-0000-1111-2222-333333333333.jsonl'), lines + '\n');
  const cfg = { agentActivity: { sources: { claude: { root } } } };
  const ref = sessionRef.encodeRef({ s: 'claude', k: 'project', v: { dir: 'proj-dp', file: 'aaaaaaaa-0000-1111-2222-333333333333.jsonl' } });
  const r = getDispatchPrompt(cfg, ref, { now: NOW });
  assert.equal(r.found, true);
  assert.equal(r.agent, 'claude');
  assert.equal(r.text, '把看板列宽改成可拖拽');
  assert.equal(r.ts, '2026-10-20T10:02:00.000Z');
  assert.ok(r.startedAt, 'startedAt 回传（birthtime iso）');
});

test('getDispatchPrompt：文件缺失 400 BAD_REF（realpath 闸，规格字面）；源禁用 404', () => {
  const root = claudeFixtureDir();
  const cfg = { agentActivity: { sources: { claude: { root } } } };
  const ref = sessionRef.encodeRef({ s: 'claude', k: 'project', v: { dir: 'proj-dp', file: '99999999-0000-1111-2222-333333333333.jsonl' } });
  assert.throws(() => getDispatchPrompt(cfg, ref, { now: NOW }), (e) => e.status === 400 && e.code === 'BAD_REF');
  const off = { agentActivity: { enabled: true, sources: { claude: { root, enabled: false } } } };
  assert.throws(() => getDispatchPrompt(off, ref, { now: NOW }), (e) => e.status === 404);
});

// ---------- codex ----------

test('getDispatchPrompt·codex：AGENTS.md 包裹跳过，Files-mentioned 取尾部真指令', () => {
  const root = mk(path.join(tmpRoot, 'dp-codex', 'sessions'));
  const lines = [
    // 真实 rollout 形态：timestamp 在 payload 内（session_meta 键序实测）
    JSON.stringify({ type: 'session_meta', payload: { cwd: 'C:\\proj\\dx', cli_version: '0.162.1', timestamp: '2026-10-20T09:00:00.000Z' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n大段注入\n</INSTRUCTIONS>' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Files mentioned by the user:\n\n## spec.md: C:/x/spec.md\n\n把导出改成流式' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '后续第二条' }] } }),
  ].join('\n');
  write(path.join(root, '2026', '10', '20', 'rollout-2026-10-20T09-00-00-aaaaaaaa-0000-1111-2222-333333333333.jsonl'), lines + '\n');
  const cfg = { agentActivity: { sources: { codex: { root } } } };
  const ref = sessionRef.encodeRef({ s: 'codex', k: 'file', v: { path: '2026/10/20/rollout-2026-10-20T09-00-00-aaaaaaaa-0000-1111-2222-333333333333.jsonl' } });
  const r = getDispatchPrompt(cfg, ref, { now: NOW });
  assert.equal(r.found, true);
  assert.equal(r.text, '把导出改成流式');
  assert.equal(r.startedAt, '2026-10-20T09:00:00.000Z', 'startedAt 取 session_meta.timestamp');
});

test('getDispatchPrompt·codex：全会话纯注入 → found:false 空文本', () => {
  const root = mk(path.join(tmpRoot, 'dp-codex-noise', 'sessions'));
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { cwd: 'C:\\proj\\dn', timestamp: '2026-10-20T09:30:00.000Z' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>x</INSTRUCTIONS>' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<current_date>2026-10-20</current_date>\n</environment_context>' }] } }),
  ].join('\n');
  write(path.join(root, '2026', '10', '20', 'rollout-2026-10-20T09-30-00-bbbbbbbb-0000-1111-2222-333333333333.jsonl'), lines + '\n');
  const cfg = { agentActivity: { sources: { codex: { root } } } };
  const ref = sessionRef.encodeRef({ s: 'codex', k: 'file', v: { path: '2026/10/20/rollout-2026-10-20T09-30-00-bbbbbbbb-0000-1111-2222-333333333333.jsonl' } });
  const r = getDispatchPrompt(cfg, ref, { now: NOW });
  assert.equal(r.found, false);
  assert.equal(r.text, '');
});

// ---------- listDispatchPrompts ----------

test('listDispatchPrompts：project 过滤、perSource 钳制、startedAt 倒序、未知源隔离、空 project 零扫描', () => {
  const croot = mk(path.join(tmpRoot, 'dp-list', 'projects'));
  // projA：两个会话（cwd 写进行内，readTail 抓取）
  write(
    path.join(croot, 'proj-a', 'cccccccc-0000-1111-2222-333333333331.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: '2026-10-20T08:00:00.000Z', message: { role: 'user', content: 'A 会话一指令' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, cwd: 'C:\\proj\\a' }),
    ].join('\n') + '\n',
    NOW - 30 * MIN
  );
  write(
    path.join(croot, 'proj-a', 'cccccccc-0000-1111-2222-333333333332.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: '2026-10-20T09:00:00.000Z', message: { role: 'user', content: 'A 会话二指令' } }),
    ].join('\n') + '\n',
    NOW - 10 * MIN
  );
  // projB：一个会话（cwd 写进行内，readTail 抓取——目录名解码回退对不上查询串）
  write(
    path.join(croot, 'proj-b', 'cccccccc-0000-1111-2222-333333333333.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: '2026-10-20T07:00:00.000Z', message: { role: 'user', content: 'B 会话指令' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, cwd: 'C:\\proj\\b' }),
    ].join('\n') + '\n',
    NOW - 60 * MIN
  );
  const xroot = mk(path.join(tmpRoot, 'dp-list', 'codex'));
  write(
    path.join(xroot, '2026', '10', '19', 'rollout-2026-10-19T20-00-00-dddddddd-0000-1111-2222-333333333333.jsonl'),
    [
      JSON.stringify({ type: 'session_meta', payload: { cwd: 'C:\\proj\\a', timestamp: '2026-10-19T20:00:00.000Z' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>x</INSTRUCTIONS>' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex 派工词' }] } }),
    ].join('\n') + '\n',
    NOW - 20 * MIN
  );
  const cfg = { agentActivity: { sources: { claude: { root: croot }, codex: { root: xroot } } } };

  const rA = listDispatchPrompts(cfg, { project: 'C:\\proj\\a', now: NOW, noCache: true });
  assert.equal(rA.project, 'C:\\proj\\a');
  const agents = rA.items.map((i) => i.agent);
  assert.ok(agents.includes('claude') && agents.includes('codex'), '两源均有命中');
  assert.ok(rA.items.every((i) => i.agent === 'codex' || i.text.includes('A 会话')), 'claude 只出 projA 会话');
  assert.equal(rA.items.find((i) => i.agent === 'codex').text, 'codex 派工词', 'codex 包裹清洗后取真指令');
  for (let i = 1; i < rA.items.length; i++) {
    assert.ok(String(rA.items[i - 1].startedAt) >= String(rA.items[i].startedAt), 'startedAt 倒序');
  }

  const rB = listDispatchPrompts(cfg, { project: 'C:\\proj\\b', now: NOW, noCache: true });
  assert.equal(rB.items.length, 1);
  assert.equal(rB.items[0].text, 'B 会话指令');

  const rOne = listDispatchPrompts(cfg, { project: 'C:\\proj\\a', perSource: 1, now: NOW, noCache: true });
  assert.equal(rOne.items.length, 2, 'perSource=1 → 每源最多 1 条');

  const rEmpty = listDispatchPrompts(cfg, { project: '', now: NOW });
  assert.deepEqual(rEmpty.items, [], '空 project 零扫描');

  const rUnknown = listDispatchPrompts(cfg, { project: 'C:\\proj\\a', agents: ['nonsense', 'claude'], now: NOW, noCache: true });
  assert.ok(rUnknown.items.length >= 1 && rUnknown.items.every((i) => i.agent === 'claude'), '未知源跳过不抛（单源隔离）');

  assert.deepEqual(DISPATCH_SOURCES, ['zcode', 'claude', 'codex'], '首批三源清单');
});

test('listDispatchPrompts：TTL 缓存命中与 noCache 绕过', () => {
  const xroot = mk(path.join(tmpRoot, 'dp-cache', 'codex'));
  const rel = ['2026', '10', '18', 'rollout-2026-10-18T10-00-00-eeeeeeee-0000-1111-2222-333333333333.jsonl'];
  const file = path.join(xroot, ...rel);
  const mkLines = (text) =>
    [
      JSON.stringify({ type: 'session_meta', payload: { cwd: 'C:\\proj\\cache', timestamp: '2026-10-18T10:00:00.000Z' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }),
    ].join('\n') + '\n';
  write(file, mkLines('第一版指令'), NOW - 40 * MIN);
  const cfg = { agentActivity: { sources: { codex: { root: xroot } } } };

  const first = listDispatchPrompts(cfg, { project: 'C:\\proj\\cache', now: NOW, perSource: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].text, '第一版指令');

  // TTL 内：改文件后仍回缓存旧值
  write(file, mkLines('第二版指令'), NOW - 5 * MIN);
  const cached = listDispatchPrompts(cfg, { project: 'C:\\proj\\cache', now: NOW + 60 * 1000, perSource: 1 });
  assert.equal(cached.items[0].text, '第一版指令', 'TTL 内命中缓存');

  // noCache 绕过 + TTL 过期后失效
  const fresh = listDispatchPrompts(cfg, { project: 'C:\\proj\\cache', now: NOW + 60 * 1000, perSource: 1, noCache: true });
  assert.equal(fresh.items[0].text, '第二版指令');
  const expired = listDispatchPrompts(cfg, { project: 'C:\\proj\\cache', now: NOW + 121 * 1000, perSource: 1 });
  assert.equal(expired.items[0].text, '第二版指令', 'TTL 过后缓存失效');
});

// ---------- 端点层（appAssembler 装配真相） ----------

test('端点：GET /api/agent-dispatch 200 形状契约；project 缺省 → 200 空列表', async () => {
  const croot = mk(path.join(tmpRoot, 'dp-endpoint', 'projects'));
  write(
    path.join(croot, 'proj-e', 'eeeeeeee-0000-1111-2222-333333333331.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: '2026-10-20T11:00:00.000Z', message: { role: 'user', content: '端点夹具指令' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, cwd: 'C:\\proj\\e' }),
    ].join('\n') + '\n',
    NOW - 5 * MIN
  );
  const cfgPath = path.join(tmpRoot, 'dp-endpoint', 'config.json');
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      port: 7843,
      host: '127.0.0.1',
      dataDir: path.join(tmpRoot, 'dp-endpoint', 'data'),
      webDir: path.join(tmpRoot, 'dp-endpoint', 'web'),
      gitea: { pollIntervalSec: 0 },
      agentActivity: {
        enabled: true,
        perSourceLimit: 10,
        maxItems: 40,
        previewChars: 200,
        sources: { claude: { root: croot } },
      },
    })
  );
  const { buildApp } = require('./helpers/appAssembler');
  const app = buildApp({ poller: 'manual', warmProbe: false, configPath: cfgPath });
  try {
    const hit = await app.fetch('GET', `/api/agent-dispatch?project=${encodeURIComponent('C:\\proj\\e')}`, {});
    assert.equal(hit.status, 200);
    assert.equal(hit.body.project, 'C:\\proj\\e');
    assert.ok(Array.isArray(hit.body.items));
    assert.equal(hit.body.items.length, 1);
    assert.equal(hit.body.items[0].agent, 'claude');
    assert.equal(hit.body.items[0].text, '端点夹具指令');
    assert.ok(hit.body.items[0].ref, 'ref 回传可溯源');

    const none = await app.fetch('GET', '/api/agent-dispatch', {});
    assert.equal(none.status, 200);
    assert.deepEqual(none.body, { project: '', items: [] }, 'project 缺省 → 空列表不扫源');

    const nomatch = await app.fetch('GET', `/api/agent-dispatch?project=${encodeURIComponent('C:\\nope')}`, {});
    assert.equal(nomatch.status, 200);
    assert.deepEqual(nomatch.body.items, []);
  } finally {
    app.close();
  }
});
