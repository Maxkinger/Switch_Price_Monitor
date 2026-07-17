# 五区真实价格采集实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让五区已确认商品通过独立的任天堂官方适配器完成真实定时与手动价格采集，并在官方不可用时安全记录过期状态；第三方回退只保留可配置的边界，本计划不解析未获准站点网页。

**Architecture:** Worker 在六小时 Cron 与已认领的手动刷新请求中调用同一个 `LiveCollectionRunner`。运行器从 D1 读取启用地区商品，以地区官方提供方注册表组装 `ProviderChain`，取得每日 CNY 汇率后写入不可变快照，并把每个成功或失败交给健康状态服务。JP 先试价格 API 再试官方 JSON-LD；US、MX、BR、HK 只试经过地区/币种/商品身份校验的官方 JSON-LD。未实现许可第三方适配器前，不创建虚假的第三方结果。

**Tech Stack:** TypeScript、Cloudflare Workers、Cloudflare D1、Vitest、Frankfurter v2 公共汇率 API。

## Global Constraints

- 每次代码、测试、SQL、配置或文档改动前完整阅读 `AGENTS.md` 和 `docs/README.md`。
- 所有新增或修改的源代码、测试、SQL 与配置使用与实现一致的中文详细注释；价格来源、汇率、采集失败和迁移必须说明安全或业务原因。
- 测试先行：每项实现都先写失败测试、确认失败、再写最小实现并运行对应测试。
- 任天堂官方请求仅在 Worker 服务端进行；不使用浏览器端抓取、无头浏览器或规避访问控制的方式。
- 每个外部请求经 `ProviderChain` 受 15 秒超时与一次网络重试保护；地区、币种、标题、发行商、商品类型及可用价格 ID 必须匹配。
- 未获 API 或书面许可的 eShop-Prices、NT Deals、Deku Deals、Green Pipe 不得实现网页解析器或发起真实请求；设置与提供方工厂只可明确显示“未接入”。
- 提交前向用户说明确切范围并获得确认；确认后同一操作完成 `git commit` 和 `git push origin main`。

---

### Task 1: 建立地区官方提供方注册表

**Files:**
- Create: `src/worker/providers/official-provider-registry.ts`
- Create: `test/official-provider-registry.test.ts`
- Modify: `src/worker/providers/official-nintendo-price-api.ts`
- Modify: `src/worker/providers/official-nintendo.ts`

**Interfaces:**
- Consumes: `RegionalProduct`、`PriceProvider`、`createNintendoPriceApiProvider()`、`createOfficialNintendoProvider()`。
- Produces: `createOfficialProviderRegistry(fetcher?: typeof fetch): { providersFor(product: RegionalProduct): PriceProvider[] }`。

- [x] **Step 1: 写入注册表失败测试**

```ts
it("uses the Japanese price API before the official page only for JP", async () => {
  const registry = createOfficialProviderRegistry(fetcher);
  expect(registry.providersFor(jpProduct).map((provider) => provider.source)).toEqual(["official", "official"]);
  expect(registry.providersFor(usProduct)).toHaveLength(1);
});

it("returns no provider for a product whose region and currency mapping is unsupported", () => {
  expect(createOfficialProviderRegistry().providersFor({ ...usProduct, currency: "JPY" })).toEqual([]);
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/official-provider-registry.test.ts`

Expected: FAIL，因为注册表模块不存在。

- [x] **Step 3: 实现最小地区注册表与解析边界**

```ts
const regionCurrencies: Record<RegionalProduct["regionCode"], string> = {
  US: "USD", JP: "JPY", MX: "MXN", BR: "BRL", HK: "HKD",
};

public providersFor(product: RegionalProduct): PriceProvider[] {
  if (regionCurrencies[product.regionCode] !== product.currency) return [];
  const page = createOfficialNintendoProvider(this.fetcher);
  return product.regionCode === "JP" ? [this.jpPriceApi, page] : [page];
}
```

保留 `ProviderChain` 既有身份验证；JP API 继续拒绝非 JP/JPY/无本区 ID 输入，官方页面解析器在没有可验证 JSON-LD 时返回 `null`，使调用方进入失败处理而非猜测金额。

- [x] **Step 4: 运行注册表与现有提供方回归测试**

Run: `npm test -- --run test/official-provider-registry.test.ts test/official-nintendo-price-api.test.ts test/official-nintendo.test.ts test/provider-chain.test.ts`

Expected: PASS。

- [x] **Step 5: 提交地区官方提供方注册表**

```bash
git add src/worker/providers/official-provider-registry.ts src/worker/providers/official-nintendo-price-api.ts src/worker/providers/official-nintendo.ts test/official-provider-registry.test.ts
git commit -m "feat: register regional official price providers"
```

### Task 2: 接入每日人民币汇率与过期回退

**Files:**
- Create: `src/worker/providers/frankfurter-exchange-rate.ts`
- Create: `src/worker/repositories/exchange-rate-repository.ts`
- Create: `src/worker/services/daily-cny-rate-service.ts`
- Create: `test/daily-cny-rate-service.test.ts`
- Modify: `test/apply-migrations.ts`

