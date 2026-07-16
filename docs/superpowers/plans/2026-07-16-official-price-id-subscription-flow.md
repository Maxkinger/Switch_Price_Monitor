# 官方价格 ID 与订阅前来源预览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员确认地区商品后，系统自动保存可验证的任天堂官方价格 ID；在创建订阅前按地区预览官方或第三方来源，并让日区先通过公开官方价格接口采集。

**Architecture:** 在已有 `regional_products.official_product_id` 字段上扩充采集读取模型，而不是新建重复标识。新增日区官方价格 API 适配器：它只接受添加流程已确认的地区商品，先验证响应地区、货币和价格 ID，再以该受控映射的商品身份构造结果。商品确认服务通过地区专用的 ID 解析器输出不可持久化预览；创建服务只消费已经确认并持久化的地区商品 ID。

**Tech Stack:** TypeScript、Cloudflare Workers、D1、Vitest、React 19、Vite。

## Global Constraints

- 每次代码、测试、SQL、配置或文档改动前，完整阅读 `AGENTS.md` 与 `docs/README.md`。
- 新增或修改的源代码、测试、SQL 和配置必须有与实现一致的中文详细注释；涉及价格来源、迁移和外部请求须说明业务与安全边界。
- 先写失败测试，再写最小实现；每个任务独立运行相关测试并提交。
- 不保存 Cookie、账号、购买信息、Telegram 凭据或任意真实秘密；浏览器只能调用本系统 API。
- 官方价格 ID 只绑定一个地区商品，不能跨区复用；无法确认时必须在订阅创建前显示第三方回退或不可监控状态。
- 只有 `official` 快照可触发即时降价；第三方来源保留站点标签但仅用于页面和日报。

---

## 文件结构

- `src/worker/providers/types.ts`：向已确认地区商品补充可空的官方价格 ID；定义官方接口结果需要回传的受控 ID。
- `src/worker/repositories/collection-repository.ts`：把 D1 的 `official_product_id` 读取为采集模型字段。
- `src/worker/providers/official-nintendo-price-api.ts`：日区公开价格 API 适配器，验证 API 响应后返回标准价格结果。
- `src/worker/services/official-price-id-service.ts`：从管理员确认的官方 URL 中按地区解析候选 ID，并调用官方价格 API 验证；无法验证时返回明确状态而不是猜测。
- `src/worker/services/subscription-preview-service.ts`：将各地区确认结果与已启用第三方顺序转为创建前来源预览。
- `src/worker/routes/product-routes.ts`：提供受会话保护的地区 URL 验证与订阅前来源预览 API；不在客户端访问任天堂。
- `src/worker/index.ts`：在静态资源回退前挂载商品确认预览路由。
- `src/shared/domain.ts`：定义只面向管理员 API 的商品确认候选与来源预览 DTO。
- `test/official-nintendo-price-api.test.ts`、`test/official-price-id-service.test.ts`、`test/subscription-preview-service.test.ts`、`test/api-product-preview.test.ts`：离线验证价格 API、ID 确认和受保护预览端点。
- `test/collection-repository.test.ts`、`test/apply-migrations.ts`：验证既有数据库字段读取与测试迁移基线。
- `docs/architecture/api-design.md`、`docs/quality/quality-and-acceptance.md`、`docs/requirements/traceability.md`：记录已实现接口、验收场景和需求状态。

### Task 1: 让采集模型读取每区官方价格 ID

**Files:**
- Modify: `src/worker/providers/types.ts`
- Modify: `src/worker/repositories/collection-repository.ts`
- Modify: `test/collection-repository.test.ts`

**Interfaces:**
- Produces: `RegionalProduct.officialPriceId: string | null`，供官方接口适配器安全决定是否请求。
- Consumes: `regional_products.official_product_id`，该字段已由 `migrations/0001_core.sql` 建立，禁止另建重复列。

