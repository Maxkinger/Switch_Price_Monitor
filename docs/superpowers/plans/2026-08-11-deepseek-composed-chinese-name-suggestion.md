# DeepSeek 常用中文本体名与商品后缀组合建议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让单次 DeepSeek API 请求能够为 `Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack` 等“已知本体 + 商品后缀”标题返回可预填的常用简体中文组合名称。

**Architecture:** 保持现有核验后单次调用、白名单候选结构、固定官方端点和严格响应归一化不变，只强化服务端固定系统提示词。提示词明确要求先识别常用中文本体名、再组合完整商品后缀，并重新定义 `high/medium/low` 的使用条件；产品与 API 文档同步该语义。

**Tech Stack:** TypeScript、Node.js 22 Fetch、DeepSeek Chat Completions JSON Object、Vitest、React Testing Library。

## Global Constraints

- AI 只能在当前唯一候选成功完成“核验其他地区”或“重新核验”后调用一次；不增加重试、网页搜索或第二次模型调用。
- 请求仍只发送临时候选键、完整官方标题、可空发行商和商品类型；不得发送 URL、地区、价格、游戏/订阅 ID、Cookie 或数据库身份。
- `Nintendo Switch 2 Edition` 原样保留，`Upgrade Pack` 使用“升级包”；DLC、季票和合集使用常用简体中文商品表达。
- 缺少官方来源证明不能单独成为 `low/null` 的理由；结果始终是待管理员确认的草稿，不代表官方命名。
- 不放宽低置信度、重复键、控制字符、超长文本、畸形 JSON、超时和非成功 HTTP 的安全降级规则。
- 所有新增或修改的源代码和测试必须带有详细中文注释，并在同一改动中修正过期注释。
- 不提交 DeepSeek API Key、加密主密钥、会话或其他真实秘密。
- 每次创建提交前，根代理必须向用户说明精确范围并取得明确确认；确认后在同一操作中提交并推送。

---

### Task 1: 强化单次 DeepSeek 提示词合同

**Files:**
- Modify: `test/deepseek-game-name-suggestion-service.test.ts:34-66`
- Modify: `src/services/deepseek-game-name-suggestion-service.ts:86-101`

**Interfaces:**
- Consumes: `DeepSeekGameNameSuggestionService.suggest(candidates: AiGameNameCandidate[]): Promise<AiGameNameSuggestion[]>`。
- Keeps: `AiGameNameCandidate`、`AiGameNameSuggestion`、请求 URL、headers、10 秒超时、用户消息 JSON 与 `normalizeSuggestions` 均不变。
- Produces: 固定系统提示词合同，使已知中文本体名与明确商品后缀输出 `high` 或 `medium` 建议。

- [ ] **Step 1: 写 Upgrade Pack 组合名称失败测试**

在 `test/deepseek-game-name-suggestion-service.test.ts` 的首个提示词合同用例之后加入：

```ts
it("先识别常用中文本体名再组合升级包后缀，并把已知组合判为可预填建议", async () => {
  // 该标题的本体与商品后缀均明确；若提示词仍把“没有官方来源证明”理解为低置信度，页面会错误得到 null 而无法预填。
  const request = vi.fn<typeof globalThis.fetch>().mockResolvedValue(modelResponse(JSON.stringify({ suggestions: [{
    candidateKey: "upgrade-pack-1",
    displayNameZhCn: "胡闹厨房！2 - Nintendo Switch 2 Edition 升级包",
    confidence: "high",
  }] })));
  const service = new DeepSeekGameNameSuggestionService(configuredReader(), request);

  await expect(service.suggest([{
    candidateKey: "upgrade-pack-1",
    canonicalTitle: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "game",
  }])).resolves.toEqual([{
    candidateKey: "upgrade-pack-1",
    displayNameZhCn: "胡闹厨房！2 - Nintendo Switch 2 Edition 升级包",
    confidence: "high",
  }]);

  const systemPrompt = readSystemPrompt(request);
  expect(systemPrompt).toContain("先识别");
  expect(systemPrompt).toContain("游戏本体");
  expect(systemPrompt).toContain("Upgrade Pack");
  expect(systemPrompt).toContain("升级包");
  expect(systemPrompt).toContain("缺少官方来源证明不能作为 low 或 null 的理由");
  expect(systemPrompt).toContain("Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack");
  expect(systemPrompt).toContain("胡闹厨房！2 - Nintendo Switch 2 Edition 升级包");
  expect(systemPrompt).toContain("DAVE THE DIVER Nintendo Switch 2 Edition");
  expect(systemPrompt).toContain("潜水员戴夫 Nintendo Switch 2 Edition");
});
```

