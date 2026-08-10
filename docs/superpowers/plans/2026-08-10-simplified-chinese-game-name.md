# Simplified Chinese Game Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让仪表盘和订阅详情始终显示已确认的简体中文常用游戏名，并提供词条复用、存量回填和管理员更正流程。

**Architecture:** PostgreSQL 保存可复用的已确认名称词条及单游戏人工覆盖；服务端依据既有 `normalized_name`、发行商和商品类型决议展示名。仪表盘、详情和新订阅确认都消费服务端决议结果，浏览器不再以正则或机器翻译决定游戏名。

**Tech Stack:** Node.js 22、TypeScript、PostgreSQL 17、React、Vitest、Vite。

## Global Constraints

- 所有新增或修改的源代码、测试、SQL 迁移和配置均须有与实现一致的中文详细注释。
- 采用测试先行：先运行新增测试确认失败，再写最小实现并运行相关测试。
- 不修改已应用迁移文件；新增迁移按字典序执行，且不得修改价格、地区映射、快照、汇率、通知或认证数据。
- 正式名称只来自人工确认的项目词库或管理员人工覆盖；不得在运行时调用 AI、翻译服务或抓取网页。
- 名称匹配必须同时使用 `normalized_name`、发行商和商品类型；中文显示名不得参与官方身份、URL 或价格 ID 的计算。
- 新订阅没有已确认词条或管理员提交的非空简体名称时必须被拒绝；存量未回填项在仪表盘/详情显示“待补充中文名称”。
- 提交前必须向用户说明完整变更范围并取得明确确认；确认后在同一操作中提交并推送，不能只提交。

---

## 文件结构与职责

| 文件 | 职责 |
| --- | --- |
| `migrations/postgres/0004_simplified_chinese_game_names.sql` | 新增词条表和游戏级展示名称元数据，不触碰历史身份/价格数据。 |
| `src/repositories/ports.ts` | 定义名称词条、游戏名称管理和服务端展示 DTO 的平台中立端口。 |
| `src/shared/game-name-identity.ts` | 从官方标题、发行商和商品类型生成唯一的名称词条键；不依赖中文显示名。 |
| `src/repositories/postgres/game-name-repository.ts` | 以参数化 SQL 实现词条查询、游戏覆盖、幂等回填与管理队列。 |
| `src/services/game-name-service.ts` | 集中校验名称、来源、证据链接、优先级和回填业务规则。 |
| `src/routes/game-name-routes.ts` | 受认证的名称管理 HTTP 合同和严格 JSON 收窄。 |
| `src/services/subscription-confirmation-service.ts` | 在官方身份重验后读取词条或验证管理员给出的中文名。 |
| `src/repositories/postgres/subscription-confirmation-repository.ts` | 在原子创建游戏时写入已确认的中文展示名。 |
| `src/repositories/postgres/dashboard-repository.ts`、`src/repositories/postgres/subscription-detail-repository.ts` | 返回服务端决议后的 `displayNameZhCn`，绝不把旧 `name_zh` 当作已确认名称。 |
| `src/app/dashboard-api-client.ts`、`src/app/dashboard-page.tsx`、`src/app/subscription-detail-page.tsx` | 渲染统一展示名及详情页更正入口。 |
| `src/app/game-name-management-page.tsx`、`src/app/game-name-api-client.ts`、`src/app/app-navigation.ts`、`src/app/App.tsx`、`src/app/styles.css` | 名称回填管理页面、同源客户端、路由和必要样式。 |
| `src/app/subscription-wizard.ts`、`src/app/subscription-wizard-page.tsx`、`src/app/api-client.ts`、`src/shared/domain.ts`、`src/routes/product-routes.ts` | 新订阅的名称建议、必填确认及服务端请求合同。 |
| `test/game-name-*.test.ts`、现有 API/DOM/PostgreSQL 测试 | 回归名称优先级、鉴权、迁移、回填和两页展示一致性。 |

### Task 1: 建立名称存储与平台中立端口

**Files:**
- Create: `migrations/postgres/0004_simplified_chinese_game_names.sql`
- Modify: `src/repositories/ports.ts`
- Modify: `test/postgres-migrations.test.ts`
- Create: `test/game-name-repository.test.ts`

