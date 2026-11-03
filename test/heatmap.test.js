'use strict';

/**
 * heatmap.test.js — v2.9.26 Agent 时间线热力图：日×agent 聚合
 *
 * 覆盖：
 *  - 注入缝聚合：多源多日会话 → 正确落桶（lastActiveAt 所在日）、时长口径（clamp 1min..6h）
 *  - 出窗会话不计入；同日同 agent 多会话累加
 *  - days 钳制（0→默认 28、负数→1、超大→90）；days 输出数组长度与日期连续
 *  - 单源异常隔离（注入抛错 → 该源零贡献不拖垮）
 *  - localYmd 本地时区口径
 * 纪律：零出网零 sqlite（listSessions 全注入）；模块级无状态（adapters 走参数）。
 * 运行：node --test test/heatmap.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildHeatmap, localYmd, DEFAULT_DAYS, MAX_DAYS } = require('../lib/heatmap');

const NOW = new Date('2026-10-30T04:00:00.000Z'); // 本地 12:00（+08:00 机器）
const MIN = 60 * 1000;
const DAY = 24 * 3600 * 1000;

function iso(ts) {
  return new Date(ts).toISOString();
}

test('localYmd：本地时区日期（+08:00 机器上 UTC 04:00 = 当日 12:00）', () => {
  assert.equal(localYmd(NOW.getTime()), '2026-10-30');
  // UTC 2026-10-30T17:00Z = 本地 31 日 01:00 → 归 10-31
  assert.equal(localYmd(Date.parse('2026-10-30T17:00:00.000Z')), '2026-10-31');
});

test('聚合：多源多日落桶、时长口径、同日累加、出窗出局', () => {
  const now = NOW.getTime();
  const r = buildHeatmap(
    {},
    {
      now,
      days: 7,
      adapters: {
        zcode: () => [
          // 今天：3.5h → 210 分钟
          { startedAt: iso(now - 210 * MIN), lastActiveAt: iso(now - 5 * MIN) },
          // 今天第二条：同 agent 累加
          { startedAt: iso(now - 30 * MIN), lastActiveAt: iso(now - 1 * MIN) },
          // 7 天窗之前 → 出局
          { startedAt: iso(now - 10 * DAY), lastActiveAt: iso(now - 9 * DAY) },
        ],
        claude: () => [
          // 昨天（本地）：90 分钟
          { startedAt: iso(now - DAY - 90 * MIN), lastActiveAt: iso(now - DAY - 2 * MIN) },
          // 跨夜挂起：40h → 钳 360
          { startedAt: iso(now - 3 * DAY - 40 * 60 * MIN), lastActiveAt: iso(now - 3 * DAY) },
        ],
      },
    }
  );
  assert.equal(r.agents.length, 2);
  assert.ok(r.agents.includes('zcode') && r.agents.includes('claude'));
  const today = r.days[r.days.length - 1];
  assert.equal(today.date, localYmd(now));
  assert.equal(today.agents.zcode.sessions, 2);
  assert.equal(today.agents.zcode.minutes, 205 + 29); // (210-5)min + (30-1)min
  const yesterday = r.days[r.days.length - 2];
  assert.equal(yesterday.agents.claude.minutes, 88); // 90-2=88
  const threeAgo = r.days[r.days.length - 4];
  assert.equal(threeAgo.agents.claude.minutes, 360, '挂起 40h 钳 6h');
  assert.equal(r.totalSessions, 4, '出窗会话不计入 total');
  assert.ok(r.totalMinutes > 0 && r.totalMinutes === 205 + 29 + 88 + 360);;
  assert.equal(r.days.length, 7);
});

test('时长下限：1 分钟内闪断会话计 1 分钟；startedAt 缺失计 1 分钟', () => {
  const now = NOW.getTime();
  const r = buildHeatmap({}, {
    now,
    days: 3,
    adapters: {
      codex: () => [
        { startedAt: iso(now - 20 * 1000), lastActiveAt: iso(now) }, // 20 秒 → 1 分钟
        { startedAt: null, lastActiveAt: iso(now) }, // 缺 start → 1 分钟
      ],
    },
  });
  const today = r.days[r.days.length - 1];
  assert.equal(today.agents.codex.sessions, 2);
  assert.equal(today.agents.codex.minutes, 2);
});

test('days 钳制与日期连续性', () => {
  const NO_SRC = {}; // 纯注入模式（空映射=全源零贡献），不触真实路径
  const r0 = buildHeatmap({}, { now: NOW.getTime(), days: 0, adapters: NO_SRC }); // → 默认 28
  assert.equal(r0.days.length, DEFAULT_DAYS);
  const rNeg = buildHeatmap({}, { now: NOW.getTime(), days: -5, adapters: NO_SRC }); // → 1
  assert.equal(rNeg.days.length, 1);
  const rBig = buildHeatmap({}, { now: NOW.getTime(), days: 999, adapters: NO_SRC }); // → 90
  assert.equal(rBig.days.length, MAX_DAYS);
  // 日期连续（首日=now-(n-1)天）
  const r = buildHeatmap({}, { now: NOW.getTime(), days: 5, adapters: NO_SRC });
  assert.equal(r.days[4].date, localYmd(NOW.getTime()));
  assert.equal(r.days[0].date, localYmd(NOW.getTime() - 4 * DAY));
});

test('单源注入抛错：该源零贡献，其余源照常', () => {
  const r = buildHeatmap({}, {
    now: NOW.getTime(),
    days: 3,
    adapters: {
      dsh: () => { throw new Error('boom'); },
      zcode: () => [{ startedAt: iso(NOW.getTime() - 10 * MIN), lastActiveAt: iso(NOW.getTime()) }],
    },
  });
  assert.ok(!r.agents.includes('dsh'));
  assert.ok(r.agents.includes('zcode'));
  assert.equal(r.totalSessions, 1);
});
