# 多地区任天堂官方搜索与自动监控 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员在默认区选定一项任天堂官方商品后，系统主动搜索设置中启用的 US、JP、MX、BR、HK 官方商店；唯一严格匹配直接纳入监控，存在歧义时展示官方候选，只有无可验证候选时才要求粘贴官方链接。

**Architecture:** `OfficialNintendoSearch` 改为由服务端只读地区档案驱动：US/MX/BR 使用任天堂公开 Algolia 游戏索引，HK 解析任天堂香港搜索页的服务端数据，JP 使用任天堂日本官网搜索入口及其公开跳转结果。所有外部响应先经地区专属解析器收窄为 `OfficialProductCandidate`，再由发现服务决定自动匹配、人工候选或官方链接兜底。最终确认与既有订阅补全仍在 Worker 内重新验证并原子写入 D1。

**Tech Stack:** TypeScript strict、Cloudflare Workers、D1、React 19、Vite、Vitest 4。

## Global Constraints

- 每次代码、测试、SQL、配置或文档改动前完整阅读 `AGENTS.md` 与 `docs/README.md`。
- 所有新增或修改的源代码、测试、SQL 与配置包含中文详细注释；注释要说明地区隔离、外部数据不可信、身份校验与原子写入的业务或安全原因。
- 测试先行：先添加失败测试，再实现最小行为；测试夹具禁止访问真实任天堂网络。
- 只能使用任天堂官方公开站点和公开搜索配置；禁止第三方价格/搜索站、Nintendo Account、Cookie、购买记录和浏览器自动化。
- `settings.enabledRegions` 是跨区查询范围的唯一事实来源；浏览器不得传入或扩大地区范围、商品 ID、货币或价格 ID。
- 自动匹配必须严格比较规范化标题、商品类型以及双方都有时的发行商；人工选择可接受本地化标题，但必须由 Worker 验证同地区官方 URL 与相同商品类型。
- 任何确认或补全失败均不得产生部分 D1 写入；每次 Git 提交前向用户说明精确范围并获确认，确认后同一操作执行 `git commit` 与 `git push origin main`。

---

### Task 1: 数据驱动的 US、MX、BR 官方索引适配器

**Files:**
- Modify: `src/worker/providers/official-nintendo-search.ts`
- Modify: `test/official-nintendo-search.test.ts`
- Modify: `docs/superpowers/specs/2026-07-18-multi-region-official-search-design.md`（仅记录已验证档案与实施状态）

**Interfaces:**
- Produces an internal immutable `OfficialRegionalSearchProfile` with `regionCode`、`indexName`、`currency`、official URL path prefix and parser.
- Keeps `OfficialProductSearch.search(regionCode, query, signal)` unchanged.
- Uses `store_game_en_us`/`USD`、`store_game_es_mx`/`MXN`、`store_game_pt_br`/`BRL` respectively against `https://U3B6GR4UA3-dsn.algolia.net/1/indexes/*/queries`.

- [x] **Step 1: 写入失败测试**

