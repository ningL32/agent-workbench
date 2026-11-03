'use strict';
// ssrfGuard.js — 出站 SSRF 防护（SPEC §5-②）。
// 规则：
//   1. 出站协议必须 ∈ config.security.allowedProtocols（默认 ["https"]）；
//   2. URL host（不分大小写）必须 === config.gitea.hostWhitelist 某项（精确匹配，天然免疫子域伪装）；
//   3. 白名单含 localhost/环回/私有段/保留段字面量时启动即抛错；
//   4. 任何违规都在发起请求之前完成——本模块纯同步、零 IO、零出站。
// 对外错误统一 code='HOST_NOT_ALLOWED'（§3 /api/gitea/test 白名单外 → 400 HOST_NOT_ALLOWED）。

/**
 * host 是否为危险字面量（localhost/环回/私有/保留段）。
 * 支持 IPv4 点分十进制与 IPv6 字面量（含方括号形式）。
 * @param {string} host
 * @returns {boolean}
 */
function isDangerousHost(host) {
  const h = String(host || '').toLowerCase().trim().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'localhost.localdomain') return true;

  if (h.includes(':')) {
    // IPv6 字面量
    const v6 = h.replace(/^\[/, '').replace(/\]$/, '');
    if (v6 === '::' || v6 === '::1') return true; // 未指定 / 环回
    const low = v6.toLowerCase();
    if (/^f[cd][0-9a-f]{2}:/.test(low)) return true; // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(low)) return true; // fe80::/10 链路本地
    return false;
  }

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false; // 普通域名
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a > 255 || b > 255) return true; // 非法即拒
  if (a === 0) return true;                    // 0.0.0.0/8 "本网络"
  if (a === 10) return true;                   // 私有
  if (a === 127) return true;                  // 环回
  if (a === 169 && b === 254) return true;     // 链路本地（含 169.254.169.254 元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 私有
  if (a === 192 && b === 168) return true;     // 私有
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;       // 192.0.0.x / 192.0.2.x 保留
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试
  if (a === 198 && b === 51) return true;      // 198.51.100.x 保留
  if (a === 203 && b === 0) return true;       // 203.0.113.x 保留
  if (a >= 224) return true;                   // 组播/保留/广播
  return false;
}

/**
 * 校验出站 URL；违规抛 Error({code:'HOST_NOT_ALLOWED'})。纯同步，零出站。
 * @param {string} rawUrl
 * @param {{security?:{allowedProtocols?:string[]}, gitea?:{hostWhitelist?:string[]}}} cfg
 * @returns {URL} 解析后的 URL
 */
function assertSafeUrl(rawUrl, cfg) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    const err = new Error(`URL 非法: ${String(rawUrl)}`);
    err.code = 'HOST_NOT_ALLOWED';
    throw err;
  }

  const protocols = ((cfg && cfg.security && cfg.security.allowedProtocols) || ['https'])
    .map((p) => String(p).toLowerCase());
  const proto = url.protocol.replace(/:$/, '').toLowerCase();
  if (!protocols.includes(proto)) {
    const err = new Error(`协议不允许: ${proto}（仅允许 ${protocols.join(', ')}）`);
    err.code = 'HOST_NOT_ALLOWED';
    throw err;
  }

  // v2.9：白名单 = gitea 节 ∪ github 节 ∪ gitee 节（v2.9.18 加 gitee；cfg 无某节时行为与旧版一致）
  const whitelist = [
    ...((cfg && cfg.gitea && cfg.gitea.hostWhitelist) || []),
    ...((cfg && cfg.github && cfg.github.hostWhitelist) || []),
    ...((cfg && cfg.gitee && cfg.gitee.hostWhitelist) || [])
  ];
  const host = url.hostname.toLowerCase(); // WHATWG URL hostname 已小写化、IPv6 去方括号
  const ok = whitelist.some((w) => String(w).toLowerCase() === host);
  if (!ok) {
    const err = new Error(`host 不在白名单: ${host}`);
    err.code = 'HOST_NOT_ALLOWED';
    throw err;
  }
  return url;
}

/**
 * 白名单体检：gitea/github/gitee 三节任一项命中 localhost/环回/私有/保留段字面量即抛错（启动期调用）。
 * @param {{gitea?:{hostWhitelist?:string[]}, github?:{hostWhitelist?:string[]}}} cfg
 * @returns {true}
 */
function validateWhitelist(cfg) {
  validateWhitelistEntries((cfg && cfg.gitea && cfg.gitea.hostWhitelist) || []);
  validateWhitelistEntries((cfg && cfg.github && cfg.github.hostWhitelist) || []);
  return validateWhitelistEntries((cfg && cfg.gitee && cfg.gitee.hostWhitelist) || []);
}

/**
 * 白名单条目体检（通用形态，任务雷达 dingtalk.hostWhitelist 复用同一红线）：
 * 任一项命中 localhost/环回/私有/保留段字面量、或含协议前缀即抛错。
 * @param {string[]} entries
 * @returns {true}
 */
function validateWhitelistEntries(entries) {
  const whitelist = entries || [];
  for (const w of whitelist) {
    if (isDangerousHost(w)) {
      const err = new Error(`白名单含禁止的主机字面量: ${w}（localhost/环回/私有/保留段不得入白名单）`);
      err.code = 'DANGEROUS_WHITELIST_ENTRY';
      throw err;
    }
    // 白名单项若形如 http://xxx，说明写法错误，一并拒绝
    if (String(w).includes('://')) {
      const err = new Error(`白名单项必须是纯 host，不得含协议: ${w}`);
      err.code = 'DANGEROUS_WHITELIST_ENTRY';
      throw err;
    }
  }
  return true;
}

/**
 * host 是否命中白名单：精确相等，或为某条目的子域（点边界后缀匹配，如
 * shanji.dingtalk.com 命中 dingtalk.com；evil-dingtalk.com 不命中）。
 * 大小写不敏感。gitea 主链路继续走 assertSafeUrl 的精确匹配，行为不变。
 * @param {string} host
 * @param {string[]} entries
 * @returns {boolean}
 */
function hostAllowed(host, entries) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return (entries || []).some((w) => {
    const e = String(w || '').toLowerCase().trim().replace(/\.$/, '');
    if (!e) return false;
    return h === e || h.endsWith('.' + e);
  });
}

module.exports = { assertSafeUrl, validateWhitelist, validateWhitelistEntries, hostAllowed, isDangerousHost };
