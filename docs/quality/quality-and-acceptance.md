# 质量与验收策略

## 1. 状态

截至 2026-08-01，仓库唯一质量目标为 Node.js 22、PostgreSQL 17、本地 Playwright Chromium 与 Docker Compose。平台移除后的本地门禁、当前工作树 M1 生产运行时 Compose 和业务自动化分层证据已通过；公开发布、DS423+ 和真实外部样本仍待验收。

## 2. 自动化测试范围

| 范围 | 必验场景 |
| --- | --- |
| 数据源与回退 | 五区官方提供方注册、官方成功、官方失败且保留过期快照；未获准第三方来源只能返回“未接入”且不得创建网络提供方 |
| 价格规则 | 官方降价提醒、第三方降价不即时提醒、单区/全局目标价优先级 |
| 人民币与税费 | 当日汇率、过期汇率、美区未税/含税显示 |
| 消息 | 日报合并、每款商品的全区/单区历史最低价、超长分页、异常三连失败、恢复通知 |
| 认证 | 初始化一次性关闭、密码登录、限流、恢复码重置与单次失效；浏览器不持久化密码或恢复码，恢复码仅首次初始化时显示一次，确认后自动进入订阅；恢复成功必须返回登录，任一受保护请求 401 必须卸载并清空订阅向导；认证表单在 560px 以下保持单列且提示可被辅助技术读取。 |
| 导出 | CSV 字段正确，且绝不包含认证或 Telegram 敏感字段 |
| 官方 ID 与订阅前预览 | 日区官方 API 的地区、币种与价格 ID 响应错配被拒绝；其他地区官方 ID 未确认时明确显示 eShop Prices → NT Deals 回退；携带错误官方 ID 的来源链结果被拒绝；预览 API 仅允许管理员调用且不写入游戏、地区商品或订阅。 |
| 最终批量确认 | 任一重复地区或官方身份无效时业务表均不写入；两个游戏可在一批创建；规范化身份命中既有订阅时返回 `existing` 且不替换既有地区；所有新建记录由单个 PostgreSQL 事务提交。 |
| 官方订阅向导 | 候选搜索、链接解析、跨区匹配、来源预览与批量确认仅调用同源受保护 API；候选整卡可多选，香港确认键按“所选游戏 + 地区”隔离；有效促销才显示划线原价、现价和折扣，价格未知显示“价格待确认”；1280px 三列、768px 两列、480px 一列，选中态为暖色 3px 边框且文字保持可读。 |
| 多地区官方搜索与确认 | 固定官方响应夹具覆盖 US/MX/BR 各自索引、币种和 URL 白名单，HK 服务端 `software.items` 与数字 NSUID，JP 下载版数字 ID 映射；唯一严格匹配自动加入，同类型语言化/歧义候选必须人工选择，空集合或不可用才显示官方链接/跳过。确认服务必须按来源等级重新解析官方 URL，并在任一无效地区时保持 PostgreSQL 事务原子性；前端自动、候选、链接三态不得互相降级。 |
| 日区最终确认双 API 复核 | 日区确认必须以默认区锚点标题重查官方软件搜索记录，并要求下载版 URL/标题 ID 精确命中；官方价格 ID 必须确认 JP、JPY、在售及同一 ID。自动日区候选还须在同次官方结果中保持唯一严格或高置信度本地化身份；搜索、价格或唯一性失败均不得调用动态商品页回退或写入 PostgreSQL。 |
| 日区升级包本地 Chromium 集成 | 官方搜索根必须唯一满足 `upgrade: 1`、下载类型、同发行商/系列和 Switch 2 Edition；本地 Playwright 只接受唯一可见的日区官方升级链接，一批最多一个浏览器与三个串行隔离上下文，单项 30 秒且不自动重试。自动候选保存前必须重新证明关系；人工链接仅能在浏览器失败且官方 URL/价格有效时按 `manual_link` 兜底。所有路径必须关闭页面、上下文和浏览器，并禁止记录页面、Cookie、队列令牌、Session ID、截图、Trace 或异常堆栈。 |

## 3. 发布验收

### 历史证据解释

第 3.1 至 3.22 节按发生时间保留 Cloudflare、D1、旧 M1 控制轮次和早期 CI 的审计记录。它们只证明对应提交与环境，不能解释为当前仓库仍支持 Cloudflare，也不能替代平台移除后第 3.23 节记录的当前工作树证据；Docker Hub、NAS 与真实外部验收仍须单独完成。

### 3.1 已完成的生产基线验证（2026-07-17）

- 已创建项目专用的 Cloudflare D1 数据库并应用 `0001` 至 `0005` 五个版本化迁移；只验证表结构，不写入管理员、订阅、价格或 Telegram 数据。
- 已部署 Worker、同源静态前端、D1 `DB` 绑定与每分钟/六小时两个既有 Cron；公开 `GET /api/auth/status` 返回 `200` 及未初始化、未认证状态，首页返回 `200`。
- 此次验证刻意停在初始化前，避免自动化处理管理员密码或恢复码。后续由管理员在生产页面完成首次设置后，再按以下清单验证受保护流程。

1. 在独立测试环境应用并验证 D1 数据库迁移。
2. 验证 Telegram 测试消息、定时任务和日报调度逻辑。
3. 针对美、日、墨西哥、巴西、香港区至少各验证一个真实商品的价格采集。
4. 验证官方失败时保留过期状态；在第三方尚未获准时，设置中选中候选来源必须显示“未接入”且不发起请求。待获得逐站许可后，再单独验收第三方回退标记。
5. 应用 `0006` 迁移并部署生产后，在已登录会话执行一次受控手动刷新；确认当前请求返回完成统计、页面重新读取最新价格、`manual_refresh_requests` 仅保存冷却时间且六小时 Cron 不依赖该表。Telegram 未配置时不要求发送通知，也不得输入或记录任何凭据。

### 3.2 立即手动刷新生产验收（2026-07-17）

- 已在生产 D1 应用 `0006_immediate_manual_refresh.sql`，远程冷却表仅保留 `id` 与 `requested_at`，旧 queued/running 状态不再存在。
- 已部署包含同步刷新接口与页面回读的 Worker；固定六小时与每分钟 Cron 均保持启用。
- 在已登录管理员会话执行一次受控刷新后，远程 D1 写入 4 条价格快照，冷却时间记录为 `2026-07-17T12:11:27.121Z`；页面重新加载后显示两项美区官方价格及人民币估算。
- 此记录只证明两项美区样本的同步刷新链路；日区、墨西哥区、巴西区、香港区的真实来源仍须在各自有已确认商品时单独验收。未配置 Telegram 或第三方来源，过程未读取、输入或记录任何凭据。

