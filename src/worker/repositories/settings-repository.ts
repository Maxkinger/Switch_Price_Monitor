import type { AppSettings, InitialSettings, RegionCode, Theme } from "../../shared/domain";

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

export class SettingsRepository {
  public constructor(private readonly database: D1Database) {}

  public async saveInitial(settings: InitialSettings): Promise<void> {
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

    if (!row) {
      return null;
    }

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
}
