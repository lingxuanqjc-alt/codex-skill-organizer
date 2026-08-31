# Skill Organizer for Codex

Skill Organizer for Codex 是一个本地优先的 Windows 工作台，用来对每台电脑上不同的 Codex skill 清单进行**分类、整理和安全管理**。它会在启动时全量扫描，并对后续文件变化做去抖增量重扫，也可手工强制重扫；不要求其他人的目录和作者的电脑一致，也不会把第三方 `SKILL.md` 改写成某种专有格式。

> 本项目是独立的社区项目，不是 OpenAI 官方产品，也不代表 OpenAI。

## 适用环境

- Windows 10（1809 或更高）/ Windows 11，x64；
- 当前用户免管理员安装；
- 桌面工作台是必装组件，Codex 会话插件是可选组件；
- 安装包自带固定的 Node.js 24 运行时，不读取系统 `PATH` 中的 Node；
- WebView2 缺失时回退到默认浏览器。

用户可见名称是 **Skill Organizer for Codex**。仓库名、插件 ID 和 MCP 命名空间继续使用 `codex-skill-organizer`，以保持插件身份稳定。

## 三项核心能力

### 分类

- 以逻辑 skill 为单位聚合不同目录或插件缓存版本，同名但身份不确定的项保持分离；
- 提供 11 个稳定的内置分类、双语显示、个人分类、标签、收藏、锁定和保存视图；
- 使用确定性规则自动分类；分类、标签、收藏、锁定或恢复自动分类等个人操作会冻结当时的自动分类，后续规则包升级只重算从未触达的项；
- Codex 中的智能整理只生成“建议暂存区”，由用户预览后确认。

### 整理

- 自动发现 Codex Home、Agents skills 和插件缓存，也可添加本机或同步盘目录；额外根默认只读，必须按根单独授权管理，网络共享与根外链接不受支持；
- 支持搜索、来源/scope/状态筛选、项目选择、重复实例展开和最多 100 项的批量编辑；
- 扫描限于 frontmatter 和必要来源元数据，不读取 assets、正文、模板、`.env` 或密钥；父级 Git 来源只接受根目录范围内、非链接的精确 GitHub remote，名称或 description 不能冒充来源。

### 管理

- 外部管理动作默认关闭；必须由用户在桌面工作台打开“管理模式”，Codex 工具不能自行开启；
- 启停只通过 Codex 官方 app-server 命中精确实例；
- 更新检查只在用户主动请求时访问已验证的公开 GitHub 来源和官方 curated Codex marketplace；只有精确 commit、tag、release 或可复现安装哈希才形成证据，草稿/占位/版本漂移的锁文件会显示“无法检查”；0.2.0 不执行覆盖更新；
- 隔离前必须确认安装单元并预览影响。Git 工作树、超过 1 GB、含链接、越界或边界不明的目录会被阻止；恢复从不覆盖冲突路径，桌面用户可以取消或选择同一父目录下的新路径，实际恢复路径会写入审计记录。
- MCP 可启停普通运行时实例；系统或插件等敏感实例，以及隔离恢复，必须打开桌面工作台由用户确认，MCP 参数不能代替该确认。
- 运行时启停和隔离批次在首个失败处停止，并分别报告成功、失败和未执行目标；分类和建议确认使用 SQLite 原子事务，不会留下半批分类结果。

## Codex 会话插件

- 宿主声明 MCP Apps UI 能力时，插件提供自包含的 `ui://codex-skill-organizer/workbench.html` 资源，由宿主决定是否显示；不支持 UI 的宿主仍可使用分页 `list_skills` 与桌面工作台入口。
- 当前项目目录来自官方 MCP roots，按 sidecar 会话隔离；每次工具请求续租，正常退出立即清理，异常会话在 TTL 后清理，不会把一个任务的 repo-scope 根泄漏给另一个任务。
- 桌面壳、sidecar 与服务都声明 `protocolVersion` 和兼容范围；不兼容时拒绝写入并提示重启，不会自动终止 Codex 或旧任务。
- 插件只提供独立工作台资源和工具，不修改 Codex 原生 Skills 页面。`restore_quarantined_skill` 只返回桌面恢复引导，实际文件移动仍需桌面确认。

## 安装与升级

从对应 GitHub Release 下载。只有 `v<version>` tag 触发的工作流会创建正式 Release；手动运行 `workflow_dispatch` 生成的 Actions artifact 只保留 30 天，用于发布演练，不是 GitHub Release 资产，也不作为正式分发入口。

- `SkillOrganizerForCodex-<version>-win-x64-setup.exe`：当前用户安装器；
- `SkillOrganizerForCodex-<version>-win-x64-portable.zip`：便携包；
- `SHA256SUMS.txt`：所有下载资产的 SHA-256；
- `skill-organizer-for-codex.cdx.json`：CycloneDX SBOM；
- `THIRD_PARTY_NOTICES.txt`：第三方许可证清单；
- `RELEASE-METADATA.json`：版本、平台与构建来源元数据；
- `CONTENT-MANIFEST-version-<version>.json`：桌面基础版本目录内容清单；
- `CONTENT-MANIFEST-version-full-<version>.json`：含可选 Codex 插件的完整版本目录内容清单；
- `CONTENT-MANIFEST-portable-<version>.json`：便携包内部内容清单。

熟人测试阶段的 0.2.x 安装包**未进行代码签名**，Windows SmartScreen 可能显示警告。先对照 `SHA256SUMS.txt` 验证哈希，再决定是否运行：

