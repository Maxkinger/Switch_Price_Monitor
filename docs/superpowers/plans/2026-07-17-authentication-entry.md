# 初始化与登录入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为单管理员站点实现首次设置、恢复码确认、登录与密码恢复入口，使成功认证后直接可用现有添加订阅向导。

**Architecture:** 新建同源认证 API 客户端和无 React 依赖的认证状态机，分别负责受控网络边界与可测试的敏感状态转换。将现有订阅向导从根组件拆为独立页面组件，根组件仅负责在 `loading/setup/recovery-code/login/recover/authenticated` 六种状态间组合认证界面与已存在的向导；浏览器从不读取会话 Cookie，也不持久化密码或恢复码。

**Tech Stack:** TypeScript strict、React 19、Vite、Cloudflare Workers、Cloudflare D1、Vitest 4。

## Global Constraints

- 每次代码、测试、配置或文档改动前完整阅读 `AGENTS.md` 与 `docs/README.md`。
- 所有新增或修改的源代码、测试、SQL 与配置必须带中文详细注释，说明认证、价格来源与安全边界。
- 先写失败测试，确认失败后写最小实现；每个任务完成后运行列出的回归测试。
- 认证请求只调用同源 `/api/auth/*`，必须使用 `credentials: "same-origin"`；不得读取、拼接、保存或记录会话 Cookie。
- 密码、确认密码、恢复码和一次性恢复码只能存在 React 内存状态；不得写入 URL、localStorage、sessionStorage、日志、测试快照或文档样例。
- 首次设置至少选择一个支持地区，默认搜索区必须属于已选地区；最终规则仍以 Worker `POST /api/auth/initialize` 为准。
- 初始化成功后先显示一次性恢复码确认页；管理员确认已保存后，使用同一次表单的内存密码调用登录并直接进入添加订阅向导。
- 恢复密码成功后不自动登录；Worker 已撤销所有会话，页面必须回到登录页。
- 任一受保护请求返回 `401` 必须清除向导内存状态并回到登录页；不得保留先前商品、地区映射、来源预览或恢复码。
- 任何本地提交与 GitHub 推送前都必须取得用户明确确认，并在确认后立即推送。

---

## 文件结构

- `src/app/auth-api-client.ts`：认证接口的同源 JSON 请求、受控错误和 DTO。
- `src/app/auth-flow.ts`：无 React 依赖的认证状态、地区/默认区约束与敏感值清除规则。
- `src/app/auth-screens.tsx`：暖色首次设置、恢复码确认、登录、恢复密码屏幕；只通过回调交付表单值。
- `src/app/subscription-wizard-page.tsx`：从根组件移出的已认证订阅向导，保持候选卡与跨区确认行为。
- `src/app/App.tsx`：认证壳层和页面切换；不再包含候选卡布局细节。
- `src/app/styles.css`：认证页表单、地区选择和窄屏样式，复用当前暖色变量。
- `test/auth-api-client.test.ts`：同源请求、Cookie 策略与受控错误测试。
- `test/auth-flow.test.ts`：认证状态机、默认区约束、敏感值清除和 `401` 回退测试。
- `docs/requirements/traceability.md`、`docs/quality/quality-and-acceptance.md`：同步认证 UI 的实现状态与验收范围。

### Task 1: 建立认证 API 客户端与纯状态机

**Files:**
- Create: `src/app/auth-api-client.ts`
- Create: `src/app/auth-flow.ts`
- Create: `test/auth-api-client.test.ts`
- Create: `test/auth-flow.test.ts`

**Interfaces:**
- Produces `InitializeAuthInput`：`password`、`enabledRegions`、`defaultSearchRegion`；`RecoverAuthInput`：`recoveryCode`、`password`；两者只用作调用时的内存 DTO。
- Produces `AuthApiError(message: string, status: number)`：只保留可展示安全摘要和 HTTP 状态，不保留请求或响应原文。
- Produces `AuthApiClient`：`getStatus(): Promise<{ initialized: boolean }>`、`initialize(input: InitializeAuthInput): Promise<{ recoveryCode: string }>`、`login(password: string): Promise<void>`、`recover(input: RecoverAuthInput): Promise<void>`、`logout(): Promise<void>`。
- Produces `AuthFlowState`：`screen`、`enabledRegions`、`defaultSearchRegion`、`recoveryCode`、`setupPassword`、`notice`。
- Produces `initializeAuthFlow()`、`toggleEnabledRegion()`、`setDefaultSearchRegion()`、`showRecoveryCode()`、`completeRecoveryCode()`、`completeAuthentication()`、`requireLogin()`。

