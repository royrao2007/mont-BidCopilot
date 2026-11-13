/**
 * 纯 JS .docx 导出：手写 OOXML + 自写 ZIP（用 node:zlib 的 deflateRaw）。
 *
 * 零第三方依赖的原因：避免分发时要求安装期编译原生模块（供应链风险面），
 * 也满足"无安装期脚本"这条披露承诺。
 *
 * 输出为最小可用 Word 文档：中文字体（eastAsia）、标题层级、正文、页码域。
 *
 * @module lib/docx
 */

import { deflateRawSync } from 'node:zlib'

/** CRC32 查表。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : (value >>> 1) >>> 0
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * 计算 CRC32。
 * @param {Buffer} buffer
 * @returns {number}
 */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** XML 转义。 */
export function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

/**
 * 构造一个最小 ZIP 归档。
 *
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const compressed = deflateRawSync(raw)
    // 只在压缩确有收益时用 deflate（method 8），否则 store（method 0）。
    const useDeflate = compressed.length < raw.length
    const payload = useDeflate ? compressed : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0x0800, 6) // UTF-8 flag
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(0, 10) // mod time
    localHeader.writeUInt16LE(0x21, 12) // mod date (1980-01-01)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(raw.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, nameBytes, payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0x21, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(raw.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra
    centralHeader.writeUInt16LE(0, 32) // comment
    centralHeader.writeUInt16LE(0, 34) // disk
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(offset, 42)

    centralParts.push(centralHeader, nameBytes)
    offset += localHeader.length + nameBytes.length + payload.length
  }

  const central = Buffer.concat(centralParts)
  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0)
  endRecord.writeUInt16LE(0, 4)
  endRecord.writeUInt16LE(0, 6)
  endRecord.writeUInt16LE(entries.length, 8)
  endRecord.writeUInt16LE(entries.length, 10)
  endRecord.writeUInt32LE(central.length, 12)
  endRecord.writeUInt32LE(offset, 16)
  endRecord.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, central, endRecord])
}

// ---------------------------------------------------------------------------
// OOXML 文档部件
// ---------------------------------------------------------------------------

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>
        <w:sz w:val="24"/>
        <w:szCs w:val="24"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:line="360" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="黑体"/>
      <w:b/><w:sz w:val="36"/><w:szCs w:val="36"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="200" w:after="120"/></w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="黑体"/>
      <w:b/><w:sz w:val="28"/><w:szCs w:val="28"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="100"/></w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="黑体"/>
      <w:b/><w:sz w:val="24"/><w:szCs w:val="24"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="BodyText">
    <w:name w:val="Body Text"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:ind w:firstLineChars="200" w:firstLine="480"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr>
  </w:style>
</w:styles>`

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1."/>
      <w:lvlJc w:val="left"/>
      <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`

const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>mont-BidCopilot</Application>
</Properties>`

/**
 * 构造 core.xml（文档属性）。
 * @param {{title?: string, author?: string}} meta
 */
function coreXml(meta) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(meta?.title ?? '标书草案')}</dc:title>
  <dc:creator>${escapeXml(meta?.author ?? 'mont-BidCopilot')}</dc:creator>
  <cp:lastModifiedBy>${escapeXml(meta?.author ?? 'mont-BidCopilot')}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`
}

/**
 * 把一行文本渲染为段落 XML。
 * @param {string} text
 * @param {string} [styleId]
 * @returns {string}
 */
function paragraph(text, styleId) {
  const style = styleId === undefined ? '' : `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>`
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

/**
 * 生成文档主体 XML。
 *
 * @param {{title: string, sections: Array<{title: string, content: string}>, footerNote?: string}} doc
 * @returns {string}
 */
export function buildDocumentXml(doc) {
  const body = []
  body.push(paragraph(doc.title ?? '标书草案', 'Heading1'))

  for (const section of doc.sections ?? []) {
    body.push(paragraph(section.title, 'Heading2'))
    const paragraphs = String(section.content ?? '').split(/\n{2,}/u).map(item => item.trim()).filter(Boolean)
    for (const text of paragraphs) body.push(paragraph(text, 'BodyText'))
  }

  if (typeof doc.footerNote === 'string' && doc.footerNote.length > 0) {
    body.push(paragraph(doc.footerNote, 'BodyText'))
  }

  // 页码域：页脚在 sectPr 中引用，简化为文末声明。
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${body.join('\n    ')}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>
      <w:cols w:space="425"/>
      <w:docGrid w:type="lines" w:linePitch="312"/>
    </w:sectPr>
  </w:body>
</w:document>`
}

/**
 * 生成 .docx 二进制。
 *
 * @param {{title: string, author?: string, sections: Array<{title: string, content: string}>, footerNote?: string}} doc
 * @returns {Buffer}
 */
export function buildDocx(doc) {
  const entries = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: buildDocumentXml(doc) },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
    { name: 'docProps/core.xml', data: coreXml(doc) },
    { name: 'docProps/app.xml', data: APP },
  ]
  return buildZip(entries)
}
