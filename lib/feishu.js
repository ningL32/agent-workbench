'use strict';

/**
 * feishu.js — 飞书妙记采集器 + 雷达池路由（与 lib/dingtalk.js 同构，PRD 任务雷达 §3/§4）
 *
 * 真实通道 = 本机 lark-cli（npm 包 @larksuite/cli，包内自带原生 lark-cli.exe——
 * 以参数数组直调原生可执行文件，无命令解释层参与，理由同 dws.exe）。
 * 认证/凭据由 lark-cli 内部管理（OAuth device flow + DPoP，token 自动刷新），
 * 本模块零凭据接触——「凭据零落盘」红线天然满足。
 *
 * fixture：LARK_FIXTURE 环境变量指向 fixture JSON 时完全替代真实 CLI
 *（零进程、零网络），模式照抄 DINGTALK_FIXTURE。fixture 形态：
 * { "items": [{minute_token,title,start_time,url,…}],   // +search 列表条目
 *   "transcripts": {"<minute_token>": "文字记录全文"} }  // +detail --transcript 落地文件的内容
 *
 * 飞书侧与钉钉的三处形态差异（官方文档 + 2026-11-03 真机样本校准）：
 *   ① 「我的妙记」= --owner-ids me ∪ --participant-ids me 两次查询按 token 去重合并；
 *   ② 搜索时间窗最大 1 个月，回溯期按 ≤31 天分窗多次查询；
 *   ③ 逐字稿落地 TXT 文件，行格式真实口径 =「Speaker 1 00:00:02.520」独立行 + 内容行 +
 *      头部元信息（录音日期/Keywords）；列表条目真实口径 = token/display_info/meta_data.app_link。
 *
 * 纵深防御：normalize 后的 ref.url host 必须命中 config.feishu.hostWhitelist
 *（精确或点边界子域），违者丢弃该条（与钉钉同一红线）；逐字稿临时文件
 * 只认本次临时目录内的 transcript.txt，读完即删（防路径逃逸）。
 *
 * 增量锚点：contentHash = sha256("feishu|minutes|<minute_token>|<start_time>")——不锚 title（评审 P2：
 * 妙记改名不该产生新 id，防同条双份入库与墓碑失效）。
 * 同一妙记重复同步哈希不变 → 不产生重复消息。minute_token 是飞书侧稳定 ID。
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
// 逐字稿单条入库上限（段落数），与钉钉 MAX_SEGMENTS 同口径；超出截断并在消息上标记 truncated
const MAX_SEGMENTS = 600;
// +search 分页防护上限：每查询最多翻页数（30/页 × 20 页 = 600 条，远超 maxMessages 封顶）
const MAX_PAGES_PER_QUERY = 20;
// 飞书官方约束：搜索时间窗最大 1 个月——分窗步长取 31 天（覆盖任意月末边界）
const CHUNK_DAYS = 31;
// minute_token 形态 allowlist（飞书侧小写字母数字串）；validListItem 入口 + fetchTranscript
// 进 execFile 参数前各校验一次（外部数据进子进程参数，使用点旁必须有本地校验，纵深防御）
const MINUTE_TOKEN_RE = /^[a-z0-9]{8,80}$/i;

// ---------------------------------------------------------------- lark-cli 解析

let larkBinCache = null;

/**
 * 解析 lark-cli 原生 exe：config.feishu.larkBin → ~/.local/bin/lark-cli.exe
 * → where lark-cli 命中项推导（npm 全局 shim 的同级 node_modules 包内 bin/lark-cli.exe）。
 * 只认原生 exe（.cmd/.ps1 shim 需经命令解释层间接执行，弃用）；全败返回 null。
 */
