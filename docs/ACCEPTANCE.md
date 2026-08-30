# Skill Organizer for Codex 0.2.0 验收记录

验收基准日期：2026-08-30

本文件区分“已在当前工作区验证”和“仍需 GitHub Actions/物理机验证”。未执行的场景不会写成通过。

## 已实现的发布边界

- 配置的目标仓库身份为 `lingxuanqjc-alt/codex-skill-organizer`，MIT License，`Copyright (c) 2026 lx`；用户可见名称为 Skill Organizer for Codex，并明确标注非 OpenAI 官方产品。只有公开 remote 创建并核验后，才把本项改写为已发布仓库事实。
- 首发目标为 Windows 10/11 x64、当前用户免管理员安装。桌面工作台固定必装，Codex 插件可选；固定 Node.js 24 runtime 随版本 payload 携带。
- 程序使用版本目录和稳定 launcher；激活前执行健康检查。程序数据位于 `%LOCALAPPDATA%\SkillOrganizerForCodex`。
- 0.2.0 从空 SQLite 数据库开始。旧 `%LOCALAPPDATA%\CodexSkillOrganizer\state.v1.json` 保留、不读取、不迁移，也不在彻底卸载范围内。
- 普通卸载保留 SQLite、快照、隔离区和日志；彻底删除必须显式勾选或使用 `/PURGEDATA`。
- 插件 helper 合并个人 marketplace 而不覆盖无关条目；只允许替换或移除带 Organizer 所有权标记的插件目录。
- 无遥测、云同步或外部 API key。更新联网仅由用户主动触发；0.2.0 只检查证据，不执行覆盖更新。

## 当前工作区已验证

- [x] `package.json`、插件 manifest、marketplace 和发布版本均为 `0.2.0`。
- [x] 插件 display name、MIT/lx、仓库 URL、MCP 入口和原创图标通过结构门禁。
- [x] 固定 Node runtime lock 使用官方 `nodejs.org` URL，并同时锁定 ZIP、`node.exe` 和许可证哈希。
- [x] release scaffold 覆盖 marketplace 无关条目保留、幂等升级备份、冲突来源拒绝、未托管插件目录拒绝和内容清单对照。
- [x] Inno Setup 源声明 `PrivilegesRequired=lowest`、x64、Windows 10 最低版本、固定 workbench 组件、可选插件、普通卸载保留与显式彻底删除。
- [x] 无参数 `npm run build:release` 与脚本参数契约一致；版本从 `package.json` 获取，runtime 从 lock 获取。
- [x] 发布输出门禁要求精确资产集合、完整 SHA-256、CycloneDX 中准确的 Node runtime、portable 内部文件一致，以及安装器不超过 150 MB。
- [x] 当前陌生清单分类质量 fixture 覆盖率和人工修正率门禁由自动化测试执行；Vibe-Trading bundle 有独立断言。
- [x] `npm run check`：版本契约、仓库秘密扫描、插件/marketplace 精确发布 allowlist、TypeScript 类型检查、197 项单元/集成测试和生产 bundle 全部通过。
- [x] Playwright 工作台验收 7/7：三块界面、锁定边界、拖拽、诊断确认、MCP 只读边界、5,000 项虚拟列表，以及跨批标签失败后的成功/失败/未执行报告。
- [x] .NET 桌面壳以 Release/win-x64 构建通过，0 警告、0 错误；这只证明编译，不代替物理 WebView2/托盘验收。
- [x] 生产依赖 `npm audit --omit=dev --audit-level=high` 为 0 个漏洞；`dotnet list ... --vulnerable --include-transitive` 未发现 NuGet 易受攻击包。
- [x] MCP 真实构建产物通过 UI-capable 与 text-only 两条 stdio 契约：资源 URI/MIME/CSP/内嵌 bundle 一致，无 UI 能力时保留分页工具和诚实桌面降级。
- [x] 扫描器拒绝伪造 GitHub host 与越界 `.git` junction；SQLite 拒绝未来 schema 降级和非损坏 I/O 自动恢复；并发快照、WAL 恢复及十份轮换有自动化覆盖。
- [x] 共享服务租约覆盖桌面隐藏、MCP 活跃、迟到 continuation 和异常会话 TTL；隐藏窗口不会杀死仍被 MCP 使用的服务。
- [x] 更新证据对非官方 marketplace、草稿/占位/漂移锁文件、私有/模糊来源和本地修改项失败关闭；每次主动检查强制刷新。
- [x] 隔离/恢复自动化覆盖 EXDEV 校验、回滚、父路径替换、指纹漂移、批量停止和显式同父目录恢复选择，且从不覆盖冲突路径。
- [x] release scaffold、插件事务 helper 与安装器静态/fixture 门禁通过；实际干净系统安装/升级/卸载矩阵仍归远程 Actions 验收，不在此项中冒充通过。
- [x] 本地 `build:release` 生成并复验精确 9 项资产；安装器 75,973,008 bytes，低于 150 MB 门禁。便携 ZIP、SBOM、第三方许可证、三个内部 manifest、release metadata 和 SHA-256 全部存在且契约通过。
- [x] 两份 workflow YAML 可解析；14 个 Action 引用固定为官方 tag 对应的完整 SHA，4 个 checkout 全部禁用凭据持久化，只有隔离的 publish job 获得一次 `contents: write`。这证明静态供应链契约，不代替远程 runner 实际成功。

