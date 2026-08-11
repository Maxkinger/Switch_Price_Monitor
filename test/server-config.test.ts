import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/server/config";

/**
 * DeepSeek 配置测试共用的最小合法环境；只包含启动服务所必需的公开假值，
 * 防止测试意外读取开发机的真实环境变量或把真实 API Key 写入断言输出。
 */
function baseEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://example.invalid/switch",
    COOKIE_SECURE: "false",
    ...overrides,
  };
}

/**
 * Node 配置测试只传入显式白名单环境，不读取测试进程真实环境。
 * 这样数据库连接串和 Telegram 凭据既不会进入快照，也不会因开发机环境差异改变断言。
 */
describe("Node 服务配置", () => {
  it("只接受解码后恰好 32 字节的 AI 主密钥，并忽略旧 DeepSeek 环境变量", () => {
    // 主密钥是唯一可解开数据库密文的材料；这里严格按字节数而非 Base64 字符串长度判断，避免宽松解码把错误值带到运行时。
    const masterKey = Buffer.alloc(32, 7).toString("base64");
    const config = readServerConfig(baseEnvironment({
      AI_CREDENTIAL_ENCRYPTION_KEY: masterKey,
      DEEPSEEK_API_KEY: "legacy-key-must-be-ignored",
      DEEPSEEK_MODEL: "legacy-model-must-be-ignored",
    }));

    expect(config.aiCredentialEncryptionKey).toEqual(new Uint8Array(Buffer.alloc(32, 7)));
    expect(config).not.toHaveProperty("deepSeekApiKey");
    expect(config).not.toHaveProperty("deepSeekModel");
    expect(readServerConfig(baseEnvironment())).not.toHaveProperty("aiCredentialEncryptionKey");
    expect(() => readServerConfig(baseEnvironment({ AI_CREDENTIAL_ENCRYPTION_KEY: "not-base64" })))
      .toThrow("AI_CREDENTIAL_ENCRYPTION_KEY_INVALID");
    expect(() => readServerConfig(baseEnvironment({ AI_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64") })))
      .toThrow("AI_CREDENTIAL_ENCRYPTION_KEY_INVALID");
  });

  it("解析显式 LAN HTTP 配置并为非秘密运行参数提供安全默认值", () => {
    const config = readServerConfig({
      DATABASE_URL: "postgres://example.invalid/switch",
      PORT: "0",
      COOKIE_SECURE: "false",
    });

    expect(config).toEqual({
      databaseUrl: "postgres://example.invalid/switch",
      port: 0,
      cookieSecure: false,
      staticDirectory: expect.stringMatching(/dist[/\\]client$/),
      maximumBodyBytes: 1_048_576,
      shutdownGraceMs: 10_000,
      // 本机免登录默认关闭；遗漏环境变量时不能把 NAS 或公网部署意外降级为无认证。
      localDevelopmentAuthBypass: false,
    });
  });

  it("只接受显式 true 启用本机免登录，其他部署保持认证流程", () => {
    const common = {
      DATABASE_URL: "postgres://example.invalid/switch",
      COOKIE_SECURE: "false",
    };

    expect(readServerConfig({ ...common, LOCAL_DEVELOPMENT_AUTH_BYPASS: "true" }))
      .toMatchObject({ localDevelopmentAuthBypass: true });
    expect(() => readServerConfig({ ...common, LOCAL_DEVELOPMENT_AUTH_BYPASS: "TRUE" }))
      .toThrow("LOCAL_DEVELOPMENT_AUTH_BYPASS_INVALID");
  });

  it("缺少数据库连接配置时使用固定错误码且不展开环境对象", () => {
    expect(() => readServerConfig({
      COOKIE_SECURE: "false",
      UNRELATED_SECRET: "must-never-appear",
    })).toThrow("DATABASE_URL_REQUIRED");

    try {
      readServerConfig({
        COOKIE_SECURE: "false",
        UNRELATED_SECRET: "must-never-appear",
      });
    } catch (error) {
      expect(String(error)).not.toContain("must-never-appear");
    }
  });

  it.each(["-1", "65536", "1.5", "not-a-port"])(
    "拒绝非法监听端口 %s",
    (port) => {
      expect(() => readServerConfig({
        DATABASE_URL: "postgres://example.invalid/switch",
        PORT: port,
        COOKIE_SECURE: "false",
      })).toThrow("PORT_INVALID");
    },
  );

  it.each(["FALSE", "0", "yes", " true "])(
    "Cookie Secure 只接受小写字面量 true 或 false：%s",
    (cookieSecure) => {
      expect(() => readServerConfig({
        DATABASE_URL: "postgres://example.invalid/switch",
        COOKIE_SECURE: cookieSecure,
      })).toThrow("COOKIE_SECURE_INVALID");
    },
  );

  it("要求 Telegram token 与 chat id 同时存在或同时缺失", () => {
    expect(() => readServerConfig({
      DATABASE_URL: "postgres://example.invalid/switch",
      COOKIE_SECURE: "false",
      TELEGRAM_BOT_TOKEN: "token-only",
    })).toThrow("TELEGRAM_CREDENTIALS_INCOMPLETE");

    expect(readServerConfig({
      DATABASE_URL: "postgres://example.invalid/switch",
      COOKIE_SECURE: "true",
      TELEGRAM_BOT_TOKEN: "paired-token",
      TELEGRAM_CHAT_ID: "paired-chat",
    })).toMatchObject({
      telegramBotToken: "paired-token",
      telegramChatId: "paired-chat",
    });
  });

  it("任何配置错误都不包含数据库或 Telegram 秘密值", () => {
    const databaseSecret = "postgres://secret-user:secret-password@example.invalid/switch";
    const telegramSecret = "telegram-secret-value";
    let capturedError: unknown;

    try {
      readServerConfig({
        DATABASE_URL: databaseSecret,
        PORT: "invalid",
        COOKIE_SECURE: "false",
        TELEGRAM_BOT_TOKEN: telegramSecret,
      });
    } catch (error) {
      capturedError = error;
    }
    // 先证明非法端口/凭据组合确实失败，再检查真实配置异常；不能用测试自己抛出的错误制造秘密检查假阳性。
    expect(capturedError).toBeInstanceOf(Error);
    expect(String(capturedError)).not.toContain(databaseSecret);
    expect(String(capturedError)).not.toContain(telegramSecret);
    expect(String(capturedError)).not.toContain("secret-password");
  });

  it("严格校验静态目录、请求体上限和优雅关停时间的数值边界", () => {
    const common = {
      DATABASE_URL: "postgres://example.invalid/switch",
      COOKIE_SECURE: "false",
    };

    expect(() => readServerConfig({ ...common, STATIC_DIRECTORY: "   " }))
      .toThrow("STATIC_DIRECTORY_INVALID");
    expect(() => readServerConfig({ ...common, MAXIMUM_BODY_BYTES: "0" }))
      .toThrow("MAXIMUM_BODY_BYTES_INVALID");
    expect(() => readServerConfig({ ...common, MAXIMUM_BODY_BYTES: "10485761" }))
      .toThrow("MAXIMUM_BODY_BYTES_INVALID");
    expect(() => readServerConfig({ ...common, SHUTDOWN_GRACE_MS: "99" }))
      .toThrow("SHUTDOWN_GRACE_MS_INVALID");
    expect(() => readServerConfig({ ...common, SHUTDOWN_GRACE_MS: "120001" }))
      .toThrow("SHUTDOWN_GRACE_MS_INVALID");
  });
});
