'use strict';

/**
 * lib/research/progress.js — 客户只读进度页（Tier2-②）
 *
 * 自包含静态 HTML(内联样式零外链,可存档/发客户);输入仅人工确认面
 * (任务结构/验收人/完成日期/人工日报——决议⑦同口径);BPMN 链接指向导出端点。
 * 全文 esc,不含任何凭据/内部观测细节。
 */

const { collectSceneData } = require('./render');

const escHtml = (s) =>
  String(s || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function renderProgressPage(ctx, projectDir) {
  const { scene, diaries } = collectSceneData(ctx, projectDir);
  const done = scene.filter((t) => t.status === 'done').length;
  const overdue = scene.filter((t) => t.status !== 'done' && typeof t.dueDate === 'string' && t.dueDate < t._today).length;
  const pct = scene.length ? Math.round((done / scene.length) * 100) : 0;
  const rows = scene
    .map(
      (t) => `      <tr>
        <td>${escHtml(t.title)}</td>
        <td><span class="badge b-${escHtml(t.status)}">${escHtml(t.status)}</span></td>
        <td>${escHtml(t.memberId || '-')}</td>
        <td>${escHtml(t.acceptorId || '-')}</td>
        <td>${t.completedAt ? escHtml(String(t.completedAt).slice(0, 10)) : (t.dueDate ? escHtml(t.dueDate) : '-')}</td>
      </tr>`
    )
    .join('\n');
  const diaryList = scene
    .flatMap((t) => (diaries[t.id] || []).map((d) => `      <li><b>${escHtml(t.title)}</b> · ${escHtml(d.date)}: ${escHtml(String(d.content || '').slice(0, 200))}</li>`))
    .join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>项目进度 · ${escHtml(projectDir || '(未绑定)')}</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; margin: 24px auto; max-width: 860px; color: #1f2937; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 24px; }
  .bar { background: #e5e7eb; border-radius: 6px; height: 14px; overflow: hidden; margin: 8px 0 4px; }
  .bar i { display: block; height: 100%; background: #2563eb; }
  .muted { color: #6b7280; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 6px; text-align: left; }
  .badge { padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .b-done { background: #dcfce7; color: #166534; }
  .b-doing { background: #dbeafe; color: #1e40af; }
  .b-review { background: #fef9c3; color: #854d0e; }
  .b-todo { background: #f3f4f6; color: #374151; }
</style>
</head>
<body>
  <h1>项目进度 · ${escHtml(projectDir || '(未绑定)')}</h1>
  <p class="muted">生成于 ${escHtml(new Date().toISOString().slice(0, 16).replace('T', ' '))} · 只读快照,数据来自工作台账人工确认记录</p>
  <div class="bar"><i style="width:${pct}%"></i></div>
  <p class="muted">完成 ${done}/${scene.length}(${pct}%)${overdue ? ` · 逾期 ${overdue}` : ''}</p>
  <h2>任务与验收</h2>
  <table>
    <thead><tr><th>任务</th><th>状态</th><th>负责人</th><th>验收人</th><th>完成/截止</th></tr></thead>
    <tbody>
${rows || '      <tr><td colspan="5" class="muted">该场景暂无任务</td></tr>'}
    </tbody>
  </table>
  <h2>进展记录</h2>
  <ul>
${diaryList || '      <li class="muted">暂无进展记录</li>'}
  </ul>
</body>
</html>
`;
}

module.exports = { renderProgressPage };
