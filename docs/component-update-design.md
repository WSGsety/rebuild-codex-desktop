# Windows 组件更新与 GitHub Releases 存储方案

采用 GitHub Releases 存放全量包、组件包和最新版清单，Windows 本地更新器按文件 SHA256 复用本地内容，下载变化或缺失的组件，从符合目录检查的本仓库旧便携版直接组成最新版。适用范围是 Windows x64，不覆盖 Store 安装、共享目录或链接目录；不兼容更新器的旧目录使用目标版本全量包安装到新目录。

初版采用每个 Release 自包含的组件集合：最新版所需的组件全部位于同一个 Release。用户只需要能访问 GitHub 的正常附件下载链路，无需额外的存储服务、GitHub 登录或本地 Git 环境。

## 包存放在 Release 附件中

发布附件布局如下，名称中的尖括号表示待构建时生成的值：

```text
预览 Release preview-v<App版本>-cli-<CLI版本>
  Codex-components-preview-win-x64-<App版本>-cli-<CLI版本>-<ZIP哈希>.zip
  updater-preview.zip                  旧用户首次获取更新工具
  update.json                          最新版文件清单
  component-runtime-<ZIP哈希>.zip
  component-app-<ZIP哈希>.zip
  component-cli-<ZIP哈希>.zip
  component-tools-<ZIP哈希>.zip
  component-meta-<ZIP哈希>.zip
  SHA256SUMS.txt
```

源码和方案保存在 Git 仓库；大体积程序包放在 Release 附件中。Actions 构建目录只作发布准备，用户下载不依赖 CI 临时产物。

GitHub 每个 Release 最多允许 1000 个附件，每个附件必须小于 2 GiB，未规定单个 Release 总大小或下载带宽的总量上限。当前包有数千个文件，采用少量组件 ZIP，避免逐文件发布触及附件数量限制。[GitHub 官方限制](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas)

初版自包含会重复存放一些未变化的组件，但不会因为删除旧 Release 而破坏最新版下载。先接受这部分存储和上传成本；只有实际出现构建或存储压力时，再评估跨 Release 引用相同组件。跨版本复用旧附件并不是客户端按需下载的前提。

## 客户端只访问 GitHub 下载链路

未来正式渠道的更新入口计划为：

```text
https://github.com/WSGsety/rebuild-codex-desktop/releases/latest/download/update.json
```

当前预览按版本发布，每个版本只有一个 Prerelease，tag 为 `preview-` 加正式 tag，例如 `preview-v26.1007.21434-cli-0.162.1`。全量包、五组组件、清单、更新工具和校验表均在该版本的附件中，不保留固定入口或跳转发布。更新器 1.1.x 通过 GitHub Release 列表接口查询全部分页，只选择已公开、带清单的 `preview-` 预览版本，并按发布时间确定最新预览。取得版本后，整轮更新只使用该版本的清单与附件。

GitHub 支持固定的最新版附件下载入口。[官方说明](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)

清单中的全量包和组件包地址指向具体 Release 的稳定下载 URL。客户端读取一次清单后，整轮更新固定使用该清单中的版本和地址，不在下载过程中重新切换到另一版。清单不保存会过期的 CDN 签名 URL。

预览更新需要访问 `api.github.com` 查询版本列表，再访问 `github.com` 的附件地址及其 CDN；不依赖 `raw.githubusercontent.com` 或用户的 GitHub 登录。旧固定入口版工具需重新下载一次 `updater-preview.zip`。公开 Release 附件可以匿名下载。[Release 附件接口说明](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)

“可以访问 GitHub”需要包括附件下载所使用的官方 CDN。2026 年 10 月 9 日对本仓库当前全量包的 HTTP HEAD 查询返回 302，跳转域名为 `release-assets.githubusercontent.com`；后续下载也应接受 GitHub 官方下载域名的正常跳转。如果用户仅能打开 `github.com` 网页、无法访问附件 CDN，全量包和组件包都会受影响。

网络错误时保留原安装，给出具体失败地址和重试提示，不自动切换到第三方镜像，也不修改用户的 TUN 或系统代理配置。客户端沿用可用的系统代理；受限网络的附件可达性需要单独验证。