**Interfaces:**
- Produces `GameNameCatalogEntry`：`identityKey`、`displayNameZhCn`、`source`、`evidenceUrl`、`confirmedAt`。
- Produces `GameNameStore`：`findCatalogEntry(identityKey)`、`listPending()`、`applyCatalogBackfill(now)`、`saveGameName(input)`。
- Produces `GameDisplayName`：`displayNameZhCn: string | null` 与 `state: "confirmed" | "pending"`。

- [ ] **Step 1: 为迁移和空库结构写失败测试**

在 `test/postgres-migrations.test.ts` 将词条表加入期望集合，并将游戏名称元数据列加入类型断言；在新测试中执行真实迁移并断言下列 SQL 约束：

```ts
await database.query(
  "INSERT INTO game_name_catalog (identity_key, display_name_zh_cn, source, confirmed_at) VALUES ($1, $2, $3, $4)",
  ["overcooked 2\\u0000ghost town games\\u0000game", "胡闹厨房 2", "publisher", now],
);
await expect(database.query(
  "INSERT INTO game_name_catalog (identity_key, display_name_zh_cn, source, confirmed_at) VALUES ($1, $2, $3, $4)",
  ["overcooked 2\\u0000ghost town games\\u0000game", "错误重复名", "manual", now],
)).rejects.toMatchObject({ code: "23505" });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- test/postgres-migrations.test.ts test/game-name-repository.test.ts`
Expected: FAIL，因为 `0004_simplified_chinese_game_names.sql`、表和端口尚不存在。

- [ ] **Step 3: 写最小迁移和端口**

创建迁移，新增 `game_name_catalog`，并在 `games` 上新增可空 `display_name_zh_cn`、`display_name_source` 和 `display_name_confirmed_at`。使用如下受控来源和值约束；注释必须说明名称只影响展示，不能改变官方身份。

```sql
CREATE TABLE game_name_catalog (
  identity_key TEXT PRIMARY KEY,
  display_name_zh_cn TEXT NOT NULL CHECK (char_length(trim(display_name_zh_cn)) BETWEEN 1 AND 120),
  source TEXT NOT NULL CHECK (source IN ('publisher', 'mainland-platform', 'hk-reference', 'manual')),
  evidence_url TEXT,
  confirmed_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE games ADD COLUMN display_name_zh_cn TEXT;
ALTER TABLE games ADD COLUMN display_name_source TEXT
  CHECK (display_name_source IN ('catalog', 'manual'));
ALTER TABLE games ADD COLUMN display_name_confirmed_at TIMESTAMPTZ;
```

在端口中把 `identityKey` 明确为现有 `normalized_name` 的精确值，并使游戏级记录可空，确保旧 `name_zh` 只能作为管理候选、不是展示真值。

- [ ] **Step 4: 运行迁移测试确认通过**

Run: `npm test -- test/postgres-migrations.test.ts test/game-name-repository.test.ts`
Expected: PASS，空库包含词条表和名称相关列，重复词条被唯一键拒绝，现有业务表仍存在。

### Task 2: 实现词条、覆盖和幂等回填服务

**Files:**
- Create: `src/repositories/postgres/game-name-repository.ts`
- Create: `src/services/game-name-service.ts`
- Create: `src/shared/game-name-identity.ts`
- Modify: `src/repositories/ports.ts`
- Modify: `src/services/subscription-confirmation-service.ts`
- Modify: `test/support/in-memory-business-stores.ts`
- Create: `test/game-name-service.test.ts`
- Modify: `test/game-name-repository.test.ts`

**Interfaces:**
- Consumes Task 1 的 `GameNameStore`、`GameNameCatalogEntry` 与 `GameDisplayName`。
- Produces `gameNameIdentityKey({ canonicalTitle, publisher, productType })`，它以现有 `normalized_name` 的标题、发行商、类型顺序产生稳定字符串。
- Produces `GameNameService.listPending()`、`backfill(now)`、`saveManual(gameId, input, now)` 与 `resolveForConfirmedGame(identityKey, submittedName)`。
- `saveManual` 输入为 `{ displayNameZhCn: string; source: "publisher" | "mainland-platform" | "hk-reference" | "manual"; evidenceUrl: string | null; saveToCatalog: boolean }`。

- [ ] **Step 1: 写失败测试覆盖优先级和安全边界**

在 `test/game-name-service.test.ts` 写入以下用例：

