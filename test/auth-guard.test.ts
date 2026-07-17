import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthService } from "../src/worker/services/auth-service";
import { requireAdmin } from "../src/worker/routes/auth-guard";

/**
 * 受保护 API 的守卫测试直接使用真实 D1 会话记录，确保未来路由不会因为仅检查 Cookie 是否存在而被伪造请求绕过。
 */
describe("requireAdmin", () => {
  const auth = new AuthService(env.DB);

  beforeEach(async () => {
    // 会话依赖管理员凭据和设置；清理顺序与认证测试保持一致，避免隔离测试间遗留有效令牌摘要。
    await env.DB.exec("DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;");
  });

  it("rejects a missing or forged cookie and accepts only a live issued session", async () => {
    // Cookie 名称本身不代表登录：只有服务端摘要匹配、未撤销且未过期的令牌才可访问管理 API。
    await expect(requireAdmin(new Request("https://example.test/api/dashboard"), env.DB)).resolves.toBe(false);
    await expect(requireAdmin(new Request("https://example.test/api/dashboard", { headers: { cookie: "session=forged" } }), env.DB)).resolves.toBe(false);

    await auth.initialize({
      password: "correct-horse-battery-staple",
      enabledRegions: ["US"],
      defaultSearchRegion: "US",
      now: "2026-07-16T00:00:00.000Z",
    });
    const session = await auth.login("correct-horse-battery-staple", "2026-07-16T00:01:00.000Z");

    await expect(requireAdmin(new Request("https://example.test/api/dashboard", { headers: { cookie: `session=${session.token}` } }), env.DB)).resolves.toBe(true);
  });
});
