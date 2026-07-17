# 官方订阅发现与批量确认实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让单管理员可在设置的默认区搜索或粘贴任天堂官方链接，批量选择商品、独立确认各区官方映射，并原子创建或返回既有订阅。

**Architecture:** 新增一个只读取任天堂公开数据的商品发现层：美区名称检索只使用任天堂官网当前公开搜索页所依赖的服务，其他尚未通过地区检索准入的区域明确返回“官方搜索不可用”，并提供官方链接确认入口。发现、跨区候选和来源预览始终只产生瞬时 DTO；最终确认服务重新验证每个候选后，在一个 D1 批次中写入 `games`、`regional_products`、`subscriptions` 与关联记录。React 前端只调用受保护的本系统 API，并用已确认的三列候选卡布局驱动多选与逐区确认。

**Tech Stack:** TypeScript、Cloudflare Workers、Cloudflare D1、React 19、Vite、Vitest、任天堂公开商品页与其公开搜索结果。

**实施状态（2026-07-17）：**本计划已完成：默认区官方发现、官方链接核验、跨区人工确认、原子批量订阅，以及同源 React 订阅向导均已落地。候选发现从不使用第三方价格站；美区以任天堂公开名称搜索接入，未获地区搜索准入时仅提供本区官方链接入口。全量测试、类型检查、生产构建、差异检查与本地渲染核对均已执行。

## Global Constraints

- 每次代码、测试、SQL、配置或文档改动前，完整阅读 `AGENTS.md` 与 `docs/README.md`。
- 新增或修改的源代码、测试、SQL 和配置必须有与实现一致的中文详细注释；外部请求、认证、价格来源与持久化必须明确说明安全和业务边界。
- 严格测试先行：每个任务先写失败测试、运行确认失败、写最小实现、运行相关回归测试，再独立提交。
- 所有发现、匹配和链接验证只使用任天堂官方商店或任天堂公开商品数据；第三方站点仅允许在价格采集阶段作为官方失败后的回退，绝不进入候选结果。
- 官方公开搜索的底层服务仅在 Worker 端调用，且仅作为任天堂官网公开搜索页的实现细节；不得发送或保存 Nintendo Cookie、账号、购买信息、会话资料或任何秘密。
- 默认搜索区必须只读取 `settings.defaultSearchRegion`，浏览器请求不得覆盖；未获得地区搜索准入时必须显示官方链接验证入口，不能伪造空搜索结果。
- 每个游戏每区最多确认一个官方商品；官方价格 ID 只能由该区官方链接/公开数据验证，绝不跨区复用，也不允许浏览器手填。
- 在 `POST /api/products/confirm-subscriptions` 成功之前不得写入 `games`、`regional_products`、`subscriptions` 或关联表；任一项无效时整批 422 且不产生半成品记录。
- 同一游戏已有订阅时返回既有订阅，不隐式覆盖地区范围；所有新增端点均要求管理员会话，匿名请求统一返回 401。
- 所有接口对外只返回受控 DTO 与中文安全摘要，不回显任天堂原始响应、外部 URL 查询资料、堆栈、SQL 或密钥。
- 候选卡桌面端固定每行三张，窄屏按宽度降为两张或一张；点击整张卡切换多选，选中状态使用暖色 `3px` 边框和浅色背景，不显示“已选择”或“点击选择”文案。

---

## 文件结构

