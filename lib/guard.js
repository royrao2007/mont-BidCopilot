/**
 * 合规硬约束内核：T-B1~T-B5 招标侧硬阻断 + 事实来源白名单。
 *
 * 设计原则：合规不是生成后的检查步骤，而是代码层不可执行路径。
 * 本模块是纯函数集合，无 I/O、无网络、无 LLM 调用，因此判定可复现、可单测。
 *
 * 命中即返回 { blocked: true }，调用方（tender.draftSection）据此不产出条款文本，
 * 模型拿不到可用条款 —— 这是"无法在资格条件中写进本地分支机构条款"的实现方式。
 *
 * @module lib/guard
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const RULES_PATH = fileURLToPath(new URL('../data/compliance-rules/tender-block.json', import.meta.url))

/** 线上规则缓存（模块级，进程内只解析一次）。 */
let cachedRules

/**
 * 地域限定词占位符的展开式。
 *
 * 为什么需要它：规则的原始写法只覆盖「本地 / 本市 / 本省 / 当地」这类**代词**，
 * 而真实条款几乎总是写**具体地名**（「宜宾市」「四川省」「项目所在地」）。
 * 只认代词的规则在实盘条款上会整片漏判——这是 T-B2 / T-B3 曾经的失效根因。
 *
 * 因此规则库用 `{{REGION}}` 占位，编译期展开成「具体行政区划名 ∪ 常见代词」。
 * 各级行政区划后缀（省/市/县/区/州/盟/旗）都必须覆盖，否则直辖市的「区」
 * 与自治州的「州」会漏。
 */
const REGION_TOKEN = String.raw`(?:(?:[\u4e00-\u9fa5]{2,8}(?:省|市|县|区|州|盟|旗))|本市|本地|本省|本区域|本辖区|本行政区|当地|项目所在地|工程所在地|采购人所在地|招标人所在地|所在地)`

/**
 * 把规则里的 `{{REGION}}` 占位符展开为真实的地域匹配式。
 * @param {string} pattern
 * @returns {string}
 */
function expandPlaceholders(pattern) {
  return pattern.includes('{{REGION}}')
    ? pattern.split('{{REGION}}').join(REGION_TOKEN)
    : pattern
}

/**
 * 读取并编译规则库。编译后的正则对象可复用，避免每次判定重新构造。
 * @returns {Promise<{rules: Array<object>, reviewRequired: Array<object>, revokedQualifications: string[], version: string}>}
 */
export async function loadRules() {
  if (cachedRules !== undefined) return cachedRules
  const raw = await readFile(RULES_PATH, 'utf8')
  const doc = JSON.parse(raw)
  const rules = (doc.rules ?? []).map(rule => ({
    ...rule,
    compiled: (rule.patterns ?? []).map(pattern => new RegExp(expandPlaceholders(pattern), 'iu')),
    // 否定豁免：命中句若整体是「不得指定品牌」这类**正确的禁止性表述**，不应误判为违规。
    negationCompiled: (rule.negations ?? []).map(pattern => new RegExp(expandPlaceholders(pattern), 'iu')),
  }))
  cachedRules = {
    rules,
    reviewRequired: doc.reviewRequired ?? [],
    revokedQualifications: doc.revokedQualifications ?? [],
    version: doc.version ?? '0.0.0',
    updatedAt: doc.updatedAt,
  }
  return cachedRules
}

/** 测试用：清空规则缓存，使下一次 loadRules 重新读盘。 */
export function resetRulesCache() {
  cachedRules = undefined
}

/**
 * 把条款文本切成句，用于定位命中片段。
 * 切分不影响判定，只影响返回的证据粒度。
 * @param {string} text
 * @returns {string[]}
 */
