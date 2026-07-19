# 日区升级包 Browser Run 生产集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 未经管理员明确要求不得启用子代理；在当前会话内执行时使用 `superpowers:executing-plans`。

**Goal:** 在现有单一 Cloudflare Worker 中接入受控 Browser Run，使添加订阅可自动发现日区升级包，并在最终保存前重新验证官方关系，同时保留严格的人工官方链接兜底。

**Architecture:** 日区官方根商品查找器先从公开搜索 API 取得唯一 `upgrade: 1` 根；请求级 Browser Run 批处理器使用一个浏览器和最多三个全新无痕上下文串行提取唯一升级链接；关系服务再用任天堂日区价格 API 验证升级包 ID、币种、在售状态及当前/常规价。商品发现、人工链接和最终确认都通过窄接口消费该服务，Browser Binding 不进入价格采集、Cron、D1 或通知链路。

**Tech Stack:** TypeScript 5.8.3、Vitest 4.1.0、Cloudflare Workers、Cloudflare Browser Run、`@cloudflare/playwright` 1.3.0、Wrangler 4.112.0、`@cloudflare/workers-types` 5.20260714.1、React 19.1、D1。

## Global Constraints

- 每个代码、测试、配置或文档改动前完整阅读项目 `AGENTS.md` 与 `docs/README.md`。
- 所有新增或修改的源代码、测试、构建配置和运行配置必须包含中文详细注释，说明职责、关键约束、失败边界以及安全或业务原因；同次修正过期注释。
- 严格测试先行：每项行为先运行目标测试并确认因缺少目标实现而失败，再写最小实现并运行通过。
- 固定使用 `@cloudflare/playwright` 1.3.0、Wrangler 4.112.0、`@cloudflare/workers-types` 5.20260714.1、`compatibility_date` 2026-07-16、`nodejs_compat` 和名为 `BROWSER` 的 Browser Binding。
- Browser Run 只允许访问 `https://store-jp.nintendo.com/item/software/D数字/`；不登录、不点击验证码、不规避机器人控制、不访问第三方、不执行购物车或购买操作。
- 每个请求最多一个浏览器、三个全新无痕上下文，商品串行处理，单商品最多 30 秒，不自动重试，不跨请求复用 Session。
- 自动候选保存前必须重新验证根商品、唯一关系 URL 和 JP/JPY/在售/同 ID 价格；人工链接只有在浏览器失败且官方 URL/价格证据完整时才能保持 `manual_link` 兜底。
- 不新增 D1 表、缓存、Cron、队列、公开诊断接口或第二个 Worker；不把 Browser Run 接入价格采集、手动刷新、日报、历史或 Telegram。
- 不记录或返回 HTML、页面正文、Cookie、存储、队列令牌、请求/响应头、截图、Trace、HAR、Browser Session ID、异常堆栈或任何凭据。
- 任何本地提交前先列出准确范围并取得管理员明确确认；确认后同一操作完成 `git commit` 与 `git push origin main`。生产部署另行确认。

---

## 文件结构与职责

### 新建

- `src/worker/providers/official-japanese-upgrade-root.ts`：解析和请求日区官方 `upgrade: 1` 根商品，不向前端暴露原始响应。
- `src/worker/providers/japanese-upgrade-browser.ts`：请求级单浏览器/多无痕上下文协调、DOM 提取、官方 URL 规范化及安全失败归一化。
- `src/worker/services/japanese-upgrade-relation-service.ts`：组合根商品、Browser Run 和价格报价，提供自动发现、人工链接与最终批量确认三个窄方法。
- `test/official-japanese-upgrade-root.test.ts`：根商品外部响应和唯一身份测试。
- `test/japanese-upgrade-browser.test.ts`：浏览器生命周期、唯一链接、超时和失败关闭测试。
- `test/japanese-upgrade-relation-service.test.ts`：关系服务自动/人工/确认及价格证据测试。
- `test/browser-run-production-config.test.mjs`：依赖、兼容标志、Binding 和生产配置回归。

### 修改

- `src/worker/providers/official-nintendo-price-api.ts`：抽出可复用的官方当前价/常规价报价接口，原价格采集器复用同一严格解析。
- `src/worker/services/official-product-discovery-service.ts`：普通日区搜索失败后批量调用升级关系服务；人工日区升级链接使用带锚点的专用校验。
- `src/worker/services/subscription-confirmation-service.ts`：整批验证前一次性复核全部日区升级包，并把结果传入既有原子确认。
- `src/worker/services/japanese-subscription-confirmation-service.ts`：继续只负责普通日区游戏/组合商品；注释明确升级包由关系服务分流。
- `src/worker/routes/product-routes.ts`：手动链接请求携带已选锚点，保持运行时收窄；深度核验上限返回安全 `422`。
- `src/worker/index.ts`：构造 Browser、根、报价和关系服务，并只注入商品路由链。
- `src/app/api-client.ts`：手动链接 API 增加可选锚点，地区失败 DTO 保留安全说明。
- `src/app/subscription-wizard-page.tsx`：展示服务端失败说明并提供重新核验；沿用共享全局请求跟踪器。
- `wrangler.jsonc`、`package.json`、`package-lock.json`：加入已锁定 Browser Run 依赖和配置。
- `test/official-nintendo-price-api.test.ts`、`test/official-product-discovery-service.test.ts`、`test/subscription-confirmation-service.test.ts`、`test/api-product-discovery.test.ts`、`test/api-client.test.ts`、`test/subscription-wizard-page.test.tsx`：锁定新增接口和回归边界。
- `docs/README.md`、`docs/requirements/traceability.md`、`docs/quality/quality-and-acceptance.md`：实现完成后更新状态和验收证据。

---

### Task 1: 锁定 Browser Run 依赖与 Worker 配置

**Files:**
- Create: `test/browser-run-production-config.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `wrangler.jsonc`
- Modify: `src/worker/index.ts`

**Interfaces:**
- Produces: `Env.BROWSER: Fetcher`，供 Task 3 的浏览器适配器使用。
- Produces: Wrangler 配置中的 `browser.binding === "BROWSER"`、`nodejs_compat` 和固定依赖版本。

- [ ] **Step 1: 写入失败的生产配置测试**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production Worker pins the verified Browser Run stack", async () => {
  // 配置测试只读取受版本控制文件，不启动浏览器或部署，确保依赖升级不会绕过已验证的 CDP 组合。
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const wrangler = JSON.parse(stripJsonComments(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")));
  assert.equal(manifest.devDependencies["@cloudflare/playwright"], "1.3.0");
  assert.equal(manifest.devDependencies.wrangler, "4.112.0");
  assert.equal(manifest.devDependencies["@cloudflare/workers-types"], "5.20260714.1");
  assert.equal(wrangler.browser.binding, "BROWSER");
  assert.deepEqual(wrangler.compatibility_flags, ["nodejs_compat"]);
  assert.equal(wrangler.compatibility_date, "2026-07-16");
});

function stripJsonComments(value) {
  return value.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/browser-run-production-config.test.mjs`

