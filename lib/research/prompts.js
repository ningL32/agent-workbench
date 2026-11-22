'use strict';

/**
 * lib/research/prompts.js — 提示词资产加载器（SPEC-RESEARCH §4）
 *
 * 纪律（沿 ai-scene ADR-102，已竣工实证）：
 *  - prompts/*.md 随包发布（package.json files 白名单）；第一行必须是 `version: X.Y.Z`
 *  - 缺版本标记 → 加载即抛错（startup fail-fast，杜绝"改了文件不升版本"的漂移）
 *  - 每次读取计算 sha256 —— 调用方把 全文+版本+sha256 快照进 interview_messages 行内，
 *    保证旧会话可解释性不随提示词演进漂移
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION_RE = /^version:\s*(\d+\.\d+\.\d+)\s*$/;
let cache = null; // 同进程提示词只在启动期变化,读一次缓存;测试用 clear()

function promptsDir() {
  return path.join(__dirname, '..', '..', 'prompts');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 加载单个提示词资产 → {name, version, sha256, text}；缺版本/空文件抛错 */
function load(name) {
  const file = path.join(promptsDir(), `${name}.md`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`提示词资产缺失: prompts/${name}.md`);
  }
  const firstLine = (text.split('\n', 1)[0] || '').trim();
  const m = VERSION_RE.exec(firstLine);
  if (!m) {
    throw new Error(`提示词资产 prompts/${name}.md 首行缺 "version: X.Y.Z" 标记（启动 fail-fast）`);
  }
  return { name, version: m[1], sha256: sha256(text), text };
}

/** 枚举全部资产 → [{name, version, sha256}]（目录列表;缺目录=空数组+console.error 留痕） */
function list() {
  let entries;
  try {
    entries = fs.readdirSync(promptsDir()).filter((f) => f.endsWith('.md'));
  } catch (e) {
    console.error(`[research/prompts] prompts 目录缺失: ${(e && e.message) || e}`);
    return [];
  }
  return entries.map((f) => {
    const full = load(f.replace(/\.md$/, ''));
    return { name: full.name, version: full.version, sha256: full.sha256 };
  });
}

function clear() {
  cache = null;
}

module.exports = { load, list, sha256, clear };
