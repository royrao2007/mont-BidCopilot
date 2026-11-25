# mont-BidCopilot 接口文档

> 本文件是接口的**唯一准绳**。改代码前必读；接口变更后立即同步。
> 行号以 2026-11-25 核对为准，指向 `lib/tools.js` 中 `tool(...)` 调用的起始行。

**适用版本**：dsh-mont-bidcopilot 0.5.0
**宿主基线**：DSH 0.2.2-rc.5 / cordis 4.1.0

---

## 〇、接口类型总览

本项目实际存在的接口类型：

| 类型 | 是否存在 | 位置 |
|---|---|---|
| **工具方法**（模型可调用） | ✅ 存在，32 个 | `lib/tools.js` |
| **内部命令**（人在输入框执行） | ✅ 存在，1 个 | `index.js:339` |
| **Host 服务**（同进程插件调用） | ✅ 存在，1 个 | `index.js:306` |
| HTTP / RPC 接口 | ❌ **本项目无此类接口** | — |
| 事件与回调（对外 emit/on） | ❌ **本项目无此类接口** | — |

> 说明：本插件是被宿主调用的被动组件，不监听也不抛出 Cordis 事件；错误通过工具返回值的 `{ ok:false, error:{ code, message } }` 传递，不通过异常冒泡给宿主。

---

## 一、工具方法（32 个）

### 统一契约

**返回结构**（所有工具一致）：

```jsonc
// 成功
{ "ok": true, /* 各工具自有字段 */ }

// 失败
{ "ok": false, "error": { "code": "E_XXX", "message": "人类可读说明" } }
```

**错误映射**（`lib/tools.js` 的 execute 包装）：

| 来源异常类 | 行为 |
|---|---|
| `StoreError` / `FactError` / `TenderError` / `BidError` / `TaskError` | 原样透出 `error.code` 与 `error.message` |
| 其他任何异常 | 归一为 `{ code: 'E_INTERNAL', message }` |

**只读准入**：14 个写工具带步骤准入条件。`allowWrite=false` 时它们**不出现在模型工具声明中**（不是调用后报错）。下表「写」列标注。

---

### 1.1 项目（3 个）

#### `mont_project_create` — 创建项目　【写】
- **实现**：`lib/tools.js:135` → `runtime.createProject`
- **入参**
  | 名 | 类型 | 必填 | 取值/默认 | 说明 |
  |---|---|---|---|---|
  | `name` | string | ✅ | 非空 | 项目名称 |
  | `id` | string | — | 字母数字与 `. _ -` | 省略时由名称派生并加随机后缀 |
  | `kind` | string | — | `tender`（默认）/ `bid` | tender=招标侧，bid=投标侧 |
  | `tenderText` | string | — | — | 可选：同时导入招标文件正文 |
- **返回**：`{ ok, project: { id, name, kind, createdAt, updatedAt, sections[], facts[], gateRecords[], ... } }`
- **错误码**
  | code | 触发条件 |
  |---|---|
  | `E_NAME_REQUIRED` | `name` 为空或全空白 |
  | `E_BAD_ID` | `id` 含非法字符 |
  | `E_PROJECT_EXISTS` | 同 id 目录已存在 |
  | `E_READONLY` | `allowWrite=false`（执行层兜底；正常情况工具已被摘除） |
- **调用方**：模型直接调用

#### `mont_project_list` — 列出项目
- **实现**：`lib/tools.js:151` → `runtime.listProjects`
- **入参**：无
- **返回**：`{ ok, projects: [{ id, name, kind, updatedAt, sectionCount, ... }] }`（按更新时间倒序）
- **错误码**：通用 `E_INTERNAL`
- **调用方**：模型

#### `mont_project_status` — 项目状态
- **实现**：`lib/tools.js:158` → `runtime.projectStatus`
- **入参**
  | 名 | 类型 | 必填 |
  |---|---|---|
  | `projectId` | string | ✅ |
- **返回**：`{ ok, project, sections, facts:{total,verified,unverified}, gates, auditValid, exportReady }`
- **错误码**：`E_PROJECT_NOT_FOUND`
- **调用方**：模型

---

### 1.2 合规内核（4 个）

#### `mont_guard_check_clause` — 条款硬阻断检查
- **实现**：`lib/tools.js:175` → `runtime.guardCheckClause` → `guard.checkClause`
- **入参**
  | 名 | 类型 | 必填 | 说明 |
  |---|---|---|---|
  | `text` | string | ✅ | 待检查条款正文 |
  | `ruleIds` | string[] | — | 只检查指定规则，如 `["T-B1","T-B3"]` |