function sentencesOf(text) {
  return String(text)
    .split(/[。；;！!？?\n]+/u)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * 对一段条款文本做 T-B1~T-B5 硬阻断检查。
 *
 * @param {string} text - 待检查的条款/章节正文。
 * @param {object} [options]
 * @param {string[]} [options.ruleIds] - 只检查指定规则（测试与定点检查用）。
 * @returns {Promise<{
 *   blocked: boolean,
 *   blockedBy: string|null,
 *   reason: string|null,
 *   legalBasis: string|null,
 *   hits: Array<{ ruleId: string, title: string, evidence: string, severity: string }>,
 *   reviewRequired: Array<{ id: string, title: string, reason: string }>,
 *   ruleVersion: string
 * }>}
 */
export async function checkClause(text, options = {}) {
  const { rules, reviewRequired, version } = await loadRules()
  const wanted = options.ruleIds === undefined ? undefined : new Set(options.ruleIds)
  const sentences = sentencesOf(text ?? '')
  const hits = []

  for (const rule of rules) {
    if (wanted !== undefined && !wanted.has(rule.id)) continue
    for (const sentence of sentences) {
      // 否定豁免：整句属于「禁止指定品牌 / 不得限定地域」这类合规表述时不判违规。
      // 放在正则之前短路，避免「不得限定本地业绩」被当成「限定本地业绩」。
      const negated = rule.negationCompiled.some(regex => regex.test(sentence))
      if (negated) continue

      const matched = rule.compiled.some(regex => regex.test(sentence))
      if (!matched) continue
      hits.push({
        ruleId: rule.id,
        title: rule.title,
        evidence: sentence,
        severity: rule.severity ?? 'block',
        legalBasis: rule.legalBasis,
      })
      // 同一规则命中一句即止；跨句继续扫其他规则，不在此处跳出整条规则。
      break
    }
  }

  const first = hits[0]
  return {
    blocked: hits.length > 0,
    blockedBy: first === undefined ? null : first.ruleId,
    reason: first === undefined ? null : `${first.title}：${describeReason(rules, first.ruleId)}`,
    legalBasis: first === undefined ? null : first.legalBasis ?? null,
    hits,
    reviewRequired: reviewRequired.map(item => ({ id: item.id, title: item.title, reason: item.reason })),
    ruleVersion: version,
  }
}

/**
 * 取某条阻断规则的可读原因。
 * @param {Array<object>} rules
 * @param {string} ruleId
 * @returns {string}
 */
function describeReason(rules, ruleId) {
  const rule = rules.find(item => item.id === ruleId)
  return rule?.reason ?? '命中硬阻断规则'
}

/**
 * 检查条款中是否把已取消资质作为资格条件（T-B5 的清单部分）。
 * 与正则规则互补：正则是写法模式，这里是名字清单，避免漏网写法。
 *
 * @param {string} text
 * @returns {Promise<{violated: boolean, qualifications: string[]}>}
 */
export async function checkRevokedQualification(text) {
  const { revokedQualifications } = await loadRules()
  const haystack = String(text ?? '')
  const found = revokedQualifications.filter(item => haystack.includes(item))
  return { violated: found.length > 0, qualifications: found }
}

// ---------------------------------------------------------------------------
// 事实字段来源白名单（投标侧）
// ---------------------------------------------------------------------------

/**
 * 事实字段类别 → 允许来源。禁用来源的写入一律拒绝。
 *
 * 这张表是"无法从联网搜索或类似项目中借用业绩填入事实字段"的实现依据：
 * setFact() 只接受 allowedSources 内的来源，其余抛 E_FACT_SOURCE_REJECTED。
 */
export const FACT_SOURCE_POLICY = Object.freeze({
  enterpriseName: { allowedSources: ['manual', 'verified_kb'], label: '企业名称' },
  creditCode: { allowedSources: ['manual', 'verified_kb'], label: '统一社会信用代码' },
  qualification: { allowedSources: ['manual', 'verified_kb'], label: '资质证书编号与有效期' },
  performance: { allowedSources: ['manual', 'verified_kb'], label: '业绩项目名称、金额、合同' },
  personnel: { allowedSources: ['manual', 'verified_kb'], label: '人员姓名、证书、社保' },
  certification: { allowedSources: ['manual', 'verified_kb'], label: '检测结论、认证状态' },
  technicalApproach: { allowedSources: ['manual', 'verified_kb', 'L1', 'L2', 'L3'], label: '技术方案描述、行业做法' },
  performanceCommitment: { allowedSources: ['manual'], label: '具体性能承诺（数字）' },
  other: { allowedSources: ['manual', 'verified_kb', 'L1', 'L2', 'L3'], label: '其他' },
})

/** 事实字段状态机取值。 */
export const FACT_STATUS = Object.freeze({
  UNVERIFIED: 'UNVERIFIED',
  VERIFIED: 'VERIFIED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
})

/**
 * 判断某个事实类别是否允许来自某个来源。
 * @param {string} category
 * @param {string} source
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function checkFactSource(category, source) {
  const policy = FACT_SOURCE_POLICY[category] ?? FACT_SOURCE_POLICY.other
  if (policy.allowedSources.includes(source)) return { allowed: true, reason: null }
  return {
    allowed: false,
    reason: `「${policy.label}」不允许来自 ${source}；允许来源：${policy.allowedSources.join(' / ')}`,
  }
}

/**
 * 依据类别的来源策略，决定写入后事实字段的初始状态。
 *
 * 规则（v0.1.4 起收紧）：
 *   - `verified_kb`（已核验企业库）→ VERIFIED：来源本身即是核验过的库；
 *   - `manual`（人工录入）→ **UNVERIFIED**：录入 ≠ 核验。人工把材料敲进系统，
 *     仍需一次顯式的核验动作（带 operator）才算 VERIFIED。
 *     此前 manual 直接置 VERIFIED，等于「填写即核验」，导出门2 的事实闸形同虚设。
 *   - 外部引用（L1/L2/L3）→ UNVERIFIED。
 *
 * 兼容性：调用方若确实已完成线下核验并希望一步落库，可传 source='verified_kb'。
 *
 * @param {string} category
 * @param {string} source
 * @returns {string}
 */
export function initialFactStatus(category, source) {
  return source === 'verified_kb' ? FACT_STATUS.VERIFIED : FACT_STATUS.UNVERIFIED
}
