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
  {
    id: 'deadline',
    label: '投标截止时间',
    // 「提交投标文件截止时间」这类标题本身不含日期；值常在**下一行**。
    // 注意不能把标题行里的「、开标时间和地点」当好值——先要求冒号，再回退到"下一行的日期"。
    regex: /(?:投标|响应|递交|提交)[^\n]{0,10}截止时间\s*[：:]\s*([^\n]{4,60})/u,
    fallback: /(?:投标|响应|递交|提交)[^\n]{0,10}截止时间[^\n]{0,20}\n+\s*([0-9]{4}\s*年[^\n]{4,40})/u,
  },
  { id: 'bidBond', label: '投标保证金', regex: /(?:投标保证金|保证金)[^0-9]{0,10}([0-9][0-9,.]*\s*(?:万元|元))/u },
  { id: 'duration', label: '工期/服务期', regex: /(?:服务期限|合同期限|履行期限|服务期|合同期|工期|交货期)[：:]?\s*([^\n]{2,40})/u },
  {
    id: 'location',
    label: '项目地点',
    // 标书里常简写为「地点：」「地址：」，不带「项目」前缀。
    regex: /(?:项目地点|实施地点|交货地点|服务地点|履约地点|地点|地址)[：:]\s*([^\n]{2,60})/u,
  },
  {
    id: 'qualification',
    label: '资格要求',
    // 资格条款常跨行（「1. …」换行「2. …」），只取单行会截断要求。
    regex: /(?:资格(?:条件|要求)|资质要求|供应商资格|特定资格要求)[：:]?\s*([^\n]{2,600})/u,
    multiline: true,
  },
  {
    id: 'technical',
    label: '技术要求',
    regex: /(?:技术(?:要求|规格|参数)|功能要求)[：:]?\s*([^\n]{2,600})/u,
    multiline: true,
  },
  {
    id: 'evaluation',
    label: '评审办法',
    // 「综合评分法」常直接出现在正文，无「评审办法：」标签。
    regex: /(?:评审(?:办法|标准|方法)|评标办法)[：:]?\s*([^\n]{2,300})/u,
    fallback: /((?:综合评分法|最低评标价法|经评审的最低投标价法|性价比法)[^\n]{0,200})/u,
    multiline: true,
  },
  { id: 'contract', label: '合同条款', regex: /(?:合同(?:条款|主要条款|草案))[：:]\s*([^\n]{2,300})/u },
  { id: 'ip', label: '知识产权', regex: /(?:知识产权|成果归属)[：:]\s*([^\n]{2,120})/u },
  { id: 'payment', label: '付款方式', regex: /(?:付款(?:方式|条件|比例))[：:]\s*([^\n]{2,120})/u },
  { id: 'warranty', label: '质保期', regex: /(?:质保期|保修期|质量保证期)[：:]?\s*([^\n]{2,40})/u },
  { id: 'acceptance', label: '验收标准', regex: /(?:验收(?:标准|方式|要求))[：:]\s*([^\n]{2,200})/u },
  { id: 'contact', label: '联系方式', regex: /(?:联系人|联系电话|联系方式)[：:]?\s*([^\n]{2,80})/u },
]

/**
 * 取字段值：主式未命中时试备用式，并按需跨行续读。
 * @param {object} field
 * @param {string} source
 * @returns {string|null}
 */
function takeField(field, source) {
  const tryOne = (regex) => {
    if (regex === undefined) return null
    const match = regex.exec(source)
    if (match === null) return null
    const value = extendValue(String(match[1] ?? '').trim(), source, match, field.multiline === true)
    return value.length === 0 ? null : value
  }
  return tryOne(field.regex) ?? tryOne(field.fallback)
}

/**
 * 跨行字段取值：命中行之后若紧跟同一条目的续行，则并入，直到遇到下一个编号条目或章节标题。
 * 单行字段原样返回。
 *
 * @param {string} value
 * @param {string} source
 * @param {RegExpExecArray} match
 * @param {boolean} multiline
 * @returns {string}
 */
