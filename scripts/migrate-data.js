'use strict';

/**
 * migrate-data.js — WP5 数据迁移脚本：旧版散落布局 → 插件化 base 布局
 *
 * 源布局（sourceRoot，旧版 ~/.dsh/fde-console 形态）：
 *   data/…（子树）、agents.json、members.json、config.json（含遗留 port/host）
 * 目标布局（base，如 ~/.dsh/fde-console 或自定义目录）：
 *   data/…、agents.json、members.json、config.json（无 port/host；dataDir/webDir 强制 base 下绝对路径）
 *
 * 规则：
 * - data/ agents.json members.json：目标已存在一律 SKIP（哨兵不被覆盖）→ 幂等可重跑
 * - config.json：每次都做三方合并重写（可重复执行，结果确定）：
 *       deepMerge( deepMerge(pluginDefaultConfig(base), 目标现有 config), 剥离 port/host 后的源 config )
 *   再强制 dataDir = <base>/data、webDir = <base>/web；
 *   v2.2：遗留 gateway 节一律剥除（网关集成已移除，业主 2026-10-20）
 * - deepMerge 只对纯对象递归；数组与标量整体覆盖
 * - 源 config 损坏：该步 ERR + errors 登记 + 回退写出默认模板（其余步骤不连坐）
 * - dry-run：零写入（不建任何目录、不写任何文件），步骤 status 与实跑一致
 *
 * 用法：
 *   node scripts/migrate-data.js [--source <旧目录>] [--base <目标base>] [--dry-run]
 *   缺省 --source = 仓库根（旧独立版布局：data/ + agents.json + members.json + config.json），
 *   缺省 --base = <DSH_HOME|~/.dsh>/fde-console
 * 退出码：0 = 无 ERR；1 = 任一步 ERR
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 唯一事实源：模板直接派生自 store.DEFAULT_CONFIG（勿在本文复制默认值，防漂移）
const { DEFAULT_CONFIG } = require('../lib/store.js');

// ---------- 基础工具 ----------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cloneJSON(v) {
  return JSON.parse(JSON.stringify(v));
}

/** 深合并：只对两侧均为纯对象的键递归；数组与标量由 override 整体覆盖；不改动入参 */
function deepMerge(baseObj, override) {
  const out = isPlainObject(baseObj) ? Object.assign({}, baseObj) : {};
  if (!isPlainObject(override)) return out;
  for (const k of Object.keys(override)) {
    const ov = override[k];
    if (isPlainObject(ov) && isPlainObject(out[k])) out[k] = deepMerge(out[k], ov);
    else out[k] = isPlainObject(ov) ? deepMerge(undefined, ov) : ov;
  }
  return out;
}

/** 剥离遗留顶层 port/host（插件化后监听参数不再进 config.json） */
function stripPortHost(cfg) {
  if (!isPlainObject(cfg)) return {};
  const out = Object.assign({}, cfg);
  delete out.port;
  delete out.host;
  return out;
}

/** 相对路径 → base 下绝对路径；绝对路径/空值原样返回（dataDir/webDir 同规则） */
function absUnderBase(base, p) {
  if (typeof p !== 'string' || p.trim() === '' || path.isAbsolute(p)) return p;
  return path.join(base, p);
}

// ---------- 路径解析 ----------

/** 旧版根目录：跟随 DSH_HOME，未设置回退 ~/.dsh */
function resolveHome() {
  const home = process.env.DSH_HOME;
  if (home && typeof home === 'string' && home.trim() !== '') return home;
  return path.join(os.homedir(), '.dsh');
}

/** 迁移目标 base：显式 base 优先；否则 <resolveHome()>/fde-console（统一 normalize） */
function resolveBase(opts) {
  const o = opts || {};
  if (o.base && typeof o.base === 'string' && o.base.trim() !== '') return path.normalize(o.base);
  return path.normalize(path.join(resolveHome(), 'fde-console'));
}

