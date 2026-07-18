# 香港区官方关联商品自动发现实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本项目当前不启用子代理执行，除非管理员另行明确要求。

**Goal:** 让香港区通过普通任天堂官网搜索到本体后，只展开一层 `ec.nintendo.com` 官方关联关系，自动发现并复核美食家版组合包、DLC 与 Switch 2 升级通行证，同时移除会被 Cloudflare Worker 拒绝的 Magento 商城搜索和临时诊断。

**Architecture:** 香港名称搜索恢复为单一 `www.nintendo.com/hk/search` 官方入口；商品页解析器新增只读关联引用接口，从已验证 `titles/{NSUID}` 的 RSC 根商品读取 `includedBundleItems`、`dlcItems.items` 与 `upgradeInfo`。发现服务只在原始查询无同类型候选时生成一次受控基础标题查询，最多读取五个本体、每页最多接受五十个关联引用，并逐个重读关联商品详情；最终确认对非日区 `automatic` 映射重新执行同一发现证明，不能信任浏览器提交的自动状态。

**Tech Stack:** TypeScript、Cloudflare Workers、React/Vite、Vitest、任天堂香港普通搜索 RSC、任天堂 `ec.nintendo.com` 商品 RSC、现有官方价格 ID 服务。

## 全局约束

- 所有新增或修改的源代码、测试、构建配置和文档必须配有中文详细注释，并同步检查受影响注释与实现一致。
- 每个行为严格测试先行：先运行新增测试并确认因缺少目标行为而失败，再写最小实现并运行通过。
- 只请求任天堂公开官方地址；不得发送 Cookie、Nintendo Account、浏览器会话、搜索引擎缓存或第三方价格站请求。
- 港区名称搜索只使用 `https://www.nintendo.com/hk/search`；不得再请求 `store.nintendo.com.hk/eshopsearch/result/`。
- 关系展开只允许一个层级、最多五个根本体、单个本体最多五十个去重关系；边界超出或任一同类型关系无法完整复核时回退人工官方链接。
- 关联对象不能继承本体发行商；只有重读关联商品自己的官方详情后，发行商、标题、类型和 URL 才能参与自动身份判断。
- 最终确认仍须通过本区官方详情、官方价格 ID 和重新执行的自动发现证明；浏览器提交的 `automatic`、标题、类型、发行商或价格均不可信。
- 不自动提交、推送或部署。准备提交时先列出完整范围并取得管理员明确确认，随后在同一操作中完成 `git commit` 与 `git push origin main`；生产部署另行取得确认。

---

## 文件结构与职责

- `src/worker/providers/official-nintendo-search.ts`：香港只保留普通官网 RSC 名称搜索，移除 Magento、30 秒例外和临时诊断。
- `src/worker/providers/official-nintendo-product-page.ts`：验证香港 `titles/aocs/bundles` 详情，并从本体详情生成无发行商的单层关联引用。
- `src/worker/services/official-product-discovery-service.ts`：生成受控基础标题、限制根候选数量、复核关系详情并计算唯一自动候选。
- `src/worker/services/subscription-confirmation-service.ts`：最终确认非日区自动候选时重新调用发现证明。
- `src/worker/index.ts`：在商品发现、最终确认和既有订阅补全之间复用同一组官方解析依赖。
- `src/shared/domain.ts`、`src/app/api-client.ts`、`src/app/subscription-wizard-page.tsx`：移除已经完成排障使命的临时搜索诊断 DTO 与展示。
- `test/official-nintendo-search.test.ts`：锁定香港搜索只调用普通官网一次。
- `test/official-nintendo-product-page.test.ts`：锁定关联类型、NSUID、URL、层级和数量安全边界。
- `test/official-product-discovery-service.test.ts`：锁定基础标题回退、关系详情复核、唯一性和失败回退。
- `test/subscription-confirmation-service.test.ts`：锁定自动香港映射必须重新通过发现证明，失败时 D1 零写入。

