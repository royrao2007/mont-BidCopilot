/**
 * 组六：包元数据与权限披露。
 *
 * 这些是「包里必须有权限信息与英文介绍」的验收点。
 * 检查对象是 locale 元数据、详情文档、示意图与清单一致性；
 * 规范依据是 DSH 的 host-plugin.md 与 plugin-details.md。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const at = rel => join(root, rel)
const read = rel => readFileSync(at(rel), 'utf8')

/** 每个 locale 都必带的权限披露关键词（中英各一套）。 */
const PERMISSION_TOKENS = {
  en: ['Permissions', 'network requests', 'credentials', 'install-time scripts'],
  zh: ['权限', '网络请求', '凭据', '安装期脚本'],
}

test('元数据｜en 与 zh 的 locale 文件都是合法 JSON 且含 meta 三字段', () => {
  for (const [file, lang] of [['locale/en.json', 'en'], ['locale/zh.json', 'zh']]) {
    const doc = JSON.parse(read(file))
    const meta = doc.meta ?? {}
    assert.ok(typeof meta.title === 'string' && meta.title.trim().length > 0, `${file} 缺 meta.title`)
    assert.ok(typeof meta.description === 'string' && meta.description.trim().length > 0, `${file} 缺 meta.description`)
    assert.ok(typeof meta.detail === 'string' && meta.detail.endsWith('.md'), `${file} 的 meta.detail 应为 .md 路径`)
    assert.ok(PERMISSION_TOKENS[lang] !== undefined)
  }
})

test('元数据｜描述里写明了权限信息（读取范围、网络、凭据、安装期脚本）', () => {
  for (const [file, lang] of [['locale/en.json', 'en'], ['locale/zh.json', 'zh']]) {
    const description = JSON.parse(read(file)).meta.description
    for (const token of PERMISSION_TOKENS[lang]) {
      assert.ok(description.includes(token), `${file} 的描述缺少权限披露「${token}」`)
    }
  }
})

test('元数据｜英文介绍为纯英文，不混入中文', () => {
  const meta = JSON.parse(read('locale/en.json')).meta
  assert.match(meta.title, /^[A-Za-z]/, '英文标题应以拉丁字母开头')
  const hanCount = (meta.description.match(/\p{Script=Han}/gu) ?? []).length
  assert.equal(hanCount, 0, `locale/en.json 描述含 ${hanCount} 个汉字，应为纯英文`)
})

test('元数据｜中文介绍为中文且同样写明权限', () => {
  const meta = JSON.parse(read('locale/zh.json')).meta
  const hanCount = (meta.description.match(/\p{Script=Han}/gu) ?? []).length
  assert.ok(hanCount > 100, `中文描述汉字过少：${hanCount}`)
})

test('元数据｜描述如实声明「不联网 / 不启动进程 / 不读凭据」这三条硬约束', () => {
  const en = JSON.parse(read('locale/en.json')).meta.description
  assert.ok(/makes no network requests/iu.test(en), '须声明不发网络请求')
  assert.ok(/spawns no processes/iu.test(en), '须声明不启动子进程')
  assert.ok(/reads no credentials/iu.test(en), '须声明不读取凭据')

  const zh = JSON.parse(read('locale/zh.json')).meta.description
  assert.ok(zh.includes('不发起任何网络请求'), '须声明不发起网络请求')
  assert.ok(zh.includes('不启动任何子进程'), '须声明不启动子进程')
  assert.ok(zh.includes('不读取任何凭据'), '须声明不读取凭据')
})

test('元数据｜描述声明了关闭插件后的行为', () => {
  const en = JSON.parse(read('locale/en.json')).meta.description
  assert.ok(/Turning the plugin off/iu.test(en), '英文须说明关闭后的变化')
  const zh = JSON.parse(read('locale/zh.json')).meta.description
  assert.ok(zh.includes('关闭插件'), '中文须说明关闭后的变化')
})

test('元数据｜每个 locale 声明的 detail 文件存在且恰好一行图片', () => {
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const detail = JSON.parse(read(file)).meta.detail
    assert.ok(existsSync(at(detail)), `${file} 声明的 ${detail} 不存在`)
    const lines = read(detail).trim().split(/\r?\n/)
    assert.equal(lines.length, 1, `${detail} 应恰好一行，实际 ${lines.length} 行`)
    const match = /^!\[([^\]]+)\]\(([^)]+)\)$/.exec(lines[0])
    assert.ok(match !== null, `${detail} 应为单行 Markdown 图片`)
    assert.ok(match[1].trim().length >= 10, `${detail} 的替代文本过短`)

    const imagePath = join(dirname(at(detail)), match[2].trim())
    assert.ok(existsSync(imagePath), `${detail} 引用的图片 ${match[2]} 不存在`)
    assert.ok(statSync(imagePath).size <= 5 * 1024 * 1024, `${match[2]} 超过 5 MiB`)
  }
})

