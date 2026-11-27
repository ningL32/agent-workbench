'use strict';

/**
 * interview-memory.test.js — 多轮对话滚动记忆(v2.9.95)
 *
 * 背景:原实现对对话历史 slice(-12) 硬截断——聊到第 7 轮,客户最初说的需求就不在上下文里了。
 * 现改为分层上下文:早期对话滚动摘要 + 最近 N 条原文。
 *
 * 通过 mock lib/research/llm.chat 捕获**实际发给模型的 prompt** 来断言(而非测内部函数):
 *  - 早期内容在原文窗口之外时,必须出现在 prompt 里(经摘要或经原文)
 *  - 系统留痕行(parse_error/paper)不占原文窗口
 *  - 并发发言第二条被拒(INTERVIEW_BUSY),不丢消息
 *  - 客户消息先落盘:模型调用抛错后,发言仍在磁盘上
 *  - 记忆更新不阻塞回复:回复返回时摘要可以还没好
 *  - 摘要后台并入后,下一轮 prompt 带上摘要
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const interviews = require('../lib/research/interviews');
const llm = require('../lib/research/llm');

function mkCtx() {
  return { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fde-ivmem-')) };
}
const rm = (ctx) => fs.rmSync(ctx.dataDir, { recursive: true, force: true });

/** AI 的标准契约回复(不产草稿) */
const aiReply = (advice) => ({
  text: JSON.stringify({ advice: advice || '好的,我了解了。', drafts: [] }),
  channel: 'dsh', modelId: 'stub',
});

/** 预置一条对话行(绕过模型,直接写盘) */
function seedRow(ctx, interviewId, role, text, kind) {
  const d = interviews.loadResearch(ctx);
  d.messages.push({
    id: 'seed_' + Math.random().toString(36).slice(2), interviewId, role, kind: kind || 'normal', text,
    ts: new Date().toISOString(),
  });
  interviews.saveResearch(ctx, d);
}

test('分层上下文:早期需求滚出原文窗口后,仍通过摘要进入 prompt', async () => {
  const ctx = mkCtx();
  const origChat = llm.chat;
  const prompts = [];
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '记忆测试' });
    // 预置早期记忆摘要(模拟后台已完成更新):覆盖了前 20 条
    let d = interviews.loadResearch(ctx);
    d.interviews.find((x) => x.id === iv.id).memory = '【已确认的事实】\n- 客户最初需求:月度报表自动化,按部门分发';
    d.interviews.find((x) => x.id === iv.id).memoryUpto = 20;
    interviews.saveResearch(ctx, d);
    // 再预置 12 条原文(正好填满窗口)
    for (let k = 1; k <= 12; k++) seedRow(ctx, iv.id, k % 2 ? 'client' : 'AI', '窗口内消息 ' + k);

    llm.chat = async (_cfg, prompt) => { prompts.push(prompt); return aiReply(); };
    await interviews.postFdeMessage(ctx, {}, iv.id, '新的一条');

    assert.strictEqual(prompts.length, 1);
    const p = prompts[0];
    assert.ok(p.includes('早期对话摘要'), 'prompt 含摘要段');
    assert.ok(p.includes('月度报表自动化,按部门分发'), '早期需求没有因为滚出窗口而丢失');
    assert.ok(p.includes('窗口内消息 1'), '原文窗口内的最早一条仍在');
    assert.ok(!p.includes('暂未纳入摘要'), '摘要覆盖连续时不应出现空档提示');
  } finally {
    llm.chat = origChat;
    rm(ctx);
  }
});

test('无摘要时如实告知空档,不静默丢弃', async () => {
  const ctx = mkCtx();
  const origChat = llm.chat;
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '空档测试' });
    for (let k = 1; k <= 20; k++) seedRow(ctx, iv.id, k % 2 ? 'client' : 'AI', '历史 ' + k);
    let p = '';
    let memRelease;
    const memGate = new Promise((r) => { memRelease = r; });
    // 摘要被人为挂起:模拟「摘要还没生成/生成很慢」的过渡态——这正是本用例要验证的场景
    llm.chat = async (_cfg, prompt) => {
      if (prompt.includes('滚动记忆')) { await memGate; return { text: '摘要', channel: 'dsh', modelId: 'stub' }; }
      p = prompt; return aiReply();
    };
    try {
      await interviews.postFdeMessage(ctx, {}, iv.id, '新消息');
      // 21 条真实对话,窗口 12 → 前 9 条既不在摘要(还没生成)也不在窗口
      assert.ok(p.includes('暂未纳入摘要'), '存在未覆盖空档时必须提示模型,而不是假装对话只有这些');
      assert.ok(!p.includes('历史 1]') && !p.includes('历史 1\n'), '窗口外的原文不逐字带入(控制 token)');
      assert.ok(p.includes('历史 10'), '窗口内原文在');
    } finally {
      memRelease(); // 放行后台摘要,避免它悬着
      await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    }
  } finally {
    llm.chat = origChat;
    rm(ctx);
  }
});

