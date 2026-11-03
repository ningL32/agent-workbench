'use strict';

/**
 * inbox.js — 任务收件箱：候选池 CRUD + 确认/拒绝流 + 误识率统计（PRD 任务雷达 §5/§7）
 *
 * - 确认入库：按（可编辑后的）字段建看板任务，task.origin = {type:'inbox', refId, quote} 溯源；
 *   rememberAlias=true 且候选带说话人原文 → 别名（speakerRaw）写入 speakerMemberId（说话人身份
 *   映射目标，v1.7 修订：与 memberId 任务负责人彻底解耦——负责人 ≠ 说话人）；目标为 Gitea 派生
 *   id 时自动创建关联手工条目（v1.5 P1-C），响应 rememberedAlias 带落点；speakerMemberId 为空
 *   （含旧客户端只传 memberId）→ 不写任何别名，rememberedAlias:null + reason:'SPEAKER_UNRESOLVED'
 *   （不报错——宁可不学，不可错学）
 * - v1.9 任务更新提案（kind==='update'，存量无 kind 字段按任务候选容错）：确认 → 不建任务、
 *   不改任务字段；往 existingTaskId 事件流写 type:"memo" 节点（纪要标题 + 原文引用），
 *   并把该纪要追加进任务 origin.relatedMemos[]（origin 缺失则创建兜底形态）；
 *   existingTaskId 已失效 → 400 TASK_NOT_FOUND（候选保持待决）；done-already 不适用 → 409
 * - 拒绝（v1.7 起原因必选）：reason ∈ duplicate/wont_do/invalid/other，落 rejectReason/rejectNote
 *   （v1.9：更新提案与任务候选同一闸门，拒绝照常可用）
 * - 已完成处置（v1.7 新增）：POST /:id/done-already → state='done_already'，不入看板
 * - 误识率仪表（v1.7 口径）：近 30 天 rejected/(confirmed+done_already+rejected)（数据从第一天起攒）；
 *   v1.9：更新提案确认计入 confirmed30d（算「已采纳」，口径不变）
 */

const store = require('./store');
const membersMod = require('./members');
const taskEvents = require('./taskEvents');
const { HttpError, sendJSON } = require('./router');

const PRIORITIES = new Set(['high', 'medium', 'low']);
const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// v1.7：拒绝原因必选枚举
const REJECT_REASONS = ['duplicate', 'wont_do', 'invalid', 'other'];

