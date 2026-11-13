# mont-BidCopilot 完整实施方案

> 文档版本：v1.0  
> 适用对象：项目负责人、核心开发、合规审查、社区维护  
> 文档性质：可执行实施方案，含架构决策、实施路线、质量基线、风险治理  
> 保存方式：复制本文全部内容，保存为 `mont-BidCopilot-实施方案.md`

---

## 目录

1. 执行摘要
2. 产品定位与不可逾越的边界
3. 开源资产吸收清单与许可证处理
4. 单体插件架构设计
5. 统一领域模型
6. 合规硬约束内核
7. 双模工作流
8. 门禁机制
9. 多平台适配
10. 权限与风险披露
11. 版本跟随机制
12. 开源分发方案
13. 分阶段实施路线
14. 测试与质量保障基线
15. 风险与治理
16. 附录

---

## 1. 执行摘要

### 1.1 项目定义

`mont-BidCopilot` 是一个面向招投标场景的**双模辅助编制引擎**，以 DSH、Codex、Qoder 等主流智能体为运行平台，以社区开源组件为代码原材料，通过源码吸收与统一重构，形成一个**单体、自研、可开源分发**的插件。

它解决两个场景：

- **招标人只说需求**：输入一段自然语言需求，输出带阻断标记和待确认标记的招标文件草案（公告、技术需求书、评审办法、合同草案）。
- **投标人上传招标文件**：在无企业资料或有企业资料两种条件下，输出按评分对齐的投标文件草案，事实字段标注核验状态，外部引用带来源标签。

### 1.2 三条不可逾越的边界

**边界一：辅助，不替代。** AI 输出只能是草案或建议。资格条件是否合法、报价是否低于成本、合同条款是否有实质性风险，判断主体是招标人、投标人和评标委员会。

**边界二：合规即架构。** 合规不是生成后的检查步骤，而是代码层的不可执行路径。插件在资格条件中写不进本地分支机构条款，无法从外部填充事实字段，无法在存在未核验事实时导出投标文件。

**边界三：不批量、不自动更新、不安装期执行脚本。** 架构上不支持批量生成多份标书；不内置更新器；`package.json` 中没有任何 `preinstall`/`install`/`postinstall` 脚本。

### 1.3 核心数字

| 指标 | 目标 |
|---|---|
| 吸收的开源组件 | 7 个（MIT 3 个、Apache-2.0 1 个、待确认 3 个） |
| 明确排除的组件 | 1 个（much-agents，AGPL） |
| 对外工具数量 | 约 12 个 `mont_*` 工具 |
| 支持平台 | DSH、Codex、Qoder（+ Agent Plugins 1.0.0 通用） |
| 总工期 | 15—20 周（单人全职），8—10 周（3 人并行） |
| 测试基线 | 3 组（功能、合规不可绕过、门禁不可绕过） |

---

## 2. 产品定位与不可逾越的边界

### 2.1 它是什么

一个运行在主流智能体平台上的**编排型单体插件**。业务逻辑在 `src/core/` 中只有一份，平台差异压缩到 `src/adapters/` 三个薄文件。它不自建一切，而是吸收社区已有代码资产，用统一领域模型和 `mont_` 工具接口重构为一个自研产品。

### 2.2 它不是什么

- 不是“全自动标书生成器”——不批量生成，不替投标人做投/不投决策。
- 不是“通用文档写作工具”——每个输出受招投标法规和公平竞争审查规则约束。
- 不是“知识库管理平台”——检索能力内化为 `core/knowledge`，不作为独立产品。
- 不是“多包共存”——不保留任何上游独立插件入口。

### 2.3 合规边界的法律依据

| 依据 | 对插件的要求 |
|---|---|
| 发改法规〔2026〕195号 | AI 定位为“辅助”和“智能纠偏”，不授权独立作出实质性决定 |
| 《公平竞争审查条例》 | 资格条件不得含本地分支机构、本地业绩、税收社保缴纳地等限制 |
| 《政府采购法》第七十七条 | 提供虚假材料谋取中标的法律责任由投标人承担，AI 不替人认罚 |
| 多地雷同筛查阈值 60%—70% | 插件不提供批量生成，导出前做雷同自检并阻断超阈值导出 |

---

## 3. 开源资产吸收清单与许可证处理

### 3.1 可直接源码合并的组件

