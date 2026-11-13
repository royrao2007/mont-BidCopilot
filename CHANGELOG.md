# CHANGELOG

## 0.1.0 — 2026-11-12

首个可装载版本。与 `mont-BidCopilot实施方案.md`（v1.0 文档）的差异全部在此记录。

### 架构选择

- **真插件而非技能包。** 通过 `ctx.tools.register` 注册 21 个 `mont_*` 工具，模型可直接调用。文档 §4.3 只列了工具名，未说明注册方式；本实现明确走 Host 工具注册路径，不走 `skills/` 目录发现。
- **DSH 装载按实际 schema 写。** `package.json#dsh.bundle.patch` 指向 `cordis.patch.yml`，patch 行含 `id`/`name`/`config`。文档 §9.3 写的「单条 insert 指向 mcp.json」与当前 DSH 0.2.2-rc.2 的实际装载语法不符（MCP 需 `@deepseek-ai/dsh-mcp-client` + `transport`/`command`，不是指向 json 文件），故未采用 MCP 通道，直接做原生 Cordis 插件。
- **运行时零第三方依赖。** SQLite FTS5 未采用，改为纯 JS 的 BM25 + 中文 bigram。实测本机 `node:sqlite` 的 FTS5 与 trigram 均可用，但引入它会绑定 Node 内建模块与数据库文件生命周期，对一个以「无安装期脚本、无原生编译」为披露承诺的插件不划算；检索规模（企业资料目录级）用 BM25 足够。

### 对文档的修正

- **`WorkflowState` 增加审计链。** 文档 §5.1 的 `gates: GateStatus[]` + `approvedBy?: string` 只记「最后谁签的」，无法满足 §14 的「门禁不可绕过」可追溯要求。改为 append-only 的 `gateRecords[]`：seq、门号、决策、操作人、时间戳、被审对象 SHA-256、结论、前驱哈希、自封签哈希。
- **审计链自封签为必需项。** 只校验「前驱哈希指针」时，末条记录被篡改无法被发现（无后继指证）。加自封签后三重复核，并由 `assertWorkflowEngine()` 在启动时对「末尾篡改」做自检，失败即拒绝启动。
- **雷同阈值拆成两条。** 文档 §6.4 用单一 0.65 同时卡「生成文本 vs 模板」与「跨投标人」，会在复用自家模板时大量误报。拆为自复制 0.85 与围标 0.65，两条规则两个阈值，独立判定。
- **引擎不可用的处置统一为拒绝启动。** 文档 §8.2 写「禁用相关流水线」，§4.2 写「合规内核与工作流引擎注册失败时整体拒绝启动」，两者冲突。取 §4.2 更严格口径：`assertComplianceKernel()` 与 `assertWorkflowEngine()` 任一失败即不注册任何工具。
- **法规依据分级。** 文档 §2.3 把发改法规〔2026〕195号与《公平竞争审查条例》《政府采购法》并列为「法律依据」。该文为八部门联合印发的**部门规范性文件**（指导性意见，无罚则），已改注为政策依据；T-B1~T-B3 的法定锚点补《招标投标法实施条例》第三十二条。

### 许可证修正（重要）

- **BidMaster-Pro 从「可吸收」降级为「不吸收任何源码」。** 实测其仓库根 `LICENSE` 为 AGPL v3 全文，`pyproject.toml` 未声明 license 字段，README 徽章与末尾却写 MIT——仓库自相矛盾。取从严解释（AGPL），否则其传染性会迫使整个分发转 AGPL。只把检查项**口径**重写为自有 JSON，不复制其代码、注释或文档文本。
- **BiaoShu-SKILL 归入 Apache-2.0 组并保留归因。** 实测 `LICENSE` 为 Apache 2.0 全文，非文档所写「预期开源」模糊项。行业分类与关键词检测规则（8 行业、keyword_matching、阈值 0.3、回退 general）与其 `industry_configs.json` 一致，按 Apache-2.0 §4 在 `NOTICE.md` 保留原始版权行。
- 另三个组件许可证实测确认：dsh-plugin-bidkit（MIT）、dsh-company-kb（MIT）、dsh-gatedflow（MIT）、rejection-check（MIT）。文档标注为「待确认」的三项至此全部确定。

