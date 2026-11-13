/**
 * 运行时：把 store / guard / facts / workflow / kb 拼成一组与传输无关的操作。
 *
 * 工具层（tools.js）与未来的 UI 层共用同一个 runtime，因此 agent 与人的路径不会分叉。
 *
 * @module lib/runtime
 */

import { openStore } from './store.js'
import { checkClause, checkFactSource } from './guard.js'
import { setFact, verifyFact, markFactNotApplicable, unverifiedFacts, describeSourcePolicy } from './facts.js'
import {
  approveGate,
  canAdvance,
  createWorkflow,
  isGateApproved,
  verifyAuditChain,
  GATES,
  GATE_STATUS,
} from './workflow.js'
import { parseTender, draftSection, checkConsistency, extractSourceLabels } from './tender.js'
import {
  parseBidTender,
  planOutline,
  lockFacts,
  preExportCheck,
  pendingFactChecklist,
} from './bid.js'
import { buildDocx } from './docx.js'
import { bm25Search, chunk, collectDocuments, evaluateGate, indexNames, requestsSync, REFUSAL_TEXT, DEFAULT_TRIGGERS } from './kb.js'
import { checkSelfDuplication, checkCollusion, similarity } from './similarity.js'
import { matchIndustry, industryOutline, loadIndustries, attribution as industryAttribution } from './industry.js'

/**
 * 创建运行时。
 *
 * @param {object} options
 * @param {string} options.root - 数据根目录。
 * @param {boolean} [options.allowWrite]
 * @param {string} [options.kbDir]
 * @param {number} [options.selfDupThreshold]
 * @param {number} [options.collusionThreshold]
 * @param {(message: string, error?: unknown) => void} [options.log]
 */