- [ ] **Step 1: 写入失败测试，证明读取模型保留本区官方价格 ID**

```ts
await env.DB.prepare(
  "INSERT INTO regional_products (id, game_id, region_code, currency, official_product_id, product_url, match_source, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
).bind("active-product", "game", "JP", "JPY", "70050000064985", "https://store-jp.nintendo.com/item/software/D70050000064985/", "manual_selection", 1).run();

await expect(new CollectionRepository(env.DB).enabledRegionalProducts()).resolves.toEqual([
  expect.objectContaining({ id: "active-product", officialPriceId: "70050000064985" }),
]);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/collection-repository.test.ts`

Expected: FAIL，因为返回的 `RegionalProduct` 尚无 `officialPriceId`。

- [ ] **Step 3: 最小实现字段传递与中文边界注释**

```ts
export interface RegionalProduct {
  // 该值仅在添加阶段由本区官方链接/公开数据验证后写入；null 表示必须预告第三方回退，绝不跨区猜测或复用。
  officialPriceId: string | null;
}

interface CollectionProductRow {
  officialPriceId: string | null;
}

// 读取时保留可空标识：采集器据此跳过不可验证的官方接口，同时仍允许第三方来源提供显示价格。
products.official_product_id AS officialPriceId,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- --run test/collection-repository.test.ts`

Expected: PASS，且断言返回 `officialPriceId: "70050000064985"`。

- [ ] **Step 5: 提交最小模型改动**

```bash
git add src/worker/providers/types.ts src/worker/repositories/collection-repository.ts test/collection-repository.test.ts
git commit -m "feat: expose regional official price id"
```

### Task 2: 接入日区任天堂公开价格 API 适配器

**Files:**
- Create: `src/worker/providers/official-nintendo-price-api.ts`
- Modify: `src/worker/providers/types.ts`
- Test: `test/official-nintendo-price-api.test.ts`

**Interfaces:**
- Produces: `createNintendoPriceApiProvider(fetchPrice?: typeof fetch): PriceProvider`。
- Consumes: `RegionalProduct`；仅在 `regionCode === "JP"` 且 `officialPriceId !== null` 时请求 `https://api.ec.nintendo.com/v1/price?country=JP&ids=<id>&lang=ja`。
- Produces: 成功时 `ProviderResult`，其 `source` 为 `official`，金额来自 `regular_price.raw_value`，并携带 `officialPriceId` 用于链路校验。

- [ ] **Step 1: 写入失败测试，覆盖成功、跨区拒绝与响应错配**

```ts
it("uses the confirmed Japanese id and rejects a mismatched title id", async () => {
  const provider = createNintendoPriceApiProvider(async (url) => {
    expect(String(url)).toContain("country=JP");
    expect(String(url)).toContain("ids=70050000064985");
    return Response.json({ country: "JP", prices: [{ title_id: 70050000064985, sales_status: "onsale", regular_price: { currency: "JPY", raw_value: "1000" } }] });
  });
  await expect(provider.fetch(jpProduct, new AbortController().signal)).resolves.toMatchObject({ amountMinor: 1000, currency: "JPY", source: "official" });
});

it("returns null when a Japanese mapping has no id, a non-JP product is supplied, or the response id/currency differs", async () => {
  await expect(provider.fetch({ ...jpProduct, officialPriceId: null }, signal)).resolves.toBeNull();
  await expect(provider.fetch({ ...jpProduct, regionCode: "US", currency: "USD" }, signal)).resolves.toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/official-nintendo-price-api.test.ts`

Expected: FAIL，因为 `createNintendoPriceApiProvider` 尚不存在。

- [ ] **Step 3: 编写只支持已验证日区边界的最小适配器**

