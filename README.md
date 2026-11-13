# mont-BidCopilot

> **English summary.** Dual-mode tender & bid drafting engine for DeepSeek Harness. Registers **21 directly callable `mont_*` tools** with code-enforced compliance (T-B1–T-B5), a fact-source allowlist, three human gates backed by a tamper-evident audit chain, score-aligned outlining, dual-threshold similarity checks, and pure-JS `.docx` export. No network access, no subprocesses, no credentials, no install-time scripts. See [SECURITY.md](SECURITY.md) for the full permission table.

招投标双模辅助编制引擎，DeepSeek Harness（DSH）插件。

> **它与「技能包」不是一类东西。** 本插件通过 `ctx.tools.register` 注册 **21 个 `mont_*` 真工具**，模型可直接调用；不依赖先加载技能正文再自行拼流程。作为对照，同目录的 `mont-forge` 是 44 个 `SKILL.md` 的技能包，其 `index.js` 只调 `ctx.skills.registerProvider`，没有 `ctx.tools.register`，因此那 44 项不是可自动调用的工具。

## 权限一览（安装前请先读这张表）

**安装即授权。** DSH 插件以本机权限运行；工具审批机制约束的是 agent 的工具调用，不为插件代码本身加沙箱。

| 能力 | 具体行为 | 可关闭 |
|---|---|---|
| 本地文件读取 | 只读你指定的企业资料目录，且仅当你在消息里**明确点名**时才读（`mont_kb_search` 门控 fail-closed） | 是 |
| 本地文件写入 | 在 `DSH_HOME/bidcopilot/projects` 下写项目目录、章节 `.md`、导出 `.docx` | 是（`allowWrite: false` → 全部写工具返回 `E_READONLY`） |
| 网络访问 | **无。** 代码中不存在 `fetch`/`http`/`https` 调用 | — |
| 本机进程 | **无。** 不 spawn 子进程、不运行动态代码 | — |
| 环境变量 | 只读 `DSH_HOME` 推导默认数据目录；不读任何凭据类变量 | — |
| 凭据 | 不接触、不存储、不转发 | — |
| 安装期脚本 | **无。** `package.json` 不含 `preinstall`/`install`/`postinstall` | — |
| 自动更新 | **无。** 不检查新版本、不发起更新请求 | — |

**关闭插件后的变化：** 21 个工具与 `/bidcopilot-gate` 命令全部移除，所有文件写入停止；已存在的项目目录原样留在磁盘上，不删除。

**如何在不信任的环境里试用：** 用隔离 profile 或临时 `dataDir`，不要指向含真实企业资料的目录，不要把凭据放进 `dataDir`。

完整披露见 [SECURITY.md](SECURITY.md)；上游归因与许可证见 [NOTICE.md](NOTICE.md)。

## 安装

### 环境要求

| 项 | 要求 | 检查命令 |
|---|---|---|
| DSH | `>=0.2.2-rc.1` | 插件页右下角版本号，或 `dsh --version` |
| Node.js | `>=22.5.0` | `node -v` |
| 第三方依赖 | **无需安装**（运行时零依赖） | — |

### 方式一：命令行安装（推荐）

在 DSH 会话里让插件管理器安装，`target` 填包的**绝对路径**：

```text
plugin_manager install_bundle target: F:\DSHDesktop\chajian\mont-BidCopilot
```

也会话中直接说一句即可，agent 会自己调：

> 把 `F:\DSHDesktop\chajian\mont-BidCopilot` 装成插件

**成功判据**（三条都要满足，缺一不算装好）：

1. 返回里 `application` 为 `applied`，或提示 `restart-required`（本 profile 无 HMR 时正常）；
2. 插件列表出现 `include:mont-bidcopilot`，`fiberPhase` 为 `active`；
3. 新会话里 `mont_ping` 能调通，返回 `toolCount: 21`。

`restart-required` 表示改动未生效，**重启 DSH** 后再验证第 2、3 条。

### 方式二：图形界面安装

1. 打开 DSH 左侧栏 **Plugins**（插件）；
2. 点 **Add plugin**（添加插件）；
3. 选择本地目录 `F:\DSHDesktop\chajian\mont-BidCopilot`；
4. 安装后确认插件行出现「招投标双模辅助编制」，图标为蓝底文档 + 绿色勾；
5. 如果状态提示需要重启，重启 DSH。

