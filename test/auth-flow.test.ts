import { describe, expect, it } from "vitest";

import type { RegionCode } from "../src/shared/domain";
import {
  completeAuthentication,
  completeRecoveryCode,
  initializeAuthFlow,
  requireLogin,
  setDefaultSearchRegion,
  showRecoveryCode,
  toggleEnabledRegion,
} from "../src/app/auth-flow";

/**
 * 认证状态机测试不依赖 React、浏览器存储或 Worker。它锁定地区选择约束和敏感值清除时机，
 * 防止界面调整后把一次性恢复码、设置密码或失效会话前的向导信息留在内存状态中。
 */
describe("authentication flow state", () => {
  it("moves the default region when the selected default region is disabled", () => {
    const withTwoRegions = {
      ...initializeAuthFlow(),
      enabledRegions: ["US", "HK"] as RegionCode[],
      defaultSearchRegion: "US" as RegionCode,
    };
    const selected = setDefaultSearchRegion(withTwoRegions, "HK");

    expect(toggleEnabledRegion(selected, "HK")).toMatchObject({ enabledRegions: ["US"], defaultSearchRegion: "US" });
  });

  it("keeps the last enabled region so the setup form cannot submit an empty monitoring scope", () => {
    const onlyJapan = { ...initializeAuthFlow(), enabledRegions: ["JP"] as RegionCode[], defaultSearchRegion: "JP" as RegionCode };

    expect(toggleEnabledRegion(onlyJapan, "JP")).toMatchObject({ enabledRegions: ["JP"], defaultSearchRegion: "JP" });
  });

  it("drops recovery code, setup password and prior UI notice when a protected request requires login", () => {
    const state = showRecoveryCode({ ...initializeAuthFlow(), setupPassword: "fixture-password-1234" }, "TEST-RECOVERY-CODE");

    expect(requireLogin({ ...state, notice: "旧提示" })).toEqual(expect.objectContaining({
      screen: "login",
      recoveryCode: null,
      setupPassword: null,
      notice: null,
    }));
  });

  it("keeps a generated recovery code only until acknowledgement and clears setup data after login", () => {
    const codeShown = showRecoveryCode({ ...initializeAuthFlow(), setupPassword: "fixture-password-1234" }, "TEST-RECOVERY-CODE");
    const recoveryAcknowledged = completeRecoveryCode(codeShown);

    expect(recoveryAcknowledged).toEqual(expect.objectContaining({ screen: "loading", recoveryCode: null, setupPassword: "fixture-password-1234" }));
    expect(completeAuthentication(recoveryAcknowledged)).toEqual(expect.objectContaining({
      screen: "authenticated",
      setupPassword: null,
      recoveryCode: null,
    }));
  });
});