Expected: FAIL，指出 `@cloudflare/playwright` 或 `browser` 配置缺失。

- [ ] **Step 3: 安装固定依赖并添加配置/类型**

Run: `npm install --save-dev --save-exact @cloudflare/playwright@1.3.0 wrangler@4.112.0 @cloudflare/workers-types@5.20260714.1`

在 `wrangler.jsonc` 保留现有 D1、Assets 和 Cron，并增加：

```jsonc
// Playwright 1.3.0 依赖 Workers 原生 node:fs 兼容层；该标志只提供运行时 API，不授权访问用户文件或 Secret。
"compatibility_flags": ["nodejs_compat"],
// Browser Binding 仅注入受认证商品发现与确认服务；Cron 和价格采集工厂不会接收此绑定。
"browser": {
  "binding": "BROWSER"
},
```

在 `Env` 中增加：

```ts
/** Browser Binding 只服务日区升级关系；不得传入价格采集、Cron、通知或前端响应。 */
BROWSER: Fetcher;
```

- [ ] **Step 4: 运行配置测试和类型检查并确认 GREEN**

Run: `node --test test/browser-run-production-config.test.mjs && npx tsc --noEmit`

Expected: 配置测试通过，TypeScript 退出码 0。

- [ ] **Step 5: 提交门禁**

向管理员列出 Task 1 的 5 个文件与依赖锁变更；取得明确确认后执行：

```bash
git add package.json package-lock.json wrangler.jsonc src/worker/index.ts test/browser-run-production-config.test.mjs
git commit -m "build: configure Browser Run production binding"
git push origin main
```

### Task 2: 解析并筛选唯一日区升级根商品

**Files:**
- Create: `src/worker/providers/official-japanese-upgrade-root.ts`
- Create: `test/official-japanese-upgrade-root.test.ts`

**Interfaces:**
- Produces: `JapaneseUpgradeRootCandidate`。
- Produces: `JapaneseUpgradeRootSearch.search(anchor, signal): Promise<JapaneseUpgradeRootCandidate | null>`。
- Consumes: `OfficialProductCandidate` 默认区升级包锚点。

- [ ] **Step 1: 写入失败测试**

```ts
it("returns the only official upgrade root with matching series and publisher", async () => {
  // 两条官方命中只有一条同时具备 upgrade:1、下载形态、Switch 2 Edition 与同发行商系列，不能按 API 顺序选择。
  const search = createOfficialJapaneseUpgradeRootSearch(async () => Response.json(japanesePayload([
    japaneseItem({ id: "70010000106252", upgrade: 1 }),
    japaneseItem({ id: "70010000109999", title: "別のゲーム Nintendo Switch 2 Edition", maker: "Other", upgrade: 1 }),
  ])));
  await expect(search.search(overcookedUpgradeUs(), new AbortController().signal)).resolves.toEqual({
    productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/",
    canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition",
    publisher: "Team17",
  });
});

it.each([0, 2])("fails closed when %i roots satisfy the complete identity", async (matchingCount) => {
  const items = Array.from({ length: matchingCount }, (_, index) => japaneseItem({ id: String(70010000106252 + index), upgrade: 1 }));
  const search = createOfficialJapaneseUpgradeRootSearch(async () => Response.json(japanesePayload(items)));
  await expect(search.search(overcookedUpgradeUs(), new AbortController().signal)).resolves.toBeNull();
});

function overcookedUpgradeUs(): OfficialProductCandidate {
  return { regionCode: "US", productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-nintendo-switch-2-edition-upgrade-pack-switch-2/", canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition Upgrade Pack", publisher: "Team17", productType: "upgrade-pack", currency: "USD", coverUrl: null, currentPriceMinor: 999, regularPriceMinor: null };
}

function japaneseItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = typeof overrides.id === "string" ? overrides.id : "70010000106252";
  return { id, nsuid: id, title: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition", maker: "Team17", sform: "BEE_DL", upgrade: 1, ...overrides };
}

function japanesePayload(items: unknown[]): unknown {
  return { result: { items } };
}
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run test/official-japanese-upgrade-root.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现最小根商品查找器**

```ts
export interface JapaneseUpgradeRootCandidate {
  productUrl: string;
  canonicalTitle: string;
  publisher: string;
}

export interface JapaneseUpgradeRootSearch {
  search(anchor: OfficialProductCandidate, signal: AbortSignal): Promise<JapaneseUpgradeRootCandidate | null>;
}

export function createOfficialJapaneseUpgradeRootSearch(fetchSearch: typeof fetch = fetch): JapaneseUpgradeRootSearch {
  return {
    async search(anchor, signal) {
      if (anchor.productType !== "upgrade-pack" || anchor.publisher === null) return null;
      const query = readUpgradeBaseTitle(anchor.canonicalTitle);
      if (query === null) return null;
      const url = new URL("https://search.nintendo.jp/nintendo_soft/search.json");
      url.search = new URLSearchParams({ q: query, limit: "20", page: "1", opt_search: "1" }).toString();
      const response = await fetchSearch(url, { headers: { accept: "application/json" }, signal });
      if (!response.ok) return null;
      const roots = parseRoots(await response.json()).filter((root) => hasMatchingRootIdentity(anchor, root));
      return roots.length === 1 ? roots[0] : null;
    },
  };
}
```

`parseRoots` 的准入条件必须等价于 `id === nsuid && /^\d+$/.test(id) && (sform === "BEE_DL" || sform === "HAC_DL") && upgrade === 1 && /nintendo\s+switch\s*2\s+edition/iu.test(title)`；标题和发行商还须为去除首尾空白后的非空字符串。`hasMatchingRootIdentity` 使用 NFKC、小写、商标符号移除和空白折叠比较发行商，并比较标题第一个含字母/数字的拉丁系列片段。

- [ ] **Step 4: 写入边界表格测试并确认 GREEN**

```ts
it.each([
  ["id/nsuid mismatch", japaneseItem({ nsuid: "70010000109999" })],
  ["unknown sform", japaneseItem({ sform: "CARD" })],
  ["missing upgrade flag", japaneseItem({ upgrade: 0 })],
  ["missing Switch 2 marker", japaneseItem({ title: "Overcooked® 2 - オーバークック２" })],
  ["publisher mismatch", japaneseItem({ maker: "Other" })],
])("rejects %s", async (_name, item) => {
  const search = createOfficialJapaneseUpgradeRootSearch(async () => Response.json(japanesePayload([item])));
  await expect(search.search(overcookedUpgradeUs(), new AbortController().signal)).resolves.toBeNull();
});
```

Run: `npx vitest run test/official-japanese-upgrade-root.test.ts`

Expected: 所有根商品测试通过。

- [ ] **Step 5: 提交门禁**

先取得管理员确认，再执行：

```bash
git add src/worker/providers/official-japanese-upgrade-root.ts test/official-japanese-upgrade-root.test.ts
git commit -m "feat: verify Japanese upgrade roots"
git push origin main
```

### Task 3: 提供日区官方当前价与常规价报价

**Files:**
- Modify: `src/worker/providers/official-nintendo-price-api.ts`
- Modify: `test/official-nintendo-price-api.test.ts`

**Interfaces:**
- Produces: `NintendoOfficialPriceQuote`。
- Produces: `NintendoOfficialPriceQuoteResolver.resolve(regionCode, currency, officialPriceId, signal)`。
- Existing: `createNintendoPriceApiProvider()` 复用相同请求和解析，不改变价格快照行为。

- [ ] **Step 1: 写入失败测试**

```ts
it("returns the current and regular JPY quote for an onsale matching title id", async () => {
  const quotes = createNintendoOfficialPriceQuoteResolver(async () => Response.json(pricePayload({
    titleId: 70050000064985,
    regularRawValue: "1000",
    discountRawValue: "700",
  })));
  await expect(quotes.resolve("JP", "JPY", "70050000064985", new AbortController().signal)).resolves.toEqual({
    officialPriceId: "70050000064985",
    currency: "JPY",
    currentPriceMinor: 700,
    regularPriceMinor: 1000,
  });
});

