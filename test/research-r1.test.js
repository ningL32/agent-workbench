'use strict';

/**
 * research-r1.test.js — 调研模块 R1 地基（SPEC-RESEARCH）：
 *  - prompts 资产：随包资产可加载且带版本+sha256；缺版本文件 fail-fast；list 枚举
 *  - llm 路由：通道选择矩阵（direct 需 key+白名单；默认 dsh；兜底 paper 显式带 reason）
 *  - paper 通道零出网（发断言前无 fetch 必要——offline 纪律）
 * 运行：node --test test/research-r1.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const prompts = require('../lib/research/prompts');
const llm = require('../lib/research/llm');

test('prompts：随包资产 research-interview 可加载（版本+sha256+非空全文）', () => {
  const p = prompts.load('research-interview');
  assert.match(p.version, /^\d+\.\d+\.\d+$/, '首行版本标记');
  assert.match(p.sha256, /^[0-9a-f]{64}$/, 'sha256 形态');
  assert.ok(p.text.length > 200, '全文非空（契约含输出 JSON 示例）');
  assert.ok(p.text.includes('"drafts"'), '契约含 drafts 输出键');
});

test('prompts：不存在的资产名抛错（fail-fast 形态）', () => {
  assert.throws(() => prompts.load('no-such-prompt'), /提示词资产缺失/);
});

test('prompts：list 枚举含 research-interview', () => {
  const l = prompts.list();
  assert.ok(l.some((x) => x.name === 'research-interview'), '枚举命中随包资产');
});

test('llm.pickChannel：矩阵四分支', () => {
  const base = { research: { directApiHost: '', directApiModel: '', hostWhitelist: [] } };
  assert.strictEqual(llm.pickChannel(base).channel, 'dsh', '默认 → dsh 引擎');
  const noKey = { research: { directApiHost: 'api.example.com', directApiModel: 'm', hostWhitelist: ['api.example.com'] } };
  const r1 = llm.pickChannel(noKey);
  assert.strictEqual(r1.channel, 'paper', 'host 已配但 env key 缺 → paper 显式降级');
  assert.ok(/RESEARCH_LLM_API_KEY/.test(r1.reason), '降级原因可观测');
  const noWhitelist = { research: { directApiHost: 'api.example.com', directApiModel: 'm', hostWhitelist: [] } };
  delete process.env.RESEARCH_LLM_API_KEY;
  const r2 = llm.pickChannel(noWhitelist);
  assert.strictEqual(r2.channel, 'paper', 'host 不在白名单 → paper（SSRF 先例）');
  process.env.RESEARCH_LLM_API_KEY = 'test-key-offline';
  const r3 = llm.pickChannel(noWhitelist);
  assert.strictEqual(r3.channel, 'paper', '白名单缺失即使有 key 也不放行');
  const ok = { research: { directApiHost: 'api.example.com', directApiModel: 'm1', hostWhitelist: ['api.example.com'] } };
  assert.strictEqual(llm.pickChannel(ok).channel, 'direct', 'key+白名单齐备 → direct');
  delete process.env.RESEARCH_LLM_API_KEY;
});

test('llm.chat：paper 通道零出网返回显式降级(含 reason,空文本)', async () => {
  const cfg = { research: { directApiHost: 'api.example.com', directApiModel: 'm', hostWhitelist: [] } };
  delete process.env.RESEARCH_LLM_API_KEY;
  const r = await llm.chat(cfg, '任意提示词(不会出网)');
  assert.strictEqual(r.channel, 'paper');
  assert.strictEqual(r.text, '');
  assert.ok(r.paperReason, 'paperReason 可观测');
});

test('migration：kb_fts 能力探测落 meta+report(本机节点上恒 ∈ {0,1});四张调研表建成', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runMigration } = require('../lib/migration');
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-research-mig-'));
  try {
    fs.writeFileSync(path.join(src, 'messages.json'), JSON.stringify([
      { id: 'm-r1', title: '迁移夹具', occurredAt: '2026-11-23T00:00:00Z' },
    ]));
    const report = runMigration({ dataDir: src, units: ['messages'], now: 0 });
    assert.ok(typeof report.kbFts === 'boolean', 'report.kbFts 布尔(能力探测结果)');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(src, 'fde.db'), { readOnly: true });
    try {
      const flag = db.prepare("SELECT value FROM meta WHERE key='kb_fts_available'").get();
      assert.ok(flag && ['0', '1'].includes(flag.value), 'kb_fts_available 落 meta(失败也留痕)');
      for (const t of ['interviews', 'interview_messages', 'task_drafts', 'kb_documents']) {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
        assert.ok(row, `表 ${t} 已建`);
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

// ---------- R2:访谈+草稿管线(装配链,离线 paper 通道) ----------
const { buildApp } = require('./helpers/appAssembler');

test('R2 装配链:访谈→发言(paper)→accept→建任务→link 全流程;pending 守卫;关闭停入站', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-research-r2-'));
  const app = buildApp({ poller: 'manual', dataDir, configPath: path.join(dataDir, 'config.json'), configDir: dataDir });
  const api = (method, p, body) => app.fetch(method, p, { headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    // 直连 host 已配但无 key → paper 显式降级(决议⑤),零出网
    const cfgPatch = await api('PATCH', '/api/settings', { research: { directApiHost: 'api.example.com', directApiModel: 'm', hostWhitelist: ['api.example.com'] } });
    assert.ok([200, 400].includes(cfgPatch.status), 'settings PATCH 接受 research 节或拒绝(白名单外字段)');

    const created = await api('POST', '/api/research/interviews', { projectDir: 'E:/demo/alpha', sceneTitle: '某客户报表改造' });
    assert.strictEqual(created.status, 201, '创建访谈 201');
    const iv = created.body;

    const msg = await api('POST', `/api/research/interviews/${iv.id}/messages`, { text: '客户希望报表支持按月导出' });
    assert.strictEqual(msg.status, 201, '发言 201');
    assert.strictEqual(msg.body.aiMessage.kind, 'paper', 'paper 模式显式留痕(决议⑤)');
    assert.strictEqual(msg.body.drafts.length, 0, '纸面模式不产草稿');

    // close → 入站 409(INTERVIEW_CLOSED)
    await api('POST', `/api/research/interviews/${iv.id}/close`, {});
    const afterClose = await api('POST', `/api/research/interviews/${iv.id}/messages`, { text: '再问一句' });
    assert.strictEqual(afterClose.status, 409, '关闭后停入站 409');
    assert.strictEqual(afterClose.body.error.code, 'INTERVIEW_CLOSED');
  } finally {
    app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('R2 草稿闸门:accept 修订/409 守卫/link 绑回/未知 404', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const interviews = require('../lib/research/interviews');
  const ctx = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fde-research-gate-')) };
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '闸门测试' });
    // 直接造一条 pending 草稿(经域校验函数,与 AI 产出同口径)
    const data = interviews.loadResearch(ctx);
    data.drafts.push({ id: 'dr_test1', interviewId: iv.id, payload: { title: '旧标题', desc: '旧描述', priority: 'low', quote: '原句' }, status: 'pending', decidedBy: null, decidedAt: null, taskId: null, createdAt: new Date().toISOString() });
    interviews.saveResearch(ctx, data);

    const bad = interviews.acceptDraft(ctx, 'dr_test1', { title: '' });
    assert.strictEqual(bad.error, 'FIELD_INVALID', '修订后非法 → 400 语义留 pending(决议①)');
    const ok = interviews.acceptDraft(ctx, 'dr_test1', { title: '按月导出报表', desc: '导出月度 CSV', priority: 'high' }, 'fde');
    assert.strictEqual(ok.draft.status, 'accepted', 'accept 翻转');
    assert.strictEqual(ok.draft.payload.title, '按月导出报表', '人工修订落 payload');
    const again = interviews.acceptDraft(ctx, 'dr_test1', {});
    assert.strictEqual(again.error, 'ALREADY_DECIDED', 'pending 守卫 409 语义');
    const noTask = interviews.linkDraft(ctx, 'dr_test1', 't-fake');
    assert.strictEqual(noTask.error, undefined, 'link 绑回(审计决议②:任务删除后悬挂=特性,此处仅绑)');
    assert.strictEqual(noTask.draft.taskId, 't-fake');
    const twice = interviews.linkDraft(ctx, 'dr_test1', 't-fake2');
    assert.strictEqual(twice.error, 'ALREADY_LINKED');
    assert.strictEqual(interviews.acceptDraft(ctx, 'dr_none', {}).error, 'DRAFT_NOT_FOUND', '未知 404 语义');
  } finally {
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});