test('元数据｜示意图为 640x300 自包含 SVG，不含脚本/样式/文本/远程引用', () => {
  const banned = ['script', 'foreignObject', 'style', 'text', 'animate', 'animateTransform', 'set']
  for (const svg of ['docs/preview.svg', 'docs/preview.zh.svg']) {
    const body = read(svg)
    assert.ok(/width="640"\s+height="300"/.test(body), `${svg} 尺寸应为 640x300`)
    assert.ok(/viewBox\s*=/.test(body), `${svg} 缺 viewBox`)
    assert.ok(body.trim().endsWith('</svg>'), `${svg} 根标签未闭合`)

    for (const tag of banned) {
      assert.ok(
        new RegExp(`<${tag}[\\s>/]`).test(body) === false,
        `${svg} 不得包含 <${tag}>`,
      )
    }
    assert.ok(
      /(?:href|src)\s*=\s*["']\s*(?:https?:)?\/\//.test(body) === false,
      `${svg} 不得引用远程资源`,
    )
  }
})

test('元数据｜图标是自包含 SVG 且未超 256 KiB', () => {
  assert.ok(existsSync(at('icon.svg')), 'icon.svg 不存在')
  const body = read('icon.svg')
  assert.ok(/viewBox\s*=/.test(body))
  assert.ok(body.trim().endsWith('</svg>'))
  assert.ok(statSync(at('icon.svg')).size <= 256 * 1024)
  assert.ok(/(?:href|src)\s*=\s*["']\s*(?:https?:)?\/\//.test(body) === false, 'icon 不得引用远程资源')
})

test('元数据｜清单导出并打包了 locale、icon、docs', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.icon, './icon.svg')
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.ok(pkg.files.includes('docs'), 'files 必须含 docs')
  assert.ok(pkg.files.some(item => item.startsWith('locale')), 'files 必须含 locale')

  // 声明到的每个资源都必须真实存在
  for (const rel of ['icon.svg', 'docs/DETAIL.md', 'docs/DETAIL.zh.md', 'locale/en.json', 'locale/zh.json']) {
    assert.ok(existsSync(at(rel)), `${rel} 被声明但不存在`)
  }
})

test('元数据｜LICENSE 为纯 MIT 文本（GitHub 才能识别为 MIT）', () => {
  const license = read('LICENSE')
  assert.ok(license.trimStart().startsWith('MIT License'), 'LICENSE 首行应为 MIT License')
  assert.ok(license.includes('Permission is hereby granted, free of charge'), '缺 MIT 授权段')
  assert.ok(license.includes('THE SOFTWARE IS PROVIDED "AS IS"'), '缺 MIT 免责段')

  // 附加内容会让 GitHub 的 license 检测退化为「other」。
  assert.equal(
    /^-{3,}$/mu.test(license),
    false,
    'LICENSE 不得包含分隔线后的附加声明，上游归因应放在 NOTICE.md',
  )
  assert.equal(
    /Apache License/u.test(license),
    false,
    'LICENSE 不得混入 Apache-2.0 文本；上游声明放 NOTICE.md',
  )

  // 上游版权行必须仍被保留在某处（MIT/Apache-2.0 的强制要求）。
  const notice = read('NOTICE.md')
  for (const holder of ['BidKit contributors', 'wu81313-lab', 'TtTRz', 'BiaoShu-SKILL']) {
    assert.ok(notice.includes(holder), `NOTICE.md 未保留上游版权行：${holder}`)
  }
})

test('文档｜内部实施方案文档不得进入仓库与 npm 包', () => {
  const internalDoc = 'mont-BidCopilot实施方案.md'

  // .gitignore 必须拦住它，否则会被 git add -A 再次带进仓库。
  const gitignore = read('.gitignore')
  assert.ok(
    gitignore.includes(internalDoc),
    '.gitignore 须忽略内部实施方案文档，防止再次误提交',
  )

  // package.json 的 files 不得包含它。
  const pkg = JSON.parse(read('package.json'))
  assert.equal(
    pkg.files.some(entry => entry.includes('实施方案')),
    false,
    'package.json#files 不得包含内部实施方案文档',
  )

  // 已跟踪文件里不得引用该文档（否则读者在仓库里查不到）。
  const trackedTexts = ['CHANGELOG.md', 'README.md', 'SECURITY.md', 'NOTICE.md']
  for (const file of trackedTexts) {
    assert.equal(
      read(file).includes(`${internalDoc}`),
      false,
      `${file} 不应引用不在仓库内的 ${internalDoc}`,
    )
  }
})

test('元数据｜package.json 声明 repository 与 homepage（供 npm 与插件市场解析来源）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(pkg.repository?.url ?? '', /^git\+https:\/\/github\.com\/royrao2007\/mont-BidCopilot\.git$/u)
  assert.equal(pkg.homepage, 'https://github.com/royrao2007/mont-BidCopilot')
  assert.equal(pkg.author?.url, 'https://github.com/royrao2007')
})

