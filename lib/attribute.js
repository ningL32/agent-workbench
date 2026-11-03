'use strict';

/**
 * attribute.js — v1.9 分支约定最小切片②：Gitea 轮询落盘后的成果自动归因
 *
 * - 输入：data/tasks.json × data/activities.json 全量扫描（≤500 条动态 × 全部任务）
 * - 精确规则（命中任一即归因；与 §3 matchedTaskIds 的 ≥4 字模糊子串口径不同，宁缺勿滥）：
 *   a) activity.branch === task.branch（双方非空）
 *   b) activity.branch 以 task/<task.id> 开头（历史：已退役的本地 CLI 启动注入约定曾产生的分支）
 *   c) activity.title 含 [#<task.id>]（约定的提交信息前缀）
 * - 类型映射 kind：feeds 词表 commit→commit、pr→pr；存量词表 commit_pushed→commit、
 *   pr_opened/pr_merged→pr 保留（存量 activities.json 旧条目继续可归因）；
 *   branch_created/branch_deleted 与未知类型跳过；无 url（或非 http(s) 伪协议，防 javascript: 流入前端渲染）跳过
 * - 幂等：task.artifacts 已含同 url 一律跳过——轮询重复落盘/全量重扫不重复挂
 * - 命中：artifacts 追加 {url, kind, repo, ref, at, title, messageBody, attributedBy:'auto'}
 *   （v2.9.15 起 title/messageBody 随归因落库，提交说明成果区直读）+ 事件流 type:'artifact'
 *   （detail=自动归因：branch <branch> / 自动归因：提交 [#<taskId>]）+ updatedAt 刷新；
 *   无任务/无命中零写盘
 * - 调用点：lib/giteaClient.js pollActivities 落盘后（轮询器与 GET /api/activities?refresh=1
 *   两路自动生效）；归因异常由调用方记日志，绝不影响轮询成败
 */

const path = require('path');
const store = require('./store');
const taskEvents = require('./taskEvents');

const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * activity.type → artifact.kind 映射；不在表内（branch_created/branch_deleted 等）不归因。
 * feeds 词表（giteaClient activities/feeds 数据源）：commit/pr；
 * 旧词表 commit_pushed/pr_opened/pr_merged 保留容错——存量 activities.json 旧条目继续可归因。
 */
const KIND_BY_TYPE = {
  commit: 'commit',
  pr: 'pr',
  commit_pushed: 'commit',
  pr_opened: 'pr',
  pr_merged: 'pr',
};

// 与 server.js 手动挂接口径一致：仅接受 http(s) URL，杜绝 javascript: 等伪协议进 artifacts
const HTTP_URL_RE = /^https?:\/\/\S+$/i;

/** 成果内提交说明上限（与 v2.0 activity.messageBody ≤300 字同口径，title 同帽防超长落库） */
const ARTIFACT_TEXT_CAP = 300;

/** activity 文本 → 成果存储形态（null 容错 + 截帽） */
function artifactText(v) {
  return v == null ? null : String(v).slice(0, ARTIFACT_TEXT_CAP);
}

/** 约定分支名：task/<taskId>（与前端「复制分支名」按钮复制内容同构） */
function taskBranchName(taskId) {
  return `task/${taskId}`;
}

/**
 * 仓库护栏：双方 repo 已知且不同 → 一切匹配规则不出。
 * branch 名只在仓库内有意义——跨仓同名 branch（各仓都叫 main）曾把 demo-plan/
 * tds/demo-hub 的提交全灌进 fde-console 的任务（2026-10-30 业主实测报错，40 条脏归因）。
 * 任一方 repo 未知时不拦（无更强证据可用的，维持旧口径宁缺勿滥精神不打折：读侧
 * matchedTaskIds 同款护栏）。规则 b/c（task/<id> 前缀与 [#id] 标记）自带任务 id 本不可能
 * 跨仓，护栏放最前统一拦截。
 */
function repoMismatch(activity, task) {
  const ar = activity && typeof activity.repo === 'string' ? activity.repo.trim() : '';
  const tr = task && typeof task.repo === 'string' ? task.repo.trim() : '';
  return ar !== '' && tr !== '' && ar !== tr;
}

/**
 * 单条 activity × 单个任务的精确匹配（仓库护栏 → 规则 a → b → c，先命中先得）。
 * @param {{branch?:string|null, title?:string, repo?:string|null}} activity
 * @param {{id:string, branch?:string|null, repo?:string|null}} task
 * @returns {{rule:'branch_equal'|'branch_prefix'|'commit_ref', detail:string}|null} null=不命中
 */
function matchReason(activity, task) {
  if (repoMismatch(activity, task)) return null;
  const branch = activity && typeof activity.branch === 'string' ? activity.branch : '';
  const title = activity && typeof activity.title === 'string' ? activity.title : '';
  if (branch && task.branch && branch === task.branch) {
    return { rule: 'branch_equal', detail: `自动归因：branch ${branch}` };
  }
  if (branch && branch.startsWith(taskBranchName(task.id))) {
    return { rule: 'branch_prefix', detail: `自动归因：branch ${branch}` };
  }
  if (title && title.includes(`[#${task.id}]`)) {
    return { rule: 'commit_ref', detail: `自动归因：提交 [#${task.id}]` };
  }
  return null;
}

