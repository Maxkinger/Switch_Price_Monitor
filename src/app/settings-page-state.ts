import { SettingsApiError } from "./settings-api-client";
import type { SettingsFormState } from "./settings-form";

/**
 * 设置请求失败后的最小页面状态。401 与普通表单错误必须分开，
 * 因为认证失效后不能继续让登录页所在内存保存地区、税务州或日报偏好。
 */
export type SettingsRequestState =
  | { kind: "ready"; draft: SettingsFormState; error: string | null }
  | { kind: "unauthorized" };

/**
 * 映射设置 API 错误为可预测的页面动作。422、409 和网络安全摘要保留草稿供管理员修正或重试；
 * 只有 Worker 明确的 401 才移除草稿并通知外层认证壳，从而避免过度清空正常输入。
 */
export function applySettingsRequestFailure(draft: SettingsFormState, error: SettingsApiError): SettingsRequestState {
  if (error.status === 401) return { kind: "unauthorized" };
  return { kind: "ready", draft, error: error.message };
}