function resolveLarkBin(cfg) {
  const configured = cfg && cfg.feishu && typeof cfg.feishu.larkBin === 'string' && cfg.feishu.larkBin.trim();
  if (configured) {
    const p = path.resolve(configured);
    if (fs.existsSync(p)) return p;
  }
  const homeFallback = path.join(os.homedir(), '.local', 'bin', 'lark-cli.exe');
  if (fs.existsSync(homeFallback)) return homeFallback;
  if (larkBinCache) return larkBinCache;
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('where', ['lark-cli'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const hits = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const hit of hits) {
      if (/\.exe$/i.test(hit) && fs.existsSync(hit)) {
        larkBinCache = hit;
        return hit;
      }
      // npm 全局 shim（lark-cli / lark-cli.cmd / lark-cli.ps1）→ 包内原生 exe
      const pkgExe = path.join(path.dirname(hit), 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe');
      if (fs.existsSync(pkgExe)) {
        larkBinCache = pkgExe;
        return pkgExe;
      }
    }
  } catch (e) { /* where 不可用 */ }
  return null;
}

// -------------------------------------------------------------------- fixture

function fixtureFile() {
  const p = process.env.LARK_FIXTURE;
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

function readFixture() {
  const file = fixtureFile();
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ------------------------------------------------------------------- envelope

/**
 * 解包 lark-cli 的统一回执：{ ok, identity, data, meta } → data。
 * ok:false 视为失败（即使进程退出码为 0 也不能当成功）；错误形态
 * { ok:false, error:{type,subtype,message,hint} }。老版本直出业务对象时原样返回（向后兼容）。
 */
function unwrapLarkPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (payload.ok === false) {
    const err = payload.error || {};
    const detail = err.message || err.subtype || err.type || 'unknown';
    const e = new Error(`lark-cli 返回失败: ${String(detail)}`);
    e.code = 'LARK_ERROR';
    throw e;
  }
  if (payload.ok === true && payload.data && typeof payload.data === 'object') return payload.data;
  return payload;
}

/** 退出码非 0 时，stdout 里通常仍是一份 JSON 回执：取出 error.message 让人能看懂 */
function larkErrorDetail(stdout) {
  try {
    const j = JSON.parse(String(stdout || '').trim());
    const msg = j && j.error && (j.error.message || j.error.subtype || j.error.type);
    if (msg) return String(msg);
  } catch (e) { /* 非 JSON 输出，交给调用方的兜底信息 */ }
  return '';
}

/** 调 lark-cli 子命令并解析 JSON 输出（--format json 统一追加） */
function runLark(cfg, args) {
  const bin = resolveLarkBin(cfg);
  if (!bin) {
    throw new HttpError(502, 'LARK_NOT_FOUND', '未找到 lark-cli（config.feishu.larkBin / ~/.local/bin/lark-cli.exe / PATH 均未命中）');
  }
  const timeoutSec = Number(cfg.feishu && cfg.feishu.larkTimeoutSec) || 60;
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args.concat(['--format', 'json']),
      { timeout: timeoutSec * 1000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = larkErrorDetail(stdout);
          const e = new Error(redact(
            `lark-cli ${args[0] || ''} ${args[1] || ''} 执行失败: ${(err && err.message) || err}`
            + `${detail ? ` — ${detail}` : ''} ${String(stderr || '').slice(0, 200)}`
          ));
          e.code = 'LARK_ERROR';
          return reject(e);
        }
        try {
          resolve(unwrapLarkPayload(JSON.parse(String(stdout || '').trim())));
        } catch (e) {
          if (e && e.code === 'LARK_ERROR') return reject(e);
          reject(Object.assign(new Error(redact(`lark-cli 输出不是合法 JSON: ${String(stdout).slice(0, 120)}`)), { code: 'LARK_ERROR' }));
        }
      }
    );
  });
}

// ---------------------------------------------------------------- normalize

/** 妙记身份哈希：token+开始时间 的 sha256 前 16 位；id = msg-<hash>。
 *  评审修正：不锚 title——妙记改名（display_info 首行变化）不应产生新 id（防同条双份入库、墓碑失效） */
function messageIdFor(item) {
  const identity = `feishu|minutes|${(item && (item.minute_token || item.token)) || ''}|${startedMsOf(item) || ''}`;
  const hash = crypto.createHash('sha256').update(identity, 'utf8').digest('hex');
  return { id: `msg-${hash.slice(0, 16)}`, contentHash: hash };
}

/** 列表条目防御性校验：minute_token/token 必须是飞书侧字母数字串形态（防注入/防脏数据） */
function validListItem(item) {
  const t = item && (item.minute_token || item.token);
  return !!(typeof t === 'string' && MINUTE_TOKEN_RE.test(t));
}

