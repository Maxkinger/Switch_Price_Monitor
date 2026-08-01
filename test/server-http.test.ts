import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerApp, type ServerDependencies } from "../src/server/app";
import { createApiDispatcher } from "../src/server/dependencies";
import { handleAuthRoute } from "../src/routes/auth-routes";
import type { AuthService } from "../src/services/auth-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // 只删除本测试通过 mkdtemp 创建且仍可 realpath 的目录；不接受外部路径，避免清理失控扩大到工作区。
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    const canonical = await realpath(directory).catch(() => null);
    if (canonical && basename(canonical).startsWith("switch-price-monitor-server-http-")) {
      await rm(canonical, { recursive: true, force: true });
    }
  }));
});

describe("Node HTTP Fetch 应用", () => {
  it("健康检查保持既有 JSON 且不触发业务依赖", async () => {
    const staticDirectory = await createStaticFixture();
    const dispatchApi = vi.fn<ServerDependencies["dispatchApi"]>();
    const app = createServerApp({ staticDirectory, maximumBodyBytes: 1024 }, { dispatchApi });

    const response = await app.fetch(new Request("http://localhost/api/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "switch-price-monitor" });
    expect(dispatchApi).not.toHaveBeenCalled();
  });

  it("将调用方同一个同源 Request 实例交给 API 分发器", async () => {
    const staticDirectory = await createStaticFixture();
    let received: Request | undefined;
    const dependencies: ServerDependencies = {
      dispatchApi: async (request) => {
        received = request;
        return new Response("routed", { status: 202 });
      },
    };
    const app = createServerApp({ staticDirectory, maximumBodyBytes: 1024 }, dependencies);
    const request = new Request("http://localhost/api/example", {
      method: "POST",
      body: JSON.stringify({ value: 1 }),
      headers: { "content-type": "application/json" },
    });

    const response = await app.fetch(request);

    expect(received).toBe(request);
    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("routed");
  });

  it("按既有路由顺序分发同一 Request，并在首个 Response 后停止", async () => {
    const request = new Request("http://localhost/api/example");
    const calls: Request[] = [];
    const handlers = [
      async (received: Request) => { calls.push(received); return null; },
      async (received: Request) => { calls.push(received); return null; },
      async (received: Request) => {
        calls.push(received);
        return new Response("matched", { status: 203 });
      },
      async (received: Request) => {
        calls.push(received);
        return new Response("must-not-run");
      },
    ];

    const response = await createApiDispatcher(handlers)(request);

    expect(calls).toEqual([request, request, request]);
    expect(response?.status).toBe(203);
    await expect(response?.text()).resolves.toBe("matched");
  });

  it("未知 API 使用固定 JSON 404 而不回退 React 页面", async () => {
    const staticDirectory = await createStaticFixture();
    const app = createServerApp(
      { staticDirectory, maximumBodyBytes: 1024 },
      { dispatchApi: async () => null },
    );

    const response = await app.fetch(new Request("http://localhost/api/not-found"));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      error: "接口不存在。",
    });
  });

  it("业务依赖抛错时返回固定 500 且响应与控制台都不泄漏秘密", async () => {
    const staticDirectory = await createStaticFixture();
    const databaseMarker = "postgres://secret-user:secret-password@database.invalid/switch";
    const telegramMarker = "telegram-token-unique-marker";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createServerApp(
      { staticDirectory, maximumBodyBytes: 1024 },
      {
        dispatchApi: async () => {
          throw new Error(`driver failed ${databaseMarker} ${telegramMarker}`);
        },
      },
    );

    try {
      const response = await app.fetch(new Request("http://localhost/api/private"));
      const responseHeaders = [...response.headers.entries()].flat().join("\n");
      const responseBody = await response.text();

      expect.soft(response.status).toBe(500);
      expect.soft(response.headers.get("content-type")).toContain("application/json");
      expect.soft(() => JSON.parse(responseBody)).not.toThrow();
      if (response.headers.get("content-type")?.includes("application/json")) {
        expect.soft(JSON.parse(responseBody)).toEqual({
          code: "INTERNAL_ERROR",
          error: "服务暂时无法处理请求，请稍后重试。",
        });
      }
      // 数据库 URL、Telegram marker、异常 message 与 stack 均不得进入客户端可见响应。
      expect.soft(`${responseHeaders}\n${responseBody}`).not.toContain(databaseMarker);
      expect.soft(`${responseHeaders}\n${responseBody}`).not.toContain(telegramMarker);
      // Hono 默认 onError 会打印原始异常；Node 应用必须覆盖该行为，而不是依赖部署日志后处理脱敏。
      expect.soft(consoleError.mock.calls.flat().join("\n")).not.toContain(databaseMarker);
      expect.soft(consoleError.mock.calls.flat().join("\n")).not.toContain(telegramMarker);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("返回根内已有静态文件及其正确 MIME 类型", async () => {
    const staticDirectory = await createStaticFixture();
    await mkdir(join(staticDirectory, "assets"), { recursive: true });
    await writeFile(join(staticDirectory, "assets", "app.css"), "body{color:#123}");
    const app = createServerApp(
      { staticDirectory, maximumBodyBytes: 1024 },
      { dispatchApi: async () => null },
    );

    const response = await app.fetch(new Request("http://localhost/assets/app.css"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    await expect(response.text()).resolves.toBe("body{color:#123}");
  });

  it("非 API 客户端路由回退到 index.html", async () => {
    const staticDirectory = await createStaticFixture();
    const app = createServerApp(
      { staticDirectory, maximumBodyBytes: 1024 },
      { dispatchApi: async () => null },
    );

    const response = await app.fetch(new Request("http://localhost/subscriptions/demo"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(response.text()).resolves.toContain("safe-index");
  });

  it.each([
    "/%2e%2e%2foutside-secret.txt",
    "/%252e%252e%252foutside-secret.txt",
    "/%2Fetc%2Fpasswd",
  ])("拒绝目录穿越、双重编码和绝对路径形式：%s", async (path) => {
    const staticDirectory = await createStaticFixture();
    const outsidePath = join(staticDirectory, "..", "outside-secret.txt");
    await writeFile(outsidePath, "must-not-be-served");
    const app = createServerApp(
      { staticDirectory, maximumBodyBytes: 1024 },
      { dispatchApi: async () => null },
    );

    const response = await app.fetch(new Request(`http://localhost${path}`));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.not.toContain("must-not-be-served");
  });

  it("拒绝根内符号链接指向静态目录之外", async () => {
    const staticDirectory = await createStaticFixture();
    const outsidePath = join(staticDirectory, "..", "symlink-secret.txt");
    await writeFile(outsidePath, "symlink-secret");
    await symlink(outsidePath, join(staticDirectory, "linked.txt"));
    const app = createServerApp(
      { staticDirectory, maximumBodyBytes: 1024 },
      { dispatchApi: async () => null },
    );

    const response = await app.fetch(new Request("http://localhost/linked.txt"));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.not.toContain("symlink-secret");
  });

  it("请求体超过上限时在业务路由执行前返回 413", async () => {
    const staticDirectory = await createStaticFixture();
    const dispatchApi = vi.fn<ServerDependencies["dispatchApi"]>();
    const app = createServerApp({ staticDirectory, maximumBodyBytes: 8 }, { dispatchApi });

    const response = await app.fetch(new Request("http://localhost/api/example", {
      method: "POST",
      body: "123456789",
    }));

    expect(response.status).toBe(413);
    expect(dispatchApi).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      code: "PAYLOAD_TOO_LARGE",
      error: "请求内容过大。",
    });
  });

  it.each([
    { cookieSecure: false, expectedSecure: false },
    { cookieSecure: true, expectedSecure: true },
  ])("登录 Cookie 始终 Strict/HttpOnly，Secure 完全取决于显式配置", async ({
    cookieSecure,
    expectedSecure,
  }) => {
    const staticDirectory = await createStaticFixture();
    const auth = {
      login: async () => ({
        token: "test-session-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    // 这里只替代外部认证业务依赖，断言对象是实际 auth route 生成的 Cookie；双重断言避免假实现被误用于其它测试。
    } as unknown as AuthService;
    const app = createServerApp(
      { staticDirectory, maximumBodyBytes: 1024 },
      {
        dispatchApi: (request) => handleAuthRoute(request, {
          auth,
          sessions: { authenticate: async () => false },
          cookieSecure,
        }),
      },
    );

    const response = await app.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "test-password-only" }),
      headers: { "content-type": "application/json" },
    }));
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie.includes(" Secure;")).toBe(expectedSecure);
  });
});

/** 创建包含唯一 SPA 入口的隔离静态根；文件内容不含任何真实前端或凭据。 */
async function createStaticFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "switch-price-monitor-server-http-"));
  temporaryDirectories.push(root);
  const staticDirectory = join(root, "client");
  await mkdir(staticDirectory);
  await writeFile(join(staticDirectory, "index.html"), "<!doctype html><p>safe-index</p>");
  return staticDirectory;
}
