# 日区订阅确认官方 API 复核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让日区商品在最终订阅确认时使用任天堂官方搜索 API 与价格 API 复核，避免 My Nintendo Store 动态页面导致有效候选被拒绝。

**Architecture:** 新增一个只负责日区确认的 Worker 服务，先以默认区官方锚点的受控标题重读官方软件搜索 API 并要求 URL 标题 ID 精确一致，再调用既有日区价格 ID 服务确认 JP/JPY/onsale。订阅确认服务针对 JP 使用该服务，其他地区继续使用现有官方商品页解析器；自动来源在当次搜索结果中重新证明唯一高置信度本地化身份，人工来源的类型边界不变。

**Tech Stack:** TypeScript、Cloudflare Workers、Vitest、现有任天堂官方搜索与价格 API 适配器、D1。

## Global Constraints

- 只能调用任天堂官方公开搜索 API 与公开价格 API；不得新增第三方、翻译、AI、Cookie、账号或浏览器直连。
- 日区价格 API 只证明标题 ID、在售状态和日元币种；标题、发行商和商品类型必须来自同次官方搜索复核。
- US、MX、BR、HK 仍使用既有官方商品页复核，不能因日区适配改变其验证要求。
- 浏览器提交的候选身份、价格和封面均不可信；最终持久化值必须由 Worker 当次官方复核结果生成。
- 所有新增或修改的源代码、测试和文档必须包含与实现一致的中文详细注释。
- 任何失败均不得部分写入 D1、不得暴露外部原始响应或秘密。
- 任何本地 Git 提交前均须先获用户明确确认，并在同一操作中推送 GitHub。

---

### Task 1: 日区官方双接口确认服务

**Files:**
- Create: `src/worker/services/japanese-subscription-confirmation-service.ts`
- Modify: `src/worker/services/official-product-discovery-service.ts`
- Test: `test/japanese-subscription-confirmation-service.test.ts`

**Interfaces:**
- Consumes: `OfficialProductCandidate`、`OfficialProductSearch.search("JP", query, signal)` 和 `OfficialPriceIdService.resolve(candidate)`。
- Produces: `JapaneseSubscriptionConfirmationService.resolve(anchor, candidate, matchSource): Promise<OfficialProductCandidate | null>`；成功返回当次官方搜索重建的候选，失败返回 `null`。

- [x] **Step 1: 写入失败的服务测试**

```ts
it("rebuilds a Japanese confirmation candidate only when official search and price APIs agree on the same onsale JPY title ID", async () => {
  const candidate = japaneseCandidate({ productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/" });
  const service = new JapaneseSubscriptionConfirmationService(
    { search: vi.fn().mockResolvedValue({ status: "available", candidates: [candidate] }) },
    { resolve: vi.fn().mockResolvedValue({ status: "official-available", officialPriceId: "70010000106252" }) },
  );

  await expect(service.resolve(usAnchor, candidate, "automatic")).resolves.toEqual(candidate);
});

it("rejects a different official Japanese URL without returning browser supplied identity fields", async () => {
  const service = createJapaneseConfirmationService({
    searchCandidates: [japaneseCandidate({ productUrl: "https://store-jp.nintendo.com/item/software/D70010000106253/" })],
    priceResolution: { status: "official-available", officialPriceId: "70010000106253" },
  });

  await expect(service.resolve(usAnchor, japaneseCandidate(), "manual_selection")).resolves.toBeNull();
});

it("rejects unavailable Japanese search or price evidence", async () => {
  const unavailableSearch = createJapaneseConfirmationService({ searchResult: { status: "unavailable", message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" } });
  const unavailablePrice = createJapaneseConfirmationService({ priceResolution: { status: "official-id-unavailable", officialPriceId: null, reason: "official-verification-failed" } });

  await expect(unavailableSearch.resolve(usAnchor, japaneseCandidate(), "manual_selection")).resolves.toBeNull();
  await expect(unavailablePrice.resolve(usAnchor, japaneseCandidate(), "manual_selection")).resolves.toBeNull();
});
```

- [x] **Step 2: 运行测试并确认失败原因是服务尚不存在**

Run: `npm test -- test/japanese-subscription-confirmation-service.test.ts`

Expected: FAIL，提示 `JapaneseSubscriptionConfirmationService` 或对应模块尚不存在。

- [x] **Step 3: 实现最小日区复核服务**

