'use strict';

/**
 * overview.js — B5 总览聚合 + 成员进度（v1.1）+ 手工名册聚合（v1.2）
 * - GET /api/overview：任务分布/智能体数/24h 动态/gitea 健康
 *   （读 data/gitea-status.json，只读）
 *   v2.2：gatewayExternalRunning 字段已随 网关集成整体移除（业主 2026-10-20）；
 *   v2.3：sessionsRunning 字段已随会话登记表退役移除（规格 §6——会话观测唯一入口
 *   = GET /api/agent-sessions，登记表已无数据消费方）
 * - GET /api/members：读时聚合不落盘；桌面 agent 注册表四源并列（workbuddy/zcode/codex/
 *   opencode，v2.6 起硅基成员来源，读 config.agentActivity.sources 各源 enabled/root/dbPath）
 *   ∪ Gitea 成员缓存 ∪ 动态中出现的人类 actor ∪ 手工名册 members.json（manual:true，giteaLogin
 *   命中则归因其 Gitea 活动数据）。agents.json CLI 注册表仍不进成员册（仅用于人类派生时的
 *   actor 排除）。
 */

const store = require('./store');
const { redact } = require('./redact');
const { sendJSON } = require('./router');
const { collectDesktopMembers, collectDesktopSourceHealth } = require('./desktopAgents');
const diaryMod = require('./diary');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// v1.4：优先级合法集（与 server.js registerTaskRoutes 内同款；历史数据缺字段时回退 medium）
const PRIORITIES = ['high', 'medium', 'low'];

function parseTs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function ageSec(now, iso) {
  const t = parseTs(iso);
  if (t === null) return null;
  return Math.max(0, Math.floor((now - t) / 1000));
}

function computeOverview(ctx) {
  const now = Date.now();
  const { columns, tasks } = store.loadTasks(ctx);

  const counts = {};
  [...columns]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .forEach((col) => {
      counts[col.id] = 0;
    });
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1;
  }

  // v1.4：逾期任务数——按天比较（YYYY-MM-DD 字符串序比较即可），严格早于今天才逾期，今天到期不算
  const n = new Date();
  const pad2 = (x) => String(x).padStart(2, '0');
  const todayYmd = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
  const overdue = tasks.filter((t) => typeof t.dueDate === 'string' && t.dueDate < todayYmd).length;

  const agents = store.loadAgents(ctx.agentsPath).length;

  const activities = store.loadActivities(ctx);
  const activities24h = activities.filter((a) => {
    const t = parseTs(a && a.occurredAt);
    return t !== null && now - t >= 0 && now - t <= DAY_MS;
  }).length;

  // 日报未填人数（2026-11-03 驾驶舱行动条）：名下有「进行中」任务、但今天没有任何 doing 任务
  // 填了日报的**人类负责人**去重计数——纯 tasks+diary 数据零源扫描（/api/members 口径的 diaryToday
  // 同源；评审修正：agentId 属主不参与——diary 是人工日报，硅基属主恒计「未填」属虚计）
  let diaryMissing = 0;
  try {
    const withDiary = diaryMod.taskIdsWithDiaryOn(ctx, diaryMod.localYmd());
    const doingByOwner = new Map();
    for (const t of tasks) {
      if (t.status !== 'doing') continue;
      const owner = typeof t.memberId === 'string' ? t.memberId.trim() : ''; // 仅人类属主（memberId）
      if (!owner) continue;
      if (!doingByOwner.has(owner)) doingByOwner.set(owner, { any: 0, covered: 0 });
      const slot = doingByOwner.get(owner);
      slot.any += 1;
      if (withDiary.has(t.id)) slot.covered += 1;
    }
    for (const slot of doingByOwner.values()) {
      if (slot.any > 0 && slot.covered === 0) diaryMissing += 1;
    }
  } catch (e) {
    console.error(redact(`[overview] diaryMissing 聚合失败（行动条该项按 0 计）: ${(e && e.message) || e}`));
  }

  return {
    tasks: { ...counts, overdue }, // v1.4：响应形状仅增 overdue 键，其余键一律不动
    agents,
    activities24h,
    diaryMissing, // v2026-11-03 只增：驾驶舱行动条「日报未填」数据源
    gitea: store.loadGiteaStatus(ctx),
  };
}

// ---------- 成员进度 ----------

// v2.9.1：actorMatches 随「动态流 actor 派生成员」整条退役（原用于智能体 actor 排除）。

/** 合成/占位 actor 不得参与聚合（qoder #4） */
function isSyntheticActor(actor) {
  return !actor || String(actor).trim().toLowerCase() === 'unknown';
}