扩展 `test/official-nintendo-search.test.ts` 的固定公开响应夹具。对 MX 和 BR 分别调用 `search("MX", "Overcooked 2", signal)`、`search("BR", "Overcooked 2", signal)`，断言请求体只包含对应的 `indexName`，返回候选的 `regionCode`、货币、URL 路径分别为 `MX`/`MXN`/`/es-mx/` 与 `BR`/`BRL`/`/pt-br/`。再断言货币不符、越区 URL、未知类型和金额精度错误的命中会被丢弃。

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/official-nintendo-search.test.ts`

Expected: FAIL，因为现有适配器仅接受 `US`，并固定读取美元与 `/us/` URL。

- [x] **Step 3: 最小适配器实现**

将当前 US 常量替换为不可变地区档案表。共享请求函数只接收已查表得到的档案，绝不读取浏览器提供的索引或货币；共享 JSON 解析函数把 `eshopDetails.currency`、官方相对 URL 前缀和金额小数位同档案逐项校验。保留现有请求超时、调用方取消、非成功 HTTP 和 `ProviderNetworkError` 语义。

代码中的中文注释必须明确：公开 Algolia key 不是秘密，但只可用于任天堂官网固定索引；地区档案防止把美区搜索结果误写成墨西哥或巴西商品；外部价格只用于候选展示，最终价格采集仍走既有官方价格解析器。

- [x] **Step 4: 运行适配器回归**

Run: `npm test -- --run test/official-nintendo-search.test.ts test/official-product-discovery-service.test.ts && npx tsc --noEmit`

Expected: PASS；US 行为不变，MX/BR 不再落入“官方搜索暂不可用”，非法命中不会进入发现服务。

- [x] **Step 5: 等待用户确认后提交并推送 Task 1**

拟提交范围：三地区官方搜索档案、受控解析、单元测试及设计状态更新。

```bash
git add src/worker/providers/official-nintendo-search.ts test/official-nintendo-search.test.ts docs/superpowers/specs/2026-07-18-multi-region-official-search-design.md docs/superpowers/plans/2026-07-18-multi-region-official-search.md
git commit -m "feat: search official mx and br stores"
git push origin main
```

### Task 2: 香港与日本官方网页搜索适配器

**Files:**
- Modify: `src/worker/providers/official-nintendo-search.ts`
- Modify: `src/worker/providers/official-nintendo-product-page.ts`（仅当该地区白名单或候选字段需与搜索页统一时）
- Modify: `test/official-nintendo-search.test.ts`
- Modify: `test/official-nintendo-product-page.test.ts`（如白名单扩展）

**Interfaces:**
- HK: fetch `https://www.nintendo.com/hk/search?k=<encoded query>` and parse only the official server-rendered `software.items` payload for the `hongkong` region.
- JP: fetch `https://search.nintendo.jp/nintendo_soft/search.json` with fixed `q`、`limit`、`page` and `opt_search` parameters; only numeric `*_DL` download records may map to the official Store URL.
- Both return `available` with zero candidates for a verified empty result, and `unavailable` for timeout, HTTP failure, redirect outside Nintendo hosts or unrecognised structure.

- [x] **Step 1: 写入失败测试**

在 `test/official-nintendo-search.test.ts` 添加两组不联网夹具：

1. HK 夹具含 Next/RSC 片段中的 `software.items`、`region: "hongkong"`、标题、NSUID、官方 eShop 模板与封面。断言候选 URL 必须是 `https://ec.nintendo.com/HK/zh/titles/{NSUID}`，且错误地区、错误模板、非数字 NSUID 或缺少标题不产生候选。
2. JP 夹具含 `search.nintendo.jp` 软件 API 的 `id`、`nsuid`、`sform`、标题、发行商和日元价格。断言请求仅带固定参数，最终候选只接受相等的数字 `id/nsuid` 与 `*_DL` 下载版，实体或聚合记录不得生成 Store URL。

