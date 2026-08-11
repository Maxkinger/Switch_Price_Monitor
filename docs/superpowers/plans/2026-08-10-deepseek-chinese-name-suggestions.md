# DeepSeek 中文游戏名称建议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在完成地区核验后生成可编辑、待管理员确认的 DeepSeek 简体中文游戏名称建议，并让存量名称管理页可按需取得同类建议。

**Architecture:** Node 服务以受控官方候选字段调用 DeepSeek Chat Completions JSON 输出，严格收窄和脱敏后通过同源名称 API 返回建议。建议只写入浏览器独立草稿；既有订阅确认和名称保存服务仍是唯一持久化入口，继续以官方锚点和精确 identityKey 裁决。

**Tech Stack:** Node.js 22 原生 `fetch`、TypeScript、DeepSeek Chat Completions JSON 输出、React、Vitest、PostgreSQL（仅复用既有名称保存）。

## Global Constraints

- `DEEPSEEK_API_KEY` 只能由 Node 进程环境读取；不得写入设置页、浏览器、PostgreSQL、日志、测试夹具、错误响应或 Git。
- AI 输入仅含 `candidateKey`、官方标题、发行商、商品类型和受控版本文本；不得发送 Cookie、密码、恢复码、会话、订阅 ID、价格、地区商品 URL、数据库或 Telegram 数据。
- AI 只返回待确认候选，绝不自动写入游戏、词条、订阅或回填结果，也不参与官方身份、跨区匹配、价格和地区裁决。
- 每次最多 10 个候选，外部请求 10 秒超时；无 Key、网络、非 2xx、JSON 或字段错误必须以固定脱敏状态降级，手工填写仍可完成。
- 旁路仅在 `LOCAL_DEVELOPMENT_AUTH_BYPASS=true` 且 Node 入口已强制监听 `127.0.0.1` 时适用；其他环境仍需要真实管理员会话。
- 所有新增或修改的源代码、测试与配置必须有准确的中文详细注释；遵循测试先行。
- 提交前须取得用户对完整范围的明确确认；确认后同一操作提交并推送，不能纳入用户现有 `docs/README.md` 或 `docs/HANDOFF.md` 改动。

---

## 文件结构与职责

| 文件 | 职责 |
| --- | --- |
| `src/services/deepseek-game-name-suggestion-service.ts` | 以受控 prompt 调用 DeepSeek、超时、JSON 收窄与 AI 结果降级。 |
| `src/server/config.ts` | 收窄可选 DeepSeek Key 与模型环境配置，绝不输出 Key。 |
| `src/server/dependencies.ts` | 装配可选 AI 名称建议服务，未配置时提供显式不可用状态。 |
| `src/routes/game-name-routes.ts` | 新增严格 JSON 的 AI 建议路由，不访问名称写入服务。 |
| `src/app/game-name-api-client.ts` | 同源 AI 建议客户端 DTO 和受控错误传递。 |
| `src/app/subscription-wizard-page.tsx` | 地区核验成功后异步预填独立草稿，保护人工输入不被迟到响应覆盖。 |
| `src/app/game-name-management-page.tsx` | 为单个待补充行按需请求并标记可编辑 AI 建议。 |
| `test/deepseek-game-name-suggestion-service.test.ts` | 覆盖外部调用边界、10 秒超时、JSON 与敏感数据不泄漏。 |
| `test/api-game-names.test.ts`、`test/server-http.test.ts` | 覆盖 API 收窄、认证/本机旁路、未配置和零持久化。 |
| `test/game-name-api-client.test.ts`、`test/subscription-wizard-page.test.tsx`、`test/game-name-management-page.test.tsx` | 覆盖客户端、异步草稿隔离和人工确认边界。 |

### Task 1: DeepSeek 配置与受控建议服务

**Files:**
- Create: `src/services/deepseek-game-name-suggestion-service.ts`
- Modify: `src/server/config.ts`
- Modify: `test/server-config.test.ts`
- Create: `test/deepseek-game-name-suggestion-service.test.ts`

**Interfaces:**
- Produces `AiGameNameCandidate`：`{ candidateKey: string; canonicalTitle: string; publisher: string | null; productType: ProductType }`。
- Produces `AiGameNameSuggestion`：`{ candidateKey: string; displayNameZhCn: string | null; confidence: "high" | "medium" | "low" }`。
- Produces `DeepSeekGameNameSuggestionService.suggest(candidates: AiGameNameCandidate[]): Promise<AiGameNameSuggestion[]>`。
- Extends `ServerConfig` with `deepSeekApiKey?: string` and `deepSeekModel?: "deepseek-v4-flash" | "deepseek-v4-pro"`.

- [ ] **Step 1: 为配置和服务写失败测试**