```ts
expect(await service.resolveForConfirmedGame(identityKey, null)).toEqual({
  displayNameZhCn: "胡闹厨房 2",
  source: "catalog",
});
await service.saveManual(gameId, { displayNameZhCn: "胡闹厨房 2：美食家版", source: "manual", evidenceUrl: null, saveToCatalog: false }, now);
expect((await service.listPending()).map((item) => item.gameId)).not.toContain(gameId);
await expect(service.saveManual(gameId, { displayNameZhCn: "   ", source: "manual", evidenceUrl: null, saveToCatalog: false }, now))
  .rejects.toThrow("中文显示名称长度应为 1 到 120 个字符。");
```

另写入：同标题但不同 `identityKey` 不能命中、回填两次只在第一次更新、`saveToCatalog: true` 只覆盖同一 identityKey 的未来建议而不改写其他游戏的 `manual` 名称。

- [ ] **Step 2: 运行服务测试确认失败**

Run: `npm test -- test/game-name-service.test.ts test/game-name-repository.test.ts`
Expected: FAIL，因为服务、仓储实现和内存替身尚不存在。

- [ ] **Step 3: 实现仓储与服务**

将现有 `normalizedGameName` 的“标题 + 发行商 + 类型”正规化逻辑移到 `game-name-identity.ts`，并让订阅确认继续使用这个唯一实现；中文名永远不输入该函数。仓储所有 SQL 使用参数；回填仅更新名称为空、具有 `normalized_name` 且命中词条的游戏：

```sql
UPDATE games
   SET display_name_zh_cn = catalog.display_name_zh_cn,
       display_name_source = 'catalog',
       display_name_confirmed_at = catalog.confirmed_at
  FROM game_name_catalog AS catalog
 WHERE games.display_name_zh_cn IS NULL
   AND games.normalized_name IS NOT NULL
   AND catalog.identity_key = games.normalized_name;
```

服务在写入前 `trim()`，拒绝 1–120 字符之外的值；只有 HTTPS 证据链接可接受，`manual` 来源允许 `null` 证据。`saveToCatalog` 为真时在同一事务 upsert 词条，再保存当前游戏的 `manual` 覆盖；为假时不得修改词条。为这些边界写中文注释，说明来源审计与避免误译的业务原因。

- [ ] **Step 4: 运行服务与 PostgreSQL 测试确认通过**

Run: `npm test -- test/game-name-service.test.ts test/game-name-repository.test.ts test/postgres-migrations.test.ts`
Expected: PASS，词条/人工优先级正确，回填幂等，不会覆盖人工确认名称。

### Task 3: 将名称决议接入订阅确认与读取 DTO

**Files:**
- Modify: `src/services/subscription-confirmation-service.ts`
- Modify: `src/repositories/postgres/subscription-confirmation-repository.ts`
- Modify: `src/repositories/postgres/dashboard-repository.ts`
- Modify: `src/repositories/postgres/subscription-detail-repository.ts`
- Modify: `src/services/dashboard-service.ts`
- Modify: `src/repositories/ports.ts`
- Modify: `src/server/dependencies.ts`
- Modify: `test/subscription-confirmation-service.test.ts`
- Modify: `test/postgres-subscription-write.test.ts`
- Modify: `test/api-dashboard.test.ts`
- Modify: `test/api-subscription-detail.test.ts`

**Interfaces:**
- Consumes `GameNameService.resolveForConfirmedGame(normalizedName, submittedName)`。
- Produces `DashboardSubscription.displayNameZhCn: string | null` 和 `SubscriptionDetail.game.displayNameZhCn: string | null`。
- 扩展 `ConfirmedSubscriptionInput`：`displayNameZhCn?: string`，只可作为管理员提交的候选，不能替代服务器官方重验。

- [ ] **Step 1: 写失败测试**

添加确认服务断言：经过官方锚点重验后，名称库命中时创建 DTO 使用词条名称；未命中且没有 `displayNameZhCn` 时抛出 `SubscriptionConfirmationError("请确认简体中文游戏名称。")`；浏览器提交的名称长度非法也被拒绝。为数据库查询与 API 夹具断言：

