# 单选官方候选与按核验触发 AI 中文名称建议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让订阅向导只能选择一个官方商品，并仅在成功核验其他地区后请求一次 DeepSeek 中文名称建议并安全预填。

**Architecture:** 将单选及候选切换后的上下文清理由纯状态模块承担，页面仅调用该状态转换并持有局部 AI 加载/过期响应保护。DeepSeek 适配器继续使用固定官方端点和白名单候选字段，但强化系统提示词以输出常用简体中文名称和版本后缀；所有建议仍仅是浏览器草稿。

**Tech Stack:** React、TypeScript、Vitest、Testing Library、Node 22 Fetch、DeepSeek Chat Completions。

## Global Constraints

- AI 只能在管理员主动发起且成功完成的“核验其他地区”或“重新核验”后请求；搜索、候选选择、输入编辑、失败核验和任何非核验自动流程均不得调用 AI。
- 页面任一时刻至多一个官方候选；切换候选必须清除旧候选的地区、跳过、手动链接、中文草稿、目录/AI 建议及加载状态。
- DeepSeek 请求只发送临时批次键、标题、可空发行商和商品类型；绝不发送 URL、地区、价格、游戏/订阅 ID、Cookie 或秘密。
- AI 建议不自动持久化；人工编辑优先，`null`/低置信度/异常均允许手工填写。
- 新增或修改源代码、测试和文档必须保持详细且准确的中文注释；不提交真实 API Key、主密钥或其他秘密。
- Git 提交与推送仅在用户明确确认变更范围后执行。

---

### Task 1: 单选候选纯状态与清理边界

**Files:**
- Modify: `src/app/subscription-wizard.ts:19-165`
- Modify: `test/subscription-wizard.test.ts:22-45`

**Interfaces:**
- Produces: `selectCandidate(state: SubscriptionWizardState, candidateKey: string): SubscriptionWizardState`。
- Replaces: `toggleCandidate` 的多选语义；`selectedCandidateKeys` 保留数组形态以最小化既有消费者变更，但结果长度只能为 `0` 或 `1`。

- [ ] **Step 1: 写失败的单选与清理状态测试**

```ts
it("selects at most one candidate and clears the prior candidate context", () => {
  const populated = {
    ...createSubscriptionWizardState({ status: "available", candidates: [overcooked(), kirby()] }),
    selectedCandidateKeys: ["US:overcooked"],
    chineseNameDrafts: { "US:overcooked": "胡闹厨房 2" },
    regionalConfirmations: { "US:overcooked:HK": { ...overcooked(), regionCode: "HK", productUrl: "https://www.nintendo.com/hk/overcooked" } },
    regionalConfirmationSources: { "US:overcooked:HK": "automatic" as const },
    skippedRegionalKeys: ["US:overcooked:JP"],
    sourcePreviews: { "US:overcooked": [] },
  };
  const first = selectCandidate(populated, "US:overcooked");
  const switched = selectCandidate(first, "US:kirby");

  expect(switched.selectedCandidateKeys).toEqual(["US:kirby"]);
  expect(switched.chineseNameDrafts).toEqual({});
  expect(switched.regionalConfirmations).toEqual({});
  expect(switched.regionalConfirmationSources).toEqual({});
  expect(switched.skippedRegionalKeys).toEqual([]);
  expect(switched.sourcePreviews).toEqual({});
  expect(selectCandidate(switched, "US:kirby").selectedCandidateKeys).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**

Run: `npm test -- test/subscription-wizard.test.ts`

Expected: FAIL，因为 `selectCandidate` 不存在，既有 `toggleCandidate` 仍允许两个键并存。

- [ ] **Step 3: 实现最小状态转换**

```ts
export function selectCandidate(state: SubscriptionWizardState, candidateKey: string): SubscriptionWizardState {
  if (state.selectedCandidateKeys[0] === candidateKey) {
    return { ...state, selectedCandidateKeys: [], chineseNameDrafts: {}, regionalConfirmations: {}, regionalConfirmationSources: {}, skippedRegionalKeys: [], sourcePreviews: {} };
  }
  return { ...state, selectedCandidateKeys: [candidateKey], chineseNameDrafts: {}, regionalConfirmations: {}, regionalConfirmationSources: {}, skippedRegionalKeys: [], sourcePreviews: {} };
}
```

在函数注释中说明：所有依赖候选键的 UI 草稿必须整体清空，防止前一商品的地区或 AI 名称进入新商品；数组仅为兼容既有确认载荷，不代表多选。

- [ ] **Step 4: 运行 GREEN**

Run: `npm test -- test/subscription-wizard.test.ts`

Expected: PASS，旧多选用例改为单选/切换清理合同。

- [ ] **Step 5: 暂存与提交准备（仅在用户确认后）**

```bash
git add src/app/subscription-wizard.ts test/subscription-wizard.test.ts
git commit -m "fix: make subscription candidates single-select"
```

不要在未取得用户明确提交确认时执行此步。

### Task 2: 向导的核验后 AI 请求、局部加载与预填交互

**Files:**
- Modify: `src/app/subscription-wizard-page.tsx:264-548, 660-745`
- Modify: `test/subscription-wizard-page.test.tsx:140-330`

**Interfaces:**
- Consumes: `selectCandidate` 与既有 `suggestAiNames(candidates)`。
- Produces: 第三步局部状态 `isAiNameSuggestionLoading`；只在 `resolveRegions(selectedCandidate)` 成功后调用一次 AI。

- [ ] **Step 1: 写失败的 DOM 回归**

```tsx
it("switches official candidates, clears the old draft, and sends AI only after a successful regional check", async () => {
  // 选择第一候选并写入草稿；切换第二候选后，第一候选的输入与地区卡必须消失。
  // 搜索和两次候选点击都断言 suggestAiNames 未调用。
  // 点击核验后断言先出现“正在生成 AI 中文名称建议”，且恰好调用一次。
  // 返回 { displayNameZhCn: "潜水员戴夫 Nintendo Switch 2 Edition", confidence: "medium" } 后断言新输入预填并显示“AI 建议，待确认”。
});