```ts
it("只在存在非空 Key 时暴露 DeepSeek 配置，模型缺省为 flash", () => {
  expect(readServerConfig(baseEnvironment({ DEEPSEEK_API_KEY: "test-key" }))).toMatchObject({
    deepSeekApiKey: "test-key",
    deepSeekModel: "deepseek-v4-flash",
  });
  expect(readServerConfig(baseEnvironment({ DEEPSEEK_MODEL: "arbitrary" }))).toThrow("DEEPSEEK_MODEL_INVALID");
});

it("把不合法模型 JSON 结果降级为同候选键的 null，且请求不含会话或价格字段", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: "not-json" } }] }));
  const service = new DeepSeekGameNameSuggestionService("test-key", "deepseek-v4-flash", fetch);
  await expect(service.suggest([candidate("official-1")])).resolves.toEqual([
    { candidateKey: "official-1", displayNameZhCn: null, confidence: "low" },
  ]);
  expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain("session");
  expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain("price");
});
```

- [ ] **Step 2: 运行失败测试确认 RED**

Run: `npm test -- test/server-config.test.ts test/deepseek-game-name-suggestion-service.test.ts`
Expected: FAIL，因为配置字段和服务尚不存在。

- [ ] **Step 3: 实现最小配置与服务**

```ts
export class DeepSeekGameNameSuggestionService {
  public constructor(
    private readonly apiKey: string,
    private readonly model: "deepseek-v4-flash" | "deepseek-v4-pro",
    private readonly request: typeof fetch = fetch,
  ) {}

  public async suggest(candidates: AiGameNameCandidate[]): Promise<AiGameNameSuggestion[]> {
    if (candidates.length === 0 || candidates.length > 10) throw new AiGameNameSuggestionError("AI 名称建议候选数量无效。");
    // 使用 AbortSignal.timeout(10_000)；Authorization 仅发往 DeepSeek 固定 origin，日志和错误不读取 Key 或外部正文。
    // JSON 只允许输入数组中已有的 candidateKey，逐项重建 1..120 字符结果；错误或低置信度统一返回 null。
  }
}
```

在 `readServerConfig` 中只读取 `DEEPSEEK_API_KEY` 和受控模型枚举；Key 缺失时不抛错，使 AI 功能可选且不会阻止本机手工名称流程。所有环境错误只返回固定代码，不插值 Key。

- [ ] **Step 4: 运行服务测试确认 GREEN**

Run: `npm test -- test/server-config.test.ts test/deepseek-game-name-suggestion-service.test.ts`
Expected: PASS，非法 JSON、重复/未知键、`low` 置信度及超长名称降级为 `null`；超时和非 2xx 抛出固定可用性错误；有效结果只使用允许字段。

### Task 2: 同源 AI 建议 API 与依赖装配

**Files:**
- Modify: `src/server/dependencies.ts`
- Modify: `src/routes/game-name-routes.ts`
- Modify: `test/api-game-names.test.ts`
- Modify: `test/server-http.test.ts`

**Interfaces:**
- Consumes Task 1 的 `DeepSeekGameNameSuggestionService` 或 `null`。
- Produces `POST /api/game-names/ai-suggestions`，请求 `{ candidates: AiGameNameCandidate[] }`，响应 `{ suggestions: AiGameNameSuggestion[] }`。
- 既有四个名称端点的响应与写入语义不变。

- [ ] **Step 1: 写失败的 HTTP 合同测试**

```ts
it("AI 建议只返回候选且不写入名称目录或游戏", async () => {
  const store = new InMemoryGameNameStore();
  store.seedPending(pendingGame("game-1", "overcooked 2|ghost town games|game"));
  const names = new GameNameService(store);
  const service = { suggest: vi.fn().mockResolvedValue([{ candidateKey: "key-1", displayNameZhCn: "胡闹厨房 2", confidence: "high" }]) };
  const response = await routeRequestWithAi("/api/game-names/ai-suggestions", "POST", {
    candidates: [{ candidateKey: "key-1", canonicalTitle: "Overcooked! 2", publisher: "Ghost Town Games", productType: "game" }],
  }, allowedSessions, names, service);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ suggestions: [{ candidateKey: "key-1", displayNameZhCn: "胡闹厨房 2", confidence: "high" }] });
  expect((await names.listPending()).map((game) => game.gameId)).toEqual(["game-1"]);
});

it("AI 未配置时返回固定 503，未认证请求仍为 401", async () => {
  await expect(routeRequestWithAi("/api/game-names/ai-suggestions", "POST", { candidates: [] }, deniedSessions, null)).resolves.toMatchObject({ status: 401 });
  await expect(routeRequestWithAi("/api/game-names/ai-suggestions", "POST", { candidates: [] }, allowedSessions, null)).resolves.toMatchObject({ status: 503 });
});
```

