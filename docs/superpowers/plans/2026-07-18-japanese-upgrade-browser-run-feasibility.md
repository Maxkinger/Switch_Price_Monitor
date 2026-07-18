# 日区升级包 Browser Run 可行性验证实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本项目当前只允许在本会话内执行，不启用子代理，除非管理员另行明确要求。

**Goal:** 在不修改或部署生产应用的前提下，用隔离的 Cloudflare Browser Run 探针对任天堂日区已知正向样本连续执行三次只读验证，判断官方升级关系链接能否稳定发现。

**Architecture:** 计划文档保存在项目仓库，实际探针仅创建于 `/tmp/switch-price-monitor-jp-browser-probe`。纯函数负责官方 URL、可见文字、唯一性和三次结果门槛；临时 Worker 只在 `wrangler dev --remote` 会话中启动 Playwright Browser Binding，通过绑定在 `127.0.0.1:8791` 的本地入口触发真实远程浏览器，不连接生产 D1、Static Assets、Cron、Secrets 或生产路由。

**Tech Stack:** Node.js、TypeScript 5.8.3、Vitest 4.1.0、Wrangler 4.31.0、`@cloudflare/workers-types` 4.20260702.1、`@cloudflare/playwright` 1.3.0、Cloudflare Browser Run、任天堂日区公开商品页。

## Global Constraints

- 执行每个代码、测试、配置或文档改动前，必须完整阅读项目 `AGENTS.md` 和 `docs/README.md`。
- 所有临时源代码、测试和配置仍须包含中文详细注释，说明职责、数据约束、边界条件和安全原因；注释必须与实现一致。
- 严格测试先行：每项行为先运行新增测试并确认因缺少目标实现而失败，再写最小实现并运行通过。
- 探针只能访问 `https://store-jp.nintendo.com/item/software/D70010000106252/`，不得访问第三方站点、搜索引擎、Nintendo Account、登录、购物车或购买接口。
- 目标关系必须是可见文字包含 `アップグレードパス` 的 HTTPS 链接，精确主机为 `store-jp.nintendo.com`，路径符合 `^/item/software/D[0-9]+/?$`；官方页面可能省略末尾斜杠，接受后必须统一规范化为带斜杠 URL，去重后必须恰好一个。
- 单次探测从启动到返回的成功耗时必须小于 30,000 毫秒；三次独立实例串行运行，相邻实例至少间隔 20 秒，不复用 Cookie、缓存、存储或 Browser Run session。
- 只允许输出 `status`、`upgradeUrl`、`linkText`、`elapsedMs`；不得保存页面 HTML、Cookie、localStorage、IndexedDB、排队令牌、请求头、响应头、截图、网络归档或异常堆栈。
- 三次必须全部成功且 URL 均为 `https://store-jp.nintendo.com/item/software/D70050000064985/`，才可判定“允许进入生产设计”；成功不代表生产集成获批。
- 探针不修改项目 `package.json`、`package-lock.json`、`wrangler.jsonc`、`src/`、`test/`、D1、Cron、生产 Secrets 或版本号，也不运行生产部署命令。
- 不自动提交或推送。任何结果文档准备提交时，先列出完整范围并取得管理员明确确认，随后在同一操作中执行 `git commit` 与 `git push origin main`。

---

## 文件结构与职责

### 项目仓库

- `docs/superpowers/plans/2026-07-18-japanese-upgrade-browser-run-feasibility.md`：本实施计划，不包含运行凭据或探针结果正文。
- `docs/superpowers/specs/2026-07-18-japanese-upgrade-pack-relation-discovery-design.md`：探针完成后只更新通过或失败状态，不改变已批准的成功门槛。
- `docs/quality/quality-and-acceptance.md`：探针完成后记录只含允许字段的三次结果与结论。
- `docs/README.md`：索引本计划，并在探针完成后同步阶段状态。

### 临时目录，不进入 Git

