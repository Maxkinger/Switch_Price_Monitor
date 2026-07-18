# 美食家版跨区官方组合商品识别实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让美区 `Overcooked! 2 - Gourmet Edition` 在新建订阅核验中自动匹配唯一的日区、港区官方美食家版组合商品，并用各区官方价格 API 验证其价格 ID。

**Architecture:** 日区搜索适配器将经过验证的 `DL_DLC` 形态映射为领域 `bundle`；英文锚点没有同类型结果时，发现服务只能由唯一官方日文系列别名再检索一次。港区补充 eShop 搜索中的精确 `bundles` 链接，并从同 URL 页面中经过 `nsUid` 校验的 RSC `BundleItem` 补齐发行商。身份服务在既有严格和 Switch 2 Edition 规则之后，只为同类型组合商品识别受控的美食家版版本标记，并继续要求发行商、拉丁主标题与候选唯一性。

**Tech Stack:** TypeScript、Cloudflare Workers、Vitest、任天堂公开搜索页/API、D1 前的内存订阅预览。

## 全局约束

- 所有新增或变更源代码、测试和文档使用中文详细注释；注释解释职责、外部数据约束、边界和安全/业务原因，并与实现保持一致。
- 测试先行：每个行为先写失败测试并运行，再写最小实现并运行对应测试。
- 只使用任天堂公开官方搜索、商品页和价格 API；不得发送 Cookie、Nintendo Account 数据、第三方请求或浏览器会话。
- 自动匹配始终需要本区官方 URL、`bundle` 类型、双方发行商、相同拉丁主标题、相同受控版本标记和唯一候选；否则回退人工选择或官方链接。
- 港区只新增 HTTPS `ec.nintendo.com/HK/zh/bundles/{数字 ID}`；日区只新增已验证的 `DL_DLC` 下载形态；不得放宽到任意 URL、语言、地区或实体卡带。
- 任何 Git 提交前必须先说明范围并取得管理员明确确认；获确认后同一操作完成提交与 `git push origin main`。

---

## 文件结构与职责

- `src/worker/providers/official-nintendo-search.ts`：将日区 `DL_DLC` 识别为组合商品，并解析港区官方 eShop 搜索结果中的 `bundles` 候选。
- `src/worker/providers/official-nintendo-product-page.ts`：白名单和解析港区组合商品详情页中经过 `nsUid` 绑定的 RSC `BundleItem` 公开元数据。
- `src/worker/services/official-product-discovery-service.ts`：在港区候选缺少发行商时，从已验证官方详情页补齐身份字段；在受限条件下进行一次日区官方日文别名检索；增加受控美食家版等价版本标记。
- `src/worker/services/japanese-subscription-confirmation-service.ts`：以待保存的官方日区标题重新搜索并与精确 URL、价格 ID 交叉验证。
- `src/worker/services/official-price-id-service.ts`：从港区组合商品精确 URL 提取可供官方价格 API 验证的 ID。
- `test/official-nintendo-search.test.ts`、`test/official-nintendo-product-page.test.ts`、`test/official-product-discovery-service.test.ts`、`test/official-price-id-service.test.ts`：离线夹具覆盖正向路径与拒绝边界。
- `docs/architecture/system-design.md`、`docs/decisions/ADR-002-price-provider-validation.md`、`docs/requirements/traceability.md`、`docs/README.md`：记录已实现的官方组合商品边界与验收。

### 生产验收补充：港区官方商城慢响应

首次修复部署后，生产向导已能自动确认日区美食家版，但港区仍回退到手动链接。只读实测证明官方搜索页本身包含正确的 `bundles/70070000010913` 链接，而其响应约 25 秒，超过原统一 12 秒搜索预算。修复只允许 `searchOfficialHongKongBundles` 使用 30 秒固定上限；普通港区索引、其他地区与详情页请求均不变，任何超时仍返回人工官方链接入口。

## Task 1: 日区官方组合商品搜索

**Files:**

- Modify: `test/official-nintendo-search.test.ts`
- Modify: `src/worker/providers/official-nintendo-search.ts`

**Consumes:** 日区公开软件搜索记录的 `id`、`nsuid`、`sform`、`title`、`maker`、`price`、`current_price`。

