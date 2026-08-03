import type { ProductType, RegionalProduct } from "../providers/types";

/** D1 联表读取的内部模型；商品身份来自管理员已确认的游戏主档，供 ProviderChain 阻止错配写入。 */
interface CollectionProductRow {
  id: string;
  regionCode: RegionalProduct["regionCode"];
  currency: string;
  /** 读取可空的地区专属官方价格 ID；采集器据此决定是否能安全调用需要该 ID 的官方接口。 */
  officialPriceId: string | null;
  productUrl: string;
  canonicalTitle: string;
  publisher: string | null;
  productType: ProductType;
}

/**
 * 定时采集的读取边界。仅联结 enabled 订阅与 enabled 地区商品，
 * 以数据库条件作为最后防线，避免过期前端状态让已停用商品继续请求外部商店。
 */
export class CollectionRepository {
  public constructor(private readonly database: D1Database) {}

  public async enabledRegionalProducts(): Promise<RegionalProduct[]> {
    const result = await this.database.prepare(
      `SELECT products.id AS id, products.region_code AS regionCode, products.currency AS currency,
              products.official_product_id AS officialPriceId, products.product_url AS productUrl, games.name_en AS canonicalTitle,
              games.publisher AS publisher, games.product_type AS productType
       FROM subscriptions
       INNER JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
       INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
       INNER JOIN games ON games.id = products.game_id
       WHERE subscriptions.enabled = 1 AND products.enabled = 1
       ORDER BY subscriptions.created_at ASC, products.region_code ASC`,
    ).all<CollectionProductRow>();
    // 游戏商品类型由创建/确认流程写入受控枚举；转换集中在这里，防止采集器接受任意数据库字符串。
    return result.results.map((row) => ({ ...row, productType: row.productType }));
  }
}