安装后可在插件详情页看到中英文标题、描述、权限说明和示意图（`locale/en.json`、`locale/zh.json`、`docs/DETAIL.md`）。

### 验证安装成功

在新会话里执行：

```text
mont_ping
```

期望返回：

```json
{
  "ok": true,
  "name": "mont-BidCopilot",
  "toolCount": 21,
  "dshEngineRange": ">=0.2.2-rc.1",
  "storageRoot": "F:\\DSHDesktop\\dsh-home\\bidcopilot\\projects"
}
```

`toolCount` 不是 21，或 `mont_ping` 调不到，说明没装好——先看第 1 条 `application` 状态。

### 升级

源码目录更新后，DSH 需重启加载新的 JavaScript 模块（插件代码不参与热更新）：

```powershell
# 1. 拉取新版本（若从 git 安装）
git -C F:\DSHDesktop\chajian\mont-BidCopilot pull

# 2. 重启 DSH
# 3. 新会话里跑 mont_ping 确认 version 与 toolCount
```

`locale` 与 `docs` 是静态资源，Plugin Manager 按需读取，改完刷新插件页即可，不必重启。

### 卸载

```text
plugin_manager remove_bundle target: dsh-mont-bidcopilot
```

卸载后 21 个工具与 `/bidcopilot-gate` 命令消失，文件写入停止。**已生成的项目目录保留在磁盘上**，不会删除；如需清理，手动删 `DSH_HOME/bidcopilot/projects` 下的对应目录。

### 安装故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `EPERM ... node_modules\<包名>_tmp_*` | 该目录 ACL 损坏，pnpm 无法清扫 | 用管理员 PowerShell 对该目录执行 `takeown /f "<路径>"` 与 `icacls "<路径>" /reset`，或改用 junction 方式接入（见 CHANGELOG） |
| `fiberPhase: failed`，诊断含 `reading 'validate'` | `Config` 未满足 Standard Schema 契约 | 本仓库已修复；若自定义改过 `Config`，需提供 `Config['~standard'].validate` |
| `application: restart-required` | 该 profile 未开 HMR | 重启 DSH |
| `mont_ping` 调不到但列表里有插件 | 未真正激活或工具注册失败 | 看插件行的 `fiberPhase` 与诊断信息 |
| 装了但看不到图标/描述 | `locale` 或 `docs` 未被导出 | 确认 `package.json` 的 `exports` 含 `./locale/*.json`、`files` 含 `locale` 与 `docs` |

### 目录与数据位置

| 内容 | 位置 |
|---|---|
| 项目数据 | `DSH_HOME/bidcopilot/projects/<项目id>/`（可用配置 `dataDir` 覆盖） |
| 每个项目 | `project.json`（索引）、`sections/*.md`（正文）、`tender/source.md`（招标原文）、`exports/*.docx` |
| 配置覆盖 | profile 的 `cordis.patch.yml` 里 `id: mont-bidcopilot` 行的 `config` |

## 使用方法

### 一分钟上手：投标侧走一遍

在 DSH 会话里按顺序说这几句，agent 会调用对应工具：

**第 1 步 · 建项目**

> 建一个投标项目，名字叫「XX市政务云平台投标」

对应 `mont_project_create`。返回 `projectId`（例如 `XX-45823d`），后面所有命令都要带它。

**第 2 步 · 解析招标文件**

> 把这份招标文件解析一下：（粘贴正文）

对应 `mont_bid_parse`，产出 18 项结构化字段、★ 实质性条款、评分表。返回里 `coverage` 是覆盖率（如 `11/18`），`missingFields` 列出没抽到的项——**这些不会编造，就是空的**。

**第 3 步 · 生成评分对齐目录**

> 按评分标准生成目录，全文目标 6 万字

对应 `mont_bid_outline`。每个评分项映射成一章，按分值权重分配字数，★ 条款挂到必须响应它的章节。`unmappedStarClauses` 非空说明有 ★ 条款没找到归属章节，必须先补章节。

**第 4 步 · 逐节写正文**

> 先写第一章，主题是技术方案

对应 `mont_bid_write_section`。一节一个文件，字数只受磁盘限制；要续写同一节传 `append: true`。返回 `sourceLabels` 统计 L1/L2/L3 标签数，`unlabeledRisk: true` 表示有外部引用但没打来源标签。

**第 5 步 · 登记企业事实（关键）**

> 把企业名称登记成「XX科技有限公司」，来源是人工录入

