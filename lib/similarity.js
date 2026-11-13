/**
 * 雷同自检：拆成两条互相独立的规则，各自独立阈值。
 *
 * 为什么必须拆开（这是对原方案 §6.4 的修正）：
 *   - 「自我复制检测」比的是 生成文本 vs 同一知识源/模板，用于发现把自家模板复制粘贴。
 *   - 「围标相似度」比的是 不同投标人之间的技术方案，对应 195 号文「技术方案语义相似性分析」场景。
 * 两条规则若共用一个 0.65 阈值，同一投标人复用自家模板时会大量误报（假阳性）。
 *
 * 实现：SimHash（64 位）+ 字符 3-gram Jaccard，两者取较大值作为相似度。
 * 纯函数、无 I/O、可复现。
 *
 * @module lib/similarity
 */

/** 生成 64 位 SimHash 的指纹。 */
export function simHash64(text) {
  const s = normalizeForCompare(text)
  const tokens = shingles(s, 3)
  if (tokens.length === 0) return 0n
  const vector = new Array(64).fill(0)
  for (const token of tokens) {
    const hash = fnv1a64(token)
    for (let bit = 0; bit < 64; bit += 1) {
      const isSet = (hash >> BigInt(bit)) & 1n
      vector[bit] += isSet === 1n ? 1 : -1
    }
  }
  let fingerprint = 0n
  for (let bit = 0; bit < 64; bit += 1) {
    if (vector[bit] > 0) fingerprint |= 1n << BigInt(bit)
  }
  return fingerprint
}

/** 两个 SimHash 的相似度（1 - 汉明距离/64）。 */
export function simHashSimilarity(a, b) {
  let distance = 0
  let diff = a ^ b
  while (diff !== 0n) {
    distance += Number(diff & 1n)
    diff >>= 1n
  }
  return 1 - distance / 64
}

/** 字符 n-gram 集合的 Jaccard 相似度。 */
export function jaccardSimilarity(textA, textB, n = 3) {
  const setA = new Set(shingles(normalizeForCompare(textA), n))
  const setB = new Set(shingles(normalizeForCompare(textB), n))
  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const token of setA) if (setB.has(token)) intersection += 1
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * 综合相似度：SimHash 与 Jaccard 取较大值。
 * 取 max 而非加权平均，是为了不因其中一种算法对短文本不敏感而漏报（避免假阴性）。
 */
export function similarity(textA, textB) {
  if (typeof textA !== 'string' || typeof textB !== 'string') return 0
  if (textA.trim().length === 0 || textB.trim().length === 0) return 0
  const sim = simHashSimilarity(simHash64(textA), simHash64(textB))
  const jac = jaccardSimilarity(textA, textB)
  return Math.max(sim, jac)
}

/**
 * 自我复制自检：给定生成文本与它所用的知识源/模板，检查是否超过自复制阈值。
 * @param {string} generated
 * @param {Array<{id?: string, text: string}>} sources
 * @param {{threshold?: number}} [options] - 默认 0.85（自复制容忍度高于围标）。
 */
export function checkSelfDuplication(generated, sources, options = {}) {
  const threshold = options.threshold ?? 0.85
  const findings = []
  for (const source of sources ?? []) {
    const score = similarity(generated, source.text)
    if (score >= threshold) {
      findings.push({
        kind: 'selfDuplication',
        sourceId: source.id ?? null,
        score: round(score),
        threshold,
        message: `与模板/知识源的相似度为 ${round(score)}，达到自复制阈值 ${threshold}，需实质性差异化改写。`,
      })
    }
  }
  return { blocked: findings.length > 0, findings }
}

/**
 * 围标相似度自检：比较当前投标文本与其他投标人的文本。
 * @param {string} current
 * @param {Array<{bidderId?: string, text: string}>} others
 * @param {{threshold?: number}} [options] - 默认 0.65（对应多地 60%—70% 预警线）。
 */
export function checkCollusion(current, others, options = {}) {
  const threshold = options.threshold ?? 0.65
  const findings = []
  for (const other of others ?? []) {
    const score = similarity(current, other.text)
    if (score >= threshold) {
      findings.push({
        kind: 'collusion',
        otherBidderId: other.bidderId ?? null,
        score: round(score),
        threshold,
        message: `与其他投标人文本相似度为 ${round(score)}，达到围标预警线 ${threshold}，属围标/串标风险提示。`,
      })
    }
  }
  return { blocked: findings.length > 0, findings }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 归一化：去空白、标点、全角转半角，便于跨排版比较。 */
function normalizeForCompare(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[^\p{Script=Han}a-z0-9]/gu, '')
}

/** 切成 n-gram（按字符，不按词，中文无需分词）。 */
function shingles(text, n) {
  const out = []
  if (text.length < n) return text.length === 0 ? [] : [text]
  for (let index = 0; index + n <= text.length; index += 1) out.push(text.slice(index, index + n))
  return out
}

/** FNV-1a 64 位哈希。 */
function fnv1a64(text) {
  const PRIME = 1099511628211n
  const OFFSET = 14695981039346656037n
  let hash = OFFSET
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * PRIME) & 0xffffffffffffffffn
  }
  return hash
}

function round(value) {
  return Math.round(value * 1000) / 1000
}
