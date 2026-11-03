'use strict';

/**
 * radar-text.test.js — v2.9.28 转写入口泛化：POST /api/radar/text
 *
 * 覆盖：
 *  - 201：合成消息入纪要池（source:'text'、speakerSegments 单段全文、analyzedAt null=可分析）
 *  - 校验：title 1..200 / text ≥10 字 / 超长 400 FIELD_INVALID
 *  - 资格闭环：入池消息可被既有 POST /api/radar/analyze 接受（accepted=1，202 job——
 *    DSH_FIXTURE 离线引擎路径，候选即时可断言）
 * 纪律：全合成夹具零出网（DSH_FIXTURE=analyze 引擎离线桩，既有机制）。
 * 运行：node --test test/radar-text.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpRoot;

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function buildAppWith(cfgExtra) {
  const cfgPath = path.join(tmpRoot, `cfg-${Math.random().toString(36).slice(2, 7)}.json`);
  writeJSON(cfgPath, Object.assign({
    port: 7851,
    host: '127.0.0.1',
    dataDir: path.join(tmpRoot, 'data'),
    webDir: path.join(tmpRoot, 'web'),
    gitea: { pollIntervalSec: 0 },
    agentActivity: { enabled: true, sources: {} },
    analyze: { timeoutSec: 300 },
  }, cfgExtra || {}));
  const { buildApp } = require('./helpers/appAssembler');
  return buildApp({ poller: 'manual', warmProbe: false, configPath: cfgPath });
}

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-rt-'));
  process.env.DSH_FIXTURE = path.join(tmpRoot, 'fixture.txt');
  fs.writeFileSync(process.env.DSH_FIXTURE, JSON.stringify({
    tasks: [{ title: '文本投喂的任务候选', desc: '来自粘贴转写', priority: 'medium', confidence: 0.9, quote: '把导出改成流式', rationale: '明确动作' }],
    taskUpdates: [],
    noise: [],
  }));
});

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) { /* EPERM 容忍 */ }
  delete process.env.DSH_FIXTURE;
});

test('POST /api/radar/text：201 入池（source=text、单段全文、可分析态）', async () => {
  const app = buildAppWith();
  try {
    const r = await app.fetch('POST', '/api/radar/text', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '粘贴的会议记录', text: '今天讨论了把导出改成流式，并要求补齐测试边界。' }),
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.messageId.startsWith('msg-text-'));
    // 池内验证形状
    const pool = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'data', 'messages.json'), 'utf8'));
    const arr = Array.isArray(pool) ? pool : pool.messages;
    const m = arr.find((x) => x.id === r.body.messageId);
    assert.ok(m, '消息已持久化');
    assert.equal(m.source, 'text');
    assert.equal(m.analyzedAt, null);
    assert.equal(m.speakerSegments.length, 1);
    assert.ok(m.speakerSegments[0].text.includes('流式'));
  } finally {
    app.close();
  }
});

test('校验：title 空 / text 过短 / 超长 → 400 FIELD_INVALID', async () => {
  const app = buildAppWith();
  try {
    const post = (body) => app.fetch('POST', '/api/radar/text', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal((await post({ title: '', text: 'x'.repeat(50) })).status, 400);
    assert.equal((await post({ title: 't', text: '短' })).status, 400);
    assert.equal((await post({ title: 't', text: 'x'.repeat(200001) })).status, 400);
  } finally {
    app.close();
  }
});

test('闭环：入池消息经既有 analyze 端点被接受（DSH_FIXTURE 离线引擎，候选落收件箱）', async () => {
  const app = buildAppWith();
  try {
    const created = await app.fetch('POST', '/api/radar/text', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '可分析文本', text: '会上明确把导出改成流式，本周内完成。' }),
    });
    const { messageId } = created.body;
    const an = await app.fetch('POST', '/api/radar/analyze', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds: [messageId] }),
    });
    assert.equal(an.status, 202);
    assert.equal(an.body.accepted, 1, '合成消息被分析管线接受');
    const job = await app.fetch('GET', `/api/radar/analyze/${an.body.jobId}`, {});
    // fixture 模式引擎即时完成
    assert.equal(job.body.results[0].ok, true, '离线引擎分析成功');
    assert.ok(job.body.results[0].added >= 1, '产出候选');
  } finally {
    app.close();
  }
});
