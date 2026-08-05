# 网络代理设置实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 NAS Node.js 运行时的设置页提供无认证 HTTP、HTTPS、SOCKS5 代理，使全部外部 HTTP 与 Playwright 请求优先走代理，并在安全边界内直连回退。

**执行状态（2026-08-05）：** Task 1 与 Task 2 的代码和测试已完成并通过本地质量门禁，等待管理员确认后与文档一同提交、推送；Task 2 已用回环 HTTP/SOCKS5 夹具验证真实成功路径，HTTPS 代理的真实 TLS 证书链保留给容器/NAS 验收，Task 3 尚未开始。

**Architecture:** 在 PostgreSQL 设置单例中保存代理开关、协议、主机与端口，由集中式 `OutboundNetworkService` 为任天堂、汇率、第三方来源与 Telegram 提供统一 Fetch 风格传输；Playwright 使用同一配置快照创建浏览器代理。设置 API 继续原子保存完整公开设置，并增加固定目标的 HTTP/浏览器连接测试；当前 Cloudflare Worker 不实现代理兼容层。

**Tech Stack:** Node.js 22、TypeScript 5.8+、React 19、Vite 7、Vitest 4、PostgreSQL 17、Playwright Chromium、`node-fetch` 3、`http-proxy-agent` 7、`https-proxy-agent` 7、`socks-proxy-agent` 8、Docker Compose。

## Global Constraints

- 执行前必须完整阅读根目录 `AGENTS.md`、`docs/README.md` 和设计规格 `docs/superpowers/specs/2026-08-01-network-proxy-settings-design.md`。
- 本计划依赖 `docs/superpowers/plans/2026-07-27-nas-docker-postgresql-migration.md` 的 Task 1–7；必须在该计划 Task 7 完成后、Task 8 开始前执行。
- 功能只进入 NAS Node.js 目标运行时；不得修改当前 Cloudflare Worker、D1 迁移、Wrangler 或生产部署来实现临时代理。
- 代理协议只允许无认证 `http`、`https`、`socks5`；页面、API、数据库、连接器和日志均不得创建或接受代理用户名、密码、认证 URL 或密文字段。
- 代理覆盖任天堂搜索/商品/价格、汇率、已准入第三方来源、Telegram 和 Playwright；代理路径不得替换业务价格来源。
- 代理失败后幂等读取最多直连一次；目标已返回 HTTP 响应时不回退。Telegram 仅在无副作用 HEAD 预检失败时改为直连发送，实际代理发送结果不明时不立即重发。
- Playwright 代理失败时必须先关闭页面、上下文和代理浏览器，再顺序启动一次直连浏览器；两者不得同时存在或共享状态。
- 测试连接只允许代码固定的 `https://www.nintendo.com/robots.txt` 与 `https://store-jp.nintendo.com/robots.txt`，请求体不得提供任意 URL、方法或请求头。
- 所有新增或修改的源代码、测试、SQL、构建与运行配置必须有中文详细注释，说明职责、数据约束、边界条件与安全或业务原因；每次验证包含注释与实现一致性检查。
- 每个功能改动严格执行 RED → GREEN → REFACTOR；没有观察到预期失败前不得写实现。
- 每个任务创建提交前必须报告精确范围并取得用户明确确认；确认后在同一操作执行 `git commit` 与 `git push`，不得只创建本地提交。
- 禁止在测试、日志、截图、命令、文档或仓库中使用真实代理地址、Telegram 凭据、管理员秘密、Cookie 或会话令牌。

## Planned File Structure

```text
src/
  shared/
    proxy-settings.ts                         # 前后端共享的代理类型、默认值与纯校验
  server/
    network/
      outbound-network.ts                    # 配置快照、代理优先和直连回退
      proxy-agent-factory.ts                 # Node Fetch 与三种无认证 Agent
      proxy-errors.ts                        # 仅含安全类别的传输错误
  services/
    proxy-connection-test-service.ts         # 固定 HTTP/浏览器测试与进程内互斥
  providers/
    playwright/
      browser-launcher.ts                    # 将代理设置映射为 Chromium 启动选项
      japanese-upgrade-browser.ts            # 代理失败后清理并从当前项直连续跑
  routes/
    settings-routes.ts                       # 公开代理字段与测试端点
  app/
    settings-form.ts                         # 代理草稿与白名单 PATCH
    settings-api-client.ts                   # 同源代理测试调用
    settings-page-state.ts                   # 保存/测试失败与认证失效状态转换
    settings-page.tsx                        # 网络代理卡片与两项三态结果
migrations/postgres/
  0002_proxy_settings.sql                    # 设置单例新增四个非认证代理字段
test/support/
  proxy-fixtures.ts                          # 本地目标、HTTP/HTTPS/SOCKS5 代理夹具
test/
  proxy-settings.test.ts
  outbound-network.test.ts
  proxy-agent-factory.test.ts
  proxy-provider-wiring.test.ts
  proxy-connection-test-service.test.ts
  api-settings-proxy.test.ts
  proxy-smoke.test.ts
  settings-page.test.tsx
```

迁移计划若已经以更窄文件名实现了等价职责，可沿用该路径，但不得把网络 Agent、设置路由、Playwright 生命周期和 React 表单合并进一个文件。

---

### Task 1: 扩展代理领域模型与 PostgreSQL 设置持久化

**Files:**
- Create: `src/shared/proxy-settings.ts`
- Create: `migrations/postgres/0002_proxy_settings.sql`
- Create: `test/proxy-settings.test.ts`
- Modify: `src/shared/domain.ts`
- Modify: `src/services/settings-service.ts`
- Modify: `src/repositories/postgres/settings-repository.ts`
- Modify: `test/settings-and-subscriptions.test.ts`
- Modify: `test/postgres-migrations.test.ts`

**Interfaces:**
- Consumes: `AppSettings`、`SettingsPatch`、`SqlExecutor`、PostgreSQL 迁移校验和机制。
- Produces:

```ts
export const proxyProtocols = ["http", "https", "socks5"] as const;
export type ProxyProtocol = (typeof proxyProtocols)[number];

export interface ProxySettings {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
}

export const defaultProxySettings: ProxySettings;
export function normalizeProxyHost(value: string): string | null;
export function validateProxySettings(value: ProxySettings): string | null;
```

`AppSettings` 增加 `proxy: ProxySettings`；首次初始化默认使用 `{ enabled: false, protocol: "http", host: "127.0.0.1", port: 7890 }`，默认关闭保证升级不会发起意外代理连接。

- [x] **Step 1: 写代理纯校验和默认值失败测试**

在 `test/proxy-settings.test.ts` 添加明确案例：

```ts
describe("proxy settings", () => {
  it("accepts disabled HTTP, HTTPS, and SOCKS5 settings with a normalized host", () => {
    // 关闭代理仍校验完整草稿，避免管理员稍后重新启用时绕过服务端约束。
    for (const protocol of ["http", "https", "socks5"] as const) {
      expect(validateProxySettings({ enabled: false, protocol, host: "127.0.0.1", port: 7890 })).toBeNull();
    }
  });

  it.each(["http://127.0.0.1", "user@proxy.test", "proxy.test/path", "proxy.test\\path", " proxy.test", "proxy.test\n"])(
    "rejects embedded URL or authentication syntax: %s",
    (host) => {
      // 主机字段不能携带 scheme、认证或路径，防止连接 URL 与日志边界被绕过。
      expect(normalizeProxyHost(host)).toBeNull();
    },
  );

  it.each([0, 65536, 1.5, Number.NaN])("rejects invalid port %s", (port) => {
    // TCP 端口只允许 1–65535 整数；浮点和 NaN 不得被数据库隐式截断。
    expect(validateProxySettings({ enabled: true, protocol: "http", host: "proxy.test", port })).toBe("代理端口无效。");
  });
});
```

