# 公开偏好设置页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为已登录管理员提供可读取、编辑并一次保存公开偏好的 `/settings` 页面。

**Architecture:** 新建同源设置客户端和无 React 依赖的设置草稿状态模块，分别约束网络边界与地区/默认区联动。设置页只复用既有 `GET/PATCH /api/settings`，应用外壳扩展一个 History API 路由；不新增 Worker 路由、D1 迁移或任何秘密配置。

**Tech Stack:** TypeScript strict、React 19、Vite、Cloudflare Workers、Cloudflare D1、Vitest 4。

## Global Constraints

- 每次代码、测试、配置或文档改动前完整阅读 `AGENTS.md` 与 `docs/README.md`。
- 所有新增或修改的源代码、测试、SQL 与配置必须含中文详细注释，并与实现保持一致。
- 必须测试先行：先运行新增失败测试，再实现最小代码并运行对应回归测试。
- 设置请求只允许同源 `/api/settings`，强制 `credentials: "same-origin"`；浏览器不得读取、保存、拼接或记录 Cookie。
- 本阶段只允许 `AppSettings` 的公开字段：`enabledRegions`、`defaultSearchRegion`、`theme`、`timezone`、`dailyReportTime`、`taxState`、`priceHistoryRetention`。`createdAt`、密码、恢复码、Telegram 和第三方价格来源不得进入草稿、页面或请求体。
- 默认搜索区必须属于启用地区；前端保持该联动以减少无效提交，Worker `PATCH /api/settings` 仍是最终校验边界。
- 主题本阶段只保存偏好，不得暗示样式已经切换；Telegram 与第三方来源保持未接入。
- 每次创建 Git 提交前向用户说明精确范围并获得明确确认；确认后同一操作完成 `git commit` 与 `git push origin main`。

---

## 文件结构

- `src/app/settings-api-client.ts`：同源 `GET/PATCH /api/settings`、公开 DTO 和安全错误。
- `src/app/settings-form.ts`：无 React 依赖的设置草稿、地区切换、默认区联动和 PATCH 构造。
- `src/app/settings-page-state.ts`：设置请求失败时的草稿保留与安全登出状态转换。
- `src/app/settings-page.tsx`：三组受控表单、读取、一次保存、成功与安全错误显示。
- `src/app/app-navigation.ts`：增加 `/settings` 路由和路径生成函数。
- `src/app/app-shell.tsx`：把侧栏设置入口改为真实导航，并装配设置页面。
- `src/app/styles.css`：设置页卡片、复选框网格、分组和窄屏布局。
- `test/settings-api-client.test.ts`：同源请求与受控错误测试。
- `test/settings-form.test.ts`：纯草稿联动和公开 PATCH 测试。
- `test/app-navigation.test.ts`：设置地址解析与未知路径回退测试。
- `docs/README.md`、`docs/requirements/traceability.md`、`docs/architecture/api-design.md`：实施结果、入口和接口使用边界。

### Task 1: 设置客户端与纯草稿状态

**Files:**
- Create: `src/app/settings-api-client.ts`
- Create: `src/app/settings-form.ts`
- Create: `test/settings-api-client.test.ts`
- Create: `test/settings-form.test.ts`

**Interfaces:**
- Produces `SettingsApiError(message: string, status: number)`，仅含 Worker 安全文案和状态码。
- Produces `SettingsApiClient`：`getSettings(): Promise<AppSettings>`、`saveSettings(patch: PublicSettingsPatch): Promise<AppSettings>`。
- Produces `SettingsFormState`、`createSettingsForm(settings)`、`toggleSettingsRegion(state, regionCode)`、`setSettingsDefaultRegion(state, regionCode)`、`toPublicSettingsPatch(state)`。

- [x] **Step 1: 写入失败测试**

```ts
it("keeps the final enabled region and moves the default region when it is disabled", () => {
  const initial = createSettingsForm(settings({ enabledRegions: ["US", "JP"], defaultSearchRegion: "US" }));
  const afterDefaultDisabled = toggleSettingsRegion(initial, "US");
  expect(afterDefaultDisabled).toMatchObject({ enabledRegions: ["JP"], defaultSearchRegion: "JP" });
  expect(toggleSettingsRegion(afterDefaultDisabled, "JP")).toEqual(afterDefaultDisabled);
});

it("builds a public settings PATCH without createdAt or secret fields", () => {
  const patch = toPublicSettingsPatch(createSettingsForm(settings()));
  expect(patch).toEqual(expect.objectContaining({ enabledRegions: expect.any(Array), dailyReportTime: "09:00" }));
  expect(patch).not.toHaveProperty("createdAt");
  expect(JSON.stringify(patch)).not.toContain("Telegram");
});

it("uses same-origin credentials for settings reads and writes", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(settings()));
  const client = createSettingsApiClient(request);
  await client.getSettings();
  await client.saveSettings(toPublicSettingsPatch(createSettingsForm(settings())));
  expect(request).toHaveBeenNthCalledWith(1, "/api/settings", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  expect(request).toHaveBeenNthCalledWith(2, "/api/settings", expect.objectContaining({ method: "PATCH", credentials: "same-origin" }));
});

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { enabledRegions: ["US", "JP"], defaultSearchRegion: "US", theme: "warm-card", timezone: "Asia/Shanghai", dailyReportTime: "09:00", taxState: "OR", priceHistoryRetention: "forever", createdAt: "2026-07-17T00:00:00.000Z", ...overrides };
}
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/settings-form.test.ts test/settings-api-client.test.ts`  
Expected: FAIL，因为设置草稿模块和同源客户端尚不存在。

