import type { AppDatabase, SqlExecutor } from "../../server/database/types";
import type { AppSettings, RegionCode, Theme } from "../../shared/domain";
import { SettingsValidationError, validateSettings } from "../../services/settings-service";
import type { SettingsPatch, SettingsStore } from "../ports";

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
export class SettingsRepository implements SettingsStore {
  public constructor(private readonly database: AppDatabase | SqlExecutor) {}

  public async get(): Promise<AppSettings | null> {
    return readSettings(this.database);
  }

  /**
   * 在单管理员设置行的 FOR UPDATE 锁内合并局部补丁、验证关联约束并写入。
   * 锁会让并发主题/时区 PATCH 串行化，后一请求总是基于前一请求已提交字段；默认搜索区与启用地区也只会以同一版本参加校验，不能留下不可达搜索区。
   */
  public async save(patch: SettingsPatch, updatedAt: string): Promise<AppSettings | null> {
    if (!isAppDatabase(this.database)) {
      // Dashboard 等只读事务可以复用本仓储的 get；局部 PATCH 必须由可开启事务的应用数据库调用，不能在未知 executor 上退化为无锁覆盖。
      throw new Error("设置补丁需要应用数据库事务。");
    }
    return this.database.transaction(async (transaction) => {
      const current = await readSettings(transaction, true);
      if (!current) return null;
      const next: AppSettings = {
        ...current,
        ...patch,
        enabledRegions: patch.enabledRegions ?? current.enabledRegions,
        defaultSearchRegion: patch.defaultSearchRegion ?? current.defaultSearchRegion,
        // TypeScript 已排除 createdAt，但运行时也明确保留首次初始化事实，防御直接仓储调用的过量对象。
        createdAt: current.createdAt,
      };
      validateSettings(next);

      await transaction.query(
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
          JSON.stringify(next.enabledRegions),
          next.defaultSearchRegion,
          next.theme,
          next.timezone,
          next.dailyReportTime,
          next.taxState,
          next.priceHistoryRetention,
          updatedAt,
        ],
      );
      return next;
    });
  }
}

/** AppDatabase 才拥有固定连接事务；SqlExecutor 仅供已有只读聚合事务注入，不能承担新的设置写边界。 */
function isAppDatabase(database: AppDatabase | SqlExecutor): database is AppDatabase {
  return "transaction" in database;
}

/** 读取函数可选择锁定单例行；锁只用于局部 PATCH，普通 GET 保持无事务只读以避免阻塞仪表盘和调度器。 */
async function readSettings(database: SqlExecutor, lockForUpdate = false): Promise<AppSettings | null> {
  const result = await database.query<SettingsRow>(
      `SELECT enabled_regions_json AS "enabledRegions",
              default_search_region AS "defaultSearchRegion",
              theme,
              timezone,
              daily_report_time AS "dailyReportTime",
              tax_state AS "taxState",
              price_history_retention AS "priceHistoryRetention",
              created_at AS "createdAt"
         FROM settings
        WHERE id = 1${lockForUpdate ? " FOR UPDATE" : ""}`,
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

/** 将 pg 默认解码的 Date 统一为既有 UTC ISO 字符串；字符串分支支持测试 executor，但同样拒绝无效时间。 */
function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("设置创建时间无效。");
  return date.toISOString();
}
