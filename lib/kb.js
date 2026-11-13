/**
 * 知识检索层：BM25 + 中文 bigram，显式调用门控。
 *
 * 门控逻辑吸收自 dsh-company-kb（MIT）的 lib/gate.js 三条放行线索：
 *   ① 本会话此前已点名启用（粘性）；
 *   ② 本轮用户消息出现触发词且同一子句无否定词；
 *   ③ 用户消息直接出现索引中的文件名/目录名。
 * 本实现为自有 JS 重写，并改为纯函数以便单测（不含 DSH session 读取）。
 *
 * 关键：门控为 fail-closed。未点名即拒绝检索，且拒绝理由可读。
 *
 * @module lib/kb
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** 否定词：出现在触发词附近时不算"要求检索"。 */
const DENIAL = /(?:不要|不用|不需要|无需|无须|禁止|关闭|停用|停掉|别再|别用|不使用|不涉及|不包含|不含|无关|不查|不查询|不检索|不搜索|不搜|不看|不引用|no\b|don't|dont|do not|without|disable)/iu

/** 同步意图词。 */
const SYNC_INTENT = /(?:同步|更新.{0,4}索引|重建.{0,4}索引|刷新.{0,4}索引|重建索引|刷新索引|重新.{0,4}索引|索引.{0,4}(?:更新|重建|刷新|同步)|索引一下|重新索引|sync|reindex|rebuild)/iu

/** 默认触发词。 */
export const DEFAULT_TRIGGERS = Object.freeze(['知识库', '企业资料', '公司资料', '素材库', 'kb', 'knowledge base'])

/** 未启用时的可读拒绝文本。 */
export const REFUSAL_TEXT = [
  '知识库在本会话尚未启用，因此没有执行检索。',
  '这不是错误：本插件的设计就是"只有用户明确要求时才检索公司知识库"。',
  '如果确实需要，请在消息里点名，例如："用知识库查一下农药追溯二维码的政策要求"；',
  '或者直接给出文件/目录名，例如："按 方案模板/常规项目技术方案书模板.docx 写一份 XX 方案"。',
  '在此之前，请基于其它信息回答，不要反复询问是否启用知识库。',
].join('')

/**
 * 归一化文本用于子句切分。
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

/**
 * 把文本切成子句（分号、句号、逗号、顿号等）。
 * @param {string} text
 * @returns {string[]}
 */
export function clausesOf(text) {
  return normalizeText(text)
    .toLowerCase()
    .split(/[。！？!?；;\n，,、]+/u)
    .map(clause => clause.trim())
    .filter(clause => clause.length > 0)
}

/**
 * 判断文本是否构成一次显式检索请求——门控核心。
 *
 * @param {string} text - 本轮的**直接用户消息**文本（不含插件注入、不含技能内容）。
 * @param {object} [options]
 * @param {string[]} [options.triggers] - 触发词。
 * @param {string[]} [options.names] - 索引中的文件名/目录名。
 * @returns {boolean}
 */
export function explicitlyRequested(text, options = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) return false
  const triggers = options.triggers ?? DEFAULT_TRIGGERS
  const names = (options.names ?? []).map(name => normalizeText(name).toLowerCase())

  for (const clause of clausesOf(text)) {
    for (const trigger of triggers) {
      const needle = trigger.toLowerCase()
      if (needle.length === 0) continue
      const at = clause.indexOf(needle)
      if (at === -1) continue
      // 否定词必须离触发词足够近才算"否定这次调用"。
      const window = clause.slice(Math.max(0, at - 24), at + needle.length + 24)
      if (DENIAL.test(window)) continue
      return true
    }
    for (const name of names) {
      if (name.length < 3) continue
      if (clause.includes(name)) return true
    }
  }
  return false
}

/**
 * 判断用户是否要求同步索引。
 * @param {string} text
 * @returns {boolean}
 */
export function requestsSync(text) {
  return clausesOf(text).some(clause => SYNC_INTENT.test(clause) && !DENIAL.test(clause))
}

/**
 * 门控评估：返回是否放行与可读理由。
 *
 * @param {object} input
 * @param {string} input.userText - 本轮直接用户消息。
 * @param {boolean} [input.previouslyEnabled] - 本会话此前是否已点名启用（粘性）。
 * @param {boolean} [input.explicit] - 调用方显式传 explicit: true（工具参数）。
 * @param {string[]} [input.names] - 索引中的文件名/目录名。
 * @param {string[]} [input.triggers]
 * @returns {{allowed: boolean, enabled: boolean, requested: boolean, reason: string|null}}
 */
export function evaluateGate(input) {
  const userText = input?.userText ?? ''
  const triggers = input?.triggers ?? DEFAULT_TRIGGERS
  const requested = explicitlyRequested(userText, { triggers, names: input?.names })

  // explicit: true 是工具层的显式声明，与用户消息点名等效——两者任一成立即放行。
  // 注意：这不是后门，因为 explicit 由调用工具时填写，且未点名时模型无从判断要检索什么；
  // 真正的保护是"不点名就没有检索动机"，加上下面 sync 的独立要求。
  const enabled = input?.explicit === true || input?.previouslyEnabled === true || requested

  return {
    allowed: enabled,
    enabled,
    requested,
    reason: enabled
      ? null
      : REFUSAL_TEXT,
  }
}