- **返回**：`{ ok, blocked:boolean, hits:[{ ruleId, matched, basis }] }`
- **错误码**：`E_TEXT_REQUIRED`
- **确定性保证**：规则匹配，非语义判断

#### `mont_guard_verify_fact` — 事实字段操作（三态）　【写】
- **实现**：`lib/tools.js:189` → `runtime.guardVerifyFact`
- **入参**
  | 名 | 类型 | 必填 | 取值/默认 | 说明 |
  |---|---|---|---|---|
  | `projectId` | string | ✅ | — | |
  | `key` | string | — | 如 `enterpriseName` | 省略 → 列出全部事实清单 |
  | `value` | string | — | — | 写入时的值 |
  | `category` | string | — | `enterpriseName`/`creditCode`/`qualification`/`performance`/`personnel`/`certification`/`technicalApproach`/`performanceCommitment`/`other` | 决定来源策略；省略按 key 推断 |
  | `source` | string | — | `manual`/`verified_kb`/`L1`/`L2`/`L3` | 业绩、资质、人员、企业名称只接受 `manual` 与 `verified_kb` |
  | `evidenceRef` | string | — | — | 证据引用 |
  | `operator` | string | — | — | 传了即核验动作（非写入） |
  | `action` | string | — | `not_applicable` | 标记不适用 |
  | `reason` | string | — | — | 不适用原因 |
- **返回**：三态之一 —— `{ ok, facts:[...] }` / `{ ok, fact:{...} }` / `{ ok, verified:true }`
- **错误码**
  | code | 触发条件 |
  |---|---|
  | `E_FACT_KEY_REQUIRED` | 未传 key 且无法推断 |
  | `E_FACT_NOT_FOUND` | 指定的 fact 不存在 |
  | `E_FACT_EMPTY` | 写入值为空 |
  | `E_FACT_SOURCE_REQUIRED` | 写入但未给 source |
  | `E_FACT_SOURCE_REJECTED` | source 不在该 category 白名单内 |
  | `E_OPERATOR_REQUIRED` | 核验动作未给 operator |
- **铁律**：只有人工核验能让事实变成 VERIFIED，模型不能自验

#### `mont_guard_similarity_check` — 雷同自检（双阈值）
- **实现**：`lib/tools.js:216` → `runtime.guardSimilarityCheck`
- **入参**
  | 名 | 类型 | 必填 | 默认 | 说明 |
  |---|---|---|---|---|
  | `text` | string | ✅ | — | 待检查正文 |
  | `templateSources` | `{id,text}[]` | — | — | 自我复制检测用 |
  | `otherBidders` | `{bidderId,text}[]` | — | — | 围标相似度用 |
  | `selfDupThreshold` | number | — | 0.85 | 覆盖配置 |
  | `collusionThreshold` | number | — | 0.65 | 覆盖配置 |
- **返回**：`{ ok, selfDuplication:{score,threshold,exceeded}, collusion:[{bidderId,score,threshold,exceeded}] }`
- **设计约束**：两条独立规则、两个独立阈值，**不可共用**——混用会在复用自家模板时大量误报
- **错误码**：`E_TEXT_REQUIRED`

#### `mont_guard_source_policy` — 来源策略表
- **实现**：`lib/tools.js:247` → `runtime.sourcePolicy`
- **入参**：无
- **返回**：`{ ok, policy: { <category>: { allowed:[...], denied:[...] } } }`

---

### 1.3 招标侧（4 个）

#### `mont_tender_parse` — 解析招标文件　【写】
- **实现**：`lib/tools.js:258` → `runtime.tenderParse`
- **入参**
  | 名 | 类型 | 必填 |
  |---|---|---|
  | `text` | string | ✅ |
  | `projectId` | string | — （给了则落盘） |
- **返回**：`{ ok, fields:{...20 项}, starClauses:[...], coverage:{...} }`；缺项为 `null` 不臆造
- **错误码**：`E_TEXT_REQUIRED`、`E_PROJECT_NOT_FOUND`

#### `mont_tender_match_industry` — 行业骨架匹配
- **实现**：`lib/tools.js:272` → `runtime.tenderMatchIndustry` → `industry.matchIndustry`
- **入参**：`text`（string，✅）
- **返回**：`{ ok, industry:{id,name}, confidence:number, sections:[...] }`；置信度 <0.3 回退 `general`

