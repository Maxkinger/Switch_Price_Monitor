# Temporary Manual Refresh No Cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 临时取消已认证管理员手动刷新的 15 分钟冷却，同时保留单行最近刷新时间并不影响六小时 Cron。

**Architecture:** `ManualRefreshRepository` 改为无条件 UPSERT 最近请求时间并始终返回接受状态，路由因此每次都同步调用既有采集器。数据库 schema、认证、价格采集器和定时任务保持不变；恢复冷却时将以新确认的变更恢复条件 UPSERT 与 429 分支。

**Tech Stack:** TypeScript、Cloudflare Workers、D1、Vitest。

## Global Constraints

- 所有新增或修改的源代码、测试和文档必须使用与实现一致的中文详细注释，说明临时无冷却的业务边界、数据保留与认证原因。
- 测试先行：先运行失败测试，再实现最小代码并运行相关测试。
- `POST /api/refresh` 仍必须使用现有管理员认证；不得新增公开刷新端点、Cookie、密钥或外部请求。
- 不新增 D1 迁移；`manual_refresh_requests` 仍只保存一行 `requested_at`。
- 不得改动六小时 Cron、价格快照、汇率、订阅、通知或第三方来源逻辑。
- 提交前通过完整 Worker、页面、类型、生产构建与注释一致性检查；提交和推送须在管理员再次确认后同一操作完成。

---

### Task 1: 无冷却的最近刷新时间写入

**Files:**
- Modify: `test/manual-refresh-repository.test.ts`
- Modify: `src/worker/repositories/manual-refresh-repository.ts`

**Interfaces:**
- Consumes: `ManualRefreshRepository.request(now: string)`。
- Produces: 每次调用均返回 `ManualRefreshRequestResult`，其中 `accepted === true`、`requestedAt === nextAllowedAt === now`。

- [x] **Step 1: 写入失败测试**

将原“拒绝十五分钟内第二次请求”测试改为连续时间戳均接受：

```ts
it("accepts consecutive requests and keeps only the latest timestamp while cooldown is temporarily disabled", async () => {
  const repository = new ManualRefreshRepository(env.DB);
  await expect(repository.request("2026-07-16T01:00:00.000Z")).resolves.toMatchObject({
    accepted: true, requestedAt: "2026-07-16T01:00:00.000Z", nextAllowedAt: "2026-07-16T01:00:00.000Z",
  });
  await expect(repository.request("2026-07-16T01:01:00.000Z")).resolves.toMatchObject({
    accepted: true, requestedAt: "2026-07-16T01:01:00.000Z", nextAllowedAt: "2026-07-16T01:01:00.000Z",
  });
  await expect(env.DB.prepare("SELECT requested_at AS requestedAt FROM manual_refresh_requests WHERE id = 1").first())
    .resolves.toEqual({ requestedAt: "2026-07-16T01:01:00.000Z" });
});
```

- [x] **Step 2: 运行失败测试**

Run: `npm test -- --run test/manual-refresh-repository.test.ts`

Expected: FAIL，因为当前条件 UPSERT 仍拒绝第二次调用。

- [x] **Step 3: 写入最小实现**

将仓储 SQL 改为无条件时间戳 UPSERT，并将接口结果固定为本次请求时间：

```ts
await this.database.prepare(
  `INSERT INTO manual_refresh_requests (id, requested_at)
   VALUES (1, ?)
   ON CONFLICT(id) DO UPDATE SET requested_at = excluded.requested_at`,
).bind(now).run();
return { accepted: true, requestedAt: now, nextAllowedAt: now };
```

移除不再可达的冷却读取分支与 15 分钟常量；新增中文注释必须说明这是临时验证策略、记录仍不包含个人数据、并发请求均可进入采集是明确业务后果。

- [x] **Step 4: 运行相关测试**

Run: `npm test -- --run test/manual-refresh-repository.test.ts`

Expected: PASS，连续请求均接受且表内只有最新时间。

### Task 2: 手动刷新路由连续执行回归

**Files:**
- Modify: `test/api-refresh.test.ts`

**Interfaces:**
- Consumes: 已认证 `POST /api/refresh`、`handleManualRefreshRoute` 与采集器替身。
- Produces: 连续两次响应均为 `200 completed`，采集器被调用两次；失败请求仍为安全 500。

- [x] **Step 1: 写入失败测试**

将原 429 断言替换为第二次完成断言：

```ts
vi.setSystemTime(new Date("2026-07-16T01:10:00.000Z"));
const repeated = await call(cookie, runner);
expect(repeated.status).toBe(200);
await expect(repeated.json()).resolves.toMatchObject({ status: "completed", executedAt: "2026-07-16T01:10:00.000Z" });
expect(runner.run).toHaveBeenNthCalledWith(2, "2026-07-16T01:10:00.000Z");
```

- [x] **Step 2: 运行失败测试**

Run: `npm test -- --run test/api-refresh.test.ts`

Expected: FAIL，因为当前仓储返回 `accepted: false`，路由仍返回 429。

- [x] **Step 3: 验证最小实现已满足路由**

不修改路由生产代码。Task 1 的仓储始终返回 `accepted: true` 后，既有路由会复用已认证同步采集分支；仅更新过期测试中文注释，使其不再声称服务端有冷却。

- [x] **Step 4: 运行相关测试**

Run: `npm test -- --run test/api-refresh.test.ts`

Expected: PASS，连续两次均同步采集，异常仍仅返回安全错误。

### Task 3: 文档状态与完整质量门禁

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/requirements/PRD.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/system-design.md`
- Modify: `docs/superpowers/specs/2026-07-18-temporary-manual-refresh-no-cooldown-design.md`
- Modify: `docs/superpowers/plans/2026-07-18-temporary-manual-refresh-no-cooldown.md`

**Interfaces:**
- Consumes: Task 1–2 的无冷却仓储与路由行为。
- Produces: 与实际临时策略一致的需求、架构、追踪和文档索引状态。

- [x] **Step 1: 更新已实施状态**

将规格和目录标记为“已实现，待生产香港验证”，追踪表记录“无冷却连续刷新已实现”；保留“恢复 15 分钟冷却必须另行确认”的明确边界。

- [x] **Step 2: 运行完整质量门禁**

Run: `npm test -- --run`

Expected: 全部 Worker 测试 PASS。

Run: `npm run test:dom -- --run`

Expected: 全部页面测试 PASS。

Run: `npx tsc --noEmit && npm run build && git diff --check`

Expected: TypeScript、生产构建与补丁空白检查 PASS。

- [x] **Step 3: 审查注释与变更范围**

Run: `git diff -- src/worker/repositories/manual-refresh-repository.ts test/manual-refresh-repository.test.ts test/api-refresh.test.ts docs`

Expected: 注释准确说明临时无冷却、认证仍有效、仅保存最近时间、并发后果和恢复边界；没有密钥、Cookie、个人数据或不相关变更。

## 自检

- 规格覆盖：Task 1 覆盖单行时间与连续接受；Task 2 覆盖认证路由连续执行和安全失败；Task 3 覆盖文档、质量门禁与注释一致性。
- 无占位符：测试、SQL、接口、命令和预期结果均已列明。
- 类型一致性：复用既有 `ManualRefreshRequestResult`、`ManualRefreshRepository.request` 与 `handleManualRefreshRoute`，不变更数据库 schema 或 HTTP 响应成功结构。
