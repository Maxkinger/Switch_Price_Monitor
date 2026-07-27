import type { SqlExecutor } from "../../server/database/types";
import type { HistoricalLow, PriceSource } from "../../shared/domain";
import type { PriceReader } from "../ports";

interface CountRow { count: string; }
interface OfficialPriceRow { amountMinor: number; source: "official"; }
interface HistoricalLowRow {
  regionalProductId: string;
  amountMinor: number;
  currency: string;
  cnyFen: number | null;
  source: PriceSource;
  capturedAt: Date;
  regionCode: string;
}

/**
 * PostgreSQL 价格读取仓储。
 * 价格金额继续使用整数最小单位；BIGINT identity 只作为数据库内确定性排序键，
 * COUNT 的 pg 字符串结果显式校验安全整数后才进入业务层，避免隐式转换截断。
 */
export class PostgresPriceRepository implements PriceReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async countForRegionalProduct(regionalProductId: string): Promise<number> {
    const result = await this.database.query<CountRow>(
      `SELECT COUNT(*) AS count
         FROM price_snapshots
        WHERE regional_product_id = $1`,
      [regionalProductId],
    );
    return parseSafeCount(result.rows[0]?.count ?? "0");
  }

  public async latestOfficialFor(regionalProductId: string): Promise<OfficialPriceRow | null> {
    const result = await this.database.query<OfficialPriceRow>(
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

  public async lowestForRegionalProduct(regionalProductId: string): Promise<HistoricalLow | null> {
    const result = await this.database.query<HistoricalLowRow>(
      `SELECT snapshots.regional_product_id AS "regionalProductId",
              snapshots.amount_minor AS "amountMinor",
              snapshots.currency,
              snapshots.cny_fen AS "cnyFen",
              snapshots.source,
              snapshots.captured_at AS "capturedAt",
              products.region_code AS "regionCode"
         FROM price_snapshots AS snapshots
         INNER JOIN regional_products AS products
           ON products.id = snapshots.regional_product_id
        WHERE snapshots.regional_product_id = $1
        ORDER BY snapshots.amount_minor ASC,
                 snapshots.captured_at ASC,
                 snapshots.id ASC
        LIMIT 1`,
      [regionalProductId],
    );
    const row = result.rows[0];
    return row ? { ...row, capturedAt: row.capturedAt.toISOString() } : null;
  }
}

/** pg 对 COUNT/BIGINT 返回十进制字符串；禁止 Number() 在 2^53 以上静默舍入。 */
function parseSafeCount(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("PostgreSQL count 不是非负整数");
  const count = BigInt(value);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("PostgreSQL count 超出 JavaScript 安全整数范围");
  return Number(count);
}