```ts
expect(detail.game).toMatchObject({
  displayNameZhCn: "胡闹厨房 2",
  nameEn: "Overcooked! 2",
});
expect(overview.subscriptions[0].displayNameZhCn).toBe("胡闹厨房 2");
```

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- test/subscription-confirmation-service.test.ts test/postgres-subscription-write.test.ts test/api-dashboard.test.ts test/api-subscription-detail.test.ts`
Expected: FAIL，因为输入、服务依赖、SQL 投影和响应字段尚未存在。

- [ ] **Step 3: 写最小实现**

在确认服务取得服务器重验的 `selected` 后，先计算既有 `normalizedGameName(selected)`，再调用名称服务；永远不用浏览器的标题/发行商/类型作为词条键。仅在无词条时接受已验证的非空 `displayNameZhCn`，并将其作为当前游戏 `manual` 名称写入。`insertGame` 同时写入旧官方字段和新展示字段，保留旧 `name_zh` 的兼容数据但不让读取模型依赖它。

仪表盘和详情查询将 `games.display_name_zh_cn AS "displayNameZhCn"` 直接投影进 DTO；不在 SQL 或浏览器中回退 `name_zh`。在依赖装配处把同一 `GameNameService` 注入确认服务、名称管理路由和需要它的仓储。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- test/subscription-confirmation-service.test.ts test/postgres-subscription-write.test.ts test/api-dashboard.test.ts test/api-subscription-detail.test.ts`
Expected: PASS，官方身份与中文展示名分离，未确认名称不能新建订阅，读取 API 返回可空的服务端展示字段。

### Task 4: 提供受认证的名称管理与回填 API

**Files:**
- Create: `src/routes/game-name-routes.ts`
- Modify: `src/server/dependencies.ts`
- Modify: `src/server/app.ts`（仅当路由 handler 类型需要显式导出）
- Create: `test/api-game-names.test.ts`
- Modify: `test/server-http.test.ts`

**Interfaces:**
- `GET /api/game-names?status=pending` 返回 `{ games: PendingGameName[] }`。
- `POST /api/game-names/backfill` 返回 `{ updatedGameIds: string[]; remainingCount: number }`。
- `POST /api/game-names/suggestions` 接收 `{ candidates: NameSuggestionCandidate[] }`，返回 `{ suggestions: NameSuggestion[] }`；它仅为向导提供已确认词条的预填建议，最终创建仍在服务器官方重验后裁决。
- `PATCH /api/game-names/:gameId` 接收 Task 2 的 `saveManual` 载荷，返回 `{ gameId, displayNameZhCn, source }`。

- [ ] **Step 1: 写失败的 HTTP 合同测试**

覆盖如下合同：未认证的四个端点都返回 401；`POST /backfill` 仅更新未命中项；`POST /suggestions` 只按标题、发行商、类型返回已确认词条或 `null`；`PATCH` 的空白名称返回 422；非 HTTPS `evidenceUrl` 返回 422；未知游戏返回 404；成功更新不返回旧 `name_zh`、SQL 错误或外部网页内容。

```ts
const response = await request("http://localhost/api/game-names/game-1", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ displayNameZhCn: "星之卡比 探索发现", source: "manual", evidenceUrl: null, saveToCatalog: true }),
});
expect(response.status).toBe(200);
expect(await response.json()).toEqual({ gameId: "game-1", displayNameZhCn: "星之卡比 探索发现", source: "manual" });
```

- [ ] **Step 2: 运行 API 测试确认失败**

Run: `npm test -- test/api-game-names.test.ts test/server-http.test.ts`
Expected: FAIL，因为路由未注册且请求合同不存在。

- [ ] **Step 3: 实现路由与依赖装配**

把 handler 放在既有 `handleDashboardRoute`、`handleSubscriptionRoute` 同级，并在 dispatcher 中放于认证路由之后。使用 `requireAdmin`；仅允许精确的 GET、POST、PATCH 路径。建议端点只读取 `{ candidateKey, canonicalTitle, publisher, productType }`，调用 Task 2 的 `gameNameIdentityKey` 后查询已确认词条；不把浏览器输入当作创建身份。JSON 解析只接受普通对象，严格验证 `source` 枚举、布尔 `saveToCatalog`、1–120 字符的 `displayNameZhCn` 和可空 HTTPS 链接；领域 `NotFound`/验证错误映射为 404/422，其余异常使用固定中文 500 文案。

- [ ] **Step 4: 运行 API 测试确认通过**

Run: `npm test -- test/api-game-names.test.ts test/server-http.test.ts`
Expected: PASS，所有写入端点均经认证、验证和脱敏错误处理。

### Task 5: 让仪表盘和详情页只显示服务端中文名

**Files:**
- Modify: `src/app/dashboard-api-client.ts`
- Modify: `src/app/dashboard-page.tsx`
- Modify: `src/app/subscription-detail-page.tsx`
- Modify: `src/shared/game-display-name.ts`
- Modify: `test/dashboard-api-client.test.ts`
- Modify: `test/dashboard-page.test.tsx`
- Modify: `test/game-display-name.test.ts`

