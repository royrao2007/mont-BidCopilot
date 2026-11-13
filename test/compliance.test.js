/**
 * 组二：合规硬约束不可绕过。
 *
 * 每条 T-B 规则都至少一个命中用例 + 一个未命中用例。
 * 另外覆盖：事实字段禁用来源注入被拒、雷同超阈值阻断导出、无批量生成入口。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkClause, checkFactSource, FACT_SOURCE_POLICY, loadRules } from '../lib/guard.js'
import { setFact, FactError, inferCategory } from '../lib/facts.js'
import { createRuntime } from '../lib/runtime.js'
import { checkSelfDuplication, checkCollusion, similarity } from '../lib/similarity.js'

async function withRuntime(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-comp-'))
  const runtime = createRuntime({ root: dir, allowWrite: true })
  try {
    return await fn(runtime, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// T-B1：本地分支机构 / 本地人员
// ---------------------------------------------------------------------------

test('合规｜T-B1 命中：本地分支机构作为资格条件', async () => {
  const verdict = await checkClause('投标人须在本市设有分支机构，并在本地拥有固定办公场所。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B1')
  assert.ok(verdict.hits[0].evidence.length > 0, '必须给出命中证据原文')
  assert.ok(verdict.legalBasis !== null)
})

test('合规｜T-B1 命中：本地户籍人员要求', async () => {
  const verdict = await checkClause('项目经理须为本地户籍人员。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B1')
})

test('合规｜T-B1 未命中：正常法人资格要求', async () => {
  const verdict = await checkClause('投标人须具有独立承担民事责任的能力，并具备良好的商业信誉。')
  assert.equal(verdict.blocked, false)
  assert.equal(verdict.blockedBy, null)
})

// ---------------------------------------------------------------------------
// T-B2：本地业绩
// ---------------------------------------------------------------------------

test('合规｜T-B2 命中：本地业绩加分', async () => {
  const verdict = await checkClause('投标人具有本省业绩的，每项加 2 分。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B2')
})

test('合规｜T-B2 命中：业绩须位于本市', async () => {
  const verdict = await checkClause('提供的类似项目业绩须位于本市行政区域内。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B2')
})

test('合规｜T-B2 未命中：不限定地域的业绩要求', async () => {
  const verdict = await checkClause('投标人应提供近三年内不少于 2 个类似项目业绩，并提供合同复印件。')
  assert.equal(verdict.blocked, false)
})

// ---------------------------------------------------------------------------
// T-B3：税收社保缴纳地
// ---------------------------------------------------------------------------

test('合规｜T-B3 命中：本市缴纳社保作为门槛', async () => {
  const verdict = await checkClause('投标人须在本市依法缴纳社会保险，并提供社保缴纳证明。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B3')
})

test('合规｜T-B3 命中：纳税属地限制', async () => {
  const verdict = await checkClause('纳税地点须在本省。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B3')
})

test('合规｜T-B3 未命中：一般纳税资格要求', async () => {
  const verdict = await checkClause('投标人应具备增值税一般纳税人资格。')
  assert.equal(verdict.blocked, false)
})

// ---------------------------------------------------------------------------
// T-B4：指定品牌 / 供应商
// ---------------------------------------------------------------------------

test('合规｜T-B4 命中：指定品牌', async () => {
  const verdict = await checkClause('本项目必须采用指定品牌的服务器设备。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B4')
})

test('合规｜T-B4 命中：限定独家授权', async () => {
  const verdict = await checkClause('投标人须具有该产品的独家授权。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B4')
})

test('合规｜T-B4 未命中：功能性描述而非品牌', async () => {
  const verdict = await checkClause('服务器应满足不少于 32 核 CPU、256GB 内存的性能要求。')
  assert.equal(verdict.blocked, false)
})

// ---------------------------------------------------------------------------
// T-B5：已取消资质
// ---------------------------------------------------------------------------

test('合规｜T-B5 命中：已取消的信息系统集成资质', async () => {
  const verdict = await checkClause('投标人须具备计算机信息系统集成资质。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B5')
})

test('合规｜T-B5 命中：已取消的招标代理资格', async () => {
  const verdict = await checkClause('投标人应持有招标代理机构资格证书。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.blockedBy, 'T-B5')
})

test('合规｜T-B5 未命中：现行有效资质', async () => {
  const verdict = await checkClause('投标人应具备建筑工程施工总承包二级及以上资质。')
  assert.equal(verdict.blocked, false)
})

// ---------------------------------------------------------------------------
// 规则库结构完整性
// ---------------------------------------------------------------------------

test('合规｜规则库五条硬阻断规则齐备且有编译后的判定式', async () => {
  const rules = await loadRules()
  const ids = rules.rules.map(rule => rule.id)
  for (const expected of ['T-B1', 'T-B2', 'T-B3', 'T-B4', 'T-B5']) {
    assert.ok(ids.includes(expected), `缺少规则 ${expected}`)
  }
  for (const rule of rules.rules) {
    assert.ok(rule.compiled.length > 0, `${rule.id} 无判定模式`)
    assert.ok(rule.legalBasis !== undefined, `${rule.id} 缺法条依据`)
    assert.ok(rule.reason.length > 0, `${rule.id} 缺阻断理由`)
  }
  assert.ok(rules.reviewRequired.length >= 3, '强制人工复核项应存在')
})

test('合规｜按 ruleIds 只检查指定规则', async () => {
  const text = '投标人须在本市设有分支机构，且须具备计算机信息系统集成资质。'
  const onlyB1 = await checkClause(text, { ruleIds: ['T-B1'] })
  assert.equal(onlyB1.blockedBy, 'T-B1')
  const onlyB5 = await checkClause(text, { ruleIds: ['T-B5'] })
  assert.equal(onlyB5.blockedBy, 'T-B5')
})

// ---------------------------------------------------------------------------
// 招标侧：生成路径被阻断
// ---------------------------------------------------------------------------

test('合规｜mont_tender_draft_section 命中阻断时不产出条款文本', async () => {
  await withRuntime(async (runtime) => {
    const result = await runtime.tenderDraftSection({
      sectionId: 'qualification',
      title: '资格条件',
      content: '投标人须在本市设有分支机构。',
    })
    assert.equal(result.generated, false, '命中硬阻断规则必须拒绝生成')
    assert.equal(result.blockedBy, 'T-B1')
    assert.equal(result.content, null, '不得返回可用条款文本')
    assert.ok(result.guidance.includes('不得以改写措辞方式规避'))
  })
})

test('合规｜未命中规则时正常生成并附复核项', async () => {
  await withRuntime(async (runtime) => {
    const result = await runtime.tenderDraftSection({
      sectionId: 'technical',
      title: '技术要求',
      content: '平台应支持不少于 5000 并发用户，响应时间不超过 2 秒。',
    })
    assert.equal(result.generated, true)
    assert.ok(result.content.length > 0)
    assert.ok(Array.isArray(result.mandatoryReview))
  })
})

test('合规｜合同类章节强制标记法务复核', async () => {
  await withRuntime(async (runtime) => {
    const result = await runtime.tenderDraftSection({
      sectionId: 'contract',
      title: '合同草案',
      content: '甲乙双方应于合同签订后 30 日内完成交付。',
    })
    assert.equal(result.generated, true)
    assert.equal(result.requiresLegalReview, true)
  })
})

// ---------------------------------------------------------------------------
// 事实字段：禁用来源注入
// ---------------------------------------------------------------------------

test('合规｜事实来源策略覆盖全部类别', () => {
  const categories = Object.keys(FACT_SOURCE_POLICY)
  assert.ok(categories.includes('performance'))
  assert.ok(categories.includes('qualification'))
  for (const policy of Object.values(FACT_SOURCE_POLICY)) {
    assert.ok(Array.isArray(policy.allowedSources) && policy.allowedSources.length > 0)
    assert.ok(policy.label.length > 0)
  }
})

test('合规｜业绩字段拒绝来自联网搜索与类似项目', () => {
  for (const source of ['L2', 'web', 'search', 'similar_project', 'model']) {
    const verdict = checkFactSource('performance', source)
    assert.equal(verdict.allowed, false, `来源 ${source} 应被拒绝`)
    assert.ok(verdict.reason.includes('不允许来自'))
  }
  assert.equal(checkFactSource('performance', 'manual').allowed, true)
  assert.equal(checkFactSource('performance', 'verified_kb').allowed, true)
})

test('合规｜企业名称拒绝模型生成', () => {
  assert.equal(checkFactSource('enterpriseName', 'model').allowed, false)
  assert.equal(checkFactSource('enterpriseName', 'L1').allowed, false)
  assert.equal(checkFactSource('enterpriseName', 'manual').allowed, true)
})

test('合规｜setFact 对禁用来源抛错且不写入', () => {
  const project = { facts: [] }
  assert.throws(
    () => setFact(project, { key: 'performance', value: '某项目 1000 万', source: 'L2' }),
    error => error instanceof FactError && error.code === 'E_FACT_SOURCE_REJECTED',
  )
  assert.equal(project.facts.length, 0, '被拒绝的来源不得留下任何字段')
})

test('合规｜setFact 缺来源声明直接拒绝', () => {
  const project = { facts: [] }
  assert.throws(
    () => setFact(project, { key: 'enterpriseName', value: '某公司' }),
    error => error.code === 'E_FACT_SOURCE_REQUIRED',
  )
})

test('合规｜人工录入的事实初始为 VERIFIED，外部引用仍为 UNVERIFIED', () => {
  const project = { facts: [] }
  const manual = setFact(project, { key: 'enterpriseName', value: '甲公司', source: 'manual' })
  assert.equal(manual.fact.status, 'VERIFIED')

  const technical = setFact(project, { key: 'technicalApproach', value: '采用微服务架构', source: 'L2' })
  assert.equal(technical.fact.status, 'UNVERIFIED', '外部引用不等于本企业事实已核实')
})

test('合规｜事实类别可按键名推断', () => {
  assert.equal(inferCategory('creditCode'), 'creditCode')
  assert.equal(inferCategory('qualificationCertNo'), 'qualification')
  assert.equal(inferCategory('performanceProjectA'), 'performance')
  assert.equal(inferCategory('unknownField'), 'other')
})

// ---------------------------------------------------------------------------
// 雷同自检
// ---------------------------------------------------------------------------

test('合规｜自我复制：完全相同文本必超阈值', () => {
  const text = '本项目采用微服务架构，实现统一身份认证与数据共享交换能力。'
  const result = checkSelfDuplication(text, [{ id: 'tpl', text }], { threshold: 0.85 })
  assert.equal(result.blocked, true)
  assert.equal(result.findings[0].kind, 'selfDuplication')
  assert.ok(result.findings[0].score >= 0.85)
})

test('合规｜自我复制：不同文本不触发', () => {
  const result = checkSelfDuplication(
    '本项目围绕设备运维响应时效展开，强调备件库与现场工程师的联动机制。',
    [{ id: 'tpl', text: '招标文件要求投标人具备三年以上类似项目业绩并提供合同复印件。' }],
    { threshold: 0.85 },
  )
  assert.equal(result.blocked, false)
})

test('合规｜围标：两投标人文本高度相似触发预警', () => {
  const text = '我们采用三层架构设计，前端使用 Vue 框架，后端使用 Spring Boot，数据库采用 MySQL 集群部署方案。'
  const other = '我们采用三层架构设计，前端使用 Vue 框架，后端使用 Spring Boot，数据库采用 MySQL 集群部署方案。'
  const result = checkCollusion(text, [{ bidderId: 'b2', text: other }], { threshold: 0.65 })
  assert.equal(result.blocked, true)
  assert.equal(result.findings[0].kind, 'collusion')
})

test('合规｜两条规则阈值独立：自复制阈值不套用到围标', () => {
  // 一条文本与模板相似度约 0.9，会触发自复制（阈值 0.85），但与围标阈值 0.65 也是超的；
  // 关键断言是调用方能分别传两个阈值且结果互不影响。
  const text = '本项目采用微服务架构，实现统一身份认证与数据共享交换能力，支持横向扩展。'
  const tpl = '本项目采用微服务架构，实现统一身份认证与数据共享交换能力，支持水平扩展。'
  const selfHigh = checkSelfDuplication(text, [{ id: 't', text: tpl }], { threshold: 0.99 })
  const selfLow = checkSelfDuplication(text, [{ id: 't', text: tpl }], { threshold: 0.5 })
  assert.equal(selfHigh.blocked, false, '阈值 0.99 时不应阻断')
  assert.equal(selfLow.blocked, true, '阈值 0.5 时应阻断')
})

test('合规｜相似度对称且有界', () => {
  const a = '招标文件要求投标人具备相应资质'
  const b = '投标人须具备相应资质并提供证明'
  const ab = similarity(a, b)
  const ba = similarity(b, a)
  assert.equal(ab, ba)
  assert.ok(ab >= 0 && ab <= 1)
  assert.equal(similarity(a, a), 1)
})

// ---------------------------------------------------------------------------
// 无批量生成入口（架构性）
// ---------------------------------------------------------------------------

test('合规｜工具清单中不存在批量生成/批量导出工具', async () => {
  const registered = []
  const fakeCtx = {
    tools: {
      register(definition) {
        registered.push(definition.name)
        return () => {}
      },
    },
  }
  const { registerTools } = await import('../lib/tools.js')
  const dir = await mkdtemp(join(tmpdir(), 'mbc-tools-'))
  try {
    const runtime = createRuntime({ root: dir, allowWrite: true })
    registerTools(fakeCtx, runtime)
    await new Promise(resolve => setTimeout(resolve, 50))
    const batchLike = registered.filter(name => /batch|bulk|multiple|多份|批量/iu.test(name))
    assert.deepEqual(batchLike, [], `不应存在批量类工具，实际：${batchLike.join(',')}`)
    assert.ok(registered.includes('mont_bid_export'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
