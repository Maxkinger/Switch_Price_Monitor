import { describe, expect, it, vi } from "vitest";
import {
  DISPOSABLE_TEST_DATABASE_MARKER,
  TEST_DATABASE_TARGET_ERROR,
  createTestDatabase,
  resetDisposableTestSchema,
  validateDisposableTestDatabaseTarget,
} from "./support/postgres";

const disposableUrl = "postgres://switch_test:switch_test@127.0.0.1:54329/switch_test";
const disposableEnvironment = {
  TEST_DATABASE_URL: disposableUrl,
  TEST_DATABASE_DISPOSABLE_MARKER: DISPOSABLE_TEST_DATABASE_MARKER,
};

describe("PostgreSQL disposable 测试目标安全门禁", () => {
  it("只接受专用回环端口、测试用户、测试库与显式 disposable marker 的组合", async () => {
    expect(validateDisposableTestDatabaseTarget(disposableEnvironment)).toBe(disposableUrl);

    // 创建池本身不发起 TCP 连接；成功关闭证明合法目标可通过工厂，同时测试不会依赖真实数据库状态。
    const database = createTestDatabase(disposableEnvironment);
    await database.close();
  });

  it.each([
    ["缺少全部环境变量", {}],
    ["缺少显式安全 marker", { TEST_DATABASE_URL: disposableUrl }],
    ["marker 值不匹配", { TEST_DATABASE_URL: disposableUrl, TEST_DATABASE_DISPOSABLE_MARKER: "yes" }],
    ["URL 无法解析", { TEST_DATABASE_URL: "not-a-postgres-url", TEST_DATABASE_DISPOSABLE_MARKER: DISPOSABLE_TEST_DATABASE_MARKER }],
    ["NAS 私网主机", { TEST_DATABASE_URL: "postgres://switch_test:do-not-leak@192.168.1.42:5432/switch_test", TEST_DATABASE_DISPOSABLE_MARKER: DISPOSABLE_TEST_DATABASE_MARKER }],
    ["开发数据库名", { TEST_DATABASE_URL: "postgres://switch_test:do-not-leak@127.0.0.1:54329/switch_dev", TEST_DATABASE_DISPOSABLE_MARKER: DISPOSABLE_TEST_DATABASE_MARKER }],
    ["生产样式用户和数据库", { TEST_DATABASE_URL: "postgres://switch_app:do-not-leak@127.0.0.1:54329/switch_price_monitor", TEST_DATABASE_DISPOSABLE_MARKER: DISPOSABLE_TEST_DATABASE_MARKER }],
    ["错误本机端口", { TEST_DATABASE_URL: "postgres://switch_test:do-not-leak@127.0.0.1:5432/switch_test", TEST_DATABASE_DISPOSABLE_MARKER: DISPOSABLE_TEST_DATABASE_MARKER }],
    ["查询参数尝试覆盖连接目标", { TEST_DATABASE_URL: `${disposableUrl}?host=192.168.1.42`, TEST_DATABASE_DISPOSABLE_MARKER: DISPOSABLE_TEST_DATABASE_MARKER }],
  ])("在创建连接池前拒绝%s", (_label, environment) => {
    // 所有失败分支使用同一不含 URL、主机、用户或密码的安全消息，避免 CI/日志泄漏误填的生产连接信息。
    expect(() => createTestDatabase(environment)).toThrow(TEST_DATABASE_TARGET_ERROR);
    try {
      createTestDatabase(environment);
    } catch (error) {
      expect((error as Error).message).toBe(TEST_DATABASE_TARGET_ERROR);
      expect((error as Error).message).not.toContain("do-not-leak");
      expect((error as Error).message).not.toContain("192.168.1.42");
    }
  });

  it("不安全目标在执行 DROP SCHEMA 前失败", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));

    await expect(resetDisposableTestSchema(
      { query },
      {
        TEST_DATABASE_URL: "postgres://switch_app:do-not-leak@nas.local:5432/switch_price_monitor",
        TEST_DATABASE_DISPOSABLE_MARKER: DISPOSABLE_TEST_DATABASE_MARKER,
      },
    )).rejects.toThrow(TEST_DATABASE_TARGET_ERROR);
    expect(query).not.toHaveBeenCalled();
  });

  it("合法目标通过二次门禁后才执行可丢弃 schema 重建", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));

    await resetDisposableTestSchema({ query }, disposableEnvironment);

    expect(query.mock.calls).toEqual([
      ["DROP SCHEMA public CASCADE"],
      ["CREATE SCHEMA public"],
    ]);
  });
});
