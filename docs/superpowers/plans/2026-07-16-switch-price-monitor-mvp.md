# Switch Price Monitor MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a single-admin, Chinese-language Switch eShop price monitor with multi-region subscriptions, official-first collection, price history, and Telegram reports.

**Architecture:** A React SPA is bundled with Vite and served with a single Cloudflare Worker. The Worker owns all API routes, scheduled collection/report work, external provider calls, and D1 access. Domain services are pure TypeScript where possible; Cloudflare bindings enter only through small repository and gateway adapters.

**Tech Stack:** TypeScript (strict), React, Vite with `@cloudflare/vite-plugin`, Cloudflare Workers Static Assets, Cloudflare D1, Cron Triggers, Cloudflare Secrets, Vitest `^4.1.0` with `@cloudflare/vitest-pool-workers` `^0.18.5`.

## Global Constraints

- All UI and Telegram copy is Simplified Chinese.
- First-run setup must collect an administrator password, at least one of US/JP/MX/BR/HK as enabled regions, and a default search region from that selection.
- Official Nintendo prices are the only source that may trigger immediate price-drop alerts; third-party prices must show their source and are daily-report-only.
- Price collection occurs every six hours; manual refresh has a 15-minute cooldown; daily report defaults to `Asia/Shanghai` 09:00.
- Preserve price history by the selected policy; delete fetch logs after 90 days.
- Never return, log, export, or commit passwords, recovery codes, Telegram credentials, or other secrets.
- Before each task, read `AGENTS.md` and `docs/README.md`; every new or modified source, test, SQL migration and configuration file requires accurate, detailed Chinese comments explaining responsibility and key business/security constraints.
- Use `apply_patch` for source edits, test each task before committing, and do not deploy until all acceptance checks pass.

---

## File Structure

```text
src/
  app/                         # React screens, API client and theme tokens
  shared/                      # domain types and pure money/date rules
  worker/
    index.ts                   # fetch + scheduled Worker entry point
    routes/                    # HTTP route handlers and request validation
    services/                  # auth, subscription, collection, report services
    providers/                 # official/third-party/rate provider adapters
    repositories/              # D1 persistence adapters
migrations/                    # numbered D1 SQL migrations
test/                          # Worker integration tests and provider fixtures
docs/                          # approved requirements and operating documentation
```

## Task 1: Scaffold the Worker, SPA, and Worker-native test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.mts`, `wrangler.jsonc`, `.gitignore`
- Create: `src/worker/index.ts`, `src/app/main.tsx`, `src/app/App.tsx`, `src/app/styles.css`
- Create: `test/health.test.ts`, `test/apply-migrations.ts`

**Interfaces:**
- Produces `Env` in `src/worker/index.ts` with `DB: D1Database`, `ASSETS: Fetcher`, and the runtime secret names.
- Produces `GET /api/health` → `{ ok: true, service: "switch-price-monitor" }`.

- [ ] **Step 1: Write the failing Worker health test**

```ts
import { describe, expect, it } from "vitest";
import worker from "../src/worker";

describe("GET /api/health", () => {
  it("returns a stable health payload", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/health"), {} as Env, {} as ExecutionContext);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "switch-price-monitor" });
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- --run test/health.test.ts`  
Expected: FAIL because `src/worker/index.ts` does not exist.

- [ ] **Step 3: Implement the smallest Worker route and SPA shell**

```ts
// src/worker/index.ts
export interface Env { DB: D1Database; ASSETS: Fetcher }
const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/health") {
      return Response.json({ ok: true, service: "switch-price-monitor" });
    }
    return env.ASSETS.fetch(request);
  },
};
export default worker;
```

Configure the Vite Cloudflare plugin, SPA fallback, strict TypeScript, D1 binding, local `.dev.vars*` exclusion, and a Vitest Workers pool. `App.tsx` renders only `<main>正在初始化价格监控站…</main>` until Task 8.

- [ ] **Step 4: Run quality gates**

Run: `npm test -- --run test/health.test.ts && npm run build`  
Expected: health test PASS and a deployable Worker build completes.

- [ ] **Step 5: Commit the independently runnable scaffold**

```bash
git add package.json tsconfig.json vite.config.ts vitest.config.mts wrangler.jsonc .gitignore src test
git commit -m "chore: scaffold Cloudflare React Worker app"
```

## Task 2: Create the D1 schema and repository primitives

**Files:**
- Create: `migrations/0001_core.sql`, `migrations/0002_price_tracking.sql`
- Create: `src/shared/domain.ts`, `src/worker/repositories/settings-repository.ts`, `src/worker/repositories/subscription-repository.ts`, `src/worker/repositories/price-repository.ts`
- Create: `test/schema-and-repositories.test.ts`

