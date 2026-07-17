# 仪表盘与订阅详情实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为已登录管理员提供概览优先的仪表盘和可管理订阅状态、已确认地区及目标价的单页详情。

**Architecture:** Worker 将仪表盘概览和订阅详情分别构造成受保护、类型明确的读取 DTO；浏览器只调用同源 API，并用 History API 在仪表盘、添加订阅和订阅详情间切换。详情页复用既有订阅 PATCH 与历史快照 API，所有价格、来源、最低价和过期状态均由 Worker 提供，不在浏览器猜测。

**Tech Stack:** React 19、TypeScript、Cloudflare Workers、D1、Vitest、Vite。

## Global Constraints

- 每次代码、测试、SQL、配置或文档改动前完整阅读 `AGENTS.md` 和 `docs/README.md`。
- 所有新增或修改的源代码、测试代码、SQL 与配置使用与实现一致的中文详细注释；认证、价格来源、汇率、通知和数据保留要说明安全或业务原因。
- 测试先行：每项实现先写失败测试，确认因目标能力缺失失败，再实现最小代码。
- 浏览器只访问同源 `/api/*`；不得从前端请求任天堂、第三方价格站、汇率服务或 Telegram。
- 任何价格均显示 Worker 返回的本币、人民币估算、来源和状态；不得补零、猜测来源或把第三方伪装为官方。
- 未获准第三方来源继续保持不请求网络的禁用边界。
- 提交前必须向用户说明确切范围并获得确认；确认后同一操作完成 `git commit` 和 `git push origin main`。

---

### Task 1: 建立受保护的订阅详情读取模型

**Files:**
- Create: `src/worker/repositories/subscription-detail-repository.ts`
- Create: `src/worker/services/subscription-detail-service.ts`
- Create: `test/api-subscription-detail.test.ts`
- Modify: `src/worker/routes/subscription-routes.ts`

**Interfaces:**
- Consumes: `subscriptions`、`games`、`regional_products`、`subscription_regions`、`subscription_region_targets`、`price_snapshots`、`regional_product_health`。
- Produces: `GET /api/subscriptions/:id` → `SubscriptionDetail`，其形状为 `{ subscriptionId, game: { id, nameZh, nameEn, productType }, enabled, globalTargetCnyFen, regionTargets, regions }`；每个 `regions` 项必须含 `regionalProductId`、`regionCode`、`currency`、`monitored`、`current`、`historicalLow` 和 `isStale`。

- [x] **Step 1: 写入订阅详情与匿名/不存在订阅的失败测试**

```ts
it("returns a subscribed game's confirmed regions, targets, current price and historical low", async () => {
  const response = await call("/api/subscriptions/subscription-overcooked-2", cookie, "GET");
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    subscriptionId: "subscription-overcooked-2",
    enabled: true,
    globalTargetCnyFen: 5000,
    regionTargets: [{ regionCode: "JP", targetAmountMinor: 800 }],
    regions: [expect.objectContaining({ regionalProductId: "product-overcooked-2-us", monitored: true })],
  });
});

it("does not expose subscription detail without a session and returns 404 for an unknown id", async () => {
  expect((await call("/api/subscriptions/subscription-overcooked-2", "", "GET")).status).toBe(401);
  expect((await call("/api/subscriptions/missing", cookie, "GET")).status).toBe(404);
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/api-subscription-detail.test.ts`

Expected: FAIL，因为 `GET /api/subscriptions/:id` 尚未由订阅路由处理。

- [x] **Step 3: 实现仓储、服务与 GET 路由**

```ts
export interface SubscriptionDetailRepositoryPort {
  find(id: string): Promise<SubscriptionDetail | null>;
}

export class SubscriptionDetailService {
  public constructor(private readonly details: SubscriptionDetailRepositoryPort) {}
  public async get(subscriptionId: string): Promise<SubscriptionDetail> {
    const detail = await this.details.find(subscriptionId);
    if (!detail) throw new SubscriptionNotFoundError("订阅不存在。");
    return detail;
  }
}
```

