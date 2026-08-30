# 安装前必读

> ⚠️ 此 0.2.x 熟人测试快照**未进行代码签名**。Windows SmartScreen 可能显示“Windows 已保护你的电脑”；请只从本仓库的 GitHub Release 下载，并先核对 `SHA256SUMS.txt`。

**Skill Organizer for Codex 是独立 MIT 开源项目，属于非 OpenAI 官方产品。** 安装器不会因此获得 OpenAI 的签名或背书。

下载后，请使用 PowerShell 验证安装器或便携 ZIP：

```powershell
Get-FileHash -LiteralPath .\SkillOrganizerForCodex-<version>-win-x64-setup.exe -Algorithm SHA256
Get-FileHash -LiteralPath .\SkillOrganizerForCodex-<version>-win-x64-portable.zip -Algorithm SHA256
```

计算结果必须与同一 Release 中 `SHA256SUMS.txt` 的对应条目完全一致。不一致时不要运行文件，并在 GitHub Issues 报告。

本快照同时提供 CycloneDX SBOM、第三方许可证清单、发布元数据和内部内容清单，方便核验所携带的运行时与文件内容。