本地 release scaffold 的最近一次执行结果应与当前提交的 CI 日志一起保存；任何后续源码修改都要求重跑。

## GitHub Actions 必须通过后才能发布

- [ ] `main` 上的 CI：`npm run check`、Playwright、生产依赖审计、插件/发布门禁、.NET build/publish 和确定性桌面产物全部通过。
- [ ] 干净 Windows runner：无预装项目 Node、无 Codex 的桌面安装、健康检查、普通卸载保留和 `/PURGEDATA`。
- [ ] 已有个人 marketplace fixture：可选插件安装不得覆盖其他插件条目。
- [ ] 仅测试编译的 activation fault：干净首次安装、旧版本到新版本、同版本三种 post-copy failure 均以 70 退出并精确恢复（或保持不存在）程序目录、`current.json`、稳定 launcher、版本目录、卸载器、ARP、快捷方式、插件和 marketplace；不完整回滚必须改用 74 和不同日志。
- [ ] 静默选择矩阵：`/TYPE=desktop`、`/TYPE=full`、两种 custom `/COMPONENTS` 和 `/LOADINF` 的实际插件文件/marketplace 结果与显式选择一致，且日志证明 `InitializeWizard` 保留了调用方选择。
- [ ] 安装目录与 `CONTENT-MANIFEST-version-0.2.0.json` 一致；portable 解压目录与 portable manifest 一致。
- [ ] 安装器、portable、SBOM、第三方许可证、release metadata 和三个 manifest 均被 `SHA256SUMS.txt` 覆盖。
- [ ] tag 必须为 `v0.2.0`，并与 package/plugin/release metadata 一致。
- [ ] tag commit 属于 `main` 历史；只读构建 job 不持有 Release 写凭据，独立发布 job 只下载并重新验证前序不可变资产后创建 Release。

在远程 workflow 实际成功前，上述项目保持未勾选。

## 唯一复杂物理机实测

- [x] 早期安装器以当前用户进入预检并在约 11 秒后被 App Control 阻止；该次测试暴露并修复了 EFS 目录中 `rename` 返回 `EXDEV` 的升级结果写入问题。它不构成安装成功、WebView2 成功或无需手工干预的端到端验收。
- [x] 本机 Code Integrity Operational 日志记录 3033/3077，确认强制 App Control 策略拒绝未签名桌面 EXE；安装器现改为在复制程序文件前预检并失败关闭，不把此情况伪装成普通 SmartScreen 提示或 WebView2 回退。
- [x] 最新发布构建在本机以退出码 7 停在健康预检，已完成并验证一份 SQLite 升级备份，但未完成桌面健康检查、未进入 Inno 正常文件复制阶段。程序目录、marketplace、旧插件、旧 0.1.1 JSON、主数据库/WAL、快捷方式和卸载注册均保持不变；允许的增量只有备份与收据，瞬态 `-shm` 不作为个人状态变化。
- [ ] WebView2 独立窗口、无 WebView2 浏览器回退、托盘、单实例、重复点击激活、隐藏 30 分钟休眠。
- [ ] 复杂真实清单、真实增量监听、自定义根、项目 repo-scope skill 和多插件版本。5,000 项扫描与虚拟窗口已由自动 fixture 覆盖，不用它冒充本项物理验证。
- [ ] 插件升级被旧 Codex 任务占用时，桌面升级完成并留下等待重启状态；重启后在新任务验证工具和协议。
- [ ] 在真实跨卷文件系统与工作台交互中复核隔离/恢复；EXDEV 哈希校验、恢复冲突、Git/1 GB/链接阻断和批量部分失败已有自动化，不用自动 fixture 冒充物理交互。
- [x] 最终安装预检前后比较 17,100 个 skill 树条目，其中 244 个物理 `SKILL.md`；所有文件内容哈希、时间戳、属性、目录类型和链接类型完全一致。此次没有执行隔离或更新检查联网。

## 已知且明确接受的限制

- 熟人阶段安装器未签名，用户必须用 `SHA256SUMS.txt` 验证。SmartScreen 信誉提示与强制 App Control 策略分开说明；后者需要受设备策略信任的签名或管理员允许规则，0.2.0 不尝试绕过。
- 当前本机文件管理架构不符合公开插件目录所需的公开 HTTPS MCP 服务、域名和发布者验证，因此不提交公开目录。
- 协议自动化已验证 UI-capable 资源与 text-only 降级；真实 Codex 新任务是否渲染会话面板仍待验证，不伪称修改了原生 Skills 页或已经显示 iframe。
- 更新执行、skill 安装/发布、云同步、多用户账号和网络共享均不在 0.2.0 范围。

## 工作区保护

- 父工作区中与本仓库无关的 `disable-global-mcp.patch` 必须保持不变，且不会纳入本仓库。
- 除用户在工作台明确确认的隔离单元外，Organizer 不移动、改写或删除第三方 skill。
