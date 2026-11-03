'use strict';

/**
 * im-notify.test.js — v2.9.39 IM 通知（飞书/钉钉）离线用例
 *
 * 纪律：
 *  - 全合成夹具、零出网（fetcher 注入缝；不请求真实端点）
 *  - 不触碰真实 ~/.dsh/fde-console/data（AGENTS 红线 3）：一律临时目录，清理容忍 Windows EPERM
 *  - 时间相关全部注入 now，不依赖运行时刻（否则夜间/跨日必挂）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const im = require('../lib/imNotify');

function tmpCtx(imCfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-im-'));
  return {
    dataDir: dir,
    tasksPath: path.join(dir, 'tasks.json'),
    inboxPath: path.join(dir, 'inbox.json'),
    config: { im: imCfg || {} },
    _dir: dir,
  };
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}

/** Windows 临时目录清理 EPERM 容错（AGENTS 测试纪律） */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* 留给系统临时目录回收 */
  }
}

const FEISHU_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcd-1234';
const DINGTALK_URL = 'https://oapi.dingtalk.com/robot/send?access_token=abcd1234';

// ---------- 目标归一化 ----------

test('normalizeTargets：非法平台/空 url/私网地址被剔除，且在 skipped 留痕', () => {
  const { targets, skipped } = im.normalizeTargets({
    im: {
      targets: [
        { platform: 'feishu', url: FEISHU_URL },
        { platform: 'slack', url: 'https://hooks.slack.com/services/x' },
        { platform: 'dingtalk', url: '' },
        { platform: 'dingtalk', url: 'http://127.0.0.1:9000/robot/send?access_token=x' },
      ],
    },
  });

  assert.equal(targets.length, 1);
  assert.equal(targets[0].platform, 'feishu');
  assert.equal(skipped.length, 3, '三类非法项都必须留痕，不得静默丢弃');
});

// ---------- 报文与签名 ----------

test('buildBody：钉钉走 markdown 且标题截断；飞书走 text 并附 timestamp+sign', () => {
  const d = im.buildBody('dingtalk', 'FDE 指挥台', ['第一行'], '');
  assert.equal(d.msgtype, 'markdown');
  assert.equal(d.markdown.title, 'FDE 指挥台');

  const f = im.buildBody('feishu', 'FDE 指挥台', ['第一行'], 'sign-secret');
  assert.equal(f.msg_type, 'text');
  assert.ok(f.timestamp && f.sign, '配了 secret 必须带 timestamp/sign');
  assert.match(f.content.text, /第一行/);
});

test('dingtalkSignedUrl：配了 secret 才追加 timestamp/sign，不配则原样返回', () => {
  assert.equal(im.dingtalkSignedUrl(DINGTALK_URL, ''), DINGTALK_URL);

  const signed = new URL(im.dingtalkSignedUrl(DINGTALK_URL, 'sign-secret'));
  assert.ok(signed.searchParams.get('timestamp'));
  assert.ok(signed.searchParams.get('sign'));
  assert.equal(signed.searchParams.get('access_token'), 'abcd1234', '原 query 不得被破坏');
});

// ---------- 单目标发送 ----------

test('sendOne：HTTP 200 但钉钉 errcode≠0 判失败（业务码必须认，不能只看状态码）', async () => {
  const r = await im.sendOne(
    { platform: 'dingtalk', url: DINGTALK_URL, secret: '' },
    'T',
    ['x'],
    { fetcher: async () => ({ ok: true, status: 200, json: async () => ({ errcode: 310000, errmsg: 'sign not match' }) }) }
  );

  assert.equal(r.ok, false);
  assert.match(r.error, /310000/);
});

test('sendOne：飞书 code=0 视为成功；HTTP 500 视为失败', async () => {
  const okRes = await im.sendOne(
    { platform: 'feishu', url: FEISHU_URL, secret: '' },
    'T',
    ['x'],
    { fetcher: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, msg: 'success' }) }) }
  );
  assert.equal(okRes.ok, true);

  const badRes = await im.sendOne(
    { platform: 'feishu', url: FEISHU_URL, secret: '' },
    'T',
    ['x'],
    { fetcher: async () => ({ ok: false, status: 500, json: async () => ({}) }) }
  );
  assert.equal(badRes.ok, false);
  assert.equal(badRes.status, 500);
});

