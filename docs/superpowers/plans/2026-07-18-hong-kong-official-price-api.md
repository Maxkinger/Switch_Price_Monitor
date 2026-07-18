# Hong Kong Official Nintendo Price API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持日区官方价格获取不变的前提下，为已确认的香港区任天堂 `titles` 与 `aocs` 商品链接接入严格校验的官方 HKD 价格 API。

**Architecture:** 使用不可变地区档案集中 JP/HK 的国家、语言与货币，并让价格 API、价格 ID 提取服务、提供方注册表共享同一地区边界。API 仅在添加流程已确认官方商品身份后读取；响应先校验地区、ID、在售状态、币种与最小货币单位，再交由既有 `ProviderChain` 校验标题、发行商与商品类型。促销时采集折后当前价，快照模型维持不变。

**Tech Stack:** TypeScript、Vitest、Cloudflare Workers、任天堂公开价格 API、D1（本任务不修改 schema）。

## Global Constraints

- 所有新增或修改的源代码、测试和文档必须使用与实现一致的中文详细注释，说明地区隔离、外部响应验证与业务原因。
- 测试先行：每项实现前先写失败测试并运行确认失败，再写最小实现并运行相关测试。
- 不请求第三方价格站、不使用 Cookie、Nintendo Account 或浏览器自动化；只访问任天堂公开 API。
- 不新增 D1 迁移：快照仍保存实际当前售价，有促销时为 `discount_price`，否则为 `regular_price`。
- 提交前须通过完整质量门禁及注释一致性检查；创建提交与推送前必须单独取得管理员确认。

---

### Task 1: 受控 JP/HK 价格 API 适配器

**Files:**
- Modify: `test/official-nintendo-price-api.test.ts`
- Modify: `src/worker/providers/official-nintendo-price-api.ts`

**Interfaces:**
- Consumes: `RegionalProduct` 的 `regionCode`、`currency`、`officialPriceId`。
- Produces: `createNintendoPriceApiProvider(fetchPrice)`；成功时返回带 `officialPriceId` 的 `ProviderResult`。

- [x] **Step 1: 写入失败测试**

在现有 JP 测试之后加入 HK 商品夹具，并断言：

```ts
it("uses Hong Kong settings and prefers the discounted HKD amount", async () => {
  const provider = createNintendoPriceApiProvider(async (url) => {
    expect(String(url)).toContain("country=HK");
    expect(String(url)).toContain("ids=70050000065163");
    expect(String(url)).toContain("lang=zh");
    return Response.json(hongKongPriceResponse());
  });
  await expect(provider.fetch(hkProduct, new AbortController().signal)).resolves.toMatchObject({
    source: "official", amountMinor: 5200, currency: "HKD", officialPriceId: "70050000065163",
  });
});

it("rejects a Hong Kong response with the wrong country, id, status, currency, or amount", async () => {
  // 每个无效变体都必须 resolve 为 null，证明外部响应不会污染快照。
});
```

- [x] **Step 2: 运行失败测试**

Run: `npm test -- --run test/official-nintendo-price-api.test.ts`

Expected: FAIL，因为实现仅允许 JP/JPY，或因 HK 夹具不存在而无法通过断言。

- [x] **Step 3: 写入最小实现**

在 `official-nintendo-price-api.ts` 中以只读地区档案定义 JP/HK 固定参数，按产品地区读取档案、构造 `URLSearchParams({ country, ids, lang })`，并把解析函数改为通用形式。任天堂的 `raw_value` 不是统一最小货币单位：JPY 原样使用，HKD 必须乘以 100 后才能写入快照：

```ts
const priceApiProfiles = {
  JP: { country: "JP", language: "ja", currency: "JPY" },
  HK: { country: "HK", language: "zh", currency: "HKD" },
} as const;

const priceNode = isRecord(price.discount_price) ? price.discount_price : price.regular_price;
const minorFactor = profile.currency === "HKD" ? 100 : 1;
if (payload.country !== profile.country || price.sales_status !== "onsale" || priceNode.currency !== profile.currency) return null;
```

保持网络异常只抛 `ProviderNetworkError`；结构、HTTP、身份与金额异常返回 `null`。每个新增配置、分支及安全校验添加中文说明。

- [x] **Step 4: 运行相关测试**

Run: `npm test -- --run test/official-nintendo-price-api.test.ts`

Expected: PASS，JP 与 HK 全部测试通过。

### Task 2: 香港官方链接价格 ID 提取与订阅前验证

**Files:**
- Modify: `test/official-price-id-service.test.ts`
- Modify: `src/worker/services/official-price-id-service.ts`

**Interfaces:**
- Consumes: `OfficialPriceIdCandidate` 与 `PriceProvider`。
- Produces: `OfficialPriceIdService.resolve(candidate)`，对 HK 返回 `official-available` 或安全的不可用原因。

- [x] **Step 1: 写入失败测试**

添加 `HK/HKD` 候选，分别覆盖 `https://ec.nintendo.com/HK/zh/titles/70010000106253` 与 `https://ec.nintendo.com/HK/zh/aocs/70050000065163`，并加入拒绝伪造主机、错误语言路径、额外路径和非数字 ID 的断言：