对应 `mont_guard_verify_fact`。这一步**不能跳过**：

- 业绩、资质、人员、企业名称只接受 `manual`（人工录入）或 `verified_kb`（已核验企业库）；传 `L2`/`web`/`model` 会被硬拒（`E_FACT_SOURCE_REJECTED`）
- 值留空则状态为 `UNVERIFIED`，**会挡住导出**

**第 6 步 · 锁定事实**

> 锁定事实

对应 `mont_bid_lock_facts`。返回 `blocked: true` 说明还有未核验项，`unverified` 列出具体是哪些。

**第 7 步 · 雷同自检**

> 检查一下正文和我们的模板像不像，再看和其他投标人像不像

对应 `mont_guard_similarity_check`。两条规则两个阈值：与模板比（自复制，`0.85`）、与其他投标人比（围标预警，`0.65`）。超阈值就别硬导，先改写。

**第 8 步 · 过门禁（必须由人做）**

agent 做不到这一步——`mont_wf_advance` 对 `approve` 会硬拒。**你自己在输入框键入**：

```text
/bidcopilot-gate XX-45823d show
/bidcopilot-gate XX-45823d approve gate2 你的名字
/bidcopilot-gate XX-45823d approve gate3 你的名字
```

`show` 先看清三门状态；`approve` 时若有未核验事实会被拒（`E_GATE_UNRESOLVED_ITEMS`），按提示补。

**第 9 步 · 导出**

> 导出标书，文件名 XX市政务云投标.docx

对应 `mont_bid_export`。前置五道检查任一不过就拒绝导出，并列出 `blockers`：

| 阻断码 | 含义 | 怎么解 |
|---|---|---|
| `E_UNVERIFIED_FACTS` | 有未核验事实 | 回去第 5 步补，或标不适用 |
| `E_GATE2_NOT_APPROVED` | 门2 未批 | 人键入 `/bidcopilot-gate ... approve gate2 名字` |
| `E_GATE3_NOT_APPROVED` | 门3 未批 | 同上 |
| `E_SELF_DUPLICATION` | 与模板太像 | 实质性改写 |
| `E_COLLUSION_RISK` | 与其他投标人太像 | 实质性改写 |

导出成功返回 `.docx` 的绝对路径与字节数。

### 招标侧走一遍

**第 1 步 · 需求结构化**

> 我要采购一套政务云平台，预算 500 万，工期 12 个月，需要支持 5000 并发

对应 `mont_tender_parse`。抽不到的字段列入 `missingFields` 并标「待招标人补充」，**不臆造**。

**第 2 步 · 匹配行业骨架**

> 这是什么行业，用哪套章节结构

对应 `mont_tender_match_industry`。8 个行业 + 通用回退；`confidence` 低于 0.3 会回退 `general` 并提示骨架待补充。

**第 3 步 · 逐节生成草案**

> 写资格条件这一节：投标人须具有独立法人资格

对应 `mont_tender_draft_section`。**这一步会先过 T-B1~T-B5 硬阻断**：

- 命中 → 返回 `generated: false`、`blockedBy: "T-B1"`、`content: null`，**根本不给你条款文本**
- 未命中 → 正常生成，并附 `mandatoryReview` 复核项

试一下拦截效果，输入「投标人须在本市设有分支机构」，会看到 `blockedBy: T-B1` 和法条依据。

**第 4 步 · 跨板块一致性**

> 检查一下预算、工期、评审办法有没有矛盾

对应 `mont_tender_check_consistency`。只输出「待确认」，**不自动改**——改是人的决定。

**第 5 步 · 过门禁并导出**

```text
/bidcopilot-gate <项目id> show
/bidcopilot-gate <项目id> approve gate1 你的名字
```

门1 是招标侧的资格与评审办法确认。

### 单独查一条条款是否违规

不需要建项目，直接问：

> 检查这条资格条件：投标人须具备本省业绩，且在本市缴纳社保

对应 `mont_guard_check_clause`。一次可命中多条规则，每条给出**原文证据**、规则编号、法条依据：

```json
{
  "blocked": true,
  "blockedBy": "T-B2",
  "hits": [
    { "ruleId": "T-B2", "evidence": "投标人须具备本省业绩", "legalBasis": "《招标投标法实施条例》第三十二条第（二）项" },
    { "ruleId": "T-B3", "evidence": "在本市缴纳社保", "legalBasis": "..." }
  ]
}
```