仓储先读取订阅、游戏和全局目标价，再读取该游戏的全部已确认地区商品；通过 `LEFT JOIN subscription_regions` 写出 `monitored`，而不是只读取当前监控地区，以便详情页可安全勾选已经验证的地区。每个地区用相关子查询读取最新和本币历史最低快照，并用 `regional_product_health.consecutive_failures > 0` 写出 `isStale`。目标价查询仅返回地区代码与最小货币单位，绝不返回会话、恢复码、Telegram 配置、原始错误或外站响应。

在 `readSubscriptionAction` 中增加 `{ kind: "read"; subscriptionId: string }`，仅匹配 `GET /^\/api\/subscriptions\/([^/]+)$/`；会话校验继续先于数据库读取，服务抛出的 `SubscriptionNotFoundError` 复用既有安全 `404` 响应。

- [x] **Step 4: 运行订阅详情与既有订阅管理回归测试**

Run: `npm test -- --run test/api-subscription-detail.test.ts test/api-subscriptions.test.ts`

Expected: PASS；详情返回当前/最低快照和目标价，匿名为 401，不存在订阅为 404，既有 PATCH 行为不变。

- [ ] **Step 5: 提交订阅详情读取模型**

```bash
git add src/worker/repositories/subscription-detail-repository.ts src/worker/services/subscription-detail-service.ts src/worker/routes/subscription-routes.ts test/api-subscription-detail.test.ts
git commit -m "feat: add subscription detail read model"
```

### Task 2: 扩展仪表盘概览的统计、日报与价格状态

**Files:**
- Modify: `src/worker/services/dashboard-service.ts`
- Modify: `src/worker/routes/dashboard-routes.ts`
- Modify: `test/api-dashboard.test.ts`

**Interfaces:**
- Consumes: 既有订阅/快照查询和 `settings.timezone`、`settings.daily_report_time`。
- Produces: `DashboardOverview = { stats: { monitoredSubscriptionCount, availableRegionPriceCount, lastCapturedAt, nextDailyReportAt }, subscriptions: DashboardSubscription[] }`；每个地区 `current` 和 `historicalLow` 保留金额、币种、来源和捕获时间，另含 `isStale`。

- [x] **Step 1: 写入概览统计、下次日报和地区过期状态的失败测试**

```ts
it("returns dashboard statistics and marks a region stale after collection failures", async () => {
  await seedSnapshotsAndHealth();
  const body = await (await call("/api/dashboard", cookie)).json<DashboardOverview>();
  expect(body.stats).toEqual({
    monitoredSubscriptionCount: 1,
    availableRegionPriceCount: 2,
    lastCapturedAt: "2026-07-17T00:00:00.000Z",
    nextDailyReportAt: expect.any(String),
  });
  expect(body.subscriptions[0].regions[0].isStale).toBe(true);
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/api-dashboard.test.ts`

Expected: FAIL，因为现有响应没有 `stats` 和地区 `isStale` 字段。

- [x] **Step 3: 实现类型明确的概览 DTO 和时间计算**

```ts
export interface DashboardOverview {
  stats: {
    monitoredSubscriptionCount: number;
    availableRegionPriceCount: number;
    lastCapturedAt: string | null;
    nextDailyReportAt: string | null;
  };
  subscriptions: DashboardSubscription[];
}

function nextDailyReportAt(now: Date, timezone: string, dailyReportTime: string): string {
  for (let offset = 60_000; offset <= 26 * 60 * 60 * 1_000; offset += 60_000) {
    const candidate = new Date(now.getTime() + offset);
    if (formatHourMinute(candidate, timezone) === dailyReportTime) return candidate.toISOString();
  }
  throw new Error("无法计算下一次日报时间。");
}
```

`DashboardService.getOverview(now = new Date())` 读取设置单例；未初始化设置时 `nextDailyReportAt` 为 `null`。地区查询 `LEFT JOIN regional_product_health`，只有快照存在且连续失败次数大于零才标为过期；从未采集的地区保持 `current: null` 和 `isStale: false`。统计只计算 `enabled = 1` 的订阅和非空当前快照，最后成功时间取所有最新快照的最大捕获时间；不要将浏览器时间、Telegram Secret 或价格来源正文写入响应。

