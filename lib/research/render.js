'use strict';

/**
 * lib/research/render.js — 场景交付产物渲染（SPEC-RESEARCH §2 闭环 C,R4）
 *
 * ★输入纯度铁律（审计决议⑦）：本模块只吃**人工确认面**数据——看板任务结构（tasks）、
 * 人工日报（diary）、验收签字（acceptorId/completedAt）；启发式归因数据（activities 模糊
 * 匹配）禁止流入客户产物。同输入 → 字节级确定（输出不含 Date.now()）。
 */

const store = require('../store');
const diaryMod = require('../diary');

function escXml(s) {
  return String(s || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 场景的人工确认面数据集：该 projectDir 下全部看板任务(创建序) + 各任务人工日报 */
function collectSceneData(ctx, projectDir) {
  const { tasks } = store.loadTasks(ctx);
  const scene = tasks
    .filter((t) => (t.projectDir || '') === projectDir)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const diaries = {};
  for (const t of scene) {
    try {
      const list = diaryMod.loadDiaries(ctx).filter((d) => d.taskId === t.id);
      diaries[t.id] = list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    } catch (e) {
      diaries[t.id] = []; // 日报读失败按空(留痕在 diary 层,此处不吞任务)
    }
  }
  return { scene, diaries };
}

/**
 * BPMN 2.0 XML:单泳道顺序流程——场景任务按创建序排布,相邻任务 sequenceFlow 相连;
 * done 任务附完成日期 documentation。文本全部 escXml,剔除非法控制字符;字节级确定。
 */
function renderBpmn(sceneData) {
  const { scene } = sceneData;
  const laneTasks = scene
    .map((t, i) => {
      const docs = [];
      if (t.status === 'done' && t.completedAt) docs.push(`验收完成 ${String(t.completedAt).slice(0, 10)}`);
      if (t.priority && t.priority !== 'medium') docs.push(`优先级 ${t.priority}`);
      const doc = docs.length
        ? `\n        <bpmn:documentation>${escXml(docs.join(';'))}</bpmn:documentation>`
        : '';
      return `    <bpmn:task id="Task_${i + 1}" name="${escXml(t.title)}">${doc}\n    </bpmn:task>`;
    })
    .join('\n');
  const flows = scene
    .slice(1)
    .map((_, i) => `    <bpmn:sequenceFlow id="Flow_${i + 1}" sourceRef="Task_${i + 1}" targetRef="Task_${i + 2}" />`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://fde-workbench.local/research">
  <bpmn:process id="Scene_Process" isExecutable="false">
${laneTasks}
${flows}
  </bpmn:process>
</bpmn:definitions>
`;
}

/** 交付报告 Markdown:场景总览 + 任务与验收(人工日报并入)+ 沉淀记录引用 */
function renderReport(sceneData, projectDir) {
  const { scene, diaries } = sceneData;
  const lines = [];
  lines.push(`# 场景交付报告 · ${projectDir || '(未绑定项目)'}`);
  lines.push('');
  lines.push(`任务数 ${scene.length} · 已完成 ${scene.filter((t) => t.status === 'done').length} · 逾期 ${scene.filter((t) => String(t.dueDate || '') < todayYmd() && t.status !== 'done').length}`);
  lines.push('');
  lines.push('## 任务与验收');
  lines.push('');
  lines.push('| 任务 | 状态 | 负责人 | 验收人 | 完成 | 优先级 |');
  lines.push('|---|---|---|---|---|---|');
  for (const t of scene) {
    lines.push(`| ${mdEsc(t.title)} | ${mdEsc(t.status)} | ${mdEsc(t.memberId || '-')} | ${mdEsc(t.acceptorId || '-')} | ${t.completedAt ? mdEsc(String(t.completedAt).slice(0, 10)) : '-'} | ${mdEsc(t.priority || 'medium')} |`);
  }
  lines.push('');
  lines.push('## 人工日报(按任务)');
  lines.push('');
  let anyDiary = false;
  for (const t of scene) {
    for (const d of diaries[t.id] || []) {
      anyDiary = true;
      lines.push(`- **${mdEsc(t.title)}** · ${mdEsc(d.date)}:${mdEsc(String(d.content || '').slice(0, 300))}`);
    }
  }
  if (!anyDiary) lines.push('(本场景暂无人工日报)');
  lines.push('');
  return lines.join('\n');
}

function mdEsc(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function todayYmd() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

/** 场景导出入口:format=bpmn|report;输入只含人工确认面(铁律) */
function exportScene(ctx, projectDir, format) {
  const sceneData = collectSceneData(ctx, projectDir);
  if (format === 'bpmn') return { contentType: 'application/xml', body: renderBpmn(sceneData) };
  return { contentType: 'text/markdown; charset=utf-8', body: renderReport(sceneData, projectDir) };
}

module.exports = { exportScene, renderBpmn, renderReport, collectSceneData, escXml };