| 项目 | 许可证 | 技术栈 | 吸收内容 | 处理方式 |
|---|---|---|---|---|
| **dsh-plugin-bidkit** | MIT | 纯 JS，零运行时依赖 | `lib/parse.js`（18项解析）、`lib/outline.js`、`lib/kb.js`、`lib/review.js`、`lib/docx.js`、`lib/figure.js`、`client.js` | 源码移入 `core/bid/`，业务逻辑保留，工具接口按 `mont_` 重写 |
| **dsh-company-kb** | MIT | JS + SQLite FTS5 | `lib/core.js`（BM25 + bigram + trigram + RRF）、`lib/ocr.js`、显式调用门控 | 检索内核移入 `core/knowledge/`，装配职责上收 |
| **dsh-gatedflow** | MIT | TypeScript，零外部依赖 | `engine` 层状态机（gates、interrupt、零突变）、防绕过 guard | 引擎移入 `core/workflow/engine.ts`，适配器丢弃 |

### 3.2 需确认许可证后处理的组件

| 项目 | 预期许可证 | 技术栈 | 吸收内容 | 处理方式 |
|---|---|---|---|---|
| **rejection-check** | 预期 MIT | DSH 插件/Skill | 废标项提取规则、三轮检查、错别字/逻辑谬误 | 规则重写，报告接入 `core/render/pdf` |
| **BidMaster-Pro** | 预期开源 | Python/Agent | 21项合规检查清单、4阶段流水线划分 | 清单转 YAML，流程作设计参考 |
| **BiaoShu-SKILL** | 预期开源 | Python + Markdown | 8大行业写作指南、章节骨架、行业检测规则 | 只吸收 Markdown 数据，Python 运行时不引入 |

### 3.3 Apache-2.0 组件

| 项目 | 吸收内容 | 处理方式 |
|---|---|---|
| **BidCopilot (xrzlizheng)** | 24条合规预检规则、合同审查逻辑、招标解析流程 | 规则转 YAML，流程用 TypeScript 重写，不引入 Python/FastAPI/Next.js 运行时 |

### 3.4 明确排除的组件

| 项目 | 许可证 | 排除原因 | 处理方式 |
|---|---|---|---|
| **much-agents** | **AGPL-3.0-or-later** | 传染性会迫使整个插件采用 AGPL | **不吸收任何源码**，仅参考“跨章节一致性台账”“审计哈希链”设计思路，用自有代码实现 |

### 3.5 许可证合规动作

**阶段 0 必须完成**：

1. 逐组件确认许可证类型和版权行。
2. 建立 `NOTICE.md`，按组件列出：名称、许可证、吸收范围、原始版权行。
3. `LICENSE` 文件包含所有 MIT/Apache-2.0 上游的原始版权声明。
4. 许可证不明确的组件**不碰代码**，只参考设计或吸收非代码资产（规则 YAML、行业 Markdown）。
5. 组合产物采用 **MIT** 分发。

**GPL/AGPL 的处理原则**：代码不合并，规则数据（YAML/Markdown）作为独立数据文件吸收并标注来源——规则数据不受代码许可证传染。

---

## 4. 单体插件架构设计

### 4.1 目录结构

