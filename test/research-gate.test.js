'use strict';

/**
 * research-gate.test.js — 访谈出口闸门(v2.9.94)
 *
 * 纯函数(核对/合并/计数)在 research-coverage.test.js 里测;本文件测**接线**:
 *   - 每轮对话后清单落盘,并随下一轮上下文回传给模型(此前"缺口清单"只是提示词里列着、实际不存在的输入项)
 *   - 只有客户的话(与附件正文)算依据;AI 自己说过的话不算
 *   - 生成方案前的闸门:有未处理缺口 → 不调模型、返回 GAPS_OPEN;确认继续才生成,并在方案上留下记录
 *   - 方案按范围合同模板输出;缺章会被点名
 *   - 对话里的 $ 符号原样进提示词(String.replace 的替换串会把 $& $` $1 当特殊模式)
 *
 * 通过 mock lib/research/llm.chat 捕获**实际发给模型的 prompt** 来断言。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const interviews = require('../lib/research/interviews');
const coverage = require('../lib/research/coverage');
const llm = require('../lib/research/llm');

function mkCtx() {
  return { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fde-gate-')) };
}
function rm(ctx) {
  try { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); } catch { /* Windows 临时目录清理 EPERM 可容忍 */ }
}

/** 按次序回放的模型桩;记录每次实际收到的 prompt */
function stubChat(replies) {
  const orig = llm.chat;
  const prompts = [];
  llm.chat = async (_cfg, prompt) => {
    prompts.push(prompt);
    const r = replies[prompts.length - 1];
    if (r === undefined) throw new Error(`模型桩没有第 ${prompts.length} 次回复`);
    return r;
  };
  return { prompts, restore: () => { llm.chat = orig; } };
}
const reply = (obj) => ({ text: JSON.stringify(obj), channel: 'dsh', modelId: 'stub' });
const mdReply = (md) => ({ text: md, channel: 'dsh', modelId: 'stub' });

const interviewOf = (ctx, id) => interviews.getInterview(ctx, id).interview;

/** 直接写盘预置一条客户发言(绕过模型) */
function seedClient(ctx, interviewId, text) {
  const d = interviews.loadResearch(ctx);
  d.messages.push({ id: 'seed_' + Math.random().toString(36).slice(2), interviewId, role: 'client', kind: 'normal', text, ts: new Date().toISOString() });
  interviews.saveResearch(ctx, d);
}

const FULL_TEMPLATE = [
  '# 场景方案 · 月度销售报表', '',
  '## 一、现状与问题', '客户每月手工对账。',
  '## 二、目标', '对账时间降到半小时以内。',
  '## 三、方案(本期做什么)', '第一步……',
  '## 四、不做什么(本期明确排除)', '- 多语言合同',
  '## 五、验收指标', '- 对账耗时:基线缺失,需先实测 → 目标 30 分钟内',
  '## 六、风险与前提', '- 基线缺失',
  '## 七、任务建议', '1. 盘点数据源 —— ……;依赖:无;优先级:high',
].join('\n');

/** 一场"有 5 项缺口、1 项客户给不出、1 项已确认"的访谈 */
function seededInterview(ctx) {
  const iv = interviews.createInterview(ctx, { sceneTitle: '闸门场景' });
  seedClient(ctx, iv.id, '这个报表是运营总监王总让做的,耗时我们没统计过。');
  const d = interviews.loadResearch(ctx);
  const it = d.interviews.find((x) => x.id === iv.id);
  it.contextMeta.coverage = coverage.applyTurn(null, {
    stakeholders: { owner: { quote: '运营总监王总让做的' } },
    baseline: { time: { unavailable: true, quote: '没统计过' } },
  }, ['这个报表是运营总监王总让做的,耗时我们没统计过。']);
  interviews.saveResearch(ctx, d);
  return iv.id;
}

// ------------------------------------------------------------------ 清单随对话更新

