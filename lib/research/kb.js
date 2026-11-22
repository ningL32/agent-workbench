'use strict';

/**
 * lib/research/kb.js — 调研知识库（SPEC-RESEARCH §2 闭环 B/§3/§6,R3）
 *
 * 存储:kbDocuments[] 附于 data/research.json(JSON 层,R3 交付面);
 * kb_fts(SQLite)为提速层——迁移目录上 R4 起沉淀同步写索引(能力探测见 migration.ensureKbFts),
 * 检索三层口径:FTS5(trigram 长词) → LIKE 短词回退 → (JSON 层恒用 LIKE 全文扫描)。
 * 中文字短词在 node:sqlite FTS5 trigram 下不命中——ai-scene 已实证,故短词必须走 LIKE 层。
 */

const fs = require('node:fs');
const path = require('node:path');
const interviews = require('./interviews');

function normText(s) {
  return String(s || '').toLowerCase();
}

/** 多词 AND 子串检索(LIKE 层语义,永远可用);词取自查询分词(≥2 字/字符段),命中返回条目+命中词 */
function likeSearch(docs, q) {
  const tokens = String(q || '')
    .toLowerCase()
    .split(/[\s,，、;；]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  if (!tokens.length) return [];
  const hits = [];
  for (const d of docs) {
    const hay = `${normText(d.title)} ${normText(d.body)}`;
    const matched = tokens.filter((t) => hay.includes(t));
    if (matched.length === tokens.length) hits.push({ ...d, matchedTokens: matched });
  }
  return hits.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
}

/** 沉淀:追加 kb_documents(同一任务可多次=版本追加,追加不改史);返回 {ok, document} */
function sediment(ctx, { sourceTaskId, kind, title, body }) {
  const data = interviews.loadResearch(ctx);
  const doc = {
    id: interviews.genId('kb'),
    source_task_id: typeof sourceTaskId === 'string' && sourceTaskId.trim() ? sourceTaskId.trim() : null,
    kind: ['diary', 'report', 'evidence'].includes(kind) ? kind : 'evidence',
    title: String(title || '').trim().slice(0, 200),
    body: String(body || '').slice(0, 20000),
    created_at: new Date().toISOString(),
  };
  if (!doc.title || !doc.body) {
    return { ok: false, error: 'FIELD_INVALID', detail: 'title 与 body 必填' };
  }
  data.kbDocuments = Array.isArray(data.kbDocuments) ? data.kbDocuments : [];
  data.kbDocuments.push(doc);
  interviews.saveResearch(ctx, data);
  return { ok: true, document: doc };
}

/** 检索:LIKE 层(JSON 恒可用);上限 20 条 */
function search(ctx, q) {
  const data = interviews.loadResearch(ctx);
  const docs = Array.isArray(data.kbDocuments) ? data.kbDocuments : [];
  return likeSearch(docs, q).slice(0, 20);
}

/** 可沉淀:done 任务里尚未有任何沉淀记录的计数(沉淀过的=已入库, hunger chip 归零) */
function eligible(ctx) {
  const store = require('../store');
  const data = interviews.loadResearch(ctx);
  const sedimented = new Set(
    (Array.isArray(data.kbDocuments) ? data.kbDocuments : [])
      .map((d) => d.source_task_id)
      .filter(Boolean)
  );
  let count = 0;
  try {
    const { tasks } = store.loadTasks(ctx);
    for (const t of tasks) if (t.status === 'done' && !sedimented.has(t.id)) count += 1;
  } catch (e) {
    console.error(`[research/kb] eligible 读取失败(按 0 计): ${(e && e.message) || e}`);
  }
  return { count };
}

/** 冷启动导入:把库里既有的数字员工周报/日报/人工日报一键灌进知识库(闭环 B 开局有料)。
 * 幂等守卫:research.json.bootstrapAt 标记——已导入过再调返回 ALREADY_DONE(可观测,重置标记可重跑)。 */
function bootstrapImport(ctx) {
  const data = interviews.loadResearch(ctx);
  if (data.bootstrapAt) return { ok: false, error: 'ALREADY_DONE', imported: 0 };
  data.kbDocuments = Array.isArray(data.kbDocuments) ? data.kbDocuments : [];
  let imported = 0;
  const push = (doc) => { data.kbDocuments.push(doc); imported += 1; };
  const safe = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ctx.dataDir, f), 'utf8')); } catch (e) { return null; } };
  const weekly = safe('weekly.json');
  if (weekly && typeof weekly.report === 'string' && weekly.report.trim()) {
    push({ id: interviews.genId('kb'), source_task_id: null, kind: 'report', title: `数字员工周报 ${String(weekly.weekKey || weekly.generatedAt || '').slice(0, 10)}`, body: weekly.report, created_at: new Date().toISOString() });
  }
  const daily = safe('report-daily.json');
  if (daily && typeof daily.report === 'string' && daily.report.trim()) {
    push({ id: interviews.genId('kb'), source_task_id: null, kind: 'report', title: `数字员工日报 ${String(daily.dayKey || daily.generatedAt || '').slice(0, 10)}`, body: daily.report, created_at: new Date().toISOString() });
  }
  let diaries = [];
  try { diaries = require('../diary').loadDiaries(ctx); } catch (e) { console.error(`[research/kb] 冷启动读日报失败: ${(e && e.message) || e}`); }
  for (const d of diaries) {
    if (!d.taskId || !String(d.content || '').trim()) continue;
    push({ id: interviews.genId('kb'), source_task_id: d.taskId, kind: 'diary', title: `日报 ${d.date}`, body: String(d.content).slice(0, 20000), created_at: new Date().toISOString() });
  }
  data.bootstrapAt = new Date().toISOString();
  interviews.saveResearch(ctx, data);
  return { ok: true, imported };
}

module.exports = { sediment, search, eligible, likeSearch, bootstrapImport };