## Task 1：移除受限 Magento 搜索和临时诊断

**Files:**

- Modify: `test/official-nintendo-search.test.ts`
- Modify: `src/worker/providers/official-nintendo-search.ts`
- Modify: `src/shared/domain.ts`
- Modify: `src/app/api-client.ts`
- Modify: `src/app/subscription-wizard-page.tsx`
- Test: `test/official-nintendo-search.test.ts`

**Interfaces:**

- Consumes: `OfficialProductSearch.search("HK", query, signal)`。
- Produces: 无 `diagnostics` 的 `OfficialSearchResult`；香港每次搜索只访问一个固定普通官网 URL。

- [x] **Step 1：先写失败测试，锁定单一香港搜索入口**

  将现有香港测试改为只返回普通官网 RSC，并断言不会出现第二次请求：

  ```ts
  it("uses only the Hong Kong Nintendo website search endpoint", async () => {
    // Magento 商城会拒绝 Cloudflare Worker；香港自动发现必须只依赖可访问的普通官网，不能静默恢复第二条受限请求。
    const fetchSearch = vi.fn(async (request: RequestInfo | URL) => {
      expect(String(request)).toBe("https://www.nintendo.com/hk/search?k=Overcooked+2");
      return new Response(hongKongSearchHtml());
    });
    const search = createOfficialNintendoSearch(fetchSearch);

    await expect(search.search("HK", "Overcooked 2", new AbortController().signal)).resolves.toMatchObject({
      status: "available",
      candidates: [expect.objectContaining({ productUrl: "https://ec.nintendo.com/HK/zh/titles/70010000106253" })],
    });
    expect(fetchSearch).toHaveBeenCalledTimes(1);
  });
  ```

  删除依赖商城成功、商城慢响应和临时诊断字段的旧断言；保留普通官网 HTTP 失败、超时与畸形 RSC 返回 `unavailable` 的回归测试。

- [x] **Step 2：运行测试并确认正确失败**

  Run: `npx vitest run test/official-nintendo-search.test.ts`

  Expected: FAIL；当前实现会发起普通官网与 Magento 两次请求，`fetchSearch` 调用次数为 2 或请求 URL 不符合断言。

- [x] **Step 3：实现最小单入口搜索并移除诊断模型**

  将香港搜索收窄为：

  ```ts
  async function searchOfficialHongKong(
    fetchOfficialSearch: typeof fetch,
    query: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<OfficialSearchResult> {
    const url = new URL(officialHongKongSearchEndpoint);
    url.searchParams.set("k", query);
    // 香港普通官网是当前唯一可由 Worker 稳定访问的官方名称索引；组合商品改由商品详情关系发现。
    const response = await fetchOfficialResponse(
      fetchOfficialSearch,
      url.toString(),
      { headers: { accept: "text/html" } },
      signal,
      timeoutMs,
    );
    if (!response) return unavailableSearch();
    const candidates = parseOfficialHongKongSearch(await response.text());
    return candidates === null ? unavailableSearch() : { status: "available", candidates };
  }
  ```

  同时删除：

  - `officialHongKongEshopSearchEndpoint`、`officialHongKongEshopSearchTimeoutMs`；
  - `searchOfficialHongKongBundles`、商城 HTML 解析与去重辅助函数；
  - `OfficialSearchDiagnostic`、`OfficialSearchResult.diagnostics`；
  - API 客户端的诊断字段和向导中的“官网搜索/商城搜索”临时展示。

  更新相关中文注释，明确组合商品改由官方关系展开，不得保留过期的“30 秒商城预算”说明。

- [x] **Step 4：运行定向测试、类型检查和差异检查**

  Run: `npx vitest run test/official-nintendo-search.test.ts && npx tsc --noEmit && git diff --check`

  Expected: PASS；香港测试只发生一次普通官网请求，类型系统确认前后端已无诊断字段引用，差异无格式错误。

## Task 2：解析并验证香港官方关联商品

**Files:**

