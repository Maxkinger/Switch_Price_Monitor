# DeepSeek 设置页加密配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员在设置页安全配置并持久化 DeepSeek API Key、模型和官方 API 地址，服务重启后仍可生成待确认的中文名称建议。

**Architecture:** 用 PostgreSQL 单例表保存 AES-256-GCM 加密的完整配置载荷，Node 进程的 `AI_CREDENTIAL_ENCRYPTION_KEY` 仅作为解密主密钥。设置页使用专用同源接口读写非秘密摘要；DeepSeek 建议服务按请求解密瞬时配置，配置删除、篡改或主密钥缺失时安全降级而不影响手工名称流程。

**Tech Stack:** Node.js 22 `node:crypto`、TypeScript、PostgreSQL 17、React、Vitest、现有 Node Fetch 路由与 PostgreSQL 迁移框架。

## Global Constraints

- `AI_CREDENTIAL_ENCRYPTION_KEY` 只来自 Node 私有环境；必须是解码后 32 字节的随机 Base64 值，不得写入 PostgreSQL、浏览器、日志、测试夹具、错误响应、镜像或 Git。
- DeepSeek API Key、模型、API 地址必须同包 AES-256-GCM 加密持久化；每次写入生成新 12 字节 nonce，算法版本固定为 `1`。
- 设置页/API 从不返回、掩码或复用 API Key；修改模型或地址也必须重新提交完整 Key。
- API 地址只能是精确 `https://api.deepseek.com`；拒绝 HTTP、路径、端口、用户名密码、查询参数、片段和非官方域名，服务端固定请求 `/chat/completions` 且 `redirect: "error"`。
- 模型为修剪后 1–128 个非控制字符；Key 为 1–512 个非控制字符；解密、篡改、未知版本、主密钥缺失或配置缺失都不得泄漏原因或调用外部 API。
- AI 仍只生成浏览器待确认草稿：不能自动保存游戏、词条、订阅、回填或影响官方身份、价格与地区裁决。
- 本机旁路仅在 `LOCAL_DEVELOPMENT_AUTH_BYPASS=true` 且 Node 已绑定 `127.0.0.1` 时适用；其他环境必须真实管理员会话。
- 所有代码、SQL、配置和测试的新增/修改均有准确详细中文注释；采用测试先行；不能修改用户已有 `docs/README.md` 或 `docs/HANDOFF.md`。
- 提交前必须先获得用户对完整范围的明确确认；确认后在同一操作提交并推送。

---

## 文件结构与职责

| 文件 | 职责 |
| --- | --- |
| `migrations/postgres/0005_ai_provider_configuration.sql` | 创建仅存密文的 AI 配置单例；`0004_simplified_chinese_game_names.sql` 是不可变历史，不能复用编号。 |
| `src/repositories/ports.ts`、`src/repositories/postgres/ai-provider-configuration-repository.ts` | 定义并实现密文的窄读写端口。 |
| `src/services/ai-provider-configuration-service.ts` | 校验、AES-GCM 加解密、摘要读取、删除与固定不可用状态。 |
| `src/server/config.ts` | 仅解析可选的 32 字节 Base64 主密钥，移除旧 DeepSeek 环境配置。 |
| `src/routes/ai-provider-settings-routes.ts` | 提供认证后的配置摘要、保存和清除 HTTP 合同。 |
| `src/services/deepseek-game-name-suggestion-service.ts` | 改为按建议请求读取瞬时解密配置，不在启动时持有 Key。 |
| `src/server/dependencies.ts` | 装配密文仓储、加密服务、设置路由和动态 AI 建议服务。 |
| `src/app/settings-api-client.ts`、`src/app/settings-page.tsx` | 设置页专用 DTO、保存/清除操作和不回显 Key 的 UI。 |
| `test/*ai-provider*`、既有设置/DeepSeek/迁移测试 | 覆盖迁移、加密、路由、客户端、DOM 和 AI 回归。 |

### Task 1: 密文迁移、仓储端口与 AES-GCM 配置服务

**Files:**
- Create: `migrations/postgres/0005_ai_provider_configuration.sql`
- Modify: `src/repositories/ports.ts`
- Create: `src/repositories/postgres/ai-provider-configuration-repository.ts`
- Create: `src/services/ai-provider-configuration-service.ts`
- Create: `test/ai-provider-configuration-service.test.ts`
- Create: `test/postgres-ai-provider-configuration-repository.test.ts`
- Modify: `test/postgres-migrations.test.ts`
- Modify: `test/postgres-backup-restore.test.mjs`

