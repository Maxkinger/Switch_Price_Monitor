# 港区核验即时中文名预览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在“核验其他地区”完成后立即在港区卡片展示最终中文名，同时保留港区官方原标题供管理员核对。

**Architecture:** 向导在现有地区核验成功后，以同一批受 Worker 核验的地区候选调用既有名称预览 API。预览按默认区锚点保存；仅已确认 HK 候选的卡片消费中文名，人工链接状态不猜测名称。最终确认服务仍独立重验并持久化名称，不信任浏览器预览。

**Tech Stack:** React 19、TypeScript、现有 `previewGameNames` 同源 API、Vitest/jsdom。

## Global Constraints

- 名称优先级固定为大陆同 ID 官方标题、香港官方繁转简、人工中文、官方英文回退；禁止机器翻译或标题词表猜测。
- 名称预览仅使用 Worker 返回的脱敏 DTO；浏览器不得提交名称来源、商品 ID 或官方 URL 来替代服务端核验。
- 港区人工链接未核验前不得显示猜测中文名；最终确认仍须重新读取官方来源。
- 所有新增或修改的源码、测试和文档须有与实现一致的中文详细注释。
- 功能改动遵循测试先行；不提交或推送，除非管理员再次明确确认。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/app/subscription-wizard-page.tsx` | 在地区核验和港区人工链接核验成功后请求名称预览，并让港区卡片消费最终中文主标题与官方英文副标题。 |
| `test/subscription-wizard-page.test.tsx` | 通过真实页面交互覆盖自动港区、待人工链接和预览失败三个展示边界。 |
| `docs/requirements/PRD.md` | 记录管理员在地区核验阶段可见中文预览与官方英文核对文本。 |
| `docs/requirements/traceability.md` | 增加即时预览规则与 DOM 验收映射。 |
| `docs/architecture/api-design.md` | 说明现有预览端点会在地区核验后被调用，且不授权最终保存。 |

### Task 1: 在地区核验后安全刷新名称预览

**Files:**
- Modify: `test/subscription-wizard-page.test.tsx`
- Modify: `src/app/subscription-wizard-page.tsx`

**Interfaces:**
- Consumes: `api.resolveRegions(candidates): Promise<RegionResolutionResponse[]>`。
- Consumes: `api.previewGameNames(inputs): Promise<GameNamePreview[]>`。
- Produces: 港区已确认卡片的 `最终中文名` 主标题和 `官方标题：{canonicalTitle}` 副标题。

- [x] **Step 1: 写港区自动候选的失败 DOM 测试**

```tsx
it("shows the verified Chinese name above the Hong Kong official title after regional verification", async () => {
  const api = wizardApi([{ candidateKey, regionCode: "HK", status: "automatic", candidate: hongKongCandidate }]);
  vi.mocked(api.previewGameNames).mockResolvedValue([{ nameZh: "胡闹厨房 2", source: "hong_kong_official" }]);
  render(<SubscriptionWizardPage api={api} onUnauthorized={vi.fn()} />);
  await selectCandidateAndResolveRegions(user);
  expect(await screen.findByText("胡闹厨房 2")).toBeTruthy();
  expect(screen.getByText(`官方标题：${hongKongCandidate.canonicalTitle}`)).toBeTruthy();
});
```

- [x] **Step 2: 运行测试确认失败原因是核验后尚未请求/展示名称预览**

Run: `npm run test:dom -- test/subscription-wizard-page.test.tsx -t "shows the verified Chinese name"`

Expected: FAIL，港区卡仅渲染 `canonicalTitle`，且 `previewGameNames` 没有在“核验其他地区”后被调用。

- [x] **Step 3: 实现最小的预览刷新与港区卡展示**

```ts
// 仅在本次地区解析代次仍有效时，从最新向导状态派生下一状态；副作用在 React 状态更新之外启动，预览严格绑定 Worker 已核验的 HK URL。
const next = applyAutomaticRegionResolutions(wizardStateRef.current, resolved);
updateWizard(next);
void refreshGameNamePreviews(next, resolved, generation);

