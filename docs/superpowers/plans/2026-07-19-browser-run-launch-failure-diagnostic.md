# Browser Run 启动失败受控诊断实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本项目当前在主会话内逐项执行，不启用子代理，除非管理员另行明确要求。

**Goal:** 在不接触生产环境的前提下，为临时 Browser Run 探针增加安全诊断能力，并通过本地/远程 A/B 证据定位浏览器启动失败所在层级。

**Architecture:** 临时探针把未知异常先交给纯函数脱敏，再由可注入的浏览器生命周期编排器标记失败阶段；HTTP 层只暴露固定的启动诊断和普通测试页导航诊断，不接受任意 URL。执行严格按本地启动、远程启动、远程普通导航、任天堂单次验证、任天堂三次验证推进，任何阶段失败都立即停止后续阶段并依据证据编写根因专用修复步骤。

**Tech Stack:** TypeScript 5.8.3、Vitest 4.1.0、Wrangler 4.31.0、`@cloudflare/playwright` 1.3.0、Cloudflare Browser Run。

## Global Constraints

- 每次修改代码、测试、配置或文档前，完整阅读项目 `AGENTS.md` 和 `docs/README.md`。
- 所有新增或修改的临时源代码、测试和 JSONC/运行脚本配置均添加中文详细注释，并检查注释与实现一致。
- 严格测试先行：每项行为先运行新增测试并确认因缺少实现而失败，再写最小实现并运行通过。
- 临时实现只存在于 `/tmp/switch-price-monitor-jp-browser-probe`；不得修改生产 `src/`、D1、Cron、Static Assets、Secrets、版本号或订阅数据。
- 诊断不得输出完整堆栈、`cause`、页面 HTML、响应正文、Cookie、请求头、响应头、账号标识、API Token、排队令牌或截图。
- HTTP 层不得接受任意导航 URL；普通对照页固定为 `https://example.com/`，任天堂页继续固定为既有官方样本。
- 本地诊断失败时不运行远程诊断；远程启动失败时不运行普通导航；普通导航失败时不访问任天堂。
- 初次远程诊断只执行一次；额度或频率错误只能等待限制恢复，不以并发、会话复用或密集重试绕过。
- 临时代码、依赖目录和结果 JSON 不进入 Git。仓库文档准备提交前，必须向管理员说明范围并取得明确确认，然后在同一操作中提交并推送 `origin/main`。
- 本计划不授权临时 Worker 部署或生产发布；若远程开发无法提供证据，必须另行取得授权后才能评估一次性部署。

---

## 文件结构与职责

### 临时目录，不进入 Git

- Create: `/tmp/switch-price-monitor-jp-browser-probe/src/diagnostic-domain.ts`：定义诊断类型、执行目标与异常脱敏纯函数。
- Create: `/tmp/switch-price-monitor-jp-browser-probe/test/diagnostic-domain.test.ts`：锁定白名单字段和敏感内容拒绝边界。
- Create: `/tmp/switch-price-monitor-jp-browser-probe/src/launch-diagnostic.ts`：编排绑定检查、启动、上下文、页面、固定普通页导航与资源清理。
- Create: `/tmp/switch-price-monitor-jp-browser-probe/test/launch-diagnostic.test.ts`：用可控假浏览器验证阶段归因和逆序清理。
- Create: `/tmp/switch-price-monitor-jp-browser-probe/src/diagnostic-http.ts`：只处理固定诊断路径并设置 `no-store`。
- Create: `/tmp/switch-price-monitor-jp-browser-probe/test/diagnostic-http.test.ts`：验证方法、路径、执行目标与禁止任意 URL。
- Modify: `/tmp/switch-price-monitor-jp-browser-probe/src/index.ts`：装配 Cloudflare Playwright 适配器和原有任天堂探针。
- Modify: `/tmp/switch-price-monitor-jp-browser-probe/src/http.ts`：为临时环境类型补充固定执行目标变量。
- Modify: `/tmp/switch-price-monitor-jp-browser-probe/package.json`：增加带固定环境标签的本地与远程脚本。
- Create: `/tmp/jp-browser-launch-local.json`、`/tmp/jp-browser-launch-remote.json`、`/tmp/jp-browser-navigation-remote.json`：只保存允许字段的临时证据。

