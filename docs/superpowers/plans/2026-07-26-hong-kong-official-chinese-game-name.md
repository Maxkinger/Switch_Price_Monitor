# 大陆/香港官方中文游戏名 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让现有和未来订阅优先使用与香港官方商品 ID 精确对应的腾讯 Nintendo Switch 大陆官方标题，再回退香港繁转简、人工中文或官方英文。

**Architecture:** Worker 在游戏名称专用服务中复用既有的香港官方商品发现与身份核验，从唯一的香港 `titles/{ID}` 商品提取数字 ID 并只读取腾讯 Nintendo Switch 官方 `software/{同一 ID}` 页面。没有可验证大陆页面时，才以离线 OpenCC 转换香港繁体标题。`games.name_zh` 仍是全部展示与通知的唯一名称字段，新增来源列保护人工输入；新增订阅在确认前预览名称，既有订阅通过受认证的批量同步与逐项回退决策完成更新。

**Tech Stack:** TypeScript、Cloudflare Workers、D1、React 19、Vitest、`opencc-js@1.4.1`（本地词典、离线繁简转换）。

## 实施状态（2026-07-26）

- [x] Task 1：离线繁简转换、名称来源契约与旧展示词表移除已实施。
- [x] Task 2：迁移 `0007_game_name_sources.sql`、订阅归属受限名称仓储已实施。
- [x] Task 3：唯一香港 `titles/{ID}` 与同 ID 腾讯 Nintendo Switch `software/{ID}` 核验、香港离线转简回退已实施。
- [x] Task 4：新增确认与既有订阅的官方/人工/英文决策已实施。
- [x] Task 5：名称预览、同步与同步确认三个管理员端点，以及向导和仪表盘显式流程已实施。
- [x] Task 6：展示回归、单 Worker 全量 Worker 回归、完整 DOM 回归、类型检查、构建、差异检查与注释一致性核对均已通过。


## Global Constraints

- 所有新增或修改的源码、测试、SQL 迁移和配置必须配有与实现一致的中文详细注释，说明职责、数据约束、边界与安全/业务原因。
- 所有生产行为按 TDD 执行：先写失败测试、确认失败原因、最小实现、确认通过，再进行重构。
- 名称优先级固定为大陆官方同 ID 标题、香港官方繁中转简体、人工中文、官方英文回退；禁止机器翻译、AI 翻译或第三方翻译服务。
- 大陆官方标题只接受腾讯 Nintendo Switch 官方 `software/{ID}` 页面，且 ID 必须与通过地区、官方 URL、商品类型、发行商和既有本地化身份规则核验的香港 `titles/{同一 ID}` 候选一致。
- 名称转换不得影响 `normalized_name`、官方 URL、价格 ID、监控地区、快照、汇率、目标价或采集行为。
- 人工中文名称不得被自动同步覆盖；同步失败和歧义必须降级为管理员填写中文或确认英文，不能阻止合法订阅创建。
- 所有新写接口要求管理员会话，错误文案仅返回简体中文安全摘要，不回显任天堂页面、Cookie、内部评分、SQL 或堆栈。
- 不在仪表盘普通加载时请求任天堂；既有名称同步仅由管理员显式触发。
- 不提交密钥、密码、恢复码、会话令牌或真实 Telegram 凭据。
- 每次准备提交前先向管理员说明范围并获得明确确认；确认后在同一操作中完成本地提交与 `git push`，不得单独提交。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `migrations/0007_game_name_sources.sql` | 为既有 `games` 记录增加受控名称来源，默认标记为待同步，不发起网络请求。 |
| `src/shared/game-name.ts` | 声明四种可持久化名称来源及浏览器/Worker 共用 DTO。 |
| `src/shared/traditional-to-simplified.ts` | 封装离线 `opencc-js` 的香港繁体转简体转换，隔离第三方依赖。 |
| `src/types/opencc-js.d.ts` | 为没有内置 TypeScript 声明的纯 JS 转换器提供最小准确的模块类型。 |
| `src/worker/services/official-product-discovery-service.ts` | 暴露仅供 Worker 使用的、可证明唯一香港同一商品候选的窄方法。 |
| `src/worker/providers/official-mainland-nintendo-product-page.ts` | 只读取腾讯 Nintendo Switch 官方 `software/{ID}` 页面并验证 URL、状态与非空标题。 |
| `src/worker/services/game-name-service.ts` | 先用香港数字 ID 解析大陆官方名称，再统一决定新订阅预览、创建和旧订阅同步时的回退状态。 |
| `src/worker/repositories/subscription-confirmation-repository.ts` | 保存新游戏的展示名称及来源，并读取安全的既有订阅名称同步锚点。 |
| `src/worker/repositories/game-name-repository.ts` | 以订阅归属为边界读取和更新既有游戏名称，避免跨订阅改写。 |
| `src/worker/services/game-name-sync-service.ts` | 批量执行官方同步、返回逐项人工决策，并安全保存人工中文或英文回退。 |
| `src/worker/services/subscription-confirmation-service.ts` | 在最终写入前重新解析官方名称，浏览器只能提交人工中文选择。 |
| `src/worker/routes/product-routes.ts` | 新增创建前名称预览接口，并收窄可选人工中文输入。 |
| `src/worker/routes/subscription-routes.ts` | 新增既有订阅同步与回退确认接口，复用会话守卫和错误脱敏。 |
| `src/worker/index.ts` | 装配名称解析、同步服务和两个路由依赖。 |
| `src/app/api-client.ts` | 让新增订阅向导请求名称预览并提交可选人工中文名。 |
| `src/app/dashboard-api-client.ts` | 声明并调用既有订阅名称同步接口。 |
| `src/app/subscription-wizard-page.tsx` | 在最终确认前展示官方简体名称或中文输入/英文回退选择。 |
| `src/app/dashboard-page.tsx` | 提供显式“同步游戏名称”批量流程和未解析项的人工决策界面。 |
| `test/game-name*.test.ts`、`test/subscription-confirmation-service.test.ts`、`test/api-*.test.ts`、`test/*page.test.tsx` | 覆盖转换、官方核验、持久化、授权、回退与页面交互。 |