```ts
export function createNintendoPriceApiProvider(fetchPrice: typeof fetch = fetch): PriceProvider {
  return {
    source: "official",
    async fetch(product, signal) {
      // JP 的公开价格 API 不返回完整商品身份；只有添加流程已经确认该地区映射且 ID、地区、货币都吻合时才可使用。
      if (product.regionCode !== "JP" || product.currency !== "JPY" || !product.officialPriceId) return null;
      const url = new URL("https://api.ec.nintendo.com/v1/price");
      url.search = new URLSearchParams({ country: "JP", ids: product.officialPriceId, lang: "ja" }).toString();
      const response = await fetchPrice(url, { headers: { accept: "application/json" }, signal });
      return response.ok ? parseJapanesePrice(await response.json(), product) : null;
    },
  };
}
```

实现 `parseJapanesePrice` 时必须：只接受普通对象；严格比较 `country === "JP"`、`title_id` 与字符串化的 `officialPriceId`、`sales_status === "onsale"`、`currency === "JPY"` 和非负安全整数 `raw_value`；网络异常包装为 `ProviderNetworkError`；任何结构/业务不符返回 `null`。标题、发行商和类型只能复制自已确认的 `RegionalProduct`，并在注释中说明该信任边界。

- [ ] **Step 4: 运行专项与相邻提供方测试**

Run: `npm test -- --run test/official-nintendo-price-api.test.ts test/official-nintendo.test.ts test/provider-chain.test.ts`

Expected: PASS，且不触发真实网络请求。

- [ ] **Step 5: 提交日区官方适配器**

```bash
git add src/worker/providers/types.ts src/worker/providers/official-nintendo-price-api.ts test/official-nintendo-price-api.test.ts
git commit -m "feat: add Japanese official price api provider"
```

### Task 3: 在商品确认阶段自动验证日区价格 ID

**Files:**
- Create: `src/worker/services/official-price-id-service.ts`
- Test: `test/official-price-id-service.test.ts`

**Interfaces:**
- Produces: `OfficialPriceIdResolution = { status: "official-available"; officialPriceId: string } | { status: "official-id-unavailable"; officialPriceId: null; reason: "unsupported-region" | "unrecognized-url" | "official-verification-failed" }`。
- Consumes: `{ regionCode: RegionCode; currency: string; productUrl: string; canonicalTitle: string; publisher: string | null; productType: ProductType }` 与可注入 `PriceProvider`。
- Rule: 首版只从日区官方 URL 的 `/item/software/D<数字>` 路径中提取 ID；其他地区返回 `unsupported-region`，由预览明确展示第三方回退，不能套用日区规则。

- [ ] **Step 1: 写入失败测试，确保只识别经过验证的日区 URL**

```ts
it("extracts the JP price id, then accepts it only after the official provider verifies price and currency", async () => {
  const service = new OfficialPriceIdService(verifiedOfficialProvider);
  await expect(service.resolve(jpCandidate)).resolves.toEqual({ status: "official-available", officialPriceId: "70050000064985" });
});

it("does not derive an id from another region or a malformed JP link", async () => {
  await expect(service.resolve({ ...jpCandidate, regionCode: "US", currency: "USD" })).resolves.toMatchObject({ status: "official-id-unavailable", reason: "unsupported-region" });
  await expect(service.resolve({ ...jpCandidate, productUrl: "https://store-jp.nintendo.com/item/software/not-an-id" })).resolves.toMatchObject({ reason: "unrecognized-url" });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/official-price-id-service.test.ts`

Expected: FAIL，因为 `OfficialPriceIdService` 尚不存在。

- [ ] **Step 3: 最小实现 URL 提取与二次验证**