test('每轮对话后清单落盘,并随下一轮上下文回传给模型;contextMeta.gaps 即未处理项', async () => {
  const ctx = mkCtx();
  const stub = stubChat([
    reply({
      advice: '好的', drafts: [],
      coverage: {
        steps: [{ name: '月度对账', who: { quote: '财务小王每月3号导出' } }],
        stakeholders: { owner: { quote: '运营总监王总让做的' } },
        assumptions: [{ text: 'SAP 可以开放接口' }],
      },
    }),
    reply({ advice: '继续', drafts: [], coverage: {} }),
  ]);
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '闸门测试' });
    await interviews.postFdeMessage(ctx, {}, iv.id, '月度对账是财务小王每月3号导出的,这个报表是运营总监王总让做的。');

    // 首轮:模型从第一轮起就看到完整的检查表(全未问)
    assert.match(stub.prompts[0], /缺口清单/, '缺口清单作为输入项真实出现在 prompt 里');
    assert.match(stub.prompts[0], /业务发起人 \?/, '首轮即列出全部检查项');
    let it = interviewOf(ctx, iv.id);
    assert.equal(it.contextMeta.coverage.steps[0].who.status, 'answered');
    assert.equal(it.contextMeta.coverage.stakeholders.owner.status, 'answered');
    assert.equal(it.contextMeta.coverage.turns, 1, '记下清单截至第几条客户发言');
    // 13 项里已确认 2 项:其余 11 项(四问余 3 + 干系人余 3 + 基线 3 + 假设 1... )——逐项核对
    assert.deepEqual(it.contextMeta.gaps.map((g) => g.label), [
      '环节「月度对账」·怎么做', '环节「月度对账」·为什么', '环节「月度对账」·交接面(输入/输出)',
      '业务发起人', 'IT/数据责任人', '最终用户',
      '耗时', '质量(错误率/返工率)', '规模(频率/人数)',
      '假设:SAP 可以开放接口',
    ], 'gaps = 未处理项,顺序与界面一致');

    // 次轮:上一轮确认过的项回传;模型回了空清单,已确认的项不丢
    await interviews.postFdeMessage(ctx, {}, iv.id, 'SAP 那边可以给我们开接口的。');
    assert.match(stub.prompts[1], /- 月度对账:谁在做 ✓「财务小王每月3号导出」/);
    assert.match(stub.prompts[1], /「SAP 可以开放接口」待客户确认/);
    it = interviewOf(ctx, iv.id);
    assert.equal(it.contextMeta.coverage.stakeholders.owner.status, 'answered');
    assert.equal(it.contextMeta.coverage.turns, 2, '模型回了空清单也算一轮更新');
  } finally { stub.restore(); rm(ctx); }
});

test('只有客户的话算依据:AI 自己说过的话、模型编出来的"客户表示",都核对不上', async () => {
  const ctx = mkCtx();
  const stub = stubChat([reply({
    advice: '明白了,这个流程是张三负责,IT部门会配合。',
    drafts: [],
    coverage: { stakeholders: { user: { quote: '这个流程是张三负责' }, it: { quote: 'IT部门会配合' } } },
  })]);
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '依据来源' });
    await interviews.postFdeMessage(ctx, {}, iv.id, '我们每个月做一次报表。');
    const st = interviewOf(ctx, iv.id).contextMeta.coverage.stakeholders;
    assert.equal(st.user.status, 'unverified', '这句只出现在 AI 自己的回复里');
    assert.equal(st.it.status, 'unverified');
  } finally { stub.restore(); rm(ctx); }
});

test('附件正文也是依据来源(需求文档/SOP 里写清楚的,不必让客户再说一遍)', async () => {
  const ctx = mkCtx();
  const stub = stubChat([reply({ advice: '好的', drafts: [], coverage: { stakeholders: { user: { quote: '报表由区域助理在每月5日前发出' } } } })]);
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '附件依据' });
    const d = interviews.loadResearch(ctx);
    d.interviews.find((x) => x.id === iv.id).attachments = [{ id: 'a1', name: 'sop.txt', bytes: 120, kind: 'text', previewText: 'SOP 第三条:报表由区域助理在每月5日前发出,店长签收。' }];
    interviews.saveResearch(ctx, d);
    await interviews.postFdeMessage(ctx, {}, iv.id, '流程都写在附件里了。');
    assert.equal(interviewOf(ctx, iv.id).contextMeta.coverage.stakeholders.user.status, 'answered');
  } finally { stub.restore(); rm(ctx); }
});

test('模型某轮没返回 coverage:清单保持不动,并如实记着"截至第几条发言"', async () => {
  const ctx = mkCtx();
  const stub = stubChat([
    reply({ advice: '好的', drafts: [], coverage: { stakeholders: { owner: { quote: '运营总监王总让做的' } } } }),
    reply({ advice: '继续', drafts: [] }),
  ]);
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '缺 coverage' });
    await interviews.postFdeMessage(ctx, {}, iv.id, '这个报表是运营总监王总让做的。');
    await interviews.postFdeMessage(ctx, {}, iv.id, '再补充一句。');
    const c = interviewOf(ctx, iv.id).contextMeta.coverage;
    assert.equal(c.stakeholders.owner.status, 'answered', '不因模型漏输出而丢失');
    assert.equal(c.turns, 1, '第 2 轮没有更新清单');
  } finally { stub.restore(); rm(ctx); }
});

// ------------------------------------------------------------------ 生成方案的闸门