- `src/shared/domain.ts`：定义商品候选、官方搜索状态、跨区确认和批量确认的共享受控 DTO。
- `src/worker/services/official-product-discovery-service.ts`：统一默认区检索、官方链接解析、跨区自动匹配与无准入地区的明确降级。
- `src/worker/providers/official-nintendo-search.ts`：只读取任天堂官网公开搜索实现所返回的美区候选；网络异常与结构变化返回不可用状态。
- `src/worker/providers/official-nintendo-product-page.ts`：验证受支持地区的官方 HTTPS 商品链接，读取公开 JSON-LD 身份、封面与可验证价格，不写 D1。
- `src/worker/routes/product-routes.ts`：增加搜索、链接解析、跨区确认、批量预览与最终确认端点，并保持既有预览端点兼容。
- `src/worker/repositories/subscription-confirmation-repository.ts`：执行确认阶段唯一的 D1 原子批次，且在写入前查找既有订阅。
- `src/worker/services/subscription-confirmation-service.ts`：重新验证浏览器提交的候选、构造规范化游戏身份并调用原子仓储。
- `src/worker/index.ts`：注入商品发现、官方链接解析、官方 ID 验证与批量确认依赖。
- `src/app/subscription-wizard.ts`：保存前端纯状态机和可测试的候选选择/逐区确认规则。
- `src/app/api-client.ts`：集中封装带 Cookie 的本系统商品 API，禁止组件直接访问任天堂或第三方站点。
- `src/app/App.tsx`、`src/app/styles.css`：实现管理员“添加订阅”向导和已确认的三列候选卡草图。
- `test/official-nintendo-search.test.ts`、`test/official-nintendo-product-page.test.ts`、`test/official-product-discovery-service.test.ts`：离线验证官方检索、官方链接解析与跨区降级。
- `test/subscription-confirmation-service.test.ts`、`test/api-product-discovery.test.ts`：验证受保护 API、全批失败不写入、批量新建与既有订阅返回。
- `test/subscription-wizard.test.ts`：验证前端多选、地区隔离、候选卡价格显示模型与请求装配。
- `docs/architecture/api-design.md`、`docs/architecture/data-model.md`、`docs/requirements/traceability.md`、`docs/quality/quality-and-acceptance.md`：记录实现后的接口、原子写入边界、验收与需求状态。

### Task 1: 建立官方商品发现 DTO 与美区官方搜索适配器

**Files:**
- Modify: `src/shared/domain.ts`
- Create: `src/worker/providers/official-nintendo-search.ts`
- Test: `test/official-nintendo-search.test.ts`

**Interfaces:**
- Produces: `OfficialProductCandidate`，字段为 `regionCode`、`productUrl`、`canonicalTitle`、`publisher`、`productType`、`currency`、`coverUrl`、`currentPriceMinor`、`regularPriceMinor`。
- Produces: `OfficialSearchResult = { status: "available"; candidates: OfficialProductCandidate[] } | { status: "unavailable"; message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" }`。
- Produces: `OfficialProductSearch.search(regionCode: RegionCode, query: string, signal: AbortSignal): Promise<OfficialSearchResult>`。
- Consumes: 仅由 Worker 注入的 `fetch`；候选链接必须以所属地区已批准的 Nintendo 官方主机为准。

- [x] **Step 1: 先写失败测试，固定美区官方搜索成功、非美区降级和结构异常行为**

```ts
it("returns only normalized US Nintendo candidates from the official search response", async () => {
  const search = createOfficialNintendoSearch(async () => Response.json({
    results: [{
      productTitle: "Overcooked! 2",
      productLink: "/us/store/products/overcooked-2-switch/",
      publisher: "Team17",
      price: { salePrice: 999, regPrice: 2499, currency: "USD" },
      imageUrl: "https://assets.nintendo.com/overcooked.jpg",
      productType: "game",
    }],
  }));

  await expect(search.search("US", "Overcooked", new AbortController().signal)).resolves.toEqual({
    status: "available",
    candidates: [expect.objectContaining({
      regionCode: "US", currency: "USD", currentPriceMinor: 999, regularPriceMinor: 2499,
      productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-switch/",
    })],
  });
});

it("does not query a non-admitted regional search adapter and reports a safe official-link fallback", async () => {
  const fetchOfficialSearch = vi.fn<typeof fetch>();
  const search = createOfficialNintendoSearch(fetchOfficialSearch);
  await expect(search.search("HK", "Overcooked", new AbortController().signal)).resolves.toEqual({
    status: "unavailable",
    message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。",
  });
  expect(fetchOfficialSearch).not.toHaveBeenCalled();
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/official-nintendo-search.test.ts`

