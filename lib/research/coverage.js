'use strict';

/**
 * lib/research/coverage.js — 访谈出口「缺口清单」(v2.9.94)
 *
 * 出发点:一场访谈什么时候算"聊够了"?此前没有任何判断——contextMeta.gaps 自 R2 起是从未填充的
 * 空占位,提示词里写着"缺口清单"是输入项,实际发给模型的上下文里根本没有它。
 *
 * 分工(本模块的全部设计都围绕这一条):
 *   - **模型只负责摘录客户原话**。它每轮随回复带回一份 coverage,标出哪些检查项有了依据。
 *   - **代码当裁判**。每一句摘录都与客户发言/附件正文逐字核对;核对不上不算「已确认」。
 *     状态由核对结果推导,模型说了不算——没有原话依据的想法不得成为事实(与草稿引用纪律同源)。
 *
 * 检查项 = 业务环节 × 四问(谁在做/怎么做/为什么/交接面) + 发现产物(干系人 ×4 / 基线 ×3 / 关键假设)。
 * 一项只有两种算"已处理":有可核对的原话(answered),或客户亲口表示给不出(unavailable,同样要原话)。
 *
 * 纯函数,不读盘、不调模型。
 */

/** 一句摘录最长保留多少字符(防模型把整段对话塞进来当"原话") */
const MAX_QUOTE = 200;
/** 近似命中的门槛:与原话的一致率(1 - 编辑距离/原话长度)不低于它,且原话至少 4 个有效字符 */
const FUZZY_RATIO = 0.9;
const FUZZY_MIN = 4;
/**
 * 一轮里所有摘录的近似核对共用的计算预算(动态规划的单元格数)。约 800 万格 ≈ 本机 100ms 量级的同步计算。
 * 核对是同步的,会占住这个本地服务的事件循环;最坏情况(长访谈 × 大量对不上的摘录)不能让它无限涨。
 * 超出预算的摘录按「未核对」处理并在清单上打 truncated 标记——宁可不确认,也不卡死服务。
 */
const FUZZY_CELL_BUDGET = 8e6;

const FACETS = [
  { key: 'who', label: '谁在做' },
  { key: 'how', label: '怎么做' },
  { key: 'why', label: '为什么' },
  { key: 'io', label: '交接面(输入/输出)' },
];
const STAKEHOLDERS = [
  { key: 'sponsor', label: '业务发起人' },
  { key: 'owner', label: '业务责任人' },
  { key: 'it', label: 'IT/数据责任人' },
  { key: 'user', label: '最终用户' },
];
const BASELINE = [
  { key: 'time', label: '耗时' },
  { key: 'quality', label: '质量(错误率/返工率)' },
  { key: 'scale', label: '规模(频率/人数)' },
];

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

/** 归一化:全角转半角、转小写、去掉空白与标点——只留字母与数字(含汉字)。核对与名称对齐都用它。 */
function norm(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 一轮核对的共用环境:语料**只归一化一次**(每条摘录各自归一化一遍整份语料,60 条摘录就是 60 倍的重复劳动),
 * 外加一个整轮共享的计算预算。
 * @param {string[]} corpus 客户发言与附件正文的原始文本
 * @param {{fuzzyCellBudget?: number}} [options]
 */
function verifyEnv(corpus, options) {
  const texts = [];
  for (const c of Array.isArray(corpus) ? corpus : []) {
    const t = norm(c);
    if (t) texts.push(t);
  }
  const budget = options && Number.isFinite(options.fuzzyCellBudget) ? options.fuzzyCellBudget : FUZZY_CELL_BUDGET;
  return { texts, budget: { left: budget }, truncated: false };
}

/**
 * 近似子串匹配:quote 对 text 任意连续子串的最小编辑距离(text 首尾可自由取舍)。
 * 逐格 DP,行=text 前缀,列=quote 前缀。自由起点 = 首列恒 0(子串可从 text 任意位置开始);
 * 自由终点 = 对**最后一列取各行最小值**(子串可在 text 任意位置结束)——只取最后一行会强迫子串
 * 贴到 text 末尾,原话后面多出的每个字都被算成编辑(实现时踩到,单测抓出)。
 * 不用「最长公共片段占比」:31 字的原话里多插入一个字,最长连续片段就只剩 27 字(87%),
 * 插在中间更是掉到一半——对"个别字出入"过于敏感,会误伤近乎逐字的摘录。
 */
function editDistanceToSubstring(quote, text) {
  let prev = Array.from({ length: quote.length + 1 }, (_, j) => j);
  let best = prev[quote.length]; // 空子串对整句 quote 的距离(= quote 长度),仅作初值
  for (let i = 1; i <= text.length; i++) {
    const cur = [0];
    const ch = text[i - 1];
    for (let j = 1; j <= quote.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ch === quote[j - 1] ? 0 : 1));
    }
    if (cur[quote.length] < best) best = cur[quote.length];
    prev = cur;
  }
  return best;
}

