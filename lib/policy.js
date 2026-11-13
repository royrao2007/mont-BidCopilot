/**
 * 招投标政策依据库：给招标文件条款找政策支撑。
 *
 * 设计原则：
 *   - **纯离线**。政策文本内置在 data/policy-library/policies.json，检索不联网、不调用 LLM，
 *     因此同一次查询必然得到同一结果，可在门1 复核时复现。
 *   - **不做语义猜测**。评分是关键词精确命中 + 中文 bigram 重合度的确定性组合，
 *     命中即给出命中词，未命中就是未命中，不用"相关度很高"这类无法核对的措辞。
 *   - **标注适用场景**。每条政策带 relevantSections，能直接对上招标文件的章节 id。
 *
 * 重要限制（必须如实告知使用者）：
 *   内置库是**常用政策的最小可用集**，不是全量法规库。检索不到不等于没有相关政策，
 *   只代表"内置库未收录"。需要完整依据时应由招标人核对官方发布渠道。
 *
 * @module lib/policy
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const LIBRARY_PATH = fileURLToPath(new URL('../data/policy-library/policies.json', import.meta.url))

/** 模块级缓存：进程内只解析一次。 */
let cachedLibrary

/**
 * 读取政策库。
 * @returns {Promise<{policies: Array<object>, version: string, updatedAt: string}>}
 */
export async function loadPolicies() {
  if (cachedLibrary !== undefined) return cachedLibrary
  const raw = await readFile(LIBRARY_PATH, 'utf8')
  const doc = JSON.parse(raw)
  cachedLibrary = {
    policies: doc.policies ?? [],
    version: doc.version ?? '0.0.0',
    updatedAt: doc.updatedAt ?? null,
  }
  return cachedLibrary
}

/** 测试用：清空缓存。 */
export function resetPolicyCache() {
  cachedLibrary = undefined
}

/**
 * 把文本切成中文 bigram + 英文/数字 token，用于重合度打分。
 * 中文不分词（避免引入词典依赖），用相邻两字组合近似语义单元。
 * @param {string} text
 * @returns {Set<string>}
 */
function tokensOf(text) {
  const normalized = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[^\p{Script=Han}a-z0-9]/gu, '')
  const out = new Set()
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    out.add(normalized.slice(index, index + 2))
  }
  if (normalized.length === 1) out.add(normalized)
  return out
}

/**
 * 计算两段文本的 bigram 重合度（以查询侧为分母，衡量"查询被覆盖了多少"）。
 * @param {Set<string>} queryTokens
 * @param {Set<string>} docTokens
 * @returns {number} 0..1
 */
function coverage(queryTokens, docTokens) {
  if (queryTokens.size === 0) return 0
  let hit = 0
  for (const token of queryTokens) if (docTokens.has(token)) hit += 1
  return hit / queryTokens.size
}

/**
 * 检索政策依据。
 *
 * 打分口径（确定性）：
 *   keywordHits × 3   —— 关键词精确命中，权重最高（可解释）
 *   topicHits   × 2   —— 主题词命中
 *   bigramCoverage × 10 —— 与标题/摘要/关键词的文本重合度
 * 同分时按政策层级（法律 > 行政法规 > 部门规章 > 规范性文件 > 国家标准 > 卫生规范）与 id 排序，
 * 保证结果稳定、可复现。
 *
 * @param {{query?: string, section?: string, topics?: string[], limit?: number}} input
 * @returns {Promise<object>}
 */