Expected: FAIL，因为 `OfficialProductCandidate` 与 `createOfficialNintendoSearch` 尚未定义。

- [x] **Step 3: 实现受控候选 DTO 与仅服务端的官方搜索适配器**

```ts
export interface OfficialProductCandidate {
  regionCode: RegionCode;
  productUrl: string;
  canonicalTitle: string;
  publisher: string | null;
  productType: ProductType;
  currency: string;
  coverUrl: string | null;
  currentPriceMinor: number | null;
  regularPriceMinor: number | null;
}

export type OfficialSearchResult =
  | { status: "available"; candidates: OfficialProductCandidate[] }
  | { status: "unavailable"; message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" };

export function createOfficialNintendoSearch(fetchOfficialSearch: typeof fetch = fetch): OfficialProductSearch {
  return {
    async search(regionCode, query, signal) {
      // 当前只有美区的任天堂公开搜索页面完成了请求形式和候选字段验证；其他地区宁可要求官方链接，也不套用美区索引。
      if (regionCode !== "US") return unavailableSearch();
      const response = await fetchOfficialSearch(createUsOfficialSearchRequest(query), { signal });
      if (!response.ok) return unavailableSearch();
      return { status: "available", candidates: parseUsOfficialSearch(await response.json()) };
    },
  };
}
```

`createUsOfficialSearchRequest` 必须构造任天堂美区官网当前公开搜索页使用的只读请求，并把请求地址、客户端公开配置和索引名收敛在该私有函数中；它们不得进入浏览器包、D1、日志或 API 响应。`parseUsOfficialSearch` 只接受普通对象、绝对或 `/us/` 相对的 Nintendo HTTPS 商品链接、非空标题、`USD`、非负安全整数金额和受控 `ProductType`；无效命中逐条跳过而非抛出。网络异常包装为 `ProviderNetworkError`，路由再转为安全的不可用响应；不读取 Cookie 或重定向至非 Nintendo 主机。

- [x] **Step 4: 运行适配器与现有提供方回归测试**

Run: `npm test -- --run test/official-nintendo-search.test.ts test/official-nintendo.test.ts test/provider-chain.test.ts`

Expected: PASS，测试只使用注入响应；非美区不会产生外部请求。

- [x] **Step 5: 提交官方搜索适配器**

```bash
git add src/shared/domain.ts src/worker/providers/official-nintendo-search.ts test/official-nintendo-search.test.ts
git commit -m "feat: add official product search adapter"
```

### Task 2: 实现官方链接解析、默认区搜索与逐商品跨区确认

**Files:**
- Create: `src/worker/providers/official-nintendo-product-page.ts`
- Create: `src/worker/services/official-product-discovery-service.ts`
- Modify: `src/worker/routes/product-routes.ts`
- Modify: `src/worker/index.ts`
- Test: `test/official-nintendo-product-page.test.ts`
- Test: `test/official-product-discovery-service.test.ts`
- Test: `test/api-product-discovery.test.ts`

**Interfaces:**
- Produces: `OfficialProductPageResolver.resolve(regionCode: RegionCode, productUrl: string, signal: AbortSignal): Promise<OfficialProductCandidate | null>`。
- Produces: `OfficialProductDiscoveryService.searchDefaultRegion(query: string): Promise<OfficialSearchResult>`。
- Produces: `OfficialProductDiscoveryService.resolveOfficialLink(regionCode: RegionCode, productUrl: string): Promise<OfficialProductCandidate | null>`。
- Produces: `OfficialProductDiscoveryService.resolveRegions(selected: OfficialProductCandidate[], enabledRegions: RegionCode[]): Promise<RegionResolution[]>`，其中每个选中游戏在每区返回一个 `automatic` 候选、`needs-manual-selection` 或 `needs-manual-link` 状态。
- Produces: `POST /api/products/search`、`POST /api/products/resolve-link`、`POST /api/products/resolve-regions`，三者均为管理员专用只读端点。

