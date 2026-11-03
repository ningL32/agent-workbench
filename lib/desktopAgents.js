'use strict';

/**
 * desktopAgents.js — 桌面 agent 注册表 → 硅基成员派生（v2.6）
 *
 * 业主 2026-10-20：硅基成员从「单一 WorkBuddy」泛化为桌面 agent 注册表四源并列——
 *   workbuddy（~/.workbuddy/workbuddy.db）/ zcode（~/.zcode/cli）/ codex（~/.codex/sessions，
 *   ChatGPT 桌面）/ opencode（~/.local/share/opencode/opencode.db）。
 * 四个适配器全部复用 lib/agentActivity.js 的只读实现（workbuddy/zcode 沿用 v2.2 活动面板
 * 同款适配器——zcode 自 v2.9.14 改读 ~/.zcode/cli/db/db.sqlite session 表，客户端新版
 * 会话落盘 session_<hex32> 家族不再走 sess_* 目录；codex/opencode 为 v2.6 桌面成员册专用适配器）。
 * 开关与路径：config.agentActivity.sources 各源已有的 enabled/root/dbPath 直接生效（不新增配置节）。
 * 纪律：每源独立 try/catch（失败 → 该源缺席，不拖垮其余源与人类名册）；各源只读。
 * hermes：~/.hermes 仅 skills/ 无会话库，本期不做（待考古）。
 */

const {
  normalizeAgentActivity,
  workbuddyAdapter,
  zcodeAdapter,
  codexAdapter,
  opencodeAdapter,
  hermesAdapter,
} = require('./agentActivity');
const { redact } = require('./redact');

/** 注册顺序即成员册输出顺序（workbuddy 保留 v2.5 既有路径与语义；hermes 2026-11-03 第七源入册） */
const DESKTOP_SOURCES = [
  { id: 'workbuddy', name: 'WorkBuddy', adapter: workbuddyAdapter },
  { id: 'zcode', name: 'ZCode', adapter: zcodeAdapter },
  { id: 'codex', name: 'Codex (ChatGPT 桌面)', adapter: codexAdapter },
  { id: 'opencode', name: 'OpenCode', adapter: opencodeAdapter },
  { id: 'hermes', name: 'Hermes', adapter: hermesAdapter },
];

/**
 * collectDesktopMembers(agentActivityCfg, deps)
 *   agentActivityCfg：ctx.config.agentActivity（可为 null/缺节，内部回默认）；
 *   deps：{ now, tasks, deriveTaskView, adapters }（deriveTaskView 由 overview.computeMembers 闭包注入，
 *         桌面成员与人类成员共用同一套 当前任务/status/weekDone 推导；adapters 为源适配器覆盖表
 *         { id: fn }，测试注入缝——AGENTS.md 坑 5 sqlite 夹具拦截的绕开路径，prod 恒缺省）。
 * → 成员条目数组（字段形状与 v2.5 workbuddy 派生条目一致，另加 source 字段标注桌面来源）。
 * 「当前任务/最近工作」归因：任务 agentId/memberId 精确等于源 id（'zcode'/'codex' 等）即命中——
 * 沿用 v2.5 workbuddy 的归因写法推广到四源。
 */
function collectDesktopMembers(agentActivityCfg, deps) {
  const d = deps || {};
  const now = d.now || Date.now();
  const tasks = Array.isArray(d.tasks) ? d.tasks : [];
  const deriveTaskView = typeof d.deriveTaskView === 'function' ? d.deriveTaskView : null;
  const sec = normalizeAgentActivity(
    agentActivityCfg !== null && typeof agentActivityCfg === 'object' ? agentActivityCfg : null
  );
  if (sec.enabled === false || deriveTaskView === null) return [];

  const entries = [];
  const overrides = d.adapters && typeof d.adapters === 'object' ? d.adapters : {};
  for (const src of DESKTOP_SOURCES) {
    const s = sec.sources[src.id] || {};
    if (s.enabled === false) continue;
    try {
      const adapterFn = overrides[src.id] || src.adapter;
      const r = adapterFn(s, { limit: sec.perSourceLimit, previewChars: sec.previewChars, now });
      const latest = (Array.isArray(r.items) && r.items[0]) || null; // 各源取最近会话代表该 agent
      if (!latest) continue;
      const alive = latest.state === 'active';
      const lastAct = Date.parse(latest.lastActiveAt) || null;
      const myTasks = tasks.filter((t) => t.agentId === src.id || t.memberId === src.id);
      const derived = deriveTaskView(myTasks, lastAct, { alive });
      entries.push({
        id: src.id,
        name: src.name,
        kind: 'agent',
        manual: false,
        role: '桌面 Agent',
        status: derived.status,
        currentTask: derived.currentTask,
        lastActivityAt: derived.lastActivityAt,
        todayCommits: 0, // 桌面 agent 无 Gitea 身份，提交/PR 统计恒 0（活动观测在「智能体动态」面板）
        openPrs: 0,
        weekDone: derived.weekDone,
        session: { id: latest.id || src.id, alive },
        source: src.id, // v2.6：标注桌面来源
      });
    } catch (e) {
      // 单源故障隔离：该源跳过不报错，不影响其余源与人类名册；但必须留痕（红线 8，禁空 catch）
      console.error(redact(`[desktopAgents] 源 ${src.id} 成员派生失败（该源成员缺席）: ${(e && e.message) || e}`));
    }
  }
  return entries;
}

/**
 * collectDesktopSourceHealth(agentActivityCfg, deps) — 桌面源健康探针（GET /api/members/source-health）。
 * 逐源跑 adapter（limit:1 轻探，adapters 覆盖表同 collectDesktopMembers 注入缝），返回逐源
 * {id,name,enabled,ok,detail,scannedAt}：关闭源 ok=null（不计入分母）；故障源 ok:false 带 detail——
 * 治「单源故障静默缺席无信号」（评审尾巴：红线 8 现状反例 desktopAgents 空 catch 的可见性配套）。
 */
function collectDesktopSourceHealth(agentActivityCfg, deps) {
  const d = deps || {};
  const now = d.now || Date.now();
  const sec = normalizeAgentActivity(
    agentActivityCfg !== null && typeof agentActivityCfg === 'object' ? agentActivityCfg : null
  );
  const overrides = d.adapters && typeof d.adapters === 'object' ? d.adapters : {};
  const scannedAt = new Date(now).toISOString();
  return DESKTOP_SOURCES.map((src) => {
    const s = sec.sources[src.id] || {};
    if (s.enabled === false || sec.enabled === false) {
      return { id: src.id, name: src.name, enabled: false, ok: null, detail: '已关闭（设置页可开）', scannedAt };
    }
    try {
      const adapterFn = overrides[src.id] || src.adapter;
      const r = adapterFn(s, { limit: 1, previewChars: 0, now });
      const ok = !!(r && r.ok !== false);
      return { id: src.id, name: src.name, enabled: true, ok, detail: (r && r.detail) || (ok ? '正常' : '失败'), scannedAt };
    } catch (e) {
      return { id: src.id, name: src.name, enabled: true, ok: false, detail: redact(String((e && e.message) || e)), scannedAt };
    }
  });
}

module.exports = { DESKTOP_SOURCES, collectDesktopMembers, collectDesktopSourceHealth };
