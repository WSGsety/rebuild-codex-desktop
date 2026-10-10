# Statsig 云控历史映射与脚本入口

> 历史分析笔记，原记录来自 `index-MmO6ZWIv.js`。该混淆文件名不对应当前构建，下面的 ID、函数名和下发计数未按最新版重新提取，不能当作当前云控开关或用户功能可用性的保证。部分 featureKey 在原客户端注册表中可见，其余用途属于当时分析。

## 历史 Feature Gates（原下发样本 30 项，另附 sunset 观察）

| ID | 功能 | 组件/函数 | 说明 |
|---|---|---|---|
| `505458` | Composer Mode | `Pvn` / `Vvn` | 控制 composer 模式选项（code/ask 等） |
| `30039772` | `enable_request_compression` | `HUn` | 请求压缩 |
| `98625937` | 账户设置面板 A | `GNe` | 用户设置/认证下拉菜单 |
| `351086149` | 原分析未定位用途 | — | 原分析未找到引用 |
| `351460523` | Follow-up 排队 | `Iwn` | 自动跟进建议 |
| `1060282072` | 协作模式 UI | `mae` / `NRn` / `jjn` | 协作模式相关组件 |
| `1156958996` | `collaboration_modes` | `HUn` | 协作模式功能开关 |
| `1221508807` | Archive Thread | `ef` | 归档会话线程 |
| `1230000863` | 原分析未定位用途 | — | 原分析未找到引用 |
| `1444479692` | `personality` | `LZe` / `HUn` | 个性化/人格 |
| `1609556872` | Hotkey 窗口 | `jxn` | 快捷键窗口功能 |
| `1823130936` | Image Input | `ICn` | 判断模型是否支持图片输入 |
| `1846562237` | Onboarding 登录 | `TFn` | 登录流程/resume 控制 |
| `2239678350` | 原分析未定位用途 | — | |
| `2313552244` | 原分析未定位用途 | — | |
| `2451719447` | 原分析未定位用途 | — | |
| `2761175068` | Feature Rollout 守卫 | `PXe` | 通用 gate 包裹组件 |
| `2777274066` | 原分析未定位用途 | — | |
| `2878153158` | 原分析未定位用途 | — | |
| `2882842607` | 会话 Diff/评论 | `Uae` | 对话中的代码 diff 和评论 |
| `2968710568` | 原分析未定位用途 | — | |
| `3075919032` | 主界面布局 | `iUt` | 拖拽/面板布局 |
| `3189729426` | 原分析未定位用途 | — | |
| `3227700559` | ChatGPT 认证流 | `QBn` | ChatGPT auth 方式检测 |
| `3390468622` | `request_rule` | `HUn` | 请求规则 |
| `3798472673` | 原分析未定位用途 | — | |
| `4059535852` | 原分析未定位用途 | — | |
| `4100906017` | 语音输入/听写 | `Gxn` | dictation 功能 |
| `4166894088` | 账户设置面板 B | `GNe` | 与 `98625937` 同函数 |
| `4276547895` | 原分析未定位用途 | — | |
| **`2929582856`** | **App Sunset 强制更新** | **`aUn`** | **原分析中的强制更新守卫** |

### HUn 注册表中的 featureKey 映射

```
gate 30039772   → enable_request_compression
gate 1786883712 → unified_exec
gate 1615536597 → shell_snapshot
gate 770526561  → remote_models
gate 2828273915 → responses_websockets
gate 2734851136 → responses_websockets_v2
gate 1156958996 → collaboration_modes
gate 1444479692 → personality
gate 3390468622 → request_rule
gate 2357796820 → apps
gate 2911102190 → sqlite
gate 2307253562 → codex_git_commit
```

> 注：以上 12 个 gate 在 HUn 中注册但部分未出现在实际下发的 30 个 gate 列表中，这一差异只描述原样本，不能证明最新版或其他用户会收到同样的集合。

## 历史 Dynamic Configs（原样本 15 项）

| ID | 功能 | 组件/函数 | 说明 |
|---|---|---|---|
| `107580212` | 模型配置 | `ZEe` | 获取可用模型列表 |
| `1121645430` | A/B 实验分组 | `zge` | 获取 experiment group name |
| `3210878109` | Personality 配置 | `LZe` | 获取个性化设置参数 |
| 其余 12 个 | 原分析未定位用途 | — | 客户端未直接引用 |

## 历史 Layers（原样本 6 项）

| ID | 功能 | 组件/函数 | 说明 |
|---|---|---|---|
| `72216192` | i18n 配置层 | `jjt` / `Xkn` / `tWn` | `enable_i18n`、`locale_source` 等参数 |
| `745800994` | WebSocket 特性层 | `HUn` | `responses_websockets` 相关 |
| `3902942138` | Git Commit 特性层 | `HUn` | `codex_git_commit` 相关 |
| 其余 3 个 | 原分析未定位用途 | — | |

## 当前相关脚本

默认补丁入口和调用列表以 [patch-all.js](patch-all.js) 为准。下表描述现有源码的匹配策略，不表示已验证最新上游 bundle 全部命中；实际修改前查看源码或使用对应 `--check`。

| 脚本 | 当前策略 | 是否由 patch-all 默认调用 |
| --- | --- | --- |
| [patch-sunset.js](patch-sunset.js) | AST 定位 `appSunset` 相关数字 gate，替换为 `!1`，不依赖旧混淆函数名 | 否 |
| [patch-statsig-logger.js](patch-statsig-logger.js) | 在 Statsig `_setStatus()` 注入值日志，先查找 statsig chunk，再兼容 index chunk | 否 |
| [patch-i18n.js](patch-i18n.js) | AST 定位 `.get("enable_i18n", ...)`，替换为 `!0` | 是 |
| [patch-devtools.js](patch-devtools.js) | 修改 `allowInspectElement` / `devTools` 属性值 | 是 |
| [patch-copyright.js](patch-copyright.js) | AST 定位 About 版权设置并替换文本 | 是 |

原笔记中的 `patch-process-polyfill.js` 已不在仓库，不能作为可执行入口。

## 备注

- 原笔记记录的名称哈希公式为 `(hash << 5) - hash + charCode`，结果 `>>> 0` 转无符号；其 SDK 来源未在本次复核，不再将该公式标为已确认的当前 Statsig 算法。
- 原始名称、哈希与用途不能仅凭旧混淆符号推定；需要对应版本源码或实际响应作为证据。
- 未验证当前版本在未登录或无网络时的全部 gate 默认值，不沿用“所有 gate 默认 FALSE”的旧结论。
- 原笔记记录 `2929582856` 未出现在当时常规下发列表；延迟加载或特定条件触发只是原分析假设，本次没有核验当前触发条件。
