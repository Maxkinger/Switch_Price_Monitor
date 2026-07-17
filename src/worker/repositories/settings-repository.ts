import type { AppSettings, InitialSettings, RegionCode, Theme } from "../../shared/domain";

/** D1 查询别名后的内部行模型，与对外 AppSettings 分离以避免泄漏数据库列命名。 */
interface SettingsRow {
  enabledRegionsJson: string;
  defaultSearchRegion: RegionCode;
  theme: Theme;
  timezone: string;
  dailyReportTime: string;
  taxState: string;
  priceHistoryRetention: AppSettings["priceHistoryRetention"];
  createdAt: string;
}

/**
 * 单管理员全局设置的持久化边界。数据库约束保证仅有 id=1，
 * 因此仓储不会接受任意设置 ID，避免个人站点误演变为多租户数据模型。
 */
export class SettingsRepository {
  public constructor(private readonly database: D1Database) {}

  public async saveInitial(settings: InitialSettings): Promise<void> {
    // 初始化只写入用户必须选择的地区；其余偏好使用迁移定义的安全默认值，减少首次配置负担。
    await this.database
      .prepare(
        `INSERT INTO settings (
          id,
          enabled_regions_json,
          default_search_region,
          created_at,
          updated_at
        ) VALUES (1, ?, ?, ?, ?)`,
      )
      .bind(
        JSON.stringify(settings.enabledRegions),
        settings.defaultSearchRegion,
        settings.createdAt,
        settings.createdAt,
      )
      .run();
  }

  public async get(): Promise<AppSettings | null> {
    // 使用显式列和别名而不是 SELECT *，确保新增敏感设置列不会意外被 API 返回。
    const row = await this.database
      .prepare(
        `SELECT
          enabled_regions_json AS enabledRegionsJson,
          default_search_region AS defaultSearchRegion,
          theme,
          timezone,
          daily_report_time AS dailyReportTime,
          tax_state AS taxState,
          price_history_retention AS priceHistoryRetention,
          created_at AS createdAt
        FROM settings
        WHERE id = 1`,
      )
      .first<SettingsRow>();

    // 无单例设置记录意味着部署尚未完成首次管理员初始化。
    if (!row) return null;

    // enabled_regions_json 是受控 RegionCode 数组；写入由服务层校验，读取时恢复为领域类型供 UI 使用。
    return {
      enabledRegions: JSON.parse(row.enabledRegionsJson) as RegionCode[],
      defaultSearchRegion: row.defaultSearchRegion,
      theme: row.theme,
      timezone: row.timezone,
      dailyReportTime: row.dailyReportTime,
      taxState: row.taxState,
      priceHistoryRetention: row.priceHistoryRetention,
      createdAt: row.createdAt,
    };
  }

  /**
   * 完整替换单例设置的可公开字段，同时保留首次初始化时间。调用者必须先在服务层合并与校验局部更新，
   * 仓储不接受任意列名或动态 SQL，避免将未来的 Telegram 等敏感列意外写入或暴露。
   */
  public async save(settings: AppSettings, updatedAt: string): Promise<void> {
    await this.database
      .prepare(
        `UPDATE settings
         SET enabled_regions_json = ?, default_search_region = ?, theme = ?, timezone = ?,
             daily_report_time = ?, tax_state = ?, price_history_retention = ?, updated_at = ?
         WHERE id = 1`,
      )
      .bind(
        JSON.stringify(settings.enabledRegions),
        settings.defaultSearchRegion,
        settings.theme,
        settings.timezone,
        settings.dailyReportTime,
        settings.taxState,
        settings.priceHistoryRetention,
        updatedAt,
      )
      .run();
  }
}