/** 4 字片段的数值哈希(不生成子串)。只用于预筛:冲突只会多做一次 DP,不会漏掉候选。 */
const gramHash = (s, i) => (((s.charCodeAt(i) * 31 + s.charCodeAt(i + 1)) * 31 + s.charCodeAt(i + 2)) * 31 + s.charCodeAt(i + 3)) | 0;

function gramHashes(q) {
  const out = new Set();
  for (let i = 0; i + 4 <= q.length; i++) out.add(gramHash(q, i));
  return out;
}

/**
 * 原话核对 → 'exact' | 'fuzzy' | null。
 * ① 归一化后的精确子串(绝大多数摘录走这条快路径,覆盖**全部**语料——很早说过的话也算数);
 * ② 不中再做近似匹配,且只对「含有原话任一 4 字片段」的语料做 DP,最近的先查。
 *    近似匹配同样覆盖全部语料:只看最近几条会让"客户早先说过、后来才被摘录且略有出入"的项永久核对不上。
 * 每次 DP 按 格数(文本长 × 原话长) 从整轮预算里扣;预算不够时跳过并记 truncated。
 * 不足 2 个有效字符的原话不作依据(单字在任何对话里都找得到)。
 */
function verifyQuoteIn(quote, env) {
  const q = norm(clip(quote, MAX_QUOTE));
  if (q.length < 2) return null;
  if (env.texts.some((t) => t.includes(q))) return 'exact';
  if (q.length < FUZZY_MIN) return null;
  const hashes = gramHashes(q);
  for (let i = env.texts.length - 1; i >= 0; i--) {
    const t = env.texts[i];
    let candidate = false;
    for (let k = 0; k + 4 <= t.length; k++) {
      if (hashes.has(gramHash(t, k))) { candidate = true; break; }
    }
    if (!candidate) continue;
    const cost = t.length * q.length;
    if (env.budget.left < cost) { env.truncated = true; continue; }
    env.budget.left -= cost;
    const dist = editDistanceToSubstring(q, t);
    if (1 - dist / q.length >= FUZZY_RATIO) return 'fuzzy';
  }
  return null;
}

/** 单条核对(独立使用,如测试/工具):每次自建环境与全额预算。热点路径请走 applyTurn,语料只归一化一次。 */
function verifyQuote(quote, corpus) {
  return verifyQuoteIn(quote, verifyEnv(corpus));
}

/** 模型对某一项的说法 → 可信状态。状态完全由核对结果推导;模型声称"客户给不出"同样要原话作证。 */
function judge(raw, env) {
  const r = isObj(raw) ? raw : {};
  const quote = clip(r.quote, MAX_QUOTE);
  if (!quote) return { status: 'missing', quote: '', basis: null };
  const basis = verifyQuoteIn(quote, env);
  if (!basis) return { status: 'unverified', quote, basis: null };
  if (r.unavailable === true) return { status: 'unavailable', quote, basis };
  return { status: 'answered', quote, basis };
}

function judgeBaseline(raw, env) {
  const r = isObj(raw) ? raw : {};
  const item = judge(r, env);
  if (item.status === 'answered') {
    item.value = clip(r.value, 40);
    // 模型没标明就按估算:来路不明的数字不得当实测(估算基线会让验收时的改进幅度站不住)
    item.estimated = r.estimated !== false;
  }
  return item;
}

