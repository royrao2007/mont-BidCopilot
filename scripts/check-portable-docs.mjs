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

// 正向检查：README 必须给出可直接在插件页输入框使用的 npm 包名
const readme = readFileSync(join(root, 'README.md'), 'utf8')

const packageName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
const hasNpmInstall = readme.includes(packageName)
console.log(`\n${hasNpmInstall ? 'PASS' : 'FAIL'}  README 给出 npm 包名（${packageName}）可供安装`)
if (!hasNpmInstall) failures += 1

// 反向检查：不得把 agent 的内部工具调用语法当成输入框内容
const installSection = (() => {
  const start = readme.indexOf('### 方式一')
  const end = readme.indexOf('### 验证安装成功')
  return start === -1 || end === -1 ? '' : readme.slice(start, end)
})()
const mistakenSyntax = /```(?:text)?\s*plugin_manager install_bundle target:/u.test(installSection)
console.log(`${mistakenSyntax ? 'FAIL' : 'PASS'}  安装步骤未把 plugin_manager 调用语法当作输入内容`)
if (mistakenSyntax) failures += 1

console.log(`\n${failures === 0 ? '全部通过：文档中无本机专属路径，安装说明可直接照抄' : `失败 ${failures} 项`}`)
process.exit(failures === 0 ? 0 : 1)
