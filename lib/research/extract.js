'use strict';

/**
 * lib/research/extract.js — 附件文本抽取(v2.9.91,零依赖 best-effort)
 *
 * 业主需求:AI 要能读客户上传的需求文档内容,而不是只知道文件名。
 * 红线:零 npm 依赖——PDF/DOCX/XLSX 全部走 Node 内置 zlib 充气 + 结构解析。
 * 哲学与 kb_fts/zstd 能力探测同款:抽取失败 = 降级为「仅名称可参考」+留痕,绝不静默吞、绝不上抛炸调用方。
 *
 * 支持:
 *   - PDF  : FlateDecode 流充气 → 文本操作符(字面串 + CID hex 串经 ToUnicode CMap 映射,覆盖中文 PDF;
 *            CMap 解码方向整体择优:UTF-16BE 标准 vs GBK 字节——国产生成器常见非标形态);
 *            扫描版/无文本层 → 降级
 *   - DOCX : zip 中央目录定位 word/document.xml → 充气 → 去 XML 标签
 *   - XLSX : zip 定位 xl/sharedStrings.xml → 提取共享字符串
 *   - TXT/MD/CSV/JSON/LOG/YAML : 直接 utf8
 */

const zlib = require('node:zlib');

const MAX_INFLATE = 12 * 1024 * 1024;
const MAX_OUT = 60000;

function tryInflateRawBuf(buf) {
  try {
    return zlib.inflateRawSync(buf, { maxOutputLength: MAX_INFLATE });
  } catch (e) {
    return null;
  }
}

// ---------- PDF ----------

/** 收集全部 FlateDecode 流的充气文本(字典只取本对象 obj 头,防前对象误判) */
function collectInflatedStreams(buf) {
  const raw = buf.toString('latin1');
  const streams = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m.index >= 3 && raw.slice(m.index - 3, m.index) === 'end') { re.lastIndex = m.index + m[0].length; continue; }
    const objStart = raw.lastIndexOf(' obj', m.index);
    const dictStart = objStart < 0 ? Math.max(0, m.index - 500) : objStart;
    const dataStart = m.index + m[0].length;
    const dataEnd = raw.indexOf('endstream', dataStart);
    if (dataEnd < 0) { re.lastIndex = dataStart; continue; }
    const dict = raw.slice(dictStart, m.index);
    let text = null;
    // 只排除图片流(位图数据巨大无文本价值);Form XObject 可能含页面文本,保留
    if (/FlateDecode/.test(dict) && !/Subtype\s*\/Image|DCTDecode|JPXDecode/.test(dict)) {
      try {
        text = zlib.inflateSync(buf.slice(dataStart, dataEnd), { maxOutputLength: MAX_INFLATE }).toString('latin1');
      } catch (e) { /* 非 zlib 流 */ }
    }
    if (text) streams.push(text);
    re.lastIndex = dataEnd;
  }
  return streams;
}

/** 解析 ToUnicode CMap(bfchar + bfrange 两种形态)→ Map<cid, dstHex 原文>(解码方向后定) */
function parseCMap(text, cidMap) {
  const bc = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
  let m;
  const bfBlocks = [...text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)];
  for (const b of bfBlocks) {
    while ((m = bc.exec(b[1])) !== null) {
      const cid = parseInt(m[1], 16);
      if (Number.isFinite(cid)) cidMap.set(cid, m[2].toUpperCase());
    }
  }
  const brBlocks = [...text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)];
  const brLine = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
  for (const b of brBlocks) {
    while ((m = brLine.exec(b[1])) !== null) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;
      if (m[4] !== undefined) {
        const dsts = [...m[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1].toUpperCase());
        for (let c = lo; c <= hi && c - lo < dsts.length; c++) cidMap.set(c, dsts[c - lo]);
      } else {
        const dstBase = parseInt(m[3], 16);
        if (!Number.isFinite(dstBase)) continue;
        // 数值形态按 Unicode 码点约定:生成 4 位 dst hex 递增
        for (let c = lo; c <= hi; c++) {
          const cp = dstBase + (c - lo);
          cidMap.set(c, cp.toString(16).toUpperCase().padStart(4, '0'));
        }
      }
    }
  }
}

