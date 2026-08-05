import type { AppSettings, RegionCode, Theme } from "../shared/domain";
import type { SessionReader } from "./auth-guard";
import { SettingsNotInitializedError, type SettingsService, SettingsValidationError, type SettingsPatch } from "../services/settings-service";
import { requireAdmin } from "./auth-guard";
import { normalizeProxyHost, validateProxySettings, type ProxySettings } from "../shared/proxy-settings";
import { ProxyConnectionTestBusyError, type ProxyConnectionTestService } from "../services/proxy-connection-test-service";

/** 设置路由依赖平台中立服务，不能取得数据库、Telegram 凭据或任意列写能力。 */
export interface SettingsRouteDependencies {
  sessions: SessionReader;
  settings: Pick<SettingsService, "get" | "update">;
  /** 只有 PostgreSQL Node 路由具备代理列与出站测试；Worker/D1 默认关闭并拒绝代理字段。 */
  proxySupported?: boolean;
  proxyTest?: Pick<ProxyConnectionTestService, "test">;
  now?: () => string;
}

/** 受管理员会话保护的全局设置读取与局部更新入口；不处理 Telegram 等秘密配置。 */
export async function handleSettingsRoute(request: Request, dependencies: SettingsRouteDependencies): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const isProxyTest = path === "/api/settings/proxy/test" && request.method === "POST";
  if (path !== "/api/settings" && !isProxyTest) return null;
  if (isProxyTest && (!dependencies.proxySupported || !dependencies.proxyTest)) return Response.json({ code: "NOT_FOUND", error: "当前运行时不支持网络代理测试。" }, { status: 404 });
  if (!isProxyTest && !["GET", "PATCH"].includes(request.method)) return null;
  if (!(await requireAdmin(request, dependencies.sessions))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });

  try {
    const service = dependencies.settings;
  if (isProxyTest) return Response.json(await dependencies.proxyTest!.test(readProxySettings(await request.json())));
    if (request.method === "GET") return Response.json(await service.get());
    const result = await service.update(readPatch(await request.json(), dependencies.proxySupported === true), (dependencies.now ?? defaultNow)());
    return Response.json(result);
  } catch (error) {
    const status = error instanceof ProxyConnectionTestBusyError ? 409 : error instanceof SettingsNotInitializedError ? 409 : error instanceof SettingsValidationError ? 422 : 500;
    const code = error instanceof ProxyConnectionTestBusyError ? "PROXY_TEST_BUSY" : status === 409 ? "SETUP_REQUIRED" : status === 422 ? "VALIDATION_ERROR" : "INTERNAL_ERROR";
    return Response.json({ code, error: error instanceof ProxyConnectionTestBusyError || error instanceof SettingsNotInitializedError || error instanceof SettingsValidationError ? error.message : "设置暂时无法保存，请稍后重试。" }, { status });
  }
}

/** 设置更新时间只能来自服务端 UTC 时钟，浏览器补丁中的 createdAt/updatedAt 字段始终被忽略。 */
function defaultNow(): string {
  return new Date().toISOString();
}

/** 从不可信 JSON 中仅取白名单字段，忽略 createdAt、管理员记录及未来秘密字段，防止过量赋值。 */
function readPatch(value: unknown, proxySupported: boolean): SettingsPatch {
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
  if ("proxy" in input) {
    if (!proxySupported) throw new SettingsValidationError("当前运行时不支持网络代理。");
    patch.proxy = readProxySettings(input.proxy);
  }
  return patch;
}

/** 代理 PATCH 只接受四个无认证字段，并在路由边界规范主机；未知认证字段不能被静默忽略。 */
function readProxySettings(value: unknown): ProxySettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SettingsValidationError("代理设置无效。");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["enabled", "protocol", "host", "port"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new SettingsValidationError("代理设置包含不支持的字段。");
  const candidate = {
    enabled: input.enabled,
    protocol: input.protocol,
    host: input.host,
    port: input.port,
  } as ProxySettings;
  const error = validateProxySettings(candidate);
  if (error) throw new SettingsValidationError(error);
  const host = normalizeProxyHost(candidate.host);
  if (!host) throw new SettingsValidationError("代理主机无效。");
  return { ...candidate, host };
}

/** 地区数组在服务层继续校验枚举与去重；这里先阻止非字符串 JSON 被隐式转换为地区代码。 */
function readRegions(value: unknown): RegionCode[] {
  if (!Array.isArray(value) || value.some((region) => typeof region !== "string")) throw new SettingsValidationError("地区选择无效。");
  return value as RegionCode[];
}

/** 空白字符串对时区、主题、税务州等字段没有业务含义，必须在边界拒绝而不是进入持久化设置。 */
function readString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new SettingsValidationError(message);
  return value;
}
