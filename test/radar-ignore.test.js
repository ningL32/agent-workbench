'use strict';

/**
 * radar-ignore.test.js — v2.9.63：删过的纪要不回来 + 关键词/标题过滤
 *
 * 回归的真实场景：删掉一条钉钉听记 → 下次同步又拉回来 → 收件箱候选又冒出来。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const radarIgnore = require('../lib/radarIgnore');

function tmpCtx() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-ig-'));
  return { dataDir, config: {} };
}

function cleanup(ctx) {
  try {
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  } catch (e) {
    /* Windows EPERM 容错 */
  }
}

test('墓碑：删除过的纪要 id 直接跳过（不用拉逐字稿）', () => {
  const ctx = tmpCtx();
  try {
    assert.equal(radarIgnore.ignoredReason(ctx, { id: 'm-1' }), null, '没删过就正常处理');
    radarIgnore.addTombstone(ctx, 'm-1', '周会：招聘进度');
    const why = radarIgnore.ignoredReason(ctx, { id: 'm-1' });
    assert.ok(why && /忽略名单/.test(why), '删过之后必须被跳过');

    const v = radarIgnore.view(ctx);
    assert.equal(v.messageCount, 1);
    assert.equal(v.messages[0].title, '周会：招聘进度', '要记下标题，方便在界面里认出来');

    radarIgnore.removeTombstone(ctx, 'm-1');
    assert.equal(radarIgnore.ignoredReason(ctx, { id: 'm-1' }), null, '恢复后应能重新同步');
  } finally {
    cleanup(ctx);
  }
});

test('规则：关键词命中标题或正文；标题片段只命中标题', () => {
  const ctx = tmpCtx();
  try {
    radarIgnore.setRules(ctx, { keywords: ['团建', 'Branding'], titles: ['周例会'] });

    assert.ok(radarIgnore.ignoredReason(ctx, { msg: { title: '部门团建安排', content: '' } }), '标题含关键词要跳过');
    assert.ok(radarIgnore.ignoredReason(ctx, { msg: { title: '内容评审', content: '这次 branding 会改 logo' } }), '正文含关键词（忽略大小写）要跳过');
    assert.ok(radarIgnore.ignoredReason(ctx, { msg: { title: '第 12 次周例会纪要', content: '' } }), '标题片段命中要跳过');
    assert.equal(radarIgnore.ignoredReason(ctx, { msg: { title: '客户交付复盘', content: '与规则无关的内容' } }), null, '不命中就正常处理');

    const v = radarIgnore.view(ctx);
    assert.deepEqual(v.rules.keywords, ['团建', 'Branding']);
  } finally {
    cleanup(ctx);
  }
});

test('规则写入：去空白、裁长度、限制条数', () => {
  const ctx = tmpCtx();
  try {
    const long = 'x'.repeat(200);
    radarIgnore.setRules(ctx, { keywords: ['  团建  ', '', long], titles: ['  '] });
    const v = radarIgnore.view(ctx);
    assert.deepEqual(v.rules.keywords, ['团建', 'x'.repeat(60)], '空白丢弃、超长截断');
    assert.deepEqual(v.rules.titles, [], '全空白等于清空');
  } finally {
    cleanup(ctx);
  }
});

// ---------- 路由级：删除纪要会留墓碑，接口可读可改 ----------

test('路由：DELETE 纪要 → 入忽略名单；GET/POST/DELETE /api/radar/ignore 可用', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-igr-'));
  const cfgPath = path.join(tmpRoot, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: 7852,
    host: '127.0.0.1',
    dataDir: path.join(tmpRoot, 'data'),
    webDir: path.join(tmpRoot, 'web'),
    gitea: { pollIntervalSec: 0 },
    agentActivity: { enabled: true, sources: {} },
    dingtalk: { enabled: true, hostWhitelist: ['dingtalk.com'] },
  }));
  const { buildApp } = require('./helpers/appAssembler');
  const app = buildApp({ poller: 'manual', warmProbe: false, configPath: cfgPath });
  try {
    // 先塞一条纪要进池（走 store，模拟已同步）
    const store = require('../lib/store');
    const ctx = app.ctx || app.context || null;
    // appAssembler 暴露的内部 ctx 名不固定，直接用同一 dataDir 写文件
    const msgFile = path.join(tmpRoot, 'data', 'messages.json');
    fs.mkdirSync(path.dirname(msgFile), { recursive: true });
    fs.writeFileSync(msgFile, JSON.stringify({ messages: [{ id: 'msg-1', title: '周会：招人', occurredAt: new Date().toISOString(), content: '内容', ref: { url: '' } }] }));

    const del = await app.fetch('DELETE', '/api/radar/messages/msg-1');
    assert.equal(del.status, 200);
    assert.equal(del.body.ignored, true, '删除必须同时进忽略名单');

    const ig = await app.fetch('GET', '/api/radar/ignore');
    assert.equal(ig.status, 200);
    assert.equal(ig.body.messageCount, 1);
    assert.ok(ig.body.messages.some((m) => m.id === 'msg-1'));

    const post = await app.fetch('POST', '/api/radar/ignore', { body: JSON.stringify({ rules: { keywords: ['团建'], titles: [] } }), headers: { 'content-type': 'application/json' } });
    assert.equal(post.status, 200);
    assert.deepEqual(post.body.rules.keywords, ['团建']);

    const un = await app.fetch('DELETE', '/api/radar/ignore/messages/msg-1');
    assert.equal(un.status, 200);
    assert.equal(un.body.remaining, 0, '恢复后墓碑清空');
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (e) {
      /* EPERM 容忍 */
    }
  }
});
