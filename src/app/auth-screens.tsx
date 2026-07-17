import { useState, type FormEvent } from "react";

import type { InitializeAuthInput, RecoverAuthInput } from "./auth-api-client";
import type { AuthFlowState } from "./auth-flow";
import type { RegionCode } from "../shared/domain";

/** 认证表单只暴露三种短暂提交状态，防止初始化、登录或恢复密码被重复发送。 */
export type AuthPendingAction = "initialize" | "login" | "recover" | null;

/** 首次设置中可选择的地区及其中文名称必须与共享领域类型一一对应。 */
const regionChoices: ReadonlyArray<{ code: RegionCode; name: string }> = [
  { code: "US", name: "美区" },
  { code: "JP", name: "日区" },
  { code: "MX", name: "墨西哥区" },
  { code: "BR", name: "巴西区" },
  { code: "HK", name: "香港区" },
];

/**
 * 认证页面只负责受控输入和可访问的呈现，网络调用由根组件统一处理。
 * 这样密码与恢复码不会在多个组件之间复制，也不会因视觉层调整绕过认证状态机的清除规则。
 */
export function AuthScreens({
  state,
  pendingAction,
  onInitialize,
  onToggleRegion,
  onChangeDefaultRegion,
  onAcknowledgeRecoveryCode,
  onLogin,
  onRecover,
  onShowRecovery,
  onReturnToLogin,
}: {
  state: AuthFlowState;
  pendingAction: AuthPendingAction;
  onInitialize: (input: InitializeAuthInput) => void;
  onToggleRegion: (regionCode: RegionCode) => void;
  onChangeDefaultRegion: (regionCode: RegionCode) => void;
  onAcknowledgeRecoveryCode: () => void;
  onLogin: (password: string) => void;
  onRecover: (input: RecoverAuthInput) => void;
  onShowRecovery: () => void;
  onReturnToLogin: () => void;
}) {
  if (state.screen === "loading") return <LoadingScreen />;
  if (state.screen === "setup") {
    return <SetupScreen state={state} notice={state.notice} pendingAction={pendingAction} onInitialize={onInitialize} onToggleRegion={onToggleRegion} onChangeDefaultRegion={onChangeDefaultRegion} />;
  }
  if (state.screen === "recovery-code") return <RecoveryCodeScreen recoveryCode={state.recoveryCode} pendingAction={pendingAction} onAcknowledge={onAcknowledgeRecoveryCode} />;
  if (state.screen === "login") return <LoginScreen notice={state.notice} pendingAction={pendingAction} onLogin={onLogin} onShowRecovery={onShowRecovery} />;
  if (state.screen === "recover") return <PasswordRecoveryScreen notice={state.notice} pendingAction={pendingAction} onRecover={onRecover} onReturnToLogin={onReturnToLogin} />;
  return null;
}

/** 认证状态尚未确定时只显示不可交互的加载页，避免闪现错误的初始化或登录表单。 */
function LoadingScreen() {
  return (
    <main className="app-shell auth-page">
      <section className="auth-card" aria-live="polite">
        <h1>Switch Price Monitor</h1>
        <p>正在检查管理员访问状态…</p>
      </section>
    </main>
  );
}

/**
 * 首次设置表单把密码仅保留在组件内存直至提交；地区与默认搜索区则来自根状态机，
 * 因而取消默认地区时能立即修正下拉框，而无需依赖浏览器持久化或不可信隐藏字段。
 */
function SetupScreen({
  state,
  notice,
  pendingAction,
  onInitialize,
  onToggleRegion,
  onChangeDefaultRegion,
}: {
  state: AuthFlowState;
  notice: string | null;
  pendingAction: AuthPendingAction;
  onInitialize: (input: InitializeAuthInput) => void;
  onToggleRegion: (regionCode: RegionCode) => void;
  onChangeDefaultRegion: (regionCode: RegionCode) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const defaultSearchRegion = state.defaultSearchRegion ?? state.enabledRegions[0];

  /** 仅做即时可用性校验；密码长度、地区合法性和单管理员冲突始终由 Worker 再次强制。 */
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setFormNotice("两次输入的密码不一致，请重新确认。");
      return;
    }
    if (!defaultSearchRegion || state.enabledRegions.length === 0) {
      setFormNotice("请至少选择一个地区，并设置默认搜索区。");
      return;
    }
    setFormNotice(null);
    onInitialize({ password, enabledRegions: state.enabledRegions, defaultSearchRegion });
  }

  return (
    <main className="app-shell auth-page">
      <section className="auth-card" aria-labelledby="setup-title">
        <p className="eyebrow">首次使用</p>
        <h1 id="setup-title">设置管理员访问</h1>
        <p className="auth-card__lead">选择要监控的地区，并创建仅供你使用的管理员密码。</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="setup-password">管理员密码</label>
          <input id="setup-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={16} required />
          <label htmlFor="setup-password-confirm">确认密码</label>
          <input id="setup-password-confirm" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={16} required />
          <fieldset className="region-checkbox-grid">
            <legend>启用地区</legend>
            {regionChoices.map((region) => (
              <label key={region.code} className="region-checkbox">
                <input type="checkbox" checked={state.enabledRegions.includes(region.code)} onChange={() => onToggleRegion(region.code)} />
                <span>{region.name}</span>
              </label>
            ))}
          </fieldset>
          <label htmlFor="default-search-region">默认搜索区</label>
          <select id="default-search-region" value={defaultSearchRegion ?? ""} onChange={(event) => onChangeDefaultRegion(event.target.value as RegionCode)}>
            {regionChoices.filter((region) => state.enabledRegions.includes(region.code)).map((region) => <option key={region.code} value={region.code}>{region.name}</option>)}
          </select>
          <Notice message={formNotice ?? notice} />
          <div className="auth-actions">
            <button className="primary-button" type="submit" disabled={pendingAction === "initialize"}>{pendingAction === "initialize" ? "初始化中…" : "完成初始化"}</button>
          </div>
        </form>
      </section>
    </main>
  );
}