```ts
export class JapaneseSubscriptionConfirmationService {
  public constructor(
    private readonly search: Pick<OfficialProductSearch, "search">,
    private readonly officialPriceIds: Pick<OfficialPriceIdService, "resolve">,
  ) {}

  public async resolve(
    anchor: OfficialProductCandidate,
    candidate: OfficialProductCandidate,
    matchSource: RegionalProductMatchSource,
  ): Promise<OfficialProductCandidate | null> {
    if (candidate.regionCode !== "JP" || !isCanonicalJapaneseStoreUrl(candidate.productUrl)) return null;
    const query = anchor.regionCode === "JP" ? candidate.canonicalTitle : anchor.canonicalTitle;
    const searchResult = await this.search.search("JP", query, new AbortController().signal);
    if (searchResult.status !== "available") return null;
    const officialCandidate = searchResult.candidates.find((item) => item.productUrl === candidate.productUrl) ?? null;
    if (!officialCandidate || officialCandidate.regionCode !== "JP" || officialCandidate.currency !== "JPY") return null;
    if (matchSource === "automatic" && !isUniqueAutomaticJapaneseMatch(anchor, officialCandidate, searchResult.candidates)) return null;
    const priceId = await this.officialPriceIds.resolve(officialCandidate);
    return priceId.status === "official-available" ? officialCandidate : null;
  }
}
```

只接受精确日区下载版 URL；搜索结果必须由现有适配器解析，因此已经验证纯数字 `id/nsuid`、下载版形态与 URL 映射。`automatic` 还必须在同次结果中成为唯一严格或高置信度本地化匹配，不能采信浏览器自报来源。为 URL 白名单、两类官方证据、唯一性和 `null` 失败边界添加中文详细注释。

- [x] **Step 4: 运行服务测试确认通过**

Run: `npm test -- test/japanese-subscription-confirmation-service.test.ts`

Expected: PASS；成功只返回官方搜索候选，搜索或价格任一失败都返回 `null`。

### Task 2: 订阅确认接线与跨语言最终身份校验

**Files:**
- Modify: `src/worker/services/subscription-confirmation-service.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/services/official-product-discovery-service.ts`
- Test: `test/subscription-confirmation-service.test.ts`
- Test: `test/api-product-discovery.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `JapaneseSubscriptionConfirmationService.resolve(anchor, candidate, matchSource)`，既有 `OfficialNintendoProductPageResolver.resolve` 和 `OfficialPriceIdService.resolve`。
- Produces: `SubscriptionConfirmationService.confirm` 对 JP 走双 API、其他地区走页面解析；自动日区可接受高置信度本地化身份，人工来源规则不变。

- [x] **Step 1: 写入失败的确认服务测试**

```ts
it("confirms an automatic localized Japanese region through official APIs without requesting the dynamic Store page", async () => {
  const pages = { resolve: vi.fn().mockResolvedValue(usCandidate()) };
  const japanese = { resolve: vi.fn().mockResolvedValue(japaneseCandidate()) };
  const service = createConfirmationService({ pages, japanese });

  await expect(service.confirm([localizedAutomaticSubscriptionInput()], now)).resolves.toHaveLength(1);
  expect(japanese.resolve).toHaveBeenCalledWith(expect.objectContaining({ regionCode: "JP" }));
  expect(pages.resolve).not.toHaveBeenCalledWith("JP", expect.any(String), expect.any(AbortSignal));
});

