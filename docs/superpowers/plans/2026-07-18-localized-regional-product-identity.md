# 跨语言地区商品高置信度识别 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让具有相同官方主标题、版本、发行商和类型的本地化地区商品安全自动匹配，并把未自动确认的日区候选按相关性优先显示和折叠。

**Architecture:** Worker 在 `OfficialProductDiscoveryService` 中保留既有严格匹配，并新增只依赖官方候选字段的高置信度本地化身份评分。`needs-manual-selection` 响应附带服务端计算的 `featuredCandidateCount`，前端只按这个受控数量显示候选卡、将剩余项折叠；浏览器不自行推断身份或匹配来源。

**Tech Stack:** TypeScript、Cloudflare Workers、React 19、Vitest、Testing Library、Vite。

## Global Constraints

- 默认区与启用地区继续仅由服务端已保存的设置决定。
- 只使用任天堂官方搜索候选和本区官方 URL，不能接入第三方、翻译服务、AI、Cookie 或账号数据。
- 所有新增或修改的源代码、测试、配置必须有中文详细注释，且注释与实现一致。
- 自动确认仅在同类型、同发行商、同拉丁主标题、同受控版本标记且唯一时发生；证据不足必须人工选择。
- 任何本地 Git 提交前均须先获用户明确确认，并在同一操作中推送 GitHub。

---

### Task 1: 服务端高置信度本地化身份与候选分层

**Files:**
- Modify: `src/worker/services/official-product-discovery-service.ts:14-137`
- Modify: `test/official-product-discovery-service.test.ts:78-132`

**Interfaces:**
- Consumes: `OfficialProductCandidate` 的 `canonicalTitle`、`publisher`、`productType` 与已校验的地区 URL。
- Produces: `RegionResolution` 的人工选择分支增加 `featuredCandidateCount: number`；自动分支仍是 `{ status: "automatic", candidate }`。

- [x] **Step 1: 写入失败的服务测试**

```ts
it("automatically matches one localized Japanese candidate with the same Latin title, edition, publisher and type", async () => {
  const anchor = usCandidate({ canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition" });
  const localized = japaneseCandidate({
    canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition",
    publisher: "Team17",
    productType: "game",
  });
  const service = new OfficialProductDiscoveryService(
    { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
    { search: async () => ({ status: "available" as const, candidates: [localized] }) },
    { resolve: async () => null },
  );

  await expect(service.resolveRegions([anchor])).resolves.toEqual([{
    candidateKey: `US:${anchor.productUrl}`, regionCode: "JP", status: "automatic", candidate: localized,
  }]);
});

it("keeps localized candidates manual when publisher is missing or high-confidence identity is not unique", async () => {
  const first = japaneseCandidate({ canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition" });
  const second = japaneseCandidate({ ...first, productUrl: "https://store-jp.nintendo.com/item/software/D70010000106253/" });
  const result = await createDiscoveryService({ status: "available", candidates: [second, first] }).resolveRegions([usCandidate({ canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition" })]);

  expect(result[0]).toMatchObject({ status: "needs-manual-selection", candidates: [first, second], featuredCandidateCount: 2 });
});
```

- [x] **Step 2: 运行测试并确认失败原因是尚无本地化匹配或 `featuredCandidateCount` 契约**

Run: `npm test -- test/official-product-discovery-service.test.ts`

Expected: FAIL；本地化唯一候选返回 `needs-manual-selection`，或人工响应尚无 `featuredCandidateCount`。

- [x] **Step 3: 实现最小服务端匹配和排序**