/**
 * 全量归因扫描（同步）。读 activities.json × 全部任务，命中即写 tasks.json + task_events.json。
 * url 去重保证幂等：重复扫描/重复轮询不产生重复成果；无任务/无动态/无命中均零写盘。
 * @param {{tasksPath:string, taskEventsPath:string, activitiesPath:string}} paths
 * @returns {{attributed:number, touched:number}} 新增成果数 / 被更新的任务数
 */
function attributeActivities(paths) {
  const ctx = {
    tasksPath: paths.tasksPath,
    taskEventsPath: paths.taskEventsPath,
    activitiesPath: paths.activitiesPath,
  };
  const data = store.loadTasks(ctx);
  if (!Array.isArray(data.tasks) || data.tasks.length === 0) return { attributed: 0, touched: 0 };
  const activities = store.loadActivities(ctx);
  if (activities.length === 0) return { attributed: 0, touched: 0 };

  const now = new Date().toISOString();
  const events = [];
  let attributed = 0;
  let touched = 0;

  for (const task of data.tasks) {
    if (!task || typeof task.id !== 'string' || !task.id) continue;
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
    const seenUrls = new Set(
      artifacts.map((a) => (a && typeof a.url === 'string' ? a.url : '')).filter(Boolean)
    );
    const before = artifacts.length;

    for (const act of activities) {
      const kind = KIND_BY_TYPE[act && act.type];
      if (!kind) continue; // branch_created/branch_deleted 与未知类型：跳过
      const url = typeof act.url === 'string' ? act.url : '';
      if (!url || !HTTP_URL_RE.test(url)) continue; // 无 url 跳过（顺带拦伪协议）
      if (seenUrls.has(url)) continue; // 幂等：同 url 已挂过（含同 PR 的 opened/merged 双动态）
      const hit = matchReason(act, task);
      if (!hit) continue;
      artifacts.push({
        url,
        kind,
        repo: act.repo == null ? null : String(act.repo),
        ref: act.branch == null ? null : String(act.branch),
        at: String(act.occurredAt || ''),
        // v2.9.15：提交说明随归因落库（成果区直接可读，不再只有裸 URL）；活动窗口滚动后仍可溯源
        title: artifactText(act.title),
        messageBody: artifactText(act.messageBody),
        attributedBy: 'auto',
      });
      seenUrls.add(url);
      events.push(taskEvents.makeEvent(task.id, 'artifact', null, null, hit.detail, now));
    }

    if (artifacts.length !== before) {
      task.artifacts = artifacts; // 存量任务无字段容错：首次归因时初始化
      task.updatedAt = now;
      touched += 1;
      attributed += artifacts.length - before;
    }
  }

  if (attributed === 0) return { attributed, touched }; // 无命中零写盘
  store.saveTasks(ctx, data);
  taskEvents.appendEvents(ctx, events);
  return { attributed, touched };
}

/**
 * v2.9.15 读取时回填（纯内存，不落盘）：按 url 从当前活动窗口补齐存量/手动成果缺的提交说明。
 * 历史部署的 tasks.json 在仓库外，归因写路径加字段不会回溯存量——与「按 config 过滤产出的键改动
 * 必须配读取时归一」同一纪律。会话成果自带 title 不参与；已有值不覆盖。
 * @returns {number} 回填的成果条数（测试观测用）
 */
function backfillArtifactMeta(tasks, activities) {
  const byUrl = new Map();
  for (const act of Array.isArray(activities) ? activities : []) {
    if (act && typeof act.url === 'string' && act.url) {
      byUrl.set(act.url, { title: artifactText(act.title), messageBody: artifactText(act.messageBody) });
    }
  }
  let filled = 0;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const arts = task && Array.isArray(task.artifacts) ? task.artifacts : [];
    for (const a of arts) {
      if (!a || a.kind === 'session' || !a.url) continue;
      const hasTitle = typeof a.title === 'string' && a.title.trim();
      if (hasTitle || !byUrl.has(a.url)) continue;
      const meta = byUrl.get(a.url);
      a.title = meta.title;
      a.messageBody = meta.messageBody;
      filled += 1;
    }
  }
  return filled;
}

/** 相对 dataDir 以项目根兜底（与 lib/giteaClient.js resolveDataPath 同口径；只拼路径不建目录） */
function dataPath(cfg, name) {
  const dir = path.isAbsolute(cfg.dataDir) ? cfg.dataDir : path.join(PROJECT_ROOT, cfg.dataDir);
  return path.join(dir, name);
}

/** pollActivities 落盘后的便捷入口：从 config 解析三个存储路径后扫描 */
function attributeAfterPoll(cfg) {
  return attributeActivities({
    tasksPath: dataPath(cfg, 'tasks.json'),
    taskEventsPath: dataPath(cfg, 'task_events.json'),
    activitiesPath: dataPath(cfg, 'activities.json'),
  });
}

module.exports = { KIND_BY_TYPE, taskBranchName, repoMismatch, matchReason, attributeActivities, attributeAfterPoll, backfillArtifactMeta, ARTIFACT_TEXT_CAP };
