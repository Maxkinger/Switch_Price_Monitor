# 立即手动刷新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已登录管理员的手动刷新在当前请求中完成一次真实官方采集，同时保留十五分钟冷却和独立的六小时 Cron 自动采集。

**Architecture:** `POST /api/refresh` 先通过 D1 单行时间戳进行原子冷却，再注入并等待与 Cron 共用的 `LiveCollectionRunner`。六小时 Cron 只执行保留清理与同一运行器，不再读取任何手动队列状态；浏览器接收本轮统计后重新读取当前页面数据。

**Tech Stack:** TypeScript strict、Cloudflare Workers、Cloudflare D1、React 19、Vite、Vitest 4。

## Global Constraints

- 每次代码、测试、SQL、配置或文档改动前完整阅读 `AGENTS.md` 与 `docs/README.md`。
- 所有新增或修改的源代码、测试、SQL 迁移和配置均须含中文详细注释，并在提交前检查注释与实现一致性。
- 必须测试先行：先写失败测试、运行确认失败，再实现最小代码并运行相关回归。
- `POST /api/refresh` 只接受管理员同源会话；浏览器不读取、保存或转发 Cookie、供应商响应、Telegram 凭据或 D1 细节。
- 手动请求只在通过服务器时间计算的十五分钟冷却后执行；冷却内返回 `429 REFRESH_COOLDOWN` 与 `nextAllowedAt`。
- 手动与六小时路径必须复用 `LiveCollectionRunner`，不得各自实现官方来源、汇率、快照、健康状态或即时事件规则。
- `0006` 迁移重建旧的单行刷新表且不复制 `queued/running` 记录；这是有意取消旧语义下尚未执行的请求，不影响订阅、价格、认证或设置数据。
- Telegram 与第三方价格站保持未配置、未接入；生产验证不输入或记录任何秘密。
- 每次创建 Git 提交前，先向用户说明精确范围并取得确认；确认后同一操作完成 `git commit` 与 `git push origin main`。

---

## 文件结构

- `migrations/0006_immediate_manual_refresh.sql`：把旧队列表迁移为只保存最近执行时间的单行冷却表。
- `test/apply-migrations.ts`：以生产编号顺序加载 `0006`，保证测试 D1 与远程迁移一致。
- `src/worker/repositories/manual-refresh-repository.ts`：仅负责原子冷却时间戳写入和下一次可执行时间计算。
- `src/worker/services/manual-refresh-service.ts`：在冷却通过后调用可注入的即时采集运行器并返回受控统计。
- `src/worker/routes/manual-refresh-routes.ts`：会话守卫、服务编排和安全 JSON 响应边界。
- `src/worker/index.ts`：构造一次可复用的 `LiveCollectionRunner`，分别注入手动路由和六小时 Cron。
- `src/worker/services/scheduler-service.ts`：六小时路径只保留清理和一次完整采集，不再认领手动队列。
- `src/app/dashboard-api-client.ts`：把刷新 DTO 从 `queued` 改为已完成统计。
- `src/app/dashboard-page-state.ts`、`src/app/dashboard-page.tsx`、`src/app/subscription-detail-page.tsx`：显示本轮结果并重新读取当前页。
- `test/manual-refresh-repository.test.ts`、`test/api-refresh.test.ts`、`test/six-hour-collection.test.ts`、`test/dashboard-api-client.test.ts`、`test/dashboard-page-state.test.ts`：覆盖冷却、立即运行、Cron 独立性和客户端文案。
- `docs/README.md`、`docs/requirements/traceability.md`、`docs/architecture/api-design.md`、`docs/quality/quality-and-acceptance.md`：记录实施完成和生产验收边界。

### Task 1: 单行冷却迁移与仓储

**Files:**
- Create: `migrations/0006_immediate_manual_refresh.sql`
- Modify: `test/apply-migrations.ts`
- Modify: `src/worker/repositories/manual-refresh-repository.ts`
- Modify: `src/worker/services/scheduler-service.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/manual-refresh-repository.test.ts`
- Modify: `test/six-hour-collection.test.ts`

**Interfaces:**
- Produces `ManualRefreshRepository.request(now): Promise<ManualRefreshRequestResult>`，其中 `accepted`、`requestedAt`、`nextAllowedAt` 均由 D1/服务端时间决定。
- Removes `ManualRefreshRepository.claimQueued()` 与所有 `queued/running` 类型和列假设；六小时 Cron 同一任务移除对该 API 的依赖，确保迁移后类型检查和定时采集均可运行。