未命中**不代表条款合法**——规则只做保守拦截，最终判断由人作出。

### 查事实来源规则

> 业绩字段能用联网搜索的结果填吗

对应 `mont_guard_source_policy`，返回 9 类字段各自允许与禁止的来源。

### 门禁命令速查

```text
/bidcopilot-gate <项目id> show                          # 看三门状态与审计链
/bidcopilot-gate <项目id> approve <gate1|gate2|gate3> <操作人>    # 批准
/bidcopilot-gate <项目id> reject  <gate1|gate2|gate3> <操作人> <备注>  # 拒绝（会冻结工作流）
```

- 操作人**必填**，会写进审计链
- 同一门只能裁一次，重复裁决报 `E_GATE_ALREADY_DECIDED`
- 拒绝后工作流冻结，后续任何门都不能再批（`E_WORKFLOW_FROZEN`）

### 创建知识库资料目录（可选）

要让 `mont_kb_search` 可用，需在配置里指定 `kbDir`：

```yaml
- id: mont-bidcopilot
  name: 'dsh-mont-bidcopilot'
  config:
    kbDir: 'F:\你的企业资料目录'
```

然后：

> 用知识库查一下农药追溯二维码的政策要求

**门控是 fail-closed 的**：没在消息里点名（或没传 `explicit: true`）就不检索，会返回可读的拒绝理由。这是设计，不是错误。

### 常见问题

**Q：为什么 agent 不能帮我批准门禁？**
门禁的作用就是挡住 agent。批准只存在于 `/bidcopilot-gate` 命令与 Host 服务里，凭证由插件内部构造，不出现在任何工具参数中。

**Q：`mont_wf_advance` 能做什么？**
只能 `status`（看状态）和 `check`（判断某门能否放行）。传 `approve`/`reject`/`sign` 一律硬拒。

**Q：为什么业绩不能从网上搜？**
因为那是别家企业的业绩。填进自己标书属提供虚假材料，法律责任由投标人承担。代码层直接拒绝，不是靠提示词约束。

**Q：审计链能不能事后改？**
每条记录含自封签哈希与前驱哈希，改任何一条（含最后一条）都会被 `verifyAuditChain` 发现。`mont_project_status` 会返回 `auditChain.valid`。

**Q：项目丢了怎么办？**
项目就是磁盘上的目录，`project.json` + `sections/*.md`。中断后下次 `mont_project_status` 就能从磁盘继续。

## 三条不可逾越的边界

**边界一：辅助，不替代。** 输出只能是草案或建议。资格条件是否合法、报价是否低于成本、合同条款是否有实质风险，判断主体是招标人、投标人和评标委员会。

**边界二：合规即架构。** 合规不是生成后的检查步骤，而是代码层不存在的路径：资格条件里写不进本地分支机构条款（规则命中即不产出条款文本），事实字段无法从外部来源填充，存在未核验事实时无法导出。

**边界三：不批量、不自动更新、不安装期执行脚本。** 无批量工具、无更新器、`package.json` 无任何 `preinstall`/`install`/`postinstall`。

## 工具清单（21 个）

### 项目（3）

| 工具 | 职责 |
|---|---|
| `mont_project_create` | 建项目（一个项目=一个目录，可跨会话恢复） |
| `mont_project_list` | 列项目 |
| `mont_project_status` | 章节数、事实核验进度、三门状态、审计链完整性、能否导出 |

### 合规内核（4）

| 工具 | 职责 |
|---|---|
| `mont_guard_check_clause` | T-B1~T-B5 硬阻断检查（确定性规则，非语义判断） |
| `mont_guard_verify_fact` | 事实写入/核验/不适用；禁用来源硬拒 |
| `mont_guard_similarity_check` | 雷同自检（自复制与围标两条独立规则、两个独立阈值） |
| `mont_guard_source_policy` | 事实来源策略表 |

### 招标侧（4）

| 工具 | 职责 |
|---|---|
| `mont_tender_parse` | 需求结构化，缺项标「待招标人补充」，不臆造 |
| `mont_tender_match_industry` | 8 行业骨架匹配，低于 0.3 回退通用 |
| `mont_tender_draft_section` | 逐节草案，**生成前先过硬阻断**，命中则不出条款文本 |
| `mont_tender_check_consistency` | 跨板块一致性，只输出「待确认」，不自动修正 |

### 投标侧（6）