it("rejects a localized automatic candidate when Japanese API verification fails and writes no rows", async () => {
  const repository = createRepositorySpy();
  const service = createConfirmationService({ repository, japanese: { resolve: vi.fn().mockResolvedValue(null) } });

  await expect(service.confirm([localizedAutomaticSubscriptionInput()], now)).rejects.toThrow("日区官方商品确认暂时失败");
  expect(repository.createAtomically).not.toHaveBeenCalled();
});
```

- [x] **Step 2: 运行测试并确认其因旧的日区页面解析与严格标题比较而失败**

Run: `npm test -- test/subscription-confirmation-service.test.ts test/api-product-discovery.test.ts`

Expected: FAIL；旧实现会调用 JP 商品页解析器，或对英文/日文标题报身份不一致。

- [x] **Step 3: 实现最小路由与服务接线**

在 `SubscriptionConfirmationService` 中注入窄接口 `resolve(candidate)` 的日区确认器，并将候选解析分支固定为：

```ts
private async resolveOfficialCandidate(
  anchor: OfficialProductCandidate,
  candidate: OfficialProductCandidate,
  matchSource: RegionalProductMatchSource,
): Promise<OfficialProductCandidate> {
  if (candidate.regionCode === "JP") {
    const verified = await this.japanese.resolve(anchor, candidate, matchSource);
    if (!verified) throw new SubscriptionConfirmationError("日区官方商品确认暂时失败，请重新核验其他地区后再试。");
    return verified;
  }
  const verified = await this.pages.resolve(candidate.regionCode, candidate.productUrl, new AbortController().signal);
  if (!verified) throw new SubscriptionConfirmationError("商品链接不是该区任天堂官方链接，或公开商品信息无法验证。");
  return verified;
}
```

从发现服务导出只读的高置信度身份谓词，或提取到单独的纯函数模块，供发现与最终确认复用。`automatic` 仅在“严格相同”或“高置信度本地化相同”时通过；`manual_selection` 和 `manual_link` 保持只检查经官方复核的相同商品类型。为跨语言规则的唯一性来源、日区页面绕过范围和错误脱敏原因补充中文详细注释。

在 Worker 组合根中把 `createOfficialNintendoSearch()` 与既有日区价格 ID 服务传给新的日区确认器；不要新增网络端点、D1 表或 Cloudflare Secret。

- [x] **Step 4: 运行 Worker 回归测试确认通过**

Run: `npm test -- test/japanese-subscription-confirmation-service.test.ts test/subscription-confirmation-service.test.ts test/api-product-discovery.test.ts test/official-product-discovery-service.test.ts`

Expected: PASS；日区走双 API，其他区继续走商品页，自动本地化可确认，人工边界与原子性不变。

### Task 3: 文档、全量验证与生产受控验收

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-japan-confirmation-api-design.md`
- Modify: `docs/superpowers/plans/2026-07-18-japan-confirmation-api.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/system-design.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/quality/quality-and-acceptance.md`

**Interfaces:**
- Consumes: Task 1 与 Task 2 的测试结果和生产只读核验。
- Produces: 已实施状态、回归命令、确认接口的日区差异与只读验收记录；不自动执行订阅写入。

- [x] **Step 1: 更新设计与追踪状态**

将设计规格标为“已实施，待生产写入验收”，在追踪表、系统设计和 API 设计中说明：JP 最终确认使用官方搜索 + 官方价格 API；非 JP 保持商品页复核；失败以安全中文 `422` 返回；所有地区仍在 D1 写入前完成验证。

- [x] **Step 2: 运行全量本地质量门禁**

Run: `npm test && npm run test:dom && npx tsc --noEmit && npm run build && git diff --check`

Expected: 全部 PASS，且构建不包含真实凭据或配置变更。

- [x] **Step 3: 部署前请求用户授权并进行只读生产验证**

先向管理员说明将部署的文件范围并获取明确授权。部署后，在已登录生产页面搜索 `Overcooked! 2`、选择美区 Switch 2 Edition、执行“核验其他地区”，确认日区仍可自动显示本地化官方候选。不得点击“确认订阅”。

- [ ] **Step 4: 请求最终提交与推送确认**

说明将包含的源代码、测试、文档与验证结果；只有在用户明确确认后，才在同一操作中执行：

```bash
git add src/worker/services/japanese-subscription-confirmation-service.ts src/worker/services/subscription-confirmation-service.ts src/worker/services/official-product-discovery-service.ts src/worker/index.ts test/japanese-subscription-confirmation-service.test.ts test/subscription-confirmation-service.test.ts test/api-product-discovery.test.ts docs
git commit -m "fix: verify Japanese subscriptions with official APIs"
git push origin main
```

## 自检记录

- 规格覆盖：Task 1 覆盖双官方接口与 URL/ID 约束；Task 2 覆盖日区接线、跨语言身份及非日区回归；Task 3 覆盖文档、质量门禁、部署授权和写入边界。
- 占位符检查：所有任务均给出文件、接口、失败测试、命令与预期结果；无 TBD 或“后续实现”占位。
- 类型一致性：日区确认器唯一公开方法为 `resolve(anchor, candidate, matchSource)`，Task 2 的注入接口和测试均使用该签名；成功返回 `OfficialProductCandidate | null`。