测试还须覆盖两种适配器的空集合、超时和结构变化：结果分别为安全空集合或 `unavailable`，不得抛出外部 HTML/JSON 原文。

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/official-nintendo-search.test.ts test/official-nintendo-product-page.test.ts`

Expected: FAIL，因为当前非 US 地区直接返回 `unavailable`，无 HK/JP 请求与解析契约。

- [x] **Step 3: 最小网页解析实现**

为 HK 与 JP 添加独立、私有的请求/解析函数，不与 Algolia JSON 解析器混用。HK 只从被白名单包裹的 `software.items` 记录读取候选，并用实际 eShop 域名、固定模板和数字 NSUID 形成候选 URL；商品页解析器新增同一官方 eShop 域名白名单及公开 `search.*` 元数据读取。JP 只调用官方软件 API，从下载版数字 ID 形成 Store URL，并保留 API 回传的标题、发行商和日元价格。

若 HK RSC 或 JP 软件 API 在 Worker 网络或页面结构下无法被验证，适配器必须返回 `unavailable`，从而显示“粘贴本区任天堂官方商品链接”；不得使用搜索引擎、任天堂账户数据或第三方。

中文注释须解释 RSC/HTML 与搜索摘要均是不可信外部输入、为何限制跳转主机、以及日区队列页不能被当作商品搜索成功。

- [x] **Step 4: 运行搜索与链接解析回归**

Run: `npm test -- --run test/official-nintendo-search.test.ts test/official-nintendo-product-page.test.ts test/official-product-discovery-service.test.ts && npx tsc --noEmit`

Expected: PASS；HK/JP 有可验证公开结果时产生本区候选，无法验证时稳定回到官方链接兜底，不泄露页面内容。

- [x] **Step 5: 已确认并提交 Task 2**

拟提交范围：香港/日本官方网页搜索、必要的商品链接白名单、解析测试。

```bash
git add src/worker/providers/official-nintendo-search.ts src/worker/providers/official-nintendo-product-page.ts test/official-nintendo-search.test.ts test/official-nintendo-product-page.test.ts docs/superpowers/plans/2026-07-18-multi-region-official-search.md
git commit -m "feat: search official hk and jp stores"
git push origin main
```

### Task 3: 发现服务的自动加入与官方候选分流

**Files:**
- Modify: `src/worker/services/official-product-discovery-service.ts`
- Modify: `test/official-product-discovery-service.test.ts`
- Modify: `test/api-product-discovery.test.ts`

**Interfaces:**
- `automatic` remains one and only one strict identity match.
- `needs-manual-selection` returns verified same-type official candidates whenever the regional search produced candidates but no unique strict match.
- `needs-manual-link` is emitted only for unavailable search or a verified empty candidate set.

- [x] **Step 1: 写入失败测试**

在发现服务测试中使用 US 默认区锚点并模拟：

```ts
// 本地化标题相同类型：不能自动匹配，但必须给管理员候选卡。
expect(resolution).toMatchObject({ status: "needs-manual-selection", regionCode: "JP", candidates: [jpLocalizedCandidate()] });

// 两项严格匹配：必须人工选择；零项：才要求官方链接。
```

再覆盖唯一严格命中仍输出 `automatic`、不同商品类型候选不会进入人工列表、`unavailable` 不会伪装成空搜索。API 测试断言浏览器仍不能指定区域范围。

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/official-product-discovery-service.test.ts test/api-product-discovery.test.ts`

Expected: FAIL，因为现有 `matchRegion` 在零个严格匹配时直接要求手动链接，丢弃了本地化官方候选。

- [x] **Step 3: 最小发现服务实现**

保留 `hasSameOfficialIdentity` 作为自动匹配专用规则。`result.candidates` 先按区域、官方 URL、受控商品类型及 `candidate.productType` 过滤；严格匹配恰为一项返回 `automatic`，否则有同类型候选即返回 `needs-manual-selection`，仅已验证空集合或 `unavailable` 返回 `needs-manual-link`。候选顺序需按标题和官方 URL 稳定排序，避免同一响应重排造成页面闪烁或测试不确定。

中文注释必须说明“自动确认”与“管理员已选择”的信任边界不同：语言化标题不能由系统猜测，但不应迫使管理员在已有官方候选时复制链接。

- [x] **Step 4: 运行服务端回归**

Run: `npm test -- --run test/official-product-discovery-service.test.ts test/api-product-discovery.test.ts test/official-nintendo-search.test.ts && npx tsc --noEmit`

Expected: PASS；唯一安全结果自动加入，歧义或本地化结果出现候选列表，真正无结果才显示链接兜底。

- [x] **Step 5: 已确认并提交 Task 3**

拟提交范围：跨区发现分流、API 行为测试与确定性排序。

```bash
git add src/worker/services/official-product-discovery-service.ts test/official-product-discovery-service.test.ts test/api-product-discovery.test.ts docs/superpowers/plans/2026-07-18-multi-region-official-search.md
git commit -m "feat: offer official regional candidates"
git push origin main
```

### Task 4: 新建与补全确认的人工本地化校验

