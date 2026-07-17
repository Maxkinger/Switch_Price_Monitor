import { initialRegionCodes, type RegionCode } from "../shared/domain";

/** 单页认证壳层可见的有限屏幕集合，避免 URL 路由或浏览器历史泄露认证流程状态。 */
export type AuthScreen = "loading" | "setup" | "recovery-code" | "login" | "recover" | "authenticated";

/**
 * 认证 UI 的纯内存状态。`setupPassword` 和 `recoveryCode` 仅跨越首次设置到登录的必要瞬间，
 * 任一失败、恢复完成或未授权回退都会清空，不能作为长期会话或恢复信息使用。
 */
export interface AuthFlowState {
  screen: AuthScreen;
  enabledRegions: RegionCode[];
  defaultSearchRegion: RegionCode | null;
  setupPassword: string | null;
  recoveryCode: string | null;
  notice: string | null;
}

/**
 * 创建首次加载状态。五区默认勾选且美区作为第一个搜索入口，管理员仍可在初始化页取消不需要的地区；
 * 这保证默认搜索区总是属于启用集合，并避免初次进入时出现不可提交的空地区配置。
 */
export function initializeAuthFlow(): AuthFlowState {
  return {
    screen: "loading",
    enabledRegions: [...initialRegionCodes],
    defaultSearchRegion: initialRegionCodes[0],
    setupPassword: null,
    recoveryCode: null,
    notice: null,
  };
}

/**
 * 切换初始化时的地区选择。最后一个地区不允许取消，防止客户端生成空监控范围；
 * 服务端仍会重复校验此约束，浏览器状态机不是安全边界。
 */
export function toggleEnabledRegion(state: AuthFlowState, regionCode: RegionCode): AuthFlowState {
  const isEnabled = state.enabledRegions.includes(regionCode);
  if (isEnabled && state.enabledRegions.length === 1) return state;

  const enabledRegions = isEnabled
    ? state.enabledRegions.filter((item) => item !== regionCode)
    : [...state.enabledRegions, regionCode];
  const defaultSearchRegion = state.defaultSearchRegion && enabledRegions.includes(state.defaultSearchRegion)
    ? state.defaultSearchRegion
    : enabledRegions[0] ?? null;
  return { ...state, enabledRegions, defaultSearchRegion };
}

/**
 * 只接受当前已启用地区作为默认搜索区，拒绝不在集合内的选择以避免前端展示与 Worker 规则不一致；
 * 不合法值保持原状态，界面可继续显示受控下拉框中的有效选项。
 */
export function setDefaultSearchRegion(state: AuthFlowState, regionCode: RegionCode): AuthFlowState {
  return state.enabledRegions.includes(regionCode) ? { ...state, defaultSearchRegion: regionCode } : state;
}

/**
 * 初始化成功后暂存一次性恢复码和本次设置密码以进入确认页。两者只能存在于页面内存，
 * 调用方不得把返回状态写入 URL、存储器、日志或分析事件。
 */
export function showRecoveryCode(state: AuthFlowState, recoveryCode: string): AuthFlowState {
  return { ...state, screen: "recovery-code", recoveryCode, notice: null };
}

/**
 * 管理员确认已保存恢复码后立即清除其明文，只保留短暂的设置密码供下一次登录请求使用。
 * 若登录失败，调用方必须改用 requireLogin 清除密码，不能重现恢复码确认页。
 */
export function completeRecoveryCode(state: AuthFlowState): AuthFlowState {
  return { ...state, screen: "loading", recoveryCode: null, notice: null };
}

/**
 * 登录成功后进入受保护向导前释放首次设置的敏感值，避免认证完成后内存快照仍含密码或恢复码。
 */
export function completeAuthentication(state: AuthFlowState): AuthFlowState {
  return { ...state, screen: "authenticated", recoveryCode: null, setupPassword: null, notice: null };
}

/**
 * 受保护请求返回 401、恢复成功或首次设置登录失败时统一回到登录页。
 * 该函数刻意不保留提示或秘密，避免失效会话下继续显示之前的向导数据或认证材料。
 */
export function requireLogin(state: AuthFlowState): AuthFlowState {
  return { ...state, screen: "login", recoveryCode: null, setupPassword: null, notice: null };
}