**Interfaces:**
- `SettingsRepository.get(): Promise<AppSettings | null>` and `saveInitial(input: InitialSettings): Promise<void>`.
- `PriceRepository.append(snapshot: PriceSnapshot): Promise<void>` and `lowestForSubscription(subscriptionId: string): Promise<HistoricalLow[]>`.

- [ ] **Step 1: Write migration-backed repository tests**

```ts
it("keeps an immutable price history and returns regional lows", async () => {
  await prices.append({ regionalProductId: "jp-1", amountMinor: 1000, currency: "JPY", cnyFen: 4174, source: "official", capturedAt: "2026-07-16T00:00:00Z" });
  await prices.append({ regionalProductId: "jp-1", amountMinor: 800, currency: "JPY", cnyFen: 3339, source: "official", capturedAt: "2026-07-17T00:00:00Z" });
  await expect(prices.lowestForSubscription("sub-1")).resolves.toContainEqual(expect.objectContaining({ regionCode: "JP", amountMinor: 800 }));
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- --run test/schema-and-repositories.test.ts`  
Expected: FAIL because migrations and repositories do not exist.

- [ ] **Step 3: Implement migrations and repositories**

`0001_core.sql` creates settings, credentials, sessions, games, regional_products, subscriptions and subscription_region_targets. `0002_price_tracking.sql` creates price_snapshots, exchange_rates, fetch_logs, regional_product_health and notification_events, including indexes on `(regional_product_id, captured_at DESC)` and `(subscription_id, status)`. Store monetary values as integer minor units and CNY as integer fen.

```ts
export type PriceSource = "official" | "eshop-prices" | "ntprices" | "deku-deals" | "green-pipe";
export interface PriceSnapshot { regionalProductId: string; amountMinor: number; currency: string; cnyFen: number | null; source: PriceSource; capturedAt: string; }
```

- [ ] **Step 4: Run database integration tests**

Run: `npm test -- --run test/schema-and-repositories.test.ts`  
Expected: PASS; each test receives an isolated D1 database with both migrations applied.

- [ ] **Step 5: Commit schema and persistence boundary**

```bash
git add migrations src/shared/domain.ts src/worker/repositories test/schema-and-repositories.test.ts test/apply-migrations.ts
git commit -m "feat: add D1 price monitoring schema"
```

## Task 3: Implement first-run setup, authentication, and session security

实施状态（2026-07-16）：认证服务、D1 迁移和 HTTP 接口已完成并通过测试；首次运行与登录页面将在 Task 8 的前端实现中接入。

**Files:**
- Create: `src/worker/services/auth-service.ts`, `src/worker/routes/auth-routes.ts`, `src/worker/repositories/auth-repository.ts`
- Create: `src/shared/regions.ts`
- Create: `test/auth.test.ts`

**Interfaces:**
- `POST /api/auth/initialize` accepts `{ password, enabledRegions, defaultSearchRegion }`.
- `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/recover`.
- `requireAdmin(request, env): Promise<AdminSession>` rejects invalid/missing sessions with `401`.

- [x] **Step 1: Write failing initialization and login tests**

```ts
it("requires the default search region to be selected during initialization", async () => {
  const response = await fetchApi("/api/auth/initialize", { password: "long-secret", enabledRegions: ["JP"], defaultSearchRegion: "US" });
  expect(response.status).toBe(422);
});

it("allows initialization once and issues an HttpOnly session after login", async () => {
  await expect(fetchApi("/api/auth/initialize", { password: "long-secret", enabledRegions: ["US", "JP"], defaultSearchRegion: "JP" })).resolves.toHaveProperty("status", 201);
  const login = await fetchApi("/api/auth/login", { password: "long-secret" });
  expect(login.headers.get("set-cookie")).toContain("HttpOnly");
});
```

- [x] **Step 2: Run the auth tests and verify failure**

Run: `npm test -- --run test/auth.test.ts`  
Expected: FAIL with missing authentication routes.

- [x] **Step 3: Implement password hashing, one-time setup and recovery code flow**

Use Web Crypto PBKDF2 with a random salt and a constant-time verification path. Persist only password/recovery-code hashes. Generate and return the recovery code only in the successful initialization response. Store sessions as random opaque tokens in a Secure, HttpOnly, SameSite=Lax cookie and keep only their SHA-256 hash in D1. For the confirmed single-administrator deployment, apply an account-level lock after five failures for fifteen minutes; do not persist IP addresses unnecessarily.