- [x] **Step 2: 运行纯测试确认 RED**

Run:

```bash
npx vitest run test/proxy-settings.test.ts
```

Expected: FAIL，因为 `src/shared/proxy-settings.ts` 尚不存在。

- [x] **Step 3: 实现共享类型、默认值与浏览器兼容校验**

实现时不得依赖 `node:net`，因为该文件会进入 React 构建。核心形状：

```ts
/** 代理设置只描述无认证传输端点；任何账号、密码或完整 URL 都不属于共享模型。 */
export const proxyProtocols = ["http", "https", "socks5"] as const;

/** 默认端口只作为关闭状态草稿，不会在管理员启用前产生任何网络连接。 */
export const defaultProxySettings: ProxySettings = {
  enabled: false,
  protocol: "http",
  host: "127.0.0.1",
  port: 7890,
};

export function normalizeProxyHost(value: string): string | null {
  // 主机必须原样无空白，且不能包含 URL scheme、路径、查询、片段或认证分隔符。
  if (value !== value.trim() || value.length === 0 || /[\u0000-\u0020\u007f/@?#\\]/.test(value)) return null;
  const candidate = value.includes(":") ? `[${value}]` : value;
  try {
    const parsed = new URL(`http://${candidate}`);
    if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/") return null;
    // URL 解析器负责域名小写、国际化域名 ASCII 化和 IPv6 规范化；数据库只保存不带方括号的主机。
    return parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
  } catch {
    return null;
  }
}
```

`validateProxySettings` 必须逐项验证对象、协议枚举、规范化主机和整数端口，并返回固定中文摘要；不得返回输入值。

- [x] **Step 4: 写 PostgreSQL 迁移与仓储失败测试**

在迁移测试中断言：

```ts
it("adds only non-authenticated proxy columns", async () => {
  // 设置表只能新增开关、协议、主机和端口；认证字段会扩大秘密管理范围，首版必须不存在。
  const columns = await database.query<{ columnName: string }>(
    `SELECT column_name AS "columnName"
       FROM information_schema.columns
      WHERE table_name = 'settings'`,
  );
  expect(columns.rows.map((row) => row.columnName)).toEqual(expect.arrayContaining([
    "proxy_enabled", "proxy_protocol", "proxy_host", "proxy_port",
  ]));
  expect(columns.rows.map((row) => row.columnName).join(" ")).not.toMatch(/proxy_(user|password|credential|secret|cipher)/i);
});
```

在 `test/settings-and-subscriptions.test.ts` 增加首次初始化默认代理、完整往返、更新其他设置时保留代理、无效代理零写入四类断言。

- [x] **Step 5: 运行数据库测试确认 RED**

Run:

```bash
TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
  npx vitest run test/postgres-migrations.test.ts test/settings-and-subscriptions.test.ts
```

Expected: FAIL，因为 `0002_proxy_settings.sql` 与 PostgreSQL 仓储字段尚未实现。

- [x] **Step 6: 实现迁移、显式行模型和原子保存**

`migrations/postgres/0002_proxy_settings.sql` 使用：

```sql
-- 代理设置只保存无认证端点；默认关闭确保升级后不会在管理员确认前改变任何出站路径。
ALTER TABLE settings
  ADD COLUMN proxy_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN proxy_protocol TEXT NOT NULL DEFAULT 'http'
    CHECK (proxy_protocol IN ('http', 'https', 'socks5')),
  ADD COLUMN proxy_host TEXT NOT NULL DEFAULT '127.0.0.1',
  ADD COLUMN proxy_port INTEGER NOT NULL DEFAULT 7890
    CHECK (proxy_port BETWEEN 1 AND 65535);
```

PostgreSQL `SettingsRow`、显式 `SELECT`、`INSERT` 和 `UPDATE` 增加四列；不得改成 `SELECT *` 或动态列名。`SettingsService.update()` 合并 `patch.proxy ?? current.proxy` 后调用 `validateProxySettings`，任何错误在进入事务前抛出 `SettingsValidationError`。

- [x] **Step 7: 运行 Task 1 质量门禁**

Run:

```bash
TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
  npx vitest run test/proxy-settings.test.ts test/postgres-migrations.test.ts \
  test/settings-and-subscriptions.test.ts test/api-settings.test.ts
npx tsc --noEmit
git diff --check
rg -n 'proxy_(username|password|credential|secret|cipher)|SETTINGS_ENCRYPTION_KEY' src migrations test
```

Expected: 测试、类型和空白检查通过；最后扫描无匹配。人工复核所有新增/修改注释与实现一致。

- [ ] **Step 8: 请求确认后提交并推送**

报告迁移列、默认关闭行为、测试数量及无认证字段扫描结果。取得明确确认后在同一操作执行：

```bash
git add src/shared/proxy-settings.ts src/shared/domain.ts src/services/settings-service.ts \
  src/repositories/postgres/settings-repository.ts migrations/postgres/0002_proxy_settings.sql \
  test/proxy-settings.test.ts test/settings-and-subscriptions.test.ts test/postgres-migrations.test.ts
git commit -m "feat: persist unauthenticated proxy settings"
git push
```

---

### Task 2: 建立三协议出站网络层与安全直连回退

**Files:**
- Create: `src/server/network/proxy-errors.ts`
- Create: `src/server/network/proxy-agent-factory.ts`
- Create: `src/server/network/outbound-network.ts`
- Create: `test/support/proxy-fixtures.ts`
- Create: `test/proxy-agent-factory.test.ts`
- Create: `test/outbound-network.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `ProxySettings`、PostgreSQL 设置读取器、标准 `RequestInit`/`Response`。
- Produces:

```ts
export type TransportPath = "direct" | "proxy" | "direct-fallback";
export type ProxyFailureCategory =
  | "proxy-authentication-required"
  | "dns"
  | "connect-timeout"
  | "tls"
  | "connection"
  | "unknown-transport";

export interface OutboundResult {
  response: Response;
  path: TransportPath;
}

export interface ProxySettingsReader {
  readProxySettings(): Promise<ProxySettings>;
}

export interface OutboundNetworkSession {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  send(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface OutboundNetwork {
  snapshot(): Promise<OutboundNetworkSession>;
  probe(settings: ProxySettings, input: RequestInfo | URL, init?: RequestInit): Promise<OutboundResult>;
}

export function createOutboundNetwork(dependencies: {
  settings: ProxySettingsReader;
  directFetch?: typeof fetch;
  proxyFetch?: ProxyFetch;
}): OutboundNetwork;
```

`snapshot()` 在商品发现、一次采集轮次或一次 Telegram 投递开始时只读一次设置，并返回绑定不可变 `ProxySettings` 的会话。会话的 `fetch` 表示业务幂等读取，即使 HTTP 方法因 Algolia 查询为 POST 也可安全回退；`send` 表示 Telegram 等非幂等副作用，必须先做无副作用 HEAD 预检。

- [ ] **Step 1: 建立本地目标与代理夹具**

`test/support/proxy-fixtures.ts` 必须提供：

```ts
export interface RunningFixture {
  url: string;
  close(): Promise<void>;
}

export function startTargetFixture(): Promise<RunningFixture>;
export function startHttpProxyFixture(options?: { requireAuthentication?: boolean }): Promise<RunningFixture>;
export function startHttpsProxyFixture(): Promise<RunningFixture>;
export function startSocks5ProxyFixture(): Promise<RunningFixture>;
```

夹具全部绑定 `127.0.0.1` 随机端口。HTTP/HTTPS 夹具只实现测试所需的普通转发与 CONNECT；SOCKS5 夹具只实现无认证方法 `0x00`、域名/IPv4/IPv6 CONNECT 和双向管道。HTTPS 代理证书在测试临时目录用 `openssl` 生成并在结束时删除；不得提交私钥、证书或固定凭据。每个服务器的 `close()` 必须等待监听器和活动 socket 关闭，防止 Vitest 退出泄漏。

