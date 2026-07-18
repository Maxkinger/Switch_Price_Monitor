# ADR-002：价格来源的验证边界与准入规则

| 项目 | 内容 |
| --- | --- |
| 状态 | 已确认；五区官方采集链路已实现，第三方实际回退待来源许可 |
| 日期 | 2026-07-17 |
| 决策 | 任天堂官方优先。eShop Prices、NT Deals、Deku Deals、Green Pipe 可在设置中列为候选来源，但在逐站取得 API 或书面许可、完成覆盖与条款审查前，生产代码不创建第三方提供方，也不发起第三方网络请求。 |

## 背景

本项目需要监控美国、日本、墨西哥、巴西、香港五区的完整游戏、DLC 和升级包。价格来源不能只“能搜索到页面”，还必须能在 Worker 服务端稳定取得价格、原始货币、标题、发行商和商品类型，并能在站点变化时安全回退。

## 验证方法与时间

验证日期：2026-07-16。样本为《Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack》。本次验证只读取公开页面和搜索索引，不登录 Nintendo Account、不使用 Cookie、不创建购买记录，也不向 D1 写入价格。

| 来源 | 已观察证据 | 准入结论 |
| --- | --- | --- |
| 任天堂美国区 | 对官方升级包 URL 发出无 Cookie 的 `GET`，HTML 中的 `application/ld+json` `Product/Offer` 包含标题、Team17、`USD`、`price: 9.99`；页面嵌入数据还含 `isUpgrade: true`。 | 已通过 US 样本验证，且 US 官方 JSON-LD 适配器已注册。Worker 解析公开 JSON-LD 的 `name`、`publisher.name`、`offers.priceCurrency` 和 `offers.price`，再以标题识别 Upgrade Pack；请求 15 秒超时，不携带账号或 Cookie。 |
| 任天堂日区 | [日区 Nintendo Switch 2 Edition 页面](https://store-jp.nintendo.com/item/software/D70010000106252/)在完整浏览器中可确认 Team17、Nintendo Switch 2 与升级通行证入口，目标为 `D70050000064985`；普通 Worker `fetch` 只取得缺少该关系的 JavaScript 排队页。公开软件搜索 API 仅为完整版返回 `upgrade: 1`，不返回升级包 ID；价格 API 能分别验证已知完整版和升级包 ID 的 JP/JPY 价格，但不返回父子关系。软件搜索 API 另可返回美食家版组合商品 `DL_DLC` ID `70070000010202`，其公开价格接口响应为 JP/JPY、常规 ¥4,900、促销 ¥1,225。 | 静态 HTML 解析器不适用，`upgrade: 1` 和价格 API 也不能单独发现升级包 ID。当前仅批准独立 Cloudflare Browser Run 探针对已知页面做三次只读可行性验证，不连接生产 D1、Cron 或订阅流程；三次均在 30 秒内唯一返回同一官方升级 URL后，才允许另写生产设计。普通游戏及已验证的 `DL_DLC` 组合商品继续使用搜索 API + 价格 API；人工确认的升级包链接只使用自己的 ID 做 JP/JPY/在售/同 ID 价格复核。不得把完整版 ID、`D` 前缀转换或已知样本映射当作升级包身份。 |
| 任天堂墨西哥区 | [墨西哥区公开商品页样本](https://www.nintendo.com/es-mx/store/products/overcooked-2-campfire-cook-off-70050000010882-switch/)能确认 Team17 与关联的 Nintendo Switch 2 Edition，但升级包价格位置仅显示 `Loading`；本轮未检索到升级包自身同时含 MXN、标题及类型的公开响应。 | MX 官方 JSON-LD 适配器已注册，但此样本尚未通过生产实测价格准入；不得从关联 DLC、搜索摘要或动态占位文本推导升级包 MXN 价格。当前安全结果是过期/不可用，不进行第三方回退。 |
| 任天堂巴西区 | [巴西区 Nintendo Switch 2 Edition 页面](https://www.nintendo.com/pt-br/store/products/overcooked-2-nintendo-switch-2-edition-switch-2/)明确提供“Pacote de Melhoria”版本选择、Team17 与升级包身份，但价格链接为动态 `ec.nintendo.com` 内容，静态公开页仅返回 `Loading`。 | BR 官方 JSON-LD 适配器已注册，但此样本尚未通过生产实测价格准入；不得把页面标题或其他 DLC 的 BRL 价格作为升级包价格。当前安全结果是过期/不可用，是否存在公开价格接口须另行验证其条款。 |
| 任天堂港区 | [香港区升级包官方页面](https://ec.nintendo.com/HK/zh/aocs/70050000065163)可确认公开 eShop 商品；无 Cookie 请求 `api.ec.nintendo.com/v1/price?country=HK&ids=70050000065163&lang=zh` 返回 `country: HK`、同一 `title_id`、`sales_status: onsale`、`regular_price` 的 `HKD 75`，以及促销中的 `discount_price` `HKD 52`。同一公开接口也能读取 `titles/70010000106253` 与 `bundles/70070000010913`。生产诊断确认 Magento 商城搜索从 Cloudflare Worker 返回 403，而普通香港官网返回 200；本体 `70010000033098` 的官方详情公开 `includedBundleItems`、`dlcItems` 与 `upgradeInfo`，可发现 Gourmet、普通 DLC 与升级通行证。V 0.0.11 验收进一步确认 titles 页面可把根对象放在 `serverFragment`，且 `dlcItems.items` 可同时含 `DlcItem` 与 `BundleItem`。 | HK 已通过公开官方价格 API 准入：只允许添加阶段已确认的 `https://ec.nintendo.com/HK/zh/titles/{ID}`、`/aocs/{ID}` 或 `/bundles/{ID}` 提取本区数字 ID，响应必须匹配 HK、该 ID、在售状态与 HKD。自动名称发现不再请求 Magento；仅从普通官网找到的 1–5 个本体展开一层官方关系，每根最多 50 项。RSC 只接受已观察到的 `fragment/serverFragment`，混合关系按官方 `__typename` 生成 `aocs/bundles` 路径，再用关联商品自己的详情验证 URL ID、类型和发行商。任何未知类型、不完整关系、第二跳或失效 automatic 唯一性均回退且零写入。接口 `raw_value` 为整港元，Worker 必须乘以 100 后写入以分为单位的快照；促销时采集折后当前价，否则采集原价。 |
| eShop Prices | [样本页](https://eshop-prices.com/games/20690-overcooked-2-nintendo-switch-2-edition-upgrade-pack?currency=KRW) 显示标题、Team17、Japan/Brazil/United States/Mexico 等地区条目，并声明页面价格含税。 | 候选来源，未获准入；不得请求。接入前须确认港区覆盖、原始本币字段和使用条款，不能把页面换算货币误存为本币。 |
| NT Deals | [美国区样本](https://ntdeals.net/us-store/game/1055028/overcooked-2-nintendo-switch-2-edition-upgrade-pack)、[墨西哥区样本](https://ntdeals.net/mx-store/game/1055138/overcooked-2-nintendo-switch-2-edition-upgrade-pack)、[巴西区样本](https://ntdeals.net/br-store/game/1055101/overcooked-2-nintendo-switch-2-edition-upgrade-pack) 给出分区商品 ID、升级包标题及 USD/MXN/BRL 原始价格。 | 候选来源，未获准入；不得请求。稳定代码名称为 `nt-deals`（先前需求中“NTPrices”为站点名称误记）；日区、港区覆盖、请求频率和使用条款仍待审计。 |
| Deku Deals | 本轮未取得覆盖五区升级包的公开、可验证请求形态。 | 保持可选且默认关闭；取得书面/公开使用许可、地区覆盖和身份字段后才可启用。 |
| Green Pipe | [公开页面](https://checkgreenpipe.com/switch-vs-steam) 证明其可展示 Switch 与 Steam 价格比较，但本轮未验证地区商品身份、五区覆盖或可复用请求形态。 | 保持可选且默认关闭；不得以该页面推断其可作为五区价格采集源。 |

## 已实现的技术边界

1. `ProviderChain` 只按管理员设置的顺序在 Worker 端调用来源；浏览器不直接访问任何商店或第三方站点。
2. 每个来源请求最多 15 秒；仅 `ProviderNetworkError` 可重试一次，之后按顺序回退。
3. 结果必须同时匹配已确认的来源、原始货币、规范化标题、发行商（若已确认）和商品类型；专用官方价格接口还必须匹配已确认的本区价格 ID 与响应地区。任一不符即拒绝写入。
4. 来源标签随快照保留。后续规则层只能让 `official` 快照触发即时降价；第三方快照仅供页面和日报展示。
5. 全部来源失败时，上层保留上一条成功快照并标记过期，不制造推测价格。
6. 五区官方提供方注册表中，JP 与 HK 均先尝试各自受控参数的任天堂公开价格 API，再尝试本区官方页面 JSON-LD；US、MX、BR 仅尝试本区官方页面。日区和香港 API 均对地区、币种和本区价格 ID 二次校验；任何地区未取得可验证价格都会安全产生过期状态，而不是推测金额。各区公开商店的实际可用性仍以本 ADR 的逐区受控验收为准。
7. `createThirdPartyProviderRegistry` 对管理员选择的未获准站点仅返回不可用来源和空提供方数组；实现中没有 `fetch`、站点 URL 或 HTML 选择器，因此不会访问第三方网页，也不会伪造第三方价格。

## 上线前准入清单

- 针对 US、JP、MX、BR、HK 各选一个真实商品，以服务端请求验证本区官方价格 ID、标题/发行商/类型的确认来源、原始货币、当前价和常规价字段。不得跨区复用价格 ID。
- 记录请求 URL/参数、响应字段、访问频率限制、超时行为及条款审查日期；不得记录 Cookie、账号或购买数据。
- 在测试 D1 环境执行一次受控采集，确认身份校验失败不会写入快照，官方失败时保留上一条成功快照并标记过期；第三方在许可前应明确显示“未接入”，而非出现伪造价格。
- 若要接入任一第三方站点，先记录其许可或 API 文档、允许的请求方式和频率、五区覆盖、原始本币字段与商品身份字段；完成审查后另行更新本 ADR、实现和测试，不能仅修改设置开关。
- 如果任一站点需要浏览器自动化或认证 Cookie，先更新 ADR 并单独评估 Cloudflare Browser Run 或替代数据源，不把该依赖隐式加入生产 Worker。日区升级包当前只获准执行独立、无持久会话的 Browser Run 三次可行性探针；探针成功也必须另行批准生产架构。

## 后果

- 首版不会承诺所有五区从第一天就有官方自动价格；未通过生产实测准入的地区会清楚显示官方价格过期或不可用状态，不以第三方补值。
- 页面设置可展示候选来源，但在通过本 ADR 准入检查前，选择它们只会显示“未接入”，不会默认启用或产生网络请求。
- 该决策避免把站点搜索索引、用户浏览器会话或转换货币误当成可靠的价格 API。
