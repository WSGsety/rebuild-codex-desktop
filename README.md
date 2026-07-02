# rebuild-codex-desktop

把 Microsoft Store 里的 Codex Desktop App 重新打包成 Windows x64 免安装 zip。

这个仓库的目标是生成类似 `Codex-win-x64-26.x.x.zip` 的桌面版应用包：解压后运行 `Codex.exe`，不需要在本机打开 Microsoft Store 安装。

## 它做什么

1. 从 Microsoft Store 下载 Codex Desktop 的 MSIX 包。
2. 解包出 Electron 应用内容。
3. Patch `app.asar`，替换/修正运行时内容。
4. 重新打包成 Windows x64 zip。
5. 定时检查上游版本，有新版本就自动发布到本仓库 Release。

## 自动发布

GitHub Actions 每 6 小时运行一次：

```text
.github/workflows/sync.yml
```

它会创建这样的 Release：

```text
v26.x.x
  Codex-win-x64-26.x.x.zip
  SHA256SUMS.txt
```

也可以在 GitHub Actions 页面手动触发 `Build Codex Desktop for Windows`。

## 本地构建

需要 Node.js 24 和 7-Zip。

```bash
npm ci
node scripts/sync-upstream.js --force --skip-mac
node scripts/patch-all.js win
npm run build:win-x64
```

产物在：

```text
out/Codex-win-x64-<version>.zip
```

## 来源

这个仓库基于 [Haleclipse/CodexDesktop-Rebuild](https://github.com/Haleclipse/CodexDesktop-Rebuild) 的公开重打包流程整理，并收窄为 Windows Desktop App 构建。

OpenAI Codex 原始项目：[openai/codex](https://github.com/openai/codex)

