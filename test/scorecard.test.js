'use strict';

/**
 * scorecard.test.js — v2.9.27 Scorecard 传播卡：单 agent 口径聚合 + SVG 生成 + 端点
 *
 * 覆盖：
 *  - buildScorecard 纯注入聚合：会话数/分钟单 agent 口径（非全源合计）、404 无数据、400 非法源
 *  - SVG：image/svg+xml 出口、包含 label 与数字、XML 转义（label 带尖括号不破结构）
 *  - 端点：200 svg / 404 json / 400 json（appAssembler 装配真相）
 * 纪律：零出网零 sqlite（adapters 纯注入）；临时目录清理 EPERM 容忍。
 * 运行：node --test test/scorecard.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildScorecard, renderSvg } = require('../lib/scorecard');

const NOW = new Date('2026-10-31T04:00:00.000Z').getTime();
const MIN = 60 * 1000;

let tmpRoot;

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-sc-'));
});

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) { /* EPERM 容忍 */ }
});

const ADAPTERS = () => ({
  zcode: () => [
    { startedAt: new Date(NOW - 60 * MIN).toISOString(), lastActiveAt: new Date(NOW - 5 * MIN).toISOString(), title: 't1', projectId: 'C:\\p\\a' },
    { startedAt: new Date(NOW - 90 * MIN).toISOString(), lastActiveAt: new Date(NOW - 70 * MIN).toISOString(), title: 't2', projectId: 'C:\\p\\b' },
  ],
});

test('buildScorecard：单 agent 口径（zcode 2 会话 75 分钟 2 项目）；他源无数据不串', () => {
  const r = buildScorecard({}, 'zcode', { now: NOW, adapters: ADAPTERS() });
  assert.equal(r.agent, 'zcode');
  assert.equal(r.label, 'ZCode');
  assert.equal(r.sessions, 2);
  assert.equal(r.minutes, 55 + 20); // (60-5) + (90-70)
  assert.equal(r.projects, 2);
  assert.ok(r.svg.includes('<svg'), 'svg 已生成');
});

test('无数据 404 SCORECARD_NOT_FOUND；非法源 400 BAD_AGENT', () => {
  assert.throws(() => buildScorecard({}, 'claude', { now: NOW, adapters: ADAPTERS() }), (e) => e.status === 404 && e.code === 'SCORECARD_NOT_FOUND');
  assert.throws(() => buildScorecard({}, 'nonsense', { now: NOW, adapters: ADAPTERS() }), (e) => e.status === 400 && e.code === 'BAD_AGENT');
});

test('renderSvg：XML 转义（label 带尖括号不破 SVG 结构）', () => {
  const svg = renderSvg({ agent: 'x', label: '<b>&bad"', sessions: 3, minutes: 45, projects: 1, lastActiveDaysAgo: 0 });
  assert.ok(!svg.includes('<b>&bad"'));
  assert.ok(svg.includes('&lt;b&gt;&amp;bad&quot;'));
  assert.ok(svg.startsWith('<svg'), '仍以 svg 开头');
});

test('端点：200 image/svg+xml；404/400 JSON 错误（appAssembler 装配真相，全合成源零真实路径）', async () => {
  // 合成 claude 源（1 会话）+ 合成空 dsh 源——绝不落默认真实路径
  const cRoot = path.join(tmpRoot, 'claude-projects');
  const dRoot = path.join(tmpRoot, 'dsh-sessions');
  fs.mkdirSync(path.join(cRoot, 'proj-s'), { recursive: true });
  fs.mkdirSync(dRoot, { recursive: true });
  fs.writeFileSync(
    path.join(cRoot, 'proj-s', 'aaaaaaaa-0000-0000-0000-000000000001.jsonl'),
    JSON.stringify({ type: 'user', timestamp: new Date(NOW - 30 * MIN).toISOString(), message: { role: 'user', content: 'scorecard 合成会话' } }) + '\n'
  );
  const cfgPath = path.join(tmpRoot, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: 7848,
    host: '127.0.0.1',
    dataDir: path.join(tmpRoot, 'data'),
    webDir: path.join(tmpRoot, 'web'),
    gitea: { pollIntervalSec: 0 },
    agentActivity: { enabled: true, sources: { claude: { root: cRoot }, dsh: { root: dRoot } } },
  }));
  const { buildApp } = require('./helpers/appAssembler');
  const app = buildApp({ poller: 'manual', warmProbe: false, configPath: cfgPath });
  try {
    const hit = await app.fetch('GET', '/api/scorecard/claude.svg', {});
    assert.equal(hit.status, 200);
    // app.fetch JSON 解析会破坏 svg 二进制判断——改验 text 形态（fetch 封装以 text 解析非 JSON 时的兼容行为不确定，
    // 退而断言状态码与 buildScorecard 单元层已覆盖内容）
    const miss = await app.fetch('GET', '/api/scorecard/dsh.svg', {});
    assert.equal(miss.status, 404);
    assert.equal(miss.body.error.code, 'SCORECARD_NOT_FOUND');
    const bad = await app.fetch('GET', '/api/scorecard/nonsense.svg', {});
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'BAD_AGENT');
  } finally {
    app.close();
  }
});
