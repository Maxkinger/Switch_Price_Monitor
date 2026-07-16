# 数据模型（逻辑设计）

## 1. 设计原则

- 所有价格均以不可变快照保存，当前价格由最新成功快照派生，避免覆盖历史。
- 商品主档与地区商品分离：同一逻辑商品可映射多个地区的独立链接或商品标识。
- 认证、Telegram 凭据及恢复相关字段与业务查询模型隔离，且不参与任何导出。
- 日志与价格历史采用不同保留策略：日志固定 90 天，价格历史按管理员设置保留。

## 2. 核心实体

| 实体 | 职责 | 关键内容 |
| --- | --- | --- |
| `settings` | 单管理员全局偏好 | 启用地区、默认搜索区、主题、时区、日报时间、税务州、来源排序、历史保留策略；默认搜索区必须属于启用地区 |
| `admin_credentials` | 管理员认证材料 | 密码哈希、恢复码校验值、初始化状态；不保存明文凭据 |
| `sessions` | 登录会话 | 会话标识摘要、过期时间、撤销状态 |
| `games` | 逻辑商品主档 | 标题、规范化标题、发行商、商品类型、封面、唯一规范化标识 |
| `regional_products` | 各区商品映射 | 地区、货币、官方链接/标识、匹配来源、商品校验元数据、启用状态 |
| `subscriptions` | 监控配置 | 软停用状态、监控地区、全局 CNY 目标价、通知选项 |
| `subscription_region_targets` | 单区目标价覆盖 | 地区、当地货币目标价、目标命中状态 |
| `price_snapshots` | 不可变价格历史 | 金额、货币、标价/税后口径、CNY 价格/汇率、来源、采集时间、有效性 |
| `exchange_rates` | 每日汇率记录 | 货币、CNY 中间汇率、来源、读取时间、是否过期 |
| `fetch_logs` | 采集诊断 | 来源、状态、耗时、安全错误摘要、采集时间；90 天清理 |
| `regional_product_health` | 故障与恢复状态 | 连续失败次数、最近成功时间、异常通知状态；由采集结果服务写回，供后续通知事件去重 |
| `notification_events` | 通知去重与审计 | 类型、关联订阅/地区、状态变迁、Telegram 发送结果和时间；唯一键原子预留同一业务事件的一次发送资格，成功投递时间只可由 pending 安全更新一次；投递调度按创建顺序读取 pending 并通过关联主档取得可读游戏名与地区标签，已 delivered 的事件不会再次进入发送队列 |
| `manual_refresh_requests` | 手动刷新队列 | 单行最近请求时间与 queued/running 状态；以原子更新强制 15 分钟冷却，调度器仅能原子认领一次 queued 请求，不保存会话或浏览器标识 |

## 3. 关键关系与约束

```text
games 1 ── * regional_products
games 1 ── * subscriptions
subscriptions 1 ── * subscription_region_targets
regional_products 1 ── * price_snapshots
regional_products 1 ── * fetch_logs
regional_products 1 ── 1 regional_product_health
subscriptions / regional_products ── * notification_events
```

- 新建订阅以前端确认的规范化商品标识执行重复检测；重复时返回既有订阅而不新增。
- 取消订阅为软停用，不删除 `price_snapshots`。
- 目标价事件仅在“未命中”转换为“已命中”时记录并发送；回升后恢复“未命中”。
- 只有来源为官方的连续快照可构成即时降价判定。

## 4. 敏感数据边界

- Telegram Bot Token、Chat ID 等运行时秘密优先从 Cloudflare Secret 读取；如允许设置页配置，必须以应用级加密形式存储且绝不回显。
- 密码和恢复码均只保存不可逆验证材料。
- CSV 导出只面向业务与诊断数据；敏感实体和字段在查询层排除。