**Interfaces:**
- Consumes: `ExchangeRateProvider`、`exchange_rates`、五区币种。
- Produces: `DailyCnyRateService.get(currencies: string[], now: string): Promise<Map<string, DailyCnyRate>>`。

- [ ] **Step 1: 写入汇率成功、部分缺失与旧值回退失败测试**

```ts
it("writes one current CNY rate for each returned foreign currency", async () => {
  await expect(service.get(["USD", "JPY"], "2026-07-17T00:00:00.000Z"))
    .resolves.toEqual(new Map([["USD", { cnyRate: 6.8, isStale: false }], ["JPY", { cnyRate: 0.043, isStale: false }]]));
});

it("uses the most recent stored rate and marks it stale when the provider fails", async () => {
  await expect(service.get(["USD"], "2026-07-17T00:00:00.000Z"))
    .resolves.toEqual(new Map([["USD", { cnyRate: 6.7, isStale: true }]]));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/daily-cny-rate-service.test.ts`

Expected: FAIL，因为汇率仓储、Frankfurter 提供方和服务不存在。

- [ ] **Step 3: 实现汇率提供方、D1 读取写入与回退服务**

Frankfurter 提供方使用 `GET https://api.frankfurter.dev/v2/rates?base=CNY&quotes=USD,JPY,MXN,BRL,HKD`，将“每 1 CNY 可换外币”的响应取倒数，转为每 1 外币对应的 CNY。仅接受正的有限数字和请求币种；网络错误包装为 `ProviderNetworkError`。仓储追加成功汇率并按币种读取最新值；服务只对缺失或请求失败币种复用最新值并写入 `isStale: true` 的读取结果，不伪造当日来源时间。

- [ ] **Step 4: 运行汇率与采集服务回归测试**

