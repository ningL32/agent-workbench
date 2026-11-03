#!/usr/bin/env node
'use strict';
/**
 * backup-data.js — 数据备份 CLI（薄壳；实现已下沉 lib/backup.js，与每日自动备份、REST API 共用一条代码路径）
 *
 * 用法（与 v2.9.7 完全一致）：
 *   node scripts/backup-data.js                       # 默认源/目标，保留 14 份
 *   node scripts/backup-data.js --keep 24
 *   node scripts/backup-data.js --source <dir> --out <dir>
 *
 * 红线：本脚本只读源目录；不触碰凭据（凭据在 git config，本来就不在数据目录里）。
 * 说明：v2.9.41 起备份也有了自动档（config.backup，默认每天 09:05，保留 14 份）与恢复接口。
 */

const { backupOnce, defaultSource, KEEP_DEFAULT } = require('../lib/backup.js');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') out.source = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--keep') out.keep = Number(argv[++i]);
    else if (a === '--now') out.now = Number(argv[++i]); // 测试注入时间戳
  }
  return out;
}

module.exports = { backupOnce, parseArgs, defaultSource, KEEP_DEFAULT };

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const r = backupOnce(args);
    console.log(`✓ 备份完成: ${r.dir}`);
    console.log(`  文件 ${r.files.length} 个，共 ${r.files.reduce((s, f) => s + f.bytes, 0)} 字节；滚动清理 ${r.pruned.length} 份旧备份`);
  } catch (e) {
    console.error(`✗ 备份失败: ${e.message}`);
    process.exit(1);
  }
}