### Task 1: 建立离线繁简转换与名称来源契约

**Files:**
- Create: `src/shared/game-name.ts`
- Create: `src/shared/traditional-to-simplified.ts`
- Create: `src/types/opencc-js.d.ts`
- Create: `test/traditional-to-simplified.test.ts`
- Modify: `src/shared/game-display-name.ts`
- Modify: `test/game-display-name.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `GameNameSource = "mainland_official" | "hong_kong_official" | "manual_chinese" | "official_english_fallback" | "legacy_pending_sync"`.
- Produces: `convertHongKongTraditionalToSimplified(title: string): string`.
- Produces: `hasChineseText(value: string): boolean`，供路由验证人工输入而不把日文假名误作中文。

- [ ] **Step 1: 写转换与来源契约的失败测试**

```ts
import { describe, expect, it } from "vitest";
import { convertHongKongTraditionalToSimplified, hasChineseText } from "../src/shared/traditional-to-simplified";

describe("香港官方游戏名繁简转换", () => {
  it("uses an offline Hong Kong Traditional-to-Simplified conversion", () => {
    expect(convertHongKongTraditionalToSimplified("薩爾達傳說 王國之淚")).toBe("萨尔达传说 王国之泪");
  });

  it("does not mistake Japanese kana for a Chinese manual name", () => {
    expect(hasChineseText("オーバークック２")).toBe(false);
    expect(hasChineseText("胡闹厨房 2")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认它因模块不存在而失败**

Run: `npm test -- test/traditional-to-simplified.test.ts`

Expected: FAIL，错误明确指出 `traditional-to-simplified` 模块尚不存在，而非测试环境或网络错误。

- [ ] **Step 3: 安装并封装离线转换器**

Run: `npm install opencc-js@1.4.1`

创建准确的最小模块声明，并实现只在 Worker 内存中使用的转换器：

```ts
// src/types/opencc-js.d.ts
declare module "opencc-js" {
  const OpenCC: { Converter(options: { from: "hk"; to: "cn" }): (value: string) => string };
  export default OpenCC;
}

// src/shared/traditional-to-simplified.ts
import OpenCC from "opencc-js";

/** 香港官方标题仅在本地以内置词典转换为简体，禁止把商品标题发送给翻译服务。 */
const hongKongToSimplified = OpenCC.Converter({ from: "hk", to: "cn" });

/** 转换失败必须由调用方显式处理，不能静默改用猜测名称或改变商品身份字段。 */
export function convertHongKongTraditionalToSimplified(title: string): string {
  const converted = hongKongToSimplified(title).trim();
  if (!converted) throw new Error("香港官方标题转换结果为空。");
  return converted;
}

/** 只有汉字可构成人工中文名；单独的日文假名不能绕过官方名称回退规则。 */
export function hasChineseText(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}
```

在 `src/shared/game-name.ts` 导出 `gameNameSources` 常量和 `GameNameSource` 类型；为来源含义写中文注释。不要再让 `game-display-name.ts` 根据有限词表重写已保存名称。

同时将 `displayChineseGameName` 收窄为“非空 `nameZh` 原样展示，否则回退 `nameEn`”；删除 `resolveChineseGameName` 和标题模式匹配。新增失败测试必须覆盖已保存的大陆/香港官方名不会被重写，以及英文回退保持原样。这样从名称来源契约首次落地起就不会出现旧词表覆盖人工或官方名称的中间状态。

- [ ] **Step 4: 运行单元测试与类型检查，确认离线转换通过**

Run: `npm test -- test/traditional-to-simplified.test.ts`

Expected: PASS；测试不创建网络请求。随后运行 `npx tsc --noEmit`，Expected: PASS。

- [ ] **Step 5: 请求提交确认而不自行提交**

向管理员说明本任务只新增离线转换依赖、来源类型和测试；只有得到明确确认后，才在同一操作中执行 `git add`、`git commit` 与 `git push`。

### Task 2: 迁移名称来源并建立受订阅约束的持久化边界

**Files:**
- Create: `migrations/0007_game_name_sources.sql`
- Create: `src/worker/repositories/game-name-repository.ts`
- Create: `test/game-name-repository.test.ts`
- Modify: `test/apply-migrations.ts`
- Modify: `src/worker/repositories/subscription-confirmation-repository.ts`
- Modify: `test/subscription-confirmation-service.test.ts`

**Interfaces:**
- Consumes: `GameNameSource` from `src/shared/game-name.ts`.
- Produces: `GameNameSyncItem { subscriptionId; gameId; source; nameEn; anchor; hongKongProductUrl }`.
- Produces: `GameNameRepository.updateForSubscription(subscriptionId, nameZh, source, now): Promise<boolean>`.

- [ ] **Step 1: 写迁移与仓储失败测试**

```ts
it("marks existing games as pending without changing their stored display name", async () => {
  const row = await env.DB.prepare("SELECT name_zh AS nameZh, name_zh_source AS source FROM games WHERE id = ?")
    .bind("legacy-game").first<{ nameZh: string; source: string }>();
  expect(row).toEqual({ nameZh: "Kirby and the Forgotten Land", source: "legacy_pending_sync" });
});

it("does not update a game when the selected subscription does not own it", async () => {
  await expect(repository.updateForSubscription("other-subscription", "星之卡比 探索发现", "manual_chinese", now)).resolves.toBe(false);
});
```

- [ ] **Step 2: 运行失败测试确认缺列/缺仓储实现**

Run: `npm test -- test/game-name-repository.test.ts test/subscription-confirmation-service.test.ts`

Expected: FAIL，原因是 `name_zh_source` 尚未迁移或 `GameNameRepository` 尚未导出；不得因为断言写错而失败。

- [ ] **Step 3: 添加迁移、迁移装载和参数化仓储实现**

```sql
-- 既有名称保持不变并标为待同步；迁移不访问任天堂，避免发布时网络失败误改业务数据。
ALTER TABLE games ADD COLUMN name_zh_source TEXT NOT NULL DEFAULT 'legacy_pending_sync';
```

将 `0007` 按编号加入 `test/apply-migrations.ts`。`SubscriptionConfirmationRepository` 的 `ValidatedSubscriptionConfirmation.game` 增加 `nameZhSource: GameNameSource`，并把 INSERT 扩展为 `name_zh_source` 参数。新增仓储使用如下受限更新 SQL：

```ts
const result = await this.database.prepare(
  `UPDATE games
   SET name_zh = ?, name_zh_source = ?
   WHERE id = (
     SELECT game_id FROM subscriptions WHERE id = ?
   )`,
).bind(nameZh, source, subscriptionId).run();
return result.meta.changes === 1;
```

读取同步项时通过 `subscriptions → games → subscription_regions → regional_products` 重建只读锚点；若已监控香港商品，则同时返回其官方 URL。每个新建 SQL、接口和分支须用中文注释说明人工名称保护与订阅归属限制。

- [ ] **Step 4: 运行仓储、确认服务和迁移回归**

Run: `npm test -- test/game-name-repository.test.ts test/subscription-confirmation-service.test.ts test/schema-and-repositories.test.ts`

Expected: PASS；现有创建仍写入名称，旧游戏名称不因迁移改变，非所属订阅返回 `false`。

- [ ] **Step 5: 请求提交确认而不自行提交**

向管理员说明迁移和名称仓储的范围；仅在明确确认后将本任务文件一并提交并推送。

### Task 3: 以唯一香港商品 ID 解析大陆官方名称并安全回退

**Files:**
- Create: `src/worker/services/game-name-service.ts`
- Create: `src/worker/providers/official-mainland-nintendo-product-page.ts`
- Create: `test/game-name-service.test.ts`
- Create: `test/official-mainland-nintendo-product-page.test.ts`
- Modify: `src/worker/services/official-product-discovery-service.ts`
- Modify: `test/official-product-discovery-service.test.ts`

**Interfaces:**
- Produces: `OfficialGameNameResolution = { kind: "mainland_official" | "hong_kong_official"; nameZh: string } | { kind: "unavailable" }`.
- Produces: `GameNameService.resolveOfficialName(anchor, knownHongKongUrl?): Promise<OfficialGameNameResolution>`.
- Produces: `OfficialProductDiscoveryService.resolveUniqueHongKongCandidate(anchor, knownHongKongUrl?): Promise<OfficialProductCandidate | null>`.

- [ ] **Step 1: 写唯一候选和转换失败测试**

```ts
it("uses a Tencent mainland title only when it has the same verified Hong Kong title ID", async () => {
  const result = await service.resolveOfficialName(anchor, "https://ec.nintendo.com/HK/zh/titles/70010000000001");
  expect(result).toEqual({ kind: "mainland_official", nameZh: "星之卡比 探索发现" });
});

it("returns unavailable when Hong Kong candidates are ambiguous", async () => {
  await expect(service.resolveOfficialName(anchor)).resolves.toEqual({ kind: "unavailable" });
});

it("falls back to converted Hong Kong title when the Tencent same-ID page is unavailable", async () => {
  await expect(service.resolveOfficialName(anchor)).resolves.toEqual({ kind: "hong_kong_official", nameZh: "萨尔达传说 王国之泪" });
});

it("does not accept a same-title Hong Kong DLC for a game anchor", async () => {
  await expect(service.resolveOfficialName(anchor)).resolves.toEqual({ kind: "unavailable" });
});
```

- [ ] **Step 2: 运行测试确认服务尚不存在**

Run: `npm test -- test/game-name-service.test.ts test/official-product-discovery-service.test.ts`

Expected: FAIL，原因是大陆官方页面提供方、新的公共解析方法与 `GameNameService` 尚未实现。

- [ ] **Step 3: 最小实现唯一香港解析器**

在 `OfficialProductDiscoveryService` 新增窄公共方法：若 `knownHongKongUrl` 非空，先经既有 `pages.resolve("HK", ...)` 重读详情，再使用已导出的 `hasSameOfficialIdentity` 或 `hasHighConfidenceLocalizedIdentity` 判断它是否属于锚点；否则调用既有 `matchRegion(anchor, "HK")`，且只在结果为 `automatic` 时返回候选。所有歧义、页面失败、类型/发行商不符与非香港 URL 都返回 `null`。

新增大陆页面提供方只接受 `https://www.nintendoswitch.com.cn/software/{纯数字 ID}`。它先在请求前验证 ID 为十进制数字，读取后确认最终 URL 仍是相同路径、响应成功且页面标题非空；页面正文中不记录、返回或拼接给浏览器。香港候选必须匹配 `^/HK/zh/titles/(\\d+)$` 才能提取 ID；`aocs`、`bundles`、查询参数、片段或不匹配路径一律不能请求大陆页面。

`GameNameService` 只依赖该窄方法与 `convertHongKongTraditionalToSimplified`：

```ts
public async resolveOfficialName(anchor: OfficialProductCandidate, knownHongKongUrl?: string): Promise<OfficialGameNameResolution> {
  const candidate = await this.discovery.resolveUniqueHongKongCandidate(anchor, knownHongKongUrl);
  if (!candidate) return { kind: "unavailable" };
  const mainlandTitle = await this.mainland.resolve(readHongKongTitleId(candidate.productUrl));
  if (mainlandTitle) return { kind: "mainland_official", nameZh: mainlandTitle };
  try {
    return { kind: "hong_kong_official", nameZh: convertHongKongTraditionalToSimplified(candidate.canonicalTitle) };
  } catch {
    return { kind: "unavailable" };
  }
}
```

写中文注释说明：候选标题只用于显示，`canonicalTitle`、锚点和转换后的名称均不得参与身份判断；大陆 ID 精确对应和转换异常降级都是为防止错误自动改名。

- [ ] **Step 4: 运行服务与官方发现回归**

Run: `npm test -- test/game-name-service.test.ts test/official-product-discovery-service.test.ts`

Expected: PASS；仅唯一且已核验香港 `titles` 候选可查询大陆同 ID 页面，存在大陆标题时优先，否则产生香港简体名。

- [ ] **Step 5: 请求提交确认而不自行提交**

说明本任务只开放受限香港候选解析和离线展示名服务；确认后才将测试、服务与发现改动一起提交并推送。

### Task 4: 在新建确认和既有同步中实施三层名称决策

**Files:**
- Create: `src/worker/services/game-name-sync-service.ts`
- Create: `test/game-name-sync-service.test.ts`
- Modify: `src/shared/domain.ts`
- Modify: `src/worker/services/subscription-confirmation-service.ts`
- Modify: `src/worker/repositories/subscription-confirmation-repository.ts`
- Modify: `test/subscription-confirmation-service.test.ts`

**Interfaces:**
- Consumes: `GameNameService`, `GameNameRepository`, `GameNameSource`.
- Produces: `GameNamePreview { nameZh: string | null; source: "mainland_official" | "hong_kong_official" | "unavailable" }`.
- Produces: `GameNameSyncResult { subscriptionId; status: "updated_official" | "needs-decision"; nameEn: string }`.
- Produces: `GameNameDecision { subscriptionId; nameZh?: string }`，空/缺失 `nameZh` 表示确认官方英文回退。

- [ ] **Step 1: 写新增确认和同步决策失败测试**

```ts
it("stores a verified mainland official name instead of a browser-supplied manual name", async () => {
  await service.confirm([{ ...input, displayNameZh: "伪造名称" }], now);
  await expect(readGame()).resolves.toMatchObject({ nameZh: "星之卡比 探索发现", nameZhSource: "mainland_official" });
});

it("stores manual Chinese only when an official Hong Kong name is unavailable", async () => {
  await sync.confirmDecisions([{ subscriptionId: "sub-kirby", nameZh: "星之卡比 探索发现" }], now);
  await expect(readGame()).resolves.toMatchObject({ nameZhSource: "manual_chinese" });
});

it("keeps a manual Chinese name during a later official sync", async () => {
  await expect(sync.sync(["sub-kirby"], now)).resolves.toEqual([
    { subscriptionId: "sub-kirby", status: "needs-decision", nameEn: "Kirby and the Forgotten Land" },
  ]);
});
```

- [ ] **Step 2: 运行测试确认新增决策接口尚缺失**

Run: `npm test -- test/game-name-sync-service.test.ts test/subscription-confirmation-service.test.ts`

Expected: FAIL，原因为输入、服务或来源字段未实现；测试不得因 D1 初始化失败。

- [ ] **Step 3: 实现预览、最终重验和同步服务**

扩展 `ConfirmedSubscriptionInput`：

```ts
export interface ConfirmedSubscriptionInput {
  selected: OfficialProductCandidate;
  regions: ConfirmedRegionalProduct[];
  skippedRegionCodes: RegionCode[];
  /** 仅当服务端无法核验香港官方名时才可保存；空值明确请求官方英文回退。 */
  displayNameZh?: string;
}
```

`SubscriptionConfirmationService` 在写入前调用 `GameNameService.resolveOfficialName`，传入已确认 HK 地区候选 URL（若存在）。成功则按解析结果强制写 `mainland_official` 或 `hong_kong_official`；不可用时，先接受含汉字且长度 1–200 的 `displayNameZh` 写入 `manual_chinese`，否则写锚点 `canonicalTitle` 与 `official_english_fallback`。不使用旧 `resolveChineseGameName` 词表。

`GameNameSyncService.sync(subscriptionIds, now)` 逐项读取仓储项；`manual_chinese` 直接返回 `needs-decision` 而不写入，其他项请求 `GameNameService`。官方成功项立即按订阅归属更新；不可用项返回英文供 UI 决策。`confirmDecisions(decisions, now)` 只允许空值写英文回退，或含汉字的 1–200 字名称写人工中文；重复订阅 ID、空数组、未知订阅均抛受控领域错误。

- [ ] **Step 4: 运行服务、确认和 D1 回归**

Run: `npm test -- test/game-name-sync-service.test.ts test/subscription-confirmation-service.test.ts test/game-name-repository.test.ts`

Expected: PASS；官方成功优先、人工中文仅在官方不可用时保存、空值英文回退、人工名不被同步覆盖。

- [ ] **Step 5: 请求提交确认而不自行提交**

说明本任务会改变新订阅与既有同步的名称写入逻辑；仅在管理员明确确认后执行一次提交和推送。

### Task 5: 接入受认证 API 与新增/既有订阅页面

**Files:**
- Modify: `src/worker/routes/product-routes.ts`
- Modify: `src/worker/routes/subscription-routes.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/app/api-client.ts`
- Modify: `src/app/dashboard-api-client.ts`
- Modify: `src/app/subscription-wizard-page.tsx`
- Modify: `src/app/dashboard-page.tsx`
- Modify: `test/api-product-discovery.test.ts`
- Modify: `test/api-subscriptions.test.ts`
- Modify: `test/subscription-wizard-page.test.tsx`
- Modify: `test/dashboard-page.test.tsx`

**Interfaces:**
- Produces: `POST /api/products/preview-game-names`，输入为确认前锚点及其已确认香港候选 URL，响应为每锚点的 `GameNamePreview`。
- Produces: `POST /api/subscriptions/sync-game-names`，输入 `{ subscriptionIds: string[] }`，响应 `GameNameSyncResult[]`。
- Produces: `POST /api/subscriptions/sync-game-names/confirm`，输入 `{ decisions: GameNameDecision[] }`，响应 `{ updatedSubscriptionIds: string[] }`。

- [ ] **Step 1: 写路由和页面失败测试**

```ts
it("rejects anonymous game-name sync requests", async () => {
  const response = await worker.fetch(request("/api/subscriptions/sync-game-names", { subscriptionIds: ["sub-kirby"] }));
  expect(response.status).toBe(401);
});

it("shows manual Chinese and English fallback choices when a new subscription has no Hong Kong title", async () => {
  render(<SubscriptionWizardPage api={apiWithoutHongKongName} onUnauthorized={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "确认并创建订阅" }));
  expect(screen.getByLabelText("中文展示名称")).toBeTruthy();
  expect(screen.getByText("留空将使用官方英文标题")).toBeTruthy();
});

it("does not request game-name sync while the dashboard is loading", async () => {
  render(<DashboardPage api={api} onUnauthorized={vi.fn()} onNavigate={vi.fn()} />);
  expect(api.syncGameNames).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行 API 与 DOM 测试确认新增接口/控件缺失**

Run: `npm test -- test/api-product-discovery.test.ts test/api-subscriptions.test.ts`

Expected: FAIL，原因是新路径未被路由或依赖注入处理。随后运行 `npm run test:dom -- test/subscription-wizard-page.test.tsx test/dashboard-page.test.tsx`，Expected: FAIL，原因是文案或控件尚不存在。

- [ ] **Step 3: 实现严格输入收窄、路由装配与界面流程**

产品路由新增预览分支，只接受与既有 `readConfirmedSubscription` 同样收窄的候选，并忽略浏览器声明的名称来源。订阅路由新增两个精确静态路径，必须在 `/:id` 正则匹配前判断，防止 `sync-game-names` 被当成订阅 ID；所有批量 ID、决策数组、中文输入长度与重复项均由路由验证，再交服务进行归属验证。

在 `index.ts` 用生产的 `OfficialProductDiscoveryService`、香港页面解析器和 `GameNameService` 装配确认、预览与同步依赖；测试入口注入窄接口，不让页面或路由自行访问任天堂。

新增向导在地区核验完成后调用预览接口并显示：大陆官方成功时“已采用腾讯 Nintendo Switch 官方中文名称：{name}”；香港回退成功时“已采用任天堂香港官方中文名称：{name}”；不可用时显示 `aria-label="中文展示名称"` 输入和“留空将使用官方英文标题”。提交时把该值作为 `displayNameZh`，服务器仍会重复核验并覆盖伪造的官方声明。

仪表盘仅在管理员点击“同步游戏名称”后发送选中订阅 ID；成功项刷新概览，未解析项在受控对话框中逐项提供中文输入和“保留官方英文”确认。请求完成后重新读取仪表盘；不在 `useEffect` 中自动同步。所有新增 React、路由和客户端代码补充中文注释，说明认证、外部调用和人工名称保护。

- [ ] **Step 4: 运行 API、DOM 与完整回归**

Run: `npm test -- test/api-product-discovery.test.ts test/api-subscriptions.test.ts test/api-dashboard.test.ts`

Expected: PASS，匿名为 401、越权/无效输入为安全 422/404、成功不回显外部正文。运行 `npm run test:dom -- test/subscription-wizard-page.test.tsx test/dashboard-page.test.tsx`，Expected: PASS，官方、人工和英文三种页面分支均可完成。

- [ ] **Step 5: 请求提交确认而不自行提交**

说明本任务新增管理员 API 与两个界面流程；得到明确确认后，将所有 API、前端与测试变更一次提交并推送。

### Task 6: 完成文档与质量门禁

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/requirements/PRD.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/data-model.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/superpowers/specs/2026-07-26-hong-kong-official-chinese-game-name-design.md`
- Modify: `docs/superpowers/plans/2026-07-26-hong-kong-official-chinese-game-name.md`

**Interfaces:**
- Consumes: 已保存的 `nameZh` 与 `nameZhSource`。
- Produces: 对提前移除旧词表的展示规则执行回归验证，并完成实现状态文档与质量门禁。

- [ ] **Step 1: 补充展示层回归测试**

```ts
it("preserves the stored official simplified title without applying the legacy title dictionary", () => {
  expect(displayChineseGameName("塞尔达传说 王国之泪", "The Legend of Zelda: Tears of the Kingdom"))
    .toBe("塞尔达传说 王国之泪");
});

it("preserves an explicit English fallback", () => {
  expect(displayChineseGameName("Kirby and the Forgotten Land", "Kirby and the Forgotten Land"))
    .toBe("Kirby and the Forgotten Land");
});
```

- [ ] **Step 2: 运行展示层回归测试确认提前修复仍有效**

Run: `npm test -- test/game-display-name.test.ts`

Expected: PASS；若失败，必须定位为后续改动重新引入旧词表或破坏已保存名称回退，而非放宽断言。

- [ ] **Step 3: 更新实施状态文档**

在产品、追踪、数据模型、API 和规格中记录实际迁移编号、端点、测试结果和“已实施”状态；更新文档中心对应计划/规格状态。检查此前关于“仅受控词表”或“未知不得自动翻译”的文字，替换为本计划的大陆同 ID 官方优先、香港繁转简、人工中文和英文回退规则，确保文档不自相矛盾。

- [x] **Step 4: 运行完整质量门禁并检查注释一致性**

Run: `npm test`

Expected: PASS。

Run: `npm run test:dom`

Expected: PASS。

Run: `npx tsc --noEmit`

Expected: PASS。

Run: `npm run build`

Expected: PASS。

Run: `git diff --check`

Expected: 无输出且退出码 0。

逐一核对本计划涉及的 TypeScript、测试、SQL 和路由中文注释：每条注释必须仍准确描述大陆同 ID 核验、离线转换、香港官方身份核验、人工名称不覆盖、订阅归属与错误脱敏等实际行为。

- [ ] **Step 5: 汇总改动并请求一次最终提交与推送确认**

向管理员列出迁移、离线依赖、名称服务、受认证接口、向导/仪表盘流程、测试和文档的完整范围及所有通过的质量门禁。只有管理员明确确认后，才执行一次 `git add`、`git commit -m "feat: use official Chinese game names"` 和 `git push`。

## 计划自检

- **规格覆盖：** Task 1 实现离线繁转简、名称来源与旧词表移除；Task 2 实现来源追溯与人工保护；Task 3 处理大陆同 ID 与香港官方核验；Task 4 覆盖新订阅与既有订阅的四层决策；Task 5 实现受认证接口和两个用户流程；Task 6 同步全部文档并执行完整质量门禁。
- **完整性：** 每个任务都给出了确切文件、测试、预期失败/通过表现和最小实现边界；所有接口均在首次消费前定义。
- **类型一致性：** `GameNameSource`、`GameNamePreview`、`GameNameSyncResult` 和 `GameNameDecision` 均由前序任务定义；Task 5 的 API 仅消费 Task 4 的 DTO，Task 6 只消费已保存的 `nameZh`/`nameZhSource`。
