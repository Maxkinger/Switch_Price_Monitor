# Target Price Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从应用、数据库和运行文档中彻底删除目标价能力及其历史数据，同时保留普通官方降价和健康通知。

**Architecture:** 保留不可变的 `0001_initial.sql`，新增 `0002_remove_target_price.sql` 删除目标价事件、地区目标表与全局目标列。Node 订阅、通知、仓储与 React 客户端收窄到不含目标价的 DTO。

**Tech Stack:** Node.js 22、TypeScript、Hono、React、Vitest、PostgreSQL 17、Docker Compose。

## Global Constraints

- 不改写 `migrations/postgres/0001_initial.sql`；迁移账本校验依赖其精确字节。
- `0002` 永久删除目标价配置和 `target-price` 通知历史，不触碰普通降价、失败/恢复、订阅、价格、设置或认证数据。
- 旧目标价 PATCH 必须返回普通 `422`，不保留兼容入口。
- 所有修改的代码、测试、SQL 与配置均需准确中文详细注释和测试先行证据。
- 活跃 PRD、API、数据模型、追踪、备份文档必须更新；历史验收记录保留其历史文字。

---

### Task 1: 数据库迁移与备份合同

**Files:**
- Create: `migrations/postgres/0002_remove_target_price.sql`
- Modify: `test/postgres-migrations.test.ts`
- Modify: `test/postgres-backup-restore.test.mjs`

**Interfaces:**
- Consumes: `runMigrations(database, POSTGRES_MIGRATION_DIRECTORY)` 的字典序与 SHA-256 账本。
- Produces: 不含 `subscription_region_targets` 和 `subscriptions.global_target_cny_fen` 的 15 张表结构。

- [x] **Step 1: 写入失败的迁移回归**

在已执行 `0001` 的夹具写入目标金额、目标表行、`target-price` 与 `official-price-drop` 通知；执行全部迁移后断言仅目标价数据消失。

```ts
await database.query("INSERT INTO subscriptions (id, game_id, global_target_cny_fen) VALUES ('target-subscription', 'game-a', 5000)");
await database.query("INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor) VALUES ('target-subscription', 'US', 1500)");
await database.query("INSERT INTO notification_events (event_type, status, dedupe_key, created_at) VALUES ('target-price', 'pending', 'target-event', CURRENT_TIMESTAMP), ('official-price-drop', 'pending', 'drop-event', CURRENT_TIMESTAMP)");
expect(await hasTable(database, "subscription_region_targets")).toBe(false);
expect(await hasColumn(database, "subscriptions", "global_target_cny_fen")).toBe(false);
```

- [x] **Step 2: 运行红灯**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run test/postgres-migrations.test.ts`

Expected: FAIL，因为 `0002_remove_target_price.sql` 尚不存在。

- [x] **Step 3: 新增最小不可逆迁移并更新表集合**

```sql
-- 目标价产品能力已永久删除；仅清理该事件类型，不能影响官方降价或健康通知。
DELETE FROM notification_events WHERE event_type = 'target-price';
DROP TABLE subscription_region_targets;
ALTER TABLE subscriptions DROP COLUMN global_target_cny_fen;
```

将备份恢复的精确表数量和夹具更新为 15 张，不再写目标列、目标表或目标事件。

- [x] **Step 4: 运行绿灯**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run test/postgres-migrations.test.ts test/postgres-backup-restore.test.mjs`

Expected: PASS；迁移账本含 `0002`，普通降价事件仍在。

### Task 2: 订阅后端、API 与仓储收窄

**Files:**
- Modify: `src/repositories/ports.ts`
- Modify: `src/repositories/postgres/subscription-repository.ts`
- Modify: `src/repositories/postgres/subscription-detail-repository.ts`
- Modify: `src/services/subscription-service.ts`
- Modify: `src/routes/subscription-routes.ts`
- Modify: `test/api-subscriptions.test.ts`
- Modify: `test/api-subscription-detail.test.ts`
- Modify: `test/postgres-subscription-read.test.ts`
- Modify: `test/postgres-subscription-write.test.ts`
- Modify: `test/subscription-region-completion.test.ts`
- Modify: `test/support/api-postgres.ts`
- Modify: `test/support/in-memory-business-stores.ts`

**Interfaces:**
- Consumes: Task 1 后无目标结构的数据库。
- Produces: `SubscriptionDetail` 不含 `globalTargetCnyFen`/`regionTargets`；更新载荷仅支持 `enabled` 与 `regionalProductIds`。

- [x] **Step 1: 写入失败的 API 断言**

```ts
const response = await call("/api/subscriptions/subscription-overcooked-2", { globalTargetCnyFen: 5000, regionTargets: [{ regionCode: "JP", targetAmountMinor: 800 }] }, cookie, "PATCH");
expect(response.status).toBe(422);
expect(await response.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
expect(JSON.stringify(await detail.json())).not.toContain("globalTargetCnyFen");
```