```text
mont-BidCopilot/
├── package.json                    # 单一包，无安装期脚本
├── plugin.json                     # Agent Plugins 1.0.0 根清单
├── mcp.json                        # MCP server 声明
├── SECURITY.md                     # 权限与风险披露
├── NOTICE.md                       # 上游组件归因
├── LICENSE                         # MIT + 上游版权声明
├── README.md
├── CHANGELOG.md
├── src/
│   ├── index.ts                    # 唯一装配器
│   ├── core/                       # 平台无关业务逻辑
│   │   ├── domain/                 # 统一领域模型
│   │   │   ├── tender.ts
│   │   │   ├── bid.ts
│   │   │   ├── fact.ts
│   │   │   ├── citation.ts
│   │   │   └── workflow.ts
│   │   ├── guard/                  # 合规硬约束
│   │   │   ├── clause-check.ts
│   │   │   ├── fact-guard.ts
│   │   │   ├── similarity.ts
│   │   │   └── rules-loader.ts
│   │   ├── tender/                 # 招标侧流水线
│   │   │   ├── parse.ts
│   │   │   ├── industry.ts
│   │   │   ├── draft.ts
│   │   │   └── consistency.ts
│   │   ├── bid/                    # 投标侧流水线（吸收 bidkit）
│   │   │   ├── parse.ts
│   │   │   ├── outline.ts
│   │   │   ├── write.ts
│   │   │   ├── lock.ts
│   │   │   └── export.ts
│   │   ├── knowledge/              # 检索层（吸收 company-kb）
│   │   │   ├── index.ts
│   │   │   ├── sqlite-fts.ts
│   │   │   ├── ocr.ts
│   │   │   └── gate.ts
│   │   ├── workflow/               # 门禁引擎（吸收 gatedflow）
│   │   │   ├── engine.ts
│   │   │   ├── gates.ts
│   │   │   └── guard.ts
│   │   ├── review/                 # 专项审查
│   │   │   ├── rejection.ts
│   │   │   ├── typo-logic.ts
│   │   │   └── compliance.ts
│   │   └── render/                 # 统一渲染
│   │       ├── docx.ts
│   │       └── pdf.ts
│   ├── tools/                      # 工具注册
│   │   ├── index.ts
│   │   ├── guard-tools.ts
│   │   ├── tender-tools.ts
│   │   ├── bid-tools.ts
│   │   ├── kb-tools.ts
│   │   ├── wf-tools.ts
│   │   └── review-tools.ts
│   ├── adapters/                   # 平台外壳
│   │   ├── dsh.ts
│   │   ├── codex.ts
│   │   └── qoder.ts
│   └── ui/                         # 统一工作台
│       ├── workbench.ts
│       └── gate-panel.ts
├── servers/
│   └── bidcopilot-mcp.mjs          # MCP server 入口
├── skills/                         # 内容真源
│   ├── mont-bidcopilot-tender/
│   ├── mont-bidcopilot-bid/
│   ├── mont-bidcopilot-compliance/
│   └── mont-bidcopilot-workflow/
├── data/                           # 数据资产
│   ├── industry-guides/
│   ├── compliance-rules/
│   └── review-checklists/
├── shells/                         # 平台声明文件
│   ├── dsh/cordis.patch.yml
│   ├── codex/.codex-plugin/plugin.json
│   └── qoder/.qoder-plugin/plugin.json
└── test/                           # 自有测试基线
```

### 4.2 装配器职责（`src/index.ts`）

唯一入口，统一注册所有工具、挂载 UI、加载数据。装配顺序：

```text
1. 合规内核（无外部依赖，最先）
2. 知识检索层（需要文件系统）
3. 工作流引擎
4. 投标侧流水线（依赖知识层和工作流）
5. 招标侧流水线（依赖合规内核）
6. 统一挂载 UI 和 Web API
```

**故障隔离**：每个模块注册做 try-catch，单个失败不阻断其他模块。但**合规内核和工作流引擎注册失败时整体拒绝启动**——合规不能降级。

### 4.3 工具命名规范

所有工具以 `mont_` 前缀 + 命名空间 + 动作：

| 工具名 | 职责 |
|---|---|
| `mont_guard_check_clause` | 合规条款硬阻断检查 |
| `mont_guard_verify_fact` | 事实字段核验状态查询/更新 |
| `mont_guard_similarity_check` | 雷同自检 |
| `mont_tender_parse` | 招标需求结构化 |
| `mont_tender_match_industry` | 行业匹配 |
| `mont_tender_draft_section` | 招标章节草案生成 |
| `mont_tender_check_consistency` | 跨板块一致性校验 |
| `mont_bid_parse` | 招标文件解析 |
| `mont_bid_outline` | 评分对齐目录 |
| `mont_bid_write_section` | 投标章节写作 |
| `mont_bid_lock_facts` | 事实锁定 |
| `mont_bid_export` | docx 导出（含门禁和雷同检查） |
| `mont_kb_search` | 显式门控知识检索 |
| `mont_wf_advance` | 工作流推进（不含 approve） |
| `mont_review_rejection` | 废标项专项检查 |

**`wf_gate_approve` 不注册为工具**，只通过 UI 面板调用。

---

## 5. 统一领域模型

### 5.1 核心实体