```ts
type CandidateRelevance = 0 | 1 | 2;

function localizedIdentityRelevance(anchor: OfficialProductCandidate, option: OfficialProductCandidate): CandidateRelevance {
  if (anchor.publisher === null || option.publisher === null || normalizeTitle(anchor.publisher) !== normalizeTitle(option.publisher)) return 0;
  const sharedLatinTitle = latinTitleMarker(anchor.canonicalTitle);
  const optionLatinTitle = latinTitleMarker(option.canonicalTitle);
  const sharedEdition = editionMarker(anchor.canonicalTitle);
  return sharedLatinTitle !== null && sharedLatinTitle === optionLatinTitle && sharedEdition !== null && sharedEdition === editionMarker(option.canonicalTitle) ? 2 : 0;
}

function latinTitleMarker(title: string): string | null {
  const marker = title.normalize("NFKC").toLocaleLowerCase().match(/[a-z]{3,}(?:[^\p{L}\p{N}]+\d+)+/u)?.[0];
  const normalized = marker?.replace(/[^a-z0-9]+/gu, "");
  return normalized && /[a-z]{3,}/u.test(normalized) && /\d/u.test(normalized) ? normalized : null;
}

function editionMarker(title: string): string | null {
  return /nintendo\s+switch\s*2\s+edition/iu.test(title.normalize("NFKC")) ? "nintendo-switch-2-edition" : null;
}
```

在 `matchRegion` 中先保留 `hasSameOfficialIdentity` 的唯一严格分支；严格分支失败后，以 `localizedIdentityRelevance` 对同类型官方候选稳定排序。只有恰好一个相关度为 `2` 的候选才返回 `automatic`；否则返回 `needs-manual-selection`，并将 `featuredCandidateCount` 设为相关度大于零的候选数量，若没有高相关候选则设为 `Math.min(3, candidates.length)`。为所有新函数和 `featuredCandidateCount` 的安全边界添加中文详细注释。

- [x] **Step 4: 运行服务测试确认通过**

Run: `npm test -- test/official-product-discovery-service.test.ts`

Expected: PASS，包含新增的本地化唯一、缺发行商、类型冲突和多个高置信度候选用例。

- [x] **Step 5: 更新前端 DTO 与状态测试契约**

在 `test/dashboard-page-state.test.ts` 的人工选择地区桩件补充 `featuredCandidateCount: 1`，并在 `src/app/api-client.ts` 的 `RegionResolutionResponse` 中增加只读字段：

```ts
| { candidateKey: string; regionCode: RegionCode; status: "needs-manual-selection"; candidates: OfficialProductCandidate[]; featuredCandidateCount: number }
```

服务端路由输出只透传受控 `RegionResolution`，浏览器请求体不新增可篡改的排序字段。

- [x] **Step 6: 运行 Worker 回归测试**

Run: `npm test -- test/official-product-discovery-service.test.ts test/api-product-discovery.test.ts`

Expected: PASS。

### Task 2: 人工候选折叠界面与交互回归

**Files:**
- Modify: `src/app/subscription-wizard-page.tsx:115-203`
- Modify: `src/app/styles.css:552-555`
- Create: `test/subscription-wizard-page.test.tsx`

**Interfaces:**
- Consumes: Worker 返回的 `needs-manual-selection.candidates` 与 `featuredCandidateCount`。
- Produces: 默认可见候选、唯一的“显示更多官方候选”按钮和可展开的剩余候选；任意候选点击仍调用既有 `onSelectCandidate`。

- [x] **Step 1: 写入失败的 DOM 测试**

```tsx
it("shows featured Japanese candidates first and expands the remaining official candidates only on request", async () => {
  const user = userEvent.setup();
  const api = createWizardApi({
    resolveRegions: vi.fn().mockResolvedValue([{
      candidateKey: candidateKey(usGame), regionCode: "JP", status: "needs-manual-selection",
      candidates: [relatedJapaneseGame, unrelatedJapaneseGame], featuredCandidateCount: 1,
    }]),
  });
  render(<SubscriptionWizardPage api={api} onUnauthorized={vi.fn()} />);

  await searchAndResolve(user, "Overcooked! 2");
  expect(screen.getByRole("button", { name: relatedJapaneseGame.canonicalTitle })).toBeVisible();
  expect(screen.queryByRole("button", { name: unrelatedJapaneseGame.canonicalTitle })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "显示更多官方候选（1）" }));
  expect(screen.getByRole("button", { name: unrelatedJapaneseGame.canonicalTitle })).toBeVisible();
});
```