- [x] **Step 1: 先写失败测试，覆盖默认区不可伪造、官方链接验证和香港区手动入口**

```ts
it("reads the configured default region instead of a browser supplied region", async () => {
  const result = await discovery.searchDefaultRegion("Overcooked");
  expect(search.search).toHaveBeenCalledWith("US", "Overcooked", expect.any(AbortSignal));
  expect(result.status).toBe("available");
});

it("accepts a verified official Hong Kong link but gives an official-link fallback when no regional search adapter exists", async () => {
  await expect(discovery.resolveOfficialLink("HK", "https://www.nintendo.com/hk/soft/verified-item")).resolves.toMatchObject({
    regionCode: "HK", productUrl: "https://www.nintendo.com/hk/soft/verified-item", currency: "HKD",
  });
  await expect(discovery.resolveRegions([usCandidate], ["US", "HK"])).resolves.toEqual([
    expect.objectContaining({ regionCode: "HK", status: "needs-manual-link" }),
  ]);
});

it("rejects an anonymous search and invalid official-link host without exposing external details", async () => {
  expect((await call("/api/products/search", { query: "Overcooked" })).status).toBe(401);
  const response = await callAsAdmin("/api/products/resolve-link", { regionCode: "US", productUrl: "https://example.test/item" });
  expect(response.status).toBe(422);
  await expect(response.json()).resolves.toEqual({ code: "VALIDATION_ERROR", error: "商品链接不是该区任天堂官方链接。" });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/official-nintendo-product-page.test.ts test/official-product-discovery-service.test.ts test/api-product-discovery.test.ts`

Expected: FAIL，因为解析器、发现服务与三个受保护端点尚不存在。

- [x] **Step 3: 实现官方 JSON-LD 链接解析与发现服务**

```ts
public async searchDefaultRegion(query: string): Promise<OfficialSearchResult> {
  const settings = await this.settings.get();
  if (!settings) throw new ProductDiscoveryError("应用尚未完成初始化。");
  return this.search.search(settings.defaultSearchRegion, query, new AbortController().signal);
}

public async resolveOfficialLink(regionCode: RegionCode, productUrl: string): Promise<OfficialProductCandidate | null> {
  // 链接先按地区白名单验证再请求，避免管理员输入让 Worker 成为任意主机的 SSRF 代理。
  if (!isOfficialNintendoProductUrl(regionCode, productUrl)) throw new ProductDiscoveryError("商品链接不是该区任天堂官方链接。");
  return this.pages.resolve(regionCode, productUrl, new AbortController().signal);
}

public async resolveRegions(selected: OfficialProductCandidate[], enabledRegions: RegionCode[]): Promise<RegionResolution[]> {
  return Promise.all(selected.flatMap((candidate) => enabledRegions
    .filter((regionCode) => regionCode !== candidate.regionCode)
    .map(async (regionCode) => this.matchRegion(candidate, regionCode))));
}
```

页面解析器复用 `official-nintendo.ts` 的 JSON-LD 安全读取原则，但返回候选身份与可选封面/价格，而不是采集快照。地区 URL 白名单以显式 `US`、`JP`、`MX`、`BR`、`HK` 主机和路径谓词实现；每个谓词都在测试夹具覆盖，拒绝子域名伪装、HTTP、空路径和跳转主机。自动匹配只在相应地区官方搜索适配器明确可用且标题、发行商（当两边均存在）和产品类型一致时返回 `automatic`；否则返回 `needs-manual-link`，不会猜测同名商品。

路由必须先 `requireAdmin`，再限制 `query` 去首尾空格后为 `1..100` 个字符；`resolve-regions` 中每个默认区候选与地区候选按共享 DTO 运行时收窄，重复地区返回 422。所有外部异常统一返回 `{ code: "INTERNAL_ERROR", error: "官方商品信息暂时无法获取，请稍后重试。" }`，不回显网络细节。

