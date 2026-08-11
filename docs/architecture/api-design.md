# API 设计与访问边界

状态：Node 同源 API 已实现；NAS 实机验收待执行

## 1. 通用约束

- Node.js 22 以同一 origin 提供 React 静态资源与 `/api/*`；不启用跨域 API。浏览器不直接访问任天堂、DeepSeek、汇率、Telegram 或数据库。
- 只有显式 `LOCAL_DEVELOPMENT_AUTH_BYPASS=true` 的本机开发进程才让认证状态返回 `{ initialized: true, authenticated: true }` 并由共享守卫直入；它强制监听 `127.0.0.1`、不读取 Cookie 或 PostgreSQL 会话，启动时只为空库写入公开默认设置，不生成认证材料。该受限模式同时覆盖名称管理五个接口，便于本机验证回填、更正和待确认 AI 建议；变量缺失或为 `false` 时所有管理接口恢复正常初始化与真实 Cookie/会话认证。旁路严禁部署到 Docker、NAS、局域网或公网。
- 请求体在路由边界按受控字段和大小上限校验；未知 API 返回固定 `404`，超限返回 `413`。数据库、网络和浏览器异常只映射为安全摘要。
- 会话 Cookie 始终为 `HttpOnly; SameSite=Strict`。`Secure` 由部署层显式 `COOKIE_SECURE` 决定，不能信任 `Forwarded` 或 `X-Forwarded-Proto` 自动推断。
- 所有写入仍先校验，再由服务/仓储执行参数化 SQL 与显式事务；除显式本机旁路外必须执行会话校验。响应、CSV 和日志不得包含密码、恢复码、会话、数据库、DeepSeek API Key 或 Telegram 秘密。

## 2. 接口清单

| 方法与路径 | 访问 | 当前行为 |
| --- | --- | --- |
| `GET /api/health` | 公开 | 返回固定服务健康 JSON，不读取数据库或秘密。 |
| `GET /api/auth/status` | 公开 | 只返回 `initialized` 与 `authenticated` 布尔值。 |
| `POST /api/auth/initialize` | 仅未初始化 | 保存密码哈希、启用地区与默认区；恢复码只在 `201` 响应显示一次。重复初始化返回 `409`。 |
| `POST /api/auth/login` | 公开 | 验证密码与失败锁定；成功设置会话 Cookie。无效凭据 `401`，锁定 `429`。 |
| `POST /api/auth/recover` | 公开 | 一次性恢复码重设密码并撤销会话；成功 `204`，不回显秘密。 |
| `POST /api/auth/logout` | 可无 Cookie | 幂等撤销当前会话并清除 Cookie，返回 `204`。 |
| `GET/PATCH /api/settings` | 已登录 | 只读写公开偏好：地区、默认区、主题、时区、日报、税务州、保留策略及无认证代理的协议/主机/端口；没有 Telegram、认证或代理密码字段。 |
| `GET /api/settings/ai-provider` | 已登录 | 只返回 `{ configured, model, apiBaseUrl }` 摘要；Key、密文、主密钥和解密失败原因均不返回。 |
| `PUT /api/settings/ai-provider` | 已登录 | 接收完整 `{ apiKey, model, apiBaseUrl }`，服务端只接受精确 `https://api.deepseek.com` 并 AES-256-GCM 加密持久化；替换模型或地址也必须重新提交 Key。 |
| `DELETE /api/settings/ai-provider` | 已登录 | 删除唯一 AI 密文配置并返回 `204`；不会改动公开设置、词条、游戏、订阅或价格。 |
| `POST /api/settings/proxy/test` | 已登录 | 仅测试请求体中的无认证代理草稿，目标固定为官方 robots.txt；返回 HTTP 与浏览器各自的安全三态，不保存草稿、不接受任意 URL。 |
| `POST /api/products/search` | 已登录 | 名称只在服务端保存的默认区搜索官方候选，不允许浏览器覆盖默认区。 |
| `POST /api/products/resolve-link` | 已登录 | 按地区官方主机和路径白名单解析单个 HTTPS 链接。 |
| `POST /api/products/resolve-regions` | 已登录 | 按已保存启用地区解析跨区候选；必要时用本地 Playwright 处理最多三个日区升级包。只读，不创建订阅。 |
| `POST /api/products/preview-sources` | 已登录 | 返回逐区官方价格 ID 状态和来源提示，不写业务数据。 |
| `POST /api/products/confirm-subscriptions` | 已登录 | 每项可附带修剪后 1–120 字符的 `displayNameZhCn`；路由只收窄 JSON 形状/长度，保存前仍重新验证官方身份并由词条优先级裁决。一个 PostgreSQL 事务批量创建，任一失败零写入。 |
| `GET /api/game-names?status=pending` | 已登录（受限本机旁路例外） | 返回仍缺少确认简体中文显示名的公开管理字段；仅显式回环本机旁路可免 Cookie。 |
| `POST /api/game-names/backfill` | 已登录（受限本机旁路例外） | 仅用精确身份词条回填空名称，返回实际更新游戏 ID 与剩余数量；不覆盖已有人工名称。 |
| `POST /api/game-names/suggestions` | 已登录（受限本机旁路例外） | 按官方标题、发行商与商品类型的精确身份返回已确认词条或 `null`；候选键只用于 UI 关联，建议不创建游戏或词条。 |
| `POST /api/game-names/ai-suggestions` | 已登录（受限本机旁路例外） | 仅将标题、可空发行商、商品类型和不含 URL 的短批内候选键发送给已配置且可解密的 DeepSeek；返回同数目的待确认常用简体中文名称建议及置信度，不创建或更新游戏、词条或订阅。配置缺失、损坏或主密钥不可用时固定返回 `503 AI_NOT_CONFIGURED`。 |
| `PATCH /api/game-names/:gameId` | 已登录（受限本机旁路例外） | 为任一已存在游戏保存或更正 1–120 字符名称及受控来源/HTTPS 证据；复用范围只取其已保存的精确官方身份，只有管理员显式选择时才建立未来复用词条。 |
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

