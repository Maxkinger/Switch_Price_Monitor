# 设置驱动的地区补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让新增和既有订阅都按服务端启用地区自动完成安全的官方商品映射，禁止静默创建只含默认区的订阅。

**Architecture:** Worker 的设置仓储是跨区范围唯一事实来源。默认区候选会触发服务端解析，自动身份匹配直接形成确认映射，无法验证的地区必须由管理员选择官方候选、核验官方链接或明确跳过。已有订阅使用已保存的地区商品作为锚点，在独立端点中以同一验证器原子补全缺失关联。

**Tech Stack:** TypeScript strict、Cloudflare Workers、D1、React 19、Vite、Vitest 4。

## Global Constraints

- 每次代码、测试、SQL、配置或文档改动前完整阅读 `AGENTS.md` 与 `docs/README.md`。
- 所有新增或修改的源代码、测试、SQL 与配置包含中文详细注释，并在提交前检查注释与实现一致。
- 测试先行：先运行失败测试，再做最小实现并运行相关回归。
- 价格来源、官方页面解析、地区范围、官方价格 ID 和 D1 写入只在 Worker 内执行；浏览器不读取 Cookie、秘密或外部响应正文。
- 跨区范围必须由保存的 `settings.enabledRegions` 决定；浏览器传入的地区数组不得扩大或缩小该范围。
- 新增与补全均要求每个目标启用地区为已确认或显式跳过；任何未覆盖、身份不符或官方链接验证失败都不得产生部分写入。
- 每次 Git 提交前向用户说明精确范围并获确认；确认后同一操作执行 `git commit` 和 `git push origin main`。

---

### Task 1: 服务端设置范围与新订阅覆盖校验

**Files:**
- Modify: `src/shared/domain.ts`
- Modify: `src/worker/services/official-product-discovery-service.ts`
- Modify: `src/worker/services/subscription-confirmation-service.ts`
- Modify: `src/worker/routes/product-routes.ts`
- Modify: `test/official-product-discovery-service.test.ts`
- Modify: `test/api-product-discovery.test.ts`
- Modify: `test/subscription-confirmation-service.test.ts`

**Interfaces:**
- Produces `ConfirmedSubscriptionInput.skippedRegionCodes: RegionCode[]`。
- Changes `OfficialProductDiscoveryService.resolveRegions(selected)` to read both `defaultSearchRegion` and `enabledRegions` from its settings reader.
- Changes `SubscriptionConfirmationService.confirm(inputs, now)` to reject each input whose current enabled-region set is not exactly partitioned into confirmed regions and `skippedRegionCodes`.

- [ ] **Step 1: 写入失败测试**

在发现服务测试中让设置返回 `enabledRegions: ["US", "JP"]`，调用时不提供地区数组，并断言只向 JP 搜索：

```ts
await service.resolveRegions([usCandidate()]);
expect(search.search).toHaveBeenCalledExactlyOnceWith("JP", usCandidate().canonicalTitle, expect.any(AbortSignal));
```

在确认服务测试中建立 US/JP 设置，提交只有 US 的 `regions` 和空 `skippedRegionCodes`，断言：

```ts
await expect(service.confirm([input], now)).rejects.toThrow("请确认或跳过所有已启用地区。");
expect(repository.createAtomically).not.toHaveBeenCalled();
```

