/**
 * 轻量任务进度：纯文件系统落盘，可跨会话查询与恢复。
 *
 * 设计取舍：不引入后台常驻进程、不引入 SQLite。
 * 每个任务一条记录，写入 project.json 的 `tasks` 数组（append-only 风格，
 * 更新时按 id 覆盖，保留 createdAt）。状态机为显式枚举，避免自由文本漂移。
 *
 * @module lib/task
 */

/** 任务状态：显式枚举，不做语义猜测。 */
export const TASK_STATUS = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
})

/** 终态集合：处于终态的任务不可再更新（除显式重启）。 */
const TERMINAL = new Set([TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELED])

export class TaskError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TaskError'
    this.code = code
  }
}

/**
 * 创建一条任务记录（纯函数，直接改 project.tasks）。
 *
 * @param {object} project
 * @param {{id?:string, kind:string, label?:string, total?:number, meta?:object}} input
 * @returns {object} task
 */
export function createTask(project, input) {
  const kind = String(input?.kind ?? '').trim()
  if (kind.length === 0) throw new TaskError('E_TASK_KIND_REQUIRED', '任务 kind 不能为空。')
  const tasks = Array.isArray(project.tasks) ? project.tasks : []
  const id = String(input?.id ?? `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  if (tasks.some(task => task.id === id)) {
    throw new TaskError('E_TASK_ID_DUPLICATE', `任务 id 已存在：${id}`)
  }
  const now = new Date().toISOString()
  const task = {
    id,
    kind,
    label: String(input?.label ?? kind),
    status: TASK_STATUS.PENDING,
    total: Number.isFinite(input?.total) ? Math.max(0, Number(input.total)) : 0,
    done: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    meta: input?.meta ?? {},
    note: null,
  }
  tasks.push(task)
  project.tasks = tasks
  return task
}

/**
 * 更新任务进度（纯函数）。
 *
 * @param {object} project
 * @param {string} id
 * @param {{status?:string, done?:number, total?:number, note?:string, increment?:number, force?:boolean}} input
 * @returns {object} task
 */
export function updateTask(project, id, input = {}) {
  const tasks = Array.isArray(project.tasks) ? project.tasks : []
  const task = tasks.find(item => item.id === String(id))
  if (task === undefined) throw new TaskError('E_TASK_NOT_FOUND', `任务 ${id} 不存在。`)

  if (TERMINAL.has(task.status) && input.force !== true) {
    throw new TaskError('E_TASK_TERMINAL', `任务 ${id} 已处于终态 ${task.status}，不可再更新（如需重启请传 force）。`)
  }

  if (input.status !== undefined) {
    if (!Object.values(TASK_STATUS).includes(input.status)) {
      throw new TaskError('E_TASK_STATUS_INVALID', `未知状态：${input.status}`)
    }
    task.status = input.status
    if (task.status === TASK_STATUS.RUNNING && task.startedAt === null) task.startedAt = new Date().toISOString()
    if (TERMINAL.has(task.status)) task.finishedAt = new Date().toISOString()
    // force 重启：清掉终态时间戳，允许重新执行。
    if (input.force === true && !TERMINAL.has(task.status)) task.finishedAt = null
  }
  if (Number.isFinite(input.total)) task.total = Math.max(0, Number(input.total))
  if (Number.isFinite(input.done)) task.done = Math.max(0, Math.min(task.total || Infinity, Number(input.done)))
  if (Number.isFinite(input.increment)) {
    task.done = Math.max(0, Math.min(task.total || Infinity, task.done + Number(input.increment)))
  }
  if (typeof input.note === 'string') task.note = input.note
  task.updatedAt = new Date().toISOString()
  return task
}

/**
 * 列出任务，可按 kind / status 过滤。
 *
 * @param {object} project
 * @param {{kind?:string, status?:string}} [filter]
 * @returns {Array<object>}
 */
export function listTasks(project, filter = {}) {
  const tasks = Array.isArray(project.tasks) ? project.tasks : []
  return tasks
    .filter(task => filter.kind === undefined || task.kind === filter.kind)
    .filter(task => filter.status === undefined || task.status === filter.status)
    .map(task => ({ ...task, progress: percent(task) }))
}

/**
 * 汇总：总任务数、按状态分布、总体进度、是否存在进行中任务。
 *
 * @param {object} project
 * @returns {object}
 */
export function taskSummary(project) {
  const tasks = Array.isArray(project.tasks) ? project.tasks : []
  const byStatus = {}
  for (const status of Object.values(TASK_STATUS)) byStatus[status] = 0
  for (const task of tasks) if (Object.hasOwn(byStatus, task.status)) byStatus[task.status] += 1
  const totalUnits = tasks.reduce((sum, task) => sum + (task.total || 0), 0)
  const doneUnits = tasks.reduce((sum, task) => sum + (task.done || 0), 0)
  return {
    ok: true,
    total: tasks.length,
    byStatus,
    running: byStatus[TASK_STATUS.RUNNING],
    unfinished: tasks.filter(task => !TERMINAL.has(task.status)).length,
    totalUnits,
    doneUnits,
    overallPercent: totalUnits > 0 ? Math.round((doneUnits / totalUnits) * 1000) / 10 : 0,
    // 可恢复 = 非终态且曾启动过（中断后可从磁盘继续）。
    resumable: tasks.filter(task => !TERMINAL.has(task.status) && task.startedAt !== null).map(task => task.id),
    notice: '任务状态落在 project.json 的 tasks 数组，跨会话可读；本实现不启动后台进程，恢复由调用方按 id 续跑。',
  }
}

/** @param {object} task */
function percent(task) {
  if (!task.total) return 0
  return Math.round((Math.min(task.done, task.total) / task.total) * 1000) / 10
}