- `/tmp/switch-price-monitor-jp-browser-probe/package.json`：锁定临时探针依赖与测试、类型检查、远程开发命令。
- `/tmp/switch-price-monitor-jp-browser-probe/package-lock.json`：由 `npm install` 生成，只约束本次临时环境。
- `/tmp/switch-price-monitor-jp-browser-probe/tsconfig.json`：严格 TypeScript、Worker、DOM 与 Vitest 类型边界。
- `/tmp/switch-price-monitor-jp-browser-probe/wrangler.jsonc`：独立 Worker 名称与 Browser Binding；远程模式和本地监听由固定 `wrangler dev --remote` 脚本提供，不含 D1、Cron、Assets 或 Secrets。
- `/tmp/switch-price-monitor-jp-browser-probe/src/probe-domain.ts`：纯函数校验可见关系、官方 URL、去重唯一性与允许的结果类型。
- `/tmp/switch-price-monitor-jp-browser-probe/src/probe.ts`：启动全新 Browser Run 实例、导航、轮询可见链接、归一化错误并确保关闭会话。
- `/tmp/switch-price-monitor-jp-browser-probe/src/http.ts`：可由 Node/Vitest 直接加载的纯 HTTP 适配器，只接受本地 `POST /probe` 并通过依赖注入调用探针。
- `/tmp/switch-price-monitor-jp-browser-probe/src/index.ts`：Cloudflare 专用装配入口，只负责把 Browser Run 实现注入纯 HTTP 适配器；该分离避免 Node 测试加载 `cloudflare:workers` 协议。
- `/tmp/switch-price-monitor-jp-browser-probe/test/probe-domain.test.ts`：官方链接与安全拒绝边界测试。
- `/tmp/switch-price-monitor-jp-browser-probe/test/index.test.ts`：HTTP 方法、路径、无缓存响应和最小字段测试。
- `/tmp/jp-upgrade-probe-run-{1,2,3}.json`：三次真实运行允许字段的临时结果；不进入 Git。

## Task 1：建立隔离临时项目与纯函数安全边界

**Files:**

- Create: `/tmp/switch-price-monitor-jp-browser-probe/package.json`
- Create: `/tmp/switch-price-monitor-jp-browser-probe/tsconfig.json`
- Create: `/tmp/switch-price-monitor-jp-browser-probe/wrangler.jsonc`
- Create: `/tmp/switch-price-monitor-jp-browser-probe/test/probe-domain.test.ts`
- Create: `/tmp/switch-price-monitor-jp-browser-probe/src/probe-domain.ts`
- Test: `/tmp/switch-price-monitor-jp-browser-probe/test/probe-domain.test.ts`

**Interfaces:**

- Produces: `ProbeStatus`、`CandidateLink`、`UpgradeLinkSelection`、`ProbeResult`。
- Produces: `selectOfficialUpgradeLink(candidates: readonly CandidateLink[]): UpgradeLinkSelection`。
- Consumes: 无项目生产模块、配置或数据。

- [x] **Step 1：创建临时目录和带中文约束说明的独立配置**

  Run: `mkdir -p /tmp/switch-price-monitor-jp-browser-probe/src /tmp/switch-price-monitor-jp-browser-probe/test`

  使用 `apply_patch` 创建以下 `package.json`；`_comments` 是 npm 忽略的说明字段，用于在不破坏 JSON 的前提下记录隔离和安全原因：

  ```json
  {
    "name": "switch-price-monitor-jp-upgrade-probe",
    "private": true,
    "version": "0.0.0",
    "type": "module",
    "_comments": [
      "本包只服务一次日区升级关系可行性验证，不得并入生产依赖或触发生产版本递增。",
      "远程开发入口仅绑定 127.0.0.1；Browser Run 只读取公开商品页，不接入 D1、Cron、Secrets 或用户会话。"
    ],
    "scripts": {
      "test": "vitest run",
      "typecheck": "tsc --noEmit",
      "dev:remote": "wrangler dev --remote --ip 127.0.0.1 --port 8791"
    },
    "devDependencies": {
      "@cloudflare/playwright": "1.3.0",
      "@cloudflare/workers-types": "4.20260702.1",
      "typescript": "5.8.3",
      "vitest": "4.1.0",
      "wrangler": "4.31.0"
    }
  }
  ```

  使用 `apply_patch` 创建 `tsconfig.json`：

  ```jsonc
  {
    // 临时探针仍启用严格类型检查，防止把任天堂页面数据或 Browser Binding 当作任意可信值。
    "compilerOptions": {
      "target": "ES2022",
      "lib": ["ES2022", "DOM", "DOM.Iterable"],
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "strict": true,
      "noEmit": true,
      "skipLibCheck": true,
      // 只声明 Worker 和 Vitest 所需类型，不引入项目生产前端或 D1 类型。
      "types": ["@cloudflare/workers-types", "vitest/globals"]
    },
    "include": ["src", "test"]
  }
  ```

  使用 `apply_patch` 创建 `wrangler.jsonc`：

  ```jsonc
  {
    "$schema": "./node_modules/wrangler/config-schema.json",
    // 使用与生产项目不同的名称；远程开发代码不会覆盖 switch-price-monitor Worker。
    "name": "switch-price-monitor-jp-upgrade-probe",
    "main": "src/index.ts",
    "workers_dev": true,
    "compatibility_date": "2026-07-18",
    // @cloudflare/playwright 1.3.0 依赖原生 Node.js API；官方要求启用 nodejs_compat。
    "compatibility_flags": ["nodejs_compat"],
    // 真实远程模式由固定的 wrangler dev --remote 脚本提供；Wrangler 4.31.0 的 Browser schema 不接受重复 remote 字段。
    "browser": {
      "binding": "BROWSER"
    }
  }
  ```