```ts
const japaneseStorePath = /^\/item\/software\/D(\d+)\/?$/;

// URL 的 D 前缀仅是已验证的日区页面形式；提取后仍调用官方价格提供方，避免把无效链接持久化为可采集 ID。
if (input.regionCode !== "JP") {
  return { status: "official-id-unavailable", officialPriceId: null, reason: "unsupported-region" };
}
let pathname: string;
try {
  pathname = new URL(input.productUrl).pathname;
} catch {
  return { status: "official-id-unavailable", officialPriceId: null, reason: "unrecognized-url" };
}
const match = pathname.match(japaneseStorePath);
if (!match) return { status: "official-id-unavailable", officialPriceId: null, reason: "unrecognized-url" };
const product = { ...input, id: "preview", officialPriceId: match[1] };
return (await this.official.fetch(product, new AbortController().signal))
  ? { status: "official-available", officialPriceId: match[1] }
  : { status: "official-id-unavailable", officialPriceId: null, reason: "official-verification-failed" };
```

无效 URL 必须捕获 `new URL` 的异常并返回 `unrecognized-url`，不得让管理员输入造成 500；服务不得写 D1，确保预览取消不会留下半成品映射。

- [ ] **Step 4: 运行服务与提供方测试**

Run: `npm test -- --run test/official-price-id-service.test.ts test/official-nintendo-price-api.test.ts`

Expected: PASS，且不同地区绝不复用日区 ID。

- [ ] **Step 5: 提交自动确认服务**

```bash
git add src/worker/services/official-price-id-service.ts test/official-price-id-service.test.ts
git commit -m "feat: verify Japanese price ids during product confirmation"
```

### Task 4: 生成创建订阅前的逐区来源预览

**Files:**
- Modify: `src/shared/domain.ts`
- Create: `src/worker/services/subscription-preview-service.ts`
- Test: `test/subscription-preview-service.test.ts`

**Interfaces:**
- Produces: `SubscriptionRegionPreview`，字段为 `regionCode`、`officialStatus`、`officialPriceId`、`fallbackSources`、`canMonitor`、`message`。
- Consumes: 已确认地区候选与 `OfficialPriceIdService`；首版回退顺序固定为 `['eshop-prices', 'nt-deals']`，并集中在 `defaultFallbackSources` 常量，供将来的设置来源排序替换。
- Rule: `official-available` 的 `fallbackSources` 仍返回默认顺序供官方运行时失败时回退；`official-id-unavailable` 必须在 `message` 中明确“将使用第三方”；没有任何允许来源时 `canMonitor` 为 `false`。

- [ ] **Step 1: 写入失败测试，覆盖三种管理员可见状态**

```ts
await expect(preview.create([verifiedJp, unsupportedHk])).resolves.toEqual([
  expect.objectContaining({ regionCode: "JP", officialStatus: "official-available", officialPriceId: "70050000064985", canMonitor: true }),
  expect.objectContaining({ regionCode: "HK", officialStatus: "official-id-unavailable", fallbackSources: ["eshop-prices", "nt-deals"], canMonitor: true, message: expect.stringContaining("第三方") }),
]);

await expect(new SubscriptionPreviewService(unavailableResolver, []).create([unsupportedHk])).resolves.toEqual([
  expect.objectContaining({ regionCode: "HK", canMonitor: false, message: expect.stringContaining("不会监控") }),
]);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/subscription-preview-service.test.ts`

Expected: FAIL，因为预览 DTO 与服务尚不存在。

- [ ] **Step 3: 实现纯服务与简体中文状态文案**

```ts
export const defaultFallbackSources = ["eshop-prices", "nt-deals"] as const;

if (resolution.status === "official-available") {
  return { regionCode: candidate.regionCode, officialStatus: resolution.status, officialPriceId: resolution.officialPriceId, fallbackSources: this.fallbackSources, canMonitor: true, message: "官方价格可用" };
}
if (this.fallbackSources.length > 0) {
  return { regionCode: candidate.regionCode, officialStatus: resolution.status, officialPriceId: null, fallbackSources: this.fallbackSources, canMonitor: true, message: `官方价格 ID 未确认，将使用第三方：${this.fallbackSources.join(" → ")}` };
}
return { regionCode: candidate.regionCode, officialStatus: resolution.status, officialPriceId: null, fallbackSources: [], canMonitor: false, message: "无可用价格来源，不会监控此区" };
```