export async function searchPolicies(input = {}) {
  const library = await loadPolicies()
  const query = String(input.query ?? '').trim()
  const section = input.section === undefined ? null : String(input.section)
  const topicFilter = Array.isArray(input.topics) && input.topics.length > 0
    ? input.topics.map(item => String(item))
    : null
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(50, Number(input.limit))) : 10

  if (query.length === 0 && section === null && topicFilter === null) {
    return {
      ok: false,
      error: {
        code: 'E_QUERY_REQUIRED',
        message: '至少提供 query、section、topics 之一；空检索会返回全部政策，不具备参考价值。',
      },
    }
  }

  const queryTokens = tokensOf(query)
  const hasQuery = query.length > 0
  const scored = []

  for (const policy of library.policies) {
    const haystack = [
      policy.title,
      policy.summary,
      (policy.keywords ?? []).join(' '),
      (policy.topics ?? []).join(' '),
      (policy.clauses ?? []).join(' '),
      policy.code,
    ].join(' ')

    // 主题过滤：给了 topics 就只保留命中任一项的政策。
    if (topicFilter !== null) {
      const topics = policy.topics ?? []
      const matchedTopic = topicFilter.some(item => topics.includes(item))
      if (!matchedTopic) continue
    }

    // 章节过滤：给 section 就只保留服务于该章节的政策。
    if (section !== null) {
      const sections = policy.relevantSections ?? []
      if (!sections.includes(section)) continue
    }

    // 关键词命中：①查询里直接出现该词；②长词（>2 字）与查询的 bigram 重合度过半。
    // 短词只走①，否则「品牌」会在任何含"品"字的查询里误命中。
    const keywordHits = hasQuery
      ? (policy.keywords ?? []).filter(word => {
        if (query.includes(word)) return true
        if (word.length <= 2) return false
        return coverage(tokensOf(query), tokensOf(word)) >= 0.5
      })
      : []
    const topicHits = hasQuery ? (policy.topics ?? []).filter(topic => query.includes(topic)) : []
    const relevance = hasQuery ? coverage(queryTokens, tokensOf(haystack)) : 0

    const score = keywordHits.length * 3 + topicHits.length * 2 + relevance * 10

    // 入选门槛（有查询词时）：
    //   - 至少命中一个关键词或主题；或
    //   - bigram 相关度达到 0.25 以上（约覆盖查询四分之一的相邻字组）。
    // 只靠微弱字面重合（如无关长句里偶然出现"审查"）不得入选——
    // 否则会给出看似相关、实则无依据的政策，比不返回更糟。
    const relevantEnough = keywordHits.length > 0 || topicHits.length > 0 || relevance >= 0.25
    if (hasQuery && !relevantEnough) continue

    scored.push({
      id: policy.id,
      code: policy.code,
      title: policy.title,
      level: policy.level,
      issuer: policy.issuer,
      effectiveFrom: policy.effectiveFrom ?? null,
      currentVersion: policy.currentVersion ?? null,
      summary: policy.summary,
      relevantSections: policy.relevantSections ?? [],
      matchedKeywords: keywordHits,
      matchedTopics: topicHits,
      score: Math.round(score * 100) / 100,
      scoreBasis: hasQuery ? 'query' : 'filterOnly',
    })
  }

  const LEVEL_ORDER = ['法律', '行政法规', '部门规章', '规范性文件', '国家标准', '卫生规范']
  const levelRank = level => {
    const index = LEVEL_ORDER.indexOf(level)
    return index === -1 ? 99 : index
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // 同分时按效力层级排序（法律先于行政法规，以此类推），再按 id 定序，保证可复现。
    const byLevel = levelRank(a.level) - levelRank(b.level)
    if (byLevel !== 0) return byLevel
    return a.id < b.id ? -1 : 1
  })

  const results = scored.slice(0, limit)

  return {
    ok: true,
    query: query.length > 0 ? query : null,
    section,
    topics: topicFilter,
    results,
    total: results.length,
    candidateTotal: scored.length,
    libraryVersion: library.version,
    libraryUpdatedAt: library.updatedAt,
    // 如实声明覆盖面限制，避免使用者误以为"查不到=没有政策"。
    coverageNotice: '内置政策库为常用政策的最小可用集，并非全量法规库。未命中仅表示内置库未收录，不代表不存在相关规定；正式发文前请核对官方发布渠道。',
  }
}

/**
 * 按招标文件章节列出全部可用政策依据（不检索，直接按 relevantSections 归类）。
 * @param {{sections?: string[]}} [input]
 * @returns {Promise<object>}
 */
export async function policiesBySection(input = {}) {
  const library = await loadPolicies()
  const wanted = Array.isArray(input.sections) && input.sections.length > 0
    ? input.sections.map(item => String(item))
    : null

  const grouped = {}
  for (const policy of library.policies) {
    for (const section of policy.relevantSections ?? []) {
      if (wanted !== null && !wanted.includes(section)) continue
      if (grouped[section] === undefined) grouped[section] = []
      grouped[section].push({
        id: policy.id,
        code: policy.code,
        title: policy.title,
        level: policy.level,
        summary: policy.summary,
      })
    }
  }

  return {
    ok: true,
    bySection: grouped,
    sectionCount: Object.keys(grouped).length,
    policyTotal: library.policies.length,
    libraryVersion: library.version,
    coverageNotice: '内置政策库为常用政策的最小可用集，并非全量法规库。',
  }
}
