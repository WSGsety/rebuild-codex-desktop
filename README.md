# rebuild-codex-desktop

把 Codex Desktop App 重新打包成 Windows x64 免安装 7z。

这个仓库做的是 **Codex Desktop App**，不是单独的 Codex CLI。新版使用 ChatGPT 桌面宿主，产物解压后运行 `ChatGPT.exe` 即可使用。

## 下载与更新

最新版本在 [GitHub Releases](https://github.com/WSGsety/rebuild-codex-desktop/releases)。每次发布提供全量 7z 和校验文件，附件命名如下：

```text
Codex-win-x64-<App版本>-cli-<CLI版本>.7z
SHA256SUMS.txt
```

首次安装和更新都使用全量 7z：使用 [7-Zip](https://www.7-zip.org/) 或兼容工具完整解压到新目录，运行 `ChatGPT.exe`（或 `启动 Codex.cmd`）即可使用。本地版本可以查看程序目录的 `build-info.json`；跳过多个版本时直接下载最新版全量包，无需按顺序补装历史版本。

`SHA256SUMS.txt` 列出该 Release 全量 7z 的校验值。包内实际桌面宿主由 Microsoft Store 包的 `AppxManifest.xml` 决定。

使用 LZMA2 标准档与固实压缩，保留全部程序文件。同一发布包的[体积和耗时对比](docs/ci-performance/sevenzip-comparison.md)显示，样本从 960.72 MiB 缩至 676.58 MiB；具体体积随版本变化。

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
6. 重新打包成同时标明 App 和 CLI 版本的全量 7z。
7. 将全量包及其 SHA256 上传到本仓库 Release。

默认每天北京时间 05:43 定时触发检查，实际启动时间受 GitHub 调度队列影响。也可以在 GitHub Actions 里手动运行 `Build Codex Desktop for Windows`。

定时/手动流程只有在对应版本的 7z 全量包及校验文件均已发布时才跳过 patch 和打包；只有旧 ZIP 的版本会重新构建 7z。App 和 CLI 版本同时展示在产物名、Release 标题和包内的 `build-info.json` 中；Windows MSIX 版本会显示在中文 Release 说明里。

PR 和 main 的代码提交会完整构建验证，但不发布；正式发布仍由 main 的定时或手动流程执行。需要重建当前已发布版本时，在手动运行 Actions 时开启 `force_build`。历史 ZIP 附件不自动删除，新流程的 `SHA256SUMS.txt` 校验当前 7z 包。

## 费用说明

如果仓库是 public，标准 GitHub-hosted Actions 通常免费。

如果仓库是 private，会消耗 GitHub Actions 免费额度；没有新版本时会跳过打包。

不想消耗太多额度，可以改成只手动触发、进一步降低检查频率，或者把仓库改成 public。

## 本地构建

需要：

- Node.js 24
- 7-Zip

构建时，7-Zip 需要以 `7zz` 命令出现在 PATH 中。脚本回归测试执行 `npm test`。

命令：

```bash
npm ci --prefix scripts --ignore-scripts
node scripts/sync-upstream.js --force --skip-mac
node scripts/patch-all.js win
npm run build:win-x64
```

产物在：

```text
out/Codex-win-x64-<App版本>-cli-<CLI版本>.7z
```

## 注意事项

这是非官方重打包，不是 OpenAI 官方发布的免安装包。

它仍然依赖 Microsoft Store 的下载接口，只是让 GitHub Actions 去下载和重打包，不需要你在自己的 Windows 机器上打开 Microsoft Store。

当前只构建 Windows x64，不构建 macOS、Linux 或 Windows arm64。

## 来源

重打包流程基于 [Haleclipse/CodexDesktop-Rebuild](https://github.com/Haleclipse/CodexDesktop-Rebuild) 整理，并收窄为 Windows x64 Desktop App 构建。

OpenAI Codex 原始项目：[openai/codex](https://github.com/openai/codex)
