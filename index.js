/**
 * Host 半边：装配器。
 *
 * 装配顺序（合规内核最先、失败即整体拒绝启动）：
 *   1. 合规内核（guard）—— 预热规则库，失败即 throw，不降级
 *   2. 工作流引擎（workflow）—— 校验三门定义与审计链函数
 *   3. 存储与运行时
 *   4. mont_* 工具注册（每个 try-catch，单个失败不阻断其余）
 *
 * 合规内核或工作流引擎注册失败时**整体拒绝启动**——合规不能降级。
 * 这与原方案 §8.2「引擎不可用就禁用流水线」冲突，本实现取 §4.2 的更严格口径。
 *
 * @module index
 */

import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { loadRules } from './lib/guard.js'
import { GATES, createWorkflow, subjectDigest, verifyAuditChain, recordHash } from './lib/workflow.js'
import { createRuntime } from './lib/runtime.js'
import { registerTools } from './lib/tools.js'

/** Cordis 插件名。 */
export const name = 'dsh-mont-bidcopilot'

/** 依赖的宿主服务。 */
export const inject = ['tools']

/**
 * 配置 schema。
 *
 * Loader 读取的是 **Standard Schema 规范**的入口 `schema['~standard'].validate(...)`，
 * 不是 `schema.validate(...)`。写成普通对象会抛
 * "Cannot read properties of undefined (reading 'validate')" 并让插件 fiber 进入 failed。
 * （本机实测：schemastery 的 schema 实例上 `schema.validate` 为 undefined，
 *   而 `schema['~standard'].validate({})` 正常返回 `{ value: {...} }`、非法输入返回 `{ issues: [...] }`。）
 *
 * 为守住"运行时零第三方依赖"的披露承诺：宿主提供 `@deepseek-ai/schemastery` 时用它构造真 schema；
 * 取不到时用等价的最小 Standard Schema 实现（补默认值 + 类型校验 + 丢弃未知键）。
 */
function buildConfigSchema() {
  const specs = [
    ['dataDir', 'string', ''],
    ['allowWrite', 'boolean', true],
    ['selfDupThreshold', 'number', 0.85],
    ['collusionThreshold', 'number', 0.65],
    ['kbDir', 'string', ''],
  ]

  /** 按 specs 归一化并校验；返回 { value } 或 { issues }。 */
  function validate(value) {
    const input = value === null || value === undefined ? {} : value
    if (typeof input !== 'object') {
      return { issues: [{ message: '配置应为对象' }] }
    }
    const out = {}
    const issues = []
    for (const [key, type, fallback] of specs) {
      const raw = input[key]
      if (raw === undefined || raw === null) {
        out[key] = fallback
        continue
      }
      if (typeof raw !== type) {
        issues.push({ message: `$.${key} expected ${type} but got ${typeof raw}`, path: [key] })
        continue
      }
      out[key] = raw
    }
    return issues.length > 0 ? { issues } : { value: out }
  }

  // 尝试用宿主 schemastery 构造真 schema（给设置页提供完整元信息）。
  try {
    const S = hostSchemastery()
    if (S !== undefined) {
      const schema = S.object({
        dataDir: S.string().default('').description('项目数据目录。留空用 <DSH_HOME>/bidcopilot/projects。'),
        allowWrite: S.boolean().default(true).description('false 时所有写工具返回 E_READONLY。'),
        selfDupThreshold: S.number().default(0.85).description('自我复制相似度阈值。'),
        collusionThreshold: S.number().default(0.65).description('围标相似度阈值。'),
        kbDir: S.string().default('').description('企业资料目录，供 mont_kb_search 检索。'),
      })
      if (schema?.['~standard']?.validate !== undefined) return schema
    }
  } catch {
    // 取不到宿主库时走下面的等价实现。
  }

  return {
    ['~standard']: {
      version: 1,
      vendor: 'mont-bidcopilot',
      validate,
    },
  }
}

/**
 * 取宿主的 schemastery（同步 require）。
 * 用 createRequire 是因为本包为 ESM，而 schemastery 同时提供 cjs 入口。
 * @returns {object|undefined}
 */
function hostSchemastery() {
  try {
    const require = createRequire(import.meta.url)
    const mod = require('@deepseek-ai/schemastery')
    const S = mod?.default ?? mod
    return typeof S?.object === 'function' ? S : undefined
  } catch {
    return undefined
  }
}

/** Loader 读取的 Config：满足 Standard Schema 契约。 */
export const Config = buildConfigSchema()

/**
 * 把任意输入校验成可用配置。
 * @param {unknown} value
 * @returns {{ok: true, value: object} | {ok: false, issues: object[]}}
 */
export function validateConfig(value) {
  const result = Config['~standard'].validate(value)
  if (result.issues !== undefined) return { ok: false, issues: result.issues }
  return { ok: true, value: result.value }
}

/**
 * 解析数据目录。
 * @param {object} config
 * @returns {string}
 */
export function resolveDataDir(config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured.length > 0) return resolve(configured)
  const home = process.env.DSH_HOME ?? resolve(homedir(), '.dsh')
  return resolve(home, 'bidcopilot', 'projects')
}