test('闸门:有未处理缺口时不强制 → 不调模型、不写方案,返回 GAPS_OPEN 与缺口清单', async () => {
  const ctx = mkCtx();
  const stub = stubChat([]);
  try {
    const id = seededInterview(ctx);
    const r = await interviews.generateProposal(ctx, {}, id);
    assert.equal(r.error, 'GAPS_OPEN');
    assert.equal(r.gate.open.length, 5);
    assert.match(r.message, /5 项缺口/);
    assert.equal(stub.prompts.length, 0, '闸门没过就不该花一次模型调用');
    assert.equal(interviewOf(ctx, id).proposal, undefined, '不写方案');
  } finally { stub.restore(); rm(ctx); }
});

test('闸门:确认继续(force)后生成方案;核对结果进提示词;方案上留下"生成时有几项缺口未处理"', async () => {
  const ctx = mkCtx();
  const stub = stubChat([mdReply(FULL_TEMPLATE)]);
  try {
    const id = seededInterview(ctx);
    const r = await interviews.generateProposal(ctx, {}, id, { force: true });
    assert.ok(r.proposal && r.proposal.md.includes('不做什么'));
    assert.match(stub.prompts[0], /## 发现产物核对/, '方案模型拿得到系统核对过的发现产物');
    assert.match(stub.prompts[0], /- 干系人·业务发起人 —— 未问/);
    assert.match(stub.prompts[0], /- 干系人·业务责任人:「运营总监王总让做的」/, '已确认项带原话,方案才能引用出处');
    assert.match(stub.prompts[0], /- 基线·耗时:「没统计过」/, '客户给不出的项如实带过去');
    assert.equal(r.proposal.gate.forced, true);
    assert.equal(r.proposal.gate.open, 5);
    assert.deepEqual(r.proposal.gate.openItems.map((x) => x.label).slice(0, 3), ['业务发起人', 'IT/数据责任人', '最终用户']);
    assert.deepEqual(r.proposal.missingSections, [], '模板七节齐全');
    assert.equal(interviewOf(ctx, id).proposal.gate.open, 5, '记录落在盘上,不只在响应里');
  } finally { stub.restore(); rm(ctx); }
});

test('闸门:缺口全部处理完(含客户明确给不出)→ 直接生成,不留"未处理"记录', async () => {
  const ctx = mkCtx();
  const stub = stubChat([mdReply(FULL_TEMPLATE)]);
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '无缺口' });
    seedClient(ctx, iv.id, '这个报表是运营总监王总让做的,耗时我们没统计过。');
    const d = interviews.loadResearch(ctx);
    const line = '这个报表是运营总监王总让做的,耗时我们没统计过。';
    const said = { quote: '运营总监王总让做的' };
    const cant = { unavailable: true, quote: '没统计过' };
    const facet = { quote: '运营总监王总让做的' };
    d.interviews.find((x) => x.id === iv.id).contextMeta.coverage = coverage.applyTurn(null, {
      stakeholders: { sponsor: said, owner: said, it: cant, user: said },
      baseline: { time: cant, quality: cant, scale: cant },
    }, [line]);
    interviews.saveResearch(ctx, d);
    const r = await interviews.generateProposal(ctx, {}, iv.id);
    assert.ok(r.proposal, '不需要 force');
    assert.equal(r.proposal.gate.forced, false);
    assert.equal(r.proposal.gate.open, 0);
    assert.equal(r.proposal.gate.unavailable, 4, '客户给不出的项单独计数——它们不是缺口,但方案必须知道');
  } finally { stub.restore(); rm(ctx); }
});

test('闸门:旧访谈没有清单 → 可以生成,但提示词如实告知"未评估",方案记录 assessed:false', async () => {
  const ctx = mkCtx();
  const stub = stubChat([mdReply(FULL_TEMPLATE)]);
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '旧访谈' });
    seedClient(ctx, iv.id, '客户要月度报表自动化。');
    const r = await interviews.generateProposal(ctx, {}, iv.id);
    assert.ok(r.proposal, '未评估不拦人:闸门只对"已知缺口"负责');
    assert.match(stub.prompts[0], /未评估/, '但要让方案模型知道发现产物没核对过');
    assert.equal(r.proposal.gate.assessed, false);
  } finally { stub.restore(); rm(ctx); }
});

test('方案没按范围合同模板输出 → 点名缺失的章节(模型少写「不做什么」「验收指标」最常见)', async () => {
  const ctx = mkCtx();
  const stub = stubChat([mdReply('# 场景方案 · X\n\n## 一、现状与问题\nx\n## 二、目标\nx\n## 三、方案\nx\n## 六、风险与前提\nx\n## 七、任务建议\nx')]);
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '缺章' });
    const r = await interviews.generateProposal(ctx, {}, iv.id);
    assert.deepEqual(r.proposal.missingSections, ['不做什么', '验收指标']);
  } finally { stub.restore(); rm(ctx); }
});