export function createRuntime(options) {
  const store = openStore({ root: options.root, allowWrite: options.allowWrite })
  const log = options.log ?? (() => {})
  const selfDupThreshold = options.selfDupThreshold ?? 0.85
  const collusionThreshold = options.collusionThreshold ?? 0.65
  const kbDir = options.kbDir

  /** 会话级门控状态（进程内；粘性直至进程重启或显式关闭）。 */
  const sessionGate = { enabled: false }

  /** 已注册的工具数与名称，由 tools.js 注册完成后回填（避免硬编码数字漂移）。 */
  let toolCount = 0
  let toolNames = []

  function reportTools(names) {
    toolNames = [...names]
    toolCount = toolNames.length
  }

  /** KB 索引缓存。 */
  let kbIndex = null
  let kbIndexAt = 0

  /**
   * 读取项目及其工作流状态。工作流状态存在 project.json 的 gateStates/gateRecords 中。
   * @param {string} projectId
   */
  async function loadProjectWithWorkflow(projectId) {
    const project = await store.readProject(projectId)
    if (project.workflow === undefined || project.workflow === null) {
      project.workflow = createWorkflow({ kind: project.kind, subjectId: project.id })
    }
    return project
  }

  /** 保存项目的工作流状态。 */
  async function saveWorkflow(projectId, project) {
    await store.updateProject(projectId, {
      workflow: project.workflow,
      gateRecords: project.workflow.gateRecords,
    })
  }

  // -------------------------------------------------------------------------
  // 项目
  // -------------------------------------------------------------------------

  async function createProject(input) {
    const project = await store.createProject(input)
    project.workflow = createWorkflow({ kind: project.kind, subjectId: project.id })
    await store.updateProject(project.id, { workflow: project.workflow })
    if (typeof input?.tenderText === 'string' && input.tenderText.length > 0) {
      await store.writeTenderSource(project.id, input.tenderText)
    }
    return { ok: true, project: publicProject(project) }
  }

  async function listProjects() {
    return { ok: true, projects: await store.listProjects() }
  }

  async function projectStatus(projectId) {
    const project = await loadProjectWithWorkflow(projectId)
    const sections = await store.listSections(projectId)
    const unverified = unverifiedFacts(project)
    return {
      ok: true,
      project: publicProject(project),
      sections,
      sectionCount: sections.length,
      facts: {
        total: (project.facts ?? []).length,
        verified: (project.facts ?? []).filter(fact => fact.status === 'VERIFIED').length,
        unverified: unverified.map(fact => ({ key: fact.key, label: fact.category })),
      },
      gates: project.workflow.gates,
      auditChain: {
        records: project.workflow.gateRecords.length,
        ...verifyAuditChain(project.workflow.gateRecords),
      },
      canExport: unverified.length === 0
        && isGateApproved(project.workflow, 'gate2')
        && isGateApproved(project.workflow, 'gate3'),
    }
  }

  function publicProject(project) {
    return {
      id: project.id,
      name: project.name,
      kind: project.kind,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      factsLocked: project.factsLocked === true,
      exports: project.exports ?? [],
    }
  }

  // -------------------------------------------------------------------------
  // 合规内核
  // -------------------------------------------------------------------------

  async function guardCheckClause(text, options = {}) {
    const verdict = await checkClause(text, options)
    return { ok: true, ...verdict }
  }

  async function guardVerifyFact(projectId, input) {
    const project = await loadProjectWithWorkflow(projectId)
    if (input?.key === undefined) {
      // 无 key：返回当前事实清单
      return {
        ok: true,
        action: 'list',
        facts: project.facts ?? [],
        unverified: unverifiedFacts(project),
        blocked: unverifiedFacts(project).length > 0,
      }
    }
    if (input?.action === 'not_applicable') {
      const result = markFactNotApplicable(project, String(input.key), String(input.reason ?? ''))
      await store.updateProject(projectId, { facts: project.facts })
      return { ok: true, action: 'not_applicable', fact: result.fact }
    }
    if (input?.operator === undefined) {
      // 无操作人：这是写入事实（不是核验）
      const result = setFact(project, input)
      await store.updateProject(projectId, { facts: project.facts })
      return { ok: true, action: 'set', fact: result.fact }
    }
    const result = verifyFact(project, String(input.key), input)
    await store.updateProject(projectId, { facts: project.facts })
    return { ok: true, action: 'verify', fact: result.fact }
  }

  async function guardSimilarityCheck(input) {
    const text = String(input?.text ?? '')
    const selfDup = checkSelfDuplication(text, input?.templateSources ?? [], {
      threshold: input?.selfDupThreshold ?? selfDupThreshold,
    })
    const collusion = checkCollusion(text, input?.otherBidders ?? [], {
      threshold: input?.collusionThreshold ?? collusionThreshold,
    })
    return {
      ok: true,
      selfDuplication: selfDup,
      collusion,
      thresholds: {
        selfDup: input?.selfDupThreshold ?? selfDupThreshold,
        collusion: input?.collusionThreshold ?? collusionThreshold,
      },
      note: '两条规则独立：自我复制比的是自身模板复用，围标相似度比的是不同投标人之间。不可共用一个阈值。',
    }
  }

  // -------------------------------------------------------------------------
  // 招标侧
  // -------------------------------------------------------------------------

  async function tenderParse(input) {
    const text = String(input?.text ?? '')
    const parsed = await parseTender(text)
    if (typeof input?.projectId === 'string' && input.projectId.length > 0) {
      const project = await loadProjectWithWorkflow(input.projectId)
      await store.writeTenderSource(input.projectId, text)
      await store.updateProject(input.projectId, {
        requirements: parsed.requirements,
        industry: parsed.industry,
      })
      project.workflow.kind = 'tender'
      await saveWorkflow(input.projectId, project)
      parsed.savedTo = input.projectId
    }
    return parsed
  }

  async function tenderMatchIndustry(text) {
    const industry = await matchIndustry(String(text ?? ''))
    const outline = await industryOutline(industry.industry)
    const doc = await loadIndustries()
    return {
      ok: true,
      industry,
      outline,
      availableIndustries: Object.entries(doc.industries ?? {}).map(([key, profile]) => ({
        key,
        label: profile.label,
      })),
    }
  }

  async function tenderDraftSection(input) {
    const drafts = await draftSection(input)
    if (typeof input?.projectId === 'string' && drafts.generated === true) {
      await store.writeSection(input.projectId, String(input.sectionId), String(drafts.content ?? ''))
    }
    return drafts
  }

  async function tenderCheckConsistency(projectIdOrSections) {
    let sections = projectIdOrSections?.sections
    if (projectIdOrSections?.projectId !== undefined) {
      const ids = await store.listSections(String(projectIdOrSections.projectId))
      sections = []
      for (const id of ids) {
        sections.push({ sectionId: id, content: await store.readSection(String(projectIdOrSections.projectId), id) })
      }
    }
    const result = checkConsistency(sections ?? [])
    return { ok: true, ...result, sectionCount: (sections ?? []).length }
  }

  // -------------------------------------------------------------------------
  // 投标侧
  // -------------------------------------------------------------------------

  async function bidParse(input) {
    const text = String(input?.text ?? '')
    const parsed = parseBidTender(text)
    if (typeof input?.projectId === 'string' && input.projectId.length > 0) {
      await store.writeTenderSource(input.projectId, text)
      await store.updateProject(input.projectId, { bidParse: parsed })
    }
    return parsed
  }

  async function bidOutline(input) {
    const parseResult = input?.parseResult ?? (input?.text === undefined ? undefined : parseBidTender(String(input.text)))
    if (parseResult === undefined) {
      throw new Error('需要 parseResult 或 text 之一。')
    }
    const outline = planOutline(parseResult, { targetWords: input?.targetWords })
    if (typeof input?.projectId === 'string' && input.projectId.length > 0) {
      await store.updateProject(input.projectId, { outline })
    }
    return { ok: true, ...outline }
  }

  async function bidWriteSection(input) {
    const projectId = String(input?.projectId ?? '')
    const sectionId = String(input?.sectionId ?? '')
    const result = await store.writeSection(projectId, sectionId, String(input?.content ?? ''), {
      append: input?.append === true,
    })
    return {
      ok: true,
      ...result,
      sourceLabels: extractSourceLabels(String(input?.content ?? '')),
      next: '继续写下一节，或调用 mont_bid_lock_facts 锁定事实。',
    }
  }

  async function bidLockFacts(projectId) {
    const project = await loadProjectWithWorkflow(projectId)
    const result = lockFacts(project)
    await store.updateProject(projectId, { facts: project.facts, factsLocked: true, factsLockedAt: project.factsLockedAt })
    return result
  }

  async function bidExport(input) {
    const projectId = String(input?.projectId ?? '')
    const project = await loadProjectWithWorkflow(projectId)
    const ids = await store.listSections(projectId)

    const sections = []
    for (const id of ids) {
      sections.push({ title: id, content: await store.readSection(projectId, id) })
    }
    const text = sections.map(section => section.content).join('\n\n')

    // 前置检查：任一不过即拒绝导出。
    const check = preExportCheck({
      project,
      text,
      workflow: project.workflow,
      templateSources: input?.templateSources,
      otherBidders: input?.otherBidders,
      thresholds: {
        selfDupThreshold: input?.selfDupThreshold ?? selfDupThreshold,
        collusionThreshold: input?.collusionThreshold ?? collusionThreshold,
      },
    })

    if (!check.canExport) {
      return {
        ok: true,
        exported: false,
        blockers: check.blockers,
        checks: check.checks,
        guidance: '导出被阻断。请先解决 blockers 列出的问题：核验事实 → 门2 → 门3 → 雷同改写。',
      }
    }

    const fileName = String(input?.fileName ?? `${projectId}-draft.docx`)
    const buffer = buildDocx({
      title: String(input?.title ?? project.name),
      author: 'mont-BidCopilot',
      sections,
      footerNote: '本文档由 mont-BidCopilot 生成，属草案。事实字段已核验、门2/门3 已签署；最终法律责任由使用者承担。',
    })
    const written = await store.writeExport(projectId, fileName, buffer)
    const exports = Array.isArray(project.exports) ? project.exports : []
    exports.push({ fileName, ...written, exportedAt: new Date().toISOString() })
    await store.updateProject(projectId, { exports })

    return {
      ok: true,
      exported: true,
      path: written.path,
      bytes: written.bytes,
      checks: check.checks,
      sections: sections.length,
    }
  }

  async function bidPendingChecklist(input) {
    return pendingFactChecklist({ includePolicy: input?.includePolicy === true })
  }

  // -------------------------------------------------------------------------
  // 知识检索（显式门控）
  // -------------------------------------------------------------------------

  async function kbBuildIndex() {
    if (kbDir === undefined) {
      return { ok: false, error: { code: 'E_KB_DIR_UNSET', message: '未配置 kbDir，无法建立索引。' } }
    }
    const documents = await collectDocuments(kbDir)
    const chunks = []
    for (const doc of documents) {
      for (const piece of chunk(doc.text)) {
        chunks.push({ docId: `${doc.relative}#${piece.index}`, text: piece.text, path: doc.relative })
      }
    }
    kbIndex = { documents, chunks }
    kbIndexAt = Date.now()
    const names = indexNames(documents)
    log(`kb index built: ${documents.length} docs, ${chunks.length} chunks`)
    return {
      ok: true,
      documents: documents.length,
      chunks: chunks.length,
      names: names.names.length,
      dirs: names.dirs.length,
      indexedAt: new Date(kbIndexAt).toISOString(),
    }
  }

  /**
   * 知识检索。**门控 fail-closed**：未点名且未显式声明即拒绝。
   */
  async function kbSearch(input) {
    const userText = String(input?.userText ?? '')
    let names = []
    if (kbIndex !== null) names = indexNames(kbIndex.documents).names

    const gate = evaluateGate({
      userText,
      previouslyEnabled: sessionGate.enabled,
      explicit: input?.explicit === true,
      names,
      triggers: Array.isArray(input?.triggers) ? input.triggers : DEFAULT_TRIGGERS,
    })

    if (!gate.allowed) {
      return {
        ok: false,
        gated: true,
        code: 'E_KB_NOT_REQUESTED',
        message: REFUSAL_TEXT,
        hint: '如果用户确实点名要查知识库，请在 userText 中带上用户原话，或显式传 explicit: true。',
      }
    }

    sessionGate.enabled = true

    // 需要同步时先重建索引。
    if (input?.sync === true || requestsSync(userText)) {
      const rebuilt = await kbBuildIndex()
      if (rebuilt.ok !== true) return rebuilt
    } else if (kbIndex === null) {
      const rebuilt = await kbBuildIndex()
      if (rebuilt.ok !== true) return rebuilt
    }

    const query = String(input?.query ?? '')
    if (query.trim().length === 0) {
      return { ok: false, error: { code: 'E_QUERY_REQUIRED', message: 'query 不能为空。' } }
    }
    const results = bm25Search(kbIndex.chunks, query, { limit: input?.limit ?? 10 })
    return {
      ok: true,
      query,
      results,
      total: kbIndex.chunks.length,
      gated: false,
    }
  }

  // -------------------------------------------------------------------------
  // 工作流推进（不含 approve）
  // -------------------------------------------------------------------------

  async function wfAdvance(input) {
    const projectId = String(input?.projectId ?? '')
    const gateId = String(input?.gateId ?? '')
    const action = String(input?.action ?? 'status')

    // 硬拒：模型无批准通道。
    if (action === 'approve' || action === 'reject' || action === 'sign') {
      return {
        ok: false,
        code: 'E_GATE_MODEL_APPROVAL_FORBIDDEN',
        message: '门禁批准/拒绝只能由 Host 侧 UI 通道发起。模型 agent 无 approve/reject 通道，本工具不提供该能力。',
        guidance: '请在界面的门禁面板中确认；如需程序化签署，请由宿主侧调用 runtime.approveGate。',
      }
    }

    const project = await loadProjectWithWorkflow(projectId)

    if (action === 'status') {
      return {
        ok: true,
        action: 'status',
        gates: project.workflow.gates,
        gateDefinitions: GATES,
        gateStatusValues: GATE_STATUS,
        auditChain: {
          records: project.workflow.gateRecords,
          ...verifyAuditChain(project.workflow.gateRecords),
        },
        frozen: project.workflow.frozen === true,
      }
    }

    if (action === 'check') {
      const verdict = canAdvance(project.workflow, gateId)
      return { ok: true, action: 'check', gateId, ...verdict }
    }

    return {
      ok: false,
      error: { code: 'E_ACTION_INVALID', message: `未知 action：${action}。允许：status / check。` },
    }
  }

  /**
   * Host 侧门禁决策入口（**不注册为工具**，只供 UI/Host 调用）。
   * credential 必须由 Host 侧构造，形如 { channel: 'host-ui' }。
   */
  async function approveGateFromHost(projectId, input) {
    const project = await loadProjectWithWorkflow(projectId)
    const result = approveGate(project.workflow, input)
    if (result.ok) await saveWorkflow(projectId, project)
    return result
  }

  // -------------------------------------------------------------------------
  // 杂项
  // -------------------------------------------------------------------------

  async function ping() {
    return {
      ok: true,
      name: 'mont-BidCopilot',
      version: '0.1.0',
      dshEngineRange: '>=0.2.2-rc.1',
      storageRoot: store.root,
      allowWrite: store.allowWrite,
      thresholds: { selfDup: selfDupThreshold, collusion: collusionThreshold },
      toolCount: toolCount,
      tools: toolNames,
      notice: 'mont-BidCopilot 已加载。它只在你点名检索时读取企业资料目录，并生成文件到数据目录。它不做自动更新，也不在安装时执行脚本。完整权限清单见 SECURITY.md。',
    }
  }

  function sourcePolicy() {
    return { ok: true, policy: describeSourcePolicy() }
  }

  return {
    store,
    log,
    kbDir,
    selfDupThreshold,
    collusionThreshold,
    // 项目
    createProject,
    listProjects,
    projectStatus,
    // 合规
    guardCheckClause,
    guardVerifyFact,
    guardSimilarityCheck,
    sourcePolicy,
    // 招标侧
    tenderParse,
    tenderMatchIndustry,
    tenderDraftSection,
    tenderCheckConsistency,
    // 投标侧
    bidParse,
    bidOutline,
    bidWriteSection,
    bidLockFacts,
    bidExport,
    bidPendingChecklist,
    // 知识
    kbBuildIndex,
    kbSearch,
    // 工作流
    wfAdvance,
    approveGateFromHost,
    // 杂项
    ping,
    reportTools,
    // 直接透出给测试
    checkFactSource,
    checkClause,
    similarity,
    industryAttribution,
    loadIndustries,
  }
}
