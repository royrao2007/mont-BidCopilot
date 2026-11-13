/**
 * 投标侧流水线：解析 → 评分对齐目录 → 章节写作 → 事实锁定 → 导出。
 *
 * 导出前的三重前置断言（任一不过即拒绝导出）：
 *   ① 所有事实字段已核验（无 UNVERIFIED）；
 *   ② 门2/门3 已批准（门禁即控制流）；
 *   ③ 雷同自检未超阈值。
 *
 * @module lib/bid
 */

import { unverifiedFacts } from './facts.js'
import { checkSelfDuplication, checkCollusion, similarity } from './similarity.js'
import { canAdvance, isGateApproved } from './workflow.js'

/** 投标侧错误。 */
export class BidError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BidError'
    this.code = code
  }
}

/** 18 项结构化解析字段（吸收 bidkit 的解析维度，用自有代码实现）。 */
const PARSE_FIELDS = [
  { id: 'projectName', label: '项目名称', regex: /(?:项目名称|采购项目名称)[：:]\s*([^\n]{2,80})/u },
  { id: 'projectNo', label: '项目编号', regex: /(?:项目编号|招标编号|采购编号)[：:]\s*([^\n]{2,60})/u },
  { id: 'tenderer', label: '招标人', regex: /(?:招标人|采购人|建设单位)[：:]\s*([^\n]{2,60})/u },
  { id: 'agency', label: '代理机构', regex: /(?:招标代理机构|代理机构|采购代理机构)[：:]\s*([^\n]{2,60})/u },
  { id: 'budget', label: '预算/限价', regex: /(?:预算|控制价|最高限价|采购预算)[^0-9]{0,12}([0-9][0-9,.]*\s*(?:万元|元|亿))/u },
  { id: 'deadline', label: '投标截止时间', regex: /(?:投标截止时间|递交截止时间|开标时间)[：:]?\s*([^\n]{4,40})/u },
  { id: 'bidBond', label: '投标保证金', regex: /(?:投标保证金|保证金)[^0-9]{0,10}([0-9][0-9,.]*\s*(?:万元|元))/u },
  { id: 'duration', label: '工期/服务期', regex: /(?:工期|服务期|合同履行期限|交货期)[：:]?\s*([^\n]{2,40})/u },
  { id: 'location', label: '项目地点', regex: /(?:项目地点|实施地点|交货地点|服务地点)[：:]\s*([^\n]{2,60})/u },
  { id: 'qualification', label: '资格要求', regex: /(?:资格(?:条件|要求)|资质要求|供应商资格)[：:]\s*([^\n]{2,300})/u },
  { id: 'technical', label: '技术要求', regex: /(?:技术(?:要求|规格|参数)|功能要求)[：:]\s*([^\n]{2,300})/u },
  { id: 'evaluation', label: '评审办法', regex: /(?:评审(?:办法|标准|方法)|评标办法)[：:]\s*([^\n]{2,300})/u },
  { id: 'contract', label: '合同条款', regex: /(?:合同(?:条款|主要条款|草案))[：:]\s*([^\n]{2,300})/u },
  { id: 'ip', label: '知识产权', regex: /(?:知识产权|成果归属)[：:]\s*([^\n]{2,120})/u },
  { id: 'payment', label: '付款方式', regex: /(?:付款(?:方式|条件|比例))[：:]\s*([^\n]{2,120})/u },
  { id: 'warranty', label: '质保期', regex: /(?:质保期|保修期|质量保证期)[：:]?\s*([^\n]{2,40})/u },
  { id: 'acceptance', label: '验收标准', regex: /(?:验收(?:标准|方式|要求))[：:]\s*([^\n]{2,200})/u },
  { id: 'contact', label: '联系方式', regex: /(?:联系人|联系电话|联系方式)[：:]?\s*([^\n]{2,80})/u },
]

/** ★ 实质性条款识别模式。 */
const STAR_PATTERNS = [
  /★[^\n]{0,120}/gu,
  /▲[^\n]{0,120}/gu,
  /(?:实质性(?:要求|条款|响应))[^\n]{0,120}/gu,
  /(?:否决(?:投标|其投标)|无效(?:投标|标))[^\n]{0,120}/gu,
]

/**
 * 解析招标文件，产出 18 项结构化结果 + ★ 条款 + 评分表。
 *
 * 缺项如实记为 null，并列入 coverage 统计——不臆造。
 *
 * @param {string} text
 * @returns {object}
 */