it("keeps manual entry usable when AI returns null or fails after regional verification", async () => {
  // 核验成功、AI 返回 low/null 或 503 时，不清空地区结果；名称输入保持可编辑并显示脱敏状态提示。
});
```

- [ ] **Step 2: 运行 RED**

Run: `npm test -- --config vitest.dom.config.mts test/subscription-wizard-page.test.tsx`

Expected: FAIL，因为页面仍显示“可多选”、切换保留旧草稿、没有 AI 加载状态且现有多候选用例会得到不同结果。

- [ ] **Step 3: 最小页面实现**

```tsx
const [isAiNameSuggestionLoading, setIsAiNameSuggestionLoading] = useState(false);

function handleSelectCandidate(candidate: OfficialProductCandidate): void {
  nameSuggestionGeneration.current += 1;
  setAiSuggestedCandidateKeys([]);
  setResolutions([]);
  setResolvedCandidateKeys([]);
  setWizard((current) => selectCandidate(current, candidateKey(candidate)));
}

async function loadAiChineseNameSuggestions(candidate: OfficialProductCandidate, generation: number): Promise<void> {
  setIsAiNameSuggestionLoading(true);
  const batch = aiSuggestionBatchSequence.current + 1;
  aiSuggestionBatchSequence.current = batch;
  const aiKey = `ai-${batch}-1`;
  try {
    const response = await gameNameApi.suggestAiNames([{
      candidateKey: aiKey,
      canonicalTitle: candidate.canonicalTitle,
      publisher: candidate.publisher,
      productType: candidate.productType,
    }]);
    const displayNameZhCn = response.suggestions.find((entry) => entry.candidateKey === aiKey)?.displayNameZhCn;
    if (nameSuggestionGeneration.current !== generation || displayNameZhCn === null || displayNameZhCn === undefined) return;
    const key = candidateKey(candidate);
    setWizard((current) => current.selectedCandidateKeys[0] !== key || current.chineseNameDrafts[key] !== undefined
      ? current
      : setChineseNameDraft(current, key, displayNameZhCn));
  } catch (error) {
    if (nameSuggestionGeneration.current === generation) setNotice(error instanceof GameNameApiError ? error.message : "AI 中文名称建议暂时无法读取，请手动填写。");
  }
  finally { if (nameSuggestionGeneration.current === generation) setIsAiNameSuggestionLoading(false); }
}
```

将 `handleRetryRegions` 与首次核验都改为只在 `resolveRegions` 成功后、只传当前唯一候选调用上述函数。候选区文案改为“点击选择一项”，计数改为“已选择 1 项”或“尚未选择”。第三步在加载期间渲染 `role="status"` 的“正在生成 AI 中文名称建议”，不禁用手工名称输入和地区操作。

- [ ] **Step 4: 运行 GREEN**

Run: `npm test -- --config vitest.dom.config.mts test/subscription-wizard-page.test.tsx`

Expected: PASS，选择不外发 AI；每次成功核验至多一次；加载、预填、人工优先和失败降级均通过。

- [ ] **Step 5: 暂存与提交准备（仅在用户确认后）**

```bash
git add src/app/subscription-wizard-page.tsx test/subscription-wizard-page.test.tsx
git commit -m "fix: request AI names after regional verification"
```

不要在未取得用户明确提交确认时执行此步。

### Task 3: 强化 DeepSeek 翻译提示词与产品文档

**Files:**
- Modify: `src/services/deepseek-game-name-suggestion-service.ts:59-105`
- Modify: `test/deepseek-game-name-suggestion-service.test.ts`
- Modify: `docs/requirements/PRD.md`
- Modify: `docs/architecture/api-design.md`

**Interfaces:**
- Keeps: `suggest(candidates): Promise<AiGameNameSuggestion[]>`、固定官方 URL、10 秒超时与 low/null 降级。
- Produces: 明确要求常用简体中文名、保留版本后缀且无需虚构官方确认的系统提示词。

- [ ] **Step 1: 写失败的适配器合同测试**

```ts
it("requests common simplified Chinese names while preserving Nintendo Switch 2 Edition suffixes", async () => {
  const request = vi.fn(async () => jsonResponse({
    choices: [{ message: { content: JSON.stringify({ suggestions: [{
      candidateKey: "candidate-1",
      displayNameZhCn: "潜水员戴夫 Nintendo Switch 2 Edition",
      confidence: "medium",
    }] }) } }],
  }));
  const suggestions = await service.suggest([{ candidateKey: "candidate-1", canonicalTitle: "DAVE THE DIVER Nintendo Switch 2 Edition", publisher: "Mintrocket", productType: "game" }]);

  expect(readSystemPrompt(request)).toContain("常用简体中文名称");
  expect(readSystemPrompt(request)).toContain("Nintendo Switch 2 Edition");
  expect(suggestions).toEqual([{ candidateKey: "candidate-1", displayNameZhCn: "潜水员戴夫 Nintendo Switch 2 Edition", confidence: "medium" }]);
});
```

- [ ] **Step 2: 运行 RED**

Run: `npm test -- test/deepseek-game-name-suggestion-service.test.ts`

Expected: FAIL，因为现有系统提示词不要求保留版本后缀或将已知名称作为建议返回。

- [ ] **Step 3: 修改固定系统提示词和文档**

```ts
content: "为已确认的任天堂商品给出常用简体中文名称建议。已知或可合理翻译的名称应返回文本；保留本体、DLC、升级包、季票、合集以及 Nintendo Switch 2 Edition 等版本后缀。只有确实无法判断时返回 null；不得声称官方确认、编造来源或返回 JSON 之外的文字。"
```

同步 PRD 与 API 文档：官方候选单选、AI 只在核验成功后请求、建议草稿待管理员确认、`null` 保留手工路径。保留固定端点、字段白名单、认证和不落库承诺。

- [ ] **Step 4: 运行 GREEN 与回归**

Run: `npm test -- test/deepseek-game-name-suggestion-service.test.ts`

Run: `npm test -- --config vitest.dom.config.mts test/subscription-wizard-page.test.tsx`

Run: `npx tsc --noEmit`

Expected: PASS，提示词合同、服务解码、向导交互及类型均通过。

- [ ] **Step 5: 暂存与提交准备（仅在用户确认后）**

```bash
git add src/services/deepseek-game-name-suggestion-service.ts test/deepseek-game-name-suggestion-service.test.ts docs/requirements/PRD.md docs/architecture/api-design.md
git commit -m "fix: improve AI Chinese name suggestions"
```

不要在未取得用户明确提交确认时执行此步。

## 完成交付验证

- [ ] 运行 `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npm test`，确认所有核心、DOM 与 PostgreSQL 回归通过。
- [ ] 运行 `npm run build`、`npx tsc --noEmit` 与 `git diff --check`。
- [ ] 人工核对：搜索/单选不调用 AI；成功核验才有一次请求；加载文案、`null` 提示、AI 预填和人工覆写均符合规格。
- [ ] 向用户说明待提交文件范围并取得明确确认后，再提交并推送。
