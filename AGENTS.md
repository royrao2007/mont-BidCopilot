# AGENTS.md — mont-BidCopilot 项目级指令

> **开工必读**：任何代码修改前，先读 `fixlog/ARCHITECTURE.md` 与 `fixlog/API.md`；任何修复必须同时登记到 `fixlog/缺陷修复记录.md`，未登记视为未完成。全文规则见文末「「文档即地图」工程铁律」一节。

---

## 项目速览

- **包名**：`dsh-mont-bidcopilot`　**版本**：0.5.0
- **类型**：DeepSeek Harness 插件（Cordis bundle）
- **作用**：招投标双模辅助编制引擎，注册 32 个 `mont_*` 工具
- **宿主基线**：DSH 0.2.2-rc.5、`@deepseek-ai/cordis` 4.1.0、`@deepseek-ai/schemastery` 3.19.0、Node ≥24.9.0
- **硬约束**：运行时零第三方依赖、不联网、不启子进程、不读凭据、无安装期脚本

## 目录地图

| 路径 | 内容 |
|---|---|
| `index.js` | 装配器：`name`/`inject`/`Config`/`apply`，启动自检 |
| `lib/` | 15 个业务模块（见 `fixlog/ARCHITECTURE.md`） |
| `test/` | 222 个用例，`node --test "test/*.test.js"` |
| `scripts/` | 脱敏扫描、推送闸门、冒烟脚本（不进 npm 包） |
| `hooks/` | `post-commit` 自动推送钩子源（`npm run install-hooks` 安装） |
| `data/` | 合规规则库、行业骨架、政策库（随包分发） |
| `locale/` | en/zh 元数据 |
| `market/` | 自建市场索引 `index.json` |
| `docs/` | 插件详情页素材（`DETAIL*.md`、`preview*.svg`） |
| **`fixlog/`** | **工程文档与修复台账（本规则唯一权威文档区）** |

## 常用命令

```bash
node --test "test/*.test.js"     # 全量测试
node scripts/smoke-load.js       # 加载冒烟（Config/工具注册/准入检查）
npm run prescan                  # 脱敏扫描（推送前必过）
npm run push:gitee               # 推 Gitee（含脱敏闸门）
npm run push:github              # 推 GitHub（含脱敏闸门）
npm run install-hooks            # 安装 post-commit 自动推送钩子
```

## 代码约定

1. **零运行时依赖**：`package.json#dependencies` 必须保持为空，不得引入第三方包。
2. **写操作必过 store**：所有磁盘写入经 `lib/store.js`，它带 `assertWritable()` 只读守卫与路径逃逸防护。不要在别处直接 `fs.write`。
3. **新增写工具要挂准入条件**：在 `lib/tools.js` 的 `WRITE_TOOLS` 集合里登记，否则只读模式下它不会被摘除。
4. **错误码稳定**：工具返回 `{ ok:false, error:{ code, message } }`，错误码是契约，改名属破坏性变更。
5. **合规不降级**：`assertComplianceKernel` / `assertWorkflowEngine` 失败必须 throw，不允许"禁用相关工具继续跑"。
6. **中文注释承载取舍**：非显然的设计决定要写明为什么，不只是写做什么。

## 发布约定

升版时同步：`package.json#version` → `market/index.json`（`version` + `versions[0].version` + `publishTimestamp` 真实 Unix 秒）→ `CHANGELOG.md` 顶部加段 → `fixlog/API.md` 与 `ARCHITECTURE.md` 受影响条目 → `README.md` 版本要求表。详见 `DISTRIBUTION.md` 的发版清单。

## 推送约定

- 说明性文档可推（README/CHANGELOG/NOTICE/SECURITY/DISTRIBUTION/docs/DETAIL*）
- 内部开发文档与会话记忆**不推**（`.gitignore` 已排除 `docs/会话记忆-*.md`、`*实施方案*.md`）
- 推送前必须过脱敏扫描，不得包含密钥/令牌/密码/内网地址/本机路径/个人信息
- GitHub 与 Gitee 分开单独推送，不配置双 pushurl

---

## 「文档即地图」工程铁律

本节为项目级强制约束，对本项目在**此对话框及新建对话框中的全部会话均生效，无需重复确认**。

### 铁律 1 — 先读地图再改地形

**任何代码修改前**，先读 `fixlog/ARCHITECTURE.md` 与 `fixlog/API.md`；修改后同步更新受影响条目。

理由：这两份文档是代码的地图。不读就改，等于在陌生地形上乱挖——改一处、落一处。

### 铁律 2 — 修复必须登记

**任何修复必须同时登记到 `fixlog/缺陷修复记录.md`，未登记视为未完成。**

"修了但没记"与"没修"在交付意义上是同一件事：下次没人知道这里改过、为什么改、怎么验证。

### 铁律 3 — 以代码为准

**文档与代码不符时，以代码为准并立即修正文档，不允许两种说法并存。**

发现冲突当场改文档。留一份"我们知道它不对的文档"，比没有文档更有害。

### 铁律 4 — 按批次跟踪，未修结转

**每次审核后的修复以该次审核结果为准；上一批未修的条目结转过来继续跟踪。**

未修条目进 `fixlog/缺陷修复记录.md` 末尾的「待跟踪」池，不许凭空消失。

### 铁律 5 — 全会话生效

**本规则对本项目在此对话框及新建对话框中的全部会话均生效，无需重复确认。**

### 执行流程

收到审核意见时：

```
① 把审核意见整理成编号清单 → 写进台账「本批清单」
   —— 没有清单就不要动手改
② 逐条修 → 每修完一条立刻改状态
③ 修不动的写「不修 + 理由」→ 进结转池
```

### 禁止事项

- ❌ 先改代码后补文档
- ❌ 改一堆再一次性补台账
- ❌ 有问题静默跳过
- ❌ 上一批未修条目凭空消失
- ❌ 文档里写"跑过了"这类不可复跑的验证

### 验收标准

- [ ] `fixlog/` 下存在 `ARCHITECTURE.md`、`API.md`、`缺陷修复记录.md` 三份文件
- [ ] 架构文档能回答「某功能在哪个模块」（存在功能索引表）
- [ ] 接口文档能回答「某接口入参与错误码是什么」（存在全局约定 + 错误码分段）
- [ ] 每批审核的**清单条目数 = 该批记录条目数**，且每条有终态
- [ ] 铁律已写入 `AGENTS.md`，**新会话可读到**（文首指引 + 本节）