### 项目仓库

- Modify after evidence: `docs/quality/quality-and-acceptance.md`：记录执行时间、允许字段、停止点和根因结论。
- Modify after evidence: `docs/superpowers/specs/2026-07-19-browser-run-launch-failure-diagnostic-design.md`：更新诊断状态，不改变准入门槛。
- Modify after evidence: `docs/README.md`：同步阶段状态。

---

### Task 1：异常脱敏与诊断结果白名单

**Files:**

- Create: `/tmp/switch-price-monitor-jp-browser-probe/test/diagnostic-domain.test.ts`
- Create: `/tmp/switch-price-monitor-jp-browser-probe/src/diagnostic-domain.ts`

**Interfaces:**

- Produces: `ExecutionTarget`、`DiagnosticStage`、`DiagnosticOperation`、`DiagnosticResult`。
- Produces: `sanitizeDiagnosticFailure(error: unknown, input: { executionTarget: ExecutionTarget; stage: DiagnosticStage; elapsedMs: number }): DiagnosticResult`。
- Consumes: 仅 ECMAScript 标准类型，不依赖 Worker、浏览器或项目生产模块。

- [ ] **Step 1：写入失败测试，锁定脱敏和字段白名单**

创建 `test/diagnostic-domain.test.ts`，测试必须明确断言：`Error` 的名称和 `429` 错误码被保留；URL 查询参数、Bearer 值、`token/secret/password` 键值、长随机串和换行被替换；超长信息被截断；任意对象不会被序列化；结果不包含 `stack` 或 `cause`。

```ts
import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticFailure } from "../src/diagnostic-domain";

describe("sanitizeDiagnosticFailure", () => {
  it("保留平台错误类别，同时移除凭据、查询参数和日志注入字符", () => {
    const error = new Error(
      "Unable to create new browser: code: 429\nurl=https://api.example.test/run?token=abc123 password=hunter2 Authorization: Bearer secret-value",
    );
    error.name = "BrowserLaunchError";

    const result = sanitizeDiagnosticFailure(error, {
      executionTarget: "remote",
      stage: "browser-launch",
      elapsedMs: 42.8,
    });

    expect(result).toEqual({
      status: "failure",
      executionTarget: "remote",
      stage: "browser-launch",
      errorName: "BrowserLaunchError",
      errorCode: "429",
      errorMessage: "Unable to create new browser: code: 429 url=https://api.example.test/run?[REDACTED] password=[REDACTED] Authorization: Bearer [REDACTED]",
      elapsedMs: 42,
    });
    expect(result).not.toHaveProperty("stack");
    expect(result).not.toHaveProperty("cause");
  });

  it("对非 Error 异常使用固定文本，不序列化攻击者控制的对象", () => {
    expect(sanitizeDiagnosticFailure({ token: "do-not-leak" }, {
      executionTarget: "local",
      stage: "context-create",
      elapsedMs: -10,
    })).toEqual({
      status: "failure",
      executionTarget: "local",
      stage: "context-create",
      errorName: "UnknownError",
      errorMessage: "Non-Error value was thrown",
      elapsedMs: 0,
    });
  });

  it("限制名称、错误码和消息长度，避免把平台响应正文带出", () => {
    const error = Object.assign(new Error("x".repeat(500)), {
      name: "N".repeat(100),
      code: "INVALID-CODE-WITH-SPACES",
    });
    const result = sanitizeDiagnosticFailure(error, {
      executionTarget: "remote",
      stage: "page-create",
      elapsedMs: 1,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") throw new Error("测试前置条件不成立");
    expect(result.errorName.length).toBeLessThanOrEqual(64);
    expect(result.errorMessage.length).toBeLessThanOrEqual(240);
    expect(result.errorCode).toBeUndefined();
  });
});
```

- [ ] **Step 2：运行测试并确认因模块不存在而失败**

Run: `npm test -- test/diagnostic-domain.test.ts`

Workdir: `/tmp/switch-price-monitor-jp-browser-probe`