- [ ] **Step 2: 写 Agent 工厂失败测试**

覆盖：

```ts
it.each([
  ["http", "http:", "HttpProxyAgent"],
  ["http", "https:", "HttpsProxyAgent"],
  ["https", "http:", "HttpProxyAgent"],
  ["https", "https:", "HttpsProxyAgent"],
  ["socks5", "https:", "SocksProxyAgent"],
] as const)("builds a no-authentication %s agent for %s targets", (protocol, targetProtocol, expectedName) => {
  // HTTP(S) Agent 类型由目标协议决定，代理 URL 的 scheme 仍严格来自代理设置。
  const agent = createProxyAgent({ enabled: true, protocol, host: "127.0.0.1", port: 7890 }, targetProtocol);
  expect(agent.constructor.name).toBe(expectedName);
});
```

另外断言 SOCKS 内部 URL 使用 `socks5h:` 让代理端解析域名，HTTP 目标选择 `HttpProxyAgent`、HTTPS 目标选择 `HttpsProxyAgent`，`407` 转为 `proxy-authentication-required`，底层错误文本不会进入 `ProxyTransportError.message`。

- [ ] **Step 3: 运行 Agent 测试确认 RED**

Run:

```bash
npx vitest run test/proxy-agent-factory.test.ts
```

Expected: FAIL，因为网络模块和代理依赖尚不存在。

- [ ] **Step 4: 安装锁定主版本并实现 Proxy Fetch**

Run:

```bash
npm install node-fetch@3.3.2 http-proxy-agent@7.0.2 https-proxy-agent@7.0.6 socks-proxy-agent@8.0.5
```

`proxy-agent-factory.ts` 的核心实现：

```ts
/** 根据目标协议选择 Node Agent；代理 URL 只由已校验字段生成，不接受完整 URL 或认证信息。 */
export function createProxyAgent(settings: ProxySettings, targetProtocol: string): Agent {
  const host = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  const proxyUrl = `${settings.protocol === "socks5" ? "socks5h" : settings.protocol}://${host}:${settings.port}`;
  if (settings.protocol === "socks5") return new SocksProxyAgent(proxyUrl);
  return targetProtocol === "http:" ? new HttpProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
}

/** node-fetch 仅在该模块出现，提供方仍接收标准 Fetch 形状，避免 Agent 选项扩散到业务代码。 */
export const proxyFetch: ProxyFetch = async (settings, input, init) => {
  const target = readRequestUrl(input);
  const response = await nodeFetch(target, {
    ...(init as NodeFetchRequestInit),
    agent: createProxyAgent(settings, target.protocol),
  });
  return response as unknown as Response;
};
```

不得关闭 TLS 校验、设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或记录构造出的代理 URL。HTTPS 代理夹具通过仅测试注入的 CA/Agent 选项信任临时证书，生产工厂保持系统 CA 验证。

- [ ] **Step 5: 写出站回退失败测试**

明确覆盖：

```ts
it("falls back once for an idempotent provider request when the proxy cannot connect", async () => {
  // 商品读取即使使用 POST 也没有外部副作用，因此由调用方选择 fetch 语义并允许一次直连。
  const directFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
  const proxyFetch = vi.fn<ProxyFetch>().mockRejectedValue(new ProxyTransportError("connection"));
  const network = createOutboundNetwork({ settings: fixedSettings(enabledProxy()), directFetch, proxyFetch });
  const session = await network.snapshot();

  await expect(session.fetch("https://target.test/read", { method: "POST", body: "{}" })).resolves.toMatchObject({ ok: true });
  expect(proxyFetch).toHaveBeenCalledTimes(1);
  expect(directFetch).toHaveBeenCalledTimes(1);
});

