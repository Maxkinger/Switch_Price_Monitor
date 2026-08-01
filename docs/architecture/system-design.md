# 系统架构说明

状态：仓库内迁移、M1 生产运行时 Compose 与业务自动化分层证据已完成；公开镜像发布和 DS423+ 部署待验收
最后更新：2026-08-01

## 1. 当前支持边界

仓库当前唯一支持的运行路径是 Node.js 22、PostgreSQL 17 与本地 Playwright Chromium。旧 Cloudflare Worker、D1、Cron Trigger、Static Assets Binding、Secrets 和 Browser Binding 的运行时代码、依赖及测试入口已经移除；Cloudflare 的历史生产证据仅用于审计，不代表当前仓库仍支持双平台。

线上 Cloudflare 资源尚未删除。它们必须等 NAS 等价验收完成并取得独立退役授权后再处理，不能因为仓库代码已经迁移就推断线上资源已停用。

## 2. 生产拓扑

```text
局域网浏览器
    │ HTTP（首阶段）
    ▼
app：Node.js 22，唯一映射 NAS 端口
    ├─ 同源 React 静态资源与 SPA 回退
    ├─ 受认证 API 与业务服务
    ├─ UTC 进程内调度器
    └─ 本地 Playwright + Chromium
    │ Compose 私有网络
    ▼
postgres：PostgreSQL 17，不映射宿主 5432
    └─ 项目专属数据库、普通应用所有者与持久化目录
```

生产 Compose 只含两个常驻服务。Chromium 不提供 CDP、远程调试端口或持久用户目录；PostgreSQL 只在 Compose 网络内可达。NAS 只保存 Compose、未提交 `.env`、只读初始化脚本和数据/备份目录，不在设备上编译源码。

本地 M1 可使用开发 Compose 与本机 Node 调试。2026-08-01 当前工作树以原生 arm64 构建最终镜像，并用生产 Compose 从空 bind mount 启动：app/postgres 均健康，app 以 `10001:10001` 运行，仅映射应用 HTTP，PostgreSQL 只保留容器网络 `5432`。验收还覆盖首次初始化、登录/退出、一次性恢复码改密、连续失败锁定、设置保存、app 重启持久化，以及镜像内无网络 Chromium 启停；全部使用合成凭据和唯一临时项目，未连接既有数据库。

## 3. 组件职责

- `src/server/`：校验运行配置，装配 Hono/Fetch 应用、静态资源、PostgreSQL、调度器与优雅关停；不得吸收业务判断。
- `src/routes/`：认证守卫、请求解析、输入约束和安全错误映射。
- `src/services/`：订阅确认、采集、通知、历史保留和业务规则。
- `src/repositories/postgres/`：参数化 SQL、显式事务、行模型转换与 PostgreSQL 锁。
- `src/providers/`：任天堂、汇率与 Telegram 外部边界；第三方价格源未经 ADR-002 准入时不得发请求。
- `src/providers/playwright/`：日区升级包关系发现；每批一个本地无头 Chromium，最多三个商品串行使用隔离上下文，单项 30 秒且不自动重试。
- `migrations/postgres/`：按文件名排序、带 SHA-256 账本的不可变迁移。

## 4. 核心数据流

### 4.1 订阅发现与确认

1. 已登录管理员通过同源 API 搜索默认区或提交任天堂官方链接。
2. Node 服务读取已保存的启用地区，调用各区官方适配器；浏览器不直接访问商店。
3. 日区升级包仅在静态官方接口不能证明关系时启动本地 Chromium；失败按商品降级，不猜测 ID。
4. 确认前重新验证官方 URL、地区、币种、类型、发行商和本区价格 ID。
5. PostgreSQL 显式事务一次写入商品、地区映射、订阅及关联；任一步失败全部回滚。

### 4.2 价格采集与手动刷新

- 六小时任务在专用 PostgreSQL advisory lock 内执行一次保留清理和统一采集；未取得锁立即跳过，不等待、不排队、不补跑。
- 每个已认证 `POST /api/refresh` 都在当前请求内同步执行同一采集链并返回统计。目前没有冷却、队列或调度器认领语义，数据库只记录最近请求时间。
- 官方结果必须匹配地区、币种、身份与本区价格 ID。全部来源失败时保留最近成功快照并标记过期，不制造价格。
- 只有官方成功快照可触发即时降价；第三方来源即使未来获准，也只用于展示与日报。

