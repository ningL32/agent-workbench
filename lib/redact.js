'use strict';
// redact.js — 凭据脱敏单一出口（SPEC §5-③）。
// 规则：所有日志/错误/落盘文本必经 redact()，按两个维度过滤：
//   a) 按 key（config.security.redactKeys = ["Authorization","extraheader"]，大小写不敏感）：
//      覆盖 HTTP 头 `Key: value`、JSON `"key":"value"`、git-config `key=value` 三种形态；
//   b) 按凭据原值：registerSecret 注册的值与 extraSecrets 参数，每次出现都替换。
// 敏感值仅存本模块内存 Set；本模块绝不写任何文件、绝不打印自身内容。

const DEFAULT_KEYS = ['Authorization', 'extraheader'];

/** @type {Set<string>} 仅内存的凭据原值集合 */
const secrets = new Set();

/** @type {string[]} 按 key 过滤的键名（大小写不敏感） */
let keys = DEFAULT_KEYS.slice();

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 注册凭据原值（仅内存）。短于 4 字符的值忽略（无脱敏意义）。
 * @param {string|null|undefined} value
 */
function registerSecret(value) {
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (v.length >= 4) secrets.add(v);
}

/** 清空内存凭据集合（仅测试用） */
function clearSecrets() {
  secrets.clear();
}

/**
 * 设置按 key 过滤的键名列表（来自 config.security.redactKeys）。
 * @param {string[]|undefined} list
 */
function setRedactKeys(list) {
  if (Array.isArray(list) && list.length) keys = list.map(String);
}

/**
 * 脱敏任意文本（错误 message、日志行、JSON 串等）。
 * @param {unknown} text 任意可字符串化的值
 * @param {string[]} [extraSecrets] 额外要按值过滤的凭据
 * @returns {string}
 */
function redact(text, extraSecrets = []) {
  let out = text == null ? '' : String(text);

  // b) 按凭据原值过滤（先做，保证整串凭据优先被整体抹除）
  const pool = extraSecrets.concat([...secrets]);
  for (const s of pool) {
    if (typeof s === 'string' && s.length >= 4) {
      out = out.split(s).join('[REDACTED]');
    }
  }

  // a) 按 key 过滤
  for (const key of keys) {
    const k = escapeRegExp(key);
    // 形态 1：`Key: value` / `key=value`（HTTP 头、git-config、一般键值）。
    // 值允许多段（如 "Basic xxx"），到行尾或分隔符为止
    out = out.replace(new RegExp(`(${k}\\s*[:=]\\s*)[^\\r\\n,;&"'}\\]]+`, 'gi'), '$1[REDACTED]');
    // 形态 2：JSON 双引号 `"key":"value"`
    out = out.replace(new RegExp(`("${k}"\\s*:\\s*")([^"]*)"`, 'gi'), '$1[REDACTED]"');
    // 形态 3：JSON 单引号 `'key':'value'`
    out = out.replace(new RegExp(`('${k}'\\s*:\\s*')([^']*)'`, 'gi'), "$1[REDACTED]'");
  }

  return out;
}

module.exports = { redact, registerSecret, clearSecrets, setRedactKeys, getRedactKeys: () => keys.slice() };