- [x] **Step 3: 实现受控客户端与地区联动**

```ts
export type PublicSettingsPatch = Omit<AppSettings, "createdAt">;

export interface SettingsFormState extends PublicSettingsPatch {}

export function toggleSettingsRegion(state: SettingsFormState, regionCode: RegionCode): SettingsFormState {
  if (state.enabledRegions.length === 1 && state.enabledRegions[0] === regionCode) return state;
  const enabledRegions = state.enabledRegions.includes(regionCode)
    ? state.enabledRegions.filter((item) => item !== regionCode)
    : [...state.enabledRegions, regionCode];
  return {
    ...state,
    enabledRegions,
    defaultSearchRegion: enabledRegions.includes(state.defaultSearchRegion) ? state.defaultSearchRegion : enabledRegions[0],
  };
}
```

`createSettingsApiClient` 内部使用固定路径的 `requestJson`。请求指定 `credentials: "same-origin"`；成功时只转换为 `AppSettings`，失败时仅从 `{ error?: string }` 建立 `SettingsApiError`。草稿转换函数必须显式逐字段构造对象，不能用扩展运算符传入 `createdAt` 或未来敏感字段。

- [x] **Step 4: 运行客户端与状态回归**

Run: `npm test -- --run test/settings-form.test.ts test/settings-api-client.test.ts test/api-settings.test.ts && npx tsc --noEmit`  
Expected: PASS；客户端不跨域、草稿不带秘密，前端联动与 Worker 设置约束一致。

- [x] **Step 5: 等待用户确认后提交并推送 Task 1**

拟提交范围：`src/app/settings-api-client.ts`、`src/app/settings-form.ts`、两项对应测试。确认后执行 `git add ... && git commit -m "feat: add public settings state" && git push origin main`。

### Task 2: 设置路由、页面与响应式界面

**Files:**
- Create: `src/app/settings-page.tsx`
- Create: `src/app/settings-page-state.ts`
- Modify: `src/app/app-navigation.ts`
- Modify: `src/app/app-shell.tsx`
- Modify: `src/app/styles.css`
- Modify: `test/app-navigation.test.ts`
- Create: `test/settings-page-state.test.ts`

**Interfaces:**
- Consumes `SettingsApiClient` 与 `SettingsFormState`。
- Produces `settingsPath(): "/settings"` 和 `{ kind: "settings" }` 路由。
- Produces `SettingsPage({ api, onUnauthorized })`，其中 `api` 只需 `getSettings` 与 `saveSettings`。
- Produces `applySettingsRequestFailure(state, error)`；`401` 返回无草稿的 `unauthorized`，其他状态保留草稿与安全文案。

- [x] **Step 1: 写入失败测试**

```ts
it("maps the settings URL and keeps unknown paths on the dashboard", () => {
  expect(readAppRoute("/settings")).toEqual({ kind: "settings" });
  expect(settingsPath()).toBe("/settings");
  expect(readAppRoute("/settings/telegram")).toEqual({ kind: "dashboard" });
});

it("keeps the public settings draft after a 422 and drops it after a 401", () => {
  const draft = createSettingsForm(settings({ dailyReportTime: "25:99" }));
  expect(applySettingsRequestFailure(draft, new SettingsApiError("日报时间无效。", 422))).toMatchObject({ kind: "ready", draft });
  expect(applySettingsRequestFailure(draft, new SettingsApiError("请先登录。", 401))).toEqual({ kind: "unauthorized" });
});

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { enabledRegions: ["US", "JP"], defaultSearchRegion: "US", theme: "warm-card", timezone: "Asia/Shanghai", dailyReportTime: "09:00", taxState: "OR", priceHistoryRetention: "forever", createdAt: "2026-07-17T00:00:00.000Z", ...overrides };
}
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- --run test/app-navigation.test.ts test/settings-page-state.test.ts`  
Expected: FAIL，因为 `/settings` 路由和设置页面错误状态尚未定义。

- [x] **Step 3: 实现页面、导航与错误状态**