test('sendAll：未配置可用目标时 ok=false、results 为空（零出网）', async () => {
  const r = await im.sendAll({ im: { targets: [] } }, 'T', ['x'], {});
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 0);
});

// ---------- 事件派发 ----------

test('fireTaskEvents：默认关闭零出网；开启后推「待验收」且带任务标题', async () => {
  const off = im.fireTaskEvents({ config: { im: { enabled: false } } }, [
    { taskId: 't1', type: 'status', from: 'doing', to: 'review', detail: '状态 doing → review' },
  ]);
  assert.equal(off.fired, 0);

  const ctx = tmpCtx({
    enabled: true,
    events: { review: true, completed: false },
    targets: [{ platform: 'feishu', url: FEISHU_URL }],
  });
  writeJSON(ctx.tasksPath, { columns: [], tasks: [{ id: 't1', title: '甲任务', status: 'review' }] });

  let captured = null;
  const fetcher = async (url, opt) => {
    captured = JSON.parse(opt.body);
    return { ok: true, status: 200, json: async () => ({ code: 0 }) };
  };
  const r = im.fireTaskEvents(
    ctx,
    [{ taskId: 't1', type: 'status', from: 'doing', to: 'review', detail: '状态 doing → review' }],
    { fetcher }
  );
  assert.equal(r.fired, 1);

  await new Promise((resolve) => setTimeout(resolve, 0)); // 等 fire-and-forget 的微任务落地
  assert.match(JSON.stringify(captured), /甲任务/, '推送正文必须带任务标题，不能只有 taskId');
  cleanup(ctx._dir);
});

// ---------- 每日摘要 ----------

test('buildDigest：逾期/待验收/收件箱/昨日完成四项计数准确', () => {
  const ctx = tmpCtx({});
  const now = new Date(2026, 9, 31, 9, 10, 0);
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymdOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const yesterday = new Date(2026, 9, 30, 12, 0, 0);

  writeJSON(ctx.tasksPath, {
    columns: [],
    tasks: [
      { id: 't1', title: '逾期A', status: 'todo', dueDate: '2026-10-01' },
      { id: 't2', title: '待验收B', status: 'review' },
      { id: 't3', title: '昨日完成', status: 'done', completedAt: `${ymdOf(yesterday)}T02:00:00.000Z` },
    ],
  });
  writeJSON(ctx.inboxPath, [
    { id: 'c1', title: '候选1', state: 'pending' },
    { id: 'c2', title: '候选2', state: 'confirmed' },
  ]);

  const d = im.buildDigest(ctx, now);
  assert.deepEqual(d.counts, { overdue: 1, review: 1, pending: 1, doneYesterday: 1 });
  cleanup(ctx._dir);
});

test('maybeRunDigest：未到点不发；到点发一次并落标记，当日再调不重发', async () => {
  const ctx = tmpCtx({
    enabled: true,
    digest: { enabled: true, at: '09:00' },
    events: {},
    targets: [{ platform: 'feishu', url: FEISHU_URL }],
  });
  writeJSON(ctx.tasksPath, { columns: [], tasks: [] });
  writeJSON(ctx.inboxPath, []);

  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ code: 0 }) };
  };

  const early = await im.maybeRunDigest(ctx, { fetcher, now: new Date(2026, 9, 31, 8, 0, 0) });
  assert.equal(early.sent, false);
  assert.equal(early.reason, '未到点');

  const first = await im.maybeRunDigest(ctx, { fetcher, now: new Date(2026, 9, 31, 9, 30, 0) });
  assert.equal(first.sent, true);

  const second = await im.maybeRunDigest(ctx, { fetcher, now: new Date(2026, 9, 31, 10, 0, 0) });
  assert.equal(second.sent, false);
  assert.equal(second.reason, '今日已发');
  assert.equal(calls, 1, '同一天只发一次，绝不刷屏');
  cleanup(ctx._dir);
});
