/**
 * 冒烟检查：在真实 Node 下加载插件入口，验证最新宿主契约仍被满足。
 *
 * 只做加载与契约检查，不启动 DSH、不写任何数据。
 * 用法：node scripts/smoke-load.js
 */

import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = pathToFileURL(join(root, 'index.js')).href

const mod = await import(entry)
const plugin = mod.default

const failures = []
const check = (ok, label) => {
  if (!ok) failures.push(label)
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
}

check(typeof plugin === 'object' && plugin !== null, 'default 导出为对象')
check(typeof plugin.name === 'string' && plugin.name.length > 0, `name 非空（${plugin.name}）`)
check(Array.isArray(plugin.inject), `inject 为数组（${JSON.stringify(plugin.inject)}）`)
check(typeof plugin.apply === 'function', 'apply 为函数')

// Config 必须满足 Standard Schema 契约（Loader 读的是 ~standard.validate）
const schema = plugin.Config?.['~standard']
check(schema !== undefined, "Config['~standard'] 存在")
check(typeof schema?.validate === 'function', 'Config 提供 validate 函数')

if (typeof schema?.validate === 'function') {
  const empty = schema.validate({})
  check(empty.issues === undefined && typeof empty.value === 'object', '空输入校验通过并补默认值')
  check(empty.value?.allowWrite === true, `默认 allowWrite=true（实际 ${empty.value?.allowWrite}）`)

  const bad = schema.validate({ allowWrite: 'not-a-boolean' })
  check(Array.isArray(bad.issues) && bad.issues.length > 0, '非法类型被拒绝')

  const unknown = schema.validate({ nope: 1 })
  check(unknown.value?.nope === undefined, '未知键被丢弃')
}

// 工具注册器在伪 ctx 下可运行（不触盘）
const { registerTools } = await import(pathToFileURL(join(root, 'lib', 'tools.js')).href)
const { createRuntime } = await import(pathToFileURL(join(root, 'lib', 'runtime.js')).href)
const { mkdtemp, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')

const dir = await mkdtemp(join(tmpdir(), 'mbc-smoke-'))
try {
  const registered = []
  const ctx = {
    tools: {
      register(definition, options = {}) {
        registered.push({ definition, options })
        return () => {}
      },
    },
  }
  registerTools(ctx, createRuntime({ root: dir, allowWrite: false }))
  check(registered.length === 32, `注册 32 个工具（实际 ${registered.length}）`)
  const gated = registered.filter(r => typeof r.options.when === 'function')
  check(gated.length === 14, `14 个写工具带准入条件（实际 ${gated.length}）`)
  const allGatedFalse = gated.every(r => r.options.when({ agent: {}, modelSelection: {}, signal: new AbortController().signal }) === false)
  check(allGatedFalse, '只读模式下所有写工具条件求值为 false')
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