/** 恢复码只显示一次且不自动写入剪贴板，管理员需要自行安全保存后才可进入订阅流程。 */
function RecoveryCodeScreen({ recoveryCode, pendingAction, onAcknowledge }: { recoveryCode: string | null; pendingAction: AuthPendingAction; onAcknowledge: () => void }) {
  return (
    <main className="app-shell auth-page">
      <section className="auth-card" aria-labelledby="recovery-code-title">
        <p className="eyebrow">请安全保存</p>
        <h1 id="recovery-code-title">一次性恢复码</h1>
        <p className="auth-card__lead">此恢复码只显示这一次。请保存在密码管理器或离线安全位置，遗失后无法再次查看。</p>
        <label htmlFor="recovery-code">恢复码</label>
        <input id="recovery-code" className="recovery-code" value={recoveryCode ?? ""} readOnly aria-describedby="recovery-code-help" />
        <p id="recovery-code-help" className="auth-help">选中后可手动复制；本站不会自动访问剪贴板。</p>
        <div className="auth-actions">
          <button className="primary-button" type="button" disabled={pendingAction === "login"} onClick={onAcknowledge}>{pendingAction === "login" ? "正在进入…" : "我已保存，进入订阅"}</button>
        </div>
      </section>
    </main>
  );
}

/** 登录表单只在浏览器内存保存本次输入，成功后由根状态机清空并显示订阅页面。 */
function LoginScreen({ notice, pendingAction, onLogin, onShowRecovery }: { notice: string | null; pendingAction: AuthPendingAction; onLogin: (password: string) => void; onShowRecovery: () => void }) {
  const [password, setPassword] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onLogin(password);
  }

  return (
    <main className="app-shell auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <p className="eyebrow">管理员登录</p>
        <h1 id="login-title">进入价格订阅</h1>
        <p className="auth-card__lead">使用管理员密码查看和管理 Switch 游戏价格订阅。</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="login-password">管理员密码</label>
          <input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          <Notice message={notice} />
          <div className="auth-actions">
            <button className="primary-button" type="submit" disabled={pendingAction === "login"}>{pendingAction === "login" ? "登录中…" : "登录"}</button>
            <button className="text-button" type="button" onClick={onShowRecovery}>使用恢复码重设密码</button>
          </div>
        </form>
      </section>
    </main>
  );
}

/** 恢复页不自动登录：Worker 会撤销旧会话，成功后必须由管理员重新用新密码登录。 */
function PasswordRecoveryScreen({ notice, pendingAction, onRecover, onReturnToLogin }: { notice: string | null; pendingAction: AuthPendingAction; onRecover: (input: RecoverAuthInput) => void; onReturnToLogin: () => void }) {
  const [recoveryCode, setRecoveryCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formNotice, setFormNotice] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setFormNotice("两次输入的密码不一致，请重新确认。");
      return;
    }
    setFormNotice(null);
    onRecover({ recoveryCode, password });
  }

  return (
    <main className="app-shell auth-page">
      <section className="auth-card" aria-labelledby="recover-title">
        <p className="eyebrow">账户恢复</p>
        <h1 id="recover-title">重设管理员密码</h1>
        <p className="auth-card__lead">恢复成功后，所有已登录会话会失效；请使用新密码重新登录。</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="recover-code">一次性恢复码</label>
          <input id="recover-code" type="text" value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} autoComplete="off" required />
          <label htmlFor="recover-password">新管理员密码</label>
          <input id="recover-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={16} required />
          <label htmlFor="recover-password-confirm">确认新密码</label>
          <input id="recover-password-confirm" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={16} required />
          <Notice message={formNotice ?? notice} />
          <div className="auth-actions">
            <button className="primary-button" type="submit" disabled={pendingAction === "recover"}>{pendingAction === "recover" ? "重设中…" : "重设密码"}</button>
            <button className="text-button" type="button" onClick={onReturnToLogin}>返回登录</button>
          </div>
        </form>
      </section>
    </main>
  );
}

/** 所有可展示提示使用 alert，使表单校验和 Worker 的安全摘要能被辅助技术及时读取。 */
function Notice({ message }: { message: string | null }) {
  return message ? <p className="auth-notice" role="alert">{message}</p> : null;
}