Expected: FAIL，错误包含 `Cannot find module '../src/diagnostic-domain'`。

- [ ] **Step 3：实现最小诊断纯函数**

创建 `src/diagnostic-domain.ts`。实现必须使用判别联合保证成功结果不含错误字段；错误码只允许 1–32 位字母、数字、点、下划线或连字符；名称最多 64 字符；消息最多 240 字符；`elapsedMs` 向下取整且最小为 0。

```ts
/** 执行目标由固定运行脚本注入，只用于区分本地浏览器和 Cloudflare 远程绑定。 */
export type ExecutionTarget = "local" | "remote";

/** 阶段值是诊断结果唯一允许的定位粒度，禁止返回内部堆栈或实现路径。 */
export type DiagnosticStage =
  | "binding-check"
  | "browser-launch"
  | "context-create"
  | "page-create"
  | "page-navigation"
  | "complete";

/** 两种操作都由服务端映射固定行为，客户端不能提供任意导航地址。 */
export type DiagnosticOperation = "launch-only" | "control-navigation";

export type DiagnosticResult =
  | {
      readonly status: "success";
      readonly executionTarget: ExecutionTarget;
      readonly stage: "complete";
      readonly elapsedMs: number;
    }
  | {
      readonly status: "failure";
      readonly executionTarget: ExecutionTarget;
      readonly stage: Exclude<DiagnosticStage, "complete">;
      readonly errorName: string;
      readonly errorCode?: string;
      readonly errorMessage: string;
      readonly elapsedMs: number;
    };

const maxNameLength = 64;
const maxMessageLength = 240;
const safeCode = /^[A-Za-z0-9._-]{1,32}$/;

function normalizeElapsedMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function redactMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[REDACTED]")
    .replace(/\b(password|token|secret)=\S+/gi, "$1=[REDACTED]")
    .replace(/(Authorization:\s*Bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxMessageLength);
}

function extractCode(error: Error & { readonly code?: unknown }): string | undefined {
  if (typeof error.code === "string" && safeCode.test(error.code)) return error.code;
  const fromMessage = error.message.match(/\bcode:\s*([A-Za-z0-9._-]{1,32})\b/i)?.[1];
  return fromMessage && safeCode.test(fromMessage) ? fromMessage : undefined;
}

export function sanitizeDiagnosticFailure(
  error: unknown,
  input: {
    readonly executionTarget: ExecutionTarget;
    readonly stage: Exclude<DiagnosticStage, "complete">;
    readonly elapsedMs: number;
  },
): DiagnosticResult {
  if (!(error instanceof Error)) {
    return {
      status: "failure",
      executionTarget: input.executionTarget,
      stage: input.stage,
      errorName: "UnknownError",
      errorMessage: "Non-Error value was thrown",
      elapsedMs: normalizeElapsedMs(input.elapsedMs),
    };
  }

  const errorCode = extractCode(error as Error & { readonly code?: unknown });
  return {
    status: "failure",
    executionTarget: input.executionTarget,
    stage: input.stage,
    errorName: (error.name || "Error").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, maxNameLength),
    ...(errorCode ? { errorCode } : {}),
    errorMessage: redactMessage(error.message),
    elapsedMs: normalizeElapsedMs(input.elapsedMs),
  };
}
```

- [ ] **Step 4：运行纯函数测试并确认通过**

Run: `npm test -- test/diagnostic-domain.test.ts`

Expected: PASS，3 个测试通过。

---

### Task 2：浏览器生命周期、阶段归因与固定普通页

**Files:**

- Create: `/tmp/switch-price-monitor-jp-browser-probe/test/launch-diagnostic.test.ts`
- Create: `/tmp/switch-price-monitor-jp-browser-probe/src/launch-diagnostic.ts`

**Interfaces:**

- Consumes: `ExecutionTarget`、`DiagnosticOperation`、`DiagnosticResult`、`sanitizeDiagnosticFailure()`。
- Produces: `DiagnosticBrowserAdapter`。
- Produces: `runLaunchDiagnostic(binding: unknown, executionTarget: ExecutionTarget, operation: DiagnosticOperation, adapter: DiagnosticBrowserAdapter, now?: () => number): Promise<DiagnosticResult>`。

