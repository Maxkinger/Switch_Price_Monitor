# Switch Price Monitor 文档中心

状态：开发进行中
最后更新：2026-07-18

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
| [设置驱动的地区补全设计规格](superpowers/specs/2026-07-17-settings-driven-region-completion-design.md) | 设置决定跨区范围、自动安全匹配、显式跳过与既有订阅地区补全 | 已实施；生产环境已验证入口与只读解析，最终写入由管理员逐区确认 |
| [设置驱动的地区补全实施计划](superpowers/plans/2026-07-17-settings-driven-region-completion.md) | 服务端地区范围、新建覆盖校验、已有订阅补全、页面和生产验收步骤 | 已完成，验收记录见质量与验收策略 |
| [多地区任天堂官方搜索与自动监控设计规格](superpowers/specs/2026-07-18-multi-region-official-search-design.md) | 五区官方搜索、自动加入监控、候选选择与官方链接兜底 | 已实施；本地质量门禁与生产只读验收均已通过，最终写入仍只由管理员触发 |
| [多地区任天堂官方搜索与自动监控实施计划](superpowers/plans/2026-07-18-multi-region-official-search.md) | 五区搜索适配器、自动/人工确认边界、前端三态与受控生产验收 | 已完成，待提交验收文档 |
| [认证入口实施计划](superpowers/plans/2026-07-17-authentication-entry.md) | 首次设置、恢复码确认自动登录、登录、密码恢复、认证失效回退与暖色响应式表单 | 已完成 |
| [公开偏好设置页设计规格](superpowers/specs/2026-07-17-public-settings-page-design.md) | 已登录管理员的公开偏好边界、三组表单、一次保存与秘密配置延期原则 | 已实施 |
| [公开偏好设置页实施计划](superpowers/plans/2026-07-17-public-settings-page.md) | 同源设置客户端、`/settings` 路由、响应式页面、文档追踪与质量门禁 | 已完成 |
| [立即手动刷新设计规格](superpowers/specs/2026-07-17-immediate-manual-refresh-design.md) | 手动采集立即执行、15 分钟冷却与六小时 Cron 独立运行边界 | 已实现，生产美区样本验收已通过 |
| [仪表盘与订阅详情设计规格](superpowers/specs/2026-07-17-dashboard-subscription-detail-design.md) | 概览优先仪表盘、单页订阅详情、趋势与安全编辑边界 | 已确认，待实施 |
| [订阅硬删除与全局请求加载设计规格](superpowers/specs/2026-07-18-subscription-hard-delete-global-loading-design.md) | 仪表盘多选永久删除、详情删除返回及全局网络加载动画 | 已确认，待实施 |
| [订阅硬删除与全局请求加载实施计划](superpowers/plans/2026-07-18-subscription-hard-delete-global-loading.md) | 请求计数器、批量原子删除、仪表盘/详情入口与最终质量验收 | 已批准，待执行 |
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
