# 香港区任天堂官方价格 API 设计规格

## 状态

已实现，待生产环境受控验收。确认与本地质量门禁日期：2026-07-18。

## 目标

在不改变日区已上线采集语义的前提下，让已由添加订阅流程核验的香港区任天堂商品，能够从任天堂公开价格 API 获取 HKD 当前售价。

## 已确认边界

1. 日区继续使用 `country=JP`、`lang=ja`、`JPY` 及 My Nintendo Store `D` 前缀 URL 的既有价格 ID 规则；本次不得改变或放宽该规则。
2. 香港区使用任天堂公开接口 `https://api.ec.nintendo.com/v1/price`，固定请求 `country=HK`、`lang=zh` 与本区商品 ID。
3. 香港价格 ID 仅能从已核验的 HTTPS `ec.nintendo.com` 官方链接取得，支持精确路径 `/HK/zh/titles/{数字 ID}` 与 `/HK/zh/aocs/{数字 ID}`；查询参数、额外路径、非香港路径、非官方主机和非数字 ID 一律拒绝。
4. 公开价格 API 不返回完整商品身份，不能用它发现或确认商品。它只可用于已经由官方搜索或官方商品链接确认的地区商品，并继续回显保存的标题、发行商和商品类型，交由 `ProviderChain` 二次比对。
5. 响应必须同时满足：`country` 为目标地区、存在与请求 ID 完全相同的 `title_id`、`sales_status` 为 `onsale`、价格币种与地区货币一致、金额为非负安全整数。任一条件不符即安全失败并允许既有官方页面/第三方回退链继续处理。
6. API 在有促销时返回 `discount_price` 与 `regular_price`。本期不可变价格快照仍只保存实际可购买的当前售价：优先折后价、无折扣时使用原价；不新增 D1 迁移，也不改变历史价格、通知或详情页的原价数据模型。添加订阅候选现有的原价/折扣展示不受影响。
7. 仍只请求任天堂公开接口：不使用 Nintendo Account、Cookie、浏览器自动化或第三方价格站点。

## 架构设计

`official-nintendo-price-api.ts` 从日区专用适配器收敛为受控地区档案驱动的官方 API 适配器。档案固定列举 JP 与 HK 的国家、语言和币种；调用方无法传入 URL、国家或语言，避免把 Worker 变成任意 API 代理。

`OfficialPriceIdService` 同样以受控地区档案提取和验证价格 ID：JP 只接受既有 Store URL，HK 只接受 `ec.nintendo.com/HK/zh/titles|aocs` URL。该服务在订阅创建前立即调用官方适配器验证 ID，因此 API 可用性会准确反映在来源预览中。

`OfficialProviderRegistry` 对 JP 与 HK 都把官方价格 API 放在对应官方页面解析器之前。其他地区保持现状；API 因页面或接口变化失败时，链路继续尝试本区官方页面，最终按既有规则标记为过期或走已获准的第三方回退。

## 数据流

```text
已确认的 HK 官方商品链接
  -> 精确提取 titles/aocs 数字 ID
  -> 请求固定 HK 官方价格 API
  -> 校验地区、ID、在售状态、HKD 与金额
  -> 有 discount_price：写入折后当前价；否则写入 regular_price
  -> ProviderChain 再校验确认过的商品身份
  -> 追加现有价格快照
```

## 验收标准

- JP 固定夹具仍生成 `country=JP&lang=ja` 请求并接受匹配的 JPY 响应。
- HK `titles/70010000106253` 与 `aocs/70050000065163` 均可在离线测试中提取并验证对应 ID。
- HK 固定夹具生成 `country=HK&lang=zh` 请求；促销响应取 `discount_price.raw_value`，无促销响应取 `regular_price.raw_value`。
- 任一地区/ID/币种/状态/金额校验失败时不产生 ProviderResult，且不发出跨区请求。
- 注册表仅为 JP 与 HK 返回“价格 API、官方页面”顺序；US、MX、BR 行为保持不变。
- 文档明确 HK 已通过公开 API 准入；不宣称第三方回退已接入。
