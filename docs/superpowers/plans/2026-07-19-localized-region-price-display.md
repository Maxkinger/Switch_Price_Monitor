# Localized Region Price Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让仪表盘和订阅详情使用中文地区名称，并按管理员确认的五区任天堂价格文字显示本地金额。

**Architecture:** 在 `dashboard-view-model.ts` 集中维护地区名称与地区级价格格式化，仪表盘和详情页只消费同一组纯函数。Worker 继续传输原地区代码、最小货币单位和币种；本次不改采集、数据库或 API 金额。

**Tech Stack:** React 19、TypeScript 5.8、Vitest、Testing Library、Vite。

## Global Constraints

- 仅覆盖仪表盘和订阅详情；不改订阅向导、Worker、D1、Cron、价格来源和 Telegram。
- 五区固定文字：美国区 `$ 39.99`、墨西哥区 `$ 39.99`、日本区 `1,999 円（税込）`、巴西区 `R$ 99.00`、香港区 `HKD 198`。
- 货币符号或代码与金额之间恰好一个空格；日本价格的 `円（税込）` 是价格文字的一部分。
- 未知地区显示原地区代码与既有安全币种后备格式；不得猜测中文名称、符号或税率。
- 新增或改动的代码、测试和文档都必须保留准确中文注释。
- 每次提交前必须先获得管理员确认；确认后同一流程执行提交和 `git push origin main`。

---

### Task 1: 集中地区名称与本地价格格式

**Files:**
- Modify: `src/app/dashboard-view-model.ts`
- Modify: `test/dashboard-view-model.test.ts`

**Interfaces:**
- Produces: `formatRegionName(regionCode: string): string`。
- Produces: `formatRegionalPrice(amountMinor: number, currency: string, regionCode: string): string`。

- [x] **Step 1: 写失败测试**

在 `test/dashboard-view-model.test.ts` 新增：

```ts
it("uses confirmed Chinese names and official price copy", () => {
  expect(formatRegionName("US")).toBe("美国区");
  expect(formatRegionName("MX")).toBe("墨西哥区");
  expect(formatRegionName("JP")).toBe("日本区");
  expect(formatRegionName("BR")).toBe("巴西区");
  expect(formatRegionName("HK")).toBe("香港区");
  expect(formatRegionName("CA")).toBe("CA");
  expect(formatRegionalPrice(3999, "USD", "US")).toBe("$ 39.99");
  expect(formatRegionalPrice(3999, "MXN", "MX")).toBe("$ 39.99");
  expect(formatRegionalPrice(1999, "JPY", "JP")).toBe("1,999 円（税込）");
  expect(formatRegionalPrice(9900, "BRL", "BR")).toBe("R$ 99.00");
  expect(formatRegionalPrice(19800, "HKD", "HK")).toBe("HKD 198");
  expect(formatRegionalPrice(1299, "CAD", "CA")).toBe("CAD 12.99");
});
```

测试注释说明 US/MX 共用 `$` 的地区语义由相邻中文名称承担，不能擅自添加未确认前缀。

- [x] **Step 2: 确认 RED**

Run: `npx vitest run test/dashboard-view-model.test.ts`  
Expected: FAIL，原因是新函数尚未导出或实现。

- [x] **Step 3: 最小实现共享函数**

在 `src/app/dashboard-view-model.ts` 增加中文注释、映射和函数：

```ts
const REGION_NAMES: Record<string, string> = {
  US: "美国区", MX: "墨西哥区", JP: "日本区", BR: "巴西区", HK: "香港区",
};

export function formatRegionName(regionCode: string): string {
  return REGION_NAMES[regionCode] ?? regionCode;
}

export function formatRegionalPrice(amountMinor: number, currency: string, regionCode: string): string {
  const twoDecimals = (amountMinor / 100).toFixed(2);
  if (regionCode === "US" || regionCode === "MX") return `$ ${twoDecimals}`;
  if (regionCode === "JP") return `${new Intl.NumberFormat("en-US").format(amountMinor)} 円（税込）`;
  if (regionCode === "BR") return `R$ ${twoDecimals}`;
  if (regionCode === "HK") {
    const amount = amountMinor / 100;
    return `HKD ${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2)}`;
  }
  return formatFallbackLocalPrice(amountMinor, currency);
}
```

把当前 `formatLocalPrice` 的后备精度规则移入私有 `formatFallbackLocalPrice`，保持未知币种行为不变。

- [x] **Step 4: 确认 GREEN**

Run: `npx vitest run test/dashboard-view-model.test.ts`  
Expected: PASS；五区均为确认文字且未知地区安全回退。

- [x] **Step 5: 任务提交门禁（已随最终变更推送 `17e64f5`）**

Run: `git diff --check`  
Expected: 无输出。

