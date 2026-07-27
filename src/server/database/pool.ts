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
      try {
        await client.query("BEGIN");
        transactionStarted = true;
        const value = await work(createExecutor(client));
        await client.query("COMMIT");
        transactionStarted = false;
        return value;
      } catch (error) {
        // 只有 BEGIN 成功后才回滚；BEGIN 自身失败时直接归还客户端，避免无事务 ROLLBACK 掩盖原始连接错误。
        if (transactionStarted) {
          await client.query("ROLLBACK");
        }
        throw error;
      } finally {
        // 成功、业务异常和 SQL 异常都必须归还同一个客户端，否则连接池最终会耗尽并阻塞 HTTP/调度请求。
        client.release();
      }
    },

    async withAdvisoryLock<T>(
      key: bigint,
      work: (connection: SqlExecutor) => Promise<T>,
    ): Promise<T | undefined> {
      const client = await pool.connect();
      let acquired = false;
      try {
        const lockResult = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
          // bigint 转十进制字符串可保持 64 位锁键精度，避免 JavaScript number 截断后不同任务误用同一把锁。
          [key.toString()],
        );
        acquired = lockResult.rows[0]?.acquired === true;
        if (!acquired) {
          // try 锁失败必须立即跳过，不排队；这是防止迁移外的定时任务重复采集和重复通知的业务语义。
          return undefined;
        }
        return await work(createExecutor(client));
      } finally {
        let unlockError: Error | undefined;
        try {
          if (acquired) {
            // advisory lock 属于当前数据库会话，必须在归还客户端前显式释放，防止锁随连接回池后永久阻塞后续任务。
            await releaseAdvisoryLock(client, key);
          }
        } catch (error) {
          // 解锁查询异常时销毁而非复用该会话，防止一把状态未知的会话锁随客户端回池并阻塞后续迁移或调度。
          unlockError =
            error instanceof Error ? error : new Error("PostgreSQL advisory lock 释放异常");
          throw error;
        } finally {
          // 正常路径归还客户端；异常路径把错误交给 pg 以淘汰客户端，两者都不会泄漏连接池容量。
          client.release(unlockError);
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