```typescript
interface TenderProject {
  id: string;
  requirements: TenderRequirements;
  industry: IndustryProfile;
  sections: TenderSection[];
  consistencyIssues: ConsistencyIssue[];
  gateStatus: GateStatus;
}

interface BidDocument {
  id: string;
  tenderRef: string;
  chapters: BidChapter[];
  facts: FactField[];
  citations: Citation[];
  reviewResults: ReviewResult[];
  gateStatus: GateStatus;
}

interface FactField {
  key: string;
  value: string | null;
  status: 'UNVERIFIED' | 'VERIFIED' | 'NOT_APPLICABLE';
  allowedSources: SourceType[];
  evidenceRef?: string;
}

interface Citation {
  content: string;
  sourceLayer: 'L1' | 'L2' | 'L3';
  sourceUrl?: string;
  verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED';
}

interface WorkflowState {
  gates: GateStatus[];
  interruptedAt?: string;
  approvedBy?: string;
}
```

### 5.2 事实字段类型化约束

| 字段类别 | 允许来源 | 禁止来源 |
|---|---|---|
| 企业名称、统一社会信用代码 | 人工录入 / 已核验企业库 | 联网搜索、类似项目、模型生成 |
| 资质证书编号、有效期 | 人工录入 + 附件 | 任何自动填充 |
| 业绩项目名称、金额、合同 | 人工录入 + 合同扫描件 | 从类似项目“借用” |
| 人员姓名、证书、社保 | 人工录入 | 模型生成 |
| 检测结论、认证状态 | 人工录入 + 证书扫描件 | 模型推断或联网推测 |
| 技术方案描述、行业做法 | L1/L2/L3（带来源标签） | — |
| 具体性能承诺（数字） | 必须人工确认 | 模型自主生成 |

---

## 6. 合规硬约束内核

### 6.1 招标侧硬阻断规则

| 编号 | 阻断模式 | 实现方式 |
|---|---|---|
| T-B1 | 资格条件含“本地分支机构/本地办公面积/本地户籍人员” | `checkClause` 模式匹配 + 语义规则，命中返回 `{ blocked: true }` |
| T-B2 | 业绩要求限定本地/本省/本市 | 同上 |
| T-B3 | 税收社保缴纳地作为投标或加分条件 | 同上 |
| T-B4 | 限定特定品牌、专利、商标或供应商（法定除外） | 同上 |
| T-B5 | 已明令取消的资质作为资格条件 | 对照取消资质目录 |

**实现位置**：`core/guard/clause-check.ts`。`tender_draft_section` 在 `execute` 内部调用，命中即返回 `{ generated: false, blockedBy, reason }`，模型无法获得可用的条款文本。

### 6.2 强制人工复核项

资格条件与合同履行的相关性、评分权重合理性、业绩要求是否构成变相限制——这些无法完全量化，模型只输出“建议 + 判断依据”，由招标人在门1逐条确认。

### 6.3 投标侧事实核验状态机

```text
事实字段初始状态：UNVERIFIED
  ↓ 人工填写或从已核验企业库调用
状态：VERIFIED
  ↓ 导出前检查
存在任何 UNVERIFIED → mont_bid_export 拒绝执行，返回待核验清单
```

### 6.4 雷同自检

- **不提供批量生成模式**（架构性禁止）。
- 导出前对生成文本与同一知识源/模板的相似度自检，阈值 0.65（参考多地 60%—70% 预警线）。
- 检测维度：元数据、目录、正文、内嵌图片比对 + SimHash。
- 超阈值阻断导出，提示需实质性差异化改写。

### 6.5 不可用路径清单（代码中有对应约束）

- 无法在资格条件中写入本地分支机构要求。
- 无法从联网搜索或类似项目中“借用”业绩填入事实字段。
- 无法以批量模式为多个投标人生成可导出的完整标书。
- 无法在存在 `UNVERIFIED` 事实字段时导出投标文件。
- 不判断“这条资格条件合法”。
- 不判断“这个报价不低于成本”。
- 不替代评标委员会的任何评审职能。
- 合同类章节强制标记 `requiresLegalReview: true`。

---

## 7. 双模工作流

### 7.1 招标侧工作流

