import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireAdmin } from "../src/routes/auth-guard";
import type { AppDatabase } from "../src/server/database/types";
import { createApiTestDatabase, createTestAuth, resetApiTestData } from "./support/api-postgres";

/**
 * 受保护 API 的守卫测试直接使用真实 PostgreSQL 会话摘要，确保路由不会因为仅检查 Cookie 是否存在而接受伪造请求。
 * Cookie 原文只保存在当前测试变量，数据库与断言都不输出它。
 */
describe("requireAdmin", () => {
  let database: AppDatabase;

  beforeAll(async () => {
    database = await createApiTestDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    // 受守卫的一次性库只保留迁移结构；每轮清空业务表可防止上一用例的有效摘要误授权本轮请求。
    await resetApiTestData(database);
  });

  it("rejects a missing or forged cookie and accepts only a live issued session", async () => {
    const auth = createTestAuth(database);
    // Cookie 名称本身不代表登录：只有服务端摘要匹配、未撤销且未过期的令牌才可访问管理 API。
    await expect(requireAdmin(new Request("https://example.test/api/dashboard"), auth)).resolves.toBe(false);
    await expect(requireAdmin(new Request("https://example.test/api/dashboard", { headers: { cookie: "session=forged" } }), auth)).resolves.toBe(false);

    await auth.initialize({
      password: "correct-horse-battery-staple",
      enabledRegions: ["US"],
      defaultSearchRegion: "US",
      now: "2026-07-16T00:00:00.000Z",
    });
    const session = await auth.login("correct-horse-battery-staple", "2026-07-16T00:01:00.000Z");

    await expect(requireAdmin(new Request("https://example.test/api/dashboard", { headers: { cookie: `session=${session.token}` } }), auth)).resolves.toBe(true);
  });
});
