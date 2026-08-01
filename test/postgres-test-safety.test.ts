import { afterEach, describe, expect, it, vi } from "vitest";
import { requireTestDatabaseUrl } from "./support/postgres";

/**
 * 测试数据库 URL 是 DROP SCHEMA、CREATE TABLE 和 TRUNCATE 等破坏性辅助操作之前的最后安全边界。
 * 这些用例逐项改变 authority、凭据、数据库和附加参数，确保只有 Task 2 Compose 的精确回环地址可通过。
 */
describe("PostgreSQL 测试数据库 URL 安全验证", () => {
  afterEach(() => {
    // 每例恢复进程环境，避免错误 URL 泄漏到同一 Vitest 执行进程的后续真实数据库测试。
    vi.unstubAllEnvs();
  });

  it("缺失 TEST_DATABASE_URL 时在创建任何连接池前拒绝执行", () => {
    vi.stubEnv("TEST_DATABASE_URL", "");

    expect(() => requireTestDatabaseUrl()).toThrow(
      "必须显式设置 TEST_DATABASE_URL 才能运行 PostgreSQL 集成测试",
    );
  });

  it.each([
    ["非回环主机", "postgres://switch_test:switch_test@localhost:54329/switch_test"],
    ["错误端口", "postgres://switch_test:switch_test@127.0.0.1:5432/switch_test"],
    ["错误数据库", "postgres://switch_test:switch_test@127.0.0.1:54329/postgres"],
    ["错误用户", "postgres://postgres:switch_test@127.0.0.1:54329/switch_test"],
    ["错误密码", "postgres://switch_test:wrong@127.0.0.1:54329/switch_test"],
    ["错误协议", "postgresql://switch_test:switch_test@127.0.0.1:54329/switch_test"],
    [
      "附加驱动连接参数",
      "postgres://switch_test:switch_test@127.0.0.1:54329/switch_test?host=/var/run/postgresql",
    ],
    [
      "附加片段",
      "postgres://switch_test:switch_test@127.0.0.1:54329/switch_test#not-exact",
    ],
  ])("拒绝%s", (_caseName, value) => {
    vi.stubEnv("TEST_DATABASE_URL", value);

    expect(() => requireTestDatabaseUrl()).toThrow(
      "TEST_DATABASE_URL 必须指向 Task 2 的一次性 switch_test 数据库",
    );
  });

  it("仅返回精确的 Task 2 一次性测试连接串", () => {
    const value =
      "postgres://switch_test:switch_test@127.0.0.1:54329/switch_test";
    vi.stubEnv("TEST_DATABASE_URL", value);

    expect(requireTestDatabaseUrl()).toBe(value);
  });
});
