'use strict';

/**
 * public-hygiene.test.js — 公开面卫生守卫（v2.9.81）
 *
 * 背景：本仓直接在公开仓开发（不再经内部镜像工具的禁词闸门），需要一道不依赖任何
 * 「具体名单」的防线——名单本身不能进公开仓（等于把要藏的东西列出来）。
 *
 * 做法：只放**形态类**规则，扫 git 跟踪文件（= 发布面）。命中即红，消息里给出文件与形态。
 *   （下列说明刻意不用可被规则匹配的字面示例——本文件自己也在扫描范围内，写实例会自咬。）
 *   H1 本机家目录绝对路径      Windows / Unix 家目录下带具体用户名的路径
 *   H2 个人工作区路径形态      非家目录的盘符路径，且目录名里含中日韩文字
 *   H3 真实邮箱地址            除占位域（example 系 / .invalid / .test）外的邮箱
 *   H4 常见凭据形态            各家 token / API key 的固定前缀 + 足够长度，或 PEM 私钥头
 *   H5 npm 打包面不得夹带运行态配置  files 白名单不含 config / agents / members 三个 json 与 data 目录
 *
 * 豁免两层：①明显占位名（Users/me、home/user）与占位文案行（placeholder=/示例）规则内排除；
 *          ②确需保留真实路径形态的夹具按文件登记 ALLOW，必须带理由。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split('\0')
    .filter(Boolean);
  return out;
}

function readText(rel) {
  // 二进制文件（png/svg 之外的图片等）读成 utf8 会得到乱码但不会抛；按扩展名直接跳过
  if (/\.(png|jpe?g|gif|ico|webp|zip|tgz|db|woff2?)$/i.test(rel)) return null;
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch (e) {
    return null;
  }
}

// 按文件豁免（必须带理由）
const ALLOW = new Map([
  // 该文件直接测 decodeProjectDirName：必须喂「含 CJK 目录名的真实形态路径」与「含家目录的临时目录名」
  // 才能验证 ~HEX4 码点解码与盘符还原。路径值均为通用示例词（工作区/demoproject）与
  // Windows 默认管理员账户名，不含任何个人身份。改动该文件时保持这一前提。
  ['test/agent-activity.test.js', 'decodeProjectDirName 解码用例：必须保留含 CJK 目录名与家目录形态的真实路径夹具'],
]);

// UI 占位文案（placeholder 里给用户看的示例路径，非真实数据）
const PLACEHOLDER_HINTS = /placeholder=|示例|比如|e\.g\.|<[^>]+>/;

const RULES = [
  {
    id: 'H1 本机家目录绝对路径',
    // `Users/me`、`home/user` 这类明显占位不算
    re: /(?:[A-Za-z]:\\{1,2}Users\\{1,2}(?!me\b|user\b|you\b|<)[A-Za-z0-9._-]+|\/(?:home|Users)\/(?!me\b|user\b|you\b|<)[A-Za-z0-9._-]+\/)/g,
    skip: (rel) => ALLOW.has(rel),
  },
  {
    id: 'H2 个人工作区路径形态（盘符路径含 CJK 目录名）',
    // 盘符必须是独立单词（\b[A-Za-z]: —— 否则 "Keywords:\n看板" 这种「冒号+转义换行」会误中）；
    // 分隔符 1 个（原文）或 2 个（JS/JSON 转义）反斜杠；行内含 placeholder=/示例 提示的是占位文案，跳过
    re: /\b[A-Za-z]:(?:\\{1,2})[^\s"'`<>|*?:\\]+[\u4e00-\u9fff][^\s"'`<>|*?:\\]*(?:\\{1,2})/g,
    filter: (m, line) => !PLACEHOLDER_HINTS.test(line),
    skip: (rel) => ALLOW.has(rel),
  },
  {
    id: 'H3 真实邮箱地址',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    // 占位域与保留域不算：example.com/.org/.net、*.example、*.invalid、*.test、*.localhost
    filter: (m) => !/@(?:[A-Za-z0-9.-]*\.?example(?:\.(?:com|org|net))?|[A-Za-z0-9.-]+\.invalid|[A-Za-z0-9.-]+\.test|localhost)\b/i.test(m),
    skip: () => false,
  },
  {
    id: 'H4 常见凭据形态',
    re: /(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|xox[bp]-[A-Za-z0-9-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g,
    skip: () => false,
  },
];

test('H1-H4: 公开面（git 跟踪文件）不含本机路径 / 个人工作区路径 / 真实邮箱 / 凭据形态', () => {
  // arrange
  const files = trackedFiles();
  assert.ok(files.length > 0, 'git ls-files 应返回跟踪文件');
  const hits = [];
  // act
  for (const rel of files) {
    const text = readText(rel);
    if (text === null) continue;
    for (const rule of RULES) {
      if (rule.skip(rel)) continue;
      // 逐行扫：filter 可拿到所在行上下文（判定占位文案）
      for (const line of text.split('\n')) {
        const found = line.match(rule.re) || [];
        const kept = rule.filter ? found.filter((m) => rule.filter(m, line)) : found;
        for (const m of kept) hits.push(`${rel} :: ${rule.id} :: ${m}`);
      }
    }
  }
  // assert
  assert.deepEqual(
    hits, [],
    `[public-hygiene] 公开面命中敏感形态（修源文件；确属夹具必需则在 ALLOW 登记并写理由）：\n  ${hits.join('\n  ')}`
  );
});

test('H5: npm files 白名单不夹带运行态配置与数据目录', () => {
  // arrange
  const forbidden = ['config.json', 'agents.json', 'members.json', 'data/', 'data'];
  // act
  const present = forbidden.filter((f) => Array.isArray(pkg.files) && pkg.files.includes(f));
  // assert
  assert.deepEqual(
    present, [],
    `[public-hygiene] package.json files 不得包含运行态文件（config.json 是下游令牌落点）：${present.join(', ')}`
  );
});