- [x] **Step 4: 运行发现、认证与来源预览回归测试**

Run: `npm test -- --run test/official-nintendo-product-page.test.ts test/official-product-discovery-service.test.ts test/api-product-discovery.test.ts test/api-product-preview.test.ts test/auth-guard.test.ts`

Expected: PASS，搜索和解析无 D1 写入；香港区能由官方链接进入既有来源预览。

- [x] **Step 5: 提交发现与确认 API**

```bash
git add src/worker/providers/official-nintendo-product-page.ts src/worker/services/official-product-discovery-service.ts src/worker/routes/product-routes.ts src/worker/index.ts test/official-nintendo-product-page.test.ts test/official-product-discovery-service.test.ts test/api-product-discovery.test.ts
git commit -m "feat: add official product discovery routes"
```

### Task 3: 原子化确认多个订阅并保留既有订阅

**Files:**
- Create: `src/worker/repositories/subscription-confirmation-repository.ts`
- Create: `src/worker/services/subscription-confirmation-service.ts`
- Modify: `src/worker/routes/product-routes.ts`
- Modify: `src/worker/index.ts`
- Test: `test/subscription-confirmation-service.test.ts`
- Test: `test/api-product-discovery.test.ts`

**Interfaces:**
- Produces: `ConfirmedSubscriptionInput = { selected: OfficialProductCandidate; regions: ConfirmedRegionalProduct[] }`，其中 `ConfirmedRegionalProduct` 额外含 `matchSource: "automatic" | "manual_selection" | "manual_link"`。
- Produces: `SubscriptionConfirmationResult = { gameId: string; subscriptionId: string; status: "created" | "existing" }`。
- Produces: `SubscriptionConfirmationService.confirm(inputs: ConfirmedSubscriptionInput[], now: string): Promise<SubscriptionConfirmationResult[]>`。
- Produces: `POST /api/products/confirm-subscriptions`，请求 `{ subscriptions: ConfirmedSubscriptionInput[] }`，响应 `{ subscriptions: SubscriptionConfirmationResult[] }`。

- [x] **Step 1: 先写失败测试，锁定全批失败、批量新建与既有订阅不变**

```ts
it("writes no game, regional product, or subscription when one item has a duplicate regional mapping", async () => {
  await expect(service.confirm([validOvercooked, invalidDuplicateUs], now)).rejects.toThrow("每个游戏在每区只能确认一个商品。");
  await expect(counts()).resolves.toEqual({ games: 0, products: 0, subscriptions: 0 });
});

it("creates two independent subscriptions in one atomic confirmation", async () => {
  await expect(service.confirm([validOvercooked, validKirby], now)).resolves.toEqual([
    expect.objectContaining({ status: "created" }),
    expect.objectContaining({ status: "created" }),
  ]);
  await expect(counts()).resolves.toEqual({ games: 2, products: 4, subscriptions: 2 });
});

it("returns an existing subscription and never replaces its regions", async () => {
  await seedExistingSubscription();
  await expect(service.confirm([validOvercooked], now)).resolves.toEqual([
    { gameId: "game-overcooked", subscriptionId: "subscription-overcooked", status: "existing" },
  ]);
  await expect(existingRegionIds()).resolves.toEqual(["product-overcooked-us"]);
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/subscription-confirmation-service.test.ts test/api-product-discovery.test.ts`

Expected: FAIL，因为确认服务、原子仓储与最终确认路由尚不存在。

- [x] **Step 3: 实现重新验证与 D1 批量写入**

