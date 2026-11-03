'use strict';

/**
 * dingtalk.js — 钉钉听记采集器 + 雷达池路由（PRD 任务雷达 §3/§4）
 *
 * 真实通道 = 本机 dws CLI（%USERPROFILE%\.local\bin\dws.exe，原生 exe 直接 spawn、
 * 不经 shell、无注入面）。认证/凭据由 dws 内部管理（token 缓存在 dws 自有存储、自动刷新），
 * 本模块零凭据接触——「凭据零落盘」红线天然满足。
 *
 * fixture：DINGTALK_FIXTURE 环境变量指向 fixture JSON 时完全替代真实 CLI
 *（零进程、零网络），模式照抄 GITEA_FIXTURE。fixture 形态 = dws 返回形态：
 * { "list": {"minutes":[{taskUuid,title,startTime,endTime,status,url}]},
 *   "transcripts": {"<taskUuid>": {paragraphList:[{paragraph,nickName,gmtCreate}]}} }
 *
 * 纵深防御：normalize 后的 ref.url host 必须命中 config.dingtalk.hostWhitelist
 *（精确或点边界子域），违者丢弃该条。我们绝不出站访问该 URL，但前端会把它渲染成
 * 链接——白名单在入库前拦住钓鱼域写入。
 *
 * 增量锚点：contentHash = sha256("dingtalk|minutes|<taskUuid>|<startTime>|<title>")。
 * 同一纪要重复同步哈希不变 → 不产生重复消息（PRD §7-2）。taskUuid 是钉钉侧稳定 ID。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const store = require('./store');
const { HttpError, sendJSON } = require('./router');
const { redact } = require('./redact');
const { hostAllowed } = require('./ssrfGuard');
const jobsMod = require('./jobs');
const radarIgnore = require('./radarIgnore');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// 逐字稿单条入库上限（段落数），防超长录音拖垮同步；超出截断并在消息上标记 truncated
const MAX_SEGMENTS = 600;

// ------------------------------------------------------------------ dws CLI

let dwsBinCache = null;

/** 解析 dws.exe：config.dingtalk.dwsBin → ~/.local/bin/dws.exe → where dws；全败返回 null */
function resolveDwsBin(cfg) {
  const configured = cfg && cfg.dingtalk && typeof cfg.dingtalk.dwsBin === 'string' && cfg.dingtalk.dwsBin.trim();
  if (configured) {
    const p = path.resolve(configured);
    if (fs.existsSync(p)) return p;
  }
  const homeFallback = path.join(os.homedir(), '.local', 'bin', 'dws.exe');
  if (fs.existsSync(homeFallback)) return homeFallback;
  if (dwsBinCache) return dwsBinCache;
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('where', ['dws'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) {
      dwsBinCache = first;
      return first;
    }
  } catch (e) { /* where 不可用 */ }
  return null;
}

function fixtureFile() {
  const p = process.env.DINGTALK_FIXTURE;
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

function readFixture() {
  const file = fixtureFile();
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 解包 dws v1.x 的统一回执：{ ok, outcome, data, meta } → data。
 * dws v1.0.64 起所有子命令都套这一层；老版本直出业务对象，此时原样返回（向后兼容）。
 * ok:false 视为失败（即使进程退出码为 0 也不能当成功）。
 */
function unwrapDwsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (payload.ok === false) {
    const detail = (payload.error && (payload.error.message || payload.error.type))
      || payload.outcome
      || 'unknown';
    const e = new Error(`dws 返回失败: ${String(detail)}`);
    e.code = 'DWS_ERROR';
    throw e;
  }
  if (payload.ok === true && payload.data && typeof payload.data === 'object') return payload.data;
  return payload;
}

/** 退出码非 0 时，stdout 里通常仍是一份 JSON 回执：取出 error.message 让人能看懂 */
function dwsErrorDetail(stdout) {
  try {
    const j = JSON.parse(String(stdout || '').trim());
    const msg = j && j.error && (j.error.message || j.error.type);
    if (msg) return String(msg);
  } catch (e) { /* 非 JSON 输出，交给调用方的兜底信息 */ }
  return '';
}

/** 调 dws 子命令并解析 JSON 输出（--format json 统一追加） */
function runDws(cfg, args) {
  const bin = resolveDwsBin(cfg);
  if (!bin) {
    throw new HttpError(502, 'DWS_NOT_FOUND', '未找到 dws CLI（config.dingtalk.dwsBin 或 ~/.local/bin/dws.exe）');
  }
  const timeoutSec = Number(cfg.dingtalk && cfg.dingtalk.dwsTimeoutSec) || 60;
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args.concat(['--format', 'json']),
      { timeout: timeoutSec * 1000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = dwsErrorDetail(stdout);
          const e = new Error(redact(
            `dws ${args[0] || ''} 执行失败: ${(err && err.message) || err}`
            + `${detail ? ` — ${detail}` : ''} ${String(stderr || '').slice(0, 200)}`
          ));
          e.code = 'DWS_ERROR';
          return reject(e);
        }
        try {
          resolve(unwrapDwsPayload(JSON.parse(String(stdout || '').trim())));
        } catch (e) {
          if (e && e.code === 'DWS_ERROR') return reject(e);
          reject(Object.assign(new Error(redact(`dws 输出不是合法 JSON: ${String(stdout).slice(0, 120)}`)), { code: 'DWS_ERROR' }));
        }
      }
    );
  });
}