**Produces:** `OfficialProductSearch.search("JP", ...)` 对唯一数字 `DL_DLC` 记录返回 `productType: "bundle"` 与 `D{ID}` 官方 Store URL。

- [x] **Step 1: 写入失败测试**

  在日区搜索测试中加入 `sform: "DL_DLC"`、ID `70070000010202`、标题 `Overcooked® 2 - オーバークック２：真の食通エディション` 的夹具，并断言：

  ```ts
  expect(result.candidates).toContainEqual({
    regionCode: "JP",
    productUrl: "https://store-jp.nintendo.com/item/software/D70070000010202/",
    canonicalTitle: "Overcooked® 2 - オーバークック２：真の食通エディション",
    publisher: "Team17",
    productType: "bundle",
    currency: "JPY",
    currentPriceMinor: 1225,
    regularPriceMinor: 4900,
  });
  ```

  同一测试保留 `HAC_CARD` 与未知 `sform`，断言两者不在候选中；注释说明不能由实体/未知形态推导购买 URL。

- [x] **Step 2: 运行失败测试**

  Run: `npx vitest run test/official-nintendo-search.test.ts`

  Expected: FAIL；当前实现会排除 `DL_DLC` 或把它错误分类为 `game`。

- [x] **Step 3: 实现最小日区形态映射**

  在 `official-nintendo-search.ts` 中用一个受控函数替换宽泛的 `endsWith("_DL")`：

  ```ts
  function readOfficialJapaneseDownloadProductType(value: unknown): ProductType | null {
    // 仅接受实测的下载本体/升级形态和组合商品形态；实体卡带或未知枚举没有可安全推导的 Store 下载 URL。
    if (value === "BEE_DL" || value === "HAC_DL") return "game";
    if (value === "DL_DLC") return "bundle";
    return null;
  }
  ```

  `toOfficialJapaneseCandidate` 必须从该函数获得类型，返回 `null` 时拒绝记录；不要根据日文标题猜测组合类型。为函数和调用处补充中文注释，说明 `DL_DLC` 是本次官方实测的组合商品边界而非对所有 DLC 的放行。

- [x] **Step 4: 运行通过测试与回归**

  Run: `npx vitest run test/official-nintendo-search.test.ts`

  Expected: PASS，既有 `BEE_DL` Switch 2 Edition 仍为 `game`，实体记录仍被拒绝。

## Task 2: 港区组合商品发现、链接验证与价格 ID

**Files:**

- Modify: `test/official-nintendo-search.test.ts`
- Modify: `test/official-nintendo-product-page.test.ts`
- Modify: `test/official-price-id-service.test.ts`
- Modify: `src/worker/providers/official-nintendo-search.ts`
- Modify: `src/worker/providers/official-nintendo-product-page.ts`
- Modify: `src/worker/services/official-price-id-service.ts`

**Consumes:** `https://store.nintendo.com.hk/eshopsearch/result/?q={query}` 公开 HTML 中的精确 eShop URL，以及港区详情页的 `search.name`、`search.publisher`、`search.thumbnail` 元数据。

**Produces:** 港区美食家版为 `bundle` 官方候选，只有精确 `/HK/zh/bundles/{数字 ID}` URL 可通过详情验证并被官方价格 ID 服务接受。

- [x] **Step 1: 写入失败测试**

  加入港区 eShop 搜索 HTML 夹具，其中只有以下有效链接：

  ```html
  <a class="product-item-link" href="https://ec.nintendo.com/HK/zh/bundles/70070000010913">
    Overcooked! 2 - Gourmet Edition
  </a>
  ```

  断言搜索返回 HKD、`bundle`、该 URL 与空发行商；同时放入 `/HK/en/bundles/`、`/HK/zh/bundles/not-a-number` 和第三方 URL，断言均被拒绝。

  为产品页解析器加入组合商品元数据夹具，并断言它返回 Team17、标题、封面、`bundle` 和空价格。为价格 ID 服务加入组合商品候选，断言 `70070000010913` 被传给注入的官方提供方；带查询参数或非港区语言仍返回 `unrecognized-url`。