`app-navigation.ts` 增加 `| { kind: "settings" }`、`settingsPath()` 和精确 `/settings` 分支。`AppShell` 将“设置（即将提供）”替换为按钮，并在 `route.kind === "settings"` 时渲染 `SettingsPage`；“价格历史”保持非交互占位。

`settings-page.tsx` 使用单一 `<form>`，载入完成后依次显示：

```tsx
<fieldset>
  <legend>地区与搜索</legend>
  {regionChoices.map((region) => <label key={region.code}><input type="checkbox" /* 受控地区状态 */ />{region.name}</label>)}
  <label>默认搜索区<select /* 仅使用 draft.enabledRegions */ /></label>
</fieldset>
<fieldset><legend>展示与日报</legend>{/* theme、timezone、HH:mm、两位州代码 */}</fieldset>
<fieldset><legend>数据保留</legend>{/* forever / one-year / two-years 单选 */}</fieldset>
<button className="primary-button" type="submit" disabled={isSaving}>保存设置</button>
```

加载或保存发生 `401` 时调用 `onUnauthorized`，并丢弃草稿；`422` 保留输入并显示安全文案；成功时以 Worker 返回值重新创建草稿并显示“设置已保存”。页面不得渲染 Telegram、密钥、恢复码、第三方来源或主题已经生效的提示。

`styles.css` 使用 `.settings-page`、`.settings-card`、`.settings-grid`、`.settings-region-grid` 和 `.settings-actions`。宽屏两列布局，`max-width: 720px` 时改为单列；复选框和单选控件保留明确 `label` 与键盘焦点。

`settings-page-state.ts` 必须使 `401` 成为不携带草稿的独立分支，避免登录页后仍保留地区、税务州和日报设置等管理员私有信息；`422`、`409` 和其他安全错误保留原草稿，供页面继续编辑。

- [x] **Step 4: 运行路由、页面状态与类型检查**

Run: `npm test -- --run test/app-navigation.test.ts test/settings-page-state.test.ts test/settings-form.test.ts test/settings-api-client.test.ts && npx tsc --noEmit`  
Expected: PASS；导航可到达、401 不保留管理员设置、422 保留草稿，TypeScript 无错误。

- [x] **Step 5: 浏览器验收**

Run: 启动 `npm run dev -- --host 127.0.0.1`，在已登录 Chrome 打开 `/settings`。  
Expected: 三个分组可读；取消默认区会自动选中另一有效区；保存出现成功提示；在窄屏检查单列布局。不得输入真实 Telegram 凭据。

- [x] **Step 6: 等待用户确认后提交并推送 Task 2**

拟提交范围：设置页面、导航、样式、路由与页面状态测试。确认后执行 `git add ... && git commit -m "feat: add public settings page" && git push origin main`。

### Task 3: 同步项目文档与完成质量门禁

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/superpowers/plans/2026-07-17-public-settings-page.md`

**Interfaces:**
- 记录 `/settings` 只消费公开 `AppSettings` 字段；Telegram 与第三方来源仍不在设置 UI 范围内。

- [x] **Step 1: 更新实施状态与接口说明**

在文档中心加入本计划和规格；在 FR-001、FR-003、FR-005、FR-007 的实现状态中记录公开偏好设置页完成、Telegram 设置留待生产流程验收后；在 API 文档的 `GET/PATCH /api/settings` 行明确该页面只提交现有公开字段，秘密字段没有浏览器入口。

- [x] **Step 2: 运行完整质量门禁**

Run: `npm test -- --run && npx tsc --noEmit && npm run build && rg -n "TODO|TBD|localStorage|sessionStorage|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID" src/app test docs/superpowers/specs/2026-07-17-public-settings-page-design.md && git diff --check`  
Expected: 所有测试、类型检查和构建通过；搜索结果不显示前端持久化、真实 Telegram 凭据或未定义占位。

- [x] **Step 3: 等待用户确认后提交并推送 Task 3**

拟提交范围：文档状态、验收记录和已勾选的实施计划。确认后执行 `git add docs/... && git commit -m "docs: record public settings page" && git push origin main`。

## 计划自检

- **规格覆盖：**Task 1 覆盖公开字段、同源接口与地区联动；Task 2 覆盖 `/settings`、三组表单、一次保存、错误与响应式界面；Task 3 覆盖项目文档和全量验收。
- **无占位检查：**计划不依赖新 Worker 路由、D1 迁移、秘密存储、第三方抓取或 Telegram 发送；每个任务都有具体文件、接口、失败测试、通过命令和提交边界。
- **类型一致性：**`PublicSettingsPatch`、`SettingsApiClient` 和 `SettingsFormState` 由 Task 1 产出，Task 2 仅消费这些接口；`settingsPath` 与 `{ kind: "settings" }` 由 Task 2 同时定义和测试。