### 3.3 设置驱动地区补全生产验收（2026-07-17）

- 已部署包含设置驱动地区补全面板的 Worker 版本 `06534e8f-bfe7-491e-8158-19a78c82d03e`，公开认证状态接口仍只返回初始化/认证布尔值，未暴露会话或管理员数据。
- 发布后发现 Cloudflare 边缘仍短暂缓存旧入口 HTML；使用唯一查询参数验证源站已引用新版带内容哈希的前端资源。已登录生产详情页随即显示“补全已启用地区”入口。该现象仅影响静态入口的新版本可见性，不改变 D1 中的订阅、价格、目标价或设置。
- 在五区均启用的生产设置下，对既有仅含 US 的《Overcooked! 2》Switch 2 升级包订阅执行一次只读“补全已启用地区”解析。JP、MX、BR、HK 均被安全地要求粘贴对应任天堂官方链接或显式跳过；页面未猜测商品身份，最终“确认补全”保持禁用，过程没有写入地区映射、价格快照、目标价或订阅状态。
- 后续管理员可在每区提供经过页面校验的任天堂官方链接，或明确选择跳过后，再单独确认最终原子补全；这一步会写入订阅数据，必须由管理员在页面中主动执行。

### 3.4 多地区官方搜索生产只读验收（2026-07-18）

- 本地固定夹具、160 项全量测试、类型检查、生产构建与空白检查均通过后，已部署 Worker 版本 `24c00eeb-8c19-48d4-b801-204d5364eaf2`；公开认证状态接口正常返回，未暴露管理员或会话资料。
- 在已登录的生产会话中确认设置启用了 US、JP、MX、BR、HK 五区，默认搜索区为 US。搜索并选择《Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack》后，MX 与 BR 显示“已自动匹配官方商品”，JP 与 HK 显示“请粘贴该区任天堂官方商品链接”。这证明浏览器没有扩展保存的地区范围，且每区均落入自动或安全链接兜底状态。
- 验收仅读取页面结果，未点击“确认订阅”或“确认补全”，因此未创建或修改订阅、地区映射、价格快照和目标价。全过程未读取、记录或导出 Cookie、密码、恢复码及 Telegram 凭据。

### 3.5 订阅硬删除与请求加载本地质量门禁（2026-07-18）

- Worker 测试共 55 个文件、170 项断言通过，覆盖受认证硬删除的原子性、既有软停用兼容性与未选订阅/全局数据保留。
- DOM 测试共 2 个文件、6 项断言通过，覆盖仪表盘多选不导航、确认前零删除、确认后概览重读，以及详情确认删除后返回仪表盘。
- TypeScript 严格检查、Vite 生产构建和 `git diff --check` 均已通过；本次只完成本地验证，没有部署 Worker、执行生产删除或读取任何管理员、Cookie、恢复码与 Telegram 凭据。

### 3.6 订阅硬删除与请求加载生产可用性验证（2026-07-18）

- 已部署包含仪表盘多选删除、详情删除和全局请求遮罩的 Worker 版本 `dc8ec6c6-3814-4dcd-b16d-3b1f202f5433`，生产地址为 `https://switch-price-monitor.cchccp.workers.dev`；D1 `DB` 绑定和每分钟/六小时两条既有 Cron 保持不变。
- 未携带会话的首页与 `GET /api/auth/status` 均返回 HTTP `200`。检查只验证公开可用性，不读取或输出管理员、Cookie、恢复码、Telegram 凭据、订阅或价格数据。
- 管理员明确授权现有订阅用于验收后，仪表盘选中《Overcooked! 2 - Gourmet Edition》与《Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack》，经二次确认后监控商品数由 3 变为 1；未选中的《Animal Crossing™: New Horizons – Nintendo Switch™ 2 Edition Upgrade Pack》保留。
- 随后在该剩余订阅的详情页进入“危险操作”，经二次确认后自动回到仪表盘；监控商品数与可用地区价格均为 0，并显示“还没有订阅”。两次操作均不读取、输出或记录 Cookie、恢复码、Telegram 凭据或被删除的原始价格历史。

### 3.7 跨语言地区商品高置信度识别本地质量门禁（2026-07-18）

- `test/official-product-discovery-service.test.ts` 先以美区 `Overcooked! 2 – Nintendo Switch 2 Edition` 和日区 `Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition` 建立失败用例；实现后唯一、同发行商、同类型且同版本标记的候选会得到 `automatic`，多个高置信候选仍返回人工选择与推荐数量。
- `test/subscription-wizard-page.test.tsx` 覆盖首屏只显示 Worker 推荐的日区候选、其余同类型官方候选在点击“显示更多官方候选”后才出现；界面折叠不会自动选择地区商品。
- 完整本地门禁结果为 Worker 55 个文件、172 项断言通过，DOM 3 个文件、7 项断言通过，TypeScript 严格检查、Vite 生产构建和 `git diff --check` 均通过。未部署 Worker，未读取、输出或修改生产会话、订阅、价格快照、恢复码或 Telegram 凭据。

### 3.8 跨语言地区商品高置信度识别生产只读验收（2026-07-18）

- 已部署 Worker 版本 `81e91452-b7a3-42ad-8e77-0e21dbcc171d`，生产地址保持为 `https://switch-price-monitor.cchccp.workers.dev`，D1 `DB` 绑定和每分钟/六小时 Cron 均未改变。
- 在已登录管理员会话中搜索 `Overcooked! 2` 并选择美区 `Overcooked! 2 – Nintendo Switch 2 Edition`，点击“核验其他地区”后，日区显示“已自动匹配官方商品”及 `Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition`。MX、BR、HK 同时保持各自官方自动匹配结果。
- 验收止于读取跨区核验结果；未点击“确认订阅”、未执行刷新或删除，因此没有创建或修改订阅、地区映射、价格快照、目标价或通知数据，也未读取、输出或记录 Cookie、密码、恢复码或 Telegram 凭据。

### 3.9 日区订阅确认官方 API 复核本地质量门禁（2026-07-18）

