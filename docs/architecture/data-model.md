# 数据模型（PostgreSQL 17）

状态：仓库实现完成；全新 NAS 数据库初始化待验收
最后更新：2026-08-01

## 1. 设计原则

- 当前唯一数据层是项目专属 PostgreSQL 17；NAS 不导入 D1 历史。
- 所有金额使用整数最小货币单位，时间使用 `TIMESTAMPTZ`，布尔值使用 `BOOLEAN`，结构化设置使用 `JSONB`。
- SQL 动态值必须参数化；跨表业务写入使用显式事务。迁移与调度使用不同的 PostgreSQL advisory lock。
- 价格以不可变快照保存。采集日志保留 90 天；价格历史按管理员偏好永久、1 年或 2 年保留。

## 2. 核心实体

| 实体 | 职责与关键约束 |
| --- | --- |
| `schema_migrations` | 记录迁移文件名和 SHA-256；已应用文件不得改写，恢复时必须与应用镜像 manifest 完全一致。 |
| `settings` | 单管理员全局偏好：启用地区、默认搜索区、主题、时区、日报时间、税务州和价格历史保留策略；默认区必须属于启用地区。 |
| `admin_credentials` | 单一管理员密码哈希、恢复码校验值和初始化状态；不保存明文。 |
| `sessions` | 会话令牌摘要、过期与撤销状态；原始令牌只存在于 Cookie。 |
| `login_attempts` | 登录失败计数与锁定时间；并发更新使用单条原子 upsert，成功登录清除状态。 |
| `games` | 逻辑商品主档；规范化名称的非空值唯一，避免并发重复创建。 |
| `regional_products` | 本区官方 URL、币种、独立官方价格 ID、匹配来源、商品校验元数据与启用状态；价格 ID 不得跨区复用。 |
| `subscriptions` | 单一逻辑商品的监控状态、全局人民币目标价和通知选项；停用为软操作。 |
| `subscription_region_targets` | 订阅的地区范围、当地货币目标价和命中状态；地区目标优先于全局目标。 |
| `price_snapshots` | 不可变的金额、币种、口径、人民币换算、汇率、来源、采集时间和有效状态。 |
| `exchange_rates` | 每日对人民币中间汇率、来源、读取时间和过期标记。 |
| `fetch_logs` | 来源、状态、耗时、脱敏错误摘要与采集时间；固定 90 天清理。 |
| `regional_product_health` | 连续失败数、最近成功时间和异常通知状态；成功后清零并允许恢复事件。 |
| `notification_events` | 目标价、降价、失败和恢复等通知的唯一业务键、`pending/delivered` 状态及投递时间；保证同一事件只取得一次发送资格。 |
| `manual_refresh_requests` | 单行最近手动请求时间。它不是队列，不含 `queued/running`，也不承担冷却或调度认领。 |

## 3. 关系与事务边界

```text
games 1 ── * regional_products
games 1 ── * subscriptions
subscriptions 1 ── * subscription_region_targets
regional_products 1 ── * price_snapshots / fetch_logs
regional_products 1 ── 1 regional_product_health
subscriptions / regional_products ── * notification_events
```

- 批量确认在一个 PostgreSQL 事务中验证并写入商品、地区商品、订阅与地区目标；任一官方身份或 SQL 失败均零写入。
- 永久删除先锁定并验证全部目标，再在同一事务删除订阅专属数据；设置、汇率、认证和未选择订阅不受影响。
- 自动采集与每次已认证手动刷新共享采集服务，但互不排队。每次手动请求同步执行并更新最近时间。
- 目标价只在未命中到命中的边沿创建事件；价格回升后才重新允许下一次命中。即时降价只比较官方成功快照。
- 迁移、采集调度和分钟通知各自依赖明确的事务或 advisory lock，不能以进程内布尔值替代数据库互斥。

## 4. 敏感数据与导出

- Telegram Bot Token 与 Chat ID 仅由成对环境变量注入，不存入 `settings`，设置 API 和页面都没有秘密字段。
- 密码、恢复码与会话仅保存不可逆验证材料或摘要；数据库 bootstrap 密码不进入 app 容器。
- CSV 只允许订阅、价格历史和采集日志白名单字段，排除认证、会话、恢复码、Telegram 和数据库凭据。
- 普通日志不得输出连接串、SQL 参数、第三方响应正文、Cookie、浏览器页面内容或异常堆栈中的秘密。

## 5. 初始化、备份与恢复

首次 PostgreSQL 数据目录必须为空。只读 init hook 用容器内部 bootstrap 角色创建普通应用数据库所有者并转移数据库与 `public` schema 所有权；重复执行或错误非空目录必须失败，不能隐式修复。

备份采用 PostgreSQL 17 custom archive、原子临时文件与每库单调序号。恢复只允许 app 停止、普通 app 角色拥有的独立空库；成功后验证迁移账本、当前迁移定义的 16 张 public 表精确集合，以及管理员只能为 0 行或唯一 `id=1`。详细合同见 [PostgreSQL 备份恢复](../deployment/postgres-backup-restore.md)。
