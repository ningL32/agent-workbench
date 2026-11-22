'use strict';

/**
 * lib/research/interviews.js — 调研访谈域逻辑（SPEC-RESEARCH §3/§6）
 *
 * 存储：data/research.json 单文件单元（{interviews[], messages[], drafts[]}），
 * 原子写（tmp+rename）沿既有 JSON 单元纪律；SQLite 表为 R3+ kb/FTS 采纳前预置（迁移映射随 R3 补）。
 *
 * 状态机：interview open→closed（关闭停入站）；draft pending→accepted/rejected
 * （accept 校验人工修订后的 payload 并翻转；绑定 task_id 由前端以既有 POST /api/tasks
 * 单写路径创建后调 /link——审计决议①：确认表单以当前状态预填，任务创建不复制第二条写路径）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const prompts = require('./prompts');

function researchFile(ctx) {
  return path.join(ctx.dataDir, 'research.json');
}

function loadResearch(ctx) {
  try {
    const raw = JSON.parse(fs.readFileSync(researchFile(ctx), 'utf8'));
    if (raw && Array.isArray(raw.interviews)) return raw;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[research] research.json 读取失败(按空单元继续): ${(e && e.message) || e}`);
  }
  return { interviews: [], messages: [], drafts: [] };
}

function saveResearch(ctx, data) {
  const file = researchFile(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

// ---------- 访谈 ----------

function createInterview(ctx, { projectDir, sceneTitle }) {
  const data = loadResearch(ctx);
  const now = new Date().toISOString();
  const interview = {
    id: genId('res'),
    projectDir: typeof projectDir === 'string' ? projectDir : '',
    sceneTitle: typeof sceneTitle === 'string' && sceneTitle.trim() ? sceneTitle.trim().slice(0, 120) : '未命名场景',
    status: 'open',
    createdAt: now,
    closedAt: null,
    contextMeta: { gaps: [], kbHits: [] }, // R2 占位:缺口清单/KB 命中随 R3 接入(context_meta 来源标注,审计决议④)
  };
  data.interviews.push(interview);
  saveResearch(ctx, data);
  return interview;
}

function getInterview(ctx, id) {
  const data = loadResearch(ctx);
  return {
    interview: data.interviews.find((i) => i.id === id) || null,
    messages: data.messages.filter((m) => m.interviewId === id),
    drafts: data.drafts.filter((d) => d.interviewId === id),
  };
}

function listInterviews(ctx) {
  const data = loadResearch(ctx);
  const pendingByInterview = {};
  for (const d of data.drafts) {
    if (d.status === 'pending') pendingByInterview[d.interviewId] = (pendingByInterview[d.interviewId] || 0) + 1;
  }
  return data.interviews
    .slice()
    .sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1))
    .map((i) => ({ ...i, pendingDrafts: pendingByInterview[i.id] || 0 }));
}

function closeInterview(ctx, id) {
  const data = loadResearch(ctx);
  const it = data.interviews.find((i) => i.id === id);
  if (!it) return null;
  if (it.status !== 'closed') {
    it.status = 'closed';
    it.closedAt = new Date().toISOString();
    saveResearch(ctx, data); // 关闭只停入站;未决草稿保持 pending 可独立处置（SPEC §6）
  }
  return it;
}

// ---------- 消息 + 上下文组装 + 草稿产出 ----------

function appendMessage(ctx, data, msg) {
  data.messages.push(msg);
}

function redactTail(text, n) {
  const { redact } = require('../redact');
  return redact(String(text || '').slice(-n));
}

/**
 * 处理一条 FDE 发言 → {aiMessage, drafts[]}。llm.js 三通道路由;契约解析失败落
 * system/parse_error 行(审计决议⑥:失败留痕不投毒);paper 模式显式 kind=paper(决议⑤)。
 */
async function postFdeMessage(ctx, cfg, id, text, opts = {}) {
  const data = loadResearch(ctx);
  const it = data.interviews.find((i) => i.id === id);
  if (!it) return null;
  if (it.status !== 'open') {
    const e = new Error('访谈已关闭,不再接收发言');
    e.code = 'INTERVIEW_CLOSED';
    throw e;
  }
  const now = new Date().toISOString();
  const fdeMsg = { id: genId('msg'), interviewId: id, role: 'FDE', kind: 'normal', text: String(text || '').slice(0, 8000), ts: now };
  appendMessage(ctx, data, fdeMsg);

  const asset = prompts.load('research-interview');
  const contextLines = [
    `场景标题: ${it.sceneTitle}`,
    `绑定项目: ${it.projectDir || '(未绑定)'}`,
    `历史沉淀检索: ${JSON.stringify(it.contextMeta.kbHits || [])}`, // R3 接入 kb.search;当前恒空(来源标注,决议④)
  ];
  const history = data.messages.filter((m) => m.interviewId === id).slice(-12);
  const prompt = `${asset.text}\n\n## 当前访谈上下文\n${contextLines.join('\n')}\n\n## 对话历史(最近 ${history.length} 条)\n${history.map((m) => `[${m.role}] ${m.text}`).join('\n')}`;

  let aiRow;
  const produced = [];
  try {
    const r = await require('./llm').chat(cfg, prompt, { timeoutSec: opts.timeoutSec });
    if (r.channel === 'paper') {
      aiRow = { id: genId('msg'), interviewId: id, role: 'AI', kind: 'paper', text: `纸面模式:${r.paperReason}`, llmChannel: 'paper', modelId: '', promptVersion: asset.version, promptSha256: asset.sha256, promptSnapshot: asset.text, ts: new Date().toISOString() };
    } else {
      const parsed = parseContract(r.text);
      if (!parsed) {
        aiRow = { id: genId('msg'), interviewId: id, role: 'system', kind: 'parse_error', text: redactTail(`LLM 返回无法按契约解析(通道 ${r.channel}): ${r.text}`, 400), llmChannel: r.channel, modelId: r.modelId, promptVersion: asset.version, promptSha256: asset.sha256, promptSnapshot: asset.text, ts: new Date().toISOString() };
      } else {
        aiRow = { id: genId('msg'), interviewId: id, role: 'AI', kind: 'normal', text: String(parsed.advice || '').slice(0, 2000), llmChannel: r.channel, modelId: r.modelId, promptVersion: asset.version, promptSha256: asset.sha256, promptSnapshot: asset.text, ts: new Date().toISOString() };
        for (const d of Array.isArray(parsed.drafts) ? parsed.drafts.slice(0, 10) : []) {
          const shape = validateDraftShape(d);
          if (!shape.ok) continue; // 无 quote/超长等不合规草稿:宁缺毋错,不落 pending
          produced.push({
            id: genId('dr'), interviewId: id, payload: shape.value, status: 'pending',
            quote: shape.value.quote, decidedBy: null, decidedAt: null, taskId: null, createdAt: new Date().toISOString(),
          });
        }
      }
    }
  } catch (e) {
    aiRow = { id: genId('msg'), interviewId: id, role: 'system', kind: 'parse_error', text: redactTail(`LLM 调用失败: ${(e && e.message) || e}`, 400), ts: new Date().toISOString() };
  }
  appendMessage(ctx, data, aiRow);
  for (const d of produced) data.drafts.push(d);
  saveResearch(ctx, data);
  return { fdeMessage: fdeMsg, aiMessage: aiRow, drafts: produced };
}