```powershell
Get-FileHash .\SkillOrganizerForCodex-0.2.1-win-x64-setup.exe -Algorithm SHA256
```

SmartScreen 提示与 Windows App Control/企业 Code Integrity 策略不是一回事。若本机策略要求发布物具有受该策略信任的 Authenticode 签名，未签名的桌面壳会被系统强制阻止；安装器会在复制程序文件前的健康预检中停止，并返回失败，不会尝试用捆绑的 Node.js 绕过组织策略。普通自签名也不保证被企业策略信任。此时需要使用由该设备策略信任的签名构建，或由设备管理员调整允许规则。

WebView2 缺失时的默认浏览器回退只适用于桌面可执行文件本身已获准运行的设备，不能绕过 App Control。

默认安装位置：

- 程序：`%LOCALAPPDATA%\Programs\SkillOrganizerForCodex`
- 数据库、快照、隔离区和日志：`%LOCALAPPDATA%\SkillOrganizerForCodex`

0.2.0 从新的 SQLite 数据库开始，**不会导入、修改或删除** 0.1.1 的 `%LOCALAPPDATA%\CodexSkillOrganizer\state.v1.json`。普通卸载保留 0.2 数据和隔离区；只有卸载器中明确勾选“彻底删除”（静默卸载为 `/PURGEDATA`）才删除新数据目录，旧 0.1.1 目录仍不在删除范围内。

插件升级后应重启 Codex，并在新任务中验证。旧任务不假设热加载；插件被占用时，桌面升级仍可完成并记录“等待重启 Codex”。

如果安装器检测到本机已有 0.1.1 插件，会单独询问是否接管；拒绝时旧插件原样保留，桌面工作台仍可安装。明确同意后，安装器先验证来源和目录结构、创建完整备份，再替换插件。自动化静默安装只有显式加入 `/ADOPTLEGACYPLUGIN` 才视为同意，不能从待处理文件推断授权。

## 隐私和安全边界

- 无遥测、广告、云同步或外部 API key；
- 本地服务只绑定动态 `127.0.0.1` 端口，并使用随机令牌、会话 TTL、Origin/CSRF 和 CSP 校验；
- 运行目录 ACL 收紧到当前用户和必要系统身份；SQLite 遇到未来 schema 或非损坏类 I/O 错误时拒绝自动恢复，避免把新数据误降级；
- 桌面窗口显示时续租共享服务，隐藏时释放桌面租约；活跃 MCP 请求会保持服务存活，全部空闲 30 分钟后才休眠，异常 MCP 会话的项目根会按 TTL 清理；
- 安装健康检查使用受约束的临时数据根，不创建或迁移正式数据库；每次认证都重新检查绝对 TTL，MCP 启动失败只返回固定的脱敏错误；
- 普通诊断隐藏用户名、绝对路径和原始 stderr；完整支持包需要用户明确确认；
- 该安全模型保护单个 Windows 用户免受误操作和非预期浏览器访问，不声称能抵御已控制同一账户的恶意软件或管理员。

更完整的边界见 [PRIVACY.md](PRIVACY.md)、[SECURITY.md](SECURITY.md)、[威胁模型](docs/THREAT_MODEL.md) 和 [安装器构建契约](installer/BUILD_CONTRACT.md)。OpenAI 的插件分发和安全要求见其[插件文档](https://developers.openai.com/plugins/build/plugins)与[安全指南](https://developers.openai.com/plugins/guides/security-privacy)。当前架构是本机文件管理工具，不提交公开插件目录。

## 本地开发

需要 Node.js 24，以及 `global.json` 固定的 .NET SDK（当前为 10.0.301，桌面程序目标框架为 .NET 8）。安装依赖并验证应用：

```powershell
npm ci
npm run check
pwsh -NoProfile -File scripts/release/Test-ReleaseScaffold.ps1
```

`npm run build:release` 是无参数的本地发布入口。它从 `package.json` 读取产品版本，自动发布 self-contained x64 桌面壳，并要求固定 Node runtime 位于：

```text
artifacts/toolchain/node-v<runtime-lock.version>-win-x64
```

运行时版本、官方下载地址和哈希的构建权威是 [scripts/release/runtime-lock.json](scripts/release/runtime-lock.json)。安装器还需要 Inno Setup 6；脚本会查找标准安装目录及 `artifacts/toolchain/inno-setup-*/ISCC.exe`。高级调用可显式传入 `-NodeRuntimeDirectory`、`-DesktopPayloadDirectory`、`-IsccPath` 或 `-OutputDirectory`，但不会绕过版本、哈希和 150 MB 安装包门禁。

```powershell
npm run build:release
```

完整发布流程、资产契约和 CI 对照方式见 [docs/RELEASE.md](docs/RELEASE.md)。已验证与尚未覆盖的项目见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

高级调试时，若 Codex CLI 不在 Codex Desktop 的版本化 `bin`、用户 `WindowsApps` 或 `Programs\\Codex` 标准目录中，可显式设置 `CSO_CODEX_CLI_PATH`。它必须是 Codex CLI 可执行文件的绝对路径，并被视为操作者对该文件的明确本机信任；发布程序不会读取普通 `CODEX_CLI_PATH`，也不会从 `PATH`/`where.exe` 搜索或执行 Codex/Git。清除该变量即可恢复标准目录解析。

## 许可证

[MIT](LICENSE) — Copyright (c) 2026 lx
