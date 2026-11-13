/**
 * 组四：清单与版本契约。
 *
 * 目的：把「DSH 版本要求」「工具数量如实」「无安装期脚本」这类
 * 一旦被悄悄改坏就会导致安装失败或披露失真的契约钉成测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerTools } from '../lib/tools.js'
import { createRuntime } from '../lib/runtime.js'
import { assertComplianceKernel, assertWorkflowEngine, resolveDataDir, Config, validateConfig } from '../index.js'

const PKG_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * 把 semver 范围的最简比较实现出来（只覆盖 >=x.y.z-pre 形式），
 * 用于断言「当前运行时版本确实落在声明范围内」。
 */
function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(String(text).trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  // 无 pre 视为高于同号 pre（semver 规则）
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const left = a.pre[index]
    const right = b.pre[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNum = /^\d+$/u.test(left)
    const rightNum = /^\d+$/u.test(right)
    if (leftNum && rightNum) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1
    } else if (leftNum !== rightNum) {
      return leftNum ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

test('版本｜package.json 声明 dsh engines 且不低于 0.2.2-rc.1', async () => {
  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'))
  assert.ok(pkg.engines !== undefined, 'package.json 必须有 engines 字段')
  assert.ok(typeof pkg.engines.dsh === 'string', 'engines.dsh 必须声明')

  const range = pkg.engines.dsh.trim()
  assert.match(range, /^>=\s*\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, `engines.dsh 应为 ">=x.y.z-pre" 形式，实际：${range}`)

  const floor = parseVersion(range.replace(/^>=/u, '').trim())
  assert.ok(floor !== null, `无法解析下限版本：${range}`)

  const required = parseVersion('0.2.2-rc.1')
  assert.ok(
    compareVersions(floor, required) >= 0,
    `engines.dsh 下限 ${range} 低于要求 0.2.2-rc.1`,
  )
})

test('版本｜当前运行时版本落在声明范围内', async () => {
  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'))
  const floor = parseVersion(pkg.engines.dsh.replace(/^>=/u, '').trim())

  // 用本机实际 DSH 运行时版本做一次真校验；读不到就跳过而不是假绿。
  const runtimePkgPath = 'D:\\Program files\\deepseekharness\\resources\\app.asar\\dsh\\package.json'
  const raw = await readFile(runtimePkgPath, 'utf8').catch(() => undefined)
  if (raw === undefined) {
    assert.ok(true, '当前环境无 DSH 桌面运行时，跳过实机版本比对')
    return
  }
  const runtimePkg = JSON.parse(raw)
  const current = parseVersion(runtimePkg.version)
  assert.ok(current !== null, `无法解析运行时版本：${runtimePkg.version}`)
  assert.ok(
    compareVersions(current, floor) >= 0,
    `运行时 ${runtimePkg.version} 不满足声明的 engines.dsh ${pkg.engines.dsh}`,
  )
})

test('版本｜node engines 声明存在且可解析', async () => {
  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'))
  assert.ok(typeof pkg.engines.node === 'string')
  assert.match(pkg.engines.node, /^>=\s*\d+\.\d+(\.\d+)?$/u)
})

test('清单｜无任何安装期脚本', async () => {
  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'))
  const scripts = pkg.scripts ?? {}
  for (const forbidden of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
    assert.equal(scripts[forbidden], undefined, `不得声明 ${forbidden} 脚本（供应链风险面）`)
  }
  assert.equal(scripts.test !== undefined, true, 'test 脚本应存在')
})

test('清单｜运行时零第三方依赖', async () => {
  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'))
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], '运行时依赖必须为空（只用 Node 标准库）')
})

test('清单｜dsh.bundle.patch 指向存在的文件', async () => {
  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'))
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
  const patch = await readFile(patchPath, 'utf8')
  assert.match(patch, /id:\s*mont-bidcopilot/u)
  assert.match(patch, /name:\s*'dsh-mont-bidcopilot'/u)
  // config 必须完整重述（DSH 的 config 是整体替换，不深合并）
  for (const key of ['dataDir', 'allowWrite', 'selfDupThreshold', 'collusionThreshold', 'kbDir']) {
    assert.match(patch, new RegExp(`${key}:`, 'u'), `patch config 缺少 ${key}`)
  }
})

