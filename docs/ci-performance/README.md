# GitHub Actions 提速记录（2026-11-06）

## 采样口径

通过 `gh run list --limit 50` 获取修改前最近 50 次运行，再用 `gh api repos/WSGsety/rebuild-codex-desktop/actions/runs/<id>/jobs?per_page=100` 获取全部 50 个 job 的步骤时间。

- [逐 job 数据](before-jobs.csv)：排队 = job created_at 到 started_at；执行 = 测试、版本判断、补丁、打包、校验、发布的步骤耗时；准备 = job 总耗时减执行，包含 runner 初始化、检出、工具/依赖、下载解包、缓存和收尾。三个数字相加等于该 job 从创建到完成的时间。
- [逐步骤数据](before-steps.csv)：保留失败和 skipped 状态，避免把未运行当成快速成功。`test_s` 单独列出纯测试时间，不把 ZIP 压缩冒充测试。
- cron 计划时刻到 workflow 真正创建的延迟不在 Jobs API 中，未计入排队。样本包含不同代码/上游版本，不能视作严格同机 A/B。
- 其中 36 次为仍在使用的 Windows 工作流，14 次是已删除的组件预览工作流；后者只列账，不混入当前完整构建的前后对比。

## 修改前瓶颈

17 次成功完整构建的 workflow 中位数为 450 秒，job 中位数 446 秒；其中准备中位数 273 秒、执行中位数 198 秒，纯脚本测试仅 1 秒（各列中位数不能相加）。15 次成功跳过构建的 workflow 中位数为 72 秒。

逐步骤中位数：依赖安装 29 秒，MSIX 恢复 47.5 秒，MSIX 保存 97 秒，ZIP 构建 120 秒。原缓存恢复整个 `codex-sync`，随后又清空解压目录，新缓存还带上旧 MSIX，缓存持续膨胀。开始时 4 个缓存合计 9,134,011,952 字节。

## 已实施

- PR 自动取消同 PR 的旧运行；main push 使用 run_id 独立分组，每个代码提交完整打包验证。main 定时/手动发版串行，`queue: max` 保留等待队列。
- 文档路径在 job 内判断，跳过依赖、测试、探测和 Windows 构建。workflow 本身始终创建，`CI` 汇总检查验证所有必要 job，文档 PR 也正常成功，不使用会使 required check 永久 Pending 的 workflow 级 `paths-ignore`。
- 本次查询 main 没有 branch protection 或 ruleset。若以后设置必需检查，应选择最终的 `CI`，不要只要求 preflight。
- 通用测试、版本探测迁到 Ubuntu；Windows 保留真实打包和 CLI 执行验证。preflight 向 Windows 传递是否构建及版本，依赖关系有实际数据和测试门禁意义。
- CI 只安装打包依赖：722 个包缩到 17 个，版本沿用原锁文件的直接依赖；`setup-node` 原生 npm 缓存使用独立锁文件。根目录完整开发依赖不变，应用原生模块继续来自上游。
- 仅缓存当前 MSIX 压缩包，精确键匹配，无跨版本恢复、不缓存解压目录。下载版本与探测版本不一致就失败，避免错误缓存键。
- 用现有 ASAR 库直接打包，删除 `npx` 子进程；强制构建不重复查询 Release，CLI 版本在一次运行中固定。
- 快速 Deflate 不删文件、不降低功能检查，实包 4,284 个条目的路径、解压大小和 CRC 与原压缩完全一致，两份 ZIP 均通过 `7zz t`；代价是 ZIP 增大约 4.9%。
- 本地 Windows 打包在输入和成品 ZIP 内容均不变时复用结果；输入覆盖上游、补丁后 ASAR、入口清单、构建代码、依赖锁、CLI/MSIX/Node/平台版本。CI 不复用成品，仍执行完整构建。

测试本来仅 1 秒，拆成多台机器反而增加准备时间；Node 测试文件已并行。仓库没有当前 macOS job、Rust/Go 工具现编译或 Docker 构建链，未增加无关缓存或矩阵。

## 本地验证

19 项测试通过，包含原有 17 项及路径判断、重复构建失效回归。覆盖同大小/时间戳修改、版本变化、新增文件、产物损坏/缺失、缓存记录损坏。

真实上游 MSIX `26.1103.3517.0`、App `26.1103.31037`、CLI `0.167.0`：第一轮连续构建 110.719 秒 / 4.426 秒；快速压缩后的最终代码为 30.750 秒 / 4.424 秒。独立快速 ZIP 压缩 15.364 秒。Mac 本地只能检查 Windows PE/哈希/内容，Windows 可执行文件的 `--version`、`app-server --help` 由真实 Windows Actions 执行。

actionlint 1.7.12 的预编译二进制及 SHA256 已验证。该版本尚不认识 GitHub 新增的 `queue` 属性，只排除这个特定诊断，其余检查通过；GitHub 已接受并成功执行含此属性的工作流。

## 线上复测

第一轮：[42241276792](https://github.com/WSGsety/rebuild-codex-desktop/actions/runs/42241276792) 成功，Windows 依赖安装 4 秒，MSIX 保存 6 秒。第二轮正在验证快速压缩和缓存命中，最终数字在完成后补齐。测试分支不发布或覆盖正式 Release。

## 缓存复查与配置依据

第二轮发现 `npm pack` 把预编译 CLI 加入了 setup-node 的 npm 缓存，Windows 缓存膨胀至 182,241,805 字节，两轮 CLI 准备仍各约 9 秒。因此将该下载放入本轮临时缓存，让依赖缓存只保留 17 个工具包。已清理两个不再需要的旧 MSIX 缓存，共 4,969,892,599 字节；当前 main 仍在使用的最新旧格式缓存暂时保留，避免影响未合并前的定时任务。

配置依据：[GitHub 并发及 queue](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[路径跳过与 Pending 检查](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)、[setup-node 缓存说明](https://github.com/actions/setup-node)。

未改动根目录开发依赖版本。工具依赖审计仍报告 3 项 moderate（ASAR 的 glob/minimatch 传递依赖），未提供直接修复；本次未扩大为依赖升级任务。生产 Release 上传覆盖及 macOS DMG 构建不在本次分支实测范围。
