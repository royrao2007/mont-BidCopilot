/**
 * 项目存储层：一个项目一个目录，纯文件系统，无数据库。
 *
 * 目录结构：
 *   <dataDir>/<projectId>/project.json      索引（需求、目录、事实、门禁、导出记录）
 *   <dataDir>/<projectId>/sections/<id>.md  正文，一节一文件（长度只受磁盘限制）
 *   <dataDir>/<projectId>/tender/source.md  招标文件原文
 *   <dataDir>/<projectId>/exports/*.docx    导出物
 *
 * 所有写入为「临时文件 + rename」原子写，中断后可从磁盘继续。
 *
 * @module lib/store
 */

import { mkdir, readFile, rename, writeFile, readdir, stat, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 存储层错误：带稳定 code，供工具层映射。 */
export class StoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

/** 项目 id 允许的字符。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 打开（必要时创建）一个项目存储根。
 * @param {{root: string, allowWrite?: boolean}} options
 */
export function openStore(options) {
  const root = resolve(options.root)
  const allowWrite = options.allowWrite !== false

  /** 断言可写；只读模式下所有写操作立刻失败。 */
  function assertWritable() {
    if (!allowWrite) throw new StoreError('E_READONLY', '当前为只读模式（allowWrite: false），写操作被拒绝。')
  }

  /** 校验项目 id，防止路径穿越。 */
  function assertId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new StoreError('E_BAD_ID', `项目 id 非法：${String(id)}（只允许字母数字与 . _ -，最长 64）`)
    }
    return id
  }

  /** 解析并确认路径落在 root 之内。 */
  function safeJoin(id, ...rest) {
    const target = resolve(root, assertId(id), ...rest)
    if (target !== resolve(root, id) && !target.startsWith(resolve(root, id) + sep)) {
      throw new StoreError('E_PATH_ESCAPE', '路径越界，已拒绝。')
    }
    return target
  }

  async function ensureDir(path) {
    await mkdir(path, { recursive: true })
  }

  /** 原子写：先写 .tmp 再 rename。 */
  async function atomicWrite(path, content) {
    const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  }

  /**
   * 从项目名派生 id。
   * @param {string} name
   * @returns {string}
   */
  function deriveId(name) {
    const ascii = String(name ?? '')
      .normalize('NFKD')
      .replace(/[^\w.-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
    const suffix = randomUUID().slice(0, 6)
    return ascii.length > 0 ? `${ascii}-${suffix}` : `project-${suffix}`
  }

  /**
   * 创建项目。
   * @param {{name: string, id?: string, kind?: 'tender'|'bid'}} input
   * @returns {Promise<object>} project 索引对象
   */
  async function createProject(input) {
    assertWritable()
    const name = String(input?.name ?? '').trim()
    if (name.length === 0) throw new StoreError('E_NAME_REQUIRED', '项目名称不能为空。')
    const id = input?.id === undefined ? deriveId(name) : assertId(input.id)
    const dir = resolve(root, id)
    const exists = await stat(dir).then(() => true, () => false)
    if (exists) throw new StoreError('E_PROJECT_EXISTS', `项目 ${id} 已存在。`)

    const now = new Date().toISOString()
    const project = {
      id,
      name,
      kind: input?.kind === 'bid' ? 'bid' : 'tender',
      createdAt: now,
      updatedAt: now,
      requirements: null,
      industry: null,
      sections: [],
      facts: [],
      citations: [],
      gateRecords: [],
      gateStates: null,
      reviews: [],
      exports: [],
      schemaVersion: 1,
    }
    await ensureDir(dir)
    await ensureDir(join(dir, 'sections'))
    await atomicWrite(join(dir, 'project.json'), JSON.stringify(project, null, 2))
    return project
  }

  /**
   * 读取项目。
   * @param {string} id
   * @returns {Promise<object>}
   */
  async function readProject(id) {
    const path = safeJoin(id, 'project.json')
    const raw = await readFile(path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') throw new StoreError('E_PROJECT_NOT_FOUND', `项目 ${id} 不存在。`)
      throw error
    })
    return JSON.parse(raw)
  }

  /**
   * 写回项目索引（只允许改数据字段，id/createdAt 保持不变）。
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object>}
   */
  async function updateProject(id, patch) {
    assertWritable()
    const current = await readProject(id)
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() }
    await atomicWrite(safeJoin(id, 'project.json'), JSON.stringify(next, null, 2))
    return next
  }

  /**
   * 写入一节正文（文件名由 sectionId 决定）。
   * @param {string} id
   * @param {string} sectionId
   * @param {string} content
   * @param {{append?: boolean}} [options]
   * @returns {Promise<{path: string, bytes: number, chars: number}>}
   */
  async function writeSection(id, sectionId, content, options = {}) {
    assertWritable()
    if (typeof sectionId !== 'string' || !ID_PATTERN.test(sectionId)) {
      throw new StoreError('E_BAD_SECTION_ID', `章节 id 非法：${String(sectionId)}`)
    }
    const path = safeJoin(id, 'sections', `${sectionId}.md`)
    const text = String(content ?? '')
    const finalText = options.append === true
      ? await readFile(path, 'utf8').then(existing => `${existing}${text}`, () => text)
      : text
    await atomicWrite(path, finalText)
    return { path, bytes: Buffer.byteLength(finalText, 'utf8'), chars: finalText.length }
  }

  /**
   * 读取一节正文。
   * @param {string} id
   * @param {string} sectionId
   * @returns {Promise<string>}
   */
  async function readSection(id, sectionId) {
    return readFile(safeJoin(id, 'sections', `${sectionId}.md`), 'utf8').catch(error => {
      if (error.code === 'ENOENT') throw new StoreError('E_SECTION_NOT_FOUND', `章节 ${sectionId} 不存在。`)
      throw error
    })
  }

  /**
   * 列出所有章节 id。
   * @param {string} id
   * @returns {Promise<string[]>}
   */
  async function listSections(id) {
    const dir = safeJoin(id, 'sections')
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name.slice(0, -3))
      .sort()
  }

  /**
   * 写入招标文件原文。
   * @param {string} id
   * @param {string} text
   */
  async function writeTenderSource(id, text) {
    assertWritable()
    const dir = safeJoin(id, 'tender')
    await ensureDir(dir)
    await atomicWrite(join(dir, 'source.md'), String(text ?? ''))
  }

  /**
   * 读取招标文件原文。
   * @param {string} id
   * @returns {Promise<string>}
   */
  async function readTenderSource(id) {
    return readFile(safeJoin(id, 'tender', 'source.md'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') throw new StoreError('E_TENDER_SOURCE_MISSING', '尚未导入招标文件原文。')
      throw error
    })
  }

  /**
   * 写入导出文件（二进制）。
   * @param {string} id
   * @param {string} fileName
   * @param {Buffer|Uint8Array} bytes
   * @returns {Promise<{path: string, bytes: number}>}
   */
  async function writeExport(id, fileName, bytes) {
    assertWritable()
    if (typeof fileName !== 'string' || !/^[A-Za-z0-9._-]+\.docx$/i.test(fileName)) {
      throw new StoreError('E_BAD_EXPORT_NAME', `导出文件名非法：${String(fileName)}`)
    }
    const dir = safeJoin(id, 'exports')
    await ensureDir(dir)
    const path = join(dir, fileName)
    const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`
    await writeFile(tmp, bytes)
    await rename(tmp, path)
    return { path, bytes: bytes.length }
  }

  /**
   * 列出全部项目。
   * @returns {Promise<Array<{id: string, name: string, kind: string, updatedAt: string}>>}
   */
  async function listProjects() {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const out = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const raw = await readFile(join(root, entry.name, 'project.json'), 'utf8').catch(() => undefined)
      if (raw === undefined) continue
      try {
        const project = JSON.parse(raw)
        out.push({ id: project.id, name: project.name, kind: project.kind, updatedAt: project.updatedAt })
      } catch {
        // 损坏的项目索引跳过，不阻断列表。
      }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  /**
   * 删除项目目录（用于测试清理）。
   * @param {string} id
   */
  async function removeProject(id) {
    assertWritable()
    await rm(resolve(root, assertId(id)), { recursive: true, force: true })
  }

  /** 确保根目录存在。 */
  async function ready() {
    await ensureDir(root)
    return root
  }

  return {
    root,
    allowWrite,
    ready,
    createProject,
    readProject,
    updateProject,
    writeSection,
    readSection,
    listSections,
    writeTenderSource,
    readTenderSource,
    writeExport,
    listProjects,
    removeProject,
    deriveId,
  }
}