- [x] **Step 4: Run auth test suite**

Run: `npm test -- --run test/auth.test.ts`  
Expected: PASS; second initialization returns `409`, expired/revoked sessions return `401`, and recovery code is one-time use.

- [ ] **Step 5: Commit authentication vertical slice**

```bash
git add src/shared/regions.ts src/worker/services src/worker/routes/auth-routes.ts src/worker/repositories/auth-repository.ts test/auth.test.ts
git commit -m "feat: add administrator setup and authentication"
```

## Task 4: Validate provider feasibility and implement provider contracts

**Files:**
- Create: `docs/decisions/ADR-002-price-provider-validation.md`, `test/fixtures/providers/`
- Create: `src/worker/providers/types.ts`, `src/worker/providers/provider-chain.ts`, `src/worker/providers/official-nintendo.ts`, `src/worker/providers/third-party.ts`, `src/worker/providers/exchange-rate.ts`
- Create: `test/provider-chain.test.ts`

**Interfaces:**
- `PriceProvider.fetch(product: RegionalProduct): Promise<ProviderResult>`.
- `ProviderChain.fetch(product, enabledProviders): Promise<ProviderResult | null>`.
- `ExchangeRateProvider.getDailyRates(currencies: string[]): Promise<RateResult[]>`.

- [ ] **Step 1: Write fixtures and failing fallback tests**

```ts
it("returns a marked fallback price when official collection fails", async () => {
  const result = await chain.fetch(product, [officialFails, eshopPricesReturns("999", "JPY")]);
  expect(result).toMatchObject({ source: "eshop-prices", amountMinor: 999, currency: "JPY" });
});

it("rejects a result whose title or product type differs from the confirmed product", async () => {
  await expect(chain.fetch(product, [returnsWrongProductType])).resolves.toBeNull();
});
```

- [ ] **Step 2: Run provider tests and verify failure**

Run: `npm test -- --run test/provider-chain.test.ts`  
Expected: FAIL because provider interfaces are not implemented.

- [ ] **Step 3: Implement contracts, timeouts, retry and validation**

Implement a 15-second abort timeout, exactly one retry for network errors, sequential source priority, and canonical title/publisher/product-type validation. Create the ADR with five-region evidence for the confirmed official endpoint or documented limitation; record request shape, response fields, terms review date, and the chosen extraction method. Do not hard-code price results or scrape browser pages from the client.

- [ ] **Step 4: Run provider unit tests and a controlled five-region discovery command**

Run: `npm test -- --run test/provider-chain.test.ts`  
Expected: PASS.  
Run: `npm run providers:verify -- --product-config test/fixtures/providers/overcooked-2.json`  
Expected: creates no production records and writes `docs/decisions/ADR-002-price-provider-validation.md` with one verified result or a documented non-working source for each region.

- [ ] **Step 5: Commit provider boundary and evidence**

```bash
git add src/worker/providers test/fixtures/providers test/provider-chain.test.ts docs/decisions/ADR-002-price-provider-validation.md package.json
git commit -m "feat: add validated price provider chain"
```

## Task 5: Build collection, historical-low, target-price, and health services

**Files:**
- Create: `src/worker/services/collection-service.ts`, `src/worker/services/price-rules.ts`, `src/worker/services/retention-service.ts`
- Create: `test/collection-service.test.ts`, `test/price-rules.test.ts`

**Interfaces:**
- `collectSubscriptionRegion(input): Promise<CollectionOutcome>`.
- `evaluateOfficialDrop(previous, current): boolean`.
- `evaluateTarget(target, price, priorState): "trigger" | "reset" | "none"`.

- [ ] **Step 1: Write failing collection and alert-rule tests**

```ts
it("does not create an immediate alert for a third-party drop", () => {
  expect(evaluateOfficialDrop({ amountMinor: 1000, source: "official" }, { amountMinor: 800, source: "ntprices" })).toBe(false);
});

it("triggers a target only on the first crossing and resets after recovery", () => {
  expect(evaluateTarget(5000, 4900, "unmet")).toBe("trigger");
  expect(evaluateTarget(5000, 4800, "met")).toBe("none");
  expect(evaluateTarget(5000, 5100, "met")).toBe("reset");
});
```

- [ ] **Step 2: Run price-rule tests and verify failure**

Run: `npm test -- --run test/price-rules.test.ts test/collection-service.test.ts`  
Expected: FAIL because collection and rule services do not exist.

- [ ] **Step 3: Implement immutable collection flow**