- 新增日区确认服务测试，覆盖同一官方搜索 URL 与官方价格 ID 同时成立、不同官方 URL、搜索或价格接口不可用、自动候选不唯一，以及人工选择仍需双接口复核的边界。
- 最终订阅确认测试覆盖美区英文与日区本地化 Switch 2 Edition 自动候选通过双 API 且不调用 JP 商品页解析器；日区 API 失败时返回安全提示并保持四张业务表零写入。
- 部署前的完整本地门禁结果为 Worker 56 个文件、179 项断言通过，DOM 3 个文件、7 项断言通过，TypeScript 严格检查、Vite 生产构建和 `git diff --check` 均通过；该阶段未读取、输出或修改生产订阅、价格、会话、密码、恢复码或 Telegram 凭据。

### 3.10 日区订阅确认官方 API 复核生产只读验收（2026-07-18）

- 已部署 Worker 版本 `08162419-7f93-49c5-b131-85b876bfaa5d`，生产地址保持为 `https://switch-price-monitor.cchccp.workers.dev`；D1 绑定和每分钟/六小时两条既有 Cron 均未改变，未执行任何迁移。
- 在已登录管理员会话中重新搜索 `Overcooked! 2`，选中美区 `Overcooked! 2 – Nintendo Switch 2 Edition` 后点击“核验其他地区”。日区显示“已自动匹配官方商品”及 `Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition`；MX、BR、HK 同时保持各自官方自动匹配结果。
- 验收止于只读搜索与跨区核验；未点击“确认订阅”、未执行刷新或删除，因而没有创建或修改订阅、地区映射、价格快照、目标价或通知，也未读取、输出或记录 Cookie、密码、恢复码或 Telegram 凭据。

### 3.11 港区官方关系 V 0.0.11 生产诊断与本地回归（2026-07-18）

- 已部署页面版本 V 0.0.11、Worker 版本 `08f90483-a06d-4ef2-8b51-5cb9bdcf1c76`；生产地址、D1 绑定和每分钟/六小时两条 Cron 均保持不变，公开健康接口返回正常。
- 在已登录管理员会话搜索 `Overcooked! 2`，选择美区 `Overcooked! 2 - Gourmet Edition` 并执行跨区核验。JP、MX、BR 自动匹配成功，但 HK 回退手工官方链接，因此 V 0.0.11 不能作为港区美食家版验收通过记录。
- 无 Cookie 只读检查确认，港区本体页面当前用 `serverFragment` 承载 `ApplicationItem`；Switch 2 本体的 `dlcItems.items` 还包含官方 `BundleItem`。旧实现只读 `fragment` 且把该列表全部当作 `DlcItem`，触发“任一根关系不完整则整批回退”的预期安全行为。
- 本地以测试先行新增两条回归：`serverFragment` 根解析和 `dlcItems.items` 混合 `BundleItem` 均先失败，最小修复后定向商品页测试 12 项全部通过。完整门禁随后通过 Worker 56 个文件、202 项测试，DOM 4 个文件、8 项测试，以及 TypeScript 严格检查、Vite 生产构建和 `git diff --check`。修复仍要求精确 HK URL、URL/NSUID 一致、明确 `DlcItem/BundleItem` 类型、唯一根、发行商、单层关系和每根最多 50 项；未知结构继续回退且零写入。
- 生产验收止于读取候选状态，没有点击“确认订阅”、刷新或删除，未创建或修改订阅、地区映射、价格快照、目标价或通知，也未读取、输出或记录 Cookie、密码、恢复码或 Telegram 凭据。修复需在提交、重新部署并复现同一只读流程后才能标记港区通过。

### 3.12 港区官方关系 V 0.0.12 生产只读验收（2026-07-18）

- 已部署页面版本 V 0.0.12、Worker 版本 `c7597121-c742-4d1b-8745-b07395b5c6ce`，生产地址保持为 `https://switch-price-monitor.cchccp.workers.dev`；D1 `DB` 绑定、每分钟调度与固定六小时采集 Cron 均未改变，公开健康接口返回正常。
- 在已登录管理员会话搜索 `Overcooked! 2`，选择美区 `Overcooked! 2 - Gourmet Edition` 并执行跨区核验。JP 自动匹配 `Overcooked® 2 - オーバークック２：真の食通エディション`，MX、BR、HK 均自动匹配 `Overcooked! 2 - Gourmet Edition`；HK 不再回退手工链接。
- 只读“价格来源预览”确认 JP 与 HK 显示“任天堂官方价格”；US、MX、BR 对该组合商品仍明确显示官方价格 ID 暂不可用，不以其他地区 ID 或推测金额冒充官方价格。
- 验收没有点击最终“确认订阅”、刷新或删除，未创建或修改订阅、地区映射、价格快照、目标价或通知，也未读取、输出或记录 Cookie、密码、恢复码或 Telegram 凭据。V 0.0.12 因此通过港区美食家版自动发现与官方价格链只读验收。

### 3.13 日区升级包 Browser Run 隔离可行性验证（2026-07-18）

- 探针在 `/tmp/switch-price-monitor-jp-browser-probe` 独立创建，临时 Worker 名为 `switch-price-monitor-jp-upgrade-probe`，只声明 Browser Binding 并通过 `wrangler dev --remote` 监听本机 `127.0.0.1:8791`；没有 D1、Cron、Static Assets、Secrets 或生产路由。执行结束后 Cloudflare API 返回该 Worker 不存在，确认未形成持久部署。
- 临时纯函数与 HTTP 适配器先经历预期 RED，再通过 2 个测试文件、13 项测试和 TypeScript 严格检查。为避免 Node 单元测试加载 `cloudflare:workers` 协议，纯 HTTP 适配器与 Cloudflare 专用装配入口保持文件隔离；该调整只存在于临时目录，未并入生产代码。
- 三次独立探测分别开始于 UTC `2026-07-18T15:45:23Z`、`15:46:05Z`、`15:46:42Z`，结果依次为 `{ status: "browser-launch-failed", elapsedMs: 4431 }`、`{ status: "browser-launch-failed", elapsedMs: 5532 }`、`{ status: "browser-launch-failed", elapsedMs: 4991 }`。相邻实例至少间隔 20 秒，没有追加第四次样本或覆盖失败结果。
- 机械验收结果为 `passed: false`。失败发生在 Browser Run 启动阶段，三次都没有进入任天堂页面导航，因此本记录不能证明任天堂日区详情页可达或不可达；它只证明当前 Wrangler 远程预览与账号环境没有达到已批准的三次成功门槛。
- 本轮不准进入 Browser Run 生产集成，日区搜索不到独立升级包时继续使用管理员手工粘贴任天堂官方链接。过程没有读取或保存页面 HTML、Cookie、localStorage、IndexedDB、排队令牌、截图、网络归档、异常堆栈或任何凭据，也没有修改生产 Worker、D1、Cron、订阅、价格历史或版本号。