```text
需求输入
  ↓
① mont_tender_parse
   结构化字段：标的类型、预算、工期、功能/性能指标、资格线索、知识产权归属
   缺失项标记「待招标人补充」，不臆造
  ↓
② mont_tender_match_industry
   加载 data/industry-guides/ 对应行业骨架
   不存在时回退通用结构，提示「行业骨架待补充」
  ↓
③ mont_tender_draft_section（逐节生成）
   公告 → 技术需求书 → 评审办法 → 合同草案
   每节调用 mont_guard_check_clause：
     · 命中 T-B → 拒绝生成，返回阻断原因
     · 命中复核项 → 生成但标记「需招标人确认」
   每节内容带来源标签（L1/L2/L3）
  ↓
④ mont_tender_check_consistency
   跨板块一致性：预算 vs 合同、工期 vs 技术需求、评审办法 vs 需求
   不一致项输出「待确认」，不自动修正
  ↓
⑤ 【门1】资格条件与评审办法确认（工作流 interrupt）
   招标人逐条确认；硬阻断项须已修正
   未确认 → 引擎暂停，不推进
  ↓
⑥ 生成招标文件草案（带阻断标记、待确认标记、来源标注）
```

### 7.2 投标侧工作流

```text
输入：招标文件 + 企业资料（可选）
  ↓
① mont_bid_parse
   18 项深度结构化、★实质性条款识别、评分表抽取
  ↓
② mont_bid_outline
   评分对齐目录生成
  ↓
③ mont_bid_write_section（逐章写作）
   企业事实：mont_kb_search 显式调用（用户点名才查）
   技术方案：L1 → L2 联网搜索 → L3 类似项目
   每条外部引用带来源标签；事实字段初始 UNVERIFIED
  ↓
④ mont_bid_lock_facts
   企业事实锁定一致性；外部引用必须可追溯
  ↓
⑤ mont_review_rejection
   废标项三轮检查 + 错别字/逻辑谬误 → PDF 报告
  ↓
⑥ mont_guard_similarity_check
   雷同自检，超阈值阻断
  ↓
⑦ 【门2】事实与引用核验（工作流 interrupt）
   列出所有 UNVERIFIED 事实字段和外部引用
   投标人逐项填写或确认；未核验不推进
  ↓
⑧ 【门3】最终合规审查签署
   合规报告无阻断项，操作人签署
  ↓
⑨ mont_bid_export
   docx 导出（纯 JS 排版级）
```

### 7.3 无企业资料时的诚实输出

- **技术方案草案**：基于 L1/L2/L3 生成，每条外部内容带来源标签。
- **待核验事实清单**：企业名称、资质编号、业绩、人员、检测结论等全部标记 `【待填写/待核验】`，附填写指引和所需证明材料类型。
- **行业参考摘要**：从类似项目和行业 skill 中提取的写法参考，明确标注“仅供参考，非本项目事实”。

输出是一份**标注完备的草案**，不是可直接递交的标书。

---

## 8. 门禁机制

### 8.1 三个强制门禁

| 门禁 | 插入位置 | 放行条件 |
|---|---|---|
| 门1 招标侧资格/评审确认 | 资格条件和评审办法生成后 | 招标人逐条确认复核项；硬阻断项已修正 |
| 门2 投标侧事实/引用核验 | `mont_bid_export` 执行前 | 所有 `UNVERIFIED` 事实字段已确认；所有 L2/L3 引用已核验来源 |
| 门3 最终合规审查签署 | 导出最终文件前 | 合规审查报告无阻断项，操作人签署 |

### 8.2 引擎层实现

复用 gatedflow 的引擎逻辑，关键特性保留：

- **门禁即控制流**：interrupt 步骤暂停引擎，模型 agent 无 approve/reject 通道。
- **零突变**：agent 无权改写 workflow 状态、参数或路由。
- **防绕过 guard**：`wf_gate_approve` 只接受 UI 调用，`mont_wf_advance` 拒绝模型调用批准操作。

**如果某部署环境无法运行工作流引擎，正确做法是禁用相关流水线，而不是退化为提示词等待。**

---

## 9. 多平台适配

### 9.1 核心原则

业务逻辑在 `core/` 中只有一份。平台差异压缩到 `src/adapters/` 三个薄文件和 `shells/` 三个声明文件。

### 9.2 MCP 作为统一工具通道

所有 `mont_*` 工具通过 MCP server（`servers/bidcopilot-mcp.mjs`）暴露，stdio JSON-RPC，零外部依赖，仅用 Node.js 标准库。DSH、Codex、Qoder 均支持 MCP server 接入。

### 9.3 各平台声明

**DSH**：`shells/dsh/cordis.patch.yml` 单条 insert，指向 `mcp.json`，从 `skills/` 发现技能。

