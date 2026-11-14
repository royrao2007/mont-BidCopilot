/**
 * 废标项 / 响应完整性检查（投标侧）。
 *
 * 设计定位：确定性规则，不依赖 LLM，结果可复现、可单测、可导出。
 * 这与「合规即架构」的整体口径一致——命中即给出结构化证据，不靠模型临场判断。
 *
 * 领域概念（公开事实，非任何项目的代码）：
 *   - 无效投标：因投标人、投标文件、签章密封、递交时间、报价、保证金、
 *     资格条件、实质性响应等原因，导致投标被认定无效、否决、不予受理或
 *     按无效响应处理的情形。
 *   - 废标项：可能导致项目废标、采购失败、重新招标、终止评审、
 *     有效投标人不足或实质性响应不足的条款或风险项。
 * 两者必须分开归类；原文中的同义表达（否决投标 / 投标无效 / 不予受理 /
 * 无效响应 / 重大偏差 / 实质性偏离 / 废标情形）按上述边界归一。
 *
 * 输出纪律（沿用本插件「不臆造」约定）：
 *   - explicit 只放招标文件原文中确实出现的条款，并保留原句作为 evidence；
 *   - inferred（经验补充）默认不输出，须显式 includeInferred=true 才给，
 *     且每条标注「经验补充，非原文」，不冒充招标文件要求；
 *   - 未响应项单列 unresponded，不混进「已通过」里。
 *
 * @module lib/rejection
 */

/**
 * 检查要点表：把「原文条款」归一为可核对的响应要点。
 *
 * keywords 用于两处：①判定招标文件是否出现该类条款；②判定投标文件章节是否响应该要点。
 * severity 分级：high=可能直接导致废标，medium=明确违反格式要求，low=需人工确认。
 * type 区分 invalidBid（投标被判无效）与 rejection（项目废标风险）。
 */
export const CHECKPOINTS = Object.freeze([
  { id: 'seal', label: '签章与密封', type: 'invalidBid', severity: 'high', keywords: ['签章', '签字', '盖章', '密封', '骑缝章', '法定代表人签字'] },
  { id: 'deadline', label: '递交时限', type: 'invalidBid', severity: 'high', keywords: ['递交截止时间', '投标截止时间', '逾期送达', '送达时间', '递交时间'] },
  { id: 'bidBond', label: '投标保证金', type: 'invalidBid', severity: 'high', keywords: ['投标保证金', '保证金', '保函'] },
  { id: 'priceCap', label: '报价与最高限价', type: 'invalidBid', severity: 'high', keywords: ['最高限价', '超过预算', '投标报价', '超限', '报价超过'] },
  { id: 'qualification', label: '资格条件响应', type: 'invalidBid', severity: 'high', keywords: ['营业执照', '资质证书', '资格条件', '许可证', '声明函', '资格证明'] },
  { id: 'authorized', label: '授权委托', type: 'invalidBid', severity: 'high', keywords: ['授权委托书', '法定代表人授权', '授权代表'] },
  { id: 'substantive', label: '实质性响应与偏离', type: 'invalidBid', severity: 'high', keywords: ['实质性响应', '实质性要求', '重大偏差', '实质性偏离', '否决投标', '无效投标'] },
  { id: 'validity', label: '投标有效期', type: 'invalidBid', severity: 'medium', keywords: ['投标有效期', '有效期不足'] },
  { id: 'format', label: '份数、装订与格式', type: 'invalidBid', severity: 'medium', keywords: ['正本', '副本', '份数', '装订', '活页', '页码', '逐页'] },
  { id: 'bidderCount', label: '有效投标人不足与重新招标', type: 'rejection', severity: 'high', keywords: ['不足三家', '重新招标', '采购失败', '终止评审', '废标', '有效投标人不足'] },
])