### 3.14 日区升级包 Browser Run 启动修复与三次复验（2026-07-19）

- 受控诊断代码继续只存在于 `/tmp/switch-price-monitor-jp-browser-probe`，没有并入生产 `src/`、依赖或 Wrangler 配置。新增异常脱敏、浏览器生命周期和固定 HTTP 边界均先经历预期 RED，再通过 5 个测试文件、31 项测试和 TypeScript 严格检查；测试同时证明诊断入口不能接受任意 URL，错误不会携带堆栈、凭据或响应正文。
- 已确认首次三次 `browser-launch-failed` 的根因是版本协议断层：`@cloudflare/playwright` 1.3.0 使用 `/v1/devtools/browser/{sessionId}` 标准 CDP 路径，而 Wrangler 4.31.0 内置 Miniflare 只实现旧 `/v1/connectDevtools`。旧绑定对新路径返回普通 405，Playwright 对空 WebSocket 调用 `accept()`，与本地稳定复现的 `Cannot read properties of null (reading 'accept')` 完全一致。
- 临时探针只把 Wrangler 升级到与既有 `@cloudflare/workers-types 4.20260702.1` 精确兼容的 4.107.1（Miniflare 4.20260702.0），并把临时兼容日期收敛到该运行时支持且满足 Playwright CDP 门槛的 `2026-07-09`。本地 Chrome for Testing 下载发生一次 TLS 中断；对固定官方下载地址的 HEAD 请求返回 200，单次重试完成下载后，本地 `launch-only` 返回 `success/complete`。远程 `launch-only` 与固定 `https://example.com/` 导航随后分别以 1821 ms、4555 ms 成功。
- 第一次任天堂单次验证返回 `{ status: "invalid-official-url", elapsedMs: 6550 }`。只读官方页面证明升级入口为无末尾斜杠的 `https://store-jp.nintendo.com/item/software/D70050000064985`；纯函数回归测试先复现误拒绝，再把零个或一个末尾斜杠统一规范化为带斜杠 URL。HTTPS、精确主机、空端口、空凭据、固定路径层级、纯数字商品 ID、可见文字和唯一性规则均未放宽。
- 修复后单次验证成功。三次正式独立复验分别开始于 UTC `2026-07-18T16:36:55Z`、`16:37:41Z`、`16:38:28Z`，耗时 8257 ms、5987 ms、8047 ms；三次均只返回 `https://store-jp.nintendo.com/item/software/D70050000064985/`。公开关系卡当时同时显示价格 `700 円（税込）` 与 `30%OFF`，该金额只作为本次页面关系证据，不替代正式价格 API 或历史快照。
- 机械结果为 `count: 3`、`allSuccess: true`、`oneUrl: true`，满足原规格的三次可行性门槛。远程预览已终止，Cloudflare API 对 `switch-price-monitor-jp-upgrade-probe` 返回 Worker 不存在（10007），确认没有持久部署；生产 V 0.0.12、D1、Cron、订阅、价格历史和版本号均未改变。
- 最终回归重新运行生产项目 Worker 56 个测试文件、202 项测试，DOM 4 个测试文件、8 项测试以及 TypeScript 严格检查，全部退出为 0；临时探针 5 个测试文件、31 项测试和独立类型检查同样通过。注释一致性复核确认新增或修改的临时源代码、测试和配置均说明了职责、边界条件与安全原因。
- 本结果只允许进入 Browser Run 生产集成设计，不代表生产功能获批。正式接入前仍须单独确认调用时机、缓存、并发与费用、失败回退、二次官方校验、监控告警和页面结构变化处理；在该设计与实现完成前，现有管理员手工官方链接兜底继续保留。

### 3.15 日区升级包 Browser Run 生产设计验收（2026-07-19）

- 已确认在现有 Worker 增加 `BROWSER` Binding，只把 Browser Run 注入日区升级包发现与最终确认；不新增公开诊断接口、D1 表、缓存、Cron、后台队列或第二个 Worker。
- 候选核验采用同步全局加载、一个浏览器和最多三个全新无痕上下文串行执行；单项最多 30 秒、不自动重试、失败按商品独立降级，超过三个深度核验商品在浏览器启动前返回 `422`。
- 自动候选保存前必须再次证明唯一 `upgrade: 1` 根、唯一官方关系 URL 和 JP/JPY/在售/同 ID 价格；人工链接也先尝试浏览器，只有浏览器暂时失败且 URL/价格证据完整时才能保持 `manual_link` 写入。最终批量保存继续零部分写入。
- 配置锁定为 `@cloudflare/playwright 1.3.0`、Wrangler `4.112.0`、`@cloudflare/workers-types 5.20260714.1`、`nodejs_compat` 和 `BROWSER` Binding；实现须用全量 Worker/DOM/类型/构建测试及远程只读 Overcooked! 2 样本验收证明兼容性。
- 本节只记录已批准设计，不表示代码、提交或生产部署已经完成。生产部署仍须单独确认，届时按既有规则从 V0.0.12 升至 V0.0.13。

### 3.16 日区升级包 Browser Run 生产集成只读验收（2026-07-19）

