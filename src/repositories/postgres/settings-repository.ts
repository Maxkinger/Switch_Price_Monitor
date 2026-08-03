import type { SqlExecutor } from "../../server/database/types";
import type { AppSettings, RegionCode, Theme } from "../../shared/domain";
import { SettingsValidationError, validateSettings } from "../../services/settings-service";
import type { SettingsReader } from "../ports";

/** PostgreSQL JSONB 与 TIMESTAMPTZ 解码后的内部行模型；未知 JSONB 必须在返回领域 DTO 前完成运行时校验。 */
interface SettingsRow {
  enabledRegions: unknown;
  defaultSearchRegion: string;
  theme: string;
  timezone: string;
  dailyReportTime: string;
  taxState: string;
  priceHistoryRetention: string;
  createdAt: Date | string;
}

/**
 * PostgreSQL 单管理员设置读取仓储。
 * 只选择公开设置列并使用稳定别名，未来即使同表新增 Telegram 或其他秘密配置，也不会因宽泛查询进入服务或 API。
 */
export class SettingsRepository implements SettingsReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async get(): Promise<AppSettings | null> {
    const result = await this.database.query<SettingsRow>(
      `SELECT enabled_regions_json AS "enabledRegions",
              default_search_region AS "defaultSearchRegion",
              theme,
              timezone,
              daily_report_time AS "dailyReportTime",
              tax_state AS "taxState",
              price_history_retention AS "priceHistoryRetention",
              created_at AS "createdAt"
         FROM settings
        WHERE id = 1`,
    );
    const row = result.rows[0];
    // 缺少单例设置表示尚未完成首次初始化；仓储不伪造默认对象，以免认证流程误判站点已经可用。
    if (!row) return null;

    if (!Array.isArray(row.enabledRegions)) {
      // 合法 JSONB 仍可能是对象、字符串或 null；统一交给现有设置错误类型，禁止原始数据库值越过业务边界。
      throw new SettingsValidationError("设置中的启用地区必须是数组。");
    }

    const settings: AppSettings = {
      enabledRegions: row.enabledRegions as RegionCode[],
      defaultSearchRegion: row.defaultSearchRegion as RegionCode,
      theme: row.theme as Theme,
      timezone: row.timezone,
      dailyReportTime: row.dailyReportTime,
      taxState: row.taxState,
      priceHistoryRetention: row.priceHistoryRetention as AppSettings["priceHistoryRetention"],
      createdAt: toIsoString(row.createdAt),
    };

    // PostgreSQL 类型只能证明 JSONB/文本的存储形态；地区从属、枚举和时区等业务关系继续复用服务层唯一校验规则。
    validateSettings(settings);
    return settings;
  }
}

/** 将 pg 默认解码的 Date 统一为既有 UTC ISO 字符串；字符串分支支持测试 executor，但同样拒绝无效时间。 */
function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("设置创建时间无效。");
  return date.toISOString();
}
