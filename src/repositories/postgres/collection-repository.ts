import type { ProductType, RegionalProduct } from "../../providers/types";
import type { SqlExecutor } from "../../server/database/types";
import type { RegionCode } from "../../shared/domain";
import type { CollectionReader } from "../ports";

/** 查询行别名精确匹配采集 DTO；BOOLEAN 只用于 WHERE，不以 SQLite 0/1 暴露给应用。 */
interface CollectionProductRow {
  id: string;
  regionCode: RegionCode;
  currency: string;
  officialPriceId: string | null;
  productUrl: string;
  canonicalTitle: string;
  publisher: string | null;
  productType: ProductType;
}

/**
 * PostgreSQL 定时采集商品读取仓储。
 * 订阅和商品均使用原生 BOOLEAN TRUE 过滤，停用状态不会继续请求外部商店；
 * 查询只返回公开商品身份，不读取认证、通知或外部响应内容。
 */
export class PostgresCollectionRepository implements CollectionReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async enabledRegionalProducts(): Promise<RegionalProduct[]> {
    const result = await this.database.query<CollectionProductRow>(
      `SELECT products.id,
              products.region_code AS "regionCode",
              products.currency,
              products.official_product_id AS "officialPriceId",
              products.product_url AS "productUrl",
              games.name_en AS "canonicalTitle",
              games.publisher,
              games.product_type AS "productType"
         FROM subscriptions
         INNER JOIN subscription_regions
           ON subscription_regions.subscription_id = subscriptions.id
         INNER JOIN regional_products AS products
           ON products.id = subscription_regions.regional_product_id
         INNER JOIN games ON games.id = products.game_id
        WHERE subscriptions.enabled IS TRUE
          AND products.enabled IS TRUE
        ORDER BY subscriptions.created_at ASC, products.region_code ASC, products.id ASC`,
    );
    return result.rows;
  }
}
