# 分发与收录状态

本文件记录 mont-BidCopilot 在各渠道的发布与收录进度，便于持续跟进。

**最后核对：2026-11-18 18:30（Asia/Shanghai）**

## 当前版本

| 项 | 值 |
|---|---|
| npm 包名 | `dsh-mont-bidcopilot` |
| latest 版本 | **0.4.3** |
| GitHub 仓库 | <https://github.com/royrao2007/mont-BidCopilot> |
| 许可证 | MIT |

## 渠道状态

| 渠道 | 状态 | 核对方式 | 下一步 |
|---|---|---|---|
| **npm 官方源** | 已上线 0.4.3 | `npm view dsh-mont-bidcopilot version --registry=https://registry.npmjs.org` | 无 |
| **DSH 插件页（npm 包名安装）** | 可用 | 输入框填 `dsh-mont-bidcopilot`，安装源选 npm 官方源 | 无 |
| **公共目录 dsh-plugin-catalog** | **未收录（被动扫描不会自动收）** | 当日全部 5 个构建（含 2026-11-18 05:28 UTC 最新）搜 `bidcopilot` 均为 0 命中 | **必须向 awesome-dsh-plugin 提 PR**（见下） |
| **自建市场索引（jsDelivr）** | 可用 0.4.3，但描述滞后 | 索引里写「21 个 mont_* 工具」「评分对齐目录」；0.4.0 起实际是 32 个，且已在 `package.json` 描述中改掉 | 修正 `market/index.json` 描述后补发版本（见发版清单） |
| **自建市场索引（GitHub raw）** | 可用（网络不稳） | `https://raw.githubusercontent.com/royrao2007/mont-BidCopilot/master/market/index.json` | 国内建议用 jsDelivr 或 gh-proxy |

## 公共目录收录机制

`dsh-plugin-catalog`（npm 包，CC0，约 11519 条目）是 DSH 生态公共插件目录，由 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的精选列表 **生成**，站点 `https://awesome-dsh-plugin.com` 与市场索引同源。

- 重建频率：每天 1—3 次（近期 UTC 04:00—06:00 之间，偶有额外构建）
- **收录来源：只收精选列表 `data/plugins/*.yml` 里有的仓库**，不是按 npm 包全量被动扫描
- 反面证据（2026-11-18 核对）：`dsh-mont-bidcopilot@0.4.3` 自 11-17 17:20 UTC 发布后，已跨过 11-18 05:28 UTC 的构建仍 0 命中；同一目录里 `mont-forge` 在列，`dsh-mont-bidcopilot` 不在。`https://awesome-dsh-plugin.com/p/royrao2007/mont-BidCopilot/` 返回 404，而 mont-forge 同名页面 200。

**结论**：此前「自动扫描 npm、等重建即可」的判断不成立，唯一入口是提 PR。

### 提 PR 的落点与门槛（已逐条核对，均满足）

在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 新建一个文件 `data/plugins/royrao2007__mont-BidCopilot.yml`（不要改 README，README 由脚本生成）：

```yaml
url: https://github.com/royrao2007/mont-BidCopilot
name: royrao2007/mont-BidCopilot
category: tools
description:
  en: 'Dual-mode tender and bid drafting engine: 32 mont_* tools with code-enforced compliance rules, a fact-source allowlist, three human gates with a tamper-evident audit chain, and pure-JS .docx export.'
  zh: '招投标双模辅助编制引擎：32 个 mont_* 工具，含代码层合规校验、事实来源白名单、三道人工门禁与防篡改审计链、纯 JS 导出 .docx。'
icon: https://raw.githubusercontent.com/royrao2007/mont-BidCopilot/master/assets/icon-180.png
```

门槛自查表：

| 要求 | 本仓库状态 |
|---|---|
| `package.json` 声明 `dsh.bundle`（仅有 `dsh.client` 不算） | ✅ `dsh.bundle.patch: ./cordis.patch.yml` |
| 仓库内有真实可运行代码 | ✅ 35 个文件、`lib/` 完整 |
| 仓库创建满 1 天 | ✅ 2026-11-13 创建，已 5 天 |
| 仓库带 `dsh-plugin` topic | ✅ topics 含 `dsh-plugin` |
| 官方 `@deepseek-ai/*` 用 peerDependencies | ✅ `@deepseek-ai/cordis` 在 peerDependencies（且 optional） |
| icon 为 GitHub 托管位图 | ✅ `assets/icon-180.png`（注意 `icon.svg` 不被接受） |
| 一个 PR 最多 3 条 | ✅ 本次 1 条 |
| 描述含 `: ` 需加引号 | ✅ 已加引号 |

⚠️ 提 PR 前必须先 `git push`：GitHub 上 `master` 仍停在 `c104e8b`（0.4.2 元数据），repo API 的 `pushed_at` 却是 11-17 17:18，两者不一致；评审会以仓库里的 `package.json` 为准。

## 自建索引的订阅方式

在 DSH 里添加市场源：**插件 → 插件市场 → 发现 → 索引源**，填入：

```
https://cdn.jsdelivr.net/npm/dsh-mont-bidcopilot/market/index.json
```

本机 `profiles/desktop/cordis.patch.yml`/`cordis.patch.yml` 里**目前没有** `plugin-market` 或索引源配置（2026-11-18 核对 grep 无命中），此前「已加入该索引」的记录不成立，需要手动在界面里加一次。

> 索引里的 icon 是内嵌 base64 data URL —— 市场无法访问本机路径或相对文件，外部图片地址在部分网络下也会超时。

## 复核命令

```bash
# 1. npm 最新版本
npm view dsh-mont-bidcopilot version --registry=https://registry.npmjs.org

# 2. 是否进入公共目录
curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json | grep -c dsh-mont-bidcopilot

# 3. 自建索引是否可用
curl -s https://cdn.jsdelivr.net/npm/dsh-mont-bidcopilot/market/index.json

# 4. 精选列表条目是否存在（404 = 没收录）
curl -sI https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/data/plugins/royrao2007__mont-BidCopilot.yml

# 5. 商店页面是否可访问（与第 4 步同步变化）
curl -sI https://awesome-dsh-plugin.com/p/royrao2007/mont-BidCopilot/

# 6. GitHub 上 master 是否已含本地最新元数据
git rev-list --left-right --count origin/master...HEAD   # 第二个数 > 0 表示没推
```

## 发版清单（每次升版照做）

1. 改 `package.json` 的 `version`
2. 同步 `market/index.json` 里 `versions[0].version` 与 `publishTimestamp`（真实 Unix 秒）
3. 在 `CHANGELOG.md` 顶部加一条
4. `node --test "test/*.test.js"` 全绿
5. `npm publish --registry=https://registry.npmjs.org --access public`
6. `git add -A && git commit && git push`
7. 等约 60 秒确认 `npm view <包名>@<版本> version` 可见
8. 若 `market/index.json` 里的描述/工具数变了，同步更新 awesome-dsh-plugin 条目 yml（目录按天重建，改完次日生效）
