# 订阅硬删除与全局请求加载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持仪表盘多选永久删除、详情页永久删除后返回首页，并在所有已认证同源 API 请求期间显示全局加载动画。

**Architecture:** Worker 新增一个只接受去重订阅 ID 的批量 `DELETE /api/subscriptions`，在验证所有目标存在后按依赖顺序原子清理订阅专属数据。前端以共享计数式 `ApiRequestTracker` 包装所有已认证 API 客户端，`AppShell` 订阅该计数并渲染统一遮罩；删除入口共用受控确认弹窗，成功后始终重新读取 Worker 模型而非本地拼接。

**Tech Stack:** TypeScript strict、React 19、Vite、Cloudflare Workers、D1、Vitest 4。

## Global Constraints

- 每次代码、测试、SQL、配置或文档改动前完整阅读 `AGENTS.md` 与 `docs/README.md`。
- 所有新增或修改的源代码、测试、SQL 与配置必须保留中文详细注释，特别说明硬删除、认证、并发请求和 D1 原子性的业务或安全原因。
- 测试先行：每一个任务先写失败测试、确认失败，再写最小实现；不访问真实任天堂、Telegram 或任何第三方站点。
- 删除只允许受认证管理员调用；空、重复或不存在的订阅 ID 必须失败，且不得产生部分删除。
- 硬删除只清理目标订阅专属的目标价、地区关联、通知事件、健康状态、快照、采集日志、地区商品和游戏；全局汇率、设置、认证资料及其他订阅绝不受影响。
- 已认证同源 API 客户端都必须经同一请求计数器在 `finally` 结束；加载层不显示请求路径、请求体、Cookie 或错误细节。
- 每次 Git 提交前向用户说明精确范围并获得确认；确认后在同一操作中 `git commit` 和 `git push origin main`。

---

### Task 1: 共享请求计数器与全局加载遮罩

**Files:**
- Create: `src/app/api-request-tracker.ts`
- Create: `test/api-request-tracker.test.ts`
- Create: `src/app/global-request-overlay.tsx`
- Modify: `src/app/app-shell.tsx`
- Modify: `src/app/api-client.ts`
- Modify: `src/app/dashboard-api-client.ts`
- Modify: `src/app/settings-api-client.ts`
- Modify: `src/app/subscription-wizard-page.tsx`
- Modify: `src/app/subscription-detail-page.tsx`
- Modify: `src/app/styles.css`
- Modify: `test/api-client.test.ts`
- Modify: `test/dashboard-api-client.test.ts`
- Modify: `test/settings-api-client.test.ts`

**Interfaces:**
- Produces `ApiRequestTracker` with `begin(): () => void`、`subscribe(listener): () => void`、`getPendingCount(): number`。
- `createProductApiClient`、`createDashboardApiClient` 与 `createSettingsApiClient` 接受可选第二参数 `tracker?: ApiRequestTracker`。
- `AppShell` 创建一个稳定 tracker，并通过 `useSyncExternalStore` 把 `pendingCount > 0` 传给 `GlobalRequestOverlay`；该 tracker 被传入全部已认证页客户端。

- [ ] **Step 1: 写入请求计数器的失败测试**

```ts
it("keeps the overlay active until every concurrent request ends", () => {
  const tracker = createApiRequestTracker();
  const firstDone = tracker.begin();
  const secondDone = tracker.begin();
  expect(tracker.getPendingCount()).toBe(2);
  firstDone();
  expect(tracker.getPendingCount()).toBe(1);
  secondDone();
  expect(tracker.getPendingCount()).toBe(0);
  secondDone();
  expect(tracker.getPendingCount()).toBe(0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/api-request-tracker.test.ts`

Expected: FAIL，因为 `api-request-tracker.ts` 尚不存在。

- [ ] **Step 3: 最小实现请求计数器与客户端 finally 包装**

```ts
export function createApiRequestTracker(): ApiRequestTracker {
  let pendingCount = 0;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    begin() {
      pendingCount += 1; notify(); let finished = false;
      return () => { if (!finished) { finished = true; pendingCount -= 1; notify(); } };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getPendingCount: () => pendingCount,
  };
}

const finish = tracker?.begin();
try { return await request(path, init); } finally { finish?.(); }
```

在每个客户端的底层传输函数中采用上述 `try/finally`，而不是在页面按钮中手工计数。将当前模块级 API 客户端改为 `AppShell` 内用 `useMemo` 创建，并把同一个产品客户端作为 prop 传入向导和详情页；保留认证前客户端不接入遮罩。`GlobalRequestOverlay` 只在可见时渲染 `role="status"`、`aria-live="polite"`、文本“正在同步数据…”，并用 CSS 动画显示圆形 spinner。