- [x] **Step 1: 写入失败测试**

将 `test/manual-refresh-repository.test.ts` 改成冷却行为测试：

```ts
it("accepts one timestamp and rejects a concurrent request until the fifteen-minute cutoff", async () => {
  const first = new ManualRefreshRepository(env.DB);
  const second = new ManualRefreshRepository(env.DB);
  const [firstResult, secondResult] = await Promise.all([
    first.request("2026-07-16T01:00:00.000Z"),
    second.request("2026-07-16T01:00:00.000Z"),
  ]);

  expect([firstResult, secondResult].filter((result) => result.accepted)).toHaveLength(1);
  expect(await env.DB.prepare("SELECT requested_at AS requestedAt FROM manual_refresh_requests WHERE id = 1").first())
    .toEqual({ requestedAt: "2026-07-16T01:00:00.000Z" });
  await expect(first.request("2026-07-16T01:10:00.000Z")).resolves.toMatchObject({
    accepted: false,
    nextAllowedAt: "2026-07-16T01:15:00.000Z",
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/manual-refresh-repository.test.ts`

Expected: FAIL，因为旧仓储仍写入 `status`、暴露 `claimQueued`，而 `0006` 尚未创建仅含时间戳的表结构。

- [x] **Step 3: 实现迁移和最小仓储**

创建迁移：

```sql
-- 旧表的 queued/running 只表示等待 Cron；立即刷新改为同步执行，因此有意丢弃未消费请求，避免迁移后产生错误的“已执行”认知。
DROP TABLE IF EXISTS manual_refresh_requests;

-- 单行记录只用于跨标签页和跨 Worker 实例的十五分钟冷却；不保存管理员、商品、会话或采集响应。
CREATE TABLE manual_refresh_requests (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  requested_at TEXT NOT NULL
);
```

在 `test/apply-migrations.ts` 导入并追加 `immediateManualRefreshSchema`，确保测试库也在 `0005` 后执行 `0006`。将仓储 UPSERT 改为：

```ts
const result = await this.database.prepare(
  `INSERT INTO manual_refresh_requests (id, requested_at)
   VALUES (1, ?)
   ON CONFLICT(id) DO UPDATE SET requested_at = excluded.requested_at
   WHERE manual_refresh_requests.requested_at <= ?`,
).bind(now, cutoff).run();
```

删除 `claimQueued()`、状态行模型及描述队列认领的注释；保留 `request()` 返回真实 `nextAllowedAt` 的安全行为。同步在 `scheduler-service.ts` 移除 `ManualRefreshClaimReader`、`manualRefresh` 依赖和 `manualRefreshConsumed` 字段；在 `index.ts` 的六小时依赖对象中移除 `manualRefresh: new ManualRefreshRepository(env.DB)`。

将 `test/six-hour-collection.test.ts` 改为不传入手动刷新端口的独立 Cron 测试：

```ts
await expect(runSixHourCollection("2026-07-17T00:00:00.000Z", {
  settings: { get: async () => ({ priceHistoryRetention: "forever" as const }) },
  retention,
  collection,
})).resolves.toEqual({ kind: "collection-completed" });
expect(collection.run).toHaveBeenCalledExactlyOnceWith("2026-07-17T00:00:00.000Z");
```

- [x] **Step 4: 运行仓储与迁移回归**

Run: `npm test -- --run test/manual-refresh-repository.test.ts test/api-refresh.test.ts test/six-hour-collection.test.ts && npx tsc --noEmit`

Expected: PASS；测试 D1 含 `0006` 后的新表结构，冷却原子且不含状态队列 API。

- [ ] **Step 5: 等待用户确认后提交并推送 Task 1**

拟提交范围：`0006` 迁移、迁移测试装配、刷新仓储、六小时 Cron 解耦及相关测试。确认后执行：

```bash
git add migrations/0006_immediate_manual_refresh.sql test/apply-migrations.ts src/worker/repositories/manual-refresh-repository.ts src/worker/services/scheduler-service.ts src/worker/index.ts test/manual-refresh-repository.test.ts test/six-hour-collection.test.ts
git commit -m "feat: simplify manual refresh cooldown"
git push origin main
```

### Task 2: 立即采集服务、路由与六小时 Cron 解耦

**Files:**
- Modify: `src/worker/services/manual-refresh-service.ts`
- Modify: `src/worker/routes/manual-refresh-routes.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/api-refresh.test.ts`