- [ ] **Step 1: 先写认证客户端与状态机的失败测试**

```ts
it("sends initialization only to the same-origin API with administrator cookie policy", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ recoveryCode: "ABCDE-12345" }, { status: 201 }));
  const client = createAuthApiClient(request);

  await expect(client.initialize({ password: "1234567890abcdef", enabledRegions: ["US", "HK"], defaultSearchRegion: "US" }))
    .resolves.toEqual({ recoveryCode: "ABCDE-12345" });
  expect(request).toHaveBeenCalledWith("/api/auth/initialize", expect.objectContaining({
    method: "POST", credentials: "same-origin", body: JSON.stringify({ password: "1234567890abcdef", enabledRegions: ["US", "HK"], defaultSearchRegion: "US" }),
  }));
});

it("moves the default region when the selected default region is disabled", () => {
  const withTwoRegions = { ...initializeAuthFlow(), enabledRegions: ["US", "HK"] as RegionCode[], defaultSearchRegion: "US" as RegionCode };
  const selected = setDefaultSearchRegion(withTwoRegions, "HK");
  expect(toggleEnabledRegion(selected, "HK")).toMatchObject({ enabledRegions: ["US"], defaultSearchRegion: "US" });
});

it("drops recovery code, setup password and prior UI notice when a protected request requires login", () => {
  const state = showRecoveryCode({ ...initializeAuthFlow(), setupPassword: "1234567890abcdef" }, "ABCDE-12345");
  expect(requireLogin({ ...state, notice: "旧提示" })).toEqual(expect.objectContaining({ screen: "login", recoveryCode: null, setupPassword: null, notice: null }));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/auth-api-client.test.ts test/auth-flow.test.ts`  
Expected: FAIL，因为认证客户端与认证状态机尚不存在。

- [ ] **Step 3: 实现同源认证客户端和受控状态转换**

```ts
export type AuthScreen = "loading" | "setup" | "recovery-code" | "login" | "recover" | "authenticated";

export interface AuthFlowState {
  screen: AuthScreen;
  enabledRegions: RegionCode[];
  defaultSearchRegion: RegionCode | null;
  setupPassword: string | null;
  recoveryCode: string | null;
  notice: string | null;
}

export function toggleEnabledRegion(state: AuthFlowState, regionCode: RegionCode): AuthFlowState {
  const enabledRegions = state.enabledRegions.includes(regionCode)
    ? state.enabledRegions.filter((item) => item !== regionCode)
    : [...state.enabledRegions, regionCode];
  const defaultSearchRegion = enabledRegions.includes(state.defaultSearchRegion as RegionCode)
    ? state.defaultSearchRegion
    : enabledRegions[0] ?? null;
  return { ...state, enabledRegions, defaultSearchRegion };
}

export function requireLogin(state: AuthFlowState): AuthFlowState {
  return { ...state, screen: "login", recoveryCode: null, setupPassword: null, notice: null };
}

/** 恢复码已确认且登录成功后，必须在进入受保护向导前释放表单密码和一次性恢复码。 */
export function completeAuthentication(state: AuthFlowState): AuthFlowState {
  return { ...state, screen: "authenticated", recoveryCode: null, setupPassword: null, notice: null };
}
```

`createAuthApiClient` 必须有一个私有 `requestJson`，对 `GET /api/auth/status` 和各 POST 端点固定 `credentials: "same-origin"`。仅在 `initialize` 返回的 201 JSON 中读取恢复码；`login` 只确认成功状态，永远不解析或暴露 Cookie；`recover` 和 `logout` 接收 204。任何非成功响应只读取 `{ error?: string }` 并抛出 `AuthApiError(message, response.status)`，不回显请求正文或响应原文。

- [ ] **Step 4: 运行认证前端逻辑回归测试**

Run: `npm test -- --run test/auth-api-client.test.ts test/auth-flow.test.ts test/api-client.test.ts test/subscription-wizard.test.ts`  
Expected: PASS；认证和商品客户端都只访问同源受保护接口，地区默认值与敏感状态转换稳定。