- [ ] **Step 4: 扩展客户端失败/成功回归测试**

```ts
it("cleans the request count after a rejected same-origin request", async () => {
  const tracker = createApiRequestTracker();
  const client = createDashboardApiClient(async () => { throw new Error("offline"); }, tracker);
  await expect(client.getDashboard()).rejects.toThrow("offline");
  expect(tracker.getPendingCount()).toBe(0);
});
```

Run: `npm test -- --run test/api-request-tracker.test.ts test/api-client.test.ts test/dashboard-api-client.test.ts test/settings-api-client.test.ts && npx tsc --noEmit`

Expected: PASS；请求成功、异常和并发结束后计数均为零，客户端仍只使用同源 Cookie。

- [ ] **Step 5: 提交 Task 1（等待用户确认）**

拟提交范围：共享请求计数器、全局遮罩、已认证 API 客户端注入与相关测试。

```bash
git add src/app/api-request-tracker.ts src/app/global-request-overlay.tsx src/app/app-shell.tsx src/app/api-client.ts src/app/dashboard-api-client.ts src/app/settings-api-client.ts src/app/subscription-wizard-page.tsx src/app/subscription-detail-page.tsx src/app/styles.css test/api-request-tracker.test.ts test/api-client.test.ts test/dashboard-api-client.test.ts test/settings-api-client.test.ts
git commit -m "feat: show global API loading state"
git push origin main
```

### Task 2: Worker 原子批量硬删除接口

**Files:**
- Modify: `src/worker/repositories/subscription-repository.ts`
- Modify: `src/worker/services/subscription-service.ts`
- Modify: `src/worker/routes/subscription-routes.ts`
- Modify: `test/api-subscriptions.test.ts`

**Interfaces:**
- `SubscriptionRepository.deleteMany(ids: string[]): Promise<void>` 在一个 D1 批次中完成已验证订阅的依赖清理。
- `SubscriptionService.deleteMany(subscriptionIds: string[]): Promise<string[]>` 拒绝任何不存在 ID，并返回删除的原始去重顺序。
- `DELETE /api/subscriptions` 接受 `{ subscriptionIds: string[] }`，成功返回 `{ deletedSubscriptionIds: string[] }`；空/重复输入返回 422，任一不存在返回 404。

- [ ] **Step 1: 写入批量删除的失败 HTTP 测试**

```ts
it("atomically deletes selected subscriptions and their exclusive price data", async () => {
  const cookie = await initializeAndLogin();
  await createSubscription(cookie);
  await seedSubscriptionPriceAndLog();
  const response = await call("/api/subscriptions", { subscriptionIds: ["subscription-overcooked-2"] }, cookie, "DELETE");
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ deletedSubscriptionIds: ["subscription-overcooked-2"] });
  await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM games WHERE id = ?").bind("game-overcooked-2").first()).resolves.toEqual({ count: 0 });
  await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM price_snapshots").first()).resolves.toEqual({ count: 0 });
});

it("does not delete any selected record when one requested subscription is absent", async () => {
  const response = await call("/api/subscriptions", { subscriptionIds: ["subscription-overcooked-2", "missing"] }, cookie, "DELETE");
  expect(response.status).toBe(404);
  await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions").first()).resolves.toEqual({ count: 1 });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/api-subscriptions.test.ts`

Expected: FAIL，因为路由尚未识别 `DELETE /api/subscriptions`。

- [ ] **Step 3: 最小实现受认证删除与依赖清理**

```ts
if (method === "DELETE" && path === "/api/subscriptions") return { kind: "bulk-delete" };

const rows = await this.database.prepare(`SELECT id, game_id AS gameId FROM subscriptions WHERE id IN (${placeholders})`).bind(...ids).all<SubscriptionRow>();
if (rows.results.length !== ids.length) throw new SubscriptionNotFoundError("订阅已不存在。");
await this.database.batch([
  this.database.prepare(`DELETE FROM notification_events WHERE subscription_id IN (${placeholders}) OR regional_product_id IN (SELECT id FROM regional_products WHERE game_id IN (${gamePlaceholders}))`).bind(...ids, ...gameIds),
  this.database.prepare(`DELETE FROM price_snapshots WHERE regional_product_id IN (SELECT id FROM regional_products WHERE game_id IN (${gamePlaceholders}))`).bind(...gameIds),
  this.database.prepare(`DELETE FROM fetch_logs WHERE regional_product_id IN (SELECT id FROM regional_products WHERE game_id IN (${gamePlaceholders}))`).bind(...gameIds),
  this.database.prepare(`DELETE FROM subscriptions WHERE id IN (${placeholders})`).bind(...ids),
  this.database.prepare(`DELETE FROM regional_products WHERE game_id IN (${gamePlaceholders})`).bind(...gameIds),
  this.database.prepare(`DELETE FROM games WHERE id IN (${gamePlaceholders})`).bind(...gameIds),
]);
```