再加入 JP 至 `skippedRegionCodes`，断言验证继续执行且只写入 US。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/official-product-discovery-service.test.ts test/subscription-confirmation-service.test.ts test/api-product-discovery.test.ts`

Expected: FAIL，因为发现服务仍接收浏览器地区数组，确认服务尚未理解跳过地区或读取设置。

- [ ] **Step 3: 最小服务端实现**

将设置读取端口收窄为：

```ts
export interface DiscoverySettingsReader {
  get(): Promise<{ defaultSearchRegion: RegionCode; enabledRegions: RegionCode[] } | null>;
}
```

在 `resolveRegions` 内部读取设置、排除候选自身地区，并调用既有 `matchRegion`；路由 `readRegionResolutionRequest` 只读取 `candidates`，拒绝旧 `enabledRegions` 字段而不信任它。

为确认服务注入同一窄设置读取端口。验证完成的 `regions` 与 `skippedRegionCodes` 时使用：

```ts
const covered = new Set([...regions.map((region) => region.regionCode), ...input.skippedRegionCodes]);
if (settings.enabledRegions.some((region) => !covered.has(region))) {
  throw new SubscriptionConfirmationError("请确认或跳过所有已启用地区。");
}
if (input.skippedRegionCodes.some((region) => !settings.enabledRegions.includes(region) || regions.some((item) => item.regionCode === region))) {
  throw new SubscriptionConfirmationError("跳过地区设置无效。");
}
```

`readConfirmedSubscription` 必须读取、去重并验证 `skippedRegionCodes`，且默认区不能被跳过。所有新增/修改注释说明设置是安全边界，不能由浏览器扩大来源请求范围。

- [ ] **Step 4: 运行服务端回归**

Run: `npm test -- --run test/official-product-discovery-service.test.ts test/subscription-confirmation-service.test.ts test/api-product-discovery.test.ts && npx tsc --noEmit`

Expected: PASS；服务端只处理设置地区，未处理地区无法绕过确认服务。

- [ ] **Step 5: 等待用户确认后提交并推送 Task 1**

拟提交范围：共享确认 DTO、设置驱动发现、确认覆盖校验、产品路由和相关测试。

```bash
git add src/shared/domain.ts src/worker/services/official-product-discovery-service.ts src/worker/services/subscription-confirmation-service.ts src/worker/routes/product-routes.ts test/official-product-discovery-service.test.ts test/subscription-confirmation-service.test.ts test/api-product-discovery.test.ts
git commit -m "feat: validate configured subscription regions"
git push origin main
```

### Task 2: 已有订阅地区补全 API 与原子写入

**Files:**
- Modify: `src/worker/repositories/subscription-confirmation-repository.ts`
- Modify: `src/worker/services/subscription-confirmation-service.ts`
- Modify: `src/worker/routes/subscription-routes.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/api-subscription-detail.test.ts`
- Create: `test/subscription-region-completion.test.ts`

**Interfaces:**
- Produces `POST /api/subscriptions/:id/resolve-regions` and `POST /api/subscriptions/:id/complete-regions`.
- Produces repository read model `{ subscriptionId, gameId, anchor: OfficialProductCandidate, existingRegionCodes: RegionCode[] }`.
- Produces `SubscriptionConfirmationService.resolveExisting(subscriptionId)` and `completeExisting(subscriptionId, regions, skippedRegionCodes, now)`.

- [ ] **Step 1: 写入失败测试**

使用 D1 夹具创建包含 US 地区商品、价格快照和目标价的订阅；调用补全服务添加 JP，断言：

```ts
expect(await detail(subscriptionId)).toMatchObject({ subscriptionId, regions: expect.arrayContaining([expect.objectContaining({ regionCode: "US" }), expect.objectContaining({ regionCode: "JP" })]) });
expect(await usSnapshotCount()).toBe(1);
expect(await targetFor(subscriptionId)).toEqual(existingTarget);
```

再令 JP 官方页面验证失败，断言 `regional_products` 和 `subscription_regions` 的行数均不变。路由测试覆盖 401、404、422 与成功响应，并确认解析端点不会接受浏览器地区范围。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/api-subscription-detail.test.ts test/subscription-region-completion.test.ts`

Expected: FAIL，因为当前订阅路由没有补全动作，确认仓储也不能读取锚点或只追加缺失地区。

- [ ] **Step 3: 最小原子补全实现**

