import { initialRegionCodes, themes, type AppSettings, type RegionCode } from "../shared/domain";
import { validateProxySettings } from "../shared/proxy-settings";
import type { SettingsPatch as SettingsPatchInput, SettingsStore } from "../repositories/ports";

/** 设置记录异常缺失时使用明确错误，避免在已登录但未完成初始化的异常状态下返回空对象。 */
export class SettingsNotInitializedError extends Error {}

/** 设置输入违反产品规则时由路由统一映射为 422，且不暴露数据库错误。 */
export class SettingsValidationError extends Error {}

/** 浏览器可提交的公开设置字段；createdAt 和任何秘密配置始终由服务端控制。 */
export type SettingsPatch = SettingsPatchInput;

/**
 * 管理全局单例设置的合并与约束。更新只影响后续搜索、显示与调度，不回写既有订阅的监控地区，
 * 因此管理员可以安全地更改默认搜索区而不改变历史价格的含义。
 */
export class SettingsService {
  public constructor(private readonly settings: SettingsStore) {}

  public async get(): Promise<AppSettings> {
    const current = await this.settings.get();
    if (!current) throw new SettingsNotInitializedError("尚未完成首次设置。");
    return current;
  }

/**
 * 将局部浏览器补丁交给仓储原子合并、校验并写入。
 * 服务不能先读再全量覆盖：两个已认证请求若分别改主题和时区，后写旧快照会丢失前一请求；PostgreSQL 仓储必须在锁内保留另一字段并检查地区从属关系。
 */
  public async update(patch: SettingsPatch, now: string): Promise<AppSettings> {
    const next = await this.settings.save(patch, now);
    if (!next) throw new SettingsNotInitializedError("尚未完成首次设置。");
    return next;
  }
}

/**
 * 所有设置校验集中在持久化前执行。地区数组去重并限制为当前五区，默认区必须包含在数组中，
 * 否则商品发现会在一个未启用地区发起请求而产生无法解释的失败。
 */
export function validateSettings(settings: AppSettings): void {
  if (!Array.isArray(settings.enabledRegions) || settings.enabledRegions.length === 0 || settings.enabledRegions.some((region) => !isRegionCode(region)) || new Set(settings.enabledRegions).size !== settings.enabledRegions.length) {
    throw new SettingsValidationError("请至少选择一个不重复的受支持地区。");
  }
  if (!settings.enabledRegions.includes(settings.defaultSearchRegion)) {
    throw new SettingsValidationError("默认搜索区必须属于已选地区。");
  }
  if (!themes.includes(settings.theme)) throw new SettingsValidationError("主题设置无效。");
  if (!isTimeZone(settings.timezone)) throw new SettingsValidationError("时区设置无效。");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.dailyReportTime)) throw new SettingsValidationError("日报时间无效。");
  if (!/^[A-Z]{2}$/.test(settings.taxState)) throw new SettingsValidationError("税务州设置无效。");
  if (!["forever", "one-year", "two-years"].includes(settings.priceHistoryRetention)) throw new SettingsValidationError("历史保留策略无效。");
  // Worker/D1 历史运行时不提供代理能力，故仅在 PostgreSQL Node 设置携带该字段时校验；其余字段仍完全沿用统一设置规则。
  if (settings.proxy !== undefined) {
    const proxyError = validateProxySettings(settings.proxy);
    if (proxyError) throw new SettingsValidationError(proxyError);
  }
}

/** 用共享地区枚举做运行时收窄，JSON 输入不得仅依赖 TypeScript 的编译期类型。 */
function isRegionCode(value: unknown): value is RegionCode {
  return typeof value === "string" && initialRegionCodes.includes(value as RegionCode);
}

/** Intl 是浏览器、Worker 与 Node 共用的标准能力；构造失败表示并非可用的 IANA 时区，日报调度不能接受它。 */
function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