- 提交 `f96d1b6` 至 `bf7e7e9` 已依次完成固定 Browser Binding、日区唯一升级根、任天堂官方报价、受限浏览器批处理、关系证据组合、向导接线与保存前二次验证。本轮重新运行 Worker 59 个测试文件、293 项测试，DOM 4 个测试文件、10 项测试，以及 2 项 Browser Binding/发布契约测试，全部通过；TypeScript、生产构建、差异空白与敏感信息扫描同样退出为 0。扫描命中只包含脱敏规则、协议说明、明确假测试值和扫描命令本身，未发现真实凭据、会话持久化或 Browser Session 记录代码。
- 经管理员授权使用 `wrangler dev --remote --port 8791` 连接远程 D1 与 Browser Run；对已由美区官方搜索确认的 `Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack` 执行两次相同的业务只读地区核验，一次验证真实向导状态，一次裁剪非渲染字段供审计。两次均返回 HTTP 200，端到端耗时位于 11–15 秒区间，单次请求没有自动重试。
- 日区结果为 `automatic`，规范化官方 URL 为 `https://store-jp.nintendo.com/item/software/D70050000064985/`，标题为 `Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition アップグレードパス`，币种为 JPY；任天堂官方价格 API 返回当前价 JP¥700、常规价 JP¥1,000。金额只作为本次候选证据，不写入价格历史。
- 每次请求都在返回前等待 page、context 与请求级 browser 的关闭链；生产使用 `launch` 会话且未配置 keep-alive 或跨请求复用，符合 Cloudflare Playwright 对 `browser.close()` 关闭 launch 会话的语义。验收仅记录关闭结论，不记录 HTML、Cookie、队列信息、会话标识、响应正文、截图、Trace、网络归档或异常堆栈。
- 业务验收没有调用最终确认、创建订阅、手动刷新、价格采集、Telegram 或部署端点，因此没有修改游戏、地区商品、订阅、价格快照、目标价或通知数据。管理员为访问受保护只读端点手动登录时创建了认证会话；该认证写入不扩大为任何业务数据授权。生产仍保持 V 0.0.12，下一步必须先提交本节文档，再单独取得 V 0.0.13 部署确认。

### 3.17 日区升级包 Browser Run V 0.0.13 生产部署验收（2026-07-19）

- 管理员单独确认生产发布后执行固定 `npm run deploy` 流程；脚本先把页面版本从 V 0.0.12 递增至 V 0.0.13，再完成生产构建与 Cloudflare 部署。生产 Worker 版本为 `dc31798e-7d40-4f4e-aadd-7b365246b7f1`，地址保持 `https://switch-price-monitor.cchccp.workers.dev`；D1 `DB`、Browser Run `BROWSER`、每分钟调度和固定六小时采集 Cron 均存在，未执行 D1 迁移。
- 发布前重新运行 Worker 59 个测试文件、293 项测试，DOM 4 个测试文件、10 项测试，以及 2 项 Browser Binding/发布契约测试，全部通过；TypeScript 严格检查、生产构建与 `git diff --check` 也以退出码 0 完成。发布后公开 `/api/health` 返回正常服务状态，公开前端资源和左侧导航均显示 0.0.13。
- 在已登录管理员会话中搜索美区 `Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack` 并执行只读跨区核验。MX、BR、HK 首次均自动匹配；JP 首次按设计独立降级为“暂不可用”，页面没有在同一请求内自动重试。管理员显式点击一次“重新核验”后，JP 返回 `automatic`，标题为 `Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition アップグレードパス`，同时保留其他三区的自动结果。
- 部署后验收共启动两次日区 Browser Run 请求；每次请求均由既有请求生命周期负责关闭，不启用 keep-alive 或跨请求复用。验收没有点击“确认订阅”、价格来源写入、手动刷新、删除或 Telegram，因此没有创建或修改订阅、地区映射、价格快照、目标价或通知；也没有读取或记录 Cookie、密码、恢复码、Browser Session 标识、页面正文、截图、Trace、网络归档或异常堆栈。

### 3.18 NAS Docker 静态合同与 M1 生产形态历史控制验收（2026-07-29）

- Docker 静态合同先因 Dockerfile、生产 Compose、env 示例和 PostgreSQL init hook 缺失得到有效 RED；实现后 `npm run test:docker-config` 共 14 项全部通过，覆盖 Node 22 Bookworm 多阶段构建、精确 Playwright Chromium、非 root/tini/健康检查、最小复制集、双架构无硬编码、app/postgres 两服务、唯一 HTTP host port、数据库内部 5432、固定应用版本、build context 排除和运行时秘密引用。
- 官方 `postgres:17` 的 `POSTGRES_USER` 会成为 bootstrap 超级用户，且 PostgreSQL 拒绝当前角色修改自身超级状态；因此未保留不可执行的“应用迁移自降权”方案。生产与开发 Compose 改用双角色：bootstrap 用户只存在于 postgres 环境，只读 init hook 在首次空数据目录内以单事务创建 `NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS LOGIN` 普通应用数据库所有者，app 只取得普通角色 URL。
- init hook 使用 psql `\getenv` 接收密码，避免密码出现在进程参数；动态角色、密码和数据库名分别经 `%I`/`%L` 引用，脚本不启用 xtrace、不输出凭据，并由 `bash -n` 通过语法检查。独立审查进一步要求 bootstrap/app 两个密码都在 psql 前验证非空且互不相同。系统化调试证明官方镜像对 Unix socket、`127.0.0.1` 与 `::1` 使用 trust，错误密码仍能连接；健康检查因此改为普通应用用户携带 `PGPASSWORD`、以 Compose 服务名 `postgres` 进入容器网络 SCRAM host 规则，并依据 `current_user` 验证登录与五项权限。实测正确密码退出 0 且 `inet_client_addr` 为容器网络地址，错误密码退出 2。
- `${POSTGRES_DATA_DIR}` 首次必须为空；官方入口对非空目录不会再次执行 hook，健康检查必须保持失败并阻止 app 启动。NAS 部署资产现包括生产 Compose、未提交 `.env`、`docker/postgres/init-app-role.sh` 与固定公开镜像；init hook 由 `.dockerignore` 排除，不进入 app 镜像层。
- 控制任务已独占构建 `linux/arm64` 镜像，大小约 546 MB，inspect 结果为 arm64 与默认用户 `10001:10001`。临时生产 Compose 中 app/postgres 均 healthy，app 实际 UID 为 10001，PostgreSQL host bindings 为空；容器内 Chromium loopback 成功完成启动、导航与清理。
- 同一临时栈从空库完成首次管理员初始化、登录和设置读取，restart app/postgres 后 initialized 状态仍保持；普通数据库角色的 `rolsuper`、`rolcreaterole`、`rolcreatedb`、`rolreplication`、`rolbypassrls` 全部为 false。
- 最终门禁通过完整测试 78 个文件、435 项，DOM 4 个文件、16 项，Docker 合同 14/14，以及 TypeScript、双生产构建与 `git diff --check`。本验收没有发布 Docker Hub manifest，也没有连接或修改 NAS/Cloudflare 生产资源。

### 3.19 GitHub Actions CI 与标签发布合同验收（2026-07-29）

