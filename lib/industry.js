/**
 * 行业骨架加载与匹配（吸收 BiaoShu-SKILL 的 8 行业分类，Apache-2.0）。
 *
 * 检测法为 keyword_matching，置信阈值 0.3，回退 general——与原数据一致。
 * 只吸收数据（行业名与关键词），不引入其 Python 运行时。
 *
 * @module lib/industry
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const GUIDES_PATH = fileURLToPath(new URL('../data/industry-guides/industries.json', import.meta.url))

let cached

/**
 * 读取行业骨架库。
 * @returns {Promise<{industries: object, detection: object, attribution: object}>}
 */
export async function loadIndustries() {
  if (cached !== undefined) return cached
  const doc = JSON.parse(await readFile(GUIDES_PATH, 'utf8'))
  cached = doc
  return doc
}

/**
 * 按关键词匹配行业。
 *
 * 评分：命中关键词数 / 该行业关键词总数，取最高分；低于阈值回退 general。
 *
 * @param {string} text - 需求或招标文件正文。
 * @returns {Promise<{industry: string, label: string, confidence: number, matched: string[], fallback: boolean}>}
 */
export async function matchIndustry(text) {
  const doc = await loadIndustries()
  const detection = doc.detection ?? {}
  const threshold = typeof detection.confidence_threshold === 'number' ? detection.confidence_threshold : 0.3
  const fallbackIndustry = typeof detection.fallback_industry === 'string' ? detection.fallback_industry : 'general'
  const haystack = String(text ?? '').toLowerCase()

  let best = { industry: fallbackIndustry, confidence: 0, matched: [] }
  for (const [key, profile] of Object.entries(doc.industries ?? {})) {
    if (key === 'general') continue
    const keywords = Array.isArray(profile.keywords) ? profile.keywords : []
    if (keywords.length === 0) continue
    const matched = keywords.filter(keyword => haystack.includes(String(keyword).toLowerCase()))
    const confidence = matched.length / keywords.length
    if (confidence > best.confidence) {
      best = { industry: key, confidence, matched }
    }
  }

  const fallback = best.confidence < threshold
  const finalKey = fallback ? fallbackIndustry : best.industry
  const profile = doc.industries?.[finalKey] ?? {}
  return {
    industry: finalKey,
    label: profile.label ?? finalKey,
    confidence: Math.round(best.confidence * 1000) / 1000,
    matched: best.matched,
    fallback,
    note: fallback ? '行业骨架待补充，已回退通用结构。' : null,
  }
}

/**
 * 取某行业的章节骨架。
 * @param {string} industry
 * @returns {Promise<{label: string, sections: Array<{id: string, title: string, hint: string}>}>}
 */
export async function industryOutline(industry) {
  const doc = await loadIndustries()
  const profile = doc.industries?.[industry] ?? doc.industries?.general ?? {}
  return {
    label: profile.label ?? industry,
    sections: Array.isArray(profile.sections) ? profile.sections : [],
  }
}

/**
 * 返回归因信息（Apache-2.0 §4 要求保留）。
 * @returns {Promise<object>}
 */
export async function attribution() {
  const doc = await loadIndustries()
  return doc.attribution ?? {}
}

/** 测试用：清缓存。 */
export function resetIndustryCache() {
  cached = undefined
}