- [x] **Step 2: 运行 DOM 测试并确认失败原因是尚未折叠候选**

Run: `npm run test:dom -- test/subscription-wizard-page.test.tsx`

Expected: FAIL；全部候选当前直接渲染，没有“显示更多官方候选”控制项。

- [x] **Step 3: 实现最小 UI 状态与可访问折叠控件**

在 `RegionalConfirmationPanel` 增加仅按 `selectedKey + regionCode` 保存展开状态的 `expandedRegionKeys` 属性和回调。人工选择分支按下列逻辑渲染：

```tsx
const visibleCandidates = expanded ? resolution.candidates : resolution.candidates.slice(0, resolution.featuredCandidateCount);
const hiddenCount = resolution.candidates.length - visibleCandidates.length;

{visibleCandidates.map((candidate) => <CandidateCard key={candidate.productUrl} /* 原有选择逻辑 */ />)}
{hiddenCount > 0 ? (
  <button type="button" className="text-button" aria-expanded={expanded} onClick={() => onToggleCandidateExpansion(key)}>
    {expanded ? "收起更多官方候选" : `显示更多官方候选（${hiddenCount}）`}
  </button>
) : null}
```

在 `SubscriptionWizardPage` 中以函数式 `setState` 更新展开键；每次新搜索和重新跨区核验时清空它，防止上一批候选的展开状态影响新响应。CSS 仅为折叠按钮添加现有暖色系统内的间距，不改变候选卡选中边框或价格布局。新增和修改的 React、CSS 注释须解释：展开是显示策略，不能影响 Worker 的官方验证或最终订阅载荷。

- [x] **Step 4: 运行 DOM 测试确认通过**

Run: `npm run test:dom -- test/subscription-wizard-page.test.tsx`

Expected: PASS；初始仅显示服务端推荐数量，展开后出现剩余官方候选，点击候选仍保持既有确认行为。

- [x] **Step 5: 运行全量质量门禁**

Run: `npm test && npm run test:dom && npx tsc --noEmit && npm run build && git diff --check`

Expected: 全部 PASS，且无 TypeScript、构建、格式或空白错误。

### Task 3: 文档、生产只读验证与交付

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-localized-regional-product-identity-design.md`
- Modify: `docs/superpowers/plans/2026-07-18-localized-regional-product-identity.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/quality/quality-and-acceptance.md`

**Interfaces:**
- Consumes: Task 1 的自动/人工分支测试结果，以及 Task 2 的 UI 交互结果。
- Produces: 实施状态、测试命令与生产只读核验记录；不产生订阅或价格快照。

- [x] **Step 1: 更新实施记录和验收追踪**

将规格状态改为“已实施，待生产只读验收”，记录严格匹配未放宽、唯一高置信度本地化匹配才自动确认、候选折叠只影响展示。将实施计划的 Task 1 和 Task 2 勾选为完成，并在需求追踪表和质量文档增加对应的回归命令与结果。

- [ ] **Step 2: 以已登录生产页面只读核验**

搜索 `Overcooked! 2`，选定 `Overcooked! 2 – Nintendo Switch 2 Edition`，点击“核验其他地区”。确认日区自动显示 `Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition`，或在存在歧义时其出现在第一屏；不得点击“确认订阅”。

- [ ] **Step 3: 最终验证并请求提交确认**

Run: `npm test && npm run test:dom && npx tsc --noEmit && npm run build && git diff --check && git status --short`

Expected: 全部通过，工作区仅包含本功能代码、测试与文档。随后向用户说明将提交的文件范围，并在获得明确确认后于同一操作中执行 `git add`、`git commit -m "feat: improve localized regional matching"` 和 `git push origin main`。
