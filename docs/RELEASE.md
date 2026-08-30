# 0.2.x 发布手册

本手册适用于 Windows 10/11 x64 熟人测试快照。发布物未签名，不提交 OpenAI 公开插件目录。SmartScreen 的信誉提示可由测试者在核验哈希后自行判断；若 Windows App Control/企业 Code Integrity 策略强制阻止未签名可执行文件，则不得绕过，必须改用受该设备策略信任的签名构建或由设备管理员放行。

## 单一版本与运行时来源

- 产品版本只在 `package.json` 维护；构建会要求插件 manifest 与之完全一致。
- 固定 Node runtime 只在 `scripts/release/runtime-lock.json` 维护。该文件同时锁定官方 URL、下载包 SHA-256、`node.exe` SHA-256 和 Node `LICENSE` SHA-256。
- 版本 payload 只携带经过哈希验证的 `runtime/node.exe` 与 `runtime/LICENSE`，不携带构建工具 npm/corepack 或系统 `PATH` 内容。
- 插件源、入口 skill、MCP 配置、安装器和前端 bundle 都从本仓库构建，不允许从个人插件缓存复制发布物。

## 首次准备本地工具链

需要 Node.js 24（仅用于构建）、`global.json` 锁定的 .NET SDK（当前为 10.0.301，用于构建目标为 .NET 8 的桌面程序）和 Inno Setup 6。发布物自己的 Node runtime 不从系统 `PATH` 获取。

下面的命令只下载 runtime lock 指定的官方 Node ZIP，并在解压前验证哈希：

```powershell
$runtimeLock = Get-Content -LiteralPath .\scripts\release\runtime-lock.json -Raw | ConvertFrom-Json
$toolchainDirectory = Join-Path $PWD 'artifacts\toolchain'
New-Item -ItemType Directory -Path $toolchainDirectory -Force | Out-Null
$runtimeArchive = Join-Path $toolchainDirectory $runtimeLock.archiveName
Invoke-WebRequest -Uri $runtimeLock.url -OutFile $runtimeArchive
$actualRuntimeHash = (Get-FileHash -LiteralPath $runtimeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualRuntimeHash -ne $runtimeLock.archiveSha256) { throw 'Pinned Node archive checksum mismatch.' }
Expand-Archive -LiteralPath $runtimeArchive -DestinationPath $toolchainDirectory
```

Inno Setup 可安装在标准目录，也可把已验证的便携编译器放在 `artifacts/toolchain/inno-setup-<version>/ISCC.exe`。该工具链目录被 Git 忽略，不进入源代码提交。

## 本地发布门禁

在干净 checkout 中运行：

```powershell
npm ci
npm run check
pwsh -NoProfile -File .\scripts\release\Test-ReleaseScaffold.ps1
npm run build:release
```

无参数入口会依次：

1. 从 `package.json` 读取版本并验证插件版本、MIT/lx 元数据和插件结构；
2. self-contained 发布 x64 桌面壳；
3. 验证固定 Node runtime 的版本和文件哈希；
4. 运行项目检查并组装版本隔离 payload；
5. 生成 portable ZIP、Inno Setup 当前用户安装器、CycloneDX 1.6 SBOM、第三方许可证清单和内容清单；
6. 要求安装器不超过 150 MB；
7. 验证发布资产集合、每个 SHA-256、SBOM 中的准确 Node runtime，以及 portable ZIP 解压后的内部文件清单。

如果工具链位于其他受控路径，可显式传入参数：

```powershell
pwsh -NoProfile -File .\scripts\release\Build-Release.ps1 `
  -NodeRuntimeDirectory 'D:\verified-toolchains\node-v<locked-version>-win-x64' `
  -IsccPath 'D:\verified-toolchains\inno\ISCC.exe'
```

显式路径不会跳过 runtime lock、版本或资产验证。`-SkipInstaller` 只用于调查 portable 构建，不构成可发布快照；`-SkipProjectCheck` 只供已经在同一 job 中完成 `npm ci && npm run check` 的 CI 使用。

## 输出资产契约

`artifacts/release/<version>` 必须只包含：