export function parseBidTender(text) {
  const source = String(text ?? '')
  if (source.trim().length === 0) throw new BidError('E_TEXT_REQUIRED', '招标文件正文不能为空。')

  const fields = {}
  let extracted = 0
  for (const field of PARSE_FIELDS) {
    const match = field.regex.exec(source)
    const value = match === null ? null : (match[1] ?? '').trim()
    fields[field.id] = { label: field.label, value }
    if (value !== null && value.length > 0) extracted += 1
  }

  const starClauses = []
  for (const pattern of STAR_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const clause = match[0].trim()
      if (clause.length > 2 && !starClauses.includes(clause)) starClauses.push(clause)
    }
  }

  const scores = extractScoreTable(source)

  return {
    ok: true,
    fields,
    coverage: `${extracted}/${PARSE_FIELDS.length}`,
    coverageRatio: Math.round((extracted / PARSE_FIELDS.length) * 1000) / 1000,
    missingFields: PARSE_FIELDS.filter(field => fields[field.id].value === null).map(field => field.label),
    starClauses,
    scores,
  }
}

/**
 * 抽取评分表。识别「评分项 + 分值」结构，含技术/商务/价格分类。
 * @param {string} text
 * @returns {Array<{item: string, score: number|null, category: string}>}
 */
export function extractScoreTable(text) {
  const rows = []
  // 评分项不允许包含数字，且非贪婪：否则「技术方案 40 分」会把 40 吞进标题、再把 0 当分值。
  const linePattern = /([^\n|，,\d]{2,40}?)[|｜\s]{0,6}([0-9]{1,3}(?:\.[0-9])?)\s*分/gu
  for (const match of String(text ?? '').matchAll(linePattern)) {
    const item = match[1].trim()
    const score = Number(match[2])
    if (item.length === 0) continue
    rows.push({ item, score: Number.isFinite(score) ? score : null, category: classifyScore(item) })
  }
  return rows
}

function classifyScore(item) {
  if (/(价格|报价|投标价)/u.test(item)) return 'price'
  if (/(技术|方案|实施|服务|质量|人员)/u.test(item)) return 'technical'
  return 'commercial'
}

/**
 * 按评分标准生成对齐目录：每个评分细则映射为一个二级章节。
 *
 * @param {object} parseResult - parseBidTender 的返回值。
 * @param {{targetWords?: number}} [options]
 * @returns {object}
 */
export function planOutline(parseResult, options = {}) {
  const scores = Array.isArray(parseResult?.scores) ? parseResult.scores : []
  const totalScore = scores.reduce((sum, row) => sum + (row.score ?? 0), 0)
  const targetWords = options.targetWords ?? 60_000

  const chapters = scores.map((row, index) => {
    const weight = totalScore > 0 && row.score !== null ? row.score / totalScore : 0
    return {
      index: index + 1,
      id: `section-${String(index + 1).padStart(2, '0')}`,
      title: row.item,
      category: row.category,
      score: row.score,
      weight: Math.round(weight * 1000) / 1000,
      targetWords: Math.round(targetWords * weight),
      rationale: `对应评分项「${row.item}」（${row.score ?? '未标'} 分，权重 ${(weight * 100).toFixed(1)}%）。`,
    }
  })

  // ★ 条款挂载：每条实质性条款必须找到响应它的章节。
  const starClauses = Array.isArray(parseResult?.starClauses) ? parseResult.starClauses : []
  const starMapping = starClauses.map(clause => {
    const target = chapters.find(chapter => clause.includes(chapter.title) || chapter.title.includes(clause.slice(0, 8)))
    return {
      clause,
      mappedTo: target?.id ?? null,
      warning: target === undefined ? '★条款未找到对应章节，必须新增响应章节。' : null,
    }
  })

  return {
    ok: true,
    chapters,
    totalScore,
    targetWords,
    starMapping,
    unmappedStarClauses: starMapping.filter(item => item.mappedTo === null).map(item => item.clause),
  }
}

/**
 * 锁定事实：把当前事实字段固化为不可回退的快照，并做一致性检查。
 *
 * @param {object} project
 * @returns {object}
 */
export function lockFacts(project) {
  const facts = Array.isArray(project.facts) ? project.facts : []
  const unverified = unverifiedFacts(project)
  const conflicts = []
  const seen = new Map()
  for (const fact of facts) {
    const value = fact.value === null ? null : String(fact.value).trim()
    if (value === null || value.length === 0) continue
    const previous = seen.get(fact.value)
    if (previous !== undefined && previous !== fact.key) {
      conflicts.push({ keys: [previous, fact.key], value })
    }
    seen.set(fact.value, fact.key)
  }

  project.factsLocked = true
  project.factsLockedAt = new Date().toISOString()
  return {
    ok: true,
    locked: true,
    total: facts.length,
    verified: facts.filter(fact => fact.status === 'VERIFIED').length,
    unverified: unverified.map(fact => ({ key: fact.key, label: fact.label ?? fact.category })),
    conflicts,
    blocked: unverified.length > 0,
    reason: unverified.length > 0
      ? `存在 ${unverified.length} 项未核验事实，导出将被阻断。`
      : null,
  }
}