function tokenOf(item) {
  return String(item.minute_token || item.token);
}

/** 标题：真实口径 = display_info 首行（防性剥 HTML 标签）；无则回落 item.title / 「未命名妙记」 */
function titleOf(item) {
  if (typeof item.title === 'string' && item.title.trim()) return item.title.trim().slice(0, 200);
  const firstLine = String(item.display_info || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) || '';
  return firstLine.replace(/<[^>]+>/g, '').slice(0, 200) || '未命名妙记';
}

/**
 * 从 display_info/description 解析「开始时间: 2026.11.03 10:40:29」（2026-11-03 真实样本口径，本地时区）。
 * 程序式解析（逐字符收集数字与分隔符再切分），解析不出返回 null。
 */
function startedMsFromInfo(text) {
  const s = String(text || '');
  const key = s.indexOf('开始时间');
  if (key === -1) return null;
  const seg = s.slice(key + 4, key + 44);
  let buf = '';
  for (const ch of seg) {
    const isDigit = ch >= '0' && ch <= '9';
    const isSep = ch === '.' || ch === '/' || ch === '年' || ch === '月' || ch === '日' || ch === ':' || ch === '：' || ch === ' ';
    if (isDigit || isSep) buf += ch;
    else if (buf) break;
  }
  let norm = '';
  for (const ch of buf.trim()) {
    const isSep = ch === '.' || ch === '/' || ch === '年' || ch === '月' || ch === '日' || ch === ':' || ch === '：' || ch === ' ';
    norm += isSep ? ' ' : ch;
  }
  const parts = norm.trim().split(/\s+/).filter(Boolean).map(Number);
  if (parts.length < 5) return null;
  const y = parts[0];
  const mo = parts[1];
  const d = parts[2];
  const hh = parts[3];
  const mm = parts[4];
  const ss = parts.length > 5 ? parts[5] : 0;
  if (!y || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  const t = new Date(y, mo - 1, d, hh, mm, ss);
  return isNaN(t.getTime()) ? null : t.getTime();
}

/** 开始时间读取优先级：毫秒时间戳字段（秒/微秒自动升幂到毫秒，防全池换 id——评审 P2）→ ISO 串
 *  → display_info/description 的「开始时间: …」文本（真实口径）；缺省 null */
function startedMsOf(item) {
  const raw = item.start_time != null ? item.start_time : (item.startTime != null ? item.startTime : item.start);
  let n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    while (n < 1e11) n *= 1000; // 秒(1e9~1e10)/微秒(1e15) → 毫秒（1e12~1e13 量级不动）
    return Math.round(n);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  const md = item.meta_data && typeof item.meta_data === 'object' ? item.meta_data : {};
  return startedMsFromInfo(md.description) || startedMsFromInfo(item.display_info);
}

/** ref.url 兼容读取：真实口径 = meta_data.app_link；多候选取第一个 https 命中；都没有 = 空串（允许） */
function urlOf(item) {
  const md = item.meta_data && typeof item.meta_data === 'object' ? item.meta_data : {};
  const cands = [item.url, item.minute_url, item.pc_url, item.share_url, md.app_link, item.app_link];
  for (const c of cands) {
    if (typeof c === 'string' && /^https:\/\//i.test(c)) return c;
  }
  return '';
}

/**
 * 段内时间偏移（"00:00:02.520"）+ 妙记开始时刻 → ISO；无锚点/无时间串返回 null。
 */
function offsetToIso(timeStr, anchorMs) {
  if (!anchorMs || !timeStr) return null;
  const clean = String(timeStr).trim();
  if (!clean) return null;
  const dot = clean.indexOf('.');
  const main = dot === -1 ? clean : clean.slice(0, dot);
  const frac = dot === -1 ? '' : clean.slice(dot + 1);
  const units = main.split(':').map(Number);
  if (!units.length || units.some((n) => !Number.isFinite(n))) return null;
  let sec = 0;
  for (const u of units) sec = sec * 60 + u;
  const ms = Number((frac + '000').slice(0, 3));
  if (!Number.isFinite(sec) || !Number.isFinite(ms)) return null;
  return new Date(anchorMs + sec * 1000 + ms).toISOString();
}

/**
 * 逐字稿 TXT → 说话人分段（2026-11-03 真实样本校准的口径）：
 *   - 说话人行 = 「Speaker 1 00:00:02.520」独立行（Speaker + 序号 + 段内时间偏移），内容在后续行；
 *     at = 妙记开始时刻（anchorMs）+ 行内偏移
 *   - 首个说话人行之前的行 = 头部元信息（录音日期行 / Keywords 块），丢弃
 *   - 其余行一律续接上一分段（内容任意，含冒号不误切）
 * 行格式官方无文档，若未来导出形态变化 → 分段为空 → 该条计 failed 留痕重试（不静默错切）。
 */
function parseTranscript(text, anchorMs) {
  const segments = [];
  let started = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('Speaker')) {
      const rest = s.slice(7).trim();
      const sp = rest.indexOf(' ');
      const num = sp > 0 ? rest.slice(0, sp) : rest;
      const tail = sp > 0 ? rest.slice(sp + 1).trim() : '';
      const numOk = num.length > 0 && Array.from(num).every((c) => c >= '0' && c <= '9');
      const tailOk = tail === '' || Array.from(tail).every((c) => (c >= '0' && c <= '9') || c === ':' || c === '.');
      if (numOk && tailOk) {
        started = true;
        segments.push({ raw: `Speaker ${num}`, memberId: null, text: '', at: offsetToIso(tail, anchorMs) });
        continue;
      }
    }
    if (!started) continue; // 头部元信息（录音日期/Keywords），丢弃
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      last.text = last.text ? `${last.text}\n${s}` : s;
    }
  }
  return segments.filter((seg) => seg.text);
}

