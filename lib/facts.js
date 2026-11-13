/**
 * 事实字段状态机：来源白名单硬拒 + UNVERIFIED 阻断导出。
 *
 * 这是"无法从联网搜索或类似项目中借用业绩填入事实字段"的实现点：
 * setFact 先查 FACT_SOURCE_POLICY，禁用来源直接抛出，不写入、不降级。
 *
 * @module lib/facts
 */

import { FACT_STATUS, FACT_SOURCE_POLICY, checkFactSource, initialFactStatus } from './guard.js'

/** 事实层错误。 */
export class FactError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FactError'
    this.code = code
  }
}

/**
 * 新增或更新一个事实字段。
 *
 * @param {object} project - 项目索引（就地更新 facts 数组）。
 * @param {object} input
 * @param {string} input.key - 字段键，例如 enterpriseName。
 * @param {string} [input.value] - 值；为空表示尚未填写。
 * @param {string} [input.category] - 类别，决定来源策略；缺省按 key 猜。
 * @param {string} input.source - 来源：manual / verified_kb / L1 / L2 / L3 / web / similar_project / model
 * @param {string} [input.evidenceRef] - 证据引用（文件路径或证书编号）。
 * @returns {{ok: true, fact: object}}
 * @throws {FactError} 来源被禁止时
 */
export function setFact(project, input) {
  const key = String(input?.key ?? '').trim()
  if (key.length === 0) throw new FactError('E_FACT_KEY_REQUIRED', '事实字段 key 不能为空。')
  const category = input?.category ?? inferCategory(key)
  const source = String(input?.source ?? '').trim()
  if (source.length === 0) throw new FactError('E_FACT_SOURCE_REQUIRED', '必须声明事实来源（source）。')

  const verdict = checkFactSource(category, source)
  if (!verdict.allowed) {
    throw new FactError('E_FACT_SOURCE_REJECTED', verdict.reason)
  }

  const value = input?.value === undefined || input?.value === null ? null : String(input.value)
  const status = value === null || value.trim().length === 0
    ? FACT_STATUS.UNVERIFIED
    : initialFactStatus(category, source)

  const facts = Array.isArray(project.facts) ? project.facts : []
  const existingIndex = facts.findIndex(item => item.key === key)
  const fact = {
    key,
    category,
    value,
    status,
    source,
    evidenceRef: input?.evidenceRef === undefined ? null : String(input.evidenceRef),
    updatedAt: new Date().toISOString(),
  }
  if (existingIndex >= 0) facts[existingIndex] = fact
  else facts.push(fact)
  project.facts = facts
  return { ok: true, fact }
}

/**
 * 人工核验一个事实字段（把 UNVERIFIED 置为 VERIFIED）。
 * 只有人工核验能置 VERIFIED——模型不能自己核验自己的输出。
 *
 * @param {object} project
 * @param {string} key
 * @param {{operator: string, evidenceRef?: string}} input
 * @returns {{ok: true, fact: object}}
 */
export function verifyFact(project, key, input) {
  const facts = Array.isArray(project.facts) ? project.facts : []
  const fact = facts.find(item => item.key === key)
  if (fact === undefined) throw new FactError('E_FACT_NOT_FOUND', `事实字段 ${key} 不存在。`)
  if (typeof input?.operator !== 'string' || input.operator.trim().length === 0) {
    throw new FactError('E_OPERATOR_REQUIRED', '核验必须记录操作人。')
  }
  if (fact.value === null || String(fact.value).trim().length === 0) {
    throw new FactError('E_FACT_EMPTY', `事实字段 ${key} 尚无值，不能核验。`)
  }
  fact.status = FACT_STATUS.VERIFIED
  fact.verifiedBy = input.operator.trim()
  fact.verifiedAt = new Date().toISOString()
  if (input?.evidenceRef !== undefined) fact.evidenceRef = String(input.evidenceRef)
  return { ok: true, fact }
}

/**
 * 标记某字段不适用。
 * @param {object} project
 * @param {string} key
 * @param {string} reason
 */
export function markFactNotApplicable(project, key, reason) {
  const facts = Array.isArray(project.facts) ? project.facts : []
  const fact = facts.find(item => item.key === key)
  if (fact === undefined) throw new FactError('E_FACT_NOT_FOUND', `事实字段 ${key} 不存在。`)
  fact.status = FACT_STATUS.NOT_APPLICABLE
  fact.notApplicableReason = String(reason ?? '')
  return { ok: true, fact }
}

/**
 * 列出全部未核验的事实字段——导出前置检查用。
 * @param {object} project
 * @returns {Array<object>}
 */
export function unverifiedFacts(project) {
  const facts = Array.isArray(project.facts) ? project.facts : []
  return facts.filter(fact => fact.status === FACT_STATUS.UNVERIFIED)
}

/**
 * 依据字段键猜测类别。猜不到归 other（other 的允许来源较宽，但外部来源仍不置 VERIFIED）。
 * @param {string} key
 * @returns {string}
 */
export function inferCategory(key) {
  const lower = String(key).toLowerCase()
  if (/(enterprise|company|corp).*name|^name$/u.test(lower)) return 'enterpriseName'
  if (/(credit|uscc|code)/u.test(lower)) return 'creditCode'
  if (/(qualification|cert|license|zizhi)/u.test(lower)) return 'qualification'
  if (/(performance|project|contract|yiji)/u.test(lower)) return 'performance'
  if (/(personnel|staff|people|member|employee)/u.test(lower)) return 'personnel'
  if (/(certification|inspection|test)/u.test(lower)) return 'certification'
  if (/(approach|solution|technical|method)/u.test(lower)) return 'technicalApproach'
  if (/(commitment|sla|throughput|capacity|number)/u.test(lower)) return 'performanceCommitment'
  return 'other'
}

/**
 * 列出事实来源策略（供工具向模型说明规则）。
 * @returns {Array<object>}
 */
export function describeSourcePolicy() {
  return Object.entries(FACT_SOURCE_POLICY).map(([category, policy]) => ({
    category,
    label: policy.label,
    allowedSources: [...policy.allowedSources],
  }))
}
