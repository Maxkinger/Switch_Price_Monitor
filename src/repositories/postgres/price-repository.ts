import type { SqlExecutor } from "../../server/database/types";
import type { HistoricalLow, PriceSnapshot } from "../../shared/domain";

/** pg 对 COUNT(*)/BIGINT 使用字符串，必须在显式安全范围校验后才能转换为 JavaScript number。 */
interface CountRow {
  count: string;
}

/** 最近官方快照只需金额与固定来源；第三方记录在 SQL 条件中被排除，不能成为即时降价比较基线。 */
interface LatestOfficialRow {
  amountMinor: number;
  source: "official";
}

/** 历史最低价行把 TIMESTAMPTZ 保留为驱动实际类型，仓储返回领域 DTO 前统一转换为 ISO 字符串。 */
interface HistoricalLowRow {
  regionalProductId: string;
  amountMinor: number;
  currency: string;
  cnyFen: number | null;
  source: HistoricalLow["source"];
  capturedAt: Date | string;
  regionCode: string;
}

/**
 * PostgreSQL 价格快照仓储保持只追加事实，并提供当前提醒与历史展示需要的窄查询。
 * 金额始终使用整数最小货币单位，仓储不得用浮点换算或让缺失人民币值变成零。
 */
export class PriceRepository {
  public constructor(private readonly database: SqlExecutor) {}

  /** 追加一条不可变价格事实；所有外部来源字段都作为参数传入，不能进入 SQL 结构。 */
  public async append(snapshot: PriceSnapshot): Promise<void> {
    await this.database.query(
      `INSERT INTO price_snapshots (
         regional_product_id, amount_minor, currency, cny_fen, source, captured_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [snapshot.regionalProductId, snapshot.amountMinor, snapshot.currency, snapshot.cnyFen, snapshot.source, snapshot.capturedAt],
    );
  }

  /** COUNT(*) 的 BIGINT 字符串只在 0..Number.MAX_SAFE_INTEGER 内转换，防止长期保留历史后静默丢失精度。 */
  public async countForRegionalProduct(regionalProductId: string): Promise<number> {
    const result = await this.database.query<CountRow>(
      `SELECT COUNT(*) AS "count"
         FROM price_snapshots
        WHERE regional_product_id = $1`,
      [regionalProductId],
    );
    const rawCount = result.rows[0]?.count ?? "0";
    let count: bigint;
    try {
      count = BigInt(rawCount);
    } catch {
      throw new Error("价格快照计数不是有效 BIGINT。");
    }
    if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("价格快照计数超过 JavaScript 安全整数范围。");
    }
    return Number(count);
  }

  /** 仅选择最新官方快照；相同捕获时刻用较大 identity 表示后写入事实，第三方价格始终排除。 */
  public async latestOfficialFor(regionalProductId: string): Promise<{ amountMinor: number; source: "official" } | null> {
    const result = await this.database.query<LatestOfficialRow>(
      `SELECT amount_minor AS "amountMinor", source
         FROM price_snapshots
        WHERE regional_product_id = $1
          AND source = 'official'
        ORDER BY captured_at DESC, id DESC
        LIMIT 1`,
      [regionalProductId],
    );
    return result.rows[0] ?? null;
  }

  /** 最低本币价格同价取最早时间，时间仍相等时取最早 identity，使来源与人民币换算展示长期稳定。 */
  public async lowestForRegionalProduct(regionalProductId: string): Promise<HistoricalLow | null> {
    const result = await this.database.query<HistoricalLowRow>(
      `SELECT snapshots.regional_product_id AS "regionalProductId",
              snapshots.amount_minor AS "amountMinor",
              snapshots.currency AS currency,
              snapshots.cny_fen AS "cnyFen",
              snapshots.source AS source,
              snapshots.captured_at AS "capturedAt",
              products.region_code AS "regionCode"
         FROM price_snapshots AS snapshots
         INNER JOIN regional_products AS products ON products.id = snapshots.regional_product_id
        WHERE snapshots.regional_product_id = $1
        ORDER BY snapshots.amount_minor ASC, snapshots.captured_at ASC, snapshots.id ASC
        LIMIT 1`,
      [regionalProductId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, capturedAt: toIsoString(row.capturedAt) };
  }
}

/** TIMESTAMPTZ 必须以 UTC ISO 字符串离开仓储，避免 Date 在 JSON/CSV 之外被宿主时区隐式格式化。 */
function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("价格捕获时间无效。");
  return date.toISOString();
}
