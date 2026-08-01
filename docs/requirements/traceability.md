# 需求追踪表

最后更新：2026-08-01

状态区分“仓库实现”“M1 本地生产验收”和“外部验收”。历史 Cloudflare 生产证据不等于当前 Node/PostgreSQL 工作树的 M1、Docker Hub 或 NAS 证据。

| ID | 需求主题 | 当前状态 | 主要证据 |
| --- | --- | --- | --- |
| FR-001 | 多商品订阅、默认区、五区发现、人工修正与补全 | 仓库已实现；Node 本地 Playwright 取代 Browser Binding，真实 NAS 样本待验收 | [PRD](PRD.md)、[API](../architecture/api-design.md)、[ADR-002](../decisions/ADR-002-price-provider-validation.md) |
| FR-002 | 官方优先、第三方准入、货币与税费 | 官方五区链路已实现；第三方无许可时不创建提供方、不发请求；真实 Node/NAS 样本待验收 | [PRD](PRD.md)、[ADR-002](../decisions/ADR-002-price-provider-validation.md) |
| FR-003 | 六小时采集、历史保留、手动刷新 | 已实现：UTC 六小时任务 + PG advisory lock；每个认证刷新请求同步执行，无冷却/队列，仅记最近时间 | [系统设计](../architecture/system-design.md)、[数据模型](../architecture/data-model.md)、[API](../architecture/api-design.md) |
| FR-004 | 官方降价与目标价提醒 | 规则、PostgreSQL 状态与事件预留已实现；真实 Telegram 演练待执行 | [PRD](PRD.md)、[系统设计](../architecture/system-design.md) |
| FR-005 | 日报与 Telegram | 中文模板、分页、pending/delivered 和 UTC 分钟调度已实现；只接受成对环境变量，设置页不存秘密；真实投递待验收 | [PRD](PRD.md)、[系统设计](../architecture/system-design.md) |
| FR-006 | 单管理员初始化、登录、锁定与恢复码 | 已实现；Cookie 为 `HttpOnly; SameSite=Strict`，`Secure` 由部署配置决定；NAS 初始化待验收 | [API](../architecture/api-design.md)、[数据模型](../architecture/data-model.md) |
| FR-007 | 导航、仪表盘、地区/价格格式与版本 | 已实现当前页面；版本改为正式 Git 标签构建，不再自动修改 package 版本；NAS 页面待验收 | [PRD](PRD.md)、[Docker Hub 发布](../deployment/docker-hub-release.md) |
| FR-008 | 管理员 CSV 导出 | 已实现订阅、价格历史和采集日志三类白名单导出 | [API](../architecture/api-design.md)、[数据模型](../architecture/data-model.md) |
| FR-009 | 连续失败与恢复通知 | PostgreSQL 健康状态、唯一事件和分钟投递已实现；真实来源失败/恢复与 Telegram 待验收 | [数据模型](../architecture/data-model.md)、[系统设计](../architecture/system-design.md) |
| FR-010 | 永久删除与全局加载 | PostgreSQL 显式事务实现并由回滚测试覆盖；历史 Worker/D1 生产删除只作为历史证据 | [API](../architecture/api-design.md)、[质量](../quality/quality-and-acceptance.md) |
| FR-011 | 页面发布版本 | 页面读取已提交的 `package.json`；自动补丁部署已移除。标签发布严格 `vX.Y.Z`，但发布前仍须人工审查 package/lockfile 与标签一致 | [PRD](PRD.md)、[Docker Hub 发布](../deployment/docker-hub-release.md) |
| NFR-001 | Node、PostgreSQL、Compose、本地调试与多架构 | 仓库实现完成；本地 69/420、DOM 16、Chromium 4、Docker/平台 19/19、tsc/build 通过；M1/arm64 生产镜像/Compose 运行时、认证持久性、端口隔离和镜像内 Chromium 已验收，业务 fake/fixture 由自动化分层证明 | [ADR-003](../decisions/ADR-003-nas-docker-postgresql.md)、[迁移规格](../superpowers/specs/2026-07-27-nas-docker-postgresql-migration-design.md) |
| NFR-002 | GitHub Actions 与公开 Docker Hub | 普通/标签工作流已实现；run `30686052256` 仅证明平台移除前提交；Secrets、`v0.1.0` 与公开镜像待完成 | [Docker Hub 发布](../deployment/docker-hub-release.md)、[质量](../quality/quality-and-acceptance.md) |
| NFR-003 | NAS 备份、恢复与回滚 | 脚本与本地隔离合同已实现；DS423+ 独立空库恢复和版本回滚演练待执行 | [备份恢复](../deployment/postgres-backup-restore.md)、[群晖部署](../deployment/synology-ds423-plus.md) |
| ADR-001 | Cloudflare Workers + D1 | 历史决策，已被 ADR-003 取代；线上资源未删除，待独立退役授权 | [ADR-001](../decisions/ADR-001-cloudflare-workers-d1.md) |
| ADR-003 | NAS Docker + PostgreSQL + 本地 Playwright | 已采纳；仓库实现、M1 生产运行时 Compose 与业务自动化分层证据已完成，公开发布、DS423+ 和 Cloudflare 退役仍待验收/授权 | [ADR-003](../decisions/ADR-003-nas-docker-postgresql.md) |

## 当前阻断上线的外部事项

1. 配置最小权限 Docker Hub Secrets，另行确认并创建严格版本标签。
2. 验证公开 manifest 同时包含 `linux/arm64` 与 `linux/amd64`。
3. 在 DS423+ 以空项目目录初始化，验证登录、持久性、备份恢复、升级和回滚。
4. 受控验证真实任天堂样本与 Telegram；不得记录凭据或响应正文。
5. 取得对精确 Cloudflare 资源的独立授权后再停止和删除；仓库迁移本身不构成授权。
