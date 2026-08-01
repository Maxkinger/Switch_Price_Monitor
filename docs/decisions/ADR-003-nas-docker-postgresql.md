# ADR-003：迁移到 NAS Docker 与 PostgreSQL

| 项目 | 内容 |
| --- | --- |
| 状态 | 已采纳；仓库实现完成，外部发布与部署待验收 |
| 日期 | 2026-07-27 |
| 最后更新 | 2026-08-01 |
| 决策 | 以 Synology DS423+ 上的 Docker Compose 作为唯一目标生产环境，使用 Node.js 应用容器、项目专属 PostgreSQL 容器和本地 Playwright，并通过 GitHub Actions 发布公开多架构镜像。 |

## 背景

历史系统运行于 Cloudflare Workers，并依赖 Static Assets、D1、Cron、Secrets 与 Browser Binding。用户希望代码保持模块化、可在 Apple Silicon M1 本地调试，并在验证后将公开镜像交给 DS423+ 直接拉取。目标 NAS 为 Intel Celeron J4125、已扩充 16 GB DDR4；首阶段只要求局域网访问，但完整保留单管理员账号密码认证。

## 决策

1. 生产只运行 `app` 与 `postgres` 两个常驻容器。app 同源提供 React、API、UTC 调度器和本地 Playwright；不增加队列或独立浏览器服务。
2. PostgreSQL 17 使用项目专属全新空数据库和 bind mount，不迁移 D1 历史，也不映射宿主 5432。
3. 官方镜像 bootstrap 管理角色仅进入 postgres。空目录 init hook 创建无超级、建角、建库、复制或绕过 RLS 权限的普通应用数据库所有者；app 只取得普通角色 `DATABASE_URL`。
4. PostgreSQL 仓储使用参数化 SQL与显式事务。迁移、分钟任务和六小时任务使用不同的 advisory lock；未取得调度锁即跳过，不等待、不排队。
5. 日区升级包使用镜像内精确锁定的 Playwright Chromium：每批一个本地无头浏览器、最多三个隔离上下文串行、单项 30 秒、无自动重试、无远程/CDP/持久 profile/调试端口。
6. M1 支持开发与生产 Compose 验收。GitHub Actions 以严格 `vX.Y.Z` 发布 `linux/arm64` 与 `linux/amd64`，NAS Compose 只使用精确版本，不使用 `latest`。
7. 运行秘密只从未提交 `.env` 注入。Telegram Token 与 Chat ID 必须成对提供，设置页不存储秘密。
8. Cookie 始终 `HttpOnly; SameSite=Strict`。局域网 HTTP 明确 `COOKIE_SECURE=false`；未来可信 HTTPS 明确改为 `true`，不依据转发头自动判断。
9. 仓库旧 Cloudflare 运行路径被完全移除，ADR-001 被本决策取代。线上 Cloudflare 资源只有在 NAS 等价验收完成且取得独立授权后才能退役。

## 考虑过的方案

- **拆分 Web、调度器与浏览器**：会引入任务协议、队列和更多故障恢复，对单管理员 NAS 项目过度复杂。
- **保留 Cloudflare 兼容层**：会让 D1、Binding 与 Worker Handler 长期存在，与唯一 Node/PostgreSQL 路径冲突。
- **SQLite**：方言接近 D1，但不符合已确认的项目专属 PostgreSQL 运维和备份目标。

## 已实现的仓库边界

- Node.js 22 HTTP/静态资源、PostgreSQL 迁移与全部仓储、UTC 调度器、本地 Chromium、Dockerfile、开发/生产 Compose、双角色初始化、备份恢复脚本、普通 CI、严格标签发布和旧平台移除均已落地。
- 当前本地门禁：Vitest 69 文件/420 项、DOM 16 项、Chromium 4 项、Docker/平台合同 19/19、TypeScript 与生产构建通过。
- 当前工作树的 M1/arm64 生产镜像与 Compose 运行时已用全新临时 PostgreSQL 数据目录验收；双容器健康、UID/端口隔离、认证恢复与锁定、设置及重启持久化、镜像内 Chromium、备份恢复 14/14 均通过。其余业务 fake/fixture 由 420 项自动化分层证明，不宣称已在生产容器内完成外部端到端演练。
- 远程 run `30686052256` 是旧平台移除前提交的成功 CI，只是历史证据，不能代表当前工作树。

## 尚未完成的外部验收

- 配置 Docker Hub Secrets、创建 `v0.1.0`、发布公开双架构镜像。
- DS423+ 拉取、初始化、局域网登录、持久性、备份恢复和回滚演练。
- 真实 Telegram 与任天堂样本验收。
- 经独立授权停止并删除线上 Cloudflare 资源。

在这些步骤完成前，不得宣称迁移已上线或 Cloudflare 已退役。完整设计见 [迁移设计规格](../superpowers/specs/2026-07-27-nas-docker-postgresql-migration-design.md)，操作见 [群晖部署](../deployment/synology-ds423-plus.md)。