// ---------------------------------------------------------------- normalize

/** 纪要身份哈希：taskUuid+startTime+title 的 sha256 前 16 位；id = msg-<hash> */
function messageIdFor(item) {
  const identity = `dingtalk|minutes|${item.taskUuid}|${item.startTime || ''}|${item.title || ''}`;
  const hash = crypto.createHash('sha256').update(identity, 'utf8').digest('hex');
  return { id: `msg-${hash.slice(0, 16)}`, contentHash: hash };
}

/** listAll 条目防御性校验：taskUuid 必须是钉钉侧十六进制串形态（防注入/防脏数据） */
function validListItem(item) {
  return !!(item && typeof item.taskUuid === 'string' && /^[0-9a-fA-F_]{8,80}$/.test(item.taskUuid));
}

function isoOrNull(ms) {
  const t = Number(ms);
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
}

/**
 * listAll 条目 + transcript 响应 → 统一消息模型（PRD §4）。
 * transcript 缺失/形态不符返回 null（调用方计入 failedFetch，下次同步重试）。
 */
function normalizeMinutes(item, transcript) {
  const paragraphs = transcript && Array.isArray(transcript.paragraphList) ? transcript.paragraphList : null;
  if (!paragraphs || paragraphs.length === 0) return null;

  const truncated = paragraphs.length > MAX_SEGMENTS;
  const segments = [];
  const contentLines = [];
  for (const p of truncated ? paragraphs.slice(0, MAX_SEGMENTS) : paragraphs) {
    if (!p || typeof p.paragraph !== 'string' || !p.paragraph.trim()) continue;
    const raw = String(p.nickName || '未知').trim();
    const at = isoOrNull(p.gmtCreate);
    segments.push({ raw, memberId: null, text: p.paragraph, at });
    contentLines.push(`【${raw}】${p.paragraph}`);
  }
  if (segments.length === 0) return null;

  const { id, contentHash } = messageIdFor(item);
  const url = typeof item.url === 'string' ? item.url : '';
  return {
    id,
    source: 'dingtalk',
    kind: 'minutes',
    title: String(item.title || '未命名听记').slice(0, 200),
    speakerSegments: segments,
    content: contentLines.join('\n') + (truncated ? '\n【已截断：超过单条 600 段上限】' : ''),
    occurredAt: isoOrNull(item.startTime) || new Date().toISOString(),
    ref: { dingtalkId: item.taskUuid, url },
    contentHash,
    truncated,
    analyzedAt: null, // 分析水位：null=待分析
    analyzeState: '', // '' | 'ok' | 'ANALYZE_FAILED'
    analyzeError: null,
    noise: [],
  };
}

// -------------------------------------------------------------------- sync

/**
 * 全量+增量同步：拉列表 → 逐条哈希查重 → 新条目拉逐字稿 → normalize → 入池。
 * 单条逐字稿失败不中断整轮（计入 failed，下次同步因哈希不在池中自然重试）。
 * @returns {{total:number, added:number, skippedExisting:number, failed:Array}}
 */
