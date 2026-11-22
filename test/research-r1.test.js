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
