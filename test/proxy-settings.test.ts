import { describe, expect, it } from "vitest";

import { normalizeProxyHost, validateProxySettings } from "../src/shared/proxy-settings";

describe("代理设置", () => {
  it("接受主机已规范化的关闭状态 HTTP、HTTPS 与 SOCKS5 配置", () => {
    // 即使关闭代理也验证完整草稿，避免管理员以后重新启用时绕过主机、端口和无认证边界。
    for (const protocol of ["http", "https", "socks5"] as const) {
      expect(validateProxySettings({ enabled: false, protocol, host: "127.0.0.1", port: 7890 })).toBeNull();
    }
  });

  it.each([
    "http://127.0.0.1",
    "user@proxy.test",
    "proxy.test/path",
    "proxy.test\\path",
    " proxy.test",
    "proxy.test\n",
  ])("拒绝内嵌 URL、认证或空白语法：%s", (host) => {
    // 主机字段不能携带 scheme、认证或路径，防止构造连接 URL 与运行日志的安全边界被绕过。
    expect(normalizeProxyHost(host)).toBeNull();
  });

  it.each([0, 65_536, 1.5, Number.NaN])("拒绝无效端口：%s", (port) => {
    // TCP 端口仅允许 1–65535 的整数，禁止 PostgreSQL 或连接器隐式截断浮点和 NaN。
    expect(validateProxySettings({ enabled: true, protocol: "http", host: "proxy.test", port })).toBe("代理端口无效。");
  });
});
