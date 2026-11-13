/**
 * 门禁状态机：门禁即控制流，带不可变审计链。
 *
 * 与原方案 §5.1 的关键差异（修正）：
 *   `WorkflowState` 原设计只有 `gates: GateStatus[]` 与 `approvedBy?: string`，
 *   这只存"最后谁签的"，无法满足"每次审批可追溯"。本实现改为 gateRecords[]：
 *   每条记录含 门号 / 决策 / 操作人 / 时间戳 / 被审对象哈希 / 结论 / 序列号，
 *   并且写入后不可修改（append-only），关闭即冻结。
 *
 * 防绕过：approve/reject 只存在于本模块导出的 approveGate()，该函数依赖一个
 * 只在 Host 侧持有的批准凭证对象；tools.js 不导出任何能构造它的路径。
 *
 * @module lib/workflow
 */

import { createHash } from 'node:crypto'

/** 三门定义：位置与放行条件。 */
export const GATES = Object.freeze({
  gate1: {
    id: 'gate1',
    title: '门1 招标侧资格/评审确认',
    position: '资格条件和评审办法生成后',
    requires: ['硬阻断项已修正', '招标人逐条确认复核项'],
  },
  gate2: {
    id: 'gate2',
    title: '门2 投标侧事实/引用核验',
    position: 'mont_bid_export 执行前',
    requires: ['所有 UNVERIFIED 事实字段已确认', '所有 L2/L3 引用已核验来源'],
  },
  gate3: {
    id: 'gate3',
    title: '门3 最终合规审查签署',
    position: '导出最终文件前',
    requires: ['合规审查报告无阻断项', '操作人签署'],
  },
})

/** 门禁的三种状态。pending 为未决，approved/rejected 为已决且不可再改。 */
export const GATE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
})

/**
 * 创建一个全新的工作流状态。
 * @param {{kind: 'tender'|'bid', subjectId: string}} input
 * @returns {object}
 */
export function createWorkflow({ kind, subjectId }) {
  return {
    kind,
    subjectId,
    createdAt: new Date().toISOString(),
    gates: {
      gate1: pendingGate('gate1'),
      gate2: pendingGate('gate2'),
      gate3: pendingGate('gate3'),
    },
    gateRecords: [],
    frozen: false,
  }
}

function pendingGate(id) {
  return {
    id,
    title: GATES[id].title,
    status: GATE_STATUS.PENDING,
    decidedAt: null,
    decidedBy: null,
  }
}

/**
 * 计算被审对象的稳定哈希，用于审计链证明"签字时看到的就是这份内容"。
 * @param {unknown} payload
 * @returns {string}
 */
export function subjectDigest(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null)
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

/**
 * 生成一次门禁决策。**这是唯一的决策入口**。
 *
 * 调用方必须传入 `credential`——一个由 Host 侧 UI 通道创建并持有的对象。
 * 该对象不通过任何工具参数暴露，因此模型 agent 无法构造。
 *
 * @param {object} workflow - 工作流状态（就地更新）。
 * @param {object} input
 * @param {string} input.gateId - gate1/gate2/gate3。
 * @param {'approve'|'reject'} input.decision
 * @param {string} input.operator - 操作人标识（来自 UI 通道，不来自模型）。
 * @param {unknown} input.subject - 被审对象，用于计算 digest。
 * @param {string} [input.note]
 * @param {object} input.credential - Host 侧批准凭证；缺失即拒绝。
 * @param {string[]} [input.unresolved] - 未解决项清单；非空时 approve 被拒。
 * @returns {{ok: boolean, error?: {code: string, message: string}, record?: object}}
 */