在确认仓储增加参数化查询，读取订阅、游戏和一个既有地区商品作为锚点，并读取现有地区代码。`completeAtomically` 只能插入不在现有集合中的验证地区：

```ts
await this.database.batch(regions.flatMap((region) => [
  this.database.prepare("INSERT INTO regional_products (...) VALUES (...)").bind(/* 受控字段 */),
  this.database.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)").bind(subscriptionId, region.id),
]));
```

服务先读取锚点，通过 Task 1 的设置范围和官方重验证逻辑解析/验证全部新增候选，再一次性调用 `completeAtomically`。已存在的地区从待写入集合排除；既有地区在覆盖校验中仍视为已确认。路由在 `requireAdmin` 后识别两个新路径，使用安全中文 404/422/500 响应，且由 `index.ts` 注入现有官方页面解析器与价格 ID 服务。

- [ ] **Step 4: 运行补全回归**

Run: `npm test -- --run test/api-subscription-detail.test.ts test/subscription-region-completion.test.ts test/api-product-discovery.test.ts && npx tsc --noEmit`

Expected: PASS；补全只增加缺失地区，任一错误不产生部分写入。

- [ ] **Step 5: 等待用户确认后提交并推送 Task 2**

拟提交范围：补全仓储、确认服务、订阅路由/Worker 接线和补全 API 测试。

```bash
git add src/worker/repositories/subscription-confirmation-repository.ts src/worker/services/subscription-confirmation-service.ts src/worker/routes/subscription-routes.ts src/worker/index.ts test/api-subscription-detail.test.ts test/subscription-region-completion.test.ts
git commit -m "feat: complete configured subscription regions"
git push origin main
```

### Task 3: 向导自动确认、显式跳过与详情页补全界面

**Files:**
- Modify: `src/app/api-client.ts`
- Modify: `src/app/subscription-wizard.ts`
- Modify: `src/app/subscription-wizard-page.tsx`
- Modify: `src/app/dashboard-api-client.ts`
- Modify: `src/app/subscription-detail-page.tsx`
- Modify: `test/subscription-wizard.test.ts`
- Modify: `test/dashboard-api-client.test.ts`
- Modify: `test/dashboard-page-state.test.ts`

**Interfaces:**
- Produces `SubscriptionWizardState.skippedRegionalKeys: string[]` and `applyAutomaticRegionResolutions(state, resolutions)`.
- `resolveRegions(candidates)` no longer accepts a caller-owned region list.
- Produces detail-client `resolveMissingRegions(subscriptionId)` and `completeMissingRegions(subscriptionId, input)`.

- [ ] **Step 1: 写入失败测试**

在向导状态测试中传入一个 automatic JP 解析结果，断言自动确认键存在；再传入 HK 的手动链接状态，断言未跳过时：

```ts
expect(canConfirmConfiguredRegions(state, selected, resolutions)).toBe(false);
```

调用 `skipRegionalConfirmation` 后断言为 true，且 `buildConfirmationInputs` 生成 `skippedRegionCodes: ["HK"]`。