/**
 * 导出前全部前置检查。**任何一项不过即拒绝导出。**
 *
 * @param {object} input
 * @param {object} input.project
 * @param {string} input.text - 拟导出的全文。
 * @param {object} input.workflow - 工作流状态。
 * @param {Array<{id?: string, text: string}>} [input.templateSources] - 模板/知识源。
 * @param {Array<{bidderId?: string, text: string}>} [input.otherBidders] - 其他投标人文本。
 * @param {object} [input.thresholds]
 * @returns {object}
 */
export function preExportCheck(input) {
  const blockers = []
  const project = input?.project ?? {}
  const workflow = input?.workflow
  const text = String(input?.text ?? '')

  // ① 事实核验
  const unverified = unverifiedFacts(project)
  if (unverified.length > 0) {
    blockers.push({
      code: 'E_UNVERIFIED_FACTS',
      gate: 'gate2',
      message: `存在 ${unverified.length} 项未核验事实字段，禁止导出。`,
      items: unverified.map(fact => fact.key),
    })
  }

  // ② 门2 事实与引用核验
  const gate2 = canAdvance(workflow, 'gate2')
  if (!gate2.canAdvance) {
    blockers.push({ code: 'E_GATE2_NOT_APPROVED', gate: 'gate2', message: gate2.reason })
  }

  // ③ 门3 最终合规签署
  const gate3 = canAdvance(workflow, 'gate3')
  if (!gate3.canAdvance) {
    blockers.push({ code: 'E_GATE3_NOT_APPROVED', gate: 'gate3', message: gate3.reason })
  }

  // ④ 自我复制
  const selfDup = checkSelfDuplication(text, input?.templateSources ?? [], {
    threshold: input?.thresholds?.selfDupThreshold,
  })
  if (selfDup.blocked) {
    blockers.push({
      code: 'E_SELF_DUPLICATION',
      message: '与模板/知识源相似度超阈值，需实质性差异化改写。',
      findings: selfDup.findings,
    })
  }

  // ⑤ 围标相似度
  const collusion = checkCollusion(text, input?.otherBidders ?? [], {
    threshold: input?.thresholds?.collusionThreshold,
  })
  if (collusion.blocked) {
    blockers.push({
      code: 'E_COLLUSION_RISK',
      message: '与其他投标人文本相似度达围标预警线。',
      findings: collusion.findings,
    })
  }

  return {
    ok: blockers.length === 0,
    canExport: blockers.length === 0,
    blockers,
    checks: {
      factsVerified: unverified.length === 0,
      gate2Approved: isGateApproved(workflow, 'gate2'),
      gate3Approved: isGateApproved(workflow, 'gate3'),
      selfDuplication: selfDup.blocked ? 'blocked' : 'pass',
      collusion: collusion.blocked ? 'blocked' : 'pass',
    },
  }
}

/**
 * 无企业资料时的诚实输出：待核验事实清单。
 *
 * @param {object} [options]
 * @returns {object}
 */
export function pendingFactChecklist(options = {}) {
  const items = [
    { key: 'enterpriseName', label: '企业名称', evidence: '营业执照' },
    { key: 'creditCode', label: '统一社会信用代码', evidence: '营业执照' },
    { key: 'qualification', label: '资质证书编号与有效期', evidence: '资质证书扫描件' },
    { key: 'performance', label: '业绩项目名称、金额、合同', evidence: '合同扫描件 + 验收证明' },
    { key: 'personnel', label: '人员姓名、证书、社保', evidence: '证书 + 社保缴纳记录' },
    { key: 'certification', label: '检测结论、认证状态', evidence: '检测报告/认证证书' },
    { key: 'performanceCommitment', label: '具体性能承诺（数字）', evidence: '须人工确认，不可由模型生成' },
  ]
  return {
    ok: true,
    items: items.map(item => ({ ...item, status: 'UNVERIFIED', mark: '【待填写/待核验】' })),
    notice: '本次未提供企业资料，以下事实字段全部标记为待核验。输出是标注完备的草案，不是可直接递交的标书。',
    fillingGuide: '逐项填写后调用 mont_guard_verify_fact 核验；全部核验通过且门2/门3 批准后方可导出。',
    sourcePolicy: options.includePolicy === true
      ? items.map(item => ({ key: item.key, allowedSources: ['manual', 'verified_kb'] }))
      : undefined,
  }
}

/**
 * 计算两段文本的相似度（工具层直接暴露，便于人工比对）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export { similarity }