- [x] **Step 2：在获准联网后安装临时依赖**

  Run: `npm install`

  Workdir: `/tmp/switch-price-monitor-jp-browser-probe`

  Expected: exit 0，并只在临时目录生成 `node_modules` 和 `package-lock.json`；项目仓库 `git status --short` 仍为空。

- [x] **Step 3：先写失败测试，锁定官方 URL、可见文字和唯一性**

  使用 `apply_patch` 创建 `test/probe-domain.test.ts`：

  ```ts
  import { describe, expect, it } from "vitest";
  import { selectOfficialUpgradeLink } from "../src/probe-domain";

  describe("selectOfficialUpgradeLink", () => {
    it("accepts one visible official upgrade-pass link and canonicalizes its identity", () => {
      // 查询参数和片段不属于商品身份；结果必须收敛到精确官方主机与软件路径。
      expect(selectOfficialUpgradeLink([{
        href: "https://store-jp.nintendo.com/item/software/D70050000064985/?source=parent#buy",
        text: "アップグレードパス",
        visible: true,
      }])).toEqual({
        status: "success",
        upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/",
        linkText: "アップグレードパス",
      });
    });

    it("deduplicates repeated anchors only when they resolve to the same official product", () => {
      // 同一响应式页面可能重复桌面和移动链接；相同规范 URL 只算一个关系。
      expect(selectOfficialUpgradeLink([
        { href: "/item/software/D70050000064985/", text: "アップグレードパス", visible: true },
        { href: "https://store-jp.nintendo.com/item/software/D70050000064985/", text: "アップグレードパスを購入", visible: true },
      ])).toMatchObject({ status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/" });
    });

    it.each([
      [[{ href: "/item/software/D70050000064985/", text: "追加コンテンツ", visible: true }], "blocked-or-missing"],
      [[{ href: "/item/software/D70050000064985/", text: "アップグレードパス", visible: false }], "blocked-or-missing"],
      [[{ href: "https://example.com/item/software/D70050000064985/", text: "アップグレードパス", visible: true }], "invalid-official-url"],
      [[{ href: "http://store-jp.nintendo.com/item/software/D70050000064985/", text: "アップグレードパス", visible: true }], "invalid-official-url"],
      [[{ href: "https://store-jp.nintendo.com:8443/item/software/D70050000064985/", text: "アップグレードパス", visible: true }], "invalid-official-url"],
      [[{ href: "https://store-jp.nintendo.com/item/software/not-a-product/", text: "アップグレードパス", visible: true }], "invalid-official-url"],
    ] as const)("rejects non-provable relation %#", (candidates, status) => {
      // 隐藏、错误文字、外部主机、非 HTTPS、自定义端口和错误路径都不能成为商品关系证据。
      expect(selectOfficialUpgradeLink(candidates)).toEqual({ status });
    });

    it("rejects multiple different official upgrade products instead of choosing DOM order", () => {
      expect(selectOfficialUpgradeLink([
        { href: "/item/software/D70050000064985/", text: "アップグレードパス", visible: true },
        { href: "/item/software/D70050000099999/", text: "アップグレードパス", visible: true },
      ])).toEqual({ status: "multiple-matches" });
    });
  });
  ```