// 港区卡只在 Worker 已给出非 unavailable 名称预览时替换主标题；官方原始标题始终保留为副标题供身份复核。
const title = resolution.regionCode === "HK" && preview?.nameZh ? preview.nameZh : candidate.canonicalTitle;
```

为异步预览提取窄辅助函数，接收已解析向导状态、当前默认区候选和代次；预览异常仅显示安全提示，不能清空地区候选、改变跳过状态或创建订阅。

- [x] **Step 4: 运行港区 DOM 测试确认通过**

Run: `npm run test:dom -- test/subscription-wizard-page.test.tsx -t "shows the verified Chinese name"`

Expected: PASS；卡片显示中文主标题和港区官方英文副标题，且预览请求收到包含同一 HK 候选的输入。

### Task 2: 锁定人工链接与不可用预览边界

**Files:**
- Modify: `test/subscription-wizard-page.test.tsx`
- Modify: `src/app/subscription-wizard-page.tsx`

**Interfaces:**
- Consumes: `GameNamePreview = { nameZh: string | null; source: "mainland_official" | "hong_kong_official" | "unavailable" }`。
- Produces: 人工 HK 链接待核验提示，及预览不可用时的受控回退说明。

- [x] **Step 1: 写两个失败 DOM 测试**

```tsx
it("does not invent a Chinese Hong Kong title before an administrator verifies its official link", async () => {
  renderWithHongKongManualLink();
  await selectCandidateAndResolveRegions(user);
  expect(screen.getByText("核验后可确定中文名称")).toBeTruthy();
  expect(screen.queryByText("胡闹厨房 2")).toBeNull();
});

it("keeps the official Hong Kong title and explains the final fallback when preview is unavailable", async () => {
  vi.mocked(api.previewGameNames).mockResolvedValue([{ nameZh: null, source: "unavailable" }]);
  await selectCandidateAndResolveRegions(user);
  expect(screen.getByText(hongKongCandidate.canonicalTitle)).toBeTruthy();
  expect(screen.getByText("最终确认时可填写中文名称或保留官方英文标题")).toBeTruthy();
});
```

- [x] **Step 2: 运行两个测试确认失败原因是人工链接核验后未刷新名称预览**

Run: `npm run test:dom -- test/subscription-wizard-page.test.tsx -t "does not invent|keeps the official Hong Kong title"`

Expected: FAIL；当前组件没有区分港区待链接和不可用预览的名称展示状态。

- [x] **Step 3: 实现最小状态分支**

```tsx
if (resolution.regionCode === "HK" && resolution.status === "needs-manual-link") {
  return <small>核验后可确定中文名称</small>;
}
if (resolution.regionCode === "HK" && preview?.source === "unavailable") {
  return <small>最终确认时可填写中文名称或保留官方英文标题</small>;
}
```

港区人工链接成功后的 `handleResolveRegionalLink` 必须在写入 Worker 返回候选后刷新名称预览；不得使用输入 URL 或输入框文本作为标题来源。

- [x] **Step 4: 运行完整向导 DOM 回归**

Run: `npm run test:dom -- test/subscription-wizard-page.test.tsx`

Expected: PASS；原有名称回退、最终确认和跨区候选折叠用例不回归。

### Task 3: 同步规则文档与最终验证

**Files:**
- Modify: `docs/requirements/PRD.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/superpowers/specs/2026-07-26-hong-kong-name-preview-design.md`
- Modify: `docs/superpowers/plans/2026-07-26-hong-kong-name-preview.md`

**Interfaces:**
- Consumes: 已实现的地区核验、名称预览和最终确认边界。
- Produces: 可追溯的即时预览规则与质量门禁记录。

- [x] **Step 1: 先更新文档中的规则与验收映射**

在 PRD 写明“港区已验证后显示最终中文主标题与官方原标题副标题；未核验链接不猜测中文名”。在追踪表写入对应 DOM 测试。API 文档说明 `preview-game-names` 是读取预览接口，最终确认仍会重验。

- [x] **Step 2: 运行验证命令**

Run: `npm run test:dom -- test/subscription-wizard-page.test.tsx`

Expected: PASS。

Run: `npx tsc --noEmit`

Expected: PASS。

Run: `npm run build`

Expected: PASS。

Run: `git diff --check`

Expected: 无输出且退出码为 0。

- [x] **Step 3: 更新规格与计划状态并检查注释一致性**

将设计规格状态改为“已实施，待管理员确认提交推送”，勾选计划任务。逐项检查 `subscription-wizard-page.tsx` 和新增测试的中文注释仍准确描述 Worker 核验、代次失效和人工名称安全边界。

## 计划自检

- **规格覆盖：** Task 1 处理核验后预览和港区卡双标题；Task 2 处理未核验链接与不可用预览；Task 3 同步文档与验证。
- **占位符：** 已检查，不含 TBD、TODO 或未定义的后续实现。
- **类型一致性：** 计划仅消费已存在的 `GameNamePreview`、`RegionResolutionResponse`、`ConfirmedSubscriptionInput` 和 `previewGameNames` 客户端方法，未引入新的跨层 DTO。
