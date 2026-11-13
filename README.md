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

```powershell
# 在 DSH 会话里交给插件管理器（Desktop 插件页或 plugin_manager 工具）
plugin_manager install_bundle target: F:\DSHDesktop\chajian\mont-BidCopilot
```

环境要求：DSH `>=0.2.2-rc.1`，Node `>=22.5.0`。运行时零第三方依赖。

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