- [ ] **Step 5: 提交认证边界与状态机**

```bash
git add src/app/auth-api-client.ts src/app/auth-flow.ts test/auth-api-client.test.ts test/auth-flow.test.ts
git commit -m "feat: add authentication entry state"
git push origin agent/d1-price-history
```

### Task 2: 组合认证界面与现有订阅向导

**Files:**
- Create: `src/app/auth-screens.tsx`
- Create: `src/app/subscription-wizard-page.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/styles.css`

**Interfaces:**
- Consumes `AuthApiClient`、`AuthFlowState`、`SubscriptionWizardState` 和既有商品 API 客户端。
- Produces `AuthScreens` 回调：`onInitialize`、`onAcknowledgeRecoveryCode`、`onLogin`、`onRecover`、`onShowRecovery`、`onReturnToLogin`。
- Produces `SubscriptionWizardPage`，在收到 `onUnauthorized` 后不渲染此前向导状态。

- [ ] **Step 1: 先为根组件认证编排写失败测试**

```ts
it("returns to login and drops the existing wizard state when a protected product request returns 401", () => {
  const authenticated = { ...initializeAuthFlow(), screen: "authenticated" as const };
  const next = requireLogin(authenticated);
  expect(next.screen).toBe("login");
  expect(next.recoveryCode).toBeNull();
  expect(next.setupPassword).toBeNull();
});

it("keeps a generated recovery code only until acknowledgement and then requests login", () => {
  const codeShown = showRecoveryCode({ ...initializeAuthFlow(), setupPassword: "1234567890abcdef" }, "ABCDE-12345");
  expect(completeRecoveryCode(codeShown)).toEqual(expect.objectContaining({ screen: "loading", recoveryCode: null }));
});

it("enters the protected page only after login and clears the setup password", () => {
  const recoveryAcknowledged = completeRecoveryCode(showRecoveryCode({ ...initializeAuthFlow(), setupPassword: "1234567890abcdef" }, "ABCDE-12345"));
  expect(completeAuthentication(recoveryAcknowledged)).toEqual(expect.objectContaining({ screen: "authenticated", setupPassword: null, recoveryCode: null }));
});
```

将上述案例追加至 `test/auth-flow.test.ts`，并让 `completeRecoveryCode` 返回仅含内存 `setupPassword` 的短暂加载状态；登录成功或失败后必须清除该密码。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/auth-flow.test.ts`  
Expected: FAIL，因为恢复码确认后的自动登录转换尚未定义。

- [ ] **Step 3: 实现认证屏幕与根组件编排**

```tsx
export function App() {
  const [auth, setAuth] = useState(initializeAuthFlow);
  const [wizardKey, setWizardKey] = useState(0);

  useEffect(() => {
    void authApi.getStatus().then(({ initialized }) => setAuth((state) => ({ ...state, screen: initialized ? "login" : "setup" })))
      .catch(() => setAuth((state) => ({ ...state, screen: "login", notice: "认证状态暂时无法获取，请稍后重试。" })));
  }, []);

  function handleUnauthorized() {
    setWizardKey((value) => value + 1);
    setAuth((state) => requireLogin(state));
  }

  if (auth.screen !== "authenticated") return <AuthScreens state={auth} /* 认证回调 */ />;
  return <SubscriptionWizardPage key={wizardKey} onUnauthorized={handleUnauthorized} />;
}
```

`auth-screens.tsx` 的每个表单使用受控输入和显式 `<label>`。首次设置先在内存中检查两次密码一致、至少一个地区和默认区非空，再调用初始化；成功时通过 `showRecoveryCode` 保存恢复码与设置密码。恢复码确认按钮调用登录，成功时通过 `completeAuthentication` 清空密码和恢复码并切换 `authenticated`；失败时调用 `requireLogin` 并显示安全摘要。恢复成功后强制 `requireLogin`，绝不自动登录。

若初始化返回 `AuthApiError` 且 `status === 409`，根组件重新调用 `getStatus()` 并切换为登录页，避免另一窗口已完成初始化时继续展示过期设置表单；`429` 与其他错误保留当前表单并显示 `error.message`。所有初始化、登录和恢复请求开始时把对应提交按钮设为禁用，结束后恢复，避免重复写入或触发多次登录。

将当前 `App.tsx` 中的候选卡、跨区确认、来源预览和批量确认组件移至 `subscription-wizard-page.tsx`，保持现有商品请求、候选卡多选和 `401` 处理外壳不变。商品 API 客户端在收到 401 时抛出带 `status` 的 `ProductApiError`，向导捕获后调用 `onUnauthorized`；其他错误仍显示当前中文提示。

`styles.css` 新增 `.auth-page`、`.auth-card`、`.region-checkbox-grid`、`.recovery-code`、`.auth-actions`，并在 `max-width: 560px` 下单列化。继续使用现有暖色变量、输入焦点样式和按钮类，恢复码采用可复制但不自动复制的等宽文本框，避免无意写入剪贴板。

- [ ] **Step 4: 运行逻辑、类型与生产构建验证**

Run: `npm test -- --run test/auth-flow.test.ts test/auth-api-client.test.ts test/api-client.test.ts test/subscription-wizard.test.ts && npx tsc --noEmit && npm run build`  
Expected: PASS；根组件可编译，认证后的订阅向导仍使用现有候选卡实现。

- [ ] **Step 5: 浏览器验证登录前渲染与窄屏布局**

Run: 使用 Browser 插件打开本地 Vite 页面。  
Expected: 页面不白屏；未初始化时显示地区和默认搜索区控件；已初始化但未认证时显示登录页；手机宽度下表单单列，控制台无应用错误。需要真实 D1 初始化的交互用本地 Worker 测试环境验证，不能把测试密码或恢复码提交到仓库。

- [ ] **Step 6: 提交认证界面**

```bash
git add src/app/App.tsx src/app/auth-screens.tsx src/app/subscription-wizard-page.tsx src/app/styles.css src/app/api-client.ts test/auth-flow.test.ts
git commit -m "feat: add administrator authentication UI"
git push origin agent/d1-price-history
```

### Task 3: 同步文档并执行完整质量门禁

**Files:**
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/plans/2026-07-17-authentication-entry.md`

