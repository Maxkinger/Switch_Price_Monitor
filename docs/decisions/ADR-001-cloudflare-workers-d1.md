# ADR-001：采用 Cloudflare Workers Static Assets 与 D1

| 项目 | 内容 |
| --- | --- |
| 状态 | 已确认 |
| 日期 | 2026-07-16 |
| 决策 | 使用 Cloudflare Workers Static Assets 托管 React 前端与 API，使用 D1 存储业务数据，以 Cron Trigger 执行采集与日报调度。 |

## 背景

产品为个人使用的 Switch 价格监控站，需要定时采集、持久化价格历史、Telegram 推送、安全保存密钥和网页管理界面，同时希望降低服务器维护成本。

## 考虑过的方案

1. Cloudflare Workers + D1：免服务器运维，提供 Worker、D1、Cron 与 Secrets。
2. VPS / NAS + Docker：抓取扩展性高，但需要维护服务器、证书、数据库和运行环境。
3. Vercel + Supabase：前后端生态成熟，但平台和配置较分散。

## 决策理由

选择方案 1，因为它与个人项目的低维护、定时运行、数据持久化和私密配置要求最匹配。采用 Workers Static Assets 而非单独 Pages，以便在一个部署单元中提供前端资产、API 和定时任务。

## 后果与约束

- 必须遵守 Worker 运行时间、网络请求和外部站点访问限制。
- 外部站点读取需要限流、超时和第三方回退策略。
- 需要以应用层时区逻辑处理日报时间；Cron 本身使用 UTC，且触发更新可能延迟。
- 如未来官方商店必须使用真实浏览器渲染才能读取价格，可能需评估 Cloudflare Browser Rendering 或独立抓取服务；该项不在当前决策中预先引入。

## 参考

- Cloudflare Workers Best Practices: <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Cloudflare D1 Getting Started: <https://developers.cloudflare.com/d1/get-started/>
- Cloudflare Cron Triggers: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>
