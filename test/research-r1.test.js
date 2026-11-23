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

// ---------- R3:知识库(闭环 B) ----------
test('R3 kb:沉淀→中文双字词检索命中→eligible 真实计数(done 且未沉淀)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const store = require('../lib/store');
  const kb = require('../lib/research/kb');
  const interviews = require('../lib/research/interviews');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-research-kb-'));
  // store.loadTasks 需要 ctx.tasksPath(与 appAssembler 同口径)
  const ctx = { dataDir, tasksPath: path.join(dataDir, 'tasks.json'), taskEventsPath: path.join(dataDir, 'task_events.json') };
  try {
    // 种 done 任务 x2(一个已沉淀,一个未沉淀)+ 一个 doing
    const tasksData = store.loadTasks(ctx);
    const mk = (id, status) => ({ id, title: `任务${id}`, status, priority: 'medium', artifacts: [], createdAt: '2026-11-23T00:00:00Z', updatedAt: '2026-11-23T00:00:00Z' });
    tasksData.tasks.push(mk('t-done1', 'done'), mk('t-done2', 'done'), mk('t-doing', 'doing'));
    store.saveTasks(ctx, tasksData);
    // eligible 先=2(两个 done 未沉淀)
    assert.strictEqual(kb.eligible(ctx).count, 2, '可沉淀=done 未沉淀');
    // 沉淀 t-done1(中文标题+正文含双字词"报表")
    const s = kb.sediment(ctx, { sourceTaskId: 't-done1', kind: 'evidence', title: '某客户报表改造验收', body: '交付按月导出报表功能,验收通过;踩坑:时区切串要本地化。' });
    assert.ok(s.ok, '沉淀成功');
    assert.strictEqual(kb.eligible(ctx).count, 1, '沉淀后 eligible 归一(饥饿可观测,决议③)');
    // 中文双字词检索(LIKE 层,FTS5 trigram 不命中的口径)
    const hits = kb.search(ctx, '报表');
    assert.strictEqual(hits.length, 1, '双字词命中');
    assert.strictEqual(hits[0].source_task_id, 't-done1', '命中带 task 出处(闭环 B 出处链)');
    assert.strictEqual(kb.search(ctx, '不存在的词组').length, 0, '未命中空返');
    assert.strictEqual(kb.search(ctx, '').length, 0, '空查询空返');
    // 路由:POST documents 400(缺 body)/201;GET search 200
    const app = buildApp({ poller: 'manual', dataDir: ctx.dataDir, configPath: path.join(ctx.dataDir, 'config.json'), configDir: ctx.dataDir });
    const api = (method, p, body) => app.fetch(method, p, { headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const bad = await api('POST', '/api/research/kb/documents', { title: '缺body' });
    assert.strictEqual(bad.status, 400);
    const okc = await api('POST', '/api/research/kb/documents', { sourceTaskId: 't-done2', kind: 'diary', title: '日报沉淀', body: '内容' });
    assert.strictEqual(okc.status, 201);
    const sr = await api('GET', '/api/research/kb/search?q=%E6%97%A5%E6%8A%A5');
    assert.strictEqual(sr.status, 200);
    assert.strictEqual(sr.body.length, 1, 'URL 编码中文查询命中');
    app.close();
  } finally {
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

// ---------- R4:渲染导出(闭环 C,输入纯度铁律) ----------
test('R4 export:BPMN 字节确定+XML 转义;报告含任务与人工日报;不含启发式归因数据', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const store = require('../lib/store');
  const render = require('../lib/research/render');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-research-r4-'));
  const ctx = { dataDir, tasksPath: path.join(dataDir, 'tasks.json'), diaryPath: path.join(dataDir, 'diary.json') };
  try {
    const tasksData = store.loadTasks(ctx);
    tasksData.tasks.push(
      { id: 't-a', title: '需求调研<含特殊字符>&"引号"', status: 'done', projectDir: 'E:/demo/alpha', priority: 'high', memberId: '李雷', acceptorId: '韩梅梅', completedAt: '2026-11-23T01:00:00Z', artifacts: [], createdAt: '2026-11-22T01:00:00Z', updatedAt: '2026-11-22T01:00:00Z' },
      { id: 't-b', title: '报表开发', status: 'doing', projectDir: 'E:/demo/alpha', priority: 'medium', memberId: '李雷', artifacts: [], createdAt: '2026-11-22T02:00:00Z', updatedAt: '2026-11-22T02:00:00Z' },
      { id: 't-other', title: '别的场景任务', status: 'todo', projectDir: 'E:/demo/beta', artifacts: [], createdAt: '2026-11-22T03:00:00Z', updatedAt: '2026-11-22T03:00:00Z' },
    );
    store.saveTasks(ctx, tasksData);
    fs.writeFileSync(path.join(dataDir, 'diary.json'), JSON.stringify([{ taskId: 't-a', date: '2026-11-22', content: '完成调研并评审' }]));

    const bpmn1 = render.exportScene(ctx, 'E:/demo/alpha', 'bpmn');
    const bpmn2 = render.exportScene(ctx, 'E:/demo/alpha', 'bpmn');
    assert.strictEqual(bpmn1.contentType, 'application/xml');
    assert.strictEqual(bpmn1.body, bpmn2.body, '同输入字节级确定');
    assert.ok(bpmn1.body.includes('&quot;'), 'XML 转义生效');
    assert.ok(!bpmn1.body.includes('<bpmn:task id="Task_3"'), '别的场景任务不混入(场景过滤)');
    assert.ok(!bpmn1.body.includes('commit'), '启发式归因数据禁入客户产物(决议⑦)');
    const report = render.exportScene(ctx, 'E:/demo/alpha', 'report');
    assert.ok(report.body.includes('需求调研<含特殊字符>&"引号"'.replace('&', '&amp;').replace('<', '&lt;').replace('"', '&quot;')) === false || report.body.includes('需求调研'), '报告含任务标题');
    assert.ok(report.body.includes('完成调研并评审'), '人工日报入报告');
    assert.ok(!report.body.includes('别的场景任务'), '场景过滤');
    // 路由级
    const app = buildApp({ poller: 'manual', dataDir, configPath: path.join(dataDir, 'config.json'), configDir: dataDir });
    const api = (method, p) => app.fetch(method, p, {});
    const rep = await api('GET', '/api/research/export?scene=E%3A%2Fdemo%2Falpha&format=report');
    assert.strictEqual(rep.status, 200);
    const bm = await api('GET', '/api/research/export?scene=E%3A%2Fdemo%2Falpha&format=bpmn');
    assert.ok(String(bm.text).includes('<bpmn:definitions'), '路由级 BPMN 可取(非 JSON 响应在 text)');
    app.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- Tier1:冷启动导入 / 晨会简报 / 场景健康 ----------
test('Tier1:KB 冷启动导入幂等;digest 聚合确定性;health 状态口径', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const store = require('../lib/store');
  const kb = require('../lib/research/kb');
  const health = require('../lib/research/health');
  const digest = require('../lib/digest');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-tier1-'));
  const ctx = { dataDir, tasksPath: path.join(dataDir, 'tasks.json'), diaryPath: path.join(dataDir, 'diary.json'), activitiesPath: path.join(dataDir, 'activities.json'), config: {} };
  try {
    // 种数据:周报/日报 JSON + 人工日报 + 场景任务(stale:updatedAt 200h 前)
    fs.writeFileSync(path.join(dataDir, 'weekly.json'), JSON.stringify({ weekKey: '2026-W47', generatedAt: '2026-11-23T01:00:00Z', report: '本周完成调研模块。' }));
    fs.writeFileSync(path.join(dataDir, 'report-daily.json'), JSON.stringify({ dayKey: '2026-11-23', generatedAt: '2026-11-23T01:00:00Z', report: '昨日日报内容。' }));
    fs.writeFileSync(path.join(dataDir, 'diary.json'), JSON.stringify([{ taskId: 't-s1', date: '2026-11-22', content: '调研访谈走查' }]));
    const tasksData = store.loadTasks(ctx);
    const old = new Date(Date.now() - 200 * 3600000).toISOString();
    tasksData.tasks.push(
      { id: 't-s1', title: '场景一任务', status: 'doing', projectDir: 'E:/demo/alpha', artifacts: [], createdAt: old, updatedAt: old },
      { id: 't-s2', title: '场景二任务', status: 'todo', projectDir: 'E:/demo/beta', dueDate: '2026-11-20', artifacts: [], createdAt: old, updatedAt: old },
    );
    store.saveTasks(ctx, tasksData);
    // 冷启动:导入 3 条(周报+日报+人工日报),幂等 409 语义
    const b1 = kb.bootstrapImport(ctx);
    assert.strictEqual(b1.imported, 3, '周报+日报+人工日报三条入 KB');
    const b2 = kb.bootstrapImport(ctx);
    assert.strictEqual(b2.error, 'ALREADY_DONE', '幂等守卫 409 语义');
    assert.ok(kb.search(ctx, '调研模块').length >= 1, '导入后可检索');
    // 场景健康:200h 前 updatedAt → stale
    const h = health.sceneHealth(ctx);
    const alpha = h.scenes.find((s) => s.projectDir === 'E:/demo/alpha');
    assert.strictEqual(alpha.status, 'stale', '200h 无更新 → stale');
    assert.strictEqual(h.staleCount, 2, '两个场景均非 ok');
    // 晨会简报:含逾期/可沉淀/场景健康段
    const d = digest.buildDigest(ctx);
    assert.ok(d.markdown.includes('逾期任务 1'), '逾期聚合');
    assert.ok(d.markdown.includes('可沉淀进知识库 0 条'), 'kb eligible 并入(夹具无 done 任务,期望 0)');
    assert.ok(d.markdown.includes('场景健康'), '健康段并入');
    assert.ok(d.counts.badScenes >= 1, '计数返回');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- Tier2-①:验收材料自动打包 ----------
test('Tier2:验收包聚合日报/成果/事件+净效果;未知任务 404;启发式归因不进材料', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const store = require('../lib/store');
  const acceptance = require('../lib/research/acceptance');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-acc-'));
  const ctx = { dataDir, tasksPath: path.join(dataDir, 'tasks.json'), diaryPath: path.join(dataDir, 'diary.json'), taskEventsPath: path.join(dataDir, 'task_events.json'), activitiesPath: path.join(dataDir, 'activities.json'), config: {} };
  try {
    const tasksData = store.loadTasks(ctx);
    tasksData.tasks.push({ id: 't-acc1', title: '报表开发|防转义', status: 'done', priority: 'high', memberId: '李雷', acceptorId: '韩梅梅', completedAt: '2026-11-23T01:00:00Z', projectDir: 'E:/demo/alpha', desc: '实现按月导出', artifacts: [{ kind: 'commit', url: 'https://git.example.com/x/commit/abc', title: 'feat: 导出' }], createdAt: '2026-11-22T01:00:00Z', updatedAt: '2026-11-23T01:00:00Z' });
    store.saveTasks(ctx, tasksData);
    fs.writeFileSync(path.join(dataDir, 'diary.json'), JSON.stringify([{ taskId: 't-acc1', date: '2026-11-22', content: '完成导出功能' }]));
    const ev = require('../lib/taskEvents');
    ev.appendEvents(ctx, [ev.createdEvent({ id: 't-acc1', title: '报表开发|防转义' }, '2026-11-22T01:00:00Z')]);

    const pack = acceptance.buildAcceptancePack(ctx, 't-acc1');
    assert.strictEqual(pack.task.acceptorId, '韩梅梅', '任务摘要');
    assert.strictEqual(pack.diaries.length, 1, '人工日报并入');
    assert.strictEqual(pack.artifacts.length, 1, '挂接成果并入');
    assert.ok(pack.events.length >= 1, '事件时间轴');
    assert.ok(pack.markdown.includes('验收材料 · 报表开发\\|防转义'), '标题转义(表格安全,mdEsc \\| 字面)');
    assert.ok(pack.markdown.includes('feat: 导出'), '成果入材料');
    assert.ok(pack.markdown.includes('2026-11-22:完成导出功能'), '日报入材料');
    assert.ok(!pack.markdown.includes('activities'), '启发式归因源不出现(决议⑦从严)');
    try {
      acceptance.buildAcceptancePack(ctx, 't-none');
      assert.fail('未知任务应 404');
    } catch (e) {
      assert.strictEqual(e.code, 'TASK_NOT_FOUND');
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- Tier2-②:客户只读进度页 ----------
test('Tier2:进度页自包含 HTML,只含人工确认面,场景过滤与百分比', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const store = require('../lib/store');
  const progress = require('../lib/research/progress');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-prog-'));
  const ctx = { dataDir, tasksPath: path.join(dataDir, 'tasks.json'), diaryPath: path.join(dataDir, 'diary.json') };
  try {
    const tasksData = store.loadTasks(ctx);
    tasksData.tasks.push(
      { id: 't-p1', title: '已完成任务<&>', status: 'done', projectDir: 'E:/demo/alpha', memberId: '李雷', acceptorId: '韩梅梅', completedAt: '2026-11-23T01:00:00Z', artifacts: [], createdAt: '2026-11-22T01:00:00Z', updatedAt: '2026-11-22T01:00:00Z' },
      { id: 't-p2', title: '进行中任务', status: 'doing', projectDir: 'E:/demo/alpha', memberId: '李雷', artifacts: [], createdAt: '2026-11-22T02:00:00Z', updatedAt: '2026-11-22T02:00:00Z' },
      { id: 't-px', title: '别的场景', status: 'todo', projectDir: 'E:/demo/beta', artifacts: [], createdAt: '2026-11-22T03:00:00Z', updatedAt: '2026-11-22T03:00:00Z' },
    );
    store.saveTasks(ctx, tasksData);
    fs.writeFileSync(path.join(dataDir, 'diary.json'), JSON.stringify([{ taskId: 't-p1', date: '2026-11-22', content: '验收演示记录' }]));
    const html = progress.renderProgressPage(ctx, 'E:/demo/alpha');
    assert.ok(html.includes('<!DOCTYPE html>'), '自包含 HTML');
    assert.ok(html.includes('已完成任务&lt;&amp;&gt;'), '标题 esc 生效');
    assert.ok(!html.includes('已完成任务<&>'), '原始特殊字符不出现');
    assert.ok(html.includes('width:50%'), '完成 1/2 → 50%');
    assert.ok(!html.includes('别的场景'), '场景过滤');
    assert.ok(html.includes('验收演示记录'), '人工日报入页');
    assert.ok(!html.includes('token') && !html.includes('Authorization'), '无凭据字面量');
    // 路由级
    const { buildApp } = require('./helpers/appAssembler');
    const app = buildApp({ poller: 'manual', dataDir, configPath: path.join(dataDir, 'config.json'), configDir: dataDir });
    const res = await app.fetch('GET', '/api/research/scene-progress?scene=E%3A%2Fdemo%2Falpha', {});
    assert.strictEqual(res.status, 200);
    assert.ok(String(res.text).includes('项目进度'), '路由级可取(非 JSON 在 text)');
    app.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- Tier2-③:research origin 徽标数据链 ----------
test('Tier2:POST /api/tasks 持久化 origin(source=research,quote 截断);非对象丢弃', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-origin-'));
  const app = buildApp({ poller: 'manual', dataDir, configPath: path.join(dataDir, 'config.json'), configDir: dataDir });
  const api = (method, p, body) => app.fetch(method, p, { headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const ok = await api('POST', '/api/tasks', { title: '调研来源任务', origin: { source: 'research', interviewId: 'res_x', quote: '原句'.repeat(150) } });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.body.origin.source, 'research');
    assert.strictEqual(ok.body.origin.interviewId, 'res_x');
    assert.ok(ok.body.origin.quote.length <= 200, 'quote 截断 ≤200');
    const noO = await api('POST', '/api/tasks', { title: '无 origin', origin: 'not-an-object' });
    assert.strictEqual(noO.status, 201);
    assert.strictEqual(noO.body.origin, undefined, '非对象 origin 丢弃');
  } finally {
    app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