/**
 * 列表条目 + 逐字稿全文 → 统一消息模型（PRD §4，source:'feishu'）。
 * 逐字稿缺失/解析不出分段返回 null（调用方计入 failedFetch，下次同步重试）。
 */
function normalizeMinute(item, transcriptText) {
  const segments = parseTranscript(transcriptText, startedMsOf(item));
  if (segments.length === 0) return null;

  const truncated = segments.length > MAX_SEGMENTS;
  const kept = truncated ? segments.slice(0, MAX_SEGMENTS) : segments;
  const contentLines = kept.map((s) => `【${s.raw}】${s.text}`);

  const { id, contentHash } = messageIdFor(item);
  return {
    id,
    source: 'feishu',
    kind: 'minutes',
    title: titleOf(item),
    speakerSegments: kept,
    content: contentLines.join('\n') + (truncated ? '\n【已截断：超过单条 600 段上限】' : ''),
    occurredAt: new Date(startedMsOf(item) || Date.now()).toISOString(),
    ref: { minuteToken: tokenOf(item), url: urlOf(item) },
    contentHash,
    truncated,
    analyzedAt: null, // 分析水位：null=待分析
    analyzeState: '', // '' | 'ok' | 'ANALYZE_FAILED'
    analyzeError: null,
    noise: [],
  };
}

// -------------------------------------------------------------- list（分窗并集）

/** 本地日期串（YYYY-MM-DD）。不能用 toISOString——UTC 转换会把东八区本地零点倒回一天（真机踩坑：今天被分窗排除，同步恒空） */
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 回溯期按 ≤31 天分窗（飞书官方约束：搜索时间窗最大 1 个月），窗口从今天往回切（首窗含今天） */
function monthlyChunks(lookbackDays) {
  const days = clampLookback(lookbackDays);
  const dayMs = 24 * 60 * 60 * 1000;
  const now = new Date();
  const chunks = [];
  let end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1); // 明天 0 点（首窗 end 减一天 = 今天，含今天）
  const floor = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1 - days);
  while (end > floor) {
    // 首窗可能不足 CHUNK_DAYS：start 收口到 floor，不越界（评审 P2：lookbackDays<31 时不得恒拉满 31 天窗）
    const rawStart = new Date(end.getTime() - CHUNK_DAYS * dayMs);
    const start = rawStart < floor ? floor : rawStart;
    chunks.push({
      start: localDateStr(start),
      end: localDateStr(new Date(end.getTime() - dayMs)), // end 当天有效（官方：仅日期 = 当天 23:59:59）
    });
    end = start;
  }
  return chunks;
}

