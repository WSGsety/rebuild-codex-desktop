# Windows 安装与更新操作

读取本文件前先按 SKILL.md 确定渠道、目标 Release 和包。路径由用户的实际安装决定，下面的 `$installDir`、`$zipPath`、`$stageDir`、`$checksumsPath` 都代表已经确定的实际值，不能直接当作未赋值的命令执行。

## 查看本地版本与校验下载

```powershell
$info = Get-Content -LiteralPath (Join-Path $installDir 'build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$info | Select-Object appVersion, codexCliVersion, entryExecutable
Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
```

从 `$checksumsPath` 中查找与 ZIP 文件名精确相同的行，再比较其 SHA256，缺行也视为失败。优先使用 Release API 返回的附件下载地址；有 `digest` 时可同时核对。跟随 GitHub 的附件 CDN 重定向是正常现象，不能把网页 HTML 或错误响应当作 ZIP。

无需认证的公开 API 可以用 Windows PowerShell 的 `Invoke-RestMethod`；下载可用 `Invoke-WebRequest -UseBasicParsing -OutFile`。使用 TLS 1.2 和可识别的 User-Agent。若 `gh` 已安装并可用，也可用它查询 Release 和下载附件，不为一次更新安装整套开发工具。

## 正式全量包

1. 首次安装时，使用用户指定的独立程序目录；如果未指定，询问位置。现有安装升级时，先准备一个与原目录分开的暂存目录，检查剩余空间足够放下下载、暂存和备份。
2. 校验 ZIP 后检查归档路径，再用系统解压工具展开，例如 `Expand-Archive -LiteralPath $zipPath -DestinationPath $stageDir`。目标应是空目录；不要解压到共享的 `software`、`Downloads` 或 Store 根目录。
3. 检查暂存目录的 `build-info.json`、实际入口和 CLI，确认 App/CLI 与本次 Release 相符。全量替换不把旧程序文件混进新版。
4. 用户已要求替换原路径时，完全退出该路径下程序后，将原目录改名为唯一备份，再将暂存目录移至原路径；第二步失败时把备份恢复。否则保留旧目录，在新目录启动。旧目录中的自建文件也必须保留，是否迁移到新版按用户需要处理。

## 正式增量包

1. 精确核对文件名 `update-from` 部分和本地 `build-info.json` 的两个旧版本，不匹配立即改用全量方案。没有 `build-info.json` 的历史安装也用全量。
2. 完全退出该安装的应用后，把原程序目录完整复制到暂存目录，包含隐藏文件；原目录留作回退。增量是变化文件的完整内容，允许手动覆盖，不能处理任意旧版，也不提供删除旧文件的能力。
3. 校验 ZIP、检查归档路径，将增量解压到暂存目录，保持内部目录结构并覆盖，例如 `Expand-Archive -LiteralPath $zipPath -DestinationPath $stageDir -Force`。
4. 核对覆盖后的 App/CLI、入口和 CLI 实际版本，再按全量方案的备份与目录切换步骤完成更新。不要先毁掉原目录，再发现增量不适用。

## 组件预览更新

用户明确选择预览时使用此流程。组件包由发布清单和更新器选择，不要求用户逐个手动挑包。

- 首次安装：使用该预览 `update.json` 指向的全量 ZIP，核对校验表、清单大小及哈希，按全量流程解压到独立目录。
- 已有便携版：下载同一预览的 `updater-preview.zip`，校验后把其中 `检查预览更新.cmd` 和 `update-components.ps1` 放入实际程序目录。旧工具可能不支持新清单的最低版本，应先更新工具。
- 从安装目录之外调用下面的命令，避免父进程工作目录占用原目录：

```powershell
# 只检查，不替换程序
& (Join-Path $installDir '检查预览更新.cmd') -CheckOnly

# 用户已要求更新且程序已退出时执行
& (Join-Path $installDir '检查预览更新.cmd') -AcceptUpdate -NoLaunch
```

CMD 返回 0 只证明独立更新进程已启动。更新器会把自身复制到安装目录旁边的临时目录，再由独立 PowerShell 执行；等待实际完成，核对输出、目标文件和 `<安装目录>.last-update.json`，不要直接在原程序目录调用内部 `-RequestPath` 模式。没有变化时不会产生新的成功报告，不能把旧报告当作本次完成。

更新器会比较文件 SHA256，校验下载、解包和完整目标，再备份并切换。所有组件都变化且体积接近全量时选择全量是正常结果；组件网络失败可尝试同一清单的全量包，完整性失败不能降级绕过校验。

如果显式指定 `-ManifestUrl`，地址必须是本仓库具体预览 tag 的 `update.json`，记录未验证默认版本发现这一边界；指定 `-Proxy` 仅使用用户提供或已验证的 HTTP 代理，不修改系统设置。GitHub API 与附件 CDN 是不同请求，单个小请求成功不代表大包下载通畅。

## 启动、失败处理与清理

```powershell
& (Join-Path $installDir 'resources\codex.exe') --version
Start-Process -FilePath (Join-Path $installDir '启动 Codex.cmd')
```

入口以包内信息为准；旧包也可能使用 `Codex.exe`。若从 SSH 远程运行，session 0 的 GUI 进程不是用户桌面窗口。只使用可用的交互会话打开，并验证该程序窗口；拿不到窗口证据时报告“文件更新已验证，桌面启动未验证”。

下载失败、无效目录、磁盘不足或校验失败时停止替换，保留当前安装和可用备份。无人值守模式应失败退出，不等待回车；检查真实工作进程，不把引导进程的退出码当成更新结果。

远程 PowerShell 中文脚本使用 UTF-8；长脚本以 UTF-8 BOM 文件传输再通过 `-File` 运行，避免 SSH 命令行长度限制。连接信息从当前用户环境获取，不将个人 IP、账户、密钥或令牌写入记录。只有必要时才使用临时中转，标明下载发生的机器与网络条件。

完成后保留用户需要的安装和备份，清理本次临时任务、暂存失败文件、连接及下载副本。组件缓存和备份不能未经判断全部删除；本次通过 Mac 下载中转的 ZIP 在完成后清理。