- Modify: `test/official-nintendo-product-page.test.ts`
- Modify: `src/worker/providers/official-nintendo-product-page.ts`
- Test: `test/official-nintendo-product-page.test.ts`

**Interfaces:**

- Produces: `OfficialNintendoRelatedProductReference`。
- Produces: `OfficialNintendoRelatedProductResolver.resolveRelated(regionCode, productUrl, signal): Promise<OfficialNintendoRelatedProductReference[] | null>`。
- Produces: `createOfficialNintendoProductPageResolver()` 返回 `OfficialNintendoProductPageResolver & OfficialNintendoRelatedProductResolver`。

- [x] **Step 1：先写失败测试，覆盖三种关系及升级优先去重**

  新增最小本体 RSC 夹具，根对象必须是请求 URL 对应的 `ApplicationItem`：

  ```ts
  const fragment = {
    __typename: "ApplicationItem",
    nsUid: 70010000033098,
    formalName: "Overcooked! 2",
    includedBundleItems: [{
      __typename: "BundleItem",
      nsUid: 70070000010913,
      formalName: "Overcooked! 2 - Gourmet Edition",
      heroBannerUrl: "https://img-eshop.cdn.nintendo.net/i/gourmet.jpg",
    }],
    dlcItems: { items: [
      { __typename: "DlcItem", nsUid: 70050000021623, formalName: "Overcooked! 2 - Carnival of Chaos", heroBannerUrl: null },
      { __typename: "DlcItem", nsUid: 70050000065163, formalName: "Overcooked! 2 – Nintendo Switch 2 Edition升級通行證", heroBannerUrl: null },
    ] },
    upgradeInfo: [{
      upgradeDlcItemNsUid: 70050000065163,
      upgradeDlcItem: { __typename: "DlcItem", nsUid: 70050000065163, formalName: "Overcooked! 2 – Nintendo Switch 2 Edition升級通行證", heroBannerUrl: null },
    }],
  };
  ```

  断言 `resolveRelated("HK", "https://ec.nintendo.com/HK/zh/titles/70010000033098", signal)` 返回：

  ```ts
  [
    expect.objectContaining({ productUrl: "https://ec.nintendo.com/HK/zh/bundles/70070000010913", productType: "bundle" }),
    expect.objectContaining({ productUrl: "https://ec.nintendo.com/HK/zh/aocs/70050000021623", productType: "dlc" }),
    expect.objectContaining({ productUrl: "https://ec.nintendo.com/HK/zh/aocs/70050000065163", productType: "upgrade-pack" }),
  ]
  ```

  同一升级 NSUID 即使也出现在 `dlcItems.items` 中只能返回一次，且类型必须优先为 `upgrade-pack`。

- [x] **Step 2：写入拒绝边界测试并运行 RED**

  追加断言：根 `nsUid` 与 URL 不同、非 `titles` URL、嵌套第二层关系、无数字 NSUID、五十一个不同的关系 URL 均返回 `null`；`aocs` 和 `bundles` 详情不允许再次展开关系。

  Run: `npx vitest run test/official-nintendo-product-page.test.ts`

  Expected: FAIL；当前解析器没有 `resolveRelated`，且 HK 商品白名单尚未完整支持 `/aocs/{ID}` 详情复核。