function judgeAssumption(raw, env) {
  const r = isObj(raw) ? raw : {};
  const text = clip(r.text, 60);
  if (!text) return null;
  const item = judge(r, env);
  // 没有原话的假设是「待客户确认」(它本身就是缺口),不是"没问过"
  const status = item.status === 'answered' ? (r.denied === true ? 'denied' : 'confirmed')
    : item.status === 'missing' ? 'open'
      : item.status;
  return { text, status, quote: item.quote, basis: item.basis };
}

function emptySlots(defs) {
  const out = {};
  for (const d of defs) out[d.key] = { status: 'missing', quote: '', basis: null };
  return out;
}

function emptyCoverage() {
  return { v: 1, steps: [], stakeholders: emptySlots(STAKEHOLDERS), baseline: emptySlots(BASELINE), assumptions: [] };
}

function rank(item) {
  if (item.status === 'answered' || item.status === 'confirmed' || item.status === 'denied') return item.estimated === true ? 3 : 4;
  if (item.status === 'unavailable') return 2;
  if (item.status === 'unverified') return 1;
  return 0; // missing / open
}

function shouldReplace(prev, next) {
  // 「客户暂给不出」有客户新说的原话作证,允许它撤下任何旧状态:客户事后收回的数字不能再当依据(宁缺毋错)。
  // 模型无权单方面把一项改成「暂给不出」——judge() 已要求它带可核对的原话,否则只是 unverified。
  if (next.status === 'unavailable') return true;
  return rank(next) >= rank(prev);
}

/** 同一条假设的判定:归一化后相等,或一方包含另一方(模型常把假设写得更具体)。短文本不做包含判定。 */
function sameAssumption(a, b) {
  const na = norm(a.text);
  const nb = norm(b.text);
  return na === nb
    || (na.length >= 4 && nb.includes(na))
    || (nb.length >= 4 && na.includes(nb));
}

/**
 * 把模型本轮的 coverage 并入清单。prev 为空(首轮/旧访谈)时从空清单起步。
 * 返回新的清单对象,不修改入参。动态列表(环节/假设)按「首次出现的顺序」排列,本轮没提到的原样保留。
 * @param {object|null} prev 上一轮的清单
 * @param {object} input 模型本轮回复里的 coverage
 * @param {string[]} corpus 核对用语料:客户发言 + 附件正文(AI 自己说的话不是依据)
 * @param {{fuzzyCellBudget?: number}} [options] 测试用:缩小近似核对的计算预算
 * @returns {object} 清单;近似核对因预算不足而未完成时带 `truncated: true`
 */
