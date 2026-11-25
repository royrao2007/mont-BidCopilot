# mont-BidCopilot 架构文档

> 本文件是项目架构的**唯一准绳**。改代码前必读；改完后同步更新受影响条目。
> 与代码不符时以代码为准，并立即修正本文件。

**适用版本**：dsh-mont-bidcopilot 0.5.0
**最后核对**：2026-11-25
**宿主基线**：DeepSeek Harness 0.2.2-rc.5、`@deepseek-ai/cordis` 4.1.0、`@deepseek-ai/schemastery` 3.19.0、Node ≥24.9.0

---

## 一、系统定位

mont-BidCopilot 是面向招投标场景的 DSH 插件，注册 32 个 `mont_*` 工具供模型直接调用。两个形态：

- **招标侧（tender）**：解析招标文件 → 匹配行业骨架 → 起草章节 → 跨板块一致性校验
- **投标侧（bid）**：解析招标文件 → 评分对齐目录 → 写章节 → 锁事实 → 废标项体检 → 导出 .docx

工程约束：**运行时零第三方依赖、不联网、不启子进程、不读凭据、无安装期脚本**（`package.json` 的 `dependencies` 为空）。

---

## 二、分层

```
┌──────────────────────────────────────────────────────────────┐
│ 宿主 DSH（Cordis 插件系统）                                    │
│   ctx.tools.register / ctx.provide / ctx.commands / Config     │
└───────────────────────────┬──────────────────────────────────┘
                            │ 装配
┌───────────────────────────▼──────────────────────────────────┐
│ 装配层  index.js                                              │
│   导出 name / inject / Config / apply；启动自检（不合规即拒启） │
└───────────────────────────┬──────────────────────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        │                                       │
┌───────▼─────────────┐              ┌──────────▼──────────────┐
│ 接口层 lib/tools.js │              │ 编排层 lib/runtime.js    │
│ 32 个工具注册        │─────────────▶│ 全部业务用例的唯一入口    │
│ 错误码映射/卡片       │              │ 写盘/只读判定             │
└─────────────────────┘              └──────────┬──────────────┘
                                                │
   ┌────────────┬────────────┬───────────────┬──┴────────────┬────────────┐
   │            │            │               │               │            │
┌──▼───┐   ┌───▼───┐   ┌────▼────┐   ┌──────▼─────┐   ┌─────▼────┐  ┌────▼─────┐
│ store│   │ guard │   │ tender  │   │    bid     │   │ workflow │  │ facts    │
│ 持久化│   │ 合规  │   │ 招标侧  │   │   投标侧   │   │ 三门+审计 │  │ 事实核验 │
└──┬───┘   └───┬───┘   └────┬────┘   └──────┬─────┘   └─────┬────┘  └────┬─────┘
   │           │            │               │               │            │
   │           └────────────┴───────────────┘               │            │
   │                        │                               │            │
┌──▼──────────────────┐  ┌──▼──────────┐  ┌────────────────▼──┐  ┌──────▼────┐
│ 纯函数/无状态工具层   │  │ industry    │  │ similarity        │  │ docx      │
│ policy / rejection  │  │ 行业骨架     │  │ 雷同自检           │  │ 纯JS打包   │
│ task / kb           │  └─────────────┘  └───────────────────┘  └───────────┘
└─────────────────────┘
```

---

## 三、模块职责与边界

| 模块 | 职责 | 边界（不该做什么） |
|---|---|---|
| `index.js` | Cordis 装配器。导出 `name`/`inject`/`Config`/`apply`；启动前自检合规内核与工作流引擎，**失败即整体拒启** | 不写业务逻辑；不直接碰磁盘 |
| `lib/tools.js` | 把 runtime 能力暴露为 32 个工具；统一错误映射、JSON 输出、卡片标题；**写工具的只读准入条件在此挂载** | 不实现业务规则；不直接读写文件 |
| `lib/runtime.js` | 业务编排中枢。每个能力一个方法，串起 store/guard/tender/bid/workflow/facts 等；`canWrite()` 对外暴露只读判定 | 不直接 `fs` 写文件（走 store）；不关心 Cordis |
| `lib/store.js` | 持久化唯一入口。项目目录布局、原子写、路径逃逸防护、`assertWritable()` 只读守卫 | 不懂业务语义；不校验合规 |
| `lib/guard.js` | 合规内核。加载 T-B1~T-B5 规则、条款硬阻断判定、事实来源白名单 | 不落盘；不做相似度 |
| `lib/facts.js` | 事实模型。写入/核验/不适用标记、未核验清单、来源策略 | 不直接读项目文件（由 runtime 传入） |
| `lib/workflow.js` | 三门定义与状态机、审计链（`recordHash` 串链）、`verifyAuditChain` 防篡改 | 不决定谁能批准（那是命令层与模型层的事） |
| `lib/tender.js` | 招标侧：招标文件解析、章节起草、来源标注提取、跨板块一致性 | 不做评分对齐（属 bid） |
| `lib/bid.js` | 投标侧：解析、评分对齐目录、章节写入、事实锁定、导出前检查、检查报告、待核验清单 | 不直接写 .docx（交给 docx.js） |
| `lib/docx.js` | 纯 JS 的最小 .docx 打包（zip + OOXML），零依赖 | 不做排版美化、不解析 |
| `lib/policy.js` | 离线政策依据库的加载与检索（按章节归类） | 不联网 |
| `lib/rejection.js` | 废标项/无效投标条款抽取与响应完整性检查 | 不判断条款是否合法（那是 guard 的事） |
| `lib/task.js` | 长流程任务进度记录（落 `project.json#tasks`） | 不启动后台进程 |
| `lib/kb.js` | 企业资料库：文档收集、分块、BM25 检索、**点名触发门控**（fail-closed） | 不联网；不在未点名时检索 |
| `lib/industry.js` | 行业骨架匹配（8 行业 + 通用回退）与章节骨架 | 不做正文写作 |
| `lib/similarity.js` | 自我复制与围标双阈值相似度 | 不共用一个阈值 |

