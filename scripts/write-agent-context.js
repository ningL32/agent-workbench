#!/usr/bin/env node
'use strict';
/**
 * write-agent-context.js — v2.9.27 Agent 上下文注入 CLI（数字员工互知）
 *
 * 用法：node scripts/write-agent-context.js [--days 1]
 * 行为：读 ~/.dsh/fde-console/config.json 的 agentContext 节
 *   { enabled: true, dirs: ["E:\\path\\to\\project", ...] }
 * 把近 N 天各 agent 会话战况写成 <dir>/.fde/daily.md（仅白名单目录；enabled!==true 直接退出）。
 * 建议挂任务计划程序每日早晨跑一次；或 agent 会话启动前由包装脚本调用。
 * （纯手动形态=零常驻零自动写盘；后续可挂 pollTick 自动档，等业主拍板。）
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function loadConfig() {
  const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  const configPath = path.join(base, 'fde-console', 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`[agent-context] 读不到配置 ${configPath}：${e.message}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : undefined;

const { writeAgentContext } = require('../lib/agentContext.js');
const config = loadConfig();
const r = writeAgentContext(config, { days });
if (r.written.length === 0 && r.skipped.length === 1 && r.skipped[0].reason.includes('enabled')) {
  console.error('[agent-context] agentContext.enabled 未开启（config.json 里设为 true 并填 dirs 白名单）');
  process.exit(1);
}
for (const w of r.written) console.log(`✓ 已写入 ${w.file}`);
for (const s of r.skipped) console.log(`- 跳过 ${s.dir}：${s.reason}`);