在实际实现中为占位符、输入收窄、目标价/关系/健康表删除分别建立小型私有 helper，避免拼接未经校验的浏览器输入。中文注释必须说明先验证全部 ID 再批量删除的原因、`fetch_logs` 的 `SET NULL` 不能满足硬删除要求，以及游戏一订阅约束为何允许删除游戏及其地区商品。

- [ ] **Step 4: 运行删除路由回归**

Run: `npm test -- --run test/api-subscriptions.test.ts test/api-dashboard.test.ts test/api-subscription-detail.test.ts && npx tsc --noEmit`

Expected: PASS；匿名仍为 401，软停用保持兼容，硬删除只影响明确选中的订阅专属数据。

- [ ] **Step 5: 提交 Task 2（等待用户确认）**

拟提交范围：批量硬删除路由、服务/仓储原子删除与 Worker 回归测试。

```bash
git add src/worker/repositories/subscription-repository.ts src/worker/services/subscription-service.ts src/worker/routes/subscription-routes.ts test/api-subscriptions.test.ts
git commit -m "feat: hard delete subscriptions"
git push origin main
```

### Task 3: 仪表盘多选与确认删除界面

**Files:**
- Create: `src/app/subscription-delete-dialog.tsx`
- Modify: `src/app/dashboard-api-client.ts`
- Modify: `src/app/dashboard-page.tsx`
- Modify: `src/app/styles.css`
- Modify: `test/dashboard-api-client.test.ts`
- Create: `test/dashboard-page.test.tsx`

**Interfaces:**
- `DashboardPageApi.deleteSubscriptions(subscriptionIds: string[]): Promise<{ deletedSubscriptionIds: string[] }>`。
- `SubscriptionDeleteDialog` 接受 `subscriptionCount`、`isDeleting`、`onCancel`、`onConfirm`；仅 `onConfirm` 会发出删除请求。
- 仪表盘卡片外层变为非交互 `article`，复选框与详情跳转按钮为并列控件，避免嵌套 button。

- [ ] **Step 1: 写入仪表盘多选与确认删除失败测试**

```tsx
it("does not navigate when the dashboard selection checkbox is toggled", async () => {
  render(<DashboardPage api={api} onNavigate={onNavigate} onUnauthorized={onUnauthorized} />);
  await user.click(await screen.findByRole("checkbox", { name: "选择 胡闹厨房 2" }));
  expect(onNavigate).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "删除已选（1）" })).toBeEnabled();
});

it("reloads the dashboard only after confirmed permanent deletion", async () => {
  await user.click(screen.getByRole("button", { name: "删除已选（1）" }));
  expect(api.deleteSubscriptions).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "永久删除" }));
  expect(api.deleteSubscriptions).toHaveBeenCalledWith(["subscription-overcooked-2"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/dashboard-page.test.tsx test/dashboard-api-client.test.ts`

Expected: FAIL，因为仪表盘没有选择状态、删除接口或确认弹窗。

- [ ] **Step 3: 最小实现多选、受控确认与重读**

```tsx
const [selectedSubscriptionIds, setSelectedSubscriptionIds] = useState<Set<string>>(new Set());
const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
async function confirmDelete(): Promise<void> {
  await api.deleteSubscriptions([...selectedSubscriptionIds]);
  setSelectedSubscriptionIds(new Set());
  setIsDeleteDialogOpen(false);
  setOverview(await api.getDashboard());
}
```

为每张卡片使用 `article.subscription-summary`、带 `aria-label={\`选择 ${subscription.nameZh}\`}` 的 checkbox 和单独的详情 button。删除工具栏仅在选择非空时出现。确认弹窗使用 `role="dialog" aria-modal="true"`，取消按钮在 DOM 与视觉上优先；删除进行时三个交互均 disabled。错误沿用现有 `DashboardApiError` 的 401/404/其他脱敏文案分支。

