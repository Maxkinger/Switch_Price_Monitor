# Switch Price Monitor 文档中心

状态：仓库迁移与无认证代理设置实现完成；外部发布与部署验收待执行

最后更新：2026-08-01

项目级执行与中文注释规范见根目录 [AGENTS.md](../AGENTS.md)。任何代码、测试、SQL、配置或文档改动前必须同时阅读该文件与本文档。

## 当前结论

- 仓库唯一支持 Node.js 22、PostgreSQL 17 与本地 Playwright Chromium；旧 Cloudflare Worker、D1、Cron、Static Assets Binding、Secrets 和 Browser Binding 运行路径已经移除。
- 本地当前门禁已通过：Vitest 69 文件/420 项、DOM 16 项、Chromium 4 项、Docker/平台合同 19/19、TypeScript 与生产构建。
- 最新成功普通 CI run `30686052256` 对应平台移除前提交，只是历史证据；当前工作树仍需自己的远程 CI。
- 当前工作树已在 M1/arm64 完成生产镜像/Compose 运行时验收：空库启动、双容器健康、非 root、端口隔离、认证/恢复/锁定、设置与重启持久化均通过；镜像内无网络 Chromium 冒烟通过，备份恢复 14/14。发现、订阅事务、历史/导出、刷新、调度锁与 Telegram fake transport 由同一工作树的 420 项自动化分层验证，不把它们误写成容器内端到端外部演练。
- Docker Hub Secrets 未配置，`v0.1.0` 未创建，公开镜像与 DS423+ 部署均未完成。
- 真实 Telegram/Nintendo 样本尚未运行；线上 Cloudflare 资源未删除，退役必须另行授权。

## 核心文档

| 文档 | 内容 | 当前状态 |
| --- | --- | --- |
| [产品需求说明](requirements/PRD.md) | 功能、业务规则、非功能要求和当前交付状态 | 需求已确认；外部验收待执行 |
| [需求追踪表](requirements/traceability.md) | 需求到实现、证据和未完成项的映射 | 已同步至 Node/PostgreSQL |
| [系统架构](architecture/system-design.md) | 两容器拓扑、数据流、认证、调度与发布边界 | 仓库实现完成 |
| [数据模型](architecture/data-model.md) | PostgreSQL 实体、事务、保留和秘密边界 | 仓库实现完成 |
| [API 设计](architecture/api-design.md) | 同源接口、认证、同步刷新与安全响应 | 仓库实现完成 |
| [质量与验收](quality/quality-and-acceptance.md) | 历史证据、当前本地门禁和外部验收条件 | 当前本地通过，外部待验收 |

## 部署与运维

| 文档 | 用途 |
| --- | --- |
| [Synology DS423+ 局域网部署](deployment/synology-ds423-plus.md) | NAS 目录、`.env`、首次初始化、日志、升级与回滚 |
| [Docker Hub 多架构发布](deployment/docker-hub-release.md) | Secrets、严格 semver、四标签、双架构与独立发布授权 |
| [PostgreSQL 备份与空库恢复](deployment/postgres-backup-restore.md) | 原子备份、14 份保留、独立空库恢复与切换边界 |

## 架构决策

| 文档 | 状态 |
| --- | --- |
| [ADR-001：Cloudflare Workers 与 D1](decisions/ADR-001-cloudflare-workers-d1.md) | 历史决策；被 ADR-003 取代，线上资源仍待独立退役授权 |
| [ADR-002：价格来源验证](decisions/ADR-002-price-provider-validation.md) | 官方优先；历史平台观察保留，当前由 Node 提供方执行 |
| [ADR-003：NAS Docker 与 PostgreSQL](decisions/ADR-003-nas-docker-postgresql.md) | 已采纳；仓库实现完成，发布与 NAS 待验收 |

## 迁移规格与计划

| 文档 | 状态 |
| --- | --- |
| [NAS Docker 与 PostgreSQL 迁移实施计划](superpowers/plans/2026-07-27-nas-docker-postgresql-migration.md) | 保留原始步骤历史；顶部摘要记录本轮实际状态 |
| [PostgreSQL 登录竞态设计](superpowers/specs/2026-07-30-postgres-login-attempt-upsert-race-design.md) | 已实现并通过真实 PostgreSQL 回归 |
| [GitHub Actions 双角色设计](superpowers/specs/2026-08-01-github-actions-postgres-dual-role-design.md) | 已实现；历史远程 CI 通过 |
| [代理迁移到 Main 设计规格](superpowers/specs/2026-08-10-proxy-main-integration-design.md) | 已实现；保留本机免认证与目标价永久删除 |

`docs/superpowers/specs/` 与 `docs/superpowers/plans/` 中其余文件保存早期功能设计、实施步骤和 Cloudflare 生产证据。它们不会被改写成当前运行合同；遇到冲突时，以本页“当前结论”、ADR-003、当前架构/部署文档和实际仓库配置为准。

## 文档变更规则

1. 需求变化先更新 PRD 与追踪表。
2. 架构、数据、接口或部署边界变化同步更新对应文档；重大取舍新增或修订 ADR。
3. 历史验收证据保留日期、提交和环境标签，不能无条件改写为“当前通过”。
4. 外部发布、NAS 写入、真实凭据测试和 Cloudflare 退役都需要与代码修改分开的明确授权。
