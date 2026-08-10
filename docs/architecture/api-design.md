# API 设计与访问边界

状态：Node 同源 API 已实现；NAS 实机验收待执行

## 1. 通用约束

- Node.js 22 以同一 origin 提供 React 静态资源与 `/api/*`；不启用跨域 API。浏览器不直接访问任天堂、汇率、Telegram 或数据库。
- 只有显式 `LOCAL_DEVELOPMENT_AUTH_BYPASS=true` 的本机开发进程才让认证状态返回 `{ initialized: true, authenticated: true }` 并由共享守卫直入；它强制监听 `127.0.0.1`、不读取 Cookie 或 PostgreSQL 会话，启动时只为空库写入公开默认设置，不生成认证材料。变量缺失或为 `false` 时所有接口恢复正常初始化与认证；旁路严禁部署到 Docker、NAS、局域网或公网。
- 请求体在路由边界按受控字段和大小上限校验；未知 API 返回固定 `404`，超限返回 `413`。数据库、网络和浏览器异常只映射为安全摘要。
- 会话 Cookie 始终为 `HttpOnly; SameSite=Strict`。`Secure` 由部署层显式 `COOKIE_SECURE` 决定，不能信任 `Forwarded` 或 `X-Forwarded-Proto` 自动推断。
- 所有写入仍先校验，再由服务/仓储执行参数化 SQL 与显式事务；除显式本机旁路外必须执行会话校验。响应、CSV 和日志不得包含密码、恢复码、会话、数据库或 Telegram 秘密。

## 2. 接口清单

| 方法与路径 | 访问 | 当前行为 |
| --- | --- | --- |
| `GET /api/health` | 公开 | 返回固定服务健康 JSON，不读取数据库或秘密。 |
| `GET /api/auth/status` | 公开 | 只返回 `initialized` 与 `authenticated` 布尔值。 |
| `POST /api/auth/initialize` | 仅未初始化 | 保存密码哈希、启用地区与默认区；恢复码只在 `201` 响应显示一次。重复初始化返回 `409`。 |
| `POST /api/auth/login` | 公开 | 验证密码与失败锁定；成功设置会话 Cookie。无效凭据 `401`，锁定 `429`。 |
| `POST /api/auth/recover` | 公开 | 一次性恢复码重设密码并撤销会话；成功 `204`，不回显秘密。 |
| `POST /api/auth/logout` | 可无 Cookie | 幂等撤销当前会话并清除 Cookie，返回 `204`。 |
| `GET/PATCH /api/settings` | 已登录 | 只读写公开偏好：地区、默认区、主题、时区、日报、税务州和保留策略；没有 Telegram 或认证秘密字段。 |
| `POST /api/products/search` | 已登录 | 名称只在服务端保存的默认区搜索官方候选，不允许浏览器覆盖默认区。 |
| `POST /api/products/resolve-link` | 已登录 | 按地区官方主机和路径白名单解析单个 HTTPS 链接。 |
| `POST /api/products/resolve-regions` | 已登录 | 按已保存启用地区解析跨区候选；必要时用本地 Playwright 处理最多三个日区升级包。只读，不创建订阅。 |
| `POST /api/products/preview-sources` | 已登录 | 返回逐区官方价格 ID 状态和来源提示，不写业务数据。 |
| `POST /api/products/confirm-subscriptions` | 已登录 | 保存前重新验证全部官方身份；一个 PostgreSQL 事务批量创建，任一失败零写入。 |
| `POST /api/subscriptions` | 已登录 | 以已确认的游戏和地区商品创建或幂等打开既有订阅。 |
| `GET /api/subscriptions/:id` | 已登录 | 返回脱敏订阅详情。 |
| `PATCH /api/subscriptions/:id` | 已登录 | 更新启用状态或地区范围；地区商品必须属于同一游戏。 |
| `POST /api/subscriptions/:id/disable` | 已登录 | 软停用，不删除历史。 |
| `POST /api/subscriptions/:id/resolve-regions` | 已登录 | 以现有订阅和设置决定缺失地区，忽略浏览器自定义范围。 |
| `POST /api/subscriptions/:id/complete-regions` | 已登录 | 复核并原子新增缺失地区，不替换现有映射或历史。 |
| `DELETE /api/subscriptions` | 已登录 | 接受非空、无重复 ID 数组；先验证全部目标，再在事务中永久删除订阅专属数据。 |
| `GET /api/dashboard` | 已登录 | 返回订阅概览、最新/历史最低价格、来源/过期状态、最近采集和下一日报时间。 |
| `GET /api/history?subscriptionId=&region=` | 已登录 | 按采集时间返回不可变快照；可选地区筛选。 |
| `POST /api/refresh` | 已登录 | 每个请求都同步执行一次统一采集并返回 `attempted/collected/stale` 等统计；当前没有冷却、队列或异步认领。 |
| `GET /api/export?kind=subscriptions\|prices\|fetch-logs` | 已登录 | 以独立字段白名单输出三类 CSV，排除所有秘密。 |

## 3. 商品与价格证据

- 地区代码只接受 US、JP、MX、BR、HK；默认区必须属于启用地区。每个地区在创建前必须确认或显式跳过。
- 官方 URL、商品类型、发行商、标题、地区、币种和本区价格 ID 在保存前复核。自动候选需要保持唯一性；无法证明时返回人工选择/链接状态，而不是猜测。
- 日区升级包浏览器批次最多三个商品，共用一次本地浏览器但每项使用新 context/page；单项失败不影响其他候选，也不自动重试。浏览器不参与六小时采集、手动刷新、日报或历史查询。
- 价格响应保留来源、原始货币、采集时间、过期状态与人民币汇率证据。官方 ID 不得跨区复用；第三方价格不得标记为官方或触发即时降价。

## 4. 手动刷新和调度边界

`POST /api/refresh` 是同步管理员操作：认证成功后记录最近请求时间，直接调用与六小时任务共享的采集服务，等待本轮完成后返回。当前实现不做 15 分钟冷却，不创建 `queued/running` 状态，也不由调度器消费。

自动任务不是 HTTP 端点。Node 进程使用 UTC 时钟和 PostgreSQL advisory lock 执行每分钟通知/日报与每六小时采集；未取得锁时立即跳过本轮。

## 5. 错误和静态资源

- 已知业务错误使用 `401/404/409/422/429` 和固定中文 `code/error`；未知数据库、网络、Telegram 或浏览器异常统一为不含内部细节的 `500`。
- `GET/HEAD` 非 API 请求先在构建静态目录内安全解析；路径穿越、重复编码和越根符号链接被拒绝，安全的客户端路由才回退 `index.html`。
- API 不存在时返回 JSON `404`，不能被 SPA 回退掩盖。
