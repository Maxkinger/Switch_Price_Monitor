import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 只在本文件替换 pg.Pool 的外部 I/O 边界，以稳定制造真实服务极难安全触发的 ROLLBACK/解锁故障。
 * 双桩完整保留 connect → client.query → client.release(error) 生命周期；断言针对数据库包装器的可观察结果，
 * 不向生产 API 暴露 raw client 或测试钩子，也不削弱另一个文件中的真实 PostgreSQL 集成测试。
 */
const pgDouble = vi.hoisted(() => ({
  connect: vi.fn(),
  poolQuery: vi.fn(),
  end: vi.fn(),
  constructorOptions: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class {
    query = pgDouble.poolQuery;
    connect = pgDouble.connect;
    end = pgDouble.end;

    constructor(options: unknown) {
      pgDouble.constructorOptions(options);
    }
  },
}));

import { createPostgresDatabase } from "../src/server/database/pool";

/**
 * 测试客户端只暴露生产包装器实际使用的 query/release 边界；
 * release spy 的参数用于区分 clean-release 与 pg-pool 明确定义的销毁连接语义。
 */
interface FakePoolClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

describe("PostgreSQL 失败路径连接清理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pgDouble.end.mockResolvedValue(undefined);
  });

  it("ROLLBACK 失败时销毁客户端并同时保留原始工作错误与回滚错误", async () => {
    const workError = new Error("work failed");
    const rollbackError = new Error("rollback failed");
    const client = createClient(async (sql) => {
      if (sql === "BEGIN") {
        return emptyResult();
      }
      if (sql === "ROLLBACK") {
        throw rollbackError;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    pgDouble.connect.mockResolvedValue(client);
    const database = createPostgresDatabase("postgres://test.invalid/test");

    const error = await captureRejection(
      database.transaction(async () => {
        throw workError;
      }),
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([workError, rollbackError]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(rollbackError);
  });

  it("advisory lock 获取查询失败时销毁状态未知的客户端", async () => {
    const acquisitionError = new Error("lock acquisition failed");
    const client = createClient(async () => {
      throw acquisitionError;
    });
    pgDouble.connect.mockResolvedValue(client);
    const database = createPostgresDatabase("postgres://test.invalid/test");

    const error = await captureRejection(
      database.withAdvisoryLock(99n, async () => "never"),
    );

    expect(error).toBe(acquisitionError);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(acquisitionError);
  });

  it("锁内回调失败时仍解锁并原样抛出回调错误", async () => {
    const callbackError = new Error("callback failed");
    const client = createAdvisoryClient();
    pgDouble.connect.mockResolvedValue(client);
    const database = createPostgresDatabase("postgres://test.invalid/test");

    const error = await captureRejection(
      database.withAdvisoryLock(100n, async () => {
        throw callbackError;
      }),
    );

    expect(error).toBe(callbackError);
    expect(client.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_unlock($1::bigint) AS released",
      ["100"],
    );
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("解锁失败时销毁客户端而不是把未知会话放回池中", async () => {
    const unlockError = new Error("unlock failed");
    const client = createAdvisoryClient(unlockError);
    pgDouble.connect.mockResolvedValue(client);
    const database = createPostgresDatabase("postgres://test.invalid/test");

    const error = await captureRejection(
      database.withAdvisoryLock(101n, async () => "completed"),
    );

    expect(error).toBe(unlockError);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(unlockError);
  });

  it("回调与解锁同时失败时聚合两个错误且用解锁错误销毁客户端", async () => {
    const callbackError = new Error("callback failed");
    const unlockError = new Error("unlock failed");
    const client = createAdvisoryClient(unlockError);
    pgDouble.connect.mockResolvedValue(client);
    const database = createPostgresDatabase("postgres://test.invalid/test");

    const error = await captureRejection(
      database.withAdvisoryLock(102n, async () => {
        throw callbackError;
      }),
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([callbackError, unlockError]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(unlockError);
  });
});

/**
 * 构造带完整 query/release 副作用的受控客户端；query 实现由每例限定 SQL 分支，
 * 任何意外语句都会让测试失败，避免宽松 mock 掩盖 BEGIN/ROLLBACK/锁顺序错误。
 */
function createClient(
  queryImplementation: (sql: string, parameters?: unknown[]) => Promise<unknown>,
): FakePoolClient {
  return {
    query: vi.fn(queryImplementation),
    release: vi.fn(),
  };
}

/**
 * advisory 客户端先返回成功取锁；解锁可选择成功或注入指定错误。
 * 结果结构镜像 pg 的 rows/rowCount/command/fields 等公开字段，避免部分 mock 与真实驱动形状脱节。
 */
function createAdvisoryClient(unlockError?: Error): FakePoolClient {
  return createClient(async (sql) => {
    if (sql.includes("pg_try_advisory_lock")) {
      return queryResult([{ acquired: true }]);
    }
    if (sql.includes("pg_advisory_unlock")) {
      if (unlockError) {
        throw unlockError;
      }
      return queryResult([{ released: true }]);
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

/**
 * 创建与 pg QueryResult 同形的结果。测试只手写业务期望行，不复用生产 normalizeResult，
 * 因而错误 rows/rowCount 分支仍会被真实包装器断言捕获。
 */
function queryResult<Row>(rows: Row[]) {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    rows,
    fields: [],
  };
}

/**
 * BEGIN/ROLLBACK 等无业务行控制语句使用空结果，仍保留完整 QueryResult 形状，
 * 防止测试因返回 undefined 而在目标清理分支之前发生无关类型或属性错误。
 */
function emptyResult() {
  return queryResult([]);
}

/**
 * 捕获 Promise 拒绝值并让意外成功立即失败；返回 unknown 迫使每例先验证错误类型，
 * 同时可用对象同一性检查确认包装器没有静默替换原始工作错误。
 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}
