# 项目案例：让 Skill 升级后仍然保留个人整理结果

日期：2026-09-08 · 案例版本：0.2.1 · [PR #7](https://github.com/lingxuanqjc-alt/codex-skill-organizer/pull/7)

## 用户问题

本机的 Skill 可以来自不同目录和插件版本。用户关心的是“这个 Skill 是什么、我怎样整理过它”，而启停和隔离又必须找到准确的物理实例。插件升级不应该让一个 Skill 看起来变成了新条目，或丢失个人分类、标签和收藏。

本案例聚焦需求定义、身份模型和升级边界的取舍，依据已经合并的代码、回归测试和验收记录解释结果。

## 身份与升级的具体取舍

| 问题 | 已采用的处理 | 为什么这样选 |
| --- | --- | --- |
| 插件缓存路径包含版本号，运行时命名又可能带不同命名空间 | 扫描、运行时叠加与 SQLite 使用一致的逻辑身份；物理实例仍独立保留 | 个人整理跟随逻辑 Skill，管理动作仍能命中精确实例 |
| 旧数据库已经记录了不一致的身份元数据 | schema 6 → 7 在事务中规范化元数据，保留逻辑 ID 和关联的个人状态 | 避免要求用户清空数据库、重做整理 |
| 扫描成功，但随后数据库拒绝同步 | 回滚候选磁盘和运行时缓存，再显式报告失败 | 保留上一次可用视图，让下一次刷新有恢复机会 |
| EFS 加密备份复制到未加密健康检查目录时，文件属性跟随复制导致失败 | 读取已验证备份的内容，以新文件流写入临时数据库，保留非覆盖语义 | 健康检查验证数据库内容，不需要复制源文件的 EFS 属性 |

身份修复见 [1e6d949](https://github.com/lingxuanqjc-alt/codex-skill-organizer/commit/1e6d9490a99f5ea2a6a0b1fd869685feb4287ff5)，EFS 健康检查修复见 [039f7f4](https://github.com/lingxuanqjc-alt/codex-skill-organizer/commit/039f7f4141eceed3b54fdf7c35cffa74808d83a5)。这两个提交构成 PR #7 的证据入口。

## 用什么证明结果

- **身份稳定：** 两个插件缓存版本应合并为一个逻辑 Skill，同时保留两个实例；用户的个人状态必须保持。对应 [inventory-service 测试](../tests/inventory-service.test.ts) 与 [scanner 测试](../tests/scanner-classifier.test.ts)。
- **迁移可用：** 升级已有 schema 6 数据库后，逻辑 ID、外键和个人状态不能丢失。对应 [SQLite 迁移测试](../tests/v2-sqlite.test.ts)。
- **失败可恢复：** 数据库同步被拒绝后，重试不应一直使用失败的候选缓存。对应 inventory-service 的回归场景。
- **健康检查边界：** 发布脚手架检查 EFS 内容复制约定；Windows 安装与桌面实际表现须有各自证据，静态检查不能代替物理机安装。当前结果及未覆盖项见 [验收记录](ACCEPTANCE.md)。

## 展示与限制

[合成示例说明](media/README.md) 提供真实工作台的隔离演示。界面由实际扫描器、SQLite 和 HTTP 服务驱动，数据为人工构造的 12 个逻辑 Skill / 13 个物理实例；不连接本机 Codex，也不代表真实用户数或使用规模。

项目已提供 [0.2.1 Windows 发布物](https://github.com/lingxuanqjc-alt/codex-skill-organizer/releases/tag/v0.2.1)。本案例没有验证付费、留存、生产用户规模或招聘效果；安装器签名、设备策略与真实桌面验收仍按验收记录分别说明。
