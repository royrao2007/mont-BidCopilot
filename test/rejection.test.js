/**
 * 组八：废标项 / 响应完整性检查。
 *
 * 覆盖：概念分离（无效投标 vs 废标项）、原文证据保留、不臆造、
 * 响应匹配、未响应分级、acknowledge 确认、经验补充显式开关、确定性、
 * 与 runtime 集成（落盘 + 审计链）、规则元信息。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHECKPOINTS,
  extractRejectionClauses,
  findResponse,
  checkRejectionResponse,
  describeRejectionRules,
} from '../lib/rejection.js'
import { createRuntime } from '../lib/runtime.js'

async function withRuntime(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-rejection-'))
  const runtime = createRuntime({ root: dir, allowWrite: true })
  try {
    return await fn(runtime, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const TENDER = `# 招标文件（节选）

四、投标文件的递交
1. 投标文件未按要求密封的，将被否决投标。
2. 逾期送达的投标文件，采购人不予受理。
3. 投标报价超过最高限价的，其投标无效。

五、废标情形
4. 有效投标人不足三家的，本项目应当重新招标。
5. 出现重大偏差或实质性偏离的，按无效响应处理。

六、其他
6. 投标文件应逐页编制页码。
`

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

test('废标｜规则表含两类概念与三级严重度', () => {
  const types = new Set(CHECKPOINTS.map(p => p.type))
  const severities = new Set(CHECKPOINTS.map(p => p.severity))
  assert.ok(types.has('invalidBid'))
  assert.ok(types.has('rejection'))
  assert.ok(severities.has('high'))
  assert.ok(severities.has('medium'))
  for (const p of CHECKPOINTS) {
    assert.ok(Array.isArray(p.keywords) && p.keywords.length > 0, `${p.id} 缺关键词`)
    assert.ok(p.label.length > 0)
  }
})

test('废标｜规则元信息可用且声明确定性', async () => {
  await withRuntime(async runtime => {
    const r = await runtime.bidRejectionRules()
    assert.equal(r.ok, true)
    assert.equal(r.checkpointCount, CHECKPOINTS.length)
    assert.equal(r.byType.invalidBid + r.byType.rejection, r.checkpointCount)
    assert.match(r.determinism, /纯规则匹配/u)
  })
})

// ---------------------------------------------------------------------------
// 原文抽取
// ---------------------------------------------------------------------------

test('废标｜抽取保留原句证据且区分两类', () => {
  const clauses = extractRejectionClauses(TENDER)
  assert.ok(clauses.length > 0)
  for (const c of clauses) {
    assert.ok(c.evidence.length > 0, '须保留原句证据')
    assert.ok(c.matchedKeywords.length > 0)
    assert.ok(c.source === 'explicit')
  }
  const types = new Set(clauses.map(c => c.type))
  assert.ok(types.has('invalidBid'), '应抽出无效投标类')
  assert.ok(types.has('rejection'), '应抽出废标项类')
})

test('废标｜中性说明不误判为废标条款', () => {
  // 「请加盖公章」是操作说明，不带否决/无效结论词，不能当废标条款。
  const clauses = extractRejectionClauses('请投标人在投标文件每页加盖公章，并逐页编制页码。')
  const seal = clauses.find(c => c.id === 'seal')
  assert.equal(seal, undefined, '中性说明不得误判为废标项')
})

test('废标｜原文未提及时不臆造（空输入返回空）', () => {
  assert.deepEqual(extractRejectionClauses(''), [])
  assert.deepEqual(extractRejectionClauses('本项目采购一批办公设备。'), [])
})

test('废标｜同义表达归并到同一要点', () => {
  const clauses = extractRejectionClauses('投标文件存在重大偏差的，将被否决投标。')
  const sub = clauses.find(c => c.id === 'substantive')
  assert.ok(sub !== undefined, '「重大偏差/否决投标」应归到实质性响应要点')
})

test('废标｜抽取工具返回两类计数', async () => {
  await withRuntime(async runtime => {
    const r = await runtime.bidRejectionExtract({ text: TENDER })
    assert.equal(r.ok, true)
    assert.ok(r.total > 0)
    assert.equal(r.total, r.invalidBid + r.rejection)
    assert.match(r.notice, /未出现的不臆造/u)
  })
})

// ---------------------------------------------------------------------------
// 响应匹配
// ---------------------------------------------------------------------------

test('废标｜章节命中关键词即算已响应，并给出命中词', () => {
  const point = CHECKPOINTS.find(p => p.id === 'seal')
  const r = findResponse(point, [
    { sectionId: 'section-02', content: '本投标文件已按要求密封并加盖骑缝章。' },
  ])
  assert.equal(r.responded, true)
  assert.equal(r.sectionId, 'section-02')
  assert.ok(point.keywords.includes(r.matchedBy))
})

test('废标｜无章节响应时返回未响应', () => {
  const point = CHECKPOINTS.find(p => p.id === 'bidBond')
  const r = findResponse(point, [{ sectionId: 's1', content: '本项目技术方案采用三层架构。' }])
  assert.equal(r.responded, false)
  assert.equal(r.sectionId, null)
})

// ---------------------------------------------------------------------------
// 完整检查
// ---------------------------------------------------------------------------

test('废标｜完整检查输出未响应项与分级统计', () => {
  const sections = [
    { sectionId: 's1', content: '本投标文件已按要求密封、签字盖章，并在投标截止时间前递交。' },
  ]
  const r = checkRejectionResponse({ tenderText: TENDER, sections })
  assert.equal(r.ok, true)
  assert.ok(r.items.length > 0)
  assert.ok(r.unresponded.length > 0, '保证金/资格等要点应未响应')
  assert.equal(r.summary.clauseCount, r.items.length)
  assert.equal(r.summary.respondedCount + r.summary.unrespondedCount, r.items.length)
  assert.equal(
    r.unrespondedBySeverity.high + r.unrespondedBySeverity.medium + r.unrespondedBySeverity.low,
    r.unresponded.length,
  )
})

test('废标｜blocked 仅在存在未响应 high 级要点时为 true', () => {
  const none = checkRejectionResponse({
    clauses: [{ id: 'format', type: 'invalidBid', severity: 'low', evidence: 'x', matchedKeywords: [] }],
    sections: [],
  })
  // low 未响应不应置 blocked
  assert.equal(none.blocked, false)

  const high = checkRejectionResponse({
    clauses: [{ id: 'seal', type: 'invalidBid', severity: 'high', evidence: 'x', matchedKeywords: [] }],
    sections: [],
  })
  assert.equal(high.blocked, true)
})

test('废标｜acknowledge 确认后不计入未响应', () => {
  const r = checkRejectionResponse({ tenderText: TENDER, sections: [], acknowledge: ['seal', 'deadline'] })
  const ack = r.items.filter(i => i.acknowledged)
  assert.equal(ack.length, 2)
  assert.equal(ack.every(i => !i.unresponded), true, '已确认项不得计入未响应')
})

test('废标｜经验补充默认不输出，显式开启才给且标为 inferred', () => {
  const off = checkRejectionResponse({ tenderText: TENDER, sections: [] })
  assert.equal(off.inferred, undefined, '默认不含经验补充')

  const on = checkRejectionResponse({ tenderText: TENDER, sections: [], includeInferred: true })
  assert.ok(Array.isArray(on.inferred))
  for (const item of on.inferred) {
    assert.equal(item.source, 'inferred')
    assert.match(item.note, /经验补充，非招标文件原文/u)
  }
})

test('废标｜确定性：同一输入两次结果完全一致', () => {
  const input = { tenderText: TENDER, sections: [{ sectionId: 's1', content: '已密封盖章' }] }
  const a = checkRejectionResponse(input)
  const b = checkRejectionResponse(input)
  assert.deepEqual(a, b)
})

test('废标｜结果附诚实声明', () => {
  const r = checkRejectionResponse({ tenderText: TENDER, sections: [] })
  assert.match(r.notice, /辅助复核/u)
  assert.match(r.notice, /确定性规则/u)
})

// ---------------------------------------------------------------------------
// runtime 集成
// ---------------------------------------------------------------------------

test('废标｜projectId 模式自动读取章节并落盘结果', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createProject({ name: '废标测试', kind: 'bid' })
    const pid = created.project.id
    await runtime.bidWriteSection({ projectId: pid, sectionId: 's1', content: '已密封盖章并附授权委托书。' })
    await runtime.bidParse({ projectId: pid, text: TENDER })

    const r = await runtime.bidRejectionCheck({ projectId: pid })
    assert.equal(r.ok, true)
    assert.ok(r.summary.sectionCount >= 1)
    assert.ok(r.items.length > 0)

    const project = await runtime.store.readProject(pid)
    assert.ok(project.rejectionCheck !== undefined, '结果应落盘')
    assert.equal(project.rejectionCheck.summary.clauseCount, r.summary.clauseCount)
  })
})

test('废标｜检查动作写入审计链且链有效', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createProject({ name: '废标审计', kind: 'bid' })
    const pid = created.project.id
    await runtime.bidWriteSection({ projectId: pid, sectionId: 's1', content: '正文。' })
    await runtime.bidRejectionCheck({ projectId: pid, tenderText: TENDER })
    const status = await runtime.projectStatus(pid)
    assert.ok(status.auditChain.activities >= 2, `应有写章节+检查两条活动，实际 ${status.auditChain.activities}`)
    assert.equal(status.auditChain.valid, true)
  })
})

test('废标｜工具层注册了 3 个废标工具', async () => {
  const registered = []
  const fakeCtx = {
    tools: {
      register(definition) { registered.push(definition.name); return () => {} },
    },
  }
  const { registerTools } = await import('../lib/tools.js')
  const dir = await mkdtemp(join(tmpdir(), 'mbc-rej-tools-'))
  try {
    registerTools(fakeCtx, createRuntime({ root: dir, allowWrite: true }))
    for (const name of ['mont_bid_rejection_check', 'mont_bid_rejection_extract', 'mont_bid_rejection_rules']) {
      assert.ok(registered.includes(name), `缺少工具 ${name}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