```ts
public async confirm(inputs: ConfirmedSubscriptionInput[], now: string): Promise<SubscriptionConfirmationResult[]> {
  const validated = await Promise.all(inputs.map((input) => this.validate(input)));
  // 所有候选先完成身份、地区、货币、官方 URL 和价格 ID 验证，任何失败都发生在 D1 批次之前。
  return this.repository.confirmAtomically(validated, now);
}

public async confirmAtomically(inputs: ValidatedSubscriptionInput[], now: string): Promise<SubscriptionConfirmationResult[]> {
  const existing = await this.findExistingSubscriptions(inputs);
  const creations = inputs.filter((input) => !existing.has(input.game.normalizedName));
  await this.database.batch(creations.flatMap((input) => [
    this.database.prepare("INSERT INTO games (id, name_zh, name_en, normalized_name, publisher, product_type, cover_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(input.game.id, input.game.nameZh, input.game.nameEn, input.game.normalizedName, input.game.publisher, input.game.productType, input.game.coverUrl, now),
    ...input.regions.map((region) => this.database.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, official_product_id, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)")
      .bind(region.id, input.game.id, region.regionCode, region.currency, region.officialPriceId, region.productUrl, region.matchSource, now)),
    this.database.prepare("INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
      .bind(input.subscriptionId, input.game.id, now, now),
    ...input.regions.map((region) => this.database.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)")
      .bind(input.subscriptionId, region.id)),
  ]));
  return inputs.map((input) => existing.get(input.game.normalizedName) ?? { gameId: input.game.id, subscriptionId: input.subscriptionId, status: "created" });
}
```

`validate` 必须再次调用官方链接解析器而非信任浏览器的标题、价格或发行商；解析后仅允许受控匹配来源，确保本体/DLC/升级包不混写。逻辑游戏的 `normalized_name` 使用标题、发行商（可空）和类型构成稳定规范化身份；确认一批内重复身份、重复地区及不存在/禁用监控来源均在调用仓储前抛出中文 `SubscriptionConfirmationError`。仓储先查询既有 `normalized_name`，既有记录完全不进入 D1 写入数组，最终按输入顺序返回 `existing` 或 `created`。若 D1 任一语句失败，`database.batch` 的原子语义确保无部分新建记录。

路由只接受非空 `subscriptions` 数组、每项至少一个地区、受控 `matchSource`、HTTPS 官方链接与受控商品类型；验证错误返回 422。路由构造服务时复用任务 2 的页面解析器和既有 `OfficialPriceIdService`，确保日区 ID 在写入前二次验证；其他区仅保留 `null`，由既有来源预览规则决定是否监控。

- [x] **Step 4: 运行确认、订阅和来源预览回归测试**

Run: `npm test -- --run test/subscription-confirmation-service.test.ts test/api-product-discovery.test.ts test/api-subscriptions.test.ts test/api-product-preview.test.ts`

Expected: PASS，整批无效时四张业务表计数保持不变；既有订阅的地区关联不被修改。

- [x] **Step 5: 提交原子批量确认**

```bash
git add src/shared/domain.ts src/worker/repositories/subscription-confirmation-repository.ts src/worker/services/subscription-confirmation-service.ts src/worker/routes/product-routes.ts src/worker/index.ts migrations/0005_subscription_confirmation.sql test/subscription-confirmation-service.test.ts test/api-product-discovery.test.ts test/apply-migrations.ts
git commit -m "feat: confirm subscriptions atomically"
```

### Task 4: 构建添加订阅向导与三列官方候选卡

**Files:**
- Create: `src/app/api-client.ts`
- Create: `src/app/subscription-wizard.ts`
- Modify: `src/app/App.tsx`
- Modify: `src/app/styles.css`
- Test: `test/subscription-wizard.test.ts`

**Interfaces:**
- Produces: `SubscriptionWizardState`，至少含 `query`、`searchResult`、`selectedCandidateKeys`、`regionalConfirmations`、`sourcePreviews`、`submitState`。
- Produces: `toggleCandidate(state: SubscriptionWizardState, key: string): SubscriptionWizardState`；多选仅按候选唯一键切换，绝不替换其他选择。
- Produces: `candidatePriceLabel(candidate: OfficialProductCandidate): CandidatePriceLabel`，返回 `kind: "sale" | "current" | "pending"` 与显示所需金额/折扣。
- Consumes: `searchProducts`、`resolveOfficialLink`、`resolveRegions`、`previewSources`、`confirmSubscriptions`，均来自 `api-client.ts` 的同源 API 调用。