/**
 * 校验合规内核可用性。**不可用即抛错**，让插件整体拒绝启动。
 * @returns {Promise<object>} 规则库
 */
export async function assertComplianceKernel() {
  let rules
  try {
    rules = await loadRules()
  } catch (error) {
    throw new Error(`[mont-BidCopilot] 合规内核加载失败，拒绝启动：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(rules.rules) || rules.rules.length === 0) {
    throw new Error('[mont-BidCopilot] 合规规则库为空，拒绝启动（合规不能降级）。')
  }
  const expected = ['T-B1', 'T-B2', 'T-B3', 'T-B4', 'T-B5']
  const present = new Set(rules.rules.map(rule => rule.id))
  const missing = expected.filter(id => !present.has(id))
  if (missing.length > 0) {
    throw new Error(`[mont-BidCopilot] 合规规则缺失 ${missing.join('、')}，拒绝启动（合规不能降级）。`)
  }
  for (const rule of rules.rules) {
    if (!Array.isArray(rule.compiled) || rule.compiled.length === 0) {
      throw new Error(`[mont-BidCopilot] 规则 ${rule.id} 无有效判定模式，拒绝启动。`)
    }
  }
  return rules
}

/**
 * 校验工作流引擎可用性。**不可用即抛错**。
 */
export function assertWorkflowEngine() {
  const required = ['gate1', 'gate2', 'gate3']
  for (const gateId of required) {
    if (GATES[gateId] === undefined) {
      throw new Error(`[mont-BidCopilot] 门禁定义缺失 ${gateId}，拒绝启动（合规不能降级）。`)
    }
  }
  // 自检审计链：空链有效、单条链可校验、篡改可被发现（含末尾记录）。
  const probe = createWorkflow({ kind: 'tender', subjectId: 'self-check' })
  if (verifyAuditChain(probe.gateRecords).valid !== true) {
    throw new Error('[mont-BidCopilot] 审计链自检失败，拒绝启动。')
  }
  const digest = subjectDigest({ probe: true })
  if (!digest.startsWith('sha256:')) {
    throw new Error('[mont-BidCopilot] 被审对象摘要计算异常，拒绝启动。')
  }
  const record = {
    seq: 1, gateId: 'gate1', decision: 'approve', operator: 'self',
    decidedAt: 'x', subjectDigest: digest, note: null, previousRecordHash: null,
  }
  record.hash = recordHash(record)
  if (verifyAuditChain([record]).valid !== true) {
    throw new Error('[mont-BidCopilot] 审计链哈希自检失败，拒绝启动。')
  }
  // 末尾记录被篡改也必须被发现（这正是自封签要拦的盲区）。
  if (verifyAuditChain([{ ...record, operator: 'tampered' }]).valid !== false) {
    throw new Error('[mont-BidCopilot] 审计链防篡改自检失败（末尾盲区），拒绝启动。')
  }
  if (verifyAuditChain([{ ...record, subjectDigest: 'sha256:forged' }]).valid !== false) {
    throw new Error('[mont-BidCopilot] 审计链摘要防篡改自检失败，拒绝启动。')
  }
  return true
}

/**
 * 装配插件。
 * @param {object} ctx - Cordis 上下文
 * @param {object} [rawConfig] - Loader 传入的配置
 */
export function apply(ctx, rawConfig = {}) {
  const log = (message, error) => {
    if (error === undefined) ctx.logger?.info?.(`mont-BidCopilot: ${message}`)
    else ctx.logger?.warn?.(`mont-BidCopilot: ${message} — ${error instanceof Error ? error.message : String(error)}`)
  }

  // ① 配置校验：用与 Loader 同契约的 Standard Schema 归一化（补默认值、拒类型错误）。
  let settings
  try {
    const verdict = validateConfig(rawConfig)
    if (verdict.ok !== true) {
      log(`配置校验失败，插件拒绝提供任何工具：${JSON.stringify(verdict.issues)}`)
      return
    }
    settings = verdict.value
  } catch (error) {
    log('配置校验异常，插件拒绝提供任何工具', error)
    return
  }

  // ② 合规内核：同步阶段无法 await，所以先做一次结构性校验，
  //    完整规则校验在 ready() 中异步完成；任一失败都让插件进入失败态。
  const dataDir = resolveDataDir(settings)
  const kbDir = typeof settings.kbDir === 'string' && settings.kbDir.trim().length > 0
    ? resolve(settings.kbDir.trim())
    : undefined

  const runtime = createRuntime({
    root: dataDir,
    allowWrite: settings.allowWrite !== false,
    selfDupThreshold: typeof settings.selfDupThreshold === 'number' ? settings.selfDupThreshold : 0.85,
    collusionThreshold: typeof settings.collusionThreshold === 'number' ? settings.collusionThreshold : 0.65,
    kbDir,
    log,
  })

  // ② 合规内核与工作流引擎的严格自检。失败则记录并拒绝提供工具。
  let kernelOk = false
  const kernelReady = (async () => {
    try {
      await assertComplianceKernel()
      assertWorkflowEngine()
      kernelOk = true
      log('合规内核与工作流引擎自检通过')
    } catch (error) {
      kernelOk = false
      log('合规内核自检失败，插件拒绝提供任何工具', error)
      throw error
    }
  })()

  // ③ 存储就绪
  runtime.store.ready().then(
    () => log(`数据目录就绪：${dataDir}`),
    error => log('数据目录创建失败', error),
  )

  // ④ 工具注册。合规内核未通过时**一个工具都不注册**。
  const disposers = []
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载期单个 disposer 失败不应阻断其余卸载。
      }
    }
  }, 'mont-bidcopilot: tools')

  kernelReady.then(() => {
    if (!kernelOk) return
    try {
      const registered = registerTools(ctx, runtime)
      disposers.push(...registered)
      log(`已注册 ${registered.length} 个 mont_* 工具`)
    } catch (error) {
      log('工具注册失败', error)
    }
  }, () => {
    // kernelReady 已 reject，错误已在上方记录。
  })

  // ⑤ Host 侧门禁入口（不是工具）。两种通道都只由人触发：
  //    a. ctx.provide 的服务，供同进程的 UI/其他 Host 插件调用；
  //    b. slash command（/bidcopilot-*），人在输入框键入，模型无法代打。
  //    二者的凭证都由本插件内部构造，不出现在任何工具参数里。
  const hostSurface = {
    runtime,
    /** 门禁决策入口：只能由 Host 侧 UI 调用。 */
    approveGate: (projectId, input) => runtime.approveGateFromHost(projectId, input),
    /** 构造 Host 侧凭证——不在任何工具参数中暴露。 */
    hostCredential: () => ({ channel: 'host-ui' }),
  }

  if (typeof ctx.provide === 'function') {
    const disposeService = ctx.provide('montBidCopilot', hostSurface)
    if (typeof disposeService === 'function') {
      ctx.effect(() => disposeService, 'mont-bidcopilot: service')
    }
  }

  // slash command：人键入才执行，模型没有调用通道。
  ctx.inject?.(['commands'], commandCtx => {
    if (typeof commandCtx.commands?.register !== 'function') return
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'bidcopilot-gate',
      description: '查看或裁决 mont-BidCopilot 的门禁（只有人能执行）。用法：/bidcopilot-gate <项目id> [show|approve|reject] <gate1|gate2|gate3> [操作人] [备注]',
      input: { hint: '<项目id> [show|approve|reject] <gateId> [操作人] [备注]' },
      recordInput: true,
      async handler(invocation) {
        const parts = String(invocation.rawInput ?? '').trim().split(/\s+/u).filter(Boolean)
        const projectId = parts[0]
        if (projectId === undefined) {
          return { kind: 'error', text: '用法：/bidcopilot-gate <项目id> [show|approve|reject] <gate1|gate2|gate3> [操作人] [备注]' }
        }
        const verb = parts[1] ?? 'show'
        try {
          if (verb === 'show') {
            const status = await runtime.projectStatus(projectId)
            const lines = [
              `项目 ${projectId} 门禁状态：`,
              ...Object.values(status.gates).map(gate => `  ${gate.id} ${gate.title} → ${gate.status}${gate.decidedBy === null ? '' : `（${gate.decidedBy}）`}`),
              `审计链有效：${status.auditChain.valid}（${status.auditChain.records} 条）`,
              `可导出：${status.canExport}`,
            ]
            return { kind: 'success', text: lines.join('\n') }
          }
          if (verb !== 'approve' && verb !== 'reject') {
            return { kind: 'error', text: `未知动作 ${verb}，只支持 show / approve / reject。` }
          }
          const gateId = parts[2]
          const operator = parts[3]
          if (gateId === undefined) return { kind: 'error', text: '缺少门编号（gate1 / gate2 / gate3）。' }
          if (operator === undefined) return { kind: 'error', text: '裁决必须写明操作人：/bidcopilot-gate <项目id> approve <gateId> <操作人>' }

          // 未解决项：approve 时若仍有未核验事实，拒绝放行（与导出前置检查同口径）。
          const status = await runtime.projectStatus(projectId)
          const unresolved = verb === 'approve'
            ? status.facts.unverified.map(fact => `${fact.key} 未核验`)
            : []

          const result = await hostSurface.approveGate(projectId, {
            gateId,
            decision: verb,
            operator,
            subject: { projectId, gateId, facts: status.facts, sections: status.sections },
            note: parts.slice(4).join(' ') || undefined,
            unresolved,
            credential: hostSurface.hostCredential(),
          })
          if (result.ok !== true) return { kind: 'error', text: `裁决失败：${result.error.code} — ${result.error.message}` }
          return {
            kind: 'success',
            text: `已记录：${result.record.gateTitle} ${result.record.decision} by ${result.record.operator}（seq ${result.record.seq}，摘要 ${result.record.subjectDigest.slice(0, 23)}…）`,
          }
        } catch (error) {
          return { kind: 'error', text: `命令执行失败：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    }), 'mont-bidcopilot: gate command')
  })

  log(`activated — dataDir=${dataDir}`)
}

/** Cordis 插件默认导出形状。 */
export default { name, inject, Config, apply }