- [x] **Step 4: 运行概览、日报与 Worker 调度回归测试**

Run: `npm test -- --run test/api-dashboard.test.ts test/report-service.test.ts test/scheduler-service.test.ts`

Expected: PASS；新增 DTO 仍可被日报调度读取，且空仪表盘保持稳定安全响应。

- [ ] **Step 5: 提交仪表盘读取模型**

```bash
git add src/worker/services/dashboard-service.ts src/worker/routes/dashboard-routes.ts test/api-dashboard.test.ts
git commit -m "feat: enrich dashboard overview"
```

### Task 3: 建立浏览器同源客户端、路由与展示纯函数

**Files:**
- Create: `src/app/dashboard-api-client.ts`
- Create: `src/app/app-navigation.ts`
- Create: `src/app/dashboard-view-model.ts`
- Create: `test/dashboard-api-client.test.ts`
- Create: `test/app-navigation.test.ts`
- Create: `test/dashboard-view-model.test.ts`

**Interfaces:**
- Consumes: `GET /api/dashboard`、`GET /api/subscriptions/:id`、`GET /api/history`、`POST /api/refresh`、`PATCH /api/subscriptions/:id`。
- Produces: `createDashboardApiClient(request?)`、`DashboardApiError`、`readAppRoute(pathname)`、`dashboardPath()`、`subscriptionDetailPath(id)`、`formatLocalPrice()`、`formatCnyFen()` 和 `trendPointsFor()`。

- [ ] **Step 1: 写入同源请求、路由解析、格式化和趋势筛选的失败测试**

```ts
it("uses same-origin credentials for dashboard detail and subscription writes", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ subscriptions: [] }));
  await createDashboardApiClient(request).getDashboard();
  expect(request).toHaveBeenCalledWith("/api/dashboard", expect.objectContaining({ credentials: "same-origin" }));
});

it("maps a subscription URL and formats JPY without decimal places", () => {
  expect(readAppRoute("/subscriptions/subscription-overcooked-2")).toEqual({ kind: "subscription-detail", subscriptionId: "subscription-overcooked-2" });
  expect(formatLocalPrice(1000, "JPY")).toBe("JP¥1,000");
});

it("keeps only CNY-comparable snapshots for an all-region trend", () => {
  expect(trendPointsFor(snapshots, null)).toEqual([{ capturedAt: "2026-07-17T00:00:00.000Z", cnyFen: 4174, regionCode: "JP" }]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/dashboard-api-client.test.ts test/app-navigation.test.ts test/dashboard-view-model.test.ts`

Expected: FAIL，因为仪表盘客户端、路由和展示纯函数尚不存在。

- [ ] **Step 3: 实现最小同源边界和可测试的纯函数**

```ts
export function readAppRoute(pathname: string): AppRoute {
  if (pathname === "/" || pathname === "/dashboard") return { kind: "dashboard" };
  if (pathname === "/subscriptions/new") return { kind: "subscription-new" };
  const match = pathname.match(/^\/subscriptions\/([^/]+)$/);
  return match ? { kind: "subscription-detail", subscriptionId: decodeURIComponent(match[1]) } : { kind: "dashboard" };
}

export function trendPointsFor(snapshots: HistorySnapshot[], regionCode: string | null): TrendPoint[] {
  return snapshots
    .filter((snapshot) => (regionCode === null || snapshot.regionCode === regionCode) && snapshot.cnyFen !== null)
    .map(({ capturedAt, cnyFen, regionCode: region }) => ({ capturedAt, cnyFen: cnyFen!, regionCode: region }));
}
```