/** #7：仅接受 http(s) URL 的动态，杜绝 javascript: 等伪协议流入前端渲染 */
function isSafeActivityUrl(url) {
  return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url);
}

/** 分支精确相等，或 title/branch 互为 ≥4 字子串（SPEC §3 模糊匹配规则） */
function fuzzyMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.includes(a)) return true;
  if (b.length >= 4 && a.includes(b)) return true;
  return false;
}

function activityMatchesTask(act, task) {
  return (
    fuzzyMatch(act.branch, task.branch) ||
    fuzzyMatch(act.title, task.title) ||
    fuzzyMatch(act.branch, task.title) ||
    fuzzyMatch(act.title, task.branch)
  );
}

/** 按成员谓词聚合动态统计：24h 提交数、7d 开放 PR 列表、最近动态时间 */
function memberActivityStats(activities, predicate, now) {
  let todayCommits = 0;
  let lastAct = null;
  const openedPRs = [];
  const mergedUrls = new Set();
  for (const act of activities) {
    if (!act || !predicate(act.actor)) continue;
    const t = parseTs(act.occurredAt);
    if (t !== null && (lastAct === null || t > lastAct)) lastAct = t;
    const fresh = t !== null && now - t >= 0;
    // 提交判定：feeds 词表 'commit'；存量词表 commit_pushed 容错（过渡期 activities.json 两词表并存）
    if (fresh && now - t <= DAY_MS && (act.type === 'commit_pushed' || act.type === 'commit')) todayCommits += 1;
    if (fresh && now - t <= WEEK_MS) {
      // 开放 PR 判定：'pr'（feeds 词表）视作开放 PR——feeds 统一后 opened/merged 同 url 经
      // mergeActivities type|url 去重合并为一条，无法区分合并态，按开放计（近似口径）；
      // 存量 pr_opened 容错保留
      if ((act.type === 'pr_opened' || act.type === 'pr') && isSafeActivityUrl(act.url)) openedPRs.push(act);
      if (act.type === 'pr_merged' && isSafeActivityUrl(act.url)) mergedUrls.add(act.url); // 存量容错
    }
  }
  const openPRs = openedPRs.filter((p) => !mergedUrls.has(p.url));
  return { todayCommits, lastAct, openPRs };
}

/** progress 推导（SPEC §3 演示值）：todo 0 / doing 无 PR 0.3 / doing 有 PR 0.6 / review 0.85 / done 1 */
function progressFor(task, openPRs) {
  switch (task.status) {
    case 'todo':
      return 0;
    case 'doing':
      return openPRs.some((p) => activityMatchesTask(p, task)) ? 0.6 : 0.3;
    case 'review':
      return 0.85;
    case 'done':
      return 1;
    default:
      return 0;
  }
}

