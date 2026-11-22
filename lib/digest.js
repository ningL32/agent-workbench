'use strict';

/**
 * lib/digest.js — 晨会简报（Tier1-①）：FDE 每天和客户开站会,一段可复制的 Markdown
 * 聚合全部既有数源(纯人工确认面+计数,零启发式细节);确定性输出,零 LLM。
 * 场景健康段来自 lib/research/health(数据已在)。
 */

const store = require('./store');
const kb = require('./research/kb');
const health = require('./research/health');

function pad2(x) {
  return String(x).padStart(2, '0');
}

function ymdOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function buildDigest(ctx, now) {
  const n = now ? new Date(now) : new Date();
  const today = ymdOf(n);
  const yesterday = ymdOf(new Date(n.getTime() - 86400000));
  const { tasks } = store.loadTasks(ctx);

  const overdue = tasks.filter((t) => t.status !== 'done' && typeof t.dueDate === 'string' && t.dueDate < today);
  const review = tasks.filter((t) => t.status === 'review');
  const doneYesterday = tasks.filter((t) => typeof t.completedAt === 'string' && t.completedAt.slice(0, 10) === yesterday);
  const activities = store.loadActivities(ctx);
  const acts24h = activities.filter((a) => {
    const t = Date.parse(a && a.occurredAt);
    return Number.isFinite(t) && n.getTime() - t >= 0 && n.getTime() - t <= 86400000;
  });

  let diaryMissing = 0;
  try {
    const diaryMod = require('./diary');
    const withDiary = diaryMod.taskIdsWithDiaryOn(ctx, diaryMod.localYmd());
    const seen = new Set();
    for (const t of tasks) {
      if (t.status !== 'doing' || !t.memberId || seen.has(t.memberId)) continue;
      if (!withDiary.has(t.id)) { diaryMissing += 1; seen.add(t.memberId); }
    }
  } catch (e) {
    console.error(`[digest] 日报未填聚合失败: ${(e && e.message) || e}`);
  }

  const eligible = kb.eligible(ctx).count;
  const healthData = health.sceneHealth(ctx);
  const badScenes = healthData.scenes.filter((s) => s.status !== 'ok');

  const research = (() => {
    try {
      const data = JSON.parse(require('node:fs').readFileSync(require('node:path').join(ctx.dataDir, 'research.json'), 'utf8'));
      const open = data.interviews.filter((i) => i.status === 'open');
      const pending = data.drafts.filter((x) => x.status === 'pending');
      return { open: open.length, pending: pending.length };
    } catch (e) {
      return { open: 0, pending: 0 };
    }
  })();

  const L = [];
  L.push(`# 晨会简报 · ${today}`);
  L.push('');
  L.push(`- 逾期任务 ${overdue.length}${overdue.length ? ':' + overdue.map((t) => `${t.title}(到期 ${t.dueDate})`).join('、') : ''}`);
  L.push(`- 待验收 ${review.length}${review.length ? ':' + review.map((t) => t.title).join('、') : ''}`);
  L.push(`- 昨日完成 ${doneYesterday.length}${doneYesterday.length ? ':' + doneYesterday.map((t) => t.title).join('、') : ''}`);
  L.push(`- 24h 团队动态 ${acts24h.length} 条 · 日报未填 ${diaryMissing} 人`);
  L.push(`- 可沉淀进知识库 ${eligible} 条`);
  L.push(`- 调研:进行中访谈 ${research.open} 场 · 待处理草稿 ${research.pending} 条`);
  if (badScenes.length) {
    L.push(`- ⚠ 场景健康:${badScenes.map((s) => `${s.projectDir}(${s.status},最近更新 ${s.lastUpdateAgeHours}h 前)`).join('、')}`);
  }
  L.push('');
  return { markdown: L.join('\n'), generatedAt: n.toISOString(), counts: { overdue: overdue.length, review: review.length, doneYesterday: doneYesterday.length, acts24h: acts24h.length, diaryMissing, eligible, researchOpen: research.open, researchPending: research.pending, badScenes: badScenes.length } };
}

module.exports = { buildDigest };
