import type { AppDatabase, SqlExecutor } from "../../server/database/types";
import type {
  GameNameBackfillResult,
  GameNameCatalogEntry,
  GameNameIdentityTarget,
  GameNameSaveInput,
  GameNameStore,
  PendingGameName,
} from "../ports";

/** PostgreSQL 读取词条时的行投影；TIMESTAMPTZ 由 pg 解码为 Date，离开仓储前必须还原 ISO 字符串 DTO。 */
interface CatalogEntryRow {
  identityKey: string;
  displayNameZhCn: string;
  source: GameNameCatalogEntry["source"];
  evidenceUrl: string | null;
  confirmedAt: Date;
}

/** 待确认查询只读取管理判定所需的公开身份和旧候选，避免把认证、价格或地区 URL 暴露给名称流程。 */
interface PendingGameNameRow {
  gameId: string;
  subscriptionId: string;
  identityKey: string | null;
  officialTitle: string;
  publisher: string | null;
  productType: PendingGameName["productType"];
  legacyNameZh: string;
}

/** 按游戏 ID 查名称保存身份的最窄行投影；查询绝不带 display_name_zh_cn 条件，使详情页可更正已确认记录。 */
interface GameNameIdentityRow {
  identityKey: string | null;
}

/** 回填 RETURNING 只取游戏 ID，调用方不能依赖 PostgreSQL 驱动的影响行数或泄漏数据库行。 */
interface UpdatedGameRow {
  gameId: string;
}

/** 剩余待确认数以 SQL COUNT 文本返回；转换前必须校验安全整数以避免损坏数据静默误报。 */
interface CountRow {
  count: string;
}

/**
 * 简体中文名称的 PostgreSQL 适配器。
 * 所有外部或管理员提供的值均通过参数化 SQL 传入；词条与当前游戏的人工确认同一事务写入，
 * 防止词条已可复用但当前管理员操作失败，或当前游戏确认后却丢失审计来源的半成品状态。
 */
export class PostgresGameNameRepository implements GameNameStore {
  public constructor(private readonly database: AppDatabase) {}

  public async findCatalogEntry(identityKey: string): Promise<GameNameCatalogEntry | null> {
    const result = await this.database.query<CatalogEntryRow>(
      `SELECT identity_key AS "identityKey",
              display_name_zh_cn AS "displayNameZhCn",
              source,
              evidence_url AS "evidenceUrl",
              confirmed_at AS "confirmedAt"
         FROM game_name_catalog
        WHERE identity_key = $1`,
      [identityKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCatalogEntry(row);
  }

  /**
   * 详情页人工更正必须先取得既有游戏的精确官方身份，而不是从 pending 列表推断。
   * 该查询只读 games.normalized_name，故已确认名称、目录来源和订阅状态不会改变存在性或复用范围判断。
   */
  public async findGameIdentity(gameId: string): Promise<GameNameIdentityTarget | null> {
    const result = await this.database.query<GameNameIdentityRow>(
      `SELECT normalized_name AS "identityKey"
         FROM games
        WHERE id = $1`,
      [gameId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { identityKey: row.identityKey };
  }

  public async listPending(): Promise<PendingGameName[]> {
    const result = await this.database.query<PendingGameNameRow>(
      `SELECT games.id AS "gameId",
              subscriptions.id AS "subscriptionId",
              games.normalized_name AS "identityKey",
              games.name_en AS "officialTitle",
              games.publisher,
              games.product_type AS "productType",
              games.name_zh AS "legacyNameZh"
         FROM games
         INNER JOIN subscriptions ON subscriptions.game_id = games.id
        WHERE games.display_name_zh_cn IS NULL
        ORDER BY games.created_at ASC, games.id ASC`,
    );
    return result.rows.map((row) => ({ ...row }));
  }

  public async applyCatalogBackfill(_now: string): Promise<GameNameBackfillResult> {
    // confirmed_at 必须沿用词条被证实的时刻而非本轮调度 now；否则重试会伪造新的来源确认时间并损害审计。
    return this.database.transaction(async (transaction) => {
      const updated = await transaction.query<UpdatedGameRow>(
        `UPDATE games
            SET display_name_zh_cn = catalog.display_name_zh_cn,
                display_name_source = 'catalog',
                display_name_confirmed_at = catalog.confirmed_at
           FROM game_name_catalog AS catalog
          WHERE games.display_name_zh_cn IS NULL
            AND games.normalized_name IS NOT NULL
            AND catalog.identity_key = games.normalized_name
          RETURNING games.id AS "gameId"`,
      );
      const remaining = await transaction.query<CountRow>(
        `SELECT COUNT(*)::text AS count
           FROM games
           INNER JOIN subscriptions ON subscriptions.game_id = games.id
          WHERE games.display_name_zh_cn IS NULL`,
      );
      return {
        updatedGameIds: updated.rows.map((row) => row.gameId),
        remainingCount: parseRemainingCount(remaining.rows[0]?.count),
      };
    });
  }

  public async saveGameName(input: GameNameSaveInput): Promise<void> {
    await this.database.transaction(async (transaction) => {
      if (input.saveToCatalog) await upsertCatalogEntry(transaction, input);
      // 当前游戏始终标为 manual：即使名称同时写入通用词条，它仍是管理员针对该记录的最终覆盖，绝不能被随后回填改写。
      await transaction.query(
        `UPDATE games
            SET display_name_zh_cn = $1,
                display_name_source = 'manual',
                display_name_confirmed_at = $2
          WHERE id = $3`,
        [input.displayNameZhCn, input.confirmedAt, input.gameId],
      );
    });
  }
}

/** 将 pg 的 Date 投影为跨端口稳定的 ISO 文本；词条 DTO 不向服务层暴露驱动日期对象。 */
function toCatalogEntry(row: CatalogEntryRow): GameNameCatalogEntry {
  return {
    identityKey: row.identityKey,
    displayNameZhCn: row.displayNameZhCn,
    source: row.source,
    evidenceUrl: row.evidenceUrl,
    confirmedAt: row.confirmedAt.toISOString(),
  };
}

/**
 * 同一 identity_key 的词条按最新人工受控确认覆盖，避免管理员更正公开来源后旧文本仍被未来回填使用。
 * SQL 中没有拼接展示名、来源或证据链接，因而管理员输入不能改变查询结构或接触其他词条。
 */
async function upsertCatalogEntry(transaction: SqlExecutor, input: GameNameSaveInput): Promise<void> {
  await transaction.query(
    `INSERT INTO game_name_catalog (
       identity_key, display_name_zh_cn, source, evidence_url, confirmed_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (identity_key) DO UPDATE
       SET display_name_zh_cn = EXCLUDED.display_name_zh_cn,
           source = EXCLUDED.source,
           evidence_url = EXCLUDED.evidence_url,
           confirmed_at = EXCLUDED.confirmed_at`,
    [input.identityKey, input.displayNameZhCn, input.source, input.evidenceUrl, input.confirmedAt],
  );
}

/** COUNT 只能是非负安全整数；不合法时抛错而非把数据库损坏状态误报为“没有待确认名称”。 */
function parseRemainingCount(value: string | undefined): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("游戏名称待确认数量无效");
  return count;
}