#### `mont_tender_draft_section` — 起草招标章节　【写】
- **实现**：`lib/tools.js:285` → `runtime.tenderDraftSection`
- **入参**
  | 名 | 类型 | 必填 | 默认 |
  |---|---|---|---|
  | `sectionId` | string | ✅ | — |
  | `content` | string | ✅ | — |
  | `title` | string | — | — |
  | `projectId` | string | — | — |
  | `requirements` | object | — | — |
  | `attachPolicyBasis` | boolean | — | `true` |
- **返回**：`{ ok, section, blocked, policyBasis, requiresLegalReview }`
- **错误码**：`E_SECTION_ID_REQUIRED`、`E_TEXT_REQUIRED`；**T-B 命中时 `generated=false` 且不返回条款文本**
- **合规红线**：硬阻断命中时不产出可用条款，模型拿不到正文

#### `mont_tender_check_consistency` — 跨板块一致性校验
- **实现**：`lib/tools.js:303` → `runtime.tenderCheckConsistency`
- **入参**：`projectId`（string，—）、`sections`（array，—）
- **返回**：`{ ok, pendingConfirmation:[{topic, detail}], autoFixed:false }`
- **设计约束**：只输出"待确认"，**不自动修正**——修正是人的决定

---

### 1.4 政策依据（3 个）

#### `mont_policy_search` — 检索政策依据
- **实现**：`lib/tools.js:324` → `runtime.policySearch` → `policy.searchPolicies`
- **入参**
  | 名 | 类型 | 必填 | 默认 |
  |---|---|---|---|
  | `query` | string | — | — |
  | `section` | string | — | — （如 `qualification`/`technical`/`evaluation`/`contract`） |
  | `topics` | string[] | — | — |
  | `limit` | number | — | 10（上限 50） |
- **返回**：`{ ok, hits:[{ id, title, level, effectiveAt, sections, matchedKeywords }] }`
- **诚实声明**：未命中仅表示内置库未收录，**不代表不存在相关规定**

#### `mont_policy_by_section` — 按章节列出依据
- **实现**：`lib/tools.js:339` → `runtime.policyBySection`
- **入参**：`sections`（string[]，—）；省略则返回全部章节
- **返回**：`{ ok, bySection:{ <section>: [...] } }`

#### `mont_policy_library_info` — 库元信息
- **实现**：`lib/tools.js:351` → `runtime.policyLibraryInfo`
- **入参**：无
- **返回**：`{ ok, version, updatedAt, total, byLevel }`

---

### 1.5 投标侧（7 个）

#### `mont_bid_parse` — 解析招标文件（投标侧）　【写】
- **实现**：`lib/tools.js:362` → `runtime.bidParse`
- **入参**：`text`（✅）、`projectId`（—）
- **返回**：`{ ok, fields, starClauses, scoreTable }`

#### `mont_bid_outline` — 生成评分对齐目录　【写】
- **实现**：`lib/tools.js:376` → `runtime.bidOutline` → `bid.planOutline`
- **入参**
  | 名 | 类型 | 必填 | 默认 |
  |---|---|---|---|
  | `projectId` | string | — | — |
  | `text` | string | — | — |
  | `parseResult` | object | — | 可直接传 `mont_bid_parse` 的结果 |
  | `targetWords` | number | — | 60000 |
- **返回**：`{ ok, chapters:[{ sectionId, title, scoreItem, scoreWeight, wordBudget }] }`
- **规则**：每个评分细则映射为一个二级章节，按分值权重分配字数；★ 条款挂到必须响应它的章节

#### `mont_bid_write_section` — 写投标章节　【写】
- **实现**：`lib/tools.js:391` → `runtime.bidWriteSection` → `store.writeSection`
- **入参**
  | 名 | 类型 | 必填 | 说明 |
  |---|---|---|---|
  | `projectId` | string | ✅ | |
  | `sectionId` | string | ✅ | |
  | `content` | string | ✅ | |
  | `append` | boolean | — | `true` 追加到末尾 |
- **返回**：`{ ok, section, sourceLabels:{L1,L2,L3}, unlabeledRisk:boolean }`
- **错误码**：`E_PROJECT_NOT_FOUND`、`E_SECTION_ID_REQUIRED`、`E_TEXT_REQUIRED`

#### `mont_bid_lock_facts` — 锁定事实　【写】
- **实现**：`lib/tools.js:407` → `runtime.bidLockFacts` → `bid.lockFacts`
- **入参**：`projectId`（✅）
- **返回**：`{ ok, snapshot, verified, unverified, blocked, conflicts:[...] }`
- **说明**：存在未核验事实时 `blocked=true`（导出将被阻断）；同值不同键的一致性冲突在此发现