function extendValue(value, source, match, multiline) {
  if (!multiline || value.length === 0) return value
  const after = source.slice(match.index + match[0].length)
  const STOP = /^(?:[0-9]{1,2}[.、）)]|[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|第[一二三四五六七八九十]+章)/u
  let merged = value
  for (const raw of after.split('\n').slice(1)) {
    const next = raw.trim()
    if (next.length === 0) break
    // 下一行是新条目/新章节 → 当前字段已结束。
    if (STOP.test(next)) break
    if (merged.length + next.length > 600) break
    merged += next
  }
  return merged
}

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
    const value = takeField(field, source)
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
 *
 * 关键难点：招标文件的评分表是**两层**结构——父级汇总项（价格分 30 / 技术分 60 / 商务分 10）
 * 与其下属评分细则（运营管理方案 15 / 应急预案 5 …）都会以「X 分」出现。
 * 若不分层直接全量累加，会得出 30+60+10+15+15+… = 170 这种大于 100 的总分，
 * 使每个章节的字数预算整体失真。
 *
 * 因此这里给每行打上 `level`（parent / child）与 `parentItem`，
 * 由 planOutline 只在**同一层**内求和。
 *
 * @param {string} text
 * @returns {Array<{item: string, score: number|null, category: string, level: string, parentItem: string|null}>}
 */
export function extractScoreTable(text) {
  const rows = []
  // 评分项不允许包含数字，且非贪婪：否则「技术方案 40 分」会把 40 吞进标题、再把 0 当分值。
  const linePattern = /([^\n|，,\d]{2,40}?)[|｜\s]{0,6}([0-9]{1,3}(?:\.[0-9])?)\s*分/gu
  for (const match of String(text ?? '').matchAll(linePattern)) {
    const item = match[1].trim()
    const score = Number(match[2])
    if (item.length === 0) continue
    rows.push({
      item,
      score: Number.isFinite(score) ? score : null,
      category: classifyScore(item),
      level: 'child',
      parentItem: null,
    })
  }
  return resolveScoreLevels(rows)
}

/**
 * 判定哪些行是父级汇总项，并把子项挂到父项下。
 *
 * 判据（全部为确定性规则，不做语义猜测）：
 *   ① 标题是「X分」的汇总形态：以「分」结尾或等于 价格分/技术分/商务分/资信分/其他分；
 *   ② 或该行分值等于其若干后续子项分值之和（且子项数 ≥ 2）。
 * 无法判定时保持 child，绝不臆造层级。
 *
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
/**
 * 判定哪些行是父级汇总项，并把子项挂到父项下。
 *
 * 核心事实：评分表总分不会超过 100 分。因此**只有当全量相加超过 100 时**，
 * 才存在"父项与子项重复计入"的可能，才需要做层级识别。
 * 这个前置条件很关键——否则「商务报价 30 分」后面恰好跟着「售后服务 20 分 + 业绩 10 分」
 * （和也是 30）这种平级巧合，会被误判成父项，把总分从 100 砍到 30。
 *
 * 启用层级识别后，按下列确定性判据定父项（不做语义猜测）：
 *   ① 标题形如「X分」（价格分 / 技术分 / 商务分 / 资信分…）——显式信号，优先；
 *   ② 仅当①完全找不到时，才用"连续子项之和恰等于本行分值（子项数 ≥ 2）"兜底。
 *
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
function resolveScoreLevels(rows) {
  const allSum = rows.reduce((sum, row) => sum + (row.score ?? 0), 0)

  // 总分未超 100 → 视为平级清单，全部按子项处理，不做任何层级推断。
  if (allSum <= 100) {
    return rows.map(row => ({ ...row, level: 'child', parentItem: null }))
  }

  const PARENT_LABEL = /^[\u4e00-\u9fa5]{2,6}分$/u
  const marks = rows.map(row => PARENT_LABEL.test(row.item.replace(/\s+/gu, '')))

  // ② 兜底：仅当①完全失效时启用。
  if (!marks.some(Boolean)) {
    for (let index = 0; index < rows.length; index += 1) {
      if (marks[index]) continue
      const target = rows[index].score
      if (target === null || target <= 0) continue
      let sum = 0
      let count = 0
      for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
        const value = rows[cursor].score
        if (value === null) break
        sum += value
        count += 1
        if (sum >= target) break
      }
      if (count >= 2 && Math.abs(sum - target) < 1e-6) marks[index] = true
    }
  }

  let currentParent = null
  return rows.map((row, index) => {
    if (marks[index]) {
      currentParent = row.item
      return { ...row, level: 'parent', parentItem: null }
    }
    return { ...row, level: 'child', parentItem: currentParent }
  })
}

function classifyScore(item) {
  if (/(价格|报价|投标价)/u.test(item)) return 'price'
  // 商务类关键词优先判定：否则「应急预案」会因含「服务」被误判为技术类。
  // 顺序敏感：先商务、再技术，避免商务项被技术正则抢走。
  if (/(业绩|信誉|资信|表彰|荣誉|财务|注册资金|体系认证|售后服务承诺|服务承诺)/u.test(item)) return 'commercial'
  if (/(应急|预案)/u.test(item)) return 'technical'
  if (/(技术|方案|实施|服务|质量|人员|设备|管理|培训|水质|救生|安全|运营|维护|保洁)/u.test(item)) return 'technical'
  return 'commercial'
}

/**
 * 按评分标准生成对齐目录：每个评分细则映射为一个二级章节。
 *
 * 分值口径：**父级汇总项与其子项不重复计入**。
 *   - 若存在可识别的父级项，则总分取父级项之和（父项与子项互为核对，不叠加）；
 *   - 若不存在父级项，则取全部子项之和；
 *   - 两种口径不一致（父项之和 ≠ 子项之和）时，以**子项之和**为准并在结果中标注，
 *     因为子项才是正文真正要逐条响应、逐条分配字数的对象。
 *
 * @param {object} parseResult - parseBidTender 的返回值。
 * @param {{targetWords?: number}} [options]
 * @returns {object}
 */
