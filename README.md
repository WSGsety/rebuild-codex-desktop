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

增量仅适用于文件名和 Release 说明中标明的旧版，App 和 CLI 版本都必须匹配；本地版本可以查看程序目录的 `build-info.json`。正式渠道跳过多个版本且没有匹配增量时，下载最新版全量包并解压到新目录，无需依次安装历史增量。

`SHA256SUMS.txt` 列出该 Release 实际提供的 ZIP 校验值；提供增量时会同时列出全量和增量包。

增量包含新增或内容变化的完整文件，沿用全量包的目录结构。构建时会校验上一版全量包的 SHA256，并实际解压覆盖增量，确认文件和目录与新版全量包一致。如果新版删除文件/目录或改变文件类型，手动覆盖无法清理旧内容，本次仅发布全量包，并在 Release 说明原因。`app.asar` 和大型 EXE 变化时仍会整体包含，增量大小取决于实际变化。

## 组件预览与安装更新 Skill

组件更新实现仍在 `codex/component-updates` 分支，正式发布继续采用上述全量和匹配增量方式。首次使用、已有普通全量版和已有组件版的安装更新流程见 [使用者 Skill](https://github.com/WSGsety/rebuild-codex-desktop/tree/codex/component-updates/.agents/skills/codex-desktop-update)，安装及调用方法见 [预览分支 README](https://github.com/WSGsety/rebuild-codex-desktop/blob/codex/component-updates/README.md#用-skill-安装和更新)。

组件预览每个版本保留一套附件，同版本覆盖原 tag，已有组件用户保持原渠道并按文件哈希更新。程序直接启动 `ChatGPT.exe`；`检查预览更新.cmd` 仅负责更新。测试范围见 [Windows 实机记录](https://github.com/WSGsety/rebuild-codex-desktop/blob/codex/component-updates/docs/windows-component-test-report.md)。

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