function computeMembers(ctx) {
  const now = Date.now();
  const giteaCfg = ctx.config.gitea || {};
  const staleWarnSec = Number(giteaCfg.staleWarnSec) > 0 ? Number(giteaCfg.staleWarnSec) : 14400;

  const agents = store.loadAgents(ctx.agentsPath); // v2.5 起仅用于人类派生时的智能体 actor 排除，不再是成员来源
  const { tasks } = store.loadTasks(ctx);
  const activities = store.loadActivities(ctx);

  // 全量开放 PR 列表（7d 内 pr_opened 或 feeds 'pr'，且未被存量 pr_merged 命中）：任务进度匹配用，
  // 不限 actor——任务的 PR 可能由协作者开启，匹配看分支/标题而非作者。
  // 'pr' 视作开放 PR（近似口径）：feeds 词表统一后 opened/merged 同 url 合并为一条
  // （mergeActivities type|url 去重），合并态不可辨；pr_merged 判定保留（存量容错）
  const openedAll = [];
  const mergedUrls = new Set();
  for (const act of activities) {
    if (!act || isSyntheticActor(act.actor)) continue;
    const t = parseTs(act.occurredAt);
    if (t === null || now - t < 0 || now - t > WEEK_MS) continue;
    if ((act.type === 'pr_opened' || act.type === 'pr') && isSafeActivityUrl(act.url)) openedAll.push(act);
    if (act.type === 'pr_merged' && isSafeActivityUrl(act.url)) mergedUrls.add(act.url);
  }
  const globalOpenPRs = openedAll.filter((p) => !mergedUrls.has(p.url));

  const memberEntries = [];

  // 「当前任务推导 + sinceUpdateSec + status + weekDone」统一入口（v1.2 起 agent 与两类 human 共用）：
  // current = 归领任务中 updatedAt 最新的未完成任务；human 条目 session 恒为 null。
  // v1.4 修订（goose 真机验收 P1-2）：活动锚点 = max(名下未完成任务中最新的 updatedAt, 最近一条
  // Gitea 动态时间)——有在办任务时任务本身就是活动证据，刚派任务不再被陈旧 Gitea 动态拖成
  // 「超时危险」；无任务成员维持纯 Gitea 锚点不变。lastActivityAt 响应字段同步用合并锚点。
  function deriveTaskView(myTasks, lastAct, sess) {
    const current = myTasks
      .filter((t) => t.status !== 'done')
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;

    const taskTs = current ? parseTs(current.updatedAt) : null;
    let anchorTs = lastAct;
    if (taskTs !== null && (anchorTs === null || taskTs > anchorTs)) anchorTs = taskTs;

    const sinceUpdateSec = anchorTs !== null ? Math.max(0, Math.floor((now - anchorTs) / 1000)) : null;

    const hasDoing = myTasks.some((t) => t.status === 'doing');
    let status = 'idle';
    if (hasDoing && sinceUpdateSec !== null && sinceUpdateSec > staleWarnSec) status = 'stale';
    else if (hasDoing || (sess && sess.alive)) status = 'working';

    const weekDone = myTasks.filter((t) => {
      if (t.status !== 'done') return false;
      const u = parseTs(t.updatedAt);
      return u !== null && now - u >= 0 && now - u <= WEEK_MS;
    }).length;

    return {
      status,
      currentTask: current
        ? {
            id: current.id,
            title: current.title,
            status: current.status,
            dueDate: typeof current.dueDate === 'string' ? current.dueDate : null, // v1.4：透传截止时间（历史数据缺字段回退 null）
            priority: PRIORITIES.includes(current.priority) ? current.priority : 'medium', // v1.4：透传优先级（历史数据缺字段回退 medium）
            ageSec: ageSec(now, current.updatedAt),
            sinceUpdateSec,
            progress: progressFor(current, globalOpenPRs),
          }
        : null,
      weekDone,
      lastActivityAt: anchorTs !== null ? new Date(anchorTs).toISOString() : null, // v1.4 修订：合并锚点
    };
  }

  // v2.6 硅基成员泛化（业主 2026-10-20）：桌面 agent 注册表四源并列——workbuddy/zcode/codex/
  // opencode 各自从本机会话库派生（适配器复用 agentActivity，见 lib/desktopAgents.js）。
  // 开关与路径沿用 config.agentActivity.sources 各源 enabled/root/dbPath；每源独立 try/catch，
  // 单源失败该源缺席不拖垮。状态/任务推导沿用 deriveTaskView：源侧最近会话 active 视作 alive 会话。
  const desktopMembers = collectDesktopMembers(ctx.config && ctx.config.agentActivity, {
    now,
    tasks,
    deriveTaskView,
    adapters: ctx.adapters, // 测试注入缝（v2.9.14）：桌面源适配器覆盖，prod 恒缺省
  });
  memberEntries.push(...desktopMembers);
  const desktopIds = new Set(desktopMembers.map((m) => String(m.id).toLowerCase()));

  // 手工名册（v1.2）：members.json 条目并入视图——无 Gitea 缓存/动态也出现；
  // giteaLogin 命中动态 actor（小写精确相等）→ 归因其活动数据（todayCommits/openPrs/lastActivityAt）
  const roster = ctx.membersPath ? store.loadMembers(ctx.membersPath) : [];
  const claimedLogins = new Set(
    roster
      .map((m) => (m && typeof m.giteaLogin === 'string' ? m.giteaLogin.trim().toLowerCase() : ''))
      .filter(Boolean)
  );
  for (const m of roster) {
    // v2.6：与桌面派生成员 id 冲突的手工条目跳过（派生胜出：保活动/会话态，防前端重复 key）
    if (desktopIds.has(String(m.id).toLowerCase())) continue;
    const login = typeof m.giteaLogin === 'string' ? m.giteaLogin.trim() : '';
    const stats = login
      ? memberActivityStats(activities, (actor) => String(actor).toLowerCase() === login.toLowerCase(), now)
      : { todayCommits: 0, lastAct: null, openPRs: [] };
    // v1.2：手工条目同样按 memberId 归领任务，currentTask/status/weekDone 与 agent 同规则推导
    const derived = deriveTaskView(
      tasks.filter((t) => t.memberId === m.id),
      stats.lastAct,
      null
    );
    memberEntries.push({
      id: m.id,
      name: m.name,
      kind: 'human',
      manual: true,
      role: typeof m.role === 'string' ? m.role : '',
      status: derived.status,
      currentTask: derived.currentTask,
      lastActivityAt: derived.lastActivityAt, // v1.4 修订：max(任务 updatedAt, Gitea 动态)
      todayCommits: stats.todayCommits,
      openPrs: stats.openPRs.length,
      weekDone: derived.weekDone,
      session: null,
    });
  }

  // 人类成员 = 手工名册 ∪ Gitea 成员缓存（已被手工名册 giteaLogin 认领的 login 不重复出现）。
  // v2.9.1：动态流 actor 自动派生整条退役（业主指令「动态流 actor 派生的先不接入」）——
  // 组织外/机器人账号（如忘忧、qianqi）不再因推过代码就长成成员；团队动态里仍按
  // 未登记 actor 降级展示（中性图标+账号名），只是不入册。
  // v2.9.2：gitea.ignoreLogins 忽略账号（默认 ["admin"]）——管理员/机器人类组织账号不入册
  // （业主拍板 admin 过滤）；config.json 手改，大小写不敏感。
  const knownAgentIds = new Set([...agents.map((a) => String(a.id).toLowerCase()), ...desktopIds]);
  const ignoreLogins = new Set(
    ((giteaCfg.ignoreLogins || [])).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
  );
  const humans = new Map();
  for (const h of store.loadGiteaMembers(ctx)) {
    if (!h.id) continue;
    const key = String(h.id).toLowerCase();
    if (knownAgentIds.has(key)) continue;
    if (ignoreLogins.has(key)) continue; // 忽略账号（admin 等非干活账号）
    if (claimedLogins.has(key)) continue; // 手工条目已归因该 login，不再输出派生重复项
    humans.set(key, { id: h.id, name: h.name || h.id, role: h.role || '' });
  }

  for (const h of humans.values()) {
    const stats = memberActivityStats(activities, (actor) => String(actor).toLowerCase() === String(h.id).toLowerCase(), now);
    // v1.2：Gitea 派生条目同样按 memberId 归领任务，推导规则与 agent 完全相同
    const derived = deriveTaskView(
      tasks.filter((t) => t.memberId === h.id),
      stats.lastAct,
      null
    );
    memberEntries.push({
      id: h.id,
      name: h.name,
      kind: 'human',
      manual: false,
      role: h.role,
      status: derived.status,
      currentTask: derived.currentTask,
      lastActivityAt: derived.lastActivityAt, // v1.4 修订：max(任务 updatedAt, Gitea 动态)
      todayCommits: stats.todayCommits,
      openPrs: stats.openPRs.length,
      weekDone: derived.weekDone,
      session: null,
    });
  }

  // v2.7 成员日报联动：diaryToday = 该成员名下「进行中」（内置 doing 列）任务当天（服务器本地
  // 今天）是否有日报——供前端标「今日未填」。currentTask/最近产出口径一概不动，仅增此字段。
  // 归领规则与各条目推导路径一致：agent 类条目（桌面源）= agentId 或 memberId 命中；human 类
  // 条目（手工名册 ∪ Gitea 派生）= memberId 命中。
  const withDiaryToday = diaryMod.taskIdsWithDiaryOn(ctx, diaryMod.localYmd());
  for (const entry of memberEntries) {
    const isAgentLike = entry.kind === 'agent';
    const hasDiary = tasks.some((t) => {
      const owned = isAgentLike
        ? t.agentId === entry.id || t.memberId === entry.id
        : t.memberId === entry.id;
      return owned && t.status === 'doing' && withDiaryToday.has(t.id);
    });
    entry.diaryToday = hasDiary;
  }

  return memberEntries;
}

function registerOverviewRoutes(router, ctx) {
  router.add('GET', '/api/overview', (c) => {
    sendJSON(c.res, 200, computeOverview(ctx));
  });
  router.add('GET', '/api/members', (c) => {
    sendJSON(c.res, 200, computeMembers(ctx));
  });
  // 桌面源健康探针（2026-11-03 评审尾巴）：逐源 ok/detail 外显，治「单源故障静默缺席无信号」。
  // 只读轻探（limit:1），与 /api/agent-activity 的 sources[] 相互独立（那条链路本就有健康徽标）
  router.add('GET', '/api/members/source-health', (c) => {
    sendJSON(c.res, 200, collectDesktopSourceHealth(ctx.config && ctx.config.agentActivity, {
      now: Date.now(),
      adapters: ctx.adapters, // 测试注入缝（同 collectDesktopMembers）
    }));
  });
}

module.exports = { registerOverviewRoutes, computeOverview, computeMembers };
