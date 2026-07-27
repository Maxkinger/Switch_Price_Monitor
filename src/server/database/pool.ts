import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { AppDatabase, SqlExecutor, SqlResult } from "./types";

/**
 * pg.Pool 与已检出 PoolClient 都满足此最小查询形状。内部类型刻意不导出，防止业务代码取得 release、
 * 事务控制或其他驱动能力，从而破坏仓储层约束和客户端归还规则。
 */
interface QueryConnection {
  query<Row extends QueryResultRow>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row>>;
}

/**
 * 将 pg 查询结果规范化为应用契约。普通 SELECT/INSERT 的 rowCount 应为整数；
 * 驱动对无计数命令返回 null 时归零，避免调用方误把 null 当成失败或进行不安全的数值运算。
 */
function normalizeResult<Row>(result: QueryResult<QueryResultRow>): SqlResult<Row> {
  return {
    rows: result.rows as Row[],
    rowCount: result.rowCount ?? 0,
  };
}

/**
 * 为连接池或单个已检出客户端创建受限执行器。参数数组在边界复制，既适配 pg 的可变数组签名，
 * 也保证驱动不会意外改写调用方持有的只读参数集合。
 */
function createExecutor(connection: QueryConnection): SqlExecutor {
  return {
    async query<Row>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<SqlResult<Row>> {
      const result = await connection.query(sql, [...parameters]);
      return normalizeResult<Row>(result);
    },
  };
}

/**
 * 创建应用专属 PostgreSQL 连接池。上限 5 与单管理员、定时采集的低并发业务规模一致，
 * 可避免 NAS 上意外启动多个实例时过度占用数据库连接；连接串只能来自受控运行时配置。
 */
export function createPostgresDatabase(connectionString: string): AppDatabase {
  const pool = new Pool({
    connectionString,
    max: 5,
  });
  const pooledExecutor = createExecutor(pool);

  return {
    query<Row>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<SqlResult<Row>> {
      return pooledExecutor.query<Row>(sql, parameters);
    },

    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let transactionStarted = false;
      let releaseError: Error | undefined;
      try {
        await client.query("BEGIN");
        transactionStarted = true;
        const value = await work(createExecutor(client));
        await client.query("COMMIT");
        transactionStarted = false;
        return value;
      } catch (error) {
        // 只有 BEGIN 成功后才回滚；工作或 COMMIT 失败但回滚成功时会话状态已知，可正常归还并原样抛出业务错误。
        if (transactionStarted) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            // 回滚失败意味着事务状态未知：用回滚错误销毁客户端，并聚合两个错误，不能让清理故障掩盖原始业务/提交错误。
            releaseError = normalizeConnectionError(
              rollbackError,
              "PostgreSQL 事务回滚失败",
            );
            throw aggregateOperationAndCleanupErrors(
              error,
              rollbackError,
              "PostgreSQL 事务失败且回滚清理失败",
            );
          }
        } else {
          // BEGIN 控制语句失败时无法证明会话仍可复用，销毁客户端以避免未知协议/事务状态回到连接池。
          releaseError = normalizeConnectionError(
            error,
            "PostgreSQL 事务启动失败",
          );
        }
        throw error;
      } finally {
        // 正常路径 clean-release；控制语句失败路径把 Error 传给 pg 以移除客户端，两者都不会泄漏池容量。
        client.release(releaseError);
      }
    },

    async withAdvisoryLock<T>(
      key: bigint,
      work: (connection: SqlExecutor) => Promise<T>,
    ): Promise<T | undefined> {
      const client = await pool.connect();
      let acquired = false;
      let releaseError: Error | undefined;
      let workFailed = false;
      let workError: unknown;
      try {
        let lockResult: QueryResult<{ acquired: boolean }>;
        try {
          lockResult = await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
            // bigint 转十进制字符串可保持 64 位锁键精度，避免 JavaScript number 截断后不同任务误用同一把锁。
            [key.toString()],
          );
        } catch (error) {
          // 获取锁的控制查询失败后无法判断会话是否已持锁，必须销毁连接而不是 clean-release 后让未知锁状态进入池。
          releaseError = normalizeConnectionError(
            error,
            "PostgreSQL advisory lock 获取失败",
          );
          throw error;
        }
        acquired = lockResult.rows[0]?.acquired === true;
        if (!acquired) {
          // try 锁失败必须立即跳过，不排队；这是防止迁移外的定时任务重复采集和重复通知的业务语义。
          return undefined;
        }
        try {
          return await work(createExecutor(client));
        } catch (error) {
          workFailed = true;
          workError = error;
          throw error;
        }
      } finally {
        let unlockFailed = false;
        let unlockError: unknown;
        try {
          if (acquired) {
            // advisory lock 属于当前数据库会话，必须在归还客户端前显式释放，防止锁随连接回池后永久阻塞后续任务。
            await releaseAdvisoryLock(client, key);
          }
        } catch (error) {
          // 解锁查询异常时销毁而非复用该会话，防止一把状态未知的会话锁随客户端回池并阻塞后续迁移或调度。
          unlockFailed = true;
          unlockError = error;
          releaseError = normalizeConnectionError(
            error,
            "PostgreSQL advisory lock 释放异常",
          );
        } finally {
          // 正常路径归还客户端；获取/解锁异常把错误交给 pg 以淘汰客户端，两者都不会泄漏连接池容量。
          client.release(releaseError);
        }

        if (unlockFailed) {
          if (workFailed) {
            // finally 中的解锁错误不能覆盖回调错误；聚合顺序固定为业务错误在前、资源清理错误在后。
            throw aggregateOperationAndCleanupErrors(
              workError,
              unlockError,
              "PostgreSQL advisory lock 回调失败且解锁清理失败",
            );
          }
          throw unlockError;
        }
      }
    },

    async close(): Promise<void> {
      // 应用关停时等待池内客户端清理完成；close 后的新查询由 pg 明确拒绝，避免静默重建连接绕过生命周期。
      await pool.end();
    },
  };
}

/**
 * 在取得锁的同一 PoolClient 上释放会话级 advisory lock。返回 false 表示会话状态异常，
 * 此时抛错而不是继续运行，因为连接若带锁回池会破坏迁移或调度互斥保证。
 */
async function releaseAdvisoryLock(client: PoolClient, key: bigint): Promise<void> {
  const result = await client.query<{ released: boolean }>(
    "SELECT pg_advisory_unlock($1::bigint) AS released",
    [key.toString()],
  );
  if (result.rows[0]?.released !== true) {
    throw new Error("PostgreSQL advisory lock 释放失败");
  }
}

/**
 * pg 的 release(error) 只接受 Error/boolean；若依赖或用户回调抛出非 Error 值，
 * 用带 cause 的安全错误包装后销毁未知状态客户端，同时避免把连接串、SQL 参数或凭据写入消息。
 */
function normalizeConnectionError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage, { cause: error });
}

/**
 * 同时保留主操作与资源清理失败，顺序固定为 operation、cleanup。
 * AggregateError 让启动/日志层可检查两条因果链，而不是被 ROLLBACK 或解锁异常静默覆盖原始业务错误。
 */
function aggregateOperationAndCleanupErrors(
  operationError: unknown,
  cleanupError: unknown,
  message: string,
): AggregateError {
  return new AggregateError([operationError, cleanupError], message);
}
