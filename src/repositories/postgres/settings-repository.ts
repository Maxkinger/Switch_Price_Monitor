import { initialRegionCodes, themes, type AppSettings, type RegionCode } from "../../shared/domain";
import type { SettingsStore } from "../ports";
import type { SqlExecutor } from "../../server/database/types";

/** pg 会把 TIMESTAMPTZ 解码为 Date；JSONB 保持 unknown，必须在进入领域 DTO 前做运行时校验。 */
interface SettingsRow {
  enabledRegions: unknown;
  defaultSearchRegion: string;
  theme: string;
  timezone: string;
  dailyReportTime: string;
  taxState: string;
  priceHistoryRetention: string;
  createdAt: Date;
}

/**
 * PostgreSQL 单管理员设置读取仓储。
 * 查询只列出公开偏好字段，不读取认证或未来 Telegram 配置；所有别名与行类型精确一致，
 * JSONB 则按现有五区、去重和默认区从属规则验证，防止数据库外部写入绕过服务约束。
 */
export class PostgresSettingsRepository implements SettingsStore {
  public constructor(private readonly database: SqlExecutor) {}

  /**
   * 仅供已被启动配置明确授权的本机开发流程，在空库写入可用的公开设置单例。
   * INSERT 不触及 admin_credentials、sessions 或任何密码/恢复码字段；冲突时不覆盖既有设置，
   * 因而重启开发服务、已有正常初始化或并发启动都不会改变管理员已经选择的地区与偏好。
   */
  public async ensureLocalDevelopmentDefaults(createdAt: string): Promise<void> {
    await this.database.query(
      `INSERT INTO settings (
         id,
         enabled_regions_json,
         default_search_region,
         created_at,
         updated_at
       ) VALUES (1, $1::jsonb, $2, $3, $3)
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(initialRegionCodes), initialRegionCodes[0], createdAt],
    );
  }

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
    if (!row) return null;

    const enabledRegions = parseEnabledRegions(row.enabledRegions);
    if (!isRegionCode(row.defaultSearchRegion) || !enabledRegions.includes(row.defaultSearchRegion)) {
      throw new Error("设置中的默认搜索地区无效");
    }
    if (!themes.includes(row.theme as AppSettings["theme"])) throw new Error("设置中的主题无效");
    if (!["forever", "one-year", "two-years"].includes(row.priceHistoryRetention)) {
      throw new Error("设置中的历史保留策略无效");
    }

    return {
      enabledRegions,
      defaultSearchRegion: row.defaultSearchRegion,
      theme: row.theme as AppSettings["theme"],
      timezone: row.timezone,
      dailyReportTime: row.dailyReportTime,
      taxState: row.taxState,
      priceHistoryRetention: row.priceHistoryRetention as AppSettings["priceHistoryRetention"],
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * 完整替换单管理员公开设置，但保留 created_at 和固定 id=1。
   * JSONB 参数由 pg 发送字符串并显式转 jsonb；所有值均绑定参数，不能借地区、时区或主题拼接 SQL。
   */
  public async save(settings: AppSettings, updatedAt: string): Promise<void> {
    await this.database.query(
      `UPDATE settings
          SET enabled_regions_json = $1::jsonb,
              default_search_region = $2,
              theme = $3,
              timezone = $4,
              daily_report_time = $5,
              tax_state = $6,
              price_history_retention = $7,
              updated_at = $8
        WHERE id = 1`,
      [
        JSON.stringify(settings.enabledRegions),
        settings.defaultSearchRegion,
        settings.theme,
        settings.timezone,
        settings.dailyReportTime,
        settings.taxState,
        settings.priceHistoryRetention,
        updatedAt,
      ],
    );
  }

}

/**
 * JSONB 读取结果不能依赖 TypeScript 断言：必须是非空、不重复且完全属于现有五区的数组。
 * 该规则与设置服务写入校验一致，错误只说明业务数据无效，不回显可能被篡改的原始 JSON。
 */
function parseEnabledRegions(value: unknown): RegionCode[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((region) => !isRegionCode(region)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("设置中的启用地区 JSONB 无效");
  }
  return value;
}

/** 复用共享领域枚举执行运行时收窄，不能把数据库 TEXT 直接强制断言为 RegionCode。 */
function isRegionCode(value: unknown): value is RegionCode {
  return typeof value === "string" && initialRegionCodes.includes(value as RegionCode);
}