- [x] **Step 3：实现关联引用类型和单层解析器**

  在 provider 中增加：

  ```ts
  export interface OfficialNintendoRelatedProductReference {
    readonly regionCode: "HK";
    readonly productUrl: string;
    readonly canonicalTitle: string;
    readonly productType: Extract<ProductType, "bundle" | "dlc" | "upgrade-pack">;
    readonly coverUrl: string | null;
  }

  export interface OfficialNintendoRelatedProductResolver {
    resolveRelated(
      regionCode: RegionCode,
      productUrl: string,
      signal: AbortSignal,
    ): Promise<OfficialNintendoRelatedProductReference[] | null>;
  }
  ```

  `resolveRelated` 必须复用同一套官方 URL 白名单与只读 fetch，不发送 Cookie；只接受 `/HK/zh/titles/{数字 ID}`。解析根 `ApplicationItem` 时先验证 `nsUid`，再按 `upgradeInfo`、`includedBundleItems`、普通 `dlcItems.items` 的受控字段生成 URL，并用 `Map<productUrl, reference>` 去重；升级关系优先写入，普通 DLC 不得覆盖。

  将 `/HK/zh/aocs/{数字 ID}` 加入商品详情白名单和 RSC `DlcItem` 解析。详情解析必须验证 URL ID 与 `DlcItem.nsUid` 相同，并从该商品自己的 `publisher.name` 读取发行商；标题分类仍由现有受控分类器决定，不能从关系类型直接覆盖详情结果。

- [x] **Step 4：运行 GREEN 和现有价格 ID 回归**

  Run: `npx vitest run test/official-nintendo-product-page.test.ts test/official-price-id-service.test.ts`

  Expected: PASS；三种关联 URL 与类型正确，超过边界安全返回 `null`，既有 HK `titles/aocs/bundles` 价格 ID 测试保持通过。

## Task 3：在发现服务中执行一次基础标题搜索与详情复核

**Files:**