**Files:**
- Modify: `src/worker/services/subscription-confirmation-service.ts`
- Modify: `src/worker/services/subscription-region-completion-service.ts`
- Modify: `test/subscription-confirmation-service.test.ts`
- Modify: `test/subscription-region-completion.test.ts`

**Interfaces:**
- `automatic` mappings require `hasSameLogicalIdentity(anchor, verified)` exactly as today.
- `manual_selection` and `manual_link` require a Worker-resolved official URL for their declared region and the same `productType` as the anchor; their localized title/publisher need not equal the anchor.
- Existing enabled-region coverage and D1 atomicity checks remain unchanged.

- [x] **Step 1: 写入失败测试**

在新建和补全服务测试中分别加入 JP 本地化标题夹具。以 `manual_selection` 提交相同 `upgrade-pack` 类型并断言成功；以不同 `game` 类型提交并断言“地区商品与默认区商品身份不一致。”且仓储未写入。再以 `automatic` 和本地化标题提交，断言仍拒绝，防止放宽自动匹配规则。

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/subscription-confirmation-service.test.ts test/subscription-region-completion.test.ts`

Expected: FAIL，因为两个服务目前对所有 `matchSource` 都执行严格标题/发行商身份校验。

- [x] **Step 3: 最小确认实现**

抽取共享的受控验证函数（或在两个服务中保持同一小型受控规则），先重新解析 `region.productUrl`，再按 `matchSource` 选择严格自动身份或人工同类型身份规则。绝不信任浏览器提交的标题、币种、发行商和价格；最终入库字段永远取自 `verified`。保留现有地区范围、重复地区、默认区不可跳过和单批次写入校验。

中文注释需说明人工选择是管理员对本地化名称的审计确认，不是放行非官方链接、跨服 URL 或错误商品类型。

- [x] **Step 4: 运行确认回归**

Run: `npm test -- --run test/subscription-confirmation-service.test.ts test/subscription-region-completion.test.ts test/api-subscription-detail.test.ts && npx tsc --noEmit`

Expected: PASS；本地化候选能在人工操作后保存，自动匹配与非同类商品仍严格拒绝，失败不会留下部分地区商品。

- [x] **Step 5: 已确认并提交 Task 4**

拟提交范围：新建/补全服务的来源分级校验与原子性测试。

```bash
git add src/worker/services/subscription-confirmation-service.ts src/worker/services/subscription-region-completion-service.ts test/subscription-confirmation-service.test.ts test/subscription-region-completion.test.ts docs/superpowers/plans/2026-07-18-multi-region-official-search.md
git commit -m "feat: confirm localized official candidates"
git push origin main
```

### Task 5: 向导与订阅详情的自动状态和候选操作

**Files:**
- Modify: `src/app/subscription-wizard.ts`
- Modify: `src/app/subscription-wizard-page.tsx`
- Modify: `src/app/subscription-detail-page.tsx`
- Modify: `test/subscription-wizard.test.ts`
- Modify: `test/dashboard-page-state.test.ts`

**Interfaces:**
- `applyAutomaticRegionResolutions` continues to populate state without a click.
- Automatic rows render a non-interactive “已自动加入监控” state; no “采用自动匹配” button.
- `needs-manual-selection` renders selectable official candidate cards; `needs-manual-link` alone renders the official link input and skip action.

- [x] **Step 1: 写入失败测试**

在向导状态/组件测试中给出一个 automatic JP、一个 localised MX candidate list 和一个 unavailable HK：断言 JP 已在确认载荷中且页面没有接受按钮；MX 显示候选，点击后形成 `manual_selection`；HK 才显示官方链接输入。详情补全面板用同样三种状态断言，并确保自动结果仍须由最终“确认补全”写入。

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/subscription-wizard.test.ts test/dashboard-page-state.test.ts`

Expected: FAIL，因为现有页面将 automatic 显示为可重复点击的“采用自动匹配”，且发现服务不会为本地化候选返回候选卡。

- [x] **Step 3: 最小前端实现**

