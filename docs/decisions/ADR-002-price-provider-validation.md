# ADR-002：价格来源的验证边界与准入规则

| 项目 | 内容 |
| --- | --- |
| 状态 | 已确认边界，适配器准入待分区验证 |
| 日期 | 2026-07-16 |
| 决策 | 任天堂官方优先；eShop Prices 和 NT Deals 作为默认候选回退来源；Deku Deals、Green Pipe 仅作为设置页可选来源，在通过覆盖范围、请求方式和条款审查前不启用生产采集。 |

## 背景

本项目需要监控美国、日本、墨西哥、巴西、香港五区的完整游戏、DLC 和升级包。价格来源不能只“能搜索到页面”，还必须能在 Worker 服务端稳定取得价格、原始货币、标题、发行商和商品类型，并能在站点变化时安全回退。

## 验证方法与时间

验证日期：2026-07-16。样本为《Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack》。本次验证只读取公开页面和搜索索引，不登录 Nintendo Account、不使用 Cookie、不创建购买记录，也不向 D1 写入价格。

| 来源 | 已观察证据 | 准入结论 |
| --- | --- | --- |
| 任天堂美国区 | 对官方升级包 URL 发出无 Cookie 的 `GET`，HTML 中的 `application/ld+json` `Product/Offer` 包含标题、Team17、`USD`、`price: 9.99`；页面嵌入数据还含 `isUpgrade: true`。 | 已通过 US 样本验证。Worker 解析公开 JSON-LD 的 `name`、`publisher.name`、`offers.priceCurrency` 和 `offers.price`，再以标题识别 Upgrade Pack；请求 15 秒超时，不携带账号或 Cookie。 |
| 任天堂日区 | [日区 Nintendo Switch 2 Edition 页面](https://store-jp.nintendo.com/item/software/D70010000106252/)可确认 Team17、Nintendo Switch 2 与升级通行证入口；该入口指向 `D70050000064985`，无 Cookie 访问会进入要求启用 JavaScript 的排队页，未返回可解析的价格或结构化 Offer。 | 身份信息部分可观察，但公开 Worker `GET` 不满足原始价格字段准入；不得接入现有 JSON-LD 适配器。后续仅可在取得允许的公开价格接口或专用适配器验证后启用。 |
| 任天堂墨西哥区 | [墨西哥区公开商品页样本](https://www.nintendo.com/es-mx/store/products/overcooked-2-campfire-cook-off-70050000010882-switch/)能确认 Team17 与关联的 Nintendo Switch 2 Edition，但升级包价格位置仅显示 `Loading`；本轮未检索到升级包自身同时含 MXN、标题及类型的公开响应。 | 不通过官方来源准入。不得从关联 DLC、搜索摘要或动态占位文本推导升级包 MXN 价格；维持官方失败后第三方回退的边界。 |
| 任天堂巴西区 | [巴西区 Nintendo Switch 2 Edition 页面](https://www.nintendo.com/pt-br/store/products/overcooked-2-nintendo-switch-2-edition-switch-2/)明确提供“Pacote de Melhoria”版本选择、Team17 与升级包身份，但价格链接为动态 `ec.nintendo.com` 内容，静态公开页仅返回 `Loading`。 | 身份可验证、价格不可由当前无 Cookie HTML 解析器取得；不得把页面标题或其他 DLC 的 BRL 价格作为升级包价格。需要单独验证公开价格接口及其条款后才能启用。 |
| 任天堂港区 | [任天堂香港产品公告](https://www.nintendo.com/hk/topics/article/5Jv6XsFzdrMn9E1AikxJJc)确认该作品提供 Nintendo Switch 2 Edition／升級通行證；公开检索仅得到旧 DLC 的 `ec.nintendo.com/HK` 页面，未找到升级包自身包含 HKD 和可校验身份字段的响应。 | 不通过官方来源准入。不能从公告或同一作品 DLC 页面推测港币价格；等待升级包的公开地区商品页或经审核的替代来源。 |
| eShop Prices | [样本页](https://eshop-prices.com/games/20690-overcooked-2-nintendo-switch-2-edition-upgrade-pack?currency=KRW) 显示标题、Team17、Japan/Brazil/United States/Mexico 等地区条目，并声明页面价格含税。 | 默认候选回退；接入前必须验证港区覆盖、原始本币字段和使用条款，不能把页面换算货币误存为本币。 |
| NT Deals | [美国区样本](https://ntdeals.net/us-store/game/1055028/overcooked-2-nintendo-switch-2-edition-upgrade-pack)、[墨西哥区样本](https://ntdeals.net/mx-store/game/1055138/overcooked-2-nintendo-switch-2-edition-upgrade-pack)、[巴西区样本](https://ntdeals.net/br-store/game/1055101/overcooked-2-nintendo-switch-2-edition-upgrade-pack) 给出分区商品 ID、升级包标题及 USD/MXN/BRL 原始价格。 | 默认候选回退；稳定代码使用 `nt-deals`（先前需求中“NTPrices”为站点名称误记）。日区、港区覆盖、请求频率和使用条款仍需上线前审计。 |
| Deku Deals | 本轮未取得覆盖五区升级包的公开、可验证请求形态。 | 保持可选且默认关闭；取得书面/公开使用许可、地区覆盖和身份字段后才可启用。 |
| Green Pipe | [公开页面](https://checkgreenpipe.com/switch-vs-steam) 证明其可展示 Switch 与 Steam 价格比较，但本轮未验证地区商品身份、五区覆盖或可复用请求形态。 | 保持可选且默认关闭；不得以该页面推断其可作为五区价格采集源。 |

## 已实现的技术边界

1. `ProviderChain` 只按管理员设置的顺序在 Worker 端调用来源；浏览器不直接访问任何商店或第三方站点。
2. 每个来源请求最多 15 秒；仅 `ProviderNetworkError` 可重试一次，之后按顺序回退。
3. 结果必须同时匹配已确认的来源、原始货币、规范化标题、发行商（若已确认）和商品类型；任一不符即拒绝写入。
4. 来源标签随快照保留。后续规则层只能让 `official` 快照触发即时降价；第三方快照仅供页面和日报展示。
5. 全部来源失败时，上层保留上一条成功快照并标记过期，不制造推测价格。
6. 任天堂美国区适配器已实现并有离线 JSON-LD 解析测试；它不硬编码价格，也不在客户端读取商店页面。

## 上线前准入清单

- 针对 US、JP、MX、BR、HK 各选一个真实商品，以服务端请求验证标题、发行商、商品类型、原始货币、当前价和常规价字段。
- 记录请求 URL/参数、响应字段、访问频率限制、超时行为及条款审查日期；不得记录 Cookie、账号或购买数据。
- 在测试 D1 环境执行一次受控采集，确认身份校验失败不会写入快照，官方失败时第三方标签可见。
- 如果任一站点需要浏览器自动化或认证 Cookie，先更新 ADR 并单独评估 Cloudflare Browser Rendering 或替代数据源，不把该依赖隐式加入 Worker。

## 后果

- 首版不会承诺所有五区从第一天就有官方自动价格；未通过准入的地区会清楚显示第三方来源或过期状态。
- 页面设置可展示候选来源，但只有通过本 ADR 准入检查的来源才可默认启用。
- 该决策避免把站点搜索索引、用户浏览器会话或转换货币误当成可靠的价格 API。