- Modify: `test/official-product-discovery-service.test.ts`
- Modify: `src/worker/services/official-product-discovery-service.ts`
- Modify: `src/worker/index.ts`
- Test: `test/official-product-discovery-service.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `OfficialNintendoRelatedProductResolver`。
- Produces: `OfficialProductDiscoveryService.verifyAutomaticRegionalCandidate(anchor, candidate): Promise<boolean>`，供 Task 4 最终确认复用。

- [x] **Step 1：先写 Gourmet Edition 完整 RED 测试**

  构造美区 `bundle` 锚点。搜索桩第一次收到完整标题并返回空同类型结果，第二次必须收到 `Overcooked! 2` 并返回两个香港 `game` 本体；关系解析桩只从 `70010000033098` 返回 Gourmet 引用，页面解析桩再返回包含 Team17 的完整香港 bundle 候选。

  ```ts
  expect(search.search).toHaveBeenNthCalledWith(1, "HK", "Overcooked! 2 - Gourmet Edition", expect.any(AbortSignal));
  expect(search.search).toHaveBeenNthCalledWith(2, "HK", "Overcooked! 2", expect.any(AbortSignal));
  expect(related.resolveRelated).toHaveBeenCalledWith(
    "HK",
    "https://ec.nintendo.com/HK/zh/titles/70010000033098",
    expect.any(AbortSignal),
  );
  ```

  最终断言状态为 `automatic`，URL 为 `bundles/70070000010913`，且所有搜索请求 URL 都不包含 `store.nintendo.com.hk`。

- [x] **Step 2：写入数量、类型和失败回退 RED 测试**

  分别覆盖：

  - 基础标题搜索返回六个根本体时不请求任何详情，结果为 `needs-manual-link`；
  - 任一根本体关系返回 `null` 时，不用部分结果自动确认；
  - bundle 锚点只复核 bundle 引用，DLC/升级引用不能进入候选；
  - 同类型引用详情返回 null、URL/地区/类型不一致或缺少发行商时不能自动确认；
  - 两个复核成功且同等高置信度的 bundle 保持 `needs-manual-selection`；
  - 未识别的 bundle 后缀不生成基础标题，也不执行第二次搜索。

  Run: `npx vitest run test/official-product-discovery-service.test.ts`

  Expected: FAIL；当前服务只会等待 Magento 搜索直接返回 bundle，没有香港基础标题与关联展开路径。

- [x] **Step 3：实现受控基础标题与关系复核**

  构造函数增加第四个依赖：

  ```ts
  public constructor(
    private readonly settings: DiscoverySettingsReader,
    private readonly search: OfficialProductSearch,
    private readonly pages: OfficialNintendoProductPageResolver,
    private readonly related: OfficialNintendoRelatedProductResolver,
  ) {}
  ```

  基础标题函数只接受两类已确认锚点：

  ```ts
  function readHongKongBaseTitle(anchor: OfficialProductCandidate): string | null {
    const normalized = anchor.canonicalTitle.normalize("NFKC").trim();
    if (anchor.productType === "bundle") {
      return normalized.replace(/\s*[-–—:：]\s*gourmet\s+edition$/iu, "").trim() || null;
    }
    if (anchor.productType === "upgrade-pack") {
      return normalized.replace(/\s*[-–—:：]?\s*nintendo\s+switch\s*2\s+edition\s+upgrade\s+pack$/iu, "").trim() || null;
    }
    return null;
  }
  ```

  香港回退必须：第二次搜索最多一次；验证根候选均为本区官方 `titles` 游戏；根数量为 1–5；逐根读取单层关系；只保留与锚点同类型引用；逐条调用 `pages.resolve`；任一同类型引用复核失败就返回空集合，避免遗漏同名候选破坏唯一性。完整候选继续进入现有严格身份、版本标记和唯一性算法。

  `verifyAutomaticRegionalCandidate` 直接重新调用单地区匹配，并只在结果为 `automatic` 且官方 URL 与待确认候选完全相同时返回 true；不能比较数组位置或浏览器标题。

- [x] **Step 4：更新生产依赖并运行 GREEN**

  `src/worker/index.ts` 中把 `officialPages` 同时作为页面解析器与关系解析器传给发现服务；商品创建和已有订阅补全使用相同依赖，不得出现两套香港规则。

  Run: `npx vitest run test/official-product-discovery-service.test.ts test/subscription-region-completion-service.test.ts && npx tsc --noEmit`

  Expected: PASS；Gourmet Edition 自动匹配，边界失败回退人工链接，既有订阅补全与类型检查通过。

## Task 4：最终确认重新证明香港自动候选

**Files:**

- Modify: `test/subscription-confirmation-service.test.ts`
- Modify: `src/worker/services/subscription-confirmation-service.ts`
- Modify: `src/worker/index.ts`
- Test: `test/subscription-confirmation-service.test.ts`

**Interfaces:**

- Consumes: Task 3 的 `verifyAutomaticRegionalCandidate(anchor, candidate): Promise<boolean>`。
- Produces: 非日区 `automatic` 地区商品只有在详情、身份、自动发现和价格 ID 四项重验都成功后才可进入 D1 批次。

- [x] **Step 1：先写香港自动确认成功与失败测试**

  为 `SubscriptionConfirmationService` 注入窄接口：

  ```ts
  interface AutomaticRegionalCandidateVerifier {
    verifyAutomaticRegionalCandidate(
      anchor: OfficialProductCandidate,
      candidate: OfficialProductCandidate,
    ): Promise<boolean>;
  }
  ```

  成功用例返回 true，断言香港 bundle 写入；失败用例返回 false，断言抛出“地区商品自动匹配已失效，请重新核验其他地区。”并验证 `games`、`regional_products`、`subscriptions`、`subscription_regions` 均为 0。再加入 `manual_selection` 用例，证明人工选择只要求官方详情和同类型，不调用自动验证器。

- [x] **Step 2：运行 RED**

  Run: `npx vitest run test/subscription-confirmation-service.test.ts`

  Expected: FAIL；当前最终确认只重读详情和比较身份，不会重新证明自动候选 URL 的唯一性。

- [x] **Step 3：实现最小最终确认门禁并复用发现服务**

  `SubscriptionConfirmationService` 构造函数增加 `automaticVerifier`。在非 JP 地区详情重读、身份比较成功后，若 `matchSource === "automatic"`，必须调用验证器；返回 false 时在任何 D1 写入和价格快照创建前抛出受控错误。JP 继续使用既有搜索 + 价格 API 专用确认器，不能重复回退动态 Store 页面。

  `src/worker/index.ts` 为每个请求只构造一个 `OfficialProductDiscoveryService` 实例，并同时传给商品发现路由与最终确认服务；已有订阅补全可构造同配置实例，但必须使用相同 `officialPages`、搜索适配器和关系解析器。

- [x] **Step 4：运行 GREEN 与确认服务回归**

  Run: `npx vitest run test/subscription-confirmation-service.test.ts test/japanese-subscription-confirmation-service.test.ts test/product-route.test.ts`

  Expected: PASS；香港自动候选可重验写入，伪造/过期自动 URL 零写入，人工选择和日区专用确认不受影响。

## Task 5：文档、全量质量门禁与受控生产验收准备

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/requirements/PRD.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/system-design.md`
- Modify: `docs/decisions/ADR-002-price-provider-validation.md`
- Modify: `docs/superpowers/specs/2026-07-18-gourmet-edition-regional-bundle-design.md`
- Modify: `docs/superpowers/plans/2026-07-18-hong-kong-related-product-discovery.md`

