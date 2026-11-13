/**
 * 工具注册层：把 runtime 的能力暴露为可自动调用的 mont_* 工具。
 *
 * 这是与 mont-forge（44 个 SKILL.md，只注册 skills provider）的关键差别：
 * 每个能力都是 ctx.tools.register 注册的真工具，模型可直接调用，
 * 不需要先 skill 加载、再按技能正文自行拼流程。
 *
 * 统一契约：所有工具返回 { ok: true, ... } 或 { ok: false, error: { code, message } }，
 * 让模型看到稳定错误码而不是传输异常。
 *
 * @module lib/tools
 */

import { StoreError } from './store.js'
import { FactError } from './facts.js'
import { TenderError } from './tender.js'
import { BidError } from './bid.js'

const STRING = { type: 'string' }
const NUMBER = { type: 'number' }
const BOOLEAN = { type: 'boolean' }
const OBJECT = { type: 'object' }
const STRING_ARRAY = { type: 'array', items: { type: 'string' } }

/**
 * 注册全部 mont_* 工具。
 *
 * @param {{tools?: {register: (definition: object) => () => void}}} ctx - Cordis 上下文。
 * @param {object} runtime - createRuntime 的返回值。
 * @returns {Array<() => void>} disposers
 */
export function registerTools(ctx, runtime) {
  if (typeof ctx?.tools?.register !== 'function') return []
  const disposers = []
  const registeredNames = []

  /**
   * 统一注册一个工具：JSON 输出 + 稳定错误映射 + 卡片标题。
   */
  const tool = (name, description, parameters, run) => {
    registeredNames.push(name)
    disposers.push(ctx.tools.register({
      name,
      description,
      parameters,
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      presentCall: args => ({
        card: 'generic',
        title: name,
        kind: 'other',
        rawInput: args,
      }),
      async execute(args) {
        try {
          return await run(args ?? {})
        } catch (error) {
          if (error instanceof StoreError || error instanceof FactError
            || error instanceof TenderError || error instanceof BidError) {
            return { ok: false, error: { code: error.code, message: error.message } }
          }
          return {
            ok: false,
            error: { code: 'E_INTERNAL', message: error instanceof Error ? error.message : String(error) },
          }
        }
      },
    }))
  }

  // -------------------------------------------------------------------------
  // 项目
  // -------------------------------------------------------------------------

  tool(
    'mont_project_create',
    '创建一个招投标项目。一个项目是一个目录，正文一节一文件，可跨会话恢复。先调用 mont_project_list 避免重复创建。',
    {
      type: 'object',
      properties: {
        name: { ...STRING, description: '项目名称，例如「XX市政务云平台建设项目」。' },
        id: { ...STRING, description: '可选的项目 id（字母数字与 . _ -）。省略时由名称派生并加随机后缀。' },
        kind: { ...STRING, enum: ['tender', 'bid'], description: 'tender=招标侧（招标人），bid=投标侧（投标人）。默认 tender。' },
        tenderText: { ...STRING, description: '可选：同时导入招标文件正文。' },
      },
      required: ['name'],
    },
    args => runtime.createProject(args),
  )

  tool(
    'mont_project_list',
    '列出所有项目（按更新时间倒序）。每个项目是一个独立目录，先看清单再决定新建还是续用已有项目，避免重复建项。',
    { type: 'object', properties: {} },
    () => runtime.listProjects(),
  )

  tool(
    'mont_project_status',
    '查看单个项目的完整状态：章节数、事实核验进度、三门状态、审计链完整性、是否具备导出条件。',
    {
      type: 'object',
      properties: {
        projectId: { ...STRING, description: '项目 id。' },
      },
      required: ['projectId'],
    },
    args => runtime.projectStatus(String(args.projectId)),
  )

  // -------------------------------------------------------------------------
  // 合规内核（T-B1~T-B5）
  // -------------------------------------------------------------------------

  tool(
    'mont_guard_check_clause',
    '对一段条款文本执行 T-B1~T-B5 硬阻断检查（本地分支机构、本地业绩、税收社保缴纳地、指定品牌、已取消资质）。命中即返回 blocked=true 并附法条依据；这是确定性规则匹配，不是语义判断。',
    {
      type: 'object',
      properties: {
        text: { ...STRING, description: '待检查的条款或章节正文。' },
        ruleIds: { ...STRING_ARRAY, description: '可选：只检查指定规则，如 ["T-B1","T-B3"]。' },
      },
      required: ['text'],
    },
    args => runtime.guardCheckClause(String(args.text), { ruleIds: args.ruleIds }),
  )

  tool(
    'mont_guard_verify_fact',
    '事实字段操作，三种用法：①不传 key（或不足以判定）→ 列出全部事实与未核验项；②传 key+value+source → 写入事实（禁用来源会被硬拒）；③传 key+operator → 把已填写的事实核验为 VERIFIED。只有人工核验能让事实变成 VERIFIED，模型不能自验。',
    {
      type: 'object',
      properties: {
        projectId: { ...STRING, description: '项目 id。' },
        key: { ...STRING, description: '事实字段键，如 enterpriseName、creditCode、performance。省略则列出清单。' },
        value: { ...STRING, description: '写入时的值。' },
        category: {
          ...STRING,
          description: '字段类别，决定来源策略：enterpriseName / creditCode / qualification / performance / personnel / certification / technicalApproach / performanceCommitment / other。省略时按 key 推断。',
        },
        source: {
          ...STRING,
          description: '来源：manual（人工录入）/ verified_kb（已核验企业库）/ L1 / L2 / L3。业绩、资质、人员、企业名称等类别只接受 manual 与 verified_kb。',
        },
        evidenceRef: { ...STRING, description: '证据引用，如证书编号或扫描件路径。' },
        operator: { ...STRING, description: '核验操作人。传了它就是核验动作，不是写入。' },
        action: { ...STRING, enum: ['not_applicable'], description: '传 not_applicable 表示该字段不适用。' },
        reason: { ...STRING, description: 'not_applicable 时的原因。' },
      },
      required: ['projectId'],
    },
    args => runtime.guardVerifyFact(String(args.projectId), args),
  )

  tool(
    'mont_guard_similarity_check',
    '雷同自检。两条独立规则、两个独立阈值：自我复制（自身文本 vs 模板/知识源，默认 0.85）与围标相似度（不同投标人之间，默认 0.65）。不可共用一个阈值——两者混用会在复用自家模板时大量误报。',
    {
      type: 'object',
      properties: {
        text: { ...STRING, description: '待检查的正文。' },
        templateSources: {
          type: 'array',
          description: '模板/知识源列表，用于自我复制检测。',
          items: {
            type: 'object',
            properties: { id: STRING, text: STRING },
          },
        },
        otherBidders: {
          type: 'array',
          description: '其他投标人文本，用于围标相似度检测。',
          items: {
            type: 'object',
            properties: { bidderId: STRING, text: STRING },
          },
        },
        selfDupThreshold: { ...NUMBER, description: '自我复制阈值，默认 0.85。' },
        collusionThreshold: { ...NUMBER, description: '围标阈值，默认 0.65。' },
      },
      required: ['text'],
    },
    args => runtime.guardSimilarityCheck(args),
  )

  tool(
    'mont_guard_source_policy',
    '列出事实字段的来源策略表：每个类别允许哪些来源、禁止哪些来源。写事实前可先查这张表。',
    { type: 'object', properties: {} },
    () => runtime.sourcePolicy(),
  )

  // -------------------------------------------------------------------------
  // 招标侧
  // -------------------------------------------------------------------------

  tool(
    'mont_tender_parse',
    '把自然语言需求结构化为招标字段（标的类型、预算、工期、功能指标、资格线索、知识产权），并做行业匹配、给出章节骨架。缺失项标记为待招标人补充，不臆造。',
    {
      type: 'object',
      properties: {
        text: { ...STRING, description: '需求描述原文。' },
        projectId: { ...STRING, description: '可选：把需求与原文存进该项目。' },
      },
      required: ['text'],
    },
    args => runtime.tenderParse(args),
  )

  tool(
    'mont_tender_match_industry',
    '按关键词匹配行业骨架（8 个行业 + 通用回退），返回章节骨架与置信度。低于阈值 0.3 回退 general 并提示行业骨架待补充。',
    {
      type: 'object',
      properties: {
        text: { ...STRING, description: '需求或招标文件正文。' },
      },
      required: ['text'],
    },
    args => runtime.tenderMatchIndustry(String(args.text)),
  )

  tool(
    'mont_tender_draft_section',
    '生成单节招标草案。**生成前先过 T-B1~T-B5 硬阻断**：命中即返回 generated=false 且不给出条款文本，模型拿不到可用条款。合同类章节自动标记 requiresLegalReview。',
    {
      type: 'object',
      properties: {
        sectionId: { ...STRING, description: '章节 id，如 qualification / technical / evaluation / contract。' },
        title: { ...STRING, description: '章节标题。' },
        content: { ...STRING, description: '拟写入的条款正文（候选文本）。' },
        projectId: { ...STRING, description: '可选：生成的章节写入该项目。' },
        requirements: { ...OBJECT, description: '可选：结构化需求，用于生成「待招标人补充」标记。' },
      },
      required: ['sectionId', 'content'],
    },
    args => runtime.tenderDraftSection(args),
  )

  tool(
    'mont_tender_check_consistency',
    '跨板块一致性校验：预算 vs 合同金额、工期表述、评审办法的评分项是否有需求条款支撑。只输出「待确认」，不自动修正——修正是人的决定。',
    {
      type: 'object',
      properties: {
        projectId: { ...STRING, description: '项目 id（读取该项目的全部章节做校验）。' },
        sections: {
          type: 'array',
          description: '或直接传入章节数组。',
          items: { type: 'object', properties: { sectionId: STRING, content: STRING } },
        },
      },
    },
    args => runtime.tenderCheckConsistency(args),
  )

  // -------------------------------------------------------------------------
  // 投标侧
  // -------------------------------------------------------------------------

  tool(
    'mont_bid_parse',
    '解析招标文件为 18 项结构化字段 + ★实质性条款 + 评分表。缺项如实返回 null 并计入 coverage，不臆造。',
    {
      type: 'object',
      properties: {
        text: { ...STRING, description: '招标文件正文。' },
        projectId: { ...STRING, description: '可选：把原文与解析结果存进该项目。' },
      },
      required: ['text'],
    },
    args => runtime.bidParse(args),
  )

  tool(
    'mont_bid_outline',
    '按评分标准生成对齐目录：每个评分细则映射为一个二级章节，按分值权重分配字数，并把 ★ 条款挂到必须响应它的章节；未挂载的 ★ 条款单独列出警告。',
    {
      type: 'object',
      properties: {
        projectId: { ...STRING, description: '项目 id（用于保存目录）。' },
        text: { ...STRING, description: '招标文件正文（内部会先解析）。' },
        parseResult: { ...OBJECT, description: '或直接传入 mont_bid_parse 的结果。' },
        targetWords: { ...NUMBER, description: '全文目标字数，默认 60000。' },
      },
    },
    args => runtime.bidOutline(args),
  )

  tool(
    'mont_bid_write_section',
    '写投标章节正文，一节一文件（长度只受磁盘限制）。传 append=true 可续写同一节。返回该段文本的来源标签统计（L1/L2/L3）与未标注风险提示。',
    {
      type: 'object',
      properties: {
        projectId: { ...STRING, description: '项目 id。' },
        sectionId: { ...STRING, description: '章节 id。' },
        content: { ...STRING, description: '章节正文。' },
        append: { ...BOOLEAN, description: 'true 表示追加到该节末尾。' },
      },
      required: ['projectId', 'sectionId', 'content'],
    },
    args => runtime.bidWriteSection(args),
  )

  tool(
    'mont_bid_lock_facts',
    '锁定事实：固化事实快照、统计已核验/未核验数量、检查同一值被不同键重复使用的一致性冲突。存在未核验事实时 blocked=true（导出将被阻断）。',
    {
      type: 'object',
      properties: {
        projectId: { ...STRING, description: '项目 id。' },
      },
      required: ['projectId'],
    },
    args => runtime.bidLockFacts(String(args.projectId)),
  )

  tool(
    'mont_bid_export',
    '导出 .docx。**前置五道检查任一不过即拒绝导出**：①无未核验事实 ②门2 已批准 ③门3 已批准 ④自我复制未超阈值 ⑤围标相似度未超阈值。通过后生成纯 JS OOXML 文档。',
    {
      type: 'object',
      properties: {
        projectId: { ...STRING, description: '项目 id。' },
        fileName: { ...STRING, description: '导出文件名（.docx）。默认 <projectId>-draft.docx。' },
        title: { ...STRING, description: '文档标题。默认项目名。' },
        templateSources: {
          type: 'array',
          description: '模板/知识源，用于自我复制检测。',
          items: { type: 'object', properties: { id: STRING, text: STRING } },
        },
        otherBidders: {
          type: 'array',
          description: '其他投标人文本，用于围标相似度检测。',
          items: { type: 'object', properties: { bidderId: STRING, text: STRING } },
        },
        selfDupThreshold: { ...NUMBER, description: '覆盖默认自我复制阈值 0.85。' },
        collusionThreshold: { ...NUMBER, description: '覆盖默认围标阈值 0.65。' },
      },
      required: ['projectId'],
    },
    args => runtime.bidExport(args),
  )

  tool(
    'mont_bid_pending_checklist',
    '无企业资料时的诚实输出：生成待核验事实清单（企业名称、信用代码、资质、业绩、人员、检测结论、性能承诺），每项附所需证明材料类型。输出是标注完备的草案，不是可直接递交的标书。',
    {
      type: 'object',
      properties: {
        includePolicy: { ...BOOLEAN, description: '是否附带每项的允许来源策略。' },
      },
    },
    args => runtime.bidPendingChecklist(args),
  )

  // -------------------------------------------------------------------------
  // 知识检索（显式门控）
  // -------------------------------------------------------------------------

  tool(
    'mont_kb_search',
    '检索企业知识库（BM25 + 中文 bigram）。**门控 fail-closed**：必须在 userText 中带上用户点名原话，或显式传 explicit=true；否则拒绝检索并返回可读理由。sync=true 会先重建索引。',
    {
      type: 'object',
      properties: {
        query: { ...STRING, description: '检索查询。' },
        userText: { ...STRING, description: '本轮用户的原话（用于门控判定）。' },
        explicit: { ...BOOLEAN, description: '显式声明用户已点名要求检索。' },
        sync: { ...BOOLEAN, description: 'true 表示先重建索引。' },
        limit: { ...NUMBER, description: '返回条数，默认 10。' },
        triggers: { ...STRING_ARRAY, description: '可选：自定义触发词。' },
      },
      required: ['query'],
    },
    args => runtime.kbSearch(args),
  )

  tool(
    'mont_kb_index',
    '重建知识库索引。返回文档数、块数、可用的文件名与目录名。',
    { type: 'object', properties: {} },
    () => runtime.kbBuildIndex(),
  )

  // -------------------------------------------------------------------------
  // 工作流（不含 approve）
  // -------------------------------------------------------------------------

  tool(
    'mont_wf_advance',
    '工作流状态查询与推进检查。action=status 看三门状态与审计链；action=check 判断某门能否放行。**本工具不提供 approve/reject**：门禁批准只能由界面门禁面板发起，模型 agent 无批准通道。',
    {
      type: 'object',
      properties: {
        projectId: { ...STRING, description: '项目 id。' },
        gateId: { ...STRING, enum: ['gate1', 'gate2', 'gate3'], description: '门编号，action=check 时必填。' },
        action: { ...STRING, enum: ['status', 'check'], description: '动作。默认 status。' },
      },
      required: ['projectId'],
    },
    args => runtime.wfAdvance(args),
  )

  // -------------------------------------------------------------------------
  // 元信息
  // -------------------------------------------------------------------------

  tool(
    'mont_ping',
    '确认 mont-BidCopilot 已加载并可用：返回版本、DSH 版本要求、数据目录、当前阈值、已注册工具清单与权限摘要。',
    { type: 'object', properties: {} },
    () => runtime.ping(),
  )

  // 回填真实工具数与名称，供 mont_ping 如实报告（不硬编码，避免与实际注册漂移）。
  if (typeof runtime.reportTools === 'function') {
    runtime.reportTools(registeredNames)
  }

  return disposers
}