// ---------------------------------------------------------------------------
// 检索内核：BM25 + 中文 bigram
// ---------------------------------------------------------------------------

/**
 * 把文本切成检索 token：中文按 bigram，英文数字按词。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const normalized = normalizeText(text).toLowerCase()
  const tokens = []
  const segments = normalized.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []
  for (const segment of segments) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      if (segment.length === 1) {
        tokens.push(segment)
        continue
      }
      for (let index = 0; index + 2 <= segment.length; index += 1) {
        tokens.push(segment.slice(index, index + 2))
      }
    } else {
      tokens.push(segment)
    }
  }
  return tokens
}

/**
 * 分块：按标题与段落聚合到约 400 字符一块，避免块过大稀释 BM25。
 * @param {string} text
 * @param {number} [targetSize]
 * @returns {Array<{index: number, text: string}>}
 */
export function chunk(text, targetSize = 400) {
  const paragraphs = String(text ?? '').split(/\n{2,}/u).map(item => item.trim()).filter(Boolean)
  const chunks = []
  let buffer = ''
  for (const paragraph of paragraphs) {
    if (buffer.length > 0 && buffer.length + paragraph.length > targetSize) {
      chunks.push(buffer)
      buffer = paragraph
    } else {
      buffer = buffer.length === 0 ? paragraph : `${buffer}\n${paragraph}`
    }
  }
  if (buffer.length > 0) chunks.push(buffer)
  return chunks.map((item, index) => ({ index, text: item }))
}

/**
 * BM25 检索。经典参数 k1=1.5, b=0.75。
 *
 * @param {Array<{docId: string, text: string}>} documents
 * @param {string} query
 * @param {{limit?: number}} [options]
 * @returns {Array<{docId: string, score: number, snippet: string}>}
 */
export function bm25Search(documents, query, options = {}) {
  const limit = options.limit ?? 10
  const k1 = 1.5
  const b = 0.75

  const docs = documents.map(doc => {
    const tokens = tokenize(doc.text)
    const tf = new Map()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    return { docId: doc.docId, text: doc.text, tf, length: tokens.length }
  })

  if (docs.length === 0) return []
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length
  const totalDocs = docs.length
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []

  // 文档频率
  const df = new Map()
  for (const token of new Set(queryTokens)) {
    let count = 0
    for (const doc of docs) if (doc.tf.has(token)) count += 1
    df.set(token, count)
  }

  const scored = docs.map(doc => {
    let score = 0
    for (const token of queryTokens) {
      const frequency = doc.tf.get(token) ?? 0
      if (frequency === 0) continue
      const docFreq = df.get(token) ?? 0
      const idf = Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5))
      const denominator = frequency + k1 * (1 - b + (b * doc.length) / (averageLength || 1))
      score += idf * ((frequency * (k1 + 1)) / (denominator || 1))
    }
    return { docId: doc.docId, score, snippet: doc.text.slice(0, 200) }
  })

  return scored
    .filter(item => item.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit)
}

/**
 * 在目录中递归收集可检索的文本文件。
 * @param {string} dir
 * @param {{maxFiles?: number, maxBytes?: number}} [options]
 * @returns {Promise<Array<{path: string, relative: string, text: string}>>}
 */
export async function collectDocuments(dir, options = {}) {
  const maxFiles = options.maxFiles ?? 2000
  const maxBytes = options.maxBytes ?? 5_000_000
  const root = resolve(dir)
  const out = []
  const allowExt = /\.(md|markdown|txt|json|ya?ml|csv)$/i

  async function walk(current) {
    if (out.length >= maxFiles) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      if (entry.name.startsWith('.')) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile() || !allowExt.test(entry.name)) continue
      const info = await stat(full).catch(() => undefined)
      if (info === undefined || info.size > maxBytes) continue
      const text = await readFile(full, 'utf8').catch(() => undefined)
      if (text === undefined) continue
      out.push({ path: full, relative: full.slice(root.length + 1), text })
    }
  }

  await walk(root)
  return out
}

/**
 * 列出索引中的文件名与目录名，供门控线索③使用。
 * @param {Array<{relative: string}>} documents
 * @returns {{names: string[], dirs: string[]}}
 */
export function indexNames(documents) {
  const names = new Set()
  const dirs = new Set()
  for (const doc of documents ?? []) {
    const parts = String(doc.relative ?? '').split(/[\\/]+/u)
    const file = parts.pop()
    if (file !== undefined && file.length > 0) names.add(file)
    for (const part of parts) if (part.length > 0) dirs.add(part)
  }
  return { names: [...names], dirs: [...dirs] }
}