### 版本契约

- `engines.dsh` 定为 `>=0.2.2-rc.1`（与同目录已装 `montagex-kernel` 写法一致），并由 `test/manifest.test.js` 固定：既断言下限不低于 `0.2.2-rc.1`，也读本机实际运行时版本做真比对，读不到时跳过而非假绿。
- `engines.node` 定为 `>=22.5.0`。

### 已实现 / 未实现

已实现：T-B1~T-B5 硬阻断；事实来源白名单与状态机；三门禁与审计链；**门禁人机通道（`/bidcopilot-gate` 命令 + Host 服务）**；评分对齐目录；18 项解析；跨板块一致性；双阈值雷同自检；纯 JS OOXML `.docx` 导出（自写 ZIP + CRC32）；BM25 检索与显式门控；8 行业骨架；21 个工具。

未实现（明确不在 v0.1.0 范围）：可视化工作台 UI（`client.js`，即门禁面板的图形界面——当前用 slash command 代替）、PDF 导出、OCR、向量检索、多平台外壳（Codex/Qoder 声明文件）。这些不在本版本声明的能力内，`README.md` 与 `mont_ping` 均未宣称。

### 安装方式（本机特殊情况）

本 profile 的 `node_modules\zod_tmp_25000_3` 是一个 ACL 拒绝所有访问的空目录残留（2026-11-12 21:02 一次 pnpm 安装中断留下），它会让任何 `plugin_manager install_bundle` 在 pnpm 清扫阶段报 EPERM 而失败。取证：对该目录 GENERIC_READ / READ_CONTROL / DELETE / WRITE_DAC / WRITE_OWNER / GENERIC_WRITE 全部 err=5；同父目录下 `zod` 可正常读取；全库仅此一处；`takeown`、`icacls /reset` 均失败，因为当前会话是非提权管理员令牌（`Administrators` 为 "Group used for deny only"，无 `SeTakeOwnershipPrivilege`）。

绕开方式（已执行并验证）：用 junction 把源码目录接到 profile 的 node_modules，再在 profile 的 `package.json` 登记 bundle 与 `link:` 依赖。Loader 已识别该行（`patchId: mont-bidcopilot`），改动需重启 DSH 生效（`restart-required`，该 profile 无 HMR）。

彻底修复仍需管理员权限，一条即可解除：先以管理员身份打开 PowerShell，再执行 `takeown /f "…\zod_tmp_25000_3"` 与 `icacls "…\zod_tmp_25000_3" /reset`，之后可改用常规 `plugin_manager install_bundle`。

### 已修缺陷

- **Config 契约（两次才对）**。第一版把 `Config` 导出成普通对象，Loader 报 `Cannot read properties of undefined (reading 'validate')`，fiber `failed`。第二版误以为契约是 `Config.validate`，改成自造 `validate` 方法——仍然是错的，因为**真实契约是 Standard Schema 规范的 `Config['~standard'].validate(...)`**。本机实测确认：schemastery 的 schema 实例上 `schema.validate` 为 `undefined`，而 `schema['~standard'].validate({})` 返回 `{ value }`、非法输入返回 `{ issues }`。最终改为：优先用宿主 `@deepseek-ai/schemastery` 构造真 schema（`vendor: schemastery`），取不到时用等价的最小 Standard Schema 实现（`vendor: mont-bidcopilot`）；并把契约、默认值、`issues` 行为、`validateConfig` 一致性全部写入 `test/manifest.test.js` 固定。
- **写 profile `package.json` 曾引入 UTF-8 BOM**，会让 DSH 解析失败。已用无 BOM 编码重写，并以备份逐字段比对确认改动仅为「新增 1 个 bundle + 1 个依赖」。
- **一次误改已逐字节还原**：`cordis.patch.yml` 曾被追加一段后又删除，SHA256 与操作前备份完全一致。