const validInput = { titleId: 70050000064985, regularRawValue: "1000", discountRawValue: "700" };

function pricePayload(input: typeof validInput): { country: string; prices: Array<Record<string, unknown>> } {
  return { country: "JP", prices: [{ title_id: input.titleId, sales_status: "onsale", regular_price: { currency: "JPY", raw_value: input.regularRawValue }, discount_price: { currency: "JPY", raw_value: input.discountRawValue } }] };
}
```

再加入完整拒绝表；每项调用 `resolve("JP", "JPY", "70050000064985", signal)` 并断言 `null`：

```ts
it.each([
  ["country", { ...pricePayload(validInput), country: "US" }],
  ["title id", pricePayload({ ...validInput, titleId: 70050000064986 })],
  ["sales status", { country: "JP", prices: [{ ...pricePayload(validInput).prices[0], sales_status: "notonsale" }] }],
  ["currency", { country: "JP", prices: [{ ...pricePayload(validInput).prices[0], discount_price: { currency: "USD", raw_value: "700" } }] }],
  ["non-integer", { country: "JP", prices: [{ ...pricePayload(validInput).prices[0], discount_price: { currency: "JPY", raw_value: "7.00" } }] }],
  ["discount above regular", pricePayload({ titleId: 70050000064985, regularRawValue: "700", discountRawValue: "1000" })],
])("rejects invalid %s evidence", async (_name, payload) => {
  const quotes = createNintendoOfficialPriceQuoteResolver(async () => Response.json(payload));
  await expect(quotes.resolve("JP", "JPY", "70050000064985", new AbortController().signal)).resolves.toBeNull();
});
```

- [ ] **Step 2: 运行目标测试并确认 RED**

Run: `npx vitest run test/official-nintendo-price-api.test.ts`

Expected: FAIL，`createNintendoOfficialPriceQuoteResolver` 尚未导出。

- [ ] **Step 3: 抽出报价解析并让现有提供方复用**

```ts
export interface NintendoOfficialPriceQuote {
  officialPriceId: string;
  currency: "JPY" | "HKD";
  currentPriceMinor: number;
  regularPriceMinor: number | null;
}

export interface NintendoOfficialPriceQuoteResolver {
  resolve(regionCode: RegionCode, currency: string, officialPriceId: string, signal: AbortSignal): Promise<NintendoOfficialPriceQuote | null>;
}

