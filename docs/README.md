# Switch Price Monitor 文档中心

状态：开发进行中
最后更新：2026-07-17

本目录按产品、架构与决策分类维护。每个需求或设计部分经确认后，应同步更新相应文档，并在需求追踪表中记录状态。

项目级执行与注释规范见根目录 [AGENTS.md](../../AGENTS.md)。所有自动化开发代理在执行前必须阅读该文件；任何新增或改动的代码、测试、SQL 与配置均须配有与实现一致的中文详细注释。

| 文档 | 用途 | 状态 |
| --- | --- | --- |
| [产品需求说明](requirements/PRD.md) | 范围、功能需求、业务规则和验收基准 | 持续更新 |
| [需求追踪表](requirements/traceability.md) | 已确认需求与设计/实现的映射 | 持续更新 |
| [系统架构说明](architecture/system-design.md) | 已确认架构、组件职责与核心数据流 | 持续更新 |
| [数据模型](architecture/data-model.md) | 业务实体、关系、保留策略与敏感数据边界 | 已确认部分 |
| [API 设计](architecture/api-design.md) | 前后端接口边界和访问控制原则 | 已确认部分 |
| [质量与验收策略](quality/quality-and-acceptance.md) | 可靠性、安全、测试和发布验收规则 | 已确认部分 |
| [MVP 实施计划](superpowers/plans/2026-07-16-switch-price-monitor-mvp.md) | 8 个可独立验收任务的实施顺序、测试与提交点 | 已批准，执行中 |
| [官方价格 ID 与订阅前来源预览计划](superpowers/plans/2026-07-16-official-price-id-subscription-flow.md) | 日区官方价格接口、地区价格 ID 与创建前来源预览的后端实施步骤 | 已完成，待后续前端与其他地区适配器接续 |
| [官方订阅发现与批量确认设计](superpowers/specs/2026-07-17-official-subscription-discovery-design.md) | 官方默认区搜索、批量候选选择、跨区确认与候选卡布局 | 已确认（草图暂定） |
| [官方订阅发现与批量确认实施计划](superpowers/plans/2026-07-17-official-subscription-discovery.md) | 默认区官方检索、官方链接确认、跨区处理、原子批量订阅与候选卡界面的实施步骤 | 已完成 |
| [认证入口实施计划](superpowers/plans/2026-07-17-authentication-entry.md) | 首次设置、恢复码确认自动登录、登录、密码恢复、认证失效回退与暖色响应式表单 | 已完成 |
| [五区真实价格采集设计规格](superpowers/specs/2026-07-17-five-region-live-collection-design.md) | 五区独立官方适配器、第三方回退、真实采集执行与验收边界 | 已确认，已实施；第三方实际回退待来源许可 |
| [五区真实价格采集实施计划](superpowers/plans/2026-07-17-five-region-live-collection.md) | 官方五区采集、汇率、Cron 与未获准第三方禁用边界的测试先行实施顺序 | 已完成 |
| [解决方案设计规格](superpowers/specs/2026-07-16-switch-price-monitor-design.md) | 已确认产品设计与官方价格 ID/创建前来源预览边界 | 已确认 |
| [ADR-001：部署架构](decisions/ADR-001-cloudflare-workers-d1.md) | 采用 Cloudflare Workers Static Assets 与 D1 的决策 | 已确认 |
| [ADR-002：价格来源验证](decisions/ADR-002-price-provider-validation.md) | 来源准入、五区可行性与回退边界 | 已确认部分 |

## 变更规则

1. 需求确认后，先更新 `PRD.md` 和 `traceability.md`。
2. 架构、数据流或接口确认后，更新 `system-design.md`；重大技术取舍另建 ADR。
3. 实现开始前，基于已批准设计创建实施计划和验收用例。
4. 设计尚未整体完成前，本文档均为“已确认部分”的累积记录，而非最终交付规格。
