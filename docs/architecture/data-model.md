# 数据模型（PostgreSQL 17）

状态：仓库实现完成；全新 NAS 数据库初始化待验收
最后更新：2026-08-11

## 1. 设计原则

- 当前唯一数据层是项目专属 PostgreSQL 17；NAS 不导入 D1 历史。
- 所有金额使用整数最小货币单位，时间使用 `TIMESTAMPTZ`，布尔值使用 `BOOLEAN`，结构化设置使用 `JSONB`。
- `settings` 在 `0003_proxy_settings.sql` 增加 `proxy_enabled`、`proxy_protocol`、`proxy_host`、`proxy_port` 四个无认证端点字段；协议和端口由 CHECK 约束收窄，密码、用户名和完整代理 URL 永不入库。
- DeepSeek 只在管理员请求名称建议时使用；API Key、模型和官方地址作为一个 AES-256-GCM 密文载荷保存在专用单例，模型响应、提示词和未确认建议不写入 PostgreSQL。
- SQL 动态值必须参数化；跨表业务写入使用显式事务。迁移与调度使用不同的 PostgreSQL advisory lock。
- 价格以不可变快照保存。采集日志保留 90 天；价格历史按管理员偏好永久、1 年或 2 年保留。

## 2. 核心实体

| 实体 | 职责与关键约束 |
| --- | --- |
| `schema_migrations` | 记录迁移文件名和 SHA-256；已应用文件不得改写，恢复时必须与应用镜像 manifest 完全一致。 |
| `settings` | 单管理员全局偏好：启用地区、默认搜索区、主题、时区、日报时间、税务州和价格历史保留策略；默认区必须属于启用地区。 |
| `admin_credentials` | 单一管理员密码哈希、恢复码校验值和初始化状态；不保存明文。 |
| `ai_provider_configuration` | 固定 `id=1` 的 AI 配置密文单例：只保存算法版本、随机 nonce、密文和更新时间；Key、模型和地址同包加密，不保存明文或可查询元数据。 |
| `sessions` | 会话令牌摘要、过期与撤销状态；原始令牌只存在于 Cookie。 |
| `login_attempts` | 登录失败计数与锁定时间；并发更新使用单条原子 upsert，成功登录清除状态。 |
| `games` | 逻辑商品主档；规范化名称的非空值唯一，避免并发重复创建。`display_name_zh_cn`、来源和确认时刻是仅影响展示的游戏级人工/目录结果，绝不参与官方身份、URL、价格 ID 或价格快照计算；旧 `name_zh` 仅作兼容与管理候选。 |
| `game_name_catalog` | 已确认简体中文名称词条；主键是规范化官方标题、发行商和商品类型组成的精确身份。名称修剪后限制为 1–120 字符，来源枚举为发行商、中国大陆平台、香港参考或人工确认，可选证据仅保存 HTTPS URL 与确认时刻。 |
| `regional_products` | 本区官方 URL、币种、独立官方价格 ID、匹配来源、商品校验元数据与启用状态；价格 ID 不得跨区复用。 |
| `subscriptions` | 单一逻辑商品的监控状态和通知选项；停用为软操作。 |
| `price_snapshots` | 不可变的金额、币种、口径、人民币换算、汇率、来源、采集时间和有效状态。 |
| `exchange_rates` | 每日对人民币中间汇率、来源、读取时间和过期标记。 |
| `fetch_logs` | 来源、状态、耗时、脱敏错误摘要与采集时间；固定 90 天清理。 |
| `regional_product_health` | 连续失败数、最近成功时间和异常通知状态；成功后清零并允许恢复事件。 |
| `notification_events` | 降价、失败和恢复等通知的唯一业务键、`pending/delivered` 状态及投递时间；保证同一事件只取得一次发送资格。 |
| `manual_refresh_requests` | 单行最近手动请求时间。它不是队列，不含 `queued/running`，也不承担冷却或调度认领。 |

## 3. 关系与事务边界

```text
games 1 ── * regional_products
games 1 ── * subscriptions
game_name_catalog 1 ── * games（仅通过精确 `normalized_name` 目录回填；单游戏 `manual` 覆盖优先）
regional_products 1 ── * price_snapshots / fetch_logs
regional_products 1 ── 1 regional_product_health
subscriptions / regional_products ── * notification_events
```

- 批量确认在一个 PostgreSQL 事务中验证并写入商品、地区商品、订阅与地区目标；任一官方身份或 SQL 失败均零写入。
- 中文名称目录回填只更新 `display_name_zh_cn IS NULL` 且精确身份命中的游戏；重复回填不覆盖游戏级 `manual` 覆盖，人工名称保存可在同一事务中选择性 upsert 未来复用词条。
- 永久删除先锁定并验证全部目标，再在同一事务删除订阅专属数据；设置、汇率、认证和未选择订阅不受影响。
- 自动采集与每次已认证手动刷新共享采集服务，但互不排队。每次手动请求同步执行并更新最近时间。
- 即时降价只比较官方成功快照，并由通知事件的唯一业务键确保同一事件只投递一次。
- 迁移、采集调度和分钟通知各自依赖明确的事务或 advisory lock，不能以进程内布尔值替代数据库互斥。

## 4. 敏感数据与导出

- Telegram Bot Token 与 Chat ID 仅由成对环境变量注入，不存入 `settings`，设置 API 和页面都没有秘密字段。
- 设置页提交的 DeepSeek API Key、模型和地址只以同包 AES-256-GCM 密文保存；Node 私有 `AI_CREDENTIAL_ENCRYPTION_KEY` 不入库且永不进入备份内容说明、CSV、设置 API 或页面。主密钥丢失时旧密文不可恢复，管理员只能清除后重新配置；名称建议在浏览器中仍只是待确认草稿，管理员保存前不会进入 `games`、`game_name_catalog` 或任何审计表。
- 密码、恢复码与会话仅保存不可逆验证材料或摘要；数据库 bootstrap 密码不进入 app 容器。
- CSV 只允许订阅、价格历史和采集日志白名单字段，排除认证、会话、恢复码、Telegram 和数据库凭据。
- 普通日志不得输出连接串、SQL 参数、第三方响应正文、Cookie、浏览器页面内容或异常堆栈中的秘密。

## 5. 初始化、备份与恢复

首次 PostgreSQL 数据目录必须为空。只读 init hook 用容器内部 bootstrap 角色创建普通应用数据库所有者并转移数据库与 `public` schema 所有权；重复执行或错误非空目录必须失败，不能隐式修复。

备份采用 PostgreSQL 17 custom archive、原子临时文件与每库单调序号。归档会包含 AI 密文行但不包含 Node 主密钥；恢复只允许 app 停止、普通 app 角色拥有的独立空库，成功后验证迁移账本、当前迁移定义的 17 张 public 表精确集合，以及管理员只能为 0 行或唯一 `id=1`。详细合同见 [PostgreSQL 备份恢复](../deployment/postgres-backup-restore.md)。
