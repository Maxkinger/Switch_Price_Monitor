import type { AiProviderCredentials } from "../repositories/ports";
import { AiProviderConfigurationService } from "../services/ai-provider-configuration-service";
import { requireAdmin, type SessionReader } from "./auth-guard";

/**
 * AI 密钥设置与普通公开偏好分离：该路由只处理精确单一路径，读取时仅返回服务已脱敏的摘要，
 * 从而不让 API Key、密文、主密钥或数据库诊断通过通用设置响应进入浏览器。
 */
export async function handleAiProviderSettingsRoute(
  request: Request,
  sessions: SessionReader,
  service: AiProviderConfigurationService,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/settings/ai-provider" || !["GET", "PUT", "DELETE"].includes(request.method)) return null;
  // 与其他设置路由共用管理员守卫；必须先于读取正文和数据库访问，避免匿名探测配置存在性或消耗解密资源。
  if (!(await requireAdmin(request, sessions))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });

  try {
    if (request.method === "GET") return Response.json(await service.getSummary());
    if (request.method === "DELETE") {
      // 清除不要求主密钥，以便管理员在主密钥丢失、密文损坏后仍能移除不可恢复的单例记录。
      await service.clear();
      return new Response(null, { status: 204 });
    }
    // PUT 必须重新提交完整三项；不会从旧密文补 Key，防止读取接口或浏览器内存变成秘密回显通道。
    await service.save(readInput(await readJson(request)), new Date().toISOString());
    return Response.json(await service.getSummary());
  } catch (error) {
    // 服务的字段校验和无效 JSON 都是管理员可修正的 422；主密钥、crypto、SQL 等内部失败统一固定 500，绝不暴露原因。
    const validation = error instanceof AiProviderRequestError || error instanceof Error && error.message === "AI 配置无效。";
    return Response.json(
      validation
        ? { code: "VALIDATION_ERROR", error: "AI 配置无效。" }
        : { code: "INTERNAL_ERROR", error: "AI 配置暂时无法保存，请稍后重试。" },
      { status: validation ? 422 : 500 },
    );
  }
}

/**
 * 只有 Fetch 的 JSON 语法错误可能代表管理员可修正的畸形正文；将它转换为路由专属校验异常，
 * 让畸形 Key 请求与字段类型错误同样只得到固定 422。传输中断、body stream 等非 SyntaxError
 * 必须继续冒泡到脱敏 500，不能被错误归类为客户端校验失败或泄漏底层诊断。
 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json() as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new AiProviderRequestError();
    throw error;
  }
}

/** 不可信 JSON 必须是只含三个字符串字段的普通对象；未知字段也拒绝，避免未来秘密字段被静默接受或过量赋值。 */
function readInput(value: unknown): AiProviderCredentials {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AiProviderRequestError();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !new Set(["apiKey", "model", "apiBaseUrl"]).has(key))) throw new AiProviderRequestError();
  if (typeof input.apiKey !== "string" || typeof input.model !== "string" || typeof input.apiBaseUrl !== "string") throw new AiProviderRequestError();
  return { apiKey: input.apiKey, model: input.model, apiBaseUrl: input.apiBaseUrl as AiProviderCredentials["apiBaseUrl"] };
}

/** 路由输入错误不携带原始正文、字段值或解析器位置，避免 API Key 被错误响应或日志意外包含。 */
class AiProviderRequestError extends Error {}