**Codex**：`shells/codex/.codex-plugin/plugin.json` 声明 `skills: "./skills/"` 和 `mcpServers`。

**Qoder**：`shells/qoder/.qoder-plugin/plugin.json` 声明元信息，`skills/` 和 `.mcp.json` 按约定自动发现。

### 9.4 Agent Plugins 1.0.0 根清单

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "mont-bidcopilot",
  "version": "0.1.0",
  "description": "招投标双模辅助编制引擎",
  "license": "MIT",
  "extensions": {
    "security": {
      "capabilities": [
        "filesystem:read:user-specified",
        "filesystem:write:user-specified",
        "network:outbound:optional",
        "process:spawn:node"
      ],
      "install_scripts": false,
      "auto_update": false,
      "credential_handling": "reference-only"
    },
    "platforms": {
      "dsh": { "min": "0.2.0", "tested_through": "0.3.x" },
      "codex": { "min": "26.300", "tested_through": "26.415" },
      "qoder": { "min": "18.0", "tested_through": "18.x" }
    },
    "dsh": { "manifest": "shells/dsh/cordis.patch.yml" },
    "codex": { "manifest": "shells/codex/.codex-plugin/plugin.json" },
    "qoder": { "manifest": "shells/qoder/.qoder-plugin/plugin.json" }
  }
}
```

### 9.5 合规不因平台降级

如果某平台不支持 MCP，该平台的工具调用降级为“仅 Skills 驱动”，但 `core/guard` 和 `core/workflow` 的约束必须通过等效机制仍然生效。合规不能因为平台切换而放松。

---

## 10. 权限与风险披露

### 10.1 `SECURITY.md`（包根目录）

```markdown
# mont-BidCopilot 安全披露

## 此插件会访问
| 能力 | 具体行为 | 是否可关闭 |
|---|---|---|
| 本地文件读取 | 读取用户指定的企业资料目录（仅当用户点名检索时） | 是 |
| 本地文件写入 | 生成 .docx / .pdf 到用户指定输出目录 | 否 |
| 网络访问 | L2 联网搜索（仅当启用时） | 是 |
| 本机进程 | MCP server 作为子进程运行 | 否 |
| 环境变量 | 不主动读取；凭据通过平台引用，不落盘明文 | — |

## 此插件不会做
- 不会在用户未点名时自动检索知识库
- 不会将文件写入资料目录以外的位置
- 不会将凭据明文写入配置文件
- 不会自动更新或加载远程代码
- 不会为多个投标人生成可导出的标书