### 包元数据与权限披露（0.1.0 内补齐）

按 DSH 的 `host-plugin.md` 与 `plugin-details.md` 规范补齐分发所需的显示元数据：

- **`locale/en.json` 与 `locale/zh.json`**：`meta.title`、`meta.description`、`meta.detail` 三字段齐备。`meta.description` 是权限披露的**正式载体**，写明：读取范围（只读你点名的企业资料目录）、写入位置（`DSH_HOME/bidcopilot/projects`）、无网络请求、无子进程、不读凭据、无安装期脚本、关闭后的变化（移除 21 个工具与门禁命令、停止写入、项目目录保留）。英文描述为**纯英文**（不含汉字），中文描述为中文。
- **`docs/DETAIL.md` / `docs/DETAIL.zh.md`**：各恰好一行带替代文本的图片，符合规范对详情文档的格式要求。
- **`docs/preview.svg` / `docs/preview.zh.svg`**：640×300 自包含 SVG，不含 `script`/`style`/`text`/`foreignObject`/动画与远程引用，明暗主题下均可读。
- **`package.json`**：新增 `./locale/*.json` 导出，`files` 增加 `locale` 与 `docs`，`icon` 与 `./icon` 导出保留；顶层 `description` 改为英文并写明工具数量与「无安装期脚本」。`npm pack --dry-run` 实测 29 个文件、192.2 kB，locale 与 docs 均在包内。
- **`README.md` 首屏**：加英文摘要与「权限一览」表格（读取/写入/网络/进程/凭据/安装期脚本/自动更新 + 关闭后变化 + 隔离试用建议），并新增「已知限制与未实现项」表。

新增测试组 `test/metadata.test.js`（14 项）把这些钉死：locale 三字段、描述必须含权限关键词、英文描述不得含汉字、detail 单行图片且图片存在、SVG 无禁用元素与远程引用、README 首屏权限表与「安装即授权」、以及**不得宣称未实现能力**。

### 文档：安装与使用步骤（0.1.0 内补齐）

README 原先只有一行安装命令与工具清单，缺可照做的操作流程。本次补齐：

**安装章节**（7 个子节）：环境要求与检查命令、命令行安装、图形界面安装、**三条可观察的成功判据**（`application` 状态 / `fiberPhase: active` / `mont_ping` 返回 `toolCount: 21`）、升级、卸载（说明项目目录保留）、安装故障排查表（含 EPERM 坏目录、`fiberPhase: failed`、`restart-required` 等 5 类现象与处理）、目录与数据位置。

**使用章节**（7 个子节）：

- 投标侧 9 步完整链路：建项目 → 解析 → 目录 → 写正文 → 登记事实 → 锁定 → 雷同自检 → 门禁 → 导出。每步都写明「说什么」与「对应哪个工具、返回什么、返回值为异常时怎么办」。
- 招标侧 5 步链路，含「试一下拦截效果」的具体输入。
- 单独查条款是否违规、查事实来源规则、门禁命令速查、知识库目录配置、6 条常见问题（含为何 agent 不能批门禁、为何业绩不能联网搜）。
- 导出阻断码对照表：5 个 `E_*` 码各自含义与解法。

新增 4 条测试锁定文档完整性：安装章节 8 个必选小节齐全、使用章节覆盖 15 个关键工具、门禁命令可直接复制、**README 提到的工具名与代码注册的 21 个完全一致（无虚构、无遗漏）**。

### 测试与实证

- 六组基线 **118 项全绿**。
- 真实装载通路验证（Cordis 风格 ctx 调 `apply()`）：`Config['~standard'].vendor = schemastery`、注册工具 **21** 个、`mont_ping.toolCount = 21`、`mont_guard_check_clause` 命中返回 `T-B1`。
