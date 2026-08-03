import type { ProductType, RegionalProduct } from "../../providers/types";
import type { SqlExecutor } from "../../server/database/types";

/** PostgreSQL 联表行使用原生 BOOLEAN 过滤，返回前只保留采集器所需的公开商品身份字段。 */
interface CollectionProductRow {
  id: string;
  regionCode: RegionalProduct["regionCode"];
  currency: string;
  officialPriceId: string | null;
  productUrl: string;
  canonicalTitle: string;
  publisher: string | null;
  productType: ProductType;
}

/**
 * PostgreSQL 定时采集读取仓储。
 * 订阅与地区商品必须同时启用才返回，数据库条件是防止过期页面状态继续访问外部价格来源和触发错误通知的最后防线。
 */
export class CollectionRepository {
  public constructor(private readonly database: SqlExecutor) {}

  public async enabledRegionalProducts(): Promise<RegionalProduct[]> {
    const result = await this.database.query<CollectionProductRow>(
      `SELECT products.id AS id,
              products.region_code AS "regionCode",
              products.currency AS currency,
              products.official_product_id AS "officialPriceId",
              products.product_url AS "productUrl",
              games.name_en AS "canonicalTitle",
              games.publisher AS publisher,
              games.product_type AS "productType"
         FROM subscriptions
         INNER JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
         INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
         INNER JOIN games ON games.id = products.game_id
        WHERE subscriptions.enabled IS TRUE
          AND products.enabled IS TRUE
        ORDER BY subscriptions.created_at ASC, products.region_code ASC`,
    );

    // 商品类型和地区代码由确认流程写入受控枚举；仓储不附带 URL 响应或内部订阅字段，保持采集输入最小化。
    return result.rows.map((row) => ({ ...row }));
  }
}
