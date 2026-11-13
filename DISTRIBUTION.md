# 分发与收录状态

本文件记录 mont-BidCopilot 在各渠道的发布与收录进度，便于持续跟进。

**最后核对：2026-11-13 14:15（Asia/Shanghai）**

## 当前版本

| 项 | 值 |
|---|---|
| npm 包名 | `dsh-mont-bidcopilot` |
| latest 版本 | **0.1.3** |
| GitHub 仓库 | <https://github.com/royrao2007/mont-BidCopilot> |
| 许可证 | MIT |

## 渠道状态

| 渠道 | 状态 | 核对方式 | 下一步 |
|---|---|---|---|
| **npm 官方源** | 已上线 0.1.3 | `npm view dsh-mont-bidcopilot version --registry=https://registry.npmjs.org` | 无 |
| **DSH 插件页（npm 包名安装）** | 可用 | 输入框填 `dsh-mont-bidcopilot`，安装源选 npm 官方源 | 无 |
| **公共目录 dsh-plugin-catalog** | 待收录 | `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` 里搜包名 | 等下次重建（见下） |
| **自建市场索引（jsDelivr）** | 可用 0.1.3 | `https://cdn.jsdelivr.net/npm/dsh-mont-bidcopilot/market/index.json` | 无 |
| **自建市场索引（GitHub raw）** | 可用（网络不稳） | `https://raw.githubusercontent.com/royrao2007/mont-BidCopilot/master/market/index.json` | 国内建议用 jsDelivr 或 gh-proxy |

## 公共目录收录机制

`dsh-plugin-catalog` 是 DSH 生态的公共插件目录（CC0 许可，约 5539 个插件），**自动扫描 npm 收录，无需提交**。

- 重建频率：每天一次，约 **UTC 05:20**（北京时间 13:20）
- 判据：npm 包存在，且 `package.json` 带 `repository`、`homepage`、`keywords`、`license`
- 我的包已具备上述全部字段；`mont-forge` 同为该目录收录项（版本 0.2.0），可作对照

**时间差造成未收录**：0.1.0—0.1.3 的发布时间（UTC 05:41 起）都晚于当日重建点（05:19:54），因此最早要到下一个重建周期才进目录。

## 自建索引的订阅方式

在 DSH 里添加市场源：**插件 → 插件市场 → 发现 → 索引源**，填入：

```
https://cdn.jsdelivr.net/npm/dsh-mont-bidcopilot/market/index.json
```

本机 profile 已加入该索引（`cordis.patch.yml` 的 `plugin-market` 行），重启 DSH 后生效。

> 索引里的 icon 是内嵌 base64 data URL —— 市场无法访问本机路径或相对文件，外部图片地址在部分网络下也会超时。

## 复核命令

```bash
# 1. npm 最新版本
npm view dsh-mont-bidcopilot version --registry=https://registry.npmjs.org

# 2. 是否进入公共目录
curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json | grep -c dsh-mont-bidcopilot

# 3. 自建索引是否可用
curl -s https://cdn.jsdelivr.net/npm/dsh-mont-bidcopilot/market/index.json
```

## 发版清单（每次升版照做）

1. 改 `package.json` 的 `version`
2. 同步 `market/index.json` 里 `versions[0].version` 与 `publishTimestamp`（真实 Unix 秒）
3. 在 `CHANGELOG.md` 顶部加一条
4. `node --test "test/*.test.js"` 全绿
5. `npm publish --registry=https://registry.npmjs.org --access public`
6. `git add -A && git commit && git push`
7. 等约 60 秒确认 `npm view <包名>@<版本> version` 可见