## 已知限制
- 本插件不是恶意代码沙箱；继承运行平台的本机权限。
- 合规硬约束在插件代码层实现，最终法律责任由使用者承担。
```

### 10.2 `plugin.json` 中的 `extensions.security`

```json
"security": {
  "capabilities": [
    "filesystem:read:user-specified",
    "filesystem:write:user-specified",
    "network:outbound:optional",
    "process:spawn:node"
  ],
  "install_scripts": false,
  "auto_update": false,
  "credential_handling": "reference-only"
}
```

### 10.3 README 首屏

第一屏不写功能列表，先写三件事：

1. **权限表格**（与 `SECURITY.md` 一致）。
2. **“安装即授权”**：DSH 插件以本机权限运行，工具审批机制约束的是 agent 的工具调用，不为插件代码本身加沙箱。
3. **如何在不信任的环境里试用**：建议隔离 profile 或临时目录，不存放凭据。

### 10.4 运行时提示

MCP server 在 `initialize` 响应中携带简短提示：

> “mont-BidCopilot 已加载。它会在你点名检索时读取企业资料目录，并生成文件到输出目录。它不做自动更新，也不在安装时执行脚本。完整权限清单见 SECURITY.md。”

---

## 11. 版本跟随机制

### 11.1 兼容性声明

```json
"extensions": {
  "platforms": {
    "dsh": { "min": "0.2.0", "tested_through": "0.3.x" },
    "codex": { "min": "26.300", "tested_through": "26.415" },
    "qoder": { "min": "18.0", "tested_through": "18.x" }
  }
}
```

平台在版本不满足时拒绝加载，用户安装前就能看到兼容性。

### 11.2 版本号规则

| 变更类型 | 版本号 | CHANGELOG 标注 |
|---|---|---|
| 平台兼容区间变更 | minor | 单独标注 `platform-compat` |
| MCP 工具签名变更 | major | 破坏性变更说明 |
| 合规规则变更 | minor 或 patch | **必须标注 `compliance-impact`** |
| 纯功能优化 | minor | — |
| Bug 修复 | patch | — |

### 11.3 不内置更新器

插件不检查新版本、不发起更新网络请求。README 为各平台列出更新命令，提示更新前查看 `compliance-impact` 标注和兼容区间变化。

---

## 12. 开源分发方案

### 12.1 许可证与归因

- `LICENSE`：MIT，包含所有上游原始版权声明。
- `NOTICE.md`：按组件列出名称、许可证、吸收范围、原始版权行。
- 规则数据（YAML/Markdown）单独标注来源，不受代码许可证传染。

### 12.2 分发渠道

- npm 包（`mont-bidcopilot`）。
- GitHub 仓库（源码 + 发布 tag）。
- 各平台安装命令在 README 中列出。

### 12.3 社区协作

- `SECURITY.md` 接受社区审查“声明与代码是否一致”。
- 建立 `compliance-impact` 标注惯例，从首次发布开始。
- 不承诺自动同步上游；在 `README` 中声明“安全修复需手动合入”。

---

## 13. 分阶段实施路线

### 阶段 0：许可审查与平台验证（1—2 周）

**交付物**：
- 所有目标组件快照存档，精确 commit 记录。
- `NOTICE.md` 初版，逐组件许可确认。
- MCP server 最小 `mont_ping` 工具在三端加载验证。
- 平台兼容性矩阵。

**闸门**：GPL/AGPL 组件确认排除；许可证不明确的组件不碰代码。

### 阶段 1：领域模型与合规内核（2—3 周）

**交付物**：
- `core/domain/` 统一模型。
- `core/guard/clause-check.ts`：T-B1~T-B5 规则加载与匹配。
- `core/guard/fact-guard.ts`：事实字段类型化与外部填充禁令。
- `core/guard/similarity.ts`：雷同阈值判定。
- 单包骨架：`package.json`、`plugin.json`、`src/index.ts` 装配器。
- 测试：T-B 规则全部命中/未命中用例。

**闸门**：命中 T-B 规则时 `mont_guard_check_clause` 确实返回 `blocked: true`；未携带 `explicit: true` 时 `mont_kb_search` 拒绝执行。

### 阶段 2：知识检索层与工作流引擎（3—4 周）

**交付物**：
- `core/knowledge/`：SQLite FTS5 + BM25 + RRF 检索内核，显式门控，OCR。
- `core/workflow/`：状态机、三个门禁定义、防绕过 guard。
- MCP 暴露 `mont_kb_search`、`mont_wf_advance`，不暴露 approve。

**闸门**：存在 `UNVERIFIED` 事实时 `mont_bid_export` 被阻断；模型无法通过任何 MCP 工具批准门禁。

### 阶段 3：投标侧流水线（3—4 周）

**交付物**：
- `core/bid/`：解析、目录、写作、锁定、导出。
- `core/review/`：废标项检查、错别字/逻辑谬误、合规检查清单。
- `core/render/`：docx、pdf。

**闸门**：无资料场景输出待核验清单；未核验时导出被阻断；雷同超阈值阻断导出。

### 阶段 4：招标侧流水线（3—4 周）

**交付物**：
- `core/tender/`：需求解析、行业匹配、逐节生成、一致性校验。
- `data/industry-guides/`：至少 2—3 个行业骨架。
- `data/compliance-rules/`：T-B 规则 YAML。

**闸门**：从需求描述生成带阻断标记和待确认标记的草案；命中 T-B 规则时拒绝生成条款。

### 阶段 5：多平台外壳与统一 UI（2—3 周）

**交付物**：
- `shells/` 三个平台声明文件。
- 统一工作台 UI、门禁面板。
- 三端安装验证：Skills 被发现、MCP 工具可调用、门禁不可绕过、导出阻断生效。

**闸门**：三端行为一致；合规约束不因平台降级。

### 阶段 6：披露、文档与发布（1—2 周）

**交付物**：
- `SECURITY.md`、`NOTICE.md`、`README.md`、`CHANGELOG.md`。
- `extensions.security` 和 `extensions.platforms` 填写完整。
- 全量回归测试通过。
- npm 包和 GitHub 仓库发布。

**总工期**：15—20 周（单人），8—10 周（3 人并行）。

---

## 14. 测试与质量保障基线

### 14.1 三组测试基线（只能增加，不能删减）

**组一：功能正确性**
- 招标侧：需求解析、行业匹配、章节生成、一致性校验。
- 投标侧：文件解析、目录生成、章节写作、事实锁定、docx 导出。
- 知识检索：FTS5 召回、OCR、显式门控。

**组二：合规硬约束不可绕过**
- T-B1~T-B5 每条规则至少一个命中用例和一个未命中用例。
- 事实字段外部填充：所有禁止来源的注入尝试被拒绝。
- 雷同自检：超阈值导出被阻断。
- 批量生成：架构层无入口。

**组三：门禁不可绕过**
- 门1：硬阻断项未修正时工作流不推进。
- 门2：存在 `UNVERIFIED` 事实时 `mont_bid_export` 拒绝执行。
- 门3：合规报告有阻断项时导出被拒绝。
- 模型 agent 无法调用 `wf_gate_approve`。

### 14.2 回归策略

每次代码变更必须通过全部三组基线。合规内核或工作流引擎的变更需要**额外的人工审查签字**。

---

## 15. 风险与治理

| 风险 | 影响 | 治理 |
|---|---|---|
| 许可证污染 | GPL/AGPL 代码进入自有库，整体分发受限 | 阶段 0 逐文件审查签字；不确定的组件不碰代码 |
| 重构丢失边界逻辑 | bidkit 事实锁定、gatedflow 零突变、company-kb 显式门控被简化 | 三条在阶段 1 固化单元测试，任何重构必须通过 |
| 统一模型过度设计 | 领域模型臃肿 | v1 只覆盖已知双模场景，预留扩展点不实现 |
| 单点装配器故障 | 全部工具不可用 | 模块级 try-catch 隔离；合规内核失败时整体拒绝启动 |
| 上游安全修复滞后 | 直接复用的已知代价 | `NOTICE.md` 记录版本；README 声明不承诺自动同步 |
| 平台 MCP 审批模式差异 | 高风险工具在不同平台触发不同流程 | `core/bid/export` 内部无论平台审批如何都执行门禁检查 |
| 开源披露与代码不一致 | 社区信任受损 | `SECURITY.md` 接受审查；披露内容与代码同步更新 |

---

## 16. 附录

### 16.1 配置示例（`mont-BidCopilot.config.yaml`）

```yaml
knowledge:
  primary: sqlite-fts
  vector:
    enabled: false
    embedding: bge-small-zh
  ocr:
    enabled: true
  explicit_gate: true