Fetch the day’s rates once, collect each enabled region through the provider chain, append source-tagged snapshots, calculate CNY fen and Oregon tax display fields, and retain the previous snapshot on total failure. Maintain health counters; notify state changes at exactly three consecutive failures and the next recovery. Query historical lows by region plus the all-region lowest CNY snapshot.

- [ ] **Step 4: Run service tests**

Run: `npm test -- --run test/price-rules.test.ts test/collection-service.test.ts`  
Expected: PASS, including stale price/rate behavior and historical-low values.

- [ ] **Step 5: Commit the price engine**

```bash
git add src/worker/services src/worker/repositories test/collection-service.test.ts test/price-rules.test.ts
git commit -m "feat: add price collection and monitoring rules"
```

## Task 6: Add subscription, settings, dashboard, history, and export APIs

**Files:**
- Create: `src/worker/routes/subscription-routes.ts`, `src/worker/routes/settings-routes.ts`, `src/worker/routes/dashboard-routes.ts`, `src/worker/routes/export-routes.ts`
- Create: `src/worker/services/subscription-service.ts`, `src/worker/services/export-service.ts`
- Create: `test/api-subscriptions.test.ts`, `test/api-settings-and-export.test.ts`

**Interfaces:**
- `POST /api/search`, `POST /api/subscriptions`, `PATCH /api/subscriptions/:id`, `POST /api/subscriptions/:id/disable`.
- `GET /api/dashboard`, `GET /api/history?subscriptionId=&region=`.
- `GET /api/export?kind=subscriptions|prices|fetch-logs`.

- [ ] **Step 1: Write failing protected API tests**

```ts
it("opens an existing subscription instead of inserting a duplicate", async () => {
  const first = await createSubscription({ gameId: "overcooked-2", regions: ["JP"] });
  const second = await createSubscription({ gameId: "overcooked-2", regions: ["US"] });
  expect(second).toMatchObject({ subscriptionId: first.subscriptionId, created: false });
});

it("does not export secrets", async () => {
  const csv = await authenticatedText("/api/export?kind=prices");
  expect(csv).not.toMatch(/BOT_TOKEN|password_hash|recovery_code/i);
});
```

- [ ] **Step 2: Run API tests and verify failure**

Run: `npm test -- --run test/api-subscriptions.test.ts test/api-settings-and-export.test.ts`  
Expected: FAIL because route handlers do not exist.

- [ ] **Step 3: Implement route handlers and validation**

Require `requireAdmin` for every route except auth. Validate enabled/default regions, 15-minute manual-refresh cooldown, all three theme values, source ordering, retention selection, and CSV kind. Use streaming CSV rows for price history; soft-disable subscriptions and expose re-enable via `PATCH`.

- [ ] **Step 4: Run API integration tests**

Run: `npm test -- --run test/api-subscriptions.test.ts test/api-settings-and-export.test.ts`  
Expected: PASS; unauthenticated requests return `401`, duplicate subscription is not created, and CSV contains headers but no secret fields.

- [ ] **Step 5: Commit the management API**

```bash
git add src/worker/routes src/worker/services src/worker/repositories test/api-subscriptions.test.ts test/api-settings-and-export.test.ts
git commit -m "feat: add subscription settings and export APIs"
```

## Task 7: Implement scheduled reports and Telegram delivery

**Files:**
- Create: `src/worker/services/report-service.ts`, `src/worker/services/telegram-service.ts`, `src/worker/services/scheduler-service.ts`
- Modify: `src/worker/index.ts`
- Create: `test/report-service.test.ts`, `test/scheduled-handler.test.ts`

**Interfaces:**
- `buildDailyReport(input): TelegramMessage[]`.
- `sendTelegram(messages): Promise<DeliveryResult[]>`.
- `runScheduled(now, env): Promise<void>`.

- [ ] **Step 1: Write failing report formatting tests**

```ts
it("includes each game current prices and historical lows, then splits long reports", () => {
  const messages = buildDailyReport({ subscriptions: thirtySubscriptions, timezone: "Asia/Shanghai", generatedAt: "2026-07-16T01:00:00Z" });
  expect(messages.length).toBeGreaterThan(1);
  expect(messages[0].text).toContain("历史最低");
  expect(messages[0].text).toContain("第三方：eShop-Prices");
});
```

- [ ] **Step 2: Run report tests and verify failure**

Run: `npm test -- --run test/report-service.test.ts test/scheduled-handler.test.ts`  
Expected: FAIL because the scheduler and Telegram service do not exist.

- [ ] **Step 3: Implement report and scheduled event handling**