## 4. 简体中文名称边界

- 名称目录身份由规范化官方标题、发行商和商品类型精确组成；浏览器的 `candidateKey` 只关联建议响应，不能成为目录键、游戏 ID 或订阅身份。
- `POST /api/game-names/suggestions` 只返回已有已确认词条或 `null`，不创建词条、游戏或订阅。向导即使取得建议，当前唯一选中的官方候选仍必须提交非空名称；最终确认服务会以重新读取的官方锚点重算身份。
- `POST /api/game-names/ai-suggestions` 接受 1–10 项服务端收窄后的官方公开字段；向导只可在当前唯一选中的官方候选成功完成“核验其他地区”或“重新核验”后发起请求，搜索、候选选择、输入编辑、失败核验和其他自动流程均不得调用。候选键限制为 1–64 字符，官方标题为 1–200 字符，可空发行商非空时为 1–120 字符，三者均拒绝 C0/C1 控制字符且不能重复候选键。固定提示词只请求常用简体中文名称，要求保留本体、DLC、升级包、季票、合集和 Nintendo Switch 2 Edition 等版本后缀；已知或可合理翻译的名称返回文本，只有确实无法判断时才为 `null`。该结果始终是待管理员确认的草稿，不得声称官方确认或编造来源；`null` 保留既有手工填写路径，不追加网页搜索、在线翻译、重试或持久化。10 秒超时、网络或供应商失败固定返回 `503 AI_UNAVAILABLE` 与“AI 名称建议暂时不可用。”；结构异常、未知或重复响应键、低置信度和非法名称均按该候选降级为 `null`。DeepSeek 配置逐次解密后只对固定 `/chat/completions` 请求使用，地址严格为 `https://api.deepseek.com` 且拒绝重定向；Key、prompt 与供应商响应正文不记录、不返回浏览器。
- `POST /api/products/confirm-subscriptions` 对缺失词条只接受服务端验证过的管理员确认文本；AI 建议只是浏览器草稿，不能自动保存、发布或建立词条，未知名称也不得调用在线翻译或抓取网页。仪表盘和详情 API 返回可空 `displayNameZhCn`，页面只可将 `null` 渲染为“待补充中文名称”。
- 回填与人工更正会改变当前或未来游戏的展示名称，故五个名称管理接口在旁路关闭时强制验证 `session` Cookie；唯一免 Cookie 情形是进程已显式开启并由 Node 强制绑定回环的本机开发旁路。路由响应只暴露固定中文错误，不返回旧名称、SQL、证据网页、供应商正文或会话细节。

## 5. 手动刷新和调度边界

`POST /api/refresh` 是同步管理员操作：认证成功后记录最近请求时间，直接调用与六小时任务共享的采集服务，等待本轮完成后返回。当前实现不做 15 分钟冷却，不创建 `queued/running` 状态，也不由调度器消费。

自动任务不是 HTTP 端点。Node 进程使用 UTC 时钟和 PostgreSQL advisory lock 执行每分钟通知/日报与每六小时采集；未取得锁时立即跳过本轮。

## 6. 错误和静态资源

- 已知业务错误使用 `401/404/409/422/429` 和固定中文 `code/error`；未知数据库、网络、Telegram 或浏览器异常统一为不含内部细节的 `500`。
- `GET/HEAD` 非 API 请求先在构建静态目录内安全解析；路径穿越、重复编码和越根符号链接被拒绝，安全的客户端路由才回退 `index.html`。
- API 不存在时返回 JSON `404`，不能被 SPA 回退掩盖。