| 工具 | 职责 |
|---|---|
| `mont_bid_parse` | 18 项结构化 + ★实质性条款 + 评分表 |
| `mont_bid_outline` | 评分对齐目录，按分值权重分配字数，★条款挂章节 |
| `mont_bid_write_section` | 章节写作，一节一文件，支持续写 |
| `mont_bid_lock_facts` | 事实锁定与一致性冲突检查 |
| `mont_bid_export` | 导 .docx，**前置五道检查任一不过即拒绝** |
| `mont_bid_pending_checklist` | 无企业资料时的待核验清单 |

### 知识检索（2）

| 工具 | 职责 |
|---|---|
| `mont_kb_search` | BM25 + 中文 bigram，**门控 fail-closed**（未点名即拒绝） |
| `mont_kb_index` | 重建索引 |

### 工作流（1）+ 元信息（1）

| 工具 | 职责 |
|---|---|
| `mont_wf_advance` | 查门状态与推进检查；**不提供 approve/reject** |
| `mont_ping` | 自检：版本、DSH 版本要求、数据目录、真实工具数 |

## 三处强制门禁

| 门 | 插入位置 | 放行条件 |
|---|---|---|
| 门1 | 资格条件与评审办法生成后 | 硬阻断项已修正；招标人逐条确认复核项 |
| 门2 | `mont_bid_export` 执行前 | 无未核验事实；L2/L3 引用已核验来源 |
| 门3 | 导出最终文件前 | 合规报告无阻断项；操作人签署 |

**门禁即控制流。** 批准通道只有两条，**都在人的手里**：

1. **slash command（推荐）** —— 在输入框键入，模型无法代打：

   ```
   /bidcopilot-gate <项目id> show
   /bidcopilot-gate <项目id> approve gate2 <操作人>
   /bidcopilot-gate <项目id> reject gate3 <操作人> <备注>
   ```

2. **Host 服务** —— 已 `ctx.provide('montBidCopilot', ...)`，供同进程的 UI 或其他 Host 插件调用 `approveGate(projectId, input)`。

两条通道使用的 `{ channel: 'host-ui' }` 凭证由插件内部构造，**不出现在任何工具参数中**。因此模型 agent 没有批准通道：21 个 `mont_*` 工具里没有任何 approve/reject/sign 项，`mont_wf_advance` 对这三个动词硬拒（`E_GATE_MODEL_APPROVAL_FORBIDDEN`）。

**放行前会被挡住的情形**（命令侧同样生效，不只是工具侧）：存在未核验事实 → `E_GATE_UNRESOLVED_ITEMS` 并列出未解决项；同一门重复裁决 → `E_GATE_ALREADY_DECIDED`；拒绝后 → 工作流冻结，`E_WORKFLOW_FROZEN`。

**审计链。** 每次决策写入一条记录：门号、决策、操作人、时间戳、被审对象 SHA-256、结论、前驱哈希、自封签哈希。三条校验（seq 连续 / 前驱指针吻合 / 自封签重算一致）缺一不可——只校验前驱指针时，末条记录被改是盲区。

## 两个阈值为什么必须分开

原方案用单一 0.65 阈值同时卡「自我复制」与「围标相似度」，这会在同一投标人复用自家模板时大量误报：

| 规则 | 比对对象 | 默认阈值 | 依据 |
|---|---|---|---|
| 自我复制 | 生成文本 vs 同一知识源/模板 | **0.85** | 发现复制粘贴 |
| 围标相似度 | 不同投标人之间 | **0.65** | 发改法规〔2026〕195号 围串标识别场景、多地 60%—70% 预警线 |

## 合规规则（T-B1~T-B5）

规则数据在 `data/compliance-rules/tender-block.json`，判定为「正则 + 关键词窗口 + 组合条件」的确定性匹配，纯函数、可单测、可复现。

| 编号 | 阻断模式 | 法条依据 |
|---|---|---|
| T-B1 | 资格条件限定本地分支机构/本地办公场所/本地户籍人员 | 《招标投标法实施条例》第32条(二)(三)；《公平竞争审查条例》第10条 |
| T-B2 | 业绩要求限定本地/本省/本市 | 同上 |
| T-B3 | 税收社保缴纳地作为投标或加分条件 | 同上 |
| T-B4 | 限定特定品牌、专利、商标或供应商 | 《招标投标法实施条例》第32条(五)；《政府采购法》第22条 |
| T-B5 | 已明令取消的资质作为资格条件 | 国务院取消行政审批项目系列决定 |