**Interfaces:**
- Consumes Task 3 的 `displayNameZhCn: string | null`。
- Produces `displayGameName(displayNameZhCn: string | null): string`，当且仅当字段为 null 时返回固定的“待补充中文名称”。

- [ ] **Step 1: 写失败 DOM 与纯函数测试**

```ts
expect(displayGameName(null)).toBe("待补充中文名称");
expect(displayGameName("胡闹厨房 2")).toBe("胡闹厨房 2");
expect(await screen.findByRole("heading", { name: "待补充中文名称" })).toBeTruthy();
expect(screen.queryByRole("heading", { name: "Overcooked! 2" })).toBeNull();
```

同时断言仪表盘复选框的无障碍名称与详情页主标题在同一 DTO 上都使用相同中文名。

- [ ] **Step 2: 运行前端测试确认失败**

Run: `npm test -- test/dashboard-api-client.test.ts test/dashboard-page.test.tsx test/game-display-name.test.ts`
Expected: FAIL，因为客户端 DTO 和页面仍读取 `nameZh` 并调用旧的 Overcooked 正则映射。

- [ ] **Step 3: 写最小页面实现**

将前端 DTO 中的 `nameZh` 替换为 `displayNameZhCn`；共享函数只负责 null 占位，不保留游戏专属词表或从 `nameEn` 推断中文。仪表盘卡片标题、选择框 `aria-label` 与详情首个 `h1` 只调用该函数。删除或改写旧函数和测试中将英文 `nameZh` 解释为中文的过期注释。

- [ ] **Step 4: 运行前端测试确认通过**

Run: `npm test -- test/dashboard-api-client.test.ts test/dashboard-page.test.tsx test/game-display-name.test.ts`
Expected: PASS，两个页面不会把英文/日文官方标题作为游戏主标题显示。

### Task 6: 增加名称管理页和详情更正入口

**Files:**
- Create: `src/app/game-name-api-client.ts`
- Create: `src/app/game-name-management-page.tsx`
- Modify: `src/app/app-navigation.ts`
- Modify: `src/app/App.tsx`
- Modify: `src/app/dashboard-page.tsx`
- Modify: `src/app/subscription-detail-page.tsx`
- Modify: `src/app/styles.css`
- Create: `test/game-name-management-page.test.tsx`
- Modify: `test/app-navigation.test.ts`
- Modify: `test/dashboard-page.test.tsx`

**Interfaces:**
- Consumes Task 4 的四个同源端点。
- Produces `gameNameManagementPath(): "/game-names"`，并在仪表盘提供入口。
- `GameNameManagementPage` 显示待补充队列、执行回填、编辑单条、选择是否写入词条。

- [ ] **Step 1: 写失败 DOM 测试**

覆盖：仪表盘入口可导航；队列显示官方标题/发行商/类型仅作管理员辅助信息；主列表显示“待补充中文名称”；点击回填后刷新队列；空白保存保持输入并显示 API 的 422 摘要；详情页保存中文名后重新读取详情而非在本地拼装价格或地区。

```tsx
await user.type(screen.getByLabelText("简体中文显示名称"), "星之卡比 探索发现");
await user.click(screen.getByRole("checkbox", { name: "保存为可复用词条" }));
await user.click(screen.getByRole("button", { name: "保存中文名称" }));
expect(api.saveGameName).toHaveBeenCalledWith("game-kirby", expect.objectContaining({ saveToCatalog: true }));
```

- [ ] **Step 2: 运行 DOM 测试确认失败**

Run: `npm test -- test/game-name-management-page.test.tsx test/app-navigation.test.ts test/dashboard-page.test.tsx`
Expected: FAIL，因为路由、客户端与页面尚不存在。

- [ ] **Step 3: 实现管理与详情 UI**

新增独立页面，避免把批量回填状态混入仪表盘价格读取状态。页面先请求待补充项，回填成功后重新读取队列；每行的官方原文只出现在管理页，不进入仪表盘/详情主标题。详情编辑调用同一客户端，成功后调用既有 `reload()`，不能本地修改 `detail` 的价格或地区数组。样式仅增加管理表单所需类，复用既有按钮、通知与无障碍标签模式。

- [ ] **Step 4: 运行 DOM 测试确认通过**

Run: `npm test -- test/game-name-management-page.test.tsx test/app-navigation.test.ts test/dashboard-page.test.tsx`
Expected: PASS，管理员可以回填和更正，普通展示页仍不泄露官方原文主标题。