- [x] **Step 4：运行测试并确认 RED**

  Run: `npm test -- test/probe-domain.test.ts`

  Workdir: `/tmp/switch-price-monitor-jp-browser-probe`

  Expected: FAIL，错误明确为无法解析 `../src/probe-domain`；失败原因必须是目标实现尚不存在，而不是依赖或配置错误。

- [x] **Step 5：实现最小纯函数与结果类型**

  使用 `apply_patch` 创建 `src/probe-domain.ts`：

  ```ts
  /**
   * 探针只输出受控状态，不暴露页面正文、Cookie、队列令牌、请求细节或异常堆栈。
   * 这些值同时是 HTTP 响应和验收记录的唯一允许错误分类。
   */
  export type ProbeStatus =
    | "success"
    | "timeout"
    | "blocked-or-missing"
    | "multiple-matches"
    | "invalid-official-url"
    | "browser-launch-failed"
    | "unexpected-error";

  /** 页面适配层只能向纯函数提供最小链接事实，不能传入完整 DOM 或 HTML。 */
  export interface CandidateLink {
    readonly href: string;
    readonly text: string;
    readonly visible: boolean;
  }

  export type UpgradeLinkSelection =
    | { readonly status: "success"; readonly upgradeUrl: string; readonly linkText: string }
    | { readonly status: "blocked-or-missing" | "multiple-matches" | "invalid-official-url" };

  export type ProbeResult =
    | { readonly status: "success"; readonly upgradeUrl: string; readonly linkText: string; readonly elapsedMs: number }
    | { readonly status: Exclude<ProbeStatus, "success">; readonly elapsedMs: number };

  const parentPageUrl = "https://store-jp.nintendo.com/item/software/D70010000106252/";
  const officialHost = "store-jp.nintendo.com";
  const officialProductPath = /^\/item\/software\/(D[0-9]+)\/?$/;
  const relationLabel = "アップグレードパス";

  function canonicalizeOfficialProductUrl(rawHref: string): string | null {
    try {
      const url = new URL(rawHref, parentPageUrl);
      // 凭据、自定义端口、非 HTTPS、相似主机和宽松路径均可能把探针变成开放抓取器，必须拒绝。
    const productMatch = url.pathname.match(officialProductPath);
    if (
      url.protocol !== "https:" ||
      url.hostname !== officialHost ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      productMatch === null
    ) {
      return null;
    }
    return `https://${officialHost}/item/software/${productMatch[1]}/`;
    } catch {
      return null;
    }
  }

  export function selectOfficialUpgradeLink(candidates: readonly CandidateLink[]): UpgradeLinkSelection {
    const namedVisibleLinks = candidates.filter(
      (candidate) => candidate.visible && candidate.text.includes(relationLabel),
    );
    if (namedVisibleLinks.length === 0) return { status: "blocked-or-missing" };

    const canonicalLinks = namedVisibleLinks.map((candidate) => ({
      candidate,
      canonicalUrl: canonicalizeOfficialProductUrl(candidate.href),
    }));
    // 页面只要出现一个同名但不合规的链接，就不应忽略风险后继续接受另一个链接。
    if (canonicalLinks.some(({ canonicalUrl }) => canonicalUrl === null)) {
      return { status: "invalid-official-url" };
    }

    const uniqueLinks = new Map<string, string>();
    for (const { candidate, canonicalUrl } of canonicalLinks) {
      uniqueLinks.set(canonicalUrl as string, candidate.text.trim());
    }
    if (uniqueLinks.size !== 1) return { status: "multiple-matches" };

    const [[upgradeUrl, linkText]] = uniqueLinks;
    return { status: "success", upgradeUrl, linkText };
  }
  ```

- [x] **Step 6：运行 GREEN、类型检查和仓库隔离检查**

  Run: `npm test -- test/probe-domain.test.ts`

  Run: `npm run typecheck`

  Workdir: `/tmp/switch-price-monitor-jp-browser-probe`

  Run: `git status --short`

  Workdir: `/Users/c/Documents/workspace/Switch_Price_Monitor`

  Expected: 定向测试和类型检查 exit 0；项目仓库只显示本计划及 `docs/README.md` 的文档改动，不出现根 `package.json`、锁文件、生产 `src/`、`test/` 或 `wrangler.jsonc` 改动。

- [x] **Step 7：临时代码不提交**

  本任务只在 `/tmp` 形成可复核检查点，不执行 `git add`、`git commit` 或 `git push`。原因是探针不是生产功能，合并临时代码会违反已批准的隔离边界。

## Task 2：实现受控 Browser Run 探测和本地 HTTP 入口

**Files:**

- Create: `/tmp/switch-price-monitor-jp-browser-probe/test/index.test.ts`
- Create: `/tmp/switch-price-monitor-jp-browser-probe/src/probe.ts`
- Create: `/tmp/switch-price-monitor-jp-browser-probe/src/http.ts`
- Create: `/tmp/switch-price-monitor-jp-browser-probe/src/index.ts`
- Test: `/tmp/switch-price-monitor-jp-browser-probe/test/index.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `CandidateLink`、`ProbeResult`、`selectOfficialUpgradeLink`。
- Produces: `runJapaneseUpgradeProbe(browserBinding: BrowserWorker): Promise<ProbeResult>`。
- Produces: `createProbeWorker(executeProbe?: ProbeExecutor)`，只处理 `POST /probe`。

