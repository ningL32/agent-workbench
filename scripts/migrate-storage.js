#!/usr/bin/env node
'use strict';
/**
 * migrate-storage.js — v2.9.33 JSON→SQLite 迁移 CLI（SPEC-STORAGE §4）
 *
 * 用法：node scripts/migrate-storage.js [--dry-run] [--units messages,task_events] [--force]
 * 行为：见 lib/migration.js（前置备份→停机检查→校验→事务导入→对账→台账→JSON 改名归档）。
 * ⚠ 执行前必须停止所有 fde-console 实例（迁移器会探测 .instance.json 拒绝在跑状态）。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh');
const dataDir = path.join(base, 'fde-console', 'data');
if (!fs.existsSync(dataDir)) {
  console.error(`[migrate] 数据目录不存在: ${dataDir}`);
  process.exit(1);
}

const { runMigration } = require('../lib/migration.js');
try {
  const r = runMigration({
    dataDir,
    units: opt('--units') ? String(opt('--units')).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
  });
  console.log(`[migrate] ${r.dryRun ? 'DRY-RUN' : '完成'} db=${r.dbPath} 备份=${r.backupDir || '（dry-run 跳过）'}`);
  for (const u of r.units) {
    console.log(`  ✓ ${u.unit}: ${u.sourceRows} 行入库${u.badRows ? `（坏行 ${u.badRows} 未迁，见报告）` : ''}${u.archived ? `，原档 → ${path.basename(u.archived)}` : ''}`);
  }
  for (const s of r.skipped) console.log(`  - 跳过 ${s.unit}: ${s.reason}`);
  process.exit(0);
} catch (e) {
  console.error(`[migrate] 失败: ${e.code ? e.code + ' ' : ''}${e.message}`);
  process.exit(1);
}
