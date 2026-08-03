import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppDatabase, SqlExecutor } from "./types";

// 固定 64 位 key 只用于模式迁移；与后续采集、日报等任务锁隔离，避免不同业务边界互相错误阻塞。
const MIGRATION_ADVISORY_LOCK_KEY = 0x5357504d00000001n;
const LOCK_RETRY_DELAY_MS = 10;

interface MigrationFile {
  version: string;
  checksum: string;
  sql: string;
}

interface AppliedMigrationRow {
  version: string;
  checksum: string;
}

/**
 * 读取目录内全部 SQL 文件并按文件名的确定性词法顺序排列。
 * 校验和直接基于原始字节计算；换行、注释或编码字节变化都视为历史迁移被修改，不能用解析后的 SQL 掩盖差异。
 */
async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const versions = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return Promise.all(versions.map(async (version) => {
    const bytes = await readFile(join(directory, version));
    return {
      version,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      sql: bytes.toString("utf8"),
    };
  }));
}

/**
 * 在迁移锁连接上创建不可变历史表。
 * IF NOT EXISTS 仅解决全新数据库的引导问题；后续是否跳过文件完全由 version 与 checksum 联合校验决定。
 */
async function ensureMigrationTable(connection: SqlExecutor): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * 在当前 advisory-lock 会话上用显式事务应用一个文件并记录校验和。
 * SQL 与迁移记录必须共同提交；任何表、索引或记录写入失败都回滚，启动时不会看到“已记录但未完成”的半迁移状态。
 */
async function applyMigration(connection: SqlExecutor, migration: MigrationFile): Promise<void> {
  await connection.query("BEGIN");
  try {
    await connection.query(migration.sql);
    await connection.query(
      "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
      [migration.version, migration.checksum],
    );
    await connection.query("COMMIT");
  } catch (error) {
    try {
      await connection.query("ROLLBACK");
    } catch (rollbackError) {
      // 同时暴露原始迁移错误与回滚错误，便于安全停机诊断；不得把失败迁移继续标记为已应用。
      throw new AggregateError([error, rollbackError], `迁移 ${migration.version} 执行失败且回滚未完成。`);
    }
    throw error;
  }
}

/**
 * 在已持有迁移锁的单一连接内验证全部历史，再依次应用新文件。
 * 先完成全量 checksum 检查再执行任何新迁移，确保被篡改的旧版本会立即停止启动而不会夹带后续模式变化。
 */
async function migrateWithConnection(connection: SqlExecutor, migrations: MigrationFile[]): Promise<void> {
  await ensureMigrationTable(connection);
  const applied = await connection.query<AppliedMigrationRow>(
    "SELECT version, checksum FROM schema_migrations ORDER BY version",
  );
  const filesByVersion = new Map(migrations.map((migration) => [migration.version, migration]));

  for (const row of applied.rows) {
    const migration = filesByVersion.get(row.version);
    if (!migration) {
      throw new Error(`已应用迁移 ${row.version} 在迁移目录中缺失，拒绝继续启动。`);
    }
    if (migration.checksum !== row.checksum) {
      throw new Error(`Migration checksum mismatch for ${row.version}; refusing to rewrite applied history.`);
    }
  }

  const appliedVersions = new Set(applied.rows.map(({ version }) => version));
  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      await applyMigration(connection, migration);
    }
  }
}

/**
 * 按不可变版本运行 PostgreSQL 迁移。
 * 多实例竞争时使用非阻塞 try-lock 加短间隔重试，使后启动实例等待首个 runner 完成后重新校验历史，而不是并发建表或直接跳过启动前置条件。
 */
export async function runMigrations(database: AppDatabase, directory: string): Promise<void> {
  const migrations = await readMigrationFiles(directory);

  while (true) {
    const completed = await database.withAdvisoryLock(MIGRATION_ADVISORY_LOCK_KEY, async (connection) => {
      await migrateWithConnection(connection, migrations);
      return true;
    });
    if (completed) return;

    await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_DELAY_MS));
  }
}