管理员确认后，依次执行 `git add src/app/dashboard-view-model.ts test/dashboard-view-model.test.ts`、`git commit -m "feat: localize regional price display"`、`git push origin main`。

### Task 2: 接入仪表盘与订阅详情

**Files:**
- Modify: `src/app/dashboard-page.tsx`
- Modify: `src/app/subscription-detail-page.tsx`
- Modify: `test/dashboard-page.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `formatRegionName`、`formatRegionalPrice`。
- Produces: 两页对同一 `DashboardRegion` 的一致展示。

- [x] **Step 1: 写失败 DOM 测试**

扩展 Overcooked 五区夹具，并添加：

```tsx
expect(await screen.findByText("美国区")).toBeTruthy();
expect(screen.getByText("$ 39.99")).toBeTruthy();
expect(screen.queryByText("US · USD")).toBeNull();
expect(screen.getByText("日本区")).toBeTruthy();
expect(screen.getByText("1,999 円（税込）")).toBeTruthy();
expect(screen.getByText("香港区")).toBeTruthy();
expect(screen.getByText("HKD 198")).toBeTruthy();
```

- [x] **Step 2: 确认 RED**

Run: `npm run test:dom -- --run test/dashboard-page.test.tsx`  
Expected: FAIL，当前页面仍显示代码或 `US · USD`。

- [x] **Step 3: 最小页面接线**

两个页面均导入 Task 1 函数。仪表盘地区行使用：

```tsx
<b>{formatRegionName(region.regionCode)}</b>
<span>{formatRegionalPrice(region.current.amountMinor, region.currency, region.regionCode)}</span>
```

详情标题改为 `<h3>{formatRegionName(region.regionCode)}</h3>`；当前价和历史最低价均使用 `formatRegionalPrice`。保留来源、人民币估算、采集时间、过期状态、等待首笔价格和管理操作。

- [x] **Step 4: 确认 GREEN**

Run: `npm run test:dom -- --run test/dashboard-page.test.tsx`  
Expected: PASS；五区中文名、价格文字和无重复币种代码均可见。

- [x] **Step 5: 任务提交门禁（已随最终变更推送 `17e64f5`）**

Run: `git diff --check`  
Expected: 无输出。

管理员确认后，依次执行 `git add src/app/dashboard-page.tsx src/app/subscription-detail-page.tsx test/dashboard-page.test.tsx`、`git commit -m "feat: show localized regions in price views"`、`git push origin main`。

### Task 3: Overcooked 五区草图与完整验收

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/superpowers/specs/2026-07-19-localized-region-price-display-design.md`

**Interfaces:**
- Consumes: Task 1–2 的固定测试夹具和本地 Vite 页面。
- Produces: 一张不含真实订阅数据的桌面草图与验收文档记录。

- [x] **Step 1: 构造仅本地的静态草图**

以《Overcooked! 2 – Nintendo Switch 2 Edition》显示五行：

```text
美国区      $ 39.99
墨西哥区    $ 39.99
日本区      1,999 円（税込）
巴西区      R$ 99.00
香港区      HKD 198
```

草图不得写入订阅、价格快照、生产 API 或官方商店。

- [x] **Step 2: 浏览器视觉验证（语义 DOM 与控制台）**

流转：本地详情草图 → 查看五区地区价格 → 确认中文名称、一个空格、无 `USD/MXN/JPY/BRL` 重复文字。使用 Browser 插件验证页面身份、非空 DOM、无框架错误、控制台和桌面截图；必要时再检查一个窄屏视口。

- [x] **Step 3: 全量质量门禁**

Run: `npm test -- --run`  
Expected: 所有 Worker 测试通过。

Run: `npm run test:dom -- --run`  
Expected: 所有 DOM 测试通过。

Run: `npx tsc --noEmit`  
Expected: 退出码 0。

Run: `npm run build`  
Expected: Vite 生产构建成功。

Run: `git diff --check`  
Expected: 无输出。

- [x] **Step 4: 更新文档状态**

README 标记本规格已实现、草图已审阅；追踪表记录两页共用地区与价格展示规则；规格补记草图结论和零业务写入边界。

- [x] **Step 5: 任务提交门禁（已随最终变更推送 `17e64f5`）**

管理员确认后，依次执行 `git add docs/README.md docs/requirements/traceability.md docs/superpowers/specs/2026-07-19-localized-region-price-display-design.md`、`git commit -m "docs: record localized price display acceptance"`、`git push origin main`。

---

## 计划自检

- 五区固定价格、中文地区、一个空格、未知回退、两页统一、静态草图和零业务写入均有任务覆盖。
- 共享函数在 Task 1 定义，Task 2 只消费已定义接口。
- 每个代码任务均包含 RED、GREEN、差异检查和管理员确认后的提交推送。
- 不新增 API、数据库、依赖、定时任务或生产部署步骤。