function applyTurn(prev, input, corpus, options) {
  const raw = isObj(input) ? input : {};
  const p = isObj(prev) && prev.v === 1 ? prev : emptyCoverage();
  const out = emptyCoverage();
  const env = verifyEnv(corpus, options);

  // 业务环节:按归一化后的名称对齐;名称保持首次出现的写法(它是后续各轮对齐用的标识)
  const rawSteps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((s) => {
      const name = clip(isObj(s) ? s.name : '', 30);
      const facets = {};
      for (const f of FACETS) facets[f.key] = judge(s[f.key], env);
      return { name, key: norm(name), facets };
    })
    .filter((s) => s.key);
  const usedSteps = new Set();
  for (const prevStep of p.steps) {
    const idx = rawSteps.findIndex((s, i) => !usedSteps.has(i) && s.key === norm(prevStep.name));
    if (idx < 0) { out.steps.push(prevStep); continue; }
    usedSteps.add(idx);
    const merged = { name: prevStep.name };
    for (const f of FACETS) {
      merged[f.key] = shouldReplace(prevStep[f.key], rawSteps[idx].facets[f.key]) ? rawSteps[idx].facets[f.key] : prevStep[f.key];
    }
    out.steps.push(merged);
  }
  rawSteps.forEach((s, i) => {
    if (usedSteps.has(i)) return;
    usedSteps.add(i); // 同名重复只取第一次
    const step = { name: s.name };
    for (const f of FACETS) step[f.key] = s.facets[f.key];
    out.steps.push(step);
  });

  for (const d of STAKEHOLDERS) {
    const next = judge(isObj(raw.stakeholders) ? raw.stakeholders[d.key] : null, env);
    out.stakeholders[d.key] = shouldReplace(p.stakeholders[d.key], next) ? next : p.stakeholders[d.key];
  }
  for (const d of BASELINE) {
    const next = judgeBaseline(isObj(raw.baseline) ? raw.baseline[d.key] : null, env);
    out.baseline[d.key] = shouldReplace(p.baseline[d.key], next) ? next : p.baseline[d.key];
  }

  const rawAssumptions = (Array.isArray(raw.assumptions) ? raw.assumptions : []).map((a) => judgeAssumption(a, env)).filter(Boolean);
  const usedAssumptions = new Set();
  for (const prevA of p.assumptions) {
    const idx = rawAssumptions.findIndex((a, i) => !usedAssumptions.has(i) && sameAssumption(prevA, a));
    if (idx < 0) { out.assumptions.push(prevA); continue; }
    usedAssumptions.add(idx);
    const next = rawAssumptions[idx];
    out.assumptions.push(Object.assign({}, shouldReplace(prevA, next) ? next : prevA, { text: prevA.text }));
  }
  const seen = new Set(out.assumptions.map((a) => norm(a.text)));
  rawAssumptions.forEach((a, i) => {
    const key = norm(a.text);
    if (usedAssumptions.has(i) || seen.has(key)) return;
    seen.add(key);
    out.assumptions.push(a);
  });
  if (env.truncated) out.truncated = true;
  return out;
}

// ------------------------------------------------------------------ 闸门计数与对外文本

/** 一项算"未处理":没问过、或模型给的依据核对不上(假设没有原话 = 待客户确认) */
const isOpen = (status) => status === 'missing' || status === 'unverified' || status === 'open';

/**
 * 清单 → 扁平条目。顺序:业务环节×四问 → 干系人 → 基线 → 关键假设。
 * 闸门计数、界面展示、给两处模型的文本都从这一份枚举出发,不会各数各的。
 */
function items(coverage) {
  const c = isObj(coverage) && coverage.v === 1 ? coverage : emptyCoverage();
  const out = [];
  for (const s of c.steps || []) {
    for (const f of FACETS) out.push({ group: 'step', key: `${norm(s.name)}.${f.key}`, label: `环节「${s.name}」·${f.label}`, item: s[f.key] });
  }
  for (const d of STAKEHOLDERS) out.push({ group: 'stakeholder', key: d.key, label: d.label, item: (c.stakeholders || {})[d.key] });
  for (const d of BASELINE) out.push({ group: 'baseline', key: d.key, label: d.label, item: (c.baseline || {})[d.key] });
  for (const a of c.assumptions || []) out.push({ group: 'assumption', key: norm(a.text), label: `假设:${a.text}`, item: a });
  return out.map((e) => ({
    group: e.group, key: e.key, label: e.label,
    text: (e.item && e.item.text) || '',
    status: (e.item && e.item.status) || 'missing',
    quote: (e.item && e.item.quote) || '',
    value: (e.item && e.item.value) || '',
    estimated: !!(e.item && e.item.estimated),
  }));
}

const isAssessed = (coverage) => isObj(coverage) && coverage.v === 1;

/**
 * 访谈出口的闸门结论:哪些还没处理、哪些客户明确给不出、哪些已有依据。
 * `items` 是全部检查项的扁平列表(界面按 group 分组渲染即可,不必认识 coverage 的结构);
 * open / unavailable / answered 是其中三类各自的子集(同一批对象)。
 * 没有清单(旧访谈/还没说过话)→ assessed=false:既不算"有缺口",也不算"已通过"——调用方必须区分这两种"没有缺口"。
 */
