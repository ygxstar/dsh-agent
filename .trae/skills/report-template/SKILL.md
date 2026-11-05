---
name: report-template
description: 所有子代理输出报告统一模板；主控收集结果时也按此结构汇总。
---
# 统一报告模板
所有子代理返回结果都遵守这份结构，方便主控解析、摘要、存档。

## 固定字段
- task_id
- agent_role
- status: running / done / failed / cancelled
- scope：本次处理的文件、模块、接口范围
- summary：一句话摘要（给主窗口展示）
- details：详细内容
- risks：风险、阻塞点、待人工确认项
- next：下一步建议（交给谁、是否需要复审）

## 约束
summary 必须简短，适合放在主对话；details 在用户主动要求【查看详情】时再完整展开。
不要把超长日志塞进 summary。