#### `mont_bid_export` — 导出 .docx　【写】
- **实现**：`lib/tools.js:420` → `runtime.bidExport`
- **入参**
  | 名 | 类型 | 必填 | 默认 | 说明 |
  |---|---|---|---|---|
  | `projectId` | string | ✅ | — | |
  | `fileName` | string | — | `<projectId>-draft.docx` | |
  | `title` | string | — | 项目名 | |
  | `templateSources` | `{id,text}[]` | — | — | 自我复制检测 |
  | `otherBidders` | `{bidderId,text}[]` | — | — | 围标相似度检测 |
  | `selfDupThreshold` | number | — | 0.85 | |
  | `collusionThreshold` | number | — | 0.65 | |
  | `acknowledged` | string[] | — | — | 人工确认的误报 code（如 `E_SELF_DUPLICATION`），确认后不阻断但保留在报告中 |
- **返回**：`{ ok, path, report, blocked, blockers:[...] }`
- **错误码**
  | code | 触发条件 |
  |---|---|
  | `E_UNVERIFIED_FACTS` | 存在未核验事实 |
  | `E_SELF_DUPLICATION` | 自我复制超阈值 |
  | `E_COLLUSION_RISK` | 围标相似度超阈值 |
  | 门禁未批准 | 五道检查的第 2/3 条 |
- **前置五道检查**（任一不过即拒导出）：①无未核验事实 ②门2 已批准 ③门3 已批准 ④自我复制未超阈值 ⑤围标相似度未超阈值

#### `mont_bid_pending_checklist` — 待核验事实清单
- **实现**：`lib/tools.js:448` → `runtime.bidPendingChecklist`
- **入参**：`includePolicy`（boolean，—）
- **返回**：`{ ok, items:[{ field, requiredEvidence, allowedSources }], notice }`
- **诚实声明**：输出是标注完备的草案，**不是可直接递交的标书**

#### `mont_bid_check_report` — 读取检查报告
- **实现**：`lib/tools.js:509` → `runtime.bidCheckReport`
- **入参**：`projectId`（✅）
- **返回**：`{ ok, report:[{ code, severity, evidence, suggestion, acknowledged }] }`；未导出过时返回空报告

---

### 1.6 废标项检查（3 个）

#### `mont_bid_rejection_extract` — 抽取废标条款
- **实现**：`lib/tools.js:485` → `rejection.extractRejectionClauses`
- **入参**：`text`（✅）
- **返回**：`{ ok, clauses:[{ id, type, text, evidence }] }`
- **诚实约束**：只抽原文明确出现且带否决/无效/废标结论词的条款，**未出现的不臆造**

#### `mont_bid_rejection_check` — 响应完整性检查　【写】
- **实现**：`lib/tools.js:464` → `rejection.checkRejectionResponse`
- **入参**
  | 名 | 类型 | 必填 | 默认 | 说明 |
  |---|---|---|---|---|
  | `projectId` | string | — | — | 给出时自动读章节与招标原文并落盘 |
  | `tenderText` | string | — | — | 未传 projectId 时用 |
  | `clauses` | object | — | — | 已抽取的条款数组 |
  | `sections` | array | — | — | 投标章节 |
  | `acknowledge` | string[] | — | — | 误报项 id |
  | `includeInferred` | boolean | — | `false` | 是否附经验补充项 |
- **返回**：`{ ok, unresponded:[{ id, level, evidence }], acknowledged }`
- **分级**：high / medium / low

#### `mont_bid_rejection_rules` — 检查口径
- **实现**：`lib/tools.js:498` → `rejection.describeRejectionRules`
- **入参**：无
- **返回**：`{ ok, checkpoints, byType:{invalid,rejection}, bySeverity:{high,medium,low}, keywords }`

---

### 1.7 任务进度（4 个）

#### `mont_task_create` — 建任务　【写】
- **实现**：`lib/tools.js:520` → `runtime.taskCreate` → `task.createTask`
- **入参**
  | 名 | 类型 | 必填 | 说明 |
  |---|---|---|---|
  | `projectId` | string | ✅ | |
  | `kind` | string | ✅ | 如 `section-writing`/`outline`/`export`/`rejection-check` |
  | `label` | string | — | 可读任务名 |
  | `total` | number | — | 总单位数 |
  | `meta` | object | — | 附加信息 |
