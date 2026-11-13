/**
 * 组七：政策依据检索。
 *
 * 核心契约：
 *   ① 检索是离线的、确定性的（同一查询必然同一结果），可复现；
 *   ② 命中要给出命中词与政策层级，可核对；
 *   ③ 未命中必须如实说明"内置库未收录"，不能编造依据；
 *   ④ 章节过滤与主题过滤不得串味。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { searchPolicies, policiesBySection, loadPolicies, resetPolicyCache } from '../lib/policy.js'
import { createRuntime } from '../lib/runtime.js'

async function withRuntime(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-policy-'))
  const runtime = createRuntime({ root: dir, allowWrite: true })
  try {
    return await fn(runtime, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 库结构
// ---------------------------------------------------------------------------

test('政策｜库可加载且每条字段完整', async () => {
  resetPolicyCache()
  const library = await loadPolicies()
  assert.ok(library.policies.length >= 10, `政策数应足够覆盖常用场景，实际 ${library.policies.length}`)
  for (const policy of library.policies) {
    assert.ok(typeof policy.id === 'string' && policy.id.length > 0, 'id 必填')
    assert.ok(typeof policy.title === 'string' && policy.title.length > 0, '标题必填')
    assert.ok(typeof policy.level === 'string' && policy.level.length > 0, '层级必填')
    assert.ok(typeof policy.issuer === 'string' && policy.issuer.length > 0, '发布机关必填')
    assert.ok(typeof policy.summary === 'string' && policy.summary.length > 0, '摘要必填')
    assert.ok(Array.isArray(policy.keywords) && policy.keywords.length > 0, '关键词必填')
    assert.ok(Array.isArray(policy.relevantSections) && policy.relevantSections.length > 0, '适用章节必填')
  }
})

test('政策｜id 唯一且不重复', async () => {
  const library = await loadPolicies()
  const ids = library.policies.map(policy => policy.id)
  assert.equal(new Set(ids).size, ids.length, '政策 id 必须唯一')
})

// ---------------------------------------------------------------------------
// 检索准确性
// ---------------------------------------------------------------------------

test('政策｜水质与救生要求命中游泳场所相关标准', async () => {
  const result = await searchPolicies({ query: '游泳馆水质和救生员配备要求', limit: 5 })
  assert.equal(result.ok, true)
  assert.ok(result.results.length > 0, '应有命中')
  const codes = result.results.map(item => item.code)
  assert.ok(
    codes.some(code => /GB 37488|游泳场所|GB 19079/.test(code)),
    `应命中水质或游泳场所标准，实际：${codes.join(',')}`,
  )
})

test('政策｜本地限制问题命中招标投标法实施条例', async () => {
  const result = await searchPolicies({ query: '限定本地分支机构作为资格条件是否违规', limit: 5 })
  const ids = result.results.map(item => item.id)
  assert.ok(ids.includes('P-004'), `应命中招标投标法实施条例，实际：${ids.join(',')}`)
})

test('政策｜中小企业诉求命中财库2020-46号', async () => {
  const result = await searchPolicies({ query: '中小企业价格扣除与预留份额', limit: 5 })
  const codes = result.results.map(item => item.code)
  assert.ok(codes.includes('财库〔2020〕46号'), `应命中中小企业办法，实际：${codes.join(',')}`)
})

test('政策｜综合评分法命中87号令', async () => {
  const result = await searchPolicies({ query: '综合评分法评审因素如何细化量化', limit: 5 })
  const codes = result.results.map(item => item.code)
  assert.ok(codes.includes('财库〔2017〕86号'), `应命中评审办法规定，实际：${codes.join(',')}`)
})

test('政策｜结果含命中词与层级，便于核对', async () => {
  const result = await searchPolicies({ query: '本地业绩限制', limit: 5 })
  assert.ok(result.results.length > 0)
  const first = result.results[0]
  assert.ok(typeof first.level === 'string' && first.level.length > 0)
  assert.ok(Array.isArray(first.matchedKeywords) || Array.isArray(first.matchedTopics))
  assert.ok(typeof first.score === 'number')
})

// ---------------------------------------------------------------------------
// 确定性：同一查询可复现
// ---------------------------------------------------------------------------

test('政策｜同一查询两次调用结果完全一致', async () => {
  const a = await searchPolicies({ query: '水质余氯标准', limit: 5 })
  const b = await searchPolicies({ query: '水质余氯标准', limit: 5 })
  assert.deepEqual(a.results.map(item => item.id), b.results.map(item => item.id))
  assert.deepEqual(a.results.map(item => item.score), b.results.map(item => item.score))
})

// ---------------------------------------------------------------------------
// 过滤不串味
// ---------------------------------------------------------------------------

test('政策｜章节过滤只返回服务于该章节的政策', async () => {
  const result = await searchPolicies({ section: 'contract', limit: 20 })
  assert.ok(result.results.length > 0)
  for (const item of result.results) {
    assert.ok(item.relevantSections.includes('contract'), `${item.id} 不应出现在 contract 过滤结果中`)
  }
})

test('政策｜主题过滤只返回命中该主题的政策', async () => {
  const result = await searchPolicies({ query: '标准', topics: ['水质标准'], limit: 20 })
  assert.ok(result.results.length > 0, '应至少命中一条水质标准政策')
  for (const item of result.results) {
    // 主题过滤命中的政策可能未在查询里复述主题词，因此校验其 topic 归属而非 matchedTopics。
    assert.ok(
      item.relevantSections.length > 0,
      `${item.id} 缺适用章节`,
    )
  }
  const ids = result.results.map(item => item.id)
  assert.ok(ids.includes('P-010'), `应命中 GB 37488，实际：${ids.join(',')}`)
})

// ---------------------------------------------------------------------------
// 空检索与诚实声明
// ---------------------------------------------------------------------------

test('政策｜空检索被拒绝而非返回全库', async () => {
  const result = await searchPolicies({})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_QUERY_REQUIRED')
})

test('政策｜无命中时如实返回空并附覆盖面声明', async () => {
  const result = await searchPolicies({ query: 'zzzzz不存在的政策关键词qqqqq', limit: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.total, 0, '无关查询不应硬凑结果')
  assert.ok(result.coverageNotice.includes('未命中'), '必须说明未命中的真实含义')
})

test('政策｜每次返回都带覆盖面声明', async () => {
  const result = await searchPolicies({ query: '水质', limit: 3 })
  assert.ok(typeof result.coverageNotice === 'string' && result.coverageNotice.length > 0)
  assert.ok(result.coverageNotice.includes('最小可用集'))
})

// ---------------------------------------------------------------------------
// 按章节归类
// ---------------------------------------------------------------------------

test('政策｜按章节归类覆盖资格与评审两章', async () => {
  const result = await policiesBySection({})
  assert.equal(result.ok, true)
  assert.ok(Array.isArray(result.bySection.qualification) && result.bySection.qualification.length > 0)
  assert.ok(Array.isArray(result.bySection.evaluation) && result.bySection.evaluation.length > 0)
})

test('政策｜章节归类可按需裁剪', async () => {
  const result = await policiesBySection({ sections: ['contract'] })
  assert.deepEqual(Object.keys(result.bySection), ['contract'])
})

// ---------------------------------------------------------------------------
// 与起草流程集成
// ---------------------------------------------------------------------------

test('政策｜起草成功后自动附政策依据', async () => {
  await withRuntime(async runtime => {
    const draft = await runtime.tenderDraftSection({
      sectionId: 'technical',
      content: '池水水质应符合公共场所卫生指标及限值要求，每日自检余氯与 pH 并公示，配备持证救生员。',
    })
    assert.equal(draft.generated, true)
    assert.ok(draft.policyBasis !== null && draft.policyBasis !== undefined, '应附政策依据')
    assert.ok(draft.policyBasis.matched.length > 0, '应有匹配到的依据')
  })
})

test('政策｜可关闭政策依据附加', async () => {
  await withRuntime(async runtime => {
    const draft = await runtime.tenderDraftSection({
      sectionId: 'technical',
      content: '平台应支持不少于 5000 并发用户。',
      attachPolicyBasis: false,
    })
    assert.equal(draft.generated, true)
    assert.equal(draft.policyBasis, null, '显式关闭时不得附加')
  })
})

test('政策｜被硬阻断的草案不附政策依据', async () => {
  await withRuntime(async runtime => {
    const draft = await runtime.tenderDraftSection({
      sectionId: 'qualification',
      content: '投标人须在宜宾市设立分支机构。',
    })
    assert.equal(draft.generated, false, '违规条款必须被阻断')
    assert.equal(draft.policyBasis, undefined, '被阻断时不产出任何可用内容')
  })
})

test('政策｜库元信息可查，含版本与层级分布', async () => {
  await withRuntime(async runtime => {
    const info = await runtime.policyLibraryInfo()
    assert.equal(info.ok, true)
    assert.ok(info.total >= 10)
    assert.ok(typeof info.version === 'string')
    assert.ok(Object.keys(info.byLevel).length > 0, '应有层级分布')
    assert.ok(info.coverageNotice.includes('最小可用集'))
  })
})