/** 原文中「无效投标/废标」同义表达，用于定位证据句。 */
const EVIDENCE_MARKERS = /(?:否决(?:其)?投标|投标无效|不予受理|无效响应|按无效(?:投标|响应)处理|重大偏差|实质性偏离|废标|采购失败|重新招标|终止评审)/u

/** 句子切分：与 guard.js 保持同一口径，便于跨模块核对。 */
function sentencesOf(text) {
  return String(text ?? '')
    .split(/[。；;！!？?\n]+/u)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * 从招标文件原文抽取废标 / 无效投标条款。
 *
 * 只保留**原文确实出现**的要点，并附原句证据；
 * 抽不到就返回空数组，不用通用清单填充。
 *
 * @param {string} text 招标文件正文
 * @returns {Array<{id,label,type,severity,evidence,matchedKeywords}>}
 */
export function extractRejectionClauses(text) {
  const sentences = sentencesOf(text)
  const found = []

  for (const point of CHECKPOINTS) {
    let evidence = null
    let matchedKeywords = []
    for (const sentence of sentences) {
      const hits = point.keywords.filter(word => sentence.includes(word))
      if (hits.length === 0) continue
      // 证据句须带「否决/无效/废标」类结论词，避免把「请加盖公章」这种中性说明误判为废标条款。
      if (!EVIDENCE_MARKERS.test(sentence)) continue
      evidence = sentence
      matchedKeywords = [...new Set([...matchedKeywords, ...hits])]
      break
    }
    if (evidence === null) continue
    found.push({
      id: point.id,
      label: point.label,
      type: point.type,
      severity: point.severity,
      evidence,
      matchedKeywords,
      source: 'explicit',
    })
  }
  return found
}

/**
 * 判定某个要点是否已被投标文件章节响应。
 *
 * 匹配口径（确定性）：章节标题或正文中出现该要点的任一 keyword 即为已响应。
 * 返回命中的章节 id 与命中词，便于人工复核「凭什么算响应了」。
 *
 * @param {object} point
 * @param {Array<{sectionId?:string,title?:string,content?:string}>} sections
 * @returns {{responded:boolean, sectionId:string|null, matchedBy:string|null}}
 */
export function findResponse(point, sections) {
  for (const section of sections ?? []) {
    const id = String(section?.sectionId ?? section?.title ?? '')
    const haystack = `${String(section?.title ?? '')}\n${String(section?.content ?? '')}`
    for (const word of point.keywords) {
      if (haystack.includes(word)) {
        return { responded: true, sectionId: id, matchedBy: word }
      }
    }
  }
  return { responded: false, sectionId: null, matchedBy: null }
}

/**
 * 经验补充项：仅在显式要求时给出。
 *
 * 这些是「此类标书常见但本招标文件原文未提及」的高风险遗漏项，
 * 属领域经验而非原文要求，因此每条都带 `source:'inferred'` 与提示语，
 * 调用方必须如实呈现，不得并入 explicit。
 *
 * @returns {Array<object>}
 */
export function inferredHighRiskPoints() {
  return CHECKPOINTS
    .filter(point => point.severity === 'high' && point.type === 'invalidBid')
    .map(point => ({
      id: point.id,
      label: point.label,
      type: point.type,
      severity: point.severity,
      source: 'inferred',
      note: '经验补充，非招标文件原文；需人工确认本项目是否适用。',
    }))
}

/**
 * 执行完整的废标项 / 响应完整性检查。
 *
 * @param {object} input
 * @param {string} [input.tenderText] 招标文件正文（用于抽取原文条款）
 * @param {Array<object>} [input.clauses] 或直接传入已抽取的条款（extractRejectionClauses 的结果）
 * @param {Array<{sectionId?:string,title?:string,content?:string}>} [input.sections] 投标文件章节
 * @param {string[]} [input.acknowledge] 已人工确认属误报 / 已线下整改的要点 id，不计入未响应
 * @param {boolean} [input.includeInferred] 是否附带经验补充项，默认 false（守住不臆造）
 * @returns {object}
 */
export function checkRejectionResponse(input = {}) {
  const clauses = Array.isArray(input.clauses)
    ? input.clauses
    : extractRejectionClauses(String(input.tenderText ?? ''))
  const sections = Array.isArray(input.sections) ? input.sections : []
  const acknowledged = new Set(
    (Array.isArray(input.acknowledge) ? input.acknowledge : []).map(item => String(item)),
  )

  const items = clauses.map(clause => {
    const point = CHECKPOINTS.find(item => item.id === clause.id) ?? {
      id: clause.id, label: clause.label ?? clause.id, keywords: clause.matchedKeywords ?? [],
      type: clause.type ?? 'invalidBid', severity: clause.severity ?? 'low',
    }
    const response = findResponse(point, sections)
    const isAcknowledged = acknowledged.has(clause.id)
    return {
      id: clause.id,
      label: clause.label ?? point.label,
      type: clause.type ?? point.type,
      severity: clause.severity ?? point.severity,
      evidence: clause.evidence ?? null,
      matchedKeywords: clause.matchedKeywords ?? [],
      responded: response.responded,
      respondedBy: response.sectionId,
      matchedBy: response.matchedBy,
      acknowledged: isAcknowledged,
      // 未响应 = 既没有章节响应，也未被人工确认。
      unresponded: !response.responded && !isAcknowledged,
    }
  })

  const unresponded = items.filter(item => item.unresponded)
  const bySeverity = { high: 0, medium: 0, low: 0 }
  for (const item of items) {
    if (Object.hasOwn(bySeverity, item.severity)) bySeverity[item.severity] += 1
  }
  const unrespondedBySeverity = { high: 0, medium: 0, low: 0 }
  for (const item of unresponded) {
    if (Object.hasOwn(unrespondedBySeverity, item.severity)) unrespondedBySeverity[item.severity] += 1
  }

  const inferred = input.includeInferred === true
    ? inferredHighRiskPoints().filter(point => !items.some(item => item.id === point.id))
    : []

  const result = {
    ok: true,
    explicit: {
      invalidBid: items.filter(item => item.type === 'invalidBid' && item.evidence !== null),
      rejection: items.filter(item => item.type === 'rejection' && item.evidence !== null),
    },
    items,
    responded: items.filter(item => item.responded).map(item => item.id),
    unresponded,
    bySeverity,
    unrespondedBySeverity,
    inferred,
    summary: {
      clauseCount: items.length,
      respondedCount: items.length - unresponded.length,
      unrespondedCount: unresponded.length,
      highRiskUnresponded: unrespondedBySeverity.high,
      sectionCount: sections.length,
    },
    // 存在未响应的 high 级要点时，导出前置检查应把该项列为阻断提示（由调用方决定）。
    blocked: unrespondedBySeverity.high > 0,
    notice: '本检查为确定性规则匹配，用于辅助复核；误报可通过 acknowledge 确认，最终以招标文件与人工核对为准。',
  }
  if (inferred.length === 0) delete result.inferred
  return result
}

/**
 * 规则元信息：让调用方看得到「按什么口径在查」。
 * @returns {object}
 */
export function describeRejectionRules() {
  return {
    ok: true,
    checkpointCount: CHECKPOINTS.length,
    byType: {
      invalidBid: CHECKPOINTS.filter(p => p.type === 'invalidBid').length,
      rejection: CHECKPOINTS.filter(p => p.type === 'rejection').length,
    },
    bySeverity: {
      high: CHECKPOINTS.filter(p => p.severity === 'high').length,
      medium: CHECKPOINTS.filter(p => p.severity === 'medium').length,
      low: CHECKPOINTS.filter(p => p.severity === 'low').length,
    },
    checkpoints: CHECKPOINTS.map(p => ({ id: p.id, label: p.label, type: p.type, severity: p.severity })),
    determinism: '纯规则匹配，无 LLM、无网络、无 I/O；同一输入必然同一结果。',
  }
}