### Task 7: 在新订阅向导中确认中文名并完成回归与文档

**Files:**
- Modify: `src/shared/domain.ts`
- Modify: `src/app/subscription-wizard.ts`
- Modify: `src/app/subscription-wizard-page.tsx`
- Modify: `src/app/api-client.ts`
- Modify: `src/routes/product-routes.ts`
- Modify: `test/subscription-wizard.test.ts`
- Modify: `test/subscription-wizard-page.test.tsx`
- Modify: `test/api-product-discovery.test.ts`
- Modify: `docs/requirements/PRD.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/data-model.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/README.md`（仅在不覆盖用户已有改动的前提下新增规格/计划链接）

**Interfaces:**
- 扩展 `ConfirmedSubscriptionInput` 的可选 `displayNameZhCn`，由 Task 3 的服务端做最终身份绑定和必填裁决。
- 向导以 `Record<string, string>` 按默认区候选键保存名称草稿，避免批量选择多款游戏时名称相互覆盖。
- 向导以 Task 4 的 `POST /api/game-names/suggestions` 返回值预填名称；建议只改善体验，不能绕过最终官方重验。

- [ ] **Step 1: 写失败测试**

测试已命中词条的候选预填、未命中候选必须输入中文名、两款候选可各自输入不同名称、提交载荷包含各自 `displayNameZhCn`；路由拒绝不存在或超长字段。

```ts
expect(api.confirmSubscriptions).toHaveBeenCalledWith([
  expect.objectContaining({ selected: usCandidate, displayNameZhCn: "胡闹厨房 2" }),
]);
expect(screen.getByRole("button", { name: "确认订阅" })).toBeDisabled();
```

- [ ] **Step 2: 运行向导/API 测试确认失败**

Run: `npm test -- test/subscription-wizard.test.ts test/subscription-wizard-page.test.tsx test/api-product-discovery.test.ts`
Expected: FAIL，因为输入合同、草稿和必填门禁尚未实现。

- [ ] **Step 3: 实现向导合同与文档同步**

在区域确认完成后的提交区为每个选中默认区商品显示“简体中文显示名称”输入。选择候选后调用 Task 4 的建议接口并预填已命中词条；未命中时输入必填。路由只收窄长度与字符串形状，最终仍由 Task 3 的确认服务在官方锚点重验后匹配/写入，不能信任浏览器标题。

同步更新 PRD、追踪表、数据模型和 API 文档：写明词库来源优先级、人工审核、回填幂等性、管理员认证、待补充占位和不使用在线翻译；不要改写历史规格为“已实现”。若 `docs/README.md` 的用户改动与新增链接冲突，停止并请求用户决定，而非覆盖文件。

- [ ] **Step 4: 运行完整验证并进行注释审查**

Run: `npm test`
Run: `npm run test:dom`
Run: `npm run test:docker-config`
Run: `npm run test:github-actions`
Run: `npx tsc --noEmit`
Run: `npm run build`
Run: `git diff --check`

Expected: 全部通过。逐文件检查新增/修改的 TypeScript、SQL、测试和文档注释均准确说明名称审计、官方身份隔离、认证与回填边界。

- [ ] **Step 5: 提交与推送前的用户确认**

向用户说明将包含的迁移、后端服务/路由/仓储、前端页面/向导、测试和文档范围，并获得明确提交授权。确认后在同一操作中执行：

```bash
git add migrations/postgres/0004_simplified_chinese_game_names.sql src test docs
git commit -m "feat: manage simplified Chinese game names"
git push origin "$(git branch --show-current)"
```

不得暂存或提交用户原有的 `docs/README.md`、`docs/HANDOFF.md` 改动；如该变更与本功能文档重叠，先请求用户处理冲突。

## 计划自查

- 词条来源、人工审核、身份联合匹配、游戏级覆盖、存量回填、新订阅门禁、仪表盘/详情一致展示、认证、迁移与测试均分别由 Task 1–7 覆盖。
- 本计划不包含在线翻译、运行时网页抓取、价格/地区/汇率改写，符合已确认范围。
- 所有后续任务引用的 `GameNameStore`、`GameNameService`、`displayNameZhCn` 和 API 路径均在前序任务中定义。
- 计划没有未完成占位或依赖读者自行补全的步骤；提交步骤遵循本仓库“先确认、同次推送”的覆盖规则。