it("does not direct-retry a non-idempotent send after the proxy preflight succeeded", async () => {
  // HEAD 只证明代理当前可达；真实 Telegram POST 一旦开始，失败结果可能已送达，不能再次直连发送。
  const proxyFetch = vi.fn<ProxyFetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockRejectedValueOnce(new ProxyTransportError("unknown-transport"));
  const directFetch = vi.fn<typeof fetch>();
  const network = createOutboundNetwork({ settings: fixedSettings(enabledProxy()), directFetch, proxyFetch });
  const session = await network.snapshot();

  await expect(session.send("https://api.telegram.test/send", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ProxyTransportError);
  expect(directFetch).not.toHaveBeenCalled();
});
```

同时测试：一次会话只读一次设置且后续保存不改变该会话；新会话读取新值；代理关闭直接请求；代理成功不直连；`407` 直连；目标 `404/500` 不直连；HEAD 预检失败后 Telegram 只直连发送一次；AbortSignal 已取消不直连；`probe()` 返回三种路径且不修改设置。

- [ ] **Step 6: 运行出站测试确认 RED**

Run:

```bash
npx vitest run test/outbound-network.test.ts
```

Expected: FAIL，因为 `createOutboundNetwork` 尚未实现。

- [ ] **Step 7: 实现配置快照、幂等回退和非幂等预检**

核心状态机：

```ts
async function requestIdempotent(
  proxy: Readonly<ProxySettings>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<OutboundResult> {
  if (!proxy.enabled) return { response: await directFetch(input, init), path: "direct" };
  try {
    return { response: await requestProxy(proxy, input, init), path: "proxy" };
  } catch (error) {
    // 调用方取消优先于回退，避免关机或超时后额外创建直连请求。
    if (init?.signal?.aborted) throw error;
    return { response: await directFetch(input, init), path: "direct-fallback" };
  }
}

async function sendNonIdempotent(
  proxy: Readonly<ProxySettings>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!proxy.enabled) return directFetch(input, init);
  const origin = new URL(readRequestUrl(input)).origin;
  try {
    // HEAD 不包含 Telegram Token 路径或消息体，只验证同一代理能否建立外部 HTTPS 连接。
    await requestProxy(proxy, `${origin}/`, { method: "HEAD", signal: init?.signal });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    return directFetch(input, init);
  }
  // 预检成功后的真实发送不再直连重试，防止结果不明时重复通知。
  return requestProxy(proxy, input, init);
}
```

`snapshot()` 必须逐字段复制并 `Object.freeze` 当前设置，再把同一对象闭包绑定到 `requestIdempotent` 与 `sendNonIdempotent`。`probe()` 使用 API 草稿的显式设置，不读取或写入仓库。这样设置更新只影响后续开始的业务操作，不会让当前采集轮次在新旧代理间切换。

`requestProxy` 收到 `407` 时抛出固定 `ProxyTransportError("proxy-authentication-required")`；其他目标 HTTP 状态原样返回。错误分类只检查稳定 `name`/`code`，公开消息固定为“代理连接失败。”，底层异常只能作为不序列化的 `cause` 保留在测试进程内。

- [ ] **Step 8: 用本地三协议夹具运行 GREEN 与回归**

Run:

```bash
npx vitest run test/proxy-agent-factory.test.ts test/outbound-network.test.ts
npx tsc --noEmit
git diff --check
```

Expected: HTTP、HTTPS、SOCKS5 和回退测试全部通过，无开放 handle；类型与空白检查退出 0。复核所有网络测试只访问 `127.0.0.1`。

- [ ] **Step 9: 请求确认后提交并推送**

报告依赖版本、本地代理协议覆盖、Telegram 预检语义和测试数量。明确确认后：

```bash
git add package.json package-lock.json src/server/network test/support/proxy-fixtures.ts \
  test/proxy-agent-factory.test.ts test/outbound-network.test.ts
git commit -m "feat: add proxy-aware outbound network service"
git push
```

---

### Task 3: 将全部 HTTP 提供方和 Telegram 接入统一网络层

**Files:**
- Create: `test/proxy-provider-wiring.test.ts`
- Modify: `src/server/dependencies.ts`
- Modify: `src/routes/product-discovery-routes.ts`
- Modify: `src/services/live-collection-runner.ts`
- Modify: `src/services/official-product-discovery-service.ts`
- Modify: `src/providers/official-provider-registry.ts`
- Modify: `src/services/telegram-service.ts`
- Modify: tests for `official-nintendo-search.ts`
- Modify: tests for `official-nintendo-product-page.ts`
- Modify: tests for `official-nintendo-price-api.ts`
- Modify: tests for `official-nintendo.ts`
- Modify: tests for `official-japanese-upgrade-root.ts`
- Modify: tests for `frankfurter-exchange-rate.ts`
- Modify: `test/telegram-service.test.ts`

**Interfaces:**
- Consumes: `OutboundNetwork.snapshot()`、`OutboundNetworkSession.fetch`、`OutboundNetworkSession.send` 和迁移计划已完成的 Node `ServerDependencies`。
- Produces: 商品发现、每次采集轮次和每次 Telegram 投递各自创建一个不可变网络会话；所有运行时外部 HTTP 客户端只接收会话方法，不再在生产依赖装配中使用全局 `fetch`。

- [ ] **Step 1: 写依赖装配失败测试**

`test/proxy-provider-wiring.test.ts` 使用可记录的 `OutboundNetwork` 替身，逐项触发任天堂搜索、官方商品页、日/港价格 API、日区升级根、汇率与 Telegram：

```ts
it("routes read providers through fetch and Telegram through send", async () => {
  // Algolia 虽使用 POST，但只读搜索由业务语义选择 fetch；Telegram 发送必须选择带 HEAD 预检的 send。
  const { outbound, session } = fakeOutboundNetwork();
  const dependencies = createServerDependencies({ database, config: fakeConfig(), outboundNetwork: outbound });

  await exerciseEveryHttpProvider(dependencies);
  await dependencies.telegram.send([{ text: "测试消息", page: 1, totalPages: 1 }]);

  expect(outbound.snapshot).toHaveBeenCalled();
  expect(session.fetch).toHaveBeenCalled();
  expect(session.send).toHaveBeenCalledTimes(1);
});
```

实际替身把 `snapshot()` 返回的会话暴露为可断言 Spy；测试还必须证明同一次多地区发现或采集只调用一次 `snapshot()`，下一轮调用第二次并可获得新配置。测试必须给每个固定外部主机返回对应最小夹具，并断言没有调用注入的“禁止直接 fetch”函数。第三方注册表当前未获准来源仍不发请求，但构造函数必须预留同一 `session.fetch`，未来启用来源不能绕过。

- [ ] **Step 2: 运行装配测试确认 RED**

Run:

```bash
npx vitest run test/proxy-provider-wiring.test.ts test/telegram-service.test.ts
```

Expected: FAIL，因为业务入口尚未创建 `OutboundNetworkSession`，Telegram 仍使用普通 Fetch 配置。

- [ ] **Step 3: 收窄 Telegram 构造接口**

将 Telegram 配置与传输分离：

```ts
export interface TelegramConfiguration {
  botToken: string;
  chatId: string;
}

/** Telegram 只能接收非幂等发送函数，避免依赖装配误用会自动重发真实 POST 的读取边界。 */
export type TelegramSender = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class TelegramService {
  public constructor(
    private readonly configuration: TelegramConfiguration,
    private readonly sender: TelegramSender,
  ) {}
}
```

保留既有安全结果 `{ index, delivered, status }`，异常仍只记录 `status: null`，不能读取或返回代理错误、Token URL 或响应正文。

- [ ] **Step 4: 在业务操作开始时建立会话并只绑定两种网络方法**

核心装配：

```ts
// 一个发现或采集轮次只建立一次会话；轮次内所有地区和嵌套提供方共享同一不可变代理快照。
const session = await outboundNetwork.snapshot();
const providerFetch: typeof fetch = session.fetch.bind(session);
// 一次 Telegram 投递使用独立会话和非幂等发送边界，代理实际 POST 失败后不得自动直连重复发送。
const telegramSend: typeof fetch = session.send.bind(session);

const officialSearch = createOfficialNintendoSearch(providerFetch);
const productPage = createOfficialNintendoProductPageResolver(providerFetch);
const priceQuotes = createNintendoOfficialPriceQuoteResolver(providerFetch);
const officialProviders = createOfficialProviderRegistry(providerFetch);
const exchangeRates = createFrankfurterExchangeRateProvider(providerFetch);
const upgradeRoot = createOfficialJapaneseUpgradeRootSearch(providerFetch);
const telegram = new TelegramService(telegramConfiguration, telegramSend);
```

`src/server/dependencies.ts` 暴露创建会话感知工作流的工厂，不能在进程启动时固定一个永不刷新的会话。商品发现路由在一次请求开始时创建会话；`LiveCollectionRunner` 在每轮开始时创建会话并传给全部地区 Provider；Telegram 每个逻辑投递创建一个会话。检查 `official-nintendo.ts`、价格 Provider 与注册表的嵌套工厂也继续传递同一个 `providerFetch`；不能因内部默认参数再次落回全局 `fetch`。

- [ ] **Step 5: 添加逐提供方代理回归**

在每个现有提供方测试中增加一个窄断言：注入的 Fetch 被调用一次，输入仍是原固定官方 URL/地区参数，响应解析与身份校验不改变。Telegram 测试断言 sender 拒绝时不会在服务内部二次调用；重试权只属于调度器后续轮次。

- [ ] **Step 6: 扫描所有生产外部 HTTP 入口**

Run:

```bash
rg -n '\bfetch\(' src/providers src/services
rg -n '= fetch|\?\? fetch|typeof fetch = fetch' src/providers src/services src/server
```

Expected: 第一条只允许调用注入参数的函数；第二条不得命中生产提供方或 Telegram 默认全局 Fetch。若新增命中，先补失败测试再修正，不能只加扫描忽略项。

- [ ] **Step 7: 运行提供方与业务回归**

Run:

```bash
npx vitest run test/proxy-provider-wiring.test.ts test/telegram-service.test.ts \
  test/official-nintendo-search.test.ts test/official-nintendo-product-page.test.ts \
  test/official-nintendo-price-api.test.ts test/official-nintendo.test.ts \
  test/official-japanese-upgrade-root.test.ts test/frankfurter-exchange-rate.test.ts \
  test/provider-chain.test.ts test/live-collection-runner.test.ts
npx tsc --noEmit
git diff --check
```

Expected: 全部通过；既有官方身份、价格来源与 ProviderChain 重试断言保持不变。

- [ ] **Step 8: 请求确认后提交并推送**

说明被接线的每个外部来源、Telegram 非幂等边界和扫描结果。确认后：

```bash
git add src/server/dependencies.ts src/providers src/services/telegram-service.ts test
git commit -m "feat: route external providers through proxy service"
git push
```

---

### Task 4: 为 Playwright 增加代理快照和清理后直连

**Files:**
- Modify: `src/providers/playwright/browser-launcher.ts`
- Modify: `src/providers/playwright/japanese-upgrade-browser.ts`
- Modify: `src/server/dependencies.ts`
- Modify: `test/playwright-browser-launcher.test.ts`
- Modify: `test/japanese-upgrade-browser.test.ts`
- Modify: `test/japanese-upgrade-relation-service.test.ts`

**Interfaces:**
- Consumes: `ProxySettingsReader`、`ProxySettings`、Task 2 的安全代理错误类别，以及迁移计划 Task 7 的 `BrowserLike`/`BrowserContextLike`/`BrowserPageLike`。
- Produces:

```ts
export interface BrowserLaunchOptions {
  proxy?: ProxySettings;
}

export interface BrowserLauncher {
  launch(options?: BrowserLaunchOptions): Promise<BrowserLike>;
}

export class BrowserProxyTransportError extends Error {
  public constructor(public readonly category: ProxyFailureCategory);
}
```

批处理在开始时只读一次代理设置；代理模式中首次启动或当前商品导航的传输错误允许切换一次直连，解析/身份/超时/取消错误不切换。

- [ ] **Step 1: 写浏览器启动参数失败测试**

在 `test/playwright-browser-launcher.test.ts` 添加：

```ts
it.each([
  ["http", "http://127.0.0.1:7890"],
  ["https", "https://127.0.0.1:7890"],
  ["socks5", "socks5://127.0.0.1:7890"],
] as const)("maps %s settings without credentials", async (protocol, server) => {
  // Chromium 只接收协议、主机和端口；username/password 即使未来出现在未知对象也不能被展开传入。
  const launch = vi.fn().mockResolvedValue(fakeBrowser());
  const launcher = createLocalBrowserLauncher({ playwright: fakePlaywright(launch), headless: true });

  await launcher.launch({ proxy: { enabled: true, protocol, host: "127.0.0.1", port: 7890 } });

  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ proxy: { server } }));
  expect(JSON.stringify(launch.mock.calls)).not.toMatch(/username|password/i);
});
```

另测关闭代理时 launch options 不含 `proxy`；IPv6 正确加方括号；浏览器错误只映射安全类别，不保留底层 message。

- [ ] **Step 2: 写批处理回退和清理失败测试**

关键顺序：

```ts
it("closes the proxy browser before retrying the current item directly", async () => {
  // 代理页面的 Cookie、缓存和半成品 DOM 不能被直连复用；先完整关闭，再从失败商品重新开始。
  const events: string[] = [];
  const launcher = sequentialLauncher([
    proxyBrowserThatFailsNavigation(events, new BrowserProxyTransportError("connection")),
    directBrowserThatSucceeds(events),
  ]);
  const batch = createJapaneseUpgradeBrowserBatch(launcher, fixedSettings(enabledProxy()));

  const result = await batch.resolve([root(FIRST_URL), root(SECOND_URL)], new AbortController().signal);

  expect([...result.values()].every((item) => item.status === "success")).toBe(true);
  expect(events).toEqual([
    "proxy-launch", "proxy-context", "proxy-page", "proxy-goto", "proxy-page-close",
    "proxy-context-close", "proxy-browser-close", "direct-launch", "direct-context",
    "direct-page", "direct-goto:first", "direct-page-close", "direct-context-close",
    "direct-context", "direct-page", "direct-goto:second", "direct-page-close",
    "direct-context-close", "direct-browser-close",
  ]);
});
```

还需证明：设置只读一次；已有成功项在后续代理失败时不重复；只重试当前项及剩余项；最多两个顺序浏览器；TimeoutError、解析失败、无唯一链接、AbortSignal 和 close 拒绝不直连；直连也失败时返回既有安全状态。

- [ ] **Step 3: 运行浏览器测试确认 RED**

Run:

```bash
npx vitest run test/playwright-browser-launcher.test.ts test/japanese-upgrade-browser.test.ts
```

Expected: FAIL，因为 launcher 尚不接收代理，批处理也没有清理后直连状态机。

- [ ] **Step 4: 实现无认证 Playwright 代理映射**

```ts
/** Playwright 代理 URL 只由已校验字段构造；该层不读取数据库，也不支持任何认证字段。 */
export function toPlaywrightProxy(settings: ProxySettings): { server: string } | undefined {
  if (!settings.enabled) return undefined;
  const host = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  return { server: `${settings.protocol}://${host}:${settings.port}` };
}
```

`createLocalBrowserLauncher` 捕获启动期明确代理错误并抛 `BrowserProxyTransportError`；普通 Chromium 启动失败仍映射既有 `browser-unavailable`。页面适配器只在代理模式把 DNS、代理握手、隧道和 TLS 建连错误转为同一安全类型，导航超时继续保持 `TimeoutError`。

- [ ] **Step 5: 实现单次配置快照与顺序回退状态机**

批处理伪代码：

```ts
const settings = await proxySettings.readProxySettings();
let mode: "proxy" | "direct" = settings.enabled ? "proxy" : "direct";
let browser = await launcher.launch(mode === "proxy" ? { proxy: settings } : undefined);
try {
  for (let index = 0; index < validRoots.length; index += 1) {
    try {
      results.set(validRoots[index].productUrl, await resolveOne(browser, validRoots[index], signal));
    } catch (error) {
      if (mode !== "proxy" || !(error instanceof BrowserProxyTransportError) || signal.aborted) throw error;
      // 当前代理浏览器必须先完整关闭；随后只允许一次直连切换并重做当前商品。
      await closeBrowserTree(browser);
      mode = "direct";
      browser = await launcher.launch();
      index -= 1;
    }
  }
} finally {
  await closeSafely(browser);
}
```

实际实现必须避免 `index -= 1` 造成无界循环：单独的 `hasFallenBack` 布尔值保证切换仅一次；成功结果 Map 不清空；晚到页面/上下文仍沿用既有清理机制。

- [ ] **Step 6: 运行完整浏览器门禁**

Run:

```bash
npx vitest run test/playwright-browser-launcher.test.ts test/japanese-upgrade-browser.test.ts \
  test/japanese-upgrade-relation-service.test.ts test/japanese-subscription-confirmation-service.test.ts \
  test/official-product-discovery-service.test.ts
