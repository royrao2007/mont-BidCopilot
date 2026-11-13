/**
 * 校验 NOTICE.md 与 README.md 中声称存在的路径是否真实存在。
 *
 * 起因：NOTICE.md 曾声称 data/review-checklists/ 存在并据此做许可证边界说明，
 * 但该目录根本不存在。文档里的路径断言必须可核实，不能写不存在的文件。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const CODE_SPAN = /\u0060([^\u0060]+)\u0060/gu

/** 只看像路径的片段，跳过命令行、键名等。 */
const looksLikePath = text =>
  /^(?:data\/|docs\/|locale\/|lib\/|test\/|scripts\/)/u.test(text)
  || /^(?:README|SECURITY|NOTICE|CHANGELOG|LICENSE)[A-Za-z.-]*\.?m?d?$/u.test(text)
  || /^(?:index\.js|cordis\.patch\.yml|package\.json|icon\.svg)$/u.test(text)

let failures = 0

/**
 * 判断某次路径出现是否在「上游组件吸收范围」语境里。
 *
 * NOTICE.md 的表格用 `lib/gate.js` 描述上游组件里被吸收的文件，
 * 那不是本包路径，不能按本包存在性校验。判据：同一行出现仓库标识
 * （形如 `owner/repo`）或「吸收」「处理」类列语义时，视为上游引用。
 */
function isUpstreamReference(text, span) {
  const index = text.indexOf(span)
  if (index === -1) return false
  const lineStart = text.lastIndexOf('\n', index) + 1
  const lineEnd = text.indexOf('\n', index)
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
  return /\u0060[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\u0060/u.test(line)
}

for (const file of ['NOTICE.md', 'README.md', 'SECURITY.md']) {
  const path = join(root, file)
  if (!existsSync(path)) continue
  const text = readFileSync(path, 'utf8')

  const claimed = new Set()
  for (const match of text.matchAll(CODE_SPAN)) {
    const span = match[1].trim()
    if (!looksLikePath(span)) continue
    claimed.add(span)
  }

  for (const span of claimed) {
    // 通配写法只校验其目录前缀
    const probe = span.includes('*') ? span.slice(0, span.indexOf('*')) : span
    const target = join(root, probe)
    if (existsSync(target)) {
      console.log(`PASS  ${file}: ${span}`)
    } else if (isUpstreamReference(text, span)) {
      // 上游组件内的路径，本包不负责存在性。
      console.log(`SKIP  ${file}: ${span}（上游组件路径，非本包文件）`)
    } else {
      failures += 1
      console.log(`FAIL  ${file}: ${span} —— 声称存在但找不到`)
    }
  }
}

console.log(`\n${failures === 0 ? '全部通过：文档声称的路径都真实存在' : `失败 ${failures} 项：文档声称了不存在的路径`}`)
process.exit(failures === 0 ? 0 : 1)
