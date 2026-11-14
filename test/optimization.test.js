/**
 * 组九：0.4.0 三项优化回归。
 *   ① 结构化检查报告 + 可确认清单
 *   ② 多标段字段与分标段目录
 *   ③ 任务进度落盘、查询、恢复
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseBidTender,
  extractLots,
  planOutline,
  preExportCheck,
  buildCheckReport,
} from '../lib/bid.js'
import { createTask, updateTask, listTasks, taskSummary, TASK_STATUS, TaskError } from '../lib/task.js'
import { createRuntime } from '../lib/runtime.js'

async function withRuntime(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-opt-'))
  const runtime = createRuntime({ root: dir, allowWrite: true })
  try { return await fn(runtime, dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
// ① 结构化检查报告
// ---------------------------------------------------------------------------

test('报告｜buildCheckReport 产出分级/证据/建议/确认字段', () => {
  const blockers = [
    { code: 'E_GATE2_NOT_APPROVED', message: '门2未批', severity: 'high', evidence: ['门2 PENDING'], suggestion: '人工签署' },
    { code: 'E_SELF_DUPLICATION', message: '与模板相似', severity: 'medium', evidence: ['tpl:0.92'], suggestion: '改写' },
  ]
  const r = buildCheckReport(blockers, new Set(['E_SELF_DUPLICATION']))
  assert.equal(r.total, 2)
  assert.equal(r.bySeverity.high, 1)
  assert.equal(r.bySeverity.medium, 1)
  assert.equal(r.acknowledgedCount, 1)
  assert.equal(r.blockingCount, 1, '已确认项不计入阻断')
  const dup = r.items.find(i => i.code === 'E_SELF_DUPLICATION')
  assert.equal(dup.acknowledged, true)
  assert.deepEqual(dup.evidence, ['tpl:0.92'])
  assert.ok(dup.suggestion.length > 0)
})

test('报告｜preExportCheck 返回 report 且 acknowledged 放行误报', () => {
  // 构造：事实全核验 + 门2/门3 已批准，但自我复制命中（误报），确认后应放行。
  const workflow = {
    gates: {
      gate1: { status: 'APPROVED' },
      gate2: { status: 'APPROVED' },
      gate3: { status: 'APPROVED' },
    },
  }
  const project = { facts: [] }
  const tplText = '本项目采用微服务架构实现统一认证。'
  const input = {
    project, workflow, text: tplText,
    templateSources: [{ id: 'tpl', text: tplText }],
    otherBidders: [],
  }
  const before = preExportCheck(input)
  assert.equal(before.canExport, false, '未确认前自我复制应阻断')
  assert.ok(before.report !== undefined, '须返回结构化报告')
  assert.ok(before.report.items.some(i => i.code === 'E_SELF_DUPLICATION'))

  const after = preExportCheck({ ...input, acknowledged: ['E_SELF_DUPLICATION'] })
  assert.equal(after.canExport, true, '确认误报后应放行')
  assert.equal(after.blockers.length, 0)
  assert.equal(after.report.acknowledgedCount, 1, '确认项仍保留在报告里')
  assert.equal(after.checks.acknowledgedCount, 1)
})

test('报告｜高severity门禁项不可被 acknowledged 静默绕过（未列入确认时仍阻断）', () => {
  const workflow = { gates: { gate2: { status: 'PENDING' }, gate3: { status: 'PENDING' } } }
  const r = preExportCheck({ project: { facts: [] }, workflow, text: 'x', acknowledged: ['E_SOMETHING_ELSE'] })
  assert.equal(r.canExport, false)
  assert.ok(r.blockers.some(b => b.code === 'E_GATE2_NOT_APPROVED'))
})

test('报告｜导出时报告落盘并写入审计链', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createProject({ name: '报告落盘', kind: 'bid' })
    const pid = created.project.id
    const exported = await runtime.bidExport({ projectId: pid })
    assert.equal(exported.exported, false, '门未批准时应被阻断')
    assert.ok(exported.report !== undefined)
    const project = await runtime.store.readProject(pid)
    assert.ok(project.exportCheck !== undefined, '报告应落盘')
    assert.equal(project.exportCheck.total, exported.report.total)
    const status = await runtime.projectStatus(pid)
    assert.ok(status.auditChain.activities >= 1, '检查动作应入审计链')
  })
})

test('报告｜mont_bid_check_report 可读取落盘报告', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createProject({ name: '读报告', kind: 'bid' })
    const pid = created.project.id
    const empty = await runtime.bidCheckReport(pid)
    assert.equal(empty.source, 'live', '未导出前应为即时空报告')
    await runtime.bidExport({ projectId: pid })
    const loaded = await runtime.bidCheckReport(pid)
    assert.equal(loaded.source, 'lastExportCheck')
    assert.ok(loaded.report.total > 0)
  })
})

// ---------------------------------------------------------------------------
// ② 多标段
// ---------------------------------------------------------------------------

test('标段｜显式枚举「标段一/标段二」抽出两个标段', () => {
  const text = '标段一：宜宾校区游泳馆运营\n标段二：自贡校区游泳馆运营\n本项目不接受联合体投标。'
  const lots = extractLots(text)
  assert.equal(lots.length, 2)
  assert.equal(lots[0].id, 'lot-1')
  assert.ok(lots[0].name.includes('游泳馆'))
})

test('标段｜「共分 3 个标段」生成占位名且标注未列明', () => {
  const lots = extractLots('本项目共分 3 个标段，投标人可投其中一个或多个。')
  assert.equal(lots.length, 3)
  assert.ok(lots[0].name.includes('未列明名称'))
})

test('标段｜无标段信息时返回空数组，不臆造', () => {
  assert.deepEqual(extractLots('本项目采购一批办公设备，预算 500 万元。'), [])
})

test('标段｜parseBidTender 覆盖 20 项且含 lots/lotCount', () => {
  const parsed = parseBidTender('项目名称：XX项目\n预算：500 万元\n本项目共分 2 个标段。')
  assert.match(parsed.coverage, /\/20$/u)
  assert.equal(parsed.lotCount, 2)
  assert.equal(parsed.fields.lots.value !== null, true)
  assert.equal(parsed.fields.stages.value, null, '未提及阶段时应为 null')
})

test('标段｜「第一阶段/第二阶段」抽出 stages 字段', () => {
  const parsed = parseBidTender('本项目采用多阶段投标，第一阶段提交技术建议书，第二阶段提交报价。')
  assert.ok(parsed.fields.stages.value !== null)
  assert.match(parsed.fields.stages.value, /阶段/u)
})

test('标段｜planOutline 按标段生成 byLot 分组目录', () => {
  const scores = [
    { item: '技术方案', score: 40, category: 'technical', level: 'child' },
    { item: '商务报价', score: 30, category: 'price', level: 'child' },
    { item: '服务方案', score: 30, category: 'technical', level: 'child' },
  ]
  const parsed = {
    scores, starClauses: [],
    lots: [{ id: 'lot-1', name: '标段一' }, { id: 'lot-2', name: '标段二' }],
  }
  const outline = planOutline(parsed, { targetWords: 30000 })
  assert.equal(outline.lotCount, 2)
  assert.equal(outline.byLot.length, 2)
  assert.equal(outline.byLot[0].chapters.length, 3)
  assert.equal(outline.byLot[0].chapters[0].id, 'lot-1-section-01', '分标段章节 id 应带标段前缀')
  assert.match(outline.notice, /2 个标段/u)
})

test('标段｜无 lots 时不产生 byLot', () => {
  const outline = planOutline({ scores: [{ item: '技术方案', score: 100, category: 'technical', level: 'child' }], starClauses: [] })
  assert.equal(outline.byLot, undefined)
})

// ---------------------------------------------------------------------------
// ③ 任务进度
// ---------------------------------------------------------------------------

test('任务｜创建→运行→完成 状态流转与进度', () => {
  const project = {}
  const t = createTask(project, { kind: 'section-writing', label: '逐节写作', total: 4 })
  assert.equal(t.status, TASK_STATUS.PENDING)
  assert.equal(t.done, 0)

  updateTask(project, t.id, { status: TASK_STATUS.RUNNING })
  updateTask(project, t.id, { increment: 2 })
  const mid = listTasks(project)[0]
  assert.equal(mid.status, TASK_STATUS.RUNNING)
  assert.equal(mid.done, 2)
  assert.equal(mid.progress, 50)

  updateTask(project, t.id, { status: TASK_STATUS.SUCCEEDED, done: 4 })
  const done = listTasks(project)[0]
  assert.equal(done.status, TASK_STATUS.SUCCEEDED)
  assert.ok(done.finishedAt !== null)
})

test('任务｜终态默认不可更新，force 可重启', () => {
  const project = {}
  const t = createTask(project, { kind: 'export', total: 1 })
  updateTask(project, t.id, { status: TASK_STATUS.FAILED })
  assert.throws(() => updateTask(project, t.id, { done: 1 }), e => e instanceof TaskError && e.code === 'E_TASK_TERMINAL')
  const restarted = updateTask(project, t.id, { status: TASK_STATUS.RUNNING, force: true })
  assert.equal(restarted.status, TASK_STATUS.RUNNING)
  assert.equal(restarted.finishedAt, null)
})

test('任务｜未知状态与缺 id 被拒', () => {
  const project = {}
  const t = createTask(project, { kind: 'x' })
  assert.throws(() => updateTask(project, t.id, { status: 'BOGUS' }), e => e instanceof TaskError)
  assert.throws(() => updateTask(project, 'nope', { done: 1 }), e => e.code === 'E_TASK_NOT_FOUND')
  assert.throws(() => createTask(project, { kind: '' }), e => e.code === 'E_TASK_KIND_REQUIRED')
})

test('任务｜汇总含按状态分布、总进度、可恢复清单', () => {
  const project = {}
  const a = createTask(project, { kind: 'outline', total: 2 })
  const b = createTask(project, { kind: 'outline', total: 2 })
  updateTask(project, a.id, { status: TASK_STATUS.RUNNING, done: 1 })
  updateTask(project, b.id, { status: TASK_STATUS.SUCCEEDED, done: 2 })
  const s = taskSummary(project)
  assert.equal(s.total, 2)
  assert.equal(s.byStatus.RUNNING, 1)
  assert.equal(s.byStatus.SUCCEEDED, 1)
  assert.equal(s.running, 1)
  assert.equal(s.unfinished, 1)
  assert.equal(s.doneUnits, 3)
  assert.equal(s.totalUnits, 4)
  assert.equal(s.overallPercent, 75)
  assert.deepEqual(s.resumable, [a.id], '非终态且已启动的任务可恢复')
})

test('任务｜按 kind / status 过滤', () => {
  const project = {}
  createTask(project, { kind: 'outline', total: 1 })
  const e = createTask(project, { kind: 'export', total: 1 })
  updateTask(project, e.id, { status: TASK_STATUS.RUNNING })
  assert.equal(listTasks(project, { kind: 'export' }).length, 1)
  assert.equal(listTasks(project, { status: TASK_STATUS.RUNNING }).length, 1)
})

// ---------------------------------------------------------------------------
// runtime 集成
// ---------------------------------------------------------------------------

test('集成｜任务工具创建/更新/列出/汇总并落盘', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createProject({ name: '任务集成', kind: 'bid' })
    const pid = created.project.id
    const t = await runtime.taskCreate(pid, { kind: 'section-writing', label: '写作', total: 3 })
    assert.equal(t.ok, true)
    const id = t.task.id

    await runtime.taskUpdate(pid, { id, status: 'RUNNING' })
    await runtime.taskUpdate(pid, { id, increment: 2 })
    const list = await runtime.taskList(pid, {})
    assert.equal(list.total, 1)
    assert.equal(list.tasks[0].progress, 66.7)

    const summary = await runtime.taskStatus(pid)
    assert.equal(summary.running, 1)
    assert.deepEqual(summary.resumable, [id])

    // 跨会话恢复：重新读项目，任务仍在。
    const project = await runtime.store.readProject(pid)
    assert.equal(project.tasks.length, 1)
    assert.equal(project.tasks[0].status, 'RUNNING')

    const status = await runtime.projectStatus(pid)
    assert.ok(status.auditChain.activities >= 3, '三次任务动作应入链')
    assert.equal(status.auditChain.valid, true)
  })
})

test('集成｜工具层注册 32 个工具（含 5 个新工具）', async () => {
  const registered = []
  const fakeCtx = { tools: { register(definition) { registered.push(definition.name); return () => {} } } }
  const { registerTools } = await import('../lib/tools.js')
  const dir = await mkdtemp(join(tmpdir(), 'mbc-opt-tools-'))
  try {
    registerTools(fakeCtx, createRuntime({ root: dir, allowWrite: true }))
    for (const name of [
      'mont_bid_check_report', 'mont_task_create', 'mont_task_update', 'mont_task_list', 'mont_task_status',
    ]) {
      assert.ok(registered.includes(name), `缺少工具 ${name}`)
    }
    assert.equal(registered.length, 32)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
