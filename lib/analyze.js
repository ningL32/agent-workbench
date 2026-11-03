'use strict';

/**
 * analyze.js — AI 拆解管线（PRD 任务雷达 §5）
 *
 * 引擎调用形态（2026-10-18 阶段 0 真机实测）：
 *   node <dshBin> --profile headless <prompt>          —— dsh 是 npm .cmd shim，
 *   直 spawn node + bin.js 绕开 cmd.exe（零 shell、零注入面、绕开 8191 cmd 行长限制；
 *   Windows CreateProcess 上限 32767 UTF-16，实测 27K 中文 prompt 通过）。
 *   dsh headless 无 stdin/无 system 旗标 → 纯 JSON 靠 prompt 约束 + 后处理提取双保险。
 *   实测耗时 12~21s/条（GLM glm-5.3-flash 路由）→ 批量走异步 job，立即 202 + 进度可查。
 *
 * fixture：DSH_FIXTURE 指向的文件内容（原样文本）替代引擎 stdout（测试全离线）。
 *
 * 输出契约：{tasks:[{title,desc,priority,suggestedMemberId,dueHint,confidence,quote,rationale}],
 *           taskUpdates:[{existingTaskId,quote,note,confidence}], noise:[{quote,reason}]}
 * - v1.9 查重分诊：纪要内容对看板已有任务的讨论/进展/变更 → 产 taskUpdates（更新提案，
 *   含原文引用），不再走「疑似重复降置信度」老路；全新事项照常产 tasks；
 *   tasks + taskUpdates 合计 ≤ maxTasksPerMessage，按置信度合并截断
 * - 解析失败重试一次，再失败该纪要标记 ANALYZE_FAILED 可重试（PRD §5）
 * - 引擎超时缺省 300s；对已失败纪要的重试自动升压 ×2（P1-B，job 记录 attempt/timeoutSec）
 * - 说话人映射用聚合名册（store.aggregateRoster：手工 ∪ Gitea 缓存）四优先级匹配，
 *   候选卡带 matchSource（alias/name/gitea）归人依据（P1-A）
 * - confidence < 0.5 不产出候选 → noise（PRD §5 置信度规则）
 * - 单纪要候选 ≤ maxTasksPerMessage（缺省 10），按置信度截断
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const store = require('./store');
const { HttpError, sendJSON } = require('./router');
const { redact } = require('./redact');
const jobsMod = require('./jobs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const PRIORITIES = new Set(['high', 'medium', 'low', 'unset']);

// ------------------------------------------------------------------ dsh CLI

let dshBinCache = null;

/** 解析 dsh 的 node 入口 bin.js：config.analyze.dshBin → %APPDATA%\npm\...；全败 null */
function resolveDshBin(cfg) {
  const configured = cfg && cfg.analyze && typeof cfg.analyze.dshBin === 'string' && cfg.analyze.dshBin.trim();
  if (configured) {
    const p = path.resolve(configured);
    if (fs.existsSync(p)) return p;
    return null; // 显式配置了但不存在 → 不再兜底（配置错误应显性暴露）
  }
  if (dshBinCache && fs.existsSync(dshBinCache)) return dshBinCache;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const fallback = path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(fallback)) {
    dshBinCache = fallback;
    return fallback;
  }
  return null;
}

