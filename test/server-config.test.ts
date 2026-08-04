import { describe, expect, it } from "vitest";

import { ServerConfigError, readServerConfig } from "../src/server/config";

/** Node 运行时配置必须只从部署环境读取；测试中的 URL 与令牌均为不可用占位符，不代表真实 NAS 或 Telegram 凭据。 */
const validEnvironment = {
  PORT: "4310",
  DATABASE_URL: "postgres://switch_app:placeholder@127.0.0.1:5432/switch_price_monitor",
  COOKIE_SECURE: "false",
  STATIC_DIRECTORY: "/tmp/switch-price-monitor-client",
  MAXIMUM_BODY_BYTES: "65536",
  SHUTDOWN_GRACE_MS: "2500",
};

describe("Node server configuration", () => {
  it("reads an explicit LAN HTTP configuration without exposing optional secrets", () => {
    // 首次 NAS 部署是局域网 HTTP，COOKIE_SECURE=false 必须显式写出；不能由 Host 或转发头猜测，以免不可信请求改变认证 Cookie 安全属性。
    expect(readServerConfig(validEnvironment)).toEqual({
      port: 4310,
      databaseUrl: validEnvironment.DATABASE_URL,
      cookieSecure: false,
      staticDirectory: validEnvironment.STATIC_DIRECTORY,
      maximumBodyBytes: 65536,
      shutdownGraceMs: 2500,
    });
  });

  it.each([
    [{ ...validEnvironment, DATABASE_URL: undefined }],
    [{ ...validEnvironment, PORT: "0" }],
    [{ ...validEnvironment, PORT: "not-a-port" }],
    [{ ...validEnvironment, COOKIE_SECURE: "yes" }],
    [{ ...validEnvironment, TELEGRAM_BOT_TOKEN: "placeholder-token" }],
    [{ ...validEnvironment, TELEGRAM_CHAT_ID: "placeholder-chat" }],
  ])("rejects incomplete or unsafe configuration with a secret-free error", (environment) => {
    // 配置错误只给出稳定代码；连接串、Telegram 凭据和环境变量原文绝不能出现在异常文本或启动日志中。
    expect(() => readServerConfig(environment)).toThrow(ServerConfigError);
    try {
      readServerConfig(environment);
    } catch (error) {
      expect(error).toMatchObject({ message: expect.not.stringContaining("placeholder") });
    }
  });
});
