/**
 * 组五：门禁人机通道。
 *
 * 这三条边界必须一直成立，否则「门禁即控制流」就退化成提示词：
 *   1. `mont_*` 工具里**不存在**任何批准/拒绝能力；
 *   2. slash command 是人键入才执行的通道，且它能真正写审计链；
 *   3. 未解决项挡住放行、拒绝即冻结、重复裁决被拒。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

/**
 * 搭建一个贴近 Cordis 语义的 Host 上下文。
 *
 * 关键点：`ctx.inject(['commands'], cb)` 的回调收到的是**派生 ctx**，
 * 它携带该服务且具备 effect；回调本身返回 void（不是 disposer）。
 */
function makeHost() {
  const tools = new Map()
  const commands = new Map()

  const commandsService = {
    register(definition) {
      commands.set(definition.name, definition)
      return () => commands.delete(definition.name)
    },
  }

  const makeChild = () => ({
    commands: commandsService,
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  })

  const effects = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(fn) {
      effects.push(fn)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    provide() {
      return () => {}
    },
    get(name) {
      return name === 'commands' ? commandsService : undefined
    },
    inject(dependencies, callback) {
      if (dependencies.every(dependency => dependency === 'commands')) callback(makeChild())
    },
  }
  return { ctx, tools, commands, effects }
}

async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), 'mbc-gatechan-'))
  const host = makeHost()
  apply(host.ctx, { dataDir, allowWrite: true })
  await new Promise(resolve => setTimeout(resolve, 400))
  const call = (name, args) => host.tools.get(name).execute(args)
  const invoke = raw => host.commands.get('bidcopilot-gate').handler({
    commandId: 'test-command',
    agent: { id: 'test-session' },
    rawInput: raw,
    attachments: [],
    signal: new AbortController().signal,
  })
  return { ...host, dataDir, call, invoke }
}

async function withHost(fn) {
  const host = await boot()
  try {
    return await fn(host)
  } finally {
    await rm(host.dataDir, { recursive: true, force: true })
  }
}

/** 造一个已核验基本事实、写过正文的项目。 */
async function prepareProject(host, name = '通道测试项目') {
  const created = await host.call('mont_project_create', { name, kind: 'bid' })
  const projectId = created.project.id
  await host.call('mont_bid_write_section', {
    projectId,
    sectionId: 'section-01',
    content: '本项目围绕设备运维响应时效展开，强调备件库与现场工程师的联动机制。',
  })
  await host.call('mont_guard_verify_fact', {
    projectId, key: 'enterpriseName', value: '测试科技有限公司', source: 'manual',
  })
  return projectId
}

// ---------------------------------------------------------------------------
// 边界一：工具面没有批准能力
// ---------------------------------------------------------------------------

test('人机通道｜工具清单中不存在任何批准/拒绝/签署工具', async () => {
  await withHost(async host => {
    // 必须等到异步内核自检完成、工具注册结束。
    assert.ok(host.tools.size > 0, '工具应已注册')
    const names = [...host.tools.keys()]
    const approvalLike = names.filter(name => /approve|reject|sign|批准|签署|agree/iu.test(name))
    assert.deepEqual(approvalLike, [], `不应存在批准类工具，实际：${approvalLike.join(',')}`)
    assert.ok(names.includes('mont_wf_advance'), '只保留状态查询与推进检查')
  })
})

test('人机通道｜mont_wf_advance 对 approve/reject/sign 一律硬拒', async () => {
  await withHost(async host => {
    const projectId = await prepareProject(host)
    for (const action of ['approve', 'reject', 'sign']) {
      const result = await host.call('mont_wf_advance', { projectId, gateId: 'gate2', action })
      assert.equal(result.ok, false, `action=${action} 必须被拒`)
      assert.equal(result.code, 'E_GATE_MODEL_APPROVAL_FORBIDDEN')
    }
    // 被拒后状态不变。
    const status = await host.call('mont_wf_advance', { projectId, action: 'status' })
    assert.equal(status.gates.gate2.status, 'PENDING')
  })
})

// ---------------------------------------------------------------------------
// 边界二：命令通道存在且能写审计链
// ---------------------------------------------------------------------------

test('人机通道｜注册了 bidcopilot-gate 命令', async () => {
  await withHost(async host => {
    assert.equal(host.commands.size, 1, '应注册一条门禁命令')
    const definition = host.commands.get('bidcopilot-gate')
    assert.ok(definition !== undefined, '命令名应为 bidcopilot-gate')
    assert.equal(typeof definition.handler, 'function')
    assert.ok(definition.description.includes('只有人能执行'), '描述须声明仅人能执行')
  })
})

