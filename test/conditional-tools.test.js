/**
 * 组七：DSH 0.2.2-rc 步骤准入机制适配。
 *
 * 验收点：
 *   - 写类工具在只读模式下被 when 条件摘除，读类工具不受影响；
 *   - 可写模式下所有工具照常注册且不带条件；
 *   - when 条件必须是纯同步布尔，不抛错、不碰 I/O；
 *   - 条件确实通过 ctx.tools.register 的第二参数传给宿主（不是只写在注释里）。
 *
 * 依据：@deepseek-ai/dsh-tools 的 ToolRegistrationOptions.when，
 * 以及 docs/upgrade-guide/v0.2.1-rc.2/conditional-tools。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools } from '../lib/tools.js'
import { createRuntime } from '../lib/runtime.js'

/** 收集注册结果：{ definition, options }。 */
function collector() {
  const calls = []
  return {
    calls,
    ctx: {
      tools: {
        register(definition, options = {}) {
          calls.push({ definition, options })
          return () => {}
        },
      },
    },
  }
}

test('准入｜只读模式下写类工具被摘除，读类工具保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-gate-ro-'))
  try {
    const { calls, ctx } = collector()
    const runtime = createRuntime({ root: dir, allowWrite: false })
    registerTools(ctx, runtime)

    const withCondition = calls.filter(c => typeof c.options.when === 'function')
    const names = new Set(withCondition.map(c => c.definition.name))

    // 只读模式：写工具必须带条件，且条件求值为 false
    for (const { definition, options } of withCondition) {
      assert.equal(
        options.when({ agent: {}, modelSelection: {}, signal: new AbortController().signal }),
        false,
        `${definition.name} 在只读模式下应被摘除`,
      )
    }
    assert.ok(names.has('mont_bid_export'), '导出是写操作，应受只读约束')
    assert.ok(names.has('mont_project_create'), '建项目是写操作，应受只读约束')
    assert.ok(names.has('mont_kb_index'), '建索引写磁盘，应受只读约束')
    assert.ok(names.has('mont_wf_advance'), '推进门禁写状态，应受只读约束')

    // 纯读工具不得被摘除
    const readOnlyNames = calls
      .filter(c => !withCondition.includes(c))
      .map(c => c.definition.name)
    for (const expected of ['mont_project_list', 'mont_project_status', 'mont_guard_check_clause',
      'mont_policy_search', 'mont_kb_search', 'mont_ping', 'mont_bid_rejection_rules']) {
      assert.ok(readOnlyNames.includes(expected), `${expected} 是读工具，不应被摘除`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('准入｜可写模式下写类工具的条件求值为 true，工具不被摘除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-gate-rw-'))
  try {
    const { calls, ctx } = collector()
    const runtime = createRuntime({ root: dir, allowWrite: true })
    registerTools(ctx, runtime)

    const withCondition = calls.filter(c => typeof c.options.when === 'function')
    assert.ok(withCondition.length > 0, '写工具应带条件')
    for (const { definition, options } of withCondition) {
      assert.equal(
        options.when({ agent: {}, modelSelection: {}, signal: new AbortController().signal }),
        true,
        `${definition.name} 在可写模式下应保留`,
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('准入｜32 个工具注册数量不因条件准入而减少', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-gate-count-'))
  try {
    for (const allowWrite of [true, false]) {
      const { calls, ctx } = collector()
      const runtime = createRuntime({ root: dir, allowWrite })
      registerTools(ctx, runtime)
      assert.equal(calls.length, 32, `allowWrite=${allowWrite} 时仍应注册 32 个工具（条件只在步骤装配时摘除）`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('准入｜条件同步返回布尔且不抛错（宿主契约）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-gate-sync-'))
  try {
    const { calls, ctx } = collector()
    const runtime = createRuntime({ root: dir, allowWrite: false })
    registerTools(ctx, runtime)

    const signal = new AbortController().signal
    for (const { definition, options } of calls) {
      if (typeof options.when !== 'function') continue
      const value = options.when({ agent: {}, modelSelection: {}, signal })
      // 不得返回 Promise：宿主会把 Promise 当异步条件 await，语义虽可用，
      // 但纯同步判断能保证"步骤装配前一次性完成"，且不可能因取消而拒绝。
      assert.equal(typeof value, 'boolean', `${definition.name} 的 when 必须同步返回布尔`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('准入｜runtime.canWrite 与 store.allowWrite 一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-gate-canwrite-'))
  try {
    const rw = createRuntime({ root: dir, allowWrite: true })
    assert.equal(rw.canWrite(), true)
    const ro = createRuntime({ root: dir, allowWrite: false })
    assert.equal(ro.canWrite(), false)
    // 省略 allowWrite 时默认可写（与 openStore 的 !== false 口径一致）
    const dflt = createRuntime({ root: dir })
    assert.equal(dflt.canWrite(), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('准入｜Config 丢弃未知键（拼错的配置不能被静默接受）', async () => {
  // 背景：宿主 schemastery 的 ~standard.validate 只补默认值、校验类型，
  // 不裁剪未知键；若不处理，写错键名会静默无效，用户以为设置生效了。
  const { default: plugin } = await import('../index.js')
  const validate = plugin.Config['~standard'].validate
  assert.equal(typeof validate, 'function')

  const result = validate({ allowWrite: false, typoKey: 'x' })
  assert.equal(result.issues, undefined, '合法输入不应报错')
  assert.equal(result.value.allowWrite, false, '已知键必须保留')
  assert.equal(result.value.typoKey, undefined, '未知键必须被丢弃')
  // 五个已知键都要在
  for (const key of ['dataDir', 'allowWrite', 'selfDupThreshold', 'collusionThreshold', 'kbDir']) {
    assert.ok(Object.hasOwn(result.value, key), `结果缺 ${key}`)
  }
  assert.deepEqual(Object.keys(result.value).sort(), ['allowWrite', 'collusionThreshold', 'dataDir', 'kbDir', 'selfDupThreshold'])
})
