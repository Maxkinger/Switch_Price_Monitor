# Switch Price Monitor 文档中心

状态：设计进行中  
最后更新：2026-07-16

本目录按产品、架构与决策分类维护。每个需求或设计部分经确认后，应同步更新相应文档，并在需求追踪表中记录状态。

| 文档 | 用途 | 状态 |
| --- | --- | --- |
| [产品需求说明](requirements/PRD.md) | 范围、功能需求、业务规则和验收基准 | 持续更新 |
| [需求追踪表](requirements/traceability.md) | 已确认需求与设计/实现的映射 | 持续更新 |
| [系统架构说明](architecture/system-design.md) | 已确认架构、组件职责与核心数据流 | 持续更新 |
| [数据模型](architecture/data-model.md) | 业务实体、关系、保留策略与敏感数据边界 | 已确认部分 |
| [API 设计](architecture/api-design.md) | 前后端接口边界和访问控制原则 | 已确认部分 |
| [质量与验收策略](quality/quality-and-acceptance.md) | 可靠性、安全、测试和发布验收规则 | 已确认部分 |
| [MVP 实施计划](superpowers/plans/2026-07-16-switch-price-monitor-mvp.md) | 8 个可独立验收任务的实施顺序、测试与提交点 | 已完成，待执行 |
| [ADR-001：部署架构](decisions/ADR-001-cloudflare-workers-d1.md) | 采用 Cloudflare Workers Static Assets 与 D1 的决策 | 已确认 |

## 变更规则

1. 需求确认后，先更新 `PRD.md` 和 `traceability.md`。
2. 架构、数据流或接口确认后，更新 `system-design.md`；重大技术取舍另建 ADR。
3. 实现开始前，基于已批准设计创建实施计划和验收用例。
4. 设计尚未整体完成前，本文档均为“已确认部分”的累积记录，而非最终交付规格。