- [x] **Step 1: 先写失败测试，覆盖多选、价格文案与单游戏单区隔离**

```ts
it("toggles whole cards independently so two selected games remain selected", () => {
  const first = toggleCandidate(initialStateWithResults, "US:overcooked");
  const second = toggleCandidate(first, "US:kirby");
  expect(second.selectedCandidateKeys).toEqual(["US:overcooked", "US:kirby"]);
  expect(toggleCandidate(second, "US:overcooked").selectedCandidateKeys).toEqual(["US:kirby"]);
});

it("shows a struck regular price, sale price and discount only when the verified sale is lower", () => {
  expect(candidatePriceLabel({ ...candidate, currentPriceMinor: 999, regularPriceMinor: 2499 })).toEqual({
    kind: "sale", regularMinor: 2499, currentMinor: 999, discountPercent: 60,
  });
  expect(candidatePriceLabel({ ...candidate, currentPriceMinor: null, regularPriceMinor: null })).toEqual({ kind: "pending" });
});

it("stores a Hong Kong confirmation under its own selected-game key", () => {
  const state = setRegionalCandidate(initialWithTwoGames, "US:kirby", "HK", hkCandidate);
  expect(state.regionalConfirmations["US:kirby:HK"]).toEqual(hkCandidate);
  expect(state.regionalConfirmations["US:overcooked:HK"]).toBeUndefined();
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/subscription-wizard.test.ts`

Expected: FAIL，因为状态机与价格显示模型尚不存在。

- [x] **Step 3: 实现纯状态机、受保护 API 客户端和无直接外链的 React 界面**

```ts
export function candidatePriceLabel(candidate: OfficialProductCandidate): CandidatePriceLabel {
  if (candidate.currentPriceMinor === null) return { kind: "pending" };
  if (candidate.regularPriceMinor !== null && candidate.currentPriceMinor < candidate.regularPriceMinor) {
    return {
      kind: "sale",
      regularMinor: candidate.regularPriceMinor,
      currentMinor: candidate.currentPriceMinor,
      discountPercent: Math.round((1 - candidate.currentPriceMinor / candidate.regularPriceMinor) * 100),
    };
  }
  return { kind: "current", currentMinor: candidate.currentPriceMinor };
}

export function toggleCandidate(state: SubscriptionWizardState, key: string): SubscriptionWizardState {
  const selected = state.selectedCandidateKeys.includes(key)
    ? state.selectedCandidateKeys.filter((item) => item !== key)
    : [...state.selectedCandidateKeys, key];
  return { ...state, selectedCandidateKeys: selected };
}
```

`api-client.ts` 只能向 `/api/products/*` 发送 JSON 并设置 `credentials: "same-origin"`；将非 2xx 响应转换为系统中文摘要，组件不拼接任天堂、第三方或 Telegram URL。`App.tsx` 以无敏感的登录态/初始化态为入口，添加订阅区域依次呈现名称输入、官方候选、多选后的逐游戏地区确认、来源预览、批量确认结果。官方搜索不可用时显示同一默认区的官方链接输入框；其他已启用地区（含香港）显示“选择官方候选”与“粘贴官方链接”两种入口，但每游戏每区只能存一项确认。

样式必须精确实现：`.candidate-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }`，`@media (max-width: 880px)` 改为两列，`@media (max-width: 560px)` 改为一列；整张 `button` 卡片可点击，选中时 `border: 3px solid var(--accent-warm)`。封面为 `54px × 72px`；文字列相对封面上缘 `2px` 放置标题、中间位置放置左对齐商品类型、下缘 `2px` 放置发行商。底行用 `display: flex; justify-content: space-between` 使发行商在左、价格在右；促销常规价使用 `text-decoration: line-through`，促销价和折扣使用强调色，价格未知只显示“价格待确认”。封面加载失败时用 CSS 占位元素替换图片，不影响按钮可点击性或文字可读性。