/** 输出契约解析:剥 ```json 围栏,取首个完整 JSON 对象;失败返回 null(调用方留痕) */
function parseContract(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1));
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}

/** 草稿形状校验(创建时即校验——审计:pending 里永远是可收的):title/desc/priority/quote 必备 */
function validateDraftShape(d) {
  if (!d || typeof d !== 'object') return { ok: false };
  const title = typeof d.title === 'string' ? d.title.trim() : '';
  const desc = typeof d.desc === 'string' ? d.desc.trim() : '';
  const quote = typeof d.quote === 'string' ? d.quote.trim() : '';
  const priority = ['high', 'medium', 'low'].includes(d.priority) ? d.priority : 'medium';
  if (!title || title.length > 120) return { ok: false };
  if (!desc || desc.length > 2000) return { ok: false };
  if (!quote || quote.length > 200) return { ok: false };
  return { ok: true, value: { title, desc, priority, quote } };
}

// ---------- 草稿闸门(审计决议①②) ----------

/** accept:校验人工修订后的 payload → 翻转 pending→accepted(单守卫);任务创建走既有 POST /api/tasks 单写路径,由前端持返回的 payload 提交后调 /link 绑定 */
function acceptDraft(ctx, id, payloadEdits, decidedBy) {
  const data = loadResearch(ctx);
  const d = data.drafts.find((x) => x.id === id);
  if (!d) return { error: 'DRAFT_NOT_FOUND' };
  if (d.status !== 'pending') return { error: 'ALREADY_DECIDED' };
  const merged = { ...d.payload, ...(payloadEdits && typeof payloadEdits === 'object' ? payloadEdits : {}) };
  const shape = validateDraftShape(merged);
  if (!shape.ok) return { error: 'FIELD_INVALID', detail: '标题/描述/引用缺失或超长(确认表单应以当前值预填并可改)' };
  d.payload = shape.value;
  d.status = 'accepted';
  d.decidedBy = typeof decidedBy === 'string' ? decidedBy : 'fde';
  d.decidedAt = new Date().toISOString();
  saveResearch(ctx, data);
  return { draft: d };
}

function rejectDraft(ctx, id, reason, decidedBy) {
  const data = loadResearch(ctx);
  const d = data.drafts.find((x) => x.id === id);
  if (!d) return { error: 'DRAFT_NOT_FOUND' };
  if (d.status !== 'pending') return { error: 'ALREADY_DECIDED' };
  d.status = 'rejected';
  d.decidedBy = typeof decidedBy === 'string' ? decidedBy : 'fde';
  d.decidedAt = new Date().toISOString();
  d.rejectReason = String(reason || '').slice(0, 200); // 留痕
  saveResearch(ctx, data);
  return { draft: d };
}

/** link:把既有单写路径创建出的 task 绑回草稿 + research 事件(quote 随事件留痕) */
function linkDraft(ctx, id, taskId) {
  const data = loadResearch(ctx);
  const d = data.drafts.find((x) => x.id === id);
  if (!d) return { error: 'DRAFT_NOT_FOUND' };
  if (d.status !== 'accepted') return { error: 'NOT_ACCEPTED' };
  if (d.taskId) return { error: 'ALREADY_LINKED' };
  d.taskId = String(taskId || '');
  saveResearch(ctx, data);
  return { draft: d };
}

function eligibleCount(ctx) {
  const data = loadResearch(ctx);
  const doneIds = new Set();
  try {
    const store = require('../store');
    const { tasks } = store.loadTasks(ctx);
    for (const t of tasks) if (t.status === 'done') doneIds.add(t.id);
  } catch (e) {
    console.error(`[research] eligible 读取任务失败(按 0 计): ${(e && e.message) || e}`);
  }
  // 可沉淀 = done 且尚未沉淀进 kb 的任务(R3 接 kb_documents 后以沉淀记录去重)
  return doneIds.size;
}

module.exports = {
  loadResearch, saveResearch, createInterview, getInterview, listInterviews, closeInterview,
  postFdeMessage, parseContract, validateDraftShape, acceptDraft, rejectDraft, linkDraft, eligibleCount, genId,
};
