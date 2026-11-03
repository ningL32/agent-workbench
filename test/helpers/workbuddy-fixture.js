'use strict';

/**
 * workbuddy-fixture.js — 测试夹具：构造最小 workbuddy.db（sessions 表五列）
 *
 * computeMembers（lib/overview.js v2.5）与 agentActivity.workbuddyAdapter 共用同一只读源；
 * 测试经 config.agentActivity.sources.workbuddy.dbPath 注入本夹具，避免读到本机真实
 * ~/.workbuddy/workbuddy.db（101+ 条真实会话）导致用例不确定。
 * 列契约与适配器 SELECT 一致：id / cwd / title / status / created_at / last_activity_at。
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {string} dbPath 目标 db 文件（已存在则先删除重建）
 * @param {Array<{id:string,cwd:string,title:string,status:string,created_at:number,last_activity_at:number}>} rows
 */
function createWorkbuddyDb(dbPath, rows) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  try { fs.rmSync(dbPath, { force: true }); } catch (e) { /* 首建不存在 */ }
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE sessions (' +
    'id TEXT PRIMARY KEY, cwd TEXT, title TEXT, status TEXT, created_at INTEGER, last_activity_at INTEGER)'
  );
  // node:sqlite 命名参数（:name 占位符）——值走绑定不进 SQL 文本
  const insert = db.prepare(
    'INSERT INTO sessions (id, cwd, title, status, created_at, last_activity_at) ' +
    'VALUES (:id, :cwd, :title, :status, :createdAt, :lastActivityAt)'
  );
  for (const r of rows) {
    insert.run({ id: r.id, cwd: r.cwd, title: r.title, status: r.status, createdAt: r.created_at, lastActivityAt: r.last_activity_at });
  }
  db.close();
  return dbPath;
}

module.exports = { createWorkbuddyDb };