DTO 不得包含任天堂原始响应、URL 查询参数以外的用户数据或任何外部错误正文；仅返回管理员确认决策所需字段。

- [ ] **Step 4: 运行预览与共享类型测试**

Run: `npm test -- --run test/subscription-preview-service.test.ts`

Expected: PASS，三种状态的 `canMonitor` 和中文提示均稳定。

- [ ] **Step 5: 提交预览服务**

```bash
git add src/shared/domain.ts src/worker/services/subscription-preview-service.ts test/subscription-preview-service.test.ts
git commit -m "feat: preview regional price sources before subscription"
```

### Task 5: 暴露受保护的商品确认预览 API

**Files:**
- Create: `src/worker/routes/product-routes.ts`
- Modify: `src/worker/index.ts`
- Test: `test/api-product-preview.test.ts`

**Interfaces:**
- Produces: `POST /api/products/preview-sources`，请求体为 `{ candidates: ProductConfirmationCandidate[] }`，响应为 `{ regions: SubscriptionRegionPreview[] }`。
- Consumes: `requireAdmin`、`OfficialPriceIdService`、`SubscriptionPreviewService`、`createNintendoPriceApiProvider`。
- Validation: 候选数组非空；地区必须为 `US|JP|MX|BR|HK`；URL 必须为 `https:`；标题非空；发行商可为 `null`；类型必须为受控 `ProductType`；同一区最多一个候选。

- [ ] **Step 1: 写入失败 API 测试，覆盖会话守卫、日区成功和其他区回退预告**

```ts
const unauthorized = await handleProductRoute(new Request("https://example.test/api/products/preview-sources", { method: "POST", body: JSON.stringify({ candidates: [jpCandidate] }) }), env.DB, preview);
expect(unauthorized.status).toBe(401);

const response = await callAsAdmin("/api/products/preview-sources", { candidates: [jpCandidate, hkCandidate] }, preview);
expect(response.status).toBe(200);
await expect(response.json()).resolves.toMatchObject({ regions: [
  { regionCode: "JP", officialStatus: "official-available" },
  { regionCode: "HK", officialStatus: "official-id-unavailable", fallbackSources: ["eshop-prices", "nt-deals"] },
] });
```

测试中的外部 `fetch` 必须注入为本地响应桩件；不得调用真实任天堂接口。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/api-product-preview.test.ts`

Expected: FAIL，因为路由未挂载或返回静态资源响应。

- [ ] **Step 3: 实现路由、输入收窄和 Worker 注册**

```ts
if (request.method !== "POST" || path !== "/api/products/preview-sources") return null;
if (!(await requireAdmin(request, database))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });

// 预览只读且不写 D1：管理员可反复比较候选，确认后仍由既有订阅创建端点消费已持久化的地区商品。
const candidates = readConfirmationCandidates(await request.json<unknown>());
return Response.json({ regions: await preview.create(candidates) });
```

将路由签名定义为 `handleProductRoute(request, database, preview: SubscriptionPreviewService)`，并由 `index.ts` 创建生产实例 `new SubscriptionPreviewService(new OfficialPriceIdService(createNintendoPriceApiProvider()), defaultFallbackSources)` 后在静态资源回退前、订阅写入路由前传入。API 测试直接传入固定的 `preview` 桩件，因此不触发真实网络。任何校验错误返回 `422 VALIDATION_ERROR`，不得回显堆栈、外部响应或数据库异常。

- [ ] **Step 4: 运行 API 相关回归测试**

Run: `npm test -- --run test/api-product-preview.test.ts test/auth-guard.test.ts test/api-subscriptions.test.ts`

Expected: PASS，匿名用户 401、无效输入 422、预览不插入 `games`、`regional_products` 或 `subscriptions`。

- [ ] **Step 5: 提交预览 API**

```bash
git add src/worker/routes/product-routes.ts src/worker/index.ts test/api-product-preview.test.ts
git commit -m "feat: add protected subscription source preview api"
```

### Task 6: 将已确认官方 ID 接入提供方链并更新工程文档

**Files:**
- Modify: `src/worker/providers/provider-chain.ts`
- Modify: `test/provider-chain.test.ts`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/requirements/traceability.md`