- **返回**：`{ ok, task:{ id, kind, status, done, total, meta } }`
- **错误码**：`E_TASK_KIND_REQUIRED`、`E_TASK_ID_DUPLICATE`

#### `mont_task_update` — 更新进度　【写】
- **实现**：`lib/tools.js:537` → `task.updateTask`
- **入参**
  | 名 | 类型 | 必填 | 说明 |
  |---|---|---|---|
  | `projectId` | string | ✅ | |
  | `id` | string | ✅ | |
  | `status` | string | — | `PENDING`/`RUNNING`/`SUCCEEDED`/`FAILED`/`CANCELED` |
  | `done` | number | — | 绝对值 |
  | `total` | number | — | 可调整 |
  | `increment` | number | — | 增量 |
  | `note` | string | — | |
  | `force` | boolean | — | 终态任务强制重启 |
- **错误码**：`E_TASK_NOT_FOUND`、`E_TASK_STATUS_INVALID`、`E_TASK_TERMINAL`（终态不可改，需 `force`）

#### `mont_task_list` — 列任务
- **实现**：`lib/tools.js:557` → `task.listTasks`
- **入参**：`projectId`（✅）、`kind`（—）、`status`（—）
- **返回**：`{ ok, tasks:[...], summary }`

#### `mont_task_status` — 任务汇总
- **实现**：`lib/tools.js:572` → `runtime.taskStatus`
- **入参**：`projectId`（✅）
- **返回**：`{ ok, total, byStatus, inProgress, remaining, overallPercent, resumable:[ids] }`

---

### 1.8 知识检索（2 个，显式门控）

#### `mont_kb_search` — 企业知识库检索
- **实现**：`lib/tools.js:587` → `kb.bm25Search`
- **入参**
  | 名 | 类型 | 必填 | 默认 | 说明 |
  |---|---|---|---|---|
  | `query` | string | ✅ | — | 检索查询 |
  | `userText` | string | — | — | 本轮用户原话（用于门控判定） |
  | `explicit` | boolean | — | `false` | 显式声明用户已点名要求检索 |
  | `sync` | boolean | — | `false` | 先重建索引 |
  | `limit` | number | — | 10 | |
  | `triggers` | string[] | — | — | 自定义触发词 |
- **返回**：`{ ok, hits:[{ path, snippet, score }], gate }`
- **门控（fail-closed）**：必须带用户点名原话或 `explicit=true`，否则**拒绝检索**并返回可读理由
- **错误码**：`E_TEXT_REQUIRED`；门控未通过时返回拒绝说明而非空结果

#### `mont_kb_index` — 重建索引　【写】
- **实现**：`lib/tools.js:605` → `runtime.kbBuildIndex`
- **入参**：无
- **返回**：`{ ok, documents, chunks, names, dirs }`

---

### 1.9 工作流与其他（2 个）

#### `mont_wf_advance` — 门禁状态与放行检查　【写】
- **实现**：`lib/tools.js:616` → `runtime.wfAdvance`
- **入参**
  | 名 | 类型 | 必填 | 取值 |
  |---|---|---|---|
  | `projectId` | string | ✅ | — |
  | `gateId` | string | — | `gate1`/`gate2`/`gate3`（`action=check` 时必填） |
  | `action` | string | — | `status`（默认）/ `check` |
- **返回**：`{ ok, gates, auditChain, canAdvance }`
- **红线**：**本工具不提供 approve/reject**。门禁批准只能由人在界面或 `/bidcopilot-gate` 发起，模型无批准通道

#### `mont_ping` — 健康检查
- **实现**：`lib/tools.js:635` → `runtime.ping`
- **入参**：无
- **返回**
  ```jsonc
  {
    "ok": true,
    "name": "mont-BidCopilot",
    "version": "0.5.0",              // 从 package.json 读
    "dshEngineRange": ">=0.2.2-rc.5", // 从 package.json#engines.dsh 读
    "storageRoot": "...",
    "allowWrite": true,
    "thresholds": { "selfDup": 0.85, "collusion": 0.65 },
    "toolCount": 32,
    "tools": ["mont_..."],
    "policyLibrary": { ... },
    "notice": "..."
  }
  ```

---

## 二、内部命令（1 个）

### `/bidcopilot-gate` — 门禁查看与裁决

