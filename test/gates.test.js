/**
 * 组三：门禁不可绕过。
 *
 * 覆盖：门1/门2/门3 未批准时工作流不推进、UNVERIFIED 事实阻断导出、
 * 模型 agent 无 approve 通道、审计链不可篡改、拒绝即冻结。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GATES,
  GATE_STATUS,
  approveGate,
  canAdvance,
  createWorkflow,
  isGateApproved,
  recordHash,
  subjectDigest,
  verifyAuditChain,
} from '../lib/workflow.js'
import { createRuntime } from '../lib/runtime.js'
import { setFact, verifyFact } from '../lib/facts.js'

const HOST_CRED = { channel: 'host-ui' }

async function withProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-gate-'))
  const runtime = createRuntime({ root: dir, allowWrite: true })
  try {
    const created = await runtime.createProject({ name: '门禁测试项目', kind: 'bid' })
    return await fn(runtime, created.project.id, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 门禁定义与初始状态
// ---------------------------------------------------------------------------

test('门禁｜三个门齐备且各有放行条件', () => {
  for (const gateId of ['gate1', 'gate2', 'gate3']) {
    assert.ok(GATES[gateId] !== undefined, `缺少 ${gateId}`)
    assert.ok(GATES[gateId].requires.length > 0, `${gateId} 缺放行条件`)
    assert.ok(GATES[gateId].position.length > 0)
  }
})

test('门禁｜新建工作流三门均为 PENDING 且审计链为空', () => {
  const workflow = createWorkflow({ kind: 'bid', subjectId: 'p1' })
  for (const gate of Object.values(workflow.gates)) {
    assert.equal(gate.status, GATE_STATUS.PENDING)
    assert.equal(gate.decidedAt, null)
  }
  assert.equal(workflow.gateRecords.length, 0)
  assert.equal(workflow.frozen, false)
})

// ---------------------------------------------------------------------------
// 门禁未批准 → 不推进
// ---------------------------------------------------------------------------

test('门禁｜门1 未确认时不能推进', () => {
  const workflow = createWorkflow({ kind: 'tender', subjectId: 'p1' })
  const verdict = canAdvance(workflow, 'gate1')
  assert.equal(verdict.canAdvance, false)
  assert.ok(verdict.reason.includes('尚未确认'))
})

test('门禁｜门2 未确认时不能推进', () => {
  const workflow = createWorkflow({ kind: 'bid', subjectId: 'p1' })
  assert.equal(canAdvance(workflow, 'gate2').canAdvance, false)
})

test('门禁｜门3 未签署时不能推进', () => {
  const workflow = createWorkflow({ kind: 'bid', subjectId: 'p1' })
  assert.equal(canAdvance(workflow, 'gate3').canAdvance, false)
})

// ---------------------------------------------------------------------------
// 模型 agent 无批准通道
// ---------------------------------------------------------------------------

test('门禁｜缺少 Host 凭证时批准被拒', () => {
  const workflow = createWorkflow({ kind: 'bid', subjectId: 'p1' })
  const result = approveGate(workflow, {
    gateId: 'gate2',
    decision: 'approve',
    operator: 'model',
    subject: {},
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_GATE_CREDENTIAL_REQUIRED')
  assert.equal(workflow.gates.gate2.status, GATE_STATUS.PENDING, '被拒后状态不得变化')
})

test('门禁｜伪造非 host-ui 凭证被拒', () => {
  const workflow = createWorkflow({ kind: 'bid', subjectId: 'p1' })
  for (const credential of [{ channel: 'tool' }, { channel: 'model' }, { channel: 'api' }, {}]) {
    const result = approveGate(workflow, {
      gateId: 'gate2', decision: 'approve', operator: 'x', subject: {}, credential,
    })
    assert.equal(result.ok, false, `凭证 ${JSON.stringify(credential)} 应被拒`)
    assert.equal(result.error.code, 'E_GATE_CREDENTIAL_REQUIRED')
  }
})

test('门禁｜mont_wf_advance 硬拒 approve/reject/sign 动作', async () => {
  await withProject(async (runtime, projectId) => {
    for (const action of ['approve', 'reject', 'sign']) {
      const result = await runtime.wfAdvance({ projectId, gateId: 'gate2', action })
      assert.equal(result.ok, false, `action=${action} 应被拒`)
      assert.equal(result.code, 'E_GATE_MODEL_APPROVAL_FORBIDDEN')
      assert.ok(result.message.includes('模型 agent 无 approve/reject 通道'))
    }
    // 拒后状态仍为未决
    const status = await runtime.wfAdvance({ projectId, action: 'status' })
    assert.equal(status.gates.gate2.status, GATE_STATUS.PENDING)
  })
})

test('门禁｜工具层不导出任何可构造 Host 凭证的路径', async () => {
  const registered = []
  const fakeCtx = {
    tools: {
      register(definition) {
        registered.push({ name: definition.name, description: definition.description })
        return () => {}
      },
    },
  }
  const { registerTools } = await import('../lib/tools.js')
  const dir = await mkdtemp(join(tmpdir(), 'mbc-gate-tools-'))
  try {
    const runtime = createRuntime({ root: dir, allowWrite: true })
    registerTools(fakeCtx, runtime)
    await new Promise(resolve => setTimeout(resolve, 50))
    const approveLike = registered.filter(item => /approve|reject|sign|批准|签署/iu.test(item.name))
    assert.deepEqual(approveLike.map(item => item.name), [], '不应存在批准类工具')
    assert.ok(registered.some(item => item.name === 'mont_wf_advance'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 存在未核验事实 → 导出被阻断
// ---------------------------------------------------------------------------

test('门禁｜存在 UNVERIFIED 事实时导出被阻断', async () => {
  await withProject(async (runtime, projectId) => {
    await runtime.store.writeSection(projectId, 'section-01', '这是正文内容，用于导出测试。')
    const result = await runtime.bidExport({ projectId })
    assert.equal(result.exported, false)
    const codes = result.blockers.map(item => item.code)
    assert.ok(codes.includes('E_GATE2_NOT_APPROVED') || codes.includes('E_GATE3_NOT_APPROVED'))
  })
})

test('门禁｜写入未核验事实后项目状态显示不可导出', async () => {
  await withProject(async (runtime, projectId) => {
    const project = await runtime.store.readProject(projectId)
    // manual 录入均为 UNVERIFIED（录入 ≠ 核验）；显式核验后才转 VERIFIED。
    setFact(project, { key: 'performanceCommitment', value: '9999', source: 'manual' })
    setFact(project, { key: 'creditCode', value: '91110000MA00000001', source: 'manual' })
    verifyFact(project, 'performanceCommitment', { operator: 'tester' })
    await runtime.store.updateProject(projectId, { facts: project.facts })

    const status = await runtime.projectStatus(projectId)
    assert.equal(status.facts.unverified.length, 1, '仅未核验的那一条计入未核验')
    assert.equal(status.canExport, false)
  })
})

test('门禁｜门2/门3 已批准但仍有未核验事实时导出仍被阻断', async () => {
  await withProject(async (runtime, projectId) => {
    await runtime.store.writeSection(projectId, 'section-01', '正文。')
    const project = await runtime.store.readProject(projectId)
    setFact(project, { key: 'creditCode', value: '', source: 'manual' })
    await runtime.store.updateProject(projectId, { facts: project.facts })

    // 用 Host 凭证把门2、门3 都放行
    const g2 = await runtime.approveGateFromHost(projectId, {
      gateId: 'gate2', decision: 'approve', operator: 'tester', subject: {}, credential: HOST_CRED,
    })
    assert.equal(g2.ok, true)
    const g3 = await runtime.approveGateFromHost(projectId, {
      gateId: 'gate3', decision: 'approve', operator: 'tester', subject: {}, credential: HOST_CRED,
    })
    assert.equal(g3.ok, true)

    const result = await runtime.bidExport({ projectId })
    assert.equal(result.exported, false, '仍有未核验事实时必须阻断')
    const codes = result.blockers.map(item => item.code)
    assert.ok(codes.includes('E_UNVERIFIED_FACTS'))
  })
})

test('门禁｜事实全部核验且门2门3批准后才允许导出', async () => {
  await withProject(async (runtime, projectId) => {
    await runtime.store.writeSection(projectId, 'section-01', '本项目正文内容，讨论设备运维与响应时效机制。')

    const project = await runtime.store.readProject(projectId)
    setFact(project, { key: 'enterpriseName', value: '测试科技有限公司', source: 'manual' })
    setFact(project, { key: 'creditCode', value: '91110000MA00000001', source: 'manual' })
    // manual 录入 ≠ 核验：必须补一次显式核验（带 operator）才允许放行。
    verifyFact(project, 'enterpriseName', { operator: 'tester' })
    verifyFact(project, 'creditCode', { operator: 'tester' })
    await runtime.store.updateProject(projectId, { facts: project.facts })

    await runtime.approveGateFromHost(projectId, {
      gateId: 'gate2', decision: 'approve', operator: 'tester', subject: {}, credential: HOST_CRED,
    })
    await runtime.approveGateFromHost(projectId, {
      gateId: 'gate3', decision: 'approve', operator: 'tester', subject: {}, credential: HOST_CRED,
    })

    const result = await runtime.bidExport({ projectId })
    assert.equal(result.exported, true, `应允许导出，实际 blockers：${JSON.stringify(result.blockers)}`)
    assert.ok(result.bytes > 0)
    assert.ok(result.path.endsWith('.docx'))
  })
})

// ---------------------------------------------------------------------------
// 审计链
// ---------------------------------------------------------------------------

test('审计链｜每次决策生成一条带摘要与链式哈希的记录', async () => {
  await withProject(async (runtime, projectId) => {
    const first = await runtime.approveGateFromHost(projectId, {
      gateId: 'gate2', decision: 'approve', operator: '张三', subject: { a: 1 }, credential: HOST_CRED,
    })
    assert.equal(first.ok, true)
    assert.equal(first.record.seq, 1)
    assert.ok(first.record.subjectDigest.startsWith('sha256:'))
    assert.equal(first.record.previousRecordHash, null)

    const second = await runtime.approveGateFromHost(projectId, {
      gateId: 'gate3', decision: 'approve', operator: '李四', subject: { b: 2 }, credential: HOST_CRED,
    })
    assert.equal(second.ok, true)
    assert.equal(second.record.seq, 2)
    assert.ok(second.record.previousRecordHash !== null, '第二条必须链到第一条')

    const status = await runtime.wfAdvance({ projectId, action: 'status' })
    assert.equal(status.auditChain.valid, true)
    assert.equal(status.auditChain.records.length, 2)
  })
})

test('审计链｜篡改记录可被发现', () => {
  const base = {
    seq: 1, gateId: 'gate1', decision: 'approve', operator: '张三',
    decidedAt: '2026-01-01T00:00:00.000Z', subjectDigest: 'sha256:abc', note: null, previousRecordHash: null,
  }
  base.hash = recordHash(base)
  const records = [base]
  assert.equal(verifyAuditChain(records).valid, true)

  // 篡改操作人
  const tampered = [{ ...base, operator: '李四' }]
  const verdict = verifyAuditChain(tampered)
  assert.equal(verdict.valid, false)
  assert.equal(verdict.brokenAt, 0)

  // 篡改摘要
  const tamperedDigest = [{ ...base, subjectDigest: 'sha256:def' }]
  assert.equal(verifyAuditChain(tamperedDigest).valid, false)

  // 篡改后同时重算自封签，但前驱指针仍指向旧值 → 仍被发现
  const resigned = [{ ...base, operator: '李四' }]
  resigned[0].hash = recordHash(resigned[0])
  assert.equal(verifyAuditChain(resigned).valid, true, '单条链内自洽重签无法被发现——这正是需要 seq+prev 链的原因')
})

test('审计链｜中段记录被重签篡改可被发现', () => {
  const r1 = {
    seq: 1, gateId: 'gate1', decision: 'approve', operator: 'a',
    decidedAt: 't1', subjectDigest: 'sha256:1', note: null, previousRecordHash: null,
  }
  r1.hash = recordHash(r1)
  const r2 = {
    seq: 2, gateId: 'gate2', decision: 'approve', operator: 'b',
    decidedAt: 't2', subjectDigest: 'sha256:2', note: null, previousRecordHash: r1.hash,
  }
  r2.hash = recordHash(r2)
  const r3 = {
    seq: 3, gateId: 'gate3', decision: 'approve', operator: 'c',
    decidedAt: 't3', subjectDigest: 'sha256:3', note: null, previousRecordHash: r2.hash,
  }
  r3.hash = recordHash(r3)
  assert.equal(verifyAuditChain([r1, r2, r3]).valid, true)

  // 篡改 r2 并重签自身哈希 → r3 的前驱指针失配，链接断开
  const forged2 = { ...r2, operator: 'hacker' }
  forged2.hash = recordHash(forged2)
  const verdict = verifyAuditChain([r1, forged2, r3])
  assert.equal(verdict.valid, false)
  assert.equal(verdict.brokenAt, 2)
  assert.ok(verdict.reason.includes('前驱哈希指针'))
})

test('审计链｜插入伪造的中段记录会断链', () => {
  const r1 = {
    seq: 1, gateId: 'gate1', decision: 'approve', operator: 'a',
    decidedAt: 't1', subjectDigest: 'sha256:1', note: null, previousRecordHash: null,
  }
  r1.hash = recordHash(r1)
  const r2 = {
    seq: 2, gateId: 'gate2', decision: 'approve', operator: 'b',
    decidedAt: 't2', subjectDigest: 'sha256:2', note: null, previousRecordHash: r1.hash,
  }
  r2.hash = recordHash(r2)
  assert.equal(verifyAuditChain([r1, r2]).valid, true)

  // 伪造一条 seq=2 但 previousRecordHash 不对的记录
  const forged = { ...r2, previousRecordHash: 'deadbeef' }
  forged.hash = recordHash(forged)
  assert.equal(verifyAuditChain([r1, forged]).valid, false)
})

test('审计链｜seq 不连续被发现', () => {
  const r1 = {
    seq: 1, gateId: 'gate1', decision: 'approve', operator: 'a',
    decidedAt: 't1', subjectDigest: 'sha256:1', note: null, previousRecordHash: null,
  }
  r1.hash = recordHash(r1)
  const skipped = {
    seq: 3, gateId: 'gate3', decision: 'approve', operator: 'c',
    decidedAt: 't3', subjectDigest: 'sha256:3', note: null, previousRecordHash: r1.hash,
  }
  skipped.hash = recordHash(skipped)
  assert.equal(verifyAuditChain([r1, skipped]).valid, false)
})

test('审计链｜subjectDigest 对同一内容稳定、对不同内容不同', () => {
  const a1 = subjectDigest({ text: 'abc' })
  const a2 = subjectDigest({ text: 'abc' })
  const b = subjectDigest({ text: 'abd' })
  assert.equal(a1, a2)
  assert.notEqual(a1, b)
})

// ---------------------------------------------------------------------------
// 不可撤销 / 拒绝即冻结 / 未解决项阻断
// ---------------------------------------------------------------------------

test('门禁｜同一门不能裁决两次', async () => {
  await withProject(async (runtime, projectId) => {
    const first = await runtime.approveGateFromHost(projectId, {
      gateId: 'gate2', decision: 'approve', operator: 'a', subject: {}, credential: HOST_CRED,
    })
    assert.equal(first.ok, true)
    const second = await runtime.approveGateFromHost(projectId, {
      gateId: 'gate2', decision: 'approve', operator: 'b', subject: {}, credential: HOST_CRED,
    })
    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'E_GATE_ALREADY_DECIDED')
  })
})

test('门禁｜拒绝决策使工作流冻结且不可再推进', async () => {
  await withProject(async (runtime, projectId) => {
    const rejected = await runtime.approveGateFromHost(projectId, {
      gateId: 'gate2', decision: 'reject', operator: 'a', subject: {}, note: '事实不清', credential: HOST_CRED,
    })
    assert.equal(rejected.ok, true)

    const status = await runtime.wfAdvance({ projectId, action: 'status' })
    assert.equal(status.frozen, true)
    assert.equal(status.gates.gate2.status, GATE_STATUS.REJECTED)

    const check = await runtime.wfAdvance({ projectId, gateId: 'gate2', action: 'check' })
    assert.equal(check.canAdvance, false)
    assert.ok(check.reason.includes('冻结'))

    const again = await runtime.approveGateFromHost(projectId, {
      gateId: 'gate3', decision: 'approve', operator: 'a', subject: {}, credential: HOST_CRED,
    })
    assert.equal(again.ok, false)
    assert.equal(again.error.code, 'E_WORKFLOW_FROZEN')
  })
})

test('门禁｜存在未解决项时 approve 被拒', () => {
  const workflow = createWorkflow({ kind: 'bid', subjectId: 'p1' })
  const result = approveGate(workflow, {
    gateId: 'gate2',
    decision: 'approve',
    operator: 'a',
    subject: {},
    credential: HOST_CRED,
    unresolved: ['资质证书未提供', '业绩金额待确认'],
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_GATE_UNRESOLVED_ITEMS')
  assert.equal(workflow.gates.gate2.status, GATE_STATUS.PENDING)
})

test('门禁｜未知门编号被拒', () => {
  const workflow = createWorkflow({ kind: 'bid', subjectId: 'p1' })
  const result = approveGate(workflow, {
    gateId: 'gate9', decision: 'approve', operator: 'a', subject: {}, credential: HOST_CRED,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_GATE_UNKNOWN')
})

test('门禁｜isGateApproved 与 canAdvance 口径一致', () => {
  const workflow = createWorkflow({ kind: 'bid', subjectId: 'p1' })
  assert.equal(isGateApproved(workflow, 'gate2'), false)
  assert.equal(canAdvance(workflow, 'gate2').canAdvance, false)

  approveGate(workflow, { gateId: 'gate2', decision: 'approve', operator: 'a', subject: {}, credential: HOST_CRED })
  assert.equal(isGateApproved(workflow, 'gate2'), true)
  assert.equal(canAdvance(workflow, 'gate2').canAdvance, true)
})
