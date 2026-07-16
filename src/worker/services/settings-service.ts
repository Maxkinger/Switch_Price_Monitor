import { initialRegionCodes, themes, type AppSettings, type RegionCode } from "../../shared/domain";
import { SettingsRepository } from "../repositories/settings-repository";

/** 设置记录异常缺失时使用明确错误，避免在已登录但未完成初始化的异常状态下返回空对象。 */
export class SettingsNotInitializedError extends Error {}

/** 设置输入违反产品规则时由路由统一映射为 422，且不暴露数据库错误。 */
export class SettingsValidationError extends Error {}

/** 浏览器可提交的公开设置字段；createdAt 和任何秘密配置始终由服务端控制。 */
export type SettingsPatch = Partial<Omit<AppSettings, "createdAt">>;

/**
 * 管理全局单例设置的合并与约束。更新只影响后续搜索、显示与调度，不回写既有订阅的监控地区，
 * 因此管理员可以安全地更改默认搜索区而不改变历史价格的含义。
 */
export class SettingsService {
  public constructor(private readonly settings: SettingsRepository) {}

  public async get(): Promise<AppSettings> {
    const current = await this.settings.get();
    if (!current) throw new SettingsNotInitializedError("尚未完成首次设置。");
    return current;
  }

  /** 把局部浏览器更新与当前值合并，并在写入前一次性验证彼此相关的地区与默认区。 */
  public async update(patch: SettingsPatch, now: string): Promise<AppSettings> {
    const current = await this.get();
    const next: AppSettings = {
      ...current,
      ...patch,
      enabledRegions: patch.enabledRegions ?? current.enabledRegions,
      defaultSearchRegion: patch.defaultSearchRegion ?? current.defaultSearchRegion,
    };
    validate(next);
    await this.settings.save(next, now);
    return next;
  }
}

/**
 * 所有设置校验集中在持久化前执行。地区数组去重并限制为当前五区，默认区必须包含在数组中，
 * 否则商品发现会在一个未启用地区发起请求而产生无法解释的失败。
 */
function validate(settings: AppSettings): void {
  if (settings.enabledRegions.length === 0 || settings.enabledRegions.some((region) => !isRegionCode(region)) || new Set(settings.enabledRegions).size !== settings.enabledRegions.length) {
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
}

/** 用共享地区枚举做运行时收窄，JSON 输入不得仅依赖 TypeScript 的编译期类型。 */
function isRegionCode(value: unknown): value is RegionCode {
  return typeof value === "string" && initialRegionCodes.includes(value as RegionCode);
}

/** Intl 是 Worker 标准运行时能力；构造失败表示并非可用的 IANA 时区，日报调度不能接受它。 */
function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
