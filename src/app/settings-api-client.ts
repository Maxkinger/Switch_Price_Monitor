import type { AppSettings } from "../shared/domain";
import type { PublicSettingsPatch } from "./settings-form";

/**
 * 设置页面只需要的同源 API 契约。接口不包含 Telegram、密码、恢复码或会话令牌，
 * 因为这些值不能由此公开偏好页面读取、缓存或再次提交。
 */
export interface SettingsApiClient {
  getSettings(): Promise<AppSettings>;
  saveSettings(patch: PublicSettingsPatch): Promise<AppSettings>;
}

/**
 * 可显示的设置接口错误仅保留 Worker 已脱敏的中文摘要和 HTTP 状态。
 * 保留状态码使页面能在 401 清空私有草稿、在 422 保留草稿，而不保存 Response 或 Cookie。
 */
export class SettingsApiError extends Error {
  public constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "SettingsApiError";
  }
}

/**
 * 创建设置页的同源客户端。浏览器自动处理 HttpOnly 会话 Cookie；此模块绝不能读取、拼接、记录或转交 Cookie，
 * 从而让管理员偏好仍由 Worker 的认证守卫保护，且不会泄露到任天堂、Telegram 或第三方来源。
 */
export function createSettingsApiClient(request: typeof fetch = fetch): SettingsApiClient {
  /**
   * 固定设置路径的 JSON 传输层。任何非成功响应只提取安全 `error` 文案，
   * 避免页面意外保留数据库、请求体或未来秘密字段；成功响应仍由 TypeScript DTO 约束其使用范围。
   */
  async function requestJson<TResponse>(method: "GET" | "PATCH", body?: PublicSettingsPatch): Promise<TResponse> {
    const response = await request("/api/settings", {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new SettingsApiError(payload.error ?? "设置请求未完成，请稍后重试。", response.status);
    return payload as TResponse;
  }

  return {
    /** 读取初始化后由 Worker 管理的公开偏好，页面不会自行推导默认区、时区或保留策略。 */
    async getSettings(): Promise<AppSettings> {
      return requestJson<AppSettings>("GET");
    },

    /** 一次提交完整公开草稿，让地区与默认区在同一服务端校验中保持原子一致。 */
    async saveSettings(patch: PublicSettingsPatch): Promise<AppSettings> {
      return requestJson<AppSettings>("PATCH", patch);
    },
  };
}