- [ ] **Step 1：写入失败测试，覆盖阶段与逆序清理**

测试使用最小假资源，不加载真实浏览器。至少覆盖完整成功、绑定缺失、`launch` 失败、`newContext` 失败、`newPage` 失败、固定普通页导航失败，以及失败后仍按 `page → context → browser` 尝试清理。`control-navigation` 必须断言只访问 `https://example.com/`。

```ts
import { describe, expect, it, vi } from "vitest";
import { runLaunchDiagnostic, type DiagnosticBrowserAdapter } from "../src/launch-diagnostic";

function createAdapter(events: string[], failure?: string): DiagnosticBrowserAdapter {
  return {
    hasBinding: (binding) => binding !== undefined && binding !== null,
    launch: async () => {
      events.push("launch");
      if (failure === "browser-launch") throw new Error("launch failed code: 429");
      return {
        close: async () => { events.push("browser.close"); },
        newContext: async () => {
          events.push("context.create");
          if (failure === "context-create") throw new Error("context failed");
          return {
            close: async () => { events.push("context.close"); },
            newPage: async () => {
              events.push("page.create");
              if (failure === "page-create") throw new Error("page failed");
              return {
                close: async () => { events.push("page.close"); },
                goto: async (url) => {
                  events.push(`goto:${url}`);
                  if (failure === "page-navigation") throw new Error("navigation failed");
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("runLaunchDiagnostic", () => {
  it("launch-only 成功且按逆序关闭全部资源", async () => {
    const events: string[] = [];
    const result = await runLaunchDiagnostic({}, "local", "launch-only", createAdapter(events), vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125));
    expect(result).toEqual({ status: "success", executionTarget: "local", stage: "complete", elapsedMs: 25 });
    expect(events).toEqual(["launch", "context.create", "page.create", "page.close", "context.close", "browser.close"]);
  });

  it("普通导航只使用代码内固定测试页", async () => {
    const events: string[] = [];
    await runLaunchDiagnostic({}, "remote", "control-navigation", createAdapter(events));
    expect(events).toContain("goto:https://example.com/");
  });

  it.each([
    [undefined, undefined, "binding-check"],
    [{}, "browser-launch", "browser-launch"],
    [{}, "context-create", "context-create"],
    [{}, "page-create", "page-create"],
    [{}, "page-navigation", "page-navigation"],
  ] as const)("把 %s / %s 归因到 %s", async (binding, failure, expectedStage) => {
    const events: string[] = [];
    const result = await runLaunchDiagnostic(
      binding,
      "remote",
      failure === "page-navigation" ? "control-navigation" : "launch-only",
      createAdapter(events, failure),
    );
    expect(result).toMatchObject({ status: "failure", executionTarget: "remote", stage: expectedStage });
  });

  it("导航失败后仍按逆序清理，清理异常不覆盖原始阶段", async () => {
    const events: string[] = [];
    const adapter = createAdapter(events, "page-navigation");
    const baseLaunch = adapter.launch;
    adapter.launch = async (binding) => {
      const browser = await baseLaunch(binding);
      const baseNewContext = browser.newContext;
      browser.newContext = async () => {
        const context = await baseNewContext();
        const baseNewPage = context.newPage;
        context.newPage = async () => {
          const page = await baseNewPage();
          page.close = async () => { events.push("page.close"); throw new Error("close failed"); };
          return page;
        };
        return context;
      };
      return browser;
    };
    const result = await runLaunchDiagnostic({}, "remote", "control-navigation", adapter);
    expect(result).toMatchObject({ status: "failure", stage: "page-navigation" });
    expect(events.slice(-3)).toEqual(["page.close", "context.close", "browser.close"]);
  });
});
```

- [ ] **Step 2：运行测试并确认因模块不存在而失败**

Run: `npm test -- test/launch-diagnostic.test.ts`

Expected: FAIL，错误包含 `Cannot find module '../src/launch-diagnostic'`。

- [ ] **Step 3：实现最小生命周期编排器**

