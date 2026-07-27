# ADR-003：迁移到 NAS Docker 与 PostgreSQL

| 项目 | 内容 |
| --- | --- |
| 状态 | 已确认，待实施 |
| 日期 | 2026-07-27 |
| 决策 | 以 Synology DS423+ 上的 Docker Compose 作为唯一生产环境，使用 Node.js 应用容器、项目专属 PostgreSQL 容器和本地 Playwright；通过 GitHub Actions 向 Docker Hub 发布公开多架构镜像。 |

## 背景

当前系统部署于 Cloudflare Workers，并依赖 Static Assets、D1、Cron Trigger、Secrets 与 Browser Binding。源码本身已经模块化，但生产运行时和数据层与 Cloudflare 平台直接耦合。管理员希望在本地 M1 完成开发和生产形态验收，再把版本化镜像发布到 Docker Hub，由群晖 NAS 直接拉取运行。

目标 NAS 为 Intel Celeron J4125 的 DS423+，已扩充 16 GB DDR4；本地开发设备为 Apple Silicon M1。两个环境分别需要 `linux/amd64` 与 `linux/arm64` 镜像。第一阶段只要求局域网访问，但继续保留完整账号密码认证。

## 决策

1. 生产环境使用两个常驻容器：一个 Node.js 应用容器和一个项目专属 PostgreSQL 容器。
2. 应用容器同时提供 React 静态资源、同源 API、定时任务与本地 Playwright，不引入分布式队列或独立浏览器服务。
3. PostgreSQL 不映射 NAS 端口；应用使用独立最小权限用户、参数化 SQL、显式事务和版本化迁移。
4. 日区升级包浏览器关系发现改为镜像内固定版本的 Playwright 与 Chromium，并保持现有 URL 白名单、批量上限、隔离上下文、超时和保存前复核规则。
5. 本地 M1 支持开发模式和生产 Compose 验收；GitHub Actions 对正式 Git 标签构建并发布 `linux/arm64` 与 `linux/amd64` 的 Docker Hub 公开镜像。
6. NAS 的 Compose 只引用固定镜像版本，不包含源码构建；运行时秘密只通过未提交的 `.env` 注入。
7. 不迁移现有 D1 数据，NAS 从全新数据库初始化。
8. NAS 完成功能等价、备份恢复和版本回滚验收后，停止并清理 Cloudflare 生产资源；实施完成前 ADR-001 仍描述当前生产环境。

## 考虑过的方案

### 单应用容器 + PostgreSQL

已采用。它保留清晰代码边界，同时把常驻服务控制为两个，适合单管理员 NAS 的资源、部署和备份需求。

### 拆分 Web、调度器与浏览器

未采用。该方案需要任务队列、跨容器协议和更复杂的重复执行控制，当前没有多用户或横向扩容需求。

### 模拟 Cloudflare 平台接口

未采用。它能减少初期修改，却会让 D1、Binding 与 Worker Handler 概念长期存在，不利于彻底迁出和后续阅读。

### SQLite

未采用。SQLite 与 D1 方言更接近，但管理员已确认使用项目专属 PostgreSQL 容器，以统一 NAS 数据库运行和备份方式。

## 后果与约束

- 需要把 D1 仓储、Worker HTTP 入口、Cloudflare Cron 和 Browser Binding 分阶段替换，并迁移相关测试。
- PostgreSQL 迁移必须保持事务语义和至少一个应用版本的回滚兼容窗口。
- 应用进程内调度器必须使用 PostgreSQL advisory lock 防止重复采集和通知。
- 本地和生产镜像需要固定 Playwright 与 Chromium 版本，并分别验证 arm64 与 amd64。
- 局域网 HTTP 首阶段允许显式配置非 `Secure` Cookie；未来接入 HTTPS 或 FRP 时必须启用 `Secure`，但不在本次范围中实现公网入口。
- Docker Hub、GitHub Actions、数据库和 Telegram 凭据均不得进入镜像层、源码、普通日志或文档。
- 完整设计与验收标准见 [NAS Docker 与 PostgreSQL 迁移设计规格](../superpowers/specs/2026-07-27-nas-docker-postgresql-migration-design.md)。