- [x] **Step 2: 运行失败测试**

  Run: `npx vitest run test/official-nintendo-search.test.ts test/official-nintendo-product-page.test.ts test/official-price-id-service.test.ts`

  Expected: FAIL；当前搜索不会读取 eShop 结果，且 `bundles` 不在港区 URL/ID 白名单内。

- [x] **Step 3: 实现受控港区组合商品路径**

  在 `official-nintendo-search.ts` 新增固定 `officialHongKongEshopSearchEndpoint`，用 `q` 查询；解析时只接受 `https://ec.nintendo.com/HK/zh/bundles/{数字 ID}`。从链接文本读取非空标题，明确写入：

  ```ts
  {
    regionCode: "HK",
    productUrl,
    canonicalTitle,
    publisher: null,
    productType: "bundle",
    currency: "HKD",
    coverUrl: null,
    currentPriceMinor: null,
    regularPriceMinor: null,
  }
  ```

  将此结果与既有港区软件结果合并并按 URL 去重；任一搜索端点网络/结构失败时不能把失败伪装为“无商品”。所有外部 HTML 提取必须验证链接协议、主机、精确路径与数字 ID，注释说明这是防止 SSRF、跨区链接及账户页面混入的边界。

  在 `official-nintendo-product-page.ts` 的 HK 白名单、eShop URL 正则中新增 `bundles`；普通 `titles` 仍解析 `search.*` 元标签，`bundles` 则只解析 RSC `BundleItem` 并验证 `nsUid` 与 URL ID 相同。在 `official-price-id-service.ts` 的 HK 正则中加入 `bundles`。三处都维持 `titles/aocs` 原有行为并以中文注释解释新增资源类型的价格 API 已由本任务夹具验证。

- [x] **Step 4: 运行通过测试与回归**

  Run: `npx vitest run test/official-nintendo-search.test.ts test/official-nintendo-product-page.test.ts test/official-price-id-service.test.ts`

  Expected: PASS；已有港区 `titles` 与 `aocs` 测试保持通过，非官方/跨语言/带查询组合 URL 均被拒绝。

## Task 3: 受控美食家版等价自动匹配

**Files:**

- Modify: `test/official-product-discovery-service.test.ts`
- Modify: `src/worker/services/official-product-discovery-service.ts`

**Consumes:** Task 1/2 的 `bundle` 候选，以及现有 `OfficialNintendoProductPageResolver.resolve(regionCode, productUrl, signal)`。

**Produces:** `resolveRegions` 为唯一日区、港区官方美食家版返回 `status: "automatic"`；不可证明、不同类型或不唯一候选保持人工状态。

- [x] **Step 1: 写入失败测试**

  创建美区锚点：

  ```ts
  const anchor = usCandidate({
    canonicalTitle: "Overcooked! 2 - Gourmet Edition",
    productType: "bundle",
    publisher: "Team17",
  });
  ```

  分别创建日区 `真の食通エディション` 和港区 `Gourmet Edition` 组合候选。港区搜索候选的 `publisher` 初始为 `null`，页面解析器桩件返回同 URL、Team17 的完整候选。断言两区各有唯一候选时均为 `automatic`。

  再覆盖：第二条同等价日区候选必须返回 `needs-manual-selection`；原版 `game`、Switch 2 Edition、季票、升级包、发行商不同或港区详情页解析失败不得自动匹配。每个桩件注释说明它所保护的误订阅业务风险。

- [x] **Step 2: 运行失败测试**

  Run: `npx vitest run test/official-product-discovery-service.test.ts`

  Expected: FAIL；现有版本标记只识别 Switch 2 Edition，且港区搜索候选缺少发行商无法成为自动候选。

