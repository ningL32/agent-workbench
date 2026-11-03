'use strict';
/**
 * weekly.js — v2.9.6 数字员工报告（日报 + 周报）：聚合「智能体动态」会话数据做养料，
 * 经 harness 引擎（dsh --profile headless，与雷达拆解同一通道）萃取蒸馏成 Markdown。
 *
 * 两种报告共用一条管线，仅参数不同：
 *   日报 daily：时间窗 1 天，内容抽样 20 条，≤300 字；自动档——每天 ≥08:00 首个轮询 tick
 *              自动生成（当日已有/未到点/失败未满 1h 则跳过），落 data/report-daily.json
 *   周报 weekly：时间窗 7 天，内容抽样 35 条，≤600 字；手动生成，落 data/weekly.json
 *
 * 养料四路（全部只读本地数据，零新采集）：
 *   ① 各桌面源会话（agentTranscript 六源列表：标题/项目/状态 + 首问⇒末答内容萃取）
 *   ② Gitea 提交/PR（activities.json，滤除 [demo-team] 机器人统计提交）
 *   ③ 任务动态（完成/进行中）
 *   ④ 人工日报（diary.json）
 *
 * 引擎红线与 analyze 完全一致：DSH_FIXTURE 离线替代 stdout（测试零出网）；
 * 引擎超时 600s（雷达实证：推理模型大 prompt 300s 不够）；日志经 redact。
 */

const fs = require('node:fs');
const { redact } = require('./redact.js');
const store = require('./store.js');
const diaryMod = require('./diary.js');
const gitea = require('./giteaClient.js');
const jobs = require('./jobs.js');
const { listAgentSessions, getAgentTranscript, normalizeProjectKey } = require('./agentTranscript.js');
const { runHeadless, runHeadlessFixture } = require('./analyze.js');
const { HttpError, sendJSON } = require('./router.js');

const SOURCE_IDS = ['zcode', 'claude', 'dsh', 'codex', 'opencode', 'workbuddy'];
const MAX_SESSION_LINES = 120;      // 喂给引擎的会话行数上限（防爆 prompt）
const WEEKLY_TIMEOUT_SEC = 600;     // 引擎超时（雷达实证：推理模型大 prompt 300s 不够）
const TITLE_CLIP = 80;
const COMMIT_TITLE_CLIP = 60;
const DIARY_CLIP = 200;

/** 两种报告的参数档 */
const KINDS = {
  daily: {
    rangeDays: 1,
    file: 'report-daily.json',
    maxContent: 20, firstClip: 120, lastClip: 100,
    keyField: 'dayKey', timeoutSec: WEEKLY_TIMEOUT_SEC,
  },
  weekly: {
    rangeDays: 7,
    file: 'weekly.json',
    maxContent: 35, firstClip: 150, lastClip: 120,
    keyField: 'weekKey', timeoutSec: WEEKLY_TIMEOUT_SEC,
  },
};

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function dataPath(cfg, name) {
  return gitea.resolveDataPath(cfg, name);
}

