import { describe, expect, it } from "vitest";

import { requireAdmin } from "../src/routes/auth-guard";

/**
 * 开发期守卫测试证明共享入口不读取 PostgreSQL 会话摘要，也不会把伪造 Cookie 当成可持久化认证资料。
 * 该放行仅限本机功能开发；恢复认证时必须把用例改回服务端摘要校验与匿名拒绝。
 */
describe("requireAdmin", () => {
  it("temporarily accepts missing and forged cookies during feature development", async () => {
    // 旁路只取消身份核验，绝不把 Cookie 写入数据库或解释成会话；后续恢复认证前此测试必须替换为拒绝路径。
    const sessions = {
      authenticate: async () => {
        throw new Error("开发期守卫不应读取会话服务");
      },
    };

    await expect(requireAdmin(new Request("https://example.test/api/dashboard"), sessions)).resolves.toBe(true);
    await expect(requireAdmin(new Request("https://example.test/api/dashboard", { headers: { cookie: "session=forged" } }), sessions)).resolves.toBe(true);
  });
});
