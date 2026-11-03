'use strict';

/**
 * agent-context.test.js — v2.9.27 Agent 上下文注入：白名单聚合 / markdown 渲染 / 安全写盘
 *
 * 覆盖：
 *  - 纯注入模式聚合（adapters 提供即不回落真实路径）：白名单内项目入、白名单外零依据
 *  - 出窗会话不计；单源异常隔离
 *  - renderMarkdown：标题/条目/空态；redact 出口
 *  - writeAgentContext：enabled!==true 零写盘；白名单目录原子写 .fde/daily.md；
 *    无活动目录跳过不写空文件；目录不存在自动 mkdir；写失败跳过不拖垮
 * 纪律：零出网零 sqlite；临时目录 after 清理 EPERM 容忍。
 * 运行：node --test test/agent-context.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAgentContext, renderMarkdown, writeAgentContext } = require('../lib/agentContext');

const NOW = new Date('2026-10-31T04:00:00.000Z').getTime();
const DAY = 24 * 3600 * 1000;
const MIN = 60 * 1000;

let tmpRoot;
let projA; // 白名单内
let projB; // 白名单外

function iso(ts) {
  return new Date(ts).toISOString();
}

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-actx-'));
  projA = path.join(tmpRoot, 'proj-a');
  projB = path.join(tmpRoot, 'proj-b');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });
});

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) { /* EPERM 容忍 */ }
});

const ADAPTERS = () => ({
  zcode: () => [
    { startedAt: iso(NOW - 60 * MIN), lastActiveAt: iso(NOW - 5 * MIN), title: '修搜索高亮 <script>alert(1)</script>', projectId: projA },
    { startedAt: iso(NOW - 5 * DAY), lastActiveAt: iso(NOW - 4 * DAY), title: '出窗旧会话', projectId: projA },
  ],
  claude: () => [
    { startedAt: iso(NOW - 30 * MIN), lastActiveAt: iso(NOW - 2 * MIN), title: 'B 项目不该出现', projectId: projB },
  ],
  dsh: () => { throw new Error('boom'); },
});

test('聚合：白名单内项目入、白名单外零依据、出窗出局、单源异常隔离', () => {
  const config = { agentContext: { enabled: true, dirs: [projA] } };
  const r = buildAgentContext(config, { now: NOW, days: 2, adapters: ADAPTERS() });
  assert.equal(r.projects.length, 1, '只出白名单项目');
  assert.equal(r.projects[0].dir, projA);
  const zcode = r.projects[0].agents.find((a) => a.agent === 'zcode');
  assert.ok(zcode);
  assert.equal(zcode.sessions.length, 1, '出窗旧会话不计');
  assert.ok(!JSON.stringify(r).includes('B 项目不该出现'), '白名单外项目内容零泄漏');
  assert.ok(!r.projects.some((p) => String(p.dir).includes('proj-b')));
});

test('renderMarkdown：标题/条目/redact 出口（script 标签被脱敏清洗链处理）', () => {
  const config = { agentContext: { enabled: true, dirs: [projA] } };
  const r = buildAgentContext(config, { now: NOW, days: 2, adapters: ADAPTERS() });
  const md = renderMarkdown(r);
  assert.ok(md.includes('# Agent 战况简报'));
  assert.ok(md.includes('## ' + projA));
  assert.ok(md.includes('ZCode（1 条）'));
  assert.ok(md.includes('修搜索高亮'));
  assert.ok(!md.includes('<script>alert(1)</script>'), '脚本片段不得原样出 markdown');
});

test('writeAgentContext：enabled 关闭零写盘', () => {
  const config = { agentContext: { enabled: false, dirs: [projA] } };
  const r = writeAgentContext(config, { now: NOW, adapters: ADAPTERS() });
  assert.deepEqual(r.written, []);
  assert.ok(fs.existsSync(projA) && !fs.existsSync(path.join(projA, '.fde')), '未创建 .fde');
});

test('writeAgentContext：白名单目录原子写 .fde/daily.md；无活动目录跳过不写空文件', () => {
  const projC = path.join(tmpRoot, 'proj-c'); // 白名单内但零会话
  fs.mkdirSync(projC, { recursive: true });
  const config = { agentContext: { enabled: true, dirs: [projA, projC] } };
  const r = writeAgentContext(config, { now: NOW, days: 2, adapters: ADAPTERS() });
  assert.equal(r.written.length, 1);
  const file = path.join(projA, '.fde', 'daily.md');
  assert.ok(fs.existsSync(file), 'daily.md 已落盘');
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('修搜索高亮'));
  // 原子写：无 .tmp 残留
  assert.ok(!fs.existsSync(file + '.tmp'));
  assert.ok(r.skipped.some((s) => s.dir === projC && s.reason.includes('无会话活动')), '白名单但无活动 → 跳过');
  assert.ok(!fs.existsSync(path.join(projC, '.fde')), '无活动目录不建 .fde');
});

test('writeAgentContext：dirs 里不存在的目录自动 mkdir 并写入', () => {
  const fresh = path.join(tmpRoot, 'proj-fresh');
  const config = { agentContext: { enabled: true, dirs: [fresh] } };
  const adapters = { zcode: () => [{ startedAt: iso(NOW - 5 * MIN), lastActiveAt: iso(NOW), title: '新目录会话', projectId: fresh }] };
  const r = writeAgentContext(config, { now: NOW, days: 1, adapters });
  assert.equal(r.written.length, 1);
  assert.ok(fs.existsSync(path.join(fresh, '.fde', 'daily.md')));
});