/** dst hex → 文本,两种解码:UTF-16BE(标准)与 GBK(国产 PDF 生成器常见非标形态) */
function decodeU16(hex) {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

let gbkDecoder = null;
function decodeGbk(hex) {
  if (gbkDecoder === null) {
    try { gbkDecoder = new TextDecoder('gbk'); } catch (e) { gbkDecoder = false; }
  }
  if (gbkDecoder === false) return null;
  const bytes = [];
  for (let i = 0; i + 2 <= hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  try { return gbkDecoder.decode(new Uint8Array(bytes)); } catch (e) { return null; }
}

/** CJK 常用汉字占比评分(防乱码择优:UTF-16BE 解 GBK 表常落 0x0080-0x0250 乱码区) */
function cjkScore(text) {
  const total = text.replace(/\s/g, '').length || 1;
  const good = (text.match(/[\u4E00-\u9FFF\u3000-\u303F0-9A-Za-z]/g) || []).length;
  return good / total;
}

/** 从 cid→dstHex 映射产出解码后的映射(整体择优:U16 vs GBK) */
function resolveDecoder(cidMap) {
  let u16Score = 0, gbkScore = 0, sampled = 0;
  for (const dstHex of cidMap.values()) {
    if (sampled >= 200) break;
    const u = decodeU16(dstHex);
    const g = decodeGbk(dstHex);
    if (g === null) { u16Score += cjkScore(u) * (u.length || 1); sampled++; continue; }
    u16Score += cjkScore(u) * (u.length || 1);
    gbkScore += cjkScore(g) * (g.length || 1);
    sampled++;
  }
  const useGbk = sampled > 0 && gbkScore > u16Score;
  return { dec: useGbk ? decodeGbk : decodeU16, useGbk };
}

/** 从充气后的内容流提取文本操作符内容(hex CID + 字面串 + TJ 数组;Td/TD/T星/ET 记换行) */
function extractContentText(content, cidMap, texts, dec) {
  const opRe = /<([0-9A-Fa-f\s]+)>\s*Tj|\(((?:\\.|[^\\()])*)\)\s*Tj|\[([\s\S]*?)\]\s*TJ|(?<![/\w])(T\*|Td|TD|ET)\b/g;
  let m;
  while ((m = opRe.exec(content)) !== null) {
    if (m[1] !== undefined) {
      const t = dec(m[1].replace(/\s/g, ''));
      if (t) texts.push(t);
    } else if (m[2] !== undefined) {
      const lit = m[2].replace(/\\([()\\nrt])/g, (_, c) => ({ n: '\n', r: '', t: '\t' }[c] || c));
      if (lit.trim()) texts.push(lit);
    } else if (m[3] !== undefined) {
      // TJ 数组:按顺序处理 hex 与字面
      const arrRe = /<([0-9A-Fa-f\s]+)>|\(((?:\\.|[^\\()])*)\)/g;
      let am;
      while ((am = arrRe.exec(m[3])) !== null) {
        if (am[1] !== undefined) {
          const t = dec(am[1].replace(/\s/g, ''));
          if (t) texts.push(t);
        } else if (am[2]) {
          texts.push(am[2].replace(/\\([()\\])/g, '$1'));
        }
      }
    } else if (m[4] !== undefined) {
      texts.push('\n');
    }
  }
}

/** 从 PDF buffer 提取文本(best-effort)。返回 null = 拉不出(扫描件/加密/无文本层)。 */
function extractPdf(buf) {
  const raw = buf.toString('latin1');
  if (!raw.startsWith('%PDF')) return null;
  const streams = collectInflatedStreams(buf);
  const cidMap = new Map();
  for (const c of streams) {
    if (/beginbfchar|beginbfrange/.test(c)) parseCMap(c, cidMap);
  }
  const texts = [];
  if (cidMap.size > 0) {
    const { dec } = resolveDecoder(cidMap);
    for (const c of streams) {
      if (/\bBT\b[\s\S]*?(Tj|TJ)/.test(c) && c.length < 4 * MAX_OUT) {
        extractContentText(c, cidMap, texts, dec);
      }
    }
  }
  const out = texts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return out ? out.slice(0, MAX_OUT) : null;
}

// ---------- ZIP(DOCX/XLSX 容器) ----------

function readZipEntries(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = {};
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    if (lho < buf.length) {
      const lnlen = buf.readUInt16LE(lho + 26);
      const lelen = buf.readUInt16LE(lho + 28);
      const dStart = lho + 30 + lnlen + lelen;
      if (dStart <= buf.length) {
        const data = buf.slice(dStart, dStart + csize);
        entries[name] = method === 0 ? data : (tryInflateRawBuf(data) || Buffer.alloc(0));
      }
    }
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

const stripXml = (xml) => xml
  .replace(/<w:p[^>]*>/g, '\n')
  .replace(/<w:tab[^>]*\/>/g, '\t')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/\n{3,}/g, '\n\n')
  .trim();

function extractDocx(buf) {
  const entries = readZipEntries(buf);
  if (!entries) return null;
  const doc = entries['word/document.xml'];
  if (!doc) return null;
  return stripXml(doc.toString('utf8')).slice(0, MAX_OUT) || null;
}

function extractXlsx(buf) {
  const entries = readZipEntries(buf);
  if (!entries) return null;
  const ss = entries['xl/sharedStrings.xml'];
  if (!ss) return null;
  const cells = [...ss.toString('utf8').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
  return (cells.join('\n').slice(0, MAX_OUT)) || null;
}

// ---------- 统一入口 ----------

function extractAttachmentText(name, buf) {
  const ext = (String(name || '').match(/\.(\w+)$/) || [])[1] || '';
  try {
    if (ext === 'pdf') {
      const t = extractPdf(buf);
      return t ? { text: t, how: 'pdf-tounicode' } : null;
    }
    if (ext === 'docx') {
      const t = extractDocx(buf);
      return t ? { text: t, how: 'docx-xml' } : null;
    }
    if (ext === 'xlsx') {
      const t = extractXlsx(buf);
      return t ? { text: t, how: 'xlsx-sharedstrings' } : null;
    }
    if (/^(txt|md|csv|json|log|yaml|yml)$/i.test(ext)) {
      return { text: buf.toString('utf8').slice(0, MAX_OUT), how: 'plain-text' };
    }
  } catch (e) {
    // 抽取失败:返回 null 由调用方降级(红线 8 由调用方留痕)
  }
  return null;
}

module.exports = { extractAttachmentText, extractPdf, extractDocx, extractXlsx, readZipEntries, extractDocx: extractDocx };
