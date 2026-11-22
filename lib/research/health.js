'use strict';

/**
 * lib/research/health.js — 场景健康预警（SPEC-RESEARCH Tier1-③）
 *
 * FDE 同时跑 N 个客户场景,"哪个客户要凉了"必须机器可见:
 *  - sceneHealth(ctx): 按项目目录聚合任务活跃度 → status ok|warn|stale
 *    口径:场景内最新任务 updatedAt 距今;warn ≥ staleHours(默认 72h),stale ≥ 168h
 *    ——只看人工确认面(任务表),启发式归因不参与
 *  - maybeWarnScenes(ctx): pollTick 每日一次,有 stale/warn 场景且 IM 通道开启时推送
 *    (沿 imNotify 每日摘要的"到点+当日未发"去重纪律)
 */

const store = require('../store');
const imNotify = require('../imNotify');

const WARN_HOURS_DEFAULT = 72;
const STALE_HOURS_DEFAULT = 168;

function thresholdMs(cfg) {
  const rc = (cfg && cfg.research) || {};
  const warn = Number(rc.staleHours) > 0 ? Number(rc.staleHours) : WARN_HOURS_DEFAULT;
  const stale = Number(rc.staleHours) > 0 ? Number(rc.staleHours) * 2 + 24 : STALE_HOURS_DEFAULT;
  return { warnMs: warn * 3600000, staleMs: stale * 3600000 };
}

/** 场景健康聚合:按 projectDir 分组的任务活跃度(只读 tasks,零源扫描) */
function sceneHealth(ctx) {
  const cfg = ctx.config || {};
  const { warnMs, staleMs } = thresholdMs(cfg);
  const now = Date.now();
  const { tasks } = store.loadTasks(ctx);
  const byScene = new Map();
  for (const t of tasks) {
    const dir = (t.projectDir || '').trim() || '(未绑定)';
    if (!byScene.has(dir)) byScene.set(dir, { projectDir: dir, tasks: 0, doing: 0, overdue: 0, latest: null, stale: 0 });
    const s = byScene.get(dir);
    s.tasks += 1;
    if (t.status === 'doing') s.doing += 1;
    if (t.status !== 'done' && typeof t.dueDate === 'string') {
      const n = new Date();
      const p = (x) => String(x).padStart(2, '0');
      const today = `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
      if (t.dueDate < today) s.overdue += 1;
    }
    const upd = Date.parse(typeof t.updatedAt === 'string' ? t.updatedAt : '');
    if (Number.isFinite(upd) && (s.latest === null || upd > s.latest)) s.latest = upd;
  }
  const scenes = [...byScene.values()].map((s) => {
    const age = s.latest === null ? null : now - s.latest;
    let status = 'ok';
    // 冻结 backlog 同样算凉:任何场景,最近更新超阈值即 warn/stale(不限 doing)
    if (age !== null && age >= staleMs) status = 'stale';
    else if (age !== null && age >= warnMs) status = 'warn';
    s.lastUpdateAgeHours = age === null ? null : Math.round(age / 3600000);
    s.status = status;
    return s;
  });
  scenes.sort((a, b) => (a.status === b.status ? b.lastUpdateAgeHours - a.lastUpdateAgeHours : a.status.localeCompare(b.status)));
  return { scenes, staleCount: scenes.filter((s) => s.status !== 'ok').length };
}

/** pollTick 每日一次:stale/warn 场景推送 IM(到点 09:30 + 当日未发守卫;im.enabled 才发) */
function maybeWarnScenes(ctx, now) {
  const cfg = ctx.config || {};
  const im = cfg.im || {};
  if (im.enabled !== true || !Array.isArray(im.targets) || im.targets.length === 0) return { sent: false, reason: 'IM 未启用' };
  const n = now || Date.now();
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  const dayKey = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hhmm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (hhmm < '09:30') return { sent: false, reason: '未到 09:30' };
  try {
    const data = JSON.parse(require('node:fs').readFileSync(require('node:path').join(ctx.dataDir, 'research.json'), 'utf8'));
    if (data.lastSceneWarnAt === dayKey) return { sent: false, reason: '今日已发' };
    const health = sceneHealth(ctx);
    const bad = health.scenes.filter((s) => s.status !== 'ok');
    if (!bad.length) {
      data.lastSceneWarnAt = dayKey;
      interviews_save(data, ctx);
      return { sent: false, reason: '无停滞场景(今日不再检查)' };
    }
    const lines = bad.map((s) => `${s.status === 'stale' ? '⛔' : '⚠'} ${s.projectDir}: ${s.doing} 个进行中,最近更新 ${s.lastUpdateAgeHours}h 前,逾期 ${s.overdue}`);
    const r = imNotify.sendAll(cfg, `场景健康预警(${bad.length} 个场景需关注)`, lines, { now: n });
    data.lastSceneWarnAt = dayKey;
    interviews_save(data, ctx);
    return { sent: true, results: r };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { sent: false, reason: '无调研数据' };
    console.error(`[research/health] 场景预警推送失败(留痕不阻塞): ${(e && e.message) || e}`);
    return { sent: false, reason: '推送失败(已留痕)' };
  }
}

// research.json 的读写归 interviews 单元;此处只改 lastSceneWarnAt 一个字段——
// 独立小写函数避免引 circular(interviews 又引 kb)
function interviews_save(data, ctx) {
  const fs = require('node:fs');
  const file = require('node:path').join(ctx.dataDir, 'research.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { sceneHealth, maybeWarnScenes };