---

## 四、模块依赖关系图

箭头方向 = **调用方向**（A → B 表示 A 依赖 B）。禁止反向依赖，禁止循环。

```
index.js
 ├─▶ lib/guard.js
 ├─▶ lib/workflow.js
 ├─▶ lib/runtime.js   ◀── 中枢，依赖面最广
 └─▶ lib/tools.js
        └─▶ lib/store.js
        └─▶ lib/facts.js
        └─▶ lib/tender.js
        └─▶ lib/bid.js

lib/runtime.js
 ├─▶ lib/store.js
 ├─▶ lib/guard.js
 ├─▶ lib/facts.js
 ├─▶ lib/workflow.js
 ├─▶ lib/tender.js  ──▶ lib/guard.js, lib/industry.js
 ├─▶ lib/bid.js     ──▶ lib/facts.js, lib/similarity.js, lib/workflow.js
 ├─▶ lib/docx.js
 ├─▶ lib/policy.js
 ├─▶ lib/rejection.js
 ├─▶ lib/task.js
 ├─▶ lib/kb.js
 ├─▶ lib/similarity.js
 └─▶ lib/industry.js

叶子模块（无内部依赖）：store / guard / facts / workflow / docx / policy /
                          rejection / task / kb / similarity / industry
```

**依赖健康度**：单一中枢（runtime）+ 大量叶子模块，无循环依赖。`tools.js` 只依赖 4 个模块，上层薄。

---

## 五、数据流

### 5.1 招标侧主流程

```
招标文件正文
   │ mont_tender_parse
   ▼
parseTender() ──▶ 18+ 结构化字段 ──▶ store.writeTenderSource() + updateProject()
   │
   ├─ mont_tender_match_industry ──▶ matchIndustry() ──▶ 行业骨架与置信度
   │
   ├─ mont_tender_draft_section ──▶ draftSection() ──▶ store.writeSection()
   │        └─ guard.checkClause() 硬阻断（命中即不产出条款）
   │
   └─ mont_tender_check_consistency ──▶ checkConsistency() ──▶ 待确认清单（不改代码）
```

### 5.2 投标侧主流程

```
招标文件正文
   │ mont_bid_parse
   ▼
parseBidTender() ──▶ 字段 + ★条款 + 评分表 ──▶ store 落盘
   │
   ├─ mont_bid_outline ──▶ planOutline() ──▶ 评分对齐目录（每细则一节，按分值分配字数）
   │
   ├─ mont_bid_write_section ──▶ store.writeSection()（一节一文件）
   │
   ├─ mont_bid_lock_facts ──▶ lockFacts() ──▶ facts 状态固化 + 一致性冲突检查
   │
   ├─ mont_bid_rejection_check ──▶ checkRejectionResponse() ──▶ 未响应项分级
   │
   └─ mont_bid_export
          └─ preExportCheck() ──▶ 五道检查任一不过即拒导出
                ├─ 无未核验事实
                ├─ 门2 已批准
                ├─ 门3 已批准
                ├─ 自我复制未超阈值
                └─ 围标相似度未超阈值
             └─ buildDocx() ──▶ .docx
```

### 5.3 状态流向（审计链）

```
gate 裁决 ──▶ appendAuditRecord()
                 │
                 ├─ seq（序号，自增）
                 ├─ gateId / decision / operator / decidedAt
                 ├─ subjectDigest（被审对象 sha256）
                 ├─ previousRecordHash（前一条的 hash）  ← 串链关键
                 └─ hash = recordHash(自身字段)
                          │
                          ▼
                 verifyAuditChain() 逐条重算；任一条被改（含末尾）即 valid=false
```

