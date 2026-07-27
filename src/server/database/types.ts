/**
 * 数据库查询统一返回普通行数组和非空影响行数，屏蔽 pg 对 COPY 等命令可能返回 null 的驱动细节。
 * Row 由调用方按已审计 SQL 的列别名声明；业务层不得借此跳过对 JSONB 或外部输入的运行时校验。
 */
export interface SqlResult<Row> {
  rows: Row[];
  rowCount: number;
}

/**
 * 最小参数化 SQL 执行边界。所有用户值必须通过 parameters 传入，禁止拼接认证材料、筛选值或价格来源数据。
 * 只读数组允许调用方安全复用参数，但实现传给 pg 前会复制为驱动接受的可变数组。
 */
export interface SqlExecutor {
  query<Row>(sql: string, parameters?: readonly unknown[]): Promise<SqlResult<Row>>;
}

/**
 * 应用数据库拥有连接池生命周期、显式事务及非阻塞 advisory lock。
 * 事务和锁回调只能看到 SqlExecutor，避免业务层保存原始 PoolClient、越过提交边界或忘记归还连接。
 */
export interface AppDatabase extends SqlExecutor {
  transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
  withAdvisoryLock<T>(
    key: bigint,
    work: (connection: SqlExecutor) => Promise<T>,
  ): Promise<T | undefined>;
  close(): Promise<void>;
}