**Interfaces:**
- Documents the one-time recovery-code display, post-initialization auto-login, recovery-to-login return, and `401` state clearing rules.

- [ ] **Step 1: 更新需求状态与认证 UI 验收规则**

在 `traceability.md` 的 `FR-006` 中记录首次设置、登录和恢复密码前端入口已实现；在质量文档列出密码不持久化、恢复码仅一次展示、初始化后进入订阅、`401` 清空向导状态和手机表单单列等验收项；在文档中心加入本计划并标注实施状态。

- [ ] **Step 2: 运行完整验证和敏感信息检查**

Run: `npm test -- --run && npx tsc --noEmit && npm run build && rg -n "TODO|TBD|localStorage|sessionStorage|recoveryCode|password" src/app test docs/superpowers/specs/2026-07-17-authentication-entry-design.md && git diff --check`  
Expected: 全部测试通过、生产构建完成；出现 `password` 或 `recoveryCode` 的位置只限受控内存状态、接口字段、测试夹具或安全设计说明，不存在浏览器持久化写入、真实凭据或待办占位。

- [ ] **Step 3: 标记计划完成并提交文档**

将本计划全部复选框更新为 `[x]`，在标题后写明最终测试、构建和浏览器验证结果。随后执行：

```bash
git add docs/requirements/traceability.md docs/quality/quality-and-acceptance.md docs/README.md docs/superpowers/plans/2026-07-17-authentication-entry.md
git commit -m "docs: document authentication entry UI"
git push origin agent/d1-price-history
```

## 计划自检

- **规格覆盖：**任务 1 覆盖同源认证请求、地区默认值与敏感内存状态；任务 2 覆盖首次设置、恢复码确认自动登录、登录、恢复密码、401 回退、暖色响应式界面与现有向导隔离；任务 3 覆盖需求状态、验收和全量质量门禁。
- **无占位检查：**计划不含 `TODO`、`TBD`、未定义接口或“适当处理”等泛化步骤；每项代码改动均指定路径、接口、测试和命令。
- **类型一致性：**`AuthFlowState`、`AuthScreen` 与状态函数均由任务 1 产出，任务 2 仅消费这些名称；`SubscriptionWizardPage.onUnauthorized` 是唯一由认证壳层消费的未授权回调。