**Interfaces:**

```ts
export type EncryptedAiProviderConfiguration = {
  algorithmVersion: 1;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  updatedAt: string;
};

export type AiProviderConfigurationSummary = {
  configured: boolean;
  model: string | null;
  apiBaseUrl: string | null;
};

export type AiProviderCredentials = {
  apiKey: string;
  model: string;
  apiBaseUrl: "https://api.deepseek.com";
};

export interface AiProviderConfigurationStore {
  getEncrypted(): Promise<EncryptedAiProviderConfiguration | null>;
  saveEncrypted(value: EncryptedAiProviderConfiguration): Promise<void>;
  clear(): Promise<void>;
}
```

`AiProviderConfigurationService` 构造参数为 `AiProviderConfigurationStore`、可选 `Uint8Array` 主密钥和可注入随机字节函数；暴露 `getSummary()`、`save(input, updatedAt)`、`clear()` 与 `getCredentials()`。`getCredentials()` 在配置不存在或不可解密时返回 `null`，绝不抛出原始 crypto 异常。

- [ ] **Step 1: 写失败的迁移、仓储和加密服务测试**

```ts
it("每次保存使用不同 nonce，数据库值不含 Key、模型或地址明文", async () => {
  const store = new InMemoryAiProviderConfigurationStore();
  const service = new AiProviderConfigurationService(store, masterKeyBytes, deterministicRandom);
  await service.save(validInput("first-key"), "2026-08-11T00:00:00.000Z");
  const first = await store.getEncrypted();
  await service.save(validInput("second-key"), "2026-08-11T00:01:00.000Z");
  const second = await store.getEncrypted();
  expect(new TextDecoder().decode(second!.ciphertext)).not.toContain("second-key");
  expect([...second!.nonce]).not.toEqual([...first!.nonce]);
  await expect(service.getCredentials()).resolves.toEqual(validInput("second-key"));
});

it("篡改密文、未知版本或缺失主密钥只返回未配置摘要", async () => {
  const service = new AiProviderConfigurationService(tamperedStore, undefined);
  await expect(service.getSummary()).resolves.toEqual({ configured: false, model: null, apiBaseUrl: null });
  await expect(service.getCredentials()).resolves.toBeNull();
});
```

新增真实 PostgreSQL 断言：迁移创建只有 `id=1` 的表、`ciphertext`/`nonce` 为 `bytea`、`saveEncrypted` 为参数化 UPSERT、`clear` 删除行；备份恢复测试的迁移账本必须在既有 `0004_simplified_chinese_game_names.sql` 之后包含 `0005_ai_provider_configuration.sql`。

- [ ] **Step 2: 运行 RED**

Run: `npm test -- test/ai-provider-configuration-service.test.ts test/postgres-ai-provider-configuration-repository.test.ts test/postgres-migrations.test.ts`

Expected: FAIL，因为迁移、端口、仓储与加密服务均不存在。

- [ ] **Step 3: 实现最小迁移、仓储与服务**

```sql
-- 加密载荷单例不保存任何明文供应商字段；主密钥始终停留在 Node 运行环境。
CREATE TABLE ai_provider_configuration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  algorithm_version SMALLINT NOT NULL CHECK (algorithm_version = 1),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 16),
  updated_at TIMESTAMPTZ NOT NULL
);
```

```ts
const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final(), cipher.getAuthTag()]);
// 解密前先检查 version/nonce 长度；任何失败都只返回 null，不能把 crypto 错误交给路由或日志。
```

实现必须先验证 Key、模型、精确地址和 C0/C1 字符，再加密；解密后再次验证，防止旧密文绕过当前限制。摘要只能由成功解密的非秘密 `model`、`apiBaseUrl` 构成。

- [ ] **Step 4: 运行 GREEN**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npm test -- test/ai-provider-configuration-service.test.ts test/postgres-ai-provider-configuration-repository.test.ts test/postgres-migrations.test.ts`

Expected: PASS，真实迁移、密文 UPSERT/删除、随机 nonce、篡改降级和明文隔离均通过。

### Task 2: 主密钥配置、认证设置 API 与动态 DeepSeek 读取

**Files:**
- Modify: `src/server/config.ts`
- Modify: `src/server/dependencies.ts`
- Modify: `src/services/deepseek-game-name-suggestion-service.ts`
- Create: `src/routes/ai-provider-settings-routes.ts`
- Modify: `src/routes/game-name-routes.ts`
- Modify: `test/server-config.test.ts`
- Modify: `test/api-settings.test.ts`
- Modify: `test/api-game-names.test.ts`
- Modify: `test/server-http.test.ts`
- Modify: `test/deepseek-game-name-suggestion-service.test.ts`

**Interfaces:**

```ts
export interface ServerConfig {
  // 删除 deepSeekApiKey/deepSeekModel；仅保留可选主密钥字节。
  aiCredentialEncryptionKey?: Uint8Array;
}