test('系统留痕行不占原文窗口', async () => {
  const ctx = mkCtx();
  const origChat = llm.chat;
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '留痕测试' });
    // 判别法:两份**真实对话完全相同**(11 条)的数据,一份掺入 6 条系统留痕。
    // 若留痕占窗口位,掺留痕那份会有真实对话被挤出 → 两次 prompt 的原文段不同。
    seedRow(ctx, iv.id, 'client', '真实诉求-A');
    for (let k = 1; k <= 10; k++) seedRow(ctx, iv.id, k % 2 ? 'client' : 'AI', '后续 ' + k);
    let pClean = '';
    llm.chat = async (_cfg, prompt) => { if (!prompt.includes('滚动记忆')) pClean = prompt; return aiReply(); };
    await interviews.postFdeMessage(ctx, {}, iv.id, '最新');
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));

    const iv2 = interviews.createInterview(ctx, { sceneTitle: '留痕测试2' });
    seedRow(ctx, iv2.id, 'client', '真实诉求-A');
    for (let k = 1; k <= 10; k++) seedRow(ctx, iv2.id, k % 2 ? 'client' : 'AI', '后续 ' + k);
    for (let k = 1; k <= 6; k++) seedRow(ctx, iv2.id, 'system', 'LLM 返回无法解析 ' + k, 'parse_error');
    let pNoisy = '';
    llm.chat = async (_cfg, prompt) => { if (!prompt.includes('滚动记忆')) pNoisy = prompt; return aiReply(); };
    await interviews.postFdeMessage(ctx, {}, iv2.id, '最新');
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));

    const recentOf = (p) => p.slice(p.indexOf('### 最近'));
    assert.ok(!pNoisy.includes('LLM 返回无法解析'), '系统留痕不进入对话历史');
    // 判别:同样 11 条真实对话,加了 6 条留痕后,原文窗口的内容应完全一样
    assert.strictEqual(recentOf(pNoisy).replace(/留痕测试2/g, '留痕测试'), recentOf(pClean), '留痕不影响哪些真实对话进入窗口');
  } finally {
    llm.chat = origChat;
    rm(ctx);
  }
});

test('并发:同一访谈第二条发言被拒(409 语义),第一条正常完成', async () => {
  const ctx = mkCtx();
  const origChat = llm.chat;
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '并发测试' });
    let release;
    const gate = new Promise((r) => { release = r; });
    llm.chat = async () => { await gate; return aiReply(); };
    const first = interviews.postFdeMessage(ctx, {}, iv.id, '第一条');
    // 让第一条真正进入 await 之后再发第二条
    await new Promise((r) => setImmediate(r));
    await assert.rejects(
      () => interviews.postFdeMessage(ctx, {}, iv.id, '第二条'),
      (e) => e && e.code === 'INTERVIEW_BUSY',
    );
    release();
    const r = await first;
    assert.ok(r && r.aiMessage, '第一条正常完成');
    // 第二条没有被写进对话(被拒在入口,不会产生孤立的客户消息)
    const rows = interviews.loadResearch(ctx).messages.filter((m) => m.interviewId === iv.id && m.role === 'client');
    assert.strictEqual(rows.length, 1, '只有第一条客户发言落盘');
  } finally {
    llm.chat = origChat;
    rm(ctx);
  }
});

test('客户消息先落盘:模型调用抛错后发言仍在', async () => {
  const ctx = mkCtx();
  const origChat = llm.chat;
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '落盘测试' });
    llm.chat = async () => { throw new Error('引擎超时'); };
    await interviews.postFdeMessage(ctx, {}, iv.id, '这条不能丢');
    const rows = interviews.loadResearch(ctx).messages.filter((m) => m.interviewId === iv.id);
    assert.ok(rows.some((m) => m.role === 'client' && m.text === '这条不能丢'), '客户发言已落盘');
    assert.ok(rows.some((m) => m.kind === 'parse_error'), '失败留痕(红线 8)');
  } finally {
    llm.chat = origChat;
    rm(ctx);
  }
});