function gateOf(coverage) {
  if (!isAssessed(coverage)) {
    return { assessed: false, open: [], unavailable: [], answered: [], items: [], counts: { total: 0, answered: 0, unavailable: 0, open: 0 } };
  }
  const open = [];
  const unavailable = [];
  const answered = [];
  const all = [];
  for (const e of items(coverage)) {
    const row = {
      group: e.group, key: e.key, label: e.label, status: e.status, quote: e.quote,
      value: e.value, estimated: e.estimated, text: e.text,
    };
    all.push(row);
    if (isOpen(e.status)) open.push(row);
    else if (e.status === 'unavailable') unavailable.push(row);
    else answered.push(row);
  }
  return {
    assessed: true,
    open,
    unavailable,
    answered,
    items: all,
    counts: { total: all.length, answered: answered.length, unavailable: unavailable.length, open: open.length },
  };
}

/** 紧凑文本里用的短标签(完整标签留给界面) */
const SHORT_LABELS = ['交接面', '质量', '规模'];
const shortLabel = (label) => SHORT_LABELS.find((x) => label.startsWith(x)) || label;

/** 四问/干系人/基线某一格的标记。核对不上的摘录原样给回模型,下一轮它才有机会重新摘录。 */
function cellMark(item) {
  if (item.status === 'answered') return `✓${item.value ? `(${item.estimated ? '估算' : '实测'})${item.value}` : ''}「${item.quote}」`;
  if (item.status === 'unavailable') return `暂给不出「${item.quote}」`;
  if (item.status === 'unverified') return `核对不上「${item.quote}」`;
  return '?';
}

/** 关键假设的状态说法(给访谈模型的清单 / 给方案的核对结果共用——同一种状态只有一种说法) */
const ASSUMPTION_WORD = {
  open: '待客户确认',
  unverified: '待客户确认(其摘录核对不上,请重新摘录客户原话)',
  unavailable: '客户暂无法确认',
  confirmed: '客户已确认',
  denied: '客户否认',
};

/** 给**访谈模型**的清单(随每轮上下文回传):紧凑,一行一组。 */
function toPromptSection(coverage) {
  const c = isAssessed(coverage) ? coverage : emptyCoverage();
  const L = ['### 业务环节 × 四问'];
  if (!(c.steps || []).length) L.push('- 尚未识别业务环节');
  for (const s of c.steps || []) {
    L.push(`- ${s.name}:` + FACETS.map((f) => `${shortLabel(f.label)} ${cellMark(s[f.key] || { status: 'missing' })}`).join(' | '));
  }
  L.push('### 干系人');
  L.push('- ' + STAKEHOLDERS.map((d) => `${d.label} ${cellMark((c.stakeholders || {})[d.key] || { status: 'missing' })}`).join(' | '));
  L.push('### 基线(当前做法的数字)');
  L.push('- ' + BASELINE.map((d) => `${shortLabel(d.label)} ${cellMark((c.baseline || {})[d.key] || { status: 'missing' })}`).join(' | '));
  L.push('### 关键假设(客户尚未确认的 = 缺口)');
  if (!(c.assumptions || []).length) L.push('- (暂无)');
  for (const a of c.assumptions || []) {
    L.push(`- 「${a.text}」${ASSUMPTION_WORD[a.status] || ASSUMPTION_WORD.open}${a.quote ? `:「${a.quote}」` : ''}`);
  }
  return L.join('\n');
}

/** 条目在方案文本里的名字:环节四问用完整标签,干系人/基线加组名前缀 */
const ENTRY_PREFIX = { stakeholder: '干系人·', baseline: '基线·' };
const entryName = (e) => `${ENTRY_PREFIX[e.group] || ''}${e.label}`;

/**
 * 给**方案模型**的核对结果(生成方案时注入):分四组,让方案知道哪些能引用、哪些必须写成待确认。
 * 未评估时如实写明——方案不得把未经核对的基线/干系人/假设当作已知事实。
 */