- `SkillOrganizerForCodex-<version>-win-x64-setup.exe`
- `SkillOrganizerForCodex-<version>-win-x64-portable.zip`
- `SHA256SUMS.txt`
- `skill-organizer-for-codex.cdx.json`
- `THIRD_PARTY_NOTICES.txt`
- `RELEASE-METADATA.json`
- `CONTENT-MANIFEST-version-<version>.json`
- `CONTENT-MANIFEST-version-full-<version>.json`
- `CONTENT-MANIFEST-portable-<version>.json`

`SHA256SUMS.txt` 覆盖除自身外的每个下载资产且不得含重复或路径穿越条目。安装后版本目录必须与 `CONTENT-MANIFEST-version-<version>.json` 一致；portable 解压目录必须与 portable manifest 一致。

本机构建和 GitHub Actions 的外层安装器可能因 Inno Setup 时间元数据而具有不同哈希。可复现性对照使用三个内容清单、固定 runtime 哈希、生产 bundle 哈希、SBOM 组件和插件 manifest，不把安装器外层时间戳误当成内部差异。

## GitHub Actions 与 tag

- `ci.yml` 验证类型、测试、生产 bundle、插件/marketplace 安全契约、依赖审计和桌面 x64 publish。
- `release.yml` 在干净 Windows runner 下载并校验 runtime lock 指定的 Node ZIP，构建安装器和 portable 包，执行真实安装/健康检查/普通卸载保留/彻底删除，以及 portable 冒烟。
- 手动 `workflow_dispatch` 只是发布 dry-run：它覆盖 `build-and-smoke` 并上传保留 30 天的 Actions artifact，但会跳过 tag 祖先检查、固定发布说明和 publish job，不创建 GitHub Release。
- 推送 tag 前，最终 tag 提交必须同时取得普通 CI 与手动完整 dry-run 成功；对应 SHA 和证据应记录在 `docs/ACCEPTANCE.md` 或发布检查记录中。
- tag 必须是 `v<package.json version>`。tag job 中任何不一致都会在创建 GitHub Release 前失败。
- 推送 tag 前必须重新确认仓库仍启用 Immutable Releases。发布工作流先下载并复验 Actions artifact，再创建 draft 并上传全部资产；再次确认远端 tag 后才发布。发布后再确认 Release 显示为 immutable 并核验 release attestation。Immutable GitHub Release 只在发布后锁定 tag 与资产，不能用手动 Actions artifact 的 digest 或保留策略代替。参见 [GitHub 官方说明](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)。
- 创建草稿后、开始发布前的失败会清理不完整草稿；一旦发布调用已经开始，工作流不再自动删除 Release。此后若命令结果或发布后复核不明确，必须保留现场并人工核验，避免删除不可变 Release 后永久占用同名 tag。

发布前人工确认：README 已说明非 OpenAI 官方、未签名 SmartScreen 风险、普通卸载保留数据、0.1.1 JSON 不迁移；`CHANGELOG.md` 日期与 tag 一致；测试记录没有把未执行项写成通过。

## 安装与卸载验收边界

- 桌面工作台固定选中，插件仅在检测到 Codex 时默认选中，用户仍可取消；
- 安装位置为 `%LOCALAPPDATA%\Programs\SkillOrganizerForCodex`，无需管理员；
- 正常文件复制开始前必须从安装包临时提取同一版本 payload，完成 SQLite 备份和版本级 `--health-check`；失败时安装器以非零退出且不得留下程序、快捷方式或卸载注册；
- post-install 激活失败时必须恢复旧 launcher、`current.json`、同版本 payload、卸载文件/注册表和快捷方式，并以非零自定义退出码结束；
- 插件 helper 只替换带 Organizer 所有权标记的目录，冲突 marketplace 条目和未托管目录必须保持原样；
- 普通卸载保留 `%LOCALAPPDATA%\SkillOrganizerForCodex`，明确 `/PURGEDATA` 才删除；
- `%LOCALAPPDATA%\CodexSkillOrganizer\state.v1.json` 不属于 0.2 安装/卸载范围。
