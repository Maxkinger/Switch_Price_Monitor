import type { AppSettings, RegionCode, Theme } from "../shared/domain";
import { normalizeProxyHost, validateProxySettings, type ProxySettings } from "../shared/proxy-settings";
import { ProxyConnectionTestBusyError, type ProxyConnectionTestService } from "../services/proxy-connection-test-service";
import { SettingsNotInitializedError, SettingsService, SettingsValidationError, type SettingsPatch } from "../services/settings-service";
import { requireAdmin } from "./auth-guard";
import type { SessionReader } from "./auth-guard";

/** 当前本机开发期直接访问的全局设置入口；不处理 Telegram 等秘密配置，认证恢复前不得部署。 */
export async function handleSettingsRoute(request: Request, sessions: SessionReader, service: SettingsService, proxySupported = false, proxyTest?: Pick<ProxyConnectionTestService, "test">): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const isProxyTest = path === "/api/settings/proxy/test" && request.method === "POST";
  if (path !== "/api/settings" && !isProxyTest) return null;
  if (isProxyTest && (!proxySupported || !proxyTest)) return Response.json({ code: "NOT_FOUND", error: "当前运行时不支持网络代理测试。" }, { status: 404 });
  if (!isProxyTest && !["GET", "PATCH"].includes(request.method)) return null;
  if (!(await requireAdmin(request, sessions))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });

  try {
    if (isProxyTest) return Response.json(await proxyTest!.test(readProxySettings(await request.json())));
    if (request.method === "GET") return Response.json(await service.get());
    // 标准 Fetch 将 JSON 返回为动态值；readPatch 负责对象形状、字段白名单和基础类型收窄，不能依赖平台专属泛型伪造可信输入。
    const result = await service.update(readPatch((await request.json()) as unknown, proxySupported), new Date().toISOString());
    return Response.json(result);
  } catch (error) {
    const status = error instanceof ProxyConnectionTestBusyError ? 409 : error instanceof SettingsNotInitializedError ? 409 : error instanceof SettingsValidationError ? 422 : 500;
    const code = error instanceof ProxyConnectionTestBusyError ? "PROXY_TEST_BUSY" : status === 409 ? "SETUP_REQUIRED" : status === 422 ? "VALIDATION_ERROR" : "INTERNAL_ERROR";
    return Response.json({ code, error: error instanceof ProxyConnectionTestBusyError || error instanceof SettingsNotInitializedError || error instanceof SettingsValidationError ? error.message : "设置暂时无法保存，请稍后重试。" }, { status });
  }
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
    // 仅 PostgreSQL Node 运行时启用此字段；其他运行时不得静默忽略代理请求。
    if (!proxySupported) throw new SettingsValidationError("当前运行时不支持网络代理。");
    patch.proxy = readProxySettings(input.proxy);
  }
  return patch;
}

/** 代理补丁严格白名单化，认证字段不能通过未知键被忽略后残留在调用链中。 */
function readProxySettings(value: unknown): ProxySettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SettingsValidationError("代理设置无效。");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !new Set(["enabled", "protocol", "host", "port"]).has(key))) throw new SettingsValidationError("代理设置包含不支持的字段。");
  const candidate = { enabled: input.enabled, protocol: input.protocol, host: input.host, port: input.port } as ProxySettings;
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

/** 空白字符串对时区、主题、税务州等字段没有业务含义，必须在边界拒绝而不是交给持久化仓储。 */
function readString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new SettingsValidationError(message);
  return value;
}
