# 数据模型（逻辑设计）

## 1. 设计原则

- 所有价格均以不可变快照保存，当前价格由最新成功快照派生，避免覆盖历史。
- 商品主档与地区商品分离：同一逻辑商品可映射多个地区的独立链接或商品标识。
- 认证、Telegram 凭据及恢复相关字段与业务查询模型隔离，且不参与任何导出。
- 日志与价格历史采用不同保留策略：日志固定 90 天，价格历史按管理员设置保留。

## 2. 核心实体

| 实体 | 职责 | 关键内容 |
| --- | --- | --- |
| `settings` | 单管理员全局偏好 | 启用地区、默认搜索区、主题、时区、日报时间、税务州、来源排序、历史保留策略，以及默认关闭的 `proxy_enabled`、`proxy_protocol`、`proxy_host`、`proxy_port`；代理只允许无认证 HTTP/HTTPS/SOCKS5，默认搜索区必须属于启用地区 |
| `admin_credentials` | 管理员认证材料 | 密码哈希、恢复码校验值、初始化状态；不保存明文凭据 |
| `sessions` | 登录会话 | 会话标识摘要、过期时间、撤销状态 |
| `login_attempts` | 登录暴力防护 | 单管理员连续失败次数与 UTC 绝对解锁时间；PostgreSQL 以原子 UPSERT 递增，避免并发请求丢失计数 |
| `games` | 逻辑商品主档 | 标题、规范化标题、发行商、商品类型、封面、唯一规范化标识 |
| `regional_products` | 各区商品映射 | 地区、货币、官方链接、每区独立的官方价格 ID、匹配来源、商品校验元数据、启用状态；价格 ID 来自搜索/链接验证，不由管理员手填且不可跨区复用 |
| `subscriptions` | 监控配置 | 软停用状态、监控地区、全局 CNY 目标价、通知选项 |
| `subscription_region_targets` | 单区目标价覆盖 | 地区、当地货币目标价、目标命中状态 |
| `price_snapshots` | 不可变价格历史 | 金额、货币、标价/税后口径、CNY 价格/汇率、来源、采集时间、有效性 |
| `exchange_rates` | 每日汇率记录 | 货币、CNY 中间汇率、来源、读取时间、是否过期 |
| `fetch_logs` | 采集诊断 | 来源、状态、耗时、安全错误摘要、采集时间；90 天清理 |
| `regional_product_health` | 故障与恢复状态 | 连续失败次数、最近成功时间、异常通知状态；由采集结果服务写回，供后续通知事件去重 |
| `notification_events` | 通知去重与审计 | 类型、关联订阅/地区、状态变迁、Telegram 发送结果和时间；唯一键原子预留同一业务事件的一次发送资格，成功投递时间只可由 pending 安全更新一次；投递调度按创建顺序读取 pending 并通过关联主档取得可读游戏名与地区标签，已 delivered 的事件不会再次进入发送队列 |
| `manual_refresh_requests` | 最近手动刷新审计 | 仅保存单行最近请求时间；当前临时无冷却且请求内同步采集，不保存 queued/running、会话、浏览器标识、商品或来源响应；并发写使用最大时间防止记录倒退 |

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

- 新建订阅以标题、可空发行商和商品类型构成的规范化商品身份执行重复检测；`games.normalized_name` 的非空值由唯一索引约束，避免并发确认创建重复游戏。最终确认先重新验证全部官方链接，再在一个 PostgreSQL 显式事务中写入游戏、地区商品、订阅及关联；每条 SQL 都使用同一事务 executor，任一验证、唯一约束或中途故障均不保留半成品。
- 首次初始化把 `admin_credentials` 与 `settings` 写入同一事务。密码恢复对未消费恢复状态做条件更新，并在同一事务更换密码哈希、标记恢复码、撤销全部会话和清空失败记录；并发恢复只有一个事务成功。D1 过渡 batch 的撤销会话和清除失败记录也必须匹配本次刚消费的恢复材料，不能影响失败恢复后的新状态。
- 成功登录在事务内锁定并重新比较服务刚验证的密码哈希与盐，再检查锁定状态、清空失败记录并写入会话摘要。这样密码恢复若先提交，旧密码无法随后创建有效会话；登录若先提交，恢复事务会撤销该会话。
- 设置 PATCH 只提交公开局部字段；PostgreSQL 在 `settings.id=1` 的 `FOR UPDATE` 锁内重新读取、合并、验证并保存，确保不同字段的并发更新不丢失，且默认搜索区始终属于最终启用地区。
- 永久删除先锁定目标订阅、游戏与所有 `regional_products`。地区商品的 `FOR UPDATE` 与通知、日志、快照外键写入所需的 `KEY SHARE` 冲突，因此清理子表后不会再插入孤儿通知/日志或令快照 `RESTRICT` 使整批删除回滚。
- 取消订阅为软停用，不删除 `price_snapshots`。
- 目标价事件仅在“未命中”转换为“已命中”时记录并发送；回升后恢复“未命中”。
- 只有来源为官方的连续快照可构成即时降价判定。
- 代理字段不保存用户名、密码、完整 URL、密钥或密文；设置 PATCH 在单例行 `FOR UPDATE` 锁内合并并验证四字段，测试连接草稿永不写入数据库。

## 4. 敏感数据边界

- Telegram Bot Token、Chat ID 等运行时秘密优先从 Cloudflare Secret 读取；如允许设置页配置，必须以应用级加密形式存储且绝不回显。
- 密码和恢复码均只保存不可逆验证材料。
- CSV 导出只面向业务与诊断数据；敏感实体和字段在查询层排除。