客户端内部使用一个 `requestJson`，固定 `credentials: "same-origin"`，只读取 Worker 承诺的 JSON 字段。非 2xx 响应转换为 `DashboardApiError(message, status, nextAllowedAt?)`；不得保留 Cookie、请求体、HTML 或外部响应。`queueRefresh()` 只接受 `202` 的排队 DTO，并把 `429` 的冷却时间保留给 UI。格式化函数根据币种决定小数位，人民币分转换为元但不改变原始金额。

- [ ] **Step 4: 运行客户端与现有商品客户端回归测试**

Run: `npm test -- --run test/dashboard-api-client.test.ts test/app-navigation.test.ts test/dashboard-view-model.test.ts test/api-client.test.ts`

Expected: PASS；所有浏览器请求均为同源，纯函数不会在价格缺失时制造趋势点。

- [ ] **Step 5: 提交浏览器数据层**

```bash
git add src/app/dashboard-api-client.ts src/app/app-navigation.ts src/app/dashboard-view-model.ts test/dashboard-api-client.test.ts test/app-navigation.test.ts test/dashboard-view-model.test.ts
git commit -m "feat: add dashboard client and navigation"
```

### Task 4: 实现概览仪表盘、单页详情与安全编辑交互

**Files:**
- Create: `src/app/app-shell.tsx`
- Create: `src/app/dashboard-page.tsx`
- Create: `src/app/subscription-detail-page.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/styles.css`
- Create: `test/dashboard-page-state.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `DashboardApiClient`、`AppRoute`、格式化和趋势函数；Task 1/2 的 DTO。
- Produces: 认证成功后的仪表盘、`/subscriptions/new` 向导和 `/subscriptions/:id` 详情页面；`onUnauthorized()` 继续由认证壳层清除内存状态。

- [ ] **Step 1: 写入页面交互状态的失败测试**

```ts
it("keeps an invalid target draft after a 422 but clears all dashboard state after a 401", () => {
  const editing = applyDetailRequestFailure(initialDetailState, new DashboardApiError("目标价设置无效。", 422));
  expect(editing.targetDraft.globalTargetCnyFen).toBe(5000);
  expect(applyDetailRequestFailure(editing, new DashboardApiError("请先登录。", 401))).toEqual({ kind: "unauthorized" });
});

