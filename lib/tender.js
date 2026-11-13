/**
 * 招标侧流水线：需求结构化 → 行业匹配 → 逐节草案（含硬阻断）→ 跨板块一致性。
 *
 * 关键约束：draftSection 在**生成条款文本之前**调用合规内核，
 * 命中 T-B 规则即返回 { generated: false, blockedBy, reason }，
 * 模型拿不到可用条款文本 —— 这是"合规即架构"的落点。
 *
 * @module lib/tender
 */

import { checkClause, loadRules } from './guard.js'
import { matchIndustry, industryOutline } from './industry.js'

/** 招标侧错误。 */
export class TenderError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TenderError'
    this.code = code
  }
}

/** 需要强制法务复核的章节（合同类）。 */
const LEGAL_REVIEW_SECTIONS = new Set(['contract', 'contract_draft', 'commercial'])

/**
 * 把自然语言需求结构化为字段。
 *
 * 守则：缺失项标记「待招标人补充」，**不臆造**。本函数不做任何推测性填充，
 * 只按显式模式抽取；抽不到就留空并记录为待补充项。
 *
 * @param {string} text - 需求描述原文。
 * @returns {Promise<object>}
 */
export async function parseTender(text) {
  const source = String(text ?? '')
  if (source.trim().length === 0) {
    throw new TenderError('E_TEXT_REQUIRED', '需求描述不能为空。')
  }

  const pick = (regex) => {
    const match = regex.exec(source)
    return match === null ? null : (match[1] ?? match[0]).trim()
  }

  const requirements = {
    subjectType: pick(/(?:标的类型|采购类型|项目类型)[：:]\s*([^\n，,。；;]{1,40})/u),
    budget: pick(/(?:预算|采购预算|控制价|最高限价)[^0-9]{0,12}([0-9][0-9,.]*\s*(?:万元|元|亿))/u),
    duration: pick(/(?:工期|服务期|合同期)[：:]?\s*([^\n，,。；;]{1,40})/u),
    indicators: pick(/(?:功能要求|性能指标|技术指标|技术要求)[：:]\s*([^\n]{1,200})/u),
    qualificationHints: pick(/(?:资格(?:条件|要求)|资质要求)[：:]\s*([^\n]{1,200})/u),
    ipOwnership: pick(/(?:知识产权|成果归属)[：:]\s*([^\n]{1,120})/u),
  }

  const missing = Object.entries(requirements)
    .filter(([, value]) => value === null)
    .map(([key]) => key)

  const industry = await matchIndustry(source)
  const outline = await industryOutline(industry.industry)
  const { reviewRequired, version } = await loadRules()

  return {
    ok: true,
    requirements,
    missingFields: missing,
    missingNotice: missing.length === 0
      ? null
      : `以下字段未能从需求中识别，标记为「待招标人补充」，未做臆造：${missing.join('、')}`,
    industry,
    suggestedSections: outline.sections,
    mandatoryReview: reviewRequired.map(item => ({ id: item.id, title: item.title, reason: item.reason })),
    ruleVersion: version,
  }
}

/**
 * 生成单节招标草案。**先过合规内核，再产出文本。**
 *
 * @param {object} input
 * @param {string} input.sectionId
 * @param {string} input.title
 * @param {string} input.content - 拟写入的条款正文（模型起草的候选文本）。
 * @param {object} [input.requirements] - 结构化需求，用于生成"待补充"标记。
 * @returns {Promise<object>}
 */
export async function draftSection(input) {
  const sectionId = String(input?.sectionId ?? '').trim()
  if (sectionId.length === 0) throw new TenderError('E_SECTION_ID_REQUIRED', 'sectionId 不能为空。')
  const candidate = String(input?.content ?? '')

  // ① 硬阻断检查（在任何文本产出之前）
  const verdict = await checkClause(candidate)

  if (verdict.blocked) {
    return {
      ok: true,
      generated: false,
      sectionId,
      blockedBy: verdict.blockedBy,
      reason: verdict.reason,
      legalBasis: verdict.legalBasis,
      hits: verdict.hits,
      // 明确不给可用条款文本。
      content: null,
      guidance: '该条款命中硬阻断规则，已拒绝生成。请按 legalBasis 修改资格条件后重试；不得以改写措辞方式规避同一限制。',
    }
  }

  const requiresLegalReview = LEGAL_REVIEW_SECTIONS.has(sectionId)
  const pendingMarks = []
  const requirements = input?.requirements ?? {}
  for (const [key, value] of Object.entries(requirements)) {
    if (value === null || value === '') pendingMarks.push(`【待招标人补充：${key}】`)
  }

  return {
    ok: true,
    generated: true,
    sectionId,
    title: typeof input?.title === 'string' ? input.title : sectionId,
    content: candidate,
    requiresLegalReview,
    pendingMarks,
    sourceLabels: extractSourceLabels(candidate),
    mandatoryReview: verdict.reviewRequired,
    ruleVersion: verdict.ruleVersion,
  }
}

