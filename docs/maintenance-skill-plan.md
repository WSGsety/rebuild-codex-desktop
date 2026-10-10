# 仓库维护 Skill 的历史评估

这是一份早期方案记录，不是当前实施计划。最初考虑为开发者增加 `codex-desktop-maintain`，后来用户明确要求的是让使用者安装和更新程序包，实际交付已改为 [codex-desktop-update](../.agents/skills/codex-desktop-update/SKILL.md)。没有创建或启用维护仓库的 Skill。

## 当前交付

- 使用者 Skill 覆盖首次安装、已有普通全量版和已有组件版；按本地状态选择全量、匹配增量或组件更新，保留已有安装渠道。
- 安装和调用方法见 [README](../README.md#用-skill-安装和更新)，Windows 操作见 [参考流程](../.agents/skills/codex-desktop-update/references/windows.md)。
- 打包和发布规则见 [组件方案](component-update-design.md)，实际验证范围见 [Windows 实机记录](windows-component-test-report.md)。

## 当时的维护方案

原设想是把发布、文件校验、备份和实机验证整理为一份开发者 Skill，复用仓库脚本，并把 Windows 细节放到按需读取的参考文件中。这些操作要求现在由现有脚本、测试和上述文档描述；不能把这份历史评估当成已经启用的自动维护流程。

后续如需开发者维护 Skill，再按明确任务决定其范围，不扩展现有使用者 Skill 的安装职责。用户此前授权的预览发布和实机测试，也不因为存在 Skill 而变为永久、无条件的外部操作权限。