async function syncMessages(ctx) {
  const cfg = ctx.config;
  if (!cfg.dingtalk || cfg.dingtalk.enabled === false) {
    throw new HttpError(409, 'RADAR_DISABLED', '钉钉通道未启用（config.dingtalk.enabled=false）');
  }
  const whitelist = (cfg.dingtalk.hostWhitelist || []).slice();
  const max = Number(cfg.dingtalk.maxMessages) || 200;

  const fx = readFixture();
  let list;
  if (fx) {
    list = (fx.list && Array.isArray(fx.list.minutes) && fx.list.minutes) || [];
  } else {
    // dws v1.0.59 实测：+list-all 不支持 --page-all（skill 文档漂移），响应也不含 cursor——
    // 单页 --limit N 覆盖（N=maxMessages 上限），池规模由配置封顶
    const data = await runDws(cfg, ['minutes', '+list-all', '--limit', String(Math.max(1, max))]);
    list = (data && Array.isArray(data.minutes) && data.minutes) || [];
  }
  list = list
    .filter(validListItem)
    .sort((a, b) => (Number(b.startTime) || 0) - (Number(a.startTime) || 0))
    .slice(0, max);

  const messages = store.loadMessages(ctx);
  const byId = new Map(messages.map((m) => [m.id, m]));
  let added = 0;
  let skippedExisting = 0;
  let skippedIgnored = 0; // v2.9.63：删过的 / 命中过滤规则的，不再拉回来
  const failed = [];

  for (const item of list) {
    const { id } = messageIdFor(item);
    if (byId.has(id)) {
      skippedExisting += 1;
      continue;
    }
    if (radarIgnore.ignoredReason(ctx, { id })) {
      skippedIgnored += 1;
      continue;
    }
    let transcript;
    try {
      // 默认正序 + 自动翻页（--page-limit 安全上限）；v1.0.59 实测 --direction 1 是倒序，不用
      transcript = fx
        ? (fx.transcripts && fx.transcripts[item.taskUuid]) || null
        : await runDws(cfg, ['minutes', '+transcript', '--id', item.taskUuid, '--page-limit', '50']);
    } catch (e) {
      failed.push({ taskUuid: item.taskUuid, error: redact((e && e.message) || String(e)) });
      continue;
    }
    const msg = normalizeMinutes(item, transcript);
    if (!msg) {
      failed.push({ taskUuid: item.taskUuid, error: '逐字稿缺失或为空' });
      continue;
    }
    if (radarIgnore.ignoredReason(ctx, { msg })) {
      skippedIgnored += 1;
      continue;
    }
    // 纵深防御：ref.url host 白名单（我们不出站，但前端渲染为链接）
    let urlHost = '';
    try { urlHost = msg.ref.url ? new URL(msg.ref.url).hostname : ''; } catch (e) { urlHost = ''; }
    if (urlHost && !hostAllowed(urlHost, whitelist)) {
      failed.push({ taskUuid: item.taskUuid, error: `ref.url host 不在白名单: ${urlHost}` });
      continue;
    }
    messages.push(msg);
    byId.set(msg.id, msg);
    added += 1;
  }

  store.saveMessages(ctx, messages);
  return { total: list.length, added, skippedExisting, skippedIgnored, failed };
}

// ------------------------------------------------------------------- routes