export interface AiProviderConfigurationReader {
  getCredentials(): Promise<AiProviderCredentials | null>;
}

export class AiProviderNotConfiguredError extends Error {}

export async function handleAiProviderSettingsRoute(
  request: Request,
  sessions: SessionReader,
  service: AiProviderConfigurationService,
): Promise<Response | null>;
```

`DeepSeekGameNameSuggestionService` 构造参数改为 `AiProviderConfigurationReader` 与可注入 fetch。`suggest(candidates)` 首先读取凭据；若为 `null` 抛出 `AiProviderNotConfiguredError`，否则仅向 `credentials.apiBaseUrl + "/chat/completions"` 发送请求。

- [ ] **Step 1: 写失败的配置、HTTP 和动态建议测试**

```ts
it("主密钥必须是 Base64 解码后恰好 32 字节，旧 DeepSeek 环境变量不再启用 AI", () => {
  expect(readServerConfig(baseEnvironment({ AI_CREDENTIAL_ENCRYPTION_KEY: base64Key }))).toMatchObject({ aiCredentialEncryptionKey: expect.any(Uint8Array) });
  expect(() => readServerConfig(baseEnvironment({ AI_CREDENTIAL_ENCRYPTION_KEY: "bad" }))).toThrow("AI_CREDENTIAL_ENCRYPTION_KEY_INVALID");
  expect(readServerConfig(baseEnvironment({ DEEPSEEK_API_KEY: "legacy" }))).not.toHaveProperty("deepSeekApiKey");
});

it("设置接口不回显 Key，保存后建议无需重启即可读取配置", async () => {
  const saved = await request("PUT", { apiKey: "test-key", model: "deepseek-chat", apiBaseUrl: "https://api.deepseek.com" });
  expect(await saved.json()).toEqual({ configured: true, model: "deepseek-chat", apiBaseUrl: "https://api.deepseek.com" });
  expect(JSON.stringify(await request("GET").then((r) => r.json()))).not.toContain("test-key");
  await expect(aiService.suggest([candidate("batch-1")])).resolves.toHaveLength(1);
});

