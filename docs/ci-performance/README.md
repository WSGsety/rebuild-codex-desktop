# GitHub Actions 提速记录（2026-11-06）

后续已按下载体积优先调整为平衡压缩参数，详见 [ZIP 体积与速度对比](zip-compression.md)。下文快速档的耗时是第一阶段历史数据，不代表调整后的发布压缩耗时。

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
- 第一阶段采用快速 Deflate，实包 4,284 个条目的路径、解压大小和 CRC 与原压缩完全一致；随后按下载体积优先改为 `Deflate -mx=5 -mfb=128`，保留完整内容，具体取舍见后续对比。
- 本地 Windows 打包在输入和成品 ZIP 内容均不变时复用结果；输入覆盖上游、补丁后 ASAR、入口清单、构建代码、依赖锁、CLI/MSIX/Node/平台版本。CI 不复用成品，仍执行完整构建。

测试本来仅 1 秒，拆成多台机器反而增加准备时间；Node 测试文件已并行。仓库没有当前 macOS job、Rust/Go 工具现编译或 Docker 构建链，未增加无关缓存或矩阵。

## 本地验证

19 项测试通过，包含原有 17 项及路径判断、重复构建失效回归。覆盖同大小/时间戳修改、版本变化、新增文件、产物损坏/缺失、缓存记录损坏。

真实上游 MSIX `26.1103.3517.0`、App `26.1103.31037`、CLI `0.167.0`：第一轮连续构建 110.719 秒 / 4.426 秒；快速压缩后为 30.750 秒 / 4.424 秒；最后一版本地复测为 33.715 秒 / 4.844 秒（CLI 下载缓存命中）。独立快速 ZIP 压缩 15.364 秒。Mac 本地只能检查 Windows PE/哈希/内容，Windows 可执行文件的 `--version`、`app-server --help` 由真实 Windows Actions 执行。

actionlint 1.7.12 的预编译二进制及 SHA256 已验证。该版本尚不认识 GitHub 新增的 `queue` 属性，只排除这个特定诊断，其余检查通过；GitHub 已接受并成功执行含此属性的工作流。

## 线上复测

所有完整验证运行均保留 Windows PE/哈希检查、CLI `--version` 和 `app-server --help`、7 组补丁及成品 SHA256。测试分支不发布或覆盖正式 Release。

| 样本 | 总耗时 | Windows job | Windows ZIP 步骤 | 状态 |
| --- | ---: | ---: | ---: | --- |
| 修改前 17 次完整发布中位数 | 450 秒 | 446 秒 | 120 秒 | 成功 |
| 同一批历史运行扣除各自发布步骤后中位数 | 414 秒 | — | — | 仅用于缩小口径差异 |
| 第一轮冷缓存 [42241276792](https://github.com/WSGsety/rebuild-codex-desktop/actions/runs/42241276792) | 252 秒 | 222 秒 | 140 秒 | 成功 |
| 第二轮热缓存 [42241842037](https://github.com/WSGsety/rebuild-codex-desktop/actions/runs/42241842037) | 163 秒 | 140 秒 | 56 秒 | 成功 |
| 第二轮 PR 冷 MSIX 缓存 [42241925848](https://github.com/WSGsety/rebuild-codex-desktop/actions/runs/42241925848) | 159 秒 | 133 秒 | 54 秒 | 成功 |
| 缓存进一步收敛 [42242655010](https://github.com/WSGsety/rebuild-codex-desktop/actions/runs/42242655010) | 212 秒 | 138 秒 | 58 秒 | 成功；含 53 秒等待旧运行取消 |
| 纯文档 PR [42242997368](https://github.com/WSGsety/rebuild-codex-desktop/actions/runs/42242997368) | 16 秒 | 跳过 | 跳过 | CI 成功 |

近似可比的历史基线 414 秒到第二轮 163 秒，减少约 60.6%；不能把原始 450 秒直接与未发布运行相比宣称纯提速 63.8%。优化前后的上游版本不同，GitHub 主机和网络也不固定，样本仍不足以承诺每次都达到此数字。同一上游版本的两轮 ZIP 步骤 140 → 56 秒（减少 60%）证据更直接。

同 PR 连续推送的旧运行 [42242367066](https://github.com/WSGsety/rebuild-codex-desktop/actions/runs/42242367066) 已自动取消，新运行继续成功。取消不是瞬时完成：该次新 run 到 preflight 创建前等待了 53 秒，已计入总耗时，不能只报告 job 的 runner 排队时间。main 的每次运行分组由配置保证，未为测试直接往 main 连续推送。

[复测逐 job 数据](after-jobs.csv)、[复测逐步骤数据](after-steps.csv) 中 `wait_before_job_s` 是 workflow 创建到 job 创建的时间，包含依赖等待和并发取消等待；后续 job 该值不能累加作为整体排队。

缓存进一步收敛后，Windows npm 缓存样本为 75,281 字节（先前 182,241,805 字节）；MSIX 单份为 1,056,154,258 字节，旧格式最新单份为 4,079,554,215 字节，缩小约 74.1%。热 MSIX 的恢复 12 秒 + 同步 29 秒，冷下载同步 36 秒 + 保存 6 秒，当前样本总成本接近，因此没有扩大缓存范围，也没有缓存解压文件。保留压缩包缓存用于重复构建及 CDN 波动时复用。

关闭并清理了仅用于验证的文档 PR/分支；最终改动通过主优化 PR 交付。

## 缓存复查与配置依据

第二轮发现 `npm pack` 把预编译 CLI 加入了 setup-node 的 npm 缓存，Windows 缓存膨胀至 182,241,805 字节，两轮 CLI 准备仍各约 9 秒。因此将该下载放入本轮临时缓存，让依赖缓存只保留 17 个工具包。已清理两个不再需要的旧 MSIX 缓存，共 4,969,892,599 字节；当前 main 仍在使用的最新旧格式缓存暂时保留，避免影响未合并前的定时任务。

配置依据：[GitHub 并发及 queue](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[路径跳过与 Pending 检查](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)、[setup-node 缓存说明](https://github.com/actions/setup-node)。

未改动根目录开发依赖版本。工具依赖审计仍报告 3 项 moderate（ASAR 的 glob/minimatch 传递依赖），未提供直接修复；本次未扩大为依赖升级任务。生产 Release 上传覆盖及 macOS DMG 构建不在本次分支实测范围。

一次本地冷下载对照耗时 241.669 秒，其中 npm 下载 CLI 用了 208.497 秒；第二次为 4.987 秒。发现这会拖慢后续本地改动构建后，最终仅在 CI 隔离 CLI 缓存，本地继续复用标准 npm 缓存。没有把这次网络异常样本删去或混入热缓存提速结论。