- **实现**：`index.js:339`（`commandCtx.commands.register`）
- **调用方**：**仅人**（输入框键入）。模型无法代打——这是设计上的隔离。
- **注册条件**：`ctx.inject(['commands'], ...)`，宿主未提供 `commands` 服务时整个命令块跳过
- **签名**
  ```
  /bidcopilot-gate <项目id> [show|approve|reject] <gate1|gate2|gate3> [操作人] [备注]
  ```
- **入参**
  | 位置 | 名 | 必填 | 取值 |
  |---|---|---|---|
  | 1 | projectId | ✅ | 项目 id |
  | 2 | action | — | `show`（默认）/ `approve` / `reject` |
  | 3 | gateId | 裁决时必填 | `gate1`/`gate2`/`gate3` |
  | 4 | operator | 裁决时必填 | 操作人 |
  | 5 | note | — | 备注 |
- **返回**：`{ kind: 'text' | 'error', text: string }`
- **错误分支**
  | 情况 | 返回 |
  |---|---|
  | 参数不足 | `{ kind:'error', text:'用法：...' }`（`index.js:348`） |
  | 裁决未写操作人 | `{ kind:'error', text:'裁决必须写明操作人：...' }`（`index.js:368`） |
- **副作用**：裁决成功写入审计链（`appendAuditRecord`）

---

## 三、Host 服务（1 个）

### `montBidCopilot` — 同进程服务

- **实现**：`index.js:329-331`（`ctx.provide('montBidCopilot', hostSurface)`，行 330）
- **调用方**：同进程的 UI 插件或其他 Host 插件（非模型、非 HTTP）
- **暴露面**：`hostSurface`（能力面，供宿主侧调用）
- **生命周期**：`ctx.effect(() => disposeService, 'mont-bidcopilot: service')`，插件卸载即回收
- **说明**：宿主未提供 `ctx.provide` 时跳过（`typeof ctx.provide === 'function'` 判定）

---

## 四、错误码总表

| code | 模块 | 触发条件 |
|---|---|---|
| `E_NAME_REQUIRED` | store | 项目名称为空 |
| `E_BAD_ID` | store | id 含非法字符 |
| `E_BAD_SECTION_ID` | store | 章节 id 非法 |
| `E_BAD_EXPORT_NAME` | store | 导出文件名非法 |
| `E_PATH_ESCAPE` | store | 路径逃逸（防护命中） |
| `E_PROJECT_EXISTS` | store | 项目已存在 |
| `E_PROJECT_NOT_FOUND` | store | 项目不存在 |
| `E_SECTION_NOT_FOUND` | store | 章节不存在 |
| `E_TENDER_SOURCE_MISSING` | store | 招标原文缺失 |
| `E_READONLY` | store | `allowWrite=false`（执行层兜底） |
| `E_FACT_KEY_REQUIRED` | facts | 未给 key 且无法推断 |
| `E_FACT_NOT_FOUND` | facts | fact 不存在 |
| `E_FACT_EMPTY` | facts | 写入值为空 |
| `E_FACT_SOURCE_REQUIRED` | facts | 写入缺 source |
| `E_FACT_SOURCE_REJECTED` | facts | source 不在类别白名单 |
| `E_OPERATOR_REQUIRED` | facts | 核验未给操作人 |
| `E_TEXT_REQUIRED` | tender/bid/kb | 正文为空 |
| `E_SECTION_ID_REQUIRED` | tender | 缺 sectionId |
| `E_UNVERIFIED_FACTS` | bid | 存在未核验事实 |
| `E_SELF_DUPLICATION` | bid | 自我复制超阈值 |
| `E_COLLUSION_RISK` | bid | 围标相似度超阈值 |
| `E_TASK_KIND_REQUIRED` | task | 缺 kind |
| `E_TASK_ID_DUPLICATE` | task | 任务 id 重复 |
| `E_TASK_NOT_FOUND` | task | 任务不存在 |
| `E_TASK_STATUS_INVALID` | task | 状态值非法 |
| `E_TASK_TERMINAL` | task | 终态任务不可改 |
| `E_INTERNAL` | tools | 未分类异常归一 |

---

## 五、维护约定

1. 新增/修改工具：同步更新本节条目、`fixlog/ARCHITECTURE.md` 的速查表、以及 `README.md` 的工具表。
2. 错误码新增：必须登记到第四节总表，并在对应工具条目写明触发条件。
3. 行号漂移：`lib/tools.js` 有增删时，重新核对本文件的所有 `lib/tools.js:<行>` 引用。
4. 接口返回值变更属破坏性变更：升 minor 版本并在 `CHANGELOG.md` 写明。