function clampLookback(lookbackDays) {
  return Math.max(1, Math.min(365, Number(lookbackDays) || 90));
}

/**
 * 拉妙记列表：--owner-ids me ∪ --participant-ids me（官方口径「我的妙记」），
 * 逐分窗逐身份查询 + has_more/page_token 翻页，按 minute_token 去重、按时间新→旧排序、封顶 max。
 */
async function listMinutes(cfg, fx) {
  if (fx) return (Array.isArray(fx.items) && fx.items) || [];
  const max = Number(cfg.feishu && cfg.feishu.maxMessages) || 200;
  const chunks = monthlyChunks(cfg.feishu && cfg.feishu.lookbackDays);
  const byToken = new Map();
  for (const idsFlag of ['--owner-ids', '--participant-ids']) {
    let hitCap = false;
    for (const chunk of chunks) {
      let pageToken = '';
      for (let page = 0; page < MAX_PAGES_PER_QUERY; page += 1) {
        const args = ['minutes', '+search', '--as', 'user', idsFlag, 'me',
          '--start', chunk.start, '--end', chunk.end, '--page-size', '30'];
        if (pageToken) args.push('--page-token', pageToken);
        const data = await runLark(cfg, args);
        for (const item of (data && Array.isArray(data.items) && data.items) || []) {
          if (validListItem(item) && !byToken.has(tokenOf(item))) byToken.set(tokenOf(item), item);
        }
        if (!data || data.has_more !== true || !data.page_token) break;
        const tok = String(data.page_token);
        // 外部数据进子进程参数前的 allowlist（与 token 同一红线；不匹配即停止翻页并留痕）
        if (!/^[A-Za-z0-9_.-]{1,256}$/.test(tok)) {
          console.error(redact(`[feishu] page_token 形态异常，停止本查询翻页: ${tok.slice(0, 16)}…`));
          break;
        }
        pageToken = tok;
      }
      if (byToken.size >= max * 2) { hitCap = true; break; } // 已远超封顶所需，提前收手（防首次同步过久）
    }
    if (hitCap) break;
  }
  return Array.from(byToken.values())
    .sort((a, b) => (startedMsOf(b) || 0) - (startedMsOf(a) || 0))
    .slice(0, max);
}

/**
 * 拉单条妙记逐字稿：+detail --transcript 落地临时目录 → 只认目录内 transcript.txt → 读完即删。
 * transcript_file 路径必须落在本次 --output-dir 内才读（防目录逃逸）。
 */