- [ ] **Step 4: 运行仪表盘前端回归**

Run: `npm test -- --run test/dashboard-page.test.tsx test/dashboard-api-client.test.ts test/dashboard-view-model.test.ts && npx tsc --noEmit`

Expected: PASS；多选不导航，取消不写入，成功删除只从 Worker 新概览渲染，错误不丢失选择。

- [ ] **Step 5: 提交 Task 3（等待用户确认）**

拟提交范围：删除客户端、仪表盘多选、共享确认弹窗、样式和页面测试。

```bash
git add src/app/subscription-delete-dialog.tsx src/app/dashboard-api-client.ts src/app/dashboard-page.tsx src/app/styles.css test/dashboard-api-client.test.ts test/dashboard-page.test.tsx
git commit -m "feat: delete selected dashboard subscriptions"
git push origin main
```

### Task 4: 详情页删除返回、文档与完整验证

**Files:**
- Modify: `src/app/subscription-detail-page.tsx`
- Modify: `test/dashboard-page.test.tsx`
- Modify: `docs/README.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/system-design.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/superpowers/specs/2026-07-18-subscription-hard-delete-global-loading-design.md`
- Modify: `docs/superpowers/plans/2026-07-18-subscription-hard-delete-global-loading.md`

**Interfaces:**
- 详情页复用 `SubscriptionDeleteDialog` 与 `DetailApi.deleteSubscriptions`。
- 成功删除单个订阅后调用 `onBack()`；父壳的仪表盘重新挂载并读取 Worker 概览。

- [ ] **Step 1: 写入详情页删除后返回的失败测试**

```tsx
it("returns to dashboard after the detail deletion is confirmed", async () => {
  render(<SubscriptionDetailPage api={api} subscriptionId="subscription-overcooked-2" onBack={onBack} onUnauthorized={onUnauthorized} />);
  await user.click(await screen.findByRole("button", { name: "删除订阅" }));
  await user.click(screen.getByRole("button", { name: "永久删除" }));
  expect(api.deleteSubscriptions).toHaveBeenCalledWith(["subscription-overcooked-2"]);
  expect(onBack).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/dashboard-page.test.tsx`

Expected: FAIL，因为详情页未提供删除入口。

- [ ] **Step 3: 最小实现详情页危险操作与文档状态**

```tsx
async function confirmDelete(): Promise<void> {
  try {
    await api.deleteSubscriptions([subscriptionId]);
    setDetail(null); setMissingResolutions([]); setMissingConfirmations({});
    onBack();
  } catch (error) { /* 沿用 401/404/脱敏 notice 处理，弹窗保持可重试 */ }
}
```

把“删除订阅”置于详情管理区末尾并使用危险按钮样式，绝不与暂停/启用混同。完成后更新 API 设计中的 `DELETE /api/subscriptions`、系统设计中的硬删除依赖边界、质量文档中的原子删除/动画验收，以及追踪表状态；计划中勾选已完成步骤。所有修改代码、测试、样式与文档都需补全准确的中文注释。

- [ ] **Step 4: 运行完整质量门禁**

Run: `npm test -- --run && npx tsc --noEmit && npm run build && git diff --check`

Expected: PASS；硬删除、既有软停用、全局请求加载、仪表盘和详情页面回归均通过，构建产物无类型或空白错误。

- [ ] **Step 5: 提交 Task 4（等待用户确认）**

拟提交范围：详情页删除返回、最终文档与全量质量门禁记录。

```bash
git add src/app/subscription-detail-page.tsx test/dashboard-page.test.tsx docs/README.md docs/requirements/traceability.md docs/architecture/system-design.md docs/architecture/api-design.md docs/quality/quality-and-acceptance.md docs/superpowers/specs/2026-07-18-subscription-hard-delete-global-loading-design.md docs/superpowers/plans/2026-07-18-subscription-hard-delete-global-loading.md
git commit -m "feat: complete subscription deletion workflow"
git push origin main
```

## Final Acceptance

1. 仪表盘支持多选，选择控件不触发详情导航；确认后只删除选中订阅。
2. 详情页删除经二次确认成功后回到仪表盘，页面不残留已删除订阅的价格或草稿。
3. 任一不存在 ID、重复 ID 或未认证请求不会产生部分删除；其他订阅和全局数据保持完整。
4. 所有已认证同源 API 请求期间显示计数式全局动画；成功、失败、401、422、429 与并发结束后都正确消失。
5. 全量测试、类型检查、生产构建和空白检查通过；文档准确记录实际实现与验收范围。