function registerRadarRoutes(router, ctx) {
  // v2.9.63 忽略名单（墓碑 + 关键词/标题规则）
  radarIgnore.registerRadarIgnoreRoutes(router, ctx);
  // 手动同步（按钮驱动，v1 无轮询）：异步 job，立即 202 + 进度可查
  router.add('POST', '/api/radar/sync', (c) => {
    const job = jobsMod.createJob('sync', 0);
    (async () => {
      try {
        const result = await syncMessages(ctx);
        job.total = result.total;
        // done 反映"处理过的条目"（已存在 + 新增 + 失败）
        job.done = result.total;
        job.results.push({ item: 'sync', ok: true, ...result });
        job.state = result.failed.length === 0 ? 'done' : 'partial';
        job.finishedAt = new Date().toISOString();
      } catch (e) {
        job.state = 'failed';
        job.error = redact((e && e.message) || String(e));
        job.finishedAt = new Date().toISOString();
      }
    })();
    sendJSON(c.res, 202, { jobId: job.id });
  });

  router.add('GET', '/api/radar/messages', (c) => {
    const messages = store
      .loadMessages(ctx)
      .slice()
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    // 列表视图不携带全文（content/speakerSegments 可能很大），详情单独取
    // v2.9.5：excerpt 摘要预览（首 2 段拼合、压空白、截 120 字）——听记标题与内容错位（串场）一眼识破
    const slim = messages.map((m) => {
      const segs = Array.isArray(m.speakerSegments) ? m.speakerSegments : [];
      const head = segs.slice(0, 2)
        .map((s) => String(s.text || '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ');
      return {
        id: m.id,
        source: m.source,
        kind: m.kind,
        title: m.title,
        occurredAt: m.occurredAt,
        ref: m.ref,
        analyzedAt: m.analyzedAt,
        analyzeState: m.analyzeState || '',
        analyzeError: m.analyzeError || null,
        segmentCount: Array.isArray(m.speakerSegments) ? m.speakerSegments.length : 0,
        excerpt: head.slice(0, 120),
        truncated: !!m.truncated,
      };
    });
    sendJSON(c.res, 200, slim);
  });

  router.add('GET', '/api/radar/messages/:id', (c) => {
    const msg = store.loadMessages(ctx).find((m) => m.id === c.params.id);
    if (!msg) throw new HttpError(404, 'MESSAGE_NOT_FOUND', '消息不存在');
    sendJSON(c.res, 200, store.clone(msg));
  });

  // v2.9.9 删除纪要：重复同步（钉钉 taskUuid 变化 → 同会话两条）或误入池的清理口。
  // 只删纪要本体——已产出的收件箱候选独立流转不连带；删除时若该条分析在跑，job 容错
  // 会把该条记为失败，无数据副作用。
  router.add('DELETE', '/api/radar/messages/:id', (c) => {
    const messages = store.loadMessages(ctx);
    const idx = messages.findIndex((m) => m.id === c.params.id);
    if (idx === -1) throw new HttpError(404, 'MESSAGE_NOT_FOUND', '消息不存在');
    const [removed] = messages.splice(idx, 1);
    store.saveMessages(ctx, messages);
    // v2.9.63：记墓碑——否则下次同步会把它当新纪要拉回来（"删了又出现"）
    radarIgnore.addTombstone(ctx, c.params.id, removed && removed.title);
    sendJSON(c.res, 200, { ok: true, deleted: c.params.id, ignored: true });
  });

  // 引擎健康状态（设置页）：二进制可达性检查，零 LLM 调用（真实往返见 POST /api/radar/engine/test）
  router.add('GET', '/api/radar/engine', (c) => {
    const cfg = ctx.config;
    const { resolveDshBin } = require('./analyze');
    const dshBin = resolveDshBin(cfg);
    sendJSON(c.res, 200, {
      dingtalk: {
        enabled: !(cfg.dingtalk && cfg.dingtalk.enabled === false),
        dwsBin: resolveDwsBin(cfg),
        fixtureMode: !!process.env.DINGTALK_FIXTURE,
      },
      // v2026-11-03 飞书妙记通道（lark-cli 桥接）：健康节与钉钉同构（bin 可达性，零出网）
      feishu: (() => {
        try { return require('./feishu').feishuHealth(cfg); } catch (e) { return { enabled: false, larkBin: null, fixtureMode: false, error: redact((e && e.message) || String(e)) }; }
      })(),
      dsh: {
        bin: dshBin,
        found: !!dshBin,
        fixtureMode: !!process.env.DSH_FIXTURE,
        timeoutSec: Number(cfg.analyze && cfg.analyze.timeoutSec) || 300,
      },
    });
  });

  // 引擎真实往返测试：跑一次最小 headless 调用（约 10s），证明 LLM 链路可用
  router.add('POST', '/api/radar/engine/test', async (c) => {
    const started = Date.now();
    try {
      const analyze = require('./analyze');
      const out = await analyze.runHeadless(ctx.config, '只回复两个字符：OK');
      sendJSON(c.res, 200, { ok: true, latencyMs: Date.now() - started, reply: String(out).slice(0, 50) });
    } catch (e) {
      sendJSON(c.res, 200, { ok: false, latencyMs: Date.now() - started, error: redact((e && e.message) || String(e)) });
    }
  });

  router.add('GET', '/api/radar/jobs/:id', (c) => {
    const job = jobsMod.getJob(c.params.id);
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', '任务不存在或已被滚动清理');
    sendJSON(c.res, 200, jobsMod.jobView(job));
  });
}

module.exports = {
  registerRadarRoutes,
  syncMessages,
  normalizeMinutes,
  messageIdFor,
  resolveDwsBin,
  runDws,
  unwrapDwsPayload,
  dwsErrorDetail,
  readFixture,
  hostAllowedRef: hostAllowed,
};