- [ ] **Step 2: 运行 RED 并确认失败原因**

Run:

```bash
npm test -- test/deepseek-game-name-suggestion-service.test.ts
```

Expected: 新用例在 `systemPrompt` 断言处 FAIL；现有提示词不包含“先识别游戏本体”、官方来源置信度口径或完整 Upgrade Pack 示例。响应归一化断言应继续通过，证明失败只来自提示词合同。

- [ ] **Step 3: 用一个固定系统提示词完成最小 GREEN**

将 `src/services/deepseek-game-name-suggestion-service.ts` 的系统消息改为下面的单一固定字符串，并同步上方中文注释，说明置信度衡量的是“常用译名组合可用性”而非官方来源证明：

```ts
content: "你是任天堂商品的简体中文名称建议器。对每个候选先识别 canonicalTitle 中的游戏本体，并使用其常用简体中文译名；再组合版本和商品后缀，不能删除版本信息或改变商品类型。Nintendo Switch 2 Edition 原样保留；Upgrade Pack 译为“升级包”；DLC、季票、合集等使用常用简体中文商品表达。缺少官方来源证明不能作为 low 或 null 的理由，因为结果只供管理员确认。本体译名已知且后缀明确时 confidence 为 high；合理译名存在差异时为 medium；只有本体确实无法可靠识别或翻译时才返回 displayNameZhCn:null 与 confidence:\"low\"。示例：DAVE THE DIVER Nintendo Switch 2 Edition → 潜水员戴夫 Nintendo Switch 2 Edition；Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack → 胡闹厨房！2 - Nintendo Switch 2 Edition 升级包。只返回 JSON 对象，成功格式示例为 {\"suggestions\":[{\"candidateKey\":\"原输入键\",\"displayNameZhCn\":\"中文名称\",\"confidence\":\"high\"}]}；无法识别时 displayNameZhCn 必须为 JSON null 且 confidence 必须为 \"low\"；confidence 只允许 \"high\"、\"medium\"、\"low\"。不得添加解释、来源、Markdown、编造事实或输入之外的候选键。",
```

不得修改用户消息字段映射、`response_format`、模型名、端点、超时或响应归一化函数。

- [ ] **Step 4: 运行服务 GREEN 与安全回归**

Run:

```bash
npm test -- test/deepseek-game-name-suggestion-service.test.ts test/api-game-names.test.ts test/server-config.test.ts
```

Expected: 全部 PASS；Upgrade Pack 与 DAVE THE DIVER 合同非空，白名单、固定端点、动态加密配置、`low/null`、重复键、控制字符、超长名称和脱敏错误测试保持通过。

- [ ] **Step 5: 检查注释、差异与提交边界**

Run:

```bash
git diff --check
git diff -- src/services/deepseek-game-name-suggestion-service.ts test/deepseek-game-name-suggestion-service.test.ts
```

Expected: 无格式错误；生产差异只修改固定提示词及准确中文注释，测试差异只新增 Upgrade Pack 合同。此时不提交，等待 Task 2 文档同步后统一请求一次提交授权。

### Task 2: 同步产品/API 合同并完成全量验收

**Files:**
- Modify: `docs/requirements/PRD.md:30`
- Modify: `docs/architecture/api-design.md:61`
- Verify: `test/subscription-wizard-page.test.tsx`
- Verify: `test/deepseek-game-name-suggestion-service.test.ts`

**Interfaces:**
- Consumes: Task 1 的固定提示词合同与既有 `POST /api/game-names/ai-suggestions` 响应形态。
- Produces: 文档化的“常用中文本体名 + 完整商品后缀”组合建议规则，以及完整回归证据。

- [ ] **Step 1: 更新 PRD 的名称建议业务规则**