test('记忆后台更新:回复不等摘要;摘要并入后下一轮 prompt 带上它', async () => {
  const ctx = mkCtx();
  const origChat = llm.chat;
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '后台记忆' });
    // 12 条填满窗口 → 第 13 条发出后,第 1 条滚出,应触发后台摘要
    for (let k = 1; k <= 12; k++) seedRow(ctx, iv.id, k % 2 ? 'client' : 'AI', '早期内容' + k);
    let memRelease;
    const memGate = new Promise((r) => { memRelease = r; });
    const calls = [];
    llm.chat = async (_cfg, prompt) => {
      calls.push(prompt);
      if (prompt.includes('滚动记忆')) { await memGate; return { text: '【已确认的事实】\n- 早期内容1', channel: 'dsh', modelId: 'stub' }; }
      return aiReply();
    };
    const t0 = Date.now();
    await interviews.postFdeMessage(ctx, {}, iv.id, '第十三条');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, '回复不被摘要阻塞(摘要被人为挂起,回复仍应立刻返回)');
    assert.strictEqual(calls.length, 2, '回复 1 次 + 后台摘要 1 次');
    assert.ok(calls[1].includes('早期内容1'), '摘要的输入包含滚出窗口的早期内容');
    // 摘要还没返回时,磁盘上不该有 memory
    assert.ok(!interviews.loadResearch(ctx).interviews.find((x) => x.id === iv.id).memory, '摘要未完成前不落盘');
    memRelease();
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    const it = interviews.loadResearch(ctx).interviews.find((x) => x.id === iv.id);
    assert.ok(it.memory && it.memory.includes('早期内容1'), '摘要并入后落盘');
    // 摘要在 AI 回复落盘**之后**才调度:12 预置 + 客户发言 + AI 回复 = 14 条,窗口 12 → 滚出 2 条
    assert.strictEqual(it.memoryUpto, 2, '记录摘要覆盖到的条数(含本轮客户发言与 AI 回复)');
    // 下一轮:prompt 带摘要
    await interviews.postFdeMessage(ctx, {}, iv.id, '第十四条');
    assert.ok(calls[2].includes('早期内容1'), '下一轮 prompt 带上了摘要里的早期事实');
  } finally {
    llm.chat = origChat;
    rm(ctx);
  }
});

test('记忆更新失败只留痕,不影响对话主流程', async () => {
  const ctx = mkCtx();
  const origChat = llm.chat;
  const origErr = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const iv = interviews.createInterview(ctx, { sceneTitle: '记忆失败' });
    for (let k = 1; k <= 12; k++) seedRow(ctx, iv.id, k % 2 ? 'client' : 'AI', '早期' + k);
    llm.chat = async (_cfg, prompt) => {
      if (prompt.includes('滚动记忆')) throw new Error('摘要引擎挂了');
      return aiReply();
    };
    const r = await interviews.postFdeMessage(ctx, {}, iv.id, '继续聊');
    assert.ok(r && r.aiMessage && r.aiMessage.kind === 'normal', '对话照常完成');
    await new Promise((res) => setImmediate(res)); await new Promise((res) => setImmediate(res));
    assert.ok(errs.some((e) => e.includes('摘要更新失败')), '失败留痕');
    const it = interviews.loadResearch(ctx).interviews.find((x) => x.id === iv.id);
    assert.ok(!it.memory, '失败不写摘要');
    // 锁被释放:下一轮可以重试摘要
    let memCalls = 0;
    llm.chat = async (_cfg, prompt) => {
      if (prompt.includes('滚动记忆')) { memCalls += 1; return { text: '摘要', channel: 'dsh', modelId: 'stub' }; }
      return aiReply();
    };
    await interviews.postFdeMessage(ctx, {}, iv.id, '再聊');
    await new Promise((res) => setImmediate(res)); await new Promise((res) => setImmediate(res));
    assert.strictEqual(memCalls, 1, '失败后下一轮会重试摘要');
  } finally {
    console.error = origErr;
    llm.chat = origChat;
    rm(ctx);
  }
});