- [ ] **Step 2: 运行 API 测试确认 RED**

Run: `npm test -- test/api-game-names.test.ts test/server-http.test.ts`
Expected: FAIL，因为精确路径、AI 服务注入和 503 状态尚不存在。

- [ ] **Step 3: 实现路由收窄和装配**

```ts
type GameNameAiSuggestionService = Pick<DeepSeekGameNameSuggestionService, "suggest">;

// 仅精确 POST 路径匹配；readSuggestionCandidates 复用标题、发行商、类型和候选键的运行时收窄。
if (action.kind === "ai-suggestions") {
  if (aiSuggestions === null) return Response.json({ code: "AI_NOT_CONFIGURED", error: "AI 名称建议尚未配置。" }, { status: 503 });
  return Response.json({ suggestions: await aiSuggestions.suggest(readSuggestionCandidates(await readJson(request))) });
}
```

在依赖装配中只有 Key 存在时创建服务；将 `GameNameAiSuggestionService | null` 与 `config.localDevelopmentAuthBypass === true` 一并传给名称路由，因此回环本机开发可验证完整 UI，而 Key 缺失/正式会话边界不变。路由不得调用 `saveManual`、`backfill`、仓储事务或外部任天堂服务。

- [ ] **Step 4: 运行 API 测试确认 GREEN**

Run: `npm test -- test/api-game-names.test.ts test/server-http.test.ts`
Expected: PASS，API 严格认证、只读、503 脱敏和本机旁路均正确，原有目录建议与写入没有回归。

### Task 3: 向导自动预填 AI 建议

**Files:**
- Modify: `src/app/game-name-api-client.ts`
- Modify: `src/app/subscription-wizard-page.tsx`
- Modify: `test/game-name-api-client.test.ts`
- Modify: `test/subscription-wizard-page.test.tsx`

**Interfaces:**
- Extends name client with `suggestAiNames(candidates: GameNameSuggestionCandidate[]): Promise<{ suggestions: AiGameNameSuggestion[] }>`.
- `SubscriptionWizardPage` consumes the same `gameNameApi` and keeps `Record<string, string>` as the only confirmable Chinese name state.

- [ ] **Step 1: 写失败的客户端和 DOM 测试**

```tsx
it("地区核验成功后预填 AI 建议但不覆盖管理员已输入的名称", async () => {
  const api = nameSuggestionApi({ suggestions: [{ candidateKey: candidateKey(usCandidate), displayNameZhCn: "AI 建议名", confidence: "high" }] });
  render(<SubscriptionWizardPage api={productApi} gameNameApi={api} onUnauthorized={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "核验其他地区" }));
  expect(await screen.findByDisplayValue("AI 建议名")).toBeTruthy();
  expect(screen.getByText("AI 建议，待确认")).toBeTruthy();
  await user.clear(screen.getByLabelText("Overcooked! 2 的简体中文显示名称"));
  await user.type(screen.getByLabelText("Overcooked! 2 的简体中文显示名称"), "管理员名称");
  await resolveLateAiResponse();
  expect(screen.getByDisplayValue("管理员名称")).toBeTruthy();
});
```

- [ ] **Step 2: 运行前端测试确认 RED**

Run: `npm test -- test/game-name-api-client.test.ts`
Run: `npm run test:dom -- --run test/subscription-wizard-page.test.tsx`
Expected: FAIL，因为 AI 客户端、预填状态与“待确认”标识尚不存在。

- [ ] **Step 3: 实现最小客户端和异步状态保护**

```ts
async suggestAiNames(candidates: GameNameSuggestionCandidate[]) {
  return requestJson<{ suggestions: AiGameNameSuggestion[] }>("/api/game-names/ai-suggestions", "POST", { candidates });
}
```

地区核验成功后仅对当前已选候选启动一批建议请求。用现有搜索代次和候选键隔离迟到结果；只在草稿仍为空时调用 `setChineseNameDraft`。为每个候选保存 `aiSuggestedCandidateKeys`，只在建议成功且草稿由 AI 填入时显示“AI 建议，待确认”。401 继续交给认证壳；503、超时和其他受控错误显示提示但不清空地区结果或禁用手工确认。

- [ ] **Step 4: 运行前端测试确认 GREEN**

Run: `npm test -- test/game-name-api-client.test.ts`
Run: `npm run test:dom -- --run test/subscription-wizard-page.test.tsx`
Expected: PASS，AI 建议自动填入、多人选草稿隔离、人工输入优先且 AI 故障不阻塞确认。

### Task 4: 名称管理页按需 AI 建议