export function createNintendoOfficialPriceQuoteResolver(fetchPrice: typeof fetch = fetch): NintendoOfficialPriceQuoteResolver {
  return {
    async resolve(regionCode, currency, officialPriceId, signal) {
      const profile = priceApiProfiles[regionCode];
      if (!profile || profile.currency !== currency || !/^\d+$/.test(officialPriceId)) return null;
      const url = new URL("https://api.ec.nintendo.com/v1/price");
      url.search = new URLSearchParams({ country: profile.country, ids: officialPriceId, lang: profile.language }).toString();
      const response = await fetchPrice(url, { headers: { accept: "application/json" }, signal });
      return response.ok ? parseNintendoPriceQuote(await response.json(), officialPriceId, profile) : null;
    },
  };
}
```

`createNintendoPriceApiProvider` 必须调用同一 `resolve` 并把 `currentPriceMinor` 映射为原有 `ProviderResult.amountMinor`；网络异常继续包装为 `ProviderNetworkError`，结构错误返回 `null`。

- [ ] **Step 4: 运行报价与现有采集回归并确认 GREEN**

Run: `npx vitest run test/official-nintendo-price-api.test.ts test/official-price-id-service.test.ts test/provider-chain.test.ts`

Expected: 全部通过，现有日区和港区最小货币单位测试不变。

- [ ] **Step 5: 提交门禁**

取得管理员确认后执行：

```bash
git add src/worker/providers/official-nintendo-price-api.ts test/official-nintendo-price-api.test.ts
git commit -m "refactor: expose verified Nintendo price quotes"
git push origin main
```

### Task 4: 实现请求级 Browser Run 批处理器

**Files:**
- Create: `src/worker/providers/japanese-upgrade-browser.ts`
- Create: `test/japanese-upgrade-browser.test.ts`

**Interfaces:**
- Consumes: `Fetcher` Browser Binding、`JapaneseUpgradeRootCandidate[]`。
- Produces: `JapaneseUpgradeBrowserBatch.resolve(roots, signal): Promise<Map<string, JapaneseUpgradeBrowserResult>>`。

- [ ] **Step 1: 写入失败测试**

```ts
it("uses one browser and a fresh serial context for every root", async () => {
  const events: string[] = [];
  const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, async () => fakeBrowser(events, [
    visibleUpgradeLink("https://store-jp.nintendo.com/item/software/D70050000064985"),
    visibleUpgradeLink("https://store-jp.nintendo.com/item/software/D70050000064986/"),
  ]));
  const result = await batch.resolve([
    root("https://store-jp.nintendo.com/item/software/D70010000106252/"),
    root("https://store-jp.nintendo.com/item/software/D70010000106253/"),
  ], new AbortController().signal);
  expect([...result.values()]).toEqual([
    { status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/" },
    { status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064986/" },
  ]);
  expect(events).toEqual(["launch", "context:1", "page:1", "page-close:1", "context-close:1", "context:2", "page:2", "page-close:2", "context-close:2", "browser-close"]);
});

function root(productUrl: string): JapaneseUpgradeRootCandidate {
  return { productUrl, canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition", publisher: "Team17" };
}

function visibleUpgradeLink(href: string) {
  return { isVisible: async () => true, innerText: async () => "アップグレードパス", getAttribute: async () => href };
}

function fakeBrowser(events: string[], linksByContext: Array<ReturnType<typeof visibleUpgradeLink>>) {
  let index = 0;
  events.push("launch");
  return {
    async newContext() {
      index += 1;
      const contextIndex = index;
      events.push(`context:${contextIndex}`);
      return {
        async newPage() {
          events.push(`page:${contextIndex}`);
          return { goto: async () => undefined, locator: () => ({ all: async () => [linksByContext[contextIndex - 1]] }), close: async () => { events.push(`page-close:${contextIndex}`); } };
        },
        close: async () => { events.push(`context-close:${contextIndex}`); },
      };
    },
    close: async () => { events.push("browser-close"); },
  };
}
```

加入 URL 边界表和资源关闭用例：

```ts
it.each([
  ["http", "http://store-jp.nintendo.com/item/software/D70050000064985/"],
  ["wrong host", "https://evil.example/item/software/D70050000064985/"],
  ["query", "https://store-jp.nintendo.com/item/software/D70050000064985/?token=x"],
  ["fragment", "https://store-jp.nintendo.com/item/software/D70050000064985/#x"],
  ["port", "https://store-jp.nintendo.com:8443/item/software/D70050000064985/"],
  ["credentials", "https://user:pass@store-jp.nintendo.com/item/software/D70050000064985/"],
])("rejects %s URL", (_name, url) => expect(normalizeJapaneseUpgradeUrl(url)).toBeNull());

it("closes the browser once when navigation throws and does not relaunch", async () => {
  const close = vi.fn();
  const launchBrowser = vi.fn().mockResolvedValue({ newContext: async () => ({ newPage: async () => ({ goto: async () => { throw new Error("timeout"); }, locator: () => ({ all: async () => [] }), close: vi.fn() }), close: vi.fn() }), close });
  const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, launchBrowser);
  await batch.resolve([root("https://store-jp.nintendo.com/item/software/D70010000106252/")], new AbortController().signal);
  expect(launchBrowser).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it("maps a Playwright navigation TimeoutError without retrying", async () => {
  const timeout = Object.assign(new Error("navigation exceeded limit"), { name: "TimeoutError" });
  const launchBrowser = vi.fn().mockResolvedValue(fakeFailingBrowser(timeout));
  const result = await createJapaneseUpgradeBrowserBatch({} as Fetcher, launchBrowser)
    .resolve([root("https://store-jp.nintendo.com/item/software/D70010000106252/")], new AbortController().signal);
  expect(result.get("https://store-jp.nintendo.com/item/software/D70010000106252/")).toEqual({ status: "timeout" });
  expect(launchBrowser).toHaveBeenCalledTimes(1);
});

it("rejects four roots before launching a browser", async () => {
  const launchBrowser = vi.fn();
  const roots = Array.from({ length: 4 }, (_, index) => root(`https://store-jp.nintendo.com/item/software/D7001000010625${index}/`));
  await expect(createJapaneseUpgradeBrowserBatch({} as Fetcher, launchBrowser).resolve(roots, new AbortController().signal)).rejects.toThrow("一次最多核验 3 个日区升级包");
  expect(launchBrowser).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run test/japanese-upgrade-browser.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现批处理器与严格 URL 规范化**

```ts
export type JapaneseUpgradeBrowserResult =
  | { status: "success"; upgradeUrl: string }
  | { status: "browser-unavailable" | "timeout" | "blocked-or-missing" | "multiple-matches" | "invalid-official-url" };

export interface JapaneseUpgradeBrowserBatch {
  resolve(roots: JapaneseUpgradeRootCandidate[], signal: AbortSignal): Promise<Map<string, JapaneseUpgradeBrowserResult>>;
}

export class JapaneseUpgradeBatchLimitError extends Error {}

interface BrowserPageLike {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  locator(selector: string): { all(): Promise<Array<{ isVisible(): Promise<boolean>; innerText(): Promise<string>; getAttribute(name: "href"): Promise<string | null> }>> };
  close(): Promise<void>;
}

interface BrowserContextLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

interface BrowserLike {
  newContext(): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

type BrowserLauncher = (binding: Fetcher) => Promise<BrowserLike>;

export function createJapaneseUpgradeBrowserBatch(
  binding: Fetcher,
  launchBrowser: BrowserLauncher = async (browserBinding) => launch(browserBinding),
): JapaneseUpgradeBrowserBatch {
  return {
    async resolve(roots, signal) {
      if (roots.length > 3) throw new JapaneseUpgradeBatchLimitError("一次最多核验 3 个日区升级包，请分批处理。");
      const results = new Map<string, JapaneseUpgradeBrowserResult>();
      let browser: BrowserLike | undefined;
      try {
        browser = await launchBrowser(binding);
        for (const root of roots) results.set(root.productUrl, await resolveOne(browser, root, signal));
      } catch {
        for (const root of roots) if (!results.has(root.productUrl)) results.set(root.productUrl, { status: "browser-unavailable" });
      } finally {
        await browser?.close().catch(() => undefined);
      }
      return results;
    },
  };
}

async function resolveOne(browser: BrowserLike, root: JapaneseUpgradeRootCandidate, signal: AbortSignal): Promise<JapaneseUpgradeBrowserResult> {
  let context: BrowserContextLike | undefined;
  let page: BrowserPageLike | undefined;
  try {
    if (signal.aborted) return { status: "browser-unavailable" };
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(root.productUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const urls: string[] = [];
    for (const link of await page.locator('a:has-text("アップグレードパス")').all()) {
      if (!await link.isVisible() || !(await link.innerText()).includes("アップグレードパス")) continue;
      const normalized = normalizeJapaneseUpgradeUrl(await link.getAttribute("href"));
      if (normalized === null) return { status: "invalid-official-url" };
      if (!urls.includes(normalized)) urls.push(normalized);
    }
    if (urls.length === 0) return { status: "blocked-or-missing" };
    if (urls.length > 1) return { status: "multiple-matches" };
    return { status: "success", upgradeUrl: urls[0] };
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError" ? { status: "timeout" } : { status: "browser-unavailable" };
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
  }
}

export function normalizeJapaneseUpgradeUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value, "https://store-jp.nintendo.com");
    const match = /^\/item\/software\/(D[0-9]+)\/?$/.exec(url.pathname);
    return url.protocol === "https:" && url.hostname === "store-jp.nintendo.com" && url.port === "" && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && match
      ? `https://store-jp.nintendo.com/item/software/${match[1]}/`
      : null;
  } catch {
    return null;
  }
}
```

`fakeFailingBrowser(error)` 与前一夹具使用相同的 `events`/关闭实现，只让 `goto` 抛入参错误。`resolveOne` 必须为每个根创建新 context/page，以 30,000ms 超时访问根 URL，仅读取可见 `アップグレードパス` 链接，在内层 `finally` 关闭 page/context。`normalizeJapaneseUpgradeUrl` 必须接受同站相对目标并规范化末尾斜杠，同时拒绝端口、凭据、查询、片段、错误主机/协议/路径。

- [ ] **Step 4: 运行测试和类型检查并确认 GREEN**

Run: `npx vitest run test/japanese-upgrade-browser.test.ts && npx tsc --noEmit`

Expected: 全部通过，Playwright 类型与窄测试替身一致。

- [ ] **Step 5: 提交门禁**

取得管理员确认后执行：

```bash
git add src/worker/providers/japanese-upgrade-browser.ts test/japanese-upgrade-browser.test.ts
git commit -m "feat: add bounded Japanese upgrade browser resolver"
git push origin main
```

### Task 5: 组合自动发现、人工链接与最终确认关系服务

**Files:**
- Create: `src/worker/services/japanese-upgrade-relation-service.ts`
- Create: `test/japanese-upgrade-relation-service.test.ts`

**Interfaces:**
- Consumes: `JapaneseUpgradeRootSearch`、`JapaneseUpgradeBrowserBatch`、`NintendoOfficialPriceQuoteResolver`。
- Produces: `discover(anchors)`、`resolveManual(anchor, productUrl)`、`verifyForConfirmation(items)`。

- [ ] **Step 1: 写入失败测试**

```ts
it("builds an automatic candidate only from root, unique browser relation and matching JPY quote", async () => {
  const anchor = overcookedUpgradeUs();
  const root = overcookedRoot();
  const service = createJapaneseUpgradeRelationService(
    { search: vi.fn().mockResolvedValue(root) },
    { resolve: vi.fn().mockResolvedValue(new Map([[root.productUrl, { status: "success", upgradeUrl }]])) },
    { resolve: vi.fn().mockResolvedValue({ officialPriceId: "70050000064985", currency: "JPY", currentPriceMinor: 700, regularPriceMinor: 1000 }) },
  );
  await expect(service.discover([anchor])).resolves.toEqual(new Map([[
    officialCandidateKey(anchor),
    { status: "automatic", candidate: overcookedUpgradeJp({ currentPriceMinor: 700, regularPriceMinor: 1000 }) },
  ]]));
});

it("keeps manual_link only when Browser Run fails but the exact JPY quote is valid", async () => {
  const anchor = overcookedUpgradeUs();
  const candidate = overcookedUpgradeJp();
  const item = { anchor, candidate, matchSource: "manual_link" as const };
  const root = overcookedRoot();
  const service = createJapaneseUpgradeRelationService(
    { search: vi.fn().mockResolvedValue(root) },
    { resolve: vi.fn().mockResolvedValue(new Map([[root.productUrl, { status: "timeout" }]])) },
    { resolve: vi.fn().mockResolvedValue({ officialPriceId: "70050000064985", currency: "JPY", currentPriceMinor: 700, regularPriceMinor: 1000 }) },
  );
  await expect(service.verifyForConfirmation([item])).resolves.toEqual(new Map([[
    japaneseUpgradeConfirmationKey(item),
    { status: "verified-manual", candidate: overcookedUpgradeJp({ currentPriceMinor: 700, regularPriceMinor: 1000 }) },
  ]]));
});

const upgradeUrl = "https://store-jp.nintendo.com/item/software/D70050000064985/";

function overcookedUpgradeUs(): OfficialProductCandidate {
  return { regionCode: "US", productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-nintendo-switch-2-edition-upgrade-pack-switch-2/", canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition Upgrade Pack", publisher: "Team17", productType: "upgrade-pack", currency: "USD", coverUrl: null, currentPriceMinor: 999, regularPriceMinor: null };
}

function overcookedRoot(): JapaneseUpgradeRootCandidate {
  return { productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/", canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition", publisher: "Team17" };
}

function overcookedUpgradeJp(overrides: Partial<OfficialProductCandidate> = {}): OfficialProductCandidate {
  return { regionCode: "JP", productUrl: upgradeUrl, canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition アップグレードパス", publisher: "Team17", productType: "upgrade-pack", currency: "JPY", coverUrl: null, currentPriceMinor: 700, regularPriceMinor: 1000, ...overrides };
}
```

加入以下失败矩阵和批量上限测试：

```ts
it.each(["browser-unavailable", "timeout", "blocked-or-missing", "multiple-matches", "invalid-official-url"] as const)(
  "rejects automatic confirmation on %s",
  async (status) => {
    const anchor = overcookedUpgradeUs();
    const candidate = overcookedUpgradeJp();
    const root = overcookedRoot();
    const service = createJapaneseUpgradeRelationService(
      { search: async () => root },
      { resolve: async () => new Map([[root.productUrl, { status }]]) },
      { resolve: async () => ({ officialPriceId: "70050000064985", currency: "JPY", currentPriceMinor: 700, regularPriceMinor: 1000 }) },
    );
    const item = { anchor, candidate, matchSource: "automatic" as const };
    await expect(service.verifyForConfirmation([item])).resolves.toEqual(new Map([[japaneseUpgradeConfirmationKey(item), { status: "rejected" }]]));
  },
);

it("rejects four items before root or browser calls", async () => {
  const roots = { search: vi.fn() };
  const browser = { resolve: vi.fn() };
  const service = createJapaneseUpgradeRelationService(roots, browser, { resolve: vi.fn() });
  const anchors = Array.from({ length: 4 }, (_, index) => ({ ...overcookedUpgradeUs(), productUrl: `https://www.nintendo.com/us/store/products/overcooked-${index}-upgrade-pack/` }));
  await expect(service.discover(anchors)).rejects.toThrow("一次最多核验 3 个日区升级包");
  expect(roots.search).not.toHaveBeenCalled();
  expect(browser.resolve).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run test/japanese-upgrade-relation-service.test.ts`

Expected: FAIL，服务模块尚不存在。

- [ ] **Step 3: 实现三个窄入口**

```ts
export type JapaneseUpgradeDiscoveryResult =
  | { status: "automatic"; candidate: OfficialProductCandidate }
  | { status: "needs-manual-link"; message: "日区自动核验暂不可用，请重新核验或粘贴官方链接。" };

export interface JapaneseUpgradeConfirmationItem {
  anchor: OfficialProductCandidate;
  candidate: OfficialProductCandidate;
  matchSource: RegionalProductMatchSource;
}

export type JapaneseUpgradeConfirmationResult =
  | { status: "verified-automatic" | "verified-manual"; candidate: OfficialProductCandidate }
  | { status: "rejected" };

export interface JapaneseUpgradeRelationService {
  discover(anchors: OfficialProductCandidate[]): Promise<Map<string, JapaneseUpgradeDiscoveryResult>>;
  resolveManual(anchor: OfficialProductCandidate, productUrl: string): Promise<OfficialProductCandidate | null>;
  verifyForConfirmation(items: JapaneseUpgradeConfirmationItem[]): Promise<Map<string, JapaneseUpgradeConfirmationResult>>;
}

export function createJapaneseUpgradeRelationService(
  roots: JapaneseUpgradeRootSearch,
  browser: JapaneseUpgradeBrowserBatch,
  prices: NintendoOfficialPriceQuoteResolver,
): JapaneseUpgradeRelationService;

export function japaneseUpgradeConfirmationKey(item: JapaneseUpgradeConfirmationItem): string {
  return `${officialCandidateKey(item.anchor)}|${item.candidate.productUrl}|${item.matchSource}`;
}
```

工厂严格按上述三个窄依赖返回服务。三个入口必须先验证 `upgrade-pack`、JP URL 和三项上限，再收集唯一根并一次调用 Browser Batch；空数组直接返回空 Map，不启动浏览器。候选使用根标题追加 `アップグレードパス`、根发行商、JP/JPY、固定类型和报价金额；自动确认要求浏览器 URL 与提交 URL 完全一致，人工确认仅在浏览器失败状态下允许报价兜底。候选阶段对每个根查询、报价和浏览器结果分别捕获安全失败，单项写 `needs-manual-link` 而不影响其他项；最终确认阶段每项都写 `verified-*` 或 `rejected`，任一外部异常归一为该项 `rejected`。不得漏项，也不得回传异常正文。

- [ ] **Step 4: 运行关系、根、浏览器和报价测试并确认 GREEN**

Run: `npx vitest run test/japanese-upgrade-relation-service.test.ts test/official-japanese-upgrade-root.test.ts test/japanese-upgrade-browser.test.ts test/official-nintendo-price-api.test.ts`

Expected: 全部通过。

- [ ] **Step 5: 提交门禁**

取得管理员确认后执行：

```bash
git add src/worker/services/japanese-upgrade-relation-service.ts test/japanese-upgrade-relation-service.test.ts
git commit -m "feat: compose Japanese upgrade relation evidence"
git push origin main
```

### Task 6: 接入地区发现、人工链接 API 与前端重试

**Files:**
- Modify: `src/worker/services/official-product-discovery-service.ts`
- Modify: `src/worker/routes/product-routes.ts`
- Modify: `src/app/api-client.ts`
- Modify: `src/app/subscription-wizard-page.tsx`
- Modify: `test/official-product-discovery-service.test.ts`
- Modify: `test/api-product-discovery.test.ts`
- Modify: `test/api-client.test.ts`
- Modify: `test/subscription-wizard-page.test.tsx`

**Interfaces:**
- Consumes: `JapaneseUpgradeRelationService.discover` 与 `resolveManual`。
- Changes: `resolveOfficialLink(regionCode, productUrl, anchor?)`。
- Changes: `/api/products/resolve-link` 可携带完整 `anchor`，仅服务端用其证明日区升级包类型/关系。
- Changes: 服务层 `needs-manual-link` 可携带安全 `message`；路由优先透传该说明，否则继续使用既有通用说明。

- [ ] **Step 1: 写入发现与 API 失败测试**

```ts
it("batches eligible Japanese upgrade fallbacks after ordinary regional search", async () => {
  const anchor = usCandidate({ canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition Upgrade Pack", productType: "upgrade-pack" });
  const jpUpgrade = japaneseCandidate({ canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition アップグレードパス", productType: "upgrade-pack", productUrl: upgradeUrl });
  const japaneseUpgrades = {
    discover: vi.fn().mockResolvedValue(new Map([[officialCandidateKey(anchor), { status: "automatic", candidate: jpUpgrade }]])),
    resolveManual: vi.fn(),
  };
  const service = new OfficialProductDiscoveryService(
    { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
    { search: vi.fn().mockResolvedValue({ status: "available", candidates: [] }) },
    { resolve: vi.fn() },
    { resolveRelated: vi.fn() },
    japaneseUpgrades,
  );
  await expect(service.resolveRegions([anchor])).resolves.toEqual([{ candidateKey: officialCandidateKey(anchor), regionCode: "JP", status: "automatic", candidate: jpUpgrade }]);
  expect(japaneseUpgrades.discover).toHaveBeenCalledExactlyOnceWith([anchor]);
});

it("sends the selected anchor when verifying a Japanese manual upgrade link", async () => {
  const anchor = candidate();
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ candidate: anchor }));
  const client = createProductApiClient(request);
  await client.resolveOfficialLink("JP", upgradeUrl, anchor);
  expect(request).toHaveBeenCalledWith("/api/products/resolve-link", expect.objectContaining({ body: JSON.stringify({ regionCode: "JP", productUrl: upgradeUrl, anchor }) }));
});
```

其中 `usCandidate(overrides)`、`japaneseCandidate(overrides)`、`candidate()` 沿用对应测试文件现有夹具并允许覆盖字段；`upgradeUrl` 固定为 `https://store-jp.nintendo.com/item/software/D70050000064985/`。DOM 测试复用 `wizardApi`，令 `resolveRegions` 连续返回一次 `needs-manual-link` 和一次 `automatic`；点击“重新核验”后断言调用次数为 2、服务端消息“日区自动核验暂不可用，请重新核验或粘贴官方链接。”曾显示，最终出现日区候选。全局请求计数继续由 `test/api-client.test.ts` 的 pending→0 用例锁定，不在组件测试伪造 tracker。

- [ ] **Step 2: 运行四组测试并确认 RED**

Run: `npx vitest run test/official-product-discovery-service.test.ts test/api-product-discovery.test.ts test/api-client.test.ts && npx vitest run --config vitest.dom.config.mts test/subscription-wizard-page.test.tsx`

Expected: FAIL，现有服务没有日区关系批处理、手动链接没有 anchor、页面没有重试入口。

- [ ] **Step 3: 实现两阶段地区发现与安全人工链接**

`resolveRegions` 把既有 `matchRegion` 的返回值扩成仅在服务内部使用的 `{ anchor, resolution, japaneseUpgradeEligible }`：只有“JP + upgrade-pack + 官方搜索状态为 available + 普通及本地化回退均无同类型候选”把标志设为 true。先并行完成不使用 Browser 的普通地区匹配，再去重收集 eligible anchor 并一次调用：

```ts
const japanese = await this.japaneseUpgrades.discover(eligibleJapaneseUpgradeAnchors);
return ordinaryMatches.map(({ resolution, japaneseUpgradeEligible }) => {
  const replacement = japaneseUpgradeEligible ? japanese.get(resolution.candidateKey) : undefined;
  return replacement?.status === "automatic"
    ? { candidateKey: resolution.candidateKey, regionCode: "JP", status: "automatic", candidate: replacement.candidate }
    : replacement?.status === "needs-manual-link"
      ? { candidateKey: resolution.candidateKey, regionCode: "JP", status: "needs-manual-link", message: replacement.message }
      : resolution;
});
```

注入依赖使用 `Pick<JapaneseUpgradeRelationService, "discover" | "resolveManual">`，并提供只返回人工链接状态/null 的安全默认实现，使普通商品的既有独立测试无需启动 Browser。`resolveOfficialLink` 对 JP 升级包要求 `anchor`，先调用 `resolveManual`；其他商品保持页面解析器。路由 `readOfficialLinkRequest` 使用既有 `readOfficialProductCandidate` 收窄可选 anchor，拒绝浏览器只提交任意标题字符串。`JapaneseUpgradeBatchLimitError` 只映射为安全 422，其余外部失败继续按单项人工链接状态返回。

- [ ] **Step 4: 实现前端消息和重新核验**

```tsx
{resolution.status === "needs-manual-link" ? (
  <>
    <p>{resolution.message}</p>
    {resolution.regionCode === "JP" ? (
      <button type="button" className="text-button" onClick={onRetryRegions}>重新核验</button>
    ) : null}
    {/* 既有官方链接输入和核验按钮保留；JP 调用时必须传入 selected 锚点。 */}
  </>
) : null}
```

`createProductApiClient.resolveOfficialLink` 增加第三个可选参数并在存在时发送 `{ anchor }`；页面调用 `api.resolveOfficialLink(regionCode, link, selected)`。

- [ ] **Step 5: 运行服务/API/DOM 回归并确认 GREEN**

Run: `npx vitest run test/official-product-discovery-service.test.ts test/api-product-discovery.test.ts test/api-client.test.ts && npx vitest run --config vitest.dom.config.mts test/subscription-wizard-page.test.tsx`

Expected: 全部通过；错误消息安全、加载计数归零、其他地区行为不变。

- [ ] **Step 6: 提交门禁**

取得管理员确认后执行：

```bash
git add src/worker/services/official-product-discovery-service.ts src/worker/routes/product-routes.ts src/app/api-client.ts src/app/subscription-wizard-page.tsx test/official-product-discovery-service.test.ts test/api-product-discovery.test.ts test/api-client.test.ts test/subscription-wizard-page.test.tsx
git commit -m "feat: discover Japanese upgrade subscriptions"
git push origin main
```

### Task 7: 接入保存前批量二次验证并装配生产服务

**Files:**
- Modify: `src/worker/services/subscription-confirmation-service.ts`
- Modify: `src/worker/services/japanese-subscription-confirmation-service.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/subscription-confirmation-service.test.ts`
- Modify: `test/japanese-subscription-confirmation-service.test.ts`
- Modify: `test/api-product-discovery.test.ts`

**Interfaces:**
- Consumes: `JapaneseUpgradeRelationService.verifyForConfirmation`。
- Keeps: `JapaneseSubscriptionConfirmationService.resolve` 仅处理非升级包 JP 候选。
- Produces: 整批日区升级证据 Map，在任何 D1 查询/写入前生成。

- [ ] **Step 1: 写入最终确认失败测试**

```ts
it("verifies all Japanese upgrade regions once before the atomic confirmation batch", async () => {
  const first = japaneseUpgradeCase("overcooked", "70050000064985");
  const second = japaneseUpgradeCase("kirby", "70050000064986");
  const japaneseUpgrades = { verifyForConfirmation: vi.fn().mockResolvedValue(new Map([
    [japaneseUpgradeConfirmationKey(first.item), { status: "verified-automatic", candidate: first.item.candidate }],
    [japaneseUpgradeConfirmationKey(second.item), { status: "verified-automatic", candidate: second.item.candidate }],
  ])) };
  const service = createServiceWithJapaneseUpgradeVerifier(japaneseUpgrades, [first, second]);
  await expect(service.confirm([first.input, second.input], now)).resolves.toHaveLength(2);
  expect(japaneseUpgrades.verifyForConfirmation).toHaveBeenCalledExactlyOnceWith([first.item, second.item]);
});

it("writes zero rows when one automatic Japanese upgrade relation is rejected", async () => {
  const first = japaneseUpgradeCase("overcooked", "70050000064985");
  const second = japaneseUpgradeCase("kirby", "70050000064986");
  const japaneseUpgrades = { verifyForConfirmation: vi.fn().mockResolvedValue(new Map([
    [japaneseUpgradeConfirmationKey(first.item), { status: "verified-automatic", candidate: first.item.candidate }],
    [japaneseUpgradeConfirmationKey(second.item), { status: "rejected" }],
  ])) };
  await expect(createServiceWithJapaneseUpgradeVerifier(japaneseUpgrades, [first, second]).confirm([first.input, second.input], now)).rejects.toThrow("日区升级包自动匹配已失效");
  await expect(counts()).resolves.toEqual({ games: 0, products: 0, subscriptions: 0, regions: 0 });
});
```

`japaneseUpgradeCase(slug, priceId)` 用不同标题、US/JP 官方 URL 和 ID 构造 `{ input, item }`，其中 `item` 精确等于 `{ anchor: input.selected, candidate: JP region, matchSource: JP region.matchSource }`；`createServiceWithJapaneseUpgradeVerifier(verifier, cases)` 在现有真实 D1 仓储夹具上注入 verifier，并让 US 页面/价格 ID 桩只接受传入 cases 的固定候选。再按同一夹具加入三个明确用例：人工 `manual_link` 的 Map 返回 `verified-manual` 时成功；人工项返回 `rejected` 时四表计数均为 0；普通日区游戏确认成功且 `verifyForConfirmation` 接收空数组、原 `japanese.resolve` 被调用。

- [ ] **Step 2: 运行最终确认测试并确认 RED**

Run: `npx vitest run test/subscription-confirmation-service.test.ts test/japanese-subscription-confirmation-service.test.ts test/api-product-discovery.test.ts`

Expected: FAIL，确认服务尚未接收批量日区升级验证器。

- [ ] **Step 3: 在写入前预计算整批日区升级证据**

```ts
public async confirm(inputs: ConfirmedSubscriptionInput[], now: string): Promise<SubscriptionConfirmationResult[]> {
  if (inputs.length === 0) throw new SubscriptionConfirmationError("请至少确认一个商品订阅。");
  const upgradeItems = collectJapaneseUpgradeConfirmationItems(inputs);
  const verifiedUpgrades = await this.japaneseUpgrades.verifyForConfirmation(upgradeItems);
  const validated = await Promise.all(inputs.map((input) => this.validate(input, verifiedUpgrades)));
  const normalizedNames = validated.map((input) => input.game.normalizedName);
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    throw new SubscriptionConfirmationError("同一批次不能重复确认同一游戏。");
  }
  const existing = await this.repository.findExistingByNormalizedNames(normalizedNames);
  const creations = validated
    .filter((input) => !existing.has(input.game.normalizedName))
    .map((input) => this.withServerGeneratedIds(input));
  await this.repository.createAtomically(creations, now);
  return projectConfirmationResults(validated, existing, creations);
}
```

`projectConfirmationResults` 是从现有 `confirm` 原样抽出的结果投影私有函数：既有记录返回其 ID 和 `existing`，新记录按 `normalizedName` 从 `creations` 取得服务端生成 ID 并返回 `created`。`collectJapaneseUpgradeConfirmationItems` 只收集地区数组中的 `regionCode === "JP" && productType === "upgrade-pack"`，并用 `input.selected` 作 anchor；超过 3 项时由关系服务在任何 D1 查询/写入前拒绝。

构造函数在 `japanese` 后新增 `japaneseUpgrades: Pick<JapaneseUpgradeRelationService, "verifyForConfirmation">`，再保留 `automaticVerifier` 与 `createId`；更新本文件全部构造调用，避免位置参数误把普通 automatic verifier 当成日区关系验证器。`validate`、`validateRegion` 和 `resolveOfficialCandidate` 增加 `verifiedUpgrades` 参数。后者对 JP `upgrade-pack` 只能读取精确 anchor/candidate/source 键；普通 JP 商品继续调用 `this.japanese.resolve`。自动拒绝使用“日区升级包自动匹配已失效，请重新核验其他地区。”，人工拒绝使用“日区升级包官方链接无法确认，请重新核验。”。

- [ ] **Step 4: 在 Worker 入口装配一次请求所需依赖**

```ts
const japaneseUpgradeRelations = createJapaneseUpgradeRelationService(
  createOfficialJapaneseUpgradeRootSearch(),
  createJapaneseUpgradeBrowserBatch(env.BROWSER),
  createNintendoOfficialPriceQuoteResolver(),
);
```

同一对象注入 `OfficialProductDiscoveryService` 和 `SubscriptionConfirmationService`；`createLiveCollectionRunner`、`scheduled` 和 Telegram 工厂不接收它。更新 `JapaneseSubscriptionConfirmationService` 注释，明确升级包已在上层分流。

- [ ] **Step 5: 运行确认/API/入口回归并确认 GREEN**

Run: `npx vitest run test/subscription-confirmation-service.test.ts test/japanese-subscription-confirmation-service.test.ts test/api-product-discovery.test.ts test/health.test.ts && npx tsc --noEmit`

Expected: 全部通过，普通 JP、HK、US/MX/BR 路径不变。

- [ ] **Step 6: 提交门禁**

取得管理员确认后执行：

```bash
git add src/worker/services/subscription-confirmation-service.ts src/worker/services/japanese-subscription-confirmation-service.ts src/worker/index.ts test/subscription-confirmation-service.test.ts test/japanese-subscription-confirmation-service.test.ts test/api-product-discovery.test.ts
git commit -m "feat: reverify Japanese upgrades before subscription writes"
git push origin main
```

### Task 8: 全量质量门禁、远程只读验收与文档归档

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/superpowers/plans/2026-07-19-japanese-upgrade-browser-run-production-integration.md`

**Interfaces:**
- Consumes: Task 1–7 的完整实现。
- Produces: 可审计的本地/远程业务只读验收记录；不修改生产业务表。若远程预览没有可复用会话，管理员手动登录会按既有认证设计创建会话记录，但不得因此调用任何订阅、刷新或通知写入端点。

- [x] **Step 1: 运行完整本地质量门禁**

Run: `npm test`

Expected: 所有 Worker 测试通过。

Run: `npm run test:dom`

Expected: 所有 DOM 测试通过。

Run: `npx tsc --noEmit`

Expected: 退出码 0。

Run: `npm run build`

Expected: Vite/Workers 构建成功，Browser Binding 与 `nodejs_compat` 无配置错误。

Run: `node --test test/browser-run-production-config.test.mjs test/deploy-production-script.test.mjs`

Expected: 依赖/Binding 与版本发布契约均通过；测试不会递增版本或部署。

- [x] **Step 2: 执行注释、安全和差异检查**

Run: `git diff --check`

Expected: 无输出。

Run: `rg -n "TELEGRAM_BOT_TOKEN=|TELEGRAM_CHAT_ID=|Bearer |password=|sessionId|trace\.zip|storageState" src test wrangler.jsonc docs`

Expected: 只出现类型名、假测试值或明确禁止记录的文档文字；不存在真实凭据、Browser Session 值或持久化代码。逐个检查所有命中。

- [x] **Step 3: 取得管理员授权后启动远程预览并执行只读样本**

Run: `npx wrangler dev --remote --port 8791`

在已登录管理员会话中只调用 `POST /api/products/resolve-regions`，输入已验证美区 `Overcooked! 2 – Nintendo Switch 2 Edition Upgrade Pack` 候选。

Expected: 日区返回 `automatic`，URL 为 `https://store-jp.nintendo.com/item/software/D70050000064985/`，货币为 JPY，当前价/常规价来自官方价格 API；请求结束后 Browser Session 正常关闭。不得调用最终确认、创建订阅、手动刷新或部署。

执行记录：远程预览的 `localhost` 会话已失效，管理员手动登录后先在真实向导执行一次官方搜索与地区核验，再以一次性本地只读代理仅重放 `resolve-regions` 以裁剪未渲染证据。两次地区核验均为 HTTP 200；登录只创建认证会话，搜索与地区核验均未修改生产业务表。

- [x] **Step 4: 更新结果文档**

在质量文档只记录允许字段：执行日期、测试数量、`status`、规范化日区 URL、价格来源为官方、耗时区间和 Session 正常关闭结论。不记录 HTML、Cookie、队列信息、响应正文或异常堆栈。README/追踪表状态改为“已实现、远程只读验收通过、待生产部署”。

- [x] **Step 5: 最终提交门禁**

向管理员列出 Task 8 文档与任何质量修正的准确范围；取得明确确认后执行：

```bash
git add docs/README.md docs/requirements/traceability.md docs/quality/quality-and-acceptance.md docs/superpowers/plans/2026-07-19-japanese-upgrade-browser-run-production-integration.md
git commit -m "docs: record Japanese upgrade Browser Run acceptance"
git push origin main
```

- [x] **Step 6: 生产部署门禁**

报告当前提交、全量测试、远程只读结果和 Cloudflare Browser Run 用量；单独询问是否允许运行 `npm run deploy`。未取得部署确认时保持生产 V0.0.12 不变；获得确认后部署脚本自动递增到 V0.0.13，并在部署后只验证健康检查和已认证只读地区核验，任何订阅写入仍由管理员页面明确触发。

执行记录：管理员已单独确认生产发布。固定脚本把版本递增至 V0.0.13，部署 Worker `dc31798e-7d40-4f4e-aadd-7b365246b7f1`；公开健康接口和页面版本均通过。已认证向导只读核验中，JP 首次受控降级、管理员显式重试后自动匹配升级通行证，MX、BR、HK 保持自动结果；部署后共使用两次 Browser Run 请求，没有最终确认订阅、手动刷新或其他业务写入。

---

## 计划自检

- 规格的单 Worker、同步等待、一个浏览器、三个上下文、30 秒、无重试、自动二次复核、人工链接兜底、原子写入、无 D1/队列/Cron 变更均映射到具体任务和测试。
- 新增类型从 Task 2–5 定义，Task 6–7 只消费已定义签名；`discover`、`resolveManual` 和 `verifyForConfirmation` 名称在全文保持一致。
- 每个功能任务均有独立 RED、最小实现、GREEN 和提交门禁；任何提交都要求管理员确认并同步推送。
- 远程预览只读、生产部署和真实订阅写入三个权限边界相互独立，不会因测试通过自动扩大授权。
- 本计划各章节均给出准确文件、接口、测试命令、预期结果和代码骨架，不含未决实现项。