**Interfaces:**
- Produces `ImmediateRefreshRunner`：`run(now: string): Promise<{ attempted: number; collected: number; stale: number }>`。
- Produces `ManualRefreshService.refresh(now): Promise<{ executedAt: string; attempted: number; collected: number; stale: number }>`。
- `handleManualRefreshRoute(request, database, runner)` consumes the runner and returns `200` after a completed collection or existing safe error response.

- [x] **Step 1: 写入失败测试**

将 API 路由测试改为注入运行器，并断言实际执行而非返回 `202`：

```ts
it("runs one collection immediately after accepting the administrator cooldown slot", async () => {
  const collection = { run: vi.fn().mockResolvedValue({ attempted: 2, collected: 1, stale: 1 }) };
  const cookie = await initializeAndLogin();

  const response = await handleManualRefreshRoute(request("/api/refresh", cookie), env.DB, collection);

  expect(response?.status).toBe(200);
  await expect(response?.json()).resolves.toEqual({
    status: "completed",
    executedAt: expect.any(String),
    attempted: 2,
    collected: 1,
    stale: 1,
  });
  expect(collection.run).toHaveBeenCalledExactlyOnceWith(expect.any(String));
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/api-refresh.test.ts test/six-hour-collection.test.ts`

Expected: FAIL，因为路由仍返回 `202 queued`，尚未接收并等待即时采集运行器。

- [x] **Step 3: 实现即时服务和受控路由**

在 `manual-refresh-service.ts` 定义窄运行器端口，并在冷却成功后等待同一实例：

```ts
export interface ImmediateRefreshRunner {
  run(now: string): Promise<{ attempted: number; collected: number; stale: number }>;
}

public async refresh(now: string): Promise<ManualRefreshExecutionResult> {
  const request = await this.requests.request(now);
  if (!request.accepted) throw new ManualRefreshCooldownError(request.nextAllowedAt);
  return { executedAt: now, ...(await this.runner.run(now)) };
}
```

路由在通过 `requireAdmin` 后调用 `refresh(new Date().toISOString())`，返回：

```ts
return Response.json({ status: "completed", ...result });
```

异常仍只返回既有安全中文摘要；不得把供应商 URL、D1 错误、外部响应或 Telegram 信息放入 HTTP JSON。

在 `index.ts` 提取 `createLiveCollectionRunner(env)`，其中保留当前的 `CollectionRepository`、汇率服务、官方提供方注册表、`CollectionService`、健康服务和通知事件接线。`fetch` 路由与六小时 `scheduled` 都调用此工厂，保证路径复用而不共享浏览器状态。

- [x] **Step 4: 运行后端回归**

Run: `npm test -- --run test/api-refresh.test.ts test/worker-maintenance.test.ts test/live-collection-runner.test.ts && npx tsc --noEmit`

Expected: PASS；立即请求只执行一次，复用既有采集规则且不会在路由层展开来源、汇率或通知细节。

- [ ] **Step 5: 等待用户确认后提交并推送 Task 2**

拟提交范围：立即刷新服务/路由、Worker 运行器装配及相关后端测试。确认后执行：

```bash
git add src/worker/services/manual-refresh-service.ts src/worker/routes/manual-refresh-routes.ts src/worker/index.ts test/api-refresh.test.ts
git commit -m "feat: run manual refresh immediately"
git push origin main
```

### Task 3: 浏览器结果展示、文档和生产验收

**Files:**
- Modify: `src/app/dashboard-api-client.ts`
- Modify: `src/app/dashboard-page-state.ts`
- Modify: `src/app/dashboard-page.tsx`
- Modify: `src/app/subscription-detail-page.tsx`
- Modify: `test/dashboard-api-client.test.ts`
- Modify: `test/dashboard-page-state.test.ts`
- Modify: `docs/README.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/superpowers/plans/2026-07-17-immediate-manual-refresh.md`

**Interfaces:**
- Produces `CompletedRefreshResult`：`{ status: "completed"; executedAt: string; attempted: number; collected: number; stale: number }`。
- `createDashboardApiClient().refreshNow()` returns `CompletedRefreshResult` with same-origin credentials.
- Produces `immediateRefreshNotice(result)`，返回 `已完成本次采集：成功 X 个地区，待确认 Y 个地区。`。

- [ ] **Step 1: 写入失败测试**

替换旧排队文案测试并补充客户端读取：