- 工作流合同测试先因 `.github/workflows/ci.yml` 与 `.github/workflows/release-image.yml` 均不存在得到单一有效 RED；实现后 9 项结构化 YAML 合同全部通过。测试使用直接、精确锁定的 `yaml` 开发依赖解析 job、service、step、permissions 与 inputs，不把脆弱正则当作工作流结构；仅中文注释一致性这种不可执行的人类约束读取注释文本。
- 普通分支 push 与 pull request 使用 `contents: read` 最小权限，在 PostgreSQL 17.10 临时 service 上执行完整 Vitest/PostgreSQL 集成测试、DOM、真实 Chromium 生命周期烟雾测试、TypeScript、生产构建、Docker/Compose 合同、工作流合同、中文注释、空白和 Gitleaks 秘密扫描，再以 Buildx 验证 `linux/arm64,linux/amd64`。空白门禁显式检查 PR base 或 push before 到 head 的已提交差异，首次 push 安全退化为当前提交；标签路径检查标签目标提交，不依赖 checkout 后必然干净的工作区。该路径没有 Docker Hub login、push、Secrets 引用或 `latest` 标签。
- 标签工作流只监听 `v*`，但在任何 Docker Hub 登录前还必须把 `github.ref_name` 严格验证为无前导零的 `vX.Y.Z`。本地 shell fixture 已证明 `v1.2.3` 生成 `1.2.3`、`1.2`、`sha-0123456789ab` 和 `latest`，并拒绝普通分支名、不完整版本、预发布后缀和前导零版本。
- 发布 job 必须依赖同一提交重新完成的完整 quality job，且只读取 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN` 两个 GitHub Repository secrets。登录令牌仅进入固定 SHA 的官方 Docker login action password input，不由 shell 输出、构建参数、缓存或 OCI 标签传递。
- 发布镜像固定同时构建 `linux/arm64,linux/amd64`，并附加 source、revision、version、created 四项 OCI 可追溯元数据。npm 缓存由 lockfile 驱动，Buildx 缓存 scope 同时包含 `package-lock.json` 与 `Dockerfile` 哈希；所有缓存都排除 PostgreSQL 运行数据、浏览器 profile、Cookie 与秘密。
- checkout、Node、QEMU、Buildx、Docker login 和 build-push 均固定到经官方版本标签核对的 40 位提交 SHA；Dockerfile 三个外部基础阶段统一固定 `node:22.20.0-bookworm-slim`，PostgreSQL service 固定到 `postgres:17.10-bookworm`。Gitleaks 固定为 8.30.1，并在执行前验证官方 linux_x64 归档 SHA-256。任何升级都必须同时修改可信 pin 合同并重新审查。
- 最终本地门禁通过完整测试 78 个文件、435 项，DOM 4 个文件、16 项，独立 Chromium 生命周期 4 项，Docker 合同 14/14，工作流合同 9/9，以及 TypeScript、生产构建、中文注释、`git diff --check` 和 actionlint 1.7.12。M1 Docker Desktop 还以 cache-only 方式实际完成 `linux/arm64,linux/amd64` 双架构构建，两个平台均走完固定 Node 基础、npm ci、生产构建、Playwright Chromium 和非 root 运行层；未登录或推送镜像。
- 本轮只创建和本地验证工作流，没有配置、读取或打印真实 Docker Hub Secrets，没有登录 Docker Hub、推送 manifest、创建 Git 标签或更新 `latest`。首次公开发布仍需管理员另行确认精确语义版本。
- 独立审查随后发现两个 quality job 错把 runner host PostgreSQL 映射与连接串设为 `5432`，这会被 `requireTestDatabaseUrl()` 的破坏性测试安全守卫确定性拒绝；两份工作流现均明确映射 `54329:5432` 并连接 `127.0.0.1:54329`，与唯一允许的临时 `switch_test` 目标一致。合同先得到端口 `5432:5432` 与期望 `54329:5432` 的 RED，修复后以结构化 YAML 精确检查 service 映射、连接串及守卫值。
- 同次审查还以真实临时 Git merge commit fixture 证明原发布空白命令漏过只存在于 merge 父差异的尾随空格；发布 workflow 已使用 `git diff-tree -m --check --root -r` 展开每个父提交，fixture 直接执行 workflow 精确 shell 后通过。普通 CI 合同现在同时拒绝 `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN` 与任意 `${{ secrets.* }}` 表达式。`npm run test:github-actions` 本轮实际为 9/9，工作流中文注释合同、actionlint 和最终空白检查均通过。
- 最终权限审查明确区分 Docker Hub 身份能力：Team/Business 组织可用 OAT 对单一 `switch-price-monitor` 仓库授予 Image Pull/Push；免费/个人 PAT 原生只有 Read/Write/Delete、没有单仓库授权，因此必须使用只拥有目标公开仓库的专用 Docker ID，并创建不含 Delete 的 Read/Write PAT。`DOCKERHUB_USERNAME` 对应专用 ID 或组织 namespace，token 必须与该身份匹配；工作流的 `${DOCKERHUB_IMAGE}@push` login scope 只限制凭据注入 Buildx 的目标 push 路径，是纵深防御而非改变 PAT 本身权限。
- 同仓库 release workflow 现使用 `release-${{ github.repository }}` 全局不可取消队列，并在完整历史 checkout 后、Docker Hub 登录前直接遍历严格 `vX.Y.Z` 标签，只允许仓库最高语义版本继续。合同以真实临时 Git 仓库证明 `v1.2.3` 在 `v1.2.4` 已存在时失败、`v1.2.4` 通过；队列与最高版本守卫共同防止旧流程回退 `X.Y`/`latest`，不依赖 GitHub 未承诺的排队顺序。最终工作流合同实际为 9/9。

### 3.20 PostgreSQL 登录失败状态并发竞态回归（2026-07-30）

- Task 10 提交前完整门禁曾在 435 项测试中的并发登录用例暴露“登录资格锁定未返回状态”；隔离重复运行再次复现，确认是成功登录删除 `login_attempts` 与等待事务执行 `DO NOTHING` 后再读取之间的真实竞态，而非断言噪声。
- 新增真实 PostgreSQL 确定性事务协调测试，在旧两语句实现下稳定得到预期 RED；改用单条 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` 后，错误登录稳定返回无效凭据并进入新的第一次失败窗口，合法登录会话仍原子提交且只保存摘要。
- 缺行竞态与“并发五次错误后正确密码锁定”组合连续 20 次通过；本轮完整 Vitest 为 78 个文件、435 项，DOM 为 4 个文件、16 项，独立 Chromium 生命周期为 4 项，Docker 合同为 14/14，工作流合同为 9/9，工作流中文注释为 1/1，且 TypeScript、生产构建、actionlint 1.7.12、`git diff --check` 与 `linux/arm64,linux/amd64` cache-only 双架构构建均通过。过程未读取或输出真实密码、哈希、盐、恢复码、Cookie、数据库凭据或 Docker Hub Secrets，也未推送镜像、创建标签或修改 NAS/Cloudflare 资源。
- 后续 Task 10 独立复验已让两份 CI quality job 的本机临时 PostgreSQL 端口与本竞态回归所用 `requireTestDatabaseUrl()` 安全守卫精确统一为 `54329`，因此 CI 不会在执行真实 PostgreSQL 回归前因错误目标被拒绝。该修正没有修改认证源码、竞态测试、迁移或凭据边界；工作流合同仍为实际 9/9。
- 最终发布安全修正只涉及 release 身份 scope、凭据说明、全局串行与最高严格语义版本守卫，没有修改本 PostgreSQL 竞态实现或回归用例；真实 Git tag fixture 与工作流合同仍为 9/9，首次真实标签发布继续等待管理员单独确认。