在 `docs/requirements/PRD.md` FR-001 的 AI 名称段落中，将现有“AI 只应给出常用简体中文名称”扩展为以下明确合同：

```markdown
AI 应先识别官方标题中的游戏本体并使用常用简体中文译名，再组合完整版本与商品后缀；`Nintendo Switch 2 Edition` 原样保留，`Upgrade Pack` 使用“升级包”，DLC、季票与合集使用常用简体中文商品表达。缺少官方来源证明不能单独成为 `low` 或 `null` 的理由，因为建议始终由管理员确认；只有本体确实无法可靠识别或翻译时才返回 `null`。
```

保留同一段中的单选、核验后触发、零重试、零网页搜索、零自动保存与服务端官方身份复核规则。

- [ ] **Step 2: 更新 API 设计的提示词与降级边界**

在 `docs/architecture/api-design.md` 的 `POST /api/game-names/ai-suggestions` 说明中加入：

```markdown
固定提示词先识别常用简体中文本体名，再组合版本与商品后缀，并用固定示例约束 `Nintendo Switch 2 Edition` 与 `Upgrade Pack`；本体已知且后缀明确时应返回 `high`，合理译名存在差异时返回 `medium`。缺少官方来源证明不触发低置信度降级，但返回值仍不代表官方确认。
```

不得删除字段长度、控制字符、重复键、10 秒超时、固定官方地址、拒绝重定向、脱敏错误、`low/null` 安全降级或不记录供应商正文的现有合同。

- [ ] **Step 3: 运行向导时机与异步隔离回归**

Run:

```bash
npm test -- --config vitest.dom.config.mts test/subscription-wizard-page.test.tsx
```

Expected: 19/19 PASS；搜索、选择和编辑不调用 AI，成功核验一次只发一次请求，管理员草稿优先，切换候选、连续核验和迟到目录/AI 响应保持隔离。

- [ ] **Step 4: 运行完整测试**

Run:

```bash
TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npm test
```

Expected: 完整 Vitest 退出 0。若本机测试 PostgreSQL 未启动，先按现有 macOS 开发文档启动 `docker-compose.dev.yml` 的 `postgres` 服务，再原样重跑完整测试，不得把缺少数据库误记为功能失败。

- [ ] **Step 5: 运行类型检查**

Run:

```bash
npx tsc --noEmit
```

Expected: 退出 0 且无 TypeScript 诊断。

- [ ] **Step 6: 运行生产构建与格式检查**

Run:

```bash
npm run build
git diff --check
```

Expected: 客户端 Vite 与服务端 tsup 构建退出 0；差异无尾随空格。

- [ ] **Step 7: 人工核对最终范围与秘密扫描**

Run:

```bash
git status --short
git diff -- src/services/deepseek-game-name-suggestion-service.ts test/deepseek-game-name-suggestion-service.test.ts docs/requirements/PRD.md docs/architecture/api-design.md
rg -n "sk-|AI_CREDENTIAL_ENCRYPTION_KEY='[^']+'|Bearer [A-Za-z0-9]" src test docs
```

Expected: 功能范围只有服务提示词、服务合同测试和两份对应文档；扫描不得发现真实 Key、主密钥或 Authorization 值。仓库原有示例/占位符若命中，必须核对为非秘密后在报告中说明，不能删除无关文档。

- [ ] **Step 8: 请求用户确认后提交并推送**

根代理向用户说明拟提交范围：

- `src/services/deepseek-game-name-suggestion-service.ts`
- `test/deepseek-game-name-suggestion-service.test.ts`
- `docs/requirements/PRD.md`
- `docs/architecture/api-design.md`
- 本实施计划文档

取得明确确认后，在同一操作链中执行：

```bash
git add src/services/deepseek-game-name-suggestion-service.ts test/deepseek-game-name-suggestion-service.test.ts docs/requirements/PRD.md docs/architecture/api-design.md docs/superpowers/plans/2026-08-11-deepseek-composed-chinese-name-suggestion.md
git commit -m "fix: improve composed Chinese name suggestions"
git push origin codex/deepseek-chinese-name-suggestions
```

Expected: 提交成功且远程 `codex/deepseek-chinese-name-suggestions` 指向新提交；不得只提交不推送，也不得暂存主工作树中的用户文档。