实现时用局部变量保存已创建资源；每个阶段单独捕获异常并调用 Task 1 的脱敏函数；`finally` 中逐项 `.close().catch(() => undefined)`。`control-navigation` 只调用 `page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 10_000 })`，不得接受 URL 参数。

```ts
import {
  sanitizeDiagnosticFailure,
  type DiagnosticOperation,
  type DiagnosticResult,
  type DiagnosticStage,
  type ExecutionTarget,
} from "./diagnostic-domain";

interface DiagnosticPage {
  goto(url: string, options: { readonly waitUntil: "domcontentloaded"; readonly timeout: number }): Promise<unknown>;
  close(): Promise<void>;
}

interface DiagnosticContext {
  newPage(): Promise<DiagnosticPage>;
  close(): Promise<void>;
}

interface DiagnosticBrowser {
  newContext(): Promise<DiagnosticContext>;
  close(): Promise<void>;
}

export interface DiagnosticBrowserAdapter {
  hasBinding(binding: unknown): boolean;
  launch(binding: unknown): Promise<DiagnosticBrowser>;
}

const controlPageUrl = "https://example.com/";

export async function runLaunchDiagnostic(
  binding: unknown,
  executionTarget: ExecutionTarget,
  operation: DiagnosticOperation,
  adapter: DiagnosticBrowserAdapter,
  now: () => number = Date.now,
): Promise<DiagnosticResult> {
  const startedAt = now();
  const fail = (error: unknown, stage: Exclude<DiagnosticStage, "complete">) =>
    sanitizeDiagnosticFailure(error, { executionTarget, stage, elapsedMs: now() - startedAt });

  if (!adapter.hasBinding(binding)) return fail(new Error("Browser binding is unavailable"), "binding-check");

  let browser: DiagnosticBrowser | undefined;
  let context: DiagnosticContext | undefined;
  let page: DiagnosticPage | undefined;
  try {
    try { browser = await adapter.launch(binding); } catch (error) { return fail(error, "browser-launch"); }
    try { context = await browser.newContext(); } catch (error) { return fail(error, "context-create"); }
    try { page = await context.newPage(); } catch (error) { return fail(error, "page-create"); }
    if (operation === "control-navigation") {
      try {
        await page.goto(controlPageUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
      } catch (error) {
        return fail(error, "page-navigation");
      }
    }
    return { status: "success", executionTarget, stage: "complete", elapsedMs: Math.max(0, Math.floor(now() - startedAt)) };
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
```

- [ ] **Step 4：运行生命周期测试并确认通过**

Run: `npm test -- test/launch-diagnostic.test.ts`

Expected: PASS，8 个参数化后测试用例全部通过。

---

### Task 3：固定 HTTP 入口与 Cloudflare 装配

**Files:**

- Create: `/tmp/switch-price-monitor-jp-browser-probe/test/diagnostic-http.test.ts`
- Create: `/tmp/switch-price-monitor-jp-browser-probe/src/diagnostic-http.ts`
- Modify: `/tmp/switch-price-monitor-jp-browser-probe/src/http.ts`
- Modify: `/tmp/switch-price-monitor-jp-browser-probe/src/index.ts`
- Modify: `/tmp/switch-price-monitor-jp-browser-probe/package.json`

**Interfaces:**

- Consumes: `DiagnosticOperation`、`DiagnosticResult`、`ExecutionTarget`、`runLaunchDiagnostic()`。
- Produces: `createDiagnosticWorker(executeDiagnostic)`，只处理 `POST /diagnostic/launch` 与 `POST /diagnostic/navigation`。
- Extends: `Env` 增加只读 `DIAGNOSTIC_EXECUTION_TARGET: string`。

- [ ] **Step 1：写入失败 HTTP 测试**

测试必须验证两个固定路径分别映射到 `launch-only` 和 `control-navigation`；`GET`、未知路径、带 `url` 查询参数、非法执行目标均不得启动浏览器；成功响应设置 `no-store` 且只包含执行器返回的白名单结果。