### 3.21 GitHub Actions PostgreSQL 双角色初始化修复（2026-08-01，本地回归及远程数据库门禁通过）

- 远程 run `30510098237` 在 435 项中通过 434 项；唯一失败显示 `switch_test` 的 `rolsuper`、`rolcreaterole`、`rolcreatedb`、`rolreplication`、`rolbypassrls` 均为 true。根因是官方 PostgreSQL 镜像把 `POSTGRES_USER` 建成 bootstrap 超级用户，而不是 PostgreSQL 测试随机失败；本地 Compose 已用独立 `switch_test_admin` 再由 init hook 建立普通应用角色。
- 合同测试先行得到有效 RED：`npm run test:github-actions` 的 9 项中 7 项通过、2 项失败；普通 CI 精确步骤序列缺少 `initialize_postgres_role`，发布 quality job 的 `POSTGRES_USER` 实际为 `switch_test` 而非 `switch_test_admin`。YAML 解析、工作流文件加载和既有无关合同均正常，因此失败精确覆盖本次权限模型缺口。
- 最小修复让普通 CI 与发布 quality job 都以 `switch_test_admin`/独立临时假密码引导 `switch_test`，健康检查只验证已存在的管理角色；checkout 后、测试前通过 `job.services.postgres.id` 向 service 容器执行既有 `docker/postgres/init-app-role.sh`，并经 GitHub service 网络别名 `postgres` 进入 SCRAM host 规则，以应用连接确认可登录且五项集群权限均为 false。没有内联复制角色 SQL；仅 runner 测试 URL 保持受守卫的 `switch_test@127.0.0.1:54329`，不得与容器内自检的网络入口混淆。
- GREEN 实际结果：`npm run test:github-actions` 为 9/9，`npm run test:workflow-comments` 为 1/1，`actionlint .github/workflows/ci.yml .github/workflows/release-image.yml` 与 `git diff --check` 均以 0 退出。新增/修改的测试与 workflow 注释均复核为说明了官方 bootstrap 语义、临时假值边界、初始化时序、TCP 身份验证和最小权限安全原因，且与实现一致。
- Docker Desktop 恢复后，`docker info --format '{{.ServerVersion}}'` 返回 29.6.2；`docker compose -f docker-compose.dev.yml up -d postgres` 后专用 PostgreSQL 为 healthy，且仅映射 `127.0.0.1:54329->5432/tcp`。完整本地门禁实际通过：Vitest 78 个文件、435 项；DOM 4 个文件、16 项；Chromium 生命周期 1 个文件、4 项；Docker 合同 14/14；Actions 合同 9/9；工作流中文注释 1/1；`npx tsc --noEmit`、`npm run build`、actionlint 与 `git diff --check` 均以 0 退出。
- 本轮没有真实秘密、Docker Hub 登录或镜像推送、Git 标签、NAS 或 Cloudflare 写入。远程 run `30685133376` 已证明本节数据库修复及其后续测试通过，但完整 quality job 随后被既有 Gitleaks 历史命中阻止；整体 CI 状态由下一节继续记录，不能把数据库门禁通过误写成完整 CI 通过。

### 3.22 Gitleaks 精确历史基线修复（2026-08-01，本地与远程完整门禁通过）