test('元数据｜package.json 保持零依赖、无安装期脚本、声明 engines.dsh', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], '运行时依赖必须为空')
  for (const key of ['preinstall', 'install', 'postinstall']) {
    assert.equal(pkg.scripts?.[key], undefined, `不得声明 ${key}`)
  }
  assert.equal(pkg.engines.dsh, '>=0.2.2-rc.1')
  assert.match(pkg.engines.node, /^>=22\.5\.0$/u)
})

test('元数据｜顶层 description 为英文且与 locale 主张一致（不含未实现能力）', () => {
  const pkg = JSON.parse(read('package.json'))
  const hanCount = (pkg.description.match(/\p{Script=Han}/gu) ?? []).length
  assert.equal(hanCount, 0, 'package.json description 应为英文')
  assert.ok(pkg.description.includes('21'), '应写明工具数量')
  assert.ok(/no install-time scripts/iu.test(pkg.description), '应声明无安装期脚本')
  // 未实现的能力不得出现在描述里
  for (const notImplemented of ['PDF export', 'OCR', 'vector']) {
    assert.ok(
      pkg.description.toLowerCase().includes(notImplemented.toLowerCase()) === false,
      `description 不应宣称未实现的能力：${notImplemented}`,
    )
  }
})

test('元数据｜README 首屏含英文摘要与权限表（安装即授权）', () => {
  const readme = read('README.md')
  const head = readme.slice(0, 6000)

  assert.ok(/English summary/iu.test(head), 'README 首屏应有英文摘要')
  assert.ok(head.includes('权限一览'), 'README 首屏应有权限一览章节')
  assert.ok(/安装即授权/u.test(head), '须写明安装即授权')

  // 五项关键能力逐条出现
  for (const row of ['本地文件读取', '本地文件写入', '网络访问', '本机进程', '凭据']) {
    assert.ok(head.includes(row), `权限表缺少「${row}」行`)
  }
  assert.ok(head.includes('关闭插件后的变化'), '须说明关闭插件后的变化')
  assert.ok(head.includes('SECURITY.md'), '须指向完整披露文件')
})

test('元数据｜README 不得宣称未实现的能力', () => {
  const readme = read('README.md')
  // 这些能力在 v0.1.0 未实现；README 里若出现必然带「未实现/不在范围」限定
  assert.ok(readme.includes('未实现'), 'README 应明确列出未实现项')
  const claim = /(?:支持|提供)(?:PDF 导出|OCR|向量检索)/u.exec(readme)
  assert.equal(claim, null, `README 不得直接宣称未实现能力：${claim?.[0]}`)
})

test('文档｜README 的安装章节包含完整步骤（要求、安装、验证、升级、卸载、排障、数据位置）', () => {
  const readme = read('README.md')

  assert.ok(readme.includes('## 安装'), '缺安装章节')
  const required = [
    '### 环境要求',           // 版本与依赖前提
    '### 方式一：命令行安装',   // 至少一种安装途径
    '### 方式二：图形界面安装', // 第二种途径
    '### 验证安装成功',       // 装完怎么确认
    '### 升级',              // 后续怎么更新
    '### 卸载',              // 怎么移除且数据留痕
    '### 安装故障排查',       // 失败怎么办
    '### 目录与数据位置',     // 数据写在哪
  ]
  for (const section of required) {
    assert.ok(readme.includes(section), `安装章节缺少「${section}」`)
  }

  // 成功判据必须是可观察的三条，而不是「装好了」
  assert.ok(readme.includes('成功判据'), '应给出可观察的成功判据')
  assert.ok(readme.includes('fiberPhase'), '判据应包含 fiberPhase 状态')
  assert.ok(readme.includes('toolCount'), '判据应包含 toolCount 验证')

  // 卸载必须说明数据保留，避免误以为删项目
  const uninstall = readme.slice(readme.indexOf('### 卸载'), readme.indexOf('### 安装故障排查'))
  assert.ok(/保留|不会删除/u.test(uninstall), '卸载说明须交代项目目录是否保留')
})