npx tsc --noEmit
git diff --check
```

Expected: 全部通过；无泄漏 Chromium 进程；原“一批最多三个商品、每项三十秒、身份不匹配不重试”断言仍通过。

- [ ] **Step 7: 请求确认后提交并推送**

报告三协议映射、清理事件顺序与浏览器测试数量。确认后：

```bash
git add src/providers/playwright src/server/dependencies.ts test/playwright-browser-launcher.test.ts \
  test/japanese-upgrade-browser.test.ts test/japanese-upgrade-relation-service.test.ts
git commit -m "feat: add proxy fallback to local playwright"
git push
```

---

### Task 5: 增加代理设置 API 与固定连接测试

**Files:**
- Create: `src/services/proxy-connection-test-service.ts`
- Create: `test/proxy-connection-test-service.test.ts`
- Create: `test/api-settings-proxy.test.ts`
- Modify: `src/shared/proxy-settings.ts`
- Modify: `src/routes/settings-routes.ts`
- Modify: `src/server/dependencies.ts`
- Modify: `test/api-settings.test.ts`

**Interfaces:**
- Consumes: `SettingsService`、`OutboundNetwork.probe`、代理感知 `BrowserLauncher` 和管理员认证守卫。
- Produces:

```ts
export interface PublicProxySettings extends ProxySettings {
  readonly directFallbackEnabled: true;
}

export type PublicAppSettings = Omit<AppSettings, "proxy"> & {
  proxy: PublicProxySettings;
};

export type ProxyProbeStatus = "proxy-success" | "direct-fallback-success" | "failed";

export interface ProxyProbeResult {
  status: ProxyProbeStatus;
  errorCategory?: ProxyFailureCategory | "browser-launch";
}

export interface ProxyConnectionTestResult {
  http: ProxyProbeResult;
  browser: ProxyProbeResult;
}

export interface BrowserProxyProbe {
  probe(settings: ProxySettings, url: string, signal: AbortSignal): Promise<ProxyProbeResult>;
}

