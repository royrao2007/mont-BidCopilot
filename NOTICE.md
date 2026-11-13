# NOTICE — 上游组件归因

本包为 MIT 分发。下表逐组件列出源码吸收范围、许可证与原始版权行。
许可证状态为 2026-11-12 逐仓库核对 LICENSE 文件所得，不是文档推测。

## 1. 已确认可源码合并（MIT）

| 组件 | 仓库 | 许可证（核对依据） | 吸收范围 | 原始版权行 |
|---|---|---|---|---|
| dsh-plugin-bidkit | `Jegozhou/dsh-plugin-bidkit` | MIT（仓库根 `LICENSE` 全文为 MIT） | 招标解析字段清单、评分对齐目录思路、纯 JS .docx 导出（OOXML + 自写 ZIP） | `Copyright (c) 2026 BidKit contributors` |
| dsh-company-kb | `wu81313-lab/dsh-company-kb` | MIT（`LICENSE` 全文为 MIT） | 中文 BM25 + bigram 检索内核、显式调用门控（`lib/gate.js` 三条放行线索与否定词窗口逻辑） | `Copyright (c) 2026 wu81313-lab` |
| dsh-gatedflow | `TtTRz/dsh-gatedflow` | MIT（`LICENSE` 全文为 MIT） | 门禁即控制流、零突变、`interrupt` 暂停引擎、`gf_advance` 拒绝模型批准 的模型（本包按此模型用自有代码重写，未复制其 TypeScript 实现） | `Copyright (c) 2026 TtTRz` |
| rejection-check | `maike-china/rejection-check` | MIT（`LICENSE` 全文为 MIT） | 废标项三轮检查口径、错别字与逻辑谬误输出结构 | `Copyright (c) 2026 废标项检查工具` |

## 2. Apache-2.0（可吸收，需保留声明）

| 组件 | 仓库 | 许可证（核对依据） | 吸收范围 | 处理方式 |
|---|---|---|---|---|
| BiaoShu-SKILL | `Get00/BiaoShu-SKILL` | Apache-2.0（仓库根 `LICENSE` 为 Apache 2.0 全文） | 8 大行业骨架与行业检测规则（`BiaoShu-writer-pro/references/industry_configs.json`，实测 8 个行业：it_information / construction / medical / education / manufacturing / logistics / consulting / general，检测法 keyword_matching，阈值 0.3，回退 general） | 只吸收数据（XML 转 JSON 后作为本包 `data/industry-guides/` 的数据文件），不引入其 Python 运行时；修改过的文件在 CHANGELOG 标注 |
| BidCopilot | `xrzlizheng/BidCopilot` | Apache-2.0（仓库根 `LICENSE` 为 Apache 2.0 全文） | 24 条合规预检规则的口径参考、合同审查检查点、招标解析流程划分 | 规则重写为本包 YAML/JSON 数据（`data/compliance-rules/`），流程用自有 JS 重写；不引入 FastAPI/Next.js 运行时 |

Apache-2.0 §4 要求：分发衍生作品须附许可证副本（见 `LICENSE` 末段与本节）、修改过的文件须显著标注（见 `CHANGELOG.md`）、保留原始版权与归因声明（本节）。

## 3. AGPL-3.0 —— 明确排除，不吸收任何源码

| 组件 | 仓库 | 许可证（核对依据） | 结论 |
|---|---|---|---|
| much-agents（标书哨兵） | `lj105183000/much-agents` | AGPL-3.0-or-later（`LICENSE` 为 AGPL v3 全文；仓库 topics 亦标 `agpl`） | 不吸收任何源码、不吸收任何受其版权的文件。仅参考“跨章节一致性台账”“审计哈希链”的**设计思路**，用本包自有代码独立实现 |
| BidMaster-Pro | `guangshu100/BidMaster-Pro` | **AGPL-3.0**（仓库根 `LICENSE` 为 AGPL v3 全文，`pyproject.toml` 未声明 license 字段，README 徽章与末尾却写 MIT —— 仓库自相矛盾） | 按更严格的 LICENSE 正文处理：**不吸收任何源码**。其“21 项合规检查清单”位于 Python `skills/check/compliance_check`，本包只把**检查项目口径**重写为自有 JSON 规则（`data/review-checklists/`），检查项名称属公有领域的方法描述，不复制其代码、注释或文档文本 |

> 关于 BidMaster-Pro 的许可证矛盾：仓库 LICENSE 正文为 AGPL v3，README 声称 MIT，两者冲突。本包取从严解释（AGPL），因其传递性会迫使整个分发转 AGPL。若上游日后修正为 MIT，可在 CHANGELOG 标注后提升吸收级别；在此之前不碰其代码。

## 4. 未吸收的许可证待确认项

截至 v0.1.0，第 1—3 节已覆盖全部组件，不存在“许可证待确认”项。

## 5. 数据文件的许可证边界

规则数据（`data/compliance-rules/*.json`、`data/review-checklists/*.json`、`data/industry-guides/*.json`）为独立数据文件，其中：
- 法规条文原文属公有领域；
- 行业骨架结构来自 Apache-2.0 的 BiaoShu-SKILL，已按 §2 处理；
- 检查项名称与判定口径为本包自行归纳，不复制任何 AGPL 组件的表达。
