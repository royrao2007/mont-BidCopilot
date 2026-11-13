/**
 * 检查发布文档中是否残留本机专属路径。
 *
 * 别人的机器没有 F 盘，README 里的安装/使用示例必须是通用形式
 * （公网 git 地址或 <占位符>），否则照抄会失败。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 会被公众阅读的文件。 */
const TARGETS = [
  'README.md',
  'SECURITY.md',
  'NOTICE.md',
  'CHANGELOG.md',
  'docs/DETAIL.md',
  'docs/DETAIL.zh.md',
  'locale/en.json',
  'locale/zh.json',
]

/** 本机专属特征：本机盘符、本机用户名、本机专有目录。 */
const LOCAL_MARKERS = [
  { pattern: /[A-Za-z]:\\DSHDesktop/u, label: '本机盘符路径（DSHDesktop）' },
  { pattern: /[A-Za-z]:\\deepseek harness/u, label: '本机盘符路径（deepseek harness）' },
  { pattern: /F:\\/u, label: 'F 盘路径' },
  { pattern: /C:\\Users\\/u, label: '用户目录绝对路径' },
  { pattern: /chajian/u, label: '本机专有目录名（chajian）' },
]

let failures = 0

for (const file of TARGETS) {
  const path = join(root, file)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    console.log(`SKIP  ${file}（不存在）`)
    continue
  }

  const hits = []
  for (const { pattern, label } of LOCAL_MARKERS) {
    const match = pattern.exec(text)
    if (match === null) continue
    const lineNo = text.slice(0, match.index).split('\n').length
    hits.push(`${label} @ 第 ${lineNo} 行: ${match[0]}`)
  }

  if (hits.length > 0) {
    failures += 1
    console.log(`FAIL  ${file}`)
    for (const hit of hits) console.log(`        ${hit}`)
  } else {
    console.log(`PASS  ${file}`)
  }
}

// 正向检查：README 必须给出公网 git 安装地址
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const hasGitInstall = readme.includes('github:royrao2007/mont-BidCopilot')
  || readme.includes('https://github.com/royrao2007/mont-BidCopilot.git')
console.log(`\n${hasGitInstall ? 'PASS' : 'FAIL'}  README 提供公网 git 安装地址`)
if (!hasGitInstall) failures += 1

console.log(`\n${failures === 0 ? '全部通过：文档中无本机专属路径' : `失败 ${failures} 项`}`)
process.exit(failures === 0 ? 0 : 1)