**Interfaces:**

- Consumes: Task 1–4 的 RED/GREEN 结果和最终差异。
- Produces: 可追踪的官方关系发现架构、验收记录和待部署变更清单。

- [x] **Step 1：同步需求、架构和来源决策文档**

  文档必须明确：

  - 香港普通官网仅发现 `titles` 根商品；
  - 一层关系只发现候选，不替代详情、身份、唯一性或价格验证；
  - Magento 403 不触发第三方或非官方回退；
  - 临时诊断已经移除；
  - 最终确认重新执行自动候选证明；
  - 超限、结构变化和网络失败均回退人工官方链接且不写入数据。

- [x] **Step 2：运行全量质量门禁**

  Run: `npm test -- --run && npm run test:dom -- --run && npx tsc --noEmit && npm run build && git diff --check`

  Expected: Worker 与 DOM 全部测试 0 失败，TypeScript 0 错误，Vite 构建退出码 0，差异检查无格式问题。

- [x] **Step 3：人工检查注释、安全和工作区范围**

  Run: `git diff --stat && git status --short && rg -n "TODO|TBD|store\.nintendo\.com\.hk/eshopsearch|OfficialSearchDiagnostic" src test docs`

  Expected: 新流程代码不存在临时诊断或 Magento 搜索引用；文档可保留历史根因描述，但不得把该入口描述为现行依赖；差异不含密钥、Cookie、账号数据或真实 Telegram 凭据。

- [ ] **Step 4：提交与部署分别进入管理员确认门禁**

  先向管理员列出完整文件、RED/GREEN 证据、全量测试数量及拟提交信息。收到明确提交确认后，在同一操作中执行精确 `git add`、`git commit` 和 `git push origin main`。生产部署另行说明版本号递增、变更范围和只读验收步骤并取得确认；不得把提交确认解释为部署授权。

- [ ] **Step 5：获得部署授权后执行只读生产验收**

  搜索美区 `Overcooked! 2`，选择 `Overcooked! 2 - Gourmet Edition`，点击“核验其他地区”，确认：

  - 香港自动候选为 `https://ec.nintendo.com/HK/zh/bundles/70070000010913`；
  - 标题为 `Overcooked! 2 - Gourmet Edition`，发行商为 Team17；
  - 价格来源为任天堂官方，HKD 金额可用；
  - 页面不再显示临时“官网搜索/商城搜索”诊断；
  - 不点击最终“确认订阅”，不创建或修改订阅、地区映射、价格历史或通知数据。

## 计划自检

- 规格中的单一官方搜索入口、基础标题、单层关系、五个根、五十个关系、关联详情复核、类型隔离、唯一性、最终确认和人工回退均有对应任务与测试。
- `OfficialNintendoRelatedProductReference`、`OfficialNintendoRelatedProductResolver` 和 `verifyAutomaticRegionalCandidate` 的名称、参数和返回类型在生产与消费任务中一致。
- 计划无 TBD、TODO、“稍后实现”或未定义错误处理；提交、推送和部署均保留管理员明确确认门禁。