```ts
await expect(service.resolve(hkAocCandidate)).resolves.toEqual({
  status: "official-available", officialPriceId: "70050000065163",
});
await expect(service.resolve({ ...hkAocCandidate, productUrl: "https://ec.nintendo.com/HK/zh/aocs/70050000065163/extra" })).resolves.toMatchObject({
  status: "official-id-unavailable", reason: "unrecognized-url",
});
```

- [x] **Step 2: 运行失败测试**

Run: `npm test -- --run test/official-price-id-service.test.ts`

Expected: FAIL，因为服务当前仅接受 JP/JPY。

- [x] **Step 3: 写入最小实现**

在服务中保留 JP 精确正则，并新增 HK 精确正则：

```ts
const hongKongEshopPath = /^\/HK\/zh\/(?:titles|aocs)\/(\d+)\/?$/;
```

用受控地区分支验证 `regionCode/currency/hostname/pathname`，再把提取的 ID 交给已有官方提供方二次验证。不得从查询参数、URL 中任意数字或非 HK 链接推导 ID；所有分支用中文注释说明地区 ID 不可跨服复用。

- [x] **Step 4: 运行相关测试**

Run: `npm test -- --run test/official-price-id-service.test.ts`

Expected: PASS，JP 回归、HK `titles/aocs` 与非法 URL 拒绝均通过。

### Task 3: 官方提供方注册顺序与回归保护

**Files:**
- Modify: `test/official-provider-registry.test.ts`
- Modify: `src/worker/providers/official-provider-registry.ts`

**Interfaces:**
- Consumes: 经确认的 `RegionalProduct`。
- Produces: `OfficialProviderRegistry.providersFor(product)`，JP/HK 返回 API 优先、官方页面回退的提供方数组。

- [x] **Step 1: 写入失败测试**

创建 `HK/HKD` 商品夹具并断言两个官方来源；US、MX、BR 均仍只有页面来源：

```ts
expect(registry.providersFor(hkProduct).map((provider) => provider.source)).toEqual(["official", "official"]);
expect(registry.providersFor(usProduct)).toHaveLength(1);
```

- [x] **Step 2: 运行失败测试**

Run: `npm test -- --run test/official-provider-registry.test.ts`

Expected: FAIL，因为注册表当前只给 JP 注册公开价格 API。

- [x] **Step 3: 写入最小实现**

将字段命名从 `japanesePriceApi` 收敛为通用的 `nintendoPriceApi`，并仅对 `JP` 与 `HK` 返回 `[nintendoPriceApi, officialPage]`。保留现有货币映射前置校验；新增中文注释说明两个相同 `official` 标签是两个不同的官方读取策略，而非重复写入。

- [x] **Step 4: 运行相关测试**

Run: `npm test -- --run test/official-provider-registry.test.ts`

Expected: PASS，JP/HK 优先 API，US/MX/BR 维持单一官方页面。

### Task 4: 文档、完整验证与注释一致性

**Files:**
- Modify: `docs/decisions/ADR-002-price-provider-validation.md`
- Modify: `docs/architecture/system-design.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-07-18-hong-kong-official-price-api-design.md`
- Modify: `docs/superpowers/plans/2026-07-18-hong-kong-official-price-api.md`

**Interfaces:**
- Consumes: Task 1–3 已通过的 API、URL 与注册表行为。
- Produces: 与生产实现一致的香港官方 API 准入记录、架构数据流和需求追踪状态。

- [x] **Step 1: 更新 ADR 与架构说明**

将 ADR-002 港区结论改为“HK 官方公开 API 已验证”，记录固定国家/语言、`titles/aocs` ID 路径、`HKD`/在售/ID 校验和促销价优先规则；系统设计改为 JP 与 HK API 优先、其他三地区页面解析。

- [x] **Step 2: 更新需求追踪与文档目录**

FR-002 标记为“HK 官方 API 已实施（待生产受控验收）”，在文档目录添加本设计规格和本计划的准确状态与链接。

- [x] **Step 3: 运行完整质量门禁**

Run: `npm test -- --run`

Expected: 所有 Worker 测试 PASS。

Run: `npm run test:dom -- --run`

Expected: 所有 DOM 测试 PASS。

Run: `npx tsc --noEmit && npm run build && git diff --check`

Expected: TypeScript、生产构建、补丁空白检查均 PASS。

- [x] **Step 4: 人工审查注释与变更范围**

Run: `git diff --check && git diff -- src/worker/providers/official-nintendo-price-api.ts src/worker/services/official-price-id-service.ts src/worker/providers/official-provider-registry.ts test/official-nintendo-price-api.test.ts test/official-price-id-service.test.ts test/official-provider-registry.test.ts`

Expected: 所有新增或更新的代码、测试和配置含有与实际 JP/HK 隔离行为一致的中文注释；没有密钥、Cookie、账号数据、生产价格快照或未授权第三方 URL。

## 自检

- 规格覆盖：Task 1 覆盖 HK API、折扣优先与响应校验；Task 2 覆盖 `titles/aocs` URL；Task 3 覆盖注册优先级和 JP 回归；Task 4 覆盖 ADR、架构、追踪、全量门禁及注释一致性。
- 无占位符：每项测试、失败预期、实现接口与命令均已列明。
- 类型一致性：所有任务复用既有 `PriceProvider`、`ProviderResult`、`RegionalProduct`、`OfficialPriceIdCandidate` 和 `OfficialPriceIdService.resolve`，不变更 D1 或共享快照 DTO。
