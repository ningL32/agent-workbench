'use strict';

/**
 * taskEvents.js — v1.7 任务事件流（时间轴数据源）
 *
 * - 存储 data/task_events.json：事件 {id, taskId, type, from, to, detail, at}，追加式
 * - 双重上限防膨胀：每任务保留最近 100 条（超出丢最旧）；全文件上限 5000 条（丢最旧）
 * - 事件类型：created / status / completed（进 done 的 status 特化）/ assign / due / priority / edit；
 *   v1.9 新增 memo（更新提案确认，来源收件箱，detail=纪要《标题》：引用原句）
 *        与 artifact（Gitea 成果手动挂接，detail=挂接成果：kind repo）；
 *   v2.0 新增 accept（v2.0 验收签字事件：验收人变更/清除，进 done 且已有验收人时联动「验收通过」）
 * - 防噪：同一次 PATCH 多字段变更按字段类型合并——每类型最多一条
 * - 删任务时顺带清理其事件（removeTaskEvents）；存量老任务不回填（详情自然为空数组）
 */

const store = require('./store');
const storeDb = require('./storeDb');
const path = require('node:path');

const PER_TASK_LIMIT = 100;
const GLOBAL_LIMIT = 5000;

/** v2.9.33 存储后端路由：台账标记 task_events 已迁移 → SQLite（ctx 路径仅用于推导 data 目录） */
function eventsBackend(ctx) {
  return storeDb.unitBackend(path.dirname(ctx.taskEventsPath), 'task_events');
}
function eventsDbPath(ctx) {
  return storeDb.dbPathFor(path.dirname(ctx.taskEventsPath));
}

function genEventId() {
  return `e-${Date.now().toString(36)}-${store.randomToken(6)}`;
}

/** 事件落盘形态：{events:[...]} 或裸数组均容忍；缺失回退空 */
function loadEvents(ctx) {
  if (eventsBackend(ctx).backend === 'sqlite') return storeDb.loadEvents(eventsDbPath(ctx));
  const d = store.readJSON(ctx.taskEventsPath, null);
  if (Array.isArray(d)) return d;
  if (store.isPlainObject(d) && Array.isArray(d.events)) return d.events;
  return [];
}

function saveEvents(ctx, events) {
  if (eventsBackend(ctx).backend === 'sqlite') {
    // 全量替换语义保留：事务内 DELETE ALL + INSERT（JSON 版调用方契约不变）
    storeDb.saveEventsSqlite(eventsDbPath(ctx), events, GLOBAL_LIMIT, PER_TASK_LIMIT);
    return;
  }
  store.writeJSON(ctx.taskEventsPath, { events });
}

/**
 * 追加事件并施加双重上限（均丢最旧）：
 * ① 全文件 > 5000 → 截保留最新 5000；② 单任务 > 100 → 该任务只留最新 100。
 * 裁剪只在实际超限时发生，避免常量改写放大写放大。
 * v2.9.33：task_events 已迁移时走单事务 SQLite 路径（追加+裁剪同事务，消除读-改-写竞态）
 */
function appendEvents(ctx, list) {
  if (!Array.isArray(list) || list.length === 0) return;
  if (eventsBackend(ctx).backend === 'sqlite') {
    storeDb.appendEvents(eventsDbPath(ctx), list, GLOBAL_LIMIT, PER_TASK_LIMIT);
  } else {
    let events = loadEvents(ctx).concat(list);
    if (events.length > GLOBAL_LIMIT) events = events.slice(events.length - GLOBAL_LIMIT);

    const countByTask = new Map();
    for (const e of events) countByTask.set(e.taskId, (countByTask.get(e.taskId) || 0) + 1);
    const over = [];
    for (const [taskId, n] of countByTask) {
      if (n > PER_TASK_LIMIT) over.push([taskId, n - PER_TASK_LIMIT]); // 需从头丢弃的条数
    }
    if (over.length > 0) {
      const drop = new Map(over);
      const seen = new Map();
      events = events.filter((e) => {
        if (!drop.has(e.taskId)) return true;
        const n = (seen.get(e.taskId) || 0) + 1;
        seen.set(e.taskId, n);
        return n > drop.get(e.taskId); // 丢最旧 drop.get(taskId) 条
      });
    }
    saveEvents(ctx, events);
  }
  // v2.9.27 Webhook 出口：fire-and-forget（绝不影响任务写路径）；v2.9.29 D1 修复——
  // 传懒加载器（webhookOut 内 60s TTL 缓存），禁用态不再每事件一次同步 config 读盘
  try {
    require('./webhookOut.js').fireTaskEvents(() => require('./giteaClient').loadConfig(), list);
  } catch (e) {
    console.error('[taskEvents] webhook 派发入口异常（不影响落盘）:', String((e && e.message) || e));
  }
  // v2.9.39 IM 通知（飞书/钉钉）：同样 fire-and-forget；只推 config.im.events 打开的两类
  //（待验收 / 已完成），未开启时零出网。异常不得影响任务写路径。
  try {
    require('./imNotify.js').fireTaskEvents(ctx, list);
  } catch (e) {
    console.error('[taskEvents] IM 派发入口异常（不影响落盘）:', String((e && e.message) || e));
  }
}

/** 某任务的事件，倒序（最新在前），≤100 条 */
function eventsForTask(ctx, taskId) {
  const events = loadEvents(ctx);
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < PER_TASK_LIMIT; i--) {
    if (events[i] && events[i].taskId === taskId) out.push(events[i]);
  }
  return out;
}

