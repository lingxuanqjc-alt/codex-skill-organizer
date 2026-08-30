---
name: skill-organizer
description: 浏览、分类、整理或安全管理本机 Codex Skills；在用户提到 Skill Organizer、待整理项、标签、更新证据、启停或隔离计划时使用。所有外部变更都受桌面管理模式和精确实例边界约束。
---

# Skill Organizer for Codex

通过本插件的 MCP 工具处理 Organizer 清单。原生 Skills 页面不会被修改；宿主不支持会话内 UI 时，使用分页文本结果并引导用户打开桌面工作台。

## 路由

- 浏览工作台或能力摘要：`open_skill_organizer`。
- 搜索、筛选、比较逻辑 skill 或展开物理实例：`list_skills`。
- 用户明确修改分类、标签、收藏或锁定：`apply_classification`。
- 生成智能分类建议：必须先用 `list_classification_candidates` 读取最小化候选，再调用 `submit_classification_suggestions`；后者只写建议暂存区。
- 用户主动检查公开来源更新：`check_skill_updates`。只返回精确证据和比较链接，不下载远端 skill 正文。
- 诊断扫描根、协议、解析错误或能力缺失：`diagnose_skill_organizer`。
- 启停具体实例：`set_skill_enabled`。普通实例可直接处理；系统或插件等敏感实例只返回桌面确认引导。
- 隔离前影响分析：`prepare_skill_quarantine`。实际移动必须回到工作台确认。
- 恢复隔离项：`restore_quarantined_skill` 只返回桌面确认引导；实际恢复必须在工作台完成，并在路径冲突时停止。

## 身份与写入边界

始终使用最新 inventory revision、opaque logical skill ID、instance ID 或 installation unit ID。名称和 description 只能帮助生成候选，不能用于合并、启停、更新或移动。同名不同来源保持分离。

MCP 不能开启管理模式。管理模式关闭、协议不兼容、revision 过期、根未授权、目标处于 Git 工作树、边界不明确或前置状态变化时，拒绝外部写入并说明用户应在工作台完成什么操作。系统 skill 永久只读；其他插件的卸载只引导到 Codex 插件管理器。

## 智能整理

仅在用户明确要求时判断分类。`list_classification_candidates` 是唯一允许的模型输入入口；只使用它返回的名称、description、来源和已有 category，并只提交该工具 `allowedCategoryIds` 中的分类。该入口会排除锁定项；不得通过其他工具读取或推断锁定项的模型分类。建议必须包含理由和置信度；低于 `0.8`、冲突或非法结果留在待整理。用户在工作台确认后才成为最终分类。

## 隐私

不请求或展示 skill 正文、assets、模板、`.env`、密钥或未脱敏诊断。联网更新检查必须由用户触发；没有遥测、云同步或外部 API key。