- [x] **Step 1：先写失败测试，锁定本地入口和最小响应**

  使用 `apply_patch` 创建 `test/index.test.ts`：

  ```ts
  import type { BrowserWorker } from "@cloudflare/playwright";
  import { describe, expect, it, vi } from "vitest";
  import { createProbeWorker } from "../src/http";

  describe("temporary probe worker", () => {
    const binding = {} as BrowserWorker;

    it("accepts only POST /probe and returns no-store JSON with allowed fields", async () => {
      // HTTP 层不得拼接目标 URL或返回调试正文；浏览器只执行代码内固定的官方样本。
      const executeProbe = vi.fn(async () => ({
        status: "success" as const,
        upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/",
        linkText: "アップグレードパス",
        elapsedMs: 1200,
      }));
      const worker = createProbeWorker(executeProbe);

      const response = await worker.fetch(
        new Request("http://127.0.0.1:8791/probe", { method: "POST" }),
        { BROWSER: binding },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        status: "success",
        upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/",
        linkText: "アップグレードパス",
        elapsedMs: 1200,
      });
      expect(executeProbe).toHaveBeenCalledWith(binding);
    });

    it.each([
      ["GET", "/probe", 405],
      ["POST", "/", 404],
      ["POST", "/probe/other", 404],
    ])("rejects %s %s without launching a browser", async (method, path, expectedStatus) => {
      // 除单一本地触发入口外不提供健康页、参数化代理或浏览器调试接口。
      const executeProbe = vi.fn();
      const response = await createProbeWorker(executeProbe).fetch(
        new Request(`http://127.0.0.1:8791${path}`, { method }),
        { BROWSER: binding },
      );
      expect(response.status).toBe(expectedStatus);
      expect(executeProbe).not.toHaveBeenCalled();
    });
  });
  ```

- [x] **Step 2：运行测试并确认 RED**

  Run: `npm test -- test/index.test.ts`

  Workdir: `/tmp/switch-price-monitor-jp-browser-probe`

  Expected: FAIL，错误明确为无法解析 `../src/http`。

- [x] **Step 3：实现 30 秒无持久状态 Browser Run 探测器**

  使用 `apply_patch` 创建 `src/probe.ts`：

  ```ts
  import { launch, type BrowserWorker } from "@cloudflare/playwright";
  import {
    selectOfficialUpgradeLink,
    type CandidateLink,
    type ProbeResult,
  } from "./probe-domain";

  const targetUrl = "https://store-jp.nintendo.com/item/software/D70010000106252/";
  const probeBudgetMs = 30_000;
  const pollIntervalMs = 250;

  function failure(status: Exclude<ProbeResult["status"], "success">, startedAt: number): ProbeResult {
    return { status, elapsedMs: Date.now() - startedAt };
  }

  function isTimeout(error: unknown): boolean {
    return error instanceof Error && /timeout/i.test(`${error.name} ${error.message}`);
  }

  export async function runJapaneseUpgradeProbe(browserBinding: BrowserWorker): Promise<ProbeResult> {
    const startedAt = Date.now();
    let browser: Awaited<ReturnType<typeof launch>>;
    try {
      // 每次 HTTP 请求都启动新实例；禁止 acquire/connect 或 keep_alive，确保三次结果不继承排队 Cookie。
      browser = await launch(browserBinding);
    } catch {
      return failure("browser-launch-failed", startedAt);
    }

    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const remainingAfterLaunch = probeBudgetMs - (Date.now() - startedAt);
        if (remainingAfterLaunch <= 0) return failure("timeout", startedAt);

        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: remainingAfterLaunch,
        });

        while (Date.now() - startedAt < probeBudgetMs) {
          // 只把链接地址、公开文字与可见性传给纯函数；不读取或返回完整 HTML、Cookie 和网络响应。
          const candidates = await page.locator("a").evaluateAll((anchors): CandidateLink[] => anchors.map((node) => {
            const anchor = node as HTMLAnchorElement;
            const style = window.getComputedStyle(anchor);
            const rect = anchor.getBoundingClientRect();
            return {
              href: anchor.href,
              text: anchor.innerText.trim(),
              visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
            };
          }));
          const selection = selectOfficialUpgradeLink(candidates);
          if (selection.status === "success") {
            return { ...selection, elapsedMs: Date.now() - startedAt };
          }
          if (selection.status !== "blocked-or-missing") {
            return failure(selection.status, startedAt);
          }
          const remaining = probeBudgetMs - (Date.now() - startedAt);
          if (remaining <= 0) break;
          await page.waitForTimeout(Math.min(pollIntervalMs, remaining));
        }
        return failure("blocked-or-missing", startedAt);
      } finally {
        // 关闭失败不能覆盖主探测结果，也不得留下可被下一次复用的页面状态。
        await context.close().catch(() => undefined);
      }
    } catch (error) {
      return failure(isTimeout(error) ? "timeout" : "unexpected-error", startedAt);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
  ```

- [x] **Step 4：实现无参数、无缓存的纯 HTTP 适配器和 Cloudflare 装配入口**

  使用 `apply_patch` 创建 `src/http.ts`：

  ```ts
  import type { BrowserWorker } from "@cloudflare/playwright";
  import type { ProbeResult } from "./probe-domain";

  export interface Env {
    readonly BROWSER: BrowserWorker;
  }

  export type ProbeExecutor = (binding: BrowserWorker) => Promise<ProbeResult>;

  export function createProbeWorker(executeProbe: ProbeExecutor) {
    return {
      async fetch(request: Request, env: Env): Promise<Response> {
        const { pathname } = new URL(request.url);
        if (pathname !== "/probe") return new Response("Not Found", { status: 404 });
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

        // 响应只包含 ProbeResult 白名单字段；no-store 防止本地代理或浏览器缓存一次性验证证据。
        return Response.json(await executeProbe(env.BROWSER), {
          headers: { "cache-control": "no-store" },
        });
      },
    };
  }
  ```

  使用 `apply_patch` 创建 `src/index.ts`；只有该装配入口加载 Cloudflare 专用运行时代码，普通 Node 测试不导入它：

  ```ts
  import { createProbeWorker } from "./http";
  import { runJapaneseUpgradeProbe } from "./probe";

  export default createProbeWorker(runJapaneseUpgradeProbe);
  ```

- [x] **Step 5：运行 GREEN、全量临时测试和类型检查**

  Run: `npm test`

  Run: `npm run typecheck`

  Workdir: `/tmp/switch-price-monitor-jp-browser-probe`

  Expected: 两个测试文件全部 PASS，TypeScript exit 0；若 `@cloudflare/playwright` 的实际类型签名与计划不同，只做保持接口和安全边界不变的最小类型修正，并同步更新中文注释，不改变目标 URL、30 秒预算或输出字段。

- [x] **Step 6：再次确认没有生产改动或敏感数据**

  Run: `git status --short`

  Run: `git diff --check`

  Workdir: `/Users/c/Documents/workspace/Switch_Price_Monitor`

  Expected: 只有计划与索引文档改动；没有生产代码、依赖、配置、锁文件或版本号变化。以 `rg` 检查临时目录时不得发现 `COOKIE`、`CF_API_TOKEN`、`TELEGRAM_BOT_TOKEN`、D1 ID 或生产 Worker 域名。

- [x] **Step 7：临时代码不提交**

  本任务仍不执行 Git 写操作；只有真实三次验证完成后的项目文档才进入后续提交确认范围。

## Task 3：执行三次真实远程探测并记录准入结论

**Files:**

- Create during execution: `/tmp/jp-upgrade-probe-run-1.json`
- Create during execution: `/tmp/jp-upgrade-probe-run-2.json`
- Create during execution: `/tmp/jp-upgrade-probe-run-3.json`
- Modify after result: `docs/superpowers/specs/2026-07-18-japanese-upgrade-pack-relation-discovery-design.md`
- Modify after result: `docs/quality/quality-and-acceptance.md`
- Modify after result: `docs/README.md`

**Interfaces:**

- Consumes: Task 2 的本地 `POST http://127.0.0.1:8791/probe`。
- Produces: 三个 `ProbeResult` JSON 和唯一的 `passed` / `failed` 准入结论。
- Produces: 若 `passed`，只允许开始新的生产设计；若 `failed`，维持人工日区官方链接兜底。

- [x] **Step 1：执行前重新核对 Cloudflare 官方限制和账号状态**

  只读取以下官方页面并确认：Playwright 仍要求 `nodejs_compat` 和兼容日期不早于 `2025-09-15`；Browser Run Free 仍至少提供每天 10 分钟、3 个并发实例和每 20 秒 1 个新实例；`wrangler dev --remote` 仍支持 Browser Run Binding。

  - `https://developers.cloudflare.com/browser-run/playwright/`
  - `https://developers.cloudflare.com/browser-run/pricing/`
  - `https://developers.cloudflare.com/browser-run/limits/`
  - `https://developers.cloudflare.com/browser-run/reference/wrangler/`

  Run: `npx wrangler whoami`

  Workdir: `/tmp/switch-price-monitor-jp-browser-probe`

  Expected: 显示已登录 Cloudflare 账号；不得把账号令牌、API Token 或完整认证信息复制到文档或聊天。若未登录，停止并请管理员完成 `wrangler login`。

- [x] **Step 2：取得远程 Browser Run 调用授权后启动临时开发会话**

  Run: `npm run dev:remote`

  Workdir: `/tmp/switch-price-monitor-jp-browser-probe`

  Expected: Wrangler 明确监听 `http://127.0.0.1:8791`，Browser Binding 名为 `BROWSER`；输出不得出现 D1、Cron、Static Assets、生产路由或 `switch-price-monitor.cchccp.workers.dev`。如果远程开发要求持久部署、命名冲突或无法提供 Browser Binding，立即终止，不改用 `wrangler deploy`；一次性部署必须另行取得管理员明确授权。

- [x] **Step 3：串行执行第一次探测**

  Run: `date -u +%Y-%m-%dT%H:%M:%SZ`

  Run: `curl --max-time 35 --silent --show-error --request POST http://127.0.0.1:8791/probe --output /tmp/jp-upgrade-probe-run-1.json`

  Run: `sed -n '1,4p' /tmp/jp-upgrade-probe-run-1.json`

  Expected: 文件只含允许的 JSON 字段。不得截图、打开 Live View、记录 HTML 或调试响应；无论结果成功或失败都不立即重试替换该样本。

- [x] **Step 4：等待实例频率窗口并执行第二次探测**

  Run: `sleep 20`

  Run: `date -u +%Y-%m-%dT%H:%M:%SZ`

  Run: `curl --max-time 35 --silent --show-error --request POST http://127.0.0.1:8791/probe --output /tmp/jp-upgrade-probe-run-2.json`

  Run: `sed -n '1,4p' /tmp/jp-upgrade-probe-run-2.json`

  Expected: 第二次结果独立生成；即使第一次失败也保留原结果，不复用 session 或 Cookie。

- [x] **Step 5：再次等待并执行第三次探测**

  Run: `sleep 20`

  Run: `date -u +%Y-%m-%dT%H:%M:%SZ`

  Run: `curl --max-time 35 --silent --show-error --request POST http://127.0.0.1:8791/probe --output /tmp/jp-upgrade-probe-run-3.json`

  Run: `sed -n '1,4p' /tmp/jp-upgrade-probe-run-3.json`

  Expected: 正好形成三次连续样本，不追加第四次“补成功”结果。

- [x] **Step 6：用只读脚本机械判定三次结果**

  Run:

  ```bash
  node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const expected = "https://store-jp.nintendo.com/item/software/D70050000064985/";
  const paths = [1, 2, 3].map((index) => `/tmp/jp-upgrade-probe-run-${index}.json`);
  const results = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const passed = results.length === 3 && results.every((result) =>
    result.status === "success" &&
    result.upgradeUrl === expected &&
    typeof result.linkText === "string" &&
    result.linkText.includes("アップグレードパス") &&
    Number.isInteger(result.elapsedMs) &&
    result.elapsedMs >= 0 &&
    result.elapsedMs < 30000 &&
    Object.keys(result).every((key) => ["status", "upgradeUrl", "linkText", "elapsedMs"].includes(key))
  );
  console.log(JSON.stringify({ passed, results }));
  process.exitCode = passed ? 0 : 1;
  '
  ```

  Expected on pass: exit 0，`passed: true`，三个 URL 全部精确等于 `D70050000064985`，每个 `elapsedMs < 30000`。

  Expected on fail: exit 1，`passed: false`；不得重新运行来替换失败样本，结论直接为“Browser Run 暂不准入生产设计”。

- [x] **Step 7：终止远程开发会话并确认无云端持久部署**

  向运行 `wrangler dev --remote` 的终端发送 `Ctrl-C`，等待进程退出。

  Run: `npx wrangler deployments list --name switch-price-monitor-jp-upgrade-probe`

  Workdir: `/tmp/switch-price-monitor-jp-browser-probe`

  Expected: 不存在由本计划创建的持久生产部署；若 Wrangler 仅显示远程开发会话产生的临时记录，确认其已结束，不执行删除生产 Worker 的命令。临时目录和三个允许字段 JSON 保留到管理员完成结果复核，不执行未经授权的 `rm`。

- [x] **Step 8：根据机械结论更新结果文档**

  若 Step 6 exit 0：

  - 将设计规格状态改为“Browser Run 三次可行性验证通过；待生产架构设计，尚未批准生产集成”。
  - 在 `docs/quality/quality-and-acceptance.md` 新增“日区升级包 Browser Run 隔离可行性验证”小节，记录三次允许字段、三次均唯一命中 `D70050000064985`、未使用持久会话以及“仅允许进入生产设计”的结论。
  - 将 `docs/README.md` 中本计划状态改为“可行性验证通过，待生产设计”；设计规格仍标明尚未批准生产集成。

  若 Step 6 exit 1：

  - 将设计规格状态改为“Browser Run 三次可行性验证未通过；维持人工官方链接兜底”。
  - 在质量文档记录三次允许字段和失败分类，不记录响应正文或堆栈。
  - 将文档索引状态改为“可行性验证未通过；不进入生产集成”。

  两个分支都不得修改 PRD 中“验证成功不等于生产批准”的规则，也不得修改生产代码、依赖、配置或版本号。

- [x] **Step 9：运行最终文档和隔离验证**

  Run: `git diff --check`

  Run: `git status --short`

  Run: `git diff --name-only`

  Workdir: `/Users/c/Documents/workspace/Switch_Price_Monitor`

  Expected: 只包含本计划、`docs/README.md`、日区升级包设计规格和质量验收文档；不包含生产代码、根依赖/锁文件、Wrangler 配置或版本号。

- [x] **Step 10：向管理员报告并请求文档提交确认**

  报告必须包含三次 `status`、官方 URL、公开链接文字、耗时和机械判定；明确说明没有生产部署、D1/订阅写入或生产代码变更。列出准备提交的文档文件，取得明确确认后，才在同一操作中执行精确 `git add`、`git commit` 和 `git push origin main`。

  临时 `/tmp` 探针源代码、依赖和三个 JSON 不进入 Git 提交。

## Plan Self-Review

- 规格覆盖：隔离目录、官方唯一 URL、可见文字、30 秒预算、三次独立实例、20 秒频率间隔、最小输出、无持久状态、成功/失败分支和生产禁入边界均有对应任务。
- 占位符检查：计划没有占位标记、延期实现措辞或未命名文件；动态运行结果只通过精确机械判定进入两个明确文档分支。
- 类型一致性：`ProbeResult`、`ProbeExecutor`、`runJapaneseUpgradeProbe` 和 `createProbeWorker` 的签名在各任务中一致；HTTP 测试与真实入口均使用 `POST /probe`。
- 隔离检查：临时依赖和代码只写 `/tmp`；项目仓库只保存计划与最终允许字段结果文档；没有生产部署命令。
- 安全检查：目标地址固定、主机和路径严格白名单、同名无效链接整体拒绝、响应无缓存、日志与结果不包含页面或会话数据。