复用现有候选卡的封面、标题、类型、发行商、原价/折扣价布局。把 automatic 行改为只读状态文字；人工候选卡点击后加现有选中边框并更新同一 `candidateKey + regionCode` 的确认项。只有 `needs-manual-link` 渲染链接输入框；用户仍可对任何未确认地区显式跳过。详情页以相同语义展示，但不允许自动结果绕过最终补全按钮。

新增或修改的状态注释说明：前端仅表现 Worker 已验证的解析结果，不能把点击状态当作官方商品验证或地区范围授权。

- [x] **Step 4: 运行前端回归与构建**

Run: `npm test -- --run test/subscription-wizard.test.ts test/dashboard-page-state.test.ts && npx tsc --noEmit && npm run build`

Expected: PASS；自动结果无需再次选择，官方候选是首选人工路径，手动链接仅在无候选时出现，构建产物无类型错误。

- [x] **Step 5: 已确认并提交 Task 5**

拟提交范围：新订阅向导、已有订阅补全的三态展示和前端测试。

```bash
git add src/app/subscription-wizard.ts src/app/subscription-wizard-page.tsx src/app/subscription-detail-page.tsx test/subscription-wizard.test.ts test/dashboard-page-state.test.ts docs/superpowers/plans/2026-07-18-multi-region-official-search.md
git commit -m "feat: show automatic regional subscriptions"
git push origin main
```

### Task 6: 文档、质量门禁与生产受控验收

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/system-design.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/superpowers/specs/2026-07-18-multi-region-official-search-design.md`
- Modify: `docs/superpowers/plans/2026-07-18-multi-region-official-search.md`

- [x] **Step 1: 更新实施状态与验收记录**

记录五区官方搜索档案、自动/人工确认边界、JP 不可验证时的安全回退、以及“启用地区由设置决定”的约束。将 FR-001 的本次部分更新为已实施/待生产受控验收；不得宣称某地区已自动搜到真实商品，除非当次部署后实际验证。

- [x] **Step 2: 已运行完整质量门禁**

Run: `npm test -- --run && npx tsc --noEmit && npm run build && git diff --check && ! rg -n "regionCode !== \"US\"|store_game_en_us.*regionCode" src/worker/providers/official-nintendo-search.ts`

Expected: 所有测试、类型检查、构建与空白检查通过；官方搜索适配器不再把 MX、BR、HK、JP 一概标记为不可用。

- [x] **Step 3: 已获用户允许后部署并完成只读验收**

```bash
npm run deploy
curl --fail --silent --show-error https://switch-price-monitor.cchccp.workers.dev/api/auth/status
```

在已登录的浏览器中使用一个测试游戏：默认区选择后确认 US/MX/BR/HK/JP 分别显示自动、候选或官方链接兜底之一；验证地区范围与设置一致。只有管理员主动点击最终确认/补全时才验证写入；不读取或记录 Cookie、密码、恢复码及 Telegram 凭据。

- [ ] **Step 4: 等待用户确认后提交并推送 Task 6**

拟提交范围：实施状态、架构/API/质量验收记录与本计划勾选状态。

```bash
git add docs/README.md docs/requirements/traceability.md docs/architecture/system-design.md docs/architecture/api-design.md docs/quality/quality-and-acceptance.md docs/superpowers/specs/2026-07-18-multi-region-official-search-design.md docs/superpowers/plans/2026-07-18-multi-region-official-search.md
git commit -m "docs: complete multi-region official search"
git push origin main
```

## Final Acceptance

1. 美区选择某官方商品后，Worker 只针对保存的启用地区搜索，不接受浏览器指定地区范围。
2. US/MX/BR 使用各自的任天堂官方索引；HK/JP 使用各自官方网页/公开搜索路径，解析失败安全回退而非伪造候选。
3. 唯一严格匹配自动进入监控；本地化或多个官方候选可选择；空结果或不可用时才出现官方链接与跳过。
4. 最终确认重新验证官方链接，自动和人工来源遵守不同但受控的身份规则，并保证 D1 原子性。
5. 全量测试、类型检查、生产构建和受控生产验收通过；文档准确反映实际已验证范围。