/**
 * 提取文本中的来源标签（L1/L2/L3），用于核对每条外部引用是否带标签。
 * @param {string} text
 * @returns {{L1: number, L2: number, L3: number, unlabeledRisk: boolean}}
 */
export function extractSourceLabels(text) {
  const source = String(text ?? '')
  const count = (layer) => (source.match(new RegExp(`\\b${layer}\\b`, 'gu')) ?? []).length
  const labels = { L1: count('L1'), L2: count('L2'), L3: count('L3') }
  // 含"根据/据统计/参考"等外部引用句式但无任何层级标签 → 存在未标注来源风险。
  const hasExternalClaim = /(?:根据|据统计|参考|依据.{0,6}(?:研究|报告|白皮书|标准))/u.test(source)
  const unlabeledRisk = hasExternalClaim && labels.L1 + labels.L2 + labels.L3 === 0
  return { ...labels, unlabeledRisk }
}

/**
 * 跨板块一致性校验：预算 vs 合同、工期 vs 技术需求、评审办法 vs 需求。
 *
 * 输出「待确认」，不自动修正 —— 修正是人的决定。
 *
 * @param {Array<{sectionId: string, content: string}>} sections
 * @returns {{issues: Array<object>}}
 */
export function checkConsistency(sections) {
  const issues = []
  const bySection = new Map((sections ?? []).map(item => [item.sectionId, String(item.content ?? '')]))
  const all = [...bySection.values()].join('\n')

  // 金额一致性：抽取所有「X 万元」，若预算段与合同段出现不同金额则提示。
  const amounts = [...all.matchAll(/([0-9][0-9,.]*)\s*万元/gu)].map(match => Number(match[1].replace(/,/gu, '')))
  if (amounts.length > 1) {
    const unique = [...new Set(amounts)]
    if (unique.length > 1) {
      issues.push({
        kind: 'amountMismatch',
        detail: `文内出现多个金额：${unique.join(' / ')} 万元`,
        action: '待确认：预算金额与合同金额是否应一致。',
      })
    }
  }

  // 工期一致性：抽取「N 天/月/年」，跨段不同则提示。
  const durations = [...all.matchAll(/([0-9]+)\s*(日历天|个?工作日|天|个月|月|年)/gu)].map(match => `${match[1]}${match[2]}`)
  if (durations.length > 1) {
    const unique = [...new Set(durations)]
    if (unique.length > 1) {
      issues.push({
        kind: 'durationMismatch',
        detail: `文内出现多个工期表述：${unique.join(' / ')}`,
        action: '待确认：技术需求与合同工期是否应一致。',
      })
    }
  }

  // 评审办法 vs 需求：评审办法段提到但需求段未出现的评分项。
  const evaluation = bySection.get('evaluation') ?? ''
  const technical = bySection.get('technical') ?? bySection.get('technical_requirements') ?? ''
  if (evaluation.length > 0 && technical.length > 0) {
    const evalItems = [...evaluation.matchAll(/([^\n，,。；;]{2,12})(?:评分|得分|分值)/gu)].map(match => match[1].trim())
    const missingInTech = evalItems.filter(item => item.length > 1 && !technical.includes(item))
    if (missingInTech.length > 0) {
      issues.push({
        kind: 'evaluationNotBackedByRequirement',
        detail: `评审办法中的评分项在技术需求中未找到对应要求：${[...new Set(missingInTech)].join('、')}`,
        action: '待确认：评分项须有对应的需求条款支撑，否则易被质疑倾向性。',
      })
    }
  }

  return { issues, count: issues.length, autoFixed: false }
}