```ts
it("turns a completed manual refresh into a result notice", () => {
  expect(immediateRefreshNotice({
    status: "completed", executedAt: "2026-07-17T01:00:00.000Z", attempted: 5, collected: 3, stale: 2,
  })).toBe("已完成本次采集：成功 3 个地区，待确认 2 个地区。");
});

it("reads an immediate refresh result with same-origin credentials", async () => {
  const request = vi.fn(async () => Response.json({ status: "completed", executedAt: "2026-07-17T01:00:00.000Z", attempted: 1, collected: 1, stale: 0 })) as unknown as typeof fetch;
  await expect(createDashboardApiClient(request).refreshNow()).resolves.toMatchObject({ status: "completed", collected: 1 });
  expect(request).toHaveBeenCalledWith("/api/refresh", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/dashboard-api-client.test.ts test/dashboard-page-state.test.ts`

Expected: FAIL，因为客户端和状态模块仍使用 `queueRefresh`、`queued` DTO 与等待 Cron 文案。

- [ ] **Step 3: 实现浏览器完成反馈与重读**

在客户端定义并返回 `CompletedRefreshResult`：

```ts
export interface CompletedRefreshResult {
  status: "completed";
  executedAt: string;
  attempted: number;
  collected: number;
  stale: number;
}

async refreshNow(): Promise<CompletedRefreshResult> {
  return requestJson<CompletedRefreshResult>("/api/refresh", "POST");
}
```

用 `immediateRefreshNotice` 替代 `refreshWaitingNotice`。仪表盘的刷新动作先等待 `refreshNow()`，再调用 `getDashboard()` 回填概览并显示结果；订阅详情的刷新动作先等待 `refreshNow()`，再调用既有 `reload()`。两处保留 `401` 安全回退和 `429` 的 Worker 文案，不从前端猜测冷却时间。

- [ ] **Step 4: 运行前端与全量质量门禁**

Run: `npm test -- --run && npx tsc --noEmit && npm run build && ! rg -n "等待采集任务执行|claimQueued|manualRefreshConsumed" src test && git diff --check`

Expected: 全部测试、类型检查和构建通过；当前生产代码、测试断言和页面文案不再依赖等待采集或 Cron 认领语义。历史 `0004` 迁移与设计文档中的迁移说明不属于此检查范围。

- [ ] **Step 5: 生产迁移、部署与受控验收**

在用户明确允许后依次运行：

```bash
npx wrangler d1 migrations apply switch-price-monitor --remote
npm run deploy
curl --fail --silent --show-error https://switch-price-monitor.cchccp.workers.dev/api/auth/status
```

然后在已登录浏览器点击一次“立即刷新”。Expected: 当前请求完成并显示本轮统计；远程 D1 的 `price_snapshots`/`fetch_logs` 按真实官方结果变化，`manual_refresh_requests` 只保存冷却时间，六小时 Cron 不依赖该表。不得在浏览器、终端输出、Git 或文档中暴露 Telegram、密码、恢复码或 Cookie。

- [ ] **Step 6: 同步实施状态与等待用户确认后提交并推送 Task 3**

更新文档索引、FR-003、API 描述、质量验收记录和本计划复选框；拟提交范围为前端刷新结果、前端测试、实施文档及本计划。确认后执行：

```bash
git add src/app/dashboard-api-client.ts src/app/dashboard-page-state.ts src/app/dashboard-page.tsx src/app/subscription-detail-page.tsx test/dashboard-api-client.test.ts test/dashboard-page-state.test.ts docs/README.md docs/requirements/traceability.md docs/architecture/api-design.md docs/quality/quality-and-acceptance.md docs/superpowers/plans/2026-07-17-immediate-manual-refresh.md
git commit -m "feat: show immediate refresh results"
git push origin main
```

## 计划自检

- **规格覆盖：**Task 1 覆盖旧队列迁移取消与原子冷却；Task 2 覆盖同步采集、复用运行器、认证/错误边界与六小时 Cron 独立；Task 3 覆盖浏览器反馈、回读、全量质量门禁和生产受控验证。
- **无占位检查：**每个任务列出确定文件、接口、失败测试、通过命令、部署命令和提交范围；不引入 Telegram、第三方来源或新的队列基础设施。
- **类型一致性：**Task 2 产出的 `attempted`、`collected`、`stale` 与 Task 3 的 `CompletedRefreshResult` 字段完全一致；Task 1 删除的 `claimQueued` 不在 Task 2 以后出现。
