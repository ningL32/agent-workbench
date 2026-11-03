'use strict';

/**
 * jobs.js — 雷达后台任务注册表（进程内内存态，单用户语义）
 *
 * 为什么进程内不落盘：任务只是"进度指示器"，其产物（消息池 analyzedAt、候选卡、
 * ANALYZE_FAILED 标记）全部落盘。服务重启丢掉的只是进行中任务的进度视图，
 * 重放安全——同一批 messageIds 重新 POST /api/radar/analyze 即可续跑。
 *
 * 滚动保留最近 MAX_JOBS 个；id 形如 job-<base36ms>-<seq>。
 */

const jobs = new Map();
let seq = 0;
const MAX_JOBS = 50;

function createJob(kind, total) {
  const id = `job-${Date.now().toString(36)}-${++seq}`;
  const job = {
    id,
    kind, // 'sync' | 'analyze'
    state: 'running', // running | done | partial | failed
    total: Number(total) || 0,
    done: 0,
    current: null, // 正在处理的条目描述
    results: [], // {item, ok, ...详情, error?}
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  jobs.set(id, job);
  while (jobs.size > MAX_JOBS) {
    jobs.delete(jobs.keys().next().value);
  }
  return job;
}

function getJob(id) {
  return jobs.get(String(id)) || null;
}

/** 任务收尾：全 ok → done；部分失败 → partial；外层异常 → failed */
function finishJob(job) {
  if (job.state === 'running') {
    job.state = job.results.length > 0 && job.results.every((r) => r.ok) ? 'done' : 'partial';
    if (job.results.length === 0 && job.total === 0) job.state = 'done';
  }
  job.finishedAt = new Date().toISOString();
}

/** 任务视图（对外输出前克隆，防调用方改内部态） */
function jobView(job) {
  return JSON.parse(JSON.stringify(job));
}

module.exports = { createJob, getJob, finishJob, jobView };