未命中不代表条款合法——规则只做保守拦截，最终判断由人作出。

## 事实字段来源策略

| 字段类别 | 允许来源 | 禁止来源 |
|---|---|---|
| 企业名称、统一社会信用代码 | 人工录入 / 已核验企业库 | 联网搜索、类似项目、模型生成 |
| 资质证书编号与有效期 | 人工录入 / 已核验企业库 | 任何自动填充 |
| 业绩项目名称、金额、合同 | 人工录入 / 已核验企业库 | 从类似项目「借用」 |
| 人员姓名、证书、社保 | 人工录入 / 已核验企业库 | 模型生成 |
| 检测结论、认证状态 | 人工录入 / 已核验企业库 | 模型推断或联网推测 |
| 技术方案描述、行业做法 | 人工录入 / 已核验企业库 / L1 / L2 / L3 | — |
| 具体性能承诺（数字） | **必须人工确认** | 模型自主生成 |

外部引用（L1/L2/L3）写入后仍为 `UNVERIFIED`——内容有来源，不等于本企业事实已核实。

## 配置

```yaml
- id: mont-bidcopilot
  name: 'dsh-mont-bidcopilot'
  config:
    dataDir: ''              # 默认 <DSH_HOME>/bidcopilot/projects
    allowWrite: true         # false 时所有写工具返回 E_READONLY
    selfDupThreshold: 0.85   # 自我复制阈值
    collusionThreshold: 0.65 # 围标阈值
    kbDir: ''                # 企业资料目录
```

DSH 的 `config` 是整体替换、不深合并，覆盖时必须重述全部字段。

## 测试

```powershell
node --test 'test/*.test.js'
```

五组基线加元数据组，共 110 项用例：

| 组 | 文件 | 内容 |
|---|---|---|
| 功能正确性 | `test/functional.test.js` | 需求解析、行业匹配、18 项解析、目录、写作、docx/ZIP/CRC32、BM25、门控 |
| 合规不可绕过 | `test/compliance.test.js` | T-B1~T-B5 各含命中与未命中用例、来源注入被拒、雷同阈值独立、无批量入口 |
| 门禁不可绕过 | `test/gates.test.js` | 未批准不推进、伪造凭证被拒、模型无批准通道、UNVERIFIED 阻断导出、审计链防篡改、拒绝即冻结 |
| 门禁人机通道 | `test/gate-channel.test.js` | 工具面无批准项、`/bidcopilot-gate` 可写审计链、未解决项挡放行、拒绝冻结、重复裁决被拒、缺参数给用法 |
| 清单与版本契约 | `test/manifest.test.js` | `engines.dsh >=0.2.2-rc.1` 且运行时落在范围内、无安装期脚本、零依赖、ping 数量如实、schema 合规 |
| 包元数据与权限披露 | `test/metadata.test.js` | en/zh locale 三字段齐备、描述含权限信息、英文纯英文、detail 单行图片、SVG 无脚本/文本/远程引用、README 首屏权限表 |

## 已知限制与未实现项

如实列出，避免高估本插件能力：

| 项 | 状态 | 说明 |
|---|---|---|
| 可视化工作台 UI（`client.js`） | **未实现** | 门禁面板当前用 `/bidcopilot-gate` 斜杠命令代替，功能等价但没有图形界面 |
| PDF 导出 | **未实现** | 只产出 `.docx`（纯 JS OOXML + 自写 ZIP） |
| OCR（扫描件识别） | **未实现** | 只接受已是文本的内容 |
| 向量检索 | **未实现** | 知识检索用 BM25 + 中文 bigram，无 embedding |
| Codex / Qoder 平台外壳 | **未实现** | 只做 DSH 原生插件；`plugin.json` 与三平台声明文件未提供 |
| 合规规则的完备性 | **有限** | 规则是确定性正则匹配，未命中不代表条款合法；规则库需随资质改革维护 |
| 雷同检测 | **有限** | 基于 SimHash + 字符 n-gram，对语义改写、翻译回译不敏感；作用是提示而非判定围标 |

## 许可证

MIT。上游归因见 [NOTICE.md](NOTICE.md)——含一个必须按 AGPL 处理、因此**不吸收任何源码**的组件（BidMaster-Pro，其 LICENSE 正文为 AGPL v3 而 README 标 MIT，取从严解释）。

安全披露见 [SECURITY.md](SECURITY.md)。
