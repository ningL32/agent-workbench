'use strict';

/**
 * lib/research/acceptance.js — 验收材料自动打包（Tier2-①）
 *
 * 验收是 FDE 的"证明时刻":把分散的证据聚合为一份 Markdown 材料包。
 * 输入=人工确认面(任务对象/挂接成果 artifacts/事件流/人工日报)+ 会话净效果
 * (v2.9.70 outcome,经 suggest 阈值候选限流 top3,单会话失败跳过留痕);
 * 启发式归因(activities 模糊匹配)不进材料——与决议⑦同口径从严。
 */

const store = require('../store');
const taskEvents = require('../taskEvents');
const diaryMod = require('../diary');
const sessionSuggest = require('../sessionSuggest');
const { getAgentTranscript } = require('../agentTranscript');
const { HttpError } = require('../router');

function mdEsc(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function buildAcceptancePack(ctx, taskId) {
  const { tasks } = store.loadTasks(ctx);
  const task = tasks.find((t) => t && t.id === taskId);
  if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');

  const diaries = diaryMod
    .loadDiaries(ctx)
    .filter((d) => d.taskId === taskId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const artifacts = (Array.isArray(task.artifacts) ? task.artifacts : [])
    .map((a) => ({ kind: a.kind || 'link', url: a.url || '', title: a.title || a.url || '' }));
  const events = taskEvents.loadEvents(ctx).filter((e) => e.taskId === taskId).slice(-30);

  // 会话净效果:suggest 阈值候选 top3 → 转录 outcome(单会话失败跳过+留痕)
  const sessions = [];
  try {
    const sug = sessionSuggest.suggestSessionsForTask(ctx, taskId, {});
    for (const s of (sug.items || []).slice(0, 3)) {
      try {
        const t = getAgentTranscript(ctx.config, s.ref, {});
        if (!t.degraded && t.outcome) {
          sessions.push({
            agent: t.agent,
            title: t.title,
            toolCalls: t.outcome.toolCalls,
            filesTouched: t.outcome.filesTouched,
            files: t.outcome.files.slice(0, 5),
          });
        }
      } catch (e) {
        console.error(`[acceptance] 会话净效果读取失败(跳过): ${(e && e.message) || e}`);
      }
    }
  } catch (e) {
    console.error(`[acceptance] 会话候选失败(按空处理): ${(e && e.message) || e}`);
  }

  const markdown = renderPack(task, diaries, artifacts, events, sessions);
  return {
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority || 'medium',
      memberId: task.memberId || null,
      acceptorId: task.acceptorId || null,
      completedAt: task.completedAt || null,
      projectDir: task.projectDir || null,
    },
    diaries,
    artifacts,
    events,
    sessions,
    markdown,
  };
}

function renderPack(task, diaries, artifacts, events, sessions) {
  const L = [];
  L.push(`# 验收材料 · ${mdEsc(task.title)}`);
  L.push('');
  L.push(`状态 ${task.status} · 优先级 ${task.priority || 'medium'} · 负责人 ${task.memberId || '-'} · 验收人 ${task.acceptorId || '-'} · ${task.completedAt ? `完成于 ${String(task.completedAt).slice(0, 10)}` : '未完成'}`);
  if (task.desc) L.push('', mdEsc(task.desc));
  L.push('', '## 挂接成果');
  if (artifacts.length) for (const a of artifacts) L.push(`- [${mdEsc(a.kind)}] ${mdEsc(a.title)}${a.url ? ` · ${a.url}` : ''}`);
  else L.push('(无挂接成果)');
  L.push('', '## 会话净效果');
  if (sessions.length) {
    for (const s of sessions) {
      L.push(`- ${mdEsc(s.title)}(${s.agent}):工具调用 ${s.toolCalls} · 涉及文件 ${s.filesTouched}${s.files.length ? `(${s.files.join('、')})` : ''}`);
    }
  } else L.push('(无候选或不可读会话)');
  L.push('', '## 人工日报');
  if (diaries.length) for (const d of diaries) L.push(`- ${d.date}:${mdEsc(String(d.content || '').slice(0, 300))}`);
  else L.push('(无人工日报)');
  L.push('', '## 关键事件(最近 30)');
  for (const e of events) L.push(`- ${e.at} ${e.type}${e.detail ? ` · ${mdEsc(e.detail)}` : ''}`);
  return L.join('\n');
}

module.exports = { buildAcceptancePack };