- [x] **Step 3: 实现最小且可审计的匹配扩展**

  在 `matchRegion` 中，仅针对本区 HK、缺失发行商且已通过同类型和官方 URL 过滤的候选调用现有 `pages.resolve` 补齐公开详情。解析失败时保留原候选供人工选择，绝不从锚点复制发行商。

  将版本标记函数改为显式返回受控值：

  ```ts
  function editionMarker(title: string): string | null {
    const normalized = title.normalize("NFKC");
    if (/nintendo\s+switch\s*2\s+edition/iu.test(normalized)) return "nintendo-switch-2-edition";
    if (/gourmet\s+edition|真の食通エディション/iu.test(normalized)) return "gourmet-edition";
    return null;
  }
  ```

  在 `localizedIdentityRelevance` 中保留原有同类型、双方发行商与相同拉丁主标题约束；仅当两端版本标记相同且非空时返回 `2`。补充中文注释，明确该小型集合不是翻译器，新增版本词必须先经过官方证据、规格和测试审查。

- [x] **Step 4: 运行通过测试与回归**

  Run: `npx vitest run test/official-product-discovery-service.test.ts`

  Expected: PASS；既有 Switch 2 Edition 自动匹配继续通过，美食家版仅在唯一官方组合商品时自动匹配。

## Task 4: 文档、全量质量门禁与受控生产验收

**Files:**

- Modify: `docs/architecture/system-design.md`
- Modify: `docs/decisions/ADR-002-price-provider-validation.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-07-18-gourmet-edition-regional-bundle-design.md`
- Modify: `docs/superpowers/plans/2026-07-18-gourmet-edition-regional-bundle.md`

**Consumes:** Task 1–3 的测试结果和经过管理员授权的生产只读核验。

**Produces:** 可追溯的官方组合商品准入记录、完成状态与验收结果；不产生订阅写入。

- [x] **Step 1: 更新架构与准入文档**

  在系统设计中记录 HK `titles/aocs/bundles` 的精确官方 ID 路径、日区 `DL_DLC` 组合商品和“搜索→官方详情补全→官方价格 API”的数据流。在 ADR-002 增加组合商品的 URL、货币、ID、价格 API 与拒绝边界；更新追踪表和索引状态。

- [x] **Step 2: 补充生产验收回归测试并执行全量质量门禁**

  Run: `npm test -- --run && npm run test:dom -- --run && npx tsc --noEmit && npm run build && git diff --check`

  Expected: 日区二次检索、候选标题最终复核和港区 RSC `BundleItem` ID 绑定测试先失败后通过；所有 Worker/DOM 测试、严格类型检查、生产构建和差异检查通过；逐项检查新增/修改注释与实现一致，且无密钥、令牌或会话数据进入差异。

  结果：定向失败测试已先确认三项缺口；修复后全量 Worker 测试为 56 文件、190 用例通过，DOM 测试为 4 文件、8 用例通过，`npx tsc --noEmit`、`npm run build` 与 `git diff --check` 均通过。已人工复核新增/修改的中文注释与日区单次回退、港区 `nsUid` 绑定、官方价格 ID 复核实现一致。

- [ ] **Step 3: 部署前取得管理员明确授权**

  不在此计划内自动部署。先向管理员说明生产变更是“官方日区/港区美食家版发现与价格 ID 验证”，并取得明确部署确认。

- [ ] **Step 4: 受控生产只读验收**

  在授权部署后，使用已登录管理员会话：搜索 `Overcooked! 2`，选择美区 `Overcooked! 2 - Gourmet Edition`，点击“核验其他地区”，确认日区和港区都显示唯一自动官方匹配；再预览价格来源，确认日区与港区均为官方可用。不得点击最终“确认订阅”，不得创建或修改订阅、快照、历史、目标价或通知。

- [ ] **Step 5: 记录验收并准备合并提交**

  将 Worker 版本、验收的候选名称、官方金额和“未写入订阅数据”的边界写回规格及追踪文档。向管理员列出全部待提交文件、测试结果和生产验收结果；只有收到明确提交确认后，才在同一命令中执行 `git add`、`git commit` 与 `git push origin main`。

## 计划自检

- 规格的日区形态、港区搜索/路径、等价匹配、错误边界、测试和生产只读验收分别由 Task 1–4 覆盖。
- 接口名称、候选字段和 URL 规则均引用现有代码中的 `OfficialProductSearch`、`OfficialNintendoProductPageResolver` 与 `OfficialPriceIdService`；新增函数返回类型已在任务中明确。
- 计划没有未定义的后续工作项；部署与提交均保留管理员明确授权门槛。