- [x] **Step 2: 运行红灯**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run test/api-subscriptions.test.ts test/api-subscription-detail.test.ts test/postgres-subscription-read.test.ts test/postgres-subscription-write.test.ts`

Expected: FAIL，因为 API、服务与 SQL 仍接受或读取目标价。

- [x] **Step 3: 删除所有目标价端口、服务与 SQL**

删除 `setTargets`、目标 DTO 字段、`TargetRow`、目标表读写和 `readSubscriptionUpdate` 的 `targets` 分支。最终联合类型为：

```ts
type SubscriptionUpdate = { kind: "enabled"; enabled: boolean } | { kind: "regions"; regionalProductIds: string[] };
```

目标字段走 `SubscriptionRequestError("订阅更新无效。")` 的 `422`，不得静默忽略。

- [x] **Step 4: 运行绿灯**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run test/api-subscriptions.test.ts test/api-subscription-detail.test.ts test/postgres-subscription-read.test.ts test/postgres-subscription-write.test.ts test/subscription-region-completion.test.ts`

Expected: PASS；详情和订阅写入不再引用已删除结构。

### Task 3: 价格规则与通知删除

**Files:**
- Modify: `src/services/price-rules.ts`
- Modify: `src/services/scheduler-service.ts`
- Modify: `src/repositories/ports.ts`
- Modify: `test/price-rules.test.ts`
- Modify: `test/postgres-health-notification.test.ts`

**Interfaces:**
- Consumes: `evaluateOfficialDrop`、健康状态转换和通知事件端口。
- Produces: 事件类型只允许 `collection-failure`、`collection-recovered`、`official-price-drop`。

- [x] **Step 1: 写入失败的通知类型回归**

```ts
const event: NotificationEventReservation = { regionalProductId: "product-us", eventType: "official-price-drop", dedupeKey: "drop:product-us:1", createdAt: "2026-08-10T00:00:00.000Z" };
await expect(repository.reserve(event)).resolves.toBe(true);
```

删除 `evaluateTarget` 断言和 `target-price` 夹具，保留普通降价、失败和恢复断言。

- [x] **Step 2: 运行红灯**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run test/price-rules.test.ts test/postgres-health-notification.test.ts`

Expected: FAIL，因为目标状态机和通知联合成员仍存在。

- [x] **Step 3: 删除目标状态机和消息分支**

删除 `TargetState`、`TargetTransition`、`evaluateTarget`、`target-price` 事件联合成员和 Telegram 模板；不得把目标事件映射成普通降价。

- [x] **Step 4: 运行绿灯**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run test/price-rules.test.ts test/postgres-health-notification.test.ts`

Expected: PASS；普通官方降价与健康通知行为不变。

### Task 4: React UI 与客户端模型删除

**Files:**
- Modify: `src/app/dashboard-api-client.ts`
- Modify: `src/app/dashboard-page-state.ts`
- Modify: `src/app/subscription-detail-page.tsx`
- Modify: `test/dashboard-page-state.test.ts`
- Modify: `test/dashboard-page.test.tsx`
- Modify: `test/subscription-detail-page.test.tsx`

**Interfaces:**
- Consumes: Task 2 的无目标价详情 API 与更新联合。
- Produces: 详情页只管理启停、地区、地区补全和删除。

- [x] **Step 1: 写入失败的 DOM 断言**

```tsx
expect(screen.queryByText("目标价（最小货币单位）")).toBeNull();
expect(screen.queryByRole("button", { name: "保存目标价" })).toBeNull();
```

- [x] **Step 2: 运行红灯**

Run: `npm run test:dom -- test/subscription-detail-page.test.tsx test/dashboard-page.test.tsx`

Expected: FAIL，因为详情页仍渲染目标价 fieldset。

- [x] **Step 3: 删除详情页状态、类型和表单**

删除 `DetailTargetDraft`、`targetDraft`、客户端 DTO 字段，以及目标价加载、编辑和保存操作。保留删除确认、地区选择与 API 失败提示，并修正中文注释。

- [x] **Step 4: 运行绿灯**

Run: `npm run test:dom`

Expected: PASS；详情页可编辑地区、停用和删除，且没有目标价控件。

### Task 5: 活跃文档、合同和最终验证

**Files:**
- Modify: `src/shared/domain.ts`
- Modify: `docs/requirements/PRD.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/architecture/data-model.md`
- Modify: `docs/deployment/postgres-backup-restore.md`
- Modify: `docs/quality/quality-and-acceptance.md`（仅当前门禁表）
- Modify: 全部受前四项编译影响的测试和中文注释

**Interfaces:**
- Consumes: Task 1-4 的最终数据库、API、通知和 UI 边界。
- Produces: 活跃文档不再把目标价列为功能、字段、表或通知类型。

- [x] **Step 1: 更新当前合同**

移除领域快照注释的“目标价判定”，将 FR-004 和追踪表收窄为官方降价提醒，删除数据模型目标字段/表说明，更新 API PATCH 描述和备份 15 表集合；不改写历史质量章节。

- [x] **Step 2: 执行最终验证**

Run: `npx tsc --noEmit && TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run && npm run test:dom && npm run test:docker-config && npm run test:github-actions && npm run test:workflow-comments && npm run build && git diff --check`

Expected: 全部通过；扫描 `src`、`test`、`migrations/postgres` 与活跃需求/架构/部署文档后，只允许 `0001_initial.sql` 和历史质量记录出现目标价历史文字。

- [ ] **Step 3: 提交（仅在获得用户明确确认后）**

Run: `git add migrations/postgres/0002_remove_target_price.sql src test docs && git commit -m "feat: remove target price support" && git push origin main`

提交前逐项排除用户既有的 `package.json`、`package-lock.json` 和无关设计文档修改；提交和推送必须在同一操作完成。