**Files:**
- Modify: `src/app/game-name-management-page.tsx`
- Modify: `src/app/styles.css`
- Modify: `test/game-name-management-page.test.tsx`

**Interfaces:**
- Extends管理页最小端口 with `suggestAiNames(candidates: GameNameSuggestionCandidate[]): Promise<{ suggestions: AiGameNameSuggestion[] }>`.
- Produces per-game loading state, AI suggestion marker, draft update and unchanged existing `saveGameName` contract.

- [ ] **Step 1: 写失败 DOM 测试**

```tsx
it("单行 AI 建议只预填当前草稿，管理员保存前不写入名称", async () => {
  const api = managementApi({ aiSuggestions: [{ candidateKey: "game-kirby", displayNameZhCn: "星之卡比 探索发现", confidence: "high" }] });
  render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "生成 AI 建议" }));
  expect(screen.getByDisplayValue("星之卡比 探索发现")).toBeTruthy();
  expect(screen.getByText("AI 建议，待确认")).toBeTruthy();
  expect(api.saveGameName).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行 DOM 测试确认 RED**

Run: `npm run test:dom -- --run test/game-name-management-page.test.tsx`
Expected: FAIL，因为页面尚无建议按钮、加载状态和 AI 标识。

- [ ] **Step 3: 实现单行按需建议**

对待补充行将 `gameId` 作为回传关联键、`officialTitle` 映射为 `canonicalTitle`，并传现有发行商/类型。点击按钮时只更新该 `gameId` 的 loading 集合；成功时仅在当前草稿仍等于初始 `legacyNameZh` 或空时预填，防止覆盖编辑。未配置/失败显示服务端脱敏摘要；按钮恢复可重试。样式复用现有按钮、通知和响应式表单布局，不能在仪表盘/详情展示官方原文或 AI 名称。

- [ ] **Step 4: 运行 DOM 测试确认 GREEN**

Run: `npm run test:dom -- --run test/game-name-management-page.test.tsx`
Expected: PASS，建议不保存、只影响当前行、人工草稿优先、失败可重试且现有 422 保存行为不变。

### Task 5: 配置文档、全量验证与交付确认

**Files:**
- Modify: `.env.example`
- Modify: `docs/requirements/PRD.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/architecture/data-model.md`
- Modify: `docs/deployment/synology-ds423-plus.md`
- Modify: `docs/superpowers/specs/2026-08-10-simplified-chinese-game-name-design.md`
- Modify: `docs/superpowers/specs/2026-08-10-deepseek-chinese-name-suggestions-design.md`（仅在实施中发现必须澄清的事实时）

- [ ] **Step 1: 同步文档与环境示例**

在 `.env.example` 只添加空 `DEEPSEEK_API_KEY=` 与受控默认 `DEEPSEEK_MODEL=deepseek-v4-flash`，中文注释强调真实 Key 只能在私有环境文件中设置。更新 PRD/API/数据模型为“AI 只生成待确认建议”，修订旧中文名称规格中“运行时不调用 AI”为“AI 输出不得自动发布”。部署手册仅列出私有环境变量和不打印秘密的限制，不新增 NAS 部署授权，也不改动用户已有 `docs/README.md`。

- [ ] **Step 2: 运行完整验证和注释审查**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npm test`
Run: `npm run test:dom -- --run`
Run: `npm run test:docker-config`
Run: `npm run test:github-actions`
Run: `npx tsc --noEmit`
Run: `npm run build`
Run: `git diff --check`

Expected: 全部通过。逐文件检查新增/修改的中文注释与实现一致；确认 API Key 未出现在 diff、构建产物、测试快照、浏览器 DTO、API 错误或日志。

- [ ] **Step 3: 提交与推送前获取用户确认**

向用户说明将提交：本机旁路修复、DeepSeek 服务/配置/AI API、向导和管理页建议 UI、测试、环境示例和文档。确认后仅暂存明确列出的功能文件，排除用户已有 `docs/README.md` 与 `docs/HANDOFF.md`，并在同一操作提交和推送：

```bash
git add src test docs/requirements/PRD.md docs/architecture/api-design.md docs/architecture/data-model.md docs/deployment/synology-ds423-plus.md docs/superpowers/specs .env.example
git commit -m "feat: suggest Chinese game names with DeepSeek"
git push origin main
```

## 计划自查

- Task 1 实现并收窄外部 API、模型配置、超时和结果降级。
- Task 2 实现认证的只读 API、依赖装配与零持久化边界。
- Task 3、4 分别覆盖新订阅自动预填和存量按需建议，二者都要求管理员确认保存。
- Task 5 覆盖秘密配置、旧文档冲突、完整回归和提交授权。
- 所有后续接口名称均由前序任务定义；无未定义占位、自动保存或未限定的外部调用。