## 组件划分和清单字段

初版按固定路径和变动频率分组，避免每次按大小重新切块导致组件边界变化：

| 组件 | 内容 | 划分目的 |
| --- | --- | --- |
| runtime | 桌面宿主、根目录运行库、语言和运行时资源 | 运行环境未变时复用本地文件 |
| app | `app.asar` 和应用配套文件 | 独立处理界面和应用逻辑更新 |
| cli | Windows CLI 及其配套程序 | 同一版本的 CLI 程序成组下载 |
| tools | CUA、内置插件及其他工具资源 | 避免 CLI 更新带上大量未变工具 |
| meta | `build-info.json`、更新工具和兼容辅助文件 | 版本信息和更新器变更只需小包 |

具体路径归属由 `scripts/build-components.js` 的 `componentFor` 确定。新版主程序 `ChatGPT.exe` 属于 runtime，用户直接运行它；`检查预览更新.cmd` 只用于更新。每个目标文件只属于一个组件，所有目标文件和必要目录都纳入清单。组件超限时当前构建会失败，自动拆分尚未实现。

更新器使用 PowerShell 调用 .NET ZIP API，先检查条目路径、重复项、符号链接和清单匹配，再解包。构建保守限制全量 ZIP、组件 ZIP 和单个目标文件均小于 2,000,000,000 字节；遇超限时构建报错。[PowerShell 解包能力说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.archive/expand-archive?view=powershell-5.1)

`update.json` 至少包含以下数据：

| 字段 | 用途 |
| --- | --- |
| schemaVersion 和最低更新器版本 | 判断客户端能否理解该清单 |
| platform 和 arch | 限定 Windows x64 产物 |
| appVersion、codexCliVersion、buildId | 展示版本并区分同版本重新构建 |
| entryExecutable | 更新后正确的启动入口 |
| full | 全量 ZIP 的固定 URL、SHA256 和字节大小 |
| components | 组件 ID、ZIP 地址、ZIP SHA256 和字节大小 |
| files | 每个目标文件的相对路径、内容 SHA256、大小和所属组件 |
| directories | 需要存在的目录，包括空目录 |

ZIP 哈希用于检查下载内容，文件哈希用于本地复用和最终验证。构建标识依据版本、打包规则与目标文件内容生成，不依赖压缩时间。其计算排除自身写入产生的循环依赖。

`recipeId` 读取打包、发布和更新工具的源码字节；这些文件中的文案或换行变化也会影响构建规则标识。核对具体产物时以发布清单中的标识为准，不要求不同系统检出的源码字节自动相同。

清单只包含数据，不能包含任意 PowerShell 命令。所有文件路径必须留在指定的程序目录内。

## 任意旧版到最新版的本地流程

首次使用者下载所选渠道的全量包；普通全量版用户在明确选择组件预览后，把 `updater-preview.zip` 解压到现有程序目录；已有组件版用户继续使用组件更新工具，必要时升级工具。同版本重发也按当前清单检查文件哈希。正式全量包不附带该预览工具，组件预览全量包携带工具。完整使用流程见 [使用者 Skill](../.agents/skills/codex-desktop-update/SKILL.md)。

双击 `检查预览更新.cmd` 只负责更新，应用启动直接运行 `ChatGPT.exe`。更新器使用 Windows PowerShell，程序目录中的更新脚本先复制到安装目录旁的临时工作目录，再由临时副本执行，避免替换自身文件和工作目录时发生锁定。

1. 读取最新版清单，逐个比较目标文件的 SHA256。内容相同的文件在本地复用；缺失或不同的文件使其所属组件进入下载列表。旧版缺少 `build-info.json` 时仍可比对文件，不要求经过任何中间版本。
2. 下载必要组件并验证 ZIP SHA256，在同一磁盘的临时目录组成完整最新版。再次验证全部目标文件、目录和启动入口；下载失败、解包越界、空间不足或校验失败时不改原安装。
3. 提示用户完全退出程序，检查安装目录中没有运行中的程序或锁定文件，然后保留旧目录备份、切换到新目录并启动。替换失败时恢复原程序文件。

