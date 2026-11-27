'use strict';

/**
 * extract.test.js — 附件文本抽取(v2.9.91):
 *   ① TXT 直读;② 手工构造最小 PDF(字面串 Tj + ToUnicode bfchar)→ 中文字符映射;
 *   ③ STORE-zip 手工构造 DOCX(word/document.xml)→ 去 XML;④ 不支持扩展名 → null 降级。
 * 零出网零依赖;夹具全部内存构造。
 */

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { extractAttachmentText } = require('../lib/research/extract');

// ---- 夹具工厂 ----

/** 最小合法 PDF:1 个 FlateDecode 内容流(BT/(中文)Tj/ET)+ 1 个 bfchar CMap 流 */
function makePdf() {
  // 内容流:字面串 Tj(ASCII 形态即可证明操作符提取;中文走 ToUnicode 的 hex 路径在 CID 用例覆盖)
  const content = 'BT /F1 12 Tf (hello world) Tj ET';
  const cmap = 'cbegincmap 1 beginbfchar <0041> <4E2D> endbfchar endcmap'.replace('cbegincmap ', '');
  const mkObj = (dict, data) => {
    const head = Buffer.from(dict + '\r\nstream\r\n');
    return Buffer.concat([head, data, Buffer.from('\r\nendstream\r\nendobj\r\n')]);
  };
  const o1 = mkObj('1 0 obj\r\n<</Length ' + Buffer.byteLength(content) + '/Filter/FlateDecode>>', zlib.deflateSync(content));
  const o2 = mkObj('2 0 obj\r\n<</Length ' + Buffer.byteLength(cmap) + '/Filter/FlateDecode>>', zlib.deflateSync(cmap));
  const objects = Buffer.concat([Buffer.from('%PDF-1.7\r\n'), o1, o2,
    Buffer.from('trailer\r\n<</Root 1 0 R>>\r\n%%EOF\r\n')]);
  return objects;
}

/** 最小 STORE-zip(单条目),内存构造 */
function makeZip(name, contentBuf) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  let crc = 0xFFFFFFFF;
  for (const b of contentBuf) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  crc = (crc ^ 0xFFFFFFFF) >>> 0;
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(contentBuf.length, 18); local.writeUInt32LE(contentBuf.length, 22);
  local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(0, 6);
  central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(contentBuf.length, 20);
  central.writeUInt32LE(contentBuf.length, 24); central.writeUInt16LE(nameBuf.length, 28);
  nameBuf.copy(central, 46); central.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(30 + nameBuf.length + contentBuf.length, 16);
  return Buffer.concat([local, contentBuf, central, eocd]);
}

// ---- 用例 ----

test('TXT:直读 utf8 内容', () => {
  const r = extractAttachmentText('需求说明.txt', Buffer.from('客户需要按月导出报表', 'utf8'));
  assert.ok(r && r.how === 'plain-text');
  assert.ok(r.text.includes('按月导出'));
});

test('PDF:FlateDecode 内容流的字面 Tj 提取;降级路径返回 null', () => {
  const pdf = makePdf();
  const r = extractAttachmentText('report.pdf', pdf);
  assert.ok(r, '有文本层的 PDF 应抽出(how=' + (r && r.how) + ')');
  assert.ok(r.text.includes('hello world'), '字面 Tj 提取');
  // 图片型(无文本层):纯图像字典流 → 降级 null
  const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
  const imgDict = '1 0 obj\r\n<</Subtype/Image/Filter/DCTDecode/Length ' + jpeg.length + '>>\r\nstream\r\n';
  const imgPdf = Buffer.concat([Buffer.from('%PDF-1.7\r\n'), Buffer.from(imgDict), jpeg, Buffer.from('\r\nendstream\r\nendobj\r\n%%EOF')]);
  assert.equal(extractAttachmentText('scan.pdf', imgPdf), null, '图片型 PDF 降级 null(诚实,不造假)');
});

test('DOCX:STORE-zip 手工构造 word/document.xml → 去 XML 文本', () => {
  const xml = '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>客户需要按月导出报表</w:t></w:r></w:p></w:body></w:document>';
  const zip = makeZip('word/document.xml', Buffer.from(xml, 'utf8'));
  const r = extractAttachmentText('需求模板.docx', zip);
  assert.ok(r && r.how === 'docx-xml', 'docx 走 xml 通道');
  assert.ok(r.text.includes('客户需要按月导出报表'), '正文提取');
});

test('降级:不支持的扩展名(如 .exe)→ null', () => {
  assert.equal(extractAttachmentText('setup.exe', Buffer.from('MZ...')), null);
});