Run: `npm test -- --run test/daily-cny-rate-service.test.ts test/collection-service.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交每日人民币汇率服务**

```bash
git add src/worker/providers/frankfurter-exchange-rate.ts src/worker/repositories/exchange-rate-repository.ts src/worker/services/daily-cny-rate-service.ts test/daily-cny-rate-service.test.ts
git commit -m "feat: collect daily CNY exchange rates"
```

### Task 3: 实现真实采集执行器与通知状态接线

**Files:**
- Create: `src/worker/services/live-collection-runner.ts`
- Create: `test/live-collection-runner.test.ts`
- Modify: `src/worker/repositories/collection-repository.ts`
- Modify: `src/worker/repositories/price-repository.ts`
- Modify: `src/worker/services/collection-service.ts`
- Modify: `src/worker/services/product-health-service.ts`

**Interfaces:**
- Consumes: `CollectionRepository.enabledRegionalProducts()`、`ProviderChain`、官方注册表、`DailyCnyRateService`、`CollectionService`、`ProductHealthService`。
- Produces: `LiveCollectionRunner.run(now: string): Promise<{ attempted: number; collected: number; stale: number }>`。

- [ ] **Step 1: 写入多地区成功、全失败与官方降价事件失败测试**

```ts
it("collects every enabled regional product and records health separately", async () => {
  await expect(runner.run("2026-07-17T00:00:00.000Z"))
    .resolves.toEqual({ attempted: 2, collected: 1, stale: 1 });
  expect(health.record).toHaveBeenNthCalledWith(1, "product-jp", true, "2026-07-17T00:00:00.000Z");
  expect(health.record).toHaveBeenNthCalledWith(2, "product-hk", false, "2026-07-17T00:00:00.000Z");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/live-collection-runner.test.ts`

Expected: FAIL，因为真实采集运行器不存在。

- [ ] **Step 3: 实现统一执行器**

```ts
for (const product of await this.products.enabledRegionalProducts()) {
  const outcome = await this.collection.collect({
    product,
    providers: this.officialRegistry.providersFor(product),
    rate: rates.get(product.currency) ?? null,
    capturedAt: now,
  });
  await this.health.record(product.id, outcome.kind === "collected", now);
}
```

执行器不得因单个商品的网络或解析失败中断其它地区。仅当 `outcome.source === "official"` 时读取上一条官方快照并调用 `evaluateOfficialDrop`；命中后通过 `NotificationEventRepository.reserve` 写入去重事件。扩展快照与仓储查询时必须保留来源、汇率和捕获时间，禁止更新历史行。

- [ ] **Step 4: 运行执行器、健康和通知回归测试**

Run: `npm test -- --run test/live-collection-runner.test.ts test/collection-service.test.ts test/product-health-service.test.ts test/notification-event-repository.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交真实采集执行器**

```bash
git add src/worker/services/live-collection-runner.ts src/worker/services/collection-service.ts src/worker/services/product-health-service.ts src/worker/repositories/collection-repository.ts src/worker/repositories/price-repository.ts test/live-collection-runner.test.ts
git commit -m "feat: run live regional price collection"
```

### Task 4: 将六小时 Cron 与手动刷新接入同一执行器

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `src/worker/services/scheduler-service.ts`
- Modify: `test/worker-maintenance.test.ts`
- Create: `test/worker-live-collection.test.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Consumes: `ManualRefreshRepository.claimQueued()`、`LiveCollectionRunner.run()`、`runScheduledMaintenance()`。
- Produces: `runSixHourCollection(now, dependencies): Promise<{ kind: "collection-completed" | "setup-not-complete"; manualRefreshConsumed: boolean }>`。

- [ ] **Step 1: 写入六小时 Cron 与手动刷新只运行一次的失败测试**

```ts
it("runs collection with maintenance for the six-hour Cron and consumes one queued refresh", async () => {
  await runSixHourCollection(now, { settings, maintenance, manualRefresh, collection });
  expect(collection.run).toHaveBeenCalledTimes(1);
  expect(manualRefresh.claimQueued).toHaveBeenCalledTimes(1);
});

it("does not run collection for an unknown Cron expression", async () => {
  await worker.scheduled!({ cron: "1 * * * *", scheduledTime } as ScheduledEvent, env, context);
  expect(waitUntil).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/worker-live-collection.test.ts test/worker-maintenance.test.ts`

Expected: FAIL，因为六小时入口仅执行保留清理。

- [ ] **Step 3: 实现调度接线**

在 `0 */6 * * *` 分支内创建一个单独 `waitUntil` Promise：先验证设置已初始化，再运行保留清理，原子认领一个手动刷新请求，并无论是否存在手动请求都只运行一次采集。保留每分钟日报与 pending 通知路径，不把价格请求放入每分钟 Cron。保留现有 Cron 表达式，修改注释说明其同时承担六小时采集和维护。

- [ ] **Step 4: 运行 Worker 调度回归测试**

Run: `npm test -- --run test/worker-live-collection.test.ts test/worker-maintenance.test.ts test/scheduler-service.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交定时与手动刷新接线**

```bash
git add src/worker/index.ts src/worker/services/scheduler-service.ts test/worker-maintenance.test.ts test/worker-live-collection.test.ts wrangler.jsonc
git commit -m "feat: schedule live price collection"
```

### Task 5: 明确第三方未接入状态、补齐 ADR 与端到端验证

**Files:**
- Create: `src/worker/providers/third-party-provider-registry.ts`
- Create: `test/third-party-provider-registry.test.ts`
- Modify: `docs/decisions/ADR-002-price-provider-validation.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/plans/2026-07-17-five-region-live-collection.md`

**Interfaces:**
- Consumes: 已声明的 `PriceSource` 和管理员来源排序。
- Produces: `createThirdPartyProviderRegistry(): { providersFor(sources): PriceProvider[]; unavailableSources: PriceSource[] }`，在本阶段永远返回空 `providersFor` 与明确不可用来源。

- [ ] **Step 1: 写入不发起未获准第三方网络请求的失败测试**

```ts
it("does not create a network provider for configured but unadmitted third-party sources", async () => {
  const registry = createThirdPartyProviderRegistry();
  expect(registry.providersFor(["eshop-prices", "nt-deals"])).toEqual([]);
  expect(registry.unavailableSources).toEqual(["eshop-prices", "nt-deals"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/third-party-provider-registry.test.ts`

Expected: FAIL，因为第三方注册表不存在。

- [ ] **Step 3: 实现禁用第三方边界与更新证据文档**

注册表只能返回空提供方数组，严禁 `fetch`、HTML 选择器或站点 URL。ADR-002 必须逐区记录官方 JSON-LD 或 JP API 的实测结果、测试日期、失败场景及“第三方未获授权，未接入”的状态；追踪表注明真实官方采集已实现、第三方实际回退仍待来源许可。

- [ ] **Step 4: 运行全量质量门禁与本地五区受控验收**

Run: `npm test -- --run && npx tsc --noEmit && npm run build && git diff --check`

Expected: 全部通过；测试使用模拟任天堂与汇率响应，绝不写入真实 Telegram 凭据或生产 D1。

- [ ] **Step 5: 标注计划完成并提交文档与来源边界**

```bash
git add src/worker/providers/third-party-provider-registry.ts test/third-party-provider-registry.test.ts docs/decisions/ADR-002-price-provider-validation.md docs/requirements/traceability.md docs/quality/quality-and-acceptance.md docs/README.md docs/superpowers/plans/2026-07-17-five-region-live-collection.md
git commit -m "docs: record live collection source boundaries"
```

## 计划自检

- **覆盖性：**Task 1 实现五区独立官方提供方；Task 2 提供每日人民币换算和过期回退；Task 3 接通快照、健康与通知；Task 4 接通 Cron 与手动刷新；Task 5 固化未获准第三方禁用边界、ADR 和验收。
- **无占位检查：**每项任务均定义具体文件、接口、测试和验收命令；第三方不具备许可时明确不发起请求，而不是以未定义的后续实现作为当前依赖。
- **类型一致性：**注册表只输出既有 `PriceProvider[]`；运行器只使用既有 `CollectionService.collect` 与 `ProductHealthService.record`；定时入口以 `LiveCollectionRunner.run` 作为唯一执行器。