export function approveGate(workflow, input) {
  const { gateId, decision, operator, subject, credential, note, unresolved } = input ?? {}

  if (credential === undefined || credential === null || credential.channel !== 'host-ui') {
    return fail('E_GATE_CREDENTIAL_REQUIRED', '门禁决策必须经 Host 侧 UI 通道发起；模型 agent 无批准通道。')
  }
  if (!Object.hasOwn(GATES, gateId)) {
    return fail('E_GATE_UNKNOWN', `未知门禁：${String(gateId)}`)
  }
  if (decision !== 'approve' && decision !== 'reject') {
    return fail('E_GATE_DECISION_INVALID', '决策只能是 approve 或 reject。')
  }
  if (typeof operator !== 'string' || operator.trim().length === 0) {
    return fail('E_GATE_OPERATOR_REQUIRED', '必须提供操作人标识。')
  }
  if (workflow.frozen === true) {
    return fail('E_WORKFLOW_FROZEN', '工作流已冻结，不能再做门禁决策。')
  }
  const gate = workflow.gates[gateId]
  if (gate.status !== GATE_STATUS.PENDING) {
    return fail('E_GATE_ALREADY_DECIDED', `${gateId} 已裁决（${gate.status}），门禁决策不可撤销、不可覆写。`)
  }
  if (decision === 'approve' && Array.isArray(unresolved) && unresolved.length > 0) {
    return fail('E_GATE_UNRESOLVED_ITEMS', `存在 ${unresolved.length} 项未解决项，不能放行：${unresolved.join('；')}`)
  }

  const digest = subjectDigest(subject)
  const decidedAt = new Date().toISOString()
  const record = {
    seq: workflow.gateRecords.length + 1,
    gateId,
    gateTitle: GATES[gateId].title,
    decision,
    operator: operator.trim(),
    decidedAt,
    subjectDigest: digest,
    note: typeof note === 'string' ? note : null,
    requires: GATES[gateId].requires,
    previousRecordHash: workflow.gateRecords.length === 0
      ? null
      : workflow.gateRecords[workflow.gateRecords.length - 1].hash,
  }
  // 自封签：记录自身哈希也存下来，否则最后一条被篡改时无法发现
  // （只校验"前驱引用"只能发现中段篡改，末尾是盲区）。
  record.hash = recordHash(record)

  gate.status = decision === 'approve' ? GATE_STATUS.APPROVED : GATE_STATUS.REJECTED
  gate.decidedAt = decidedAt
  gate.decidedBy = record.operator
  workflow.gateRecords.push(record)

  if (decision === 'reject') workflow.frozen = true
  return { ok: true, record }
}

/**
 * 计算一条审计记录的链式哈希（哈希链：篡改任一条即可被发现）。
 * @param {object} record
 * @returns {string}
 */
export function recordHash(record) {
  const canonical = JSON.stringify({
    seq: record.seq,
    gateId: record.gateId,
    decision: record.decision,
    operator: record.operator,
    decidedAt: record.decidedAt,
    subjectDigest: record.subjectDigest,
    note: record.note,
    previousRecordHash: record.previousRecordHash,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * 校验整条审计链是否被篡改。
 *
 * 三重复核：① seq 连续 ② 前驱哈希指针吻合 ③ 每条记录的自封签 hash 与重算值一致。
 * 第③项不可省：只做②时，末条记录被改写无法被发现（没有后继来指证它）。
 *
 * @param {object[]} records
 * @returns {{valid: boolean, brokenAt: number|null, reason?: string}}
 */
export function verifyAuditChain(records) {
  let previous = null
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.seq !== index + 1) return { valid: false, brokenAt: index, reason: 'seq 不连续' }
    if (record.previousRecordHash !== previous) {
      return { valid: false, brokenAt: index, reason: '前驱哈希指针不吻合' }
    }
    if (typeof record.hash !== 'string' || record.hash.length === 0) {
      return { valid: false, brokenAt: index, reason: '记录缺少自封签' }
    }
    if (record.hash !== recordHash(record)) {
      return { valid: false, brokenAt: index, reason: '记录内容与自封签不符' }
    }
    previous = record.hash
  }
  return { valid: true, brokenAt: null }
}

/**
 * 判断某个门是否已批准。
 * @param {object} workflow
 * @param {string} gateId
 * @returns {boolean}
 */
export function isGateApproved(workflow, gateId) {
  return workflow?.gates?.[gateId]?.status === GATE_STATUS.APPROVED
}

/**
 * 判断工作流能否推进到下一步——门禁即控制流：未批准即不能推进。
 * @param {object} workflow
 * @param {string} gateId
 * @returns {{canAdvance: boolean, reason: string|null}}
 */
export function canAdvance(workflow, gateId) {
  const gate = workflow?.gates?.[gateId]
  if (gate === undefined) return { canAdvance: false, reason: `未知门禁：${String(gateId)}` }
  if (gate.status === GATE_STATUS.APPROVED) return { canAdvance: true, reason: null }
  if (gate.status === GATE_STATUS.REJECTED) {
    return { canAdvance: false, reason: `${gate.title} 已被拒绝，工作流冻结，需重新发起。` }
  }
  return { canAdvance: false, reason: `${gate.title} 尚未确认，工作流暂停。` }
}

function fail(code, message) {
  return { ok: false, error: { code, message } }
}
