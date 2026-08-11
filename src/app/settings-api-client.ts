import type { AppSettings } from "../shared/domain";
import type { ApiRequestTracker } from "./api-request-tracker";
import type { PublicSettingsPatch } from "./settings-form";
import type { ProxyConnectionTestResult } from "../services/proxy-connection-test-service";

/** 浏览器可读取的 AI 配置摘要；API Key 永远不属于此 DTO，不能被渲染、缓存或重新提交。 */
export type AiProviderConfigurationSummary = {
  configured: boolean;
  model: string | null;
  apiBaseUrl: string | null;
};

/** 保存时一次性提交完整 AI 配置；服务端不会从旧密文补回 Key，避免它成为秘密回显来源。 */
export type AiProviderConfigurationInput = {
  apiKey: string;
  model: string;
  apiBaseUrl: string;
};

/**
 * 设置页面只需要的同源 API 契约。接口不包含 Telegram、密码、恢复码或会话令牌，
 * 因为这些值不能由此公开偏好页面读取、缓存或再次提交。
 */
export interface SettingsApiClient {
  getSettings(): Promise<AppSettings>;
  saveSettings(patch: PublicSettingsPatch): Promise<AppSettings>;
  testProxy(settings: PublicSettingsPatch["proxy"]): Promise<ProxyConnectionTestResult>;
  getAiProviderConfiguration(): Promise<AiProviderConfigurationSummary>;
  saveAiProviderConfiguration(input: AiProviderConfigurationInput): Promise<AiProviderConfigurationSummary>;
  clearAiProviderConfiguration(): Promise<void>;
}

/**
 * 可显示的设置接口错误仅保留同源服务端已脱敏的中文摘要和 HTTP 状态。
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
 * 从而让管理员偏好仍由 Node API 的认证守卫保护，且不会泄露到任天堂、Telegram 或第三方来源。
 */
export function createSettingsApiClient(request: typeof fetch = fetch, tracker?: ApiRequestTracker): SettingsApiClient {
  /**
   * 固定设置路径的 JSON 传输层。任何非成功响应只提取安全 `error` 文案，
   * 避免页面意外保留数据库、请求体或未来秘密字段；成功响应仍由 TypeScript DTO 约束其使用范围。
   */
  async function requestJson<TResponse>(method: "GET" | "PATCH", body?: PublicSettingsPatch): Promise<TResponse> {
    const finish = tracker?.begin();
    try {
      const response = await request("/api/settings", {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new SettingsApiError(payload.error ?? "设置请求未完成，请稍后重试。", response.status);
      return payload as TResponse;
    } finally {
      // 偏好保存失败也必须释放加载状态，管理员才能在保留草稿后继续修正。
      finish?.();
    }
  }

  /**
   * AI 配置接口与公开设置 PATCH 彻底分离：只接受专用路径和专用 DTO，
   * 防止 API Key 因类型复用、LocalStorage 辅助逻辑或普通偏好请求而进入错误的数据边界。
   */
  async function requestAiJson<TResponse>(method: "GET" | "PUT", body?: AiProviderConfigurationInput): Promise<TResponse> {
    // AI 卡片自行管理等待与禁用，不能占用应用壳的全屏请求遮罩；否则一个缓慢的摘要读取会阻断独立的公开设置表单。
    const response = await request("/api/settings/ai-provider", {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new SettingsApiError(payload.error ?? "AI 配置请求未完成，请稍后重试。", response.status);
    return payload as TResponse;
  }

  return {
    /** 读取初始化后由服务端管理的公开偏好，页面不会自行推导默认区、时区或保留策略。 */
    async getSettings(): Promise<AppSettings> {
      return requestJson<AppSettings>("GET");
    },

    /** 一次提交完整公开草稿，让地区与默认区在同一服务端校验中保持原子一致。 */
    async saveSettings(patch: PublicSettingsPatch): Promise<AppSettings> {
      return requestJson<AppSettings>("PATCH", patch);
    },
    /** 测试仅提交代理四字段，目标地址固定在服务端，浏览器不能把它扩展为任意探测请求。 */
    async testProxy(settings: PublicSettingsPatch["proxy"]): Promise<ProxyConnectionTestResult> {
      const finish = tracker?.begin();
      try {
        const response = await request("/api/settings/proxy/test", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new SettingsApiError(payload.error ?? "代理连接测试未完成，请稍后重试。", response.status);
        return payload as ProxyConnectionTestResult;
      } finally { finish?.(); }
    },
    /** 读取服务端脱敏摘要；成功 JSON 不会被解释为或扩展为含 Key 的配置对象。 */
    async getAiProviderConfiguration(): Promise<AiProviderConfigurationSummary> {
      return requestAiJson<AiProviderConfigurationSummary>("GET");
    },
    /** 保存时才让内存中的 Key 进入同源请求体，服务端成功响应仍只能是无 Key 摘要。 */
    async saveAiProviderConfiguration(input: AiProviderConfigurationInput): Promise<AiProviderConfigurationSummary> {
      return requestAiJson<AiProviderConfigurationSummary>("PUT", input);
    },
    /** 删除请求故意没有正文，避免空 Key、旧模型或任何秘密草稿被多余地传输或记录。 */
    async clearAiProviderConfiguration(): Promise<void> {
      // 清除和保存一样由卡片局部禁用，避免幂等恢复操作把整个已认证应用锁进无关的全屏遮罩。
      const response = await request("/api/settings/ai-provider", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new SettingsApiError(payload.error ?? "AI 配置清除未完成，请稍后重试。", response.status);
      }
    },
  };
}