客户端测试断言 `/api/products/resolve-regions` 请求体只有 `candidates`；详情客户端测试断言两个新端点使用 `same-origin` Cookie。组件测试/状态测试断言详情页面补全成功后重新读取详情并显示安全结果提示。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/subscription-wizard.test.ts test/dashboard-api-client.test.ts test/dashboard-page-state.test.ts`

Expected: FAIL，因为当前向导有硬编码地区、不会自动确认，且确认按钮未检查未处理地区。

- [ ] **Step 3: 最小前端实现**

移除 `SubscriptionWizardPage` 中作为业务范围的 `regionChoices`，仅保留独立 `regionLabel` 显示映射。选中候选后调用：

```ts
const resolutions = await productApi.resolveRegions(selectedCandidates);
setWizard((current) => applyAutomaticRegionResolutions(current, resolutions));
```

每个非自动地区提供“跳过此区”切换。确认按钮的 `disabled` 使用 `canConfirmConfiguredRegions`；最终确认载荷只包含自动/人工确认候选和显式跳过代码。

在详情页加入“补全已启用地区”面板，复用候选卡/链接核验显示逻辑但不暴露游戏 ID 或已有商品 URL。成功调用 `completeMissingRegions` 后调用既有 `reload()`；401 使用 `onUnauthorized`，422 保留人工选择和跳过状态。

- [ ] **Step 4: 运行前端回归与构建**

Run: `npm test -- --run test/subscription-wizard.test.ts test/dashboard-api-client.test.ts test/dashboard-page-state.test.ts && npx tsc --noEmit && npm run build`

Expected: PASS；新订阅会自动采用安全匹配，未处理地区无法静默提交，详情可补全而不移除既有地区。

- [ ] **Step 5: 等待用户确认后提交并推送 Task 3**

拟提交范围：设置驱动的向导状态与页面、订阅详情补全界面、客户端和前端测试。

```bash
git add src/app/api-client.ts src/app/subscription-wizard.ts src/app/subscription-wizard-page.tsx src/app/dashboard-api-client.ts src/app/subscription-detail-page.tsx test/subscription-wizard.test.ts test/dashboard-api-client.test.ts test/dashboard-page-state.test.ts
git commit -m "feat: guide configured region completion"
git push origin main
```

### Task 4: 文档、全量验证与生产受控验收

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/superpowers/plans/2026-07-17-settings-driven-region-completion.md`

- [ ] **Step 1: 更新实施状态与验收说明**

将规格索引和 FR-001 更新为“已实施，待生产逐区验收”，记录：默认区仅是搜索入口、服务端设置为地区事实来源、自动匹配/显式跳过、已有订阅原子补全和不删除历史的边界。

- [ ] **Step 2: 运行完整质量门禁**

Run: `npm test -- --run && npx tsc --noEmit && npm run build && ! rg -n "regionChoices\.map\(\(region\) => region\.code\)|resolveRegions\([^)]*," src test && git diff --check`

Expected: 全部测试、类型检查和构建通过；生产代码不再把前端硬编码地区数组作为跨区解析范围。

- [ ] **Step 3: 生产迁移、部署与受控验收**

不需要数据迁移。获得用户明确允许后：

```bash
npm run deploy
curl --fail --silent --show-error https://switch-price-monitor.cchccp.workers.dev/api/auth/status
```

在已登录浏览器中选择一款现有 US 订阅，点击“补全已启用地区”。只对 Worker 已能可靠核验的地区执行最终确认；对其余地区验证人工选择、官方链接或跳过流程。Expected: 既有 US 快照和目标价保持，新增地区只在确认后采集，浏览器和日志不暴露 Cookie、密码、恢复码或 Telegram 凭据。

- [ ] **Step 4: 等待用户确认后提交并推送 Task 4**

拟提交范围：实施状态、验收记录和本计划。确认后执行：

```bash
git add docs/README.md docs/requirements/traceability.md docs/architecture/api-design.md docs/quality/quality-and-acceptance.md docs/superpowers/plans/2026-07-17-settings-driven-region-completion.md
git commit -m "docs: record configured region completion"
git push origin main
```

## 计划自检

- **规格覆盖：** Task 1 将地区范围和提交覆盖校验移到服务端；Task 2 原子补全已有订阅；Task 3 实现自动确认、显式跳过和两种页面入口；Task 4 覆盖文档、质量门禁和生产验收。
- **无占位检查：** 每个任务给出精确文件、接口、失败测试、执行命令、预期结果和提交范围；没有新增第三方来源、秘密字段或不受控的地区输入。
- **类型一致性：** `skippedRegionCodes` 在共享 DTO、产品确认、已有订阅补全和向导状态中使用同一 `RegionCode[]`；Task 2 复用 Task 1 的设置范围与官方重验证规则。
