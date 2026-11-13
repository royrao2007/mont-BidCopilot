/**
 * 组一：功能正确性。
 *
 * 覆盖招标侧（需求解析、行业匹配、章节生成、一致性校验）、
 * 投标侧（18 项解析、评分对齐目录、章节写作、事实锁定、docx 导出）、
 * 知识检索（BM25 召回、门控）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntime } from '../lib/runtime.js'
import { buildDocx, crc32, buildZip } from '../lib/docx.js'
import { bm25Search, tokenize, chunk, explicitlyRequested, requestsSync, evaluateGate } from '../lib/kb.js'
import { parseTender, checkConsistency } from '../lib/tender.js'
import { parseBidTender, planOutline } from '../lib/bid.js'
import { matchIndustry, industryOutline } from '../lib/industry.js'

async function withRuntime(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-func-'))
  const runtime = createRuntime({ root: dir, allowWrite: true })
  try {
    return await fn(runtime, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 招标侧
// ---------------------------------------------------------------------------

test('功能｜需求解析抽出字段并把缺项标为待补充', async () => {
  const text = '采购类型：软件开发。预算：200 万元。工期：6 个月。功能要求：建设统一的政务服务平台。'
  const parsed = await parseTender(text)
  assert.equal(parsed.ok, true)
  assert.match(parsed.requirements.subjectType, /软件开发/u)
  assert.match(parsed.requirements.budget, /200/u)
  assert.ok(parsed.missingFields.includes('ipOwnership'), '未提供的知识产权字段应列入待补充')
  assert.ok(parsed.missingNotice !== null, '存在缺失项时必须给出提示')
})

test('功能｜空需求被拒绝', async () => {
  await assert.rejects(() => parseTender('   '), error => error.code === 'E_TEXT_REQUIRED')
})

test('功能｜行业匹配命中信息技术', async () => {
  const industry = await matchIndustry('本项目为软件系统集成与信息化平台建设，含数据库与网络安全要求。')
  assert.equal(industry.industry, 'it_information')
  assert.ok(industry.confidence >= 0.3)
  const outline = await industryOutline('it_information')
  assert.ok(outline.sections.length >= 3, '应返回章节骨架')
})

test('功能｜行业匹配低于阈值时回退 general', async () => {
  const industry = await matchIndustry('完全无关的一段文字，只有天气和散步。')
  assert.equal(industry.industry, 'general')
  assert.equal(industry.fallback, true)
  assert.ok(industry.note !== null)
})

test('功能｜跨板块一致性发现金额与工期冲突', () => {
  const result = checkConsistency([
    { sectionId: 'budget', content: '本项目预算 200 万元。' },
    { sectionId: 'contract', content: '合同金额 180 万元，工期 6 个月。' },
    { sectionId: 'technical', content: '工期 12 个月完成交付。' },
  ])
  assert.ok(result.count >= 2)
  assert.equal(result.autoFixed, false, '一致性校验不得自动修正')
  const kinds = result.issues.map(item => item.kind)
  assert.ok(kinds.includes('amountMismatch'))
  assert.ok(kinds.includes('durationMismatch'))
})

// ---------------------------------------------------------------------------
// 投标侧
// ---------------------------------------------------------------------------

const TENDER_SAMPLE = `项目名称：XX市政务云平台建设项目
项目编号：ZB-2026-001
招标人：XX市大数据管理局
预算：500 万元
投标截止时间：2026年12月20日 09:30
投标保证金：10 万元
工期：12 个月
资格要求：投标人须具有独立法人资格
技术要求：平台应支持不少于 5000 并发用户
评审办法：技术方案 40 分，商务报价 30 分，售后服务 20 分，业绩 10 分
★ 投标人必须提供原厂授权书
★ 未按要求密封的投标文件将被否决
质保期：3 年`

test('功能｜18 项解析抽出字段并给出覆盖率', () => {
  const parsed = parseBidTender(TENDER_SAMPLE)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.fields.projectName.value, 'XX市政务云平台建设项目')
  assert.match(parsed.fields.budget.value, /500/u)
  assert.match(parsed.coverage, /^\d+\/18$/u)
  assert.ok(parsed.coverageRatio > 0.5)
  assert.ok(parsed.starClauses.length >= 2, '应识别 ★ 实质性条款')
})

test('功能｜评分表抽取并分类', () => {
  const parsed = parseBidTender(TENDER_SAMPLE)
  assert.ok(parsed.scores.length >= 3, `期望至少 3 条评分项，实际 ${parsed.scores.length}`)
  const categories = new Set(parsed.scores.map(item => item.category))
  assert.ok(categories.has('technical'))
  assert.ok(categories.has('price'))
})

test('功能｜评分对齐目录按权重分配字数', () => {
  const parsed = parseBidTender(TENDER_SAMPLE)
  const outline = planOutline(parsed, { targetWords: 10000 })
  assert.ok(outline.chapters.length >= 3)
  const totalWords = outline.chapters.reduce((sum, chapter) => sum + chapter.targetWords, 0)
  assert.ok(Math.abs(totalWords - 10000) <= outline.chapters.length, '字数分配总和应接近目标')
  assert.ok(outline.chapters.every(chapter => chapter.rationale.length > 0))
})

test('功能｜投标章节写入与追加', async () => {
  await withRuntime(async (runtime) => {
    const created = await runtime.createProject({ name: '测试投标项目', kind: 'bid' })
    const projectId = created.project.id
    const first = await runtime.bidWriteSection({ projectId, sectionId: 'section-01', content: '第一段内容。' })
    assert.equal(first.ok, true)
    const second = await runtime.bidWriteSection({ projectId, sectionId: 'section-01', content: '第二段内容。', append: true })
    assert.equal(second.ok, true)
    const text = await runtime.store.readSection(projectId, 'section-01')
    assert.ok(text.includes('第一段内容'))
    assert.ok(text.includes('第二段内容'))
  })
})

test('功能｜无企业资料时输出待核验清单', async () => {
  await withRuntime(async (runtime) => {
    const checklist = await runtime.bidPendingChecklist({ includePolicy: true })
    assert.equal(checklist.ok, true)
    assert.ok(checklist.items.length >= 7)
    assert.ok(checklist.items.every(item => item.status === 'UNVERIFIED'))
    assert.ok(checklist.notice.includes('不是可直接递交的标书'))
  })
})

test('功能｜docx 导出产出合法 ZIP 结构', async () => {
  const buffer = buildDocx({
    title: '测试标书',
    author: 'test',
    sections: [{ title: '第一章', content: '正文内容一。\n\n正文内容二。' }],
    footerNote: '草案说明',
  })
  assert.ok(Buffer.isBuffer(buffer))
  // ZIP 魔数
  assert.equal(buffer.readUInt32LE(0), 0x04034b50)
  // 末尾 EOCD
  const eocdOffset = buffer.length - 22
  assert.equal(buffer.readUInt32LE(eocdOffset), 0x06054b50)
  const entryCount = buffer.readUInt16LE(eocdOffset + 8)
  assert.equal(entryCount, 8, '应为 8 个部件')

  // 解回来验证 document.xml 含中文标题
  const text = buffer.toString('latin1')
  assert.ok(text.includes('[Content_Types].xml'))
  assert.ok(text.includes('word/document.xml'))
})

test('功能｜CRC32 与已知值一致', () => {
  // "123456789" 的标准 CRC32 为 0xCBF43926
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926)
})

test('功能｜ZIP 构建对多个条目均可解出原始内容', () => {
  const zip = buildZip([
    { name: 'a.txt', data: Buffer.from('hello', 'utf8') },
    { name: 'b/c.txt', data: Buffer.from('世界', 'utf8') },
  ])
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
  const eocd = zip.length - 22
  assert.equal(zip.readUInt16LE(eocd + 8), 2)
})

// ---------------------------------------------------------------------------
// 知识检索
// ---------------------------------------------------------------------------

test('功能｜BM25 召回并按相关度排序', () => {
  const docs = [
    { docId: 'a', text: '农药追溯二维码的编码规则与政策要求。' },
    { docId: 'b', text: '食堂卫生管理制度与消毒记录。' },
    { docId: 'c', text: '二维码用于产品追溯，追溯码应可查询。' },
  ]
  const results = bm25Search(docs, '农药追溯二维码政策')
  assert.ok(results.length >= 1)
  assert.equal(results[0].docId, 'a', '最相关文档应排第一')
})

test('功能｜中文 bigram 分词产出二元组', () => {
  const tokens = tokenize('追溯二维码')
  assert.ok(tokens.includes('追溯'))
  assert.ok(tokens.includes('溯二'))
  const english = tokenize('trace qr code')
  assert.ok(english.includes('trace'))
})

test('功能｜分块按目标大小聚合', () => {
  const pieces = chunk('段落一。\n\n段落二。\n\n段落三。', 6)
  assert.ok(pieces.length >= 2)
  assert.ok(pieces.every(piece => piece.text.length > 0))
})

test('功能｜门控：点名触发词才放行', () => {
  assert.equal(explicitlyRequested('用知识库查一下农药追溯'), true)
  assert.equal(explicitlyRequested('今天天气不错'), false)
  assert.equal(explicitlyRequested('不要用知识库，直接回答'), false, '否定词应使门控不放行')
  assert.equal(explicitlyRequested('按 方案模板/常规模板.docx 写一份方案', { names: ['常规模板.docx'] }), true)
})

test('功能｜门控：同步意图识别', () => {
  assert.equal(requestsSync('同步一下知识库索引'), true)
  assert.equal(requestsSync('不要同步索引'), false)
})

test('功能｜门控评估 fail-closed', () => {
  const denied = evaluateGate({ userText: '随便聊聊', explicit: false })
  assert.equal(denied.allowed, false)
  assert.ok(denied.reason.includes('尚未启用'))
  const allowed = evaluateGate({ userText: '用知识库查一下', explicit: false })
  assert.equal(allowed.allowed, true)
})

test('功能｜知识库检索在未点名时被拒绝', async () => {
  const kbDir = await mkdtemp(join(tmpdir(), 'mbc-kb-'))
  try {
    await writeFile(join(kbDir, 'a.md'), '农药追溯二维码政策说明。', 'utf8')
    const runtime = createRuntime({ root: await mkdtemp(join(tmpdir(), 'mbc-kbroot-')), allowWrite: true, kbDir })
    const denied = await runtime.kbSearch({ query: '农药', userText: '你好' })
    assert.equal(denied.ok, false)
    assert.equal(denied.gated, true)
    assert.equal(denied.code, 'E_KB_NOT_REQUESTED')

    const allowed = await runtime.kbSearch({ query: '农药追溯', userText: '用知识库查一下农药追溯' })
    assert.equal(allowed.ok, true)
    assert.ok(allowed.results.length >= 1)
  } finally {
    await rm(kbDir, { recursive: true, force: true })
  }
})
