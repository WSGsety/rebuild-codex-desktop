# rebuild-codex-desktop

把 Codex Desktop App 重新打包成 Windows x64 免安装 zip。

这个仓库做的是 **Codex Desktop App**，不是单独的 Codex CLI。新版使用 ChatGPT 桌面宿主，产物解压后运行 `ChatGPT.exe` 即可使用。

## 下载与更新

最新版本在 [GitHub Releases](https://github.com/WSGsety/rebuild-codex-desktop/releases)。每次发布保留全量包，可以安全覆盖上一版时额外提供增量包，附件命名如下：

```text
Codex-win-x64-<App版本>-cli-<CLI版本>.zip
Codex-win-x64-<新App版本>-cli-<新CLI版本>-update-from-<旧App版本>-cli-<旧CLI版本>.zip
SHA256SUMS.txt
```

以对应 Release 的实际附件为准：历史版本不会自动补发增量包，附件中没有 `update-from` ZIP 时，请下载全量包。

| 使用情况 | 下载哪个包 | 如何使用 |
| --- | --- | --- |
| 首次安装、本地版本不匹配，或本次没有增量附件 | 全量 ZIP | 解压到新目录，运行 `ChatGPT.exe` |
| 本地 App 和 CLI 版本都与增量包标明的旧版一致 | `update-from` 增量 ZIP | 完全退出程序（包括后台进程），解压到原程序目录，选择替换全部文件，再重新启动 |

增量包解压目标是原来包含 `ChatGPT.exe` 的目录，保留 ZIP 内部目录结构即可，不需要更新脚本。包内实际桌面宿主由 Microsoft Store 包的 `AppxManifest.xml` 决定。

增量仅适用于文件名和 Release 说明中标明的旧版，App 和 CLI 版本都必须匹配；本地版本可以查看程序目录的 `build-info.json`。正式渠道跳过多个版本且没有匹配增量时，下载最新版全量包并解压到新目录；无需依次安装历史增量。组件预览渠道则由更新器按文件哈希跨版本更新。

`SHA256SUMS.txt` 列出该 Release 实际提供的 ZIP 校验值；提供增量时会同时列出全量和增量包。

增量包含新增或内容变化的完整文件，沿用全量包的目录结构。构建时会校验上一版全量包的 SHA256，并实际解压覆盖增量，确认文件和目录与新版全量包一致。如果新版删除文件/目录或改变文件类型，手动覆盖无法清理旧内容，本次仅发布全量包，并在 Release 说明原因。`app.asar` 和大型 EXE 变化时仍会整体包含，增量大小取决于实际变化。

## 组件更新预览版

组件更新在 `codex/component-updates` 分支试用，正式发布仍保留上述全量和手动增量方式。

预览版与正式版一样按 App/CLI 版本保留，tag 在正式版前加 `preview-`，例如 `preview-v26.1007.21434-cli-0.162.1`。同版本重发继续使用原 tag，覆盖发布说明、清单、更新工具和整套程序包，清理旧附件；版本变化才创建新 tag。每个 Prerelease 只有一套附件：一个全量 ZIP、runtime/app/cli/tools/meta 各一个组件 ZIP、`update.json`、`updater-preview.zip` 和校验表，共 9 个附件。在 [GitHub Releases](https://github.com/WSGsety/rebuild-codex-desktop/releases) 直接打开对应预览版本，不再发布固定入口或跳转页。

- 已有本仓库 Windows x64 便携版：把 `updater-preview.zip` 解压到包含 `ChatGPT.exe` 的程序目录，双击 `检查预览更新.cmd`。
- 新安装：从最新 `preview-` 版本直接下载 `Codex-components-preview-win-x64-...zip`，解压到独立目录。
- 只检查不更新：在程序目录运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\update-components.ps1 -CheckOnly`。
- 需要显式代理时，在上述 PowerShell 命令后加 `-Proxy http://127.0.0.1:7897`，端口换成自己的 HTTP 代理端口；脚本不修改系统代理或 TUN 配置。

更新器 1.1.x 使用 `api.github.com` 查询所有分页中的已公开 `preview-` 版本，按发布时间选择带清单的最新预览，忽略正式版和草稿，再从 GitHub 附件下载清单。需要能访问 GitHub API 及附件 CDN；查询失败时不改原程序。之前下载过固定入口版工具的用户，请从最新 `preview-` 版本重新下载一次 `updater-preview.zip`。

更新器比较目标文件的 SHA256，下载内容变化或缺失的组件，可以从本仓库旧版直接组成当前预览版，无需依次安装历史增量。组件下载量接近全量或组件不可下载时使用同一版本的全量包。下载和暂存目录校验完成后，需要完全退出程序才能切换；不会强制结束进程。

原目录保留为旁边的 `.backup-...` 目录，其中的未知自建文件也保留在备份中，不会自动复制到新程序目录。用户配置目录不由更新器修改。已下载并校验的包保存在旁边的 `.component-cache`，可重试复用；更新记录是 `.last-update.json`。确认新版可用后，可自行清理备份和缓存。

预览 Action 为 [Publish component updater preview](https://github.com/WSGsety/rebuild-codex-desktop/actions/workflows/component-preview.yml)：支持手动运行；main 的正式构建成功后检查最新正式包，来源或打包规则变化时发布或覆盖对应预览，同内容则跳过。main 中的预览 Action 只负责入口，始终从预览分支读取实现。预览标记为 Prerelease，不设置为正式 Latest。

已完成一次 Windows 历史版本升级和组件更新实测，具体构建、网络条件与范围见 [实机记录](docs/windows-component-test-report.md)；登录后任务和连续版本稳定性仍待观察，之后再决定是否迁入主分支。详细流程见 [组件更新方案](docs/component-update-design.md)。

## 用 Skill 安装和更新

提供面向使用者的 [codex-desktop-update Skill](.agents/skills/codex-desktop-update/SKILL.md)，覆盖首次安装、已有普通全量版和已有组件版，帮助选择全量、匹配的增量或组件更新，并校验下载。首次安装默认正式版，已有组件版默认保持组件渠道；用户可以明确指定切换。它不构建或发布程序。

将整个 `.agents/skills/codex-desktop-update` 目录（包括 `references`）复制到本机 Codex 的技能目录。Windows 默认位置为 `%USERPROFILE%\.codex\skills\codex-desktop-update`；如果自定义了 `CODEX_HOME`，则放到其 `skills` 下。重新开始一个会话后，可以这样请求：

```text
$codex-desktop-update 帮我安装最新正式版，先确认安装位置。
$codex-desktop-update 把 D:\software\Codex-Desktop 升级到最新正式版，优先使用适用的增量包。
$codex-desktop-update 更新我现有的组件版，保持当前渠道。
```

示例路径换成自己的程序目录。普通全量版不满足增量基线时会改用最新全量包；组件版即使版本号相同，也会按清单哈希检查内容是否变化。也可以明确指定“组件预览版”；只想查询时说“检查更新，不安装”。执行需要访问 Windows 文件和运行命令，远程协助则需要用户提供可用连接。

## 工作方式

自动流程在：

```text
.github/workflows/sync.yml
```

它会：

1. 检查 Codex Desktop 当前版本。
2. 从 Microsoft Store 下载 Windows x64 MSIX 包。
3. 解包 Electron 应用。
4. Patch `app.asar`。
5. 用所选版本的官方 `@openai/codex` Windows x64 程序包替换 `codex.exe` 和三个 Windows 配套程序。
6. 重新打包成同时标明 App 和 CLI 版本的全量 ZIP。
7. 下载上一版正式 Release 的全量包，生成并验证可以手动覆盖的增量 ZIP。
8. 将全量包、可用的增量包及两者的 SHA256 上传到本仓库 Release。

默认每天北京时间 05:43 定时触发检查，实际启动时间受 GitHub 调度队列影响。也可以在 GitHub Actions 里手动运行 `Build Codex Desktop for Windows`。

如果对应的 App 和内置 Codex CLI 版本组合已经发布，workflow 会跳过 patch 和打包。App 和 CLI 版本同时展示在产物名、Release 标题和包内的 `build-info.json` 中；Windows MSIX 版本会显示在中文 Release 说明里。

提交新流程不会立刻重打包，也不会自动为已有 Release 补发增量。需要重建当前已发布版本时，在手动运行 Actions 时开启 `force_build`。

## 费用说明

如果仓库是 public，标准 GitHub-hosted Actions 通常免费。

如果仓库是 private，会消耗 GitHub Actions 免费额度。生成增量还需要下载上一版全量包并比较文件，运行时间取决于下载和压缩速度；没有新版本时会跳过打包。

不想消耗太多额度，可以改成只手动触发、进一步降低检查频率，或者把仓库改成 public。

## 本地构建

需要：

- Node.js 24
- 7-Zip

运行打包测试时，7-Zip 需要以 `7zz` 命令出现在 PATH 中，执行 `npm test`。

命令：

```bash
npm ci
node scripts/sync-upstream.js --force --skip-mac
node scripts/patch-all.js win
npm run build:win-x64
```

产物在：

```text
out/Codex-win-x64-<App版本>-cli-<CLI版本>.zip
```

## 注意事项

这是非官方重打包，不是 OpenAI 官方发布的免安装包。

它仍然依赖 Microsoft Store 的下载接口，只是让 GitHub Actions 去下载和重打包，不需要你在自己的 Windows 机器上打开 Microsoft Store。

当前只构建 Windows x64，不构建 macOS、Linux 或 Windows arm64。

## 来源

重打包流程基于 [Haleclipse/CodexDesktop-Rebuild](https://github.com/Haleclipse/CodexDesktop-Rebuild) 整理，并收窄为 Windows x64 Desktop App 构建。

OpenAI Codex 原始项目：[openai/codex](https://github.com/openai/codex)