function fixtureFile() {
  const p = process.env.DSH_FIXTURE;
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

/** DSH_FIXTURE 模式：文件原样文本即引擎 stdout */
function runHeadlessFixture() {
  const file = fixtureFile();
  if (!file) return null;
  return fs.readFileSync(file, 'utf8');
}

/**
 * 真实引擎调用：node <dshBin> --profile headless <prompt>，返回 stdout 文本。
 * 独立导出供 /api/radar/engine/test 复用。opts.timeoutSec 可覆盖配置超时（P1-B 重试升压用）。
 */
function runHeadless(cfg, prompt, opts = {}) {
  const dshBin = resolveDshBin(cfg);
  if (!dshBin) {
    throw new HttpError(502, 'DSH_NOT_FOUND', '未找到 dsh 引擎入口（config.analyze.dshBin 或 %APPDATA%\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js）');
  }
  const timeoutSec = Number(opts && opts.timeoutSec) || Number(cfg.analyze && cfg.analyze.timeoutSec) || 300;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [dshBin, '--profile', 'headless', prompt],
      // 桌面宿主里 process.execPath 是 Electron 主程序，且 env 不带 ELECTRON_RUN_AS_NODE：
      // 不强制这一位会把「拆解」变成「又开一个 DSH 窗口」而不是跑 headless。纯 node 下该变量被忽略。
      { timeout: timeoutSec * 1000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (err, stdout, stderr) => {
        if (err) {
          const reason = err.killed || err.signal === 'SIGTERM' ? `超时（>${timeoutSec}s）` : (err.message || String(err));
          return reject(Object.assign(new Error(redact(`dsh 执行失败: ${reason} ${String(stderr || '').slice(0, 200)}`)), { code: 'DSH_ERROR' }));
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

// ------------------------------------------------------------- prompt 构造

/**
 * 说话人 raw → {id, source}（v1.5 goose 验收 P1-A：聚合名册四优先级匹配）。
 * roster = store.aggregateRoster(ctx) 快照（无 source 字段的条目按 manual 处理，兼容旧夹具）：
 *   ① 手工 alias 精确（source 'alias'）
 *   ② 手工 name 精确（'name'）
 *   ③ gitea login(id)/name 精确（'gitea'）
 *   ④ 全部字段小写双向包含（raw 与字段均 ≥2 字，防单字误伤），仍按 ①②③ 来源优先
 * 未命中返回 null。
 */
function resolveSpeaker(raw, roster) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  const norm = (v) => String(v || '').trim().toLowerCase();
  const srcOf = (m) => (m && m.source === 'gitea' ? 'gitea' : 'manual');
  const manual = roster.filter((m) => srcOf(m) === 'manual');
  const gitea = roster.filter((m) => srcOf(m) === 'gitea');
  // 双向包含且两边 ≥2 字（v1.5 P1-A：小写包含匹配，单字不上包含档防误伤）
  const containsLoose = (field, k) => field.length >= 2 && (field.includes(k) || k.includes(field));
  for (const m of manual) {
    if ((m.aliases || []).some((a) => norm(a) === key)) return { id: m.id, source: 'alias' };
  }
  for (const m of manual) {
    if (norm(m.name) === key) return { id: m.id, source: 'name' };
  }
  for (const m of gitea) {
    if (norm(m.id) === key || norm(m.name) === key) return { id: m.id, source: 'gitea' };
  }
  if (key.length >= 2) {
    for (const m of manual) {
      if ((m.aliases || []).some((a) => containsLoose(norm(a), key))) return { id: m.id, source: 'alias' };
    }
    for (const m of manual) {
      if (containsLoose(norm(m.name), key)) return { id: m.id, source: 'name' };
    }
    for (const m of gitea) {
      if (containsLoose(norm(m.id), key) || containsLoose(norm(m.name), key)) return { id: m.id, source: 'gitea' };
    }
  }
  return null;
}

/** 说话人 raw → 成员 id：聚合名册四优先级（见 resolveSpeaker）；未命中 null（旧接口形状） */
function mapSpeaker(raw, roster) {
  const hit = resolveSpeaker(raw, roster);
  return hit ? hit.id : null;
}

/** 说话人分段文本行：【raw|memberId】text；memberId 已由别名预匹配解析（未识别 "-"） */
function transcriptLines(message, roster) {
  const lines = [];
  for (const seg of message.speakerSegments || []) {
    const mid = mapSpeaker(seg.raw, roster) || '-';
    lines.push(`【${seg.raw}|${mid}】${seg.text}`);
  }
  return lines.join('\n');
}

/** 组 prompt（PRD §5：置信度规则 + few-shot + 防重清单 + 名册；只输出 JSON） */
function buildPrompt(message, roster, boardTasks, cfg) {
  const maxTasks = Number(cfg.analyze && cfg.analyze.maxTasksPerMessage) || 10;
  const maxChars = Number(cfg.analyze && cfg.analyze.maxPromptChars) || 24000;

  let transcript = transcriptLines(message, roster);
  let truncated = false;
  if (transcript.length > maxChars) {
    transcript = transcript.slice(0, maxChars) + '\n【已截断：超出长度上限】';
    truncated = true;
  }

  const rosterLines = roster
    .map((m) => {
      const aliases = Array.isArray(m.aliases) && m.aliases.length ? `（别名: ${m.aliases.join('/')}）` : '';
      return `- ${m.id} | ${m.name}${aliases}`;
    })
    .join('\n') || '（名册为空）';

  const boardLines = (boardTasks || [])
    .map((t) => `- ${t.id} | [${t.status}] ${t.title}`)
    .join('\n') || '（看板当前没有任务）';

  return `你是任务拆解引擎。从会议逐字稿中识别"待办任务"与"对已有任务的更新"，只输出一个 JSON 对象，禁止输出任何其他文字、解释或 markdown 代码块围栏。

# 输出 schema
{"tasks":[{"title":"","desc":"","priority":"high|medium|low|unset","suggestedMemberId":"","dueHint":"","confidence":0.0,"quote":"","rationale":""}],"taskUpdates":[{"existingTaskId":"","quote":"","note":"","confidence":0.0}],"noise":[{"quote":"","reason":""}]}

# 置信度规则（严格遵守；tasks 与 taskUpdates 适用同一规则）
- 0.9 以上：明确动作 + 明确负责人 + 明确时间
- 0.7 到 0.9：明确动作，负责人或时间模糊
- 0.5 到 0.7：推断性表述（如"这个后面得弄"）
- 低于 0.5：tasks 与 taskUpdates 均不产出，归入 noise

# 判定正反例
- 寒暄、过程性发言 ✗
- "我看看" ✗（无明确动作与交付物）
- "周五前给我" ✓
- "@小王 把部署文档更新下" ✓
- 同一工程的连续子步骤（整理清单→写 SOP→建模板）✗ 逐条拆成多张（合成一张，desc 列步骤）
- 对已有任务的跟进讨论（如"SSO 联调遇阻，数据源还没通"且看板已有该任务）→ taskUpdate ✓
- 只是顺带提了一句旧任务名、没有实质进展或变更 → 不产 taskUpdate ✗

# 拆解规则
- tasks 与 taskUpdates 合计最多 ${maxTasks} 条，按置信度从高到低截断
- 粒度原则（优先级最高，覆盖一切拆分冲动）：一张候选 = 一个「可独立指派、独立验收」的工作单元——同一目标、同一负责对象、同一交付物下的多个准备步骤/子动作，合成一张候选，把步骤写进 desc。例：一次需求调研里的"整理报表清单""写 SOP""建模板"是同一工程的三步，合一张候选，desc 列出步骤
- 判断标准：这些动作会不会由同一个人、围绕同一个交付物连续推进？会 → 一张；不同人各领一段、交付物截然不同、或需要独立跟进验收 → 才拆
- 宁大勿碎：产出 1 条步骤完整的候选，好过 3 条碎片候选（碎片让看板失焦、派工失真）；大小拿不准时选更大的一方
- 互不相干的两件事（不同目标/不同负责人/不同交付物）才拆成两张；不建父子层级
- dueHint 只写原文中的日期词（如"周五""月底"），不要换算成具体日期
- suggestedMemberId 只能从名册 id 中选；依据是发言分段的说话人映射或上下文；无法判断时填空字符串
- quote 必须是逐字稿中的原句（可截取，不改写）
- 查重分诊：先对照"现有看板任务"判断逐字稿内容与其的关系——
  - 全新事项（看板中没有对应任务）→ 产 tasks
  - 对看板已有任务的讨论/进展/变更（跟进情况、阻塞、方案调整、完成汇报）→ 不产 tasks，改产 taskUpdates：
    existingTaskId 填看板任务 id，quote 填本次讨论的原句，note 用一句话概括本次进展/变更
  - 顺带提了一句旧任务名但无实质讨论或变更 → 既不产 tasks 也不产 taskUpdates
- ${truncated ? '注意：逐字稿被截断，只分析可见部分' : '逐字稿完整'}

# 成员名册（id | 姓名（别名））
${rosterLines}

# 现有看板任务（id | [状态] 标题；查重分诊与 taskUpdates.existingTaskId 参考）
${boardLines}

# 会议逐字稿（【说话人|成员id】分段；成员id 为 "-" 表示未识别）
${transcript}

只输出 JSON。`;
}

// ------------------------------------------------------------- 输出解析/整形

/** 从引擎输出提取 JSON：剥代码围栏 → 首个 { 到末个 } → JSON.parse */
function extractJSON(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].includes('{')) t = fence[1].trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('输出中未找到 JSON 对象');
  const parsed = JSON.parse(t.slice(i, j + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('输出不是 JSON 对象');
  }
  return parsed;
}

function clipStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 模型输出 → 严格候选结构（脏数据逐项防御，不因单条畸形丢弃整批） */
function coerceResult(parsed, roster, cfg) {
  const maxTasks = Number(cfg.analyze && cfg.analyze.maxTasksPerMessage) || 10;
  const rosterIds = new Set(roster.map((m) => m.id));
  let tasks = [];
  for (const t of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
    if (!t || typeof t !== 'object') continue;
    const title = clipStr(t.title, 200).trim();
    if (!title) continue; // 无标题的候选不可用，丢弃
    let confidence = Number(t.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.min(1, Math.max(0, confidence));
    const suggested = typeof t.suggestedMemberId === 'string' && rosterIds.has(t.suggestedMemberId) ? t.suggestedMemberId : '';
    tasks.push({
      title,
      desc: clipStr(t.desc, 2000),
      priority: PRIORITIES.has(t.priority) ? t.priority : 'unset',
      suggestedMemberId: suggested,
      dueHint: clipStr(t.dueHint, 60).trim(),
      confidence: Math.round(confidence * 100) / 100,
      claimLevel: confidence >= 0.9 ? 'fact' : confidence >= 0.7 ? 'observation' : confidence >= 0.5 ? 'hypothesis' : 'suggestion',
      quote: clipStr(t.quote, 300),
      rationale: clipStr(t.rationale, 500),
    });
  }
  tasks.sort((a, b) => b.confidence - a.confidence);

  // v1.9 任务更新提案：existingTaskId 必填（缺了提案无处可挂，丢弃），quote/note/clamp 同套路
  let updates = [];
  for (const u of Array.isArray(parsed.taskUpdates) ? parsed.taskUpdates : []) {
    if (!u || typeof u !== 'object') continue;
    const existingTaskId = clipStr(u.existingTaskId, 100).trim();
    if (!existingTaskId) continue;
    let confidence = Number(u.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.min(1, Math.max(0, confidence));
    updates.push({
      existingTaskId,
      quote: clipStr(u.quote, 300),
      note: clipStr(u.note, 500),
      confidence: Math.round(confidence * 100) / 100,
      claimLevel: confidence >= 0.9 ? 'fact' : confidence >= 0.7 ? 'observation' : confidence >= 0.5 ? 'hypothesis' : 'suggestion',
    });
  }
  // PRD §5 上限扩到两类合计：合并按置信度截断后再拆回（各自仍保持降序）
  if (tasks.length + updates.length > maxTasks) {
    const merged = tasks
      .map((t) => ({ isTask: true, item: t, confidence: t.confidence }))
      .concat(updates.map((u) => ({ isTask: false, item: u, confidence: u.confidence })));
    merged.sort((a, b) => b.confidence - a.confidence);
    const kept = merged.slice(0, maxTasks);
    tasks = kept.filter((x) => x.isTask).map((x) => x.item);
    updates = kept.filter((x) => !x.isTask).map((x) => x.item);
  }
  const noiseRaw = Array.isArray(parsed.noise) ? parsed.noise : [];
  const noise = noiseRaw
    .filter((n) => n && typeof n === 'object')
    .slice(0, 50)
    .map((n) => ({ quote: clipStr(n.quote, 300), reason: clipStr(n.reason, 300) }));
  return { tasks: tasks.slice(0, maxTasks), taskUpdates: updates, noise };
}

// ----------------------------------------------------------------- 管线主体

/**
 * 分析一条纪要：组 prompt → 调引擎 → 解析（失败重试一次）→ coerce。
 * opts.timeoutSec 覆盖本次引擎超时（P1-B 重试升压：路由层按 attempt 计算 ×2 后传入）。
 * 名册 = store.aggregateRoster(ctx) 聚合快照（手工 ∪ Gitea 缓存，P1-A）。
 * 成功返回 {tasks, noise, raw}；两次解析失败抛错（调用方标记 ANALYZE_FAILED）。
 */
async function analyzeMessage(ctx, message, opts = {}) {
  const cfg = ctx.config;
  const roster = store.aggregateRoster(ctx);
  const { tasks: boardTasks } = store.loadTasks(ctx);
  const prompt = buildPrompt(message, roster, boardTasks, cfg);

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let output = null;
    const fx = runHeadlessFixture();
    if (fx !== null) {
      output = fx; // fixture 模式不 spawn
    } else {
      output = await runHeadless(cfg, prompt, { timeoutSec: opts.timeoutSec }); // 引擎级失败（超时/找不到 bin）直接抛，不重试
    }
    try {
      const parsed = extractJSON(output);
      const result = coerceResult(parsed, roster, cfg);
      result.raw = output;
      return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw Object.assign(new Error(`引擎输出两次解析失败: ${lastErr && lastErr.message}`), { code: 'ANALYZE_PARSE_FAILED' });
}

/** quote 反查说话人 raw：双向包含（模型引用可能是分段全文的子串，也可能跨段拼接） */
function speakerRawForQuote(message, quote) {
  if (!quote) return '';
  const seg = (message.speakerSegments || []).find(
    (s) => s.text && (s.text.includes(quote) || quote.includes(s.text))
  );
  return seg ? seg.raw : '';
}

/**
 * matchSource（v1.5 P1-A）：候选卡上的归人依据。
 * 优先取「该候选说话人原文预匹配命中同一成员」的档位（alias/name/gitea）；
 * 模型按上下文归人时回退为该成员在聚合名册中的来源档位（gitea/manual→name）；
 * 未归人恒 null。
 */
function matchSourceFor(t, speakerRaw, roster) {
  if (!t.suggestedMemberId) return null;
  const resolved = speakerRaw ? resolveSpeaker(speakerRaw, roster) : null;
  if (resolved && resolved.id === t.suggestedMemberId) return resolved.source;
  const entry = roster.find((r) => r.id === t.suggestedMemberId);
  return entry ? (entry.source === 'gitea' ? 'gitea' : 'name') : null;
}

/** 候选去重键：任务候选按 消息|引用|标题；更新提案按 消息|update|目标任务|引用 */
function candidateKey(c) {
  return c.kind === 'update'
    ? `${c.messageId}|update|${c.existingTaskId}|${c.quote}`
    : `${c.messageId}|${c.quote}|${c.title}`;
}

/**
 * 把分析结果落盘：候选入池（confidence ≥ 0.5，防重去抖）、noise 记录到消息、
 * 水位 analyzedAt/analyzeState 更新。
 * confidence < 0.5 的项不产出候选（PRD §5），落入消息 noise 留痕。
 * v1.9：result.taskUpdates（更新提案）落为 kind:'update' 候选（带 existingTaskId/quote/note），
 * 不入看板；任务候选显式标 kind:'task'（存量候选无 kind 字段，消费端按 task 容错）。
 * @returns {number} 新增候选数
 */
function applyAnalysis(ctx, message, result) {
  const inbox = store.loadInbox(ctx);
  const roster = store.aggregateRoster(ctx); // matchSource 归因依据（P1-A）
  // 重试场景：清掉该消息此前可能残留的 pending 候选（部分成功后被标 FAILED 的脏数据）
  const kept = inbox.filter((c) => !(c.messageId === message.id && c.state === 'pending'));
  const existed = new Set(kept.map(candidateKey));
  const now = new Date().toISOString();
  let added = 0;
  const noise = result.noise.slice();

  for (const t of result.tasks) {
    if (t.confidence < 0.5) {
      noise.push({ quote: t.quote, reason: t.rationale || `低置信度 ${t.confidence}，不产出候选` });
      continue; // PRD：低于 0.5 不产出候选
    }
    const key = `${message.id}|${t.quote}|${t.title}`;
    if (existed.has(key)) continue;
    existed.add(key);
    const speakerRaw = speakerRawForQuote(message, t.quote);
    kept.push({
      id: `cand-${Date.now().toString(36)}-${store.randomToken(4)}-${added}`,
      kind: 'task',
      messageId: message.id,
      messageTitle: message.title,
      occurredAt: message.occurredAt,
      title: t.title,
      desc: t.desc,
      priority: t.priority,
      suggestedMemberId: t.suggestedMemberId,
      matchSource: matchSourceFor(t, speakerRaw, roster), // v1.5 P1-A：归人依据落候选卡
      dueHint: t.dueHint,
      confidence: t.confidence,
      quote: t.quote,
      rationale: t.rationale,
      speakerRaw,
      state: 'pending',
      decidedAt: null,
      createdAt: now,
    });
    added += 1;
  }

  // v1.9：任务更新提案 → kind:'update' 候选（确认后写目标任务时间轴，不建新任务）
  for (const u of Array.isArray(result.taskUpdates) ? result.taskUpdates : []) {
    if (u.confidence < 0.5) {
      noise.push({ quote: u.quote, reason: `低置信度 ${u.confidence}，不产出更新提案` });
      continue; // 与任务候选同一置信度闸门
    }
    const key = `${message.id}|update|${u.existingTaskId}|${u.quote}`;
    if (existed.has(key)) continue;
    existed.add(key);
    kept.push({
      id: `cand-${Date.now().toString(36)}-${store.randomToken(4)}-${added}`,
      kind: 'update',
      messageId: message.id,
      messageTitle: message.title,
      occurredAt: message.occurredAt,
      existingTaskId: u.existingTaskId,
      quote: u.quote,
      note: u.note,
      confidence: u.confidence,
      speakerRaw: speakerRawForQuote(message, u.quote),
      state: 'pending',
      decidedAt: null,
      createdAt: now,
    });
    added += 1;
  }

  store.saveInbox(ctx, kept);

  message.analyzedAt = now;
  message.analyzeState = 'ok';
  message.analyzeError = null;
  message.noise = noise;
  return added;
}

/** 标记 ANALYZE_FAILED（可重试：analyzedAt 仍为 null，analyze 端点据此放行重跑） */
function markFailed(ctx, message, err) {
  message.analyzeState = 'ANALYZE_FAILED';
  message.analyzeError = redact((err && err.message) || String(err)).slice(0, 500);
  message.analyzedAt = null;
  const messages = store.loadMessages(ctx);
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx !== -1) {
    messages[idx] = message;
    store.saveMessages(ctx, messages);
  }
}

function persistAnalyzedMessage(ctx, message) {
  const messages = store.loadMessages(ctx);
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx !== -1) {
    messages[idx] = message;
    store.saveMessages(ctx, messages);
  }
}

// ------------------------------------------------------------------- routes

/** 同一消息并发防重入（两个 job 撞车时后者跳过） */
const inFlight = new Set();

/**
 * v1.5（goose 验收 P1-B）：引擎超时按尝试次数升压——首次按配置值，重试（attempt≥2）
 * 用配置 ×2（升压一次封顶，不指数放大）。job 记录里带 attempt/timeoutSec 可观测。
 */
function effectiveTimeoutSec(base, attempt) {
  const b = Number(base) || 300;
  return Number(attempt) > 1 ? b * 2 : b;
}

function registerAnalyzeRoutes(router, ctx) {
  router.add('POST', '/api/radar/analyze', (c) => {
    const body = c.body || {};
    if (!Array.isArray(body.messageIds) || body.messageIds.length === 0 || body.messageIds.length > 50) {
      throw new HttpError(400, 'FIELD_INVALID', 'messageIds 必填且为 1..50 个消息 id 的数组');
    }
    const messages = store.loadMessages(ctx);
    const byId = new Map(messages.map((m) => [m.id, m]));
    const eligible = [];
    const skipped = [];
    for (const id of body.messageIds) {
      const m = byId.get(String(id));
      if (!m) {
        skipped.push({ messageId: id, reason: 'NOT_FOUND' });
        continue;
      }
      if (m.analyzedAt && m.analyzeState !== 'ANALYZE_FAILED') {
        skipped.push({ messageId: id, reason: 'ALREADY_ANALYZED' });
        continue;
      }
      if (inFlight.has(String(id))) {
        skipped.push({ messageId: id, reason: 'ALREADY_RUNNING' });
        continue;
      }
      eligible.push(m);
    }
    const baseTimeout = Number(ctx.config.analyze && ctx.config.analyze.timeoutSec) || 300;
    const job = jobsMod.createJob('analyze', eligible.length);
    (async () => {
      for (const message of eligible) {
        const id = String(message.id);
        inFlight.add(id);
        job.current = message.title;
        // P1-B：尝试次数落消息（成功/失败两条持久化路径都会写回），重试即升压
        const attempt = (Number(message.analyzeAttempts) || 0) + 1;
        message.analyzeAttempts = attempt;
        const timeoutSec = effectiveTimeoutSec(baseTimeout, attempt);
        try {
          const result = await analyzeMessage(ctx, message, { timeoutSec });
          const added = applyAnalysis(ctx, message, result);
          persistAnalyzedMessage(ctx, message);
          job.results.push({ item: id, ok: true, added, attempt, timeoutSec });
        } catch (e) {
          markFailed(ctx, message, e);
          job.results.push({ item: id, ok: false, error: redact((e && e.message) || String(e)), attempt, timeoutSec });
        } finally {
          inFlight.delete(id);
          job.done += 1;
          job.current = null;
        }
      }
      jobsMod.finishJob(job);
    })();
    sendJSON(c.res, 202, {
      jobId: job.id,
      accepted: eligible.length,
      skipped,
      // v1.5 P1-B：带段数供前端预估提示（segmentCount>150 = 长会，可能 2-4 分钟）
      items: eligible.map((m) => ({
        id: String(m.id),
        segmentCount: Array.isArray(m.speakerSegments) ? m.speakerSegments.length : 0,
      })),
    });
  });

  router.add('GET', '/api/radar/analyze/:id', (c) => {
    const job = jobsMod.getJob(c.params.id);
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', '任务不存在或已被滚动清理');
    sendJSON(c.res, 200, jobsMod.jobView(job));
  });

  // v2.9.28 转写入口泛化：POST /api/radar/text {title, text}——任意文本（非钉钉听记）入纪要池。
  // 只持久化合成消息（source:'text'，全文作单段 speakerSegment）；分析复用既有 POST analyze
  // {messageIds:[id]}——零管线改动。返回 messageId 后调用方自行触发 analyze（202 job 模式）。
  router.add('POST', '/api/radar/text', (c) => {
    const body = c.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (title.length < 1 || title.length > 200) {
      throw new HttpError(400, 'FIELD_INVALID', 'title 必填且为 1..200 字符');
    }
    if (text.length < 10) {
      throw new HttpError(400, 'FIELD_INVALID', 'text 至少 10 字（转写正文）');
    }
    if (text.length > 200000) {
      throw new HttpError(400, 'FIELD_INVALID', 'text 超长（上限 200000 字符）');
    }
    const messages = store.loadMessages(ctx);
    const now = new Date().toISOString();
    const message = {
      id: `msg-text-${Date.now().toString(36)}-${store.randomToken(4)}`,
      title,
      source: 'text', // 纪要池源徽标区分（钉钉听记无此字段）
      occurredAt: now,
      createdAt: now,
      speakerSegments: [{ raw: '文本投喂', text }], // 单段：整篇作无名说话人；transcriptLines 直接可用
      analyzedAt: null,
      analyzeState: null,
      analyzeAttempts: 0,
      noise: [],
    };
    messages.push(message);
    store.saveMessages(ctx, messages);
    sendJSON(c.res, 201, { messageId: message.id, title: message.title, next: `/api/radar/analyze` });
  });
}

module.exports = {
  registerAnalyzeRoutes,
  analyzeMessage,
  applyAnalysis,
  markFailed,
  buildPrompt,
  extractJSON,
  coerceResult,
  mapSpeaker,
  resolveSpeaker,
  effectiveTimeoutSec,
  runHeadless,
  runHeadlessFixture,
  resolveDshBin,
};
