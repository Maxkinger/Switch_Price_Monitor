# ADR-001：采用 Cloudflare Workers Static Assets 与 D1

| 项目 | 内容 |
| --- | --- |
| 状态 | 历史决策；已被 ADR-003 取代 |
| 日期 | 2026-07-16 |
| 被取代日期 | 2026-08-01（仓库运行路径完成迁移） |
| 历史决策 | 使用 Cloudflare Workers Static Assets 托管 React 前端与 API，使用 D1 存储业务数据，以 Cron Trigger 执行采集与日报调度。 |

## 背景与当时理由

产品是个人使用的 Switch 价格监控站，需要定时采集、持久化历史、Telegram 推送和网页管理界面。当时在 Cloudflare Workers + D1、VPS/NAS + Docker、Vercel + Supabase 中选择第一项，主要为了降低服务器维护成本，并通过一个 Worker 部署单元提供静态前端、API 与调度。

该方案在 2026-07-17 至 2026-07-19 形成了 D1、Worker、Cron 与 Browser Binding 的历史生产验收记录。这些记录仍保留在质量文档中用于审计，但不再定义当前仓库的支持架构。

## 取代原因

- Worker 部署会形成单一 bundle，不利于本地阅读、调试与长期维护。
- D1、Cron、Secrets 与 Browser Binding 使运行时和数据层绑定 Cloudflare。
- 用户已确认以 DS423+、Docker Compose、项目专属 PostgreSQL 和本地 Playwright 作为唯一目标，并要求 M1 本地调试与 GitHub Actions 多架构发布。

当前仓库已经移除旧平台运行时代码、依赖、配置和平台测试，只支持 Node.js 22 + PostgreSQL 17 + 本地 Playwright Chromium。现行决策见 [ADR-003](ADR-003-nas-docker-postgresql.md)。

## 线上资源退役边界

“仓库代码已迁移”不等于“线上资源已删除”。Cloudflare Worker、D1、Cron、Secrets 或 Browser 资源仍可能存在；当前没有执行删除。M1 生产运行时 Compose 与业务自动化分层证据已经完成，但仍必须完成公开镜像、DS423+ 功能等价、备份恢复和回滚验收，再取得针对精确线上资源的独立退役授权。任何文档或自动化都不得把 ADR 状态当作删除授权。

## 历史后果

- 当时必须遵守 Worker 运行时间、网络请求和站点访问限制。
- D1 批次、Cloudflare Cron 和 Browser Binding 的证据只适用于对应历史提交/部署。
- 历史外部链接、版本号和生产样本不证明当前 Node/PostgreSQL 工作树已部署或已通过远程验收。