workflow:
  gate1_required: true
  gate2_required: true
  gate3_required: true
  durable_recovery: true

similarity:
  threshold: 0.65
  block_export: true

render:
  docx_engine: pure-js
  pdf_engine: builtin
```

### 16.2 发布前检查清单

- [ ] `SECURITY.md` 三节完整，与代码行为一致
- [ ] `plugin.json` 的 `extensions.security` 声明完整
- [ ] `package.json` 无 `preinstall`/`install`/`postinstall`
- [ ] README 首屏含权限表格和“安装即授权”
- [ ] README 列出三端安装和更新命令
- [ ] `extensions.platforms` 与验证环境一致
- [ ] CHANGELOG 建立 `compliance-impact` 标注
- [ ] `LICENSE` 和 `NOTICE.md` 覆盖所有上游
- [ ] 三组测试基线全部通过
- [ ] 三端安装验证通过

### 16.3 关键决策记录

| 决策 | 理由 |
|---|---|
| 单体插件而非多包共存 | 用户要求自研产品，消除同步负担 |
| MIT 分发 | 兼容所有 MIT/Apache-2.0 上游 |
| 排除 much-agents | AGPL 传染性与自研定位冲突 |
| MCP 作为统一工具通道 | 三平台共同支持，避免三套工具注册层 |
| 不内置更新器 | 更新是用户决定，插件不发起网络请求 |
| 无安装期脚本 | 消除供应链风险面，本身就是风险披露 |
| 合规内核失败时拒绝启动 | 合规不能降级 |
| 三组测试基线不可删减 | 自有化后没有上游回归可参照 |

---

**文档结束**。本文档为 `mont-BidCopilot` 从吸收到发布的全流程实施方案，所有架构决策、合规边界、实施路线、测试基线均以此为准。实施过程中的任何偏离需在 CHANGELOG 中记录理由。