export function planOutline(parseResult, options = {}) {
  const scores = Array.isArray(parseResult?.scores) ? parseResult.scores : []
  const targetWords = options.targetWords ?? 60_000

  const parents = scores.filter(row => row.level === 'parent')
  const children = scores.filter(row => row.level !== 'parent')
  const sumOf = list => list.reduce((sum, row) => sum + (row.score ?? 0), 0)
  const parentSum = sumOf(parents)
  const childSum = sumOf(children)

  // 章节主体用子项；没有子项时退回父项（避免只剩汇总行时目录为空）。
  const scored = children.length > 0 ? children : parents

  // 总分口径：**只用一层**。
  //   ① 有父项 → 取父项之和（父项就是总分，子项是它的分解，二者不可相加）；
  //   ② 无父项 → 取子项之和。
  // 旧实现把两层都累加，产出 170 分这种大于 100 的总分，使字数预算整体失真。
  const totalScore = parents.length > 0 ? parentSum : childSum
  const parentMismatch = parents.length > 0 && children.length > 0 && Math.abs(parentSum - childSum) > 1e-6

  const chapters = scored.map((row, index) => {
    // 权重分母用满分（totalScore）；若某章节分值超出剩余额度则如实保留其分值，
    // 不裁剪权重，避免"看起来分配合理、实际章节被压扁"。
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

  // 评分表存在未列明细则的余额时（父项合计 > 子项合计），子项字数之和会小于目标字数。
  // 把余额按各章权重**等比例补足**到目标字数，使全书篇幅与招标要求一致；
  // 补足量与分配量分开记录，不掩盖"评分表不全"这一事实。
  const allocated = chapters.reduce((sum, chapter) => sum + chapter.targetWords, 0)
  const deficiency = targetWords - allocated
  const wordBudget = {
    targetWords,
    allocatedWords: allocated,
    deficiency,
    note: deficiency > 0
      ? `评分细则未覆盖全部 ${totalScore} 分（子项合计 ${childSum} 分），已按权重等比例补足 ${deficiency} 字，使全文接近目标字数。`
      : null,
  }
  if (deficiency > 0 && allocated > 0) {
    for (const chapter of chapters) {
      chapter.targetWords += Math.round(deficiency * (chapter.targetWords / allocated))
      chapter.targetWordsNote = '含评分表余额按比例补足的字数'
    }
  }

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
    wordBudget,
    scoreBreakdown: {
      parentSum,
      childSum,
      usedAsTotal: parents.length > 0 ? 'parentSum' : 'childSum',
      mismatch: parentMismatch,
      note: parentMismatch
        ? `父级汇总项合计 ${parentSum} 分与子项合计 ${childSum} 分不一致：字数权重已按父项合计 ${parentSum} 分分配，未被子项覆盖的 ${parentSum - childSum} 分属于评分表未列明细则的部分。请核对评分表是否漏项。`
        : null,
    },
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
  const result = {
    ok: true,
    items: items.map(item => ({ ...item, status: 'UNVERIFIED', mark: '【待填写/待核验】' })),
    notice: '本次未提供企业资料，以下事实字段全部标记为待核验。输出是标注完备的草案，不是可直接递交的标书。',
    fillingGuide: '逐项填写后调用 mont_guard_verify_fact 核验；全部核验通过且门2/门3 批准后方可导出。',
  }
  // 只在被要求时附加该键。不能用 `key: undefined`——宿主对工具输出做 lossless JSON
  // 校验，显式 undefined 会让整次调用被判为非法输出（实测报 "value is not lossless JSON"）。
  if (options.includePolicy === true) {
    result.sourcePolicy = items.map(item => ({ key: item.key, allowedSources: ['manual', 'verified_kb'] }))
  }
  return result
}

/**
 * 计算两段文本的相似度（工具层直接暴露，便于人工比对）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export { similarity }