- [x] **Step 4: 运行前端纯逻辑、类型检查与生产构建**

Run: `npm test -- --run test/subscription-wizard.test.ts && npx tsc --noEmit && npm run build`

Expected: PASS，两个商品可同时选择，折扣仅在真实促销时出现，生产构建不含任天堂直接请求代码。

- [x] **Step 5: 提交订阅向导与候选卡**

```bash
git add src/app/api-client.ts src/app/subscription-wizard.ts src/app/App.tsx src/app/styles.css test/subscription-wizard.test.ts
git commit -m "feat: add subscription discovery wizard"
```

### Task 5: 同步工程文档、进行端到端验证并完成发布前检查

**Files:**
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/architecture/data-model.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/plans/2026-07-17-official-subscription-discovery.md`

**Interfaces:**
- Documents: 三个只读发现端点与一个原子确认端点的请求、响应、401/422 安全规则。
- Documents: `normalized_name` 的订阅去重用途、确认前无写入与批量原子性。
- Documents: 需求 `FR-001` 的实现状态与可验证验收用例。

- [x] **Step 1: 写入失败验收清单并补齐 API 文档的精确合同**

```markdown
| `POST /api/products/search` | 已登录管理员 | 只读取服务端设置的默认搜索区；返回任天堂官方候选或官方链接输入提示；不写 D1。 |
| `POST /api/products/resolve-link` | 已登录管理员 | 验证一个指定地区的任天堂官方 HTTPS 商品链接，返回瞬时候选；不写 D1。 |
| `POST /api/products/resolve-regions` | 已登录管理员 | 对每个已选游戏分别返回其他启用地区的自动映射或人工官方确认入口；不写 D1。 |
| `POST /api/products/confirm-subscriptions` | 已登录管理员 | 重新验证整批候选后原子写入新游戏/地区商品/订阅；既有订阅仅返回，不改写地区。 |
```

将下列验收步骤加入质量文档：匿名调用四端点均为 401；空查询、伪造主机、重复地区与身份冲突均为 422；搜索/解析/预览前后四张业务表的行数不变；两游戏批量创建后两个订阅都可在仪表盘查询；一项无效时两个订阅均不创建；香港区只能以本区官方候选或官方链接加入；候选卡在 1280px 三列、768px 两列、480px 一列且文字对比度可读。

- [x] **Step 2: 运行文档引用与全量质量门禁**

Run: `rg -n "POST /api/products/(search|resolve-link|resolve-regions|confirm-subscriptions)" docs src test && npm test -- --run && npx tsc --noEmit && npm run build && git diff --check`

Expected: 所有四个端点在文档、Worker 与测试中均有对应记录；全量测试、类型检查、构建和差异检查全部通过。

- [x] **Step 3: 人工检查注释与无秘密边界**

```bash
rg -n "TODO|TBD|telegram.*token|bot[_-]?token|api[_-]?key|password|recovery" src test migrations docs
git diff --check
git status --short
```

Expected: 不新增 `TODO`/`TBD`、真实凭据或恢复码；新增外部请求、认证、原子写入和价格来源代码均含中文详细注释，且工作区只包含预期改动。

- [x] **Step 4: 标注实施计划完成并提交文档**

将本计划的所有任务复选框改为 `[x]`，在顶部增加“实施状态”段落，说明美区官方名称搜索已接入、其他地区按验证状态回退官方链接，且候选发现从不使用第三方价格站。随后执行：

```bash
git add docs/architecture/api-design.md docs/architecture/data-model.md docs/requirements/traceability.md docs/quality/quality-and-acceptance.md docs/README.md docs/superpowers/plans/2026-07-17-official-subscription-discovery.md
git commit -m "docs: document subscription discovery flow"
```