- 提交 `5fa2c06` 触发的远程 run `30685133376` 已通过 PostgreSQL service 初始化、普通角色 SCRAM 权限自检、435 项 Vitest、16 项 DOM、4 项 Chromium、类型检查、生产构建、Docker/Actions/注释合同与空白检查；这证明原 434/435 权限失败已修复。随后 Gitleaks 扫描 161 个提交并报告七个命中，质量 job 因此失败，QEMU、Buildx 与双架构镜像构建均按安全边界没有启动。
- 使用与 CI 相同的 Gitleaks `8.30.1`，并以官方 checksums 文件校验 M1 对应归档后，本地完全复现七个历史命中：两项来自源码中已注明为任天堂官网公开只读搜索配置的同一值，五项来自认证实施计划中的固定测试密码样例；报告全程使用 100% 脱敏，未把命中原文写入日志、文档或基线。
- 合同测试先得到有效 RED：10 项中 8 项通过，扫描步骤缺少显式基线路径且 `.gitleaksignore` 不存在。最小修复新增只含七个 `提交:路径:规则:行号` 精确 fingerprint 的根目录基线，并让普通 CI 与发布 quality job 以 `${GITHUB_WORKSPACE}/.gitleaksignore` 锚定文件；没有按规则、整份文件或正则扩大例外，也不受 runner 当前目录漂移影响。
- GREEN 实际结果：Actions 合同 10/10、中文注释合同 1/1、actionlint 与 `git diff --check` 均退出 0；同版本 Gitleaks 再次扫描 161 个提交得到 `no leaks found`。额外的临时高熵假令牌不在基线中，扫描仍报告一项命中并退出 1，证明精确历史基线不会吞掉未来新增秘密。
- 提交 `af62ea7` 触发的 [远程 run `30685670944`](https://github.com/Maxkinger/Switch_Price_Monitor/actions/runs/30685670944) 在 10 分 25 秒内完整通过：双角色 PostgreSQL 初始化与 SCRAM 权限自检、435 项 Vitest、16 项 DOM、4 项 Chromium、类型检查、生产构建、Docker/Actions/注释/空白合同、Gitleaks 161 提交全历史扫描、QEMU、Buildx 以及 `linux/arm64`/`linux/amd64` 镜像构建均成功。该普通 CI 只验证双架构构建，没有登录 Docker Hub、创建标签或推送镜像。
- 本次没有修改历史提交、暴露命中值、关闭 Gitleaks 规则、登录 Docker Hub、创建标签、推送镜像、访问 NAS 或写入 Cloudflare；首次真实标签发布继续等待用户单独确认。

### 3.23 Task 11 平台移除后的当前证据（2026-08-01）

- 生产源码、测试、依赖、构建配置、运维脚本和工作流中的旧 Cloudflare 运行入口已移除；历史文档允许保留平台背景。Docker/平台合同新增嵌套 lockfile 合成依赖检查及 `docker/`、PostgreSQL 迁移目录覆盖后，均先得到有效 RED，再修复并以 19/19 通过，避免旧平台包或运行符号从嵌套依赖与部署资产回流。
- 当前本地完整业务门禁为 Vitest 69 个文件、420 项通过；DOM 16 项通过；真实本地 Chromium 生命周期 4 项通过；TypeScript 严格检查和客户端/Node 生产构建通过。
- 最新已知成功的普通 CI run `30686052256` 对应平台移除前提交。它可证明当时的 PostgreSQL、秘密扫描和双架构构建门禁，但不能证明当前未提交工作树或未来发布标签。当前提交必须重新跑远程 CI。
- 当前工作树在 M1/arm64 构建 `switch-price-monitor:task11-m1-local` 后，以唯一临时 Compose project 和全新 bind mount 启动生产定义。app/postgres 均健康；app 的运行身份为 `10001:10001`，唯一宿主映射为临时 HTTP `33080 -> 3000`，postgres `5432` 没有宿主绑定。健康 API与静态首页、首次初始化、`HttpOnly; SameSite=Strict` 且 LAN HTTP 无 `Secure` 的 Cookie、登录/退出、一次性恢复码改密、设置更新、app 重启持久化和五次失败后的 `429 LOGIN_LOCKED` 均通过。这是生产运行时/装配冒烟，不宣称发现、通知等 fake 外部边界也在该容器中运行。
- 同一 arm64 镜像在 `--network none`、非 root、`cap_drop=ALL` 与 `no-new-privileges` 下完成 Chromium data URL 启停冒烟。发现 fixture、订阅事务、历史/导出、手动刷新 fixture、调度锁和 Telegram fake transport 由同一工作树的 420 项 Vitest 分层验证；它们与 Compose 冒烟共同构成当前 M1 本地证据，但不等同于真实任天堂或 Telegram 端到端演练。
- 独立 PostgreSQL 17 备份恢复集成门禁新增显式绝对 `--env-file`、任意 cwd 与 16 张 public 表精确集合校验后重新运行 14/14；缺少非抽样必需表的 archive 会清回空库。通过后各自唯一临时容器、网络、数据库和归档均由受控清理移除；未读取既有项目 `.env` 或数据库，也未使用真实认证或 Telegram 凭据。
- Docker Hub Repository Secrets 尚未配置，`v0.1.0` 尚未创建，公开双架构镜像尚未发布；标签推送必须另行确认。
- DS423+ 没有部署，真实 Telegram/Nintendo 样本没有运行，线上 Cloudflare 资源没有停止或删除。Cloudflare 退役必须在 NAS 等价、备份恢复与回滚验收后取得独立授权。

## 4. 验收原则

- 不把“请求成功”当作“价格正确”：必须通过商品身份校验。
- 不把地区价格 ID 当作跨区通用编号：官方 API 返回价格时必须再次与已确认的本区 ID 比对；US、MX、BR、HK 只接受本区官方 JSON-LD，缺少可验证价格时记录过期状态，不猜测第三方补值。
- 不把第三方价格当作官方确认价格：来源必须可见，且不触发即时降价提醒。
- 任何测试、日志、导出和错误页面都不得泄露凭据。
- 当前唯一支持路径是 Node.js 22 + PostgreSQL 17 + 本地 Playwright；历史 Worker/D1 验收不得作为当前工作树或 NAS 的替代证据。
- 手动刷新每次认证请求同步执行，无冷却、队列或调度认领；测试必须证明连续请求都进入采集服务并只记录最近请求时间。
- 会话 Cookie 必须保持 `HttpOnly; SameSite=Strict`；局域网 HTTP 明确 `COOKIE_SECURE=false`，可信 HTTPS 明确为 `true`，不得根据客户端可伪造的转发头自动降级。
- NAS 备份恢复门禁必须使用唯一 Compose project、显式绝对 env 文件与 mktemp 临时目录，控制端最新隔离验收为 14/14：任意 cwd/env 与路径边界；fresh/fixture；失败原子性；retention 上限、18 位 sequence、每库锁和跨库隔离；app running/paused；普通角色 owner、view、collation、文本搜索配置、publication 和 operator 等用户对象；截断 archive 的 single-transaction；容器 tmp 清理；镜像精确 manifest/checksum；16 张 public 表精确集合、管理员状态与共享 ACL 边界。checksum、表集合或管理员 post-validation 失败必须以显式目标库 typed cleanup 把本次恢复对象清回经同一 catalog 守卫证明的空库，并能立刻用合法归档重试；脚本不得使用会撤销其他数据库、表空间或配置参数授权的角色级清理命令，测试必须保留共享表空间显式 ACL 哨兵。任何子命令 stderr 都不得回显容器秘密。
- 本地界面验收应在已登录管理员会话下覆盖真实官方候选、跨区选择、香港官方链接核验、来源预览和最终确认；未登录状态只能验证页面渲染与 `401` 安全拦截，不能代替写入链路验收。
- 认证入口界面验收必须覆盖首次设置、地区与默认搜索区约束、一次性恢复码确认后的自动登录、恢复密码后返回登录、重新登录以及撤销会话后由受保护请求触发的安全回退；任何临时密码、恢复码、Cookie 或一次性 PostgreSQL/Compose 测试数据不得进入 Git、日志、截图或文档。
- 永久删除的生产人工验收已在管理员明确授权的既有订阅上覆盖仪表盘多选与详情删除入口。未来回归仍须先取得管理员对具体订阅的明确授权，并验证确认被拒绝、`404` 与 `401` 均不得删除其他订阅或全局数据；全程不得将真实会话或价格历史复制到日志与文档。