it("turns a queued refresh response into an honest waiting notice", () => {
  expect(refreshNotice({ status: "queued", requestedAt: "2026-07-17T00:00:00.000Z", nextAllowedAt: "2026-07-17T00:15:00.000Z" }))
    .toContain("已排队");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/dashboard-page-state.test.ts`

Expected: FAIL，因为详情请求失败状态和刷新文案函数尚不存在。

- [ ] **Step 3: 实现页面与交互状态**

```tsx
if (route.kind === "dashboard") {
  return <DashboardPage api={dashboardApi} onNavigate={navigate} onUnauthorized={handleUnauthorized} />;
}
if (route.kind === "subscription-detail") {
  return <SubscriptionDetailPage subscriptionId={route.subscriptionId} api={dashboardApi} onNavigate={navigate} onUnauthorized={handleUnauthorized} />;
}
return <SubscriptionWizardPage onUnauthorized={handleUnauthorized} />;
```

`AppShell` 监听 `popstate` 并通过 `history.pushState` 切换路由；导航的“仪表盘”和“添加订阅”可用，“价格历史”和“设置”显示为即将接入但不可点击的文字入口，不能渲染空白路由。`DashboardPage` 初次加载概览，整张游戏卡以键盘可访问的 `<button>` 进入详情，展示状态统计、五区本币/CNY/来源/过期信息和跨区最低价；空概览只提供添加入口。

`SubscriptionDetailPage` 并行读取详情和历史，显示返回、五区价格卡、地区筛选趋势 SVG、启用开关、已有地区复选框与全局/单区目标价表单。保存三类配置时分别调用既有 PATCH；成功后重新读取详情和概览，422 保留草稿，404 导航到仪表盘，401 调用 `onUnauthorized`，429 显示 API 返回的冷却截止时间。新增地区按钮导航到 `/subscriptions/new` 并说明需要官方确认，不能要求用户填写内部 ID。

所有新增组件、状态转换函数和样式使用中文详细注释；在 `styles.css` 中补齐暖色主题的导航、统计卡、地区价格栅格、趋势 SVG、设置区和窄屏响应式规则。五区宽屏五列，中屏三列，窄屏两列或单列；来源、过期和无价格始终使用文字而非仅颜色。

- [ ] **Step 4: 运行前端状态与现有认证/向导回归测试**

Run: `npm test -- --run test/dashboard-page-state.test.ts test/auth-flow.test.ts test/subscription-wizard.test.ts test/api-dashboard.test.ts`

Expected: PASS；页面状态正确处理 401/422/429，既有认证与官方订阅向导不回归。

- [ ] **Step 5: 本地浏览器验收**

Run: `npm run dev`

在本地已登录管理员会话中验证：仪表盘卡片跳转详情并可用返回键返回；五区当前/最低/来源状态可读；手动刷新显示排队或冷却；暂停、地区范围和目标价保存后重新读取；窄屏布局不遮挡按钮或价格。不得输入真实 Telegram 凭据、调用未获准第三方站点或使用真实生产 D1。

- [ ] **Step 6: 提交仪表盘与订阅详情 UI**

```bash
git add src/app/App.tsx src/app/app-shell.tsx src/app/dashboard-page.tsx src/app/subscription-detail-page.tsx src/app/styles.css test/dashboard-page-state.test.ts
git commit -m "feat: add dashboard and subscription detail UI"
```

### Task 5: 同步文档并执行完整质量门禁

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/system-design.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/superpowers/plans/2026-07-17-dashboard-subscription-detail.md`

**Interfaces:**
- Consumes: Task 1–4 的实际 DTO、路由和 UI 行为。
- Produces: 可审计的实现状态、完整接口契约与验收记录。

- [ ] **Step 1: 写入实现状态与接口文档更新**

将 `GET /api/subscriptions/:id`、扩展后的 `GET /api/dashboard` 和 `POST /api/refresh` 的“排队而非立即抓取”展示规则写入 API 文档；将 FR-007 更新为“已实现”，并明确独立全局历史页、设置页与 CSV 导出仍不在本阶段范围。README 标明本计划已完成，系统架构写入导航、详情和安全地区编辑边界。

- [ ] **Step 2: 标记全部计划复选框完成**

将本计划每个已实际执行并验证的步骤改为 `- [x]`；不得将尚未运行的浏览器验收或测试标为完成。

- [ ] **Step 3: 运行完整质量门禁**

Run: `npm test -- --run && npx tsc --noEmit && npm run build && git diff --check`

Expected: 所有 Vitest 用例通过、TypeScript 无错误、Worker 与前端生产构建完成、差异无空白错误；测试和构建日志不出现密码、恢复码、Telegram 凭据或生产数据。

- [ ] **Step 4: 提交文档与验收记录**

```bash
git add docs/README.md docs/requirements/traceability.md docs/architecture/system-design.md docs/architecture/api-design.md docs/quality/quality-and-acceptance.md docs/superpowers/plans/2026-07-17-dashboard-subscription-detail.md
git commit -m "docs: record dashboard delivery"
```

## 计划自检

- **规格覆盖：**Task 1 提供安全详情 DTO；Task 2 提供概览统计和价格状态；Task 3 固化浏览器同源与路由边界；Task 4 交付方案 A 仪表盘和方案 B 式详情编辑；Task 5 更新正式文档并执行全量验证。
- **类型一致性：**详情读取由 `SubscriptionDetailRepositoryPort.find`、`SubscriptionDetailService.get` 和 `GET /api/subscriptions/:id` 串联；浏览器通过 `DashboardApiClient` 读取/写入并以 `DashboardApiError` 处理受控状态码。
- **安全边界：**地区编辑仅提交 Worker 已确认的 `regionalProductId`，新增未确认地区回到官方确认向导；浏览器不请求外站、不读取 Cookie 或秘密；第三方站点在未获许可时保持无网络请求。
