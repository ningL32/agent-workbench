'use strict';

/**
 * mcp-core.test.js — v2.9.27 MCP 协议核心（lib/mcpCore.handle 纯函数直测）
 *
 * 覆盖：
 *  - initialize 握手（serverInfo/protocolVersion）
 *  - tools/list 三工具齐备
 *  - tools/call fde_list_tasks：合成 config 读夹具任务；status 过滤
 *  - tools/call fde_search_work：空查询 → isError 结果（处理器不抛）
 *  - 未知方法 -32601；未知工具 -32602；通知不回包
 * 纪律：configLoader 注入合成配置（绝不触真实 ~/.dsh）；零出网零 spawn。
 * 运行：node --test test/mcp-core.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handle, TOOLS } = require('../lib/mcpCore');

const NOW = Date.now();

let tmpRoot;
let configLoader;

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-mcpcore-'));
  const dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'tasks.json'),
    JSON.stringify({
      columns: [
        { id: 'todo', name: '待分配' },
        { id: 'doing', name: '进行中' },
      ],
      tasks: [
        { id: 't-mcp-1', title: 'MCP 夹具任务一', status: 'todo', priority: 'high', updatedAt: new Date(NOW).toISOString(), artifacts: [] },
        { id: 't-mcp-2', title: 'MCP 夹具任务二', status: 'doing', updatedAt: new Date(NOW).toISOString(), artifacts: [] },
      ],
    })
  );
  // 六源全部指向临时空目录（绝不触真实 ~/.zcode 等路径——合成夹具纪律）
  const emptyRoots = {};
  for (const s of ['zcode', 'claude', 'dsh', 'codex']) {
    const dir = path.join(tmpRoot, 'src-' + s);
    fs.mkdirSync(dir, { recursive: true });
    emptyRoots[s] = { root: dir };
  }
  for (const s of ['workbuddy', 'opencode']) {
    emptyRoots[s] = { dbPath: path.join(tmpRoot, 'src-' + s + '.db') }; // 不存在的 db → openReadOnlyDb null → 空列表
  }
  configLoader = () => ({
    dataDir,
    gitea: { pollIntervalSec: 0 },
    agentActivity: { enabled: true, sources: emptyRoots },
  });
});

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) { /* EPERM 容忍 */ }
});

test('initialize 握手：serverInfo fde-console + tools 能力', () => {
  const r = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, configLoader);
  assert.equal(r.result.serverInfo.name, 'fde-console');
  assert.ok(r.result.capabilities.tools);
  assert.ok(r.result.protocolVersion);
});

test('tools/list：三工具齐备（name/description/inputSchema）', () => {
  const r = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, configLoader);
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['fde_agent_status', 'fde_list_tasks', 'fde_search_work']);
  for (const t of r.result.tools) {
    assert.ok(t.description && t.inputSchema);
  }
});

test('tools/call fde_list_tasks：夹具任务出全量；status=doing 过滤生效', () => {
  const all = handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fde_list_tasks', arguments: {} } }, configLoader);
  const tasks = JSON.parse(all.result.content[0].text);
  assert.equal(tasks.length, 2);
  assert.ok(tasks.some((t) => t.id === 't-mcp-1' && t.title === 'MCP 夹具任务一'));
  const doing = handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fde_list_tasks', arguments: { status: 'doing' } } }, configLoader);
  const only = JSON.parse(doing.result.content[0].text);
  assert.equal(only.length, 1);
  assert.equal(only[0].id, 't-mcp-2');
});

test('tools/call fde_search_work：空查询 → isError 结果（处理器不抛、进程不炸）', () => {
  const r = handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fde_search_work', arguments: { q: '   ' } } }, configLoader);
  assert.equal(r.result.isError, true);
  assert.ok(r.result.content[0].text.includes('失败'));
});

test('fde_agent_status：sources 空配置零出网返回健康占位', () => {
  const r = handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fde_agent_status', arguments: {} } }, configLoader);
  const parsed = JSON.parse(r.result.content[0].text);
  assert.ok(parsed.health);
  assert.ok(parsed.heatmap);
});

test('未知方法 -32601 / 未知工具 -32602 / 通知不回包', () => {
  const r1 = handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, configLoader);
  assert.equal(r1.error.code, -32601);
  const r2 = handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } }, configLoader);
  assert.equal(r2.error.code, -32602);
  const r3 = handle({ method: 'notifications/initialized' }, configLoader);
  assert.equal(r3, null);
});