function readJsonArray(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

// bot 统计提交标记（读取时归一，AGENTS 词表纪律）：开源换名 [demo-team] 与存量部署历史 [teamai]
// 双认——bot 工具产出的标题不随本仓改名，只滤新词会漏滤历史/未来真机提交（评审 P1）
const BOT_MARKERS = ['[demo-team]', '[teamai]'];
function isBotCommit(a) {
  const title = String((a && a.title) || '');
  return BOT_MARKERS.some((m) => title.toLowerCase().startsWith(m.toLowerCase()));
}

/** 服务器本地日期 YYYY-MM-DD（日报自动档「今日已有」判定与 dayKey 用） */
function localYmd(d) {
  const x = d instanceof Date ? d : new Date(d || Date.now());
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** 今日本地 00:00 的毫秒值 */
function todayStartMs(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 自然时间窗（业主拍板口径：报告严格只含其名义周期，绝不混入周期外数据）：
 *   日报 = 昨日自然日（昨日 00:00 → 今日 00:00）；周报 = 上周自然周（上周一 00:00 → 本周一 00:00）。
 */
function naturalRange(kind, now) {
  const start = todayStartMs(now);
  if (kind === 'daily') return { since: start - 24 * 3600 * 1000, until: start };
  const dow = (new Date(start).getDay() + 6) % 7; // 周一=0
  const thisMonday = start - dow * 24 * 3600 * 1000;
  return { since: thisMonday - 7 * 24 * 3600 * 1000, until: thisMonday };
}

// ---------------------------------------------------------------- 养料聚合

/**
 * 聚合最近 rangeDays 天的四路养料（纯确定性，可单测）。
 * opts: {now, days, maxContent, firstClip, lastClip, listSessions, getTranscript}
 * bot 提交（title 以 [demo-team] 开头）一律排除。
 */
function collectWeeklyFacts(ctx, opts = {}) {
  const kind = KINDS[opts.kind || 'weekly'] || KINDS.weekly;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  // 窗口优先级：显式 range（自然日/自然周，generateReport 传入）> days 滚动窗（兼容旧测试）。
  // until 为开区间上界（自然窗口严格不含周期外数据）
  let since;
  let until;
  if (opts.range && Number.isFinite(opts.range.since) && Number.isFinite(opts.range.until)) {
    since = opts.range.since;
    until = opts.range.until;
  } else {
    since = now - (Number(opts.days) || kind.rangeDays) * 24 * 3600 * 1000;
    until = now + 60000;
  }
  const inRange = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= since && t < until;
  };
  const maxContent = Number.isFinite(opts.maxContent) ? opts.maxContent : kind.maxContent;
  const firstClipN = Number.isFinite(opts.firstClip) ? opts.firstClip : kind.firstClip;
  const lastClipN = Number.isFinite(opts.lastClip) ? opts.lastClip : kind.lastClip;
  // 会话取数可注入（测试确定性；缺省走真实六源 listAgentSessions）
  const fetchPage = typeof opts.listSessions === 'function'
    ? opts.listSessions
    : (agent, cursor) => listAgentSessions(ctx.config, { agent, limit: 50, cursor, now });
  // 转录取样可注入（默认真实 getAgentTranscript；workbuddy 等无转录源 degraded 自然跳过）
  const fetchTranscript = typeof opts.getTranscript === 'function'
    ? opts.getTranscript
    : (ref) => getAgentTranscript(ctx.config, ref, {});

  // ① 数字员工会话（六源，逐源翻页拉到时间窗外或翻尽；单源故障该源缺席不拖垮报告）
  const sessions = [];
  const perAgent = {};
  for (const agent of SOURCE_IDS) {
    let collected = 0;
    let cursor = null;
    let exhausted = false;
    for (let page = 0; page < 4 && !exhausted && sessions.length < MAX_SESSION_LINES; page++) {
      let r;
      try {
        r = fetchPage(agent, cursor);
      } catch (e) {
        break; // 单源故障隔离
      }
      let outOfRange = false;
      let unparsable = 0;
      for (const it of r.items || []) {
        const t = Date.parse(it.lastActiveAt);
        // 列表新→旧：比窗口新的条目（日报/周报生成时的「今天」）只能跳过不能止——
        // 止了就把整窗漏掉（2026-11-03 真机事故：日报采 zcode/codex 全 0，因当天会话排最前触发出窗即止）
        if (!Number.isFinite(t)) {
          unparsable += 1; // 时间不可解析静默跳过=红线 8 盲区（评审 P2）：留痕一条，防「源坏了表现成没干活」
          continue;
        }
        if (t >= until) continue;
        if (t < since) { outOfRange = true; break; } // 越过窗口下界：该源采集结束
        if (sessions.length >= MAX_SESSION_LINES) break;
        sessions.push({
          agent,
          ref: it.ref || '',
          title: clip(it.title, TITLE_CLIP),
          project: it.projectId || '',
          state: it.state || '',
          lastActiveAt: it.lastActiveAt,
        });
        collected += 1;
      }
      perAgent[agent] = (perAgent[agent] || 0) + collected;
      if (outOfRange || !r.nextCursor || sessions.length >= MAX_SESSION_LINES) exhausted = true;
      cursor = r.nextCursor;
      if (unparsable > 0) {
        console.error(`[weekly] ${agent} 有 ${unparsable} 条会话 lastActiveAt 不可解析（已跳过，不进报告）`);
      }
    }
    if (!perAgent[agent]) perAgent[agent] = 0;
  }

  // ①b 内容机械萃取（两级蒸馏的第一层）：按最近优先抽 maxContent 条，逐条读转录抽
  // 「首条用户消息（任务指令）⇒ 末条助手消息（交付结果）」。单会话转录失败跳过不炸整体。
  const byRecent = sessions.filter((s) => s.ref).sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
  let contentSessions = 0;
  for (const s of byRecent.slice(0, maxContent)) {
    try {
      const t = fetchTranscript(s.ref);
      if (!t || t.degraded || !Array.isArray(t.messages) || t.messages.length === 0) continue;
      const firstUser = t.messages.find((m) => m.role === 'user');
      const lastAssistant = t.messages.slice().reverse().find((m) => m.role === 'assistant');
      const digest = [
        firstUser ? clip(firstUser.text, firstClipN) : '',
        lastAssistant ? clip(lastAssistant.text, lastClipN) : '',
      ].filter(Boolean).join(' ⇒ ');
      if (digest) { s.digest = digest; contentSessions += 1; }
    } catch (e) { /* 单会话失败跳过 */ }
  }

  // ② Gitea 提交/PR（滤 bot；读走 store 路由——2026-11-03 评审 P1：直读 JSON 在已迁移实例上静默断粮）
  const acts = store
    .loadActivities(ctx)
    .filter((a) => (a.type === 'commit' || a.type === 'pr' || a.type === 'commit_pushed' || a.type === 'pr_opened' || a.type === 'pr_merged'))
    .filter((a) => inRange(a.occurredAt))
    .filter((a) => !isBotCommit(a));
  const byActor = new Map();
  for (const a of acts) {
    const actor = a.actor || 'unknown';
    if (!byActor.has(actor)) byActor.set(actor, { count: 0, titles: [] });
    const e = byActor.get(actor);
    e.count += 1;
    if (e.titles.length < 8) e.titles.push(clip(a.title, COMMIT_TITLE_CLIP));
  }

  // ③ 任务动态
  const { tasks } = store.loadTasks(ctx);
  const done = tasks.filter((t) => t.status === 'done' && inRange(t.completedAt)).map((t) => clip(t.title, 60));
  const doing = tasks.filter((t) => t.status === 'doing').map((t) => clip(t.title, 60));

  // ④ 人工日报（窗内有更新的条目，content 截 200；读走 diary 路由——同上评审 P1）
  const diaries = diaryMod
    .loadDiaries(ctx)
    .filter((d) => inRange(d.updatedAt))
    .slice(0, 10)
    .map((d) => {
      const t = tasks.find((x) => x.id === d.taskId);
      return { taskTitle: clip(t ? t.title : d.taskId, 40), date: d.date, content: clip(d.content, DIARY_CLIP) };
    });

  return {
    rangeStart: new Date(since).toISOString(),
    rangeEnd: new Date(now).toISOString(),
    sessions,
    commits: [...byActor.entries()].map(([actor, e]) => ({ actor, count: e.count, titles: e.titles })),
    tasksDone: done,
    tasksDoing: doing,
    diaries,
    stats: {
      perAgent: perAgent,
      sessionsTotal: sessions.length,
      contentSessions,
      commitsTotal: acts.length,
      doneTotal: done.length,
      doingTotal: doing.length,
      diaryTotal: diaries.length,
      truncated: sessions.length >= MAX_SESSION_LINES,
    },
  };
}

// ---------------------------------------------------------------- prompt

/** 养料事实 → 蒸馏 prompt（日报/周报结构与篇幅不同） */
function buildReportPrompt(facts, kind) {
  const lines = [];
  if (kind === 'daily') {
    lines.push('【任务】你是 AI 数字员工团队的日报撰稿人。仅依据下方「过去 24 小时事实素材」萃取蒸馏一份中文日报（Markdown）。');
    lines.push('要求：');
    lines.push('- 只依据素材事实归纳，不编造、不臆测；素材未覆盖的不写；');
    lines.push('- 结构固定：## 摘要（一段≤80字）→ ## 昨日进展（3-5 条，每条一句话带证据）→ ## 进行中 → ## 值得注意（风险/阻塞，没有写"无"）；');
    lines.push('- 正文 ≤300 字；直接输出 Markdown 正文，不要代码围栏，不要寒暄。');
  } else {
    lines.push('【任务】你是 AI 数字员工团队的周报撰稿人。仅依据下方「本周事实素材」萃取蒸馏一份中文周报（Markdown）。');
    lines.push('要求：');
    lines.push('- 只依据素材事实归纳，不编造、不臆测；素材未覆盖的不写；');
    lines.push('- 结构固定：## 总览（一段≤120字，开头以「本周期（<素材时间窗起> 至 <素材时间窗止>）」标注精确周期，日期逐字采用【素材 · 时间窗】给出的起止，禁止自行推算）→ ## 工作亮点（按项目/主题分 3-6 条，每条一句话带证据）→ ## 各数字员工动态（每人 1-3 句）→ ## 任务与交付（完成/进行中）→ ## 值得注意（风险/阻塞/建议 2-3 条，没有写"无"）；');
    lines.push('- 正文 ≤600 字；直接输出 Markdown 正文，不要代码围栏，不要寒暄。');
  }
  lines.push('');
  // 时间窗用本地日期标签（facts 里是 UTC ISO，直接喂会被引擎误读日期，如上周一 00:00+08 显示为 10-11）
  lines.push(`【素材 · 时间窗】${localYmd(facts.rangeStart)} 至 ${localYmd(facts.rangeEnd)}（本地时间，截止点不含）；归纳时一律以此窗口表述，不得外推`);
  lines.push('【素材 · 数字员工会话】格式：智能体 | 项目 | 标题；「内容」行为该会话首条任务指令与末条交付结果的机械萃取（两层蒸馏的第一层），是归纳的主要依据');
  for (const s of facts.sessions) {
    const proj = normalizeProjectKey(s.project).split('\\').filter(Boolean).pop() || '未知';
    lines.push(`- ${s.agent} | ${proj} | ${s.title}`);
    if (s.digest) lines.push(`  · 内容：${s.digest}`);
  }
  if (!facts.sessions.length) lines.push('-（窗内无会话记录）');
  lines.push('【素材 · Gitea 提交/PR（已滤机器人）】');
  for (const c of facts.commits) lines.push(`- ${c.actor}：${c.count} 条，如「${c.titles.join('」「')}」`);
  if (!facts.commits.length) lines.push('-（窗内无提交）');
  lines.push(`【素材 · 任务】完成 ${facts.tasksDone.length}：${facts.tasksDone.join('、') || '无'}；进行中 ${facts.tasksDoing.length}：${facts.tasksDoing.join('、') || '无'}`);
  lines.push('【素材 · 人工日报】');
  for (const d of facts.diaries) lines.push(`- ${d.date}《${d.taskTitle}》：${d.content}`);
  if (!facts.diaries.length) lines.push('-（窗内无日报）');
  return lines.join('\n');
}

/** 兼容保留：周报 prompt（既有测试/调用方口径） */
function buildWeeklyPrompt(facts) {
  return buildReportPrompt(facts, 'weekly');
}

/** 引擎输出清理：去首尾代码围栏与空白（模型偶尔包 ```markdown） */
function cleanReport(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/i, '');
  return t.trim();
}

// ---------------------------------------------------------------- 生成与落盘

/** 聚合 → 引擎蒸馏 → 落盘（daily→report-daily.json / weekly→weekly.json，各仅存最新一份）。
 * 窗口口径（业主拍板）：日报=昨日自然日、周报=上周自然周——严格不含名义周期外数据。 */
async function generateReport(ctx, kind) {
  const k = KINDS[kind];
  if (!k) throw new HttpError(400, 'BAD_KIND', 'kind 必须为 daily/weekly');
  const now = Date.now();
  const range = naturalRange(kind, now);
  const facts = collectWeeklyFacts(ctx, {
    kind, range,
    days: k.rangeDays, maxContent: k.maxContent, firstClip: k.firstClip, lastClip: k.lastClip,
  });
  const prompt = buildReportPrompt(facts, kind);
  let output;
  const fx = runHeadlessFixture();
  if (fx !== null) {
    output = fx; // fixture 模式零 spawn（测试离线）
  } else {
    output = await runHeadless(ctx.config, prompt, { timeoutSec: k.timeoutSec });
  }
  const report = cleanReport(output);
  if (!report) throw Object.assign(new Error('引擎输出为空'), { code: 'WEEKLY_EMPTY' });
  const doc = {
    generatedAt: new Date().toISOString(),
    generatedDay: localYmd(now), // 日报自动档「今日已生成」判定键
    report,
    stats: facts.stats,
  };
  // 键=报告覆盖的起始自然日：日报=昨日、周报=上周一（绝不含周期外数据的口径锚点）
  doc[k.keyField] = localYmd(range.since);
  store.writeJSON(dataPath(ctx.config, k.file), doc);
  return doc;
}

/** 兼容保留：周报生成 */
function generateWeekly(ctx) {
  return generateReport(ctx, 'weekly');
}

function readReport(ctx, kind) {
  const k = KINDS[kind];
  if (!k) return null;
  try {
    const j = JSON.parse(fs.readFileSync(dataPath(ctx.config, k.file), 'utf8'));
    return j && j.report ? j : null;
  } catch {
    return null;
  }
}

/** 兼容保留：读周报 */
function readWeekly(ctx) {
  return readReport(ctx, 'weekly');
}

// ---------------------------------------------------------------- 日报自动档

let lastAutoAttempt = 0; // 进程内：失败后每小时最多重试一次（成功当天直接被 dayKey 守卫拦下）

/**
 * 日报自动档（挂轮询 tick）：本地时间 ≥08:00 且今天尚未生成过 → 自动生成昨日自然日窗口日报。
 * 守卫顺序：今天已生成（generatedDay=今天）→ 跳过；未到 08:00 → 跳过；失败后 1h 内不重试。
 * opts.now 可注入（测试）。返回 'generated' | 'exists' | 'too-early' | 'throttled'（供测试断言）。
 */
async function maybeAutoDaily(ctx, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const doc = readReport(ctx, 'daily');
  if (doc && doc.generatedDay === localYmd(now)) return 'exists';
  const hour = new Date(now).getHours();
  if (hour < 8) return 'too-early';
  if (Date.now() - lastAutoAttempt < 3600e3) return 'throttled';
  lastAutoAttempt = Date.now();
  await generateReport(ctx, 'daily');
  return 'generated';
}

// ---------------------------------------------------------------- 路由

/** 报告路由（weekly 三条既有端点不动；daily 三条平行新增） */
function registerWeeklyRoutes(router, ctx) {
  // POST /api/weekly/generate | /api/daily/generate → 202 {jobId}（引擎蒸馏 30~120s+，走雷达同款 job 轮询）
  for (const kind of ['weekly', 'daily']) {
    router.add('POST', `/api/${kind}/generate`, (c) => {
      const job = jobs.createJob(kind, 1);
      (async () => {
        try {
          const doc = await generateReport(ctx, kind);
          job.current = null;
          job.done = 1;
          job.results.push({ item: doc[kind === 'daily' ? 'dayKey' : 'weekKey'], ok: true, stats: doc.stats });
          job.state = 'done';
        } catch (err) {
          job.results.push({ item: kind, ok: false, error: redact((err && err.message) || String(err)) });
          job.state = 'failed';
        } finally {
          jobs.finishJob(job);
        }
      })().catch(() => {});
      sendJSON(c.res, 202, { jobId: job.id });
    });

    // GET /api/<kind>/job/:id → 进度轮询
    router.add('GET', `/api/${kind}/job/:id`, (c) => {
      const job = jobs.getJob(c.params.id);
      if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', '任务不存在或已过期');
      sendJSON(c.res, 200, jobs.jobView(job));
    });

    // GET /api/<kind> → 最新报告（404 NOT_FOUND = 从未生成）
    router.add('GET', `/api/${kind}`, (c) => {
      const doc = readReport(ctx, kind);
      if (!doc) throw new HttpError(404, kind === 'daily' ? 'DAILY_NOT_FOUND' : 'WEEKLY_NOT_FOUND', kind === 'daily' ? '尚未生成日报' : '尚未生成周报');
      sendJSON(c.res, 200, doc);
    });
  }
}

module.exports = {
  collectWeeklyFacts,
  buildReportPrompt,
  buildWeeklyPrompt,
  generateReport,
  generateWeekly,
  readReport,
  readWeekly,
  maybeAutoDaily,
  localYmd,
  naturalRange,
  cleanReport,
  registerWeeklyRoutes,
};
