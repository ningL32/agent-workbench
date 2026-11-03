'use strict';

/**
 * learn-import.test.js — 导入器（v2.9.56）：docx/html/pdf/md/txt → 本地学习库
 *
 * 零第三方依赖：docx 的 zip 与 pdf 的文本操作符都由 lib/learnImport.js 自己解。
 * 这里用最小合法样本验证三种格式 + 导入落库 + 重扫不丢。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const imp = require('../lib/learnImport');
const learn = require('../lib/learn');

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fde-${tag}-`));
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (e) {
      /* Windows EPERM 容错 */
    }
  }
}

/** 最小 zip 写入器（store 模式，够拼一个 docx） */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

function makeDocx(paragraphs) {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return makeZip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': xml,
  });
}

function makePdf(line) {
  const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'latin1');
}

test('htmlToText：去脚本样式、块级换行、解实体', () => {
  const html = `<html><head><style>.a{color:red}</style></head><body>
    <h2>标题&nbsp;甲</h2><script>alert('x')</script>
    <p>第一段 &amp; 第二段</p><ul><li>要点一</li><li>要点二</li></ul>
  </body></html>`;
  const text = imp.htmlToText(html);
  assert.ok(!/color:red|alert/.test(text), '脚本与样式必须去掉');
  assert.match(text, /^## 标题 甲/m, '标题转 markdown 且解 &nbsp;');
  assert.match(text, /第一段 & 第二段/, '实体要解码');
  assert.match(text, /- 要点一/, '列表项要保留结构');
});

test('docxToText：自己解 zip + 抽 w:t 段落', () => {
  const buf = makeDocx(['第一段内容', '第二段内容']);
  const text = imp.docxToText(buf);
  assert.match(text, /第一段内容/);
  assert.match(text, /第二段内容/);
  assert.equal(text.split('\n').length, 2, '一段一行');
  assert.throws(() => imp.docxToText(Buffer.from('not a zip')), /zip|中央目录/);
});

test('pdfToText：抓文本操作符；无可用文本时如实返回', () => {
  const ok = imp.pdfToText(makePdf('Hello AI engineering from scratch'));
  assert.match(ok.text, /Hello AI engineering/);
  assert.ok(ok.usable > 10);

  const empty = imp.pdfToText(Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nstream\nBT ET\nendstream\nendobj\n', 'latin1'));
  assert.equal(empty.usable, 0, '抽不出字要能被上层识别为失败');
});

test('extractText：md 直读；不支持的扩展名给明确原因', () => {
  const dir = tmpdir('imp-read');
  try {
    const md = path.join(dir, 'a.md');
    fs.writeFileSync(md, '# 标题\n\n这是一段足够长的正文，用来验证读取。\n');
    const r = imp.extractText(md);
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'md');
    assert.match(r.text, /足够长/);

    const bad = imp.extractText(path.join(dir, 'a.exe'));
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /不支持/);
  } finally {
    cleanup(dir);
  }
});

test('collectFiles：目录递归只收受支持格式', () => {
  const dir = tmpdir('imp-collect');
  try {
    fs.mkdirSync(path.join(dir, '子目录'));
    fs.writeFileSync(path.join(dir, 'a.md'), '# a\n\n内容内容内容内容内容\n');
    fs.writeFileSync(path.join(dir, '子目录', 'b.html'), '<p>内容内容内容内容内容</p>');
    fs.writeFileSync(path.join(dir, 'c.png'), 'binary');
    const r = imp.collectFiles(dir);
    assert.equal(r.ok, true);
    assert.equal(r.files.length, 2);
    assert.ok(r.files.every((f) => /\.(md|html)$/.test(f)));
  } finally {
    cleanup(dir);
  }
});

test('importMaterials：落本地 imports/、进页面索引、重扫不丢、能抽出知识点', async () => {
  const dir = tmpdir('imp-src');
  const ctx = { dataDir: tmpdir('imp-data'), config: { learn: { seeds: [] } } };
  const engine = async (prompt) => {
    if (prompt.includes('原子知识点')) {
      return JSON.stringify({ concepts: [{ term: '导入口诀', definition: '把外部资料抽成术语', why: '不用手抄' }] });
    }
    return JSON.stringify({ good: [], missing: [], jargon: [], misconception: [], probe: 'p', level: 2 });
  };
  try {
    const pdf = path.join(dir, '一本书.pdf');
    const sentence = 'The agent loop repeats thought, action and observation until a termination condition. ';
    fs.writeFileSync(pdf, makePdf(sentence.repeat(3).trim()));
    const html = path.join(dir, '网页.html');
    fs.writeFileSync(html, '<h2>网页标题</h2><p>网页正文内容，足够长足够长足够长。</p>');
    const scannedSrc = path.join(dir, 'ignored.png');
    fs.writeFileSync(scannedSrc, 'x');

    const r = learn.importMaterials(ctx, dir);
    assert.equal(r.ok, true);
    assert.equal(r.imported.length, 2, 'pdf 与 html 都要导入');
    assert.ok(r.imported.every((x) => x.page.startsWith('import:')), '页面用 import: 前缀，不混进知识库');

    const files = fs.readdirSync(path.join(ctx.dataDir, 'learn', 'imports'));
    assert.equal(files.length, 2, '每个导入都留一份 md 副本');

    const pages = learn.loadPages(ctx);
    assert.equal(pages.filter((p) => p.rel.startsWith('import:')).length, 2);

    // 重扫（scanVault 看不到 imports 目录）不得把导入的页面冲掉
    const fakeScan = { root: '/x', scannedAt: new Date().toISOString(), entries: [] };
    const after = learn.syncPages(ctx, fakeScan);
    assert.equal(after.filter((p) => p.rel.startsWith('import:')).length, 2, '重扫要保留导入页面');

    const added = await learn.ensureFreshConcepts(ctx, { engine });
    assert.ok(added.added > 0, '导入的资料要能被抽成知识点');
    const items = learn.loadItems(ctx);
    assert.ok(items.some((i) => String(i.sourcePath).startsWith('import:')), '知识点要能回溯到导入来源');
  } finally {
    cleanup(dir, ctx.dataDir);
  }
});
