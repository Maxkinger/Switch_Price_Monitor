import type { AppSettings, InitialSettings, RegionCode, Theme } from "../shared/domain";
import { validateSettings } from "../services/settings-service";
import type { SettingsPatch, SettingsStore } from "./ports";

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
export class SettingsRepository implements SettingsStore {
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
   * Worker 过渡仓储也只接收局部补丁，并保留首次初始化时间与未提交字段。
   * NAS PostgreSQL 使用行锁完成多进程并发保证；D1 兼容层维持相同的字段白名单和校验边界，避免 Task 5 前重新允许浏览器覆盖秘密配置。
   */
  public async save(patch: SettingsPatch, updatedAt: string): Promise<AppSettings | null> {
    const current = await this.get();
    if (!current) return null;
    const settings: AppSettings = {
      ...current,
      ...patch,
      enabledRegions: patch.enabledRegions ?? current.enabledRegions,
      defaultSearchRegion: patch.defaultSearchRegion ?? current.defaultSearchRegion,
      createdAt: current.createdAt,
    };
    validateSettings(settings);
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
    return settings;
  }
}