async function fetchTranscript(cfg, token, fx) {
  if (fx) {
    const t = fx.transcripts && fx.transcripts[token];
    return typeof t === 'string' ? t : null;
  }
  // 外部数据进子进程参数前的本地 allowlist 校验（与 validListItem 同一形态红线）
  const tok = String(token || '');
  if (!MINUTE_TOKEN_RE.test(tok)) {
    throw new Error(`minute_token 形态非法（应为 8~80 位字母数字）: ${tok.slice(0, 8)}…`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-lark-'));
  try {
    const data = await runLark(cfg, ['minutes', '+detail', '--as', 'user', '--minute-tokens', tok,
      '--transcript', '--overwrite', '--output-dir', dir]);
    const minutes = (data && Array.isArray(data.minutes) && data.minutes) || [];
    const hit = minutes.find((m) => m && (m.minute_token === tok || m.minute_token === undefined));
    const file = hit && hit.artifacts && typeof hit.artifacts.transcript_file === 'string'
      ? hit.artifacts.transcript_file : '';
    const dirResolved = path.resolve(dir);
    let resolved = file ? path.resolve(file) : '';
    // realpath 归一后比对（评审 P2：Windows 大小写/8.3 短名/\\?\ 前缀会让字节级前缀比对失配 → fail-closed 拒读）
    try {
      resolved = fs.realpathSync(resolved);
    } catch (e) { /* 文件不存在/不可达 → 走下方边界判定返回 null */ }
    let dirReal = dirResolved;
    try {
      dirReal = fs.realpathSync(dirResolved);
    } catch (e) { /* 临时目录刚建必存在；容错保留原值 */ }
    if (!resolved || !(resolved === dirReal || resolved.startsWith(dirReal + path.sep))) return null;
    return fs.readFileSync(resolved, 'utf8');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不阻塞 */ }
  }
}

// -------------------------------------------------------------------- sync

/**
 * 全量+增量同步：拉列表 → 逐条哈希查重 → 新条目拉逐字稿 → normalize → 入池。
 * 单条逐字稿失败不中断整轮（计入 failed，下次同步因哈希不在池中自然重试）。
 * @returns {{total:number, added:number, skippedExisting:number, skippedIgnored:number, failed:Array}}
 */
async function syncMessages(ctx) {
  const cfg = ctx.config;
  if (!cfg.feishu || cfg.feishu.enabled === false) {
    throw new HttpError(409, 'RADAR_DISABLED', '飞书通道未启用（config.feishu.enabled=false）');
  }
  const whitelist = (cfg.feishu.hostWhitelist || []).slice();

  const fx = readFixture();
  const list = await listMinutes(cfg, fx);

  const messages = store.loadMessages(ctx);
  const byId = new Map(messages.map((m) => [m.id, m]));
  let added = 0;
  let skippedExisting = 0;
  let skippedIgnored = 0;
  const failed = [];

  for (const item of list) {
    const token = tokenOf(item);
    const { id } = messageIdFor(item);
    if (byId.has(id)) {
      skippedExisting += 1;
      continue;
    }
    if (radarIgnore.ignoredReason(ctx, { id })) {
      skippedIgnored += 1;
      continue;
    }
    let transcriptText;
    try {
      transcriptText = await fetchTranscript(cfg, token, fx);
    } catch (e) {
      failed.push({ minuteToken: token, error: redact((e && e.message) || String(e)) });
      continue;
    }
    const msg = normalizeMinute(item, transcriptText || '');
    if (!msg) {
      failed.push({ minuteToken: token, error: '逐字稿缺失或为空' });
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
      failed.push({ minuteToken: token, error: `ref.url host 不在白名单: ${urlHost}` });
      continue;
    }
    messages.push(msg);
    byId.set(msg.id, msg);
    added += 1;
  }

  // 收尾合并写（评审 P1：全程持有入池前快照，首轮逐条拉逐字稿可跑数分钟——期间用户删消息/
  // 分析管线写回都会被旧快照整体覆写掉。重读磁盘按 id 合并：盘上现有为准，仅补本轮真新增）
  const fresh = store.loadMessages(ctx);
  const freshIds = new Set(fresh.map((m) => m.id));
  const trulyNew = messages.filter((m) => !freshIds.has(m.id));
  store.saveMessages(ctx, fresh.concat(trulyNew));
  return { total: list.length, added: trulyNew.length, skippedExisting, skippedIgnored, failed };
}

// ------------------------------------------------------------------- routes

/** 引擎健康（设置页 GET /api/radar/engine 的 feishu 节）：二进制可达性检查，零出网 */
function feishuHealth(cfg) {
  return {
    enabled: !!(cfg.feishu && cfg.feishu.enabled === true),
    larkBin: resolveLarkBin(cfg),
    fixtureMode: !!process.env.LARK_FIXTURE,
  };
}

function registerFeishuRoutes(router, ctx) {
  // 手动同步（按钮驱动，v1 无轮询）：异步 job，立即 202 + 进度可查——与钉钉同步同一模式
  router.add('POST', '/api/radar/sync/feishu', (c) => {
    const job = jobsMod.createJob('sync-feishu', 0);
    (async () => {
      try {
        const result = await syncMessages(ctx);
        job.total = result.total;
        job.done = result.total;
        job.results.push({ item: 'sync-feishu', ok: true, ...result });
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
}

module.exports = {
  registerFeishuRoutes,
  syncMessages,
  normalizeMinute,
  parseTranscript,
  messageIdFor,
  titleOf,
  startedMsFromInfo,
  startedMsOf,
  urlOf,
  monthlyChunks,
  listMinutes,
  fetchTranscript,
  resolveLarkBin,
  runLark,
  unwrapLarkPayload,
  larkErrorDetail,
  readFixture,
  feishuHealth,
};
