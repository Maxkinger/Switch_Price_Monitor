import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppDatabase, SqlExecutor } from "./types";

/**
 * 迁移使用独立的 64 位 advisory lock 键；后续定时采集和日报必须使用其他键，
 * 避免慢迁移与业务调度互相误判为重复执行。固定值属于协议，不含数据库凭据或业务标识。
 */
const MIGRATION_ADVISORY_LOCK_KEY = 8_602_727_000n;
const MIGRATION_LOCK_RETRY_MILLISECONDS = 25;

interface MigrationFile {
  version: string;
  checksum: string;
  sql: string;
}

/**
 * 在专用 advisory lock 下按文件名字典序执行不可变迁移。
 * try-lock 未取得时短暂等待并重试，确保第二个应用实例最终重查并继续，而不是跳过尚未完成的 schema 初始化。
 */
export async function runMigrations(database: AppDatabase, directory: string): Promise<void> {
  while (true) {
    const acquired = await database.withAdvisoryLock(
      MIGRATION_ADVISORY_LOCK_KEY,
      async (connection) => {
        await migrateWhileLocked(database, connection, directory);
        return true;
      },
    );
    if (acquired === true) {
      return;
    }
    await delay(MIGRATION_LOCK_RETRY_MILLISECONDS);
  }
}

/**
 * 锁内先建立最小迁移账本，再比较所有已存在版本的 SHA-256。
 * 任何历史字节变化都在执行新 SQL 前终止，防止多个实例在不一致 schema 上继续启动。
 */
async function migrateWhileLocked(
  database: AppDatabase,
  connection: SqlExecutor,
  directory: string,
): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const migrations = await readMigrationFiles(directory);
  const appliedResult = await connection.query<{ version: string; checksum: string }>(
    "SELECT version, checksum FROM schema_migrations",
  );
  const appliedChecksums = new Map(
    appliedResult.rows.map((row) => [row.version, row.checksum]),
  );

  for (const migration of migrations) {
    const appliedChecksum = appliedChecksums.get(migration.version);
    if (appliedChecksum !== undefined) {
      if (appliedChecksum !== migration.checksum) {
        throw new Error(
          `迁移 ${migration.version} 的 SHA-256 校验和与已应用记录不一致，拒绝启动`,
        );
      }
      continue;
    }

    // SQL 与迁移账本写入必须在同一 checked-out-client 事务中完成；任一句失败都不能留下部分 schema 或虚假已应用记录。
    await database.transaction(async (transaction) => {
      await transaction.query(migration.sql);
      await transaction.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum],
      );
    });
  }
}

/**
 * 只读取目录第一层的普通 `.sql` 文件并按完整文件名字典序排序。
 * 校验和基于 readFile 得到的精确字节，SQL 解码也来自同一 Buffer，避免换行正规化掩盖历史迁移修改。
 */
async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const versions = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));

  return Promise.all(
    versions.map(async (version) => {
      const bytes = await readFile(join(directory, version));
      return {
        version,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        sql: bytes.toString("utf8"),
      };
    }),
  );
}

/**
 * 锁竞争重试只让出 Node 事件循环，不持有数据库客户端或事务。
 * 迁移锁属于启动正确性边界，因此不设静默跳过上限；数据库连接或 SQL 错误仍会立即向上抛出。
 */
async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