Configure six-hour collection Cron Triggers plus a periodic dispatch Cron. In `scheduled()`, run collection, cleanup, immediate official-alert aggregation, health notifications, and report delivery when the configured local minute matches. Format all copy in Chinese; include every game’s current region prices plus all-region and regional historical lows; split messages below Telegram’s 4096-character limit with `第 n/m 页`.

- [ ] **Step 4: Run scheduler tests with mocked Telegram fetch**

Run: `npm test -- --run test/report-service.test.ts test/scheduled-handler.test.ts`  
Expected: PASS; third-party drops do not send immediate messages, three failures send one alert, recovery sends one message, and the report has historical lows.

- [ ] **Step 5: Commit scheduling and notification delivery**

```bash
git add src/worker/index.ts src/worker/services test/report-service.test.ts test/scheduled-handler.test.ts wrangler.jsonc
git commit -m "feat: add Telegram reports and scheduled monitoring"
```

## Task 8: Build the administrator UI and complete end-to-end verification

**Files:**
- Create: `src/app/api.ts`, `src/app/auth/SetupPage.tsx`, `src/app/auth/LoginPage.tsx`
- Create: `src/app/layout/AppShell.tsx`, `src/app/pages/DashboardPage.tsx`, `src/app/pages/SubscriptionsPage.tsx`, `src/app/pages/HistoryPage.tsx`, `src/app/pages/SettingsPage.tsx`
- Create: `src/app/components/PriceTable.tsx`, `src/app/components/PriceSourceBadge.tsx`, `src/app/components/HistoricalLow.tsx`, `src/app/theme.ts`
- Modify: `src/app/App.tsx`, `src/app/styles.css`
- Create: `test/ui/initialization.spec.ts`, `test/ui/dashboard.spec.ts`, `docs/operations/deployment-runbook.md`

**Interfaces:**
- `ApiClient.getDashboard(): Promise<DashboardResponse>`.
- `PriceTable` consumes `PriceView[]` with `source`, `isStale`, raw money and CNY display values.

- [ ] **Step 1: Write failing browser-level UI tests**

```ts
test("first run selects regions and a default search region", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("管理员密码").fill("long-secret");
  await page.getByLabel("日本区").check();
  await page.getByLabel("默认搜索区").selectOption("JP");
  await expect(page.getByRole("button", { name: "完成初始化" })).toBeEnabled();
});

test("dashboard distinguishes official, third-party and stale prices", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByText("第三方：eShop-Prices")).toBeVisible();
  await expect(page.getByText("数据可能过期")).toBeVisible();
});
```

- [ ] **Step 2: Run UI tests and verify failure**

Run: `npm run test:e2e -- test/ui/initialization.spec.ts test/ui/dashboard.spec.ts`  
Expected: FAIL because the application screens do not exist.

- [ ] **Step 3: Implement the complete responsive UI**

Build the Chinese-only pages with fixed desktop left navigation. Use `warm-card` as the initial CSS-variable theme and expose `calm-dark` and `clean-light` in settings. The dashboard shows last update, next report, manual refresh cooldown, raw/cny/tax prices, source badge, stale state, historical lows, and subscription actions. Settings exposes all approved controls, including provider ordering and Telegram test. Do not expose secret values after save.

- [ ] **Step 4: Run all verification**

Run: `npm test -- --run && npm run build && npm run test:e2e`  
Expected: all unit/integration/UI tests PASS and the Worker SPA build completes.

- [ ] **Step 5: Write deployment runbook and perform staging acceptance**

Document exact D1 creation/migration, secret configuration, Cron setup, first-run initialization, five-region smoke test, Telegram test message, controlled refresh, CSV verification, and rollback steps in `docs/operations/deployment-runbook.md`. Execute those checks against staging before production deployment.

- [ ] **Step 6: Commit the UI and release documentation**

```bash
git add src/app test/ui docs/operations package.json
git commit -m "feat: add Switch price monitor administrator UI"
```

## Plan Self-Review

- Spec coverage: Tasks 1–3 cover platform, D1 and authentication; Tasks 4–5 cover provider validation, collection, history, targets and failures; Tasks 6–7 cover management APIs, export, scheduling and Telegram; Task 8 covers the approved UI and staging acceptance.
- Placeholder scan: no deferred implementation markers are present; the provider verification task produces a concrete ADR before production adapters are trusted.
- Type consistency: `PriceSnapshot`, `ProviderResult`, `AppSettings`, `HistoricalLow`, `Env`, `PriceProvider` and route contracts are defined by the task that first produces them and consumed only in later tasks.