export class ProxyConnectionTestBusyError extends Error {}
export class ProxyConnectionTestService {
  test(settings: ProxySettings): Promise<ProxyConnectionTestResult>;
}
```

- [ ] **Step 1: 写连接测试服务失败测试**

覆盖固定目标、两项并行或顺序策略、8 秒独立超时、三态结果、错误类别脱敏和进程内互斥：

```ts
it("uses only the two code-owned targets and does not persist the draft", async () => {
  // 测试服务不能接收 URL；固定目标阻止受认证页面把 NAS 变成任意 SSRF 探针。
  const service = createProxyConnectionTestService({ outbound, browser, timeoutMs: 8_000 });

  await service.test({ ...enabledProxy(), enabled: false });

  // 即使保存草稿尚未启用，测试也必须临时验证该代理端点，而不是只测直连后给出误导性成功。
  expect(outbound.probe).toHaveBeenCalledWith(enabledProxy(), "https://www.nintendo.com/robots.txt", expect.anything());
  expect(browser.probe).toHaveBeenCalledWith(enabledProxy(), "https://store-jp.nintendo.com/robots.txt", expect.any(AbortSignal));
  expect(settingsRepository.save).not.toHaveBeenCalled();
});
```

第二个并发 `test()` 必须抛 `ProxyConnectionTestBusyError`；第一项结束、失败或取消后互斥状态都必须释放。

- [ ] **Step 2: 写 HTTP 路由失败测试**

`test/api-settings-proxy.test.ts` 覆盖：

- 未认证 GET/PATCH/POST 测试均 `401`；
- GET 返回 `proxy` 与 `directFallbackEnabled: true`，没有认证字段；
- PATCH 原子保存完整代理，非法协议/主机/端口为 `422` 且旧值不变；
- `username`、`password`、`proxyUrl` 或未知代理字段为 `422`，不能忽略；
- POST 测试只接受 `{ enabled, protocol, host, port }`，不保存草稿；
- 互斥冲突为 `409 PROXY_TEST_BUSY`；
- 结果只含 `http`、`browser`、`status`、可选 `errorCategory`。

- [ ] **Step 3: 运行服务与路由测试确认 RED**

Run:

```bash
npx vitest run test/proxy-connection-test-service.test.ts test/api-settings-proxy.test.ts
```

Expected: FAIL，因为服务、POST 路由和严格代理字段解析尚不存在。

- [ ] **Step 4: 实现固定测试服务和浏览器 Probe**

```ts
const HTTP_TEST_URL = "https://www.nintendo.com/robots.txt";
const BROWSER_TEST_URL = "https://store-jp.nintendo.com/robots.txt";

public async test(settings: ProxySettings): Promise<ProxyConnectionTestResult> {
  if (this.inFlight) throw new ProxyConnectionTestBusyError("代理连接测试正在进行。");
  this.inFlight = true;
  // 两个通道各有独立截止时间；一个通道提前失败或完成不能取消另一项诊断。
  const httpSignal = AbortSignal.timeout(this.timeoutMs);
  const browserSignal = AbortSignal.timeout(this.timeoutMs);
  // “启用”只控制保存后的业务流量；连接测试始终临时启用草稿端点，且绝不写回数据库。
  const candidate = Object.freeze({ ...settings, enabled: true });
  try {
    // 两项结果独立返回；普通 HTTP 失败不能阻止浏览器验证其单独代理实现。
    const [http, browser] = await Promise.all([
      this.probeHttp(candidate, HTTP_TEST_URL, httpSignal),
      this.browser.probe(candidate, BROWSER_TEST_URL, browserSignal),
    ]);
    return { http, browser };
  } finally {
    this.inFlight = false;
  }
}
```

Browser Probe 复用 Task 4 的启动、页面、上下文和关闭接口；代理失败必须先完整关闭后再直连，任何 HTTP 响应视为传输成功，`407` 报 `proxy-authentication-required`。

测试草稿中的 `enabled` 只表示保存后的业务开关。服务必须临时把候选设置视为启用，以便管理员在正式启用前验证代理；此转换不改变请求对象，不读取数据库，也不持久化。

- [ ] **Step 5: 扩展设置路由的严格白名单**

路由签名改为注入依赖而非自行创建数据库服务：

```ts
export interface SettingsRouteDependencies {
  requireAdmin(request: Request): Promise<boolean>;
  settings: SettingsService;
  proxyConnectionTest: ProxyConnectionTestService;
  now(): string;
}
```

`readProxySettings()` 必须用允许字段集合检查 `Object.keys`。既有顶层设置 PATCH 可以继续忽略历史未知顶层字段以保持兼容，但 `proxy` 对象必须严格拒绝认证或 URL 字段。POST 测试请求只读取完整代理对象，不读取或合并数据库值。

- [ ] **Step 6: 运行 API 与认证回归**

Run:

```bash
TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
  npx vitest run test/proxy-connection-test-service.test.ts test/api-settings-proxy.test.ts \
  test/api-settings.test.ts test/auth-guard.test.ts test/server-http.test.ts
npx tsc --noEmit
git diff --check
```

Expected: 全部通过；测试未访问公网，所有网络依赖均为注入替身。

- [ ] **Step 7: 请求确认后提交并推送**

报告端点契约、固定目标、互斥/超时和认证字段拒绝结果。确认后：

```bash
git add src/shared/proxy-settings.ts src/services/proxy-connection-test-service.ts \
  src/routes/settings-routes.ts src/server/dependencies.ts \
  test/proxy-connection-test-service.test.ts test/api-settings-proxy.test.ts test/api-settings.test.ts
git commit -m "feat: add proxy settings and connection test API"
git push
```

---

### Task 6: 在设置页增加无认证代理表单与连接测试结果

**Files:**
- Modify: `src/app/settings-form.ts`
- Modify: `src/app/settings-api-client.ts`
- Modify: `src/app/settings-page-state.ts`
- Modify: `src/app/settings-page.tsx`
- Modify: `src/app/styles.css`
- Modify: `test/settings-form.test.ts`
- Modify: `test/settings-api-client.test.ts`
- Modify: `test/settings-page-state.test.ts`
- Create: `test/settings-page.test.tsx`

**Interfaces:**
- Consumes: `ProxySettings`、`ProxyConnectionTestResult`、既有管理员会话失效回调。
- Produces:

```ts
export interface PublicSettingsPatch {
  enabledRegions: RegionCode[];
  defaultSearchRegion: RegionCode;
  theme: AppSettings["theme"];
  timezone: string;
  dailyReportTime: string;
  taxState: string;
  priceHistoryRetention: AppSettings["priceHistoryRetention"];
  // 代理必须整对象提交，避免协议、主机和端口来自不同版本的草稿。
  proxy: ProxySettings;
}

