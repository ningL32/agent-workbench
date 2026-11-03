#!/usr/bin/env node
'use strict';
/**
 * mcp-server.mjs — v2.9.27 FDE 指挥台 MCP Server（stdio transport 壳）
 *
 * 协议核心在 lib/mcpCore.js（纯函数、可直测）；本文件只做 stdin/stdout 接线。
 * 协议：JSON-RPC 2.0，newline-delimited（MCP stdio transport 惯例）。
 *
 * 用法（以 Claude Code 为例，其他 agent 的 MCP 配置同理）：
 *   { "mcpServers": { "fde": { "command": "node", "args": ["<仓库>/scripts/mcp-server.mjs"] } } }
 *
 * 安全：三工具全只读（不写 data/）；stdio 零 TCP 监听；数据不出本机（红线 7）。
 * 日志走 stderr（stdout 是协议通道，污染即炸）。
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(pathToFileURL(path.join(__dirname, '..', 'package.json')).href);
const { handle } = require_('../lib/mcpCore.js');
const VERSION = require_('../package.json').version;

function loadConfig() {
  const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  const configPath = path.join(base, 'fde-console', 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return {};
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      process.stderr.write(`[mcp] 非 JSON 行忽略: ${line.slice(0, 80)}\n`);
      continue;
    }
    try {
      const out = handle(msg, loadConfig);
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    } catch (e) {
      process.stderr.write(`[mcp] 处理异常: ${e.message}\n`);
      if (msg && msg.id !== undefined && msg.id !== null) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'internal error' } }) + '\n');
      }
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`[mcp] fde-console MCP server v${VERSION} ready (stdio)\n`);
