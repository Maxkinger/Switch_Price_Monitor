/**
 * 数据库查询的最小稳定返回契约。
 * 业务层只接收行数据和确定的受影响行数，不能依赖 pg 的原始客户端、字段元数据或可变连接状态。
 */
export interface SqlResult<Row> {
  rows: Row[];
  rowCount: number;
}

/**
 * 可执行参数化 SQL 的受限接口。
 * 参数数组保持只读，要求调用方使用 PostgreSQL 占位符而不是拼接认证材料、价格来源或其他外部输入。
 */
export interface SqlExecutor {
  query<Row>(sql: string, parameters?: readonly unknown[]): Promise<SqlResult<Row>>;
}

/**
 * 应用数据库只公开查询、事务、会话级 advisory lock 和关闭能力。
 * 原始连接池不会跨越此边界，从而避免业务仓储忘记释放连接或绕过统一事务规则。
 */
export interface AppDatabase extends SqlExecutor {
  transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
  withAdvisoryLock<T>(key: bigint, work: (connection: SqlExecutor) => Promise<T>): Promise<T | undefined>;
  close(): Promise<void>;
}
