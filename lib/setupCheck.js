'use strict';

/**
 * setupCheck.js — 环境体检聚合（分发部署自检，GET /api/setup/check）
 *
 * 目的：fde-console 分发给新机器时，新人在设置页一键体检即可知道缺什么、怎么修。
 * 五项探测互不阻塞（各自 try/catch，单项失败/抛错不影响其余项）：
 *   1. node       —— 运行时版本展示（恒 ok）
 *   2. dws        —— 钉钉采集 CLI 可执行性（spawnSync --version/--help，5s 超时）
 *   3. dsh        —— 分析引擎入口可解析性（resolveDshBin + --version）
 *   4. llmRoute   —— dsh 的 LLM 路由文件存在性（~/.dsh/settings.yaml + .credentials.yaml，
 *                    文件级检查，不做真实 LLM 调用）
 *   5. gitea      —— 复用 giteaClient.testConnection（3s 预算，超时按失败表达）
 *   v2.2：cliGateway 项已随 网关集成整体移除（业主 2026-10-20；六项收敛为五项）
 * 脱敏：所有 detail 经 redact()（探测输出可能夹带路径/环境信息）；hint 为静态文案不含凭据；
 *       本端点绝不回显凭据值（凭据仍仅内存，见 redact.js）。
 * 可测性：runSetupCheck(config, deps) 支持逐项注入探测替换与 existsSync/giteaTest 注入
 *       （离线测试不 spawn 真实二进制、不出网）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const giteaClient = require('./giteaClient');
const { redact } = require('./redact');

const HINTS = {
  dws: '钉钉工作台 CLI 未安装或未登录，请先安装 dws 并完成钉钉登录',
  dsh: 'dsh 未安装（npm i -g @deepseek-ai/dsh）',
  llmRoute: '未找到默认模型路由：0.2.1+ 在 profiles/<name>/cordis.patch.yml 配置 agent-default-model（provider/model）；旧版为 ~/.dsh/settings.yaml + .credentials.yaml',
  giteaUnreachable: '无法连接 Gitea：检查网络连通性与 baseUrl 是否可达',
  larkcli: 'lark-cli 未安装（npm i -g @larksuite/cli），安装后运行 lark-cli config init 完成飞书应用配置并 lark-cli auth login 完成用户授权',
};

/** 探测抛错时的兜底 hint（与各项主失败 hint 同源，保证任何路径都有修复指引） */
const FALLBACK_HINT = {
  node: null,
  dws: HINTS.dws,
  dsh: HINTS.dsh,
  llmRoute: HINTS.llmRoute,
  gitea: HINTS.giteaUnreachable,
  larkcli: HINTS.larkcli,
};

