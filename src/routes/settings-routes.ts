import type { AppSettings, RegionCode, Theme } from "../shared/domain";
import { SettingsNotInitializedError, SettingsService, SettingsValidationError, type SettingsPatch } from "../services/settings-service";
import { requireAdmin } from "./auth-guard";
import type { SessionReader } from "./auth-guard";

/** 当前本机开发期直接访问的全局设置入口；不处理 Telegram 等秘密配置，认证恢复前不得部署。 */
export async function handleSettingsRoute(request: Request, sessions: SessionReader, service: SettingsService): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/settings" || !["GET", "PATCH"].includes(request.method)) return null;
  if (!(await requireAdmin(request, sessions))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });

  try {
    if (request.method === "GET") return Response.json(await service.get());
    // 标准 Fetch 将 JSON 返回为动态值；readPatch 负责对象形状、字段白名单和基础类型收窄，不能依赖平台专属泛型伪造可信输入。
    const result = await service.update(readPatch((await request.json()) as unknown), new Date().toISOString());
    return Response.json(result);
  } catch (error) {
    const status = error instanceof SettingsNotInitializedError ? 409 : error instanceof SettingsValidationError ? 422 : 500;
    const code = status === 409 ? "SETUP_REQUIRED" : status === 422 ? "VALIDATION_ERROR" : "INTERNAL_ERROR";
    return Response.json({ code, error: error instanceof SettingsNotInitializedError || error instanceof SettingsValidationError ? error.message : "设置暂时无法保存，请稍后重试。" }, { status });
  }
}

/** 从不可信 JSON 中仅取白名单字段，忽略 createdAt、管理员记录及未来秘密字段，防止过量赋值。 */
function readPatch(value: unknown): SettingsPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SettingsValidationError("请求内容必须是对象。");
  const input = value as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if ("enabledRegions" in input) patch.enabledRegions = readRegions(input.enabledRegions);
  if ("defaultSearchRegion" in input) patch.defaultSearchRegion = readString(input.defaultSearchRegion, "默认搜索区无效。") as RegionCode;
  if ("theme" in input) patch.theme = readString(input.theme, "主题设置无效。") as Theme;
  if ("timezone" in input) patch.timezone = readString(input.timezone, "时区设置无效。");
  if ("dailyReportTime" in input) patch.dailyReportTime = readString(input.dailyReportTime, "日报时间无效。");
  if ("taxState" in input) patch.taxState = readString(input.taxState, "税务州设置无效。");
  if ("priceHistoryRetention" in input) patch.priceHistoryRetention = readString(input.priceHistoryRetention, "历史保留策略无效。") as AppSettings["priceHistoryRetention"];
  return patch;
}

/** 地区数组在服务层继续校验枚举与去重；这里先阻止非字符串 JSON 被隐式转换为地区代码。 */
function readRegions(value: unknown): RegionCode[] {
  if (!Array.isArray(value) || value.some((region) => typeof region !== "string")) throw new SettingsValidationError("地区选择无效。");
  return value as RegionCode[];
}

/** 空白字符串对时区、主题、税务州等字段没有业务含义，必须在边界拒绝而不是交给持久化仓储。 */
function readString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new SettingsValidationError(message);
  return value;
}
