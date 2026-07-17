import { useEffect, useState } from "react";

import { AuthScreens, type AuthPendingAction } from "./auth-screens";
import { AuthApiError, createAuthApiClient, type InitializeAuthInput, type RecoverAuthInput } from "./auth-api-client";
import {
  completeAuthentication,
  completeRecoveryCode,
  initializeAuthFlow,
  requireLogin,
  setDefaultSearchRegion,
  showRecoveryCode,
  toggleEnabledRegion,
} from "./auth-flow";
import { AppShell } from "./app-shell";
import type { RegionCode } from "../shared/domain";

/** 认证客户端为无状态同源边界，可在整个 SPA 生命周期复用而不保存任何秘密或 Cookie。 */
const authApi = createAuthApiClient();

/**
 * 根组件只编排认证状态和已认证订阅页，不包含候选卡或跨区匹配细节。
 * 认证成功前绝不挂载订阅向导；认证失效时通过 key 卸载其所有内存选择、错误和来源预览。
 */
export function App() {
  const [auth, setAuth] = useState(initializeAuthFlow);
  const [pendingAction, setPendingAction] = useState<AuthPendingAction>(null);
  const [appKey, setAppKey] = useState(0);

  /** 初次加载只询问是否已完成设置，不尝试读取会话 Cookie、管理员地区或任何认证材料。 */
  useEffect(() => {
    let isCurrent = true;
    void authApi.getStatus()
      .then(({ initialized }) => {
        if (isCurrent) setAuth((state) => ({ ...state, screen: initialized ? "login" : "setup", notice: null }));
      })
      .catch(() => {
        if (isCurrent) setAuth((state) => ({ ...state, screen: "login", notice: "认证状态暂时无法获取，请稍后重试。" }));
      });
    return () => { isCurrent = false; };
  }, []);

  /** 首次设置成功后把恢复码和本次密码仅传入状态机内存，等待管理员确认已安全保存恢复码。 */
  async function handleInitialize(input: InitializeAuthInput) {
    setPendingAction("initialize");
    setAuth((state) => ({ ...state, notice: null }));
    try {
      const { recoveryCode } = await authApi.initialize(input);
      setAuth((state) => showRecoveryCode({ ...state, setupPassword: input.password }, recoveryCode));
    } catch (error) {
      if (error instanceof AuthApiError && error.status === 409) {
        try {
          const { initialized } = await authApi.getStatus();
          setAuth((state) => ({ ...state, screen: initialized ? "login" : "setup", notice: error.message }));
        } catch {
          setAuth((state) => ({ ...state, screen: "login", notice: "认证状态暂时无法获取，请稍后重试。" }));
        }
      } else {
        setAuth((state) => ({ ...state, notice: error instanceof AuthApiError ? error.message : "初始化未完成，请稍后重试。" }));
      }
    } finally {
      setPendingAction(null);
    }
  }

  /** 恢复码确认后的自动登录只使用本次设置表单的内存密码；任一失败都会清除它并回到登录页。 */
  async function handleAcknowledgeRecoveryCode() {
    const password = auth.setupPassword;
    if (!password) {
      setAuth((state) => ({ ...requireLogin(state), notice: "初始化信息已失效，请使用管理员密码登录。" }));
      return;
    }
    setPendingAction("login");
    setAuth((state) => completeRecoveryCode(state));
    try {
      await authApi.login(password);
      setAuth((state) => completeAuthentication(state));
    } catch (error) {
      setAuth((state) => ({ ...requireLogin(state), notice: error instanceof AuthApiError ? error.message : "登录未完成，请使用管理员密码重试。" }));
    } finally {
      setPendingAction(null);
    }
  }

  /** 普通登录成功后同样清空密码状态，浏览器只继续保存 Worker 管理的 HttpOnly Cookie。 */
  async function handleLogin(password: string) {
    setPendingAction("login");
    setAuth((state) => ({ ...state, notice: null }));
    try {
      await authApi.login(password);
      setAuth((state) => completeAuthentication(state));
    } catch (error) {
      setAuth((state) => ({ ...state, notice: error instanceof AuthApiError ? error.message : "登录未完成，请稍后重试。" }));
    } finally {
      setPendingAction(null);
    }
  }

  /** 密码恢复成功后服务端已撤销会话，强制返回登录而不是把恢复码或新密码延续到订阅页。 */
  async function handleRecover(input: RecoverAuthInput) {
    setPendingAction("recover");
    try {
      await authApi.recover(input);
      setAuth((state) => ({ ...requireLogin(state), notice: "密码已重设，请重新登录。" }));
    } catch (error) {
      setAuth((state) => ({ ...state, notice: error instanceof AuthApiError ? error.message : "密码重设未完成，请稍后重试。" }));
    } finally {
      setPendingAction(null);
    }
  }

  /** 商品端点报告 401 时卸载向导并清空认证状态机中的敏感值，阻止过期会话继续显示旧选择。 */
  function handleUnauthorized() {
    setAppKey((current) => current + 1);
    setAuth((state) => ({ ...requireLogin(state), notice: "登录状态已失效，请重新登录。" }));
  }

  if (auth.screen === "authenticated") return <AppShell key={appKey} onUnauthorized={handleUnauthorized} />;
  return (
    <AuthScreens
      state={auth}
      pendingAction={pendingAction}
      onInitialize={handleInitialize}
      onToggleRegion={(regionCode) => setAuth((state) => toggleEnabledRegion(state, regionCode))}
      onChangeDefaultRegion={(regionCode: RegionCode) => setAuth((state) => setDefaultSearchRegion(state, regionCode))}
      onAcknowledgeRecoveryCode={handleAcknowledgeRecoveryCode}
      onLogin={handleLogin}
      onRecover={handleRecover}
      onShowRecovery={() => setAuth((state) => ({ ...state, screen: "recover", notice: null }))}
      onReturnToLogin={() => setAuth((state) => ({ ...requireLogin(state), notice: null }))}
    />
  );
}