**末尾盲区**：只验 `previousRecordHash` 无法发现最后一条被篡改，因此 `recordHash` 覆盖自身全部字段，且启动自检显式测试"末尾被改必须被发现"。

---

## 六、外部依赖及作用

| 依赖 | 作用 | 性质 |
|---|---|---|
| `@deepseek-ai/cordis` ≥4.1.0 | 插件运行时（上下文、effect、inject） | **peerDependency（optional）**，宿主提供 |
| `@deepseek-ai/schemastery` 3.19.0 | 设置页 schema 元信息；**取不到则回退到等价的最小 Standard Schema 实现** | 运行时按需 require，非硬依赖 |
| Node 内置模块 | `node:path` / `node:os` / `node:fs/promises` / `node:module` / `node:crypto` | 零第三方运行时依赖 |

**无**：数据库、网络客户端、模板引擎、日志库。

---

## 七、启动与配置入口

### 7.1 启动顺序（`index.js#apply`）

1. **合规内核** `assertComplianceKernel()` —— 预热规则库，校验 T-B1~T-B5 齐备且每条有编译后的判定模式。**失败即 throw，不降级。**
2. **工作流引擎** `assertWorkflowEngine()` —— 校验三门定义存在；自检审计链（空链有效、单条可验、末尾篡改可发现、摘要篡改可发现）。**失败即 throw。**
3. **运行时** `createRuntime()` —— 打开 store。
4. **工具注册** `registerTools()` —— 每个工具独立 try-catch，单个失败不阻断其余。
5. **服务暴露** `ctx.provide('montBidCopilot', hostSurface)` —— 供同进程 UI/其他 Host 插件调用。
6. **命令注册** `ctx.commands.register({ name: 'bidcopilot-gate', ... })` —— 需 `inject(['commands'])`。

> 设计取舍：合规内核与工作流引擎失败时**整体拒启**，而不是"禁用相关工具继续跑"。合规不能降级。

### 7.2 配置项（`Config`，Standard Schema）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dataDir` | string | `''` | 项目数据目录。留空用 `<DSH_HOME>/bidcopilot/projects` |
| `allowWrite` | boolean | `true` | `false` 时写类工具**从模型工具集摘除**（步骤准入），执行层另有 `E_READONLY` 兜底 |
| `selfDupThreshold` | number | `0.85` | 自我复制相似度阈值 |
| `collusionThreshold` | number | `0.65` | 围标相似度阈值 |
| `kbDir` | string | `''` | 企业资料目录，供 `mont_kb_search` 检索 |

**未知键一律丢弃**（`index.js` 在 schemastery 外再包一层白名单裁剪）——防止拼错的键被静默接受。

### 7.3 数据目录布局

```
<dataDir>/                        # 默认 <DSH_HOME>/bidcopilot/projects
└── <projectId>/
    ├── project.json              # 索引：sections/facts/citations/gateRecords/tasks/exportCheck
    ├── sections/<sectionId>.md   # 一节一文件
    ├── tender-source.md          # 招标原文
    └── exports/*.docx
```

---

## 八、功能定位速查（回答"某功能在哪个模块"）

| 我想… | 去哪个模块 | 入口 |
|---|---|---|
| 解析招标文件 | `bid.js#parseBidTender` / `tender.js#parseTender` | `mont_bid_parse` / `mont_tender_parse` |
| 生成评分对齐目录 | `bid.js#planOutline` | `mont_bid_outline` |
| 匹配行业骨架 | `industry.js#matchIndustry` | `mont_tender_match_industry` |
| 检查条款是否违规 | `guard.js#checkClause` | `mont_guard_check_clause` |
| 查政策依据 | `policy.js#searchPolicies` | `mont_policy_search` |
| 抽出废标条款 | `rejection.js#extractRejectionClauses` | `mont_bid_rejection_extract` |
| 检查响应完整性 | `rejection.js#checkRejectionResponse` | `mont_bid_rejection_check` |
| 锁事实、查未核验 | `facts.js` | `mont_bid_lock_facts` / `mont_guard_verify_fact` |
| 三门裁决与审计链 | `workflow.js` | `/bidcopilot-gate`、`mont_wf_advance` |
| 导出 .docx | `bid.js#preExportCheck` + `docx.js#buildDocx` | `mont_bid_export` |
| 检索企业资料 | `kb.js#bm25Search` | `mont_kb_search` |
| 任务进度 | `task.js` | `mont_task_create/update/list/status` |
| 改文件读写 | `store.js` | 所有写操作必经此处 |

---

## 九、维护约定

1. 新增模块必须登记到第三节表格与第四节依赖图，并说明依赖方向。
2. 新增工具必须同时更新 `fixlog/API.md` 与本节速查表。
3. 任何跨越"禁止反向依赖"的改动，先在 `fixlog/缺陷修复记录.md` 记录设计理由。
4. 本文件的**行号类引用以 `fixlog/API.md` 为准**，此处只写模块级定位。