test('对话里的 $ 符号原样进提示词,不被当成替换模式', async () => {
  const ctx = mkCtx();
  const stub = stubChat([mdReply(FULL_TEMPLATE)]);
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '美元符号' });
    seedClient(ctx, iv.id, '预算是 $& 元,另有 $` 和 $1 两笔,$$ 结算。');
    await interviews.generateProposal(ctx, {}, iv.id);
    assert.ok(stub.prompts[0].includes('预算是 $& 元,另有 $` 和 $1 两笔,$$ 结算。'), '客户原话一个字符都不能变');
  } finally { stub.restore(); rm(ctx); }
});

// ------------------------------------------------------------------ HTTP 契约

test('POST /api/research/interviews/:id/proposal:有缺口 → 409 GAPS_OPEN(带 gate);带 force → 201', async () => {
  const { buildApp } = require('./helpers/appAssembler');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-gate-http-'));
  const app = buildApp({ poller: 'manual', dataDir, configPath: path.join(dataDir, 'config.json'), configDir: dataDir });
  const stub = stubChat([mdReply(FULL_TEMPLATE)]);
  const headers = { 'Content-Type': 'application/json' };
  try {
    // 应用的数据目录是 configDir 下的 data/(config.dataDir 的相对路径解析)
    const id = seededInterview({ dataDir: path.join(dataDir, 'data') });
    const blocked = await app.fetch('POST', `/api/research/interviews/${id}/proposal`, { headers, body: '{}' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'GAPS_OPEN');
    assert.equal(blocked.body.gate.open.length, 5, '把缺口清单随 409 一起给前端,前端不用再取一次');
    assert.equal(stub.prompts.length, 0);

    const ok = await app.fetch('POST', `/api/research/interviews/${id}/proposal`, { headers, body: '{"force":true}' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.gate.forced, true);
  } finally {
    stub.restore();
    if (app) app.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* EPERM 可容忍 */ }
  }
});

// ------------------------------------------------------------------ 界面数据源

test('访谈详情带闸门结论(gate):界面据此渲染「访谈出口」,不在前端重复一套缺口逻辑', async () => {
  const ctx = mkCtx();
  try {
    const id = seededInterview(ctx);
    const d = interviews.getInterview(ctx, id);
    assert.equal(d.gate.assessed, true);
    assert.deepEqual(d.gate.counts, { total: 7, answered: 1, unavailable: 1, open: 5 });
    assert.equal(d.gate.items.length, 7, 'items = 全部检查项的扁平列表(含已确认/暂给不出/未处理),界面按 group 分组即可');
    // 基线项带上规范写法与实测/估算;假设项带上假设文本——界面不需要再认识 coverage 的结构
    const time = d.gate.items.find((x) => x.label === '耗时');
    assert.deepEqual([time.status, time.quote], ['unavailable', '没统计过']);
    assert.equal(d.gate.items.find((x) => x.label === '业务责任人').group, 'stakeholder');
  } finally { rm(ctx); }
});

test('未评估的访谈:gate.assessed=false、items 为空——界面据此显示"还没有清单",而不是"没有缺口"', async () => {
  const ctx = mkCtx();
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '未评估' });
    const d = interviews.getInterview(ctx, iv.id);
    assert.equal(d.gate.assessed, false);
    assert.deepEqual(d.gate.items, []);
    assert.equal(d.gate.counts.open, 0);
  } finally { rm(ctx); }
});

test('场景列表带 openGaps(未处理缺口数;未评估为 null),左栏一眼看出哪场还不能生成方案', async () => {
  const ctx = mkCtx();
  try {
    seededInterview(ctx);
    interviews.createInterview(ctx, { sceneTitle: '未评估' });
    const list = interviews.listInterviews(ctx);
    assert.equal(list.find((x) => x.sceneTitle === '闸门场景').openGaps, 5);
    assert.equal(list.find((x) => x.sceneTitle === '未评估').openGaps, null, '未评估 ≠ 0 缺口');
  } finally { rm(ctx); }
});

// ------------------------------------------------------------------ 模型调用超时

test('生成方案用自己的超时上限,不借用「听记分析」的配置:方案是长输出(实测 8000+ 字、约 3~4 分钟)', async () => {
  const ctx = mkCtx();
  const seen = [];
  const orig = llm.chat;
  llm.chat = async (_cfg, _prompt, opts) => { seen.push(opts); return mdReply(FULL_TEMPLATE); };
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '超时' });
    await interviews.generateProposal(ctx, { analyze: { timeoutSec: 60 } }, iv.id);
    assert.ok(seen[0].timeoutSec >= 600, `方案超时应 ≥600s,实际 ${seen[0].timeoutSec}(听记分析配置的 60s 不能传导到这里)`);
    await interviews.generateProposal(ctx, {}, iv.id, { timeoutSec: 42 });
    assert.equal(seen[1].timeoutSec, 42, '调用方显式指定时以调用方为准');
  } finally { llm.chat = orig; rm(ctx); }
});
