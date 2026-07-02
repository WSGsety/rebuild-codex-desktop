# rebuild-codex-desktop

把 OpenAI Codex 官方 release 里的 Windows CLI 二进制重新打包成免安装 zip。

这个仓库不逆向 Microsoft Store 里的 Codex 桌面 App，也不重新编译 Codex。它只从 [openai/codex](https://github.com/openai/codex) 的公开 release 资产中提取 `codex.exe` 和配套文件，生成可解压即用的包。

## 产物

生成文件类似：

```text
dist/codex-portable-windows-amd64-0.142.5.zip
```

zip 解压后：

```text
codex-portable-windows-amd64-0.142.5/
  bin/codex.exe
  codex-path/rg.exe
  codex-resources/*.exe
  run-codex.cmd
  VERSION.txt
  README.txt
```

在 Windows 上双击 `run-codex.cmd`，或在目录里运行：

```powershell
.\bin\codex.exe
```

## 本地打包

```bash
python3 scripts/package_codex.py --output dist
```

默认打包 `win_amd64`。如果要打包 ARM64：

```bash
python3 scripts/package_codex.py --arch arm64 --output dist
```

## 自动发布

`.github/workflows/package.yml` 每 6 小时检查一次 `openai/codex` 最新 release。

如果你的仓库里还没有对应 release，它会：

1. 下载上游 Windows wheel
2. 校验上游 sha256
3. 生成 portable zip
4. 创建 `codex-portable-<上游tag>` release
5. 上传 zip 和 sha256 文件

手动触发也可以在 GitHub Actions 里运行 `Package Codex portable`。

