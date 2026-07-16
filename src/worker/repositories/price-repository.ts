import type { HistoricalLow, PriceSnapshot } from "../../shared/domain";

export class PriceRepository {
  public constructor(private readonly database: D1Database) {}

  public async append(snapshot: PriceSnapshot): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO price_snapshots (
          regional_product_id,
          amount_minor,
          currency,
          cny_fen,
          source,
          captured_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        snapshot.regionalProductId,
        snapshot.amountMinor,
        snapshot.currency,
        snapshot.cnyFen,
        snapshot.source,
        snapshot.capturedAt,
      )
      .run();
  }

  public async countForRegionalProduct(regionalProductId: string): Promise<number> {
    const row = await this.database
      .prepare("SELECT COUNT(*) AS count FROM price_snapshots WHERE regional_product_id = ?")
      .bind(regionalProductId)
      .first<{ count: number }>();

    return row?.count ?? 0;
  }

  public async lowestForRegionalProduct(regionalProductId: string): Promise<HistoricalLow | null> {
    return this.database
      .prepare(
        `SELECT
          snapshots.regional_product_id AS regionalProductId,
          snapshots.amount_minor AS amountMinor,
          snapshots.currency AS currency,
          snapshots.cny_fen AS cnyFen,
          snapshots.source AS source,
          snapshots.captured_at AS capturedAt,
          products.region_code AS regionCode
        FROM price_snapshots AS snapshots
        INNER JOIN regional_products AS products ON products.id = snapshots.regional_product_id
        WHERE snapshots.regional_product_id = ?
        ORDER BY snapshots.amount_minor ASC, snapshots.captured_at ASC
        LIMIT 1`,
      )
      .bind(regionalProductId)
      .first<HistoricalLow>();
  }
}
