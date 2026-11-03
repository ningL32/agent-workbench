'use strict';

/**
 * opencode-fixture.js — 测试夹具：构造最小 opencode.db（session 表五列）
 *
 * 列契约与 v2.6 opencodeAdapter 的 SELECT 一致：id / directory / title / time_created / time_updated
 * （time_created/time_updated 为毫秒整数）。测试经 config.agentActivity.sources.opencode.dbPath 注入，
 * 避免读本机真实 ~/.local/share/opencode/opencode.db。
 */

const fs = require('fs');
const path = require('path');

function createOpencodeDb(dbPath, rows) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  try { fs.rmSync(dbPath, { force: true }); } catch (e) { /* 首建不存在 */ }
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE session (' +
    'id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)'
  );
  const insert = db.prepare(
    'INSERT INTO session (id, directory, title, time_created, time_updated) ' +
    'VALUES (:id, :directory, :title, :timeCreated, :timeUpdated)'
  );
  for (const r of rows) {
    insert.run({ id: r.id, directory: r.directory, title: r.title, timeCreated: r.time_created, timeUpdated: r.time_updated });
  }
  db.close();
  return dbPath;
}

module.exports = { createOpencodeDb };