it("非法官方地址为 422，配置不存在为 AI_NOT_CONFIGURED，删除后不调用 fetch", async () => {
  await expect(request("PUT", { apiKey: "test-key", model: "model", apiBaseUrl: "https://evil.test" })).resolves.toMatchObject({ status: 422 });
  await expect(requestAi()).resolves.toMatchObject({ status: 503 });
  await request("DELETE");
  expect(fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行 RED**

Run: `npm test -- test/server-config.test.ts test/api-settings.test.ts test/api-game-names.test.ts test/server-http.test.ts test/deepseek-game-name-suggestion-service.test.ts`

Expected: FAIL，因为主密钥、专用设置路由和动态配置读取尚不存在。

- [ ] **Step 3: 实现最小配置、路由与依赖装配**

```ts
if (request.method === "GET") return Response.json(await service.getSummary());
if (request.method === "PUT") {
  await service.save(readAiProviderInput(await readJson(request)), new Date().toISOString());
  return Response.json(await service.getSummary());
}
if (request.method === "DELETE") {
  await service.clear();
  return new Response(null, { status: 204 });
}
```

专用路由精确匹配 `/api/settings/ai-provider`，先认证再读取正文；认证/旁路规则与设置页一致。`ServerConfig` 只读取 `AI_CREDENTIAL_ENCRYPTION_KEY`，以 `Buffer.from(value, "base64")` 解码并严格确认 32 字节；删除 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 的解析、Compose 注入和依赖装配分支。`createServerDependencies` 始终创建动态建议服务，但只有加密服务能成功解密配置时才会外发请求。

在名称建议路由中把 `AiProviderNotConfiguredError` 映射为既有固定 `503 AI_NOT_CONFIGURED`；网络/超时/非 2xx 的 `AiGameNameSuggestionError` 继续是 `503 AI_UNAVAILABLE`。不得让设置 API、建议 API 或普通日志获得明文 Key。

- [ ] **Step 4: 运行 GREEN**

Run: `npm test -- test/server-config.test.ts test/api-settings.test.ts test/api-game-names.test.ts test/server-http.test.ts test/deepseek-game-name-suggestion-service.test.ts`

Expected: PASS，密钥读取、认证、422、GET 脱敏、DELETE 204、无需重启生效、删除后零外发与现有 AI 错误分类均正确。

### Task 3: 设置页 API 客户端与加密配置卡片

**Files:**
- Modify: `src/app/settings-api-client.ts`
- Modify: `src/app/settings-page.tsx`
- Modify: `src/app/styles.css`
- Modify: `test/settings-api-client.test.ts`
- Modify: `test/settings-page.test.tsx`

**Interfaces:**

```ts
export type AiProviderConfigurationSummary = {
  configured: boolean;
  model: string | null;
  apiBaseUrl: string | null;
};

export type AiProviderConfigurationInput = {
  apiKey: string;
  model: string;
  apiBaseUrl: string;
};

export interface SettingsApiClient {
  getAiProviderConfiguration(): Promise<AiProviderConfigurationSummary>;
  saveAiProviderConfiguration(input: AiProviderConfigurationInput): Promise<AiProviderConfigurationSummary>;
  clearAiProviderConfiguration(): Promise<void>;
}
```

- [ ] **Step 1: 写失败的客户端和 DOM 测试**

```tsx
it("保存配置后只显示状态、模型和官方地址，从不回显 Key", async () => {
  render(<SettingsPage api={configuredApi} onUnauthorized={vi.fn()} />);
  await user.type(screen.getByLabelText("DeepSeek API Key"), "secret-key");
  await user.type(screen.getByLabelText("DeepSeek 模型"), "deepseek-chat");
  await user.click(screen.getByRole("button", { name: "保存 DeepSeek 配置" }));
  expect(await screen.findByText("DeepSeek 已配置")).toBeTruthy();
  expect(screen.queryByDisplayValue("secret-key")).toBeNull();
  expect(configuredApi.saveAiProviderConfiguration).toHaveBeenCalledWith({ apiKey: "secret-key", model: "deepseek-chat", apiBaseUrl: "https://api.deepseek.com" });
});

it("清除必须确认，成功后仅禁用 AI 配置并保留公开设置草稿", async () => {
  render(<SettingsPage api={configuredApi} onUnauthorized={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "清除 DeepSeek 配置" }));
  await user.click(screen.getByRole("button", { name: "确认清除" }));
  expect(configuredApi.clearAiProviderConfiguration).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("DeepSeek 未配置")).toBeTruthy();
  expect(screen.getByLabelText("默认搜索区")).toBeTruthy();
});
```

客户端测试必须断言三个专用请求使用同源路径、`credentials: "same-origin"`，DELETE 无请求体，非成功响应只保留服务端安全摘要；任何成功 DTO 都不包含 `apiKey`。

- [ ] **Step 2: 运行 RED**

Run: `npm test -- test/settings-api-client.test.ts`

Run: `npm run test:dom -- --run test/settings-page.test.tsx`

Expected: FAIL，因为客户端缺少专用方法且页面没有 AI 配置卡片。

- [ ] **Step 3: 实现最小 UI 与状态隔离**

在 `SettingsPage` 中独立维护 `aiConfiguration`、`aiKeyDraft`、`aiModelDraft`、`aiApiBaseUrlDraft`、`isSavingAiConfiguration` 和 `isConfirmingClear`。挂载时并行读取公开设置与 AI 摘要；Key 草稿只存在 React 内存、保存成功或 401 时立即清空，不能进入 LocalStorage、URL、全局 `AppSettings` 或普通设置 PATCH。

```tsx
<fieldset className="settings-card" aria-labelledby="deepseek-configuration-title">
  <legend id="deepseek-configuration-title">DeepSeek AI 配置</legend>
  <p>{aiConfiguration.configured ? "DeepSeek 已配置；重新输入 Key 可替换配置。" : "DeepSeek 未配置；中文名称仍可手工填写。"}</p>
  <label className="settings-field">DeepSeek API Key<input type="password" autoComplete="new-password" value={aiKeyDraft} onChange={...} /></label>
  <label className="settings-field">DeepSeek 模型<input value={aiModelDraft} onChange={...} /></label>
  <label className="settings-field">DeepSeek API 地址<input value={aiApiBaseUrlDraft} onChange={...} /></label>
  <button type="button" onClick={...}>保存 DeepSeek 配置</button>
</fieldset>
```

清除使用页面内确认态，不使用浏览器 `confirm`，便于 DOM 无障碍测试。该卡片的加载/错误不会禁用公开设置表单；401 仍调用 `onUnauthorized`，其他错误保留 Key 以便管理员修正或重试，但错误文本不可包含输入值。

- [ ] **Step 4: 运行 GREEN**

Run: `npm test -- test/settings-api-client.test.ts`

Run: `npm run test:dom -- --run test/settings-page.test.tsx`

Expected: PASS，保存/刷新摘要、Key 不回显、替换需重新输入 Key、确认清除、401 与 422/503 UI 边界均正确。

### Task 4: 删除旧环境配置、部署资产与完整回归

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.prod.yml`
- Modify: `test/docker-config.test.mjs`
- Modify: `docs/requirements/PRD.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/architecture/data-model.md`
- Modify: `docs/deployment/synology-ds423-plus.md`
- Modify: `docs/superpowers/specs/2026-08-10-deepseek-chinese-name-suggestions-design.md`
- Modify: `docs/superpowers/specs/2026-08-11-deepseek-ui-encrypted-configuration-design.md`（仅发现必须修正的事实时）

- [ ] **Step 1: 写失败的部署合同测试**

```js
it("生产 app 只接收 AI 加密主密钥，不接收旧 DeepSeek Key 或模型环境变量", async () => {
  const compose = await readCompose();
  expect(compose.services.app.environment.AI_CREDENTIAL_ENCRYPTION_KEY).toBe("${AI_CREDENTIAL_ENCRYPTION_KEY:-}");
  expect(compose.services.app.environment).not.toHaveProperty("DEEPSEEK_API_KEY");
  expect(compose.services.app.environment).not.toHaveProperty("DEEPSEEK_MODEL");
});
```

- [ ] **Step 2: 运行 RED**

Run: `npm run test:docker-config`

Expected: FAIL，因为 Compose 与 `.env.example` 仍含旧的 DeepSeek 环境变量。

- [ ] **Step 3: 同步配置、文档和注释**

`.env.example` 只保留空 `AI_CREDENTIAL_ENCRYPTION_KEY=`，中文注释说明通过 `openssl rand -base64 32` 生成、必须私有保存且丢失后只能清除/重配；不再出现 DeepSeek Key、模型或地址。生产 Compose 只向 `app` 注入主密钥，不能注入 PostgreSQL。PRD、API、数据模型、NAS 文档和旧 DeepSeek 规格应明确：设置页配置是加密持久化、官方地址固定校验、Key 永不回显、AI 只作草稿；不得以此授权 NAS/公网部署或恢复生产认证。

- [ ] **Step 4: 运行全量验证与秘密扫描**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npm test`

Run: `npm run test:dom -- --run`

Run: `npm run test:docker-config`

Run: `npm run test:github-actions`

Run: `npx tsc --noEmit`

Run: `npm run build`

Run: `git diff --check`

Run: `rg -n 'DEEPSEEK_API_KEY|DEEPSEEK_MODEL|AI_CREDENTIAL_ENCRYPTION_KEY|secret-key|BEGIN.*KEY' src test dist docs .env.example docker-compose.prod.yml`

Expected: 全部测试通过；扫描只允许主密钥变量名在服务器配置/部署说明中出现，不能出现实际值、旧 Key/模型配置路径、浏览器 DTO、快照、错误响应或日志。

- [ ] **Step 5: 提交前请求用户确认**

向用户说明待提交范围：AI 配置迁移、加密服务/主密钥、认证设置 API、动态 DeepSeek 读取、设置页卡片、迁移/HTTP/DOM/Compose 测试和文档；明确排除 `docs/README.md`、`docs/HANDOFF.md` 与任何真实秘密。收到确认后，仅暂存这些文件，提交并推送：

```bash
git add migrations/postgres/0005_ai_provider_configuration.sql src test docs .env.example docker-compose.prod.yml
git commit -m "feat: configure DeepSeek securely from settings"
git push
```

## 计划自查

- Task 1 覆盖密文 schema、随机 nonce、加密/篡改/删除和迁移账本。
- Task 2 覆盖主密钥、认证 API、动态生效与既有 AI 建议错误语义。
- Task 3 覆盖设置页安全输入、Key 不回显、替换和清除的人机边界。
- Task 4 覆盖旧环境来源移除、Compose 秘密边界、文档与全量门禁。
- 每一项规格要求均有实现和测试任务；没有任意第三方地址、Key 回显、自动保存、生产认证恢复或 NAS 部署范围漂移。
