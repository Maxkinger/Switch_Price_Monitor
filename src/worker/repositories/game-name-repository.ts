import type { GameNameSource } from "../../shared/game-name";
import type { OfficialProductCandidate, RegionCode } from "../../shared/domain";

/**
 * 供名称同步服务消费的只读订阅项。锚点和香港 URL 均从订阅已监控商品恢复，
 * 因而浏览器不能借同步请求替换游戏身份、伪造香港商品或指定另一个订阅的资源。
 */
export interface GameNameSyncItem {
  subscriptionId: string;
  gameId: string;
  source: GameNameSource;
  nameEn: string;
  anchor: OfficialProductCandidate;
  hongKongProductUrl: string | undefined;
}

/** D1 行只承接 SQL 的蛇形字段；仓储在边界处重建受限 DTO，避免数据库列名传播到服务层。 */
interface GameNameSyncRow {
  subscriptionId: string;
  gameId: string;
  source: GameNameSource;
  nameEn: string;
  regionCode: RegionCode;
  productUrl: string;
  currency: string;
  publisher: string | null;
  productType: OfficialProductCandidate["productType"];
  coverUrl: string | null;
}

/**
 * 游戏名称持久化只接受已存在订阅作为写入入口。此仓储不解析任天堂页面、不会猜测翻译，
 * 以保证外部名称解析失败时不会绕过来源审计或改动未被管理员选中的游戏。
 */
export class GameNameRepository {
  public constructor(private readonly database: D1Database) {}

  /**
   * 从订阅、游戏、订阅地区关联与地区商品重建同步所需的只读身份。每个订阅按最早监控商品取一个锚点，
   * 同时保留已监控的香港官方 URL，供后续服务优先复核而不是再次信任浏览器给出的链接。
  */
  public async findForSync(subscriptionIds: string[]): Promise<GameNameSyncItem[]> {
    // 空选择既没有管理员授权的同步对象，也会生成不同 D1 实现可能拒绝或误解释的 `IN ()`；直接返回空结果以避免无意义查询扩大读取范围。
    if (subscriptionIds.length === 0) return [];
    const placeholders = subscriptionIds.map(() => "?").join(", ");
    // 联表范围严格从 subscriptions 开始，既保证锚点属于请求订阅，也避免读取同一游戏但未监控的地区商品作为香港候选。
    const result = await this.database.prepare(
      `SELECT subscriptions.id AS subscriptionId, games.id AS gameId, games.name_zh_source AS source, games.name_en AS nameEn,
              products.region_code AS regionCode, products.product_url AS productUrl, products.currency AS currency,
              games.publisher AS publisher, games.product_type AS productType, games.cover_url AS coverUrl
       FROM subscriptions
       INNER JOIN games ON games.id = subscriptions.game_id
       INNER JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
       INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
       WHERE subscriptions.id IN (${placeholders})
       ORDER BY subscriptions.id ASC, products.created_at ASC, products.id ASC`,
    ).bind(...subscriptionIds).all<GameNameSyncRow>();

    const rowsBySubscription = new Map<string, GameNameSyncRow[]>();
    for (const row of result.results) {
      const rows = rowsBySubscription.get(row.subscriptionId) ?? [];
      rows.push(row);
      rowsBySubscription.set(row.subscriptionId, rows);
    }
    return subscriptionIds.flatMap((subscriptionId) => {
      const rows = rowsBySubscription.get(subscriptionId);
      // 缺少订阅、游戏或 subscription_regions 映射时无法从受控关联恢复官方锚点；不得以名称、其他游戏商品或浏览器 URL 猜补，因此不能产生同步项。
      if (!rows || rows.length === 0) return [];
      const anchor = rows[0];
      // 香港链接仅限当前订阅已关联的 HK 商品；没有该映射时显式留空，让后续服务走受控搜索而非自行拼接 URL。
      const hongKongProductUrl = rows.find((row) => row.regionCode === "HK")?.productUrl;
      return [{
        subscriptionId: anchor.subscriptionId,
        gameId: anchor.gameId,
        source: anchor.source,
        nameEn: anchor.nameEn,
        anchor: {
          regionCode: anchor.regionCode,
          productUrl: anchor.productUrl,
          canonicalTitle: anchor.nameEn,
          publisher: anchor.publisher,
          productType: anchor.productType,
          currency: anchor.currency,
          coverUrl: anchor.coverUrl,
          currentPriceMinor: null,
          regularPriceMinor: null,
        },
        hongKongProductUrl,
      }];
    });
  }

  /**
   * 仅通过订阅反查其所属游戏后更新显示名和来源；浏览器即使猜到 game ID 也无法越过该归属限制。
   * `now` 保留在仓储契约中供同步服务统一传递审计时点，当前表没有游戏名称更新时间列，故不能伪造不存在的审计字段。
   */
  public async updateForSubscription(subscriptionId: string, nameZh: string, source: GameNameSource, now: string): Promise<boolean> {
    void now;
    // 参数化绑定使名称内容不会改变 SQL 结构；子查询是订阅归属的唯一授权边界，零行更新必须返回 false 供调用方安全处理。
    const result = await this.database.prepare(
      `UPDATE games
       SET name_zh = ?, name_zh_source = ?
       WHERE id = (
         SELECT game_id FROM subscriptions WHERE id = ?
       )`,
    ).bind(nameZh, source, subscriptionId).run();
    return result.meta.changes === 1;
  }
}