检查和下载不强制结束正在运行的任务。用户目录下的配置、聊天数据和模型设置不由更新器修改。未知自建文件必须保留备份，不能按镜像规则直接删除；用户数据与程序目录混放时，需要先明确迁移边界。

通过按清单组成新程序目录，新版不再包含的旧程序文件不会继续混入目标安装，因此自动更新能够处理手动覆盖 ZIP 无法完成的删除和目录调整。

缺少组件、清单格式不支持或本地状态不能安全处理时，明确提示原因。组件下载不可用但该清单中的全量包可用时，允许下载全量包构建同一个目标版本，仍需校验并保留原安装。

## 发布完整性与版本保留

每轮预览构建先生成完整目标目录，再生成组件、清单和校验表。首次创建该 tag 时使用 Draft Release，完整核对后公开为 Prerelease，并明确不设置为正式 Latest。同版本重发直接更新原公开 Release，按照下述顺序替换内容。

预览 tag 采用 `preview-` 加正式 tag，不追加构建哈希或修订号。同 App 和 CLI 版本重发时继续使用原 tag，覆盖发布说明、清单、更新工具和整套程序包；版本变化才创建新 tag。每个 Release 只有一套 9 个附件：一个全量包、五个组件包、清单、更新工具、校验表。先上传并校验新程序 ZIP，再覆盖工具和校验表，最后切换清单；确认新附件完整后删除未被新清单引用的旧附件，避免每个组件重复出现。相同来源和构建规则的完整发布跳过打包。正式渠道后续迁入时再确定其重新构建规则。

同版本覆盖后，已经取得旧清单但尚未下载旧包的客户端可能需要重新检查更新；不为旧清单在同一 Release 继续堆积组件包。

构建跳过判断也需要纳入更新器和打包规则的变化，不能仅比较上游 App 和 CLI 版本，否则更新工具修复后可能没有可发布的新产物。

初版没有跨 Release 组件引用。保留或删除旧版时，最新版自身的附件不受影响；已开始按旧清单更新的用户仍可能需要旧版附件，因此不在发布新版本时立即删除前一版。

以后若引入跨 Release 组件复用，必须增加引用追踪和保留规则，在所有引用清单失效前不得删除对应旧组件。该优化暂不纳入首版实现。

## 实施范围和验收

发布端、组件清单和本地更新工具已在 `codex/component-updates` 实现并发布。2026-10-10 已在 Windows 完成一次真实历史版本的缓存全量升级、一次受控 CLI 落后场景的组件下载更新、文件校验、备份、零变化检查和登录界面启动；具体构建与网络范围见 [实机记录](windows-component-test-report.md)。这不代表同 tag 后续覆盖重发的附件已逐一实机复测。

main 保留预览 Action 入口和独立正式流程，组件实现与使用者 Skill 仍在预览分支。现有正式全量包和安全的手动增量包继续提供；登录后工作流程、连续多个版本及更多历史与网络场景仍待观察，再决定是否迁入主分支。

改动集中在 Windows 打包脚本、GitHub Actions、本地更新工具、README、Release 模板和对应测试。开发分支先使用非 Latest 的预发布附件和独立安装目录完成验收，再考虑正式发布。

验收至少覆盖：

- 相距多个版本的真实旧目录更新到同一个目标版本，目标程序文件和最新版全量包一致，并能真实启动。
- 没有版本记录的旧目录、缺失程序文件，以及 App 与 CLI 版本号相同但内容变化的构建。
- CLI 单独更新时只下载 CLI 和必要元数据组件；以实际下载字节统计收益。
- 文件删除、目录调整、更新脚本自身替换、中文路径和空格路径。
- 程序仍运行、下载中断、SHA256 错误、附件缺失、磁盘空间不足和替换失败时保持原安装可恢复。
- 能正常下载 GitHub 附件的网络，以及只能访问网页而无法访问附件 CDN 的网络。
- 最新版附件公开时完整，分支预发布不会改变正式 Latest。

组件更新减少的是未变化内容的重复下载。跨很老的版本或多数组件都变化时，下载量仍可能接近全量包。增加组件发布也会增加构建和上传时间，实际耗时以 Actions 运行记录为准，峰值磁盘占用尚未专门测量。
