import type { RegionCode } from "../shared/domain";

/**
 * 首次初始化接口的浏览器内存请求体。密码只在调用期间存在，
 * 不允许该 DTO 承担 Cookie、令牌或任何会被持久化的会话信息。
 */
export interface InitializeAuthInput {
  password: string;
  enabledRegions: RegionCode[];
  defaultSearchRegion: RegionCode;
}

/**
 * 恢复密码接口的浏览器内存请求体。恢复码是一次性应急凭据，
 * 因此客户端只提交给同源 Worker，不能转发到日志、URL 或第三方服务。
 */
export interface RecoverAuthInput {
  recoveryCode: string;
  password: string;
}

/**
 * 认证接口公开给页面的最小契约。登录 Cookie 由浏览器和 Worker 协商，
 * 此接口故意不暴露 Cookie、令牌、管理员资料或 Worker 的原始响应。
 */
export interface AuthApiClient {
  getStatus(): Promise<{ initialized: boolean }>;
  initialize(input: InitializeAuthInput): Promise<{ recoveryCode: string }>;
  login(password: string): Promise<void>;
  recover(input: RecoverAuthInput): Promise<void>;
  logout(): Promise<void>;
}

/**
 * 仅携带可安全显示的服务端摘要和 HTTP 状态的认证错误。
 * 状态码用于初始化冲突和登录锁定等 UI 分支；请求体、Cookie 与原始响应不得被错误对象保留。
 */
export class AuthApiError extends Error {
  public constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "AuthApiError";
  }
}

/**
 * 创建同源认证客户端。所有请求都使用 same-origin 凭据策略，
 * 让浏览器自动携带 HttpOnly 会话 Cookie，但 JavaScript 永远不会读取或拼接 Cookie 值。
 */
export function createAuthApiClient(request: typeof fetch = fetch): AuthApiClient {
  /**
   * 认证端点的统一传输层。它只接受站内固定路径，并只提取 Worker 明确承诺的 JSON 字段，
   * 防止页面把密码、恢复码或未知错误响应意外保留在状态或日志中。
   */
  async function requestJson<TResponse>(path: "/api/auth/status" | "/api/auth/initialize" | "/api/auth/login" | "/api/auth/recover" | "/api/auth/logout", method: "GET" | "POST", body?: unknown): Promise<TResponse> {
    const response = await request(path, {
      method,
      credentials: "same-origin",
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      throw new AuthApiError(payload.error ?? "认证请求未完成，请稍后重试。", response.status);
    }
    return payload as TResponse;
  }

  return {
    /** 首次访问只读取是否已初始化，不读取任何管理员设置或认证材料。 */
    async getStatus(): Promise<{ initialized: boolean }> {
      return requestJson<{ initialized: boolean }>("/api/auth/status", "GET");
    },

    /** 初始化成功时唯一允许读取的秘密是本次必须展示给管理员保存的一次性恢复码。 */
    async initialize(input: InitializeAuthInput): Promise<{ recoveryCode: string }> {
      return requestJson<{ recoveryCode: string }>("/api/auth/initialize", "POST", input);
    },

    /** 登录只确认 Worker 已设置会话；响应中的 expiresAt 与 Cookie 都不暴露给页面状态。 */
    async login(password: string): Promise<void> {
      await requestJson<unknown>("/api/auth/login", "POST", { password });
    },

    /** 密码恢复完成后 Worker 会撤销会话，页面必须回到登录入口而不是自动获得新会话。 */
    async recover(input: RecoverAuthInput): Promise<void> {
      await requestJson<unknown>("/api/auth/recover", "POST", input);
    },

    /** 退出保持幂等；即使浏览器没有有效会话也交由 Worker 覆盖过期 Cookie。 */
    async logout(): Promise<void> {
      await requestJson<unknown>("/api/auth/logout", "POST");
    },
  };
}
