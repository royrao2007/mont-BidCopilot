/**
 * 组六：0.1.4 缺陷修复回归。
 *
 * 每条用例对应一个已修复的实测缺陷，防止退化。缺陷编号沿用实测报告：
 *   B1/B2/B3  T-B1~T-B4 只认「本地/本市」代词，写具体地名时整片漏判
 *   B4        评分表父项与子项重复累加，总分算成 170
 *   B5        应急预案/服务承诺分类互换
 *   B6        pendingFactChecklist 返回含 undefined 的键，宿主 lossless JSON 校验判非法
 *   B7        manual 录入即 VERIFIED，绕过门2 的人工核验
 *   B8        招标公告解析把原文写明的截止时间/地点/评审办法抽成 null
 *   B9        审计链只记门禁裁决，写操作不留痕
 *   B10       「服务期限 3 年」被解析成 duration="限"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkClause } from '../lib/guard.js'
import { pendingFactChecklist, parseBidTender, extractScoreTable, planOutline } from '../lib/bid.js'
import { parseTender } from '../lib/tender.js'
import { createRuntime } from '../lib/runtime.js'

async function withRuntime(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-regress-'))
  const runtime = createRuntime({ root: dir, allowWrite: true })
  try {
    return await fn(runtime, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// B1/B2/B3：具体地名必须与代词同等命中
// ---------------------------------------------------------------------------

test('回归B1｜具体市名 + 设立分支机构 → 命中 T-B1', async () => {
  // 旧实现只认「本地/本市」，写真实市名时漏放。
  const verdict = await checkClause('投标人须在宜宾市设立分支机构方可参与投标。')
  assert.equal(verdict.blocked, true, '写具体市名时必须与写「本地」同等拦截')
  assert.equal(verdict.blockedBy, 'T-B1')
})

test('回归B1｜仅接受本地注册企业的排他写法 → 命中 T-B1', async () => {
  const verdict = await checkClause('本项目仅接受在宜宾市注册的企业投标，外地企业须在本地设立分公司。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B1')
})

test('回归B2｜具体市名内的业绩要求 → 命中 T-B2', async () => {
  const verdict = await checkClause('投标人近三年须在宜宾市内具有至少2个同类游泳馆运营业绩。')
  assert.equal(verdict.blocked, true, '「宜宾市内…业绩」必须被拦截')
  assert.equal(verdict.blockedBy, 'T-B2')
})

test('回归B2｜省名内的业绩要求 → 命中 T-B2', async () => {
  const verdict = await checkClause('投标人须具有四川省内类似项目业绩。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B2')
})

test('回归B3｜具体市名缴纳税收社保 → 命中 T-B3', async () => {
  const verdict = await checkClause('投标人须在宜宾市缴纳税收和社会保障资金。')
  assert.equal(verdict.blocked, true, '属地税收社保必须被拦截')
  assert.equal(verdict.blockedBy, 'T-B3')
})

test('回归B3｜项目所在地缴纳税收 → 命中 T-B3', async () => {
  const verdict = await checkClause('投标人须在项目所在地缴纳税收。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B3')
})

test('回归B4｜A品牌或B品牌 → 命中 T-B4', async () => {
  const verdict = await checkClause('水循环过滤设备须采用A品牌或B品牌产品。')
  assert.equal(verdict.blocked, true, '「A品牌或B品牌」是典型的变相指定品牌')
  assert.equal(verdict.blockedBy, 'T-B4')
})

test('回归B4｜具名品牌二选一 → 命中 T-B4', async () => {
  const verdict = await checkClause('水处理设备须为海尔品牌或美的品牌。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B4')
})

// ---------------------------------------------------------------------------
// 否定豁免：合规的禁止性表述不得误判
// ---------------------------------------------------------------------------

test('否定豁免｜「不得指定品牌」属合规表述，不判违规', async () => {
  const verdict = await checkClause('采购人不得指定品牌、型号或供应商。')
  assert.equal(verdict.blocked, false, '禁止性规定的正确写法不应被当成违规')
})

test('否定豁免｜「不得限定本地业绩」属合规表述，不判违规', async () => {
  const verdict = await checkClause('本项目不得限定投标人具有本地业绩。')
  assert.equal(verdict.blocked, false)
})

test('否定豁免｜正常资格条款不误报', async () => {
  const verdict = await checkClause(
    '投标人应为中华人民共和国境内依法注册的独立法人，具有独立承担民事责任的能力，有依法缴纳税收和社会保障资金的良好记录。',
  )
  assert.equal(verdict.blocked, false, '通用资格条款不得被属地规则误伤')
})

// ---------------------------------------------------------------------------
// B4：评分不重复累加
// ---------------------------------------------------------------------------

const TWO_LAYER_SCORES = `价格分30分
技术分60分
商务分10分
运营管理方案15分
救生安全管理方案15分
水质管理方案10分
人员配置与培训方案10分
应急预案5分
设备维护方案5分
类似项目业绩5分
企业信誉3分
服务承诺2分`

test('回归B4｜两层评分表总分为 100 而非重复累加的 170', () => {
  const rows = extractScoreTable(TWO_LAYER_SCORES)
  const outline = planOutline({ scores: rows, starClauses: [] }, { targetWords: 60000 })
  assert.equal(outline.totalScore, 100, '父项与子项不得叠加计数')
  assert.ok(outline.totalScore <= 100, '总分不可能超过 100')
})

test('回归B4｜父项被正确识别为 parent 层', () => {
  const rows = extractScoreTable(TWO_LAYER_SCORES)
  const parents = rows.filter(row => row.level === 'parent').map(row => row.item)
  assert.deepEqual(parents, ['价格分', '技术分', '商务分'])
})

test('回归B4｜平级评分表不被误判父项（总分仍为 100）', () => {
  // 「商务报价 30」后面恰好跟着「售后服务 20 + 业绩 10」，和也是 30：
  // 若按分值求和判父项会把它误判成汇总项，总分掉到 30。
  const rows = extractScoreTable('技术方案40分\n商务报价30分\n售后服务20分\n业绩10分')
  const outline = planOutline({ scores: rows, starClauses: [] }, { targetWords: 10000 })
  assert.equal(outline.totalScore, 100)
  assert.equal(outline.chapters.length, 4, '平级结构应保留全部四项为章节')
})

test('回归B4｜字数分配总和接近目标字数', () => {
  const rows = extractScoreTable(TWO_LAYER_SCORES)
  const outline = planOutline({ scores: rows, starClauses: [] }, { targetWords: 10000 })
  const totalWords = outline.chapters.reduce((sum, chapter) => sum + chapter.targetWords, 0)
  assert.ok(Math.abs(totalWords - 10000) <= outline.chapters.length, `字数总和应接近目标，实际 ${totalWords}`)
})

// ---------------------------------------------------------------------------
// B5：分类归属
// ---------------------------------------------------------------------------

test('回归B5｜应急预案归技术类而非商务类', () => {
  const rows = extractScoreTable('应急预案5分')
  assert.equal(rows[0].category, 'technical')
})

test('回归B5｜服务承诺归商务类而非技术类', () => {
  const rows = extractScoreTable('服务承诺2分')
  assert.equal(rows[0].category, 'commercial')
})

test('回归B5｜类似项目业绩归商务类', () => {
  const rows = extractScoreTable('类似项目业绩5分')
  assert.equal(rows[0].category, 'commercial')
})

// ---------------------------------------------------------------------------
// B6：无 undefined 值（宿主 lossless JSON 校验）
// ---------------------------------------------------------------------------

test('回归B6｜待核验清单默认不含 undefined 值的键', () => {
  const result = pendingFactChecklist({})
  // 显式 undefined 会被宿主判为非法输出（value is not lossless JSON）。
  assert.equal(Object.hasOwn(result, 'sourcePolicy'), false, '未要求时不应出现该键')
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('undefined'), false)
})

test('回归B6｜待核验清单在最严格的 lossless JSON 校验下可序列化', () => {
  const result = pendingFactChecklist({})
  assert.doesNotThrow(() => {
    const text = JSON.stringify(result, (_key, value) => {
      if (value === undefined) throw new Error('含 undefined 值')
      return value
    })
    assert.ok(text.length > 0)
  })
})

test('回归B6｜要求来源策略时才附带该键', () => {
  const result = pendingFactChecklist({ includePolicy: true })
  assert.ok(Array.isArray(result.sourcePolicy))
  assert.equal(result.sourcePolicy.length, result.items.length)
})

// ---------------------------------------------------------------------------
// B7：manual 录入不等于核验
// ---------------------------------------------------------------------------

test('回归B7｜manual 录入后为 UNVERIFIED，导出被阻断', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createProject({ name: '回归B7', kind: 'bid' })
    const projectId = created.project.id
    await runtime.bidWriteSection({ projectId, sectionId: 'section-01', content: '正文内容。' })
    const set = await runtime.guardVerifyFact(projectId, {
      key: 'enterpriseName', value: '测试公司', source: 'manual',
    })
    assert.equal(set.fact.status, 'UNVERIFIED', '录入不得自动视为已核验')

    const status = await runtime.projectStatus(projectId)
    assert.equal(status.facts.unverified.length, 1)
    assert.equal(status.canExport, false)
  })
})

test('回归B7｜显式核验后才转 VERIFIED', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createProject({ name: '回归B7b', kind: 'bid' })
    const projectId = created.project.id
    await runtime.guardVerifyFact(projectId, { key: 'enterpriseName', value: '测试公司', source: 'manual' })
    const verified = await runtime.guardVerifyFact(projectId, { key: 'enterpriseName', operator: '张三' })
    assert.equal(verified.fact.status, 'VERIFIED')
    assert.equal(verified.fact.verifiedBy, '张三')
  })
})

test('回归B7｜verified_kb 来源可直接视为已核验', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createProject({ name: '回归B7c', kind: 'bid' })
    const projectId = created.project.id
    const set = await runtime.guardVerifyFact(projectId, {
      key: 'creditCode', value: '91110000MA00000001', source: 'verified_kb',
    })
    assert.equal(set.fact.status, 'VERIFIED')
  })
})

// ---------------------------------------------------------------------------
// B8：招标公告字段抽取
// ---------------------------------------------------------------------------

const NOTICE_SAMPLE = `四、提交投标文件截止时间、开标时间和地点
2026年12月11日10点00分（北京时间）
地点：四川轻化工大学宜宾校区行政楼会议室

本项目采用综合评分法，价格分30分，技术分60分，商务分10分。

2. 本项目的特定资格要求：投标人须具有高危险性体育项目经营许可证（游泳）。
`

test('回归B8｜「提交投标文件截止时间」抽出真实日期', () => {
  const parsed = parseBidTender(NOTICE_SAMPLE)
  assert.match(parsed.fields.deadline.value ?? '', /2026年12月11日/u, '截止时间不得漏抽')
})

test('回归B8｜「地点：」抽出场地而非漏抽', () => {
  const parsed = parseBidTender(NOTICE_SAMPLE)
  assert.match(parsed.fields.location.value ?? '', /行政楼会议室/u)
})

test('回归B8｜无标签的「综合评分法」也能抽出评审办法', () => {
  const parsed = parseBidTender(NOTICE_SAMPLE)
  assert.match(parsed.fields.evaluation.value ?? '', /综合评分法/u)
})

test('回归B8｜资格要求抽出实质内容而非只剩政策句', () => {
  const parsed = parseBidTender(NOTICE_SAMPLE)
  assert.match(parsed.fields.qualification.value ?? '', /高危险性体育项目经营许可证/u)
})

// ---------------------------------------------------------------------------
// B9：审计链记录写操作
// ---------------------------------------------------------------------------

test('回归B9｜写章节后审计链留痕', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createProject({ name: '回归B9', kind: 'bid' })
    const projectId = created.project.id
    await runtime.bidWriteSection({ projectId, sectionId: 'section-01', content: '正文。' })
    const status = await runtime.projectStatus(projectId)
    assert.ok(status.auditChain.activities >= 1, '写操作必须入链')
    assert.ok(status.auditChain.records >= 1)
    assert.equal(status.auditChain.valid, true, '混入活动记录后链仍须校验通过')
  })
})

test('回归B9｜写事实与锁定事实均留痕，且链保持有效', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createProject({ name: '回归B9b', kind: 'bid' })
    const projectId = created.project.id
    await runtime.guardVerifyFact(projectId, { key: 'enterpriseName', value: '甲公司', source: 'manual' })
    await runtime.guardVerifyFact(projectId, { key: 'enterpriseName', operator: '张三' })
    await runtime.bidLockFacts(projectId)
    const status = await runtime.wfAdvance({ projectId, action: 'status' })
    assert.ok(status.auditChain.activities >= 3, `期望至少 3 条活动记录，实际 ${status.auditChain.activities}`)
    assert.equal(status.auditChain.gateDecisions, 0, '活动记录不得被计为门禁裁决')
    assert.equal(status.auditChain.valid, true)
  })
})

test('回归B9｜活动记录被篡改能被发现', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createProject({ name: '回归B9c', kind: 'bid' })
    const projectId = created.project.id
    await runtime.bidWriteSection({ projectId, sectionId: 'section-01', content: '正文。' })
    const project = await runtime.store.readProject(projectId)
    const records = project.workflow.gateRecords
    assert.ok(records.length >= 1)
    // 篡改活动记录的 action 字段（recordHash 已把 decision 纳入哈希）。
    records[0].decision = 'forged-action'
    const { verifyAuditChain } = await import('../lib/workflow.js')
    assert.equal(verifyAuditChain(records).valid, false, '活动记录同样受自封签保护')
  })
})

// ---------------------------------------------------------------------------
// B10：工期解析
// ---------------------------------------------------------------------------

test('回归B10｜「服务期限 3 年」解析为完整工期而非「限」', async () => {
  const parsed = await parseTender('服务期限 3 年，合同一年一签，年度考核合格后续签下一年度合同。')
  // 关键是不得为「限」——旧实现的 bug。完整保留「服务期限」前缀不影响语义，
  // 因此这里既接受「服务期限 3 年」也接受「3 年」，只要不是被截断的「限」。
  assert.notEqual(parsed.requirements.duration, '限', '不得把「限」当成工期值')
  assert.match(parsed.requirements.duration ?? '', /3\s*年/u, '必须解析出真实工期数值')
})

test('回归B10｜「工期：12 个月」正常解析', async () => {
  const parsed = await parseTender('工期：12 个月')
  assert.equal(parsed.requirements.duration, '12 个月')
})