function discoveryForProposal(coverage) {
  if (!isAssessed(coverage)) {
    return '## 发现产物核对(系统维护)\n'
      + '(未评估:本访谈尚未产生缺口清单。基线、干系人、关键假设都没有经过系统与对话原文的核对——'
      + '方案不得把它们当作已知事实;请在"风险与前提"一节如实写明"发现产物未评估",验收指标中的基线一律按缺失处理。)';
  }
  const all = items(coverage);
  const rows = all.filter((e) => e.group !== 'assumption');
  const assumptions = all.filter((e) => e.group === 'assumption');
  const line = (e) => (e.group === 'baseline' && e.status === 'answered'
    ? `- ${entryName(e)}:${e.value}(${e.estimated ? '估算' : '实测'})「${e.quote}」`
    : `- ${entryName(e)}:「${e.quote}」`);
  const group = (title, list, render) => [title, ...(list.length ? list.map(render) : ['- (无)'])];

  return [
    '## 发现产物核对(系统维护;只采信与对话原文逐字核对过的客户原话)',
    '使用规则:「已确认」可直接引用,并带上原话出处;「客户暂给不出」与「未处理的缺口」逐条写入"风险与前提",'
      + '不得补全、不得回避;「关键假设」按标注的状态对待,未确认的不得写成事实。',
    ...group('### 已确认', rows.filter((e) => e.status === 'answered'), line),
    ...group('### 客户暂给不出', rows.filter((e) => e.status === 'unavailable'), line),
    ...group(
      '### 未处理的缺口',
      rows.filter((e) => isOpen(e.status)),
      (e) => `- ${entryName(e)} —— ${e.status === 'unverified' ? `摘录未核对上:「${e.quote}」` : '未问'}`
    ),
    ...group(
      '### 关键假设(客户已确认 / 客户否认 / 待客户确认 / 客户暂无法确认)',
      assumptions,
      (e) => `- 「${e.text}」—— ${ASSUMPTION_WORD[e.status] || ASSUMPTION_WORD.open}${e.quote ? `:「${e.quote}」` : ''}`
    ),
  ].join('\n');
}

// ------------------------------------------------------------------ 方案章节(范围合同模板)

/** 范围合同的七节。顺序即模板顺序;「不做什么」「验收指标」是 v2.9.94 新增的两节。 */
const PROPOSAL_SECTIONS = [
  { key: 'current', label: '现状与问题', test: (h) => h.includes('现状') || h.includes('问题') },
  { key: 'goal', label: '目标', test: (h) => h.includes('目标') },
  { key: 'solution', label: '方案', test: (h) => h.includes('方案') },
  { key: 'excluded', label: '不做什么', test: (h) => h.includes('不做') || h.includes('排除') || h.includes('范围外') },
  { key: 'acceptance', label: '验收指标', test: (h) => h.includes('验收') },
  { key: 'risks', label: '风险与前提', test: (h) => h.includes('风险') || h.includes('前提') },
  { key: 'tasks', label: '任务建议', test: (h) => h.includes('任务') },
];

/** 取各级标题文本(去掉"一、""2."这类编号)。H1 是文档大标题("场景方案 · X"),不算章节。 */
function headingTexts(md) {
  const out = [];
  for (const line of String(md == null ? '' : md).split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m || m[1].length === 1) continue;
    out.push(m[2].replace(/^[一二三四五六七八九十\d]+\s*[、.．:：)）]?\s*/, '').trim());
  }
  return out;
}

/**
 * 方案文档是否按范围合同模板把七节写全。只查"有没有这一节",不查内容与顺序。
 * 一个标题只能认领一节(按模板顺序认领第一个匹配且未被占用的),避免"验收指标与目标值"同时顶掉两节。
 */
function checkProposalSections(md) {
  const claimed = new Set();
  for (const h of headingTexts(md)) {
    const sec = PROPOSAL_SECTIONS.find((s) => !claimed.has(s.key) && s.test(h));
    if (sec) claimed.add(sec.key);
  }
  return {
    present: PROPOSAL_SECTIONS.filter((s) => claimed.has(s.key)).map((s) => s.label),
    missing: PROPOSAL_SECTIONS.filter((s) => !claimed.has(s.key)).map((s) => s.label),
  };
}

module.exports = {
  FACETS, STAKEHOLDERS, BASELINE, PROPOSAL_SECTIONS,
  norm, verifyQuote, applyTurn, emptyCoverage,
  gateOf, toPromptSection, discoveryForProposal, checkProposalSections,
};