/** 删任务时顺带清理其事件；文件本就无该任务事件时不写盘（legacy 删除零写放大） */
function removeTaskEvents(ctx, taskId) {
  if (eventsBackend(ctx).backend === 'sqlite') {
    return storeDb.deleteEventsForTask(eventsDbPath(ctx), taskId);
  }
  const events = loadEvents(ctx);
  const kept = events.filter((e) => e && e.taskId !== taskId);
  if (kept.length !== events.length) saveEvents(ctx, kept);
  return events.length - kept.length;
}

function makeEvent(taskId, type, from, to, detail, at) {
  return { id: genEventId(), taskId, type, from: from === undefined ? null : from, to: to === undefined ? null : to, detail: detail || '', at };
}

/** created 事件：detail 含 origin 来源描述（收件箱确认入库任务），手工创建注明之 */
function createdEvent(task, at) {
  const origin = task && task.origin;
  const detail =
    origin && origin.type === 'inbox'
      ? `来源：收件箱候选 ${origin.refId}`
      : '手工创建';
  return makeEvent(task.id, 'created', null, task.status, detail, at);
}

/** assign 的 from/to 描述：agent:xx + member:yy，均空为「未指派」（双向清空也记） */
function assignDesc(t) {
  const parts = [];
  if (t.agentId) parts.push(`agent:${t.agentId}`);
  if (t.memberId) parts.push(`member:${t.memberId}`);
  return parts.length ? parts.join(' + ') : '未指派';
}

/**
 * PATCH 前后差异 → 事件列表（防噪：每字段类型最多一条）。
 * @param oldV/newV 变更前后的字段快照 {status, agentId, memberId, acceptorId, dueDate, priority, title, desc, notes}
 */
function patchEvents(taskId, oldV, newV, at) {
  const evts = [];
  // status：to === "done" 时类型特化为 completed
  if (oldV.status !== newV.status) {
    if (newV.status === 'done') {
      evts.push(makeEvent(taskId, 'completed', oldV.status, 'done', `状态 ${oldV.status} → done，任务完成`, at));
    } else {
      evts.push(makeEvent(taskId, 'status', oldV.status, newV.status, `状态 ${oldV.status} → ${newV.status}`, at));
    }
  }
  // assign：agentId 或 memberId 任一变更，一次 PATCH 合并为一条（detail 注明改了哪个字段）
  if (oldV.agentId !== newV.agentId || oldV.memberId !== newV.memberId) {
    const changed = [];
    if (oldV.agentId !== newV.agentId) changed.push('agentId');
    if (oldV.memberId !== newV.memberId) changed.push('memberId');
    evts.push(makeEvent(taskId, 'assign', assignDesc(oldV), assignDesc(newV), `指派变更（${changed.join('、')}）`, at));
  }
  // v2.0：accept——验收签字人变更/清除（独立于 assign：验收签字与负责人/执行者语义分离）
  if (oldV.acceptorId !== newV.acceptorId) {
    evts.push(
      makeEvent(
        taskId,
        'accept',
        oldV.acceptorId,
        newV.acceptorId,
        newV.acceptorId === null ? '清除验收人' : '验收人变更',
        at
      )
    );
  }
  // due：to 为新值或「清除」
  if (oldV.dueDate !== newV.dueDate) {
    evts.push(makeEvent(taskId, 'due', oldV.dueDate, newV.dueDate === null ? '清除' : newV.dueDate, '截止时间变更', at));
  }
  // priority
  if (oldV.priority !== newV.priority) {
    evts.push(makeEvent(taskId, 'priority', oldV.priority, newV.priority, `优先级 ${oldV.priority} → ${newV.priority}`, at));
  }
  // v2.9.4：bind——项目目录绑定/解绑（绑定≠挂接：ambient 关联，进时间轴可溯）
  if (oldV.projectDir !== newV.projectDir) {
    evts.push(
      makeEvent(
        taskId,
        'bind',
        oldV.projectDir,
        newV.projectDir == null ? null : newV.projectDir,
        newV.projectDir == null ? '解绑项目目录' : `绑定项目目录 ${newV.projectDir}`,
        at
      )
    );
  }
  // edit：title/desc/notes 变更，detail 注明改了什么字段，不存全文
  const edited = [];
  for (const f of ['title', 'desc', 'notes']) {
    if (oldV[f] !== newV[f]) edited.push(f);
  }
  if (edited.length > 0) {
    evts.push(makeEvent(taskId, 'edit', null, null, `编辑了 ${edited.join('、')}`, at));
  }
  // v2.0：done 联动——进 done 且已有验收人时额外补一条「验收通过」事件（与 completed 事件独立，
  // 验收人为空时不发）
  if (oldV.status !== newV.status && newV.status === 'done' && newV.acceptorId) {
    evts.push(makeEvent(taskId, 'accept', null, newV.acceptorId, `验收通过：by ${newV.acceptorId}`, at));
  }
  return evts;
}

/** PATCH 快照（只取事件相关字段，避免引用逃逸） */
function snapshotOf(task) {
  return {
    status: task.status,
    agentId: task.agentId,
    memberId: task.memberId,
    acceptorId: task.acceptorId, // v2.0：验收签字人（accept 事件差分依据）
    dueDate: task.dueDate,
    priority: task.priority,
    title: task.title,
    desc: task.desc,
    notes: task.notes,
    projectDir: task.projectDir, // v2.9.4：项目绑定/解绑差分依据
  };
}

module.exports = {
  PER_TASK_LIMIT,
  GLOBAL_LIMIT,
  loadEvents,
  saveEvents,
  appendEvents,
  eventsForTask,
  removeTaskEvents,
  makeEvent,
  createdEvent,
  patchEvents,
  snapshotOf,
};