/** YYYY-MM-DD + 真实日历回读（与 server.js 任务 dueDate 同规则：V8 会把 02-30 滚动到 3 月） */
function validDueDate(v) {
  if (typeof v !== 'string' || !DUE_DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function candidateView(c) {
  const v = store.clone(c);
  // 五类卡点（源自数字员工文五类卡点分类，2026-10-25 增）：
  // cognitive=认知/歧义  risk=风险/敏感  relation=关系/真人  system=系统/工具  strategy=策略/新话术
  v.blockerType = v.blockerType || 'cognitive';
  return v;
}

/**
 * 候选决定附言（reject 的 note / done-already 的 note）：可省略；提供时必须为 ≤500 字符字符串；
 * null 视为未填（宽松，与 memberId 等可空字段风格一致）。
 */
function optionalNote(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > 500) {
    throw new HttpError(400, 'FIELD_INVALID', 'note 可省略，提供时必须为不超过 500 字符的字符串');
  }
  return v;
}

/** 近 30 天误识率（v1.7 口径）= rejected30d/(confirmed30d+doneAlready30d+rejected30d)，
 * 分母 0 时 null（还没数据不显示数字）。「已顺手做完」的 done_already 属于正确处置，
 * 计入分母（AI 识别为任务而实际无需建任务），分子仍只算 rejected。 */
function computeStats(candidates) {
  const cutoff = Date.now() - 30 * 86400 * 1000;
  const counts = { pending: 0, confirmed: 0, rejected: 0, done_already: 0, merged: 0 };
  let confirmed30 = 0;
  let rejected30 = 0;
  let doneAlready30 = 0;
  let merged30 = 0;
  for (const c of candidates) {
    if (counts[c.state] !== undefined) counts[c.state] += 1;
    if (c.decidedAt && Date.parse(c.decidedAt) >= cutoff) {
      if (c.state === 'confirmed') confirmed30 += 1;
      else if (c.state === 'rejected') rejected30 += 1;
      else if (c.state === 'done_already') doneAlready30 += 1;
      else if (c.state === 'merged') merged30 += 1;
    }
  }
  const denominator = confirmed30 + doneAlready30 + rejected30;
  return {
    pending: counts.pending,
    confirmed: counts.confirmed,
    rejected: counts.rejected,
    doneAlready: counts.done_already,
    merged: counts.merged,
    confirmed30d: confirmed30,
    rejected30d: rejected30,
    doneAlready30d: doneAlready30,
    merged30d: merged30,
    rejectRate30d: denominator > 0 ? Math.round((rejected30 / denominator) * 10000) / 10000 : null,
  };
}

/**
 * 记住说话人映射：别名追加到成员（大小写不敏感去重）。v1.7 修订起 memberId 参数
 * 语义 = speakerMemberId（说话人身份映射目标），与任务负责人无关。
 * v1.5（goose 验收 P1-C）：目标 id 不在手工名册但命中 Gitea 成员缓存时，自动创建
 * 关联手工条目（{id:login, name:full_name, giteaLogin:login}）再写别名——确认弹层
 * 下拉展示的是聚合名册，映射必须能挂到派生成员，否则该组合服务端必 404。
 * @returns {{memberId:string, alias:string|null, memberCreated:boolean}}
 */
function rememberAlias(ctx, memberId, raw) {
  const { members, member, created } = membersMod.resolveAliasTarget(ctx, memberId);
  if (!member) {
    throw new HttpError(404, 'MEMBER_NOT_FOUND', '「记住此映射」目标成员不存在于手工名册与 Gitea 成员缓存');
  }
  let aliasWritten = false;
  const alias = String(raw || '').trim();
  if (alias && alias.length <= 50) {
    if (!Array.isArray(member.aliases)) member.aliases = [];
    const dup = member.aliases.some((a) => typeof a === 'string' && a.trim().toLowerCase() === alias.toLowerCase());
    if (!dup) {
      member.aliases.push(alias);
      aliasWritten = true;
    }
  }
  // 新建条目即便本次没有别名可写也要落盘（映射目标已扩展，丢掉即回退成派生孤儿）
  if (created || aliasWritten) store.saveMembers(ctx.membersPath, members);
  return { memberId: member.id, alias: alias || null, memberCreated: created };
}

/** 已决候选的重复决定提示文案（v1.7 增 done_already 态） */
function stateLabel(state) {
  if (state === 'confirmed') return '确认';
  if (state === 'done_already') return '标记为已完成';
  return '拒绝';
}

function registerInboxRoutes(router, ctx) {
  router.add('GET', '/api/inbox', (c) => {
    const state = c.query.get('state');
    let list = store.loadInbox(ctx);
    if (state) list = list.filter((x) => x.state === state);
    // 待确认按置信度降序（PRD §6）；已决按决定时间倒序
    list = list.slice().sort((a, b) => {
      if (a.state === 'pending' && b.state === 'pending') {
        return b.confidence - a.confidence || Date.parse(b.createdAt) - Date.parse(a.createdAt);
      }
      return Date.parse(b.decidedAt || b.createdAt) - Date.parse(a.decidedAt || a.createdAt);
    });
    sendJSON(c.res, 200, list.map(candidateView));
  });

  router.add('GET', '/api/inbox/stats', (c) => {
    sendJSON(c.res, 200, computeStats(store.loadInbox(ctx)));
  });

  router.add('POST', '/api/inbox/:id/confirm', (c) => {
    const inbox = store.loadInbox(ctx);
    const cand = inbox.find((x) => x.id === c.params.id);
    if (!cand) throw new HttpError(404, 'CANDIDATE_NOT_FOUND', '候选卡不存在');
    if (cand.state !== 'pending') throw new HttpError(409, 'ALREADY_DECIDED', `该候选已${stateLabel(cand.state)}，不可重复决定`);

    // v1.9 任务更新提案分支：确认 = 采纳这条讨论/进展，挂到已有任务的时间轴。
    // 不建任务、不改任务业务字段（title/status 等一概不动）；确认前先校验目标任务仍在，
    // 已失效（被删）→ 400 TASK_NOT_FOUND 且候选保持待决（不产生半截状态）。
    if (cand.kind === 'update') {
      const data = store.loadTasks(ctx);
      const task = data.tasks.find((t) => t.id === cand.existingTaskId);
      if (!task) {
        throw new HttpError(400, 'TASK_NOT_FOUND', `关联任务 ${cand.existingTaskId || '（空）'} 不存在或已删除，无法确认更新提案`);
      }
      const now = new Date().toISOString();
      // memo 事件：时间轴上的「纪要节点」（detail = 纪要标题 + 引用原句）
      taskEvents.appendEvents(ctx, [
        taskEvents.makeEvent(task.id, 'memo', null, null, `纪要《${cand.messageTitle}》：${cand.quote}`, now),
      ]);
      // origin.relatedMemos 追加 → 任务 × 听记 天然 N:N；origin 缺失（老任务）创建兜底形态
      if (!store.isPlainObject(task.origin)) {
        task.origin = { type: 'inbox', refId: cand.messageId, quote: '', relatedMemos: [] };
      }
      if (!Array.isArray(task.origin.relatedMemos)) task.origin.relatedMemos = [];
      task.origin.relatedMemos.push({
        refId: cand.messageId,
        title: cand.messageTitle,
        quote: cand.quote || '',
        at: now,
      });
      store.saveTasks(ctx, data);

      cand.state = 'confirmed';
      cand.decidedAt = now;
      cand.confirmedTaskId = task.id;
      store.saveInbox(ctx, inbox);
      return sendJSON(c.res, 200, { task: store.clone(task), candidate: candidateView(cand) });
    }

    const body = c.body || {};
    // 字段校验（确认时允许编辑；全部字段可省略 = 按 AI 建议原样入库）
    const title = body.title !== undefined ? String(body.title).trim() : cand.title;
    if (!title || title.length < 1 || title.length > 200) {
      throw new HttpError(400, 'FIELD_INVALID', 'title 必填且为 1..200 字符');
    }
    let desc = body.desc !== undefined ? body.desc : cand.desc;
    if (typeof desc !== 'string' || desc.length > 2000) {
      throw new HttpError(400, 'FIELD_INVALID', 'desc 必须为不超过 2000 字符的字符串');
    }
    let priority = body.priority !== undefined ? body.priority : cand.priority;
    if (priority === 'unset' || priority === undefined || priority === null || priority === '') priority = 'medium';
    if (!PRIORITIES.has(priority)) {
      throw new HttpError(400, 'FIELD_INVALID', 'priority 必须为 high/medium/low 之一');
    }
    let memberId = body.memberId !== undefined ? body.memberId : cand.suggestedMemberId;
    if (memberId === undefined || memberId === null || memberId === '') memberId = null;
    else if (typeof memberId !== 'string' || memberId.length > 64) {
      throw new HttpError(400, 'FIELD_INVALID', 'memberId 必须为不超过 64 字符的字符串或 null');
    }
    // v1.7 修订：speakerMemberId = 说话人身份映射目标（「这个说话人是名册里的谁」），
    // 与 memberId（任务负责人）解耦。可省略/null/空串 = 不做身份映射
    let speakerMemberId = body.speakerMemberId !== undefined ? body.speakerMemberId : null;
    if (speakerMemberId === '') speakerMemberId = null;
    if (speakerMemberId !== null && (typeof speakerMemberId !== 'string' || speakerMemberId.length > 64)) {
      throw new HttpError(400, 'FIELD_INVALID', 'speakerMemberId 必须为不超过 64 字符的字符串或 null');
    }
    let dueDate = body.dueDate !== undefined ? body.dueDate : null;
    if (dueDate === '') dueDate = null;
    if (dueDate !== null && !validDueDate(dueDate)) {
      throw new HttpError(400, 'FIELD_INVALID', 'dueDate 必须为 YYYY-MM-DD 格式字符串或 null');
    }
    const remember = body.rememberAlias === true;

    // 前置校验别名目标（避免任务已建而别名写入失败的不一致）。
    // v1.7 修订：只校验 speakerMemberId（映射目标）；memberId 是任务负责人，与记别名无关，
    // 不再要求「记住映射必须先指定负责成员」。speakerMemberId 为空 → 不写别名（宁可不学，
    // 不可错学——旧客户端只传 memberId 时绝不把说话人昵称挂到负责人名下）。
    // v1.5（P1-C）：只读解析不落盘——手工名册或 Gitea 缓存任一命中即放行，落盘延后到 rememberAlias
    if (remember) {
      if (!cand.speakerRaw) throw new HttpError(400, 'FIELD_INVALID', '该候选没有说话人原文，无法记住映射');
      if (speakerMemberId) {
        const target = membersMod.resolveAliasTarget(ctx, speakerMemberId);
        if (!target.member) {
          throw new HttpError(404, 'MEMBER_NOT_FOUND', '「记住此映射」目标成员不存在于手工名册与 Gitea 成员缓存');
        }
      }
    }

    // 建任务（带 origin 溯源）
    const data = store.loadTasks(ctx);
    const now = new Date().toISOString();
    const task = {
      id: store.genTaskId(data.tasks),
      title,
      status: 'todo',
      agentId: null,
      memberId,
      repo: null,
      branch: null,
      prUrl: null,
      notes: '',
      desc,
      dueDate,
      priority,
      artifacts: [], // v1.9：Gitea 成果挂接（与手工建任务同构；存量任务无字段容错）
      createdAt: now,
      updatedAt: now,
      origin: { type: 'inbox', refId: cand.id, quote: cand.quote || '' },
    };
    data.tasks.push(task);
    store.saveTasks(ctx, data);
    // v1.7：收件箱确认入库也记 created 事件（detail 含 origin 来源描述）
    taskEvents.appendEvents(ctx, [taskEvents.createdEvent(task, now)]);

    // v1.7 修订：别名只写 speakerMemberId 名下；为空（含旧客户端只传 memberId）不写任何别名，
    // 响应 rememberedAlias:null + reason:'SPEAKER_UNRESOLVED'（不报错——用户有权不映射）
    let remembered = null;
    let aliasReason = null;
    if (remember) {
      if (speakerMemberId) {
        remembered = rememberAlias(ctx, speakerMemberId, cand.speakerRaw);
      } else {
        aliasReason = 'SPEAKER_UNRESOLVED';
      }
    }

    cand.state = 'confirmed';
    cand.decidedAt = now;
    cand.confirmedTaskId = task.id;
    // 编辑后字段回写候选（审计留痕：AI 建议 → 人工定稿）
    cand.title = title;
    cand.desc = desc;
    cand.priority = priority;
    cand.suggestedMemberId = memberId;
    cand.dueDate = dueDate;
    store.saveInbox(ctx, inbox);

    // v1.5：rememberedAlias 带映射落点（memberId = 映射目标 speakerMemberId，
    // memberCreated=true = 由派生 id 自动建的关联手工条目）；
    // v1.7 修订：请求了记住映射但未写别名时附 reason:'SPEAKER_UNRESOLVED'（映射目标未指定）
    const confirmRes = { task: store.clone(task), candidate: candidateView(cand), rememberedAlias: remembered };
    if (aliasReason) confirmRes.reason = aliasReason;
    sendJSON(c.res, 200, confirmRes);
  });

  // v2.9.12 合并入库：多条候选 → 一个人工命名的新任务。标题/描述全人工填（不做智能
  // 拼装），N 条候选全部转 merged（不进误识率分母，单独 merged30d 观测拆解粒度），
  // 并各自以 memo 事件 + relatedMemos 记入任务时间轴（原文可溯）。
  // 原子性：先全量校验后落盘，tasks/inbox 两次原子写之间无用户可达中间态。
  router.add('POST', '/api/inbox/confirm-merged', (c) => {
    const body = c.body || {};
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 50 || ids.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new HttpError(400, 'FIELD_INVALID', 'ids 必须为 2..50 个候选 id 的数组');
    }
    const title = String(body.title === undefined ? '' : body.title).trim();
    if (!title || title.length < 1 || title.length > 200) {
      throw new HttpError(400, 'FIELD_INVALID', 'title 必填且为 1..200 字符（合并后任务由人工命名）');
    }
    let desc = body.desc;
    if (desc === undefined || desc === null) desc = '';
    if (typeof desc !== 'string' || desc.length > 2000) {
      throw new HttpError(400, 'FIELD_INVALID', 'desc 必须为不超过 2000 字符的字符串');
    }
    let priority = body.priority === undefined || body.priority === null || body.priority === '' ? 'medium' : body.priority;
    if (!PRIORITIES.has(priority)) {
      throw new HttpError(400, 'FIELD_INVALID', 'priority 必须为 high/medium/low 之一');
    }
    let memberId = body.memberId === undefined || body.memberId === null || body.memberId === '' ? null : body.memberId;
    if (memberId !== null && (typeof memberId !== 'string' || memberId.length > 64)) {
      throw new HttpError(400, 'FIELD_INVALID', 'memberId 必须为不超过 64 字符的字符串或 null');
    }
    let dueDate = body.dueDate === undefined || body.dueDate === '' ? null : body.dueDate;
    if (dueDate !== null && !validDueDate(dueDate)) {
      throw new HttpError(400, 'FIELD_INVALID', 'dueDate 必须为 YYYY-MM-DD 格式字符串或 null');
    }

    const inbox = store.loadInbox(ctx);
    const targets = [];
    for (const id of ids) {
      const cand = inbox.find((x) => x.id === id);
      if (!cand) throw new HttpError(404, 'CANDIDATE_NOT_FOUND', `候选卡 ${id} 不存在`);
      if (cand.state !== 'pending') throw new HttpError(409, 'ALREADY_DECIDED', `候选「${cand.title || id}」已${stateLabel(cand.state)}，不可再合并`);
      if (cand.kind === 'update') throw new HttpError(400, 'UPDATE_KIND_UNSUPPORTED', '任务更新提案不能参与合并，请单独确认或拒绝');
      targets.push(cand);
    }
    if (new Set(targets.map((x) => x.id)).size !== targets.length) {
      throw new HttpError(400, 'FIELD_INVALID', 'ids 存在重复');
    }

    const now = new Date().toISOString();
    const main = targets[0]; // 主候选：origin 溯源锚点（前端按置信度降序传参）
    const data = store.loadTasks(ctx);
    const task = {
      id: store.genTaskId(data.tasks),
      title,
      status: 'todo',
      agentId: null,
      memberId,
      repo: null,
      branch: null,
      prUrl: null,
      notes: '',
      desc,
      dueDate,
      priority,
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      origin: { type: 'inbox', refId: main.id, quote: main.quote || '', relatedMemos: [] },
    };
    const memoEvents = targets.map((cand) =>
      taskEvents.makeEvent(task.id, 'memo', null, null, `纪要《${cand.messageTitle}》：${cand.quote}`, now));
    taskEvents.appendEvents(ctx, memoEvents);
    for (const cand of targets) {
      task.origin.relatedMemos.push({
        refId: cand.messageId,
        title: cand.messageTitle,
        quote: cand.quote || '',
        at: now,
      });
    }
    data.tasks.push(task);
    store.saveTasks(ctx, data);

    for (const cand of targets) {
      cand.state = 'merged';
      cand.mergedInto = task.id;
      cand.mergedAt = now;
      cand.decidedAt = now;
    }
    // 主候选回写人工定稿字段（审计留痕，与单条确认同口径）
    main.title = title;
    main.desc = desc;
    main.priority = priority;
    main.suggestedMemberId = memberId;
    main.dueDate = dueDate;
    main.confirmedTaskId = task.id;
    store.saveInbox(ctx, inbox);

    sendJSON(c.res, 200, {
      task: store.clone(task),
      merged: targets.map((x) => x.id),
      candidate: candidateView(main),
    });
  });

  // v1.7：拒绝原因必选——缺 reason 或取值不在枚举 → 400 REASON_REQUIRED；
  // 落 rejectReason/rejectNote，state=rejected
  router.add('POST', '/api/inbox/:id/reject', (c) => {
    const inbox = store.loadInbox(ctx);
    const cand = inbox.find((x) => x.id === c.params.id);
    if (!cand) throw new HttpError(404, 'CANDIDATE_NOT_FOUND', '候选卡不存在');
    if (cand.state !== 'pending') throw new HttpError(409, 'ALREADY_DECIDED', `该候选已${stateLabel(cand.state)}，不可重复决定`);
    const reason = (c.body || {}).reason;
    if (!REJECT_REASONS.includes(reason)) {
      throw new HttpError(400, 'REASON_REQUIRED', `reason 必填，且为 ${REJECT_REASONS.join('/')} 之一`);
    }
    const note = optionalNote((c.body || {}).note);
    cand.state = 'rejected';
    cand.decidedAt = new Date().toISOString();
    cand.rejectReason = reason;
    cand.rejectNote = note;
    store.saveInbox(ctx, inbox);
    sendJSON(c.res, 200, candidateView(cand));
  });

  // v1.7：「其实早就做完了」处置——state=done_already、decidedAt；不入看板（不建任务）。
  // 统计口径：done_already 计入误识率分母（识别为任务但实际无需建任务）。
  // v1.9：对更新提案不适用——提案要么确认（写关联任务时间轴）要么拒绝，409 NOT_APPLICABLE
  router.add('POST', '/api/inbox/:id/done-already', (c) => {
    const inbox = store.loadInbox(ctx);
    const cand = inbox.find((x) => x.id === c.params.id);
    if (!cand) throw new HttpError(404, 'CANDIDATE_NOT_FOUND', '候选卡不存在');
    if (cand.state !== 'pending') throw new HttpError(409, 'ALREADY_DECIDED', `该候选已${stateLabel(cand.state)}，不可重复决定`);
    if (cand.kind === 'update') {
      throw new HttpError(409, 'NOT_APPLICABLE', '任务更新提案不适用「已完成」处置：确认后写入关联任务时间轴，或改用拒绝');
    }
    const note = optionalNote((c.body || {}).note);
    cand.state = 'done_already';
    cand.decidedAt = new Date().toISOString();
    cand.doneNote = note;
    store.saveInbox(ctx, inbox);
    sendJSON(c.res, 200, candidateView(cand));
  });
}

module.exports = { registerInboxRoutes, computeStats, REJECT_REASONS };