export interface SettingsApiClient {
  getSettings(): Promise<PublicAppSettings>;
  saveSettings(patch: PublicSettingsPatch): Promise<PublicAppSettings>;
  testProxy(proxy: ProxySettings): Promise<ProxyConnectionTestResult>;
}
```

页面提供启用开关、协议下拉框、主机文本框、端口数字框和“测试连接”按钮；不得出现用户名、密码或完整代理 URL 输入框。测试连接只使用当前草稿且不保存，所以即使“启用代理”未勾选也会临时验证所填代理，并明确提示测试不会启用或保存配置。

- [ ] **Step 1: 写表单模型失败测试**

`test/settings-form.test.ts` 覆盖：

- API 值完整映射到草稿；
- `http`、`https`、`socks5` 可选，其他协议在客户端校验失败；
- 主机 trim 后不能为空，不能包含协议、路径、用户名、密码、空白或控制字符；
- 端口只接受 `1..65535` 的整数；
- 序列化只产生 `{ enabled, protocol, host, port }`；
- 从未知对象注入 `username`、`password`、`proxyUrl` 时不会进入表单模型或请求体。

示例：

```ts
it("serializes only the four no-authentication proxy fields", () => {
  // 表单白名单同时是前端防泄漏边界，未知字段不能被对象展开带回 API。
  const draft = proxyDraftFromSettings({
    enabled: true,
    protocol: "socks5",
    host: "127.0.0.1",
    port: 7890,
    username: "unexpected",
    password: "unexpected",
  } as never);

  expect(toProxySettings(draft)).toEqual({
    enabled: true,
    protocol: "socks5",
    host: "127.0.0.1",
    port: 7890,
  });
});
```

- [ ] **Step 2: 写 API Client 失败测试**

`test/settings-api-client.test.ts` 断言：

- `testProxy` 向 `/api/settings/proxy/test` 发送完整四字段 POST；
- `401` 调用一次 `onUnauthorized` 且抛既有会话错误；
- `409 PROXY_TEST_BUSY` 映射为可展示错误，但不清空当前草稿；
- `422` 显示安全校验消息，不回显服务器正文或代理地址；
- 响应解码拒绝未知 `status` 和认证字段。

- [ ] **Step 3: 写设置页行为失败测试**

使用既有 DOM 测试栈验证：

```tsx
it("tests the unsaved draft independently from saving", async () => {
  // 测试按钮不能隐式保存，管理员可以先验证新代理再决定是否覆盖当前有效配置。
  const api = fakeSettingsApi({
    testResult: {
      http: { status: "direct-fallback-success", errorCategory: "connection" },
      browser: { status: "proxy-success" },
    },
  });
  render(<SettingsPage api={api} />);

  await editProxy({ enabled: true, protocol: "http", host: "192.168.1.20", port: "7890" });
  await clickButton("测试连接");

  expect(api.testProxy).toHaveBeenCalledWith({
    enabled: true,
    protocol: "http",
    host: "192.168.1.20",
    port: 7890,
  });
  expect(api.save).not.toHaveBeenCalled();
  expect(screen.getByText("代理失败但直连成功")).toBeVisible();
});
```

另测：保存和测试使用独立 loading 状态；测试期间只禁用测试按钮；保存成功以后才更新基线；保存失败保留草稿；`settings-page-state.ts` 对保存和测试的 `401` 均返回 `unauthorized`，对 `409` 保留草稿与上次结果；HTTP 与浏览器结果分别显示“代理连接成功”“代理失败但直连成功”或“代理与直连均失败”；禁用代理时仍提交当前候选代理并提示测试不改变业务开关；键盘标签和错误提示可访问。

- [ ] **Step 4: 运行 UI 测试确认 RED**

Run:

```bash
npm run test:dom -- --run test/settings-page.test.tsx
npx vitest run test/settings-form.test.ts test/settings-api-client.test.ts
```

Expected: FAIL，因为代理草稿、Client 方法和设置卡片尚不存在。

- [ ] **Step 5: 实现严格表单与 API Client**

`settings-form.ts` 只逐字段构造草稿和请求对象，禁止 `{ ...serverProxy }`。错误消息只指出字段规则，不包含主机完整值。`settings-api-client.ts` 复用既有 JSON/认证处理，新增 `409` 的稳定错误码映射；响应解码器逐项允许固定状态和安全错误类别。

核心请求：

```ts
/** 连接测试只提交当前无认证草稿；该方法不会触发保存，也不会自动重试 POST。 */
async function testProxy(proxy: ProxySettings): Promise<ProxyConnectionTestResult> {
  return requestJson("/api/settings/proxy/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: proxy.enabled,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
    }),
  });
}
```

- [ ] **Step 6: 实现代理设置卡片和三态结果**

在既有设置页结构中加入单独卡片：

- 开关控制保存后的全局代理是否启用，但不隐藏协议/主机/端口；
- 协议选项文案为 HTTP、HTTPS、SOCKS5；
- 主机 placeholder 使用 `127.0.0.1`，端口 placeholder 使用 `7890`，不得放真实局域网地址；
- 测试结果按“普通 HTTP”和“浏览器”两行展示；
- 卡片固定提示代理失败会尝试直连，直连回退可能暴露 NAS 的出口地址；
- 失败类别只翻译安全枚举，不显示原始异常；
- `aria-live="polite"` 宣告测试完成，字段错误通过 `aria-describedby` 关联；
- CSS 沿用现有颜色变量与响应式断点，不增加远程字体、图标或第三方资源。

所有新增组件、状态转换和样式分区均添加中文详细注释，解释草稿不自动保存、无认证字段边界及双通道结果的业务原因。

- [ ] **Step 7: 运行 UI GREEN、类型和负向扫描**

Run:

```bash
npx vitest run test/settings-form.test.ts test/settings-api-client.test.ts test/settings-page-state.test.ts
npm run test:dom -- --run test/settings-page.test.tsx
npx tsc --noEmit
npm run build
rg -n 'username|password|proxyUrl|proxy_url' src/app test/settings-form.test.ts \
  test/settings-api-client.test.ts test/settings-page.test.tsx
git diff --check
```

Expected: 测试、类型、构建和空白检查通过。扫描只能命中用于证明拒绝未知认证字段的测试与中文注释，不得命中表单控件、请求类型或生产请求体。

- [ ] **Step 8: 请求确认后提交并推送**

报告页面字段、三态展示、无认证字段扫描与 DOM 测试结果。取得明确确认后：

```bash
git add src/app/settings-form.ts src/app/settings-api-client.ts src/app/settings-page.tsx \
  src/app/settings-page-state.ts src/app/styles.css test/settings-form.test.ts \
  test/settings-api-client.test.ts test/settings-page-state.test.ts test/settings-page.test.tsx
git commit -m "feat: add proxy controls to settings page"
git push
```

---

### Task 7: 补齐容器契约、CI 门禁、文档与分级验收

**Files:**
- Create: `test/proxy-container-contract.test.mjs`
- Create: `test/proxy-smoke.test.ts`
- Modify: `Dockerfile`
- Modify: `docker-compose.dev.yml`
- Modify: `docker-compose.prod.yml`
- Modify: `.env.example`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/README.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/superpowers/specs/2026-08-01-network-proxy-settings-design.md`

**Interfaces:**
- Consumes: Tasks 1–6 的数据库字段、统一网络层、Playwright、API 和设置 UI。
- Produces: 可重复的本地三协议验收、容器网络契约、CI 回归门禁和需要用户授权的 DS423+ 真机验收步骤。

`.env.example` 不新增代理地址、用户名或密码变量：代理只由管理员设置页写入 PostgreSQL，避免 Compose 环境覆盖数据库真值或把局域网地址复制到日志/仓库。容器保持普通 bridge 网络；不使用 `network_mode: host`、`privileged` 或宿主 Docker Socket。

- [ ] **Step 1: 写容器契约失败测试**

`test/proxy-container-contract.test.mjs` 读取 Docker/Compose/CI 文本并断言：

```js
test("keeps proxy configuration in PostgreSQL without privileged networking", () => {
  // bridge 容器可主动访问 NAS 局域网代理，不需要扩大宿主网络或 Docker 控制权限。
  assert.doesNotMatch(allCompose, /network_mode:\s*host|privileged:\s*true|docker\.sock/);
  assert.doesNotMatch(envExample, /PROXY_(URL|USERNAME|PASSWORD)|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY/);
  assert.match(ci, /proxy-agent-factory\.test\.ts/);
  assert.match(ci, /proxy-smoke\.test\.ts/);
});
```

同时验证生产镜像仍安装 Chromium 运行依赖，数据库迁移包含四个代理列，健康检查不依赖公网或代理测试目标。

- [ ] **Step 2: 写只访问本机的冒烟测试**

`test/proxy-smoke.test.ts` 复用 Task 2 的本地代理夹具并启动 Chromium，逐协议执行：普通 HTTP 代理成功、代理端口关闭后的直连回退、Playwright 代理成功、Playwright 清理后直连。测试必须：

- 仅访问 `127.0.0.1` 随机端口；
- 使用临时数据库或注入设置读取器，不修改开发者真实设置；
- `finally` 关闭全部 socket、page、context、browser；
- 失败标题只包含协议与阶段，不输出代理 URL、请求头、Cookie、数据库 URL 或底层错误；
- 由 Vitest 的非零退出表示任一协议失败。