/** 从任意命令输出提取语义版本号（"dws version v1.0.59 (…)"、"0.1.0-rc.7" 均命中） */
function versionOf(text) {
  const m = /(\d+\.\d+\.\d+(?:[^\s\r\n]*))/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** dsh 配置目录：~/.dsh（DSH_HOME 设置时为 <DSH_HOME>/.dsh，与插件配置落点同一约定） */
function dshHomeDir() {
  const envHome = process.env.DSH_HOME && String(process.env.DSH_HOME).trim();
  return path.join(envHome || os.homedir(), '.dsh');
}

// ------------------------------------------------------------------ 探测实现

/** ① Node 运行时：恒 ok（展示用，本服务就跑在它上面） */
function probeNode() {
  return {
    ok: true,
    detail: `Node.js ${process.version}（${process.platform}-${process.arch}）`,
    hint: null,
  };
}

/** ② dws（钉钉采集，可选组件）：bin 可解析 + 可执行；未安装 = ok:true + optional（开源用户零噪音，
 *  只损失雷达钉钉同步，其余功能不受影响——2026-11-03 开源发布工程口径） */
function probeDws(config) {
  if (process.env.DINGTALK_FIXTURE) {
    return { ok: true, detail: 'fixture 模式（零进程采集，未探测真实 CLI）', hint: null };
  }
  // 延迟 require：与 radar 引擎端点同款，避免模块图在装配期展开
  const { resolveDwsBin } = require('./dingtalk');
  const bin = resolveDwsBin(config);
  if (!bin) {
    return {
      ok: true,
      optional: true,
      detail: '未安装（可选）——任务雷达钉钉同步不可用，其余功能不受影响',
      hint: HINTS.dws,
    };
  }
  let v = spawnSync(bin, ['--version'], { timeout: 5000, windowsHide: true });
  if (v.error || v.status !== 0) {
    v = spawnSync(bin, ['--help'], { timeout: 5000, windowsHide: true });
  }
  if (v.error) {
    return {
      ok: false,
      detail: `dws 不可执行：${v.error.code || v.error.message}（${bin}）`,
      hint: HINTS.dws,
    };
  }
  const version = versionOf(String(v.stdout || '') + String(v.stderr || ''));
  return { ok: true, detail: `dws${version ? ` ${version}` : ''} 可执行（${bin}）`, hint: null };
}

/** ②-b lark-cli（飞书妙记采集，可选组件）：bin 可解析 + 原生 exe 存在性（文件级检查，零 spawn）；
 *  未安装 = ok:true + optional（与 dws 同款开源口径；可执行性由雷达同步真实兜底） */
function probeLarkCli(config) {
  if (process.env.LARK_FIXTURE) {
    return { ok: true, detail: 'fixture 模式（零进程采集，未探测真实 CLI）', hint: null };
  }
  // 延迟 require：与雷达引擎端点同款，避免模块图在装配期展开
  const { resolveLarkBin } = require('./feishu');
  const bin = resolveLarkBin(config);
  if (!bin) {
    return {
      ok: true,
      optional: true,
      detail: '未安装（可选）——任务雷达飞书同步不可用，其余功能不受影响',
      hint: HINTS.larkcli,
    };
  }
  // 解析红线在调用侧复查：只认真实存在的原生 exe（与 feishu.js 的 exe-only 口径一致）
  if (!/\.exe$/i.test(bin) || !fs.existsSync(bin)) {
    return {
      ok: false,
      detail: `lark-cli 路径不是原生 exe 或文件不存在：${bin}`,
      hint: HINTS.larkcli,
    };
  }
  return { ok: true, detail: `lark-cli 可解析（${bin}）`, hint: null };
}

/** ③ dsh（分析引擎）：入口 bin 可解析即为 ok；--version 能取到就附版本（5s 超时） */
function probeDsh(config) {
  if (process.env.DSH_FIXTURE) {
    return { ok: true, detail: 'fixture 模式（零进程分析，未探测真实引擎）', hint: null };
  }
  const { resolveDshBin } = require('./analyze');
  const bin = resolveDshBin(config);
  if (!bin) {
    return {
      ok: false,
      detail: '未找到 dsh 引擎入口（config.analyze.dshBin / %APPDATA%\\npm\\node_modules\\@deepseek-ai\\dsh）',
      hint: HINTS.dsh,
    };
  }
  const v = spawnSync(process.execPath, [bin, '--version'], { timeout: 5000, windowsHide: true });
  const version = v.error ? null : versionOf(String(v.stdout || '') + String(v.stderr || ''));
  return { ok: true, detail: `dsh${version ? ` ${version}` : ''} 入口可解析（${bin}）`, hint: null };
}

/**
 * ④ LLM 路由：两种口径都要认（文件级，零调用）
 *  ① 旧版（≤0.2.0）：`<dshHome>/settings.yaml` 与 `.credentials.yaml` 均存在；
 *  ② 0.2.1+：模型路由搬进 **profile** 的 `cordis.patch.yml`，由 `agent-default-model` 行承载
 *     （provider/model），`~/.dsh/settings.yaml` 根本不存在——旧口径会误报「未配置」，
 *     而宿主明明在跑（2026-10-31 业主实测：桌面 profile 里 provider=deepseek-account）。
 * 因此先看旧文件，再扫 profile；两者都没有才判失败。找不到只代表「没找到」，措辞要诚实。
 */
function readModelRoute(file, readFile) {
  try {
    const text = String(readFile(file, 'utf8'));
    const at = text.indexOf('agent-default-model');
    if (at === -1) return null;
    const block = text.slice(at, at + 600);
    const provider = /provider:\s*["']?([A-Za-z0-9._-]+)/.exec(block);
    const model = /model:\s*["']?([A-Za-z0-9._/.:-]+)/.exec(block);
    if (!model) return null;
    return { provider: provider ? provider[1] : '', model: model[1] };
  } catch (e) {
    return null;
  }
}

/** profiles 目录下的子目录名（读不到就是空数组：体检绝不因枚举失败而炸） */
function listProfileDirs(dir, readdir) {
  try {
    return readdir(dir, { withFileTypes: true })
      .filter((d) => d && d.isDirectory && d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    return [];
  }
}

function probeLlmRoute(config, deps) {
  const d = deps || {};
  const exists = d.existsSync || fs.existsSync;
  const readFile = d.readFileSync || fs.readFileSync;
  const readdir = d.readdirSync || fs.readdirSync;
  const dir = d.dshHomeDir || dshHomeDir();
  const hasSettings = !!exists(path.join(dir, 'settings.yaml'));
  const hasCreds = !!exists(path.join(dir, '.credentials.yaml'));

  // ① 旧版全局口径：两个文件齐了即通过（历史部署不受影响）
  if (hasSettings && hasCreds) {
    return { ok: true, detail: `settings.yaml 与 .credentials.yaml 均存在（${dir}）`, hint: null };
  }

  // ② 0.2.1+：profile 的 cordis.patch.yml 里 agent-default-model 行
  // 先试当前 profile（DSH_PROFILE），再兜底扫其余 profile——插件可能跑在被 profile 起的实例里，
  // 而模型路由配在另一个 profile（例如桌面端 desktop）上
  const envProfile = typeof d.profile === 'string' ? d.profile : (process.env.DSH_PROFILE || '');
  const profilesDir = path.join(dir, 'profiles');
  const all = typeof d.listProfiles === 'function' ? d.listProfiles(profilesDir) : listProfileDirs(profilesDir, readdir);
  const names = envProfile ? [envProfile].concat((all || []).filter((n) => n !== envProfile)) : (all || []);
  for (const name of names || []) {
    const route = readModelRoute(path.join(profilesDir, name, 'cordis.patch.yml'), readFile);
    if (route) {
      const who = route.provider ? `${route.provider} / ${route.model}` : route.model;
      const credNote = hasCreds ? '' : '（未发现 .credentials.yaml：密钥可能由宿主自身托管）';
      return { ok: true, detail: `profile "${name}" 默认模型 ${who}${credNote}`, hint: null };
    }
  }

  // ③ 都没找到：如实说明看过哪里，不假装知道原因
  const missing = [!hasSettings && 'settings.yaml', !hasCreds && '.credentials.yaml'].filter(Boolean).join('、');
  return {
    ok: false,
    detail: `缺少 ${missing}（目录 ${dir}）；profiles/*/cordis.patch.yml 也未见 agent-default-model 行`,
    hint: HINTS.llmRoute,
  };
}

/** gitea 失败 hint 按 HTTP 状态区分（testConnection 只回错误文本，状态码从中提取） */
function giteaHint(err) {
  const code = err && err.code;
  if (code === 'HOST_NOT_ALLOWED') return 'baseUrl 不在 hostWhitelist：在设置页将该域名加入 host 白名单';
  const m = /HTTP (\d{3})/.exec(String((err && err.message) || err || ''));
  const status = m ? Number(m[1]) : null;
  if (status === 401 || status === 403) {
    return 'Gitea 凭据不可用：二选一——① 在系统凭据管理器配置（git credential.helper 已接管 gitea 域名）；② 执行 git config --global http.<baseUrl>/.extraheader "Authorization: Basic <base64(用户名:令牌)>"；改完重启服务';
  }
  if (status === 404) return 'Gitea 地址或 API 前缀不正确：检查设置页 baseUrl / apiPrefix';
  if (status && status >= 500) return `Gitea 服务端错误（HTTP ${status}）：稍后重试或联系 Gitea 管理员`;
  return HINTS.giteaUnreachable;
}

/** Promise 竞速超时（giteaClient.testConnection 内部 5s 固定，体检预算 3s 更紧） */
function withTimeout(promise, ms, timeoutValue) {
  let timer;
  const t = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/** ⑤ Gitea：复用 giteaClient.testConnection（带 3s 预算；fixture 模式零出网直接 ok） */
async function probeGitea(config, deps) {
  const d = deps || {};
  const timeoutMs = Number(d.giteaTimeoutMs) || 3000;
  const giteaTest = d.giteaTest || giteaClient.testConnection;
  const base = config && config.gitea && config.gitea.baseUrl;
  if (typeof base !== 'string' || base.trim() === '') {
    return { ok: false, detail: '未配置 gitea.baseUrl', hint: '请在设置页填写 Gitea 地址（baseUrl）后重试' };
  }
  let res;
  try {
    res = await withTimeout(Promise.resolve().then(() => giteaTest(base, config)), timeoutMs, { timedOut: true });
  } catch (e) {
    return { ok: false, detail: redact((e && e.message) || String(e)), hint: giteaHint(e) };
  }
  if (res && res.timedOut) {
    return { ok: false, detail: `连接超时（>${timeoutMs}ms）`, hint: '连接超时：检查网络连通性与 Gitea 服务可达性' };
  }
  if (res && res.ok) {
    return {
      ok: true,
      detail: `已连接（${Number(res.latencyMs) || 0}ms，API ${res.apiVersion || '版本未知'}）`,
      hint: null,
    };
  }
  const err = new Error((res && res.error) || 'GITEA_TEST_FAILED');
  return { ok: false, detail: redact(err.message), hint: giteaHint(err) };
}

// ------------------------------------------------------------------ 聚合

/** 五项清单：id 固定（前端/测试契约），name 为中文展示名，depKey 为可注入探测的 deps 键
 *  （v2.2：cliGateway 项随 网关集成移除，六项收敛为五项） */
const ITEM_META = [
  ['node', 'Node.js 运行时', 'probeNode', probeNode],
  ['dws', '钉钉采集（dws）', 'probeDws', probeDws],
  ['larkcli', '飞书采集（lark-cli）', 'probeLarkCli', probeLarkCli],
  ['dsh', '分析引擎（dsh）', 'probeDsh', probeDsh],
  ['llmRoute', 'LLM 路由配置', 'probeLlmRoute', probeLlmRoute],
  ['gitea', 'Gitea 连接', 'probeGitea', probeGitea],
];

/**
 * 聚合体检。deps 可注入：probeNode/probeDws/probeDsh/probeLlmRoute/probeGitea
 * （逐项替换探测）、existsSync/dshHomeDir（llmRoute 文件级判定注入）、giteaTimeoutMs/giteaTest
 * （gitea 超时与连接测试注入）。全部缺省 = 真实探测。
 * @returns {Promise<{allOk:boolean, items:Array<{id,name,ok,detail,hint}>, checkedAt:string}>}
 */
async function runSetupCheck(config, deps) {
  const d = deps || {};
  const items = await Promise.all(
    ITEM_META.map(async ([id, name, depKey, defaultProbe]) => {
      const probe = d[depKey] || defaultProbe;
      let r;
      try {
        r = (await probe(config, d)) || {};
      } catch (e) {
        r = { ok: false, detail: redact((e && e.message) || String(e)), hint: FALLBACK_HINT[id] };
      }
      return {
        id,
        name,
        ok: !!r.ok,
        optional: !!r.optional, // 可选组件（dws/lark-cli）未安装 → ok:true + optional:true，不卡 allOk
        detail: redact(String(r.detail || '')),
        hint: r.hint || null,
      };
    })
  );
  return {
    allOk: items.every((i) => i.ok),
    items,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  runSetupCheck,
  probeNode,
  probeDws,
  probeDsh,
  probeLlmRoute,
  probeGitea,
  dshHomeDir,
  versionOf,
  HINTS,
};
