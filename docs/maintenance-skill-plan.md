# 仓库维护 Skill 评估

建议增加一份仓库内 Skill，把本项目已验证的发布和 Windows 升级流程保存在代码旁边。它用于重复维护任务，不能代替构建脚本、测试或用户对外部操作的授权。先保持一份 Skill，不拆成发布、文档、测试等多套规则。

## 建议文件

- `.agents/skills/codex-desktop-maintain/SKILL.md`：触发条件、代码入口、发布约定、检查与交付要求。
- `.agents/skills/codex-desktop-maintain/references/windows-test.md`：需要实机验证时才读取的 Windows 流程。

初版复用仓库现有脚本，不新增一套打包、发布框架。只有实测中确认反复需要的步骤，才考虑增加小型辅助脚本。`AGENTS.md` 保留已有规则和授权边界，不复制整份到 Skill。

## Skill 应记录的项目知识

1. **按任务定位入口**：正式构建查看 `.github/workflows/sync.yml`；预览构建查看 `component-preview.yml`、`scripts/build-components.js`、`scripts/publish-components-preview.js`；本地更新查看 `updater/update-components.ps1`。定时、版本和参数从实际文件读取，不在 Skill 中固化当前值。
2. **正式与预览发布**：正式 tag 与包内 App/CLI 版本对应；预览 tag 是正式 tag 加 `preview-`，每个版本一个 Prerelease，清单、全量、组件、更新工具在同一版本，不创建固定入口或跳转发布。是否迁入 main 按当前用户授权决定，不由 Skill 自动扩大范围。
3. **发布完整性**：验证来源全量 ZIP 的 SHA256；程序 ZIP 使用哈希名称、不覆盖既有不同内容。先上传并核对清单引用的全部包，再切换清单。检查 Prerelease、正式 Latest、附件大小和 SHA256。代码、README、更新工具最低版本、Release 说明一起核对。
4. **验证选择**：文档修改核对差异；行为修改运行对应测试。真实 Windows 升级仅在任务授权时执行；有授权则完成实际路径，不以 CI 测试或进程创建成功代替程序可用。报告 CI 失败的原因及最终运行链接，保留真实历史。
5. **交付证据**：区分已修改、已发布、文件校验通过和实际启动成功；报告需要一次性更新工具的迁移要求、下载包大小与缓存使用情况；Mac 预下载缓存不能称为 Windows 直连大包下载成功，说明尚未覆盖的版本或网络条件。

## Windows 参考流程

- 从用户当前连接配置确认主机与交互会话，不把个人 IP、账户、密钥写进公开 Skill。
- 使用独立测试目录和独立应用配置目录；确认原安装路径及运行进程。只结束本次创建的测试进程，不强制结束用户正在工作的程序。
- 使用真实历史全量包，校验后解压并记录 App/CLI 版本。分别验证历史版本升级和组件单独落后的场景；后者要标明是受控场景，不能称作曾经发布的版本组合。
- Windows PowerShell 中文输出使用 UTF-8，短远程命令采用参数列表及 EncodedCommand，避免本机 Shell 提前展开远端变量；长脚本先以 UTF-8 BOM 文件传输，再通过 -File 执行，避免 Windows OpenSSH 入口的命令行长度限制。
- 从实际发布的 ZIP 取更新工具，验证最新预览查询、下载、解包、目标文件 SHA256、备份与目录切换。全组件都变化时允许选择全量，不能为演示省流量伪造选择结果。
- GUI 从当前交互会话启动。SSH 的 session 0 进程存在不代表用户桌面已显示窗口；记录测试程序的窗口与截图，不抓整张用户桌面。
- 新版打开后再次检查更新，确认没有重复下载。保留用户需要观察的测试安装及备份，清理本次 Mac 下载、临时任务和无用工作目录。

## 当前建议与落地边界

这份文件是评估与具体设计，尚未创建或启用 `.agents/skills` 下的 Skill。实测已发现无人值守出错仍等待回车的问题，并已补充回归检查、发布 1.1.1 修复。Windows 实测发现的问题应先在代码和测试中修复，再把已跑通的流程纳入 Skill，不能用操作说明掩盖未解决的脚本错误。

依据：OpenAI 官方维护实践建议把仓库规则放在 AGENTS.md，把具体的重复流程放在仓库 `.agents/skills/`，并保持明确的触发条件和输出范围：[Using skills to accelerate OSS maintenance](https://developers.openai.com/blog/skills-agents-sdk)。