先在 `test/proxy-container-contract.test.mjs` 断言测试存在且 CI 调用该测试。

- [ ] **Step 3: 运行契约测试确认 RED**

Run:

```bash
node --test test/proxy-container-contract.test.mjs
```

Expected: FAIL，因为冒烟测试和 CI 代理门禁尚未加入。

- [ ] **Step 4: 更新容器和 CI，保持最小权限**

- Dockerfile 保留非 root 用户和 Chromium 安装，不增加代理环境变量；
- Compose 继续使用 bridge/服务名访问 PostgreSQL，应用容器可主动访问管理员填写的局域网主机和端口；
- 健康检查只打容器本地 `/api/health`，不得因为外部代理不可用把容器判死；
- CI 安装 Chromium 后运行代理 Agent、出站回退、提供方接线、Playwright、API、DOM、契约与本地冒烟测试；
- 所有 Docker、Compose、CI 和脚本改动添加中文详细注释，说明无认证配置、最小权限、测试仅本机和失败回退边界。

CI 片段：

```yaml
# 代理回归只启动回环夹具，避免 CI 对任天堂、Telegram 或开发者局域网产生真实请求。
- name: Verify local proxy transports
  run: |
    npx vitest run test/proxy-agent-factory.test.ts test/outbound-network.test.ts
    npx vitest run test/proxy-smoke.test.ts
```

- [ ] **Step 5: 运行 M1 全量本地验收**

Run:

```bash
npx vitest run test/proxy-settings.test.ts test/proxy-agent-factory.test.ts \
  test/outbound-network.test.ts test/proxy-provider-wiring.test.ts \
  test/playwright-browser-launcher.test.ts test/japanese-upgrade-browser.test.ts \
  test/proxy-connection-test-service.test.ts test/api-settings-proxy.test.ts
npm run test:dom -- --run test/settings-page.test.tsx
node --test test/proxy-container-contract.test.mjs
npx vitest run test/proxy-smoke.test.ts
npx tsc --noEmit
npm run build
```

Expected: HTTP、HTTPS、SOCKS5 的 Node 请求和 Chromium 请求均通过本地夹具；故障后只回退一次；Telegram 测试不重复发送；设置页三态结果正确；无公网访问。

- [ ] **Step 6: 运行 PostgreSQL、完整回归和镜像门禁**

Run:

```bash
TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
  npm test -- --run
npm run test:dom -- --run
npx tsc --noEmit
npm run build
docker build -t switch-price-monitor:proxy-local .
git diff --check
rg -n 'NODE_TLS_REJECT_UNAUTHORIZED|network_mode:\s*host|privileged:\s*true|docker\.sock' \
  Dockerfile docker-compose.dev.yml docker-compose.prod.yml src test .github
```

Expected: 所有检查退出 0；负向扫描无匹配；镜像以非 root 用户运行且健康检查不访问外网。若 PostgreSQL 或 Docker 未启动，记录为未执行并先取得对应运行权限，不能把跳过写成通过。

- [ ] **Step 7: 更新追踪矩阵与验收记录**

在文档中记录：

- FR-012 对应数据库、出站网络层、各提供方、Telegram、Playwright、API/UI、CI 和测试文件；
- 代理无认证、默认关闭、失败直连、连接测试固定目标和不保存草稿；
- M1 命令、日期、实际通过数量和运行环境；
- “注释与实现一致性”逐文件检查结论；
- 未执行的 DS423+ 步骤明确保持“待用户授权”，不伪造结果。

文档只写已实际运行的事实；任何失败都保留复现命令和安全错误类别，不复制底层网络异常、代理地址或凭据。

- [ ] **Step 8: 取得授权后执行 DS423+ 真机验收**

该步骤会访问用户 NAS 和真实网络，必须在执行前单独取得明确授权，并由用户临时提供一个“不需要用户名和密码”的测试代理地址。不得把地址写入 Git、命令历史、测试快照或日志。

真机验收顺序：

1. 部署当前镜像并让迁移 runner 成功执行 `0002_proxy_settings.sql`；
2. 管理员登录设置页，逐项保存 HTTP、HTTPS、SOCKS5 临时代理并运行连接测试；
3. 核对普通 HTTP 和浏览器各自显示代理成功；
4. 暂停代理，核对两项显示“代理失败但直连成功”，并执行一次真实采集；
5. 恢复代理，运行日区升级关系批处理，检查没有残留 Chromium 进程；
6. 发送一条明确标记为验收的 Telegram 测试消息，确认只收到一次；
7. 关闭代理功能并清除临时主机/端口，确认容器健康状态不受影响。

若用户未授权真实 Telegram 消息，则跳过第 6 项并明确记录，不能用普通业务通知替代。

- [ ] **Step 9: 最终安全与注释一致性复核**

Run:

```bash
rg -n 'username|password|proxyUrl|proxy_url|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY' \
  src migrations test Dockerfile docker-compose.dev.yml docker-compose.prod.yml .env.example
rg -n '\bfetch\(' src/providers src/services
git diff --check
git status --short
```

Expected: 第一条只允许数据库既有管理员密码语义或明确拒绝代理认证字段的校验注释，代理生产模型/表单/环境不得出现认证字段；第二条只允许统一注入的网络函数；空白检查通过。逐个检查所有变更源代码、测试、SQL、构建和运行配置的中文注释是否准确描述职责、约束、边界和安全/业务原因。

- [ ] **Step 10: 请求最终确认后提交并推送**

向用户报告本地门禁、镜像结果、文档状态、未执行/已执行的真机项目和准确变更范围。取得明确确认后在同一操作提交并推送：

```bash
git add Dockerfile docker-compose.dev.yml docker-compose.prod.yml .env.example \
  .github/workflows/ci.yml test/proxy-smoke.test.ts test/proxy-container-contract.test.mjs docs
git commit -m "test: verify proxy settings deployment"
git push
```

---

## Final Verification Matrix

| Requirement | Implementation tasks | Required evidence |
|---|---|---|
| 设置页可启用/禁用代理，并保存协议、主机、端口 | 1, 5, 6 | PostgreSQL 迁移测试、API 测试、DOM 测试 |
| 仅支持 HTTP、HTTPS、SOCKS5，且不支持用户名/密码 | 1, 2, 4, 5, 6 | 严格字段测试、三协议本地夹具、认证字段负向扫描 |
| 所有外部 HTTP 来源使用统一代理边界 | 2, 3 | 提供方接线测试、全局 Fetch 扫描 |
| 代理失败自动直连且只回退一次 | 2, 4 | 出站状态机测试、Playwright 清理顺序测试 |
| Telegram 不因模糊 POST 结果重复发送 | 2, 3 | HEAD 预检与不二次调用测试 |
| Playwright 使用同一配置快照并顺序回退 | 4 | 启动映射、设置只读一次、最多两个浏览器和清理事件测试 |
| 测试连接固定目标、不保存草稿、区分三态 | 5, 6 | 服务/API/DOM 测试和固定 URL 断言 |
| 默认关闭、错误脱敏、容器最小权限 | 1, 2, 7 | 默认值测试、错误枚举测试、容器契约与安全扫描 |
| 本地、CI、NAS 验收可追踪且不伪造结果 | 7 | M1 命令输出、CI 门禁、经授权的 DS423+ 验收记录 |

## Required Execution Order

严格按 `Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7` 执行。Task 1–7 又依赖 `2026-07-27-nas-docker-postgresql-migration.md` 的 Task 1–7 已完成；若前置迁移计划尚未落地，应先暂停本计划，完成并验证该基础，不得在 Cloudflare Worker 旧运行时上并行实现第二套代理逻辑。
