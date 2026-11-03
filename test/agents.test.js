'use strict';

/**
 * agents.test.js — 智能体只读注册表 + 会话登记表退役（启动/注册表 CRUD/登记表均已退役）
 * 覆盖：内置 9 项引导、视图字段键、退役端点 404（POST/PATCH/DELETE /api/agents、
 *       POST /api/agents/:id/launch）、v2.3 会话登记表退役（GET /api/sessions 与
 *       POST /api/sessions/:id/stop 一律 404 NOT_FOUND，规格 §6）。
 * 运行：node --test test/agents.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7792; // 仅作 fixture 配置留痕（进程内装配不再监听端口）

const { buildApp } = require('./helpers/appAssembler');

let app;
let tmpDir;

// WP3：真端口 spawn → 装配器进程内分发（同一 app.handle 管线，断言零改动）
async function api(method, p, body) {
  return app.fetch(method, p, {
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-agents-'));
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({
      port: PORT,
      host: '127.0.0.1',
      dataDir: path.join(tmpDir, 'data'),
      webDir: path.join(tmpDir, 'web'),
      gitea: { pollIntervalSec: 0 },
    })
  );
  app = buildApp({ configPath: path.join(tmpDir, 'config.json') });
});

test.after(() => {
  if (app) app.close();
});

test('GET /api/agents 首次运行引导内置 9 项', async () => {
  const r = await api('GET', '/api/agents');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 9);
  const ids = r.body.map((a) => a.id);
  for (const id of ['opencode', 'crush', 'kilo', 'mcode', 'goose', 'codex', 'claude', 'dsh', 'demo-team']) {
    assert.ok(ids.includes(id), `缺少内置智能体 ${id}`);
  }
  assert.ok(r.body.every((a) => a.builtin === true && a.enabled === true));
  const claude = r.body.find((a) => a.id === 'claude');
  assert.strictEqual(claude.command, 'claude');
  assert.strictEqual(claude.commandTemplate, 'claude "{briefing}"');
});

test('GET /api/agents 视图字段：内置项含 id/name/command/commandTemplate/builtin/enabled 键', async () => {
  const r = await api('GET', '/api/agents');
  assert.strictEqual(r.status, 200);
  const agent = r.body.find((a) => a.id === 'claude');
  assert.ok(agent, 'claude 应在注册表中');
  for (const k of ['id', 'name', 'command', 'commandTemplate', 'builtin', 'enabled']) {
    assert.ok(Object.prototype.hasOwnProperty.call(agent, k), `视图应含字段 ${k}`);
  }
});

test('启动与注册表 CRUD 已退役：POST/PATCH/DELETE /api/agents 与 launch 均 404 NOT_FOUND', async () => {
  const post = await api('POST', '/api/agents', { id: 'sleeper', name: 'Sleeper', command: 'ping' });
  assert.strictEqual(post.status, 404);
  assert.strictEqual(post.body.error.code, 'NOT_FOUND');

  const patch = await api('PATCH', '/api/agents/claude', { enabled: false });
  assert.strictEqual(patch.status, 404);
  assert.strictEqual(patch.body.error.code, 'NOT_FOUND');

  const del = await api('DELETE', '/api/agents/claude');
  assert.strictEqual(del.status, 404);
  assert.strictEqual(del.body.error.code, 'NOT_FOUND');

  const launch = await api('POST', '/api/agents/claude/launch', { workdir: tmpDir, briefing: 'x' });
  assert.strictEqual(launch.status, 404);
  assert.strictEqual(launch.body.error.code, 'NOT_FOUND');
});

// ---------- v2.3 会话登记表退役（规格 §6）：两端点路由未挂载，统一 404 ----------

test('会话登记表退役：GET /api/sessions 与 POST /api/sessions/:id/stop 一律 404 NOT_FOUND', async () => {
  const list = await api('GET', '/api/sessions');
  assert.strictEqual(list.status, 404);
  assert.strictEqual(list.body.error.code, 'NOT_FOUND');

  const stop = await api('POST', '/api/sessions/s-anything/stop');
  assert.strictEqual(stop.status, 404);
  assert.strictEqual(stop.body.error.code, 'NOT_FOUND');
});