test('文档｜README 的使用章节给出可照做的操作顺序，覆盖两侧与门禁', () => {
  const readme = read('README.md')

  assert.ok(readme.includes('## 使用方法'), '缺使用方法章节')

  // 投标侧完整链路
  assert.ok(readme.includes('### 一分钟上手：投标侧走一遍'), '缺投标侧上手流程')
  // 招标侧完整链路
  assert.ok(readme.includes('### 招标侧走一遍'), '缺招标侧上手流程')
  // 门禁命令必须可查
  assert.ok(readme.includes('### 门禁命令速查'), '缺门禁命令速查')
  // 常见问题
  assert.ok(readme.includes('### 常见问题'), '缺常见问题')

  // 每一步都要点明对应工具，否则用户不知道 agent 在调什么
  const usage = readme.slice(readme.indexOf('## 使用方法'), readme.indexOf('## 三条不可逾越的边界'))
  for (const tool of [
    'mont_project_create',
    'mont_bid_parse',
    'mont_bid_outline',
    'mont_bid_write_section',
    'mont_guard_verify_fact',
    'mont_bid_lock_facts',
    'mont_guard_similarity_check',
    'mont_bid_export',
    'mont_tender_parse',
    'mont_tender_match_industry',
    'mont_tender_draft_section',
    'mont_tender_check_consistency',
    'mont_guard_check_clause',
    'mont_guard_source_policy',
    'mont_kb_search',
  ]) {
    assert.ok(usage.includes(tool), `使用章节未提及 ${tool}，用户无法对应到工具`)
  }

  // 门禁命令必须给出可直接复制的形式
  assert.ok(usage.includes('/bidcopilot-gate'), '使用章节须给出门禁命令')
  assert.ok(usage.includes('approve gate2'), '须给出批准门2 的具体写法')
  assert.ok(usage.includes('approve gate1'), '须给出批准门1 的具体写法')

  // 导出阻断码要有解释表，否则用户看到 blocker 无法处理
  for (const code of [
    'E_UNVERIFIED_FACTS',
    'E_GATE2_NOT_APPROVED',
    'E_GATE3_NOT_APPROVED',
    'E_SELF_DUPLICATION',
    'E_COLLUSION_RISK',
  ]) {
    assert.ok(usage.includes(code), `缺少阻断码说明：${code}`)
  }
})

test('文档｜README 明确说明门禁批准只能由人执行', () => {
  const readme = read('README.md')
  const usage = readme.slice(readme.indexOf('## 使用方法'))
  assert.ok(
    /agent 做不到这一步|只能由人|由人来做|你自己在输入框/u.test(usage),
    '使用章节须明确门禁批准由人执行，agent 做不到',
  )
  assert.ok(usage.includes('mont_wf_advance'), '须提到 mont_wf_advance 的边界')
})

test('文档｜README 提到的工具名与代码注册的 21 个完全一致（无虚构、无遗漏）', () => {
  const readme = read('README.md')
  const toolsSource = read('lib/tools.js')

  const registered = new Set([...toolsSource.matchAll(/'(mont_[a-z_]+)'/gu)].map(match => match[1]))
  const mentioned = new Set([...readme.matchAll(/(mont_[a-z_]+)/gu)].map(match => match[1]))

  assert.equal(registered.size, 21, `代码应注册 21 个工具，实际 ${registered.size}`)

  const fictional = [...mentioned].filter(name => !registered.has(name))
  assert.deepEqual(fictional, [], `README 提到代码中不存在的工具：${fictional.join(',')}`)

  const undocumented = [...registered].filter(name => !mentioned.has(name))
  assert.deepEqual(undocumented, [], `以下工具未在 README 中出现：${undocumented.join(',')}`)
})