/** 迁移源缺省 = 仓库根（旧独立版布局所在；SPEC-PLUGIN 2.4：拷 repo data/ → <base>/data） */
function defaultSourceRoot() {
  return path.resolve(__dirname, '..');
}

// ---------- config 模板 ----------

/**
 * 插件化默认 config：派生自 store.DEFAULT_CONFIG 的全新对象（互不影响、不污染原值）
 * - 删除 port/host
 * - dataDir 重写为 base 下绝对路径；webDir 指向插件包自带 web（资产随代码走，base 只放用户数据）
 * - security.trustedHosts 兜底 ['127.0.0.1', 'localhost']（本机回环白名单）
 * - v2.2：gateway 节不再存在于模板（网关集成已移除）
 */
function pluginDefaultConfig(base, webDir) {
  const cfg = cloneJSON(DEFAULT_CONFIG);
  delete cfg.port;
  delete cfg.host;
  cfg.dataDir = path.join(base, 'data');
  cfg.webDir = webDir || path.join(base, 'web');
  if (!isPlainObject(cfg.security)) cfg.security = {};
  cfg.security.trustedHosts = ['127.0.0.1', 'localhost'];
  return cfg;
}

/** 原子写 JSON（与 lib/store.writeJSON 同格式：2 空格缩进 + 末尾换行） */
function writeJSONFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-migrate-${process.pid}-${Date.now().toString(36)}`;
  let done = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    done = true;
  } finally {
    if (!done) {
      try {
        fs.unlinkSync(tmp);
      } catch (e) { /* tmp 不存在 */ }
    }
  }
}

// ---------- 迁移步骤 ----------

function step(id, status, detail) {
  return { id, status, detail: detail || '' };
}

/** 递归复制目录树（node 内置 cpSync；recursive 含子目录） */
function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * 迁移主入口。opts: { sourceRoot, base, dryRun }
 * @returns {{ steps: Array<{id,status,detail}>, errors: Array<{id,error}> }}
 */
function runMigration(opts) {
  const o = opts || {};
  const sourceRoot = o.sourceRoot || defaultSourceRoot();
  const base = o.base ? path.normalize(o.base) : resolveBase({});
  const dryRun = !!o.dryRun;

  const steps = [];
  const errors = [];

  // 实跑才落位目录；dry-run 连 base 目录都不建（零写入红线）
  if (!dryRun) fs.mkdirSync(base, { recursive: true });

  // ---- 步骤 1：data/ 子树整体搬迁 ----
  {
    const srcData = path.join(sourceRoot, 'data');
    const dstData = path.join(base, 'data');
    if (fs.existsSync(dstData)) {
      steps.push(step('data', 'SKIP', `目标已存在，跳过: ${dstData}`));
    } else if (!fs.existsSync(srcData)) {
      steps.push(step('data', 'SKIP', `源不存在，跳过: ${srcData}`));
    } else {
      if (!dryRun) copyDir(srcData, dstData);
      steps.push(step('data', 'OK', `data 子树已复制: ${srcData} → ${dstData}`));
    }
  }

  // ---- 步骤 2/3：agents.json / members.json 单文件搬迁（目标哨兵不覆盖） ----
  for (const fileName of ['agents.json', 'members.json']) {
    const srcFile = path.join(sourceRoot, fileName);
    const dstFile = path.join(base, fileName);
    if (fs.existsSync(dstFile)) {
      steps.push(step(fileName, 'SKIP', `目标已存在，跳过（不覆盖哨兵）: ${dstFile}`));
    } else if (!fs.existsSync(srcFile)) {
      steps.push(step(fileName, 'SKIP', `源不存在，跳过: ${srcFile}`));
    } else {
      if (!dryRun) fs.copyFileSync(srcFile, dstFile);
      steps.push(step(fileName, 'OK', `${fileName} 已复制: ${srcFile} → ${dstFile}`));
    }
  }

  // ---- 步骤 4：config.json 三方合并重写（可重复执行，结果确定） ----
  {
    const id = 'config.json';
    const srcCfgFile = path.join(sourceRoot, 'config.json');
    const dstCfgFile = path.join(base, 'config.json');

    // 4.1 读目标现有 config（视为"目标侧已有配置"）
    let targetExisting = null;
    let targetBroken = false;
    if (fs.existsSync(dstCfgFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(dstCfgFile, 'utf8'));
        if (isPlainObject(parsed)) targetExisting = parsed;
      } catch (e) {
        targetBroken = true;
        errors.push({ id, error: `目标 config.json 损坏: ${e.message}` });
      }
    }

    // 4.2 读源 config（损坏 → ERR + 回退默认模板；其余步骤不连坐）
    let sourceCfg = {};
    let sourceBroken = false;
    if (fs.existsSync(srcCfgFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(srcCfgFile, 'utf8'));
        if (isPlainObject(parsed)) sourceCfg = parsed;
        else sourceBroken = true;
      } catch (e) {
        sourceBroken = true;
        errors.push({ id, error: `源 config.json 解析失败: ${e.message}` });
      }
    }

    if (targetBroken || sourceBroken) {
      // 回退：写出默认模板（无 port/host、绝对 dataDir/webDir、trustedHosts）
      const fallback = pluginDefaultConfig(base);
      if (!dryRun) writeJSONFile(dstCfgFile, fallback);
      steps.push(
        step(id, 'ERR', targetBroken ? '目标 config.json 损坏，已回退默认模板' : '源 config.json 损坏，已回退默认模板')
      );
    } else {
      // 4.3 三方合并：模板 ← 目标现有 ← 源（剥 port/host），再强制路径归位
      const merged = deepMerge(deepMerge(pluginDefaultConfig(base), targetExisting), stripPortHost(sourceCfg));
      delete merged.port;
      delete merged.host;
      // v2.2：网关集成已移除——源/目标侧带入的遗留 gateway 节一律剥除
      delete merged.gateway;
      merged.dataDir = path.join(base, 'data');
      // webDir = 插件包自带 web（资产随代码版本走，更新 migrate 即同步）；base 只放用户数据
      merged.webDir = path.join(defaultSourceRoot(), 'web');
      if (!dryRun) writeJSONFile(dstCfgFile, merged);
      steps.push(
        step(
          id,
          'OK',
          `config 已合并重写（dataDir=${merged.dataDir}，webDir=${merged.webDir}，已剥离 port/host/gateway${dryRun ? '，dry-run 未写入' : ''}）`
        )
      );
    }
  }

  return { steps, errors };
}

// ---------- CLI 层 ----------

function parseArgs(argv) {
  const out = { source: undefined, base: undefined, dryRun: false };
  const args = argv || [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--source') out.source = args[++i];
    else if (a === '--base') out.base = args[++i];
  }
  return out;
}

/**
 * CLI 入口（进程内可复用：只返回退出码，不 process.exit）
 * @param {string[]} argv 不含 node 与脚本路径的参数
 * @returns {number} 0 = 无 ERR；1 = 任一步 ERR
 */
function main(argv) {
  const args = parseArgs(argv);
  const sourceRoot = path.resolve(args.source || defaultSourceRoot());
  const base = resolveBase({ base: args.base });
  console.log(`[migrate] 源目录: ${sourceRoot}`);
  console.log(`[migrate] 目标 base: ${base}${args.dryRun ? '（dry-run：零写入）' : ''}`);

  const { steps, errors } = runMigration({ sourceRoot, base, dryRun: args.dryRun });
  for (const s of steps) {
    console.log(`[${s.status}] ${s.id} — ${s.detail}`);
  }
  const count = (status) => steps.filter((s) => s.status === status).length;
  console.log(
    `汇总: 共 ${steps.length} 步 — OK ${count('OK')} / SKIP ${count('SKIP')} / ERR ${count('ERR')}` +
      (errors.length ? `；errors: ${errors.length}` : '')
  );
  return errors.length > 0 ? 1 : 0;
}

module.exports = {
  resolveHome,
  resolveBase,
  defaultSourceRoot,
  pluginDefaultConfig,
  deepMerge,
  stripPortHost,
  runMigration,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
