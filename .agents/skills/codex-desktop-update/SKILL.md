---
name: codex-desktop-update
description: 帮助用户从 WSGsety/rebuild-codex-desktop 的 GitHub Releases 下载、安装和更新 Windows x64 Codex Desktop 便携版，判断全量包、匹配版本的增量包或用户指定的组件预览更新。适用于安装最新版、检查更新和升级现有程序，不用于修改源码、构建或发布 Release，也不用于升级单独的 Codex CLI。
---

# 安装与更新 Codex Desktop

面向使用便携版的用户。应用是 Codex Desktop，新版桌面宿主名为 `ChatGPT.exe`；不要把任务转换成安装 npm Codex CLI。仅支持本仓库 Windows x64 便携程序，不覆盖 Microsoft Store 安装目录。

## 先确定更新对象

- 从用户提供的位置或已知安装路径读取 `build-info.json`，记录 `appVersion`、`codexCliVersion`、`entryExecutable`。无法确定程序目录时先询问，不扫描或改动其他软件。
- 默认使用正式 Latest。只有用户明确要求组件更新或预览版时才选择 Prerelease，不静默改变渠道。用户只要求检查时，只查询和报告，不安装。
- 在 Windows 上执行安装；从 Mac/Linux 协助时，使用已有、获准的 Windows 连接。没有连接就交付适合用户机器的步骤，不声称已经安装。
- 全量和增量的执行方法见 [Windows 操作](references/windows.md)。按实际环境使用 PowerShell 和系统解压工具；`gh` 可选，不要求用户安装 Node.js、Git 或构建工具。

## 获取并选择包

仓库固定为 `WSGsety/rebuild-codex-desktop`，发布页是 https://github.com/WSGsety/rebuild-codex-desktop/releases 。使用实际公开附件，不拼接或猜测某个版本一定有增量包。

正式版查询 `https://api.github.com/repos/WSGsety/rebuild-codex-desktop/releases/latest`，确认不是草稿或 Prerelease。记录返回的 tag，整轮操作从该 Release 获取包和 `SHA256SUMS.txt`。

| 本地情况 | 选择 |
| --- | --- |
| 首次安装、缺少版本信息、没有匹配增量，或跨版本跳跃 | 最新正式全量 ZIP，先解压到独立目录 |
| 当前 App/CLI 均与最新 Release 的增量基线一致 | 该增量 ZIP，先备份并准备覆盖后的完整目录 |
| App/CLI 均已相同，只要求普通更新 | 报告版本已一致；同版本重新安装需用户确有重装意图，不能仅据版本号宣称文件完整 |
| 用户明确选择组件预览更新 | 使用最新公开 `preview-` Release 的更新工具；已有便携版可按文件哈希跨版本更新 |

正式包命名：

```text
Codex-win-x64-<App>-cli-<CLI>.zip
Codex-win-x64-<新App>-cli-<新CLI>-update-from-<旧App>-cli-<旧CLI>.zip
```

增量要求两个旧版本都精确匹配，只用于它标明的基线，不能当作任意旧版到最新版的补丁；不默认下载并串联多个历史增量。新版可能因删除文件或改变目录类型而只提供全量包。

预览查询 Release 列表的全部分页，选已公开、非草稿、带有效 `update.json` 的 `preview-` 版本，按 `published_at` 选择最新。每个预览只有一套附件：全量 ZIP、五个组件 ZIP、`update.json`、`updater-preview.zip`、`SHA256SUMS.txt`。同 App/CLI 版本可能覆盖原 tag 的内容，不能只凭 tag 或包名复用未校验的旧下载。

## 下载与替换

1. 下载到本次临时目录；按同一 Release 的校验表核对每个所用 ZIP 的 SHA256。预览还要核对清单引用的文件名、URL、大小和哈希；下载地址应来自本仓库 Release。校验失败不解包、不覆盖安装目录。
2. 用临时目录准备完整目标，检查解包路径越界和链接，不把全量包直接混入旧目录。覆盖前让用户退出该安装目录下的程序及其后台进程，不按 `ChatGPT.exe` 名称强杀所有进程。
3. 替换时保留原目录备份；复制增量基线时包括隐藏文件。保留用户自建文件及配置，预览更新器把未知自建文件留在备份中，不会自动复制到新版。不要清理账户目录或改变系统代理、TUN。
4. 替换失败时恢复原程序；网络或校验失败时保留当前可用安装并说明具体失败环节。同 tag 内容重发造成清单/包不一致时，重新获取该 Release 的清单与校验表后至多重试一次，不绕过哈希校验。

## 验证与交付

- 核对新目录的 App/CLI 版本和入口文件；运行 `resources\codex.exe --version`，再通过 `启动 Codex.cmd` 或包内真实入口打开桌面应用。
- 以实际可见窗口判断启动结果。仅有下载成功、进程存在或启动命令返回 0，不足以声称应用已正常打开；没有图形界面证据时明确这一项未验证。不自动登录账户或发送任务。
- 组件更新后再检查一次，确认需要的组件为零。记录实际选中的组件、是否使用全量、下载/缓存情况和备份位置，不把 Mac 预下载缓存称为 Windows 直连下载。
- 清理本次临时下载、脚本或连接；用户仍需观察的安装、备份和有效缓存按其要求保留。若使用 Mac 中转，完成后清理 Mac 下载副本。
- 最后告知渠道与 tag、前后 App/CLI 版本、实际使用的包、安装及备份位置、启动结果和未完成项。包不可访问时提供对应发布页，不能报告已经更新。
