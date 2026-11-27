'use strict';

/**
 * lib/research/flow.js — 调研任务流程图(v2.9.94)
 *
 * 数据源:访谈的草稿(含 pending/accepted/rejected)。依赖关系从草稿 desc 的
 * 「依赖:…(任务N)…」文本解析——拆解提示词(research-decompose.md)要求 desc 开头写依赖,
 * 「任务N」按**拆解草稿的创建顺序**编号(fromProposal 草稿按 createdAt 升序的第 N 条)。
 *
 * 口径说明(实测):方案「任务建议」节与拆解草稿的编号体系不一致(方案 6 条/草稿 7 条,
 * 且方案第 2 条依赖无而草稿第 2 条依赖任务1),故节点以草稿为准,方案不作权威序。
 *
 * 两种输出,零依赖:
 *   - buildFlow():结构化 {nodes, edges}——前端自渲染或测试断言
 *   - toMermaid():Mermaid flowchart 文本——业主自行渲染/截图(红线:零 npm 依赖,
 *     且宿主 CSP 为 default-src 'self',CDN 版 mermaid 不可用)
 *   - toSvg():分层布局的 SVG(服务端渲染,沿用 scorecard 端点先例)
 */

function parseDeps(desc) {
  const m = String(desc || '').match(/依赖[:：]\s*([^。;\n]*)/);
  if (!m) return [];
  const text = m[1];
  if (/^\s*(无|—|-|无依赖)\s*$/.test(text)) return [];
  const out = [];
  for (const z of text.matchAll(/任务\s*(\d+)/g)) {
    const n = Number(z[1]);
    if (Number.isInteger(n) && n >= 1 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * 构建流程图。
 *
 * 编号口径(真机数据实证后修正):只有**方案拆解来源**的草稿(fromProposal)参与「任务N」编号,
 * 按创建顺序 1..n。访谈过程中产出的草稿不参与——实测一条早于拆解创建的访谈草稿排在第 1 位,
 * 把拆解草稿整体挤后一位,导致「依赖任务1」错指到总括任务上。
 * 非拆解草稿的节点照常输出(n=null,不参与依赖解析),保证画布不丢任务。
 *
 * @param {object[]} drafts 该访谈全部草稿(任意顺序)
 * @returns {{nodes: Array, edges: Array}} edges = [{from, to}](from/to 为节点 n)
 */
function buildFlow(drafts) {
  const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  const all = Array.isArray(drafts) ? drafts.slice() : [];
  const fromProposal = all.filter((x) => x.fromProposal).sort(byCreated);
  const others = all.filter((x) => !x.fromProposal).sort(byCreated);
  // 任务N 编号:拆解草稿按创建序(与拆解提示词里 AI 写「任务N」时看到的方案序一致)
  const nOf = new Map(fromProposal.map((x, i) => [x.id, i + 1]));
  const mk = (x, n) => ({
    n,
    id: x.id,
    title: String((x.payload && x.payload.title) || '').trim(),
    status: x.status,
    priority: (x.payload && x.payload.priority) || 'medium',
    taskId: x.taskId || null,
    deps: n === null ? [] : parseDeps(x.payload && x.payload.desc),
  });
  const nodes = fromProposal.map((x) => mk(x, nOf.get(x.id))).concat(others.map((x) => mk(x, null)));
  const edges = [];
  const has = (n) => nodes.some((y) => y.n === n);
  for (const node of nodes) {
    for (const dep of node.deps) {
      // 自引用(dep === 自身 n)不成边:A 依赖 A 会画出指向自己的环,无业务含义
      if (dep !== node.n && has(dep)) edges.push({ from: dep, to: node.n });
    }
  }
  return { nodes, edges };
}

/**
 * Mermaid 节点标签转义。节点写在双引号标签 ["…"] 里,该形态下圆括号/花括号/井号都安全;
 * 必须处理的是会破坏语法的两类:
 *   - 换行:节点定义被截成多行 → 语法错(实测:AI 生成的标题可能带换行)。换成 <br/> 保留视觉换行
 *   - 双引号:提前闭合标签。换成单引号
 */
function mermaidLabel(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br/>')
    .replace(/"/g, "'");
}

/** Mermaid flowchart 文本。状态以 class 区分(渲染方可按 class 上色);非编号节点用 id 做键 */
function toMermaid(flow) {
  const keyOf = (nd) => (nd.n === null ? 'X_' + String(nd.id).replace(/[^A-Za-z0-9_]/g, '') : 'T' + nd.n);
  const L = ['flowchart TD'];
  for (const nd of flow.nodes) {
    const prefix = nd.n === null ? '' : nd.n + '. ';
    L.push(`  ${keyOf(nd)}["${prefix}${mermaidLabel(nd.title)}"]:::${nd.status}`);
  }
  if (flow.edges.length) {
    for (const e of flow.edges) L.push(`  T${e.from} --> T${e.to}`);
  } else {
    L.push('  %% 无依赖关系');
  }
  return L.join('\n') + '\n';
}

/** 按 DAG 最长路径分层(无依赖=第 0 层);环或自引用按 0 兜底,不抛错。非编号节点(n=null)=第 0 层 */
function computeLayers(flow) {
  const layer = new Map();
  const has = (n) => flow.nodes.some((y) => y.n === n);
  const depsOf = new Map(flow.nodes.map((nd) => [nd.n, nd.n === null ? [] : nd.deps.filter(has)]));
  const depth = (n, seen) => {
    if (layer.has(n)) return layer.get(n);
    if (seen.has(n)) return 0; // 环:兜底
    const next = new Set(seen).add(n);
    const ds = depsOf.get(n) || [];
    const d = ds.length ? Math.max(...ds.map((x) => depth(x, next))) + 1 : 0;
    layer.set(n, d);
    return d;
  };
  for (const nd of flow.nodes) {
    if (nd.n === null) layer.set(null, 0);
    else depth(nd.n, new Set());
  }
  return layer;
}

const escXml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STATUS_COLOR = { accepted: '#22c55e', pending: '#3b82f6', rejected: '#6b7280' };

/** 服务端渲染 SVG:层为行、同层横排;节点标题截 14 字;节点带 data-n/data-status 供前端交互 */
function toSvg(flow, opts = {}) {
  const layer = computeLayers(flow);
  const rows = new Map();
  for (const nd of flow.nodes) {
    const l = layer.get(nd.n === null ? null : nd.n);
    if (!rows.has(l)) rows.set(l, []);
    rows.get(l).push(nd);
  }
  const W = 220, H = 56, GX = 32, GY = 56, PAD = 28;
  const maxPerRow = Math.max(1, ...[...rows.values()].map((r) => r.length));
  const width = PAD * 2 + maxPerRow * W + (maxPerRow - 1) * GX;
  const height = PAD * 2 + rows.size * H + (rows.size - 1) * GY;
  const pos = new Map();
  [...rows.entries()].sort((a, b) => a[0] - b[0]).forEach(([l, arr], ri) => {
    const rowW = arr.length * W + (arr.length - 1) * GX;
    arr.forEach((nd, ci) => {
      pos.set(nd.id, { x: PAD + (width - PAD * 2 - rowW) / 2 + ci * (W + GX), y: PAD + ri * (H + GY) });
    });
  });
  const parts = [];
  // 字体写在每个 <text> 上而非 <svg> 根:被内联进宿主页面时会继承页面字体/字重,
  // 真机实测出现文字重影(描边或 faux-bold)。显式 font-weight/stroke 把继承切断。
  const FONT = `font-family="system-ui, 'Microsoft YaHei', sans-serif" font-weight="400" stroke="none"`;
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#0d1117"/>`);
  for (const e of flow.edges) {
    const from = flow.nodes.find((nd) => nd.n === e.from);
    const to = flow.nodes.find((nd) => nd.n === e.to);
    const a = pos.get(from && from.id), b = pos.get(to && to.id);
    if (!a || !b) continue;
    const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y;
    const my = (y1 + y2) / 2;
    parts.push(`<path d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}" fill="none" stroke="#4b5563" stroke-width="1.5" marker-end="url(#arr)"/>`);
  }
  parts.push(`<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4b5563"/></marker></defs>`);
  for (const nd of flow.nodes) {
    const p = pos.get(nd.id);
    const color = STATUS_COLOR[nd.status] || '#6b7280';
    // 节点显示文本与 data-* 属性里的标题压成单行:<text> 不自动换行(裸换行会挤成一行夹空白),
    // 属性值里的裸换行也会被浏览器规范化成空格、与 dataset.title 不一致。<title> 悬停提示保留换行(多行提示)。
    const oneLine = nd.title.replace(/\s*\r?\n\s*/g, ' ');
    const title = oneLine.length > 14 ? oneLine.slice(0, 14) + '…' : oneLine;
    const prefix = nd.n === null ? '' : nd.n + '. ';
    const statusLabel = { accepted: '已建任务', pending: '待确认', rejected: '已拒绝' }[nd.status] || nd.status;
    parts.push(`<g data-draft-id="${escXml(nd.id)}" data-status="${escXml(nd.status)}" data-n="${nd.n === null ? '' : nd.n}" data-title="${escXml(oneLine)}" data-task-id="${escXml(nd.taskId || '')}">`);
    parts.push(`<title>${escXml(prefix + nd.title)}\n${statusLabel}${nd.priority !== 'medium' ? ' · ' + nd.priority : ''}${nd.deps.length ? '\n依赖: 任务' + nd.deps.join('、任务') : ''}</title>`);
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="8" fill="#161b22" stroke="${color}" stroke-width="1.5"/>`);
    parts.push(`<text x="${p.x + 12}" y="${p.y + 23}" font-size="13" fill="#e6edf3" ${FONT}>${escXml(prefix + title)}</text>`);
    parts.push(`<text x="${p.x + 12}" y="${p.y + 43}" font-size="11" fill="${color}" ${FONT}>${escXml(statusLabel)}${nd.priority !== 'medium' ? ' · ' + escXml(nd.priority) : ''}</text>`);
    parts.push(`</g>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

module.exports = { parseDeps, buildFlow, toMermaid, toSvg, computeLayers };
