import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { AppDatabase, SqlExecutor, SqlResult } from "./types";

type QueryConnection = Pick<Pool | PoolClient, "query">;

/**
 * 将 pg 连接收窄为平台中立查询接口。
 * pg 在部分命令上可能返回 null rowCount；应用契约统一转换为 0，避免仓储把“无可报告行数”误当作未初始化值。
 */
function createExecutor(connection: QueryConnection): SqlExecutor {
  return {
    async query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
      // pg 类型要求可变数组，但驱动只读取参数；复制可保护调用方的只读输入，也禁止驱动持有其原始引用。
      const result = await connection.query<QueryResultRow>(sql, [...parameters]);
      return {
        rows: result.rows as Row[],
        rowCount: result.rowCount ?? 0,
      };
    },
  };
}

/**
 * 创建应用唯一的 PostgreSQL 基础连接池。
 * connectionString 必须由启动配置显式提供；此层不包含测试、开发或 NAS 默认凭据，防止缺失配置时误连错误数据库。
 */
export function createPostgresDatabase(connectionString: string): AppDatabase {
  // 单管理员 HTTP 与少量后台任务共用最多五条连接；限制池大小可避免 NAS PostgreSQL 被意外并发或重复实例耗尽。
  const pool = new Pool({ connectionString, max: 5 });
  const executor = createExecutor(pool);

  return {
    query<Row>(sql: string, parameters?: readonly unknown[]) {
      return executor.query<Row>(sql, parameters);
    },

    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
      // 整个事务固定使用同一个已签出连接；跨连接执行 BEGIN/COMMIT 会破坏认证、订阅等多语句写入的原子性。
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await work(createExecutor(client));
        await client.query("COMMIT");
        return value;
      } catch (error) {
        // 回滚覆盖回调已完成的全部语句，确保失败的密码重置、订阅确认或价格写入不会留下半成品。
        await client.query("ROLLBACK");
        throw error;
      } finally {
        // 无论提交、业务异常或回滚结果如何都归还连接，避免池耗尽后让健康检查和后台任务永久阻塞。
        client.release();
      }
    },

    async withAdvisoryLock<T>(key: bigint, work: (connection: SqlExecutor) => Promise<T>): Promise<T | undefined> {
      // 会话级锁必须与受保护工作使用同一连接；使用 try-lock 可让竞争者立即跳过，避免重复迁移或调度任务排队堆积。
      const client = await pool.connect();
      let acquired = false;
      try {
        const result = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS acquired",
          [key.toString()],
        );
        acquired = result.rows[0]?.acquired === true;
        if (!acquired) return undefined;

        return await work(createExecutor(client));
      } finally {
        try {
          if (acquired) {
            // 显式解锁后才归还连接，防止会话锁随池连接泄漏到无关请求并导致后续任务被永久跳过。
            await client.query("SELECT pg_advisory_unlock($1)", [key.toString()]);
          }
        } finally {
          // 即使连接中断导致解锁命令报错，也必须把客户端交还给 pg 处理，不能让池永久损失一个签出槽位。
          client.release();
        }
      }
    },

    async close(): Promise<void> {
      // end 会等待已签出连接归还；测试和服务停机必须调用它，确保没有悬挂 socket 阻止进程退出。
      await pool.end();
    },
  };
}