```ts
import type { BrowserWorker } from "@cloudflare/playwright";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosticWorker } from "../src/diagnostic-http";

describe("diagnostic HTTP boundary", () => {
  const binding = {} as BrowserWorker;

  it.each([
    ["/diagnostic/launch", "launch-only"],
    ["/diagnostic/navigation", "control-navigation"],
  ] as const)("把 %s 映射到固定操作 %s", async (path, operation) => {
    const execute = vi.fn(async () => ({
      status: "success" as const,
      executionTarget: "local" as const,
      stage: "complete" as const,
      elapsedMs: 5,
    }));
    const response = await createDiagnosticWorker(execute).fetch(
      new Request(`http://127.0.0.1:8791${path}`, { method: "POST" }),
      { BROWSER: binding, DIAGNOSTIC_EXECUTION_TARGET: "local" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(execute).toHaveBeenCalledWith(binding, "local", operation);
  });

  it.each([
    ["GET", "/diagnostic/launch", "local", 405],
    ["POST", "/diagnostic/unknown", "local", 404],
    ["POST", "/diagnostic/navigation?url=https://attacker.test", "local", 400],
    ["POST", "/diagnostic/launch", "staging", 500],
  ])("拒绝 %s %s / %s", async (method, path, target, expectedStatus) => {
    const execute = vi.fn();
    const response = await createDiagnosticWorker(execute).fetch(
      new Request(`http://127.0.0.1:8791${path}`, { method }),
      { BROWSER: binding, DIAGNOSTIC_EXECUTION_TARGET: target },
    );
    expect(response.status).toBe(expectedStatus);
    expect(execute).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2：运行测试并确认因模块不存在而失败**

Run: `npm test -- test/diagnostic-http.test.ts`

Expected: FAIL，错误包含 `Cannot find module '../src/diagnostic-http'`。

- [ ] **Step 3：实现固定 HTTP 边界并更新环境类型**

`diagnostic-http.ts` 只允许无查询参数的两个固定路径；非法 `DIAGNOSTIC_EXECUTION_TARGET` 返回固定错误，不回显环境变量。`http.ts` 的 `Env` 增加中文注释说明该变量不是密钥，只能由固定脚本设置为 `local` 或 `remote`。

```ts
import type { BrowserWorker } from "@cloudflare/playwright";
import type { DiagnosticOperation, DiagnosticResult, ExecutionTarget } from "./diagnostic-domain";
import type { Env } from "./http";

export type DiagnosticExecutor = (
  binding: BrowserWorker,
  executionTarget: ExecutionTarget,
  operation: DiagnosticOperation,
) => Promise<DiagnosticResult>;

const operations = new Map<string, DiagnosticOperation>([
  ["/diagnostic/launch", "launch-only"],
  ["/diagnostic/navigation", "control-navigation"],
]);

export function createDiagnosticWorker(executeDiagnostic: DiagnosticExecutor) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const operation = operations.get(url.pathname);
      if (!operation) return new Response("Not Found", { status: 404 });
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (url.search !== "") return new Response("Query parameters are not allowed", { status: 400 });
      if (env.DIAGNOSTIC_EXECUTION_TARGET !== "local" && env.DIAGNOSTIC_EXECUTION_TARGET !== "remote") {
        return new Response("Diagnostic target is not configured", { status: 500 });
      }
      return Response.json(
        await executeDiagnostic(env.BROWSER, env.DIAGNOSTIC_EXECUTION_TARGET, operation),
        { headers: { "cache-control": "no-store" } },
      );
    },
  };
}
```

- [ ] **Step 4：装配实际 Playwright 适配器**

修改 `index.ts`，保持原 `/probe` 路由不变；诊断路径交给 `createDiagnosticWorker()`。适配器只负责把 Cloudflare 类型映射到 Task 2 的最小接口，不捕获异常，确保异常统一由脱敏边界处理。

```ts
import { launch, type BrowserWorker } from "@cloudflare/playwright";
import { createDiagnosticWorker } from "./diagnostic-http";
import { createProbeWorker, type Env } from "./http";
import { runLaunchDiagnostic, type DiagnosticBrowserAdapter } from "./launch-diagnostic";
import { runJapaneseUpgradeProbe } from "./probe";

const adapter: DiagnosticBrowserAdapter = {
  // Browser Binding 是平台对象；这里只检查是否注入，不读取或记录绑定内部状态。
  hasBinding: (binding) => binding !== undefined && binding !== null,
  launch: (binding) => launch(binding as BrowserWorker),
};

const diagnosticWorker = createDiagnosticWorker((binding, target, operation) =>
  runLaunchDiagnostic(binding, target, operation, adapter));
const probeWorker = createProbeWorker(runJapaneseUpgradeProbe);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 固定诊断前缀与任天堂探针分流，禁止诊断参数污染正式关系提取路径。
    if (new URL(request.url).pathname.startsWith("/diagnostic/")) {
      return diagnosticWorker.fetch(request, env);
    }
    return probeWorker.fetch(request, env);
  },
};
```

- [ ] **Step 5：增加固定本地/远程运行脚本**

修改 `package.json` 的 `scripts`；中文 `_comments` 同步说明环境标签只是诊断元数据，不是权限或密钥。

```json
{
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "dev:local": "wrangler dev --ip 127.0.0.1 --port 8791 --var DIAGNOSTIC_EXECUTION_TARGET:local",
    "dev:remote": "wrangler dev --remote --ip 127.0.0.1 --port 8791 --var DIAGNOSTIC_EXECUTION_TARGET:remote"
  }
}
```

- [ ] **Step 6：运行新增测试、全量临时测试和类型检查**

Run: `npm test -- test/diagnostic-http.test.ts && npm test && npm run typecheck`

Expected: 新增 HTTP 测试通过；临时项目 5 个测试文件全部通过；TypeScript exit 0。

---

### Task 4：本地/远程 A/B 证据采集

**Files:**

- Create: `/tmp/jp-browser-launch-local.json`
- Create when allowed: `/tmp/jp-browser-launch-remote.json`
- Create only after remote launch success: `/tmp/jp-browser-navigation-remote.json`

**Interfaces:**

- Consumes: `POST /diagnostic/launch`、`POST /diagnostic/navigation`。
- Produces: 三份只含 `DiagnosticResult` 白名单字段的临时证据和明确停止点。

- [ ] **Step 1：启动本地浏览器诊断会话**

Run: `npm run dev:local`

Workdir: `/tmp/switch-price-monitor-jp-browser-probe`

Expected: Wrangler 监听 `127.0.0.1:8791`，不创建持久 Worker，不连接生产绑定。

- [ ] **Step 2：执行一次本地 launch-only 并校验白名单**

Run: `curl --fail-with-body --silent --show-error --request POST --output /tmp/jp-browser-launch-local.json http://127.0.0.1:8791/diagnostic/launch`

Expected: JSON 只含规格允许字段。若 `status` 不是 `success`，立即停止 Task 4，依据 `stage/errorCode/errorMessage` 形成单一根因假设；不得运行远程诊断。

- [ ] **Step 3：本地成功后终止会话，再启动一次远程诊断会话**

Run: `npm run dev:remote`

Expected: Wrangler 以临时远程开发模式监听本机入口；没有生产 D1、Cron、Assets、Secrets 或生产路由。若命令需要联网权限，执行前使用系统审批流程。

- [ ] **Step 4：执行一次远程 launch-only 并校验白名单**

Run: `curl --fail-with-body --silent --show-error --request POST --output /tmp/jp-browser-launch-remote.json http://127.0.0.1:8791/diagnostic/launch`

Expected: 若成功，继续 Step 5；若失败，立即终止远程会话，不访问普通页或任天堂，并按以下证据规则处理：

- `429`、每日时间或实例频率提示：记录平台限制并等待官方窗口恢复，不改代码；
- `binding-check`：只核验 Wrangler 实际绑定注入和固定脚本，不改页面逻辑；
- 权限或鉴权提示：记录所需 Cloudflare 权限并请求管理员处理，不提交凭据；
- 平台 5xx 或暂时不可用：记录时间和错误码，停止本轮，不以循环重试覆盖证据；
- 其他错误：回到系统化调试的模式比较阶段，基于精确错误形成一个新假设后再修改计划。

- [ ] **Step 5：仅在远程启动成功后执行固定普通页导航**

Run: `curl --fail-with-body --silent --show-error --request POST --output /tmp/jp-browser-navigation-remote.json http://127.0.0.1:8791/diagnostic/navigation`

Expected: `status: "success"`。失败时记录 `page-navigation` 证据并停止，不访问任天堂。

- [ ] **Step 6：终止远程开发会话并确认无持久部署**

Run: `npx wrangler deployments list --name switch-price-monitor-jp-upgrade-probe`

Expected: 没有因本次 `wrangler dev` 新建持久生产部署；若平台返回 Worker 不存在，同样视为符合隔离要求。

---

### Task 5：任天堂探针恢复验证与结果归档

**Files:**

- Create only after Task 4 passes: `/tmp/jp-upgrade-probe-retry-{1,2,3}.json`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/superpowers/specs/2026-07-19-browser-run-launch-failure-diagnostic-design.md`
- Modify: `docs/README.md`

**Interfaces:**

- Consumes: 原有 `POST /probe` 和 Task 4 的三份诊断结果。
- Produces: 可审计的根因结论；仅当三次任天堂结果全部成功时，产生“允许进入生产设计”的结论。

- [ ] **Step 1：只有 Task 4 三项均成功时，执行一次任天堂单次验证**

Run: `curl --fail-with-body --silent --show-error --request POST http://127.0.0.1:8791/probe`

Expected: 唯一成功结果必须是 `https://store-jp.nintendo.com/item/software/D70050000064985/`。任意失败都立即停止，不追加三次验证。

- [ ] **Step 2：单次成功后串行执行三次全新实例验证**

每次运行前重新启动远程开发会话或确保探针的 `launch()` 创建全新实例；相邻启动至少满足 Cloudflare 当前官方频率限制。分别把白名单 JSON 保存到 `/tmp/jp-upgrade-probe-retry-1.json`、`-2.json`、`-3.json`，不得覆盖任何失败样本。

Expected: 三次均在 30 秒内返回同一个升级包 URL，才把结果标记为通过；任意一次失败即维持人工官方链接兜底。

- [ ] **Step 3：运行临时项目最终质量门禁**

Run: `npm test && npm run typecheck`

Expected: 全部测试通过，TypeScript exit 0，中文注释与实现一致。

- [ ] **Step 4：把允许字段和结论写入项目文档**

文档必须记录每个实际执行阶段的开始时间、白名单结果、停止点、已证实根因和未执行步骤；不得写入完整堆栈、页面内容或凭据。若根因需要代码或配置修复，先把证据和单一假设补入本计划，再按 TDD 增加精确修复任务，不能直接猜测修改。

- [ ] **Step 5：检查项目仓库没有临时代码或敏感结果**

Run: `git status --short && git diff --check && rg -n "Bearer |password=|token=|secret=" docs`

Expected: Git 只显示批准的文档变更；敏感模式扫描不出现本次诊断凭据或真实令牌。

- [ ] **Step 6：提交前向管理员列出范围并取得确认**

拟提交范围仅可包含本规格、实施计划、索引和最终质量结论。获得明确确认后，在同一操作中执行 `git add`、`git commit` 与 `git push origin main`；未确认时保持未提交状态。

---

## 计划自检

- 规格覆盖：异常脱敏、阶段诊断、本地/远程对照、普通页隔离、任天堂准入、资源清理、文档与提交边界均映射到具体任务。
- 占位扫描：计划没有 `TBD`、`TODO`、“稍后实现”或未定义函数；未知根因被设计为证据停点，而不是伪造的条件修复代码。
- 类型一致性：`ExecutionTarget`、`DiagnosticStage`、`DiagnosticOperation`、`DiagnosticResult`、`DiagnosticBrowserAdapter` 和三个公开函数的名称在任务间一致。
- 安全一致性：客户端只能选择两个固定诊断操作，不能指定目标 URL；脱敏发生在 HTTP 返回之前；临时结果不进入 Git。
- 流程一致性：任何阶段失败都会阻止后续网络访问；三次任天堂验证仍沿用原准入门槛，诊断成功不等于生产集成获批。