### 4.3 通知与日报

- Node 进程按 UTC 对齐每分钟检查日报和待投递事件，使用与六小时采集不同的 PostgreSQL advisory lock。
- Telegram 只在 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_CHAT_ID` 成对存在时装配。设置页不接收、不保存也不回显这两项秘密。
- 事件先以唯一业务键在 PostgreSQL 中预留，投递成功后从 `pending` 原子更新为 `delivered`；失败保留待重试状态，普通日志只记录脱敏类别。

## 5. 认证与秘密边界

- 系统只允许单一管理员。密码、恢复码和会话令牌只保存不可逆校验材料或摘要；恢复码仅初始化时显示一次。
- 会话 Cookie 始终使用 `HttpOnly` 与 `SameSite=Strict`。局域网纯 HTTP 必须显式设置 `COOKIE_SECURE=false`；未来接入可信 HTTPS（包括经正确 TLS 终止的 FRP）必须改为 `true`。应用不会依据转发头自动降低该约束。
- 登录连续失败会临时锁定；成功登录清理失败状态。退出、恢复密码和修改密码按业务规则撤销会话。
- PostgreSQL bootstrap 管理角色只存在于数据库容器。应用只取得普通数据库所有者的 `DATABASE_URL`，两类用户名和密码必须不同。
- Docker Hub、数据库、Telegram、密码、恢复码和 Cookie 均不得进入 Git、镜像层、普通日志或文档。

## 6. 数据、备份与生命周期

- NAS 使用全新项目专属 PostgreSQL 数据库，不导入 D1 历史数据；首次数据目录必须为空，官方 entrypoint 才会执行普通角色初始化脚本。
- 迁移器在启动时使用独立 advisory lock，验证已应用迁移的文件名和校验和；漂移或失败使进程退出。
- 价格快照不可变；采集日志固定保留 90 天，价格历史按管理员设置保留。
- 宿主备份脚本生成经 `pg_restore --list` 校验的 custom archive，并按数据库独立保留最近 14 份。恢复只允许 app 已停止、目标为独立空库且迁移 manifest 一致的项目，禁止覆盖在线业务库。
- 进程关停顺序为停止接收调度、停止 HTTP、等待受控任务并关闭数据库池；超出共享宽限时间后退出，由下一轮幂等状态恢复。

## 7. 发布与部署状态

GitHub Actions 普通 CI 验证测试、类型、构建、秘密扫描和双架构镜像构建，但不登录 Docker Hub。标签发布只接受仓库最高的严格 `vX.Y.Z`，完整门禁通过后发布 `X.Y.Z`、`X.Y`、`sha-<12位提交>` 与 `latest`；NAS 必须固定使用精确 `APP_VERSION`，不能使用 `latest`。

当前本地门禁为 Vitest 69 个文件/420 项、DOM 16 项、Chromium 4 项、Docker/平台合同 19/19，以及 TypeScript 和生产构建通过。远程 CI run `30686052256` 通过的是平台移除前的提交，不能证明当前工作树。Docker Hub Secrets 尚未配置，`v0.1.0` 尚未创建，公开镜像、DS423+ 部署、真实 Telegram/Nintendo 样本与 Cloudflare 资源退役均未完成。

### 7.1 M1 本地开发命令

以下命令只使用 `docker-compose.dev.yml` 的 tmpfs 一次性 PostgreSQL 和回环 `54329`，不会连接 NAS 或项目现有数据库：

```bash
docker compose -f docker-compose.dev.yml up -d postgres
docker compose -f docker-compose.dev.yml ps postgres
DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
  COOKIE_SECURE=false npm run dev
```

测试使用同一受守卫 URL：

```bash
TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
  npx vitest run
```

停止开发数据库使用 `docker compose -f docker-compose.dev.yml down`；tmpfs 数据不可恢复，不能存放需要保留的调试资料。

部署步骤见 [群晖 DS423+ 部署](../deployment/synology-ds423-plus.md)、[Docker Hub 发布](../deployment/docker-hub-release.md)和 [PostgreSQL 备份恢复](../deployment/postgres-backup-restore.md)。
