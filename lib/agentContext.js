'use strict';

/**
 * agentContext.js — v2.9.27 Agent 上下文注入（数字员工互知）
 *
 * 「让 ZCode 知道 Codex 昨晚在这个项目干了什么」：把近 N 天各 agent 会话聚合为一份
 * .fde/daily.md 落在项目根，agent 会话启动自动读到（AGENTS.md/上下文发现机制）。
 *
 * 安全边界（红线级）：
 *  - 只写 config.agentContext.dirs 白名单里显式列出的目录（绝不写会话数据里出现的任意路径）；
 *  - 写文件固定名 .fde/daily.md，先 mkdir -p <dir>/.fde 再原子写（tmp+rename）；
 *  - enabled !== true 时 buildAgentContext 仍可用（只读聚合），writeAgentContext 直接 no-op；
 *  - 内容全部来自六源标题（已在 listAgentSessions 内 redact），再过一道 redact。
 */

const fs = require('node:fs');
const path = require('node:path');
const at = require('./agentTranscript');
const snapshot = require('./sessionSnapshot');
const redactMod = require('./redact');

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_DAYS = 1;
const MAX_DAYS = 7;
const FILE_NAME = '.fde/daily.md';
const PER_PROJECT_CAP = 40; // 每项目最多列 40 条会话（防长项目刷屏）

function redactText(t) {
  try {
    return redactMod.redact(t);
  } catch (e) {
    return String(t);
  }
}

function normalizeKey(p) {
  return String(p || '').trim().replace(/[\\/]+$/, '').toLowerCase().replace(/[\\/]+/g, '\\');
}

/**
 * buildAgentContext(config, opts) → {projects:[{dir, days, agents:[{agent, label, sessions:[{title,at}]}], total}]}
 * 数据面=listAgentSessions（每源 50 条帽），按 projectId 归一聚合、只保留 dirs 白名单内的项目。
 * @param {{days?:number, now?:number, adapters?:object}} opts adapters=纯注入模式（同 heatmap 语义）
 */
function buildAgentContext(config, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const days = Math.min(Math.max(Number(o.days) || DEFAULT_DAYS, 1), MAX_DAYS);
  const sinceMs = now - days * DAY_MS;
  const sec = (config && config.agentContext) || {};
  const whitelist = (Array.isArray(sec.dirs) ? sec.dirs : []).map(normalizeKey).filter(Boolean);
  // v2.9.29 D3：六源会话统一走 sessionSnapshot（adapters 纯注入语义不变）
  const { byAgent: snapByAgent } = snapshot.getSnapshot(config, { now, adapters: o.adapters });

  const byProject = new Map(); // normDir -> {dir, agents: Map(agent -> [{title,at}])}
  for (const agent of at.SOURCE_IDS) {
    for (const it of snapByAgent[agent] || []) {
      const at2 = Date.parse(it.lastActiveAt);
      if (!Number.isFinite(at2) || at2 < sinceMs) continue;
      const norm = normalizeKey(it.projectId);
      if (!norm || !whitelist.includes(norm)) continue; // 白名单外零写入依据
      if (!byProject.has(norm)) byProject.set(norm, { dir: it.projectId, agents: new Map() });
      const rec = byProject.get(norm);
      if (!rec.agents.has(agent)) rec.agents.set(agent, []);
      const list = rec.agents.get(agent);
      if (list.length >= PER_PROJECT_CAP) continue;
      list.push({ title: String(it.title || '（未命名会话）'), at: it.lastActiveAt });
    }
  }

  const projects = [...byProject.values()].map((rec) => ({
    dir: rec.dir,
    agents: [...rec.agents].map(([agent, sessions]) => ({
      agent,
      sessions: sessions.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))),
    })),
    total: [...rec.agents.values()].reduce((n, s) => n + s.length, 0),
  })).sort((a, b) => b.total - a.total);

  return { projects, days, generatedAt: new Date(now).toISOString() };
}

/** 聚合结果 → markdown 文本（agent 会话启动可读的战况简报；HTML 元字符转义——.md 虽由 LLM 消费仍纵深防御） */
function renderMarkdown(ctxResult) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [
    '# Agent 战况简报（FDE 指挥台自动生成）',
    '',
    `> 生成于 ${ctxResult.generatedAt} · 覆盖最近 ${ctxResult.days} 天（每源计最近 50 条会话） · 数据只读本机六源会话，本文件供 agent 会话启动时了解其他 agent 近期工作。`,
    '',
  ];
  if (!ctxResult.projects.length) {
    lines.push('（白名单项目近 ' + ctxResult.days + ' 天无 agent 会话活动。）', '');
    return lines.join('\n');
  }
  const LABEL = { zcode: 'ZCode', claude: 'Claude Code', dsh: 'DSH', workbuddy: 'WorkBuddy', codex: 'Codex', opencode: 'OpenCode' };
  for (const p of ctxResult.projects) {
    lines.push(`## ${p.dir}`, '');
    for (const a of p.agents) {
      lines.push(`### ${LABEL[a.agent] || a.agent}（${a.sessions.length} 条）`, '');
      for (const s of a.sessions) {
        const t = String(s.at || '').replace('T', ' ').slice(0, 16);
        lines.push(`- ${t} ${esc(redactText(s.title).replace(/\s+/g, ' ').slice(0, 100))}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * writeAgentContext(config, opts) → {written:[{dir,file}], skipped:[{dir,reason}]}
 * 只写 enabled===true 且 dirs 白名单内的目录；单目录失败跳过不拖垮（EPERM 容忍）。
 */
function writeAgentContext(config, opts) {
  const o = opts || {};
  const sec = (config && config.agentContext) || {};
  if (sec.enabled !== true) return { written: [], skipped: [{ dir: '(all)', reason: 'agentContext.enabled !== true' }] };
  const result = buildAgentContext(config, o);
  const md = renderMarkdown(result);
  const written = [];
  const skipped = [];
  for (const dirRaw of Array.isArray(sec.dirs) ? sec.dirs : []) {
    const dir = String(dirRaw || '').trim();
    if (!dir) continue;
    const hasActivity = result.projects.some((p) => normalizeKey(p.dir) === normalizeKey(dir));
    if (!hasActivity) {
      skipped.push({ dir, reason: '近窗无会话活动（不写空文件）' });
      continue;
    }
    try {
      const target = path.join(dir, '.fde');
      fs.mkdirSync(target, { recursive: true });
      const file = path.join(target, 'daily.md');
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, md, 'utf8');
      fs.renameSync(tmp, file);
      written.push({ dir, file });
    } catch (e) {
      skipped.push({ dir, reason: String((e && e.message) || e) });
    }
  }
  return { written, skipped };
}

module.exports = { buildAgentContext, renderMarkdown, writeAgentContext, normalizeKey, FILE_NAME, DEFAULT_DAYS, MAX_DAYS };