**Interfaces:**
- Consumes: `ProviderResult.officialPriceId?: string`；只有专用官方价格 API 填写该字段。
- Rule: `ProviderChain` 对携带 `officialPriceId` 的官方结果必须同时验证其等于 `RegionalProduct.officialPriceId`；没有该字段的既有 JSON-LD 官方适配器维持标题、发行商、类型与货币验证，避免无关回归。

- [ ] **Step 1: 写入失败测试，防止官方价格 API 的错误 ID 通过链路**

```ts
it("rejects an official API result whose confirmed price id differs from the regional mapping", async () => {
  const apiProvider: PriceProvider = {
    source: "official",
    fetch: async () => ({ ...validResult({ source: "official" }), officialPriceId: "70050000000000" }),
  };
  await expect(new ProviderChain().fetch({ ...product, officialPriceId: "70050000064985" }, [apiProvider])).resolves.toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/provider-chain.test.ts`

Expected: FAIL，因为链路尚未比较 `officialPriceId`。

- [ ] **Step 3: 最小实现可选 ID 校验并同步文档**

```ts
const hasMatchingOfficialId = result.officialPriceId === undefined
  || (expectedSource === "official" && product.officialPriceId !== null && result.officialPriceId === product.officialPriceId);
return hasMatchingOfficialId
  && result.source === expectedSource
  && result.currency === product.currency
  && normalizeIdentity(result.title) === normalizeIdentity(product.canonicalTitle)
  && result.productType === product.productType
  && (product.publisher === null || normalizeIdentity(result.publisher ?? "") === normalizeIdentity(product.publisher));
```

更新 API 文档，列出 `POST /api/products/preview-sources` 的会话、输入和无持久化约束；更新质量文档，列出“跨区 ID 拒绝、官方 ID 缺失的第三方预告、官方 API 响应错配”三项离线验收；在追踪表把 FR-001、FR-002 标为已实现相应后端边界，明确跨区自动搜索与前端确认页面仍在后续界面任务中实现。

- [ ] **Step 4: 运行全量验证与注释一致性检查**

Run: `npm test -- --run && npx tsc --noEmit && npm run build && git diff --check`

Expected: 全部通过；逐项复读本任务改动的中文注释，确认它们仍准确描述“日区专用、各区不复用、预览不写库、第三方不即时通知”的边界。

- [ ] **Step 5: 提交链路与文档更新**

```bash
git add src/worker/providers/provider-chain.ts test/provider-chain.test.ts docs/architecture/api-design.md docs/quality/quality-and-acceptance.md docs/requirements/traceability.md
git commit -m "feat: validate official price ids in provider chain"
```

## 计划自检

- 规格覆盖：Task 1 读取持久化 ID；Task 2 验证日区官方价格；Task 3 自动取得并验证 ID；Task 4 提供创建前按区来源状态；Task 5 向已登录管理员提供无写入预览；Task 6 将 ID 校验纳入采集链并更新验收文档。
- 范围边界：本计划明确只实现已验证的日区 ID 解析。US、MX、BR、HK 仍会在预览中明确标记为官方 ID 未确认并使用第三方回退；后续新增地区解析器前必须先更新 ADR-002 的真实验证证据。
- 类型一致性：`officialPriceId` 在 `RegionalProduct`、D1 读取模型、官方 API 结果与 ProviderChain 中均为同一字符串标识；预览与订阅写入之间不共享半成品数据库记录。
- 占位检查：计划不含 `TBD`、`TODO` 或“适当处理”等未定义实现步骤。
