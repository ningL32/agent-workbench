'use strict';

/**
 * learnImport.js — 学习资料的导入器（v2.9.56）
 *
 * 约束：**零第三方依赖**（AGENTS 红线 1），只用 Node 内置模块。
 * 支持：.md / .txt / .html(.htm) / .docx / .pdf
 *  - docx = zip + word/document.xml，自己解 zip（中央目录 + inflateRaw）
 *  - html = 去 script/style、块级标签换行、解实体
 *  - pdf = 解 FlateDecode 流 + 抓文本操作符；**子集字体/扫描件会抽不出字**，如实报错而不是塞垃圾
 *
 * 产出：把文本写成 `data/learn/imports/<slug>.md`（本地学习库），页面索引里用 `import:` 前缀，
 * **绝不写入用户的知识库**。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const KINDS = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.html': 'html',
  '.htm': 'html',
  '.docx': 'docx',
  '.pdf': 'pdf',
};
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_FILES = 200;

function kindOf(filePath) {
  return KINDS[path.extname(String(filePath)).toLowerCase()] || null;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** HTML → 纯文本：去脚本样式、块级换行、解实体、压空白 */
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<h([1-6])[^>]*>/gi, (m, n) => `${'#'.repeat(Number(n))} `);
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

// ---------- zip（docx 用） ----------

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 极简 zip 读取：返回 { [name]: Buffer }（只支持 store/deflate，足够读 docx） */
function readZip(buf) {
  const entries = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/docx（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    if (!raw.length) continue;
    try {
      entries[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    } catch (e) {
      /* 单个条目坏了不影响其它 */
    }
  }
  return entries;
}

/** docx → 文本：<w:p> 分段、<w:t> 取字 */
function docxToText(buf) {
  const files = readZip(buf);
  const docName = Object.keys(files).find((n) => /^word\/document\d*\.xml$/.test(n));
  if (!docName) throw new Error('docx 里找不到 word/document.xml');
  const xml = files[docName].toString('utf8');
  const body = xml.replace(/<w:tbl[\s\S]*?<\/w:tbl>/g, (tbl) => `${tbl}\n`);
  const paragraphs = body.split(/<\/w:p>/);
  const lines = [];
  for (const p of paragraphs) {
    const texts = Array.from(p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)).map((m) => m[1]);
    if (!texts.length) continue;
    lines.push(decodeEntities(texts.join('')).replace(/\s+/g, ' ').trim());
  }
  return lines.filter(Boolean).join('\n');
}

// ---------- pdf ----------

function decodePdfString(s) {
  return s
    .replace(/\\([nrtbf])/g, (m, c) => ({ n: '\n', r: '\n', t: '\t', b: '', f: '' }[c] || c))
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\(\d{1,3})/g, (m, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/** 从解压后的内容流里抓文本操作符（Tj / TJ / ' / "） */
function textFromContent(content) {
  const out = [];
  const pickStrings = (chunk) => {
    const parts = [];
    for (const m of chunk.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) parts.push(decodePdfString(m[1]));
    return parts.join('');
  };
  for (const m of content.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) out.push(pickStrings(m[1]));
  for (const m of content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g)) out.push(decodePdfString(m[1]));
  return out.join('');
}

/** pdf → 文本（尽力而为；抽不出来就明确失败，不塞垃圾） */
function pdfToText(buf) {
  const raw = buf.toString('latin1');
  const chunks = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const slice = buf.slice(start, end);
    let content = null;
    try {
      content = zlib.inflateSync(slice).toString('latin1');
    } catch (e) {
      // 未压缩流：直接当文本内容试一次
      content = slice.toString('latin1');
    }
    if (content && /(Tj|TJ)\b/.test(content)) chunks.push(textFromContent(content));
    re.lastIndex = end + 9;
  }
  const text = chunks
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const usable = (text.match(/[\u4e00-\u9fa5A-Za-z0-9]/g) || []).length;
  return { text, usable };
}

// ---------- 统一入口 ----------

/** 读一个文件并抽取文本：返回 {ok, kind, text, chars, warning?} */
function extractText(filePath) {
  const kind = kindOf(filePath);
  if (!kind) return { ok: false, kind: null, reason: '不支持的格式（支持 md/txt/html/docx/pdf）' };
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (e) {
    return { ok: false, kind, reason: `读不到文件：${path.basename(filePath)}` };
  }
  if (st.size > MAX_FILE_BYTES) return { ok: false, kind, reason: '文件超过 40MB，先拆分' };
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    return { ok: false, kind, reason: '读取失败（权限或文件被占用）' };
  }

  let text = '';
  let warning = null;
  try {
    if (kind === 'md' || kind === 'txt') {
      text = buf.toString('utf8');
    } else if (kind === 'html') {
      text = htmlToText(buf.toString('utf8'));
    } else if (kind === 'docx') {
      text = docxToText(buf);
    } else if (kind === 'pdf') {
      const r = pdfToText(buf);
      text = r.text;
      if (r.usable < 120) {
        return {
          ok: false,
          kind,
          reason: 'PDF 没抽出可用文本（扫描件或子集字体编码）——先用 OCR/转换工具转成 md 再导入',
        };
      }
      if (r.usable < 400) warning = '抽取到的文本较少，可能是版式复杂或部分页面为图片';
    }
  } catch (e) {
    return { ok: false, kind, reason: String((e && e.message) || e).slice(0, 200) };
  }

  text = String(text || '').trim();
  if (text.length < 20) return { ok: false, kind, reason: '抽取出的文本太少（<20 字），放弃导入' };
  return { ok: true, kind, text, chars: text.length, warning };
}

/** 从路径收集待导入文件（文件 → 单个；目录 → 递归受支持格式） */
function collectFiles(inputPath) {
  const abs = path.resolve(String(inputPath || '').trim());
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    return { ok: false, reason: `路径不存在：${inputPath}` };
  }
  if (st.isFile()) {
    return kindOf(abs) ? { ok: true, files: [abs] } : { ok: false, reason: '该文件格式不在支持范围（md/txt/html/docx/pdf）' };
  }
  const files = [];
  const walk = (dir) => {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (files.length >= MAX_FILES) return;
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (kindOf(ent.name)) files.push(full);
    }
  };
  walk(abs);
  if (!files.length) return { ok: false, reason: '目录里没有可导入的文件' };
  return { ok: true, files };
}

function slugify(filePath) {
  const base = path.basename(filePath).replace(/\.[^.]+$/, '');
  const ascii = base.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const hash = require('node:crypto').createHash('sha1').update(filePath).digest('hex').slice(0, 6);
  return `${ascii || 'doc'}-${hash}`;
}

module.exports = {
  KINDS,
  MAX_FILES,
  kindOf,
  htmlToText,
  readZip,
  docxToText,
  pdfToText,
  extractText,
  collectFiles,
  slugify,
};