test('人机通道｜命令 show 返回三门状态并标注未决', async () => {
  await withHost(async host => {
    const projectId = await prepareProject(host)
    const result = await host.invoke(`${projectId} show`)
    assert.equal(result.kind, 'success')
    assert.ok(result.text.includes('gate1'))
    assert.ok(result.text.includes('PENDING'))
    assert.ok(result.text.includes('审计链有效'))
    assert.ok(result.text.includes('可导出'))
  })
})

test('人机通道｜命令 approve 写入审计链并可导出', async () => {
  await withHost(async host => {
    const projectId = await prepareProject(host)
    await host.call('mont_guard_verify_fact', {
      projectId, key: 'creditCode', value: '91110000MA00000001', source: 'manual',
    })

    const gate2 = await host.invoke(`${projectId} approve gate2 张三`)
    assert.equal(gate2.kind, 'success')
    assert.ok(gate2.text.includes('门2'))
    assert.ok(gate2.text.includes('seq 1'))

    const gate3 = await host.invoke(`${projectId} approve gate3 李四`)
    assert.equal(gate3.kind, 'success')
    assert.ok(gate3.text.includes('seq 2'))

    const status = await host.call('mont_wf_advance', { projectId, action: 'status' })
    assert.equal(status.auditChain.valid, true)
    assert.equal(status.auditChain.records.length, 2)
    assert.equal(status.gates.gate2.decidedBy, '张三')
    assert.equal(status.gates.gate3.decidedBy, '李四')

    const exported = await host.call('mont_bid_export', { projectId, title: '通道测试标书' })
    assert.equal(exported.exported, true, `应可导出，blockers=${JSON.stringify(exported.blockers)}`)
    assert.ok(exported.bytes > 0)
  })
})

// ---------------------------------------------------------------------------
// 边界三：未解决项 / 冻结 / 重复裁决
// ---------------------------------------------------------------------------

test('人机通道｜存在未核验事实时 approve 被拒并列出项目', async () => {
  await withHost(async host => {
    const projectId = await prepareProject(host)
    // 造一条空值事实 → UNVERIFIED
    await host.call('mont_guard_verify_fact', { projectId, key: 'creditCode', value: '', source: 'manual' })

    const result = await host.invoke(`${projectId} approve gate2 张三`)
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('E_GATE_UNRESOLVED_ITEMS'))
    assert.ok(result.text.includes('creditCode'))

    const status = await host.call('mont_wf_advance', { projectId, action: 'status' })
    assert.equal(status.gates.gate2.status, 'PENDING', '被拒后门禁必须仍是未决')
  })
})

test('人机通道｜reject 使工作流冻结且不可再推进', async () => {
  await withHost(async host => {
    const projectId = await prepareProject(host)
    const rejected = await host.invoke(`${projectId} reject gate3 法务 合同条款存在实质风险`)
    assert.equal(rejected.kind, 'success')

    const status = await host.call('mont_wf_advance', { projectId, action: 'status' })
    assert.equal(status.frozen, true)
    assert.equal(status.gates.gate3.status, 'REJECTED')

    // 冻结后门2也不能批准
    await host.call('mont_guard_verify_fact', {
      projectId, key: 'creditCode', value: '91110000MA00000001', source: 'manual',
    })
    const afterFreeze = await host.invoke(`${projectId} approve gate2 张三`)
    assert.equal(afterFreeze.kind, 'error')
    assert.ok(afterFreeze.text.includes('E_WORKFLOW_FROZEN'))
  })
})

test('人机通道｜同一门不能裁决两次', async () => {
  await withHost(async host => {
    const projectId = await prepareProject(host)
    await host.call('mont_guard_verify_fact', {
      projectId, key: 'creditCode', value: '91110000MA00000001', source: 'manual',
    })
    assert.equal((await host.invoke(`${projectId} approve gate2 张三`)).kind, 'success')
    const again = await host.invoke(`${projectId} approve gate2 李四`)
    assert.equal(again.kind, 'error')
    assert.ok(again.text.includes('E_GATE_ALREADY_DECIDED'))
  })
})

test('人机通道｜命令缺参数时给出用法而非崩溃', async () => {
  await withHost(async host => {
    const empty = await host.invoke('')
    assert.equal(empty.kind, 'error')
    assert.ok(empty.text.includes('用法'))

    const unknownProject = await host.invoke('not-exist show')
    assert.equal(unknownProject.kind, 'error')

    const missingGate = await host.invoke('not-exist approve')
    assert.equal(missingGate.kind, 'error')
    assert.ok(missingGate.text.includes('缺少门编号') || missingGate.text.includes('用法'))

    const missingOperator = await host.invoke('not-exist approve gate2')
    assert.equal(missingOperator.kind, 'error')
    assert.ok(missingOperator.text.includes('操作人'))
  })
})