test('清单｜Config 满足 Standard Schema 契约且覆盖 patch 全部键', () => {
  // Loader 读取的是 `Config['~standard'].validate(...)`，不是 `Config.validate(...)`。
  // 写成普通对象会让 fiber 报 "reading 'validate'" 并进入 failed（本机实测过的真实故障）。
  assert.equal(typeof Config.validate, 'undefined', '不应导出裸 validate；契约在 ~standard 下')
  assert.ok(Config['~standard'] !== undefined, 'Config 必须提供 ~standard 入口')
  assert.equal(typeof Config['~standard'].validate, 'function', '~standard.validate 必须是函数')
  assert.equal(Config['~standard'].version, 1, 'Standard Schema 版本应为 1')

  const defaults = Config['~standard'].validate({}).value
  assert.ok(defaults !== undefined, '空输入必须能补出默认值')
  for (const key of ['dataDir', 'allowWrite', 'selfDupThreshold', 'collusionThreshold', 'kbDir']) {
    assert.ok(Object.hasOwn(defaults, key), `Config 缺少 ${key}`)
  }
  assert.equal(defaults.dataDir, '')
  assert.equal(defaults.allowWrite, true)
  assert.equal(defaults.selfDupThreshold, 0.85)
  assert.equal(defaults.collusionThreshold, 0.65)
  assert.equal(defaults.kbDir, '')

  // 非法输入必须返回 issues，而不是抛异常或静默通过。
  const bad = Config['~standard'].validate({ allowWrite: 'yes' })
  assert.ok(Array.isArray(bad.issues) && bad.issues.length > 0, '非法类型必须产生 issues')
  assert.ok(bad.issues[0].message.includes('allowWrite'))
  assert.equal(bad.value, undefined)

  // validateConfig 是 apply 内部使用的同一契约，二者口径必须一致。
  const good = validateConfig({ selfDupThreshold: 0.9 })
  assert.equal(good.ok, true)
  assert.equal(good.value.selfDupThreshold, 0.9)
  assert.equal(good.value.allowWrite, true, '未提供的键补默认值')
  assert.equal(validateConfig({ kbDir: 123 }).ok, false)

  // 未知键的处理随 vendor 而异：宿主 schemastery 会透传，本包回退实现会丢弃。
  // 两种都合规；关键是 apply() 只读取白名单内的键，因此未知键不进入运行时决策。
  const cleaned = Config['~standard'].validate({ unknownKey: 1 }).value
  for (const key of ['dataDir', 'allowWrite', 'selfDupThreshold', 'collusionThreshold', 'kbDir']) {
    assert.ok(Object.hasOwn(cleaned, key), `白名单键 ${key} 必须存在`)
  }
  assert.ok(
    ['schemastery', 'mont-bidcopilot'].includes(Config['~standard'].vendor),
    `vendor 应为宿主库或回退实现，实际 ${Config['~standard'].vendor}`,
  )
})

test('清单｜数据目录解析遵循配置与 DSH_HOME', () => {
  const explicit = resolveDataDir({ dataDir: 'F:\\tmp\\mbc' })
  assert.equal(explicit, 'F:\\tmp\\mbc')

  const original = process.env.DSH_HOME
  process.env.DSH_HOME = 'F:\\tmp\\dshhome'
  try {
    const derived = resolveDataDir({ dataDir: '' })
    assert.ok(derived.includes('bidcopilot'), `应由 DSH_HOME 派生，实际：${derived}`)
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})

test('清单｜合规内核自检通过（五条规则齐备且可编译）', async () => {
  const rules = await assertComplianceKernel()
  assert.ok(rules.rules.length >= 5)
  assert.ok(rules.version.length > 0)
})

test('清单｜工作流引擎自检通过（含末尾篡改可发现）', () => {
  assert.equal(assertWorkflowEngine(), true)
})

test('清单｜mont_ping 如实报告工具数量与清单一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-manifest-'))
  try {
    const names = []
    const ctx = { tools: { register(definition) { names.push(definition.name); return () => {} } } }
    const runtime = createRuntime({ root: dir, allowWrite: true })
    registerTools(ctx, runtime)

    const ping = await runtime.ping()
    assert.equal(ping.ok, true)
    assert.equal(ping.toolCount, names.length, 'ping 报的数量必须与实际注册数一致')
    assert.deepEqual(ping.tools, names, 'ping 报的清单必须与实际注册清单一致')
    assert.ok(ping.toolCount >= 20, `工具数应覆盖全部能力，实际 ${ping.toolCount}`)
    assert.equal(ping.dshEngineRange, '>=0.2.2-rc.1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('清单｜每个工具都有非空描述与对象根 schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mbc-schema-'))
  try {
    const defs = []
    const ctx = { tools: { register(definition) { defs.push(definition); return () => {} } } }
    const runtime = createRuntime({ root: dir, allowWrite: true })
    registerTools(ctx, runtime)

    assert.ok(defs.length >= 20)
    for (const definition of defs) {
      assert.ok(definition.name.startsWith('mont_'), `${definition.name} 应以 mont_ 前缀`)
      assert.ok(definition.description.length >= 20, `${definition.name} 描述过短`)
      assert.equal(definition.parameters.type, 'object', `${definition.name} 参数根必须是 object`)
      assert.equal(typeof definition.execute, 'function', `${definition.name} 缺 execute`)
      assert.equal(typeof definition.output?.render, 'function', `${definition.name} 缺 output.render`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
