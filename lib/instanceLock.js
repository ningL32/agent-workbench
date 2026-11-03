'use strict';

/**
 * instanceLock.js — v2.9.43 单实例登记（检测 + 告警，不硬拦）
 *
 * 背景（真事故，不是假想）：v2.9.25 桌面版 DSH 与 CLI 实例同跑、共享同一份 data/，
 * 桌面版内存里的旧代码每 60s 继续写脏归因（16:04 一次 65 条，累计清理 156 条）。
 * 当时的结论是「杀干净一个实例不等于修复完成，修复必须以全部实例都跑新代码为完成态」。
 *
 * 本模块只解决**知情**问题：启动时登记自己，同时看有没有别的存活实例共用同一个 base 目录。
 * 刻意**不硬拦**——插件跑在宿主进程里，拒绝启动会连带把整个 DSH 拖下水；正确做法是
 * 启动日志 + 顶栏告警 + /api/instance 查询，让人自己决定杀哪一个。
 *
 * 落点：`<base>/.instance.json`（base = 配置目录，通常是 ~/.dsh/fde-console）。
 * 形如 {updatedAt, instances:[{pid, startedAt, version, port}]}，只保留存活条目。
 * 写入走 store.writeJSON（tmp+rename 原子写），与其它数据文件同一纪律。
 */

const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');

const LOCK_FILE = '.instance.json';

function lockPath(baseDir) {
  return path.join(baseDir, LOCK_FILE);
}

/** pid 是否存活：EPERM 视为存活（存在但无权限，Windows 同用户极少见） */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

function readLock(baseDir) {
  try {
    const d = store.readJSON(lockPath(baseDir), null);
    if (!store.isPlainObject(d)) return { updatedAt: null, instances: [] };
    const list = Array.isArray(d.instances) ? d.instances : [];
    return {
      updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : null,
      instances: list.filter((x) => x && Number.isInteger(x.pid)),
    };
  } catch (e) {
    return { updatedAt: null, instances: [] };
  }
}

/** 当前存活的其它实例（不含自己） */
function othersLive(baseDir, selfPid) {
  const self = selfPid || process.pid;
  return readLock(baseDir).instances.filter((x) => x.pid !== self && isAlive(x.pid));
}

/**
 * 登记自己并返回 {self, others}：
 * - 先清掉已死条目（进程被强杀后残留的 pid 不制造假告警）
 * - others = 登记时刻仍然存活的其它实例（启动日志据此告警）
 */
function acquire(baseDir, meta) {
  const m = meta || {};
  const now = new Date().toISOString();
  const self = {
    pid: process.pid,
    startedAt: now,
    version: typeof m.version === 'string' ? m.version : null,
    port: Number.isInteger(m.port) ? m.port : null,
  };
  const alive = othersLive(baseDir); // 只保留存活者（含自己之外的）
  const others = alive.filter((x) => x.pid !== self.pid);
  const next = {
    updatedAt: now,
    instances: [...others, self],
  };
  try {
    store.writeJSON(lockPath(baseDir), next);
  } catch (e) {
    // 登记失败不该阻断启动：退回「不登记」状态，但把原因留给调用方
    return { self, others, error: String((e && e.message) || e) };
  }
  return { self, others };
}

/** 退出时把自己摘掉；没有别人的话顺手删文件（不给下一次启动留垃圾） */
function release(baseDir, pid) {
  const me = pid || process.pid;
  try {
    const lock = readLock(baseDir);
    const rest = lock.instances.filter((x) => x.pid !== me && isAlive(x.pid));
    if (rest.length === 0) {
      fs.rmSync(lockPath(baseDir), { force: true });
      return { released: true, remaining: 0 };
    }
    store.writeJSON(lockPath(baseDir), { updatedAt: new Date().toISOString(), instances: rest });
    return { released: true, remaining: rest.length };
  } catch (e) {
    return { released: false, error: String((e && e.message) || e) };
  }
}

/** 运行期查询：{self, others, multiInstance}（不写盘） */
function status(baseDir, selfPid) {
  const me = selfPid || process.pid;
  const lock = readLock(baseDir);
  const self = lock.instances.find((x) => x.pid === me) || null;
  const others = lock.instances.filter((x) => x.pid !== me && isAlive(x.pid));
  return {
    self,
    others,
    multiInstance: others.length > 0,
    startedAt: self ? self.startedAt : null,
    lockPath: lockPath(baseDir),
  };
}

module.exports = { LOCK_FILE, lockPath, isAlive, acquire, release, status, othersLive };
